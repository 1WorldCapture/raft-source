# M4 realtime 验收(real App + 原版客户端)— 实现与状态报告

- 日期:2026-10-08(第三轮)。
- 执行者:P3 realtime worker。
- 交付物(全部在授权范围内):`server-go/tests/acceptance/m4-realtime.mjs`(验收套件,`verifyM4Realtime` + standalone)、`server-go/tests/acceptance/m4-realtime-fixture/`(TEST-ONLY bulk 播种器)、本报告,以及一处 core 修复(`Identity.Expired` 精确边界,见 §4)。未触碰 app/其他模块/schema/客户端/浏览器/live 4301/5175/var*/go.mod/commits。
- **状态:实现完成、本地可验证部分全部通过;真实执行仍被本 worker 沙盒禁止(端口绑定 EPERM,同前两轮),网络互通由父级运行 —— 本报告不含任何未执行即声称通过的结论。**

## 1. 运行方式(父级执行)

```sh
cd server-go
node tests/acceptance/m4-realtime.mjs          # standalone:构建真实 server、动态端口、一次性数据目录
# 或父级 runner:
import { verifyM4Realtime } from './tests/acceptance/m4-realtime.mjs';
await verifyM4Realtime({ origin, data, start, stop, capture, executable, env });
```

依赖:P0 已 pin 的候选库(主 go.mod 已含,无需 -modfile)、仓库锁定的 `socket.io-client@4.8.3`(直接 import `node_modules/.pnpm`,零安装)、`m3-harness.mjs` 真实账号流。standalone 完全镜像 `m4-backend.mjs` 的隔离纪律:一次性 tmpdir/数据目录、动态回环端口、SIGINT 优雅停机断言(hijacked socket 回收)、严格子进程 reap、日志中凭据样扫描。

## 2. 后端就绪门槛(不容忍缺席)

套件第一条即硬门槛:`GET /socket.io/?EIO=4&transport=polling` 必须返回 **400(websocket-only 的显式拒绝)**。任何其他状态(尤其 not-enabled 501)都让套件**立即失败**,错误信息指明"app 集成(deps.SocketIO)未落地"—— 本轮编码时 `internal/app` 尚未传入 `deps.SocketIO`(父级 worker agt_18c13485 接线中),届时该门槛会真实放行,而不是被静默跳过。

## 3. 用例矩阵(16 组,全部真实数据库身份)

| # | 用例 | 断言要点 |
|---|---|---|
| 2 | 握手拒绝关键词 | 缺 token→`Authentication required`;伪 token→`Invalid or expired token`;外空间成员→`Not a member of this server`(逐字) |
| 3 | 账号级连接 | serverId=null 连接成功但无 rooms:joined/无 workspace 消息/无心跳(原版语义) |
| 4 | rooms 屏障 + 双账号 live | rooms:joined(无业务 payload)先于 message:new;live 帧=HTTP 行(同 ID/seq/content/sender=已验证 principal);同 ID 恰一帧 |
| 5 | 断线重连与顺序收敛 | engine 级断开→原客户端自动重连→resume 恢复离线消息恰一次;重连后 live 到达;跨重连 ID 无重复 |
| 6 | 私有受众 | 私有频道:成员收/非成员不收;人类 DM 只投双方(dm:new `{channelId}` 形状);公开 thread:显式 join 的非 follower 也能收 thread live(公开 viewer);私有父链 thread 对非成员零泄漏(join 也不给) |
| 7 | Reaction 双面 | 共享 `message:updated`(canonical 聚合)+ 私有 `reaction_viewer:updated` 只发 actor 本人 |
| 8 | read/mute/display 私有事件 | `read_state:updated`;`notification_prefs:updated {serverId,scopeId,prefs{activityMuted,muteFromSeq},prefsVersion}`;`message_display_prefs:updated {…collapseLongMessages…}`;全部单 payload 对象 |
| 9 | 应用心跳 | `{seq≥0 整数, ts=epoch ms}`;非 Engine.IO ping |
| 10 | 自有同源代理 + Origin | 临时 Node 代理(WS upgrade 透传)携 Web Origin 流经 live;伪造 Origin 在 HTTP 层被拒(传输级失败,永不建立) |
| 11a | bulk 播种 | **停机状态**经真实 `message.Store.CreateTx`+`db.WithWriteTx` 播 1200 条 + 1 条 32000-UTF-16-unit CJK(96KB UTF-8):完整元数据、事务 seq、同事务 outbox(见 §5) |
| 11b | >500 多页恢复 | 重启后原客户端 resume 循环:≥1200 行、页≤500、currentSeq 严格前进、ID 无重复、finalCursor≥bulk 末 seq;**全程 0 次断开**(字节预算不触发重连循环) |
| 11c | 32000 CJK 完整性 | 逐字符断言 32000 个『界』完整恢复,不截断不丢弃 |
| 12 | 重启 outbox 持久 | 停机前提交的消息,重启后经 live 或 resume **恰一次**到达 |
| 13 | logout 家族隔离 | family A logout→socket A 以 `transport close` 被关、重连被 `Invalid or expired token` 拒;独立 family B 的 socket 持续收 live |
| 14 | 权限变更驱逐 | 移除私有频道成员→已建立连接 `transport close` 关闭;自动重连按当前授权重建(工作区可连、私有房内容不再到达) |
| 15 | 严格清理 | 每组自清 socket;套件结束断言零残留连接 |

