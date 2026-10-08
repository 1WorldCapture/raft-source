# Raft Go Server：独立重建架构与第一期设计

- 日期：2026-10-07
- 参考基线：raft-source / dev / `6a2caa6c268806cb1719ecb36324b5aacf38773d`
- 状态：第一期 SQLite 账号后端已实现并通过后端核对；用户将 Web UI 交由其他协作者处理。本次未进行浏览器 UI 验收。实际交付与限制见 [后端验收交接](backend-handoff.md)。
- 工程位置：仓库根目录 `server-go/`，独立 Go module。

## 1. 已确认的方向与本方案的建议

用户已确认：以现有 TS Server 为 reference，在同一仓库内独立重建 Go Server；不是逐接口混跑迁移。现有 Web、CLI、Daemon 暂时不改。先规划整个系统的职责边界，再从注册登录开始，之后迭代工作空间、频道、Agent 接入和消息投递。

本方案建议：模块化单体；新数据库和新会话；首期验收停在现有 Web 的工作空间选择/创建入口，而不是聊天主界面。允许调整启动环境变量，不修改客户端源码、依赖锁文件、现有服务配置或已有数据。

“首期只做账号入口”是交付顺序，不是删除最终产品功能。“目录骨架已建立”也不代表业务模块已经实现。

## 2. 为什么不能只实现 login/register 两个接口

现有 Web 的页面门禁是：无身份 → 登录/注册；邮箱未验证 → EmailVerificationPage；资料未完成 → AccountIdentitySetupPage；加载工作空间；最后根据 URL 进入 ServerSelector 或 ServerResolver。[R1]

新用户的工作空间列表为空时，ServerSelector 默认进入创建页。它不是聊天页面。[R2] 因此第一期的明确终点是：注册、验证邮箱、补充资料、到达这个真实的账号后页面，刷新仍保持登录，退出后能重新登录。

第一期不创建假工作空间，不谎报 Computer 已连接，不伪造 onboarding 完成来绕过界面。创建工作空间按钮在对应能力实现前应明确报未支持，不能返回假的成功结果。该页面中的可见但后续实现的操作必须列入阶段限制。

`GET /api/servers` 的现有响应是数组本身，不是 `{ servers: [] }`。[R3] 当查询出的真实成员关系为零时返回 `[]` 是正确业务结果；硬编码所有用户永远没有工作空间则不是完整实现。

## 3. 目标架构：模块化单体、少量明确边界

首版部署为一个 Go 进程、一个独立 SQLite 数据文件，使用纯 Go 驱动。首期不需要 PostgreSQL、Redis、分布式锁、消息中间件、服务网格或第二个 TS 后端。SQLite 使用本地磁盘、WAL、外键约束和有界锁等待；并发写入通过短事务串行化。未来是否切换 PostgreSQL 单独评估，不抽象一个无真实需要的通用 ORM。Web 开发仍可使用自己的 Vite/Node 工具链，这不属于 Go Server 的运行依赖。

### 3.1 入口与适配层

- `internal/transport/legacyweb`：现有 Web 的路径、DTO、字段默认值、错误码及 HTTP 行为。此处将内部模型投影为旧客户端期待的形状。
- `internal/transport/agentapi`：未来兼容现有 CLI/Agent API；不要因为只读了 Web 就声明 CLI 已兼容。
- `internal/transport/machinews`：未来兼容 Daemon 的鉴权、握手、心跳、命令和 ACK。
- `internal/transport/socketio`：未来兼容浏览器实时事件、订阅、撤权和恢复。

适配层只处理协议，不拥有用户、消息或投递状态。不要在 Go 内嵌 JS 运行时调用 TS shared，也不要反向调用旧 TS Server 来完成业务。

### 3.2 业务模块与事实归属

**auth**：人类账号、密码凭据、邮箱验证、资料初始化、会话与撤销。首期实现。profile 与 session 先在一个模块内，不拆独立服务。

**workspace**：团队空间、成员关系、角色。对外继续叫 `/api/servers`，内部用 workspace 避免与服务进程混淆。首期只实现真实成员列表读取所需的最小模型；创建与邀请后续实现。

