# M3 邀请功能修复报告（m3-ui-acceptance-report 发现 #1）

日期：2026-10-08(含 parent 评审整改)。范围:`server-go/` 后端(不含 `internal/app/health.go`、`internal/app/app_test.go`、`tests/acceptance/build-identity.mjs` 及 parent 新增的 `deferred_ui_routes*.go`、Office 路由、`machinews/fence_test.go`,均未触碰)。目标:补齐 M3 UI 验收中被 P1 缺口阻塞的 workspace 邀请面 —— join-link 创建/列表/撤销、邮件邀请与 pending 列表、公开预览与登录后加入 —— 使浏览器可以用第二个真实账号加入 workspace。

## 1. 契约依据

以冻结的 TS 服务器与 Web 消费方为准,未发明任何字段:

| 面 | TS/Web 契约源 |
|---|---|
| `GET/POST /api/servers/:id/join-links`、`DELETE /api/servers/:id/join-links/:linkId` | `packages/server/src/routes/servers.ts`;`InviteHumanDialog.tsx`(GET 空则 POST `{maxUses:null,expiresAt:null}`,取 `links[0]`/`data.link`,用 `link.token` 拼 `${origin}/join/<token>`);`SettingsPanel.tsx` JoinLinksSection |
| `GET/POST /api/servers/:id/invites`、`DELETE /api/servers/:id/invites/:inviteId` | servers.ts invites 三路由 + `inviteService.ts`(pending 过滤、7 天过期、重复 409、撤销即删行、**guest 经 feature flag 拒绝**) |
| `GET /api/auth/invite-info?token=`(公开) | `auth.ts` invite-info;`InviteAcceptPage.tsx` |
| `POST /api/auth/accept-invite`(登录+已验证+资料完成) | `auth.ts` accept-invite + `inviteService.acceptInvite`(email 绑定、精确错误句、join link 幂等加入、原子守护递增);`authStore.acceptInvite` → Web 重拉 `/api/servers` 进入 `/s/<slug>` |
| 邮件 | `emailService.renderInviteEmailHtml`(`?invite=<token>` 链接、7 天提示、inviter/server 名 HTML 转义) |

## 2. 实现

**迁移 `0009_workspace_invitations.sql`(追加式,不改写 0001–0008)**

- `workspace_join_links`:原始 token **按契约持久化**——多用途链接必须可从列表重建 URL(两个 Web 组件都读 `link.token`);`token_digest`(sha256 hex,UNIQUE)是**查找键**,不是静态加密:拿到数据库或备份文件即得到原文,防护依赖本仓既有的本地文件控制(SQLite 0600、数据目录私有、备份纪律,与 `sk_machine_*` 等现有本地凭据同级)。未新增密码学组件。
- `workspace_invites`:email 邀请**只存摘要**(一次性、邮件带出、原文不可恢复,对齐 TS `tokenHash`),role/status CHECK,邮箱按账号侧 trim+小写归一。

**域层 `internal/workspace/invites.go`**

