# M4 APPLICATION 实时组装集成报告（m4_socket / m4_publications）

- 日期：2026-10-09（含 2026-10-08 深夜父级评审意见落实）。执行者：APPLICATION realtime 组装（本文唯一新增文件：`internal/app/m4_socket.go`、`internal/app/m4_publications.go`、`internal/app/m4_socket_test.go`、`internal/app/m4_publications_test.go`、本报告）。
- 基线：四份已批准 M4 设计文档 + `m4-execution-lock.md` + `m4-authority-contract.md` + `m4-socket-integration-notes.md` + message/channel/readstate/acceptance worker 报告与两份 review notes。
- 性质：实现与集成记录，不是验收结论。真实 socket.io-client 互通（`tests/acceptance/m4-socket-poc.mjs`）与浏览器/UI 验收归父级；本沙箱禁止本地端口绑定（EPERM），全部测试为进程内驱动。

## 1. 交付物与所有权边界

| 文件 | 内容 |
|---|---|
| `internal/app/m4_socket.go` | `buildM4Realtime` 构造器、握手鉴权/围栏/守卫/房间/加入/恢复/心跳六个适配器、撤权驱逐 wake、生命周期 `Handler()`/`Close()` |
| `internal/app/m4_publications.go` | 事务性 outbox publisher：把 durable publication 引用重投影为当前事实 + 当前受众，经网关守卫送达 |
| `internal/app/m4_socket_test.go` | 进程内协议/状态/负例测试（真实迁移库、真实 JWT、真实 m4Runtime、注入式 Transport 驱动真实网关） |
| `internal/app/m4_publications_test.go` | publisher 行为/隐私/受众/完成与失败语义测试（真实域写入 → commit listener 唤醒 → 真实 outbox worker → 真实网关送达） |

未修改：`app.go`/`m4.go`（父所有）、socket/message/channel/readstate worker 文件、schema、clients/UI/TS、`var*`/4301/5175、commits（未提交未推送）。

**依赖状态（如实申报）**：父级在本任务执行中途已将 `github.com/zishang520/socket.io/{servers/engine/v3,servers/socket/v3,v3} @v3.0.6` pin 入主 `go.mod`；其时 `go.sum` 缺条目导致 `go build ./...` 失败，我执行了一次 `go mod tidy`（零网络，全部来自本地 module cache，`go.mod`/`go.sum` 变化均为追加：间接依赖与 go.sum 校验和）。此后 `go build ./...` 通过。若父级希望自行管理该文件，请复核这两处追加。

## 2. 构造器与生命周期（父级接线面）

```go
rt, err := buildM4Realtime(messaging, signer, logger, origins) // messaging=*m4Runtime（app.Build 已有）
mux.Handle("GET /socket.io/", rt.Handler())                    // websocket-only Engine.IO v4
defer rt.Close()                                                // 必须在 DB Close 之前
```

- `buildM4Realtime(m *m4Runtime, signer *auth.TokenSigner, logger *slog.Logger, origins []string) (*m4Realtime, error)`。
- `origins` 建议来自 `cfg.WebOrigin`（显式配置；绝不从 Host 推导）。空列表会拒绝所有带 Origin 的浏览器握手（网关记录一条 Warn）。
- 构造即启动：应用心跳循环（原 15s 节拍）、outbox publisher 单 worker（`realtime.Store.Start`，commit-listener 唤醒）、authority 驱逐 wake worker。`StartHeartbeat` 失败（与 Close 竞争）时构造返回错误并自行回收。
- `Close()` 顺序（幂等）：先停 publisher（不再产生新帧）→ 摘除 authority listener 并 join wake worker → `gateway.Close()`（raw-close 所有 hijacked socket——`net/http` Shutdown 够不到的部分——并 join drainer/屏障/心跳 goroutine）。**父级必须在 `DB.Close()` 之前调用**；无需其他停止顺序要求。
- `Stats()` 暴露网关计数器（admitted/rejected/revokedClosed/queueOverflowed/…）与 publisher 计数（published/completed/deferred/unknown/summary invalidations）+ 被丢弃的 wake 数，供运维与验收读取。

## 3. 当前消费的跨模块 API 快照（别名对照）

