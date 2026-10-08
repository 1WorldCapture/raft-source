# M4 人类 Activity / Inbox / 已读状态实施合同

日期：2026-10-08。状态：**方案定稿供实施；尚未实现、尚未执行下述 M4 测试。** 本文补足 `phase-4-messaging.md` §9 与 `m4-compatibility-contract.md` 的逐端点范围，P5 不再自行解释“最小 Activity/Inbox”。

## 1. 范围与不能混淆的概念

本期支持普通公共/私有频道、人类一对一及 self-DM、这些会话的一级线程、人类结构化 mention。既有 Agent 目录仍可显示，但没有 Agent 消息、任务卡、联合频道投影、附件评论或外部集成事实，不生成这些卡片。

**Read** 是本人在某会话的阅读状态；**Done** 是本人对当前活动边界的完成/隐藏决策；**Follow** 是本人对线程的持续订阅意愿；**Mute** 是本人活动展示/通知偏好。它们不是四个同义按钮。Done 可以附带原合同要求的已读推进，但不会撤销 follow；mute 不删除消息或改变成员关系；仅打开线程不自动 follow；取消 follow 后仍可能有父频道继承的内容读取权。

三个层面明确分开：基础内容授权 → 按请求用途选择关注/活动集合 → 投影本人状态。HTTP history/context 可读并不意味着该线程自动进入 `/messages/sync`；后者与 Socket resume 对线程要求有效 follow。Activity 的 `all` 可以保留原合同规定的未 Done、已取消关注线程条目，不得误套 resume 的 follower-only 筛选。

## 2. 已决定的路由范围

下表路径均带 `/api`。身份、当前 workspace 与对象权限检查先于领域操作；特殊错误优先级按原 handler fixture 保留。

| 路由 | 本期决定 | 必需行为 |
|---|---|---|
| `GET /channels/activity/snapshot` | 实现 | 本人、人类会话集合的权威窗口；`requestId` 必需，`windowId` 省略或 main，filter 为 all/unread/mentions |
| `GET /channels/activity/difference` | 实现 | epoch/afterWatermark 为规范十进制字符串；200 difference/notModified 或409 snapshotRequired，不以消息 seq 冒充水位 |
| `GET /channels/inbox` | 实现 | 原 items envelope、真实 counts、limit/offset/filter/channelId/q/sort；filter 另兼容 unread_mentions；all 包含原规则下未 Done 的 unfollowed 条目 |
| `GET /channels/inbox/done` | 实现 | 本人完成记录；分页与权限复核，不泄漏已失去读取权的旧预览 |
| `GET /channels/inbox/unfollowed` | 实现 | 本人显式取消关注历史，完成态按原读取投影保留；不是所有可读线程目录 |
| `POST /channels/inbox/done` | 实现 | 普通频道/人类 DM 的 Done frontier 事务；thread 输入不冒充普通会话 |
| `POST /channels/inbox/undone` | 实现 | 恢复本人的 active 状态，不改变其他用户的 Done/read |
| `POST /channels/inbox/read-all` | 实现 | 当前 workspace 的本人会话集合，固定快照边界，返回 `{ok,markedCount,scopes}` 与版本化通知 |
| `GET /channels/threads/followed` | 实现 | 本人关注线程、真实摘要与父链权限；不接受代 Agent receiver |
| `POST /channels/threads/follow` | 实现 | body `{parentMessageId}`；检查父消息并 ensure 唯一线程，返回 `{ok,threadChannelId}` |
| `POST /channels/threads/unfollow` | 实现 | body `{threadChannelId}`；记录显式取消，不删除基础内容访问权 |
| `POST /channels/threads/done` | 实现 | body `{threadChannelId,throughActivitySeq?,frontierSpace?}`；同下述 frontier 守卫 |
| `POST /channels/threads/undone` | 实现 | body `{threadChannelId}`；恢复本人线程活动态，重新计算可见性 |
| `POST /channels/{id}/read`、`/read-all`、`/unread` | 实现本人路径 | 同一 readstate 用例；read-all 与消息并发时只确认已验证的快照边界 |
| `GET /channels/unread`、`GET /servers/unread-summary` | 实现 | 从本人有权事实计算，不用 seq 相减；后者为账号级 literal 路由 |
| `GET/PATCH /channels/{id}/notification-settings` | 实现 | 持久化 activityMuted/muteFromSeq/prefsVersion；静音例外按原人类 mention/线程规则计算 |
| `GET/PATCH /channels/{id}/message-display-settings` | 实现 | collapseLongMessages 与 prefsVersion；独立于 mute 的字段与版本域 |
| `POST /read-mutations`、`GET /read-mutations/frontier` 的新序号器全域 | 本期不开放，授权后501 | 当前原 Web 上述路径仍走兼容 read/Done 接口；不复制跨系统 Agent/任务读状态序号器。P0 必须锁定实际消费方，出现必需调用即阻塞合同签收，不悄悄更改客户端 |
| Agent receiver、任务/工作流 Done、joint、saved、全局消息搜索 | 授权后501 | 不用人类会话接口代办；输入声明这些副作用时提交前拒绝 |

