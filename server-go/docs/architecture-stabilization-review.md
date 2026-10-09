# 架构稳定化：实施中独立审查清单

- 审查基线：原始 `6ffc168` 与本轮正在变更的工作树。
- 状态：**历史独立审查检查点，以下观察保留原貌，不是当前未解决缺陷清单。** 续作已逐项处置并完成最终后端验收；真实位置、迁移与普通/race/原协议/真实客户端/升级回退证据见 [architecture-stabilization-closure.md](architecture-stabilization-closure.md) 第 5–7 节及 [测试迁移表](architecture-stabilization-test-map.md) 第 10 节。旧行号不作为现状依据。
- 所有权：本清单由外层审查者维护；最终集成人在 `architecture-stabilization-closure.md` 登记解决位置与执行证据。`architecture-stabilization-implementation.md` 同样只是前一轮交接快照，已明确标注。
- 产品与现场边界不变：无 UI 测试，不操作现有实例、客户端或用户数据，不改 migration/golden。

## R1｜新消息与新线程回复不能混同

观察点：`internal/message/create.go` 新增 `CreateResult.ThreadReply`，当前检查点的返回值是无条件 `ThreadReply: true`；`application/messaging.sendHumanTx` 对该值执行 `MarkReadLatestTx`。

必须修正为只在**新线程回复**时为真，或以等价的明确类型表达该事实。普通频道、DM、自聊的新消息不能因本次重构新增已读副作用；重放更不能再次推进已读。

验收应通过完整应用入口检查：普通消息不新增该读状态；新线程回复推进作者读游标；成功发送后手动标未读再重放原 randomId，读状态/关注/publication 不变；读推进失败时整笔消息事务回滚。不能只测试结构体字段或修改既有 golden 接受额外副作用。

## R2｜完整频道查询应由 claims 唯一确定观察者

观察点：`application/channelview/read.go` 的 List/Detail/CreateResult 同时接收 claims 和独立 userID；当前检查点验证 claims，却按 userID 查询可见频道及接收者私有状态。

传输层当前传入一致值，不代表新的应用 API 已自行维护该不变式。完整入口应从 `claims.Subject` 派生 actor，删除冗余 userID，或在任何私有查询前严格验证相等。底层接受 caller-provided executor 的批量事实读取仍可显式接收 userID，但不能冒充完整已授权入口。

验收：两个有效人类账号、同空间及跨空间、私有频道与不同 read/mute 状态；有效 A 身份不能被另一个参数变成 B 的观察者。保留现有 HTTP 错误优先级和 403/404 语义。

外层已完成此边界的 red/green：新增 `application/channelview/viewer_authority_test.go`，真实签名/验签 A、B claims，同空间及 A 非成员的另一空间，B 拥有私有频道与 readStateVersion=7；List/Detail/CreateResult 六个负例在修复前全部读取成功。外层只在 `channelview/read.go` 三个完整入口添加 actor==claims.Subject 的前置绑定；修复后六个负例及 B 合法读的正例连续 5 次 race 通过。这是内部新应用入口的加固，当前 HTTP 本来传同一身份；后续收敛 typed API 时可以删除冗余 userID，需保留等价安全覆盖，不能取消绑定。

## R3｜新导出的机器事实服务必须绑定目标与主体

观察点：新 `computer/presence.go` 的 ApplyReady/TouchHeartbeat/RecordStatusTransition 验证 principal，但分别还有独立 facts.MachineID/machineID。原函数是 Hub 私有实现，现在成为导出的领域入口。

需要在同一领域边界确认目标机器等于 principal.MachineID，且仍保留事务内 `ValidatePrincipalTx`。不能仅证明“该凭据有效”，再更新另一个机器 ID。测试同空间/跨空间的两个真实机器、有效 A principal 与 B 目标，要求拒绝且 B 持久状态不变。

