# 私有化发行包 内部打包手册（不对客户交付）

> 对应 commit **d574ce4667456cd9d02bdf0cc05b4ba5da48865b**（私有版 0.1.3，tag `v0.1.3`）；客户文档见 DELIVERY.md。

## 1. 分工与顺序（正式构建）

全部使用同一个 commit，构建前确认工作区干净（脚本拒绝 dirty tree）。

1. **Linux（xai）**：linux-x64 Computer、CLI、daemon、downloads 树和 manifests；用 rcodesign 构建 darwin-arm64/x64 Computer；cursor-sdk 的 darwin 资产。
2. **服务器**：private 模式的 server/web 镜像（入库脚本 `ops/docker/build-release.sh <full-sha> <branch>` 一键完成：frozen install→双镜像（tag `<branch>-<sha>`）→linux-x64 downloads 产物，自写 pidfile+分步日志），`docker save` 成 tar，记录 sha256 和大小；**自有生产发版走 deploy 分支并打 `v0.1.x` annotated tag**（客户交付包仍按本手册三路构建）。
   **版本标签规矩（发版追溯）**：每次生产发版完成后，在 deploy 分支对应的 commit 上打 annotated tag 并推送：`git tag -a v0.1.x -m "release v0.1.x" <sha> && git push origin v0.1.x`。历史映射：`v0.1.0`=`e4a40e8`、`v0.1.1`=`b5f7fdd`、`v0.1.2`=`0391e80`、`v0.1.3`=`d574ce4`。客户交付的 DELIVERY.md 只写「发行版号+构建 commit」这类可核对信息，不出现我们的仓库与分支操作。
3. **Mac**：`--only desktop`，产出 Desktop 的 arm64/x64 dmg/zip、`latest-mac.yml`、desktop manifest，传走后立即清理（峰值约 10–11GB）。
4. **汇总**：在服务器组装发行包，整包重算 sha256，与各方清单逐项比对；所有 manifest 的 commit 必须一致。
5. 全新安装复验：downloads 树整体重建（desktop/ 只留当前版本）、断网安装、完整用户流程、首次检查更新不提示。

资源（xai 实测）：Linux 全量约 1 分钟，下载树约 340MB；限制内存 `NODE_OPTIONS=--max-old-space-size=3072`。

## 2. 在 Linux 上构建

**命令**

```sh
export COREPACK_HOME=<工作区>/corepack
export RAFT_CODESIGN_TOOL=rcodesign
export RAFT_RCODESIGN=<rcodesign 路径>
pnpm install --frozen-lockfile
node scripts/build-release-artifacts.mjs --out <dir>
# cursor-sdk darwin 资产
node packages/daemon/scripts/build-cursor-sdk-assets.mjs --target darwin-arm64   # 再 --verify --require-registry
node packages/daemon/scripts/build-cursor-sdk-assets.mjs --target darwin-x64
```

除 Desktop dmg/zip（依赖 macOS `hdiutil`）外，全部产物可在 Linux 构建。darwin Computer 用 rcodesign 做 ad-hoc 签名：

- 版本：rcodesign **0.29.0**，官方 release 预编译二进制（`apple-codesign/0.29.0`，asset `apple-codesign-0.29.0-x86_64-unknown-linux-musl.tar.gz`），下载后用 release 附带的 `.sha256` 校验，放在仓库外的工作目录，无需 sudo。
- 显式开启：`RAFT_CODESIGN_TOOL=rcodesign`、`RAFT_RCODESIGN=<路径>`；不开启则构建报错，不会静默产出未签名文件。
- 构建需要 Node >= 24；corepack 无法写系统目录时设置 `COREPACK_HOME`。
- 验证：darwin-arm64 的 ad-hoc 签名产物在 Mac 上 `--version` 正常、`codesign -dv` 识别为合法 ad-hoc 结构（May 验证，试跑产物与 PR #178 分支产物字节一致）。
- 可复现性：同一 commit、同一工作目录路径下构建结果字节一致；工作目录路径会被嵌入 SEA blob，路径不同则 sha256 不同（不影响功能）。清单以最终构建为准。


- cursor-sdk 的 darwin 资产在 Linux 上只校验 manifest 哈希（1630 个文件），不执行其中的 node（跨架构）；执行层面的验证在 Mac 上随 Desktop 构建完成。

## 3. 按客户打包（Desktop 单步重打）

Desktop 安装包在构建时烘焙服务器地址（`--desktop-origin`，写入 VITE_API_URL/CSP/manifest.origin），因此换客户必须重打 Desktop。

1. 复用发行包中除 Desktop 外的全部产物（镜像、linux Computer/CLI/daemon、downloads 树、cursor-sdk 资产——它们与服务器地址无关，镜像的 SERVER_URL 在部署时由环境变量注入）。
2. 在一台 **macOS** 机器上、检出与发行包**相同的 commit**，运行：
   ```sh
   node scripts/build-release-artifacts.mjs --out <发行包 downloads 目录> --only desktop \
     --desktop-origin https://<客户 SERVER_URL>
   ```
   `--desktop-origin` 必须是裸 https 根地址（脚本校验）。`--only desktop` 只重打 `desktop/`（dmg/zip 的 arm64+x64、`latest-mac.yml`、desktop manifest），不重建其他产物，manifest 的 commit 不变。
3. 验收：desktop manifest 的 `origin` = 客户地址；app 内更新检查与下载入口均指向该地址（检测逻辑为 detect-only，点更新=打开下载页，不自动安装）。
4. 本次候选版 Desktop 使用 18443 的 origin（`https://raft.tailf3efbe.ts.net:18443`），**仅供 IT 复验，不进客户交付包**；交付文档注明「Desktop 按客户重打，样例 origin 仅供复验」。


## 4. 已知坑

- Node 版本：仓库要求 >= 24。
- 旧的 18443 feed 若指向更高版本号（如 0.1.10），新装 0.1.0 会提示「降级」——上架时整体重建 downloads 树。
- `gh pr create`（GraphQL）在当前 org 策略下被拒，用 REST：`gh api repos/1WorldCapture/raft-source/pulls --input -`。
- 构建产物不进 git；工作目录路径会嵌入 SEA blob（路径不同则 sha256 不同）。
