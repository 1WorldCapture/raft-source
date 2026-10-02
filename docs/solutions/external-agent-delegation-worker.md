# External Agent 委托调度与模拟提供方

本次交付 #grokbot-integration task #6（A3），基于 dev `1deccf5`，接续已经共同验收的 A2（PR #144）。实现范围是持久调度、投递租约、结果分类、退避与限额、worker 生命周期及确定性模拟提供方。没有真实 Grok 传输、公开 API、CLI、本机安装、生产迁移或部署。

## 持久事实与事务边界

`external_agent_wakes` 本身就是 outbox，不新增重复队列表。worker 扫描使用有查询期限的只读事务及按连接 ID 排序的有限分页；每页默认 50 个连接，默认最多 4 个并行任务，上限分别为 200 和 16。扫描位置仅用于公平遍历，不作为已消费输入的证据。重建 worker 后从数据库恢复，暂停或阻塞绑定不会让后续绑定永远得不到扫描。

每个连接先调用 A2 的恢复端口，再在稳定 Agent 授权门内预留 dispatch。attempt、请求摘要、配置版本、epoch、fence、次数、启动期限与租约在调用模拟提供方之前提交。真实 PostgreSQL 回归用事务提交屏障及可观察的锁等待验证：未提交的竞争者调用适配器次数为零；竞争结束只有一个投递。

适配器调用始终在数据库事务外。默认注册表为空，缺少适配器不预留 attempt。A3 只接受由服务端依赖注入的 `mode: fake` 适配器；没有生产适配器注册，没有服务启动时自动启用真实投递。后续接入层须独立完成生命周期接线和正式传输审核，不能把本次模拟注册误当作已配置 Grok。

模拟提供方只接收 shared 闭合 schema 的六个唤醒字段。接口不传正文、任务、附件、私有 endpoint、Webhook key、Raft credential 或 ownerToken。脚本可用屏障及受控回调模拟 Routine；回调是测试代码，不是允许用户配置任意脚本的产品能力。

## 分类与预算

| 传输事实 | 调度处理 | 不产生的事实 |
| --- | --- | --- |
| HTTP 恰好 200 | attempt accepted；等待已有启动期限内的 begin | 不创建 run、不 claim、不 ack |
| 401/403、404/410 | attempt rejected；wake blocked，并保存固定配置原因 | 不自动更换凭据、不自行解除阻塞 |
| 429 | rejected；持久保存有界 Retry-After 与指数退避的较大值 | 不重置 attempt 或 run-start 预算 |
| 5xx | rejected；指数退避 | 不猜测提供方内部执行结果 |
| 其他 HTTP 状态，包括意外 2xx 和重定向 | rejected、protocol mismatch；有界重试 | 不以任意 2xx 作为 accepted |
| 网络未知、取消、期限耗尽、非法适配器结果 | unknown；保留启动关联窗口及持久退避 | 不宣称远端已取消或模型已读消息 |

退避基数 1 秒、指数递增，jitter 区间为 0.5–1.5，退避及 Retry-After 最多 5 分钟；小数毫秒向上取整。随机源由服务端注入，测试固定。适配器提供的任意错误字符串、响应体或额外字段不能进入审计：非法结果统一归为固定 `adapter_failure`。

每次真实预留计入数据库 attemptCount，投递与运行次数分别受 A2 的现有上限约束。按连接统计过去一小时的所有 attempt，不因 worker 重建、epoch 或 retry cycle 变化绕过小时限额；命中限额只推迟 nextAttemptAt，不创建 attempt、不消耗一次投递预算。下一可尝试时间来自窗口最老 attempt 的退出时刻。

unknown 等待的下一次投递同时受 startupDeadline 和持久 nextAttemptAt 约束。普通扫描、失联恢复、新消息、yielded、过期 run 不清零次数。blocked/exhausted 仍阻止新输入自动创建预算；显式 resume/redrive 沿用 A2 的权限、审计及预算语义。

## 迟到回调与生命周期

投递结果先记录 attempt 事实，只有当前 epoch、dispatch fence、owner、dispatching 状态和仍未过期的 dispatch lease 都匹配，才能改变 wake。有效 run 已开始时不降回 awaiting_agent；暂停、换代、失联租约被回收或新投递已开始时，不用旧回调覆盖新状态。租约已经过期但恢复扫描还没执行，同样不能修改 wake。

dispatch 总期限默认 10 秒，短于 15 秒预留租约。worker 取消会通知适配器，保存 unknown；取消信号不是清理完成的证明。取消后额外等待最多 1 秒以确认适配器回调尾部结束；尾部不配合时保存 unknown、让本 worker 停止接受后续 tick，并通过 runOnce/stop 报告清理失败。测试必须释放故意阻塞的尾部，不能把取消 Promise 当作数据库事务已回滚。

