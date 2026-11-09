import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryReader, type SessionSummary } from "../src/history.ts";
import { LIMITS, type RequestMetadata } from "../src/types.ts";

// Every fixture below is synthetic; these are not captured adapter histories.
const BOT = "n1-synthetic";
const ID = "019700f1-1a2b-7c3d-8e4f-aabbccddeeff";
const SECOND = "019700f1-1a2b-7c3d-8e4f-aabbccddee00";
const TIME = "2026-05-14T10:12:03.000Z";
let root: string;
let data: string;
let dir: string;
let path: string;
let reader: HistoryReader;

function header(id = ID, extra: Record<string, unknown> = {}) {
  return { type: "session", version: 3, id, timestamp: TIME, cwd: "/untrusted/cwd", title: "header title", ...extra };
}
function entry(id: string, parentId: string | null, type: string, extra: Record<string, unknown> = {}) {
  return { type, id, parentId, timestamp: TIME, ...extra };
}
function message(id: string, parentId: string | null, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return entry(id, parentId, "message", { message: { role, content, timestamp: 1778753525000, ...extra } });
}
async function save(records: unknown[], target = path, tail = "") {
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, records.map(record => JSON.stringify(record)).join("\n") + "\n" + tail);
}
function summary(target = path, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { path: target, botId: BOT, bindingRevision: "BINDING", sessionId: ID, title: "", lastActivity: 0, historicalBinding: "unknown", ...extra };
}
function request(extra: Partial<RequestMetadata> = {}): RequestMetadata {
  return { botId: BOT, messageId: "message-1", from: "n1-remote", timestamp: 1778753525000, type: "chat.message", ...extra };
}
function source(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ source: "clawsynapse", botId: BOT, messageId: "message-1", from: "n1-remote", runId: "run-a", sessionKey: "shared", ...extra });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "clawsynapse-history-synthetic-")));
  data = join(root, "data");
  dir = join(data, "bots", BOT, "workspace", "BINDING", ".clawsynapse", "omp-sessions");
  path = join(dir, `2026-05-14T10-12-03_${ID}.jsonl`);
  await mkdir(dir, { recursive: true });
  // Persisted daemon BotConfig is ordinary JSON, not JSONL, and may be pretty-printed.
  await writeFile(join(data, "bots", BOT, "config.json"), JSON.stringify({ role: "agent", bindingRevision: "BINDING" }, null, 2));
  reader = new HistoryReader({ dataDir: data, botIds: [BOT] });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("discovery, headers and title rewrites", () => {
  test("recognizes title v1 before the header without treating title.source as a request", async () => {
    await save([{ type: "title", v: 1, title: "physical title", source: "clawsynapse" }, header(), message("a", null, "user", "hello")]);
    const result = await reader.listSessions();
    expect(result.warnings).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.title).toBe("physical title");
    expect(result.sessions[0]!.historicalBinding).toBe("current");
    expect(await reader.findRequest(request())).toEqual([]);
  });

  test("blank native titles use the first user request body and creation time without modifying history", async () => {
    await save([{ type: "title", v: 1, title: "" }, header(ID, { title: "" }),
      message("assistant", null, "assistant", [{ type: "text", text: "not the request" }]),
      message("u", "assistant", "user", [{ type: "text", text: source({ payload: { text: "  汇总本周\n进度\t谢谢  " } }) }]),
      message("later", "u", "user", "not the first request")]);
    const original = await readFile(path, "utf8");
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title).toContain("汇总本周 进度 谢谢");
    expect(title).toContain("2026-05-14 10:12");
    expect(title).not.toContain("clawsynapse");
    expect(title).not.toContain("not the request");
    expect(title).not.toContain("not the first request");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  test("workspace topic titles use currentInstruction rather than execution instructions or shared history", async () => {
    const topic = { conversationId: "topic-1", history: [{ text: "HISTORICAL_ONLY", currentInstruction: "NESTED_NOT_CURRENT" }],
      currentInstruction: "请排查\"同步\"问题\n然后给出结论" };
    await save([{ type: "title", v: 1, title: "" }, header(ID, { title: "" }),
      message("u", null, "user", source({ payload: { text: `FIXTURE_EXECUTION_PREAMBLE\n${JSON.stringify(topic)}` } }))]);
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title).toContain("请排查\"同步\"问题 然后给出结论");
    expect(title).not.toContain("FIXTURE_EXECUTION_PREAMBLE");
    expect(title).not.toContain("HISTORICAL_ONLY");
    expect(title).not.toContain("NESTED_NOT_CURRENT");
  });

  test("workspace topic JSON without a preamble also extracts the current instruction", async () => {
    await save([header(ID, { title: "" }), message("u", null, "user", source({
      payload: { text: JSON.stringify({ conversationId: "topic-2", history: [], currentInstruction: "当前问题" }) },
    }))]);
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title).toContain("当前问题");
    expect(title).not.toContain("conversationId");
  });

  test("an empty workspace instruction never turns shared history or the preamble into a title", async () => {
    await save([header(ID, { title: "" }), message("u", null, "user", source({
      payload: { text: `EXECUTION_ONLY\n${JSON.stringify({ conversationId: "topic-3", history: [{ text: "HISTORY_ONLY" }], currentInstruction: " \n " })}` },
    }))]);
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title).toContain(ID.slice(-8));
    expect(title).not.toContain("EXECUTION_ONLY");
    expect(title).not.toContain("HISTORY_ONLY");
  });

  test("ordinary messages mentioning currentInstruction are not mistaken for workspace topics", async () => {
    await save([header(ID, { title: "" }), message("u", null, "user", source({
      payload: { text: "解释 currentInstruction 字段\n{\"currentInstruction\":\"这只是示例\"}" },
    }))]);
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title).toContain("解释 currentInstruction 字段");
    expect(title).not.toContain("这只是示例");
  });

  test("an empty physical title does not discard a real header title", async () => {
    await save([{ type: "title", v: 1, title: " \t" }, header(), message("u", null, "user", "must not replace the saved title")]);
    expect((await reader.listSessions()).sessions[0]!.title).toBe("header title");
  });

  test("missing titles summarize ordinary text blocks and skip blank user messages", async () => {
    await save([header(ID, { title: undefined }), message("blank", null, "user", " \n\t "),
      message("u", "blank", "user", [{ type: "text", text: "修复接口" }, { type: "text", text: "检查回归" }])]);
    expect((await reader.listSessions()).sessions[0]!.title).toContain("修复接口 检查回归");
  });

  test("task instructions produce bounded previews without cutting an emoji grapheme", async () => {
    const emoji = "👨‍👩‍👧‍👦";
    await save([{ type: "title", v: 1, title: "" }, header(ID, { title: undefined }),
      message("u", null, "user", source({ type: "task.assign", payload: { instruction: emoji.repeat(41) + "PRIVATE_LONG_TAIL" } }))]);
    const title = (await reader.listSessions()).sessions[0]!.title;
    expect(title.endsWith(`${emoji.repeat(40)}…`)).toBe(true);
    expect(title).not.toContain("PRIVATE_LONG_TAIL");
    expect(title).not.toContain("task.assign");
  });

  test("sessions without user text keep distinguishable time and ID labels instead of assistant content", async () => {
    await save([header(ID, { title: "" }), message("a", null, "assistant", [{ type: "text", text: "not a user request" }])]);
    await save([header(SECOND, { title: "" })], join(dir, `2026-05-14T10-12-03_${SECOND}.jsonl`));
    const sessions = (await reader.listSessions()).sessions;
    expect(sessions.find(session => session.sessionId === ID)!.title).toContain(ID.slice(-8));
    expect(sessions.find(session => session.sessionId === SECOND)!.title).toContain(SECOND.slice(-8));
    expect(sessions.every(session => session.title.includes("2026-05-14 10:12Z"))).toBe(true);
    expect(sessions.some(session => session.title.includes("not a user request"))).toBe(false);
  });

  test("ignores wire logs, backups, non-UUID main files and unselected Bots", async () => {
    await save([header(), message("a", null, "user", "included")]);
    await save([header()], join(dir, "agent.jsonl"));
    await save([header()], `${path}.bak`);
    await save([header()], join(data, "bots", BOT, "state", "messages.jsonl"));
    await save([header()], join(data, "bots", "n1-other", "workspace", "BINDING", ".clawsynapse", "omp-sessions", `time_${ID}.jsonl`));
    expect((await reader.listSessions()).sessions.map(session => session.path)).toEqual([path]);
  });

  test("validates header identity and reports unsupported header/title versions", async () => {
    await save([header(SECOND)]);
    expect((await reader.listSessions()).warnings.join(" ")).toContain("UUID");
    await expect(reader.readSession(summary())).rejects.toThrow("UUID");
    for (const version of [undefined, 1, 4]) {
      await save([header(ID, { version })]);
      await expect(reader.readSession(summary())).rejects.toThrow("不支持的历史版本");
    }
    await save([{ type: "title", v: 2, title: "future" }, header()]);
    await expect(reader.readSession(summary())).rejects.toThrow("title");
  });

  test("supports v2 tree entries and readable legacy hook messages", async () => {
    await save([header(ID, { version: 2 }), message("a", null, "hookMessage", "legacy extension message"), message("b", "a", "assistant", [{ type: "text", text: "answer" }])]);
    const transcript = await reader.readSession(summary());
    expect(transcript.blocks.map(block => [block.role, block.text])).toEqual([["system", "legacy extension message"], ["assistant", "answer"]]);
  });

  test("distinguishes current, historical and unknown bindings without daemon access", async () => {
    await save([header()]);
    const oldPath = join(data, "bots", BOT, "workspace", "OLD", ".clawsynapse", "omp-sessions", `time_${SECOND}.jsonl`);
    await save([header(SECOND)], oldPath);
    const listed = await reader.listSessions();
    expect(listed.sessions.find(session => session.path === oldPath)!.historicalBinding).toBe("historical");
    await rm(join(data, "bots", BOT, "config.json"));
    const unknown = await reader.listSessions();
    expect(unknown.sessions.every(session => session.historicalBinding === "unknown")).toBe(true);
    expect(unknown.warnings.join(" ")).toContain("无法确认当前绑定");
  });

  test("rereads same-size title edits, truncation and atomic replacements", async () => {
    await save([{ type: "title", v: 1, title: "old title" }, header(), message("a", null, "user", "old text")]);
    const old = await readFile(path, "utf8");
    const oldStatTime = new Date("2026-05-15T00:00:00Z");
    await utimes(path, oldStatTime, oldStatTime);
    expect((await reader.readSession(summary())).session.title).toBe("old title");
    await writeFile(path, old.replace("old title", "new title").replace("old text", "new text"));
    await utimes(path, oldStatTime, oldStatTime);
    expect((await reader.readSession(summary())).blocks[0]!.text).toBe("new text");
    expect((await reader.readSession(summary())).session.title).toBe("new title");
    await save([header()]);
    expect((await reader.readSession(summary())).blocks).toEqual([]);
    const replacement = `${path}.replacement`;
    await save([header(), message("r", null, "user", "replacement")], replacement);
    await rename(replacement, path);
    expect((await reader.readSession(summary())).blocks[0]!.text).toBe("replacement");
  });
});

