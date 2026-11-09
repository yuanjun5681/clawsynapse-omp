# ClawSynapse omp 插件设计

状态：功能已实现，已完成类型检查、逻辑回归、真实 omp TUI/RPC smoke 和隔离 daemon 收件链路验证；尚未完成真实 omp Agent 模型/工具/子 Agent 端到端验收。精确证据与缺失前置条件见 [实际验证记录](verification.md)，不据模块测试推定全部验收通过。

## 1. 目标与非目标

插件作为独立 TypeScript 项目 `clawsynapse-omp`，安装到交互式 omp TUI；不修改 omp 核心。

目标：

1. ClawSynapse 收到远端业务请求时，在 omp 状态栏提示连接状态、新请求数量与最近来源。
2. 使用 `/clawsynapse` 查看本机 omp 处理这些请求的原生会话历史，包括输入、回答、工具调用和结果，以及实际保存的可读 thinking。
3. 多 Bot、多 Harness binding 的历史隔离；历史不依赖 daemon 当前在线。

非目标：

- 展示 ClawSynapse 双向 wire 消息历史。
- 在状态栏推断远端请求的运行中、完成、失败或排队数量。
- 自动把请求注入当前交互式 omp 对话，自动执行、回复或重跑任务。
- 创建、启动、停止、修改 Bot，修改 daemon 配置、信任或凭据。
- 恢复、迁移、导出、分享或修改被查看的 Bot 原生 omp 会话文件；当前交互会话为保证自身可恢复而由宿主保存 header 的前置条件见第 4.2 节。
- 仅为通知增加 SSE/WebSocket、独立 NATS 连接或私有 journal 读取。

本地路径、历史格式、来源字段、子 Agent 和实机取样依据见 [本地历史调研](omp-plugin-history.md)。

## 2. 数据来源与职责

| 数据来源 | 用途 | 不用于 |
|---|---|---|
| daemon HTTP `messages?after=` | 检测本 Bot 新接收的业务请求 | 推断本地执行终态、获取完整处理过程 |
| 专用 `omp-sessions/*.jsonl` | 查看本机 omp 的已持久化处理过程 | 判断尚未落盘的流式内容或 daemon 是否收到请求 |
| 本地 SessionState 映射 | 按 native session UUID 辅助关联 | 唯一会话发现入口、原始 sessionKey 还原 |
| 插件自有 SQLite 状态库 | 原子保存观察游标、未查看元数据及查看确认 | 保存消息正文、模型上下文或修改原生会话 |

两条读取链路独立：daemon 离线时仍可查看已有历史；未生成原生历史的新请求仍可被状态栏发现。

## 3. 状态栏

使用 `ctx.ui.setStatus("clawsynapse", text)`。不接管整个 footer，不把长正文放入状态栏。

| 场景 | 示例 |
|---|---|
| 正在建立初始游标 | `ClawSynapse · 连接中` |
| 已连接且无新请求 | `ClawSynapse · 已连接` |
| 有未查看的新请求 | `ClawSynapse · 2 条新请求 · 来自 User-A` |
| daemon 无法连接 | `ClawSynapse · 离线 · 2 条未查看` |
| HTTP 错误、鉴权失败或响应非法 | `ClawSynapse · 查询失败 · 2 条未查看` |
| 多 Bot 部分查询失败 | `ClawSynapse · 1/2 Bot 可用 · 2 条新请求` |

来源名称从接收 Bot 作用域内的 `GET /v2/bots/<botId>/peers` 解析，本地 `localAlias` 优先，其次为签名 discovery 的 `displayName`；未知、空名称或名称查询失败时使用完整发送方 ID，不伪造名称。不同接收 Bot 的别名不混用；名称仅作显示，不改变请求身份或授权，不写入持久观察状态。有未查看请求时在该 Bot 正常轮询后查询，沿用相同 scoped token、loopback/无代理/拒绝重定向、超时和解压后大小上限；只保留当前请求来源名称，单名称最多 8 KiB。名称不可用不暂停消息消费或清除未查看集合，连接详情说明回退原因。请求列表选中行保留完整发送方/接收方 ID。状态文字按终端显示宽度截断；所有外部文本遵守第 5 节的安全渲染规则。不要每次轮询弹通知，错误状态只更新状态栏。

“新请求”是插件观察到且尚未在 `/clawsynapse` 请求列表中确认查看的业务请求，不是 daemon inbox 总数，不是待执行数，也不是对方未读状态。

