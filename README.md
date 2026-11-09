# ClawSynapse omp

只读观察 ClawSynapse 远端业务请求，在 omp 状态栏提示新请求，并用 `/clawsynapse` 查看本机原生处理历史。不会注入当前对话、执行历史工具、代替 Bot 回复或修改被查看的历史。

## 开发与加载

插件**不要求最新 omp，也不锁定宿主的精确版本**。已实机验证 omp 18.18.2（Linux）和 18.18.3（macOS）；这是已测组合，不是最低版本要求。运行时按公开接口能力检查兼容性，缺少能力时明确报告并禁用对应功能。`package.json` 中固定的 coding-agent 版本仅用于开发期类型检查，不会作为运行期宿主版本门槛。

```sh
bun install --frozen-lockfile
bun run check
bun test
omp --extension .
```

需要长期启用时，在确认配置和权限后使用 `omp plugin link .`，重启 omp 生效。当前包保持 private，不会发布到 npm。

只安装运行所需依赖可使用 `bun install --production --frozen-lockfile`；不会安装开发期 coding-agent 类型包，更不会替换已有 omp 二进制。使用 Bun，并遵守依赖包自身的运行时要求。

## 配置

默认创建用户级 `~/.omp/clawsynapse.json`，所有工作区共用，不要求在特定目录启动 omp。下列 Bot ID 为格式示例，必须换成该 daemon 上实际存在的完整本地 ID；插件不会自动选择或创建 Bot。

```json
{
  "endpoint": "http://127.0.0.1:18080",
  "dataDir": "~/.clawsynapse",
  "stateDir": "~/.clawsynapse-omp",
  "botIds": ["n1-00000000000000000000000000000001"],
  "pollIntervalMs": 1000
}
```

需要项目专属连接时，可创建 `<项目>/.omp/clawsynapse.json`。项目配置**整份优先**，不会合并用户配置中的 Bot、token 或其他字段；只有项目配置不存在时才读取用户配置。项目配置损坏、权限错误或为 symlink 时直接报错，不静默切换到用户级身份。两处配置均不存在时明确报错；不会向上搜索父项目配置。

- endpoint 仅接受明确的 loopback IP，不使用环境代理、不跟随重定向；插件与 daemon 必须在同一网络命名空间。
- DataDir 为部署机器的真实本地目录；stateDir 必须与其互不包含。已有 stateDir 必须由当前用户拥有且权限为 0700，已有数据库必须是 0600；不自动修正不安全的目录权限。
- 可选 `tokenFiles` 为按所选完整 Bot ID 索引的 token 文件路径对象。文件须为当前用户私有常规文件；配置中不填写 token 明文。未配置时使用 daemon 现有的本机无 token 读取模式。
- 修改配置后重启 omp。配置错误、鉴权失败或数据集回退会明确报告，不更换身份、不重新建立基线掩盖问题。
- 首次观察只建立最近 cursor 基线，不把旧 inbox 计成新请求。同一交互会话 UUID 恢复后继续补读；普通树导航不回退游标，新 UUID 不继承旧范围。
- 开始观察前，经 omp 公开接口保存当前交互会话 header，以便空会话也可恢复。`--no-session` 禁用通知观察，但仍可浏览历史；print/RPC 不启动 TUI 观察循环。

## 使用

- `/clawsynapse`：直接打开配置范围内的全部本地会话总览；Enter 连续阅读所选分支的完整对话，不再逐条进入消息详情。
- `/clawsynapse <session-id 或前缀>`：在配置范围内定位原生会话；有歧义时选择。
- 原生标题为空时，显示“会话创建时间（UTC，Z 后缀）+ 首条有效用户请求摘要”。工作区主题优先取嵌套 JSON 的 `currentInstruction`，不把执行说明或共享 `history` 当标题；普通请求仍提取正文。摘要按完整字素有界截断；没有用户正文时显示时间和短 session ID，不调用模型、不改写历史。
- 列表用 ↑/↓ 选择、Enter 打开，r 刷新；n 打开新请求。顶部显示当前位置；Backspace 返回上一级并保留原位置，Esc 关闭面板，不中止任务。
- 对话连续展示 user/assistant/工具消息，长内容用 PgUp/PgDn 翻页，←/→ 跳转消息；Enter 展开或折叠工具参数/结果和已保存的 thinking。b 选分支，a 查看子 Agent，i 显示完整 DataDir、Bot、binding、原生 session ID 与文件路径。不会同时展开所有分支和子 Agent。

状态栏使用完整名称 `ClawSynapse`。来源从所选接收 Bot 的 `/peers` 名称目录解析：本地别名优先，其次为对端 `displayName`，未知或查询失败时回退完整 Bot ID；名称只用于展示，不替代身份或授权。请求列表保留完整发送方/接收方 ID。只浏览会话总览或对话不会清除新请求，需按 n 显示对应请求条目才确认查看。

仅实际绘制到当前终端视口的请求才确认已查看；未显示的分页和并发新请求保留。确认写入失败时保留未查看状态，修复后按 r 重试。已查看不表示已执行，文件不再增长也不表示任务完成。

宿主缺少终端绘制回调时，请求列表明确降为只读并持续提示，不会用定时器猜测“已显示”或错误清除未查看请求。缺少公开会话持久化或托管定时器时，禁用通知观察，历史仍可浏览。

历史仅发现配置 Bot 的专用 `workspace/<bindingRevision>/.clawsynapse/omp-sessions`，包括旧 binding；普通开发会话和 wire journal 不参与发现。支持 session v2/v3、title v1；其他版本或损坏结构明确拒绝。图片/blob 只显示存在性，不读取内容。

## 限制与验证

网络、队列、数据库、文件、单行、entry 和目录扫描均有固定上限。超限明确暂停或拒绝，不丢弃未查看数据继续推进游标。所有外部终端文本均转义控制序列。

实现、验证范围和未完成的真实模型验收分别见：

- [设计与精确资源上限](docs/design.md)
- [环境选择及测试计划](docs/testing.md)
- [实际验证记录](docs/verification.md)

真实 omp Agent 的模型、工具及子 Agent 端到端验收需要单独的测试模型/凭据；合成历史和 Console 收件链路不代表该项通过。
