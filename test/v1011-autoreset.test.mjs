// v0.10.11 자동 새 대화: 입력 토큰이 sessionResetTokens 를 넘으면 / 시간 초과가 나면 세션을 버리고 답변에 sessionReset 표시
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';

const ROOT=new URL('..',import.meta.url).pathname;
const MOCK=path.join(ROOT,'src/adapters/mock-cli.mjs');
const base=(id,extra={})=>({id,label:id,color:'#888',command:'node',args:[MOCK],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[MOCK,'--auth-status'],parser:'mock-json'},...extra});

test('설정한 AI(Grok 식)만: 큰 입력 → 세션 초기화, 시간 초과 → 세션 초기화. 설정 없는 AI 는 어떤 경우에도 유지', async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v1011-'));
  const big=base('big',{args:['-e',"process.stdout.write(JSON.stringify({text:'답',session:'s-big',usage:{input_tokens:1000,cache_read_input_tokens:130000,output_tokens:10}}))"],sessionResetTokens:120000});
  const small=base('small',{args:['-e',"process.stdout.write(JSON.stringify({text:'답',session:'s-small',usage:{input_tokens:500000,output_tokens:10}}))"]});   // 기본(꺼짐): 입력이 커도 세션 유지
  const slow=base('slow',{args:['-e',"setTimeout(()=>{},5000)"],runTimeoutMs:600,sessionResetTokens:120000});
  const keep=base('keep',{args:['-e',"setTimeout(()=>{},5000)"],runTimeoutMs:600});   // 기본(꺼짐): 시간 초과여도 세션 유지
  await mkdir(path.join(dir,'config'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters:[big,small,slow,keep],timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=31000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 8'},stdio:['ignore','pipe','pipe']});
  let log='';srv.stdout.on('data',d=>log+=d);t.after(()=>srv.kill());
  await new Promise(r=>srv.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const lr=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 8'})});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const as=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie}}:{method:'POST',headers:{cookie,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return x.json();};
  const waitDone=async n=>{for(let i=0;i<120;i++){const st=await as('/api/state');if(st.messages.filter(m=>m.role==='assistant'&&m.status!=='running').length>=n)return st;await new Promise(r=>setTimeout(r,100));}throw Error('timeout');};
  await as('/api/send',{text:'a',targets:['big','small']});let st=await waitDone(2);
  const b=st.messages.find(m=>m.adapter==='big'),s=st.messages.find(m=>m.adapter==='small');
  assert.equal(b.status,'done');assert.equal(b.sessionReset,true);assert.equal(st.adapters.find(a=>a.id==='big').session,null,'큰 세션은 버림');
  assert.equal(s.sessionReset,undefined);assert.equal(st.adapters.find(a=>a.id==='small').session,'s-small','설정 없는 AI 는 아무리 커도 유지');
  await as('/api/send',{text:'b',targets:['slow','keep']});st=await waitDone(4);
  const sl=st.messages.find(m=>m.adapter==='slow'),kp=st.messages.find(m=>m.adapter==='keep');
  assert.equal(sl.status,'error');assert.equal(sl.timedOut,true);assert.equal(sl.sessionReset,true);
  assert.equal(kp.status,'error');assert.equal(kp.timedOut,true);assert.equal(kp.sessionReset,undefined,'설정 없는 AI 는 시간 초과여도 자동 새 대화 안 함');
  const saved=JSON.parse(await readFile(path.join(dir,'data/users/1/state.json'),'utf8'));assert.equal(saved.epochs.keep,undefined,'keep 세대 그대로');assert.equal(saved.epochs.slow,1);
  assert.match(log,/\[run\] #\d+ big done \d+s exit=0 tok=131000\+10/,'v0.10.9 실행 결과 로그');
  assert.match(log,/\[run\] #\d+ slow error cli_timeout/);
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');assert.match(app,/m\.sessionReset\?`<span title=/);
  const cfg=JSON.parse(await readFile(path.join(ROOT,'config/adapters.json'),'utf8'));assert.equal(cfg.adapters.find(a=>a.id==='grok').sessionResetTokens,120000);
});
