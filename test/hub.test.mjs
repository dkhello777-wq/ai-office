import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import http from 'node:http';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
import {runAdapter,PARSERS,STREAM_PARSERS,probeAdapter,buildChildEnv,checkAuth,AUTH_PARSERS,loadConfig,ROOT,startLogin,extractLoginHints,maskLine} from '../src/adapters/index.mjs';
import {extractPlan} from '../src/orchestrate.mjs';
import {Store,normalizeUsage} from '../src/store.mjs';
import {Accounts,USERNAME_RE} from '../src/accounts.mjs';
import {stat,chmod} from 'node:fs/promises';

const MOCK=new URL('../src/adapters/mock-cli.mjs',import.meta.url).pathname;
const mock=(extra={})=>({id:'mock',command:'node',args:[MOCK],resumeArgs:['--session','{session}'],parse:'mock-json',...extra});
const sha=b=>createHash('sha256').update(b).digest('hex');
const tmp=()=>mkdtemp(path.join(os.tmpdir(),'hub-'));

test('mock adapter round trip keeps the full prompt and returns a session',async()=>{
 const prompt='가'.repeat(50000)+'\n둘째 줄';
 const r=await runAdapter(mock(),{prompt,cwd:os.tmpdir()});
 assert.match(r.text,/받은 프롬프트 50005자/);assert.ok(r.session);assert.equal(r.exitCode,0);
 const r2=await runAdapter(mock(),{prompt:'again',cwd:os.tmpdir(),session:r.session});assert.equal(r2.session,r.session);
});
test('missing CLI is reported, not crashed',async()=>{
 await assert.rejects(runAdapter(mock({command:'definitely-missing-cli-xyz'}),{prompt:'x',cwd:os.tmpdir()}),/cli_not_found/);
 assert.equal((await probeAdapter(mock({command:'definitely-missing-cli-xyz'}))).installed,false);
});
test('parsers extract text and session from each CLI shape',()=>{
 assert.deepEqual(PARSERS['claude-json'](JSON.stringify({result:'답',session_id:'s1',usage:{input_tokens:1}})).text,'답');
 const codex=PARSERS['codex-jsonl']('{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"코덱스 답"}}\n');
 assert.equal(codex.text,'코덱스 답');assert.equal(codex.session,'t1');
 assert.equal(PARSERS['gemini-json'](JSON.stringify({response:'제미나이 답'})).text,'제미나이 답');
 assert.equal(PARSERS['gemini-json']('plain text output').text,'plain text output');
});

// ---- F1: stdout/stderr 원문 전체 보존 (길이·해시 대조), 비정상 종료·파싱 실패·정상 종료 ----
test('F1 failure: long stdout AND stderr are both preserved byte-exact as evidence; status carries only summary',async()=>{
 const dir=path.join(await tmp(),'ev');
 const err=await runAdapter(mock({args:[MOCK,'--mode','fail']}),{prompt:'x',cwd:os.tmpdir(),evidenceDir:dir}).then(()=>null,e=>e);
 assert.equal(err.message,'cli_exit_3');assert.equal(err.exitCode,3);
 const so=await readFile(path.join(dir,'stdout.bin')),se=await readFile(path.join(dir,'stderr.bin')),meta=JSON.parse(await readFile(path.join(dir,'meta.json'),'utf8'));
 assert.equal(so.toString(),'BEGIN-STDOUT '+'x'.repeat(9000)+' END-STDOUT\n');assert.equal(se.toString(),'BEGIN-STDERR '+'y'.repeat(9000)+' END-STDERR\n');
 assert.equal(meta.stdoutBytes,so.length);assert.equal(meta.stdoutSha256,sha(so));assert.equal(meta.stderrBytes,se.length);assert.equal(meta.stderrSha256,sha(se));assert.equal(meta.exitCode,3);
 assert.equal(err.evidence.stdoutSha256,meta.stdoutSha256);assert.equal(err.evidence.stderrSha256,meta.stderrSha256);
 assert.ok(err.stdout.startsWith('BEGIN-STDOUT')&&err.stdout.endsWith('END-STDOUT\n'));
});
test('F1 parse failure keeps raw stdout evidence and reports parseError',async()=>{
 const dir=path.join(await tmp(),'ev');
 const err=await runAdapter(mock({args:[MOCK,'--mode','badjson']}),{prompt:'x',cwd:os.tmpdir(),evidenceDir:dir}).then(()=>null,e=>e);
 assert.equal(err.message,'parse_failed');assert.equal(err.exitCode,0);assert.equal(err.parseFailed,true);
 assert.equal((await readFile(path.join(dir,'stdout.bin'))).toString(),'{"text": "unterminated');
 assert.ok(JSON.parse(await readFile(path.join(dir,'meta.json'),'utf8')).parseError);
});
test('F1 success also writes evidence and links hash into the result',async()=>{
 const dir=path.join(await tmp(),'ev');
 const r=await runAdapter(mock(),{prompt:'정상',cwd:os.tmpdir(),evidenceDir:dir});
 assert.equal(r.evidence.stdoutSha256,sha(await readFile(path.join(dir,'stdout.bin'))));assert.equal(r.evidence.exitCode,0);
});

// ---- R2: 증거 권한 0700/0600 (umask 022 에서도) ----
test('R2 evidence dir is 0700 and files 0600 regardless of umask',async()=>{
 const old=process.umask(0o022);try{
  const dir=path.join(await tmp(),'ev');await runAdapter(mock(),{prompt:'x',cwd:os.tmpdir(),evidenceDir:dir});
  assert.equal((await stat(dir)).mode&0o777,0o700);
  for(const f of ['stdout.bin','stderr.bin','meta.json'])assert.equal((await stat(path.join(dir,f))).mode&0o777,0o600,f);
 }finally{process.umask(old);}
});
// ---- R3: 증거 저장 실패는 성공이 아니다 ----
test('R3 evidence write failure rejects with evidence_write_failed and still hands back the body',async()=>{
 const base=await tmp();const dirAsFile=path.join(base,'ev');await writeFile(dirAsFile,'occupied');
 const err=await runAdapter(mock(),{prompt:'본문 보존',cwd:os.tmpdir(),evidenceDir:dirAsFile}).then(()=>null,e=>e);
 assert.equal(err.message,'evidence_write_failed');assert.equal(err.exitCode,0);assert.match(err.text,/받은 프롬프트/);
});
// ---- R4: 파싱 원본 예외는 로컬 meta 에만 ----
test('R4 malformed JSON: exception text stays in local meta.json, never in the rejection or summary',async()=>{
 const dir=path.join(await tmp(),'ev');
 const err=await runAdapter(mock({args:[MOCK,'--mode','badjson']}),{prompt:'x',cwd:os.tmpdir(),evidenceDir:dir}).then(()=>null,e=>e);
 assert.equal(err.message,'parse_failed');assert.equal(err.parseFailed,true);assert.equal(err.parseError,undefined);
 assert.ok(!JSON.stringify({m:err.message,e:err.evidence}).includes('unterminated'));
 const meta=JSON.parse(await readFile(path.join(dir,'meta.json'),'utf8'));assert.ok(meta.parseError.includes('JSON'));assert.equal(meta.parseFailed,true);
 assert.equal((await readFile(path.join(dir,'stdout.bin'))).toString(),'{"text": "unterminated');
});

