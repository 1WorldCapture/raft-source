# Raft Go Server 第二期设计：工作空间与原客户端初始化契约

> 版本：v0.1，待实施设计。  
> 范围：`raft-source/server-go/`；数据库继续使用 SQLite。  
> 源码基线：`c4a5015deb7dcc8b800df96675d899f384f76e36`。本次读取开始时工作区干净。  
> 兼容对象：同一基线的 TS Server、Web、CLI、Daemon。兼容功能与线上实际配置不能根据文件名或旧讨论推断。  
> 状态说明：本文及配套路由清单是设计产物，不是第二期功能已经实现或测试通过的证明。Web UI 实现及浏览器验收仍由协作者负责；本期不得修改客户端来规避后端契约。

## 0. 结论与必须先说清楚的边界

第二期应交付的是：**工作空间真实创建、创建者 owner 成员关系、按成员资格读取及排序、基本资料和设置、以及与 TS 相同的 owner 初始化状态机。**

它不是另做一个 Go 风格的 Workspace API，也不是创建空间以后自动跳过初始化进入聊天页。外部继续使用 `/api/servers`、`X-Server-Id` 和原有 DTO；`workspace` 只是 Go 内部的领域名称。

本次源码核对发现五个决定实现范围的事实：

1. TS 创建空间在一个事务中写入空间、owner、成员协议审计、系统频道，并按功能旗标决定是否创建 owner 私有引导频道。只写空间与成员两张表不等价。[R03]
2. 新 owner 的 setup 契约是 `onboarding-setup-v2`。当前服务端不再接受 `defer`；客户端类型中残留 `defer` 不代表接口仍支持它。[R08][R09]
3. 对新空间 owner，正常初始投影是 `computer_runtime`、`blocksChat: true`。本期尚无 Computer/Agent 接入能力时，不得为展示主界面而伪造 complete；参考已有的授权配置 setter 完成路径另见第9.3节。[R08][R23]
4. `GET /settings` 是带 `settings.onboardSettings` 的聚合读取；修改空间资料用 `PATCH /api/servers/:id`，不是新造一个 `PATCH /settings`。[R02][R07]
5. 现有 Go M1 的列表缺少 `serverOrderVersion`，成员表默认角色为 `owner`。M2 必须补齐前者并修正后者的新增成员默认值，同时保留已有数据。[R01][R04]

**推荐验收终点**：原 Web 完成账号流程后，创建一个真实空间；列表、详情和 owner 关系一致；基本设置通过后端契约验收；选择新空间后得到原初始化界面的真实“连接 Computer”状态，刷新/重启不丢状态。

**不在本期承诺**：新建空间 owner 完整完成 Computer → Cindy → survey → handoff → 正常聊天的全流程。最后这条闭环需要后续 Agent/Computer 及消息能力。若将“新空间创建后直接可聊天”列为本期强制目标，就必须把这些依赖提前实施，而不能放宽旧规则、返回假完成或要求 Web 改门禁。

---

## 1. 固定约束与兼容策略

### 1.1 固定约束

- 只在 `server-go/` 中开发；旧 TS Server 是参考，不参与 Go 服务运行。
- 继续使用 M1 的 SQLite、自动迁移、密码与 session 实现；不重新引入 PostgreSQL、Redis或第二个 TS 后端。
- Web、CLI、Daemon 源码和既有协议不变。测试环境可以改变服务地址和启动配置。
- M1 的已有账号、签名密钥、session、邮箱 token、头像、工作空间及成员数据必须能够升级保留。
- 成功形状、错误状态、错误字段、权限、排序、默认值和真实副作用都属于兼容范围。
- 本期不以增加微服务、通用事件总线、分布式所有权平台或全站 OpenAPI 作为前置条件。

### 1.2 三种状态必须分开记录

| 状态 | 含义 | 对外与验收要求 |
|---|---|---|
| 本期已实现且等价 | 本期能力、配置范围内与 TS 一致 | 执行契约及行为对照测试 |
| 本期尚未实现 | 属于后续能力 | 明确错误，不假 200；不能写成“完全兼容” |
| 经评审的有意差异 | 修复已知缺陷或沿用 M1 安全差异 | 单独列出旧/新行为、影响和批准状态 |

“客户端不变”不等于“第二期已经能够执行所有客户端命令”。例如 CLI 的 `raft server info` 使用 `/internal/agent-api/server`，并非 Web 的 `/api/servers/:id`。[R13]

### 1.3 基准配置与源码版本一并冻结

源码无法证明实际部署启用了哪些 feature flags。必须给契约测试记录配置向量 C，而不是用“默认应该打开”代替查证。

首个本地基准 C0：没有配置的旗标按 TS 的 `missing_flag → enabled:false` 求值；未配置反馈系统时 `feedbackSettings.enabled=false`。单独测试 `onboarding_opener_v2` 开/关两个分支。`onboarding_owner_wizard_v0` 与新 setup projection 不是同一个开关，不能用前者为 false 推导 `blocksChat=false`。[R03][R07][R18]

不实现完整云端旗标管理平台。采用范围明确的本地 policy provider，并冻结本期涉及的键、取值、缺省规则；不向 Web 增加 Go 专用开关。未具备对应能力的配置不能被静默“启用成功”。

---

## 2. 第二期能力范围

### 2.1 必须完成

**空间基础**：创建、列表、详情、owner 成员、成员目录读取、工作空间切换顺序。

**基本设置**：名称、头像、`hideHumansFromMembers`；聚合设置读取；onboarding 设置与个人偏好的兼容读取/写入。设置可以保存，并不表示尚未实现的 Agent 欢迎消息已经执行。

**初始化**：setup 持久状态、projection、start/complete 命令规则、reset、handoff 的持久记录和错误契约；官方 Agent/Computer 事实由独立边界提供。

**必要配套**：系统频道初始化、成员协议审计、侧栏偏好读取、初始化所需的机器目录读取、M1→M2 数据迁移。

### 2.2 只切必要片段，不提前做完整后续领域

系统频道创建属于 TS `createServer` 的既有副作用，所以本期必须有真实频道记录；这不代表本期实现频道 CRUD、聊天、未读或 Agent 投递。

机器目录与 setup facts 需要一个可扩展的真实数据来源。推荐建立最小 Computer/Machine 目录表与读取适配器，不开放注册、连接、runtime 探测或凭据写入。空库查询可返回 `[]`；出现尚不能解释的记录应返回 unknown/明确失败，不能继续硬编码“没有机器”。这些表由后续接入模块扩展，不建立第二份影子目录。

官方 Agent 读取边界同理：本期至少可靠处理 `onboardingAgentId=null`，以及指向不存在、跨空间、已删除或身份不合格记录的拒绝分支。不得制造一个名叫 Cindy 的假 Agent。成功接入和创建不在 M2 的产品入口范围。

### 2.3 明确延后

成员邀请、加入链接、角色变更/转移 owner、移除成员、退出/删除空间、跨空间 Joint Channel、社区加入、完整侧栏自定义写入、计费、消息/未读、Agent/Daemon 凭据与执行、外部集成。

