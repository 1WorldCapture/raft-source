# 第一阶段后端验收与交接

## 结论与范围

**SQLite 账号后端已完成实现、核对、修复与后端测试。Web UI 由其他协作者负责，本轮未启动浏览器/Vite，未修改原 Web、CLI、Daemon 或 TypeScript Server。**

项目位置：`/Users/lyon/workspace/raft-source/server-go`。参考仓库 HEAD：`6a2caa6`。新目录当前尚未 git commit/push；本次没有代用户发布代码。

本阶段包括注册、登录、验证邮箱、资料完成、偏好、头像、密码重置、会话恢复/轮换/撤销和真实最小 workspace 成员查询。创建工作空间、频道、Agent/机器连接、消息/@/投递均明确留给后续阶段。

## 实际执行的检查

环境：Go `go1.27.1 darwin/arm64`，模块语言基线 `go 1.26`，SQLite 使用 pure-Go modernc 驱动。测试数据均在测试自己创建的临时目录，不使用旧服务数据库。

| 检查 | 结果及证据边界 |
|---|---|
| `make check` | 全部通过：gofmt 检查、go vet、普通测试、race、真实 HTTP 黑盒验收 |
| `go test -json -count=1 ./...` | 84 个顶层测试及 11 个子测试 pass，0 fail；5 个包无独立测试，不能宣称它们各自都有完整覆盖 |
| `go test -race -count=1 ./...` | 本机通过；不等于所有可能调度、业务竞态都被证明不存在 |
| `node tests/acceptance/run.mjs` | 10 组账号 HTTP 场景 + 真实进程重启/私有 mailbox/损坏密钥/恢复/正常退出检查全部通过 |
| `go mod verify` | 所有模块通过校验 |
| `go mod tidy -diff` | 无差异，不改 module 文件 |
| `make build` | `CGO_ENABLED=0` 本机二进制构建成功，产物 `bin/raft-server` 已被忽略 |
| `make cross-build` | Linux/amd64 和 Windows/amd64 的 CGO-free 编译通过；没有在这两个系统执行运行测试 |
| `make vuln` | govulncheck v1.8.0：0 可达漏洞、0 已导入包漏洞，1 个模块级非导入包警告，详见下文 |

独立只读代码复核还检查了账号 use case、session、HTTP 映射和旧 TS 协议。复核者自己的运行沙箱不允许绑定端口，因此只完成 auth 测试和 vet；本表的完整 socket/HTTP/race 结果来自主工作区实际执行，未把复核者的环境失败冒充通过。

### 漏洞扫描说明

工具报告 `GO-2026-5932`：`golang.org/x/crypto/openpgp` 不再维护且存在设计安全问题。依赖模块是 `golang.org/x/crypto v0.57.0`，本后端使用其中的密码/派生能力，**没有导入 openpgp**。扫描器没有发现当前导入包或调用路径受到这条记录影响，因此没有为消除未使用包的警告而无依据地替换加密实现。

该结果只描述本次工具与漏洞数据库检查，不是“所有依赖零风险”或生产安全认证。

## 本轮实证修复

以下核心问题均先增加可执行回归测试、观察原实现失败，再修复并通过测试；测试不是 grep 源码或比对函数名称。

### 持久化密钥

原来并发首启可生成不同密钥，损坏文件会被重新生成覆盖，旧文件权限也未收紧。现在使用已写完并同步的临时文件原子、不覆盖发布，所有进程读取同一胜出者；损坏/符号链接/无效长度拒绝启动。32 路并发与多次重复竞态测试通过。密钥和数据库配套保留，不能把删除密钥当作修复。

### 鉴权故障与请求取消

数据库不可用原本会被当成 401，客户端可能无谓刷新/丢弃有效会话。现在临时基础设施失败返回 503 `auth_temporarily_unavailable`，真正删除账号或撤销会话仍然返回 401。读取用户会继承 HTTP context；连接池耗尽时取消请求能退出。资料写入失败也不会误撤销 session。

### 输入、日志和退出

JSON body 必须恰好包含一个文档；尾随第二个文档/垃圾返回 400，超限尾随空白返回 413。日志只记录路由模板，不记录原始路径中的资源/秘密、query、body 或 bearer。响应提供 `X-Request-Id`。清理 worker 的 stop 可重复/并发调用并等待退出，再关闭数据库。

### 邮件配额与令牌

原先冷却检查在事务外，16 路请求可多次绕过；删除旧 token 还会丢失小时配额历史。现在新增 `account_email_requests` 元数据账本，配额检查与新 token 写入在同一 IMMEDIATE 事务。验证邮件 16 路并发只有一次成功；替换令牌后第六次小时内请求仍受限；密码找回并发受每用户五次小时配额约束。

账本记录的是发送尝试，不是 SMTP 成功确认。发信失败不会假称已经实际送达，普通日志也不暴露 token。outbox 的既有目录权限收紧，已取消的发送不写新邮件。

### 原子注册与密码策略

账号、条款接受记录、初始会话、验证 token 和配额记录一起提交。注入 session INSERT 失败后，不留下半注册账号，也不发验证邮件。