// ---- F4: UTF-8 청크 경계 ----
test('F4 multibyte characters split across chunks survive in stdout, stderr and evidence',async()=>{
 const dir=path.join(await tmp(),'ev');
 const r=await runAdapter(mock({args:[MOCK,'--mode','split']}),{prompt:'x',cwd:os.tmpdir(),evidenceDir:dir});
 const expected='가나다😀 한글 응답 '.repeat(300);
 assert.equal(r.text,expected);assert.ok(!r.text.includes('\uFFFD'));
 assert.equal(r.stderr,'경고: 다중바이트 stderr 😀\n');
 assert.equal((await readFile(path.join(dir,'stdout.bin'))).toString('utf8'),JSON.stringify({text:expected,session:r.session,usage:null}));
});

// ---- F2: 환경 허용 목록 + 인증 상태 게이트 ----
test('F2 child env: only allow-listed names pass; provider keys/endpoints never pass even if allow-listed',async()=>{
 const parent={PATH:process.env.PATH,HOME:'/x',HUB_REVIEW_MARKER:'synthetic-non-secret-marker',FAKE_API_KEY:'not-a-real-key',FAKE_BASE_URL:'http://x',ANTHROPIC_API_KEY:'not-real',OPENAI_BASE_URL:'http://y'};
 const a=mock({args:[MOCK,'--mode','envdump'],envAllow:['HUB_REVIEW_MARKER','FAKE_API_KEY','FAKE_BASE_URL']});
 const {env,blockedNames}=buildChildEnv(parent,a);
 assert.deepEqual(Object.keys(env).sort(),['HOME','HUB_REVIEW_MARKER','PATH']);
 assert.deepEqual(blockedNames,['ANTHROPIC_API_KEY','FAKE_API_KEY','FAKE_BASE_URL','OPENAI_BASE_URL']);
 const r=await runAdapter(a,{prompt:'x',cwd:os.tmpdir(),parentEnv:parent});
 assert.equal(r.text,'env:HUB_REVIEW_MARKER,PATH');assert.deepEqual(r.envBlockedNames,blockedNames);
});
test('R1: deployed Claude authCheck parser — only claude.ai/firstParty/subscription passes; api_key, helper, third_party, oauth blocked',async()=>{
 const cfg=await loadConfig();const claude=cfg.adapters.find(a=>a.id==='claude');
 assert.equal(claude.authCheck.parser,'claude-json');
 const parse=AUTH_PARSERS[claude.authCheck.parser];
 const F=(authMethod,apiProvider,subscriptionType,loggedIn=true)=>JSON.stringify({loggedIn,authMethod,apiProvider,subscriptionType});
 assert.equal(parse(F('claude.ai','firstParty','pro')).state,'subscription');
 assert.equal(parse(F('claude.ai','firstParty','max')).state,'subscription');
 assert.equal(parse(F('api_key','firstParty',null)).state,'api_key');
 assert.equal(parse(F('api_key_helper','firstParty',null)).state,'api_key');
 assert.equal(parse(F('third_party','bedrock',null)).state,'third_party');
 assert.equal(parse(F('claude.ai','vertex','pro')).state,'third_party');
 assert.equal(parse(F('oauth_token','firstParty',null)).state,'unverified');
 assert.equal(parse(F('claude.ai','firstParty',null)).state,'unverified');            // subscriptionType null
 assert.equal(parse(F('claude.ai','firstParty','pro',false)).state,'not_logged_in');  // loggedIn false
 assert.equal(parse('{"loggedIn":true}').state,'unverified');
 assert.equal(parse('SYNTHETIC_PRIVATE_MARKER is not json').state,'unverified');assert.equal(parse('SYNTHETIC_PRIVATE_MARKER is not json').reason,'malformed_json');
 assert.equal(parse('[]').state,'unverified');
 // 노출 필드는 허용 목록뿐: 원문 출력이 결과에 없다
 for(const r of [parse(F('api_key','firstParty',null)),parse('SYNTHETIC_PRIVATE_MARKER is not json')])assert.deepEqual(Object.keys(r).filter(k=>!['state','reason','authMethod','apiProvider','subscriptionType'].includes(k)),[]);
});
test('R1: deployed config end-to-end — mock CLI emitting the four fixtures with stderr noise; stdout JSON judged alone, nothing raw returned',async()=>{
 const cfg=await loadConfig();const claude=cfg.adapters.find(a=>a.id==='claude');
 // 배포 config 의 authCheck.parser 를 그대로 쓰되 실행 파일만 모의 CLI 로 바꾼다 (실제 claude 미실행)
 const a={...claude,command:'node',envAllow:['MOCK_AUTH_JSON'],authCheck:{...claude.authCheck,args:[MOCK,'--auth-status']}};
 const run=json=>checkAuth(a,{PATH:process.env.PATH,MOCK_AUTH_JSON:json});
 const F=(m,p,t)=>JSON.stringify({loggedIn:true,authMethod:m,apiProvider:p,subscriptionType:t});
 const r1=await run(F('claude.ai','firstParty','pro'));assert.equal(r1.state,'subscription');assert.ok(r1.stderrBytes>0,'stderr warning was emitted and kept separate');
 assert.equal((await run(F('api_key','firstParty',null))).state,'api_key');
 assert.equal((await run(F('api_key_helper','firstParty',null))).state,'api_key');
 assert.equal((await run(F('third_party','bedrock',null))).state,'third_party');
 assert.equal((await run('{"loggedIn":false}')).state,'not_logged_in');
 const bad=await run('SYNTHETIC_PRIVATE_MARKER is not json');assert.equal(bad.state,'unverified');assert.ok(!JSON.stringify(bad).includes('SYNTHETIC_PRIVATE_MARKER'));
 assert.equal((await checkAuth(mock(),{PATH:process.env.PATH})).state,'unverified'); // authCheck 미설정
});
test('R1: Codex text parser is line-anchored',()=>{
 const p=AUTH_PARSERS['codex-text'];
 assert.equal(p('Logged in using ChatGPT\n').state,'subscription');
 assert.equal(p('Logged in using an API key\n').state,'api_key');
 assert.equal(p('Not logged in\n').state,'not_logged_in');
 assert.equal(p('something else\n').state,'unverified');assert.equal(p('').state,'unverified');
});

