import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import type { HistoryReader, RequestMatch, SessionSummary, Transcript, TranscriptBlock } from "./history.ts";
import { errorText, safeText } from "./safety.ts";
import type { Config, ObserverView, RequestKey, RequestMetadata } from "./types.ts";

export function formatStatus(view: ObserverView, width: number): string {
  const count = view.observation.unread.length;
  const paused = view.bots.find(bot => bot.state === "paused");
  const connected = view.bots.filter(bot => bot.state === "connected").length;
  let status: string;
  if (view.discovery) status = `${view.discovery.state === "waiting" ? "等待本地 Bot" : view.discovery.state === "offline" ? "daemon 离线" : "自动发现失败"} · ${view.discovery.detail}`;
  else if (paused) status = `观察已暂停 · ${paused.detail ?? "容量受限/存储失败"} · ${count} 条未查看`;
  else if (connected && connected < view.bots.length) status = `${connected}/${view.bots.length} Bot 可用 · ${count} 条新请求`;
  else if (view.bots.some(bot => bot.state === "error")) status = `查询失败 · ${count} 条未查看`;
  else if (view.bots.some(bot => bot.state === "offline")) status = `离线 · ${count} 条未查看`;
  else if (view.bots.some(bot => bot.state === "connecting")) status = "连接中";
  else if (count) {
    const latest = view.observation.unread[count - 1];
    const source = latest ? senderName(view, latest) : "未知来源";
    status = `${count} 条新请求 · 来自 ${safeText(source, true)}`;
  } else status = "已连接";
  return truncateToWidth(`ClawSynapse · ${safeText(status, true)}`, Math.max(1, width));
}

function senderName(view: ObserverView | undefined, request: RequestMetadata): string {
  const names = view?.peerNames;
  const scope = names && Object.hasOwn(names, request.botId) ? names[request.botId] : undefined;
  return scope && Object.hasOwn(scope, request.from) ? scope[request.from]! : request.from;
}

interface PanelOptions {
  config: Config;
  history: HistoryReader;
  getView: () => ObserverView | undefined;
  subscribe: (listener: () => void) => () => void;
  acknowledge: (keys: RequestKey[]) => void;
  refreshObserver: () => Promise<void>;
  observationError?: string;
  prefix?: string;
  onReady: (close: () => void) => void;
}
interface Row {
  title: string;
  description?: string;
  action: () => void | Promise<void>;
  request?: RequestMetadata;
}
interface Menu {
  kind: "menu";
  title: string;
  rows: Row[];
  selected: number;
  top: number;
  refresh?: () => void | Promise<void>;
  section?: "sessions" | "requests";
}
interface Detail {
  kind: "detail";
  title: string;
  text: string;
  starts: number[];
  page: number;
  width: number;
}
interface ReadingPosition { block: number; part: number; offset: number }
interface Conversation {
  kind: "conversation";
  title: string;
  transcript: Transcript;
  starts: ReadingPosition[];
  page: number;
  width: number;
  rows: number;
  expanded: boolean;
}
type Page = Menu | Detail | Conversation;
type SavedPage = Page | { kind: "session"; session: SessionSummary; leafId?: string; entryId?: string; part: number; offset: number; expanded: boolean };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Produce only the visible page, retaining offsets instead of materializing a huge wrapped transcript. */
function textPage(text: string, start: number, width: number, rows: number): { lines: string[]; next: number } {
  const lines: string[] = [];
  let line = "";
  let cells = 0;
  let next = start;
  for (const part of segmenter.segment(text.slice(start))) {
    const character = part.segment;
    const index = start + part.index;
    if (character === "\n" || character === "\r\n") {
      lines.push(line); line = ""; cells = 0; next = index + character.length;
      if (lines.length >= rows) return { lines, next };
      continue;
    }
    const value = character === "\t" ? "    " : safeText(character, true);
    const size = visibleWidth(value);
    if (cells && cells + size > width) {
      lines.push(line); line = ""; cells = 0;
      if (lines.length >= rows) return { lines, next: index };
    }
    line += value; cells += size; next = index + character.length;
  }
  if (line || !lines.length) lines.push(line);
  return { lines, next };
}

