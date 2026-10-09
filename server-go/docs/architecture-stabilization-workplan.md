# 架构稳定化执行与验收计划

- 状态：**全部工作包已收口并完成最终后端验收**。本文件保留原执行计划；实际改动、独立审查处置、同树 `make check`/交叉编译/漏洞扫描结果见 [architecture-stabilization-closure.md](architecture-stabilization-closure.md) 第 5–7 节。未提交、未推送，不代表 UI 或 M5 新业务已经签收。
- 关联设计：[architecture-stabilization-design.md](architecture-stabilization-design.md)。
- 基线：`feat/go-server` / `6ffc168`。
- 完成定义：全部工作包收口之后，才能开始最后一个产品阶段 M5。工作包是工程执行顺序，不是新的产品 phase，也不能进入生产符号命名。

## 1. 范围和变更纪律

范围限于 Go Server 结构、必要的测试/工具引用和文档。客户端源码、锁文件、迁移 0001–0013、生产/协作者数据、现有运行实例均不改。

先固定目标契约，再移动实现；每个工作包完成时可编译并运行其责任测试。不能把全局重命名、鉴权变化、schema 变化和新功能放进一次无法定位的改动。发现真实 bug，单独列缺陷及修复证据，不能改 golden 让结构重构“通过”。

一个集成人拥有公共构造器、路由总装、共享事务类型、protocol 清单、Makefile 和最终验收。各工作者只有明确文件所有权；同一函数不得并行由多个工作包修改。下面保留原角色分工建议；最终执行与交接状态以收口报告为准。

## 2. 工作包与依赖

| 工作包 | 责任 | 必须交付 | 完成后才放行 |
|---|---|---|---|
| baseline | 集成人/测试负责人 | 当前构建与行为基线、路线与身份清单、数据/迁移 hash、测试用例映射 | 其余工作包 |
| contracts | 领域与协议负责人 | neutral facts、wire/presenter 所有权、构造与事务签名、查询与发布端口约定 | 依赖这些接口的抽离 |
| http-boundaries | HTTP 负责人 | humanapi/agentapi/computerapi/httpx/authn 分包、唯一注册、主体不混用 | 对应完整 HTTP 验收 |
| messaging-queries | 消息/读模型负责人 | 唯一完整发送/线程用例、无 hook 旁路、统一 ChannelView、无 M3 fallback | 消息/快照/幂等全链路 |
| realtime-boundaries | 实时负责人 | publication 改名、唯一状态事件投影、应用分派器与安全 Sink、socket bridge | race/真实客户端恢复 |
| machine-facts | Computer/Daemon 负责人 | machinews 持久事实移入 computer、必需 Facts 端口、slot/事务锁序保持 | 原 Daemon ready/heartbeat/revoke 竞态 |
| bootstrap-lifecycle | 集成人与身份模块负责人 | app 纯装配、机器事件协调、auth maintenance、启动失败及退出清理 | 生命周期回归 |
| closure | 集成人/独立审查者 | 清除过渡代码、结构门禁、全量验收、更新当前架构及交接 | M5 |

`contracts` 先冻结事实类型及接口，不要求一步搬完全部实现。HTTP 分包与 messaging/queries、realtime 的专属实现可以并行；尚待用例抽离的 handler 不得被错误宣称“已完成薄化”。涉及公共 constructor 的落地由集成人协调，最终每个 handler 必须符合无 SQL 的终态。

## 3. baseline：冻结什么

### 3.1 源码和行为

记录当前 HEAD、tracked diff、现有未跟踪内容，不把协作者文件纳入重构清理。以已提交源码在临时目录构建当前 M4 基线二进制；依赖不可用或基线失败要如实登记，不能引用旧报告代替本轮基线。

至少采集：

- HTTP 路由的 method/pattern、精确/trailing-slash/通配匹配、主体、认证链、scope/guest、限流及已知未启用面。
- 账号、workspace、Agent/Computer/Runner、消息、DM/thread、readstate/Activity 的正例和负例响应。
- 真实原 Socket.IO 客户端、Computer/Daemon 客户端的现有非 UI 协议结果。
- 当前数据库 schema/migration checksum、关键表内容、凭据与游标兼容结果。
- 命名/导入/SQL 访问基线及测试清单：旧用例名称 -> 目标用例/覆盖点 -> 调用脚本。

