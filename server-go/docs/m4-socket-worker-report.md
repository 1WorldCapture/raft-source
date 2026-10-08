# M4 P0/P3 Socket.IO 传输层 Worker 报告(v2 — 候选库实测重写)

- 日期:2026-10-08(第二轮)。
- 执行者:P3 realtime worker。
- 范围:只修改 `server-go/internal/transport/socketio/**`、`server-go/tests/acceptance/m4-socket-spike*`、本报告。已删除我的 `run.sh`(被父级 `m4-socket-poc.mjs` 取代);未触碰父级 runner/helpers/app/schema/migrations/`go.mod`/UI/live 服务;未提交、未推送。
- 结论:**候选库已按缓存真实源码(servers/socket/v3@v3.0.6)重写全部绑定并通过编译验证(临时 `-modfile`,零网络);gateway/core 在原语级实现了 authority 契约(guard/proof/per-family epoch/谓词受众/字节预算 resume/raw close/写停滞),全部测试 race 通过。剩余未执行项只有需要网络与端口的实际互通(父级执行)。**

## 0. 上一版问题与本轮修复对照

| 父级反馈 | 修复 |
|---|---|
| `github.com/zishang520/socket.io/types` 不存在 | 真实类型在 `github.com/zishang520/socket.io/v3/pkg/types`;四个模块(servers/socket、servers/engine、parsers/{socket,engine}、根 v3)均 @v3.0.6,Go 1.26.0。全部 import 已改,编译通过 |
| 14 个 VERIFY 猜测点 | 全部按缓存源码重写,已核实并注明来源(§2);VERIFY 标注全部移除 |
| JWT IssuedAt/ExpiresAt 不可变进 identity、精确过期 | `TokenProof{IssuedAt,ExpiresAt}` 由 `Identify` 返回并冻结进 `Identity`;Admit 拒绝无过期证明与已过期 token;每次 enqueue 前与心跳 sweep 都按**该连接自己的** token 过期关闭(新 token 不延长旧连接) |
| 注入式短准入守卫(check+非阻塞 admission 原子) | `AdmissionGuard` 接口(`Options.Guard`,**必填**);Admit 的 fence 复读+比对+pending 注册、以及每条 Publish 的资格检查+有界入队都在 guard 内;守卫内零网络/零阻塞等待(测试断言) |
| per-family epoch 独立于 user/workspace | `FenceScope{Kind: User|Family|Workspace, ID}` 对齐 `db.AuthorityGeneration(handle, kind, id)`;Identity 冻结三代快照;logout 只 bump family、password reset bump user(测试覆盖隔离) |
| 提示 revoke family/predicate API、谓词受众发布 | `Gateway.Revoke(Revocation{UserID, SessionFamilyID, WorkspaceID, Scope, MemberUserIDs})`;`PublishWhere(event, payload, include func(Identity) bool)` — 谓词在 guard 内对当前 opened 连接按当前事实裁决;`PublishUserServer` 交集房保留 |
| 32000 CJK / 500 长消息 resume 不重连循环 | resume 按字节预算分页:`SyncVisible(..., maxMessages, byteBudget)`;gateway 兜底裁剪页(truthful currentSeq=最后纳入行 seq / hasMore);单页永不超队列字节界 → 不触发慢消费者断开 → 无循环;预算耗尽(空页+<4KiB)时断开,每次重连获得全量预算(有界重试);两个专门测试 |
| 上游无界缓冲/慢写 | 源码核实:engine `writeBuffer`(slice)与 ws `writeQueue`(never-blocking queue)双层无界、ws 写**无 deadline**。drainer 改为发射窗口(`Transport().Writable()` 门槛)+ `WriteStallTimeout`(默认 30s)后 raw close with discard;上游可积压量被钉死在本网关队列界内;无 goroutine 泄漏(测试覆盖) |
| `Socket.Disconnect(true)` 会先发 namespace disconnect 并禁自动重连 | **源码确认**(client.go `_disconnect()` 先对每个 ns 发 DISCONNECT packet)。撤权/慢断开/停滞一律 `Client.Conn().Close(true)`(engine 层 discard raw close,无 namespace packet → 客户端 "transport close" 自动重连);spike 用例 09/10 专门对照两种断开 |
| spike client 期望 500+500,实际 800 可见 | fixture 真值:1200 条、每 3 条 1 条入 u2-only `ch-secret` → u1 可见 **800**;断言改为页1=500(hasMore)、页2=300(complete,currentSeq=最后送达行 seq,低于全局 2200 高水位) |
| rooms:joined listener 晚挂 | 09/10/11 用例全部在触发前 attach 等待器 |
| 生产 build-tag 排除 | 从未使用 build tag;代码无条件存在,-modfile 编译验证 |