用户关闭 omp 的 hook status 显示设置时，状态栏可能不可见；命令仍可使用。非 TUI 模式不启动通知轮询和交互 UI，防止 daemon 启动的 `omp -p --mode json` 再启动插件的观察循环。

## 4. 游标轮询

### 4.1 读取契约

```text
GET <endpoint>/v2/bots/<botId>/messages?after=<cursor>&limit=100
```

响应使用 ClawSynapse `APIResult`；读取 `data.items` 与 `data.cursor`。cursor 是单 Bot 的本地收件箱序号，不能跨 Bot、不同 endpoint 或不同数据集复用。

默认建议每秒轮询一次，网络请求超时为 3 秒；这些是设计值，不是实测延迟承诺。多个 Bot 各自维护游标与连接状态，单 Bot 不允许重叠请求。积压超过单页时按返回游标继续读取，直到空页；每 Bot 每轮最多消费 5 页，未追完的积压留到下一轮，页间让出事件循环。容量与故障暂停优先于追赶，不以持续有新消息为由无限循环。

请求分类仅统计协议支持的远端业务命令（当前为 `chat.message`、`task.assign`），排除自身来源、`run.*`、`chat.progress`、回复和反馈事件。所有收件箱记录都推进游标，不能只为被展示的类型推进，否则会重复读取反馈。

### 4.2 初始加载与未查看状态

- 首次观察某个 Bot：调用无 `after` 的最近消息查询，以响应 cursor 建立基线，不把已有全部历史当成刚收到的新请求。
- 已有同一观察范围的持久游标：从该游标继续消费，不重新建立基线，避免重启遗漏。
- 在观察范围内以 `(botId,messageId)` 去重；游标与未查看的最小元数据一起保存，不保存完整 payload。已提交 cursor 之前的记录不重放，不维护无限增长的已查看 ID 数组。
- `/clawsynapse` 展示独立的“新请求”列表；只有当前视口实际完成渲染的条目才可确认查看，不能把列表分页中未显示的条目一起确认。确认提交显式 ID 集合，不按当前总数或“全部”清空，不能清除显示快照之后才到达的请求。
- 请求尚未产生原生历史时显示“暂无本地处理历史”；即使已查看也不声称任务已执行。
- 自动模式中，Bot 移出注册列表后停止查询并隐藏其观察数据，不删除持久 cursor 或未查看记录；重新加入时继续原进度。显式选择模式中 Bot 消失仍报告查询错误。数据集回退或本地数据替换时不悄悄重建基线；现有接口没有 journal generation，不能保证检测到所有同 ID 数据替换情况。

#### 持久化与提交顺序

观察状态不再写入 omp `appendEntry` / custom entries。它们不进入模型上下文，但不提供本设计所需的可确认提交契约：本机缓存的 omp 18.13.3 中，新会话可能等到出现 assistant 消息才创建文件，追加失败也可能只在宿主内部记录。此证据不代表其他版本；本插件不依赖其内部实现来判断落盘成功。

使用 Bun 内置 `bun:sqlite`，在插件自有 `stateDir/observers.sqlite3` 保存状态；不引入 ORM 或可替换存储后端。状态库带 schemaVersion，目录权限 0700，数据库及其事务文件权限 0600；拒绝把数据库放在 daemon 数据树、原生历史目录或网络文件系统中。插件状态只写自有库；当前交互会话 header 只交由 omp 的公开接口保存，不直接改写 JSONL，不写被查看的会话及引用文件。

