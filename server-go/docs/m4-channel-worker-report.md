# M4 P1/P4 — Channel & human conversations worker report

- 执行者：Channel worker（P1 统一权限 / P4 人类 DM + 线程产品路径）。
- 基线：`bc65213`（M3 提交点）+ 父集成人新增的 `0010_messaging_foundation.sql`、`db.WithWriteTx/WithReadSnapshot/WithAuthorityRead`、`auth.ValidateHumanTx`、`realtime.Enqueue`、`legacyweb.accessClaims`。
- 本文按执行锁要求**先行发布跨模块 API**，消息/readstate worker 可立即据此编译；文末记录实际测试命令与结果（执行后更新）。
- **2026-10-08 集成复审修订**：按父集成人指令修复五项偏差（follow 同事务已读接缝、followers-updated 发布键碰撞、dm:new 复活幂等、#all/#announcement 写入范围、hiddenDmIds/readstate 后端契约），并采纳跨切片审查 A9 的 posting 错误优先级修正。变更明细见 §1.2/§2.1/§3。
- **2026-10-08 第三轮集成修订（channel list/detail/create 投影）**：所有权扩展至 `legacyweb/channel_handlers.go`、`legacyweb/channel_dto.go`。原 M3 出口硬编码 readState absent/cursor 0/默认 mute/display/lastMessage null，M4 有真实数据后刷新会覆盖原客户端状态。新增每读一次的 `M4ChannelProjector` 接缝（同一 pinned snapshot），见 §2.3；保留父层对 `HasPriorChannelRelationshipTx` 的 0011 残留扩展并补齐见证测试，见 §2.4。

## 1. 冻结的跨模块 API（internal/channel，已实现）

```go
type Conversation struct {
    Channel *Channel        // 请求的会话频道；线程时为 thread channel
    Root    *Channel        // 父链根会话（非线程时等于 Channel）
    ParentMessageID string  // 仅线程非空
    Role    string          // 调用者当前 workspace 角色
    IsMember bool           // Root 上的 channel_humans 显式成员行
}
func (s *Store) AuthorizeConversationTx(ctx context.Context, ex Executor,
    workspaceID, channelID, userID string, posting bool) (*Conversation, error)
func (s *Store) SelectSyncAudienceTx(ctx context.Context, ex Executor,
    workspaceID, channelID, userID string) (bool, error)
func (s *Store) ListSubscriptionsTx(ctx context.Context, ex Executor,
    workspaceID, userID string) ([]string, error)
func (s *Store) EnsureDMTx(ctx context.Context, tx *sql.Tx,
    workspaceID, userID, otherUserID string) (*Channel, error)
func (s *Store) EnsureThreadTx(ctx context.Context, tx *sql.Tx,
    workspaceID, channelID, parentMessageID, userID string) (*Channel, error)
func (s *Store) SetThreadFollowTx(ctx context.Context, tx *sql.Tx,
    workspaceID, threadID, userID string, follow, automatic bool) error
```

`Executor` 即既有 `channel.Executor`（Exec/Query/QueryRow Context 三方法，`*sql.Tx`/`*sql.DB`/`db.Executor` 同形）。错误以 `channel.DomainError` 返回，transport 按既有 code→HTTP 映射处理。

### 1.1 语义要点（消息/readstate 必须遵守）

