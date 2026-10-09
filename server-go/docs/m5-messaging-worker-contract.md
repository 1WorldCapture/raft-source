# M5 Messaging Worker（B）接口契约

- 日期：2026-10-09（America/Los_Angeles）。责任范围按 `m5-execution-lock.md`：`internal/channel/**`、`internal/message/**`、`internal/application/messaging/**`、本文档与自有测试。
- 状态：**已合流为一条生产路径**。`messaging.NewService(channels, messages, readstate)` 签名不变，构造时在同一 `*sql.DB` 上冻结 `delivery.NewStore` 与 `agent.NewStore`（无 nil、无 no-op、无事后 setter）。人类 `Send` 始终解析合法 typed Agent mention 并在同一事务计划收件；Agent DM 始终带真实 peer；`SendAgent` 在事务内调用 `agent.ValidateAgentPrincipalTx`。`CreateMessageTx` 是唯一人类创建路径。`NewAgentMessagingService`、`CreateMessageWithAgentMentionsTx`、`ErrAgentMessagingUnavailable` 已删除。

## 1. B 发布的公开接口（已实现）

### 1.1 Agent 会话授权（channel 域）

```go
// internal/channel/agent_conversation.go
func (s *Store) AuthorizeAgentConversationTx(ctx context.Context, ex Executor,
    workspaceID, channelID, agentID string, posting bool) (*Conversation, error)
```

- 只读真实 Agent/空间/会话事实：`agents.workspace_id = workspaceID AND deleted_at IS NULL`（工作区删除/joint_storage 同步 fail-closed），不伪造人类 claims。
- `Conversation.Channel/Root/ParentMessageID/Role/IsMember`：Role 为 `agent_members` 的可空角色（`AgentServerRole`），IsMember 为根频道 `channel_agents` 行。
- 线程继承根权限（同一 parent-chain walk，深度上限 8，断链 → NOT_FOUND）。
- 读（posting=false）：隐藏 `#all` → NOT_FOUND；普通公开频道可读；private/joint/DM 需 `channel_agents` 行（DM 参与者=双方）。
- 发（posting=true）：隐式成员系统频道（启用的 `#all`、`#announcement`）按既有 Agent 目录隐式成员政策放行（= 原 TS `isServerAgent`，即本空间活 Agent）；其余（普通公开/私有/joint/DM）需根 `channel_agents` roster；归档 → CONFLICT。对齐原 TS `canAgentAccessChannel`/`canAgentPostToChannel`（joint 冻结切片按 private 处理）。
- 错误沿用 channel.DomainError 语义：`NotServerMemberMessage`/`"Channel not found"`/`postJoinRequiredMessage`/`"This channel is archived"`，由 message/channel_seam.go 的既有归一化映射。

```go
// Agent DM 参与者事实：根频道对应的 canonical human-Agent DM 的 Agent 一方。
// ok=false 表示该频道不是（已建档的）human-Agent DM。
func (s *Store) AgentDMParticipantTx(ctx context.Context, ex Executor,
    workspaceID, channelID string) (agentID string, ok bool, err error)
```

### 1.2 canonical human-Agent DM（channel 域）

```go
// internal/channel/agent_dm.go
func (s *Store) EnsureAgentDMTx(ctx context.Context, tx *sql.Tx,
    workspaceID, userID, agentID string) (*Channel, error)
```

- 独立 typed pair 事实表 `agent_direct_messages`（workspace, user, agent, channel 唯一），不向人类 `direct_messages` 塞 Agent UUID，不写假 roster。
- 同一对 (workspace,user,agent) 幂等：重复打开返回同一 canonical channel；软删除行按人类 DM 同规则复活并重新发 `dm:new`。
- 创建：channels(type=dm, name=agent.name) + channel_humans(该人类) + channel_agents(该 Agent) + pair 行 + `dm:new` intent，同一事务。guest 发起者拒绝；Agent 必须是本空间活 Agent。
- 第三方无加入/读取路径（DM 授权只认参与者行）。

```go
// 人类 DM 列表（含 Agent 对端，真实 peer 类型，不把 Agent 冒充 user）
type DMView struct { ...; PeerType string } // "user" | "agent"
func (s *Store) ListDMsWithAgentsTx(ctx context.Context, ex Executor,
    workspaceID, userID string) ([]DMView, error)
```

