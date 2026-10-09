# M5 Lifecycle Worker 契约（Worker C）

- 日期：2026-10-09（America/Los_Angeles）。责任人：C / lifecycle worker。
- 所有权：`internal/agent/**`（本切片新增文件）、`internal/application/machinecontrol/**`、`internal/transport/machinews/**`（本轮**零生产代码改动**，理由见 §6）、本文档与我新增的测试。
- 输入：[M5 执行锁](m5-execution-lock.md)、[深化设计](phase-5-delivery.md)、[协议证据](m5-protocol-evidence.md)、A 的 [delivery 契约](m5-delivery-worker-contract.md)与 `0014_delivery.sql`、B 的 [messaging 契约](m5-messaging-worker-contract.md)。
- 状态：**已实现并自测**（命令与结果见 §8）；machinews/agentapi/app 组线归父执行者（§7）。

## 1. 已交付导出 API（对 B / Agent API / 父执行者）

### 1.1 事务内 credential 重验（跨模块硬契约 #6，首个交付）

```go
// internal/agent/principal.go
type RevalidatedPrincipal struct {
    CredentialID string
    AgentID      string
    WorkspaceID  string
    Scopes       []string   // 当前 DB 行的 scopes（绝不是 lookup 快照）
    Agent        *Agent     // 存活 Agent 投影
    Role         *string    // agent_members.role（无成员行为 nil）
}
func (p *RevalidatedPrincipal) HasScope(capability string) bool

// 事务绑定形态：在调用方 platformdb.WithWriteTx 内执行（B 的 SendAgent 同一事务）。
func (s *Store) RevalidateCredentialTx(ctx context.Context, tx *sql.Tx,
    lookup CredentialLookup) (*RevalidatedPrincipal, error)

// 独立短事务形态（Agent API 读路径）。
func (s *Store) RevalidateCredential(ctx context.Context,
    lookup CredentialLookup) (*RevalidatedPrincipal, error)

// 通用 Executor 形态（写事务或读快照均可）+ capability 检查。见 §3 协调点。
type Executor = platformdb.Executor   // internal/agent
func (s *Store) ValidateAgentPrincipalTx(ctx context.Context, ex Executor,
    principal CredentialLookup, capability string) error
```

校验规则（顺序固定）：credential 行存在且未撤销 → 行仍绑定 `lookup.AgentID`（binding 漂移拒绝）→ Agent 存活、未删除 → workspace 存活 → workspace 一致 → scopes 取**当前行值**。错误映射：撤销 `ErrCredentialRevoked`(401 `credential_revoked`)；Agent/工作区消亡 `ErrAuthenticatedAgentGone`/`ErrAuthenticatedServerGone`(401)；绑定/跨空间伪造 (401 invalid)；capability 缺失 (403 `capability_not_authorized`)。**撤销后的 scopes 不再可用**：撤销即整体拒绝，没有" revoked scopes 仍授权"的状态；scopes 变更即时生效（不信任中间件快照）。

### 1.2 持久 launch / startDispatch（schema 来自 A 的 0014 §5）