// ---- v0.4 단위: 계정·초대·세션 / extraEnv / 로그인 힌트 추출 ----
test('v0.4 accounts: invite-only signup, scrypt hash only on disk, one-time invite, lockout after 10 failures',async()=>{
 const dir=await tmp();const acc=new Accounts(dir);await acc.load();
 const code=await acc.ensureBootstrap();assert.ok(code&&code.length>=16);
 assert.equal((await acc.signup({inviteCode:'wrong',username:'alice',password:'correct horse battery'})).error,'invite_invalid');
 assert.equal((await acc.signup({inviteCode:code,username:'Al',password:'correct horse battery'})).error,'username_invalid');
 assert.equal((await acc.signup({inviteCode:code,username:'alice',password:'short'})).error,'password_too_short');
 const a=await acc.signup({inviteCode:code,username:'Alice',password:'correct horse battery'});assert.equal(a.user.role,'admin');assert.equal(a.user.username,'alice');
 assert.equal((await acc.signup({inviteCode:code,username:'bob',password:'another long password'})).error,'invite_invalid','invite is single-use');
 const raw=await readFile(path.join(dir,'accounts.json'),'utf8');assert.ok(!raw.includes('correct horse battery')&&!raw.includes(code),'no plaintext password or invite code on disk');
 assert.equal(((await stat(path.join(dir,'accounts.json'))).mode&0o077),0);
 const inv=await acc.createInvite({createdBy:'alice'});const b=await acc.signup({inviteCode:inv.code,username:'bob',password:'another long password'});assert.equal(b.user.role,'user');
 const l=await acc.login({username:'bob',password:'another long password',key:'k'});assert.ok(l.token);assert.equal(acc.userForToken(l.token).username,'bob');
 assert.equal(acc.userForToken('nope'),null);
 for(let i=0;i<10;i++)assert.equal((await acc.login({username:'bob',password:'wrong password!!',key:'k2'})).error,'login_invalid');
 assert.equal((await acc.login({username:'bob',password:'another long password',key:'k2'})).error,'too_many_attempts');
 await acc.setDisabled(b.user.id,true);assert.equal(acc.userForToken(l.token),null,'disabled user loses sessions');
 assert.equal(await acc.ensureBootstrap(),null,'no bootstrap once users exist');
});
test('v0.4 extraEnv overrides HOME for the child but deny patterns still apply',()=>{
 const {env,blockedNames}=buildChildEnv({PATH:'/bin',HOME:'/real/home',OPENAI_API_KEY:'x'},{id:'t',envAllow:[]},{HOME:'/users/1/home',CLAUDE_CONFIG_DIR:'/users/1/home/.claude',ANTHROPIC_API_KEY:'y'});
 assert.equal(env.HOME,'/users/1/home');assert.equal(env.CLAUDE_CONFIG_DIR,'/users/1/home/.claude');assert.equal(env.ANTHROPIC_API_KEY,undefined);
 assert.deepEqual(blockedNames,['ANTHROPIC_API_KEY','OPENAI_API_KEY']);
});
test('v0.4 login hints: URLs and device codes extracted, nothing else; mock login writes into the given HOME only',async()=>{
 const h=extractLoginHints('Open https://auth.example/device?x=1. in your browser\nEnter code: ABCD-1234\nsecret=do-not-show');
 assert.deepEqual(h.urls,['https://auth.example/device?x=1']);assert.deepEqual(h.codes,['ABCD-1234']);
 const home=path.join(await tmp(),'home');const ev=path.join(await tmp(),'ev');const events=[];
 const run=startLogin({id:'mock',command:'node',login:{args:[MOCK,'--login']}},{cwd:os.tmpdir(),extraEnv:{HOME:home},evidenceDir:ev,onEvent:e=>events.push(e)});
 await new Promise(r=>setTimeout(r,400));run.write('OK');
 const r=await run.done;assert.equal(r.status,'done');assert.deepEqual(r.urls,['https://mock.invalid/device']);assert.deepEqual(r.codes,['MOCK-1234']);
 assert.ok(events.some(e=>e.codes.includes('MOCK-1234')));
 assert.equal((await checkAuth({id:'mock',command:'node',authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'}},{PATH:process.env.PATH},{HOME:home})).state,'subscription');
 assert.equal((await checkAuth({id:'mock',command:'node',authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'}},{PATH:process.env.PATH},{HOME:home+'-other'})).state,'not_logged_in');
 assert.ok((await readFile(path.join(ev,'stdout.bin'),'utf8')).includes('MOCK-1234'));assert.equal(((await stat(path.join(ev,'stdout.bin'))).mode&0o077),0);
});

// ---- 서버 통합: 계정 게이트 + 사용자 격리 + F3 출처/형식 게이트 + F2 호출 중단 + F1 증거 연결 ----
async function startServer(adapters,env={}){
 const dir=await tmp();
 const cfg={adapters,timeoutMs:30000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'},signup:{mode:'invite'},loginTimeoutMs:20000};
 await mkdir(path.join(dir,'config'),{recursive:true});await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify(cfg));
 await spawnOk('cp',['-r',path.join(ROOT,'src'),path.join(ROOT,'public'),dir]);
 const port=18787+Math.floor(Math.random()*2000);
 const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),...env},stdio:['ignore','pipe','pipe']});
 let log='';srv.stderr.on('data',d=>log+=d);
 await new Promise(r=>srv.stdout.on('data',d=>{log+=d;if(String(d).includes('AI Hub'))r();}));
 const base=`http://127.0.0.1:${port}`,host=`127.0.0.1:${port}`;
 const call=(p,o={})=>fetch(base+p,{...o,headers:{'content-type':'application/json',origin:base,...(o.headers??{})}});
 const bootstrap=(await readFile(path.join(dir,'data/bootstrap-invite'),'utf8')).trim();
 const signup=async(invite,username,password='synthetic password 1')=>{const r=await call('/api/signup',{method:'POST',body:JSON.stringify({invite,username,password})});const body=await r.json();if(r.status!==200)return {status:r.status,body};const cookie=r.headers.get('set-cookie').split(';')[0];const as=async(p,o={})=>{const x=await call(p,{...o,headers:{cookie,...(o.headers??{})}});return {status:x.status,body:await x.json()};};return {status:200,body,cookie,as};};
 const admin=await signup(bootstrap,'admin');assert.equal(admin.status,200,JSON.stringify(admin.body));
 const invite=async(role='user')=>(await admin.as('/api/admin/invites',{method:'POST',body:JSON.stringify({role})})).body.code;
 const s={dir,srv,base,host,call,bootstrap,signup,admin,invite,log:()=>log};
 s.auth=admin.as;   // 기본 호출자 = 관리자 계정
 return s;
}
const mockAdapter=(id,extra={})=>({id,label:id,color:'#888',command:'node',args:[MOCK],resumeArgs:['--session','{session}'],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},login:{args:[MOCK,'--login']},...extra});
const wait=async(as,n)=>{for(let i=0;i<60;i++){const st=(await as('/api/state')).body;if(st.messages.filter(m=>m.role==='assistant'&&m.status!=='running').length>=n)return st;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');};

test('v0.4 gate: no session → 401 everywhere and nothing dispatched; bootstrap invite makes the first admin and is then consumed; login/logout; invites are single-use',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 assert.equal((await s.call('/api/send',{method:'POST',body:JSON.stringify({text:'표식',targets:['mock']})})).status,401);
 assert.equal((await s.call('/api/state')).status,401);
 assert.equal((await fetch(s.base+'/api/state?token=anything')).status,401);
 assert.equal((await s.auth('/api/state')).body.messages.length,0);
 assert.ok(!s.admin.cookie.includes(s.bootstrap),'cookie is a session value, not the invite');
 assert.equal((await s.admin.as('/api/me')).body.user.role,'admin');
 assert.equal((await s.signup(s.bootstrap,'intruder')).body.error,'invite_invalid','bootstrap invite is single-use');
 await assert.rejects(stat(path.join(s.dir,'data/bootstrap-invite')),'bootstrap file removed after admin exists');
 const code=await s.invite();const u=await s.signup(code,'user1');assert.equal(u.body.user.role,'user');
 assert.equal((await s.signup(code,'user2')).body.error,'invite_invalid');
 assert.equal((await u.as('/api/admin/users')).status,403,'non-admin cannot reach admin API');
 // 로그인/로그아웃
 const bad=await s.call('/api/login',{method:'POST',body:JSON.stringify({username:'user1',password:'wrong password!!'})});assert.equal(bad.status,401);
 const ok=await s.call('/api/login',{method:'POST',body:JSON.stringify({username:'user1',password:'synthetic password 1'})});assert.equal(ok.status,200);
 const cookie=ok.headers.get('set-cookie').split(';')[0];
 assert.equal((await s.call('/api/me',{headers:{cookie}})).status,200);
 await s.call('/api/logout',{method:'POST',headers:{cookie},body:'{}'});
 assert.equal((await s.call('/api/me',{headers:{cookie}})).status,401,'session invalid after logout');
 // 중지된 사용자는 즉시 차단
 await s.auth('/api/admin/users/disable',{method:'POST',body:JSON.stringify({userId:u.body.user.id,disabled:true})});
 assert.equal((await u.as('/api/state')).status,401);
 assert.equal((await s.auth('/api/admin/users/disable',{method:'POST',body:JSON.stringify({userId:s.admin.body.user.id,disabled:true})})).body.error,'cannot_disable_self');
 const acc=await readFile(path.join(s.dir,'data/accounts.json'),'utf8');assert.ok(!acc.includes('synthetic password 1')&&!acc.includes(code));
});
test('v0.4 isolation: users see only their own messages, files and evidence; CLI login/auth state is per user (separate HOME)',async t=>{
 const s=await startServer([mockAdapter('mock',{envAllow:[]})]);t.after(()=>s.srv.kill());   // MOCK_AUTH 없음 → 각 사용자 HOME 의 표식으로 판정
 const a=await s.signup(await s.invite(),'alice'),b=await s.signup(await s.invite(),'bob');
 // 둘 다 아직 미로그인 → 호출 차단
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'alice 표식',targets:['mock']})});
 let st=await wait(a.as,1);assert.equal(st.messages.at(-1).status,'blocked');assert.equal(st.messages.at(-1).error,'not_logged_in');
 // alice 만 화면에서 CLI 로그인
 const start=await a.as('/api/cli-login',{method:'POST',body:JSON.stringify({adapterId:'mock'})});assert.equal(start.status,200);
 assert.equal((await a.as('/api/cli-login',{method:'POST',body:JSON.stringify({adapterId:'mock'})})).body.error,'login_already_running');
 for(let i=0;i<30;i++){const l=(await a.as('/api/state')).body.adapters[0].login;if(l.codes.includes('MOCK-1234'))break;await new Promise(r=>setTimeout(r,100));}
 let l=(await a.as('/api/state')).body.adapters[0].login;assert.deepEqual(l.urls,['https://mock.invalid/device']);assert.deepEqual(l.codes,['MOCK-1234']);
 assert.equal((await b.as('/api/state')).body.adapters[0].login,null,'bob does not see alice login');
 assert.equal((await b.as('/api/cli-login/input',{method:'POST',body:JSON.stringify({adapterId:'mock',text:'OK'})})).status,409,'bob cannot feed alice login');
 await a.as('/api/cli-login/input',{method:'POST',body:JSON.stringify({adapterId:'mock',text:'OK'})});
 for(let i=0;i<30;i++){l=(await a.as('/api/state')).body.adapters[0];if(l.login.status==='done'&&l.auth?.state==='subscription')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(l.login.status,'done');assert.equal(l.auth.state,'subscription');
 assert.ok(await stat(path.join(s.dir,'data/users',String(a.body.user.id),'home/.mock-auth')));
 await assert.rejects(stat(path.join(s.dir,'data/users',String(b.body.user.id),'home/.mock-auth')),'bob HOME untouched');
 // alice 는 이제 호출됨, bob 은 여전히 차단
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'alice 두번째',targets:['mock']})});st=await wait(a.as,2);assert.equal(st.messages.at(-1).status,'done');
 await b.as('/api/send',{method:'POST',body:JSON.stringify({text:'bob 표식',targets:['mock']})});const sb=await wait(b.as,1);assert.equal(sb.messages.at(-1).status,'blocked');
 // 메시지·파일 격리
 assert.ok(st.messages.every(m=>!String(m.text).includes('bob')));assert.ok(sb.messages.every(m=>!String(m.text).includes('alice')));
 await a.as('/api/files?name=alice.txt',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'alice only'});
 assert.deepEqual((await b.as('/api/state')).body.files,[]);assert.equal((await s.call('/files/alice.txt',{headers:{cookie:b.cookie}})).status,404);
 assert.equal((await s.call('/files/alice.txt',{headers:{cookie:a.cookie}})).status,200);
 assert.equal(((await stat(path.join(s.dir,'data/users',String(a.body.user.id)))).mode&0o077),0,'user dir 0700');
 assert.ok(st.messages.at(-1).evidence.dir.includes(path.join('data/users',String(a.body.user.id),'runs')));
 assert.equal((await s.auth('/api/state')).body.messages.length,0,'admin sees no user messages either');
});
test('F3: wrong Origin, disallowed Host and non-JSON content type are rejected before any side effect (also on signup/login)',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const body=JSON.stringify({text:'검수용 무해한 표식',targets:['mock'],files:[]});
 for(const [label,headers,code] of [['foreign origin',{origin:'https://example.invalid'},'origin_not_allowed'],['missing origin',{origin:''},'origin_not_allowed'],['text/plain',{'content-type':'text/plain'},'json_required']]){
  const r=await s.auth('/api/send',{method:'POST',headers,body});assert.equal(r.body.error,code,label);
  const l=await s.call('/api/login',{method:'POST',headers,body:JSON.stringify({username:'admin',password:'synthetic password 1'})});assert.equal((await l.json()).error,code,'login '+label);
 }
 const rawHost=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:Number(s.host.split(':')[1]),path:'/api/send',method:'POST',headers:{host:'evil.example:80',origin:'http://evil.example:80','content-type':'application/json',cookie:s.admin.cookie}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>resolve(JSON.parse(d)));});req.on('error',reject);req.end(body);});
 assert.equal(rawHost.error,'host_not_allowed');
 assert.equal((await s.auth('/api/state')).body.messages.length,0);
 const f=await s.auth('/api/files?name=x.txt',{method:'POST',headers:{origin:'https://example.invalid','content-type':'application/octet-stream'},body:'x'});assert.equal(f.body.error,'origin_not_allowed');
 assert.deepEqual((await s.auth('/api/state')).body.files,[]);
});
test('F2: api-key auth, not-logged-in and unverified adapters are blocked before any provider call; subscription proceeds',async t=>{
 const s=await startServer([mockAdapter('sub'),mockAdapter('none',{authCheck:null})],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'표식',targets:['sub','none']})});
 const st=await wait(s.auth,2);const by=Object.fromEntries(st.messages.filter(m=>m.role==='assistant').map(m=>[m.adapter,m]));
 assert.equal(by.sub.status,'done');
 assert.equal(by.none.status,'blocked');assert.equal(by.none.error,'auth_unverified');assert.equal(by.none.authCheck.reason,'no_auth_check_configured');
 assert.equal(by.none.text,'',"blocked adapter produced no answer");
});
test('F2: API-key mode detected by the auth check stops the call with api_key_auth_detected',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'apikey'});t.after(()=>s.srv.kill());
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'표식',targets:['mock']})});
 const st=await wait(s.auth,1);const m=st.messages.at(-1);
 assert.equal(m.status,'blocked');assert.equal(m.error,'api_key_auth_detected');assert.ok(Object.keys(m.authCheck).every(k=>['state','reason','authMethod','apiProvider','subscriptionType','exitCode','at'].includes(k)),'only allow-listed fields');assert.equal(m.authCheck.authMethod,'api_key');
 assert.equal((await s.auth('/api/state')).body.adapters[0].auth.state,'api_key');
});
test('R3 server: evidence write failure is recorded as error (not done) with the body preserved',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const runs=path.join(s.dir,'data/users',String(s.admin.body.user.id),'runs');
 await mkdir(runs,{recursive:true});await writeFile(path.join(runs,'2-mock'),'occupied');
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'표식',targets:['mock']})});
 const st=await wait(s.auth,1);const m=st.messages.at(-1);
 assert.equal(m.status,'error');assert.equal(m.error,'evidence_write_failed');assert.equal(m.unstoredAnswer,true);assert.match(m.text,/mock 답변/);assert.equal(m.evidencePreserved,false);
});
test('server: send, handoff, files, evidence dir per attempt, UTF-8 body, child HOME is the user home',async t=>{
 const s=await startServer([mockAdapter('mock'),mockAdapter('mock2',{args:[MOCK,'--mode','envdump']})],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 await s.auth('/api/files?name='+encodeURIComponent('대본.txt'),{method:'POST',headers:{'content-type':'application/octet-stream'},body:'원문 😀 '.repeat(100)});
 const korean='한글😀 혼합 '.repeat(2000);
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:korean,targets:['mock','mock2'],files:['대본.txt']})});
 let st=await wait(s.auth,2);const user=st.messages[0];assert.equal(user.text,korean);
 const replies=st.messages.filter(m=>m.role==='assistant');assert.ok(replies.every(m=>m.status==='done'&&m.evidence?.stdoutSha256&&m.evidence.dir.endsWith(`${m.id}-${m.adapter}`)));
 assert.equal(st.files[0].name,'대본.txt');assert.equal(st.files[0].bytes,Buffer.byteLength('원문 😀 '.repeat(100)));
 const r1=replies.find(m=>m.adapter==='mock');
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'위 답변 검토',targets:['mock'],handoffFrom:r1.id})});
 st=await wait(s.auth,3);assert.ok(st.messages.at(-1).text.includes('[다른 AI(mock)의 답변 전문입니다'));
 const saved=await s.auth('/api/save',{method:'POST',body:JSON.stringify({messageId:r1.id,name:'mock-answer.txt'})});assert.equal(saved.body.name,'mock-answer.txt');
 const shared=path.join(s.dir,'data/users',String(s.admin.body.user.id),'workspace/shared');
 assert.equal(await readFile(path.join(shared,'mock-answer.txt'),'utf8'),r1.text);
 assert.ok((await (await fetch(s.base+'/')).text()).includes('AI Hub'),'static page opens without login');
 // envdump 모의 CLI: 자식에 HOME 이 사용자 home 으로 들어갔는지 (프롬프트 텍스트에 포함되어 돌아옴)
 const meta=JSON.parse(await readFile(path.join(s.dir,'data/users',String(s.admin.body.user.id),'runs',`${replies.find(m=>m.adapter==='mock2').id}-mock2`,'meta.json'),'utf8'));
 assert.equal(meta.adapter,'mock2');
});

