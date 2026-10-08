// Integration API for the M4 parent/worker: compare REAL Go wire against the
// frozen contracts by re-executing the ORIGINAL TS parsers/validators on the
// Go side's own inputs.
//
// Programmatic:  import { verifyGoWireSamples } from './verify-go-wire.mjs';
// CLI:           node verify-go-wire.mjs samples.json
//
// A sample file is { samples: Sample[] }; each Sample is
//   { id, area, input?, goOutput, goStatus?, goErrorBody? }
// See server-go/contracts/m4/README.md for the per-area schema. No Go server,
// TS server, PostgreSQL or browser is involved: the Go side records its wire
// (body in / body out / status) and this file decides compatibility.
import { createRequire } from 'node:module';
import path from 'node:path';
import { repoRoot } from './pinned-sources.mjs';
import { loadOriginalModules, loadActivityJsonSchema } from './exec-original.mjs';
import { checkViewerVersionTrace } from './cases-reaction-versions.mjs';

const bigintSafeJson = (value) => JSON.stringify(
  value,
  (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner),
);

async function buildAjv() {
  const requireFromSyncCore = createRequire(path.join(repoRoot, 'packages/sync-core/package.json'));
  const Ajv2020 = requireFromSyncCore('ajv/dist/2020.js');
  const bundle = await loadActivityJsonSchema();
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  ajv.addSchema(bundle, 'activity-sync.schema.json');
  return {
    ingress: ajv.getSchema('ActivityIngress.json'),
    intent: ajv.getSchema('ActivityIntent.json'),
  };
}

const INTENT_TYPES = new Set(['ensureWindow', 'refresh', 'loadMore', 'markChannelReadAll', 'markInboxReadAll', 'markThreadDone', 'markInboxDone']);