| 用途 | 实际 API（当前源码） | 备注 |
|---|---|---|
| 握手身份 | `auth.TokenSigner.VerifyAccessToken` + `auth.ValidateHumanTx(ctx, ex, claims, now)` | `auth.ErrTokenWrongType` → 网关 `ErrInvalidTokenType`（原客户端 refresh 触发词逐字保留） |
| 围栏 | `db.AuthorityGeneration(handle, kind, id)`；kind ∈ user/family/workspace | `core.FenceKind*` 一一映射 |
| 准入守卫 | `db.WithAuthorityReadContext(ctx, handle, fn)` | 网关在守卫内只做 fence 比对 + 有界入队；本层不在守卫/事务内做任何 DB 读或网络写 |
| 初始房间 | `channel.Store.ListSubscriptionsTx`（快照内） | 公开全域 / private、DM 按 roster / 线程按有效 follow（sync 可见性集合） |
| join:channel | `channel.Store.AuthorizeConversationTx(posting=false)` | 基础内容授权；`channel.AsDomainError` 视为拒绝（fail-closed），显式 join 不写 follow |
| 恢复 | `message.Store.ResumePage(claims, ws, lastSeq, message.ResumeOptions{MaxMessages, MaxEncodedBytes})` | **这就是 notes 预告的 "ResumeByte" 增量的落地名**：500 条原上限 + 字节预算都在 `ResumeOptions`；claims 从连接冻结身份重建（绝不信 resume body） |
| Live 受众 | `message.Store.LiveEligibilityForChannel`（= notes 预告的 "AudienceForLive"） | 本层**未走逐连接调用**（N 连接=N 次 DB 读，不可在守卫内）；改为一次快照解析**策略受众集合**（§7 表；私有/DM 父链线程= `thread_follows` 当前 active follower），裁定文字与该 API 等价 |
| 消息投影 | `message.Store.ProjectPublication`（message:new/updated、reaction_viewer、thread 三类） | 密封投影唯一入口 `SocketMessageNew/SocketMessageUpdated`；本层不另算覆盖/聚合 |
| 心跳高水位 | `SELECT COALESCE(MAX(seq),0) FROM messages WHERE workspace_id=?` | 提交序号提示，非 ACK |

## 4. 握手与连接身份（authority 合同落实）

1. `Identify`：仅同步 JWT 解码（签名/类型），proof = **该已验证 token 自身**的 IssuedAt/ExpiresAt（绝不查“该用户最新 token”）。
2. `Authenticate`：pinned 只读快照上 `ValidateHumanTx`（过期/类型/family 归属/撤销/真实已验证用户）+ serverId 的当前成员资格与 role（workspace 存活、非 joint_storage）；无成员资格 → 原句 `Not a member of this server`；DB 故障 fail-closed（网关按 invalid/expired 分类）并记录真实原因日志。
3. 网关在**准入守卫内**复读三代 fence（user/family/workspace）并冻结 Identity；此后每次入队与心跳 sweep 都按**该连接自己的 token 过期**关闭——新 token 不延长旧连接（有测试钉死）。
4. account 级连接（无 serverId）：只进 user 房，永不 rooms:joined、永不 resume（有测试）。

## 5. 撤权驱逐模型（重要——测试与现场行为的解释）

`0012` 触发器决定：**任何 channels / channel_humans / workspace_memberships / workspaces 变更都 bump workspace epoch；thread_follows 变更 bump 该用户 epoch；family 撤销 bump family epoch**。本层把 `db.RegisterAuthorityListener` 的每次变更翻译为网关驱逐：

| 变更 | 驱逐 | 效果 |
|---|---|---|
| family | `Revoke{UserID: 属主, SessionFamilyID}`（属主由 session_families 反查；行已删则记日志，fence+心跳兜底） | 仅该 family 的 socket（family 隔离有测试） |
| user | `Revoke{UserID}` | 该用户全部 socket（含 follow/unfollow——保守设计，客户端自动重连重订阅） |
| workspace | `Revoke{WorkspaceID, ScopeAll}` | 该 workspace 全部 socket |

