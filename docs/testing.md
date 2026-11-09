# ClawSynapse omp 测试验证方案

状态：持续验收计划。仓库现有插件实现、类型检查和行为回归测试；已执行结果单独记录在 [实际验证记录](verification.md)。本文的全部场景不能仅因实现存在就视为通过；目前未制作 Dockerfile 或验收镜像。

## 1. 环境选择

推荐 **Orb Ubuntu 做真实集成验收，Docker 做可重复自动化，宿主独立目录做快速 smoke**。它们承担不同证明责任，不需要把同一批手工验收在三个环境完整重做。

| 备选 | 能验证什么 | 局限与隔离要求 | 定位 |
|---|---|---|---|
| 独立 HOME / XDG / omp profile | 宿主 Bun/omp 兼容、终端交互、配置隔离、短反馈循环 | 这是进程配置隔离，不是安全沙箱；同用户进程仍可访问宿主文件和网络。Python venv 不适用于本 TypeScript/Bun 插件 | 日常快速检查，macOS 发布前 smoke |
| Docker 容器 | 固定版本、干净依赖、HTTP/磁盘/崩溃故障注入、可自动重复的 Linux 检查 | CLI 与 daemon 可用性需另查；TUI 需要 PTY。禁止挂宿主 HOME、SSH agent、Docker socket，禁止 privileged；非 root 运行，持久数据在 Linux volume 中 | 实现后建设自动化与 CI |
| Orb Ubuntu Linux machine | Bun/omp、ClawSynapse、NATS 和真实 TUI 的完整组合，保留现场便于排障 | 需固定版本并记录安装步骤；有宿主文件/命令集成，不是默认封闭的恶意代码沙箱。测试数据放 guest 自有目录，不复用宿主凭据或数据根 | 首次真实端到端验收，首选 |

`orb -m ubuntu` 是进入**已有名为 ubuntu 的 machine**，不是创建或重置环境。使用专用名字避免污染日常 machine；本轮已创建 `clawsynapse-omp-test`，启用 `--isolated --isolate-network`，关闭宿主共享/集成并限制访问其他 machine/宿主 IP，没有使用原有 ubuntu/ubuntu-2 的数据。

## 2. 共同约束与前置条件

- 记录插件 Git commit、ClawSynapse commit/版本、omp 和 Bun 的精确版本，以及 OS/架构；依赖通过 lockfile 固定，容器基础镜像固定 digest，不用 `latest` 作为验收依据。
- HTTP 只允许 loopback：插件和它观察的 daemon 必须位于同一 guest 或同一容器网络命名空间。不能把 endpoint 改成 `host.docker.internal`、VM IP 或远端地址来绕过设计。Docker 内的其他进程可放同一测试容器；拆容器时显式共享 daemon 的网络命名空间。单独的 NATS 可以使用私有测试网络。
- 使用新的 HOME、XDG 目录、ClawSynapse DataDir、插件 stateDir、omp profile/会话目录及 JetStream 数据目录；清除继承的生产 CLAWSYNAPSE_* 配置、代理和凭据环境变量。源码可复制或只读挂载，运行数据不能写回源码目录。
- 仅创建测试 Bot、测试身份和测试信任关系，不复制生产 Bot。禁止连接生产 NATS、公开转发 daemon HTTP 或挂载宿主真实历史。
- 集成环境需要启用 JetStream 的 NATS、ClawSynapse CLI/daemon、Bun、目标 omp 版本，以及可真实调用的测试模型。模型凭据单独配置，日志和验收产物中不记录 token 或完整模型上下文。
- 准备一个发送方 Console Bot 和两个接收方 Agent Bot；后两者显式配置 `harness.adapter=omp`，均使用完整 Bot ID。测试控制器负责 Bot 创建/启动/信任，插件仍只读观察。按对应 ClawSynapse 版本的 CLI 文档操作，等待实际 running/信任状态，而非只看 202 接纳响应。
- 未配置真实模型时可以完成确定性逻辑与协议检查，但不能把合成 JSONL、HTTP fixture 或 Console 收件当作真实 omp 工具历史的端到端验收。

## 3. Orb Ubuntu 执行路径

普通专用 machine 的入口如下。对恶意输入与故障测试，优先使用本轮已验证的隔离创建参数：`orb create --isolated --isolate-network --memory 4G --cpus 2 --disk 12G ubuntu:26.04 clawsynapse-omp-test`；不要覆盖已有同名 machine。

```sh
# 在 macOS 上创建专用 machine；已有同名 machine 时先核实用途，不覆盖
orb create ubuntu clawsynapse-omp-test
orb -m clawsynapse-omp-test
```

进入 machine 后按顺序准备：

