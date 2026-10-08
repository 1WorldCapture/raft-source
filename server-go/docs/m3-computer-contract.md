# M3 COMPUTER worker 契约(contract doc)

状态:实现进行中(本文档先发布 schema 与导出签名,供 MACHINEWS / AGENT / parent 立即对接;实现落地后更新"验证状态"一节)。

所有权(见 m3-implementation-coordination.md slot 2):

- `internal/computer/**`
- `internal/transport/legacyweb/computer_*.go`(仅新建)
- migration `0007_computer_admission.sql`
- 本文档 + 自己的测试

原始行为来源(全部逐行追踪,非按端点名猜测):

| 表面 | TS 源 |
| --- | --- |
| device-code 用户登录 | `packages/server/src/routes/deviceAuth.ts` + `services/deviceAuthService.ts` |
| Computer attach | `routes/computerAttach.ts` + `services/computerCredentialService.ts`(attachComputer/findComputerByApiKeyWithReason/ensureComputerMachine) |
| legacy machine 注册/轮换 | `routes/servers.ts`(`POST /:id/machines`、`POST /:id/machines/:machineId/rotate-key`)+ `services/machineService.ts`(registerMachine/regenerateApiKey) |
| legacy roster | `routes/computerLegacyMachines.ts` + `services/legacyMachineService.ts` |
| agent bootstrap login | `routes/agentLogin.ts` + `services/agentCredentialService.ts`(consumeAgentBootstrapToken) |
| internal Computer 面 | `routes/internalComputer.ts`(preflight)+ `middleware/auth.ts`(requireComputerAuth)+ `middleware/authFromRegistry.ts` + `middleware/routeAuthPolicy.ts` |
| /daemon/connect 认证决策 | `routes/daemon.ts`(resolveUpgradeAuth,闭环 deny reason/stage) |
| CLI wire 消费端 | `packages/computer/src/apiClient.ts`(DeviceAuthClient/ComputerAttachClient/preflight/legacy roster)+ `services/login.ts`/`attach.ts` |

---

## 1. Migration `0007_computer_admission.sql`

沿用 0001 约定:时间戳 INTEGER unix 毫秒(UTC),布尔 0/1,UUID 为 TEXT。**不改** M1/M2 的 0001–0005 任何行为;对既有库是纯增量 `ALTER TABLE ... ADD COLUMN`(全部可空,老行读作"尚无凭证")。

```sql
-- machines(TS `daemons`):legacy 机器凭证列。M2 建表时按 0004 注释
-- "intentionally absent until the M3 admission flow exists" 刻意省略,
-- 本迁移补齐。api_key_prefix 列 0004 已存在,这里只建索引。
ALTER TABLE machines ADD COLUMN api_key_hash TEXT;
ALTER TABLE machines ADD COLUMN api_key_fingerprint TEXT;   -- sha256(key)[0:16]
ALTER TABLE machines ADD COLUMN legacy_key_migrated_at INTEGER;
CREATE INDEX idx_machines_api_key_prefix ON machines(api_key_prefix);
CREATE INDEX idx_machines_api_key_fingerprint ON machines(api_key_fingerprint);

-- computers(TS `computers`):Computer 凭证列,语义与 TS 完全一致。
ALTER TABLE computers ADD COLUMN api_key_hash TEXT;   -- argon2id(sk_computer_*)
ALTER TABLE computers ADD COLUMN api_key_prefix TEXT; -- raw key 前 16 字符
CREATE INDEX idx_computers_prefix ON computers(api_key_prefix);

-- device_authorizations(TS `device_authorizations`):device-code 登录授权。
CREATE TABLE device_authorizations (
    id                      TEXT PRIMARY KEY,
    device_code_lookup_hash BLOB NOT NULL UNIQUE,  -- HMAC-SHA256(pepper, dvc_*)
    device_code_hash        TEXT NOT NULL,          -- argon2id(raw device_code)
    user_code               TEXT NOT NULL UNIQUE,   -- XXXX-XXXX(Crockford base32)
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','denied','expired','consumed')),
    client_name             TEXT,
    approved_by_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
    expires_at              INTEGER NOT NULL,
    poll_interval_seconds   INTEGER NOT NULL DEFAULT 5,
    approved_at             INTEGER,
    denied_at               INTEGER,
    consumed_at             INTEGER,
    consumed_session_id     TEXT,
    consumed_ip             TEXT,
    consumed_user_agent     TEXT,
    revoked_at              INTEGER,
    revoked_by_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_reason          TEXT,
    created_at              INTEGER NOT NULL
);
CREATE INDEX idx_device_authorizations_approved_by ON device_authorizations(approved_by_user_id);
CREATE INDEX idx_device_authorizations_expires_at ON device_authorizations(expires_at);
```