- `channel.ListDMsTx` 仍只返回人类对人类行。应用层 `messaging.ListDMs` / `CreateDM` 已改走 `ListDMsWithAgentsTx`：Agent 对端来自 `agents` 表，`PeerType` 为 `"agent"`，gravatar 为空，排序与原规则一致。
- **G 接线**：`humanapi/conversation_dto.go` 的 `dmChannelWireView` 仍硬编码 `PeerType: "user"`。领域行已经是真实 peer。G 必须透传 `v.PeerType`（Agent 行 gravatar 保持空）。在此之前 HTTP JSON 会把 Agent DM 标成 `user`，与领域事实不一致；B 不改 transport。

```go
// Agent 侧按 peer handle 解析既有 DM（target DSL dm:@peer 用；只解析不创建）
func (s *Store) ResolveAgentDMByPeerNameTx(ctx context.Context, ex Executor,
    workspaceID, agentID, peerName string) (*Channel, error) // nil = 无此 DM
```

### 1.3 typed Agent mention（message 域）

```go
// internal/message/create.go — 唯一人类创建路径
func (s *Store) CreateMessageTx(ctx context.Context, tx *sql.Tx,
    claims auth.AccessTokenClaims, workspaceID string, input CreateInput) (*CreateResult, error)
```

- 人类发送允许 `Mention{Type:"agent"}`。不再存在第二套 “M4 仍 501” 的创建函数。
- 解析规则（同事务、同快照）：Agent 必须是本空间活 Agent；`name` 必须等于 `agents.name`（handle 防伪）；接收者须对根会话具备**读取+回复**权限（`AuthorizeAgentConversationTx(posting=true)`）。非法目标整体拒绝（400），绝不半笔提交：`Mention @x is not an agent of this workspace` / `Mention @x does not match the agent directory` / `Mention @x cannot receive mentions in this conversation`。
- 事实分表：人类进 `message_mentions`（原样），Agent 进 `message_agent_mentions(workspace_id, message_id, agent_id, handle_at_send, created_at)`，唯一 `(message_id, agent_id)`。原 `message_mentions.user_id` 人类表不动。
- 幂等摘要含 `agent:<id>` 目标（排序后）；同 randomId 重放返回原消息、不重写任何事实。
- 同 handle 绑定两个 actor（含跨 user/agent）仍是 `MentionBindingConflict`。

`CreateResult` 新增 `RootChannelID string`（根会话；非线程时等于频道本身）与 `AgentMentionIDs() []string`（排序去重后的 Agent 收件目标）。

### 1.4 SendAgent（application/messaging）

```go
// internal/application/messaging/messaging.go
// 签名保持三实参。内部冻结 delivery.NewStore(db) 与 agent.NewStore(db, StoreOptions{})。
func NewService(channels *channel.Store, messages *message.Store,
    readstate *readstate.Store) (*Service, error)

func (s *Service) SendAgent(ctx context.Context, principal agent.CredentialLookup,
    input message.CreateInput) (*message.CreateResult, error)

func (s *Service) ResolveAgentTarget(ctx context.Context, principal agent.CredentialLookup,
    target string) (*AgentTarget, error)

type AgentTarget struct { ChannelID, ChannelType string }
```

