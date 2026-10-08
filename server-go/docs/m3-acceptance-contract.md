# M3 兼容性/验收契约(测试责任人)

- 责任范围:仅 `server-go/tests/acceptance/m3-*.mjs`、可选 `server-go/tests/fixtures/m3-*/**`、本文档。
- 不修改:runner(`run.mjs`)、任何 Go 实现文件、clients/var/shared、go.mod。不提交。
- 方法:先读 TS 源码钉死 wire 契约(§3),再写黑盒验收;以 wire 证据判定,不做代码 grep;"未实现/501"即失败;绝不伪造 setup complete 或在产品请求上伪造 Computer 凭据。
- 基线核对日期:2026-10-08,dev 基线 `4acd990`(M2)。当前 Go 侧 `/internal/*`、`/daemon/*` 仍为 501,M3 各 worker 代码落地前本套件预期失败——这是验收门槛,不是回归。

## 1. 导出签名(供 parent 在 run.mjs 装配)

```js
import { verifyM3ComputerAdmission } from './m3-computer-admission.mjs';
import { verifyM3DaemonWire }          from './m3-daemon-wire.mjs';
import { verifyM3AgentIdentity }       from './m3-agent-identity.mjs';
import { verifyM3Channels }            from './m3-channels.mjs';
import { verifyM3Persistence }         from './m3-persistence.mjs';

await verifyM3ComputerAdmission({ origin, data });
await verifyM3DaemonWire({ origin, data });
await verifyM3AgentIdentity({ origin, data });
await verifyM3Channels({ origin, data });
await verifyM3Persistence({ origin, data, start, stop }); // 最后执行:内部 stop/start 重启进程
```

- `origin`/`data`:与现有 M2 模块一致(隔离 loopback 实例与其数据目录;outbox 位于 `data/outbox`)。
- `start`/`stop`:parent 闭包(与 `verifyProcessLifecycle` 用法相同)。persistence 与 `workspaces-upgrade.mjs` 一样仅由 parent 调用;其余四个模块支持独立运行:`RAFT_GO_TEST_URL` + `RAFT_GO_TEST_DATA`。
- 模块间无共享可变状态;各自用真实产品流程自建夹具,返回值仅供诊断,不作为夹具传递通道。建议装配顺序:ComputerAdmission → DaemonWire → AgentIdentity → Channels → Persistence。

## 2. 共享设施

- `m3-harness.mjs`:`httpClient`(仅 loopback、超时、凭据不进日志)、`createVerifiedAccount`(注册→outbox 验证→资料)、`createWorkspace`、`deviceLogin`(真实设备授权:authorize→approve→token 轮询)、`attachComputer`(设备会话 attach,真实 `sk_computer_*` 仅存内存)、`pollUntil`(有界轮询)。
- `m3-wire-ws.mjs`:**手写最小 RFC 6455 客户端**(node:http Upgrade + 帧编解码,客户端帧带 mask,自动应答 server ping)。原因:仓库是 pnpm 严格布局,`ws` 从 server-go 不可解析;且原生 WebSocket 不能带 `Authorization` 头、不能读取非 101 响应的 `Slock-Reason` 头,而这两点正是 daemon wire 的核心证据。客户端同时支持 legacy `?key=` 查询参数形态。

凭据安全:所有 key/token 只进内存;断言失败消息只带 HTTP 状态与 code;`connectMachine` 的拒绝路径只保留状态码与 `Slock-Reason`(闭集),绝不保留原始 key。

## 3. 已钉死的 TS wire 契约(验收断言依据,先于 Go 实现固定)

来源均为本仓库 TS 源码逐行阅读(文件与行为,行号针对当前 dev 工作区):

### 3.1 设备授权 `/api/auth/device/*`
来源 `packages/server/src/routes/deviceAuth.ts`;消费方 `packages/computer/src/services/login.ts`+`apiClient.ts`、`packages/cli/src/agentLogin/deviceAuthClient.ts`。

