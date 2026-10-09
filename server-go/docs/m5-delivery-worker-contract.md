# M5 Delivery Worker 契约（Worker A）

- 日期：2026-10-09（America/Los_Angeles）
- 责任人：A / delivery worker。所有权：`internal/delivery/**`、`internal/platform/db/migrations/0014_delivery.sql`、本文档。
- 状态：**契约已冻结，实现随本轮交付**。本文先发布 schema 与导出 Go API，B（messaging）/ C（lifecycle）/ 父执行者据此集成。
- 输入：[M5 执行锁](m5-execution-lock.md)、[深化设计](phase-5-delivery.md)、[协议证据](m5-protocol-evidence.md)、[实施协调](m5-implementation-coordination.md)。

## 0. 诚实边界（先读）

1. ACK / `daemon_drained` 是 **Daemon 报告的回执**，不是模型消费保证。原 Daemon 的 starting-buffer 分支（`agentProcessManager.ts:4361–4388`）会在启动缓冲后即 ACK；start 失败后已 ACK occurrence 不重报。本模块持久化的是"回执事实"，不是 `model_seen` / `task_completed`。
2. 本模块不承诺 exactly-once 运行时副作用。ACK 后的 daemon crash、丢 ACK 前的副作用窗口按 [深化设计 §7.3](phase-5-delivery.md) 如实保留。
3. `Store` 只拥有持久事实：不启动线程、不做网络 I/O、不持有任何跨事务内存状态。派送发送、连接准入、HTTP/WS 呈现由 machinews / machinecontrol / agentapi（他人所有权）完成。
4. 逻辑意图（`agent_deliveries`）与协议 occurrence（`agent_delivery_attempts`）分离。同一 machine/launch/session 的重发复用同一 `occurrence_id`；身份漂移时旧 attempt 终结、新 occurrence 生成，旧快照**绝不原地改写**。
5. `drained_reported_at` 的命名即承诺：它是 Daemon 报告的 drained 观察时间，不解读为模型消费。

## 1. 迁移 0014（已冻结）

迁移文件 `internal/platform/db/migrations/0014_delivery.sql`，纯增量：只建新表/新索引，不 INSERT 任何行，不改 0001–0013。时间戳均为 INTEGER unix 毫秒。**其中 `message_agent_mentions` 由 message（B）写，`agent_direct_messages` 由 channel/B 写，`agent_launches` 由 agent（C）写；delivery Store 只写 `agent_deliveries` / `agent_delivery_attempts` / `agent_delivery_claims`。**

完整 SQL 与迁移文件逐字一致（以迁移文件为准；本文不重复粘贴全文，结构摘录如下）：

| 表 | 写入方 | 要点 |
|---|---|---|
| `message_agent_mentions` | message/B | PK `(message_id, agent_id)`；复合 FK message/agent+workspace；`handle_at_send` |
| `agent_deliveries` | delivery/A | 唯一 `(workspace_id, source_kind, source_id, agent_id)`；`scheduling_state` 7 态 CHECK；`delivery_order` 全局唯一递增；`retry_count`/`next_attempt_at`/`lease_expires_at`/`revision` |
| `agent_delivery_claims` | delivery/A | 唯一 `(workspace_id, agent_id, claim_digest)`；只存 SHA-256 摘要；`lease_expires_at`/`acked_at`/`removed_count` |
| `agent_delivery_attempts` | delivery/A | `occurrence_id` PK；`(delivery_id, attempt_number)` 唯一；身份快照列（managed 非空 / external 全空）条件 CHECK；`received_at`/`pending_at`/`drained_reported_at`/`acked_at`；状态 `in_flight/terminal` + `terminal_code` 闭集 CHECK |
| `agent_launches` | agent/C | 唯一 `(workspace_id, agent_id, start_dispatch_id)`；state `reserved/dispatched/acked/superseded/failed/cancelled`；`queue_state queued/starting/running/rebound`；复合 FK agent/machine+workspace |
| `agent_direct_messages` | channel/B | PK `(workspace_id, user_id, agent_id)`；`channel_id UNIQUE`；复合 FK channels/agents；`user_id <> agent_id` |

