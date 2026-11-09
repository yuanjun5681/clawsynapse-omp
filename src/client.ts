import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { ObserverStore } from "./state.ts";
import { discoverBotIds } from "./config.ts";
import { errorText } from "./safety.ts";
import { LIMITS, type BotConnection, type Config, type ObservationState, type ObserverOptions, type ObserverView, type RequestKey, type RequestMetadata } from "./types.ts";

class PollFailure extends Error {
  constructor(message: string, readonly state: "offline" | "error" | "paused", readonly retry?: "manual" | "capacity") {
    super(message);
  }
}
interface Page { cursor: number; requests: RequestMetadata[]; empty: boolean }
interface APIEnvelope { ok: unknown; code: unknown; data?: unknown }
interface WirePage { items: unknown; cursor: unknown }
interface WireItem {
  cursor: unknown; id: unknown; type: unknown; from: unknown; to?: unknown; ts: unknown;
  requestId?: unknown; runId?: unknown; sessionKey?: unknown;
}
function isCursor(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function parsePage(value: unknown, botId: string, after: number | undefined, limit: number): Page {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new PollFailure("daemon 响应的 APIResult 格式非法", "error");
  const envelope = value as APIEnvelope;
  if (typeof envelope.ok !== "boolean" || typeof envelope.code !== "string" || !envelope.code) throw new PollFailure("daemon 响应的 APIResult 格式非法", "error");
  if (!envelope.ok) {
    const reasons: Record<string, string> = { unauthorized: "鉴权失败", forbidden: "无访问权限", not_found: "Bot 不存在", bot_not_found: "Bot 不存在", conflict: "Bot 状态冲突", bot_not_running: "Bot 未运行", invalid_argument: "查询参数被拒绝" };
    throw new PollFailure(`daemon 业务错误${Object.hasOwn(reasons, envelope.code) ? `：${reasons[envelope.code]}` : ""}`, "error");
  }
  if (typeof envelope.data !== "object" || envelope.data === null || Array.isArray(envelope.data)) throw new PollFailure("daemon 消息分页结构非法", "error");
  const data = envelope.data as WirePage;
  if (!Array.isArray(data.items) || data.items.length > limit || !isCursor(data.cursor)) throw new PollFailure("daemon 消息分页结构或 cursor 非法", "error");
  let previous = after ?? -1;
  const requests: RequestMetadata[] = [];
  for (const raw of data.items) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new PollFailure("daemon 消息记录格式非法", "error");
    const item = raw as WireItem;
    if (!isCursor(item.cursor) || item.cursor <= previous ||
        typeof item.id !== "string" || !item.id || typeof item.type !== "string" || !item.type ||
        typeof item.from !== "string" || !item.from || !isCursor(item.ts) || item.ts > 8_640_000_000_000_000 ||
        (item.to !== undefined && typeof item.to !== "string")) throw new PollFailure("daemon 消息记录或单调 cursor 非法", "error");
    for (const field of ["requestId", "runId", "sessionKey"] as const) {
      if (item[field] !== undefined && typeof item[field] !== "string") throw new PollFailure("daemon 请求关联字段格式非法", "error");
    }
    previous = item.cursor;
    if ((item.type !== "chat.message" && item.type !== "task.assign") || item.from === botId || (item.to && item.to !== botId)) continue;
    const metadata: RequestMetadata = { botId, messageId: item.id, type: item.type, from: item.from, timestamp: item.ts };
    for (const field of ["requestId", "runId", "sessionKey"] as const) {
      if (typeof item[field] === "string") metadata[field] = item[field];
    }
    if (Buffer.byteLength(JSON.stringify(metadata)) > LIMITS.metadataBytes) throw new PollFailure("单条请求元数据超过 8 KiB，观察已暂停", "paused", "manual");
    requests.push(metadata);
  }
  if ((data.items.length > 0 && data.cursor !== previous) || (after !== undefined && data.items.length === 0 && data.cursor !== after)) throw new PollFailure("daemon 页尾 cursor 与消息记录不一致", "error");
  return { cursor: data.cursor, requests, empty: data.items.length === 0 };
}

