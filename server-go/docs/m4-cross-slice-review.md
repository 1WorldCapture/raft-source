# M4 跨切片只读审查（message / readstate / channel + legacyweb m4 handlers）

日期：2026-10-08（v2，按父层裁定更正并全量重验）· 基线：工作区当前未提交实现 ·
性质：**只读审查，未修改任何产品文件**。对照物：已批准 M4 文档
（phase-4-messaging.md、m4-activity-readstate-contract.md、m4-compatibility-contract.md、
m4-execution-lock.md、m4-authority-contract.md）与原始 TS/Web 消费方（逐条引用原源码行验证）。
本版相对 v1（曾误置于仓库根 docs/，已删除）的更正：

1. **撤销 v1-A7**（channel-scoped HTTP sync 的 thread-follow 要求）：phase-4-messaging §6.2
   明文"HTTP `/messages/sync`（含指定 channel）与 Socket resume 共用此过滤"——这是已批准的
   Go 设计决定，不是 bug。m4-compatibility-contract §1 同义。不得回退。
2. **reaction 版本问题已由 message worker 修复**（本审查重读确认）：reaction.go 现用
   `message_reaction_discussion_versions` / `message_reaction_viewer_versions` 持久计数表
   （readDiscussionVersion/readViewerVersion/bumpDiscussionVersion/bumpViewerVersion，
   reaction.go:382-452），absence=0，DB 错误以 `fmt.Errorf` 传播不再吞错。**无遗留**。
3. v1-A4（Mentions filter 丢弃 mentionOnly 行）已被 worker 修复：inbox_page.go:170,266
   现置 `AnyMention: true`。**撤销**。
4. 其余条目全部对照 22:47-23:09 的最新文件重验，行号为当前版本。

---

## A. 实锤 blocker（重验后仍成立，按危害排序）

> **A1 已撤销（v2.1）**：v1/v2 初版把 `MarkUnread` 的 `boundary - maxReadSeq` 判为
> 计数错误。重读原 TS `channelService.markUnread`（channelService.ts:15034 附近）
> 发现原实现就是 `unreadCount: Math.max(boundary.latestUnreadEligibleSeq - scope.maxReadSeq, 0)`
> —— **同一个差值**；且 rewind 总把 cursor 置为 boundary-1，差值恒等于"本次回退的
> 1 条"，与 COUNT 语义在当前行为下等价。Go 与原 TS 逐字一致（本审查的 in-process
> Go 采集亦实测 unread=1）。合同"不是 seq 差"一句只描述 unread **列表**端点
> （unread.go 的 COUNT 路径），不适用于 markUnread 响应。仅建议（P3）：改写为
> COUNT 以防 rewind 语义变化后回归，非必须。

### A2（P1·信息泄漏）read-all 失权残留路径把失权者 cursor 推到当前高水位
`internal/readstate/readstate.go`（MarkReadLatest，residue 分支 ~281-304）：
authorize 404 且 `hasPriorChannelRelationshipTx` 成立 → `residueOnly=true` 后仍执行
`applyReadAdvanceTx(latestSeqTx(...))`，把**当前**频道高水位写入前成员的
`user_channel_read_states.last_read_seq`。HTTP 响应虽按原 receipt 省略 seq，但存储已把
"失权后新增了多少消息"编码进前成员可读的自家状态（notification-settings/
unread-summary 的 readState union 都回显 maxReadSeq）。合同 §4.2 只允许"清理自己的旧
状态"。对比：DoneThread 的删除残留路径（done.go retireDeletedThreadResidueTx）面向
已删除对象，泄漏面为历史高水位，风险较低；本条是**活跃频道**的当前值。
最小修复：residue-only 分支不调用 applyReadAdvance（保留旧 cursor 或删除行），
receipt 的 readStateVersion/changed 取现值。