另建辅助唯一索引 `idx_agents_id_workspace`、`idx_machines_id_workspace`（新复合外键的父键要求；`id` 本身是 PK，故恒可建）。到期扫描索引：`idx_agent_deliveries_due`（partial，pending/waiting 态）、`idx_agent_deliveries_lease_expired`（partial，leased 态）、per-agent 顺序/状态索引、attempt 的 open/agent 索引、claim 的 open 索引。

### B/C 需要的列如有变更

按执行锁：B/C 的表需求由 A 冻结最终 schema。上表是当前定稿。如需追加列，请通过本文档"变更请求"小节登记，由 A 统一修改迁移；不要自行 ALTER。

## 2. 导出 Go API（`internal/delivery`，已冻结）

包只依赖 `platform/db`、`platform/clock` 与标准库——**不 import agent/channel/message**。跨模块 live 事实（Agent 绑定、频道授权、凭据有效性）一律通过注入的类型化回调在**同一事务内**解析；不接收裸 principal 字符串作授权依据。

### 2.1 Store 与事务语义

```go
func NewStore(handle *sql.DB) *Store            // 锁定构造（执行锁 §2）
func NewStoreWithOptions(handle *sql.DB, opts Options) *Store
type Options struct{ Clock clock.Clock }        // 注入后冻结，无事后 setter

func (s *Store) DB() *sql.DB                    // 锁定接口（执行锁 §2）
```

- Store 自身的多语句操作各自包一个 `platformdb.WithWriteTx`（IMMEDIATE + authority fence）；事务内无网络 I/O、无嵌套顶层事务。
- `PlanMessageTx` 等以 `Tx` 结尾的方法是**事务内步骤**，由调用方（B 的完整 send 用例）在它自己的 `WithWriteTx` 里调用。

### 2.2 计划（B 在 send 事务内调用）

```go
type PlanInput struct {
    WorkspaceID string
    MessageID   string
    ChannelID   string
    AgentIDs    []string
}
func (s *Store) PlanMessageTx(ctx context.Context, tx *sql.Tx, input PlanInput) error
```

- 对 `(message, agent)` 幂等（唯一键 `workspace+source_kind+source_id+agent`）；重复行跳过、不报错。
- 校验 message 属于该 workspace/channel；agent 存在、未删除且属该 workspace（事实读，不是授权——授权由 B 在调用前完成）。
- 一次调用为每个（去重后的）agent 创建一条 `pending` 意图；`delivery_order` 在事务内 `MAX+1` 分配。
- 任何一条写失败 → 返回错误 → B 的整笔事务回滚（无消息孤儿/幽灵收件）。
- sender replay 不调用本方法（B 保证）。

```go
type BriefingPlanInput struct {
    WorkspaceID    string
    AgentID        string
    MemberID       string   // 人类成员
    Purpose        string   // 如 "onboarding"
    Version        string   // briefing 契约版本
    ConversationID string   // 交接会话（DM 建立后传入；'' 允许）
}
func (s *Store) PlanBriefingTx(ctx context.Context, tx *sql.Tx, input BriefingPlanInput) error
```

- 幂等键 `source_id = "briefing:{MemberID}:{Purpose}:{Version}"`；重复点击/激活/重连归一到同一意图。

### 2.3 调度事实回调（组合根注入）

```go
type DispatchFacts struct {
    SupportsManagedWire bool   // external runtime 的 Agent 为 false（只能 claim）
    Reachable           bool   // 当前机器连接可达
    MachineID           string // Agent 当前绑定机器（live 事实）
    LaunchID            string // 当前持久 launch（空 = 未形成）
    SessionID           string // 当前 session（空 = 未形成）
    Stopped            bool   // 用户明确停止：等待，不烧预算，不强唤醒
}

type AgentFactsFn func(ctx context.Context, ex Executor, workspaceID, agentID string) (DispatchFacts, error)

type DeliveryAuthorizationFn func(ctx context.Context, ex Executor, d Delivery) (authorized bool, reason string, err error)

type DispatchDeps struct {
    Facts     AgentFactsFn             // 必填
    Authorize DeliveryAuthorizationFn  // 必填：重投/领取前重验当前授权
}
```

