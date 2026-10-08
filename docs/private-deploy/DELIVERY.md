# Raft 私有化发行包 交付文档（私有版 0.1.3，commit d574ce4）

> 状态：私有版 **0.1.3**，commit **d574ce4667456cd9d02bdf0cc05b4ba5da48865b**（deploy 分支，tag `v0.1.3`）。升级、回滚、断网全新安装、含迁移的发版（0273/0274）均已实测；2026-10-07 另完成一次生产环境从 pm2 源码栈到 Docker 的正式切换（停机 109 秒、数据零丢失），相关经验已并入 §5/§8。产物清单：0.1.0 基线见 `INVENTORY-68b6d61.txt`；**0.1.3 的通用发行包是否重新组装由发行方另行决定**，未重组装时桌面件按 §6 单独交付。
> 技术细节的权威来源是发行包内的 `deploy/README.md`。构建流程见内部文档 BUILD-INTERNAL.md，不随客户交付。

## 1. 发行包内容

构建 commit：**`d574ce4667456cd9d02bdf0cc05b4ba5da48865b`**（deploy 分支；所有 manifest 的 `commit` 字段一致，可核对）。**版本标签**：每个发行版在 deploy 分支对应 commit 上打 annotated tag——`v0.1.0`=`e4a40e8`、`v0.1.1`=`b5f7fdd`、`v0.1.2`=`0391e80`、`v0.1.3`=`d574ce4`，可用 `git tag -l v0.1.*` 与 `git rev-parse v0.1.x^{}` 追溯。

| 组件 | 版本 | 形态 |
|---|---|---|
| server 镜像 | 同 commit | docker save tar（private 模式） |
| web 镜像（selfhost） | 同 commit | docker save tar（与 server 镜像同一个 tar） |
| 部署文件 | commit 3c71fee | `deploy/docker-compose.yml`、`deploy/.env.example`、`deploy/README.md`（含上传文件持久卷和 `SCOPE_ATTESTATION_SECRET` 透传；**请使用包内这份，不要使用 68b6d61 源码树里的旧 compose**） |
| 基础镜像 | postgres:17-alpine、redis:7-alpine | docker save tar（`images/raft-base-images.tar`，按 digest 固定） |
| Computer | 1.0.29 | linux-x64、darwin-arm64、darwin-x64 单文件；darwin 为 ad-hoc 签名 |
| CLI | 0.0.24-zcode.1 | tgz |
| daemon | 1.0.26 | tgz |
| downloads 树 | — | `computer/ cli/ daemon/` + 各 manifest（`desktop/` 按客户单独提供） + `install.sh/ps1` |
| Desktop | **0.1.3** | **不在通用发行包中，按客户单独提供**（arm64/x64 的 dmg、zip、`latest-mac.yml`、manifest，未签名；见 §6） |

完整的文件路径、大小、sha256 见《产物清单》（SHA256SUMS）。

## 2. 版本规则

- 私有版有**自己独立的版本线**，从 **0.1.0** 开始（Desktop version）；不在上游版本号上往上调。
- Computer（1.0.29）、CLI（0.0.24-zcode.1）、daemon（1.0.26）保持原版本——它们参与 server 与 daemon 之间的兼容检查，不随私有版本线变化。
- **发行说明必须列出所含组件的版本**（上表）。
- **同一个版本号只发布一次**；内容有变就发新版本号。
- 客户端的更新提示**只比较私有版之间的版本**。
- 上架新版本时 `downloads/desktop/` 整体按新发行包重建（不在旧树上增量覆盖），确保 `latest-mac.yml` 只指向当前版本，避免旧的更高版本号造成「降级提示」（例如旧 feed 若指向 0.1.10，新装 0.1.0 会被提示“降级”）。

## 3. 安装（离线）

1. 载入镜像：`docker load -i <images tar>`（先 `sha256sum` 核对）。记下 `docker load` 输出的两个镜像 tag（本版为 `raft-source-server:dev-68b6d61ff019dddbcf81f4785d9806df3f49603f` 和 `raft-source-web-selfhost:dev-68b6d61ff019dddbcf81f4785d9806df3f49603f`，以 `docker load` 实际输出为准）。
   同样载入基础镜像：`docker load -i images/raft-base-images.tar`（含 compose 使用的 `postgres:17-alpine` 和 `redis:7-alpine`，发行包自带，离线环境无需联网拉取）。
