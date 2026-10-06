# Attention 增量版：迭代 1 + 2 合并代码修改方案

- 日期：2026-10-06
- 修订：v2，吸收 dev 更新及评审意见后的完整方案。
- 源码基线：`dev` / `origin/dev` = `06b5617ccf27d6733370aa01cbb119b9c7860f6e`；实查比原基线 `5021cf090e2b2a0553d2868e044f1c7ddb5c0ad0` 新 23 个提交。
- 状态：可实施设计；尚未修改业务代码。本文的新增命令、接口和默认值均为拟议行为。
- 文件状态：本文件在当前工作区存在，但仍为 untracked；并不属于已提交的 dev。更新版应作为实施 PR 的文档一并提交，另提供完整附件用于外部评审。
- 本轮决策：采用人类优先的五级推荐；权限隔离与 direct-notice/full-body 区分是上线门槛；保留无新持久化、无调度变更的范围。
- 相关设计：`attention-v1-design.md` 保留为远期目标；本方案独立交付，不以前述完整 Scheduler 建成为前提。

## 1. 交付定义

一次交付完成两个能力：

1. **有顺序的推荐**：同一份 Inbox/通知候选按 **人类 DM → 人类直接 @ → Agent DM → Agent 直接 @ → 普通** 排序；DM thread 继承 DM 类别。以候选组内尚未消费消息的最强真实信号分类，不用 latestSenderType 代替整组。仍展示其余行，不改变收到哪些消息或通知何时发送。
2. **按 target 读取 pending**：增加 `raft message check --target <target> [--limit <n>]`。只消费当前 managed Daemon 本地、该 conversation 的 pending 正文；其他 conversation、App items 和特殊控制事件不被顺带消费。

用户体验闭环：收到带推荐的通知 → 对推荐 target 执行定向 check → 获得该 target 当前有界 pending 批次 → 完成工作或继续查资料。既有全量 check、history read、search、resolve、claim/ack 保留。

本版不承诺“只让一个 target 进入模型”，也不保证模型绝不主动跨频道。它提供默认优先路径，不建立权限墙。

### 1.1 明确不做

不迁 Go；不新增 `raft attention` 命令族；不维护 Current Focus / Waiting For；不自动判断当前任务；不改变 busy/idle、3 秒通知安排、SDK steer 或 compaction/review 门控；不增加持久化 Attention Queue、selectionId、游标租约或 Server deferred receipt；不修改启动/close/恢复时的消息选择；不全面重构 mention 生命周期；不新增模型分类器；不把任务标记一律提升为“新指派”。

Server、Computer 和 DB 无业务变更；**Desktop/Computer/Daemon/CLI 的构建、版本与发行产物需要联动更新**，不是说所有发布包都不变。外部 self-hosted runner 暂不支持新的定向 pending check，但其现有读取能力不变。其原因是本版本复用 managed runner 本地 Inbox，而不是建设第二套 Server pending 查询。

现有停止、凭据、权限、系统控制、安全门、App 动作仍按原实现工作。“人类优先”只影响普通消息候选的建议顺序，不赋予新权限、不自动抢占任务。

## 2. 本次核查到的实施依据

| 现有代码 | 已核实的事实 | 对设计的影响 |
|---|---|---|
| `daemon/src/agentInboxProjection.ts:73-151` | 按 target 聚合；当前 latestSeq 降序；DM thread 的 flags 不一定带 dm。 | 保留原投影，叠加纯推荐函数；DM thread 不能只靠 dm flag 判断。 |
| `daemon/src/agentRuntimeInput.ts:198-217` | 普通输入是 content-free notice；rows 来自传入的 messages。 | 推荐是“本次更新中”，不是声称掌握全部队列；保留所有原候选。 |
| `cli/src/commands/message/check.ts:17-42`、`message/_inbox.ts:31-94` | 无参数 check 调全量 drain，最多循环 50 轮，并排序输出。 | 无参数分支不变；定向分支单独实现，不复用全量 drain 后过滤。 |
| `daemon/src/agentCredentialProxy.ts:542-590,1357-1420` | 本地 events 优先；本地无数据时可能转发 Server；正文返回前消费本地消息。 | 用独立本地路由，所有分支都返回，禁止新定向请求回落到全量 events。 |
| `server/src/routes/internalAgentApi.ts:4499-4529` | resolve-channel 使用 `resolveWritableAgentTarget`。 | 不把可写目标解析当成读接口；本版只选择已经由 Server 投递的本地 target，不创建/加入会话。 |
| `daemon/src/agentProcessManager.ts:2027-2084` | active 与 starting buffer 都参加 pending；消费经 visible ledger 抑制确切消息。 | 复用原 pending/消费入口，不复制一个业务队列。 |
| `daemon/src/agentProcessManager.ts:4288-4322,4587-4610,7611-7620` | tracked mention 有 received/pending/drained；已有 completePendingTrackedMentions 按 Agent 全量确认。 | 定向读取只能确认实际返回 ID 对应的当前代次 mention，不能调用该全量方法。 |
| `daemon/src/agentVisibleDeliveryLedger.ts:31-65`、`agentInboxProjection.ts:140-151` | `thread-<full UUID>` 在两处 target 格式化的截短处理不同。 | 新读入口必须使用“实际展示的 target”投影规则，不能盲调按另一种 key 过滤的 getPendingMessages。 |
| `shared/src/daemonApiContract.ts:214-274`、`cli/src/daemonApiPath.ts:163-194` | 有独立 Daemon 本机 typed 路由和 CLI 适配器。 | 新路由放这里，不加进 Server agentApiContract 注册表。 |
| `cli/AGENTS.md` | 两种 runner；命令语义在 help；客户端统一；Agent 使用 target DSL/handle。 | 不暴露用户 UUID、不偷偷查询/创建 identity；新命令消费行为在 help 明说。 |
| `daemon/src/drivers/raftCliGuide.ts:1-38` | managed prompt 与 raft-cli-overview 共用生成源。 | 改源再生成手册，不直接手改 generated overview。 |

表中路径均相对 `packages/`，`cli/AGENTS.md` 同样在 packages 下；APM 中原 4582 行之后的旧定位在新基线通常顺移 4 行。对现有路径的核查不代表全部运行时已测试。

### 2.1 最新 dev 的实际差异

`git diff 5021cf0..06b5617 -- packages/daemon/src/agentProcessManager.ts` 显示 **5 行增加、1 行删除**：投递入口使用 `isApmIdle(ap) || ap.driver.isRunInProgress?.() === false`，让 omp 原生运行状态优先于滞后的进程级 busy 判断。不得以旧代码覆盖这个判断。

`consumesSpawnPrompt` 的改动在 `drivers/types.ts:489`、`drivers/omp.ts:739–754` 及 `agentInboxDeliveryDebt.ts`；提交 `97d78bb` 还修改了 handshake 后首个 prompt 的发送和相关回归，并非只在 APM 改了 5 行。此次不改这些语义，但必须保留并复跑相关测试。

### 2.2 direct delivery 的关键事实

当前 `sendStdinNotification()` 在 APM `8055–8104` 将 `formatInboxUpdateRuntimeInput()` 产生的 **content-free notice** 送进 busy runtime，并登记 `recordNoticeWritten`。这一事实只证明通知贡献，不证明消息正文被阅读。

另一条 `deliverMessagesViaStdin()` 路径在 `8315–8428` 使用具体正文 formatter；非 transient 的成功路径才调用 `consumeVisibleMessages`。线程上下文也有独立的全文暴露记录。

