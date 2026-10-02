# 自托管 Computer 发布源（自托管指南）

本文说明如何把「连接一台计算机」引导页所需的安装脚本和版本产物托管在你自己的部署上（nginx 的 `/computer/` 路径），替代官方 `cdn.raft.build`。适用于私有化部署配置契约 v1（`RAFT_COMPUTER_RELEASE_BACKEND=manifest` 模式；`hands` 模式也需要这里的发布文件根，只是版本权威在 Hands）。

> 契约要点：引导命令全链路走私有环境——安装脚本从 `RAFT_COMPUTER_RELEASE_BASE` 下载，计算机注册显式携带 `--server-url <RAFT_PUBLIC_ORIGIN>`，安装即初始化本机发布源（`<状态根>/computer/release-source.json`），升级器与常驻服务共用该来源。任何环节配置缺失都是**可见失败**，绝不静默回退官方源。

目录

1. [目录布局与 nginx 行为](#1-目录布局与-nginx-行为)
2. [运维配置 env.local](#2-运维配置-envlocal)
3. [服务端配置 packages/server/.env](#3-服务端配置-packagesserverenv)
4. [发布流程](#4-发布流程)
5. [首版约束](#5-首版约束)
6. [网络可达性（Tailscale）](#6-网络可达性tailscale)
7. [验证清单](#7-验证清单)

---

## 1. 目录布局与 nginx 行为

`RAFT_COMPUTER_WEB_ROOT`（默认 `/srv/raft-computer`）就是 `/computer/` 背后的本地目录：

```
/srv/raft-computer/
├── manifest.json          # 根 latest 指针：{"version": "<semver>"}，发布脚本原子切换
├── install.sh             # 入口脚本（shell）
├── install.ps1            # 入口脚本（PowerShell）
└── <version>/             # 版本目录：不可变
    ├── manifest.json      # 该版本清单（targets + photonWasm，含 sha256/size_bytes）
    ├── raft-computer-<target>...   # 各平台二进制（含可选 gz 边车）
    └── photon_rs_bg.wasm  # 图像处理 wasm 边车
```

nginx 模板（`ops/self-host/nginx/raft.conf.tmpl`）的缓存策略：

- `manifest.json`、`install.sh`、`install.ps1`：`no-cache, must-revalidate`——它们代表"当前发布"，必须即时反映最新一次发布；
- `<version>/` 下所有文件：`public, immutable, max-age=31536000`——版本目录一旦发布不可变（发布脚本保证），可永久缓存；
- 其余 `/computer/` 路径一律 404，不落入 SPA 的 index.html。

## 2. 运维配置 env.local

`ops/self-host/env.example` 新增一项，复制到 `env.local` 后按需调整：

```bash
RAFT_COMPUTER_WEB_ROOT=/srv/raft-computer
```

改完后重渲染并热加载 nginx（改模板，不要手改 `$RAFT_OPS_HOME/nginx/` 里的渲染产物）：

```bash
ops/self-host/render-nginx.sh --reload
```

## 3. 服务端配置 packages/server/.env

引导契约的五个变量权威在 `packages/server/.env`（服务端读取并经 `GET /api/deployment/computer-setup` 下发；`env.local` 不复制这些值，避免双份漂移）：

```bash
RAFT_PUBLIC_ORIGIN=https://raft.example.internal   # 对外 API origin，仅 origin，必填
RAFT_COMPUTER_RELEASE_BASE=https://raft.example.internal/computer  # 发布文件根，两后端均必填
RAFT_COMPUTER_RELEASE_BACKEND=manifest             # hands | manifest，默认 hands，不自动降级
RAFT_COMPUTER_HANDS_ORIGIN=...                     # hands 模式必填；manifest 模式不使用
RAFT_COMPUTER_PINNED_VERSION=                      # 可选，映射 pinned:<version> channel
```

生产 URL 必须为 HTTPS（开发回环可显式允许 HTTP）。改完后重启 raft-server 生效。

## 4. 发布流程

使用 `ops/self-host/publish-computer.sh <staging-dir>`。staging 目录按第 1 节布局准备（恰好一个 `<version>/` 目录 + 可选入口脚本），脚本按契约顺序执行：

1. **校验**：解析版本目录的 `manifest.json`，逐文件核对 sha256 与 size_bytes（targets、gz 边车、photonWasm），多余未引用文件也拒绝——损坏或不完整的 staging 在任何线上变更之前失败；
2. **发布版本目录**：拷贝到临时目录并二次核对后原子 `mv` 为 `<version>/`，并去除写权限；
3. **入口脚本**：内容有变化则原子替换（本机有 shellcheck 时先过一遍 `install.sh`）；
4. **最后切换 latest 指针**：生成 `{"version": "<version>"}`，回读解析无误后原子 `os.replace` 到根 `manifest.json`。

不可变规则（防止缓存与内容不一致）：

- 同版本、不同内容 → **拒绝发布**，提示提升版本号；
- 同版本、相同内容 → 幂等通过（重试安全）；
- 任何校验失败 → 当前 latest 指针**保持不变**。

## 5. 首版约束

- `/computer/` 下的 `install.sh` / `install.ps1` **必须是支持持久化契约的新版脚本**（安装即写入 `release-source.json`、统一安装/升级变量）。直接镜像官方旧脚本不足以完成引导闭环——首个可用版本 = 新脚本 + 该版本全部产物 + manifest，三者同批落库；
- 官方旧版本目录可以直接复用其产物**仅当**入口脚本已是新版（产物本身与来源无关，校验逻辑不变）；
- 新引导发布前必须完成 A/B/C 联调（全新安装 → 注册 → 服务重启 → 升级），见契约「PR 与交付」节。

## 6. 网络可达性（Tailscale）

本部署当前对外域名是 Tailscale 域名（如 `raft.tailXXXX.ts.net`）。引导页上的安装/设置命令要跑在**能访问该域名的计算机**上：

- 已加入同一 Tailnet 的机器：直接可用；
- Tailnet 之外的机器：需要先解决可达性（Tailscale subnet router / 公网域名 + DNS + 证书），否则 `curl` 与 `raft-computer setup` 都会连不上。这是部署边界条件，请在接入新计算机前确认。

## 7. 验证清单

发布后逐项检查：

```bash
# 1) latest 指针与版本目录一致
curl -s https://raft.example.internal/computer/manifest.json
# 2) 入口脚本可下载（应返回新脚本内容）
curl -fsSL https://raft.example.internal/computer/install.sh | head -5
# 3) 版本产物 sha256 与该版本 manifest 一致（抽一个目标平台）
curl -s https://raft.example.internal/computer/<version>/manifest.json
# 4) 引导页（连接一台计算机）显示的命令全部指向自有域名
# 5) 全新安装 → raft-computer setup --server-url ... → 服务重启 → 升级 全链路（task #9 联调）
```
