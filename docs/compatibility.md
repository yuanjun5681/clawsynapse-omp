# omp 最低版本评估

日期：2026-11-09。范围：当前插件的 GitHub 安装、通知观察、历史面板及屏幕显示后的已查看确认；不包含真实模型执行验收。

## 结论

**建议将 omp 18.13.3 作为最低支持基线。** 该版本已通过隔离的真实 TUI 冒烟验证，且插件所用的 `sessionManager.ensureOnDisk` 已进入扩展公开类型契约。不需要最新 omp，也不要求与开发 SDK 18.18.3 精确一致。

**18.2.10 是当前查明的最早完整运行版本，不等于公开接口支持基线。** 已实际运行通过通知、历史和已查看确认；但此时 `ensureOnDisk` 只存在于实际传入的 SessionManager，尚未列入扩展公开的 ReadonlySessionManager 类型。不将依赖这一未公开能力的版本作为推荐安装环境。

本结论不新增运行期版本号拦截或宿主 peer dependency；已有能力检查与安全降级保留。未逐一测试所有中间版本，也不承诺所有未来版本兼容。

## 不同版本边界

| 能力 | 首个版本 | 证据与限制 |
| --- | --- | --- |
| `omp plugin install github:owner/repo` | 15.7.3 | 上游加入 GitHub 简写解析；仅代表支持安装语法，不代表本插件能运行。旧安装器需要额外的 Bun。 |
| 扩展托管定时器 `ctx.setTimeout` / `clearTimer` | 17.1.0 | 上游公开扩展类型及 changelog。 |
| 扩展上下文正确提供 `ctx.mode` | 17.3.1 | 更早版本中本插件的 TUI 模式判断会直接返回，不能视为可用。 |
| `tui.addPaintListener` | 18.2.10 | 18.2.9 只有单监听器 `setPaintListener`，18.2.10 增加可共存的监听器；本插件不能覆盖宿主监听器。缺少时请求列表只读，不自动确认已查看。 |
| 预编译 omp 使用内嵌 Bun 安装插件 | 18.11.0 | 此前独立二进制的 Git/npm 安装需要 PATH 中有额外的 Bun。 |
| `ensureOnDisk` 纳入扩展公开会话类型 | 18.13.3 | 对照 18.13.2 / 18.13.3 的 ReadonlySessionManager 声明；这是推荐支持基线的决定性条件。 |

`omp.extensions`、命令注册、自定义面板、状态栏和使用的会话事件早于决定性边界。插件自己的 `@oh-my-pi/pi-tui` 运行依赖不会为宿主传入的 TUI 实例补充 `addPaintListener`。

## 本轮实际验证

使用官方 GitHub Release 的 macOS arm64 预编译二进制；逐个执行 `--version` 核对身份。独立 HOME、XDG、配置、会话、SQLite 和本地 HTTP fixture；不继承生产凭据，不调用模型，不连接生产 daemon。

实际通过以下版本的 TUI 场景：

- 18.2.10、18.13.3、18.18.0、18.18.1、18.18.3。
- 空交互会话可启动观察，轮询建立基线后注入 3 条合成请求，状态栏显示 3 条新请求。
- `/clawsynapse` 打开会话总览，Enter 显示合成 user/assistant 对话。
- 仅浏览历史不清除请求；按 `n` 显示请求列表后确认已查看；Esc 返回主界面。
- 18.13.3 额外核对 SQLite：浏览历史时未查看 ID 恰为 `compat-1`、`compat-2`、`compat-3`；显示请求列表后未查看为 0，cursor 为 3。18.2.10 同样核对未查看计数从 3 变为 0。

此前 Linux 18.18.2 / 18.18.3 的验收见 [实际验证记录](verification.md)。本轮旧版本探针不替代其中的视口分页、崩溃恢复、分支和子 Agent 等更广验收。

18.2.9 的官方 Release API 和预编译下载地址返回 404，未运行该版二进制；其缺少 `addPaintListener` 的结论来自官方已发布 npm 类型声明与 18.2.10 的对照，不冒充负向实测。

### 二进制 SHA-256

| 版本 | SHA-256 |
| --- | --- |
| 18.2.10 | `32895b6a0fb1f33788ac8ab9c807a0c021214963c80c4d956be08c6eafdee008` |
| 18.13.3 | `b449d0d0d779a0b2e655f0ce41d5c414a253de71c67b3affc30a6528fc967314` |
| 18.18.0 | `0adae2a341a1e6840b00c96ce0b1c9d2e0257b1ea6782e4302e17b717a6ffb0a` |
| 18.18.1 | `ce80099f10c5ea4367523767230cb5b920f30cc139b9cf8758c1cc4b2f1f9409` |
| 18.18.3 | `87e8e593046dfb1047e359ad845648ffc8bda91aa59a9785690d5107f562c32d` |

### GitHub 安装验证边界

- 18.13.3 在隔离环境中执行 `plugin install --dry-run github:yuanjun5681/clawsynapse-omp`，返回预期安装目标；仅证明语法接受，不证明真实安装成功。
- 18.18.3 实际安装该仓库时，Bun 请求 `https://codeload.github.com/yuanjun5681/clawsynapse-omp/legacy.tar.gz/` 返回 404。
- 随后 GitHub API 显示仓库公开、size 为 0；`git ls-remote https://github.com/yuanjun5681/clawsynapse-omp.git` 成功但没有任何引用。因此当前阻碍是仓库尚无可下载的分支，不是宿主版本。
- 本轮运行验证使用本地当前源码与现有锁定依赖，通过 `--extension` 加载。必须在代码推送后另做一次真实 GitHub 安装验证，不能把本地加载或 dry-run 称为分发验收通过。

## 一手来源

- [GitHub 安装语法引入提交](https://github.com/can1357/oh-my-pi/commit/22e564a85d4f00813cccd5260aad1cd068e6227d)。
- [17.1.0 扩展类型声明](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.1.0/dist/types/extensibility/extensions/types.d.ts)及 [changelog](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.1.0/CHANGELOG.md)：托管定时器。
- [17.3.1 扩展类型声明](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.3.1/dist/types/extensibility/extensions/types.d.ts)及 [changelog](https://unpkg.com/@oh-my-pi/pi-coding-agent@17.3.1/CHANGELOG.md)：运行模式上下文。
- [18.2.9 TUI 声明](https://unpkg.com/@oh-my-pi/pi-tui@18.2.9/dist/types/tui.d.ts)与 [18.2.10 TUI 声明](https://unpkg.com/@oh-my-pi/pi-tui@18.2.10/dist/types/tui.d.ts)：多监听器边界。
- [18.2.10 扩展 runner](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.2.10/src/extensibility/extensions/runner.ts)：运行期传入实际 SessionManager。
- [内嵌 Bun 安装修复](https://github.com/can1357/oh-my-pi/commit/c8380a85d5e8ffb403340f66d59134712e25564b)及 [18.11.0 changelog](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.11.0/CHANGELOG.md)。
- [18.13.2 会话类型声明](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.13.2/dist/types/session/session-manager.d.ts)与 [18.13.3 会话类型声明](https://unpkg.com/@oh-my-pi/pi-coding-agent@18.13.3/dist/types/session/session-manager.d.ts)：`ensureOnDisk` 公开类型边界。
- 官方二进制：[18.2.10](https://github.com/can1357/oh-my-pi/releases/tag/v18.2.10)、[18.13.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.13.3)、[18.18.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.0)、[18.18.1](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.1)、[18.18.3](https://github.com/can1357/oh-my-pi/releases/tag/v18.18.3)。