## 1. 沙盒仍然受限的部分(如实声明)

网络出口与本地端口绑定仍被策略拒绝(`user denied`/EPERM),因此:**实际网络互通(spike 运行、原客户端握手、真实断开行为)未在本环境执行** —— 由父级运行 `m4-socket-poc.mjs`。其余全部工作(源码核实、编译、race 测试)已真实完成,命令与输出见 §5。

## 2. 上游核实(v3.0.6 缓存源码,逐条来源)

| 事实 | 源码位置 | 用途 |
|---|---|---|
| import 路径:`servers/socket/v3`、`servers/engine/v3`、`v3/pkg/types`(根模块提供 types/queue 等 pkg) | 各 go.mod | 绑定层 import |
| `socket.NewServer(nil, *ServerOptions)`;`DefaultServerOptions()`;`ServeHandler(nil).ServeHTTP` 幂等复用 engine | server.go:111/297 | 无 attach 创建 |
| `SetTransports(*types.Set[TransportCtor])`;`socket.WebSocket` TransportCtor;`SetServeClient(false)`;`SetPath/SetPingInterval/SetPingTimeout/SetMaxHttpBufferSize` | engine config/server-options.go、socket.io.go | websocket-only 配置 |
| `NamespaceMiddleware = func(*Socket, func(*types.ExtendedError))`;`srv.Use(...)` | namespace-type.go:9、server.go:601 | 准入 middleware |
| middleware 错误 → EIO4 客户端收 `{"message": err.Error()}` | namespace.go run() `socket._error(map{"message":...})` | 五个错误关键词逐字透传 |
| `Socket.Emit(ev, args...)`;encoder `preprocessData` 对 `json.RawMessage` 直通,`json.Marshal` 原样内联 | socket.go:301、parsers/socket encoder.go | 单 payload 事件,预序列化不重写 |
| **`Socket.Disconnect(true)` → `Client._disconnect()` 先对每个 namespace socket 发 DISCONNECT packet 再 `close()`** | client.go:134-141 | **撤权禁用该路径** |
| `Client.Conn()` → engine.Socket 接口;`Close(true)`=discard 立即关(不等 drain);`Close(false)`=等 drain(慢消费者会拖住) | engine socket.go Close | raw close 路径 |
| engine `writeBuffer` 无界 slice;`flush()` 仅在 `Transport().Writable()` 时搬运;ws `Send()` 立即 `SetWritable(false)` 并 enqueue;ws `writeQueue.Enqueue` **从不阻塞、无界**;ws 写无 deadline | engine socket.go sendPacket/flush、transports/websocket.go Send/send、pkg/queue/queue.go | 发射窗口 + 停滞超时设计 |
| `transports.Transport.Writable()` 在接口上公开 | transport-type.go | CanAccept 实现 |
| `HttpContext.Request() *http.Request`;`Handshake{Headers, Auth map[string]any}` | types/http-context.go、socket.go:33 | 准入拿原始请求与 auth |
| parser 解码:number→float64、object→map[string]any | parsers/socket decoder.go:439 | gateway 严格校验前的 arg 形态 |
| `Server.Close(fn)`:每 socket "server shutting down" 后 engine.Close() 每 conn `Close(true)` | server.go:575、base-server.go:275 | 关停收割 hijacked |