`Executor` 即 `platformdb.Executor`。回调在写事务内运行：只做短 SQL，不做网络 I/O。`Authorize` 返回 `false` 时以 `reason`（短稳定码，如 `agent_deleted`、`membership_removed`）取消未派送意图；已 acknowledged 的记录永不回退。

### 2.4 托管派送（C / machinecontrol 周期与 wake 触发）

```go
type PrepareInput struct {
    Now         time.Time    // 零值 = Store 时钟
    MaxPerAgent int          // 默认 1：单 Agent 同时最多一个待确认 managed attempt
    MaxTotal    int          // 默认 64：本轮扫描上限
}
type DispatchPlan struct {
    Delivery   Delivery
    Attempt    Attempt   // 含 occurrence 与完整身份快照
    MessageSeq int64     // messages.seq —— wire seq 用它，不是 delivery_order
}
func (s *Store) PrepareManagedDispatches(ctx context.Context, deps DispatchDeps, input PrepareInput) ([]DispatchPlan, error)
```

一次 `WithWriteTx` 内，按 `delivery_order` 扫描到期意图并产出**已租约**的派送计划：

| 情形 | 结果 |
|---|---|
| `Authorize` 拒绝 | 意图 `cancelled`（reason 记录在 `last_error_code`），open attempt 终结 `CANCELLED` |
| `Stopped` / 机器不可达 | `waiting_machine`（`agent_stopped` / `machine_offline`），**不消耗预算** |
| launch/session 未形成 | `waiting_identity`（`identity_incomplete`），不消耗预算 |
| 不支持 managed wire（external） | 保持 `pending`（claim 路径专属），扫描间隔顺延 |
| 同一身份已有 open attempt | **复用同一 occurrence**（Daemon 去重），预算 +1，续租 |
| 身份漂移（无接收证据） | 旧 attempt 终结 `SUPERSEDED`；新 attempt_number + 新 occurrence；预算 +1 |
| 身份漂移（旧 attempt 已有 received/pending/drained 观察） | **不确定结局**：`blocked`（`uncertain_delivery`），不隐式重投；旧 attempt 保持 open，真实五元 ACK 可解除不确定并确认 |
| 预算耗尽（`retry_count >= 24`） | `blocked`（`RETRY_EXHAUSTED`），attempt 终结，需显式重投 |
| 该 Agent 已有其他待确认 attempt | 本轮跳过（公平性，不改状态） |

发送本身在**事务提交后**由 machinews 经 current-connection admission 完成；其结果回写：

```go
type SendOutcome struct {
    OccurrenceID string
    Accepted     bool
    ErrorCode    string // !Accepted 时必填（短码）
    Recoverable  bool
}
func (s *Store) RecordManagedSendResult(ctx context.Context, outcome SendOutcome) error
```

- `Accepted` → 只补 `dispatched_at` 观察（CAS：`acked_at IS NULL` 才写；ACK 可能早于 Send 返回）。
- `!Accepted && Recoverable` → 意图回 `pending`，`next_attempt_at = now + BackoffFor(retry_count)`；occurrence 保留复用。
- `!Accepted && !Recoverable` → 意图 `cancelled`，attempt 终结 `SEND_FAILED`。

### 2.5 回执（machinews → machinecontrol → 本 Store）

```go
type MachinePrincipal struct { // 已认证机器面身份（auth 来源；payload 只是证据）
    ComputerID, MachineID, WorkspaceID string
}
type MentionSnapshot struct {  // 原 wire 五元快照（payload 证据）
    OccurrenceID, MessageID, MachineID, LaunchID, SessionID string
}

type TransitionInput struct {
    Principal MachinePrincipal
    AgentID   string
    Stage     string // TransitionReceived | TransitionPending | TransitionDrained
    Snapshot  MentionSnapshot
}
func (s *Store) RecordTransition(ctx context.Context, input TransitionInput) (TransitionResult, error)

type AckInput struct {
    Principal MachinePrincipal
    AgentID   string
    Seq       int64  // wire seq == messages.seq
    Snapshot  *MentionSnapshot // nil = legacy ACK（缺 deliveryId/mentionDelivery）
}
type AckResult struct {
    DeliveryID, OccurrenceID string
    AlreadyAcknowledged      bool
}
func (s *Store) AcknowledgeManaged(ctx context.Context, input AckInput) (AckResult, error)

type ControlAckInput struct { // seq 0 control notice; NOT a tracked five-tuple
    Principal    MachinePrincipal
    AgentID      string
    OccurrenceID string // exact attempt occurrence; deliveryId on the wire
    LaunchID     string // CURRENT persisted launch (caller-supplied; not a wire field)
    SessionID    string // CURRENT persisted session (caller-supplied; not a wire field)
}
func (s *Store) AcknowledgeControl(ctx context.Context, input ControlAckInput) (AckResult, error)

type TerminalErrorInput struct {
    Principal MachinePrincipal
    AgentID   string
    Code      string // 六种 wire 错误码之一
    Snapshot  MentionSnapshot
}
func (s *Store) RecordTerminalError(ctx context.Context, input TerminalErrorInput) (TerminalErrorResult, error)
```

