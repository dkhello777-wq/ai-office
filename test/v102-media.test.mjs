// v0.10.2 AI 가 만든 이미지·영상을 방에 올리기: 새 파일 찾기 · 경로 언급 · 범위 제한 · 파일함 복사 · 화면 표시 · 영상 Range
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,cp,utimes,readdir,realpath} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {findNewMedia,collectMedia,mentionedPaths} from '../src/media.mjs';

const ROOT=new URL('..',import.meta.url).pathname;
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5d90000000049454e44ae426082','hex');

test('경로 언급 뽑기: "saved to /절대경로", 상대경로, 백틱 안 이름', ()=>{
  const ps=mentionedPaths('Image downloaded (12 bytes, png) and saved to /tmp/x/out 1.png.\n결과는 `shared/포스터.webp` 와 ./v/clip.mp4 에 있어요. no.txt',{cwd:'/w'});
  assert.ok(ps.includes('/tmp/x/out 1.png'));assert.ok(ps.includes('/w/shared/포스터.webp'));assert.ok(ps.includes('/w/v/clip.mp4'));
  assert.ok(!ps.some(p=>p.endsWith('.txt')));
});

test('새 미디어 찾기: 실행 중에 생긴 것만, 허용 폴더 안만, 이미 가져간 것은 빼고, 언급된 것이 먼저', async()=>{
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'v102-')));
  const ws=path.join(base,'workspace'),home=path.join(base,'home'),outside=path.join(base,'outside');
  for(const d of [ws,path.join(ws,'out'),path.join(ws,'.git'),path.join(home,'.grok','imagine'),outside])await mkdir(d,{recursive:true});
  const old=path.join(ws,'old.png');await writeFile(old,PNG);const t=new Date(Date.now()-3600e3);await utimes(old,t,t);
  const since=Date.now()-1000;
  await writeFile(path.join(ws,'out','a.png'),PNG);
  await writeFile(path.join(home,'.grok','imagine','b.jpg'),PNG);
  await writeFile(path.join(ws,'.git','c.png'),PNG);   // .git 은 건너뜀
  await writeFile(path.join(outside,'d.png'),PNG);     // 허용 밖 — 언급돼도 안 받음
  await writeFile(path.join(ws,'note.txt'),'x');
  const text=`saved to ${path.join(home,'.grok','imagine','b.jpg')} 그리고 ${path.join(outside,'d.png')}`;
  const got=await findNewMedia({roots:[{dir:ws,depth:6},{dir:home,depth:6}],allowed:[ws,home],since,text,cwd:ws});
  assert.deepEqual(got.map(f=>path.relative(base,f.path)),['home/.grok/imagine/b.jpg','workspace/out/a.png']);
  assert.equal(got[0].mentioned,true);
  const again=await findNewMedia({roots:[{dir:ws,depth:6}],allowed:[ws,home],since,text:'',cwd:ws,claimed:new Set([path.join(ws,'out','a.png')])});
  assert.deepEqual(again,[]);
  // 파일함 복사: shared 밖이면 "<AI>-<번호>-이름" 으로 복사, shared 안이면 그대로
  const shared=path.join(ws,'shared');await mkdir(shared);await writeFile(path.join(shared,'mine.webp'),PNG);
  const safeName=n=>String(n).replace(/[\\/]/g,'_');
  const media=await collectMedia([...got,{path:path.join(shared,'mine.webp'),size:PNG.length}],{shared,prefix:'grok-7',safeName});
  assert.deepEqual(media.map(x=>[x.name,x.kind]),[['grok-7-b.jpg','image'],['grok-7-a.png','image'],['mine.webp','image']]);
  assert.deepEqual((await readdir(shared)).sort(),['grok-7-a.png','grok-7-b.jpg','mine.webp']);
});

