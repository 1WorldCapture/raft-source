# Attention 增量版 1+2：实现与验证记录

- 日期：2026-10-06
- 工作区：`/Users/lyon/workspace/raft-source`
- 分支／基线：`dev` / `06b5617ccf27d6733370aa01cbb119b9c7860f6e`
- 依据：`attention-increment-1-2-implementation-plan.md` v2。
- 状态：已修改工作区源代码、文档和测试；CLI/Daemon 本地构建成功。未 git add/commit/push，未发布、签名或重启现用服务。

## 1. 已完成的功能

### 推荐与展示

新增 `packages/shared/src/agentInboxPriority.ts`。由每条合格 pending 消息的发送者和直接提及事实计算等级，按 target 聚合最强信号，顺序为人类 DM、人类 @、Agent DM、Agent @、普通。DM thread 按父 DM 类型判定；`latestSenderType` 仅展示，不承担整组判断。

同级使用有效 firstPendingSeq 与稳定 target 顺序。注释明确共享 messages-table 序号不是提交时间，也不是消费／ACK 水位。未知 sender/未来 priority 不获得人类优先，旧 producer 缺字段仍可展示粗粒度顺序。

通知保留原候选消息集合和时机，只排序展示并给出“本次更新中”的建议。Inbox 保留其他 target、App items 与 suppressed 信息；仅在 Daemon 返回可选 target_check 能力时，CLI 推荐新的定向命令。

### 定向 CLI

新增：

```bash
raft message check --target "dm:@James"
raft message check --target "#proj-api:a1b2c3d4" --limit 50
```

仅 managed-runner；默认 50、最大 200 条，并受 256 KiB 序列化 UTF-8 JSON 预算限制。每次调用只请求一个有界页面，不运行全量 drain 循环。结果说明 scope 为当前 daemon pending，不等于 Server 历史；其他读取、搜索、resolve、claim/ack 能力保留。裸 `raft message check` 继续走原全量分支。

### 本机路由与消费

新增 `POST /internal/agent-api/inbox/messages/check`，放在独立 Daemon API 契约。只使用代理 token 注册 Agent 的 coordinator，不接受 agentId/serverId/launchId 参数，不查询全局 pending。空、错误、方法错误、unavailable 都本地返回，绝不降级调用 `/events`。

新增纯准备器 `agentInboxTargetCheck.ts`：显示 target 匹配、实际 channel 身份检查、ID 去重、固定本次成员、有界完整正文、schema 校验与序列化先于消费。短 ID 碰撞或冲突身份零消费。字节预算含 JSON 转义、中文、代码块和附件元数据；附件文件不内联，首条过大明确报错而不截断后标已读。

代理在准备前、消费前检查注册和当前 launch。即使旧 token 尚未注销，当前 launch guard 也阻止它沿动态 Agent 查询读到新进程的消息。

APM 新组合 hook 复用原 exact-ID 消费，再仅完成本次返回 IDs、当前 Agent/launch/session 对应的 pending tracked mention。不调用 agent 级 complete-all，不推进 max seq 水位，不按条数清理通知债务。

### Notice 与正文

通知贡献不代表正文已读。定向 check 不按 `hasContributedMessage` 排除消息；正文仍待消费时可以读取，已被 visible ledger 记录的实际正文不再次作为 pending 读取。既有 runtime gates、失败/unknown/deferred 行为不改。

### 观测

新增 `attentionObservation.ts`，由 APM 用 WeakMap 绑定当前进程。只保存一条临时 recommendation 观测，session 改变即不关联；不持久化、不授权、不调度。

成功通知记录 recommendation_id、recommended_target、priority；读取记录 check_scope、check_target、outcome、returned_count、first_check 等。全量 check 的多页不会重复算首次采纳。观测异常不影响消息处理。未关联的读取不补造推荐。

### 提示词、手册和兼容

更新 `systemPrompt.ts`、唯一 CLI guide 源、通知文案和 Inbox/Message/Mention/worked patterns。明确推荐与当前任务无关时先完成当前步骤，不要求立即切换，不限制其他查询。

运行生成器更新 `manual/agent-knowledge/raft-cli-overview.md`。重复生成前后 SHA256 相同：
`903d1da52da52d7e0d7c2f9359006a5d34ad386c95ca42912eec25c860b58466`。

旧 Daemon 缺能力时不建议已支持定向 check；手动新请求遇旧版本或 self-hosted 明确 unsupported，无全量 fallback。

## 2. 主要文件

新增实现：

- `packages/shared/src/agentInboxPriority.ts`
- `packages/daemon/src/agentInboxTargetCheck.ts`
- `packages/daemon/src/attentionObservation.ts`

修改接线：Shared Inbox/Daemon contract/raw diagnostic keys；Daemon projection、proxy、coordinator、APM、runtime input、prompt/guide；CLI typed client、message check、Inbox formatter、错误码；相关手册。

没有改 Server/DB/Computer 业务、omp 生产 driver、通知计时器、Focus/Waiting For、启动与恢复选择规则。保留基线 omp 的 isRunInProgress 和 consumesSpawnPrompt 行为。

## 3. 已执行测试（去除重复运行后）

| 套件 | 通过 | 跳过 |
|---|---:|---:|
| Shared priority + Inbox + Daemon API contract | 38 | 0 |
| CLI targeted + legacy check + Inbox + typed client | 23 | 0 |
| Daemon proxy + targeted route + batch + exact ACK + projection + notice state + ledger + prompt | 146 | 0 |
| omp RPC + driver + startup delivery debt | 56 | 0 |
| Claude APM 完整文件（含新增闭环） | 108 | 1 |
| 合计 | **371** | **1** |