2. 进入发行包内的 `deploy/` 目录（部署文件，取自 3c71fee，镜像本身构建自 68b6d61），`cp .env.example .env`，填 `POSTGRES_PASSWORD`、`JWT_SECRET`，**把 `RAFT_SERVER_IMAGE`、`RAFT_WEB_IMAGE` 设为第 1 步 load 输出的 tag**（compose 默认找 `:local` tag，不设置时会去 Docker Hub 拉取，离线环境下失败），设置 `RAFT_PUBLIC_ORIGIN=https://<主机名>[:<端口>]`（对外端口由 `.env` 的 `RAFT_HTTP_PORT` 决定，compose 把它映射到 web 容器的 443；默认 18443，生产常用 443 或自定义端口）。
3. 把发行包 `downloads/` 放到 compose 旁边的 `./downloads/`。
4. `docker compose up -d`；健康检查 `curl -fsS https://<主机名>[:<端口>]/api/version`，回显 sha 应为 `68b6d61…`。
5. 上传文件（附件、头像）保存在命名卷 `raft-uploads`（挂载到容器 `/app/uploads`，由 `UPLOADS_DIR` 指定），容器重建不会丢失；备份时要和数据库一起备份它。
6. 无 SMTP 时账号激活链接打印在 server 容器日志（见 README「离线首跑」）。

`.env` 里的 `SCOPE_ATTESTATION_SECRET` 是可选项：仅当你运行外部 worker（反馈报告/trace 上传）时才需要，未设置时这些接口会报「Scope attestation is not configured」，不影响登录、会话和已注册的 Computer。更换该值只会让已签发的 attestation token（有效期数分钟）失效。

私有模式（`RAFT_DEPLOYMENT_MODE=private`，compose 已设）下：版本查询读本地 manifest；遥测默认关；官方链接隐藏或可配置替换。

## 4. 证书与域名

- web 容器内终结 TLS，证书从 `./certs/` 只读挂载（`fullchain.pem` + `privkey.pem`）。
- 证书来源三种：企业 CA；`tailscale cert`（推荐）；自签（兜底，Computer/CLI 侧需设置 `NODE_EXTRA_CA_CERTS`）。
- `RAFT_PUBLIC_ORIGIN` 必须是 `https://<证书主机名>[:<端口>]`，SERVER_URL/APP_URL/CORS_ORIGIN 由它派生。
- **换域名**：改 `RAFT_PUBLIC_ORIGIN` → 换证书 → `docker compose up -d`；已注册的 Computer 需重新执行「添加 computer」命令；**已烘焙旧地址的 Desktop 需要按新地址重打**（见 §6：Desktop 由我们按客户地址重新构建后交付）。
- **续期**：重跑 `tailscale cert` 覆盖 `./certs/` 后 `docker compose restart web`；compose 不自动续期。
- 不要使用 `http://` origin：安装/升级会警告，同一链路的中间人可同时替换 manifest 和二进制。

## 5. 升级与回滚

**升级**（已实测 dd8c608 → 68b6d61）：
1. 升级前备份：`pg_dumpall` 逻辑备份 + 停栈后的 `raft-pgdata` 卷快照；**同时备份 `raft-uploads` 卷（用户上传的附件、头像）**；记下当前镜像 tag。
2. `.env` 里切换 `RAFT_SERVER_IMAGE` / `RAFT_WEB_IMAGE` 到新 tag（先 `docker load` 新镜像）；`downloads/` 树按新发行包**整体重建**（不要在旧树上增量覆盖）；`docker compose up -d`（改了 `.env` 必须 `up -d`，`restart` 不会重读环境变量）。
3. 验证：`/api/version` 回显新 commit；server 日志出现 `[MIGRATION_PREFLIGHT_OK]` 与 `[MIGRATION_DEPLOY_OK]`（server 启动前由 entrypoint 跑守卫式、幂等的迁移）；已有账号和数据完好；`downloads/` 各 manifest 与 `latest-mac.yml` 可访问，旧版本文件返回 404。

**回滚**（已实测，dd8c608 ↔ 68b6d61 双向）：把 `.env` 的镜像 tag 改回旧版本，`docker compose up -d`，`/api/version` 回显旧 commit，数据完好，旧代码的迁移检查同样通过。

- 本版本对之间**没有数据库迁移**，所以回滚只需换镜像重启，**不需要恢复数据库备份**。
- **若某次升级包含数据库迁移**，回滚前必须先恢复升级前的备份（`pg_dump -Fc` 逻辑备份），再换回旧镜像。恢复的具体路径（`docker compose exec -T db pg_restore --no-owner -U raft -d raft < dump.custom`）已在生产切换中多次实测可靠；「迁移后回滚」的完整顺序（停栈→恢复备份→换旧镜像→起栈）按 §8 的切换脚本模式编排，首次执行前仍建议先在测试环境走一遍。
- 升级前仍建议双备份（数据库 + `raft-uploads` 卷），并保留上一版镜像 tar 和 `downloads/` 树。
- **发版完成后打版本标签**：`git tag -a v0.1.x -m "release v0.1.x" <部署的 commit> && git push origin v0.1.x`（deploy 分支；历史版本已补打，见 §1 映射表）。

