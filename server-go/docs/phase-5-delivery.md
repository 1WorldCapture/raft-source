# M5 深化设计：显式提及、持久投递与 Agent 回复

- 日期：2026-10-08（America/Los_Angeles）
- 基线：`336b5c8`，已完成 architecture stabilization 的 Go Server。
- 状态：**设计与实施契约；M5 后端已于 2026-10-09 完成收口，最终完整 `make check`（含全量 race、原客户端及 0014/0015 升级回退）通过。UI 与现有实例部署另行签收。** 最新代码、修复与测试状态以 [M5 后端收口](m5-backend-closeout.md) 为准；UI 验收由独立协作者负责。前置修复的历史记录见 [UI 分诊与交接](m5-ui-feedback-triage.md)。
- 产品边界：M5 是本轮最后一个产品阶段，不增加 M6；旧总纲中的 M6 排期已被后续稳定化方案覆盖。保留现有 Web、CLI、Daemon 源码与锁文件；不借本期重写客户端、引入任务/工作流引擎或扩大到联合频道。
- 配套：[实施与验收责任](m5-implementation-coordination.md)、[原协议证据](m5-protocol-evidence.md)、[稳定化接入边界](architecture-stabilization-design.md)。本文保留设计约束，不作为单独的实现完成证明；实际 API、增量迁移与验收结果以收口报告及当前代码为准。

## 1. 完成的应当是什么

M5 的主验收故事是：人类进入真实频道 → 通过现有 picker 显式提及一个有权读取并回复的 Agent → 消息与该 Agent 的收件意图原子提交 → 在线派送，离线保留 → 原 Daemon 或原 CLI 接受输入 → Agent 用自己的凭据发送回复 → 人类在原 Web 中收到真实回复。服务端重启、重复发送、连接替换和 ACK 丢失不能凭空丢掉未确认意图或重复创建消息。

必须把三种承诺分开：

| 层次 | M5 的承诺 | 不能从中推导的承诺 |
|---|---|---|
| 服务端事实 | 消息与每个合法 Agent 收件意图同事务；未确认记录可恢复、可诊断 | WebSocket write 成功不等于收到 |
| 接收回执 | 记录原协议实际返回的回执及其身份、代际和含义；重复回执幂等 | ACK 不等于模型已经读到，更不等于完成任务 |
| 用户结果 | 指定集成用例中，原客户端实际收到输入、以 Agent 身份提交回复，原 Web 可见 | 任意模型必然回答、运行时副作用 exactly-once |

**重要限制：当前 Daemon 的 tracked mention ACK 也不能统一称为“输入已被模型消费”。** `agentProcessManager.ts:4361–4388` 在启动缓冲分支中把消息放入内存后即可完成 tracked delivery；源码明确注明 start 失败后已 ACK occurrence 不会重新报告。普通 ACK 则在 `deliverMessage` 返回 accepted 后发送。M5 保证的是服务端未确认投递的持久性与明确的回执事实，不承诺不改 Daemon 就获得跨进程崩溃的模型消费确认。这个边界必须出现在验收报告中，不能被“可靠”二字掩盖。

## 2. 产品决策与范围

### 2.1 默认频道不再是死频道

恢复启用的真实 `#all`/`#announcement` 的隐式成员发帖权。已通过账号门禁并属于空间的 owner/admin/member 无需物理 roster 行；列表 `joined: true` 与发帖授权一致。隐藏的 `#all`、归档/删除频道、非成员、当前被禁用的 guest 均不因此获得权限。普通频道仍需显式加入，DM 仍需参与者身份，线程继承根会话的权限。

不把 `#all` 当作 Activity 聚合面，不修改客户端来补一个无意义的 Join 按钮，不回填虚假成员。此次不新设“公告只能管理员发”的策略。公告频道原有禁止线程的规则继续有效；Agent 讨论主验收用 `#all` 或自建频道，不依赖公告线程。

### 2.2 本期覆盖与明确不覆盖

必做：显式单个/多个 Agent mention；稳定 ID 解析；空间/频道授权；消息发送幂等；持久队列与有限重试；原 machine wire；Agent 专属发送/历史/必要收件接口；离线恢复；原人类消息、线程、DM、未读链路不退化。

