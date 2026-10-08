# Raft Go Server — 账号、工作空间、执行接入与人类聊天后端（M1–M4）

在 `raft-source/server-go/` 中独立重建的 Go Server。旧 TypeScript Server 仅作为协议与行为参考，不参与运行。

**当前工作区已接入 M4 人类聊天、持久历史、Socket.IO、DM/线程、reaction、已读及 human Activity/Inbox。后端收尾与实际验收结果见 [M4 后端交接](docs/phase-4-backend-handoff.md)。UI 由独立协作者验收；在该签收完成前，构建 Stage 保持 `m3`，不把后端测试冒充整体产品发布。** M1–M3 账号、工作空间、Agent/Computer 身份及 Daemon 接入保持兼容；原 `onboarding-setup-v2` 门禁保留。M5 Agent 可靠投递、ACK、任务执行仍未实现，人类消息持久化不代表 Agent 已消费。

- [整体架构与阶段设计](docs/architecture-and-phase-1.md)
- [M1 后端验收记录及联调交接](docs/backend-handoff.md)
- [M2 实施、验收证据、兼容差异及联调交接](docs/phase-2-backend-handoff.md)
- [M2 输入设计（保留原稿）](docs/phase-2-workspaces.md)
- [M3 实施结果、后端验收、升级与 UI 测试交接](docs/phase-3-backend-handoff.md)
- [M3 UI 问题修复与最终集成验证（含0009迁移及部署状态）](docs/m3-ui-fix-closeout.md)
- [M4 后端收尾、验收证据与 UI/发布交接](docs/phase-4-backend-handoff.md)
- [M4 消息与实时通信总体设计（保留输入设计）](docs/phase-4-messaging.md)
- [M4 HTTP / Socket.IO 兼容合同](docs/m4-compatibility-contract.md)
- [M4 人类 Activity / Inbox / 已读状态合同](docs/m4-activity-readstate-contract.md)
- [M4 实施协调、工作包与验收责任](docs/m4-implementation-coordination.md)
- [现有 Web 账号协议参考](contracts/legacyweb/account-entry.md)

## 启动：不需要 PostgreSQL、Redis、Docker 或系统 SQLite

从项目根目录先进入 `server-go`：

```sh
cd /Users/lyon/workspace/raft-source/server-go
# 首次试用使用独立目录；不要未经备份直接升级原 var/。
export RAFT_GO_DATA_DIR="$PWD/var-m4-local"
export RAFT_GO_LISTEN=127.0.0.1:4302  # 独立联调端口，不替换既有 4301 实例
export RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175
go run ./cmd/raft-server
```

`RAFT_GO_WEB_ORIGIN` 请换成 UI 协作者实际使用的前端 origin。它用于生成验证/重置邮件链接、设备授权页面链接及 Agent 控制平面地址，并作为 M4 Socket.IO 的 Origin 允许来源；**不是启动 Web UI 的开关，也不为普通 HTTP API 开启任意跨域访问**。未配置允许来源时，携带 Origin 的浏览器 Socket 握手会被拒绝。同源代理需要转发 `/api`、`/internal`，以及支持 WebSocket upgrade 的 `/daemon` 和 `/socket.io/`。M4 Socket.IO 只承诺 websocket-only，不支持 polling。

默认监听 `127.0.0.1:4301`，数据存入当前工作目录的 `var/`。首次启动自动执行嵌入的 SQLite migration，生成并持久化独立签名密钥。Go 语言基线是 1.26；本次实际测试工具链为 `go1.27.1 darwin/arm64`。

```sh
curl -i http://127.0.0.1:4302/healthz
curl -i http://127.0.0.1:4302/readyz
curl -i http://127.0.0.1:4302/version  # stage=m3（等待独立 UI/发布签收）；核对实际构建
```

`/healthz` 表示进程存活；`/readyz` 检查数据库、migration 和 publication 积压准入，不声称 SMTP 可投递、浏览器已收到消息或 Agent 已消费。

构建后运行不需要 Go、Node 或 C 动态库：

```sh
make build
RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175 ./bin/raft-server
```