现有 `agentProcessManager.codex.test.ts:6041–6193` 明确断言 direct busy notice 不含原正文，且消息留在 Inbox，之后仍可 check。这些是现有测试代码的静态核实，不能把 driver 的 direct/steer 标签等同已读。新版验收必须分别覆盖“通知已写，正文仍可读”和“正文已消费，不再重复读”。

## 3. 合并版的具体产品行为

### 3.1 普通通知

原通知仍会在原时机出现，其候选集合不变。示意：

```text
[Raft inbox notice]
Suggested first among these updates: dm:@James (human direct message)

dm:@James           pending: 2
#proj-api:a1b2c3d4   pending: 3 · you were mentioned
#engineering        pending: 6

Prefer reading one conversation at a time:
raft message check --target 'dm:@James'
If this conversation is unrelated to your current task, finish the current step first. This is a reading recommendation, not a request to switch tasks immediately.
```

中文示意用于设计解释；生产文案沿用仓库既有 Agent-facing 文风。插入命令中的 target 必须按实际 POSIX/PowerShell 上下文安全引用，拒绝控制字符，不直接拼接未经转义的会话名称；相关恶意引号/换行用例加入格式化回归。所有旧行、flags、reply limitation、已有 attention_hint 都保留。不把 pending 计数等同已读，不把推荐打印当成投递成功的新依据。

只有一行或没有可推荐消息时，减少多余说明。只有 suppressed 的 target 可展示，但不能成为待读推荐。Runtime profile、App item 和 channel-less agent-event 不参加本版普通 conversation 推荐；其旧路径保留。

### 3.2 完整 Inbox

`raft inbox check` 仍不消费消息。消息 target 行按相同规则排序，推荐范围写成“这个 Inbox 快照的消息 target”。App items 继续走 `formatAgentInboxFullSnapshot` 的现有独立展示，不与普通消息错误合并，也不宣称 DM 推荐高于所有系统控制。

不加必选 `--attention` 才能受益，不增加 mode-dependent 的读取限制。旧 formatter 可以保留，新增排序/推荐 wrapper 供新 UI 文案调用，避免改变无关工具输出。

### 3.3 读取能力保持并列

| 命令 | 本版语义 |
|---|---|
| `raft message check` | 保留现有全量、非阻塞 drain 与输出行为。 |
| `raft message check --target <t>` | 新增：只读取当前 Daemon 本地该 target 的一页 pending。 |
| `raft message check --target <t> --limit 100` | 新增：调整单次条数上限，不变成全量循环。 |
| `raft inbox check` | 不读正文、不消费；增加排序与推荐。 |
| `raft message read --target <t>` | 原有历史/上下文读取，不等于定向 pending check。 |
| `raft message search / resolve / claim / ack` | 保留现有行为。 |

不把无参数 check 改成只读推荐项；不新增 `--all` 来“归还”原本能力。

## 4. 共享推荐策略：纯函数，不带状态

新增 `packages/shared/src/agentInboxPriority.ts`，从 shared index 导出。拟议接口：

```ts
export type InboxPriorityKind =
  | "human_dm" | "human_mention"
  | "agent_dm" | "agent_mention" | "ordinary";

export interface InboxPriorityRecommendation {
  target: string;
  kind: InboxPriorityKind;
}

// 输入是已完成资格过滤/既有 sender 归一化的 Agent-facing 事实。
export interface InboxPriorityMessageFacts {
  channel_type?: string;
  parent_channel_type?: string;
  sender_type?: string; // 只认 human/agent；其他值不猜测身份。
  mentioned?: boolean;
  non_member_mention?: boolean;
}

// 由 Daemon 对同一 target 的合格、尚未消费消息聚合后，附加到对应行。
export function classifyPendingTarget(
  messages: readonly InboxPriorityMessageFacts[],
): InboxPriorityKind;

export function rankInboxTargets(
  rows: readonly AgentInboxTargetRow[],
): AgentInboxTargetRow[];

export function recommendInboxTarget(
  rankedRows: readonly AgentInboxTargetRow[],
  eligibleTargets: ReadonlySet<string>,
): InboxPriorityRecommendation | null;
```

函数不访问时钟/网络/进程状态，不修改入参，不维护历史，输出只用于展示与建议。

### 4.1 分类规则：人类优先，按真实消息聚合

固定等级为 `human_dm(0) → human_mention(1) → agent_dm(2) → agent_mention(3) → ordinary(4)`。同一发送者类型下，DM thread 与 DM 同级。

对每条合格 pending 消息读取受信任的 `sender_type`，结合自身是否在 DM/DM thread、是否直接提及接收 Agent，计算等级；target 取组内最强等级。DM 判定使用 `channel_type=dm` 或 `channel_type=thread && parent_channel_type=dm`，不能只靠 dm flag。直接 @ 使用 Server 产生的 `mentioned/non_member_mention`，不能解析正文中的 @ 或“我是人类/老板”。

明确区分 DB 的 `senderType=user` 与 Agent-facing 的 `sender_type=human`：本地 AgentMessage 使用后者；历史别名只经既有、可验证的归一化处理，冲突或未知类型不得猜成人类。`system`、`third_party_app`、未知类型不享有人类优先级，原有系统控制通道不参加本版普通消息排序。

**不能直接以 latestSenderType 分类。** 例如人类在 DM 先发请求、Agent 后面补一条，整组仍是 human_dm；Agent 在频道 @ 接收者后，人类只说了一句普通话，不构成 human_mention。sender 和 mention 必须来自同一条消息。最后一条的 senderType 继续只是展示信息。

新投影行增加可选 `attentionPriority`（已知五级值兼容未来字符串）。Daemon 依据原始候选计算，Shared rank 只比较该值，CLI 不用 latestSenderType 反推。同步更新 `AgentInboxTargetRow`、`AGENT_INBOX_TARGET_ROW_KEYS`、Daemon wire schema 与诊断白名单；未知值不得导致整个 Inbox 被拒绝，也不得解释成人类优先。字段缺失时保持可用的粗粒度 legacy DM/@展示，明确无精确 human-first 证据，不伪造新优先级。

`task` 标识仅展示，不自动等价新指派。suppressed-only、空行、App item、Runtime profile、channel-less event 不竞争普通 conversation 推荐；特殊事件即使带合成 DM 字段也不参与。新排序不新增过滤或清空行为。

推荐和读取共用普通 conversation / pending 资格规则。通知的评级范围是本次 delta 中实际候选；完整 Inbox 的评级范围是本地完整快照，两者都调用同一规则，但不把 delta 称为全局排名。组内人类信号被消费后，下一次评级从剩余消息重算，不永久粘在人类优先级。

### 4.2 排序与 seq 前提

先比较上面的五级等级；同级按有效 `firstPendingSeq` 升序，最后按完整 target 确定性决胜。只接受正的 `Number.isSafeInteger`。该字段缺失/不安全的行排在有效 seq 行后，缺值行以 target 稳定决胜，不伪造 seq=0，也不在不同 pair 中混用时间戳和 seq，避免非传递排序。这里只表达已知序号的确定性顺序，不承诺每个无序号成员的严格等待时间。未来若来源不再共享本地 canonical seq，需要统一扩展时间排序字段后再变更，不在 CLI 从 latest timestamp 猜最早时间。