Agent 回复本身不触发“频道里所有 Agent 都收到”。M5 不做自动旁听、隐式多 Agent 广播、看到任意 `@` 字符就执行、自动任务认领或工作流推进。Agent 主动提及其他 Agent 的级联唤醒默认不纳入核心闭环；需要支持时单独增加有界、可追踪的显式用例，不能悄悄引入无限互答。

Agent DM 采用 **M5 内部的独立切片**，不是 P1 热修复：完成收件/回复主体授权之后，再实现人类与 Agent 的 canonical DM；在此之前保留明确 501，绝不创建空壳可聊 DM。既有 `direct_messages` 表只支持两个人类，不能往其中塞 Agent UUID。原 UI 的静默错误仍需客户端协作者修正，后端不能借假 200 消除它。

不纳入：Joint Channel、Office、附件/文件传输、全文搜索、任务/工作流、计费/配额系统重建、任意远程文件操作、分布式副本和外部 VM 编排。既有相关入口仍返回真实未启用或错误，不建立通用空成功兜底。

### 2.3 Agent 可达性不等于权限

Agent 可以是长期空间成员，某台机器或进程只是当前执行载体。`online`、`active`、机器连接存在都不能授予频道权限。离线但合法的目标可以形成待投递记录；删除、跨空间或无权读取目标应在提交前拒绝，而不是接受后偷偷发给别的 Agent。

核心路径采用“接收者具备根会话读取及回复权限”的收件策略。私有频道需要真实 Agent roster；对启用的系统频道使用现有 Agent 目录/成员策略核对后的隐式成员规则，不能直接把人类权限函数套给 Agent。对于普通公开频道的未加入 Agent，M5 核心路径不自动加入：显式报出不可投递，或在后续经过验证的 notify-only 切片中表达 `non_member_mention`；不能一边暗中加入一边宣称只是通知。

## 3. 原客户端兼容边界

### 3.1 机器下行与上行

继续使用 `packages/shared/src/index.ts` 的既有协议：

| 方向/帧 | 必要契约 | 服务端解释 |
|---|---|---|
| 下行 `agent:start` | `agentId`, `config`；可选 `launchId`, `startDispatchId`, `wakeMessage`, `resumeMessages`, `unreadSummary`, `resumePrompt` | 启动请求，不是启动完成 |
| 上行 `agent:start:ack` | `startDispatchId`, `launchId?`, `queueState`, queue depth/age | queued/starting/running/rebound 是 Daemon 报告的启动队列状态 |
| 下行 `agent:deliver` | `agentId`, `message: AgentMessage`, `seq`, `deliveryId?`, `mentionDelivery?`, `transient?` | 一个明确收件者的一次可重试派送 |
| 上行 `agent:deliver:ack` | `agentId`, `seq`, `deliveryId?`, `mentionDelivery?` | 带类型和身份边界的接收回执；不是 task completed |
| 上行 `agent:delivery:transition` | `stage` 为 received/pending/drained 三种，`outcome` accepted/coalesced | 单个 occurrence 的过程观察，不能单凭中间状态清队列 |
| 上行 `agent:delivery:terminal_error` | 六种既有错误码与完整身份快照 | 按错误类别处理 attempt；不得无条件终结逻辑投递 |
| 上行 session/status/invalidate | 当前 agent、launch 与真实 runtime session | 校验当前代际后更新 Agent 事实，不等于消息 ACK |

tracked mention 的快照原样为 `{ occurrenceId, messageId, machineId, launchId, sessionId }`。`deliveryId === occurrenceId`；`messageId === message.message_id`；wire `seq` 仍是 **消息的 `messages.seq`**。新增服务端 delivery 排序号不能塞进这个 `seq` 字段。

`AgentMessage` 沿用 snake_case 字段，包括 `channel_id/channel_name/channel_type`、`sender_id/sender_name/sender_type`、正文、timestamp、message_id、seq、mentioned 及需要时的 thread context。Web 的 `senderType: user` 和 Agent wire 的 `sender_type: human` 是不同投影，必须由唯一 presenter 映射；不直接把 Web DTO 广播给 Daemon。附件/task 字段未实现时不伪造内容。

### 3.2 Agent HTTP 与 CLI

原客户端已具备以下语义，实施时必须冻结实际请求/响应 fixture，而不是只对齐路径：

