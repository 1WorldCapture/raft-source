# M2 HTTP worker 交付报告

范围：`docs/m2-implementation-coordination.md` 中的 HTTP worker 槽位（`internal/transport/legacyweb/` 的 workspace handler/DTO/scope/路由/测试、`internal/app/app.go`、`internal/platform/config/` policy 接线、头像复用）。本报告是状态陈述，不是完成宣称；未尽事项见"缺口"。

## 交付文件

**新增（传输层）**
- `internal/transport/legacyweb/workspace_scope.go` — `RequireServerScope`（X-Server-Id 缺失/不匹配 400、非成员/已删除/joint_storage 403 的共同前置中间件，把解析出的 membership 放入 request context）、`DenyGuests`（管理表面 guest 403，对所有方法生效）、DomainError→HTTP 状态/形状映射（通用四码 + TS setup 机器码 403/404/409/424）。
- `internal/transport/legacyweb/workspace_handlers.go` — W08–W17 处理器。
- `internal/transport/legacyweb/workspace_method_policy.go`（integrator 协同产物）— 405/Allow 兜底，先走身份/scope/guest 检查再 405。
- `internal/transport/legacyweb/avatar_store.go`（integrator 协同产物）— os.Root 沙箱化、临时文件+硬链接原子发布的内容寻址头像存储。
- 测试：`workspaces_testsupport_test.go`、`workspaces_scope_test.go`、`workspaces_create_test.go`、`workspaces_list_order_test.go`、`workspaces_profile_test.go`、`workspaces_avatar_test.go`、`workspaces_members_settings_test.go`、`workspaces_setup_test.go`、`workspace_history_internal_test.go`。

**重写/修改**
- `servers_handlers.go` — W01–W07（create 的 JS truthiness/类型兼容、列表投影含 serverOrderVersion 与 trial 时窗、order GET/PATCH、详情、PATCH 资料、头像上传入口）。
- `routes.go` — W01–W17 全量注册；`/api/servers/order` 字面量优先于 `{id}`；`/api/avatars/servers/{file}` 静态服务；socket.io、/internal、/daemon 维持诚实 501。
- `avatar_handlers.go` — 校验/重编码管线抽取为 `decodeValidatedAvatarPNG`，users/servers 两命名空间复用；服务端头像 URL 为 `/api/avatars/servers/<sha128>.png`（服务端返回的真实稳定路径）。
- `internal/app/app.go` — `workspace.NewStoreWithOptions`（注入 clock + policy 向量）接入 ServersHandlers。
- `internal/platform/config/workspace_policy.go`（integrator 协同）+ Config.WorkspacePolicy：`RAFT_GO_POLICY_ONBOARDING_OPENER_V2|RAFT_GO_POLICY_ONBOARDING_OWNER_WIZARD_V0|RAFT_GO_POLICY_FEEDBACK_ENABLED`，仅接受 0/1，feedback=1 显式报错（诚实：M2 无反馈系统）。C0 全默认关闭。
- M1 测试适配（仅机制、不改断言）：`testsupport_test.go`/`policy_avatar_persistence_test.go`/`app_test.go` 改为进程内 recorder 驱动（本沙箱禁本地 bind）；`refresh_logout_servers_test.go` 的 create 501 断言已由 foundation 侧替换为真实创建契约（与我的 W01 测试一致）。

## 路由状态（对照 workspaces-route-matrix.json）

| 路由 | 状态 | 说明 |
|---|---|---|
| W01 POST /api/servers | 已实现+测试 | 200 裸 ServerRecord；truthiness/类型分支在传输层，slug 规则与活跃冲突 409 在域层 |
| W02 GET /api/servers | 已实现+测试 | 排序/版本由域层 ListUserServers 提供；trial 时窗（2026-04-18→2026-06-23T12:00Z，free 窗口内 -1）在传输层按注入时钟求值，单测覆盖边界 |
| W03/W04 GET/PATCH /api/servers/order | 已实现+测试 | 数组字符串校验+去重在传输层；过滤/补全/无变化不加版在域层事务 |
| W05 GET /:id | 已实现+测试 | 纯 ID 查找，无 slug 回退 |
| W06 PATCH /:id | 已实现+测试 | 权限先于校验；UTF-16 100 边界（含 emoji 代理对）覆盖 |
| W07 POST /:id/avatar | 已实现+测试 | 权限先于解码；legacy errorCode 形状；DB 失败不假成功（trigger 注入） |
| W08 GET /:id/members | 已实现+测试 | guest 处理器级拒绝；邮箱/hideHumans 隐私在域层 |
| W09/W10/W11 settings/onboarding-settings | 已实现+测试 | W11 原始 body map 直通域层（别名合并、校验顺序、grandfathered reconcile 均在域层）；组合更新原子性 trigger 测试 |
| W12 GET setup-projection | 已实现+测试 | §10.2 新 owner 投影逐字段断言 + 重启保持 |
| W13 POST setup-transition | 已实现+测试 | defer/未知 action 400；start 幂等；complete 无官方 Agent 409 |
| W14 POST setup-reset | 已实现+测试 | 域层 SetupResetResult{Projection(json:"-"), RevokedComputers} 在传输层平铺合并 |
| W15 POST setup-handoff | 已实现+测试 | ownerId 鉴权 403 INSUFFICIENT_PERMISSION；无 complete 前置（D06）；首次时间不可变 |
| W16 GET sidebar-order | 已实现+测试 | 19 字段全量断言、空数组非 null、版本为 number |
| W17 GET machines | 已实现+测试 | 采纳 TS 实际对象信封 `{machines, latestDaemonVersion:null, latestComputerVersion:null}`（web 两形状兼容；与 matrix"裸数组"表述的差异已登记） |

