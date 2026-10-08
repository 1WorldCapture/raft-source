# M4 后端真进程验收与 M3 升级测试 — worker 交付报告

日期:2026-10-08。执行者:后端验收测试 worker(仅拥有下列三个文件)。状态:**测试已交付、语法与导入已验证;真实进程执行被两个外部条件阻塞**(见 §6),本文不声称任何 M4 套件通过。本报告是执行记录,不是验收结论;按 `m4-implementation-coordination.md` §8 模板撰写。

## 1. 目标与实际范围

| 目标 | 实际交付 |
|---|---|
| M4 后端真进程验收套件(真实 HTTP + 真实进程,动态端口 + 一次性数据目录) | `tests/acceptance/m4-backend.mjs`(16 组检查,导出 `verifyM4Backend`) |
| M3→M4 升级/旧版拒绝/冷备恢复测试(两个冻结 M3 起点) | `tests/acceptance/m3-to-m4-upgrade.mjs`(导出 `verifyM3ToM4Upgrade`) |
| 验收记录 | 本报告 |

明确不做:浏览器/UI 测试(用户另派专人);Socket.IO live 事件(P3 spike/协议 suite 的范围);发送限流套件(`m4-message-rate-limit`);撤权窗口 failpoint(P6)。本套件的发送量刻意控制在每用户 ≤ ~26 次写入,远低于冻结合同的 60 次/60 秒共享桶,避免误触限流。

## 2. 修改/新增文件(所有权之内)

| 文件 | 性质 |
|---|---|
| `server-go/tests/acceptance/m4-backend.mjs` | 新增,仅此 worker 所有 |
| `server-go/tests/acceptance/m3-to-m4-upgrade.mjs` | 新增,仅此 worker 所有 |
| `server-go/docs/m4-acceptance-worker-report.md` | 新增,本报告 |

未触碰:`tests/acceptance/run.mjs`、`internal/app/**`、`routes.go`、各 worker 模块、`packages/**`、lockfile、`var*`/`var-m3-dev`/`var-backup-m2-*` 现场数据、既有截图与报告。无 commit/push/重启。

## 3. 导出函数与可执行命令

```js
// tests/acceptance/m4-backend.mjs
verifyM4Backend({ origin, data, start, stop, capture, executable, env })
// origin: 已就绪实例的 http://127.0.0.1:<动态端口>
// data:   一次性数据目录(套件读取 data/outbox 私有信箱完成真实注册验证)
// start/stop: 可选;提供时执行第 16 组"重启持久化"检查,否则打印 SKIP 行
// capture/executable/env: 透传 run.mjs 既有能力,当前套件不依赖

// tests/acceptance/m3-to-m4-upgrade.mjs
verifyM3ToM4Upgrade({ executable, capture })
// executable: 当前树构建的 M4 二进制(run.mjs 已构建的那一个)
// capture:    run.mjs 的 (program, args, {timeout, env, cwd}) => {code, stdout, stderr}
```

独立执行(一次性数据、动态端口、结束即清理,不碰现场):

```bash
cd server-go
node tests/acceptance/m4-backend.mjs          # 独立构建+起服+跑 16 组检查
node tests/acceptance/m3-to-m4-upgrade.mjs    # 独立构建当前树,再对两个冻结 M3 起点跑升级矩阵
```

**需要集成人接线(run.mjs 由 parent 所有,本 worker 未改)**:

```js
import { verifyM4Backend } from './m4-backend.mjs';
import { verifyM3ToM4Upgrade } from './m3-to-m4-upgrade.mjs';
// suite 白名单追加 'm4-backend';套件循环里:
//   await start(); await verifyM4Backend({ origin, data, start, stop, capture, executable, env }); await stop();
// 'upgrade' 套件追加: await verifyM3ToM4Upgrade({ executable, capture });
```

## 4. 覆盖矩阵(检查组 → 冻结合同依据)

