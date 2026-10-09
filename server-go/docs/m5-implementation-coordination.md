# M5 实施切片、检查点与验收责任

日期：2026-10-08（America/Los_Angeles）  
输入：[深化设计](phase-5-delivery.md)、[协议证据](m5-protocol-evidence.md)、[UI 反馈分诊](m5-ui-feedback-triage.md)。

**本文是可执行工作计划，不是已经启动的后台任务或完成记录。** 责任人以角色表示，实施派工时绑定具体协作者。M5 是最后一个产品阶段，以下是 M5 内部切片，不增设 M6。不改 Web/CLI/Daemon 源码与锁文件；纯客户端问题在分诊表保留阻塞/交接状态。

## 1. 本轮起点

本轮已经修复并完成后端验证：系统频道隐式发帖、Pre-join Agreement 的明确未启用响应。`make check` 和 Linux/Windows CGO-free 交叉编译通过。原有 4301/5175 进程未重启，UI 未复测；M5 的新迁移、delivery 服务和 Agent 收发尚不存在。

稳定化后的 auth、channel、message、readstate、publication、machinews 必须保留唯一实现，不新建一条平行的 M5 handler/Store 链。M5 新入口按能力命名，例如 `SendAgent`，而不是 `M5Send` 或阶段开关。

## 2. 实施顺序与出口

| 切片 | 主责角色 | 输入与实际工作 | 退出检查的责任与证据 |
|---|---|---|---|
| S0 协议与保证冻结 | 协议负责人；集成负责人审核 | 原 Web mention/原 CLI send/check/claim/ack/原 Daemon start+delivery；无业务 wake 的首次 session；早 ACK/start 失败；原版客户端 cohort | 独立协议审查确认字段/错误/身份矩阵；标明至少一种 runtime 的真实执行证据和所有尚未签收路径。不能以模拟器替代原进程 |
| S1 数据与事务所有权 | delivery/agent/message 领域负责人 | 新增 0014+ migration、Agent mention facts、逻辑意图、attempt/claim、持久 launch；constructor 依赖；唯一键/复合 FK/CHECK/index | 集成负责人检查迁移 hash/跨空间约束；测试负责人注入写失败并验证 rollback；先通过升级副本与 schema gate |
| S2 显式 mention 原子提交 | messaging 负责人 | SendHuman 统一解析、权限、源去重、多个目标、意图事务内计划；保持现有人类 publication/read 顺序 | 集成负责人检查同一 write transaction；测试负责人覆盖 illegal target、randomId replay/conflict、崩溃与关联行无孤儿 |
| S3 派送与回执 | delivery + machinecontrol 负责人 | 有界调度、持久退避、current connection guard、准确 wire、ACK/transition/error、lease CAS、同 occurrence 重试 | 安全审查检查锁序与撤权到发送窗口；测试负责人执行 ACK 丢失/乱序/伪造/晚到/Send 返回晚于 ACK 的竞态 |
| S4 Agent 读取与回复 | Agent API/CLI 契约负责人 | Agent-only proof、target DSL、history/context、SendAgent v1/v2、claim/ack；两种 clientMode | 协议负责人运行原 CLI；UI 协作者确认消息身份/正文/线程显示。只能在真实消息提交后报告发送成功 |
| S5 冷启动、恢复与交接 | Agent 生命周期负责人 | 持久 startDispatch、launch/session 恢复、机器离线/停止/移机、OnReady 扫描、briefing 意图与人的 handoff 分离 | 测试负责人跑服务端/Daemon 独立 crash 矩阵；集成负责人逐条确认“已知回执”与“未知副作用”没有混同 |
| S6 Agent DM 有界闭环 | channel + messaging 负责人 | 独立 typed pair、参与者授权、创建幂等、原 Web 开 DM DTO、direct-message 收件策略、Agent 回复 | 集成负责人检查不污染原人类 DM；UI 协作者确认实际进入会话。未完成前保持 Agent DM 明确 501，不提前开放按钮成功态 |
| S7 集成、升级与 UI 发布验收 | 集成负责人，UI 协作者独立签收 | 全量后端 gate、原客户端流程、升级回退、queue 诊断、默认频道与管理降级复测、客户端遗留问题结论 | 后端测试负责人交命令/输出；UI 协作者交截图/HAR/控制台；集成负责人确认所有必做项与公开保证一致后才晋级 Stage |

依赖：S0 → S1 → S2 → S3；S4 的原协议 fixtures 可与 S1 并行，实际发送/收件接入依赖 S2/S3；S5 的启动 spike 必须在 S0 提前做，完整恢复依赖 S3/S4；S6 依赖 S4 的稳定授权/回复；S7 汇总全部必做出口。不能把 S0 的关键身份缺口留到最终 UI 才发现。

每个切片产物包含变更范围、真实执行的命令及结果、未完成/不适用项、受影响 schema/route manifest 和下一检查点负责角色。没有检查者的“完成”不视为可交接。

## 3. S0 必须拍板的细节

### 原协议，非自创字段

从原代码冻结正反例：Web structured mention 的完整请求；Agent send v1/v2 的规范结果与错误；AgentMessage 的 snake_case 及 sender_type 映射；start ACK 四种 queueState；完整/缺失/伪造 mentionDelivery；legacy check 和 claim/ack token 的合法使用范围。