```go
// internal/agent/launches.go —— 表 agent_launches（0014 已冻结，写入归本模块）
func NewLaunchStore(handle *sql.DB, clock clock.Clock) (*LaunchStore, error)
// 0014 未应用时构造失败（fail closed，不静默降级）。

type Launch struct { /* id/start_dispatch_id/workspace/agent/machine/state/
    queue_state/dispatch_count/last_dispatch_at/acked_at/terminal_code/
    revision/created_at/updated_at —— 与 0014 列一一对应 */ }

func (l *LaunchStore) ReserveStartLaunchTx(ctx, tx, workspaceID, agentID, machineID) (*Launch, error)
    // 每 Agent 单一未确认 start：并发预留（批量 mention）得到同一 launch/dispatch id。
    // 机器漂移：旧 launch 终结 superseded(machine_changed)，新建 launch。
func (l *LaunchStore) RecordStartDispatch(ctx, launchID) error
    // reserved→dispatched；同 dispatch 重发（恢复）dispatch_count+1；终态 CAS 拒绝复活。
func (l *LaunchStore) ApplyStartAckTx(ctx, tx, ws, agent, machine, dispatchID, launchID, queueState) (bool, error)
    // start:ack：machine/dispatch/launch 三重匹配才落库；queueState 只是 reported 事实。
func (l *LaunchStore) AcceptSessionFrameTx(ctx, tx, ws, agent, machine, launchID) (bool, error)
    // agent:session 的持久 fence：launchId 必须是当前活跃 launch 且机器匹配。
func (l *LaunchStore) TerminateAgentLaunchesTx(ctx, tx, ws, agent, exceptID, state, code) (int64, error)
func (l *LaunchStore) TerminateAgentLaunches(ctx, ws, agent, exceptID, state, code) (int64, error)
    // stop/reset → cancelled(stopped)；机器迁移 → superseded(machine_changed)。
func (l *LaunchStore) CurrentLaunch(ctx, ws, agentID) (*Launch, error)   // 当前身份查询
func (l *LaunchStore) ListUnconfirmedStartDispatches(ctx, machineID) ([]*Launch, error)
    // 恢复窗口：state IN (reserved, dispatched)。
```

**没有 session 列**（遵 A 的 0014）：session 事实留在 `agents.session_id`（M3 语义），tracked 投递身份 = (当前 launch, agents.session_id)，在派送时组合，不制造第二身份来源。

### 1.3 Service 生命周期入口（M5）

```go
// internal/agent/start_dispatch.go（ServiceOptions 新增 Launches *LaunchStore，构造期绑定）
func (s *Service) EnsureStartLaunch(ctx, a *Agent) (*Launch, error)
    // 短事务预留 → commit 后尽力派送 agent:start（带 launchId+startDispatchId）。
    // 机器离线：预留即持久唤醒意图，恢复路径补发。绝不在事务内等待 Daemon/模型。
func (s *Service) RecoverPendingStarts(ctx, machineID) error
    // OnReady/启动扫描入口：重发同一 dispatch 身份；跳过 stopped/移机/删除（终态关闭）。
func (s *Service) DispatchDelivery(ctx, machineID, command DeliveryCommand) error
    // 受控投递入口：经 gateway（machinews hub）的 current-connection admission。
func (s *Service) CurrentLaunchIdentity(ctx, workspaceID, agentID) (*Launch, error)
func (s *Service) ManagedDispatchFactsTx(ctx, ex Executor, workspaceID, agentID) (ManagedDispatchFacts, error)
    // A 的 DispatchDeps.Facts 事务内事实回调：SupportsManagedWire/Reachable/MachineID/
    // LaunchID/SessionID/Stopped，字段与 delivery.DispatchFacts 一一对应；
    // Reachable 取 machines.last_status 持久投影，绝不调用 Hub 方法（A 变更请求 #4）。
```

`Launches == nil`（0014 前构造）：M3 行为逐字节保持；M5 入口返回 `ErrLaunchPersistenceUnavailable`(501)，不伪造成功。

### 1.4 typed machine wire（协议帧冻结自 shared/index.ts:557–582,853–862）

```go
// internal/agent/delivery_command.go
type MentionDeliverySnapshot struct { /* occurrenceId/messageId/machineId/launchId/sessionId */ }
func (m MentionDeliverySnapshot) Complete() bool

type StartDispatchCommand struct { /* type:"agent:start" + config + launchId + startDispatchId
    + 可选 wake/resume 字段（wire 类型完整；生命周期构造器永不设置，见 §4） */ }
func NewStartDispatchCommand(a *Agent, serverURL string, machineName, machineDescription,
    machineHostname, machineOS, daemonVersion *string, launchID, startDispatchID string) StartDispatchCommand

type DeliveryCommand struct { /* type:"agent:deliver" + agentId + message(json.RawMessage 透传)
    + seq + deliveryId + transient + mentionDelivery */ }
func NewMentionDeliveryCommand(agentID string, message json.RawMessage, seq int64,
    snapshot MentionDeliverySnapshot) (DeliveryCommand, error)   // 五元不全/空正文/seq<=0 拒绝
func NewTransientDeliveryCommand(agentID string, message json.RawMessage, seq int64) (DeliveryCommand, error)
func NewControlDeliveryCommand(agentID string, message json.RawMessage, occurrenceID string) (DeliveryCommand, error)
```

