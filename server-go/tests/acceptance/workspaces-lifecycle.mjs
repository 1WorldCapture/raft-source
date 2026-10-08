// M2 real-process lifecycle and cold-backup recovery. Operates exclusively
// on the disposable data directory created by acceptance/run.mjs.
import assert from 'node:assert/strict';
import { cp, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { httpClient, expectStatus } from './workspaces-contract.mjs';

export async function verifyWorkspaceLifecycle({ origin, data, start, stop, fixture }) {
  const request = httpClient(origin);
  const { account, first, order, settings, avatarURL } = fixture;
  const keyPath = path.join(data,'keys','jwt-secret');
  const keyBefore = await readFile(keyPath);
  const scoped = { token:account.accessToken, server:first.id };
  const endpoint = tail => `/api/servers/${first.id}${tail}`;
  const beforeProjection = await request(endpoint('/setup-projection'),scoped);
  expectStatus(beforeProjection,200,'before lifecycle projection');
  assert.equal(beforeProjection.data.phase,'in_progress');
  assert.equal(beforeProjection.data.blocksChat,true);
  const beforeAvatar = Buffer.from(await (await fetch(new URL(avatarURL,origin),{signal:AbortSignal.timeout(15000)})).arrayBuffer());
  const avatarHash = createHash('sha256').update(beforeAvatar).digest('hex');

  // Stop and join before copying SQLite and its companion state. A raw copy
  // of a running main .db file is deliberately NOT a supported backup test.
  const backup = path.join(path.dirname(data),'m2-cold-backup');
  await stop();
  await cp(data,backup,{recursive:true,errorOnExist:true,force:false});
  assert.ok((await stat(path.join(backup,'raft.db'))).isFile());
  assert.ok((await readFile(path.join(backup,'keys','jwt-secret'))).equals(keyBefore));
  await start();
  assert.ok((await readFile(keyPath)).equals(keyBefore),'M2 does not rotate persistent signing keys');
  expectStatus(await request('/api/auth/me',{token:account.accessToken}),200,'pre-restart access remains valid');
  const readAndCheck = async token => {
    const scope={token,server:first.id};
    const detail=await request(endpoint(''),scope); expectStatus(detail,200,'retained detail'); assert.deepEqual(detail.data,first);
    const currentOrder=await request('/api/servers/order',{token}); expectStatus(currentOrder,200,'retained order'); assert.deepEqual(currentOrder.data,order);
    const currentSettings=await request(endpoint('/onboarding-settings'),scope); expectStatus(currentSettings,200,'retained preferences'); assert.deepEqual(currentSettings.data,settings);
    const currentSetup=await request(endpoint('/setup-projection'),scope); expectStatus(currentSetup,200,'retained setup'); assert.deepEqual(currentSetup.data,beforeProjection.data);
    const members=await request(endpoint('/members'),scope); expectStatus(members,200,'retained membership'); assert.equal(members.data.length,1); assert.equal(members.data[0].userId,account.user.id); assert.equal(members.data[0].role,'owner');
    const avatar=await fetch(new URL(avatarURL,origin),{signal:AbortSignal.timeout(15000)}); assert.equal(avatar.status,200); assert.equal(createHash('sha256').update(Buffer.from(await avatar.arrayBuffer())).digest('hex'),avatarHash);
  };
  await readAndCheck(account.accessToken);
  console.log('PASS M2 SIGTERM/restart preserves workspace, owner, order version, preferences, setup, avatar and signing key');

  const rotated=await request('/api/auth/refresh',{method:'POST',body:{refreshToken:account.refreshToken}});
  expectStatus(rotated,200,'M2 persisted refresh session');
  await readAndCheck(rotated.data.accessToken);
  const changed=await request(endpoint(''),{token:rotated.data.accessToken,server:first.id,method:'PATCH',body:{name:'After cold backup'}});
  expectStatus(changed,200,'post-backup mutation');
  assert.equal(changed.data.name,'After cold backup');

  // Restore the whole stopped instance, including keys and avatars. This is a
  // recovery exercise, NOT support for rolling an old binary over a new schema.
  await stop();
  await rm(data,{recursive:true,force:true});
  await cp(backup,data,{recursive:true,errorOnExist:true,force:false});
  await start();
  await readAndCheck(account.accessToken);
  const login=await request('/api/auth/login',{method:'POST',body:{email:account.email,password:account.password}});
  expectStatus(login,200,'password/account survived cold restore');
  await readAndCheck(login.data.accessToken);
  await rm(backup,{recursive:true,force:true});
  console.log('PASS M2 stopped-instance backup/restore recovers original workspace state, database, keys, session and avatar bytes');
}