- `AuthorizeConversationTx(posting=false)`：失败关闭的基础内容授权。缺 workspace membership → `FORBIDDEN "Not a member of this server"`；频道不存在/跨空间/父链断裂（缺父消息、跨空间父频道、嵌套/环）→ `NOT_FOUND "Channel not found"`。线程的读取权继承根会话；follow 行不构成内容权限。
- `AuthorizeConversationTx(posting=true)`：在读取权之上再要求——根与请求频道均未归档（`CONFLICT "This channel is archived"`）、真实频道成员（公开频道也需 roster 行，`FORBIDDEN "You must join this channel to send messages"`，与原 `canUserPostToChannel` 一致）；`#all`(enabled)/`#announcement` 走隐式 server membership；线程递归到根会话判定。guest 冻结策略一律拒绝。
- `SelectSyncAudienceTx`：基础授权 + 线程有效 follow（`unfollowed_at IS NULL`）。**history/context/显式 join 一律不得调用它作为读取门槛**；只有 sync/resume 使用。读取/join 不写 follow。
- `ListSubscriptionsTx`：原 `syncMessages` 可见性条件的集合版——公开频道全域、private/DM 按 roster、线程按有效 follow 且父链仍可读（父频道归档不剔除 sync，但软删/隐藏 #all 剔除）。
- `EnsureDMTx`：canonical pair `(workspace,user_low,user_high)` 唯一；并发落败方重读获胜行返回同一频道；self-DM 只写一条 roster；软删 DM 复活（原 ensure 语义）；创建时双方必须是 eligible 成员且（冻结 guest 策略）非 guest。已存在 pair 不再做资格校验（原语义：老 DM 对 guest 也可返回）。
- `EnsureThreadTx`：父频道存在且属于本空间（否则 `NOT_FOUND "Parent channel not found"`）、非线程（`INVALID_INPUT "Cannot create a thread inside a thread"`）、非 #announcement（`INVALID_INPUT` + 消息 "The #announcement channel is one-way…"）、父消息存在且属于该频道/空间（`NOT_FOUND "Parent message not found"`）。**不拒绝归档父频道**（原 ensure 如此；归档拦截在 create-thread 路由）。并发唯一索引仲裁，落败方收敛；同一事务内将 `messages.thread_id` 投影为线程频道（唯一写入点）。自动 'authored' follow 仅给**人类父消息作者**，非重激活（显式 unfollow 不被复活）；**opener 永不自动 follow**。
- `SetThreadFollowTx(follow=true, automatic=false)`：显式手动 follow，重激活并刷新；`(true, true)`：回复/被提及规则，重激活但不搅动已激活行的 revision（重复回复幂等）；`(false, _)`：显式 unfollow，保留历史行（row 不删除）。
- **发布意图归属（修订）**：follow/unfollow/自动回复关注/作者自动关注的 `thread:followers-updated` 意图由**发生真实变更的域函数本身**在同一事务内入队——对象是关系级逻辑对象 `(object_type="thread_follow", object_id=threadChannelId+":"+userId, revision=该用户 follow 行自身 revision, subject_user_id=userId, scope_id=threadChannelId)`。不同用户同处 revision 1 不再在 `realtime_publications` 唯一键上碰撞；无变更（automatic 命中已激活行、重复 unfollow、authored 命中已有行）= 无写入也无意图。authored 自动关注改为**只插入**（不刷新已有行）：第三方打开线程面板不碰作者的兴趣行、不发事件。`thread:updated` 意图仅在 EnsureThreadTx 真实创建线程时入队（revision 1，线程只会创建一次）。
- **posting 错误优先级（采纳跨切片审查 A9）**：posting 判定顺序改为成员资格 403（"You must join this channel to send messages"）→ 归档 409（channel_archived），与原 messages.ts:1702-1706 一致；未加入的归档频道得到 403 而非 409。
- 辅助导出：`HasActiveThreadFollowTx`、`ThreadFollowRevisionTx`（发布意图的 revision）、`HasPriorChannelRelationshipTx`（403/404 分流的可信见证：roster 行/thread_follows 行/DM pair 行；read-cursor 与 inbox 残留见证待 readstate 表落地后由其 worker 补充）。

## 2. HTTP 集成（父集成人接线）

新文件 `internal/transport/legacyweb/m4_conversation_routes.go`：

```go
func RegisterM4ConversationRoutes(mux *http.ServeMux, h *M4ConversationHandlers, gate *AuthGate)
```

接线（app 侧，一处调用）：

```go
m4conv := &legacyweb.M4ConversationHandlers{
    Channels: &legacyweb.ChannelHandlers{Store: m.channels}, // 复用 RequireChannelServer
}
// 可选接线（message worker 落地后）：
// m4conv.PostInitialReply = func(ctx, tx, claims, ws, channelID, content) error {
//     _, err := messages.CreateTx(ctx, tx, claims, ws, message.CreateInput{
//         ChannelID: channelID, Content: content})
//     return err
// }
legacyweb.RegisterM4ConversationRoutes(mux, m4conv, gate)
```

