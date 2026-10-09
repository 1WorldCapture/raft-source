# M5 本轮实施接口锁与责任

日期：2026-10-08（America/Los_Angeles）。用户已授权实现 M5，UI 留给独立协作者。

共同输入：phase-5-delivery.md、m5-implementation-coordination.md、m5-protocol-evidence.md；**实施优先纠正见 m5-claim-wire-correction.md（原 CLI ack 是三个 ID 数组，不是服务端秘密 claim token）**。当前 checkout 含上一轮真实 UI 后端补丁和文档，必须保留；不 commit/push，不修改 packages/、apps/、原客户端/锁文件、迁移 0001–0013、旧 golden、4301/5175 实例、var*/ 或截图。测试只用自己的临时数据/动态端口。

## 工作区所有权

A / delivery worker：新增 internal/delivery/**，新增 migration 0014_delivery.sql。该迁移负责 message_agent_mentions、agent_deliveries、agent_delivery_attempts、claim facts、agent_direct_messages、agent_launches 及它们需要的复合唯一索引；不改旧 migration。先发布准确 schema 与 Go 接口到 m5-delivery-worker-contract.md，再完成实现。不得修改 app/transport/message/channel/agent 生产文件。Store 只写本模块 delivery/attempt/claim 表；message_agent_mentions/channel DM/agent launch 表由对应领域写。

B / messaging worker：internal/channel/**、internal/message/**、internal/application/messaging/**，可新建自己的测试和 m5-messaging-worker-contract.md；实现 Agent 会话授权、target DSL、typed Agent mentions、SendAgent、Agent DM 与原子收件计划。不得修改 agent/、app/、transport/、migrations/（向 A 提交约束），保留现有系统频道 P1 修复。先发布接口，供 Agent API 与调度调用。

C / lifecycle worker：internal/agent/**、internal/application/machinecontrol/**、internal/transport/machinews/**；实现持久 launch/startDispatch、启动 ACK、准确 current identity、受控投递入口和已认证 receipt 派发。读取 A 的 schema 与接口；不得修改 app/、HTTP、message/channel 或 migration。先发布 m5-lifecycle-worker-contract.md，说明组合根集成方式和锁序。

D / Agent API worker：internal/transport/httpapi/agentapi/**、新 internal/transport/presenter/agent_messages.go、新 internal/protocol/client/agent_messages.go，以及 docs/m5-agentapi-worker-contract.md。实现准确原 CLI send/history/resolve/events/claim/ack HTTP 适配，无 SQL；不得修改已有 public Web presenters、humanapi、router/manifest 或 app。与 A/B/C 通过 contract docs 对接，新增公开构造参数交父执行者装配。

E / 原客户端验证 worker：仅新增 tests/acceptance/m5-original-clients/** 与 docs/m5-original-client-worker-report.md；真实原 CLI/Daemon 可执行 harness，任何 runtime 替身必须明示。

F / 迁移验收 worker：tests/acceptance/client-contracts.mjs 的显式新增迁移索引支持、contracts/client/migration-additions.json（不改原 manifest/golden）、新 tests/acceptance/m5-upgrade.mjs、新 platform/db M5 迁移测试及 docs/m5-upgrade-worker-report.md。必要的原升级脚本兼容调整先报告；不改 Makefile/run.mjs，父执行者装配。新索引必须精确 hash+inventory，保留旧冻结集/Git hash 全量自测，不允许任意额外 migration。

G / 主集成 worker：internal/app/**、新增 internal/application/agentdelivery/** 与必要 agentconversation 读模型包、transport/httpapi/agentapi/domain_adapter.go（仅此新文件，不与 D 文件重叠）、humanapi/conversation_dto.go 的真实 PeerType 透传、router/manifest/internal preflight registry 接线、docs/m5-integration-worker-report.md。负责 A/B/C/D 真实实现合流、dispatcher/receipt adapter、关闭回收及既有构造测试升级。所有 production 端口必须真实装配，不用 old/new 两条分支维持旧 501。不得修改 readstate、parent m5_agent_chat_integration_test.go、A/B/C/D 自有文件（报告冲突交对应 worker/父执行者），不得修改 Makefile/run.mjs。

父执行者：readstate 人类-Agent DM 支持、humanapi 新端到端集成测试、Makefile/run.mjs/全量验收、briefing/workspace/application onboarding、最终安全审查与交接。为 briefing 增加 delivery/briefing_views.go（仅新文件、FindPlannedSourceTx 只读方法），不触碰 A 的既有文件；control ACK 待 A/C 完成后协调补齐。

## 跨模块硬契约

1. database/sql + platformdb.WithWriteTx 是唯一跨领域写事务。禁止提交后再补必需收件意图；禁止嵌套 top-level transaction；transport 无 SQL；app 无业务判定。
2. A 提供 `delivery.NewStore(handle *sql.DB) *Store`、`Store.DB() *sql.DB`，Store 无需启动线程/网络，只拥有持久事实。B 的 NewService 可构造同一数据库上的真实 delivery Store（非 no-op、非可变 setter），保持既有调用稳定。
3. A 提供 `PlanInput{WorkspaceID string, MessageID string, ChannelID string, AgentIDs []string}` 与 `PlanMessageTx(context.Context,*sql.Tx,PlanInput) error`。B 在完整 send 用例同一事务调用；sender replay 不调用。Plan 对 (message,recipient) 唯一。
4. B 提供 `channel.Store.AuthorizeAgentConversationTx(ctx, executor, workspaceID, channelID, agentID string, posting bool) (*channel.Conversation,error)`；只校验真实 Agent/空间/会话事实，不伪造人类 claims。线程继承根权限，DM 限双方，普通频道需 roster，启用系统频道按已有 Agent 隐式成员政策，guest/隐藏/归档/删除不放开。
5. B 提供 `messaging.Service.SendAgent(ctx context.Context, principal agent.CredentialLookup, input message.CreateInput) (*message.CreateResult,error)`；principal 自带 AgentID/WorkspaceID/CredentialID/scopes。必须在事务内重验 credential/Agent/绑定及必要 scope，慢 hash 在 HTTP 入口外。需 agent-owned revalidation 方法时与 C 约定，禁止 message 直接写 agent 表。
6. C 提供 agent-owned transaction-bound principal validator，精确校验 credential、scope、活跃 Agent/workspace 和 runner binding；B/HTTP 使用其验证结果。不得仅凭可构造的 CredentialLookup 结构当永久授权。
7. 协议 `agent:deliver` 的 seq 仍是 message.seq；deliveryId=mentionDelivery.occurrenceId；五元快照严格核对。delivery_order 是内部调度，不占用 wire seq。
8. 当前 Daemon 的 drained/ACK 是 reported receipt，不是模型消费保证（starting buffer 存在 early ACK）。不编造 input_accepted 帧，不承诺 exactly-once。
9. 同身份重试保留 occurrence；identity drift 不能原地改旧快照。旧连接/机器/Agent ACK 零越权；receipt 不能覆盖已终态新 attempt。锁序必须明确且无 DB/fence→slot 与 slot→DB/fence 反转。**父审查发现旧 Hub.Send 只重验 Computer，不闭合 Agent/channel 撤权窗口；C 已获追加任务实现 SendWithAdmission（slot内进入调用方 authority fence/活事实检查，并持有至enqueue），G 必须用该入口，不能直接以 DispatchDelivery/Hub.Send 声称最终授权成立。**
10. 0014+ 添加真实约束、indexes 与外键；Agent DM 不往现有人类 direct_messages 塞 Agent UUID；原 human message_mentions 保留，新 Agent mention 分表。A 为 B/C 的表需求提供最终 schema。
11. 未实现 task/workflow/attachments/joint/office 保持真实拒绝。不因支持 message endpoints 把整个 v2/messages/events 家族兜底放行。

每位 worker 必须运行自己负责的测试、报告具体命令及失败，不能改旧 golden 或删除安全测试来变绿。计划不等于代码，测试存在不等于已执行。父执行者最终跑全量 make check/cross-build 与独立安全审查。
