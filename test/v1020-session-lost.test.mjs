// v0.10.20 이어갈 대화 기록이 서버에서 사라졌을 때(Codex "no rollout found"): 한 번만 새 대화로 다시 보내고 sessionLost 표시.
// 그리고 저장 공간 정리(자동·고른 항목)는 지금 이어가는 대화의 기록 파일을 지우지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp,utimes,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {sweep,listCandidates,deletePath} from '../src/janitor.mjs';

const ROOT=new URL('..',import.meta.url).pathname;
const MOCK=path.join(ROOT,'src/adapters/mock-cli.mjs');
const base=(id,extra={})=>({id,label:id,color:'#888',command:'node',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},parse:'mock-json',resumeArgs:['--session','{session}'],...extra});
// 세션 'gone' 으로 이어가려 하면 Codex 와 같은 오류로 끝난다. 새로 시작하면 처음엔 'gone', 그다음엔 'fresh' 를 준다(실행 횟수는 작업 폴더 파일).
const SCRIPT=`const fs=require('fs');const a=process.argv;const s=a.includes('--session')?a[a.indexOf('--session')+1]:null;
if(s==='gone'){process.stderr.write('Error: thread/resume: thread/resume failed: no rollout found for thread id gone (code -32600)\\n');process.exit(1);}
if(s==='broken'){process.stderr.write('Error: something else\\n');process.exit(1);}
let n=0;try{n=Number(fs.readFileSync('count','utf8'));}catch{}fs.writeFileSync('count',String(n+1));
process.stdout.write(JSON.stringify({text:'답'+n,session:s??(n===0?'gone':'fresh'),usage:null}));`;

test('no rollout found → 새 대화로 한 번 다시 시도해 답하고, 다른 오류는 그대로 실패', async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v1020-'));
  const cx=base('cx',{args:['-e',SCRIPT,'--']});
  await mkdir(path.join(dir,'config'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters:[cx],timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=33000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 8'},stdio:['ignore','pipe','pipe']});
  let log='';srv.stdout.on('data',d=>log+=d);t.after(()=>srv.kill());
  await new Promise(r=>srv.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const lr=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 8'})});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const as=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie}}:{method:'POST',headers:{cookie,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return x.json();};
  const waitDone=async n=>{for(let i=0;i<150;i++){const st=await as('/api/state');if(st.messages.filter(m=>m.role==='assistant'&&m.status!=='running').length>=n)return st;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');};
  await as('/api/send',{text:'a',targets:['cx']});let st=await waitDone(1);
  assert.equal(st.adapters.find(a=>a.id==='cx').session,'gone');
  await as('/api/send',{text:'b',targets:['cx']});st=await waitDone(2);
  const m=st.messages.filter(x=>x.role==='assistant').at(-1);
  assert.equal(m.status,'done');assert.equal(m.text,'답1');assert.equal(m.sessionLost,true);
  assert.equal(st.adapters.find(a=>a.id==='cx').session,'fresh','새 세션으로 이어감');
  assert.match(log,/이어갈 대화 기록 없음 → 새 대화로 다시 시도/);
  // 다른 오류는 다시 시도하지 않고 세션도 그대로(사용자 방침: 자동으로 끊지 않기)
  const s=JSON.parse(await readFile(path.join(dir,'data/users/1/state.json'),'utf8'));s.sessions.cx='broken';
  srv.kill();await new Promise(r=>srv.on('exit',r));
  await writeFile(path.join(dir,'data/users/1/state.json'),JSON.stringify(s));
  const srv2=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 8'},stdio:['ignore','pipe','pipe']});
  t.after(()=>srv2.kill());
  await new Promise(r=>srv2.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const lr2=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 8'})});
  const cookie2=lr2.headers.get('set-cookie').split(';')[0];
  const as2=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie:cookie2}}:{method:'POST',headers:{cookie:cookie2,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return x.json();};
  await as2('/api/send',{text:'c',targets:['cx']});
  for(let i=0;i<150;i++){st=await as2('/api/state');if(st.messages.filter(x=>x.role==='assistant'&&x.status!=='running').length>=3)break;await new Promise(r=>setTimeout(r,100));}
  const e=st.messages.filter(x=>x.role==='assistant').at(-1);
  assert.equal(e.status,'error');assert.equal(e.sessionLost,undefined);assert.equal(st.adapters.find(a=>a.id==='cx').session,'broken');
});

test('저장 공간 정리: 이어가는 대화의 Codex·Claude 기록은 자동 정리·고른 항목 지우기에서 빠진다', async()=>{
  const users=await mkdtemp(path.join(os.tmpdir(),'v1020j-'));const u=path.join(users,'1');
  const NOW=Date.now(),old=new Date(NOW-10*86400e3);
  const put=async(rel,bytes)=>{const p=path.join(u,rel);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,Buffer.alloc(bytes));await utimes(p,old,old);};
  const LIVE='019a0000-aaaa-bbbb-cccc-000000000001',CL='11111111-2222-3333-4444-555555555555';
  await put(`home/.codex/sessions/2026/10/21/rollout-2026-10-21T01-00-00-${LIVE}.jsonl`,300);
  await put('home/.codex/sessions/2026/10/20/rollout-2026-10-20T01-00-00-019a0000-dead-dead-dead-000000000000.jsonl',300);
  await put(`home/.claude/projects/-app-ws/${CL}.jsonl`,200);
  await put('home/.claude/projects/-app-ws/99999999-0000-0000-0000-000000000000.jsonl',200);
  await writeFile(path.join(u,'state.json'),JSON.stringify({messages:[],nextId:1,sessions:{codex:LIVE,claude:CL,grok:null}}));
  const c=await listCandidates(users);
  assert.ok(!c.some(i=>i.path.includes(LIVE)||i.path.includes(CL)),'이어가는 기록은 후보가 아님');
  assert.equal(c.filter(i=>i.kind==='cli-log').length,2);
  const r=await sweep(users,{highPct:10,lowPct:0,protectHours:0},{usage:async()=>({total:1000,used:900,free:100,pct:90}),now:NOW});
  assert.equal(r.deleted,2);
  await stat(path.join(u,`home/.codex/sessions/2026/10/21/rollout-2026-10-21T01-00-00-${LIVE}.jsonl`));await stat(path.join(u,`home/.claude/projects/-app-ws/${CL}.jsonl`));
  assert.equal((await deletePath(users,'1','home/.codex/sessions')).error,'in_use','이어가는 기록이 든 폴더도 거부');
  assert.equal((await deletePath(users,'1',`home/.claude/projects/-app-ws/${CL}.jsonl`)).error,'in_use');
});