managed runner 与 self-hosted runner 分开运行。至少一个拟支持 runtime 用原 Daemon 证明首次启动如何取得 session，重连是否保持同一 launch/session；有证据后才配置可投递 cohort。仅 daemonVersion 达到某个 semver 不足以证明所有 driver 都提供消费确认。

### 回执保证

基线明确接受“Daemon reported receipt”，不承诺模型消费 exactly-once。将 `agentProcessManager.ts:4361–4388` 的启动缓冲提前 ACK 作为必须记录的兼容局限。需要强保证时，不允许通过后端改名掩盖；相关路径必须标未支持强保证，并列出升级客户端协议所需的后续独立变更，不能偷偷修改当前客户端。

最终产品签收至少仍需真实输入—Agent 回复闭环。ACK 语义较弱不是允许永远只有队列没有回复的借口。

## 4. 并行工作边界

共享文件由集成负责人单点修改：组合根、依赖构造、路由 manifest、migration 编号/顺序、公共 presenter/协议 DTO、Makefile 验收集合。协作者可以提交变更建议/独立 patch，不能同时覆盖这些文件。

领域工作按所有权拆分：message/mention、channel/DM、agent/launch、delivery/receipt；HTTP/machinews 不直接写表。领域方法必须接受同一 executor/transaction 语义，不在内部启动嵌套顶层事务。

新增 schema 时复用真实 agent/workspace 复合约束。外部 Agent 的 claim 路径没有机器/launch/session；managed attempt 必须具备这些快照。通过 transport_kind 的条件 CHECK 分别约束，不能为外部 Agent 生成假机器或 session。

源码变更不能直接操作 `var/`、`var-m3-dev/`、`var-m4-ui-test/` 或他人的测试实例。每名执行者使用独立数据目录、动态端口和自己的测试进程；禁止为了“端口占用”结束协作者的服务。

## 5. 验收矩阵的执行要求

### 事务与幂等

测试消息插入前、插入后意图写失败、commit 后 HTTP 响应前、publication wake 前等窗口。对用户和 Agent 分别验证相同 randomId 回原消息、不同摘要报冲突、重放无多余收件/关注/publication；多个 mention 目标不能形成半笔提交。

### 身份与撤权

独立两个空间、两个 Agent、两台机器、两个同账户 session family。覆盖跨空间目标、错误凭据类别、Agent key 撤销、私有频道移除、隐藏 #all、归档、删 Agent、移机、旧连接/旧 launch/旧 session 的 ACK。重点检查授权之后到发送准入之前的窗口，并用 race 与受控 barrier 稳定复现，不能只用随机 sleep。

### 丢包与崩溃

至少覆盖：送出前 crash；收到但 ACK 丢失；ACK 已落库但响应/后续事件丢失；start queued 后失败；旧 daemon 消失新 launch 接管；服务端 restart 保留旧 daemon；服务端与 daemon 同时 restart；claim 后调用方崩溃；ACK 后业务未执行。

最后一种不是可伪造恢复的成功项，必须报告协议边界。exactly-once 外部工具执行不在本期保证内。

### 升级与回退

使用真实冻结 M4 二进制生成的数据副本升级到 M5，确认 signing key、session、Agent/Computer credentials、messages.seq、history/readstate 不变。新迁移不改 0001–0013。旧程序拒绝新 schema 并允许匹配冷备恢复；在恢复后的旧实例继续写入。整个测试过程只动临时副本。

### UI 与未解决客户端问题

复测见 `m5-ui-feedback-triage.md`：默认频道直接发帖，Agreement 不再裸 Not found；人类 DM 返回后实际路径/面板是否切换；Agent DM 未启用时错误可见；换账号不泄露草稿；Office 关闭时默认 List；Activity All 与 Unread 语义分开。

当前“客户端源码冻结”边界下，纯前端草稿隔离/错误提示/默认视图无法在本轮 Go 补丁内闭合。UI 协作者应在其客户端维护路径单独处理并返回验收；它们不能在 Go 交接上被写成已修复。尤其跨账号草稿建议按隐私问题提升到 P2。

## 6. 每个切片的统一检查命令

正常开发可以先跑定向包测试；合并前不能只保留子集。最低 gate：

```sh
cd server-go
make check
make cross-build
```

M5 新增的 schema/client fixtures/真实线协议/crash suites 必须纳入完整 gate 或明确独立必跑的验收命令。不要通过更新 golden、skip、移除 suite 或缩小 SUITE 掩盖行为漂移。新的 fixture 是新能力的证据；旧 fixtures 保持不变。

源码检查还应包含 `git diff --check`、受保护路径无修改、迁移 hash/inventory、无新增 transport SQL、无 app 业务、无 placeholder success、所有工作线程关闭后再关 DB。

## 7. 发布与交接

本轮 `make check` 已重新构建 `server-go/bin/raft-server`，但原 4301 进程仍是此前运行实例；“磁盘二进制已更新”不等于“进程已加载补丁”。由运行环境责任人在其测试窗口加载新构建并记录进程/build identity，UI 协作者再复测。不要把旧进程截图用于新补丁签收。

M5 实施完成的最终交接须逐项列出：支持的原客户端版本/runtime、可靠性保证与限制、真实 Agent 回复证据、后端命令结果、UI 签收、迁移/回退方法、未解决 issue 及责任角色。只有全部必做项都有证据，才能标 M5 complete；本文不预先晋级当前 build stage，也不创建任何提交或 PR。
