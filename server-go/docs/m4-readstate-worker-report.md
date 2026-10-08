# M4 P5 readstate/Activity worker 执行报告

日期：2026-10-08。执行者：readstate worker（P5）。范围：`m4-activity-readstate-contract.md` 选定的全部端点的人类 READSTATE/ACTIVITY 后端。本文是执行记录，不是验收结论；真实监听器集成测试、浏览器/UI 与发布签收归集成人（P6–P9）。

## 0. 交付物与所有权边界

本人只新增/拥有以下文件（未改动 migrations、routes.go、go.mod、其他 worker 文件、客户端/UI/TS/var*/端口）：

- `internal/readstate/**`（domain 包 + 全部测试）
- `internal/transport/legacyweb/m4_readstate_handlers.go`、`m4_readstate_routes.go`、`m4_readstate_http_test.go`
- `server-go/contracts/m4-readstate-schema.sql`（0011 草案，幂等）
- `server-go/docs/m4-readstate-worker-report.md`（本文）

测试命令与结果见 §6。所有测试使用一次性数据目录（`t.TempDir()`）与进程内 recorder，不触网、不绑端口、不读写 var*。

## 1. 已冻结的 Schema 草案（供 0011 复核）

`contracts/m4-readstate-schema.sql`，10 张表（全部 `IF NOT EXISTS`，便于在已跑 0001-0010 的库上重放）：

| 表 | 主键 | 用途 |
|---|---|---|
| `user_channel_read_states` | (ws,user,channel) | 有效阅读边界 `last_read_seq` + `read_state_version`；read 单调前进，显式 unread 回退，每次有效变化 +1 版本（同版本必同值） |
| `user_channel_done_states` | (ws,user,channel) | 会话 Done（普通频道/人类 DM/一级线程统一）：`done_through_activity_seq` 单调 max、`done_at`、`active_override`、`revision`；仅当会话最新活动 seq ≤ frontier 时抑制，新活动自动复活；从不触碰 `thread_follows` |
| `user_mention_suppressions` | (ws,user,target_kind,channel) | Done/取关的持久 mention 边界（target_kind ∈ channel/dm/thread）；Mentions 过滤与取关线程预览封顶 |
| `user_channel_mute_states` | (ws,user,channel) | activityMuted + mute_from_seq + prefs_version（独立版本域） |
| `user_channel_display_prefs` | (ws,user,channel) | collapseLongMessages + prefsVersion（独立版本域） |
| `activity_principal_authorities` | (ws,principal) | 跨 filter 共享的单调 row_version 权威 |
| `activity_scopes` | (ws,principal,filter,window) | epoch/watermark/scope_digest/metadata（主窗口固定 main，100 行） |
| `activity_row_authorities` | (ws,principal,row) | 跨 filter 行身份（last_version+digest） |
| `activity_rows` | scope+row_id | 物化窗口行（payload 无 rowVersion；tombstone reason ∈ done/deleted/outOfWindow） |
| `activity_changes` | scope+seq | 每 scope 稠密变更日志；Go 侧执行 2048 保留，超限滚 epoch 而非留洞 |

**集成人已安装 0011**（`internal/platform/db/migrations/0011_readstate_activity.sql`，同名同列，另加 channels(id,workspace_id) 复合外键、scope 级联、integer typeof/range CHECK），并另加 0012 authority epochs。本包对两者无代码耦合；草案与 0011 并存验证（draft 重放为 no-op）由 `TestSchemaDraftAppliesToMigratedDB` 覆盖。

## 2. 已冻结的 Go API（供集成人接线）

