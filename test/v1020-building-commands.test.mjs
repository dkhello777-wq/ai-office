// v0.10.20 빌딩 지시 받기: 지시·결정 답을 대화방 글로 바꾸기, 받기→시작→보내기→완료 알림
import test from 'node:test';
import assert from 'node:assert/strict';
import {commandToSend,commandResult,startBuildingWorker,BUILDING_MARK,BUILDING_ANSWER_MARK} from '../src/building.mjs';

const ask={id:7,role:'assistant',adapter:'claude',status:'done',approvalRequested:true,text:'[승인 요청] 로그 폴더(2.1GB)를\n지워도 될까요?'};

test('commandToSend: 일반 지시는 팀장 AI 에게, 없으면 첫 AI 에게', ()=>{
  assert.deepEqual(commandToSend({body:' 카드뉴스 3장 만들어 줘 '},{lead:'codex',adapterIds:['claude','codex']}),{text:`${BUILDING_MARK}\n카드뉴스 3장 만들어 줘`,targets:['codex']});
  assert.deepEqual(commandToSend({body:'x'},{lead:null,adapterIds:['claude','codex']}).targets,['claude']);
  assert.deepEqual(commandToSend({body:'x'},{lead:'gone',adapterIds:['grok']}).targets,['grok']);
  assert.equal(commandToSend({body:'x'},{adapterIds:[]}).error,'no_adapter');
});

test('commandToSend: 결정 답은 그 승인 요청을 한 AI 에게 허락/거절로', ()=>{
  const yes=commandToSend({body:'[결정 답] …',decision:{id:'m7',answer:'허락'}},{messages:[ask],lead:'codex',adapterIds:['claude','codex']});
  assert.deepEqual(yes.targets,['claude']);
  assert.ok(yes.text.startsWith(`${BUILDING_ANSWER_MARK} 허락합니다.`));
  assert.match(yes.text,/요청 내용: 로그 폴더\(2\.1GB\)를 지워도 될까요\?/);
  const no=commandToSend({decision:{id:'m7',answer:'거절'}},{messages:[ask],adapterIds:['claude']});
  assert.match(no.text,/거절합니다\. 승인 요청하신 일은 하지 말고/);
  assert.equal(commandToSend({decision:{id:'m8',answer:'허락'}},{messages:[ask],adapterIds:['claude']}).error,'decision_gone');
  assert.equal(commandToSend({decision:{id:'logs-1',answer:'허락'}},{messages:[ask],adapterIds:['claude']}).error,'decision_gone');
});

test('commandResult: 답이 다 끝나야 완료, 첫 줄을 결과로', ()=>{
  const u={id:10,role:'user'};
  assert.equal(commandResult(u,[u]),null);
  assert.equal(commandResult(u,[u,{role:'assistant',replyTo:10,status:'running'}]),null);
  assert.deepEqual(commandResult(u,[u,{role:'assistant',replyTo:10,status:'done',text:'다 했어요\n자세히는…'}]),{ok:true,note:'다 했어요 자세히는…'});
  assert.deepEqual(commandResult(u,[u,{role:'assistant',replyTo:10,status:'error',error:'timeout'}]),{ok:false,note:'AI 가 답하지 못했어요 (timeout)'});
});

// 가짜 빌딩: 보관함에 지시를 넣어 두고 claim/start/finish 호출을 기록한다
function fakeBuilding(commands,{offDuty=false}={}){
  const calls=[];
  const fetchImpl=async(u,opts)=>{
    const p=new URL(u).pathname,body=JSON.parse(opts.body);calls.push([p,body,opts.headers.Authorization]);
    let out;
    if(p==='/api/floor/work/claim')out={offDuty,command:offDuty?null:commands.shift()??null};
    else if(p.endsWith('/start'))out={ok:true};
    else if(p.endsWith('/finish'))out={ok:true};
    return {ok:true,status:200,json:async()=>out};
  };
  return {calls,fetchImpl};
}
function fakeCtx(messages=[]){
  let next=100;
  const store={state:{messages},update(id,patch){const m=messages.find(x=>x.id===id);Object.assign(m,patch);return m;},save:async()=>{}};
  const ctx={store};
  const send=async(_ctx,{text,targets})=>{const m={id:next++,role:'user',text,targets};messages.push(m);return m;};
  return {ctx,send,messages};
}

