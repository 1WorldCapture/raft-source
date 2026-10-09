# M5 实施前协议纠正：Claim-Ack 不是服务端秘密 token

主执行者实读 `packages/shared/src/agentApiContract.ts:1226–1240`、`packages/cli/src/commands/message/_claimAck.ts` 与 `ack.ts` 确认：

- HTTP GET /events/claim 的 ack 字段仅 `{seqs:number[], message_ids:string[], third_party_event_ids:string[]}`（每数组 max500）。
- CLI Claim-Ack token 是 base64url(JSON {v:1,s:seqs,m:message_ids,t:third_party_event_ids})，不含秘密、不含 claimId、lease generation 或签名。
- CLI decode 只重建这三个数组，其他自创字段不会被回传。POST /events/ack 请求体就是这三个数组；响应 `{ok:true,removed_count:number}`。

因此本轮必须纠正 phase-5-delivery.md 中关于服务端秘密 claim token 的过强假设。A/D 实施不得添加客户端必填 token 或新字段。可以在服务端持久记录“该 Agent credential 确实领取过这些 delivery”的 receipt 与有限 lease，用于拒绝任意跨主体 ACK 和没有领取过的批量确认；但同一 Agent/credential 针对同一消息在不同租约世代的迟到 ACK 无法从原 wire 区分。这是兼容保证边界，不能声称强 claim-generation fencing 或 exactly-once。

批次 ACK 必须核对真实认证主体、当前 credential scope、workspace/Agent/channel 权限与已领取交集；不得把较大 seq 当累积确认水位。seq/message_id 两数组交叉一致与原客户端真实语义要通过共享 schema/CLI roundtrip 测试。第三方事件不在本期，不假造已删除数量。历史已 ACK 的合法重复返回0。

Managed machine ACK 的五元 snapshot 与连接代际校验不受此纠正影响，仍必须严格执行。
