# Go Server 架构稳定化设计

- 状态：设计提案，尚未实施；不能作为重构完成或测试通过的证据。
- 日期：2026-10-08。
- 核对基线：`feat/go-server` / `6ffc168`，工作区 `/Users/lyon/workspace/raft-source`。
- 产品边界：按用户最新确认，M4 已完成，M5 是本轮最后一个产品阶段。本方案是 M5 的前置工程准入，不增加 M6，也不借重构扩展产品范围。
- 配套执行方案：[architecture-stabilization-workplan.md](architecture-stabilization-workplan.md)。
- 本轮交付：设计与执行清单；不修改业务源码、数据库、客户端、依赖和运行实例。

## 1. 决策摘要

在 M5 开始前完成一次有明确终点的结构性重构，而不是只去掉文件名中的 `m4_`，也不是先开发 M5、再慢慢清理。

目标是一个职责稳定的模块化单体：一个 Go 进程、一套现有 SQLite 数据模型、一套现有客户端协议；按业务和协议组织代码，跨模块业务由应用用例协调，底层模块拥有事实，传输层只做协议适配，装配层只管理依赖及生命周期。

必须完成的调整：

1. 去掉生产文件、类型、函数、字段及行为选择中的开发阶段身份。
2. 删除 `legacyweb` 包，建立按身份边界划分的正式 HTTP 适配器。
3. 将 HTTP handler 中的事务编排、查询和权限事实读取移到领域服务或应用用例。
4. 将 `app` 中的频道投影、实时受众计算、发布策略和定时清理移到实际拥有这些职责的包。
5. 消息、频道、已读、实时通知之间使用明确的事务内调用，不保留“父 worker 以后接上”的可变生产接缝。
6. 把客户端 DTO/事件编码与内部事实模型分开；共享消息与接收者私有状态不能共用一个万能 DTO。
7. 为依赖、命名、路由、快照、授权和资源回收建立可执行门槛，全部满足后才开始 M5。

不做微服务化，不替换数据库/Socket.IO 库，不建设通用事件总线、通用仓储或插件系统，不强迫每个已有领域服务再套一层空转发 Service。

## 2. 当前问题及证据

以下路径均相对 `server-go/`，行号以核对基线为准。

| 现状 | 证据 | 调整含义 |
|---|---|---|
| 阶段已经进入真实运行对象 | `internal/app/app.go:26–34,89,136–146`：`m3Runtime`、`m4Runtime`、`m4Realtime` | 不只改文件名，需要重建稳定的装配命名及职责 |
| 频道按历史阶段选择两条代码路径 | `internal/transport/legacyweb/channel_handlers.go:25–37,143–145,357,435–436` | 删除 nil projector 触发的 M3 fallback，不把测试历史作为产品运行模式 |
| HTTP handler 直接开事务/查库 | `channel_handlers.go:61,151`；`m4_conversation_handlers.go:163,304,558,617`；`m4_readstate_handlers.go:57` | transport 不再持有 SQL 执行权和跨域事务所有权 |
| 装配层实现真实频道查询 | `internal/app/m4.go:151–331` | 查询移入频道读模型服务，保持同一 pinned snapshot |
| 装配层包含大量发布业务 | `internal/app/m4_publications.go:106–168,201–343,887–1138` | 持久队列、受众策略、编码和 socket 入队必须有不同所有者 |
| HTTP 身份边界混合 | `agent_cli.go:18–48` 同时注册人类管理接口与 Agent key 接口；`computer_handlers.go:96–138` 包含设备授权与 Computer 接口 | 不能依据路径里含有 agent/computer 就选认证方式 |
| 可变接缝已不再是独立实现需要 | `internal/readstate/store.go:61–177`；`internal/app/m4.go:40–91` | 当前默认绑定已调用共享实现，删除重复接线和误导注释，不宣称仍有多套事务实现 |
| 线程回复的必要业务作用通过可选 hook 完成 | `internal/message/create.go:29–64,135–175` | 提升为应用用例中的显式同事务步骤，重放不能再次推进已读 |
| readstate 事件形状存在两个实现位置 | `internal/readstate/projector.go:53–167` 与 `internal/app/m4_publications.go:887–1138` | 统一事实投影与编码；二者鉴权入口不同，不能机械选一个复制 |
| app 不只在 M4 文件中含 SQL | `internal/app/app.go:227–273`：readiness 和 janitor | 清理应覆盖整个装配层，不只重命名几个新增文件 |
| Daemon transport 也拥有持久事实 | `internal/transport/machinews/store.go:25–239`、`config.go:67–96`：ready/heartbeat/status SQL 与 Config.DB | 将持久机器事实移回 computer；保留 Hub 连接代际状态机，不能漏过 transport 无 SQL 的终态 |