Inbox 的 q 是自身列表筛选，不意味着实现 `/messages/search`。原 Inbox 默认 limit30、上限100；Activity main 窗口为100。两种读取 DTO 不互换，`hasMore` 和总数从真实的授权集合计算，不因本期只支持人类而恒写 false/0。

## 3. 逻辑存储与事务所有权

物理 migration 编号由集成人从0010起串行分配；本文表名是建议，不预先抢占编号。

| 逻辑对象 | 主键/关键字段 | 约束 |
|---|---|---|
| human message mentions | message_id + mentioned_user_id；workspace_id | 目标确属当前 workspace 且能读取相应会话；重复 mention 不重复计数；客户端 name 不作为身份 |
| thread follows | workspace_id + user_id + thread_channel_id；parent_message_id、followed_at、unfollowed_at、revision | parent message/thread/channel 必须相互对应；取消关注保留本人历史；自动 authored/replied 行为用 reference fixture 固定 |
| conversation read state | workspace_id + user_id + channel_id；read_through_seq、unread override、read_state_version | 同事务改变有效阅读状态及版本；相同版本必须对应相同值，禁止同版本不同 maxReadSeq |
| conversation Done state | 同 user/workspace/channel；done_through_activity_seq、done_at、active override、revision | Done 只确认当时已知活动，新消息超过 frontier 后可重新 active；不覆盖 follow 行 |
| notification/display prefs | user/workspace/channel；mute/display 各自字段及版本 | 私人状态，不能放进公共 message payload；no-op 的版本行为按原 fixture |
| Activity principal row authority | user + workspace + row_id；单调 row_version | 同一行跨 all/unread/mentions filter 的内容版本一致；不能各 filter 产生互相冲突的同版本内容 |
| Activity scope | user + workspace + filter + window_id；epoch、watermark、窗口元数据 | 不和其他用户/空间共用 cursor；主窗口固定 main |
| Activity rows / changes | scope + row_id / scope + change_seq；row_version、upsert/tombstone、受限 payload、reason | 每个 scope 的 change_seq 连续；有限保留，缺口要求 snapshot，不补造变更 |

message/channel/readstate 的应用用例在短写事务中校验身份和权限，提交本次消息/状态事实及必要 publication；不在事务内做 Socket 或邮件网络调用。Activity 查询沿用“**基于当前事实 reconcile 后读快照/差量**”的模式：重建受限的人类窗口、对照既有行指纹、仅为真实变化递增行版本和变更序号，与读取响应在同一一致性边界完成。可先取只读事实快照并在提交时校验版本重试，不能在全局 IMMEDIATE 事务中执行不受限的历史扫描。

Socket 通知是唤醒线索，不是 Activity 权威副本。即使通知遗失，下一次 snapshot/difference 都会与持久业务事实重新对齐。本人 projection 日志与用户/空间一起治理和清理，不因 outbox 重试把旧私人 payload 发给失去权限的连接。

## 4. Read / Unread / Done 的裁定规则

### 4.1 本人阅读状态

