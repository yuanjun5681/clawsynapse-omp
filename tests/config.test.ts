import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverBotIds, loadConfig, normalizeEndpoint } from "../src/config.ts";
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

test("no configuration discovers only the default local catalog, including stopped and archived Bots", async () => {
  const home = await realpath(await fixture());
  await rm(join(home, ".omp", "clawsynapse.json"));
  const cwd = join(home, "workspace");
  const dataDir = join(home, ".clawsynapse");
  const other = `n1-${"b".repeat(32)}`;
  await mkdir(cwd);
  await mkdir(join(dataDir, "bots", `n1-${"c".repeat(32)}`), { recursive: true });
  await writeFile(join(dataDir, "bots.json"), JSON.stringify({
    schemaVersion: 3,
    bots: [
      { botId: other, desiredState: "stopped", archived: true, workspaceId: "workspace-1" },
      { botId: bot, desiredState: "running", archived: false },
    ],
  }));
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(0);
  expect(result.config).toEqual({
    endpoint: "http://127.0.0.1:18080", dataDir, stateDir: join(home, ".omp", "clawsynapse"),
    botIds: [bot, other], autoDiscoverBots: true, pollIntervalMs: 1000, tokenFiles: {},
  });
});

test("an empty install works without creating daemon data or configuration", async () => {
  const home = await realpath(await fixture());
  await rm(join(home, ".omp"), { recursive: true });
  const cwd = join(home, "workspace");
  await mkdir(cwd);
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(0);
  expect(result.config?.botIds).toEqual([]);
  expect(result.config?.autoDiscoverBots).toBe(true);
  await expect(discoverBotIds(join(home, ".clawsynapse"))).resolves.toEqual([]);
  await expect(lstat(join(home, ".clawsynapse"))).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(join(home, ".clawsynapse", "bots"), { recursive: true });
  await expect(discoverBotIds(join(home, ".clawsynapse"))).resolves.toEqual([]);
});

test("an empty project object replaces user selection with default local discovery", async () => {
  const home = await realpath(await fixture({ tokenFiles: { [bot]: "~/private-token" } }));
  const cwd = await fixture();
  await writeFile(join(cwd, ".omp", "clawsynapse.json"), "{}");
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(0);
  expect(result.config).toEqual({
    endpoint: "http://127.0.0.1:18080", dataDir: join(home, ".clawsynapse"),
    stateDir: join(home, ".omp", "clawsynapse"), botIds: [], autoDiscoverBots: true,
    pollIntervalMs: 1000, tokenFiles: {},
  });
});

test("explicit selection remains independent of catalog discovery and accepts an omitted endpoint", async () => {
  const root = await fixture();
  await writeFile(join(root, ".omp", "clawsynapse.json"), JSON.stringify({ botIds: [bot], dataDir: join(root, "data"), stateDir: join(root, "state") }));
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "bots.json"), "{invalid");
  const config = await loadConfig(root);
  expect(config.endpoint).toBe("http://127.0.0.1:18080");
  expect(config.botIds).toEqual([bot]);
  expect(config).not.toHaveProperty("autoDiscoverBots");
  for (const botIds of [[], null, "auto", ["../other-bot"], [42]]) {
    const invalid = await fixture({ botIds });
    await expect(loadConfig(invalid)).rejects.toThrow();
  }
});

test("automatic token overrides validate IDs without selecting inventory or reading token contents", async () => {
  const root = await realpath(await fixture());
  const token = join(root, "token-never-created");
  await writeFile(join(root, ".omp", "clawsynapse.json"), JSON.stringify({
    dataDir: join(root, "data"), stateDir: join(root, "state"), tokenFiles: { [bot]: token },
  }));
  const config = await loadConfig(root);
  expect(config.botIds).toEqual([]);
  expect(config.autoDiscoverBots).toBe(true);
  expect(config.tokenFiles).toEqual({ [bot]: token });
  await writeFile(join(root, ".omp", "clawsynapse.json"), JSON.stringify({ tokenFiles: { "../outside": token } }));
  await expect(loadConfig(root)).rejects.toThrow();
});

