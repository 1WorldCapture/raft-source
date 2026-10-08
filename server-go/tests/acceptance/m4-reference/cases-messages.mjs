// Area A — message v1/v2 wire: body parsers, mentions, randomId, page cursors,
// reaction emoji/limits, plus the v1-vs-v2 envelope/error-literal contract.
//
// Everything under `executed` runs the ORIGINAL parser functions from pinned
// messages.ts bytes. The `sourceDerived` block quotes exact response literals
// extracted from the same pinned bytes (route handlers are express/DB-bound and
// cannot be executed here; the literals are pulled out mechanically with
// anchors, never retyped by hand).
import assert from 'node:assert/strict';
import { PINNED, readPinned, segmentOf } from './pinned-sources.mjs';

const UUID = '0b2a6f3e-9c1d-4e7b-8f2a-1c3b5d7e9a01';
const UUID2 = '1c3b5d7e-9a01-4e7b-8f2a-0b2a6f3e-9c1d'.slice(0, 36); // second distinct uuid
const UUID_B = '3f8d1a2b-7c4e-49d6-b0a1-2e5f6a7b8c9d';

function randomIdVerdict(value) {
  if (value === undefined) return 'absent';
  if (typeof value === 'string') return 'valid';
  return 'invalid';
}

// Mechanically extract an exact response literal from the pinned route bytes so
// the frozen contract can never drift from the source by retyping.
function extractLiteral(source, needle, anchor) {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `literal not found in pinned source: ${needle}`);
  const line = source.slice(0, at).split('\n').length;
  return { value: needle.replace('${MAX_RANDOM_ID_LENGTH}', '128').replace('${MAX_MESSAGE_LENGTH}', '32000'), anchor: `${anchor}:${line}` };
}

