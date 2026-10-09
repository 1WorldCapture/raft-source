# M5 迁移验收 Worker 报告（Worker F）

- 日期：2026-10-09（America/Los_Angeles）
- 责任人：F / 迁移验收 worker（[m5-execution-lock.md](m5-execution-lock.md)）
- 输入：[phase-5-delivery.md](phase-5-delivery.md) §12、[m5-implementation-coordination.md](m5-implementation-coordination.md) §5“升级与回退”、[m5-delivery-worker-contract.md](m5-delivery-worker-contract.md)（A 已冻结 0014 schema）、现有 `tests/acceptance/client-contracts.mjs`、`m3-to-m4-upgrade.mjs`、`stabilization-rollback.mjs`、Makefile/run.mjs。
- 所有权遵守：只新增/修改本 worker 文件；未改 Makefile、run.mjs、app/生产代码、原 manifest、0001–0013、旧 golden、var*/ 运行实例。未 commit/push，未委派。

## 1. 交付物

| 文件 | 状态 | 内容 |
|---|---|---|
| `contracts/client/migration-additions.json` | 新增 | 冻结集（0001–0013）之后的**显式增量迁移索引**：逐条登记精确文件名+sha256+字节数+来源契约文档；`frozenThrough` 钉住冻结尾；无任何通配/区间/未来文件自动放行 |
| `tests/acceptance/client-contracts.mjs` | 扩展（原有检查全保留） | integrity checker 支持 additions 索引：冻结集∪additions 与目录双向精确清点；additions 校验（shape/路径逃逸/重复/与冻结集重叠/排序/出处）+ hash 比对；git 基线比对**仍仅针对冻结集与冻结 fixture**（增量迁移产生于基线之后，additions 文件即其权威）；自测新增 11 例（含 1 正例），旧 21 例全保留 |
| `tests/acceptance/m5-upgrade.mjs` | 新增 | 真实进程 M4(336b5c8)→当前 M5 就地升级验收；导出 `verifyM4ToM5Upgrade({executable, capture})` 供父 run.mjs 装配；可独立运行 |
| `internal/platform/db/m5_upgrade_test.go` | 新增 | DB 层 M4→M5 升级评审套件（6 个测试，详见 §4） |
| `docs/m5-upgrade-worker-report.md` | 新增 | 本报告 |

## 2. 新增迁移登记记录与哈希复查

- `0014_delivery.sql` 于本日 14:34 由 worker A 落地，其契约文档明示“迁移 0014（已冻结）”。
- 登记内容（`migration-additions.json`）：
  - `file: 0014_delivery.sql`，`sha256: 3a86db7305ae0a3e48ae23d0ec02126501c87b8a8f7e81b75bd546f8cfe02319`，`bytes: 11078`，`introducedBy: docs/m5-delivery-worker-contract.md`。
- **报告前复查**（任务要求的 recheck）：文件 mtime 仍为 14:34:11、哈希与登记一致（见 §5 复查命令输出）。登记期间 A 未再修改该文件。
- 后续规程：A 如需再改 0014，`make test-client-contracts` 将立即以 `migration-hash-drift` 失败；更新 additions 属评审后的人工动作（更新 hash/bytes 并复跑 checker），checker 不提供写回模式。任何“既不在冻结 manifest 又不在 additions 的 .sql”都以 `migration-inventory` 失败——不存在宽容通道。

## 3. checker 扩展设计要点

- 冻结不变量不放松：0001–0013 仍同时对照 manifest、工作区与 git 基线（6ffc168）三方；0011 溯源引用等旧检查原样保留；旧自测 21 例全部通过。
- additions 语义：
  - `frozenThrough` 必须等于冻结 manifest 最后一项（0013）；
  - 增量文件名必须是裸 `NNNN_lower_snake.sql`（`additions-path-escape`），严格按字典序排在冻结尾之后且不得与冻结集重复（`additions-frozen-overlap`）、条目内不得重复（`additions-duplicate`）、必须严格递增；
  - 每条必须有合法 sha256/bytes 与 `introducedBy` 出处（`additions-shape`）；
  - 磁盘=冻结集∪additions 的**双向精确等式**（`migration-inventory`），`expectedCount` 双侧核对；
  - 增量文件 hash/bytes 对照 additions（`migration-hash-drift`）；
  - additions 文件缺失即失败（它是冻结契约的一部分，不是可选文件）。
- 新自测 11 例：`additions-registered-passes`（正例）、`additions-tampered`→migration-hash-drift、`additions-unregistered-extra`→migration-inventory、`additions-registered-removed`→migration-inventory、`additions-path-escape`、`additions-path-subdir`→additions-path-escape、`additions-duplicate`、`additions-frozen-overlap`、`additions-shape-bad-hash`、`additions-shape-misordered`→additions-shape、`additions-manifest-deleted`→additions-shape。全部在系统临时目录的一次性工作区内执行，真实树零写入。

## 4. DB 层 M4→M5 升级评审（internal/platform/db/m5_upgrade_test.go）