test("catalog discovery observes replacements and ignores unregistered folders", async () => {
  const root = await realpath(await fixture());
  const dataDir = join(root, "data");
  const other = `n1-${"b".repeat(32)}`;
  await mkdir(join(dataDir, "bots", other), { recursive: true });
  for (const ids of [[bot], [other, bot], [other], []]) {
    await writeFile(join(dataDir, "bots.json"), JSON.stringify({
      schemaVersion: 3, bots: ids.map(botId => ({ botId, desiredState: "stopped", archived: false })),
    }));
    await expect(discoverBotIds(dataDir)).resolves.toEqual([...ids].sort());
  }
});

test("catalog discovery rejects malformed schemas, duplicate identities and unsafe paths", async () => {
  const root = await realpath(await fixture());
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const record = { botId: bot, desiredState: "stopped", archived: false };
  const invalid = [
    "{invalid", "null", "[]",
    JSON.stringify({ schemaVersion: 2, bots: [] }),
    JSON.stringify({ schemaVersion: 3, bots: null }),
    JSON.stringify({ schemaVersion: 3, bots: [], unknown: true }),
    ...[
      [record, record],
      [{ ...record, botId: "../outside" }],
      [{ ...record, desiredState: "unknown" }],
      [{ ...record, archived: "false" }],
      [{ ...record, archived: true, desiredState: "running" }],
      [{ ...record, workspaceId: "../../outside" }],
      [{ ...record, workspaceId: "same" }, { ...record, botId: `n1-${"b".repeat(32)}`, workspaceId: "same" }],
      [{ ...record, credentials: "/private/key" }],
    ].map(bots => JSON.stringify({ schemaVersion: 3, bots })),
  ];
  for (const value of invalid) {
    await writeFile(join(dataDir, "bots.json"), value);
    await expect(discoverBotIds(dataDir)).rejects.toThrow();
  }
});

test("catalog discovery enforces byte and identity limits", async () => {
  const root = await realpath(await fixture());
  const dataDir = join(root, "data");
  await mkdir(dataDir);
  const bots = Array.from({ length: 1001 }, (_, index) => ({
    botId: `n1-${index.toString(16).padStart(32, "0")}`, desiredState: "stopped", archived: false,
  }));
  await writeFile(join(dataDir, "bots.json"), JSON.stringify({ schemaVersion: 3, bots }));
  await expect(discoverBotIds(dataDir)).rejects.toThrow();
  await writeFile(join(dataDir, "bots.json"), `{"schemaVersion":3,"bots":[]} ${" ".repeat(1024 * 1024)}`);
  await expect(discoverBotIds(dataDir)).rejects.toThrow();
});

test("missing catalogs with existing data and symlinked catalog paths fail closed", async () => {
  const root = await realpath(await fixture());
  const dataDir = join(root, "data");
  await mkdir(join(dataDir, "bots", "unknown"), { recursive: true });
  await expect(discoverBotIds(dataDir)).rejects.toThrow();
  const target = join(root, "catalog.json");
  await writeFile(target, JSON.stringify({ schemaVersion: 3, bots: [] }));
  await symlink(target, join(dataDir, "bots.json"));
  await expect(discoverBotIds(dataDir)).rejects.toThrow();
  await rm(join(dataDir, "bots.json"));
  await rm(join(dataDir, "bots"), { recursive: true });
  await mkdir(join(root, "empty-bots"));
  await symlink(join(root, "empty-bots"), join(dataDir, "bots"));
  await expect(discoverBotIds(dataDir)).rejects.toThrow();
  await symlink(dataDir, join(root, "data-alias"));
  await expect(discoverBotIds(join(root, "data-alias"))).rejects.toThrow();
});

test.skipIf(process.getuid?.() === 0)("an unreadable project override never falls back to a valid user configuration", async () => {
  const home = await fixture();
  const cwd = await fixture();
  const file = join(cwd, ".omp", "clawsynapse.json");
  await chmod(file, 0);
  try {
    const result = await isolatedConfig(cwd, home);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("EACCES");
  } finally { await chmod(file, 0o600); }
});

test("a symlinked project configuration directory never falls back", async () => {
  const home = await fixture();
  const cwd = await fixture();
  await rm(join(cwd, ".omp"), { recursive: true });
  await symlink(join(cwd, "missing-directory"), join(cwd, ".omp"));
  const result = await isolatedConfig(cwd, home);
  expect(result.exitCode).toBe(1);
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