JSON 对比必须保留字段集合、缺失/null/零值、数值与字符串、数组顺序、envelope、机器码与错误优先级。只对预先声明的随机 ID、时间戳等做精确 normalization；不能把权限字段、计数、revision、cursor 或未知新增字段统统忽略。

### 3.2 数据与回退验证

从当前 M4 二进制生成临时真实数据，覆盖消息、reaction、已读、mute/display、DM/thread、publication pending、Agent/Computer 凭据和邀请。对其冷备份副本分别用重构前/后程序检查。绝不打开用户的 var* 目录做实验。

重构应保持 schema 不变。验证新二进制在副本读写后，旧 M4 二进制仍能打开并执行约定操作；原 M1/M2/M3 升级链测试另保留。这里验证的是回退兼容，不是执行生产回退或降级 migration。

## 4. 文件与职责迁移清单

路径相对 `server-go/`。这是职责映射，不是把整文件机械搬到一个目标后就算完成。

| 当前文件/对象 | 终态归属与处理 |
|---|---|
| `app/m3.go`、`m3Runtime` | 组件构造进 `app/execution.go`；机器事件协调进 `application/machinecontrol`；移除阶段类型 |
| `app/m4.go`、`m4Runtime` | 构造进 `app/services.go`；发送/线程组合进 `application/messaging`；`projectChannels` 进 `application/channelview` |
| `app/m4_socket.go` | 装配/组件生命周期留 `app/realtime.go`；鉴权/rooms/resume/guard 等适配进 `socketio/bridge`；业务查询交回应用/领域 |
| `app/m4_publications.go` | 拆为 `application/realtime/{dispatcher,audience,message_events,channel_events,readstate_events}.go`；wire 类型进 protocol/presenter；guard 入队进 bridge |
| `app/app.go` 的 janitor/ready SQL | auth maintenance 和 platform/db readiness；app 只启动/汇总 |
| `legacyweb/routes.go` | `httpapi/router.go`，由功能注册器组成，删除阶段能力切换 |
| `legacyweb/authmw.go`、通用 middleware/respond | `httpapi/authn` 与 `httpapi/httpx`；HTTP 身份提取和领域验证分开 |
| `legacyweb/auth_*`、profile、workspace/invite、avatar | humanapi 按功能分文件；文件存储相关代码放在明确的 adapter/store 文件，不纳入通用 httpx |
| `legacyweb/channel_*.go` | humanapi/channel handlers；SQL/事务/关系权限查询移到 domain/application；DTO 移 presenter |
| `legacyweb/m4_channel_projection.go` | 被完整 ChannelView 读模型与 mapper 取代，不只改名保留 patch map |
| `legacyweb/m4_conversation_*.go` | humanapi/conversation；事务和跨域回调移 messaging；DTO 移 protocol/presenter |
| `legacyweb/m4_message_*.go` | humanapi/message handlers/routes/ratelimit；读写用例移 messaging 或已有完整查询服务 |
| `legacyweb/m4_readstate_*.go` | humanapi/readstate；直接 DB membership 查询移资源所有者 |
| `legacyweb/agent_cli.go` | 必须按函数拆：人类管理/凭据注册留 humanapi；whoami/server/channel-members 等 Agent key 表面进 agentapi |
| `legacyweb/agent_handlers.go`、agent DTO/form | humanapi 的 Agent 管理；已存在 agent.Service 继续复用；协议形状进 presenter |
| `legacyweb/computer_*.go` | 人类机器管理进 humanapi；接入交换和 Computer key 内部表面进 computerapi；主体按路由保留 |
| `legacyweb/runner_handlers.go` | computerapi；认证依赖 computer/agent 的领域方法，不再依赖另一个 HTTP handler |
| `legacyweb/runtime_catalog_handlers.go` | humanapi；catalog/broker 事实与关联逻辑仍在 runtimecatalog |
| `machinews/store.go`、`Config.DB` | SQL 与机器持久状态移 `computer/presence.go`；Hub 使用必需 Facts 接口，保持 current-generation/slot 保护内调用及事务内 principal 复查 |
| `internal/realtime/publications.go` | `internal/publication`，更新 import；不改表名、事件值和已持久化引用 |
| message DTO/socket map、channel Wire、readstate JSON/Wire | 分离事实查询、算法与输出编码，统一到 neutral facts + protocol/client + presenter |

其余 `legacyweb` 文件必须逐个分配到 HTTP 子包、领域/应用或 presenter；禁止把未想清楚的代码放进新的 `legacy`、`compat_misc`、`common_services` 大包。

