# M5 原协议证据索引

- 核对日期：2026-10-08（America/Los_Angeles）
- 工作区基线：`336b5c8`；本文引用该 checkout 的实际路径/行段，不是网络最新版声明。
- 方法：主执行者读取 Go/原 Web/共享协议/Daemon 关键路径；独立只读研究者核对原 CLI、Daemon 与 TS Server，主执行者再次检查 ACK 提前确认分支。失败的研究调用不计为审查或测试证据。
- 作用：支持 [M5 深化设计](phase-5-delivery.md)，不是宣称 M5 已实现或所有运行时已通过。

## 1. 共享帧与类型

| 证据路径（仓库相对路径） | 事实 |
|---|---|
| `packages/shared/src/index.ts:71–156` | AgentMessage 的 sender_type 使用 human/agent/system/third_party_app；消息采用 snake_case 字段，有 mentioned、non_member_mention 和线程上下文 |
| 同文件 `529–548` | mention 快照为 occurrence/message/machine/launch/session；三种 transition stage 与六种 terminal error |
| 同文件 `557–582` | agent:start 有可选 launch/startDispatch/wake/resume；agent:deliver 有 message、seq、deliveryId、transient、mentionDelivery |
| 同文件 `853–862` | session/invalidate、start ACK、delivery ACK、transition、terminal_error 的既有字段 |

必须保留 `deliveryId = mentionDelivery.occurrenceId` 与 `message.message_id = mentionDelivery.messageId`。message seq 不能改为新 outbox 的排序号。

## 2. ACK 不是模型消费保证

`packages/daemon/src/core.ts:3735–3820` 在接收 agent:deliver 时核对认证机器、occurrence 和 message identity；调用 AgentProcessManager 后，普通消息 accepted=true 会直接 ACK。带 mentionDelivery 的消息依靠传入的 onMentionAck 回调确认，不在同一个 accepted 分支直接确认。

`packages/daemon/src/agentProcessManager.ts:4201–4288` 从 live process、idle/cooldown restart snapshot 或 queued start 中读取 launch/session，拒绝缺失/漂移身份；trackedMentionDeliveries 是进程内 Map。重复 pending 可 coalesce，重复 drained 可重发 ACK。

`agentProcessManager.ts:4303–4317` 的 completeTrackedMentionDelivery 会先报告 daemon_drained 再 ACK。然而调用位置并不全等价于已经进入模型：

- `4340–4359`：已有 consumed-boundary 证据则不重注入，补确认。
- **`4361–4388`：没有进程但正在 starting/queued 时，bufferDuringStart 后也会调用 completeTrackedMentionDelivery。源码 TODO 明确说明：start 失败后，已经 ACK 的 occurrence 不会重新报告。**
- 其他完成点包括 `4545`、`4561`、`4791`、`7662` 附近，各 runtime/driver 的输入路径需要独立 fixture/原进程验收。

因此 `daemon_drained` 应记录成 **Daemon 报告的 drained**，不能统一映射到 `model_seen`、`task_completed` 或跨 Daemon crash 的 durable consumption。只检查正常在线 SDK 路径而忽略 starting buffer，会得到过强结论。

`packages/daemon/src/core.ts:3458` 的 sendDeliveryAck 取有效 msg.seq，或回退 message.seq；ACK 不是 per-Agent 连续游标。缺少 receipt 的较小 seq 不能被一个大 seq 清理。

## 3. 冷启动与启动回执

`packages/daemon/src/core.ts:1498–1516` 的 selectWakeDeliveryIndex 排除带 mentionDelivery 的消息，不能用普通 wakeMessage 绕开 occurrence 路径。

`core.ts:3503–3540,3578–3610` 与 `agentStartCoordinator.ts:56–78`、`agentStartDispatchProjection.ts:17–34` 维护 start dispatch 去重和 queued/starting/running/rebound 投影。start ACK 只是对应阶段回执，不是自动得到有效 session 的证明。

`agentProcessManager.ts:2558,3699,7510` 附近存在 runtime session 报告；对每个拟支持 runtime，是否能在无业务 wake 条件下初始化 session、重连怎样保留 launch/session，仍须执行定向启动 spike。本文不把仅有源码入口当作已运行证据。

## 4. Agent HTTP/CLI 契约

`packages/cli/AGENTS.md` 规定 managed-runner 和 self-hosted-runner 两种模式，Agent 身份用 handle/target DSL，服务端才是 handle→稳定 ID 的授权解析边界；公共 Web 可以使用 UUID。

