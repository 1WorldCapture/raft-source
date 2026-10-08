# M4 后端收尾、验收证据与交接

- 验收日期：2026-10-08（最终本机构建时间 `2026-10-08T23:29:47Z`）。
- 工作区：`/Users/lyon/workspace/raft-source`，实际 checkout；HEAD `bc65213b377a992c381e809c72ba50ca9af367fd`，包含未提交改动。
- 结论：**M4 约定的人类聊天后端及非 UI 自动化门槛已完成；最终 `make check` 全部通过。**
- UI 责任：用户明确交给其他协作者，本轮没有执行浏览器/UI 测试，没有替其签收。
- 发布状态：**未 commit、未 push、未重启或升级现有实例。Stage 保持 `m3`，P8/P9 尚未签收。** 这是 `m4-implementation-coordination.md` 的发布门槛，不表示当前工作区仍缺人类消息实现。

本记录来自本轮实际执行，不将旧 worker 报告中的“待接线”“沙箱不能监听”“已通过”等字样直接视为当前状态。输入设计及历史观察保留；本文件是本轮后端集成结论，不能替代未来的 `m4-ui-acceptance-report.md`。

## 1. 完成范围

| 领域 | 当前后端能力 | 对应验证 |
|---|---|---|
| 人类消息 | 原 v2 发送及 v1 alias、服务端 principal、结构化 human mention、同一 `randomId` 重试复用消息 ID/seq；冲突不泄漏原行 | message/domain、HTTP v1/v2、原 Web fold |
| 持久读取 | 最新页、before/after、messageWindow/context、HTTP sync、Socket resume；当前 workspace/频道/线程父链权限与真实覆盖水位 | 快照/权限/分页回归、原协议样本、1,201 条恢复 |
| 会话 | 人类二人 DM、self-DM、规范唯一配对、线程 ensure/reply、显式查看与关注分离 | channel/domain、真实 HTTP、live 受众 |
| 消息聚合 | reaction 幂等、共享聚合版本、本人 viewer 版本与私有快照；无新增正文编辑/删除产品接口 | 原 reducer、共享/私有事件与离线快照 |
| 已读与 Activity | read/mark-unread/read-all、scope/workspace unread、mute/display 偏好、human Inbox/Done/reactivation、Activity snapshot/difference/notModified/epoch | readstate、HTTP 16 组中的相关场景、生成 schema 与原 reducer |
| 实时 | 原 Socket.IO 客户端 websocket-only、rooms 屏障、heartbeat/resume、origin、撤权、慢消费者/关闭回收 | gateway/core、真实 JS 客户端及隔离代理 |
| 发布与恢复 | 业务事实及 publication 原子提交，当前事实重投影，错误重试、可观测的永久无效引用停放、进程强杀恢复 | outbox、真实子进程故障注入、HTTP/Socket 重启 |
| M1–M3 回归 | 账号、邀请、workspace、频道、Agent/Computer 身份与 Daemon 接入 | 全套 HTTP、原 Computer/Daemon 客户端直连及代理、冻结二进制升级 |

这些能力集成在同一 Go 进程。旧 TypeScript Server 不参与运行；原客户端和冻结的原函数作为协议消费者/参考被实际执行，没有修改消费者来适配 Go 输出。

## 2. 本轮发现并修复的缺口

### 2.1 恢复查询的权限快速返回

`SyncVisibleMessages` 原先在部分空流、越过水位、成员已退出等路径，只得到空订阅集合就返回成功，缺少 use-case 层 workspace membership 校验。即使外部入口另有鉴权，也不能把这当作领域接口的授权保证。

现已在读取 workspace 高水位及所有快速返回之前检查当前 membership。新增矩阵覆盖空库、有消息、已覆盖水位、软删 workspace、不存在 workspace，分别验证 HTTP sync、visible sync、resume 的拒绝与无返回数据。

### 2.2 异常线程与残留权限关系

同步订阅 SQL 原先可能因残留 `channel_humans` 行，把“线程的父频道还是线程”的异常链纳入同步。现显式要求父消息同 workspace、父频道属于受支持的非线程根类型。测试证明 history 拒绝的异常线程不能从 HTTP sync 或 resume 绕过，同时正常一级线程保留。

实时侧原先将 workspace/roster/follow 直接当作完整受众。新增失败回归证明：冻结禁用的 guest 仍可能收到共享内容；失去私有父频道访问权的人凭残留 follow 仍可能收到线程正文、摘要与计数提示。

现通过 `authorizeAudienceSetsTx` 在同一快照内复用 `channel.AuthorizeConversationTx`，对 live/counting、频道事件及定向 joined 更新统一收紧。基础设施错误向上返回，不能伪装成资源消失。

### 2.3 私有状态事件与每连接的线程兴趣

