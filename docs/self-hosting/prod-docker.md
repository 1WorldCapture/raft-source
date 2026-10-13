# 生产 Docker 私有栈运行手册

> 适用：我们自己的生产（https://raft.tailf3efbe.ts.net）。2026-10-07 由 pm2 源码栈切换而来（停机 109 秒，数据零丢失）。
> 客户交付形态见 `docs/private-deploy/`；8443 测试环境同构（`-p raft-test8443`），仅 SHA 滚动不同。

## 现状速查

| 项 | 值 |
|---|---|
| compose 项目 | `-p raft-prod` @ `/opt/raft-prod-docker/` |
| 内容物 | docker-compose.yml（#183 版）+ `.env`（生产密钥）+ `certs/`（**通用名** fullchain.pem/privkey.pem）+ `downloads/`（cli/computer/daemon/desktop 全套 feed） |
| 卷 | `raft-prod_raft-pgdata`（数据库）、`raft-prod_raft-uploads`（附件）、`raft-prod_raft-redisdata`（redis RDB；迁移步骤见「备份与回滚」） |
| 网络 | `raft-internal`（internal:true，server/db/redis 零出站）+ `raft-edge`（仅 web，发布 443/80） |
| 端口 | web 容器 443(TLS)/80；db/redis 不发布 |
| 密钥 | JWT_SECRET / SCOPE_ATTESTATION_SECRET / POSTGRES_PASSWORD 在 `.env`（600）；与切换前逐字节一致（登录态与 agent token 连续） |
| 桌面更新源 | `downloads/desktop/`（latest-mac.yml + 版本子目录），private 模式自持 |

## 发版流程（唯一路径）

1. 在服务器构建检出（`/opt/raft-pd2/source`）`git fetch && git checkout <deploy 分支头 SHA>`
2. 构建双镜像（**用入库脚本 `ops/docker/build-release.sh <full-sha> deploy`**）：
   - 脚本产出 `raft-source-server:deploy-$SHA` 与 `raft-source-web-selfhost:deploy-$SHA`（**分支参数与 tag 用 `deploy`/`deploy-<sha>`**，修正 /api/version 显示 "dev" 的历史遗留）
3. 同源 downloads：`node scripts/build-release-artifacts.mjs --platforms linux-x64 --out <dir>` → rsync 进 `/opt/raft-prod-docker/downloads/{cli,computer,daemon}`；desktop 子树仅在桌面发版时更新。**`downloads/mobile/` 为手工放置目录**（Android APK，IT 经手上传+sha256 核对），发版 rsync 不涉及、不会被冲掉
4. 改 `.env` 两个镜像 tag → `cd /opt/raft-prod-docker && docker compose -p raft-prod up -d server web`
5. 验证：`/api/version` 三参数、health 200、登录探针（错误凭据 401）、容器健康；**desktop/mobile feed 落位后，对 latest-mac.yml 里的每个 url 逐条 `curl -I` 确认 200**（nginx 路径大小写敏感；上传目标只写目录不写文件名——见「已知坑」）
6. 有迁移时：entrypoint guarded migration 自动应用（日志确认 `[MIGRATION_DEPLOY_OK]`）；大表索引提前评估锁表（参考 0273 案例：2081 行毫秒级随部署走）

**deploy.sh 已不再用于生产**（pm2 源码栈时代的工具，随栈退役；保留在仓库供源码栈部署场景使用）。

## Feature flag 变更（唯一支持方式）

生产上改 feature flag **只走** server 镜像里的管理脚本。它调用 `featureFlagRolloutWriterService`：用当前 global config version 做 CAS，经 guardrail 决定放宽还是收窄，再把规则和审计写在同一个事务里。

**不要**再手写 SQL 改 `feature_flags`、`feature_flag_rules`、`feature_flag_config_versions` 或 `feature_flag_rollout_audit_events`。放宽记成 `operator_approved`，批准人写在 `approved_by`，receipt 留空。现在没有评估器，不要手写 receipt 来换一条 `guardrail_passed`。