ACK 准入（单短事务，全部通过才落库，否则**零状态变化**并返回类型化错误）：

1. `Principal.MachineID == Snapshot.MachineID == attempt.machine_id_snapshot`（认证来源与一致性双重核对）；workspace/agent/launch/session/message/seq/deliveryId 全等。`Seq <= 0` 直接拒绝（`ErrIdentityMismatch`）：正 seq tracked 五元不把 0 当水位。
2. legacy ACK（`Snapshot == nil`）对 tracked attempt 一律拒绝 `ErrLegacyAckAmbiguous`——不用 `max(seq)` 猜测。
3. 重复合法 ACK 幂等：不加 retry、不刷新首次确认时间、不重复发布。
4. 迟到 ACK 落在已终结 attempt（`SUPERSEDED`/漂移关闭/`CANCELLED`）上：仅记录 `acked_at` 审计，不确认新 attempt、不复活已取消意图。
5. receipt 不能把已终态意图复活；`acknowledged`/`cancelled` 不被 transition 覆盖。
6. `source_kind=briefing` / `message_id IS NULL` 的控制 attempt **不能**走 `AcknowledgeManaged`（`ErrControlPathMismatch`，零写入）。

### 2.5.1 控制 notice ACK（`AcknowledgeControl`）

给 G / machinecontrol 的 seq 0 briefing 路径。与 `AcknowledgeManaged` 不混用。一次 `WithWriteTx`，任一拒绝零写入：

| 条件 | 结果 |
|---|---|
| `source_kind=briefing` 且 delivery/attempt 的 `message_id` 都为 NULL，`transport_kind=managed_wire` | 才可能确认 |
| 已认证 `Principal.MachineID` == attempt 机器快照；workspace 与 `AgentID` 全等 | 机器/空间/Agent 闭合。payload 没有机器字段，不能当认证来源 |
| `LaunchID`/`SessionID` 等于 attempt 上不可变的 launch/session 快照 | 调用方必须传入**当前**持久 launch 与 `agents.session_id`（`agent.Service.CurrentControlIdentity`）。旧 launch/session 拒绝 |
| 当前连接 | store 不保存 connection generation。调用方只在 machinews 已准入的当前连接上把 principal 传进来（退役连接到不了这里） |
| 同一当前身份的重复 ACK | `AlreadyAcknowledged=true`，不刷新 `acknowledged_at`，不增加 retry |
| 已 `SUPERSEDED`/取消/其他终态、外机、外 Agent、未知 occurrence、tracked 消息 attempt | 零写入。控制路径**不**给旧 attempt 补 `acked_at` 审计 |
| 其他 intent | 不更新。seq 0 只绑定这一个 occurrence，不是清队列水位 |

确认后的 `scheduling_state=acknowledged` 与 `terminal_code=ACKED` 是 **reported receipt**。本方法不写 `received_at`/`pending_at`/`drained_reported_at`，也不存在 model-consumed 列。ACK 早于 `RecordManagedSendResult` 时，后到的 accepted/可恢复失败观察不能把意图打回 pending，也不能补写已确认 attempt 的 `dispatched_at`。

transition 三阶段只做**首次观察**落盘（重复/乱序幂等，时间戳只允许 NULL→值，绝不倒退、绝不在 ACK 时伪造未观察的时间戳）。

