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
const CLI_LOG_DIRS=['.codex/sessions','.codex/log','.claude/projects','.grok/logs','.grok/memtrace'];   // v0.10: Grok 로그(대화 세션 .grok/sessions 는 이어가기에 쓰여 지우지 않는다)
// v0.10.15 캐시: 다시 받을 수 있는 것(npm·pip·브라우저 캐시 등). 자동 정리 대상에 포함
const CACHE_DIRS=['.npm/_cacache','.npm/_logs','.cache','.codex/cache','.grok/cache','.local/share/pnpm','.pip','.bun/install/cache'];

export async function diskUsage(dir){
  const s=await statfs(dir);
  const total=s.blocks*s.bsize,free=s.bavail*s.bsize,used=Math.max(0,total-free);
  return {total,used,free,pct:total?Math.round(used/total*1000)/10:0};
}

async function sizeOf(p){
  let st;try{st=await stat(p);}catch{return {bytes:0,mtime:0};}
  if(!st.isDirectory())return {bytes:st.size,mtime:st.mtimeMs};
  let bytes=0,mtime=0;   // v0.10.16 폴더의 시각은 안에 든 파일들의 최신 수정 시각(폴더 자체 mtime 은 복사·생성 때 바뀌어 믿을 수 없다). 빈 폴더만 자기 mtime
  let names=[];try{names=await readdir(p);}catch{}
  for(const n of names){const r=await sizeOf(path.join(p,n));bytes+=r.bytes;if(r.mtime>mtime)mtime=r.mtime;}
  return {bytes,mtime:mtime||st.mtimeMs};
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
    for(const rel of CACHE_DIRS)await filesUnder(path.join(usersDir,u,'home',rel),items);
  }
  return items.sort((a,b)=>a.mtime-b.mtime);
}

