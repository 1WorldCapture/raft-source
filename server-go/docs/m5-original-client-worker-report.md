# M5 原客户端验收 Worker 报告（Worker E）

> 历史工作快照：本报告记录 Worker E 当时的测试，不能单独代表最终工作区。2026-10-09 的最终集成已覆盖 0014/0015，并加强启动丢帧后的自动恢复、真实 wire 断言和已知 501 的严格校验；见 [最终原客户端验收](m5-original-client-final-review.md) 与 [M5 后端收口](m5-backend-closeout.md)。

- 日期：2026-10-09。
- 责任人：E。只改 `tests/acceptance/m5-original-clients/**` 与本文。未改 `internal/app`、dispatcher、claim、Makefile、`run.mjs`、`packages/`、`apps/`、锁文件、冻结迁移、golden。未 commit、未 push、未委派。
- 命令：在 `server-go` 执行 `make test-m5-original-clients`。退出码 0，墙钟约 30s。Go 进程由 `run.mjs` 编译并拉起；本套件自有临时目录与端口。未启动 `fixtures/machine-gateway.mjs`，也未走 `daemon-protocol-drive.mjs`。未使用已有实例或 `var*` 数据，未调用付费模型。

## 1. 源钉

```
FACT m5-original-clients source-pin HEAD=336b5c81b8d67c1c5d3cec2ef7e6fcb0bd2fed1c packages/cli=6a21bafbabbcec72f6373d5262895daa1ac49c01 packages/daemon=722599605c716b1daf7e815de630f5b339a7113d worktree=clean diff=none
```

`packages/cli`、`packages/daemon`、`packages/shared` 相对该 HEAD 无 diff。CLI 没有可执行的 `dist`；daemon 包装器用 `node` 执行 `slockCliPath`。Harness 的 `fixtures/original-cli-host.mjs` 只是宿主：`node --import <repo>/node_modules/tsx/dist/esm/index.mjs packages/cli/src/index.ts`，参数与环境原样转发。被测命令仍是未改过的 `packages/cli/src/index.ts`。

## 2. 上一轮挂起的原因（harness，不是生产缺陷）

父执行者把 `parent_channel_name` / `parent_channel_type` 改成 `omitempty` 之后，`make test-m5-original-clients` 打出 source-pin 就停在外部 120s。`runDrive` 把子进程全部输出缓冲到退出，内部期限是 600000ms，所以外部超时看不到卡在哪一步。

具体循环在 provider 状态机，不在 Go：

- 唤醒后的 bash 是未改的 `raft message check` 加 `raft message read`。工具结果里有人类 marker 之后，provider 再发一条 `raft message send --target '#all' --json`。
- 原 CLI `--json` 成功体是 `{ok,state,messageId,messageSeq}`，**不回显 stdin 正文**。
- 旧状态机用回复 marker 是否出现在 `role=tool` 里判断 send 完成。该 marker 只在 stdin，永远不出现，于是每一轮都再发一次 send。Pi 的 bash 工具没有默认超时，`waitFor` 要到 150s 才失败。这就是外部 120s 只看见 source-pin 的原因。

本轮改为：send 脚本先打 `M5-SECTION send`，完成条件是该段里的 `"state":"sent"`；正文是否落库仍由 Web `GET /api/messages/channel` 的恰好一条 `senderType=agent` 判定。`--idempotency-key` 只覆盖协议允许的一次 `SEND_HELD_AS_DRAFT` 重试，不会空转。check 在没有 tool result 时最多再发一次，第二次空结果直接结束并失败。bash 参数带 90s `timeout`（Pi 以秒计，无默认值）。

诊断：子进程每条 `PASS|FAIL|FACT|API-BLOCKER|SUMMARY|MODE` 行在产生时就转发；`waitFor` 每 5s 打一条不含正文的 `FACT m5-daemon-core step`；provider 每次非冷启动回合打 `stage/reason/requests/tool-flags`；父进程每 10s 打 `drive-heartbeat`（只含脚本名、耗时、上一条安全行的前 180 字符）。整段输出仍做凭证扫描，命中则整段扣下。

## 3. Claim 断言纠正（原 wire，不是放宽）

第一次修正 send 循环后，daemon 腿已通过，CLI 腿在单次 `raft message claim` 上失败：`claim arrays did not contain the mentioned message`。不是空 claim，也没有重试。

原协议（`m5-delivery-worker-contract.md`、`internalAgentApi` 形状）：正 seq 消息只进 `seqs`，`message_ids` 只放无正 seq 的 notice id，不放 `messages.id`。旧断言要求 `message_ids` 含该消息 UUID，会拒绝一次正确的 claim。现断言：