terminal_error 分类（generation 匹配：machine+launch+session 全等才作用）：

| Code | 处理 |
|---|---|
| `IDENTITY_UNKNOWN` / `IDENTITY_DRIFT` / `INSTRUMENT_FAILED` | 可恢复：attempt 终结该码，意图回 `pending` + 退避（不永久终结待唤醒消息） |
| `QUOTA_LIMITED` / `UNSUPPORTED_DELIVERY_PATH` | `blocked`（诊断明确，可显式重投） |
| `DELIVERY_REJECTED` | `cancelled`（明确拒绝） |

### 2.6 外部 runner claim/ack 与 legacy drain（agentapi / 父执行者接线）

```go
type AgentPrincipal struct { AgentID, WorkspaceID, CredentialID string }
type AgentPrincipalValidator func(ctx context.Context, ex Executor, p AgentPrincipal) error

type ClaimInput struct {
    Principal AgentPrincipal
    Limit     int           // 默认 50，上限 500
    LeaseTTL  time.Duration // 默认 DefaultClaimLeaseTTL = 10m
    SinceSeq  *int64        // nil = latest；非 nil 只选择 messages.seq > *SinceSeq
}
type ClaimReceipt struct { Seqs []int64; MessageIDs []string } // 原 claim token 形状
type ClaimedEvent struct {
    DeliveryID, MessageID, ConversationID, SourceKind string
    Seq, CreatedAt int64
}
type ClaimResult struct {
    ClaimID string
    Claim   ClaimReceipt
    Events  []ClaimedEvent
    LeaseExpiresAt int64
    Reissued bool // 未过期 open claim 的可见页被原样重领（不二次计预算、不延长租约）
}
func (s *Store) ClaimAgentEvents(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, input ClaimInput) (*ClaimResult, error)

type ClaimAckInput struct { Principal AgentPrincipal; Claim ClaimReceipt }
type ClaimAckResult struct { RemovedCount int64 }
func (s *Store) AckAgentClaim(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, input ClaimAckInput) (*ClaimAckResult, error)

// DrainLegacyEvents 保持原签名：SinceSeq=nil（latest）。
func (s *Store) DrainLegacyEvents(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, principal AgentPrincipal, limit int) ([]ClaimedEvent, int64, error)

// LegacyDrainQuery 是显式 since/limit 变体。SinceSeq 语义与 ClaimInput.SinceSeq 相同。
type LegacyDrainQuery struct {
    Principal AgentPrincipal
    Limit     int
    SinceSeq  *int64
}
func (s *Store) DrainLegacyEventsQuery(ctx context.Context, deps DispatchDeps, validate AgentPrincipalValidator, query LegacyDrainQuery) ([]ClaimedEvent, int64, error)
```

`ErrClaimInconsistent`：提交的 `message_ids` 里有本 workspace 的 `messages.id`，但其正 `seq` 不在 `seqs` 中。整笔 ACK 失败关闭，零写入。

