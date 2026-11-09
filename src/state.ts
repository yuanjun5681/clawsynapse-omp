import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LIMITS, type Config, type ObservationState, type RequestKey, type RequestMetadata } from "./types.ts";

const LOCAL_FILESYSTEMS = new Set([
  0x1a, 0x11, 0x11954, 0x4d44, // APFS, HFS, UFS, FAT
  0xef53, 0x1021994, 0x9123683e, 0x58465342, 0x2fc12fc1,
  0x794c7630, 0x858458f6, 0xf2f52010, 0x2011bab0, // local Linux filesystems
]);
function fail(name: string, message: string): never {
  const error = new Error(message);
  error.name = name;
  throw error;
}
function safeInteger(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
function canonicalPath(path: string): string {
  if (!isAbsolute(path)) throw new Error("观察目录必须是绝对路径");
  let ancestor = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(ancestor), ...tail); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      tail.unshift(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
  }
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
function regularPrivateFile(path: string, mainDatabase = false): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("观察数据库必须是独立常规文件，不能是 symlink");
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) throw new Error("观察数据库必须由当前用户拥有且权限为 0600");
  if (mainDatabase && stat.size > LIMITS.databaseBytes) fail("ObservationCapacityError", "状态库 capacity 超过 64 MiB");
}
function normalizeMetadata(input: RequestMetadata, botIds: Set<string>): { value: RequestMetadata; json: string; bytes: number } {
  if (!input || !botIds.has(input.botId) || typeof input.messageId !== "string" || !input.messageId ||
      (input.type !== "chat.message" && input.type !== "task.assign") || typeof input.from !== "string" || !input.from ||
      input.from === input.botId || !safeInteger(input.timestamp) || input.timestamp > 8_640_000_000_000_000) throw new Error("请求元数据格式非法");
  const value: RequestMetadata = { botId: input.botId, messageId: input.messageId, type: input.type, from: input.from, timestamp: input.timestamp };
  for (const key of ["requestId", "runId", "sessionKey"] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== "string") throw new Error("请求关联元数据格式非法");
      value[key] = input[key];
    }
  }
  const json = JSON.stringify(value);
  const bytes = Buffer.byteLength(json);
  if (bytes > LIMITS.metadataBytes) fail("ObservationCapacityError", "单条 metadata 元数据超过 8 KiB，观察已暂停");
  return { value, json, bytes };
}

/** Durable per-interactive-session observations. Every mutation is a short revision-CAS transaction. */
export class ObserverStore {
  private readonly db: Database;
  private readonly scope: string;
  private readonly botIds: Set<string>;
  private closed = false;

