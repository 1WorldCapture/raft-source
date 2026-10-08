# M4 P2 + Reactions — Message worker report

- 执行者：Message worker（P2 消息事实/seq/randomId 幂等/v2 发送/历史/context/sync + 人类 reactions）。
- 基线：`bc65213` + 集成人共享工作树中的 0010/0011/0012 migration、`db.WithWriteTx/WithReadSnapshot`、`auth.ValidateHumanTx`、`realtime.Enqueue`、`legacyweb.accessClaims`、channel worker 冻结 API（`internal/channel/conversation.go`/`dm.go`/`thread.go`）。
- 所有权：仅 `internal/message/**`、`internal/transport/legacyweb/m4_message*.go`、本报告。未修改 schema、`routes.go`、`app/**`、go.mod、其他 worker 文件、TS/Web/CLI/Daemon、lockfiles、live 数据。未提交/未推送/未重启服务/未做浏览器测试。
- 父审阅意见 `docs/m4-message-review-notes.md` 已逐条落实（见 §7）；第二轮集成/安全审阅的 7 项必改已全部落实（见 §10）。

## 1. 需要集成人接线的 API（先读这里）

### 1.0 线程回复读游标 Hook（第三轮新增，父接线）

```go
// internal/message —— 稳定签名，父在 app 装配时注入：
type ThreadReplyReadHook func(ctx context.Context, tx *sql.Tx,
    claims auth.AccessTokenClaims, workspaceID, threadID string) error
func (s *Store) SetThreadReplyReadHook(h ThreadReplyReadHook)
func (s *Store) HasThreadReplyReadHook() bool   // 装配完整性自检

// 父接线（无模块环）：
messages.SetThreadReplyReadHook(func(ctx context.Context, tx *sql.Tx,
    claims auth.AccessTokenClaims, ws, threadID string) error {
    _, err := readstate.MarkReadLatestTx(ctx, tx, claims, ws, threadID)
    return err
})
```

语义（对齐原 messageService.ts:2653/2759 的 replied 自动关注后 markReadLatest）：
- **仅新的人类线程回复**在同一事务内调用（含同事务的 message/follow/publication —— 回滚不可能留下幻读或缺失读效果的回复）；randomId 重放、历史读取、普通频道消息一律不调用；
- hook 失败 → 整个回复事务回滚（消息/follow/publication 零残留）；
- 两位作者各自以**本人**已验 claims 触发；
- 未接线时纯事实用例仍可跑（单测可分），`HasThreadReplyReadHook()==false` 向装配声明产品路径不完整——生产装配必须接线。
- 测试：`TestThreadReplyReadHookSameTransaction`（同事务、重放不触发、非线程不触发、回滚零残留、两作者）、`TestThreadReplyReadHookWiringBoundary`。own-message 排除与版本台账消费属 readstate 侧语义，由其 worker 在 `MarkReadLatestTx` 内实现。

### 1.1 HTTP 注册（父在 `app` 或 `Deps.RegisterAdditional` 中一处调用）

```go
import "raft.local/server-go/internal/transport/legacyweb"

messageStore := message.NewStore(db, m.channels)          // 锁定构造器
msgHandlers := legacyweb.NewMessageHandlers(
    messageStore,
    &legacyweb.ChannelHandlers{Store: m.channels},        // 复用 RequireChannelServer
)
msgHandlers.SetCursorSecret(<32+ bytes 稳定密钥>)          // 可选：reaction actors 游标跨重启有效
legacyweb.RegisterMessageRoutes(mux, msgHandlers, gate)   // gate = legacyweb.AuthGate
```

路由面（全部在 `RequireVerifiedProfileComplete + RequireChannelServer` 链后；写方法再过共享限流桶）：