`make build` 使用 `CGO_ENABLED=0`。部署后的 Go Server 不需要 Node。测试工具与运行依赖分开：HTTP 验收及 TS 纯投影对照需要 Node；原版 Computer/Daemon 客户端兼容测试还需要仓库已有的 `node_modules/.bin/tsx` 及相应客户端依赖。对照脚本使用内置 `node:module.stripTypeScriptTypes`。竞态检测需要对应平台支持的 race 工具链。

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
| `RAFT_GO_DEVICE_LOGIN_ENABLED` | 启用 | `0` / `false` / `no` / `off` 关闭设备登录及相应新凭据签发表面；既有凭据管理按各路由契约处理 |
| `RAFT_GO_AGENT_BOOTSTRAP_ENABLED` | 关闭 | 仅显式 `true` 启用一次性 Agent bootstrap token 签发与交换 |
| `RAFT_GO_POLICY_ONBOARDING_OPENER_V2` | `0` | `1` 时创建私有 #all 及 owner 私有引导频道；不启用消息投递 |
| `RAFT_GO_POLICY_ONBOARDING_OWNER_WIZARD_V0` | `0` | 旧 wizard 偏好投影开关，不改变新 setup 的 blocksChat |
| `RAFT_GO_POLICY_FEEDBACK_ENABLED` | `0` | M2 无反馈服务，设置为 `1` 会明确拒绝启动 |

上述 policy 仅接受未设置、`0` 或 `1`；其他值明确报错。它们是冻结的本地配置边界，不是云端旗标平台；C0 为全部未配置/false。

签名密钥文件权限为 0600，密钥目录和开发 outbox 目录为 0700（POSIX）。并发首次启动采用完整临时文件的原子、不覆盖发布；已有密钥损坏、长度不合法或指向符号链接时拒绝启动，**不会静默生成新密钥覆盖它**。需要支持 hard link 的本地文件系统；Windows 实际访问控制应按用户 ACL 配置，不能把 POSIX mode 当作 Windows 安全验收。

## 已实现的后端能力

- 邮箱注册与密码登录、真实用户和条款版本接受记录；密码使用 Argon2id，用户、初始 session、验证 token 和接受记录在同一事务提交。
- 邮箱验证、重发验证、用户名可用性检查、完成账号资料；邮箱与 handle 唯一性由数据库约束兜底。
- `/auth/me`、资料/语言/时区偏好、浏览器时区观测、头像上传与读取。头像有格式嗅探、解码、5MB 和尺寸上限，重编码为 PNG。
- 短期 JWT access token、可撤销 session family、refresh 轮换、多标签页宽限期恢复、加密 successor 收据、退出。
- 找回与重置密码、登录后改密；一次性 token 消费和所有 session 撤销在事务内执行。
- 工作空间创建、成员资格列表、详情、账号级排序与版本；创建事务同时保存显式 owner、setup 初始状态、成员偏好、协议审计、#all/#announcement，按 opener 配置创建私有引导频道。
- owner/admin 名称、头像、hideHumansFromMembers 管理；成员目录与邮箱隐私；聚合设置、旧 onboarding 设置及个人偏好写入。
- workspace邀请链接与邮件邀请的创建/列表/撤销、公开预览及登录后接受；次数/过期/邮箱绑定、事务内权限重验与完整成员初始化。Guest邀请仍冻结禁用。此M3补丁追加0009 migration，自动化回归与未部署现场的区别见上述修复交接。
- 完整 setup 投影、start/complete/reset/handoff 命令及首次 handoff/session-family 事实；机器目录来自真实持久数据与当前 WebSocket 连接。官方 Cindy 创建、角色与 setup checkpoint 原子提交；不会声称已发送 briefing。
- 公共/私有频道的创建、列表、详情、成员与角色、加入/退出、归档、删除及系统频道保护；不伪造消息历史、未读或 Socket.IO 事件。
- 外部与托管 Agent 创建、列表/详情/设置、机器分配、头像、官方身份收养；`sk_agent_*` 凭据签发/列表/撤销、一次性 bootstrap 及 CLI 身份、空间与频道成员读取。
- Computer 设备码授权、用户批准/拒绝、一次性会话交换、attach、preflight；legacy machine 注册、编辑、删除和密钥轮换。用户、Computer、machine 与 Agent 凭据不互相冒充。
- 原始 `/daemon/connect` WebSocket、首帧 `machine:context`、ready/心跳、在线目录、替换重连、撤销与停机；真实 `agent:start`/stop/reset/purge 派发，以及托管 Runner 的凭据签发与撤销。
- 创建表单所需的运行时选择、form definition、实时模型目录与 rescan；结果来自该机器的关联回复，离线或不支持时返回明确错误，不伪造模型可用性。

