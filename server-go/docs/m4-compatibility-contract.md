# M4 原 Web 兼容合同与接口清单

日期：2026-10-08。状态：**源码核对后的待实施合同，不是已实现 API 清单。** 基线为当前 `feat/go-server` 的 TS/Web 源码；实现时 P0 将它冻结到 revision 和执行式 fixtures。主设计：`phase-4-messaging.md`；工作分派：`m4-implementation-coordination.md`。

## 1. HTTP 的公共前置条件

原 Web 的 axios 自动发送 `Authorization: Bearer <access-token>` 和 `X-Server-Id`（`packages/web/src/api/client.ts:26–37`）。TS 的 message/channel 挂载经过 requireAuth、requireVerified、requireServer（`packages/server/src/app.ts:557–579`）。Go 继续核验真实会话、邮箱、资料与 workspace membership；请求 body 中的 user/server/sender 字段不能替代 principal。

no-ID 的 user 级 `/api/servers/unread-summary` 与 URL-scoped 的 `/api/servers/{id}/...` 不混用。新增 literal 路由不能再次被动态 `{id}` 捕获。所有消息、DM、线程、reaction、已读、sync、Socket 共用同一套**基础内容授权**，但不把内容读取权和消息流订阅混为一个布尔值。线程 HTTP history/context 与显式 `join:channel` 检查父链读取权；`GET /messages/sync` 与 Socket resume 另要求有效 `thread_follows`，这是原 TS 的投递兴趣过滤，不是第二套可以绕过父链的权限。仅打开线程不自动 follow。实时受众见 §4.3；私有 payload 的 scope 不从客户端任意 room 名推断。

## 2. 必须匹配的 HTTP 表面

表中的“本期”是本方案的范围决策，不意味着 TS 的全部同名服务被照搬。

