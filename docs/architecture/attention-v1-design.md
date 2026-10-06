# Raft Attention V1：源码核查与可实施设计

- 日期：2026-10-06
- 状态：设计建议；本文没有实现 Attention，也不代表生产验收完成。
- 核查基线：`5021cf090e2b2a0553d2868e044f1c7ddb5c0ad0`。
- 范围：Server 投递/恢复、Daemon APM/Inbox/代理、CLI 读取、共享契约、运行时输入与系统提示词。
- 验证：直接阅读与调用链交叉搜索，并对独立只读复审的结论回到原代码复核；运行 2 个现有 shared 纯函数测试文件，16 项通过、0 项失败；另用真实 ledger 类完成 1 次纯内存键不一致复现。未运行真实模型、Server 集成或生产服务测试。
- 文中 `[Sxx]` 对应末尾可定位到当前工作区的源码证据。所有新增命令、字段、模块和默认值均为建议，不是现有功能。

## 1. 执行结论

建议把 Attention 做成 **Daemon 内的一层确定性推荐与自动投递策略**，同时提供新的 CLI 读取路径及 attention-first 提示词。保留 Node.js 技术栈，不重写 APM，不把它升级成完整任务调度器，不建立新的分布式消息系统。

最小闭环是：平台从真实 pending 消息中按 conversation target 聚合；根据当前 focus 和 runtime 的安全输入窗口选择一个 target；自动通知与主动读取引用同一个 selection；读取返回该 target 的有界消息批次；已有 CLI 全量读取、历史读取和搜索继续可用。

它能够控制 **平台主动给什么、默认推荐什么**，不能也不应保证模型永远不看其他信息。跨 target 阅读可能是在为当前任务查资料，不是自动违规。

核心不是一个优先级排序函数。上线前必须一并处理 Focus 的事实来源、所有投递入口、target 级 ACK/消费范围、延迟投递的保留与恢复、CLI 契约和提示词一致性。

## 2. 需求冻结：用户已表达的决定与本报告建议

### 2.1 用户已确认的产品边界

1. 第一期不做 Waiting For，也不从自然语言猜测等待关系。
2. DM 的优先级高于普通直接 @mention；普通频道活动更低。
3. 忙碌时关注当前工作相关信息，其他消息可以延后；idle 时按优先级挑选。
4. 调度单位是 DM/channel/thread target，不是孤立的 message。触发可能只有一条 @，读取/正文投递必须考虑同 target 的其他 pending 消息。
5. Push 和 CLI Pull 都要支持 attention；不能只过滤通知而缺少匹配的读取入口。
6. CLI 保留不同读取方式和完整能力；提示词应引导 attention-first，而不是 attention-only。

### 2.2 为落地而补充的建议

以下是本报告的工程选择，不冒充用户已经指定：

- 首版执行策略先覆盖 daemon-managed Agent；self-hosted/external CLI 不强行接入一个没有 runtime 状态来源的远程 Scheduler。
- busy 时，当前 exact target 的增量可优先进入安全输入窗口；不相关 DM 与 @ 都在下一安全回合边界排序，DM 在前。高优先级不是强行杀掉进程。
- idle 排序采用 `DM（含 DM thread） > 直接 @ > 明确指派给自己的任务 > 普通活动`。任务项只有可靠的当前指派事实才升级；不能仅凭 task_number。
- 先把 Focus 做成“当前执行上下文对应的 conversation target”，不宣称已掌握 Agent 所有在办任务或跨频道语义关系。
- 默认自动路径采用单 target 的通知加 CLI 正文批量读取；既有必须携带正文的 wake 路径使用同一批次构造器。通知本身不冒充正文已读。
- 旧 CLI 的默认消费与输出顺序保持兼容。全局列表的 attention 排序/标记作为显式选项，不静默改旧脚本结果。

## 3. 源码排查：真实现状与需要修正的认识

### 3.1 当前不是“所有正文一股脑注入”

`formatInboxUpdateRuntimeInput` 明确生成 content-free notice，列出 target、pending 数量等，再引导模型用 message check/read 读取。`deliverInboxUpdateViaStdin` 只有部分 thread-join 情况附带正文；普通情况仍是 notice。[S01]

真正要改善的是：**通知候选仍可能跨多个 target，什么时候读及优先处理什么主要由模型选择**。因此不能把增加 target grouping 描述成从零增加分组，也不能把通知写入成功当成正文已交给模型。

### 3.2 已有按 target 投影，但没有所需的排序

`projectAgentInboxSnapshot` 已按可见 target 分桶，记录 DM、thread、task、mention 等 flags；返回结果按 latestSeq 降序，而不是 DM > @ 排序。Attention 可以复用投影思想，但需要新的 policy 输入和排序规则。[S02]

只从聚合后的 `latestSender` 推优先级不够。应遍历该 target 当前仍 pending 的消息，取最强有效信号；某条 @ 已被其他 CLI 读走后，不能让整个 target 永久保持 mention 等级。

### 3.3 Current Focus 尚无可靠的现成存储与生产者

在本次核查的 AgentConfig、APM、生命周期记录和 CLI 契约中，没有 currentFocus/attention selection 的完整实现。现有 task_number/task_status 是消息携带的任务投影，不等于 Agent 正在处理该任务。部分 runtime event 的 taskId 是原生子 Agent/工具事件的标识，也不能当成 Raft taskId。[S03]

不能用“最后读过的频道”“最后一条到达的消息”或“最后一次 task claim”自动覆盖 Focus；读其他频道可能只是查资料，一个 Agent 也可能持有多个任务。

### 3.4 busy/idle 是运行时事实，不是任务完成事实

当前有 session readiness、busy-delivery readiness、compaction/review gate、turn_end 等控制。`turn_end` 会触发 pending flush，但没有证明整个业务任务已经完成。[S04]

方案采用它作为可调度的运行时边界，不把它写成 task done。第一版不提供跨多任务的自动暂停/恢复栈；跨回合长期任务仍依靠既有会话、任务记录和 Agent 行为。

### 3.5 投递入口不止 deliverMessage