| 方法/路径 | 说明 |
|---|---|
| `POST /api/v2/messages` | v2 发送 → `{message}`（pendingMentionActions/unresolvedMentionHandles 仅非空出现，人类-only M4 恒空故不出现） |
| `POST /api/messages` | v1 别名 → 裸 message |
| `GET /api/messages/channel/{channelId}` | MessagePage（limit 默认50/最大200，before/after 互斥，`invalid_message_page_cursor` 400） |
| `GET /api/messages/context/{messageId}?channelId=` | 原 context DTO（15/15 窗口，hasOlder/hasNewer，channelArchived） |
| `GET /api/messages/sync` | 裸 `Message[]`（since_seq/channel_id/limit 默认200/最大500） |
| `POST/DELETE /api/messages/{id}/reactions` | 写桶内；响应 = 展平的完整 message DTO + `reactionViewer` |
| `GET /api/messages/{id}/reactions/actors`、`/viewer` | 共享聚合 / 私人快照 |
| `PATCH/DELETE /api/messages/{id}`、`/{id}/saved`、`/search`、`/forward`、`/mention-actions/execute` | 授权后显式 501 `feature_not_implemented` |

实现为单个 `/api/messages/{rest...}` dispatcher（Go ServeMux 禁止 `channel/{id}` 与 `{messageId}/x` 两种通配位置并存），与 channel worker 的 dispatcher 方式一致。

### 1.2 跨模块域 API（`internal/message`，供 readstate/socket/父 publisher）

```go
func NewStore(handle *sql.DB, channels *channel.Store) *Store   // 锁定签名
func (s *Store) Create(ctx, claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*CreateResult, error)
func (s *Store) CreateTx(ctx, tx *sql.Tx, claims, workspaceID, input) (*CreateResult, error) // conversation worker 首条回复用
type CreateInput struct{ ChannelID, Content string; RandomID *string; Mentions []Mention; AttachmentIDs []string; AsTask *bool }
type CreateResult struct{ Message *Message; Replayed bool; Mentions []Mention }
```

conversation worker 的 `M4ConversationHandlers.PostInitialReply` 与 `CreateTx` 同形，可直接闭包接线（channel worker 报告 §2.1 已留该缝）。

**readstate worker 可直接读取的已协定事实**：`messages`（含 `revision`）、`message_mentions`、`message_reactions`、`message_reaction_discussion_versions`、`message_reaction_viewer_versions`、`thread_follows`（只读）。勿写 `messages.revision`/reaction 表（message 所有权）。

**socket worker（父 publisher）投影入口**（§1.3）已就绪。

### 1.3 Publication 投影入口（父 outbox hub 出队时调用）

```go
type PublicationRef struct{ WorkspaceID, ObjectType, ObjectID, EventType string; Revision int64; SubjectUserID string }
func (s *Store) ProjectPublication(ctx, ref PublicationRef) (*PublicationProjection, error)
func (s *Store) AudienceForChannel(ctx, workspaceID, channelID, userID string) (bool, error)
```

`PublicationProjection` 携带：`WorkspaceID`、`ChannelID`、`PrivacyClass("shared"|"viewer_private")` 及按 object 类型投影的当前事实——`message:new`（完整共享 DTO + `ConversationContext`）、`message:updated`（共享聚合 DTO）、`reaction_viewer:updated`（仅 subject 的私人快照，`SubjectUserID` 必填）、`thread:updated`（**逐字段移植原 emit**：`parentMessageId/threadChannelId/replyCount/lastReplyAt/participantIds/parentChannelId/serverId/syncCoreReplyWindow{producer="message-service.thread-replies-window.v1",discussion{root,relation:replies,parentScopeKey,backing:sync-scope},window{sync-scope-window}}/latestReply`（密封消息 + senderDisplayName + null senderAvatarUrl + thread conversationContext），来源 `messageService.ts:2880-2913` + `discussionGraph.ts:85-150`）。事实已删除 → `(nil,nil)`，publisher 完成该行而不投递。

**两条受众规则，不可混用**：