路由（全部位于既有 `gate.RequireVerifiedProfileComplete + RequireChannelServer` 链之后；与 `channel_routes.go` 的 `{rest...}` dispatcher 共存，精确字面量/更长模式优先，不改共享 routes）：

| 方法/路径 | 说明 |
|---|---|
| `GET /api/channels/dm` | 人类 DM 列表（peer 投影 + lastMessageAt 排序） |
| `POST /api/channels/dm` | `{userId}` 人类 DM/self-DM；`{agentId}` 形状+身份+存在性校验后**授权 501**（不建会话） |
| `GET /api/channels/threads/followed` | 本人 active 关注线程（真实 reply/unread/前沿） |
| `POST /api/channels/threads/follow` | `{parentMessageId}` → `{ok,threadChannelId}` |
| `POST /api/channels/threads/unfollow` | `{threadChannelId}` → `{ok:true}`，显式取消历史 |
| `POST /api/channels/{id}/threads` | `{parentMessageId, content?}`，ensure + 可选首条回复（同事务） |
| `GET /api/channels/{id}/threads` | `?parentMessageIds=`（≤500 UUID）；缺省为 compat 最近 100 父消息 |
| `GET /api/channels/{id}/threads/{messageId}` | 单父线程信息 |

### 2.1 可选接缝（父集成人显式接线，非猜构造字段）

- `M4ConversationHandlers.PostInitialReply func(ctx, tx *sql.Tx, claims auth.AccessTokenClaims, workspaceID, channelID, content string) error`：与锁定签名 `message.Store.CreateTx` 同形（去包类型）。未接线且请求带 `content` 时，路由在**任何写之前**返回 501 `feature_not_implemented`（不产生半开状态）。
- `M4ConversationHandlers.ReadCursor channel.ReadCursorFunc`：`(ctx, ex, workspaceID, userID, channelID) → readThroughSeq`。readstate 落地后由父接线；nil = "无已读记录"（游标 0，即尚未接任何已读写入时的真实值）。
- `M4ConversationHandlers.MarkReadLatest MarkReadLatestTx`，精确签名：
  ```go
  type MarkReadLatestTx func(ctx context.Context, tx *sql.Tx,
      claims auth.AccessTokenClaims, workspaceID, userID, threadChannelID string) error
  ```
  在 `POST /channels/threads/follow` 的**同一事务**内、`SetThreadFollowTx` 成功后调用（对应原 `followThread → markReadLatest` 配对，channelService.ts:14464+）。父接线到 readstate 用例；nil 时不伪造已读。**hook 返回错误 → 整个 follow 事务回滚**（含 follow 行与已读推进），HTTP 500。
- `M4ConversationHandlers.DMReadState DMReadState`，精确签名：
  ```go
  type DMReadState func(ctx context.Context, ex channel.Executor,
      workspaceID, userID, channelID string) (json.RawMessage, error)
  ```
  在 DM 列表/创建响应的同一读快照内为每行解析 #632 read frontier。readstate 拥有并自行序列化精确 JSON 形状（kind/readStateVersion/maxReadSeq/latestActivity）；channel 原样内嵌，不二次渲染。返回 `nil, nil` → 字段省略（老服务器容忍）。nil seam 同样省略。
- **发布意图（修订后全部由域函数在同一事务内入队，handler 不再自行入队）**：
  - `thread:followers-updated`：见 §1.1——关系级对象 `(thread_follow, thread+":"+user)`，scope_id=threadChannelId。父 publisher 按 ScopeID 路由，向当前有权受众重投影共享 `{threadChannelId}` 提示；follow 行私数据绝不进入意图。
  - `dm:new`：EnsureDMTx 在**真实创建或真实复活**时入队，`(object_type="channel", object_id=dmChannelId, revision=max(transitionMillis, 同键前值+1), scope_id=dmChannelId)`。revision 严格递增保证 create 时间的键**永远不会压制之后的真实复活**；同事务重放（重试）重算出相同键保持幂等；无转移的 ensure 不入队。受众=参与者，由 publisher 从 direct_messages 事实重投影，payload 只含 `{channelId}`。
  - `thread:updated`：仅 EnsureThreadTx 真实创建线程时入队（revision 1；本期线程无复活路径）。