发送量预算:live HTTP 发送全程人均 <10 次(生产 60/60s 共享桶之内);bulk 走 §5 helper;**绝不通过 env 关闭生产限流,也不等待限流窗口**。

监听纪律:所有等待器先挂后触发;`disconnect(reason, description)` 双参数形态记录 reason;超时全部有界(事件等待 8–25s,页面循环 12 页收敛守卫);日志/输出不含正文凭据(仅计数/ID/错误码)。

## 4. 本轮 core 修复(已证实的单元缺陷)

**`Identity.Expired` 的精确边界**(core/identity.go):原实现 `now.After(exp)` 在 **恰好 exp 时刻**漏判;Admit 的拒绝条件(`!ExpiresAt.After(now)`)却是 now≥exp 拒——两处相差一秒。已统一为 RFC 7519 语义(`now >= exp` 即过期),并补恰在 exp 时刻的断言(core/fence_test.go)。父级指令中指出的此项已修。race 全量通过(§6)。

drainer 的 guard check/use 与上游 Writable 界复核结论:发布路径的资格检查+有界入队整体在 AdmissionGuard 内(父级 `db.WithAuthorityReadContext`),drainer 只送出已在 guard 内授权的帧(字节一经授权不可撤回,承诺边界=授权后不再有新授权);上游两层无界缓冲被 `CanAccept` 发射窗口钉死在本网关队列界内,慢 peer 由队列溢出断开或 30s 写停滞 discard 关闭——三条机制均有测试,未发现新缺陷,未做无证据改动。生产 `Options.Guard` 保持必填。

## 5. bulk 播种器(显式 TEST-ONLY)

`m4-realtime-fixture/main.go`:一次性验收数据目录专用;通过**真实领域 API**(`CreateTx` 在 `WithWriteTx` 内)播种——每行携带完整记录/来源元数据、事务分配 seq、请求摘要、与事实同事务提交的 `realtime_publications` outbox(与生产写入完全同构);claims 由数据库中未撤销、已验证家庭的真实用户构造,谓词经真实 `ValidateHumanTx`;不暴露任何 HTTP 端点、不改任何生产行为、输出仅计数 JSON。存在理由:恢复语料走 HTTP 要么 20 分钟、要么关生产限流,两者都被明令禁止。

## 6. 本地已验证 / 未执行(如实)

```
$ go build ./tests/acceptance/m4-realtime-fixture/   # FIXTURE-BUILDS(主模块直接编译)
$ go test -race -count=1 ./internal/transport/socketio/...
ok  .../socketio 2.481s   ok  .../core 1.745s   (zishang 编译通过)
$ node --check tests/acceptance/m4-realtime.mjs        # SYNTAX-OK
```

**未执行**:端口绑定在本 worker 沙盒仍被拒(`bind: operation not permitted`),m4-realtime 的 16 组用例与 standalone 全程未在本环境运行。首次真实执行须由父级进行;预期门槛:①deps.SocketIO 接线落地(§2);②各事件由集成 worker 真实发布。任何一条用例失败都按失败处理,本报告不预填通过。

## 7. 已知缺口(精确记录,父级裁决)

1. **pending 握手撤权**的精确瞬间(bob 握手中途移除成员)依赖亚毫秒编排,集成层以"移除后重连被当前授权拒绝 + 已建连接被驱逐"覆盖其可观测面;进程内竞态窗口已由 gateway 单测(TestAdmitRevocationDuringAuthenticate / TestPendingRevocationBlocksOpen)钉死。
2. bulk 语料的**跨频道可见性空洞**(P0 spike 已验;真实 App 恢复中 bob 对公开频道的可见集本套以单一频道验证多页与字节路径,跨频道空洞差量归 m4-message-recovery suite 的 HTTP 侧)。
3. `unread_summary:changed`/`thread:followers-updated` 未单列用例:前者随 read/mute 已被间接观测不到不构成断言缺口(若需要可加);后者依赖 follow 端点与事件的集成完成度,本轮以 carol(公开 viewer)与 bob(follower)的恢复差异覆盖主语义。

## 8. 父级接线清单(不变项从简)

- `deps.SocketIO = zishang engine handler`;`Options.Guard` 用 `db.WithAuthorityReadContext`;`Fence` 用 authority 代缓存(`db.AuthorityGeneration`);撤权写路径提交后调用 `Gateway.Revoke`(logout→family、移除成员→workspace/channel 谓词、转私有→non-members);App.Close 先 `g.Close()` 再释放 DB。
- 注册 suite:run.mjs 登记 `m4-realtime`(父级拥有 run.mjs,本套件只导出 `verifyM4Realtime`)。