describe("tree integrity and transcript rendering", () => {
  test("selects last logical entry, branches by ancestry and pairs tools by call ID", async () => {
    await save([header(), message("u", null, "user", "question"),
      message("a", "u", "assistant", [{ type: "thinking", thinking: "saved thought" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "one" } }, { type: "toolCall", id: "call-2", name: "bash", arguments: { command: "two" } }]),
      entry("metadata", "a", "future_metadata", { arbitrary: true }),
      message("r2", "metadata", "toolResult", [{ type: "text", text: "second result" }], { toolCallId: "call-2", toolName: "bash" }),
      message("r1", "r2", "toolResult", [{ type: "text", text: "first result" }], { toolCallId: "call-1", toolName: "read" }),
      message("sibling", "a", "assistant", [{ type: "text", text: "sibling only" }])]);
    const selected = await reader.readSession(summary());
    expect(selected.leafId).toBe("sibling");
    expect(selected.branches.map(branch => branch.id).sort()).toEqual(["r1", "sibling"]);
    expect(selected.blocks.some(block => block.role === "tool")).toBe(false);
    const first = await reader.readSession(summary(), "r1");
    const tools = first.blocks.filter(block => block.role === "tool");
    expect(tools.map(block => block.details.find(detail => detail.label === "参数")!.text)).toEqual([JSON.stringify({ command: "two" }, null, 2), JSON.stringify({ path: "one" }, null, 2)]);
    expect(first.blocks[1]!.details.find(detail => detail.label.includes("thinking"))!.text).toBe("saved thought");
    expect(first.blocks.map(block => block.text).join(" ")).not.toContain("sibling only");
    await expect(reader.readSession(summary(), "absent")).rejects.toThrow("不存在");
  });

  test("does not pair a result with a tool call on another branch", async () => {
    await save([header(), message("u", null, "user", "question"), message("a", "u", "assistant", [{ type: "toolCall", id: "private", name: "read", arguments: {} }]), message("r", "u", "toolResult", [{ type: "text", text: "not paired" }], { toolCallId: "private", toolName: "read" })]);
    const result = await reader.readSession(summary());
    expect(result.warnings.join(" ")).toContain("没有所选分支上的调用");
    expect(result.blocks[1]!.details.some(detail => detail.label === "调用 entry")).toBe(false);
  });

  test("retains messages before compaction and reset, resolves branch labels", async () => {
    await save([header(), message("u", null, "user", "before compaction"), entry("c", "u", "compaction", { summary: "compressed", firstKeptEntryId: "u" }), entry("reset", "c", "reset_boundary"), message("a", "reset", "assistant", [{ type: "text", text: "after reset" }]), entry("label", "a", "label", { targetId: "label", label: "named branch" })]);
    const result = await reader.readSession(summary());
    expect(result.blocks[0]!.text).toBe("before compaction");
    expect(result.blocks.map(block => block.text).join(" ")).toContain("after reset");
    expect(result.blocks.filter(block => block.role === "system")).toHaveLength(2);
    expect(result.branches[0]!.label).toBe("named branch");
  });

  test("rejects duplicates, missing parents, self-links, longer cycles and malformed envelopes", async () => {
    const cases = [
      [message("x", null, "user", "one"), message("x", null, "user", "duplicate")],
      [message("x", "missing", "user", "missing")],
      [message("x", "x", "user", "self")],
      [message("x", "y", "user", "cycle"), message("y", "x", "user", "cycle")],
      [{ type: "future", id: "x", timestamp: TIME }],
    ];
    for (const entries of cases) {
      await save([header(), ...entries]);
      await expect(reader.readSession(summary())).rejects.toThrow();
      expect((await reader.listSessions()).sessions).toEqual([]);
    }
  });

  test("represents images/blobs and redacted thinking without opening external files", async () => {
    const referenced = join(root, "never-read-image");
    await writeFile(referenced, "secret sentinel");
    const image = { type: "image", data: `blob:sha256:${"a".repeat(64)}`, url: referenced };
    await save([header(ID, { cwd: referenced }), message("u", null, "user", [image]), message("a", "u", "assistant", [{ type: "redactedThinking", data: "not-readable" }, { type: "text", text: "answer" }])]);
    const bytes = await readFile(path);
    await rm(referenced);
    const result = await reader.readSession(summary());
    expect(result.blocks[0]!.text).toContain("未读取图片内容");
    expect(result.blocks[1]!.details[0]!.text).toContain("无法恢复");
    expect(JSON.stringify(result)).not.toContain("secret sentinel");
    expect(await readFile(path)).toEqual(bytes);
  });

  test("tolerates incomplete trailing bytes only and retries them on refresh", async () => {
    const tail = JSON.stringify(message("a", "u", "assistant", [{ type: "text", text: "completed" }]));
    await save([header(), message("u", null, "user", source())], path, tail.slice(0, -2));
    const partial = await reader.readSession(summary());
    expect(partial.incomplete).toBe(true);
    expect(partial.blocks).toHaveLength(1);
    expect(partial.warnings.join(" ")).toContain("末行");
    expect((await reader.findRequest(request()))[0]!.entryId).toBe("u");
    await save([header(), message("u", null, "user", source())], path, tail);
    const complete = await reader.readSession(summary());
    expect(complete.incomplete).toBe(false);
    expect(complete.blocks.at(-1)!.text).toBe("completed");
    await writeFile(path, `${JSON.stringify(header())}\n{broken}\n${JSON.stringify(message("a", null, "user", "not allowed"))}\n`);
    await expect(reader.readSession(summary())).rejects.toThrow("JSON 损坏");
    await expect(reader.findRequest(request())).rejects.toThrow("扫描不完整");
    await writeFile(path, `${JSON.stringify(header())}\n\n`);
    await expect(reader.readSession(summary())).rejects.toThrow("JSON 损坏");
  });
});

