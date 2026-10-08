# M4 backend-compatibility reference contracts (frozen at bc65213)

These six JSON files are the frozen wire contracts the M4 Go backend must be
compatible with. They are GENERATED — every `executed` block is a transcript of
the ORIGINAL TypeScript parsers/normalizers/reducers/schema from the pinned
baseline actually running; nothing in them is a hand-typed expectation. The one
exception is clearly labelled: `history-coverage.contract.json` is
source-derived (see inside), because the original function reads PostgreSQL.

Regenerate / verify:

```bash
node server-go/tests/acceptance/m4-reference/run.mjs          # run + regenerate (byte-stable)
node server-go/tests/acceptance/m4-reference/run.mjs --check  # assert fixtures unchanged
```

If a pinned source hash drifts, the suite refuses to run — re-review the
baseline before trusting any regenerated evidence.

## Files

| file | area | how it was frozen |
|---|---|---|
| `messages-wire.contract.json` | v1/v2 message create: body limits, mentions, randomId, cursors, reaction parsing | executed original `messages.ts` parsers + error literals extracted from the same pinned bytes |
| `canonical-message.contract.json` | canonical message manifest, shared/private omission, socket allowlist, commentRef shared-null-preserve fold | executed original shared manifest + socket projector + web canonical fold |
| `history-coverage.contract.json` | `MessageWindowCoverage` boundary shapes + message-page envelope | **source-derived, not executed** (needs PostgreSQL); every expectation is line-anchored to the pinned function |
| `readstate-prefs-wire.contract.json` | read-mutation admission parser, read-state ledger, read receipts, mute/display/notification prefs | executed original route segment + web pure domains |
| `thread-dm-wire.contract.json` | channel visibility/name validation, DM/thread route literals, DM channel fold | executed parsers/validators/fold + source-derived route literals |
| `activity-v1.contract.json` | uint64 primitives, Activity JSON Schema verdicts, reducer snapshot/difference/notModified/frame/readStateUpdated behavior + a frozen actual stream (message→read→done→difference) | executed original uint64 + reducer + core + contract runner + ajv over the generated schema |
| `reaction-versions.contract.json` | reaction viewer/discussion version ordering (stale / duplicate / equal-version-different-payload) | source-derived invariants from the pinned web reducer + executed worked traces; verifier area `reaction.viewerVersion.stream` |
| (in `readstate-prefs-wire.contract.json`) | multi-event read stream incl. late-duplicate rejection | executed original ledger (`readStateStream`) |

## Feeding real Go wire (for the parent)

The Go side records its actual HTTP bodies/statuses (or reducer results) and
the reference suite re-executes the ORIGINAL TypeScript on the same inputs to
decide compatibility:

```bash
node server-go/tests/acceptance/m4-reference/run.mjs --verify go-samples.json
# exit 0 + "ok": true  -> compatible
```

Or programmatically: `import { verifyGoWireSamples } from
'../tests/acceptance/m4-reference/verify-go-wire.mjs'`.

`go-samples.json` is `{ "samples": [ ... ] }`. Each sample needs `id`, `area`,
and the Go observation:

### `message.create.body`
`input: { version: "v1"|"v2", body: <exact request body JSON> }`,
`goStatus: number`, `goErrorBody: {error, code?}` on failures,
`goOutput: <response JSON>` on 200. The original parser chain decides the
expected status/error-string/envelope and the sample must match byte-for-byte
on the error strings.

### `message.dto`
`input: { surface: "messageNew"|"enrichedUpdated"|"taskStatusUpdated"|"httpCreate" }`,
`goOutput: <message DTO>`. Checks: canonicalRequired presence+types, the
per-surface presence matrix, sealed keys (`agentSendKey`/`searchText`/
`searchVector`/`senderHandle`/`optimisticDisplaySeq`) never on the wire, and
`attachment.commentCount` stripped from shared frames.

### `message.page`
`goOutput: <GET /api/channels/:id/messages response>`. Checks the four envelope
keys, `messageWindow` identity (`schemaVersion:1`,
`domain:"receiver_visible_messages_v1"`, `receiverKind:"user"`) and the eight
inline coverage fields with their JSON types.

### `history.coverage`
`input: { scenarioId: <id from the contract's scenarios table> }`,
`goOutput: <the coverage object Go computed for that scenario>`. Byte-level
comparison against the frozen boundary table.

### `read.mutation`
`input: { body: <POST body> }`, `goStatus`, `goErrorBody`, `goOutput` (the
admitted mutation). Status mapping: `MUTATION_ID_PAYLOAD_MISMATCH`→409,
`SCOPE_NOT_FOUND`→404, parser errors→400, ADMITTED→201 (replays may 200).

### `read.state.event` / `read.receipt.hydrate` / `read.receipt.scopeUpdated` / `prefs.activityMute` / `prefs.activityMute.supported`
`input: { payload }` (or `{ channelType }`), `goOutput: <Go's normalized object
or null>`, and for `read.state.event` also `goAccepted`/`goOutcome`.

### `activity.ingress` / `activity.uint64`
`input: { candidate }` / `{ value }`, `goVerdict: "accept"|"reject"` /
`"valid"|"invalid"`. The real generated JSON Schema + original uint64 check.

### `reaction.viewerVersion.stream`
`input: { events: [{ op, viewerVersion, reactedEmojis }] }` — the Go side's
actual viewer-version sequence for ONE (principal, server, message). Enforces
the frozen original reducer rule (reactionReadModels.ts:387-401, pinned in
`reaction-versions.contract.json`): versions must never regress, and an
equal version must carry an identical canonical (sorted) payload. A
hash-derived version (repeat/decrease across add/remove/add) fails with
`stale` / `equal-version-different-payload`.

### `read.state.stream`
`input: { events: [<read/unread payloads in arrival order incl. LATE
duplicates>] }`, `goOutcomes: ["accepted"|"stale"|"corrupt-null", ...]` (same
length), `goFinal?: { maxReadSeq, readStateVersion }`. The ORIGINAL web
read-state ledger re-executes the whole stream and the Go per-step verdicts
and final effective frontier must match — this is the two-tabs +
late-response contract, executable.

### `activity.stream.digest`
`goOutput: { digest }`. Replays the frozen realistic ingress sequence
(`executed.actualStream.steps` in activity-v1.contract.json: baseline
snapshot → new-message frame → readStateUpdated advance → done tombstone)
through the ORIGINAL reducer and compares the canonical digest
(`{steps, finalState:{[scopeId]:state}, violations}`, same recipe as
`activity.reducer.run`). The Go side does not invent inputs: it folds the
frozen steps.

### `activity.reducer.run`
`input: { steps: [<ActivityIngress JSONs in order>] }`,
`goOutput: { digest }`. Go must fold the same steps with its reducer and
digest: `sha256(canonicalJson({ steps: <per-step outcomes>,
finalState: <state per scopeId>, violations: <drained records minus index> }))`
with `canonicalJson` = sorted object keys, arrays in order, bigint seqs as
decimal strings. The frozen `activity-v1.contract.json` carries worked
examples (`authoredSequences`) showing exact outcome/state shapes.

## Guarantees and limits

- All tests run under the repo's Node with no TS server, no PostgreSQL, no
  browser, no network. Dependencies resolved from the existing workspace
  (`ajv` and `typescript` via `packages/sync-core`).
- `history.coverage` and every `sourceDerived` block are the only
  non-executed contract content; they quote pinned bytes with anchors.
- Nothing here claims anything about the Go server until samples arrive.
