// v0.10.5 방 비우기: 대화 기록 삭제 · 모든 AI 새 대화(세션 초기화) · 사용량 유지 · 답하는 중이면 거절 · 화면은 clearedBefore 미만을 버린다
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Store} from '../src/store.mjs';

const ROOT=new URL('..',import.meta.url).pathname;
const MOCK=path.join(ROOT,'src/adapters/mock-cli.mjs');
const base=(id,extra={})=>({id,label:id,color:'#888',command:'node',args:[MOCK],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},...extra});

test('Store.clear: 메시지 비움 · 세션 지우고 세대 올림 · nextId 유지 · clearedBefore 기록 · 사용량 유지', async()=>{
  const st=new Store(new URL('file:///tmp/nonexistent-v105.json'));
  st.add({role:'user',text:'a'});st.add({role:'assistant',adapter:'x',text:'b',status:'done'});
  st.setSession('x','sess-1');st.addUsage('x',{input:10,output:5});
  const next=st.state.nextId;
  assert.equal(st.clear(['x','y']),2);
  assert.deepEqual(st.state.messages,[]);assert.equal(st.session('x'),null);assert.equal(st.epoch('x'),1);assert.equal(st.epoch('y'),1);
  assert.equal(st.state.nextId,next);assert.equal(st.clearedBefore(),next);
  assert.equal(st.usageFor().tokens,15);
  assert.equal(st.add({role:'user',text:'c'}).id,next,'id 는 이어서');
});

test('서버: /api/clear 는 답하는 중이면 409, 끝나면 지우고 cleared/state 이벤트, 재시작 뒤에도 비어 있음', async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v105-'));
  const slow=base('slow',{args:['-e',"setTimeout(()=>{process.stdout.write(JSON.stringify({text:'늦은 답',session:'s'}))},1500)"]});
  await mkdir(path.join(dir,'config'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters:[base('mock'),slow],timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=26000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 5'},stdio:['ignore','pipe','pipe']});
  t.after(()=>srv.kill());
  await new Promise(r=>srv.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const lr=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 5'})});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const as=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie}}:{method:'POST',headers:{cookie,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return {status:x.status,body:await x.json()};};
  const waitIdle=async()=>{for(let i=0;i<100;i++){const st=(await as('/api/state')).body;if(!st.messages.some(m=>m.status==='running'))return st;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');};
  // SSE 로 cleared 이벤트를 받는다
  const events=[];const ac=new AbortController();
  fetch(url+'/api/events',{headers:{cookie},signal:ac.signal}).then(async r=>{const rd=r.body.getReader();const td=new TextDecoder();let buf='';while(true){const {value,done}=await rd.read();if(done)break;buf+=td.decode(value);let i;while((i=buf.indexOf('\n\n'))>=0){const chunk=buf.slice(0,i);buf=buf.slice(i+2);const ev=/^event: (\S+)/m.exec(chunk)?.[1];const data=/^data: (.*)$/m.exec(chunk)?.[1];if(ev)events.push({ev,data:JSON.parse(data)});}}}).catch(()=>{});
  t.after(()=>ac.abort());
  await as('/api/send',{text:'안녕',targets:['mock']});await waitIdle();
  await as('/api/send',{text:'천천히',targets:['slow']});
  await new Promise(r=>setTimeout(r,300));
  let r=await as('/api/clear',{});assert.equal(r.status,409);assert.equal(r.body.error,'busy');
  await waitIdle();
  let st=(await as('/api/state')).body;assert.equal(st.messages.length,4);assert.equal(st.adapters.find(a=>a.id==='slow').session,'s');
  const nextBefore=Math.max(...st.messages.map(m=>m.id))+1;
  r=await as('/api/clear',{});assert.equal(r.status,200);assert.equal(r.body.removed,4);
  st=(await as('/api/state')).body;assert.deepEqual(st.messages,[]);assert.equal(st.clearedBefore,nextBefore);
  assert.equal(st.adapters.find(a=>a.id==='slow').session,null,'모든 AI 새 대화');
  await new Promise(r=>setTimeout(r,200));
  const c=events.find(e=>e.ev==='cleared');assert.ok(c);assert.equal(c.data.clearedBefore,nextBefore);
  assert.ok(events.some(e=>e.ev==='state'&&e.data.messages?.length===0));
  // 비운 뒤 보낸 메시지 id 는 이어서 커진다
  await as('/api/send',{text:'다시',targets:['mock']});st=await waitIdle();
  assert.equal(st.messages[0].id,nextBefore);
  const saved=JSON.parse(await readFile(path.join(dir,'data/users/1/state.json'),'utf8'));
  assert.equal(saved.clearedBefore,nextBefore);assert.equal(saved.messages.length,2);
});

test('화면: 메뉴에 방 비우기, 확인 뒤 /api/clear, cleared 이벤트·스냅샷의 clearedBefore 로 옛 메시지 제거', async()=>{
  const html=await readFile(path.join(ROOT,'public/index.html'),'utf8');assert.match(html,/id="m-clear">🧹 방 비우기/);
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(app,/\$\('#m-clear'\)\.onclick=async\(\)=>\{\$\('#menu'\)\.close\(\);if\(state\.messages\.some\(m=>m\.status==='running'\)\)\{toast\(ERR\.busy\);return;\}if\(!confirm\(/);
  assert.match(app,/api\('\/api\/clear',\{method:'POST',body:'\{\}'\}\)/);
  assert.match(app,/es\.addEventListener\('cleared',e=>\{const d=JSON\.parse\(e\.data\);state\.messages=state\.messages\.filter\(m=>m\.id>=\(d\.clearedBefore\?\?Infinity\)\)/);
  assert.match(app,/if\(Number\.isSafeInteger\(snap\.clearedBefore\)&&snap\.clearedBefore>0\)\{state\.messages=state\.messages\.filter\(m=>m\.id>=snap\.clearedBefore\)/);
  assert.match(app,/busy:'AI 가 답하는 중이라 비울 수 없어요/);
});
