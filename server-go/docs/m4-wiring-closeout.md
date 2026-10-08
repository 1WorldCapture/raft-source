# M4 composition-root wiring closeout (P1-1 a/b/c)

日期：2026-10-09。执行者：M4 收尾评审 worker。范围：仅 `internal/app/m4.go`
与新增 `internal/app/m4_wiring_test.go`（真实装配测试）。未触碰
`m4_socket.go` / `m4_publications.go` 及其测试（在役集成 worker 所有）、
`middleware.go`、legacyweb 既有测试、验收脚本、TS/Web、var*、无 commit/push。

## 1. 已落地的接线（internal/app/m4.go）

### (a) 线程回复推进回复者已读游标 —— 产品路径补全

`buildM4` 现在装配 `messages.SetThreadReplyReadHook(...)` →
`readstate.MarkReadLatestTx`（同一 `*sql.Tx`），并加**装配完整性断言**：
`buildM4` 在 hook 缺失时直接返回错误（fail closed，对应 message worker 报告
§1.0 "生产装配必须接线"）。原行为缺口（跨切片审查 A6）：回复者回复后线程仍
显示未读；现在回复、自动关注与读推进是同一原子事实（hook 失败整个回复回滚）。

### (b) DM readState（#632 union）—— M4ConversationHandlers.DMReadState

`register` 接线 `DMReadState: m.dmReadState` → `readstate.DMReadStateTx`。
DM 列表/创建响应的每行现在携带属主渲染的精确
`{"kind":"absent"} | {"kind":"present",readStateVersion:number,
maxReadSeq:"<decimal>",latestActivity:{messageId,seq}|null}` union；
非 DM scope / 非参与者 / 异空间由 DMReadStateTx fail-closed。

### (c) M4ChannelProjector —— 组合根实现 + m4 侧挂载 + 暴露给父级

`m4Runtime.projectChannels` 逐字段镜像已验证的测试参考实现
（legacyweb `m4TestProjector`）：legacy coalesce-0 标量、公告默认静音
`{true,0,0}`（boundary 0 非 null）、静音边界 null/数字区分、display 默认
`{true,0}`、仅 list 出口的 lastMessageAt（ISO 毫秒 / null）。一处有意升级：
#632 union 由属主切片 `readstate.ReadFrontierJSONTx` 渲染（携带真实
latestActivity 对，而非参考实现的 null），符合 readstate worker 报告 §13.3
"勿单独再发明形状"。全部读取在调用方 pinned snapshot executor 上
（`channel.Executor` 结构性满足 `readstate.Queryer`），无第二连接。

该 projector 已挂到 m4 组合自建的全部 `ChannelHandlers` 实例，并作为
`m4Runtime.channelProjector` 暴露（同包可读）。

## 2. 剩余的唯一父级动作（/api/channels 三个真实出口的最终挂载）

`GET/POST /api/channels`、`GET /api/channels/{id}` 由 **M3 runtime** 在
`internal/app/m3.go:141` 注册：

```go
legacyweb.RegisterChannelRoutes(mux, &legacyweb.ChannelHandlers{Store: m.channels}, gate)
```

m4.go 无法触碰该行（文件所有权），且 ServeMux 精确模式重复注册会 panic，
故 m4 侧无法安全地"覆盖"注册。**父级一行替换即可完成 (c) 的最终挂载**（二选一）：

- 方案 A（推荐）：`m3.go:141` 的实参改为携带 projector 的实例——
  给 `m3Runtime` 加可设置字段 `m4Projection legacyweb.M4ChannelProjector`，
  `app.go` 在 `RegisterAdditional` 闭包内、`execution.register` 之前赋
  `execution.m4Projection = messaging.channelProjector`（同包，无新签名）。
- 方案 B：把 m3.go:141 这一行移入 `app.go` 的 `RegisterAdditional` 闭包
  （`messaging.register` 之后任意位置），改用
  `legacyweb.RegisterChannelRoutes(mux, &legacyweb.ChannelHandlers{Store: ..., M4: messaging.channelProjector}, gate)`。

接线前，真实 `/api/channels` 出口仍输出 M3 fixture 默认值（readState
absent / maxReadSeq 0 / 默认 mute/display / lastMessage null）——即 P1-1(c)
报告的风险仍在；接线后由本 projector 提供真实快照。
`m4_wiring_test.go` 的 `TestM4WiringChannelProjectionExits` 已按"父级完成
挂载后的确切形态"（同一 `RegisterChannelRoutes` 调用 + 真实 gate + 真实
DB + 真实装配的 projector）预先锁定行为。

## 3. 测试证据（internal/app/m4_wiring_test.go，全部走真实 app.Build 装配）

真实账号链路（注册/outbox 验证/资料完成）+ SQL 播种 workspace/成员 +
真实 HTTP 面（v2 发送、threads ensure/read-all、DM、notification-settings、
message-display-settings、threads 摘要），进程内 recorder，无 TCP 监听。

| 测试 | 覆盖 |
|---|---|
| `TestM4WiringAssemblyCompleteness` | 装配级守卫：hook 缺失 / projector 缺失 → 装配期失败 |
| `TestM4WiringThreadReplyAdvancesReplierCursor` | Bob 回复后本人 cursor == 回复 seq、线程摘要 unread=0；Alice cursor 恰为自己的首答 seq（不被他人回复推进）、unread=1；另经真实 readstate store 直读 cursor |
| `TestM4WiringDMReadStateUnion` | 未读 DM 行 absent；read-all 后 present（version≥1、十进制串 maxReadSeq、同源 latestActivity 对）；创建响应 absent；无 token 401（auth seam） |
| `TestM4WiringChannelProjectionExits` | list：已读+已静音+display 已改频道全真值（present union/versions/静音边界数字/collapse=false/lastMessageAt ISO）；未读频道 absent/0/false/null；公告默认 {true,0,0}；detail 无 lastMessageAt 键；create 新会话空态且无 display/last-message 键；跨空间残留不泄漏 |

**变异验证（证明"无接线必红"）**：逐一移除三处接线后对应测试全部失败——
去 hook → `bob thread cursor = 0, want his reply seq 3`；去 DMReadState →
`created DM readState = <nil>`；去 projector → 装配守卫 + 出口断言双红。
还原后全绿（`cmp` 逐字节核对还原）。

## 4. 实际命令

```
GOCACHE=$TMPDIR/go-build-cache \
go test ./internal/app/ -run 'TestM4Wiring' -count=1 -v   # 4/4 PASS
go test ./internal/app/ -count=1                            # 全包 ok（含在役集成 worker 的 m4_socket/m4_publications 用例）
go test ./internal/app/ -run 'TestM4Wiring' -race -count=1  # ok
go vet ./internal/app/                                      # clean
gofmt -l internal/app/                                      # 无输出
```

## 5. 顺带观察（非本次范围，未改动）

- `m4_conversation_handlers.go` 的 `ListDMs` 在快照返回后用裸 `*sql.DB`
  逐行解析 readState（`:116`），与 DM 行集不在同一 pinned snapshot——并发
  写入下行集与 frontier 可能撕裂（D3 族）。文件归 channel worker 所有，
  建议后续把 `dmReadState` 调用移入 `WithReadSnapshot` 闭包内。