原架构 `docs/architecture-and-phase-1.md:9–36` 明确要求独立 Go Server、原客户端协议适配，而不是请求旧 TS Server 完成业务。`legacyweb` 的来历合理；本次删除的是过时包边界，不是删除协议兼容能力。

当前 `legacyweb` 有 46 个生产 Go 文件和 45 个测试文件。阶段文件检查还必须包括 `m3.go`、`m4.go`，不能只匹配 `m4_*.go`。文件数量用于盘点，不作为架构优劣或验收的唯一指标。

## 3. 目标目录与依赖方向

以下是最终组织方式。`delivery` 仅标记 M5 的归属，现在不创建空包、空表或假实现。

```text
internal/
  app/                          # 唯一组合根：构造、启动、ready、关闭
    app.go
    services.go
    http.go
    execution.go
    realtime.go
    lifecycle.go
    health.go

  application/                  # 仅承接真实跨模块用例，不是通用大 Service
    messaging/                  # 人类发送、创建线程/首条回复、关注与已读联动
    channelview/                # 列表/详情/创建出口的授权读模型
    realtime/                   # 当前事实投影、受众策略、持久发布分派
    machinecontrol/             # Agent/Computer/catalog 的机器事件协调

  auth/                         # 账号、会话、验证、维护任务
  workspace/                    # 空间、成员、邀请、setup
  channel/                      # 频道/DM/线程、关系、可见性与关注事实
  message/                      # 消息、幂等、mentions、reaction 与历史事实
  readstate/                    # 已读、偏好、Activity/Inbox 事实与算法
  agent/                        # Agent 身份、凭据、生命周期
  computer/                     # Computer 身份、接入、凭据及机器 presence 持久事实
  runtimecatalog/               # Runtime 元数据及请求关联
  publication/                  # 从 internal/realtime 改名：持久通知引用及调度
  # delivery/                   # M5 实现时新增：Agent 收件、ACK、重试、游标

  protocol/
    client/                     # 现有客户端的 DTO、union、事件词汇、纯编码类型

  transport/
    httpapi/
      router.go                 # 唯一 HTTP 总装配和路由清单校验
      httpx/                    # request-id、限额正文、响应、通用 HTTP 工具
      authn/                    # HTTP 凭据提取/验证，调用身份所有者
      humanapi/                 # 账号入口、人类管理及聊天 API；按功能分文件
      agentapi/                 # sk_agent 认证的 Agent API
      computerapi/              # sk_computer 接口及 Computer 接入交换协议
    presenter/                  # 业务读模型 -> protocol/client 的纯映射
    socketio/
      core/                     # 保留已有连接/房间/队列/恢复状态机
      zishang/                  # 保留已有第三方 wire binding
      bridge/                   # 实现应用发布端口、鉴权/订阅/恢复适配
    machinews/                  # 保留连接状态机/wire；通过必需 Facts 端口持久化

  platform/                     # 保留现有 db/clock/config/keys/mail 等
```

### 3.1 编译依赖规则

