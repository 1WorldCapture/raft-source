# M4 详细设计：人类聊天、持久历史与实时恢复

- 日期：2026-10-08。
- 状态：**设计稿；本轮不实现 M4，不把设计条目计为已通过验收。**
- 基线：`feat/go-server`，M3 已提交基线 `d275cce25c251997ba872add84d6e75d3bef4df8`，加本轮 M3 UI 缺陷修复。修复代码与本方案分别验收。
- 总体方向：沿用 `architecture-and-phase-1.md` 的独立 Go Server、模块化单体、本地 SQLite、原 Web/CLI/Daemon 协议兼容；不混跑 TS Server，不引入 Redis/PostgreSQL/LLM 作为运行依赖。
- 配套文档：`m4-compatibility-contract.md`（接口与线协议）、`m4-activity-readstate-contract.md`（人类 Activity/Inbox、已读、Done 与持久差量）、`m4-implementation-coordination.md`（实施顺序、责任与验收门槛）。

## 1. 本期交付的产品闭环

两个经过邮箱验证、已完成资料、属于同一 workspace 的人类账号，通过原 Web 进入有权访问的频道，发送文本、查看持久历史和线程回复；对方无需刷新看到消息。刷新、切换空间、短暂断网、Go 进程重启后，消息与未读能够重新与数据库对齐。另一空间、已被移除的成员、非参与者的私信、无权进入的私有频道不能从 HTTP、Socket、补同步或计数侧面泄露内容。

M3 解决“人、空间、频道、Computer 与 Agent 身份存在”；M4 解决“人可以真实交谈”；M5 才解决“消息可靠到达 Agent 并得到回复”。给一个 Agent 发出 `@handle`、Socket emit 成功或 Agent 显示 online，都不是 M4 已完成 Agent 执行的证据。

### 1.1 范围分层

| 层级 | 本期处理 | 验收口径 |
|---|---|---|
| 必须闭环 | 人类文本发送；原 Web 的 v2 写入与旧版历史读取；随机幂等键；频道历史/定位/补页；Socket.IO；重连与重启恢复 | 两个真实账号、真实 Go 进程、原 Web，不能用模拟成功数据代替 |
| 必须配套 | 人类一对一与 self-DM；普通消息线程及人类 mention；本人已读与未读；workspace 未读摘要；Activity mute；原 Web 所需的最小 Activity/Inbox 和线程关注读取 | 不能拿永远为空的未读/Inbox 掩盖已有消息；按实际权限计算 |
| 聊天内的聚合变化 | 人类 reaction 的写入、聚合及本人 viewer 状态；线程最新回复/数量变化 | HTTP 返回与 realtime/reconnect 后一致；私人 viewer 状态不能进入公共广播 |
| 只复用，不扩写 | M3 Agent/Computer 生命周期及其状态广播；workspace/频道/成员变更的 socket 通知 | 仍由原业务模块拥有事实；M4 不接管 runtime、launch 或模型调用 |
| 明确不做 | Agent 消息写入/显式 @Agent 调度、可靠 delivery/ACK/retry、任务与工作流、联合频道、附件/转发/搜索/外部集成、Office 产品 | 相关写入明确拒绝，UI 给出未启用提示；不签署这些能力 |

源码核对确认：原 TS/Web **没有人类消息正文编辑/删除的写入接口**；`message:updated` 承载 reaction/action/task 等聚合变化，不是文本编辑/删除的证据。本期不擅自新增这两个产品功能。存储和缓存设计仍必须处理消息聚合更新与频道/消息不可见后的失效，不能把所有更新误当作新消息或增加未读。

范围增量说明：reaction 和最小 human Activity/Inbox 是本方案为了使原聊天壳层可用而明确纳入的增强切片，并不是原 M4 一句话定义自然要求全量实现的子系统。P4/P5 分别签收；若原依赖迫使重做任务/Agent 工作流，必须缩回已声明的人类子集或记录范围变更，不能隐形扩大为全量 TS 迁移。

Activity 的任务卡片、Agent 工作完成态、附件评论与 Office 不因原 UI 发起请求就自动纳入 M4。M4 的 Activity 子集只表达本期实际产生的人类会话/线程事实；其余能力必须通过明确的未启用边界呈现，不能伪造可用性。

### 1.2 原客户端兼容不等于原 TS 实现照搬