```go
// sync/resume 兴趣（所有线程一律要求有效 follow）
func (s *Store) AudienceForChannel(ctx, workspaceID, channelID, userID string) (bool, error)

// live 推送资格（经批准的公开线程 live 规则）：
// 非线程=基础读取权；公开父频道线程=有权 explicit viewer（ViaFollow=false）；
// private/DM 父链线程=仅 active follower（ViaFollow=true）。
type LiveEligibility struct { Eligible, ViaFollow bool; RootType string }
func (s *Store) LiveEligibilityForChannel(ctx, workspaceID, channelID, userID string) (LiveEligibility, error)
```

socket 端 payload 密封（去 agentSendKey/searchText/searchVector/senderHandle）用 `message.SocketMessageNew/SocketMessageUpdated`，conversationContext 仅 `message:new`。

**字节有界 Resume**（socket worker 唯一恢复入口）：

```go
type ResumeOptions struct{ MaxMessages int; MaxEncodedBytes int64 } // 默认 500 / 1MiB
func (s *Store) ResumePage(ctx, claims, workspaceID string, lastSeq int64, opts ResumeOptions) (*ResumeEnvelope, error)
```

页恒为 seq 前缀：字节界截断尾部时 `currentSeq` 回退到最后一条**已包含**消息的 seq、`hasMore=true`，下一页精确重取被截行——可见消息永不被跳过。

**字节核算含完整 JSON 信封**（外层花括号/键名/逗号分隔/currentSeq 数字），先按每消息尺寸+分隔符+保守余量选前缀，再用真实信封 marshal 精确复核、超出即继续裁尾——**永不静默放行超预算消息**。单条合法消息（32000 CJK ≈ 96KB）在默认 1MiB 下整页容纳；当调用方收缩预算至单条以下时返回类型化错误 `ErrResumeMessageExceedsBudget`（网关按慢消费者策略重试/关闭，而非无跳过死循环或无限重连）。测试：`TestResumePageByteBoundNeverSkipsVisibleMessages`（6×96KB 按 380KB 界取尽零跳过）、`TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize`（1MiB 单条容纳、1KB 预算类型化错误、每页整信封 ≤ 预算、紧预算分页取尽）。

**HTTP sync（第三轮重做）——稀疏大数据集必须可读，不再有永久 503**：

```go
func (s *Store) SyncHTTP(ctx, claims, workspaceID string, sinceSeq int64, channelID string, limit int) (*SyncResult, error)
var ErrSyncDeadlineExceeded error   // → HTTP 503 {"code":"sync_scan_deadline_exceeded"}（瞬态可重试）
```

- **无固定行/频道配额**：先经 channel worker 的 `ListSubscriptionsTx`（原 syncMessages 可见性条件的集合 SQL——复用权限策略，零复制）把可流频道集合注入 `channel_id IN (...)` **在 LIMIT 之前过滤**，不可见频道/行根本不进入扫描；随后扫描全部所需行直到真实满页或快照终点（每查询 ≤500 可见消息持有；IN 列表按 500 分块）。
- **仅有 context 截止**（默认 15s，`SyncScanDeadline`）：超限是显式瞬态失败（503 `sync_scan_deadline_exceeded`），重载时可重试——**绝不是把合法大历史永久排除的固定配额**。>20000 隐藏行与 >512 隐藏频道形态下，原客户端裸数组游标协议（末条 seq 续拉、满页续读）最终取回全部授权行。
- **成员资格强制**：`requireWorkspaceMembership`——非成员对空 workspace 也是 403 "Not a member of this server"，空答案与"非成员"永不混淆。
- resume 信封路径（`SyncVisibleMessages`→`ResumePage`）沿用同一订阅前缀 + 行预算（信封有 currentSeq 前进语义，预算耗尽永远可续）。
- 测试：`TestSyncHTTPReadsSparseDatasetBehindAdversarialBulk`（两形态域级直取 + resume 分页取尽）、`TestSyncHTTPRequiresMembershipEvenForEmptyStream`、`TestM4SyncReadsSparseDatasetBehindAdversarialBulk`（真实 HTTP 裸数组游标翻页）、`TestM4SyncRequiresCurrentMembership`。