- 只 claim 一次；没有 `Claim-Ack:` 即失败，不轮询。
- `seqs` 含刚提交的 mention seq；stdout 含该 marker。
- `message_ids` 不含这条公开 message id；`third_party_event_ids` 为空；token 键只有 `v,s,m,t`。
- 未 ack 前再 claim 一次，仍是同一 seq。
- ack 的 removed count 为正，再 ack 为 `Acked 0 inbox items.`

## 4. 本次通过的原样结果

```
PASS m5-daemon-core R1-real-server-machine-online version-present runtimes=builtin
PASS m5-daemon-core R-mention-before-session persisted=true deliver-before-start=not-required
PASS m5-daemon-core R-cold-start-session runtime=builtin provider=deterministic-local wakeMessage=absent launch-present=true bodyInModelTurns=false
PASS m5-daemon-core R-tracked-ack runtime=builtin occurrence-matches-deliveryId=true transitions=daemon_received>daemon_drained bodyInModelTurns=false semantics=reported-receipt exactly-once=not-claimed live-llm=false
FACT m5-daemon-core provider-turn stage=await-check reason=issue-check requests=2 tool-flags=none
FACT m5-daemon-core provider-turn stage=await-send reason=issue-send requests=3 tool-flags=check+read
FACT m5-daemon-core provider-turn stage=done reason=send-sent requests=4 tool-flags=check+read+send+state-sent
PASS m5-daemon-core R-builtin-tool-consumption runtime=builtin tool=bash cli=packages/cli/src/index.ts proxy=daemon-local check-section-has-human-marker=true read-section-has-human-marker=true send-tool=raft-message-send web-count=1 semantics=model-tool-consumption live-llm=false receipt-phase=separate
PASS m5-daemon-core R-reconnect-retry same-process-reconnect=true first-occurrence-rewritten=false retry-session=unchanged exactly-once=not-claimed
PASS m5-original-cli C1 self-hosted-runner message-claim-three-arrays seqs+message_ids+third_party_event_ids token-keys=v,s,m,t positive-seq-ack=seqs public-message-id-in-message-ids=false
PASS m5-original-cli C1 self-hosted-runner message-claim-reissue same-message=true
PASS m5-original-cli C1 self-hosted-runner message-ack
PASS m5-original-cli C1 self-hosted-runner message-ack-idempotent removed_count=0
PASS m5-original-cli C1 self-hosted-runner message-check-legacy destructive-drain=true
PASS m5-original-cli C1 self-hosted-runner message-send
PASS m5-original-cli C1 self-hosted-runner message-send-idempotent
PASS m5-original-cli C1 self-hosted-runner message-read history-shows-agent-reply=true
PASS m5-original-cli C2 managed-runner-via-original-daemon-proxy message-send
PASS m5-original-cli C2 managed-runner-via-original-daemon-proxy message-send-idempotent
PASS m5-original-clients web-history builtin-tool-reply senderType=agent count=1
PASS m5-original-clients web-history agent-credential-reply senderType=agent count=1
PASS m5-original-clients web-history managed-runner-reply senderType=agent count=1
SUMMARY m5-original-clients complete
PASS graceful shutdown and credential-safe process output
```

日志里没有 `sk_computer_` / `sk_machine_` / `sk_agent_` / `sk_daemon_`、Bearer 或口令。本地 provider 的固定钥匙是 `sk-local-deterministic-provider-fixture`，模型名 `m5-acceptance-deterministic`，只打到本机回环。daemon 与 CLI 临时目录都打印了 `cleanup temp-dir-removed=true`。

`R-tracked-ack` 仍只是 content-free wake 的 reported receipt（`bodyInModelTurns=false`），不是模型消费，也不是 exactly-once。消费证据是其后单独的 bash 工具结果：check 段与 read 段都含人类 marker，send 段为 `state=sent`，Web 历史里该回复恰好一条。

## 5. 仍未实现、但不阻断本套件的原 CLI 面

```
API-BLOCKER m5-original-cli message-resolve GET /internal/agent-api/messages/{id}/resolve not-implemented (messages family deferred)
API-BLOCKER m5-original-cli resolve-channel original CLI calls GET /internal/agent-api/attachment-upload-capabilities before POST /resolve-channel; capabilities family returned not-implemented
```

这两条是原 CLI 先打到尚未实现的 messages/attachment 家族。本套件按既有约定把它们记成 API-BLOCKER，不把 501 当成 send/read/claim 失败。

## 6. 0015

本次跑套件时 `internal/platform/db/migrations/` 只有到 `0014_delivery.sql`，没有 `0015`。本 worker 不改迁移、不改 registry。若另一 worker 落地附加的 session-binding `0015`，由父执行者接入 registry；本报告不声称已经覆盖那次迁移。

## 7. 明确不声称

- 未测 claude / codex / kimi / cursor / opencode / grok 等 runtime。支持面只有 builtin 的 bash 工具。
- 没有真实 LLM，没有浏览器签收。
- receipt 阶段与工具消费阶段在 provider 状态机里是分开的；没有把 ACK 当成消费。