现有 Web `messageStore.sendMessage` 发送 `POST /api/v2/messages`，历史读取走 `/api/messages/...`；socket 初始化固定 `transports: ["websocket"]`，auth 为 `{token, serverId, clientKind:"web"}`。M4 必须兼容**真实消费方**，不是只写一组看起来合理的 REST 接口。

本轮 M3 的前端修复是用户报告的定点修复，不代表允许 M4 重写客户端。M4 默认不修改 Web/CLI/Daemon 源码、依赖版本和锁文件。若协议验证证明某项保证无法由原客户端实现，先形成“现有行为→无法满足的保证→最小客户端差异”的变更记录；不得偷偷新增客户端必填字段、改变 `seq` 含义或伪装成零改动兼容。

## 2. 已核实的基础与必须修复的接缝

| 基础 | 当前源码事实 | M4 动作 |
|---|---|---|
| 数据库 | `internal/platform/db/db.go` 使用 WAL、`synchronous(FULL)`、外键、最多 8 连接、`_txlock=immediate`；迁移遇到未知版本拒绝启动 | 沿用短写事务；不在业务事务里等待网络、Socket 或 Argon2 |
| 频道 | `channels` 已含 `dm/thread` type 和 `parent_message_id`；M3 没有线程消息用例 | 在 channel 模块补有证据的 DM/线程创建和递归权限，不另建相互矛盾的频道体系 |
| 权限 | `channel/access.go` 有非事务公开读取助手和事务内写检查；部分公开助手依赖 HTTP 已做成员预检 | 抽出显式、事务可用、缺 membership 必拒绝的聊天访问策略；禁止 Socket 直接调用“public=true”分支当完整鉴权 |
| 原 Web 重连 | `socketBridge.ts` 在 `rooms:joined` 后执行 `sync:resume`、未读/Inbox/频道刷新；重连还使历史 overlay 失效并刷新当前最新页 | 保持订阅完成屏障；新消息补同步和可见聚合快照分开验证 |
| 机器实时层 | M3 `/daemon/connect` 是原始 WebSocket，已有 generation 与 credential 撤销 | 不拿它冒充 Socket.IO，不改变 M3 wire 格式，不把浏览器恢复游标用作 Agent delivery 游标 |
| 实例识别 | `/version` 和 build headers 标识真正运行的二进制 | M4 实施完成后才升级 Stage；设计阶段仍是 M3。部署必须检查运行实例，不只检查磁盘上的新二进制 |

## 3. 模块与数据归属

```text
原 Web
  ├─ HTTP /api/v2/messages、/api/messages、/api/channels
  │       → legacyweb：解析/DTO/错误/请求上下文
  └─ Socket.IO /socket.io/
          → socketio：握手/连接/房间/有界队列/协议
                     │
       app 中的显式聊天用例组合（同一短事务）
          ├─ auth：当前 user + session family
          ├─ workspace：当前 membership/角色
          ├─ channel：可见性、DM、线程、频道成员
          ├─ message：消息事实、序号、随机幂等键、reaction
          ├─ readstate：已读事实、版本、mute、未读投影
          └─ realtime 发布接口：提交后通知；断线由持久读模型恢复

SQLite：唯一事实来源             machinews：保持 M3，M5 再接 delivery
```

建议新增 `internal/message`、`internal/readstate`、`internal/transport/socketio`。只有出现真实公共用例才抽 `internal/realtime`；不先建事件总线框架，不创造一个无所不包的 Orchestrator。`app` 仅组合用例和生命周期，业务模块不导入 app 或 transport。

channel 拥有频道与访问策略；message 不直接篡改 `channel_humans`，也不另写一套私有频道判断。创建线程涉及 parent message 和 thread channel 时，由应用用例用同一个 `*sql.Tx` 调用两个模块的事务方法。为避免 channel↔message import cycle，父消息归属查询通过小接口或应用层传入的经事务验证引用完成，不用全局 service locator。

建议明确的用例接口（名称可调整，但事务边界不可省略）：

- `CreateHumanMessage(ctx, principal, scope, input)`：鉴权、验证幂等键、写事实及必要聚合；返回提交后的 DTO 与发布引用。
- `ListHistory / Context / SyncVisibleMessages`：同一可见性策略，稳定排序和有界分页。
- `EnsureDirectMessage / EnsureThread`：检查全部参与者/父消息归属，唯一键使并发重试返回同一会话。
- `AdvanceRead / MarkUnread / SetActivityMute`：当前用户自己的版本化状态；不允许替别人标已读。
- `AuthorizeConversationTx`：返回基础内容访问权，包括 workspace、root channel、thread/DM 与有效角色，缺失任何父链即拒绝。`SelectSyncAudienceTx` 在此基础上叠加线程有效 follow；显式 history/context/join 不要求 follow。两者共用授权事实，但不能把读取权和订阅兴趣压成一个布尔值。
- `PublishCommitted`：仅接收已提交事实 ID/版本；传输失败不回滚已提交消息，也不导致同一 `randomId` 再建消息。