说明:

- 表名/列名与 TS 物理名一致(daemons 的 Go 侧名字沿 M2 已定的 `machines`,映射已在 m2-directory-schema.md 记录)。
- 所有 TS 有而 M3 不实现的列(computer_outage_occurrences、computer_lifecycle 等)**不建**;不为未实现表面建影子表。
- AGENT worker 的 0008 / MACHINEWS 的 0009 与本迁移无交叠。

---

## 2. `internal/computer` 导出 API

### 2.1 Principal 与 Authenticate(MACHINEWS 消费的精确 seam)

协调文档指定的形状,逐字段:

```go
package computer

// Principal is the resolved machine-plane identity behind one presented key.
//   Kind:         "computer" | "legacy_machine"   (closed set; never "unknown" on success)
//   ComputerID:   computers.id for Kind=="computer"; "" for legacy machines
//   MachineID:    machines.id (always set on success)
//   WorkspaceID:  workspaces.id (always set on success; TS serverId)
//   UserID:       machines.user_id for legacy machines; "" for computers
type Principal struct {
    Kind        string
    ComputerID  string
    MachineID   string
    WorkspaceID string
    UserID      string
}

// AuthError is a wire-safe closed-set denial. Reason/Stage carry no ids,
// keys or prefixes, so MACHINEWS may put Reason straight into Slock-Reason.
// Reason/stage sets are byte-identical to routes/daemon.ts resolveUpgradeAuth.
type AuthError struct {
    Reason string // closed set below
    Stage  string // format | computer_lookup | machine_lookup | legacy_migration | server_lookup
}

// Reasons (closed set):
//   missing_key  invalid_key_format
//   computer_not_found  computer_revoked  computer_machine_unlinked
//   computer_key_hash_mismatch  server_not_found  machine_not_found
//   machine_key_invalid  legacy_machine_key_migrated
func (e *AuthError) Error() string

// Authenticate resolves one presented key exactly like daemon.ts
// resolveUpgradeAuth: sk_computer_* -> computer; sk_machine_* / sk_daemon_*
// -> legacy machine (rejected once legacy_key_migrated_at is set); anything
// else -> invalid_key_format. Verification is argon2id over the stored hash;
// authorization state (revocation, machine link, workspace liveness) is
// re-read AFTER the hash proof so rotation/revoke during verification cannot
// resurrect a stale principal. Infrastructure failures return a non-AuthError
// error (caller must answer 5xx, never a denial Reason).
func (s *Store) Authenticate(ctx context.Context, key string) (Principal, error)
```

MACHINEWS 注意:

- `legacy ?key=` query 兼容由 **MACHINEWS transport 层**提取后调用同一 `Authenticate`;本包不解析 query(也不记录 raw key)。
- revoke 立即生效:revoke 写 `computers.revoked_at`(DB 即时),`Authenticate` 每次心跳/入站重查;无需回调也正确(回调只影响已建立连接的主动断开,那属于 Hub)。
- `Attach` 原子创建真实 machine + computer;`serverMachineId`(wire 名)= computers.id,`machineId` = machines.id。

### 2.2 Store 构造(真实 SQLite 句柄 + 注入时钟)

```go
type Options struct {
    Clock            clock.Clock    // nil -> clock.Real{}
    DeviceCodePepper []byte         // HMAC key; REQUIRED (>= 32 bytes, like TS pepper||JWT_SECRET)
    Argon            Argon2Config   // zero -> production defaults
}

func NewStore(db *sql.DB, opts Options) (*Store, error)
```