test('서버: AI 가 작업 폴더 밖(홈 아래)에 만든 이미지가 답변에 붙고 파일함에 들어가며, 영상은 Range 로 받는다', async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v102s-'));
  const script=`const fs=require('fs'),p=require('path');const d=p.join(process.env.HOME,'.grok','imagine');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'cat.png'),Buffer.from('${PNG.toString('hex')}','hex'));fs.writeFileSync(p.join(d,'clip.mp4'),Buffer.alloc(5000,7));process.stdout.write(JSON.stringify({text:'고양이 이미지를 만들었어요',session:'s1'}))`;
  const mk={id:'img',label:'img',color:'#888',command:'node',args:['-e',script],parse:'mock-json',enabled:true,envAllow:['MOCK_AUTH'],authCheck:{args:[path.join(ROOT,'src/adapters/mock-cli.mjs'),'--auth-status'],parser:'mock-json'}};
  await mkdir(path.join(dir,'config'),{recursive:true});
  await writeFile(path.join(dir,'config/adapters.json'),JSON.stringify({adapters:[mk],timeoutMs:20000,port:0,host:'127.0.0.1',allowedHosts:[],authCacheMs:0,users:{dir:'data/users'}}));
  await cp(path.join(ROOT,'src'),path.join(dir,'src'),{recursive:true});await cp(path.join(ROOT,'public'),path.join(dir,'public'),{recursive:true});
  const port=23000+Math.floor(Math.random()*2000);
  const srv=spawn('node',['src/server.mjs'],{cwd:dir,env:{PATH:process.env.PATH,HOME:process.env.HOME,PORT:String(port),MOCK_AUTH:'subscription',HUB_PASSWORD:'synthetic password 7'},stdio:['ignore','pipe','pipe']});
  t.after(()=>srv.kill());
  await new Promise(r=>srv.stdout.on('data',d=>{if(String(d).includes('AI Hub'))r();}));
  const url=`http://127.0.0.1:${port}`;
  const lr=await fetch(url+'/api/login',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({password:'synthetic password 7'})});
  const cookie=lr.headers.get('set-cookie').split(';')[0];
  const as=async(p,body)=>{const x=await fetch(url+p,body===undefined?{headers:{cookie}}:{method:'POST',headers:{cookie,'content-type':'application/json',origin:url},body:JSON.stringify(body)});return x;};
  await as('/api/send',{text:'고양이 그려줘',targets:['img']});
  let m;for(let i=0;i<80;i++){const st=await (await as('/api/state')).json();m=st.messages.find(x=>x.role==='assistant'&&x.status!=='running');if(m)break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(m.status,'done');
  assert.deepEqual(m.media.map(f=>[f.name,f.kind]).sort(),[[`img-${m.id}-cat.png`,'image'],[`img-${m.id}-clip.mp4`,'video']]);
  const img=await as('/files/'+encodeURIComponent(`img-${m.id}-cat.png`));
  assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await img.arrayBuffer()),PNG);
  const vr=await fetch(url+'/files/'+encodeURIComponent(`img-${m.id}-clip.mp4`),{headers:{cookie,range:'bytes=100-199'}});
  assert.equal(vr.status,206);assert.equal(vr.headers.get('content-range'),'bytes 100-199/5000');assert.equal((await vr.arrayBuffer()).byteLength,100);
  assert.equal((await fetch(url+'/files/'+encodeURIComponent(`img-${m.id}-clip.mp4`),{headers:{cookie,range:'bytes=9000-'}})).status,416);
});

test('프롬프트·화면: 결과 파일은 shared/ 에 저장하라는 안내, 답변 아래 이미지·영상 표시', async()=>{
  const srv=await readFile(path.join(ROOT,'src/server.mjs'),'utf8');
  assert.match(srv,/p\+=`\\n\\n`\+MEDIA_NOTE;/);assert.match(srv,/\$\{MEDIA_NOTE\}`;/,'팀원 작업 프롬프트에도');
  const app=await readFile(path.join(ROOT,'public/app.js'),'utf8');
  assert.match(app,/<video src="\$\{u\}" controls playsinline/);assert.match(app,/<img src="\$\{u\}"/);
});
