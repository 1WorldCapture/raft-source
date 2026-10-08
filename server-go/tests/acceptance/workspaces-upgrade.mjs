// Upgrade a database actually created with only the two original M1 migrations,
// then verify it through the new standalone server's HTTP surface.
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { httpClient, expectStatus, initialProjection } from './workspaces-contract.mjs';

export async function verifyM1WorkspaceUpgrade({ origin, env, start, stop, capture }) {
  const generated=await capture('go',['run','./tests/fixtures/m1-upgrade'],{timeout:120000});
  assert.equal(generated.code,0,`M1 fixture build failed: ${generated.stderr}`);
  // Capture is intentional: the private fixture response contains test-only
  // sessions and must not be inherited to stdout/stderr by the command helper.
  const fixture=JSON.parse(generated.stdout);
  assert.ok(path.basename(fixture.dataDir).startsWith('raft-go-m1-upgrade-'));
  const originalDataDir=env.RAFT_GO_DATA_DIR;
  assert.notEqual(path.resolve(fixture.dataDir),path.resolve(originalDataDir));
  const request=httpClient(origin);
  try {
    await stop();
    env.RAFT_GO_DATA_DIR=fixture.dataDir;
    await start();
    const digest=buffer=>createHash('sha256').update(buffer).digest('hex');
    assert.equal(digest(await readFile(path.join(fixture.dataDir,'keys','jwt-secret'))),fixture.keyHash,'M1 signing key preserved by M2 startup');
    for(const account of [fixture.owner,fixture.coOwner]) {
      const me=await request('/api/auth/me',{token:account.accessToken}); expectStatus(me,200,'M1 access after upgrade'); assert.equal(me.data.id,account.userId); assert.equal(me.data.email,account.email); assert.equal(me.data.emailVerified,true);
      const list=await request('/api/servers',{token:account.accessToken}); expectStatus(list,200,'M1 workspace list after upgrade'); assert.equal(list.data.length,1); assert.equal(list.data[0].id,fixture.workspaceId); assert.equal(list.data[0].role,'owner'); assert.equal(list.data[0].serverOrderVersion,0);
      const scope={token:account.accessToken,server:fixture.workspaceId};
      const projection=await request(`/api/servers/${fixture.workspaceId}/setup-projection`,scope); expectStatus(projection,200,'M1 setup backfill'); assert.deepEqual(projection.data,initialProjection,'M1 owners are not silently grandfathered');
      const login=await request('/api/auth/login',{method:'POST',body:{email:account.email,password:account.password}}); expectStatus(login,200,'M1 password after upgrade'); assert.equal(login.data.user.id,account.userId);
      const refreshed=await request('/api/auth/refresh',{method:'POST',body:{refreshToken:account.refreshToken}}); expectStatus(refreshed,200,'M1 refresh after upgrade');
    }
    const scope={token:fixture.owner.accessToken,server:fixture.workspaceId};
    const detail=await request(`/api/servers/${fixture.workspaceId}`,scope); expectStatus(detail,200,'M1 detail'); assert.equal(detail.data.ownerId,fixture.owner.userId); assert.equal(detail.data.slug,fixture.slug); assert.equal(detail.data.avatarUrl,fixture.avatarUrl);
    const members=await request(`/api/servers/${fixture.workspaceId}/members`,scope); expectStatus(members,200,'M1 membership directory'); assert.deepEqual(members.data.map(m=>[m.userId,m.role]),[[fixture.owner.userId,'owner'],[fixture.coOwner.userId,'owner']]);
    const image=await fetch(new URL(fixture.avatarUrl,origin),{signal:AbortSignal.timeout(15000)}); assert.equal(image.status,200); assert.equal(digest(Buffer.from(await image.arrayBuffer())),fixture.avatarHash,'M1 avatar content preserved');
    const pendingMe=await request('/api/auth/me',{token:fixture.pending.accessToken}); expectStatus(pendingMe,200,'M1 unverified session retained'); assert.equal(pendingMe.data.emailVerified,false);
    const verified=await request('/api/auth/verify-email',{method:'POST',token:fixture.pending.accessToken,body:{token:fixture.pending.verifyToken}}); expectStatus(verified,200,'M1 verification token remains usable once');
    const repeated=await request('/api/auth/verify-email',{method:'POST',token:fixture.pending.accessToken,body:{token:fixture.pending.verifyToken}}); assert.ok(repeated.status>=400&&repeated.status<500,'M1 verification token remains single-use');
    const created=await request('/api/servers',{method:'POST',token:fixture.owner.accessToken,body:{name:'After M1 upgrade',slug:'after-m1-upgrade'}}); expectStatus(created,200,'new M2 create after M1 upgrade'); assert.equal(created.data.ownerId,fixture.owner.userId);
    const freshProjection=await request(`/api/servers/${created.data.id}/setup-projection`,{token:fixture.owner.accessToken,server:created.data.id}); expectStatus(freshProjection,200,'new post-upgrade setup'); assert.deepEqual(freshProjection.data,initialProjection);
    console.log('PASS M2 real-process M1 upgrade preserves IDs, both old owner roles, password hashes, sessions, key, single-use email token and avatar');
    console.log('PASS M2 upgrade backfills truthful owner setup and supports new atomic workspace creation');
  } finally {
    await stop({strict:false});
    env.RAFT_GO_DATA_DIR=originalDataDir;
    await rm(fixture.dataDir,{recursive:true,force:true});
    await start();
  }
}