describe("request association", () => {
  test("uses structured user source, local Bot and original message ID, returns every containing leaf", async () => {
    await save([header(), message("first", null, "user", [{ type: "text", text: source() }]), message("answer-a", "first", "assistant", [{ type: "text", text: "branch a" }]), message("answer-b", "first", "assistant", [{ type: "text", text: "branch b" }]), message("second", "answer-b", "user", source({ messageId: "message-2", runId: "run-b" })), message("answer-c", "second", "assistant", [{ type: "text", text: "second request" }])]);
    const first = await reader.findRequest(request());
    expect(first.map(match => [match.entryId, match.leafId]).sort()).toEqual([["first", "answer-a"], ["first", "answer-c"]]);
    expect((await reader.findRequest(request({ messageId: "message-2" }))).map(match => [match.entryId, match.leafId])).toEqual([["second", "answer-c"]]);
    expect(await reader.findRequest(request({ messageId: "absent", sessionKey: "shared" }))).toEqual([]);
    for (const payload of [source({ botId: "n1-other" }), source({ source: "something-else" }), "clawsynapse message-1", JSON.stringify({ sessionKey: "shared" })]) {
      await save([header(), message("u", null, "user", payload)]);
      expect(await reader.findRequest(request())).toEqual([]);
    }
    await save([header(), message("a", null, "assistant", [{ type: "text", text: source() }])]);
    expect(await reader.findRequest(request())).toEqual([]);
  });

  test("does not collapse separate runs or bindings for the same message", async () => {
    await save([header(), message("run-a", null, "user", source()), message("run-b", null, "user", source({ runId: "run-b" }))]);
    const other = join(data, "bots", BOT, "workspace", "OLD", ".clawsynapse", "omp-sessions", `time_${SECOND}.jsonl`);
    await save([header(SECOND), message("old-run", null, "user", source({ runId: "run-old" }))], other);
    const matches = await reader.findRequest(request({ runId: "run-a" }));
    expect(matches).toHaveLength(3);
    expect(new Set(matches.map(match => match.entryId))).toEqual(new Set(["run-a", "run-b", "old-run"]));
  });
});