## 3. 交付物(最终)

```
server-go/internal/transport/socketio/
├── options.go      Options(必填 Guard)+ AdmissionGuard + TokenProof + 六个回调接口
│                   (ResumeProvider 带 byteBudget;ResumePage 带 Seqs)
├── gateway.go      Admit(guard+proof+三代 fence)/屏障/事件/守卫内发布/PublishWhere/
│                   字节预算 resume+truthful 裁剪/写停滞 drainer/心跳过期 sweep/Close 收割
├── gateway_test.go fake 全链路(含 guard TOCTOU、expiry、family 隔离、bounded resume、stall)
├── core/           identity(kind 化 fence)/fence/queue/origin/ratelimit/lifetime/conn/registry
│                   + 全部 *_test.go(race)
└── zishang/        绑定层:真实 API,raw close=Conn().Close(true),CanAccept=Writable(),
                    origin/polling 前置拒绝;`_ socketio.Transport` 与 `_ http.Handler` 编译期断言

server-go/tests/acceptance/m4-socket-spike/
├── README.md       运行方式(父级 runner)与退出标准
├── go.mod          候选 pin 参考(runner 会覆盖;注明 go1.26 要求)
├── main.go         spike server(真实 API;raw close 对照 namespace disconnect;800 可见 fixture)
└── client.mjs      原版 socket.io-client@4.8.3 断言(13 组;触发前挂 listener)
```

## 4. 依赖(父级 pin 动作)

实测解析(父级 P0 已取):`github.com/zishang520/socket.io/servers/socket/v3 **v3.0.6**`(Go 1.26.0),兄弟模块 `servers/engine/v3`、`parsers/socket/v3`、`parsers/engine/v3`、根 `v3` 同为 v3.0.6;传递依赖含 gorilla/websocket v1.5.3、andybalholm/brotli、klauspost/compress、msgpack/v5、gookit/color、quic-go(+webtransport-go)、dunglas/httpsfv、vmihailenco/tagparser、xo/terminfo —— **全部已在本地 module cache**。精确 checksum 请以 `m4-socket-poc.mjs` 输出的 `{path, version, sum, goModSum}` 为准 pin 入主 `go.mod`(我无法读 sumdb,不手抄)。

**注意**:runner 当前写 `go 1.25` 的临时 go.mod,而候选要求 go ≥ 1.26.0 —— 本地 go1.25.5 不会为依赖要求自动切 toolchain,直接报错(已实测)。请把 runner 的临时声明提到 1.26.0+(父级拥有该文件;spike/go.mod 里也留了说明)。

## 5. 测试(真实命令与输出)

环境:go1.25.5(缓存 toolchain go1.27.1 实际构建)、`GOCACHE=$TMPDIR/gocache`、`GOPROXY=off GOPRIVATE='*'`(全部来自 module cache,零网络)。

```
# 1) 主模块 socketio 全树(含 zishang 绑定)编译 + vet + race 测试,经临时 -modfile:
$ go build -modfile $TMPDIR/m4socket/go.mod ./internal/transport/socketio/...   # TREE-BUILD-OK
$ go vet  -modfile $TMPDIR/m4socket/go.mod ./internal/transport/socketio/...    # 无输出
$ go test -race -count=1 -timeout 150s -modfile $TMPDIR/m4socket/go.mod \
      ./internal/transport/socketio/...
ok   raft.local/server-go/internal/transport/socketio         2.371s
ok   raft.local/server-go/internal/transport/socketio/core    2.439s
?    raft.local/server-go/internal/transport/socketio/zishang [no test files]

# 2) spike(复制 main.go 到隔离模块,模拟父级 runner 的构建路径):
$ cd $TMPDIR/m4spike && go build -o spike .          # SPIKE-COMPILES
$ CGO_ENABLED=0 go build -o spike-cgo-free .        # SPIKE-CGO-FREE-OK
```