`NewControlDeliveryCommand` 是 onboarding control notice（原 daemon `sendDeliveryAck`，core.ts 非 mention 的 accepted 分支）：`seq=0`、`transient=true`、`deliveryId` 等于 attempt occurrence、**无 mentionDelivery**。daemon 的 ack seq 是 `msg.seq > 0 ? msg.seq : msg.message.seq ?? 0`，所以 message JSON 里的正 `seq` 会被拒绝，避免 ack 掉出 seq 0 控制路径。这是 reported receipt，不是模型消费。

wire 约束：tracked `seq` 仍是消息的 `messages.seq`（delivery_order 永不进入 wire seq）；tracked `deliveryId === mentionDelivery.occurrenceId`；control `deliveryId` 是 occurrence 且没有 mentionDelivery；`message` 是 presenter 的 snake_case AgentMessage JSON 原样透传，本模块不重投影。**无发明帧**。正 seq tracked 五元仍然严格；seq 0 不是清队列水位。

### 1.5 回执解析与已认证派发（machinecontrol）

```go
// internal/agent/receipts.go
func ParseReceiptFrame(raw json.RawMessage) ReceiptSet
// closed-set 校验：transition 三 stage×两 outcome、terminal 六码、start:ack 四态；
// mentionDelivery 缺失/不完整 → ReceiptKindInvalid（消费+诊断，绝不作为事实转发）。

// internal/application/machinecontrol/receipts.go
type DeliveryReceiptSink interface { ApplyDeliverAck / ApplyDeliveryTransition /
    ApplyDeliveryTerminalError (ctx, computer.Principal, typed receipt) error }

func NewDeliveryReceiptAdapter(store deliveryStore, logger) *DeliveryReceiptAdapter
func NewDeliveryReceiptAdapterWithIdentity(store, logger, identity ControlIdentity) *DeliveryReceiptAdapter
// ControlIdentity = func(ctx, workspaceID, agentID) (launchID, sessionID string, err error)
// 直接适配 A 的 *delivery.Store（§2.5 / §2.5.1）：principal→MachinePrincipal。
// 正 seq + mentionDelivery → AcknowledgeManaged。seq 0 + deliveryId + 无
// mentionDelivery → AcknowledgeControl，LaunchID/SessionID 来自 ControlIdentity
//（接 agent.Service.CurrentControlIdentity），不从 payload 猜测。未接线 identity
// 的控制 ACK 拒绝且不落入 managed。seq 0 且无 deliveryId 在解析层就是非法帧，
// 不是水位。A 的 closed-set 拒绝（ErrIdentityMismatch/ErrOccurrenceUnknown/
// ErrLegacyAckAmbiguous/ErrAttemptTerminal/ErrInvalidInput/ErrControlPathMismatch）
// 记日志零变化返回；基础设施错误穿透。legacy ACK 以 Snapshot=nil 转发，由 A 拒绝
// （不用 max(seq) 猜测）。
func (s *Service) CurrentControlIdentity(ctx, workspaceID, agentID) (launchID, sessionID string, err error)
// 短读快照，只读持久 launch + agents.session_id，不碰 Hub。receipt 路径已持
// machine slot 时调用顺序仍是 slot → DB。
```

路由顺序（`Coordinator.OnMessage`，构造期固定）：validate principal → runtimecatalog broker → receipt sink（若装配）→ agent 生命周期 switch（start:ack/session/status/purge 在此，launch-fenced）。`NewCoordinator` 签名不变；M5 用 `NewCoordinatorWithOptions(..., Options{Receipts, Logger})`。

## 2. 对 A 的消费

