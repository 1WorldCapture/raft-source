# M5 Onboarding 交接整合（父执行者负责实现）

本模块只处理已确认 owner setup-handoff 后的 Agent-only briefing；不复刻 opener-v2 的四条代发消息/附件/Day2提醒，不写假 Agent 回复。人类点击事实已由 workspace 持久化，重启/重连可从其重建。

## 对 G 的接线

父执行者新增 `internal/application/onboarding.Service`（构造依赖同 DB workspace/channel/delivery stores），只拥有协调，不在 app 放业务。提供：

- `Reconcile(ctx) error`：同事务扫描真实已完成且已 handoff 的 owner、指定 onboarding Agent、启用 #all 和未完成 briefing，调用 A `PlanBriefingTx`。同幂等key唯一，不写任何公共消息。
- `BriefingTx(ctx,ex platformdb.Executor,d delivery.Delivery) (*Briefing,error)`：从 source_id解析owner/version并重新核对当前owner/membership/setup/Agent指定/频道权限，返回纯事实 `Briefing{WorkspaceID,AgentID,MemberID,ChannelID,ChannelName,Content,NoticeID,CreatedAt}`，无 wire DTO/JSON。NoticeID稳定等于逻辑 delivery ID（非 messages.id）。
- `FinalizeReported(ctx) error`：调用同一有界幂等 Reconcile，从 delivery 已报告 receipt 的 source_kind=briefing 行补写 workspace preferences 的 onboarding_dm_sent_at/by_agent，只代表当前旧协议实际报告的接收层级，不等于模型消费。

**代码已存在并已执行通过**：`go test -count=1 ./internal/application/onboarding ./internal/workspace`；包含重复计划唯一、私有正文零messages/publication、未ACK不填sent、已有ACK恢复补写、隐藏/归档/删Agent/未handoff权限、故障回滚、103空间分页公平性。构造：`onboarding.NewService(workspaceStore, channelStore, deliveryStore)`。

G 创建 dispatcher 时可注入不可变 `Briefings` 端口：prepare 授权时对 SourceBriefing 调 BriefingTx，message source 仍用 message/channel事实。pump 每轮先 Reconcile（bounded），派送后/下轮 FinalizeReported。对方未构造前不要加 no-op成功；由父执行者和G在最终装配时统一。

## control notice 原 wire（已实读 core.ts:3458–3469）

非消息 briefing 不借用 messages.seq，也不创建公开聊天行。下行现有 `agent:deliver`：message sender_type=system，content为Agent-only，message_id=稳定NoticeID；wire `seq:0`、`transient:true`、`deliveryId=attempt.occurrence_id`，**无 mentionDelivery**。原 daemon sendDeliveryAck会回传seq0+deliveryId。它的accepted/ACK只能解释为reported receipt（可能存在transient丢弃路径），不能叫model_consumed。

C目前NewTransientDeliveryCommand拒绝seq0且不带deliveryId，需合法扩展控制notice路径（仍是原protocol）。Parser对普通ACK允许seq0，但tracked snapshot分支仍严格positive。G据 source_kind 分别走消息ACK与controlACK：后者验证认证机器/Agent/workspace、当前连接以及attempt所绑定的current launch/session，不能把seq0当全局清队列信号。

## 对 A 的追加事实 API 请求

为了保持领域拥有自己的表，父执行者会在A完成后增加或请A增加：

- 父执行者已新增 `delivery/briefing_views.go::FindPlannedSourceTx(ctx,ex,workspaceID,agentID,sourceKind,sourceID) (*Delivery,error)`。Reconcile 对 workspace 有界 keyset 候选逐项查询确切 source，无需 ListAcknowledgedBriefingsTx 或新 schema，避免已finalize第一页挤占扫描。
- `AcknowledgeControl(ctx,input ControlAckInput{Principal,AgentID,OccurrenceID,LaunchID,SessionID}) (AckResult,error)`：真实已派送null-message控制attempt、身份快照+当前事实验证，seq0与具体occurrence绑定；不能和tracked AcknowledgeManaged混同；事务内确认意图，重复幂等。

0014 已支持 briefing/null message，不需新migration。父执行者不修改 A/C/G 活跃所有权文件，完成后协调相应小补丁。

## 范围与权限

Owner briefing只发指定同空间活Agent，目标上下文是启用的真实 #all，但正文不进入messages/publications，其他人类和Agent读历史不得看到。隐藏/归档#all、未完成setup、未handoff、换owner/指定Agent/撤权时不派送旧briefing。重复hand-off/激活/周期扫描不创建重复意图。发送后reported字段与人的handoff分开；receipt未确认不先写成功。