// ======================= v0.4 검수(Gemini) 재현 테스트: 패치 전에는 FAIL, 패치 후 PASS =======================
test('audit: concurrent signups cannot reuse single-use invite or create duplicate usernames',async()=>{
 const dir=await tmp();const acc=new Accounts(dir);await acc.load();
 const code=await acc.ensureBootstrap();
 const [r1,r2]=await Promise.all([acc.signup({inviteCode:code,username:'admin1',password:'correct horse battery'}),acc.signup({inviteCode:code,username:'admin2',password:'correct horse battery'})]);
 assert.equal([r1,r2].filter(r=>r.user).length,1,'single-use bootstrap invite must allow only one signup');assert.equal(acc.users.length,1);
 const c1=(await acc.createInvite({createdBy:'admin1'})).code,c2=(await acc.createInvite({createdBy:'admin1'})).code;
 const [u1,u2]=await Promise.all([acc.signup({inviteCode:c1,username:'sameuser',password:'correct horse battery'}),acc.signup({inviteCode:c2,username:'sameuser',password:'correct horse battery'})]);
 assert.equal([u1,u2].filter(r=>r.user).length,1,'concurrent signups must not create duplicate usernames');
});
test('audit: expired and revoked invites are rejected; bootstrap stays closed even if all users are disabled; unused bootstrap invite is revoked once a user exists',async()=>{
 const dir=await tmp();const acc=new Accounts(dir);await acc.load();
 const boot=await acc.ensureBootstrap();
 const admin=await acc.signup({inviteCode:boot,username:'admin',password:'correct horse battery'});
 const expired=await acc.createInvite({createdBy:'admin',ttlMs:-1000});
 assert.equal((await acc.signup({inviteCode:expired.code,username:'user1',password:'correct horse battery'})).error,'invite_invalid');
 const revoked=await acc.createInvite({createdBy:'admin'});await acc.revokeInvite(revoked.invite.id);
 assert.equal((await acc.signup({inviteCode:revoked.code,username:'user2',password:'correct horse battery'})).error,'invite_invalid');
 await acc.setDisabled(admin.user.id,true);
 assert.equal(await acc.ensureBootstrap(),null,'disabling all users must not mint a new bootstrap invite');
 // 첫 사용자가 일반 초대로 가입해도 미사용 bootstrap 초대는 폐기된다
 const dir2=await tmp();const acc2=new Accounts(dir2);await acc2.load();const boot2=await acc2.ensureBootstrap();
 acc2.accounts.data.invites.push({id:'x1',codeHash:'h',role:'user',createdBy:'someone',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+1e6).toISOString(),usedBy:null,usedAt:null,revoked:false});
 const inv=await acc2.createInvite({createdBy:'someone'});await acc2.signup({inviteCode:inv.code,username:'first',password:'correct horse battery'});
 assert.equal(await acc2.ensureBootstrap(),null);
 assert.ok(acc2.accounts.data.invites.filter(i=>i.createdBy==='bootstrap').every(i=>i.revoked||i.usedBy),'bootstrap invite revoked after any signup');
 assert.equal((await acc2.signup({inviteCode:boot2,username:'late',password:'correct horse battery'})).error,'invite_invalid');
});
test('audit: login lockout cannot be bypassed by whitespace variations in username',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 for(const variant of ['admin',' admin','admin ','  admin'])for(let i=0;i<3;i++)await s.call('/api/login',{method:'POST',body:JSON.stringify({username:variant,password:'wrong password!!'})});
 const locked=await s.call('/api/login',{method:'POST',body:JSON.stringify({username:'   admin',password:'synthetic password 1'})});
 assert.equal(locked.status,429);assert.equal((await locked.json()).error,'too_many_attempts');
});
test('audit: startLogin enforces R3 (evidence write failure is error, not done) and lastLine is masked',async()=>{
 const base=await tmp();const occupied=path.join(base,'ev');await writeFile(occupied,'occupied');
 const h=startLogin({id:'mock',command:'node',login:{args:[MOCK,'--login']}},{cwd:os.tmpdir(),extraEnv:{HOME:path.join(base,'home')},evidenceDir:occupied});
 await new Promise(r=>setTimeout(r,300));h.write('OK');
 const r=await h.done;assert.equal(r.status,'error');assert.equal(r.error,'evidence_write_failed');
 assert.equal(maskLine('token=abcdef123456 done'),'token=[가림] done');
 assert.equal(maskLine('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),'Authorization: [가림]');
 assert.equal(maskLine('Open https://auth.example/device?code=SECRETVALUE now'),'Open https://auth.example/device?[가림] now');
 assert.equal(maskLine('Enter code: ABCD-1234'),'Enter code: ABCD-1234','device codes are kept');
});
test('audit: cross-user save/handoff blocked, forged cookie rejected, safeName blocks dot-dot, state.json is 0600, disable closes SSE',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const alice=await s.signup(await s.invite(),'alice'),bob=await s.signup(await s.invite(),'bob');
 await alice.as('/api/send',{method:'POST',body:JSON.stringify({text:'alice secret question',targets:['mock']})});
 const stA=await wait(alice.as,1);const aliceReplyId=stA.messages.find(m=>m.role==='assistant').id;
 assert.equal((await bob.as('/api/save',{method:'POST',body:JSON.stringify({messageId:aliceReplyId,name:'steal.txt'})})).status,404);
 assert.equal((await bob.as('/api/send',{method:'POST',body:JSON.stringify({text:'review',targets:['mock'],handoffFrom:aliceReplyId})})).status,400);
 assert.equal((await s.call('/api/state',{headers:{cookie:'hub=forged_token_value_1234567890'}})).status,401);
 const up=await alice.as('/api/files?name=..',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'dotdot'});
 assert.equal(up.status,200);assert.equal(up.body.name,'file');
 const got=await s.call('/files/...',{headers:{cookie:alice.cookie}});   // '..' 은 fetch 가 URL 단계에서 정규화하므로 같은 규칙에 걸리는 '...' 로assert.equal(got.status,200);assert.equal(await got.text(),'dotdot','".." is served as the file named "file", never the parent dir');
 await assert.rejects(stat(path.join(s.dir,'data/users',String(alice.body.user.id),'workspace','..','dotdot')));
 assert.equal(((await stat(path.join(s.dir,'data/users',String(alice.body.user.id),'state.json'))).mode&0o077),0,'state.json 0600');
 // 중지되면 열린 SSE 가 닫힌다
 const es=await fetch(s.base+'/api/events',{headers:{cookie:bob.cookie}});const reader=es.body.getReader();await reader.read();
 await s.auth('/api/admin/users/disable',{method:'POST',body:JSON.stringify({userId:bob.body.user.id,disabled:true})});
 const closed=await Promise.race([reader.read().then(r=>r.done),new Promise(r=>setTimeout(()=>r('timeout'),3000))]);
 assert.equal(closed,true,'SSE closed on disable');
});
test('audit: JsonFile/Store save chain recovers after one failed write',async()=>{
 const dir=await tmp();const st=new Store(new URL('file://'+path.join(dir,'sub','state.json')));
 await writeFile(path.join(dir,'sub'),'occupied');   // 디렉터리 자리에 파일 → 첫 저장 실패
 await assert.rejects(st.save());
 await (await import('node:fs/promises')).unlink(path.join(dir,'sub'));
 st.add({role:'user',text:'after'});await st.save();   // 두 번째 저장은 성공해야 한다
 assert.ok(JSON.parse(await readFile(path.join(dir,'sub','state.json'),'utf8')).messages.length===1);
});