  constructor(config: Config, sessionId: string) {
    if (!sessionId || !config.botIds.length || config.botIds.some((id) => typeof id !== "string" || !id)) throw new Error("观察范围缺少 session 或 Bot ID");
    const dataDir = canonicalPath(config.dataDir);
    const stateDir = canonicalPath(config.stateDir);
    if (dirname(stateDir) === stateDir || stateDir === canonicalPath(homedir())) throw new Error("stateDir 必须为独立专用目录，不能是 HOME 或文件系统根");
    if (contains(dataDir, stateDir) || contains(stateDir, dataDir)) throw new Error("stateDir 与 DataDir 必须 separate 分离");
    const endpoint = new URL(config.endpoint);
    if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname) || !/^\/*$/.test(endpoint.pathname)) throw new Error("观察 endpoint 必须是明确的 loopback HTTP origin");
    this.botIds = new Set([...config.botIds].sort());
    this.scope = JSON.stringify([sessionId, endpoint.origin, dataDir, [...this.botIds]]);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const directory = lstatSync(stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
      throw new Error("stateDir 必须为当前用户拥有的私有目录（0700）；不会修改已有目录权限");
    }
    if (!LOCAL_FILESYSTEMS.has(Number(statfsSync(stateDir).type) >>> 0)) throw new Error("状态库拒绝网络或无法确认的文件系统");
    const path = join(stateDir, "observers.sqlite3");
    let created = false;
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      closeSync(fd);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    regularPrivateFile(path, true);
    for (const suffix of ["-journal", "-wal", "-shm"]) {
      try { regularPrivateFile(`${path}${suffix}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.db = new Database(path, { create: false, readwrite: true, strict: true });
    try {
      this.db.run("PRAGMA busy_timeout = 0");
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version !== 0 && version !== 1) throw new Error(`不支持的观察数据库 schema version ${version}`);
      if (version === 0 && !created) throw new Error("已有观察数据库缺少 schema version；拒绝重建基线");
      if (version === 0 && this.db.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error("拒绝无 schema version 的已有数据库");
      this.db.run("PRAGMA trusted_schema = OFF");
      this.db.run("PRAGMA foreign_keys = ON");
      const journal = this.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode = DELETE").get()!.journal_mode;
      this.db.run("PRAGMA synchronous = EXTRA");
      const synchronous = this.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()!.synchronous;
      if (journal.toLowerCase() !== "delete" || synchronous !== 3) throw new Error("SQLite 无法保证 DELETE journal / synchronous=EXTRA");
      const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      const maxPages = Math.floor(LIMITS.databaseBytes / pageSize);
      const actualMax = this.db.query<{ max_page_count: number }, []>(`PRAGMA max_page_count = ${maxPages}`).get()!.max_page_count;
      if (actualMax > maxPages) fail("ObservationCapacityError", "状态库 capacity 超过主库页数上限");
      const check = this.db.query<{ quick_check: string }, []>("PRAGMA quick_check").all();
      if (check.length !== 1 || check[0]?.quick_check !== "ok") throw new Error("观察数据库损坏，拒绝写入");
      this.transaction(() => {
        if (version === 0) {
          this.db.run(`CREATE TABLE scopes (scope TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision >= 0)) WITHOUT ROWID`);
          this.db.run(`CREATE TABLE cursors (scope TEXT NOT NULL REFERENCES scopes(scope), bot_id TEXT NOT NULL, cursor INTEGER NOT NULL CHECK(cursor >= 0), PRIMARY KEY(scope, bot_id)) WITHOUT ROWID`);
          this.db.run(`CREATE TABLE unread (scope TEXT NOT NULL REFERENCES scopes(scope), bot_id TEXT NOT NULL, message_id TEXT NOT NULL, metadata TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes > 0), PRIMARY KEY(scope, bot_id, message_id))`);
          this.db.run("PRAGMA user_version = 1");
        }
        if (!this.db.query<{ revision: number }, [string]>("SELECT revision FROM scopes WHERE scope = ?").get(this.scope)) {
          const count = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM scopes").get()!.count;
          if (count >= LIMITS.scopes) fail("ObservationCapacityError", "观察范围 capacity 已达 128，不会淘汰旧状态");
          this.db.query("INSERT INTO scopes(scope, revision) VALUES (?, 0)").run(this.scope);
        }
        this.readState();
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  snapshot(): ObservationState {
    return this.transaction(() => this.readState(), "DEFERRED");
  }

  commitPage(botId: string, expectedRevision: number, after: number | undefined, cursor: number, requests: RequestMetadata[]): ObservationState {
    if (!this.botIds.has(botId) || !safeInteger(expectedRevision) || !safeInteger(cursor) ||
        (after !== undefined && (!safeInteger(after) || cursor < after)) ||
        (after === undefined && requests.length !== 0) || (after === cursor && requests.length !== 0)) throw new Error("非法 Bot、baseline 或 page cursor");
    if (requests.length > LIMITS.unreadCount) fail("ObservationCapacityError", "单页请求 metadata 数量超过 capacity 上限，观察已暂停");
    const rows = requests.map((request) => {
      if (request.botId !== botId) throw new Error("请求元数据 Bot 与 page 不一致");
      return normalizeMetadata(request, this.botIds);
    });
    return this.transaction(() => {
      this.expectRevision(expectedRevision);
      const current = this.db.query<{ cursor: number }, [string, string]>("SELECT cursor FROM cursors WHERE scope = ? AND bot_id = ?").get(this.scope, botId)?.cursor;
      if (current !== after) fail("ObservationConflictError", "观察 cursor 已被其他窗口修改，请重新加载");
      const insert = this.db.query("INSERT OR IGNORE INTO unread(scope, bot_id, message_id, metadata, bytes) VALUES (?, ?, ?, ?, ?)");
      for (const row of rows) insert.run(this.scope, botId, row.value.messageId, row.json, row.bytes);
      this.assertCapacity();
      this.db.query("INSERT INTO cursors(scope, bot_id, cursor) VALUES (?, ?, ?) ON CONFLICT(scope, bot_id) DO UPDATE SET cursor = excluded.cursor").run(this.scope, botId, cursor);
      this.bumpRevision(expectedRevision);
      return this.readState();
    });
  }

  acknowledge(keys: RequestKey[], expectedRevision: number): ObservationState {
    if (!safeInteger(expectedRevision) || keys.some((key) => !key || !this.botIds.has(key.botId) || typeof key.messageId !== "string" || !key.messageId)) throw new Error("非法查看确认 ID 或 revision");
    return this.transaction(() => {
      this.expectRevision(expectedRevision);
      const remove = this.db.query("DELETE FROM unread WHERE scope = ? AND bot_id = ? AND message_id = ?");
      for (const key of keys) remove.run(this.scope, key.botId, key.messageId);
      this.bumpRevision(expectedRevision);
      return this.readState();
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private expectRevision(expected: number): void {
    const row = this.db.query<{ revision: number }, [string]>("SELECT revision FROM scopes WHERE scope = ?").get(this.scope);
    if (!row || row.revision !== expected) fail("ObservationConflictError", "观察 revision 已被其他窗口修改，请重新加载");
  }
  private bumpRevision(expected: number): void {
    if (expected >= Number.MAX_SAFE_INTEGER) fail("ObservationCapacityError", "观察 revision 已达到安全整数上限");
    this.db.query("UPDATE scopes SET revision = revision + 1 WHERE scope = ?").run(this.scope);
  }
  private assertCapacity(): void {
    const size = this.db.query<{ count: number; bytes: number }, [string]>("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM unread WHERE scope = ?").get(this.scope)!;
    if (size.count > LIMITS.unreadCount || size.bytes > LIMITS.unreadBytes) fail("ObservationCapacityError", "未查看请求 capacity 已满，观察已暂停；查看后可继续");
  }
  private readState(): ObservationState {
    this.assertCapacity();
    const revision = this.db.query<{ revision: number }, [string]>("SELECT revision FROM scopes WHERE scope = ?").get(this.scope)?.revision;
    if (revision === undefined || !safeInteger(revision)) throw new Error("观察数据库 revision 损坏");
    const cursors: Record<string, number> = Object.create(null);
    for (const row of this.db.query<{ bot_id: string; cursor: number }, [string]>("SELECT bot_id, cursor FROM cursors WHERE scope = ?").all(this.scope)) {
      if (!this.botIds.has(row.bot_id) || !safeInteger(row.cursor)) throw new Error("观察数据库 cursor 损坏");
      cursors[row.bot_id] = row.cursor;
    }
    const unread: RequestMetadata[] = [];
    // Local insertion order, not opaque message IDs or remote clocks, defines the latest observed source.
    const rows = this.db.query<{ bot_id: string; message_id: string; metadata: string; bytes: number }, [string, number]>("SELECT bot_id, message_id, metadata, bytes FROM unread WHERE scope = ? ORDER BY rowid LIMIT ?").all(this.scope, LIMITS.unreadCount + 1);
    for (const row of rows) {
      if (row.bytes > LIMITS.metadataBytes || Buffer.byteLength(row.metadata) !== row.bytes) throw new Error("观察数据库 metadata 损坏");
      const item = normalizeMetadata(JSON.parse(row.metadata) as RequestMetadata, this.botIds).value;
      if (item.botId !== row.bot_id || item.messageId !== row.message_id) throw new Error("观察数据库请求 ID 损坏");
      unread.push(item);
    }
    return { revision, cursors, unread };
  }
  private transaction<T>(body: () => T, mode: "IMMEDIATE" | "DEFERRED" = "IMMEDIATE"): T {
    if (this.closed) throw new Error("观察数据库已关闭");
    this.db.run(`BEGIN ${mode}`);
    try {
      const value = body();
      this.db.run("COMMIT");
      return value;
    } catch (error) {
      // SQLITE_FULL and I/O errors can cause SQLite to roll back the transaction itself.
      if (this.db.inTransaction) this.db.run("ROLLBACK");
      throw error;
    }
  }
}
