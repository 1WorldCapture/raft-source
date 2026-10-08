# M3 后端实施与联调交接

日期：2026-10-08。目录：`server-go/`。阶段依据：`architecture-and-phase-1.md` 的 M3 与 `m3-implementation-coordination.md`。

本轮保留已有 M1/M2 及未提交 M3 实现，完成模块接线、原客户端兼容与后端验收。**不运行 Web UI 端到端测试，不启动真实 LLM，不替测试人员签署界面验收。** 下文区分已实现能力、实际执行证据和后续阶段边界。

## 1. 交付范围

| 模块 | M3 后端范围 |
|---|---|
| 频道 | 公共/私有列表、详情、创建与编辑、成员和角色、加入/退出、归档/恢复、删除及系统频道保护；workspace/channel 双重隔离 |
| Agent | external/managed 身份、列表/详情/设置、机器分配、头像、官方 Cindy 与身份收养、start/stop/reset/delete、软删除和离线 purge 意图 |
| Agent 凭据与 CLI | 独立 `sk_agent_*` 签发/安全元数据列表/撤销、可选一次性 bootstrap；whoami、server directory、按 handle 解析的 channel-members，以及 capability 门禁 |
| Computer | 设备码申请/批准/拒绝/交换、attach、preflight、legacy machine 注册/编辑/删除/轮换；机器删除时拒绝仍被 Agent 占用的绑定 |
| Daemon | `/daemon/connect` 原始 WebSocket、首帧 `machine:context`、ready/心跳、连接替换、持久机器事实、撤销检查和停机回收 |
| 托管 Runner | Computer/legacy machine 身份下的 Runner 列表、Agent 凭据签发/撤销及停止；不接受用户 JWT 或别的机器冒充 |
| 创建表单 | runtime-options、form definitions、live model detect、option sources、rescan；内置元数据与机器实际回复结合，失败不伪造可用模型 |

M3 **不包含**消息持久化/历史/未读/Socket.IO（M4），也不包含可靠投递、ACK、任务与消息执行闭环（M5）。joint/cloud/provider-connection 等未启用能力仍按各路由明确拒绝。创建 Agent 身份、设置 `active` 派发投影或接收 `ready` 都不等于验证了模型供应商或完成了用户任务。

## 2. 本轮关键集成与修正

### 应用装配

`internal/app/m3.go` 在 HTTP listener 暴露前组装 Computer/Agent/Channel/Runner/RuntimeCatalog 与 machine hub。AgentHandlers 的实时目录和头像目录已注入；preflight 的 manifest 包含真正注册的 Agent CLI 读取，不登记尚未实现的消息 API。机器轮换/删除和 workspace setup reset 撤销提交后调用 hub 断连；事务回滚不会断开仍有效的连接。机器目录和 workspace setup 的在线信息来自本进程连接，不使用持久行冒充在线。

头像与其他头像共用受控、内容寻址的 PNG 存储及既有读取路由。原客户端可经一个同源 origin 访问 `/api`、`/internal`、`/daemon`；代理必须支持 `/daemon/connect` 的 WebSocket upgrade。

### 身份与事务边界

机器首次认证验证真实 key，后续写操作核对该次认证证明的 verifier revision、撤销/迁移状态、workspace 及机器绑定。Agent 回调与 Runner 写入在**实际提交事务内**调用 `computer.ValidatePrincipalTx`；即使撤销前的请求排队、或者密钥在 Argon2 计算期间轮换，也不能凭旧身份签发新的 `sk_agent_*`。

legacy `sk_machine_*` 在对外 preflight 中保留 Computer alias 的原协议形状，但内部始终保留真实 principal kind、user、machine 与 credential revision；不把显示用 alias 当成鉴权证据。凭据只在签发响应出现一次，列表使用 `id`、`maskedToken` 和审计时间，不返回原 key。

频道的创建、修改、归档/恢复、删除及成员变更也在提交事务内重新核对真实 workspace membership、当前角色/capability 和频道归属；请求预检后发生降权或空间变更不能继续提交旧权限下的写入。测试同时覆盖私有频道成员与 DM participant 的绑定（不增加 DM 创建产品入口）。

官方身份、Agent membership、workspace onboarding 指针及 owner setup checkpoint 在同一 SQLite 事务提交。Agent 删除撤销凭据并保留可重试的 purge 意图。支持 launchId 的 daemon 使用启动代次隔离迟到的 status/session。

