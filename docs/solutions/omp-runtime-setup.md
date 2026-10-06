# OMP runtime（oh-my-pi）安装与配置

Raft 的 OMP runtime 把 [oh-my-pi](https://github.com/can1357/oh-my-pi)（`omp`）作为本机子进程驱动：daemon 以 `omp --mode rpc` 启动它，通过 stdio NDJSON 通信。omp 的模型、订阅与登录态**直接复用本机 `~/.omp`**——Raft 不管理 omp 的凭据，也不修改它的全局配置。

## 安装 omp

在**运行 agent 的那台电脑**上安装（daemon 所在机器）：

```sh
# macOS / Linux 官方脚本
curl -fsSL https://omp.sh/install | sh
```

或 Homebrew / Bun：

```sh
brew install oh-my-pi          # Homebrew
bun install -g @oh-my-pi/pi-coding-agent   # Bun 全局安装
```

daemon 依次在 `PATH`、`~/.local/bin`、`~/.bun/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 中查找 `omp`。安装完成后用 `omp --version` 确认可执行。

## 登录

OMP runtime 的模型来自本机已登录的服务商。**在 agent 将要运行的那台电脑上**执行：

```sh
omp login <服务商>
```

例如 `omp login cursor`（Cursor 订阅）、`omp login kimi-code`、`omp login zhipu-coding-plan`。可用服务商列表见 `omp login --help`。登录状态存于本机 `~/.omp/`，Raft 只读使用。

登录后，在 Raft 里新建/编辑 agent 选择 OMP runtime 时，「模型」下拉会列出**这台机器已登录服务商的可用模型**（按服务商分组）。没有任何登录时，模型检查会明确提示需要先 `omp login <服务商>`，不会静默给出空列表。

## 支持的版本

- 最低要求 **omp 18.6.0**（daemon 启动前会做版本探测；版本过低时界面提示升级）。
- 实测基线：18.6.1 / 18.6.2。
- RPC 协议：握手后自动协商 v2（大帧分块传输）；仅支持 v1 的旧版本按 1 MiB 物理帧上限运行。

## 模型与推理强度

- 启动参数：daemon 以 `--model <服务商/模型>` 与 `--thinking <档位>` 启动 omp，新建与恢复会话都携带。
- 推理强度档位（低/中/高/超高/最大）映射到 omp 的 `low / medium / high / xhigh / max`；「ultra」映射到 `max`。
- 每个模型支持的档位来自 omp 模型目录的 `thinking.efforts`，界面上只给出该模型实际支持的档位。
- 选错的模型 id（如服务商下架）会让启动快速失败，stderr 中的 omp 原始错误（含 `omp models find` 指引）会透出给操作者。

## 会话与恢复

- 会话文件在 agent 工作区的 `.omp-sessions/` 下（隔离于用户自己的 `~/.omp` 会话）。
- agent 重启（或空闲后再次唤醒并重新拉起进程）时按会话 id `--resume` 恢复；系统提示词与发现隔离在恢复后同样生效。
- 恢复失败（如会话文件损坏）自动降级为新会话，并附诊断说明（带首次退出的 stderr 摘要）。

## 系统提示词与隔离边界

- Raft 的常驻系统提示词以 `--append-system-prompt <文件>` 传入（0600 权限，位于 per-agent 的 CLI transport 目录），**新建与恢复均生效**。采用追加而非整体替换：保留 omp 默认模板的工具使用协议（对工具调用有利），并在追加内容开头声明「Raft 指引优先」。整体替换式 `--system-prompt` 与 `--resume` 组合存在上游问题（恢复后模型视图工具不可用，omp 18.6.1 已复现），故不使用。
- 隔离：每次启动附带 `--config` overlay，禁用**项目级**的上下文文件发现（`AGENTS.md`、`CLAUDE.md`、`GEMINI.md`、`copilot-instructions.md`），避免工作区指令文件叠加在 Raft 指引之下；**用户级**的个人偏好（`~/.omp/agent/` 等）照常加载。会替换系统提示词的发现文件（`SYSTEM.md` 等）被显式 flag 压制。
- 用户自己的 skills、MCP servers、rules 等 discovery 贡献不受影响；认证与订阅在 provider 体系之外，不受影响。
- daemon 不写入用户的 `~/.omp`（只读使用）。

## managed MCP 工具

服务端为 agent 分配的 managed MCP 工具经 omp 的 `set_host_tools` 注册，在会话就绪（首次模型调用）前完成；工具调用由 daemon 转发到服务端 agent API 执行，支持取消（abort 传播到在途请求）。注册失败不会挂死会话，agent 将在无托管工具的状态下运行并附诊断。

## 已知限制（一期）

- **advisor / review 不支持**：omp 的 advisor（看门狗）与 review 相关能力计划二期接入；相关 RPC 帧仅记录日志，不映射为 Raft 事件。
- **订阅合规提示未定**：使用个人订阅跑平台 agent 的合规口径 owner 尚未拍板，产品内暂无相关提示。
- **多服务商模型列表较长**：选择器已按服务商分组；搜索/过滤 combobox 为后续独立小任务。
- **omp 子命令**：daemon 只以 `--mode rpc` 与 `--version` 调用 omp；不要让 omp 进程吃到裸子命令或提示词形态的参数（会被当作一次真实提问，消耗订阅）。
- 模型检查的缓存约 10 分钟；`omp login` 之后最多一个缓存代（或 auth 存储 mtime 变化）即可看到新目录。
