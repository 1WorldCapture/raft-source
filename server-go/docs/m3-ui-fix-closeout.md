# M3 UI 问题修复与最终集成验证

日期：2026-10-08。工作区：`/Users/lyon/workspace/raft-source`，DevSpace `ws_64eca3e811`，基线 `d275cce25c251997ba872add84d6e75d3bef4df8`。

**状态：修复代码与自动化回归完成；未提交/推送，未重启4301/5175，未重新执行浏览器黑盒验收。** 本文是中断恢复后对现有补丁再次核查、补充修正、在可监听真实端口环境完成集成验证的记录。此前 worker 报告中的受限环境、跳过测试和待父代理验证属于历史过程，不是当前最终测试结论。

## 1. 原始证据与结论

保留 `m3-ui-acceptance-report.md` 和 `gui-test-screenshots/m3/` 原样，不覆盖协作者的观察。问题在代码层面成立；对日志归因和阶段边界有下述校正。

| 报告项 | 核实结论与修复 | 目前签收范围 |
|---|---|---|
| P1 邀请成员不可用 | 原Go缺失邀请路由。补齐join-links创建/列表/撤销、email invites创建/列表/撤销、公开invite-info及登录后accept。新增成员同时初始化setup/preferences，避免“加入成功但sidebar/settings 404”的半成员 | 全量真实HTTP、事务权限/并发/持久化测试通过；双账号浏览器路径仍需在部署补丁后复验 |
| P2 设备码没有拒绝入口 | DeviceLoginPage新增拒绝按钮，发同一接口的`approve:false`；批准/拒绝共用错误处理，同步ref防止同tick重复点击，终态不可再次提交 | 页面行为与合同测试、真实后端拒绝→poll access_denied测试通过 |
| P2 Agent详情Not found+无效Retry | Skills/Reminders等明确后续能力增加授权后501，前端显示未启用，不给无效Retry；真实404/权限/网络错误仍保留错误路径 | 定向组件测试及后端权限/501/404边界测试通过；未重新拍浏览器截图 |
| P3 Activity mute横幅与Office失败 | mute显式501时隐藏控制和横幅，写入失败回滚乐观状态；Office显示未启用且保留资产/网络等真实错误。空间切换及清空时移除旧overview/提示 | 组件测试通过；这些能力仍未在M3实现，不能把降级当作M4完成 |

**GET / 日志不是浏览器一定请求了根URL。** 当前访问日志记录的是匹配到的路由模式；未知路径落入 `/` 兜底时就显示这个模式。根据Agent详情组件挂载顺序和实际请求源码，Skills是报告位置的对应候选，Reminders也有同类缺失端点。不能仅凭这条日志唯一还原原URL；本次修复直接覆盖明确的可选端点，并保留未知API的404，不把全站404吞成“未启用”。

**Office不是单纯Socket.IO尚未实现导致的错误。** 初始加载依赖`GET /api/servers/{id}/agent-overview`；M3没有Office业务实现，该授权后路由现在给明确501。未实现的聊天、Socket.IO、可靠Agent投递仍在各自后续阶段，不通过假空数据声称可用。

## 2. 后端邀请修复的关键边界

新增 `internal/platform/db/migrations/0009_workspace_invitations.sql`，只追加，不改0001–0008。管理请求在HTTP身份/空间门禁后，仍在实际写事务内重验owner/admin资格，防止排队期间降权后凭旧scope写入。join-link使用次数与成员关系同事务守护，支持撤销、过期、次数上限及不重复耗次的已加入重试。

邮件邀请绑定归一化邮箱、严格单次接受；摘要持久化，完整token仅进入本次邮件/outbox。join-link完整token按既有Web列表重建URL的合同持久化，摘要仅是查找键，**不是静态加密**；本地数据库/数据目录和备份权限必须继续保护。日志不记录token、邮件体或SMTP错误原文。

Guest门禁仍关闭：创建guest邀请、接受历史guest邀请都明确400拒绝，不静默提升为member。已有guest角色的防护测试不等于guest邀请UI已经启用。普通member可通过邀请创建真实关系，用于后续双账号及第二空间UI隔离验收。

未配置mailer在落库前失败；mailer投递失败按原TS语义保留pending记录，恢复方式是**撤销后重新创建**，不是重发无法从摘要还原的token。相关错误仍500，不伪造投递成功。

