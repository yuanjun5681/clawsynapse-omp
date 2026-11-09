import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LIMITS, type Config, type RequestMetadata } from "./types.ts";
import { discoverBotIds } from "./config.ts";

export interface SessionSummary {
  path: string;
  botId: string;
  bindingRevision: string;
  sessionId: string;
  title: string;
  lastActivity: number;
  historicalBinding: "current" | "historical" | "unknown";
}
export interface TranscriptBlock {
  entryId: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  details: { label: string; text: string }[];
}
export interface Transcript {
  session: SessionSummary;
  leafId: string | null;
  branches: { id: string; label: string }[];
  blocks: TranscriptBlock[];
  warnings: string[];
  incomplete: boolean;
}
export interface RequestMatch { session: SessionSummary; entryId: string; leafId: string | null }

type ObjectValue = Record<string, unknown>;
type Entry = ObjectValue & { type: string; id: string; parentId: string | null; timestamp: string };
interface Parsed {
  header: ObjectValue;
  title?: string;
  entries: Entry[];
  byId: Map<string, Entry>;
  leaves: Entry[];
  incomplete: boolean;
  mtime: number;
}
interface Location { root: string; path: string; botId: string; binding: string; chain: string[] }
interface TopicAssociation { messageId: string; sessionId: string; entryId: string; parentId: string; lastId: string; digest: string }
interface Budget { remaining: number }
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MAIN = new RegExp(`^.+_(${UUID})\\.jsonl$`, "i");
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MAX_DEPTH = 32;
const object = (v: unknown): v is ObjectValue => typeof v === "object" && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const errorText = (e: unknown): string => e instanceof Error ? e.message : String(e);
const missing = (e: unknown): boolean => object(e) && e.code === "ENOENT";
function fail(text: string): never { throw new Error(text); }
const timestamp = (v: unknown): number => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;
const pretty = (v: unknown): string => typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? "";

/** No cache: each read observes title edits, truncation and same-size rewrites afresh. */
export class HistoryReader {
  private readonly dataDir: string;
  private botIds: Set<string>;
  constructor(private readonly config: Pick<Config, "dataDir" | "botIds" | "autoDiscoverBots">) {
    if (!isAbsolute(config.dataDir)) fail("历史 DataDir 必须是绝对路径");
    this.dataDir = resolve(config.dataDir);
    if (config.botIds.some(id => !NAME.test(id))) fail("历史 Bot ID 包含非法路径字符");
    this.botIds = new Set(config.botIds);
  }

  private async refreshBots(): Promise<void> {
    if (!this.config.autoDiscoverBots) return;
    const ids = await discoverBotIds(this.dataDir);
    this.config.botIds = ids;
    this.botIds = new Set(ids);
  }

  private async root(): Promise<string> { return realpath(this.dataDir); }

