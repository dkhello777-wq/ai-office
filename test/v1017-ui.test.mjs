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
