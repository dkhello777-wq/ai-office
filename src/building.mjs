// v0.10.18 AI 빌딩 보고: 버전·디스크·최근 오류 수·작업 수를 빌딩 서버(dkhello777-wq/ai-building)에 정해진 간격으로 보낸다.
// AI 는 쓰지 않는 일반 보고 프로그램이다. BUILDING_URL 과 BUILDING_REPORT_KEY 가 둘 다 있을 때만 켜지고,
// 보고에 실패해도 로그 한 줄로 끝난다 (사이트 동작에는 영향 없음). 대화 본문·오류 원문·키는 보내지 않는다.
// v0.10.19: 숫자와 함께 작업 목록(요청 첫 줄로 만든 짧은 제목)과 결정 질문([승인 요청] 답변의 첫 줄)도 보낸다.

// 최근 N시간 안의 실행 오류 시각만 기억한다 (본문 없음).
export class ErrorWindow{
  constructor({windowMs=24*3600*1000,now=()=>Date.now()}={}){this.windowMs=windowMs;this.now=now;this.times=[];}
  trim(){const cut=this.now()-this.windowMs;while(this.times.length&&this.times[0]<cut)this.times.shift();}
  record(at=this.now()){this.times.push(at);if(this.times.length>5000)this.times.shift();}
  count(){this.trim();return this.times.length;}
  lastAt(){this.trim();return this.times.length?this.times.at(-1):null;}
}

// 사용자 컨텍스트에서 "지금 일하는 중·막힘·결정 대기" 수를 센다. 마지막 사용자 메시지 뒤의 답변만 본다 (= 지금 진행 중인 라운드).
// running 에는 대기열에서 기다리는 실행도 이미 들어 있다 (runOne 이 자리를 얻기 전에 넣음) — queue 를 더하면 두 번 센다.
export function workSummary(ctx){
  if(!ctx)return {active:0,blocked:0,waiting:0};
  const round=currentRound(ctx.store?.state?.messages??[]);
  return {
    active:ctx.running?.size??0,
    blocked:round.filter(m=>m.status==='blocked').length,
    waiting:round.filter(m=>m.status==='done'&&m.approvalRequested).length,
  };
}
function currentRound(msgs){
  let lastUser=-1;for(const m of msgs)if(m.role==='user'&&m.id>lastUser)lastUser=m.id;
  return msgs.filter(m=>m.role==='assistant'&&m.id>lastUser);
}

// v0.10.19 빌딩 방 상세에 보일 작업 목록과 결정 질문.
// 작업 제목 = "AI 이름 · 요청 첫 줄"(팀원 작업은 팀장이 붙인 작업 제목). 일하는 중(실행·대기)은 전부, 막힌 일과 결정 질문은 지금 라운드만, 끝난 일은 최근 몇 개만.
const BLOCK_REASON={user_disabled:'긴급 중지로 멈췄어요',quota_cooldown:'사용 한도에 걸려 쉬는 중이에요',budget_exceeded:'이번 달 토큰 예산을 넘었어요',
  not_logged_in:'AI 로그인이 필요해요',api_key_auth_detected:'구독 로그인이 아니라 막았어요',third_party_auth_detected:'구독 로그인이 아니라 막았어요',auth_unverified:'로그인 상태를 확인하지 못했어요'};
