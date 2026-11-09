# ClawSynapse omp

在 omp 中接收 ClawSynapse 新请求提示，并通过 `/clawsynapse` 浏览本机的 Bot 会话历史。

插件只读查看请求和历史，不会代替 Bot 回复、执行历史中的工具或修改对话内容。查看新请求时，会在插件自己的状态目录中记录已查看状态。

## 安装

使用前请准备好：

- 已安装的 omp，建议使用 **18.13.3 或更新版本**。
- 已安装的 Git，用于从 GitHub 下载插件。
- 已安装的 ClawSynapse；接收新请求提示需要本机 daemon 正在运行。
- 对 ClawSynapse 本地数据目录的读取权限。

从公开 GitHub 仓库安装：

```sh
omp plugin install github:yuanjun5681/clawsynapse-omp
```

插件通过 [GitHub 仓库](https://github.com/yuanjun5681/clawsynapse-omp)分发，不需要从 npm 安装。

安装后重启 omp，输入 `/clawsynapse` 即可使用，**不需要创建插件配置文件或填写 Bot ID**。插件不会替你安装或启动 ClawSynapse daemon。

**最低支持基线为 omp 18.13.3**：该版本所需公开扩展接口齐全，并已通过通知、历史浏览及已查看确认的实测，不要求安装最新版本。更早的 18.2.10 虽已通过基本功能实测，但依赖当时尚未公开的会话接口，不作为推荐安装环境。旧宿主缺少功能时，插件会尽可能安全降级；能安装不代表功能完整。

## 自动连接与 Bot 同步

默认连接 `http://127.0.0.1:18080`，从 `~/.clawsynapse/bots.json` 引用 ClawSynapse 已注册的全部本地 Bot，并从 `~/.clawsynapse/bots/` 读取它们的历史。不复制或另外维护一份 Bot 列表，也不读取身份私钥或自动复制 token。

- 新增或移除 Bot 后，通知范围会在后续轮询中自动同步，不需要重启 omp；历史列表按 `r` 刷新。
- 新发现的 Bot 从当前收件进度开始观察。其他 Bot 已有的游标和未查看请求不会因列表变化重置。
- 移出的 Bot 不再显示，但插件保留它已有的观察状态；重新注册同一 Bot 后继续使用。未注册的遗留目录不会自动纳入范围。
- daemon 未启动时显示离线，启动后自动重连；没有 Bot 时显示等待提示，不会自动创建或启动 Bot。已有本地历史不依赖 daemon 在线。

插件状态保存在 `~/.omp/clawsynapse`，不写入 ClawSynapse 的配置或历史。可选配置文件仍为 `~/.omp/clawsynapse.json`。旧版状态不会自动迁移；如需继续使用旧状态，可通过 `stateDir` 显式指定原目录。

## 可选配置

只有使用非默认端口、数据目录，或只想查看指定 Bot 时，才需要创建 `~/.omp/clawsynapse.json`。所有字段均可省略，省略项使用默认值。例如：

```json
{
  "endpoint": "http://127.0.0.1:19090",
  "dataDir": "/srv/clawsynapse"
}
```

| 字段 | 说明 |
| --- | --- |
| `endpoint` | 本机 daemon 地址，默认 `http://127.0.0.1:18080`。仅接受明确的回环 IP，不接受 `localhost` 或远程地址。 |
| `dataDir` | ClawSynapse 的实际本地数据目录，默认 `~/.clawsynapse`。 |
| `stateDir` | 插件专用状态目录，默认 `~/.omp/clawsynapse`，不能与 `dataDir` 相同或互相包含。 |
| `botIds` | 可选的完整本地 Bot ID 列表。**不填写时自动同步本地注册列表**；填写后仅查看这些 Bot，不再自动扩展范围。 |
| `pollIntervalMs` | 检查新请求和 Bot 变化的间隔，单位为毫秒，默认 `1000`。 |
| `tokenFiles` | 可选的按完整 Bot ID 索引的私有 token 文件路径对象。默认使用 daemon 的本机无 token 读取模式。 |

目录路径可使用绝对路径或 `~/` 开头的路径。插件与 daemon 必须能通过同一回环网络访问；在容器中运行时尤其需要注意。自定义 `endpoint` 时，也需确认 `dataDir` 属于同一部署。

已有旧版插件配置时，移除 `botIds` 即可启用自动同步。自动范围和手动指定范围各自保存观察状态，切换模式不会复制或清空旧模式的数据。

### 可选的 scoped token

如需使用 Bot 的 scoped token，可增加 `tokenFiles` 字段，例如：

```json
"tokenFiles": {
  "n1-00000000000000000000000000000001": "~/.clawsynapse-tokens/my-bot.token"
}
```

示例 ID 和路径必须换成实际值；显式设置 `botIds` 时，token 对应的 Bot 必须在其中。文件须为当前用户拥有的私有常规文件，不能是符号链接。不要在配置中填写 token 明文。

### 项目专属配置

可在启动 omp 的项目目录中创建 `.omp/clawsynapse.json`，格式相同。项目配置会**整份替代**用户配置，不合并 Bot、token 或其他字段；省略项使用默认值，而不是继承用户配置。项目文件损坏或无法读取时会直接报错，不会悄悄切换连接。

修改可选配置后重启 omp。两处配置都不存在时，直接使用默认连接和自动发现。

## 使用

在 omp 的交互界面中输入：

```text
/clawsynapse
```

打开所配置 Bot 的本地会话总览，选择会话后连续阅读对话。也可以指定会话 ID 或前缀：

```text
/clawsynapse <session-id 或前缀>
```

匹配多个会话时，会显示选择列表。没有标题的会话会显示创建时间（UTC）和首条用户请求摘要。

### 快捷键

| 位置 | 按键 | 操作 |
| --- | --- | --- |
| 列表 | ↑ / ↓ | 选择条目 |
| 列表 | Enter | 打开所选条目 |
| 列表 | r | 刷新 |
| 列表 | n | 查看新请求 |
| 对话 | PgUp / PgDn | 翻页 |
| 对话 | ← / → | 跳转消息 |
| 对话 | Enter | 展开或折叠工具参数、结果和已保存的思考内容 |
| 对话 | b | 选择对话分支 |
| 对话 | a | 查看子 Agent |
| 对话 | i | 查看 Bot、会话 ID 和本地文件路径等信息 |
| 面板 | Backspace | 返回上一级并保留原位置 |
| 面板 | Esc | 关闭面板，不中止当前任务 |

### 新请求提示

omp 状态栏中的 `ClawSynapse` 会提示新请求。来源优先显示本地别名，其次显示对端名称；无法获取名称时显示完整 Bot ID。

- 首次启用只从当前进度开始观察，不会把已有的旧请求全部算作新请求。
- 恢复同一个 omp 会话时，会继续补读；新建会话不会继承旧会话的通知范围。
- 只浏览会话总览或对话不会清除新请求。需要按 `n` 打开请求列表，实际显示到屏幕上的请求才会标记为已查看。
- 未翻到的请求和同时到达的新请求仍保留未查看状态。保存已查看状态失败时，修复错误后按 `r` 重试。

**已查看不代表已执行，也不代表 Bot 已完成任务。**

## 更新与卸载

当前版本 **0.1.1**：适配原生主题输入 `instruction/publicContext/requiredContext`，修复标题与用户正文直接显示 JSON，并通过持久化收执关联主题请求历史。

更新已安装的 GitHub 版本：

```sh
omp plugin upgrade clawsynapse-omp
```

更新后重启 omp。

卸载插件：

```sh
omp plugin uninstall clawsynapse-omp
```

卸载后重启 omp。以上命令使用插件包名 `clawsynapse-omp`，不是 GitHub 仓库路径。

## 常见问题

### 无法连接 daemon

确认 daemon 已启动，`endpoint` 的 IP 和端口正确，且插件与 daemon 在同一回环网络中。插件不使用环境代理，也不会跟随重定向。

### 配置或权限错误

确认配置是合法 JSON，Bot ID 完整且属于该 daemon，目录路径正确。配置文件不能是符号链接。

如果 `stateDir` 已存在，必须由当前用户拥有且权限为 `0700`；已有状态数据库必须为 `0600`。插件不会自动放宽或修正不安全的权限。不要把 ClawSynapse 数据目录或主目录直接用作 `stateDir`。

### 能看历史，但没有新请求提示

新请求提示只在 omp 交互界面启用。使用 `--no-session` 时仍可浏览历史，但不观察新请求；print/RPC 模式也不会启动通知观察。

如果 omp 缺少所需的会话保存或定时功能，通知观察会被禁用并显示原因。如果缺少确认屏幕显示的能力，请求列表会降为只读，不会自动清除未查看状态。

### 找不到历史或内容不完整

插件只查看本地已注册 Bot（或可选配置指定 Bot）的 ClawSynapse 专用 omp 历史，包括旧绑定下的历史，不列出普通 omp 会话。请检查 ClawSynapse 数据目录和注册列表；仅在自定义部署或指定范围时检查 `dataDir`、`botIds`。注册列表损坏、缺失但仍有 Bot 数据，或不支持其版本时，会明确报错，不会通过扫描目录猜测身份。

图片和其他附件只显示是否存在，不展示内容。不支持的历史版本、损坏文件或超过读取上限的数据会明确报错，不会静默跳过后继续标记为已查看。

## 反馈与许可

遇到问题可在 [GitHub Issues](https://github.com/yuanjun5681/clawsynapse-omp/issues) 反馈，请说明 omp 版本、操作系统、操作步骤及错误信息。不要上传 token、私有对话或其他敏感数据。

本插件采用 [MIT 许可证](LICENSE)。
