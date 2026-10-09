# Architecture stabilization：续作与最终收口

- 工作区：`/Users/lyon/workspace/raft-source`，`feat/go-server`。
- 代码基线：`6ffc168dd7025a2d5f61416347ecc9937853c3ad`。
- 本轮日期：2026-10-08（America/Los_Angeles；UTC 为 2026-10-09）。
- **状态：本轮后端 architecture stabilization 已收口，最终同一源码工作树上的 `make check`、交叉编译、依赖扫描及保护范围检查均通过。M5 后端接入基础可以进入下一阶段；不代表 M5 业务功能、UI 签收或生产部署已经完成。代码尚未提交、未推送。**
- 约束依据：[设计](architecture-stabilization-design.md)、[工作计划](architecture-stabilization-workplan.md)、[历史审查](architecture-stabilization-review.md)。

## 1. 接手状态与变更边界

接手时已经有大批未提交的 Go 架构迁移：旧 `transport/legacyweb` 删除，新 application / httpapi / protocol / presenter / bridge 等包已经存在。此前的[实施报告](architecture-stabilization-implementation.md)是一次受限环境中的交接快照，不应据其“实施完成”标题放行 M5。独立复核确认它遗漏了重复领域 wire 实现、构造后的可变依赖、部分失败清理和消息 publication 顺序等事项。

Git 起点并非完全未暂存：已有 `internal/app/m3.go -> internal/app/execution.go` 的 staged rename。本轮保留既有工作和 index，没有 commit、push、reset、stash 或 rebase。

范围仍为 Go Server 的结构、验收工具和文档；不变更客户端源码、JavaScript 锁文件、Go 依赖版本及 go.sum、迁移 0001–0013、冻结 golden、运行中的服务或用户数据。本轮发现并单独修复工具链安全问题：仅将 go.mod 的 `toolchain go1.27.1` 改为 `toolchain go1.27.2`，见第 4 节。没有启动 Web UI，也没有进行 UI 签收。

`gui-test-screenshots/`、`var/`、`var-backup-m2-20261008-1902/`、`var-m3-dev/`、既有 UI 报告及 `.claude` 元数据不属于本轮清理对象。真实监听验收使用测试自行创建的 OS 临时目录、动态 loopback 端口和私有子进程；没有将生产/协作者数据库用于实验。

## 2. 本轮已经落地的验收补全

### 2.1 回退验收纳入默认门禁

`tests/acceptance/run.mjs` 的 `all` 与独立 `stabilization-rollback` suite 调用 `verifyStabilizationRollback({ executable, capture })`。当前 executable 必须与冻结 `6ffc168` 进行真实新旧程序对照，不传 `baselineOnly`，不以旧程序对自己运行代替验收。

覆盖 11 类持久 HTTP 视图、签名 cursor 与 Agent/Computer 凭据、33 个路由/身份探针、旧程序创建的冷备份恢复，以及新程序写入后旧程序继续读取和写入。原有 M1/M2/M3 升级链和两套冻结 M3 起点仍完整保留。

Makefile 新增 `test-stabilization-rollback`。`check` 改为依赖明确设置 `RAFT_GO_TEST_SUITE=all` 的 `test-http-all`；开发者仍可用 `test-http SUITE=...` 跑子集，但环境中遗留的 SUITE 不再悄悄缩窄完整 check。

### 2.2 独立验证 DM read-frontier 的 wire

`tests/acceptance/m4-backend.mjs` 不再只检查 readState 字段是否存在。使用真实 HTTP create/send/read/unread/list 操作，独立断言：

- 新建自聊与双人 DM 的精确 absent union；有新消息但尚未读时仍 absent。
- 第一次实际读取后的 present union、版本 1、decimal-string maxReadSeq 与同一条最新消息的 ID/seq 对。
- re-open/create 与 list 两个出口一致；B 的已读状态不出现在 A 的私有 frontier 中。
- 标未读后版本递增为 2，union 仍是 present 而非 absent，最新 activity 对不被误改。