test('startBuildingWorker: 받기→시작→대화방에 보내기, 답이 끝나면 완료 알림 (한 번만)', async()=>{
  const b=fakeBuilding([{id:'cmd_1',body:'오늘 할 일 정리'},{id:'cmd_2',body:'',decision:{id:'m7',answer:'허락'}}]);
  const {ctx,send,messages}=fakeCtx([ask]);
  const logs=[];
  const w=startBuildingWorker({url:'https://building.test',key:'wk_x',getCtx:async()=>ctx,send,lead:()=>'codex',adapterIds:['claude','codex'],fetchImpl:b.fetchImpl,log:l=>logs.push(l),setTimer:()=>null,clearTimer:()=>{}});
  await w.ready;
  assert.deepEqual(b.calls.map(c=>c[0]),['/api/floor/work/claim','/api/floor/commands/cmd_1/start','/api/floor/work/claim','/api/floor/commands/cmd_2/start','/api/floor/work/claim']);
  assert.ok(b.calls.every(c=>c[2]==='Bearer wk_x'));
  const sent=messages.filter(m=>m.role==='user');
  assert.deepEqual(sent.map(m=>[m.targets[0],m.buildingCommand]),[['codex','cmd_1'],['claude','cmd_2']]);
  assert.ok(sent[0].text.startsWith(BUILDING_MARK));
  // 아직 답이 없으면 완료 알림 없음
  b.calls.length=0;await w.tick();
  assert.deepEqual(b.calls.map(c=>c[0]),['/api/floor/work/claim']);
  // 답이 끝나면 완료 알림
  messages.push({id:200,role:'assistant',replyTo:sent[0].id,status:'done',text:'정리했어요'},{id:201,role:'assistant',replyTo:sent[1].id,status:'blocked',error:'quota_cooldown'});
  b.calls.length=0;await w.tick();
  assert.deepEqual(b.calls.slice(0,2).map(c=>[c[0],c[1]]),[
    ['/api/floor/commands/cmd_1/finish',{ok:true,note:'정리했어요'}],
    ['/api/floor/commands/cmd_2/finish',{ok:false,note:'AI 가 답하지 못했어요 (quota_cooldown)'}],
  ]);
  b.calls.length=0;await w.tick();
  assert.ok(!b.calls.some(c=>c[0].endsWith('/finish')),'완료는 한 번만 알린다');
  assert.ok(logs.some(l=>l.includes('지시 받기 시작')));
});

test('startBuildingWorker: 지나간 결정 답은 보내지 않고 실패로 알린다 · 퇴근 중이면 아무것도 안 함 · 로그인 전이면 쉰다', async()=>{
  const b=fakeBuilding([{id:'cmd_9',decision:{id:'m55',answer:'거절'}}]);
  const {ctx,send,messages}=fakeCtx([]);
  const w=startBuildingWorker({url:'https://building.test',key:'k',getCtx:async()=>ctx,send,adapterIds:['claude'],fetchImpl:b.fetchImpl,log:()=>{},setTimer:()=>null});
  await w.ready;
  assert.equal(messages.length,0);
  assert.deepEqual(b.calls.find(c=>c[0].endsWith('/finish'))[1],{ok:false,note:'이미 지나간 질문이라 대화방에 보내지 않았어요'});

  const off=fakeBuilding([{id:'cmd_x',body:'y'}],{offDuty:true});
  const o=startBuildingWorker({url:'https://building.test',key:'k',getCtx:async()=>fakeCtx().ctx,send:()=>assert.fail('퇴근 중에 보냄'),adapterIds:['claude'],fetchImpl:off.fetchImpl,log:()=>{},setTimer:()=>null});
  await o.ready;
  assert.deepEqual(off.calls.map(c=>c[0]),['/api/floor/work/claim']);

  const none=fakeBuilding([{id:'cmd_y',body:'z'}]);
  const n=startBuildingWorker({url:'https://building.test',key:'k',getCtx:async()=>null,send:()=>assert.fail(),adapterIds:['claude'],fetchImpl:none.fetchImpl,log:()=>{},setTimer:()=>null});
  await n.ready;
  assert.equal(none.calls.length,0);
});

test('startBuildingWorker: 빌딩이 안 되면 로그 한 줄만 (연속 실패로 넘치지 않게)', async()=>{
  const logs=[];
  const w=startBuildingWorker({url:'https://building.test',key:'k',getCtx:async()=>fakeCtx().ctx,send:async()=>{},adapterIds:['claude'],fetchImpl:async()=>{throw new Error('ECONNREFUSED');},log:l=>logs.push(l),setTimer:()=>null});
  await w.ready;await w.tick();await w.tick();
  assert.equal(logs.length,1);assert.match(logs[0],/지시 받기 실패: ECONNREFUSED/);
});