| # | 检查组 | 合同依据(文档/原 TS 源) |
|---|---|---|
| 1 | v2 发送 envelope、canonical 必需字段、**原 Web fold 接受真实 wire** | compat §2/§3.2;`canonicalMessageManifest.ts:96-133`;`messageSyncDomain.ts` messageNewFrame;经 `m4-reference/exec-original.mjs` 执行原始 sync-core |
| 2 | v1 裸 DTO 别名 + 冻结的 body/randomId/cursor 校验文本 + asTask/附件提交前 501 | `messages.ts:1663-1691, 89-94, 478-484`;compat §3.1/§5 |
| 3 | randomId 跨 v1/v2 幂等、同键异内容/异频道/跨空间 409 `random_id_conflict` 且不回读原消息、异发送者可用同键、并发同键恰一行 | `messageService.ts:1202-1210, 2378-2438`;compat §3.1 |
| 4 | 工作空间/未加入/私有频道/移除成员(403 prior-relationship vs 404 never-member)隔离,覆盖发送、历史、全局 sync | `messages.ts:1695-1705`;`channelAccessDenial.ts:67-77`;phase-4 §8.1 |
| 5 | 真实人类 mention:目录身份投影(客户端 name 不冒充)、unread/hasMention 投影、Agent mention 整体 501、混合请求不部分接受、无效目标显式拒绝 | compat §3.1;readstate §3(mentions 表约束) |
| 6 | self-DM(单 roster 行语义)与两个人类 DM:双向 ensure 同一 channel、参与者可见性、agentId 分支 501 不建会话、非成员目标 400、own-send 不产生未读 | phase-4 §4.1;`channels.ts:674-747`;`channelService.ts:3712-3811` |
| 7 | 线程:ensure+首条回复、父消息 `threadId=threadChannelId`、回复 `channelId=thread`/`threadId=null`、真实 replyCount/participantIds、嵌套 400、authored/replied 自动关注、**unfollow 后 history 仍可读 vs 关注列表移除** | compat §2/§3.2;`channels.ts:3979-4178`;readstate §1(三个层面分开) |
| 8 | reaction:幂等 add/remove、聚合计数、私有 viewer snapshot(`{serverId,messageId,viewerVersion,reactedEmojis}`)、actors envelope、非法 emoji 400 | `messages.ts:1873-2127`;`messageReactionService.ts:224-235` |
| 9 | 分页/覆盖:schemaVersion/domain/scopeId 精确、`coveredAfterSeq`=频道内真实前驱(跨频道 seq 空洞下)、before/after 保守 hasNewer/非 completeThroughLatest、空页 `coveredFromSeq=H+1/coveredThroughSeq=H`、sync 裸数组分页无重无漏、全局 sync 兴趣过滤(未关注线程不进流) | compat §3.3/§3.4;`messageService.ts:6400+,6564+` |
| 10 | read/unread/read-all:`{ok,maxReadSeq,readStateVersion}` / unread 四键 / read-all 的 `seq` 键、伪造超大 seq 被钳制、标未读后 wire maxReadSeq 回退+版本前进、inbox read-all `{ok,markedCount,scopes}` | `channels.ts:3789-3974, 1337-1357`;readstate §4.1 |
| 11 | mute/display:默认值、`muteFromSeq=H+1`、版本递增、线程 400 专用文案、DM `activityMuteSupported:false`、**静音例外(mention 仍可见,普通活动被抑制)**、display 独立版本域 | `channels.ts:2338-2445`;`shared/activityMute.ts`;readstate §4.1 |
| 12 | Inbox:envelope 六键、真实 items/计数、filter unread/mentions/unread_mentions/all(含未 Done 未关注线程)、q/channelId/limit/hasMore/sort、跨用户不可见 | `channels.ts:1095-1181`;readstate §2 |
| 13 | Done frontier 四态矩阵(412/400×2/409×2 含数值型非规范十进制与 int4 上限)、`{ok:true}`、done/unfollowed 历史、新活动越 frontier 复活、undone、线程 done/undone、陌生人合并 404 | `channels.ts:1240-1357, 1681-1834`;`inboxSuppressionWriters.ts:49-123`;readstate §4.2 |
| 14 | Activity:snapshot/difference/notModified 三态精确形状(UInt64 规范十进制字符串、scope 五键、window 七键)、**原始 Activity reducer 折叠接受全部真实行**、fromSeq=after+1、rowVersion 前进、409 snapshotRequired(带当前 epoch 且无 type 成员)、畸形 uint64 400、跨主体水位不泄漏、filter 间同行同版本、`/read-mutations*` 授权后 501 | readstate §5;`activitySyncService.ts:865-987`;`activity-v1/activity-sync.tsp` |
| 15 | `GET /api/servers/unread-summary` 无 X-Server-Id literal 路由、真实计数、跨账号隔离 | `servers.ts:775-845`;phase-4 §9 |
| 16 | 重启持久化:消息、mute/display 偏好、Activity epoch+watermark、notModified 判定(需 runner 提供 start/stop) | readstate §5("重启保留水位/epoch");phase-4 §10 |