**channel**：公开/私有频道、私信、线程及可见性。拥有频道成员和访问规则；不得在 HTTP、Socket 和历史重放中各写一套不一致的权限判断。

**agent**：作为长期成员的 Agent 身份、所属团队、机器绑定、配置和运行状态。Agent 身份、一次运行和某条 WebSocket 连接必须是不同概念。Go Server 不执行 LLM，不把现有 Daemon 的 Runtime SDK 搬进来。

**message**：消息事实、编辑版本、回复/线程关联、发送幂等键和解析后的 mention 引用。消息记录不是投递队列。

**delivery**：投递策略、收件人快照、每个 Agent 的投递记录、ACK、重试、游标和去重。它使用 Agent 连接能力，但不负责登录、任务业务、模型配置或 UI 房间管理。

**task / workflow**：任务事实与工作流状态。通过明确用例调用消息/Agent 能力，不把工作流步骤绑定到某个 SDK 的普通 sub-agent。

**integration / storage**：后续外部系统适配、附件与资源存储。需要时再落地，首期不导入这些生态依赖。

模块间优先使用普通 Go 调用。接口在需要隔离数据库、时钟、邮件、传输或测试替身时定义，不为每个结构生成一组无意义接口。禁止业务模块直接改写另一模块拥有的表；跨模块原子操作由应用用例显式组织同一事务。

### 3.3 组合与基础设施

`internal/app` 只组装服务、路由和生命周期；`internal/platform` 承担配置、数据库、时钟、日志、邮件等基础能力。没有全局 service locator，没有可以处理所有业务的中央 Orchestrator。

请求带 context、超时和请求 ID；响应映射与错误分类集中在协议层；日志默认不记录请求正文、密码、token 或邮件验证链接。授权检查失败不能降级为允许。

现在定义未来模块职责，不现在创建十几张未来表或实现通用插件/事件平台。Go 包随首个真实用例建立，避免 import cycle 和空架构。

## 4. 在首期预留消息/@/投递的正确边界

本节是新架构约束，不是对当前 TS 每一条消息路径的逐行复刻。

1. 人类、Agent、Machine 都有不同的 principal 类型；Machine 的连接身份不等于其上所有 Agent 的业务权限。
2. 用户可见的 @handle 与稳定 ID 分离。profile 完成时建立稳定身份；以后修改展示名不会改变历史发送者或 mention 指向。
3. 提及文本先按协议和频道权限解析，落为明确的对象引用。`@某个名字` 不自动意味着有权唤醒任意 Agent；批量 mention 和任务关注者由投递策略决定。
4. 消息持久化成功后才发布。未来把消息事实、必要的收件事实/投递意图写入同一事务；不采用先 emit 再补写数据库的路径。
5. 消息编号和投递编号分开。全局 seq 不能直接视为任一频道或 Agent 的连续游标；数据库 sequence 的分配顺序也不能未经验证就当作事务提交顺序。恢复协议必须有明确的扫描/覆盖语义，不凭“看到较大 seq”证明中间事实全已提交。
6. 投递至少一次，按稳定 delivery ID 去重。区分已持久化、已发送、Daemon 已接收、已交给 Agent 输入通道、Agent 完成任务；不能把 WebSocket write 成功当作 Agent 消费成功。
7. 内存队列只用于加速。进程重启后，未 ACK 投递能从持久化状态恢复；在线状态不等于有权删掉队列。
8. 接入 Agent/Daemon 时再实现连接 generation，防止旧连接的迟到 ACK/断线事件覆盖新连接；首期 auth 不需要先实现分布式 ownership 系统。

这些边界使频道和 Agent 接入可以分支迭代，最后由消息投递用例合流，而无需后来拆一个万能类。

## 5. 第一期开哪些能力

### M0：工程入口

独立 module、启动入口、受控监听、健康与就绪检查、优雅退出、最小测试。当前已落下这个小骨架，尚无数据库或 auth 实现。`/healthz` 只证明进程可响应；`/readyz` 当前固定 503，不能拿 liveness 作为账号能力验收。

### M1A：现有 Web 的真实账号闭环

必须实现的协议包括：