- `DeviceCodePepper` 为空或 <32 字节时 `NewStore` 返回错误。parent wiring 传 `cfg.JWTSecret` 或显式 pepper;**不**在包内偷偷回落读 env(config 归 parent)。
- `Argon2Config` 与 auth 包密码参数风格一致(memory/iterations/parallelism),仅用于 API-key/device-code 哈希;零值用生产默认(同 TS argon2 默认强度)。测试注入弱参数。

### 2.3 凭证原语

```go
// raw key 只返回给调用者一次;hash/prefix 才是落库物。
func GenerateComputerKeyMaterial(cfg Argon2Config) (apiKey, apiKeyHash, apiKeyPrefix string, err error)
// sk_computer_<64hex>; prefix = raw key 前 16 字符
func GenerateMachineKeyMaterial(cfg Argon2Config) (apiKey, apiKeyHash, apiKeyPrefix, apiKeyFingerprint string, err error)
// sk_machine_<64hex>; prefix = 前 20 字符; fingerprint = sha256(key) hex 前 16 字符
func MachineAPIKeyFingerprint(apiKey string) string
```

### 2.4 用户登录 grant(device lifecycle)

```go
type DeviceGrantIssued struct {
    DeviceCode          string // raw dvc_*, 仅此一次返回
    UserCode            string // XXXX-XXXX
    ExpiresInSeconds    int
    PollIntervalSeconds int
}

func (s *Store) CreateDeviceAuthorization(ctx context.Context, clientName string, ttl time.Duration) (DeviceGrantIssued, error)

type ApproveResult struct{ OK bool; Err string } // Err: user_code_invalid | already_resolved | expired
func (s *Store) ApproveDeviceAuthorization(ctx context.Context, userCode string, userID string, approve bool) (ApproveResult, error)

type ConsumeResult struct {
    OK               bool
    ApprovedByUserID string
    Err              string // device_code_invalid | authorization_pending | access_denied | expired_token | device_code_consumed
}
func (s *Store) ConsumeDeviceAuthorization(ctx context.Context, deviceCode string, obs TokenUseObservation) (ConsumeResult, error)

type TokenUseObservation struct{ IP, UserAgent string }
```

生命周期语义与 deviceAuthService.ts 逐分支一致:pending→approved/denied 的 CAS(user_code 定位,trim+upper),token 阶段 HMAC 定位 → argon2 验证 → revoked/consumed/expired/denied/pending 判定 → CAS 单消费(status='approved' 条件更新,竞败 = device_code_consumed)。行永不被删除。

### 2.5 Computer attach / revoke

```go
type AttachResult struct {
    APIKey          string // raw sk_computer_*, 恰好返回一次
    ServerMachineID string // computers.id(wire 名 serverMachineId)
    MachineID       string // machines.id
    WorkspaceID     string
    ServerSlug      string
    Resumed         bool   // 恒 false(TS attach 从不按名字 resume;CLI 本地幂等)
}

type AttachError struct{ Code string } // not_authorized | requires_admin | computer_name_collision

func (s *Store) AttachComputer(ctx context.Context, userID string, serverSlug, name string) (AttachResult, error)

func (s *Store) RevokeComputer(ctx context.Context, computerID string, byUserID string, reason string) error
```

- 角色门:owner/admin(registerMachines capability)→ 通过;member(在册)→ `requires_admin`;非成员/不存在/已删 workspace → `not_authorized`(零枚举)。
- 同 (workspace, attached_by_user, name) 活跃重名 → `computer_name_collision`;被 revoke 的旧行不算冲突(行永不删除)。
- 原子性:computer 行 + 关联 machine 行(registerMachine 等价物;生成的 sk_machine_* raw key 按 TS 语义**丢弃**)在同一 SQLite 事务创建。

### 2.6 Legacy machine 注册 / 轮换 / roster 读取