```go
func NewStore(db *sql.DB, channels *channel.Store) *Store
// 生产默认直接绑定共享助手（见 §4）：
//   runWriteTx    = platformdb.WithWriteTx
//   readSnapshot  = platformdb.WithReadSnapshot（仅接口适配）
//   validateHuman = auth.ValidateHumanTx（ErrTokenInvalid 映射）
//   enqueue       = realtime.Enqueue（要求 *sql.Tx；预算满→错误+回滚）
// 测试可覆盖（SetClock/SetValidateHuman/SetEnqueue/SetWriteTx/SetReadSnapshot），
// 但默认即生产语义，单测跑在生产默认上。

// 操作（全部接受完整 auth.AccessTokenClaims，事务内复验 session+membership）：
MarkRead / MarkReadLatest（含 residue-only receipt）/ MarkUnread /
MarkInboxReadLatest（{markedCount, scopes}）
DoneChannel / UndoneChannel / DoneThread（删除线程与已删 DM 父链的本人残留裁决，
陌生人合并 404）/ UndoneThread（显式取关的 mention 边界保留）
NotificationSettings / SetNotificationSettings / DisplaySettings / SetDisplaySettings
InboxItems（all/unread/mentions/unread_mentions；limit≤100、offset、channelId、q、sort、
  groups/totalCount/totalUnreadCount/activeUnreadCount 真实计算）
DoneInboxItems / UnfollowedInboxItems
UnreadCounts / UnreadSummary（#632 SSOT readState 投影）/ ServerUnreadSummary
ActivitySnapshot / ActivityDifference（reconcile + 100 行 main 窗口 + 2048 保留 + epoch 滚动）

// 供 channel worker follow 流在同事务内复用（评审意见 6）：
MarkReadLatestTx(ctx, ex, claims, ws, channelID) (ReadStateResult, error)
ReadCursorTx(ctx, ex, ws, userID, channelID) (int64, error)

// HTTP 注册（父级已从 legacyweb.New 接线；未改 routes.go）：
RegisterReadstateRoutes(mux *http.ServeMux, handlers *ReadstateHandlers, gate *AuthGate)
```

端点清单（全部实现，无一常量空数据）：`GET /api/channels/activity/snapshot|difference`、`GET /api/channels/inbox|inbox/done|inbox/unfollowed`、`POST /api/channels/inbox/done|undone|read-all`、`POST /api/channels/{id}/read|read-all|unread`、`GET /api/channels/unread(?summary=1)`、`GET/PATCH /api/channels/{id}/notification-settings|message-display-settings`、`POST /api/channels/threads/done|undone`、`GET /api/servers/unread-summary`。`POST /api/read-mutations`、`GET /api/read-mutations/frontier` 授权后 501 `feature_not_implemented`。follow/unfollow/threads-followed 归 channel worker，本包只消费 `thread_follows` 共享事实。

## 3. 关键语义裁定（对照合同逐条）