## 2. 实际交付范围

- **写入**：v1/v2 人类发送；`auth.ValidateHumanTx` 事务内重验；seq 由 SQLite AUTOINCREMENT 在同一 IMMEDIATE 事务分配并校验安全整数；`randomId` 幂等作用域 `(sender_type='user', sender_id, random_id)`（跨空间，同原 TS partial index），重放校验 workspace+channel+请求摘要（digest=SHA256(workspace/channel/sender/content/排序 mention 目标 id)，重放不因目录改名而误判 409），同键异请求 → 409 `random_id_conflict` 原句。
- **未启用副作用提交前拒绝**：非空 attachmentIds / true asTask / 任何 agent 型结构化 mention（含混合）→ 501 `feature_not_implemented`；无部分接受、无落行。
- **人类结构化 mention**：仅 `type:user`；事务内核实目标为当前 workspace 成员、对该会话有读取权（`AuthorizeConversationTx(posting=false)`）、name 与目录 handle 一致（防冒充）；持久化稳定目标 id + 目录名。同 handle 双 id → v2 原 binding-conflict 400；未知目标/名字不匹配/不可读 → 400（批准合同的"不允许接收后忽略"）。纯正文 `@name` 不产生 mention 事实（见 §6 偏差 4）。
- **线程**：回复发送者与被提及人类经 `channel.SetThreadFollowTx(automatic=true)` 自动关注（'replied'/'mentioned' 语义由 channel worker 实现；authored-follow 在其 EnsureThreadTx）。父消息 `thread_id` 投影唯一写入点是 channel worker；回复自身 `threadId=null`、`channelId=thread channel`，与 TS 冻结合同一致。
- **读取**：频道历史（latest/before/after，严格 seq 游标）、context（15/15、scope 不匹配 404）、`/messages/sync`（裸数组）。MessagePage.messageWindow 逐字段移植 `listMessagesWithCoverage`：coveredAfter=频道内真实前驱、remoteHighWater=频道边界、空页 from=H+1/through=H、仅 latest-tail 可 `completeThroughLatest`、before/after 保守 hasGap/hasNewer。行/覆盖/线程摘要/DTO 全部同快照。**ThreadSummary.unread 使用真实 0011 游标**（只读 `user_channel_read_states.last_read_seq`，`seq > COALESCE(cursor,0)` + 有效 follow，无占位 0；`TestThreadSummaryUnreadUsesRealCursor`）。
- **同步扫描**：固定 H=workspace 已提交高水位，按 seq 升序分批扫描 `(lastSeq,H]`，逐 DISTINCT channel 调 `SelectSyncAudienceTx`（本请求内 memo），私有/不可读频道静默形成空洞；预算 20000 行/512 频道耗尽时如实返回 hasMore 与已覆盖游标，绝不伪造完整。指定 channel 的 sync 同样要求有效 follow（批准的 Go 决策，见偏差 2）。`ResumePage` 输出 Socket `{messages,currentSeq,hasMore}`，currentSeq=真实覆盖（含空洞前进），扫到 H 才等于 H。
- **Reactions**：add/remove 幂等（真实变更才 bump `messages.revision` 且才 enqueue）；聚合来自真实行；actors 列表带 HMAC 签名游标 + discussion-version/visibility 守卫（同 emoji 变更 409 `reaction_discussion_version_changed`，可见集变化 409 `reaction_actor_visibility_changed`，含 `rebaselineRequired`）；viewer 私人快照 `{serverId,messageId,viewerVersion,reactedEmojis}`；版本为 0010 持久有序计数器（见 §7）。**actors 可见性执行原隐藏目录策略**（第二轮审阅 #3）：`hide_humans_from_members && requester.role=="member"` 时，#all 目录范围（#all 频道或根为 #all 的线程）仅暴露请求者本人与 community/community-cn 空间的 owner/admin（`shouldHideHumanDirectoryFromRequester`/`shouldExposeHumanInHiddenDirectory`/`isHiddenAllDirectoryScope` 逐条移植，只读 `workspaces.slug`/roster）；owner/admin 与非 #all 范围不受影响（`TestReactionActorsHiddenDirectoryPolicy`）。
- **限流**：v1/v2/reaction 写共享每用户 60/60s 固定窗口桶（retry 别名不绕过、跨空间同桶、GET 不消耗），429 原句 + RateLimit-Limit/Remaining/Reset 头；测试注时钟，产品接线不提供关闭项。
- **Publication**：`message:new`（rev=1）、`message:updated`（rev=bumped messages.revision）、`reaction_viewer:updated`（subject=操作者）、`thread:updated`（rev=回复 seq）全部经 `realtime.Enqueue` 与事实同事务提交。