脚本打进本变更之后构建的 server 镜像，入口是 `packages/server/dist/flag-rollout.js`。镜像带迁移 0282。容器里已经有 `DATABASE_URL`，不要把连接串打出来。8443 把容器名换成 `raft-test8443-server-1`。

```bash
# 只读
docker exec raft-prod-server-1 \
  node packages/server/dist/flag-rollout.js show --flag provider_connections_v0

# 预览，不写库。放宽打印 operator_approved 和批准人；收窄打印 narrowing。
docker exec raft-prod-server-1 \
  node packages/server/dist/flag-rollout.js server_allowlist_add \
  --flag provider_connections_v0 \
  --server <server-uuid> \
  --actor-type human --actor-name <name> \
  --approved-by <who-decided> \
  --reason "why this change" \
  --dry-run

# 收窄（从 allowlist 去掉一台，或 kill_switch_set --desired true）不需要 --approved-by。
# 放宽（加入 allowlist，或 kill_switch_set --desired false）必须带 --approved-by。
# 脚本不接受 --receipt-file / --receipt-id。
docker exec raft-prod-server-1 \
  node packages/server/dist/flag-rollout.js server_allowlist_add \
  --flag provider_connections_v0 \
  --server <server-uuid> \
  --actor-type human --actor-name <name> \
  --approved-by <who-decided> \
  --reason "why this change"
```

- `--reason` 必填。`--actor-type` 只允许 `human` 或 `agent`，`--actor-name` 写入审计的 actor id。放宽的 `--approved-by` 是做决定的人，写入 `approved_by`，和执行人可以不是同一个人。
- 一次只改一台 server。下一台用上一次输出里的新 config version 再跑。
- 省略 `--expected-version` 时，脚本读当前 version 填进 writer 的 CAS。传了但和当前不一致就拒绝，不写规则、不写审计、不推进 version。
- `--dry-run` 只打印决定，不写库。放宽没给 `--approved-by` 时拒绝，不写库。
- 控制面 id 默认 `production`（`RAFT_FEATURE_FLAG_CONTROL_PLANE_ID` 可改）。
- 成功时 stdout 是一份 JSON：变更前后的 rules、config version、authorization、approvedBy、audit event id。receipt 为空。

## 备份与回滚

- **每日备份 cron**：04:15 UTC `docker exec raft-prod-db-1 pg_dump` → `/root/raft-prod-backups/raft-prod-<ts>.dump`（umask 077、容器侧 pg_restore 核读、滚动留 14 份）——**校验必须用容器内 pg_restore**（宿主 pg16 读不了 pg17 的 1.16 格式头）
- 切换时点备份：`/root/prod-docker-switch/backups/`（pg dump+RDB+附件 census）
- 回滚阶梯：上一版镜像改 tag `up -d`（分钟级）；数据库回退用备份反向 restore（有损，需 owner 决策）
- 旧 pm2 栈回滚体：`/opt/raft/source` 已于 2026-10-08 清理（task #16，配置已打包 `/root/raft-prod-backups/opt-raft-configs-*.tar.gz`）。宿主 postgres16/redis 也已于同日**退役**（task #17：purge+数据目录清理；最终备份在 `/root/raft-prod-backups/host-pg16-final-20261008T130133Z/`——raft.dump 18.2MB+raft_test.dump 978KB 均 197 表核读通过、redis-dump.rdb）——**回滚到 pm2 形态已不可行**，数据库级回退仅靠 dump 备份链

### redis 匿名卷 → 命名卷迁移（逐栈执行）

redis 镜像自带 `VOLUME /data`，旧版 compose 未显式命名时 Docker 会建**匿名卷**——容器重建（镜像升级）时不随行，RDB 会静默丢失（机器在线信号等缓存全体短暂重建）。compose 已改为显式 `raft-redisdata` 命名卷；**已有部署按下述步骤迁移**（以 8443 栈为例，`-p` 与目录换成对应栈）：

