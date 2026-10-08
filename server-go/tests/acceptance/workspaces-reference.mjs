// Execute the frozen TS PURE projector against the Go projector. This is
// deliberately not a claim of full TS-server/PostgreSQL differential coverage.
// No reference source is rewritten and no TS backend/dependency graph is started.
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const sourcePath=path.resolve(root,'../packages/server/src/services/serverSetupStateService.ts');
const source=await readFile(sourcePath,'utf8');
const expectedHash='d1df92725f9a0abbf0789d23f400120fba4d98acd5c430fd7c6808bb371cb7e7';
assert.equal(createHash('sha256').update(source).digest('hex'),expectedHash,'TS reference changed: re-review baseline before regenerating equivalence evidence');
const from=source.indexOf('function isRuntimeReady('), to=source.indexOf('function nextStateForAction(');
assert.ok(from>=0 && to>from,'reference pure-function boundaries exist');
// This exact contiguous section includes the original gate helpers and projector;
// only TypeScript syntax and the module export keyword are removed for execution.
const segment=source.slice(from,to).replace('export function projectServerSetup(', 'function projectServerSetup(');
const executable=stripTypeScriptTypes(segment,{mode:'strip'});
const project=vm.runInNewContext(`${executable}\nprojectServerSetup;`,{}, {timeout:5000});
const cases=[];
const baseState={serverId:'reference-server',userId:'reference-owner',contractVersion:'onboarding-setup-v2'};
const stateVariants=[
  ...['not_started','in_progress','deferred'].map(status=>({...baseState,status,completionReason:null})),
  ...[null,'normal','grandfathered','complete_after_defer','admin_override'].map(completionReason=>({...baseState,status:'complete',completionReason})),
];
const add=(label,state,live)=>cases.push({label,state,live,expected:JSON.parse(JSON.stringify(project(state,live)))});
for(const state of stateVariants) {
  for(const computer of ['online','offline','unknown']) {
    for(const runtime of ['ready_recommended','ready_other','not_ready','checking','error','unknown']) {
      for(const officialOnboardingAgent of ['usable','missing','unusable','unknown']) {
        for(const everHadAgent of [false,true]) {
          const live={computer,runtime,officialOnboardingAgent,everHadAgent,hasConnectedComputer:true,
            offlineComputers:computer==='online'?[]:[{id:'sleeping-computer',name:'Sleeping laptop',lastHeartbeat:'2026-07-01T12:34:56.789Z',isComputer:true}],
            runtimeOptions:[],ownerSurveyPending:true,ownerHandoffPending:true,actorIsOwner:true};
          add(`${state.status}/${state.completionReason}/${computer}/${runtime}/${officialOnboardingAgent}/checkpoint=${everHadAgent}`,state,live);
        }
      }
    }
  }
}
for(const state of stateVariants) {
  for(const actorIsOwner of [false,true]) for(const ownerSurveyPending of [false,true]) for(const ownerHandoffPending of [false,true]) {
    add(`post-setup/${state.status}/${state.completionReason}/${actorIsOwner}/${ownerSurveyPending}/${ownerHandoffPending}`,state,
      {computer:'unknown',runtime:'unknown',officialOnboardingAgent:'unknown',everHadAgent:true,hasConnectedComputer:false,offlineComputers:[],runtimeOptions:[],actorIsOwner,ownerSurveyPending,ownerHandoffPending});
  }
}
const dir=await mkdtemp(path.join(tmpdir(),'raft-go-ts-reference-'));
try {
  const fixture=path.join(dir,'projector-reference.json');
  await writeFile(fixture,JSON.stringify({sourceBaseline:'c4a5015deb7dcc8b800df96675d899f384f76e36',sourceSHA256:expectedHash,cases}),{mode:0o600});
  await new Promise((resolve,reject)=>{
    const child=spawn('go',['test','-tags=reference','./internal/workspace','-run','^TestM2TSProjectorReference$','-count=1','-v'],{
      cwd:root,env:{...process.env,RAFT_M2_PROJECTOR_REFERENCE:fixture},stdio:['ignore','pipe','pipe'],
    });
    let timedOut=false, output='';
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},120000);
    child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
    child.stderr.on('data',chunk=>process.stderr.write(chunk));
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);if(timedOut)reject(new Error('Go projector differential timed out'));else if(code!==0)reject(new Error(`Go projector differential exited ${code}`));else if(!output.includes('--- PASS: TestM2TSProjectorReference'))reject(new Error('Go reference test did not execute; no-test success is not equivalence evidence'));else resolve();});
  });
  console.log(`PASS M2 ${cases.length} executable TS/Go pure-projector comparisons at frozen source baseline`);
} finally {
  await rm(dir,{recursive:true,force:true});
}
