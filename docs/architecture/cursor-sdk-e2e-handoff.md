# Cursor SDK 桌面测试版交付与验收说明

版本：`0.1.8-cursor-sdk.2`。工作区：`/Users/lyon/workspace/raft-source`，基线 HEAD `7796d74`。

本次完成的是可供用户自行端到端验证的 macOS Apple Silicon 桌面测试版，不是正式签名、公证或全平台发布。源代码保留在当前工作区，未 commit、push 或 publish；未安装/替换用户正在使用的应用，未重新登录或新建/撤销真实 Cursor 授权。

## 1. 本次交付产物

输出目录：

```text
/Users/lyon/workspace/raft-source/apps/raft-desktop-electron/release-cursor-sdk/
```

| 产物 | 文件名 | 大小（字节） |
|---|---|---:|
| 推荐安装包 | Raft-Desktop-Cursor-SDK-0.1.8-cursor-sdk.2-arm64.dmg | 211282279 |
| 解压运行包 | Raft-Desktop-Cursor-SDK-0.1.8-cursor-sdk.2-arm64.zip | 203874515 |
| 已展开应用 | mac-arm64/Raft Desktop.app | — |

SHA-256：

```text
f14c91696de349ba49431bebf747ccff464566b36e66b0013c69f450cc0486c6  Raft-Desktop-Cursor-SDK-0.1.8-cursor-sdk.2-arm64.dmg
8b3c06236c23c944cfef2f50dd39fe6c3ca3cfc7e48862438197c24b1486f06f  Raft-Desktop-Cursor-SDK-0.1.8-cursor-sdk.2-arm64.zip
```

请使用 `.2-arm64`，不要使用同目录上次中断时遗留的 `.1` 或 `x64` 产物。旧 Intel 产物中的 host 资产不匹配，本轮未将它们作为可用交付。此次只为当前机器构建并验证 arm64。

安装包未经过 Developer ID 签名或 Apple 公证。macOS 可能提示未经验证的开发者；这是受控本机测试版本，不应作为公开发行包。此预发布版本禁用了正式自动更新，避免验证时被线上版本替换；正式版更新逻辑未改变。

## 2. 实际接线

新增 `runtime=cursor-sdk`，保留原来的 `cursor` CLI，现有 Agent 不自动迁移。生产链路为：

```text
Raft Server → daemon/APM → CursorSdkRuntimeSession
                       → 固定 Node 24.15.0 常驻 host
                       → 原始 @cursor/sdk 1.0.36
                       → SDKAgent → 多个顺序 Run / 运行中 steer
```

外置资源在应用 `Contents/Resources/cursor-sdk/`，包含 Node、host、原始 SDK 生产依赖闭包和平台 helper。SDK 不通过 `/bundled` 入口塞入 Electron/SEA，不依赖用户 PATH 上的 Node，也不在用户启动时安装 latest。

APM 使用有 attemptId 的异步投递结果；只有 APM 负责回退 follow-up。`complete_delivered` 不补发，`revert` 恢复相应未读通知债务并等待真正空闲，未知 ACK 不当作已确认拒收。会话结束汇合 stream 排空、Run 终态和 ACK 结算，SDK user echo 不重新进入 Raft 聊天。停止过程有真实进程退出检查和有界升级，不仅凭 clean ACK 宣称退出。

主要文件：

- `packages/daemon/src/drivers/cursor-sdk.ts`：常驻会话、环境隔离、IPC、投递与停止。
- `packages/daemon/src/cursorSdk/{nativeRuntimeHost,nativeAuthHost,protocol,eventMapper,assets}.ts`：真实 SDK host、协议及资源校验。
- `packages/daemon/src/runtimeAuth/cursor/{nativeCredentialBroker,nativeAuthClient}.ts`：当前生产认证实现。
- `packages/daemon/src/runtimeDeliveryAttemptLedger.ts`、`agentProcessManager.ts`、`runtimeNotificationState.ts`：通知尝试与债务集成。
- `packages/computer/src/services/runtimeAuth.ts`、`cursorSdkAuth.ts`：本机 owner 认证服务与 CLI。
- `apps/raft-desktop-electron/src/app/cursorSdkControls.ts`、`src/main/cursorSdkMenuController.ts`：桌面原生菜单。
- `packages/shared/src/index.ts`、Web runtime form：能力注册与模型选择。
- `packages/daemon/scripts/build-cursor-sdk-assets.mjs` 与 `cursor-sdk-assets.lock.json`：固定资源构建。

