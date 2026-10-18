// v0.9.2 구글 드라이브로 보내기: 기기 코드 연결 → 폴더 만들기 → resumable 업로드, 만료·해제 처리 (가짜 fetch)
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {GDrive} from '../src/gdrive.mjs';

const res=(status,body,headers={})=>({ok:status>=200&&status<300,status,headers:{get:k=>headers[k.toLowerCase()]??null},text:async()=>typeof body==='string'?body:JSON.stringify(body)});
function fakeGoogle(){
  const calls=[];let pollCount=0;const state={folders:new Map(),files:[],trashed:new Set(),revoked:[]};
  const fetch=async(url,opt={})=>{
    const body=opt.body instanceof Buffer?opt.body:String(opt.body??'');calls.push({url,method:opt.method??'GET',headers:opt.headers??{},body});
    if(url.endsWith('/device/code')){assert.match(body,/scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file/);return res(200,{device_code:'DEV',user_code:'ABCD-EFGH',verification_url:'https://www.google.com/device',expires_in:1800,interval:5});}
    if(url.endsWith('/token')){
      const p=new URLSearchParams(body);
      if(p.get('grant_type')==='urn:ietf:params:oauth:grant-type:device_code'){pollCount++;return pollCount<2?res(428,{error:'authorization_pending'}):res(200,{access_token:'AT1',refresh_token:'RT',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'});}
      if(p.get('grant_type')==='refresh_token')return p.get('refresh_token')==='RT'?res(200,{access_token:'AT2',expires_in:3600}):res(400,{error:'invalid_grant'});
    }
    if(url.includes('/revoke')){state.revoked.push(new URLSearchParams(body).get('token'));return res(200,{});}
    if(url.startsWith('https://www.googleapis.com/drive/v3/files?')&&opt.method==='POST'){const id='F'+(state.folders.size+1);state.folders.set(id,JSON.parse(body));return res(200,{id});}
    if(url.startsWith('https://www.googleapis.com/drive/v3/files/')){const id=decodeURIComponent(url.split('/files/')[1].split('?')[0]);return state.folders.has(id)?res(200,{id,trashed:state.trashed.has(id)}):res(404,{error:{message:'nf'}});}
    if(url.startsWith('https://www.googleapis.com/upload/')){const meta=JSON.parse(body);state.pendingMeta=meta;return res(200,{},{location:'https://upload.example/session1'});}
    if(url==='https://upload.example/session1'){const id='X'+(state.files.length+1);state.files.push({id,meta:state.pendingMeta,bytes:Buffer.from(opt.body)});return res(200,{id,name:state.pendingMeta.name,webViewLink:`https://drive.google.com/file/d/${id}/view`});}
    return res(500,{error:'unexpected '+url});
  };
  return {fetch,calls,state};
}
async function setup(env={clientId:'cid',clientSecret:'sec'}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'v092-'));const g=fakeGoogle();
  const timers=[];let t=1_000_000;
  const d=new GDrive({dataDir:dir,...env,fetchImpl:g.fetch,now:()=>t,setTimer:(fn,ms)=>timers.push({fn,ms})});
  const tick=async(ms=5000)=>{t+=ms;const due=timers.splice(0);for(const x of due)await x.fn();await new Promise(r=>setImmediate(r));};
  return {dir,g,d,tick,advance:ms=>{t+=ms;}};
}

test('설정이 없으면 꺼져 있고 연결을 거부한다', async()=>{
  const {d}=await setup({clientId:'',clientSecret:''});
  assert.equal(d.status().configured,false);
  await assert.rejects(d.connect(),/gdrive_not_configured/);
});

test('기기 코드 연결: 코드 표시 → 대기 → 허용되면 0600 파일에 저장', async()=>{
  const {d,tick,dir}=await setup();
  const s=await d.connect();
  assert.equal(s.pending.userCode,'ABCD-EFGH');assert.equal(s.connected,false);
  await tick();assert.equal(d.status().connected,false,'아직 대기 중');
  await tick();
  const st=d.status();assert.equal(st.connected,true);assert.equal(st.pending,null);
  const f=path.join(dir,'gdrive.json');assert.equal((await stat(f)).mode&0o777,0o600);
  assert.equal(JSON.parse(await readFile(f,'utf8')).refreshToken,'RT');
});

test('업로드: 폴더를 한 번 만들고 그 안에 파일을 올린다, 폴더가 휴지통이면 새로 만든다', async()=>{
  const {d,tick,g,dir}=await setup();
  await d.connect();await tick();await tick();
  const fp=path.join(dir,'code.zip');await writeFile(fp,Buffer.from('PK-zip-bytes'));
  const r=await d.upload(fp,'code.zip','application/zip');
  assert.equal(r.name,'code.zip');assert.match(r.link,/drive.google.com\/file\/d\/X1/);
  assert.equal(g.state.folders.get('F1').name,'AI 오피스');
  assert.deepEqual(g.state.files[0].meta.parents,['F1']);
  assert.equal(g.state.files[0].bytes.toString(),'PK-zip-bytes');
  await d.upload(fp,'code2.zip');
  assert.equal(g.state.folders.size,1,'폴더 재사용');
  g.state.trashed.add('F1');
  await d.upload(fp,'code3.zip');
  assert.equal(g.state.folders.size,2,'휴지통에 간 폴더는 새로 만듦');
  assert.match(d.status().folderUrl,/folders\/F2$/);
});

test('권한이 거둬지면(invalid_grant) 다시 연결하라고 하고 저장된 토큰을 지운다', async()=>{
  const {d,tick,dir,advance}=await setup();
  await d.connect();await tick();await tick();
  d.data.refreshToken='REVOKED';d.access=null;
  const fp=path.join(dir,'a.txt');await writeFile(fp,'x');
  await assert.rejects(d.upload(fp,'a.txt'),/gdrive_reconnect_required/);
  assert.equal(d.status().connected,false);
  await assert.rejects(stat(path.join(dir,'gdrive.json')));
});

test('연결 해제: 토큰을 Google 에 폐기 요청하고 파일을 지운다', async()=>{
  const {d,tick,g,dir}=await setup();
  await d.connect();await tick();await tick();
  await d.disconnect();
  assert.deepEqual(g.state.revoked,['RT']);
  assert.equal(d.status().connected,false);
  await assert.rejects(stat(path.join(dir,'gdrive.json')));
});

test('코드 시간이 지나면 대기를 끝내고 이유를 남긴다', async()=>{
  const {d,tick,advance}=await setup();
  await d.connect();advance(1800*1000);await tick();
  const s=d.status();assert.equal(s.pending,null);assert.equal(s.lastError,'gdrive_code_expired');
});

test('서버: 화면에 드라이브 띠와 업로드 버튼, API 는 업로드 대상을 파일함 안으로 제한', async()=>{
  const srv=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(srv,/\/api\/gdrive\/upload[\s\S]{0,200}safeName\(a\.name\)[\s\S]{0,80}ctx\.shared/);
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.match(html,/id="gdrive-bar"/);
});