translation/announcement/notification 等完整设置面板不自动纳入“基本设置”。相应接口另列为后续能力；不能把 `GET /settings` 支持等同于所有设置页按钮都已可用。

删除/离开必须延后到能完整处理成员清理、会话/实时撤权及关联资源时。当前 owner 模型仍保留多 owner 的可能性，不能为方便本期而做“每空间只能有一个 owner 角色”的唯一约束。[R14]

---

## 3. 对外路由清单与共同前置条件

### 3.1 共同认证与空间作用域

所有 `/api/servers` 路由先执行 M1 的有效 access token、邮箱验证和账号资料完成检查。[R02][R06]

- 无效/撤销会话：401，保留 M1 的 `auth_required` 等既有形状。
- 邮箱未验证：403 `{ "error": "Email verification required" }`。
- 资料未完成：403，`code: "PROFILE_SETUP_REQUIRED"`。
- 基础设施故障不伪装为 401。M1 已明确的 503 安全恢复语义继续保留，不能重新造成强制登出。

用户级路由 `/api/servers`、`/order` 不要求 `X-Server-Id`；请求携带另一个空间的头也不能让它改变当前用户或创建 owner。

对 `/:id` 及其子路由：

| 条件 | 有效 HTTP 结果 |
|---|---|
| 缺少/空 `X-Server-Id` | 400 `Missing X-Server-Id header` |
| 头与 URL id 不一致，即使用户同时属于两个空间 | 400 `X-Server-Id must match server id in URL` |
| 非成员、空间已删除、`joint_storage` | 403 `Not a member of this server`，前置中间件先拒绝 |
| 通过前置检查后对象消失 | 由端点返回自身 404 |

**不得只看 endpoint handler 里的 404 就误记外部契约**：实际请求通常先在 `requireServerMatchesParam` 得到 403。[R06]

Guest 对 settings、onboarding-settings、setup-projection、machines 等管理表面得到 403 `Guests cannot access server management data`。这段 middleware 对路径的所有方法生效；“任意成员能修改个人 onboarding 偏好”是处理器的局部描述，不可据此让 guest 绕过外层拒绝。[R02]

Go 不要求复制 Express 的注册顺序，但实际匹配效果必须一致：`/order` 不能被当成 `:id=order`；已存在客户端依赖的 Labs 403 特例不通过新通配路由覆盖。

### 3.2 计划实现路由

| ID | 方法与路径 | 成功形状 | 本期责任 |
|---|---|---|---|
| W01 | POST `/api/servers` | 200，裸 ServerRecord | 事务创建及既有副作用 |
| W02 | GET `/api/servers` | 200，ServerListItem 数组 | 资格过滤、顺序、历史窗口 |
| W03 | GET `/api/servers/order` | 200，顺序与版本对象 | 账号级偏好 |
| W04 | PATCH `/api/servers/order` | 200，顺序与版本对象 | 非成员过滤、幂等版本 |
| W05 | GET `/api/servers/:id` | 200，裸 ServerRecord | 空间详情 |
| W06 | PATCH `/api/servers/:id` | 200，裸 ServerRecord | name/hideHumansFromMembers |
| W07 | POST `/api/servers/:id/avatar` | 200，裸 ServerRecord | 上传与资料更新 |
| W08 | GET `/api/servers/:id/members` | 200，成员数组 | 目录/邮箱可见性 |
| W09 | GET `/api/servers/:id/settings` | 200，`{settings:{...}}` | 聚合设置读取 |
| W10 | GET `/api/servers/:id/onboarding-settings` | 200，裸 onboardSettings | 旧读取接口 |
| W11 | PATCH `/api/servers/:id/onboarding-settings` | 200，裸 onboardSettings | 管理设置与本人偏好 |
| W12 | GET `/api/servers/:id/setup-projection` | 200，完整投影 | 无推进副作用的读取 |
| W13 | POST `/api/servers/:id/setup-transition` | 200，重新读取的投影 | action=start/complete |
| W14 | POST `/api/servers/:id/setup-reset` | 200，投影+revokedComputers | 受保护回滚 |
| W15 | POST `/api/servers/:id/setup-handoff` | 200，重新读取的投影 | owner 点击事实 |
| W16 | GET `/api/servers/:id/sidebar-order` | 200，完整偏好投影 | 当前成员真实默认值/清洗 |
| W17 | GET `/api/servers/:id/machines` | 200，机器目录数组 | 初始化读取配套；不含接入 |

配套 `workspaces-route-matrix.json` 是实现和测试的待办清单，不是运行时路由或已覆盖测试声明。头像的静态文件服务复用 M1 的安全处理能力，但 URL 使用服务端实际返回的稳定路径，不能要求客户端自行拼接新前缀。

---

## 4. DTO：内部重构，对外不重命名

### 4.1 ServerRecord：创建、详情、更新使用

字段与 TS `servers` 行一致：[R05]

```text
id, name, avatarUrl, slug, kind, ownerId, onboardingAgentId,
agentAllChannelGreetingEnabled, hideHumansFromMembers, publiclyVisible,
plan, translationEnabled, progressAnnouncementsEnabled, planDowngradedAt,
deletedAt, createdAt, updatedAt
```

`kind=normal`、`plan=free`；greeting 默认 true；hideHumans/publiclyVisible/translationEnabled/progressAnnouncementsEnabled 默认 false；可空值保持 null。没有将整个记录包成 `{server:...}`，也不把 `id` 改为 `workspaceId`。

### 4.2 ServerListItem：不得简单复用 ServerRecord

```text
id, name, avatarUrl, slug, ownerId, onboardingAgentId,
hideHumansFromMembers, plan, planDowngradedAt, role, serverPushMuted,
createdAt, serverOrderVersion, messageHistoryDays, historyCutoff
```

`role` 来自当前用户 membership，而非 `ownerId == userId` 的猜测。`serverOrderVersion` 来自账号级排序版本，每项一致。`messageHistoryDays=-1` 表示无限，`historyCutoff=null`；否则按参考计划函数与注入时钟计算。[R04][R17]

M1 的 free=30 简化当前日期下可能恰好正确，但完整兼容测试还需覆盖参考 trial 时窗，不能因为过去窗口已经结束就把测试固定成永久 30。

### 4.3 编码规则

- UUID 仍为字符串；SQLite 内部使用 TEXT 不改变协议类型。
- 时间为 UTC ISO-8601 毫秒精度；不输出 SQLite 整数、Go 纳秒或本地时区。
- null、字段缺省、空数组不能互换；不要对所有可空字段加 `omitempty`。
- version 保持 JSON number；内部可用 int64，但不得未经协议升级改成字符串。
- PATCH 必须区分 absent/null/false/empty string，不能用 Go 零值统一处理。
- TS `string.length` 是 UTF-16 code unit 数。对已有长度限制应按相同边界测试 emoji 等输入，而不是随意改成字节数或 rune 数。
- 非本期字段不能成为“任意 map 更新数据库”的入口；保留 TS 的忽略/拒绝规则，而非统一 `DisallowUnknownFields` 改掉所有请求。

