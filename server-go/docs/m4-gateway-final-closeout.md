# M4 网关 F3 安全加固收尾（gateway 准入契约）

对应评审发现:`roomBarrier` 的 `rooms:joined` 与 `handleResume` 的 `sync:resume:response` 直接调用 `g.enqueue`,未经过 `opts.Guard.Guard`,与 `Publish`/`PublishWhere` 不一致,存在 check/use 竞态。本文记录核实结论、修复内容与证据。仅描述代码契约,不是已验收报告。

## 核实结论:下游出队并不能保护实际发射

- 出队路径(`startDrainer`)在 `Queue().Take` 之后只复查 `cs.Revoked()`,**不重读 fence generation**。
- `MarkRevoked` 由 `Gateway.Revoke` 置位,而 `Revoke` 挂在提交后的 eviction wake(commit listener)上,在 authority fence 释放**之后**异步执行。
- 因此存在真实窗口:撤销已提交(generation 已 bump、缓存已更新),eviction wake 尚未落地,竞态窗口内入队的帧会被 drainer 发射。下游没有"受守卫保护的出队"。
- `m4-authority-contract.md` 明确:"A generation check without the guard is insufficient because a revocation can interleave between check and use"。因此必须在**准入侧**强制契约,这与本修复一致。

## 修复内容(仅 `internal/transport/socketio/gateway.go`)

1. **`roomBarrier`**:`rooms:joined` 帧经 `guardedEnqueue`( admission guard 内完成 fence 读 + 有界入队)。`ChannelRooms` DB 解析保持在 guard 外。guard 获取被放弃(关停/取消/超时)时 fail closed:断开连接、绝不未守卫发射。
2. **`handleResume`**:`sync:resume:response` 帧同样经 `guardedEnqueue`;`SyncVisible` provider 读保持在 guard 外。guard 放弃时 fail closed 断开(客户端重连重同步,不"看似已同步")。
3. **`heartbeatTick`(核实中发现的同类路径,评审未列出)**:心跳帧原先同样未守卫直接 `enqueue`。现按 workspace 批次在 guard 内准入;`WorkspaceSeq` DB 读与过期清扫仍在 guard 外。guard 放弃时跳过本 tick(周期性遥测自愈,撤销驱逐仍会关闭未授权连接),不触发断连风暴。
4. **publish guard 有界可取消**:
   - 新增 `PublishContext` / `PublishWhereContext`,及便捷变体 `PublishChannelContext` / `PublishWorkspaceContext` / `PublishUserServerContext`;
   - `Publish` / `PublishWhere` / 便捷方法保留为向后兼容包装(语义不变,但现在受 `guardAcquireTimeout` 有界);
   - `withGuard`:调用方 ctx 无 deadline 时统一附加 `guardAcquireTimeout = 5s` 上界;取消/超时在**任何帧入队之前**放弃整批(守卫临界区本身同步非阻塞,不存在半批状态)。
5. **新增观测**:`Stats.GuardAbandoned`(guard 获取被放弃计数);所有守卫段落统一计入 `Stats.Guarded`。
6. **不变量保持**:guard 内只有 fence 读 + 有界队列 offer + 既有的 `handleEnqueueErr` 路径(`CloseTransport` 为非阻塞 raw close,原 `Publish` 已如此);不持有 guard 跨 DB/网络/阻塞等待;generation、有界队列、wire 语义(事件、envelope、静默忽略行为)全部不变。

## 确定性回归(`gateway_guard_hardening_test.go`,全部经既有 seam:guard/fence/provider/transport 桩)

- 守卫覆盖计数:rooms:joined / resume 响应 / 心跳各自的准入都会经过 guard(旧代码计数不增长——变异验证:回退任一路径,对应测试必失败)。
- TOCTOU:守卫临界区内发生(或已发生)workspace/user 撤销提交时,帧被拒并断开,无发射。
- fail closed:guard 拒绝获取(refuse)时 rooms:joined / resume 响应不发射且连接关闭;barrier 的 guard 等待受 `RoomSetupTimeout` 约束(有界验证)。
- 心跳 guard 放弃:跳过 tick、不断连、计数。
- publish 取消:已取消 ctx 在任何帧 offer 前放弃,`GuardAbandoned=1`,无误断连;无 deadline 的 legacy `Publish` 获得约 `guardAcquireTimeout` 的 deadline,调用方自带 deadline 原样透传。
- 无守卫跨越 provider 读:`ChannelRooms` / `SyncVisible` / `WorkspaceSeq` 执行时 guard 不活跃。

## 证据

- `go build ./...` 通过;`go vet ./internal/transport/socketio/...` 干净;`gofmt` 干净。
- `go test -count=1 ./internal/transport/socketio/...` 与 `go test -race -count=2 ./internal/transport/socketio/...` 全绿(含全部既有测试 + 14 个新回归)。
- `go test -count=1 ./internal/platform/db/` 全绿(authority fence 语义未受影响)。
- 变异验证:将 roomBarrier / handleResume / heartbeat 批次分别回退为未守卫写法,对应回归测试均失败;已恢复。
- `internal/app` 存在**既有失败** `TestM4PublicThreadMessageLiveHonorsPerSocketInterest`(per-socket interest 泄漏),经行为回退对照复跑确认为父工作区既有问题(与本次改动无关,三次复现一致);属 app/publication 侧,不在本次写权限内。

## 需要父层跟进的调用点改造(可选,向后兼容)

app 侧(`internal/app/m4_publications.go`)可将 publisher 调用切换为 context-aware 变体,使 guard 等待绑定请求/关停上下文:

- `deliver` / `fanoutUnreadSummary` / `deliverSet` 增加 `ctx` 参数(由 `publishXxx(ctx, …)` 透传);
- `gateway.PublishWhere(...)` → `gateway.PublishWhereContext(ctx, ...)`;
- `gateway.PublishUserServer(...)` → `gateway.PublishUserServerContext(ctx, ...)`。

不改造时行为不变(legacy 包装已受 5s 上界)。

## 边界

- 保证的是"已提交撤销之后不再授权**新** payload 准入(入队)";已交给网络的字节不可收回(契约原文)。
- guard 放弃造成的 publish 跳过不重试内存帧;持久面(publication outbox / 客户端恢复)仍是重试与补同步的归属。
