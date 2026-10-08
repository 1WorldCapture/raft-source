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

## 磁盘治理（39G 盘）

- 常态线：**至少 6G 空闲**；每小时 `/root/bin/disk-alert.sh` cron 检查，>85% 写 syslog + `/var/log/disk-alert.log`（运维日常巡检该文件，超线在 #prod-docker 报告）
- journald 上限：`/etc/systemd/journald.conf.d/00-size-cap.conf` `SystemMaxUse=200M`（已配置；不设上限曾涨到 ~10G）
- 镜像保留（2026-10-08 owner 定）：生产现役+生产上一版（回滚体）+8443 现役，三组之外随发版清理；`docker builder prune` 定期跑（legacy builder 实际为 0，buildkit 场景才有量）
- 大件产物（发行包/桌面安装包）传输后及时清理服务器中转目录

## 已知坑（实战记录）

- **web 镜像证书要通用名**：`certs/fullchain.pem`+`privkey.pem`，不能用域名命名文件
- compose 卷名=项目前缀+声明名：uploads 实际卷是 `raft-prod_raft-uploads`，不是 `raft-prod_uploads`
- 构建期磁盘峰值：pnpm install + 双镜像层需 >5G 余量，盘紧会 ENOSPC 失败（先清 journal/悬空层再构建）
- **从 owner Mac 往服务器传产物，默认走 tailscale**（`root@100.99.233.89`，链路 direct），只有 tailscale 不通才退回公网 IP（38.55.131.6）。实测产物级 ~125KB/s——瓶颈是 Mac 上行带宽，与链路类型无关，200MB 级文件预算 25-30 分钟
- **传输目标只写目录，不写文件名**（如 `rsync -av src/ host:/opt/raft-prod-docker/downloads/desktop/0.1.6/`）：nginx 下载路径**大小写敏感**，手写目标文件名一旦大小写与 latest-mac.yml 的 url 不一致就 404（0.1.6 发版实测：rsync 目标名小写化 → yml 引用的 `Raft-Desktop-…` 404）。需要中转就整目录一起传；落位后按发版清单第 5 步对 yml 每个 url `curl -I` 核 200
- pipefail 下 `xxx --list | grep -q` 会因 SIGPIPE 假失败——长输出流校验用文件中转
- 空 crontab 时 `crontab -l | grep -v X` 退出码 1，在 set -e/pipefail 的 subshell 里会静默吞掉后续行——加 `|| true` 护栏
- **后台启动三件套**：先建好日志目录再重定向、脚本自写 pidfile、启动后 kill -0 验活——只看日志判断进度，不靠 pgrep（自匹配假阳性曾吞掉 25 分钟）