| 请求 | 期望 |
|---|---|
| POST `/authorize` `{clientName?}` | 201 `{deviceCode,userCode,verificationUri,verificationUriComplete,expiresIn>0,interval>=1}`;verificationUri 为绝对 URL、path=`/login/device`、**origin ≠ API origin**;`verificationUriComplete` 以 `?user_code=<userCode>` 预填;clientName 非 string 或 >200 字符 → 400 `client_name_invalid`;未配置 app URL → 503 `DEVICE_LOGIN_URL_UNAVAILABLE`(黑盒不触发,由配置决定) |
| POST `/approve`(Bearer 用户)`{userCode,approve?}` | 200 `{ok:true,action:"approved"\|"denied"}`;缺 userCode → 400 `user_code_required`;未知 code → 404;已决议 → 409(already_resolved);无认证 → 401 |
| POST `/token` `{deviceCode}` | 未批准 → 400 `authorization_pending`;成功 → 200 `{accessToken,refreshToken,userId=批准人}`(token 可用於 `/api/auth/me`);拒绝 → 403 `access_denied`;重放 → 410 `device_code_consumed`;乱码 → 400 `device_code_invalid`;缺参 → 400 `device_code_required` |

### 3.2 Computer attach 与内部面
来源 `routes/computerAttach.ts`、`services/computerCredentialService.ts`(attachComputer:同名同用户未撤销 → collision;始终 fresh 创建,`resumed:false`)、`routes/internalComputer.ts`;消费方 `packages/computer/src/apiClient.ts`。

| 请求 | 期望 |
|---|---|
| POST `/api/computer/attach`(Bearer 用户)`{serverSlug,name?}` | 201 `{apiKey:"sk_computer_*"(仅此一次),serverMachineId(computers.id),machineId(machines.id),serverId,serverSlug,resumed:false}`,两个 id 是不同 UUID;同名重复 → 409 `COMPUTER_NAME_COLLISION`;未知/非成员 slug → 403 `not_authorized`;成员无 manageMachines → 403 `requires_admin`(M3 无邀请 API,暂无法黑盒构造,见 §4.6);空 slug → 400 `server_slug_required`;name 空/>200 → 400 `name_invalid`;无认证 → 401 |
| POST `/internal/computer/preflight`(Bearer sk_computer_)`{}` | 200 `{ok:true,serverSlug,principal:{kind:"computer",serverId}}`;坏 key → 401 |
| GET `/internal/computer/runners`(Bearer sk_computer_) | 200 `{whitelist:["agentId","name","status","model","runtime"],runners:[]}`;**M3 分工将该面 defer 给 AGENT(见 m3-computer-contract.md §4),故验收接受两态之一:完整 TS 契约,或 401 `auth_policy_unregistered_path` 诚实 fail-closed;任何其他形状(尤其无 whitelist 的空成功)都判失败** |
| GET `/api/servers/`(尾斜杠) | 200 裸数组(Computer `ServersClient.list()` 的确切 URL 形态;M2 Go 只注册了无尾斜杠形态,需要 parent/COMPUTER 补) |
| DELETE `/api/servers/:id/machines/:machineId`(X-Server-Id) | 200;之后该 key 的 preflight/runners/ws 全部 401;机器行从目录消失 |

### 3.3 `/daemon/connect`(原始 WS)
来源 `routes/daemon.ts`(Bearer 优先、legacy `?key=` 兼容、401+`Slock-Reason` 闭集)、`services/machineContext.ts`(首帧)、`services/agentOrchestrator.ts`(ping→回 ping,行 6341-6345);消费方 `packages/daemon/src/connection.ts`、`core.ts`(emitReady 行 4338-4400)。