1. **Read/Done/Follow/Mute 四概念分离**：Done 不写 follow 行；mute 不动 read 游标（有测试）；follow 由 channel worker 调 `MarkReadLatestTx` 在同一事务内完成原 legacy 的"follow 即标读"。
2. **read 只推进到本会话已存在边界**：伪造超大 seq 被钳制到当前 max（`TestMarkReadAdvancesAndClamps`）；read-all 边界在事务内固定，之后新消息仍可未读；read-all 与并发新消息竞争只产生一致结果（`TestConcurrentReadAllVersusNewMessage`）。
3. **显式标未读**：回退到"最新一条非本人消息"前一位，版本 +1；wire `maxReadSeq` 投影有效状态；仅本人消息时诚实零操作；晚到的低 read 不能越过回退边界。
4. **Done frontier 四态矩阵**（`TestDoneChannelFrontierMatrix`、HTTP `TestReadstateHTTPDoneMatrix`）：省略值→事务内权威快照（空频道诚实 400 REQUIRED）；有值无 frontierSpace→412 `DONE_FRONTIER_SPACE_REQUIRED`；frontierSpace≠storage→400 `DONE_FRONTIER_UNMAPPABLE`；storage+合法值→严格守卫：非正规范十进制（含 0、前导零、null、数字）→400 `DONE_FRONTIER_REQUIRED`；超前→409 `DONE_FRONTIER_BEYOND_LATEST`（不截断）；>2147483647→409 `DONE_FRONTIER_ABOVE_INT4_AUTHORITY`（保留原 int4 语义，不做 widen）。成功 `{ok:true}`；done_through 单调 max；失败零越权写入（表级断言）。
5. **Done 复活规则**：存储行保留确认边界，投影按"最新活动 seq > frontier"复活（新回复/新消息自动 active，无需消息抵达钩子——message worker 不 import readstate）。
6. **删除域残留**：已删线程/已删 DM 父链仅当调用者持有本人残留（read/done/suppression/follow 行）才允许清理，返回 legacy receipt（`legacyNoop/terminalReason/retiredThroughActivitySeq/readStateVersion/changed`）；陌生人合并 404，不泄漏存在性；read-all 对失去 private 访问但有历史关系者返回 residue-only receipt（无 seq 字段）。
7. **未读计数**：全部来自可见消息事实（seq > 游标且非本人），无跨 scope 减法；公开频道全 workspace 可见计数、private/DM 按成员、线程按活跃 follow + 可读父链；Done 抑制排除；guest（冻结门）聚合面诚实为空。
8. **Inbox/Activity 投影**：非成员公开频道仅通过 mention 行进入（unread=0、mentionOnly）；`all` 含未 Done 的取关线程（unread=0/hasMention=false、预览封顶在取关边界——边界从共享 `unfollowed_at` 派生：取关时刻已提交的最新回复）；`mentions` 与读取状态无关（读过的 mention 不消失），`unread_mentions` 组合态；q 只筛本人列表；排序 activityAt/kind/scopeId 同向。
9. **Activity 线协议**：epoch/watermark/rowVersion/latestActivitySeq/maxReadSeq/readStateVersion 全部规范 UInt64 十进制字符串（拒绝符号/空格/前导零/小数/指数；>2^63 的 wire 值→409 snapshotRequired 而非溢出）；`activityVersion = watermark`；差量 `(after, current]` 去重到每行最后变化，`fromSeq=after+1`、`nextFromSeq=null`；相等且无变化→200 notModified；epoch 不符/after 超前/日志缺口→409 snapshotRequired；2048 保留超限→epoch+1、清日志与墓碑、watermark 重置（旧差量 409）；同一行跨 filter 共享 rowVersion（principal 权威）。
10. **两套数字域不混用**：传统 read/read-all/unread/inbox read-all 响应为 JS 安全整数（JSON number），Activity 为十进制字符串，均有测试断言。
11. **reconcile 一致性边界**：canonical 窗口与变更日志写入在同一 `db.WithWriteTx`（IMMEDIATE+fence）内完成；快照读取在 pinned `BEGIN DEFERRED` 上单连接完成。
12. **私人状态**：mute/display/read/Done 不进任何共享消息投影；publication 仅对象/属主引用（subject_user_id+scope_id），无 payload、无收件人列表；预算满→事务回滚（`TestBacklogFullRejectsAndRollsBack`）。

## 4. 对父级评审意见（docs/m4-readstate-review-notes.md）的响应

1. **移除重复默认实现** ✅：`store.go` 四个本地默认（defaultWriteTx/defaultReadSnapshot/defaultValidateHuman/defaultEnqueue）已删除，`NewStore` 直接绑定 `platformdb.WithWriteTx/WithReadSnapshot`、`auth.ValidateHumanTx`、`realtime.Enqueue`（仅做结构同型接口适配）。单测运行在生产默认上（`TestProductionDefaultsAreSharedHelpers` 行为验证：授权 fence、快照并发、精确身份谓词、真实 publication 行）。
2. **禁止提交失败后重播业务回调** ✅：重试机制随本地默认一并删除；共享驱动的获取重试不重播回调（`TestWriteTxRunsCallbackExactlyOnce` 用包着生产绑定的计数器断言回滚/提交路径各恰好一次）。
3. **精确身份谓词** ✅：直接使用 `auth.ValidateHumanTx`（零 ExpiresAt、未来 IssuedAt、过期、非本人 family、撤销 family 均拒绝——新增负例）；数据库错误不再被折算成凭据裁定（错误原样上抛，transport 映射 500/403 而非 401）。
4. **enqueue 契约** ✅：绑定 `realtime.Enqueue`（要求事务、幂等、无效引用/预算满→错误并回滚关联事实；`MaxPending` 语义见 `TestBacklogFullRejectsAndRollsBack`）。旧"静默丢弃"实现已删。
5. **0011/0012** ✅：本包不耦合 0012；草案幂等重放与 0011 并存已测（`TestSchemaDraftAppliesToMigratedDB`、`TestSchemaDraftMatchesStoreUsage`）。
6. **follow 同事务标读钩子** ✅：`MarkReadLatestTx`（完整 claims 复验）与 `ReadCursorTx` 已导出并加测试（`TestFollowHookMarkReadLatestTx`、`TestReadCursorTxHook`）；readstate 不改 `thread_follows`。集成人可将 `internal/app/m4.go` 的 `readCursor` 适配器换成 `ReadCursorTx`，并在 channel worker 的 follow 路由事务内调用 `MarkReadLatestTx`。

