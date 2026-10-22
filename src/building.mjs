// v0.10.18 AI 빌딩 보고: 버전·디스크·최근 오류 수·작업 수를 빌딩 서버(dkhello777-wq/ai-building)에 정해진 간격으로 보낸다.
// AI 는 쓰지 않는 일반 보고 프로그램이다. BUILDING_URL 과 BUILDING_REPORT_KEY 가 둘 다 있을 때만 켜지고,
// 보고에 실패해도 로그 한 줄로 끝난다 (사이트 동작에는 영향 없음). 보내는 칸은 정해진 숫자뿐 — 대화 본문·오류 원문·키는 보내지 않는다.

// 최근 N시간 안의 실행 오류 시각만 기억한다 (본문 없음).
export class ErrorWindow{
  constructor({windowMs=24*3600*1000,now=()=>Date.now()}={}){this.windowMs=windowMs;this.now=now;this.times=[];}
  trim(){const cut=this.now()-this.windowMs;while(this.times.length&&this.times[0]<cut)this.times.shift();}
  record(at=this.now()){this.times.push(at);if(this.times.length>5000)this.times.shift();}
  count(){this.trim();return this.times.length;}
  lastAt(){this.trim();return this.times.length?this.times.at(-1):null;}
}

// 사용자 컨텍스트에서 "지금 일하는 중·막힘·결정 대기" 수를 센다. 마지막 사용자 메시지 뒤의 답변만 본다 (= 지금 진행 중인 라운드).
export function workSummary(ctx){
  if(!ctx)return {active:0,blocked:0,waiting:0};
  const msgs=ctx.store?.state?.messages??[];
  let lastUser=-1;for(const m of msgs)if(m.role==='user'&&m.id>lastUser)lastUser=m.id;
  const round=msgs.filter(m=>m.role==='assistant'&&m.id>lastUser);
  return {
    active:(ctx.running?.size??0)+(ctx.queue?.length??0),
    blocked:round.filter(m=>m.status==='blocked').length,
    waiting:round.filter(m=>m.status==='done'&&m.approvalRequested).length,
  };
}

export function buildReport({version,disk,errors,work}){
  const body={version:String(version??'unknown')};
  if(disk&&Number.isFinite(disk.total)&&disk.total>0){body.diskUsedBytes=Math.max(0,Math.round(disk.used??0));body.diskTotalBytes=Math.round(disk.total);}
  if(errors){body.errorCount=errors.count();const last=errors.lastAt();if(last)body.lastErrorAt=last;}
  if(work)body.work={active:work.active|0,blocked:work.blocked|0,waiting:work.waiting|0};
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