跳过项是现有 Claude APM 文件中的一项，本次未取消任何用例。不是整个仓库的全量测试统计。

### 可复跑命令

```bash
pnpm --filter @botiverse/raft-shared exec node --import tsx --test \
  src/agentInboxPriority.test.ts src/agentInbox.test.ts src/daemonApiContract.test.ts

pnpm --filter @botiverse/raft exec node --import tsx --test \
  src/commands/message/check.targetCheck.test.ts src/commands/message/check.test.ts \
  src/commands/inbox/check.test.ts src/daemonApiPath.test.ts

CI=1 pnpm --filter @botiverse/raft-daemon exec vitest run \
  src/agentCredentialProxy.test.ts src/agentCredentialProxy.targetCheck.test.ts \
  src/agentInboxTargetCheck.test.ts src/agentProcessManager.targetCheck.test.ts \
  src/agentInboxProjection.test.ts src/runtimeNotificationState.test.ts \
  src/agentVisibleDeliveryLedger.test.ts src/drivers/systemPrompt.test.ts \
  --maxWorkers=1 --minWorkers=1 --silent

CI=1 pnpm --filter @botiverse/raft-daemon exec vitest run \
  src/drivers/ompRpc.test.ts src/drivers/omp.test.ts src/agentInboxDeliveryDebt.test.ts \
  --maxWorkers=1 --minWorkers=1

CI=1 pnpm --filter @botiverse/raft-daemon exec vitest run \
  src/agentProcessManager.claude.test.ts --maxWorkers=1 --minWorkers=1
```

使用 CI=1，避免当前 Vitest 配置自动更新快照。HTTP 测试只用本机假服务／测试凭据；APM 使用原假 driver 与临时数据目录；omp RPC 使用临时 fake Node 进程和实际 pipe，没有调用真实 provider 模型。

### 已验证的关键回归

A token/B-only target 读取零泄漏、零消费；A/B 同名 target 分离；旧 launch token 被拒绝；本地空／无 hook／错误方法零 upstream；同 target 多发送者一起返回；父频道、thread、DM、DM thread 分离；短引用冲突拒绝；有界页／UTF-8／附件元数据预算；只确认当前代次且本次返回的 mention IDs；稀疏高 seq 不变成 read-through；notice 后正文仍可读、消费后不重复；其他会话保留供旧全量读取；观测故障不改变消费。

新增 Claude APM 闭环验证混合通知→人类 DM 推荐→定向正文消费→另一 conversation 保留与实际 trace。新增 omp 用例验证 ready/RPC/steer 携带相同推荐与 body 未消费契约。

## 4. 构建与类型检查

以下均成功：

```bash
pnpm --filter @botiverse/raft-daemon build
node packages/cli/dist/index.js message check --help
pnpm --filter @botiverse/raft-daemon generate:raft-cli-guide
git diff --check
```

Daemon build 包含 CLI build、Daemon bundle、内置 CLI 复制。`--help` 已在实际构建出的 CLI 验证新选项。构建输出有现有 zod-openapi sideEffects 提示；测试环境有 Node module.register 弃用提示，均未阻止通过。omp fake harness 中 `/tmp/slock-cli.js` 缺失警告来自原测试夹具，不应解释成已验证的 Desktop 安装问题。

Shared `tsc --noEmit` 通过；Daemon 与 CLI 全量类型检查仍有 **5 处基线测试错误**：

| 文件（HEAD 原始行号） | 错误 |
|---|---|
| `packages/daemon/src/agentInboxDeliveryDebt.test.ts:24` | TS2322：null 不可赋值给 string。 |
| `packages/daemon/src/drivers/ompRpc.test.ts:851,868` | TS18047：harness 可能为 null；本次新增测试后行号为 885,902。 |
| `packages/cli/src/commands/message/claim.test.ts:145` | TS2769：assert.rejects 回调类型为 void 或 Promise。 |
| `packages/cli/src/commands/message/send.test.ts:572` | TS2769：同类回调类型。 |

已用 TypeScript CompilerHost 做只读基线对照：把工作树修改的 tracked 源在内存中替换为 `git show HEAD:<path>`，排除新文件，分别建立 Daemon/CLI program 并 noEmit 检查；HEAD 同样分别报告 3/2 条相同错误。最终工作树没有新增类型诊断。没有为了让检查变绿改动这些无关测试。

CLI 测试执行清单增量加入新 8 项测试，fileCount=106、total=935；已检查排序、计数及新增用例实际执行。**未运行整个 935 项 CLI 套件**，不能把 manifest 总数当成实际通过数。

## 5. 交付边界与未做事项

没有构建签名 Desktop 安装包、安装升级、版本发布、停止现用 Agent、全员重启或调用真实 Claude/omp 模型。真实模型是否遵循推荐、Desktop 混合版本安装、真实团队灰度指标仍需发行验收，不用 fake RPC 测试替代。

本次产物是工作区源码、测试、生成手册和本地构建结果。没有 git add/commit/push，也没有变更 release 版本号。用户原有 `apps/mobile/metro.config.js` 本地修改保持原样；先前的三个设计文档仍是独立 untracked 文档，本次未误纳入其他迁移实现。

功能需由新版 Desktop/Computer/Daemon/内置 CLI 组合实际安装并受控更新运行进程后才对现用 Agent 生效；不能因为本地 build 成功就宣称已上线。