## 5. contracts：先冻结的内部接口

接口名以实现评审为准，下面是语义要求，不是已经存在的可编译 API。

### 5.1 SQL 与执行上下文

共享 `db.Queryer`/`db.Executor` 类型，消除仅为 worker 协作复制的同形接口。查询接受 caller-provided executor；事务内写方法明确接受 `*sql.Tx`。函数回调签名也统一，不能因为 Go 接口方法集合相同就假设不同函数类型可直接互换。

read-only 接口是工程约束，实际只读性仍由现有 deferred/query-only 事务保证。所有者通过 Tx 方法修改自己的表；应用层组织跨模块事务，已有完整的单模块操作可保留其事务入口，禁止 handler 或其他模块直写外域表。

machine-facts 必须记录 ready/heartbeat/status 的持久字段、授权触发器影响及 slot/DB/fence 锁序。迁移保留现有局部短事务，不能机械增加全局锁，不能把受 current-generation 保护的同步落库改成保护外异步操作。所有必须涉及浏览器 authority 变更的写入仍使用既有共享围栏路径。

### 5.2 完整用例与局部原语

`SendHuman`、`EnsureThreadWithReply`、`FollowThread` 是完整应用操作。事务内消息创建原语返回消息、`Replayed`、已解析 mentions 及必要的 typed context；应用据此执行既有关注/已读联动。不能为了提取而新增重复权限查询或改变验证次序。

顶层完整消息写入旁路迁移后删除；低层单元测试仍能测试存储原语，但不能将“只写一行消息”当作完整发送语义。没有客户端 randomId 的请求不凭空获得新的幂等语义。

### 5.3 读模型与发布端口

ChannelView 返回完整 typed facts；批量调用同一 snapshot 的 readstate/message/channel 查询。ReadFrontier 的 present/absent、共享 MessageFacts 与 ViewerFacts 分开建模。

NotificationSink 的所有权在应用层，bridge 实现。使用同步、返回错误、有 context 的单次“校验并有界入队”语义；签名不得将公开 `Publish` 与外部 `CanSend` 拼成两步，不把旧快照伪装成当前授权。

跨层错误用可分类原因与明确机器码传递；HTTP status/body 映射在 adapter，传输错误/资源不存在/权限拒绝不混同。重构不能借此统一掉现有各入口不同的错误优先级。

## 6. 必测行为矩阵

| 主题 | 必须覆盖的回归 |
|---|---|
| 错种凭据 | Human JWT、Agent key、Computer key、bootstrap/device proof 相互误用均按原合同拒绝 |
| 路由细节 | `/api/channels/dm` 与 `{id}`、原尾斜杠 alias、405 Allow、未知 internal API、认证/guest 与 method 拒绝顺序 |
| 构造完整性 | 缺必需依赖不能启动；空频道走真实查询；不再有 nil projector 返回旧 fixture |
| 消息原子性 | 首条/普通线程回复、关注/已读/publication 任一步故障全回滚；幂等重放无重复作用；跨 workspace randomId 冲突不泄漏原消息 |
| 同快照 | 频道列表与读状态/偏好/last-message，DM 行与 read frontier，在并发更新/撤权时不撕裂 |
| 查询预算 | 0/1/多频道、分页上限，批量投影工作量有界；不以 N+1 替代现有批量读取 |
| 实时受众 | 公开/私有/DM/thread、失权残留 follow、guest、owner-only viewer/read/prefs、多标签页兴趣区别 |
| 准入竞态 | 投影前/后/入队前撤权、迟到 authority wake、family 硬删、token 过期、慢队列出队、guard 取消 |
| 持久恢复 | commit 后崩溃、发送后标记前崩溃、重启重放/客户端去重、未知引用预算、真实 SQL 错误持续保留 |
| Daemon 事实 | ready 落库故障/重试、握手后 key rotation、事务内 principal 复查、迟到 heartbeat/offline、新旧 generation 竞争、版本刷新及在线连续性 |
| 生命周期 | 每个构造失败点、重复 Close、在途 listener/发布、机器断连回调、升级连接、无 goroutine 持续访问已关闭 DB |
| 编码 | v1/v2、send/history/sync/resume、reaction 共享与私有、ReadFrontier union、decimal cursor/digest、缺失/null/0 |
| 兼容与回退 | frozen reducer、fresh Go wire、原 Computer/Daemon、现有迁移链以及当前 M4 数据新旧程序互读 |