1. 用非 root 测试用户，在 guest 自有文件系统建立私有测试根，例如 `$HOME/clawsynapse-omp-test`。其下分别放源码、HOME/XDG、daemon DataDir、插件 stateDir、JetStream 数据和验收证据；目录 0700，敏感文件 0600。不把 `/mnt/mac` 等宿主共享路径作为运行数据目录。
2. 安装锁定版本的 Bun、omp、ClawSynapse 和启用 JetStream 的 NATS Server；记录版本。仅在 guest 中配置一次性模型凭据，确认实际调用可用；不从宿主复制整个认证目录。
3. 清理继承环境并设置测试 HOME/XDG。启动独立 JetStream，确认它使用测试存储目录及测试端口。用 ClawSynapse `init` 的显式 `--config`、`--data-dir`、`--local-api-addr`、`--nats-servers` 参数初始化，运行 `clawsynapsed --config` 指向这份配置；不安装系统服务。
4. 在同一 guest 的另一终端创建/启动测试 Bot 并建立测试信任。先用 Console 收件链路验证真实业务请求可达，再准备两个 omp Agent 的模型和 binding。
5. 插件实现后，在 guest 的 `~/.omp/clawsynapse.json` 显式填写 guest 内的 loopback endpoint、DataDir、stateDir 和两个接收方完整 ID，再加载插件。用 `/tmp` 等无项目配置的目录启动，核实用户级默认生效；另用完整项目 `.omp/clawsynapse.json` 验证整份覆盖、不混入用户 Bot/token，损坏或 symlink 项目配置不得回退。面板中核实数据根和 Bot，再开始发送请求。
6. 执行第 5 节场景，并在 daemon 停止后重开历史面板证明离线读取。发布前在 macOS 独立目录补做真实 TUI smoke，覆盖终端宽度、Esc/返回、状态栏、同 UUID 恢复及 SQLite 权限/同步设置。

Docker 路径使用相同逻辑场景：实现后制作包含固定版本依赖的测试镜像，非 root 运行，交互验收分配 PTY，故障数据用独立 volume 或限额 tmpfs；不要求容器内运行 systemd。无模型凭据的 CI 只报告其实际覆盖层级，不冒充完整集成通过。

## 4. 验证分层与可观察结果

| 层级 | 运行面 | 关键断言 |
|---|---|---|
| 确定性逻辑回归 | Bun，临时目录、真实 SQLite；HTTP 边界可用受控本地 fixture | 分类、分页、cursor/未查看原子提交、精确 ID 确认、revision 冲突、容量；分支/树/工具配对、路径越界、控制字符安全处理 |
| 故障与恢复 | 子进程、真实文件系统和 SQLite，guest/container 内执行 | COMMIT 前后强杀、并发写入、锁冲突、权限/ENOSPC、超大响应取消；不能仅靠抛一个模拟异常证明磁盘恢复 |
| 真实链路 | 真实 NATS + daemon + omp Agent + 插件 TUI | 远端请求到达、状态计数、真实工具历史及主/子会话关联，反馈不计数，daemon 离线仍可浏览 |
| 宿主兼容 | macOS 原生终端、独立测试数据 | Linux 通过不能代替 macOS TUI、路径、SQLite 和权限行为验收 |

确定性测试只保留消费者可见行为与边界；使用可控时钟、完成信号或测试进程同步点，不用任意 sleep 代替状态确认。测试数据只能包含合成内容或脱敏样本。UI 通过真实 TUI 操作和截图/终端记录确认，不对源码字符串、复制后的常量或 mock 回显写“证明性测试”。

## 5. 必测场景与通过判据

