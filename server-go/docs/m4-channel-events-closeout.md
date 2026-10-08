# M4 channel:updated / channel:members-updated — 意图生产收尾（channel 切片）

日期:2026-10-09。范围:仅 `server-go/internal/channel/**`(行为与测试);未触碰
`internal/app/**`、`internal/message/**`、`internal/readstate/**`、transport、
migrations(0001–0013 冻结)、`var*`。本文件是生产者契约的协调记录;dispatcher
接线归 parent(见 §5)。

## 1. 已核实的缺口

`docs/m4-realtime-integration-report.md` §9.3:M3 频道变更对合同 §4.2 的
`channel:updated` / `channel:members-updated` **不产生任何 intent**。本切片现已
为既有 M3 变更补齐 durable intents——每次真实变更在其 **同一个**
`db.WithWriteTx` 事务内经 `realtime.Enqueue` 入队;预算满
(`realtime.ErrBacklogFull`)则整个变更回滚(fail-closed),回滚时事实与意图一
同消失。outbox 行只含引用,无任何 payload(§3)。

## 2. 事件语义依据(原 TS 源,逐处核对)

原服务端发射矩阵(`packages/server/src/routes/channels.ts`、
`packages/server/src/services/channelRealtimeEvents.ts`):

| 变更 | 原行为 | Go 生产 |
|---|---|---|
| 创建(含初始成员) | `publishChannelUpdate`(channels.ts:846)→ 对当前已授权 socket 逐个 `channel:updated {channel}` + 订阅授予 | 1 × `channel:updated`;初始成员**静默**(TS create 无 members-updated) |
| rename/描述/可见性/guest 策略 | `publishChannelUpdate`(channels.ts:2191) | 1 × `channel:updated`(SQL 实际执行即发;TS PATCH 后无条件发布,含同值 PATCH——一致) |
| #all hide/restore | `publishChannelUpdate`(channels.ts:1982/2013);Go 的专用路由经 `UpdateChannel` | 1 × `channel:updated` |
| archive / unarchive | `publishChannelUpdate`(channels.ts:2564/2642) | 各 1 × `channel:updated`,仅真实跃迁;幂等重入不产生 |
| **删除频道** | **原 TS 不发射任何事件**(channels.ts:2676–2704 无 emit;joint disconnect 的裸 `{channelId}` 帧是另一变更) | **零 intent**(有意对齐;撤权由 realtime 授权层 fail-closed 保证,合同 §4.3"撤权不能只依赖通知") |
| 加成员(单个/批量) | `emitChannelMembersUpdated`(channels.ts:385–400/3323/3460):被加用户 `user:{id}` `channel:updated {channel,…,joined:true}` + 私有频道 `channel:{id}` 房 / 否则 `server:{id}` 房 `channel:members-updated {channelId}` | 1 × `channel:members-updated` per 真实行写入,`SubjectUserID=被加人类`(§3);幂等重加不产生 |
| agent 增删 | `emitChannelMembersUpdated`(channels.ts:3608 等,无定向帧) | 1 × `channel:members-updated`,`SubjectUserID=""` |
| 自己 join / 离开 | `server` 房 members-updated(channels.ts:3728/3740/3775) | join:`SubjectUserID=加入者`;leave:`""`;仅真实行变更 |
| 角色变更 | members-updated + 定向 `channel:authority-updated`(channels.ts:3509–3515) | 1 × `channel:members-updated`,`SubjectUserID=目标(仅 user 目标)`;**authority-updated 属另一事件族,本切片不产生**(§7) |
| 私有频道清空自动软删 | TS removeHuman 内部清理,路由仍只发 members-updated | 仅 members-updated,无 `channel:updated` |
| 懒 ensure #all/#announcement | service 层无 io,无发射 | 零 intent |
| 空字段 PATCH(无 SQL) | — | 零 intent(无 durable fact) |

原消费端(`packages/web/src/store/channelRealtimeSync.ts:84–103`、
`socketBridge.ts:180–181`):`channel:updated` 载荷为完整 channel DTO(应用
patch)或裸 `{channelId}`(按 id 重拉);`channel:members-updated` 载荷被忽略,
仅触发列表重拉。全部单 payload 参数。

## 3. 生产者 API / 字段(提案,dispatcher 按此接线)

`internal/channel/publications.go`:

```go
const (
    PublicationEventChannelUpdated = "channel:updated"
    PublicationEventMembersUpdated = "channel:members-updated"
)
// 两个包内 helper(随事实同事务调用;外部包经 Store 变更方法间接到达):
func (s *Store) enqueueChannelUpdated(ctx, tx, workspaceID, channelID) error
func (s *Store) enqueueMembersUpdated(ctx, tx, workspaceID, channelID, subjectUserID) error
```

realtime_publications 行字段:

| 列 | channel:updated | channel:members-updated |
|---|---|---|
| object_type | `"channel"` | `"channel"` |
| object_id | 频道 id | 频道 id |
| scope_id | 频道 id | 频道 id |
| subject_user_id | `""` | 被加成员/角色变更目标(人类 uuid);删除、agent、self-join 为 `""` |
| revision | 见 §4 | 见 §4 |

