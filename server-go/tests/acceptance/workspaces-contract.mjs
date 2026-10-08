// M2 HTTP black-box acceptance. Uses real signup/mail/profile flows against
// an isolated Go process; no fixture tokens, client modifications or TS server.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const recordFields = ['id', 'name', 'avatarUrl', 'slug', 'kind', 'ownerId', 'onboardingAgentId', 'agentAllChannelGreetingEnabled', 'hideHumansFromMembers', 'publiclyVisible', 'plan', 'translationEnabled', 'progressAnnouncementsEnabled', 'planDowngradedAt', 'deletedAt', 'createdAt', 'updatedAt'];
export const listFields = ['id', 'name', 'avatarUrl', 'slug', 'ownerId', 'onboardingAgentId', 'hideHumansFromMembers', 'plan', 'planDowngradedAt', 'role', 'serverPushMuted', 'createdAt', 'serverOrderVersion', 'messageHistoryDays', 'historyCutoff'];
export const onboardFields = ['onboardingAgentId', 'agentAllChannelGreetingEnabled', 'onboardingWizardEnabled', 'setupModalReminderOptOut', 'onboardingReminderOptOut', 'dismissedAddComputerStepAt', 'dismissedCreateAgentStepAt', 'dismissedInviteStepAt', 'dismissedCommunityStepAt', 'dismissedNotificationStepAt', 'onboardingWizardCurrentStep', 'onboardingDmSentAt', 'onboardingDmSentByAgentId'];
export const sidebarFields = ['channelOrder', 'agentOrder', 'dmOrder', 'channelSortMode', 'jointChannelSortMode', 'dmSortMode', 'pinnedSortMode', 'pinned', 'pinnedChannelIds', 'pinnedAgentIds', 'pinnedOrder', 'hiddenDmIds', 'channelPanelTabOrder', 'agentPanelTabOrder', 'customSections', 'sectionOrder', 'sectionPlacements', 'sectionsVersion', 'pinnedVersion'];
export const initialProjection = {
  surface: 'computer_runtime', phase: 'not_started', currentStep: 'computer_runtime',
  blocksChat: true, allowedExits: ['reset', 'return_to_server'],
  sideEffectState: { transitions: 'enabled', completion: 'disabled' },
  gateReason: 'computer_offline', computerStatus: 'offline', runtimeStatus: 'unknown',
  runtimeOptions: [], hasConnectedComputer: false, offlineComputers: [],
  postSetup: { surveyPending: false, handoffPending: false },
};
const isoMillis = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function httpClient(origin) {
  const parsed = new URL(origin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) throw new Error('Workspace tests require an isolated loopback instance.');
  return async (route, { method = 'GET', body, token, server, headers = {} } = {}) => {
    const multipart = body instanceof FormData;
    const response = await fetch(new URL(route, origin), {
      method, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {
        ...(body === undefined || multipart ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(server === undefined ? {} : { 'X-Server-Id': server }), ...headers,
      },
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, data, headers: response.headers };
  };
}
export function expectStatus(result, expected, context) {
  assert.equal(result.status, expected, `${context}: HTTP status (response bodies and credentials intentionally omitted)`);
}
export function exactKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
async function findMailToken(maildir, email) {
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const item of await readdir(maildir, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const text = await readFile(path.join(maildir, item.name), 'utf8');
      if (!text.includes(email)) continue;
      const decoded = text.replaceAll('\\u0026', '&').replaceAll('=3D', '=').replaceAll('\\/', '/');
      const token = decoded.match(/[?&]verify=([A-Za-z0-9._~-]+)/)?.[1];
      if (token) return token;
    }
    await sleep(100);
  }
  throw new Error('Verification mail did not arrive in the private test mailbox.');
}
export async function verifiedAccount(request, maildir, label) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 14);
  const email = `${label}-${suffix}@example.test`;
  const password = `Private-test-${suffix}-Password!`;
  const signup = await request('/api/auth/register', {
    method: 'POST', body: { email, password, acceptTerms: true, termsVersion: '2026-05-12', privacyVersion: '2026-05-12', legalAcceptanceSource: 'signup' },
  });
  expectStatus(signup, 200, 'workspace account signup');
  const account = { ...signup.data, email, password };
  const verify = await findMailToken(maildir, email);
  expectStatus(await request('/api/auth/verify-email', { method: 'POST', token: account.accessToken, body: { token: verify } }), 200, 'workspace account verification');
  expectStatus(await request('/api/auth/me/complete-profile', { method: 'POST', token: account.accessToken, body: { name: `ws_${suffix}`, displayName: 'Workspace Test Owner' } }), 200, 'workspace account profile');
  return account;
}
// Minimal deterministic PNG, generated without a native image dependency.
function onePixelPNG() {
  const crc32 = buffer => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, 40, 90, 160, 255]))), chunk('IEND', Buffer.alloc(0))]);
}