- claim 领取范围：**该 Agent 的 `SupportsManagedWire=false`（external）意图**。托管 Agent 的 tracked mention 走 wire；其强恢复路径是租约到期重发，不与 claim 混流（如需变更走本文档变更请求）。
- `SinceSeq == nil` 是原 `"latest"`：当前到期队列，不形成水位。非 nil 时，**在同一写事务内、租约与自动 ACK 之前**只保留 `messages.seq > *SinceSeq`。无正 seq 的 notice（briefing）在 since 条件下不进入本批，也不被确认。被跳过的低 seq 保持原状态（pending 或已租约），不能被本次 drain 静默确认。过滤下推到选择 SQL，低 seq 不占用 limit，因此不会把更高 seq 饿死。`limit` 截断的尾部同样不在本次 receipt 里，也不会被确认。负 since 返回 `ErrInvalidInput`，零写入。
- 回执形状跟原 `internalAgentApi.ts`：正 seq 消息只进 `seqs`，`message_ids` 为空。非消息 briefing：`seqs` **不含 0**，`message_ids = [delivery ID]`。该 ID 是稳定 notice id（与 onboarding `Briefing.NoticeID` 相同），**不插入 messages 行**。`ClaimedEvent.SourceKind` 保留为 `briefing`；`MessageID` 为空；`Seq` 为 0 且不进入 ack seqs。G 见到 `SourceKind==briefing` 时用 `DeliveryID` 调 `BriefingTx`。
- 内部 `claim_digest` 仍是已发放批次的 SHA-256 收据，绑定 (workspace, agent)。它**不是**客户端必须回传的秘密，ACK **不要求**整批 digest 相等。
- `AckAgentClaim` 确认的是**当前认证主体、未过期 external_claim 租约**与提交 `seqs` / notice id 的交集。不是 `max(seq)` 水位：较大 seq 不确认较小 seq，`seq<=0` 不确认任何 notice。外国 id、从未领取、租约已过期、重复 id 的贡献都是 0；整批没有交集时 `RemovedCount=0` 且零写入。`ErrClaimUnknown` / `ErrClaimExpired` 仍导出（已有调用方的 `errors.Is` 保持可编译），这条路径不再用它们拒绝外国或过期批。
- seq 与 message id 交叉一致，失败关闭：`message_ids` 中的本空间消息必须带上它自己的正 seq，否则 `ErrClaimInconsistent`，回滚，零写入。正 seq 消息不能只靠 `message_id` 被确认。同一消息的 seq 与 id 同时出现只计一次。notice id 不是 message 行，不触发该错误。
- 部分 ACK 留下的未点名行保持 leased、可再领。`agent_delivery_claims.acked_at` 只在该 claim 已无 in-flight attempt 时写入。行上 `removed_count` 是该 claim 累计 `ACKED` 的 attempt 数；本次响应的 `RemovedCount` 只计本次新确认。重领对剩余行重跑 `Authorize`，不延长租约，不二次计预算。`Authorize` 错误整笔回滚，不变成空成功。
- 交集内当前阅读权失败：取消该意图，不计入 `removed_count`，不确认。已经 `cancelled` 或 attempt 已是 `SUPERSEDED` 的行不会被改成 `ACKED`，也不会把已取消意图复活。
- **租约世代边界（不造强 token）**：wire 只有 seqs/message_ids/third_party ids，没有 claim id、lease generation 或签名。同一 Agent 对同一消息在租约续期之后的迟到 ACK 会确认**当前** leased 行。不能从原协议区分世代，不声称 fencing 或 exactly-once。
- 若 open claim 的可见页为空（since 把已租约低 seq 全部滤掉），这些行保持 leased 且不确认；同一 claim 上继续领取通过 since 的更新行（`Reissued=false`，因为新行计了预算）。之后不带 since 的领取会重领仍租约的低 seq。可见页非空时只返回该页，不把未返回的行放进 receipt。
- 历史已合法 ACK 的重复提交返回 `removed_count: 0`，不改 revision，不刷新 `acknowledged_at`。
- `DrainLegacyEvents` 签名不变，等价于 `SinceSeq=nil`。`DrainLegacyEventsQuery` 是带 since 的显式变体。两者都在**同一事务**里领取并只自动确认**本次返回的 receipt**。HTTP 响应丢失窗口仍是兼容语义，不是强恢复。
- `third_party_event_ids` 不属于 delivery 意图；由 agentapi 自行处理，本 Store 不涉及。

### 2.7 恢复、取消与重投

```go
type RecoveredLeases struct { Managed, Claims int64 }
func (s *Store) RecoverExpiredLeases(ctx context.Context, now time.Time) (RecoveredLeases, error)

type CancelInput struct {
    WorkspaceID    string
    AgentID        string // 可选过滤
    ConversationID string // 可选过滤
    MessageID      string // 可选过滤
    DeliveryID     string // 可选精确目标
    Reason         string // 必填短码
}
func (s *Store) CancelDeliveries(ctx context.Context, input CancelInput) (int64, error)

func (s *Store) RequeueBlocked(ctx context.Context, workspaceID, deliveryID, reason string) (bool, error)
```