除新消息的 idle/busy 分支，还有启动时 wakeMessage、startingInboxes、resumeMessages；runtime clean close 后选一条 queuedWakeMessage 并缓冲其余消息；compaction/review 结束；错误退避到期；session-ready retry；无进程状态再启动。[S05]

如果只在 `deliverMessage` 的通知 timer 前加筛选，其他路径仍会把所有 target 带回模型。

### 3.6 当前全局计数和全局 mention ACK 不能原样用于单 target 投递

`executeApmGatedSteeringEffect` 取整个 ap.inbox 并清全局 pending notification 状态。turn_end 一旦该 effect 返回成功，会调用 `completePendingTrackedMentions(agentId)`，后者遍历此 Agent 的所有 pending tracked mention。[S06]

这些代码在现有整体 flush 语义下工作；**如果只把消息选择改成单 target，却保留全局清理/ACK，会把其他 target 的债务抹掉或误报已投递**。这属于迁移时必须防止的新回归，不是本文已经复现的现网事故。

### 3.7 CLI 全量读取确实是另一条完整消费通道

`message check` 调 `drainInbox`，后者循环请求 events，默认最多 50 轮，收集结果后按 seq 排序。它不是只显示通知，也不是天然按 target 限定。`message claim/ack` 是另一个已有显式确认路径。[S07]

`message read` 是 history 接口，并维护本地 freshness cursor；`--around` 特意不推进该本地 cursor。`inbox check` 不读正文、不 drain，但目前只支持 managed-runner，还包含 App items，不能把它简化成只有聊天消息的列表。[S08]

### 3.8 Managed CLI 有本地源和 Server fallback，不能先 drain 再过滤

credential proxy 优先从 Daemon 的全部 pending 返回 `/events`；本地没有 pending 时返回 undefined，再进入 Server 路径。返回本地 events 前会记录 exact-id 消费。Server 的 drain 模式也会在返回前做 ACK。[S09]

因此新 `attention read` 不能实现为“调用旧 message check，然后过滤到目标”。那样其他 target 已经被消费了。也不能只在本地过滤，fallback 仍请求无 target 的 drain。

### 3.9 现有 ACK、exposure、freshness 不同义

`AgentVisibleDeliveryLedger` 对稀疏事件默认只记录 exact IDs。只有受信任的连续内容消费来源可推进 target 高水位。Server events 的兼容 ACK 在缺少某 capability 时还会推进 legacy per-channel checkpoint。[S10]

一次选中了高 seq 的 @，不代表该 target 中更早的消息全部看过。`throughSeq` 只能用作选批快照边界，不能直接赋给 seenUpToSeq。

### 3.10 长时间静默延迟会遇到 Server retry budget

当前 tracked mention 重发从 5 秒指数退避，最长间隔 5 分钟，最多 24 次；最终会持久化 RETRY_EXHAUSTED。现有 daemon_pending transition 会写状态，但对应 handler 并不同时清理待 ACK 的重试跟踪。[S11]

因此“已接收、只是等 Agent 有空”不能无限被当成“链路未送达”重试；也不能为停止重试而提前冒充 daemon_drained/最终 ACK。

### 3.11 Inbox 并非一个无限、全量、持久化的数据库

本地 APM Inbox 是进程内队列；Server 的内存 Inbox 当前超过 1000 条会移除最早元素。Server 消息历史、通知资格、持久化 mention occurrence、各类 cursor 和缓存是不同存储层。[S12]

此前“所有消息都在 Inbox，Queue 只是投影”的说法要加限定：Scheduler 只能操作 **有权接收且实际 pending 的消息**，不能凭空恢复被 mute/unfollow 的正文，也不能把缓存当作长时间延迟的可靠存储。

### 3.12 attention_hint 不是 Waiting For 或完整 Scheduler

存在 AttentionDependencyOracle、hint schema 和测试。本次对生产源文件的搜索没有发现 evaluator 的实际调用链，也没有发现 directedOpenAsk/awaitedReview 的可靠运行时生产者。[S13]

可保留现有 hint 兼容，但 V1 不依赖它来判断 Focus、等待状态或优先级；不能仅因字段存在就宣称整套 Attention Hygiene 已经上线。

### 3.13 提示词需要修改唯一生成源，而非只加一段新话

`systemPrompt.ts` 负责 managed standing prompt；`raftCliGuide.ts` 同时生成共享操作指南和 `manual/agent-knowledge/raft-cli-overview.md`，后者明确禁止手工改。另有动态 inbox notice、startup/resume 文案、人工维护的 inbox/message/common-worked-patterns 文档。[S14]

目前 Messaging 文案让模型自行决定什么时候读取，startup 还可能先对 concrete incoming message 作回应。增加 Attention 后应统一默认路径，避免旧文案继续引导全量扫描或只针对 trigger 抢先答复。

### 3.14 现有风险：CLI 消费与 tracked mention 完成未统一

源码显示：busy tracked mention 置为 pending；CLI 本地 events 消费它会从 ap.inbox 移除，但 consumeVisibleMessages 没有对应地结算 tracked occurrence。若 turn_end 时 inbox 已空，则不产生 deliver_stdin effect，也不会进入当前的 completePendingTrackedMentions 调用点。重推又可能命中 duplicate_pending。[S06][S09][S20]

这是有完整静态调用链支持的风险，尚未运行完整 APM 故障复现；不能说在任何后续事件下都永远不 ACK。正确修复是按实际消费/投递成员结算其对应 tracked occurrence，不是在无 effect 时把所有 pending mention 全部 ACK。

### 3.15 已复现的局部缺陷：third-party event target key 不一致

真实 `AgentVisibleDeliveryLedger` 中，lookup/suppress 侧的 formatAgentMessageVisibleTarget 会把 third_party_event 映射为 agent-event；记录侧的 formatProxyVisibleMessageTarget 没有这个分支。[S10]

本次纯内存夹具同时具有合法 message_id、seq 与 third_party_event.id。实际记录 target 为 `dm:@system`，查找 target 为 `agent-event:12345678`，`shouldSuppress=false`、按查找 target 的 `isModelSeen=false`。这证明键不一致；未据此推断生产全部 third-party events 的端到端结果。