另外检查构造器：nil DB 不应经非 nil PresenceStore 包装后绕过 Hub 必需依赖检查。当前 PresenceOptions 中的 `*func()` 仍允许构造后替换 hook，与“依赖已冻结”的注释不一致；改为捕获函数值或把故障屏障放到适当的测试构造/替身中，避免保留指针形式的可变生产接缝。

这些修正不能改变现有 slot → 局部 SQLite 事务的锁顺序。Disconnect 必须继续在吊销事务提交之后调用；不得为了统一接口把心跳套进新的全局 authority fence。

外层已对目标绑定完成 red/green 修复：新增 `computer/presence_target_authority_test.go`，真实签发并验证 Computer 与 legacy machine 凭据，覆盖同空间/跨空间 × ready/heartbeat/status，共 12 个负例（并验证合法 self-target 写入成功）。修复前全部复现 A 凭据可写 B；外层只定点修改了 `computer/presence.go` 三个校验调用并新增 `validatePresenceTargetTx`，在原事务内先验证凭据，再要求目标==principal.MachineID，不新增锁。负例连续 5 次 race 通过，computer/machinews 整包 race 再次通过。构造器 nil DB 和 hook 指针问题仍需集成人处理。

## R4｜不能把旧投影补丁原样搬到 application 就算终态

观察点：`application/channelview/projection.go` 当前仍有 `json.RawMessage`、`any` null/省略字段、ISO 日期字符串，以及“missing map entry means no data supplied”的补丁语义。这与已批准设计 §6.1–6.3 的完整 typed ChannelView 终态不同。

该文件可以是迁移中间产物，但收口前必须完成 neutral facts/read model 与 protocol/client/presenter 的分离。应用读模型表达真实 present/absent、偏好、版本和消息时间事实；wire union、null/缺失、ISO 日期和不同出口字段集合由纯 presenter 输出。readstate 的 ReadFrontierJSONTx/DMReadStateTx、Inbox Wire 和 message/channel 的 wire helpers 也应按设计完成事实/编码分离，而不是换个类型名或返回 []byte 隐藏 JSON。

List/Detail/Create-result 仍须共用 caller-pinned snapshot。保留公告默认静音、collapse 默认值和 list/detail/create 的不同字段集合，不新增逐字段裸 DB 读取或退化成无界 N+1。

## R5｜显式应用事务要保留完整副作用及故障窗口

原发送路径在新线程回复中先自动关注，再推进已读，之后记录消息 publication。当前抽离后的 message.CreateTx 已记录 message/thread publication，应用层随后才推进已读。必须核对持久意图序列及原消费者行为，不能在“原子性仍然成立”之外忽略可观察的事件顺序差异。

按批准设计组织完整用例：领域原语负责自己的事实；应用明确组织新回复的关注/已读和通知记录，重放提前退出。若需要分开记录消息通知，由清晰的事务内原语/typed intent 实现，不恢复可选 hook，不在 commit 后补必需作用。

故障注入必须发生在已经产生部分事务内变更之后，证明消息、mentions、follow、read-state、全部 publication 一起回滚。单纯在第一条写入前返回 404 不足以覆盖这个窗口。

外层已新增 `application/messaging/send_atomicity_regression_test.go` 四个真实应用回归：重放保留后来标未读+显式取消关注；回复的读推进失败回滚此前消息+关注，移除故障后同 randomId 可作为新消息成功；创建线程+首条回复读失败全部回滚；显式 follow 的读失败回滚新线程与关注。使用测试临时库 SQL trigger，先断言事务内新线程/active follow/新回复实际存在，才抛出指定后置故障；对全部实际业务表（包含 authority/activity/publication）做精确行集前后对照，不只比消息数。四个测试已连续 3 次 race 通过。此覆盖补齐被删 hook 回滚场景，但 publication 相对排序/领域表所有权仍需后续收敛。

## R6｜构造完整性不能只靠一次 nil 检查

