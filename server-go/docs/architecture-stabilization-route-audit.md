# Architecture stabilization：路由清单审查记录

- 日期：2026-10-08（America/Los_Angeles）。
- 性质：历史静态审查与最终处置记录；唯一活动清单为 `internal/transport/httpapi/manifest_table.go:Manifest()`，实际验收见收口报告。
- 基线：`6ffc168dd7025a2d5f61416347ecc9937853c3ad`。
- 对象：`internal/transport/httpapi/router.go` 的初期 49 条 `Manifest()` 记录及真实叶子注册点；最终状态见 [收口报告](architecture-stabilization-closure.md)。

## 已确认的问题

初期 Manifest 不是完整清单。`/api/runtime-catalog/*` 根本不是实际注册路径：runtime catalog 位于 servers 的 machine 子路径及 agents 的 runtime-options。`/api/servers/{id}/*`、`/api/messages/*`、`/api/agents/{id}/*`、`/internal/computer/*` 等近似通配不能替代真正挂载的字面量、Go ServeMux wildcard、dispatcher 子端点或 gates-first 的 405 fallback。

缺失项还包括 readstate 的 activity/inbox/read/unread/prefs/read-mutations 面、DM/thread 路由、尾斜杠 `{$}` 别名、账号与 workspace 的保留路径，以及内部已登记但未实现家族的 401/501 区别。单纯检查清单是否有重复条目，无法发现漏登记、虚构路径或身份标注错误。

## 必须保留的真实行为

`Require` 验证账号/会话身份；`RequireVerified` 是 `RequireVerifiedProfileComplete` 的别名，后者额外检查邮箱与资料完成。不可根据函数名称误造出第三档门禁。

设备 approve、computer attach、legacy-machines 是 Require-only 入口；device authorize/token 和 bootstrap `/api/agent/login` 不加人类 RVP 或机器 key 门。人类管理 Agent 凭据及机器增改删/rotate-key 则属于 humanapi，按原 RVP、scope 和 guest 策略执行。内部未登记路径保持先回答 unregistered，不能先检查一个该路径根本不接受的凭据。

405 并非统一由最外层路由直接返回：多个 server/channel/conversation 路径需要先完成原身份、scope、guest 检查，才返回准确 Allow。不能为让清单更易生成而改变这些分支、尾斜杠和字面量的优先级。

## 限流实例：纠正静态审查中的误读

必须沿着构造位置数实例，而不是看到同名 `limited` 就假定共享。当前 `computerapi.RegisterRoutes` 的 `limited(handler)` **每调用一次都调用 `ratelimit.New`**：device authorize、approve、token、attach、legacy-machines、agent/login 是六个各自独立的 per-IP limiter；默认每端点 200/min。它们也不共享 account 的 general-auth limiter。

account 面有共享 general-auth 桶及额外 register/login-account/forgot 桶；消息写入使用自己的 per-user limiter。机器管理搬迁不能悄悄将六个 admission 限流器合并成一个桶，也不能与账号面合并。早期辅助审查中“七条设备路由共享一个实例”的结论与实际代码不符，本记录不采用它。

## 验证方式

`tests/architecture/route_manifest_test.go` 是批准的结构合同：真实源码中的每个 literal Handle/HandleFunc 注册点必须有精确清单记录，叶子归属必须一致，不能用 Pattern 中虚构的星号代替真实路由；清单应具有 Gate、Scope、RateLimit、Capability 维度。动态注册和 dispatcher 子路径仍需单独核对，不声称 AST 可以证明完整鉴权行为。

执行证据来自真实装配后的 HTTP 测试、原始客户端、33 个路由/身份新旧回退探针，以及最终全套复跑。静态清单与执行测试互补；不新建路由配置框架，不新增 API，不用元数据代替原来的授权实现。

## 最终处置与验证

最终实际枚举 **248 项：169 个 mount、79 个 dispatch 逻辑子项**。清单恢复独立的 Identity、Allow 字段，并加入 Kind，区别真实挂载与已有 dispatcher 的子路径；Gate/Scope/RateLimit/Capability 保留完整描述。清单只生成审查数据，不参与请求授权或路由注册。

中间 173 项实现曾通过粗结构检查，却仍含虚构的 `/api/servers/{id}/` 回退、错误的含 emoji reaction URL、Agent credential 错误限流和 unregistered Agent root 错记 405 等事实问题；最终版本已经替换，不将“通过 AST”当作“策略描述正确”。新 `manifest_policy_regression_test.go` 固定这些已发现错误；`manifest_test.go` 检查 vocabulary、唯一性和 mount/dispatch；架构测试仍核对真实字面量挂载与 owner。

一个需特别区分的同名函数：readstate 的中间件是 **ReadstateHandlers.RequireServerScope**，按 X-Server-Id 检查会员关系；不是 ServersHandlers 的同名方法，后者还要求 URL workspace ID 相同。readstate URL 中的 id 是频道 ID。最终清单明确表达了这一差异。

33 个 Agent deferred 家族按真实首段分类器逐名核对；未知路径先 401，已知但未实现的家族认证后 501。admission 六个 limiter 独立实例、reaction 的 `/reactions/actors` 和 `/reactions/viewer`、machines 的原 Allow GET fallback、reserved method 路径均保持原行为。

最终在所有源代码修正后实际执行 `make check`，包括完整普通/race、原协议/fresh Go wire、真实 HTTP/Socket.IO、原始 Computer/Daemon 客户端及新旧程序的 33 个路由/身份回退探针，全通过。`route-inventory-candidate.txt` 只是历史审查草稿，不是另一套当前清单。