HTTP 形状：注册/登录返回 `{user, accessToken, refreshToken}`；`GET /api/auth/me` 返回 User 本身；`GET /api/servers` 返回数组；forgot/reset 的 `ok` 是 JSON 布尔值。日期输出为 UTC 毫秒 ISO 字符串。详细接口和边界见交接文档。

未验证邮箱与未完成资料会阻止工作空间表面访问。`/:id` 路径还要求匹配的 `X-Server-Id` 及真实 membership；guest 不能访问对应管理表面。注册不自动验证邮箱，无默认管理员或共享密码。

### M4 人类聊天与恢复

M4 追加原 v2/v1 文本写入、`randomId` 幂等、历史/定位/补同步、人类 DM 与 self-DM、线程创建/回复/关注、reaction 聚合及本人 viewer 状态。已读/标未读/read-all、mute/display 偏好和 human Activity/Inbox/Done 均来自持久事实。实时事件通过与业务事务原子提交的 publication outbox 投影；发送、历史、同步和 live 受众复用当前频道权限，私有父频道失权后残留 follow 不授予内容访问。

原版 Socket.IO 客户端协议验收不需要启动浏览器。`message.seq`、聚合版本、Activity 水位和内部 publication ID 互不替代。断线与重启依靠持久读模型恢复，不把网络写成功称为 delivered/consumed。具体支持矩阵、故障窗口和后端测试证据见 M4 交接文档。

## 一致性与故障语义

SQLite 使用经启动验证的 WAL、`synchronous=FULL`、每连接外键、8 个连接和短 IMMEDIATE 写事务。锁等待保留每次操作最多约 10 秒的预算，但原生等待切为 50ms，并在 Go 中响应请求取消；只重试事务取得锁之前或单条 autocommit 操作，不重放事务正文或提交。迁移逐项消费 `foreign_key_check` 结果，失败回滚当前迁移。只面向本地磁盘，不用 NFS/共享网络盘充当多机数据库。

头像先写入私有临时文件并同步落盘，再原子发布完整内容；相同内容并发复用，不覆盖已被引用的文件。数据库失败不返回假成功，也不立即删除可能共享的内容文件；孤儿回收单独安排。

邮件冷却/小时配额与 token 创建同一事务判定；`account_email_requests` 保存不含 token 的发起记录，替换或消费 token 不重置配额。验证邮件为 60 秒冷却、每用户每小时 5 次（含注册发送）；密码找回有每用户每小时 5 次和 HTTP 入口限流。SMTP 失败仍消耗一次尝试配额，允许按限流规则重新请求，不宣称邮件恰好投递一次。再次申请会替换旧链接，使用最新邮件。

数据库读取/鉴权基础设施异常返回 503 `auth_temporarily_unavailable`，与真实失效的 401 区分；数据库查询继承请求取消。请求日志只记录路由模板、状态、耗时和 request ID，不记录原始资源路径、body、Authorization 或查询串。

刷新宽限期外重放会撤销 family，这是有意的安全收紧。资料字段有显式输入限制，未宣称所有旧 TS 边缘行为逐字节等价；目前 `referralSource` 空字符串清空和 `referralSourceOther` 类型拒绝等边缘差异在交接文档记录。

## 测试与核对

```sh
make check         # 格式、vet、普通测试、race、TS 投影对照、HTTP/升级/恢复、构建
make build         # 本机 CGO-free 二进制，输出 bin/raft-server
make cross-build   # Linux/amd64、Windows/amd64 编译验证，不等于运行验证
make vuln          # 联网执行固定版本 govulncheck

go mod verify
go mod tidy -diff  # 只检查依赖整理差异，不改 go.mod/go.sum
```

