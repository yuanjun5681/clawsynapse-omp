# 实际验证记录

日期：2026-11-09。状态：实现可加载，以下已执行检查通过；不是完整发布验收通过声明。

## 环境与版本

| 项目 | 实际使用 |
|---|---|
| 宿主 | macOS arm64，预编译 `omp/18.18.3` |
| 模块运行时 | macOS Bun 1.4.3；Linux Bun 1.4.3 |
| 类型与 TUI 包 | `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-tui` 18.18.3，bun.lock 固定依赖 |
| Linux | 专用 Orb `clawsynapse-omp-test`，Ubuntu 26.04 arm64；`--isolated --isolate-network`，4G / 2 CPU / 12G |
| daemon | 相邻 ClawSynapse 工作树交叉编译的 Linux arm64 CLI/daemon，运行时版本 `dev`；工作树 HEAD `a761fcdd47df77c3d7cca5737fa8184157edcf9f`，不将 HEAD 等同于未核验的整个工作树快照 |
| 消息总线 | NATS Server 2.10.27，JetStream 开启，guest 内仅监听 127.0.0.1:14422 |
| daemon HTTP | guest 内仅监听 127.0.0.1:18180，独立 DataDir；不读取生产身份或凭据 |

本轮交叉编译产物 SHA-256：daemon `19331a0793818e6f9796f6f01905f3ac7186f6b8737092134a65d8ef90cefe49`；CLI `c5a29e90214fb9beb556ee7210fa913415bc9959e42296738210eb14f6bf5c49`。

上游 coding-agent 源码包声明的 Bun engine 与本轮独立 Bun CLI 版本不同；本轮真实宿主使用预编译 omp，不能据此宣称源码版 omp 在更低 Bun engine 上兼容。此处版本号是实际验收组合，不是最低版本或“必须最新”的要求；插件不声明精确宿主 peer dependency，按所需公开能力检查运行。

后续最低版本专项评估确定公开接口支持基线为 **18.13.3**，并实测 18.2.10、18.13.3、18.18.0、18.18.1 和 18.18.3 的通知、历史与已查看确认路径。18.2.10 是已查明的最早完整运行版本，但其会话保存方法尚未进入扩展公开类型。证据、二进制校验值、安装语法与实际 GitHub 分发阻碍见 [版本兼容评估](compatibility.md)；不据此扩大下列历史验收场景的版本覆盖。

## 已执行检查

| 检查 | 命令或运行面 | 结果与证明范围 |
|---|---|---|
| 类型检查 | macOS `bun run check`；guest `bun run --bun --cwd <测试项目> check` | 通过，插件与目标版本公开类型相符 |
| 行为回归 | Linux `bun test --cwd <测试项目>` | 70 pass、0 fail，5 个测试文件、264 次断言 |
| macOS 最终行为检查 | `bun run check && bun test` | 70 pass、0 fail、265 次断言；包含最后补充的独立 CR 控制字符转义回归 |
| SQLite 强杀 | 子进程在真实 COMMIT 前/后同步阻塞，再 SIGKILL、重开库 | 两个永久回归通过；只恢复完整旧/新状态，没有新 cursor 配旧未查看集合 |
| 磁盘满 | guest 私有 128 KiB tmpfs，用真实文件耗尽可用空间，再提交请求 | 真实 full 错误后 cursor/未查看集合不变；释放空间后重开库、原页重试成功 |
| 原生 TUI | 实际 omp 二进制 + PTY + VT 屏幕解析；HTTP 与历史使用明确标记的合成 fixture | 面板、视口精确确认、前缀定位、详情/返回、分支、子 Agent、Esc 均通过 |
| 空交互会话恢复 | 没有模型回答的实际 TUI 会话，提交观察状态后 SIGKILL，再用原文件 resume | UUID、cursor 与精确未查看 ID 集合保持；没有生成第二个交互会话文件 |
| TUI 禁用持久化 | 实际 `omp --no-session`，打开通知说明并通过前缀进入历史 | 显示“观察不可用”，不伪造 0 条未读；历史可浏览，HTTP 查询次数为 0，不创建插件状态或交互会话文件 |
| RPC | 实际 `omp --mode rpc --no-session --model anthropic/claude-sonnet-4-5 --extension ...`，只调用命令查询、`/clawsynapse` 与 get_state | 通过；未出现 agent_start/message_start，daemon 查询次数为 0，未创建插件 stateDir；仅显式选择模型，不提供凭据、不调用该模型 |
| 真实消息链路 | 真实 JetStream + daemon，一个发送 Console、两个接收 Console + RequestObserver | 基线、两类业务命令、反馈过滤、Bot 隔离、状态库重开、并发到达后精确查看确认通过 |