## 4. 数据设计与迁移

以下为逻辑 schema，落地时以当时的最新 migration 编号**追加**。本轮邀请修复**已使用 `0009_workspace_invitations.sql`**（工作树中的补丁，不代表已经提交 Git 或部署）。M4 从 `0010` 起由集成负责人串行分配；worker 不得各自抢编号或改写 0001–0009。

### 4.1 消息事实

`messages` 的核心字段：稳定 `id`；`workspace_id`；`channel_id`；`sender_type` 与稳定 `sender_id`；`content`；`message_type`；`random_id`（可空）；全库唯一 `seq`；`created_at`；必要的聚合 revision。原 wire 的 `threadId` 与 thread channel 的关系从 TS fixture 冻结，**不把 message ID、root message ID、thread channel ID 混为一谈**。

人类发送者必须来自服务端 principal，不能接受 body 中的 `senderId/senderType`。未来 Agent 可扩展同一消息事实，但 M4 不对 Agent token 开放写入。历史展示的 sender 名称/头像/成员状态采用原 DTO 的投影语义；不把脱离 workspace 的人偷偷恢复成当前成员，也不因 profile 修改而重写发送者 ID。

约束与索引：

| 对象 | 约束/索引 | 目的 |
|---|---|---|
| 消息序号 | `UNIQUE(seq)`；频道历史 `(workspace_id, channel_id, seq)` | 原 Web 稳定排序、跨频道补同步 |
| 写幂等 | 有值时 `UNIQUE(sender_type, sender_id, random_id)`，与原 TS 一致，并校验 workspace、channel 与请求摘要 | 重试只能返回原消息；同键异请求返回409冲突，跨空间冲突不泄漏原消息内容 |
| 消息归属 | 事务内验证 `channel.workspace_id == message.workspace_id`；可行时加复合 FK | 防止有效 channel ID 被拼到另一空间 |
| 线程根 | root message → 唯一 thread channel；并发唯一约束 | 双击 Reply/多端同时开线程不会生成两个线程 |
| DM 对 | workspace + 排序后的参与者类型/ID 对唯一；M4 开放人类一对一及 `(user,user)` self-DM | 参与者顺序不同仍返回同一 DM；self-DM 只写一条参与者关系，不产生重复未读/双重事件；不能跨空间配对 |
| reaction | `(message_id, actor_type, actor_id, emoji)` 唯一 | 幂等添加/撤销；数量取真实行而不是盲加减 |
| read state | `(workspace_id, user_id, channel_id)` 主键，read seq + unread override + revision | 多端/重试的有序合并 |
| mute/preferences | 同 user/workspace/channel scope；epoch/revision 按原消费方冻结 | 本人设置不混入其他用户共享状态 |
| mentions / follows / done | 消息→已验证人类目标；用户→线程关注及取消记录；scope 的 Done frontier | 从持久事实计算 mention、线程兴趣与 Done，不用前端按钮状态冒充事实 |
| Activity 差量 | 用户+workspace+filter+window 的 epoch/watermark、行版本和有限变更日志 | 与消息 create seq 分离；详情见 `m4-activity-readstate-contract.md`，禁止重用 publication ID 当客户端水位 |

### 4.2 三种序号，禁止混用

**`message.seq`**：消息首次创建的全库序号；频道内可以有空洞，不能用两个 seq 相减计算消息数。原 Web 用 JavaScript number，发送前必须在安全整数范围内，解析拒绝 NaN、小数、负值和越界值；不得默默截断 int64。

**聚合/状态 revision**：reaction、已读、线程投影等对象的变更版本。编辑聚合不能修改消息创建 seq，也不能生成“另一条新消息”来更新原消息。

**未来 delivery ID/cursor**：M5 每个 Agent 收件事实的游标，与前两者独立。M4 不创建一张假 ACK 表让 transport write 冒充消费完成。