## 5. 与参考实现的差异（逐条申报，非静默）

1. **Inbox 时间戳格式**：TS legacy 内联 SQL 输出 `YYYY-MM-DD HH24:MI:SS.US+00`，Done/unfollowed 路径输出 ISO。Go 统一 ISO-8601 毫秒 `Z`（与 Date.toJSON 一致，channel 包 `milliTime` 同款）。JS 消费端两格式均经 `new Date()` 归一，行为等价。
2. **InboxItem 可空字段**：TS 对 `doneAt`/`unfollowedAt` 区分"显式 null"与"缺省"；Go 对 active 行省略该键（JS 两者皆 falsy）。`latestActivitySeq`、`firstUnreadMessageId` 等始终显式（含 null）。
3. **跨 workspace Done**：legacy `/inbox/done` 接受其他 workspace 的频道（canonical membership 复验）。Go 面向请求 workspace 作用域，跨 workspace 目标合并 404；残留清理走目标空间自身端点（客户端切空间）。合同 §2"身份、当前 workspace 与对象权限检查先于领域操作"支持此裁定。
4. **unfollow 边界派生**：TS 在 unfollow 时冻结 seq 边界；Go 从共享 `unfollowed_at` 派生（"提交时刻 ≤ unfollowed_at 的最新回复"）。并发提交时钟回拨的极端情形下可能相差一条；如需完全冻结，父级可在 channel worker unfollow 事务内调用本包导出的 suppression 写入（当前未导出，避免 readstate 反向写 follow 语义）。已在 §3.8 标注。
5. **`userChannelInboxStates`→统一 done 表**：TS 线程 Done 放 `thread_follows.done_at`；按 m4 合同 §3 的"conversation Done state"表，Go 统一入 `user_channel_done_states`（follow 行不被覆盖），投影端等价。
6. **#all/announcement 隐式成员**：TS legacy 内联 SQL 对 #all 无隐式成员处理（依赖 RW serving rows）；Go 按 M3 Go 的 ListChannels 语义把启用的 #all/announcement 计为已加入（含聚合与未读）。
7. **`isHumanActivityMuteEnabled` 特性开关**：legacy 由 feature flag 门控；Go 恒启用真实持久化（合同 §2 要求"必须真实持久化"，M3 已无全局 flag 机制）。

## 6. 测试证据

环境：Go 1.27.1（go.mod toolchain），`GOCACHE` 指向沙箱可写目录。全部命令在仓库 `server-go/` 下执行。

```
go test ./internal/readstate/ -count=1          # ok  ~1.8s
go test ./internal/readstate/ -race -count=1    # ok  ~37s
go test ./internal/transport/legacyweb/ -count=1 -skip 'TestM3WebSocketUpgrade|TestM3ReservedWorkspaceReads'   # ok
go vet ./internal/readstate/ ./internal/transport/legacyweb/   # clean
go test ./internal/app/ ./internal/channel/ ./internal/message/ ./internal/realtime/ -count=1   # ok（父级/兄弟 worker 集成不回归）
```

覆盖（`internal/readstate/` 34 个测试函数 + legacyweb 8 个 HTTP 测试）：
行为（read/unread/read-all/inbox read-all/prefs/inbox 四 filter/未读计数/账号摘要/Done 复活）、矩阵（Done 412/400/409×边界、thread NOT_A_THREAD/残留/已删 DM 父链）、Activity（snapshot 形状、notModified、difference 去重、409 三态、>2^63 wire、tombstone done/deleted、跨 filter rowVersion、跨 scope 误用、2048 滚动+旧 epoch 409、重启持久化）、并发（读/写竞态单赢家、并发 Done 幂等、并发 snapshot 日志稠密、read-all vs 新消息）、失败（失败零写入、预算满回滚、撤销会话、跨 workspace/无成员/陌生人）、schema（草案应用于已迁移库、幂等、列形状、FK check）、负例（伪造大 seq、0/前导零/null frontier、错误 frontierSpace、错误 receiver、布尔类型校验、缺参句子逐字对齐）。

