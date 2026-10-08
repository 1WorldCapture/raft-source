# M3 数据库升级审查与测试报告

角色:M3 DATABASE UPGRADE reviewer/test implementer(见 `m3-implementation-coordination.md`)。
本角色只 owns 两个文件:`internal/platform/db/m3_upgrade_test.go` 与本文档。不编辑任何 worker
的迁移/代码文件;发现的问题一律报告给 parent,由 owner 修复。

## 1. 范围与方法

- 从**未改动**的 0001–0005 SQL(磁盘上的冻结迁移,逐字执行)构建**真实 M2 数据库**,
  `schema_migrations` 恰好记录这五个版本——与 M2 二进制 `migrate()` 留下的状态一致。
  不用当前 `db.Open` 建库(那会直接跑到最新链,测不到升级路径)。
- 种子数据覆盖全部 20 张 M2 表(临时目录 fixture,绝不触碰 `var/` 或任何生产数据)。
- 通过 `store.Open` 原地执行 M2→current 升级,断言:**每一张旧表的每一行、每一列字节级不变**;
  只允许"已文档化的有意图变更"(白名单机制,见 §3.3)。
- 外键/完整性/索引约束、默认角色、失败迁移回滚、重复/并发升级、写锁等待,全部实测。
- 断言在 0006+ 迁移落地前以显式 skip 或平凡通过的方式运行,落地后自动收紧(与 M2 审查
  套件同款策略),因此本套件在当前 M2-only 树上必须全绿。

## 2. M2 基线 schema(升级必须原样保全)

冻结迁移 `0001_init.sql` … `0005_workspace_preferences.sql` 共 20 张业务表 + `schema_migrations`:

| 表 | 迁移 | 排序键(确定性 dump) |
| --- | --- | --- |
| users | 0001(+0004 两列) | id |
| session_families | 0001 | id |
| sessions | 0001 | id |
| session_token_predecessors | 0001 | token_hash |
| session_refresh_rotation_receipts | 0001 | id |
| account_tokens | 0001 | id |
| account_email_requests | 0002 | id |
| legal_acceptances | 0001 | id |
| workspaces | 0001(+0003 六列) | id |
| workspace_memberships | 0001(0003 重建) | workspace_id, user_id |
| workspace_membership_agreement_audit | 0003 | id |
| channels | 0003 | id |
| channel_humans | 0003 | channel_id, user_id |
| account_workspace_order | 0003 | user_id |
| workspace_member_setup | 0004 | workspace_id, user_id |
| machines | 0004 | id |
| computers | 0004 | id |
| agents | 0004 | id |
| agent_members | 0004 | workspace_id, agent_id |
| workspace_member_preferences | 0005 | workspace_id, user_id |

种子覆盖:5 个用户(owner + co-owner 同空间、admin/member/guest、未验证 guest、0004 的
`first_onboarding_completed_*` 列)、3 个 session family(1 个 revoked)+ 4 个
session(旋转前任 + AES-GCM 封装 receipt)、email 验证/重置一次性 token、邮件请求账本、
法律接受、3 个 workspace(1 个软删除)、8 条 membership(全角色)、创建期审计行、
系统频道 `#all`/`#announcement`(v2 私有形态与默认形态两种)+ onboarding-owner 私有频道
+ `channel_humans` 行、`account_workspace_order`、8 条 setup 状态
(`complete/normal`、`in_progress`、`not_started`、legacy `deferred` 各有覆盖)、
3 台旧机器(含 0004 遗留 `api_key_prefix` 形态、online/offline 已落定状态、runtimes NULL
的 unknown 形态)、3 台 Computer(1 个 revoked)、4 个 agent(官方 Cindy、generic、
软删除)、3 条 agent_members(admin/member)、8 条 preferences(含 dismissed/wizard/
sidebar JSON 值)。

诚实边界:0004 注释明确 machines/computers/agents 在 M2 产品里没有写入方,真实 M2 生产库
中这些表大概率是空的;本 fixture 按 parent 指令种入"旧机器/Computer/agent"行,代表 TS
时代库与隔离 fixture 中存在的形状,目的是让 0007/0008 的 ALTER 路径在**有行**的表上被
真正执行和验证(空表上的 ADD COLUMN 不触发任何数据路径,测不出改写风险)。

## 3. 初始 schema 期望(立即发布,供各 worker 对照)

### 3.1 已锁定的 M3 预期变更

