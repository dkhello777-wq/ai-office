// GPT(Codex) 독립 검수 R01~R12 재현 테스트 (v0.5 에서 FAIL, v0.6 에서 PASS 해야 함). 원본에서 바꾼 곳: R03 — codex 는 resumeMode=replace 로 바뀌어
// resumeArgs 가 명령 전체를 대신하므로, 테스트 어댑터도 resumeArgs 앞에 node 실행 인자를 붙인다. 완료 조건은 더 강하게: 'exec' 바로 다음에 'resume', 그다음 세션 ID.
// Run from project root: node --test test/codex-review.test.mjs
// No provider calls; only synthetic credentials, local subprocesses and loopback HTTP.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,cp,rm} from 'node:fs/promises';
import {once} from 'node:events';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {Owner} from '../src/owner.mjs';
import {PARSERS,checkAuth,runAdapter,loadConfig} from '../src/adapters/index.mjs';
import {extractPlan} from '../src/orchestrate.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const temp=()=>mkdtemp(path.join(os.tmpdir(),'hub-independent-review-'));
async function poll(fn,ms=5000){const end=Date.now()+ms;while(Date.now()<end){const v=await fn();if(v)return v;await delay(30);}throw Error('condition timeout');}

test('R01 Codex status on stderr must be recognized',async()=>{
 const a={id:'codex',command:process.execPath,authCheck:{args:['-e','process.stderr.write("Logged in using ChatGPT\\n")'],parser:'codex-text'}};
 const r=await checkAuth(a,{PATH:process.env.PATH});
 assert.equal(r.state,'subscription',JSON.stringify(r));
});
test('R02 Codex turn.completed usage must survive parsing',()=>{
 const events=[{type:'thread.started',thread_id:'test-thread'},{type:'item.completed',item:{type:'agent_message',text:'OK'}},{type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:60}}];
 const r=PARSERS['codex-jsonl'](events.map(JSON.stringify).join('\n'));
 assert.deepEqual(r.usage,events[2].usage);
});
test('R03 Codex follow-up must pass resume and previous session to CLI',async()=>{
 const a=(await loadConfig()).adapters.find(a=>a.id==='codex');
 const script='console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(process.argv.slice(1))}}))';
 const wrap=args=>['-e',script,'--',...args];
 const first=await runAdapter({...a,command:process.execPath,args:wrap(a.args),resumeArgs:wrap(a.resumeArgs)},{cwd:os.tmpdir(),prompt:'first',session:null,parentEnv:{PATH:process.env.PATH}});
 assert.deepEqual(JSON.parse(first.text),a.args,'first call uses plain exec args');
 const r=await runAdapter({...a,command:process.execPath,args:wrap(a.args),resumeArgs:wrap(a.resumeArgs)},{cwd:os.tmpdir(),prompt:'follow-up',session:'previous-session',parentEnv:{PATH:process.env.PATH}});
 const argv=JSON.parse(r.text);
 const i=argv.indexOf('exec');
 assert.ok(i>=0&&argv[i+1]==='resume'&&argv[i+2]==='previous-session','resume must be the exec subcommand followed by the exact session id; actual argv: '+JSON.stringify(argv));
 assert.ok(!argv.slice(0,i).includes('--json'),'base exec args must not precede the resume subcommand');
});
test('R04 concurrent failed logins must not lose failure counts',async t=>{
 const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));
 const a=new Owner(d);await a.load();await a.setup({password:'synthetic-password'});
 await Promise.all(Array.from({length:16},()=>a.login({password:'incorrect-password',key:'same-ip'})));
 const counter=a.failures.get('same-ip');
 const next=await a.login({password:'synthetic-password',key:'same-ip'});
 assert.equal(next.error,'too_many_attempts','16 failures counted as '+counter.count+'; next login '+(next.token?'succeeded':next.error));
});
test('R05 corrupt owner file must fail closed instead of becoming first-run',async t=>{
 const d=await temp();t.after(()=>rm(d,{recursive:true,force:true}));await writeFile(path.join(d,'owner.json'),'{corrupted');
 const a=new Owner(d);let error;try{await a.load();}catch(e){error=e;}
 if(!error)assert.fail('Corrupt owner file accepted; isSet='+a.isSet);
 assert.equal(error.message,'accounts_corrupt');
});
test('R06 invalid worker plan must not become successful direct answer',()=>{
 const r=extractPlan(JSON.stringify({tasks:[{worker:'nonexistent-worker',prompt:'required task'}],answer:null}),['worker']);
 assert.equal(r,null,'actual: '+JSON.stringify(r));
});
test('R07 timeout must finish even when a descendant holds stdout open',async()=>{
 const script='require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},5200)"],{stdio:["ignore",process.stdout,process.stderr]});setInterval(()=>{},1000);';
 const start=Date.now();const result=await runAdapter({id:'tree',command:process.execPath,args:['-e',script],parse:'plain'},{cwd:os.tmpdir(),prompt:'x',timeoutMs:200,parentEnv:{PATH:process.env.PATH}}).catch(e=>e);
 assert.equal(result.message,'cli_timeout','fixture must reach the intended timeout');
 assert.ok(Date.now()-start<4000,'timeout 200ms + grace 3000ms exceeded: '+(Date.now()-start)+'ms; '+result.message);
});