| 原命令/用途 | 原接口 | M5 处理 |
|---|---|---|
| `raft message send` | `POST /internal/agent-api/send`、`/v2/send` | 两种入口归一到 `SendAgent`；保留各自 envelope |
| `raft message check` | `GET /internal/agent-api/events` | 遗留 destructive drain，返回即确认；HTTP 响应丢失有固有窗口，不能当强恢复路径 |
| `raft message claim` | `GET /internal/agent-api/events/claim` | 领取有限批次及 ack 的 seqs/message_ids/third_party_event_ids 三数组，不立即确认 |
| `raft message ack` | `POST /internal/agent-api/events/ack` | 原 CLI 解码本地 Claim-Ack token 后原样回传三数组，重复提交幂等，服务端按真实主体及已领取事实约束 |
| 历史/定位/频道解析 | 原 `history`、`resolve-channel` 等真实消费路径 | 只实现闭环实际需要的准确契约；只读不隐式推进 ACK |

Agent 面身份参数使用 `@handle` 与目标 DSL（`#channel`、`dm:@peer`、线程引用），在服务端解析为稳定 UUID。不能要求 Agent 临时知道用户/Agent UUID，也不能让 CLI 自己成为权限权威。所有 Agent API 使用 `sk_agent_*` 或现有 runner proof，拒绝人类 JWT、Computer key 和另一 Agent 的 proof。

managed runner 的命令可能先进入 Daemon 本地桥，self-hosted runner 才直接访问 Agent API。测试需要覆盖两种真实 `clientMode`，不能仅因一个 curl 请求成功就说原 CLI 全部兼容。强服务端领取恢复路径采用既有 claim/ack；遗留 check 单独作为兼容语义签收。

## 4. 原子发送与模块职责

保持稳定化后的模块化单体，不回到万能 Orchestrator：

| 归属 | 所有事实/职责 | 不得承担 |
|---|---|---|
| `message` | 正文、seq、发送幂等、已解析 mentions | Daemon 在线队列、连接判定 |
| `channel` | 人类/Agent 可见性、发帖、线程根、DM 参与者 | 任意凭据验证或派送重试 |
| `agent` | 长期身份、绑定、当前 launch/session、凭据与启动事实 | Web 投影与全域消息 SQL |
| 新 `delivery` | 收件意图、attempt、claim/ACK、租约、退避、恢复查询 | 消息编辑、模型执行、task 状态 |
| `application/messaging` | 同一事务内组织 SendHuman/SendAgent 与必需副作用 | 直接写其他领域表 |
| `application/machinecontrol` | 分派启动/投递回执到事实服务 | 从 payload 伪造已认证主体 |
| machinews/agentapi/presenter | 传输、认证适配与协议投影 | 直接 SQL 或第二套业务规则 |
| `app` | 构造、依赖验证、生命周期 | 临时实现收件策略或状态机 |

一次新的 SendHuman：账号与 scope 在事务内重新验证 → 校验 body、幂等键与全部目标 → 解析稳定 Agent/user references 并检查权限 → 写 message 与 mention facts → 调用 delivery 的事务内计划方法 → 线程关注/作者 read advance → 按既有顺序记录 browser publication → commit → 唤醒投递扫描器。

沿用现有 publication 的顺序约束，不重排已读/消息/线程事件。Agent 收件记录与消息在同一个 `platformdb.WithWriteTx` 中写入；任意必需收件写失败则全部 rollback。**不能照抄原 TS 中 occurrence 补写失败仍放过消息的窗口。** commit 后的 wake 丢失也不丢意图，周期扫描会重新发现。

同一发送者、randomId 和请求摘要重放返回原消息，不再创建 mention、自动关注或 delivery。摘要不同则冲突，不泄露原消息。多个 Agent 目标采用全部合法后统一提交：不出现一条消息“发送成功”但部分非法目标被静默抛弃。合法目标的在线/离线状态不影响消息的原子接受。

## 5. 新增持久模型（实施时迁移，不在设计轮创建）

新增迁移从 `0014` 开始；保持 0001–0013 字节不变。建议的数据归属如下；实施前由 schema 负责人按实际 Store/约束名称冻结 SQL。

### 5.1 `message_agent_mentions`（message 所有）

字段：workspace_id、message_id、agent_id、handle_at_send、created_at；唯一 `(message_id, agent_id)`，复合外键约束 message/Agent 与空间一致。保留原 `message_mentions.user_id` 人类表，不把 Agent 写成用户、不重写其外键。当前名字用于目录展示，历史绑定由稳定 ID 决定；改名不改变收件目标。