### 2.2 公开/私有线程 live 规则（供 socket worker 文档化引用）

- 基础内容授权（`AuthorizeConversationTx`）永远先行：线程读取权 = 根会话读取权。
- live：公开父频道线程可含显式 join 的有权 viewer（thread room）；**private/DM 父链线程 live 仅 active follower**（`HasActiveThreadFollowTx`）。
- resume/`/messages/sync`：一律 `SelectSyncAudienceTx`（公开与私有线程同规则：active follow 才进流）。
- 打开线程/读取 history 不写 follow；显式 unfollow 不撤销内容读取权。

### 2.3 频道 list/detail/create 的 M4 投影接缝（第三轮）

```go
// internal/transport/legacyweb/m4_channel_projection.go
type M4ChannelProjection struct {
    ReadState          json.RawMessage // #632 union，readstate 渲染，逐字内嵌
    MaxReadSeq         *int64          // legacy 线形：coalesce 0
    ReadStateVersion   *int64
    ActivityMuted      *bool
    MuteFromSeq        any             // nil 省略；RawMessage("null") 显式 null
    PrefsVersion       *int64
    ActivityMuteSupported *bool
    CollapseLongMessages  *bool
    DisplayPrefsVersion   *int64
    LastMessageAt      any             // 仅 list 出口；时间 DTO 或 RawMessage("null")
    LastMessagePreview any             // 仅 DM 列表路径使用；/api/channels 列表不带
}
type M4ChannelProjector func(ctx context.Context, ex channel.Executor,
    serverID, userID string, channels []channel.Channel,
    includeLastMessage bool) (map[string]M4ChannelProjection, error)
```

- **构造字段**：`ChannelHandlers{ Store *channel.Store; M4 M4ChannelProjector }`。`M4 == nil`（独立 M3 套件）时 list/detail/create 走原 M3 路径（`listM3`/`getM3`/原 create 尾部），输出与 M3 字节一致——fixture 默认值显式保留在 `channel_dto.go`；`M4 != nil`（生产 M4）时三个出口在**一个 `db.WithReadSnapshot`** 内完成频道行（`ListChannelsTx`，无惰性 ensure）、权限（`ResolveChannelActorContextTx`/`CanUserAccessChannelTx`，均为本轮 surface 的 executor 变体）与投影（单次 projector 批查询），无逐字段二次查询/无第二连接/无全局可变状态。
- **父接线（app 侧一行）**：`&legacyweb.ChannelHandlers{Store: m.channels, M4: m4Projector}`；`m4Projector` 由 readstate/message 切片实现（readstate 导出方法就绪后替换测试参考实现）。测试参考实现 `m4TestProjector`（`m4_channel_projection_http_test.go`）按原 attachment 规则批查 0011/0010 表：legacy 0-coalesce、announcement 默认 mute（true/0/0）、未静音 `muteFromSeq: null`、display 默认 collapse=true/version 0、lastMessage=MAX(seq) 消息时间。
- **出口键集按原路由固定**：list 恒带 `lastMessageAt`（null 当无消息）且**不带** `lastMessagePreview`（原 includePreview 仅 DM 列表）；detail/create 不带 last-message 键；create 不带 display 键且其“新会话空态”由投影快照陈述（absent/0/false/null），非旧 scope 默认。projector 供了也不扩键集（builder 显式清空）。
- 语义证据：attachReadState/attachActivityMuteState/attachUserChannelDisplayPrefs/attachLastMessageAt（channelService.ts:1214-1460）、detail 路由 channels.ts:2448-2508、create 路由 channels.ts:760-870。

### 2.4 prior-relationship 残留见证（保留父补丁 + 测试）

父层已把 `HasPriorChannelRelationshipTx` 扩展到 0011 的 read/done/mention 残留（每条带 channel↔workspace JOIN）。本轮**原样保留**并补测试（`TestPriorRelationshipResidueWitnesses` 域级、`TestM4RemovedMemberResidueSplit` HTTP 级）：
- 仅读过 history（无任何残留）的_removed_ 成员 → 404 字节同 missing（不泄露存在性）；
- 本人 read 残留（在所探测频道上有 `user_channel_read_states` 行）→ 诚实 403 `{"error":"Access denied"}`，**且响应体仅此一句**——无 seq/version/frontier（“never expose current private frontier”）；
- 他人的 read 残留不构成见证 → 404；done/mention 残留同规则。