新增/强化测试(均通过):守卫内 TOCTOU(guard during bump → AuthChanged;guard 后 bump → 帧不入队且断开);token 过期(Admit 拒绝过期/无证明;publish 拒绝并断开;心跳 sweep 断开;**advance 后新 token 可再接入**);family 隔离(f1 bump 不影响 f2;workspace bump 只影响绑定连接);字节预算 resume(2MB 页裁剪进 1MiB 预算、currentSeq=最后纳入行 seq、hasMore truthfully、消息数 <500;预算 <4KiB 空页 → 断开而非循环;新连接全量预算可恢复);`PublishWhere` 谓词不泄漏;写停滞(transport 40ms 不可写 → discard 关闭,StalledClosed=1);外加原有全量(关键词、屏障、交集、撤权矩阵、限流、上限、Close)。

**未执行**:实际网络互通(端口绑定被禁)。spike 由父级运行:`node tests/acceptance/m4-socket-poc.mjs`(先按 §4 修 runner 的 go 版本声明)。

## 6. 接线面(与 v1 相同处从简,新变化加粗)

```go
opts := socketio.Options{
    Auth:  authAdapter,   // Identify(ctx, token) (user, family, TokenProof, err); Authenticate(req)
    Fence: fence,         // core.AuthorizationFence: Generation(FenceScope{Kind,ID}) uint64 —— 对齐
                          //   db.AuthorityGeneration(handle, kind, id);非阻塞、禁网络
    **Guard: authorityGuard,  // db.WithAuthorityReadContext 适配(必填)**
    ChannelRooms / Join / Heartbeat / Origins 同前,
    Resume: readModel,    // SyncVisible(ctx, id, lastSeq, maxMessages=500, byteBudget)
    **WriteStallTimeout / ResumeFrameOverheadBytes 可选**
}
g, _ := socketio.New(opts); eng, _ := zishang.New(g, zishang.Options{})
g.StartHeartbeat(); mux.Handle("GET /socket.io/", eng)
g.PublishChannel / PublishWorkspace / PublishUserServer(交集) / **PublishWhere(谓词受众)**
g.Revoke(&core.Revocation{UserID, SessionFamilyID | WorkspaceID, Scope, MemberUserIDs})
g.Close()  // App.Close 内、释放 DB 前
```

父级撤权写路径约定(m4-authority-contract):bump 对应 kind 的 fence(在写事务内捕获、提交后更新缓存)→ 释放写 fence → `g.Revoke(...)`(驱逐 transport)。发布路径在 guard 内做三代 fence 比对,check/use 竞态闭合。

## 7. 与 TS 的有意差异(v1 §8 全部保留,新增)

- resume 请求严格 JSON number + 安全整数(TS truthiness 会放过字符串数字)。
- 心跳 hub 级单循环;屏障失败/超时 fail-closed 断开。
- **每连接 token 过期强制**(TS 无 per-socket token 到期);**字节预算 resume 分页**(TS 单页 500 不看字节)——两者是 authority/backpressure 契约新增,不破坏原 wire 形状(`{messages,currentSeq,hasMore}` 不变)。

## 8. 下一步

1. 父级把 runner 临时 go.mod 提到 go 1.26.0,运行 `m4-socket-poc.mjs` → 13 组断言 + SIGINT 清理;按输出 pin 主模块依赖。
2. spike 通过后:主 `go.mod` require 五个模块 @v3.0.6(校验和取 runner 输出),删除临时 modfile,常规 `go test ./internal/transport/socketio/...`。
3. 集成人按 §6 接线并登记 `m4-socket-client` suite;许可证/漏洞审计在依赖树落地后执行(cache 内齐备)。
