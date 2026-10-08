# M2 目录与初始化 Schema（setup worker 维护）

> 适用范围：`server-go` 迁移 `0004_workspace_setup.sql` 创建的全部表、
> 相关读取边界与跨 worker 协调事实。TS 基线 `c4a5015`。
> 本文是实现事实的登记，不是兼容性完成的声明。

## 1. 表清单与 TS 映射

| Go 表 (SQLite) | TS 表 (PostgreSQL) | 用途 | M2 写入方 |
|---|---|---|---|
| `workspace_member_setup` | `server_members` 的 `setup_*` 列 | 每成员持久 setup 状态（设计 6.2 拆表） | 创建事务（foundation）+ setup 命令 + settings reconcile |
| `machines` | `daemons` | 最小机器目录（只读） | 仅测试 fixture；M3 接入模块扩展 |
| `computers` | `computers` | 托管 Computer 目录（只读） | 仅测试 fixture；reset 写 `revoked_at` |
| `agents` | `agents` | 最小 Agent 目录（只读边界） | 仅测试 fixture；产品无 agent writer |
| `agent_members` | `server_agent_members` | Agent 的空间角色 | 仅测试 fixture |
| `users` 追加列 | 同名 | 账号级首次完成事实 | setup-handoff |

时间戳一律 INTEGER Unix 毫秒（UTC），布尔 0/1，UUID 为 TEXT——沿用 0001 约定。

## 2. 关键列

### workspace_member_setup
```
workspace_id, user_id          PK(workspace_id,user_id)；
                               复合 FK → workspace_memberships ON DELETE CASCADE
status          not_started|in_progress|deferred|complete   （deferred 仅兼容读取）
completion_reason  NULL | normal|grandfathered|complete_after_defer|admin_override
                               CHECK：非 NULL 时必须 status='complete'
contract_version TEXT NOT NULL  （新行 onboarding-setup-v2）
handoff_acknowledged_at INTEGER NULL
```
迁移回填：为既有 membership 插入 `not_started/NULL/v2` 行（不自动 complete）。
创建事务按协调文档契约写入同样的初始行。

### machines（对 settings/未来 worker 的稳定列集）
```
id, workspace_id(FK workspaces), user_id(FK users), name, description,
api_key_prefix, runtimes(TEXT JSON 数组; NULL=未上报), hostname, os,
daemon_version, computer_version, computer_version_reported_at,
last_heartbeat, last_status(online|offline|NULL), status_changed_at, created_at
```
刻意不含 `api_key_hash`/`api_key_fingerprint`：M2 没有任何校验这些密钥的
路径，不保存无人验证的秘密；M3 接入流程落地时再增列。

### computers
```
id, workspace_id(FK), name, attached_by_user_id(FK users, NULL),
machine_id(FK machines ON DELETE SET NULL), created_at, last_used_at,
revoked_at, revoked_by_user_id, revoked_reason
```
非撤销行即"连接过 Computer"这一持久事实；reset 只写 `revoked_at`
（与 TS 一致，不写 revoked_by/reason）。

### agents / agent_members（settings worker 已按此对齐 sidebar 消毒 SQL）
```
agents: id, workspace_id(FK), name, display_name, description, avatar_url,
        status(active|inactive|stopped), runtime(默认 claude),
        machine_id(FK machines, NULL), creator_type(user|agent|NULL),
        creator_id, deleted_at, created_at, updated_at
        唯一索引 (workspace_id, name) WHERE deleted_at IS NULL
agent_members: PK(workspace_id, agent_id), role(member|admin), joined_at, updated_at
```
sidebar / 官方身份 / 配置 setter 校验共用 `workspace_id + deleted_at IS NULL` 语义，
与 TS `a.server_id` / `a.deleted_at IS NULL` 一致。

### users 追加
```
first_onboarding_completed_at INTEGER NULL
first_onboarding_completed_session_family_id TEXT NULL
```
均为首次写入生效（WHERE IS NULL），重复点击不刷新。survey 事实复用 0001 的
`signup_survey_completed_at`，不重复建列。

## 3. 在线状态 seam（重要语义）

TS 的机器 online 判定来自 orchestrator 的实时 socket（`getMachineStatus`），
异常时降级 `unknown`。Go M2 没有连接层，因此：

- `internal/workspace/setup_facts.go` 的 `machineStatusProbe` 默认对每台机器
  返回错误 → 状态 `unknown`（TS catch 分支的等价物）。**绝不伪造 online**。
- 推论：有 machines 记录时 computerStatus=`unknown`（gateReason=
  `computer_status_unknown`）；完全空目录才是 `offline`（新空间验收投影，
  设计 10.2）。`machines.last_status` 是"上次落定状态"，只用于目录
  `statusSince` 推导，不作为 online 依据。
- `directories.go` 的机器列表 `status` 恒为 `"offline"`、`statusVersion` 0、
  `runtimeVersions` `{}`、`computerVersion`/`hostKind` NULL——这些在 TS 中
  都是 live-only 字段，M2 诚实降级。
- M3 接入层替换 probe 后，投影/目录自动获得真实 online 分支；测试通过
  覆写 probe 已经覆盖 online 路径（`withProbe`）。

