import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { RequestObserver } from "./client.ts";
import { canonicalPath, isWithin, loadConfig } from "./config.ts";
import { HistoryReader } from "./history.ts";
import { errorText } from "./safety.ts";
import { ObserverStore } from "./state.ts";
import type { Config } from "./types.ts";
import { formatStatus, openPanel } from "./ui.ts";

interface ActiveSession {
  ctx: ExtensionContext;
  id: string;
  config: Config;
  history: HistoryReader;
  listeners: Set<() => void>;
  store?: ObserverStore;
  observer?: RequestObserver;
  error?: string;
  closePanel?: () => void;
}

/** Materialize only the interactive owner's identity, never a Bot transcript being inspected. */
async function prepareIdentity(ctx: ExtensionContext, config: Config): Promise<void> {
  const manager = ctx.sessionManager;
  if (typeof manager?.getSessionId !== "function" || typeof manager?.getSessionFile !== "function" || typeof manager?.ensureOnDisk !== "function") {
    throw new Error("宿主缺少公开会话能力 getSessionId/getSessionFile/ensureOnDisk；仅可浏览历史");
  }
  if (typeof ctx.setTimeout !== "function" || typeof ctx.clearTimer !== "function") {
    throw new Error("宿主缺少托管定时器 setTimeout/clearTimer；仅可浏览历史");
  }
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  if (!id || !file) throw new Error("观察需要可恢复的交互会话；--no-session 仅可浏览历史");
  if (isWithin(config.dataDir, await canonicalPath(file))) throw new Error("不能在 Bot 数据目录中的交互会话启动观察");
  await manager.ensureOnDisk();
  if (isWithin(config.dataDir, await canonicalPath(file))) throw new Error("交互会话路径已改变到 Bot 数据目录");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("交互会话不是常规持久文件");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, size);
      size += read.bytesRead;
      const text = buffer.subarray(0, size).toString("utf8");
      const lines = text.split("\n");
      if (lines.length > 1) {
        let index = 0;
        let header: unknown;
        try {
          header = JSON.parse(lines[0]!);
          if (typeof header === "object" && header !== null && "type" in header && header.type === "title") {
            if (!("v" in header) || header.v !== 1) throw new Error("不支持的交互会话 title 版本");
            if (lines.length < 3) { if (read.bytesRead) continue; else break; }
            index = 1; header = JSON.parse(lines[index]!);
          }
        } catch { throw new Error("交互会话 header 非法，不能确认可恢复身份"); }
        if (!header || typeof header !== "object" || !("type" in header) || header.type !== "session" || !("id" in header) || header.id !== id) {
          throw new Error("交互会话 header.id 与当前 UUID 不一致");
        }
        return;
      }
      if (!read.bytesRead) break;
    }
    throw new Error("无法读取完整交互会话 header，观察未启动");
  } finally { await handle.close(); }
}

export default function clawsynapse(pi: ExtensionAPI) {
  let active: ActiveSession | undefined;
  let startupError = "插件尚未启动";
  let generation = 0;

  const stop = () => {
    ++generation;
    const previous = active; active = undefined;
    if (!previous) return;
    previous.closePanel?.(); previous.observer?.stop();
    previous.store?.close();
    previous.listeners.clear(); previous.ctx.ui.setStatus("clawsynapse", undefined);
  };
  const start = async (ctx: ExtensionContext) => {
    stop();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const ticket = generation;
    try {
      const config = await loadConfig(ctx.cwd);
      if (ticket !== generation) return;
      const session: ActiveSession = { ctx, id: typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "", config, history: new HistoryReader(config), listeners: new Set() };
      active = session;
      ctx.ui.setStatus("clawsynapse", "ClawSynapse · 连接中");
      try {
        await prepareIdentity(ctx, config);
        if (ticket !== generation || active !== session) return;
        const store = new ObserverStore(config, session.id); session.store = store;
        session.observer = new RequestObserver(config, store, {
          schedule: (callback, ms) => {
            const timer = ctx.setTimeout(callback, ms);
            return () => ctx.clearTimer(timer);
          },
          onChange: view => {
            if (ticket !== generation || active !== session) return;
            ctx.ui.setStatus("clawsynapse", formatStatus(view, process.stdout.columns || 80));
            for (const listener of session.listeners) listener();
          },
        });
        session.observer.start();
      } catch (error) {
        if (ticket !== generation || active !== session) return;
        session.observer?.stop(); session.store?.close(); session.store = undefined; session.observer = undefined;
        session.error = `观察已暂停：${errorText(error)}；历史仍可浏览，修复后重启插件`;
        ctx.ui.setStatus("clawsynapse", "ClawSynapse · 观察已暂停 · /clawsynapse 查看原因");
      }
    } catch (error) {
      if (ticket !== generation) return;
      startupError = `配置错误：${errorText(error)}。请检查用户 ~/.omp/clawsynapse.json 或项目 .omp/clawsynapse.json`;
      ctx.ui.setStatus("clawsynapse", "ClawSynapse · 配置错误 · /clawsynapse 查看原因");
    }
  };
  pi.on("session_start", async (_event, ctx) => { await start(ctx); });
  pi.on("session_switch", async (_event, ctx) => { await start(ctx); });
  pi.on("session_branch", async (_event, ctx) => {
    if (!active || typeof ctx.sessionManager?.getSessionId !== "function" || active.id !== ctx.sessionManager.getSessionId()) await start(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (!active || typeof ctx.sessionManager?.getSessionId !== "function" || active.id !== ctx.sessionManager.getSessionId()) await start(ctx);
  });
  pi.on("session_shutdown", () => { stop(); });
  pi.registerCommand("clawsynapse", {
    description: "查看 ClawSynapse 新请求及本机原生处理历史（只读）",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return;
      const session = active;
      if (!session) { ctx.ui.notify(startupError, "error"); return; }
      session.closePanel?.();
      await openPanel(ctx, {
        config: session.config, history: session.history,
        getView: () => session.observer?.getSnapshot(),
        subscribe: listener => { session.listeners.add(listener); return () => { session.listeners.delete(listener); }; },
        acknowledge: keys => {
          if (active !== session || !session.observer) throw new Error(session.error ?? "观察范围已切换，未确认查看");
          session.observer.acknowledge(keys);
        },
        refreshObserver: async () => {
          if (active !== session) throw new Error("观察范围已切换");
          if (!session.observer) throw new Error(session.error ?? "观察不可用");
          await session.observer.refresh();
        },
        observationError: session.error, prefix: args.trim() || undefined,
        onReady: close => { session.closePanel = close; },
      });
      session.closePanel = undefined;
    },
  });
}
