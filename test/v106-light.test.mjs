// v0.10.6 가벼운 화면: 상태 스냅샷은 최근 300개만(older 수 포함) · /api/messages 로 옛 메시지 100개씩 · 화면은 최근 60개만 그리고 "더 보기"
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';

const ROOT=new URL('..',import.meta.url).pathname;
const MOCK=path.join(ROOT,'src/adapters/mock-cli.mjs');
const base=id=>({id,label:id,color:'#888',command:'node',args:[MOCK],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'}});

test('서버: 메시지 350개 → /api/state 는 최근 300개 + older 50, /api/messages?before 로 나머지', async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v106-'));
  await mkdir(path.join(dir,'config'),{recursive:true});await mkdir(path.join(dir,'data/users/1'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters:[base('mock')],timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  const messages=[];for(let i=1;i<=350;i++)messages.push({id:i,role:i%2?'user':'assistant',adapter:i%2?undefined:'mock',text:'m'+i,status:i%2?undefined:'done',at:new Date(1760000000000+i*1000).toISOString(),seq:i});
  await writeFile(path.join(dir,'data/users/1/state.json'),JSON.stringify({messages,sessions:{},nextId:351,usage:{},epochs:{},seq:350,cooldowns:{}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=27000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 6'},stdio:['ignore','pipe','pipe']});
  t.after(()=>srv.kill());
  await new Promise(r=>srv.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const lr=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 6'})});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const get=async p=>(await fetch(url+p,{headers:{cookie}})).json();
  const st=await get('/api/state');
  assert.equal(st.messages.length,300);assert.equal(st.messages[0].id,51);assert.equal(st.older,50);
  let r=await get('/api/messages?before=51&limit=100');
  assert.equal(r.messages.length,50);assert.equal(r.messages[0].id,1);assert.equal(r.older,0);
  r=await get('/api/messages?before=51&limit=20');assert.equal(r.messages.length,20);assert.equal(r.messages[0].id,31);assert.equal(r.older,30);
  r=await get('/api/messages?before=1');assert.deepEqual(r,{messages:[],older:0});
});

test('화면: 최근 60개만 그리고 "이전 대화 더 보기"(화면 100개씩 → 서버 100개씩), 화면 밖 말풍선은 content-visibility, 영상은 preload=none', async()=>{
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(app,/const SHOW_MAX=60,SHOW_STEP=100;let shown=SHOW_MAX;/);
  assert.match(app,/const hidden=Math\.max\(0,ordered\.length-shown\);/);assert.match(app,/for\(const m of ordered\.slice\(hidden\)\)/);
  assert.match(app,/const older=hidden\+\(state\.older\?\?0\);/);
  assert.match(app,/api\(`\/api\/messages\?before=\$\{minId\}&limit=\$\{SHOW_STEP\}`\)/);
  assert.match(app,/if\(Number\.isSafeInteger\(s\.older\)\)state\.older=s\.older;/);
  assert.match(app,/shown=SHOW_MAX;renderTimeline\(\);\}\);   \/\/ v0\.10\.5/,'방 비우기 뒤 창 초기화');
  assert.match(app,/<video src="\$\{u\}" controls playsinline preload="none">/);
  const css=await readFile(path.join(ROOT,'public/style.css'),'utf8');
  assert.match(css,/\.m\{display:flex;gap:8px;max-width:100%;content-visibility:auto;contain-intrinsic-size:auto 120px\}/);
  const srv=await readFile(path.join(ROOT,'src/server.mjs'),'utf8');assert.match(srv,/const MSG_WINDOW=300;/);
});