已读、notification prefs、display prefs 的 durable 引用现在也重验当前 scope 权限。批量 read-state 事件剔除失权后的保留行，而非把数据库中的本人旧状态直接重播给新连接。测试覆盖“退出私有频道后重新连接”，并保留仍有权公共频道的真实 read-state。

公开父频道线程的 `message:new` / `message:updated` 现在同时要求基础权限与**该 socket 的线程 room**。关注者在握手屏障加入；显式查看者可加入但不自动关注；同用户未打开线程的另一个标签页、其他被动 workspace 连接不被隐式订阅。线程摘要/关注提示仍使用各自约定的受众，不把它们混成正文流。

原 TS `messageService.ts` 的 reaction 更新生产者明确投递到 `channel:<id>` room。对应旧测试补齐“显式查看者加入 room”的前置条件，保持对 payload/context/隐私字段的断言；不是为了通过测试而扩大受众。

### 2.4 撤权通知的真实竞态与 family 硬删除

全量回归曾出现 `rooms:joined` 等待超时。已用确定性回归定位，而非以“机器负载高”豁免：提交后的撤权通知可能延迟到新 socket 已按最新 generation 鉴权以后；原实现无条件按 scope 踢连接，把刚重连的有效 socket 再次踢掉。

`Revocation.BeforeGeneration` 现只匹配早于本次提交 generation 的身份，覆盖 opened/pending、user/workspace/family 三类；相同或更新 generation 的新连接不受迟到、重复或乱序通知影响。旧显式 revocation 的零值行为不变，authority wake 则拒绝非法的零 generation。

Family 硬删除后不再依赖已不存在的 owner 行反查：直接按保留的 family tombstone 和 immutable family ID 关闭旧 socket，不能误伤同一用户的独立登录或其他用户。

### 2.5 完整入队守卫、取消及慢队列

除一般广播外，`rooms:joined`、`sync:resume:response` 和 heartbeat 也必须把 generation 检查及有界 offer 放在 admission guard 内。读取频道/恢复页/水位的数据库操作留在 guard 外，guard 不跨网络等待。

Gateway 补齐有界、可取消的准入；没有 caller deadline 的兼容调用使用 5 秒获取上界。持久发布器接入返回错误的 `PublishFilteredContext`，透传 batch context，序列化/获取 guard/取消失败不会被误计为 publication 已完成。所有共享和接收者私有投影在 guard 内复查 authority serial；serial 已变化时保留 intent 重投影。

出站慢队列在交给 transport 前再次检查当前 generation 与本连接 token 期限，即使异步 eviction wake 尚未到达，也不继续发送已经确定失权的排队帧。已经在有效授权下交给网络的数据不可撤回；不宣称端到端“恰好一次”。

### 2.6 发布失败处理

线程投影的父频道查询现在只将 `sql.ErrNoRows` 视作事实消失；真实数据库错误保持 pending/retry。删除了没有调用者但会吞查询错误的旧辅助函数。新增回归覆盖存在/不存在/跨 workspace/软删线程与真实 SQL 查询错误。

已识别的 `reaction_viewer` 类型若缺 subject，也统一进入永久不可投影引用的重试预算，而不是永远占用 pending 名额。达到既有预算 8 后显式 PARKED、记录日志/计数并释放 pending 槽位。瞬时 DB、权限快照变化或取消错误不使用此停放策略。该策略不是悄悄丢弃无法发布的正常事实。

### 2.7 测试自身的并发与事件顺序

最终全量 race 暴露了 readstate 测试夹具对 `clock.Fixed.T` 的并发读写。已换成共享原子模拟时钟，readstate 与 channel 依赖读取同一时钟；未关闭 race、未串行化业务并发场景。`TestConcurrentReadAllVersusNewMessage` 修复后连续 20 次 race 通过。

公开线程查看者测试原先把首先观察到的任意 `message:new` 当作目标回复，遇到正常的父消息 outbox 重放会误判。现在按目标 ID 与 channel 等待；与新增每-socket 兴趣测试一起连续 20 次 race 通过。

## 3. 实际执行结果

以下命令从 `server-go/` 运行。最终 `make check` 是上述修改全部落地后的完整成功运行，不是挑选一次早期通过结果。

