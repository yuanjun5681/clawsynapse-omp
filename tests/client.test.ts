import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestObserver } from "../src/client.ts";
import { ObserverStore } from "../src/state.ts";
import { LIMITS, type Config, type ObserverView } from "../src/types.ts";

const cleanup: (() => void | Promise<void>)[] = [];
function deferred<T>() { return Promise.withResolvers<T>(); }
function envelope(cursor: number, extra: Record<string, unknown> = {}) {
  return { cursor, id: `m-${cursor}`, type: "chat.message", from: "remote", to: "bot-a", ts: 1700000000000 + cursor, payload: { text: "never persist this body" }, ...extra };
}
function page(items: unknown[], cursor: number) { return Response.json({ ok: true, code: "msg.replay", data: { items, cursor } }); }
function scheduler() {
  const jobs: { ms: number; callback: () => void; canceled: boolean }[] = [];
  return {
    jobs,
    schedule(callback: () => void, ms: number) {
      const job = { ms, callback, canceled: false };
      jobs.push(job);
      if (ms === 0) queueMicrotask(() => { if (!job.canceled) { job.canceled = true; callback(); } });
      return () => { job.canceled = true; };
    },
    fire(ms: number) {
      const job = jobs.find((entry) => entry.ms === ms && !entry.canceled);
      if (!job) throw new Error(`No managed timer for ${ms}`);
      job.canceled = true;
      job.callback();
    },
  };
}
function fixture(handler: (request: Request) => Response | Promise<Response>, botIds = ["bot-a"], extra: Partial<Config> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clawsynapse-client-")));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const config: Config = { endpoint: `http://127.0.0.1:${server.port}`, dataDir: join(root, "data"), stateDir: join(root, "state"), botIds, pollIntervalMs: 1000, tokenFiles: {}, ...extra };
  const store = new ObserverStore(config, "01234567-89ab-4cde-8f01-234567890abc");
  const timers = scheduler();
  const changes: ObserverView[] = [];
  const observer = new RequestObserver(config, store, { schedule: timers.schedule, onChange: (view) => changes.push(view) });
  cleanup.push(async () => { observer.stop(); store.close(); await server.stop(true); rmSync(root, { recursive: true, force: true }); });
  return { root, server, config, store, timers, changes, observer };
}
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); });