| 实际源码 | 原接口及语义 |
|---|---|
| `packages/shared/src/agentApiPaths.ts:1–3`；`packages/cli/src/commands/message/send.ts` | `/internal/agent-api` 前缀，POST `/send` 与 `/v2/send` |
| `packages/cli/src/commands/message/check.ts:1–13` | GET `/events`，non-blocking drain，返回即确认，无后续 CLI ACK |
| `packages/cli/src/commands/message/claim.ts:1–8` | GET `/events/claim`，领取但不确认 |
| `packages/cli/src/commands/message/ack.ts`、`message/_claimAck.ts` | POST `/events/ack`，CLI 本地 token 解码后仅回传 seqs/message_ids/third_party_event_ids 三数组；不是服务端秘密 token |
| `packages/shared/src/agentApiContract.ts:1226–1240,1774–1799` | claim/ack 的共享契约，三数组批次与 `{ok:true,removed_count}`；原 CLI 不携带 claimId/租约代际 |

必须区分 legacy check 的 response-loss 窗口和 claim/ack 的可重领协议。原 CLI 支持不等于 managed runtime 自动采用该路径，也不等于 Agent 执行业务后才 ACK。实施实读 `_claimAck.ts` 进一步确认：Claim-Ack token 只是批次 ID 的 base64url 编码，无法提供服务端签名或租约代际证明；同一主体/消息跨租约的迟到确认不可从 wire 区分。此前将其泛称为“claim token”的部分不能推导为秘密授权票据，详见 `m5-claim-wire-correction.md`。

## 5. 原 TS 的可借鉴机制与不可直接复制的窗口

以下服务路径均在 `packages/server/src/`：

| 源码 | 可核对机制 |
|---|---|
| `services/agentOrchestrator.ts:7610–7658` | start ACK 校验 machine/agent/launch |
| 同文件 `7692–7735` | terminal error 用认证连接定位，payload 只作一致性证据；其他机器不能伪造取消 |
| 同文件 `7758–7768` | IDENTITY_UNKNOWN 是可恢复 attempt 失败，不能永久终结待唤醒消息 |
| 同文件 `7790–7868` | tracked ACK 做身份闭合、持久记录、再清 tracker/inbox |
| 同文件 `9252–9318` | machine ready 后从 durable occurrence 恢复；内存 map 不作第二恢复权威 |
| 同文件 `11597–11674` | redrive CAS、identity drift、stable deliveryId 与快照 |
| `services/agentDeliveryRetryPolicy.ts:14–40` | 参考退避 5 秒起、上限 5 分钟、24 次；预算需持久化 |
| `services/mentionDeliveryOccurrenceService.ts:55–63,101–130` | 状态观察与回执完整性判断 |
| `db/schema.ts:5755–5818` | occurrence、身份快照、重试预算、状态约束、每消息/Agent 唯一关系 |

注意 `services/messageService.ts:3674–3717` 的 occurrence 处理不应被当作 Go 的原子性证明；Go 新实现必须把消息和必需收件意图放进同一 write transaction，避免 occurrence 写失败而消息成功的窗口。协议兼容不要求复制原 Server 的内部故障行为。

## 6. Onboarding 与当前 Go 的缺口

`packages/server/src/services/onboardingService.ts:601–633` 的 briefing 使用 transient 路径；`onboardingBriefingOnActivation.ts:14–36` 提供激活/重连后的再尝试。不能据 transient accepted 就声称持久 inbox 已保存。

`server-go/docs/phase-2-workspaces.md:488–492` 明确把人类 handoff acknowledgment 与 briefing 已投递分开，M2/M3 未投递时不填假成功。

当前 Go：

- `internal/application/messaging/messaging.go` 已拥有 SendHuman 的完整事务和发布顺序，是 M5 合流点。
- `internal/message/create.go` 仍拒绝 Agent mentions；原 `message_mentions` 是 user_id 外键。
- `internal/agent/machine_callbacks.go:39–76` 只消费身份生命周期帧，delivery 帧尚未实现。
- `internal/agent/launch_fence.go` 是内存 fence；M5 的跨重启身份核对需要持久事实。
- `internal/agent/gateway.go:59–76` 当前 command 尚未携带全部 M5 start/delivery 字段。
- `internal/transport/httpapi/agentapi/internal.go` 保留尚未实现 families 的明确拒绝；不能把这些路径名当作已实现操作。
- `internal/platform/db/migrations/0010_messaging_foundation.sql` 的 realtime_publications 明确不是 per-Agent ACK ledger。

## 7. 证据等级

本轮确实执行了 Go 完整 make check、原 M1–M4 fixtures/reducers、升级/回退、race 与交叉编译。**没有执行 M5 的真实 Daemon 输入—模型—回复闭环，没有运行 M5 schema，也没有浏览器复测。** 所以上述 M5 内容是经源码核对的设计约束，不能被下游交接写成“已验证 M5 可用”。