具体实现与早期子任务测试见 `m3-invitations-fix.md`；以下补充修正及最终集成结果以本文为准。

## 3. 恢复执行时额外修正

### 邀请HTTP校验与原Web/TS对齐

独立复核发现并修正了三个具体兼容差异：

- 创建邀请的顺序改为email校验→邀请管理能力→role校验，外围身份/空间/guest门禁仍先执行。普通member的坏邮箱返回原400；合法邮箱仍403，权限没有放宽。
- 显式`role:null`不再当作字段缺省并默认member；null、数组、对象、非member/guest值都400。
- 邮箱校验改用共享TS合同的254个UTF-16单元、local-part64单元、域名边界/连续点与ECMAScript空白规则；错误文案为`Enter a valid email address`，空值为`Email is required`。HTTP预检与域层写入复用一个validator。

新增 `internal/workspace/invites_validation_test.go` 和 `internal/transport/legacyweb/invites_validation_test.go`，覆盖Unicode/长度/格式、错误优先级、null/复杂role、未授权先行拒绝及拒绝请求零邀请落库。修正原测试中错误的邮箱提示和未触达能力判断的空body假设。

### Office清空空间时的状态残留

上一版补丁在effect最前面`if (!serverId) return`，会在退出/移除/清空workspace时跳过旧overview与提示的清理。改为先清空旧空间状态，再决定是否发新请求；新增组件测试，确认current=null后无旧未启用提示/roster，并且没有无scope的overview请求。

### 运行阶段标识

`internal/app/health.go`移除硬编码`account_phase`，改为`buildinfo.Stage`；build-identity验收同时核对CLI version、`/version`、`/healthz`和响应头。**仅有account_phase标签不能单独证明二进制是M2**，因为修复前M3代码本身也保留了这个硬编码；应综合实际/version和buildTime判断。

### 测试同步修正

现有补丁包含machinews撤销测试的net.Pipe关闭握手修正：并发完成write/read，继续要求close=1008且业务回调零执行。完整普通/race回归均通过，没有为消除测试等待而放宽服务端撤销逻辑。

## 4. 本轮最终实际验证

除单独标注的TS projector reference在本轮前半段执行外，下列主要后端/前端回归都在上述补充修正后再次执行。测试程序构建自己的CGO-free可执行文件、申请独立端口、创建临时SQLite/密钥/outbox并在结束时清理自己的资源；不使用现场4301或`var-m3-dev`测试。

| 命令/检查 | 实际结果与边界 |
|---|---|
| `make fmt-check vet` | 通过；全部Go文件格式与vet |
| `go test -count=1 ./...` | 全量通过，未跳过需要TCP监听的测试 |
| `go test -race -count=1 ./...` | 全量通过，包含legacyweb、workspace、machinews及真实监听用例；无skip参数 |
| `node tests/acceptance/workspaces-reference.mjs` | 本轮实际通过1216个冻结TS原函数/Go projector对照；后续邀请validator修正不修改该projector |
| `node tests/acceptance/run.mjs` | 最终补丁全量真实进程HTTP验收通过：账号/空间、Computer、Daemon、Agent、频道、邀请、真实runtime目录、原版Computer/Daemon直连+同源代理、重启持久化、备份恢复及冻结旧程序升级 |
| `make cross-build` | Linux/amd64、Windows/amd64、CGO_ENABLED=0编译通过；不代表目标OS运行验收 |
| `go mod verify`、`go mod tidy -diff` | 通过，依赖无新增漂移 |
| Web定向Vitest（命令见下） | **7文件、58测试全部通过**；包括Device10+合同2、Skills4、Reminders3、Mute30、Office5、feature识别4 |
| `pnpm run typecheck` | 通过 |
| `pnpm run lint:i18n-literals` | 通过，152项既有baseline保持匹配 |
| 改动Web源文件及上述测试的oxlint | 通过；没有把定向检查冒称为全仓库lint已通过 |
| `git diff --check` | 通过 |
| 浏览器黑盒、外部SMTP、生产负载、目标OS真机、完整前端生产build | 本轮未执行；不得由后端/组件测试推导为通过 |

前端复现（工作目录`packages/web`）：

