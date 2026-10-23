// v0.10.19 AI 빌딩 보고: 작업 목록(제목·상태)과 결정 질문을 빌딩 서버가 받는 모양으로 만든다
import test from 'node:test';
import assert from 'node:assert/strict';
import {workDetail,buildReport} from '../src/building.mjs';

const label=id=>({claude:'클로드',codex:'코덱스'})[id]??id;
const at=s=>`2026-10-22T09:${s}:00.000Z`;

test('workDetail: 일하는 중·막힘·끝남 제목과 결정 질문', ()=>{
  const ctx={running:new Set(['x']),store:{state:{messages:[
    {id:1,role:'user',text:'옛날 질문',at:at('00')},
    {id:2,role:'assistant',adapter:'claude',replyTo:1,kind:'answer',status:'done',text:'끝',at:at('01')},
    {id:3,role:'assistant',adapter:'codex',replyTo:1,kind:'answer',status:'done',approvalRequested:true,text:'[승인 요청] 옛 허락',at:at('02')},
    {id:4,role:'user',text:'로그 폴더 정리해 줘\n자세한 설명은 여기',at:at('10'),mode:'orchestrate'},
    {id:5,role:'assistant',adapter:'claude',replyTo:4,kind:'plan',status:'done',text:'{}',at:at('11')},
    {id:6,role:'assistant',adapter:'codex',replyTo:5,kind:'task',taskTitle:'큰 파일 찾기',status:'running',text:'',at:at('12')},
    {id:7,role:'assistant',adapter:'claude',replyTo:5,kind:'task',taskTitle:'로그 지우기',status:'done',approvalRequested:true,text:'[승인 요청] 로그 폴더(2.1GB)를\n  지워도 될까요?',at:at('13')},
    {id:8,role:'assistant',adapter:'codex',replyTo:4,kind:'answer',status:'blocked',error:'quota_cooldown',at:at('14')},
  ]}}};
  const w=workDetail(ctx,{label});
  assert.equal(w.active,1);assert.equal(w.blocked,1);assert.equal(w.waiting,1);
  assert.deepEqual(w.items,[
    {title:'코덱스 · 큰 파일 찾기',state:'active',since:Date.parse(at('12'))},
    {title:'코덱스 · 로그 폴더 정리해 줘 자세한 설명은 여기',state:'blocked',reason:'사용 한도에 걸려 쉬는 중이에요',since:Date.parse(at('14'))},
    {title:'클로드 · 옛날 질문',state:'done',since:Date.parse(at('01'))},
  ],'계획(①)과 승인 요청 답변은 끝난 일에 넣지 않는다');
  assert.deepEqual(w.decisions,[{id:'m7',question:'클로드: 로그 폴더(2.1GB)를 지워도 될까요?',options:['허락','거절'],since:Date.parse(at('13'))}],'지난 라운드의 승인 요청은 결정 질문에서 빠진다');
});

test('workDetail: 제목·질문 길이를 빌딩 한도 안으로, 끝난 일은 최근 것부터 몇 개만', ()=>{
  const long='가'.repeat(500);
  const msgs=[{id:1,role:'user',text:long,at:at('00')}];
  for(let i=0;i<8;i++)msgs.push({id:2+i,role:'assistant',adapter:'claude',replyTo:1,kind:'answer',status:'done',text:'x',at:at(String(10+i))});
  msgs.push({id:20,role:'user',text:'다음',at:at('30')},{id:21,role:'assistant',adapter:'claude',replyTo:20,status:'done',approvalRequested:true,text:'[승인 요청] '+long,at:at('31')});
  const w=workDetail({running:new Set(),store:{state:{messages:msgs}}},{label});
  assert.equal(w.items.length,5);
  assert.equal(w.items[0].since,Date.parse(at('17')));
  for(const it of w.items)assert.ok(it.title.length<=120&&it.title.endsWith('…'));
  assert.ok(w.decisions[0].question.length<=300);
  assert.deepEqual(workDetail(null),{active:0,blocked:0,waiting:0,items:[],decisions:[]});
});

test('buildReport: 작업 목록과 결정 질문을 work 안에 그대로 싣는다', ()=>{
  const items=[{title:'a',state:'active'}],decisions=[{id:'m1',question:'q',options:['허락','거절']}];
  assert.deepEqual(buildReport({version:'0.10.19',work:{active:1,blocked:0,waiting:1,items,decisions}}).work,{active:1,blocked:0,waiting:1,items,decisions});
  assert.deepEqual(buildReport({version:'0.10.19',work:{active:1,blocked:0,waiting:0}}).work,{active:1,blocked:0,waiting:0},'목록이 없으면 예전 모양 그대로');
});