- Listener 回调零网络零阻塞：只向 256 深度有界队列投递；溢出计数丢弃（fence 仍是最终守卫，日志首条+每千条告警）。**wake 队列永不关闭**（父级评审 §2：Close 取消订阅后，已捕获回调的在途提交仍可能投递，向已关闭 channel 发送会 panic）；终止以 wakeDone 信号 + workerDone join 完成（有并发提交 × Close 的竞态测试）。
- family 硬删除（行已不存在）：同一事务必然连带 bump 属主 USER epoch（users 删除级联 session_families），同批 user 变更完成驱逐；family 墓碑本身保持 fence 权威。属主反查用 2s 有界 ctx、Close 期间短路跳过、失败日志不携带原始 SQL 错误串。当前稳定 core.Revocation 无 family-only/自定义匹配形状，故不伪造接口（报告 §9 记录请求）。
- **推论（现场可见行为）**：新建频道/DM/线程、成员变更等提交的瞬间，整个 workspace 的在线连接都会被断开并自动重连——这是 0012+围栏的既定保守语义，不是本层缺陷；消息、reaction、readstate/prefs 提交不 bump epoch，长连接在这些写入下稳定送达（测试按此排序）。
- 已经送上网络的字节不可撤回；保证是“撤权提交后不再基于旧权限授权新数据”。

## 6. Publisher 语义（显式，不吞错）

**受众绑定（父级评审 §1 落实）**：每次投影前捕获 `db.AuthoritySerial`（全局已提交 authority 水位，内存读），全部读取完成后复核，且**进入网关守卫内的发布谓词**——工作区匹配 + 当前策略集合成员 + serial 未变三者同时成立才入队。serial 变化 → 意图保留重试（`errAudienceStale`），变更提交前已入队的帧不撤回（客户端按稳定 ID 去重），变更后不再有任何旧受众帧被新连接接受。**所有**共享会话事件都走 `PublishWhere` 策略谓词发布（频道房只作订阅索引，不再承载投递授权）；私人事件走 subject 的 user∩workspace 交集房。

| intent（object/event） | 投影 | 受众（§7） | 完成（nil）条件 |
|---|---|---|---|
| `message/message:new` | `SocketMessageNew`（密封 DTO + conversationContext） | 策略集合；DM 消息活动**另发** `dm:new {channelId}` 给双方参与者（父级评审 §3） | 事实已删 → completed（无投递） |
| `message/message:updated` | `SocketMessageUpdated`（密封聚合，无任何 viewer 私有字段） | 同上 | 同上 |
| `reaction_viewer/reaction_viewer:updated` | message worker 私人快照 | **仅** subject 的 user∩workspace 交集房 | 事实已删/无 subject → completed |
| `thread/thread:updated`（message worker，rev=回复 seq）与 `channel/thread:updated`（channel worker，rev=1） | `ProjectPublication(objectType=thread)`（thread 摘要事实 + ServerID 由 ref 补齐） | §7 线程规则 | 线程/父链消失 → completed |
| `channel/dm:new` | `{channelId}`（绝不发 channel DTO） | DM 双方参与者（创建/复活 intent 与 DM 消息活动派生 intent 两条来源） | 频道已删/非 DM → completed |
| `thread_follow/thread:followers-updated` | `{threadChannelId}` | §7 线程规则 | 线程消失 → completed |
| `read_state/read_state:updated` | 0011 表当前行 `{serverId,scopeId,maxReadSeq,readStateVersion}` | subject 交集房 | 行已无 → completed |
| `read_state_bulk/read_state:updated_bulk` | 该用户全部当前行 scopes（readstate 现已不再写入该 intent——见 §9.1；projector 保留） | subject 交集房 | 无行 → completed |
| `unread_summary/unread_summary:changed` | `{serverId}`（纯失效提示，无伪造计数） | subject 交集房 | 总是 published |
| `notification_prefs/notification_prefs:updated` | 冻结 envelope `{serverId,scopeId,prefs{activityMuted,muteFromSeq},prefsVersion}`（有效态= muted∧有边界；无行按诚实默认，announcement 频道带原默认静音） | subject 交集房 | — |
| `message_display_prefs/message_display_prefs:updated` | `{…,prefs{collapseLongMessages},prefsVersion}`（无行默认 collapse=true/v0） | subject 交集房 | — |