### 5.2 `agent_deliveries`（delivery 所有，逻辑收件意图）

字段：id、独立递增 delivery_order、workspace_id、agent_id、source_kind、source_id、message_id、conversation_id、scheduling_state、created_at、next_attempt_at、retry_count、last_error_code、acknowledged_at、revision。消息型记录的 `(workspace_id, message_id, agent_id)` 唯一；briefing 等控制意图使用独立 source_kind/source_id 幂等键。所有 source 类型都必须有真实用例，不创建通用任意 JSON 作业平台。

`scheduling_state` 区分 pending、waiting_machine、waiting_identity、leased、acknowledged、blocked、cancelled。ACK 只是收件回执，不叫 completed。被移除的频道权限/Agent 删除/空间删除会取消未派送意图，保留必要审计；可恢复离线不算取消。字段受 CHECK、非负计数、安全整数和复合外键约束；索引覆盖待扫描时间、Agent 顺序和源去重。

### 5.3 `agent_delivery_attempts`（delivery 所有，协议 occurrence）

字段：occurrence_id、delivery_id、attempt_number、workspace_id、agent_id、message_id、machine_id_snapshot、launch_id_snapshot、session_id_snapshot、transport_kind、lease/token 摘要、retry_count、next_attempt_at、received_at、pending_at、drained_reported_at、acked_at、terminal_code、revision。managed wire 的三项身份快照在首次发送时必须非空；self-hosted claim 路径以 Agent proof/claim 租约绑定，不要求机器快照。使用 transport_kind 的条件 CHECK 区分，禁止为外部 Agent 伪造 machine/launch/session。

**逻辑意图与协议 occurrence 分开。** 同一 machine/launch/session 的网络重试使用相同 occurrence_id，因此原 Daemon 可去重。确需切换 launch/session 时，不把原 occurrence 的快照原地改成新身份；在旧 attempt 终结且重新授权后生成新 occurrence，保留其逻辑 delivery 关联。旧 ACK 最多说明旧 attempt，不可确认新 attempt。身份已确认派送后是否允许自动重投到新 launch，按第 7 节的保守策略处理。

每次派送的当前连接 epoch 是服务端认证证据，不是持久“在线”状态。记录必要的最近派送代际/时间以审计，但服务端重启后绝不把旧 epoch 当作仍存活的锁。序号较大的 ACK 不累计清理较小消息；只能确认它具体绑定的 occurrence 或 claim 批次。

### 5.4 launch 与 claim

当前 expected launch fence 仅在内存。M5 需由 agent 领域追加当前 launch/startDispatch 的持久事实，允许短事务内预留启动意图、重发同一个未确认 startDispatch、验证 session 更新与恢复。不能只往 delivery 表缓存“Agent 当前状态”，制造第二身份来源。

**实施核对纠正：** 原 CLI 的 Claim-Ack token 只是本地 base64url(JSON {v,s,m,t})，HTTP wire 不携带服务端秘密 token、claimId 或 lease generation。服务端保留已领取集合及有界租约，按已认证 Agent/credential/workspace 和当前权限确认对应记录，不接受客户端自报任意消息列表跨主体清队列。原 CLI 会丢弃三数组以外的自创字段，因此不能增加必填签名 token。相同主体对同一批消息在不同租约世代的迟到 ACK 无法从原协议区分，不能宣称强 lease-generation fencing。详见 `m5-claim-wire-correction.md`。

人类—Agent DM 若进入该切片，新增独立 typed participant/pair 事实，不修改原人类 canonical pair 表含义。创建必须同事务完成频道、参与者、唯一映射和必要投影，第三方不可凭 channelId 加入或读取。

## 6. 投递、ACK 与重试状态

### 6.1 调度与证据是两条轴

调度决定“接下来做什么”；证据决定“我们实际知道什么”。不把 received/pending/drained 三个 Daemon 观察直接当作队列的唯一生命周期。

典型过程：逻辑 pending → 当前机器不可达则 waiting_machine → 身份未齐则 waiting_identity → 领取 attempt → 通过当前权限与连接准入发送 → 记录 received/pending/drained 报告 → 匹配 ACK 则 acknowledged。只有明确不可恢复权限/资源错误才 cancelled；重试预算耗尽进入 blocked，可诊断和显式重投，不删除记录。

