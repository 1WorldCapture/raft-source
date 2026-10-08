# M3A 频道切片契约（CHANNEL worker）

- 基线：`4acd990`（M2）+ 本轮 M3 各 worker 并行变更
- 所有权：`internal/channel/**`、`internal/transport/legacyweb/channel_*.go`、migration `0006_channel_core.sql`、本文件、本切片测试。不编辑 routes.go/app.go。
- 依据源码（逐行读过，非按名字猜测）：`packages/server/src/routes/channels.ts`（589-917, 1938-2216, 2448-2745, 2974-3786）、`packages/server/src/services/channelService.ts`（155-530, 1092-1345, 1406-1965, 1966-2130, 2670-2682, 2904-3180, 3350-3530, 4512-4598, 4754-5310）、`packages/server/src/lib/channelActorPermissions.ts`、`packages/server/src/lib/actorPermissions.ts`、`packages/server/src/middleware/auth.ts`（212-238 requireServer）、`packages/shared/src/channelPermissions.ts`、`packages/shared/src/serverPermissions.ts`、`packages/shared/src/index.ts`（NAME_* / validateName）、`packages/shared/src/inboxScopeReadFrontier.ts`、`packages/shared/src/activityMute.ts`、`packages/server/src/app.ts`（557-564 挂载）、web 消费方 `packages/web/src/store/channelStore.ts`、`packages/web/src/hooks/useChannelMembers.ts`

## 1. 范围