与 M2/M3 评审套件同一模式：逐字应用冻结 0001–0013 + `schema_migrations` 恰好记录 13 项（冻结 M4 二进制 migrate() 留下的状态），按真实 M4 writer 形态播种（会话族/轮换 lineage/封存回执、频道/线程/DM、messages 的 random_id 幂等摘要、人类 mention、reaction 版本计数、publication、readstate 全套、activity 窗口、machine/computer/agent + argon2 凭据哈希；0012 触发器随播种真实生效）。

| 测试 | 断言 |
|---|---|
| `TestM5FrozenM4ChainIsAnUntouchedPrefix` | 恒跑（无需 0014）：0001–0013 恰为目录排序前缀，其后文件严格晚于冻结尾——杜绝重编号/中插 |
| `TestM5UpgradePreservesEveryM4RowAndColumn` | `store.Open` 就地升级后全部 M4 表 dump 逐字节相等；密码可验证、refresh token 可解析、`MAX(seq)`=3、读边界=1；FK/integrity 干净 |
| `TestM5UpgradeChangesAreAdditiveAndDocumented` | 无表/列/FK/索引丢失或重定义；既有行新列必须 NULL/默认值；新表必须为空（0014 契约声明零回填，白名单当前为空集） |
| `TestM5UnconfirmedDeliveryIntentsSurviveReopen` | **未确认投递的持久层重启恢复**（phase-5 §12）：按 A 契约 §1 精确播种（pending+managed in-flight occurrence、leased+external claim 绑定）→ Close → 重开 → 四张 delivery 表逐字节相等、状态/重试预算/下次尝试时间/身份快照/未 ACK 事实不变；重开后可继续写入（delivery_order 前进）且唯一约束仍生效；列集钉死契约，漂移即带 diff 失败 |
| `TestM5UpgradeFailureRollsBackAndRetryUpgrades` | 注入 0014 记录失败 → Open 失败、M4 dump 逐字节不变、未记录；清障后重试升级干净 |
| `TestM5RepeatedOpenIsIdempotent` | 二次 Open 不重录、不改 M4 数据、不动已写 delivery 行 |

需要 0014+ 的阶段带显式 skip 消息（`m5SkipUntilM5Lands`），0014 已落地，全部实际执行。

## 5. 已执行命令与精确结果

| 命令 | 结果 |
|---|---|
| `node tests/acceptance/client-contracts.mjs` | **PASS**：selftest 32/32（旧 21+新 11）；真实校验 `12 frozen fixtures + 13 frozen migrations + 1 registered additions verified`（冻结集 git-baseline vs 6ffc168；additions 由 migration-additions.json 钉住），exit 0 |
| `node --check tests/acceptance/m5-upgrade.mjs` + 模块导入/检测验证 | OK：`verifyM4ToM5Upgrade` 导出、`FROZEN_M4_COMMIT=336b5c8`、磁盘 14 个迁移（13 冻结+0014_delivery.sql） |
| `go test -count=1 ./internal/platform/db/` | **ok**（14.3s）：含既有 m2/m3 全部套件 + 新 M5 六测 |
| `go test -count=1 -run 'TestM5' ./internal/platform/db/` | **ok** |
| `go vet ./internal/platform/db/` | ok；`gofmt -l internal/platform/db/` 无输出 |
| `go test -count=1 ./tests/architecture/` | **FAIL**，但唯一失败 `TestHTTPRouteManifestCoversActualMounts` 的 7 条全部指向 worker D 正在落地的 `agentapi/handlers.go` 新路由（send/events/claim/ack/resolve-channel/history/v2/send 未入父执行者的 route manifest）——与本 worker 文件无关，证据：失败清单仅含 agentapi 路径 |
| `shasum -a 256 internal/platform/db/migrations/0014_delivery.sql`（报告前复查） | `3a86db…2319`，与登记一致；mtime 14:34:11 未变 |
| `node tests/acceptance/m5-upgrade.mjs`（独立全链路） | **本会话无法执行**：沙箱禁止本地端口绑定（`listen EPERM 127.0.0.1`；会话级 `sandbox.network.allowLocalBinding` 未开启，属用户设置）。该测试自身不含任何已知失败；逻辑经导入验证 + 与两套已验证套件（m3-to-m4-upgrade / stabilization-rollback）同构。执行命令见 §6 |

未执行 `make check` 全量：工作树含 A–D 并行进行中的改动（如上架构门禁失败即其例），全量 gate 由父执行者收口时运行。

## 6. m5-upgrade.mjs 运行方式与父执行者装配

独立运行（临时数据 + 动态端口，不触碰 var*/运行实例）：

```sh
cd server-go
node tests/acceptance/m5-upgrade.mjs
```

父装配（run.mjs 与 Makefile 均为父执行者所有，此处仅为建议 patch，本 worker 未改动）：

```js
// tests/acceptance/run.mjs
import { verifyM4ToM5Upgrade } from './m5-upgrade.mjs';
// knownSuites 增加 'm5-upgrade'；在 stabilization-rollback 分支旁：
if (selectedSuite === 'all' || selectedSuite === 'm5-upgrade') {
  await verifyM4ToM5Upgrade({ executable, capture });
}
```