received/pending/drained 的重复、迟到或顺序重排不得让时间戳倒退或使已 ACK 记录复活。原协议并不保证每个中间 transition 都先于最终 ACK 到达；合法最终 ACK 可以独立确认回执，但不能伪造此前没有观察到的三个时间戳。保存 `drained_reported_at` 这个名字，避免暗示已观测模型消费。

### 6.2 ACK 的准入顺序

先由 machinews 给出已认证 Computer/Machine principal 与当前连接保护；再定位属于该主体、Agent、workspace 的已派送 attempt；检查 occurrence、message、wire seq、machine/launch/session 的一致性；最后在短事务里做幂等 CAS。

payload 的 machineId 只能用来做一致性核对，绝不是认证来源。另一机器伪造合法 occurrence、旧连接迟到 ACK、另一 Agent/空间的 ACK 批次，均不得越权修改收件状态。合法 ACK 重放不增加 retry、不重复 publication、不刷新首次确认时间。

对 tracked attempt，缺少 deliveryId/mentionDelivery 的 legacy ACK 不得用 max(seq) 猜测确认。M3 仍可兼容旧机器连接，但只有通过固定原客户端协议测试的版本/运行路径才能进入 M5 tracked 派送。未知能力保持 pending/blocked 并给出诊断，不默默降级为弱回执。

### 6.3 调度参数与公平性

初始建议值（可配置、待负载验证）：单 Agent 同时最多一个待确认 managed attempt；跨 Agent 有限并发；5 秒起指数退避、上限 5 分钟并加抖动；自动发送预算 24 次。持久记录下一次允许时间与已发生次数，进程重启/重连/扫描不得重置预算。

机器离线、尚未有 session、被用户明确停止属于等待/阻塞事实，不在忙循环中消耗网络发送预算。不覆盖 stopped 状态强行唤醒。使用现有 Agent 生命周期规则决定是否可启动；同一 Agent 启动请求去重，批量 mention 不能触发并行重复 start。

调度按每个 Agent 的 delivery_order 排序但不以消息全局 seq 计算连续游标。某条被取消或 blocked 的记录不能永久阻塞整个 Agent；明确记终态/操作原因后推进后续。没有无限内存缓冲；临时 wake channel 满时允许丢唤醒信号，但不能丢数据库记录。acknowledged 审计记录的清理期单独配置，永不清理未处理 backlog。

## 7. 冷启动、重连与不确定窗口

### 7.1 不制造启动死锁

tracked mention 需要非空 launchId/sessionId，第一次启动时这些事实可能未齐。先持久化逻辑意图，再按现有生命周期启动，等待真实 session 身份；不要在创建 message 的事务中等待 Daemon 或模型。

原 Daemon 明确禁止把 tracked mention 直接提升成普通 wakeMessage（`core.ts:1498–1516`）。M5 也不通过去掉 mentionDelivery 来“绕过”冷启动身份校验。第一实施切片必须验证：对拟支持的 runtime，原 `agent:start` 在没有业务 wake 的情况下能否建立 session；若需要原有 resumePrompt/初始化上下文，使用经 fixture 验证的启动契约，不能伪造用户消息。

`agent:start:ack queued/starting` 不是可派送条件；仅 `ready.runningAgents` 也不含 session 身份。组合真实 current launch、session 和受支持的 runtime 路径后才能建立 attempt。某个 runtime 无法闭合此条件，就保持明确 waiting_identity/unsupported，列为该 runtime 未签收；不得把现有 M3 身份接入成功扩大成所有 runtime 的 M5 支持。

### 7.2 服务端重启与连接替换

启动顺序：迁移完成 → 构造完整依赖 → 恢复未确认 delivery/start 意图 → 接纳机器连接 → 重建当前连接保护 → 核对持久 launch 与真实 session → 有界扫描。启动时将过期进程租约变为可重领，但不假造机器在线。周期扫描、OnReady 和 session 更新都只触发同一调度入口。

同一 machine/launch/session 重新连接可重发原 occurrence；重新授权后才发正文。Daemon 崩溃导致新 launch/session 时，旧 attempt 的回执不能继承。对尚无接收证据、身份漂移且重新获得授权的记录，可创建关联的新 occurrence；对已经 received/pending、但是否产生 runtime 副作用未知的记录，进入显式 uncertain/blocked 诊断，不自动声称“安全 exactly-once 重试”。可选择人工确认重投，同样记录风险和次数，不暗中无限重发。