- `SendAgent` 单一 `platformdb.WithWriteTx`：**先** `principals.ValidateAgentPrincipalTx(ctx, tx, principal, "send")`（C 提供的事务内重验；慢 hash 留在 HTTP 入口），再 `messages.CreateAgentMessageTx`（见 1.5），再同事务 `RecordSendPublicationsTx`。Agent 发送者不推进人类 read frontier、不产生 Agent 收件意图（无级联）；线程回复照发 `thread:updated`。
- sender 幂等：`(sender_type='agent', sender_id, random_id)` 全局唯一；同 randomId+摘要重放返回原消息且零副作用。
- Agent 发送者提及**人类**用既有 typed user mention 规则；提及**Agent**（含自指）→ 501 `Agent mentions of other agents are not enabled in this server stage`（显式拒绝，不静默）。
- 目标 DSL 由 `ResolveAgentTarget` 按**原 TS `resolveWritableAgentTarget` 语义**解析成稳定 channel UUID（单一写事务 + C 重验，posting 授权在内）：
  - `dm:@peer`：既有 canonical human-Agent DM → posting 校验；peer 为本空间人类且尚无会话 → **创建** canonical DM（原 findOrCreateDM 路径）；peer 非人类非 Agent → `*AgentTargetPeerNotFound`；peer 为自身 handle → `AgentTargetSelfDM`；peer 为其他 Agent → `*AgentTargetUnsupported`（agent-agent DM 诚实 501）。
  - `#name:<8hex>` / `dm:@peer:<8hex>`：解析父会话 → 按 parent message UUID 前缀定位线程（跨频道同前缀碰撞不解析）→ 存在则 posting 校验；父消息存在而线程未建 → **创建**线程（`channel.EnsureAgentThreadTx` + message-owned `thread_id` 投影同事务挂接；公告频道线程仍拒绝）。
  - `#name`：解析（private/joint roster 门控）→ posting 校验；可解析不可发 → `*AgentTargetForbidden`；归档 → `message.ErrChannelArchived`（409）。
  - 未命中 → `*AgentTargetNotFound{Target}`（适配方按 target 形态渲染原句）；空/空白 → `ErrAgentTargetShape`。
  - 只读形态 `channel.ResolveAgentTargetRefTx` 保留（不创建），供历史/锚点等只读面复用。
- agent 发送幂等键遵循原 agent `idempotencyKey` 上限 **256**（`message.MaxAgentRandomIDLength`；人类 randomId 仍 128）——对 D 反馈 #5。
- `NewService` 始终带真实 planner 与 principal validator。`SendAgent` / `ResolveAgentTarget` 不再有“未接线 501”。调用方仍用原三实参构造。

### 1.5 Agent 发送步骤与读取（message 域）

```go
func (s *Store) CreateAgentMessageTx(ctx context.Context, tx *sql.Tx,
    agentID, workspaceID string, input CreateInput) (*CreateResult, error)
func (s *Store) ListAgentChannelPageForAgent(ctx context.Context, workspaceID, channelID, agentID string,
    q PageQuery) (*Page, error)
func (s *Store) GetAgentMessageContextForAgent(ctx context.Context, workspaceID, channelID, messageID,
    agentID string, before, after int) (*ContextResult, error)
```

- `CreateAgentMessageTx`：`AuthorizeAgentConversationTx(posting=true)` → randomId 幂等 → user mention 解析 → `messages(sender_type='agent')` → 线程中被提及人类的自动关注（原规则，作用于人类）→ 无 Agent 收件计划。
- Agent 读取：读快照 + Agent 会话授权；线程 unread 对 Agent 视图按无 readstate 处理（`viewerID=""` 既有语义），投影与人类同一 presenter 事实源。

### 1.6 SendHuman 的原子收件计划（application/messaging）

`SendHuman`（含线程首回复合用步）始终：

1. `CreateMessageTx`（消息 + 两类 mention 事实）；
2. **同一事务** `planner.PlanMessageTx(ctx, tx, delivery.PlanInput{WorkspaceID, MessageID, ChannelID, AgentIDs})`——目标 = 已解析 Agent mentions ∪ 根会话为 canonical Agent DM 时的对端 Agent（DM 隐式收件，见 §3），去重排序；`ChannelID` 为消息自身频道（线程回复=线程频道）。无目标时不调用 planner。replay（`Replayed=true`）不调用；
3. 线程回复的作者 read advance（原顺序）；
4. `RecordSendPublicationsTx`（既有 browser publication 顺序不变）。

任一步失败整笔回滚——消息、mention、计划、关注、read、publication 同生共死。

## 2. 对 A（delivery worker）的接口消费与约束

按 `m5-execution-lock.md` §2–3 消费（本包以签名兼容 seam 表达，A 的 `*delivery.Store` 直接满足）：

```go
// internal/application/messaging/agent.go —— A 的 *delivery.Store 原生满足
type DeliveryPlanner interface {
    PlanMessageTx(ctx context.Context, tx *sql.Tx, input delivery.PlanInput) error
}
```