升级套件(每个冻结起点一轮):

| 步骤 | 依据 |
|---|---|
| `git archive` 冻结 commit → 独立目录构建(`CGO_ENABLED=0`),不触碰工作树 | m2-to-m3 同款流程 |
| 旧二进制经自身 API 生成真实数据:双工作空间+order、公/私有频道、外部 Agent+sk_agent 凭据、device grant+Computer attach、(bc65213)join link 真实接纳第二成员+保留 pending 邮件邀请 | phase-4 §4.3("必须用冻结的 M3 二进制生成旧数据") |
| 断言旧二进制确实无 v2 面(404)后优雅停机、取冷备份 | — |
| 新二进制原位升级:签名密钥逐字节不变、`/api/auth/me` 逐字段一致、servers/order 一致、频道身份/字段保留、Agent 详情+旧凭据 whoami、Computer preflight、(patched)邀请/链接/成员保留、旧 refresh/密码可用 | m2-to-m3 验收口径的 M4 版 |
| 升级后 M4 在迁移数据上真实工作:v2 发送+同 randomId 重放同条、历史恰一行、**空频道诚实空页** | phase-4 §4.3 |
| 旧二进制拒绝 M4 schema(非零退出 + `schema version ... newer than this binary`),数据无损 | db.go 迁移卫兵 |
| 恢复匹配冷备份 → 旧二进制可起、旧会话/频道可读、v2 仍 404(确证回滚到旧面) | phase-4 §4.3 |
| 全程密钥不进日志 | 既有纪律 |

## 5. 依据实际 DTO 源钉死的期望(非猜测清单)

- Message canonical 十字段与 presence:直接执行 pinned `canonicalMessageManifest.ts`(经 `m4-reference/exec-original.mjs` 的 SHA-256 钉版加载),必需字段清单来自原 manifest,非手抄。
- 两组"原消费者接受真实 wire"证据:HTTP message 帧喂入原 Web `createMessagesSyncDomain` 的 sync-core(`ingestFrame`,断言 `applied/max_advanced` 且折叠态含该行);Activity window/difference 帧喂入原 `foldActivityEvent`(断言折叠后行数===wire 行数,即原 `isRow()` 门全部放行)。
- 错误文本逐字取自原 handler:`Channel not found`(create)/`Channel not found or not visible`(history)/`You must join this channel to send messages`/`Cannot create a thread inside a thread`/`Either agentId or userId is required` 等。
- Done 矩阵含"数值型 throughActivitySeq 不是规范十进制字符串 → 400 DONE_FRONTIER_REQUIRED"(原 `parsePositiveCanonicalDecimal` 只收字符串)与 int4 上限 409。
- muteFromSeq = 频道 frontier+1(原 `setInboxTargetActivityMuteState`)。
- 复用了 P0 已交付的 `tests/acceptance/m4-reference/`(pinned-sources + exec-original),未自制平行 runner、未伪造 API。

### 5.1 两个明示的裁量记录(如与集成人 P0 fixture 不一致,以此处为准修订)

1. **无效 mention 目标(非本空间用户)→ 期望 400 且零行落库**。compat §3.1 明文"不允许实施者另行选择'接收后忽略'",故按显式拒绝断言。若 P0 fixture 钉死为其他映射,应改测试并在本报告登记。
2. **未关注线程的 `sync?channel_id=` → 接受 200 空数组或 403/404 任一,但断言零行投递**。冻结合同只钉住"兴趣过滤"不变量,未钉状态码;测试锁定不变量本身,两种合规实现都通过,任何泄漏线程行的实现都失败。

## 6. 实际命令与结果(如实记录)

