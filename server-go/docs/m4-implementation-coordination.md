# M4 实施协调与验收责任

日期：2026-10-08。状态：**待实施计划，不是执行记录。** 总设计见 `phase-4-messaging.md`；wire 合同见 `m4-compatibility-contract.md`；P5 的完整人类状态与端点范围见 `m4-activity-readstate-contract.md`。本轮只关闭 M3 的已核实缺陷并设计 M4，不能将本文中的测试写成已经通过。

## 1. 进入条件

M3 的邀请加入链路必须能产生两个真实 workspace 成员；设备码批准/拒绝可达；Agent 详情不再把未启用功能显示成无法恢复的 404；运行实例身份可以核对。先保留原 UI 验收报告，新增修复交接，不重写原观察证据。

进入 M4 前由集成负责人记录：git revision 与工作树状态、实际运行 `/version`、schema migration 列表、Go/Node/pnpm 版本、原 Web lockfile client 版本，以及没有被本轮测试修改的 live data/backups。guest gate 仍关闭时记录“guest 邀请被明确拒绝”，不能声称已完成 guest UI 功能。

后端测试可用 fixture 构造受限角色验证防护，但 owner/member/第二空间的实际 UI 链路不能再用直接插库替代。测试数据与用户现场隔离。

## 2. 工作包、依赖与签收者

“负责人”是执行角色，派单时必须绑定具体人或 Agent；“验收者”不能仅复制执行者的完成声明。每个任务交付代码、实际命令结果和失败/未测范围。

| ID | 工作包 / 主责范围 | 依赖 | 执行负责人 | 验收负责人 | 必须交付 |
|---|---|---|---|---|---|
| P0 | 冻结原客户端合同、scope、Go Socket.IO spike | M3 修复回归 | 协议负责人 | 集成负责人 + UI 协作者 | 路由/DTO/error/event fixture、实际原 client 互通报告、依赖 tag/checksum、限制清单 |
| P1 | 聊天统一权限、DM/thread 的事务接口、migration 设计 | P0 | channel/安全负责人 | 独立安全审查者 | 缺 membership 必拒绝、线程父链、DM participant、事务内降权 tests；schema 审查 |
| P2 | 消息事实、seq、randomId 幂等、v2 发送/历史/context/sync | P1 | message 负责人 | 协议测试负责人 | 两账号 HTTP 闭环、并发/回滚/重启、原 Web DTO 消费 tests |
| P3 | Socket.IO 握手、rooms、发送、heartbeat、resume、关闭回收 | P0 可先建协议适配；接线依赖 P1/P2 | realtime 负责人 | 协议测试负责人 + 安全审查者 | 原 client 直连/代理 tests、pending 握手撤权、背压、race/资源回收 |
| P4 | 人类 DM/self-DM、thread 产品路径与聚合、human reactions/viewer snapshots | P1/P2；实时联调依赖 P3 | 会话负责人 | message + UI 协作者 | 原 UI 打开 DM/回复、唯一性、reaction 本人态与共享态隔离、历史 overlay 恢复 |
| P5 | 版本化已读/标未读、未读摘要、mute/display、human Activity/Inbox/Done 差量 | P2/P4；实时联调依赖 P3 | readstate 负责人 | UI 协作者 + 安全审查者 | 按 `m4-activity-readstate-contract.md` 逐端点签收；多端乱序、真实计数、Done frontier、snapshot/difference/epoch、私人事件与恢复 |
| P6 | 撤权与故障窗口的跨模块集成 | P3/P4/P5 | 集成负责人 | 独立安全审查者 | logout/降权/移除/转私有各阶段 failpoint，提交后崩溃与补同步 tests |
| P7 | M3→M4 升级、备份恢复、部署与运行诊断 | P2–P6 冻结 schema | 运维/集成负责人 | 后端测试负责人 | 冻结 M3 程序生成真实旧数据、升级/旧版拒绝/恢复、构建与运行的区别 |
| P8 | 原 Web 双账号、多空间浏览器验收 | P6/P7、完整后端门槛通过 | UI 协作者 | 产品负责人 / 指定验收人 | 截图、实际请求、断网/重连/刷新、权限矩阵、明确未启用入口 |
| P9 | 发布签收、Stage=m4、交接 | P8 通过或产品明确接受逐条剩余项 | 集成负责人 | 用户/发布负责人 | 实际构建标识、实现范围、测试证据、限制、备份/回滚说明 |

