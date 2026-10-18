// v0.9.0 저장 공간 안전장치: 지울 수 있는 기록만, 오래된 것부터, 규칙대로 지우는지.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sweep,listCandidates,diskUsage} from '../src/janitor.mjs';

const DAY=86400e3,NOW=Date.parse('2026-10-19T00:00:00Z');
const exists=p=>stat(p).then(()=>true,()=>false);
async function put(p,bytes,ageDays){await mkdir(path.dirname(p),{recursive:true});await writeFile(p,Buffer.alloc(bytes));const t=new Date(NOW-ageDays*DAY);await utimes(p,t,t);await utimes(path.dirname(p),t,t);}
// 가짜 디스크: total 고정, used = 시작값 - 지금까지 지운 바이트 (실제 파일 크기로 계산)
async function tree(){
  const root=await mkdtemp(path.join(os.tmpdir(),'jan-'));const u=path.join(root,'users','1');
  await put(path.join(u,'runs','10-claude','stdout.bin'),100,40);   // 40일 전 → 항상 삭제
  await put(path.join(u,'runs','20-codex','stdout.bin'),200,10);
  await put(path.join(u,'runs','30-gemini','stdout.bin'),300,5);
  await put(path.join(u,'runs','40-claude','stdout.bin'),400,0.01); // 15분 전 → 보호
  await put(path.join(u,'home','.codex','sessions','2026','a.jsonl'),250,8);
  await put(path.join(u,'home','.claude','projects','x','b.jsonl'),150,3);
  // 절대 지우면 안 되는 것들 (아주 오래됐어도)
  await put(path.join(u,'workspace','shared','내파일.txt'),999,90);
  await put(path.join(u,'workspace','memory.md'),50,90);
  await put(path.join(u,'state.json'),50,90);
  await put(path.join(u,'home','.codex','auth.json'),10,90);
  await put(path.join(u,'home','.claude','.credentials.json'),10,90);
  await put(path.join(u,'home','.gemini','oauth_creds.json'),10,90);
  return {root,usersDir:path.join(root,'users'),u};
}
const fakeUsage=(total,startUsed,usersDir)=>{let base=null;return async()=>{const items=await listCandidates(usersDir);const now=items.reduce((a,i)=>a+i.bytes,0);if(base===null)base=startUsed-now;const used=base+now;return {total,used,free:total-used,pct:Math.round(used/total*1000)/10};};};

test('low usage: only records older than maxAgeDays go; recent and protected stay; user files, conversation and logins never touched',async()=>{
  const {usersDir,u}=await tree();
  const r=await sweep(usersDir,{},{usage:fakeUsage(10000,2000,usersDir),now:NOW});   // 20% 사용 → 압박 없음
  assert.equal(r.pressure,false);assert.equal(r.deleted,1);assert.equal(r.reasons.age,1);
  assert.equal(await exists(path.join(u,'runs','10-claude')),false,'40-day-old run removed');
  for(const keep of ['runs/20-codex','runs/30-gemini','runs/40-claude','home/.codex/sessions/2026/a.jsonl','home/.claude/projects/x/b.jsonl'])assert.ok(await exists(path.join(u,keep)),keep);
});

test('high usage: deletes oldest first until under lowPct, never the protected recent run, never user data or logins',async()=>{
  const {usersDir,u}=await tree();
  // total 2000, used 1500 (75%) → 목표 50% = 1000 → 500 바이트 이상 지워야 함. 오래된 순: 10-claude(100,40일) 20-codex(200,10일) a.jsonl(250,8일) …
  const r=await sweep(usersDir,{highPct:70,lowPct:50},{usage:fakeUsage(2000,1500,usersDir),now:NOW});
  assert.equal(r.pressure,true);
  assert.deepEqual(r.reasons,{age:1,pressure:2});assert.equal(r.freedBytes,550);
  assert.ok(r.after.pct<=50,'got under lowPct: '+r.after.pct);
  for(const gone of ['runs/10-claude','runs/20-codex','home/.codex/sessions/2026/a.jsonl'])assert.equal(await exists(path.join(u,gone)),false,gone);
  for(const keep of ['runs/30-gemini','runs/40-claude','home/.claude/projects/x/b.jsonl'])assert.ok(await exists(path.join(u,keep)),keep);
  for(const keep of ['workspace/shared/내파일.txt','workspace/memory.md','state.json','home/.codex/auth.json','home/.claude/.credentials.json','home/.gemini/oauth_creds.json'])assert.ok(await exists(path.join(u,keep)),'must never delete '+keep);
});

test('nothing deletable left: reports stillHigh instead of touching anything else; diskUsage reads a real filesystem',async()=>{
  const {usersDir,u}=await tree();
  const r=await sweep(usersDir,{highPct:10,lowPct:5,protectHours:24*365},{usage:async()=>({total:1000,used:900,free:100,pct:90}),now:NOW});
  assert.equal(r.deleted,0,'everything is inside the protect window');assert.equal(r.stillHigh,true);
  assert.equal((await readdir(path.join(u,'runs'))).length,4);
  const d=await diskUsage(os.tmpdir());assert.ok(d.total>0&&d.pct>=0&&d.pct<=100);
});