### A3（P1·Activity 线格式）difference 的 rows/tombstones 顺序随机
`internal/readstate/activity.go:227-247`：`latestByRow := map[string]activityChange{}`
+ `for _, change := range latestByRow` —— Go map 迭代顺序随机，同一状态两次请求的
difference rows 数组顺序不同。生成 schema 的 rows 是有序数组；契约 runner 的
canonicalJson 明文"arrays keep semantic order — order IS behavior"；snapshot 窗口侧
（materializeWindowTx:891-901）已有正确的稳定排序（lastActivityAt 降序、rowId 升序），
difference 侧没有。跨端 digest、客户端逐行合并、测试都会闪断。
最小修复：输出前按 materializeWindowTx 相同比较器排序（rows 与 tombstones 各自）。

### A5（P1·与原 TS 行为相反）announcement 频道默认静音未作用于 Activity/Inbox 投影
原 TS `channelService.ts:1250-1296`：`ANNOUNCEMENT_DEFAULT_MUTE={activityMuted:true,
muteFromSeq:0,prefsVersion:0}`，经 `attachActivityMuteState` 作用于 inbox 行——
无显式 mute 行的 announcement 频道在 Activity 中**不提升、无未读**（注释原话：
"50 agents' hourly posts must not read as loud unread"）。Go 中该默认只存在于
`prefs.go:279-299`（GET notification-settings 合成，且 `MuteFromSeq=nil`，原版=0）；
`inbox.go` 的 promotion-eligible-latest 查询（~691-703）与 unread 窗口只看
`user_channel_mute_states` 表 → announcement 消息正常提升+计未读。同一事实两个面相反。
最小修复：promotion/unread 查询对 `system_kind='announcement' AND type='channel'` 且
该用户无显式 mute 行的频道按 `mute_from=0` 处理（并让 GET settings 的合成默认带
muteFromSeq=0 与原版一致）。

### A6（P1·未读状态错误）回复线程后未推进回复者 read cursor
原 TS 线程回复两处（messageService.ts:2653-2657 首条回复路径、2759-2762 常规回复路径）：
`recordThreadFollow("replied",{reactivateUnfollowed:true})` 之后紧跟
`markReadLatest(senderId, threadChannelId)`（"activity" cadence）——回复者自己的回复
立即算已读。Go `message/create.go`（CreateTx thread 分支 ~140-152）只做 follow
（replied 激活 ✓、mention 激活 ✓），无任何 read 推进（grep markRead/ReadAdvance 零命中）
→ 回复者回复后该线程仍显示未读（自己的回复）。
最小修复：thread 分支在同一事务内把回复者 cursor 推进到该消息 seq（经 readstate
共享 seam/父层用例，不引包循环）。

### A8（P1·列表语义）Done 历史包含已"复活"的行
原语义（合同 §4.2 + inbox 查询族）：Done 后新活动超过 frontier → 行回 active/主 inbox。
主 inbox 正确地以 `done_through_activity_seq >= channel latest` 派生排除
（inbox.go:551-558、unread.go:185-193）；`DoneInboxItems`（inbox_page.go:471-489）
**没有反向条件**——新消息超 frontier 后同一行同时出现在 inbox 与 done 历史。
最小修复：DoneInboxItems 两个查询（chat/thread）各加与 inbox 相同的
`done_through >= COALESCE(channel latest,0)` 保留条件。

### A9（P2·错误优先级）posting 的 archived(409) 先于 membership(403)
`channel/conversation.go:100-106`：`posting=true` 分支先查
`channel.ArchivedAt != nil || root.ArchivedAt != nil`（409）再 `canPostRoot`（403）。
原 TS 顺序：`canUserPostToChannel`（403 "You must join this channel to send messages"，
messages.ts:1702-1705）→ `assertChannelNotArchived`（409，1706 起）。未加入的
archived 频道：原 403，Go 409。合同要求"特殊错误优先级按原 handler fixture 保留"。
最小修复：conversation.go 内交换两块判定；或 posting 路径先问 membership 再查 archived。