以上保留当前安全目标，不宣称封闭所有流量侧信道，也不新增 exactly-once 交付承诺。

## 7. 结构门禁与测试迁移

拟新增 `tests/architecture`（名称为计划，当前不存在），用 AST/实际 import 图和有界规则检查：

- app 的 SQL 执行、业务 mapper/audience 实现；transport 的 SQL、BeginTx、Store.DB 访问。
- application/domain 导入 transport/protocol/Socket.IO；publication 反向导入业务；HTTP 子包反向导入总装配。
- 生产文件/标识符中的阶段前缀与旧包导入，包含 `m3.go` 和 `m4.go`；排除显式登记的发布元数据、历史 fixtures 和模型名称。
- 生产 SetWriteTx/SetValidateHuman/SetThreadReplyReadHook 及旧阶段 fallback。
- 路由 manifest 与实际挂载的重复、遗漏、认证策略。

文本 grep 是盘点工具，不是完整门禁。SQL 检查结合已解析调用与少量明确允许项；行为测试证明快照/事务和授权，不能靠正则猜控制流正确。

测试迁移规则：

1. 行为测试按职责改名；升级/历史 reference 可保留阶段含义。每个旧用例有目标映射，不以文件/测试数量相同替代覆盖证明。
2. `tests/acceptance/m4-reference/go-wire-export.mjs:27` 直接调用 `TestM4ReferenceExportGoWire`，改名时连同脚本、标记和 runner 一起检查。
3. fresh wire/reference 的 `--check` 模式不得写 golden。历史 `contracts/m4` 继续作为唯一冻结依据，由新 manifest 引用。
4. 真 HTTP/socket 集成测试使用完整 app 构造和真实临时数据库，不靠只给 Store 的旧 M3 fixture。
5. domain 单元 fixture 不导入 app；全应用 testkit 只给外部集成测试使用，避免 `app -> testkit -> app` 的测试导入环。
6. 测试故障注入不需要生产可变 setter。保留必要的独立时钟/transport 替身，构造后依赖冻结。

中间步骤可有写明所有者与删除工作包的迁移例外；closure 时所有为本重构新增的过渡例外必须归零。保留的历史例外逐项列明，不得以通配符豁免整个 internal 目录。

## 8. 验收命令与证据

当前已存在的入口包括 `make check`、`make cross-build`、`make vuln`。当前 `check` 已包括 fmt、vet、全包普通/race、reference、fresh Go wire、HTTP/原客户端/升级和本机构建；其依据是 `Makefile:17–84`，不是本轮重新执行的结果。

实施期间按新路径更新责任测试。最终必须完整运行等价于：

```sh
make architecture-check    # 拟新增，必须先实现，不是当前已可运行的命令
make check                # 更新引用，但不能减少原有门槛
make cross-build
make vuln                 # 需要网络；失败/未执行必须明确记录
```

跨平台 build 仅证明编译，不当作 Linux/Windows 真机验收；UI 仍由指定协作者运行。按现有相同环境重复关键 race 场景，报告真实命令与结果，不用一次挑选成功样本替代完整末次运行。

最终交接记录必须包含：前后 commit/工作树；修改文件范围；依赖图；路由差异报告；migration/fixture hash；用例迁移表；完整命令/结果；构造/关闭故障窗口；协议和回退证据；任何剩余例外及产品未实现面。

## 9. 停止条件、回退和最终准入

出现以下情况先停在对应工作包排查：协议/权限变化无解释，schema/hash 改变，事务回调被重放或嵌套，旧代码只是被隐藏在 wrapper 后，真实客户端测试只能靠改客户端/跳过用例通过。

代码回退以小批次变更为单位，且只在得到实施/提交授权后操作。无 schema 重构的运行回退应使用已验证的 M4 二进制和匹配数据副本流程；本计划不授权操作正在运行的服务。

M5 准入由集成人检查设计 §11 的全部条件，独立审查者重点核对权限/事务/投影与测试是否被削弱。不存在“先进入 M5，剩余重构以后再说”的隐式尾项；只有 M5 本身尚未实现的 delivery/ACK/Agent 回复属于下一阶段。

## 10. 本轮记录

本轮只新增两份设计 Markdown，没有改业务源码，没有执行格式化、构建、测试、数据库操作、git commit/push 或服务重启。现有未跟踪 UI/数据目录保留。所有实现、测试通过和 M5 放行结论仍待后续执行。