实现（原 Web 频道核心闭环）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/channels` | GET | 列表（`?archived=exclude\|include\|only`，默认 exclude；排除 DM/线程；含 `joined`、权限投影、readState frontier） |
| `/api/channels` | POST | 创建公开/私有频道（creator admin 行 + 初始成员一起提交） |
| `/api/channels/{id}` | GET | 详情（含 `joined` 与权限投影） |
| `/api/channels/{id}` | PATCH | 改名/描述/可见性（public↔private）；guestVisible/guestJoinable 在本策略向量下 404 |
| `/api/channels/{id}` | DELETE | 删除（server `deleteChannels` 能力；系统频道拒绝） |
| `/api/channels/{id}/archive` | POST | 归档（channel capability `archiveChannels`） |
| `/api/channels/{id}/unarchive` | POST | 解档 |
| `/api/channels/{id}/join` | POST | 自助加入公开频道 |
| `/api/channels/{id}/leave` | POST | 自助离开（私有频道最后一个成员离开即软删） |
| `/api/channels/{id}/members` | GET | 花名册 `{agents, humans, externalMembers}` |
| `/api/channels/{id}/members` | POST | 添加单个 agent/人 |
| `/api/channels/{id}/members/batch` | POST | 批量添加 |
| `/api/channels/{id}/members/agent/{memberId}` | DELETE | 移除 agent 成员 |
| `/api/channels/{id}/members/user/{memberId}` | DELETE | 移除人类成员 |
| `/api/channels/{id}/members/{targetType}/{memberId}/role` | PATCH | 频道本地角色 member↔admin（authority_revision + 持久事件行） |
| `/api/channels/{id}/agents` | GET | 频道 agent 列表（#all/#announcement → 全服务器 agent 受众） |
| `/api/channels/system/all/hide` | POST | 隐藏 #all（专用表面；通用 visibility 字段拒绝 #all） |
| `/api/channels/system/all/restore` | POST | 恢复 #all |

明确不实现、且**绝不伪造成功**（显式 501 `feature_not_implemented`，与 M2 的诚实策略一致）：

- `/api/channels/dm`（GET/POST）、`/unread`、`/activity/*`、`/inbox*`、`/threads*`、`/saved*`、`/joint-invites*`、`/{id}/read`、`/{id}/read-all`、`/{id}/notification-settings`、`/{id}/message-display-settings`、`/{id}/files`、`/{id}/convert-to-joint`、`/{id}/joint-invites`、`/{id}/joint-invite/resend`、`/{id}/disconnect`、`/{id}/stop-all-agents`、`/{id}/resume-all-agents`、`/{id}/threads*` —— 属于 M4/M5（消息、未读、线程、投递）或联合频道/编排器域。
- `POST /api/channels` 携带 `visibility:"joint"`：原服务会创建联合频道；本阶段返回 501（`joint_channels_not_implemented`），不落任何行。

## 2. Migration `0006_channel_core.sql`（供 AGENT worker 对齐）

```sql
CREATE TABLE channel_agents (
    channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','admin')),
    authority_revision INTEGER NOT NULL DEFAULT 1,
    added_at           INTEGER NOT NULL,            -- unix ms
    PRIMARY KEY (channel_id, agent_id)
);
CREATE INDEX idx_channel_agents_agent ON channel_agents(agent_id);
CREATE INDEX idx_channel_agents_channel_role ON channel_agents(channel_id, role);

CREATE TABLE channel_membership_role_events (
    id                 TEXT PRIMARY KEY,
    channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    requester_user_id  TEXT NOT NULL REFERENCES users(id),
    target_type        TEXT NOT NULL CHECK (target_type IN ('user','agent')),
    target_id          TEXT NOT NULL,
    previous_role      TEXT NOT NULL CHECK (previous_role IN ('member','admin')),
    next_role          TEXT NOT NULL CHECK (next_role IN ('member','admin')),
    authority_revision INTEGER NOT NULL,
    delivery_status    TEXT NOT NULL DEFAULT 'pending'
                       CHECK (delivery_status IN ('pending','sent','dead_letter')),
    delivery_attempts  INTEGER NOT NULL DEFAULT 0,
    last_delivery_error TEXT,
    created_at         INTEGER NOT NULL,
    delivered_at       INTEGER
);
CREATE INDEX idx_channel_role_events_pending ON channel_membership_role_events(delivery_status, created_at);
CREATE INDEX idx_channel_role_events_channel ON channel_membership_role_events(channel_id, created_at);
```

对 AGENT worker 的接口约定：

- 频道 agent 成员只有 `channel_agents` 一张表；`role`/`authority_revision` 与 `channel_humans` 同构。
- `internal/channel` 导出 `IsChannelAgent` / `AddAgent` / `RemoveAgent` 供 agent 域复用（接受同事务 executor 注入）。
- 花名册/agent 列表按 `agents.workspace_id`（TS `serverId`）+ `agents.deleted_at IS NULL` 过滤；`serverRole` 读 `agent_members.role`（TS `server_agent_members`，LEFT JOIN 语义——缺行不是消失）。
- `channels.archived_by_agent_id` 仍是 TS 兼容列（0003 已有，无 FK）。M3A 人类归档路径恒写 NULL；agent 归档路径（`setLocalChannelArchivedByAgent`）属 agent 域。
- 本迁移不建任何 messages/未读表。

## 3. 组装（parent 接线）

```go
// internal/channel
channelStore := channel.NewStoreWithOptions(handle, channel.Options{Clock: wsClock})
// internal/transport/legacyweb
handlers := &legacyweb.ChannelHandlers{Store: channelStore}
legacyweb.RegisterChannelRoutes(mux, handlers, gate) // gate *legacyweb.AuthGate
```

- `RegisterChannelRoutes` 在传入的 `*http.ServeMux` 上注册集合路由（`GET`/`POST /api/channels` 与 `{$}` 尾斜杠，其余方法 JSON 405）以及一条方法无关的 `/api/channels/{rest...}`。子树不拆成多条方法模式：Go ServeMux 会在「方法更窄、路径更宽」或「通配符位置不可比」（`saved/{messageId}` 对 `{id}/archive`）时 panic。分发器把字面 deferred 路径放在 `{id}` 动作之前，405/501 语义与逐条注册相同。每条业务路由的链是 `gate.RequireVerifiedProfileComplete`（=TS requireAuth+requireVerified+profile 门）→ `RequireChannelServer`（=TS requireServer，见 §4）→ handler。
- TS 侧 `/api/channels` 挂载只有 `inboxRouteBackpressure + requireAuth + requireVerified + requireServer`，**没有** authLimiter；generalAuth 限流是否包裹由 parent 决定（本注册不自带限流器）。
- `channel.Store` 只依赖 `*sql.DB` + 注入时钟（`channel.Options{Clock}`），无其它服务依赖；不 import workspace/auth（通过 SQL 直读 `workspaces`/`workspace_memberships`，只读）。

## 4. 中间件契约（与 TS 逐条对齐）

`RequireChannelServer`（TS `requireServer`，auth.ts:212-238）：

1. 缺 `X-Server-Id` → `400 {"error":"Missing X-Server-Id header"}`
2. 成员资格查询（JOIN workspaces，排除 `deleted_at IS NOT NULL` 与 `kind='joint_storage'`）无行 → `403 {"error":"Not a member of this server"}`
3. 通过后把 serverID 放入请求 ctx。频道路由**不**要求 URL 与 header 匹配（`/api/channels/{id}` 的 `{id}` 是频道 id）；跨服务器访问由每个 handler 的 `channel.serverId != serverID → 404 Channel not found` 拒绝（与 TS 相同）。

门禁错误体（gate 已有实现，复用）：401 `auth_required`；403 `Email verification required`；403 `PROFILE_SETUP_REQUIRED`。

## 5. 领域权限模型（shared 矩阵的 Go 移植）

Server 角色→能力矩阵（`serverPermissions.ts`）：owner=全部；admin=除 `manageBilling` 全部；member=`viewChannel, createChannels, viewChannelMembers, joinPublicChannels, addChannelMembers, viewMembers, viewAgents, controlAgentRuntime, viewMachines, assignTasks`；guest=无。

频道能力解析（`channelActorPermissions.ts` + `channelPermissions.ts`）：

- `supportsChannelRoles = (type ∈ {channel, private}) && name != "all"`
- `hasEffectiveChannelCapability`：server 角色有能力 → true；否则 `isChannelMember && supportsChannelRoles && channelRole=="admin" && serverRole ∈ {owner,admin,member} && cap ∈ CHANNEL_ADMIN_CAPABILITIES`
- `CHANNEL_ADMIN_CAPABILITIES = {editChannelMetadata, archiveChannels, removeChannelMembers, changeChannelMemberRoles, manageGuestAccess}`
- `canAddChannelMembers`：可加频道(channel/private/joint 且 name≠all、未归档未删) && (owner|admin 或 (member && 已是频道成员))
- `channelAdminBasis`：server_role | channel_role | both | null
- 投影能力集 `CHANNEL_MANAGEMENT_CAPABILITIES`（9 项）随列表/详情返回
- 名称校验：`^[\p{L}][\p{L}\p{N}_-]*$`（Unicode），trim 后 1..32 个 UTF-16 单位；错误句子 `Channel name is required` / `must be at least` / `must be at most` / `must start with a letter and can only contain letters, numbers, hyphens, and underscores`；保留名 `all`、`announcement`（`'Channel name "all" is reserved'` + `code:"channel_name_reserved"`）。

冻结策略向量（本阶段）：guest 功能门=off（`canGuestReadChannel`/`canGuestJoinChannel` fail-closed → guest 列表看不到任何频道、不能加入）；读回执（peerReadStates）=off；联合频道=不存在（无写入路径）；plan 恒为 free（`maxChannels=-1`，配额分支保留但永不触发）。

## 6. 关键行为语义（从 TS 服务逐条移植）

- **系统频道**：`#all`（name=all，type channel=启用/private=隐藏）、`#announcement`（system_kind=announcement）。二者成员是**派生的**（无 channel_humans/channel_agents 行）：人类=非 guest 服务器成员；agent=全部未删 agent。`addHuman`/`addAgent` 对它们是 no-op（但 guest 添加被 403 拒绝）；`removeHuman`/`removeAgent`/归档/改名/改可见性均被拒绝（错误句子见源）。列表懒创建 #all/#announcement（`archived=only` 不创建）；隐藏的 #all 从列表剔除；announcement 花名册走派生受众。
- **创建**：creator 写 channel_humans role=admin；初始 userIds 校验服务器成员，全部通过才提交；重名（未删除、含归档）→ 活跃 409 `Channel name "x" is already taken` / 归档 409 `archived_name_collision` 载荷（含 `canUnarchiveArchivedChannel`）。
- **PATCH**：#all 的 visibility 字段被显式拒绝（`all_channel_visibility_managed_separately`，句子为 ALL_CHANNEL_VISIBILITY_REFUSAL 原文）；改 visibility 要求调用者是频道成员（`channel_membership_required`）；public→private 清 #all 的全部成员行；私有频道 guestVisible 恒 false。改名查重 → 409。能力与可见性成员资格在写事务内按当前行重查，失败回滚。
- **归档/解档**：幂等（重复归档返回当前行）；#all/#announcement 拒绝；`archived_by_user_id` 记录执行者。归档名仍占用（唯一索引仅按 deleted_at 过滤，0003 已建）。`archiveChannels` 在写事务内重查。
- **删除**：软删；#all/#announcement 拒绝（403 原句）；joint 400（本阶段无 joint 可达）。`deleteChannels`（DM 则参与者）与私有频道显式成员在写事务内重查。
- **加入/离开**：join 仅 type=channel 且未归档，`joinPublicChannels` 能力（member/owner/admin 有，guest 无→403 `Server role cannot join public channels`；guest 门关时 403 `Guest policy does not allow joining this channel`）；#all/announcement 隐式成员 join 幂等 `{ok:true}`；私有频道 join 403 `Private channels require an invitation`。leave 对 #all/announcement 报 `Cannot leave or remove from the #all channel` / `Cannot remove members from, or leave, the #announcement channel`（403）；私有频道最后一个成员（人+agent 计数）离开 → 软删该频道。加入能力、离开访问权与服务器成员资格都在写事务内重查。
- **花名册**：`{agents, humans, externalMembers: []}`；每行投影 `serverRole`（人类原始行把服务器角色放 `role`，Agent 放 `serverRole`，先归一再算 `effectiveChannelRole`/`channelAdminBasis`/`canChangeChannelRole`）；viewer 需 `changeChannelMemberRoles` 才有 `canChangeChannelRole=true`，且不能对自己/owner/admin/guest 操作；`hideHumansFromMembers` 对 #all 花名册过滤（member 视角只剩自己+community 管理员——本阶段无 community slug，即只剩自己）。`activity`/`activityDetail` 字段不存在（无编排器；TS 在编排器失败时的回退形状就是无这两个字段）。
- **角色变更**：目标是自己→`channel_admin_self_demote_forbidden`(409)；目标 owner/admin→`protected_server_role`(403)；目标无成员行→`channel_member_required`(409)；guest 提升 admin→`guest_channel_admin_forbidden`(409)；成功自增 `authority_revision` 并写 `channel_membership_role_events` 行。TS 在 socket 投递后把事件标 `sent`；本阶段无 Socket.IO，事件保持 `pending`（真实 outbox 状态，M4 实时层可消费），响应 `eventId` 为真实行 id。
- **channel_humans/channel_agents 不变式**：`joined_at`/`added_at` 为写入时钟；`authority_revision` 初始 1。

## 7. 响应 DTO（关键形状，均与 TS 字段名逐一对齐）

列表/详情项（在频道原始列之上追加）：

```
joined, channelRole(null|member|admin), channelAdminBasis(null|server_role|channel_role|both),
channelCapabilities{editChannelMetadata,archiveChannels,deleteChannels,changeChannelVisibility,
  manageGuestAccess,federateChannels,addChannelMembers,removeChannelMembers,changeChannelMemberRoles},
channelAuthorityRevision(null|number),
maxReadSeq:0, readStateVersion:0, readState:{kind:"absent"},        // 无读游标表时的真实值
collapseLongMessages:true, displayPrefsVersion:0,                    // 无偏好行时的默认值
activityMuted:false(announcement:true), muteFromSeq:null, prefsVersion:0,
activityMuteSupported:(type ∈ channel|private|joint),
jointChannelId:null, jointRole:null, jointPeerServerId:null, jointPeerServerName:null,
jointPeerServerSlug:null, jointPeerStatus:null, jointServers:[], jointPendingInvites:[], jointBillingLocked:null
```

- 原始列：`id, serverId, name, description(null|string), type, systemKind(null|all|announcement), guestVisible, guestJoinable, parentMessageId(null), createdAt, archivedAt, archivedByUserId, archivedByAgentId, deletedAt`（时间戳 = UTC 毫秒 ISO-8601，与 M2 milliTime 一致）。
- 列表项额外含 `lastMessageAt:null`、`lastMessagePreview:null`（TS `attachLastMessageAt`；无消息表时的真实值）。详情 `GET /{id}` 与创建响应不含这两个键（TS 这两个出口不调用 attachLastMessageAt）。
- 创建响应：上述权限投影 + `joined:true` + activityMute 三字段（类型支持时）+ `activityMuteSupported` + readState 三字段 + `jointInvites:[]`、`jointInvite:null`；**不含** lastMessageAt/collapseLongMessages。
- PATCH/archive/unarchive 响应：**仅频道原始列**（TS `res.json(updated)` 原样）。
- join/leave/add/remove：`{ok:true}`；batch：`{ok:true, added:{userIds,agentIds}, alreadyMembers:{userIds,agentIds}}`。
- 角色变更：`{changed, channelId, targetType, targetId, channelRole, authorityRevision, eventId}`。
- 花名册 human 行：`{id, serverId, serverName, serverSlug, name, displayName, description, avatarUrl, gravatarHash, role, serverRole, channelRole(仅显式行), effectiveChannelRole, channelAdminBasis, canChangeChannelRole}`；agent 行：`{id, serverId, serverName, serverSlug, name, displayName, status, avatarUrl, channelRole, serverRole, effectiveChannelRole, channelAdminBasis, canChangeChannelRole}`。`gravatarHash = sha256(trim+lowercase(email))`。
- `GET /{id}/agents`：agent 原始行（`id, serverId, serverName, serverSlug, name, displayName, status, avatarUrl, channelRole, serverRole`）；系统频道时为派生受众（无 channelRole/serverRole 键）。

错误体：`{"error": "..."}`，带 code 的场景额外 `{"code"}`（channel_name_reserved / channel_archived / archived_name_collision / all_channel_visibility_managed_separately / channel_membership_required / 角色变更 machine code）。逐路由的状态码映射按 §1 表格与 §6 语义实现（测试固化）。

## 8. 已知偏差与缺口（如实记录）

1. **非字符串 `name` 创建**：TS `validateName(undefined)` 会抛 TypeError → 500；Go 回 400 `Channel name is required`。web 永远发送字符串，此偏差仅影响畸形请求，选择更严格而非复刻崩溃。
2. **Socket.IO 事件**（`channel:updated`/`channel:members-updated`/`channel:authority-updated`）、成员增删系统消息、归档/改名系统消息、未读通知：M4/M5 域，本切片不发布也不伪造。角色变更事件行停留 `pending`。
3. **`/system/all/hide` 的 `tryClaimAllChannelUnlockInstruction`**（onboarding unlock 声明列）属 agent 域（0008），本切片不写该列；隐藏/恢复可见性行为本身完整。
4. **Guest 视角花名册特殊形状**（TS 3116-3140）在 C0 下不可达（guest 读频道先被 404），代码路径保留。
5. **联合频道**：读路径按"显式成员"处理（与 TS 一致），全部联合专有写面 501/不可达；配额分支（free=maxChannels:-1）永不触发。
6. **`inboxRouteBackpressure`** 中间件（TS 挂载于 /api/channels 之前）无 Go 对应物：它只对 inbox 类路由做准入，本切片实现的频道路由不在其作用集内；deferred 的 inbox 路由已 501。
7. M2 遗留：`archived_by_agent_id` 无 FK（见 §2）。
8. `POST /channels` 对 `agentIds` 的校验要求 agent 未删除且属于本服务器（TS getAgent 语义）；agent 不存在 → 400 `Agent not found in this server`。
9. **离开/移除 #all 的状态码**：TS catch 只把消息里含子串 `Cannot remove` 的错误提升为 403，因此 #all 原句 `Cannot leave or remove from the #all channel` 会掉进 500。本切片把类型化 forbidden 映成 403 并返回原句（与 §6 一致）；#announcement 原句本身含 `Cannot remove`，两边都是 403。
10. **写事务内的资格复核**对齐 TS `withLockedChannelActorCapabilities`，并补上 TS 删除/加入/离开未锁住的窗口。PATCH、归档、解档、删除、创建、加入、离开、单人/批量添加、移除，以及角色变更，都在提交事务内重读工作空间成员资格（排除 `deleted_at` 与 `kind='joint_storage'`）、当前角色、频道绑定和对应能力。事务内失败则整笔回滚。能力锁失败的 HTTP 句子与 TS catch 相同（更新 → `You do not have permission to update channels`；归档/解档 → `Only admins can archive|unarchive channels`；添加 → `You do not have permission to add channel members`；移除 → `Channel capability required`）。删除失败句子仍是 `Only admins can delete channels`。改可见性另在事务内重查频道成员行（`channel_membership_required`）。私有频道删除在事务内重查显式成员。加入在事务内重查 `joinPublicChannels` / guest 门；离开在事务内重查仍可访问且仍是服务器成员。处理器上的预检保留稳定请求的原句；提交边界是事务内这次重读。

## 9. 测试

- `internal/channel`（`permissions_test.go`、`behavior_test.go`、`authorize_test.go`）：真实 SQLite 行为测试（迁移后 schema、系统频道不变式、重名/归档冲突、私有频道空员软删、角色变更 revision/事件行、跨服务器隔离、权限矩阵穷举、名称校验句子、并发创建重名由唯一索引仲裁）。`authorize_test.go` 在同一条写事务里先降权、删成员或改频道绑定，再证明 PATCH、归档、解档、删除、创建、加入、离开、添加、移除、角色变更与隐藏 #all 全部回滚。0006 是纯加表：打开已含 0001–0006 的库后，既有 `channels`/`channel_humans` 行仍可读，且不存在 messages 表。M2 文件原地升级的全表字节对比由 `internal/platform/db/m3_upgrade_test.go` 负责（非本切片文件）。
- `legacyweb`（`channel_http_test.go`，内部包测试，自建 mux + `RegisterChannelRoutes` + 真实 auth 栈，不依赖 parent 接线）：每路由的鉴权门（未验证/资料未完成/缺 header/非成员）、成功 DTO 逐字段断言、错误码、405/501 面、跨工作空间 404。
