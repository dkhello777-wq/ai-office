// v0.9.3 Gemini 덜 닳게: AI 별 '모두에게 빼기'(quiet), AI 별 방 대화 공유 끄기, 사용 한도 소진 → 초기화 시각까지 쉬기
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';

const ROOT=new URL('..',import.meta.url).pathname;
const MOCK=path.join(ROOT,'src/adapters/mock-cli.mjs');
const QUOTA_STDERR='error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 159h53m24s.\\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429}';
const base=(id,extra={})=>({id,label:id,color:'#888',command:'node',args:[MOCK],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},...extra});

async function start(adapters){
  const dir=await mkdtemp(path.join(os.tmpdir(),'v093-'));
  await mkdir(path.join(dir,'config'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters,timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=21000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 9'},stdio:['ignore','pipe','pipe']});
  let log='';srv.stderr.on('data',d=>log+=d);
  await new Promise(r=>srv.stdout.on('data',d=>{log+=d;if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const r=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 9'})});
  const cookie=r.headers.get('set-cookie').split(';')[0];
  const as=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie}}:{method:'POST',headers:{cookie,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return {status:x.status,body:await x.json()};};
  return {srv,as,dir,log:()=>log};
}
const waitDone=async(as,n)=>{for(let i=0;i<100;i++){const st=(await as('/api/state')).body;if(st.messages.filter(m=>m.role==='assistant'&&m.status!=='running').length>=n)return st;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');};

test('한도 소진: 오류를 quota_exhausted 로 바꾸고 초기화 시각까지 그 AI 를 띄우지 않는다, 직접 풀 수 있다', async t=>{
  const quota=base('q',{args:['-e',`process.stderr.write('${QUOTA_STDERR}');process.exit(3)`]});
  const s=await start([base('mock'),quota]);t.after(()=>s.srv.kill());
  const t0=Date.now();
  await s.as('/api/send',{text:'안녕',targets:['q']});
  let st=await waitDone(s.as,1);
  const a=st.messages.find(m=>m.adapter==='q');
  assert.equal(a.status,'error');assert.equal(a.error,'quota_exhausted');assert.equal(a.cliError,'cli_exit_3');
  const reset=Date.parse(a.resetAt);const want=t0+(159*3600+53*60+24)*1000;
  assert.ok(Math.abs(reset-want)<60000,'초기화 시각 = 지금 + 159h53m24s');
  st=(await s.as('/api/state')).body;
  assert.equal(st.adapters.find(x=>x.id==='q').cooldownUntil,a.resetAt);
  assert.equal(st.adapters.find(x=>x.id==='mock').cooldownUntil,null);
  // 쉬는 동안: CLI 를 띄우지 않고 바로 막음
  await s.as('/api/send',{text:'다시',targets:['q']});
  st=await waitDone(s.as,2);
  const b=st.messages.filter(m=>m.adapter==='q').at(-1);
  assert.equal(b.status,'blocked');assert.equal(b.error,'quota_cooldown');assert.equal(b.resetAt,a.resetAt);assert.equal(b.evidence,undefined,'CLI 를 띄우지 않음');
  // state.json 에 남아 재시작 뒤에도 유지
  const saved=JSON.parse(await readFile(path.join(s.dir,'data/users/1/state.json'),'utf8'));
  assert.equal(saved.cooldowns.q,a.resetAt);
  // 직접 풀기
  assert.equal((await s.as('/api/settings/cooldown-clear',{adapterId:'q'})).status,200);
  assert.equal((await s.as('/api/state')).body.adapters.find(x=>x.id==='q').cooldownUntil,null);
});

test('quiet: config 기본값(quietDefault) → 사용자가 켜고 끌 수 있고 owner.json 에 남는다', async t=>{
  const s=await start([base('mock'),base('g',{quietDefault:true,roomShare:false})]);t.after(()=>s.srv.kill());
  let st=(await s.as('/api/state')).body;
  assert.equal(st.adapters.find(x=>x.id==='g').quiet,true);assert.equal(st.adapters.find(x=>x.id==='mock').quiet,false);
  assert.equal((await s.as('/api/settings/quiet',{adapterId:'g',quiet:false})).status,200);
  st=(await s.as('/api/state')).body;assert.equal(st.adapters.find(x=>x.id==='g').quiet,false);
  assert.equal((await s.as('/api/settings/quiet',{adapterId:'mock',quiet:true})).status,200);
  assert.equal((await s.as('/api/state')).body.adapters.find(x=>x.id==='mock').quiet,true);
  assert.equal((await s.as('/api/settings/quiet',{adapterId:'nope',quiet:true})).status,404);
  assert.equal((await s.as('/api/settings/quiet',{adapterId:'g',quiet:'yes'})).status,400);
  const owner=JSON.parse(await readFile(path.join(s.dir,'data/owner.json'),'utf8'));
  assert.deepEqual(owner.quiet,{g:false,mock:true});
});

test('배포 config: Gemini 는 기본으로 모두에게에서 빠지고 방 대화 공유도 붙지 않는다; 화면은 모두에게·팀장 분배에 inAll 만 보낸다', async()=>{
  const cfg=JSON.parse(await readFile(path.join(ROOT,'config/adapters.json'),'utf8'));
  const g=cfg.adapters.find(a=>a.id==='gemini');assert.equal(g.quietDefault,true);assert.equal(g.roomShare,false);
  for(const id of ['claude','codex'])assert.ok(!cfg.adapters.find(a=>a.id===id).quietDefault);
  const srv=await readFile(path.join(ROOT,'src/server.mjs'),'utf8');
  assert.match(srv,/adapters\.find\(a=>a\.id===forAdapter\)\?\.roomShare===false\)return ''/);
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(app,/const on=state\.adapters\.filter\(inAll\)/);
  assert.match(app,/const inAll=a=>connected\(a\)&&!a\.quiet&&!cooling\(a\)/);
});
