// v0.6.1 independent review: corruption and shutdown boundaries.
// No provider calls or real credentials. Run from project root:
// node --test test/v061-boundary-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Owner} from '../src/owner.mjs';
import {Store} from '../src/store.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const temp=()=>mkdtemp(path.join(os.tmpdir(),'hub-v061-review-'));
async function poll(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(25);}throw Error('fixture timeout');}
async function accountFixture(t){
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));
  const a=new Owner(d);await a.load();
  const r=await a.setup({password:'synthetic-password'});assert.equal(r.user.id,1);
  return {d,a};
}

test('G01a session expiry missing or malformed must never authorize a token',async t=>{
  const {d,a}=await accountFixture(t);
  const login=await a.login({password:'synthetic-password',key:'fixture'});
  const f=path.join(d,'sessions.json'),original=JSON.parse(await readFile(f,'utf8'));
  const observations=[];
  for(const expiry of [undefined,'not-a-date']){
    const data=structuredClone(original);const record=Object.values(data.sessions)[0];
    if(expiry===undefined)delete record.expiresAt;else record.expiresAt=expiry;
    const raw=JSON.stringify(data);await writeFile(f,raw);
    const b=new Owner(d);let rejected=false;
    try{await b.load();}catch(e){assert.equal(e.message,'accounts_corrupt');rejected=true;}
    const authorized=!rejected&&Boolean(b.userForToken(login.token));
    observations.push({expiry:expiry??'missing',loadRejected:rejected,authorized});
    assert.equal(await readFile(f,'utf8'),raw,'Corrupt input must not be silently overwritten');
  }
  t.diagnostic(JSON.stringify(observations));
  assert.ok(observations.every(x=>!x.authorized),'Invalid expiry bypasses the expiry check');
});

test('G01c duplicate message IDs must be rejected before update targets the wrong message',async t=>{
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));const f=path.join(d,'state.json');
  await writeFile(f,JSON.stringify({messages:[{id:1,role:'user',text:'request'},{id:1,role:'assistant',text:'answer'}],nextId:2,usage:{},sessions:{},epochs:{}}));
  const s=new Store(pathToFileURL(f));let rejected=false;
  try{await s.load();}catch(e){assert.equal(e.message,'state_corrupt');rejected=true;}
  if(rejected)return;
  s.update(1,{status:'done',text:'replacement answer'});
  t.diagnostic('duplicate IDs accepted; updated role='+s.state.messages.find(m=>m.text==='replacement answer').role);
  assert.fail('Duplicate message IDs must not pass schema validation');
});

test('G01d structurally invalid usage must not turn a configured budget comparison false',async t=>{
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));const f=path.join(d,'state.json');
  const month=new Date().toISOString().slice(0,7);
  await writeFile(f,JSON.stringify({messages:[],nextId:1,usage:{[month]:{lead:{input:'broken',output:20,calls:1}}},sessions:{},epochs:{}}));
  const s=new Store(pathToFileURL(f));let rejected=false;
  try{await s.load();}catch(e){assert.equal(e.message,'state_corrupt');rejected=true;}
  if(rejected)return;
  const u=s.usageFor();t.diagnostic('usage tokens='+JSON.stringify(u.tokens)+'; budget comparison (>=10)='+(u.tokens>=10));
  assert.fail('Malformed nested usage accepted and passed to budget arithmetic');
});

async function shutdownFixture(t,{ignoreParentTerm}){
  const d=await temp(),heartbeat=path.join(d,'heartbeat');let runner;
  t.after(async()=>{
    await writeFile(heartbeat+'.stop','stop');await delay(250);
    if(runner&&runner.exitCode===null)runner.kill('SIGKILL');
    await rm(d,{recursive:true,force:true});
  });
  const leaf=path.join(d,'leaf.cjs'),parent=path.join(d,'parent.cjs'),host=path.join(d,'host.mjs');
  await writeFile(leaf,'const fs=require("node:fs"),f=process.argv[2];process.on("SIGTERM",()=>{});const beat=()=>{if(fs.existsSync(f+".stop"))process.exit(0);fs.writeFileSync(f,String(Date.now()));};beat();setInterval(beat,100);');
  // Both processes cooperate with fixture cleanup, but deliberately ignore TERM
  // where stated. Heartbeat observation avoids cross-namespace PID assumptions.
  await writeFile(parent,`const fs=require('node:fs');${ignoreParentTerm?'process.on("SIGTERM",()=>{});':''}require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{if(fs.existsSync(process.argv[3]+'.stop'))process.exit(0);},100);`);
  const mod=pathToFileURL(path.join(ROOT,'src/adapters/index.mjs')).href;
  await writeFile(host,`import {runAdapter} from ${JSON.stringify(mod)};
setInterval(()=>{},1000); // Simulates the server's open HTTP listener.
console.log('HOST_READY');
try{await runAdapter({id:'fixture',command:process.execPath,args:${JSON.stringify([parent,leaf,heartbeat])},parse:'plain'},{cwd:${JSON.stringify(d)},prompt:'x',timeoutMs:800,parentEnv:{PATH:process.env.PATH}});}catch(e){console.log('RUN_FINISHED:'+e.message);}`);
  runner=spawn(process.execPath,[host],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
  let output='';runner.stdout.on('data',b=>output+=b);runner.stderr.on('data',b=>output+=b);
  const closed=once(runner,'close');
  await poll(()=>output.includes('HOST_READY'));
  await poll(async()=>Boolean(await readFile(heartbeat,'utf8').catch(()=>'')));
  if(ignoreParentTerm){await delay(1000);} // Timeout has fired; its 3s grace is pending.
  else await poll(()=>output.includes('RUN_FINISHED:cli_timeout')); // Parent close already removed the live entry.
  const stopAt=Date.now();runner.kill('SIGTERM');
  const [code]=await closed;
  const shutdownMs=Date.now()-stopAt;
  await delay(2200); // Also observe beyond the original timeout's kill deadline.
  const before=await readFile(heartbeat,'utf8');await delay(250);
  const alive=before!==await readFile(heartbeat,'utf8');
  t.diagnostic('ignoreParentTerm='+ignoreParentTerm+'; host exit='+code+' after '+shutdownMs+'ms; descendant heartbeat continues='+alive);
  assert.equal(code,0,'Host should use its actual shutdown handler');
  assert.equal(alive,false,'Shutdown must not discard pending process-group cleanup');
}

test('G02a shutdown must finish pending cleanup after the direct child has closed',async t=>shutdownFixture(t,{ignoreParentTerm:false}));
test('G02b shutdown must accelerate a timeout already waiting for SIGKILL',async t=>shutdownFixture(t,{ignoreParentTerm:true}));
