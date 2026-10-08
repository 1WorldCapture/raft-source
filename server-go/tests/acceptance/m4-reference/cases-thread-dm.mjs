// Area E — thread/DM wire: channel visibility + invite-list parsers, the
// shared name validator, the DM/thread route response-literal contract
// (source-derived), and the web DM-channel domain fold (executed).
import assert from 'node:assert/strict';
import { PINNED, readPinned, segmentOf } from './pinned-sources.mjs';

const host = (value) => JSON.parse(JSON.stringify(value));

function requireLiteral(segment, needle, label) {
  assert.ok(segment.includes(needle), `${label}: literal missing from pinned bytes: ${needle}`);
  const line = segment.slice(0, segment.indexOf(needle)).split('\n').length;
  return { value: needle, line };
}

export async function runThreadDmCases(mods) {
  const executed = {};

  // ---- parseChannelVisibility (executed) ----
  const CH = mods.channelsParsers;
  executed.parseChannelVisibility = [undefined, 'public', 'private', 'joint', 'PUBLIC', '', 'channels', 42, null].map(raw => ({
    inputPresent: raw !== undefined,
    input: raw === undefined ? null : raw,
    parsed: CH.parseChannelVisibility(raw),
  }));
  assert.equal(executed.parseChannelVisibility[0].parsed, 'public');
  assert.equal(CH.parseChannelVisibility('private'), 'private');
  assert.equal(CH.parseChannelVisibility('nope'), null);

  // ---- normalizeStringList (executed) ----
  executed.normalizeStringList = {
    dedupeTrimFilter: host(CH.normalizeStringList([' a ', '', 'b', 'a', 42, null])),
    notArray: host(CH.normalizeStringList('x')),
    withinCap: host(CH.normalizeStringList(['a', 'b'], 2)),
  };
  assert.deepEqual(executed.normalizeStringList.dedupeTrimFilter, ['a', 'b']);
  assert.deepEqual(executed.normalizeStringList.notArray, []);
  assert.throws(() => CH.normalizeStringList(['a', 'b', 'c'], 2), /maximum of 2 invited people/);
  executed.normalizeStringList.overCapThrows = 'A joint channel invite can include a maximum of ${maxItems} invited people per target server (thrown)';

  // ---- validateName (executed shared segment) ----
  const VN = mods.sharedValidateName;
  executed.validateName = [
    { name: 'general', label: 'Channel name' },
    { name: '  spaced  ', label: 'Channel name' },
    { name: '', label: 'Channel name' },
    { name: '   ', label: 'Channel name' },
    { name: 'x'.repeat(33), label: 'Channel name' },
    { name: '-leading', label: 'Channel name' },
    { name: 'has space', label: 'Channel name' },
    { name: '频道', label: 'Channel name' },
    { name: 'a_b-c9', label: 'Channel name' },
    { name: 'ab', label: 'Server name', minLength: 3 },
  ].map(({ name, label, minLength }) => ({
    name,
    reason: host(VN.validateNameReason(name, minLength)),
    message: VN.validateName(name, label, minLength),
  }));
  const [general, spaced, empty, blank, tooLong, leading, space, unicode, mixed, tooShortServer] = executed.validateName;
  assert.equal(general.message, null);
  assert.equal(spaced.message, null);
  assert.deepEqual(empty.reason, { code: 'required' });
  assert.deepEqual(blank.reason, { code: 'required' });
  assert.deepEqual(tooLong.reason, { code: 'tooLong', maxLength: 32 });
  assert.deepEqual(leading.reason, { code: 'pattern' });
  assert.deepEqual(space.reason, { code: 'pattern' });
  assert.equal(unicode.message, null); // \p{L} — a unicode letter may start a name
  assert.equal(mixed.message, null);
  assert.deepEqual(tooShortServer.reason, { code: 'tooShort', minLength: 3 });
  assert.equal(tooShortServer.message, 'Server name must be at least 3 characters');
  executed.nameRules = {
    regex: '^\\p{L}[\\p{L}\\p{N}_-]*$ (unicode)',
    minLength: VN.NAME_MIN_LENGTH,
    maxLength: VN.NAME_MAX_LENGTH,
  };

  // ---- DM/thread route contract (source-derived literals from pinned bytes) ----
  const channelsSource = await readPinned('serverChannelsRoute');
  const dmRoute = segmentOf(channelsSource, 'channelRouter.post("/dm",', '// Create channel', 'channels.dm.route');
  executed.dmRouteContract = {
    derivation: 'source-derived (handler is express/DB-bound; not executed)',
    sourceAnchor: `${PINNED.serverChannelsRoute.path} (sha256 ${PINNED.serverChannelsRoute.sha256})`,
    validation: {
      bothMissing: { status: 400, error: 'Either agentId or userId is required' },
      bothPresent: { status: 400, error: 'Cannot provide both agentId and userId' },
      guestCreate: { status: 403, error: 'Guests cannot create direct messages' },
      hiddenDirectoryTarget: { status: 404, error: 'DM target not found' },
      nonMemberTarget: { status: 400, error: 'User is not a member of this server' },
      guestTarget: { status: 403, error: 'Guests cannot be added to new direct messages' },
      agentNotFound: { status: 404, error: 'Agent not found in this server' },
    },
    selfDm: 'self-DM is always allowed (userId === req.userId bypasses directory/membership denials)',
    literals: {
      bothMissing: requireLiteral(dmRoute, 'Either agentId or userId is required', 'dm'),
      bothPresent: requireLiteral(dmRoute, 'Cannot provide both agentId and userId', 'dm'),
      agentNotFound: requireLiteral(dmRoute, 'Agent not found in this server', 'dm'),
    },
  };

  const threadRoute = segmentOf(
    channelsSource,
    'channelRouter.post("/:id/threads",',
    '// Get thread summaries for channel thread-parent messages.',
    'channels.threads.route',
  );
  executed.threadRouteContract = {
    derivation: 'source-derived (not executed)',
    validationOrder: [
      'parentMessageId must be a non-empty trimmed string -> 400 "parentMessageId is required"',
      'channel must exist on this server -> 404 CHANNEL_NOT_FOUND_BODY',
      'access checked BEFORE the nested-thread shape is described (no existence oracle for strangers)',
      'nested thread (channel.type === "thread") -> 400 "Cannot create a thread inside a thread"',
      'archived channel -> 409 { error: "This channel is archived", code: "channel_archived" }',
    ],
    optionalFirstReply: 'when content is a non-empty trimmed string the first reply is posted in the SAME request through broadcastAndDeliver',
    response: '{ threadChannelId, ...threadInfo }',
    literals: {
      parentRequired: requireLiteral(threadRoute, 'parentMessageId is required', 'thread'),
      nested: requireLiteral(threadRoute, 'Cannot create a thread inside a thread', 'thread'),
      archived: requireLiteral(threadRoute, '"This channel is archived", code: "channel_archived"', 'thread'),
    },
  };

  // POST / (create channel) sits between POST /dm and GET /joint-invites.
  const createSegment = segmentOf(
    channelsSource,
    '// Create channel\nchannelRouter.post("/",',
    'channelRouter.get("/joint-invites",',
    'channels.create.route',
  );
  executed.channelCreateContract = {
    derivation: 'source-derived (not executed)',
    reservedName: { status: 400, error: 'Channel name "all" is reserved', code: 'channel_name_reserved' },
    visibilityError: { status: 400, error: 'visibility must be one of: public, private, joint' },
    visibilityDefault: 'absent visibility parses to "public" (executed parser above)',
    literals: {
      reserved: requireLiteral(createSegment, 'Channel name "all" is reserved', 'create'),
      reservedCode: requireLiteral(createSegment, 'channel_name_reserved', 'create'),
      visibility: requireLiteral(createSegment, 'visibility must be one of: public, private, joint', 'create'),
    },
  };

  // ---- web DM/channel domain fold (executed) ----
  const CD = mods.webChannelDomain;
  const apiDm = (id, overrides = {}) => ({
    id, name: 'peer', type: 'dm', joined: true, lastMessageAt: '2026-10-02T00:00:00.000Z',
    readState: { kind: 'present', maxReadSeq: '9', readStateVersion: 4 }, // wire-only union
    ...overrides,
  });

  // toChannel drops the wire-only readState union AND lastMessageAt.
  const converted = CD.toChannel(apiDm('dm-1'), 'dm');
  executed.toChannelDropsWireOnly = {
    keys: host(Object.keys(converted).sort()),
    readStatePresent: 'readState' in converted,
    lastMessageAtPresent: 'lastMessageAt' in converted,
    type: converted.type,
  };
  assert.equal(executed.toChannelDropsWireOnly.readStatePresent, false);
  assert.equal(executed.toChannelDropsWireOnly.lastMessageAtPresent, false);
  assert.equal(executed.toChannelDropsWireOnly.type, 'dm');

  // hydrateDmChannels keeps server-unknown local-only DMs at the tail.
  const base = { channels: [], dmChannels: [{ id: 'dm-local', name: 'ghost', type: 'dm' }], channelActivity: {} };
  const hydrated = CD.hydrateDmChannels(base, [apiDm('dm-1'), apiDm('dm-2')]);
  executed.hydrateDm = {
    dmIds: host(hydrated.dmChannels.map(c => c.id)),
    activityKeys: host(Object.keys(hydrated.channelActivity).sort()),
  };
  assert.deepEqual(executed.hydrateDm.dmIds, ['dm-1', 'dm-2', 'dm-local']);
  assert.deepEqual(executed.hydrateDm.activityKeys, ['dm-1', 'dm-2']);

  // patchChannel upserts DMs into the dm bucket (never the channel list).
  const patchedExisting = CD.patchChannel(hydrated, { ...apiDm('dm-1'), lastMessageAt: '2026-10-03T00:00:00.000Z' });
  const patchedNew = CD.patchChannel(patchedExisting, apiDm('dm-3'));
  executed.patchDm = {
    existingUpdatedOrder: host(patchedExisting.dmChannels.map(c => c.id)),
    upsertKeepsSingle: patchedNew.dmChannels.filter(c => c.id === 'dm-1').length,
    appended: host(patchedNew.dmChannels.map(c => c.id)),
    channelsUntouched: patchedNew.channels.length,
    activityAdvanced: patchedNew.channelActivity['dm-1'],
  };
  assert.deepEqual(executed.patchDm.existingUpdatedOrder, ['dm-1', 'dm-2', 'dm-local']);
  assert.equal(executed.patchDm.upsertKeepsSingle, 1);
  assert.deepEqual(executed.patchDm.appended, ['dm-1', 'dm-2', 'dm-local', 'dm-3']);
  assert.equal(executed.patchDm.channelsUntouched, 0);
  assert.equal(executed.patchDm.activityAdvanced, '2026-10-03T00:00:00.000Z');

  // refreshExistingDm moves a known DM to the front; unknown is a no-op.
  const refreshed = CD.refreshExistingDm(patchedNew, 'dm-2', '2026-10-04T00:00:00.000Z');
  executed.refreshDm = {
    order: host(refreshed.dmChannels.map(c => c.id)),
    unknownIsIdentityNoop: CD.refreshExistingDm(refreshed, 'dm-ghost', 'x') === refreshed,
  };
  assert.deepEqual(executed.refreshDm.order, ['dm-2', 'dm-1', 'dm-local', 'dm-3']);
  assert.equal(executed.refreshDm.unknownIsIdentityNoop, true);

  return {
    area: 'thread-dm-wire',
    executed,
    assertions: 22,
  };
}
