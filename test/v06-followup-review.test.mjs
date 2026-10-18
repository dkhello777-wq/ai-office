// Independent v0.6 follow-up review. Expected-correctness assertions intentionally
// expose remaining defects. Local fixtures only; no provider or real credentials.
// Run: node --test test/v06-followup-review.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm,access} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Owner} from '../src/owner.mjs';
import {Store} from '../src/store.mjs';
import {runAdapter} from '../src/adapters/index.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const temp=()=>mkdtemp(path.join(os.tmpdir(),'hub-v06-review-'));
const exists=async p=>{try{await access(p);return true;}catch{return false;}};
async function poll(fn,ms=6000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(25);}throw Error('fixture condition timeout');}

test('F01a structurally corrupt owner file must fail closed, not become first-run',async t=>{
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));
  await writeFile(path.join(d,'owner.json'),'{"salt":123}');
  const a=new Owner(d);let error;
  try{await a.load();}catch(e){error=e;}
  if(error){assert.equal(error.message,'accounts_corrupt');return;}
  t.diagnostic('Existing owner.json with wrong schema accepted; isSet='+a.isSet);
  assert.fail('Existing owner file with wrong schema must fail closed');
});

test('F01b state with missing nextId must fail closed before creating null IDs',async t=>{
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));
  const f=path.join(d,'state.json');await writeFile(f,'{"messages":[]}');
  const s=new Store(pathToFileURL(f));let error;
  try{await s.load();}catch(e){error=e;}
  if(error){assert.equal(error.message,'state_corrupt');return;}
  s.add({role:'user',text:'synthetic'});await s.save();
  const persisted=JSON.parse(await readFile(f,'utf8'));
  t.diagnostic('Persisted id='+persisted.messages[0].id+'; nextId='+persisted.nextId);
  assert.fail('Missing nextId accepted and persisted as null');
});

test('F02 timeout must kill a descendant that ignores SIGTERM even after parent close',async t=>{
  const d=await temp();
  const pidFile=path.join(d,'descendant-heartbeat');
  // Observe liveness through a heartbeat: executor child PID namespaces can make
  // a child's process.pid invalid in its parent's namespace. A stop file also
  // guarantees cleanup without guessing cross-namespace process IDs.
  t.after(async()=>{await writeFile(pidFile+'.stop','stop');await delay(250);await rm(d,{recursive:true,force:true});});
  const leaf=path.join(d,'leaf.cjs'),parent=path.join(d,'parent.cjs');
  await writeFile(leaf,'const fs=require("node:fs"),f=process.argv[2];process.on("SIGTERM",()=>{});const beat=()=>{if(fs.existsSync(f+".stop"))process.exit(0);fs.writeFileSync(f,String(Date.now()));};beat();setInterval(beat,100);');
  await writeFile(parent,'require("node:child_process").spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:["ignore",process.stdout,process.stderr]});setInterval(()=>{},1000);');
  const started=Date.now();
  const result=await runAdapter({id:'tree',command:process.execPath,args:[parent,leaf,pidFile],parse:'plain'},
    {cwd:d,prompt:'fixture',timeoutMs:800,parentEnv:{PATH:process.env.PATH}}).catch(e=>e);
  assert.ok(Number(await readFile(pidFile,'utf8'))>0,'Descendant fixture must have started');
  assert.equal(result.message,'cli_timeout');
  const returned=Date.now()-started;
  await delay(Math.max(0,4300-(Date.now()-started)));
  const firstHeartbeat=await readFile(pidFile,'utf8');await delay(250);
  const alive=firstHeartbeat!==await readFile(pidFile,'utf8');
  t.diagnostic('Adapter returned after '+returned+'ms; descendant still running after '+(Date.now()-started)+'ms: '+alive);
  assert.equal(alive,false,'SIGKILL grace elapsed but descendant survived');
});