/** Return one raw section at a time; never concatenate the whole conversation or expand every tool eagerly. */
function conversationPart(block: TranscriptBlock, part: number, expanded: boolean): string {
  if (part === 0) return `[${{ user: "用户", assistant: "助手", tool: "工具", system: "系统" }[block.role]}]`;
  if (part === 1) return block.text || "（无文本内容）";
  const index = expanded ? Math.floor((part - 2) / 2) : part - 2;
  const item = block.details[index];
  if (!item) return "";
  return expanded ? ((part - 2) % 2 ? item.text : item.label) : `[折叠] ${item.label}`;
}

export async function openPanel(ctx: ExtensionContext, options: PanelOptions): Promise<void> {
  if (typeof ctx.ui.custom !== "function") {
    ctx.ui.notify("宿主缺少公开自定义 TUI 能力 ui.custom，无法打开历史面板", "error");
    return;
  }
  await ctx.ui.custom<void>((tui, theme, _keys, done) => {
    const paintWarning = typeof tui.addPaintListener === "function" ? "" : "宿主缺少终端绘制回调：请求列表只读，不会自动确认已查看";
    let disposed = false;
    let busy = false;
    let operation = 0;
    let notice = options.observationError ?? "";
    let page: Page = { kind: "menu", title: "会话总览", section: "sessions", rows: [], selected: 0, top: 0 };
    const stack: SavedPage[] = [];
    const acknowledged = new Set<string>();
    let paintedRows: { text: string; key: RequestKey }[] = [];
    let cancelAck: (() => void) | undefined;
    let ackBlocked = false;
    let nextTextOffset = 0;
    let nextReadingPosition: ReadingPosition | undefined;
    const idOf = (key: RequestKey) => JSON.stringify([key.botId, key.messageId]);
    const redraw = () => { if (!disposed) tui.requestRender(); };
    const current = (ticket: number) => !disposed && ticket === operation;
    const menu = (title: string, rows: Row[], refresh?: Menu["refresh"]): Menu => ({ kind: "menu", title, rows, selected: 0, top: 0, refresh });
    const savePage = (value: Page): SavedPage => {
      if (value.kind !== "conversation") return value;
      const at = value.starts[value.page] ?? { block: 0, part: 0, offset: 0 };
      return { kind: "session", session: value.transcript.session, leafId: value.transcript.leafId ?? undefined,
        entryId: value.transcript.blocks[at.block]?.entryId, part: at.part, offset: at.offset, expanded: value.expanded };
    };
    const push = (next: Page) => {
      if (disposed) return;
      // Retain navigation identities, not every previously opened parsed transcript.
      if (next.kind === "conversation") {
        for (let index = 0; index < stack.length; index++) {
          const saved = stack[index]!;
          if (saved.kind === "conversation" && saved.transcript !== next.transcript) stack[index] = savePage(saved);
        }
      }
      stack.push(next.kind === "conversation" && page.kind === "conversation" && next.transcript !== page.transcript ? savePage(page) : page);
      page = next; paintedRows = []; redraw();
    };
    const detail = (title: string, text: string): Detail => ({ kind: "detail", title, text: safeText(text), starts: [0], page: 0, width: 0 });
    const report = (error: unknown) => { notice = errorText(error); redraw(); };
    const run = (action: () => void | Promise<void>) => {
      if (busy || disposed) return;
      busy = true; const ticket = ++operation; redraw();
      Promise.resolve().then(() => { if (current(ticket)) return action(); }).catch(error => { if (current(ticket)) report(error); }).finally(() => { if (current(ticket)) { busy = false; redraw(); } });
    };
    const connectionText = () => [
      `endpoint: ${options.config.endpoint}`, `DataDir: ${options.config.dataDir}`, `stateDir: ${options.config.stateDir}`,
      ...options.config.botIds.map(botId => `Bot: ${botId}`), options.observationError ?? "",
      ...(options.getView()?.discovery ? [options.getView()!.discovery!.detail] : []),
      ...(options.getView()?.bots.map(bot => `${bot.botId}: ${bot.state}${bot.detail ? ` · ${bot.detail}` : ""}`) ?? []),
      "", "仅展示已落盘历史；文件停止增长不代表已完成。", "观察范围跟随当前交互会话；不同 UUID 不共享全局未读数。",
    ].join("\n");
    function showRequests(replace = false) {
      const view = options.getView();
      if (!view) {
        push(detail("观察不可用", options.observationError ?? "通知观察尚未可用；历史仍可浏览"));
        return;
      }
      acknowledged.clear();
      const snapshot = view.observation.unread.slice();
      const next = menu("新请求 · 已显示即确认查看", snapshot.map(request => ({
        title: `${senderName(view, request)} · ${request.type} · ${request.messageId}`,
        description: `来自 ${request.from} → Bot ${request.botId} · ${new Date(request.timestamp).toISOString()}`,
        request,
        action: () => showRequest(request),
      })), async () => {
        const ticket = operation;
        await options.refreshObserver();
        if (current(ticket)) showRequests(true);
      });
      next.section = "requests";
      if (replace) { page = next; redraw(); } else push(next);
    }
    async function showRequest(request: RequestMetadata) {
      const ticket = operation;
      const matches = await options.history.findRequest(request);
      if (!current(ticket)) return;
      if (!matches.length) {
        push(detail("暂无本地处理历史", `${JSON.stringify(request, null, 2)}\n\n尚未确认关联到本机原生会话；已查看不表示任务已执行。`));
      } else if (matches.length === 1) await openMatch(matches[0]!);
      else push(menu("选择关联会话 / 分支", matches.map(match => ({ title: `${match.session.title} · ${match.session.bindingRevision} · ${match.leafId}`, description: match.session.sessionId, action: () => openMatch(match) }))));
    }
    async function openMatch(match: RequestMatch) {
      await showTranscript(match.session, match.leafId ?? undefined, match.entryId);
    }
    async function showSessions(prefix?: string, replace = false) {
      const ticket = operation;
      const result = await options.history.listSessions();
      if (!current(ticket)) return;
      notice = result.warnings.length ? `${result.warnings.length} 条读取提示（列表中可打开）` : options.observationError ?? "";
      const selected = prefix ? result.sessions.filter(session => session.sessionId.startsWith(prefix)) : result.sessions;
      if (prefix && selected.length === 1) { await showTranscript(selected[0]!, undefined, undefined, replace); return; }
      if (prefix && !selected.length) { notice = "未找到配置范围内的原生 session ID"; redraw(); return; }
      const rows: Row[] = selected.map(session => ({ title: `${session.title || "未命名会话"} · ${bindingLabel(session)}`, description: `Bot ${session.botId} · ${session.sessionId} · ${new Date(session.lastActivity).toISOString()}`, action: () => showTranscript(session) }));
      if (result.warnings.length) rows.unshift({ title: `读取提示 (${result.warnings.length})`, action: () => push(detail("读取提示", result.warnings.join("\n"))) });
      const next = menu(prefix ? `匹配 ${prefix} · 请选择` : `会话总览 (${selected.length})`, rows, () => showSessions(prefix, true));
      next.section = "sessions";
      if (replace) { page = next; redraw(); } else push(next);
    }
    async function showTranscript(session: SessionSummary, leafId?: string, requestEntry?: string, replace = false, restore?: { part: number; offset: number; expanded: boolean }) {
      const ticket = operation;
      const transcript = await options.history.readSession(session, leafId);
      if (!current(ticket)) return;
      const requestIndex = requestEntry ? transcript.blocks.findIndex(block => block.entryId === requestEntry) : -1;
      const next: Conversation = { kind: "conversation", title: session.title || session.sessionId, transcript,
        starts: [{ block: Math.max(0, requestIndex), part: restore?.part ?? 0, offset: restore?.offset ?? 0 }],
        page: 0, width: 0, rows: 0, expanded: restore?.expanded ?? false };
      if (replace) { page = next; redraw(); } else push(next);
      notice = transcript.warnings.join("；") || "仅已落盘内容，不代表任务已完成";
    }
    function showBranches(transcript: Transcript) {
      const session = transcript.session;
      push(menu("分支 · 文件默认分支不等于运行中内存选中分支", transcript.branches.map(branch => ({ title: branch.label || branch.id, description: branch.id, action: () => showTranscript(session, branch.id) }))));
    }
    async function showChildren(transcript: Transcript) {
      const ticket = operation;
      const children = await options.history.listChildren(transcript.session);
      if (!current(ticket)) return;
      notice = children.warnings.join("；");
      push(menu("子 Agent · 按需读取", children.sessions.map(session => ({ title: session.title || session.sessionId, description: session.sessionId, action: () => showTranscript(session) }))));
    }
    function close() { if (!disposed) { dispose(); done(); } }
    const unsubscribe = options.subscribe(redraw);
    const unsubscribePaint = typeof tui.addPaintListener === "function" ? tui.addPaintListener(paint => {
      if (disposed || cancelAck || ackBlocked || !paintedRows.length) return;
      const live = new Set(paint.viewport.map(line => Bun.stripANSI(line).trimEnd()));
      const keys = paintedRows.filter(row => live.has(row.text) && !acknowledged.has(idOf(row.key))).map(row => row.key);
      if (!keys.length) return;
      const timer = ctx.setTimeout(() => {
        cancelAck = undefined;
        if (disposed) return;
        try { options.acknowledge(keys); for (const key of keys) acknowledged.add(idOf(key)); }
        catch (error) { ackBlocked = true; notice = `查看确认失败，r 重试：${errorText(error)}`; redraw(); }
      }, 0);
      cancelAck = () => ctx.clearTimer(timer);
    }) : undefined;
    function dispose() {
      if (disposed) return;
      disposed = true; ++operation;
      cancelAck?.();
      unsubscribe(); unsubscribePaint?.(); paintedRows = [];
    }
    options.onReady(close);
    run(async () => {
      await showSessions(undefined, true);
      if (!disposed && options.prefix) {
        if (/^[a-fA-F0-9-]+$/.test(options.prefix)) await showSessions(options.prefix);
        else notice = "参数须为完整原生 session ID 或唯一十六进制前缀";
      }
    });
    return {
      dispose,
      invalidate() { if (page.kind !== "menu") page.width = 0; },
      render(width: number): string[] {
        if (disposed) return [];
        const usable = Math.max(1, width - 2);
        const height = Math.max(8, tui.terminal.rows - 6);
        const headerHeight = page.kind === "conversation" ? 3 : 2;
        const bodyHeight = Math.max(1, height - headerHeight - 5);
        const truncate = (value: string) => truncateToWidth(safeText(value, true), usable);
        const parent = stack.at(-1);
        const parentTitle = parent?.kind === "session" ? parent.session.title : parent?.title;
        const breadcrumb = parentTitle ? `${truncateToWidth(safeText(parentTitle, true), Math.max(8, Math.floor(usable / 3)))} / ` : "";
        const lines = [theme.fg("accent", truncate(`ClawSynapse / ${breadcrumb}${page.title}`))];
        const view = options.getView();
        lines.push(theme.fg("muted", truncate(`范围 ${options.config.botIds.length} 个 Bot    n 新请求 ${view ? view.observation.unread.length : "不可用"}    i 完整身份与配置`)));
        if (page.kind === "conversation") lines.push(theme.fg("muted", truncate(`已落盘分支 · ${bindingLabel(page.transcript.session)} ${page.transcript.session.bindingRevision}`)));
        paintedRows = [];
        if (busy) lines.push(theme.fg("muted", "读取中… Esc 可关闭"));
        else if (page.kind === "menu") {
          if (!page.rows.length) lines.push(options.config.autoDiscoverBots && !options.config.botIds.length
            ? "尚无已注册的本地 Bot；在 ClawSynapse 中创建后按 r 刷新。"
            : page.section === "sessions" ? "暂无已落盘会话。n 查看新请求，r 刷新。" : "暂无条目；r 刷新，Backspace 返回。");
          if (page.selected < page.top) page.top = page.selected;
          if (page.selected >= page.top + bodyHeight) page.top = page.selected - bodyHeight + 1;
          for (let index = page.top; index < Math.min(page.rows.length, page.top + bodyHeight); index++) {
            const row = page.rows[index]!;
            const value = truncate(`${index === page.selected ? ">" : " "} ${index + 1}. ${row.title}`);
            lines.push(index === page.selected ? theme.fg("accent", value) : value);
            if (row.request && usable >= 12) paintedRows.push({ text: value.trimEnd(), key: row.request });
          }
          while (lines.length < bodyHeight + headerHeight) lines.push("");
          lines.push(theme.fg("muted", truncate(page.rows[page.selected]?.description ?? `${page.rows.length} 条`)));
        } else if (page.kind === "detail") {
          if (page.width !== usable) { page.starts = [0]; page.page = 0; page.width = usable; }
          const slice = textPage(page.text, page.starts[page.page] ?? 0, usable, bodyHeight);
          nextTextOffset = slice.next;
          lines.push(...slice.lines);
          while (lines.length < bodyHeight + headerHeight) lines.push("");
          lines.push(theme.fg("muted", `第 ${page.page + 1} 页${slice.next < page.text.length ? " · 下页继续" : " · 已到底"}`));
        } else {
          if (page.width !== usable || page.rows !== bodyHeight) {
            page.starts = [page.starts[page.page] ?? { block: 0, part: 0, offset: 0 }];
            page.page = 0; page.width = usable; page.rows = bodyHeight;
          }
          const start = page.starts[page.page]!;
          const at = { ...start };
          let remaining = bodyHeight;
          while (remaining > 0 && at.block < page.transcript.blocks.length) {
            const block = page.transcript.blocks[at.block]!;
            const text = conversationPart(block, at.part, page.expanded);
            const slice = textPage(text, at.offset, usable, remaining);
            lines.push(...slice.lines.map(line => at.part === 0 ? theme.fg("accent", line) : line));
            remaining -= slice.lines.length;
            at.offset = slice.next;
            if (at.offset < text.length) break;
            at.part++; at.offset = 0;
            if (at.part >= 3 + block.details.length * (page.expanded ? 2 : 1)) { at.block++; at.part = 0; }
          }
          nextReadingPosition = at.block < page.transcript.blocks.length ? at : undefined;
          if (!page.transcript.blocks.length) lines.push("此分支没有可展示的消息；b 选择分支，Backspace 返回。");
          while (lines.length < bodyHeight + headerHeight) lines.push("");
          lines.push(theme.fg("muted", truncate(`第 ${page.page + 1} 页 · 消息 ${Math.min(start.block + 1, page.transcript.blocks.length)}/${page.transcript.blocks.length}${nextReadingPosition ? " · 下页继续" : " · 已到底"}   b 分支  a 子Agent  r 刷新`)));
        }
        const discoveryNotice = view?.discovery?.detail ?? "";
        const displayedNotice = [paintWarning, discoveryNotice, notice].filter(Boolean).join("；");
        lines.push(theme.fg(displayedNotice ? "warning" : "muted", truncate(displayedNotice || " ")));
        lines.push(theme.fg("muted", truncate(page.kind === "conversation" ? "PgUp/PgDn 翻页   ←/→ 消息   Enter 展开/折叠工具与 thinking" : page.kind === "detail" ? "PgUp/PgDn 翻页" : "↑/↓ 选择   Enter 打开   r 刷新")));
        lines.push(theme.fg("muted", truncate("Backspace 返回上一级   Esc 关闭   n 新请求   i 信息")));
        return lines.map(line => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) { close(); return; }
        if (matchesKey(data, "backspace")) {
          const previous = stack.pop();
          if (!previous) return;
          ++operation; busy = false;
          if (previous.kind === "session") run(() => showTranscript(previous.session, previous.leafId, previous.entryId, true, previous));
          else page = previous;
          paintedRows = []; nextReadingPosition = undefined; redraw(); return;
        }
        if (busy) return;
        if (data === "i") {
          push(detail("连接与会话信息", `${connectionText()}${page.kind === "conversation" ? `\n\n当前历史会话：\n${JSON.stringify(page.transcript.session, null, 2)}` : ""}`));
          return;
        }
        if (data === "n") { if (page.kind !== "menu" || page.section !== "requests") run(() => showRequests()); return; }
        if (data === "b" && page.kind === "conversation") { showBranches(page.transcript); return; }
        if (data === "a" && page.kind === "conversation") { const transcript = page.transcript; run(() => showChildren(transcript)); return; }
        if (data === "r") {
          ackBlocked = false;
          const refresh = page.kind === "menu" ? page.refresh : undefined;
          if (refresh) run(refresh);
          else if (page.kind === "conversation") {
            const saved = savePage(page);
            if (saved.kind === "session") run(() => showTranscript(saved.session, saved.leafId, saved.entryId, true, saved));
          } else run(async () => { await options.refreshObserver(); if (!disposed) notice = options.observationError ?? "已刷新观察状态"; });
          return;
        }
        if (page.kind === "menu") {
          if (matchesKey(data, "up")) page.selected = Math.max(0, page.selected - 1);
          else if (matchesKey(data, "down")) page.selected = Math.min(Math.max(0, page.rows.length - 1), page.selected + 1);
          else if (matchesKey(data, "pageUp")) page.selected = Math.max(0, page.selected - 10);
          else if (matchesKey(data, "pageDown")) page.selected = Math.min(Math.max(0, page.rows.length - 1), page.selected + 10);
          else if (matchesKey(data, "return")) { const action = page.rows[page.selected]?.action; if (action) run(action); }
        } else if (page.kind === "detail") {
          if (matchesKey(data, "pageDown") || matchesKey(data, "down")) {
            if (nextTextOffset < page.text.length) { page.starts[page.page + 1] = nextTextOffset; page.page++; }
          } else if (matchesKey(data, "pageUp") || matchesKey(data, "up")) page.page = Math.max(0, page.page - 1);
        } else {
          if (matchesKey(data, "pageDown") || matchesKey(data, "down")) {
            if (nextReadingPosition) { page.starts[page.page + 1] = nextReadingPosition; page.page++; }
          } else if (matchesKey(data, "pageUp") || matchesKey(data, "up")) page.page = Math.max(0, page.page - 1);
          else if (matchesKey(data, "return") || matchesKey(data, "left") || matchesKey(data, "right")) {
            const block = page.starts[page.page]?.block ?? 0;
            const step = matchesKey(data, "left") ? -1 : matchesKey(data, "right") ? 1 : 0;
            if (!step) page.expanded = !page.expanded;
            page.starts = [{ block: Math.max(0, Math.min(page.transcript.blocks.length - 1, block + step)), part: 0, offset: 0 }];
            page.page = 0;
          }
        }
        redraw();
      },
    };
  }, { overlay: true });
}

function bindingLabel(session: SessionSummary): string {
  return session.historicalBinding === "historical" ? "历史绑定" : session.historicalBinding === "current" ? "当前绑定" : "绑定状态未知";
}