## 4. Runtime admission（投影 runtimeOptions）

`RuntimeAdmissionPolicy{GrokRuntimeEnabled, OmpRuntimeEnabled}`，C0 全 false
（TS missing_flag → enabled:false；协调文档禁止启用未支持的 platform 旗标）。
候选目录 = shared RUNTIMES 中 supported、非 deprecated、非 builtin 的条目
（claude, codex, grok, kimi-sdk, copilot, cursor-sdk, opencode, pi, omp），
按此顺序输出。`kimi-sdk` 携带 `formDefinitionRef`
（protocolVersion 1 / kimi-sdk.create.v1）；其余省略该字段（TS optional 语义）。
推荐集合 `{claude, codex}` 决定 `ready_recommended`。

## 5. W17（GET /api/servers/:id/machines）响应形状证据

领域函数 `ListMachines(ctx, workspaceID, userID) ([]map[string]any, error)`
返回裸数组（空目录为 `[]` 非 null）。**TS 路由实际返回包裹对象**：

```json
{ "machines": [ ... ], "latestDaemonVersion": null, "latestComputerVersion": null }
```

证据：`routes/servers.ts` `res.json({machines, latestDaemonVersion,
latestComputerVersion})`；Web `machineStore` `Array.isArray(data) ? data :
data.machines` 两种都接受。**HTTP worker 应按 TS 包裹形状输出**（两个
latest* 版本字段在 M2 恒为 null——无 release 元数据源）。路由矩阵 W17 写的
"wrapped: false" 与 TS 实际代码不一致，以 TS 基线为准；此事已在交接报告登记。

每机器字段（与 TS 逐字段一致）：`id, serverId, userId, name, description,
apiKeyPrefix, runtimes, hostname, os, daemonVersion, lastHeartbeat, createdAt,
status, statusVersion, runtimeVersions, computerVersion, hostKind, isComputer,
computerAttachedByCurrentUser, agentCount, creator, statusSince,
computerUpgradeAvailable, computerBroadcastPolicy`。
`statusSince` 为毫秒 epoch 或 null（优先级：落定 offline 状态时间 → 心跳 →
创建时间；无 open outage 表，M2 恒无该输入）。Computer 机器的
`computerBroadcastPolicy` 为 TS 精确的 `source_missing` 决策（无 live 版本源）。

## 6. 跨 worker 协调事实

- **settings**：`validateConfiguredAgentTx(ctx, tx, workspaceID, agentID)`——
  通过条件：agents 行存在 + 同 workspace + `deleted_at IS NULL`（接受任何
  真实本地 Agent，不查官方身份——D11）。失败返回
  `*DomainError{Code:"INVALID_INPUT", Message:"Onboarding agent not found in this server"}`。
  空字符串 agentID 不要调用（TS falsy = 清空指针）。
  `reconcileOwnersTx(ctx, tx, workspaceID)`——指针非空时把未 complete 的
  owner 行写成 `complete/grandfathered`，已 complete 的 reason 不变。
- **http**：setup 命令错误码即 TS 机器码（`INVALID_SETUP_ACTION` 400；
  `ACTOR_NOT_HUMAN`/`CROSS_USER_TRANSITION`/`INSUFFICIENT_PERMISSION` 403；
  `STATE_NOT_FOUND` 404；`OFFICIAL_ONBOARDING_AGENT_NOT_USABLE`/
  `SERVER_ALREADY_SET_UP` 409；`LIVE_FACTS_UNAVAILABLE` 424；未分类 500
  `SERVER_SETUP_TRANSITION_FAILED`/`SERVER_SETUP_RESET_FAILED`/
  `SERVER_SETUP_HANDOFF_FAILED`）。`GetSetupProjection` 不返回业务错误
  （一律 200 投影；仅基础设施故障 500）。`SetupResetResult` 的
  `Projection` 字段带 `json:"-"`，transport 需把投影字段与
  `revokedComputers` 合并输出。
- **迁移顺序契约**：`workspace_member_setup` 对 `workspace_memberships` 有
  复合外键。0003 的 membership 表重建（drop+rename）必须在 0004 之前应用；
  最终树按文件名天然满足。**不要保留只应用过 0004 的中间数据库**再用旧
  二进制升级。任何未来重建 workspace_memberships 的迁移必须先处理子表外键
  （事务内 PRAGMA foreign_keys=OFF 无效，见设计 6.3）。
- foundation 公共 API（store.go/model.go/policy.go）已按协调契约落地；
  本切片曾用的临时 `DomainError` shim（setup_foundation_pending.go）已删除，
  代码已切换到 model.go 常量。

## 7. 测试与证据状态

- 49 个行为测试（纯投影器 18 + runtime 4 + 持久化/命令 17 + 目录 10）全部
  通过（`go test ./internal/workspace/ -count=1`）。
- 纯投影器另通过 integrator 的 TS 执行对拍：1216 例
  （`node tests/acceptance/workspaces-reference.mjs`）。
- 失败注入：SQLite trigger 注入 computer 撤销失败 / users 首次完成写入失败，
  验证事务原子回滚。
- 详见交接报告（会话总结），含未覆盖缺口清单。