- 观察键为 `(当前交互式 omp session UUID, 规范化 endpoint, 规范化 DataDir, 范围标识)`；显式模式的范围标识仍为排序去重的 Bot ID 集合，自动模式为稳定的 `local-catalog`。因此自动列表增删不会创建新范围或重置其他 Bot 的游标。被移出 Bot 的数据保留并计入容量，但从当前快照隐藏；重新注册恢复。不同模式的数据不混用或自动迁移。使用公开 `ctx.sessionManager.getSessionId()` 获取当前交互会话 ID，不用被查看的 Bot 原生 session ID。
- 开始建立基线或恢复观察前，调用公开 `ctx.sessionManager.ensureOnDisk()`，并核实 `getSessionFile()` 提供的持久文件存在、header.id 与当前 UUID 一致；这样没有 assistant 回答的新会话也有可 resume 的身份。该操作只针对当前交互会话，若其文件位于被观察 Bot 历史读取树中则禁用观察。缺失公开能力、`--no-session` 无持久文件或宿主保存失败时显示明确错误，不启动通知轮询；只读历史面板仍可使用。不以 SQLite 中存在一个无法恢复的 UUID 记录冒充重启恢复。
- 同一观察范围恢复已提交游标及未查看数据；新范围先成功提交基线，再宣告连接完成。普通分支和树导航不回退观察状态；产生新 UUID 的 fork/branch 是新观察范围，不继承旧游标或未查看记录。新会话 header 已由宿主保存是恢复前提，不能仅因 `getSessionId()` 返回字符串就宣称可恢复。
- 状态表保存各 Bot 的 cursor、未查看元数据和观察范围 revision。使用 SQLite 事务、`journal_mode=DELETE`、`synchronous=EXTRA`；启动时核对设置，未知 schema 拒绝写入。事务内不进行网络请求、目录扫描或 UI 渲染，锁冲突立即返回，交由下一轮调度重试，不同步等待锁而卡住 TUI。
- 收到一页后先完整校验并分类，再在一个短事务中检查预期 revision、插入去重后的未查看元数据并推进该 Bot cursor。事务提交成功后才发布新内存快照；解析、容量检查或写入失败均不推进 cursor，不把该页标成消费成功。失败页可从持久 cursor 重取，不无限堆积内存重试批次。
- 查看确认在独立事务中仅删除已呈现的 ID 集合；提交成功后才更新未查看计数。失败则保留未查看状态并显示错误，不声称已确认。轮询提交与查看确认均在事务内递增 revision；并发修改导致 revision 不匹配时重新加载，不用旧快照覆盖新请求。
- 多窗口不是全局未读服务。不同交互会话 UUID 的观察范围独立；同一 UUID、同一范围的窗口通过事务和 revision 防止覆盖，显示可在下一次刷新收敛，不承诺同步刷新。进程崩溃后的恢复依赖 SQLite 的事务恢复；不把文件系统/设备不履行同步写入的情形宣称为可保证的断电恢复。
- 状态库无法打开、损坏、权限错误或磁盘已满时暂停观察，保留已有文件并报告原因；不得删除库、重新建基线或退化成“看似已持久化”的内存状态。已有历史浏览仍可用。

### 4.3 故障处理

单次失败不推进 cursor、不清未查看记录；下一次正常轮询恢复。HTTP 401/403、404 Bot 不存在、409 Bot 过渡状态等显示可辨识原因，不自动创建、启动或更换身份。网络错误与 daemon 返回的业务错误分开处理。响应不合法时拒绝消费，不以空结果掩盖异常。

### 4.4 资源上限

以下是首版固定设计上限，需通过第 10 节的边界用例验证；不是已实测容量承诺。计量中的 MiB 为 1024² 字节。

| 资源 | 上限及行为 |
|---|---|
| HTTP 响应 | 每页解压后的响应体最多 8 MiB；流式计数并在超限时取消，不能先无界 `response.json()` 再检查 |
| 自动发现 | 注册表最多 1 MiB、1000 个 Bot；只读 schemaVersion 3 的 `DataDir/bots.json`，拒绝损坏、重复身份、符号链接与非法路径，不扫描目录激活未知 Bot |
| 请求元数据 | 单条序列化后最多 8 KiB，仅包含关联 ID、来源和时间等必要字段；超限整页拒绝提交，不截断唯一键 |
| 未查看队列 | 每观察范围最多 1000 条且元数据总计不超过 8 MiB；整页事务若超限则回滚并暂停消费，用户查看释放容量后再追赶 |
| 状态库 | 最多 128 个观察范围，主库最多 64 MiB（通过页数限制约束）；不得自动淘汰旧范围或未查看记录，新范围/写入超限时报告容量错误 |
| JSONL 解析 | 单文件最多 64 MiB、单物理行最多 8 MiB、最多 100000 条逻辑 entry；按块读取并检查增长，超限显示明确不可完整读取原因，不拼接“完整历史” |
| 历史发现与缓存 | 单次发现最多检查 10000 个目录项（含 binding 与无关文件），超限注明列表不完整；不预载子 Agent。当前不保留跨会话解析缓存，返回旧会话时按标识重新读取；若将来引入缓存，每进程总量不得超过 128 MiB |

