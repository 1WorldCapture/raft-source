# M4 后端兼容性参考测试报告（reference，非验收）

> 本报告位于 `server-go/docs/m4-reference-report.md`（v2，按父层要求从仓库根 docs/
> 移入，原位置文件已删除；审查报告见同目录 `m4-cross-slice-review.md`）。

日期：2026-10-08 · 基线：`bc65213b377a992c381e809c72ba50ca9af367fd` ·
角色：backend compatibility reference（与 `server-go/docs/m4-execution-lock.md` 的分工一致：
本套件只冻结原始 TS 线格式并给父层提供 Go 对照 API；不运行 Go/TS 服务器、Postgres、浏览器；
不修改任何产品代码 / migration / run.mjs；不 commit。）

## 1. 交付物

| 路径 | 内容 |
|---|---|
| `server-go/tests/acceptance/m4-reference/` | 测试套件（11 个模块） |
| `server-go/contracts/m4/*.contract.json`（6 个） | 冻结的线格式契约（字节稳定，可 `--check` 幂等校验） |
| `server-go/contracts/m4/README.md` | 父层集成文档（样本 schema、digest 算法） |
| `docs/m4-reference-report.md` | 本报告 |

入口：

```bash
node server-go/tests/acceptance/m4-reference/run.mjs            # 执行 + 重新生成契约 + 自测
node server-go/tests/acceptance/m4-reference/run.mjs --check    # 断言契约未被改动（幂等）
node server-go/tests/acceptance/m4-reference/run.mjs --verify go-samples.json   # 真实 Go wire 对照
```

实际运行输出（本机 Node v26.3.0，无 TS server / Postgres / 网络 / 浏览器）：

```text
PASS M4 reference: 6 suites (5 executing original code), 155 assertions,
6 contract fixtures in server-go/contracts/m4 (baseline bc65213);
verify API self-test 17/23 pass + 6 drifted-sample rejects
```

## 2. 执行了哪些"原始代码"（全部 SHA-256 钉死在 `pinned-sources.mjs`）

沿用 M2 reference 测试（`workspaces-reference.mjs`）的既定做法：从钉死的原始字节中按唯一
marker 抽取**连续**纯函数段，用 Node 官方 type stripper（`node:module` 的
`stripTypeScriptTypes`，strip 模式）去类型，仅做机械化的 `export ` 前缀移除与**单行运行时
import 改写**（改写目标本身也是已执行的原始模块，且每次改写断言恰好命中一次），在独立 vm
中执行。没有任何手写重实现。

