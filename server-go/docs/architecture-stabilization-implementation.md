# 架构稳定化实施报告

- 状态：**历史实施交接快照，不能作为最终完成或 M5 放行证据。** 续作核查发现本文关于依赖冻结、逆序清理和 wire 唯一化的部分表述超出了实际完成范围；原监听/网络环境限制已由续作环境补验。当前状态、独立安全修复及最终验收以 [architecture-stabilization-closure.md](architecture-stabilization-closure.md) 为准。以下保留原轮次记录，不将中间结果改写成最终证据。
- 日期:2026-10-09。
- 基线:`feat/go-server` / `6ffc168`(工作区起点;基线期 `go test ./...` 除两个沙箱绑定测试外全绿)。
- 关联:[architecture-stabilization-design.md](architecture-stabilization-design.md)、[architecture-stabilization-workplan.md](architecture-stabilization-workplan.md)、[architecture-stabilization-review.md](architecture-stabilization-review.md)。
- 集成人声明:本报告只记录实际执行过的命令与结果;凡未能运行的项目均写明原因,不以估计代替执行。

## 1. 变更总览

- Git 工作区:相对 `6ffc168` 共 140 个文件变更(98 删除、41 修改、若干新增目录与文件;`git status` 快照见 §9)。**未执行任何 git commit / push / stage。**
- 未触碰:`gui-test-screenshots/`、`var/`、`var-backup-m2-20261008-1902/`、`var-m3-dev/`、迁移 0001–0013(hash 复核见 §6)、`contracts/m4/`、`contracts/legacyweb/`、客户端源码与锁文件(仓库非 server-go 部分零改动)。
- 新增测试工具与契约测试期间由父集成人并行加入的文件(`tests/architecture/*`、`stabilization-rollback.mjs`、`docs/architecture-stabilization-review.md`、computer/platform 回归测试)保持原样并被本实现满足。

### 1.1 终态目录(与设计 §3 一致)

```text
internal/
  app/            app.go services.go http.go execution.go realtime.go publications.go(已并入 application/realtime 后删除) lifecycle.go health.go
  application/    messaging/ channelview/ realtime/ machinecontrol/
  auth/ workspace/ channel/ message/ readstate/ agent/ computer/(+presence.go) runtimecatalog/
  publication/    (原 internal/realtime 改名;表名/事件值不变)
  protocol/client/
  transport/
    httpapi/      router.go + httpx/ authn/ humanapi/ agentapi/ computerapi/ (+testkit 已移至 tests/testkit)
    presenter/
    socketio/     core/ zishang/ bridge/
    machinews/    (SQL 已移至 computer/presence.go;Hub 经 MachineFacts 端口)
tests/
  architecture/   结构契约(AST/import/SQL/命名/wire 边界)
  testkit/        全应用 HTTP 集成 testkit(仅测试导入)
  acceptance/     + rollback_seed_test.go(回退数据播种工具)
```

`legacyweb` 生产代码为零(目录内仅剩无关的 `.claude` 会话元数据,未动)。

## 2. 各工作包落地情况

### 2.1 baseline(§3 of workplan)
- 起点 HEAD `6ffc168`,工作区仅既定未跟踪文件。
- 基线二进制:从 `git archive 6ffc168` 源码在 `$TMPDIR/archstab/baseline-src` 构建(`raft-server-baseline`,arm64),用于回退验证。
- 迁移 0001–0013 sha256 基线与终态一致(§6)。
- 基线 `go test ./...`:除 §8.2 所列两个沙箱绑定失败外全绿;`workspaces-reference`(1216 例)、`m4-reference --check`(7 套件 173 断言)、`m4-wire --check` 通过;`govulncheck` 因网络被沙箱代理拒绝(§8.3)。