序号建议由 SQLite 在**同一 IMMEDIATE 写事务**中更新计数器或分配持久主键。全体消息写路径使用同一机制；不在事务外预取批号，不用进程内 atomic counter，不因为某个 HTTP 响应晚到就认定此前序号未提交。数据库单写者与分配/提交规则需用并发及回滚测试证明；不要仅凭 SQLite 名称断言全局提交顺序。

### 4.3 迁移、回滚与已有 M3 数据

M4 启动只添加真实需要的表、索引和字段。已有 workspace、频道、Agent、Computer、会话、邀请记录全部保留；没有消息时是诚实的空历史，不补假欢迎聊天、不伪造未读或 onboarding DM sent。

必须用冻结的 M3 二进制生成旧数据，再由 M4 迁移，不得用 M4 SQL 手造旧表冒充升级。覆盖本轮邀请修复版 M3 与未打补丁 M3 两种起点。旧二进制遇到 M4 schema 应拒绝启动；回滚恢复匹配的旧二进制和完整冷备份，不做自动降级/清库。

SQLite 数据/密钥/头像/outbox 的备份遵循 M3 交接。现有 `var-m3-dev` 和 `var-backup-m2-20261008-1902` 是协作者的现场，不能在 M4 测试中自动删除、迁移或替换。

## 5. 发送与幂等的完整时序

1. HTTP 层解析真实 v2 body、body 大小和字段类型；拒绝本期不支持的 `attachmentIds`、`asTask`、需执行的 mention action 等，**在插入消息前**给出明确错误。普通正文中看似 `@name` 的文本本身不自动调度 Agent。
2. 校验真实用户会话和 workspace。进入 IMMEDIATE 事务后，再核验未撤销的 session、membership、当前角色、频道状态及父链权限，避免预检后排队降权仍可提交。
3. 对 `randomId` 做同作用域查重。同键同输入返回原提交结果；同键不同目标/内容不能悄悄成功。没有 `randomId` 的旧调用不能被宣称具有跨请求幂等保证。
4. 校验内容边界及原协议可空/空白语义；保留 UTF-16 与字节长度差异的 reference fixture。分配 seq 并写消息、必要的线程数量/最后活动和本次状态版本。用例失败全部回滚。
5. 提交后返回规范 DTO，并发出已提交引用。HTTP 与 socket 到达顺序不确定；原 Web 会以稳定 ID/randomId 合并乐观行，测试必须覆盖两种顺序。
6. 提交成功但 HTTP 响应丢失：重试返回同一消息/seq；提交成功但广播前崩溃：重启后 HTTP sync/history 必须找回。不能为了补广播再执行一次发送用例。

`POST` 成功仅承诺数据库已接受并持久化消息，不承诺另一个浏览器已看到，更不承诺 Agent 接收或任务完成。

## 6. 历史、上下文与断线补同步

### 6.1 频道历史

最新页/`before`/`after`/context 全用 seq 游标，不用易漂移的 offset。读取必须先确认 scope、当前访问权限和 thread root 归属；页内返回顺序、默认/最大 limit、边界是严格大于还是大于等于，以原 Web fixture 固定。context 的 `messageId` 与 `channelId` 必须相互匹配，不能通过一个公开 channel ID 读取私有消息。

数据库封装应区分 IMMEDIATE 短写事务与只读一致性快照。当前默认 DSN 的 `_txlock=immediate` 不可未经验证直接用于所有 history 读取，否则长历史快照可能占用写者位置；P1 必须验证只读 deferred transaction/专用只读连接的实际驱动行为、WAL 可见性和关闭回收，再提供统一 helper，不能在各 handler 手写不一致的 BEGIN。

后台已有更大 seq 不代表当前频道有消息，也不代表用户可以见到那些消息。`hasMore` 用授权后的额外一行或覆盖扫描计算，不能用全库计数推测。遇到越权行、tombstone 或不可见频道，既不泄漏内容，也不能让分页无限停在同一 cursor。

### 6.2 保持原 `sync:resume` wire

请求为 `{lastSeq}`；响应为 `{messages, currentSeq, hasMore}`。原客户端通过 `currentSeq` 连续拉页，并用 `batchAddMessages` 合并真实消息。不得把一个没有被原客户端认识的 mutation/event cursor 塞进 `currentSeq`，也不得要求原客户端凭空发送新恢复字段。

