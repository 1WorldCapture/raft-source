# Raft Go Server M2：实施结果与后端验收交接

## 1. 交付状态与范围

M2 工作空间后端已实现，完整 `make check` 已通过。所有修改位于 `server-go/`，沿用单进程、SQLite、M1 账号与会话；没有引入 PostgreSQL、Redis、TS 运行后端，也没有修改 Web、CLI、Daemon 来适配 Go。

实现参考基线：`c4a5015deb7dcc8b800df96675d899f384f76e36`。输入设计 `docs/phase-2-workspaces.md` 和原 `contracts/legacyweb/workspaces-route-matrix.json` 保留原稿；其中两处与真实 TS HTTP 输出不一致的简写，见第 4 节。开发修改未提交，未修改用户原 `var/`，未对其真实数据库执行升级或启动替换服务。

**后端验收通过，不等于原 Web 浏览器验收通过。** 本次没有启动浏览器、Vite 或原 TS Server，也没有执行完整 PostgreSQL/TS 与 Go HTTP 差分测试。UI 协作者仍需按第 8 节独立验收。新 owner 的本期终点是正确的 Computer 初始化门禁，不是完整聊天。

## 2. 已实现接口

以下全部沿用原 `/api/servers` 命名、`X-Server-Id`、ServerRecord/ListItem 及错误形状。用户级列表/创建/order 不受任意外来空间请求头改变；空间级路由验证 header、URL、真实 membership、软删除和 joint_storage。

| 编号 | 方法与路径（公共前缀 `/api/servers`） | 实现内容 |
|---|---|---|
| W01 | POST `/` | 单事务创建空间、owner、setup、偏好、协议审计、系统频道及可选 opener |
| W02 | GET `/` | 成员资格过滤、账号排序、版本、计划历史窗口和 trial 边界 |
| W03–04 | GET/PATCH `/order` | 去重、过滤、追加未列出的空间、有效无变化不加版、事务内版本递增 |
| W05–06 | GET/PATCH `/:id` | 裸记录；owner/admin 名称、hideHumansFromMembers 更新 |
| W07 | POST `/:id/avatar` | 权限先于解析；校验/重编码；私有临时文件原子发布；更新真实 DB 引用 |
| W08 | GET `/:id/members` | joinedAt 目录、角色、邮箱可见性、hideHumans、guest 拒绝 |
| W09–11 | GET `/:id/settings`，GET/PATCH `/:id/onboarding-settings` | 聚合/旧别名/本人偏好/授权管理字段；组合写事务与 owner checkpoint reconcile |
| W12–15 | GET `/:id/setup-projection`，POST `/:id/setup-transition`、`setup-reset`、`setup-handoff` | 完整投影、start/complete、reset 实际撤销、首次 handoff 与 session family 持久事实 |
| W16 | GET `/:id/sidebar-order` | 19 字段投影、typed/legacy pinned、目录存在性和可见性清洗 |
| W17 | GET `/:id/machines` | 真实最小机器目录读取与原响应信封；不提供注册/连接 writer |

成功创建返回 200 + 裸 ServerRecord。创建者来自当前账号，不接受 body.ownerId/role/plan/setupStatus 授权。创建故障注入覆盖 workspace、membership、setup、preferences、audit、channel、opener roster 写入，失败不留下半个空间。

系统频道已真实持久化：#all 与 #announcement；opener 开启时 #all 为 private，并额外创建普通 private 的 onboarding-owner 与 owner roster。它们不意味着完整频道 API 或消息能力已完成。

## 3. 初始化与持久化

新空间 owner 投影为 `computer_runtime / not_started`，`blocksChat=true`，`gateReason=computer_offline`，`runtimeStatus=unknown`，不是 complete/deferred/null。GET 无推进副作用，刷新和进程重启保留事实。

显式 complete 检查真实官方 onboarding Agent 的本空间、有效记录、machine/runtime 和身份条件；普通名叫 Cindy 的 Agent 不满足条件。授权 onboardingAgentId 配置 setter 是 TS 另一条路径：有效本空间记录触发所有未完成 owner → complete/grandfathered，不重复官方身份校验，已完成原因不被覆盖。

reset 按空间 ownerId 鉴权，在同一 IMMEDIATE 事务内检查 checkpoint、撤销未撤销 Computer 并重置 owner setup，不删除空间/频道/账号。handoff 允许原 TS 的提前调用，但只记录首次 acknowledgment、账号首次完成时间和 session family，不推进 setup；本期没有 Agent 投递，不写“briefing 已发送”。

最小 machines/computers/agents/agent_members 是真实目录表，不建立影子目录。产品没有注册/Agent 创建入口，正常新库目录为空；fixture 用来覆盖后续契约，不作为产品成功接入证据。没有连接层就不伪造在线：setup 对不可确认的机器事实保持 unknown，目录按当前无连接事实给出离线/未知字段。完整 schema 和 M3 接入边界见 `m2-directory-schema.md`。

## 4. 源码核对后保留的契约与差异

**输入设计的两处简写已按实际 TS 修正实现，而不改原稿：**