**原版参考执行**（合同 §7-7）：`TestActivityWireAcceptedByReferenceReducer` 把本包真实产出的 snapshot/difference wire 写入临时文件，用仓库自带 tsx 驱动原版 `packages/sync-core/src` 的 `createSyncCore`+Activity domain ingest（非自制解析器），断言无 violation、状态物化。node/tsx 缺席时诚实 skip。

## 7. 沙箱限制与未执行范围（如实申报）

1. 本沙箱禁止本地端口绑定（EPERM）：`TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware`（既有测试）与 `internal/platform/mail` 的 SMTP greeting 测试无法运行，与本包无关；我的全部 HTTP 测试走 `httptest.NewRecorder`（无监听）。
2. `tsx` CLI 的 IPC pipe 被沙箱禁止，参考执行测试改用 `node --import tsx`（等效加载器路径）。
3. **父级所有权的既有测试需要更新**：`TestM3ReservedWorkspaceReadsDoNotBecomeWorkspaceIDs`（workspace_reserved_routes_test.go，非本人文件）仍断言 `/api/servers/unread-summary` 返回 501；父级已置 `ReadstateRoutes: true`，该路由现为真实 200。该断言由集成人更新（保留 join-community 的 501 断言即可）。
4. `internal/transport/socketio/zishang/**`（socket worker 的隔离 spike）引用了 go.mod 尚未引入的依赖，`go build ./...` 会失败；我未触碰该目录，`go list/test` 按集成人的 spike 约定排除它。
5. 未执行：真实监听器/TCP/Socket 端到端、浏览器/UI 验收、live var* 数据、提交/推送（明确排除）。`internal/app/m4.go` 已由父级接线本包（seams 全部按 §2 绑定），集成级验证归父级。

## 8. 集成人下一步

1. 更新 §7-3 的既有断言（unread-summary 不再 501）。
2. channel worker follow 路由：在同一 `WithWriteTx` 内调用 `MarkReadLatestTx`；将 `app/m4.go` 的 `readCursor` 换成 `ReadCursorTx`。
3. 若要完全冻结 unfollow 边界（§5-4），在 channel worker unfollow 事务内补写 suppression（需本包再导出一个受控写入入口，半小时工作量）。
4. P6 撤权窗口与 P7 升级链路对本包 0011/0012 的联合验证。

## 9. 第二轮（Actual HTTP group 11 + 跨切面审查）裁定与修复

对照 `docs/m4-readstate-review-notes.md`（Appended 段）与 `docs/m4-cross-slice-review.md`（v2）逐项裁定；先给结论表，证据与修复随后。**所有修复已附回归测试**；测试命令同 §6，另加 `-run 'TestMuted|TestMuteEpochs|TestMarkUnread|TestResidueReadAll|TestActivityDifferenceDeterministic|TestAnnouncementDefault|TestDoneHistoryExcludes|TestInboxReadAllSkips|TestUnreadSummaryMentions|TestTombstoneReason|TestMentionOnly|TestReal|TestReadstateHTTPMuted'`。