### 2.5 致 readstate/消息切片的协调说明（第三轮）

- readstate 需导出一个符合 `M4ChannelProjector`（§2.3 签名）的投影方法，父层在 app 装配处接到 `ChannelHandlers.M4`。语义要求（与原 attachment 一致，测试参考实现已按此验证）：legacy `maxReadSeq/readStateVersion` 无行 coalesce 0；`readState` 为 #632 union 的属主渲染 JSON（absent/present）；无行 + announcement(channel) → 默认 mute true/0/0；未静音 → `muteFromSeq: null`；display 无行 → collapse=true/version 0；`includeLastMessage=true` 仅 list 出口（MAX(seq) 消息时间或 null）。一切读取只用传入的 `ex`（同一 pinned snapshot）。
- readstate 起草中的 durable mute epochs（0013，父层安装）不得改变本出口的 wire 形状：epoch 属于内部单调性/并发合并域，出口仍按“当前快照值”投影；若 0013 改变判定输入，只需替换 projector 实现，channel 出口无感。
- `M4ConversationHandlers.DMReadState`（§2.1）仍待 readstate 提供逐字 JSON；测试参考渲染见 `m4TestProjector` 的 readState 分支（与 readstate `inbox.go` 的 Wire 渲染同形）。

## 3. 与参考实现的对齐/偏差记录（2026-10-08 复审后）

- 线程摘要 unread 仅在 active follow 时计数（原 join 语义）；followed 列表 unread 排除本人消息；frontier `latestActivitySeq` 与 `latestActivityMessageID` 同源。preview 截断按 UTF-16 code units（100/140）。
- ~~follow 不推已读~~ **已修复**：`MarkReadLatestTx` 接缝在 follow 同事务内推进（§2.1），由父接线 readstate；未接线时不伪造。
- ~~hiddenDmIds 无后端支撑~~ **已修复**：0005 的 `workspace_member_preferences.hidden_dm_ids` 真实存在。EnsureDMTx 创建非自身 DM 时把频道 id 并入**被动方**的 hidden_dm_ids（幂等集合并集，行不存在则建行），对应原 `hidePassivePeerOnCreate`；DM 列表仍返回该行（原 listDMChannels 不过滤，收起是 sidebar 读侧行为）。自身 DM 不写；重复 ensure 不重复写。
- **#all/#announcement 写入范围（复审第 4 项，带证据的收敛）**：
  - 原 TS 允许隐式成员频道被普通成员发消息：`channelService.canUserPostToChannel`（channelService.ts:5979+）`hasImplicitServerMembership(channel) → isServerHumanMember(...)`（`hasImplicitServerMembership = isEnabledAllChannel || isAnnouncementChannel`，channelService.ts:246-248）；send 路由（messages.ts:1702+）只查 canPost + billing，无系统频道拦截；web composer 无门控。announcement 的"单向"仅落在 thread/reply choke point（`AnnouncementNoThreadsError`），messageService 对 announcement 的特判只压制 agent fan-out。
  - 已批准 M4 范围覆盖该 TS 行为：phase-4-messaging §9 "「#all」/Activity 不可作为普通会话随意写入；人类消息只能写到明确的原始 conversation scope"；m4-execution-lock "Posting requires real channel membership ... and system-channel restrictions"；m4-implementation-coordination §6 的验收闭环明确是"普通公共频道……真实加入后互发文本"。
  - 实施决定（fail-closed 收敛，非静默扩大）：`canPostRoot` 要求**所有类型的 root 都有真实 channel_humans 行**。#all(enabled)/#announcement 的受众是派生的、永远没有 roster 行，因此普通人类发帖被拒（403 join 句）。读取权不受影响。已知影响：原 TS 中成员可发的这两个频道在 M4 不可发——这是有记录的范围收缩；若产品后续要求恢复，需按执行锁另行走范围变更。
- 'authored' 自动 follow 在 ensure 时写入（执行锁决定），比原 TS（首个回复广播时）更早；**非重激活且只插入**——已有行（无论状态）不刷新、不发事件，第三方打开面板零副作用。
- DM 列表的 readState 投影经 `DMReadState` 接缝由 readstate 提供（§2.1）；mute/displayPrefs 仍归 readstate 所有的其他端点。

