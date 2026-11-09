import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ObserverStore } from "../src/state.ts";
import type { Config } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const boundary of ["before", "after"]) {
  test(`SIGKILL ${boundary} COMMIT restores one complete observation, never a new cursor with missing request`, async () => {
    const root = mkdtempSync(join(tmpdir(), "cs-crash-")); roots.push(root);
    mkdirSync(join(root, "data"), { mode: 0o700 });
    const config: Config = { endpoint: "http://127.0.0.1:18080", dataDir: join(root, "data"), stateDir: join(root, "state"), botIds: ["bot-a"], pollIntervalMs: 1000, tokenFiles: {} };
    const initial = new ObserverStore(config, "crash-observer");
    initial.commitPage("bot-a", 0, undefined, 0, []); initial.close();
    const gate = Promise.withResolvers<void>();
    const writer = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/crash-writer.ts", import.meta.url)), JSON.stringify(config), boundary], {
      stdout: "ignore", stderr: "pipe",
      ipc(message) { if (message === boundary) gate.resolve(); },
    });
    try {
      await Promise.race([gate.promise, writer.exited.then(async code => { throw new Error(`Writer exited before crash boundary (${code}): ${await new Response(writer.stderr).text()}`); })]);
      writer.kill("SIGKILL"); await writer.exited;
      const recovered = new ObserverStore(config, "crash-observer");
      try {
        expect(recovered.snapshot()).toEqual(boundary === "before"
          ? { revision: 1, cursors: { "bot-a": 0 }, unread: [] }
          : { revision: 2, cursors: { "bot-a": 1 }, unread: [{ botId: "bot-a", messageId: "new-request", from: "sender", type: "chat.message", timestamp: 1 }] });
      } finally { recovered.close(); }
    } finally { if (writer.exitCode === null) writer.kill("SIGKILL"); await writer.exited; }
  }, 10000);
}