### 7.3 原客户端无法消除的窗口

当前 Daemon 的去重表和启动缓冲属于内存。即便服务端有持久 outbox，也不能证明一次 ACK 后的 daemon crash 没有丢未消费输入，或一个丢失 ACK 的输入没有产生过副作用。M5 不宣称 exactly-once 模型运行。业务操作需要自身幂等键，Agent 回复使用稳定 randomId 可以防重复消息，但不能防任意外部工具重复执行。

一个不带原任务标识关联的 Agent 回复，不自动确认所有此前 delivery。单条回复存在，只证明该回复已经持久化；不能靠文本相似性补造 input-accepted/task-completed 状态。将来确需“确认跨 Daemon 重启模型已消费”，需要明确升级客户端的持久接收/消费证明契约，不是服务端加一个布尔字段即可获得。

## 8. 权限、锁序与数据泄露边界

每次初始计划、重试发送、claim 领取、历史读取和 Agent 回复均重新校验当前主体/空间/频道/Agent 绑定。recipient snapshot 表达当时的意图，不是永久授权。离开私有频道、撤销 key、删除 Agent、迁移 machine、隐藏 #all 后不得再基于旧快照派送。已经在撤权前合法交付的字节不能收回；原 `agent:inbox:purge` 可作尽力清理，不等于撤回保证。

DB transaction 不跨网络 I/O，不等待 ACK。投递准备/租约提交后，经现有 current-connection admission 边界执行最后一次身份和权限检查再入有界发送队列。实施者必须先形成具体锁序表：machine slot/connection guard、authority fence、SQLite 写事务及回调路径；**禁止**一条路径持 DB/fence 再等 slot，另一条回调持 slot 再等 DB/fence。复用稳定化现有 guard，不另造全局锁或在 app 闭包里随手串联。

必须测试“授权检查后、真正队列准入前撤权”的竞争，fail closed；不能只在准备 attempt 时查一次就声称发送时授权成立。ACK 可能早于 Send 调用返回，故发送结束后的状态更新只能 CAS 补充发送观察，不可把 acknowledged 覆盖回 sent/pending。

日志只记录请求/投递/attempt 的受控关联、状态、错误类与耗时；不记录正文、token、邮箱验证链接或私有 briefing。metrics label 使用低基数类型/结果，不把 Agent/message ID 当 label。

## 9. Agent 回复与浏览器一致性

增加 typed `SendAgent` 用例：当前 Agent proof → 解析目标 DSL → 重新验证空间/频道/DM/thread 权限 → sender_type=agent 的幂等消息 → 需要的线程关系/人类通知事实 → 同事务 publication → 原 Web 消息事件。不可复用 SendHuman 时伪造 user claim，也不可绕开内容验证与 randomId 摘要。

历史/上下文、HTTP 返回及实时事件都通过同一 Agent actor presenter。删掉的 Agent 历史身份应按既有 tombstone 契约显示，不以另一个同名 Agent 替换。跨空间 Agent、已撤销 runner credential、私有频道撤权、DM 第三者都不得发送或读取。

先实现频道和线程的 explicit mention/reply 闭环，再接 Agent DM。DM 对端必须真实存在并属于该空间，创建与重复打开返回同一 canonical channel；人类与对应 Agent 之外不可读；Agent 收到 direct-message 的隐式收件语义须单独冻结，不能混用普通广播规则。

人类未读/Activity 仍由人类 readstate 负责，delivery ACK 不得把人类消息标已读或 Done。Agent 回复给人类产生真实消息/未读，Agent 的队列 ACK 不借用 browser Socket.IO ACK 或 `realtime_publications.published_at`。

## 10. Onboarding briefing 是独立的交接事实

现有 M2 已把人的 setup-handoff acknowledgment 与 briefing_sent 分开。M5 需要兑现这一衔接：在 handoff 已成立、指定官方 Agent 合法可达时生成稳定的 briefing 意图；重复点击、Agent 激活、机器重连和服务端恢复都归一到同一幂等键，例如 workspace/member/briefing-purpose/version。