真实消息场景中，接收 A 最终 cursor=3、接收 B cursor=1；三条业务请求中显式查看一条后，剩余 ID 恰好为另一 Bot 的请求与并发新到请求。`chat.response` 被实际接收并推进 cursor，但不增加新请求数量。未用 Console 的接收成功冒充 omp Agent 已执行。

## TUI 证据的含义

- 使用全新 HOME/XDG、独立配置/DataDir/stateDir/交互 session 目录，不使用宿主生产认证。只在这份临时配置中关闭首次启动教学，未执行 provider 登录。
- 注入 40 条请求；最终布局在 110×38 终端中确认 24 条、保留 16 条，确认集合与实际 VT 视口出现的请求 ID 集合严格相同。检查会等到完整请求行进入屏幕模型，不使用尚在传输中的半帧截图充当证据。
- 强杀后启动第二个真实 omp 进程，显式 resume 原 JSONL，验证同 UUID 与原未查看集合恢复。该场景证明已提交状态恢复，不声称 SIGKILL 执行了 graceful shutdown hook。
- 历史 fixture 覆盖多分支和父子 Agent，工具结果/可读 thinking 的结构配对另有行为回归。这些不是来自真实模型任务的历史样本。
- 临时终端记录含 home、new-requests、timeline、session-provenance、detail、branches、children、child-timeline、resumed-empty-session；i 能打开完整数据根/Bot/binding/会话标识。原始临时测试数据不作为产品文件提交；本记录保存运行方法、关键断言及证明边界。

## 现有 ubuntu 的旧版本兼容与安装

- 保留原有预编译 `omp/18.18.2`，安装独立 Bun 1.4.4。验证前后 omp 二进制 SHA-256 均为 `128e1772b2e01bf7ee83cc6810e7efc1e0a5eda87220bad870322f762a9458ab`；没有运行 omp update。
- 删除宿主精确 peer dependency；固定 SDK 只供开发期类型检查。`bun install --production --frozen-lockfile` 实际安装 11 个运行依赖包，没有安装 coding-agent 开发包。
- 在全新 HOME/XDG、合成 HTTP/历史和独立配置/状态目录中启动实际 18.18.2 TUI。公开会话落盘、托管定时器、自定义面板、终端绘制回调均可用，没有使用模型凭据或推理。
- 注入 40 条请求；110×38 终端中实际显示并确认 24 条，保留 16 条，屏幕 ID 集合与已确认集合严格相同。原生历史前缀定位、user/assistant 时间线、i 会话来源信息、Backspace 返回和 Esc 关闭通过；不将此轮合成历史宣称为真实 Agent 执行。
- `omp plugin link` 注册独立源码副本，`omp plugin list --json` 确认为 enabled，doctor 的插件项为 ok。doctor 同时报告全局 `package_manifest: Not created yet` warning；未将其描述为全绿，也未改写宿主全局 package manifest。
- 删除临时探针并停止探针拥有的进程；未停止现有 ubuntu、未修改生产 daemon/Bot 配置，未发送业务消息或读取生产会话正文。
- 兼容性按公开能力判断，不推断未测旧版本均可用：缺少会话持久化/托管定时器时禁用观察；缺少绘制回调时请求列表只读并明确告警，历史保留。