期望值由协议字面量和实际写入结果构成，不调用被测 presenter/domain wire helper 来计算期望。该扩展已通过 M4 backend 的全部 16 个检查组。

### 2.3 冻结资料索引与结构门禁

`contracts/client/manifest.json` 指向现有唯一冻结资料，不复制另一份 golden。`tests/acceptance/client-contracts.mjs` 验证目录完整性、hash、schema、来源、实际消费者和 Git 基线，并对恶意/错误清单在独立临时目录执行自检。Makefile `test-client-contracts` 已加入完整 check。

AST 结构检查增加 transport 的零参数 `Store.DB()` 调用限制。原规则只检查显式 SQL 调用/类型，无法发现“handler 获取原始 executor，再交给领域查询”的越界。新增规则先真实报告了 `humanapi/channel_members.go` 两处遗留调用；修复前的红灯不能登记成完成。

### 2.4 真正的后置 HTTP 故障与快照预算

新增 `tests/acceptance/stabilization_http_failure_test.go` 覆盖回复、创建线程与首条回复、显式 follow、创建 DM 四种真实 HTTP 500 映射、回滚和故障解除后的恢复。普通业务表逐行对比，publication 对比完整持久意图字段；后台 dispatcher 的处理进度列不属于未提交请求的业务事实，不将其异步变化误判为回滚失败。

为避免假证据，回复/follow 的 SQL trigger 只有在 earlier thread/follow/reply 确已存在时才触发；不能在缺少前置事实时也 RAISE 再用同一个 500 自证。DM 使用仅在新 pair/channel/participants 已插入后才出现的临时读取 poison row；同一 frontier reader 在创建前必须正常。四类操作均检验失败后无残留、移除故障后相同请求成功；回复复用相同 randomId，证明失败没有消耗幂等键。所有 schema 故障只影响单个测试的临时数据库。

新增 `stabilization_query_budget_test.go`，对 caller-pinned executor 的 0/1/many 批量投影计数。当前基线预算是三次 batch 查询，加一次可选 last-message 查询，以及每个已有 read row 的频道两次 frontier 查询；这部分线性工作继承自基线，本轮未引入新的 N+1。额外 unread 频道不增加语句，所有计入的 Exec 为零。单连接池加死锁退出 deadline 验证投影不能另取同一池中的连接；不是将运行耗时当成性能验收。HTTP/预算测试已一起连续 3 次 race 通过。

路由清单补入逐字注册点/真实 owner/策略维度的 AST 交叉校验。准确 inventory 已集成，并与完整门禁一起通过，最终为 248 项：169 个实际挂载和 79 个明确标记的 dispatcher 逻辑子项。见第 5–6 节及 [路由审查](architecture-stabilization-route-audit.md)。

## 3. 中间执行证据（不替代最终同树复跑）

以下命令均由续作会话实际运行。源码仍在收口时的通过结果只说明执行时的树，不是最终冻结版本的完整验收。