| 原始文件（@bc65213） | 执行内容 | 方式 |
|---|---|---|
| `packages/server/src/routes/messages.ts` | `parseHumanMessageCreateBody`、`parseRandomId`、`parseStructuredMentions`、`parseReactionEmoji`、`parseReactionActorPageLimit`、`parseMessagePageCursor`、常量（32000/128/16/UUID_RE） | 两段连续抽取（L57–127、L465–484），strip 执行 |
| `packages/server/src/routes/channels.ts` | `parseChannelVisibility`、`normalizeStringList` | 连续段（L547–564）strip 执行 |
| `packages/server/src/routes/readMutations.ts` | `parsePayload`（read admission 解析器） | 连续段 + 真 `ReadMutationError` 类（见 §5 说明） |
| `packages/server/src/services/readMutationSequencer.ts` | `ReadMutationError` 类 | 连续段，**官方 TS transpile**（工作区自带 typescript@5.9.3；构造器参数属性是 strip 模式拒绝的语法） |
| `packages/server/src/services/messageRealtimeEvents.ts` | `projectMessageSocketPayload`、`projectRichMessageSocketPayload`（socket allowlist + storage-only 封条） | 整文件（仅 type import），strip 执行 |
| `packages/shared/src/canonicalMessageManifest.ts` | `CANONICAL_MESSAGE_MANIFEST` v5、mergePolicy/presence 矩阵、omission ledger、`canonicalMessageManifestJson()` | 整文件 strip 执行 |
| `packages/shared/src/activityMute.ts` | `channelTypeSupportsActivityMute`、支持类型表 | 整文件 strip 执行 |
| `packages/shared/src/index.ts` | `NAME_REGEX/NAME_MIN_LENGTH/NAME_MAX_LENGTH`、`validateNameReason`、`validateName` | 连续段（L3488–3548）strip 执行 |
| `packages/sync-core/src/uint64.ts` | `isUInt64String`、`compareUInt64String` | 整文件 strip 执行 |
| `packages/sync-core/src/violations.ts` + `core.ts` | `createSyncViolationBuffer`、`createSyncCore`（完整确定性内核） | 整文件；core 的唯一运行时 import 接到已执行的 violations |
| `packages/sync-core/src/domains/activity.ts` | Activity 纯 reducer 全量（fold/tombstone/readState/快照投影/fingerprint） | 整文件；uint64 import 接到已执行的 uint64 |
| `packages/sync-core/contracts/activity-v1/runner/runBehaviorVectors.ts` | `canonicalJson`、`sha256Hex`、`exactSeq`、`scopeIdOf`、`applyStep`、`runCase`、`SEQUENCED_INGRESS_BRANCHES` | 连续段（L37–214）执行；依赖注入已执行的 core/domain + node:crypto |
| `packages/sync-core/contracts/activity-v1/generated/json-schema/activity-sync.schema.json` | 生成的 JSON Schema 本体 | 由真实 ajv 8.17.1（工作区 `packages/sync-core` 依赖，与契约包自己的 verifier 同源）加载校验 |
| `packages/web/src/store/messageStore.ts` | `compareMessagesForDisplay`、`sortBySeq` | 连续段（L603–627）strip 执行 |
| `packages/web/src/store/messageSyncDomain.ts` | `mergeCanonicalMessageProjection`、`applyMessageNew/Updated`、`applyMessageDomainEvent` | 连续段（L25–148）；manifest 与 sortBySeq 均为已执行原始代码注入 |
| `packages/web/src/store/readReceiptDomain.ts` | 全部 6 个纯函数（零 import 文件） | 整文件执行 |
| `packages/web/src/store/channelDomain.ts` | mute/display prefs normalizer、stale-version 守卫、`toChannel`、DM hydrate/patch/refresh、`canToggleActivityMute` | 整文件；唯一 import 接到已执行的 shared activityMute |
| `packages/web/src/store/readStateSync.ts` | `normalizeReadStateUpdated(Bulk)`、`consumeReadStateUpdate/Snapshot(Rows)`、ledger 读取族 | 连续段（L33–427）；uint64 wiring 以段前注入（原 import 行钉在文件内、断言唯一） |
| `packages/web/src/store/notificationPrefsSyncDomain.ts` | `applyNotificationPrefsDomainEvent`、`scopeIdForNotificationPrefsUpdate`、`sameNotificationPrefsUpdate` | 三段连续抽取合并执行 |

所有被消费的原始行为向量 / 契约向量（`activity-sync.behavior.jsonl`、
`activity-sync.contract-vectors.jsonl`）逐字节 SHA-256 校验且与契约包 `manifest.json` 中冻结的
digest 一致。

## 3. 冻结结果（六份契约的关键事实）

- **messages-wire**：16 个 create-body 边界、8 个 randomId、20 个 mentions（含
  trim 去重、`type:id:name` 精确键、128 上限）、10 个分页 cursor（**注意：原解析器接受
  `"01"` 为游标 1**，Go 不得"修正"）、9 个 reaction emoji / 9 个 actors limit；v1 裸行 vs
  v2 `{message,…}` 信封、六条错误字面量（从钉死字节机械提取，非手抄）。
- **canonical-message**：manifest v5（10 canonicalRequired + 10 optionalAggregate）、
  `commentRef=shared-null-preserve` 且仅在 enrichedUpdated 出现、`conversationContext`
  仅 messageNew；socket 19 键 allowlist（含条件 `taskAssigneeName`）；
  `projectRichMessageSocketPayload` 封掉 `agentSendKey/searchText/searchVector/senderHandle`；
  合并 fold 实证：共享面 commentRef:null **不清除**、present-empty 清除、absent 保留、
  no-op 状态引用恒等；展示序 seq 优先、缺 seq 回落 createdAt/id。
- **history-coverage**（source-derived，见 §5）：11 个边界场景，包括"空 channel 的 latest
  空页依然 `completeThroughLatest=true`"、"before 空页 `coveredAfterSeq=channel max`"、
  "跨 channel 全局 seq 空洞不是本地 gap"；`messageWindow` 信封
  （`receiver_visible_messages_v1`）与 by-sender `{messages,hasMore}`（明确非窗口）区分。