describe("children and path boundaries", () => {
  test("discovers children on demand, validates direct parents and supports nested Agent names", async () => {
    await save([header(), message("u", null, "user", "parent")]);
    const childPath = join(path.slice(0, -6), "ScoutAgent.jsonl");
    const grandchildPath = join(childPath.slice(0, -6), "ChildAgent.jsonl");
    await save([header(SECOND, { parentSession: path }), message("c", null, "user", "child")], childPath);
    await save([header("nested-session", { parentSession: childPath }), message("g", null, "assistant", [{ type: "text", text: "nested" }])], grandchildPath);
    expect((await reader.listSessions()).sessions).toHaveLength(1);
    const children = await reader.listChildren(summary());
    expect(children.warnings).toEqual([]);
    expect(children.sessions.map(session => session.sessionId)).toEqual([SECOND]);
    expect((await reader.readSession(children.sessions[0]!)).blocks[0]!.text).toBe("child");
    const nested = await reader.listChildren(children.sessions[0]!);
    expect(nested.sessions).toHaveLength(1);
    expect((await reader.readSession(nested.sessions[0]!)).blocks[0]!.text).toBe("nested");
    await save([header(SECOND, { parentSession: join(root, "forged.jsonl") })], childPath);
    expect((await reader.listChildren(summary())).warnings.join(" ")).toContain("parentSession");
    await expect(reader.readSession(nested.sessions[0]!)).rejects.toThrow("parentSession");
  });

  test("does not follow forged cwd or parentSession read targets", async () => {
    await save([header(ID, { cwd: join(root, "missing"), parentSession: join(root, "missing-parent.jsonl") })]);
    expect((await reader.readSession(summary())).blocks).toEqual([]);
    const childPath = join(path.slice(0, -6), "Agent.jsonl");
    await save([header(SECOND, { parentSession: ID })], childPath);
    const children = await reader.listChildren(summary());
    expect(children.sessions).toEqual([]);
    expect(children.warnings.join(" ")).toContain("parentSession");
  });

  test("rejects forged summaries and symlinked files, directories and Bot configs", async () => {
    await save([header()]);
    for (const forged of [summary(join(root, `time_${ID}.jsonl`)), summary(path, { botId: "n1-other" }), summary(path, { bindingRevision: "OTHER" }), summary(path, { sessionId: SECOND })]) {
      await expect(reader.readSession(forged)).rejects.toThrow();
    }
    await expect(reader.readSession(summary(`${dir}/../omp-sessions/2026-05-14T10-12-03_${ID}.jsonl`))).rejects.toThrow("规范绝对路径");
    const outside = join(root, `outside_${ID}.jsonl`);
    await save([header(), message("secret", null, "user", "outside sentinel")], outside);
    await rm(path);
    await symlink(outside, path);
    expect((await reader.listSessions()).warnings.join(" ")).toContain("符号链接");
    await expect(reader.readSession(summary())).rejects.toThrow("符号链接");
    await rm(path);
    await save([header()]);
    const actualDir = `${dir}-actual`;
    await rename(dir, actualDir);
    await symlink(actualDir, dir);
    await expect(reader.readSession(summary())).rejects.toThrow("符号链接");
    expect((await reader.listSessions()).warnings.join(" ")).toContain("符号链接");
    await rm(dir);
    await rename(actualDir, dir);
    const config = join(data, "bots", BOT, "config.json");
    await rm(config);
    await symlink(outside, config);
    const result = await reader.listSessions();
    expect(result.sessions[0]!.historicalBinding).toBe("unknown");
    expect(result.warnings.join(" ")).toContain("符号链接");
  });

  test("reports filesystem failures instead of returning an apparently empty list", async () => {
    await rm(join(data, "bots", BOT, "workspace"), { recursive: true });
    await writeFile(join(data, "bots", BOT, "workspace"), "not a directory");
    const listed = await reader.listSessions();
    expect(listed.sessions).toEqual([]);
    expect(listed.warnings.length).toBeGreaterThan(0);
    await expect(reader.findRequest(request())).rejects.toThrow("扫描不完整");
    const absent = new HistoryReader({ dataDir: join(root, "absent"), botIds: [BOT] });
    await expect(absent.listSessions()).rejects.toThrow();
    expect(() => new HistoryReader({ dataDir: data, botIds: ["../escape"] })).toThrow();
  });
});

