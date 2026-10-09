# M5 Agent API Worker Contract（D）

- 日期：2026-10-09。责任人：D / Agent API worker。
- 所有权：`internal/transport/httpapi/agentapi/**`、`internal/transport/presenter/agent_messages.go`、`internal/protocol/client/agent_messages.go`、本文档。
- 不修改：app/组合根、router/manifest、humanapi、既有 presenter/protocol 文件、迁移、packages/、锁文件、旧 golden、4301/5175 实例。新增公开构造参数由父执行者装配。

## 1. 冻结的原协议（实读 checkout `336b5c8` 源码，不是猜测）

来源：`packages/shared/src/agentApiContract.ts`、`agentApiMessageContract.ts`、`agentApiPaths.ts`、`packages/cli/src/commands/message/{send,check,claim,ack,read,resolve}.ts`、`_claimAck.ts`、`_inbox.ts`、`packages/server/src/routes/internalAgentApi.ts`、`routes/agentWritableTarget.ts`、`routes/channelAccessDenial.ts`。另遵守 [m5-claim-wire-correction.md](m5-claim-wire-correction.md)。

### 1.1 本切片实现的精确路由

| 路由 | 方法 | capability | 原客户端 |
|---|---|---|---|
| `/internal/agent-api/send` | POST | `send` | `raft message send`（v1） |
| `/internal/agent-api/v2/send` | POST | `send` | `raft message send`（CLI 实际总是走 v2） |
| `/internal/agent-api/events` | GET | `read` | `raft message check`（legacy destructive drain：返回即确认） |
| `/internal/agent-api/events/claim` | GET | `read` | `raft message claim`（`?since=latest`，不确认） |
| `/internal/agent-api/events/ack` | POST | `read` | `raft message ack`（幂等） |
| `/internal/agent-api/history` | GET | `read` | `raft message read`（channel/before/after/around/limit） |
| `/internal/agent-api/resolve-channel` | POST | `send` | `attachment upload --target`（target DSL → channelId） |

其余 family（messages/search/channels/threads/mentions/tasks/...）保持 `DeferredAgentAPI` 的鉴权后 501 / 未知路径 401，不做 family 级兜底放行。未装配端口时上述七条精确路由不注册（含 405 回退），回落到 501，不伪造成功。

**已装配路由的错误方法**：每条已装配路径另注册 method-less 回退，在同一 Agent proof + capability 门禁（401/403/501-capability 先于 405）之后返回 `405` + `Allow: <正确方法>` + body `{error:"Method not allowed",code:"method_not_allowed",allow}`——不再误报 "not implemented"。未装配 family 与未知路径的旧语义不变（deferred 501 / 401 unregistered）。`GET /path` 模式按 Go 语义同时覆盖 HEAD；但 events/drain 与 events/claim 具有收件状态副作用，续作已在鉴权/能力校验后显式拒绝 HEAD（405、Allow: GET），禁止无正文探测请求消耗收件或领取无法接收的批次。history 的 HEAD 只读语义保留。

### 1.2 身份与 capability

- 只接受 `Authorization: Bearer sk_agent_*`。人类 JWT、Computer key、其他 Agent 的 proof 一律 401（`bindAgentCredential` 既有语义）。
- scope 缺失 → 403 `{error:"Agent credential is not authorized for this capability", code:"capability_not_authorized", requiredCapability}`。
- 存在 `X-Slock-Agent-Active-Capabilities` 头且不含该 capability → 501 `{error:"The current runner session does not support this capability", code:"unsupported_capability", requiredCapability}`。

### 1.3 send（v1/v2 归一）

Body（zod passthrough，未知字段忽略）：`target`、`content`、`attachmentIds?`、`idempotencyKey?`（trim 后 1–256）、`continue?`、`sendDraft?`、`continueAnyway?`、`draftReholdCount?`、`draftReplacedExisting?`、`seenUpToSeq?`、`freshnessContextMode?`（inline|withheld）；v2 另有 `mentions?: {type:user|agent,id:uuid,name:1..128}[]`（v1 携带 mentions 时忽略，同 TS）。

TS 校验顺序（冻结）：`target` 非空字符串 → 400 `{"error":"target is required"}`；`content` 非空字符串 → 400 `{"error":"Content is required"}`；`continue:true` → 400 `--continue is no longer supported...`；`continueAnyway&&!sendDraft` → 400 `--send-draft --anyway requires a saved draft`。