**SubjectUserID 语义扩展(需 parent 批准)**:0010 迁移注释写"SubjectUserID
是私有状态对象 owner"。此处提议扩展为"受影响成员的引用":publisher 在
subject 非空时**额外**向 `user:{subject}` 发射定向
`channel:updated {channel:<当前投影,joined:true>}`(精确复刻 TS
emitChannelMembersUpdated 的定向帧——私有频道被拉入的成员尚未入 channel 房,
这是他得知可见性的唯一信号)。subject 为空则只发房间帧。它是引用、不是
payload,也不是房间授予。

**Publisher 投影要求(安全 current-state 投影)**:
- `channel:updated`:从**当前** channels 行重投影 channel Wire DTO(单
  payload),受众=按**当前**授权解析(公开→server 房当前成员;私有→channel
  房/当前成员),与 m4 发布层的 authority-binding 复核一致;频道已删则视为
  已处理(无可投事实)。
- `channel:members-updated`:载荷固定 `{channelId}`(scope_id);私有频道→
  channel 房,否则→server 房;subject 非空时另发上述定向帧。
- 两个事件都**不得**内嵌成员名单/角色/描述——投影时重读。

## 4. Revision 策略(无需迁移)

channels 表**没有** revision/updated_at 列;channel_humans/channel_agents 只有
**逐行** authority_revision(删行即失;两个不同成员合法同处 revision 1)——都
不是稳定的 per-channel 单调版本。故沿用 dm:new 的**已提交意图前沿**策略:
`revision = max(变更毫秒, 同 (workspace,'channel',channelID,eventType) 已提交
MAX(revision)+1)`。同一事务内的多次入队能看到彼此的行 → 批量加成员在同一毫
秒内仍严格递增、绝不撞唯一键;同键重放(事务重试)幂等。**0001–0013 保持冻
结,无需新迁移**;若未来要求"频道行版本"而非意图前沿,最小迁移是
`ALTER TABLE channels ADD COLUMN revision INTEGER NOT NULL DEFAULT 0` + 写路径
自增——本切片未做也不要求。

## 5. Parent 接线清单

1. `internal/app` 的发布投影 dispatch(app 拥有)登记两个
   `(ObjectType="channel", EventType=…)` 分支,按 §3 投影;在此之前 drainer
   按既有 unknown-deferred 语义重试 8 次后 park(不吞、不阻塞其他行——失败行
   指数退避跳过,已验证)。
2. 若批准 §3 的 SubjectUserID 扩展,定向帧在 publisher 侧实现;若不批准,忽略
   subject 字段即可(房间帧语义自足,仅私有频道新增成员的定向提示缺失)。
3. 角色变更的 `channel:authority-updated`(TS 定向帧)属另一事件族,不在本次
   范围;Go 侧已有 `channel_membership_role_events` durable 行可作其事实源。

## 6. 验证(本环境实际执行)

```
go test -count=1 ./internal/channel/          # ok(含既有全部测试)
go test -race -count=1 ./internal/channel/    # ok
go test -count=1 ./tests/acceptance/m4-reference/  # ok
go build ./...                                # ok(GOCACHE 指向临时目录)
```

新增 `internal/channel/publications_test.go`(10 组):
create/rename/no-op/描述/隐私(含 #all 翻转仅 channel:updated)/archive 幂等/
unarchive 幂等/**删除零 intent**;join/重 join/加成员/重加/agent 增删/角色变
更(含 no-op)/leave/删不存在成员/批量同毫秒严格递增;私有频道清空自动软删仅
members-updated;懒 ensure 零 intent;**回滚无残留**(行与意图同亡);
**预算满 fail-closed**(AddHumanTx/JoinChannel/UpdateChannel 均报
ErrBacklogFull 且零持久化);裸 DB 句柄调用自动包事务仍原子;意图行仅引用、
无 payload/凭据形状值。

全量 `go test ./...` 在本沙盒的失败均为环境项:两个需本地端口的真实监听测试
(`legacyweb` socket upgrade、`platform/mail` SMTP)因沙盒 EPERM 禁止 bind 而
失败,与本次变更无关(parent 域);`internal/app` 两次一次性
rooms:joined 超时为集成报告 §8.1 已记载的负载瞬态,复跑 5/5 + 2/2 稳定,且该
测试不创建常规频道、不触及本切片意图。

## 7. 剩余限制

1. dispatcher 未接线前,两个事件族在生产库中会以 unknown-deferred 重试并最终
   park(有告警日志与计数,不阻塞其他发布)——这是集成层既有的显式语义。
2. `channel:authority-updated`(角色变更定向帧)未实现,见 §5.3。
3. joint 频道的投影广播(TS 走 joint projections)不适用:Go 无 joint 变更面。
4. 同值 PATCH 会发 intent(TS 同样无条件发布);若产品要求抑制,需在 UpdateChannel
   增加逐字段相等短路——属行为变更,需另行决定。
