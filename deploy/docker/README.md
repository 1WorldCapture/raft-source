# Raft 自托管 Docker 部署（一期：服务端 + Web + PostgreSQL）

内网离线部署：两个镜像 + 一份 compose + 一份 `.env`，全程不需要公网。

## 组成

| 服务 | 说明 |
|---|---|
| `db` | postgres:16-alpine，数据卷 `raft-pgdata`，仅内网 |
| `server` | 官方 server 镜像；启动前由 entrypoint 跑守卫式迁移（幂等） |
| `web` | selfhost 变体 web 镜像：**不烘焙 API 地址**（同源回退 `window.location.origin`），nginx 将 `/api`、`/socket.io` 反代到 server |

网络拓扑：`raft-internal`（`internal: true`）只挂 `server`+`db`，不发布任何端口；
`web` 同时挂 `raft-internal`（反代用）与 `raft-edge`（发布 `RAFT_HTTP_PORT`，默认 **18443**）。
唯一入口是 web，同源部署因此**任意主机名/端口即装即用**。

## 构建 / 导出（在有网的环境执行）

在仓库根（`<sha>` = 构建的 git commit）：

```sh
docker build -f packages/server/Dockerfile \
  --build-arg RAFT_RELEASE_SHA=<sha> --build-arg RAFT_BUILD_AT=<iso8601> \
  --build-arg RAFT_RELEASE_BRANCH=dev -t raft-source-server:dev-<sha> .
docker build -f packages/web/Dockerfile \
  --build-arg SELFHOST=1 --build-arg VITE_COMMIT_SHA=<sha> \
  -t raft-source-web-selfhost:dev-<sha> .
docker save raft-source-server:dev-<sha> raft-source-web-selfhost:dev-<sha> \
  -o raft-images-dev-<sha>.tar
sha256sum raft-images-dev-<sha>.tar   # 记录随交付物移交
```

> `SELFHOST=1` 只做一件事：把 `nginx-selfhost.conf.template` 装进镜像并跳过
> `VITE_API_URL` 烘焙（该 ARG 本无默认值，不传即同源）。官方镜像构建路径不变。

## 部署（离线环境执行）

```sh
docker load -i raft-images-dev-<sha>.tar
cd deploy/docker
cp .env.example .env    # 填 POSTGRES_PASSWORD、JWT_SECRET（生成命令见文件内注释）
docker compose up -d
```

健康核对：

```sh
docker compose ps
curl -fsS http://127.0.0.1:${RAFT_HTTP_PORT:-18443}/api/version   # 回显 sha=<sha>
docker compose logs server | grep -i migrate                       # 迁移执行记录
```

验收清单（对应 task #2 断网验证）：注册 / 登录 / 建频道 / 发消息全走
`https://<host>:18443` 一个源；`docker compose logs` 无外联报错影响功能。

## 离线首跑（无 SMTP 的账号激活）

无邮件配置时，邮件以 `[DEV EMAIL]` 块打印到 **server 容器日志**（不外发）。
注册后取验证链接：

```sh
docker compose logs server | grep -o 'http[^ "<]*verify=[a-f0-9]*' | tail -1
```

在浏览器打开（或在 UI 的验证页粘贴 token）即完成验证，随后走正常的资料补全。
**建议 `.env` 里设置 `RAFT_PUBLIC_ORIGIN=http://<你的主机>:18443`**——验证链接
会用它生成，否则回退开发默认 `localhost:5173`（token 仍有效，仅链接主机不对）。

## TLS（nginx 容器内终结）

web 容器监听 443，证书从 `./certs/` 只读挂载（`fullchain.pem` + `privkey.pem`），
compose 把 `${RAFT_HTTP_PORT:-18443}` 映射到 443。`RAFT_PUBLIC_ORIGIN` 必须是
`https://<证书主机名>:18443` 形式（SERVER_URL/APP_URL/CORS_ORIGIN 全部由它派生）。

**证书三种来源**：
1. 企业 CA 签发（内网已有 PKI 时）；
2. **`tailscale cert <机器名>.ts.net`（推荐）**：owner 已确认 Tailscale 属于可用形态，
   Let's Encrypt 签发、浏览器与 Node 均信任、90 天有效；
3. 自签证书（兜底）：浏览器需手动信任，**Computer/CLI 侧要额外配置**
   `NODE_EXTRA_CA_CERTS=/path/to/your-ca.pem` 后再执行添加命令，否则守护进程
   TLS 校验失败。