- 目标解析错误（TS `agentWritableTarget.ts` 原句）：forbidden → 403（#announcement 一句话 / 线程非父频道成员 / 普通频道非成员三句原文）；`dm:@peer` 的 peer 不存在 → 404 `User or agent not found: @<peer>`；对自己开 DM → 400 `Cannot create a DM with yourself`；其余 → 404 `Channel not found: <target>` / 线程变体原句。
- 归档 → 409 `{"error":"This channel is archived","code":"channel_archived"}`。
- v2 mention 校验失败 → 400 `{"error",...}`，binding 冲突带 `code:"mention_binding_conflict"`。
- 成功 → 200 `{"ok":true,"state":"sent","messageId","messageSeq"}`（`pendingMentionActions`/`unresolvedMentionHandles` 为空时省略；M5 合法目标要么全部接受要么整笔拒绝，不产生部分成功）。
- 未知错误 → 500 `{"error":"Failed to send message"}`。
- **M5 Go 不实现 freshness gate**（attested-send 事实不存在；原 TS 的 `sendFreshness not enabled → 403` 分支绝不能复刻，否则当前 CLI 每次发送都带 `draftReholdCount` 会被 403）。`state:"held"` 分支本服务器不产生；wire 联合类型保持兼容。
- **draft 动作（review 修正）**：`sendDraft:true`（含其伴随的 `continueAnyway:true`）→ 501 `feature_not_implemented` "Saved drafts are not enabled in this server stage"——无服务端 draft 存储/freshness gate，绝不把草稿动作当普通正文提交。总是携带的无害元数据（`draftReholdCount`/`draftReplacedExisting`/`seenUpToSeq`/`freshnessContextMode`）继续接受并忽略。legacy 400 优先级不变（`continue:true` 与 anyway-without-draft 先于 501）。
- attachments：Go 本期未启用。`attachmentIds` 形状先校验（必须是非空字符串数组；非数组或含非字符串/空串元素 → 400 `agent_api_contract_invalid`），**任何被请求的附件数组不可能被静默丢弃后照常提交**；良构非空 → 501 `feature_not_implemented` "Attachments are not enabled in this server stage"。
- **idempotencyKey（review 修正）**：非字符串或 trim 后超过 256 个 UTF-16 单元 → 400 `agent_api_contract_invalid`（绝不静默丢失调用方的幂等身份或截断）；1..256 原样透传；空/缺省视为无 key（原 TS length>0 规则）。B 的 domain 路径同担长度约束（B 反馈 #5）。mention `name` 以 JavaScript 字符串长度（UTF-16 单元 ≤128）度量，与共享 schema/`validateCreateShape` 一致——星面字符按 2 单元计。

### 1.4 events / claim / ack

- `?since=`：`latest` 或非负整数；非法 → 400 `{"error":"since must be a non-negative integer (messageSeq) or 'latest'","code":"since_invalid"}`。`limit`：Number||50（NaN 与 "0" 均取 50），clamp [1,200]；原 TS 对负数 limit 的 SQLite 无限制语义不复刻，下界收 1。
- 响应：`{events:[AgentMessage...], last_seen_msgId, last_seen_seq, reply_target, pending_notice_ids:[], wake_reason:null, has_more}`；`last_seen_msgId`=最新事件 id（空批 null）；`last_seen_seq`=最新事件 seq，无 seq 时回落 since（可 null）；`reply_target`=`channelId:<uuid>` 或 null；`pending_notice_ids`/`wake_reason` 为冻结占位。
- claim 响应额外 `ack:{seqs:[],message_ids:[],third_party_event_ids:[]}`（各 ≤500）。**该 ack 批次即 CLI Claim-Ack token 的全部内容**（base64url JSON `{v:1,s,m,t}`，无服务端秘密/租约字段——见 m5-claim-wire-correction）。
- drain（GET /events）在返回前服务端确认本批（legacy 语义，HTTP 响应丢失窗口由设计文档承认）。
- POST /events/ack body 为三个数组；响应 `{ok:true, removed_count:N}`；重复 ack 返回 0；`third_party_event_ids` 本期接受但不产生删除计数；跨主体/未领取 id 计入 0，不作为水位。

### 1.5 history