已核实 `server/src/db/schema.ts:1676–1680` 定义 `messages.seq = bigserial`，初始 SQL 同样为 bigserial；`messageService.ts:2011–2032` 的系统消息还显式使用 `nextval(pg_get_serial_sequence('messages','seq'))`。它是**同一个数据库 messages 表的共同序号空间**，并非每个 channel 自己编号；同一 server/注册 Inbox 中跨 conversation 比较成立。不同部署/数据库的 seq 不直接比较；外部数据只能使用 Server 本地投影后的 seq。

建议在 comparator 写明：

```ts
// Candidate scope: one authenticated agent's local Server inbox.
// Canonical messages.seq is allocated from the shared messages-table sequence,
// not a per-channel counter. Use it only as deterministic sequence ordering.
// It is not commit order, arrival order, a contiguous history proof, or an ACK cursor.
```

序列可能有缺口，预分配、并发提交或缓存会使 seq 大小不等于事务提交/网络到达时间；不能据最大 seq 推断此前消息都看过。此处只是同级展示排序，不修改恢复或已读游标。[E1][E2]

本策略不承诺低等级 target 的最大等待时间，也不改变 busy 时机；人类普通频道闲聊也不会因发送者是人类就压过 Agent 的直接请求。

### 4.3 接入两处展示

- Daemon：对本次合格消息聚合 priority 后，projection → rank → recommendation → 原 `formatAgentInboxDelta`。`formatInboxUpdateRuntimeInput` 保留文本入口，内部复用一个返回 text/recommendation 的纯 presentation helper，便于 trace 记录同一结果。
- CLI：Inbox `_format.ts` wrapper 使用 Daemon 行上聚合得到的 attentionPriority 和同一 rank/recommend，再调用原 `formatAgentInboxSnapshot`；上层仍组合 App items。不要从 latestSenderType 重算分类。

不要分别在 CLI 与 Daemon 写一份 DM/@比较器。不要改变传给 notifications、attempt ledger、tracked mention 的原始 message 集合或顺序。推荐文案必须与本次实际输出行使用同一个排序结果。

现有 `/inbox` 响应的 target 行增量携带可选 `attentionPriority`；同时增量附一个可选 `target_check` 元数据：`{ schema: "daemon-inbox-target-check.v1", eligible_targets: string[] }`。它只是当前本机读取能力/资格的快照，不是新状态或授权许可。CLI 据此选择可定向读取的推荐项；字段缺失表示旧 Daemon，仍展示并排序完整 Inbox，但不编造已支持 `--target` 的建议。旧 CLI 可忽略这个可选字段。动态 notice 则从本次原始输入用同一 eligibility helper 计算，保留非候选的旧展示路径。

## 5. 新定向读取的边界

### 5.0 权限隔离是验收门槛

`target` 只是当前注册上下文中的筛选条件，绝不是选择 Agent/租户的权限凭据。拥有者只来自 `registrations.get(bearerToken)` 及其绑定的 coordinator；后者必须闭包绑定同一个 agentId。新端点不得接收或信任 caller-supplied agentId、serverId、launchId、X-Agent-Id 等来扩大范围。

严格请求 schema 拒绝额外身份字段；伪造 header 不能覆盖 registration；invalid/revoked token 拒绝。当前 `agentCredentialProxy.ts:410–420,490–494,1704–1714` 已有 token 绑定与按 launch 注销基础，新路径要复用，不能绕过。

硬测试：A 用 A 的 token 请求只有 B pending 中才有的 target，A 返回 local-empty，B 正文零泄露、B 消费回调/mention ACK 零调用。再加一个更强对照：A/B 都订阅同一显示 target，但各自 pending 不同，A 只能读取自己那份，B 的集合与回执完全不变。A 本来就有权限且已有自己 pending 的同会话消息可以正常读，不能把“B 也看过这个频道”当成禁止 A 读取的理由。

同名 target 跨 Agent 绝不能在全局 Map 中合并后筛选。处理过程中注册被撤销、session/launch 被替换时，在消费前重新验证拥有者，失败零消费。现有权限撤销/purge 行为保持，本版不做额外历史抓取，也不宣称本地缓存自动获得超出原系统的实时授权保证。

### 5.1 支持对象

仅 managed-runner；target 使用通知或 inbox check 已显示的四类引用：`#channel`、`#channel:shortid`、`dm:@handle`、`dm:@handle:shortid`。

本版不是一般目标解析服务。对已投递 target 做精确选择，不负责任意别名、permalink、handle→UUID 解析或创建 DM/thread。target 不存在于本地 pending 只说明这个本地快照无匹配，不证明服务器上不存在该频道或历史为空。

消息合并以同一 actual conversation 为边界。内部保留 channel_id 等已投递身份；如果相同展示 target 对应两个不同真实 conversation（例如短 ID 冲突），返回 `TARGET_AMBIGUOUS`，零消费，不混发两个上下文。

### 5.2 本地 scope 的诚实含义

返回范围明确为 `daemon_pending_target`。

包含当前 agent 的 active inbox + starting buffer 中、目标匹配且仍 pending 的普通消息。选择时用同一 APM 实例的 visible ledger 排除已被记录为正文消费的确切身份，**不能用通知 contributed 集合作为已读集合**。保留同 target 的所有合格发送者，不只拿触发 @ 的那条，也不只拿某个人的 DM。

不补 Server history、不补被 mute 时未投递的消息、不偷偷全量 sync、不把其他 thread 或父频道的消息带入。需要额外背景时，Agent 使用原 `message read/search`，受现有权限控制。

本地快照可能含投递时的 task projection。不能称它为任务最新状态；本版不根据它自动识别“新指派”，也不改原任务写入的 freshness 检查。

### 5.3 小批量一次返回，大批量有界分页

建议初始条数：默认 50，最大 200；严格校验整数、正数和上限。UTF-8 响应预算建议从 256 KiB 开始测试；预算是工程上限起点，不是性能结论。**字节预算优先于条数**，按最终 JSON 序列化后的 UTF-8 字节计量，包含 envelope、附件元数据、task projection、转义后的代码块和响应字段；不是只量 content.length。原始附件文件不内联、不下载。CLI canonical 输出也使用有界 formatter，不能在打印时附加未计量的附件全文。

单次请求捕获 pending 的固定副本 → exact ID 去重 → 目标筛选 → seq 顺序 → 有界前缀。请求处理过程中新增消息留在后续请求。本版不创建持久化 snapshot/selection/cursor，也不让 CLI 内部循环调用旧 drain 的 50 轮逻辑。

返回 `remaining_count` / `has_more`，均只针对该次目标快照。下一次执行同一个定向 check 会读取剩余或新到消息，快照已经更新，不宣称跨调用固定批次。

条数正常时同 target 的 pending 一次返回；超限诚实显示分页。正文不做 LLM 摘要、不静默截断后登记为全文消费。若第一条就超过硬响应预算，返回 `MESSAGE_TOO_LARGE` 和合法消息引用，零消费；Agent 改走现有 history/resolve 路径。若在后续成员处到达预算，先返回已能完整容纳的前缀，剩余继续 pending。

优先级针对 target，不重新排列该 target 的正文；一条 @ 在大 backlog 后面时，保留时间顺序和明确的触发 message 引用，可用原 `read --around` 查看。不要为了推荐而假装已交付全部上下文。

## 6. 路由与 schema：独立本机接口

### 6.1 不在旧 events 上加一个可能被忽略的 query

新增：

```http
POST /internal/agent-api/inbox/messages/check
```

放入 `daemonApiContract.ts`：