### A10（P2·事件缺口）`scope_read:updated` 共享回执事件未入 publication
原 read 路由在 read_state 之外还 `emitScopeReadUpdated`（channels.ts:3807-3815，
受权限约束的共享阅读回执投影；合同 §6 列名）。Go `readstate.go`
（enqueueReadStatePublicationTx）只 enqueue `read_state:updated` + `unread_summary:changed`
（grep scope_read 全包零命中）。若父层 publisher 不从 read_state 派生，Web 端
readReceiptDomain 的 `scope_read:updated` 消费方断流。
最小修复：MarkRead 成功路径补 scope_read intent（或父层在 publisher 明确派生并在
集成记录写明）。

### A11（P2·越权推进）inbox read-all 的 thread 分支不校验父链当前读取权
`readstate.go:424-438`：MarkInboxReadLatest 的 UNION thread 分支只 JOIN
`thread_follows(unfollowed_at IS NULL) + t.deleted_at IS NULL`，不查父频道可读性
（对比同包 `loadThreadCandidates` 的完整父链条件：pc 未删未归档、hidden-#all 排除、
private/DM 成员）。follow 后失去私有父链权限的线程仍被批量标读并计入响应 scopes，
违反"当前授权集合"（合同 §4.1）。
最小修复：该 UNION 分支补与 loadThreadControls 相同的父链 JOIN/EXISTS。

### A12（P2·摘要不一致）UnreadSummary 的 mention 事实绕过 Done 抑制
`unread.go:65-100`：`UnreadSummary` 的 mention 聚合只按 read cursor 过滤，不查
done/suppression（同函数上方的 count 与 activityUnread 都有 done 排除，unread.go:185-193,
368-376）→ Done 到最新的频道 `unreadCount=0` 但 `hasMention=true`。
最小修复：mention 查询并入相同 NOT EXISTS（done_through >= latest）与
user_mention_suppressions 边界。

---

## B. 已修复 / 已撤销（供 workers 关闭工单）

| v1 编号 | 现状 |
|---|---|
| reaction hash 版本（父层发现） | **已修**：持久计数表 + 原子 bump + DB 错误传播（reaction.go:382-452）；0010 表已启用 |
| v1-A4 mentionOnly 被 Mentions filter 丢弃 | **已修**：inbox_page.go:170,266 `AnyMention: true` |
| v1-A7 channel-scoped sync follow 过滤 | **撤销**：phase-4-messaging §6.2 明文批准的 Go 决定（HTTP sync 含指定 channel 与 resume 共用订阅过滤）；m4-compatibility-contract §1 同义。保持现状，勿改 |
| v1/v2-A1 MarkUnread seq 差值 | **撤销（v2.1）**：原 TS markUnread 即 `Math.max(boundary - maxReadSeq, 0)`，Go 与原实现一致；in-process Go 采集实测一致（见 §G） |

## C. 需执行式 fixture 裁决（不要按本报告直接改，先冻结原输出）

1. HTTP message 面 key 集：Go DTO 携带 `agentSendKey/searchText`（恒 null）与
   `senderHandle`；原 TS HTTP enriched 走 drizzle `.select()` 全列（storage 键带**真值**
   上 HTTP 面；sealed 约束经 projectRichMessageSocketPayload 只作用于 socket 面，
   messages.api.test.ts:3255-3257 的 must-not-leak 断言即 socket 事件）。Go 恒 null
   与原"真值"不同、与 manifest canonical 20 键也不同。以 P0 handler 执行式 fixture
   钉死 HTTP history/sync/send 响应 key 集后统一（m4-reference `message.dto` 已区分
   socket 面与 httpCreate 面）。
2. send 响应是否带 conversationContext（manifest presence=messageNew 指 broadcast 面）。
3. Done 省略 through + 空目标（done.go validateDoneFrontier 无消息→400 REQUIRED）的
   原错误映射。
4. unread 计数是否排除 message_type='system'（Go COUNT 未过滤）。
5. notification-settings 有行时是否输出 activityMuteSupported（原无行默认含 false，
   有行路径不含；Go 恒输出）。
6. sidebar unread 对 announcement/未加入公共频道的计入集合。

## D. 小项（顺手修）

1. `tombstoneReasonsTx`（activity.go:795-849）以 `done_at IS NOT NULL` 判 reason=done，
   不比对 frontier：因 read 推进而离开 unread 窗口的行可能被错标 "done"（应 outOfWindow）。