- `app` 可以依赖下面各层；下面任何生产包不得反向导入 `app`。
- transport 可以调用应用用例和已有领域服务；不得执行 SQL、开事务或写业务表。
- application 可以依赖领域模块、`publication`、platform；不得依赖 transport、Socket.IO 库或客户端 DTO。
- 领域模块不得导入 application、transport、protocol。已存在且有实际用途的领域间依赖可保留并列入白名单，例如 message/readstate 调用 channel 权限事实，agent 使用 computer 绑定事实。禁止形成循环。
- `publication` 只依赖 platform/标准库，不依赖业务领域、应用层或 transport。
- `protocol/client` 是纯协议叶子包，不导入应用/领域/数据库；`presenter` 可以导入读模型与协议类型，但不读数据库、不鉴权、不发送网络。
- `httpapi` 根包依赖叶子适配器；叶子可以依赖 `authn`、`httpx`，不能反向依赖根包或彼此的业务 handler。
- `socketio/bridge` 可以导入 socketio/core、application 和 presenter；socketio/core 与 zishang 不得反向导入 bridge。

领域内部继续允许 Service/Store 与 SQL 同包。当前不是建立纯 DDD 教科书模型，也不是给每张表创建 Repository 接口。

## 4. HTTP 包重建：按身份而不是路径单词分类

### 4.1 终态职责

| 入口 | 所属 | 身份与规则 |
|---|---|---|
| 注册、登录、邮箱验证、refresh/logout | humanapi 的 account 文件 | 明确公开/令牌交换策略，不能套一个统一的“已登录”门 |
| workspace/channel/message/readstate、人类管理 Agent 与机器 | humanapi 的对应功能文件 | 逐路由保留当前 verified/profile/scope/guest 要求 |
| `/internal/agent-api...` | agentapi | Agent credential、scope、绑定及撤销校验；不能接受人类 JWT 替代 |
| `/internal/computer...` 和 runner 管理 | computerapi | Computer principal、机器/Agent 绑定、密钥撤销及 current generation |
| device authorize/token、attach、bootstrap exchange | computerapi 的 admission 文件 | 逐端点使用公开交换凭据或人类授权证明，不因包名而统一按 Computer key 放行 |
| `/daemon/connect`、`/socket.io/` | 独立 transport，在总入口挂载 | 保持原协议与升级中间件，不纳入普通 JSON body 包装 |

`/api/agents/{id}/credentials` 是人类管理接口，不移到 Agent-key API；`/api/agent/login` 是 bootstrap 交换，不因路径包含 agent 就接受任意 Agent key。设备 approve 的现有认证链也不能被顺手强化成另一套协议。以实际 handler 和客户端合同为准。

### 4.2 路由所有权

每个入口只注册一次，并生成或核对一份简单的 route manifest：method、pattern、身份策略、scope、限流策略、能力状态、handler 所有者。它是清单与测试输入，不是新建配置驱动路由框架。

总路由统一处理已知/未知表面，叶子负责自身端点的 method fallback。保留精确路径优先、trailing-slash alias、405 `Allow`、鉴权先于方法拒绝的既有顺序。检查路径重复、通配路由遮蔽和保留接口遗漏，不只检查 method+path 字符串完全重复。

删除 `RegisterAdditional` 中“按阶段接入”的含义及 `ReadstateRoutes` 这类为了旧测试保留的开关；正式构建必须挂载已实现的全部核心能力。未来尚未实现的业务仍返回原有 404/501，不以清理为名伪造成功。

### 4.3 Handler 与鉴权职责

handler 负责解析路径/header/body、保留输入形状差异、调用一个业务入口、映射响应。HTTP 凭据解析留在 `authn`，身份有效性和资源权限事实由 auth/agent/computer/channel/workspace 等所有者提供。

请求上下文使用明确的 Human/Agent/Computer 证明，不使用一个含模糊 userID 的万能上下文。证明只来自验证器；可导出的结构体不等于可信能力，领域/用例仍须在事务内复查撤销、绑定及权限。不能把已验签当作永久授权，也不能把 Agent ID 塞进 Human claims 绕过类型区分。

不为所有端点强制同一认证链；现有账号资料门禁、设备流和 CLI 管理流的差异必须逐条保留。

## 5. 应用用例：消除跨模块可选 hook

### 5.1 消息发送的唯一完整入口

将完整人类发送行为放在 `application/messaging.SendHuman`。保留 message 内的事务内持久化原语，但名字必须说明它只是事务内步骤；不再保留一个看似完整、实际可能没有推进已读的生产 `message.Store.Create` 旁路。