| 方法 / 路径（含 `/api`） | 请求/响应合同 | M4 决策 | 源码 |
|---|---|---|---|
| `POST /v2/messages` | `{channelId,content,randomId?,mentions?,attachmentIds?,asTask?}` → **`{message,pendingMentionActions?,unresolvedMentionHandles?}`** | 必须；人类文本；未启用副作用在提交前拒绝 | `routes/messages.ts:1657–1794`；Web `messageStore.ts:2483` |
| `POST /messages` | 同 body；通常裸 Message，v1 pending actions 才用 envelope | 兼容别名，与 v2 共用领域用例；不能强迫 Web 改回 v1 | 同上 |
| `GET /messages/channel/{channelId}` | `limit` 默认50/最大200；`before` 与 `after` 互斥；响应 MessagePage，见 §3 | 必须；最新页、历史和 overlay 同一路径 | `messages.ts:997–1158` |
| `GET /messages/context/{messageId}` | `channelId` query，目标前后约15条；scope 必须匹配；按原 context DTO fixture | 必须，用于引用/定位 | `messages.ts:845–904` |
| `GET /messages/sync` | `since_seq`、`channel_id?`、`limit` 默认200/最大500 → **Message 数组本身** | 必须；不误套 Socket resume envelope | `messages.ts:2130–2178` |
| `GET /channels/dm` | 当前用户可见的 DM 数组 | 必须 | `channels.ts:641–673` |
| `POST /channels/dm` | 原 body 是 `{userId}` 或 `{agentId}`，只能二选一 | M4 开放人类一对一及 self-DM；合法 `agentId` 分支在身份/scope/形状校验后返回501 `feature_not_implemented`，不创建会话；不把形状错误伪装成501 | `channels.ts:674–747`；Web `channelStore.ts:630,658` |
| `POST /channels/{id}/threads` | `{parentMessageId,content?}`；ensure thread + 可选首条回复 | 必须；不支持嵌套；同父消息并发返回同一 thread | `channels.ts:3979–4077` |
| `GET /channels/{id}/threads`、`GET /channels/{id}/threads/{messageId}` | 本频道线程摘要/按父消息查询；真实回复计数和最后回复 | 必须；不能恒返回 `{}` 掩盖已有回复 | `channels.ts:4078–4178` |
| `GET /channels/threads/followed`、`POST /channels/threads/follow`、`POST /channels/threads/unfollow` | 按原 thread DTO；本人关注及 authored/replied 自动关注 | 线程恢复需要的配套；Agent follower 操作后置 | `channels.ts:1360,1601,1653`；`messageService.ts:2640–2675` |
| `POST /channels/{id}/read` | `{seq}` → `{ok,maxReadSeq,readStateVersion}` | 必须；本人、当前 scope、版本化 | `channels.ts:3789–3824` |
| `POST /channels/{id}/read-all` | 按原本人 read-all body/DTO；覆盖当前授权快照 | 必须的本人路径；不支持代 Agent 执行 | `channels.ts:3827–3948` |
| `POST /channels/{id}/unread` | → `{ok,unreadCount,maxReadSeq,readStateVersion}` | 必须；与 read 竞争通过 revision 判断 | `channels.ts:3951–3974` |
| `GET /channels/unread?summary=1` | summary 为 `{channels:{...}}`，无 summary 为 map | 必须；数字来自可见消息，不是 seq 差 | `channels.ts:959–1008` |
| `GET /servers/unread-summary` | 当前账号所属空间的未读摘要；按原 DTO fixture | 必须；user scoped literal route | `servers.ts:775` |
| `GET/PATCH /channels/{id}/notification-settings` | PATCH `{activityMuted}`，读/写响应含 `activityMuted,muteFromSeq,prefsVersion` | 必须真实持久化；与读状态、频道权限分开 | `channels.ts:2338,2368` |
| `GET/PATCH /channels/{id}/message-display-settings` | 本人的显示偏好，按现有 response fixture | 聊天壳层配套；不能与 mute 复用不相干字段 | `channels.ts:2409,2423` |
| `POST/DELETE /messages/{messageId}/reactions` | emoji/actor 唯一、幂等 add/remove；按原 body/response fixture | **本方案明确纳入的增强切片**，不是原 M4 一句话定义天然包含 | `messages.ts:1983,2056` |
| `GET /messages/{messageId}/reactions/actors`、`GET /messages/{messageId}/reactions/viewer` | 共享聚合与本人 viewer snapshot 分开 | 随 reactions 一起交付，不能只做按钮不做恢复 | `messages.ts:1873,1958` |
| `GET /channels/activity/snapshot`、`GET /channels/activity/difference` | 原 `requestId/filter/windowId/epoch/afterWatermark` 合同；snapshot、difference、notModified、409 snapshotRequired | 必须；人类会话真实投影与持久变更窗口，详见 `m4-activity-readstate-contract.md` | `channels.ts:1013–1109`；`activitySyncService.ts` |
| `GET /channels/inbox` | 真实 items、分页、计数、filter/channelId/q/sort | 必须；普通频道、人类 DM、线程子集；不是恒空兼容壳 | `channels.ts:1112–1197` |
| `GET /channels/inbox/done`、`GET /channels/inbox/unfollowed` | 本人完成/取消关注记录的分页投影 | 必须；记录保留和权限过滤同时成立 | `channels.ts:1200–1257` |
| `POST /channels/inbox/done`、`POST /channels/inbox/undone` | `{channelId,throughActivitySeq?,frontierSpace?}` / `{channelId}` | 必须；Done 的412/400/409边界与恢复新消息规则不能省略 | `channels.ts:1259–1334` |
| `POST /channels/inbox/read-all` | 当前 workspace 本人的批量已读，返回 `{ok,markedCount,scopes}` | 必须；同一快照边界推进，不能替别人或 Agent 标读 | `channels.ts:1337–1357` |
| `POST /channels/threads/done`、`POST /channels/threads/undone` | `{threadChannelId,throughActivitySeq?,frontierSpace?}` / `{threadChannelId}` | 必须；Done 不等于 unfollow；新回复可恢复 active | `channels.ts:1681–1834` |

**发送限流同样属于合同。** 原 TS `app.ts:519–532, 566–579` 对 message 路由的非 GET 请求使用同一个 `messageLimiter`：每用户每60秒60次，v1/v2 共用桶（已实现的 reaction 写入也经过此桶），429 为 `{error:"Too many messages, please slow down"}`，保留标准限流与重试响应头。Go 测试可注入时钟/测试限额，但不能在产品配置中默认关闭；幂等重试也可能得到429，客户端保留原 randomId 后重试，不能通过换别名或 workspace 绕限流。该限制与 Socket 入站事件限流是两层不同机制。

暂不新增消息文本编辑/删除：本次核对的 TS `messages.ts` 没有 `PATCH/DELETE /messages/{id}`，DELETE 仅是 reaction 删除；Web 也没有对应文本编辑/删除写入。`message:updated` 目前承载 reaction/action/task 等聚合变化，不能由事件名称反推存在这些 CRUD 功能。