- W17 返回 `{machines, latestDaemonVersion, latestComputerVersion}`，不是裸数组。证据：`packages/server/src/routes/servers.ts` 的 `GET /:id/machines`（基线 2643–2773）。本地没有版本发布源时两个版本提示为 null。
- 即使持久化 `sectionOrder=[]`，响应也包含 `system:pinned`、`system:joint`、`system:channels`、`system:dms`。证据：同文件 `canonicalizeSidebarSections`（约 510–542）和 `hydrateSidebarPinnedResponse`（698–716）。其他未设置顺序数组保持空，版本 0，sortMode=manual。

**未擅自实施的行为变更：**

D01 创建名称未套用 PATCH 的 trim/100 限制；PATCH 按 ECMAScript 空白和 UTF-16 单元处理。D02 活跃重复 slug 为 409；软删占用仍不可重用，保留原一般失败 500，未把待评审的“统一 409”当作已批准修复。空字符串 onboardingAgentId 同样保持 TS UUID 写失败的 500，不在 SQLite 存成空指针或半更新其他设置。D06 提前 handoff 保持可调用；D09 complete 不再因断线重新阻塞；D11 配置 setter 和显式 complete 不混同。

**已记录的实现收敛/限制：**

- D04 补齐 serverOrderVersion；D05 只改变未来 membership 默认值，存量角色不降级。
- D07 沿用 M1 鉴权基础设施 503 与实际失效 401 的区别；各业务端点仍用自己的错误体，普通 SQL 细节不输出给调用者。
- D08 排序更新与组合设置写在 SQLite 事务内，防丢版本/半提交。相同 joinedAt 的 ID tie-break 只是确定化，不声称 TS 保证相同排序。
- 延续 M1 已存在的 405/Allow 策略，M2 的有效路径在方法拒绝前执行身份/空间/guest 门禁。原 TS 未必逐方法返回同一 405，这是 Go HTTP 边界，不宣称逐字节复刻所有不支持方法。
- 无法解释的 sidebar JSON/类型保守清洗；不存在、跨空间、不可见 ID 不返回。M2 无完整 sidebar writer、agent/self DM peer 接入链，未来新增 writer 前需扩展真实目录及对应测试。
- Socket.IO 未实现，不提供跨标签页推送等价承诺；反馈服务未实现，配置不能假装启用。
- 没有新增微服务、任务总线、假 Agent、假消息、noop notifier 作为成功路径。

## 5. SQLite 升级、安全与取消修复

只新增 0003/0004/0005，原 0001/0002 未修改。0003 先重建 membership 默认 role，保留原行，再由 0004/0005 建立 setup/preferences 复合外键与回填。updated_at 使用可用于非空旧表的常量新增及 created_at 回填，不依赖 SQLite 不允许的非恒定 ADD COLUMN 默认表达式。

迁移器逐项读取 `PRAGMA foreign_key_check` 的结果，在记录 migration 之前发现错误并回滚。升级测试覆盖原 M1 全表快照、账号/密码、session family/refresh/轮换收据、邮箱 token、法律接受记录、头像 URL、workspace/member ID 和旧 owner/co-owner 角色。

实测原生 10s busy handler 会延迟请求取消，因此新增受限 connector：原生等待 50ms，Go 每次操作最多约 10s 的可取消重试。仅重试取得 IMMEDIATE 写锁或单条 autocommit 语句；不重放事务正文、多语句迁移或 commit。启动验证 WAL 前提。300ms 截止的 BeginTx/ExecContext 测试要求 1s 内退出，实测约 311–312ms；取消后无写入，瞬态竞争释放后恰好一次写入。Prepared statement 保留底层短等待、不自动重放；当前产品 writer 使用直接 Exec/Query。

头像复用 M1 的 32-hex 内容地址格式。新实现先完整写入 0600 临时文件、sync/close，再在同目录 hard link 原子、不覆盖发布；拒绝 namespace/content 符号链接和内容地址不匹配的既存文件。并发相同上传不截断已被引用的文件。需要支持 hard link 的本地文件系统；不提供不安全的原位写入回退。孤儿头像 GC 未纳入本期，DB 写失败后不删除可能共享文件。

## 6. 实测验收证据

环境：`go1.27.1 darwin/arm64`、Node `v26.3.0`、`modernc.org/sqlite v1.60.1`。C0 未配置旗标全 false；opener 开/关在隔离数据库测试中分别覆盖。普通服务运行不依赖 Node。