function readToken(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > 16 * 1024) throw new Error("unsafe token file");
    const bytes = Buffer.alloc(16 * 1024 + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      length += count;
      if (length === bytes.length) throw new Error("oversized token");
      if (count === 0) break;
    }
    const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)).trim();
    if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error("invalid token");
    return token;
  } catch {
    // Never expose the token, token path, filesystem error, or daemon response body.
    throw new PollFailure("Bot tokenFile 无法安全读取；需要当前用户私有的常规文件，观察已暂停", "paused", "manual");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Polling and lifecycle state, separate from the durable observation and native history reader. */
export class RequestObserver {
  private readonly config: Config;
  private readonly bots = new Map<string, BotConnection>();
  private readonly peerNames: Record<string, Record<string, string>> = Object.create(null);
  private readonly paused = new Map<string, "manual" | "capacity">();
  private readonly timers = new Set<() => void>();
  private readonly rounds = new Set<AbortController>();
  private observation: ObservationState;
  private generation = 0;
  private running = false;
  private stopped = false;
  private pollCancel?: () => void;
  private flight?: { generation: number; promise: Promise<void> };
  private discovery?: ObserverView["discovery"];

  constructor(config: Config, private readonly store: ObserverStore, private readonly options: ObserverOptions) {
    this.config = structuredClone(config);
    const endpoint = new URL(config.endpoint);
    if (!/^https?:$/.test(endpoint.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^\/*$/.test(endpoint.pathname) ||
        !Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs <= 0 || config.botIds.some((id) => !id || id === "." || id === "..")) throw new Error("非法 loopback endpoint、Bot ID 或轮询间隔");
    this.config.endpoint = endpoint.origin;
    this.config.botIds = [...new Set(config.botIds)].sort();
    this.observation = store.snapshot();
    for (const botId of this.config.botIds) this.bots.set(botId, { botId, state: "connecting" });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.beginRound(true);
  }

  stop(): void {
    this.running = false;
    this.stopped = true;
    this.generation++;
    for (const controller of this.rounds) controller.abort();
    for (const cancel of [...this.timers]) cancel();
    this.pollCancel = undefined;
  }

  refresh(): Promise<void> { return this.beginRound(true); }

  getSnapshot(): ObserverView {
    return structuredClone({ observation: this.observation, bots: [...this.bots.values()], peerNames: this.peerNames,
      ...(this.discovery ? { discovery: this.discovery } : {}) });
  }

  acknowledge(keys: RequestKey[]): void {
    if (this.stopped || keys.length === 0) return;
    const generation = this.generation;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        this.observation = this.store.snapshot();
        try {
          this.observation = this.store.acknowledge(keys, this.observation.revision);
          for (const [botId, reason] of this.paused) {
            if (reason === "capacity") {
              this.paused.delete(botId);
              this.bots.set(botId, { botId, state: "connecting", detail: "容量已释放，等待继续观察" });
            }
          }
          this.publish(generation);
          return;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "ObservationConflictError" || attempt === 2) throw error;
        }
      }
    } catch (error) {
      try { this.observation = this.store.snapshot(); } catch { /* Retain the last durable snapshot if storage is unavailable. */ }
      const failure = this.storageFailure(error);
      for (const botId of new Set(keys.map((key) => key.botId))) if (this.bots.has(botId)) this.setFailure(botId, failure);
      this.publish(generation);
      throw failure;
    }
  }

  private beginRound(explicit: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const generation = this.generation;
    if (this.flight?.generation === generation) return this.flight.promise;
    this.pollCancel?.();
    this.pollCancel = undefined;
    if (explicit) this.paused.clear();
    const controller = new AbortController();
    this.rounds.add(controller);
    const promise = this.runRound(generation, controller.signal).finally(() => {
      this.rounds.delete(controller);
      if (this.flight?.promise === promise) this.flight = undefined;
      if (this.running && !this.stopped && generation === this.generation) {
        this.pollCancel = this.schedule(() => { this.pollCancel = undefined; void this.beginRound(false); }, this.config.pollIntervalMs);
      }
    });
    this.flight = { generation, promise };
    return promise;
  }

  private async synchronizeBots(generation: number, signal: AbortSignal): Promise<boolean> {
    try {
      const ids = await discoverBotIds(this.config.dataDir);
      if (signal.aborted || this.stopped || generation !== this.generation) return false;
      this.store.setBotIds(ids);
      this.config.botIds = ids;
      const active = new Set(ids);
      for (const id of this.bots.keys()) {
        if (!active.has(id)) { this.bots.delete(id); this.paused.delete(id); delete this.peerNames[id]; }
      }
      for (const botId of ids) if (!this.bots.has(botId)) this.bots.set(botId, { botId, state: "connecting" });
      this.observation = this.store.snapshot();
      this.discovery = undefined;
      if (!ids.length) {
        const health = await this.requestJSON("", new URL("/v2/health", this.config.endpoint), signal);
        if (typeof health !== "object" || health === null || !("ok" in health) || health.ok !== true ||
            !("code" in health) || health.code !== "daemon.healthy") throw new PollFailure("本机端点未返回有效的 ClawSynapse daemon 健康状态", "error");
        if (signal.aborted || this.stopped || generation !== this.generation) return false;
        this.discovery = { state: "waiting", detail: "本机暂无已注册 Bot；创建后将自动发现" };
      }
      this.publish(generation);
      return ids.length > 0;
    } catch (error) {
      if (signal.aborted || this.stopped || generation !== this.generation) return false;
      this.discovery = { state: error instanceof PollFailure && error.state === "offline" ? "offline" : "error",
        detail: error instanceof PollFailure ? error.message : `本地 Bot 发现失败：${errorText(error)}` };
      this.publish(generation);
      return false;
    }
  }

  private async runRound(generation: number, signal: AbortSignal): Promise<void> {
    if (this.config.autoDiscoverBots && !await this.synchronizeBots(generation, signal)) return;
    try { this.observation = this.store.snapshot(); }
    catch (error) {
      if (this.stopped || generation !== this.generation) return;
      const failure = this.storageFailure(error);
      for (const botId of this.config.botIds) this.setFailure(botId, failure);
      this.publish(generation);
      return;
    }
    await Promise.all(this.config.botIds.map(async (botId) => {
      if (this.paused.has(botId)) return;
      try {
        await this.pollBot(botId, generation, signal);
        await this.refreshPeerNames(botId, generation, signal);
      }
      catch (error) {
        if (signal.aborted || this.stopped || generation !== this.generation) return;
        this.setFailure(botId, error instanceof PollFailure ? error : this.storageFailure(error));
        this.publish(generation);
      }
    }));
  }

  private async pollBot(botId: string, generation: number, signal: AbortSignal): Promise<void> {
    for (let index = 0; index < LIMITS.pagesPerRound; index++) {
      if (signal.aborted || this.stopped || generation !== this.generation) return;
      const after = this.observation.cursors[botId];
      const page = await this.requestPage(botId, after, 100, signal);
      if (after !== undefined && page.empty) {
        // MessagesAfter echoes an out-of-range `after`; only a recent-page query can detect rollback.
        const recent = await this.requestPage(botId, undefined, 1, signal);
        if (recent.cursor < after) throw new PollFailure("检测到收件数据集回退或替换；保留旧游标，观察已暂停", "paused", "manual");
      }
      if (signal.aborted || this.stopped || generation !== this.generation) return;
      this.observation = this.store.snapshot();
      this.observation = this.store.commitPage(botId, this.observation.revision, after, page.cursor, after === undefined ? [] : page.requests);
      this.bots.set(botId, { botId, state: "connected" });
      this.paused.delete(botId);
      this.publish(generation);
      if (after === undefined || page.empty || index + 1 === LIMITS.pagesPerRound) return;
      const turn = Promise.withResolvers<void>();
      const cancel = this.schedule(() => { signal.removeEventListener("abort", abort); turn.resolve(); }, 0);
      const abort = () => { cancel(); turn.resolve(); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      await turn.promise;
      signal.removeEventListener("abort", abort);
    }
  }

  private async refreshPeerNames(botId: string, generation: number, signal: AbortSignal): Promise<void> {
    const senders = new Set(this.observation.unread.filter(request => request.botId === botId).map(request => request.from));
    if (!senders.size) { delete this.peerNames[botId]; return; }
    const names: Record<string, string> = Object.create(null);
    let failed = false;
    try {
      const value = await this.requestJSON(botId, new URL(`/v2/bots/${encodeURIComponent(botId)}/peers`, this.config.endpoint), signal);
      if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true ||
          !("code" in value) || value.code !== "peers.ok" || !("data" in value) || typeof value.data !== "object" ||
          value.data === null || !("items" in value.data) || !Array.isArray(value.data.items)) throw new Error("非法名称目录");
      for (const peer of value.data.items) {
        if (typeof peer !== "object" || peer === null || typeof peer.botId !== "string" || !senders.has(peer.botId)) continue;
        const name = (typeof peer.localAlias === "string" ? peer.localAlias.trim() : "") ||
          (typeof peer.displayName === "string" ? peer.displayName.trim() : "");
        if (name && Buffer.byteLength(name) <= LIMITS.metadataBytes) names[peer.botId] = name;
      }
    } catch { failed = true; }
    if (signal.aborted || this.stopped || generation !== this.generation) return;
    this.peerNames[botId] = names;
    const bot = this.bots.get(botId);
    if (failed && bot?.state === "connected") this.bots.set(botId, { ...bot, detail: "名称查询不可用；暂用完整 ID" });
    this.publish(generation);
  }

  private async requestPage(botId: string, after: number | undefined, limit: number, signal: AbortSignal): Promise<Page> {
    const url = new URL(`/v2/bots/${encodeURIComponent(botId)}/messages`, this.config.endpoint);
    url.searchParams.set("limit", String(limit));
    if (after !== undefined) url.searchParams.set("after", String(after));
    return parsePage(await this.requestJSON(botId, url, signal), botId, after, limit);
  }

  private async requestJSON(botId: string, url: URL, signal: AbortSignal): Promise<unknown> {
    const tokenPath = Object.hasOwn(this.config.tokenFiles, botId) ? this.config.tokenFiles[botId] : undefined;
    const token = tokenPath === undefined ? undefined : readToken(tokenPath);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    let timedOut = false;
    const cancelTimeout = this.schedule(() => { timedOut = true; controller.abort(); }, LIMITS.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url, { method: "GET", redirect: "error", proxy: "", signal: controller.signal, headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!response.ok) {
        await response.body?.cancel();
        const reasons: Record<number, string> = { 401: "鉴权失败", 403: "无访问权限", 404: "Bot 不存在", 409: "Bot 处于过渡或冲突状态" };
        throw new PollFailure(`HTTP ${response.status}${reasons[response.status] ? `：${reasons[response.status]}` : "：查询失败"}`, "error");
      }
      if (!response.body) throw new PollFailure("daemon 响应缺少消息体", "error");
      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts: string[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > LIMITS.responseBytes) throw new PollFailure("HTTP 解压后响应超过 8 MiB，观察已暂停；修复后手动刷新", "paused", "manual");
        try { parts.push(decoder.decode(chunk.value, { stream: true })); }
        catch { throw new PollFailure("daemon 响应不是有效 UTF-8", "error"); }
      }
      try { parts.push(decoder.decode()); }
      catch { throw new PollFailure("daemon 响应不是有效 UTF-8", "error"); }
      let value: unknown;
      try { value = JSON.parse(parts.join("")); }
      catch { throw new PollFailure("daemon 响应不是有效 JSON", "error"); }
      return value;
    } catch (error) {
      controller.abort();
      if (reader) { try { await reader.cancel(); } catch { /* A network abort can already have closed the stream. */ } }
      if (error instanceof PollFailure) throw error;
      if (timedOut) throw new PollFailure("HTTP 请求超时（3 秒），daemon 离线或无响应", "offline");
      if (error instanceof Error && /redirect/i.test(error.message)) throw new PollFailure("HTTP 重定向已拒绝", "error");
      throw new PollFailure("网络连接失败，daemon 离线或不可达", "offline");
    } finally {
      reader?.releaseLock();
      cancelTimeout();
      signal.removeEventListener("abort", abort);
    }
  }

  private storageFailure(error: unknown): PollFailure {
    if (error instanceof Error && error.name === "ObservationConflictError") return new PollFailure("观察 revision/cursor 已被其他窗口更新；已重载，下一轮重试", "error");
    if (typeof error === "object" && error !== null && "code" in error && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED")) return new PollFailure("观察存储暂时被占用；保留已提交状态，下一轮重试", "error");
    if (error instanceof Error && error.name === "ObservationCapacityError") {
      const releasable = /未查看/.test(error.message);
      return new PollFailure(releasable ? "未查看请求容量受限，观察已暂停；查看后继续" : "观察存储或元数据容量受限，观察已暂停；修复后手动刷新", "paused", releasable ? "capacity" : "manual");
    }
    return new PollFailure("观察存储失败，观察已暂停；保留已提交状态，修复后手动刷新", "paused", "manual");
  }
  private setFailure(botId: string, failure: PollFailure): void {
    this.bots.set(botId, { botId, state: failure.state, detail: failure.message });
    if (failure.retry) this.paused.set(botId, failure.retry);
  }
  private publish(generation: number): void {
    if (!this.stopped && generation === this.generation) this.options.onChange(this.getSnapshot());
  }
  private schedule(callback: () => void, ms: number): () => void {
    let active = true;
    const cancelHost = this.options.schedule(() => {
      if (!active) return;
      active = false;
      this.timers.delete(cancel);
      callback();
    }, ms);
    const cancel = () => {
      if (!active) return;
      active = false;
      this.timers.delete(cancel);
      cancelHost();
    };
    this.timers.add(cancel);
    return cancel;
  }
}