对表内未逐字段抄录的大 DTO，P0 的交付是**原处理函数执行出的真实 response fixture + Go 投影对照测试**，而不是开发者根据名称自由设计。尤其 Activity/Inbox、thread summaries、reaction viewer 有独立版本/权限语义，不得只返回一个“看起来差不多”的对象。若 P0 确认必须恢复整个 M6 子系统才能支持某个增强项，应将该项作为明确的 scope 变更重新签收，不扩成隐形全量迁移。

## 3. Message 与历史覆盖合同

### 3.1 输入与写幂等

正文是非空字符串，trim 后不能为空，最多 **32000 个 JavaScript UTF-16 code units**；`randomId` 有值时是1–128个字符的非空字符串。UUID、mention 类型及 name 长度按原 parser fixture 对照，不能用 Go byte length 直接替换 JS length。

原 TS 的幂等索引是 `(sender_type,sender_id,random_id)`（`messageService.ts:2390–2434`），不以 workspace 重置同一发送者的随机键。Go 使用同一作用域；重放还必须验证当前空间/频道授权及请求摘要。相同随机键指向别的频道/内容时409 `random_id_conflict`，不得跨空间读回原消息内容。

M4 不接入 Agent 投递。为空/缺省的 `attachmentIds`、false/缺省的 `asTask` 可视为未请求副作用；非空附件、true任务、需要执行的结构化 Agent mention 在写入前返回明确未启用错误。普通 `@foo` 文本不能自行触发 Agent。**本方案纳入人类结构化 mention**：仅解析 `type:user`，事务内核实目标在当前 workspace 且有对应会话读取权，持久化稳定目标 ID；影响本人的 mention/unread 投影以及 mute 的原有例外规则，不新增成员/权限、不发送外部通知。名字从当前目录投影，不能凭客户端 name 冒充另一个人。包含任何需要 Agent 行为的结构化 mention 时，整次写入在提交前501，不部分接受；混合 user/agent 请求同样如此。P0 用原 parser/mention resolver 的可执行 fixture 钉死重复目标、无效目标、正文提及与结构化列表的差异和错误映射，不允许实施者另行选择“接收后忽略”。

### 3.2 消息共享事实与私人投影

共享 canonical 必需字段（`packages/shared/src/canonicalMessageManifest.ts:96–133`）：

```text
id, channelId, content, createdAt,
senderType, senderId, messageType, seq,
randomId: string | null,
threadId: string | null
```

`threadId` 是**父消息指向其 thread channel 的 ID**；回复本身的 `channelId` 为该 thread channel，回复的 `threadId` 通常为 null（M4 不允许嵌套线程）。`parentMessageId` 是线程频道记录的反向引用，不能把它填入 Message.threadId。创建线程会改变父消息的投影/摘要，不能分配一个新 create seq 冒充新父消息。

`seq` 是消息创建序号，wire 为安全整数。sender 名称/成员状态、mentions/reactions/attachments/conversationContext 等按原字段 presence 规则投影：**缺字段通常表示保留旧聚合，显式空数组则表示清空**，不能混用。`updatedAt` 不是原 Web canonical 判新保证。

reaction viewer、attachment commentCount、本人 read/mute 状态不进入共享广播。HTTP/private snapshot 可包含经本人权限过滤的字段；不能将同一完整 HTTP DTO 不加区分地发往所有 channel sockets。

### 3.3 MessagePage 的精确形状

```text
{
  messages: Message[],
  threadSummariesByParentMessageId: Record<parentMessageId, ThreadSummary>,
  historyLimited: boolean,
  messageWindow: {
    schemaVersion: 1,
    domain: "receiver_visible_messages_v1",
    serverId, receiverKind: "user", receiverId, scopeId,
    coveredAfterSeq: number,
    coveredFromSeq: number,
    coveredThroughSeq: number,
    remoteHighWaterSeq: number,
    hasGap: boolean,
    hasNewer: boolean,
    completeThroughLatest: boolean
  }
}
```

源码：`messages.ts:1138–1154`、`services/messageService.ts:6382–6478`。历史页无论 latest/before/after，messages 都按 seq 升序呈现。边界与页面须来自同一一致性数据库快照，不分别读两次再拼“无洞”结论。

`coveredAfterSeq` 是本频道里第一条返回消息的真实前驱，不是 `firstSeq-1`（其他频道会占用全局 seq）。`remoteHighWaterSeq` 是这个频道的已提交边界。原空页为 `coveredFromSeq=H+1`、`coveredThroughSeq=H`；前驱按实际 channel snapshot 给出。只有 latest-tail 响应可 `completeThroughLatest=true`；原 before/after 保守地标 hasGap/hasNewer=true，不能仅因为一次 after 页碰到最新就伪造完整覆盖。