| 命令 / 验证 | 结果 |
|---|---|
| `make check` | **PASS**：fmt、vet、全包普通测试、全包 race、M2/M4 reference、fresh Go wire、全套 HTTP/真实客户端/升级、CGO-free 本机构建 |
| `go test -race -count=15 ./internal/app -run 'TestM4(DelayedAuthorityWake\|DeletedFamilyWake\|PublisherDeletedFact\|RealtimeThreadUnfollow)'` | PASS：撤权/握手复现相关目标重复验证 |
| `go test -race -count=20 ./internal/readstate -run '^TestConcurrentReadAllVersusNewMessage$'` | PASS：原子模拟时钟修复后的并发目标 |
| `go test -race -count=20 ./internal/app -run '^(TestM4PublisherPublicThreadIncludesExplicitViewers\|TestM4PublicThreadMessageLiveHonorsPerSocketInterest)$'` | PASS：事件顺序与 per-socket 兴趣 |
| `make cross-build` | PASS：Linux/amd64、Windows/amd64，`CGO_ENABLED=0` 编译；不是两平台真机运行 |
| `make vuln` | PASS：固定 `govulncheck@v1.8.0`，扫描 33 modules 与 go1.27.1；详情见下 |
| `go mod verify` | PASS：all modules verified |
| `go mod tidy -diff` | PASS：无依赖整理差异，未执行写入式 tidy |
| `git diff --check` / `make fmt-check` | PASS |

全量 `check` 中的主要真实证据：

- M2 原函数/Go 纯 projector：**1,216** 组实际执行比较。
- M4 reference：**7 suites，其中 6 个执行原代码；173 assertions；7 contract fixtures**。校验器另有 20 正例及 9 个预期 drift 拒绝，不把负例误计成兼容失败。
- Fresh Go wire：实际 Go 公开 API 输出通过原 reaction/read-state ledger、Activity reducer 及生成 schema；覆盖版本、Done tombstone 和 difference。
- M4 HTTP：**16 组通过**，包括 v1/v2、幂等、mention、DM/self-DM、线程、reaction、历史、read-all、mute/display、Inbox/Done/Activity、重启。
- M4 realtime：**16 组通过**，使用原 `socket.io-client@4.8.3`；包含 rooms 屏障、Origin、隔离代理、撤权、多页 **1,201 条** 恢复、**32,000 UTF-16 units 的 CJK 正文**、重启及全部 client socket 关闭。
- M1/M2/M3 账号、邀请、Computer、Daemon、Agent、频道及持久化全部保留回归；原 Computer/Daemon 客户端通过直连与独立同源代理访问 Go。

所有真实进程测试使用自己的系统临时目录、数据库、密钥/outbox、端口及子进程；没有连接或升级现有 4301 实例。没有启动 Vite、浏览器、旧 TS Server、真实 LLM 或对外 SMTP。

### `test-m4-wire` 现在是无写入门槛

`make check` 已加入 `test-m4-wire`。该目标使用 `--go-wire --check`，每次采集并语义验证新 Go wire，但不重写 `contracts/m4/go-wire-samples.json`。动态 ID 不与旧样本逐字节比较。需要显式更新证据时才去掉 `--check`。

本轮验证该文件运行前后 SHA-256 均为：

```text
35d35239c8b29c174ee40ac79cffd732751fba1b2ca167826da7c34240960bac
```

### 依赖扫描的边界

最终扫描报告：可调用漏洞 **0**，已 import 包的额外漏洞 **0**；required module 层有 **1** 条：`GO-2026-5932`，`golang.org/x/crypto@v0.57.0` 中未维护的 `openpgp`，无固定修复版本。当前代码不 import/call 该受影响包。不能把此结果写成“依赖库没有任何公告”，也不能把 module-only 公告等同于当前程序已有可达利用路径。

## 4. 强杀窗口：不只验证 SIGTERM

新增 `internal/message/crash_process_test.go`，执行真正独立子进程并由父进程强制终止；每个场景都使用真实迁移后的独立 SQLite。进程在确定性引用屏障停止，不靠随机 sleep 猜测提交位置。

| 强杀位置 | 重开数据库后的断言 |
|---|---|
| message + publication 写入后、事务 commit 前 | 两者都不存在；重试创建唯一真实消息 |
| commit 后、publisher 处理前 | 消息与 pending intent 同时保留；同 randomId 返回原 ID/seq，不再追加 intent |
| publisher callback 接受引用后、`published_at` 标记前 | intent 仍 pending；重开后重放相同引用；标记成功后不再次处理 |

三种窗口都验证 `PRAGMA integrity_check=ok`。最后一项模拟 transport 接受 publication 的 callback 边界，不冒充浏览器已渲染或客户端已经 ACK。真实 TCP/Socket.IO 重启恢复由独立 realtime acceptance 覆盖。

## 5. 迁移、升级与回滚

当前 schema 共 13 项；M4 只追加：

```text
0010_messaging_foundation.sql
0011_readstate_activity.sql
0012_authority_epochs.sql
0013_activity_mute_epochs.sql
```

0001–0009 未因本轮收尾重写。已实际用两个冻结 M3 二进制生成真实旧数据后升级：

| 起点 | revision | 结果 |
|---|---|---|
| 未打邀请补丁 M3 | `d275cce25c251997ba872add84d6e75d3bef4df8` | 数据/密钥/会话/workspace/频道/Agent/Computer 保留，新 M4 schema 可用 |
| 邀请修复版 M3 | `bc65213b377a992c381e809c72ba50ca9af367fd` | 同上，并验证邀请与成员事实保留 |

