# M1–M4 UI 回归反馈：M5 前置修复与交接

- 日期：2026-10-08（America/Los_Angeles）
- 输入：`gui-test-screenshots/m1-m4-ui-regression-report.md`，未修改该报告或其截图。
- 基线：`336b5c8`；本轮直接在现有 checkout 修改，**未 commit、未 push**。
- 环境：协作者的 4301 Server、5175 Vite 及 `var-m4-ui-test` 未重启/修改；`var-m3-dev`、`var/`、备份目录未作为本轮运行数据使用。
- 约束：保留原 Web/CLI/Daemon 源码、锁文件和 0001–0013 migrations；后端验证与 UI 签收分开。

## 1. 结论与逐项状态

| 原级别/问题 | 本轮判断 | 本轮结果 | 关闭条件/责任角色 |
|---|---|---|---|
| P1：默认 #all/#announcement 不能发帖 | Go 权限实现与隐式成员列表契约矛盾；原 M4 设计误把 #all 与 Activity 并列为不可写聚合面 | **后端已修复，新增回归通过**；恢复真实系统频道隐式发帖，不造 roster | 环境负责人加载新二进制；UI 协作者以两个账号无 Join 发送、收取并截图 |
| P2：Agent Messages 501 无反馈 | 501 是未启用 Agent DM 的真实结果；按钮无 catch/关闭面板太早属于客户端问题 | **未修改客户端，静默问题尚未修复**；Agent DM 不假开放 | 客户端维护者补 pending/error 展示；M5 Agent DM 切片完成后再验证成功跳转 |
| P2：Pre-join Agreement 裸 Not found | 已知产品能力的 GET/PUT 未注册 | **后端已修复，新增权限/方法测试通过**；准确返回未启用说明 | UI 协作者确认显示说明，不显示裸 Not found；未授权者仍不得读取/保存 |
| P2：人类 Message 创建 DM 后不跳转 | 原组件已经有 nav.toDm；200 本身不能定位导航/面板生命周期根因 | **尚未复现并修复可见导航问题**；后端 DM 全套契约仍通过 | UI 协作者记录 response id、控制台、pathname、面板栈和 workspace epoch；客户端维护者据此修复 |
| P3：跨账号草稿残留 | 正文存于全局 slock_drafts、按 channelId 索引；账号切换未隔离 | **未修复；建议提升为 P2 隐私问题** | 客户端维护者完成按账号隔离、清理当前内存、取消旧账号延迟写入及回归 |
| P3：Members 默认 Office | 无已存 List 偏好时客户端选择 Office；已有 List 偏好实际会持久保存 | **未修复默认选择策略**；Office 仍返回诚实未启用 | 客户端维护者按能力回退 List；不删除用户有意保存的可用视图偏好 |
| P3：自己的线程回复出现在 Activity | Activity All 保留关注线程，不等于给自己增加未读；发线程回复会自动关注并推进本人 read frontier | **不按已证实的后端通知缺陷修改**；报告尚未证明自增未读 | UI 协作者分别核对 All/Unread/badge；只有出现本人未读增长才按缺陷修复 |
| P3：Joint Channel 表单未提交成功 | 未观察到服务端请求，不能据此判断后端成功或失败；该能力仍不在 M5 核心范围 | **未验证表单根因、未启用能力** | 客户端维护者给出 disabled/未启用态；UI 协作者记录实际请求前再归因 |

**这不是“全部 UI 问题已关闭”的报告。** 已完成的是两项后端修复和 M5 深化设计；剩余客户端问题、未复现导航和能力范围都保留在上表。

## 2. P1 的设计拍板与代码

原链路是：系统频道隐式成员 → `GET /api/channels` 返回 joined=true → 原 Web 不提供 Join → `canPostRoot` 却要求 channel_humans 行。按照原 TS 的隐式成员契约修复后端，而不是把新空间默认频道改成没有发帖功能的只读落地页。

修改 `server-go/internal/channel/conversation.go` 的 canPostRoot，保留 guest/隐藏 #all 的拒绝，然后使用：

```go
return HasImplicitServerMembership(root) || member
```

此时 caller 已验证真实有效的 workspace membership。普通公开/私有频道、DM 仍需各自 roster；归档、删除、跨空间和线程根权限检查不变。原公告不允许线程的规则也未变化。`Conversation.IsMember` 没有伪装物理 roster，数据库不补 membership 行。