| 迁移 | Owner | 依据 | 预期 |
| --- | --- | --- | --- |
| `0006_channel_core.sql` | CHANNEL | 契约文档尚未发布 | 期望**纯增量**:`channel_agents` 表 + channels 必要的可空列;无 messages 表;不得改写任何 M2 行;系统频道 partial unique 语义不变 |
| `0007_computer_admission.sql` | COMPUTER | `docs/m3-computer-contract.md` §1 + `internal/computer` 代码已引用列名 | `machines` + `api_key_hash`/`api_key_fingerprint`/`legacy_key_migrated_at`(全可空,旧行读 NULL)+ `idx_machines_api_key_prefix`/`idx_machines_api_key_fingerprint`;`computers` + `api_key_hash`/`api_key_prefix`(可空)+ `idx_computers_prefix`;新表 `device_authorizations`(契约 §1 形状) |
| `0008_agent_identity.sql` | AGENT | `internal/agent/model.go`/`credentials.go` 已落地(迁移未落) | `agents` 预计 + `status_changed_at`/`session_id`/`model`/`runtime_config`/`reasoning_effort`/`execution_mode`/`env_vars`(旧行只读 NULL 或声明默认值)+ agent 凭证表 + bootstrap token 表(表名以落地迁移为准) |
| `0009_machine_connections.sql` | MACHINEWS | `docs/m3-machinews-contract.md` 明确声明 | **不需要**(连接代数在内存,ready 事实写 0004 已有 machines 列) |

### 3.2 绝不允许(硬断言,任何环境)

- 任何 M2 表**删列/改列定义**(类型、NOT NULL、默认值、PK)。
- 任何 M2 表**删外键、删索引**(重建表必须完整重建 0001–0005 的全部约束)。
- 任何 M2 行的**任何旧列值变化**(全表确定性 dump 字节级比对;新插入行同样会被 dump
  比对发现)。
- 升级**发明事实**:旧机器/Computer 凭证列必须读 NULL;setup 状态不得被改写(尤其不得
  自动 complete);系统频道/成员关系不得被增删;agents 旧行新增列只允许 NULL 或声明默认值。
- 新表中由迁移自己插入的行(backfill)未登记白名单。
- 失败迁移留下半升级状态;重复/并发 Open 重复记录版本。

### 3.3 白名单机制("有意图变更"如何被接受)

`m3_upgrade_test.go` 顶部维护两个初始为空的登记表:

- `m3DocumentedMigrationBackfills`(表→列→契约文档理由):允许迁移向**既有 M2 行**的
  新增列写入非默认值。当前为空——0007/0008 已公布计划均为 NULL/默认值,无需条目。
- `m3DocumentedMigrationInserts`(新表→理由):允许迁移向**新表**插入行。当前为空。

任何未登记的改写都会让 `TestM3UpgradeChangesAreAdditiveAndDocumented` 失败并输出精确
差异;reviewer 核对契约文档确属有意图后在此登记,否则退回 owner 修复。这实现了
"only intentional migration changes allowed and documented"。

## 4. Schema 审查:跨空间凭证/绑定完整性与不安全默认(报告,不改他人文件)

以下发现按严重度排列,供 parent 分派;均基于冻结的 0001–0005 与已发布的 0007 契约及
0008 代码推断,不阻塞升级本身:

1. **`agent_members`(0004)无法声明式阻止跨空间 roster**:`workspace_id→workspaces` 与
   `agent_id→agents` 是两个独立外键,ws-B 的 agent 可以插入 ws-A 的 agent_members。
   修复建议(给 AGENT/CHANNEL worker):加复合外键 `(workspace_id, agent_id) REFERENCES
   agents(workspace_id, id)`,需要在 agents 上补 `UNIQUE(workspace_id, id)` 索引;
   或由写入方在同一事务内校验。**0006 的 `channel_agents` 大概率有同样问题**(契约未
   发布,落地时必须核对)。