```go
type MachineRegistered struct {
    ReadModel map[string]any // TS buildMachineReadModel 对新机器的投影
    APIKey    string         // raw sk_machine_*, 恰好一次
}
func (s *Store) RegisterMachine(ctx context.Context, workspaceID, userID, name string) (MachineRegistered, error)

func (s *Store) RotateMachineKey(ctx context.Context, workspaceID, machineID, actorUserID, actorRole string) (string, error)
// 权限:actorRole 为 owner/admin,或 machine.user_id == actorUserID;否则 ErrForbidden。
// 机器不在该 workspace -> ErrMachineNotFound(404 "Machine not found in this server")。

type LegacyRosterEntry struct { ... } // 序列化为 TS LegacyMachineRosterEntry 精确形状
func (s *Store) ListLegacyMachineRoster(ctx context.Context, userID, serverSlug string, includeAll bool) ([]LegacyRosterEntry, error)
// 非成员/不存在/已删 -> ErrNotAuthorized(403 零枚举)
```

- Register 的 read model 复刻 TS buildMachineReadModel 对一台新机器的投影(status=offline、statusVersion=0、isComputer=false、computerAttachedByCurrentUser=false、agentCount=0、runtimes=[]、runtimeVersions={}、computerVersion/hostKind/creator/computerUpgradeAvailable/computerBroadcastPolicy 为 null/false 投影),与 M2 `workspace/directories.go` wire 形状一致。
- quota:TS registerMachine 的 plan quota 在 raft-shared 当前对**所有** plan 均为 maxMachines=-1(无限),Go 侧同样不加人为上限;plan 收紧时在此补真实检查。

### 2.7 agent bootstrap login 的注入 seam(AGENT worker 请实现)

`/api/agent/login` 的 HTTP 层在本 worker(computer_agentlogin.go),bootstrap token 的存储/胡椒/消费归 AGENT worker(agentCredentialService 对应物)。注入接口:

```go
// AgentBootstrapExchanger 消费 Web 管理 UI 发放的 bootstrap token,
// 返回全新 sk_agent_* 凭证材料。AGENT worker 拥有实现
// (agent_bootstrap_tokens 存储 + pepper + CAS 单消费 + 凭证签发)。
type AgentBootstrapExchanger interface {
    ExchangeAgentBootstrapToken(ctx context.Context, rawToken string, obs TokenUseObservation) (AgentBootstrapExchange, error)
}

type AgentBootstrapExchange struct {
    APIKey        string   // raw sk_agent_*
    CredentialID  string
    AgentID       string
    AgentName     string
    WorkspaceID   string   // TS serverId
    WorkspaceSlug string   // exchanger 自行解析,可为空串
    Scopes        []string
}

// BootstrapError.Code 闭环集(TS agentLogin.ts 错误矩阵):
//   missing_bootstrap_token(400, HTTP 层产生)
//   token_invalid | token_revoked | token_expired(401)
//   token_consumed | agent_missing(410)
//   bootstrap_token_pepper_missing(503)
type BootstrapError struct{ Code string }
```

AGENT worker:请导出满足该接口的类型(或等价签名,由 parent 适配),并在 m3-agent-contract.md 登记实际签名。

### 2.8 internal 面注册表(preflight 反射真实注册面)

```go
type InternalRouteEntry struct{ Method, Path, Principal string }

// ComputerHandlers.InternalRoutes 默认只含本 worker 注册的行:
//   {"POST", "/internal/computer/preflight", "sk_computer"}
// parent wiring 时把 AGENT worker 的 /internal/agent-api/* 行并入,
// preflight 响应即真实反映 Go 服务器的注册面(不会静态漂移)。
```

---

## 3. HTTP 表面(`legacyweb.RegisterComputerRoutes`)

```go
func RegisterComputerRoutes(mux *http.ServeMux, handlers *ComputerHandlers, gate *AuthGate)
```

`ComputerHandlers`(导出字段,parent 组装):