| 场景 | 操作 | 通过判据 |
|---|---|---|
| 基线与追赶 | 先存旧 inbox，再启动观察；随后发送跨多页的新请求及反馈 | 旧请求不计新；每轮最多 5 页，最终新业务 ID 集合准确，反馈不增加计数，TUI 可响应 |
| 空交互会话 | 不产生任何 assistant 回答，开始观察并提交新请求后退出/强杀，再正常 resume 原 UUID | 开始观察前宿主已保存可恢复的 header；resume 后取回精确 cursor/未查看 ID。若目标 omp 无法做到，则该版本不通过兼容验收，不能改测数据库读取来冒充恢复 |
| 已有会话恢复 | 从可正常 resume 的同一 omp session UUID 重启插件 | 恢复已提交 cursor 和精确未查看 ID；离线期间已入 inbox 的请求继续补读，不重复建立基线 |
| 禁用会话持久化 | TUI 用 `--no-session`，或目标公开保存能力不可用/失败 | 明确禁用通知观察，不强制覆盖用户的 no-session 选择；历史浏览仍可用，不创建“不可找回 UUID”的观察状态 |
| 并发查看 | 渲染第一页后，在确认事务前注入下一批请求 | 仅已渲染 ID 被确认；未显示分页和并发新增 ID 仍未查看；确认失败则计数不提前减少 |
| 分支与多窗口 | 树导航、产生新 UUID 的分叉、切换会话；两个进程打开同一观察范围 | 同 UUID 不回退，新 UUID 默认独立；旧异步结果不污染新会话；revision 冲突后重载，不覆盖已提交新请求 |
| 事务崩溃 | 通过私有测试同步点，在 COMMIT 前和 COMMIT 后/发布 UI 前分别强杀写入进程，再重开库 | 只出现完整旧状态或完整新状态；不能出现新 cursor 配旧未查看集合。恢复后继续补读结果与未崩溃对照一致 |
| 存储故障 | 非 root 下制造不可写目录、第二连接持写锁、限额文件系统写满 | 明确报错且不推进 cursor/提前确认；TUI 不同步等待锁。释放故障后从已提交状态继续，不删库重建基线 |
| 范围与数据集变化 | 两 Bot/不同 endpoint、DataDir、绑定、观察范围；测试数据回退 | 不跨范围复用 cursor，不混淆旧 binding；可识别回退时显式报错。无 generation 的同 ID 替换检测限制必须保留，不能宣称已全面解决 |
| 真实工具与子 Agent | 在两个 omp Agent 上执行可控请求，至少一次真实工具调用、一次真实委派；同一 sessionKey 再发送请求 | 面板展示真实工具参数/结果与请求起点，按调用 ID/所选分支配对；恢复会话不凭一次请求拆文件，子 Agent 按父会话归组 |
| 历史格式与破损 | title 前导、多分支、compaction/reset、半行补全、中间损坏、重写/替换、未知版本 | 默认分支可解释，旧消息保留，半行刷新后可读；损坏/不支持版本显式提示，不跨坏节点拼对话 |
| 路径与只读 | guest 内放越界 symlink、伪造 cwd/parentSession；停止历史写入者后对读取树做前后散列 | 拒绝越界，不读取哨兵内容；历史文件及引用文件散列和目录成员不变，只有独立 stateDir 可写 |
| 资源边界 | 分别输入设计上限处及刚超上限的数据；HTTP 加入无 Content-Length 的流式超大响应 | 边界内可处理，超限取消/暂停/明确拒绝；未查看数据与 cursor 不丢，缓存淘汰后可重读；对照采样 RSS，不能只检查错误字符串 |
| 终端内容 | 在隔离终端中展示 ANSI、OSC 8/52、DCS、C1 和换行/制表攻击样本 | 危险字节成为可见转义，终端标题/光标及预设测试剪贴板不被改变；禁用宿主剪贴板等集成，不能拿生产终端或真实剪贴板冒险 |
| 模式与退出 | print/RPC 启动、TUI 切换与退出，期间保留未完成 HTTP | 非 TUI 无通知轮询；旧请求被取消或结果被代次丢弃，无遗留监听/数据库句柄，不执行历史工具或把内容送入模型 |

数据库损坏、未知 schema、超过观察范围数/主库页数上限也需要明确错误用例。边界测试按具体资源分别断言，不能仅构造一个“超大输入”就视为全部上限已覆盖。

## 6. 证据与完成条件

每轮保存版本清单、环境/网络拓扑、使用的数据根、执行场景、断言结果及脱敏 TUI 截图或终端记录。崩溃用例记录强杀同步点和重开后的 cursor/未查看 ID 对照；只读检查在写入者停止后执行，避免把 daemon 正常写入误判为插件修改。

首次完整通过要求：设计文档全部验收项有实际对应证据，Orb 或等价 Linux 环境完成真实工具/子 Agent 链路，macOS 原生 TUI smoke 通过。凭据/模型未准备好、插件尚未实现、某环境尚未启动时，明确记录未执行项，不能用 health、HTTP fixture 或数据库原语测试替代。

本轮已执行模块测试、macOS omp TUI/RPC smoke、真实 ENOSPC，以及独立 Orb 上的真实 Console 收件链路；模型执行、真实工具/子 Agent 和全量 UI 故障交互等仍按计划验收。实际版本、命令、结果和证据边界见 [实际验证记录](verification.md)，不把计划改写为通过报告。

## 参考

- [OrbStack machine commands](https://docs.orbstack.dev/machines/commands)：`orb create` 与 `orb -m` 的不同职责。
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)：同步 Interface、事务与数据库连接管理。
- [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)：FULL/EXTRA 的同步与文件系统保证范围。
- [omp extension authoring](https://omp.sh/docs/extension-authoring)：公开 Interface、生命周期与非交互模式限制。
- ClawSynapse 配套版本的 `docs/cli.md`、`docs/operations.md`：显式 DataDir/config、Bot Role/Harness、JetStream 与真实模型前置条件；这些文件属于相邻项目，不作为本插件包的本地链接。
