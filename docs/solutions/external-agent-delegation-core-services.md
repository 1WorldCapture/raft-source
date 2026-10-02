# 外部 Agent 委托执行：A2 核心服务与提交保护

2026-10-02。对应设计 v1.1 第 3–6、12 节及阶段 A 冻结矩阵。任务：#grokbot-integration task #5；技术审核：Anna。基线为已合 A1 的 f7eea01；本报告描述服务实现，不代表真实 Grok 接入、部署或阶段 A 全部完成。

## 行为与服务边界

配置、回执、调度和运行事实使用 A1 六张表。`ExternalAgentConnectionService` 管理草稿、绑定、密钥、切换、暂停、恢复、重试和显式回滚；`ExternalAgentDelegationService` 管理 wake、dispatch 预留、begin、租约、结束和扫描恢复；`ExternalAgentInboxReceiptService` 管理来源投影、固定批次、限定正文读取、部分确认和可靠交接。

暂停或解绑保留 delegated 消费模式，旧 drain、裸 ack、history、send/task/channel、桥接等入口继续拒绝。只有授权的人类显式回滚才恢复 legacy。blocked 和 exhausted 保留当前 cycle 和预算；新输入只追加回执。普通恢复不重开预算，人工 redrive 建立有前序关联的新 cycle，并保留审计及频率限制。

begin 使用请求摘要、256 位 ownerToken 的散列及稳定请求键恢复原 run，不续租、不复活过期运行、不返回 ownerToken。单 run 只有一个 open claim；相同批次键重放返回原成员，已 released 的历史批次可以核对但不能恢复执行权。ack 检查身份、run、epoch、fence、claim 成员、期限和当前来源权限；不适用项保留 suppressed 原因，不伪装成 processed。

发送重放也重新验证执行权和目标权限；变更同一幂等键的正文、目标或附件集合会冲突。可靠交接必须引用当前真实人类承担的持久任务与服务器保护的审计记录，普通消息或空任务不足以证明交接。

## 事务授权

`agentTransactionAuthority.ts` 以稳定 Agent UUID 映射 PostgreSQL 事务 advisory 门。即使没有 connection 行也有同一互斥边界；多 Agent 按 UUID 排序取得全部门，再读配置、运行、凭据、权限和业务行。权限及凭据从服务端身份重新解析，没有调用方布尔参数跳过检查。

事务能力使用私有 WeakMap 认证并在退出时失效。复制对象、修改暴露的 Set 或重用已提交的 context 不能制造授权。来源受众扩大时整体回滚、重新规划，有界尝试三次，不能持业务行锁再补较早的 Agent 门。事务锁等待和语句都有上限；最终业务写入后再次使用数据库 `clock_timestamp()` 检查租约，异常导致整笔业务回滚。

人类管理无需 run，仍在同一事务复查成员资格和管理权限。delegated 业务必须有绑定凭据及有效运行上下文。bootstrap 独立提供脱敏状态，不增授业务权。更改运行类型或绑定 Computer 前必须先显式回滚委托模式。

## 安全切换与不支持边界

旧内存队列、阅读游标和历史消息都不能证明完整待办。当前实现只支持两种切换证据：

1. 创建新 Agent 与首次启用在同一事务完成。私有出生证明认证本事务真正插入的身份，提交前身份及凭据不可被旧消费者使用；审计保存可重放的空清单证明。
2. 已处于 delegated 的绑定恢复，使用已有持久回执，不从 legacy 队列重建。

普通既有 legacy Agent 返回 `legacy_pending_completeness_unproven` 并保留原消费模式、凭据、输入及审计状态。回滚后的 legacy 身份也不会因为队列为空重新放行。没有实现旧队列迁移清单适配器；这是明确的不支持分支，不能声称所有旧 Agent 可以迁移。新身份创建辅助端口是服务内部的原子创建动作；将它暴露为网络 API 时，A4 仍需明确创建请求重试与一次性凭据交付契约。

消息通知、任务正文、工作流任务、操作卡片、外部消息入站和手动 mention 通过既有 canonical 通知事实投影。来源、通知事实、receipt、generation 和 wake 在同一提交事务，投影失败不留下已提交的孤立来源。手动 notify/add 以真实 mention 发生身份分别去重，相同正文的合法新发生记录独立保留。