检查新应用 Service 的依赖字段是否仍可公开替换，以及 Clock/cursor secret 是否仍依靠生产 Set 方法注入。批准方案要求必需依赖在构造时确定，不能构造成功后再改成另一组 stores 或 nil。

需要保留真实的测试时钟/传输替身，但避免公开可变身份、事务和入队策略。检查不同 stores 的数据库/时钟一致性约束，并使用真实应用入口的缺依赖测试验证无法启动半接线构建。

外层已新增 `application/channelview/construction_regression_test.go`，同时验证 messaging/channelview 构造器的缺依赖、零值 Store、来自两个不同真实 SQLite handle 的混合依赖以及合法一致实例。修复前两构造器接受零值/三种混库；外层在两 NewService 中添加非空、同一 DB handle 校验。修复后 channelview/messaging 整包各连续 3 次 race 通过（6.235s / 25.679s）。公开可变字段及构造期 clock/cursor 整理仍由主集成人收口，不能用这次 ctor 检查替代不可变依赖。

## R7｜测试迁移必须准确表述所证明的行为

readstate 中旧 `TestWriteTxRunsCallbackExactlyOnce` 的 wrapper 计数实际是在数调用事务助手的次数，并非业务回调执行次数。删除 setter 后不能用“platform 已测试”作未经核对的替代。

补充或确认 platform 的执行式测试：在成功、主动 rollback、等待锁后取消等场景直接统计业务回调执行次数，且核对持久状态/commit 通知。readstate 的新 `TestWriteTxCommitAndRollbackEffects` 在明确的新 fixture 下应断言精确的通知数量，避免 `summaryWake >= 1` 掩盖重复效果。已有 backlog-full 导致事务回滚的测试必须继续保留。

旧用例 → 新用例/新包的映射需要覆盖真实行为，而不是只比测试函数总数。所有 reference/fresh-wire 均使用只读 check 模式。

外层已补充独立文件 `internal/platform/db/write_callback_once_regression_test.go`（该新文件由外层审查者写入，不修改集成人在途源码）。通过真实共享事务入口验证提交、领域错误、真实唯一约束失败、写入后取消时业务回调恰一次，数据与通知正确提交/回滚；真实 SQLite 写锁等待后取消时业务回调零次。两个测试连续 5 次 race 通过。它解决 platform 回调计数覆盖缺口，不替代 readstate 精确通知数量和应用层跨域回滚验证。

## R8｜实时统一以实际生产路径为准

独立基线审查确认：原 `readstate.ProjectPublication(subjectClaims, ...)` 仅由测试调用；实际 publisher 位于 `app/m4_publications.go`。两者对无 prefs 行、公告默认静音及私有主体缺失的行为并不完全相同。不得因删除重复实现，改用另一套不等价行为。

统一事实读取与编码时保留当前应用发布路径的客户端语义；后台通知不应要求原发送者 access token 继续有效，更不能伪造 Human claims。最终每条连接仍使用自身有效凭据、workspace 与订阅兴趣。

特别核对：serial 在读取快照之前采样；实际 gateway 的同一 admission guard 内检查 serial/current generation/用户与空间交集并有界入队；取消和 guard 获取失败向上传递；慢队列出队再次检查 expiry/generation；公开线程的正文不发给同用户未订阅线程的另一个标签页。

未知或不可投影引用、真实 DB 错误、事实消失的完成/重试规则分别保留；空 publication 批次不得提交清理事务，避免 commit-listener 自我唤醒。

## R9｜领域写所有权与 app 失败清理

核对原 `channel.EnsureThreadTx` 对 `messages.thread_id` 的直接更新。按目标架构，该字段连接应由 message 的明确事务原语配合应用用例完成，保持与线程 ensure/作者关注同事务；不能把跨域写简单藏到新的 application SQL 中。逐项登记真实表/字段写所有权。