  /** Reject symlinks at every level, including links remaining inside the root. */
  private async safePath(root: string, path: string): Promise<void> {
    const rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("历史路径越界");
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail(`历史路径不允许符号链接: ${current}`);
      if (current !== path && !stat.isDirectory()) fail(`历史父路径不是目录: ${current}`);
    }
    if (await realpath(path) !== path) fail(`历史路径不是规范路径: ${path}`);
  }

  private async *directory(root: string, path: string, budget: Budget, optional = false): AsyncGenerator<{ name: string; directory: boolean; file: boolean; symlink: boolean }> {
    let handle;
    try {
      await this.safePath(root, path);
      handle = await opendir(path);
    } catch (e) {
      if (optional && missing(e)) return;
      throw e;
    }
    try {
      for await (const item of handle) {
        if (--budget.remaining < 0) fail(`历史发现超过 ${LIMITS.candidates} 个目录项，列表不完整`);
        yield { name: item.name, directory: item.isDirectory(), file: item.isFile(), symlink: item.isSymbolicLink() };
      }
    } finally {
      // The async iterator closes on normal completion and early return.
      await handle.close().catch((e: unknown) => { if (!object(e) || e.code !== "ERR_DIR_CLOSED") throw e; });
    }
  }

  private async location(session: SessionSummary): Promise<Location> {
    await this.refreshBots();
    const root = await this.root();
    // Accept only canonical paths produced from the configured root, never normalize away '..'.
    const path = session.path;
    if (!isAbsolute(path) || resolve(path) !== path) fail("历史路径必须是规范绝对路径");
    const parts = relative(root, path).split(sep);
    if (parts[0] !== "bots" || !this.botIds.has(parts[1] ?? "") || parts[2] !== "workspace" || !NAME.test(parts[3] ?? "") || parts[4] !== ".clawsynapse" || parts[5] !== "omp-sessions") fail("历史路径不属于配置的 Bot 专用目录");
    const files = parts.slice(6);
    if (!files.length || files.length > MAX_DEPTH) fail("历史子 Agent 层级超限");
    const chain: string[] = [];
    let current = join(root, ...parts.slice(0, 6));
    for (let i = 0; i < files.length; i++) {
      const part = files[i]!;
      const stem = i === files.length - 1 ? part.slice(0, -6) : part;
      if (i === files.length - 1 && !part.endsWith(".jsonl")) fail("历史文件扩展名无效");
      if (i === 0 ? !MAIN.test(`${stem}.jsonl`) : !NAME.test(stem)) fail("历史文件名无效");
      chain.push(join(current, `${stem}.jsonl`));
      current = join(current, stem);
    }
    if (chain.at(-1) !== path || parts[1] !== session.botId || parts[3] !== session.bindingRevision) fail("历史路径与会话范围不匹配");
    await this.safePath(root, path);
    return { root, path, botId: parts[1]!, binding: parts[3]!, chain };
  }

  /** Bounded block reads; never read image blobs or paths supplied by headers. */
  private async *lines(root: string, path: string, maxBytes = LIMITS.historyBytes): AsyncGenerator<{ value: ObjectValue; line: number } | { incomplete: true }> {
    await this.safePath(root, path);
    const before = await lstat(path);
    if (!before.isFile()) fail(`历史路径不是普通文件: ${path}`);
    if (before.size > maxBytes) fail(`历史文件超过 ${maxBytes} 字节: ${path}`);
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (stat.dev !== before.dev || stat.ino !== before.ino || !stat.isFile()) fail("历史文件在打开时被替换，请刷新");
      await this.safePath(root, path);
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let fragments: Buffer[] = [];
      let length = 0;
      let total = 0;
      let line = 0;
      const decode = (bytes: Buffer, trailing: boolean): ObjectValue | null => {
        let value: unknown;
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { if (trailing) return null; return fail(`历史第 ${line} 行不是有效 UTF-8`); }
        try { value = JSON.parse(text); }
        catch { if (trailing) return null; return fail(`历史第 ${line} 行 JSON 损坏`); }
        if (!object(value)) fail(`历史第 ${line} 行必须是 JSON 对象`);
        return value;
      };
      while (true) {
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > maxBytes) fail(`历史文件增长超过 ${maxBytes} 字节`);
        let start = 0;
        for (let i = 0; i < bytesRead; i++) {
          if (chunk[i] !== 10) continue;
          const end = chunk.subarray(start, i);
          length += end.length;
          if (length > LIMITS.lineBytes) fail("历史单行超过 8 MiB");
          const bytes = fragments.length ? Buffer.concat([...fragments, end], length) : end;
          line++;
          yield { value: decode(bytes, false)!, line };
          fragments = [];
          length = 0;
          start = i + 1;
        }
        if (start < bytesRead) {
          const remainder = chunk.subarray(start, bytesRead);
          length += remainder.length;
          if (length > LIMITS.lineBytes) fail("历史单行超过 8 MiB");
          fragments.push(Buffer.from(remainder));
        }
      }
      if (length) {
        line++;
        const value = decode(Buffer.concat(fragments, length), true);
        if (value) yield { value, line }; else yield { incomplete: true };
      }
      const after = await file.stat();
      const linked = await lstat(path);
      if (after.size < total || after.dev !== linked.dev || after.ino !== linked.ino || (after.size === before.size && after.mtimeMs !== before.mtimeMs)) fail("历史文件在读取时被重写或替换，请刷新");
      await this.safePath(root, path);
    } finally { await file.close(); }
  }

  private header(value: ObjectValue): void {
    if (value.type !== "session" || !nonempty(value.id)) fail("历史缺少有效 session header");
    if (value.version !== 2 && value.version !== 3) fail(`不支持的历史版本: ${String(value.version ?? 1)}（仅支持 v2/v3）`);
  }

  private async parse(root: string, path: string, headerOnly = false): Promise<Parsed> {
    let header: ObjectValue | undefined;
    let title: string | undefined;
    let incomplete = false;
    const entries: Entry[] = [];
    const byId = new Map<string, Entry>();
    for await (const record of this.lines(root, path)) {
      if ("incomplete" in record) { incomplete = true; continue; }
      const value = record.value;
      if (record.line === 1 && value.type === "title") {
        if (value.v !== 1 || typeof value.title !== "string") fail("不支持或损坏的 title 记录（仅支持 v1）");
        title = value.title;
        continue;
      }
      if (!header) {
        this.header(value);
        header = value;
        if (headerOnly) break;
        continue;
      }
      if (!nonempty(value.type) || value.type === "session" || value.type === "title" || !nonempty(value.id) || !(value.parentId === null || nonempty(value.parentId)) || typeof value.timestamp !== "string" || !timestamp(value.timestamp)) fail(`历史第 ${record.line} 行树结构损坏`);
      if (byId.has(value.id)) fail(`历史存在重复 entry ID: ${value.id}`);
      if (value.type === "message") {
        const message = value.message;
        if (!object(message) || !nonempty(message.role) || !(typeof message.content === "string" || Array.isArray(message.content))) fail(`历史第 ${record.line} 行消息结构损坏`);
        if (message.role === "toolResult" && !nonempty(message.toolCallId)) fail(`历史第 ${record.line} 行工具结果缺少调用 ID`);
        if (Array.isArray(message.content)) for (const block of message.content) {
          if (!object(block) || !nonempty(block.type)) fail(`历史第 ${record.line} 行 content block 损坏`);
          if (block.type === "text" && typeof block.text !== "string") fail(`历史第 ${record.line} 行 text block 损坏`);
          if (block.type === "toolCall" && (!nonempty(block.id) || !nonempty(block.name))) fail(`历史第 ${record.line} 行工具调用损坏`);
        }
      }
      const entry = value as Entry;
      byId.set(entry.id, entry);
      entries.push(entry);
      if (entries.length > LIMITS.entries) fail(`历史超过 ${LIMITS.entries} 条 entry`);
    }
    if (!header) fail("历史 header 尚未完整保存");
    const parents = new Set<string>();
    for (const entry of entries) {
      if (entry.parentId !== null) {
        if (!byId.has(entry.parentId)) fail(`历史缺少 parent: ${entry.parentId}`);
        parents.add(entry.parentId);
      }
    }
    const done = new Set<string>();
    for (const entry of entries) {
      const chain = new Set<string>();
      let current: Entry | undefined = entry;
      while (current && !done.has(current.id)) {
        if (chain.has(current.id)) fail(`历史树存在环: ${current.id}`);
        chain.add(current.id);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
      }
      for (const id of chain) done.add(id);
    }
    const leaves = entries.filter(entry => !parents.has(entry.id));
    const last = entries.at(-1);
    if (last && parents.has(last.id)) leaves.push(last);
    return { header, title, entries, byId, leaves, incomplete, mtime: (await lstat(path)).mtimeMs };
  }

  private async load(session: SessionSummary): Promise<{ parsed: Parsed; location: Location }> {
    const location = await this.location(session);
    let parent: string | undefined;
    let parsed: Parsed | undefined;
    for (const path of location.chain) {
      parsed = await this.parse(location.root, path, path !== location.path);
      if (!parent) {
        const id = MAIN.exec(basename(path))?.[1];
        if (parsed.header.id !== id) fail("主会话文件名 UUID 与 header.id 不匹配");
      } else {
        if (typeof parsed.header.parentSession !== "string" || parsed.header.parentSession !== parent) fail(`子 Agent parentSession 与直接父会话不匹配: ${path}`);
      }
      parent = path;
    }
    if (parsed!.header.id !== session.sessionId && session.sessionId !== "") fail("历史 session ID 与 header 不匹配");
    return { parsed: parsed!, location };
  }

  // Daemon BotConfig: bots/<botId>/config.json, top-level bindingRevision and role.
  private async currentBinding(root: string, botId: string): Promise<string | undefined> {
    const path = join(root, "bots", botId, "config.json");
    await this.safePath(root, path);
    const before = await lstat(path);
    if (!before.isFile() || before.size > 1024 * 1024) fail("Bot config.json 不是普通文件或超过 1 MiB");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (stat.dev !== before.dev || stat.ino !== before.ino) fail("Bot config.json 在打开时被替换");
      await this.safePath(root, path);
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.allocUnsafe(16 * 1024);
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > 1024 * 1024) fail("Bot config.json 超过 1 MiB");
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
      const after = await file.stat();
      const linked = await lstat(path);
      if (after.dev !== linked.dev || after.ino !== linked.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) fail("Bot config.json 在读取时被替换或重写");
      await this.safePath(root, path);
      if (object(config) && config.role === "console") return undefined;
      if (!object(config) || !nonempty(config.bindingRevision) || !NAME.test(config.bindingRevision) || config.role !== "agent") fail("Bot 配置缺少有效的 Agent bindingRevision");
      return config.bindingRevision;
    } finally { await file.close(); }
  }

  private summary(location: Location, parsed: Parsed, binding?: string): SessionSummary {
    const title = parsed.title?.trim() || (typeof parsed.header.title === "string" ? parsed.header.title.trim() : "") || fallbackTitle(parsed);
    let lastActivity = Math.max(parsed.mtime, timestamp(parsed.header.timestamp));
    for (const entry of parsed.entries) lastActivity = Math.max(lastActivity, timestamp(entry.timestamp));
    return { path: location.path, botId: location.botId, bindingRevision: location.binding, sessionId: String(parsed.header.id), title,
      lastActivity,
      historicalBinding: binding === undefined ? "unknown" : binding === location.binding ? "current" : "historical" };
  }

  async listSessions(): Promise<{ sessions: SessionSummary[]; warnings: string[] }> {
    const { sessions, warnings } = await this.discoverSessions();
    return { sessions, warnings };
  }

  private async discoverSessions(): Promise<{ sessions: SessionSummary[]; warnings: string[]; failures: string[] }> {
    await this.refreshBots();
    if (!this.botIds.size) return { sessions: [], warnings: [], failures: [] };
    const root = await this.root();
    const sessions: SessionSummary[] = [];
    const warnings: string[] = [];
    const failures: string[] = [];
    const budget = { remaining: LIMITS.candidates };
    for (const botId of this.botIds) {
      let binding: string | undefined;
      try { binding = await this.currentBinding(root, botId); }
      catch (e) { warnings.push(`${botId}: 无法确认当前绑定: ${errorText(e)}`); }
      try {
        for await (const revision of this.directory(root, join(root, "bots", botId, "workspace"), budget, true)) {
          if (revision.symlink) { const message = `跳过符号链接 binding: ${revision.name}`; warnings.push(message); failures.push(message); continue; }
          if (!revision.directory || !NAME.test(revision.name)) continue;
          const dir = join(root, "bots", botId, "workspace", revision.name, ".clawsynapse", "omp-sessions");
          try {
            for await (const item of this.directory(root, dir, budget, true)) {
              if (!item.name.endsWith(".jsonl")) continue;
              if (item.symlink) { const message = `跳过符号链接历史: ${item.name}`; warnings.push(message); failures.push(message); continue; }
              if (!item.file || !MAIN.test(item.name)) continue;
              const candidate: SessionSummary = { path: join(dir, item.name), botId, bindingRevision: revision.name, sessionId: "", title: "", lastActivity: 0, historicalBinding: "unknown" };
              try {
                const { parsed, location } = await this.load(candidate);
                sessions.push(this.summary(location, parsed, binding));
                if (parsed.incomplete) warnings.push(`${item.name}: 末行尚未完整保存`);
              } catch (e) { const message = `${item.name}: ${errorText(e)}`; warnings.push(message); failures.push(message); }
            }
          } catch (e) { const message = `${dir}: ${errorText(e)}`; warnings.push(message); failures.push(message); }
          if (budget.remaining < 0) break;
        }
      } catch (e) { const message = `${botId}: ${errorText(e)}`; warnings.push(message); failures.push(message); }
      if (budget.remaining < 0) break;
    }
    sessions.sort((a, b) => b.lastActivity - a.lastActivity || a.path.localeCompare(b.path));
    return { sessions, warnings, failures };
  }

  private path(parsed: Parsed, leafId?: string): Entry[] {
    let current = leafId === undefined ? parsed.entries.at(-1) : parsed.byId.get(leafId);
    if (leafId !== undefined && !current) fail(`不存在的历史分支: ${leafId}`);
    const chain: Entry[] = [];
    while (current) { chain.push(current); current = current.parentId === null ? undefined : parsed.byId.get(current.parentId); }
    return chain.reverse();
  }

  /** Receipts are correlation evidence only; never turn wire journal records into transcript entries. */
  private async topicAssociations(root: string, botId: string): Promise<TopicAssociation[]> {
    const path = join(root, "bots", botId, "state", "messages.jsonl");
    try { await this.safePath(root, path); }
    catch (e) { if (missing(e)) return []; throw e; }
    const result: TopicAssociation[] = [];
    for await (const record of this.lines(root, path)) {
      if ("incomplete" in record) continue;
      const state = record.value.topicState;
      if (!object(state) || !nonempty(state.lastRequest) || !object(state.receipt)) continue;
      const receipt = state.receipt;
      if (!nonempty(receipt.NativeSessionID) || !nonempty(receipt.UserEntryID) ||
          typeof receipt.ParentEntryID !== "string" || !nonempty(receipt.LastEntryID) ||
          typeof receipt.InputDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.InputDigest)) continue;
      if (result.length >= LIMITS.candidates) fail("主题请求关联收执超过上限，无法完整扫描");
      result.push({ messageId: state.lastRequest, sessionId: receipt.NativeSessionID, entryId: receipt.UserEntryID,
        parentId: receipt.ParentEntryID, lastId: receipt.LastEntryID, digest: receipt.InputDigest });
    }
    return result;
  }

  async readSession(session: SessionSummary, leafId?: string): Promise<Transcript> {
    const { parsed, location } = await this.load(session);
    const warnings: string[] = [];
    let binding: string | undefined;
    try { binding = await this.currentBinding(location.root, location.botId); }
    catch (e) { warnings.push(`无法确认当前绑定: ${errorText(e)}`); }
    if (parsed.incomplete) warnings.push("末行尚未完整保存；刷新后重试。仅展示已持久化内容，不能据此判断执行完成。");
    const chain = this.path(parsed, leafId);
    let associated = chain.some(entry => requestIdentity(entry)?.botId === location.botId);
    if (!associated && chain.some(entry => nativeTopicEntry(entry))) {
      try {
        associated = (await this.topicAssociations(location.root, location.botId))
          .some(receipt => verifiedTopicEntry(parsed, receipt) && chain.some(entry => entry.id === receipt.entryId));
      } catch (e) { warnings.push(`主题请求关联扫描失败: ${errorText(e)}`); }
    }
    if (!associated) warnings.push("所选分支没有有效的 ClawSynapse user 来源标记或主题输入收执，无法确认请求关联；关联证据本身也不代表身份认证。");
    const blocks = render(chain, Number(parsed.header.version), warnings);
    const labels = new Map<string, string>();
    for (const entry of parsed.entries) if (entry.type === "label" && typeof entry.targetId === "string") {
      if (nonempty(entry.label)) labels.set(entry.targetId, entry.label); else labels.delete(entry.targetId);
    }
    return { session: this.summary(location, parsed, binding), leafId: chain.at(-1)?.id ?? null,
      branches: parsed.leaves.map(e => ({ id: e.id, label: labels.get(e.id) ?? `${e.id} · ${e.timestamp}` })),
      blocks, warnings, incomplete: parsed.incomplete };
  }

  async listChildren(session: SessionSummary): Promise<{ sessions: SessionSummary[]; warnings: string[] }> {
    const { location } = await this.load(session);
    if (location.chain.length >= MAX_DEPTH) fail("历史子 Agent 层级超限");
    const sessions: SessionSummary[] = [];
    const warnings: string[] = [];
    let binding: string | undefined;
    try { binding = await this.currentBinding(location.root, location.botId); }
    catch (e) { warnings.push(`无法确认当前绑定: ${errorText(e)}`); }
    const dir = location.path.slice(0, -6);
    for await (const item of this.directory(location.root, dir, { remaining: LIMITS.candidates }, true)) {
      if (!item.name.endsWith(".jsonl")) continue;
      if (item.symlink) { warnings.push(`跳过符号链接子 Agent: ${item.name}`); continue; }
      if (!item.file || !NAME.test(item.name.slice(0, -6))) continue;
      try {
        const { parsed, location: childLocation } = await this.load({ ...session, path: join(dir, item.name), sessionId: "" });
        sessions.push(this.summary(childLocation, parsed, binding));
        if (parsed.incomplete) warnings.push(`${item.name}: 末行尚未完整保存`);
      } catch (e) { warnings.push(`${item.name}: ${errorText(e)}`); }
    }
    sessions.sort((a, b) => b.lastActivity - a.lastActivity || a.path.localeCompare(b.path));
    return { sessions, warnings };
  }

  async findRequest(request: RequestMetadata): Promise<RequestMatch[]> {
    const listing = await this.discoverSessions();
    if (!this.botIds.has(request.botId)) fail("请求 Bot 不在历史配置范围内");
    // Partial active tails and unknown binding state do not invalidate saved associations.
    // Unreadable/omitted candidates must never silently become a negative lookup.
    if (listing.failures.length) fail(`请求关联扫描不完整: ${listing.failures.join("；")}`);
    const matches: RequestMatch[] = [];
    let receipts: TopicAssociation[] | undefined;
    for (const session of listing.sessions) {
      if (session.botId !== request.botId) continue;
      const { parsed } = await this.load(session);
      const wanted = new Set(parsed.entries.filter(entry => {
        const identity = requestIdentity(entry);
        return identity?.botId === request.botId && identity.messageId === request.messageId;
      }).map(entry => entry.id));
      if (parsed.entries.some(entry => nativeTopicEntry(entry))) {
        receipts ??= await this.topicAssociations(await this.root(), request.botId);
        for (const receipt of receipts) {
          if (receipt.messageId === request.messageId && verifiedTopicEntry(parsed, receipt)) wanted.add(receipt.entryId);
        }
      }
      if (!wanted.size) continue;
      const children = new Map<string | null, Entry[]>();
      for (const entry of parsed.entries) {
        const list = children.get(entry.parentId) ?? [];
        list.push(entry);
        children.set(entry.parentId, list);
      }
      const selectedLeaves = new Set(parsed.leaves.map(e => e.id));
      const stack: { entry: Entry; exit: boolean }[] = (children.get(null) ?? []).map(entry => ({ entry, exit: false }));
      const active: string[] = [];
      while (stack.length) {
        const { entry, exit } = stack.pop()!;
        if (exit) { if (wanted.has(entry.id)) active.pop(); continue; }
        if (wanted.has(entry.id)) active.push(entry.id);
        if (selectedLeaves.has(entry.id)) for (const entryId of active) {
          if (matches.length >= LIMITS.candidates) fail("请求关联结果超过上限，无法完整展示");
          matches.push({ session, entryId, leafId: entry.id });
        }
        stack.push({ entry, exit: true });
        for (const child of children.get(entry.id) ?? []) stack.push({ entry: child, exit: false });
      }
    }
    return matches;
  }
}