- `agent_launches` DDL 完全采用 0014 冻结版（我曾按草案实现，A 落地后已重写对齐：无 session 列、state 六值、queue_state、dispatch_count/last_dispatch_at/terminal_code、复合 FK agents/machines(id,workspace_id)）。C 无 schema 变更请求。
- 回执经 `NewDeliveryReceiptAdapterWithIdentity` 消费 §2.5 的 `AcknowledgeManaged/RecordTransition/RecordTerminalError` 与 §2.5.1 的 `AcknowledgeControl`。控制 ACK 的当前 launch/session 用 `CurrentControlIdentity`，不读 payload。
- `ManagedDispatchFactsTx` 为 A 的 `DispatchDeps.Facts` 提供事务内事实（响应 A 变更请求 #4：不触碰 Hub）。
- 派送发送结果回写（A 的 `RecordManagedSendResult`）由父执行者在组合层接线（§7）。

## 3. 对 B 的协调点

B 契约 §4 要求 `ValidateAgentPrincipalTx(ctx, channel.Executor, ...)`。**channel.Executor 是独立定义的同形接口**，Go interface 满足性要求参数类型精确一致，我无法实现 B 现有签名。已提供通用形态 `ValidateAgentPrincipalTx(ctx, agent.Executor /* = platformdb.Executor */, ...)`（§1.1）。**请求 B**（或父执行者）把 `AgentPrincipalValidator` 的参数类型改为 `platformdb.Executor`（或其别名）；`*agent.Store` 即直接满足。读路径（history/context）同样可用同方法在 `WithReadSnapshot` 的 executor 内验证（B 反馈 #6）。

## 4. 首次 session bootstrap 分析（非空分析 + 测试钉死）

问题：tracked mention 需要非空 launchId/sessionId，但第一次启动时两者都未形成（§7.1）。两条候选路径：

1. **伪造业务 wake**：把 mention 内容塞进 `agent:start.wakeMessage` 强推 session 形成 —— **禁止**。原 Daemon `selectWakeDeliveryIndex`（core.ts:1498–1516，注释明言 load-bearing）把带 mentionDelivery 的投递排除出 wake 提升：被提升为 wake 的 mention 会绕过 handleMessage，其 occurrence 永远停在"recorded, never delivered"。去掉 mentionDelivery 降级为普通 wake 更是直接违反协议。
2. **诚实冷启动**（本实现）：start 帧只带 launchId+startDispatchId（`TestStartDispatchNeverCarriesWakeMessage` 钉死 wakeMessage/resumeMessages/resumePrompt/unreadSummary 四字段绝不出现）；mention 逻辑意图在 A 的 delivery 层等待；session 只能由 runtime 经 `agent:session`（launch-fenced）报告；在它落地前 `ManagedDispatchFactsTx.LaunchID/SessionID` 不齐 → A 的调度判 `waiting_identity`，tracked 帧 `NewMentionDeliveryCommand` 对不完整五元**构造期拒绝**（`TestTrackedDeliveryRequiresCompleteIdentitySnapshot`）。某个 runtime 若在无业务 wake 时无法建立 session，它就保持 waiting_identity/未签收，不伪造用户消息。

**Reported receipt ≠ 模型消费**（§1 协议证据 #2 的钉死）：`agent:start:ack queueState=running` 与 `agent:delivery:transition stage=daemon_drained` 都是 Daemon 报告。`TestReportedAckAndDrainedAreNotModelConsumption` 断言 running ack 落库后 `agents.session_id` 仍为空、身份闸门未开；drained 的持久化字段在 A 侧叫 `drained_reported_at`（命名即承诺）。早 ACK 窗口（agentProcessManager.ts:4361–4388 启动缓冲）如实保留为兼容局限，不改名、不升级语义。

## 5. 锁序证明（无 DB/fence→slot 反转）

参与锁：**M** = machine slot 互斥（hub.slots per-machine）；**F** = authority fence + SQLite IMMEDIATE 写事务（platformdb.WithWriteTx：f.enter → BEGIN → commit → f.leave）；**S** = socket/发送队列（enqueue 非阻塞）。

