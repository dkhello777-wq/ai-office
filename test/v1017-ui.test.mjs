// v0.10.17 UI: 저장 공간 경고 띠 · 파일함 찾기/정렬/지우기 · 파일함의 shared 파일은 지울 수 있고 memory.md 는 못 지운다
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {deletePath} from '../src/janitor.mjs';
const ROOT=new URL('../',import.meta.url).pathname;

test('화면: 경고 띠(85%·95%)와 파일함 찾기·정렬·🗑 이 있다', async()=>{
  const html=await readFile(ROOT+'public/index.html','utf8');
  assert.match(html,/id="disk-warn"/);assert.match(html,/id="file-q"/);assert.match(html,/id="file-sort"/);
  const app=await readFile(ROOT+'public/app.js','utf8');
  assert.match(app,/const DISK_WARN=85,DISK_BAD=95;/);assert.match(app,/function showDiskWarn\(s\)/);
  assert.match(app,/path:'workspace\/shared\/'\+n/);
});

test('파일함 🗑: workspace/shared/<이름> 은 지워지고 memory.md·../ 는 거부', async()=>{
  const users=await mkdtemp(path.join(os.tmpdir(),'v1017-'));const u=path.join(users,'1');
  await mkdir(path.join(u,'workspace/shared'),{recursive:true});
  await writeFile(path.join(u,'workspace/shared/a.png'),Buffer.alloc(1000));await writeFile(path.join(u,'workspace/memory.md'),'x');
  const r=await deletePath(users,'1','workspace/shared/a.png');assert.equal(r.ok,true);assert.equal(r.bytes,1000);
  await assert.rejects(stat(path.join(u,'workspace/shared/a.png')));
  assert.equal((await deletePath(users,'1','workspace/memory.md')).error,'not_deletable');
  assert.equal((await deletePath(users,'1','workspace/shared/../../state.json')).error,'bad_path');
});

test('빠른 저장 공간 계산(find): 영역 합계·node_modules 통째·깊은 폴더 단위·심볼릭 링크 무시·N일 지난 자료 미리보기', async()=>{
  const {breakdown,purgeOld}=await import('../src/janitor.mjs');const {symlink,utimes}=await import('node:fs/promises');
  const users=await mkdtemp(path.join(os.tmpdir(),'v1017b-'));const u=path.join(users,'1');
  const mk=async(rel,bytes)=>{const p=path.join(u,rel);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,Buffer.alloc(bytes,1));return p;};
  await mk('workspace/memory.md',10);await mk('workspace/shared/한글 이름 (1).md',2_000);
  await mk('workspace/p/node_modules/a/i.js',3_000);await mk('workspace/p/node_modules/b/i.js',4_000);
  const deep=await mk('workspace/a/b/c/d/e/f/g/h/deep.txt',500);await mk('home/.cache/x/y',6_000);await mk('home/.claude/projects/s.jsonl',700);
  await symlink('/etc',path.join(u,'workspace/link'));
  const r=await breakdown(users);const me=r.users[0];
  assert.equal(me.areas.workspace,10+2_000+7_000+500);assert.equal(me.areas.shared,2_000);assert.equal(me.areas.home['.cache'],6_000);assert.equal(me.areas.home['.claude'],700);
  const byPath=Object.fromEntries(me.top.map(x=>[x.path,x]));
  assert.equal(byPath['workspace/p/node_modules'].bytes,7_000);assert.equal(byPath['workspace/p/node_modules'].dir,true);
  assert.equal(byPath['workspace/a/b/c/d/e/f/g'].dir,true);assert.ok(!me.top.some(x=>x.path.startsWith('workspace/link')));
  const old=(Date.now()-5*86400e3)/1000;await utimes(deep,old,old);
  const pv=await purgeOld(users,'1',{days:2,dryRun:true});
  assert.deepEqual(pv.items.map(x=>x.path),['workspace/a/b/c/d/e/f/g']);
});