function content(value: unknown): { text: string; details: { label: string; text: string }[] } {
  if (typeof value === "string") return { text: value, details: [] };
  const texts: string[] = [];
  const details: { label: string; text: string }[] = [];
  if (Array.isArray(value)) for (const block of value) {
    if (!object(block)) continue;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    if (block.type === "image") texts.push("[图片 / blob 引用；未读取图片内容]");
    if (block.type === "thinking" && typeof block.thinking === "string") details.push({ label: "已保存的 thinking", text: block.thinking });
    if (block.type === "redactedThinking") details.push({ label: "thinking", text: "[不可读 / redacted；无法恢复]" });
  }
  return { text: texts.join("\n"), details };
}

/** Recognize only the native topic manifest, not arbitrary JSON with an instruction field. */
function nativeTopic(text: string): ObjectValue | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (object(value) && typeof value.instruction === "string" && Array.isArray(value.publicContext)) return value;
  } catch { /* Ordinary text stays unchanged. */ }
  return undefined;
}

function nativeTopicEntry(entry: Entry): boolean {
  return entry.type === "message" && object(entry.message) && entry.message.role === "user" &&
    nativeTopic(content(entry.message.content).text) !== undefined;
}

function verifiedTopicEntry(parsed: Parsed, receipt: TopicAssociation): boolean {
  if (parsed.header.id !== receipt.sessionId) return false;
  const entry = parsed.byId.get(receipt.entryId);
  if (!entry || !nativeTopicEntry(entry) || (entry.parentId ?? "") !== receipt.parentId) return false;
  const text = content((entry.message as ObjectValue).content).text;
  if (`sha256:${createHash("sha256").update(text).digest("hex")}` !== receipt.digest) return false;
  let last = parsed.byId.get(receipt.lastId);
  while (last) {
    if (last.id === entry.id) return true;
    last = last.parentId ? parsed.byId.get(last.parentId) : undefined;
  }
  return false;
}