既有边（machinews，本轮未改动，逐条核过源码）：
- 入站回调：`admitCurrent/withCurrent` 持 **M** → `revalidate`（短 **F**）→ OnMessage 回调（machinecontrol→agent：**F** 内含 ValidatePrincipalTx + 业务写）→ 释放 **M**。序：M → F。
- 出站 `Hub.Send`：持 **M** → `revalidate`（**F**）→ enqueue（**S**）→ 释放 **M**。序：M → F → S。
- 无 slot 的纯 DB 路径：仅 **F**。

本轮新增路径（全部单向，无新增反向边）：
| 路径 | 序 | 证明位置 |
|---|---|---|
| `EnsureStartLaunch` | **F**（预留，commit 后释放）→ gateway.Send（**M**→**F**→**S**） | start_dispatch.go：reserveLaunch 先 commit；sendStartDispatch 在事务外 |
| `RecoverPendingStarts` | 无锁读（ListUnconfirmed…）→ gateway.Send（**M**→**F**→**S**） | start_dispatch.go：读不持事务；发送前无 F |
| `DispatchDelivery` | 调用方不持事务（文档强制）→ gateway.Send（**M**→**F**→**S**） | DispatchDelivery 注释 + §7 组合根说明 |
| receipt 回调 | machinews 持 **M** → validate（**F**）→ adapter → A 的 Store（**F**） | machinecontrol/receipts.go（与既有 OnMessage 同栈） |
| `ManagedDispatchFactsTx` | 纯 **F** 内 SQL，零 Hub 调用 | dispatch_facts.go（响应 A 变更请求 #4） |

不存在任何"持 F 等 M"的路径：agent 包内所有 gateway 调用点（Start/Stop/Delete/EnsureStartLaunch/RecoverPendingStarts/DispatchDelivery/sendStops/sendPendingPurges）均在事务提交后或无事务状态执行——这是 M3 既有不变量（"the store commits first, dispatch follows"），本轮以审查+新增代码同规则维持。调度器（A/父）在 `PrepareManagedDispatches` 提交后再调 `DispatchDelivery`，最后一道实时准入在 hub 的 M 内完成（撤权→发送窗口由此闭合）。

## 6. machinews 零改动声明

受控投递所需的 current-connection safe dispatch 已由既有 Hub 提供：`Send` 的 per-machine slot 互斥 + principal 重验 + 连接代际 fence（frame scope）+ 非阻塞 enqueue；回调路径的 `admitCurrent` 同构。执行锁明令"复用稳定化现有 guard，不另造全局锁"。故 `internal/transport/machinews/**` 本轮无生产代码改动；其既有测试（fence/handshake/offline_reconnect/protocol）原样通过（§8）。

## 7. 父执行者组合根接入清单

1. **构造**（app 组装，迁移 0014 应用后）：
   ```go
   launchStore, err := agent.NewLaunchStore(handle, clock)  // 失败=拒绝启动 M5 路径
   agentService := agent.NewService(agentStore, agent.ServiceOptions{
       Gateway: hub, ServerURL: cfg.ServerURL,
       DeviceAuthEnabled: cfg.DeviceLogin, Launches: launchStore,
   })
   receiptSink := machinecontrol.NewDeliveryReceiptAdapterWithIdentity(
       deliveryStore, logger, agentService.CurrentControlIdentity)
   coordinator, err := machinecontrol.NewCoordinatorWithOptions(
       agentService, broker, validatePrincipal,
       machinecontrol.Options{Receipts: receiptSink, Logger: logger})
   hubCfg.OnMessage = coordinator.OnMessage  // hub 配置既有字段
   ```