基线 app.Build 某些数据库打开后的失败分支只关闭 handle，未释放全局 authority fence 条目；统一逆序清理时可修复，但应单独记录这一既有缺陷及验证，不宣称只是文件重命名。构造失败、重复 Close、维护任务与劫持连接退出、机器断连回调结束后再关 DB，都需要回归。

## R10｜关注与 DM 用例迁移中的测试缺口

检查点：`m4_conversation_http_test.go` 把 `TestM4FollowReadSameTransaction` 改为真实服务调用，这是正确方向，但原“读推进失败则线程/关注全部回滚”的子测试在当前 diff 中被删除。必须在新的应用用例测试中恢复等价故障窗口，例如在隔离测试库的已读写入处触发真实 SQL 失败，验证已经执行的线程创建、关注及通知均回滚；不能只保留成功路径。

新关注成功用例把线程 maxReadSeq 与父消息 seq 比较也不正确：当前 `readstate.latestSeqTx` 明确查询该线程自身消息的 MAX(seq)，空线程得到 0，父消息属于父频道，不应被当成线程已读边界。应依据该线程真实回复设置断言，不能为了让测试过而修改业务游标算法。

新的 DM verbatim 测试只创建空自聊、从同一 owning projector 计算期望，能验证嵌入路径但不能独立证明 wire 正确性，也缺少以前 present 分支覆盖。需要保留冻结 wire/schema 对照，并通过真实消息/已读操作覆盖 present 与 absent，再验证 HTTP create/list 出口；不能用“被测函数计算期望”替代原协议断言。

## R11｜当前 M4 前后程序互读回退测试已由外层新增

外层独立新增 `tests/acceptance/stabilization-rollback.mjs`，无并发改动已有 runner。通过冻结 `6ffc168dd7025a2d5f61416347ecc9937853c3ad` 的 git archive 构建旧程序，由旧程序真实 HTTP 流程创建账号、邀请、公开/私有频道、消息、线程、DM、已读/静音/展示偏好、reaction 与签名 cursor、Agent/Computer 凭据。停机冷复制后，新程序须保留完整可观察状态及旧幂等键、cursor、权限拒绝；新程序写入回复/偏好后，旧程序须直接互读、识别新幂等键并继续写入。

导出入口是 `verifyStabilizationRollback({ executable, capture })`，可接入统一验收 runner 的 all 和独立稳定化 suite/Makefile。直接 `node tests/acceptance/stabilization-rollback.mjs` 会构建当前源程序并执行全流程。

随后扩展了 33 个 route/auth 对照探针（错种 key、未注册 internal、方法/作用域优先级、字面量与尾斜杠、真实未验证账号的低门禁设备入口），先从冻结旧程序采集，再严格比新/回退程序的 status/body/Allow/Location/Content-Type。只对 `/api/servers/` 的滚动 `historyCutoff` 做显式语义归一化：逐次验证真实请求开始/结束时间减 messageHistoryDays 的精确 UTC 毫秒窗口，以及 null/字段形状，再代入标记；这是旧对旧自检发现的时钟字段，不是放宽业务差异。完整 33 探针版本 `--baseline-only` 已通过。冷备份也实际由旧程序恢复检查，不再只创建副本；信号只终止自有子进程，清理错误保留原异常，日志泄密检测覆盖被滚动截掉的早期日志。

**仅用于测试程序自检**的 `--baseline-only` 已实际通过：冻结 M4 与自己往返，证明真实 fixture/断言可在基线上运行。这不是重构实现通过的证据，最终验收不能传这个参数。最终 gate 必须接入默认真实新旧程序对照，并保留现有历史升级矩阵。该文件由外层编写，集成改动可在主写入者收口时协调。

## R12｜HTTP 身份拆分保留真实注册门，不按函数名称猜测

