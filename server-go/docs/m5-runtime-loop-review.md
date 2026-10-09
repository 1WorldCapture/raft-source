# M5 original runtime loop — read-only review findings

2026-10-09. Source review by independent worker `agt_36224b1c`; no original client files changed and no live service started by the reviewer. This is a recipe and evidence boundary, not an executed-test result. E2 owns implementing/executing the acceptance extension.

## Real path

1. `packages/daemon/src/core.ts` skips tracked mentionDelivery frames for wake promotion. Builtin cold start receives the standing prompt `Start.`, not the human message body.
2. `agentProcessManager.ts` idle delivery writes a content-free `Inbox update:` notice. `daemon_received` / `daemon_drained` / `agent:deliver:ack` report notification acceptance, not body consumption. The actual body remains in the daemon-local inbox.
3. `drivers/pi.ts` uses the real `bash` tool replaced with `createPiCommandTool` (`drivers/piCommandTool.ts`). POSIX schema: `{command: string, timeout?: number}`. No separate Raft tool is needed. The shell gets the launch PATH wrapper, SLOCK_HOME/AGENT_ID/SERVER_URL/CLI_TRANSPORT_DIR; the wrapper supplies the local proxy URL/token-file without exposing the provider key.
4. A provider-generated bash call to `raft message check` consumes exact local inbox IDs through the ORIGINAL credential proxy. `raft message read --target '#all' --limit 20` goes through the proxy to Go history and updates the CLI seen cursor. The next actual provider request contains the marker in a role=tool message.
5. A later provider-generated bash call to `raft message send --target '#all'` with stdin text goes through the original proxy to `/internal/agent-api/v2/send`; verify its real persisted sender/type/content in the public Web-compatible channel history.

## Fixture corrections to make

- The current original-CLI/daemon drive points `slockCliPath` at `packages/cli/src/index.ts`. The injected wrapper uses plain node, not tsx, and `index.ts` imports `./main.js`; a genuine runtime bash invocation will fail. Use the runnable built original CLI entry (`packages/cli/dist/raft.js`) only after verifying it corresponds to the pinned original source, or build the unchanged original CLI into the owned temporary fixture directory. Do not rewrite original client source or lockfiles.
- A fixed provider returning only assistant text proves neither tool execution nor reply persistence. Add deterministic SSE tool_calls using the original OpenAI-compatible protocol, not a mocked Bash executor.
- Scope body-free wake assertions to pre-tool/user-notice evidence. The later role=tool provider request MUST contain the source marker. Retain the distinction rather than failing whenever any request contains the marker.
- Existing CLI C2 creates a separate original credential proxy without the live Agent inbox coordinator. It proves that transport mode but is not proof that the running builtin Agent consumed/sent. Keep that separate from the new full builtin leg.

## Minimal deterministic provider sequence

- On initial `Start.`: emit ordinary assistant text and finish_reason=stop; let the original session become idle.
- On the appropriate content-free Inbox update: emit one `bash` tool call with `command: raft message check && raft message read --target \"#all\" --limit 20` and a bounded timeout.
- Inspect a subsequent request's `messages[]`: require role=tool content containing the particular human marker; merely finding it in system/user/history metadata does not count.
- Emit another `bash` call whose command is a normal `raft message send --target \"#all\"` with the scripted reply on stdin (a bounded heredoc or equivalent). Use a deterministic idempotency key where the original command supports it.
- If the original local freshness coordinator returns SEND_HELD_AS_DRAFT/state=held, repeat an ordinary send after the check/read cursor. Do NOT call --send-draft: that deferred-send feature is explicitly unimplemented on this M5 backend and must not be reclassified as sent.
- After a successful tool result, emit final assistant text. Require a real owner-visible Go history row with that reply, senderType=agent and the exact builtin Agent ID, appearing once.

SSE must carry `delta.tool_calls[]` with index/id/type=function/name=bash and JSON-string function.arguments; the final chunk uses finish_reason=tool_calls followed by [DONE]. Pi then appends the real tool result to the next chat/completions request. The local provider is scripted and never contacts a commercial model.

## Authentication/configuration

`agent:start` uses `config.serverUrl`, does not embed a permanent Agent key, and uses empty authToken. The original DaemonCore has the Computer key and requests `/internal/computer/runners/{agentId}/credentials` with its actual scopes; the result stays in the proxy. The provider baseUrl is an owned loopback OpenAI-compatible server with gateway/openai-compatible settings. Ensure the process harness advertises a reachable Go control URL, not an unrelated Web-origin port.

No model-consumption or exactly-once claim may be inferred from daemon ACK. The requested new tool-result evidence is stronger than ACK, but still a deterministic provider fixture, not a live LLM or browser UI signoff.