| 命令 | 结果 |
|---|---|
| `node --check tests/acceptance/m4-backend.mjs` / `m3-to-m4-upgrade.mjs` | **通过**(多次,含补丁后复验) |
| `node -e "import(...)"` 两模块 | **通过**;各导出且仅导出 `verifyM4Backend` / `verifyM3ToM4Upgrade` |
| `loadOriginalModules()` 冒烟(manifest 字段、messages fold `max_advanced`、activity 初始态) | **通过**(P0 fixture 基线未漂移) |
| `git ls-tree d275cce… / bc65213… migrations/` | 确认 0001–0008 / +0009,与升级套件的 invites 分支一致 |
| 构建当前树(`CGO_ENABLED=0 go build ./cmd/raft-server`) | **失败**:`internal/channel/conversation.go:201: s.HasActiveThreadFollowTx undefined(type *Store has no …)`,且 `internal/message` 尚不存在 —— worker 模块仍在集成中,当前树尚非可测的 M4 二进制 |
| 一次性驱动脚本:构建 `bc65213` 旧二进制并运行 `verifyM4Backend` | 构建成功;**被本会话沙箱禁止本地端口绑定(listen EPERM)阻止**。这是执行环境限制,非测试缺陷;套件在纯 M3 二进制上的预期行为是:真实流程 fixture 全部成立、第 1 组在 v2 发送处如实失败(不会伪造通过) |

**当前无法由本 worker 完成真进程执行的两个外部条件**:
1. 集成树可编译(等待 channel/message/readstate worker 的模块与 parent 接线;当前编译错误如上)。
2. 执行环境允许本地监听(本沙箱 `listen 127.0.0.1` 返回 EPERM;用户可在设置中开启 `sandbox.network.allowLocalBinding: true` 后让我复跑,或在正常终端执行 §3 的独立命令)。

升级套件的额外前置:`git archive` 需能读取本仓库两冻结 commit(已验证可读);Go 构建需 module cache(两 commit 依赖均为当前缓存子集)。

## 7. 失败/未测部分(不隐藏)

- 16 组检查 + 升级矩阵**均未在真实 M4 进程上执行**(原因见 §6);本报告不产生任何"PASS M4 …"证据。
- Socket.IO live(message:new/rooms:joined/resume/心跳)、撤权窗口、崩溃 failpoint、限流、2048 条保留边界、多端旧响应乱序、Agent DM 之外的 501 面枚举:不在本套件范围,归属 P3/P6/独立 suite。
- 升级套件不测 Activity 0011 迁移(0011 由 parent 评审 readstate worker 草案后落盘);如 parent 需要,可在 `m4-backend` 套件追加 Activity 重启检查已覆盖的等价面。
- `m4-backend` 第 16 组在无 start/stop 的 runner 下打印 SKIP(不静默跳过)。

## 8. 数据迁移与现场安全

- 两套件所有进程使用 `mkdtemp` 一次性目录 + 动态端口;`finally` 中先优雅停机(12 秒上限后 SIGKILL 兜底)再 `rm -rf`,不触碰 4301/5175、`var*`、`var-m3-dev`、`var-backup-m2-*`、用户会话或截图。
- 升级套件对冻结源只做 `git archive`(只读),绝不 checkout 覆盖工作树。
- 断言密码/令牌/API key 不出现在子进程日志(沿用 m2 升级套件口径);测试自身失败消息只含上下文与状态码,不倾倒响应体。
- 环境变量最小集(`PATH/HOME/TMPDIR` + `RAFT_GO_LISTEN/DATA_DIR/WEB_ORIGIN/MAIL_MODE=outbox`),不继承 `RAFT_GO_*` 测试开关,避免误开 gate。

## 9. 需要集成人接线的动作

1. 在 `tests/acceptance/run.mjs` 按 §3 片段登记 `m4-backend` suite 并在 `upgrade` suite 追加 `verifyM3ToM4Upgrade`(文件所有权在 parent)。
2. 集成完成后先跑独立命令复核,再进 run.mjs 全量;两套件对当前 M3 行为会如实失败(404/501 面),这是刻意的 fail-closed 设计。
3. 若 §5.1 两条裁量与最终 P0 fixture 冲突,以 fixture 修订测试并在本报告登记差异。

## 10. 下一步负责人的明确动作

- parent:完成 worker 模块接线与 0011 落盘 → 构建通过 → 按 §3 执行两套件 → 将真实输出(命令+结果)回填本报告 §6,或以 phase-4-backend-handoff 汇总。
- 任一断言失败时:先判定是实现缺口还是测试期望与 fixture 的偏差(优先查 §5.1 两条),不允许为通过而放宽断言。