---

## 5. Go 模块结构与责任

保持一个进程、一份 SQLite、普通进程内调用。推荐新增/扩展：

```text
internal/workspace/
  model.go                 空间、成员、偏好等类型
  service.go               Create/Get/Update/Order 用例与事务边界
  store.go                 SQLite 查询与写入；接受同一 transaction executor
  policy.go                基础角色/目录可见性策略
  setup.go                 setup 状态机与纯投影函数
  setup_store.go           持久 setup / handoff
  setup_facts.go           Computer/官方 Agent 事实读取边界
  settings.go              聚合与成员偏好
  sidebar.go               读取清洗，不承担完整侧栏编辑
internal/transport/legacyweb/
  servers_handlers.go      HTTP 解析与错误/DTO 映射
  workspace_scope.go       URL/header/membership 共同检查
  workspace_dto.go          原协议形状
internal/channel/           本期仅系统频道初始化、可见性所需目录
internal/computer/          本期仅目录读取；M3 扩展接入
internal/platform/db/migrations/
  0003_workspace_foundation.sql  名称示例；实施时使用下一个未占用版本
```

不要求每个文件都对应 interface。真正需要隔离的是时钟、事务、附件存储、feature policy、setup live facts，以及后续实时通知边界。

**事务归用例拥有**。`CreateWorkspace` 开一次事务，系统频道和审计 writer 接受该 tx；它们不得再打开独立 DB transaction。领域代码不接受 `http.Request`，也不发 Socket.IO。

`ownerId` 与 owner role 并存：普通管理授权按 membership capability；setup start/complete 按本人 owner role；reset/handoff 的原 TS 特例按空间 `ownerId`。这不完全统一，但兼容层不能擅自改成一套更“优美”的规则。[R08][R14]

---

## 6. SQLite 数据模型与 M1 升级

### 6.1 延续一条迁移链

不修改已经应用的 `0001_init.sql`、`0002_account_email_requests.sql`。新增 migration；新装执行全链，旧 M1 数据原位升级。与旧 TS PostgreSQL 物理表名一致不是要求；外部行为和未来可导出性才是要求。

### 6.2 表与字段设计

| 对象 | 设计 |
|---|---|
| workspaces | 在现有列上增加 kind、updated_at、greeting/publiclyVisible/translation/progressAnnouncements 等真实配置列；原 id/slug/owner_id 保留 |
| workspace_memberships | 保留 `(workspace_id,user_id)` 主键、role、push muted、joined_at；新插入默认 role=member，创建者显式写 owner |
| workspace_member_setup | 以 membership 为父关系，保存 status、completion_reason、contract_version、handoff_acknowledged_at；setup 是每成员事实，不是单个全局空间布尔值 |
| workspace_member_preferences | 保存 reminder opt-out、五种 dismissal 时间、旧 wizard step、briefing 记录及侧栏偏好；不与 setup status 混写 |
| account_workspace_order | 以 user_id 为主键，保存 ordered IDs 和 version；这是账号级，不是当前空间级 |
| workspace_membership_agreement_audit | 保存创建时 source=admin-add、subject、actor、nullable agreement/version 等真实审计事实；不伪造已接受协议 |
| channels / channel_humans | 系统频道及 opener 私有频道的真实记录；只有 opener 私有频道需要本次显式 owner roster |
| computers / machines 最小目录 | 保存空间归属、撤销状态、名称和已知 heartbeat/runtime 事实；M2 不提供接入 writer，不制造在线状态 |
| 官方 Agent 目录边界 | 后续 Agent 模块唯一维护；M2 对无指针、无记录/不合格指针正确拒绝，成功分支用隔离测试 fixture 验证而非运行时假实现 |
| users 追加字段 | `first_onboarding_completed_at`、`first_onboarding_completed_session_family_id`，用于原 handoff 的账号级持久事实；M1 账号和会话不重建 |

setup 状态约束：`not_started | in_progress | deferred | complete`。`deferred` 只兼容读取，不再产生。completion reason 为 null 或 `normal | grandfathered | complete_after_defer | admin_override`；非 null reason 只能属于 complete。新 owner 显式 `not_started + null + onboarding-setup-v2`。

系统频道用稳定 UUID 及 `(workspace_id,system_kind)` 活跃记录唯一约束，防止重试生成重复 #all/#announcement。`onboarding-owner` 是普通私有频道，不要虚构新的 TS systemKind。

### 6.3 默认 role=owner 的修正

M1 membership 表默认 owner 是一个需要收口的边界。[R01]

迁移只改变**未来 INSERT 的默认值**，不把已有 owner 批量降为 member。改变默认角色不能直接套用 PostgreSQL 的 ALTER COLUMN SET DEFAULT。SQLite 的 ALTER 能力应以实际驱动内置版本为准；本设计选择经过演练的表重建路径，保留索引/FK并执行 `foreign_key_check`，并不声称 SQLite 不支持任何 ALTER COLUMN 操作。[W2]

当前 M1 没有依赖 membership 的新子表时，可先重建 membership，再建 setup/preferences 子表。实施前重新核对入向外键；不能在事务里执行 `PRAGMA foreign_keys=OFF` 后假定已经生效。

对旧数据：根据真实 membership 补初始化行；不把所有已有空间标记 complete。若 owner_id 没有相应 owner membership，或者存在本阶段无法解释的 onboardingAgentId，输出诊断并按明确修复流程处理；禁止迁移时默默授予权限或清空指针。

### 6.4 事务与故障恢复

沿用 M1 的 WAL、外键开启、连接级 busy timeout 和 `BEGIN IMMEDIATE`；写事务保持短小。SQLite 支持并发读，但通常仅一个并发写事务，因此不直接翻译 `SELECT FOR UPDATE` 或 pg advisory lock。[W1]

写入和读取取消必须使用请求 context；不在 transaction 内做头像解码、发邮件、网络访问、等待 Daemon 或广播。副作用失败不把已提交事实伪装成未发生。

升级失败回滚当前 migration，不破坏 M1 数据。备份/恢复必须同时考虑数据目录与密钥，不在运行中只拷贝主 `.db` 忽略 WAL。回退旧二进制遇到新 schema 应维持现有 fail-closed 行为，不承诺任意跨版本 downgrade。

---

## 7. 创建空间：完整事务与输入契约

### 7.1 输入与输出

请求：`POST /api/servers`，JSON `{ "name": "Example team", "slug": "example-team" }`。

成功是 **200 + ServerRecord**，不是 201，不是 `{server:...}`。owner 取当前已验证账号，不读取 body.ownerId/role。body 里的 settings/plan/setupStatus 不能提升权限或跳过初始化。

slug 规则完全来自 shared：最少 5，`^[a-z][a-z0-9-]*$`，没有当前代码定义的最大长度；不自动 lowercase、trim 或加新保留词。[R10]