```make
# Makefile（可选）
test-m5-upgrade:
	RAFT_GO_TEST_SUITE=m5-upgrade $(NODE) tests/acceptance/run.mjs
```

套件阶段（全部真实进程、真实 API）：
1. `git archive 336b5c8` 独立构建冻结 M4 二进制；
2. 冻结二进制经自身 HTTP API 造真实数据（账号/工作空间/join/频道/消息+reactions/线程/DM/读边界/通知与显示偏好/Agent 凭据/Computer attach/待处理邀请），快照 13 个持久化视图；
3. 冷备（优雅停机后复制）；
4. 当前可执行文件**就地升级**：JWT key 逐字节一致、13 视图逐字节相等（key/session/message.seq/readstate 完整性）、refresh/login 存活、randomId 幂等重放同 id 同 seq、在迁移数据上继续写入（seq 前进）；
5. 服务端重启（stop/start）：全部视图与凭据仍稳定——升级后持久状态非内存态；
6. 冻结 M4 二进制对新 schema **fail-closed 拒绝**（断言 `schema version … newer than this binary` 守卫信息）；
7. 匹配冷备恢复 → 旧二进制可服务原视图并**恢复写入**（新消息 200 + 幂等重放不重复）；
8. M5 HTTP 投递面探针（`/internal/agent-api/send|events|events/claim|events/ack` 等）真实探测并**如实打印**当前状态码，不伪造；
9. 全程凭据不入日志断言。

前置硬门槛：磁盘必须存在晚于 0013 的迁移，否则套件**响亮失败**而非静默空转。

## 7. stabilization-rollback.mjs 必需适配（已检查，未改动、未禁用）

该套件按“本轮稳定化零 schema 变更”设计：末段让冻结 M4 二进制（6ffc168）**读取并继续写入**新二进制处理过的数据。0014 落地后该前提不再成立：`migrate()` 的 fail-closed 守卫会使旧进程启动即退出，`start(oldBinary, workingData)`（`tests/acceptance/stabilization-rollback.mjs:419`）抛出 "Owned rollback server exited before readiness"。这是**设计内**行为（phase-5 §12：旧程序拒绝新 schema、以明确拒绝+可验证恢复为准），不是测试 bug。必需适配（父执行者执行，文件为共享文件）：

1. 第 419–431 行“旧二进制读全部新写 + 识别新幂等摘要 + 继续写入”整段替换为**拒绝始终断言**：`capture(oldBinary, [], { cwd: dir, env })` 非零退出且输出匹配 `/schema version.*newer than this binary/`（与 m5-upgrade.mjs 第 6 阶段一致）；
2. `routesAfter`（第 416 行采集、422 行对比）依赖旧进程可运行，随上一条一并移出该上下文（冷备恢复块内的 routesBefore 对比不受影响）；
3. 第 427–430 行的“恢复后继续写入”证明移入**冷备恢复块**（第 434–438 行保留）：在恢复的旧实例上真实发一条新消息并断言 200——m5-upgrade.mjs 第 7 阶段已实现同型断言可作参照；
4. `--baseline-only` 自检（旧对旧）不受影响；
5. 适配后 `SUITE=all` 才能回绿：当前 `make check`/`test-http-all` 中该套件必红（0014 已在磁盘），这正是零 schema 假设失效的准确信号。

m3-to-m4-upgrade.mjs 经审查不受 0014 影响：其旧进程仅在冷备恢复后启动，中间步骤只以当前二进制升级 + 断言旧二进制拒绝（原本就断言拒绝，现在更早成立）。

## 8. 诚实边界与未完成项

1. **pending delivery 持久性的分层**：DB 层保证（未确认 intent/occurrence/claim 重启恢复）已实现并执行（§4）。HTTP 层端到端（picker mention→intent→Daemon wire→重启恢复）依赖 B/C/D 的 S2–S4 面；本 worker 的 m5-upgrade.mjs 只做真实探针并如实报告状态码，不伪造。D 的路由已在落地中（架构门禁可见），父执行者收口时应把端到端 mention→intent 持久化纳入验收（或扩展 m5-upgrade.mjs 第 8 阶段为真实驱动）。
2. **m5-upgrade.mjs 未在本会话执行**：沙箱禁止 loopback listen（EPERM）。需用户开启 `sandbox.network.allowLocalBinding: true`（设置即时生效，无需重启）后在同会话重跑，或在正常开发环境执行 §6 命令。执行后若 A–D 期间又改树导致构建失败，属并行工作瞬态，重试即可。
3. **0014 哈希的时效性**：本报告哈希对应 14:34:11 版本；A 契约若演进，以 checker 失败为信号、评审后更新 additions（§2 规程）。
4. `make check` 全量、cross-build、`SUITE=all` 未由本 worker 执行（并行改动中的树 + 端口限制）；责任在父执行者最终收口。
5. 架构门禁当前红：D 的 7 条 agentapi 路由待父执行者入 route manifest（§5 证据），与本 worker 无关。
