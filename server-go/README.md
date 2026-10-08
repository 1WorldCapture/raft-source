# Raft Go Server — 第一阶段账号后端

在 `raft-source/server-go/` 中独立重建的 Go Server。旧 TypeScript Server 仅作为协议与行为参考，不参与运行。

**当前交付：SQLite 账号后端和后端测试已完成。Web UI 由其他协作者处理，本次未运行或验收浏览器界面。** Workspace 创建、Channel、Agent/Daemon 接入、消息和 @投递不属于本阶段。

- [整体架构与阶段设计](docs/architecture-and-phase-1.md)
- [后端验收记录及联调交接](docs/backend-handoff.md)
- [现有 Web 账号协议参考](contracts/legacyweb/account-entry.md)

## 启动：不需要 PostgreSQL、Redis、Docker 或系统 SQLite

从项目根目录先进入 `server-go`：

```sh
cd /Users/lyon/workspace/raft-source/server-go
RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175 go run ./cmd/raft-server
```

`RAFT_GO_WEB_ORIGIN` 请换成 UI 协作者实际使用的前端 origin。它用于生成验证/重置邮件链接，**不是启动 Web UI 的开关，也不会配置浏览器 CORS**。后端本身不提供前端页面；联调优先使用前端同源代理。

默认监听 `127.0.0.1:4301`，数据存入当前工作目录的 `var/`。首次启动自动执行嵌入的 SQLite migration，生成并持久化独立签名密钥。Go 语言基线是 1.26；本次实际测试工具链为 `go1.27.1 darwin/arm64`。

```sh
curl -i http://127.0.0.1:4301/healthz
curl -i http://127.0.0.1:4301/readyz
```

`/healthz` 表示进程存活；`/readyz` 检查数据库和 migration，不声称 SMTP 可投递或完整聊天系统已经就绪。

构建后运行不需要 Go、Node 或 C 动态库：

```sh
make build
RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175 ./bin/raft-server
```

`make build` 使用 `CGO_ENABLED=0`。测试工具的依赖与服务端运行依赖分开：HTTP 验收脚本需要 Node，竞态检测需要对应平台支持的 race 工具链。

## 本地开发邮件

默认 `outbox` 模式只把邮件写入私有本地 JSON 文件，不向真实邮箱发送、不在普通日志输出令牌。

```sh
go run ./cmd/raft-server mailbox list
go run ./cmd/raft-server mailbox latest
go run ./cmd/raft-server mailbox -json latest
go run ./cmd/raft-server mailbox show <file>
```

`latest` 和 `show` 是显式读取秘密材料的开发操作，输出含验证/重置链接，不要粘贴进公共日志。JSON 文件包含 `to`、`subject`、`kind`、`token`、`html` 等字段。没有公开的 HTTP 邮箱入口。

SMTP/Mailpit 是可选项，不是启动依赖。远程 SMTP 必须提供 STARTTLS；仅 localhost/loopback 开发收信服务允许明文。实际外部供应商的投递成功率和证书配置仍需部署方单独验收。

## 环境配置

全部使用 `RAFT_GO_` 前缀，**程序不会自动加载 `.env` 文件**；请由 shell 或进程管理器注入。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RAFT_GO_LISTEN` | `127.0.0.1:4301` | IP literal；非 loopback 需显式 `RAFT_GO_ALLOW_NON_LOOPBACK=1` |
| `RAFT_GO_DATA_DIR` | `./var` | SQLite、签名密钥、头像与 outbox 根目录；相对当前工作目录 |
| `RAFT_GO_WEB_ORIGIN` | 未设置 | 验证链接回退固定开发 origin `http://127.0.0.1:4301`，不是请求 Host；联调应显式设置真正前端 origin |
| `RAFT_GO_JWT_SECRET` | 自动生成并保存 | 显式值至少 32 字节；签名与加密收据使用同一根密钥的独立派生用途 |
| `RAFT_GO_MAIL_MODE` | `outbox` | `outbox` 或 `smtp`；仅设置 SMTP_HOST 也会选择 SMTP |
| `RAFT_GO_SMTP_HOST` / `PORT` | 无 / `587` | SMTP 服务；远程必须 STARTTLS |
| `RAFT_GO_SMTP_USERNAME` / `PASSWORD` | 无 | 可选 SMTP AUTH |
| `RAFT_GO_FROM_EMAIL` | `Raft <noreply@raft.build>` | 外部投递时配置为自己可用的发件地址 |
| `RAFT_GO_OUTBOX_DIR` | `DATA_DIR/outbox` | 开发邮件目录 |
| `RAFT_GO_ACCESS_TOKEN_TTL` | `15m` | 访问令牌期限 |
| `RAFT_GO_REFRESH_TTL` | `720h` | 刷新会话期限 |
| `RAFT_GO_REFRESH_REPLAY_GRACE` | `10s` | 同一旧 refresh token 可恢复同一 successor 的宽限期 |
| `RAFT_GO_ARGON2_MEMORY_KIB` / `ITERATIONS` / `PARALLELISM` / `MAX_CONCURRENCY` | `65536 / 3 / 1 / 4` | 密码成本和哈希并发上限；较高参数需要相应内存预算 |