P0 之前不要让多个 worker 各自设计 message DTO、seq 或 migration 编号。P2 与 P3 可以在合同冻结后并行；不要把依赖“数据库有消息”的集成测试伪造成提前通过。P5 不能拿常量空数据等 P2，将来再改。

## 3. 文件所有权与合并纪律

| 路径 | 首要负责人 | 协作规则 |
|---|---|---|
| `internal/message/**` | P2 | 领域事实与持久读取；不得导入 socket 库或调用 daemon |
| `internal/channel/**` | P1/P4 | 先锁定事务接口，再按文件拆分；M3 频道功能必须保持回归 |
| `internal/readstate/**` | P5 | 所有查询显式 user/workspace/conversation；不直接修改 auth 表 |
| `internal/transport/socketio/**` | P3 | 协议实现、连接与队列；不拥有消息表/成员角色事实 |
| `internal/transport/legacyweb/*message*` | P2 | 同一 DTO projection 被 HTTP 与恢复调用，避免三套编码 |
| `internal/transport/legacyweb/*read*` | P5 | 先登记 no-ID routes，避免再被动态 workspace/channel 路由吞掉 |
| `internal/platform/db/migrations/**` | 集成负责人 | **单写者**从0010起分配编号，0009已由本轮M3邀请补丁使用；其他 worker 交 migration 草案，不改0001–0009 |
| `internal/app/**`、`routes.go`、`Makefile`、`tests/acceptance/run.mjs` | 集成负责人 | worker 提供注册函数/独立 suite，最后由集成人接线，避免重复注册 |
| `contracts/**`、测试 fixtures | 协议负责人 | 快照必须来自原函数执行或公开 wire，不用源码字符串检查代替行为 |
| `packages/web`、CLI、Daemon、TS Server、lockfiles | 默认只读 reference | 定点修复另列批准范围；不得为使后端测试通过偷偷修改消费方 |
| `var*`、keys、outbox、已有截图/报告 | 现场保管者 | 测试不读取生产密钥、不删原数据；临时资源由创建者清理 |

同一 checkout 的 worker 必须先检查未提交改动。提交/推送/重启服务不属于自动的“写完代码”动作；由集成人按用户授权执行。使用独立 worktree 时也必须把来源 revision 和差异写入交接。

## 4. P0 协议 spike 的退出标准

使用独立、临时 Go module 和同仓库已锁定的 JS client；不先改主 `go.mod`/lockfile。spike 通过后才将经验证的依赖合入主模块。

必须执行：

1. 原 `socket.io-client@4.8.3` 的 websocket-only 握手成功，auth 字段原样传入；错误 token/type/已撤销 session 和错误 workspace 被拒绝，错误信息不触发错误的无限 refresh。
2. 原样 `rooms:joined`、单 payload 的 `message:new`、`heartbeat`、`sync:resume`/response 可收发；join/leave 请求按实际参数形态处理。不得让测试自制一个和目标客户端不同的 wire。
3. net/http 中间件、Vite 同源代理、Origin allowlist、Server.Shutdown + hijacked socket 清理都可工作。
4. transport close 后原客户端确实重连并重新鉴权；namespace disconnect 不被误用为必须自动恢复的断开方式。
5. 有界队列/慢消费者、ping/pong timeout、畸形包/超大包/rate limit、并发连接/断连在 race 下可控；CGO-free 构建可用。
6. 使用到的 package/tag/checksum、Go 要求、许可证、依赖漏洞结果写入报告。上游 README 的“兼容”不是这份报告的替代品。