**已对账（A 已落地）**：`NewService` 自己执行 `delivery.NewStore(channels.DB())` 与 `agent.NewStore(channels.DB(), agent.StoreOptions{})`。`internal/app/services.go` 继续调用 `messaging.NewService(channels, messages, states)` 即得到真实收件计划与凭据重验，无需第二构造函数。同一事务性由 `agent_deliveries` 行与注入的 `BEFORE INSERT` 失败回滚证明，不再使用 recording planner。

**A 的 0014 已按下列字段冻结并落地**（`message_agent_mentions` / `agent_direct_messages` 由 B 写、A 建；实测一致）：

```sql
CREATE UNIQUE INDEX idx_agents_id_workspace ON agents(id, workspace_id);

CREATE TABLE message_agent_mentions (
    message_id     TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id       TEXT NOT NULL,
    handle_at_send TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (message_id, agent_id),
    FOREIGN KEY (message_id, workspace_id) REFERENCES messages(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_message_agent_mentions_agent ON message_agent_mentions(workspace_id, agent_id, message_id);

CREATE TABLE agent_direct_messages (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id     TEXT NOT NULL,
    channel_id   TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, user_id, agent_id),
    FOREIGN KEY (channel_id, workspace_id) REFERENCES channels(id, workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_direct_messages_agent ON agent_direct_messages(workspace_id, agent_id, channel_id);
```

（Agent 软删除不清事实行；复合 FK 需要 `idx_agents_id_workspace`。A 的 0014 若对列名有调整，以字段集合不变为前提与本契约对齐后同步 B 测试 fixture。）

### 2.1 与 D（agentapi worker）的对接

D 的端口（`SendAgentPort`/`WritableTargetPort`）按本文 §1.4 映射（D 契约 §3.1 已按此编码）：
- `SendAgent`：`AgentSendInput.CreateInput` 直传，`IdempotencyKey` → `CreateInput.RandomID`（≤256 已支持）。
- `ResolveAgentTarget` 哨兵映射：`*AgentTargetNotFound`→原 not-found 句（按 target 形态）；`*AgentTargetForbidden`→原 forbidden 句；`*AgentTargetPeerNotFound`→404 `User or agent not found: @<peer>`；`AgentTargetSelfDM`→400 `Cannot create a DM with yourself`；`*AgentTargetUnsupported`→501；`message.ErrChannelArchived`→409。`ErrAgentMessagingUnavailable` 已删除（不再有未接线态）。

## 3. 冻结的语义决策

1. **DM 隐式收件（本期冻结）**：canonical human-Agent DM（含其线程）里**人类**发出的每条消息，同一事务为该 DM 的 Agent 对端生成恰好一个收件意图（无需显式 mention）；显式提及该 Agent 时合并为同一目标。**Agent** 在该 DM 发消息不为任何 Agent 生成意图（人类侧由既有 publication/readstate 负责）。普通频道/系统频道仍只按显式 mention 收件，不广播。
2. **Mention 收件资格** = 根会话读取+回复权限（原 TS `canAgentPostToChannel` 语义）：启用系统频道=本空间活 Agent；普通公开/私有频道=真实 `channel_agents` roster；DM=参与者。未加入普通频道的 Agent mention 整笔回绝（不静默丢弃、不自动加 roster）。
3. **Agent→Agent 提及**：明确 501，不记录事实、不产生意图（级联唤醒不在核心闭环）。
4. **人类路径**：`NewService` 即生产路径。合法 typed Agent mention 与 canonical Agent DM 成功并原子计划收件。附件、task、Agent→Agent mention、agent-agent DM 仍真实拒绝。`ErrAgentDMNotImplemented` 仍导出（humanapi 的 switch 继续编译），`CreateDM` 不再返回它。父执行者需把 `humanapi/m4_message_http_test.go` 里 “agent mention → 501 Agent mentions are not enabled” 改成：不存在的 Agent 为 400 `Mention @… is not an agent of this workspace`（整笔零行）；合法且有收件资格的 Agent 为成功并写入 `message_agent_mentions` + `agent_deliveries`。G 需在 `conversation_dto.go` 透传 `v.PeerType`（当前硬编码 `"user"`，列表/创建的领域行已经是 `"agent"`）。未改 DTO 前 HTTP wire 仍把 Agent peer 显示成 user。
5. **不支持（真实拒绝，不兜底）**：task/workflow/joint/attachment、agent-agent DM、Agent→Agent mention、briefing/交接意图（S5 归 C/父执行者）。`ResolveAgentTarget` 对人类 peer 与已有父消息按 §1.4 创建 canonical DM / 线程；公告线程仍拒绝。
6. 保留 P1 系统频道隐式发帖修复与 M4 授权/replay/publication 顺序；0001–0013、app/transport/agent/migrations/clients/locks/goldens 未改。

