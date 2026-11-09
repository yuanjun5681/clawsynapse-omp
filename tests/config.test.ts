import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, normalizeEndpoint } from "../src/config.ts";
import { safeText } from "../src/safety.ts";
import type { Config } from "../src/types.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const bot = `n1-${"a".repeat(32)}`;
async function fixture(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "cs-config-")); roots.push(root);
  await mkdir(join(root, ".omp"));
  await writeFile(join(root, ".omp/clawsynapse.json"), JSON.stringify({ endpoint: "http://127.0.0.1:18080/", botIds: [bot, bot], dataDir: join(root, "data"), stateDir: join(root, "state"), ...extra }));
  return root;
}

// A fresh process isolates HOME without mutating the environment of concurrent test files.
async function isolatedConfig(cwd: string, home: string): Promise<{ exitCode: number; config?: Config; error?: { code?: string; message: string } }> {
  const program = `
    import { loadConfig } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    try { console.log(JSON.stringify({ config: await loadConfig(process.argv[1]) })); }
    catch (error) { console.log(JSON.stringify({ error: { code: error.code, message: error.message } })); process.exitCode = 1; }
  `;
  const child = Bun.spawn([process.execPath, "--eval", program, cwd], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try { return { exitCode, ...JSON.parse(stdout) }; }
  catch { throw new Error(`Configuration probe exited ${exitCode}: ${stderr || stdout}`); }
}

test("user configuration works from unrelated workspaces and resolves home-relative paths independently of cwd", async () => {
  const home = await realpath(await fixture({ dataDir: "~/daemon", stateDir: "~/observer" }));
  for (const name of ["workspace-a", "workspace-b"]) {
    const cwd = join(home, name);
    await mkdir(cwd);
    const result = await isolatedConfig(cwd, home);
    expect(result.exitCode).toBe(0);
    expect(result.config).toEqual({
      endpoint: "http://127.0.0.1:18080", botIds: [bot],
      dataDir: join(home, "daemon"), stateDir: join(home, "observer"), pollIntervalMs: 1000, tokenFiles: {},
    });
  }
});

test("a project overrides the entire user configuration without inheriting another Bot or token", async () => {
  const home = await fixture({ tokenFiles: { [bot]: "~/private-token" } });
  const other = `n1-${"b".repeat(32)}`;
  const cwd = await realpath(await fixture({ endpoint: "http://[::1]:19090", botIds: [other] }));
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(0);
  expect(result.config).toEqual({
    endpoint: "http://[::1]:19090", botIds: [other], dataDir: join(cwd, "data"),
    stateDir: join(cwd, "state"), pollIntervalMs: 1000, tokenFiles: {},
  });
});

test("malformed and symlinked project overrides fail instead of silently selecting the user identity", async () => {
  const home = await fixture();
  const cwd = await realpath(await fixture());
  const file = join(cwd, ".omp", "clawsynapse.json");
  await writeFile(file, "{invalid");
  const malformed = await isolatedConfig(cwd, home);
  expect(malformed.exitCode).toBe(1);
  expect(malformed.error?.message).toContain(file);
  await rm(file);
  await symlink(join(cwd, "missing.json"), file);
  const linked = await isolatedConfig(cwd, home);
  expect(linked.exitCode).toBe(1);
  expect(linked.error?.code).toBe("ELOOP");
});

test("missing project and user configuration reports the user-level path", async () => {
  const home = await realpath(await fixture());
  const file = join(home, ".omp", "clawsynapse.json");
  await rm(file);
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(1);
  expect(result.error?.code).toBe("ENOENT");
  expect(result.error?.message).toContain(file);
});

test("literal loopback is canonicalized but remote, proxy-friendly names and credentials are refused", () => {
  expect(normalizeEndpoint("http://127.0.0.1:18080/")).toBe("http://127.0.0.1:18080");
  expect(normalizeEndpoint("http://[::1]:18080")).toBe("http://[::1]:18080");
  for (const url of ["http://localhost:18080", "http://127.0.0.1.evil", "http://2130706433", "http://127.0.0.1/path", "http://user@127.0.0.1", "http://192.168.0.1"]) {
    expect(() => normalizeEndpoint(url)).toThrow();
  }
});

test("scope paths resolve symlink aliases and do not allow state within daemon data", async () => {
  const root = await fixture();
  await mkdir(join(root, "data"));
  await symlink(join(root, "data"), join(root, "alias"));
  await writeFile(join(root, ".omp/clawsynapse.json"), JSON.stringify({ endpoint: "http://127.0.0.1:18080", botIds: [bot], dataDir: join(root, "data"), stateDir: join(root, "alias/state") }));
  await expect(loadConfig(root)).rejects.toThrow("互不包含");
});

test("selected identities are explicit and token paths cannot silently choose another Bot", async () => {
  const root = await fixture({ tokenFiles: { [`n1-${"b".repeat(32)}`]: "/tmp/token" } });
  await expect(loadConfig(root)).rejects.toThrow("所选 Bot");
  const invalid = await fixture({ botIds: ["../other-bot"] });
  await expect(loadConfig(invalid)).rejects.toThrow("完整本地 Bot ID");
});

test("normalization gives stable Bot scope without losing selected identities", async () => {
  const root = await fixture();
  const config = await loadConfig(root);
  expect(config.botIds).toEqual([bot]);
  expect(config.endpoint).toBe("http://127.0.0.1:18080");
});

test("untrusted terminal control protocols become visible text on all render paths", () => {
  const raw = "title\u001b]52;c;secret\u0007\u009b2J\u001bPpayload\u001b\\\n\ttext\u202e";
  const escaped = safeText(raw);
  expect(escaped).toBe("title\\u001b]52;c;secret\\u0007\\u009b2J\\u001bPpayload\\u001b\\\n\ttext\\u202e");
  expect(safeText("a\nb\tc", true)).toBe("a\\u000ab\\u0009c");
  expect(safeText("first\rspoof")).toBe("first\\u000dspoof");
});