## 用户级默认配置修复

- 根因：原加载器只读当前目录的 `.omp/clawsynapse.json`，实际在 `/tmp` 启动时得到 ENOENT；插件全局启用不等于配置全局可见。
- `bun run check && bun test tests/config.test.ts` 通过：9 pass、0 fail、29 次断言。新增回归使用独立 HOME 子进程，覆盖不同工作目录共用默认配置、`~/` 路径、项目整份覆盖且不混用 Bot/token、损坏或 symlink 项目文件拒绝回退、两处配置均缺失。
- ubuntu 已将原独立工作目录中未改动的配置迁移到 `~/.omp/clawsynapse.json`（0600），删除该工作目录的冗余项目配置；实际加载器在 `/tmp`、HOME 和原工作目录均解析到同一显式 Bot/endpoint。没有复制旧观察状态或修改生产 daemon/Bot。
- 原生 TUI 运行于 guest 的真实 `/tmp`，没有该目录的项目配置；使用全新 HOME/XDG、用户级合成配置、独立 DataDir/stateDir 和 HTTP fixture。状态栏“已连接”、观察库创建、实际 HTTP 轮询、面板内完整 Bot/数据根/connected 状态及 Esc 关闭均通过；没有调用模型或读取生产会话正文。
- 此轮实际宿主为 `omp/18.18.3`，以 VT 画面和 `omp --version` 为准；当前二进制 SHA-256 为 `c49a84875d915c7d0de8bb69fe180b3bf53c16600bc4d5a61ea22ac2b3ac45c9`。探针末行遗留的 18.18.2 固定标签不是版本证据，不据此声称本轮在 18.18.2 验收；此前 18.18.2 记录保留。本轮没有执行 omp 升级，插件不新增宿主版本限制。

## 通知名称与连续对话浏览

- `bun run check && bun test tests/client.test.ts` 通过：30 pass、0 fail、106 次断言。新增 HTTP/SQLite 行为回归证明：同一发送方在不同接收 Bot 下采用各自别名，名称接口失败时回退 ID，消息连接、持久游标与未查看请求不受影响，错误响应正文不进入观察快照。
- 已只读查询现有 daemon 的 scoped peers 元数据，确认截图发送方有 `displayName: User-A`；未读取业务消息正文、改名、修改信任或发送消息。
- 在 ubuntu 当前 `omp/18.18.3` + Bun 1.4.4 中，用全新 HOME/XDG、合成 HTTP/历史和独立状态库启动实际 TUI。两个尺寸均验证完整 `ClawSynapse` 状态名、`User-A` 来源、未知名称的完整 ID 回退、直接会话总览、连续 user/assistant/工具消息，以及 50 行长回答全部可达。
- 已验证 thinking/工具结果展开、i 信息返回原阅读位置、分支选择与返回、子 Agent 完整对话与返回、原生 session 前缀直接进入正文及返回总览、Esc 关闭。仅浏览总览/正文时 40 条请求全部保留；按 n 打开请求列表后才按实际 VT 视口精确确认：

| 终端尺寸 | 注入请求 | 实际显示并确认 | 保留未查看 |
|---|---:|---:|---:|
| 110×38 | 40 | 25 | 15 |
| 80×24 | 40 | 11 | 29 |

- 确认集合与实际屏幕请求 ID 集合严格相等。长对话按消息/段落偏移分页，未拼接整份文本或预载全部子 Agent。本轮没有模型推理或生产历史正文；不是新增真实 Agent 执行验收。

## 空标题会话的可读名称