- **readstate-prefs-wire**：read mutation 四种 kind + 两类错误码 + 409/404/400 映射
  （并如实记录 `throughSeq/scopeId` 是 TS 直通 cast，Go 必须自行强类型）；read-state
  ingress ledger（stale/cleared/corrupt/accepted/supersededBySocket；`"01"`、超过
  2^53 → corrupt）；read receipts（peers/summary 双形态、seq 升 count 降阶梯、
  max-watermark 合并）；mute/display/notification prefs（stale prefsVersion 守卫、
  dm/thread 无 mute 面、scopeId 推导、同值 no-op 恒等）。
- **thread-dm-wire**：visibility 解析（缺省=public）、invite 名单去重/上限抛错、共享名校验
  （Unicode 首字母、32 上限、pattern）；DM/thread 路由错误字面量与校验顺序（access 先于
  嵌套 thread 形状披露）；Web DM 域 fold（`readState`/`lastMessageAt` wire-only 丢弃、
  local-only DM 保留、DM upsert 不入 channel 列表）。
- **activity-v1**：uint64 边界（`00/01/-1/+1/空串/空白/0x1/数字` 拒收；2^53 相邻与
  u64 全域比较）；18 条冻结契约向量经真实 ajv 重放全数命中期望；14 条自定边界
  （含 sealed 分支多余键拒收、`nextFromSeq` 可空可零、`markThreadDone` 的 `"0"` 拒收）；
  8 条冻结行为向量用**原始 runner** 重放并首次记录聚合 digest：
  `d43b3da565b81306b3ef5338ed50f432dfd84a66c7db050b8405af51078a236d`
  （契约包 manifest 的 `canonicalBehaviorResultSha256` 为 null，本冻结为首个记录）；
  33 步自定 reducer 序列覆盖：stale 同 epoch 快照（version_regression + 不回滚）、
  contiguous 无基线帧 stop-gate、帧间隙 difference 请求、同 seq 同指纹=重复 vs 异指纹=
  producer_version_conflict、tombstone 单调与复活、readStateUpdated 版本寄存器、
  2^53 精确相邻与真间隙、跨 epoch 重基线、unknown 事件全等、缺字段行被 isRow 丢弃。
  **如实冻结的 runnerProtocol-1 事实**：`applyStep` 的 difference 分支不把 `hasMore` 映射为
  core 的 `partial`——hasMore 页按完整差分折叠；Go 侧以相同输入对照时必须与此行为一致而非
  OpenAPI 文案。

## 4. 集成 API（父层喂真实 Go wire 的入口）

`verify-go-wire.mjs` 导出 `verifyGoWireSamples(samples)` 并提供 CLI；12 个 area
（create body / DTO 面 / 分页信封 / coverage 场景 / read mutation / read state 事件 /
receipt hydrate·scope / mute·eligibility / activity ingress·uint64 / reducer 差分 digest）。
判定全部通过**当场重新执行原始代码**完成，而不是查表。样本格式见
`server-go/contracts/m4/README.md`。

自测（`selftest-verify.mjs`，样例显式命名 `selftest-*`，只证明判别力、不冒充 Go 证据）：
23 个样例 = 17 个正确线格式全 pass + 6 个故意漂移样例（v1 错包信封、enrichedUpdated 带上下文、
sealed 键泄漏、coverage 漂移、schema 误收、reducer digest 漂移）全部 fail。

## 5. 未执行 / 诚实边界

1. **history-coverage 为 source-derived**：`listMessagesWithCoverage` 在 repeatable-read
   事务里走 drizzle/PostgreSQL，离开原服务器无法诚实执行。11 个边界场景逐行锚定钉死函数
   （函数段独立 SHA-256 记录在契约内），真实 Go coverage 只能经 `--verify` 对照。
2. **路由处理器字面量为提取而非执行**：v1/v2 信封、DM/thread/创建频道错误串与校验顺序，
   从钉死字节机械提取（带行号锚）；express/DB 处理器本身不可执行。
3. **`ReadMutationError` 用官方 TS transpile**：构造器参数属性是 Node strip 模式拒绝的语法；
   使用工作区自带 typescript@5.9.3 的 `transpileModule`（官方编译器、原始字节、零手编）。
4. **vm 依赖注入清单**（全部为已执行原始代码或 Node 内建）：core←violations、activity←uint64、
   messageSyncDomain←manifest+sortBySeq、channelDomain←sharedActivityMute、readStateSync←uint64、
   activityRunner←core+activityDomain+node:crypto、ajv/typescript←工作区依赖。无任何手写替身。