**换域名/主机名**：改 `.env` 的 `RAFT_PUBLIC_ORIGIN` → 替换 `./certs/` 证书 →
`docker compose up -d`。**已注册的 Computer 需要重新执行「添加 computer」命令**
（它记录的是旧服务器地址）。

**续期**：`tailscale cert` 到期前重跑同名命令覆盖 `./certs/` 后
`docker compose restart web`；企业 CA 按内部流程。compose 不做自动续期。

## 客户端产物目录（二期 task #4）

`./downloads/`（compose 同时挂给 server 与 web；nginx 经 alias 直出 `/downloads/`，
二进制不经过 Node）。用仓库根的脚本从**与 server 镜像同一 commit** 构建的产物生成：

```sh
node scripts/build-release-artifacts.mjs --out deploy/docker/downloads
# 或手工喂已构建的产物（两个产品版本独立，分别指定）：
node scripts/build-downloads.mjs --computer-version <v> --cli-version <v> \
  --commit <sha> --out deploy/docker/downloads \
  --computer-darwin-arm64 <sea 文件> --computer-darwin-x64 <sea 文件> \
  --computer-linux-x64 <sea 文件> --cli <raft-<cli-v>.tgz>
```

manifest 格式与 Computer 的 legacy-cdn 读取器逐字段兼容（platform key =
`<node-platform>-<arch>`），并带 `commit` 字段记录产物来源 sha——验收时可直接
与 server 镜像的构建 SHA 比对（同 commit 契约）。安装脚本 `install.sh` /
`install.ps1` 也由管线拷入 `computer/` 根部，安装命令
`curl .../downloads/computer/install.sh | sh` 直接可用。

**安全边界（必读）**：manifest 里的 sha256 证明**完整性**（字节与 manifest 一致），
不证明**来源**——没有 Hands 那样的独立签发方。因此私有部署的 origin 必须走
HTTPS（或 Tailscale tailnet）。若用 `http://` origin，安装与升级都会给出明确
警告（install.sh 内置检测）；同一链路上的中间人可以同时替换 manifest 和二进制。

**Computer 升级源指向本服务器（task #5）**：私有安装命令会带
`RAFT_COMPUTER_INSTALL_BACKEND=server`，安装后持久化到
`~/.slock/computer/release-backend`（channel 文件同款机制，对 launchd/systemd
服务上下文同样生效）。此后 `raft-computer upgrade` 与服务端触发的升级检查都从
`${服务器 origin}/downloads/computer/manifest.json` 解析最新版本；多服务器混接
（不同 origin）会明确报错而非挑边，可用 `RAFT_COMPUTER_UPGRADE_BASE_URL` 显式指定。
`RAFT_DEPLOYMENT_MODE=private` 环境变量 + 已连接服务器同样触发（等价开关）。

**CLI / daemon 从本服务器安装（task #6）**：`GET /api/deployment-info` 在私有模式下
附带服务器渲染的下载 URL（origin 只取配置的 `SERVER_URL`，**绝不取请求 Host**——
防 Host 头注入）。web 界面与 agent 指引（manual `raft-cli-overview` 等）中的安装命令
按此生成为 `npm i -g ${origin}/downloads/cli/raft-<v>.tgz`（CLI）与两段式
`npm i -g <daemon-url> && raft-daemon --server-url … --api-key …`（daemon）。
**注意**：机器上已全局安装的官方 `@botiverse/raft-daemon` 会被上述安装**覆盖**为
本服务器版本——这是预期行为（私有部署的机器必须用同源产物）。manual 占位符在
服务器缺产物/缺 SERVER_URL 时回退官方命令并记警告日志；官方部署渲染逐字节不变
（快照测试锁定）。

**遥测与官方链接（task #7）**：
- **遥测默认关（隐私红线）**：daemon/Computer 的 trace 上报四层策略——
  `SLOCK_DAEMON_TRACE_UPLOAD_DISABLED=1`（最高）> `SLOCK_DAEMON_TRACE_UPLOAD_URL`
  显式设置（**唯一的显式打开方式**，指向自选 worker）> 私有上下文（`RAFT_DEPLOYMENT_MODE=private`
  env 或安装器持久化的 `computer/release-backend=server`）默认关 > 官方部署默认开（行为不变）。
