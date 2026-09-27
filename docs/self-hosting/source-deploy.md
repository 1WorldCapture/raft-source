# 从源码部署 Raft（自托管指南）

本文说明如何在一台 Linux 机器上从源码部署一套完整可用的 Raft：服务端、Web、反向代理、本机 Computer（daemon），以及之后的升级和回滚。文中的做法和脚本都在真实环境里按步骤演练过，包括全新空库的初始化、升级、手动回滚和失败后的自动回滚。

> 约定：文中出现的 `raft.example.internal`、`/opt/raft/...`、`raft` 用户等都是**占位值**，请换成你自己的。本文和 `ops/self-host/` 里不包含任何真实的密钥、IP 或内部域名；这些值只放在不入库的文件里（`packages/server/.env`、`ops/self-host/env.local`、daemon 密钥文件）。

目录

0. [必读：进程环境隔离](#0-必读进程环境隔离)
1. [架构](#1-架构)
2. [前置依赖](#2-前置依赖)
3. [分支约定](#3-分支约定)
4. [拉代码和安装依赖](#4-拉代码和安装依赖)
5. [服务端配置 packages/server/.env](#5-服务端配置-packagesserverenv)
6. [数据库初始化和迁移](#6-数据库初始化和迁移)
7. [ops/self-host：运维脚本和 env.local](#7-opsself-host运维脚本和-envlocal)
8. [Web 生产构建和发布目录](#8-web-生产构建和发布目录)
9. [nginx](#9-nginx)
10. [pm2](#10-pm2)
11. [首次启动](#11-首次启动)
12. [本机 Computer（daemon）](#12-本机-computerdaemon)
13. [升级](#13-升级)
14. [回滚](#14-回滚)
15. [常见故障排查](#15-常见故障排查)
16. [客户端怎么连接自托管服务器](#16-客户端怎么连接自托管服务器)
17. [备份](#17-备份)

---

## 0. 必读：进程环境隔离

**这是整篇文档里最重要的一条。** 服务端的密钥只应该存在于 `packages/server/.env` 这一个文件里，由服务端进程自己加载；它们绝不能出现在任何其他进程的环境变量中。

### 为什么

- 进程的环境变量会被它启动的所有子进程继承。daemon 下面运行的是本机所有 Agent，以及它们执行的每一条命令。
- pm2 在 `pm2 start` 时会把**执行这条命令的 shell 的全部环境变量**保存进该进程的配置（以及 `~/.pm2/dump.pm2`），之后每次 `pm2 restart` 都会原样带上。
- `dotenv` **不会覆盖已存在的环境变量**。一个从外面继承来的 `DATABASE_URL`，优先级比 `.env` 里写的更高。

### 实际发生过的事故

一次运维操作前，有人在 shell 里加载过服务端的 `.env`，然后从这个 shell 用 pm2 启动了 daemon。结果：

1. daemon 进程带上了 `DATABASE_URL`、`JWT_SECRET`、`REDIS_URL`、`SCOPE_ATTESTATION_SECRET` 等服务端配置，以及 `NODE_ENV=development`；
2. 本机所有 Agent 及其命令都继承了这些值，任何 Agent 都能直接读到生产库的连接串和 JWT 签名密钥；
3. 之后从 Agent 的环境里启动的 nginx 等 pm2 进程，也把这些值保存进了 pm2 的配置和 dump 文件；
4. 在一个新建的空库上演练迁移时，继承来的 `DATABASE_URL` 盖过了 `.env`，**迁移命令实际连到了生产库**。所幸生产库当时已经是最新版本，预检判定为无需操作，没有造成改动；
5. 继承来的 `NODE_ENV=development` 还导致 Web 生产构建把开发工具打进包里，构建检查失败。

处理方式：用干净的环境 `pm2 delete` + `pm2 start` 重建 daemon 和相关进程，`pm2 save`，并核对进程环境和 dump 文件；之后评估是否轮换泄漏的密钥。

### 规则

1. **不要在交互 shell 里 `source packages/server/.env` 或 `export` 其中的变量。** 需要查数据库时，用单条命令的子 shell，或 `psql` 直接读连接串文件，用完即走。
2. **不要从加载过服务端配置的 shell 启动任何进程**，尤其是 pm2 进程。统一用干净环境启动：
   ```bash
   env -i HOME="$HOME" PATH="/opt/node-v24/bin:/usr/bin:/bin" pm2 start ops/self-host/ecosystem.config.cjs [--only <name>]
   pm2 save
   ```
3. `ops/self-host/ecosystem.config.cjs` 对所有进程启用 `filter_env: true`，不继承启动 shell 的环境；每个进程只拿到配置里显式给出的变量和自己的 `.env`。
4. **`pm2 restart` 不会刷新已保存的环境。** 要清除进程里已经带上的变量，必须 `pm2 delete <name>`，再用干净环境 `pm2 start ... --only <name>`，然后 `pm2 save`。
5. daemon 的环境里不能有 `NODE_ENV`（尤其不能是 `development`），也不能有任何服务端变量。
6. `ops/self-host` 的脚本在开头会先 `unset` 这些服务端变量，迁移脚本显式从 `.env` 读取连接串，不依赖调用者的环境。

### 怎么检查（只查变量是否存在，不输出值）

```bash
KEYS='^(DATABASE_URL|JWT_SECRET|REDIS_URL|SCOPE_ATTESTATION_SECRET|NODE_ENV)='
# 某个进程的实际环境（把 raft-daemon 换成要查的进程名）
tr '\0' '\n' < /proc/$(pm2 pid raft-daemon)/environ | grep -cE "$KEYS"      # 应为 0
# pm2 为各进程保存的环境
pm2 jlist | python3 -c "import json,sys; [print(a['name'], sorted(k for k in a['pm2_env'] if k in ('DATABASE_URL','JWT_SECRET','REDIS_URL','SCOPE_ATTESTATION_SECRET'))) for a in json.load(sys.stdin)]"
# pm2 的 dump 文件
grep -c DATABASE_URL ~/.pm2/dump.pm2                                          # 应为 0
# 当前 shell（在 Agent 里执行时即 Agent 的环境）
env | grep -cE "$KEYS"                                                         # 应为 0
```

### 机器注入的变量

有些运行平台会往 pm2 主进程（God daemon）或整台机器注入变量（例如某些 API key）。pm2 主进程的环境会被它的所有子进程继承，`filter_env` 挡不住这一层，重启 daemon 也清不掉。这类变量不属于服务端配置泄漏，要按平台的注入策略单独评估。检查方法：

```bash
tr '\0' '\n' < /proc/$(pgrep -f "PM2 v" | head -1)/environ | cut -d= -f1
```

## 1. 架构

```
   Web 浏览器 / 手机 App / 桌面端 / 其他机器上的 daemon
                     │  http(s)://raft.example.internal:3001   （可再加一个兼容端口，如 5173）
                     ▼
            ┌──────────────────┐
            │  nginx (pm2)     │  gzip、WebSocket 升级、长连接、上传大小、静态缓存
            └──┬────────────┬──┘
   /api /internal /socket.io │  其余路径
   /daemon /share /health    │
   /.well-known /robots.txt  ▼
               │     /srv/raft-web/current → releases/<sha>/   （Web 生产构建，SPA）
               ▼
      raft-server (pm2, tsx, 127.0.0.1:3101)
        │         │          │
    PostgreSQL  Redis     本地磁盘 uploads/（或 S3/R2）
     (必需)    (可选)
               ▲
      raft-daemon (pm2) ── 本机 Computer，承载本机的 Agent
      raft-trace-upload-worker (pm2，可选)
```

要点：

- **所有客户端只认一个公开地址**（上图是 `:3001`）。nginx 占用这个端口，服务端退到只监听本机的内部端口（`3101`）。这样以后加 nginx、换内部端口，客户端都不用改。
- Web 是**生产构建的静态文件**，由 nginx 直接提供；不要在线上跑 Vite 开发服务器（首屏要加载几百个模块，很慢）。
- 服务端直接用 `tsx` 运行 TypeScript 源码，和官方容器入口 `packages/server/entrypoint.sh` 一致（`packages/server` 的 tsconfig 是 `noEmit`，没有 `dist/server.js`）。
- 单实例部署时 Redis 是可选的；配置了 `REDIS_URL` 会启用多副本相关的能力（Socket.io adapter、跨副本路由、分布式锁）。

## 2. 前置依赖

| 组件 | 版本 / 说明 |
|---|---|
| Linux | 以 Debian 13 验证 |
| Node.js | ≥ 24（`package.json` 的 `engines`），建议装在独立目录，例如 `/opt/node-v24/bin` |
| pnpm | 10.29.3（`packageManager` 字段），用 `corepack enable` 启用 |
| PostgreSQL | 以 17 验证 |
| Redis | 可选 |
| nginx | 以 1.26 验证（Debian 包） |
| pm2 | `npm i -g pm2` |
| 其他 | git、python3、curl、openssl |

```bash
sudo apt-get install -y git curl python3 openssl postgresql nginx   # redis-server 可选
# Node 24：下载官方二进制包解压到 /opt/node-v24，然后
export PATH=/opt/node-v24/bin:$PATH
corepack enable
npm i -g pm2
```

**容器里没有 systemd 时**（PID 1 不是 systemd，`systemctl` 不可用）：

- apt 装 nginx 时 `policy-rc.d` 会阻止它自动启动，这是正常的；本文的 nginx **不作为系统服务运行**，而是由 pm2 以部署用户身份前台运行（监听的端口都大于 1024，不需要 root）。
- 没有 cron/logrotate 时，nginx 日志轮转也交给 pm2 的 `cron_restart`（见第 10 节）。
- 有 systemd 的机器也可以照用这套做法，所有进程统一由 pm2 管理，`pm2 startup` 负责开机自启。

## 3. 分支约定

| 分支 | 用途 |
|---|---|
| `main` | 跟随上游，不直接改 |
| `dev` | 我们自己的开发集成分支，PR 合到这里 |
| `deploy` | **线上唯一允许运行的代码**：`main` + 从 `dev` 挑选（cherry-pick 或合并）的修复 |

- 修复由开发侧合进 `deploy`；运维只从 `deploy` 拉代码部署。
- **不要在部署目录里手改源码。** 部署脚本要求部署目录里没有已修改的受版本控制文件，否则拒绝执行。
- 线上跑的是哪个提交，可以随时用 `GET /api/version` 查看（见第 5 节的 `RAFT_RELEASE_*`）。

### 3.1 代码怎么从开发流到线上

```
上游 ──同步──▶ main ──合并（不 rebase）──▶ dev ◀── 功能/修复 PR
                 │                         │
                 └──────▶ deploy ◀── cherry-pick -x（或整体合并 dev）
                              │
                              └──▶ 部署目录（只 checkout，不改）
```

1. **main 跟上游**：同步上游时直接快进或合并到 `main`，不在 `main` 上做自己的改动。
2. **main 进 dev 用合并，不用 rebase**：`dev` 上的提交已经被 PR 引用，改写历史会让 PR 和部署记录对不上。
3. **所有改动先进 dev**：功能和修复都发 PR 到 `dev`，审查合并后才考虑上线。不允许直接往 `deploy` 提交新代码。
4. **进入 deploy 的两种方式**：
   - **挑选单个修复**（常用）：`git cherry-pick -x <dev 上的提交>`。`-x` 会在提交信息里记下来源提交，之后对账时能知道 `deploy` 上的每个改动来自 `dev` 的哪次合并。只挑选服务端或 Web 需要的提交；只改桌面端、手机端或 CLI 的提交不需要进 `deploy`。
   - **整体追上 dev**：当 `deploy` 上挑选的提交越来越多、冲突变多，或者 `dev` 上有需要上线的大改动（例如 daemon、computer 包的变更）时，把 `deploy` 重置为 `dev` 的某个提交（在 `deploy` 上合并 `dev`，或者重建 `deploy` 分支）。这会同时带上 daemon 的改动，按第 12 节，要安排在有人值守的时间，并单独评估是否需要重启 daemon。
5. **谁负责**：开发侧负责更新 `deploy` 分支并说明本次上线包含哪些提交、是否需要重启 daemon、是否有数据库迁移；运维只从 `deploy` 拉代码部署，部署完用 `GET /api/version` 核对 `sha` 和 `branch`。
6. **上线前的检查**：`git log --oneline main..deploy` 看清楚本次比 `main` 多了哪些提交；`git diff <上次部署的 sha> <本次 sha> --stat` 看改到了哪些目录（`packages/server`、`packages/web` 需要重启 server 或重新构建 Web；`packages/daemon`、`packages/computer`、`packages/cli` 需要评估是否重启 daemon；`migrations` 需要先跑迁移）。

## 4. 拉代码和安装依赖

```bash
sudo mkdir -p /opt/raft && sudo chown raft: /opt/raft
git clone https://github.com/<your-org>/raft-source.git /opt/raft/source
cd /opt/raft/source
git checkout -B deploy origin/deploy
ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile
```

`ELECTRON_SKIP_BINARY_DOWNLOAD=1` 避免在服务器上下载桌面端的 Electron 二进制。

## 5. 服务端配置 packages/server/.env

服务端通过 `dotenv` 读取 `packages/server/.env`（不入库，权限建议 `600`）。完整的可选项见 `packages/server/.env.example`，下面是自托管实际用到的：

| 变量 | 必需 | 用途 | 示例（占位） |
|---|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串 | `postgresql://raft:<password>@127.0.0.1:5432/raft` |
| `JWT_SECRET` | 是 | 用户会话签名密钥，`openssl rand -hex 32` 生成。**更换后所有用户都要重新登录** | `<64 位 hex>` |
| `PORT` | 否 | 服务端监听端口。放在 nginx 后面时用内部端口 | `3101` |
| `HOST` | 否 | 绑定地址。放在 nginx 后面时设为 `127.0.0.1`，外部就无法绕过 nginx 直连 | `127.0.0.1` |
| `TRUST_PROXY` | 否* | 信任几层反向代理的 `X-Forwarded-For`（跳数、true/false 或地址列表）。**放在 nginx 后面时必须设置**，否则所有请求的来源 IP 都是 127.0.0.1，限流会把所有用户算成同一个人 | `1` |
| `SERVER_URL` | 是 | 服务端对外地址：daemon 回连、OAuth 回调默认值、分享页都用它。填**公开地址**（nginx 的端口），不是内部端口 | `http://raft.example.internal:3001` |
| `APP_URL` | 是 | 用户访问 Web 的地址：邮件链接、设备登录、推送链接等都用它 | `http://raft.example.internal:3001` |
| `CORS_ORIGIN` | 是 | 允许的浏览器来源，逗号分隔。Web 从哪些地址打开，就都列上 | `http://raft.example.internal:3001` |
| `NODE_ENV` | 否 | 自托管保持不设或 `development`。设为 `production` 会改变原生推送的证明校验、翻译服务、Slack Bridge 本地运行时等行为，需要单独评估 | — |
| `REDIS_URL` | 否 | 启用 Redis（多副本能力） | `redis://127.0.0.1:6379` |
| `SCOPE_ATTESTATION_SECRET` | 否 | 给外部 worker（trace 上传）签发证明的密钥，必须和 worker 一致 | `<随机串>` |
| `RAFT_RELEASE_SHA` | 否* | 当前运行的完整 40 位 commit SHA | 部署脚本自动写入 |
| `RAFT_BUILD_AT` | 否* | 部署时间，UTC ISO-8601，如 `2026-01-01T00:00:00Z` | 部署脚本自动写入 |
| `RAFT_RELEASE_BRANCH` | 否* | 部署来源分支 | 部署脚本自动写入 |
| `UPLOADS_DIR` | 否 | 本地附件目录。不设时是**服务端工作目录下的 `uploads/`**（即 `packages/server/uploads`）。建议显式放到源码目录之外，方便备份，也避免误删 | `/var/lib/raft/uploads` |

\* `TRUST_PROXY`、`HOST` 在 nginx 部署下必须设置。三个 `RAFT_RELEASE_*` 缺失时 `/api/version` 返回 503，不影响其他功能，由 `deploy.sh` 每次部署自动更新。

邮件（`RESEND_API_KEY`）、第三方登录（Google/GitHub/Apple）、Web Push（VAPID）、S3/R2、翻译等都是可选能力，按 `.env.example` 的说明配置即可；不配置时对应功能关闭或降级（例如邮件打印到日志）。

> ⚠️ **不要在交互 shell 里 `source packages/server/.env`，更不要从这样的 shell 启动 pm2 进程。** `dotenv` 不会覆盖已存在的环境变量，而 pm2 会把启动它的 shell 的环境保存到进程配置里：之后这些值会被带进 daemon，本机所有 Agent 都能读到数据库密码和 JWT 密钥；一个继承来的 `DATABASE_URL` 还会让迁移等命令悄悄连到别的库。`ops/self-host` 的脚本会先清掉这些变量，pm2 配置也用 `filter_env` 隔离（见第 10 节）。

## 6. 数据库初始化和迁移

创建数据库和用户：

```bash
sudo -u postgres psql -c "CREATE ROLE raft LOGIN PASSWORD '<password>'" \
                      -c "CREATE DATABASE raft OWNER raft"
```

迁移（首次建表和以后每次升级都一样）：

```bash
ops/self-host/migrate.sh
```

说明：

- 服务端**启动时不会自动迁移**，必须单独执行。
- `migrate.sh` 走服务端的受保护部署路径 `pnpm run db:migrate:deploy`：先做预检（对比迁移清单和库里的版本），再迁移，再做权限校验。
- 这条路径**要求迁移连接上显式设置 `statement_timeout`**：通过连接串里的 libpq 参数 `options=-c statement_timeout=<ms>` 生效，同时用 `SERVER_MIGRATION_EXPECTED_STATEMENT_TIMEOUT_MS` 声明同一个值，预检会读回来核对。直接跑 `pnpm run db:migrate:deploy` 会报 `[MIGRATION_PREFLIGHT_ABORT] MISSING_TIMEOUT`。`migrate.sh` 会基于 `.env` 的 `DATABASE_URL` 临时生成这个迁移连接串（只用于这一条命令，不影响运行中服务端的连接），超时取 `env.local` 里的 `RAFT_MIGRATION_TIMEOUT_MS`（默认 60000，范围 1000–3600000）。
- 成功时的输出：

  ```
  [MIGRATION_PREFLIGHT_OK] admit=BEHIND_MIGRATE ...   # 有待执行的迁移（全新空库也是这个）
  [MIGRATION_PREFLIGHT_OK] admit=AT_TARGET_NOOP ...   # 已是最新，无操作
  [MIGRATION_DEPLOY_OK] all pending migrations applied
  ```

  如果你明明是空库却看到 `AT_TARGET_NOOP`，说明连错了库——检查当前 shell 有没有继承 `DATABASE_URL`（第 5 节的警告）。
- 核对：`psql "$DATABASE_URL" -Atc 'select count(*) from drizzle.__drizzle_migrations'` 应该等于 `ls packages/server/drizzle/*.sql | wc -l`。
- 迁移**不会随回滚撤销**。上游的迁移按「先扩展、后收缩」编写，旧代码可以在新表结构上运行；如果某次升级包含破坏性迁移，需要单独评估。

## 7. ops/self-host：运维脚本和 env.local

| 文件 | 作用 |
|---|---|
| `env.example` | 本机配置模板。复制为 `env.local`（已被 `.gitignore` 忽略）后填写 |
| `lib.sh` | 公共函数；读取 `env.local`，并清掉继承来的服务端环境变量 |
| `build.sh [ref]` | 在独立 worktree 里安装依赖、生产构建 Web，发布到 `$RAFT_WEB_RELEASES/<sha>`。**不碰部署目录和任何进程** |
| `migrate.sh` | 数据库迁移（第 6 节） |
| `deploy.sh [ref] [--dry-run]` | 升级，失败自动回滚（第 13 节） |
| `rollback.sh [backup-dir]` | 回滚到上一次部署前的状态（第 14 节） |
| `render-nginx.sh [--reload]` | 用模板生成 nginx 配置并校验（第 9 节） |
| `nginx-logrotate.sh` | nginx 日志轮转，保留 14 天 |
| `ecosystem.config.cjs` | pm2 进程定义，所有机器相关的值都从 `env.local` 读取 |
| `nginx/` | nginx 配置模板 |

```bash
cp ops/self-host/env.example ops/self-host/env.local
$EDITOR ops/self-host/env.local
```

`env.local` 的主要字段：部署目录 `RAFT_ROOT`、允许上线的 ref `RAFT_DEPLOY_REF`（默认 `origin/deploy`）、`NODE_BIN_DIR`、运维工作目录 `RAFT_OPS_HOME`（构建 worktree、备份、日志、渲染后的 nginx 配置）、Web 发布目录、公开端口 `RAFT_PUBLIC_PORTS`、内部端口 `RAFT_SERVER_PORT`（必须和 `.env` 的 `PORT` 一致）、pm2 进程名、daemon 参数。**这里不放密钥。**

脚本可以放在任意目录运行（例如用另一份 checkout 里的新版本脚本）；用 `RAFT_OPS_ENV=/path/to/env.local` 指定配置文件。

## 8. Web 生产构建和发布目录

```bash
ops/self-host/build.sh            # 默认构建 RAFT_DEPLOY_REF 当前指向的提交
```

它做的事：

1. 在 `$RAFT_OPS_HOME/build/<sha>` 建一个干净的 worktree（不影响部署目录）；
2. `pnpm install --frozen-lockfile`；
3. `NODE_ENV=production VITE_COMMIT_SHA=<sha> ... pnpm --filter @botiverse/raft-web run build`；
4. 把 `packages/web/dist` 复制到 `$RAFT_WEB_RELEASES/<sha>`（先写到 `.partial` 再改名，不会出现半个版本）。

注意：

- **必须 `NODE_ENV=production`。** 如果构建环境继承了 `NODE_ENV=development`，Vite 会把开发工具（react-scan、react-grab）打进包里，构建自带的检查会失败：`[devtools-prod-bundle] dev-only package names leaked into production output`。
- 不要设 `VITE_API_URL`：Web 和 API 同源，留空时前端走相对路径。
- 设置了 `VITE_COMMIT_SHA`，构建才会生成桌面端需要的 `/desktop-manifest.json`（兼容性清单）。
- 字体：`main` 上的旧版本做生产构建会丢字体（上游 PR #28 修复，已进 `deploy`）。发布后可以检查 `dist/assets/` 里有没有 `.ttf`/`.woff2` 文件。
- 一次构建约 1–1.5 分钟，产物约 14MB。`/srv/raft-web/current` 是指向当前版本的软链接，切换版本就是原子地换这个软链接，nginx 不需要重载。
- 旧版本目录可以定期清理，保留最近几个用于回滚。

## 9. nginx

模板在 `ops/self-host/nginx/`，渲染到 `$RAFT_OPS_HOME/nginx/`：

```bash
ops/self-host/render-nginx.sh            # 生成并 nginx -t 校验
ops/self-host/render-nginx.sh --reload   # 生成、校验并平滑重载（不断连接）
```

渲染后的站点配置（`raft.conf`，占位值已替换）：

```nginx
upstream raft_server { server 127.0.0.1:3101; keepalive 32; }

map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 3001;      listen [::]:3001;
    server_name _;

    access_log logs/access.log raft;
    error_log  logs/error.log warn;

    root /srv/raft-web/current;
    index index.html;

    gzip on; gzip_vary on; gzip_proxied any; gzip_comp_level 5; gzip_min_length 1000;
    gzip_types text/plain text/css text/javascript application/javascript application/json
               application/manifest+json application/xml image/svg+xml font/ttf font/otf;

    client_max_body_size 256m;

    location ~ ^/(api|internal|socket\.io|daemon|share|\.well-known)/ { include raft-proxy.conf; }
    location = /health     { include raft-proxy.conf; }
    location = /robots.txt { include raft-proxy.conf; }

    location /assets/ {
        add_header Cache-Control "public, immutable, max-age=31536000";
        try_files $uri =404;
        location ~* \.ttf$ { default_type font/ttf; add_header Cache-Control "public, immutable, max-age=31536000"; try_files $uri =404; }
    }
    location = /sw.js { add_header Cache-Control "no-cache"; try_files $uri =404; }
    location = /desktop-manifest.json { default_type application/json; add_header Cache-Control "no-cache, must-revalidate"; try_files $uri =404; }
    location / { add_header Cache-Control "no-cache"; try_files $uri $uri/ /index.html; }
}
```

`raft-proxy.conf`：

```nginx
proxy_pass http://raft_server;
proxy_http_version 1.1;
proxy_set_header Host $http_host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $connection_upgrade;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
proxy_request_buffering off;
```

逐项说明：

- **反代的路径**和 `packages/web/vite.config.ts` 的开发代理一致（`/api`、`/internal`、`/socket.io`、`/daemon`），再加上服务端直接提供的公开路由（`/share`、`/health`、`/.well-known`、`/robots.txt`）。上游新增服务端根路由时要同步加到这里。其余路径都回退到 `index.html`（SPA），所以访问公开端口上不存在的路径会得到页面而不是 404 JSON。
- **gzip**：只压缩文本类响应；图片、视频、压缩包本身已经压缩过，不再压缩。`gzip_min_length 1000` 表示小于 1KB 的响应不压缩（例如 160 字节的 `/api/auth/providers`），这是正常的。日志格式 `raft` 里的 `gz=` 是压缩比，`-` 表示没压缩，可以用来核对。
- **字体类型**：Debian 的 `/etc/nginx/mime.types` 没有 `ttf`。不要在 server 级别写 `types { ... }` 补——那会**整个替换**默认类型表，其他文件全变成 `application/octet-stream`；所以在 `/assets/` 里单独给 `.ttf` 设置类型。
- **WebSocket**：`Upgrade`/`Connection` 头 + HTTP/1.1。socket.io、daemon 长连接（`/daemon/connect`，约 30 秒一次心跳）和 SSE 都是长连接，读写超时设为 1 小时，远大于心跳间隔。
- **上传大小**：附件单文件上限 Free 50MB、Pro 200MB（加少量余量），所以 `client_max_body_size 256m`；nginx 默认只有 1MB。
- **流式**：`proxy_buffering off` 让大文件下载和 SSE 直接流给客户端；`proxy_request_buffering off` 让大上传直接流给服务端，不先落 nginx 的临时文件。Range 请求（视频拖动进度条）原样透传，服务端返回 206。
- **缓存**：`/assets/` 下的文件名带内容哈希，设为一年 immutable；`index.html`、`sw.js`、`desktop-manifest.json` 不缓存，保证发布新版本后客户端能拿到新入口。
- **真实 IP**：nginx 追加 `X-Forwarded-For`，服务端要设 `TRUST_PROXY=1` 才会采信（第 5 节）。
- **IPv6**：同时监听 `[::]`。如果客户端通过只发布 AAAA 记录的名字（例如某些 VPN 的 MagicDNS）访问，只监听 IPv4 会连不上。
- 要保留一个旧端口（例如以前 Web 开发服务器用的 `5173`）给老客户端，把它加到 `RAFT_PUBLIC_PORTS` 即可，两个端口提供同一个站点；并把对应的来源加进 `CORS_ORIGIN`。

## 10. pm2

`ops/self-host/ecosystem.config.cjs` 定义了这些进程（名字可在 `env.local` 修改）：

| 进程 | 内容 |
|---|---|
| `raft-server` | `node <root>/node_modules/tsx/dist/cli.mjs src/server.ts`，工作目录 `packages/server` |
| `raft-nginx` | `nginx -p $RAFT_OPS_HOME/nginx -c nginx.conf -g 'daemon off;'` |
| `raft-nginx-logrotate` | 每天 UTC 04:00 由 pm2 `cron_restart` 触发一次日志轮转 |
| `raft-trace-upload-worker` | 可选；存在 `packages/trace-upload-worker/.env` 时才启用 |
| `raft-daemon` | 可选；`env.local` 里设置了 `RAFT_DAEMON_KEY_FILE` 时才启用（第 12 节） |

所有进程都设置了 `filter_env: true`，**不继承执行 `pm2 start` 的 shell 的环境变量**，只拿到配置里显式给的 `PATH`、`HOME` 等，以及各自的 `.env`。原因见第 5 节的警告。启动时最好也用干净的环境：

```bash
env -i HOME="$HOME" PATH="/opt/node-v24/bin:/usr/bin:/bin" pm2 start ops/self-host/ecosystem.config.cjs
pm2 save
pm2 startup      # 有 systemd 时生成开机自启；容器环境按平台方式拉起 pm2 resurrect
```

核对 pm2 保存的配置里没有密钥：

```bash
grep -c DATABASE_URL ~/.pm2/dump.pm2     # 应为 0
```

注意 pm2 主进程（God daemon）自身的环境变量会被所有子进程继承，`filter_env` 挡不住这一层；如果平台往 pm2 主进程里注入了变量，那是平台层面的事。

`pm2 restart <name>` 会沿用该进程保存的环境；要让新的 `filter_env` 或环境生效，需要 `pm2 delete <name>` 后重新 `pm2 start ... --only <name>`，再 `pm2 save`。

## 11. 首次启动

```bash
cd /opt/raft/source
# 1. 依赖：第 4 节；配置：第 5 节 .env、第 7 节 env.local
# 2. 数据库
ops/self-host/migrate.sh
# 3. Web
ops/self-host/build.sh
sudo mkdir -p /srv/raft-web/releases && sudo chown -R raft: /srv/raft-web
ln -sfn /srv/raft-web/releases/$(git rev-parse HEAD) /srv/raft-web/current
# 4. nginx
ops/self-host/render-nginx.sh
# 5. 进程
env -i HOME="$HOME" PATH="/opt/node-v24/bin:/usr/bin:/bin" pm2 start ops/self-host/ecosystem.config.cjs
pm2 save
# 6. 写入版本信息（部署同一个提交，会重启一次服务端，约 5 秒）
ops/self-host/deploy.sh
```

验证：

```bash
curl -s http://127.0.0.1:3001/health                         # {"status":"ok"}
curl -s http://127.0.0.1:3001/api/version                     # sha / builtAt / branch
curl -sI -H 'Accept-Encoding: gzip' http://127.0.0.1:3001/ | grep -i content-encoding   # gzip
ss -ltnp | grep 3101                                          # 只在 127.0.0.1 上
```

然后在浏览器打开公开地址，注册第一个用户并创建 server。

## 12. 本机 Computer（daemon）

daemon 是本机的「Computer」，负责在这台机器上运行 Agent。它从 `packages/daemon/dist/raft-daemon.js` 启动：

```bash
pnpm --filter @botiverse/raft-daemon build        # 生成 dist/（会先构建 CLI）
node packages/daemon/dist/raft-daemon.js --server-url <公开地址> --api-key-file <密钥文件>
```

- **机器密钥**：在 Web 的 server 设置 → Computers 里添加电脑，会给出一次性的 `sk_machine_...` 密钥（接口是 `POST /api/servers/:id/machines`，需要有注册机器权限的用户）。把它写进权限为 `600` 的文件，用 `--api-key-file` 传入；不要写在命令行参数或 pm2 配置里。
- **一个机器密钥只属于一个 server。** 同一台机器要加入多个 server，就为每个 server 各注册一次、各跑一个 daemon 进程（pm2 里复制一份配置，换名字和密钥文件）。多个 daemon 可以共用同一个 `SLOCK_HOME`：锁是按机器目录加的，本地代理端口是随机分配的。
- `SLOCK_HOME`（新名字 `RAFT_HOME` 优先）默认 `~/.slock`，存放机器目录、Agent 工作区等。
- `--server-url` 用**公开地址**（经过 nginx），不要用内部端口。

**重启 daemon 会让本机所有 Agent 掉线**，daemon 起来后它们会自动重连恢复（实测十几秒）。所以：

- 只有 daemon、CLI、computer 相关代码变化时才需要重启它；`deploy.sh` 发现这些目录有变化时只会提示，**不会自动重启 daemon**；
- 重启前通知在这台机器上工作的人；
- 如果执行重启的正是跑在这个 daemon 上的 Agent，要用脱离当前进程树的后台脚本执行（`setsid nohup ...`），脚本里做健康检查、失败时回退到旧配置，并事先设好提醒，恢复后回来核对结果。

### 12.1 daemon、Computer 和 CLI 的版本号

同一台机器上报给服务端的有两个版本号，在 Web 的「计算机」页面能看到：

- **daemon 版本**（`packages/daemon/package.json`）：真正连接服务器、运行 Agent 的进程。像本文这样直接运行 `raft-daemon.js` 的机器，页面上显示为「守护进程 v…」。
- **Computer 版本**（`packages/computer/package.json`）：外面包着 daemon 的宿主程序，负责后台服务、开机自启、升级等。独立安装的 `raft-computer` 和**桌面端内置**的 Computer 会上报这个版本。桌面端和菜单栏 App 打包时会把 Computer、daemon、CLI 的真实版本写死进包里（`packages/computer/scripts/embeddedVersionDefines.mjs`），不会报成 App 自己的版本号。

服务端拿 Computer 版本和官方发布渠道的最新版比较，决定是否提示「有可用更新」。几点注意：

- **桌面端内置的 Computer 跟随桌面端一起更新，不能单独升级。** 它的升级提示不应该出现（正在修改，服务端会识别「桌面端内置」并不再提示）；需要更新时，重新打桌面端包安装。
- **官方渠道的最新版可能比我们 fork 里的版本新**，所以独立安装的 Computer 显示「有可用更新」是正常的；是否跟进官方版本，由开发侧决定，不要直接在机器上执行升级。
- 看线上服务端本身的版本，用 `GET /api/version`（和 daemon、Computer 版本无关）。

### 12.2 桌面端对运维的影响

本机如果运行着桌面端（例如某台 Mac），它的 Computer 后台服务是由桌面端管理的：

- **关闭窗口不会停服务**：桌面端退到菜单栏，后台服务和 Agent 继续运行。
- **退出桌面端会停掉这台机器上的所有 Agent**：菜单栏「退出」、Cmd+Q、Dock 右键退出，都会先弹确认框，然后优雅地停掉后台服务、daemon 以及它们启动的全部 Agent 进程；桌面端崩溃或被强杀时，后台进程会在约 10 秒内自行退出，不留孤儿进程。所以在这类机器上，「退出桌面端」就等于让这台机器上的 Agent 全部下线，需要提前通知。
- **开机自启**：桌面端登录时以菜单栏形式启动，再由它拉起后台服务。
- 桌面端连哪个服务器是在**打包时**决定的（见第 16 节），服务器地址变了要重新打包。
- 退出后怀疑有残留进程时，按第 0 节的方法检查进程，只看是否存在，不要输出环境变量的值。

## 13. 升级

```bash
ops/self-host/deploy.sh --dry-run      # 只看计划
ops/self-host/deploy.sh                # 部署 RAFT_DEPLOY_REF（默认 origin/deploy）
ops/self-host/deploy.sh <sha|ref>      # 部署指定提交
```

`deploy.sh` 的流程：

1. 检查部署目录没有被手改；`git fetch`；比较当前提交和目标提交，得出计划：
   - lockfile 或任何 `package.json`、`patches/` 变了 → 需要在部署目录 `pnpm install`；
   - `packages/server/drizzle` 变了 → 需要迁移；
   - trace worker 或 shared 包变了 → 重启 worker；
   - daemon/cli/computer 变了 → 只提示。
2. **构建**（`build.sh`，零影响）。
3. **备份** `.env`、当前提交和当前 Web 版本到 `$RAFT_OPS_HOME/backups/<时间>/`。
4. **切换**：checkout 目标提交 → 按需安装依赖 → 按需迁移（此时旧服务端还在运行） → 写入 `RAFT_RELEASE_*` → 切换 Web 软链接 → 重启 `raft-server`（**API 中断从这里开始，实测 3–6 秒**）。
5. **验证**：内部端口和每个公开端口的 `/health` 都返回 200，`/api/version` 显示目标 SHA。
6. 以上任何一步失败，自动执行 `rollback.sh`。

日志在 `$RAFT_OPS_HOME/logs/deploy-<时间>.log`。

升级后的人工抽查：Web 能打开且字体正常；本机 Agent 在线、能收发消息；上传一个附件再下载；手机和桌面端各看一眼。

只改了 Web 的发布，也可以只做 `build.sh <ref>` + 切换软链接，不重启服务端；但为了 `RAFT_RELEASE_*` 和部署目录一致，推荐统一走 `deploy.sh`。

## 14. 回滚

```bash
ops/self-host/rollback.sh                   # 回到最近一次部署之前
ops/self-host/rollback.sh <backup-dir>      # 回到指定备份
```

它会：checkout 回备份时的提交（lockfile 不同则重新安装依赖）→ 恢复 `.env` → 把 Web 软链接指回旧版本 → 重启 `raft-server` → 最多等 180 秒（`RAFT_ROLLBACK_TIMEOUT`）确认健康。

- 不重启 daemon。
- **数据库迁移不会撤销**（第 6 节）。
- 回滚本身的中断时间和部署相同（几秒）。

## 15. 常见故障排查

| 现象 | 原因和处理 |
|---|---|
| 公开端口返回 **502** | 服务端没起来或正在重启。`pm2 logs raft-server`；nginx 错误日志 `$RAFT_OPS_HOME/nginx/logs/error.log` 里的 `connect() failed (111: Connection refused)` 就是这种情况。部署或重启的那几秒出现 502 属于正常 |
| **WebSocket 频繁断开**、Agent 反复重连 | 检查 `raft-proxy.conf` 的 `Upgrade`/`Connection` 头和 `proxy_read_timeout`；确认客户端连的是公开端口；在浏览器 Network 里 socket.io 请求应为 101 |
| **字体 404 / 字体显示不对** | Web 构建版本不含 PR #28 的修复（检查 `dist/assets` 有没有字体文件）；或 nginx 把 ttf 当成了 `application/octet-stream`（见第 9 节，不要用 server 级 `types{}`） |
| 构建失败：`dev-only package names leaked into production output` | 构建时 `NODE_ENV` 不是 `production`（第 8 节） |
| `/api/version` 返回 **503** `Build identity unavailable` | `.env` 缺 `RAFT_RELEASE_SHA`（完整 40 位）/`RAFT_BUILD_AT`（UTC，`Z` 结尾）/`RAFT_RELEASE_BRANCH`；执行一次 `deploy.sh` 即可补上 |
| **限流误判**：大家一起被 429，或登录频繁被拒 | 服务端没采信 nginx 的 `X-Forwarded-For`，所有人都被当成 127.0.0.1：设置 `TRUST_PROXY=1` 并重启服务端。服务端错误日志里的 `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` 就是这个问题的信号 |
| 迁移报 `MISSING_TIMEOUT` | 直接运行了 `db:migrate:deploy`；改用 `migrate.sh`（第 6 节） |
| 空库迁移却显示 `AT_TARGET_NOOP` | 连错了库：当前环境继承了别的 `DATABASE_URL`（第 5 节） |
| 大文件上传失败（413） | `client_max_body_size` 太小 |
| 某个响应没有 gzip | 小于 1KB，或是图片/二进制，属于正常；用访问日志的 `gz=` 核对 |
| 从外部能直接访问内部端口 | `.env` 没有 `HOST=127.0.0.1` |
| Agent 的环境里能看到 `DATABASE_URL` 等 | daemon 是从带着这些变量的 shell 启动的：用干净环境 `pm2 delete` + `pm2 start --only raft-daemon`，再 `pm2 save`（第 10 节）。考虑轮换泄漏的密钥 |
| 手机 App 连不上 `http://` 地址 | Android 默认禁止明文 http（第 16 节） |

## 16. 客户端怎么连接自托管服务器

三种客户端里，只有 Web 和服务器同源；手机 App 和桌面端的服务器地址都是**打包时写死**的，服务器地址（域名、端口、http/https）一旦变化，这两个都要重新打包。所以对外地址要尽量固定，本文把 nginx 放在原来的端口上，就是为了让已经发出去的 App 不用重新打包。

- **Web**：直接访问公开地址，和 API 同源，无需额外配置。
- **手机 App**（`apps/mobile`，Expo）：服务器地址在**构建时**通过 `EXPO_PUBLIC_RAFT_SERVER_URL` 写入，没有默认值，也没有在 App 内修改地址的界面。Android 默认禁止明文 http：`apps/mobile/plugins/withCleartext.js` 生成的网络安全配置只对少数主机放开明文（本机地址、模拟器地址和特定的 VPN 域名后缀）。自托管用 `http://` 时，要把你的主机加进这个插件的 `domain-config`，然后重新 `expo prebuild`（手改 `android/` 目录会被下次 prebuild 覆盖）；或者直接给服务端配上 HTTPS。
  - 打包示例：`EXPO_PUBLIC_RAFT_SERVER_URL=http://<公开地址> pnpm --filter ./apps/mobile ...`（具体命令见 `apps/mobile` 的说明）。**不要用裸 IP**：插件只能按主机名放开明文，裸 IP 会被系统拦截。
  - 安卓模拟器访问宿主机用 `10.0.2.2`，这个地址已经在白名单里；真机要用上面放开的主机名。
  - 用 `adb` 安装到真机前，先执行 `adb reverse --remove-all`，否则调试时设置的端口转发可能让 App 实际连到了开发机，而不是服务器。
  - Gradle 只在代码内容变化时才重新生成 JS bundle。只改了环境变量重新打包时，要让 bundle 真正重新生成（例如加 `--rerun-tasks`），否则新地址不会写进去；打包后可以解包检查 bundle 里的地址。
- **桌面端**（`apps/raft-desktop-electron`）：服务器地址在构建时通过 `VITE_API_URL` 写入（默认是官方地址）。非官方地址需要构建配置同时放开 CSP 和 CORS 白名单，这部分在 `dev` 分支的 `buildConfig.mjs` 里处理；Web 发布里的 `/desktop-manifest.json` 是桌面端的兼容性清单。
  - 打包示例：`VITE_API_URL=http://<公开地址> pnpm --filter @botiverse/raft-desktop-electron dist:mac`。不设置 `VITE_API_URL` 就会连官方生产服务器，一定要设置。
  - 这个值只接受 `http(s)://主机[:端口]`，非法值会让打包直接失败；用非官方地址打的包会自动关闭自动更新，避免被官方版本覆盖。
  - 包里的 App 名称和本地数据目录保持不变，重新安装不会丢失登录状态。

## 17. 备份

需要备份的只有三样，代码和 Web 构建都能从 git 重新生成：

1. **PostgreSQL**：`pg_dump -Fc "$DATABASE_URL" > raft-$(date +%F).dump`（在干净环境里执行，确认连的是正确的库）。
2. **附件**：本地存储时是 `UPLOADS_DIR`（默认 `packages/server/uploads`）；用 S3/R2 时由对象存储负责。
3. **不入库的配置和密钥**：`packages/server/.env`、`ops/self-host/env.local`、daemon 密钥文件、trace worker 的 `.env`。这些要存放在安全的位置，不要放进 git 或聊天记录。