暂停消费时状态栏必须说明“容量受限/存储失败，观察已暂停”，保留已有未查看数量；不能继续显示正常已连接。反馈事件也只有在所在整页成功提交时才推进 cursor。超大单页等无法靠查看释放的限制需报告明确原因，不反复高速重试。

## 5. Slash 命令与查看流程

注册唯一顶层命令 `clawsynapse`，避免占用 omp 内置 `/session`、`/resume` 等名称。

| 命令 | 行为 |
|---|---|
| `/clawsynapse` | 直接显示配置范围内全部本地会话总览；n 进入新请求 |
| `/clawsynapse <session-id>` | 在已配置范围内按完整 ID 或唯一前缀定位本地会话；歧义时选择，不猜测 |

面板行为：

- 会话总览按最近持久化活动排序，直接展示标题与绑定状态；选中行显示 Bot、原生 session ID、最后活动时间，i 查看完整来源。顶部显示当前位置、观察范围与新请求入口，不再经过首页菜单。
- 非空 title v1 优先，其次非空 header.title；均缺失或为空白时，使用会话创建时间（UTC，分钟精度、Z 后缀）与首条有效 user 请求的单行摘要。ClawSynapse 结构化输入先提取 payload.text / payload.instruction（或字符串 payload）；工作区主题正文为一行执行说明后附 JSON（也接受直接 JSON），识别顶层 conversationId 与 history 数组后只取 currentInstruction，绝不使用共享历史或执行说明充当请求；有效主题的空/缺失指令视为无可用正文，不回退说明文字。普通正文兼容字符串与 text blocks，不因提到 currentInstruction 就误识别为主题。摘要最多 40 个完整字素，空白折叠，超出加省略号。无用户正文时使用时间与短 session ID；只有缺少有效创建时间才退到用户 entry 时间/文件时间。标题仅在读取时派生，不调用模型，不回写 title/header 或被查看历史。
- binding 已非当前配置时标记历史绑定，不自动接回执行。
- 新请求可定位对应主会话和请求起点；尚未关联到原生历史时保留请求元数据和明确空态。
- Enter 后连续阅读所选分支的 user 输入、assistant text、toolCall 与 toolResult，不再把每条消息作为新的详情层级；工具按调用 ID 配对，不按相邻行配对。
- 工具参数/结果、已保存的可读 thinking 默认折叠，Enter 展开/折叠；PgUp/PgDn 翻页，←/→ 跳转消息。按消息、段落与偏移渲染当前页，不拼接整份会话或提前展开全部工具；不可读、redacted 或未保存的推理不作恢复承诺。
- b 分支、a 子 Agent、r 刷新、i 来源信息；Backspace 返回上一级并恢复列表选择/阅读位置，Esc 始终关闭而不中止任务。只读浏览会话不确认新请求；按 n 打开请求列表后仍仅确认实际绘制条目。
- 默认选择文件最后一条逻辑 entry 的祖先链；这是文件可推导的默认分支，不保证等于正在运行的 omp 内存选中分支。
- 执行中只展示已落盘内容并注明限制，不能根据文件停止增长显示“已完成”。

长内容分页/按需加载；不默认展开整个文件和全部子 Agent。普通文本与工具过程为核心范围，图片 blob 不在本设计的渲染范围内，显示存在图片或 blob 引用，不伪造图片内容。

所有来源、标题、错误文本、user/assistant 正文、工具名称/参数/结果和 thinking 都是不可信终端文本。进入普通文本或 Markdown 渲染前，将 ESC、C1 及除换行/制表外的控制字符转成可见转义；状态栏还需转义换行/制表。禁止把内容中的 ANSI、OSC（含超链接/剪贴板）、DCS 或清屏/光标移动序列直通终端，只保留 UI 自己生成的样式。超长文本按显示单元分页；安全处理只改变展示，不回写原始文件。

## 6. 历史发现与请求关联

### 6.1 目录

```text
<DataDir>/bots/<botId>/workspace/<bindingRevision>/.clawsynapse/omp-sessions/
  <timestamp>_<nativeSessionId>.jsonl
  <timestamp>_<nativeSessionId>/<AgentId>.jsonl
```

使用配置的 DataDir，默认 `~/.clawsynapse`。仅枚举所选 Bot 的专用目录；历史查看包括旧 binding。普通 omp 默认根 `~/.omp/agent/sessions` 下的开发会话不参与发现，即使 cwd 或标题包含 clawsynapse。