// v0.10.15 무엇이 공간을 차지하는지: 사용자별 작업 폴더·홈 폴더(상위 폴더별)·실행 기록·state.json 크기 + 큰 파일/폴더 상위 목록.
// 큰 항목은 "지울 수 있는 단위" 로 보인다: node_modules·.git 같은 폴더는 통째로 한 항목, 그 밖은 파일 단위.
const UNIT_DIRS=new Set(['node_modules','.git','.venv','venv','__pycache__','.next','dist','build','.cache','_cacache']);
async function walkUnits(dir,rel,out,depth=0){
  let ents=[];try{ents=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const e of ents){
    const p=path.join(dir,e.name),r=rel?rel+'/'+e.name:e.name;
    if(e.isDirectory()){if(UNIT_DIRS.has(e.name)||depth>=6){const z=await sizeOf(p);out.push({path:r,bytes:z.bytes,mtime:z.mtime,dir:true});}else await walkUnits(p,r,out,depth+1);}
    else if(e.isFile()){try{const st=await stat(p);out.push({path:r,bytes:st.size,mtime:st.mtimeMs,dir:false});}catch{}}
  }
}
export async function breakdown(usersDir,{top=25}={}){
  const users=[];let names=[];try{names=await readdir(usersDir);}catch{return {users};}
  for(const u of names){
    const base=path.join(usersDir,u);let st;try{st=await stat(base);}catch{continue;}if(!st.isDirectory())continue;
    const ws=path.join(base,'workspace'),home=path.join(base,'home');
    const areas={workspace:(await sizeOf(ws)).bytes,shared:(await sizeOf(path.join(ws,'shared'))).bytes,runs:(await sizeOf(path.join(base,'runs'))).bytes,state:(await sizeOf(path.join(base,'state.json'))).bytes,home:{}};
    let hn=[];try{hn=await readdir(home);}catch{}
    for(const n of hn){const z=await sizeOf(path.join(home,n));if(z.bytes>0)areas.home[n]=z.bytes;}
    const units=[];await walkUnits(ws,'workspace',units);await walkUnits(home,'home',units);
    units.sort((a,b)=>b.bytes-a.bytes);
    users.push({user:u,areas,top:units.slice(0,top)});
  }
  return {users};
}
// v0.10.16 N일 지난 자료 지우기(사용자 요청): 작업 폴더의 파일·단위 폴더(node_modules 류)와 홈의 캐시류 중 수정 시각이 N일보다 오래된 것. memory.md·.git·로그인 정보·state.json·.grok/sessions 는 제외. dryRun 이면 목록만.
export async function purgeOld(usersDir,user,{days=2,dryRun=false,now=Date.now()}={}){
  if(!/^[\w.-]+$/.test(String(user)))return {error:'bad_path'};
  const base=path.join(usersDir,user);const cutoff=now-Math.max(0,Number(days)||0)*86400e3;
  const units=[];await walkUnits(path.join(base,'workspace'),'workspace',units);
  for(const h of ['.tmp','.npm','.cache','.local','.pip','.bun','Downloads'])await walkUnits(path.join(base,'home',h),'home/'+h,units);
  const victims=units.filter(u=>u.mtime<cutoff&&u.path!=='workspace/memory.md'&&!/(^|\/)\.git(\/|$)/.test(u.path));
  let deleted=0,bytes=0;const items=[];
  for(const v of victims.sort((a,b)=>b.bytes-a.bytes)){
    items.push({path:v.path,bytes:v.bytes,mtime:v.mtime,dir:!!v.dir});
    if(dryRun)continue;
    const r=await deletePath(usersDir,user,v.path);if(r.ok){deleted++;bytes+=r.bytes;}
  }
  return {dryRun,days,candidates:victims.length,candidateBytes:victims.reduce((a,v)=>a+v.bytes,0),deleted,bytes,items:items.slice(0,50)};
}
// v0.10.15 사용자가 고른 항목 지우기: 작업 폴더(memory.md 제외)·홈의 캐시·node_modules 류·tmp 만. 로그인 정보(.claude/.codex/.grok 의 인증 파일 등)·state.json 은 거부.
const DELETABLE_HOME=new Set(['.tmp','.npm','.cache','.local','.pip','.bun','.pnpm-store','.yarn','.gradle','.m2','.cargo','go','.rustup','.nvm','.config','.gemini','.playwright','.ms-playwright','Downloads','Desktop','Documents','tmp','.cursor','.vscode-server','.ollama']);
export async function deletePath(usersDir,user,rel){
  if(!/^[\w.-]+$/.test(String(user))||typeof rel!=='string'||!rel||rel.includes('\0'))return {error:'bad_path'};
  const base=path.join(usersDir,user);const parts=rel.split('/').filter(Boolean);if(parts.some(x=>x==='..'||x==='.'))return {error:'bad_path'};
  const top=parts[0];
  let ok=false;
  if(top==='workspace'&&parts.length>=2&&!(parts.length===2&&parts[1]==='memory.md'))ok=true;
  else if(top==='home'&&parts.length>=2){const h=parts[1];if(DELETABLE_HOME.has(h))ok=true;else if(['.claude','.codex','.grok'].includes(h)&&parts.length>=3&&!(h==='.grok'&&parts[2]==='sessions')&&(UNIT_DIRS.has(parts[parts.length-1])||/^(projects|sessions|log|logs|cache|memtrace|debug|telemetry|statsig|shell-snapshots|todos|downloads|plugins)$/.test(parts[2])))ok=true;}   // .grok/sessions 는 이어가기에 쓰여 보호
  if(!ok)return {error:'not_deletable'};
  const target=path.join(base,...parts);
  let real;try{const {realpath}=await import('node:fs/promises');real=await realpath(target);}catch{return {error:'not_found'};}
  const baseReal=await (await import('node:fs/promises')).realpath(base);
  if(!(real===baseReal||real.startsWith(baseReal+path.sep)))return {error:'bad_path'};
  const z=await sizeOf(real);
  try{await rm(real,{recursive:true,force:true});}catch(e){return {error:'delete_failed',detail:e.code};}
  return {ok:true,path:rel,bytes:z.bytes};
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
    async info(detail=false){let u=null;try{u=await diskUsage(usersDir);}catch{}const r={usage:u,highPct:o.highPct,lowPct:o.lowPct,maxAgeDays:o.maxAgeDays,protectHours:o.protectHours,last:state.last};if(detail){try{r.breakdown=await breakdown(usersDir);}catch(e){r.breakdown={error:e.code??e.message};}}return r;},
    deletePath:(user,rel)=>deletePath(usersDir,user,rel),
    purgeOld:(user,o)=>purgeOld(usersDir,user,o)
  };
}