本地无计费历史截断时 `historyLimited=false` 只代表本地真实保留策略，不等于默认所有账号属于某个付费套餐。日后启用保留期时要让 history/sync/resume 一致，不能只截断一个接口。

### 3.4 三条恢复路径的返回形状不同

| 路径 | 返回 | 游标来源 |
|---|---|---|
| HTTP history/overlay | 上述 MessagePage | messageWindow 对频道覆盖作承诺 |
| HTTP `/messages/sync` | **Message[]** | Web 取消息 seq 循环，满页继续；不能加 envelope 破坏读取 |
| Socket `sync:resume:response` | `{messages,currentSeq,hasMore}` | Web 用 currentSeq 继续发 resume；见 §4 |

overlay 的原调用是 `/messages/channel/{id}?after={fromSeq-1}&limit=50`（`cache/overlayRefresh.ts:43, 285–310`）；`OVERLAY_PAGE_SIZE=50` 是 HTTP 单页大小，`OVERLAY_OPEN_MESSAGE_LIMIT=200` 是当前打开会话读取的本地缓存窗口，两者不能混用；这也不是一个尚不存在的新 `/overlays` 协议。重连只刷新当前最新窗口，旧页再次可见时刷新；不承诺非可见的所有历史缓存立刻更新。对这个原客户端可接受的陈旧窗口要在 UI 验收中明确说明。

## 4. Socket.IO wire 合同

### 4.1 建连

- 路径 `/socket.io/`，Engine.IO v4；**websocket-only 直连**，无 polling 先导步骤。
- 默认 Socket.IO namespace `/`；`auth = {token, serverId: string|null, clientKind:"web"}`。
- Web 依赖 auth 错误关键词触发一次 refresh；保留可识别的 `Authentication required`、`Invalid token type`、`Invalid or expired token`、`Not a member of this server`、`Authentication changed; reconnect required`，但不泄漏 token 或用户详情。
- 无 serverId 的账号连接不能订阅任何 workspace 内容。收到 serverId 也必须验证 active session+membership，不能只验证 JWT 签名。
- 候选 Go 库必须用锁定的原 `socket.io-client@4.8.3` 实际验证；README、raw WS demo 都不是通过证据。

### 4.2 核心事件

| 方向 / 事件 | Payload / ACK | 用途与安全 |
|---|---|---|
| S→C `rooms:joined` | 原实现无业务 payload；不是 callback ACK | 完整授权订阅后才发，客户端从此开始未读/Inbox/resume |
| C→S `join:channel` | 一个 channelId 字符串；无 ACK 合同 | 只允许当前 workspace 下可访问的会话 |
| C→S `leave:channel` | 一个 channelId 字符串 | 离开订阅不等于离开业务 membership |
| S→C `message:new` | 单个 Message payload | 提交后、对当前有权受众；HTTP echo 和 live 按 ID/randomId 合并 |
| S→C `message:updated` | 单个规范消息聚合 payload | 不改 create seq，不增加未读；private viewer 不广播 |
| C→S `sync:resume` | `{lastSeq}` | serverId 来自连接，不接受额外 body 冒充 scope |
| S→C `sync:resume:response` | `{messages,currentSeq,hasMore}`；原 limit500 | 分页、可见性过滤、currentSeq 有真实覆盖；不可返回全库“最大号”跳过未扫描可见行 |
| S→C `heartbeat` | `{seq,ts}`，原15秒 | seq 为本 workspace 已提交提示，ts 毫秒；不是 Engine.IO ping，也不是消息 ACK |
| S→C `dm:new` | **`{channelId}`**，不是完整 channel DTO | 只投参与者，客户端随后发 `join:channel` 并 HTTP 重拉 DM |
| S→C `thread:updated` | root/parent/thread 标识、replyCount、lastReplyAt、latestReply 等原 DTO | 非参与私有线程不能收到；恢复由 thread snapshots |
| S→C `channel:updated`、`channel:members-updated` | 原 channel DTO / 成员变更 DTO | 新建/授权后重新订阅；撤权不能只依赖通知 |
| S→C `read_state:updated`、`read_state:updated_bulk` | 按原 normalized read-state DTO，含版本 | 本人私有，workspace 绑定，多端旧响应不能回退 |
| S→C `unread_summary:changed` | `{serverId}` | 失效提示，接收端重读自己的真实摘要 |
| S→C `notification_prefs:updated` | `{serverId,scopeId,prefs:{activityMuted,muteFromSeq},prefsVersion}` | 本人私有，不给所有频道成员；prefs不能被平铺 |
| S→C `message_display_prefs:updated` | `{serverId,scopeId,prefs:{collapseLongMessages},prefsVersion}` | 只发本人+workspace；配套显示偏好 PATCH，多端去旧版本 |
| S→C `thread:followers-updated` | `{threadChannelId}` | 只发当前有权线程受众，客户端重读关注态；不能广播完整 follower 私人状态 |
| S→C `reaction_viewer:updated` | 当前用户的版本化 snapshot | private only；随 reaction 增强切片一起验收 |
| S→C `scope_read:updated` | 原 read receipt projection | 只在实现确切原权限/字段后启用，不把完整 read-state 私有行广播 |