- 接受后**第一帧** `{"type":"machine:context","machineId","serverId"}`(machineId=machines.id)。
- `{"type":"ready",capabilities?,runtimes,runtimeVersions?,runningAgents,hostname?,os?,daemonVersion?,computerVersion?}` 的 facts 落 machines 行:`/api/servers/:id/machines` 反映 `status:"online"`、`daemonVersion`、`runtimes`。
- machine 发 `{"type":"ping"}` → server 在同一 socket 回 `{"type:"ping"}`;server 亦每 30s 主动 ping(验收不等待真实周期)。
- 同 machine 新连接替换旧连接(旧连接被关闭,machinews 契约为 1000);断开后 2s 宽限期内未重连则 offline(允许 ≤30s 延迟);ready 事实持久,重启后仍在 machines 行。
- **legacy 机器面**(COMPUTER 契约 §3):`POST /api/servers/{id}/machines {name}` → 200 `{machine,apiKey:"sk_machine_*"`(恰好一次);`POST .../rotate-key` → 200 `{apiKey}`;轮换后旧 key ws → 401 `machine_key_invalid`,新 key 可连。验收已覆盖注册→连线→轮换→旧 key 失效全链。
- 撤销对已建立连接:pong/ready/heartbeat 是重验证点(≥30s 间距);验收在 DELETE 后主动发 `pong` 触发复核,避免依赖 30s 心跳时钟。
- 拒绝:HTTP 非 101 + `Slock-Reason`(闭集:missing_key/invalid_key_format/computer_*(如 computer_revoked/computer_machine_unlinked)/machine_key_invalid/legacy_machine_key_migrated/server_not_found/exception);浏览器 Origin 不构成绕过(坏 key+Origin 仍 401)。
- 撤销后已建立连接被拆除(≤30s);`computer_revoked|computer_machine_unlinked|machine_not_found` 之一。

### 3.4 Agent 身份与凭据
来源 `routes/agents.ts`(create 1260-1745、start 2995、stop 3078、reset 3102、delete 3147)、`routes/agentCredentials.ts`、`routes/agentLogin.ts`、`routes/internalAgentApi.ts`(whoami 1666)、`services/officialOnboardingAgentIdentity.ts`;消费方 `packages/web/src/store/agentStore.ts`(createAgent 730)、`packages/cli/src/{client.ts,commands/agent/login.ts,auth/env.ts}`。