2. **`channels.archived_by_agent_id`(0003)无外键**(0003 注释已声明"agent 表出现前
   不加"):0008 落地后应通过重建补外键,或由归档写入方校验 agent 存在且同空间;
   `workspace_member_preferences.onboarding_dm_sent_by_agent_id`(0005)同类。
3. **`machines.user_id`/`computers.attached_by_user_id`(0004)不绑定 membership**:
   机器可以挂在"不是该空间成员"的用户名下;成员被移除后机器行仍在。TS 语义在写入方
   约束;COMPUTER worker 的 register/attach 事务内必须校验(契约 §2.5 的角色门已覆盖
   attach,register 路径请一并确认)。
4. **`device_authorizations.approved_by_user_id ON DELETE SET NULL`(0007 契约)**:
   批准者被删除后,已 approved 的 pending 设备码仍可消费,`ConsumeResult.ApprovedByUserID`
   为空 → 签发会话时必须 fail-closed;契约 §2.4 未写明,请 COMPUTER 在 consume 语义中
   明确(建议:approved_by 为空的 approved 行按 expired 处理)。
5. **`workspace_membership_agreement_audit.actor_user_id` 无 ON DELETE**(RESTRICT):
   未来账号删除路径会被审计行阻塞(其余用户数据都是 CASCADE)。当前无删除写入方,
   记录在案。
6. **不安全默认扫描(M2 + 已公布 M3)**:未发现不安全默认——`workspace_memberships.role`
   默认 `member`(D05 已修)、`agents.status` 默认 `inactive`、`machines.last_status`
   NULL 即 unknown(不伪造 online)、`workspace_member_setup` 回填 `not_started`
   (不自动完成)、`device_authorizations.status` 默认 `pending`、频道
   `guest_visible/guest_joinable` 默认 0。0007 的 `computers` 无 (workspace, user, name)
   活跃唯一索引:并发 attach 依赖 BEGIN IMMEDIATE 串行化 + 事务内检查,单进程成立,
   可接受(记录)。

## 5. 测试清单(`m3_upgrade_test.go`,package `db_test`)

| 测试 | 覆盖 | 0006+ 落地前 |
| --- | --- | --- |
| `TestM3UpgradePreservesEveryM2RowAndColumn` | 升级后 20 表全列 dump 字节级一致;密码/refresh/一次性 token 可用;版本恰好全记录;FK/integrity 干净 | 通过(平凡升级) |
| `TestM3UpgradeChangesAreAdditiveAndDocumented` | 列/外键/索引只增不减不改;新增列旧行只读 NULL 或声明默认;新表迁移自插行须白名单 | 通过(无差异) |
| `TestM3UpgradeInventsNoCredentialsStatusOrCompletion` | 0007 凭证列旧行 NULL;setup 状态逐行不变;频道/成员/agent 行数不变 | 列不存在时跳过对应断言 |
| `TestM3UpgradeFailureRollsBackAndRetryUpgrades` | 注入 trigger 阻断 0006+;失败后 M2 数据字节不变、版本不记录;清除后重试成功 | skip(无可失败迁移) |
| `TestM3RepeatedOpenIsIdempotent` | 二次 Open 版本不变、数据不变 | 通过 |
| `TestM3ConcurrentUpgradeFromM2` | 3 并发 Open;最终版本恰好一次、数据完好 | 通过 |
| `TestM3OpenUnderHeldWriteLockLeavesNoPartialState` | 持写锁期间 Open 阻塞不产生半升级;释放后完整升级 | 通过(-short 跳过) |
| `TestM3UpgradeKeepsDefaultRoleAndKeyConstraints` | 默认角色 member;显式 owner 可写;FK 池内强制;系统频道/频道名/agent 名唯一索引保留 | 通过 |

M2 套件(`m2_upgrade_integration_test.go`)对 busy connector 的上下文取消/写锁等待已有
完整覆盖;M3 不改 connector,故本套件只保留持锁 Open 一项,其余不重复。

## 6. 测试证据

2026-10-08 收口：0006/0007/0008 均已落地，`make check` 中的全量普通测试及全量 race 测试通过，包含本报告的真实 SQLite 升级用例。

`RAFT_GO_TEST_SUITE=upgrade node tests/acceptance/run.mjs` 另行通过：先构建冻结的、已提交的 M2 二进制并生成真实账号、会话、工作空间、偏好与 setup 数据，再交给 M3 执行增量迁移；原 ID、签名密钥、登录会话和权限保留。旧 M2 二进制面对 M3 schema 明确拒绝启动且不损坏数据；随后 M3 再启动，升级后新签发的 Computer 凭据仍有效。

同一组升级验收也已接入完整 HTTP runner 并执行通过。详细命令、数据备份与回滚边界见 `phase-3-backend-handoff.md`。本轮仅使用隔离测试数据，未升级用户现有 `var/`，未执行 UI 端到端测试。

## 7. 实际担忧与给 parent 的建议

(待测试运行后回填。)