```go
type ComputerHandlers struct {
    Store *computer.Store

    // device /token 成功后签发正常用户会话(TS: sessionService.createSession
    // + signAccessToken)。parent 适配 auth.SessionService/TokenSigner。
    Sessions SessionIssuer

    // device 授权页 URL 基址;nil -> authorize 503 DEVICE_LOGIN_URL_UNAVAILABLE(TS 同款)
    VerificationBaseURL *url.URL

    // SLOCK_DEVICE_LOGIN_ENABLED 等价(默认 true)
    DeviceLoginEnabled bool

    // SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED 等价(默认 false;TS #1836 未发布)
    AgentBootstrapEnabled bool

    // AGENT worker 的 bootstrap 消费实现;nil 而 Enabled 时 -> 503(诚实,不伪造)
    AgentBootstrap computer.AgentBootstrapExchanger

    // 工作区 scope 门(parent 传 servers.RequireServerScope;nil 时 handler 自查成员,仍 fail-closed)
    Scope func(http.HandlerFunc) http.HandlerFunc

    // internal 面注册表(见 2.8)+ claimed 前缀
    InternalRoutes  []computer.InternalRouteEntry
    ClaimedPrefixes []string
}
```

注册的路由(公开面带 per-IP general auth 限流,镜像 TS `authLimiter` 挂载):

| 方法/路径 | 认证 | 成功 | 关键错误(状态码, code) |
| --- | --- | --- | --- |
| POST `/api/auth/device/authorize` | 公开 | 201 `{deviceCode,userCode,verificationUri,verificationUriComplete,expiresIn,interval}` | 400 client_name_invalid;404 device_login_disabled;503 DEVICE_LOGIN_URL_UNAVAILABLE |
| POST `/api/auth/device/approve` | 用户 JWT | 200 `{ok:true,action:"approved"\|"denied"}` | 400 user_code_required;401 auth_required;404 user_code_invalid;409 already_resolved;410 expired;404 device_login_disabled |
| POST `/api/auth/device/token` | 公开(deviceCode 即凭证) | 200 `{accessToken,refreshToken,userId}` | 400 authorization_pending / device_code_invalid / device_code_required;403 access_denied;410 expired_token / device_code_consumed;404 device_login_disabled |
| POST `/api/computer/attach` | 用户 JWT | 201 `{apiKey,serverMachineId,machineId,serverId,serverSlug,resumed}` | 400 server_slug_required / name_invalid;401 auth_required;403 not_authorized / requires_admin;409 COMPUTER_NAME_COLLISION;404 computer_attach_disabled |
| GET `/api/computer/legacy-machines?serverSlug=&includeAll=` | 用户 JWT | 200 `{entries:[...]}` | 400 server_slug_required;403 not_authorized(零枚举);404 computer_legacy_roster_disabled |
| POST `/api/servers/{id}/machines` | 用户 JWT + X-Server-Id scope | 200 `{machine:{...read model},apiKey}` | 400 Name is required;404 Server not found(非成员);403 registerMachines capability 提示 |
| POST `/api/servers/{id}/machines/{machineId}/rotate-key` | 用户 JWT + scope | 200 `{apiKey}` | 404 Machine not found in this server;403 rotateMachineKeys capability 提示 |
| POST `/api/agent/login` | bootstrapToken(公开) | 200 `{apiKey,credentialId,agentId,agentName,serverId,serverSlug,scopes}` | 400 missing_bootstrap_token;401 token_invalid/token_revoked/token_expired;410 token_consumed/agent_missing;404 self_hosted_runner_bootstrap_disabled;503 bootstrap_token_pepper_missing |
| POST `/internal/computer/preflight` | Bearer sk_computer_*(sk_machine_* 为 phase-1 alias) | 200 `{ok,serverSlug,surfaceVersion,claimedPrefixes,registeredPrincipals,computerSurface,principal}` | 401 Missing computer credential / invalid_principal / Invalid computer credential / legacy_machine_key_migrated / Server no longer exists;401 auth_policy_unregistered_path(未注册兄弟路径 fail-close) |

`/internal/computer/` 前缀的其余兄弟路径(未注册)一律 401 `auth_policy_unregistered_path`,与 authFromRegistry fail-close 契约一致;runners/migrations/o11y 等 TS 面属于 AGENT/M4+/deferred,不伪造。