```ts
inboxTargetCheck: route({
  key: "inboxTargetCheck",
  method: "POST",
  path: "/inbox/messages/check",
  client: { resource: "inbox", method: "checkTarget" },
  description: "Consume one bounded page of this managed daemon's pending messages for a displayed target.",
  request: { body: daemonApiInboxTargetCheckBodySchema },
  response: { body: daemonApiInboxTargetCheckResponseSchema },
})
```

使用 POST 明确它有消费副作用。不注册 Server route，不修改 agentApiContract 的 Server manifest，也不增加 DB schema。

### 6.2 请求

```json
{"target":"#proj-auth:af813abc","limit":50}
```

request schema strict：非空有界 target、可选 limit。不接受 caller-supplied agentId/serverId/launchId，拥有者来自 proxy registration。Body 中未知键、空 target、非法 limit 在任何读取/消费之前拒绝。

### 6.3 响应

```json
{
  "scope":"daemon_pending_target",
  "target":"#proj-auth:af813abc",
  "messages":[],
  "returned_count":0,
  "remaining_count":0,
  "has_more":false
}
```

`messages` 复用 `agentApiMessageContract.ts` 中的 `agentApiMessageEnvelopeSchema`，不要新写一个会丢 attachments、非成员说明、external provenance 或 task projection 的简化 message schema。避免从包含大量 Server 路由的 barrel 引入循环依赖。

空响应输出：“当前 Daemon Inbox 中，该 target 没有 pending 消息”，而不是“你没有工作”或“频道没有消息”。

### 6.4 专用路由绝不回落全量读取

`handleProxyRequest` 在现有 token/origin 检查之后，通用 upstream forwarding 之前截获该路径。该路径无论成功、空、非法参数、缺 coordinator 或未知 method，都必须本地返回，不得返回 undefined 进入转发。

缺少新 hook：503 `TARGET_CHECK_UNAVAILABLE`。旧 Daemon 对新专用路径可能返回 404/405，CLI 映射为 `TARGET_CHECK_UNSUPPORTED`；它不是 `/events`，因此即使旧 proxy 原样转发这个陌生路径，也不会变成全量 drain。

self-hosted-runner：CLI 在发请求前报告不支持这个本地读取能力，并提示仍可使用原 history read 或主动执行全量 check。这里是不具备功能，不是 Attention 权限限制。

无需新增 Server capability 协议或 AgentConfig feature 状态；仅在既有本机 `/inbox` 响应增加上节的可选能力/资格元数据。发布时让新 Daemon 携带匹配的内置 CLI；新提示词与新端点一起发布。混装旧全局 CLI 出现 unknown flag 时，给出旧 history read 的兼容提示，不自动执行全量命令。

## 7. Daemon 实现与 exact-ID 消费

### 7.1 新增纯准备模块

新增 `packages/daemon/src/agentInboxTargetCheck.ts`，负责请求 target 在当前投影中的匹配、conversation 唯一性、固定成员、排序、分页、大小限制和响应构造。函数只返回计划，不直接变更 APM。

示意接口：

```ts
interface TargetCheckPlan {
  response: DaemonApiResponseByRoute["inboxTargetCheck"];
  consumedMessages: AgentProxyVisibleMessage[];
}

function prepareTargetCheck(
  pending: readonly AgentProxyVisibleMessage[],
  input: DaemonApiRequestBodyByRoute["inboxTargetCheck"],
): TargetCheckPlan;
```

消息类型需窄幅补齐已有真实字段的可见类型：channel_id、parent_channel_id、message_id/id、attachments/provenance 等沿用原 envelope。不要依靠 `any` 把 key 不一致问题藏掉。

### 7.2 展示 target 与选择 target 必须一致

把 `agentInboxProjection.ts` 内原 `formatInboxMessageTarget` 作为共享于该投影与新读模块的内部纯 helper 导出，或抽到同目录小模块；输出不变。

**本轮不要直接把它替换为 ledger 的 formatter。** 当前 ledger 对 `thread-<full UUID>` 的处理与通知短 ID 有差异，盲替换会造成 Agent 复制通知 target 却读不到 pending。新读模块从相同已显示 target 选择原始 message 对象，再由原消费入口根据原始 metadata 记账。

不要把用户传来的 target 强塞回消息 metadata，也不要用它直接覆盖账本 bucket；消费调用不传新的 boundarySeq。防御性查询 isMessageModelSeen 时使用**原消息经 ledger 自身 formatter 得到的旧账本 key**，不是用户复制的短显示引用；这样既能按显示 target 正确选消息，又不因两种 key 的历史差异漏查已消费记录。

### 7.3 先准备和验证，再提交消费

新路由的顺序：

1. 检查注册 token、origin、路径/method 和 request schema。
2. 仅从本 registration 的 coordinator 读取 `getAllPendingMessages()` 副本，使用与推荐相同的合格 pending 视图：过滤普通 conversation 类型，并用原 ledger 确切消费记录排除已消费成员；channel-less agent-event、Runtime profile 控制、App items 不在本轮范围。通知贡献标记不能让正文被排除。
3. 用同一投影规则匹配 target，校验内部 conversation 唯一性、metadata 和 stable ID。
4. 固定有界成员，构造 response，做 response schema 校验及 JSON 序列化。
5. 再确认 registration 仍有效、请求未中断；在不跨异步等待的短同步段中消费这些确切原始消息。
6. 写出已经验证过的响应。

准备/序列化失败、target 歧义、非法输入、oversize-first、coordinator 缺失均零消费。响应写出后的链路失败仍可能出现“已消费但工具结果没有到达模型”的不确定性，与现有 check 的 consume-on-response 风格一致；本版不伪称端到端 exactly-once，也不新增 durable claim protocol。需要可靠持久化接收者的既有 claim/ack 能力保留，HTTP finish 不是模型读到的证明。

### 7.4 增加一个小的定向消费组合 hook

在 `AgentProxyInboxCoordinator` 及 `buildAgentProxyInboxCoordinator` 中增量增加可选 hook，例如：

```ts
consumeTargetMessages?(messages: AgentProxyVisibleMessage[]): void;
```

生产新路由要求该 hook 存在；旧测试/调用方可以不提供，但此时新端点返回 unavailable，不能假装消费成功。

APM hook 做两件事：

- 复用 `consumeVisibleMessages(agentId, { messages, source: "agent_api_events_local" })`。不传 boundarySeq，继承 exact-ID 语义和 active/starting 抑制；不把 max(returned seq) 写成读过所有更早消息。
- 调一个新小 helper：仅完成这些 message IDs 对应、agent 和当前 launch/session 一致的 pending tracked mentions。复用已有 `completeTrackedMentionDelivery(context)`，以相同 occurrence 身份报告 daemon_drained/ACK；旧代次、其他 Agent、其他 message ID 不动。

该 helper 不调用 `completePendingTrackedMentions(agentId)`，不重新发送或重建 occurrence，不把任务设为 done。drained 重复确认需幂等，断线后的已有重发语义继续有效。

本版只把新定向路径接好。旧全量 events 的历史 ACK 风险可以作为独立 bug 修复，但不在这里重写整个 turn_end/重试系统。定向读取 A 不能因本次调用确认 B；之后旧 delivery 正常通知 B，是另一条合法路径，测试需区分。

### 7.5 direct/steer 与重复读取：按正文暴露事实判定

不按 runtime 名称决定是否可以读取：Claude、Codex、Kimi、omp、Cursor SDK 都可能使用直接输入通道，但通道承载的既可能是 notice，也可能是实际正文。也不要把 `consumesSpawnPrompt=true` 解释成“所有消息正文都已读”；它指 driver 承接启动输入，启动输入本身仍可能是 notice。