所有 bridge 消费事件只读取**第一个 payload 参数**（`socketBridge.ts:139–142`）；不能把 DTO 拆成多个 Socket.IO 参数。上表不会把内部服务器间 ack(`access:revoked` 等)暴露成用户可发的特权事件；Go 单实例不需要复制 Redis 内部总线。

原 JS 客户端的 request/response 是具名事件，不是 `emitWithAck`。即使库支持 Socket.IO 协议 ACK，也不能把它解释为数据库提交、另一个浏览器已显示或 M5 Daemon 已消费。

### 4.3 房间与权限

原 TS 的 room 命名：`user:{id}`、`user:{id}:clientKind:{kind}`、`server:{id}`、`user:{uid}:server:{sid}`、`channel:{id}`（`socket/index.ts:207–240`、`socket/platformScope.ts:22–32`）。这些是适配层内部索引，不是授权事实。Go 可以内部用其他结构，但必须产生相同可见行为。

共享频道消息只投当前有权订阅者。线程所有路径首先要求根会话可读，再按原路径叠加兴趣规则：HTTP history/context 和显式 join 不要求 follow；全局或指定 channel 的 HTTP sync、Socket resume 都要求有效 follow。公开父频道下 live 使用有权 thread room（包括显式 join 的查看者）；私有/DM 父链下 live 按有权 follower 逐用户投递。follow/unfollow 管理自动订阅，不因一次只读打开而落关注行。P0/P4 必须验证“可读但未关注”“取消关注但仍可读”“父频道撤权”三者不同的 history/sync/live 结果，不能用一个通用可见集合机械替代。读/mute/viewer snapshot 用用户与空间的**交集**，不是分别向 user room 和 server room 发两次（那是并集，会泄漏）。

撤权覆盖 pending handshake、已入房间的 socket、正在读取的 resume 和待发队列。使用 transport close 让原客户端重新鉴权；不得只发 namespace 的 server disconnect 后假设 Manager 必定自动重连。已经在撤权前送上网络的字节不可收回，保证在于撤权提交后不再基于旧权限授权新数据。

## 5. 未启用能力的诚实响应

M4 未实现的 `asTask=true`、附件发送、Agent DM 创建、Agent mention action、Agent reply/delivery、搜索/转发/saved、joint、Office/reminders/runtime skills，按各自路由返回明确未启用，而不是返回空消息/假 task/假成功。已有真正实现的 M3 runtime catalog 与这些 future skills 不是一回事，不得一起关闭。

前端只将 **HTTP501 + `code:"feature_not_implemented"`** 识别为功能未启用。401/403、资源404、unknown-route404、500/网络失败保留错误路径。M3 补丁为已确认的 optional panels 添加了明确的授权后501；不把所有404认成缺功能。

所有 wire 错误都在具体 handler 中建立，不使用全局“未实现一律200”或全局错误吞掉。未知 API 保持404，错误 method 保持合理405/Allow，授权检查的顺序和对象不存在性按原路由 fixture。

## 6. 合同冻结的执行证据要求

P0 必须提供真实原处理函数/纯投影函数生成的非生产 fixture：普通消息/v1-v2响应、空页/满页/before/after/messageWindow、线程摘要、DM、新旧 read state、mute、reaction shared/private、关键错误。DTO 应由 Web 的现有 normalizer/reducer 实际消费，断言最终可见状态；禁止用 grep 源码有没有字段证明兼容。

另外用真实 socket.io-client 捕获 handshake、rooms、单 payload、resume 分页和 transport close 重连。每份 fixture 标注来源 revision、输入条件和收件 principal；不保存实际 token/密码/邮箱验证链接。升级时冻结本期 Go 二进制/SQL 起点，为 M5 保留独立消息与 delivery 的清晰边界。