- **新消息的未读失效**：message worker 不为收件人 enqueue unread_summary；本层在 `message:new` 出版时向“计数受众 − 发送者”（公开频道=当前成员、private/DM=roster、**线程=active followers**，与 readstate 计数口径一致）发 `{serverId}` 失效提示，计数始终由客户端 HTTP 重读真实摘要——不伪造任何 count（有正/负测试：发送者收不到、其他成员收到）。
- 错误语义：投影/受众解析的**瞬时 DB 故障 → 返回错误 → 行保留重试**（attempts+1 指数退避，有测试）；**serial 失配（受众快照过期）→ 保留重试**（stale 计数，有测试）；**未知 object/event → 计数+类型化错误，保持 pending**；**重试预算（attempts≥8）耗尽后 PARKED**——重试一个永远不可投影的类型不可能成功，而毒行会占满有界 backlog 阻塞新 intent，故显式标记处理+ERROR 日志+独立计数（绝不静默，有测试）；**事实已删 → 显式 completed 计数后正常标记 published**（有测试）。
- 全部投影与受众解析在守卫**外**的只读快照完成；网关在守卫内仅做 fence 比对 + 有界入队。绝无嵌套 fence、绝无 fence 下网络写。

## 7. Live 受众规则（冻结合同逐条 + 父级评审裁定）

投递一律按**当前策略集合**经 `PublishWhere` 谓词发布（serial 绑定见 §6）；房间只是订阅索引：

| 会话 | live 策略集合 | 未读计数集合 |
|---|---|---|
| 公开频道 | 当前 workspace 成员 | 同 live |
| private 频道 | 当前 roster 成员 | 同 live |
| DM | 双方参与者 | 同 live |
| 公开父频道线程 | 当前 workspace 成员（**显式 viewer 依策略包含**，无需 follow，也不依赖其是否入房） | active followers |
| 私有/DM 父链线程 | **仅当前 active follower** | 同 live |

- 私有父链线程的负断言：已入线程房的非 follower 对 message:new / thread:updated / thread:followers-updated 三类事件零收件（有测试）。
- 公开父线程回复送达显式 viewer（有测试）；公开父线程的策略投递包含从未 join 的普通成员——较 TS 房间投递为**超集**（均为 base-authorized 的共享事实，无私数据；未读计数仍按 follower 口径），这是“房间仅是订阅索引”裁定的直接结果，记录为有意偏差。
- 与 TS 的差异记录：TS 在 emit 前把 follower 的 socket `socketsJoin` 进线程房；Go 网关无服务端入房 API（接口冻结不改），策略集合投递语义等价（follower 一定收到）。DM 创建事件因 §5 驱逐语义天然以“重连后 HTTP 发现”为主；DM 消息活动派生的 dm:new 已补（父级评审 §3），被动/隐藏对端可刷新。
- 私人状态（read/mute/display/viewer）一律走 `user:{uid}:server:{sid}` **交集房**，绝不 user 房+server 房并集（跨工作空间/跨用户泄漏均有负测试）。

## 8. 测试证据（实际命令，2026-10-08，本机共享 checkout）

```
$ GOCACHE=$TMPDIR/gocache go build ./...                                  # OK（全模块，含 zishang 绑定）
$ go vet ./internal/app/ ./internal/realtime/ ./internal/transport/socketio/...   # clean
$ go test ./internal/app/ -run 'TestM4Realtime'  -count=1   # ok   ~5s（15 用例）
$ go test ./internal/app/ -run 'TestM4Publisher' -count=1   # ok   ~3s（16 用例）
$ go test ./internal/app/ -run 'TestM4Realtime|TestM4Publisher' -count=1 -race    # 连续 8 次 ok（每次 ~19s）
$ go test ./internal/app/ -count=1                           # ok   ~6s（既有用例不回归）
$ go test ./internal/realtime/ ./internal/transport/socketio/... -count=1         # 全 ok
$ go test ./internal/... -count=1
ok  internal/{agent,app,auth,channel,computer,message,platform/{buildinfo,config,db},readstate,realtime,runtimecatalog,transport/{machinews,socketio,socketio/core},workspace}
FAIL internal/platform/mail     # TestReviewSMTPHonorsCancellationDuringGreeting：bind EPERM（既有沙箱限制，非本层）
FAIL internal/transport/legacyweb  # channel worker 本轮在途编辑（m4_channel_projection* 新文件编译/断言）+ 既有 TestM3WebSocketUpgrade bind EPERM；均非本层文件
```