const oneLine=(t,max)=>{const s=String(t??'').replace(/\s+/g,' ').trim();return s.length>max?s.slice(0,max-1)+'…':s;};
const atMs=m=>{const t=Date.parse(m.at);return Number.isFinite(t)?t:undefined;};
export function workDetail(ctx,{label=id=>id,maxDone=5}={}){
  if(!ctx)return {active:0,blocked:0,waiting:0,items:[],decisions:[]};
  const msgs=ctx.store?.state?.messages??[];
  const byId=new Map(msgs.map(m=>[m.id,m]));
  const request=m=>{   // 이 답변이 답하는 사용자 요청 (팀원 작업·종합은 계획을 거쳐 올라간다)
    if(m.taskTitle)return m.taskTitle;
    let p=byId.get(m.replyTo);if(p&&p.role!=='user')p=byId.get(p.replyTo);
    return p?.role==='user'?p.text:'';
  };
  const title=m=>{const who=label(m.adapter),req=oneLine(request(m),110-who.length);return req?`${who} · ${req}`:`${who} 답변`;};
  const shown=m=>m.role==='assistant'&&m.kind!=='plan';   // 팀장 ① 계획은 작업이 아니라 내부 단계
  const round=currentRound(msgs);
  const active=msgs.filter(m=>m.role==='assistant'&&m.status==='running').map(m=>({title:title(m),state:'active',since:atMs(m)}));
  const blocked=round.filter(m=>m.status==='blocked').map(m=>({title:title(m),state:'blocked',reason:BLOCK_REASON[m.error]??'멈췄어요',since:atMs(m)}));
  const asks=round.filter(m=>m.status==='done'&&m.approvalRequested);
  const done=msgs.filter(m=>shown(m)&&m.status==='done'&&!m.approvalRequested).slice(-maxDone).reverse().map(m=>({title:title(m),state:'done',since:atMs(m)}));
  const decisions=asks.slice(0,10).map(m=>({id:`m${m.id}`,question:oneLine(`${label(m.adapter)}: ${String(m.text??'').replace(/^\s*\[승인 요청\]\s*/,'')}`,300),options:['허락','거절'],since:atMs(m)}));
  return {active:active.length,blocked:blocked.length,waiting:asks.length,items:[...active,...blocked,...done].slice(0,30),decisions};
}

export function buildReport({version,disk,errors,work}){
  const body={version:String(version??'unknown')};
  if(disk&&Number.isFinite(disk.total)&&disk.total>0){body.diskUsedBytes=Math.max(0,Math.round(disk.used??0));body.diskTotalBytes=Math.round(disk.total);}
  if(errors){body.errorCount=errors.count();const last=errors.lastAt();if(last)body.lastErrorAt=last;}
  if(work){
    body.work={active:work.active|0,blocked:work.blocked|0,waiting:work.waiting|0};
    if(Array.isArray(work.items))body.work.items=work.items;
    if(Array.isArray(work.decisions))body.work.decisions=work.decisions;
  }
  return body;
}

export async function sendReport({url,key,body,fetchImpl=globalThis.fetch,timeoutMs=15000}){
  const target=new URL('/api/floor/report',url);
  const res=await fetchImpl(target,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  if(!res.ok){let text='';try{text=(await res.text()).slice(0,120);}catch{}throw new Error(`HTTP ${res.status} ${text}`.trim());}
  return true;
}

// 시작하면 바로 한 번, 그 뒤 intervalSec 마다 보낸다. 반환값은 멈추는 함수.
// 실패는 상태가 바뀔 때만 로그에 남긴다 (연속 실패로 로그가 넘치지 않게).
export function startBuildingReporter({url,key,version,intervalSec=300,getDisk,getWork,errors,fetchImpl,log=console.log,setTimer=setInterval,clearTimer=clearInterval}){
  let okBefore=null;
  const tick=async()=>{
    let disk=null,work=null;
    try{disk=await getDisk?.();}catch{}
    try{work=getWork?.();}catch{}
    const body=buildReport({version,disk,errors,work});
    try{
      await sendReport({url,key,body,fetchImpl});
      if(okBefore!==true)log(`[빌딩] 보고 시작 (${new URL(url).host}, ${intervalSec}초마다)`);
      okBefore=true;
    }catch(e){
      if(okBefore!==false)log(`[빌딩] 보고 실패: ${e.message} — 다음 간격에 다시 시도`);
      okBefore=false;
    }
  };
  tick();
  const timer=setTimer(tick,intervalSec*1000);
  timer?.unref?.();
  return ()=>clearTimer(timer);
}