执行顺序：验证过的 Human 证明 -> 一个 `db.WithWriteTx` -> 事务内身份/频道权限复查 -> 幂等判定及消息创建 -> 新线程回复的自动关注与已读推进 -> 同事务 publication -> commit -> 返回结果。输入验证与错误优先级按现有合同保留。

关键规则：

- 用 `CreateResult.Replayed` 区分新写入和重放。重放不重新关注、不再次标已读、不产生新 publication 或未来 delivery。
- 自动关注所有权仍在 channel；已读算法仍在 readstate；应用只决定调用顺序，不直接写它们的表。
- 创建线程及首条回复调用同一个事务内发送步骤，不在事务中调用另一个会自行开事务的公开用例。
- 显式 follow 与 mark-read-latest 同事务；任何必要步骤失败全部回滚。
- 去掉 `SetThreadReplyReadHook`、`HasThreadReplyReadHook` 作为完整性保证的方式；完整性来自唯一的应用路径和端到端回归。
- 不将必要同步作用改成内存事件、post-commit listener 或异步任务。

### 5.2 依赖在构造时确定

readstate 默认实现目前已调用共享 db/auth/publication，重构不是另写这些算法。删除生产 `SetWriteTx`、`SetReadSnapshot`、`SetValidateHuman`、`SetEnqueue` 及重复的同形结构转换；直接复用共享实现，或在确有测试需要时用构造期不可变的小接口。

生产必需依赖缺失，构造失败；不允许 nil 代表“旧阶段”“未接线但可启动”。Clock、cursor key、mail、网络发送器等真实外部依赖在 Options 中注入。测试错误注入使用测试专用构造/替身，不开放启动后可替换身份规则和事务实现的 setter。

已有安全、完整的单模块操作可由 handler 直接调用其服务；不为机械分层创建一层只有一行转发的 application 包。

## 6. 查询、DTO 与领域事实

### 6.1 ChannelView 的终态

`application/channelview` 拥有 List/Detail/Create-result 的完整读模型。它在一个 pinned read snapshot 内加载可见频道、参与者上下文、已读、mute/display 和最后消息信息。

优先由 channel/readstate/message 提供接受同一 executor 的批量事实读取方法，例如 `ViewerStatesTx`、`LastMessageFactsTx`。多个模块的 JOIN 确有必要时，允许在明确的应用 query 文件中做只读联查，登记依赖的表和字段；这不是写权限，也不能重新实现另一套频道授权。

不得从快照回调里拿裸 DB 再读，也不得将批量查询退化成无界的逐频道查询。分页和查询工作量保持有界；测试比较基线查询数量/预算，不能仅凭目录变漂亮宣称性能改善。

### 6.2 三种模型明确分开

1. **领域事实**：消息、read frontier、偏好、成员关系；使用业务类型，不承担 `null`/省略等客户端表达。
2. **应用读模型**：当前用户可见的完整查询结果，包含明确的 present/absent 信息及数值，不依赖 HTTP 或 Socket.IO。
3. **协议 DTO**：`protocol/client` 的数值/字符串、union、nullable、v1/v2 envelope；由 presenter 纯转换。

`M4ChannelProjection` 不只是改叫 ChannelProjection：transport 中的接口和 `app.projectChannels` 都被真实查询服务替代；不再返回一个“可能没提供字段”的补丁 map 来修饰旧阶段默认值。

删除 `listM3/getM3` 和旧 create fallback。正式代码只查询真实数据；新账号/空频道自然得到 absent/0/null，不依赖阶段分支。公告频道默认静音、collapse 默认值、列表/详情/create 的不同字段集合仍是当前协议要求，必须保留。

### 6.3 共享与私有编码唯一化

HTTP 与 Socket 共用消息基础 DTO 和纯 mapper，但调用不同出口：发送响应、历史页、同步页、共享事件、viewer 私有事件不能被压成同一个大对象。