- **链接中性化**：CLI 帮助/doctor/setup 输出中的 dashboard 深链接改拼 **slug 所属附件的
  origin**（`${origin}/s/<slug>/...`），社区链接隐藏；web 的 docs 入口私有下隐藏（可用
  `RAFT_PUBLIC_DOCS_URL` 配置）；邮件中的官方链接隐藏（社区/移动端 CTA/文档），
  许可与隐私链接保留但可用 `RAFT_PUBLIC_TERMS_URL`/`RAFT_PUBLIC_PRIVACY_URL` 替换；
  agent 外部指引的 `claude plugin marketplace` 步骤私有下省略并附内网说明。

**Desktop 安装包（三期 task #12）**：`./downloads/desktop/` 由
`scripts/build-release-artifacts.mjs` 在 **macOS 构建机**上生成（非 macOS
跳过并提示，可稍后在同 commit 的 Mac 上补跑该步骤；**macOS 上必须传
`--desktop-origin <https-origin>`**——烘焙进 app 作为 VITE_API_URL，
**必须等于本部署的 SERVER_URL**：漏传或误传会打出连官方服务器、开官方
更新器的包，直接报错拒绝构建）：
```
desktop/<v>/Raft-Desktop-<v>-{arm64,x64}.dmg|.zip   （electron-builder，不签名）
desktop/latest-mac.yml   ← 双架构合成 feed（每个 entries 带 <v>/ 前缀 url + sha512）
desktop/manifest.json    ← {version, commit, origin, embedded:{computer,cli,daemon}}
```
双架构 latest-mac.yml 是合成的（electron-builder 每架构各写一份会互相覆盖）；
manifest 的 origin 即烘焙 origin，验收时与 SERVER_URL 比对。
**两种部署形态的分发路径**：
1. **compose 栈（本任务范围，直接可用）**：nginx 经 alias 直出整棵
   `/downloads/`，desktop/ 天然可访问，无需任何服务端改动。
2. **源码栈（pm2 + 应用路由）**：`downloadsRouter` 的产品白名单目前只有
   computer/cli（daemon 当时也 404 过，靠 nginx 临时补段解决）。desktop
   的源码形态统一处理已记单独待办，本任务不扩大范围。
应用内更新：desktop 连私有服务器时由 `main/privateUpdateChecker.ts` 读
`/downloads/desktop/latest-mac.yml` 检测并提示手动安装（未签名包的
Gatekeeper 步骤见 desktop README）；`GET /api/deployment-info` 私有模式下
附带 `downloads.desktop`（版本 + 双架构 dmg URL，**只取 SERVER_URL**），
网页设置页据此显示下载入口（官方部署字段缺席=零差异）。

**Managed MCP 内网放行名单（task #9）**：
内网 MCP 服务器默认被 SSRF 防护封锁（与官方云一致）。私有模式下管理员可显式放行：
`RAFT_MANAGED_MCP_ALLOWED_NETWORKS=10.20.0.0/16,100.64.0.0/10`（CIDR，IPv4/IPv6）作用于
**DNS 解析后的实际 IP**，且只有通过判定的地址会用于建连（混合解析绝不让连接落到被封地址）；
`RAFT_MANAGED_MCP_ALLOWED_HOSTS=mcp.corp.example` 仅越过 `.internal`/`.local` 等后缀预检，
IP 仍须落名单或公网。**注意：修改 .env 后要用 `docker compose up -d`（重建容器）才会重新
读取环境变量——`docker compose restart` 不会**。**安全底线**：环回（127/8、::1）、链路本地（169.254/16、fe80::/10，
含云元数据端点）、未指定（0.0.0.0/8、::）与组播段**永不可放行**——配置了也会被忽略并记警告。
建议配最小范围。官方云部署完全忽略这两个 env（行为逐字节不变）。换版本=重跑脚本+`docker compose restart server web`。
server 侧 `RAFT_DEPLOYMENT_MODE=private`（compose 已设）使「最新版本」查询读本地
manifest 而非官网——官方部署不受影响（唯一判断入口
`isPrivateDeploymentMode`，shared）。

## 已知边界（二期处理）

- web 的 Computer 安装命令（task #5）与 CLI/daemon 安装命令（task #6）在私有模式下均已指向本服务器 `/downloads/`；agent 详情页的 `claude plugin marketplace add botiverse/…`（GitHub 公网）仍在——task #7 链接中性化处理。
- 私有模式下「最新版本」已读本地 manifest（本条）；官方部署的外部查询行为不变。