### 测试有效性修正

修复 machinews 测试等待函数的重复锁死锁；用 ping 往返作为限流测试的入站处理屏障，避免把“socket write 已完成”当成“服务端已消费”。runtimeVersions 是每次 ready 的新快照，不保留已不再报告的旧 runtime 版本。另修复“重连尚未 publish 就失败”丢失旧离线定时任务的分支：待成功发布才永久丢弃旧任务，失败则恢复；对应回归与相邻重连测试在 race 下连续执行 10 次通过。

按原 TS 源码校正四处验收假设，未放宽服务端安全行为：合法 workspace scope 查询外部 Agent 是 404，非成员 scope 是 403；凭据列表字段是 `id`；软删除 Agent 的受权 profile 仍为 200 且带 `deletedAt`；未指定机器时会自动选择本空间第一台机器，`machine_unassigned` 测试必须使用真正无机器的空间。

## 3. 验收记录

M3 后端收口检查已通过。下面只记录实际执行过的命令，不将后端通过当作 UI 验收。

| 命令/用例 | 本轮记录 |
|---|---|
| `RAFT_GO_TEST_SUITE=original-clients node tests/acceptance/run.mjs` | 通过：原版 Computer/Daemon 直连、设备授权链接 origin、同源代理与 `/api /internal /daemon` 转发 |
| `RAFT_GO_TEST_SUITE=agents node tests/acceptance/run.mjs` | 通过：9 组身份、隔离、凭据、bootstrap、wire 生命周期及官方 onboarding |
| `RAFT_GO_TEST_SUITE=persistence node tests/acceptance/run.mjs` | 通过：新进程登录、同 ID 频道/Agent、Agent/Computer 凭据及 Daemon 重连 |
| `RAFT_GO_TEST_SUITE=upgrade node tests/acceptance/run.mjs` | 通过：冻结 M2 二进制生成数据后升级至 M3；旧 M2 拒绝新 schema；M3 再启动保留新 Computer 凭据 |
| `go test -run TestRunner -count=1 -timeout=75s ./internal/agent ./internal/transport/legacyweb` | 通过：包括凭据轮换事务窗口、缺失/伪造 principal、UTF-16 名称边界 |
| `node tests/acceptance/run.mjs` | 通过：M1/M2 的 28 组、M3 Computer 6 / Daemon 8 / Agent 9 / Channel 7 / Creation read models 9 组，以及原客户端、重启、备份恢复和升级 |
| `RAFT_GO_TEST_SUITE=creation-read-models node tests/acceptance/run.mjs` | 通过：9 组真实目录/RPC、form ref、头像 PNG 读取、Agent CLI capability/handle 隔离、preflight 登记 |
| `go vet ./...` | 通过 |
| `make test-reference` | 通过：1,216 个冻结 TS 原函数与 Go 投影对照 |
| `make cross-build` | 通过：Linux/amd64、Windows/amd64；仅编译，不是目标系统运行验收 |
| `go mod verify` 与 `go mod tidy -diff` | 通过；WebSocket 库已按真实使用归类为直接依赖 |
| `make vuln` | 执行通过：扫描报告 0 个代码可达漏洞、0 个导入包漏洞；1 个模块级提示，见下文，不能简化为“依赖完全无告警” |
| `make check` | 全部通过：格式、vet、全量普通测试、全量 race、TS reference、完整 HTTP/协议/升级验收及本机 CGO-free 构建 |
| UI / 浏览器端到端测试 | **未执行，交给测试人员** |

`govulncheck@v1.8.0 -show verbose ./...` 的本次输出在 `golang.org/x/crypto` 模块层列出 GO-2026-5932（openpgp）；扫描没有发现本程序导入该受影响包或调用相应符号。保留这个提示，不宣称所有依赖在任何用法下均无漏洞。

HTTP 测试创建自己的临时目录、SQLite、密钥、outbox、端口和 Go 进程，只销毁自身资源。不会替换正在运行的用户服务或修改已有 `var/`。原版客户端兼容测试需要仓库的 `tsx` 与客户端依赖，但部署 Go 二进制不需要 Node、旧 TS Server、PostgreSQL 或 Redis。

## 4. 启动与联调