function userContent(value: unknown): ReturnType<typeof content> {
  const body = content(value);
  const topic = nativeTopic(body.text);
  if (!topic) return body;
  body.text = topic.instruction as string;
  if ((topic.publicContext as unknown[]).length) body.details.push({
    label: "公开上下文（引用事实，非当前用户指令）", text: pretty(topic.publicContext),
  });
  if (object(topic.requiredContext)) body.details.push({
    label: "必需上下文读取范围（不代表已读取）", text: pretty(topic.requiredContext),
  });
  return body;
}

const titleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Workspace topics contain either JSON directly or one instruction line followed by JSON. */
function topicInstruction(text: string): string | undefined {
  const newline = text.indexOf("\n");
  const json = text.trimStart().startsWith("{") ? text : newline < 0 ? "" : text.slice(newline + 1);
  if (!json) return undefined;
  try {
    const topic: unknown = JSON.parse(json);
    if (object(topic) && nonempty(topic.conversationId) && Array.isArray(topic.history)) {
      // A recognized topic without a usable instruction must not expose its preamble or history as a title.
      return typeof topic.currentInstruction === "string" ? topic.currentInstruction : "";
    }
  } catch { /* Not a workspace topic; retain the ordinary message-body fallback. */ }
  return undefined;
}

function titlePreview(value: unknown): string {
  let text = userContent(value).text;
  try {
    const request: unknown = JSON.parse(text);
    if (object(request) && request.source === "clawsynapse") {
      const payload = request.payload;
      text = typeof payload === "string" ? payload : object(payload)
        ? (typeof payload.text === "string" && payload.text.trim() ? payload.text : typeof payload.instruction === "string" ? payload.instruction : "")
        : "";
      text = topicInstruction(text) ?? text;
    }
  } catch { /* Ordinary user text is not an adapter envelope. */ }
  let result = "";
  let count = 0;
  let space = false;
  for (const { segment } of titleSegmenter.segment(text)) {
    if (/^\s+$/u.test(segment)) { space = result.length > 0; continue; }
    if (count + (space ? 1 : 0) >= 40) return `${result}…`;
    if (space) { result += " "; count++; space = false; }
    result += segment; count++;
  }
  return result;
}