覆盖（m4_socket_test.go，进程内真实网关 + 注入 Transport；含父级评审 §2 的 Close/在途提交竞态测试）：
- 状态/协议：成员握手 → rooms:joined 屏障；account 级无流；join:channel 允许/拒绝计数；sync:resume 字节预算分页（30000 CJK×12 条 → 页被裁剪、currentSeq=最后纳入行 seq、hasMore 真值、续页补齐至高水位、0 游标按设计忽略）；resume 可见性（未关注线程不进流、空洞推进 currentSeq）；心跳 {seq,ts} 真实高水位。
- 负例：错误 token 类型/过期/垃圾签名/非成员 serverId/已撤销 family 的五类原句拒绝；per-connection token 到期（发布路径精确关闭；新 token 不延长旧连接，不与房间屏障竞速）。
- 生命周期竞态：8×5 路并发 authority 提交与 Close 交错（含取消订阅后的在途回调）零 panic/死锁/泄漏。
- 撤权：family 撤销只驱逐该 family（隔离断言）+ 撤销后重握手失败；workspace epoch（频道改名）驱逐本空间且不影响他空间；thread follow 变更驱逐该用户。
- 真实 wire 绑定前置守卫（recorder，无监听）：polling 400 原句、Origin 403 计数。
- 生命周期：Close 幂等、hijacked socket 全收割、Close 后拒绝新握手。

覆盖（m4_publications_test.go，真实域写入 → commit 唤醒 → outbox → 网关；含父级评审 §1/§3 的新增用例）：
- 共享 message:new 密封键集（searchText/agentSendKey/searchVector/senderHandle **键不存在**）+ conversationContext；resume 面则为 null 密封（同 TS syncMessages 面）。
- 未读失效：受众−发送者（发送者零收件有负断言），payload 仅 {serverId}。
- 隐私：reaction_viewer 仅 subject 交集房（同用户 account 级 socket 与他用户均零收件）；message:updated 共享面无 viewer 字段。
- 线程：私有父链 follower-only（房间内非 follower 三类事件全零）；公开父链显式 viewer 收到。
- dm:new {channelId} 仅参与者；thread:updated 真实 replyCount/lastReplyAt/锚点/serverId；followers-updated {threadChannelId}。
- readstate：read_state 逐 scope 版本化事件；bulk projector 的当前行投影形状；mute/display 冻结 envelope 与版本域。
- **serial 绑定（评审 §1）**：受众解析后权限变更提交 → 守卫内谓词拒绝全部旧受众投递；重连后的新连接 + 新解析受众恢复送达。
- **DM 消息活动派生 dm:new（评审 §3）**：DM 内真实发消息后双方参与者收 {channelId}，非参与者零收件。
- thread:updated 仅共享聚合（无 unreadCount/firstUnreadMessageId/readState/maxReadSeq 接收者私有键）。
- 完成/失败：已删事实 completed 无投递且行标记 published；未知 intent 保持 pending（按 durable 行状态断言 attempts≥1 且未 published）；预算耗尽后 PARKED（独立计数）；瞬时 DB 故障 defer（publisher 返回错误 + Store 层 drain 失败保留 intent）。

### 8.1 稳定性备注

- 最终状态：`-count=1` 连续 5 次、`-race` 连续 8 次全部通过。开发期出现过两类测试自身的时序缺陷，均已修复：①屏障等待预算小于服务端 10s fail-closed 上限；②短 TTL token 测试与房间屏障竞速（改为经发布路径断言精确到期关闭，不再依赖屏障完成）。本 checkout 与多个 worker 共享，重度编译负载下偶发整进程停顿仍可能拖满任一等待窗口（~1/10 量级、随机用例、固定满超时特征）——属环境性，父级在安静环境复跑 §8 命令即可复核。

### 8.2 沙箱限制（如实）

1. 本地端口绑定被拒（EPERM）：真实 socket.io-client@4.8.3 互通（`node tests/acceptance/m4-socket-poc.mjs`）**未在本环境执行**，归父级；进程内注入 Transport 驱动的是生产同一网关代码路径，仅 wire 绑定不同（绑定层自身的单测在 socket worker 包内）。
2. 共享 checkout 上 channel worker 正在实时编辑其文件（`m4_channel_projection.go`/`channel_handlers.go` 等），`go build ./internal/app/` 依赖 `legacyweb`，其间出现过瞬态他包编译错误（非本层文件）；本报告所有结论以我文件最终稳定态为准，最终全绿运行请父级在 worker 落盘稳定后执行（§8 命令）。
3. race 运行耗时较长；如需复现逐条命令见上文。