- 六个管理操作各自在**事务内重验** owner/admin 角色(`CanManage`);scope 中间件身份仅作前置快速拒绝。
- **guest 冻结门禁**(parent 整改 #1):`SERVER_GUEST_FEATURE_FLAG_KEY` 在 M3 冻结为 disabled(本地 policy 向量无 guest 开关,feature-flag 服务未实现,与既有 channel/role policy 同一口径)。`CreateEmailInvite` 在事务内拒绝 `role=guest`,返回 TS 原句 **"Guest access is not enabled for this server"**(400,不静默降级 member、不落行);`AcceptInvite` 对**既存** guest 邀请行(历史策略或直写产生)同样显式拒绝(同一句子、行保持 pending 可撤销、绝不产生成员关系)。直接播种的既有 guest **权限**测试(成员目录、管理面 403)保持不变——角色模型本身未变,被冻结的是邀请入口。
- `InviteInfo`(公开预览):email 优先的共享 token 空间;撤销/过期/耗尽/空间已删折叠为同一 404;`insideCountsHidden` 跟随 `hide_humans_from_members`;无 billing/agreement,相应字段如实 `false/null/null`。
- `AcceptInvite`(单事务):email 邀请按 TS 顺序 status→过期→guest 门禁→**邮箱绑定**→空间存活→成员查重;join link 校验撤销/过期/耗尽后插入成员并**守护式** `use_count+1`(同事务重验,失败整体回滚不超发)。**幂等语义区分**:join link 是**有条件幂等**(已在成员 → 再次成功且不消耗次数,TS `joinedThisServer=false` 路径);email 邀请**严格单次**(同一 token 对任何人——包括已接受的账号——都返回 "This invite has already been used")。
- **伴随行原子初始化**(parent 整改 #3):插入成员与 `workspace_member_setup`(not_started,v2 契约)、`workspace_member_preferences` 同事务完成——`GET sidebar-order` 与 `GET onboarding-settings` 把缺失行视为 integrity drift(404 "Member not found"/"Server not found"),仅有成员行的"半成员"会在真实 UI 上破碎;创建路径(CreateWorkspace)本就为 owner 写这两行,加入路径与之对齐。
- 邮件渲染 `invite_email.go`(纯函数,逐值 HTML 转义,`${webOrigin}?invite=<token>`,outbox `kind:"invite"`+`token`)。

**传输层与装配**

- `invite_handlers.go`:TS 精确句子(member 403 / guest 管理面 403 / maxUses·expiresAt 校验 / accept 按关键字映射 400,guest 门禁句显式映射 400,"server no longer exists" 保持 500)。
- **邮件失败语义**(parent 整改 #2):`SendInviteMail` 为 nil → 在**持久化之前**拒绝(500 "Failed to create invite",零落行——插入一行其 token 从未到达任何人的 pending 没有意义);投递失败 → TS 语义(行已提交,500),但该 pending 行**不可原样重试**——一次性 token 只存在于那次失败的投递里,存储的摘要无法重生成;**恢复路径是显式的 revoke-and-recreate**(DELETE 该 pending 邀请 → 重新 POST 创建,新 token 新邮件),代码注释与本报告如实记载,不声称"可重试"。日志只写**固定诊断**("invite email delivery failed; pending invite requires revoke-and-recreate to recover" + workspace_id),不记录 `sendErr.Error()` 原文——传输错误可能携带收件人、邮件体、SMTP 凭据或 token。
- `routes.go` 挂载六个管理路由(gate→scope→guestFree)与两个 auth 面;`workspace_method_policy.go` 补 405/Allow 兜底;`app.go` 装配邮件适配。

## 3. 变更文件

新增:`0009_workspace_invitations.sql`、`workspace/invites.go`、`workspace/invite_email.go`、`workspace/invites_concurrency_test.go`、`legacyweb/invite_handlers.go`、`legacyweb/invites_http_test.go`、`legacyweb/invites_member_journey_test.go`、`legacyweb/invites_internal_test.go`、`tests/acceptance/m3-invitations.mjs`、本报告。
修改:`legacyweb/routes.go`、`workspace_method_policy.go`、`policy_avatar_persistence_test.go`(1 条:accept-invite 501→401)、`internal/app/app.go`、`tests/acceptance/run.mjs`(最小接线)。
未触碰:parent 与其他 worker 的全部文件(见 §1 范围)。

## 4. 测试证据(实际执行)

| 命令 | 结果 |
|---|---|
| `go test -count=1 -race -run 'TestJoinLink\|TestEmailInvite\|TestInviteCross\|TestInviteAccept\|TestInviteCreateOverrules\|TestInviteMailer\|TestJoinedMember\|TestInviteRestart\|TestAcceptJoinLinkConcurrent\|TestAcceptEmailInviteConcurrent' ./internal/transport/legacyweb/ ./internal/workspace/` | **通过**(race)。含:授权矩阵;join-link 生命周期(maxUses/expiresAt 校验、幂等重入恰耗 1 次、耗尽/过期/撤销);**guest 禁用门禁**(创建 400 原句零落行;直写既存 guest 行 → 预览可见但 accept 显式拒绝、行保持 pending、零成员;既有播种 guest 权限测试保留);email 流(归一化、409、仅摘要入库、绑定拒绝、member 角色落地、严格单次、过期替换、撤销);跨空间隔离;门禁顺序与 405 |
| 同上中 `invites_internal_test.go`(包内测试) | **通过**:①**事务时降权**——scope 中间件的过期 admin 声明被 store 事务重验推翻(403 原句、零落行、mailer 零调用),owner 同路径通过且 mailer 恰调一次;②**nil mailer** 在持久化前拒绝(500、零行);③**投递失败**——哨兵秘密 `sk_invite_secret_DO_NOT_LOG_*` 携带于传输错误中:500、行按 TS 语义留存、**日志与响应均无哨兵**、固定诊断在日志中 |
| 同上中 `invites_concurrency_test.go`(真实 goroutine) | **通过**:①maxUses=2 被 4 用户并发抢——恰好 2 成功/2 得 usage-limit 原句、成员数=3、use_count=2(无超发);②同一用户 8 路并发——全部成功、单成员、use_count=1(无双重消耗);③email 邀请同用户 6 路并发——恰 1 成功、其余 "already been used"(严格单次) |
| `TestJoinedMemberEndToEndUsability` / `TestInviteRestartPersistence` | **通过**:accept 后以真实 API 走 servers 列表(member 角色)→ workspace 详情 → settings → setup-projection(`none`+`insufficient_permission`)→ **sidebar-order 200**(证明伴随行存在,缺失即 404)→ channels(#all `joined:true`);reopen(同数据目录重建 app)后 0009 迁移恰记录一次、link id/token/useCount/maxUses 不变、pending 邀请留存、成员关系可读、链接仍可预览 |
| `go test -count=1 -race -skip '...bind-blocked...' ./internal/transport/legacyweb/ ./internal/workspace/ ./internal/app/` | **全绿**(整包 race,57.7s/31.9s/2.9s) |
| `go test -count=1 -skip 'TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware\|TestReviewSMTPHonorsCancellationDuringGreeting' ./...` | **13 包全绿** |
| `go vet ./...`、`gofmt -l .` | 通过/无输出 |
| `CGO_ENABLED=0 go build -o $TMPDIR/raft-server-invitations-check ./cmd/raft-server` | 通过(输出到 TMPDIR,不覆盖 `bin/raft-server`,4301/5175 进程未动) |
| `node --check tests/acceptance/m3-invitations.mjs && node --check tests/acceptance/run.mjs` | 语法通过 |

**子进程限制(本 worker 执行环境,非全局要求)**:我的命令沙箱禁止本地端口绑定(一切 `listen(127.0.0.1)` → `EPERM`,v4/v6 已探针复核),因此我在本环境**无法执行**需要真实监听的测试:`tests/acceptance/run.mjs`(全部套件)与两条依赖 TCP 监听的既有 Go 测试(`TestM3WebSocketUpgradeSurvivesLoggingAndSecurityMiddleware`、`TestReviewSMTPHonorsCancellationDuringGreeting`;parent 的 fence_test net.Pipe 修复不受影响,我未触碰)。parent 环境可起真实监听,请执行:

```sh
cd server-go
RAFT_GO_TEST_SUITE=invitations node tests/acceptance/run.mjs   # 本修复的端到端套件
node tests/acceptance/run.mjs                                   # 全量(M1–M3 + 本套件)
go test -race ./...                                             # 含上述两条 bind 测试
```

mjs 套件已覆盖 UI 阻塞流(join-link 对话框 GET→POST 流、`/join/<token>` 对应 invite-info→accept→servers 列表→进入空间的关键读取)与 guest 禁用门禁;Go 侧并发/降权/重启/日志卫生证据不依赖监听。

## 5. 有意的边界与剩余限制

1. **join-link 原文 token 按契约持久化**(兼容性取舍,非疏漏):UI 需要从列表重建可复用 URL;`token_digest` 只承担索引查找与唯一性,**不是静态加密**——数据库/备份文件被读取即暴露,防护等同本仓其他本地凭据(0600 文件、私有数据目录、冷备份纪律)。email 邀请才是摘要单存面。未为此新增密码学。
2. **无 seat limit / billing / agreement**:无本地 provider,`humanSeatLimitReached=false`、`agreement=null`、`agreementId` 入参惰性;均为如实投影。
3. **guest 冻结门禁**:M3 内 guest 邀请创建与既存 guest 邀请接受都被拒绝(TS 原句);将来启用 guest 需要先落地 feature-flag 服务并同步解除两处门禁,不能只改一处。
4. **无实时事件**:accept 后无 Socket.IO `server:member-added`(M3 明确 501);Web 靠重拉 `/api/servers` 收敛(已被测试覆盖)。
5. **邮件投递失败恢复 = revoke-and-recreate**(显式、可审计),不提供自动重发——存储摘要无法重生成一次性 token,自动"重试"必然产生不同 token 而旧 pending 行变成死锁,故宁可选择显式路径。
6. 并发正确性依据:SQLite 单写者 + 每请求 IMMEDIATE 事务 + 同事务守护递增;真实多实例共享库不在 M3 范围。
7. 未做:提交/推送/分支、服务停启、真实邮件(outbox)、触碰 `var*`、备份、截图及他人文件。