| 编号 | 裁定 | 处置 |
|---|---|---|
| A1 MarkUnread 计数 | 实锤（全局 AUTOINCREMENT seq 差把别的频道序号计入） | 已修：改真实 `COUNT(*)`（channel 限定 + `seq>maxReadSeq AND seq<=boundary AND NOT own`），与 unread.go/inbox.go 的 COUNT 域一致 |
| A2 失权 read-all 泄漏当前高水位 | 实锤（残留路径调用 `latestSeqTx` 并把当前 max 写进前成员 cursor） | 已修：residue 分支不再查询/写入任何当前值——cursor 原样保留，receipt 取现值 changed=false |
| A3 difference 顺序随机 | 实锤（map 迭代） | 已修：rows 按 lastActivityAt 降序/rowId 升序、tombstones 按 rowId 升序（与 materializeWindow 比较器一致）；回归含“同状态 7 次重建字节一致” |
| A4 mentionOnly 丢 AnyMention | 审查 v2 已撤销（我第一轮已修） | 证据：inbox_page.go 两处 `AnyMention: true`；新增 TestMentionOnlyRowsCarryAnyMention 锁定 |
| A5 公告默认静音未入投影 | 实锤（默认只在 GET settings 合成，且 MuteFromSeq=nil 与原版 0 不符） | 已修：资格谓词内置隐式公告 epoch（boundary 0）；GET 默认改 `{muted, muteFromSeq:0, version:0}`；显式首次 mute/unmute 冻结隐式区间 `[0, latest]` 防 backfill |
| A6 回复者 read 推进 | 归父级接线（message worker 经回调调 `MarkReadLatestTx`，无环） | 钩子已在（第一轮），测试 TestFollowHookMarkReadLatestTx 保持；本包无改动 |
| A7 线程 sync follow 过滤 | 按父级裁定忽略（已批准的 Go 决定） | 未改 |
| A8 Done 历史含已复活行 | 实锤（无反向条件） | 已修：Done 历史（chat+thread 两查询）仅保留 `done_through >= 当前最新活动` 的行；复活行只出现在主 Inbox |
| A10 缺 scope_read:updated | **裁定为与原实现一致的“无事件”，非缺陷**，但补齐投影器支持 | 证据：`readReceiptService.ts:187-192`——exposed-peer 列表 agents-only，human actor 在 `actorIsMember` 处必然被丢弃，"a human read never reaches other clients"；M4 仅有人类读。readstate 不为人类读 enqueue scope_read 是忠实行为。`ProjectPublication` 保留该分支（含未来 payload 形状与 peer-limit summary 变体），见 §10 |
| A11 inbox read-all 线程父链 | 实锤（thread 分支无父链谓词；第一轮补丁因字符串不匹配未落地，本轮按行重写并验证） | 已修：补 pm/pc JOIN + 归档/hidden-#all 排除 + private/DM 父成员 EXISTS，与 loadThreadCandidates 同一谓词 |
| A12 摘要 mention 绕过 Done 抑制 | 实锤 | 已修：mention 聚合并入 effective-done NOT EXISTS 与 mention-suppression 边界（`seq > done_through`） |
| D1 tombstone reason 未比对 frontier | 实锤 | 已修：reason=done 仅当 `done_through >= 频道最新`；read 推进导致的离窗为 outOfWindow（TestTombstoneReasonReadAdvanceIsOutOfWindow） |
| D2 defaultEnqueue 用 time.Now | 第一轮已随本地默认删除而消失（现绑 realtime.Enqueue） | 无需处置 |
| D4 mute DEFAULT 1 与原默认相反 | 草案已改 DEFAULT 0 | **请父级对齐 0011/新迁移**（现有 INSERT 均显式赋值，行为无风险，仅防误用） |
| reaction 版本 | message worker 已修（审查 v2 §B） | 不在本包 |

### 9.1 group 11（真实 mute/Inbox）根因与机制

失败根因：Inbox 的 unreadCount/promotion 用“当前 mute 行标志”计算。父级复现序列里旧 mention 已读、mute 后新普通消息把 raw 未读数抬到 1，unread filter 便包含该频道——把“频道追赶未读”误当“Activity 事实未读”。

修复采用**持久 mute epoch**（不是静默重算当前标志，也不是空数据/推进游标）：

1. 新表 `user_channel_mute_epochs`（草案已加；**请父级以 0013 安装**，形状见草案 §4b）：`(ws,user,channel,muted_at)` 主键，`mute_from_seq`（开闸边界）与 `suppressed_through_seq`（关闸时冻结的当前 max seq；NULL=仍开）。
2. 资格判定（`chatEligibilityPredicate`，inbox.go）：消息 eligible ⟺ 个人 mention 穿透 ⟂ 非“被提交时刻活跃的 epoch 覆盖”（`mute_from <= seq <= suppressed_through`）。epoch 区间纯 seq 域：等毫秒时间戳、时钟回拨、重启都不影响（TestMuteEpochsSurviveRestartAndEqualTimestamps）。
3. mute 时开 epoch（boundary=latest+1）；unmute 时关 epoch（`suppressed_through = MAX(latest, mute_from-1)`）——被抑制区间永久冻结，**unmute 绝不回填**（对照 inboxPolicyModel.test.ts:1190-1245 逐句断言：muted ordinary 无 Activity fact、`getUnreadCounts` 仍为 1、unmute 无 backfill、真实 read 清零）。
4. 公告频道隐式默认 = 无显式行且无 epoch 时的 `[0, ∞)`；首次显式 mute/unmute 前先冻结 `[0, latest]` 闭合 epoch，防显式操作把隐式抑制历史回填。
5. 域分离冻结：Inbox/Activity 的行 unreadCount、filter=unread、totalUnreadCount、activityUnreadCount 均为 **Activity 事实域**（eligible 计数）；`GET /channels/unread`（map 与 summary 的 unreadCount）保持**频道追赶域**（raw 计数）——两域同测断言（TestMutedOrdinaryTrafficActivityVsCatchup、TestReadstateHTTPMutedUnreadFilterRepro）。
6. 线程不受 mute 抑制（原 `isActivityPromotionSuppressedByMute kind!=='thread'`），thread 聚合保持 raw。

