import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
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

export async function loadConfig(cwd: string): Promise<Config> {
  let file = join(cwd, ".omp", "clawsynapse.json");
  const userFile = join(homedir(), ".omp", "clawsynapse.json");
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle: FileHandle;
  try { handle = await open(file, flags); }
  catch (error) {
    // Only an absent project config permits fallback; broken or unsafe overrides must remain visible.
    if (file === userFile || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    file = userFile;
    handle = await open(file, flags);
  }
  let raw: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("插件配置必须是小于 64 KiB 的常规文件");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new Error("插件配置超过 64 KiB");
    try { raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error(`${file} 不是合法 JSON`); }
  } finally { await handle.close(); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("插件配置必须是 JSON 对象");
  const input = raw as Record<string, unknown>;
  const allowed: Record<string, true> = { endpoint: true, dataDir: true, stateDir: true, botIds: true, pollIntervalMs: true, tokenFiles: true };
  if (Object.keys(input).some(key => !Object.hasOwn(allowed, key))) throw new Error("插件配置包含不支持的字段");
  if (typeof input.endpoint !== "string") throw new Error("必须显式配置 endpoint");
  if (!Array.isArray(input.botIds) || !input.botIds.length || !input.botIds.every(id => typeof id === "string" && BOT_ID.test(id))) {
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
  const stateDir = await canonicalPath(typeof input.stateDir === "string" ? input.stateDir : "~/.clawsynapse-omp");
  if (isWithin(dataDir, stateDir) || isWithin(stateDir, dataDir)) throw new Error("stateDir 与 DataDir 必须互不包含");
  if (dirname(stateDir) === stateDir || stateDir === await canonicalPath(homedir())) throw new Error("stateDir 必须是插件专用目录，不能使用根目录或 HOME");
  const botIds = [...new Set<string>(input.botIds)].sort();
  const tokenFiles: Record<string, string> = Object.create(null);
  if (input.tokenFiles !== undefined) {
    if (!input.tokenFiles || typeof input.tokenFiles !== "object" || Array.isArray(input.tokenFiles)) throw new Error("tokenFiles 必须是按完整 Bot ID 索引的路径对象");
    for (const [botId, path] of Object.entries(input.tokenFiles)) {
      if (!botIds.includes(botId) || typeof path !== "string") throw new Error("tokenFiles 只能配置所选 Bot 的 token 文件路径");
      tokenFiles[botId] = await canonicalPath(path);
    }
  }
  return { endpoint: normalizeEndpoint(input.endpoint), dataDir, stateDir, botIds, pollIntervalMs, tokenFiles };
}