| 命令 | 实际结果 |
|---|---|
| `make architecture-check fmt-check vet` | 接手树通过；随后加强的 Store.DB 门禁发现两处真实遗留，待源代码修复后重跑 |
| `make test` | 全包普通测试通过，含原报告受本地绑定限制的 SMTP 与 Socket.IO 升级测试 |
| `make race` | 全包 race 通过，没有 race 报警；该次外层 shell 随后的文件存在性盘点失败不属于测试失败 |
| `make test-http`，默认 all | HTTP、Socket.IO、原 Computer/Daemon direct/proxy 客户端、持久化、历史升级和当前 M4 回退全通过 |
| `make test-stabilization-rollback` | 实际新旧二进制往返通过，不是 baseline-only 自检 |
| `make test-m4-backend` | 新增 DM union/观察者隔离断言后，16 个检查组通过 |
| `make test-m4-realtime test-m4-wire` | 消息 DTO 迁移后再次通过；1201 条分页恢复、32000-unit CJK、退出与权限隔离；测试 fixture 改为显式 fact + publication 原语，不要求保留第二个生产 send 包装器 |
| `go test -race -count=3 -run '^TestStabilization' ./tests/acceptance/` | 加强后置故障因果条件和单连接快照 guard 后连续 3 次通过 |
| 6 个新增 source 回归，3 次 race（messaging/app/computer） | 消息 publication 顺序与 revision、Build 失败 fence 释放、重复 Close、presence 空 DB 拒绝与 hook 捕获均通过 |
| `make test-reference` | 1216 个执行式 TS/Go workspace 投影对照通过 |
| `make test-m4-reference` | 7 suites、173 assertions；冻结资料只读 check 通过 |
| `make test-m4-wire` | 实际 Go 输出通过原始 reducer/Activity schema；未重写 golden |
| `make cross-build` | Linux / Windows amd64、CGO=0 编译通过；不宣称跨平台真机验证 |
| `node tests/acceptance/client-contracts.mjs` | 12 份冻结资料与 13 个迁移 hash/清单/来源一致，21/21 故障自检通过 |
| 初次 `make vuln`，Go 1.27.1 | 失败：8 个标准库可达漏洞 |
| `GOTOOLCHAIN=go1.27.2 make vuln` | 通过：0 个可达漏洞、0 个已导入包漏洞；6 个未调用的模块级提示保留，见下节 |

## 4. 独立安全修复：工具链补丁

本轮终于可以运行上一会话因网络限制未完成的 govulncheck，发现 Go 1.27.1 标准库中的 8 个可达漏洞。Go 官方于 2026-10-08 发布的 1.27.2 包含相应安全修复。处理是升级模块的 toolchain 补丁指示，不改变 `go 1.26.0`、任何 require 版本、go.sum 或客户端锁文件，也不更改系统的全局 Go 配置。

修复后 scanner 返回成功：当前代码可达漏洞为 0，已导入包额外漏洞为 0。仍有 6 个模块级提示：`golang.org/x/net v0.59.0` 中 5 项未调用的 HTTP/2 代码问题，以及 `golang.org/x/crypto/openpgp` 的未使用包提示。保留这项事实；“扫描通过”不等于“所有依赖模块不存在任何 advisory”。本次不为清零未使用包提示扩大为依赖升级。

该项是新发现的安全维护变更，不应包装成纯文件重命名或声称 go.mod 完全未变。新旧二进制兼容对照仍使用冻结旧代码和其原工具链要求，未修改旧基线。

## 5. 源代码闭环：最终状态