并行实现遗留的第二套、未接线 auth broker 及仅对应的测试已经删除；生产 native 链路及其回归测试保留。

## 3. 登录体验与边界

当前已验证的主路径是只读复用 `~/.cursor/sdk/auth.json` 的已有 SDK 登录，再在线验证身份。绑定之后来源和主体固定；显式错误 key 不回退到另一账号。新浏览器登录通过官方 `Cursor.auth.login()`，创建 Raft 自有授权，不覆盖共享 SDK store。断开是本机禁用连接，不删除共享登录，也不宣称远端 key 已撤销。

桌面菜单：

```text
Cursor SDK → Connection Status…
Cursor SDK → Connect / Sign In… → Use Existing Login
Cursor SDK → Connect / Sign In… → Browser Sign-In
Cursor SDK → Cancel Sign In
Cursor SDK → Disconnect from Raft…
```

已经做过 SDK Demo 登录的当前机器，应使用 **Use Existing Login**，无须再登录。只登录过 `cursor-agent`、没有 SDK 登录的机器不能据此假定自动复用；CLI Keychain/API-key reader 和 CLI session → key bootstrap 未作为这次交付能力。Browser Sign-In 是此类场景的入口。

已有源 `CURSOR_API_KEY` 可被明确绑定，但远程 Agent env 不能覆盖本机绑定凭证、backend 或资源。连接状态是本地记录；Use Existing Login 执行在线验证。登录/断开时有活动 Cursor SDK host 会要求先停止 Agent。

## 4. 必须先确认的服务端条件

此桌面包包含新前端、内嵌 Computer/daemon，但**不包含部署到远端的 Raft Server**。

服务端也必须运行认识 `cursor-sdk` 的本次 shared/runtime 注册代码，否则新增 Agent 或模型目录请求可能被拒绝。本轮 server admission 测试已通过，但没有替用户发布、重启或更新线上服务端。需要用包含这些变更的服务端进行 E2E，不能把“只换桌面包”视为已完成服务器升级。

## 5. 用户 E2E 建议

1. 正常退出旧 Raft Desktop（不是仅关闭窗口；它可能继续驻留菜单栏）。新包沿用相同应用身份和既有数据，不能视为完全隔离的新环境。保留旧版本，不清空原应用数据。
2. 安装 `.2-arm64.dmg` 或把 `.2-arm64.zip` 解压到单独测试目录运行。确认 About 中版本为 `0.1.8-cursor-sdk.2`。
3. 进入有服务端支持的 Raft，确认本机 Computer 在线。通过原生 Cursor SDK 菜单选择 Use Existing Login，等待 Verified and connected。
4. 新建测试 Agent，runtime 选择 **Cursor SDK** 而不是 Cursor CLI；使用本机在线发现的模型。`composer-2.5` 是本次 smoke 选择，不是所有用户的强制默认模型。
5. 测试普通对话后继续提问，验证上下文延续。再要求执行安全的耗时工作，运行途中发消息调整目标，观察 steer 后的新要求生效。
6. 原工作结束后继续发送消息；停止再启动同一 Agent，检查会话恢复。旧 Cursor CLI/Claude/Codex Agent 应继续保持原行为。

Raft 当前 busy 语义注入的是 inbox 唤醒通知，Agent 再通过现有 CLI 读取业务消息；steer ACK 不等于消息已读或任务完成。不要把完整业务消息绕过 inbox 重复注入。