## 6. Desktop 与客户地址

Desktop 安装包在构建时写入服务器地址，因此**每个客户的 Desktop 由我们在 macOS 上按该客户的服务器地址单独构建**后交付（其余产物各客户共用）。更换域名/地址后，需要我们重新构建并交付 Desktop。

## 7. 已知限制

- Desktop **只支持 macOS**（没有 Windows 版 Desktop）。
- 每个客户都需要在一台 Mac 上重打 Desktop（见 §6）。
- Computer 的数据目录路径过长（大约超过 70 个字符）时会静默启动失败；默认路径不受影响，自定义很深的目录时请注意（已知问题 D1，暂缓修复）。
- Desktop 未签名、未公证：macOS Gatekeeper 首次打开需要手动放行；应用内更新是**检测+手动下载**，不自动安装。
- darwin Computer 为 ad-hoc 签名，非 Apple Developer ID 签名、未公证。
- 官方 `@botiverse/raft-daemon` 若已全局安装，会被本服务器版本覆盖（预期行为）。
- 发行包按 docker compose 部署；Desktop 的 pm2 源码栈分发路径不在本次范围。
- Managed MCP 内网放行名单修改 `.env` 后需 `docker compose up -d` 重建容器，`restart` 不会重读环境变量。

## 8. 从源码部署（pm2 + 反向代理）迁移到 Docker

适用于已有的源码部署（pm2 起 server、Caddy/nginx 做入口、独立 PostgreSQL）想改用本发行包的 Docker Compose 形态并**保留数据**。本流程在测试环境完整实测过一次：停机 **2 分 15 秒**，12 个用户、11 个 server 的数据、存量密码登录、Computer 重新上线、3 个附件均验证无误。原环境保持不动，随时可回滚。

**前提与准备**
- 准备好发行包（镜像 tar、基础镜像 tar、`downloads/`），按 §3 在**新目录**里放好 compose、`.env`、证书、`downloads/`。`RAFT_PUBLIC_ORIGIN` 设为现有环境的对外地址。
- **把旧环境的 `JWT_SECRET` 拷到新 `.env`**，已登录的会话才不会失效；`SCOPE_ATTESTATION_SECRET` 若旧环境设置过也一并拷贝（可选，见 §3）。`POSTGRES_PASSWORD` 用新生成的值。
- `downloads/` 里要包含 `desktop/` 子树（容易漏拷）。
- 旧环境其他配置（OAuth、SMTP 等）按变量名逐项对照后再带到新 `.env`；Redis 里只有可重建的临时状态（序号、心跳、运行时标记），**不需要迁移**。
- 旧环境的上传目录（`UPLOADS_DIR`）要迁移，见下面第 6 步。

**步骤**
1. **冒烟（不停机）**：先用临时端口（`RAFT_HTTP_PORT` 改成空闲端口）起一个空栈，检查镜像、证书、`.env`、`downloads/`、迁移链和 `/api/version`；通过后 `docker compose down -v` 清掉冒烟栈的卷。
2. **通知**：提前几分钟告知用户即将停机。
3. **停旧栈**：停 pm2 的 server 进程和旧入口（Caddy/nginx；若入口是 `tailscale serve` 等端口转发，一并撤掉，让出端口）。**从此刻起停机**。
4. **导出旧库**：`pg_dump -Fc <旧库名> > dump.custom`（执行前确认库名；只读，不改旧库）。记录文件大小和 sha256。
5. **起新栈的数据库并导入**：`.env` 的 `RAFT_HTTP_PORT` 改成正式端口，先只启动 db：`docker compose up -d db`；然后用 `docker compose exec -T db pg_restore --no-owner -U raft -d raft < dump.custom` 导入。**务必通过容器内导入**：宿主机上的 `127.0.0.1:5432` 可能是旧库，直连会连错库（密码错误，或更糟——误写旧库）。
6. **迁移上传文件**：把旧上传目录的文件拷进 `raft-uploads` 卷（例如 `docker cp <旧目录>/. <server 容器>:/app/uploads/`，或在 server 启动前用临时容器挂载该卷拷入），并核对文件数量。
7. **启动全栈**：`docker compose up -d`。server 启动时自动跑迁移；日志应出现 `[MIGRATION_PREFLIGHT_OK]`（旧库版本与目标一致时为 NOOP，否则会顺序执行迁移）。
8. **验证**：`/api/version` 回显目标 commit、`deploymentMode=private`；用一个旧账号密码登录；旧的 server/agent/Computer 数据都在；打开一条带老附件的消息；在隔离的 home 里用网页给出的「添加 Computer」命令装一个 Computer，确认上线后清理；`/downloads/`（含 `desktop/latest-mac.yml`）可访问；同机其他服务不受影响。