export async function verifyGoWireSamples(sampleFile) {
  const samples = Array.isArray(sampleFile) ? sampleFile : sampleFile.samples;
  if (!Array.isArray(samples)) throw new Error('samples must be an array (or { samples: [...] })');
  const mods = await loadOriginalModules();
  const ajv = await buildAjv();
  const results = [];
  const failed = [];

  const fail = (sample, reason) => {
    results.push({ id: sample.id, area: sample.area, verdict: 'fail', reason });
    failed.push({ id: sample.id, area: sample.area, reason });
  };
  const pass = (sample, detail) => {
    results.push({ id: sample.id, area: sample.area, verdict: 'pass', ...(detail ? { detail } : {}) });
  };

  for (const sample of samples) {
    try {
      switch (sample.area) {
        // ---- message create (v1/v2) --------------------------------------
        case 'message.create.body': {
          const P = mods.messagesParsers;
          const body = sample.input?.body;
          const version = sample.input?.version ?? 'v1';
          const bodyVerdict = P.parseHumanMessageCreateBody(body);
          if (bodyVerdict === 'invalid') {
            if (sample.goStatus !== 400 || sample.goErrorBody?.error !== 'Invalid message request body') {
              fail(sample, `expected 400 "Invalid message request body", got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
            break;
          }
          const randomId = P.parseRandomId(body?.randomId);
          if (typeof randomId !== 'string' && randomId !== undefined) {
            const expectedError = `randomId must be a non-empty string with at most ${P.MAX_RANDOM_ID_LENGTH} characters`;
            if (sample.goStatus !== 400 || sample.goErrorBody?.error !== expectedError) {
              fail(sample, `expected 400 "${expectedError}", got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
            break;
          }
          const mentions = P.parseStructuredMentions(body?.mentions);
          if (mentions === 'invalid') {
            if (sample.goStatus !== 400 || sample.goErrorBody?.error !== 'Invalid mentions payload') {
              fail(sample, `expected 400 "Invalid mentions payload", got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
            break;
          }
          const content = body?.content;
          if (typeof content !== 'string' || content.trim().length === 0) {
            if (sample.goStatus !== 400 || sample.goErrorBody?.error !== 'Message content cannot be empty') {
              fail(sample, `expected 400 "Message content cannot be empty", got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
            break;
          }
          if (content.length > P.MAX_MESSAGE_LENGTH) {
            const expectedError = `Message content exceeds maximum length of ${P.MAX_MESSAGE_LENGTH} characters`;
            if (sample.goStatus !== 400 || sample.goErrorBody?.error !== expectedError) {
              fail(sample, `expected 400 "${expectedError}", got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
            break;
          }
          // Success: freeze the envelope shape per contract version.
          if (sample.goStatus !== 200 || typeof sample.goOutput !== 'object' || sample.goOutput === null) {
            fail(sample, 'original parsers accept this body; expected Go 200 with a JSON object');
            break;
          }
          const wrapped = 'message' in sample.goOutput;
          if (version === 'v2' && !wrapped) {
            fail(sample, 'v2 success must wrap as { message, ... }');
            break;
          }
          if (version === 'v1' && wrapped && !('pendingMentionActions' in sample.goOutput)) {
            fail(sample, 'v1 success must be the bare message row (only pendingMentionActions may wrap it)');
            break;
          }
          const message = wrapped ? sample.goOutput.message : sample.goOutput;
          if (typeof message?.id !== 'string' || typeof message?.seq !== 'number') {
            fail(sample, 'response message row must carry id (string) and seq (number)');
            break;
          }
          if (Array.isArray(body?.mentions) && JSON.stringify(message.mentions ?? null) !== JSON.stringify(mentions.length === 0 ? null : mentions)) {
            // mentions may legitimately be absent when empty
            if (!(mentions.length === 0 && message.mentions === undefined)) {
              fail(sample, 'echoed mentions must equal the parsed structured mentions (trimmed, deduped)');
              break;
            }
          }
          pass(sample);
          break;
        }

        // ---- canonical message DTO surfaces ------------------------------
        case 'message.dto': {
          const M = mods.canonicalManifest;
          const surface = sample.input?.surface;
          const message = sample.goOutput;
          if (!['messageNew', 'enrichedUpdated', 'taskStatusUpdated', 'httpCreate'].includes(surface)) {
            fail(sample, `unknown surface ${surface}`);
            break;
          }
          if (!message || typeof message !== 'object') {
            fail(sample, 'goOutput must be the message DTO object');
            break;
          }
          const byName = Object.fromEntries(M.CANONICAL_MESSAGE_FIELD_DESCRIPTORS.map(f => [f.name, f]));
          for (const field of M.CANONICAL_REQUIRED_MESSAGE_FIELDS) {
            if (!(field in message)) {
              fail(sample, `canonicalRequired field missing: ${field}`);
              break;
            }
            const descriptor = byName[field];
            const value = message[field];
            const expectedType = descriptor.wireType === 'number' ? 'number' : 'string';
            if (descriptor.nullable) {
              if (value !== null && typeof value !== expectedType) {
                fail(sample, `field ${field}: expected ${expectedType}|null, got ${typeof value}`);
                break;
              }
            } else if (typeof value !== expectedType) {
              fail(sample, `field ${field}: expected ${expectedType}, got ${typeof value}`);
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          if (surface !== 'httpCreate') {
            for (const [name, descriptor] of Object.entries(byName)) {
              if (descriptor.presence[surface] === 'absent' && name in message) {
                fail(sample, `field ${name} must be ABSENT on ${surface} (presence matrix)`);
                break;
              }
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          const banned = [
            ...M.CANONICAL_MESSAGE_EXCLUSIONS.storageOnlySealed.fields,
            ...M.CANONICAL_MESSAGE_EXCLUSIONS.clientOnly.fields,
            'senderHandle',
          ];
          for (const key of banned) {
            if (key in message) {
              fail(sample, `sealed/storage-only key on wire: ${key}`);
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          for (const attachment of message.attachments ?? []) {
            if ('commentCount' in attachment) {
              fail(sample, 'viewer-scoped attachment.commentCount must be stripped from shared frames');
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          if (sample.input?.surface === 'messageNew' && message.commentRef !== undefined && message.commentRef === null) {
            // allowed on the wire; the FOLD preserves — informational only
          }
          pass(sample, `canonical DTO valid for surface ${surface}`);
          break;
        }

        // ---- message page envelope + coverage shapes ----------------------
        case 'message.page': {
          const page = sample.goOutput;
          for (const key of ['messages', 'threadSummariesByParentMessageId', 'historyLimited', 'messageWindow']) {
            if (!(key in page)) {
              fail(sample, `message page envelope missing key: ${key}`);
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          const window = page.messageWindow;
          if (window.schemaVersion !== 1 || window.domain !== 'receiver_visible_messages_v1' || window.receiverKind !== 'user') {
            fail(sample, 'messageWindow identity mismatch (schemaVersion/domain/receiverKind)');
            break;
          }
          for (const key of ['coveredAfterSeq', 'coveredFromSeq', 'coveredThroughSeq', 'remoteHighWaterSeq', 'hasGap', 'hasNewer', 'completeThroughLatest']) {
            if (!(key in window)) {
              fail(sample, `messageWindow missing coverage field: ${key}`);
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          for (const key of ['coveredAfterSeq', 'coveredFromSeq', 'coveredThroughSeq', 'remoteHighWaterSeq']) {
            if (!Number.isSafeInteger(window[key])) {
              fail(sample, `coverage field ${key} must be a safe integer`);
              break;
            }
          }
          if (failed.some(f => f.id === sample.id)) break;
          if (typeof window.hasGap !== 'boolean' || typeof window.hasNewer !== 'boolean' || typeof window.completeThroughLatest !== 'boolean') {
            fail(sample, 'hasGap/hasNewer/completeThroughLatest must be booleans');
            break;
          }
          if (!Array.isArray(page.messages)) {
            fail(sample, 'messages must be an array');
            break;
          }
          pass(sample);
          break;
        }

        case 'history.coverage': {
          const { scenarioId } = sample.input;
          const contract = JSON.parse(await (await import('node:fs/promises')).readFile(
            path.join(repoRoot, 'server-go/contracts/m4/history-coverage.contract.json'), 'utf8',
          ));
          const scenario = contract.scenarios.find(s => s.id === scenarioId);
          if (!scenario) {
            fail(sample, `unknown scenarioId ${scenarioId}`);
            break;
          }
          const diffs = [];
          for (const [field, expected] of Object.entries(scenario.expected)) {
            if (sample.goOutput[field] !== expected) {
              diffs.push(`${field}: go=${JSON.stringify(sample.goOutput[field])} expected=${JSON.stringify(expected)}`);
            }
          }
          if (diffs.length) fail(sample, `coverage mismatch for ${scenarioId}: ${diffs.join('; ')}`);
          else pass(sample, `coverage matches scenario ${scenarioId}`);
          break;
        }

        // ---- read mutations ------------------------------------------------
        case 'read.mutation': {
          const RM = mods.readMutationParser;
          try {
            const parsed = RM.parsePayload(sample.input?.body);
            const expectedStatus = 201; // ADMITTED path (replay outcomes may be 200)
            if (![200, 201].includes(sample.goStatus)) {
              fail(sample, `original parser accepts; expected Go 200/201, got ${sample.goStatus}`);
              break;
            }
            if (bigintSafeJson(parsed.mutation) !== bigintSafeJson(sample.goOutput?.mutation ?? sample.goOutput)) {
              fail(sample, `mutation mismatch: original=${bigintSafeJson(parsed.mutation)} go=${bigintSafeJson(sample.goOutput)}`);
              break;
            }
            pass(sample);
          } catch (error) {
            const statusByCode = { MUTATION_ID_PAYLOAD_MISMATCH: 409, SCOPE_NOT_FOUND: 404 };
            const expectedStatus = statusByCode[error.code] ?? 400;
            if (sample.goStatus !== expectedStatus || sample.goErrorBody?.code !== error.code) {
              fail(sample, `expected ${expectedStatus} code=${error.code}, got ${sample.goStatus} ${JSON.stringify(sample.goErrorBody)}`);
              break;
            }
            pass(sample);
          }
          break;
        }

        // ---- read-state / receipt / prefs events ---------------------------
        case 'read.state.event': {
          const RS = mods.webReadStateSync;
          RS.resetReadStateSyncForTests();
          const normalized = RS.normalizeReadStateUpdated(sample.input?.payload);
          if (normalized === null) {
            if (sample.goAccepted !== false) fail(sample, 'original normalizer rejects this payload; Go must drop it (not accept, not partially apply)');
            else pass(sample, 'corrupt payload correctly dropped');
            break;
          }
          const outcome = RS.consumeReadStateUpdate(normalized);
          if (sample.goAccepted !== true || sample.goOutcome !== outcome) {
            fail(sample, `original fold says ${outcome}; Go reported accepted=${sample.goAccepted} outcome=${sample.goOutcome}`);
            break;
          }
          pass(sample, outcome);
          break;
        }

        case 'read.receipt.hydrate': {
          const RR = mods.webReadReceipt;
          const normalized = RR.normalizeReadReceiptHydrate(sample.input?.payload);
          if (bigintSafeJson(normalized) !== bigintSafeJson(sample.goOutput ?? null)) {
            fail(sample, `normalize mismatch: original=${bigintSafeJson(normalized)} go=${bigintSafeJson(sample.goOutput)}`);
            break;
          }
          pass(sample);
          break;
        }

        case 'read.receipt.scopeUpdated': {
          const RR = mods.webReadReceipt;
          const normalized = RR.normalizeScopeReadUpdated(sample.input?.payload);
          if (bigintSafeJson(normalized) !== bigintSafeJson(sample.goOutput ?? null)) {
            fail(sample, `normalize mismatch: original=${bigintSafeJson(normalized)} go=${bigintSafeJson(sample.goOutput)}`);
            break;
          }
          pass(sample);
          break;
        }

        case 'prefs.activityMute': {
          const CD = mods.webChannelDomain;
          const normalized = CD.normalizeActivityMuteState(sample.input?.payload);
          if (bigintSafeJson(normalized) !== bigintSafeJson(sample.goOutput)) {
            fail(sample, `mute state mismatch: original=${bigintSafeJson(normalized)} go=${bigintSafeJson(sample.goOutput)}`);
            break;
          }
          pass(sample);
          break;
        }

        case 'prefs.activityMute.supported': {
          const supported = mods.sharedActivityMute.channelTypeSupportsActivityMute(sample.input?.channelType);
          if (supported !== sample.goOutput) {
            fail(sample, `eligibility mismatch for ${sample.input?.channelType}: original=${supported} go=${sample.goOutput}`);
            break;
          }
          pass(sample);
          break;
        }

        // ---- Activity ingress (schema + uint64) -----------------------------
        case 'activity.ingress': {
          const candidate = sample.input?.candidate;
          const validate = INTENT_TYPES.has(candidate?.type) ? ajv.intent : ajv.ingress;
          const verdict = validate(candidate) ? 'accept' : 'reject';
          if (verdict !== sample.goVerdict) {
            const firstError = validate.errors?.[0] ? `${validate.errors[0].instancePath} ${validate.errors[0].message}` : '';
            fail(sample, `schema verdict mismatch: original=${verdict} go=${sample.goVerdict} (${firstError})`);
            break;
          }
          pass(sample, verdict);
          break;
        }

        case 'activity.uint64': {
          const verdict = mods.uint64.isUInt64String(sample.input?.value) ? 'valid' : 'invalid';
          if (verdict !== sample.goVerdict) {
            fail(sample, `uint64 verdict mismatch for ${JSON.stringify(sample.input?.value)}: original=${verdict} go=${sample.goVerdict}`);
            break;
          }
          pass(sample, verdict);
          break;
        }

        // ---- Activity reducer differential ---------------------------------
        case 'activity.reducer.run': {
          const R = mods.activityRunner;
          const core = mods.createActivitySyncCore();
          const steps = sample.input?.steps ?? [];
          const outcomes = [];
          for (const step of steps) {
            outcomes.push(R.applyStep(core, step));
          }
          const scopeIds = new Set(steps.map(step => R.scopeIdOf(step)));
          const finalState = {};
          for (const id of [...scopeIds].sort()) finalState[id] = core.state('activity', id) ?? null;
          const originalDigest = R.sha256Hex(R.canonicalJson({
            steps: outcomes.map(o => JSON.parse(bigintSafeJson(o))),
            finalState: JSON.parse(bigintSafeJson(finalState)),
            violations: JSON.parse(bigintSafeJson(core.violations().records.map(({ index, ...rest }) => rest))),
          }));
          if (sample.goOutput?.digest !== originalDigest) {
            fail(sample, `reducer digest mismatch: original=${originalDigest} go=${sample.goOutput?.digest} (re-run the same steps and canonicalJson the same fields on the Go side; see contracts/m4/README.md)`);
            break;
          }
          pass(sample, originalDigest);
          break;
        }

        // ---- reaction viewer-version ordering (pinned original rule) -------
        case 'reaction.viewerVersion.stream': {
          const events = sample.input?.events;
          if (!Array.isArray(events) || events.length === 0) {
            fail(sample, 'input.events must be a non-empty array of {viewerVersion, reactedEmojis}');
            break;
          }
          const violations = checkViewerVersionTrace(events);
          if (violations.length > 0) {
            fail(sample, `viewer-version drift vs the frozen original reducer rule: ${violations.map(v => `step ${v.index} (${v.op}) ${v.kind}: ${v.detail}`).join('; ')}`);
            break;
          }
          pass(sample, `${events.length} events, versions strictly ordered, equal-version payloads identical`);
          break;
        }

        // ---- real read stream (executed original ledger) --------------------
        case 'read.state.stream': {
          const RS = mods.webReadStateSync;
          RS.resetReadStateSyncForTests();
          const events = sample.input?.events ?? [];
          const goOutcomes = sample.goOutcomes ?? [];
          if (goOutcomes.length !== events.length) {
            fail(sample, `goOutcomes length ${goOutcomes.length} != events length ${events.length}`);
            break;
          }
          const diffs = [];
          for (const [index, payload] of events.entries()) {
            const normalized = RS.normalizeReadStateUpdated(payload);
            const expected = normalized === null ? 'corrupt-null' : RS.consumeReadStateUpdate(normalized);
            if (goOutcomes[index] !== expected) {
              diffs.push(`step ${index}: original=${expected} go=${goOutcomes[index]}`);
            }
          }
          if (diffs.length) {
            fail(sample, `read-stream divergence: ${diffs.join('; ')}`);
            break;
          }
          if (sample.goFinal !== undefined) {
            const final = RS.getAcceptedReadState(
              events[0]?.payload?.serverId ?? events[0]?.serverId,
              events[0]?.payload?.scopeId ?? events[0]?.scopeId,
            );
            const goFinal = sample.goFinal;
            if (goFinal?.maxReadSeq !== final?.maxReadSeq || goFinal?.readStateVersion !== final?.readStateVersion) {
              fail(sample, `final frontier mismatch: original=${JSON.stringify(final)} go=${JSON.stringify(goFinal)}`);
              break;
            }
          }
          pass(sample, `${events.length}-event stream matches the original ledger`);
          break;
        }

        // ---- frozen actual Activity stream digest ----------------------------
        case 'activity.stream.digest': {
          const contract = JSON.parse(await (await import('node:fs/promises')).readFile(
            path.join(repoRoot, 'server-go/contracts/m4/activity-v1.contract.json'), 'utf8',
          ));
          const stream = contract.executed.actualStream;
          if (!stream?.steps) {
            fail(sample, 'frozen actualStream missing from activity-v1.contract.json; regenerate contracts');
            break;
          }
          const R = mods.activityRunner;
          const core = mods.createActivitySyncCore();
          const outcomes = stream.steps.map(step => JSON.parse(bigintSafeJson(R.applyStep(core, step))));
          const scopeIds = new Set(stream.steps.map(step => R.scopeIdOf(step)));
          const finalState = {};
          for (const id of [...scopeIds].sort()) {
            finalState[id] = JSON.parse(bigintSafeJson(core.state('activity', id) ?? null));
          }
          const digest = R.sha256Hex(R.canonicalJson({
            steps: outcomes,
            finalState,
            violations: JSON.parse(bigintSafeJson(core.violations().records.map(({ index, ...rest }) => rest))),
          }));
          if (sample.goOutput?.digest !== digest) {
            fail(sample, `actual-stream digest mismatch: original=${digest} go=${sample.goOutput?.digest} (replay the frozen steps in contracts/m4/activity-v1.contract.json executed.actualStream.steps)`);
            break;
          }
          pass(sample, digest);
          break;
        }

        default:
          fail(sample, `unknown area: ${sample.area}`);
      }
    } catch (error) {
      fail(sample, `verifier error: ${error.message}`);
    }
  }

  return {
    ok: failed.length === 0,
    total: samples.length,
    passed: samples.length - failed.length,
    failed,
    results,
  };
}

// CLI entry.
if (process.argv[1] && (process.argv[1].endsWith('verify-go-wire.mjs'))) {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('usage: node verify-go-wire.mjs <samples.json>\n');
    process.exit(2);
  }
  const { readFile } = await import('node:fs/promises');
  const samples = JSON.parse(await readFile(file, 'utf8'));
  const report = await verifyGoWireSamples(samples);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