失败时先判断“可在适配层修复”还是“候选库无法满足”；不得顺手把原 Web 改为 raw WS。唯一允许提前进入 P1/P2 的内容是已经冻结、与传输库无关的数据库/权限工作。

## 5. 必需自动化验收矩阵

所有新增命令名称均为**拟定 suite**，实施时在 `run.mjs` 显式登记；本文不声称它们现在可运行。

| 拟定 suite | 必测正常路径 | 必测反例/故障 | 成功证据 |
|---|---|---|---|
| `m4-message-http` | v2 发送→原式历史→context→before/after/sync | 错空间/无成员/未加入/归档/畸形 body/内容长度/randomId 冲突 | 真实 HTTP、SQLite 重查，同 ID/seq、正确状态码和 DTO |
| `m4-message-idempotency` | 两个并发请求同键返回同一消息；HTTP 响应丢失重试 | 同键异内容/异频道/异用户；提交前取消；事务回滚 | 数据库恰一行，无重复线程/未读副作用 |
| `m4-socket-client` | 原 JS client、rooms 屏障、live/HTTP 顺序、心跳、join/leave | 过期/撤销 token、无 scope、Origin、异常 packet、没有房间时不假 ready | 真实 Socket.IO，不是自制原始 WS |
| `m4-message-recovery` | 多页补同步、live 与 resume 重复、重启后补齐 | >limit、不可见 seq 空洞、新获得权限、扫描预算、请求乱序 | cursor 单调前进；内容无缺失、无越权、无永久重复 |
| `m4-conversations` | 并发 ensure DM/self-DM/thread、父消息定位、回复计数、follow/unfollow事件 | 外空间目标、非参与 DM、Agent DM501、父链缺失/循环/跨空间、父私有频道撤权；可读未关注线程history与resume差异 | 原 UI 需要的同一会话身份、准确订阅兴趣与严格权限 |
| `m4-reactions-overlay` | 幂等 add/remove、聚合、本人 viewer 状态 | 多人并发、stale revision、公共广播夹带私人标记 | HTTP/live/reconnect/旧页再次可见一致 |
| `m4-readstate` | 多端已读、标未读、mute/display、summary/Inbox、Done/undone/read-all | 旧响应晚到、假大 seq、本人消息、无权 scope、别人的状态、Done412/400/409 | 稳定 revision、非相减计数、两类prefs事件与重启保留 |
| `m4-activity-sync` | snapshot/difference/notModified、all/unread/mentions、分页、本人Done/unfollowed列表 | epoch不符、保留缺口409、跨用户/空间水位误用、元数据变化、失权旧预览、超过2^53的十进制字符串 | 原schema+reducer接受真实wire，连续覆盖承诺成立，无恒空或恒409伪实现 |
| `m4-message-rate-limit` | 同用户60秒60次，v1/v2与reaction写入共享桶；读不消耗此桶 | 换别名/空间绕限额、重复randomId风暴、超限429文案与响应头 | 时钟可控、无已提交重复行，产品默认不跳过限流 |
| `m4-revocation` | 已建立连接撤权并按预期重连 | pre-auth/post-auth/pre-room/post-room/pre-resume-send/pre-write 每窗口撤权 | 旧 generation 不再授权新 payload；无 token/正文泄漏 |
| `m4-failure-restart` | 备份恢复、进程崩溃后持久事实可见 | commit 前/后、HTTP 前/后、enqueue 前/后、迁移途中中断 | 同 ID/seq、无幽灵连接、不清库、不假“已送达” |
| `m3-to-m4-upgrade` | 冻结原 M3 与邀请修复 M3 的真实数据升级 | 旧 M3 拒绝 M4 schema；冷备份恢复 | 旧会话/凭据/邀请/频道/Agent 保留 |