## 4. 测试

- 域测试：`internal/channel/conversation_test.go` — 授权矩阵（公开/私有/DM/线程/隐藏 #all/归档/guest 冻结）、DM 并发收敛与 self-DM 单行、thread 唯一性 + `thread_id` 投影 + authored 自动关注（含不复活显式 unfollow）、manual/automatic/显式 unfollow 的 revision 语义、sync 受众（含失去私有父频道成员资格后的剔除、读取不写 follow）、跨空间父消息/嵌套/自环防御、摘要/关注列表真实计数与 UTF-16 截断、prior-relationship 见证。
- HTTP 测试：`internal/transport/legacyweb/m4_conversation_http_test.go` — 全部经真实 app（真实注册/验证/资料链路 + 真实 JWT）与本 worker 的注册函数 mux（in-process recorder，无 TCP）；DM 创建/列表/自身 DM/agent 501 前置不落库；线程 ensure/首条回复接缝（同一事务）/未接线 501 不落库/嵌套/公告/归档/父消息守卫；summaries 参数解析与 compat 窗口；followed/follow/unfollow 全链路；read-cursor 接缝驱动真实 unread；logout 撤销家庭后 401；进程重启（reopen）后 follow/投影/DM 持久；并发 DM ensure 单行收敛；与 M3 dispatcher 同 mux 共存（无 panic、精确路由优先、未实现面保持 501、已实现路径 405+Allow）。

### 4.1 既有测试的必要更新

- `internal/channel/behavior_test.go` 的 `TestSchemaIsAdditiveAndPreservesChannels` 原断言 `messages` 表不存在（M3 冻结时点事实）。父集成人已提交 `0010_messaging_foundation.sql` 后该断言与已批准 schema 冲突；更新为要求 `messages` 表存在（加法式 schema 检查的本意不变），M3 频道行为断言全部保留并通过。

## 5. 实际命令与结果（2026-10-08 执行）

```text
$ GOCACHE=$TMPDIR/go-build-cache go build ./internal/channel/ ./internal/transport/legacyweb/   # OK
$ go test ./internal/channel/ -count=1
ok  raft.local/server-go/internal/channel   1.349s        # 全量（含 M3 回归 + 复审新增用例）
$ go test ./internal/transport/legacyweb/ -run '<本 worker 17 个 TestM4* 用例>' -count=1 -race
ok  raft.local/server-go/internal/transport/legacyweb  13.594s   # 会话 + 投影 + 残留分流，全绿
$ go test ./internal/transport/legacyweb/ -run 'TestChannel|TestChannels' -count=1
ok  raft.local/server-go/internal/transport/legacyweb   0.438s   # M3 channel 出口（未接线路径）回归
$ go test ./internal/message/ -count=1 -run 'TestCreate|TestThread|TestSync|TestHistory|TestIdempot|TestReaction'
ok  raft.local/server-go/internal/message   1.145s        # 消息切片在修订后的 channel 域上全绿
$ go test ./internal/readstate/ -count=1
ok  raft.local/server-go/internal/readstate  2.131s       # readstate 切片同上
$ go test ./internal/transport/legacyweb/ -count=1
--- FAIL: TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware   # 既有 M3 用例，见 5.1
（另：internal/message 的 TestReferenceVerifierRunsOriginalManifestAndViewerReducer 在本沙箱失败于
 node tsx 的 IPC listen EPERM —— 沙箱禁 listen，属环境限制，非逻辑失败，文件归消息 worker。）
```

### 5.2 本 worker 的测试清单（第三轮修订后全部通过）