建议独立修复共享 target/id 归一化并加回归。Attention V1 排除这类事件的普通调度，不等于可以把共用 ledger 中该问题忽略或顺手当 ordinary 消息分桶。

### 3.16 现有风险：启动缓冲已 ACK、失败后仍未交付

delivery-during-start 分支会在 bufferDuringStart 后 completeTrackedMentionDelivery，代码自身备注了 start 失败后已 ACK occurrence 不会重新报告。取消/失败与 starting buffer 清理因此要一起审查。[S05][S20]

Attention 引入更长的等待后会扩大这个窗口；必须在可恢复保留后才能发 deferred receipt，不能把“排进启动缓冲”冒充正文已交付。不能简单把所有启动失败都发 terminal error，因为 terminal error 可能终结 Server obligation；可恢复失败应保留/rebind 该 obligation。

### 3.17 恢复提示词存在不同于常规 notice 的模式

formatResumeUnreadSummaryPrompt 明确要求一次性追赶列出的频道，并禁止该模式调用 message check；但它并非无条件禁止回复：发现直接请求/指派/@等时允许转入 active handling。formatResumeEmptyPrompt 另有“无消息便停止”的文案。[S21]

Attention-enabled 路径要改成按目标有界追赶和清楚的空状态说明，同时保留“不因旧历史自动群发回复”的意图。不要把所有旧禁令统统删除，更不能把 reviewer 的摘句当成完整逻辑。

## 4. 目标边界与组件职责

### 4.1 控制面分工

- **Server**：身份、权限、消息与通知资格、任务投影、可恢复的 pending/mention obligation、target 解析。不是第二个读取 runtime busy 状态的 Scheduler。
- **Daemon / APM**：Attention 的唯一活动决策者；知道当前 runtime 和安全输入窗口。协调 Focus、target 候选、批次、retry、CLI 消费反馈。
- **CLI**：保留能力；新增 attention 优先入口。自身不猜优先级，不私自建立另一份 Focus 缓存。
- **Runtime adapter**：在实际支持的窗口发送 notice 或正文；拒绝时保留债务。它不决定 DM 和 @ 谁优先。
- **提示词**：解释默认 attention-first 行为和允许的主动查阅；不承诺强制隔离全部模型注意力。

建议新增四个内部模块，而不是一个新服务：

`attentionPolicy.ts`：纯函数，classify/rank/eligible。

`attentionCoordinator.ts`：每 Agent 的 Focus、selection、触发时机、代次与单个 in-flight 派发。

`attentionBatch.ts`：target 解析后构造批次、冻结成员、分页、输出。

`attentionReceipts.ts`：确切成员的 notice/read receipt、延迟保留及恢复。与现有 visible ledger 和 attempt ledger 通过小接口衔接，不复制它们的含义。

### 4.2 先覆盖哪些对象

首版覆盖普通 channel/private/joint、channel thread、DM、DM thread 的消息注意力。Joint 必须使用当前 Server 已授权的本地 conversation 投影。

App Inbox、third-party agent-event、runtime profile 控制、stop/restart/shutdown、认证失败继续走各自现有控制路径。它们不是普通低优先级 channel。第一版不重写 App ACK 或把所有不同义的事件塞进一个消息优先队列。

self-hosted/external Agent 继续使用现有 CLI。新 attention 命令遇到未支持环境返回明确 unsupported，而不是返回“没有工作”。没有 runtime 状态上报就不提供伪造的 busy/idle 调度。

## 5. 数据模型与 Focus 生命周期

### 5.1 Target 身份

内部聚合键采用已授权本地投影的 `serverId + conversationId`；在当前结构中 thread 自己也是一个 conversation/channel，不与 parent 合并。

对 Agent 展示并接收现有 DSL：`#channel`、`#channel:shortid`、`dm:@handle`、`dm:@handle:shortid`。名称变化不应导致内部拆成两个队列；handles/DSL 的权威解析与鉴权留在 Server，遵守 CLI AGENTS.md。[S15]

DM thread 继承 DM 优先级，但正文只读取该 DM thread；channel thread 只读取该 thread，必要时附一个 root message 作为上下文，不附父频道全部 pending。

### 5.2 建议契约（示意，不是已存在代码）

```ts
type AttentionClass = "dm" | "mention" | "assigned_task" | "ordinary";
type AttentionTiming = "safe_point" | "turn_boundary" | "idle";

type Focus = {
  targetKey: string;
  displayTarget: string;
  source: "scheduled_input" | "explicit_focus";
  revision: number;
  launchId: string;
  processInstanceId: string;
  // 只标识当前执行上下文；不是任务完成状态。
};

type AttentionCandidate = {
  targetKey: string;
  displayTarget: string;
  priorityClass: AttentionClass;
  focusRelated: boolean;
  triggerMessageIds: string[];
  pendingCount: number;
  firstPendingSeq?: number;
  oldestPendingAt: string;
  timing: AttentionTiming;
  reason: string;
};

type AttentionSelection = {
  id: string;
  targetKey: string;
  displayTarget: string;
  focusRevision: number;
  policyRevision: string;
  ownerEpoch: string;
  reason: string;
};

type AttentionBatch = {
  id: string;
  selectionId: string;
  throughSeq?: number;       // 仅快照截点，绝不是已读高水位
  memberMessageIds: string[];
  returnedMessageIds: string[];
  remainingCount: number;
  nextCursor?: string;
  coverage: "pending_snapshot" | "partial";
};
```

候选是 Inbox 的投影，不复制正文。Selection 表示当前推荐/选中的阅读对象，不表示该对象已处理。Batch 表示某次固定读取/投递的成员，不能每次重试偷偷换成新的未读集合。

### 5.3 Focus 从哪里来

默认来源是 Scheduler 选择并实际被 runtime 接受的输入 target。启动失败或 SDK 拒绝输入不能提前提交新的 Focus。启动积压跨多个 target 时先选一组，再构造启动输入，不能沿用所有 startingInbox 作为同一 turn 的业务输入。