普通 read 只推进到本会话已经存在且本次有权读取的边界；不得把用户伪造的巨大 seq 作为未来永久“全已读”凭证。read-all 固定授权集合与高水位，随后并发提交的新消息仍可未读。无权消息、别的频道的 seq 空洞、本人发送与原合同排除的系统事件都不能靠算术差混入计数。

显式标未读是新的状态决策，带新 `readStateVersion`。存储可以保持已读事实与 override 分离，但 wire 的 `maxReadSeq` 必须投影**有效状态**，不能因为内部最大值单调而让 UI 永远无法标未读。多端晚到的低版本读响应不能覆盖新状态；序列化的实际服务端裁定顺序决定同一时刻的两个新写入结果，不宣称客户端未携带的因果序号能被服务端猜出来。

人类 mention 参与 hasMention、firstMentionMessageId 和相应筛选；只对被提及且有权读取的人生效。静音不吞掉原合同中 mention/线程的例外活动，也不能替其推进已读。原规则的计数单元（消息还是活动行）、自发消息排除及 Done 对读状态的附带推进，由原函数执行式 fixture 钉死，而不是用示例常数验证。

### 4.2 Done frontier

频道/DM 的 `/inbox/done` 与线程的 `/threads/done` 共用同一 frontier 校验函数，但对象类型、存在性保护和本人残留记录路径不同。

| 输入 | 裁定 |
|---|---|
| 不提供 throughActivitySeq，frontierSpace 省略或 storage | 使用事务内当前权威活动快照，不把请求时间当活动边界 |
| 提供 throughActivitySeq，但省略 frontierSpace | 412，code `DONE_FRONTIER_SPACE_REQUIRED`，要求刷新重试 |
| frontierSpace 不是 storage | 400，code `DONE_FRONTIER_UNMAPPABLE` |
| 明确 storage + 合法边界 | 验证与本 scope 的当前活动权威一致后应用 |
| 缺少/无效数值触发原必要边界错误 | 保留400 `DONE_FRONTIER_REQUIRED` 等原映射，不悄悄按0处理 |
| 边界超过最新活动或原兼容 int4 authority 上限 | 保留409 `DONE_FRONTIER_BEYOND_LATEST` / `DONE_FRONTIER_ABOVE_INT4_AUTHORITY`；不得截断后接受 |

这组 storage frontier 是原 Done 写入的兼容标识，不是 Socket `lastSeq` 或 Activity差量 watermark。即便新 Go 数据库内部使用64位，也不能偷偷消除仍被原 UI 感知的上限和冲突语义；扩宽该合同应另做版本变更。

成功响应遵循原 `{ok:true}` 及适用的残留清理 receipt；不把所有命令改成尚未被原 Web 发出的 commandId 协议。Done 不删除历史；新活动超过已确认边界后恢复 active，显式 undone 恢复本人列表。取消 follow 不等于 Done，二者在 all/unfollowed/done 读取中分别处理。

对于已删线程或已删 DM 父链，仅当调用者具有原规则认可的**本人残留记录**，才允许清理自己的旧 Activity 状态；否则统一404，不能通过“对象曾存在”或其他人的 Done 状态泄漏资源存在性。活跃但已撤权的私有父链仍需拒绝，不能借残留路径恢复其内容读取权。

## 5. Activity snapshot / difference 线协议

权威类型源为 `packages/sync-core/contracts/activity-v1/activity-sync.tsp` 及其 generated bindings/schema，运行参考为 `packages/server/src/services/activitySyncService.ts`。不修改 generated 文件，不把 TypeScript 类型存在当作 Go 输出通过了运行验证。

scope 是 `{serverId,principalId,filter,windowId}`。epoch、watermark、rowVersion、Activity 中的 maxReadSeq/readStateVersion 均使用**规范 UInt64 十进制字符串**，不是 JS number。解析拒绝符号、空格、前导零（除单独0）、小数、指数及越界；SQLite 本地计数可限定在非负 signed64 范围，但必须明确处理收到更大合法 wire 值的恢复/冲突，不能溢出或经 float64 中转。传统消息 DTO 的 seq 仍是安全整数，两套投影不得混用。

精确返回族：