## 9. 需要各 worker/父级接线的 API 请求（不在本层伪造）

**父级评审（docs/m4-realtime-review-notes.md）落实对照**：§1 受众 TOCTOU → serial 绑定（§6）✅；§2 Close/listener 竞态 + family 硬删除 → 永不关闭的 wake 队列 + 信号终止 + 同批 user epoch 驱逐论证（§5）✅；§3 dm:new 消息活动（§6/§7）✅、未知类型不无限积压（PARKED，§6）✅；scope_read/readstate 投影器 → 等待 readstate 落地后接入（§9.1），不重复第二套读模型；`tests/acceptance/m4-realtime.mjs`（16 组原版客户端验收）由父级在 app 接线后执行——本层进程内用例不冒充该套件结果。

1. **readstate**：请导出 `ProjectPublication`（或等价只读投影入口）供 read_state/unread_summary/prefs 意图重投影；本层目前按 §6 表所述**只读**复投影 0011 三表（与 readstate GET 投影同语义，含 announcement 默认静音与有效 mute 判定）。另核实：`MarkInboxReadLatest` 已不再 enqueue `read_state_bulk`（“scope 列表是请求态不是 durable 对象”）——本层 projector 保留支持，若确定永不再发可删除该分支。
2. **message**：`ProjectPublication` 的 thread 投影缺 `parentChannelId`/`syncCoreReplyWindow`/`latestReply`（原 TS thread:updated 携带）；`message:updated` 原面还带 conversationContext（Go 密封缝未附）。请扩展投影（ServerID 本层已由 ref 补齐）。
3. **channel**：合同 §4.2 的 `channel:updated` / `channel:members-updated` 目前**无任何 intent 产生**（M3 频道变更不 enqueue）。请补 intent + 投影入口；本层 dispatch 留有明确 unknown-deferred 语义，不会吞掉它们。
4. **scope_read:updated**：按合同“只在实现确切原权限/字段后启用”，readstate 未产生该 intent，本层**不发布**；需要时请先冻结共享回执投影的授权面。
5. **网关（socket worker）**：当前稳定 `core.Revocation` 无 family-only / 自定义匹配形状（评审 §2 提及的 custom Match 尚不存在）；家族硬删除依赖同批 user epoch 驱逐（§5 已论证+注释）。若后续提供，familyOwner 反查可移除。后续若增加服务端 socketsJoin（follower 入房），公开父线程的策略集合投递可收窄回 follower∪joiner。
6. **父级**：`app.Build` 中按 §2 接线（构造 → mux 挂载 → Close 先于 DB Close）；`origins` 用 `cfg.WebOrigin`；互通验收两套：`m4-socket-poc.mjs`（传输 spike，13 组）与 `m4-realtime.mjs`（真实 App + 原版客户端，16 组，其第一组硬门槛即本层 polling 400）——父级在接线后运行，把 zishang 依赖状态从“已 pin 未互通”推进为“已验证”。

## 10. 与批准文档的对照清单

- execution-lock：不改共享路由/app.go；新端点由父接线 ✔；无浏览器/UI 测试 ✔；一次性数据目录 ✔。
- authority-contract：exact token proof、per-connection expiry、fence/guard 分工、listener 后置、family 隔离、外部写作者不支持（测试 seeding 也走 WithWriteTx，避免把种子 epoch 误当新变更驱逐无辜连接——该坑已修并有测试覆盖其语义）✔。
- socket-integration-notes：守卫内零网络 ✔；500 条 + 字节预算 + truthful currentSeq/hasMore ✔（resume 分页测试）；22000 UTF-8 上限的长消息不造成无限重连（provider 恒保 ≥1 条 + 网关预算页）✔。
- compatibility §4：单 payload 事件、事件名/错误词逐字、私人交集房、`{channelId}`/`{threadChannelId}`/`{serverId}` 精确形状、密封面区分（事件=键删除、resume=null 密封，与 TS 两面一致）✔。
- activity-readstate §6：`thread:followers-updated` 仅 `{threadChannelId}`、prefs envelope 不平铺、多端失效 ✔；`scope_read:updated` 未启用（§9.4）。