5. **延后到父层的事项**：真实 Go wire 样本尚未存在——所有 Go 对照（HTTP 状态/错误体/DTO/
   coverage/reducer digest）只能等父层按 README 格式投喂；本套件不对此作任何断言。
   UI/浏览器测试按约定完全保留给另一位测试者，本套件零 React/DOM 依赖。
6. 本套件未触碰：产品 Go/TS/Web/CLI 代码、migrations、共享 `run.mjs`、lockfile、var*/数据、
   git 提交。写入范围仅 `m4-reference*`、`contracts/m4/**`、本报告。

## 6. 复核清单

- [x] 契约字节稳定：`run.mjs` 与 `run.mjs --check` 双跑通过（无时间戳、键排序固定）
- [x] 全部 24 个原始源文件 SHA-256 与 `bc65213` 工作区一致；行为/契约向量 digest 与契约包
      manifest 冻结值一致
- [x] 判别力自测：6 个漂移样例全部被拒
- [ ] （父层）真实 Go wire 样本经 `--verify` 全量通过 —— 尚未发生，本报告不作该声明

## 附录（2026-10-08 跨切片审查后增强）

配合 `server-go/docs/m4-cross-slice-review.md`（v2），verifier 新增三个拒收面（只改 m4-reference 与
contracts/m4）：

- `reaction.viewerVersion.stream` — 按 pinned 原始 reducer（reactionReadModels.ts:387-401）
  冻结的数值规则，拒收版本回退（stale）与同版本异 payload（conflict）的 Go wire；
  hash 派生版本（add/remove/add 重复或回退）必然被拒。契约
  `reaction-versions.contract.json` 同时冻结了干净计数器轨迹与两条 hash 漂移形状。
- `read.state.stream` — 执行原始 read-state ledger 对多事件流（含晚到的低版本重复写、
  unread 回退、corrupt 载荷）逐步裁定；Go 的每步 accepted/stale/corrupt 与最终有效
  frontier 必须一致（readstate-prefs 契约 `readStateStream`，8 步真实日场景）。
- `activity.stream.digest` — 冻结一条"快照→新消息帧→已读推进→Done 墓碑→差量重放"
  真实流（`activity-v1.contract.json` `executed.actualStream`），Go 用同输入折叠后对
  canonical digest；Go 侧无需自造输入。

自我判别：self-test 现 29 例（20 正确通过 + 9 漂移全拒，新增 4 个新 area 正/负例）。
真实 Go parity 仍未标记通过——等待父层按 README 投喂真实样本。套件全量：
`node server-go/tests/acceptance/m4-reference/run.mjs` →
`PASS M4 reference: 7 suites (6 executing original code), 173 assertions, 7 contract fixtures`。

## 附录 B（v2.1）：in-process Go 真实 wire 采集

入口：`node server-go/tests/acceptance/m4-reference/run.mjs --go-wire`
（也可直接 `node server-go/tests/acceptance/m4-reference/go-wire-export.mjs`）。

`go_wire_export_test.go`（owned reference area，package m4reference）在
`t.TempDir()` 的隔离迁移 SQLite 上，经**产品公共 API** 驱动真实流并把单文档 JSON
打印到 stdout marker；node 侧采集后用**原始 TS 执行**验证。无 TCP、无 router、
无 live 数据、无 schema/主仓库改动。

当前结果（证据 `server-go/contracts/m4/go-wire-samples.json`，随每次运行刷新）：

| 检查 | 结果 |
|---|---|
| reaction viewer 版本流（真实 add/remove/add/幂等/双用户，v1→v5） | 严格递增、幂等不 bump —— message worker 的持久计数修复被**真实执行**回归验证 |
| discussion 版本探测 | 非回退 |
| read-state 变更流喂原始 ledger | 全部 accepted，最终 frontier 一致 |
| 5 个真实 Activity body 过生成的 JSON Schema（ajv） | 全部通过（snapshot ×2 / difference / notModified ×2，含 Done tombstone） |
| 真实 difference rows/tombstones 过原始 reducer（ingestDifference 同 runner 映射） | 全部进入 state，rowVersion 不被 fold 改写 |

边界与诚实声明：这是 store 公共 API 层 + handler 同形状序列化；`accessClaimsContextKey`
未导出使外部包无法注入 httptest claims，legacyweb JSON 编码与真 HTTP 由父层单独运行。
真实 Go HTTP parity 不在本报告主张范围内。