| 输入问题 | 原 TS 错误 |
|---|---|
| name/slug 为缺失或 falsy | 400 `Name and slug are required` |
| truthy 非字符串 slug | 400 `Slug is required` |
| 少于 5 个字符 | 400 `Slug must be at least 5 characters` |
| 模式不匹配 | 400 `Slug must start with a letter and contain only lowercase letters, numbers, and hyphens` |
| 活跃 slug 已占用 | 409 `Server slug "..." is already taken` |

**create 与 patch 的 name 校验并不相同**：TS create 只有 truthy 检查；PATCH 才 trim、非空和 ≤100。Go 不应未经记录就把 PATCH 的规则套到创建。对错误类型、超长名称、软删除 slug 和并发冲突等原代码缺陷，见第 14 节差异登记。

### 7.2 单次事务步骤

1. 验证账号状态；进入 SQLite 写事务后再次确认必要身份记录仍有效。
2. 检查 slug 占用并插入 workspaces，生成稳定 ID、统一时间。
3. 插入 owner membership（明确 role=owner）和 setup v2 初始行。
4. 插入默认成员偏好，以及成员协议审计记录。
5. 按本次 policy 求值初始化 #all：opener off → type=channel；on → type=private；systemKind=all。
6. 确保 #announcement：type=channel，systemKind=announcement，description=`Agent progress announcements`，与 progressAnnouncementsEnabled 是否开启无关。
7. opener on 时插入 `onboarding-owner` 私有频道及创建者的人类成员行。
8. 提交；输出完整 ServerRecord。创建不启动 Cindy、不投递消息，也不擅自增加 TS 此路径没有的实时事件。[R03][R11]

故障注入要求：第 2–7 步任一步失败，全事务回滚，空间/owner/频道/审计均无部分残留。不可在创建响应已经成功后再“尽力补建 owner”。

### 7.3 重试与并发

同 slug 不是一个完整的幂等协议。成功响应丢失后，旧客户端再次 POST 可能得到冲突；不得把其他请求创建的空间直接当作当前请求的成功结果返回。

不新增客户端必须携带的 Idempotency-Key。可以通过随后 GET 列表让客户端观察真实结果。并发创建必须保证至多一个空间，且只有该赢家拥有完整副作用；失败结果的兼容/修复决策单独登记。

---

## 8. 列表、详情、顺序和基本资料

### 8.1 列表与详情

列表只包含当前用户仍是成员、未删除、kind!=joint_storage 的空间。排序先读取账号保存顺序，过滤无资格 ID并去重，再按 joinedAt 追加未出现的空间；不要永久固定成 UUID 排序。[R04]

Go M1 用 id 作为同时间的辅助排序。TS 只明确 joinedAt，等时间的顺序并无稳定保证；正常数据保持语义，fixture 固定加入时间。若为相同 joinedAt 增加稳定 tie-breaker，列入非语义漂移，不声称 TS 本来保证了该次序。

详情接口按 ID，不按 slug。原 Web 通过成员列表与本地路由解析 slug；不要新增“把任意 :id 当 slug 查询”的回退。[R04][R12]

### 8.2 账号级顺序

`GET/PATCH /api/servers/order`：`{serverOrder:[...],serverOrderVersion:n}`。

PATCH 必须是字符串数组。过滤他人空间和不存在 ID，保序去重，补全遗漏成员空间；不因此返回 403。实际有效顺序相同不加版本，变化才增加一次。全部在 SQLite 事务中更新，避免读改写丢版本。

条件启用时的原事件名是 `server_order:updated`，不是 `server:order-updated`，目标是当前用户 room。[R20] M2 未实施 Socket.IO 时只声明 HTTP 范围；不得把长期 no-op notifier 当成跨标签页实时同步已经等价。完整实时资格验证归后续阶段，见第 11 节。

### 8.3 PATCH 资料

允许 name/hideHumansFromMembers；不允许该接口更改 slug、ownerId、plan、kind、onboardingAgentId。owner/admin 具有 editServerSettings，member/guest 不具备。

name：非字符串 → 400 `Name must be a string`；trim 后空 → `Name is required`；超过 100 UTF-16 单元 → `Name must be 100 characters or fewer`。hideHumans 必须 boolean。没有有效字段 → `At least one field is required`。无权限 → 403 `Only server owners and admins can edit the server profile`。[R02]

更新 updatedAt，createdAt 不变，返回完整 ServerRecord。TS 该路径没有 server-updated 广播；不把新增事件作为旧客户端必需依赖。

### 8.4 头像

沿用 multipart 字段 `avatar` 和 M1 的大小、内容校验与安全重编码机制；权限先于接收/解码。无文件 400 `No avatar file provided`；过大/坏格式保留 `PROFILE_AVATAR_TOO_LARGE`、`PROFILE_AVATAR_BAD_FORMAT` 及 maxBytes 形状。[R02]

文件写入先准备为私有临时文件、原子发布，再更新 DB 引用。DB 失败时不得返回假成功，也不立即删除仍被其他记录引用的内容寻址文件。文件/数据库不是同一原子事务，孤儿文件回收单独处理。

---

## 9. 成员可见性与设置合同

### 9.1 Owner 与成员读取

创建后，空间记录 ownerId 与创建者 membership.role=owner 必须一致。授权以真实 membership 为准；不是所有登录用户都能读取所有空间。原 Web 的 createServer 会给本地响应对象补 `role: "owner"`，因此界面显示 owner 不是数据库成员关系正确的证据；必须用重新登录后的列表/成员查询和事务测试验证。[R12]

成员响应字段：[R15]

```text
userId, email, name, displayName, description, avatarUrl, role, joinedAt, gravatarHash
```

- owner/admin 可看到所有成员邮箱；普通 member 只看到自己的邮箱，其他为 null。
- `hideHumansFromMembers=true` 时普通 member 的目录仅自己；owner/admin 不据此失去管理目录。
- guest 被本端点明确拒绝。
- gravatarHash 仍依原参考输出；不要因为邮箱被隐藏就直接删除前端认识的头像字段。
- 列表依据 joinedAt，非全局 users 表；必须测试两个空间的隔离。

本期不提供“创建另一个 owner”的入口，但模型、策略与测试应覆盖 co-owner，防止未来只能靠改 ownerId 表达多 owner。[R14]

### 9.2 聚合设置示例

以下为 C0 新空间实际字段示例；布尔值来自配置与持久数据，不是为了跳过门禁。

```json
{
  "settings": {
    "onboardSettings": {
      "onboardingAgentId": null,
      "agentAllChannelGreetingEnabled": true,
      "onboardingWizardEnabled": false,
      "setupModalReminderOptOut": false,
      "onboardingReminderOptOut": false,
      "dismissedAddComputerStepAt": null,
      "dismissedCreateAgentStepAt": null,
      "dismissedInviteStepAt": null,
      "dismissedCommunityStepAt": null,
      "dismissedNotificationStepAt": null,
      "onboardingWizardCurrentStep": null,
      "onboardingDmSentAt": null,
      "onboardingDmSentByAgentId": null
    },
    "feedbackSettings": { "enabled": false }
  }
}
```

