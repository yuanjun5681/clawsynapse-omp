---
summary: "omp 插件只读展示 ClawSynapse 本地原生处理历史的路径与筛选依据"
title: "omp 插件本地会话历史调研"
---

# omp 插件本地会话历史调研

本文由 `clawsynapse/docs/omp-plugin-history.md` 迁移至插件项目，保留原调研证据。文中 `internal/...` 路径、“本仓 adapter”及相关实现均指相邻的 `clawsynapse` 项目；本插件总体方案见 [插件设计](design.md)。本机检查结果是调研时快照，不是部署配置或当前实时状态。

## 范围与结论

仅展示本机 omp 如何处理 ClawSynapse 远端请求：用户输入、assistant 回答、工具调用与结果，以及实际保存的 thinking；不要求双向 wire 消息历史。该范围可使用本地原生 JSONL，无须为历史查看增加 daemon 双向会话 API。历史不是实时执行状态；尚未持久化的流式输出不能从 JSONL 恢复。

## 保存路径

普通 omp 的默认会话根目录为 `~/.omp/agent/sessions/`；命名 profile 通常为 `~/.omp/profiles/<name>/agent/sessions/`。XDG/目录覆盖可改变默认位置；当前交互会话以 `/session info` 为准。不要自行拼接 omp 的 project 编码目录。

ClawSynapse 的 omp adapter 明确传入 `--session-dir`，因此其主会话位于：

```text
<DataDir>/bots/<botId>/workspace/<bindingRevision>/.clawsynapse/omp-sessions/
  <timestamp>_<nativeSessionId>.jsonl
```

`DataDir` 默认 `~/.clawsynapse`，但支持配置和启动参数覆盖。优先从插件配置或实际 daemon 部署配置解析，不能假设一定使用默认路径。更换 Harness binding 后新旧目录分开，历史查看可以跨 binding 枚举并明确标识旧绑定。

来源：`internal/config/daemon.go:107-110,400-412`；`internal/app/app.go:188-203`；`internal/adapter/pi_sessions.go:32-34`；`internal/adapter/cli.go:218-233`。

## 如何筛选与关联

1. 仅在配置的 DataDir 下枚举 Bot / binding 的专用 `omp-sessions` 目录，不全盘扫描普通 omp 会话。
2. 顶层 `*.jsonl` 作为主会话候选。检查普通文件、目录边界与 header；不要跟随符号链接到授权根之外。
3. 不把物理首行固定当作 header：omp 可以先写 `type=title,v=1`，随后才是 `type=session`。用 header.id 确认 native session UUID，不仅相信文件名。
4. 按原生树结构读取 user 消息。其 content 可以是字符串或 text blocks；提取文本并尝试 JSON 解析，而非搜索关键词。
5. ClawSynapse adapter 的输入是 JSON 对象，字段包括 `source:"clawsynapse"`、`botId`、`messageId`、`requestId`、`runId`、`from`、`sessionKey`、`payload`、`metadata`、`executionContext`。结合专用目录、botId 与结构化 source 识别来源；source 本身只是分类标记，不是认证证明。
6. 同一原生会话可处理多个请求，不能假设一文件一请求。使用注入的 user entry 及其 messageId/runId 标记请求起点，在所选分支上查看后续处理记录。