## 契约决策与登记差异

1. **D02 软删 slug**：foundation 裁定——活跃冲突统一 409，仅软删保留行占用的 slug 维持 legacy 500 "Failed to create server"（统一 409 属待评审修复，不静默落地）。HTTP 测试按此断言。
2. **W17 信封**：见上表；matrix 标"wrapped:false 裸数组"与 TS 实际代码（对象信封）不一致，以 TS 代码为准并已测试。
3. **W12 意外错误形状**：legacy 路由无 catch → express 全局 500；Go 输出 `{"error":"Internal server error","code":"internal_server_error"}`（无 correlationId——沿用 M1 无 correlationId 的已登记差异）。
4. **create name 的 truthy 非字符串**：数字/布尔按 JS 字符串化（42→"42"，mirror legacy PG text 插入），数组/对象→500 "Failed to create server"（legacy insert 失败路径）。slug 非字符串→400 "Slug is required"。
5. **非法 JSON body**：沿用 M1 "Invalid JSON body" 400（legacy express 对非对象 JSON 会在字段校验得到 400，状态码一致、句子不同，属 M1 既有差异）。
6. **W13/W14 通用码**：TS 仅映射 ServerSetupStateError 机器码、其余一律 500；Go 对域层通用 DomainError（INVALID_INPUT 等）保留通用映射，仅未知码落到端点 500 兜底（防御性扩展，已注释）。
7. **joined_at 同毫秒 tie-breaker**（id 序）为 foundation 登记的非语义漂移；HTTP 测试通过固定 joined_at fixture 规避其对断言的影响。

## 与其他 worker 的协同记录

- settings worker：确认 GetSidebarOrder 返回完整 19 字段响应 map、错误经 DomainError.Message 透传；W11 直通原始 body 的分工经其确认。
- foundation：trimECMAScriptSpace 重复声明冲突由其自行解除；D02 分支细化后我同步了测试预期。
- integrator：并行加固了 avatar 存储（os.Root/原子链接）、405 门序（先鉴权后 405）、config policy 严格化（0/1、feedback 拒启）；我移除了被取代的冗余实现（apiRoutes 动态模板、简化版 publishAvatar、重复的 policy_test）。

## 测试结果（2026-10-08 本机，Go 1.27.1）

```
GOCACHE=<tmp> go test -count=1 ./...          # 全部通过，唯 internal/platform/mail 因沙箱禁本地端口 bind 失败（见"环境限制"）
GOCACHE=<tmp> go test -race -count=1 ./internal/transport/legacyweb/ ./internal/app/ ./internal/workspace/ ./internal/platform/config/   # ok
gofmt -l .                                    # 干净
go vet ./...                                  # 干净
CGO_ENABLED=0 go build ./cmd/raft-server      # ok
go test -count=1 ./internal/transport/legacyweb/  # 68 pass / 0 fail（含 M1 回归全部）
```

M1 回归：register_login / refresh_logout / me_profile / request_safety / verification_reset / backend_closeout / policy_avatar_persistence 及 workspace 域全部既有测试保持通过；唯一被替换的断言是"workspace create 501"（按协调文档换成真实创建契约，由 foundation 与我两侧覆盖）。

## 环境限制（需要用户决策）

本会话沙箱禁止本地端口 bind（EPERM）。影响：
- `internal/platform/mail` safety_review_test（需真实 TCP listener）无法在本沙箱运行；无绑定限制的环境可过。
- `make test-http`（tests/acceptance/*.mjs 需起真实服务进程）同样被阻，未能在此执行。
- 我的 Go 测试已改为进程内 recorder 驱动以完成验证；端到端 TCP 验证由 integrator 的 acceptance 层承担。
- 如需在本会话跑齐：settings 开启 `sandbox.network.allowLocalBinding: true`（无需重启）。

## 缺口（未覆盖/待后续）

- T05 同 slug 并发：已有 in-process 并发测试（4 goroutine 单赢家+副作用完整性）；跨进程竞争由 acceptance 层覆盖。
- T16/T17 部分分支（runtime ready→create_agent、424 LIVE_FACTS_UNAVAILABLE、official-agent usable 成功 complete）：需 Agent/机器 fixture，域层单测覆盖投影机；HTTP 层这些分支映射表已实现但无触发用例。
- T20 reset 与 Agent 创建竞态：域层同事务设计+域层测试；无 HTTP 触发用例。
- T26 原 Web 浏览器联调：归 UI 协作者，未宣称。
- Socket.IO/实时事件（server_order:updated 等）：未实现，未用 no-op 伪装。
- 翻译/公告/通知设置、成员管理、邀请等 deferred 能力：路由未注册（未知路径仍诚实 404）。