export async function runMessagesCases(mods) {
  const P = mods.messagesParsers;
  const executed = {};

  // ---- parseHumanMessageCreateBody ----
  const bodyCases = [
    { label: 'valid-minimal', body: { channelId: UUID, content: 'hi' } },
    { label: 'valid-full', body: { channelId: UUID, content: 'hi', attachmentIds: [UUID_B], asTask: true } },
    { label: 'valid-asTask-false-explicit', body: { channelId: UUID, content: 'hi', asTask: false } },
    { label: 'valid-uppercase-uuid', body: { channelId: UUID.toUpperCase(), content: 'x' } },
    { label: 'null-body', body: null },
    { label: 'array-body', body: [UUID] },
    { label: 'string-body', body: 'x' },
    { label: 'channelId-missing', body: { content: 'hi' } },
    { label: 'channelId-non-string', body: { channelId: 42, content: 'hi' } },
    { label: 'channelId-non-uuid', body: { channelId: 'not-a-uuid', content: 'hi' } },
    { label: 'attachmentIds-valid', body: { channelId: UUID, content: 'hi', attachmentIds: [UUID, UUID_B] } },
    { label: 'attachmentIds-not-array', body: { channelId: UUID, content: 'hi', attachmentIds: 'x' } },
    { label: 'attachmentIds-non-string-item', body: { channelId: UUID, content: 'hi', attachmentIds: [42] } },
    { label: 'attachmentIds-non-uuid-item', body: { channelId: UUID, content: 'hi', attachmentIds: ['nope'] } },
    { label: 'asTask-non-boolean', body: { channelId: UUID, content: 'hi', asTask: 'yes' } },
    { label: 'attachmentIds-empty-array', body: { channelId: UUID, content: 'hi', attachmentIds: [] } },
  ];
  executed.parseHumanMessageCreateBody = bodyCases.map(({ label, body }) => {
    const out = P.parseHumanMessageCreateBody(body);
    return { label, input: body, verdict: out === 'invalid' ? 'invalid' : 'valid', parsed: out === 'invalid' ? null : out };
  });
  assert.equal(executed.parseHumanMessageCreateBody.filter(c => c.verdict === 'valid').length, 6);

  // ---- parseRandomId ----
  const randomIdInputs = [undefined, 'abc-123', '', 'x'.repeat(129), 'x'.repeat(128), 42, null, true];
  executed.parseRandomId = randomIdInputs.map(value => {
    const out = P.parseRandomId(value);
    return { input: value === undefined ? null : value, inputPresent: value !== undefined, verdict: randomIdVerdict(out), parsed: typeof out === 'string' ? out : null };
  });
  const byVerdict = Object.groupBy(executed.parseRandomId, c => c.verdict);
  // valid: 'abc-123' and the 128-char id; invalid: '', 129 chars, 42, null, true.
  assert.equal(byVerdict.absent.length, 1);
  assert.equal(byVerdict.valid.length, 2);
  assert.equal(byVerdict.invalid.length, 5);

  // ---- parseStructuredMentions ----
  const mentionCases = [
    { label: 'absent', value: undefined },
    { label: 'empty-array', value: [] },
    { label: 'user-valid', value: [{ type: 'user', id: UUID, name: 'Ada' }] },
    { label: 'agent-valid-name-trimmed', value: [{ type: 'agent', id: UUID_B, name: '  Bot  ' }] },
    { label: 'mixed-valid', value: [
      { type: 'user', id: UUID, name: 'Ada' },
      { type: 'agent', id: UUID_B, name: 'Bot' },
    ] },
    { label: 'duplicate-exact-deduped', value: [
      { type: 'user', id: UUID, name: 'Ada' },
      { type: 'user', id: UUID, name: 'Ada' },
    ] },
    { label: 'same-id-different-type-kept', value: [
      { type: 'user', id: UUID, name: 'A' },
      { type: 'agent', id: UUID, name: 'A' },
    ] },
    { label: 'same-id-different-name-kept', value: [
      { type: 'user', id: UUID, name: 'A' },
      { type: 'user', id: UUID, name: 'B' },
    ] },
    { label: 'trim-collapses-duplicates', value: [
      { type: 'user', id: UUID, name: ' Ada ' },
      { type: 'user', id: UUID, name: 'Ada' },
    ] },
    { label: 'type-team-invalid', value: [{ type: 'team', id: UUID, name: 'X' }] },
    { label: 'type-missing-invalid', value: [{ id: UUID, name: 'X' }] },
    { label: 'id-non-uuid', value: [{ type: 'user', id: 'abc', name: 'X' }] },
    { label: 'id-non-string', value: [{ type: 'user', id: 42, name: 'X' }] },
    { label: 'name-empty', value: [{ type: 'user', id: UUID, name: '' }] },
    { label: 'name-whitespace-only', value: [{ type: 'user', id: UUID, name: '   ' }] },
    { label: 'name-129', value: [{ type: 'user', id: UUID, name: 'x'.repeat(129) }] },
    { label: 'name-128-valid', value: [{ type: 'user', id: UUID, name: 'x'.repeat(128) }] },
    { label: 'value-not-array', value: 'nope' },
    { label: 'item-null', value: [null] },
    { label: 'item-string', value: ['user'] },
  ];
  executed.parseStructuredMentions = mentionCases.map(({ label, value }) => {
    const out = P.parseStructuredMentions(value);
    return { label, input: value === undefined ? null : value, inputPresent: value !== undefined, verdict: out === 'invalid' ? 'invalid' : 'valid', parsed: out === 'invalid' ? null : out };
  });
  const mentions = Object.groupBy(executed.parseStructuredMentions, c => c.verdict);
  // NOTE: an ABSENT mentions key parses to [] (valid), matching the original
  // parser's explicit `if (value === undefined) return []`.
  assert.equal(mentions.valid.length, 10);
  assert.equal(mentions.invalid.length, 10);
  const trimmed = executed.parseStructuredMentions.find(c => c.label === 'agent-valid-name-trimmed');
  assert.equal(trimmed.parsed[0].name, 'Bot');
  assert.equal(executed.parseStructuredMentions.find(c => c.label === 'trim-collapses-duplicates').parsed.length, 1);
  assert.equal(executed.parseStructuredMentions.find(c => c.label === 'same-id-different-type-kept').parsed.length, 2);

  // ---- parseReactionEmoji / parseReactionActorPageLimit / parseMessagePageCursor ----
  executed.parseReactionEmoji = [
    '👍', ' 👍 ', '', '   ', 'x'.repeat(16), 'x'.repeat(17), 'a b', 42, '👍👎',
  ].map(value => ({ input: typeof value === 'string' && value === '' ? '' : value, parsed: P.parseReactionEmoji(value) }));
  assert.equal(executed.parseReactionEmoji.filter(c => c.parsed === null).length, 5);
  assert.equal(P.parseReactionEmoji(' 👍 '), '👍');

  executed.parseReactionActorPageLimit = [
    undefined, '1', '100', '0', '101', 'abc', '50', 50, '1.5',
  ].map(value => ({ inputPresent: value !== undefined, input: value ?? null, parsed: P.parseReactionActorPageLimit(value) }));
  assert.equal(executed.parseReactionActorPageLimit[0].parsed, 50);
  // nulls: '0', '101', 'abc', bare number 50, '1.5'.
  assert.equal(executed.parseReactionActorPageLimit.filter(c => c.parsed === null).length, 5);

  executed.parseMessagePageCursor = [
    undefined, '0', '42', '-1', 'abc', '1.5', '9007199254740992', '9007199254740993', '01', 42,
  ].map(value => {
    const out = P.parseMessagePageCursor(value);
    return {
      inputPresent: value !== undefined,
      input: value ?? null,
      verdict: out === 'invalid' ? 'invalid' : out === undefined ? 'absent' : 'valid',
      parsed: typeof out === 'number' ? out : null,
    };
  });
  // "01" matches ^\d+$ and Number("01") is a safe integer, so the original
  // parser ACCEPTS it as cursor 1 — a Go port must not "fix" this.
  assert.equal(executed.parseMessagePageCursor.find(c => c.input === '01').verdict, 'valid');
  assert.equal(executed.parseMessagePageCursor.find(c => c.input === '9007199254740993').verdict, 'invalid');

  // ---- constants executed out of the original segment ----
  executed.constants = {
    MAX_MESSAGE_LENGTH: P.MAX_MESSAGE_LENGTH,
    MAX_RANDOM_ID_LENGTH: P.MAX_RANDOM_ID_LENGTH,
    MAX_REACTION_LENGTH: P.MAX_REACTION_LENGTH,
  };
  assert.equal(P.MAX_MESSAGE_LENGTH, 32000);
  assert.equal(P.MAX_RANDOM_ID_LENGTH, 128);
  assert.equal(P.MAX_REACTION_LENGTH, 16);
  assert.equal(P.UUID_RE.test(UUID), true);
  assert.equal(P.UUID_RE.test('nope'), false);

  // ---- source-derived response literals (extracted, not retyped) ----
  const source = await readPinned('serverMessagesRoute');
  const createHumanSegment = segmentOf(
    source,
    'async function createHumanMessage(',
    'messageRouter.post("/", (req, res) => createHumanMessage(req, res, "v1"));',
    'messages.createHumanMessage',
  );
  const literals = {
    invalidBody: extractLiteral(createHumanSegment, 'Invalid message request body', 'messages.ts:createHumanMessage'),
    randomIdTooLong: extractLiteral(createHumanSegment, 'randomId must be a non-empty string with at most ${MAX_RANDOM_ID_LENGTH} characters', 'messages.ts:createHumanMessage'),
    invalidMentions: extractLiteral(createHumanSegment, 'Invalid mentions payload', 'messages.ts:createHumanMessage'),
    channelIdContentRequired: extractLiteral(createHumanSegment, 'Channel ID and content are required', 'messages.ts:createHumanMessage'),
    contentEmpty: extractLiteral(createHumanSegment, 'Message content cannot be empty', 'messages.ts:createHumanMessage'),
    contentTooLong: extractLiteral(createHumanSegment, 'Message content exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters', 'messages.ts:createHumanMessage'),
  };
  assert.equal(literals.randomIdTooLong.value, 'randomId must be a non-empty string with at most 128 characters');
  assert.equal(literals.contentTooLong.value, 'Message content exceeds maximum length of 32000 characters');

  // The v1/v2 fork is a boolean threaded into the SAME handler; freeze what
  // each contract version does at the response boundary, as evidenced by the
  // branch structure of the pinned segment.
  const sourceDerived = {
    derivation: 'source-derived (route handler is express/DB-bound; not executed)',
    sourceAnchor: `${PINNED.serverMessagesRoute.path} (sha256 ${PINNED.serverMessagesRoute.sha256})`,
    envelopeV1: {
      success: 'bare enriched message row (the message DTO itself)',
      successWithPendingMentionActions: { message: 'enriched message', pendingMentionActions: 'non-empty array' },
      mentionValidationErrorBody: { error: 'error string only (no code key on v1)' },
      randomIdConflict: { status: 'from error (409 family)', body: { error: 'string', code: 'string' } },
    },
    envelopeV2: {
      success: { message: 'enriched message', pendingMentionActions: 'present only when non-empty', unresolvedMentionHandles: 'present only when non-empty' },
      mentionValidationErrorBody: { error: 'string', code: 'present when error carries one' },
    },
    responseErrorLiterals: literals,
    validationOrder: [
      'parseHumanMessageCreateBody -> 400 invalidBody',
      'parseRandomId -> 400 randomIdTooLong',
      'parseStructuredMentions -> 400 invalidMentions',
      'channelId/content presence -> 400 channelIdContentRequired',
      'content type/trim -> 400 contentEmpty',
      'content length -> 400 contentTooLong',
    ],
  };

  return {
    area: 'messages-wire',
    executed,
    sourceDerived,
    assertions: 24,
  };
}