**回滚**（新栈有问题时）：`docker compose down`（保留卷），重新启动 pm2 server 和原入口、恢复端口转发。旧库在整个过程中**只导出、没有写入**，所以旧环境原样可用，约 2 分钟内恢复。

**常见陷阱**
- `downloads/` 漏拷 `desktop/` 子树（Desktop 下载和更新检测会 404）。
- 宿主机与容器的 PostgreSQL 端口冲突（见第 5 步）。
- 写迁移脚本时 `set -e` 与 `diff`（有差异时返回非零）组合会让脚本提前结束；比对结果请显式判断。
- 切换后以新 compose 为准做后续升级（§5），不要再回到旧的拉源码 + pm2 方式。

### 8.1 切换脚本与演练方法（生产实战提炼）

正式切换建议用**分阶段幂等脚本 + 自动回滚**，要点（全部实战验证）：

- **脚本形态**：nohup 独立运行（不依赖操作者会话）、分阶段标记文件支持断点续跑、任一阶段失败自动回滚（`docker compose down` **保留卷** + 重启旧栈）、全程写日志。给脚本加「完成闩」：全部通过后写标记，之后任何重跑被拒绝（防止误触清理卷的动作碰到已承载生产数据的卷）。
- **阶段与验收门**：预检（镜像/密钥/证书/desktop feed 在场，live 版本==目标版本，**切换不顺带升级**）→ 备份（pg 逻辑备份+上传目录快照+旧 .env 副本）→ 停旧栈（停机计时）→ 起 db → 导库+传附件 → 起 server/web → 验收门（版本三参数、错误凭据登录应答 401、socket.io 握手、downloads manifest、**附件三层校验**：库内行数一致+卷内样本字节大小一致+附件路由非 404）。
- **回滚域**：失败发生在停旧栈之前时不重启旧栈（它从未被碰）；回滚后清除停机及之后的阶段标记，重跑才会重新停旧栈。
- **演练**：临时 compose 项目+临时端口，用生产数据**副本**+演练专用随机密钥跑完整流程，量出真实停机时间；compose 的网络拓扑（server/db 仅挂 `internal: true` 网络）天然阻断出站，演练中从 server 容器内 `fetch` 任意外网域名应失败（DNS 都不解析），以此证明生产凭据不会从演练环境外泄。
- **回滚窗口**：新栈开始接受写入后新旧数据开始分叉；切换刚完成的短窗口内可一键回滚，之后回滚需恢复备份（有损，需决策）。

### 8.2 迁移实战补充清单

- **证书文件名必须是通用名**：web 容器 nginx 读 `/etc/nginx/certs/fullchain.pem` 与 `privkey.pem`，用域名命名的证书文件会导致 web 容器崩溃循环。
- **卷名规则**：compose 顶层声明的卷实际名=「compose 项目名_声明名」（如 `raft-uploads` 在项目 `x` 下是 `x_raft-uploads`）；预创建卷再 `up` 会被采纳（有一条无害 warning）。
- **Redis 可选迁移**：默认按易失处理（重连自愈）即可；如需保留在场状态，`redis-cli SAVE` 后把 `dump.rdb` 放进 redis 容器 `/data/` 再首启（compose 未给 redis 声明卷，用 `compose create` + `docker cp` + `start`）。注意 RDB 里的短 TTL 键（如心跳）在快照与加载间隔过长时会自然过期，属预期。
- **磁盘与日志**：切换/构建前确认磁盘余量（建议 ≥6G；构建期 pnpm+双镜像层峰值明显）；给宿主 journald 设上限（如 `SystemMaxUse=200M`），否则日志可无声涨到数十 G。加每小时磁盘水位检查（超 85% 记日志）。
- **日常备份**：切换后第一天起建容器内 `pg_dump` 定时备份（umask 077、滚动保留）；**核读必须用容器内的 pg_restore**——宿主机低版本 pg_restore 读不了容器高版本产生的备份头。
- **`downloads/desktop/` 必须在切换前到位**：若原环境桌面端走官方更新源，切到私有模式后没有本地 desktop feed 会导致「检查更新」无源可用；先布放当前版本的 dmg/zip/latest-mac.yml/manifest 再切换。
- **后台启动三件套**：先建好日志目录再重定向、脚本自写 pidfile、启动后 `kill -0` 验活；进度只看日志，不要用 `pgrep -f` 判断（会自匹配给出假阳性）。
- **shell 陷阱**：`set -o pipefail` 下 `xxx --list | grep -q` 会因 SIGPIPE 假失败（长输出流校验用文件中转）；空 crontab 时 `crontab -l | grep -v X` 的退出码会吞掉后续行（加 `|| true` 护栏）。