主会话收集顶层 JSONL；同名 artifact 目录中的子 Agent 按父会话按需展开，校验其 parentSession 并限制目录范围。不得把 wire journal `state/messages.jsonl`、SessionState JSON、锁文件、备份或其他日志混入列表。

### 6.2 来源和会话标识

以 `(botId,bindingRevision,nativeSessionId)` 标识本地会话，不以标题或原始 sessionKey 作为唯一键。文件名 UUID 与逻辑 session header.id 应匹配；物理首行可能是 title v1，需要跳过该记录再读 header。

解析 user 消息中的 JSON 输入，检查 `source:"clawsynapse"`、`botId`、`messageId`、`requestId`、`runId`、`from`、`sessionKey` 等字段。此处 source 是正文中的字段，不是 title.source；它是分类线索，不是身份认证。目录、header 与结构化输入共同用于关联。

同一会话可以处理多个请求；使用 user entry 标记各请求起点。关联新请求首选本地 Bot + 原始 messageId，并保留 runId 作为执行关联信息；不能只用同名 sessionKey 合并不同发送方。

SessionState 中只有隔离后的摘要与 native UUID，且成功完成后才保存，故不能只依赖该映射寻找执行中或失败前产生的历史。无有效来源标记的文件不伪装成某个请求的历史，应显示无法确认关联原因。

### 6.3 安全的只读解析

- 不跟随 symlink 越过允许根，不信任文件名、header.cwd 或 parentSession 提供的任意路径。
- 解析 entry 树，检测重复 ID、缺失 parent、自引用和环；损坏内容给出提示，不跨错误节点拼出貌似完整的对话。
- 活跃文件末行不完整时等待后续刷新；中间非法记录、未来不支持版本应报告，不默默丢掉。
- 未知 entry 和字段可忽略显示但不能误解释；compaction/reset 不应删除历史查看中的旧消息。
- title 可原地修改，迁移/维护可重写文件；监听只是刷新线索，读取时检查文件替换、截断和重写，不永久假定 append-only。
- 不调用 `SessionManager.open`、resume、export 作为只读加载手段；不依赖未公开的 omp 内部深路径导出。

## 7. 插件配置

插件配置是可选覆盖，不是首次使用前置条件。两处配置都不存在时，使用 `http://127.0.0.1:18080`、`~/.clawsynapse`、`~/.omp/clawsynapse` 和每秒轮询，并自动引用 `DataDir/bots.json` 的全部注册 Bot。状态目录归属于 omp，配置文件仍为 `~/.omp/clawsynapse.json`；不自动迁移旧状态，显式 `stateDir` 不变。优先读取 `<cwd>/.omp/clawsynapse.json`，不存在时读取 `~/.omp/clawsynapse.json`；项目文件整份替代用户文件，省略项使用默认值，不按字段继承，防止混用部署与 token。损坏、不可读或为 symlink 时报错，不回退切换身份。不向上搜索父目录。覆盖文件修改后重启；自动注册列表在每轮轮询、历史列表刷新及读取时重载，无须重启。

```json
{
  "endpoint": "http://127.0.0.1:18080",
  "dataDir": "~/.clawsynapse",
  "stateDir": "~/.omp/clawsynapse",
  "botIds": ["<可选：只查看指定 Bot 时填写完整本地 ID，否则省略此字段>"],
  "pollIntervalMs": 1000
}
```

- 省略 `botIds` 时自动发现；显式非空列表仍为固定范围，不擅自扩展。仅以 schemaVersion 3 的注册 catalog 为真源，包含停止和归档 Bot，不读取凭据或创建身份。无数据的新安装返回空范围；catalog 缺失但 Bot 数据仍存在时必须报错恢复原表，不扫描目录猜测。空范围会查询 `GET /v2/health`，区分 daemon 离线和等待创建 Bot；目录发现失败保留现有状态并暂停该轮消息读取，后续轮询重试。
- endpoint 仅允许明确的 loopback 地址，不允许远端地址；拒绝重定向。HTTP 请求不使用环境代理把本机请求送到外部。
- DataDir 必须解析为本机绝对目录；不从请求 payload、会话正文或 header.cwd 动态改写读取根。
- `stateDir` 解析为本机绝对目录，与 DataDir 及原生历史读取根分离；测试必须显式指定独立目录，不能复用生产状态库。改变 stateDir 不自动复制旧观察状态。
- polling 间隔为正数，HTTP 超时固定有界；配置错误时命令显示原因，不静默使用另一个 Bot 或数据目录。
- daemon 现有 loopback 无 token 读取模式可用；可选 `tokenFiles` 是按所选完整 Bot ID 索引的私有常规文件路径对象，读取时要求当前用户拥有且权限 0600。不把 token 明文写入项目配置、状态库或日志。
- HTTP Bot 选择与磁盘 Bot 目录须对应；历史页面注明数据根与 Bot，防止 endpoint 和 DataDir 指向不同部署时误关联。