describe("resource boundaries", () => {
  test("rejects oversized sparse files before reading their contents", async () => {
    await save([header()]);
    await truncate(path, LIMITS.historyBytes + 1);
    await expect(reader.readSession(summary())).rejects.toThrow("超过");
    expect((await reader.listSessions()).sessions).toEqual([]);
  });

  test("enforces physical line and logical entry limits", async () => {
    await save([header(), message("u", null, "user", "x".repeat(LIMITS.lineBytes))]);
    await expect(reader.readSession(summary())).rejects.toThrow("单行");
    const records: unknown[] = [header()];
    for (let i = 0; i <= LIMITS.entries; i++) records.push(entry(String(i), i ? String(i - 1) : null, "unknown_future"));
    await save(records);
    await expect(reader.readSession(summary())).rejects.toThrow("entry");
  }, 30_000);

  test("bounds discovery even when a directory contains only irrelevant entries", async () => {
    for (let i = 0; i <= LIMITS.candidates; i++) await writeFile(join(dir, `unrelated-${i}`), "");
    const listed = await reader.listSessions();
    expect(listed.warnings.join(" ")).toContain("列表不完整");
    await expect(reader.findRequest(request())).rejects.toThrow("扫描不完整");
  }, 30_000);
});

test("automatic local history follows registered Bot additions and rejects removed identities even while files remain", async () => {
  const botId = `n1-${"a".repeat(32)}`;
  const config = { dataDir: data, botIds: [] as string[], autoDiscoverBots: true };
  const automatic = new HistoryReader(config);
  const catalog = (ids: string[]) => writeFile(join(data, "bots.json"), JSON.stringify({
    schemaVersion: 3, bots: ids.map(botId => ({ botId, desiredState: "stopped", archived: false })),
  }));
  await catalog([]);
  expect((await automatic.listSessions()).sessions).toEqual([]);
  const target = join(data, "bots", botId, "workspace", "BINDING", ".clawsynapse", "omp-sessions", `2026-05-14T10-12-03_${ID}.jsonl`);
  await save([header(), message("u", null, "user", "automatic history")], target);
  await writeFile(join(data, "bots", botId, "config.json"), JSON.stringify({ role: "agent", bindingRevision: "BINDING" }));
  const consoleId = `n1-${"c".repeat(32)}`;
  await mkdir(join(data, "bots", consoleId), { recursive: true });
  await writeFile(join(data, "bots", consoleId, "config.json"), JSON.stringify({ role: "console" }));
  await catalog([botId, consoleId]);
  const listing = await automatic.listSessions();
  expect(listing.sessions.map(session => session.botId)).toEqual([botId]);
  expect(listing.warnings).toEqual([]);
  const session = listing.sessions[0]!;
  expect((await automatic.readSession(session)).blocks[0]!.text).toContain("automatic history");
  await catalog([]);
  expect((await automatic.listSessions()).sessions).toEqual([]);
  await expect(automatic.readSession(session)).rejects.toThrow("配置的 Bot");
  await catalog([botId]);
  expect((await automatic.listSessions()).sessions.map(item => item.sessionId)).toEqual([ID]);
});