- 根因已确认：现有三份原生历史均有 title v1 记录，但 title 为空；原摘要逻辑保留空字符串，UI 因而统一显示“未命名会话”。
- `bun run check && bun test tests/history.test.ts` 通过：26 pass、0 fail、115 次断言。新增回归覆盖空/缺失标题、保留已有 header 标题、首条有效 user、结构化 chat/task 正文、普通 text blocks、空白归一化、完整字素截断、无用户正文时的时间/短 ID 和历史字节不变。
- 已更新 ubuntu 独立插件的 history 模块；实际读取现有三份历史后，三份均获得带创建时间的有效请求摘要，warnings=0。验证只输出数量，不输出用户请求或派生标题正文；未改写原生历史。
- 另以全新 HOME/XDG、三个空标题合成会话和实际 omp TUI，在 80×24 终端验证三行不同的“UTC 时间 + 请求摘要”完整可见，Enter 打开、Backspace 返回及 Esc 关闭正常；浏览前后合成历史字节一致。此场景使用 `--no-session` 只读浏览，不调用模型。

## 工作区主题 currentInstruction 标题

- 对照桌面端 `workspace_context.go` 确认实际封装：外层 ClawSynapse user JSON 的 payload.text 为一行执行说明，再接包含 conversationId、history、currentInstruction 的 JSON。先前仅提取 payload.text，误把执行说明当成用户摘要。
- 标题现在识别该主题结构，只提取顶层 currentInstruction；不从 history 中递归猜测指令，不依赖执行说明的具体措辞。空指令不回退执行说明；普通消息提及同名字段不误识别，已有原生标题仍优先。
- `bun run check && bun test tests/history.test.ts` 通过：30 pass、0 fail、126 次断言。新增回归覆盖说明行后的嵌套 JSON、转义引号/换行、带同名嵌套字段的历史、直接主题 JSON、空指令及普通正文的误识别防护。
- 已更新 ubuntu 插件；现有 4 个主题会话的派生标题均与对应首条有效用户请求的 currentInstruction 前缀一致，warnings=0。核验只输出计数，未输出用户指令正文。
- 全新 HOME/XDG 下，80×24 实际 TUI 已验证带说明主题、直接 JSON 主题与普通消息三类可读标题，并通过 Enter/Backspace/Esc 与历史字节不变检查；没有模型推理或原生历史回写。

## 回归测试内容

- `tests/config.test.ts`：用户级默认、项目整份优先和错误不回退、隔离 HOME、显式身份、loopback、目录别名隔离、token 范围和危险终端文本，包括不能原样透传的独立 CR。
- `tests/state.test.ts`：重开恢复、revision/cursor CAS、容量整页回滚、元数据字节边界、独立 Bot/观察范围、损坏/权限拒绝、最近来源按本地到达顺序。
- `tests/client.test.ts`：基线、分页、公私请求分类、HTTP/业务/非法响应、解压后大小、重定向、私有 token、取消与代次、确认失败与锁释放后恢复。
- `tests/history.test.ts`：title/session 版本、空标题请求摘要/时间/短 ID、字素边界与只读保证、树/工具关联、reset/compaction、半行/重写、请求关联、嵌套子 Agent、路径越界和资源边界。
- `tests/crash.test.ts` 与专用子进程 fixture：真实事务 COMMIT 两侧的进程崩溃恢复。

## 尚未通过的完整验收

1. **真实 omp Agent 模型、工具与子 Agent 链路**：隔离环境没有专用测试模型/凭据。需要新建两个 `role=agent`、`harness.adapter=omp` 的接收 Bot；现有 Console 的 Role 不能直接切换。完成真实请求、真实工具调用/委派、同 sessionKey 后续请求和历史关联后，才能关闭此项。
2. **全量 TUI 故障与平台场景**：print 模式、真实交互会话切换/分叉、断线期间浏览、窄终端、宿主剪贴板/标题/光标不变等尚未全部做实际界面验收。相关底层逻辑有回归，不替代这些实机场景。
3. **发布前环境矩阵**：尚无 Docker 验收镜像/CI；除本记录列明的组合外，未验证其他 omp/Bun 版本、所有本地文件系统、断电/设备不履行同步写入及所有数据集同 ID 替换。无 journal generation 的协议限制仍存在。