建议实现：在一个一致性读取边界固定已提交高水位 H，按当前 workspace、基础内容授权及**本路径的订阅兴趣集合**扫描 `(lastSeq,H]`。普通频道/DM 按原规则，线程还必须有有效 follow；HTTP `/messages/sync`（含指定 channel）与 Socket resume 共用此过滤。可读但未关注的线程通过 history/context 获取，不因读取而自动进入补同步流。有下一页时，`currentSeq` 至少覆盖已处理的扫描范围且严格前进；无下一页时覆盖至 H。每页最多返回约定 limit 的可见消息，并限制扫描工作量；扫描预算耗尽也必须能前进和继续。跨请求的 H 可以重新取，但每次对返回的覆盖承诺必须真实。H 取 workspace 范围的已提交序号，不暴露其他 workspace 的活跃信息。

`currentSeq` 表示**本次授权集合下已经覆盖的范围**，不是“该用户看过所有 seq”。以上覆盖扫描的前进语义是 Go 的明确实现决策：原 TS 取本页最后可见消息 seq，空页保持 lastSeq；Go 只有在已证明覆盖到 H 时才能前进到 H，并须在 P0 用原 reducer 验证兼容，不能直接返回未经扫描的 maxSeq。权限新增后，旧 cursor 之前的可见历史通过新频道 snapshot/history 加载；不能期待单纯 `seq > lastSeq` 自动找回刚获得权限的旧消息。

对于权限在读取到发出之间发生变化的连接，舍弃旧快照并关闭 transport 触发重新鉴权；不能把未经当前权限核验的历史队列继续交付。没有 serverId 的账号级连接只承担账号级事件，不允许 resume 任意 workspace。

### 6.3 不能只回放新增消息

现有 `socketBridge` 已在断线时使历史 overlay marks 失效，重连刷新当前最新约 200 条，旧页再次可见时再刷新。因此 M4 恢复分两层：

- 新消息：`sync:resume` 与 HTTP `/messages/sync` 按 seq 补齐。
- 已有消息的 reaction/线程聚合/其他 viewer overlay：使用原客户端真正调用的 snapshot/overlay 读取重新投影，不能改写 create seq 来混入新增消息流。

必须验证“离线期间 reaction 改变，重连后当前页正确；旧页滚入视区后正确”。如果冻结的实际调用缺少某个必需恢复路径，P0 就明确该差距，并决定补兼容快照端点或走独立评审的最小客户端改动；不能到发布时才把遗漏叫作限制。

### 6.4 重连建立的无缝交接

握手验会话/成员 → 记录 pending connection → 建立当前用户有权访问的房间 → 再核验 membership/权限版本 → 发布连接 → 发 `rooms:joined` → 客户端拉快照和 resume。不能一连接就先发 `rooms:joined` 再异步建房间。

允许 live 与 resume 重复同一稳定 ID，由客户端已有合并逻辑去重。禁止“先 history 后 join”留下空窗。断线期间的服务端事件不能只留内存；消息恢复依据数据库。Socket.IO 的短期 connection state recovery 如被候选库支持，也只是优化，默认不依赖，不允许恢复旧 rooms 时跳过鉴权。

## 7. Socket.IO 适配层

### 7.1 协议与候选库

当前锁文件的 Web client 为 `socket.io-client@4.8.3`，使用 Socket.IO 应用协议而非裸 WebSocket。M4 首个技术门槛是**独立协议 spike**，在真实原客户端下验证，再向主 Go module 引入依赖。

候选优先考察 `github.com/zishang520/socket.io/servers/socket/v3`：上游目前为 v3 模块化实现，声明面向 Socket.IO v4+。不沿用旧教程里的 `/v2` import，也不依据 README 就宣布适配成功。本轮只核查上游资料，**未在 Raft 执行该库的兼容测试、未安装到主 module**。实施时锁定实际通过测试的 tag/checksum，记录 Go 最低版本、许可证、依赖和漏洞检查。

不选用仅按旧版 JS 客户端兼容性介绍的 `googollee/go-socket.io` 直接开工。另一个候选可在首选 spike 失败时评估；不能为了绕过库问题要求 Web 改成裸 WebSocket。库应只负责协议，不成为领域状态存储或隐式多实例架构。

原 Web 的验收必测 websocket-only。Engine.IO polling/upgrade 只有在宣称支持时才纳入兼容承诺；M4 可以显式限定传输，不得向不支持的 transport 返回伪握手。关闭 WebTransport、额外 namespace、未用 adapter 和二进制消息功能；保持 net/http 的 Origin、body、日志和 ResponseController/upgrade 兼容。