必须区分三种情况：

1. **仅 notice 成功写入/steer**：消息仍可通过本地定向 check 返回。重复通知由原 `recordNoticeWritten/filterUncontributedMessages` 抑制；CLI 正文读取不是第二次通知，也不是重复读正文。完整 Inbox 仍可以推荐这个尚未消费的 target。
2. **实际正文在非 transient 成功路径被登记消费**：同 message ID 不再出现在新定向读取结果或重新构建的 pending 推荐里。若同 target 还有其他新 pending，它仍可以被推荐；不能屏蔽整个 target。
3. **发送失败、deferred_to_idle、unknown 或只呈现截断片段**：不能自行升级为完整消费，继续服从现有 receipt/attempt/visibility 语义。`unknown` 不被直接当失败重新发送，本轮不改 SDK 恢复机制。

新读取器/推荐视图只复用实际 `consumeVisibleMessages`/visible ledger 消费事实；如存在遗留残余 pending，确切已消费成员可在新视图中防御性排除，不为清理它们推进游标或动全局队列。不得对所有 `hasContributedMessage` 成员一律过滤，那会把通知过但还没读的正文藏掉。

新增成对回归：busy direct notice → check 返回正文一次 → 再 check 不重复；busy 具体正文成功登记消费 → check 不返回该 ID，推荐不再引用它。再覆盖正文投递失败仍 pending、同 target 部分已读/部分新消息、thread context 与 parent 隔离、不同 runtime 相同语义。

### 7.6 不按条数乱改通知债务

本次定向读取不得调用全局 clearPending/clearTimer/clearNoticeFingerprint，也不得简单 `notifications.remove(returned_count)`。当前 pendingCount 表示通知债务，不等于消息总数，且 contributed identities 有独立语义。

继续让既有消费抑制和通知前的 prune/filter 处理余项。用 A/B 混合用例验证：A 已读取后，B 的待通知资格、SDK attempt 记录和原通知路径仍然正常。任何需要额外清理的操作必须有确切身份依据，而非全局计数推断。

## 8. CLI 修改

### 8.1 `message/check.ts`

新增 `CheckOpts` 和 `--target` / `--limit` 描述，handler 的 opts 默认 `{}`，保持既有 `.handler(ctx)` 测试调用兼容。

```ts
if (opts.target === undefined) {
  // --limit 单独出现时给出明确参数错误；不存在新增参数时完全走原分支。
  return legacyCheckExactlyAsToday(ctx);
}

// 新分支：先校验选项和 managed-runner，然后只发一个 typed 本机请求。
const result = await daemonApi.inbox.checkTarget({ target, limit });
// 使用原正文 formatter；头尾增加 target/scope/remaining 的说明。
```

实际修改不要求抽走旧 handler：保留无参分支原代码可减少回归。新分支可以用 `_targetInbox.ts` helper，禁止调用 `drainInbox()`。

输出保留原 message 正文格式和 reply target；只是目标级页头、计数和下一步提示不同。例如：

```text
Pending messages for #proj-auth:af813abc (current daemon inbox)
[现有 canonical message 格式，按顺序输出]
3 returned; 2 more pending for this target in this snapshot.
Use the same target check to continue, or message read for wider history.
```

不要把“还有一页”写成必须轮询直到永久清空的命令。无参数旧 check 的全量循环原样保留，不在本轮重排它的全文输出。

### 8.2 typed client

`daemonApiPath.ts` 在 inbox resource 下增加 `checkTarget(body)`，仍使用 `requestClientAsApiResponse`。共享 `createDaemonApiClient` 从 route contract 推导方法，检查并更新该路径相关 contract/tests，不手写 fetch、端口、token 或自建错误封装。

错误分类必须覆盖：参数错误、self-hosted 不支持、旧 Daemon 404/405、当前服务 unavailable、response schema 不符、target 歧义和 oversized message。不用“空列表成功”掩盖不支持，不自动调用 Server /events。

## 9. 提示词与知识文档

### 9.1 默认行为文案（建议）

> Raft may suggest which conversation to read first. When choosing what to inspect next, usually prioritize human direct messages (including DM threads), then human direct mentions, agent direct messages, agent direct mentions, and ordinary activity. Prefer `raft message check --target <target>` to read that conversation's pending messages together. **If the recommended conversation is unrelated to the task you are working on, finish your current step before switching.** A recommendation is not an instruction to interrupt immediately or reply to every message. A notice may have arrived without its message bodies being read. You may use full-inbox checks, history reads, search, resolve and other existing CLI tools whenever they help complete the work or answer an explicit request. Targeted checks cover the current managed daemon inbox, not complete server history.

短规则留在 standing prompt；flag、条数、unsupported、分页、是否消费等接口细节主要留在 `--help`。不使用“只有被推荐的 target 才能读”“禁止 inbox check”等措辞。

### 9.2 修改位置

- `systemPrompt.ts`：Messaging/启动行为中的默认优先路径；保留“完成当前工作”和不反复轮询。
- `raftCliGuide.ts`：命令列表、managed 模式说明、reading 段落；self-hosted 明确不支持新本地接口。
- `agentRuntimeInput.ts`：普通 notice 的推荐；对其余恢复/系统控制模式逐一审查，不机械全局替换。离线 summary 仍不是本地 pending 数据，不把历史追赶改为本地 check 后宣称已追赶。
- `manual/agent-knowledge/inbox.md`、`message.md`、`common-worked-patterns.md`、`mention.md`：区分无参全量与定向 local pending；pattern 改为优先按 conversation 阅读，保留全量范例。
- 用 `generate:raft-cli-guide` 更新 generated `raft-cli-overview.md`；更新实际 AX examples/manifests 和受影响 snapshots，不能只改生成产物。

图示日期、先前构想中的 Waiting For 和“强制单 target”不进入本版 prompt。

### 9.3 可观测性：复用 trace，不新增持久化或调度状态

在现有 `daemon.agent.inbox_update.pushed` 上记录本次实际渲染建议的 `attention.recommended_target`（没有推荐则不填）和 `attention.priority`。在既有 `daemon.agent.drain.outcome` 及新定向 check trace 上记录 `attention.check_scope=target|all`、`attention.check_target`（all 时为空）；空结果、错误、不支持也保留各自 outcome。对应挂接点见 `agentProxyInboxCoordinator.ts:38–50`、`agentCredentialProxy.ts:1399–1410,1609–1620`。

只有这两个 target 字段仍不足以精确关联跨多条通知的“下一次读取”。增加轻量 `attention.recommendation_id`，并复用 agentId/daemonInstanceId/launchId/sessionId 等现有身份；它是观测关联键，不是 selection、不授权也不影响排序。可在每个活跃 launch 保留一条有限的最近 recommendation 观测记录，重启/注销即丢弃；没有新 DB/journal，不持有消息正文、不参与调度。无记录时只报 unlinked，不能自行补配。

渲染与 trace 共用同一个纯 presentation 结果，不能在发送成功后重新 rank 得到另一 target。准备失败、写入失败不报成功推荐；SDK 仅接受写入但未确认模型看见时，把事件标作 transport-accepted，不夸大为已读。startup、idle/busy notice 都需挂接；`inbox check` 自己显示的建议记录为独立 source=snapshot，不伪装成 push。