## 8. 模块与生命周期

建议初始结构，不引入框架或可替换后端抽象：

```text
package.json
docs/
  design.md
  omp-plugin-history.md
  testing.md
  verification.md
src/
  index.ts       注册工厂、配置、生命周期、连接各模块
  config.ts      配置校验、loopback 与目录规范化
  client.ts      HTTP 校验、游标轮询、请求分类与取消
  state.ts       SQLite 事务、范围隔离、游标提交与查看确认
  history.ts     目录发现、只读树解析、来源关联、子 Agent
  ui.ts          状态栏与命令面板
  safety.ts      不可信终端文本转义
  types.ts       模块共享的数据契约与固定上限
```

| 模块 | 对调用方提供的 Interface | 集中的复杂度 |
|---|---|---|
| 请求观察 | start / stop，观察快照与错误回调 | 分页、游标、去重、请求分类、取消、连接状态；只发布已提交快照 |
| 观察状态 | load / commitPage / acknowledge，显式观察范围及预期 revision | SQLite 事务、容量、冲突检查、重启恢复；不暴露 SQL 给 UI |
| 历史读取 | listSessions / readSession，显式选择分支与子 Agent | 路径限制、JSONL、树、半行、重写、请求关联 |
| 展示 | 根据快照更新状态、打开面板 | TUI 交互、折叠、分页、已查看确认 |

以上是模块职责，不要求机械地为每个动作定义 class 或 TypeScript interface。网络、状态提交和磁盘历史读取的复杂度分别集中在 client/state/history 内，UI 不自行拼路径、判断协议事件或直接改游标。

- 工厂仅注册事件和命令；运行期动作在 `session_start` 等回调中启动。
- 使用 `ctx.setInterval` / `ctx.setTimeout` 管理定时器，调用 fetch 时使用 AbortController。
- `session_switch` 时停止旧观察、取消请求、清除旧状态栏，再从状态库加载新观察范围；异步完成回调须校验当前会话代次，不能污染已切换会话。已开始的短事务保持原观察键，不能在回调中改写为新会话的键。
- `session_branch` / `session_tree` 后重新核对交互会话 UUID：未变化则保持同一观察状态，变化则按切换流程加载新范围。历史面板里的分支选择只改变所查看的历史，不改变观察键。
- `session_shutdown` 清 timer、abort HTTP、关闭数据库连接、清 status；历史使用显式刷新，不创建文件监听。不依靠退出 hook 才提交游标，运行期每页及查看确认已各自提交。
- 只使用可核实的公开 omp 扩展接口：`registerCommand`、`ctx.ui.setStatus`、`ctx.ui.custom`、生命周期事件、只读会话标识及当前交互会话的 `ensureOnDisk`；观察状态持久化由插件自有状态库负责。

## 9. 依赖与发布

使用 `@oh-my-pi/pi-coding-agent` 的公开类型，开发依赖固定版本以保证类型检查可复现，但不以该版本作为宿主要求，不声明精确版本 peer dependency，不自动安装或升级 omp。最低支持基线选择 18.13.3：所需接口已全部公开，且已通过隔离 TUI 冒烟验证；更早的 18.2.10 虽可完整运行，但 `ensureOnDisk` 尚未纳入扩展公开类型，不作为推荐安装环境。精确边界、来源和实测范围见 [版本兼容评估](compatibility.md)。运行期仍依据公开能力检查：缺少会话保存/托管定时器能力时禁用观察而保留历史查看；缺少终端绘制回调时请求列表只读、不自动确认，并持续显示具体原因。打包采用 `package.json` 的 `omp.extensions`，通过公开 GitHub 仓库分发。

不复用 clawsynapse 的 Go internal 包；HTTP 与磁盘布局是跨项目依赖。布局变化集中修改 history 模块，协议变化集中修改 client 模块。现阶段不新增 daemon endpoint；若将来要求低延迟推送，再另行定义带 cursor 补读的 SSE 契约，不为单向通知引入 WebSocket。

