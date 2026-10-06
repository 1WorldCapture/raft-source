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

## 已知边界（二期处理）

- web 生成的 Computer 安装命令仍指向官方 CDN（`cdn.raft.build`）——二期
  「服务器分发客户端」改为 `/downloads/`；一期仅修复 `--server-url` 缺失 bug。
- server 每小时的外部“最新版本”查询（npmjs/CDN/hands）在离线环境失败并被
  吞掉，影响仅是“有新版”提示失真；二期改为读本地 manifest。