读取请求进入时捕获最近有效 recommendation 关联；读取完成记录 scope、target、returned_count、outcome。只把首次关联的成功定向读取视为一次建议选择；失败/空读另计。新通知到来不反向改写已开始请求的关联。旧全量 check 可能分页发多次 /events，不把 50 个请求算成 50 次用户选择；本版以“每条推荐后首个匹配读取结果”的观测口径去重，不能声称它是完整的 CLI 逻辑调用追踪或因果证明。

首版指标：推荐后定向读的选择匹配比例、全量读取比例、读取错误/空结果率、返回消息数/字节数；不得把查阅非推荐 target 一律视为失误，它可能是完成当前任务所需调查。模型收益需后续观察，不在实现前承诺百分比。

Trace 中不记录正文、附件内容、token 或私密请求载荷。精确 target 只能存在于既有相同访问权限的诊断 trace；导出聚合时按部署规范散列/脱敏，target 不作为高基数 metrics label。原 trace 白名单/测试需要同步，且 trace 写入失败不得导致读取失败或改变消费。

## 10. 逐文件修改清单

| 文件/目录 | 操作 | 修改目的 |
|---|---|---|
| `packages/shared/src/agentInboxPriority.ts` + test | 新增 | 纯排序与推荐，共用于通知和 Inbox。 |
| `packages/shared/src/index.ts`、`agentInbox.ts` | 小改 | 导出新策略/类型；增加可选 attentionPriority 并更新 row key 白名单，旧字段不变。 |
| `packages/shared/src/daemonApiContract.ts` + test | 小改 | 新本机 POST request/response schema 和 route；既有 Inbox response 的可选 target_check 元数据。 |
| shared daemonApiClient / daemonApiRawClient 对应 tests | 校验/按需改 | 方法派生、诊断、旧 schema 兼容；无须创建 Server manifest。 |
| `packages/daemon/src/agentInboxProjection.ts` + test | 小改 | 复用已展示 target 规则；由每组原始 pending 聚合人类/Agent信号，latestSenderType 仅展示。 |
| `packages/daemon/src/agentInboxTargetCheck.ts` + test | 新增 | 纯 target 选择、固定有界成员与响应准备。 |
| `packages/daemon/src/agentCredentialProxy.ts` + test | 小改 | 新本机路由；scope、错误、零 fallback；调用新 hook。 |
| `packages/daemon/src/agentProxyInboxCoordinator.ts` | 小改 | 透传定向消费 hook；复用 trace sink 记录推荐关联与实际读取。 |
| `packages/daemon/src/agentProcessManager.ts` + targeted test | 局部改 | 组合现有消费与 exact-ID/current-generation mention 完成；不改调度。 |
| `packages/cli/src/daemonApiPath.ts` + test | 小改 | typed `inbox.checkTarget`。 |
| `packages/cli/src/commands/message/check.ts` + test | 小改 | 新 opts 分支，保留无参行为。 |
| `packages/cli/src/commands/message/_targetInbox.ts` | 可选新增 | 隔离新调用与错误/输出逻辑，避免膨胀原 handler。 |
| `packages/cli/src/commands/inbox/_format.ts` + test | 小改 | 推荐展示 wrapper，保留 App 组合。 |
| `packages/daemon/src/agentRuntimeInput.ts` + tests/examples | 小改 | notice 排序/建议，原通知 message 集合不变。 |
| `packages/daemon/src/drivers/systemPrompt.ts`、`raftCliGuide.ts` + tests | 小改 | attention-first 行为与 managed/self-hosted 差异。 |
| 相关 manual、generated guide、CLI 测试清单、trace 契约测试 | 同步 | 文档、观测字段与可执行行为一致；本设计文档加入 PR。 |
| Desktop/Computer/Daemon/CLI 版本与构建发行清单 | 发布改动 | 产物联动，不改 Desktop UI 或 Computer 生命周期业务；覆盖 canonical/isolated Desktop 构建。 |

这是代码落点清单，不是“所有文件大改”。真正新增业务模块为纯策略和定向读取准备，APM 只增加一个很小的消费确认组合点。测试量可能多于实现量；不以文件数冒充工时。

## 11. 合并与发布顺序

### 11.1 三个内部 PR，一个产品版本

1. **契约与底层路径**：纯策略、typed 路由、准备器、确切消费 hook、隔离/notice-body 回归。此时不发新 prompt，不改变原显示。
2. **CLI 与展示**：--target/--limit、typed adapter、排序与推荐、能力元数据和 trace。新旧接口共同工作。
3. **默认引导与发行**：prompt、help、manual/generated guide、本文、版本清单；把完整组合打入 Desktop，而不是只发布 npm 后宣布用户已升级。

### 11.2 Desktop 是当前部署的实际交付单元

已核实 Daemon `package.json:33` 构建并拷贝 CLI；Computer 依赖 Daemon；Desktop `tsup.config.ts:12–24` 内联 Computer，`electron-builder.yml:27–31` 将 CLI 作为 extraResources。用户当前部署因此要发布**新的 Desktop 版本**，使实际加载的 Computer/Daemon、注入的 CLI、提示词来自同一验证构建。新 `06b5617` 的 isolated builder 继承 canonical config 也要保留，不能漏带 CLI。

发布步骤：先构建 shared/CLI → Daemon → Computer → Desktop（以现有 workspace build scripts 的依赖顺序为准），记录源码提交和各产物版本/摘要；在隔离状态根安装测试 Desktop，分别完成 Claude Code 与 omp 的闭环；小范围人工批准灰度后，分批让所有使用内嵌版本的终端退出并重启至新 Desktop。不是所有机器必须同时停机，也不是仅重启 GUI 就必然接管到新 Runner：按现有宿主所有权规则核验实际进程。

新 system prompt 通常不能靠替换文件自动改写既有活跃模型会话。验收要启动新的 managed 会话或使用现有受控重启流程，确认 prompt 已更新；不手工删除真实会话/状态。用 `raft version`（live daemon 与 CLI 分别报告）和实际 launch/build 记录核实，不仅看 Desktop About 或 `raft --version`。`target_check` 字段是补充能力检查，不代替活进程版本证据。

独立安装 Computer/Daemon 的服务器按对应部署方式升级其产物与进程，不要求安装 Desktop；仍核对注入 CLI。这里无 Server/DB 迁移，也没有自动授权执行全员重启。本设计阶段不发布、不安装、不重启生产。

### 11.3 混合版本和回滚

保留可选 `target_check` 能力字段与可兼容的 `attentionPriority`。验证：旧 CLI+新 Daemon（原命令可用）、新 CLI+旧 Daemon（字段缺失时不建议新能力；手动新命令明确 unsupported，零全量回退）、新 CLI+新 Daemon（完整路径）、self-hosted（旧行为正常）。旧全局 CLI 被错误地从 PATH 选中时，按现有 wrapper 诊断恢复，不能自动执行全量读取补救。

回滚时回到已知可用的整套 Desktop/内嵌产物和受控进程，不只降一个 CLI。无 DB 回滚，已经返回并消费的正文不恢复 unread，不重放业务副作用。

## 12. 验收矩阵

### A. 推荐