- `channel` 必填（缺 → 400 `agent_api_contract_invalid` zod 形状）；`before/after/around` 锚点（纯数字 seq / 8-hex 短 id / UUID）；`limit` Number||50（NaN 与 "0" 均取 50）cap 100；负数同上下界收 1（不复刻 SQLite 负 LIMIT 事故）。
- 锚点非法 → 400 `{"error":"Message anchor must be a seq, full UUID, or 8-character short id in <ref>: <anchor>","errorCode":"INVALID_ARG"}`；歧义 → 400 + `errorCode:"AMBIGUOUS_ID"` + suggestedNextAction；不存在 → 404 + `errorCode:"NOT_FOUND"`（注意键名是 `errorCode`，CLI `mapReadFailure` 依赖）。
- 频道不可见 → 404 `{"error":"Channel not found or not visible"}`（与不存在同体，反 oracle）；可见但无权 → 403 `{"error":"You do not have access to this history"}`。
- 成功 → `{messages:[envelope...], has_more, has_older, has_newer, last_read_seq}`。只读，不隐式推进 delivery ACK。

### 1.6 resolve-channel

Body `{target}`（trim ≥1，缺失 → 400 zod 形状）；成功 `{channelId}`；错误映射与 send 的目标解析完全一致（同一 TS 函数）。解析"可写"目标：posting 授权在内（B 的事务内重验兜底 TOCTOU）。

### 1.7 AgentMessage envelope（events/history 共用）

snake_case 为主 + CLI 实际消费的 camelCase 回显：`seq`（缺省省略）、`id`、`message_id`、`timestamp`、`createdAt`、`sender_type`/`senderType`（agent-facing：human|agent|system|third_party_app）、`sender_name`/`senderName`、`sender_description`/`senderDescription`、`channel_id`、`channel_name`、`channel_type`、`parent_channel_name`、`parent_channel_type`（线程；父为 dm 时 CLI 依此拼 `dm:@peer:shortid`）、`content`、`mentioned`、`attachments:[]`、`threadId`、`replyCount`、`non_member_mention`（可省）。线程消息的 `channel_name` 为 `thread-<shortid>`。timestamp 为 ISO 毫秒（JS toISOString 形）。任务字段本期不存在即省略，不伪造。

## 2. Go 表面（本 worker 交付）

- `protocol/client/agent_messages.go`：上述 wire DTO（纯协议叶子，无 domain import）。
- `presenter/agent_messages.go`：`AgentMessageFacts`（传输无关输入事实）→ wire envelope 的唯一映射；`AgentHistoryFacts`。
- `agentapi/ports.go`：消费侧端口（接口 + 输入/负载结构 + 类型化错误），签名只使用基元与 domain 类型（`agent.CredentialLookup`、`message.CreateInput` 内嵌）。
- `agentapi/{messages,events,history,resolve}.go`：HTTP 适配（解析/校验/错误映射/envelope，无 SQL、无业务判定）。
- `agentapi/handlers.go`：`Handlers` + `NewHandlers(store, Dependencies)`（构造校验、端口不可变）；`RegisterRoutes` 在对应端口已装配时注册七条精确方法路由，否则保持 deferred 501。Go mux：精确 method 路由优先于 `{rest...}`，已实现路径的错误方法经同一 proof/capability 门禁后返回 405；未装配路径才回落 `DeferredAgentAPI` 501。

## 3. 端口契约（A/B/C 对接点；组合需求）

```go
// send：归一后的 agent 发送。内嵌 message.CreateInput（ChannelID 为已解析 UUID，
// Mentions 仅 v2 结构化 mention），IdempotencyKey 对应原 agent_send_key（1..256）。
type AgentSendInput struct { message.CreateInput; IdempotencyKey string }
type SendAgentPort interface {
    SendAgent(ctx context.Context, principal agent.CredentialLookup, in AgentSendInput) (*message.CreateResult, error)
}
// B：按 lock #5 提供 SendAgent(ctx, principal, message.CreateInput) 后，父执行者
// 以一行适配（或 B 扩展 CreateInput 携带 agent send key 后直接方法值）装配。

type WritableTargetResolution struct { ChannelID, Kind string } // Kind: channel|private|dm|thread
type WritableTargetPort interface {
    ResolveWritableAgentTarget(ctx context.Context, principal agent.CredentialLookup, target string) (*WritableTargetResolution, error)
}
// 错误：TargetForbiddenError{Message}/ErrAgentTargetPeerNotFound/ErrAgentTargetSelfDM/
// TargetNotFoundError{Message}/AgentDMNotEnabledError{Message}（501）。B 实现；
// 消息用 agentWritableTarget.ts 原句。

type AgentHistoryQuery struct { ChannelRef, Before, After, Around string; Limit int64 }
type AgentHistoryPort interface {
    ReadAgentHistory(ctx context.Context, principal agent.CredentialLookup, q AgentHistoryQuery) (*presenter.AgentHistoryFacts, error)
}
// 错误：HistoryChannelHiddenError（404 中立体）、HistoryForbiddenError（403）、
// HistoryAnchorError{Reason: invalid|ambiguous|not_found, ChannelRef, Anchor}、
// HistoryNotFoundError{Message, Code, SuggestedAction}（线程无回复等原句）。
// B/A 提供：授权读 + 锚点解析 + last_read_seq；只读。

type AgentEventQuery struct { SinceSeq *int64; Limit int }
type AgentEventBatch struct { // presenter.AgentMessageFacts 列表 + 游标原料
    Events []presenter.AgentMessageFacts
    HasMore bool
    AckSeqs []int64; AckMessageIDs []string
}
type AgentEventsPort interface {
    DrainEvents(ctx, principal, q) (*AgentEventBatch, error) // legacy：返回前服务端确认本批
    ClaimEvents(ctx, principal, q) (*AgentEventBatch, error) // 仅领取
    AckEvents(ctx, principal, seqs []int64, messageIDs []string) (int, error)
}
// A 为主（持久 claim facts/租约/receipt），读模型组合 B 的可见性与 C 的凭据重验。
// AckEvents 幂等、按认证主体/workspace 限定、重复返回 0、不把大 seq 当水位。
```