- `GET /api/auth/providers`：真实返回当前启用的第三方登录配置；首期可为 `{ "providers": [] }`，不承诺 OAuth。
- `POST /api/auth/register`：接收现有邮箱/密码与条款接受字段，校验、持久化用户和接受版本，签发受限的新会话；响应 `{ user, accessToken, refreshToken }`。
- `POST /api/auth/login`：相同响应；错误密码/未知账户不能被映射为服务端 500。
- `POST /api/auth/verify-email` 与 `POST /api/auth/resend-verification`：使用真实一次性验证链接；验证完成后 `/auth/me` 体现变化。
- `GET /api/auth/me`：返回 User 本身，不再嵌套 `{ user }`。
- `GET /api/auth/me/username-available?name=...`：资料页的用户名可用性检查，只是建议性预检；并发唯一性仍由提交时保证。
- `POST /api/auth/me/complete-profile`：提交 name/displayName，完成账号资料；返回 User 本身。
- `POST /api/auth/refresh`：响应 `{ accessToken, refreshToken }`；必须兼容现有客户端的并发与失败恢复行为。
- `POST /api/auth/logout`：撤销对应会话；不只删除浏览器 token。
- `GET /api/servers`：执行当前用户的真实成员列表查询。新数据库中没有工作空间时为 `[]`。

UserDTO 的最小要求不是只给 id/email：需要兼容当前 `User` 类型与页面实际读取，包括 `name`、`displayName`、`emailVerified`、`profileSetupCompletedAt`、`profileSetupSuggestedHandle`、`avatarUrl`、`gravatarHash` 和语言/时区/偏好字段。必需的可空字段给 `null`，布尔字段给确定默认值；不要以省略所有字段绕开 UI 门禁。[R4]

注册后使用内部未完成资料状态，通过适配器投影为客户端认识的 pending handle + null completion stamp；用户真实完成后才变更。现有用户名校验与保留名字需提取为契约测试，不能采用另一套不一致规则。[R5]

HTTP 状态、错误 `code`、错误体、日期精度和数组形状按当前消费方建立 fixture；不要求 Go 内部字段名、表结构和 TS 一致。[R4-R6]

### M1B：完善账号入口的可见操作

密码找回与重置、头像上传、必要的 `PATCH /auth/me` 偏好、时区观测为同一期的后续子任务。第一轮浏览器验收可使用默认头像，但必须注明头像自定义尚未验收，不能说“整个资料页所有操作已支持”。找回密码入口在未实现前明确返回未支持，完整账号阶段发布前做通。

现有可选时区观测会根据服务端字段判断是否支持；可以暂不声明该可选能力，或实现真实记录，不能假返回成功。[R4]

第三方 OAuth、设备授权、组织邀请、计费、全套设置不属于本期。只对明确且语义正确的可选读取返回空集合；未知接口返回明确未支持/未找到，业务写操作不设“通用 200”兜底。

### 浏览器验收的准确终点

在独立 origin 与全新 browser context 中：注册 → 本地测试邮箱收信 → 打开同一 Go Web origin 的验证链接 → 填用户名和显示名 → 工作空间创建/选择页 → 刷新保留会话 → 退出 → 重新登录。

该终点表示账号入口已经真实跑通，不表示已经进入聊天系统。创建并进入工作空间属于 M2；若要把聊天壳层提前作为 M1 验收，就必须同时增加 workspace 创建、setup projection 和壳层实际使用的数据接口，不能靠一个空 `/channels` 响应宣称完成。

## 6. 账号内部模型与安全设计

### 最小数据模型

建议首期建：`users`（稳定 ID、邮箱、handle、展示名与资料状态）、`password_credentials`（算法参数和 hash）、`sessions`（family/状态/expiry）、`refresh_tokens`（hash、轮换链）、`account_tokens`（验证/重置的一次性 hash）、`legal_acceptances`。再建最小 `workspaces` / `workspace_memberships`，使 `/servers` 能执行真实授权查询。

可将凭据/会话的某些表合并以减少实现量，表数量不是架构目标。必须保证的事实是邮箱/handle 唯一、可撤销会话、一次性凭据和可审计的接受版本。

独立数据库从新 migration 开始；不复刻旧 migration 历史，不修改旧数据库。未来历史导入作为单独项目，当前不实现双写同步。

### 密码与会话