提供一个显式纠偏操作作为新增小能力：`raft attention focus --target <target>`，用于 Agent 或外部调用方明确说“现在改为处理这里”。它不读取、清空、claim 或完成任务；鉴权失败不更改状态。可另有 `--clear`，互斥参数在 help 中定义。

不得因 search/read/send 的目标不同就自动切 Focus。普通跨频道调查不会改掉当前工作。

没有明确来源时 Focus 为 unknown。此时不凭猜测给普通消息 busy interrupt 资格；DM/@ 保持下一边界优先。Feature 首次开启到已有 turn 上也采用 unknown，下一次有效输入再建立。

### 5.4 Focus 何时失效

代次变化、显式 stop、reset、替换会话、迁移到新执行拥有者必须撤销旧 selection 的控制效力；旧 handle 不可指向新 Agent 实例。正文 pending 不因撤销 selection 被当成已读。

turn_end 只是当前执行回合的安全边界。可以保存 lastFocus 供展示/恢复，但 idle 排序不因为“上一次做的是 A”而永久压过 DM。新 target 被接收后才替换活动 Focus。Task 是否完成仍由现有 task 机制决定。

## 6. 调度策略：把优先级、时机和 runtime 能力分开

### 6.1 busy：先判当前上下文

同一个已确认 exact target 的新消息：进入 `safe_point` 候选，批量合并。这个名字比 INTERRUPT_NOW 更精确：代表尽快在 runtime 可接受的新输入窗口送达，不代表 kill、强制取消正在执行的工具或开启第二个并发 turn。

不相关 DM / DM thread：`turn_boundary`，类别 dm。

不相关直接 @：`turn_boundary`，类别 mention。只有 Server 给出的 mentioned/non_member_mention 等受信任元数据作为证据，正文里“@某人”“紧急”“我是老板”不提升权限或优先级。

明确分配给自己的任务：`turn_boundary`，类别 assigned_task。task_status 存在或 task_number 非空不足以证明新指派；如果缺少可验证的 assignment 事件/当前 assignee，则按其已有 DM/@/ordinary 事实排序。

其余普通活动：`idle`，不为它启动 busy notification timer。

同 task 跨频道关系不在首版默认强规则中：先依赖 exact target；后续有权威 task→conversation 关联后才添加。相同 task_number、同父频道不构成因果证明。

### 6.2 idle/turn boundary：一次选择一个 target

无已启动的用户显式输入和必须先处理的系统控制时，排序为：dm、mention、assigned_task、ordinary。相同类别按最早 pending 时间/seq，再按稳定 target key 决胜，而非最新活动越多越优先。

target 的类别取仍 pending 消息中的最强信号，重新计算，不能把历史 @ 永久粘在 target 上。被同一次全量 CLI 消费掉的候选应立即消失。

严格 DM 优先在持续 DM 洪水下可能延迟普通频道。本版不声称有最大等待时间保证；监测 oldest pending age，并提供可配置的 idle 公平性参数作为后续调优。不能用强行打断正在工作来解决普通队列饥饿。

### 6.3 不绕过已有安全门

session 未 ready、compaction/review 不接受输入、SDK busy gate 关闭、sticky error、rate limit backoff、explicit stop 都优先于 Attention 的发送建议。

`unsupported` 保留为边界待办；`deferred_to_idle` 恢复本批仍未消费成员的债务；`unknown` 不等于失败，不立即重发产生并发副作用。继续使用 RuntimeSession/RuntimeProcessBindingFence/RuntimeDeliveryAttemptLedger，而不是平行实现一套 SDK 可靠性逻辑。[S16]

### 6.4 合并但不无限通知

同 target 短窗口内的更新合并；可复用现有计时器作为首批合并窗口。3 秒是当前普通 busy notification 默认值，不是证明最优的新参数。[S17]

相同 ownerEpoch、selection、pending revision 已通知且没有新成员时，不因普通 turn_end 重新通知一次。一次只允许一个平台自动派发计划 in-flight。有新的确切消息，或一次有记录的原生投递失败/回退，才产生新的候选债务。

不要求模型必须答复每个 target。已读取但无需动作是正常结果；已通知但没读也不应在每个回合形成无限唤醒循环。

## 7. TargetBatch：同上下文完整，不等于无限历史

### 7.1 选中后再构造

按照 selection 的授权 target 取所有当前可用、未消费、未被另一已确认读取覆盖的 pending 成员；以 immutable message ID 去重，按 seq 排序。需要 Server 修复数据时只读取这个 target，不执行全局 drain。

消息的 task mutable projection 应复用现有权威刷新规则，不能拿旧缓存 task_status 决定新行为。正文 original content 和 amended task projection 不混写。[S18]

### 7.2 冻结批次

在构造时固定 member IDs 与 throughSeq；无 seq 的合法消息用 ID 和固定成员列表。读取过程中新增消息留给下一批。Cursor 绑定 ownerEpoch、selection、batch、target，不是裸全局 seq。

批次成员可分多页；读完一页只确认该页完整返回的 ID。下一页仍属同一 target，不触发全队列重新 pick。

### 7.3 有界输出

建议初始实验上限：单页最多 50 条且 UTF-8 正文总计不超过 32 KiB，并受具体 runtime 输入预算约束。两者是可调起点，不是已测量结果。

正常少量消息一次给全；超过上限时返回 remainingCount、nextCursor、coverage。高优先级 trigger 必须进入第一有效页面或明确给出其阅读入口，不能让一条 @ 排在几百条旧消息之后却说优先已实现。

成员不连续时只确认 exact IDs。单条消息超过预算要分块或明确提示需要定向全文读取，不能把截断摘要登记为全文已读。页内提供明确时间/seq 和 trigger 标识，不把缺口藏起来。

历史补充与 pending 分开：线程 root、少量必要背景可作为 context；它们不是新的 pending work。频道选择不自动附所有子 thread，thread 选择不附 parent channel 全部消息。non-member mention 只获得原本授权的通知/上下文，不能据此扩展读取权限。

### 7.4 Push 与 Pull 的两种正文交付方式

默认建议 **通知 + 拉取**：自动通知只给 selectionId、target、原因和待读条数；Agent 用 attention read 拉取完整目标批次。这样能沿用当前 notice-first 行为，减少同时改动所有 runtime 的风险。