`GET /onboarding-settings` 只返回上面的 onboardSettings 内层。[R07]

### 9.3 PATCH onboarding-settings

管理字段：`onboardingAgentId`（string/null）、`agentAllChannelGreetingEnabled`（boolean），owner/admin 才能改。

本人偏好字段：reminder opt-out、dismissedAddComputerStep、dismissedCreateAgentStep、dismissedInviteStep、dismissedCommunityStep、dismissedNotificationStep，以及 onboardingWizardCurrentStep。非 guest 的普通 member 可以改自己的偏好，不能指定别人的 userId。[R02]

兼容细节：

- `setupModalReminderOptOut ?? onboardingReminderOptOut` 的别名/空值优先级与 TS 一致；两个响应别名指向同一持久事实。
- dismissal=true 写当前时间，false 写 null；不得据此写 setup=complete。
- wizard step 允许 null 或参考闭合集合；它是旧 UI 偏好，不是新 setup 真相。
- onboardingAgentId 非空必须指向本空间有效 Agent，否则 400 `Onboarding agent not found in this server`。null 可清空配置，但已完成 setup 不因此回退。
- **配置 setter 与显式 complete 是两条不同路径**：TS 此 PATCH 对非空 Agent ID 检查存在性与本空间归属，然后 setter 调用 `reconcileOwnersToSetupCheckpoint`，把所有未完成的 owner 行写成 `complete + grandfathered`；此 reconcile 本身没有再次做官方 Cindy 身份校验。已经 complete 的 owner 原 reason 保留。不能因为显式 complete 检查 official usable，就擅自给配置 setter 增加相同条件。[R23]
- 本期不开放 Agent 创建，因此正常新库不具备非空成功候选；这条 setter 的有效记录分支必须作为后续对接合同及隔离 fixture 测试保留。伪造、不存在、跨空间 ID 仍拒绝。以后启用 Agent writer 前必须接通完整事务化 reconcile，不能只有字符串落库。
- 任意字段类型错误按原错误句子拒绝；没有字段时 400。组合更新建议同一事务，避免管理设置已经提交而个人偏好失败产生一半生效；这是实现原子性的明确改进，不改变正常成功结果。

### 9.4 侧栏读取

`GET /sidebar-order` 不只返回三个数组，还包含四种 sortMode、typed pinned、legacy pinned 三字段、hiddenDmIds、两个 panel tab order、customSections、sectionOrder、sectionPlacements、sectionsVersion、pinnedVersion。[R16]

默认数组为空、sortMode=manual、版本=0，是合法“未设置”事实；系统频道已经存在并不意味着用户显式 channelOrder 必须预填它们。

不得原样返回持久化 ID：按频道/Agent/DM/用户的存在性与可见性过滤，并按 TS 合成 typed/legacy pinned。未来目录未实现时，不把未知对象视为可见；有无法解释的旧偏好应清晰降级或失败，不能泄露他空间 ID。

完整 PATCH sidebar（custom section CAS、pinnedVersion、事件）延后，不用一条 generic JSON update 伪装完成。

---

## 10. 初始化门禁：持久状态、实时事实、展示投影分离

### 10.1 状态机的三部分

1. **持久状态**：membership 对应的 setup.status、reason、contractVersion。
2. **事实读取**：活跃 Computer、在线状态、runtime readiness、官方 Agent 身份、原 owner 的 survey 和 handoff。
3. **纯投影**：输入上述内容，生成原 Web 认识的 ServerSetupProjection。[R08]

事实读取不可反向“修复”setup；GET 不自动完成、不发消息、不创建 Agent。状态变更由显式命令、官方 Agent 创建及经过授权的 onboarding 配置 setter 等既有写入路径拥有；这些路径的完成条件和 completionReason 并不相同，不能擅自统一。[R23]

### 10.2 新空间初始响应

在真实目录为空、新 owner 未完成 setup 时，按参考逻辑输出：

```json
{
  "surface": "computer_runtime",
  "phase": "not_started",
  "currentStep": "computer_runtime",
  "blocksChat": true,
  "allowedExits": ["reset", "return_to_server"],
  "sideEffectState": { "transitions": "enabled", "completion": "disabled" },
  "gateReason": "computer_offline",
  "computerStatus": "offline",
  "runtimeStatus": "unknown",
  "runtimeOptions": [],
  "hasConnectedComputer": false,
  "offlineComputers": [],
  "postSetup": { "surveyPending": false, "handoffPending": false }
}
```

注意无 Computer 时 runtime 是 **unknown**，不是擅自选择 not_ready；postSetup 在前置 setup 尚未完成时不展示。[R08]

`return_to_server` 不是 `defer`，也不意味着 blocksChat=false。按原 Web 实际按钮行为验收，不把这个枚举重新解释成绕过门禁的许可。

### 10.3 全部投影分支必须写测试

| 事实/状态 | 结果要点 |
|---|---|
| 非 owner 但通过空间资格检查 | surface=none，phase=null，blocksChat=false，insufficient_permission |
| guest 请求 setup-projection | 先被管理表面 middleware 拒绝 403，不到上面的分支 |
| 角色/状态解析失败或状态丢失 | 原 retry projection；不篡改成 complete；失败原因与未知事实按 TS |
| 未完成、Computer offline/unknown | computer_runtime；相应 gateReason |
| online、runtime 未就绪 | computer_runtime；not_ready/checking/error/unknown 分别保留 |
| online、runtime ready | create_agent；按官方 Agent 状态决定 completion 是否 enabled |
| status=complete | 不再因机器断线回退 setup；参考 resolver 不重读 live inventory，相关状态使用 unknown |
| legacy status=deferred | 兼容读取为非阻塞；服务端不再生成这种状态 |

**官方 Agent usable 不是“有一个在线 Agent”，也不是“名称叫 Cindy”。** TS 检查 onboarding 指针、本空间、未删除、machineId、非空 runtime，以及 `hasOfficialOnboardingAgentIdentity` 的身份/角色条件。必须使用相同事实定义；不要再添加“必须当前在线”等 TS 没有的完成条件。[R19]

### 10.4 start / complete

POST body `{action:"start"}` 或 `{action:"complete"}`。

- actor 必须是人类、只能改自己的 setup 行，membership role 必须 owner。
- start：not_started/deferred → in_progress；已 in_progress 无变化；已 complete 不回退。
- complete：未 complete 时先验证官方 Agent usable；通过后 status=complete、reason=normal；已 complete 幂等。
- defer 及未知 action：400 `{ "error": "INVALID_SETUP_ACTION" }`。
- 权限错误 403；STATE_NOT_FOUND 404；OFFICIAL_ONBOARDING_AGENT_NOT_USABLE 409；LIVE_FACTS_UNAVAILABLE 424；未知失败 500 SERVER_SETUP_TRANSITION_FAILED。[R09]