域（`internal/channel`，随包全量通过）：`TestAuthorizeConversationMatrix`（含 posting 403→409 优先级）、`TestAuthorizeConversationThreads`、`TestEnsureDM`、`TestEnsureThread`、`TestSetThreadFollowSemantics`、`TestSyncAudienceAndSubscriptions`、`TestThreadProjections`、`TestPriorChannelRelationshipWitnesses`、`TestFollowPublicationIdentities`（多用户同 revision 不碰撞 / automatic 无变更零发布 / 重激活发布 / 真实 unfollow 发布且重复 unfollow 零发布 / thread:updated 仅创建）、`TestDMPublicationAndHiddenPeer`（dm:new 创建 1 次、幂等 ensure 零新增、软删复活必发第 2 个意图、被动方 hidden_dm_ids 幂等且自身 DM/主动方不写）、`TestPostingScopeRestrictsImplicitMembershipChannels`（#all/#announcement 读许可、发帖拒绝；真实加入频道照常可发），以及既有 M3 用例全量回归（含更新后的 `TestSchemaIsAdditiveAndPreservesChannels`）。

HTTP（`internal/transport/legacyweb`，`-race` 亦通过）：`TestM4CreateAndListDMs`、`TestM4ThreadLifecycle`、`TestM4FollowInterest`、`TestM4ReadCursorSeamDrivesUnread`、`TestM4RevokedSessionAndRestartPersistence`、`TestM4ConcurrentDMEnsure`、`TestM4AnnouncementFollowRefused`、`TestM4RoutesCoexistWithChannelDispatcher`、`TestM4FollowReadSameTransaction`（hook 携带完整 claims/ws/thread 同事务调用；hook 失败 → follow+线程全部回滚）、`TestM4DMReadStateSeam`（未接线省略、接线后逐字内嵌）、`TestM4TwoAccountDMLifecycle`（双账号同会话/peer 投影/活动排序/软删复活后 dm:new 双意图且 hidden 不重复）、`TestM4RemovedMemberResidueSplit`（§2.4 的 403/404 分流与零前沿泄露）。

第三轮新增（`m4_channel_projection_http_test.go`，含测试参考投影实现）：`TestM4ChannelListProjection`（真实 read/mute/display/lastMessage 投影逐字段断言；toggle 后刷新反映新真值；announcement 默认 mute 与 #all absent/无 stale 零值；列表无 preview 键）、`TestM4ChannelDetailAndCreateProjection`（detail 带状态且无 last-message 键；create 陈述新会话空态且不携带 display/last-message 键）、`TestM4ChannelProjectionCrossWorkspaceNoLeak`（同用户在 A/B 两空间，A 的 read 残留绝不投影到 B 的列表，B 行 absent/0/null）。M3 回归：`TestChannel*` 全量在**未接线**路径下通过（出口字节保持不变）。

### 5.1 失败与限制（如实记录）

- `TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware`（`websocket_middleware_test.go`，M3 既有用例，本 worker 未改动）在本沙箱 panic：`httptest: failed to listen on a port: bind: operation not permitted`。原因是沙箱禁止本地端口绑定，非代码回归；该用例需要真实 TCP listener，在父环境可运行。本 worker 的全部测试只用 in-process recorder，不受此限制（任务要求的“runnable in parent even sandbox bind denied”已满足）。
- 本沙箱 Go 构建缓存目录不可写，全部命令使用 `GOCACHE=$TMPDIR/go-build-cache`。
- 同一 checkout 上消息/readstate/socket worker 并行落盘期间，`go test ./...` 出现过瞬时的他包编译错误（非本 worker 文件）；本报告的所有结论以其最终稳定状态为准，`go build ./...` 当前除 socket worker 的隔离 spike（依赖尚未进入主 go.mod，按锁不由其先行修改）外全部通过。
- PostInitialReply / ReadCursor 两个接缝未接线时的行为已按 §2.1 如实拒绝/取 0，接线点与代码位置见 §2.1。
- 归属说明：同包内 `TestM4Message*`（消息 worker 的 `m4_message_http_test.go`）与 `internal/readstate`、`internal/app` 在本快照时刻存在消息/readstate worker 落盘中的编译/用例失败，文件均不在本 worker 所有权内；本报告 §5 的通过结论只覆盖上表所列本 worker 用例与其依赖的共享包（channel/platform-db/auth/app 装配在消息测试之外均通过）。
- 第三轮快照补充：全包运行另见 `TestRoutePolicy` 失败——`GET /socket.io/?transport=polling` 现返回 400（socket worker 的传输已落地）而该 M3 用例仍期待 501；用例与路由均不在本 worker 所有权内，留父层裁决。