briefing 原参考路径是 transient，不应把它直接当可持久 Agent inbox ACK。Go 可以持久保存“仍需尝试交接”的意图，但原客户端仅报告 accepted 时，字段必须解释为对应层级的 reported receipt，不能伪称模型已读。实现前核对具体 hook/receipt 的消费契约；未确认前不填 briefing_sent。不要为了走通 #all 而把用户私有 onboarding 内容广播到公共频道；交接目标与可见范围必须沿原产品契约。

“用户点击”“briefing 意图存在”“Daemon 报告接受”“Agent 实际回复”保留为不同事实。失败不会回滚用户已完成的资料或 setup acknowledgment，但必须能再试，不伪造 setup complete 来绕门禁。

## 11. 观测与验收矩阵

必要诊断：消息提交/幂等冲突、意图创建/取消、每种等待原因、attempt 数与退避、当前/过期 ACK、claim 租约与重领、原 Daemon 早 ACK 窗口、启动身份等待、队列年龄、shutdown 未处理量。管理员/Agent 自己查看队列的入口只能在精确身份授权下开放；不要为了 UI 状态显示暴露其他空间 backlog 或私有正文。

| 必须执行的场景 | 通过定义 |
|---|---|
| 新空间默认频道 | owner/member 无 Join 可发；无物理 roster；普通未加入频道仍拒绝 |
| 原 Web picker → Agent | 真实 structured mention；稳定目标与正文、意图同事务，不只测试字符串包含 @ |
| 多 Agent mention | 去重、权限全量校验、每目标一个意图；一个离线不阻止其他派送 |
| 消息/意图写失败 | 任一写入故障整笔回滚，无消息孤儿/无幽灵收件 |
| commit 后 HTTP 丢失 | same randomId 重放原消息，不重复 delivery/通知 |
| commit 后扫描器未唤醒 | 周期扫描或服务端重启恢复真实未确认记录 |
| 原 Daemon wire | 正确 full identity、原 frame/ACK、real clientMode，不只模拟器 |
| 重复/乱序/伪造 ACK | 同 occurrence 幂等，旧连接/旧 launch/外机/外 Agent 零越权修改 |
| 冷启动/启动失败 | 不偷换 wakeMessage；identity 形成有证据；早 ACK 丢失窗口明确记录，不宣称已消费 |
| Daemon crash | 未 ACK 意图可重放；有接收证据但未知副作用显式诊断；不声称 exactly-once |
| 原 CLI claim/ack | 领取响应丢失可重领；ACK 响应丢失幂等；legacy check 单独记录弱语义 |
| Agent 真实回复 | 自身 proof 经原 CLI 到 Go，sender 为 Agent，原 Web 实时可见；重试不重复消息 |
| 权限竞争 | 计划后撤权、发送准入前撤权、领取后撤 key、移机、删 Agent 均 fail closed |
| 系统交接 | handoff ack 不伪造 briefing_sent；离线/激活/重启只形成一个交接意图 |
| 人类 M1–M4 | 现有完整 make check/reference/fixtures/upgrade/race 全部保持 |

至少一项受支持 runtime 使用真实 Daemon/原 CLI 完成输入—回复闭环。模型推理可用明确标识的本地 deterministic provider 替身验证协议，但那不算真实商业模型/厂商调用验收；最终报告逐项区分模拟器、原进程、本地替身与真实模型。浏览器验收由 UI 协作者执行并留截图/请求/控制台证据。

## 12. 迁移、部署与完成门槛

本轮不迁移正在运行的 `var-m4-ui-test`、`var-m3-dev`、`var/`，不替换现有进程。未来 M5 schema 验收在独立临时数据库和真实 M4 冷备副本上进行：保留 key/session/message/seq/readstate → 运行增量迁移 → 验证未确认 delivery 重启恢复 → 旧 M4 程序拒绝新 schema → 用匹配冷备恢复旧程序。不要承诺降级程序直接理解新表；以明确拒绝和可验证恢复为准。

M5 完成要求同时具备：领域/协议测试、真实原客户端闭环、崩溃与撤权竞争、升级/回退、完整后端 gate、UI 协作者签收及本节诚实保证边界。仅有设计文档、队列表、WebSocket emit、daemon active 或 ACK 数量都不构成产品完成。

当前实施进度、未关闭项及同树验收结果统一记录在 [M5 后端收口](m5-backend-closeout.md)。纯客户端遗留问题、独立 UI 签收与未验证 runtime 必须单列，不能从后端测试通过推导为已经完成。