## 10. 验收标准

以下是发布前的完整验收标准，不是全部通过声明。已执行场景和仍需真实模型的部分见 [实际验证记录](verification.md)。

1. 已建立基线后远端发送业务请求，状态栏在正常下一次轮询完成后增加新请求；历史反馈事件不增加数量。
2. 首次运行不把已有 inbox 全部算为新请求；没有任何 assistant 回答的新交互会话先由宿主保存可恢复的 header，再提交基线和新请求；恢复该 UUID 后取回 cursor 和未查看元数据，分页积压不漏读、不重复计数。`--no-session` 或缺少保存能力时明确禁用通知观察，保留只读历史功能。
3. `/clawsynapse` 新请求列表能显示尚无原生历史的请求；仅实际显示的视口条目变为已查看，未显示的分页和并发新到请求不会被一起清空；确认事务失败时计数保持未查看。
4. 本地 omp 处理请求后，找到专用目录 JSONL 并展示真实工具调用/结果；恢复同一原生会话的后续请求不会被误分成两个文件，也不与其他 Bot/binding 混合。
5. 普通 clawsynapse 开发会话、wire journal、锁和备份不进入主会话列表；父子 Agent 正确分组。
6. title 前导、分支、compaction、半行、文件替换和损坏有明确行为；工具结果在正确分支按调用 ID 匹配。
7. daemon 断开、鉴权失败、Bot 不存在时准确显示异常，保留未查看数据；daemon 离线仍能读取已有历史。
8. 切换 omp 会话和退出不会遗留轮询、文件监听或旧异步回调；同 UUID 树导航不回退游标，新 UUID 不继承；print/RPC 中不启动 TUI 通知循环。
9. 只读查看不修改被查看的 Bot 原生历史及引用文件，不执行历史工具，不把正文和 token 输出到插件日志或当前模型上下文；观察状态只写插件自有库，当前交互会话 header 的保存仅经宿主公开接口完成。
10. 权限错误、数据库锁冲突、磁盘满及提交前/后进程崩溃不会造成“cursor 已推进但未查看记录丢失”；同范围并发窗口不能用旧快照覆盖新请求。
11. HTTP、未查看队列、状态库和 JSONL 达到上限时有明确暂停或拒绝行为，不静默丢弃、伪造完整结果；超大响应未在检查前完整载入内存。
12. 含 ANSI/OSC/DCS/C1 的标题、正文、工具内容及错误信息只显示安全文本，不改终端标题、剪贴板、光标或插件面板之外的内容。

应为游标恢复、并发到达后的已查看语义、事务失败、请求分类、资源上限、路径越界和树/工具关联等容易产生用户可见错误的逻辑保留针对性回归测试；UI 通过实际交互验收，不用源码字符串测试冒充行为证明。环境选择、测试分层、执行步骤与证据要求见 [测试验证方案](testing.md)。

## 11. 当前证据与未验证项

已实现本插件并验证 omp 18.18.3 的公开扩展 Interface。模块回归使用临时目录、真实 SQLite 与本地 HTTP fixture；macOS 实际 omp TUI 已验证视口精确确认、前缀查找、分支/子 Agent 导航及空交互会话强杀后恢复；RPC 本地命令不启动轮询。Orb 独立隔离机中已验证真实 JetStream、daemon、两个 Console 接收 Bot 的观察和状态恢复；这不是 omp Agent 模型执行验证。

详细来源与版本差异记录在 [本地历史调研](omp-plugin-history.md)。其 `internal/...` 来源路径均属于相邻 `clawsynapse` 项目，不属于本插件源码。

早期设计曾核对本机缓存 omp 18.13.3 的 `appendEntry`、会话延迟保存及 `ReadonlySessionManager`，据此选择插件自有 SQLite 与宿主 `ensureOnDisk`。实现针对 18.18.3 的公开类型；后续通过上游版本对照及真实 TUI 验证，将公开接口最低支持基线确定为 18.13.3，不以版本间源码相似性推断兼容。真实 omp Agent 的模型凭据、工具/子 Agent 执行样本与完整验收仍缺失；最低版本冒烟验证不等于全部发布验收通过。

官方参考：

- [Authoring extensions](https://omp.sh/docs/extension-authoring)
- [Sessions](https://omp.sh/docs/sessions)
- [Session format](https://omp.sh/docs/session-format)