// ======================= v0.5 벤치마킹 4종: 메모리 · 예산 · 오케스트레이터 · 스트리밍 =======================
test('v0.5 memory: memory.md is injected before every prompt, editable, appendable from an answer, per user, 0600',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const a=await s.signup(await s.invite(),'alice'),b=await s.signup(await s.invite(),'bob');
 assert.equal((await a.as('/api/memory')).body.text,'');
 await a.as('/api/memory',{method:'POST',body:JSON.stringify({text:'# 취향\n- 답은 한국어로'})});
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'질문',targets:['mock']})});
 let st=await wait(a.as,1);
 const ev=await readFile(path.join(st.messages.at(-1).evidence.dir,'..','..','runs',path.basename(st.messages.at(-1).evidence.dir),'stdout.bin'),'utf8');
 assert.match(st.messages.at(-1).text,/첫 줄: \[내 메모리/,'prompt starts with the memory block');
 assert.equal((await b.as('/api/memory')).body.text,'','memory is per user');
 const r=await a.as('/api/memory/append',{method:'POST',body:JSON.stringify({messageId:st.messages.at(-1).id,note:'이 답변 기억'})});
 assert.equal(r.status,200);
 const mem=(await a.as('/api/memory')).body.text;assert.ok(mem.includes('이 답변 기억')&&mem.includes('mock 답변 #'));
 assert.equal(((await stat(path.join(s.dir,'data/users',String(a.body.user.id),'workspace/memory.md'))).mode&0o077),0);
 assert.equal((await a.as('/api/state')).body.memory.chars,mem.length);
});
test('v0.5 budget: usage accumulates per month and adapter; exceeding the per-user limit blocks before any call; admin can change the limit',async t=>{
 const s=await startServer([mockAdapter('mock'),mockAdapter('m2')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const u=await s.signup(await s.invite(),'user1');
 await u.as('/api/send',{method:'POST',body:JSON.stringify({text:'x'.repeat(100),targets:['mock','m2']})});
 let st=await wait(u.as,2);const b=st.budget;
 assert.equal(b.calls,2);assert.ok(b.tokens>200,'input+output counted');assert.equal(b.limit,0);assert.equal(b.exceeded,false);
 assert.ok(b.byAdapter.mock.calls===1&&b.byAdapter.m2.calls===1);
 assert.equal((await s.auth('/api/admin/users/budget',{method:'POST',body:JSON.stringify({userId:u.body.user.id,monthlyTokens:-5})})).status,400);
 await s.auth('/api/admin/users/budget',{method:'POST',body:JSON.stringify({userId:u.body.user.id,monthlyTokens:b.tokens})});   // 지금까지 쓴 만큼이 상한 → 다음 호출 차단
 await u.as('/api/send',{method:'POST',body:JSON.stringify({text:'more',targets:['mock']})});
 st=await wait(u.as,3);const last=st.messages.at(-1);
 assert.equal(last.status,'blocked');assert.equal(last.error,'budget_exceeded');assert.equal(last.budget.limit,b.tokens);
 assert.equal(st.budget.exceeded,true);assert.equal(st.budget.calls,2,'blocked call not counted');
 await assert.rejects(stat(path.join(s.dir,'data/users',String(u.body.user.id),'runs',`${last.id}-mock`)),'no CLI run for a blocked call');
 await s.auth('/api/admin/users/budget',{method:'POST',body:JSON.stringify({userId:u.body.user.id,monthlyTokens:null})});
 await u.as('/api/send',{method:'POST',body:JSON.stringify({text:'again',targets:['mock']})});
 st=await wait(u.as,4);assert.equal(st.messages.at(-1).status,'done');
 assert.deepEqual(normalizeUsage({input_tokens:3,output_tokens:4}),{input:3,output:4});assert.deepEqual(normalizeUsage(null),{input:0,output:0});
});
test('v0.5 orchestrate: lead plans (JSON) → workers run in parallel → lead synthesizes; every step has evidence; direct answer and unparsable plan handled',async t=>{
 const s=await startServer([mockAdapter('lead'),mockAdapter('dev'),mockAdapter('qa')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 assert.equal((await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'목표',mode:'orchestrate',lead:'lead',workers:['lead']})})).body.error,'workers_required');
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'랜딩 페이지 만들고 검토',mode:'orchestrate',lead:'lead',workers:['dev','qa']})});
 const st=await wait(s.auth,4);   // plan + 2 tasks + final
 const user=st.messages[0];assert.equal(user.mode,'orchestrate');assert.deepEqual(user.workers,['dev','qa']);
 const plan=st.messages.find(m=>m.kind==='plan'),tasks=st.messages.filter(m=>m.kind==='task'),final=st.messages.find(m=>m.kind==='final');
 assert.equal(plan.status,'done');assert.deepEqual(plan.plan.tasks.map(t=>t.worker),['dev','qa']);
 assert.equal(tasks.length,2);assert.ok(tasks.every(m=>m.status==='done'&&m.replyTo===plan.id&&m.evidence?.stdoutSha256));
 assert.ok(tasks.find(m=>m.adapter==='dev').text.includes('HUB:TASK 1/2'));
 assert.equal(final.status,'done');assert.match(final.text,/\[mock 종합\] 결과 2건 종합: 작업1 작업1 for dev \/ 작업2 작업2 for qa/);
 assert.ok(final.evidence?.stdoutSha256&&final.derivedFrom===plan.id);
 assert.equal(st.budget.calls,4,'all four CLI runs counted');
 // extractPlan 단위
 assert.deepEqual(extractPlan('설명\n```json\n{"tasks":[{"worker":"dev","title":"t","prompt":"p"},{"worker":"nope","prompt":"x"},{"worker":"qa","prompt":""}]}\n```',['dev','qa']).tasks,[{worker:'dev',title:'t',prompt:'p'}]);
 assert.equal(extractPlan('no json here',['dev']),null);
 assert.equal(extractPlan('{"tasks":[{"worker":"dev","prompt":"a"},{"worker":"dev","prompt":"b"}]}',['dev'],1).tasks.length,1,'maxTasks');
});
test('v0.5 orchestrate: lead answers directly (empty tasks) → final from plan; garbage plan → plan_parse_failed, no workers called',async t=>{
 const s=await startServer([mockAdapter('lead',{envAllow:['MOCK_AUTH','MOCK_PLAN']}),mockAdapter('dev')],{MOCK_AUTH:'subscription',MOCK_PLAN:'direct'});t.after(()=>s.srv.kill());
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'간단한 질문',mode:'orchestrate',lead:'lead',workers:['dev']})});
 const st=await wait(s.auth,2);const final=st.messages.find(m=>m.kind==='final');
 assert.equal(final.text,'[mock 팀장 직접 답변] 팀원 없이 처리했습니다.');assert.equal(st.messages.filter(m=>m.kind==='task').length,0);
 const s2=await startServer([mockAdapter('lead',{envAllow:['MOCK_AUTH','MOCK_PLAN']}),mockAdapter('dev')],{MOCK_AUTH:'subscription',MOCK_PLAN:'garbage'});t.after(()=>s2.srv.kill());
 await s2.auth('/api/send',{method:'POST',body:JSON.stringify({text:'목표',mode:'orchestrate',lead:'lead',workers:['dev']})});
 const st2=await wait(s2.auth,1);const plan=st2.messages.find(m=>m.kind==='plan');
 assert.equal(plan.status,'error');assert.equal(plan.error,'plan_parse_failed');assert.ok(plan.text.includes('JSON 없음'),'lead text kept for the user');
 await new Promise(r=>setTimeout(r,400));assert.equal((await s2.auth('/api/state')).body.messages.filter(m=>m.kind==='task'||m.kind==='final').length,0);
});
test('v0.5 streaming: partial text reaches SSE before the final message; final answer and evidence unchanged',async t=>{
 const s=await startServer([mockAdapter('mock',{args:[MOCK,'--mode','stream'],stream:'mock-stream'})],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const es=await fetch(s.base+'/api/events',{headers:{cookie:s.admin.cookie}});const reader=es.body.getReader();const dec=new TextDecoder();let buf='';const partials=[];let final=null;
 const pump=(async()=>{while(true){const {value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf('\n\n'))>=0){const ev=buf.slice(0,i);buf=buf.slice(i+2);const type=ev.match(/^event: (\S+)/m)?.[1];const data=ev.match(/^data: (.*)$/m)?.[1];if(type==='partial')partials.push(JSON.parse(data));if(type==='message'){const m=JSON.parse(data);if(m.role==='assistant'&&m.status==='done')final=m;}}if(final)break;}})();
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'스트리밍 확인',targets:['mock']})});
 await Promise.race([pump,new Promise(r=>setTimeout(r,8000))]);reader.cancel().catch(()=>{});
 assert.ok(final,'final message arrived');assert.ok(partials.length>=2,'got partial events: '+partials.length);
 assert.ok(partials.some(p=>typeof p.partial==='string'&&p.partial.startsWith('[mock 답변]')),'partial text extracted from unfinished JSON');
 assert.ok(partials.every(p=>p.id===final.id&&p.bytes>0));
 assert.match(final.text,/받은 프롬프트/);assert.ok(final.evidence.stdoutSha256);
 assert.equal(STREAM_PARSERS.jsonl('{"type":"item.completed","item":{"type":"agent_message","text":"코덱스 중간"}}\n{"type":"x"'),'코덱스 중간');
 assert.equal(STREAM_PARSERS.jsonl('{"delta":"안녕"}\n{"delta":"하세요"}\n'),'안녕하세요');
 assert.equal(PARSERS['claude-json']('{"type":"system"}\n{"type":"result","result":"스트림 끝","session_id":"s9"}\n').text,'스트림 끝');
});