2. **调度循环**（周期 + commit-listener 唤醒，归父/A）：
   ```go
   plans, err := deliveryStore.PrepareManagedDispatches(ctx, delivery.DispatchDeps{
       Facts: func(ctx, ex, ws, agentID) (delivery.DispatchFacts, error) {
           f, err := agentService.ManagedDispatchFactsTx(ctx, ex, ws, agentID)
           return delivery.DispatchFacts{SupportsManagedWire: f.SupportsManagedWire,
               Reachable: f.Reachable, MachineID: f.MachineID,
               LaunchID: f.LaunchID, SessionID: f.SessionID, Stopped: f.Stopped}, err
       },
       Authorize: /* B 的会话授权回调 */,
   }, input)
   // 事务提交后（绝不持事务）：
   for _, plan := range plans {
       var cmd agent.DeliveryCommand
       var err error
       if plan.Delivery.SourceKind == "briefing" { // null message, seq 0
           cmd, err = agent.NewControlDeliveryCommand(plan.Attempt.AgentID, briefingMessageJSON, plan.Attempt.OccurrenceID)
       } else {
           cmd, err = agent.NewMentionDeliveryCommand(plan.Attempt.AgentID, presenterMessage, plan.MessageSeq, snapshotFrom(plan))
       }
       // 发送走 hub.SendWithAdmission（slot 内重验 Agent/launch/频道并持有至 enqueue）。
       // DispatchDelivery 只包 Hub.Send 的 computer 重验，不能单独声称最终授权。
       if err == nil { err = hub.SendWithAdmission(ctx, machineID, cmd, admit) }
       deliveryStore.RecordManagedSendResult(ctx, outcomeFor(cmd, err, plan))
   }
   ```
   `presenterMessage` 来自 D 的 AgentMessage presenter；`snapshotFrom` 用 plan.Attempt 的三快照 + occurrence/message id。
3. **启动恢复**：`EnsureStartLaunch` 由调度在 `waiting_machine/identity` 且 Agent 未停止时调用（或父在 OnReady/周期里调）；OnReady 已内置 `RecoverPendingStarts`（无需父接线）。服务端重启后调用一次 `RecoverExpiredLeases`（A）+ 各在线机器 `RecoverPendingStarts`（C）。
4. **Agent API（D）**：`bindAgentCredential` 后的 send/read 用例改为事务/快照内 `store.RevalidateCredentialTx` / `ValidateAgentPrincipalTx`（替换"先验后开无身份快照事务"的旧形态）。

## 8. 我运行的命令与结果

```sh
cd server-go
GOCACHE=<sandbox-local> go build ./...                                  # 通过
GOCACHE=<sandbox-local> go vet ./internal/agent/ ./internal/application/machinecontrol/ ./internal/transport/machinews/   # 无告警
GOCACHE=<sandbox-local> go test ./internal/agent/ -count=1              # ok（含既有 M3 全部测试 + 本轮新增）
GOCACHE=<sandbox-local> go test ./internal/application/machinecontrol/ -count=1   # ok
GOCACHE=<sandbox-local> go test ./internal/transport/machinews/ -count=1           # ok（零生产改动回归）
```

新增测试（我拥有）：`principal_m5_test.go`（5：当前 scopes/撤销/Agent与空间消亡/绑定与跨空间伪造/事务内撤销拒绝）、`launches_m5_test.go`（8：去重、移机 supersede+迟到 fence、ack=reported 非会话、ack 四类 fence、恢复窗口、重发计数与终态拒绝、stop 终结、缺表拒绝）、`start_dispatch_m5_test.go`（6：单 dispatch 身份、wake 禁令、五元完备性、reported≠消费、离线持久+恢复、跳过 stopped/移机、受控投递错误穿透）、`dispatch_facts_test.go`（1：纯持久事实组合）、`machinecontrol/receipts_test.go`（7：路由、无效形状消费、start:ack 归属、验证先行、适配器逐字映射+legacy nil、预期拒绝分类、端到端）。

## 9. 诚实边界

- start:ack/transition/ACK 全部是 reported receipt；早 ACK 窗口与 exactly-once 之外的副作用窗口按深化设计 §7.3 如实保留，本文不放大承诺。
- 首次 session bootstrap：冷启动路径已实现并测试；各 runtime 在无业务 wake 下能否建立 session 属 S0 spike 结论，本切片不代签收（§4 分析给出判定闸门：waiting_identity 保守等待）。
- machinews/agentapi/app 未接线（父执行者所有权）；未执行真实 Daemon/CLI 闭环与 `make check` 全量（沙箱内 GOCACHE 受限，构建/测试以包级命令执行；建议父在合并 gate 跑全量）。
- 未 commit/push；未改 app/HTTP/migrations/message/channel/client/locks/goldens/data/config 与既有进程。
