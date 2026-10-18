// v0.9.0 저장 공간 안전장치: 데이터 볼륨이 차기 전에 "다시 만들 수 있는 기록" 만 오래된 것부터 지운다.
//
// 지우는 것 (사용자 지시로 허락됨 — 2026-10-19):
//   - users/<id>/runs/<메시지ID>-<AI>/      허브의 실행 증거(stdout/stderr 원문). 답변 본문은 state.json 에 따로 있다.
//   - users/<id>/home/.codex/sessions/…    Codex CLI 의 대화 기록 파일
//   - users/<id>/home/.codex/log/…         Codex CLI 로그
//   - users/<id>/home/.claude/projects/…   Claude Code 의 대화 기록 파일
// 절대 지우지 않는 것: 작업 폴더(workspace — 사용자 파일·memory.md), state.json(대화), 로그인 정보(home 의 나머지 전부), 비밀번호 파일.
// 최근 protectHours 시간 안에 바뀐 것은 진행 중일 수 있어 건드리지 않는다.
//
// 규칙: ① maxAgeDays 보다 오래된 기록은 항상 지운다. ② 사용률이 highPct% 이상이면 lowPct% 아래로 내려갈 때까지 오래된 것부터 지운다.
import {statfs,readdir,stat,rm} from 'node:fs/promises';
import path from 'node:path';

export const JANITOR_DEFAULTS={highPct:70,lowPct:50,maxAgeDays:30,protectHours:6,intervalMinutes:10};
const CLI_LOG_DIRS=['.codex/sessions','.codex/log','.claude/projects'];

export async function diskUsage(dir){
  const s=await statfs(dir);
  const total=s.blocks*s.bsize,free=s.bavail*s.bsize,used=Math.max(0,total-free);
  return {total,used,free,pct:total?Math.round(used/total*1000)/10:0};
}

async function sizeOf(p){
  let st;try{st=await stat(p);}catch{return {bytes:0,mtime:0};}
  if(!st.isDirectory())return {bytes:st.size,mtime:st.mtimeMs};
  let bytes=0,mtime=st.mtimeMs;
  let names=[];try{names=await readdir(p);}catch{}
  for(const n of names){const r=await sizeOf(path.join(p,n));bytes+=r.bytes;if(r.mtime>mtime)mtime=r.mtime;}
  return {bytes,mtime};
}
async function filesUnder(dir,out=[]){
  let ents=[];try{ents=await readdir(dir,{withFileTypes:true});}catch{return out;}
  for(const e of ents){const p=path.join(dir,e.name);if(e.isDirectory())await filesUnder(p,out);else if(e.isFile()){try{const st=await stat(p);out.push({path:p,bytes:st.size,mtime:st.mtimeMs,kind:'cli-log'});}catch{}}}
  return out;
}

// 지울 수 있는 항목 목록 (오래된 것부터). 실행 증거는 폴더 단위, CLI 기록은 파일 단위.
export async function listCandidates(usersDir){
  const items=[];
  let users=[];try{users=await readdir(usersDir);}catch{return items;}
  for(const u of users){
    const runs=path.join(usersDir,u,'runs');
    let dirs=[];try{dirs=await readdir(runs);}catch{}
    for(const d of dirs){const p=path.join(runs,d);const r=await sizeOf(p);items.push({path:p,bytes:r.bytes,mtime:r.mtime,kind:'run'});}
    for(const rel of CLI_LOG_DIRS)await filesUnder(path.join(usersDir,u,'home',rel),items);
  }
  return items.sort((a,b)=>a.mtime-b.mtime);
}

// 한 번 정리. usage 함수는 테스트에서 바꿔 끼울 수 있다.
export async function sweep(usersDir,opts={},{usage=diskUsage,now=Date.now()}={}){
  const o={...JANITOR_DEFAULTS,...opts};
  const before=await usage(usersDir);
  const protectBefore=now-o.protectHours*3600e3,ageBefore=now-o.maxAgeDays*86400e3;
  const items=(await listCandidates(usersDir)).filter(i=>i.mtime<protectBefore);
  const targetUsed=before.total*o.lowPct/100;
  let used=before.used,deleted=0,freed=0;const reasons={age:0,pressure:0};
  const pressure=before.pct>=o.highPct;
  for(const i of items){
    const old=i.mtime<ageBefore;
    if(!old&&!(pressure&&used>targetUsed))continue;
    try{await rm(i.path,{recursive:true,force:true});}catch{continue;}
    deleted++;freed+=i.bytes;used-=i.bytes;reasons[old?'age':'pressure']++;
  }
  const after=await usage(usersDir);
  return {at:new Date(now).toISOString(),before:{pct:before.pct,used:before.used,total:before.total},after:{pct:after.pct,used:after.used,total:after.total},deleted,freedBytes:freed,reasons,pressure,stillHigh:after.pct>=o.highPct};
}

// 서버용: 시작 30초 뒤 한 번, 이후 intervalMinutes 마다. 동시에 두 번 돌지 않는다. maybe() 는 AI 실행이 끝날 때마다 불러 사용률이 높을 때만 바로 정리.
export function startJanitor(usersDir,opts={},log=console.log){
  const o={...JANITOR_DEFAULTS,...opts};
  const state={last:null,running:null,opts:o};
  const run=async(why)=>{
    if(state.running)return state.running;
    state.running=(async()=>{try{const r=await sweep(usersDir,o);state.last={...r,why};if(r.deleted)log(`저장 공간 정리(${why}): ${r.deleted}개 삭제, ${(r.freedBytes/1048576).toFixed(1)}MB 확보 · 사용률 ${r.before.pct}% → ${r.after.pct}%${r.stillHigh?' · 아직 높음(지울 수 있는 기록이 부족 — 작업 폴더 확인 필요)':''}`);return state.last;}
      catch(e){log('저장 공간 정리 실패: '+(e.code??e.message));return null;}finally{state.running=null;}})();
    return state.running;
  };
  const t1=setTimeout(()=>run('start'),30e3);t1.unref?.();
  const t2=setInterval(()=>run('interval'),o.intervalMinutes*60e3);t2.unref?.();
  return {
    state,run,
    async maybe(){try{const u=await diskUsage(usersDir);if(u.pct>=o.highPct)return run('pressure');}catch{}return null;},
    async info(){let u=null;try{u=await diskUsage(usersDir);}catch{}return {usage:u,highPct:o.highPct,lowPct:o.lowPct,maxAgeDays:o.maxAgeDays,protectHours:o.protectHours,last:state.last};}
  };
}
