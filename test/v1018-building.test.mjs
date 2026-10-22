// v0.10.18 AI 빌딩 보고: 오류 창 · 작업 수 세기 · 보고 본문 · 전송(열쇠 헤더, 실패 로그, 비밀 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import {ErrorWindow,workSummary,buildReport,startBuildingReporter} from '../src/building.mjs';

test('ErrorWindow: 24시간 지난 오류는 세지 않는다', ()=>{
  let t=1_000_000;const w=new ErrorWindow({now:()=>t});
  w.record();t+=3600*1000;w.record();
  assert.equal(w.count(),2);assert.equal(w.lastAt(),t);
  t+=23*3600*1000+1;   // 첫 기록이 24시간을 넘김
  assert.equal(w.count(),1);
  t+=24*3600*1000;
  assert.equal(w.count(),0);assert.equal(w.lastAt(),null);
});

test('workSummary: 마지막 질문 뒤의 답변만 센다', ()=>{
  const ctx={running:new Set(['a','b']),queue:[{}],store:{state:{messages:[
    {id:1,role:'user'},{id:2,role:'assistant',status:'blocked'},{id:3,role:'assistant',status:'done',approvalRequested:true},
    {id:4,role:'user'},{id:5,role:'assistant',status:'blocked',error:'quota_cooldown'},{id:6,role:'assistant',status:'done',approvalRequested:true},{id:7,role:'assistant',status:'done'},
  ]}}};
  assert.deepEqual(workSummary(ctx),{active:3,blocked:1,waiting:1});
  assert.deepEqual(workSummary(null),{active:0,blocked:0,waiting:0});
});

test('buildReport: 정해진 숫자 칸만, 디스크는 바이트로', ()=>{
  const errors=new ErrorWindow({now:()=>5000});errors.record(4000);
  const b=buildReport({version:'0.10.18',disk:{total:5e9,used:4.7e9,free:3e8,pct:94},errors,work:{active:1,blocked:0,waiting:2}});
  assert.deepEqual(b,{version:'0.10.18',diskUsedBytes:4.7e9,diskTotalBytes:5e9,errorCount:1,lastErrorAt:4000,work:{active:1,blocked:0,waiting:2}});
  assert.deepEqual(buildReport({version:undefined}),{version:'unknown'});
});

test('startBuildingReporter: 열쇠는 헤더로만, 실패는 상태가 바뀔 때만 로그', async()=>{
  const calls=[],logs=[];let fail=false;
  const fetchImpl=async(u,o)=>{calls.push({url:String(u),headers:o.headers,body:JSON.parse(o.body)});return fail?{ok:false,status:401,text:async()=>'{"error":"열쇠가 맞지 않습니다."}'}:{ok:true};};
  let tickFn;const stop=startBuildingReporter({url:'https://building.example',key:'rk_test',version:'0.10.18',intervalSec:300,
    getDisk:async()=>({total:100,used:40}),getWork:()=>({active:1,blocked:0,waiting:0}),errors:new ErrorWindow(),
    fetchImpl,log:m=>logs.push(m),setTimer:(fn)=>{tickFn=fn;return {unref(){}};},clearTimer:()=>{}});
  await new Promise(r=>setTimeout(r,10));
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://building.example/api/floor/report');
  assert.equal(calls[0].headers.Authorization,'Bearer rk_test');
  assert.deepEqual(calls[0].body,{version:'0.10.18',diskUsedBytes:40,diskTotalBytes:100,errorCount:0,work:{active:1,blocked:0,waiting:0}});
  assert.ok(!JSON.stringify(calls[0].body).includes('rk_test'),'본문에 열쇠가 섞이지 않는다');
  assert.equal(logs.length,1);assert.match(logs[0],/보고 시작/);
  fail=true;await tickFn();await tickFn();
  assert.equal(logs.length,2);assert.match(logs[1],/보고 실패: HTTP 401/);
  fail=false;await tickFn();
  assert.equal(logs.length,3);assert.match(logs[2],/보고 시작/);
  stop();
});