现有必须把正文放在启动输入的路径，允许直接投递同一 TargetBatch；记录该页已完整暴露的 exact IDs。后续 attention read 只提供剩余/新增内容或明确标注已经交付，不再把同一页当成新工作。

禁止两个实现：Push 自己拼一个跨 target prompt，Pull 再用另一套 grouping。两者共享构造器、快照成员与 receipt。

## 8. CLI / API 契约：增量，不改旧功能默认含义

### 8.1 新 CLI（建议命名）

`raft attention current`：查询当前 Focus、当前/下一推荐 selection 和原因；不读取正文、不 drain、不改变 task 状态。无推荐时区分 disabled/unsupported、runtime gated、无当前候选，而非统一 empty。

`raft attention read [--selection <id>] [--cursor <cursor>]`：读取一个已选 target 的批次；未传 selection 时使用当前有效 selection。会有读取/确认副作用，help 明确说明。过期 selection 返回 ATTENTION_SELECTION_STALE，不偷偷改读新 target，更不退回全量 message check。

`raft attention next`：显式交还当前注意力并请求重新选一个 target，是一次调度操作，不是普通 peek。只改变选择，不代替读取、不自动完成任务、不启动第二个 runtime。模型在自己的执行回合内到达交接点时可以调用，不能简单检查 APM busy 就永久拒绝——工具调用本身通常发生在 busy turn。无下一候选时不宣称所有业务已完成。

`raft attention focus --target <target>`：显式纠偏当前工作上下文，不消费消息。日常自动路径不要求反复调用；主动接手另一个工作时可用。具体语法与互斥参数放 help，系统提示词只介绍用途。

新增命令采用标准 canonical text 输出，并提供 --json；错误走现有 CliError/renderer，不输出自定义成功形状冒充 empty。读命令非阻塞，不等待未来新消息。新增能力未开启时返回可识别的 disabled/unsupported 状态，绝不自动执行旧的全量消费作为降级。

### 8.2 保留原 CLI

- `message check`：保留现有全量 drain 到上限与默认 seq 输出，不变成 attention read，也不强迫增加 --all 才能用旧能力。
- `message claim/ack`：保留原显式确认含义。
- `inbox check`：仍展示完整可用的消息 targets 与 App items、不 drain。新增可选 `--attention`，同一次快照附推荐/等级/原因；不删除低优先级行。
- `message read/search/resolve`：保留历史/搜索/定向查阅能力。研究别的频道不自动切 Focus。

第一版无须改造全量 message check 的正文默认格式；分组和排序展示可以作为显式选项后补。其消费动作必须被 Attention 投影观察到，避免队列留着已经读过的推荐。

### 8.3 接口应落到现有哪条链路

Daemon-owned 命令使用 `createDaemonApiSurfaceClient`，在 shared 的 daemonApiContract 增加 schema、route 与生成客户端映射，在 credential proxy 注册本地 handler，通过注入的 Attention coordinator 操作同一 APM 状态。

建议本地路由：`GET /attention/current`，`POST /attention/next`，`POST /attention/focus`，`POST /attention/read`，`POST /attention/read-ack`；均位于已有 `/internal/agent-api` 本机代理命名空间。这些不是直接转发到 Server 的万能接口。代理失效要报错，不 fallback 到中心 Server 的同名空实现。[S19]

Server 补一个受鉴权的 target-scoped pending snapshot/claim 能力，或为 eventsClaim 增加明确可验证的 target 查询；选择范围必须在 ACK 前确定。旧 query 没有 target 的行为不变。不能依赖 passthrough schema 接受了新参数就认为 handler 已实现筛选。

### 8.4 正文读取确认

采用 batch/page receipt：服务端冻结并返回成员和不含密钥的 receipt；CLI 在成功输出该页后发 read-ack；后端验证 actor/epoch/selection/batch/成员，再提交 exact exposure/消费记录。ACK 失败保留同一批次可重试，不自动拉新 target。

成功写 stdout 仍不等于模型理解了内容。状态命名和日志应区分 `notified`、`body_exposed`、`task_completed`。沿用已有名称 model-seen 的 ledger 时，也不能扩大它的证据含义。

崩溃发生在输出后 ACK 前可能重放。采用至少一次和稳定 batch ID，而不是承诺 CLI/SDK/模型之间不存在的全局 exactly-once。只有真正返回的全文 IDs 才进入 exposure 集；分页高 seq 不推进整个频道高水位。

## 9. APM 接入、债务保留与恢复

### 9.1 接入位置清单

1. `deliverMessage`：验证、去重和入 Inbox 后更新候选；不相关 ordinary 不创建 busy 通知。
2. `sendStdinNotification`：从 coordinator 取单个 eligible selection；不再从全部 changedMessages 生成多 target 通知。
3. `executeApmGatedSteeringEffect` 与 turn_end：一次只处理选定 target；按 batch 返回已通知/暴露 ID，不能只返回一个 boolean 后清空所有 tracked mentions。
4. `startAgentNow`：先归并 wake/starting/resume 候选再 pick；只把一个 target 作为业务输入，其余保留。
5. runtime clean close / no-process continuation：下一次进程启动前重新 rank target，不选数组中的第一条消息代表全部积压。
6. compaction/review/session-ready/backoff/progress retry：安全门改变后重新询问同一 coordinator，不绕过 policy flush 全部 Inbox。
7. `consumeVisibleMessages`：旧 check/history/held/新 attention read 的消费完成后，更新相关 target 投影，撤销被完全消费的推荐。
8. stop/reset/credential revoke/channel purge：清 selection、释放 lease；保留或删除 pending 必须服从原有生命周期和权限，不因 Attention 清理误启动已停止 Agent。

### 9.2 pending 生命周期不能依附一个 RuntimeSession

建议把 Agent pending 容器的拥有者提升到 APM 的 Agent 生命周期层；现有 ap.inbox 和 starting buffer 通过窄接口引用/转移同一批消息，而不是建第三份正文队列。

