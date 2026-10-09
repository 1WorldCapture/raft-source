# 架构稳定化测试迁移映射(快照)

- 状态：**已补入最终收口迁移表（第 10 节）**。第 1–8 节保留早期实施快照，数量与部分中间路径不代表最终树；出现差异以第 10 节及 [最终收口报告](architecture-stabilization-closure.md) 为准。源码已收口，最终完整普通/race、协议、HTTP/客户端、升级回退门禁均通过，仍未提交。
- 日期:2026-10-09。
- 基线:`feat/go-server` / `6ffc168dd7025a2d5f61416347ecc9937853c3ad`(工作区起点 HEAD)。
- 关联:[architecture-stabilization-design.md](architecture-stabilization-design.md) §10–11、[architecture-stabilization-workplan.md](architecture-stabilization-workplan.md) §7(测试迁移规则)、[architecture-stabilization-implementation.md](architecture-stabilization-implementation.md) §3、[architecture-stabilization-closure.md](architecture-stabilization-closure.md)（最终续作证据）。
- 方法:旧侧来自 `git show 6ffc168:server-go/<path>` 逐文件枚举 `func Test*`;新侧来自当前工作区同规则枚举。函数名比对是**定位手段**;覆盖证明以第 4、5 节的逐项处置为准,不以数量相等代替。
- `make test-client-contracts`（`contracts/client/manifest.json` + `tests/acceptance/client-contracts.mjs`）负责冻结契约与迁移哈希不变量的可执行校验，与本文的映射互补；最终集成人已同步更新收口报告和本文。

## 1. 总量对照(定位用,不是覆盖证明)

| 维度 | 基线 6ffc168 | 当前工作区 | 说明 |
|---|---|---|---|
| Go 测试文件 | 163 | 176 | legacyweb 45 文件迁出,新增 tests/architecture、testkit、application 等回归 |
| Go 测试函数(实例/唯一名) | 740 / 738 | 764 / 762 | 唯一名口径下 732/738 同名存在;跨包同名(如 workspace 与其 HTTP 测试同名)按唯一名统计 |
| 仅基线存在的函数名 | — | 6 | 全部有第 4 节的逐项处置,无静默消失 |
| 仅现树存在的函数名 | — | 30 | 第 6 节分类:新门禁、新回归、语义改名;其中 6 个为本快照定稿前源侧 worker 刚新增 |
| Node/验收脚本(tests/ 下 .mjs/.go) | 46 项 | 52 项 | +6 全为新增(见第 7 节);既有文件中 3 个内容修改,其余与基线字节一致 |

## 2. Go 包级文件迁移总表

路径相对 `server-go/`。除下列映射外,其余包(workspace/readstate/message/app/computer/auth/channel/agent/runtimecatalog/platform\*/socketio\*/machinews)的测试文件**同名原位保留**(部分内容按工作包改写,见第 5 节)。

| 旧(基线) | 新(当前) | 说明 |
|---|---|---|
| `internal/transport/legacyweb/`(45 个 `_test.go`) | `internal/transport/httpapi/humanapi/`、`computerapi/`、`httpapi/`(根)、`tests/testkit/` | 第 3 节逐文件表 |
| `internal/message/read_hook_test.go` | 删除;行为并入 `internal/application/messaging/read_advance_test.go`、`send_atomicity_regression_test.go` | hook 基础设施整体删除(设计 §5),第 4/5 节 |
| `internal/realtime/publications_test.go` | `internal/publication/publications_test.go` | 包改名 `realtime→publication`,表名/事件值不变 |
| `internal/readstate/shared_seams_test.go`(部分) | 同文件保留 + `internal/platform/db/write_callback_once_regression_test.go` | "事务回调恰一次"合同移交 platform/db,第 4 节 |
| (无) | `tests/architecture/{stabilization_contract,wire_boundary}_test.go` | 新结构门禁(make architecture-check) |
| (无) | `tests/testkit/testkit.go` | 全应用 HTTP testkit,生产代码零导入(工作包规则 5) |
| (无) | `tests/acceptance/rollback_seed_test.go` | 回退验证数据播种(`RAFT_ROLLBACK_DIR` 门控) |
| (无) | `internal/application/{messaging,channelview}/*_test.go`、`internal/computer/presence_target_authority_test.go`、`internal/transport/socketio/bridge/vocabulary_test.go`、`internal/transport/httpapi/manifest_test.go` | 新增行为回归(第 6 节) |