测试必须验证直接写 body.setupStatus、wizardCurrentStep 或伪造 Agent ID 不会获得完成权限；对于显式 complete，普通但不满足官方身份条件的 Agent 不通过 usable 校验。**但已获管理权限的 onboardingAgentId 配置 setter 有独立的 grandfathered 完成语义**，必须按第9.3节测试，不得把它误记成被 TS 禁止的路径。[R23]

### 10.5 reset 不等于删除空间

原行为是：校验空间原 owner、未 complete、onboardingAgentId 仍为空；同一事务撤销该空间所有未撤销 Computer，并将 owner setup 归为 not_started/reason=null。返回新投影和本次实际 `revokedComputers`。[R08]

不删除空间、成员、系统频道，不重置账号资料，不卸载用户电脑上的程序。已 complete 或曾跨越官方 Agent checkpoint 的空间返回 409 `SERVER_ALREADY_SET_UP`。

`everHadAgent` 这个内部字段在参考中实际由 onboardingAgentId 判断，不是所有普通 Agent 的数量。必须保留该区别。之后接入 Agent 创建时，reset 与创建用同一事务序列化机制，不能检查在事务外、撤销在事务内。

### 10.6 survey / handoff 是独立事实

setup 完成后，只有完成原因 normal/complete_after_defer 且 actor 是 `servers.ownerId` 时，才读取并展示原 owner 的 surveyPending/handoffPending；grandfathered/admin_override 不自动补欠引导步骤。[R08]

handoff 先持久化会员上的首次 acknowledgment，以及 users 首次 onboarding 完成时间/当前 session family；重复点击不刷新首次时间。之后才尝试 briefing。不能把“用户点击”与“Agent 收到”合成同一字段。[R21]

**原端点的一个非直观行为**：setup-handoff 按 ownerId 鉴权，但没有显式要求 setup 先 complete。Go 不得悄悄加一个 409 前置条件并声称完全复刻；也不能让提前 handoff 改变 setup.status。测试必须覆盖该现状，产品强化另行评审。

本期没有 Agent 投递，不能记录“briefing 已发送”。M3/M5 应根据持久 acknowledgment 和未完成投递事实继续执行，与参考的激活时重试能力衔接；M2 不预建一个通用任务编排平台。

### 10.7 不把原 Web 的失败降级当作成功路径

原浏览器 gate 首次读取投影失败时会保留 null 并可能不显示模态；MainLayout 的其余内容仍然挂载。缺失 setup-projection、返回404/501，或错误地给 owner 返回 phase=null，都可能造成“看到了主界面”的假阳性。[R22]

因此创建事务必须同时产生 owner 的 setup 行；新空间的验收必须断言 setup-projection 返回200、有效完整投影和正确 blocksChat，并在重新读取和进程重启后再次核实。不能借用初次读取失败、数据库造 complete/deferred、把 owner 改成 member，来绕过正常的新用户流程。

这里仍保留一个诚实边界：原 UI 自身的失败降级并不会因 Go 改写就自动消失，本期不能在不改客户端的情况下宣称修复了它。setup 是产品引导门禁，不代替每个业务端点的身份和资源权限检查；原 retry 分支及业务授权分别验证。

---

## 11. 原 Web 初始化依赖与协作者边界

### 11.1 实际调用链

`ServerSelector` 提交 name/slug → `serverStore.createServer` POST → 设置当前空间 → `loadMembers` / `loadSidebarOrder` / `loadSettings` → 路由进入 `/s/:slug/...` → MainLayout 和 SetupProjectionGate 挂载。[R12]

SetupProjectionGate 会并行读 machines 与 setup-projection，并在机器变化或轮询恢复时重新取投影。MainLayout 的 realtime bridge 还会初始化 Socket.IO、频道/DM/Agent/机器/未读/保存项等读取；模态门禁并不会自动阻止这些底层 hook 执行。[R12][R22]

### 11.2 分类处理，而非全部返回空成功

| 类别 | 端点/能力 | 本期处理 |
|---|---|---|
| 本期硬依赖 | servers、members、settings、sidebar-order、setup-projection、machines 目录 | 按原合同实现并验证 |
| 后续产品读取 | channels、DM、agents、unread、saved、announcement 等 | 逐项登记实际请求和影响；未实现返回明确错误，不能全局兜底200 |
| 实时通道 | Socket.IO handshake/rooms/events | 后续资格验证；M2 不宣称 realtime 等价 |
| 可选配置/遥测 | feature flag、deployment info、上报 | 遵守原缺省/失败行为；不能把失败当作“功能关闭且成功” |
| 主动后续命令 | Register Computer、Create Agent、发送消息 | 本期不提供假凭据或假执行结果 |

由于 #all/#announcement 已真实创建，把 `/channels` 永久返回 `[]` 尤其不正确。若 UI 协作者发现频道列表是本期页面渲染的阻塞依赖，就增加范围受控的真实只读接口及测试，而不是修改 Web 或隐藏数据。这个依赖扩展需要补入路由清单，不能口头宣布全部已支持。

### 11.3 接受标准的两层

**后端可独立验收**：创建/设置/权限/持久化/状态投影通过 HTTP 与 SQLite 测试。

**原 Web 联调验收**：同一源码版本、独立浏览器 context、同源代理只指向 Go。真实创建空间并观察请求；确认进入 Computer 初始化状态，刷新/重启后保持正确；不注入 tokens 绕账号、不改 owner setup、不覆盖响应、不修改前端 flags。

本期不能要求一个尚无 Agent 的新 owner 打开所有被初始化模态遮挡的设置控件。那些设置后端先经 API验收；原 UI 完整可操作性应随后续真实 checkpoint 再验收。测试 fixture 可覆盖已完成状态，但不能把它当作新用户完整创建链路的证据。

### 11.4 CLI / Daemon 不被误接到 Web API

- CLI 仍使用 agent-facing `/internal/agent-api/server` 等合同；human `/api/servers` 的 DTO 不可拿去冒充该响应。[R13]
- 本期人类注册/登录成功不表示 Agent 凭据接入成功；不能把 JWT 当 machine key 兼容。
- 外部依然说 serverId，内部可以说 workspaceID；同一空间 ID 后续必须贯穿人类 API、Agent API与机器协议。
- 后续内部接口保留 handle/UUID 解析边界，不要求修改 CLI 让它适应 Go 新模型。
- `/internal/*`、`/daemon/*` 未实现状态沿用 M1，不偷偷转发回 TS。

---

## 12. 错误、事件、安全和可观测性

### 12.1 错误映射

领域层使用 typed error；transport 层按端点映射原 status/shape。业务 400/403/404/409/424 与数据库/存储故障分开。不要在 Go 中统一改为 REST 风格 201/422 或 `{code,message}`。

并发资源消失时的错误顺序以完整 middleware 链为基准。先验证身份/作用域，再验证业务可见性；不能通过另一用户的合法 serverId 访问 URL 中其他空间。

### 12.2 事件范围