将 `message/dto.go` 中 UI wire 结构、`SocketMessageUpdatedInContext`、channel 的对外 Wire、readstate 的 `ReadFrontierJSONTx` / Inbox Wire 等按“读取事实”和“编码”拆开。领域返回 typed facts，presenter 输出客户端 DTO。禁止 application 导入 DTO 以避免 application -> transport -> application 的环。

领域中用于幂等 digest、cursor 签名、Activity token 的 JSON/canonical 算法不是普通 HTTP 编码，不能因清理 DTO 而改变。检查约束针对 wire 所有权和依赖，不粗暴禁止整个领域导入 `encoding/json`。

## 7. 实时系统：持久引用、策略和传输解耦

### 7.1 三个明确所有者

- `publication`：现 `internal/realtime` 改名后的持久引用队列。负责同事务 Enqueue、去重、backlog、扫描、重试和清理。保留数据库表名 `realtime_publications`、列、索引、事件字符串和已落库数据。
- `application/realtime`：按引用读取当前事实，计算受众和私有所有者，决定可投影/已消失/应重试/永久无效。按 message、channel、readstate、audience 分文件，不重新制造一个千行 dispatcher。
- `socketio/bridge`：将语义通知转换为 wire，在实际 gateway 的同一准入保护下检查 serial、连接身份、workspace、room interest 并入队。核心状态机、zishang wire binding 和慢队列出队保护保留。

`readstate.ProjectPublication(subjectClaims, ...)` 与目前 app 中实际使用的状态事件投影不能同时作为权威。将它们收敛为一套当前事实读取及一套 presenter；测试迁移到相同路径。后台 publication 不依赖原发送者 access token 继续有效，不伪造 JWT；私有对象靠 owner/scope 当前事实，最终每条连接用其自身有效身份校验。

### 7.2 发布端口的安全合同

应用层定义窄的 `NotificationSink`，输入为语义通知：事件种类、typed data、workspace、已授权用户集合、私有 owner（如有）、订阅兴趣要求、authority serial。输出表示处理/入队结果或可重试错误，绝不叫 `Delivered=true`。

端口不暴露 `socketio.Gateway`、`core.Identity` 或 `channel:<id>` 字符串。兴趣表达为 channel/thread 的语义 ID，由 bridge 映射到原 room。

最重要的实现要求不是接口名字，而是下列顺序：

1. 在读取快照之前采样 authority serial，随后在一个快照内取得事实与受众；不能在读完旧快照后把新 serial 贴上去。
2. payload 构造与 SQL 在短 fence 外执行。
3. bridge 在 gateway 同一 admission guard 内核对 serial、当前连接 generation、身份、workspace、订阅兴趣，并执行有界非阻塞入队。
4. serial 变化、获取 guard 失败、取消或序列化错误向上传递，保留 durable intent 重投影；禁止 `CanSend()` 和 `Send()` 分离造成竞态。
5. 慢队列真正交给网络前再次校验当前 generation/expiry；已在有效授权下写入网络的数据不能撤回。

共享事件不含 receiver-private read/mute/reaction-viewer 数据；私有事件限定 user 与 workspace 的交集。公开线程仍区分显式查看的 socket 和同用户其他标签页，关注者/计数受众也不能混同。

### 7.3 完成语义不得“美化”

当前队列的 `published_at`/Published 是“本轮引用已处理”，不证明浏览器收到或 Agent 消费。保留语义和存储兼容。

已删除/失权的事实可以无需发送而处理完成；无在线浏览器不是 Agent delivery 失败；真实数据库错误不能当作事实不存在。未知或永久无效引用保持现有有界重试及可观测停放。当前 PARKED 是日志/计数与处理终结语义，并非本次设计可以凭空新增的持久状态表；若要增加持久 DLQ，另行评审 schema，不能混入无 schema 重构。

## 8. 底层基础设施与生命周期

`platform/db` 的共享实现保留，尤其是 `transactions.go:74–110,141–210`：写回调恰执行一次；事务内禁止网络/嵌套写事务；commit 后、释放 authority fence 前发布 generation；释放后通知 listener；read snapshot 使用 pinned connection 与 deferred/query-only，并清理取消后的连接状态。