## 3. legacyweb 45 个测试文件逐项映射

41 个文件**同名迁入新包**;4 项例外单独列出。文件名保留 m3/m4 阶段词(工作包 §7 规则 1:测试文件名允许历史含义)。

| 目标包 | 文件(同名迁移) |
|---|---|
| `httpapi/humanapi`(31) | agent_closeout_http、agent_http、avatar_store、channel_http、deferred_ui_routes、invites_http、invites_internal、invites_member_journey、invites_validation、m4_channel_projection_http、m4_conversation_http、m4_dm_snapshot、m4_message_fixture、m4_message_http、m4_readstate_http、me_profile、policy_avatar_persistence、refresh_logout_servers、register_login、runtime_catalog_http、verification_reset、workspace_history_internal、workspace_reserved_routes、workspaces_avatar、workspaces_create、workspaces_list_order、workspaces_members_settings、workspaces_profile、workspaces_scope、workspaces_setup(另新增 export_test.go,非迁移) |
| `httpapi/computerapi`(8) | computer_agentlogin_http、computer_attach_http、computer_device_http、computer_internal_http、computer_machines_http、computer_management_http、computer_testsupport、runner_http |
| `httpapi`(根,4) | backend_closeout、m4_socket_origin、m4_socket_upgrade、websocket_middleware |
| `httpapi`(根,改名,1) | request_safety_test → **request_safety_http_test** |
| `tests/testkit`(2) | testsupport_test、workspaces_testsupport_test → **testkit.go**(helper 载体;断言留在各测试包) |

## 4. 仅基线存在的 6 个函数:逐项处置

全部为 seam/接缝类测试被工作包有意消除后的改名或移交,无静默消失,无"用 skip 蒙混"。

| 基线函数(旧文件) | 处置 | 现树可执行等价 | 性质 |
|---|---|---|---|
| `TestThreadReplyReadHookSameTransaction`(message/read_hook_test.go) | 改名+升位 | `TestSendHumanThreadReplyAdvancesReplierCursor`(application/messaging/read_advance_test.go):断言对象从 hook 调用改为同事务 readstate 行事实;另覆盖"重放不推进、频道消息不推进" | 行为等价(更强:走真实 SendHuman 全路径) |
| `TestThreadReplyReadHookWiringBoundary`(同上) | 拆分 | "纯事实路径可单测分离"由 read_advance_test 的频道消息不推进断言承担;"fresh store unwired"断言随 hook 删除失去对象 —— 防线转移为 tests/architecture 生产接缝禁令(Set\* 类 setter 禁止)与 m4_wiring 装配存在性断言 | 部分**结构门禁替代**,非行为等价(第 5 节诚实点名) |
| `TestWriteTxRunsCallbackExactlyOnce`(readstate/shared_seams_test.go) | 移交+增强 | readstate 侧:`TestWriteTxCommitAndRollbackEffects`(回滚零残留/提交一组 wake);恰一次合同:`TestWriteTransactionCallbackIsNotReplayed`、`TestWriteTransactionCancelledAcquisitionDoesNotInvokeCallback`(platform/db/write_callback_once_regression_test.go,4 模式矩阵含取消后写) | 行为等价(更强:归属正确的层) |
| `TestM4ReadCursorSeamDrivesUnread`(legacyweb/m4_conversation_http_test.go) | 改名 | `TestM4ReadCursorFactsDriveUnread`(humanapi 同名文件):ReadCursor stub 换成真实 readstate 行 | 行为等价(去 stub) |
| `TestM4FollowReadSameTransaction`(同上) | 改名 | `TestM4FollowAdvancesReadInSameTransaction`(humanapi) | 行为等价 |
| `TestM4DMReadStateSeam`(同上) | 改名并补独立协议验收 | 初期 `TestM4DMReadStateVerbatimFromOwner` 仍用 owning projector 计算期望，只能证明嵌入，不能独立证明 wire；续作在 `tests/acceptance/m4-backend.mjs` 用协议字面量和真实 read/unread 操作验证 absent/present/rewound、create/list 与观察者隔离 | 独立协议覆盖来自新增 HTTP 断言，不误将同一生产函数自证描述为更强 |