function fallbackTitle(parsed: Parsed): string {
  let preview = "";
  let created = timestamp(parsed.header.timestamp);
  for (const entry of parsed.entries) {
    if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "user") continue;
    preview = titlePreview(entry.message.content);
    if (preview) { created ||= timestamp(entry.timestamp); break; }
  }
  const date = new Date(created || parsed.mtime).toISOString().slice(0, 16).replace("T", " ");
  return `${date}Z · ${preview || `会话 ${String(parsed.header.id).slice(-8)}`}`;
}

function render(entries: Entry[], version: number, warnings: string[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const calls = new Map<string, { entryId: string; name: string; arguments: unknown; result: boolean }>();
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "reset_boundary") {
      blocks.push({ entryId: entry.id, role: "system", text: entry.type === "reset_boundary" ? "[上下文 reset；此前历史保留]" : `[${entry.type}；此前历史保留]`, details: typeof entry.summary === "string" ? [{ label: "摘要", text: entry.summary }] : [] });
      continue;
    }
    if (entry.type === "custom_message") {
      if (entry.display !== false) blocks.push({ entryId: entry.id, role: "system", ...content(entry.content) });
      continue;
    }
    if (entry.type !== "message") continue;
    if (!object(entry.message) || typeof entry.message.role !== "string") fail(`消息结构损坏: ${entry.id}`);
    const message = entry.message;
    const role = message.role;
    const body = role === "user" ? userContent(message.content) : content(message.content);
    if (role === "toolResult") {
      const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
      if (!call) warnings.push(`工具结果没有所选分支上的调用: ${String(message.toolCallId)}`);
      else {
        if (call.result) fail(`所选分支存在重复工具结果: ${String(message.toolCallId)}`);
        call.result = true;
      }
      blocks.push({ entryId: entry.id, role: "tool", text: `${String(message.toolName ?? call?.name ?? "工具")} · ${String(message.toolCallId ?? "未知 ID")}${message.isError === true ? " · 错误" : ""}`,
        details: [...(call ? [{ label: "调用 entry", text: call.entryId }, { label: "参数", text: pretty(call.arguments) }] : []), { label: "结果", text: body.text }, ...body.details] });
      continue;
    }
    if (role === "assistant" && Array.isArray(message.content)) for (const value of message.content) {
      if (!object(value) || value.type !== "toolCall") continue;
      if (!nonempty(value.id) || !nonempty(value.name)) fail(`工具调用结构损坏: ${entry.id}`);
      if (calls.has(value.id)) fail(`所选分支存在重复工具调用 ID: ${value.id}`);
      calls.set(value.id, { entryId: entry.id, name: value.name, arguments: value.arguments, result: false });
      body.details.push({ label: `工具调用 ${value.name} · ${value.id}`, text: pretty(value.arguments) });
    }
    const displayRole = role === "user" || role === "assistant" ? role : role === "developer" || role === "custom" || (version === 2 && role === "hookMessage") ? "system" : undefined;
    if (displayRole) blocks.push({ entryId: entry.id, role: displayRole, ...body });
  }
  return blocks;
}

function requestIdentity(entry: Entry): { botId: string; messageId: string } | undefined {
  if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "user") return undefined;
  let source: unknown;
  try { source = JSON.parse(content(entry.message.content).text); } catch { return undefined; }
  if (!object(source) || source.source !== "clawsynapse" || !nonempty(source.botId) || !nonempty(source.messageId)) return undefined;
  return { botId: source.botId, messageId: source.messageId };
}