export async function verifyWorkspaceContract({ origin, data }) {
  const request = httpClient(origin), maildir = path.join(data, 'outbox');
  const suffix = randomUUID().slice(0, 8), passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log(`PASS M2 ${name}`); };
  let a, b, first, second, foreign, retainedOrder, retainedSettings, avatarURL;
  const scoped = (record, account = a, extras = {}) => ({ token: account.accessToken, server: record.id, ...extras });
  const endpoint = (record, tail = '') => `/api/servers/${record.id}${tail}`;

  await check('identity gates cover creation and scoped reads before parsing', async () => {
    for (const [route, method] of [['/api/servers','GET'],['/api/servers','POST'],['/api/servers/order','PATCH'],['/api/servers/missing/settings','GET'],['/api/servers/missing/setup-transition','POST']]) {
      expectStatus(await request(route, { method, ...(method === 'GET' ? {} : { body: {} }) }), 401, 'missing identity');
    }
    const email = `pending-${suffix}@example.test`, password = `Pending-${suffix}-Password!`;
    const pending = await request('/api/auth/register', { method: 'POST', body: { email, password, acceptTerms: true, termsVersion:'2026-05-12', privacyVersion:'2026-05-12' } });
    expectStatus(pending, 200, 'pending fixture');
    const denied = await request('/api/servers', { method:'POST', token:pending.data.accessToken, body:{name:'Pending',slug:`pending-${suffix}`} });
    expectStatus(denied, 403, 'unverified account'); assert.equal(denied.data.error, 'Email verification required');
    const verify = await findMailToken(maildir, email);
    expectStatus(await request('/api/auth/verify-email', { method:'POST', token:pending.data.accessToken, body:{token:verify} }), 200, 'verify pending');
    const profileDenied = await request('/api/servers', { method:'POST', token:pending.data.accessToken, body:{name:'Pending',slug:`pending-${suffix}`} });
    expectStatus(profileDenied, 403, 'incomplete profile'); assert.equal(profileDenied.data.code, 'PROFILE_SETUP_REQUIRED');
    a = await verifiedAccount(request, maildir, 'owner-a');
    b = await verifiedAccount(request, maildir, 'owner-b');
  });
  await check('W01 creates a bare real workspace without accepting forged privileges', async () => {
    const result = await request('/api/servers', { method:'POST', token:a.accessToken, body:{name:'  Workspace A  ',slug:`space-a-${suffix}`,ownerId:b.user.id,role:'guest',plan:'enterprise',setupStatus:'complete',settings:{hideHumansFromMembers:true}} });
    expectStatus(result, 200, 'create'); first = result.data; exactKeys(first, recordFields);
    assert.equal(first.ownerId,a.user.id); assert.equal(first.name,'  Workspace A  '); assert.equal(first.kind,'normal'); assert.equal(first.plan,'free');
    for (const key of ['avatarUrl','onboardingAgentId','planDowngradedAt','deletedAt']) assert.equal(first[key],null);
    for (const key of ['hideHumansFromMembers','publiclyVisible','translationEnabled','progressAnnouncementsEnabled']) assert.equal(first[key],false);
    assert.equal(first.agentAllChannelGreetingEnabled,true);
    assert.match(first.createdAt,isoMillis); assert.equal(first.updatedAt,first.createdAt);
  });
  await check('W01 slug truthiness, case and length errors preserve legacy wording', async () => {
    for (const [body,error] of [
      [{},'Name and slug are required'], [{name:'X',slug:''},'Name and slug are required'],
      [{name:'X',slug:17},'Slug is required'], [{name:'X',slug:'abcd'},'Slug must be at least 5 characters'],
      [{name:'X',slug:'UPPER'},'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens'],
      [{name:'X',slug:' spaces '},'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens'],
      [{name:'X',slug:'1start'},'Slug must start with a letter and contain only lowercase letters, numbers, and hyphens'],
    ]) {
      const result = await request('/api/servers',{method:'POST',token:a.accessToken,body}); expectStatus(result,400,'slug validation'); assert.equal(result.data.error,error);
    }
    const duplicate = await request('/api/servers',{method:'POST',token:a.accessToken,body:{name:'Duplicate',slug:first.slug}});
    expectStatus(duplicate,409,'active duplicate'); assert.equal(duplicate.data.error,`Server slug "${first.slug}" is already taken`);
  });
  await check('W02/W05 list, detail, create-name differences and header-independent owner', async () => {
    const another = await request('/api/servers',{method:'POST',token:b.accessToken,body:{name:'Other owner',slug:`space-b-${suffix}`}}); expectStatus(another,200,'foreign create'); foreign=another.data;
    const created = await request('/api/servers',{method:'POST',token:a.accessToken,server:foreign.id,body:{name:'x'.repeat(101),slug:`second-${suffix}`}}); expectStatus(created,200,'create does not reuse PATCH name limit'); second=created.data; assert.equal(second.ownerId,a.user.id);
    const listed = await request('/api/servers',{token:a.accessToken,server:foreign.id}); expectStatus(listed,200,'list'); assert.deepEqual(listed.data.map(x=>x.id),[first.id,second.id]);
    for (const row of listed.data) { exactKeys(row,listFields); assert.equal(row.role,'owner'); assert.equal(row.serverOrderVersion,0); assert.equal(typeof row.messageHistoryDays,'number'); assert.match(row.createdAt,isoMillis); if(row.historyCutoff!==null) assert.match(row.historyCutoff,isoMillis); }
    const detail = await request(endpoint(first),scoped(first)); expectStatus(detail,200,'detail'); assert.deepEqual(detail.data,first);
  });
  await check('W05 scope rejects missing/mismatched header, slug fallback and nonmembers', async () => {
    const missing=await request(endpoint(first),{token:a.accessToken}); expectStatus(missing,400,'missing header'); assert.equal(missing.data.error,'Missing X-Server-Id header');
    const mismatch=await request(endpoint(first),{token:a.accessToken,server:second.id}); expectStatus(mismatch,400,'mismatched header even for two owned spaces'); assert.equal(mismatch.data.error,'X-Server-Id must match server id in URL');
    const denied=await request(endpoint(first),scoped(first,b)); expectStatus(denied,403,'foreign owner'); assert.equal(denied.data.error,'Not a member of this server');
    const slug=await request(`/api/servers/${first.slug}`,{token:a.accessToken,server:first.slug}); expectStatus(slug,403,'no slug fallback');
    const absent=await request('/api/servers/missing',{token:a.accessToken,server:'missing'}); expectStatus(absent,403,'missing scope membership');
  });
  await check('W03/W04 order filters, appends, versions and no-op behavior', async () => {
    const before=await request('/api/servers/order',{token:a.accessToken}); expectStatus(before,200,'order'); exactKeys(before.data,['serverOrder','serverOrderVersion']); assert.deepEqual(before.data,{serverOrder:[first.id,second.id],serverOrderVersion:0});
    for(const value of [null,{},'not-array',[1]]) { const bad=await request('/api/servers/order',{method:'PATCH',token:a.accessToken,body:{serverOrder:value}}); expectStatus(bad,400,'order input'); assert.equal(bad.data.error,'serverOrder must be an array of string IDs'); }
    const changed=await request('/api/servers/order',{method:'PATCH',token:a.accessToken,server:foreign.id,body:{serverOrder:[foreign.id,second.id,second.id,'missing']}}); expectStatus(changed,200,'change order'); retainedOrder=changed.data; assert.deepEqual(retainedOrder,{serverOrder:[second.id,first.id],serverOrderVersion:1});
    const same=await request('/api/servers/order',{method:'PATCH',token:a.accessToken,body:{serverOrder:[second.id,first.id,first.id]}}); expectStatus(same,200,'no-op order'); assert.deepEqual(same.data,retainedOrder);
    const list=await request('/api/servers',{token:a.accessToken}); assert.deepEqual(list.data.map(x=>x.id),retainedOrder.serverOrder); assert.ok(list.data.every(x=>x.serverOrderVersion===1));
  });
  await check('W06 PATCH distinguishes absent/null/false and UTF-16 boundaries', async () => {
    for(const [body,error] of [[{},'At least one field is required'],[{name:null},'Name must be a string'],[{name:22},'Name must be a string'],[{name:'  \t\n'},'Name is required'],[{name:'😀'.repeat(51)},'Name must be 100 characters or fewer'],[{ownerId:b.user.id,plan:'enterprise'},'At least one field is required']]) {
      const bad=await request(endpoint(first),scoped(first,a,{method:'PATCH',body})); expectStatus(bad,400,'profile validation'); assert.equal(bad.data.error,error);
    }
    const result=await request(endpoint(first),scoped(first,a,{method:'PATCH',body:{name:`  ${'😀'.repeat(50)}  `,hideHumansFromMembers:true,slug:'changed-slug',ownerId:b.user.id,plan:'enterprise'}})); expectStatus(result,200,'profile update'); exactKeys(result.data,recordFields); assert.equal(result.data.name,'😀'.repeat(50)); assert.equal(result.data.slug,first.slug); assert.equal(result.data.ownerId,a.user.id); assert.equal(result.data.plan,'free'); assert.equal(result.data.createdAt,first.createdAt); assert.match(result.data.updatedAt,isoMillis); assert.equal(result.data.hideHumansFromMembers,true); first=result.data;
    const invalid=await request(endpoint(first),scoped(first,a,{method:'PATCH',body:{hideHumansFromMembers:null}})); expectStatus(invalid,400,'null is not false');
  });
  await check('W07 multipart avatars are validated and returned URL serves bytes', async () => {
    const noFile=await request(endpoint(first,'/avatar'),scoped(first,a,{method:'POST',body:new FormData()})); expectStatus(noFile,400,'missing avatar'); assert.equal(noFile.data.error,'No avatar file provided');
    const badForm=new FormData(); badForm.set('avatar',new Blob(['not-an-image'],{type:'image/png'}),'bad.png');
    const bad=await request(endpoint(first,'/avatar'),scoped(first,a,{method:'POST',body:badForm})); expectStatus(bad,400,'bad avatar'); assert.equal(bad.data.errorCode,'PROFILE_AVATAR_BAD_FORMAT');
    const validForm=new FormData(); validForm.set('avatar',new Blob([onePixelPNG()],{type:'image/png'}),'pixel.png');
    const result=await request(endpoint(first,'/avatar'),scoped(first,a,{method:'POST',body:validForm})); expectStatus(result,200,'valid avatar'); exactKeys(result.data,recordFields); first=result.data; avatarURL=first.avatarUrl; assert.equal(typeof avatarURL,'string');
    const image=await fetch(new URL(avatarURL,origin),{signal:AbortSignal.timeout(15000)}); assert.equal(image.status,200); assert.match(image.headers.get('content-type'),/^image\//); assert.ok((await image.arrayBuffer()).byteLength>0);
  });
  await check('W08 real owner membership, exact member shape and isolation', async () => {
    const result=await request(endpoint(first,'/members'),scoped(first)); expectStatus(result,200,'members'); assert.equal(result.data.length,1); const owner=result.data[0]; exactKeys(owner,['userId','email','name','displayName','description','avatarUrl','role','joinedAt','gravatarHash']); assert.equal(owner.userId,a.user.id); assert.equal(owner.role,'owner'); assert.equal(owner.email,a.email); assert.match(owner.joinedAt,isoMillis);
    expectStatus(await request(endpoint(first,'/members'),scoped(first,b)),403,'foreign members denied');
  });
  await check('W09/W10 settings aggregate, default nulls, old aliases and C0', async () => {
    const aggregate=await request(endpoint(first,'/settings'),scoped(first)); expectStatus(aggregate,200,'aggregate'); exactKeys(aggregate.data,['settings']); exactKeys(aggregate.data.settings,['onboardSettings','feedbackSettings']); assert.deepEqual(aggregate.data.settings.feedbackSettings,{enabled:false});
    const old=await request(endpoint(first,'/onboarding-settings'),scoped(first)); expectStatus(old,200,'old settings'); exactKeys(old.data,onboardFields); assert.deepEqual(old.data,aggregate.data.settings.onboardSettings);
    assert.equal(old.data.onboardingWizardEnabled,false); assert.equal(old.data.agentAllChannelGreetingEnabled,true); assert.equal(old.data.setupModalReminderOptOut,false); assert.equal(old.data.onboardingReminderOptOut,false);
    for(const key of onboardFields.filter(x=>x.endsWith('At')||x.endsWith('Id')||x==='onboardingWizardCurrentStep')) assert.equal(old.data[key],null);
  });
  await check('W11 own preferences are atomic, alias-compatible and do not complete setup', async () => {
    const result=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{setupModalReminderOptOut:false,onboardingReminderOptOut:true,dismissedAddComputerStep:true,agentAllChannelGreetingEnabled:false,userId:b.user.id,setupStatus:'complete'}})); expectStatus(result,200,'preferences'); assert.equal(result.data.setupModalReminderOptOut,false); assert.equal(result.data.onboardingReminderOptOut,false); assert.match(result.data.dismissedAddComputerStepAt,isoMillis); assert.equal(result.data.agentAllChannelGreetingEnabled,false);
    const alias=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{setupModalReminderOptOut:null,onboardingReminderOptOut:true,dismissedInviteStep:true}})); expectStatus(alias,200,'nullish alias'); retainedSettings=alias.data; assert.equal(alias.data.setupModalReminderOptOut,true); assert.equal(alias.data.onboardingReminderOptOut,true);
    const invalid=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{agentAllChannelGreetingEnabled:true,dismissedInviteStep:'yes'}})); expectStatus(invalid,400,'combination rejects invalid type');
    const reread=await request(endpoint(first,'/onboarding-settings'),scoped(first)); assert.deepEqual(reread.data,retainedSettings);
    const fake=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{onboardingAgentId:randomUUID()}})); expectStatus(fake,400,'nonexistent agent'); assert.equal(fake.data.error,'Onboarding agent not found in this server');
    const empty=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{}})); expectStatus(empty,400,'empty settings');
    const emptyAgent=await request(endpoint(first,'/onboarding-settings'),scoped(first,a,{method:'PATCH',body:{onboardingAgentId:'',agentAllChannelGreetingEnabled:true,setupModalReminderOptOut:false}}));
    expectStatus(emptyAgent,500,'empty agent preserves legacy UUID failure'); assert.deepEqual(emptyAgent.data,{error:'Failed to update onboarding settings'});
    assert.deepEqual((await request(endpoint(first,'/onboarding-settings'),scoped(first))).data,retainedSettings,'failed empty agent setter must not partially change preferences');
  });
  await check('W12 new owner gets the full truthful blocking projection', async () => {
    const result=await request(endpoint(first,'/setup-projection'),scoped(first)); expectStatus(result,200,'initial projection'); assert.deepEqual(result.data,initialProjection);
    const again=await request(endpoint(first,'/setup-projection'),scoped(first)); assert.deepEqual(again.data,initialProjection);
  });
  await check('W13 start is idempotent, complete requires facts and defer is rejected', async () => {
    const start=await request(endpoint(first,'/setup-transition'),scoped(first,a,{method:'POST',body:{action:'start',userId:b.user.id,setupStatus:'complete'}})); expectStatus(start,200,'start'); assert.equal(start.data.phase,'in_progress'); assert.equal(start.data.blocksChat,true);
    const again=await request(endpoint(first,'/setup-transition'),scoped(first,a,{method:'POST',body:{action:'start'}})); expectStatus(again,200,'start repeated'); assert.deepEqual(again.data,start.data);
    const complete=await request(endpoint(first,'/setup-transition'),scoped(first,a,{method:'POST',body:{action:'complete',onboardingAgentId:randomUUID()}})); expectStatus(complete,409,'unusable official agent'); assert.equal(complete.data.error,'OFFICIAL_ONBOARDING_AGENT_NOT_USABLE');
    for(const body of [{action:'defer'},{action:'unknown'},{setupStatus:'complete'}]) { const invalid=await request(endpoint(first,'/setup-transition'),scoped(first,a,{method:'POST',body})); expectStatus(invalid,400,'invalid action'); assert.equal(invalid.data.error,'INVALID_SETUP_ACTION'); }
  });
  await check('W14/W15 early handoff does not advance setup and reset preserves workspace', async () => {
    const handoff=await request(endpoint(first,'/setup-handoff'),scoped(first,a,{method:'POST',body:{}})); expectStatus(handoff,200,'early handoff'); assert.equal(handoff.data.phase,'in_progress'); assert.equal(handoff.data.blocksChat,true);
    const again=await request(endpoint(first,'/setup-handoff'),scoped(first,a,{method:'POST',body:{}})); expectStatus(again,200,'repeated handoff'); assert.deepEqual(again.data,handoff.data);
    const reset=await request(endpoint(first,'/setup-reset'),scoped(first,a,{method:'POST',body:{}})); expectStatus(reset,200,'reset'); assert.deepEqual(reset.data,{...initialProjection,revokedComputers:0});
    expectStatus(await request(endpoint(first),scoped(first)),200,'workspace preserved');
    assert.equal((await request(endpoint(first,'/members'),scoped(first))).data.length,1);
  });
  await check('W16/W17 complete sidebar defaults and real empty machine directory', async () => {
    const sidebar=await request(endpoint(first,'/sidebar-order'),scoped(first)); expectStatus(sidebar,200,'sidebar'); exactKeys(sidebar.data,sidebarFields);
    for(const key of ['channelOrder','agentOrder','dmOrder','pinned','pinnedChannelIds','pinnedAgentIds','pinnedOrder','hiddenDmIds','channelPanelTabOrder','agentPanelTabOrder','customSections','sectionPlacements']) assert.deepEqual(sidebar.data[key],[]);
    for(const key of ['channelSortMode','jointChannelSortMode','dmSortMode','pinnedSortMode']) assert.equal(sidebar.data[key],'manual');
    // TS routes/servers.ts canonicalizeSidebarSections appends system sections
    // even when persisted sectionOrder is empty (design §9.4 simplified this).
    assert.deepEqual(sidebar.data.sectionOrder,['system:pinned','system:joint','system:channels','system:dms']);
    assert.equal(sidebar.data.sectionsVersion,0); assert.equal(sidebar.data.pinnedVersion,0);
    const machines=await request(endpoint(first,'/machines'),scoped(first)); expectStatus(machines,200,'empty machine catalog'); assert.deepEqual(machines.data,{machines:[],latestDaemonVersion:null,latestComputerVersion:null});
  });
  await check('unsupported commands and wrong methods never claim success', async () => {
    // M3 now exposes the system channels M2 already created. They must be
    // read from those rows, not hidden behind the old unsupported assertion.
    const channels=await request('/api/channels',scoped(first)); expectStatus(channels,200,'M3 reads M2 system channels');
    assert.deepEqual(channels.data.map(channel=>channel.systemKind).sort(),['all','announcement']);
    for(const route of ['/internal/agent-api/server','/daemon/unsupported','/socket.io/']) { const result=await request(route,scoped(first)); assert.ok(result.status>=400, 'unsupported or wrong-principal surface cannot return successful placeholder'); }
    const wrong=await request(endpoint(first,'/settings'),scoped(first,a,{method:'PATCH',body:{name:'not-a-profile-endpoint'}})); expectStatus(wrong,405,'settings is read-only'); assert.match(wrong.headers.get('allow')??'',/GET/);
  });
  await check('concurrent same-slug creation has only one winner and complete ownership', async () => {
    const slug=`race-${suffix}`;
    const results=await Promise.all(Array.from({length:5},()=>request('/api/servers',{method:'POST',token:b.accessToken,body:{name:'Concurrent workspace',slug}})));
    assert.equal(results.filter(x=>x.status===200).length,1);
    for(const result of results.filter(x=>x.status!==200)) assert.ok([409,500].includes(result.status),'losers follow legacy conflict/error contract');
    const winner=results.find(x=>x.status===200).data;
    const members=await request(endpoint(winner,'/members'),scoped(winner,b)); expectStatus(members,200,'winner membership'); assert.equal(members.data.length,1); assert.equal(members.data[0].userId,b.user.id);
    assert.deepEqual((await request(endpoint(winner,'/setup-projection'),scoped(winner,b))).data,initialProjection);
  });
  await check('fresh login observes actual workspace role, settings and setup state', async () => {
    const login=await request('/api/auth/login',{method:'POST',body:{email:a.email,password:a.password}}); expectStatus(login,200,'fresh login'); a={...a,...login.data};
    const listed=await request('/api/servers',{token:a.accessToken}); expectStatus(listed,200,'fresh list'); assert.deepEqual(listed.data.map(x=>x.id),retainedOrder.serverOrder); assert.ok(listed.data.every(x=>x.role==='owner'));
    assert.deepEqual((await request(endpoint(first,'/onboarding-settings'),scoped(first))).data,retainedSettings);
    const started=await request(endpoint(first,'/setup-transition'),scoped(first,a,{method:'POST',body:{action:'start'}})); expectStatus(started,200,'state retained for restart'); assert.equal(started.data.phase,'in_progress');
    first=(await request(endpoint(first),scoped(first))).data;
  });
  console.log(`M2 HTTP acceptance passed: ${passed.length} groups; no browser or Agent registration performed.`);
  return { account:a, otherAccount:b, first, second, foreign, order:retainedOrder, settings:retainedSettings, avatarURL, groups:passed.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origin=process.env.RAFT_GO_TEST_URL, data=process.env.RAFT_GO_TEST_DATA;
  if(!origin||!data) throw new Error('Set RAFT_GO_TEST_URL and RAFT_GO_TEST_DATA to an isolated local test instance.');
  await verifyWorkspaceContract({origin,data});
}