## 5. 被删除/重写的回归与钩子(诚实点名)

以下基线断言在现树**没有同形断言**;逐项给出理由与现存承担者。判断依据是基线测试体与现树对应文件的对照,不是数量。

1. **`PostInitialReply` 未接线 501 子测试**("unwired first reply is refused before mutation",基线 m4_conversation_http_test.go 内 `t.Run`):接缝删除后"未接线"状态不存在,首条回复走 `CreateThread` 完整用例(需真实 roster,测试补播种)。501 语义本身仍由 deferred_ui_routes_test 的诚实 501 断言守卫,但"首条回复的 501"不再存在 —— 这是设计 §5 的**有意语义变化**,不是遗漏。
2. **`MarkReadLatest` 注入失败子测试**(基线 m4_conversation_http_test.go 两处注入)：生产可变 setter 已删除，但晚失败注入并未消失。`application/messaging/send_atomicity_regression_test.go` 使用测试自有 SQLite BEFORE INSERT trigger，核对同事务内更早的 thread/follow/新 reply 事实后抛出指定故障；直接应用测试核对该指定错误，并比较从 sqlite_schema 枚举的全部应用表精确行集。`TestSendHumanReadFailureRollsBackEarlierMessageAndFollow`、`TestCreateThreadFirstReplyReadFailureRollsBackEntireWorkflow`、`TestFollowThreadReadFailureRollsBackThreadAndFollow` 提供 R5/R10 的真实后置故障回滚覆盖，不是依赖结构推断。HTTP 错误映射与 DM projection 失败的新增覆盖另见续作报告。
3. **`HasThreadReplyReadHook()` fresh-store 断言**(第 4 节第 2 行):无行为等价,防线为结构门禁。
4. **DM 快照纪律"创建即可读自身未提交频道行"**:由行为证明替代原快照断言,现名 `TestM4DMFrontierSharesCallerSnapshotAndCreationTransaction`(humanapi/m4_dm_snapshot_test.go)。
5. **`m4_wiring_test` 的 PostInitialReply 装配完整性断言**:改为服务存在性断言(构造失败即 Build 失败);`TestM4WiringThreadReplyAdvancesReplierCursor` 端到端行为原样通过。
6. **PostInitialReply 501(unwired)删除**与 **seam 类测试改写**的完整清单另见 implementation 报告 §3;本表只收录可从基线 git show 直接指认的项。

## 6. 新增函数分类（该轮快照，非最终测试数量）

| 类别 | 函数(所在文件) |
|---|---|
| 新结构门禁(tests/architecture,make architecture-check) | TestStabilizationRequiredProductionBoundaries、TestStabilizationTransportAndCompositionDoNotExecuteSQL、TestStabilizationProductionNamesDescribeCapabilities、TestStabilizationDependencyDirection、TestClientWireSerializationIsNotOwnedByApplication(wire_boundary_test.go) |
| 语义改名(第 4 节对应项) | TestM4ReadCursorFactsDriveUnread、TestM4FollowAdvancesReadInSameTransaction、TestM4DMReadStateVerbatimFromOwner、TestWriteTxCommitAndRollbackEffects、TestSendHumanThreadReplyAdvancesReplierCursor |
| 新增行为回归(稳定化必测矩阵) | TestSendHumanReplayPreservesSubsequentUnreadAndUnfollow、TestSendHumanReadFailureRollsBackEarlierMessageAndFollow、TestCreateThreadFirstReplyReadFailureRollsBackEntireWorkflow、TestFollowThreadReadFailureRollsBackThreadAndFollow(send_atomicity_regression_test.go);TestConversationUseCasesBindActorToAuthenticatedClaims、TestConversationMutationsReuseTheirTransactionConnection(actor_snapshot_regression_test.go);TestApplicationConstructorsRejectMixedDatabaseOwners、TestChannelViewCannotSubstituteAnotherViewer(channelview);TestPresenceFactsRejectDifferentTargetMachine(computer);TestSemanticEventVocabularyMatchesGateway(socketio/bridge);TestRouteManifestHasNoDuplicates(httpapi) |
| 平台合同移交 | TestWriteTransactionCallbackIsNotReplayed、TestWriteTransactionCancelledAcquisitionDoesNotInvokeCallback(platform/db) |
| 验收工具 | TestSeedRollbackData(tests/acceptance/rollback_seed_test.go) |
| 快照定稿前源侧新增(未在基线) | TestBuildCloseIsFenceNeutral、TestBuildFailureReleasesAuthorityFence(app/build_failure_cleanup_test.go);TestPresenceStoreHooksAreCapturedOnce、TestPresenceStoreRejectsNilDatabase(computer/presence_constructor_test.go);TestSendHumanIntentRevisionsMatchBaseline、TestSendHumanPublicationOrderMatchesBaseline(application/messaging/publication_order_test.go) |