## 3. 修改文件

`internal/message/`：`doc.go model.go errors.go store.go channel_seam.go validate.go create.go history.go context.go sync.go reaction.go threadsummary.go dto.go publication.go` + 测试 `testsupport_test.go create_test.go history_test.go sync_test.go reaction_test.go publication_test.go live_test.go hidden_directory_test.go reference_verify_test.go read_hook_test.go` + 引用验证器 `testdata/reference_verify.mjs`。
`internal/transport/legacyweb/`：`m4_message_handlers.go m4_message_read_handlers.go m4_message_routes.go m4_message_ratelimit.go` + 测试 `m4_message_http_test.go m4_message_fixture_test.go`。
`docs/m4-message-worker-report.md`（本文）。未修改任何被跟踪文件；schema 变更需求为零（隐藏目录用既有 workspaces 列，游标用已安装的 0011）。

## 4. 引用的 TS/Web 基线（冻结源）

- `packages/server/src/routes/messages.ts`（57-58 常量、69-141 解析器、465-479 reaction/游标解析、518+ loadVisibleMessageForUser、845-996 context、997-1160 history+window、1657-1800 v1/v2 发送、1873-2178 reactions+sync）。
- `packages/server/src/services/messageService.ts`（1973 createMessage、2380-2434 randomId 重放、4935-5077 mention/reaction 聚合、5119 enrich、6006-6073 context、6382-6478 coverage、6564-6700 syncMessages 可见性、8140+ broadcastAndDeliver 的 sender 投影/线程 follow/'mentioned' 规则、7196-7259 线程被提及自动关注）。
- `packages/server/src/services/messageReactionService.ts`（224-519：viewer/discussion 版本、游标签名、409 语义）与 `packages/server/src/db/schema.ts:3319-3340`（版本表列名）。
- `packages/server/src/services/channelService.ts`（5979 canUserPostToChannel、6569+ 线程摘要、6891-7160 ThreadSummary 形状、14406 recordThreadFollow）。
- `packages/server/src/routes/channelAccessDenial.ts`（403/404 分流与字节一致 body）。
- `packages/server/src/socket/index.ts:245-271`（resume wire）；`packages/web/src/store/messageStore.ts`（1400-1429 发送响应归一、2740-2830 sync 满页循环、1365+ 分页游标）；`packages/web/src/store/reactionReadModels.ts`（340-440 版本合并/冲突）；`packages/shared/src/canonicalMessageManifest.ts`（字段在场语义与 socket 密封清单）。
- Fixture：`m4_message_fixture_test.go` 将 canonical manifest 必需字段/可选聚合族与 legacy 错误句清单固化为执行断言，并在真实 HTTP 响应上交叉验证；DTO 键集由 `assertExactKeys` 逐端点比对（发送面 vs 历史面 vs reaction 面 vs actors discussion vs viewer vs ThreadSummary/latestReply）。
- **引用验证器（第二轮审阅 #7）**：`internal/message/testdata/reference_verify.mjs` **静态导入原 TS 模块**（`packages/shared/src/canonicalMessageManifest.ts` 与 `packages/web/src/store/reactionReadModels.ts`），由 `reference_verify_test.go` 用工作区自带 esbuild 打包后以原生 node 执行（无 TS 服务/守护进程，沙箱无本地 socket 也可跑）：真实 Go DTO 通过**原 manifest** 的 canonicalRequired 断言；Go 产生的有序 viewer 版本序列（applied×4 → stale → duplicate + 最终 overlay 态）驱动**原 web reducer** `applyVersionedViewerOverlaySnapshot` 逐条核对。node/esbuild 缺失 = 测试失败而非跳过。