| 命令/范围 | 结果与解释 |
|---|---|
| `make check` | 完整通过：fmt-check、vet、普通测试、race、TS 对照、HTTP/生命周期/升级、CGO-free build |
| `go test -json -count=1 ./...` | 227 个顶层测试 PASS；包含子测试计 275 个 PASS 事件；0 个测试失败、0 个测试跳过 |
| 未含测试函数的包 | 5 个包显示 no test files/package skip，不计为被跳过的测试；真实 M1 fixture 命令属于其中之一 |
| `go test -race -count=1 ./...` | 全包通过，无竞态报告 |
| TS/Go 纯投影对照 | 1,216 组通过；实际执行冻结 TS 原函数，不是手抄期望值；原源码 SHA-256 在脚本中锁定 |
| M1 HTTP 黑盒 | 原 10 组通过，注册/验证/资料/登录/refresh/退出/重置回归保留 |
| M2 HTTP 黑盒 | 18 组通过，覆盖 W01–W17、错误/作用域/创建竞争/刷新登录/真实门禁 |
| 独立进程生命周期 | SIGTERM 后重启保留状态、排序版本、偏好、owner、头像、密钥；完整停机备份恢复通过 |
| 独立进程 M1→M2 | 原 0001/0002 构造的旧库被新二进制升级，旧登录/refresh/单次验证 token/头像/owner 与 co-owner 均正常；新创建和真实 setup 回填通过 |
| `make cross-build` | Linux/amd64、Windows/amd64 编译通过；不是两个系统的运行验收 |
| `go mod verify` | all modules verified |

主要测试入口：`tests/acceptance/workspaces-contract.mjs`、`workspaces-lifecycle.mjs`、`workspaces-upgrade.mjs`、`workspaces-reference.mjs`，以及 workspace/legacyweb/db 包的行为测试。`tests/fixtures/m1-upgrade` 始终创建自己的临时目录；其测试凭据输出由 runner 私有捕获，不应直接转存到公共日志。

**未执行/不应误记为通过：** 原 Web 浏览器 T26、完整 PostgreSQL/TS HTTP 和约束并发对照、Computer/Agent 真机接入、Socket.IO、CLI/Daemon、外部 SMTP 部署投递、Linux/Windows 运行、生产负载与本轮在线漏洞扫描。部分 setup 故障/ready 分支由领域测试覆盖，不能把它们记成已由真实机器或每个 HTTP 分支触发。

## 7. 启动、升级与恢复

新环境试用：

```sh
cd /Users/lyon/workspace/raft-source/server-go
export RAFT_GO_DATA_DIR="$PWD/var-m2-dev"
export RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175
make build
./bin/raft-server
```

默认监听 127.0.0.1:4301。Web origin 换成实际前端值；不启动 Web、不自动配置 CORS；原前端的同源代理只能指向 Go。程序不自动读 .env。默认 outbox，可用同一 shell 环境下的 `go run ./cmd/raft-server mailbox list` / `mailbox latest` 读取开发邮件；令牌输出属于秘密材料。

本地 policy 键为 `RAFT_GO_POLICY_ONBOARDING_OPENER_V2`、`RAFT_GO_POLICY_ONBOARDING_OWNER_WIZARD_V0`、`RAFT_GO_POLICY_FEEDBACK_ENABLED`。只接受未设置/0/1；前两个可在本期范围内切换，feedback=1 明确失败。旧 wizard false 不是跳过新 setup 的许可。

**现有 M1 实例升级顺序：** 先停旧进程并确认退出；私密备份整个 DATA_DIR（DB、仍存在的 WAL/SHM、keys、avatars），另行保管外部 JWT_SECRET 和外置 outbox；保留旧二进制；再启动新二进制指向原目录。检查 /readyz、migration 和诊断日志，真实登录复读列表/setup/设置。不要在服务写入时只拷贝 raft.db，不要删除密钥或修改 migration 版本制造成功。

恢复时同样先停进程，再配套恢复完整数据库、密钥和头像。回退旧二进制应恢复与旧二进制匹配的 M1 整体备份；不能只换二进制而让它读取 M2 schema。未知新版本保持 fail-closed。备份中包含账号与凭据材料，按秘密管理。

启动可能输出 `OWNER_MEMBERSHIP_INCONSISTENT`、`OWNER_SETUP_STATE_MISSING`、`OWNER_PREFERENCES_MISSING`、`ONBOARDING_AGENT_REFERENCE_UNRESOLVED`。这些是只读诊断，不自动授权或清指针。处理时先停机备份，再依据权威成员/Agent 历史逐条核对：选择恢复一致备份或经 owner/运维明确批准的定向数据修复，记录前后值和审批；重启并重跑 FK/成员权限/投影检查。不要批量补 owner、把全部 setup 改 complete，或清除无法解释的 onboarding 指针。

## 8. 原 Web 协作者验收交接

使用相同源码基线、独立浏览器 context、仅指向 Go 的同源代理；经真实邮箱验证和资料流程登录，不注入 token 或改 setup 数据。创建空间后捕获 `/api/servers`、members、settings、sidebar-order、machines、setup-projection 请求，确认新 owner 的完整阻塞投影，刷新并重启服务复验。

MainLayout 即使在模态门禁下也会请求 channels、DM、agents、unread、saved 等后续表面。记录每条未支持请求与实际影响，不用空数组或前端改动掩盖。若真实频道只读成为页面阻塞依赖，应单独扩展范围与路由/权限测试；M2 当前没有承诺完整频道 API。

尚无真实 Agent 的新 owner 不一定能通过模态操作所有设置控件；设置后端由 HTTP 验收，原 UI 可操作性在后续真实 checkpoint 后复验。看到聊天主布局本身不是成功证据，必须验证 setup-projection 200、完整字段与 blocksChat=true。本次原 Web 验收状态：**未执行**。