## 7. Node / 验收与引用侧

基线 tests/ 下 46 个 .mjs/.go 测试资产中,除下列外**全部与基线字节一致**(git status 无改动):

| 变化 | 文件 | 内容 |
|---|---|---|
| 修改 | `tests/acceptance/run.mjs` | 注册 `stabilization-rollback` 套件(SUITE=all 默认包含;baselineOnly 仅独立 harness) |
| 修改 | `tests/acceptance/m4-backend.mjs` | 加强 DM readState #632 union 断言(absent/present、跨 viewer 不泄漏、rewind 保持 present;期望值独立于生产 presenter 推导) |
| 修改 | `tests/acceptance/m4-reference/go_wire_export_test.go` | wire 采集改经 `messaging.SendHuman` 真实路径 |
| 新增 | `tests/acceptance/stabilization-rollback.mjs`、`rollback_seed_test.go`、`tests/architecture/*`、`tests/testkit/testkit.go` | 见第 2 节 |
| 新增(本任务) | `tests/acceptance/client-contracts.mjs` + `contracts/client/manifest.json` | 冻结契约能力索引 checker(make test-client-contracts) |

`tests/acceptance/m4-reference/**` 引用侧不变:`run.mjs` 继续读写/校对 `contracts/m4/**`(`--check` 只读比对);`workplan` §7 规则 2 的 `TestM4ReferenceExportGoWire` 调用点(`go-wire-export.mjs`)仍以该测试名定位,本轮未被改名。

## 8. 与契约索引 checker 的关系(快照脆弱性)

- `contracts/client/manifest.json` 登记的消费者路径是**当前工作区快照**:其中 `internal/transport/httpapi/humanapi/m4_readstate_http_test.go`、`internal/readstate/fixture_test.go`、`internal/readstate/doc.go` 位于 `internal/**`,源侧 worker 仍可能迁移它们。checker 会因消费者文件移动而失败(consumer-missing)—— 这是预期的漂移信号,随移动同步更新 manifest 即可,不是契约本身漂移。
- 测试名同理:本文第 4/6 节的等价映射以现树函数名为准;若后续纯改名,以第 5 节的"承担者语义"为准重新对表,不以本表数量断言。

## 9. 本映射的范围与实际执行证据

监听类验收和 govulncheck 已由续作会话实际运行：完整 TCP/原始客户端/升级与回退、reference/fresh wire、cross-build 均已有通过记录；Go 1.27.2 工具链补丁后扫描为 0 个可达漏洞，6 个未调用模块级提示如实保留。原先“本沙箱不可用”的描述不再代表工作区的验收状态。

本文是映射，不是测试运行日志。中间树与最终同树复跑应区分，以 [architecture-stabilization-closure.md](architecture-stabilization-closure.md) 的实际命令/结果为准，不将本表的静态枚举数量当作完整验收。

## 10. 最终收口增量与中间快照更正

以下处置在第 1 节统计之后完成，全部进入最终同树 `make check`。因此不能从旧表的“同名原位保留”推断以下文件仍在旧位置，也不能将它们从旧目录删除解释为覆盖消失。