- 密码采用 Argon2id 和随机 salt，存参数化 hash；具体成本在目标机器测量并满足 OWASP 下限，不自创密码加密。[W1]
- 新 Server 使用独立 JWT 签名密钥、issuer 和 audience。access token 保持 JWT 形状、sub/type/exp 等客户端需要的字段，不换成 opaque access token，因为客户端代码会解析部分 claim。[R7]
- refresh token 使用安全随机值，持久化查验使用 hash。access token 短时有效，服务端继续核验账号和会话状态；logout/reset 后旧会话失效。
- 轮换在数据库事务内完成；并发 refresh 不得生成两条相互不知情的有效链。使用短期、受限的同一 successor 重放窗口应明确承认安全/可用性权衡，不能把所有旧 token 永久接受。[W2]
- 当前 Web 发送刷新 attempt header，并有跨标签页恢复协调；不能要求它新增一个必填 header。仅有未绑定的 request ID 也不是强身份凭证。[R8]
- 同一旧 refresh 在极短窗口内重试如需返回同一 successor，使用受保护的限时加密 receipt，并与 family 撤销状态联动；其他长期凭据只存 hash。窗口外检测到重用须有撤销策略和测试。精确窗口在契约测试与威胁评估后固定，不能靠“先给一个永不过期 token”省事。
- 单用户互斥/数据库唯一约束解决竞争；每次注册、资料完成、验证 token 消费均有事务与并发测试。密码哈希计算不长时间占用数据库事务/连接。

### 邮件与开发安全

开发默认使用私有本地 outbox 保存验证与重置邮件，不真实发往外部，不在普通日志输出链接或 token。开发读取入口必须限制在本地且拒绝跨站来源；SMTP/Mailpit 是可选配置而非启动依赖。Mailpit 提供 SMTP 和 Web 收件箱，可用于额外 SMTP 验收。[W3] 所有开发端口绑定 loopback；验证链接 origin 来自显式配置，不从任意 Host 头拼接。

没有默认管理员/共享密码，没有生产可启用的自动验邮箱开关。不要把 token 或验证链接写进通用日志。SMTP 失败不能导致账号状态不可解释：账号保留未验证、允许限流重发；简单的持久邮件作业或可重试发送状态按需实现，不先建设通用消息平台。

邮箱/密码输入尺寸上限、限流、JSON body 上限、TLS 部署、错误脱敏及 reset 非枚举响应都属于账号阶段，不以“只是 demo”略过。固定窗口/IP 限流和用户级限制从单实例起步；多实例时再替换实现，不预先依赖 Redis。

本方案沿用旧 Web 的 token 携带方式以满足零源码改动，不把浏览器 localStorage 当作安全最优方案；未来 cookie/BFF 方案必须作为客户端兼容变更另行评审。

## 7. 客户端零源码改动的本地运行方式

现有 Vite 已通过 `SLOCK_SERVER_PORT` 设置本地代理，通过 `VITE_DEV_PORT` 设置 Web 端口；`/api`、`/internal`、`/socket.io`、`/daemon` 均已有代理。[R9]

建议为新环境分配 Go 4301、Web 5175、独立 SQLite 数据目录与密钥文件；不需要数据库端口或容器。端口需启动前检查占用，不杀旧服务。Web 协作者可参考的联调命令（账号后端已实现；本轮不启动或修改 Web）：

```sh
# 从 raft-source 根目录；显式清空远程代理与编译期 API origin。
SLOCK_SERVER_PORT=4301 SLOCK_WEB_PROXY_TARGET= VITE_DEV_PORT=5175 VITE_API_URL= \
  pnpm --dir packages/web exec vite --host 127.0.0.1 --port 5175 --strictPort
```

检查最终 resolved config 与浏览器请求 origin，避免旧 `.env`、自动登录、Service Worker、IndexedDB 或本地缓存将测试导向 TS/生产。使用新的测试 context；不要清空用户正常使用的浏览器数据。邮件链接必须指回 5175 的前端 origin，而不是 4301 API 端口或旧环境。

不通过旧 `raftdev` 启动新后端，不修改旧 `.env`，不借旧会话完成登录。CLI/Daemon 只承诺源码不改，当前阶段不宣称它们已能接新 Server；相应协议在 Agent 阶段验收。