```sh
cd /Users/lyon/workspace/raft-source/server-go
make build

# 首次联调用新目录；不要把未备份的已有实例当测试数据。
export RAFT_GO_DATA_DIR="$PWD/var-m3-dev"
export RAFT_GO_WEB_ORIGIN=http://127.0.0.1:5175
./bin/raft-server
```

在另一个终端检查实际运行版本：

```sh
curl -i http://127.0.0.1:4301/version
curl -i http://127.0.0.1:4301/healthz
curl -i http://127.0.0.1:4301/readyz
```

`/version.stage` 应为 `m3`；响应的 `X-Raft-Go-Stage`、revision/build-time 可帮助排除浏览器代理仍指向旧 M2 进程的问题。`readyz` 只说明后端数据库/迁移可用，不说明模型或聊天闭环已就绪。

设备登录默认启用；`RAFT_GO_DEVICE_LOGIN_ENABLED=0`（也接受 false/no/off）可关闭对应新签发表面。Agent bootstrap 默认关闭，测试该入口时显式设置 `RAFT_GO_AGENT_BOOTSTRAP_ENABLED=true`。配置从环境读取，不自动加载 `.env`。不要将测试的低成本 Argon 参数带到生产环境。

## 5. 数据升级与回滚

M3 仅追加 `0006_channel_core.sql`、`0007_computer_admission.sql`、`0008_agent_identity.sql`，不改写已有 0001–0005。升级测试不是手工拼出新表冒充旧版本：它先构建冻结的、已提交 M2 程序，生成账号、会话、空间与偏好，再由 M3 在启动时增量迁移。

在线权威是当前 hub 连接，`machines.last_status` 仅是最后一次经过授权的持久观察；凭据已撤销或服务停机时，不承诺该列立即写成 offline。回调必须保留传入的 generation context；M3 `Send` 成功仅表示进入本代连接队列，不是持久 ACK，完整送达语义属于 M5。具体限制见 `m3-machinews-closeout.md`。

实际升级前优雅停止旧实例并完整冷备份 `RAFT_GO_DATA_DIR`，包括数据库、仍存在的 WAL/SHM、签名密钥与头像；外置 outbox/环境根密钥另存。不要在服务写入时仅复制 `raft.db`。本轮没有升级用户的已有实例。

已升级数据库不能直接交回 M2。回滚要同时恢复旧二进制和匹配的旧数据备份；旧程序遇到未来 schema 会拒绝启动，不降级、不清库。原密钥须与数据库配套恢复，否则已有会话和刷新收据无法复用。

## 6. 给 UI 测试人员的清单（本轮不执行）

这些是待人工/浏览器验收的场景，不是已通过证据：

1. 原 Web 注册、验证、workspace 创建后进入正确 Computer setup；刷新、重新登录和代理仍连接 M3，不能把请求失败后的前端降级当成成功。
2. 设备码批准/拒绝、Computer attach、在线/离线/重连；页面收到的模型选项与真实机器一致，离线/超时/未安装应显示可恢复错误。
3. 创建 managed/external Agent 与官方 Cindy；头像、设置、机器分配、启动/停止/reset/delete、官方身份收养及 setup/handoff 状态一致。
4. 公共/私有频道与成员角色、加入/退出、归档/删除；使用 owner/admin/member/guest 及另一空间检查可见性和禁止操作。
5. 凭据新建/遮罩列表/撤销、删除后 profile、连续点击及重新进入页面的状态恢复；密钥不得出现在公共日志、错误页面或可再次读取的列表。

消息/未读/Socket.IO/任务投递等后续表面不在 M3 UI 签收范围。实际供应商调用、外部 SMTP、公网 TLS/代理限流、生产负载与 Linux/Windows 真机行为也需要各自验收，不能用本机编译结果替代。

## 7. 相关依据

主装配：`internal/app/m3.go`。模块契约：`m3-channel-contract.md`、`m3-agent-contract.md`、`m3-computer-contract.md`、`m3-computer-management-contract.md`、`m3-runner-contract.md`、`m3-runtime-catalog-contract.md`、`m3-machinews-contract.md`。执行入口：`Makefile` 与 `tests/acceptance/run.mjs`。此前 worker 报告中的“待 parent 接线/尚未执行”是过程记录；当前装配和本交接的实际命令结果优先。