## 5. 实际命令与结果（2026-10-08，本机共享 checkout）

```
go vet ./internal/message/ ./internal/transport/legacyweb/          # 通过
go test ./internal/message/ -count=1                                # ok（37 个用例：create/history/sync/reaction/publication/live/hidden-directory/read-hook/reference-verify）
go test ./internal/message/ -race -count=1                          # ok 23.2s
go test ./internal/transport/legacyweb/ -run 'TestM4|TestFrozen' -count=1   # ok（30 个用例）
# 引用验证器（真实原 TS 模块驱动，测试内部执行）：
#   esbuild bundle internal/message/testdata/reference_verify.mjs → node <bundle> <fixtures>
gofmt -l（已格式化）
```

第二轮新增覆盖：live/sync 受众分离（公开线程 explicit viewer vs 私有线程 follower-only vs unfollow 后 history 存活）；扫描预算两类对抗形态（>20000 隐藏行、>512 不可见频道，HTTP 面显式 503 + 续扫可达）；32000 CJK 长文的字节界 resume 分页取尽且零跳过；隐藏目录三种角色/范围/community 豁免；0011 游标 unread（中间游标只剩 1 条未读且 firstUnread 指向正确行）；无伪造编辑/删除/saved 面（404/405）；重启后 ProjectPublication/LiveEligibility/ResumePage 稳定；原 reducer 驱动的 viewer 版本序列（applied×4→stale→duplicate）。

沙箱限制（非跳过、如实记录）：本环境禁止本地端口绑定，`TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware`（M3 既有用例）报 `bind: operation not permitted`；未验证它与我无关——它不在我拥有的文件中。`go build ./internal/...` 当前失败于 socket worker spike 的未入 go.mod 依赖（`zishang520/socket.io`，其按执行锁"主 go.mod 待父集成"），不在本 worker 范围。共享 checkout 中父/readstate 的在途编辑（`routes.go` 的 ReadstateRoutes 缝、`workspace_reserved_routes_test.go` 相关的 unread-summary 路由）使 `TestM3ReservedWorkspaceReadsDoNotBecomeWorkspaceIDs` 此刻红——该测试与文件均非本 worker 所有，已留待父处理。

覆盖的行为类：行为（发送/重放/冲突/验证顺序）、并发（8 路同 randomId 单行；-race）、回滚（校验失败零残留）、重启（reopen 同 data dir：事实/seq/游标密钥语义/randomId 重放/限流窗口）、授权（无 token/异空间/未加入/私有越权/归档/guest 冻结/403-404 分流）、长度（32000 UTF-16 精确、astral 计 2、U+0085 JS-trim 语义、randomId 128）、限流（60 桶共享、读取豁免、跨用户独立、replay 不绕过、窗口重置）、sync（可见性/线程兴趣/空洞前进/分页/频道范围）、overlay（after={seq-1}&limit=50）、reaction（幂等/聚合/版本计数器跨重启/add-remove-add 单调/两用户独立/游标守卫 409/系统消息 400/emoji 校验）。

## 6. 与参考实现的偏差（显式记录）