来源：`internal/adapter/cli.go:243-273`；`internal/adapter/pi_sessions.go:79-181`；omp [Session format](https://omp.sh/docs/session-format)。

另有映射文件：

```text
<DataDir>/bots/<botId>/sessions/<bindingRevision>/omp/<hash-prefix>/<hash>.json
```

其 `sessionId` 指向原生 UUID；`sessionKey` 是隔离后的摘要，不是原始会话名。映射仅在成功完成、保存会话后写入，因此不能作为实时发现新会话的唯一入口。主会话列表应从专用原生目录发现，映射只作补充。

来源：`internal/app/app.go:102-104`；`internal/store/session_state.go:13-42`；`internal/adapter/cli.go:159-171,308-345`；`internal/messaging/handler.go:115-129`。

## 只读展示要求

- JSONL 是树状日志：按 entry.id / parentId 还原选定分支，不能直接把所有行拼成一段线性对话。
- 展示 user、assistant text、toolCall、toolResult；thinking 仅展示实际已保存且可读的内容，不声称能还原隐藏/加密推理。
- 存在 compaction、reset、branch summary 等记录；历史查看与重建模型上下文是两件事，不应因上下文压缩而丢掉旧历史。
- 活跃文件末尾可能有未写完的一行，应暂缓解析该行。文件还可能原地更新 title 或因维护重写，不能只依赖永久递增 offset。
- 完成的消息/工具活动才持久化，JSONL 不包含全部 in-flight streaming delta，不能单凭文件无增长判定已完成。
- 图片可能引用独立 blob；只展示文本与工具过程时无需读取图片 blob，完整图片展示则需要另行解析实际 omp blob 根目录。
- 读取时不 resume、不 export、不执行会话中的工具，也不把历史自动注入当前模型上下文。
- 状态栏继续从 daemon inbox cursor 感知接收请求；历史 JSONL 用于本地处理过程查看。两者职责不同。

官方来源：[Sessions](https://omp.sh/docs/sessions)、[Session format](https://omp.sh/docs/session-format)、[Authoring extensions](https://omp.sh/docs/extension-authoring)。

## 验证边界

以上路径与注入字段已核对原 ClawSynapse adapter 实现；本调研本身不构成插件实现或端到端通过的证明。当前实现与已执行检查见 [实际验证记录](verification.md)。

## 本机只读检查结果

本机默认 DataDir 为 `/Users/lalo/.clawsynapse`。已发现一个配置为 omp 的 Bot，其专用原生目录实际存在：

```text
/Users/lalo/.clawsynapse/bots/n1-dc69c3923c8945bf38b6b2784b447f37/workspace/QIWJTFRQXYLZZX4IJ5DF7HYE4M/.clawsynapse/omp-sessions/
```

检查时该目录为空，未找到可用于验证来源标记的 ClawSynapse 原生 omp 历史样本；不据此推断其他 DataDir 或已经清理的历史。

普通 omp 根目录下存在 `--Volumes-UWorks-Projects-clawsynapse--` 与 `--Volumes-UWorks-Projects-clawsynapse-bot--` 等项目会话目录。这些 header.cwd 指向开发仓库，不是 Bot 隔离工作目录，不能仅因路径含 clawsynapse 就认定它们是远端请求的处理历史。只读抽样确认了 title v1、session v3 及 user/assistant/toolResult 等记录形状，未输出消息正文。

工具统计数据库只能作辅助索引，不能代替对专用目录的发现与 JSONL header 校验。

## 读取方式与子 Agent

建议插件以只读 JSONL 解析为默认方案，不为了查看而调用 `SessionManager.open` 或 resume。子研究检查的本机缓存包为 `@oh-my-pi/pi-coding-agent@18.13.3`，其中存在内部只读 loader/listing；但内部导出与当前运行版本的一致性未经验证，不应直接作为稳定插件契约。普通 listing 还可能恢复备份；公开 session manager 的打开/写入路径涉及目录、breadcrumb 与迁移，不能据名称假设纯只读。

如请求执行委派了子 Agent，其历史不是主文件中普通 entry 分支，而是独立 JSONL：

```text
<timestamp>_<sessionId>.jsonl
<timestamp>_<sessionId>/<AgentId>.jsonl
<timestamp>_<sessionId>/<AgentId>/<ChildAgentId>.jsonl
```

本机普通 omp 会话样本确认了该 sibling artifact 布局，子文件 header.parentSession 指向父 JSONL。专用目录顶层文件作为主列表，子 Agent 通过父会话详情按需展开，不当作独立远端请求。不要将 artifact 中其他日志文件作为 transcript。以上子 Agent 布局已在普通会话取样，但 ClawSynapse 真实执行样本仍缺失。