| 基线/中间测试位置 | 最终位置与验证职责 |
|---|---|
| `message/reference_verify_test.go` | `transport/presenter/messages_test.go:TestReferenceVerifierRunsOriginalManifestAndViewerReducer`，仍运行原始 manifest/reducer 的真实验证，不换 golden。 |
| message 内的 shared message updated sealing 测试 | `presenter/messages_test.go:TestSocketUpdatedInContextSealsAndCarriesContext`，保留 storage-only 与 receiver-private 字段不得泄漏、nil context 不虚构的断言。 |
| message 内两项 resume 字节预算测试 | `transport/socketio/bridge/resume_budget_test.go`：`TestResumePageByteBoundNeverSkipsVisibleMessages`、`TestResumeByteBudgetIncludesEnvelopeAndNeverAdmitsOversize`；真实事实扫描后调用 `presenter.RenderResumePage`，保留 envelope/超限/不跳过消息的行为。 |
| `readstate/projector_test.go`，与生产另一路重复的 projector | 重复生产实现删除；`application/realtime/readstate_events_test.go` 使用真实 dispatcher/presenter：`TestReadStateWakeProjectsCurrentFactsThroughPresenter`、`TestUnreadSummaryWakeProjectsServerIDInvalidation`、`TestStaleSubjectWakeCompletesWithoutDelivery`、`TestPrefsWakesProjectFrozenPrefsEnvelopes`。app 中 authority、private publication completion、Socket.IO 端到端测试仍保留。 |
| legacyweb/computerapi 人类机器管理测试 | `httpapi/humanapi/machines_http_test.go`。人类 RVP/scope/capability、缺少或错配 X-Server-Id、guest、删除/rotate/disconnect/method fallback 的原断言保留；中间迁移接线失败后修正 fixture，而非把原 400 改成 200/405。 |
| message 生产 `CreateTx` 被测试依赖 | 生产包装器删除；包内/crash fixtures 的 seeder 仅在 `internal/message/seed_message_test.go` 编译。跨包 presenter/resume fixture 与 `tests/acceptance/m4-realtime-fixture/main.go` 显式组合 `CreateMessageTx` 和 `RecordSendPublicationsTx`，不是第二个生产发送用例。 |
| read/follow 错误注入 hook | 原生产 hook 删除；应用层 SQL trigger 晚故障测试与 `tests/acceptance/stabilization_http_failure_test.go` 四种 HTTP 晚失败/回滚/恢复验证互补。HTTP trigger 使用 WHEN 前置事实条件，DM poison row 仅在新 DM 事实之后出现，不以相同 500 掩盖过早故障。 |
| DM read-state 自证式期望 | `tests/acceptance/m4-backend.mjs` 使用独立协议字面量验证 absent/present/rewound、decimal-string seq、create/list 一致和 viewer 隔离；不是仅比较同一个生产函数的两次输出。 |
| channelview 仅有功能/快照测试 | 新增 `tests/acceptance/stabilization_query_budget_test.go`，0/1/many、计数 executor、单连接池和零写入检查；与原 snapshot/claims 隔离回归一起通过。 |
| Build/presence/machinecontrol 构造与关闭 | `app/build_failure_cleanup_test.go`、`computer/presence_constructor_test.go`、`application/machinecontrol/constructor_test.go`；nil 依赖、捕获语义、校验先于下游、失败 fence 释放和重复 Close。 |
| 粗略路由清单仅查重复 | 8 个最终架构合同中的 route coverage/policy 维度检查，加 `httpapi/manifest_policy_regression_test.go` 精确固定真实 reaction 路径、401/405/Allow、不同作用域、独立 limiter 与 mount/dispatch 区分。 |

验收入口的最终额外变化包括 bulk fixture 注释/两原语播种（`m4-realtime.mjs`/`m4-realtime-fixture/main.go`）、真实回退默认接入 all，以及 `Makefile` 的 `test-http-all` 防止继承缩小的 SUITE。第 7 节“只有三个文件修改”的旧快照不再适用于最终树。

最终执行证据：一次连续成功的 `make check`（全包普通与 race、8 项结构合同、契约自检、原 TS reference/fresh Go wire、完整真实 HTTP/原客户端/升级回退及构建），随后 `make cross-build vuln` 成功。冻结资料/迁移 hash 不变、没有新增 skip 或改 golden。独立审查和最终验收详情均见收口报告第 5–7 节。