## 4. 对 C（lifecycle worker）的接口消费

```go
// internal/application/messaging/agent.go —— C 的 *agent.Store 原生满足
// （参数类型已按 C 契约 §2.3 请求改为 platformdb.Executor 别名形态）
type AgentPrincipalValidator interface {
    // 在调用方事务/快照内重验 credential 未撤销、其当前存储 scopes 含
    // capability、Agent/工作区存活、绑定一致。禁止内部再做慢 hash。
    ValidateAgentPrincipalTx(ctx context.Context, ex platformdb.Executor,
        principal agent.CredentialLookup, capability string) error
}
```

已对账：C 交付 `agent.ValidateAgentPrincipalTx(ctx, agent.Executor /* = platformdb.Executor */, ...)`（含 CURRENT-scopes 语义与 401/403 分类）。B 不写 agent 表、不缓存凭据结论——事务内每次调用以 C 的实时事实为准。

## 父执行者 / G 集成反馈（本轮已在 B 侧合流）

1. Planner 直接使用 `delivery.PlanInput`。`*delivery.Store` 满足 `DeliveryPlanner`。无第二套输入类型。
2. 双轨与可选 no-op planner 已删除。`NewService` 是唯一构造，内部冻结同一数据库上的真实 `delivery.Store` 与 `agent.Store`。`CreateMessageTx` 是唯一人类创建路径，始终解析 typed Agent mention。B 自有测试不再断言人为 501。
3. `AgentPrincipalValidator.ValidateAgentPrincipalTx` 的 executor 参数是 `platformdb.Executor`。`*agent.Store` 直接满足。`SendAgent` 与 `ResolveAgentTarget` 在各自的 `WithWriteTx` 里先调用它，再写事实。
4. 应用层 `ListDMs` / `CreateDM` 已走 `ListDMsWithAgentsTx` / `EnsureAgentDMTx`，`DMView.PeerType` 对 Agent 行为 `"agent"`。HTTP DTO 透传仍归 G（`conversation_dto.go` 目前硬编码 `"user"`）。readstate 的人类-Agent DM 参与者查询归父执行者。
5. Agent `randomId` 上限 256（`MaxAgentRandomIDLength`）；人类仍 128。B 测试覆盖 256 字符合法 key。
6. 直接构造输入的发送/目标解析与 credential 复核在同一写事务。历史/上下文读取新增快照绑定入口，供 G 把已有的 `ValidateAgentPrincipalTx` 与读放进同一次 `WithReadSnapshot`（见下）。仅 channel 的 AgentID 活跃校验不等于 credential 仍有效。

### 1.7 同快照 Agent 读取（message 域，给 G 的 agentconversation）

```go
func (s *Store) ListAgentChannelPageForAgentTx(ctx context.Context, ex platformdb.Executor,
    workspaceID, channelID, agentID string, q PageQuery) (*Page, error)
func (s *Store) GetAgentMessageContextForAgentTx(ctx context.Context, ex platformdb.Executor,
    workspaceID, channelID, messageID, agentID string, before, after int) (*ContextResult, error)
```

- 不打开自己的快照。调用方在**同一** executor 上先 `ValidateAgentPrincipalTx(..., "read")`，再调用这两个方法。
- 现有 `ListAgentChannelPageForAgent` / `GetAgentMessageContextForAgent` 签名不变（自开快照，只做会话读授权），供已有测试编译。G 的 `ReadHistory` / context 目前先在一个快照里验 credential、再调用自开快照的读，两代事实可能不一致；应改为在第一个快照内调用 `*Tx` 变体。B 不改 `internal/application/agentconversation`。