```bash
# 0) 确认现状：redis 容器当前挂的匿名卷名（记下来）
docker inspect raft-test8443-redis-1 --format '{{range .Mounts}}{{.Name}} {{end}}'
# 1) 取出 RDB——用同步 SAVE（数据仅 KB 级，阻塞可忽略；BGSAVE 是异步的，
#    紧接着 docker cp 可能拷到写一半的文件）
docker exec raft-test8443-redis-1 redis-cli SAVE
docker cp raft-test8443-redis-1:/data/dump.rdb /tmp/redis-migrate.rdb
# 2) 同步新版 compose（含 raft-redisdata 顶层声明）到栈目录后，创建命名卷并注入 RDB
docker volume create raft-test8443_raft-redisdata
docker run --rm -v raft-test8443_raft-redisdata:/data -v /tmp/redis-migrate.rdb:/src.rdb:ro alpine \
  sh -c 'cp /src.rdb /data/dump.rdb && chown 999:999 /data/dump.rdb'
# 3) 重建 redis 容器（挂载新命名卷）
docker compose -p raft-test8443 up -d redis
# 4) 验证：容器 Up(healthy)、redis-cli ping 正常、旧匿名卷不再被引用后删除
docker volume rm <step0-记录的匿名卷名>   # 删前逐个 docker inspect 确认无引用
rm /tmp/redis-migrate.rdb
```

注：RDB 丢失的最坏影响是缓存类数据重建（机器重新上报心跳），非持久数据无损；迁移步骤是为了消除「升级 redis 镜像时全员短暂离线」的惊扰。

## TLS 证书续期（自动）

- **机制**：systemd timer `raft-tailscale-cert.timer` 每日跑 `/usr/local/sbin/raft-tailscale-cert-renew`（oneshot service 的 "inactive" 是正常间歇态，timer 活性用 `systemctl list-timers` 看）
- **续期条件**：`tailscale cert --min-validity 720h`——证书剩余有效期 >30 天时不换新（原件在 `/var/lib/raft-ops/certs/`，root:raft 644/640，归档保留）
- **docker 同步（2026-10-11 起）**：证书**内容**（sha256）变化时，脚本自动把 fullchain/privkey 拷入两栈 `certs/`（同目录暂存+原子 rename，owner/mode 保持 root:root 644/600），并在各 web 容器内 `nginx -t` + `nginx -s reload`。**任一步失败即中止，不再动另一栈**（单栈故障不扩散）
- **手动验证**：`/usr/local/sbin/raft-tailscale-cert-renew --force-sync`（证书未变也强制走一遍拷贝+reload 链路，用于验证）；外部核验用 `openssl s_client -connect raft.tailf3efbe.ts.net:443` / `:8443` 看指纹与到期时间
- **日志**：journal（`journalctl -u raft-tailscale-cert`）+ `/var/log/raft-cert-renew.log` 双落
- **关键日期**：当前证书（三处同指纹）**2026-12-31 02:14 GMT 到期**，约 **12-01 自动续新**并同步两栈；此前（10-07~10-11）docker 两栈证书是手工一次性副本、无同步机制，此脚本即为闭环该缺口

## 磁盘治理（39G 盘）

- 常态线：**至少 6G 空闲**；每小时 `/root/bin/disk-alert.sh` cron 检查，>85% 写 syslog + `/var/log/disk-alert.log`（运维日常巡检该文件，超线在 #all 报告）
- **构建起飞门槛（2026-10-13 起，task #37）**：`build-release.sh` 启动即自检磁盘空闲，**<12G 拒绝构建**（`RAFT_BUILD_MIN_FREE_GB` 可调）——磁盘高压期构建曾在 ~87% 出现 containerd 层导出竞态（content digest not found / tmpmount lstat 消失），连续两败后第三次才成
- journald 上限：`/etc/systemd/journald.conf.d/00-size-cap.conf` `SystemMaxUse=200M`（已配置；不设上限曾涨到 ~10G）
- 镜像保留（2026-10-08 owner 定）：生产现役+生产上一版（回滚体）+8443 现役，三组之外随发版清理；`docker builder prune` 定期跑（legacy builder 实际为 0，buildkit 场景才有量）
- **发版收官保留清单（2026-10-13 owner 定，盘定死不可扩——每次发版必须执行，不是想起来才做）**：
  1. feed：只留当前版+上一版（回滚体）；
  2. 镜像：只留当前+上一版（两栈同规），然后 `docker image prune -f`（清悬空层——legacy builder 失败中间层以 dangling 镜像堆积，2026-10-13 曾积 3.66G）；
  3. computer downloads：留当前+上一版，**外加持久化访问日志（14 天）里近 7 天被请求过的任何版本**；
  4. pre-release 备份：机上只留最近 2 份，更早的拷出机归档（sha256 校验通过后才删服务器侧）。
  **发版报告必须带磁盘占用百分比。**
  systemd timer `raft-image-prune.timer` 每周兜底跑一次