### 9.2 其余第一轮遗留的更正

- `MarkInboxReadLatest` 不再 enqueue workspace 级 `read_state:updated_bulk` intent：其 scope 列表是请求态而非持久对象引用，无法按“当前事实重投影”重建；每个变更 scope 已按各自 `read_state:updated`（revision=版本）幂等 enqueue，web 端 ledger 对单事件与 bulk 等价收敛（TestRealGoWireFeedsOriginalReadStateLedger 用原 ledger 验证）。

## 10. 新增跨模块 API：当前授权 Publication Projector（尽早冻结）

```go
// internal/readstate/projector.go
type ProjectedEvent struct {
    Event         string         // socket 事件名（compat §4.2）
    ServerID      string
    SubjectUserID string         // 私有事件的目标（user∩workspace 房间由 worker 决定）
    Payload       map[string]any // 精确 wire payload（单参数）
    SharedScope   bool           // 仅 scope_read 受众共享回执
}

// ProjectPublication 为本包 mutation 产生的一个 publication intent 渲染
// 当前授权 payload。subject 的完整 claims 按当前事实复验（会话族+成员）：
// 失效/失权 → (nil, nil)（wake 丢弃，绝不按旧权限投递）。payload 从当前
// 数据库事实快照重读，不持久化、不缓存。
func (s *Store) ProjectPublication(ctx, subjectClaims auth.AccessTokenClaims,
    p PublicationIntent) ([]ProjectedEvent, error)
```

精确 payload（与原 web 消费方逐字段对齐，测试锁定）：
- `read_state:updated` → `{serverId, scopeId, maxReadSeq:number, readStateVersion:number}`
- `unread_summary:changed` → `{serverId}`
- `notification_prefs:updated` → `{serverId, scopeId, prefs:{activityMuted,muteFromSeq}, prefsVersion}`
- `message_display_prefs:updated` → `{serverId, scopeId, prefs:{collapseLongMessages}, prefsVersion}`
- `scope_read:updated` → 人类 subject 恒不投影（§9 A10 证据）；未来 agent 写入者：`{scopeId, peerKind, peerId, maxReadSeq}`（超 exposed-peer 上限时 `{scopeId, summaryChanged:true}`），SharedScope=true，房间/受众由 worker 裁定。

接线建议：realtime worker dequeue `realtime_publications` 后按 (object_type,event) 分派；subject claims 由 worker 从当前会话解析（publication 不携带凭据）。

## 11. 需父级动作汇总

1. **0013 安装 `user_channel_mute_epochs`**（草案 §4b 原文可抄；含 `suppressed_through_seq >= mute_from_seq - 1` CHECK 以表示空区间）。未安装前生产 mute 语义与测试不一致（测试库经草案自建表）。
2. 0011 的 `user_channel_mute_states.activity_muted DEFAULT 1` 建议 0013 一并 `ALTER`/重建对齐 DEFAULT 0（D4；现无行为风险）。
3. realtime worker 按 §10 接 ProjectPublication；message worker 的线程回复回调接 `MarkReadLatestTx`（A6），channel worker follow 同。
4. §7-3 的既有断言更新（unread-summary 不再 501）仍待父级。
5. `internal/app/m4_socket_test.go` 当前 6 例失败为父级 socket 绑定未组装（"socket.io wire binding not assembled"，socket worker 依赖未入 go.mod）——与本包无关，本轮全量验证时如实记录。

## 12. 剩余偏差（需产品/父级决策，非“已实现义务”）