- `RecoverExpiredLeases`：启动/周期调用。过期 managed 租约 → 意图回 `pending`（occurrence 保留，同身份重发复用）；过期 claim → 意图回 `pending`。不假造机器在线、不重置预算。
- `CancelDeliveries`：撤权/删 Agent/频道移除后由应用层调用。`acknowledged` 永不动；`cancelled` 幂等。open attempt 终结 `CANCELLED`。已交付字节不回收（尽力清理走原 `agent:inbox:purge`，不是撤回保证）。
- `RequeueBlocked`：**显式**人工重投（`blocked` → `pending`，预算清零并记录 reason）。进程重启/重连/扫描**永不**重置预算——只有这个入口会。

### 2.8 诊断查询

```go
func (s *Store) GetDelivery(ctx context.Context, deliveryID string) (*Delivery, error)
func (s *Store) ListMessageDeliveries(ctx context.Context, workspaceID, messageID string) ([]Delivery, error)
func (s *Store) AttemptByOccurrence(ctx context.Context, occurrenceID string) (*Attempt, error)
type QueueStats struct {
    PerState         map[string]int64
    InFlightAttempts int64
    OldestDueAgeMs   int64
    OpenClaims       int64
}
func (s *Store) QueueStats(ctx context.Context, workspaceID string) (*QueueStats, error)
```

不暴露正文/token/跨空间 backlog。管理员入口由 HTTP 层做精确身份授权后调用。

## 3. 重试策略（与原 TS 对齐）

```go
const (
    RetryBaseBackoff      = 5 * time.Second
    RetryBackoffCap       = 5 * time.Minute
    RetryBudget           = 24
    DefaultClaimLeaseTTL  = 10 * time.Minute
    WaitingRecheckBackoff = 5 * time.Second
)
func BackoffFor(attempts int64) time.Duration   // 5s,10s,20s…封顶 5m
func LeaseTTLFor(attempts int64) time.Duration  // managed ACK 等待窗 = BackoffFor
func BudgetExhausted(retryCount int64) bool
```

- 预算按**实际派送准备次数**计（managed resend / 新 claim 发放），持久化在 `agent_deliveries.retry_count`；等待态（waiting_*）与扫描不消耗。
- 抖动：实际调度用的退避在 `BackoffFor` 基础上加确定性抖动（`SHA-256(deliveryID|retry_count) % 25%`），重启稳定、可测试。

## 4. 锁序与并发

- 本模块所有写都在 `platformdb.WithWriteTx` 的短事务内，事务内零网络 I/O——不产生"持 DB/fence 等 slot"的路径；发送在提交后进入 machinews 的 current-connection admission（持 slot 不落 DB 的方向由 machinews 保证，非本模块职责）。
- 所有意图/attempt 更新都是 `WHERE id=? AND revision=?` 的 CAS；影响行数为 0 → `ErrConcurrentModification`，绝不盲目重试覆盖。
- 同一 occurrence 的并发 ACK/transition/terminal_error 全部经 revision CAS 串行化；迟到帧最多补审计时间戳，不覆盖终态。

## 5. 变更请求

父执行者集成请求（请 A 实现时核对）；A 的处理状态以【A】标注：