HTTP runner 在系统临时目录构建并运行新二进制，使用临时 SQLite/独立密钥/outbox。`make check` 运行 M1–M4 全部后端套件，包括 Computer/Daemon/Agent、频道、M4 HTTP 与真实 Socket.IO 客户端恢复；冻结原 TS 合同和实时采集的 Go wire 均参与兼容检查，检查模式不重写 wire 证据。升级矩阵包括真实旧二进制生成的 M2、未打补丁 M3 和邀请修复版 M3 数据，并验证旧程序拒绝新 schema、配套冷备份可恢复。原版 Computer/Daemon 客户端通过直连及隔离的同源代理访问 Go。所有测试只清理自己的进程与临时目录。另有冻结 TS 原函数的纯投影对照，不代表完整 PostgreSQL/TS HTTP 对照。**不启动 Vite、浏览器、旧 TS Server 或真实 LLM，也不修改已有 UI 测试结果。**

## 备份、升级与恢复

本阶段最简单可靠的备份方式是先优雅停机，确认进程已经退出，再私密备份整个 `RAFT_GO_DATA_DIR`。保留数据库、仍存在的 WAL/SHM、密钥和头像；自定义 outbox 或通过环境提供的根密钥要另行保管。不要在服务写入时只复制 `raft.db`。

启动自动执行增量 migration。M2 新增 `0003_workspace_foundation.sql`、`0004_workspace_setup.sql`、`0005_workspace_preferences.sql`，不修改 M1 的 0001/0002。membership 只改变未来 INSERT 的默认角色为 member，已有 owner/co-owner 原样保留；旧 owner setup 不被自动标记 complete。启动会记录缺失 owner 关系或无法解释的 onboarding 指针诊断，不会自动补权限或清空指针。遇到未知 schema version 的旧二进制拒绝启动，不自动降级或清空数据。

M3 仅追加 `0006_channel_core.sql`、`0007_computer_admission.sql`、`0008_agent_identity.sql`，不改写 0001–0005。升级证据同时覆盖隔离的 M1 数据库与真实 M2 二进制生成的数据；没有替用户升级现有 `var/`。升级前完整冷备份，回滚使用旧程序与其匹配的旧数据备份，不把旧程序直接指向已升级数据库。

M4 追加 `0010_messaging_foundation.sql`、`0011_readstate_activity.sql`、`0012_authority_epochs.sql`、`0013_activity_mute_epochs.sql`；不改写 0001–0009，也不自动迁移协作者正在使用的 `var-m3-dev/`。原 M3 邀请修复使用 0009。已有消息为空时保持真实空态，不补假欢迎消息。

密钥损坏时恢复原密钥，而不是删除密钥文件重新启动；否则原 access token 和加密刷新收据无法正常恢复。密钥与数据库必须配套备份，备份本身含账号和凭据材料。

## 交付边界

本次交付的是**同一 Go 进程内的 M1–M4 后端及原客户端协议兼容能力**，不是整套 Raft 上线验收。仅注册实际支持的路由；未知内部路由拒绝访问，未实现的已知产品表面明确返回 404/501。M5 可靠投递/ACK/Agent 任务执行、附件、转发、全文搜索、联合频道和 Office 不因 M4 人类聊天可用而自动启用。UI 签收、Stage 晋级和现有实例部署由相应责任人继续处理。

新空间初始仍是 `surface=computer_runtime`、`phase=not_started`、`blocksChat=true`；随后可以接入真实 Computer、创建 Agent 并提交真实 setup checkpoint。创建身份或派发启动命令不等于 LLM 已成功执行，不把缺失后续请求或前端降级显示当作成功证据。

Web UI、原 CLI、Computer/Daemon 以及旧 TS 服务端源码本轮不修改。UI 端到端测试明确交给测试人员；此外，实际模型供应商、外部 SMTP、Linux/Windows 真机运行、公网 TLS/代理与生产负载未由本轮后端测试替代。