async function startHub(t){
 const d=await temp();await cp(path.join(ROOT,'src'),path.join(d,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(d,'public'),{recursive:true});await mkdir(path.join(d,'config'));
 const fixture=path.join(d,'fixture.mjs');
 await writeFile(fixture,`import {randomUUID} from 'node:crypto';
if(process.argv.includes('--auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'}));process.exit(0);}
let p='';for await(const c of process.stdin)p+=c;
const i=process.argv.indexOf('--session');const session=i>=0?process.argv[i+1]:randomUUID();
await new Promise(r=>setTimeout(r,450));
let text='OK';if(p.includes('### HUB:PLAN'))text=JSON.stringify({tasks:[{worker:'worker',title:'work',prompt:'task'}]});
console.log(JSON.stringify({text,session,usage:{input:80,output:20}}));`);
 const adapter=id=>({id,label:id,command:process.execPath,args:[fixture],resumeArgs:['--session','{session}'],parse:'mock-json',enabled:true,authCheck:{args:[fixture,'--auth'],parser:'mock-json'}});
 const sock=net.createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const port=sock.address().port;await new Promise(r=>sock.close(r));
 await writeFile(path.join(d,'config/adapters.json'),JSON.stringify({adapters:[adapter('lead'),adapter('worker')],host:'127.0.0.1',port,timeoutMs:10000,allowedHosts:[],users:{dir:'data/users'}}));
 const child=spawn(process.execPath,['src/server.mjs'],{cwd:d,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 t.after(async()=>{child.kill('SIGTERM');await delay(50);await rm(d,{recursive:true,force:true});});
 await poll(()=>log.includes('AI Hub'));
 const base='http://127.0.0.1:'+port;
 const call=async(p,{cookie,body,raw,method='GET',headers={}}={})=>{const res=await fetch(base+p,{method,headers:{origin:base,'content-type':'application/json',...(cookie?{cookie}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:raw!==undefined?{body:raw}:{})});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:res.status,headers:res.headers,data};};
 const code=(await readFile(path.join(d,'data/setup-code'),'utf8')).trim();
 const r0=await call('/api/setup',{method:'POST',body:{password:'synthetic-password',code}});assert.equal(r0.status,200);
 const admin={id:1,cookie:r0.headers.get('set-cookie').split(';')[0]};const user=admin;
 const ac=(p,o={})=>call(p,{...o,cookie:admin.cookie});const uc=ac;
 return {d,base,ac,uc,user,admin,call};
}
test('R09 new conversation while running must not resurrect old session',async t=>{
 const s=await startHub(t);
 await s.uc('/api/send',{method:'POST',body:{text:'first',targets:['lead']}});
 await poll(async()=>{const st=(await s.uc('/api/state')).data;return st.messages.some(m=>m.status==='done');});
 const old=(await s.uc('/api/state')).data.adapters[0].session;
 await s.uc('/api/send',{method:'POST',body:{text:'slow second',targets:['lead']}});
 await delay(140);await s.uc('/api/reset',{method:'POST',body:{adapterId:'lead'}});
 const st=await poll(async()=>{const r=(await s.uc('/api/state')).data;return r.messages.filter(m=>m.role==='assistant'&&m.status==='done').length===2&&r;});
 assert.equal(st.adapters[0].session,null,'old session restored: '+(st.adapters[0].session===old));
});
test('R10 duplicate targets must not launch unbounded parallel runs past budget',async t=>{
 const s=await startHub(t);await s.ac('/api/settings/budget',{method:'POST',body:{monthlyTokens:50}});
 await s.uc('/api/send',{method:'POST',body:{text:'x',targets:Array(8).fill('lead')}});
 const st=await poll(async()=>{const x=(await s.uc('/api/state')).data;return !x.messages.some(m=>m.status==='running')&&x.messages.length>1&&x;});
 const done=st.messages.filter(m=>m.role==='assistant'&&m.status==='done');
 assert.ok(done.length<=1,'same request ran '+done.length+' calls / tokens='+st.budget.tokens+' / cap='+st.budget.limit);
});
test('R11 HTML file open must not execute with Hub origin privileges',async t=>{
 const s=await startHub(t);await s.uc('/api/files?name=preview.html',{method:'POST',raw:'<!doctype html><script>document.title="synthetic-test"</script>',headers:{'content-type':'text/html'}});
 const r=await s.uc('/files/preview.html');assert.equal(r.status,200);
 const protectedResponse=/attachment/i.test(r.headers.get('content-disposition')??'')||/sandbox/.test(r.headers.get('content-security-policy')??'')||/^text\/plain/.test(r.headers.get('content-type')??'');
 assert.ok(protectedResponse,'HTML served at authenticated origin: '+JSON.stringify(Object.fromEntries(r.headers)));
});
test('R12 SSE reconnect must reconcile messages missed while disconnected',async()=>{
 const src=await readFile(path.join(ROOT,'public/app.js'),'utf8');const connect=src.slice(src.indexOf('function connect(){'),src.indexOf('async function boot(){'));
 let loads=0,instance;const dom={};const ctx={es:null,EventSource:class{constructor(){instance=this;}addEventListener(){}},$:()=>dom,load:async()=>{loads++;},api:async()=>{loads++;return {};},state:{messages:[],adapters:[]},partials:{}};
 vm.runInNewContext(connect+'\nconnect();',ctx);instance.onopen();instance.onopen();await delay(10);
 assert.ok(loads>0,'No state refresh on initial SSE open or reconnect; no replay IDs on server');
});