```sh
node scripts/run-vitest-tests.mjs --dom \
  tests/serverFeatureAvailability.test.ts \
  tests/deviceLoginPage.behavior.test.tsx \
  tests/deviceLoginPageContract.test.tsx \
  tests/agentSkillsAvailability.behavior.test.tsx \
  tests/agentReminders.behavior.test.tsx \
  tests/activityMuteHeader.behavior.test.tsx \
  tests/officePageAvailability.behavior.test.tsx
pnpm run typecheck
pnpm run lint:i18n-literals
```

测试输出仍有Node实验特性/废弃API警告，以及既有ChatPanel测试的React `act(...)`警告；此次58项断言均通过，不宣称日志完全无警告。本轮没有重新执行漏洞扫描，不复用旧报告写成“当前依赖无漏洞”。

## 5. 现场只读检查与部署状态

本轮只读检查时，4301实际返回：

```json
{
  "stage": "m3",
  "revision": "d275cce25c251997ba872add84d6e75d3bef4df8",
  "modified": true,
  "commitTime": "2026-10-08T10:56:15Z",
  "buildTime": "2026-10-08T11:01:24Z",
  "goVersion": "go1.27.1"
}
```

`/readyz`为ready，`/healthz`仍返回account_phase；说明运行实例尚未包含本次health标签修正。经5175请求**已注册**的`/api/auth/providers`返回200及同一M3/revision/buildTime响应头，确认Vite API代理指向该实例。一个不存在的路径返回404本身不能当代理断链证据。

本轮没有覆盖`bin/raft-server`、停止/重启4301/5175、迁移现场SQLite、启动机器模拟器或改动旧备份；`server-go/var-m3-dev/`、`server-go/var-backup-m2-20261008-1902/`与原截图保留。它们仍是工作树中的未跟踪目录，后续提交不要使用未经检查的`git add .`把数据/密钥/备份带入仓库。

实际部署补丁需要独立的受控动作：确认目标进程与配置→优雅停止→完整冷备份数据目录（含可能存在的WAL/SHM、密钥、头像和必要outbox）→构建并启动修复版→核对/version、healthz、readyz和代理→UI复验。新增0009会在修复版启动时应用；旧M3程序可能因未知schema拒绝打开新库，回滚应恢复**匹配旧二进制的完整冷备份**，不可直接拿旧程序降级新库。

## 6. 给UI协作者的补丁复验项

部署新构建后使用可重放测试账号：owner创建链接→另一已验证账号加入→刷新/重登/读取sidebar与settings→公共/私有频道和另一workspace隔离；guest仍应明确禁用，不签guest邀请功能通过。邮件路径验证绑定邮箱、重复/撤销/过期与收件端测试outbox。

设备码分别走批准和拒绝，拒绝后设备轮询必须得到access_denied且没有会话；快速重复点击不生成第二次提交。Agent详情查看Skills/Reminders未启用态，真实404仍有错误；Activity mute无虚假失败横幅，Office显示未启用，切换/清空空间不残留旧状态。

UI报告应单列通过/失败/未执行/阶段不适用；本文不替协作者重新签署浏览器验收。

## 7. M4详细设计交付

- `phase-4-messaging.md`：范围、模块、数据、事务/幂等、Socket.IO、发布outbox、恢复、撤权、迁移和部署。
- `m4-compatibility-contract.md`：原HTTP/Socket.IO真实合同、精确payload、线程读取与订阅差异、50条overlay页/200条本地窗口、self-DM与Agent DM边界、限流及未启用语义。
- `m4-activity-readstate-contract.md`：human Activity/Inbox/Done/read/follow/mute逐端点范围、状态持久化、frontier守卫、scope/epoch/watermark与变更保留、真实原schema/reducer验收。
- `m4-implementation-coordination.md`：P0–P9工作包、依赖、执行/验收角色、文件所有权、迁移单写者、自动化与UI验收矩阵、发布阻塞条件。

独立复核后已修正线程内容权与兴趣集合混淆、overlay参数误记、遗漏的prefs/follow事件、dm:new payload、self-DM、Activity/Done端点缺口、HTTP限流及0009编号滞后。M4只完成设计，Socket.IO库仍需P0原客户端实测；没有安装候选库、实现M4业务或把stage改为m4。