TS create 和 profile PATCH 并没有相同的广播承诺；顺序/pinned/member mutation 各有独立事件和旗标。不能为了“统一”增加依赖，也不能把原事件静默丢失称为完整兼容。

本期尚未启动实时服务时，API测试与实时验收分别记账。开启 receiver state push 等要求事件的配置前必须接入真正的 Socket.IO adapter并通过旧客户端测试。普通 WebSocket 不兼容 Socket.IO 的包协议。[W3]

不为单机 M2 引入 Redis。后续若新增可靠跨进程副作用，再根据具体业务设计持久交接；现在先确保事务提交后才允许通知观察者。

### 12.3 观测

记录请求 ID、路由模板、状态码、domain error code、耗时、SQLite busy/timeout、migration version。业务审计记录 actor/subject/来源等，不把完整用户邮箱、token、头像字节或任意 raw body写进普通日志。

建议指标/日志事件：workspace.create 成功/冲突/回滚，scope mismatch/denied，setup transition changed/no-op/rejected，reset revoked count，settings update失败，order version changed/no-op。指标标签不使用任意 workspaceId，避免高基数。

---

## 13. 可执行验收设计

以下是**待实现的测试要求**，不是本轮已有测试结果。

### 13.1 共用 fixture

两位普通用户 A/B；空间 S1/S2；角色 owner/admin/member/guest 与 co-owner；验证/资料状态齐全；稳定时钟；旗标 C0 与 opener on。通过测试专用 seeder 向隔离数据库插入数据，不新增产品后台绕权限接口。

TS 和 Go 使用各自数据库，在同一个固定场景下比较可观察结果。PostgreSQL 专有 SQL 不逐行翻译，而比较结果、排序、权限和副作用。TS 的 PGlite 测试只覆盖适用语义；遇到 PG 锁/约束行为差异用真正 PostgreSQL 的参考测试补证据，不能假定两者完全一样。

### 13.2 必须通过的矩阵

| 测试组 | 核心断言 |
|---|---|
| T01 身份门禁 | 无 token、撤销、未验证、资料未完成准确拒绝；DB故障不变401 |
| T02 创建 happy path | 200裸ServerRecord；owner来源当前账号；重新读取确认真实owner关系；返回所有字段 |
| T03 原子性 | 在 owner/审计/系统频道/偏好写入注入失败，无半创建残留 |
| T04 slug | 长度/大小写/非法字符/不自动归一化；活跃重复409 |
| T05 竞态 | 同slug并发至多一个完整空间；输出遵循已批准冲突映射 |
| T06 升级 | 带M1账号/session/空间数据升级；密钥/token/旧role/ID不变化 |
| T07 scope | 缺头400、跨头400、非成员403；用户同时属于两空间也不能错配 |
| T08 列表 | 只返回本人可见空间；排除deleted/joint_storage；裸数组含版本 |
| T09 顺序 | 去重过滤/补全/无变化不加版/并发不丢版/重启持久 |
| T10 资料 | owner/admin允许；member/guest拒绝；PATCH校验UTF-16边界 |
| T11 头像 | 原multipart/错误码；坏格式/过大/未授权；DB失败不假成功 |
| T12 成员隐私 | 不跨空间；邮箱null规则；hideHumans普通member仅自己；guest403 |
| T13 设置形状 | nested settings与旧onboarding内层一致；别名一致；null不缺字段 |
| T14 偏好写入 | 只能本人；管理字段鉴权；组合更新全回滚；dismiss不完成setup；有效onboarding配置按TS reconcile为grandfathered |
| T15 初始门禁 | 与第10.2节JSON一致；无 Computer 时runtime unknown |
| T16 状态分支 | 纯projector覆盖全部status/computer/runtime/官方Agent状态 |
| T17 transition | start幂等、complete只在官方Agentusable时成功；defer400；424不混409 |
| T18 terminal | complete不因离线/删除Agent重新阻塞；grandfathered不欠survey/handoff |
| T19 reset | ownerId权限、实际revoked数量、重复安全、保留空间/频道/资料 |
| T20 reset竞态 | 与checkpoint写入串行；不能在创建官方Agent后撤销机器 |
| T21 handoff | 原owner判定、首次时间稳定、账号family记录、提前调用不改setup.status |
| T22 防伪造 | body.plan/role/ownerId/setupStatus无授权效果；无效ID拒绝；区分显式complete的official校验与授权配置setter |
| T23 目录/侧栏 | 真实空目录；保存非法/跨空间ID后读取不泄露；偏好完整字段 |
| T24 协议形状 | number/string、日期、[]/null、错误体、methods/Allow与路径匹配 |
| T25 生命周期 | SIGTERM/重启后空间与设置/状态保留；SQLite写锁等待可取消 |
| T26 原Web协作 | 不改客户端/状态；创建→初始化状态→刷新；首读失败不误记通过；请求覆盖清单与已知缺口 |
| T27 旧功能回归 | M1注册/登录/验证/轮换/重置/退出/权限全部仍通过 |

### 13.3 测试落点

- `internal/workspace/*_test.go`：策略、projection、事务和SQLite持久化。
- `internal/transport/legacyweb/workspaces_*_test.go`：完整路由及共同中间件顺序。
- `tests/acceptance/workspaces-contract.mjs`：真实独立进程+临时SQLite+HTTP；不需要启动Web。
- `tests/acceptance/workspaces-lifecycle.mjs`：重启/升级/故障/写锁。
- UI协作者扩展 `tests/e2e` 或独立验收工程；后端交接提供API和配置，不替其宣称浏览器通过。

既有 `make check` 继续执行格式、vet、单测、race、HTTP黑盒与构建；加入M2验收，不删除M1断言。不能用grep源码出现某个函数名代替行为测试。

---

## 14. 必须登记、不能悄悄修的参考差异

| 编号 | 原 TS/当前 Go事实 | M2默认处理与决策要求 |
|---|---|---|
| D01 | TS create name仅truthy，PATCH有trim/100限制 | 正常字符串行为保持；新上限/类型收紧需单独批准，不混入普通重写 |
| D02 | TS slug预检只看活跃行，但DB全表unique；并发/软删冲突可能500 | 不允许重用软删slug；建议统一409，但这是待评审的缺陷修复，不冒充既有全部分支 |
| D03 | TS未给community等slug统一保留词限制 | 不自行新增保留表；社区产品风险另审 |
| D04 | Go M1未输出serverOrderVersion | 本期补齐，与现有Web同形，不作为新产品功能 |
| D05 | Go M1默认membership.role=owner | 迁移改未来默认member、创建显式owner，旧角色不变 |
| D06 | 原setup-handoff缺少complete前置条件 | 保持原调用可接受性；提前ack不允许推进setup；如强化另审 |
| D07 | M1基础设施故障已用503避免误登出 | 沿用已公开M1差异；普通业务错误继续原形状 |
| D08 | TS顺序更新读改写、并发版本可能覆盖 | SQLite事务确保单调，无需新增客户端CAS字段；登记并发修复 |
| D09 | 完成态resolver不读取Computer实时事实 | 对齐unknown投影，不能为了“更准确”把离线重新变成未完成 |
| D10 | 本期未实现Socket.IO/CLI/Daemon接入 | 明确范围缺口，不叫全部客户端已兼容；不得用no-op或TS转发掩盖 |
| D11 | TS有效onboarding配置setter会把未完成owner reconcile为grandfathered，不重复官方身份校验 | 与显式complete分别保留；如强化setter条件需单独评审，不能在重写时擅自统一 |