安全测试必须验证响应内容/可见状态和数据库副作用，不只断言错误 HTTP 状态。测试不得只 grep 源码看“有没有 auth 判断”。多页恢复测试不能以 socket write 返回当作服务端已经处理，应使用有明确定义的协议屏障或有界最终状态等待。

## 6. UI 验收：由协作者实际执行

浏览器使用新的独立 context 和可重放数据，不能复用用户正常会话、不能把页面连到旧 TS backend。记录 Go `/version` 和代理 origin 后开始。

### 会话与消息

账号 A 创建空间并邀请账号 B；A/B 分别进入普通公共频道并真实加入后互发文本。观察“发送中→持久行”的转换；快速重试不会产生两条。A 关闭页面后 B 继续发送，A 重开看到持久历史。另一空间账号 C 无法通过链接、历史定位、Socket 或 unread 看见内容。

A/B 在私有频道聊天，移除 B 后，B 的打开页面不再接收新的私有内容；旧 URL、thread ID、context ID、已建立 socket 均被限制。人类 DM 只有双方能看见；同时点击打开不会出现重复会话。在线程中回复时父消息计数和 thread 页面一致。

### 恢复与多端

同账号两标签页：一个读消息、另一个看到正确未读变化；旧请求晚返回不能恢复已经清零的 unread。离线超过一页消息后重连，看到完整补齐且没有重复。离线期间 reaction/线程聚合变化，最新页恢复正确，旧页滚入视区时恢复正确。

切换 workspace 后旧请求/旧 socket 的迟到响应不污染新空间。Go 重启后连接恢复、消息不丢；Computer/Agent 仍遵守 M3 状态语义，不能把重连显示为 Agent 任务完成。

### 边界与失败

Activity mute 不再弹“加载失败”，确实持久化且对本人有效；数据库故障仍展示真实可重试错误。Office、Agent 自动回复、任务、附件、搜索等未启用入口有清晰说明，不能显示假的成功或伪造空列表。正文里的普通 @ 文本和需要执行的结构化 @Agent 不混淆。

协作者报告必须分“通过 / 失败 / 未执行 / 因阶段边界不适用”。后台/API 测试不能替代浏览器验收；自动化浏览器验收也不自动等于用户人工签收。

## 7. 发布阻塞条件

以下任一项存在则不能签“完整 M4 已完成”：

- 原 Web 实际 `/api/v2/messages` 仍未接通，只有手写 curl 的旧版发送可用。
- Socket 只能建立裸 WS，或一连接就发 rooms ready 而没有完整授权订阅。
- 重启/断线超过一页消息后丢失、重复或停在不前进的 cursor。
- 某一个 HTTP/Socket/resume/context/计数入口绕过共用基础授权，或遗漏该操作的订阅兴趣规则，尤其缺 workspace membership、DM participant、线程父链，或把未关注线程错误塞进resume。
- HTTP 成功但重试创建另一条消息；广播成功被称为 Agent ACK。
- guest 功能未启用却在邀请中被静默升级成 member。
- schema 升级无法从真实 M3 起点复现，或测试修改了现场数据。
- 后端通过被写成 UI 通过，或者未启用功能通过常量空数据/全局捕错掩盖。

## 8. 阶段完成记录模板

每个执行者提交：目标与实际范围；修改文件；引用的 TS/Web 基线；实际命令和结果；失败/未测部分；数据迁移；安全考虑；需要集成人接线的函数；下一负责人的明确动作。

本轮M3补丁的最终集成证据见 `m3-ui-fix-closeout.md`；它不替代本表P0–P9的M4执行记录。

集成人最终产生 `phase-4-backend-handoff.md`，UI 协作者产生 `m4-ui-acceptance-report.md`。这些文件应在**执行后**才创建为验收记录；本设计不预填“全通过”。发布卡至少记录：运行版本、schema、启用能力、未启用能力、已执行测试、回滚备份位置、负责签收的人。