// ======================= v0.5 검수(Gemini) 재현 테스트 =======================
test('v0.5 audit: maskLine masks underscored keys (access_token, client_secret) and URL #fragments',()=>{
 assert.equal(maskLine('access_token=short_secret_123 ok'),'access_token=[가림] ok');
 assert.equal(maskLine('refresh_token: my_refresh_val'),'refresh_token: [가림]');
 assert.equal(maskLine('client_secret=super_secret_val'),'client_secret=[가림]');
 assert.equal(maskLine('Redirect https://auth.example/cb#access_token=xyz123 now'),'Redirect https://auth.example/cb#[가림] now');
 assert.equal(maskLine('Enter code: ABCD-1234'),'Enter code: ABCD-1234');
});
test('v0.5 audit: extractPlan rejects all-invalid workers or empty direct answer, handles multiple code fences, reports dropped',()=>{
 assert.equal(extractPlan('{"tasks":[{"worker":"WrongName","title":"t","prompt":"do it"}],"note":"n","answer":null}',['dev','qa']),null);
 assert.equal(extractPlan('{"tasks":[],"note":"n","answer":null}',['dev']),null);
 assert.equal(extractPlan('{"tasks":[],"note":"n","answer":"   "}',['dev']),null);
 const multi='예시 코드:\n```js\nconst sample = { a: 1 };\n```\n계획:\n```json\n{"tasks":[{"worker":"dev","title":"구현","prompt":"작성하라"}],"note":"ok","answer":null}\n```';
 const parsed=extractPlan(multi,['dev']);assert.ok(parsed);assert.equal(parsed.tasks.length,1);assert.equal(parsed.tasks[0].worker,'dev');
 const partial=extractPlan('{"tasks":[{"worker":"dev","prompt":"a"},{"worker":"nope","prompt":"b"}]}',['dev']);assert.equal(partial.tasks.length,1);assert.equal(partial.dropped,1);assert.equal(partial.requested,2);
});
test('v0.5 audit: codex-jsonl extracts usage from JSONL events and normalizeUsage clamps negatives',()=>{
 const out='{"type":"thread.started","thread_id":"t1"}\n{"type":"item.completed","item":{"type":"agent_message","text":"코덱스 답"}}\n{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":45}}\n';
 const r=PARSERS['codex-jsonl'](out);assert.equal(r.text,'코덱스 답');assert.deepEqual(normalizeUsage(r.usage),{input:120,output:45});
 assert.deepEqual(normalizeUsage({input_tokens:-50,output_tokens:30}),{input:0,output:30});
});
test('v0.5 audit: /api/memory/append accepts messageId:null with note; orchestrate skips synth when all workers are blocked; concurrent memory writes serialize',async t=>{
 const s=await startServer([mockAdapter('lead'),mockAdapter('dev',{envAllow:[],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'}})],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const memo=await s.auth('/api/memory/append',{method:'POST',body:JSON.stringify({messageId:null,note:'독립 메모 항목'})});assert.equal(memo.status,200);
 assert.ok((await s.auth('/api/memory')).body.text.includes('독립 메모 항목'));
 await Promise.all(Array.from({length:10},(_,i)=>s.auth('/api/memory/append',{method:'POST',body:JSON.stringify({note:'동시 '+i})})));
 const mem=(await s.auth('/api/memory')).body.text;for(let i=0;i<10;i++)assert.ok(mem.includes('동시 '+i),'append '+i+' kept');
 await s.auth('/api/send',{method:'POST',body:JSON.stringify({text:'목표 실행',mode:'orchestrate',lead:'lead',workers:['dev']})});
 await wait(s.auth,2);await new Promise(r=>setTimeout(r,300));
 const st=(await s.auth('/api/state')).body;
 assert.equal(st.messages.find(m=>m.kind==='task').status,'blocked');
 assert.equal(st.messages.filter(m=>m.kind==='final').length,0,'lead synthesize should not run when every worker task failed/blocked');
 assert.equal(st.messages.find(m=>m.kind==='plan').orchestrateError,'all_tasks_failed');
});
test('v0.6: corrupt state.json fails closed for that user only; /files/ serves html as download with sandbox CSP; targets deduped',async t=>{
 const s=await startServer([mockAdapter('mock')],{MOCK_AUTH:'subscription'});t.after(()=>s.srv.kill());
 const a=await s.signup(await s.invite(),'alice'),b=await s.signup(await s.invite(),'bob');
 await a.as('/api/send',{method:'POST',body:JSON.stringify({text:'x',targets:['mock','mock','mock']})});
 const st=await wait(a.as,1);assert.equal(st.messages.filter(m=>m.role==='assistant').length,1,'duplicate targets run once');
 await a.as('/api/files?name=p.html',{method:'POST',headers:{'content-type':'application/octet-stream'},body:'<script>1</script>'});
 const r=await s.call('/files/p.html',{headers:{cookie:a.cookie}});
 assert.match(r.headers.get('content-disposition')??'',/attachment/);assert.match(r.headers.get('content-security-policy')??'',/sandbox/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');
 // bob 의 state.json 을 손상시키면 bob 만 막힌다 (서버는 bob 의 컨텍스트를 아직 안 만들었으므로 파일을 먼저 만든다)
 const bobState=path.join(s.dir,'data/users',String(b.body.user.id),'state.json');await mkdir(path.dirname(bobState),{recursive:true});await writeFile(bobState,'{corrupt');
 const rb=await b.as('/api/state');assert.equal(rb.status,500);assert.equal(rb.body.error,'state_corrupt');
 assert.equal(await readFile(bobState,'utf8'),'{corrupt','corrupt file is not overwritten');
 assert.equal((await a.as('/api/state')).status,200,'alice unaffected');
});
function spawnOk(cmd,args){return new Promise((res,rej)=>{const c=spawn(cmd,args);c.on('close',code=>code===0?res():rej(Error(cmd+' failed')));});}
