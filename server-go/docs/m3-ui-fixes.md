# M3 UI 缺陷修复报告（前端）

> 后续集成记录：本报告保留前端 worker 的执行范围与当时结果。中断恢复后的补充修正（含Office空workspace清理）、最终58项定向Web回归及完整Go/真实HTTP验证，见 [m3-ui-fix-closeout.md](m3-ui-fix-closeout.md)。浏览器黑盒仍待部署补丁后复验。

日期：2026-10-08（含 parent code review 修订）。范围：`m3-ui-acceptance-report.md` §6 中经验证的 P2/P3 前端缺陷（#2、#3、#4）。改动仅限 `packages/web`；Go 侧只做只读核对，未改任何后端文件。执行者：前端 worker。

## 结论速览

| # | 缺陷 | 根因 | 修复 | 状态 |
|---|---|---|---|---|
| #2 (P2) | 设备码批准页无拒绝入口 | `DeviceLoginPage.tsx` 固定发 `approve:true` | 并列 Deny 按钮，共用一条提交路径（pending/approved/denied + 共享错误映射）；in-flight/terminal 双 ref 防护；仅被选中的动作显示 Approving…/Denying… | 代码 + 行为测试完成 |
| #3 (P2) | Agent 详情裸 "Not found"+Retry；日志出现 `GET / → 404` | Skills 与 Reminders 两个**可选面板**请求的端点在当时的 Go 服务器上不存在（ Skills：`GET /api/agents/{id}/skills`；Reminders：`GET /api/reminders`），落入 catch-all → 404 `{"error":"Not found"}`，前端把该文本直接渲染成错误横幅 + Retry | 服务器返回**显式 501 `feature_not_implemented`**（后端已补 deferred 端点）时渲染"此服务器未提供该功能"；**generic 404 一律保留为真实错误** | 代码 + 行为测试完成 |
| #4 (P3) | #all 每次加载弹 "Failed to load Activity mute setting."；Office 成员视图 "The office could not be loaded." | mute：`GET /api/channels/{id}/notification-settings` → Go dispatcher `writeDeferred` → 501；Office：`GET /api/servers/{id}/agent-overview` 当时无路由 → 404（现已由后端补为显式 501） | mute：读/写遇显式 501 时静默降级隐藏控件、无横幅；Office：显示 "not enabled on this server" 文案，并在工作区切换时清除旧 overview 与 scoped 状态 | 代码 + 行为测试完成 |

未动：#1（P1 workspace 邀请路由，后端 worker 范围，parent 已另行补齐）、#5（`/api/servers/unread-summary`、`/socket.io/` 日志噪音，无用户可见横幅）。

## 根因与证据

### `GET / → 404` 日志的精确含义

访问日志中间件（`internal/transport/legacyweb/middleware.go:40-46`）记录的字段是 **`request.Pattern`（匹配到的注册 pattern），不是请求 URL**：

```go
route := request.Pattern
if route == "" { route = "unmatched" }
logger.Info("http request", "method", r.Method, "route", route, "status", rec.status, ...)
```

任何未命中显式路由的路径都由 `mux.HandleFunc("/", fallback)`（`routes.go` catch-all）接住，此时 `request.Pattern == "/"`。因此验收报告中的 `GET / → 404` 应读作"GET 请求匹配到 catch-all `/` 处理器并返回 404"，**不代表客户端请求了根路径**。Skills/Reminders 等未注册端点会产生这种日志，但单凭 pattern 不能唯一归因。修复源码已为这些端点显式注册授权后的501；**本轮没有重启现有4301实例，不能声称现场日志已经消失**。

### #3 Agent 详情 "Not found"+Retry（源码位置证据）

两个独立面板各自请求一个**当时不存在的可选端点**：

- **Skills**：`AgentSkills.tsx` 请求 `GET /api/agents/{id}/skills`，错误分支直接渲染 `err.response.data.error`（"Not found"）+ Retry。其在 profile tab 的渲染位置由 `AgentDetailPanel.tsx` 源码顺序唯一确定：`AgentProfileInfo`（内含 `AgentCreatedAgentsSection`，约 L2538-2546）→ `AgentSkills`（约 L4440-4444）→ Actions 区（约 L4446-4451）。验收报告描述"Created Agents 与 Actions 之间"恰与该源码顺序一致，且该区间再无其他错误横幅来源；此为**源码顺序推导**，非截图比对。Reminders（`AgentRemindersSection`，`GET /api/reminders`）位于独立 tab，是同类问题的另一处。
- 后端事实（只读核对）：parent 已在 `deferred_ui_routes.go` 注册 `GET /api/agents/{id}/skills` 与 `GET /api/reminders`——先完成认证、scope、对象/编辑权限检查（未授权得 401/403，语义化 404 如 "Agent not found"），授权调用者得显式 **501 `feature_not_implemented`**。文件头注释明确设计意图："A missing capability is not a missing resource… Do not teach clients to hide arbitrary 404s"。

