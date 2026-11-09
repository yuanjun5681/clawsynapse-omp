import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObserverStore } from "../src/state.ts";
import { LIMITS, type Config, type RequestMetadata } from "../src/types.ts";

const roots: string[] = [];
const stores: ObserverStore[] = [];
function fixture(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "clawsynapse-state-"));
  roots.push(root);
  mkdirSync(join(root, "data"), { mode: 0o700 });
  return { endpoint: "http://127.0.0.1:18080", dataDir: join(root, "data"), stateDir: join(root, "state"), botIds: ["bot-a"], pollIntervalMs: 1000, tokenFiles: {}, ...overrides };
}
function open(config: Config, session = "01234567-89ab-4cde-8f01-234567890abc") {
  const store = new ObserverStore(config, session);
  stores.push(store);
  return store;
}
function request(messageId: string, extra: Partial<RequestMetadata> = {}): RequestMetadata {
  return { botId: "bot-a", messageId, type: "chat.message", from: "remote", timestamp: 1700000000000, ...extra };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ObserverStore durable observation", () => {
  test("a restart restores cursors and exact metadata without replaying acknowledged requests", () => {
    const config = fixture();
    const first = open(config);
    expect(first.commitPage("bot-a", 0, undefined, 7, [])).toEqual({ revision: 1, cursors: { "bot-a": 7 }, unread: [] });
    first.commitPage("bot-a", 1, 7, 9, [request("one"), request("two", { runId: "run-two" })]);
    first.acknowledge([{ botId: "bot-a", messageId: "one" }], 2);
    first.close();
    expect(open(config).snapshot()).toEqual({ revision: 3, cursors: { "bot-a": 9 }, unread: [request("two", { runId: "run-two" })] });
    expect(statSync(config.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(config.stateDir, "observers.sqlite3")).mode & 0o777).toBe(0o600);
  });

  test("latest observed source follows local arrival order across restarts, not message ID or remote clock order", () => {
    const config = fixture();
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-a", 1, 0, 2, [
      request("z-first", { from: "first-source", timestamp: 200 }),
      request("a-later", { from: "latest-source", timestamp: 100 }),
    ]);
    store.close();
    expect(open(config).snapshot().unread.map(item => item.from)).toEqual(["first-source", "latest-source"]);
  });

  test("revision and cursor CAS reject stale windows and precise acknowledgement preserves concurrent arrivals", () => {
    const config = fixture();
    const first = open(config);
    const second = open(config);
    first.commitPage("bot-a", 0, undefined, 0, []);
    first.commitPage("bot-a", 1, 0, 1, [request("shown")]);
    const rendered = second.snapshot();
    first.commitPage("bot-a", 2, 1, 2, [request("arrived-later")]);
    expect(() => second.acknowledge(rendered.unread, rendered.revision)).toThrow(/revision/i);
    expect(() => second.commitPage("bot-a", 3, 0, 3, [request("stale")])).toThrow(/cursor/i);
    expect(second.acknowledge(rendered.unread, second.snapshot().revision).unread.map((item) => item.messageId)).toEqual(["arrived-later"]);
    expect(first.snapshot().cursors["bot-a"]).toBe(2);
  });

  test("a whole page rolls back at queue capacity and can be retried after exact acknowledgement", () => {
    const store = open(fixture());
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-a", 1, 0, 1000, Array.from({ length: 1000 }, (_, i) => request(`r-${i}`)));
    expect(() => store.commitPage("bot-a", 2, 1000, 1002, [request("extra-one"), request("extra-two")])).toThrow(/capacity|容量/i);
    expect(store.snapshot().cursors["bot-a"]).toBe(1000);
    expect(store.snapshot().unread).toHaveLength(1000);
    store.acknowledge([{ botId: "bot-a", messageId: "r-0" }, { botId: "bot-a", messageId: "r-1" }], 2);
    const next = store.commitPage("bot-a", 3, 1000, 1002, [request("extra-one"), request("extra-two")]);
    expect(next.revision).toBe(4);
    expect(next.unread).toHaveLength(1000);
    expect(next.cursors["bot-a"]).toBe(1002);
  });

  test("metadata is byte bounded, duplicates do not consume capacity, and snapshots cannot mutate persisted state", () => {
    const store = open(fixture());
    store.commitPage("bot-a", 0, undefined, 0, []);
    const base = request("edge", { sessionKey: "" });
    const overhead = Buffer.byteLength(JSON.stringify(base));
    const edge = { ...base, sessionKey: "é".repeat(Math.floor((LIMITS.metadataBytes - overhead) / 2)) + "x".repeat((LIMITS.metadataBytes - overhead) % 2) };
    store.commitPage("bot-a", 1, 0, 1, [edge, edge]);
    expect(() => store.commitPage("bot-a", 2, 1, 2, [request("too-large", { sessionKey: "é".repeat(4096) })])).toThrow(/metadata|元数据/i);
    const snapshot = store.snapshot();
    snapshot.unread[0]!.messageId = "mutated";
    snapshot.cursors["bot-a"] = 999;
    expect(store.snapshot().unread[0]!.messageId).toBe("edge");
    expect(store.snapshot().cursors["bot-a"]).toBe(1);
  });

  test("a real SQLite writer lock fails immediately without losing the committed page", () => {
    const config = fixture();
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 2, []);
    const blocker = new Database(join(config.stateDir, "observers.sqlite3"));
    blocker.run("BEGIN IMMEDIATE");
    try {
      expect(() => store.commitPage("bot-a", 1, 2, 3, [request("locked")])).toThrow();
    } finally {
      blocker.run("ROLLBACK");
      blocker.close();
    }
    expect(store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 2 }, unread: [] });
    expect(store.commitPage("bot-a", 1, 2, 3, [request("locked")]).unread).toEqual([request("locked")]);
  });

  test("canonical scopes share only identical sessions, endpoint, data root, and selected Bot sets", () => {
    const config = fixture({ botIds: ["bot-b", "bot-a", "bot-a"] });
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 8, []);
    const alias = join(config.dataDir, "..", "alias");
    symlinkSync(config.dataDir, alias);
    expect(open({ ...config, endpoint: `${config.endpoint}/`, dataDir: alias, botIds: ["bot-a", "bot-b"] }).snapshot().cursors).toEqual({ "bot-a": 8 });
    expect(open(config, "11234567-89ab-4cde-8f01-234567890abc").snapshot().cursors).toEqual({});
    expect(open({ ...config, endpoint: "http://127.0.0.1:18081" }).snapshot().cursors).toEqual({});
    expect(open({ ...config, botIds: ["bot-a"] }).snapshot().cursors).toEqual({});
    const otherData = join(config.dataDir, "..", "other-data");
    mkdirSync(otherData);
    expect(open({ ...config, dataDir: otherData }).snapshot().cursors).toEqual({});
  });

  test("new scopes are refused at the fixed limit without evicting existing observations", () => {
    const config = fixture();
    for (let i = 0; i < LIMITS.scopes; i++) open(config, `session-${i}`).close();
    expect(() => open(config, "one-too-many")).toThrow(/capacity|容量/i);
    expect(open(config, "session-0").snapshot()).toEqual({ revision: 0, cursors: {}, unread: [] });
  });

  test("unsafe state placement, symlink databases, corrupt databases, and unknown schemas are refused without replacement", () => {
    const config = fixture();
    expect(() => open({ ...config, stateDir: join(config.dataDir, "plugin") })).toThrow(/separate|分离/i);
    mkdirSync(config.stateDir, { mode: 0o700 });
    const target = join(config.dataDir, "sentinel");
    writeFileSync(target, "untouched", { mode: 0o600 });
    const path = join(config.stateDir, "observers.sqlite3");
    symlinkSync(target, path);
    expect(() => open(config)).toThrow(/regular|symlink|常规/i);
    rmSync(path);
    writeFileSync(path, "not sqlite", { mode: 0o600 });
    expect(() => open(config)).toThrow();
    expect(statSync(path).size).toBe(10);
    rmSync(path);
    writeFileSync(path, "", { mode: 0o600 });
    expect(() => open(config)).toThrow(/schema/);
    expect(statSync(path).size).toBe(0);
    rmSync(path);
    const future = new Database(path);
    future.run("PRAGMA user_version = 999");
    future.close();
    chmodSync(path, 0o600);
    expect(() => open(config)).toThrow(/schema/i);
    const preserved = new Database(path, { readonly: true });
    try { expect(preserved.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(999); }
    finally { preserved.close(); }
  });

  test("the same message ID belongs independently to each selected Bot", () => {
    const store = open(fixture({ botIds: ["bot-a", "bot-b"] }));
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-b", 1, undefined, 0, []);
    store.commitPage("bot-a", 2, 0, 1, [request("shared")]);
    store.commitPage("bot-b", 3, 0, 1, [request("shared", { botId: "bot-b" })]);
    const result = store.acknowledge([{ botId: "bot-a", messageId: "shared" }], 4);
    expect(result).toEqual({ revision: 5, cursors: { "bot-a": 1, "bot-b": 1 }, unread: [request("shared", { botId: "bot-b" })] });
  });

  test("a preexisting non-private state directory is refused rather than silently chmodded", () => {
    const config = fixture();
    mkdirSync(config.stateDir, { mode: 0o755 });
    chmodSync(config.stateDir, 0o755);
    expect(() => open(config)).toThrow(/0700/);
    expect(statSync(config.stateDir).mode & 0o777).toBe(0o755);
    expect(existsSync(join(config.stateDir, "observers.sqlite3"))).toBe(false);
  });

  test("an oversized main database is preserved and refused without rebuilding its scope", () => {
    const config = fixture();
    const original = open(config);
    original.commitPage("bot-a", 0, undefined, 7, []);
    original.close();
    const path = join(config.stateDir, "observers.sqlite3");
    truncateSync(path, LIMITS.databaseBytes + 1);
    expect(() => open(config)).toThrow(/capacity/i);
    expect(statSync(path).size).toBe(64 * 1024 * 1024 + 1);
  });

  test("baseline and decreasing or malformed page cursors never erase or advance state", () => {
    const store = open(fixture());
    expect(() => store.commitPage("bot-a", 0, undefined, 1, [request("old")])).toThrow();
    store.commitPage("bot-a", 0, undefined, 10, []);
    expect(() => store.commitPage("bot-a", 1, 10, 9, [])).toThrow();
    expect(() => store.commitPage("bot-a", 1, 10, Number.MAX_SAFE_INTEGER + 1, [])).toThrow();
    expect(() => store.commitPage("other-bot", 1, undefined, 0, [])).toThrow();
    expect(store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 10 }, unread: [] });
  });
});