进程退出、按回合重启时，未选 target 仍有拥有者。特别替换 clean-close 里对整个 ap.inbox 的 splice 和第一条 queuedWakeMessage 选择，避免后续按数组顺序绕过 Scheduler。所有权转移使用 exact IDs，可测试地保证不丢、不重复入队。[S05]

### 9.3 延迟保留是可靠性前置，不是额外的智能功能

现有缓存不适合无限静默等待。对新策略接收并延后的持久消息，增加轻量 durable pending-reference journal：保存消息 ID、授权 target/owner、接收代次与未完成 receipt，不再复制整段正文。重启时按当前权限回读正文，撤权/删除/过期给明确终态；恢复失败保留待修复，不伪装 empty。

可以复用现有 durable file / machine lock 原语，但不能把核心 Attention 状态伪装成一个 App 的存储。容量满要背压或进入可恢复的 Server pending 路径，不能像现有内存缓存一样静默丢最早条目。该补丁不等于建设一个通用的全局消息日志。

### 9.4 tracked mention 的有限延迟 receipt

建议为已支持 Attention 的版本增加可持久化、带期限的 deferred receipt，携带现有 occurrence identity、owner generation、selection/target 和 deferredUntil。它只能在 Daemon 已可靠保留 pending 后发送。

Server 校验并记录“已接收，计划延后”，在该有限 lease 内暂停将同一事实计入传输失败 budget；不写 daemon_drained、不写任务完成、不推进已读。lease 过期、拥有者失联或代次变化，恢复原本的可恢复投递/告警流程；每次延期不能无上限刷新绝对期限。

这可以作为现有 daemon transition 的可选扩展，并由 capability gate 双端上线；旧 Daemon 的重试策略保持不变。只有最后真正通知/交付该批成员时，才按既有合同结算对应 occurrence。单次成功绝不 complete all pending mentions。

### 9.5 稀疏读取的 ACK 不使用 legacy 高水位捷径

新 target/batch read 的确认只作用于当前确切成员，不能直接复用缺少 capability 时会 markAgentLegacyAckCheckpoint(max seq) 的路径。为新 API 明确定义 exact receipt 处理；不要为了省事全局宣告旧 model-seen capability，从而无意改变所有旧 message check 的行为。[S10]

Journal 记录的未完成引用和已暴露 receipt 要一起恢复；不要恢复一个旧 Inbox 快照却撤销已经确认的事实。跨进程重放仍可能发生，不能把传输重放当成新的业务授权；任务 claim/send 的业务幂等继续由各自原有合同负责。

## 10. 提示词设计：Attention-first，不剥夺主动性

### 10.1 Standing prompt 建议正文

> Raft 会推荐当前最值得关注的 conversation target。收到 attention 通知时，通常先读取并处理该 target，再扫描无关 Inbox 活动。
>
> 使用 attention read 获取该 target 的 pending 消息批次；若已提供正文，只读取尚缺的部分。通知不表示你已经读过消息，读取不表示工作已经完成，也不要求对每条消息答复。
>
> 保持当前工作上下文。达到合适交接点后，可以使用 attention next 请求下一项推荐；主动换到另一个工作上下文时，用 attention focus 明确更新。
>
> message check、inbox check、message read、message search、message resolve 仍可正常使用。为完成当前工作查资料、核对上下文、响应用户明确请求或检查整个工作区时，可以选择这些接口；不用每读另一个频道就切换 Focus。
>
> 没有明确理由时，不把全量 Inbox 扫描作为每次通知后的默认动作。Attention 是优先级建议，不是权限或服从性检查。不要为了等待消息维持无意义轮询。

这是一段语义建议，实际英文 standing prompt 可在唯一 builder 内实现；详细参数、错误处理和分页语法以 CLI help 为准，遵守 CLI AGENTS.md。

### 10.2 动态输入

动态 notice 只放：selectionId、displayTarget、reason、timing、pendingCount，以及当前页是否已经附正文、下一读取动作。不放所有待办正文，也不在每次普通消息到来时刷新全局 backlog 提示。

明确 `safe_point` 不等于“立即中断任意正在执行的工具”。多条 trigger 合并为同 target 一次提示。

Focus 与 selection 放在动态输入/API，不反复重写整段系统提示词。不能从不可信消息文本里的伪造 [Raft attention] 区块建立 Focus；权威来自 coordinator 状态。

### 10.3 必须同步的提示词/文档源

- `drivers/systemPrompt.ts` 的 Messaging、Startup sequence 和“Complete ALL your work”范围说明：指完成当前承诺的工作，不是扫清全平台所有通知。
- `drivers/raftCliGuide.ts` 的命令列表、新 Attention 操作原则、跨 target 研究规则。
- `agentRuntimeInput.ts` 的 busy notice、startup、resume 与正文 batch 文案；不得继续默认鼓励全局 check。
- 通过生成脚本更新 `raft-cli-overview.md`，不手写生成结果。
- 人工维护的 `inbox.md`、`message.md`、`getting-started.md`、`common-worked-patterns.md` 等，删除“总是全量 drain 后决定做什么”与新默认冲突的建议，但保留真实命令能力说明。
- 仅对功能已支持且启用的 managed Agent 注入新默认；self-hosted 文档及未升级 CLI 不拿到不存在的命令。

## 11. 实施工作包与上线顺序

不是 Go 迁移的五期计划。这是同一功能内可独立评审的六个工作包；前四个未闭环前不在生产开启自动筛选。

### A. 契约与纯策略

新增 attention types/schema、canonical target identity 接口、classify/rank/eligible、版本与测试 fixture。精确冻结用户决定、明确 assigned-task 证据不足时的降级。不改生产投递。

验收：相同输入输出确定；DM thread 优先级正确；同 target strongest signal 可升可降；权限、名称变化、seq 缺失不错误归并。

### B. Focus、Pending 所有权与影子决策

引入 coordinator、Focus 来源/撤销、生命周期级 pending 拥有者；覆盖 no-process/start/close 路径。影子模式只记录如果启用会选哪个 target，不改变实际通知。

验收：没有可靠 Focus 时不猜；读取 B 不改 A；stop 后不会自动启动；进程退出后非选中 targets 保留；影子策略不消耗/ACK 消息。

### C. CLI 批次读取与兼容