1. **随机幂等摘要严于 TS**：TS 重放仅比对 channelId；批准设计（§3.1"同键不同目标/内容不能悄悄成功"）要求 Go 校验内容+mention 目标摘要 → 同键改内容 409。digest 用目标 id（不含目录名）以免改名破坏合法重放。
2. **指定 channel 的 sync 要求线程有效 follow**：原 TS `syncMessages` 仅全局 sync 应用兴趣过滤；批准设计（phase-4 §6.2"含指定 channel"）明确收紧。可读未关注线程仍可 history/context。
3. **Reaction 版本为持久有序计数器**（父审阅后落地，见 §7），表由父加入 0010。
4. **纯正文 `@name` 不建 mention 事实**：批准合同 §3.1 只纳入"结构化 mention"；正文提及不自动调度（人类侧也不做姓名目录反查，避免姓名冒充面）。影响：仅打字未选人的 @ 文本不产生 mention/unread——记录为边界，P5 如需正文提及需独立签收。
5. **`searchText` 恒 null、`lastReplyAt` 用 ISO 毫秒**：TS 写 searchText 字符串、PG text 时间戳；Go 无搜索索引（搜索 501），null 为诚实值；lastReplyAt 归一为与 createdAt 相同的 ISO 毫秒（JS Date 两者等价解析）。
6. **senderMembershipStatus 的 removed/left 合并**：Go schema 无 departure 表，非成员一律 "removed"。
7. **限流为单实例固定窗口**（沿用 M3 平台约定），非 Redis 全局桶。
8. **actors 可见性**为 roster/隐式 server 成员（无 TS hidden-directory 策略——M3 未实现该策略）。

## 7. 父审阅意见落实（docs/m4-message-review-notes.md）

- reaction viewer/discussion 版本改为 0010 持久有序计数器（`message_reaction_(discussion|viewer)_versions`，引用列名/安全整数 CHECK）：真实变更同事务原子自增两者，幂等重读不变，缺行=0；`stateVersion` 哈希源已删除。新增 add/remove/add 单调、双用户独立、幂等不进位、重启保持并续计（`TestReactionVersionIsOrderedCounter`、`TestReactionVersionsPersistAcrossRestartAndTwoUsers`）。
- 版本读取失败必须传播：`readDiscussionVersion/readViewerVersion` 返回错误，不再伪造 1。
- 吞错审计：全部查询路径显式 `rows.Err()`；`projectOne` 等单行读取错误传播为端点 500 句。
- 历史行/覆盖/摘要/DTO 同快照（`Page.DTOs`/`ContextResult.DTOs`/`SyncResult.DTOs` 在同一 `WithReadSnapshot` 内投影），二次读取的假无洞断言已消除。
- publication 投影/读取入口见 §1.3。

## 8. 审阅落实

### 8.1 第二轮（7 项必改）

1. **live 与 sync 受众分离**：新增 `LiveEligibilityForChannel`（公开父频道线程=有权 explicit viewer；private/DM 父链=仅 active follower，`ViaFollow` 标记）；`AudienceForChannel` 保持 sync/resume 的全线程 follow 规则。测试 `TestLiveEligibilityDistinctFromSyncAudience` 冻结两者差异与 unfollow 后的 history 存活。
2. **字节有界 Resume + HTTP sync 类型化失败**：见 §1.3。`SyncResult.BudgetExhausted` → HTTP `503 sync_scan_budget_exhausted`，绝不返回截断成功/假空；resume 前缀截断 + 真实 currentSeq。测试覆盖 >20000 隐藏行、>512 不可见频道、32000 CJK 长文分页取尽。
3. **隐藏目录策略**：见 §2 reactions 段。逐条移植原 `shouldHideHumanDirectoryFromRequester` / `shouldExposeHumanInHiddenDirectory` / `isHiddenAllDirectoryScope`（含 community/community-cn slug 与 owner/admin 豁免），修正第一版"无隐藏策略"的错误报告。
4. **无伪造表面**：删除消息正文编辑/删除与 saved 的 501（原 TS 从未注册这些路由）→ 未知识别为 404/405；保留 search/forward/mention-actions 的授权后 501（原真实路由，M4 禁用）；方法门 405 + Allow、未知 404 由 dispatcher 固定（`TestM4NoInventedMessageSurfaces`）。
5. **thread:updated 精确 payload**：见 §1.3（syncCoreReplyWindow/discussion graph/latestReply 全字段移植）。
6. **ThreadSummary unread 用真实 0011 游标**：见 §2 读取段。
7. **引用验证器**：见 §4 fixture 段；含重启后投影/恢复入口稳定性测试（`TestM4RestartStableProjectionAndResume`）。