### 7.2 生命周期与背压

每个 socket 持有不可变连接身份 `{userId, sessionFamily, workspaceId, generation}`；传入 body 不能覆盖身份。auth token 不写入 query/log；握手 Origin 依据配置允许列表检查，不能从任意 Host 推导。

有界入站尺寸、事件频率、每用户连接数、每连接待发送消息数/字节数与发送 deadline。建议首轮测试参数：事件 JSON 上限 64 KiB、消息正文按原契约更小的上限、每连接 256 个待发 envelope 且最多 1 MiB；这些是待压测的初始值，不是已验证容量指标。超限明确断开，让客户端重连补同步；不得静默丢一条后继续报告完全同步。

连接/心跳/恢复任务必须绑定 generation 和 context。关闭时取消 timer、release room 引用和 pending handshake；net/http Shutdown 不会自动回收 hijacked sockets，仿照 M3 machine hub 注册显式 shutdown hook。测试 race、重复断连、慢客户端及 goroutine 稳定性。

应用层 `heartbeat {seq, ts}` 与 Engine.IO ping/pong 是不同协议层；前者用于发现数据库事实落后，后者仅检测传输。它们都不是消息 ACK。

### 7.3 发布可靠性：本期不虚构“已送达”

**本方案选择轻量事务性 publication outbox**，不采用只有内存 emit 的实现。`realtime_publications` 与消息/读状态等事实在同一事务插入，字段限于 publication ID、workspace、对象类型/ID、事件类型、对象 revision、created_at、published_at 与重试计数；不存永久的接收者私密 payload 或陈旧受众列表。幂等键为 `(object_type,object_id,revision,event_type)`，publication ID 与 `message.seq` 分离。单进程 worker 启动时扫描 pending 行、提交后 wake 并做低频兜底扫描；出队重新投影、鉴权并送入有界连接队列。

发布成功后才标 `published_at`；此标记仅表示已处理到本实例传输队列，不叫 delivered/consumed。崩溃导致重发时允许重复，客户端以稳定 ID/版本合并；某个慢连接排队失败则断开该连接，交由原恢复路径找回，不阻塞全部收件人。对象已删除或当前无有权在线受众时可完成本次 publication，未来连接通过持久事实恢复。瞬时数据库/投影失败保持 pending，指数退避并有指标告警；不能无限占用写事务。

已发布行按保留策略分批清理，未发布行不因 TTL 静默删除；积压达到明示限额时使 readiness/新写入准入降级并告警，避免无人在线时无限堆积。M4 不实现通用消息中间件、跨实例 lease 或每个 Agent 的 delivery ACK。HTTP 成功仍只承诺数据库事实与 publication 已提交，端到端看到消息靠 live 加数据库恢复；P6 必须覆盖 enqueue/标记之间崩溃和重复发布。

## 8. 安全与撤权

### 8.1 统一授权矩阵

所有路径统一检查 active session、workspace membership、频道所属空间、当前频道类型和有效权限。owner/admin 不自动读取没有参与的私信，也不以 workspace 管理权限绕过私有内容边界。guest 继续遵循既有 feature gate；本期不能因为做了邀请就顺手把 guest gate 打开。

线程的**基础读取权**继承根会话权限，消息流再按用途叠加兴趣过滤：history/context/显式 join 不要求关注，HTTP sync 与 Socket resume 要求有效 follow；公开父频道的 live 走有权 thread room，私有/DM 父链的 live 走有权 follower。仅打开线程不能自动写关注关系。必须验证父消息存在、父频道属于当前 workspace、链无环且深度有界。离开父私有频道后不能只凭保存的 thread ID 继续订阅。DM 仅参与者可见；普通频道公开仅表示对**本 workspace 的有权成员**公开。

### 8.2 撤销窗口

覆盖 logout、密码重置、session family 撤销、移除成员、降权、频道公共转私有、私有成员移除、归档/删除、guest policy 变化。M3 这些操作需接到 socket 撤权钩子，不能只防新握手。

pending handshake、已建立连接、待发队列、resume 任务都必须受控。设计一个短临界区的 authorization generation/fence：撤权写事务与 publication 资格确认协调，提交后使旧 generation 不再有权发布，清理应用队列并关闭 transport。不要只执行 `leave(room)`，因为其间的直接 send 和握手竞态仍可能绕过。