## 8. 后续阶段与并行关系

**M2 / workspace**：创建空间与 owner 成员关系、真实列表与基本设置。进入空间的 UI 还存在 server setup gate；需要检查完整 `setup-projection` 消费并设计无 Computer 时的真实状态，不能直接返回“setup complete”。[R10]

**M3A / channel**：公开/私有频道、成员与基础读写权限。先做列表/创建再做线程和 DM，避免一开始纳入 Joint Channel 的全部历史行为。

**M3B / agent**：Agent 身份创建、现有 Daemon 的凭据/注册/连接/心跳、基本在线状态。可与频道工作并行，因为身份接入不是消息消费。若现有 Web 的 agent 入口要求频道或 Computer onboarding，则该切片的 API/Daemon 验收先行，UI 验收随壳层能力完成。

**M4 / message**：人类发消息、持久历史、客户端实时显示、断线补同步。到此才正式接入 Socket.IO；不能用普通 WebSocket 假替代，因为现有 Socket.IO 客户端需要自己的协议。[W4]

**M5 / mention & delivery**：显式 @Agent、解析与权限、持久投递、Daemon ACK、Agent 回复、离线恢复与去重。这时把 M3A/M3B 合流。

**M6 / collaboration**：任务、工作流、附件、外部集成、搜索及更丰富的成员/频道模型，按产品优先级逐项恢复。

该排序不是强制先 channel 后 agent：M2 的身份/团队范围是共同基础，M3A 与 M3B 可交换/并行；消息投递依赖两者。不得等全部 Go 功能写完再第一次连接原客户端。

## 9. 工程组织与工具

规划路径（只有已经需要的包才创建 Go 文件）：

- `cmd/raft-server/`：进程入口。
- `internal/app/`：装配、生命周期。
- `internal/auth/`：首期账户用例与持久化。
- `internal/workspace/`：首期成员列表，后续空间管理。
- `internal/channel/`、`internal/agent/`、`internal/message/`、`internal/delivery/`：后续真实切片。
- `internal/transport/legacyweb/`：兼容旧 Web；后续另外三种协议适配器。
- `internal/platform/`：数据库、配置、时钟、邮件、日志。
- `migrations/`：新数据库唯一 migration 链。
- `contracts/legacyweb/`：消费方 DTO、错误、fixtures 和来源清单。
- `tests/integration/` 与 `tests/e2e/`：真实数据库与原 Web。
- `dev/`：隔离 Compose/启动配置；`docs/`：本设计与验收记录。

优先标准库 HTTP、slog、context；本期按用户决定采用 database/sql + 纯 Go SQLite 驱动，迁移 SQL 随二进制嵌入。保持一条新 schema 演进链，不依赖旧 Drizzle、不引入 pgx 或复制两份 schema。W5 为最初 PostgreSQL 方案的背景资料，不是本期依赖。

本机可用 Go 1.25.5，当前无外部依赖骨架使用 1.25 语言基线以便验证。它不是生产版本承诺；账号阶段开始前，应在 CI/容器锁定受支持的 Go toolchain（本次官方发布历史已列出 Go 1.27），并测试依赖，而不修改用户全局 Go 安装。[W6]

## 10. 首期工作拆分与验收责任

P0：独立 Go 入口、隔离配置、真实数据库 migrations、基础错误与日志。工程负责人验收可启动/退出、数据库隔离、就绪检查不撒谎。

P1：现有 Web 账号 contract + fixture；测试负责人逐个记录请求、响应、错误及页面状态。fixture 不含生产 token/邮箱。

P2：注册、密码登录、UserDTO、JWT、会话轮换和撤销；后端负责人交付，安全审核覆盖未验证/撤销/重用/竞争条件。

P3：真实测试邮件、邮箱验证、用户名校验与资料完成、真实空工作空间列表；浏览器验收人员使用原页面跑通 M1A。

P4：找回密码、头像及必要偏好，补齐 M1B；重复执行冷启动、退出、密码重置和两标签页 refresh 场景。

P5：冻结首期可用能力清单，验证旧服务与客户端没有被修改，保留可复现启动与测试记录，然后进入 M2。

不硬排工期；每项检查需由明确的人或 Agent 承担，不能只有“全部通过”而没有执行者和证据。