不复制已确认的安全漏洞；发现安全风险时暂停相关发布并单独裁决。与此同时，不能以“更安全”为理由随意改动普通业务合同而不记录客户端影响。

---

## 15. 实施拆分、责任与发布门槛

| 步骤 | 交付 | 主责与核对责任 | 退出条件 |
|---|---|---|---|
| M2-0 | 冻结基线/配置，补契约样例和路由清单 | 协议负责人；后端复核 | 字段/错误/权限/副作用可追溯；差异登记有结论 |
| M2-1 | SQLite增量迁移、默认role修正、工作空间领域 | 后端；数据审核者 | M1升级/备份恢复/外键检查通过 |
| M2-2 | Create/List/Get/Order/owner及系统频道事务 | 后端；安全/协议审核者 | T01–T09与故障注入通过 |
| M2-3 | Profile/Avatar/Members/Settings/偏好 | 后端；安全审核者 | 隔离与隐私/输入/响应矩阵通过 |
| M2-4 | setup projector及命令、目录读边界 | 后端；状态机审核者 | 全分支/幂等/terminal/reset/handoff通过 |
| M2-5 | HTTP黑盒、原Web请求交接、文档 | 测试；UI协作者负责浏览器 | M1+M2门槛通过；每个未支持请求有范围判定 |

角色是责任槽位，不假设已经有人认领；执行时每项指定具体人或Agent，不能由“测试会检查”替代责任人。

代码冻结前必须交付：通过的命令及环境、测试数量与失败/跳过原因、M1数据升级证据、兼容差异结论、后续依赖列表、启动/备份/恢复说明、UI协作者的独立验收记录或明确未验收状态。

不使用“已创建空间，所以M2完成”作为发布标准；也不把后续整套消息系统捆绑成M2的隐性前置工程。采用本文件明确的阶段终点与接口范围。

---

## 16. 源码证据索引与参考资料

行号对应上方基线；实现前HEAD变化须重新核对。括号内列出关键符号，行号漂移时可定位符号，不把旧行号当最新事实。

| 引用 | 路径与范围 | 证据 |
|---|---|---|
| R01 | `server-go/internal/workspace/store.go`；`server-go/internal/transport/legacyweb/servers_handlers.go`；`server-go/internal/platform/db/migrations/0001_init.sql:135–160` | 当前Go最小列表/默认owner/缺少字段 |
| R02 | `packages/server/src/routes/servers.ts:721–1534`、`:1795–1817` | 主要HTTP路由、管理表面、设置、setup |
| R03 | `packages/server/src/services/serverService.ts:158–227` | createServer事务副作用 |
| R04 | `packages/server/src/services/serverService.ts:262–420` | membership列表/排序/版本 |
| R05 | `packages/server/src/db/schema.ts:249–383` | ServerRecord及成员setup/偏好字段 |
| R06 | `packages/server/src/middleware/auth.ts:80–203,404–458`；`packages/server/src/app.ts:416` | 认证/资料/作用域中间件 |
| R07 | `packages/server/src/services/serverSettingsService.ts:20–54` | settings聚合与旧别名 |
| R08 | `packages/server/src/services/serverSetupStateService.ts:17–215,304–617,745–1025` | 状态、projection、事实、reset |
| R09 | `packages/server/src/routes/servers.ts:104–169,1258–1373` | action/status映射、命令与handoff |
| R10 | `packages/shared/src/serverSlugValidation.ts:1–41` | 唯一已确认slug规则 |
| R11 | `packages/server/src/services/channelService.ts:158–255` | 系统频道、announcement幂等、隐式成员 |
| R12 | `packages/web/src/store/serverStore.ts:325–348,366–432,505–551`；`packages/web/src/components/auth/ServerSelector.tsx:24–85`；`packages/web/src/App.tsx:610–780` | create/select的下游调用与页面路由 |
| R13 | `packages/cli/AGENTS.md`；`packages/cli/src/commands/server/info.ts:132–139`；`packages/shared/src/agentApiContract.ts:2037–2055` | agent-facing合同不同于人类REST |
| R14 | `packages/server/src/routes/servers.ts:1041–1071,1177–1209,2208–2419`；`packages/server/src/services/serverService.ts:987–1201` | owner角色、ownerId、延后成员管理复杂性 |
| R15 | `packages/server/src/services/serverService.ts:570–596,651–710`；`packages/server/src/routes/servers.ts:1795–1817` | 成员目录与邮箱隐私 |
| R16 | `packages/server/src/services/serverService.ts:15–35,1617–1860`；`packages/server/src/routes/servers.ts:1963–2205` | 侧栏偏好完整合同/清洗/CAS |
| R17 | `packages/shared/src/index.ts:3270–3286,3353–3363`；`packages/server/src/services/planService.ts:398` | trial与计划历史窗口 |
| R18 | `packages/server/src/services/featureFlagService.ts:40–41,421,673`；`packages/server/src/services/serverService.ts:236–254` | 旗标键/缺省false/旧wizard求值 |
| R19 | `packages/server/src/services/serverSetupStateService.ts:694–739` | 官方Agent usable定义 |
| R20 | `packages/server/src/routes/servers.ts:222`（emitServerOrderUpdated）、`:743–771` | server_order:updated条件广播 |
| R21 | `packages/server/src/services/serverService.ts:1403–1436` | handoff会员与账号时间戳 |
| R22 | `packages/web/src/components/onboarding/ServerSetupProjectionGate.tsx:85–357`；`packages/web/src/components/onboarding/serverSetupProjection.ts:5–114`；`packages/web/src/store/socketBridge.ts:353–362` | UI投影合同、机器读取、底层初始化 |
| R23 | `packages/server/src/services/serverService.ts:504–545,984–1050`；`packages/server/src/routes/servers.ts:1455–1482` | onboarding配置setter的独立checkpoint/reconcile语义 |

- W1：SQLite 官方 Transaction：<https://www.sqlite.org/lang_transaction.html>。用于短写事务、单写者与 BEGIN IMMEDIATE 的设计依据。
- W2：SQLite 官方 ALTER TABLE：<https://www.sqlite.org/lang_altertable.html>；CREATE TABLE：<https://www.sqlite.org/lang_createtable.html>。用于增量schema、表重建、约束与排序规则。
- W3：Socket.IO 官方 Introduction：<https://socket.io/docs/v4/>。用于区分普通WebSocket与既有Socket.IO协议。

以上技术依据不代表本期已经实现相关能力。最终兼容判断以固定版本的可执行测试与实际客户端验收为准。