同时修正 `docs/phase-4-messaging.md` §9 的错误限定，避免后续执行者按旧注释重新把修复收紧回去。

新增/调整验证：

- `internal/channel/conversation_test.go::TestPostingScopeHonorsImplicitMembershipChannels`：owner/member 无 roster 可发，guest 拒绝，归档拒绝，普通显式加入仍正常。
- `internal/transport/httpapi/humanapi/system_channel_posting_test.go::TestFreshWorkspaceSystemChannelsCanPostWithoutJoining`：真实注册/验证/资料与新空间，两个默认频道 joined=true；owner/member 不调用 Join 直接 POST；randomId 重放同一消息；两条真实 chat、零 roster；非成员 403、归档 409。
- `internal/message/hidden_directory_test.go`：去掉为了绕原 bug 而人工添加的 #all roster，目录隐私测试现在基于真实隐式成员条件。

已有隐藏频道、普通未加入频道、私有/DM/thread、权限竞争及原客户端契约测试随全量 gate 一起通过。

## 3. Pre-join Agreement 修复

原 Web 请求 `GET /api/servers/:id/agreement`，保存调用 PUT，并把后端 error 字符串直接显示。原 TS 的 GET/PUT 均只允许 owner/admin。Go 现在注册对应已知能力路径，但继续不实现 agreement 内容管理和加入前强制接受。

owner/admin 的 GET/PUT 返回：

```json
{
  "error": "Pre-join agreements are not enabled in this server stage",
  "code": "feature_not_implemented"
}
```

HTTP 状态为 501，不返回 `{enabled:false}` 假成功，不表示已保存协议。完整顺序：已验证/资料完整的人类会话 → X-Server-Id 与 URL 一致 → 当前空间成员 → guest 拒绝 → owner/admin → capability/method 结果。

相关文件：

- 新增 `internal/transport/httpapi/humanapi/agreement.go`：RequireAgreementManagement。
- `humanapi/servers_routes.go`：GET/PUT 真实注册。
- `humanapi/method_policy.go`：其他方法在相同 gates 后 405，Allow=GET, PUT。
- `internal/transport/httpapi/manifest_table.go`：路由清单同步。
- 新增 `humanapi/agreement_test.go::TestDeferredAgreementPreservesScopeRoleAndMethodPolicy`：owner/admin/member/guest/outsider、无认证、错误凭据类别、无 scope/错 scope、六种 HTTP 方法及未知子路径。

member 保留原错误 `Only server owners and admins can manage the pre-join agreement`；未知路径仍是真实 404，不被一层全局 501 吞掉。

## 4. 交给客户端维护者的精确修复点

### Agent Messages

位置：`packages/web/src/components/agent/AgentDetailPanel.tsx:4216–4224`，`store/channelStore.ts:623–648`。当前点击先关闭 profile/thread，再 await openDM，未捕获 rejected promise。

补丁要求：请求期间显示忙态、防重复点击；成功拿到有效 channel 后再关闭旧面板并跳转；501 展示未启用说明；其他错误显示真实失败但保留上下文；取消/空间切换时不执行旧请求的导航。不能在 Go 返回假成功，也不能关闭整个认证/目录来隐藏按钮。

### 人类 DM 跳转

位置：`components/member/HumanDetailPanel.tsx:314–323` 已经调用 `nav.toDm(ch.id)`；`store/channelStore.ts:651–675` 在解析/更新 store、joinRealtimeChannel 后返回 channel；`hooks/useAppNavigate.ts:440` 构造 DM route。

因此“缺少 navigate 调用”不是已证实根因。先取证：创建返回的 channel.id、openUserDM 是否真正 resolve（含 realtime join 是否 throw）、调用时是否还在同一 workspace、pathname 是否改变、可见 panel 是否被旧 profile/page stack 覆盖、组件卸载后异步闭包是否仍使用正确导航上下文。修复需同时覆盖已有 DM 和新建 DM、overlay 与 Members page 两种入口。不得为了让某个面板打开而给后端增加不真实的全局导航事件。

### 草稿隐私