```text
200 snapshot:
  {type:"snapshot",requestId,scope,epoch,watermark,activityVersion,window}
  window = {rows,tombstones,nextCursor,hasMore,complete,totalCount,totalUnreadCount}

200 notModified:
  {type:"notModified",requestId,scope,epoch,watermark,activityVersion}

200 difference:
  {type:"difference",requestId,scope,epoch,fromSeq,toSeq,activityVersion,
   rows,tombstones,nextCursor,hasMore,complete,totalCount,totalUnreadCount,nextFromSeq}

409 snapshotRequired:
  {snapshotRequired:true,requestId,scope,epoch,watermark,activityVersion}
```

本期沿用参考的100行 main 窗口、每 scope 最多2048条变化保留作为初始实现参数，而不是已压测容量。差量以 `(afterWatermark,currentWatermark]` 为完整连续范围，去重到每个 row 的最后一次有效变化；fromSeq=after+1，toSeq=current，当前不拆分差量时 nextFromSeq=null。元数据单独变化也须进入水位，不能返回旧 counts 的 notModified。

epoch不符、after超前或保留窗口已无法覆盖时返回409让原客户端重新 snapshot；相等且确实无变化时才200 notModified。不能恒返回409替代差量实现，也不能越过没有扫描或已被清理的变更宣称无洞。重启保留水位/epoch；scope重建、权限导致受众语义变化时明确换 epoch，避免旧差量重新引入已不可见预览。

tombstone 的 reason 只能使用原枚举 done/deleted/outOfWindow；如果无法忠实表达失权，不新增客户端不认识的 reason，而是换 epoch要求新快照。upsert内容、行顺序、rowId格式、filter联动与同一row跨filter版本关系以原生成schema和执行向量校验。授权失败仍为401/403/语义404，不伪装成空snapshot。

## 6. 多端事件、恢复与隐私

状态提交后通过 publication 接口通知：`read_state:updated` / `read_state:updated_bulk`、`unread_summary:changed`、`notification_prefs:updated`、`message_display_prefs:updated`。私人内容使用用户与workspace的交集；后两者的 prefs envelope 与 prefsVersion 按 compatibility 表冻结，不能平铺成另一种形状。

`thread:followers-updated` 仅携带 `{threadChannelId}`，向当前有权线程受众发失效提示；本人关注列表同时通过现有刷新路径与HTTP状态对齐。`scope_read:updated` 是受权限约束的共享阅读回执投影，不能夹带完整私人 read/Done/mute 行。

断网恢复分别验证：新消息由 message sync 恢复，reaction/线程摘要由50条HTTP overlay页及当前本地200条窗口恢复，个人已读/未读/偏好由HTTP状态读取恢复，Activity以snapshot/difference恢复。任何一层“socket发出成功”都不能替代另外几层的恢复证据。

## 7. P5 的执行退出标准

P0先冻结原TypeSpec/schema、真实handler/纯投影输出、原Web normalizer/reducer消费结果；P5复用这些非生产fixture，并添加以下行为测试：

1. all/unread/mentions 三filter及 Inbox unread_mentions，普通频道/私有/DM/self-DM/线程有真实行、排序、计数和分页；q仅筛选有权列表。
2. 两标签页 read → unread → 旧read响应晚到，保留较新版本；同一版本不同值被检测；本人发送不制造虚假未读。
3. follow/unfollow/Done/undone分别变更；Done后新回复恢复active；未关注但可读线程history正常而resume不带该线程；丢失父频道权限后全部内容路径拒绝。
4. Done四种输入矩阵、超前/超上限409、本人删除残留与陌生人404，失败零越权写入。
5. read-all与并发新消息竞争、跨workspace scope与代Agent输入拒绝、mute+人类mention例外、显示偏好多端事件。
6. snapshot→difference→notModified；2048条保留边界外409；epoch变化、跨scope误用水位、最大整数/异常字符串、并发相同请求与重启。
7. 原Web reducer执行接受所有真实wire，50条overlay请求不误写成200；private payload从未出现在公共room；日志无正文/密钥。

上述均为待实施的门槛，不是当前M3补丁的测试结果。P5任何“未启用”例外必须与本路由清单逐项签收；不能在最后把必需的Done或差量读取改成永远空数据，以便声称M4已完成。