### 2.2 contracts / 领域接缝
- `internal/realtime` → `internal/publication`:仅改名与 import 更新;表 `realtime_publications`、事件字符串、已落库数据不变。契约:`publication` 仅依赖 platform/标准库(tests/architecture 强制)。
- `readstate`:删除 `SetWriteTx/SetReadSnapshot/SetValidateHuman/SetEnqueue` 生产可变接缝(方法直接绑定共享 `db.WithWriteTx`/`WithReadSnapshot`/`auth.ValidateHumanTx`/`publication.Enqueue`);`SetClock` → 构造期 `NewStoreWithOptions(Options{Clock})`。`shared_seams_test` 的计数包装测试改写为行为等价断言(回滚零残留 / 提交恰一组 wake),回调恰执行一次的合同由 platform/db 既有测试拥有。
- `message`:删除 `ThreadReplyReadHook`/`SetThreadReplyReadHook`/`HasThreadReplyReadHook` 与顶层 `Store.Create` 旁路;`CreateTx` 保留为事务内原语并新增 `CreateResult.ThreadReply` 事实位。新增 `LastMessageFactsTx` 批量事实读取;`readstate` 新增 `ViewerReadStatesTx/ViewerMuteStatesTx/ViewerDisplayPrefsTx` 与类型化 `ReadFrontierTx/DMReadFrontierTx`(#632 union 的 SSOT 类型复用 `readstate.ReadFrontier`)。
- `computer/presence.go`:`machineFacts` 全部 SQL 迁入 `computer.PresenceStore`(ApplyReady/TouchHeartbeat/RecordStatusTransition/Exists,输入 typed `ReadyFacts`+principal,短局部事务与锁序原样);machinews `Config.DB` 删除,Hub 依赖构造期必需的 `MachineFacts` 端口;测试故障注入改为构造期 `PresenceOptions`(指针捕获,启动后不可变)。

### 2.3 应用用例(§5 of design)
- `application/messaging`:`SendHuman`(唯一完整人类发送入口:一个 `WithWriteTx` → 身份/权限复查 → 幂等与创建 → 新线程回复同事务推进作者已读 → 同事务 publication);`CreateThread`(EnsureThreadTx+首条回复走同一事务内发送步骤);`FollowThread`(显式 follow+markReadLatest 同事务);`UnfollowThread`;DM 列表/创建(含 agent 501 与隐藏目录路径)、thread summaries/info/followed 读模型;`PriorChannelRelationship`(403/404 判别)。重放不重关注/不重推进/不产生新 publication(`read_advance_test` 验证)。
- `application/channelview`:`Service.Project`(批量事实读取替代 app 内联 SQL)与 `List/Detail/CreateResult`(一个 pinned snapshot 内完成频道、权限、actor context 与 viewer 投影)。`M4ChannelProjector` 接缝与 `listM3/getM3` fallback 删除;新账号/空频道自然得到 absent/0/null。
- `application/realtime`:`Dispatcher`(dispatcher/audience/message_events/channel_events/readstate_events 分文件)+ `SocketFacts`(握手/房间/加入/resume/心跳事实源)+ `NotificationSink` 端口 + 语义事件词汇(与 gateway 词汇由 bridge 测试钉死相等)。完成语义与存储兼容保持:published_at=处理完成、未知引用 8 次有界重试后 PARKED(日志+计数,无新持久状态)、事实消失 complete、真实 SQL 错误保留重试。
- `application/machinecontrol`:机器事件协调(OnReady/OnMessage/OnDisconnect)从装配闭包移入;agent.Service/runtimecatalog.Broker 复用;协调器在 Hub 监听暴露前完成装配。

### 2.4 HTTP 包重建(§4 of design)
- `httpapi/router.go`:唯一总装配;`Config` 显式列出每个叶子的 handler 集与 SocketIO/Daemon 传输;`RegisterAdditional` 与 `ReadstateRoutes` 阶段开关删除(unread-summary 用户面常挂)。保留 404/405 Allow、trailing-slash alias、鉴权先于方法拒绝、`/internal/`、`/daemon/`、`/socket.io/` 的既有诚实策略;`Manifest()` 提供路由清单(去重/身份策略由 `manifest_test` 校验)。
- `httpx`:RequestID/SecurityHeaders、响应写入(WriteError/WriteErrorCode/WriteJSON/NotImplemented)、限界正文解析(DecodeJSONBody/ReadJSONObject/MaxJSONBodyBytes)、共享 pattern、scope-membership 上下文。
- `authn`:AuthGate(Require/RequireVerified/RequireVerifiedProfileComplete)、已验证 claims/userID 冻结入请求上下文(`UserID/AccessClaims/FamilyID`);`WithUserID` 仅测试用。
- `humanapi`:account(注册/登录/刷新/登出/验证/重置/me/profile/avatar)、servers+workspace(含 scope/method-policy/reserved)、invite、channel(管理+roster)、conversation(DM/thread/follow)、message(send v1/v2、history、context、sync、reaction)、readstate(activity/inbox/prefs/done)、Agent 人类管理与凭据/引导令牌、runtime catalog。所有 SQL/事务/`Store.DB()` 访问移除;scope 中间件的成员资格事实走 `workspace.GetMembership`,Agent 存在性走 `channel.Store.AgentExists`。
- `agentapi`:`/internal/agent-api`(whoami/server/channel-members)由 `Handlers{Store *agent.Store}` 自鉴权(sk_agent 每请求对账),从不接受人类 JWT;未注册路径 401、已知未实现族 501 的 fail-closed 语义原样。
- `computerapi`:设备 authorize/approve/token、attach、legacy-machines、`/api/agent/login` 引导交换、`/internal/computer` 内部面(含 preflight 反射的注册表)、workspace 机器管理、runner API。与 workplan 的字面差异:机器管理 HTTP 文件留在 computerapi 而非 humanapi —— ComputerHandlers 是同一 Computer 身份面(设计 §4.1 computerapi 行),拆成两个类型会复制 8 个共享字段并在叶子间引入被禁止的相互依赖;每条路由的身份策略(人类门/交换凭据/sk_computer)逐条保留,runner 对 ComputerHandlers 的依赖由此成为包内依赖,满足"runner 不再依赖另一个 HTTP handler"的实质要求。
- `presenter` + `protocol/client`:实时事件 wire 形状(read_state/bulk/unread_summary/dm:new/members/followers/prefs/display/channel:updated)与 #632 union 渲染唯一化;application 三包零 json tag / 零 JSON 输出 / 零旧 wire 编码调用(tests/architecture/wire_boundary 强制)。

### 2.5 实时系统(§7 of design)
- 三个所有者:`publication`(持久引用)、`application/realtime`(投影/受众/分派)、`socketio/bridge`(wire 适配与 sink)。顺序合同保持:serial 先于快照采样、payload 构造在 fence 外、bridge 在 gateway 同一 admission guard 内核对 serial/身份/workspace/兴趣并有界入队、serial 变化/守卫失败/取消上抛保留 durable intent(重投影)、`PublishFilteredContext` 单调用消除 CanSend/Send 竞态。后台发布不依赖发送者 token;私有事件限定 user∩workspace;公开线程区分 thread room 兴趣。
- `app/realtime.go`:仅装配与生命周期(gateway+bridge+dispatcher+eviction wake+zishang 绑定+心跳启动);权威唤醒/降代逐出/Close 顺序(publisher→listener→gateway)原样。

### 2.6 装配与生命周期(§8 of design)
- app 终态文件:app.go(Build 编排)/services.go(chat 构造)/execution.go(控制面构造+协调器)/http.go(handler 装配)/realtime.go/lifecycle.go(StartMaintenance/Close)/health.go。`m3Runtime/m4Runtime/m4Realtime/m4Publisher` 阶段类型全部更名(controlPlane/chatServices/realtimeRuntime/realtime.Dispatcher)。
- janitor SQL → `auth.MaintenanceService`;readiness SQL → `platform/db.Ready`(ErrNotMigrated)。
- 生命周期:构造失败逆序清理、realtime 先于 control 关闭、DB 关闭后释放 authority fence、重复 Close 幂等 —— 原语义保留(app 生命周期测试通过)。

## 3. 结构门禁与测试迁移

- `tests/architecture`(集成人契约):5 项全部通过(必需边界/依赖方向/app+transport 无 SQL/生产命名/wire 所有权)。`make architecture-check` 已加入且并入 `make check` 依赖链首。
- 测试迁移映射(旧 → 新):
  - legacyweb 45 个测试 → httpapi/{humanapi,computerapi,httpx,root} 对应包;`testsupport_test.go`+`workspaces_testsupport_test.go` → `tests/testkit`(全应用 testkit,生产代码零导入,符合工作包规则 5)。
  - `read_hook_test.go`(message)→ `application/messaging/read_advance_test.go`(同事务推进/重放不推进/频道消息不触发/发布计数,断言从 hook 调用改为 readstate 行事实)。
  - `m4_wiring_test` 的装配完整性断言改为服务存在性(构造失败即 Build 失败);`ThreadReplyAdvancesReplierCursor` 端到端行为测试原样通过。
  - seam 类测试改写:PostInitialReply 501(unwired)删除(接缝不存在);首条回复走真实发送步骤(需真实 roster,测试补播种);ReadCursor stub → 真实 readstate 行;MarkReadLatest 注入失败子测试删除(原子性由单事务结构+platform 回调恰一次合同承担),正路径断言保留;DMReadState 逐字嵌入改为与属主投影独立计算的字节相等断言;DM 快照纪律改为"创建即可读自身未提交频道行"的行为证明。
  - `go-wire-export`(冻结 wire 采集)改经 `messaging.SendHuman` 真实路径,`--check` 通过(原始 reducer 接受)。
- 命名清理:生产文件/标识符零 m3/m4 前缀(契约强制);测试文件名保留阶段词(不在扫描范围,历史可读)。

## 4. 协议/Schema 兼容性证据

- 迁移 0001–0013 未改动;`go.mod/go.sum` 未改动。
- `m4-reference --check`:7 套件 173 断言通过(冻结 TS 源)。
- `m4-wire --check`:真实 Go 公共 API wire 通过原始 reducer/JSON Schema(证据文件未重写)。
- `workspaces-reference`:1216 例通过。
- 实时事件负载经 presenter 映射到 protocol/client;成员加入定向 channel:updated 的 `{channel:{...,joined:true}}` 嵌套形状与 read_state 大数 decimal-string、latestActivity 对等形状均有 app 集成测试断言(members-updated 定向帧、readstate 事件形状测试)。
- 路由差异:无删除、无新增业务路径;唯一行为性差异是原 `ReadstateRoutes=false` 测试态的移除(生产恒为 true);`/socket.io/` nil 时仍为诚实 501。

## 5. 回退/数据兼容验证(workplan §3.2 等价执行)

- 以当前代码迁移链播种 M4 形态数据(账号/会话族/workspace/channel/thread follow/message/read+mute+display/reaction 壳/publication 行;`tests/acceptance/rollback_seed_test.go`,`RAFT_ROLLBACK_DIR` 门控)。
- **基线二进制(6ffc168)成功打开并诊断该数据**:日志显示迁移与 workspace 诊断正常完成,仅在 `listen 127.0.0.1:4301` 处被本沙箱禁止端口绑定而退出(非数据/Schema 失败)——即旧二进制可读新代码所写 M4 数据的回退方向成立。
- 新代码重读旧数据方向由 in-process 升级链测试(`platform/db` m2/m3 upgrade 测试)与 testkit reopen 测试覆盖。
- 父集成人提供的 `tests/acceptance/stabilization-rollback.mjs`(冻结旧二进制↔新二进制互读写的完整 TCP 验收)需要真实监听端口,本沙箱无法运行,留给父侧执行;其断言面与上述手工验证一致。

## 6. Hash 与不变量复核

- 迁移 sha256(基线=终态,抽查全部 13 个文件一致;完整清单存 `$TMPDIR/archstab/migration-hashes-baseline.txt`,与当前 `shasum -a 256 internal/platform/db/migrations/*.sql` 输出相同)。
- `git status` 中非 server-go 前缀改动:0。

## 7. 执行过的完整命令与结果

| 命令 | 结果 |
|---|---|
| `go vet ./...` | PASS |
| `gofmt -l .` | 空 |
| `go test -count=1 ./...` | 除 §8.2 两项外全 PASS |
| `go test -race -count=1 ./...` | 同上(见 §8.2;race 无新增告警) |
| `go test -count=1 ./tests/architecture/`(`make architecture-check`) | PASS(5 契约) |
| `node tests/acceptance/workspaces-reference.mjs` | PASS(1216) |
| `node tests/acceptance/m4-reference/run.mjs --check` | PASS(7 套件/173) |
| `node tests/acceptance/m4-reference/run.mjs --go-wire --check` | PASS |
| `GOOS=linux/windows GOARCH=amd64 go build ./...` | PASS |
| `go build ./cmd/raft-server` | PASS |
| 基线二进制读新数据(回退) | 打开/诊断成功,仅 listen 被沙箱禁止 |
| `make vuln`(govulncheck@v1.8.0) | **未能执行**:沙箱代理拒绝 proxy.golang.org(用户侧策略;见 §8.3) |
| `make test-http` / `test-reference(Node)` / `test-m4-upgrade` / `m4-realtime` / `m4-socket-spike` | **未能执行**:需要本地 TCP 监听,沙箱禁止(§8.2) |

## 8. 环境限制与诚实边界

### 8.1 沙箱
本会话 Bash 运行于 macOS Seatbelt 沙箱:**本地端口绑定被禁**(`listen tcp 127.0.0.1:0: bind: operation not permitted`,已三次探测确认)。代码库本身即为此环境设计("in-process recorder, no TCP listener"),因此 Go 套件基本可全跑;影响集中在需要真实监听的验收与二进制面。

### 8.2 因绑定而无法运行的两个 Go 测试(基线同样失败,非本重构引入)
- `internal/platform/mail` `TestReviewSMTPHonorsCancellationDuringGreeting`(本地 SMTP 监听)。
- `httpapi` `TestM4SocketIOConfiguredOriginSurvivesEngineUpgrade`(httptest.NewServer 绑定;Go 1.27 起构造即绑定)。
其余 `make test-http`(M1–M4 真监听 HTTP 验收)、`test-m4-upgrade` 双冻结矩阵、`test-reference`/`m4-realtime` Node 套件、`m4-socket-spike`(真实 socket.io 客户端)同因端口绑定不可运行——这些是父侧(监听可用环境)必跑项;启用方式:`sandbox.network.allowLocalBinding: true`(用户设置,即时生效)。

### 8.3 govulncheck
`go run golang.org/x/vuln/cmd/govulncheck@v1.8.0` 需访问 proxy.golang.org;沙箱过滤代理以"user denied"拒绝(即使按 auto 模式申报域名亦被策略拒绝)。**未执行,无结果可报告**;依赖清单(go.mod/go.sum)未变,基线期同样未能运行。

### 8.4 UI
按任务边界未做任何 UI 测试或签收声明。

## 9. 剩余缺口与交接

1. **监听类验收**(§8.2 清单):代码路径未改动其合同,但必须在可监听环境由父侧实际运行后方可宣称全量验收;`stabilization-rollback.mjs` 同列。
2. **govulncheck**:需网络可达环境执行。
3. **channelview 单元测试**:其行为由 humanapi 投影测试与 app 装配测试端到端覆盖,无独立单元文件;如需直测可在 closure 补充。
4. **`internal/transport/legacyweb/.claude/`**:仅会话元数据,未清理(不属本任务所有)。
5. **测试文件名**仍含 m3/m4 阶段词(工作包允许历史含义保留在测试;如需彻底改名是纯机械工作)。
6. machine 管理面落位computerapi 的决定(§2.4)请独立审查者复核是否接受为终态,或要求进一步拆型。

## 10. Git 快照

- 起点:`6ffc168dd7025a2d5f61416347ecc9937853c3ad`(clean,除既有未跟踪)。
- 终点:140 文件变更(98 D / 41 M / 新增目录与文件如 §1.1;完整 `git status --porcelain` 以工作区为准)。
- 未 commit / 未 push / 未 stage。
