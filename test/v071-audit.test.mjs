// v0.7.1: 독립 검수 V01~V21 회귀 테스트. 각 테스트는 검수자의 재현 시나리오를 그대로 옮긴 것이라, 패치 전 코드에서는 실패한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Owner,validBudgetTokens} from '../src/owner.mjs';
import {Store,normalizeUsage} from '../src/store.mjs';
import {runAdapter,checkAuth,extractLoginHints,sanitizeLoginUrl,maskLine,ROOT,terminateAll} from '../src/adapters/index.mjs';
const MOCK=new URL('../src/adapters/mock-cli.mjs',import.meta.url).pathname;
const tmp=()=>mkdtemp(path.join(os.tmpdir(),'hub71-'));
const PASS='synthetic password 1';
async function startServer(adapters,env={}){
 const dir=await tmp();
 await mkdir(path.join(dir,'config'),{recursive:true});
 await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters,timeoutMs:30000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'},loginTimeoutMs:20000}));
 await new Promise((res,rej)=>{const c=spawn('cp',['-r',path.join(ROOT,'src'),path.join(ROOT,'public'),dir]);c.on('close',code=>code===0?res():rej(Error('cp')));});
 const port=20787+Math.floor(Math.random()*2000);
 const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),...env},stdio:['ignore','pipe','pipe']});
 let log='';srv.stderr.on('data',d=>log+=d);
 const started=await new Promise(r=>{srv.stdout.on('data',d=>{log+=d;if(String(d).includes('AI Hub'))r(true);});srv.on('exit',()=>r(false));});
 const base=`http://127.0.0.1:${port}`;
 const call=(p,o={})=>fetch(base+p,{...o,headers:{'content-type':'application/json',origin:base,...(o.headers??{})}});
 const session=r=>{const cookie=r.headers.get('set-cookie').split(';')[0];const as=async(p,o={})=>{const x=await call(p,{...o,headers:{cookie,...(o.headers??{})}});return {status:x.status,body:await x.json()};};return {cookie,as};};
 const code=async()=>(await readFile(path.join(dir,'data/setup-code'),'utf8')).trim();
 const setup=async(password=PASS,c)=>{const r=await call('/api/setup',{method:'POST',body:JSON.stringify({password,code:c??await code()})});const body=await r.json();return r.status===200?{status:200,body,...session(r)}:{status:r.status,body};};
 const login=async(password=PASS,headers={})=>{const r=await call('/api/login',{method:'POST',headers,body:JSON.stringify({password})});const body=await r.json();return r.status===200?{status:200,body,...session(r)}:{status:r.status,body};};
 return {dir,srv,base,port,call,setup,login,code,started,log:()=>log,userDir:path.join(dir,'data/users','1')};
}
const mockAdapter=(id,extra={})=>({id,label:id,color:'#888',command:'node',args:[MOCK],resumeArgs:['--session','{session}'],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},login:{args:[MOCK,'--login']},...extra});
const wait=async(as,n,ms=8000)=>{const end=Date.now()+ms;while(Date.now()<end){const st=(await as('/api/state')).body;if(st.messages.filter(m=>m.role==='assistant'&&m.status!=='running').length>=n)return st;await new Promise(r=>setTimeout(r,80));}throw Error('timeout');};