describe("ObserverStore local catalog membership", () => {
  test("adding a Bot preserves existing cursors and unread requests without rebaselining", () => {
    const store = open(fixture({ autoDiscoverBots: true }));
    store.commitPage("bot-a", 0, undefined, 7, []);
    const before = store.commitPage("bot-a", 1, 7, 8, [request("saved-a")]);
    store.setBotIds(["bot-a", "bot-b"]);
    expect(store.snapshot()).toEqual(before);
    expect(() => store.commitPage("bot-a", 2, undefined, 99, [])).toThrow(/cursor/i);
    expect(store.commitPage("bot-b", 2, undefined, 20, [])).toEqual({
      revision: 3, cursors: { "bot-a": 8, "bot-b": 20 }, unread: [request("saved-a")],
    });
    expect(store.commitPage("bot-a", 3, 8, 9, [request("later-a")])).toEqual({
      revision: 4, cursors: { "bot-a": 9, "bot-b": 20 }, unread: [request("saved-a"), request("later-a")],
    });
  });

  test("removal hides but retains observations and rejects inactive or foreign acknowledgements atomically", () => {
    const config = fixture({ autoDiscoverBots: true, botIds: ["bot-a", "bot-b"] });
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-b", 1, undefined, 5, []);
    store.commitPage("bot-a", 2, 0, 1, [request("saved-a")]);
    const savedB = request("saved-b", { botId: "bot-b" });
    const durable = store.commitPage("bot-b", 3, 5, 6, [savedB]);
    store.setBotIds(["bot-b"]);
    const onlyB = { revision: 4, cursors: { "bot-b": 6 }, unread: [savedB] };
    expect(store.snapshot()).toEqual(onlyB);
    expect(() => store.acknowledge([savedB, request("saved-a")], 4)).toThrow();
    expect(() => store.acknowledge([{ botId: "foreign", messageId: "saved-b" }], 4)).toThrow();
    expect(() => store.commitPage("bot-a", 4, 1, 2, [request("hidden")])).toThrow();
    expect(store.snapshot()).toEqual(onlyB);
    store.setBotIds(["bot-a", "bot-b"]);
    expect(store.snapshot()).toEqual(durable);
    store.close();
    const reopened = open({ ...config, botIds: ["bot-b"] });
    expect(reopened.snapshot()).toEqual(onlyB);
    expect(() => reopened.commitPage("bot-b", 4, undefined, 99, [])).toThrow(/cursor/i);
    reopened.setBotIds(["bot-a", "bot-b"]);
    expect(() => reopened.commitPage("bot-a", 4, undefined, 99, [])).toThrow(/cursor/i);
    expect(reopened.snapshot()).toEqual(durable);
  });

  test("zero membership at startup or reopening never clears durable state or revision", () => {
    const config = fixture({ autoDiscoverBots: true, botIds: [] });
    const store = open(config);
    expect(store.snapshot()).toEqual({ revision: 0, cursors: {}, unread: [] });
    store.setBotIds(["bot-a"]);
    store.commitPage("bot-a", 0, undefined, 10, []);
    const durable = store.commitPage("bot-a", 1, 10, 11, [request("retained")]);
    store.setBotIds([]);
    expect(store.snapshot()).toEqual({ revision: 2, cursors: {}, unread: [] });
    expect(() => store.acknowledge([request("retained")], 2)).toThrow();
    store.close();
    const empty = open(config);
    expect(empty.snapshot()).toEqual({ revision: 2, cursors: {}, unread: [] });
    empty.close();
    const restored = open({ ...config, botIds: ["bot-a"] });
    expect(restored.snapshot()).toEqual(durable);
    expect(() => restored.commitPage("bot-a", 2, undefined, 99, [])).toThrow(/cursor/i);
    expect(restored.snapshot()).toEqual(durable);
  });

  test("windows with different memberships share revision CAS while exposing only their active Bots", () => {
    const config = fixture({ autoDiscoverBots: true });
    const first = open(config);
    first.commitPage("bot-a", 0, undefined, 0, []);
    const rendered = first.commitPage("bot-a", 1, 0, 1, [request("shown-a")]);
    const second = open({ ...config, botIds: ["bot-b"] });
    expect(second.snapshot()).toEqual({ revision: 2, cursors: {}, unread: [] });
    second.commitPage("bot-b", 2, undefined, 0, []);
    expect(() => first.commitPage("bot-a", 2, 1, 2, [request("later-a")])).toThrow(/revision/i);
    first.commitPage("bot-a", 3, 1, 2, [request("later-a")]);
    const savedB = request("saved-b", { botId: "bot-b" });
    expect(() => second.commitPage("bot-b", 3, 0, 1, [savedB])).toThrow(/revision/i);
    second.commitPage("bot-b", 4, 0, 1, [savedB]);
    expect(() => first.acknowledge(rendered.unread, rendered.revision)).toThrow(/revision/i);
    expect(first.acknowledge(rendered.unread, 5)).toEqual({
      revision: 6, cursors: { "bot-a": 2 }, unread: [request("later-a")],
    });
    expect(second.snapshot()).toEqual({ revision: 6, cursors: { "bot-b": 1 }, unread: [savedB] });
  });

  test("automatic scope markers remain isolated from unchanged explicit Bot-set scopes", () => {
    const config = fixture({ autoDiscoverBots: true });
    const automatic = open(config);
    automatic.commitPage("bot-a", 0, undefined, 7, []);
    const explicit = open({ ...config, autoDiscoverBots: false });
    expect(explicit.snapshot()).toEqual({ revision: 0, cursors: {}, unread: [] });
    expect(() => explicit.setBotIds(["bot-a"])).toThrow();
    explicit.commitPage("bot-a", 0, undefined, 99, []);
    automatic.setBotIds(["bot-a", "bot-b"]);
    expect(automatic.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 7 }, unread: [] });
    expect(open({ ...config, autoDiscoverBots: false, botIds: ["bot-a", "bot-b"] }).snapshot()).toEqual({
      revision: 0, cursors: {}, unread: [],
    });
    expect(open({ ...config, autoDiscoverBots: false }).snapshot().cursors).toEqual({ "bot-a": 99 });
    expect(() => open({ ...config, autoDiscoverBots: false, botIds: [] })).toThrow();
  });

  test("membership updates copy their input and reject malformed IDs without changing the active set", () => {
    const store = open(fixture({ autoDiscoverBots: true }));
    store.commitPage("bot-a", 0, undefined, 7, []);
    const botIds = ["bot-a"];
    store.setBotIds(botIds);
    botIds.push("bot-b");
    expect(() => store.commitPage("bot-b", 1, undefined, 0, [])).toThrow();
    expect(() => store.setBotIds(["bot-b", ""])).toThrow();
    expect(store.snapshot()).toEqual({ revision: 1, cursors: { "bot-a": 7 }, unread: [] });
    store.close();
    expect(() => store.setBotIds([])).toThrow(/关闭/);
  });

  test("inactive retained requests still consume queue capacity and failed pages roll back", () => {
    const store = open(fixture({ autoDiscoverBots: true }));
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-a", 1, 0, LIMITS.unreadCount, Array.from({ length: LIMITS.unreadCount }, (_, i) => request(`r-${i}`)));
    store.setBotIds(["bot-b"]);
    store.commitPage("bot-b", 2, undefined, 0, []);
    const savedB = request("extra-b", { botId: "bot-b" });
    expect(() => store.commitPage("bot-b", 3, 0, 1, [savedB])).toThrow(/capacity|容量/i);
    expect(store.snapshot()).toEqual({ revision: 3, cursors: { "bot-b": 0 }, unread: [] });
    store.setBotIds(["bot-a", "bot-b"]);
    expect(store.snapshot().unread).toHaveLength(LIMITS.unreadCount);
    expect(store.snapshot().cursors).toEqual({ "bot-a": LIMITS.unreadCount, "bot-b": 0 });
    store.acknowledge([{ botId: "bot-a", messageId: "r-0" }], 3);
    const accepted = store.commitPage("bot-b", 4, 0, 1, [savedB]);
    expect(accepted.revision).toBe(5);
    expect(accepted.unread).toHaveLength(LIMITS.unreadCount);
    expect(accepted.unread.at(-1)).toEqual(savedB);
  });

  test("inactive cursor and metadata rows are validated before snapshots hide them", () => {
    const config = fixture({ autoDiscoverBots: true });
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-a", 1, 0, 1, [request("saved")]);
    store.setBotIds([]);
    const database = new Database(join(config.stateDir, "observers.sqlite3"));
    try {
      database.run("UPDATE cursors SET bot_id = ''");
      expect(() => store.snapshot()).toThrow(/cursor/i);
      database.run("UPDATE cursors SET bot_id = 'bot-a'");
      const invalid = JSON.stringify(request("saved", { from: "bot-a" }));
      database.query("UPDATE unread SET metadata = ?, bytes = ?").run(invalid, Buffer.byteLength(invalid));
      expect(() => store.snapshot()).toThrow(/元数据/);
      expect(() => open({ ...config, botIds: [] })).toThrow(/元数据/);
      const valid = JSON.stringify(request("saved"));
      database.query("UPDATE unread SET metadata = ?, bytes = ?, message_id = 'mismatch'").run(valid, Buffer.byteLength(valid));
      expect(() => store.snapshot()).toThrow(/请求 ID/);
    } finally {
      database.close();
    }
  });

  test("explicit scopes continue rejecting persisted rows for unselected Bots", () => {
    const config = fixture();
    const store = open(config);
    store.commitPage("bot-a", 0, undefined, 0, []);
    store.commitPage("bot-a", 1, 0, 1, [request("saved")]);
    const database = new Database(join(config.stateDir, "observers.sqlite3"));
    try {
      database.run("UPDATE cursors SET bot_id = 'foreign'");
      expect(() => store.snapshot()).toThrow(/cursor/i);
      database.run("UPDATE cursors SET bot_id = 'bot-a'");
      const foreign = JSON.stringify(request("saved", { botId: "foreign" }));
      database.query("UPDATE unread SET bot_id = 'foreign', metadata = ?, bytes = ?").run(foreign, Buffer.byteLength(foreign));
      expect(() => store.snapshot()).toThrow(/元数据/);
    } finally {
      database.close();
    }
  });
});