- 人类 DM > 人类直接 @ > Agent DM > Agent 直接 @ > ordinary；同一发送者类型的 DM thread 与 DM 同级。
- 人类 DM 后追加 Agent 消息，组仍为 human_dm；Agent @ 后追加人类 ordinary，不得误变 human_mention；人类 @ 被消费后只剩 Agent @，等级必须降低。
- latestSenderType 与组内最强信号冲突时按原始消息事实；未知 sender、system、third_party_app 不被猜成人类；旧缺字段响应不崩溃。
- 只带 task flag 不自动提权；原始内容中的 @/urgent 不参与策略。
- 同级 firstPendingSeq 稳定；未知 seq、空 rows、未知 flags 不使整个 Inbox 失败。
- suppressed-only 留在列表但不推荐；App items 保留原字段/动作；合成 DM 下的特殊事件不被错误推荐到新读取器。
- 旧 Daemon 缺少 target_check 元数据：完整列表正常，不打印未获支持的定向读取建议；旧 CLI 忽略新可选字段。
- 推荐来自本次实际候选；不得把 delta 说成完整 Inbox；原消息候选集合、计数和通知次数不变。

### B. 定向读取

- target A/B 各有多条消息，check target A 返回 A 同 conversation 多发送者消息；target B 不消费。
- **Agent 隔离硬门槛**：Agent A 用自己的 token 指定仅在 Agent B pending 中存在的 target，B 正文不泄露、B 消费/ACK 零调用；两 Agent 都有相同显示 target 时，A 只消费 A 自己的 pending。
- body 伪造 agentId/serverId/launchId 被 strict schema 拒绝，伪造身份 header 不覆盖注册；无效/撤销 token 拒绝，消费前身份替换不影响新会话。
- Channel 与子 thread、两个 sibling thread、DM 与 DM thread 严格分开。
- 通知里的短 thread target 可直接使用；full UUID 形成的 metadata 不造成空读；短 ID 冲突零消费报错。
- active/starting 出现同 message ID 只输出一次并正确抑制两份；无合法 ID/metadata 的候选不伪造已读。
- 本地没有 A 而有 B：返回 A 的 local empty，Server /events 请求数为零；本地完全空仍不 fallback。
- 新请求处理期间到达 A 新消息：不被本次确认；下一次可读。
- 多于 limit/预算：只消费完整返回成员，remaining 针对该 snapshot；oversized-first 零消费。长代码块、中文/emoji 多字节、JSON 转义、多个附件元数据均按实际序列化字节控制，字节上限优先于 50/200 条数。
- non-member mention 只获得已经授权投递内容，不自动查历史、join 或获得发送权。
- channel-less event、App items、runtime control 不被误收进普通 conversation 批次。

### C. 确认与故障

- 定向读 A 后只完成 A IDs 的当前 generation tracked mentions；B 不被本次 hook ACK。
- A 在 busy 时被读走，到 turn_end 时 A 不需要再次出现才确认；重复回执幂等。
- 旧 token/旧 launch/session/另一个 Agent 不可消费当前 Agent 的消息。
- 不调用 agent 级 complete-all、不全局清通知债务；A 读取后 B 仍可正常被原路径通知。
- exact-ID 消费不推进 max seq 高水位，不把较早未读内容埋掉。
- 参数、准备、schema、序列化失败零消费；响应后断线的不确定性不伪装 exactly-once，不自动全量重试。

### D. Runtime/可见性回归

- busy steer 只含 notice、不含原正文：contributed=true 但仍 pending，定向 check 必须能返回该正文，第二次不再返回已读 ID。
- busy 正文实际成功并登记消费：定向 check 和新推荐均排除已消费 ID；同 target 的其他新消息仍可用。
- 发送失败、deferred_to_idle、unknown 不被本版误标已读；transient 和 runtime control 保持原路径。
- 回归 omp 的 `consumesSpawnPrompt`、握手后首个 prompt、`isRunInProgress=false`；不重复注入启动正文、不把原生已结束 turn 永久当作 busy。

### E. CLI 与行为

- 无参数 message check 的现有输出、has_more drain、errors 全回归。
- `--limit` 单独出现明确错误；空 target/负数/小数/超限被拒绝。
- 新命令错误不转化成“无工作”；shared client 错误仍有原诊断，日志不含正文或密钥。
- 原 read/search/resolve/claim/ack 可用，不因推荐 A 禁止查询 B。
- prompt/manual/help 同源一致；模型没有因新默认而被要求回复每条 ordinary 消息。
- **分别在真实 Claude Code 与 omp 上各做一次**：A/B 混合通知 → 看到人类优先推荐 → 对 A 定向 check → A 完整小批返回 → B 仍 pending → 无参数全量 check 仍可读取 B。Claude Code 覆盖 stdin 通道，omp 覆盖 RPC；真实协议通过不等于提示词有效，需要保留模型实际选择的 trace。
- 重复相同输入的若干小样本，并记录“当前任务与推荐无关”的对照；合理的继续当前步骤或跨频道调查不能判为违规。无新 API 的旧模型结果不能冒充本版 E2E。

### F. Trace/发布回归

- 文本里实际推荐 target 与 trace recommended_target 一致；失败发送不报成功；target/all/empty/error 都有可区分的读取记录。
- 两条通知夹着读取请求时关联不乱配；全量 check 多页不膨胀采纳次数；旧 launch 的 trace 不归因给新 launch；trace 失败不影响业务。
- Desktop 包含匹配的内嵌 Daemon 与 CLI；canonical 和 isolated builder 均带 CLI；重启后 live daemon、实际调用 CLI、prompt 均为新版本。
- 以上验收使用隔离状态根/mock 凭据；真实协议测试需明确授权的测试账户，不触碰现用工作队列。

## 13. 开发验证命令与本次实际验证

开发阶段按修改文件执行 shared/CLI/Daemon 的隔离测试。不要直接在用户生产状态根执行 APM 全量测试、真实浏览器登录、安装/重启或带真实凭据的网络验证。沿用仓库已有隔离测试准则和假 RuntimeSession。

本次在新的 `06b5617` 基线实际执行：

```bash
CI=1 pnpm --filter @botiverse/raft-daemon exec vitest run \
  src/agentInboxProjection.test.ts src/agentVisibleDeliveryLedger.test.ts \
  src/runtimeNotificationState.test.ts --maxWorkers=1 --minWorkers=1

pnpm --filter @botiverse/raft-shared exec node --import tsx --test \
  src/agentInbox.test.ts src/daemonApiContract.test.ts
```

第一组 **42 pass / 0 fail**（投影 22、通知状态 15、visible ledger 5）；第二组 **17 pass / 0 fail**；合计 **59 项通过**。shared 测试出现 Node module.register 弃用警告，未影响通过。设置 CI=1 是因为当前 Daemon vitest 配置在非 CI 下会自动更新快照，本次没有更新快照。

上述是现有基础测试，不是新方案已经实现的证明。APM 中 direct busy notice 的相关现有断言做了静态核对，但没有把整个 APM 套件或真实 SDK 运行起来；新权限用例、人类聚合优先级、定向端点、trace、混合版本和 Claude Code/omp 两次真实 E2E 都是实施后的验收项，当前尚未执行。

本次没有修改业务代码、没有 fetch/pull/切分支、没有发布或启动/停止 Computer/Daemon、没有改动既有 mobile 本地修改。只更新此设计文档；它仍是待开发者纳入 PR 的 untracked 文件。

## 14. 对本轮反馈的逐项回复

### F0：新 dev 与 omp 变化

**接受，以实查结果校正说明。** dev/origin/dev 同为 06b5617，恰好比 5021cf0 多 23 提交。APM diff 是 5 insertions / 1 deletion 的 `isRunInProgress` 判断；consumesSpawnPrompt 属于 driver/types/debt 文件的相关提交。两者都保留，不能从旧基线复制文件覆盖。详见 §2.1。

### F1：Agent token 与 target 权限边界

