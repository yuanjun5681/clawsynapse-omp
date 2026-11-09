import { Database } from "bun:sqlite";
import { ObserverStore } from "../../src/state.ts";
import type { Config } from "../../src/types.ts";

const config: Config = JSON.parse(process.argv[2]!);
const boundary = process.argv[3];
const store = new ObserverStore(config, "crash-observer");
const run = Database.prototype.run;
Database.prototype.run = function(this: Database, ...args: Parameters<Database["run"]>) {
  if (args[0] !== "COMMIT") return run.apply(this, args);
  if (boundary === "before") {
    process.send?.("before");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  const result = run.apply(this, args);
  process.send?.("after");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  return result;
};
store.commitPage("bot-a", 1, 0, 1, [{ botId: "bot-a", messageId: "new-request", from: "sender", type: "chat.message", timestamp: 1 }]);