async function startHub(t,{slowAuth=false,modelDelay=30,concurrent=1}={}){
  const d=await temp();await cp(path.join(ROOT,'src'),path.join(d,'src'),{recursive:true});
  await cp(path.join(ROOT,'public'),path.join(d,'public'),{recursive:true});await mkdir(path.join(d,'config'));
  const fixture=path.join(d,'fixture.mjs');
  await writeFile(fixture,`import {writeFile,access} from 'node:fs/promises';
import path from 'node:path';
const home=process.env.HOME;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
if(process.argv.includes('--auth')){
 await writeFile(path.join(home,'auth-started'),'ready');
 if(${slowAuth}){while(true){try{await access(path.join(home,'auth-release'));break;}catch{}await delay(20);}}
 console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'}));process.exit(0);
}
let p='';for await(const c of process.stdin)p+=c;
await writeFile(path.join(home,'model-started'),p);
await delay(${modelDelay});
console.log(JSON.stringify({text:'OK',session:'fixture-session',usage:{input:1,output:1}}));`);
  const adapter={id:'lead',label:'lead',command:process.execPath,args:[fixture],parse:'mock-json',enabled:true,authCheck:{args:[fixture,'--auth'],parser:'mock-json'}};
  const sock=net.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');
  const port=sock.address().port;await new Promise(r=>sock.close(r));
  await writeFile(path.join(d,'config/adapters.json'),JSON.stringify({adapters:[adapter],host:'127.0.0.1',port,timeoutMs:10000,allowedHosts:[],users:{dir:'data/users'},limits:{concurrentPerUser:concurrent}}));
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:d,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  t.after(async()=>{
    const closed=once(child,'close');child.kill('SIGTERM');
    const force=setTimeout(()=>child.kill('SIGKILL'),3000);await closed;clearTimeout(force);
    await rm(d,{recursive:true,force:true});
  });
  await poll(()=>{if(child.exitCode!==null)throw Error(log);return log.includes('AI Hub');});
  const base='http://127.0.0.1:'+port;
  const call=async(p,{cookie,body,method='GET'}={})=>{
    const res=await fetch(base+p,{method,headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    return {status:res.status,headers:res.headers,data:await res.json()};
  };
  const code=(await readFile(path.join(d,'data/setup-code'),'utf8')).trim();
  const r0=await call('/api/setup',{method:'POST',body:{password:'synthetic-password',code}});assert.equal(r0.status,200);
  const user={id:1,cookie:r0.headers.get('set-cookie').split(';')[0]};
  const uc=(p,o={})=>call(p,{...o,cookie:user.cookie});
  const userDir=path.join(d,'data/users',String(user.id));
  const home=path.join(userDir,'home');
  const diskState=async()=>JSON.parse(await readFile(path.join(userDir,'state.json'),'utf8'));
  return {uc,home,diskState};
}

test('F05 handled login storage error must not create an unhandled rejection',async t=>{
  const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));
  const script=path.join(d,'login-rejection.mjs');
  const source=pathToFileURL(path.join(ROOT,'src/owner.mjs')).href;
  await writeFile(script,`import {Owner} from ${JSON.stringify(source)};
import {mkdir} from 'node:fs/promises';
const a=new Owner(${JSON.stringify(d)});await a.load();
await a.setup({password:'synthetic-password'});
await mkdir(${JSON.stringify(path.join(d,'sessions.json.tmp'))});
try{await a.login({password:'synthetic-password',key:'fixture'});}catch(e){console.log('CALLER_CAUGHT:'+e.code);}
await new Promise(r=>setTimeout(r,100));console.log('STILL_ALIVE');`);
  const child=spawn(process.execPath,[script],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const [code]=await once(child,'close');
  t.diagnostic('Exit='+code+'; stdout='+JSON.stringify(stdout.trim())+'; unhandled EISDIR='+stderr.includes('EISDIR'));
  assert.match(stdout,/CALLER_CAUGHT:EISDIR/,'Fixture must fail in sessions save and be caught by caller');
  assert.equal(code,0,'Unhandled promise returned by finally crashes process despite caller catch');
  assert.match(stdout,/STILL_ALIVE/);
});