### #4 Activity mute 与 Office

- mute：`GET /api/channels/{id}/notification-settings` 在 `channel_routes.go` dispatcher 中命中 `writeDeferred` → 501 `{code:"feature_not_implemented"}`。读取失败被 `ChatPanel` 渲染为 alert 横幅，每次进入频道都出现。
- Office：加载失败本身是 **HTTP `GET /api/servers/{id}/agent-overview`**（当时无路由 → 404；现已由后端补为 gate+scope+guest 门控后的显式 501 "Office overview is not enabled in this server stage"）。它不是 Socket.IO 501 本身——`/socket.io/` 501 是另一条独立日志现象（office 的实时事件推送依赖它），与加载失败文案无直接关系。
- 这些端点是**服务器现阶段未启用的未来能力**（ reminders/skills/Office 均超出当前人工消息面范围）；本报告不将其归入任何特定里程碑义务。

## 前端修复设计

### 共享判据（防误吞真实错误）

`src/utils/serverFeatureAvailability.ts` 的 `isServerFeatureUnavailableResponse(err)` **仅匹配一种信号**：`501 && data.code === "feature_not_implemented"`。

**generic 404 一律不匹配**（含 Go catch-all `{error:"Not found"}` 与 TS catch-all `{error:"Not found",code:"not_found",path}` 两种形态）：404 有歧义——可能是资源真的不存在、代理误路由、路径拼写错误——必须保持真实错误路径。测试矩阵（`tests/serverFeatureAvailability.test.ts`）钉死：401/403/5xx/网络错误/语义化 404（"Agent not found"）/无 code 的 501 全部不匹配。

### #2 DeviceLoginPage（`packages/web/src/pages/DeviceLoginPage.tsx`）

- `decision: pending | approved | denied` 状态机；`submitDeviceLoginDecision(approve)` 一条路径两用；Deny 发送 `approve:false`（后端语义：轮询设备得 `access_denied`，`computer_deviceauth.go:80` 只读核对）。
- **in-flight 防护**：`inFlightRef` 同步读取——同一 tick 内的第二次点击（React 批处理使 `submitting` state 尚未生效）不会发出第二个 POST。
- **terminal 防护**：`decidedRef` 在决定落地时置位；决定视图替换整个表单，无任何再提交入口。
- **单按钮进行中文案**：`pendingAction` 仅在**被选中的**按钮上显示 "Approving…"/"Denying…"；另一按钮保持静止标签（两按钮均禁用）。
- Approve 保持 form submit（回车默认批准不变）；denied 结果页与 approved 共用 Close this page 流程。i18n 新增 5 key ×（en/zh-cn）。

### #3 Skills / Reminders 诚实降级（`AgentSkills.tsx`、`AgentDetailPanel.tsx`、`AgentRemindersSection.tsx`）

- Skills：catch 命中显式 501 → 渲染 "Skills are not available from this server."（无 Retry）；其余一切错误（含 generic 404、401/403、5xx）保持原错误文本 + Retry。
- Reminders：loader 命中显式 501 → `AgentRemindersSection` 新 `unavailable` prop 渲染同款诚实文案；真实错误横幅与 Retry 不变。

### #4 Activity mute（`ChatPanel.tsx`）与 Office（`office/OfficePage.tsx`）

- mute 读取遇显式 501 → `activityMuteUnavailable`，不设错误横幅；toggle 写入遇同类响应 → 回滚乐观状态并同样降级；header 按钮（含 topbar overflow 菜单项）隐藏，handler guard 阻止后续触发。选择"隐藏控件"而非"禁用+提示"，与产品对 DM/thread 不渲染 mute 控件的既有模式一致。**generic 404 保持原横幅**（测试覆盖两种 404 形态）。
- Office：
  - `assetsError`（前端资产加载失败，与 scope 无关）与 `overviewError`（当前 workspace overview 真实失败）**分离为两个标志**，互不清除、互不冒充。
  - scope 切换（serverId 变化）时先清除上一 workspace 的 `overview` 与场景缓存（`officeRef`/`structureRef`），并重置 `overviewError`/`unavailable`——`overview=null` 经 scene memo 使 `officeState=null`，画布子树随之卸载，旧 workspace 的画面不会残留在新 scope 的"未启用"提示之下。
  - overview 遇显式 501 → 显示 "The office view is not enabled on this server."（`office-unavailable`）；其他失败保留 "could not be loaded."。

### 明确未做（边界）