明确保证边界：撤权提交后不能再基于旧权限授权新的 payload；已经在撤权前授权并交给网络/客户端的字节无法收回。不得宣称能撤回已发送数据。严格检查发送时权限，也不能在数据库事务内等待网络 write。

原 Web 依赖 transport 关闭后自动重新鉴权；直接发送 Socket.IO namespace 的 server-disconnect 可能阻止自动重连，必须在 spike 用原客户端验证断开方式。撤权失败/数据库不可用时 fail closed，不带着旧 rooms 继续运行。

### 8.3 隐私与信息侧信道

全库 `seq` 和原协议的 workspace heartbeat 高水位仍可能暴露粗略活跃度/序号空洞，不能宣称绝对消除了计时与流量侧信道。本期保留原 wire，以内容/资源/明确未读计数的授权隔离为边界；更强的流量隐藏需要 per-receiver opaque cursor 等独立协议设计，不偷偷塞进 M4。

共享 `message:new/updated` 只包含共享事实；reaction viewer、读状态、mute 等只发用户+workspace 的私有范围。不要把完整 receiver-private HTTP DTO直接广播到 channel room。

未读/Inbox/搜索式定位不能显示不可见消息数量、私有频道标题或 DM 参与者。日志只记录请求 ID、已脱敏对象引用、错误码、耗时/计数；不记录正文、邀请链接、auth token、邮箱验证或 deviceCode。调试 trace 字段不能作为客户端可写业务事实进入持久化。

## 9. 未读、已读、Mute 与 Activity

`lastReadSeq` 是当前会话的已读边界，不是全局消费游标；默认推进单调，手动“标未读”作为独立 override 和新 revision 表达，不能靠随意减 seq 与并发 ACK 竞争。读取与变更均绑定本人 principal。

未读由有权可见且符合原 UI 计数规则的消息计算，排除本人发送/无效系统事件的具体规则由 reference fixture 固定。不能用 `maxSeq - lastReadSeq`；其他频道、删除项和不可见行造成空洞。多端用对象 revision 接受更新，旧响应不得覆盖新已读状态。

Activity mute 是本人的展示/通知偏好，不删除消息、不撤销频道权限、不停止 Agent，也不能伪造“已读”。本期实现它的真实持久化与 `notification_prefs:updated` 的正确作用域；强制数据库故障时应报真实错误，而不是仍显示“未启用”。

`/api/servers/unread-summary` 的 no-ID 路由必须排在动态 workspace 解析之前，按用户实际 membership 聚合；不能再次被 `:id` 当 workspace 读成 404。Activity/Inbox 是聚合视图，不是可写 conversation scope；人类消息只能写到明确的真实频道、DM 或线程。

**M5 前置 UI 回归修正（2026-10-08，America/Los_Angeles）：** 上一版将 `#all` 与 Activity 并列为不可写聚合面，错误地收紧了原客户端契约。启用状态下的真实系统频道 `#all`/`#announcement` 采用工作空间隐式成员制：符合现有账号/成员门禁的 owner/admin/member 不需要物理 roster 行即可发帖，不要求用户显式 join，也不回填虚假成员行。隐藏的 `#all`、归档/删除频道、非空间成员和被现有 guest 策略拒绝的主体仍不可写；普通公开/私有频道的显式加入要求、DM 参与者限制和线程继承根会话权限保持不变。`joined: true`、成员投影和发帖授权必须表达同一事实；这里不是引入“只有管理员可发公告”的新策略。具体修复和验收状态以 `m5-ui-feedback-triage.md` 及 M5 交接记录为准。

Activity/Inbox 的人类子集与纯频道聊天分别签收：频道聊天先通过并不意味着 Inbox、Done、Agent 任务流或 Office 都通过。本方案明确把 human snapshot/difference、active/done/unfollowed 列表、本人 read-all、频道/线程 done/undone 纳入 P5；逐端点范围、状态表、frontier 错误、增量 epoch/watermark 与降级行为见 **`m4-activity-readstate-contract.md`**。任务/Agent 卡片、联合频道及全文搜索不随此引入；Inbox 自身的 q 列表筛选是原壳层必需的读取，不等于实现全局消息搜索。禁止总是返回空集合“降噪”。

## 10. 验收策略与观测

完整实施门槛见 `m4-implementation-coordination.md`。本设计最低要求包括：