- POST `/api/agents`(X-Server-Id)`{name,external:true}` → **200**(非 201);DTO 核心字段 `id/name/description/runtime="external"/machineId=null/serverRole="member"/createdAt`。名称错误(shared `validateName`,label "Agent name"):`"Agent name is required"`/`"Agent name must be at most 32 characters"`/`"Agent name must start with a letter and can only contain letters, numbers, hyphens, and underscores"`;重名 → 409(消息含 already taken);`external+onboarding` → 400 `"Onboarding agent cannot be external"`;`external+machineId` → 400 `"External agents cannot be assigned to a Computer"`。
- onboarding(Cindy):`{onboarding:true,runtime,model,machineId}`(Web CreateAgentDialog 同一表单);成功后 name/description/avatarUrl 覆盖为官方身份(`Cindy`/`Onboarding Assistant`/`pixel:mug`)、serverRole=`admin`、工作空间 `onboardingAgentId` 指向它;再次创建 → 409;随后 `setup-transition {action:"complete"}` 在机器在线 + ready 报告对应 runtime 时真实 complete(phase=complete、blocksChat=false)。
- 铸造:POST `/api/agents/:id/credentials`(Bearer 用户、**无 X-Server-Id**、body `{}`)→ 201 `{credentialId,apiKey:"sk_agent_*",scopes[],agentId,agentName,serverId}`;反枚举:他空间非成员 → 404 `agent_missing`;无权成员 → 403 `insufficient_role`(同 §4.6 暂缺构造路径)。
- CLI whoami:GET `/internal/agent-api/`(尾斜杠、Bearer sk_agent_)→ 200 `{agentId,agentName,agentDisplayName,serverId,serverRole,serverCapabilities,credentialId,scopes}`;坏/撤销 key → 401。
- 撤销:DELETE `/api/agents/:id/credentials/:credentialId` → 204;重复 → 404 `credential_missing`;列表 GET → `{agentId,credentials[]}`(撤销行保留 revokedAt)。
- bootstrap:POST `/api/agents/:id/bootstrap-tokens` TS 默认关闭(#1836)→ 404 `self_hosted_runner_bootstrap_disabled`;若 Go 打开则 201 → `POST /api/agent/login` 单次交换(重放 410 `token_consumed`)。验收两者取其一且 code 必须与矩阵一致。
- 生命周期:external start/stop/reset → 400 `"External agents do not use Raft-managed runtime lifecycle"`;无 machine start → 409 `machine_unassigned`;托管 agent(runtime "claude"/model "sonnet"+machineId,机器在线+ready 报告 claude)start → 200 `{ok:true}` **且 machine WS 收到 `{"type":"agent:start",agentId,config}`**(config 为对象);stop → WS 收到 `agent:stop`;delete → 200 后 detail 404。
- 越空间 detail(mismatched X-Server-Id)→ 404/403,不泄露存在性。

### 3.5 频道 `/api/channels`(X-Server-Id)
来源 `routes/channels.ts`(list 589、create 750、detail 2448、archive 2520、members 3068、add-member 3354、join 3685、leave 3749)、`middleware/auth.ts` requireServer(212-238);消费方 `packages/web/src/store/channelStore.ts`(Channel DTO 23-110)。

- requireServer:无认证 → 401;缺头 → 400 `"Missing X-Server-Id header"`;非成员 → 403 `"Not a member of this server"`;**他空间频道 id 在自己 scope 下 → 404**。
- GET → 数组;新空间含 `#all`(systemKind:"all"、joined:true、archivedAt:null)与 `#announcement`(systemKind:"announcement");`?archived=` 非法值 → 400 `"archived must be one of: exclude, include, only"`。
- POST `{name,description?,visibility:"public"|"private"}` → **200**;`{id,name,type:"channel"|"private",joined:true,archivedAt:null,createdAt}`;保留名 `all` → 400 `channel_name_reserved`;visibility 非法 → 400 `"visibility must be one of: public, private, joint"`;重名 → 409(含 already taken);名称校验 label `"Channel name"`(shared validateName);description>500 → 400。
- join/leave 自往返 `{ok:true}`;leave 后 public detail joined:false,重 join 恢复;**私有频道 join → 403 `"Private channels require an invitation"`(TS join 的类型检查先于可见性判断,即便是成员也一样)**;私有频道跨空间 detail → 404;`announcement` 亦为保留名(400 `channel_name_reserved`);leave #all → 403;#all join 幂等 `{ok:true}`;归档后 join → 409 `channel_archived`。
- members GET → `{agents[],humans[],externalMembers[]}`;owner 行 `role:"owner"`、`effectiveChannelRole:"owner"`、`canChangeChannelRole:false`;POST members `{agentId}` → `{ok:true}`,roster 出现该 agent;未知 agentId → 400 `"Agent not found in this server"`。
- archive 系统频道 → 400;普通频道 → 200 archivedAt 置位;`?archived=only` 可见;unarchive → null;PATCH 改名/描述 → 200。

## 4. 对其他 worker / parent 的依赖与缺口(尽早协调)

1. **COMPUTER**:`Store.Authenticate` 的 Reason 闭集须覆盖 §3.3;`GET /api/servers/`(尾斜杠)需注册(ServersClient 兼容);撤销后 preflight/runners/ws 全 401。
2. **MACHINEWS**:Hub 接受 Bearer 与 `?key=`;首帧 machine:context;ready facts 落 machines 行供 W17 读;同机替换关旧连接;拒绝给 `Slock-Reason`。
3. **AGENT**:Web 建 Cindy 的最小可用 body 的承认范围、`agent:start` 的派发 payload(验收只要求 `agentId`+`config` 对象)、`/internal/agent-api/` 尾斜杠与 whoami DTO、bootstrap 面 Go env 开关名。worker 契约文档定稿后如与 §3.4 有出入,以双方文档对齐后更新本文件。
4. **CHANNEL**:joined/channelRole 等扩展字段以 CHANNEL worker 契约为准;验收只断言 TS 明确核心字段。
5. **parent**:装配顺序(persistence 最后);`run.mjs` 现有 credential-leak 日志检查会覆盖 M3 输出;如需为新 env(bootstrap 开关等)传值请在 runner env 中显式加入。
6. **第二成员夹具缺口**:M2/M3 无邀请/成员添加 API,`requires_admin`(attach)、`insufficient_role`(mint)、`addChannelMembers` 越权分支无法黑盒构造非 owner 成员;已列入缺口,不伪造 membership。若后续引入邀请端点,补三处断言即可。
7. **沙箱**:本套件需要真实进程 + 原始 TCP/WS(loopback)。若执行环境禁止端口绑定,由 parent 在其会话执行 `node tests/acceptance/m3-*.mjs`(设 `RAFT_GO_TEST_URL`/`RAFT_GO_TEST_DATA`);测试不降级、不 mock。

## 5. 执行与验证记录(如实)

- 语法:五个验收模块 + 两个共享文件 + 自检夹具均通过 `node --check`(Node v26.3.0)。
- **WS 客户端编解码:本会话未执行**——沙箱拒绝本地端口绑定(`listen EPERM 127.0.0.1`),无法起回环服务器。已把自检脚本作为披露的测试夹具落在 `server-go/tests/fixtures/m3-ws-selfcheck/validate-ws-client.mjs`(回环 daemon 模仿:401+Slock-Reason、machine:context 首帧、mask 帧往返、大帧 16/64 位长度、close 帧),供 parent/任意可绑端口环境执行:
  `node server-go/tests/fixtures/m3-ws-selfcheck/validate-ws-client.mjs`
- **真实 Go 进程冒烟:本会话未执行**(同一沙箱限制)。当前 Go 基线(仅 M1/M2)下本套件必然失败——这是预期验收门槛。parent 可在 run.mjs 装配后执行,或先行单模块冒烟:
  ```sh
  cd server-go
  CGO_ENABLED=0 go build -o "$TMPDIR/raft-m3" ./cmd/raft-server
  port=4301; data="$(mktemp -d)"; origin="http://127.0.0.1:$port"
  RAFT_GO_LISTEN="127.0.0.1:$port" RAFT_GO_DATA_DIR="$data" \
  RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175 RAFT_GO_MAIL_MODE=outbox "$TMPDIR/raft-m3" &
  RAFT_GO_TEST_URL="$origin" RAFT_GO_TEST_DATA="$data" \
    node tests/acceptance/m3-computer-admission.mjs
  ```
  (四个非 persistence 模块均可如此独立运行;m3-persistence 需要 run.mjs 的 start/stop 闭包。)

### 依赖状态快照(2026-10-08,第二轮更新)

- CHANNEL/COMPUTER/MACHINEWS 三份 worker 契约(`docs/m3-{channel,computer,machinews}-contract.md`)已于本套件编写中途出现并完成对齐:private join 403、runners 双态断言、legacy machine 注册/轮换链、pong 触发重验证均已按其契约修正(见 §3 各条)。AGENT worker 契约文档尚未出现;§3.4 仍全部钉自 TS 源码,internal/agent 代码已在落地,其契约发布后请复核 §4.3 对齐点。
- Go 基线核实:`internal/` 下仅有 auth/workspace;`/internal/`、`/daemon/` 走 501 `feature_not_implemented`;go.mod 已由 parent 加入 `github.com/coder/websocket v1.8.15`。

## 6. 已知边界(不冒充)

- 不验收:Socket.IO(M4)、消息/unread(M4)、@投递(M5)、浏览器 UI、OS supervisor、真实 LLM/provider 调用、外部 SMTP。
- server 30s 周期 ping 与 daemon 70s watchdog 不等待真实时钟;用协议内 ping 验证活性。
- 撤销对已建立连接允许 ≤30s 有界延迟(实现可选即时回调或心跳复核)。
- device authorize 的 503(未配置 app URL)与过期(410 expired_token)分支依赖时钟/配置控制,黑盒不可达,不在断言内;`authorization_pending/access_denied/device_code_consumed/device_code_invalid` 等可达分支全覆盖。