## 3.1 与 A/B 已发布 API 的对接映射（实现侧已按此编码）

A/B contract docs 落地后（`m5-delivery-worker-contract.md` §2.6、`m5-messaging-worker-contract.md` §1.4/1.5），组合根按以下方式把他们的实现接到我的端口（适配器归父执行者，建议放 app 装配处）：

| 我的端口 | A/B 已发布 API | 适配要点 |
|---|---|---|
| `SendAgentPort.SendAgent` | B `Service.SendAgent(ctx, principal, message.CreateInput)`（锁文签名，已实现） | `in.CreateInput` 直传；`in.IdempotencyKey` 需 B 侧 domain 路径支持 256 上限（B 反馈 #5），落地前适配器按 B 最终字段映射，不得截断或静默丢弃 |
| `WritableTargetPort` | B `Service.ResolveAgentTarget(ctx, principal, target) (*AgentTarget, error)` + `channel.AuthorizeAgentConversationTx` | B 哨兵映射：`ErrAgentMessagingUnavailable`→501、`ErrAgentTargetNotFound`→`TargetNotFoundError{notFoundMessageForTarget 原句}`、`ErrAgentTargetShape`→400 "target is required"；channel 域 join-required/archived 归一化错误→`TargetForbiddenError{postJoin 原句}` / `message.ErrChannelArchived`（409）。peer-not-found/self-dm/agent-DM-501 由适配器按 B/channel 事实判别填入对应哨兵 |
| `AgentHistoryPort` | B `ListAgentChannelPageForAgent` / `GetAgentMessageContextForAgent` + C 凭据复核（同读快照） | 锚点解析（seq/短id/UUID、AMBIGUOUS/NOT_FOUND）与 last_read_seq 由 B 读模型产出；装填 `presenter.AgentMessageFacts`（线程 channel_name=`thread-<shortid>`） |
| `AgentEventsPort.DrainEvents` | A `Store.DrainLegacyEvents(ctx, deps, validate, principal, limit)` | 返回事件装填 facts；removed 数不参与响应体（drain 无 removed 字段） |
| `AgentEventsPort.ClaimEvents` | A `Store.ClaimAgentEvents(ctx, deps, validate, ClaimInput)` | `ClaimResult.Claim{Seqs,MessageIDs}` → `AckSeqs/AckMessageIDs`；`Events`+facts 合成 `AgentEventBatch`；`HasMore` 按 A 的批界 |
| `AgentEventsPort.AckEvents` | A `Store.AckAgentClaim(ctx, validate, ClaimAckInput)` | `RemovedCount` 直传（重复 ack=0，见 m5-claim-wire-correction #1）；`ErrClaimUnknown` 等 A 错误→500 "Failed to acknowledge events"（不泄露内部状态） |

A 的 `DispatchDeps`（Facts/Authorize）与 `AgentPrincipalValidator` 由组合根注入 C/事实源——不经过 transport。`third_party_event_ids` 由本层接收且不转发（A 明确不涉及）。

## 3.2 路由 manifest 增补（供 G/父执行者登记；仅在端口装配后注册）