- 原客户端协议：真实 `socket.io-client@4.8.3`、websocket-only、auth 失败/过期/刷新、rooms 屏障、心跳、resume 分页；不能用自制 raw-WS client 替代。
- 原业务路径：两账号邀请加入、公共/私有/DM/线程、人类发送的 HTTP/socket 顺序变化、随机幂等重试、真实持久历史。
- 并发与安全：写预检后撤权、pending 握手撤权、resume 到出队之间撤权、workspace 切换、同消息多 reaction/读状态乱序。
- 崩溃窗口：插入未提交、提交后 HTTP 前、提交后广播前、恢复分页中；重启不丢已提交事实、不重复消息、不继承幽灵连接。
- 恢复与聚合：消息超过一页；其他空间/不可见频道造成 seq 空洞；离线期间 reaction/线程变化；恢复最新页及旧页；新获得频道权限后的旧历史。
- 运维：M3→M4 升级/冷备份恢复/旧程序拒绝新 schema；CGO-free Linux/Windows 构建与明确的运行验收区分；race、限流、慢客户端、关闭回收。

建议记录不含正文的计数/直方图：消息提交/幂等命中/冲突/拒绝、事务等待、history/sync 行数与扫描数、resume 页数/覆盖前进、活跃/pending sockets、每连接队列字节、慢消费者断连、撤权断连、read-state revision 冲突。不要用 message ID/用户 ID 做高基数 metrics label。

容量测试采用明示的合成负载而不是预先承诺性能：例如 100 个 Web socket、10 msg/s、10 万条历史、1% 慢消费者，记录 p50/p95/p99、RSS、goroutine 与恢复正确性；这些数字是测试起点，**不是本轮测得容量**。

## 11. 发布与交接

只有全部必需门槛通过，才把 build Stage 从 m3 改为 m4，并更新已启用路由/preflight/阶段边界。每次联调先检查 `/version`、`/healthz`、`/readyz` 及 Vite proxy，记录实际 buildTime/revision/modified；工作区 HEAD 不能代表当前监听进程。

发布前优雅停止目标实例并完整冷备份，再启动同一套签名密钥与迁移后的数据。测试使用新目录/独立端口；不得把测试脚本默认指向 4301 现有实例。后端报告只签后端证据；UI 协作者必须用两个账号和另一空间完成可见性/恢复验收，保留截图与实际请求证据。

M4 交接必须回答：支持哪些原 UI 操作、未启用哪些；运行的是哪个构建；数据库升级如何恢复；断线遗漏如何找回；明确哪些信息只代表 persisted/queued，尚不代表 Agent delivered/consumed。

## 12. 源码与外部依据

本仓库来源（实施前冻结到具体 revision，并在协议文档补端点范围）：

- `server-go/docs/architecture-and-phase-1.md:26–80, 169–181`：模块边界、seq 与投递边界、M4/M5 分期。
- `server-go/docs/phase-3-backend-handoff.md:9–28`：M3 已实现能力与后续边界。
- `server-go/internal/platform/db/db.go:60–128`：连接池、WAL/FULL、IMMEDIATE 事务。
- `server-go/internal/platform/db/migrations/0003_workspace_foundation.sql:65–114`：频道/成员模型。
- `server-go/internal/channel/access.go`：公开读取前置条件、guest gate 与 DM/线程接缝。
- `packages/web/src/api/socket.ts:23–49`：真实 socket auth 与 transport。
- `packages/web/src/store/messageStore.ts:2481–2578`：v2 写入、randomId、乐观消息合并。
- `packages/web/src/store/socketBridge.ts:922–1079`：rooms 屏障、resume、overlay 恢复。
- `packages/server/src/socket/index.ts:69–305`：TS 参考握手、撤权、房间、resume/heartbeat。
- `packages/shared/src/canonicalMessageManifest.ts:96–236`：共享事实与 receiver-private 字段边界。

外部资料核查于 2026-10-08；只用于协议约束与候选库评估，不是 Raft 执行测试证据：

- Socket.IO delivery guarantees：<https://socket.io/docs/v4/delivery-guarantees/>。
- Socket.IO server options / connection state recovery：<https://socket.io/docs/v4/server-options/>。
- Engine.IO v4 协议：<https://github.com/socketio/engine.io-protocol>。
- 候选库与 v3 模块：<https://github.com/zishang520/socket.io>；升级说明：<https://github.com/zishang520/socket.io/blob/main/docs/UPGRADE.md>。
- 旧实现自身的兼容性/归档说明：<https://github.com/googollee/go-socket.io>。