### 必须覆盖的负向用例

重复邮箱/handle；错误密码；撤销会话；验证链接过期/重复/错误用途；未验证或资料未完成时访问空间；refresh 并发/丢响应/旧 token 重用；资料校验竞争；SMTP 失败可重试；进程重启后会话与账号仍存在；另一个用户不能读取他人的工作空间。

### 浏览器与协议门槛

浏览器门槛由 Web UI 协作者负责，可参考 `server-go/tests/e2e`，但这些文件的历史结果不作为本轮后端通过证据。应使用真实 Go + 临时 SQLite + 私有开发收件箱，不能偷偷指向旧 TS Server。可选遥测与阻塞请求分别判定，不允许以未知请求全部回 200 掩盖缺失功能。后端独立门槛是 `make check`，通过 `tests/acceptance/run.mjs` 测试真实进程和 HTTP，不依赖浏览器。

## 11. 本轮产物与尚未完成

已完成：独立 Go module、SQLite 与两条嵌入 migration、密码哈希、JWT/session family、注册登录、邮箱验证/重发、资料完成、偏好和头像、密码找回/重置、刷新和退出、真实最小 workspace 列表、本地 outbox/CLI，以及后端核对与回归测试。进程重启、撤销持久化、密钥损坏、并发邮件限流、事务回滚和请求取消均有执行式测试。

未完成且不冒充完成：Web UI 验收、workspace 创建、Channel、Agent/Daemon、实时消息、@与投递、外部 SMTP 和生产部署验收。旧 Server、Web、CLI、Daemon 本轮不修改。下一期建议 workspace 创建/成员基础，然后推进 Channel 和 Agent 接入。具体测试结果见 `backend-handoff.md`。

## 12. 源码与外部依据

本地源码行号针对上述基线；属于 DevSpace 实际读取，不是根据公开仓库镜像推断：

- [R1] `packages/web/src/App.tsx:1050-1205`：账号/邮箱/资料/空间页面门禁。
- [R2] `packages/web/src/components/auth/ServerSelector.tsx:24-32`；`App.tsx:684-780`：无空间进入创建/选择页。
- [R3] `packages/web/src/store/serverStore.ts:365-412`：GET servers 消费数组；无 current 时成员/sidebar loader 不操作。
- [R4] `packages/web/src/store/authStore.ts:65-159,251-340,563-606`：User、认证/资料/邮箱请求。
- [R5] `packages/server/src/routes/auth.ts:1225-1300`：资料完成与用户名预检。
- [R6] `packages/server/src/routes/auth.ts:553-644,1097-1188`：注册/登录/refresh/me 与 providers 响应。
- [R7] `packages/web/src/utils/socketReconnectAuthRefresh.ts:99-108`；`hostAccessTokenSync.ts:133-138`：读取 JWT claim。
- [R8] `packages/web/src/utils/refreshCoordinator.ts:244-307,387-390`；`packages/server/src/routes/auth.ts:1128-1173`：现有 refresh 契约与 header。
- [R9] `packages/web/scripts/webProxyTarget.ts:1-46`；`packages/web/vite.config.ts:15-23,154-214`：不改源码的本地代理能力。
- [R10] `packages/web/src/components/onboarding/serverSetupProjection.ts:77-110`；`App.tsx:610-680`：工作空间 setup 门禁。

外部原始资料：

- [W1] OWASP Password Storage Cheat Sheet：https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- [W2] RFC 9700 §4.14：https://www.rfc-editor.org/rfc/rfc9700.html#section-4.14
- [W3] Mailpit 官方安装与配置：https://mailpit.axllent.org/docs/install/ 、https://mailpit.axllent.org/docs/configuration/
- [W4] Socket.IO 官方 Introduction（不是普通 WebSocket）：https://socket.io/docs/v4/
- [W5] sqlc/pgx 官方指南：https://docs.sqlc.dev/en/latest/guides/using-go-and-pgx.html
- [W6] Go 官方发布历史与支持策略：https://go.dev/doc/devel/release

安全材料是选型依据，不是安全认证或完整生产验收；已实现和实测的具体措施以代码及 `backend-handoff.md` 为准，未来架构与阶段仍是规划。