describe("RequestObserver HTTP seam", () => {
  test("first contact establishes only a baseline; later remote commands count while every valid event advances the cursor", async () => {
    let baseline = true;
    const f = fixture((request) => {
      const after = new URL(request.url).searchParams.get("after");
      if (after === null) return page([envelope(baseline ? 9 : 18)], baseline ? 9 : 18);
      if (after === "9") return page([
        envelope(10, { type: "task.assign", requestId: "req", runId: "run", sessionKey: "topic" }),
        envelope(11, { type: "chat.message", from: "bot-a" }),
        envelope(12, { type: "run.completed" }), envelope(13, { type: "chat.progress" }),
        envelope(14, { type: "chat.response" }), envelope(15, { type: "chat.error" }),
        envelope(16, { type: "unknown.command" }), envelope(17, { to: "other-bot" }),
        envelope(18, { type: "chat.message", to: undefined }),
      ], 18);
      return page([], 18);
    });
    await f.observer.refresh();
    expect(f.observer.getSnapshot().observation).toEqual({ revision: 1, cursors: { "bot-a": 9 }, unread: [] });
    baseline = false;
    await f.observer.refresh();
    const view = f.observer.getSnapshot();
    expect(view.observation.cursors["bot-a"]).toBe(18);
    expect(view.observation.unread).toEqual([
      { botId: "bot-a", messageId: "m-10", type: "task.assign", from: "remote", timestamp: 1700000000010, requestId: "req", runId: "run", sessionKey: "topic" },
      { botId: "bot-a", messageId: "m-18", type: "chat.message", from: "remote", timestamp: 1700000000018 },
    ]);
    expect(view.bots[0]?.state).toBe("connected");
    expect(f.timers.jobs.filter((job) => job.ms === 1000)).toHaveLength(0);
  });

  test("sender names are scoped to the receiving Bot and naming failures do not change durable requests", async () => {
    let namesAvailable = true;
    const f = fixture((request) => {
      const url = new URL(request.url);
      const botId = url.pathname.includes("/bot-b/") ? "bot-b" : "bot-a";
      if (url.pathname.endsWith("/peers")) return namesAvailable
        ? Response.json({ ok: true, code: "peers.ok", data: { items: [{ botId: "remote", displayName: "Public name", localAlias: botId === "bot-a" ? "Local alias" : "" }] } })
        : new Response("PRIVATE-PEER-ERROR", { status: 403 });
      return url.searchParams.has("after") ? page([], 1) : page([envelope(1, { to: botId })], 1);
    }, ["bot-a", "bot-b"]);
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    f.store.commitPage("bot-a", 1, 0, 1, [{ botId: "bot-a", messageId: "a", type: "chat.message", from: "remote", timestamp: 1 }]);
    f.store.commitPage("bot-b", 2, undefined, 0, []);
    f.store.commitPage("bot-b", 3, 0, 1, [{ botId: "bot-b", messageId: "b", type: "chat.message", from: "remote", timestamp: 1 }]);
    const durable = f.store.snapshot();
    await f.observer.refresh();
    expect(f.observer.getSnapshot().peerNames).toEqual({ "bot-a": { remote: "Local alias" }, "bot-b": { remote: "Public name" } });
    namesAvailable = false;
    await f.observer.refresh();
    const view = f.observer.getSnapshot();
    expect(view.peerNames).toEqual({ "bot-a": {}, "bot-b": {} });
    expect(view.bots.map(bot => bot.state)).toEqual(["connected", "connected"]);
    expect(f.store.snapshot().cursors).toEqual(durable.cursors);
    expect(f.store.snapshot().unread).toEqual(durable.unread);
    expect(JSON.stringify(view)).not.toContain("PRIVATE-PEER-ERROR");
  });

  test("backlog pagination stops after five pages and resumes the exact committed cursor next round", async () => {
    const afters: number[] = [];
    const f = fixture((request) => {
      const raw = new URL(request.url).searchParams.get("after");
      if (raw === null) return page([envelope(0)], 0);
      const after = Number(raw);
      afters.push(after);
      return page([envelope(after + 1)], after + 1);
    });
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    await f.observer.refresh();
    expect(afters).toEqual([0, 1, 2, 3, 4]);
    expect(f.store.snapshot().cursors["bot-a"]).toBe(5);
    await f.observer.refresh();
    expect(afters).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(f.store.snapshot().unread).toHaveLength(10);
  });

  test("acknowledgement uses exactly rendered IDs even when another window commits a new request", async () => {
    const f = fixture(() => page([], 0));
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    f.store.commitPage("bot-a", 1, 0, 1, [{ botId: "bot-a", messageId: "shown", type: "chat.message", from: "remote", timestamp: 1 }]);
    const rendered = f.store.snapshot().unread;
    const other = new ObserverStore(f.config, "01234567-89ab-4cde-8f01-234567890abc");
    try { other.commitPage("bot-a", 2, 1, 2, [{ botId: "bot-a", messageId: "new", type: "task.assign", from: "remote", timestamp: 2 }]); }
    finally { other.close(); }
    f.observer.acknowledge(rendered);
    expect(f.observer.getSnapshot().observation.unread.map((item) => item.messageId)).toEqual(["new"]);
    expect(f.changes.at(-1)?.observation.cursors["bot-a"]).toBe(2);
  });

  test.each([401, 403, 404, 409, 500])("HTTP %s is recognizable without exposing a secret response body or moving the cursor", async (status) => {
    const f = fixture(() => new Response("TOP-SECRET-BODY", { status }));
    f.store.commitPage("bot-a", 0, undefined, 10, []);
    await f.observer.refresh();
    const view = f.observer.getSnapshot();
    expect(view.bots[0]?.state).toBe("error");
    expect(view.bots[0]?.detail).toContain(String(status));
    expect(JSON.stringify(view)).not.toContain("TOP-SECRET");
    expect(view.observation.cursors["bot-a"]).toBe(10);
  });

  test("each Bot reports its own failure while another Bot can establish a baseline", async () => {
    const f = fixture((request) => request.url.includes("bot-b/") ? new Response("no", { status: 403 }) : page([], 12), ["bot-a", "bot-b"]);
    await f.observer.refresh();
    expect(f.observer.getSnapshot().bots.map((bot) => [bot.botId, bot.state])).toEqual([["bot-a", "connected"], ["bot-b", "error"]]);
    expect(f.store.snapshot().cursors).toEqual({ "bot-a": 12 });
  });

  test.each([
    { ok: false, code: "unauthorized", message: "SECRET-BUSINESS" },
    { ok: true, code: "msg.replay", data: { items: [], cursor: Number.MAX_SAFE_INTEGER + 1 } },
    { ok: true, code: "msg.replay", data: { items: [envelope(2), envelope(1)], cursor: 2 } },
    { ok: true, code: "msg.replay", data: { items: [envelope(2)], cursor: 3 } },
    { ok: true, code: "msg.replay", data: { items: [envelope(2, { from: null })], cursor: 2 } },
    { ok: true, code: "msg.replay", data: { items: [envelope(2, { runId: 9 })], cursor: 2 } },
    { ok: true, code: "msg.replay", data: { items: [envelope(2, { ts: 8_640_000_000_000_001 })], cursor: 2 } },
    { ok: true, code: "msg.replay", data: { items: null, cursor: 2 } },
  ])("invalid or daemon-error pages preserve the entire previous observation: %#", async (body) => {
    const f = fixture(() => Response.json(body));
    f.store.commitPage("bot-a", 0, undefined, 1, []);
    await f.observer.refresh();
    expect(f.store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 1 }, unread: [] });
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("error");
    expect(JSON.stringify(f.observer.getSnapshot())).not.toContain("SECRET-BUSINESS");
  });

  test("malformed JSON and invalid UTF-8 are not treated as an empty inbox", async () => {
    for (const body of ["{not json", new Uint8Array([0xff])]) {
      const f = fixture(() => new Response(body));
      await f.observer.refresh();
      expect(f.store.snapshot().cursors).toEqual({});
      expect(f.observer.getSnapshot().bots[0]?.state).toBe("error");
    }
  });

  test("an empty replay checks the recent cursor and pauses on detectable dataset rollback", async () => {
    const f = fixture((request) => new URL(request.url).searchParams.has("after") ? page([], 10) : page([envelope(3)], 3));
    f.store.commitPage("bot-a", 0, undefined, 10, []);
    await f.observer.refresh();
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("paused");
    expect(f.observer.getSnapshot().bots[0]?.detail).toMatch(/回退|替换/);
    expect(f.store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 10 }, unread: [] });
  });

  test("a valid response exactly at the decoded byte limit is accepted", async () => {
    const prefix = '{"ok":true,"code":"msg.recent","data":{"items":[],"cursor":0},"padding":"';
    const suffix = '"}';
    const body = prefix + "x".repeat(LIMITS.responseBytes - Buffer.byteLength(prefix + suffix)) + suffix;
    const f = fixture(() => new Response(body));
    await f.observer.refresh();
    expect(f.store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 0 }, unread: [] });
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("connected");
  });

  test("compressed responses are limited by decoded size, not their small wire length", async () => {
    const compressed = Bun.gzipSync(new Uint8Array(9 * 1024 * 1024).fill(32));
    const f = fixture(() => new Response(compressed, { headers: { "content-encoding": "gzip" } }));
    await f.observer.refresh();
    expect(f.store.snapshot()).toEqual({ revision: 0, cursors: {}, unread: [] });
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("paused");
    expect(f.observer.getSnapshot().bots[0]?.detail).toContain("8 MiB");
  });

  test("a decoded streaming response over 8 MiB is canceled and paused instead of repeatedly fetched", async () => {
    let calls = 0;
    const f = fixture(() => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const chunk = new Uint8Array(1024 * 1024).fill(32);
          for (let i = 0; i < 9; i++) controller.enqueue(chunk);
          controller.close();
        },
      }));
    });
    f.observer.start();
    await f.observer.refresh();
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("paused");
    expect(f.store.snapshot().cursors).toEqual({});
    f.timers.fire(1000);
    // Join the automatic round without turning this into an explicit retry.
    await Promise.resolve();
    expect(calls).toBe(1);
    f.observer.stop();
  });

  test("metadata over its byte limit pauses without a partial-page commit", async () => {
    const f = fixture(() => page([envelope(1), envelope(2, { sessionKey: "x".repeat(LIMITS.metadataBytes) })], 2));
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    await f.observer.refresh();
    expect(f.store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 0 }, unread: [] });
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("paused");
  });

  test("queue capacity pauses the whole failed page, then exact acknowledgement permits replay", async () => {
    const f = fixture((request) => {
      const after = new URL(request.url).searchParams.get("after");
      return after === "1000" ? page([envelope(1001)], 1001) : after === null ? page([envelope(1001)], 1001) : page([], 1001);
    });
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    f.store.commitPage("bot-a", 1, 0, 1000, Array.from({ length: 1000 }, (_, i) => ({ botId: "bot-a", messageId: `old-${i}`, type: "chat.message" as const, from: "remote", timestamp: i })));
    await f.observer.refresh();
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("paused");
    expect(f.store.snapshot().cursors["bot-a"]).toBe(1000);
    expect(f.store.snapshot().unread).toHaveLength(1000);
    f.observer.acknowledge([{ botId: "bot-a", messageId: "old-0" }]);
    await f.observer.refresh();
    const state = f.store.snapshot();
    expect(state.cursors["bot-a"]).toBe(1001);
    expect(state.unread).toHaveLength(1000);
    expect(state.unread.some((item) => item.messageId === "old-0")).toBe(false);
    expect(state.unread.find((item) => item.messageId === "m-1001")).toEqual({ botId: "bot-a", messageId: "m-1001", type: "chat.message", from: "remote", timestamp: 1700000001001 });
  });

  test("failed acknowledgement retains rendered IDs and can recover after a real writer lock is released", () => {
    const f = fixture(() => page([], 0));
    f.store.commitPage("bot-a", 0, undefined, 0, []);
    const shown = { botId: "bot-a", messageId: "shown", type: "chat.message" as const, from: "remote", timestamp: 1 };
    f.store.commitPage("bot-a", 1, 0, 1, [shown]);
    const blocker = new Database(join(f.config.stateDir, "observers.sqlite3"));
    blocker.run("BEGIN IMMEDIATE");
    try {
      expect(() => f.observer.acknowledge([shown])).toThrow(/存储/);
      expect(f.observer.getSnapshot().observation).toEqual({ revision: 2, cursors: { "bot-a": 1 }, unread: [shown] });
      expect(f.observer.getSnapshot().bots[0]?.detail).toContain("存储");
    } finally { blocker.run("ROLLBACK"); blocker.close(); }
    f.observer.acknowledge([shown]);
    expect(f.observer.getSnapshot().observation).toEqual({ revision: 3, cursors: { "bot-a": 1 }, unread: [] });
  });

  test("stop aborts HTTP, cancels managed timers, and prevents late commits or callbacks; restarting uses a new generation", async () => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    let first = true;
    const f = fixture(() => { if (first) { first = false; entered.resolve(); return release.promise; } return page([], 4); });
    f.observer.start();
    const old = f.observer.refresh();
    await entered.promise;
    f.observer.stop();
    const before = f.changes.length;
    expect(f.timers.jobs.every((job) => job.canceled)).toBe(true);
    f.observer.start();
    const fresh = f.observer.refresh();
    release.resolve(page([envelope(99)], 99));
    await Promise.all([old, fresh]);
    expect(f.store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 4 }, unread: [] });
    expect(f.changes).toHaveLength(before + 1);
    expect(f.changes.slice(before).map((view) => view.observation.cursors["bot-a"])).toEqual([4]);
  });

  test("simultaneous refreshes share one HTTP operation and an explicit managed timeout reports offline", async () => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    let calls = 0;
    const f = fixture(() => { calls++; entered.resolve(); return release.promise; });
    const first = f.observer.refresh();
    const second = f.observer.refresh();
    expect(first).toBe(second);
    await entered.promise;
    f.timers.fire(LIMITS.timeoutMs);
    await first;
    expect(calls).toBe(1);
    expect(f.observer.getSnapshot().bots[0]?.state).toBe("offline");
    expect(f.store.snapshot().cursors).toEqual({});
    release.resolve(page([], 0));
  });

  test("redirects are never followed", async () => {
    let followed = false;
    const f = fixture((request) => {
      if (new URL(request.url).pathname === "/forbidden") { followed = true; return page([], 0); }
      return new Response(null, { status: 302, headers: { location: "/forbidden" } });
    });
    await f.observer.refresh();
    expect(followed).toBe(false);
    expect(f.observer.getSnapshot().bots[0]?.state).not.toBe("connected");
    expect(f.store.snapshot().cursors).toEqual({});
  });

  test("private per-Bot token files are sent only to that Bot; insecure files pause without leaking secrets", async () => {
    const received: (string | null)[] = [];
    const f = fixture((request) => { received.push(request.headers.get("authorization")); return page([], 0); });
    const tokenPath = join(f.root, "token");
    writeFileSync(tokenPath, "fixture-secret-token\n", { mode: 0o600 });
    const privateConfig = { ...f.config, tokenFiles: { "bot-a": tokenPath } };
    const observer = new RequestObserver(privateConfig, f.store, { schedule: f.timers.schedule, onChange: () => {} });
    cleanup.push(() => observer.stop());
    await observer.refresh();
    expect(received).toEqual(["Bearer fixture-secret-token"]);
    chmodSync(tokenPath, 0o644);
    await observer.refresh();
    expect(received).toHaveLength(1);
    expect(observer.getSnapshot().bots[0]?.state).toBe("paused");
    expect(JSON.stringify(observer.getSnapshot())).not.toContain("fixture-secret-token");
  });

  test("local catalog changes add baselines without resetting existing requests and recover after empty or damaged discovery", async () => {
    const a = `n1-${"a".repeat(32)}`, b = `n1-${"b".repeat(32)}`;
    const cursors: Record<string, number> = { [a]: 5, [b]: 9 };
    const afters: { botId: string; after: string | null }[] = [];
    const f = fixture(request => {
      const url = new URL(request.url);
      if (url.pathname === "/v2/health") return Response.json({ ok: true, code: "daemon.healthy", data: {} });
      if (url.pathname.endsWith("/peers")) return Response.json({ ok: true, code: "peers.ok", data: { items: [] } });
      const botId = url.pathname.split("/")[3]!;
      const after = url.searchParams.get("after");
      afters.push({ botId, after });
      const cursor = cursors[botId]!;
      const items = after === null ? [envelope(cursor, { id: `${botId}-${cursor}`, to: botId })]
        : Array.from({ length: Math.max(0, cursor - Number(after)) }, (_, i) => {
          const value = Number(after) + i + 1;
          return envelope(value, { id: `${botId}-${value}`, to: botId });
        });
      return page(items, cursor);
    }, [], { autoDiscoverBots: true });
    const catalog = (ids: string[]) => writeFileSync(join(f.config.dataDir, "bots.json"), JSON.stringify({
      schemaVersion: 3, bots: ids.map(botId => ({ botId, desiredState: "stopped", archived: false })),
    }));
    await f.observer.refresh();
    expect(f.observer.getSnapshot().discovery?.state).toBe("waiting");
    catalog([a]);
    await f.observer.refresh();
    expect(f.observer.getSnapshot().observation).toMatchObject({ cursors: { [a]: 5 }, unread: [] });
    cursors[a] = 6;
    await f.observer.refresh();
    catalog([a, b]);
    cursors[a] = 7;
    await f.observer.refresh();
    expect(f.observer.getSnapshot().observation.unread.map(item => item.messageId)).toEqual([`${a}-6`, `${a}-7`]);
    expect(f.observer.getSnapshot().observation.cursors).toEqual({ [a]: 7, [b]: 9 });
    catalog([b]);
    await f.observer.refresh();
    expect(f.observer.getSnapshot().bots.map(bot => bot.botId)).toEqual([b]);
    expect(f.observer.getSnapshot().observation.unread).toEqual([]);
    catalog([a, b]);
    cursors[a] = 8;
    await f.observer.refresh();
    expect(f.observer.getSnapshot().observation.unread.map(item => item.messageId)).toEqual([`${a}-6`, `${a}-7`, `${a}-8`]);
    const durable = f.store.snapshot();
    const calls = afters.length;
    writeFileSync(join(f.config.dataDir, "bots.json"), "{broken");
    await f.observer.refresh();
    expect(f.observer.getSnapshot().discovery?.state).toBe("error");
    expect(f.store.snapshot()).toEqual(durable);
    expect(afters.length).toBe(calls);
    catalog([a, b]);
    await f.observer.refresh();
    expect(f.observer.getSnapshot().discovery).toBeUndefined();
    expect(f.observer.getSnapshot().observation.unread).toEqual(durable.unread);
  });

  test("an empty local catalog checks daemon health without following redirects or sending Bot credentials", async () => {
    let followed = false;
    const credentials: (string | null)[] = [];
    const f = fixture(request => {
      credentials.push(request.headers.get("authorization"));
      if (new URL(request.url).pathname !== "/v2/health") { followed = true; return page([], 0); }
      return new Response(null, { status: 302, headers: { location: "/wrong-service" } });
    }, [], { autoDiscoverBots: true, tokenFiles: { unused: "/must-not-read-token" } });
    await f.observer.refresh();
    expect(followed).toBe(false);
    expect(credentials).toEqual([null]);
    expect(f.observer.getSnapshot().discovery?.state).toBe("error");
    expect(f.store.snapshot().cursors).toEqual({});
  });
});