复核基线 `authmw.go`：`Require` 只做有效账号/会话身份验证；`RequireVerified` 实际是 `RequireVerifiedProfileComplete` 的别名（邮箱+资料双门）。不能把 Require 描述或实现为“只验证邮箱”，也不能因别名改名而遗漏资料门。

设备 approve、computer attach、legacy-machines 注册使用 Require；其领域流程可能有额外检查，但本次不得统一升级成全局 RVP。公开 device authorize/token 和 bootstrap `/api/agent/login` 不能误加 Agent-key/Computer-key 门。人类管理 `/api/agents/{id}/credentials` 以及 `/api/servers/{id}/machines` 的创建/修改/删除/rotate-key 均归 humanapi；设备授权/接入交换按批准方案留在 computerapi 的 admission 子面，每个端点保持原 proof。

必须继续覆盖：未知 internal 路径的 401 unregistered 优先于凭据检查；已知未启用面经原门后 501；`sk_machine_*` 合法历史别名与其他错种 key 的区别；公开头像；鉴权/scope/guest 先于 405；`/api/servers/{$}` 和 channels 尾斜杠别名；order/unread-summary 字面量与 `{id}`/子树 fallback；账户 GA 与设备公开面的独立限流实例；preflight 从完整合并注册表推导的 wire 输出。

旧 RunnerHandlers 借用 ComputerHandlers 认证、ComputerHandlers 借用 ServersHandlers scope、Message/ConversationHandlers 借用 ChannelHandlers 的结构关系，需换为认证/领域应用依赖，不能通过新 HTTP 子包互相导入维持原环。

## R13｜批准的结构门禁已由外层新增

外层新增 `tests/architecture/stabilization_contract_test.go`：检查目标生产包存在、生产依赖方向、app/transport 无 SQL 执行及事务调用、transport 不持有 raw sql.DB/Tx/Conn、阶段文件/符号及已退休 setter 不再存在。它们明确标记为结构合同，不声称证明业务行为。当前中间树仍保留 legacyweb、app 实时逻辑等，因而该组测试**预期未通过**；收口前应完成实现，而非豁免旧路径或删测试。

这些门禁不完整证明所有包职责、跨域表写所有权或 DTO 纯度；相应人工审查与业务测试仍然必需。`make architecture-check` 应执行该结构测试包，并保留在最终全套 check 中。

外层随后新增同包 `wire_boundary_test.go`，针对批准方案中的 application/channelview、messaging、realtime 检查客户端 JSON 字段标签、RawMessage/输出编码及旧 SocketMessage*/ReadFrontierJSONTx/DMReadStateTx 编码调用。不会粗暴禁止 domain 的 canonical/cursor/digest JSON，也不扩大到 Daemon opaque frame。当前中间树仍有 31 个相应遗留点，故测试未通过；这要求完成 typed facts/presenter 分离，不能通过改 helper 名字、把 RawMessage 改成 []byte 或新增排除项伪造终态。

## R14｜新会话服务的主体绑定与单连接事务回归已修复

外层新增 `application/messaging/actor_snapshot_regression_test.go`，八个完整会话入口（DM list/create、thread create/summaries/info/followed/follow/unfollow）要求 actor 与 claims.Subject 一致；修复前八项均可传 A proof + B actor 成功，可能修改 B 的关注/DM。外层在 dm.go/thread.go 的完整入口添加显式绑定，不改变 HTTP 已传同一身份的合法行为；未来可删冗余 actor 参数，等价覆盖保留。

同文件新增单连接池回归：CreateThread 与 Unfollow 在已持有 write tx 时调用裸 `Channels.GetChannel`，修复前在 `SetMaxOpenConns(1)` 下确定性超时；外层改为 caller tx 上 `GetChannelTx`。ThreadSummaries/ThreadInfo 的频道存在性读取也迁到它们自身 pinned snapshot 内，保持既有前置错误顺序但不再读取另一个快照。修复后 messaging 整包连续 3 次 race 通过（21.755s），包含上述十个负例及前述跨域回滚/重放检查。