每个旧二进制直接面对新 schema 都拒绝启动；恢复与其匹配的完整冷备份后旧实例可工作。测试还保留 M1/M2 升级与恢复链路。

真正部署必须先优雅停机并确认停止，再私密备份整个 `RAFT_GO_DATA_DIR`，保留数据库、仍存在的 WAL/SHM、密钥、头像及 outbox；外置 outbox 或环境根密钥另存。回滚使用**旧二进制 + 同一时点旧数据与密钥**，不对已经升级的数据库做 SQL 降级，不删除密钥来“修复”启动。

本轮没有为现场实例生成或指定新的部署备份位置，也没有使用 `var-m3-dev/` 或已有 `var-backup-m2-20261008-1902/` 作为测试库；这些现场目录保持原样。

## 6. 构建身份与协作者联调

最终 `./bin/raft-server version` 的实际输出为：

```json
{"stage":"m3","revision":"bc65213b377a992c381e809c72ba50ca9af367fd","modified":true,"commitTime":"2026-10-08T13:53:27Z","buildTime":"2026-10-08T23:29:47Z","goVersion":"go1.27.1"}
```

这是磁盘上新构建的身份，**不是现有后台进程已切换版本的证明**。真实 HTTP acceptance 已核对测试进程的 executable、`/version`、health body 和 build headers 一致。未运行任何现场升级/restart 操作。

UI 协作者可按 README 用新的 `var-m4-local/` 和独立端口启动待测构建，配置正确的 `RAFT_GO_WEB_ORIGIN`；代理应包括 `/api`、`/internal`、`/daemon` 与 websocket upgrade 的 `/socket.io/`。不要把 README 的示例目录当作现有 M3 数据库的自动迁移授权。

独立 UI 验收仍按 `m4-implementation-coordination.md` P8 的双账号、另一空间、频道/DM/线程、断网/重连、Done/mute/已读和权限矩阵执行。此处只给交接入口，不预填 UI 通过结果。

## 7. 明示限制与未启用能力

**阶段边界。** 不新增人类正文编辑/删除接口；M5 Agent delivery/ACK/任务执行闭环、附件、转发、全文消息搜索、联合频道与 Office 未启用。持久化人类 mention 不代表唤起 Agent。HTTP 成功承诺 persisted + publication committed，不承诺 delivered/consumed。默认 guest 门禁保持关闭，现有 guest 数据不会因此被恢复成有权内容受众。

**部署与容量。** 单 Go 进程/单应用 DB handle，本地 SQLite WAL；不支持外部写进程绕过 authority fence，也没有跨节点 broker/lease。每连接队列默认 256 frames / 1 MiB、publication pending 上界 10,000 等是已实现且有边界测试的参数，不是生产容量承诺。没有完成 100 sockets/10 msg/s/10 万历史的 p50/p95/p99、RSS 或公网压力基准；没有 Linux/Windows 真机、生产 TLS/代理、外部 SMTP 验收。握手全局限流/全局连接上界等容量加固另行评估。

**线程关注的保守失效。** 0012 用 user epoch 表达 follow/refollow/unfollow；首次回复/创建线程若新增自动 follow，会使该用户已有的跨 workspace/family socket 保守断开重鉴权。新 generation 连接不会再被迟到 wake 误踢，但初次全 user 失效仍是当前设计的可见代价。更细粒度的兴趣 fence 未隐式引入；详见 `m4-authority-contract.md`。

**测试与审查不是绝对证明。** 最终回归对上述复现均通过；负载参数、所有可能的调度交错和 UI 体验不能仅由一次全量测试推定。发现真实失败时先复现并修复，没有删除安全断言或把失败重命名为“环境问题”。

## 8. P0–P9 责任交接

| 工作包 | 本轮状态 | 下一责任边界 |
|---|---|---|
| P0–P7 后端实现、协议、恢复、安全及回归 | 后端集成门槛 PASS；证据在本文件及现有分模块报告 | 当前未提交工作区供代码评审；本轮未自动提交 |
| P8 原 Web 双账号、多空间 UI | 本轮明确未执行 | 已指定的 UI 协作者产出独立验收报告 |
| P9 发布 / Stage=m4 / 现场升级 | 未执行，Stage=m3 | UI 签收或产品逐项接受剩余项后，由发布负责人决定并操作 |

README 已更新实现范围、Socket.IO/Origin 联调说明与独立数据目录示例。历史 worker 报告保留原来的观察与失败；尤其 `m4-gateway-final-closeout.md` 所列父层 public-thread 测试中间态，已由本轮 room/受众接线和最终全量 PASS 覆盖，不再是遗留后端失败。