来源权限复用现有频道、联合频道及线程解析器，并核对本地来源服务器。公开频道、公告提及、线程关注、私有权限移除及静音规则有定向服务回归。联合频道/DM 的完整生产矩阵仍应在后续 API 集成验收补足；复用解析器及原读取兼容测试不能冒充每种来源都已独立跑完。

第三方事件及提醒到期没有本轮 receipt 生产适配器，状态能力明确为 false。第三方事件向 delegated 身份输入会在原始事件插入前拒绝；旧第三方消费、重建及状态提交同样检查模式。提醒的旧 Agent 创建/修改/确认端口拒绝 delegated 调用；包括人类来源在内，给 delegated 接收者创建或替换提醒也在提醒和来源事件写入前明确拒绝。没有真实 Webhook、外部网络 adapter、worker、probe、API 或 CLI 新入口；这些属于后续阶段。

## 旧入口及路由外调用者

[逐项登记](external-agent-delegation-old-entrypoints.json) 列出原 94 条静态登记的当前代码位置、调用线索和入口策略。登记不等于每个内部函数都支持 delegated；下表给出实际提交边界及拒绝策略。

| 范围 | 实际提交保护 / 调用者 | delegated 策略 |
| --- | --- | --- |
| 消息及发送重放、附件关联 | messageService、agentSendReplayService；生产发送路径共享实际事务，附件关联沿用同 executor | 有经过验证的运行上下文可以提交；无上下文拒绝；发送与目标权限最终复查 |
| 任务创建/认领/取消/状态/指派/修改/删除/正文转任务/资源凭据 | taskService 的实际写入事务、任务事件和通知投影；tasks 人类路由及内部 Agent 路由传真实 actor | 新认领和状态服务端口可接运行上下文；其他旧 Agent 调用拒绝。force 旧入口不接受 delegated 上下文 |
| 阅读 intent 与晚到 worker | readMutationSequencer 入队及效果提交两层；markAgentLegacyRead/checkpoint 共用 Agent 门 | delegated 旧读取拒绝；遗留读取 intent 无效果退休，零游标推进 |
| 频道创建、管理、成员、退出、静音、取消关注 | 创建取得 Agent 门后复用 quota 锁；withLockedChannelActorCapabilities 包住实际频道锁及写入；成员端口实际 executor 规划目标门；旧自助服务传 actor | delegated 旧 Agent 调用拒绝；人类管理保留既有权限；受众变化需回滚扩门 |
| Agent 创建、资料和 Computer 绑定 | agentService 同事务出生证明；资料更新带真实 actor；绑定检查消费模式 | 无 run 的旧 Agent 创建/资料写入拒绝；人类更改运行类型或绑定 Computer 先回滚 |
| 凭据撤销、配置、密钥、模式切换 | agentCredentialService 和 connection 服务在目标 Agent 门内复查管理者并撤销运行、claims | 人类管理与业务提交按数据库提交顺序排序；输入不被批量确认或删除 |
| 工作流、操作卡片、手动 mention | 实际业务事务授权、canonical 通知事实同 executor；mention 的 delegated 接收者绕开易失 delivery 回调 | 旧 Agent 写入拒绝；合法人类来源和接收者投影仍可提交 |
| 应用配置与提醒 ACK/CRUD | rapAppConfigService、reminder 服务实际事务；提醒 ACK 不把 App Inbox 持久化当当前执行权 | delegated 旧写入及裸 ACK 拒绝 |
| 第三方事件及消费状态 | oauthService 原始插入、重建、claim/release/delivered 实际 Agent 门 | 明确不支持 delegated 来源及旧消费；不静默确认 |
| 上传会话、下载/知识/搜索、集成管理、MCP、反馈、Wiki、wake-hints/activity | 老 agent-api 最早的统一守卫先于验证器、桥接、网络或正文处理 | 全部明确拒绝 delegated；没有声称其内部服务新增 run 支持 |