1. **跨 workspace Done/read-all 残留清理**（§5-3）：原 legacy 允许对别的 workspace 频道 Done；Go 按请求 workspace 合并 404。需产品确认客户端始终切空间后可关闭。
2. **unfollow 边界派生**（§5-4）：现从 `unfollowed_at` 派生（提交时刻 ≤ 取关时间的最新回复）；与原“取关时冻结 seq”在并发时钟回拨下可差一条。如需完全冻结：channel worker unfollow 事务内调用本包受控 suppression 写入（需再导出一个入口，约半小时）。
3. **C 组 fixture 裁决项**（审查 §C：HTTP message 面 key 集、conversationContext presence、Done 空目标错误映射、system 消息是否计入未读、有行时 activityMuteSupported 输出、sidebar 对未加入公共频道计入）：待 P0 执行式 fixture 冻结后统一，本包未单方面改。
4. **read_state:updated_bulk intent 移除**（§9.2）：web 对单事件等价收敛（原 ledger 已验证）；若产品要求事件名级 fidelity，需引入持久 scope 列表引用（新 schema 决策）。

## 13. 父级 0013 前追加意见（epoch 键审查 + DM 投影）的落实

1. **epoch 键改造（已按父级审查执行）**：主键改为 `(workspace_id,user_id,channel_id, epoch_version)`；`epoch_version` 取本事务的下一个 `prefs_version`（单调；**0 保留给隐式公告前缀的冻结 epoch**），`muted_at/unmuted_at` 仅为真实时钟观测值，不做 timestamp+1 伪时间。新增部分唯一索引 `…_open`（`WHERE suppressed_through_seq IS NULL`）强制每接收者/频道至多一个开 epoch；空区间（`suppressed_through = mute_from - 1`）为合法形态。专项测试：`TestMuteEpochsSameClockTripleToggle`（同毫秒三连 toggle=3 个闭合 epoch、直写第二个开 epoch 被索引拒绝、双接收者独立）、`TestMuteEpochsSurviveRestartAndEqualTimestamps`（等时间戳不同 seq + 重启）。**0013 终版草案见 contracts/m4-readstate-schema.sql §4b，可直接安装。**
2. **DMReadStateTx / ReadFrontierJSONTx（已导出，父级接线 M4ConversationHandlers.DMReadState）**：
   ```go
   // 精确 #632 InboxScopeReadFrontier wire（父级不再自行拼形状）：
   // {"kind":"absent"} | {"kind":"present","readStateVersion":<num>,
   //  "maxReadSeq":"<decimal>","latestActivity":{"messageId","seq"}|null}
   func (s *Store) ReadFrontierJSONTx(ctx, ex Queryer, workspaceID, userID, channelID string) (json.RawMessage, error)
   // DM 变体：调用方已在同一快照授权 DM scope；本投影对非本空间/非参与者
   // 额外 fail-closed（404 形状），latestActivity 为同源消息对（空 scope 为 null）。
   func (s *Store) DMReadStateTx(ctx, ex Queryer, workspaceID, userID, channelID string) (json.RawMessage, error)
   ```
   测试：`TestReadFrontierJSONExactWire`（absent/present/同源对逐字节）、`TestDMReadStateParticipantGuard`（参与者 wire、非参与者 404、非 DM scope 404）。
3. **通用列表/DM 富化**：原实现把同一 #632 union 附着到 DM 视图与 followed threads（channelService.ts:1107/1237/7666/8041 的 `readState` 字段）——channel worker 的 `/channels`、`/channels/dm`、threads 摘要可直接复用 `ReadFrontierJSONTx`（已授权 scope 通用版）；勿单独再发明 prefs/read 端点之外的形状。

## 14. 第二轮最终验证（2026-10-08 深夜）

```
go test ./internal/readstate/ -count=1      # ok（52 测试函数）
go test ./internal/readstate/ -race -count=1 # ok
go test ./internal/transport/legacyweb/ -run TestReadstate -count=1  # ok（9 HTTP 测试）
go vet ./internal/readstate/ ./internal/transport/legacyweb/          # clean
```

并行 churn 声明：legacyweb 全套本轮出现 3 例兄弟 worker 面失败（`TestM4SyncBudgetExhaustionIsTypedFailure`＝message worker sync 预算面；`TestRoutePolicy`/`TestUnchangedHonestSurfaces`＝socket worker 刚落地的 `/socket.io/` polling 行为 400 vs 旧断言 501）＋父级 app 的 6 例 m4_socket 绑定未组装——均不在本包文件（`git status` 佐证为他人未提交改动），本包面全部通过。真实 HTTP parity（m4-backend.mjs group 11 复跑）由父级执行。