位置：`store/messageStore.ts:432–465` 使用全局 `slock_drafts`；`1512` 初始化、`1689–1702` 按 channelId 写；`2968` 之后的 server reset 保留 drafts。`MessageInput.tsx:707–713` 读取同一 channel 草稿；`authStore.ts:346–381` logout 不隔离正文草稿。附件/failed-mention 缓存已有 auth scope 清理，不能据此认为正文也安全。

建议正文/持久缓存归属至少 `(server origin, userId, workspaceId, channelId)`；账号 subject 变化时先清当前可见草稿与内存，再载入新主体的草稿；取消旧主体的 debounce/异步写，写回前检查 auth epoch。旧全局、无法证明归属的草稿不可自动赋给下一登录账号。不要从服务端发送 Clear-Site-Data 清掉整个站点所有资料来“解决”。验收 A 写未发送正文→退出→B 登录同频道不可见→A 重登按所选保留策略恢复；同时测试页面关闭时延迟落盘和多标签切换。

### Office 默认视图

位置：`office/membersSurface.ts:7–19`。默认 office，但 `raft.members.surface.<userId>` 保存的 list 会被读取，不能笼统写成“视图偏好没有持久化”。当服务器明确不支持 Office 时，未设置/不可用默认回退 List；仍允许已启用环境的用户切回 Office，不能通过后端伪造 Office 数据消除空态。

### Activity 与 Joint

`internal/application/messaging/messaging.go` 对本人新线程回复同事务 MarkReadLatest；`readstate/inbox.go:245–323,379–448` 将关注线程纳入列表；`readstate/inbox_test.go::TestUnreadCountsExcludeDoneAndOwn` 覆盖本人消息不计 unread。保留关注讨论在 All 的既有契约。UI 需要另验 Unread 和 badge，不建议一刀切删除自己的线程卡片。

Joint Channel 目前只记录为未启用/未验证。没有实际请求的表单失败不能被本轮后端测试关闭；入口应有明确能力说明，不扩大到本期实现联合存储/跨空间权限。

## 5. 本轮实际执行结果

已成功执行：

```sh
cd server-go
make check
make cross-build
```

以及根目录 `git diff --check`，未发现 whitespace 错误。

`make check` 完整通过：architecture-check、fmt-check、go vet、所有普通测试、所有 race 测试、client-contracts、M2 reference、M4 reference、fresh Go wire、所有真实 HTTP/Socket.IO/原客户端代理测试、持久化、升级回退与最终构建。具体可核实输出包含：

- 12 frozen fixtures 与 13 migrations 的 hash/inventory 验证保持不变；checker selftest 21/21。
- M2 1216 个原 TS/Go projector 对照。
- M4 reference 7 suites / 173 assertions；fresh Go public wire 被原 reducers/schema 接受。
- M4 backend 16 check groups；实时恢复包括 1201 条消息分页、权限撤销与断线重连。
- 两个冻结 M3 基线到 M4 的升级、旧程序拒绝新 schema、匹配冷备恢复；冻结 M4 与当前重构程序之间的回退验证。
- CGO-free Linux amd64、Windows amd64 编译通过；这是编译证据，不是 Linux/Windows 实机运行验收。

新增系统频道与 Agreement 测试进入了全量普通/race suites。**未执行浏览器 UI 复测、未执行 M5 Agent 收件/回复、未请求真实模型。** 不把本轮后端结果写成上述 UI 问题全部关闭。

## 6. 环境与最终交接

`make check` 构建了新的 `server-go/bin/raft-server`，构建输出时间 `2026-10-09T05:41:54Z`（洛杉矶 2026-10-08 22:41:54）。但 4301 仍是此前运行的进程，Vite 5175 未切代理。UI 协作者开始补丁复测前，应由环境负责人在自己的窗口加载新二进制，核对新进程/build identity；不要拿旧进程行为否定或签收新补丁。

推荐最小复测：新建空间、邀请第二账号、无 Join 在两个系统频道互发，验证侧栏/实时/刷新/重试；Administration 检查 Agreement 的清楚未启用说明；回归自建公共/私有频道、DM 和线程，确认未放宽权限。然后单独处理客户端待办，不混成一次“后端已全修复”的结论。

M5 设计和后续工作包见 `phase-5-delivery.md`、`m5-implementation-coordination.md`。本轮没有新增 migration，没有更改原客户端，没有迁移协作者数据，也没有提交/推送代码。