本项是外层对主集成人已新增应用代码的定点纠正，不是并行重写架构；主集成人后续 typed models/构造器整理须保留这些修复及测试。

## 已由外层实际执行的中间检查

以下不是最终集成验收，执行时工作树仍在变更：

- 4 个 platform/db authority/snapshot 用例各重复 3 次 race：通过。
- `go test -race -count=1 ./internal/computer ./internal/transport/machinews`：通过；目标绑定修复后再次通过（computer 9.917s，machinews 22.131s）。
- `go test -race -count=5 ./internal/computer -run '^TestPresenceFactsRejectDifferentTargetMachine$'`：通过，修复前 12 个跨目标子场景全部失败，修复后每个连续 5 次通过。
- `go test -race -count=5 ./internal/application/channelview -run '^TestChannelViewCannotSubstituteAnotherViewer$'`：通过，修复前六个冒用观察者负例全部复现，修复后全部五次通过。
- `go test -race -count=3 -v ./internal/application/messaging -run '^(TestSendHumanReplayPreservesSubsequentUnreadAndUnfollow|TestSendHumanReadFailureRollsBackEarlierMessageAndFollow|TestCreateThreadFirstReplyReadFailureRollsBackEntireWorkflow|TestFollowThreadReadFailureRollsBackThreadAndFollow)$'`：四项各连续 3 次通过。
- `go test -race -count=1 ./internal/readstate`：通过。
- `go test -race -count=1 ./internal/publication`：通过。
- `go test -race -count=5 -v ./internal/platform/db -run '^TestWriteTransaction(CallbackIsNotReplayed|CancelledAcquisitionDoesNotInvokeCallback)$'`：通过，两个顶层测试及提交/错误/约束/取消子场景各连续 5 次。

- `node --check tests/acceptance/stabilization-rollback.mjs`：通过。
- `node tests/acceptance/stabilization-rollback.mjs --baseline-only`：通过，仅测试程序自检，不是新代码验收。
- `go test ./... -run '^$'`：HTTP 大搬迁之前的中间树所有包编译通过；未运行行为测试。后续 HTTP 搬迁期曾因尚未接线的新 testkit/旧 helper/StartJanitor 调用而编译失败，最终必须完整重跑。
- `go test -race -count=3 ./internal/application/messaging`：R14 修复后整包连续 3 次通过（21.755s），含 R5/R10 的真实回滚与后续用户意图保持测试。
- `go test -race -count=3 ./internal/application/channelview ./internal/application/messaging`：构造一致性修复后整包再次各连续 3 次通过（6.235s / 25.679s）。
- `node tests/acceptance/stabilization-rollback.mjs`：HTTP 分包接线后再次实际新旧二进制往返通过，包含全部十一项持久 HTTP 视图、33 个 route/auth 探针、cursor/凭据、原始冷备份恢复及旧程序继续写入。实时/DTO 最终拆分完成后仍需重跑。
- `go test -race -count=1 ./internal/transport/httpapi/...`：搬迁中曾因 Agent test mux 未挂新入口、readstate 测试相对路径失效而失败；主集成人修复后，`go test -race -count=1 ./internal/transport/httpapi/humanapi -run '^(TestAgentAPIServerAndChannelReads|TestCredentialHTTPScopesAndIdentity|TestReadstate.*)$'` 全部通过（8.423s）。最终仍需整套而非该子集。
- `go test -count=1 ./tests/architecture`：当前中间树未通过（仍有 legacyweb、app 实时 SQL 和阶段 runtime 等待迁移），这是未完成项，不是可跳过的环境问题。

最终仍须对收口后的同一工作树重新完成 architecture-check、完整 make check、cross-build、vuln、当前 M4 数据前后程序互读/回退，以及 migration/fixture/client 不变检查；不能把上述局部中间结果当作 M5 放行证据。