第二轮同时确认：私有频道发信按原语义 403 join-required（channel 层 posting 路径已不经过 read 判定）、移除成员历史 403 依赖父侧 residue 见证（非 auth 变更），本 worker 测试与两者兼容。

### 8.2 第三轮（3 项必改）

1. **线程回复读游标同事务 Hook**：见 §1.0（稳定签名、仅新回复、重放/历史不触发、回滚原子、两作者、装配完整性自检）。
2. **HTTP sync 稀疏大数据集可读**：见 §1.3 —— 订阅 SQL 前 LIMIT 过滤取代固定配额，仅留瞬态 deadline 失败；成员资格对空 workspace 也强制；>20000 隐藏行 / >512 隐藏频道下原裸数组游标协议最终取回授权行（域 + 真实 HTTP 双层测试）。
3. **Resume 字节界含完整信封**：见 §1.3 —— 精确信封核算 + `ErrResumeMessageExceedsBudget` 类型化错误（网关重试/关闭，无静默放行、无死循环）。

保持不变并继续由既有测试冻结：共享/私人 DTO 精确形状、公开线程 explicit LIVE 与 sync follow 的分离（`LiveEligibilityForChannel`/`AudienceForChannel`，供父 `m4_socket.go`/`m4_publications.go` 集成使用）。

## 9. 安全考虑

- 身份：claims 仅来自 `legacyweb.accessClaims`（已验 JWT 上下文），事务内 `ValidateHumanTx` 重验过期/类型/family 归属/撤销/真实资料；sender 永不接受 body 字段。
- 越权：所有读取走 `AuthorizeConversationTx`（线程递归根会话、跨空间/断链 fail-closed NOT_FOUND）；403/404 分流经 `HasPriorChannelRelationshipTx`，陌生人获字节一致 404；context 中跨频道消息 id 一律 404 "Message not found"；sync 空洞不泄漏其他空间活跃度（H 为本 workspace 范围）。
- 隐私：共享 DTO 不含 reaction viewer 私态；viewer 版本化快照仅 subject 收；actors 游标 HMAC 签名并绑定 principal/scope/message/emoji/版本/可见集。
- 日志/错误体不含正文、token、邮箱；429/409 保持原句。

## 10. 下一负责人动作

- 父：按 §1.0 接线 `SetThreadReplyReadHook`（readstate.MarkReadLatestTx，无环）；按 §1.1 接线路由与 cursor secret；`m4_socket.go`/`m4_publications.go` 使用 `ResumePage`/`LiveEligibilityForChannel`/`ProjectPublication`；publisher 用 §1.3 投影+准入；将本报告测试并入 `tests/acceptance/run.mjs` 拟定 suite（m4-message-http/idempotency/recovery/reactions-overlay/rate-limit）。
- readstate：直接读 §1.2 列出的协定表；ThreadSummary unread 的读游标扩展点在 `threadsummary.go threadUnread`（P5 接 0011 游标表）。
- socket worker：`ResumePage` + `SocketMessageNew/SocketMessageUpdated` 为恢复与密封投影的唯一入口，勿自算覆盖。
- 待办边界（不阻塞 P2 签收）：正文 @name mention、`hasMore` 在 resume 满页时的客户端合并验证属 P0/P3 互通项。