旧 agent-api 唯一白名单为身份 `GET /`。回归从实时 shared 合约枚举所有旧方法/路径，并补直注册路径及未知桥接路径，确认暂停后的 delegated 仍在 handler 之前拒绝。不能把 GET 自动视为只读。

路由外核对重点：`internal.ts` 是 Computer 身份路径；external 身份无 machineId，真实 Computer 不能认领它。内部桥接 sentinel 只在 agent-api 认证和统一守卫之后设置，不是网络身份。agentOrchestrator 的同步易失队列移除不改 receipt；新身份提交前没有合法旧消费者，后续 delegated 旧 HTTP 入口也不能进入队列路径。此兼容论证依赖“既有 legacy 切换不支持”的明确边界，未来支持迁移清单时必须重新验证旧请求和来源收敛，不能仅删除这个不支持错误。

## 恢复审计增量

迁移 0271 扩充既有 `product_events` 的 subject/event 白名单，写入 connection 恢复与 receipt 交接事件，没有再建重复领域表。记录使用 strict 闭合元数据、同事务插入、稳定幂等键；审计失败会回滚状态变更。密钥使用服务器配置注入的 32 字节 keyring，以 server/agent/connection/purpose 作为 AES-GCM 关联数据；DTO 仅显示已配置状态与指纹。没有生产迁移。

## 验证与可复现执行

核心回归位于 `src/test/integration/externalAgentDelegation.services.test.ts`。真实多连接竞争位于 `src/services/externalAgentDelegation.realPg.test.ts`，使用独立观察连接查询 `pg_blocking_pids`，不用固定等待猜测先后。

仓库内执行器创建仅属于本次调用的临时 PostgreSQL 集群、独立回环端口和双临时状态根；不接受既有数据库 URL，退出时按精确 data 目录清理，异常清理失败也会报错。缺真实 PG 时 required 路径不能以 skip 报绿：

```sh
pnpm --filter @botiverse/raft-server test:external-agent-delegation-real-pg
```

需 PostgreSQL 的 initdb/pg_ctl 在 PATH 或显式设置 `RAFT_A2_PG_BIN`；Mac Homebrew PostgreSQL 16 有默认探测路径。普通测试也必须显式将 RAFT_HOME/SLOCK_HOME 指向临时目录，不能继承当前托管根。

结果和最终源码提交号见下面的交付附录。中间失败已修正且保留原日志，不把旧提交通过结果当作最终树全量通过。没有运行 server 全量、真实 Grok、登录、浏览器或部署。

## 阶段 A 矩阵映射

| 骨架编号 | 本服务范围与后续责任 |
| --- | --- |
| A01–03、A08–10、A12、A14–18、A22、A24–26、A31–32、A38–40 | 来源原子性/发生身份、begin 恢复、固定批次/部分确认、权限/租约/迟到清理、恢复与预算有核心回归。A09 请求前文件及 A22 真正新 API 身份链仍由 A4 完成；A30/A31 的来源与旧切换不支持边界如上 |
| A11、A13、A18–20、A23、A35–36 | 独立真实 PG 覆盖并发 begin/claim、数据库时钟到期、暂停/凭据撤销两序、finish/input 两序、无 connection 配置门、新身份切换/source、多 Agent 双向生产。A21 逐种权限/配置变更的两序尚应在 API 集成矩阵扩展；不冒称所有撤销类型已独立验证 |
| A04–07、A27–28 | A2 提供持久 dispatch 预留/回调/恢复端口；真实 worker、fake adapter、传输分类、重建和副作用隔离归 A3 |
| A29、A33–34、A37 | probe 属后续真实 adapter/接入阶段；CLI 每轮文件/权限/身份恢复归 A4。当前没有对真实提供方宣称可用 |

本表是范围与证据映射，不是“40 项已全过”。后续 A3/A4 使用这些服务接口仍必须按原冻结行为补集成，不因本 PR 通过而解除真实提供方验证条件。


## 交付验证附录

实现提交为 `3fdef79664e40d865d3caf624b5a9db58343528b`，已从开发基线 f7eea01 同步到 dev@9c85b92。同步只带入 A1 bigint 注释修正及 Computer 独立判活修复，没有修改本实现的服务行为。最后审计修正把 resume/redrive 的结果版本写入审计，并保留单独的请求版本。