- pre-release 备份保留：**机上只留最近 2 份**，更早的拷出机归档（sha256 校验通过后才删服务器侧）
- **web 访问日志持久化（2026-10-13 起）**：compose 挂载 `./logs/nginx:/var/log/nginx-persist`+conf.d 追加文件版 access_log（additive，docker logs 不变）；轮转配置=仓库 `deploy/docker/logrotate/raft-nginx-access`（daily/14 份/50M 上限），装到 /etc/logrotate.d/ 并按栈改容器名
- 大件产物（发行包/桌面安装包）传输后及时清理服务器中转目录

## 已知坑（实战记录）

- **web 镜像证书要通用名**：`certs/fullchain.pem`+`privkey.pem`，不能用域名命名文件
- compose 卷名=项目前缀+声明名：uploads 实际卷是 `raft-prod_raft-uploads`，不是 `raft-prod_uploads`
- 构建期磁盘峰值：pnpm install + 双镜像层需 >5G 余量，盘紧会 ENOSPC 失败（先清 journal/悬空层再构建）
- **从 owner Mac 往服务器传产物，默认走 tailscale**（`root@100.99.233.89`，链路 direct），只有 tailscale 不通才退回公网 IP（38.55.131.6）。实测产物级 ~125KB/s——瓶颈是 Mac 上行带宽，与链路类型无关，200MB 级文件预算 25-30 分钟。**已知现象（2026-10-09，原因待查）**：tailscale 长传输（200MB 级 rsync）出现过两次**早期即断**（exit 11，ping 仍 direct/271ms，服务器侧零字节落盘）；同窗口公网 IP 的 scp/rsync 稳定。遇 tailscale 连续早断即按「不通」处理退公网，逐文件传 + `rsync --partial` 续传，勿反复重试 tailscale
- **传输目标只写目录，不写文件名**（如 `rsync -av src/ host:/opt/raft-prod-docker/downloads/desktop/0.1.6/`）：nginx 下载路径**大小写敏感**，手写目标文件名一旦大小写与 latest-mac.yml 的 url 不一致就 404（0.1.6 发版实测：rsync 目标名小写化 → yml 引用的 `Raft-Desktop-…` 404）。需要中转就整目录一起传；落位后按发版清单第 5 步对 yml 每个 url `curl -I` 核 200
- **传输脚本起飞前先自检源/目标路径**：脚本开头 `test -d "$SRC"`，目标目录不存在时先显式 `ssh mkdir -p` 并打印，随后打印源与目标全路径再传；任一不匹配或不存在就 `exit 1`，**绝不让 rsync 的隐式远端建目录行为替你建路径**（2026-10-11 实测：脚本目标路径笔误时，rsync 在因源缺失报错之前已把错误的目标目录建了出来）
- pipefail 下 `xxx --list | grep -q` 会因 SIGPIPE 假失败——长输出流校验用文件中转
- 空 crontab 时 `crontab -l | grep -v X` 退出码 1，在 set -e/pipefail 的 subshell 里会静默吞掉后续行——加 `|| true` 护栏
- **后台启动三件套**：先建好日志目录再重定向、脚本自写 pidfile、启动后 kill -0 验活——只看日志判断进度，不靠 pgrep（自匹配假阳性曾吞掉 25 分钟）