**接受，升级为上线硬门槛。** target 只筛选注册 Agent 自己的 pending；新增 A token 读取 B-only target 零泄露/零消费，以及相同 target 在 A/B 两个 Inbox 中仍隔离的测试。伪造身份字段、header、旧 token、launch 切换全部覆盖。详见 §5.0、§12.B。

### F2：人类 DM/@ 与 Agent 私信的优先级

**拍板采用：人类 DM → 人类 @ → Agent DM → Agent @ → 普通。** 不是仅在同级内人类优先，因为那仍会让 Agent DM 压过人类 @。但不直接使用 latestSenderType：新增按合格 pending 消息聚合的 attentionPriority，sender 和 mention 来自同一消息。latestSenderType 仍只描述最新一条；不加 LLM 判断闲聊或紧急程度。详见 §4。

### F3：跨 conversation 比较 seq 的前提

**已核实，可以保留 seq 同级排序，但修正“严格时间单调”的措辞。** messages 表共享 bigserial 序列，系统消息使用同一个 nextval；同一注册 Server Inbox 内可跨频道比较。序号有缺口且不等于提交/到达时间，不拿它推进读取或 ACK 边界。注释、数值安全、缺值兜底、跨部署不比较写入 §4.2。

### F4：direct/steer 进去后是否应该在 check 中排除

**接受防重复目标，但不能按原表述一律排除。** 当前主 busy 通道 steer 的是 content-free notice；contributed/transport delivered 不等于正文已读。排除所有 steer 过的 ID 会让真正未读正文无法 check。已完整暴露且登记消费的正文必须排除；只通知过的正文必须保留。新增正反两组用例，并覆盖同 target 部分已读、失败/unknown 和 omp 启动语义。详见 §2.2、§7.5、§12.D。

### F5：推荐 target 与实际读取的可观测性

**接受。** 在现有 trace 增加 recommended_target、check_scope、check_target；加轻量 recommendation_id 和现有 launch/session 身份关联下一次读取。不新增持久化；最多每活跃 launch 一条短期观测记录，不控制工作流。区分 target/all、空读/错误、HTTP 多页和合理的主动跨 target 查询，不把相关性当因果效果。详见 §9.3。

### F6：避免推荐让 Agent 立即切换上下文

**接受，写进默认规则和动态通知。** 明确“推荐会话与当前任务无关时，可以先完成当前步骤再切换”；保留全部读取工具。新推荐是默认阅读顺序，不改变 busy 时机、不要求每条回复。详见 §3.1、§9.1。

### F7：Desktop 发布与全员重启

**接受并落到实际交付流程。** 本环境需新 Desktop 携带匹配 Computer/Daemon/CLI 和 prompt；经过 Claude/omp 隔离验收后，所有内嵌版本用户分批受控重启，不要求全员同时停机。核验 live daemon、实际 CLI 和新会话提示词；独立服务器走各自 Computer/Daemon 部署。保留 target_check 混合版本元数据。详见 §11。

### F8：测试建议

**全部纳入。** managed 闭环、DM thread、短 ID 冲突、本地空时零 Server /events、只确认返回 IDs、Claude Code 与 omp 分别实测，都写为实施验收。另补当前反馈发现的 notice-vs-body 双向回归、混合 sender 聚合与 Agent token 隔离。本次 59 项只是现有基础回归，不代替这些新测试。详见 §12–13。

### F9：方案文档不在 dev

**核实：文件在当前作者工作区但未被 Git 跟踪，所以远端 dev 没有它并不矛盾。** 当前路径不变，本文是更新后的完整独立方案，可直接作为外部评审附件，不依赖远期 attention-v1-design.md 才能理解。实施 PR 需显式把本文件加入版本控制。本轮不擅自 commit/push。

### F10：默认条数、附件与长代码块

**接受。** 默认 50、上限 200，最终受 256 KiB 初始响应预算限制；按序列化 UTF-8 计量，附件元数据、JSON 转义、代码块、多字节字符都计入。大文件不内联；超限只返回完整前缀，第一条就超限则零消费并提示已有定向全文入口。不会静默截断后当成读完。详见 §5.3。

## 15. 补充证据索引

均相对当前仓库根；行号以 06b5617 为准，实施再次更新时应复核。

- [C1] `packages/daemon/src/agentInboxProjection.ts:73–151`：分组、latestSeq、flags、最新发送者与 target。
- [C2] `packages/daemon/src/agentCredentialProxy.ts:410–420,490–494,575–590,1357–1420,1704–1714`：token 隔离、本地 events、fallback、注销。
- [C3] `packages/daemon/src/agentProcessManager.ts:2027–2084,4288–4322,4582–4614`：pending 消费、mention、omp 原生状态。
- [C4] `packages/server/src/db/schema.ts:1676–1680`；`packages/server/drizzle/0000_lyrical_arclight.sql:67`；`packages/server/src/services/messageService.ts:2011–2032`：共同 seq 与预分配。
- [C5] `packages/daemon/src/agentRuntimeInput.ts:198–217`；`packages/daemon/src/agentProcessManager.ts:8055–8104,8165–8307,8315–8428`：notice / body 不同路径。
- [C6] `packages/daemon/src/agentProcessManager.codex.test.ts:6041–6193`：direct busy/idle notice 保留正文 pending 的现有断言。
- [C7] `packages/daemon/src/runtimeNotificationState.ts:55–84,141–180`；`packages/daemon/src/agentVisibleDeliveryLedger.ts:78–114,155–224`：贡献标记与消费账本不同义。
- [C8] `packages/daemon/src/agentProxyInboxCoordinator.ts:38–50`；`packages/daemon/src/agentCredentialProxy.ts:1609–1620`：现有 trace/drain hook。
- [C9] `packages/daemon/src/drivers/omp.ts:739–754,907–930,998–1002`；`packages/daemon/src/drivers/types.ts:489`；提交 `97d78bb`：omp 启动与原生 run 状态。
- [C10] `packages/daemon/package.json:33`；`packages/computer/package.json`；`apps/raft-desktop-electron/tsup.config.ts:12–24`；`apps/raft-desktop-electron/electron-builder.yml:27–31`：内嵌发布链。
- [C11] `packages/shared/src/daemonApiContract.ts:54–67,111–118,214–274`；`packages/cli/src/daemonApiPath.ts:163–194`：增量本机 contract/client。
- [C12] `packages/daemon/src/drivers/raftCliGuide.ts:1–38`；`packages/daemon/src/drivers/systemPrompt.ts`；`packages/cli/AGENTS.md`：文案唯一源与 CLI 边界。

PostgreSQL 一手参考（本轮查阅，用于说明序列语义；不用于代替仓库核实）：

- [E1] Numeric Types / Serial Types：https://www.postgresql.org/docs/current/datatype-numeric.html
- [E2] Sequence Functions / CREATE SEQUENCE：https://www.postgresql.org/docs/current/functions-sequence.html ；https://www.postgresql.org/docs/current/sql-createsequence.html

## 16. 最终收敛

这个合并版的名字可以是 **“推荐优先级 + Target-scoped Check”**，不叫“完整 Attention Scheduler”。

它把默认行为从“看完整 Inbox 再自己调度”向前推进为“平台建议先看一个 conversation，Agent 有现成的工具把这个 conversation 的 pending 一起读出来”。所有旧能力仍在，系统仍按原有运行时生命周期工作。

未来 Focus、Busy 降噪和安全边界单 target 自动派发，都可以复用本轮纯排序、target 投影和 exact-ID 读取；但本轮是否能上线，不再取决于它们是否完成。