签名密钥文件权限为 0600，密钥目录和开发 outbox 目录为 0700（POSIX）。并发首次启动采用完整临时文件的原子、不覆盖发布；已有密钥损坏、长度不合法或指向符号链接时拒绝启动，**不会静默生成新密钥覆盖它**。需要支持 hard link 的本地文件系统；Windows 实际访问控制应按用户 ACL 配置，不能把 POSIX mode 当作 Windows 安全验收。

## 已实现的后端能力

- 邮箱注册与密码登录、真实用户和条款版本接受记录；密码使用 Argon2id，用户、初始 session、验证 token 和接受记录在同一事务提交。
- 邮箱验证、重发验证、用户名可用性检查、完成账号资料；邮箱与 handle 唯一性由数据库约束兜底。
- `/auth/me`、资料/语言/时区偏好、浏览器时区观测、头像上传与读取。头像有格式嗅探、解码、5MB 和尺寸上限，重编码为 PNG。
- 短期 JWT access token、可撤销 session family、refresh 轮换、多标签页宽限期恢复、加密 successor 收据、退出。
- 找回与重置密码、登录后改密；一次性 token 消费和所有 session 撤销在事务内执行。
- 真实 workspace membership 查询；新用户没有成员关系时返回空数组，不伪造空间。

HTTP 形状：注册/登录返回 `{user, accessToken, refreshToken}`；`GET /api/auth/me` 返回 User 本身；`GET /api/servers` 返回数组；forgot/reset 的 `ok` 是 JSON 布尔值。日期输出为 UTC 毫秒 ISO 字符串。详细接口和边界见交接文档。

未验证邮箱与未完成资料会阻止 workspace 列表访问。注册不自动验证邮箱，无默认管理员或共享密码。

## 一致性与故障语义

SQLite 使用 WAL、`synchronous=FULL`、每连接外键校验、10 秒 busy timeout、8 个连接和短 IMMEDIATE 写事务。只面向本地磁盘；不把 SQLite 文件放到 NFS/共享网络盘上并作为多机数据库使用。

邮件冷却/小时配额与 token 创建同一事务判定；`account_email_requests` 保存不含 token 的发起记录，替换或消费 token 不重置配额。验证邮件为 60 秒冷却、每用户每小时 5 次（含注册发送）；密码找回有每用户每小时 5 次和 HTTP 入口限流。SMTP 失败仍消耗一次尝试配额，允许按限流规则重新请求，不宣称邮件恰好投递一次。再次申请会替换旧链接，使用最新邮件。

数据库读取/鉴权基础设施异常返回 503 `auth_temporarily_unavailable`，与真实失效的 401 区分；数据库查询继承请求取消。请求日志只记录路由模板、状态、耗时和 request ID，不记录原始资源路径、body、Authorization 或查询串。

刷新宽限期外重放会撤销 family，这是有意的安全收紧。资料字段有显式输入限制，未宣称所有旧 TS 边缘行为逐字节等价；目前 `referralSource` 空字符串清空和 `referralSourceOther` 类型拒绝等边缘差异在交接文档记录。

## 测试与核对

```sh
make check         # 格式、vet、普通测试、race、独立 HTTP 黑盒验收
make build         # 本机 CGO-free 二进制，输出 bin/raft-server
make cross-build   # Linux/amd64、Windows/amd64 编译验证，不等于运行验证
make vuln          # 联网执行固定版本 govulncheck

go mod verify
go mod tidy -diff  # 只检查依赖整理差异，不改 go.mod/go.sum
```

HTTP runner 在系统临时目录构建并运行新二进制，使用临时 SQLite/独立密钥/outbox，执行真实进程重启、撤销持久化、密钥损坏后拒绝启动及恢复测试；退出后清理自己的进程和临时文件。**不启动 Vite、浏览器、旧 TS Server，也不修改已有 UI 测试或其结果。**

## 备份、升级与恢复

本阶段最简单可靠的备份方式是先优雅停机，确认进程已经退出，再私密备份整个 `RAFT_GO_DATA_DIR`。保留数据库、仍存在的 WAL/SHM、密钥和头像；自定义 outbox 或通过环境提供的根密钥要另行保管。不要在服务写入时只复制 `raft.db`。

启动自动执行新 migration；本次新增 `0002_account_email_requests.sql`，从现存 account_tokens 回填可用配额信息，无法恢复此前已删除的历史请求。遇到未知 schema version 的旧二进制拒绝启动，不自动降级或清空数据。

密钥损坏时恢复原密钥，而不是删除密钥文件重新启动；否则原 access token 和加密刷新收据无法正常恢复。密钥与数据库必须配套备份，备份本身含账号和凭据材料。

## 交付边界

本阶段完成的是**开发环境可独立运行、经过后端验证的账号 Server**，不是整套 Raft 上线验收。`POST /api/servers`、Socket.IO、`/internal/*` 和 `/daemon/*` 返回显式未实现；未知 `/api/*` 返回 404，不用假 200 掩盖缺失功能。

Web UI、原 CLI、Daemon 以及旧 TS 服务端源码本轮均未修改。浏览器交互、外部 SMTP、Linux/Windows 实际运行、公网 TLS/代理限流与生产负载仍由各自阶段验收。
