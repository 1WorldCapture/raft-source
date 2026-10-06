# Cursor SDK implementation integration review (parent)

> Historical draft-review record, retained for provenance. It is not the current open-issue list. The native production chain supersedes the discarded drafts below. See [the E2E handoff](cursor-sdk-e2e-handoff.md) for the verified 0.1.8-cursor-sdk.2 arm64 artifact, fixes, test evidence and remaining limitations.

The following were blocking review findings from in-progress drafts; each describes the draft state at review time, not the final E2E build.

## Auth

- The SDK exports `class Cursor` (`typeof Cursor === 'function'`), not an object-only namespace. `Cursor.models.list({apiKey})`, NOT `Cursor.models()`. `Cursor.me({apiKey})` -> SDKUser.userId?: number and userEmail?: string. Use exact published SDK types, not guessed broad structural APIs/fixtures.
- Verify and models must use the exact explicitly supplied credential snapshot through private Node IPC, not default SDK auto-resolution plus fingerprinting some possibly different file. Model detection must respect existing bound source and principal. Snapshot key should be online verified before a lease; bounded cache allowed but not indefinite.
- Browser login MUST NOT overwrite ~/.cursor/sdk/auth.json. Use `Cursor.auth.login({openBrowser:false,onLoginUrl,signal,store:null,...})` in the host and transfer result on private IPC, verify same key/principal, atomically persist under Raft-owned control-plane directory. Borrowed store is always readonly. Login requires owner action. Failed persistence/mismatch must report the possible orphaned key rather than blindly retry.
- Store schema must check version=1, expiration (no post-expiry grace), approved backend exactly https://api2.cursor.sh for initial release, bounded opaque nonempty key rather than crsr_ regex. Default source can be shared SDK store or a bound Raft-owned store; never guess from key prefix.
- Read secret files with bounded size + owner/regular-file/no symlink checks. State directories must reject symlinks and permission failures, not ignore chmod failure. Do not print JSON parse error causes (may include secret).
- Explicit disconnect must persist disabled intent (tombstone) so next agent launch/model detection cannot automatically rebind the still-present shared store. Borrowed logout does not delete/revoke source. Owned disconnect may keep private key for later explicit reuse but never silently reconnect. Active hosts need stop/refusal before claiming disconnected; do not promise remote revocation.
- fs async operations must import from node:fs/promises, not await callback fs functions.
- Replace auth/assetResolver dynamic-specifier shim with static lightweight assets import before tsup/Electron packaging.
- Add public command `raft-computer runtime auth <status|login|logout> cursor`; do not confuse Raft main login. Parent menu uses Computer service exports; report exact signatures.

## Runtime/APM coordination

- BLOCKER in current runtimeHost draft: actual SDK does NOT export a runtime `SDKAgent` constructor and has no `new Cursor(...).agent.run(...)`. Exact 1.0.36 API is `Agent.create(options):Promise<SDKAgent>`, `Agent.resume(agentId,options):Promise<SDKAgent>`, `agent.agentId`, `agent.send(text):Promise<Run>`, `run.id`, `run.stream():AsyncGenerator<SDKMessage>`, `run.wait():Promise<RunResult>`, `run.steer(text):Promise<SteerAckOutcome>`, `run.cancel():Promise<void>`, `agent[Symbol.asyncDispose]():Promise<void>`. Rewrite guessed structural SDK factories against actual published `.d.ts`. Runtime SDKAgent is type-only. Normalized assistant text is message.message.content blocks, not message.content. tool_call carries status running/completed/error and args/result; emit completion rather than a second tool call. The full SDK public types are available in the pinned tarball's dist/esm/agent.d.ts, messages.d.ts, run.d.ts.
- APM worker added RuntimeDriver.deliveryOutcomeAttempts; real CursorSdkDriver MUST set true or no attemptId is allocated and outcomes cannot restore debts.
- Child host startup must strip NODE_OPTIONS/NODE_PATH/NODE_TLS_REJECT_UNAUTHORIZED and per-agent overrides of backend/assets. Shared runtime config now strips these but raw env merge still needs defense.
- No broad UnknownAgentError -> new Agent; only actual AgentNotFoundError and explicit recovery behavior. Resume must not silently erase state.
- Require native run terminal+stream drain+steer outcome settle/unknown, no parent busy lock falsely idle.

## Assets

- Resolver manifest entry paths must be relative and confined to asset root (realpath/no escaping symlinks), not arbitrary ../ paths.
- Validate executable/host/package integrity against generated SHA256 manifest before passing credentials, and validate the staged closure when packaging. Version-only package.json check is not proof original SDK bytes were loaded.
- Prefer no private signing/publish. Parent created electron-builder.cursor-sdk.yml (extends canonical config), output release-cursor-sdk, version 0.1.8-cursor-sdk.1, publish:null. Parent disables updater only this exact prerelease version pattern.

Parent will re-review after workers complete and run a real bounded packaged-host smoke. This file is review evidence, not a claim these issues have already been fixed.