test('V04: invalid HUB_PASSWORD refuses to start; setup needs the one-time code; /healthz exposes nothing',async t=>{
 const bad=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:'short'});t.after(()=>bad.srv.kill());
 assert.equal(bad.started,false);assert.match(bad.log(),/HUB_PASSWORD/);
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_ALLOWED_HOSTS:'*'});t.after(()=>s.srv.kill());
 assert.deepEqual(await (await s.call('/healthz')).json(),{ok:true});
 // Origin/Host 를 맞춘 외부 클라이언트도 코드 없이는 못 만든다
 const raw=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:s.port,path:'/api/setup',method:'POST',headers:{host:'evil.example',origin:'http://evil.example','content-type':'application/json'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve({status:r.statusCode,body:JSON.parse(d)}));});req.on('error',reject);req.end(JSON.stringify({password:'attacker password 1'}));});
 assert.equal(raw.status,403);assert.equal(raw.body.error,'setup_code_invalid');
 assert.equal((await s.setup(PASS,'wrong-code')).status,403);
 const ok=await s.setup();assert.equal(ok.status,200);
 await assert.rejects(readFile(path.join(s.dir,'data/setup-code')),'code file removed after setup');
 assert.equal((await s.setup(PASS,'any')).status,409);
});
test('V01+V02: password change closes old SSE and old sessions stay dead even if sessions.json cannot be written',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const a=await s.setup();
 const es=await fetch(s.base+'/api/events',{headers:{cookie:a.cookie}});const reader=es.body.getReader();await reader.read();
 await mkdir(path.join(s.dir,'data/sessions.json.tmp'));   // 세션 파일 저장을 실패시킨다
 const r=await a.as('/api/settings/password',{method:'POST',body:JSON.stringify({current:PASS,next:'another long password'})});assert.equal(r.status,200);
 const drain=(async()=>{while(true){const x=await reader.read();if(x.done)return true;}})();   // 재시작 직후 state 이벤트 등이 먼저 올 수 있으니 done 까지 읽는다
 const closed=await Promise.race([drain,new Promise(r=>setTimeout(()=>r('timeout'),3000))]);assert.equal(closed,true,'old SSE closed');
 assert.equal((await a.as('/api/state')).status,401);
 const o=new Owner(path.join(s.dir,'data'));await o.load();assert.equal(o.authVersion,2);
 assert.equal(o.userForToken(a.cookie.split('=')[1]),null,'old token invalid after reload');
 await rm(path.join(s.dir,'data/sessions.json.tmp'),{recursive:true});
 assert.equal((await s.login('another long password')).status,200);
});
test('V03+V16: corrupt or empty owner.json fails closed; budget rejects unsafe numbers in API and in setBudget',async t=>{
 const d=await tmp();
 await writeFile(path.join(d,'owner.json'),JSON.stringify({salt:'',hash:'',createdAt:new Date().toISOString()}));
 const o=new Owner(d);await assert.rejects(o.load(),/accounts_corrupt/);
 const d2=await tmp();const o2=new Owner(d2);await o2.load();await o2.setup({password:PASS});
 assert.equal(await o2.setBudget({monthlyTokens:1e100}),false);assert.equal(await o2.setBudget({monthlyTokens:5.5}),false);assert.equal(await o2.setBudget({monthlyTokens:1000}),true);
 const o3=new Owner(d2);await o3.load();assert.equal(o3.user.budget.monthlyTokens,1000);
 assert.equal(validBudgetTokens(-1),false);assert.equal(validBudgetTokens(0),true);
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());const a=await s.setup();
 for(const v of [1e100,-5,'abc',true,1.5])assert.equal((await a.as('/api/settings/budget',{method:'POST',body:JSON.stringify({monthlyTokens:v})})).status,400,String(v));
 assert.equal((await a.as('/api/settings/budget',{method:'POST',body:JSON.stringify({monthlyTokens:'2000'})})).status,200);
 const bad=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_MONTHLY_TOKENS:'1e100'});t.after(()=>bad.srv.kill());assert.equal(bad.started,false);
});
test('V05: X-Forwarded-For is honoured only with HUB_TRUST_PROXY=1 (lockout per client, Secure cookie behind https proxy)',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1'});t.after(()=>s.srv.kill());
 for(let i=0;i<10;i++)await s.login('wrong password!!',{'x-forwarded-for':'198.51.100.1'});
 assert.equal((await s.login(PASS,{'x-forwarded-for':'198.51.100.1'})).status,429);
 assert.equal((await s.login(PASS,{'x-forwarded-for':'203.0.113.2'})).status,200,'other client unaffected');
 const r=await s.call('/api/login',{method:'POST',headers:{'x-forwarded-proto':'https','x-forwarded-for':'203.0.113.3',origin:'https://127.0.0.1:'+s.port},body:JSON.stringify({password:PASS})});
 assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/; Secure/);
 const u=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS});t.after(()=>u.srv.kill());
 const r2=await u.call('/api/login',{method:'POST',headers:{'x-forwarded-proto':'https',origin:'https://127.0.0.1:'+u.port},body:JSON.stringify({password:PASS})});
 assert.equal(r2.status,403,'untrusted proxy header does not change scheme → origin mismatch');
});
test('V06: oversized JSON bodies are cut at the limit before parsing',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS});t.after(()=>s.srv.kill());
 const big=JSON.stringify({password:'x'.repeat(200*1024)});
 const r=await s.call('/api/login',{method:'POST',body:big}).catch(e=>({status:'reset',error:e}));
 assert.ok(r.status===413||r.status==='reset','got '+r.status);
 const r2=await s.call('/api/login',{method:'POST',headers:{'content-length':String(10*1024*1024)},body:JSON.stringify({password:PASS})}).catch(e=>({status:'reset'}));
 assert.ok(r2.status===413||r2.status==='reset','got '+r2.status);
 assert.equal((await s.login()).status,200,'server still serves after oversized requests');
});
test('V09: auth check runs in the same cwd as the model (project settings cannot differ)',async()=>{
 const d=await tmp();const f=path.join(d,'cli.mjs');
 await writeFile(f,"import {existsSync} from 'node:fs';const mode=existsSync('local-api-mode')?'api_key':'claude.ai';console.log(JSON.stringify({loggedIn:true,authMethod:mode,apiProvider:'firstParty',subscriptionType:mode==='claude.ai'?'pro':null}));");
 const ws=path.join(d,'ws');await mkdir(ws);await writeFile(path.join(ws,'local-api-mode'),'1');
 const a={id:'x',command:'node',authCheck:{args:[f],parser:'claude-json'}};
 assert.equal((await checkAuth(a,{PATH:process.env.PATH},{},null,ws)).state,'api_key');
 assert.equal((await checkAuth(a,{PATH:process.env.PATH},{},null,d)).state,'subscription');
});
test('V10: login URLs lose fragments and token-bearing queries; OAuth state/code_challenge survive',()=>{
 assert.deepEqual(extractLoginHints('Open https://auth.example/cb#access_token=secret now').urls,['https://auth.example/cb']);
 assert.deepEqual(extractLoginHints('Open https://x.example/?access_token=abc').urls,[]);
 assert.equal(sanitizeLoginUrl('https://claude.ai/oauth/authorize?code=true&client_id=1&state=xyz&code_challenge=abc'),'https://claude.ai/oauth/authorize?code=true&client_id=1&state=xyz&code_challenge=abc');
});
test('V11: a timed-out CLI that exits 0 is cli_timeout, not done',async()=>{
 const d=await tmp();const f=path.join(d,'t.mjs');
 await writeFile(f,"process.on('SIGTERM',()=>{console.log(JSON.stringify({text:'partial',session:'s'}));process.exit(0)});console.log('ready');setInterval(()=>{},1000);");
 const err=await runAdapter({id:'t',command:'node',args:[f],parse:'mock-json'},{prompt:'hi',cwd:d,timeoutMs:250,evidenceDir:path.join(d,'ev')}).then(()=>null,e=>e);
 assert.equal(err.message,'cli_timeout');assert.equal(err.timedOut,true);assert.equal(err.exitCode,0);
});
test('V12: a grandchild left behind by a normally exiting CLI is killed with its group',async()=>{
 const d=await tmp();const bg=path.join(d,'bg.mjs');await writeFile(bg,'setInterval(()=>{},1000)');
 const parent=path.join(d,'p.mjs');await writeFile(parent,`import {spawn} from 'node:child_process';const c=spawn(process.execPath,[${JSON.stringify(bg)}],{stdio:'ignore'});console.log(JSON.stringify({text:String(c.pid),session:'s'}));c.unref();`);
 const r=await runAdapter({id:'p',command:'node',args:[parent],parse:'mock-json'},{prompt:'hi',cwd:d,timeoutMs:3000});const pid=Number(r.text);
 await new Promise(r=>setTimeout(r,150));
 let state=null;try{state=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]?.[0];}catch{}
 assert.ok(state===null||state==='Z','grandchild not running (state '+state+')');
 try{process.kill(pid,'SIGKILL');}catch{}
});
test('V13: when state.json cannot be written the answer is not reported as done',async t=>{
 const s=await startServer([mockAdapter('mock',{args:[MOCK,'--mode','stream']})],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS});t.after(()=>s.srv.kill());
 const a=await s.login();await a.as('/api/state');
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'x',targets:['mock']})});
 await mkdir(path.join(s.userDir,'state.json.tmp'));   // 질문은 저장된 뒤, 답변 저장만 실패하게
 const st=await wait(a.as,1);const m=st.messages.at(-1);
 assert.equal(m.status,'error');assert.equal(m.error,'persist_failed');assert.equal(m.unstoredAnswer,true);assert.match(m.text,/받은 프롬프트/);
});
test('V14+V15: after a restart stale running messages become interrupted and auth state is refreshed without user action',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS});t.after(()=>s.srv.kill());
 const a=await s.login();await a.as('/api/state');s.srv.kill();await new Promise(r=>setTimeout(r,300));
 const f=path.join(s.userDir,'state.json');
 await writeFile(f,JSON.stringify({messages:[{id:1,role:'assistant',adapter:'mock',status:'running',text:'',at:new Date().toISOString()}],sessions:{mock:'prev'},nextId:2,usage:{},epochs:{}}));
 const port=20787+Math.floor(Math.random()*2000);
 const srv2=spawn('node',['src/server.mjs'],{cwd:s.dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription'},stdio:['ignore','pipe','pipe']});t.after(()=>srv2.kill());
 await new Promise(r=>srv2.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
 const base=`http://127.0.0.1:${port}`;const l=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({password:PASS})});const cookie=l.headers.get('set-cookie').split(';')[0];
 let st;for(let i=0;i<40;i++){st=await (await fetch(base+'/api/state',{headers:{cookie}})).json();if(st.adapters[0].auth?.state==='subscription')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(st.messages[0].status,'error');assert.equal(st.messages[0].error,'interrupted');
 assert.equal(st.adapters[0].auth?.state,'subscription','auth refreshed at boot');
 assert.equal(JSON.parse(await readFile(f,'utf8')).messages[0].status,'error','persisted');
});
test('V17: Claude cache tokens count toward the budget; Codex cached_input is not double counted',()=>{
 assert.deepEqual(normalizeUsage({input_tokens:10,output_tokens:20,cache_read_input_tokens:10000,cache_creation_input_tokens:2000}),{input:12010,output:20});
 assert.deepEqual(normalizeUsage({input_tokens:100,output_tokens:5,cached_input_tokens:60}),{input:100,output:5});
});
test('V18: two overlapping questions to the same AI run one after another on one session; orchestrator tasks never touch it',async t=>{
 const s=await startServer([mockAdapter('lead'),mockAdapter('w')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS});t.after(()=>s.srv.kill());
 const a=await s.login();
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'first',targets:['lead']})});await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'second',targets:['lead']})});
 let st=await wait(a.as,2);const done=st.messages.filter(m=>m.role==='assistant');
 assert.equal(done[1].session,done[0].session,'second resumed the first session');assert.equal(st.adapters.find(x=>x.id==='lead').session,done[0].session);
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'goal',mode:'orchestrate',lead:'lead',workers:['w']})});
 st=await wait(a.as,5);const task=st.messages.find(m=>m.kind==='task');
 assert.ok(task&&task.status==='done');assert.equal(st.adapters.find(x=>x.id==='w').session,null,'task did not leave a session on the worker');
});
test('V19: every store write bumps a monotonic seq; the client keeps the newer message',async()=>{
 const st=new Store(new URL('file://'+path.join(await tmp(),'s.json')));
 const m=st.add({role:'user',text:'a'});const s1=m.seq;st.update(m.id,{text:'b'});assert.ok(m.seq>s1);
 const src=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('function mergeSnapshot('),src.indexOf('function connect('));
 const vm=await import('node:vm');const ctx={state:{messages:[{id:1,status:'error',error:'plan_parse_failed',seq:5}]},partials:{}};
 vm.runInNewContext(code+"\nmergeSnapshot({messages:[{id:1,status:'done',text:'old',seq:3}]});",ctx);
 assert.equal(ctx.state.messages[0].status,'error','older snapshot (seq 3) does not overwrite seq 5');
 ctx.state.messages=[{id:1,status:'error'}];vm.runInNewContext("mergeSnapshot({messages:[{id:1,status:'done'}]});",ctx);
 assert.equal(ctx.state.messages[0].status,'error','without seq a terminal state is not flipped');
});
test('V20: mentions need a leading boundary and an exact alias (emails and scoped packages are not mentions)',async()=>{
 const src=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const code=src.slice(src.indexOf('const ALIAS='),src.indexOf('async function send()'));
 const vm=await import('node:vm');const ctx={state:{adapters:[{id:'claude',label:'Claude'},{id:'codex',label:'ChatGPT (Codex)'},{id:'gemini',label:'Gemini'}]}};
 vm.runInNewContext(code,ctx);const p=t=>[...vm.runInNewContext('parseMentions('+JSON.stringify(t)+')',ctx)];
 assert.deepEqual(p('메일: user@claude.com'),[]);assert.deepEqual(p('문서: @google-cloud/storage'),[]);assert.deepEqual(p('일반 인용: @클라우드 비용'),[]);
 assert.deepEqual(p('@클로드 이거 봐줘'),['claude']);assert.deepEqual(p('오늘 @코덱스에게 리뷰 맡김'),['codex']);assert.deepEqual(p('@chatgpt 와 @gemini 둘 다'),['codex','gemini']);
});
// ---- 재검수 V22~V25 ----
test('V22: v0.7.0 data (no authVersion, sessions without v) is migrated: owner kept, old sessions dropped, login works',async t=>{
 const d=await tmp();
 // v0.7.0 과 같은 형식: authVersion 없음, 세션에 v 없음 (해시 알고리즘은 동일)
 const o=new Owner(d);await o.load();await o.setup({password:PASS});const tok=(await o.login({password:PASS,key:'k'})).token;
 const of=JSON.parse(await readFile(path.join(d,'owner.json'),'utf8'));delete of.authVersion;await writeFile(path.join(d,'owner.json'),JSON.stringify(of));
 const sf=JSON.parse(await readFile(path.join(d,'sessions.json'),'utf8'));for(const v of Object.values(sf.sessions))delete v.v;await writeFile(path.join(d,'sessions.json'),JSON.stringify(sf));
 const m=new Owner(d);await m.load();
 assert.equal(m.authVersion,1);assert.deepEqual(m.migrated,['owner_auth_version','sessions_dropped:1']);
 assert.equal(m.userForToken(tok),null,'legacy session requires re-login');
 assert.ok((await m.login({password:PASS,key:'k'})).token,'old password still works');
 const again=new Owner(d);await again.load();assert.equal(again.migrated,undefined,'migration is one-time');
 // 서버도 그 데이터로 뜬다
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());s.srv.kill();await new Promise(r=>setTimeout(r,200));
 await mkdir(path.join(s.dir,'data'),{recursive:true});await writeFile(path.join(s.dir,'data/owner.json'),JSON.stringify(of));await writeFile(path.join(s.dir,'data/sessions.json'),JSON.stringify(sf));
 const port=20787+Math.floor(Math.random()*2000);const srv2=spawn('node',['src/server.mjs'],{cwd:s.dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription'},stdio:['ignore','pipe','pipe']});t.after(()=>srv2.kill());
 const up=await new Promise(r=>{srv2.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r(true);});srv2.on('exit',()=>r(false));});assert.equal(up,true,'server starts on legacy data');
 const base=`http://127.0.0.1:${port}`;assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({password:PASS})})).status,200);
});
test('V23: a login whose scrypt started before a password change cannot be issued a session afterwards',async()=>{
 const d=await tmp();const o=new Owner(d);await o.load();await o.setup({password:PASS});
 const hooks=await import('node:async_hooks');let count=0,loginP;const started=new Promise(r=>{const h=hooks.createHook({init(_id,type){if(type!=='SCRYPTREQUEST')return;if(++count===2){loginP=o.login({password:PASS,key:'inflight'});r();}}});h.enable();});
 const change=o.changePassword({current:PASS,next:'brand new password 2'});await started;await change;const l=await loginP;
 assert.equal(count>=2,true,'hook observed the second scrypt');assert.equal(o.authVersion,2);
 // 두 결말만 허용: (a) 변경이 먼저 커밋돼 발급 거부, (b) 변경 전에 발급됐지만 v=1 이라 커밋 즉시 무효. 어느 쪽이든 옛 비밀번호로 "변경 후에도 유효한" 세션은 없다.
 if(l.token){assert.equal(o.userForToken(l.token),null,'session issued before the commit is dead after it');const r=new Owner(d);await r.load();assert.equal(r.userForToken(l.token),null);}
 else assert.equal(l.error,'login_invalid');
 assert.ok((await o.login({password:'brand new password 2',key:'x'})).token);
});
test('V24: forged X-Forwarded-For from an untrusted peer is ignored; client-prepended hops are skipped; rotating keys hits the global gate',async t=>{
 // 신뢰 프록시 목록이 있고 소켓 상대(127.0.0.1)가 그 안에 없으면 헤더는 무시된다 → 같은 키 → 11번째는 429
 const u=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1',HUB_TRUSTED_PROXIES:'10.0.0.0/8'});t.after(()=>u.srv.kill());
 for(let i=0;i<10;i++)await u.login('wrong password!!',{'x-forwarded-for':`198.51.100.${i}`});
 assert.equal((await u.login(PASS,{'x-forwarded-for':'198.51.100.99'})).status,429);
 // 소켓 상대가 신뢰 범위(127.0.0.0/8)면 오른쪽부터 읽어 첫 비신뢰 값이 키: 클라이언트가 앞에 붙인 값은 무시
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1',HUB_TRUSTED_PROXIES:'127.0.0.0/8,10.0.0.0/8'});t.after(()=>s.srv.kill());
 for(let i=0;i<10;i++)await s.login('wrong password!!',{'x-forwarded-for':`fake${i}, 203.0.113.5, 10.0.0.2`});
 assert.equal((await s.login(PASS,{'x-forwarded-for':'other, 203.0.113.5, 10.0.0.2'})).status,429,'real client 203.0.113.5 locked regardless of prepended junk');
 assert.equal((await s.login(PASS,{'x-forwarded-for':'203.0.113.6, 10.0.0.2'})).status,200,'another real client fine');
 assert.equal((await s.login('wrong password!!',{'x-forwarded-for':'not-an-ip'})).status,401);
 // 직접 노출(HUB_TRUST_PROXY=1, 목록 없음)에서 키를 돌려도 전체 실패 20회/분 뒤엔 모두 429
 const g=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1'});t.after(()=>g.srv.kill());
 const codes=[];for(let i=0;i<30;i++)codes.push((await g.login('wrong password!!',{'x-forwarded-for':`198.51.100.${i}`})).status);
 assert.ok(codes.slice(0,20).every(c=>c===401)&&codes.slice(20).every(c=>c===429),codes.join(','));
});
test('V25: after SIGTERM the grace period is honoured for a grandchild even when the parent exits first; a normally exiting parent still kills leftovers',async()=>{
 const {spawnChild,terminateChild}=await import('../src/adapters/index.mjs');
 const d=await tmp();const ready=path.join(d,'ready'),cleanup=path.join(d,'cleanup');
 await writeFile(path.join(d,'bg.mjs'),`import {writeFileSync} from 'node:fs';process.on('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(cleanup)},'ok');process.exit(0);},250));writeFileSync(${JSON.stringify(ready)},'1');setInterval(()=>{},1000);`);
 await writeFile(path.join(d,'parent.mjs'),`import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(path.join(d,'bg.mjs'))}],{stdio:'ignore'});setInterval(()=>{},1000);`);
 const p=spawnChild('node',[path.join(d,'parent.mjs')],{cwd:d,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
 for(let i=0;i<100;i++){try{await readFile(ready);break;}catch{await new Promise(r=>setTimeout(r,10));}}
 const closed=new Promise(r=>p.once('close',r));terminateChild(p,1000);await closed;await new Promise(r=>setTimeout(r,400));
 assert.equal(await readFile(cleanup,'utf8'),'ok','grandchild finished its SIGTERM cleanup inside the grace');
});
test('V26: a malformed HUB_TRUSTED_PROXIES entry refuses to start instead of trusting everyone; empty prefix and /33 included',async t=>{
 for(const bad of ['192.0.2.0/33','192.0.2.0/','not-an-ip','192.0.2.1,10.0.0.0/8,2001:db8::/129','192.0.2.0/ 24'])
 {const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1',HUB_TRUSTED_PROXIES:bad});t.after(()=>s.srv.kill());assert.equal(s.started,false,bad);assert.match(s.log(),/HUB_TRUSTED_PROXIES/);}
 // 올바른 목록인데 peer(127.0.0.1)가 밖이면 헤더 무시 → https Origin 은 거부
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1',HUB_TRUSTED_PROXIES:'192.0.2.0/24'});t.after(()=>s.srv.kill());
 const r=await s.call('/api/login',{method:'POST',headers:{'x-forwarded-proto':'https',origin:'https://127.0.0.1:'+s.port},body:JSON.stringify({password:PASS})});assert.equal(r.status,403);
 assert.equal((await s.login()).status,200,'plain login still fine');
});
test('V27: IPv4-mapped and compressed IPv6 forms of the peer match the rule; embedded dotted IPv4 is compared exactly',async t=>{
 const {buildTrusted}=await import('../src/trusted.mjs');
 // 검수자의 표 그대로 + 자기 일치
 const T=(rule,ip)=>buildTrusted(rule).check(ip);
 assert.equal(T('::ffff:127.0.0.1/128','::ffff:127.0.0.1'),true);
 assert.equal(T('::ffff:127.0.0.0/120','::ffff:127.0.0.1'),true);
 assert.equal(T('127.0.0.1','::ffff:127.0.0.1'),true,'IPv4 rule matches the mapped form of the same peer');
 assert.equal(T('127.0.0.0/8','::ffff:127.0.0.1'),true);
 assert.equal(T('2001:db8::192.0.2.2/128','2001:db8::192.0.2.1'),false,'embedded dotted IPv4 compared exactly');
 assert.equal(T('2001:db8::192.0.2.2/128','2001:db8::c000:202'),true,'dotted and hex forms are the same address');
 assert.equal(T('2001:db8::/32','2001:0db8:0000:0000:0000:0000:0000:0001'),true,'compressed vs expanded');
 assert.equal(T('10.0.0.0/8','not-an-ip'),false);
 assert.equal(buildTrusted('').trustAll,true);assert.equal(buildTrusted('  ').trustAll,true);
 for(const bad of ['192.0.2.0/33','192.0.2.0/','2001:db8::/129','x','192.0.2.0/24,oops','192.0.2.0//24'])assert.throws(()=>buildTrusted(bad),/trusted_proxy_invalid/,bad);
 assert.doesNotThrow(()=>buildTrusted('0.0.0.0/0'),'explicit /0 is allowed');
 // 실제 HTTP: 서버를 :: 에 띄우고 127.0.0.1 로 접속 (IPv6 없는 환경이면 건너뜀)
 const net=await import('node:net');const can=await new Promise(r=>{const sv=net.createServer();sv.once('error',()=>r(false));sv.listen(0,'::',()=>{sv.close();r(true);});});
 if(!can){t.diagnostic('IPv6 unavailable here; HTTP part skipped');return;}
 for(const rule of ['127.0.0.1','::ffff:127.0.0.1/128','::ffff:127.0.0.0/120']){
  const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription',HUB_PASSWORD:PASS,HUB_TRUST_PROXY:'1',HUB_TRUSTED_PROXIES:rule,HOST:'::'});t.after(()=>s.srv.kill());
  const r=await s.call('/api/login',{method:'POST',headers:{'x-forwarded-proto':'https',origin:'https://127.0.0.1:'+s.port},body:JSON.stringify({password:PASS})});assert.equal(r.status,200,rule);
 }
});
test('V28: ANSI colour codes around a login URL or code are stripped (found in production with Codex 0.163)',async()=>{
 const {stripAnsi}=await import('../src/adapters/index.mjs');
 const out='\x1b[1mOpen \x1b[4mhttps://auth.openai.com/codex/device\x1b[0m\x1b[24m and enter \x1b[32mABCD-12345\x1b[0m\n';
 const h=extractLoginHints(out);
 assert.deepEqual(h.urls,['https://auth.openai.com/codex/device']);assert.deepEqual(h.codes,['ABCD-12345']);
 assert.equal(stripAnsi('\x1b]8;;https://x.example\x07link\x1b]8;;\x07'),'link','OSC hyperlinks stripped too');
 assert.equal(maskLine('\x1b[31mtoken=abc\x1b[0m'),'token=[가림]');
});
test('V29 (v0.8 Gemini): file-based auth status → only Google-account OAuth with refresh_token passes; API key / Vertex blocked; no creds = not_logged_in',async()=>{
 const {loadConfig,AUTH_PARSERS,PARSERS}=await import('../src/adapters/index.mjs');
 const cfg=await loadConfig();const g=cfg.adapters.find(a=>a.id==='gemini');assert.equal(g.authCheck.parser,'gemini-json');assert.equal(g.login.command,'node');
 const H=await mkdtemp(path.join(os.tmpdir(),'gem-'));await mkdir(path.join(H,'.gemini'),{recursive:true});
 assert.equal((await checkAuth(g,process.env,{HOME:H})).state,'not_logged_in');
 await writeFile(path.join(H,'.gemini/settings.json'),JSON.stringify({security:{auth:{selectedType:'oauth-personal'}}}));
 await writeFile(path.join(H,'.gemini/oauth_creds.json'),JSON.stringify({access_token:'a',refresh_token:'r',expiry_date:1}));
 const ok=await checkAuth(g,process.env,{HOME:H});assert.equal(ok.state,'subscription');assert.ok(!JSON.stringify(ok).includes('"r"'),'no token values leak');
 await writeFile(path.join(H,'.gemini/oauth_creds.json'),JSON.stringify({access_token:'a',expiry_date:1}));
 assert.equal((await checkAuth(g,process.env,{HOME:H})).state,'not_logged_in','expired access token without refresh token → re-login');
 for(const [t,st] of [['gemini-api-key','api_key'],['vertex-ai','third_party'],['cloud-shell','third_party']]){await writeFile(path.join(H,'.gemini/settings.json'),JSON.stringify({security:{auth:{selectedType:t}}}));assert.equal((await checkAuth(g,process.env,{HOME:H})).state,st,t);}
 assert.equal(AUTH_PARSERS['gemini-json']('nope').state,'unverified');
 // -o json 의 stats.models 토큰 합산
 const r=PARSERS['gemini-json'](JSON.stringify({response:'hi',stats:{models:{'gemini-2.5-pro':{tokens:{prompt:10,candidates:5,thoughts:2}},'gemini-2.5-flash':{tokens:{prompt:3,candidates:1}}}}}));
 assert.equal(r.text,'hi');assert.deepEqual(normalizeUsage(r.usage),{input:13,output:8});
 // 로그인 힌트: 토큰 교환 endpoint 는 제외, 틀린 코드 뒤 재발급된 URL 이 먼저
 const h=extractLoginHints('visit https://accounts.google.com/o/oauth2/v2/auth?a=1\nEnter code:\nPOST https://oauth2.googleapis.com/token failed\nvisit https://accounts.google.com/o/oauth2/v2/auth?a=2\n');
 assert.deepEqual(h.urls,['https://accounts.google.com/o/oauth2/v2/auth?a=2','https://accounts.google.com/o/oauth2/v2/auth?a=1']);
 await rm(H,{recursive:true,force:true});
});
test('cleanup',async()=>{await terminateAll(200);});
