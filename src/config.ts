import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "./types.ts";

export const BOT_ID = /^n1-[a-f0-9]{32}$/;

export function isWithin(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === "" || (!part.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && part !== ".." && !isAbsolute(part));
}

/** Resolve existing ancestors too, so nonexistent leaf directories cannot hide symlink aliases. */
export async function canonicalPath(value: string): Promise<string> {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(expanded)) throw new Error("目录与 tokenFile 必须是绝对路径或 ~/ 路径");
  const absolute = resolve(expanded);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent), relative(parent, absolute));
  }
}

export function normalizeEndpoint(value: string): string {
  if (!/^https?:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?\/?$/.test(value)) {
    throw new Error("endpoint 仅允许明确的 HTTP(S) loopback 地址，不允许主机名、路径或凭据");
  }
  const url = new URL(value);
  if (!(url.hostname.startsWith("127.") || url.hostname === "[::1]")) throw new Error("endpoint 不是 loopback 地址");
  return url.origin;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readJSON(file: string, limit: number): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`${file} 必须是至多 ${limit} 字节的常规文件`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      length += bytesRead;
      if (length > limit) throw new Error(`${file} 超过 ${limit} 字节`);
      if (bytesRead === 0) break;
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
    catch { throw new Error(`${file} 不是合法 JSON`); }
  } finally { await handle.close(); }
}

/** The registered catalog is authoritative; unknown Bot directories never select identities. */
export async function discoverBotIds(dataDir: string): Promise<string[]> {
  if (!isAbsolute(dataDir)) throw new Error("DataDir 必须是绝对路径");
  try {
    const stat = await lstat(dataDir);
    if (!stat.isDirectory() || await realpath(dataDir) !== resolve(dataDir)) throw new Error("DataDir 必须是无符号链接的常规目录");
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  let raw: unknown;
  try { raw = await readJSON(join(dataDir, "bots.json"), 1024 * 1024); }
  catch (error) {
    if (!isMissing(error)) throw error;
    const botsDir = join(dataDir, "bots");
    try {
      if (!(await lstat(botsDir)).isDirectory()) throw new Error("bots 必须是无符号链接的常规目录");
      const entries = await opendir(botsDir);
      try {
        if (await entries.read()) throw new Error("Bot catalog 缺失但 Bot 数据仍存在；请恢复 bots.json");
      } finally { await entries.close(); }
    } catch (inspectionError) {
      if (!isMissing(inspectionError)) throw inspectionError;
    }
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Bot catalog 必须是 JSON 对象");
  const catalog = raw as Record<string, unknown>;
  if (catalog.schemaVersion !== 3 || !Array.isArray(catalog.bots) || catalog.bots.length > 1000 ||
      Object.keys(catalog).some(key => key !== "schemaVersion" && key !== "bots")) throw new Error("Bot catalog schema 或数量非法");
  const ids = new Set<string>();
  const workspaces = new Set<string>();
  for (const rawBot of catalog.bots) {
    if (!rawBot || typeof rawBot !== "object" || Array.isArray(rawBot)) throw new Error("Bot catalog 注册项非法");
    const bot = rawBot as Record<string, unknown>;
    if (Object.keys(bot).some(key => !["botId", "desiredState", "archived", "workspaceId"].includes(key)) ||
        typeof bot.botId !== "string" || !BOT_ID.test(bot.botId) || ids.has(bot.botId) ||
        (bot.desiredState !== "running" && bot.desiredState !== "stopped") || typeof bot.archived !== "boolean" ||
        (bot.archived && bot.desiredState !== "stopped")) throw new Error("Bot catalog 注册项非法或 Bot ID 重复");
    if (bot.workspaceId !== undefined) {
      if (typeof bot.workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(bot.workspaceId) || workspaces.has(bot.workspaceId)) {
        throw new Error("Bot catalog workspaceId 非法或重复");
      }
      workspaces.add(bot.workspaceId);
    }
    ids.add(bot.botId);
  }
  return [...ids].sort();
}

async function readConfig(file: string): Promise<unknown> {
  try {
    if (!(await lstat(dirname(file))).isDirectory()) throw new Error("插件配置目录必须是无符号链接的常规目录");
    return await readJSON(file, 64 * 1024);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function loadConfig(cwd: string): Promise<Config> {
  const file = join(cwd, ".omp", "clawsynapse.json");
  const userFile = join(homedir(), ".omp", "clawsynapse.json");
  const project = await readConfig(file);
  const raw = project === undefined ? (file === userFile ? {} : await readConfig(userFile) ?? {}) : project;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("插件配置必须是 JSON 对象");
  const input = raw as Record<string, unknown>;
  const allowed: Record<string, true> = { endpoint: true, dataDir: true, stateDir: true, botIds: true, pollIntervalMs: true, tokenFiles: true };
  if (Object.keys(input).some(key => !Object.hasOwn(allowed, key))) throw new Error("插件配置包含不支持的字段");
  if (input.endpoint !== undefined && typeof input.endpoint !== "string") throw new Error("endpoint 必须是 loopback URL");
  const autoDiscoverBots = input.botIds === undefined;
  if (!autoDiscoverBots && (!Array.isArray(input.botIds) || !input.botIds.length || !input.botIds.every(id => typeof id === "string" && BOT_ID.test(id)))) {
    throw new Error("botIds 必须显式列出完整本地 Bot ID（n1- 加 32 位小写十六进制）");
  }
  const pollIntervalMs = input.pollIntervalMs ?? 1000;
  if (typeof pollIntervalMs !== "number" || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 2147483647) {
    throw new Error("pollIntervalMs 必须是有效的正整数毫秒数");
  }
  for (const key of ["dataDir", "stateDir"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new Error(`${key} 必须是目录路径`);
  }
  const dataDir = await canonicalPath(typeof input.dataDir === "string" ? input.dataDir : "~/.clawsynapse");
  const stateDir = await canonicalPath(typeof input.stateDir === "string" ? input.stateDir : "~/.omp/clawsynapse");
  if (isWithin(dataDir, stateDir) || isWithin(stateDir, dataDir)) throw new Error("stateDir 与 DataDir 必须互不包含");
  if (dirname(stateDir) === stateDir || stateDir === await canonicalPath(homedir())) throw new Error("stateDir 必须是插件专用目录，不能使用根目录或 HOME");
  const botIds = autoDiscoverBots ? await discoverBotIds(dataDir) : [...new Set(input.botIds as string[])].sort();
  const tokenFiles: Record<string, string> = Object.create(null);
  if (input.tokenFiles !== undefined) {
    if (!input.tokenFiles || typeof input.tokenFiles !== "object" || Array.isArray(input.tokenFiles)) throw new Error("tokenFiles 必须是按完整 Bot ID 索引的路径对象");
    for (const [botId, path] of Object.entries(input.tokenFiles)) {
      if (!BOT_ID.test(botId) || (!autoDiscoverBots && !botIds.includes(botId)) || typeof path !== "string") throw new Error("tokenFiles 只能配置所选 Bot 的有效完整 Bot ID 与 token 文件路径");
      tokenFiles[botId] = await canonicalPath(path);
    }
  }
  return { endpoint: normalizeEndpoint(input.endpoint ?? "http://127.0.0.1:18080"), dataDir, stateDir, botIds, pollIntervalMs, tokenFiles, ...(autoDiscoverBots ? { autoDiscoverBots: true } : {}) };
}