| 事项 | 最终实现与证据 |
|---|---|
| 单一完整消息用例 | `application/messaging` 负责同事务 identity revalidation、message facts、线程关注/已读推进与 publication。`publication_order_test.go` 逐行核对基线意图顺序及 revision；原子性和幂等测试保留。 |
| 跨领域写入所有权 | `message.AttachThreadToParentTx` 拥有 `messages.thread_id` 更新；channel 不再写 message 字段。messaging 将线程事实与关联更新放在同一事务。 |
| 删除第二条生产发送捷径 | `message.Store.CreateTx` 已从生产 `create.go` 删除。域内/crash 测试需要的 seeder 只存在于 `seed_message_test.go`；presenter、resume 和 bulk fixture 显式调用事实/意图两个原语。测试便捷入口不再进入生产二进制。 |
| 事实与客户端编码分离 | message enrichment、conversation context、viewer、thread 为 typed facts；客户端 DTO 在 `protocol/client`，纯转换在 `transport/presenter`。`channel.Wire`、Inbox 的领域 Wire、readstate 的 `ReadFrontierJSONTx`/`DMReadStateTx` 和重复 `ProjectPublication` 已退役。 |
| 共享/私有实时唯一实现 | application/realtime 读取当前事实并决定受众，publication 只管理持久意图，bridge 编码并在同一 admission guard 内校验和入队。authority serial、generation、订阅兴趣、取消和慢队列保护回归保留。 |
| readstate 测试跟随真实路径 | 原重复 projector 测试迁到 `application/realtime/readstate_events_test.go`：read-state 当前事实、server unread invalidation、失效主体无发送完成、prefs envelope 均通过实际 dispatcher 和 presenter 验证。 |
| 机器事实与构造器 | `computer.NewPresenceStore` 拒绝 nil DB，函数 hook 构造时捕获；保留 slot → DB 锁序。messaging/channelview 依赖字段私有，message clock/cursor 构造注入，cursor key 复制捕获。 |
| machinecontrol 构造后不可变 | `NewCoordinator` 校验必需 service/broker/validator，字段私有。Hub → coordinator → service/broker → Hub 的装配环通过仅局部可见的回调引用一次性绑定，绑定完才暴露 listener，不给运行期留下公开 setter。缺失依赖与验证先于回调的测试通过。 |
| HTTP 身份与依赖边界 | 人类机器管理及其回归迁到 humanapi；Computer admission/internal 留在 computerapi。Runner 使用 Computer 领域与共享认证函数；Message/Conversation 不再依赖 ChannelHandlers。两处 `Store.DB()` 逃逸已修复。机器管理真实 scope 缺失/mismatch/guest/method 顺序断言保持原合同。 |
| 失败清理 | `app.Build` 统一逆序清理 realtime → control/Hub → DB → authority fence。`TestBuildFailureReleasesAuthorityFence`、`TestBuildCloseIsFenceNeutral` 及生命周期/race 测试通过。 |
| 查询快照与工作量 | channelview 在 caller-pinned executor 上完成完整读模型，零/一/多频道预算与单连接快照保护通过；不声称基线每个已有 read row 的线性 frontier 查询已被优化消失。 |

### 5.1 路由清单的最终复核

最终入口为 `internal/transport/httpapi/manifest_table.go:Manifest()`，只有这一份运行代码清单；`Method/Pattern/Owner/Identity/Allow/Gate/Scope/RateLimit/Capability/Kind` 分别描述真实挂载与逻辑分派子项。它不注册路由、不读取源码、不替代鉴权。

独立复核否决了中间版本的 173 条清单，因为它混入不存在的 reaction URL、虚构 workspace 子树回退、错误的限流/作用域及 401/405 描述。最终版本修正为 248 条，且有专门 `manifest_policy_regression_test.go` 固定这些已发现错误。关键差异包括：

- DELETE reaction 与 POST 共用 `/reactions`；actors/viewer 是直接子路径，不在 URL 中追加 emoji。
- Readstate 使用 `ReadstateHandlers.RequireServerScope`，不是同名的 `ServersHandlers.RequireServerScope`；前者不要求 channel ID 与 X-Server-Id 相同。
- 人类 Agent credential/manageable 入口没有 account general-auth limiter；六个 admission 入口各有自己的独立限流实例。
- Agent 未登记路径先返回 401；33 个已知 deferred 家族先认证再返回 501。machines 的原始 method fallback `Allow: GET`、保留字路径和尾斜杠别名不被“整理”改变。

`docs/architecture-stabilization-route-inventory-candidate.txt` 仅保留为审查草稿，不是第二套活动清单。子任务汇总中的“173 条”“保留生产 CreateTx”等是集成前的历史快照，最终以本报告与实际源码为准。

## 6. 最终同树验收：实际执行全部通过

下列命令是在所有上述生产变更、路由清单修正、测试 seeder 下沉和 machinecontrol 构造器修复完成后执行的。之后仅更新文档，未再修改被验收的源码。完整 `make check` 是一次连续成功执行，不是把多个不同中间版本的子集结果拼成一次通过。