增加 current/read/next/focus、typed daemon API、target-scoped Server 修复、批次 receipt 与分页；旧读法继续可用。inbox 的 attention 注解只在显式选项启用。

验收：读取一个 target 只消费它的返回全文 IDs；本地空、Server 有消息时不全局 drain；旧命令测试仍通过；stale handle 不变成另一个 target。

### D. 所有主动投递入口与可靠性

统一 APM 各入口到 coordinator；修复全局 mention ACK、全局 notification debt 清理；实现延迟 journal、Server 有限 deferral receipt、代次恢复、SDK revert/unknown 处理。先在 fake runtime 上验证，再在一个已支持 runtime 受控验证。

验收：同 target 合批，其他 target 不提前通知/ACK；busy gating 不被绕过；长期 defer 不出现虚假 retry exhaustion；重启后可恢复。

### E. 提示词与行为验证

更新唯一 prompt/guide 源、动态文案、手册与 freshness/snapshot tests。给人工场景和不同模型跑小规模对照，检查 attention-first 是否真的降低无关扫描，同时不妨碍主动研究。

验收：新命令存在才提示；任务需要跨频道证据时模型仍能查阅；不因推荐为空谎称全局无工作；不强制每条消息答复。

### F. 小范围启用与回滚

按 agent/runner feature flag 灰度，从 mixed DM、mention、普通频道的固定场景扩展。Server 先支持兼容 receipt/claim，再升级 Daemon/CLI，最后启用 prompt 和 policy。

建议以 AgentConfig 的可选 attentionPolicy 快照承载 version、mode（off/shadow/active）和 policyRevision；只有权威配置入口可改变，不接受消息正文覆盖。旧配置缺省 off；shadow 不消费、不新发 ACK、不改变实际投递。bundled CLI、Daemon route 和 prompt contract 同版验证后，才能报告 attention-v1 capability。

关闭 flag 后恢复旧选择方式，但不删除未完成 pending journal 或 batch receipt；先解除 deferred lease/归还未消费事实，再恢复旧投递。不能通过清所有 notice memo 触发全量重播。

## 12. 必须覆盖的验收场景

### 策略与能力

- busy 时同 focus thread、无关 DM、无关 @、普通频道同时到达；只对 focus 产生安全窗口候选，边界后先 DM 再 @。
- DM thread 与普通 thread 不混；同 parent 的另一个 thread 不被当成当前 focus。
- Focus unknown；只读搜索跨 target；explicit focus 更新；next 在 Agent 自身回合内可操作而不启动第二个进程。
- task_number 相同但不同频道/Server 不误判同一任务；普通任务状态变化不冒充新指派。
- runtime 不支持 busy 输入、session 未 ready、compaction、review、rate-limit、explicit stop 均不被 Attention 绕过。

### Batch / 消费 / 并发

- 一条 @ 触发时，同 target 的前后 pending 消息一并构造；不夹入其他 target。
- 批次读到一半新增消息不改变快照成员；超大 target 可分页；高优先级 trigger 不被吞在截断尾部。
- 只显示摘要/部分正文不登记全文已读；高 seq 的 sparse batch 不推进频道高水位；parent root 不消费整个 parent channel。
- notice 后 read、正文 push 后 read、全量 check 与 attention read 并发、两个并发 read、ACK 重试、输出后进程崩溃。
- 其他 target 的 mention 不被一次 target 派发确认；未选中的 notification contribution 不被全局 clear。
- cursor/selection/owner epoch 不匹配返回明确状态；权限在 pick 和 read 之间被撤销时不返回正文。

### 生命周期与恢复

- 已运行、排队启动、正在启动、runtime clean exit、idle 无进程、cooldown、resume/cold start、主动 stop/reset。
- pending 在 runtime 退出时保留；新进程按 target 重新 pick；Daemon 重启按 journal/Server 授权恢复，不能自动恢复旧运行时权限。
- SDK delivered/deferred_to_idle/unknown 和旧 attempt 晚到；只恢复本批仍未读成员，不反复唤醒同一未变化集合。
- 长时间 defer、lease 到期、Server 重启、连接断开、旧代次消息、journal 写失败/容量不足。
- feature flag 开关与滚动升级；旧 CLI 默认行为；新命令 unsupported 不自动清 Inbox。

### 真实行为对照

用相同消息到达序列比较旧版与新版。评估自动注入的无关 targets 数、全量扫描频率、DM/@ 处理延迟、当前任务完成率/耗时、实际 Focus 切换频率、输入字节数、重复通知与待办漏处理。

跨 target 读取仅记 `cross_target_read` 事实，不直接记成“错误调度”或“模型不服从”。是否合理要结合当前任务需要和后续行动判断。不能以更少读取次数作为唯一成功指标。

## 13. 本次验证结果与证据边界

执行命令：

```sh
pnpm --filter @botiverse/raft-shared exec node --import tsx --test \
  src/attentionDependencyOracle.test.ts src/agentInbox.test.ts
```

结果：16 tests，16 pass，0 fail，0 skipped。测试覆盖现有 hint 条件、Inbox 不含正文、mention 标识、non-member 说明、suppressed 与 pending 区别、未知 flag 的有界输出。出现 Node module.register 的弃用警告，不影响这次测试通过。

另一次纯内存复现直接 import 当前 `AgentVisibleDeliveryLedger`，对带 third_party_event.id 的消息调用 recordConsumed，再检查 formatAgentMessageVisibleTarget、shouldSuppress 与 isModelSeen。观测结果为：recordedTargets=[dm:@system]；lookupTarget=agent-event:12345678；suppressed=false；modelSeenAtLookup=false。复现未创建消息、未调用网络，也未修改源码。

16 项通过是旧代码基线；键不一致复现是一项被确认的局部缺陷。二者都不是新 Attention 的正确性证明。尚未完成：新功能实现、完整 APM 故障复现、真实 runtime E2E、Server 集成、长时间 defer/重启恢复实机验证、模型 A/B 结果。不能据此承诺节省多少 token、降低多少延迟或精确人天。