| pattern | 方法 | 门禁 | 行为 |
|---|---|---|---|
| `POST /internal/agent-api/send` | POST | sk_agent proof + `send` scope(+active header) | MessageSend |
| `/internal/agent-api/send` | 其余全部 | 同上（401/403/501-capability 先行） | 405 `Allow: POST` |
| `POST /internal/agent-api/v2/send` | POST | 同 send | MessageSendV2 |
| `/internal/agent-api/v2/send` | 其余全部 | 同上 | 405 `Allow: POST` |
| `POST /internal/agent-api/resolve-channel` | POST | proof + `send` | ResolveChannel |
| `/internal/agent-api/resolve-channel` | 其余全部 | 同上 | 405 `Allow: POST` |
| `GET /internal/agent-api/events` | GET；HEAD 鉴权后 405 | proof + `read` | Events（legacy drain） |
| `/internal/agent-api/events` | 其余全部 | 同上 | 405 `Allow: GET` |
| `GET /internal/agent-api/events/claim` | GET；HEAD 鉴权后 405 | proof + `read` | EventsClaim |
| `/internal/agent-api/events/claim` | 其余全部 | 同上 | 405 `Allow: GET` |
| `POST /internal/agent-api/events/ack` | POST | proof + `read` | EventsAck |
| `/internal/agent-api/events/ack` | 其余全部 | 同上 | 405 `Allow: POST` |
| `GET /internal/agent-api/history` | GET(含 HEAD) | proof + `read` | History |
| `/internal/agent-api/history` | 其余全部 | 同上 | 405 `Allow: GET` |

未装配端口时以上 14 行都不存在，全部回落 deferred 501；`* /internal/agent-api/{rest...}` 的 identity-family 语义（未知 family 401 / 已知 deferred family 鉴权后 501）保持原样。405 body：`{"error":"Method not allowed","code":"method_not_allowed","allow":"<METHOD>"}`。

## 4. 组合根需求（父执行者）

1. `agentapi.NewHandlers(store *agent.Store, deps agentapi.Dependencies)`：`Dependencies{Send SendAgentPort; Targets WritableTargetPort; History AgentHistoryPort; Events AgentEventsPort}`。store 必填；`Send` 装配时必须同时装配 `Targets`（构造期校验）；其余可独立装配，未装配 family 保持 501。
2. 现有 `&agentapi.Handlers{Store: ...}` 字面量继续编译（全部 M5 端点 deferred 501）。
3. 端口实现方（A/B/C 或 app 内薄适配器）负责把 domain 读数填入 `presenter.AgentMessageFacts`（线程 `channel_name=thread-<shortid>`、agent-facing sender_type、Millis 时间戳由 presenter 负责）。

## 5. 测试

- `agentapi` HTTP 测试（fake 端口）：七路由的成功/错误形状、capability/active-capability 门禁、JWT/Computer key 拒绝、未装配 501 回落、**已装配路由错误方法 405+Allow（门禁优先）**、since/limit/锚点校验、claim/ack 幂等语义、**draft 动作 501 且不触达 Send 端口**、**附件形状 400/501 且不触达 Send 端口**、**idempotencyKey 256/257/非字符串、UTF-16 度量**、无 SQL。
- CLI 兼容测试（只读原客户端源码移植）：Claim-Ack token 编解码（`_claimAck.ts` 规则：base64url `{v:1,s,m,t}`、v≠1/负 seq 拒绝）、CLI 格式化器消费字段矩阵（`_format.ts` formatMessageLine/formatHistory 对四种 target 形状所需字段）、send/check/claim/ack 消费的请求路径与响应字段。
- presenter 测试：facts→wire 映射、线程/DM 命名、seq 省略、任务字段不伪造。

## 6. 边界与未做

- freshness gate / held 草稿、附件、task、搜索、第三方事件、agent-event: ref、joint channel：不实现即真实拒绝（501/404/400），不假成功。
- 本文件先于实现发布；A/B/C contract docs（`m5-delivery-worker-contract.md` 等）落地后若签名有出入，以双方文档协调修订，父执行者最终装配并跑 `make check`/cross-build。

## 7. 2026-10-09 续作：收件探测与数值边界

父执行者新增 `events_safety_test.go`，并修复两项真实副作用/数值风险：

- events 与 claim 的 HEAD 请求不进入投递端口；proof 与 read capability 门禁仍先于 405。正常原 CLI GET 行为不变。
- events/history limit 在 float→integer 转换**之前**完成有界夹取，包含超大有限值、Infinity 和 JavaScript 中溢出成 Infinity 的指数写法；无效/NaN/0 保留默认值。since 拒绝会溢出 int64 的边界（float64(MaxInt64) 实际舍入为 2^63），不得生成负游标。

已执行 `go test -count=1 ./internal/transport/httpapi/agentapi`：通过。这只是定向测试证据，不替代最终同树全量 gate。
