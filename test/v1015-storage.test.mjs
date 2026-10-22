// v0.10.15 저장 공간: 무엇이 큰지(breakdown) · 고른 항목 지우기(허용 범위만) · 캐시도 자동 정리 대상
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {breakdown,deletePath,listCandidates} from '../src/janitor.mjs';

test('breakdown: 영역별 크기·큰 항목(node_modules 는 통째로), deletePath 는 작업 폴더·캐시·CLI 로그만 지운다', async()=>{
  const users=await mkdtemp(path.join(os.tmpdir(),'v1015-'));const u=path.join(users,'1');
  const mk=async(rel,bytes)=>{const p=path.join(u,rel);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,Buffer.alloc(bytes,1));};
  await mk('workspace/memory.md',100);await mk('workspace/shared/big.mp4',5_000_000);await mk('workspace/proj/node_modules/a/index.js',300_000);await mk('workspace/proj/node_modules/b/index.js',400_000);
  await mk('home/.npm/_cacache/x',200_000);await mk('home/.claude/auth.json',50);await mk('home/.claude/projects/p/s.jsonl',10_000);await mk('home/.grok/auth.json',40);await mk('home/.grok/sessions/s1.json',3_000);
  await mk('runs/1-mock/stdout',1_000);await writeFile(path.join(u,'state.json'),'{}');
  const b=await breakdown(users,{top:5});const me=b.users[0];
  assert.equal(me.areas.shared,5_000_000);assert.ok(me.areas.workspace>=5_700_100);assert.equal(me.areas.runs,1_000);assert.equal(me.areas.home['.npm'],200_000);
  assert.equal(me.top[0].path,'workspace/shared/big.mp4');
  const nm=me.top.find(x=>x.path==='workspace/proj/node_modules');assert.ok(nm&&nm.dir&&nm.bytes===700_000,'node_modules 는 한 항목');
  // 허용: 파일함 파일, node_modules, npm 캐시, claude projects 로그
  for(const rel of ['workspace/shared/big.mp4','workspace/proj/node_modules','home/.npm/_cacache','home/.claude/projects/p'])assert.equal((await deletePath(users,'1',rel)).ok,true,rel);
  await assert.rejects(stat(path.join(u,'workspace/shared/big.mp4')));
  // 거부: memory.md, state.json, 로그인 정보, 상위 탈출, 그록 세션
  for(const rel of ['workspace/memory.md','state.json','home/.claude/auth.json','home/.grok/auth.json','home/.grok/sessions/s1.json','workspace/../state.json','home','workspace'])assert.ok((await deletePath(users,'1',rel)).error,rel);
  assert.equal((await deletePath(users,'1','workspace/nope.txt')).error,'not_found');
  await assert.doesNotReject(stat(path.join(u,'workspace/memory.md')));await assert.doesNotReject(stat(path.join(u,'home/.claude/auth.json')));
  // 캐시는 자동 정리 후보
  await mk('home/.cache/pip/w.whl',10);
  const c=await listCandidates(users);assert.ok(c.some(i=>i.path.endsWith('.cache/pip/w.whl')));
});

test('화면·API: /api/storage?detail=1, /api/storage/delete, 저장 공간 시트', async()=>{
  const ROOT=new URL('..',import.meta.url).pathname;
  const srv=await readFile(ROOT+'src/server.mjs','utf8');assert.match(srv,/janitor\.info\(url\.searchParams\.get\('detail'\)==='1'\)/);assert.match(srv,/url\.pathname==='\/api\/storage\/delete'/);
  const app=await readFile(ROOT+'public/app.js','utf8');assert.match(app,/async function renderStorage\(\)/);assert.match(app,/api\('\/api\/storage\?detail=1'\)/);assert.match(app,/api\('\/api\/storage\/delete'/);
  const html=await readFile(ROOT+'public/index.html','utf8');assert.match(html,/<dialog id="storage" class="sheet">/);
});

test('v0.10.16 purgeOld: N일 지난 작업 파일·캐시만(미리보기/삭제), memory.md·.git·최근 파일·로그인 정보는 남긴다', async()=>{
  const users=await mkdtemp(path.join(os.tmpdir(),'v1016-'));const u=path.join(users,'1');
  const {utimes}=await import('node:fs/promises');
  const mk=async(rel,bytes,ageDays)=>{const p=path.join(u,rel);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,Buffer.alloc(bytes,1));const t=new Date(Date.now()-ageDays*86400e3);await utimes(p,t,t);};
  await mk('workspace/memory.md',10,30);await mk('workspace/old.mp4',1000,5);await mk('workspace/new.txt',100,0.5);await mk('workspace/shared/old.png',500,3);
  await mk('workspace/proj/node_modules/a.js',700,10);await mk('workspace/proj/.git/HEAD',20,10);await mk('home/.npm/_cacache/x',300,9);await mk('home/.claude/auth.json',5,40);await mk('home/.grok/sessions/s.json',5,40);
  const {purgeOld}=await import('../src/janitor.mjs');
  const pv=await purgeOld(users,'1',{days:2,dryRun:true});
  assert.equal(pv.dryRun,true);assert.deepEqual(pv.items.map(i=>i.path).sort(),['home/.npm/_cacache','workspace/old.mp4','workspace/proj/node_modules','workspace/shared/old.png']);
  await assert.doesNotReject(stat(path.join(u,'workspace/old.mp4')),'미리보기는 안 지움');
  const r=await purgeOld(users,'1',{days:2});
  assert.equal(r.deleted,4);assert.equal(r.bytes,2500);
  for(const rel of ['workspace/old.mp4','workspace/shared/old.png','workspace/proj/node_modules','home/.npm/_cacache'])await assert.rejects(stat(path.join(u,rel)),rel);
  for(const rel of ['workspace/memory.md','workspace/new.txt','workspace/proj/.git/HEAD','home/.claude/auth.json','home/.grok/sessions/s.json'])await assert.doesNotReject(stat(path.join(u,rel)),rel);
});
