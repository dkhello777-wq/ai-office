// v0.9.1 화면 다듬기: 답변 순서(먼저 끝난 AI 부터)와 finishedAt 기록
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mkdtemp} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
await import('../public/order.js');
const order=globalThis.orderTimeline;
const ids=list=>order(list).map(m=>m.id);
const T=s=>`2026-10-19T00:00:${String(s).padStart(2,'0')}.000Z`;

test('모두에게: 먼저 끝난 답이 위, 아직 답하는 중인 말풍선은 아래', ()=>{
  const msgs=[
    {id:1,role:'user',at:T(0)},
    {id:2,role:'assistant',replyTo:1,adapter:'claude',status:'done',at:T(0),finishedAt:T(30)},
    {id:3,role:'assistant',replyTo:1,adapter:'codex',status:'running',at:T(0)},
    {id:4,role:'assistant',replyTo:1,adapter:'gemini',status:'done',at:T(0),finishedAt:T(10)},
  ];
  assert.deepEqual(ids(msgs),[1,4,2,3]);
});

test('끝난 시각 기록이 없는 옛 답변은 시작 시각 + 걸린 시간으로 비교', ()=>{
  const msgs=[
    {id:1,role:'user',at:T(0)},
    {id:2,role:'assistant',replyTo:1,status:'done',at:T(0),elapsedMs:20000},
    {id:3,role:'assistant',replyTo:1,status:'error',at:T(0),elapsedMs:5000},
  ];
  assert.deepEqual(ids(msgs),[1,3,2]);
});

test('질문이 여러 개여도 답변은 자기 질문 아래에만 모인다', ()=>{
  const msgs=[
    {id:1,role:'user',at:T(0)},
    {id:2,role:'assistant',replyTo:1,status:'done',at:T(0),finishedAt:T(9)},
    {id:3,role:'assistant',replyTo:1,status:'done',at:T(0),finishedAt:T(3)},
    {id:4,role:'user',at:T(20)},
    {id:5,role:'assistant',replyTo:4,status:'running',at:T(20)},
    {id:6,role:'assistant',replyTo:4,status:'done',at:T(20),finishedAt:T(25)},
  ];
  assert.deepEqual(ids(msgs),[1,3,2,4,6,5]);
});

test('팀장 모드(계획·작업·종합)는 순서를 바꾸지 않는다', ()=>{
  const msgs=[
    {id:1,role:'user',at:T(0),mode:'orchestrate'},
    {id:2,role:'assistant',replyTo:1,kind:'plan',status:'done',at:T(0),finishedAt:T(5)},
    {id:3,role:'assistant',replyTo:2,kind:'task',status:'done',at:T(5),finishedAt:T(40)},
    {id:4,role:'assistant',replyTo:2,kind:'task',status:'done',at:T(5),finishedAt:T(8)},
    {id:5,role:'assistant',replyTo:1,kind:'final',status:'running',at:T(41)},
  ];
  assert.deepEqual(ids(msgs),[1,2,3,4,5]);
});

test('store.update 가 답이 끝날 때 finishedAt 을 한 번만 남긴다', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v091-'));
  const s=new Store(new URL('file://'+path.join(dir,'state.json')));
  const u=s.add({role:'user',text:'hi'});
  const a=s.add({role:'assistant',replyTo:u.id,status:'running',text:''});
  assert.equal(a.finishedAt,undefined);
  s.update(a.id,{text:'부분'});
  assert.equal(s.get(a.id).finishedAt,undefined,'running 중에는 없음');
  s.update(a.id,{status:'done',text:'끝'});
  const first=s.get(a.id).finishedAt;
  assert.ok(Number.isFinite(Date.parse(first)));
  s.update(a.id,{status:'error',error:'persist_failed'});
  assert.equal(s.get(a.id).finishedAt,first,'한 번 정해지면 그대로');
  s.update(u.id,{text:'x'});
  assert.equal(s.get(u.id).finishedAt,undefined,'사용자 메시지에는 안 붙음');
});

test('화면이 order.js 를 app.js 보다 먼저 불러오고, 펼치기는 다시 그리지 않고 제자리에서 바꾼다', async()=>{
  const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
  assert.ok(html.indexOf('/order.js')>0&&html.indexOf('/order.js')<html.indexOf('/app.js'));
  const app=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
  assert.match(app,/orderTimeline\(state\.messages\)/);
  assert.match(app,/onclick=\(\)=>toggleClip\(b\)/);
  assert.doesNotMatch(app,/data-clip[^\n]*renderTimeline\(\)/,'펼치기에서 전체를 다시 그리면 맨 아래로 튄다');
});