2. `defaultEnqueue` 用 `time.Now()` 而非 `s.now()`（store.go）——测试时钟旁路。
3. `ResumePage`/`SyncMessages` 的 DTO 投影开第二个快照（sync.go ProjectSnapshot、
   m4_message_read_handlers projectFromSnapshot）——行集与聚合可能撕裂。
4. 0011 `user_channel_mute_states.activity_muted DEFAULT 1` 与原默认（未静音）相反；
   现有 INSERT 均显式赋值未触发，建议改 DEFAULT 0 防将来误用。

## E. 已核对一致（供父层放心，节选）

coverage 边界与冻结契约逐场景一致（含空频道 latest 空页 complete=true、before 空页
coveredAfter=high）；Activity uint64/epoch/洞检测/notModified/retention/epoch 滚动、
**activityVersion=watermark 与原 activitySyncService.ts:876,901,918,979 一致**；
snapshot 窗口行序与原 reducer 比较器一致；thread follow 三种自动语义（replied 激活、
authored 非激活、mention 无条件激活，与原 planDirectMentionThreadFollow 一致）；
DM 双写 channel_humans+direct_messages、agent-DM 501 顺序、hidden-directory 404、
self-DM；posting 的 announcement/隐式成员规则（原 hasImplicitServerMembership→
isServerHumanMember）；read/unread/read-all 与 Done 的 412/400/409 矩阵与 residue
receipt 字段；inbox 非法 filter 静默归 all（与原一致）；#632 readState union
（string maxReadSeq + number version + latestActivity）；randomId 幂等域与跨空间 409；
UTF-16 计量（utf16Length/jsTrim ECMA 集）；guest gate 冻结关闭为声明过的决定。

## F. 配套 verifier（本审查同步更新，见 server-go/docs/m4-reference-report.md）

m4-reference 新增三个可执行拒收面：`reaction.viewerVersion.stream`（数值版本序不变量，
恰好回归验证本次 reaction 修复）、`read.state.stream`（执行原 ledger 裁定含晚到重复写的
多事件流）、`activity.stream.digest`（冻结"快照→新消息→已读→Done→差量"流对 digest）。

## G. in-process Go 真实 wire 采集（v2.1 新增，执行式证据）

`go_wire_export_test.go`（owned reference area）在 t.TempDir() 的隔离迁移库上驱动
**真实公共 API**（message.Create/AddReaction/RemoveReaction/ViewerSnapshot/
ListReactionActors、readstate.MarkRead/MarkUnread/MarkReadLatest/DoneChannel/
ActivitySnapshot/ActivityDifference/UnreadCounts/UnreadSummary），stdout 导出单文档，
`node run.mjs --go-wire` 采集并用**原始 TS 执行**验证。当前全部通过（证据
`server-go/contracts/m4/go-wire-samples.json`）：

- reaction viewer 版本流（真实 add/remove/add/幂等/双用户）：v1→v5 严格递增、幂等不 bump ——
  **message worker 的持久计数修复被真实执行回归验证**；
- discussion 版本非回退；
- read-state 变更流（(maxReadSeq,readStateVersion) 序列）被原始 ledger 全数接受，
  最终 frontier 一致（同证据顺带佐证 A1 撤销：unread=1 与原差值语义一致）；
- 全部 5 个真实 Activity body（snapshot/差异/notModified/含 Done tombstone 的快照）
  通过**生成的 Activity JSON Schema**（ajv）；
- 真实 Go difference 的 rows/tombstones 经原始 runner 同款 ingestDifference 全部进入
  原始 reducer state，rowVersion 不被 fold 改写。

边界：store 层公共 API + handler 同形状序列化；legacyweb JSON 编码路径与真 HTTP 由父层
单独执行（`accessClaimsContextKey` 未导出，外部包无法注入 httptest claims——如父层愿意
导出一个测试注入 seam，可再提升一层覆盖）。真实 Go HTTP parity 仍由父层裁定。