1. 原 CLI 协议实读纠正见 `m5-claim-wire-correction.md`。原 ACK 三数组，不含秘密/世代 token；`AckAgentClaim` 的合法重复必须返回 removed_count=0（实际本次移除数），而非首次移除数。HTTP 集成测试已固定此语义。【A：已实现并测试（§2.6）】
2. Ack 时须重新验证会话阅读权，而不仅 credential：Claim 之后退出私有频道/Agent DM 失效，不能凭旧领取摘要确认新状态。建议 AckAgentClaim 同样接受 DispatchDeps.Authorize 或等价事务内验证。【A：已实现——`AckAgentClaim` 现接受 `DispatchDeps`，撤销意图取消且不计入 removed_count】
3. Prepare 身份漂移且旧 attempt 已 observed received/pending/drained、结果不确定时应 blocked/uncertain，不能自动创建新 occurrence 隐式重投；无接收证据才安全按设计新建 attempt。迟到旧回执不可确认新意图。【A：已实现——observed 漂移 → `blocked/uncertain_delivery`，旧 attempt 保持 open，真实五元 ACK 解除不确定；迟到旧回执只记审计】
4. FactsFn 在 WithWriteTx 内，禁止调用 Hub.Snapshot/IsOnline 等获取 machine slot 的方法，否则可能和 slot→DB/fence 回调反锁。以同事务持久 machine/Agent facts 作候选判断，最后实时准入在提交后检查。父执行者负责后者。【A：已在 §2.3/§4 冻结；C 的 `ManagedDispatchFactsTx` 确认遵守】
5. 父执行者 readstate 联合参与者投影使用已冻结 agent_direct_messages.user_id，此列请保持；human 字段不得换名。【A：保持不变】
6. Onboarding planner 会使用 PlanBriefingTx；请确保非消息源（message_id NULL）可持久并被诊断，但不伪造正 message seq。Briefing transport 不得误用需要真实 message.seq 的 tracked mention ACK。父已实现 application/onboarding + delivery/briefing_views.go（只新增独立文件），契约见 m5-onboarding-integration-contract.md；需要具体control ACK路径，seq0+deliveryId，无mentionDelivery。【A：已实现 `AcknowledgeControl`，见 §2.5.1。正 seq tracked 仍拒绝 seq 0。G 用 `CurrentControlIdentity` 填 LaunchID/SessionID。】
7. **刚实读 claim.go::claimTx：openClaimTx 命中后直接 projectClaimTx 返回，没有 deps.Authorize 重验，是撤权后重新领取的正文泄漏窗口。** 旧claim重新发放也必须逐条核对当前频道/Agent权限，非法项取消且不得投影或进入ACK批次；失败不能吞成空成功。【A：已实现。reissue 逐条 Authorize；非法项取消且不投影；摘要改为剩余批次；Authorize 错误回滚。】
8. 原 `/events?since=N&limit=M` 在**选择/领取/自动ACK之前**过滤 seq>N（internalAgentApi.ts:3337–3410），不能由G在Claim后丢显示条目。请 ClaimInput 加 SinceSeq *int64 并贯穿内部选择/reissue/legacy drain；否则容易ACK用户没看见的消息，或首批低seq永远阻塞更高seq。原latest只表示当前队列，不改变水位。【A：已实现。`ClaimInput.SinceSeq`；legacy 显式变体 `DrainLegacyEventsQuery(LegacyDrainQuery)`，`DrainLegacyEvents` 签名不变且 SinceSeq=nil。选择在事务内下推，跳过的行不确认。】
9. 原正seq事件的ACK只进seqs，message_ids仅无正seq事件（internalAgentApi.ts:3405+）。当前 claim.go 对briefing会把0放seqs，原CLI schema拒绝。控制意图应 message_ids=[逻辑noticeID]、seqs不含0；真消息 seqs有值、message_ids可空。任何筛选后的批次都必须只确认真正返回的条目；不得requires不透明额外字段。【A：已实现。正 seq 只进 seqs。briefing 的 message_ids 是 delivery ID（NoticeID），seqs 不含 0，不写 messages 行。`ClaimedEvent.SourceKind` 保留给 G 投影 `BriefingTx`。】
10. 原ACK语义允许确认已发放集合的子集（服务端对seqs/message_ids分别清理），并不要求整个batch digest完全相等。精确batch模型可作内部receipt，但不得因此拒绝合法已领取子集或令since/limit改变后永久卡住。优先逐项核对auth+已领取交集，重复removed_count0；同Agent跨租约晚ACK边界如实记录。【A：已实现。ACK 是未过期已领取交集，不是整批 digest，也不是 max seq 水位。外国/未领取/过期/重复 id 移除 0。seq 与 message id 不一致返回 `ErrClaimInconsistent` 且零写入。部分 ACK 后剩余行可重领。同 Agent 同消息跨租约迟到 ACK 仍确认当前 leased 行，不新增强 token。】

## 6. 实现状态

- [x] `0014_delivery.sql`（§1 描述逐字落地）
- [x] Store / Plan / Dispatch / Receipt / Claim / Recover / Query 全量实现（§2）
- [x] 单元测试：plan 原子性、调度状态机、occurrence 复用与漂移、ACK 幂等与越权零变化、claim 幂等/过期/子集/since/notice/竞态、恢复/取消/CAS、退避曲线
- [ ] machinews/agentapi/app 接线（父执行者所有权，不在本 worker 范围）
- [ ] 真实原 Daemon/CLI 闭环（S0/S7 验收，父执行者负责）