后续按 [测试计划](testing.md) 执行剩余场景。凭据应直接配置到隔离测试环境，不写入项目、验收记录或聊天；不自动复用生产认证。

本轮专用 daemon/NATS 进程已停止，Orb `clawsynapse-omp-test` 已确认 stopped；保留 guest 的私有测试数据便于后续模型验收。guest 源码副本是本轮验收快照，继续前须重新同步当前仓库与 lockfile。没有停止或改写原有 ubuntu/ubuntu-2。

## 零配置连接与本地 Bot 自动同步

- 默认不要求 `~/.omp/clawsynapse.json`：使用 `http://127.0.0.1:18080` 和 `~/.clawsynapse`，引用 schemaVersion 3 的 `bots.json`。上游依据为相邻 ClawSynapse 的 `docs/operations.md`、`docs/api.md`、`internal/app/manager.go`；本地 catalog 是注册身份真源，不通过扫描目录激活未知 Bot，不读取身份私钥或复制 token。
- `bun run check` 通过。针对 config/state/client/history 的首次回归为 102 pass、2 fail；其中发现并修复了自动历史刷新在遍历 Set 时原地清空/重新添加导致重复扫描的问题，改为替换集合、保留正在遍历的快照。另删除了把“回退检测的最近消息查询”误判为“重新建立基线”的错误断言。随后仅重跑两个失败场景，2 pass、0 fail、18 次断言；其余 102 项未重复执行。本轮没有运行未改动的 crash 测试。
- 新增行为覆盖无配置启动、空安装、完整项目覆盖、注册表损坏/重复/不支持版本/超限/符号链接、遗留目录不激活、自动范围持久化、并发窗口、隐藏数据容量核算、移除后恢复及保留未查看集合。显式范围保留原作用域；自动范围使用稳定 `local-catalog` 标识，避免每次 Bot 增删重建基线。
- macOS arm64 实际 `omp/18.18.3`，110×38 PTY 与 VT 屏幕解析；全新 HOME/XDG、默认路径、独立会话和状态库。确认 `~/.omp/clawsynapse.json` 从始至终不存在；本轮拥有的合成 HTTP 服务绑定默认 `127.0.0.1:18080`，没有访问生产 daemon、Bot、凭据或历史，没有模型推理。
- 首先无数据/无 Bot 启动，屏幕显示等待本地 Bot，实际收到 `/v2/health` 查询。随后写入合成 schema-3 catalog 和 A 的专用历史，自动建立 cursor=5 基线；增加 cursor=6 后状态栏显示 1 条新请求，`/clawsynapse` 展示 A 历史，Enter 连续显示合成 user/assistant 内容，SQLite 中该请求仍未查看。
- 不重启 omp，新增 B 后范围自动变为 2，按 r 可见 B 历史；移出 A 后范围变为 1，刷新后不再显示 A 历史。重新加入 A 后，其原未查看请求重新可见，SQLite 中 A cursor 仍为 6；按 n 实际绘制该条后未查看计数变为 0，Esc 返回主界面。
- 另在默认端口没有服务时启动第二份全新 HOME，屏幕显示 daemon 离线，历史面板仍可打开并说明暂无本地 Bot；随后启动合成服务，无须重启 omp 即恢复为等待 Bot。未自动创建或启动任何身份。
- README、设计和测试计划已改为默认自动发现、可选人工覆盖。真实 Agent 模型/工具/子 Agent 验收仍未完成；本节不扩大此前兼容性矩阵或真实 daemon 集成的证明范围。
- 自动发现包含 Console Bot；其合法的“无 Harness 绑定”不会被误报为历史损坏。扩展自动历史回归同时注册 Agent 与 Console，验证仅列出实际历史、无绑定警告、移出后拒绝旧身份路径、重新加入可继续读取；单独执行该场景 1 pass、0 fail、7 次断言。