注册、重置和登录后改密的服务层统一执行密码长度策略；过长新密码不再被误报为“重置链接失效”，校验失败不消耗有效重置 token。验证 token 在恰好到期时即失效。forgot-password 的 `ok` 修正为布尔 `true`，不再是字符串。

## 启动与 UI 协作者对接

后端终端：

```sh
cd /Users/lyon/workspace/raft-source/server-go
RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175 go run ./cmd/raft-server
```

请把 `5175` 改成实际前端端口。另开终端并在相同 `server-go` 目录读取开发邮件：

```sh
go run ./cmd/raft-server mailbox latest
go run ./cmd/raft-server mailbox -json latest
```

默认 API origin：`http://127.0.0.1:4301`。前端使用自己的同源代理指向 Go，不能为了过页面门禁把请求转回旧 TS。`RAFT_GO_WEB_ORIGIN` 仅用于邮件链接，不启用 CORS，也不提供静态页面；跨 origin 直接请求需要另外评审部署/CORS 配置。

`RAFT_GO_DATA_DIR` 相对进程工作目录，默认 `var/`；从不同目录启动可能得到不同测试数据库。进程不会自动读取 `.env`。

### 关键 HTTP 契约

| 操作 | API | 要点 |
|---|---|---|
| providers | `GET /api/auth/providers` | `{providers: []}`，首期无第三方登录 |
| 注册 / 登录 | `POST /api/auth/register`、`/login` | `{user, accessToken, refreshToken}` |
| 当前用户 | `GET /api/auth/me` | User 本身，不包 `{user:...}` |
| 验证 / 重发 | `POST /api/auth/verify-email`、`/resend-verification` | 验证 body `{token}`；重发需 access bearer |
| 用户名 / 资料 | `GET /api/auth/me/username-available?name=...`、`POST /api/auth/me/complete-profile` | complete body `{name, displayName}`，name 为 handle |
| 偏好 / 头像 | `PATCH /api/auth/me`、`POST /api/auth/me/avatar` | 头像 multipart 字段 `avatar`；不更改账户身份权限字段 |
| 时区 | `POST /api/auth/me/timezone-observation` | body `{timezone}` |
| 刷新 / 退出 | `POST /api/auth/refresh`、`/logout` | body `{refreshToken}`；刷新返回两个 token，退出撤销该 family |
| 找回 / 重置 | `POST /api/auth/forgot-password`、`/reset-password` | `{email}` / `{token,password}`；成功 `{ok:true,...}` |
| 空间列表 | `GET /api/servers` | 数组；无 membership 返回 `[]`，不是错误也不是伪造数据 |

注册需要 `acceptTerms: true`、`termsVersion: "2026-05-12"`、`privacyVersion: "2026-05-12"`；这是现有客户端提交的版本契约，不表示本项目给出法律合规结论。业务 API 使用 `Authorization: Bearer <accessToken>`，令牌不放 URL 或通用日志。

未验证邮箱请求 `/api/servers` → 403；资料未完成 → 403 `PROFILE_SETUP_REQUIRED`；完成后新用户 → 200 `[]`。客户端最后应到真实空间创建/选择入口；**点创建会得到 501，这是 M2 未实现，不是登录失败**。

### 已知差异与尚未验证

保留外部主要账号协议，不声明所有旧边缘行为逐字节一致。已知差异包括刷新宽限外重放撤销 family、持久化故障 503、显式密码/资料/头像输入上限，以及 referral 边缘字段：空 referralSource 被清空、other 描述非字符串被拒绝。这些边缘差异不影响已有正常请求形状，扩展这些页面时可单独决定是否完全对齐。

注册/邮件错误后的网络重试仍应根据响应和登录状态处理；没有跨请求端到端 exactly-once 保证。旧链接会在重发时失效，使用最新邮件。生产外发邮件持久任务队列、完整账号退役/OAuth/邀请、代理后分布式限流不在本期。

## SQLite 数据与升级操作

`0001_init.sql` 建立账号/session/workspace schema；`0002_account_email_requests.sql` 追加独立配额账本并回填当前尚存的 token。migration 不删除旧账号，不新增 PostgreSQL 依赖。已被旧逻辑删除的历史 token 无法恢复为历史配额，此限制在短期窗口内自然结束。

SQLite 要放本地磁盘。备份采用优雅停机、确认进程退出、复制整个数据目录的方式，保留 DB/WAL/SHM、签名密钥、头像；外置 outbox 和环境密钥另行保管。不要在线只复制 `raft.db`。旧二进制遇到新 migration 版本会拒绝启动，不强行降级。

密钥损坏时恢复原始配套密钥；不要删除生成新值来掩盖损坏。新密钥会使旧 token/加密刷新收据不再正常恢复。测试中使用临时目录验证过损坏拒绝及恢复后旧会话仍可访问。

## 下一阶段明确不做的事

本次不改 Web UI，不据历史 `tests/e2e/artifacts` 声称当前浏览器通过；不接入消息、@、Agent delivery；不创建影子 TS 服务、双写或共享旧数据文件；不使用假 HTTP 200 替代未实现的功能。

下一步可在当前基础上增加真实 workspace 创建/成员模型与相关页面前置 API，再逐步增加频道与 Agent 接入。无需再改造本阶段为跨语言迁移平台。