## 6. 已完成验证

| 检查 | 结果 |
|---|---|
| daemon / Computer / desktop 类型检查 | 通过 |
| 清理后的 Cursor SDK、认证、资产、APM 投递聚焦测试 | 15 文件，141 项通过 |
| 既有 Claude/Codex/旧 Cursor/APM/lazy-loading 回归 | 372 项通过，1 项跳过 |
| Computer 认证服务及 CLI presenter | 8 项通过 |
| shared runtime/config/availability | 51 项通过 |
| 桌面 unit / runtime / updater | 分别 150 / 33 / 2 项通过 |
| server Cursor SDK admission | 2 项通过 |
| Web Cursor SDK 表单 | 1 项通过 |
| 真实 SDK host + 当前生产 adapter smoke | 1 项通过 |
| 新 `.2` 应用包校验 | 1630 个资源文件、103 个主进程文件通过 |
| `.2` DMG / ZIP | hdiutil verify 与 unzip 完整性检查通过 |

不要对上表简单求和作为互不重复的测试总数；部分脚本覆盖重叠。

真实 smoke 使用已有登录、`composer-2.5`、来自应用包资源目录的真实 Node/SDK/auth host，以及当前生产 RuntimeSession adapter。测试了同 host 多 Run、运行时 shell sleep 期间 steer 得到 delivered、stop 后 PID 消失、新 host 恢复同一 nativeAgentId 并记得随机标记。为了不操作真实团队/频道，Raft server/CLI transport 用测试 seam 隔离；**这不是完整桌面 UI 到线上团队的端到端验证**。

新 `.2` 包再次校验了资源哈希和当前生成 dist 的精确文件集合/字节，确保没有旧 chunk、资源重复或陈旧内嵌 CLI。测试用临时工作区与连接记录在 finally 中清理，未改共享 SDK 登录。

## 7. 本轮收尾额外修复

- 主进程构建先清理顶层生成 JS/CJS，消除旧 lazy chunk 残留；原失败的版本标识测试已复现后修复。
- 打包过滤工作区 staging/cache，SDK 只由经过校验的 extraResources 提供；ASAR 不再重复携带 runtime-assets。
- 独立 arm64 E2E 构建命令强制构建、校验资产后再打包，并检查真正 `.app` 内的内容，不以 --version 代替完整验证。
- 旧 Intel 产物不列为交付。新版本号 `.2` 区分此前中断产物。
- release-cursor-sdk 加入 gitignore，避免二进制混入代码提交。

重建命令：

```sh
pnpm --filter @botiverse/raft-desktop-electron run dist:mac:cursor-sdk
```

只复核当前 `.app`：

```sh
pnpm --filter @botiverse/raft-desktop-electron run verify:cursor-package
```

## 8. 尚不应宣称完成的范围

完整桌面 UI/团队通信的 E2E 留给用户；本轮未验证首次浏览器登录的真人操作、CLI Keychain 复用、企业/服务账号、后台 subagent 的全部竞态、长期刷新/内存表现、崩溃 stale-run 的全自动恢复、全平台资源发布、正式签名/公证或资产原地升级回滚。测试版为 trusted-host 模式，独立进程不是同一 OS 用户下的安全沙箱。

认证操作与已写入的活动 host 锁之间有防护，但仍需在正式放量前强化启动租约至 host 注册之间的并发断开竞态。测试时不要同时发起 Agent 启动与账号切换/断开。清理失败、缺失 checkpoint 或未知 owner 应以可行动错误处理，不宣称自动恢复或完全停止。

## 9. 工作区保护

用户原有 `apps/mobile/metro.config.js` 修改未改变，SHA-256：

```text
414d64d2845e37aba937eae86df41213079181d04128da957647c7185aa0c63e
```

本次生产回归测试和构建校验脚本应保留；此前要求清理的是探索 Demo，不是删除产品测试。所有改动未提交，未发布到线上，未修改当前已安装应用。
