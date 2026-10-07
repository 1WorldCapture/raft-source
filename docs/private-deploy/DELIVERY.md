# Raft 私有化发行包 交付文档（草稿，commit 68b6d61）

> 状态：草稿。镜像与 Desktop 的 sha256 待 IT / May 回填；标注「待确认」的内容没有在本次构建中实测，交付前需由 IT 复验确认。
> 技术细节的权威来源是仓库 `deploy/docker/README.md`（同 commit）。构建流程见内部文档 BUILD-INTERNAL.md，不随客户交付。

## 1. 发行包内容

构建 commit：`68b6d61ff019dddbcf81f4785d9806df3f49603f`（所有 manifest 的 `commit` 字段一致，可核对）。

| 组件 | 版本 | 形态 |
|---|---|---|
| server 镜像 | 同 commit | docker save tar（private 模式） |
| web 镜像（selfhost） | 同 commit | docker save tar |
| Computer | 1.0.29 | linux-x64、darwin-arm64、darwin-x64 单文件；darwin 为 ad-hoc 签名 |
| CLI | 0.0.24-zcode.1 | tgz |
| daemon | 1.0.26 | tgz |
| downloads 树 | — | `computer/ cli/ daemon/ desktop/` + 各 manifest + `install.sh/ps1` |
| Desktop | **0.1.0** | arm64/x64 的 dmg、zip、`latest-mac.yml`、manifest（未签名） |

完整的文件路径、大小、sha256 见《产物清单》（SHA256SUMS）。

## 2. 版本规则

- 私有版有**自己独立的版本线**，从 **0.1.0** 开始（Desktop version）；不在上游版本号上往上调。
- Computer（1.0.29）、CLI（0.0.24-zcode.1）、daemon（1.0.26）保持原版本——它们参与 server 与 daemon 之间的兼容检查，不随私有版本线变化。
- **发行说明必须列出所含组件的版本**（上表）。
- **同一个版本号只发布一次**；内容有变就发新版本号。
- 客户端的更新提示**只比较私有版之间的版本**。
- 上架新版本时 `downloads/desktop/` 整体按新发行包重建（不在旧树上增量覆盖），确保 `latest-mac.yml` 只指向当前版本，避免旧的更高版本号造成「降级提示」（例如旧 feed 若指向 0.1.10，新装 0.1.0 会被提示“降级”）。

## 3. 安装（离线）

1. 载入镜像：`docker load -i <images tar>`（先 `sha256sum` 核对）。
2. `cd deploy/docker && cp .env.example .env`，填 `POSTGRES_PASSWORD`、`JWT_SECRET`，设置 `RAFT_PUBLIC_ORIGIN=https://<主机名>[:<端口>]`（对外端口由 `.env` 的 `RAFT_HTTP_PORT` 决定，compose 把它映射到 web 容器的 443；默认 18443，生产常用 443 或自定义端口）。
3. 把发行包 `downloads/` 放到 compose 挂载的 `./downloads/`。
4. `docker compose up -d`；健康检查 `curl -fsS https://<主机名>[:<端口>]/api/version`，回显 sha 应为 `68b6d61…`。
5. 无 SMTP 时账号激活链接打印在 server 容器日志（见 README「离线首跑」）。

私有模式（`RAFT_DEPLOYMENT_MODE=private`，compose 已设）下：版本查询读本地 manifest；遥测默认关；官方链接隐藏或可配置替换。

## 4. 证书与域名

- web 容器内终结 TLS，证书从 `./certs/` 只读挂载（`fullchain.pem` + `privkey.pem`）。
- 证书来源三种：企业 CA；`tailscale cert`（推荐）；自签（兜底，Computer/CLI 侧需设置 `NODE_EXTRA_CA_CERTS`）。
- `RAFT_PUBLIC_ORIGIN` 必须是 `https://<证书主机名>[:<端口>]`，SERVER_URL/APP_URL/CORS_ORIGIN 由它派生。
- **换域名**：改 `RAFT_PUBLIC_ORIGIN` → 换证书 → `docker compose up -d`；已注册的 Computer 需重新执行「添加 computer」命令；**已烘焙旧地址的 Desktop 需要按新地址重打**（见 §6：Desktop 由我们按客户地址重新构建后交付）。
- **续期**：重跑 `tailscale cert` 覆盖 `./certs/` 后 `docker compose restart web`；compose 不自动续期。
- 不要使用 `http://` origin：安装/升级会警告，同一链路的中间人可同时替换 manifest 和二进制。

## 5. 升级与回滚（待确认）

升级：用新发行包（新 commit）换镜像和 `downloads/`，`docker compose up -d`；server 启动前由 entrypoint 跑守卫式、幂等的迁移（README 描述）。换版本的 downloads 部分见 README：重跑脚本 + `docker compose restart server web`。

回滚：**迁移是否可逆、回滚是否需要先恢复数据库备份，本次没有实测，属待确认项**，需 IT 在复验中给出并写入此节。保守做法：升级前备份 `raft-pgdata` 数据卷，保留上一版镜像 tar 和 `downloads/` 树。

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
- 升级与回滚流程的数据库侧细节待 IT 复验确认（§5）。