未安装、重启、升级任何现用 Computer/Daemon，未读取实际凭据。业务文件未由本次任务修改；原有 `apps/mobile/metro.config.js` 修改与 Go 迁移规划文档保持不动。

## 14. 源码证据索引

行号以本报告基线为准；后续实现可能移动。

- **[S01] 通知与正文**：`packages/daemon/src/agentRuntimeInput.ts:198-217`；`packages/daemon/src/agentProcessManager.ts:8051-8101,8161-8305`。普通路径是 content-free notice；thread join 可有正文。
- **[S02] target 聚合/排序**：`packages/daemon/src/agentInboxProjection.ts:73-135`；`packages/shared/src/agentInbox.ts:48-87,90-145`。按 target 分桶、flags、latestSeq 排序和无正文输出。
- **[S03] 元数据/Focus 边界**：`packages/shared/src/index.ts:101-160,1118`；`packages/daemon/src/agentProcessManager.ts:487-530,819-832`；`packages/daemon/src/agentLifecycleRecord.ts`。存在任务投影、原生事件 taskId；本次检索未发现 Current Focus 实现。
- **[S04] 运行时边界**：`packages/daemon/src/agentProcessManager.ts:7581-7668`；`packages/daemon/src/runtimeBusyDeliveryCoordinator.ts:99-137`；`packages/daemon/src/drivers/types.ts:304-438`。
- **[S05] 多入口与进程退出**：`packages/daemon/src/agentProcessManager.ts:2987-3097,3259-3278,3379-3500,4370-4488,4822-4933,6790-6895`。启动/恢复/退出/安全边界均有投递逻辑。
- **[S06] 全局清理与确认**：`packages/daemon/src/agentProcessManager.ts:4317-4322,6819-6877,7604-7620`。全部 pending mention completion 与全局 notification 清理。
- **[S07] CLI check/claim**：`packages/cli/src/commands/message/check.ts:16-38`；`packages/cli/src/commands/message/_inbox.ts:28-96`；`packages/cli/src/commands/message/claim.ts`、`ack.ts`；`packages/shared/src/agentApiContract.ts:1220-1234,1770-1800`。
- **[S08] history 与 Inbox 命令**：`packages/cli/src/commands/message/read.ts:92-163`；`packages/cli/src/commands/inbox/check.ts:15-50`。
- **[S09] 本地/fallback 消费**：`packages/daemon/src/agentCredentialProxy.ts:513-600,1333-1420,1609-1628`；`packages/server/src/routes/internalAgentApi.ts:3275-3463`。
- **[S10] exact-id 与高水位**：`packages/daemon/src/agentVisibleDeliveryLedger.ts:78-114,155-224`；`packages/daemon/src/agentProcessManager.ts:2040-2084`；`packages/server/src/routes/internalAgentApi.ts:3210-3243`。
- **[S11] tracked mention 重试**：`packages/server/src/services/agentDeliveryRetryPolicy.ts:1-46`；`packages/server/src/services/agentOrchestrator.ts:7620-7650,7749`；`packages/server/src/services/mentionDeliveryOccurrenceService.ts:248-279`；`packages/server/src/db/schema.ts:5736-5765`。
- **[S12] 有限缓存**：`packages/server/src/services/agentOrchestrator.ts:11872-11884,12000-12009`；`packages/daemon/src/agentProcessManager.ts:2027-2038,3470-3500`。
- **[S13] AttentionDependencyOracle**：`packages/shared/src/attentionDependencyOracle.ts:19-59,67-105`；`packages/shared/src/attentionDependencyOracle.test.ts`。生产调用缺失是本次搜索边界内的结果，不是对外部部署的断言。
- **[S14] 提示词源**：`packages/daemon/src/drivers/systemPrompt.ts:8-28,71-107,146-170`；`packages/daemon/src/drivers/raftCliGuide.ts:1-38,115-145,493-573`；`manual/agent-knowledge/common-worked-patterns.md:171-188`；`manual/agent-knowledge/inbox.md:49-69`。
- **[S15] CLI 设计约束**：`packages/cli/AGENTS.md`。handles/DSL、query/mutation、help 为参数真源、复用 typed client。
- **[S16] SDK attempt 与安全输入**：`packages/daemon/src/runtimeDeliveryAttemptLedger.ts:1-26,67-198`；`packages/daemon/src/agentProcessManager.ts:4583-4614,4869-4925,6642-6675`；`packages/daemon/src/drivers/types.ts:387-438`。
- **[S17] 通知 timer**：`packages/daemon/src/agentProcessManager.ts:424-425,4916-4919`；`packages/daemon/src/runtimeNotificationState.ts:1-85`。
- **[S18] Server 刷新与授权**：`packages/server/src/routes/internalAgentApi.ts:3310-3420`；`packages/server/src/services/messageService.ts:1295-1507,7148-7320`。通知资格/任务投影/mention 与正文不是随意客户端推断。
- **[S19] Daemon-local 契约**：`packages/shared/src/daemonApiContract.ts:216-275`；`packages/cli/src/daemonApiPath.ts`；`packages/cli/src/client.ts:1-93`；`packages/daemon/src/agentCredentialProxy.ts:413-491,513-600`。
- **[S20] 既有 mention 生命周期风险**：`packages/daemon/src/agentProcessManager.ts:2040-2084,4268-4276,4317-4336,4360-4386,4587-4610,7604-7620`；`packages/daemon/src/agentCredentialProxy.ts:1392-1398`；`packages/daemon/src/apmStateMachine.ts:539-560`。
- **[S21] 恢复提示词**：`packages/daemon/src/agentRuntimeInput.ts:299-341`；启动调用点 `packages/daemon/src/agentProcessManager.ts:3075`。

## 15. 最终建议

采用 **按 target 组织的 Attention 推荐与自动投递策略 + 原能力保留的 CLI + attention-first 提示词**。

不要再增加 Waiting For、老板识别、语义分类器或跨任务依赖图。先把一个 target 的选择、同 target 批次读取、正确消费与可恢复延迟做扎实。

最值得坚持的三条：**平台知道自己推荐了什么；Agent 保留主动查阅能力；无论从哪条路径读过的消息，都不会在 Attention 层被错误地当成另一件新工作。**