- 不实现这些未来能力的前端模拟或后端端点。
- `message-display-settings` 501 与 `unread-summary` 404：报告未列为缺陷（后者无横幅），不动。
- 未改任何后端路由/文档/锁线；未触碰 screenshots、var 备份、4301/5175 进程。

## 测试（全部已执行）

```
node scripts/run-vitest-tests.mjs [--dom] <file>   # 于 packages/web 下
```

| 套件 | 结果 | 关键覆盖 |
|---|---|---|
| tests/serverFeatureAvailability.test.ts | 4/4 | 显式 501 匹配（skills/reminders/office/socket.io 四种文案）；**generic 404 两种形态必须保留为真实错误**；401/403/语义化 404/5xx/网络错误不匹配 |
| tests/deviceLoginPage.behavior.test.tsx | 10/10 | deny 提交体 `approve:false`、denied 结果页+Close、**仅选中动作显示进行中文案（另一按钮静止且禁用）**、**same-tick 双击仅一次 POST**、**决定落地后表单卸载无再提交入口**、deny 错误复用码生命周期文案 |
| tests/deviceLoginPageContract.test.tsx | 2/2 | 原契约不回归 |
| tests/agentSkillsAvailability.behavior.test.tsx | 4/4 | 显式 501 → 未启用无 Retry；**generic 404（两种形态）→ 保留错误+Retry**；语义化 404 保留；真实错误 Retry 后可达降级态 |
| tests/agentReminders.behavior.test.tsx | 3/3 | unavailable 渲染无 Retry；真实错误保留横幅+Retry；原有链接行为 |
| tests/activityMuteHeader.behavior.test.tsx | 30/30 | 显式 501 读降级、toggle 501 回滚+隐藏+无横幅；**generic 404（两种形态）→ 横幅保留且控件不隐藏**；原 27 项不回归 |
| tests/officePageAvailability.behavior.test.tsx | 4/4 | 显式 501 → 未启用文案；**generic 404 → 保留 could-not-load**；网络错误保留；**工作区切换时 scoped 状态随新 scope 设置与清除**（注：jsdom 无法解码 office 图片资产，画布挂载/卸载为结构性保证——`overview` 清空 → scene=null → 画布子树卸载——浏览器端补测见下） |
| 回归：messageForwardChatPanel + chatPanelNamespace.i18n + agentReminders | 33/33 | — |
| 回归：agentDetail.i18n / agentMigrationProfileEntry / agentRuntimeConnectionFields / agentRuntimeErrorBanner / agentUnavailablePanel | 95/95 | — |
| 回归：agentMachineResidueI18n / officeOverview / addMachineDeviceApproval | 12/12 | — |

`pnpm run typecheck` 通过；改动文件 oxlint（src+tests）通过；`check-i18n-literals`（152 keys baseline）通过。仓库 lint 全量另有 6 处 HEAD 预存报错（`MessageItem.tsx` bg-brutal-yellow、`ComputerCommandGuide` import 风格等），涉事文件本次零改动（`git diff` 证实），不在本任务范围。

## 未验证部分（如实声明）

- **浏览器端到端未执行**：本 worker 会话沙箱禁止本地回环连接（curl 127.0.0.1 一律 `Operation not permitted`，含声明 allowed_domains 后），无法访问运行中的 4301/5175 做黑盒复验；DevSpace MCP 端口同被阻。组件级行为已由 jsdom 套件覆盖。
- 建议人工/后续浏览器补测：① 设备码页 Deny → CLI 端轮询得 `access_denied`；② Go 服务器下 Agent 详情 Skills 区显示"未提供"文案、generic 404 场景仍显示错误+Retry；③ #all 无 mute 错误横幅、header 无 mute 按钮；④ Office 视图显示"未启用"文案，且**切换 workspace 后旧办公室画面消失**（jsdom 无法验证画布，此项仅浏览器可测）；⑤ 同一设备码快速连点 Approve/Deny 仅发一次请求。
- `ps` 在沙箱内不可用；本 worker 未对 4301/5175 发送任何信号，未做任何代码外的环境变更。

## 评审修订记录

- 2026-10-08 第一版。
- 2026-10-08 parent review 修订：判据收紧为**仅显式 501 `feature_not_implemented`**（generic 404 保留真实错误，测试双向钉死）；DeviceLogin 增 in-flight/terminal 防护与单按钮进行中文案；Office 拆分资产/overview 错误、scope 切换清除旧 overview 与 scoped 状态并补切换测试；报告根因精确化（`GET /` 为 `request.Pattern` 匹配结果而非 URL；Skills 位置改为源码顺序推导；Office 失败归因于 HTTP 端点而非 Socket.IO；端点统称"未启用的未来能力"，不指定里程碑）。