不为了目录纯洁再抽一个并行 TransactionManager，不重新实现授权围栏，也不把数据库提交重试变成重放整个业务回调。

### 8.1 Daemon 持久事实与连接状态拆开

当前 `machinews/store.go` 的 machineFacts、ready/heartbeat/status 写入及机器是否存在查询，移到 `computer/presence.go` 等领域文件。Hub 依赖构造期必需的 MachineFacts 端口，提供 ApplyReady、TouchHeartbeat、RecordStatusTransition、Exists；输入为已验证 Computer principal 与 typed observation，输出为业务状态，不能暴露 SQL handle。`Config.DB` 删除，替换为明确的事实服务依赖。

保留原有连接 slot/generation/current-owner 屏障与有界回调时序。事实调用必须在当前连接仍有效的原保护范围内同步完成，事务内仍复查 principal；不能改成释放 slot 后异步写入，否则旧连接可能覆盖新状态。保留 ready 重试、heartbeat、状态时间单调、快速重连在线连续性、Computer 版本刷新和撤销竞态的既有行为。

这些现有单模块 presence 写入当前使用短的局部 SQL 事务，搬迁时保留其锁序，不机械套入另一把全局 authority fence。跨域消息/已读及影响浏览器授权的写入仍走既有共享 WithWriteTx。presence 写入字段与授权触发器须形成明确清单；若涉及新增授权影响，必须先设计并验证 slot -> DB/fence 的锁序，而不是把所有写操作统一加锁就宣称更安全。本次结构重构不新增此类字段或状态含义。

Socket bridge 也不直接复制 app 里的 SQL：握手 membership、room eligibility、resume、heartbeat 的事实读取交给应用/领域；bridge 仅转换协议和调用已注入的 generation/guard 能力，不再从 transport 裸读数据库。

### 8.2 组合根及资源回收

`app` 最终只持有组件和生命周期。复杂机器事件协调从 `m3.go` 移到 application/machinecontrol，已有 agent.Service/runtimecatalog.Broker 继续复用；不在装配闭包里新增业务判定。auth janitor SQL 移到 auth 的维护服务；schema readiness 移到 platform/db 的检查函数；app 只汇总健康状态。

生命周期约束：先完成构造与必需依赖验证，再启动消费者/注册 listener，最后对外 ready。构造中途失败，按实际已创建资源的逆序清理。

正常退出先停止新入口/新业务工作，再停止发布扫描及心跳/维护任务；已升级连接由各 transport 显式关闭，不依赖 `http.Server.Shutdown` 自动关闭 WebSocket。保留必要的机器断连回调落库，等待所有仍可能访问数据库的 worker/callback 结束，再关闭数据库并释放 authority fence。取消/关闭可重复，超时不得被包装为成功；不必强行清空 durable backlog，重启恢复即可。

## 9. M5 的稳定接入边界

M5 的实现仍要核对原 CLI/Daemon 的实际 delivery/ACK 协议；本方案不虚构新的帧格式，也不宣称现有 Daemon 已支持所需 ACK。

稳定的归属为：

| M5 新能力 | 接入位置 | 不得侵入 |
|---|---|---|
| Agent mention 解析及可唤醒性 | messaging 用例协调 message/channel/agent 的事实能力 | HTTP handler 自己查表/决定收件人 |
| 消息与 Agent 收件记录原子写入 | 同一 messaging write transaction 调用 future delivery 的事务内计划方法 | commit 后才临时创建必需的 delivery |
| Agent 发送/回复 | agentapi 验证 Agent proof，调用明确的 SendAgent 用例 | 假装 Human、复用用户 JWT |
| Agent 队列、ACK、重试、delivery cursor | 独立 delivery 模块，复用平台事务 | browser publication 队列、message.seq |
| Daemon 帧与当前连接代际 | machinews 传输边界与 machinecontrol 协调 | app 中散落帧判定或无身份的通用回调 |
| 生命周期/消息唤醒策略 | 通过已有 Agent/Computer 服务及明确命令端口 | socket room 被用作 Agent 事实来源 |