| 最终命令/门禁 | 实际结果 |
|---|---|
| `go test -count=1 -run TestManifestRetainsReviewedPolicyDistinctions -v ./internal/transport/httpapi` | PASS；实际枚举 248 项 = 169 mount + 79 dispatch，全部针对性策略断言通过。 |
| `make check` | PASS，完整连续执行；包括下列所有子门禁。 |
| `architecture-check`、`fmt-check`、`vet` | 8 个架构合同测试通过；格式检查和 `go vet ./...` 通过。 |
| `go test -count=1 ./...` | 所有包通过，包括 SMTP、本地 TCP/Socket.IO 升级测试；没有以子代理的沙箱限制跳过这些测试。 |
| `go test -race -count=1 ./...` | 所有包通过，无 race 报警。 |
| `test-client-contracts` | 12 份冻结资料、13 个迁移与基线一致；21/21 故障自检通过，没有重生成 golden。 |
| `test-reference` | 1216 个实际执行的 TS/Go workspace 投影对照通过。 |
| `test-m4-reference` | 7 suites、173 assertions 通过；原始资料只读。 |
| `test-m4-wire` | 当前 Go 实际 public-API 输出通过原 TS reducer 与 Activity schema；私有 reaction/read-state 版本、Done tombstone 等通过。 |
| `test-http-all` | 完整账户、workspace、Computer admission、Daemon、Agent、频道/DM/线程/已读/Inbox/Activity、Socket.IO、持久化、原客户端 direct/proxy 验收通过；没有传入缩小范围的 SUITE。 |
| 真实实时恢复 | 1201 条消息分页恢复、32000-unit CJK 消息、重启恢复、会话家族隔离、私有订阅与撤权驱逐均通过。 |
| 历史升级与当前回退 | 保留 M1/M2 链；两套冻结 M3 起点升级、旧二进制拒绝及冷备恢复通过；冻结 M4 → 当前程序 → 冻结 M4 的 11 类视图、33 个路由/身份探针、cursor/credentials、继续读写均通过。 |
| `build`（make check 最后一步） | `CGO_ENABLED=0` 生成 `server-go/bin/raft-server`。本次构建记录的 BuildTime 为 `2026-10-09T04:28:10Z`。 |
| `make cross-build` | Linux amd64、Windows amd64，CGO=0，全部包编译通过。 |
| `make vuln` | 使用 Go 1.27.2，41 个 root packages、33 个模块；0 个可达漏洞、0 个已导入包漏洞，6 个未调用模块级提示；命令成功。 |
| `git diff --check` | PASS，无 whitespace 错误。 |
| 保护范围与 Git 基线复核 | packages/apps、客户端锁文件、go.sum、13 个 migration、冻结 m4/legacyweb/readstate schema 无 diff；HEAD 仍为 `6ffc168dd7025a2d5f61416347ecc9937853c3ad`；index 仍只有接手时的 staged rename。 |

实际路由和身份策略仍由执行式 HTTP/回退测试验证；静态清单/AST 检查不能代替这些行为证据。

## 7. 剩余观察项与交付边界

本轮没有发现尚未关闭的架构稳定化阻塞项。保留以下明确边界，不将它们包装成已经做过的工作：

1. 依赖扫描保留第 4 节的 6 个未调用模块级 advisory；0 可达不等于所有 require 模块都不存在公告。后续依赖维护可以单独处理，不混入本次零 schema、客户端不变的架构重构。
2. 辅助执行器曾报告一次已有 5 秒轮询模式的 resume 测试超时；隔离重复、后续重复普通/race 及本轮最终整套均通过。本次没有添加 skip、扩大该 timeout 或修改 wire 来抹掉该观察。
3. Linux/Windows 是交叉编译，不是真机运行验收。没有启动或签收 Web UI；没有替换运行中的服务、修改用户数据库或部署本次构建。
4. Activity 的 canonical/token JSON 和既有 auth 时钟测试入口保留其原职责；它们不是另一套客户端 presenter，也未以“禁止全部 JSON”的规则粗暴重写。
5. 未 commit、未 push；原工作树和暂存状态保留。构建输出及审查草稿不是源代码提交建议；本报告不宣称工作树已清空，也未清理他人的 UI/备份目录。

结论：批准范围内的后端架构稳定化已完成并通过最终验收。后续 M5 应在既定 messaging 事务、独立 Agent delivery、machinecontrol 与身份分面的入口扩展，不能把本轮通过解释为 Agent delivery/ACK 或 UI 功能已经实现。