| 验证 | 结果与边界 | 完整日志 |
| --- | --- | --- |
| 核心服务主体 | 29 通过、0 失败；审计版本修正前的完整核心套件，不替代后面的修正复验 | desktop-isolated-230150-416836.log |
| 独立真实 PostgreSQL | 13 通过、0 失败；仓库内临时集群执行器实跑，独立观察连接证实竞争等待 | desktop-isolated-230151-497290.log |
| 线程发送补验 | 1 通过；补齐真实归档操作者后复验同事务投影/父级权限，28 项由筛选跳过 | desktop-isolated-230457-593501.log |
| 恢复审计最后修正 | 2 通过；blocked 恢复及 exhausted 人工重试的结果版本、请求版本、预算、幂等及审计关联，27 项由筛选跳过 | desktop-isolated-230751-200998.log |
| 提醒调度兼容 | 完整提醒 contract 14 项及 CRUD 2 项通过；同批核心 27 项通过，1 项因测试 fixture 字段拼写失败，已在完整核心复验修正 | desktop-isolated-225525-909714.log |
| 静音及提醒 ACK 修正 | 6 通过；89 项由筛选跳过，不计作平台跳过或新增通过数 | desktop-isolated-224944-351887.log |
| 第一批兼容 | 103 通过、1 跳过；这是更早代码采样，覆盖阅读、提及、任务、工作流、回执、应用配置和发送重放，不冒充最终源码全量 | desktop-isolated-222222-325102.log |
| 第二批兼容 | 190 通过、6 失败；失败为新事务静音嵌套根查询和提醒 ACK 的数据库 UUID 兼容，已修并以上述定向及完整提醒复验确认 | desktop-isolated-223437-388998.log |
| 最新同步后类型检查 | tsc --noEmit 退出 0，使用独立增量缓存；实现提交 3fdef79 保持稳定 | desktop-isolated-230932-352178.log |
| 来源与操作卡片补验 | 11 通过；联合入站、线程投影、来源失败回滚、私有操作卡片及 capability；38 项因筛选跳过 | desktop-isolated-231339-599456.log |

每次隔离执行器前后都核对现用会话摘要，全部已结束的执行保持不变。普通日志保存子命令完整输出；执行器退出码及会话摘要核对另保存在交付证据索引。没有把重叠批次相加成一个虚构总数。没有跑 server 全量或远端 CI；后续 PR 检查结果单独记录。

迁移快照逐表对照 0270：没有新增/删除表，非 product_events 表零结构变化；唯一变化是 product_events 的两项有限白名单约束。94 条登记均已解析当前位置，静态清单仍不等于所有内部调用都具备新运行上下文。

完整日志的 SHA256：

- `desktop-isolated-230150-416836.log`：`0b4268743ce3c5ba70c91169d183959caaef57ba96aaee74b38ef3e407155db6`
- `desktop-isolated-230151-497290.log`：`987000bd729e181c4f38f991f4b1224778e88aa4d26249de1de150ea8d469496`
- `desktop-isolated-230457-593501.log`：`dfddf8b6798d11edf4c7c27a66bdea6c33462f0bf10f0d3aa96467a9e712e046`
- `desktop-isolated-230751-200998.log`：`82c9da2266759c82cff858bf4ffd9ceca788a8353fb352ab24cf7453b149174a`
- `desktop-isolated-225525-909714.log`：`1e012e979f854abdcf2018b8a63f4746a3f55aa68b7a06919342e9f46c044a0c`
- `desktop-isolated-224944-351887.log`：`581baf33593ffa8a8584cfc45fe836dadd439108e202bf9d23c9f2a3c46db6a5`
- `desktop-isolated-222222-325102.log`：`1a5bd7e0d078171165fee383f06f3bde3bb5db4db53a76037ba754079cfab512`
- `desktop-isolated-223437-388998.log`：`9659372c2412f645f8160477fcba6e3576faeac3388a46de1f69192e7fafee34`
- `desktop-isolated-230932-352178.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `desktop-isolated-231339-599456.log`：`337e0333e21a4521d091b64ef01bc7c9c294f85b4415f01d41f334f408ae17b0`