“message persisted / notification processed / daemon received / agent input accepted / task completed”是不同状态，不能用一个 send-success 布尔值覆盖。ACK 必须关联真实当前主体、连接/启动代际和稳定 delivery ID，最终字段以 M5 协议核对结果为准。

现在不建立空 delivery 表或 no-op planner。M5 到来时新增业务模块并在既定用例事务中显式调用；这属于正常扩展，不需要再次重拆 HTTP 身份、事务、投影或 app。

## 10. 命名、文档与兼容不变量

生产符号按职责命名，例如 `MessageHandlers`、`ConversationService`、`ChannelView`、`PublicationDispatcher`。不保留 `M4MessageHandlers` type alias、`RegisterM4...` 转发函数或 `legacyweb` wrapper 作为终态；过渡代码只允许在重构中间步骤存在。

历史阶段信息合理保留在：设计/验收原稿、冻结 reference/升级数据、旧二进制来源、发布 Stage 元数据。版本化协议 v1/v2、migration 编号以及第三方模型名中的 M3/M4 不是清理对象。Stage 只描述发布，不决定 handler/query 走哪套实现。

`contracts/m4/` 和 `contracts/legacyweb/` 当前含冻结来源与验收资料，不能全局重写其内容。新建按能力索引的 `contracts/client/manifest.json` 指向唯一的原 fixture，并记录来源/hash/消费者；不复制出两套会各自漂移的 golden。迁移脚本入口时同时迁移引用与测试选择器，保留原始证据可追溯。

本次重构预期 schema 变更数为零：不改 migration 0001–0013，不改表/列/索引、JWT/key derivation、cursor/digest 规则、路径、响应字段、事件、鉴权顺序、默认配置或客户端依赖。发现必须改业务行为时，记录为独立修复，不偷偷用新 golden 接受变化。

## 11. M5 准入门槛

只有以下条件全部满足，才认为底层稳定化完成：

- 生产中不存在 `legacyweb` 包/导入、阶段 runtime、阶段命名业务 API、M3/M4 双轨 handler。
- transport 无直接 SQL/事务/Store.DB 读取；app 无业务 SQL、payload 投影、受众策略或消息持久化。
- 领域/application 不导入 transport、客户端 protocol 或 Socket.IO 第三方库；publication 不依赖领域。
- 每个 HTTP endpoint 有唯一所有者及明确认证/method/fallback；错种凭据、跨空间、撤权和未支持表面的结果保持原合同。
- 同一业务只有一个必要副作用路径：线程回复/关注/已读/publication 原子，幂等重放无重复作用。
- 快照、authority fence、per-socket 兴趣、共享/私有 payload、当前 generation 和取消传播回归全部通过。
- 真实客户端协议、fresh Go wire、reference reducer、全量普通/race 测试、升级/回退、构建及依赖检查通过；不得用新的 golden、skip 或只跑子集掩盖失败。
- 0001–0013 hash、客户端源码/锁文件和运行现场保持不变；当前 M4 数据的副本可由新旧二进制读取并完成约定操作。
- 更新后的架构文档与实际依赖图一致；测试/fixture/历史引用有明确迁移表，无永久遗留 wrapper。

结构检查不是行为正确性的证明。AST/import/SQL 检查与集成/race/协议测试必须同时成立。

## 12. 实施方式与本轮状态

按配套工作计划进行多个可审查、每步能编译并验证的变更批次；不是一次性全目录替换，也不把必需步骤拖到 M5 后。重构期间暂停在相同底层文件中并行开发 M5；模块内任务可在契约冻结后并行，共享路由/构造/协议清单由集成人单点修改。

工作区既有 `gui-test-screenshots/`、`server-go/docs/m3-ui-acceptance-report.md`、`server-go/var-backup-m2-20261008-1902/`、`server-go/var-m3-dev/` 不归本任务所有，不清理、不迁移、不覆盖。测试必须使用自建临时数据与端口。UI 测试仍由用户指定协作者负责，后端准入不伪称 UI 已签收。

本轮只核对了源码、文档和 Git 状态，未执行构建或测试。尝试的独立只读审查未得到有效输出，不计为第二方验证。上述门槛均是后续实施要求，而非已通过声明。