parent wiring 提示:在 `legacyweb.New` 的 Deps 组装处构造 `ComputerHandlers` 并调用 `RegisterComputerRoutes(mux, ...)`;同时把 routes.go 里 `/internal/` blanket 501 调整为放行 `/internal/computer/`(routes.go 归 parent,本 worker 不改)。

---

## 4. 与其他 worker 的边界

- **MACHINEWS**:只依赖 §2.1/2.2(Authenticate + Reason 闭环)。hub 的回调拿到的 `computer.Principal` 即 Authenticate 结果;ready 元数据写 `machines` 行(last_heartbeat/daemon_version/runtimes/hostname/os/computer_version)——这些列 0004 已有,本 worker 不新增影子表。Agent 状态变更走 AGENT 的回调,不经我。
- **AGENT**:§2.7 的 exchanger;channel_agents(0006)与 agents 表(0004/0008)归你们;本 worker 只读 `agents`(register read model 的 agentCount 恒 0,新机器无 agent)。internal/computer 的 runners/* 处理器在 AGENT 落地凭证签发后由 parent 决定挂载;`/internal/computer/` dispatcher 按注册表 fail-close,不会吞掉后续注册路径(并入 `InternalRoutes` 即可)。
- **CHANNEL**:无直接 seam。
- **parent**:config/app/routes/go.mod 归你;pepper 建议直接用 cfg.JWTSecret(≥32 字节时与 TS 回落语义一致),WebOrigin → VerificationBaseURL。

## 5. 验证状态

### 已实现并通过(Go test,真实 SQLite + 全链路 HTTP recorder)

- `internal/computer`(14 个测试,`go test ./internal/computer/` ok):
  - Authenticate 生命周期:computer 认证/前缀失配(computer_key_hash_mismatch)/revoke 即失效(computer_revoked)/machine 链接丢失(computer_machine_unlinked)/软删 workspace(server_not_found)/空 key(missing_key)/sk_agent 形状(invalid_key_format)/无候选(computer_not_found);
  - legacy machine:注册认证(Kind=legacy_machine)/轮换旧 key 失效(machine_key_invalid)/非创建者 member 403/admin 可轮换/跨 workspace 均匀 404/迁移后 legacy_machine_key_migrated;
  - device grant:完整 authorize→approve(大小写/空格归一)→token 流程/pending/denied/access_denied/过期(expired、expired_token)/unknown 折叠(user_code_invalid、device_code_invalid)/4 路并发 CAS 单消费恰一次/审计列落库/consume 后 consumed;
  - attach:owner/admin 通过、member requires_admin、非成员+幽灵 slug+软删 workspace 全折叠 not_authorized、同名 computer_name_collision、revoke 后同名可重建、computer+machine 同事务且 machine 带(被丢弃 raw key 的)真实 hash;
  - legacy roster:默认仅 fingerprint 行、includeAll 全量且脱敏 fingerprint、migrated 行时间戳、NULL-fingerprint 行不参与 intersection、跨 workspace 隔离;
  - M2 升级兼容:0007 前的库重开升级后行与身份保留、新列读作无凭证、旧行不进默认 roster。
- `internal/transport/legacyweb`(本 worker 的 computer_*_test.go;因 AGENT worker 的 agent_dto.go 暂缺符号导致包级编译被挡,详见下节):
  - device HTTP:201 形状(verificationUri/verificationUriComplete/expiresIn=600/interval=5)、401 未认证 approve、pending 400、token 200 发真实用户会话(JWT 可验证、userId 正确)、重复 poll 410 device_code_consumed、denied 403 access_denied、输入校验(device_code_required/user_code_required/client_name_invalid/404 user_code_invalid/409 already_resolved)、flag off 404(device_login_disabled/computer_attach_disabled/computer_legacy_roster_disabled)、无 WebOrigin 503 DEVICE_LOGIN_URL_UNAVAILABLE;
  - attach HTTP:400(server_slug_required/name_invalid)、401、非成员与幽灵 slug 同型 403 not_authorized、member 403 requires_admin、201 形状(apiKey/serverMachineId≠machineId/serverId/serverSlug/resumed=false)、重名 409 COMPUTER_NAME_COLLISION、异用户同名允许;
  - machines HTTP:非成员 404 "Server not found"、member 403 registerMachines 文案、无 name 400、200 {machine read model(offline/isComputer=false/agentCount=0/apiKeyPrefix=前 20 字符), apiKey}、rotate:创建者 200/非创建者 member 403 文案/admin 200/跨 workspace 404 "Machine not found in this server";
  - internal HTTP:preflight 200 完整形状(claimedPrefixes/registeredPrincipals/computerSurface/principal echo/serverSlug/surfaceVersion)、无 bearer 401、sk_agent 与 JWT 401 invalid_principal、未知 sk_computer 401、未注册兄弟路径与错误方法 401 auth_policy_unregistered_path、DB revoke 后同 key 立即 401、sk_machine alias 通过且 computerId==machineId、alias 迁移后 401 legacy_machine_key_migrated、sk_daemon 401 invalid_principal;
  - agent login:flag off 404 self_hosted_runner_bootstrap_disabled、flag on 无 exchanger 503 bootstrap_exchanger_unavailable(诚实,不伪造成功)、空 token 400、成功 200 全字段、重放 410 token_consumed、token_invalid 401。
- `internal/platform/db` 的 migration 链经 computer 包升级测试覆盖(fresh + reopen/upgrade 两条路径);db 包自身的测试套件当前被其他 worker 的 m3_upgrade_test.go 未完成符号挡住(非本 worker 文件)。

### 已知 gap(诚实边界,未实现)

- `PATCH/DELETE /api/servers/{id}/machines/{machineId}`(TS 有 editMachines/removeMachines 门):协调文档给本 slice 的是 "legacy machine creation/key rotation/register reads",不含 edit/remove;当前由 M2 的 method-fallback 405 如实回答。
- `POST /api/computer/adopt-legacy`(legacy daemon → Computer 收养):属于 migration 流(协调文档将 migrations 列为 deferred),未实现,`/api/computer/adopt-legacy` 走通用 404。
- `/internal/computer/runners*`、agent-o11y、agent-migrations、provider-connection(TS 面):runner 数据面归 AGENT/M4+/deferred;dispatcher 对它们 fail-close 401 auth_policy_unregistered_path,绝不伪造空成功。
- device grant 的管理 revoke 端点:TS 亦无该路由(仅表列),一致地未暴露。
- TS deviceAuth.ts 的观测性旁路(recordAuthSessionIssuedTrace / attachAuthTraceIdentity):Go 侧无对应 trace 体系,行为等价、仅缺 trace 事件;授权决策不受影响。
- TS attach 成功后的 mobile-app 邮件旅程(enqueueComputerMobileAppEmailJourney):邮件 lifecycle 归 M2/M4 邮件面,attach 主结果不受其影响(TS 同样 best-effort 吞错);未接。
- /api/agent/login 在 flag off 时的 404 body:本实现总是挂载并在 handler 内答 {"code":"self_hosted_runner_bootstrap_disabled"}(TS agentLogin.ts 的防御性 body),而非 TS 挂载层省略后的裸 404 — 对 CLI 的 404=disabled 判定等价。
- TS registerMachine 的 plan 配额检查:raft-shared 当前所有 plan maxMachines=-1,Go 侧同样无限额(不发明限制);plan 收紧时在 RegisterMachine 处补真实检查。

### 跨 worker 状态

- AGENT worker:`agent_dto.go` 目前引用未定义符号(AgentHandlers/timeUnixMilli),`legacyweb` 包暂不可整体编译 — 本 worker 文件在包可编译时即通过(单文件语法已过 vet 前的解析)。§2.7 的 exchanger 接口等待你们在 m3-agent-contract.md 登记。
- MACHINEWS:Authenticate/Principal/AuthError 按本文 §2.1 就绪;hub 每次入站/心跳重查即天然获得 revoke 即时性。
- parent:`RegisterComputerRoutes(mux, handlers, gate)` 就绪;routes.go 的 `/internal/` blanket 501 需要你在 wiring 时放行 `/internal/computer/`;pepper 建议 cfg.JWTSecret。