同一 worker 的重叠 tick 合并；start 重复调用不创建第二个循环；stop 取消当前循环并等待本页全部并行任务和结果审计结束。每连接异常只返回固定 unavailable 类别，预留事实由租约恢复；扫描或清理故障由生命周期 owner 收到异常。可注入 onTick 接收仅含合成资源 ID 和结果类别的观测，不记录原始异常或配置秘密。

## 验证映射与可复现命令

| 冻结矩阵 | A3 证据 |
| --- | --- |
| A01 | 来源事务回滚后零 receipt、attempt、适配器调用 |
| A04 | 真 PostgreSQL 双 worker 锁竞争；提交之前零调用、提交后唯一投递 |
| A05 | 失联预留的 unknown 审计与高 fence 重抓；过期前后迟到回调不覆盖当前状态 |
| A06–A08 | accepted 不消费、accepted 无 begin 耗尽、重复物理唤醒唯一 owner、先 begin 后 unknown 不倒退 active |
| A14/A18 | worker 扫描过期 run，释放未确认批次并保留部分已 ack；旧 ack 拒绝 |
| A26 | 独立投递/运行次数耗尽；重建及新输入不恢复预算 |
| A27 | 认证/endpoint/状态分类、持久退避、Retry-After、小时限额、未知响应关联窗口 |
| A28 | 取消、重建、暂停时 I/O、尾部未结束失败、并行任务完整收尾 |
| A32 | 六字段 payload、固定错误审计、未知网络被吞异常后的负向守卫证据 |

这些是 A3 适用条件，不是宣布冻结的 40 个场景全部完成。CLI context、正式 API 权限组合、probe、真实 DNS pinning/TLS/重定向安全、实际 Grok Webhook/并发/取消能力仍分别交付。A2 明确不支持的既有消费者迁移、第三方和提醒来源保持不支持。

worker 集成测试在 PGlite 下对 fetch、HTTP(S)、TCP、DNS（含 promises）及子进程入口安装拒绝并审计的副作用守卫。每例退出检查审计；唯一受控负向用例故意触发被拒网络，验证适配器吞异常仍不能抹去审计，实际发出请求为零。真实 PG 用独立临时集群的实际数据库连接验证锁竞争，不能用 PGlite 代替该证据。

```bash
# Explicitly use disposable state roots when invoking these commands.
pnpm --filter @botiverse/raft-server exec vitest run \
  src/services/externalAgentDispatchPolicy.test.ts \
  src/test/integration/externalAgentDelegation.worker.test.ts \
  --maxWorkers 1 --minWorkers 1
pnpm --filter @botiverse/raft-server test:external-agent-delegation-real-pg
pnpm --filter @botiverse/raft-server exec tsc --noEmit
```

真实 PG 命令使用仓库现有专用执行器，只启停本次临时集群；缺少临时 PG URL 时 required 标志使测试失败，不能跳过后误称通过。所有实际执行同时绑定两个独立临时状态根，并核对现用会话摘要不变。完整日志与版本索引随交付附件保留，最终结果见下节。

## 最终验证记录

最终业务提交 `a1756b8` 固定后完成：

| 验证 | 结果 | 完整日志 |
| --- | --- | --- |
| worker 集成与结果策略 | 20 通过、0 失败（worker 17、policy 3） | desktop-isolated-235036-357174.log |
| 临时真实 PostgreSQL | 17 通过、0 失败（原 A2 13、A3 新增 4） | desktop-isolated-235037-518295.log |
| 完整 server 类型检查 | 退出码 0 | desktop-isolated-235038-669116.log |
| 同阶段核心兼容补验 | 核心 29 通过；同批 worker 14、policy 3 也通过 | desktop-isolated-234021-704062.log |

核心兼容补验早于最后 worker 并发及 Retry-After 小数归整修改；最终定向与真实 PG 在固定业务提交上重跑，不把前轮合计 46 项冒称最终版本的全 server 全量。未运行全 server 套件，未配置远端 CI。

中间一轮类型检查发现网络守卫 mock 的 TypeScript 方法类型不匹配，已修正后完整检查通过；小数 Retry-After 新断言曾失败，已统一向上取整，在固定版本的完整定向套件中通过。失败日志亦保留供核对。

各次完成执行都确认现用会话摘要不变；最终 worker 各例副作用守卫与尾部清理断言通过，真实 PG 执行器已结束并清理本次集群。代码之外的最终提交只补本报告，不需要重复测试。附件提供完整日志、字节数与 SHA256 索引。
