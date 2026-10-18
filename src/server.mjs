// AI Office 서버 (v0.7, 1인용): 브라우저(PC/폰) ⇄ 이 서버 ⇄ 각 AI CLI.
// 서버 주인 한 명(비밀번호 하나)이 쓴다. 작업 폴더는 data/users/1/ 하나:
//   home/       → CLI 의 HOME·설정 폴더(로그인 정보가 여기 저장됨: 사용자별 구독 분리)
//   workspace/  → 공유 파일(shared/) 과 CLI 의 작업 폴더, memory.md(사용자 메모리)
//   state.json  → 대화 기록·세션·월별 사용량 / runs/ → 실행 증거(0700/0600)
// v0.5 추가: 사용자 메모리(memory.md 주입·저장) · 월별 토큰 예산 · 오케스트레이터 모드(팀장 AI 가 분배→종합) · 부분 출력 스트리밍
import http from 'node:http';
import {readFile,writeFile,readdir,stat,mkdir,chmod,appendFile,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {loadConfig,runAdapter,checkAuth,startLogin,maskLine} from './adapters/index.mjs';
import {Store,sha256} from './store.mjs';
import {Owner,OWNER_ID,PASSWORD_MIN,validBudgetTokens,validPassword} from './owner.mjs';
import {randomBytes} from 'node:crypto';
import {extractPlan} from './orchestrate.mjs';

const root=new URL('../',import.meta.url);
const config=await loadConfig();
const dataDir=path.resolve(new URL('data/',root).pathname);
const usersDir=path.resolve(new URL((config.users?.dir??'data/users')+'/',root).pathname);
await mkdir(dataDir,{recursive:true,mode:0o700});await mkdir(usersDir,{recursive:true,mode:0o700});
for(const d of [dataDir,usersDir]){try{await chmod(d,0o700);}catch{}}
const adapters=config.adapters.filter(a=>a.enabled);
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.pdf':'application/pdf','.webmanifest':'application/manifest+json'};
const BUDGET_DEFAULT=(()=>{const raw=process.env.HUB_MONTHLY_TOKENS??config.budget?.monthlyTokens??0;const n=Number(raw);if(!validBudgetTokens(n)){console.error(`월 토큰 상한 값이 잘못됨 (${raw}): 0 이상의 정수만`);process.exit(2);}return n;})();   // 0 = 무제한. 검수 V16: 로드·API 와 같은 검사
const JSON_BODY_MAX=64*1024;   // 검수 V06: JSON 요청 본문 상한(바이트). 파일 업로드는 limits.uploadBytes.
const MEMORY_MAX=Number(config.memory?.maxChars??20000);              // 프롬프트에 주입하는 메모리 상한(초과분은 앞부분을 잘라 넣지 않고, 화면에 경고)
const ORCH=config.orchestrate??{};
const ORCH_MAX_TASKS=Number(ORCH.maxTasks??6);
const LIMITS={uploadBytes:Number(config.limits?.uploadBytes??50*1024*1024),textChars:Number(config.limits?.textChars??200000),concurrentPerUser:Number(config.limits?.concurrentPerUser??4)};   // GPT R10·자원 한도
// 브라우저가 실행할 수 있는 파일 형식은 /files/ 에서 다운로드로만 (GPT R11: 허브 출처에서 스크립트가 돌면 세션 쿠키로 API 호출 가능)
const DOWNLOAD_ONLY=new Set(['.html','.htm','.xhtml','.svg','.xml','.js','.mjs','.css','.webmanifest']);

// ---- 계정: 주인 한 명. 비밀번호가 아직 없으면 화면의 "비밀번호 설정" 또는 환경변수 HUB_PASSWORD 로 정한다. ----
const owner=new Owner(dataDir);
try{await owner.load();}
catch(e){console.error(`계정 파일을 읽을 수 없어 시작하지 않습니다 (${e.message}): ${e.file}\n  → 파일이 손상됐으면 백업에서 복구하거나, 정말 처음부터 시작하려면 data/ 폴더를 옮긴 뒤 다시 실행하세요. 빈 상태로 덮어쓰지 않습니다.`);process.exit(2);}
if(!owner.isSet&&process.env.HUB_PASSWORD){const r=await owner.setup({password:process.env.HUB_PASSWORD});if(r.error){console.error(`HUB_PASSWORD 가 잘못돼 시작하지 않습니다: ${r.error} (${PASSWORD_MIN}자 이상). 검수 V04: 잘못된 값으로 무인증 상태로 열지 않는다.`);process.exit(2);}console.log('HUB_PASSWORD 로 주인 비밀번호를 설정했습니다.');}
// 검수 V04: 비밀번호가 아직 없으면 1회용 설정 코드를 콘솔과 data/setup-code(0600) 에 남기고, /api/setup 은 그 코드가 있어야 받는다.
// 공개 주소에 올린 뒤 먼저 접속한 사람이 주인이 되는 일을 막는다. 설정이 끝나면 파일을 지운다.
let setupCode=null;
if(!owner.isSet){setupCode=randomBytes(9).toString('base64url');const f=path.join(dataDir,'setup-code');await writeFile(f,setupCode+'\n',{mode:0o600});try{await chmod(f,0o600);}catch{}}
async function consumeSetupCode(){setupCode=null;try{await unlink(path.join(dataDir,'setup-code'));}catch{}}
// 호환용 별칭: 아래 코드는 accounts.userById / publicUser 만 쓴다
const accounts={userById:id=>owner.userById(id),publicUser:u=>owner.publicUser(u)};

import {timingSafeEqual} from 'node:crypto';
const require_same=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
const cookies=req=>Object.fromEntries((req.headers.cookie??'').split(';').map(s=>s.trim().split('=')).filter(([k])=>k));
const currentUser=req=>owner.userForToken(cookies(req).hub);
// 검수 V04·V05: 프록시 헤더(x-forwarded-proto / x-forwarded-for)는 HUB_TRUST_PROXY=1 일 때만 믿는다 (Docker 기본값 1 — 플랫폼 프록시 뒤). 아니면 소켓 값만.
// 재검수 V24: 프록시 신뢰는 (1) HUB_TRUST_PROXY=1 이고 (2) 소켓 상대가 HUB_TRUSTED_PROXIES(콤마, IP 또는 CIDR; 비우면 모든 peer) 안에 있을 때만.
// x-forwarded-for 는 오른쪽에서 왼쪽으로 읽어 신뢰 프록시가 아닌 첫 값을 쓴다 — 클라이언트가 앞에 붙인 값은 무시된다. IP 형식이 아니면 소켓 주소로 대체.
import net from 'node:net';
import {buildTrusted} from './trusted.mjs';
const TRUST_PROXY=process.env.HUB_TRUST_PROXY==='1';
// 재검수 V26·V27: 신뢰 목록은 Node 내장 net.BlockList 로 판정(IPv4-mapped IPv6, 압축 표기, embedded IPv4 모두 내장 처리).
// "미설정"(모든 peer 신뢰)과 "설정했지만 잘못됨"을 분리한다: 항목 하나라도 틀리면 시작 거부 — 오타가 전체 신뢰로 바뀌지 않게.
let TRUSTED;try{TRUSTED=buildTrusted(process.env.HUB_TRUSTED_PROXIES);}catch(e){console.error(`HUB_TRUSTED_PROXIES 항목이 잘못돼 시작하지 않습니다: "${e.entry}" (${e.why}). IP 또는 IP/prefix 를 콤마로.`);process.exit(2);}
const TRUST_ALL_PEERS=TRUSTED.trustAll;
const isTrustedPeer=ip=>TRUSTED.check(ip);
const viaTrustedProxy=req=>TRUST_PROXY&&isTrustedPeer(String(req.socket.remoteAddress??''));
const isSecure=req=>viaTrustedProxy(req)&&req.headers['x-forwarded-proto']==='https';
function clientIp(req){
  const peer=String(req.socket.remoteAddress??'');
  if(!viaTrustedProxy(req))return peer;
  const hops=String(req.headers['x-forwarded-for']??'').split(',').map(s=>s.trim()).filter(Boolean);
  for(let i=hops.length-1;i>=0;i--){const h=hops[i];if(!net.isIP(h))return peer;if(!TRUST_ALL_PEERS&&isTrustedPeer(h))continue;return h;}
  return peer;
}
const allowedHosts=new Set([...(config.allowedHosts??[]),...(process.env.HUB_ALLOWED_HOSTS?process.env.HUB_ALLOWED_HOSTS.split(','):[])].map(s=>s.trim()).filter(Boolean));
// 변경 요청(POST)은 Host 허용 목록 + Origin 일치 + JSON 형식까지 확인한 뒤에만 처리한다.
// 클라우드 배포(HUB_ALLOWED_HOSTS=*)에서는 Host 목록 검사를 끄고 Origin 일치(CSRF 방어)만 본다 — 도메인이 플랫폼이 정해 주는 값이라 미리 알 수 없기 때문.
const ANY_HOST=allowedHosts.has('*');
function mutationGate(req,expectJson=true){
  const host=req.headers.host??'';
  if(!ANY_HOST&&allowedHosts.size&&!allowedHosts.has(host))return {error:'host_not_allowed',status:403};
  const origin=req.headers.origin;
  const scheme=isSecure(req)?'https':'http';
  if(!origin||origin!==`${scheme}://${host}`)return {error:'origin_not_allowed',status:403};
  if(expectJson&&!(req.headers['content-type']??'').startsWith('application/json'))return {error:'json_required',status:415};
  return null;
}
const setSessionCookie=(req,res,token)=>res.setHeader('Set-Cookie',`hub=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30*24*3600}${isSecure(req)?'; Secure':''}`);
const clearSessionCookie=(req,res)=>res.setHeader('Set-Cookie',`hub=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure(req)?'; Secure':''}`);

// ---- 사용자별 컨텍스트: 폴더·대화 저장소·인증 상태·SSE 클라이언트·진행 중인 CLI 로그인 ----
// 초기화 중인 Promise 를 캐시해 같은 사용자의 동시 첫 요청이 컨텍스트를 두 번 만들지 않게 한다 (검수 FAIL 7).
const contexts=new Map();
const contextPromises=new Map();
async function mkPrivate(d){await mkdir(d,{recursive:true,mode:0o700});try{await chmod(d,0o700);}catch{}}
async function userContext(user){
  let ctx=contexts.get(user.id);if(ctx){ctx.user=user;return ctx;}
  let p=contextPromises.get(user.id);if(p)return p;
  p=(async()=>{
    const dir=path.join(usersDir,String(user.id));
    const home=path.join(dir,'home'),workspace=path.join(dir,'workspace'),shared=path.join(workspace,'shared'),runs=path.join(dir,'runs');
    const tmpDir=path.join(home,'.tmp');
    for(const d of [dir,home,tmpDir,workspace,shared,runs])await mkPrivate(d);
    // 어댑터별 설정 폴더({home}/.claude, {home}/.codex …)를 미리 만든다 — Codex 는 CODEX_HOME 이 없으면 상태 명령부터 실패한다 (Linux 검증)
    for(const a of adapters)for(const v of Object.values(a.perUserEnv??{})){const p=String(v).replace(/\{home\}/g,()=>home);if(p.startsWith(home+path.sep))await mkPrivate(p);}
    const store=new Store(new URL('file://'+path.join(dir,'state.json')));
    await store.load();   // 손상이면 던진다 → 이 사용자 요청은 500, 다른 사용자는 영향 없음 (GPT R05)
    // 검수 V14: 이전 프로세스가 남긴 running 메시지는 되살릴 수 없다 → interrupted 로 닫는다 (자동 재실행은 중복을 만드므로 하지 않음)
    const stale=store.state.messages.filter(m=>m.role==='assistant'&&m.status==='running');
    if(stale.length){for(const m of stale)store.update(m.id,{status:'error',error:'interrupted',interruptedAt:new Date().toISOString()});await store.save();}
    await ensureGitRepo(workspace);
    const c={user,dir,home,tmpDir,workspace,shared,runs,memoryFile:path.join(workspace,'memory.md'),store,authState:{},clients:new Set(),logins:{},running:new Set(),active:0,queue:[]};
    contexts.set(user.id,c);contextPromises.delete(user.id);
    refreshAuth(c).catch(e=>console.error('auth refresh',e));   // 검수 V15: 재시작 뒤에도 남아 있는 CLI 로그인을 바로 반영 (비동기)
    return c;
  })();
  contextPromises.set(user.id,p);
  try{return await p;}catch(e){contextPromises.delete(user.id);throw e;}
}
// Codex 비대화형 실행은 작업 폴더가 git 저장소이길 요구한다(GPT 배포 점검). git 이 있으면 사용자 workspace 를 한 번 init 한다. 없으면 건너뛰고 기록만.
function ensureGitRepo(workspace){
  return new Promise(resolve=>{
    stat(path.join(workspace,'.git')).then(()=>resolve(true),()=>{
      execFile('git',['init','-q'],{cwd:workspace,env:{PATH:process.env.PATH,HOME:workspace}},err=>{if(err)console.warn('git init 생략:',err.code??err.message);resolve(!err);});
    });
  });
}
// 자식 CLI 에 넘기는 사용자별 환경: HOME·XDG·임시 폴더·Windows 설정 폴더를 사용자 home 아래로 (검수 FAIL 9-3), 어댑터별 perUserEnv({home} 치환)를 추가.
function userEnv(ctx,adapter){
  const env={HOME:ctx.home,USERPROFILE:ctx.home,APPDATA:path.join(ctx.home,'AppData/Roaming'),LOCALAPPDATA:path.join(ctx.home,'AppData/Local'),TMPDIR:ctx.tmpDir,TMP:ctx.tmpDir,TEMP:ctx.tmpDir,XDG_CONFIG_HOME:path.join(ctx.home,'.config'),XDG_DATA_HOME:path.join(ctx.home,'.local/share'),XDG_CACHE_HOME:path.join(ctx.home,'.cache')};
  for(const [k,v] of Object.entries(adapter.perUserEnv??{}))env[k]=String(v).replace(/\{home\}/g,()=>ctx.home);
  return env;
}
function emit(ctx,type,data){const line=`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of ctx.clients)res.write(line);}
// 사용자의 열린 SSE 와 진행 중 CLI 로그인을 닫는다 (계정 중지·로그아웃 시, 검수 FAIL 7). tokenHash 를 주면 그 세션의 SSE 만.
function closeUserStreams(userId,tokenHash=null,{cancelRuns=false}={}){
  const tctx=contexts.get(userId);if(!tctx)return;
  for(const c of [...tctx.clients]){if(tokenHash&&c.hubTokenHash!==tokenHash)continue;try{c.end();}catch{}tctx.clients.delete(c);}
  if(!tokenHash&&cancelRuns){
    for(const l of Object.values(tctx.logins))if(l?.status==='running'&&l.handle)l.handle.cancel();
    for(const ac of tctx.running)ac.abort();   // 진행 중인 모델 실행(인증 확인 단계 포함)도 끊는다 (GPT R08/F03)
    for(const w of tctx.queue.splice(0))w.reject(Object.assign(new Error('cancelled'),{cancelled:true}));   // 대기 중이던 요청은 취소로 끝낸다 (GPT F04)
  }
}
const isDisabled=ctx=>false;   // 1인용: 계정 중지 개념 없음 (서버 종료가 곧 중지)
// 사용자별 동시 실행 상한 (GPT R10). 상한을 넘는 호출은 순서대로 기다린다.
function acquireSlot(ctx){
  if(ctx.active<LIMITS.concurrentPerUser){ctx.active++;return Promise.resolve();}
  return new Promise((resolve,reject)=>ctx.queue.push({resolve:()=>{ctx.active++;resolve();},reject}));
}
function releaseSlot(ctx){ctx.active--;const next=ctx.queue.shift();if(next)next.resolve();}

const json=(res,v,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(v));};
// 검수 V06: 청크마다 누적 바이트를 보고 상한을 넘으면 즉시 끊는다 (Content-Length 가 없거나 거짓이어도).
async function bodyBytes(req,max){
  if(Number(req.headers['content-length']??0)>max)throw Object.assign(new Error('body_too_large'),{max});
  const chunks=[];let n=0;
  for await(const c of req){n+=c.length;if(n>max){req.destroy();throw Object.assign(new Error('body_too_large'),{max});}chunks.push(c);}
  return Buffer.concat(chunks);
}
async function bodyJson(req){try{return JSON.parse((await bodyBytes(req,JSON_BODY_MAX)).toString('utf8'));}catch(e){if(e.message==='body_too_large')throw e;return undefined;}}
// 파일 이름: 경로 구분자 치환 + '.'/'..' 같은 점만 있는 이름 금지 (검수 FAIL 9-1)
const safeName=n=>String(n??'').replace(/[\\/]/g,'_').replace(/[^\w.\-가-힣 ()\[\]]/g,'_').replace(/^\.+$/,'').slice(0,200)||'file';

async function listFiles(ctx){
  const names=await readdir(ctx.shared);const out=[];
  for(const n of names.sort()){const s=await stat(path.join(ctx.shared,n));if(s.isFile())out.push({name:n,bytes:s.size,at:s.mtime.toISOString()});}
  return out;
}
// ---- v0.5 사용자 메모리: workspace/memory.md (0600). 프롬프트 앞에 주입되고, CLI 도 작업 폴더에서 직접 읽을 수 있다. ----
async function readMemory(ctx){try{return await readFile(ctx.memoryFile,'utf8');}catch{return '';}}
// 쓰기·추가는 사용자별로 직렬화 (Gemini FAIL5)
function queueMemory(ctx,fn){ctx._memChain=(ctx._memChain??Promise.resolve()).then(fn,fn);return ctx._memChain;}
function writeMemory(ctx,text){return queueMemory(ctx,async()=>{await writeFile(ctx.memoryFile,String(text??''),{encoding:'utf8',mode:0o600});try{await chmod(ctx.memoryFile,0o600);}catch{}});}
function appendMemory(ctx,entry){return queueMemory(ctx,async()=>{await appendFile(ctx.memoryFile,entry,{encoding:'utf8',mode:0o600});try{await chmod(ctx.memoryFile,0o600);}catch{}});}
const memoryPublic=text=>({chars:text.length,overLimit:text.length>MEMORY_MAX,maxChars:MEMORY_MAX});

// ---- v0.5 토큰 예산: 사용자별 월 상한(관리자 설정, 없으면 config 기본값). 0 = 무제한 ----
function budgetFor(ctx){
  const limit=Number(owner.user.budget?.monthlyTokens??BUDGET_DEFAULT)||0;
  const u=ctx.store.usageFor();
  return {month:u.month,tokens:u.tokens,calls:u.total.calls,byAdapter:u.byAdapter,limit,exceeded:limit>0&&u.tokens>=limit};
}

const loginPublic=l=>l?{status:l.status,urls:l.urls??[],codes:l.codes??[],lastLine:l.lastLine??'',error:l.error??null,startedAt:l.startedAt,endedAt:l.endedAt??null,tail:l.tail??null,exitCode:l.exitCode??null}:null;
async function statePayload(ctx){
  const memory=await readMemory(ctx);
  return {user:accounts.publicUser(ctx.user),lead:owner.user.lead,adapters:adapters.map(a=>({id:a.id,label:a.label,color:a.color,roleHint:a.roleHint??'',session:ctx.store.session(a.id),auth:ctx.authState[a.id]??null,canLogin:!!(a.login&&Array.isArray(a.login.args)),login:loginPublic(ctx.logins[a.id]),stream:!!a.stream})),messages:ctx.store.state.messages,workspace:ctx.workspace,evidenceRoot:ctx.runs,budget:budgetFor(ctx),memory:memoryPublic(memory),orchestrate:{maxTasks:ORCH_MAX_TASKS},limits:LIMITS};
}
// 프롬프트 합성: (메모리) + (다른 AI 답변 전문) + 본문 + 첨부 안내. 원문을 요약하거나 자르지 않는다.
function composePrompt({text,files=[],handoff=null,memory=''}){
  let p='';
  if(memory&&memory.trim())p+=`[내 메모리 — 이전 대화에서 저장해 둔 맥락·결정·취향입니다. 작업 폴더의 memory.md 와 같습니다. 참고만 하고, 사용자 요청이 우선입니다.]\n${memory.trim()}\n\n`;
  if(handoff)p+=`[다른 AI(${handoff.fromLabel})의 답변 전문입니다. 그대로 검토·참고하세요.]\n${handoff.text}\n\n[사용자 요청]\n`;
  p+=text;
  if(files.length)p+=`\n\n[첨부 파일 — 현재 작업 폴더의 shared/ 안에 있습니다. 직접 읽어서 참고하세요]\n`+files.map(f=>`- shared/${f}`).join('\n');
  return p;
}

// ---- 인증 종류 확인(사용자별). 호출 직전마다 그 사용자의 HOME 으로 상태 명령을 실행해 판정. 노출 필드는 허용 목록만. ----
const AUTH_FIELDS=['state','reason','authMethod','apiProvider','subscriptionType','exitCode','at'];
const publicAuth=r=>Object.fromEntries(AUTH_FIELDS.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
async function ensureAuth(ctx,adapter,signal=null){
  const cached=ctx.authState[adapter.id],ttl=config.authCacheMs??0;
  if(ttl>0&&cached&&cached.state==='subscription'&&Date.now()-Date.parse(cached.at)<ttl)return cached;
  const r=await checkAuth(adapter,process.env,userEnv(ctx,adapter),signal,ctx.workspace);   // 검수 V09: 실행과 같은 cwd 에서 판정
  ctx.authState[adapter.id]=publicAuth({...r,at:new Date().toISOString()});
  return ctx.authState[adapter.id];
}
async function refreshAuth(ctx){if(ctx._refreshing)return ctx._refreshing;ctx._refreshing=(async()=>{for(const a of adapters){const r=await checkAuth(a,process.env,userEnv(ctx,a),null,ctx.workspace);ctx.authState[a.id]=publicAuth({...r,at:new Date().toISOString()});}emit(ctx,'state',await statePayload(ctx));})();try{await ctx._refreshing;}finally{ctx._refreshing=null;}}

// 검수 V13: 완료 상태는 저장이 끝난 뒤에만 화면에 알린다. 저장이 실패하면 메모리 상태도 성공으로 두지 않고 persist_failed 오류로 바꾼다.
async function persistThenEmit(ctx,id){
  const {store}=ctx;
  try{await store.save();}
  catch(e){console.error('state save failed',e.code??e.message);const m=store.get(id);if(m&&m.status==='done')store.update(id,{status:'error',error:'persist_failed',persistError:e.code??'save_failed',unstoredAnswer:true});}
  emit(ctx,'message',store.get(id));
}
// 검수 V18: 같은 AI 의 일반 대화(세션 이어가기)는 직렬로. 두 프로세스가 같은 세션을 동시에 resume 하거나 세션 하나가 버려지는 일을 막는다.
function serialOn(ctx,adapterId,fn){const q=ctx.chains??(ctx.chains=new Map());const next=(q.get(adapterId)??Promise.resolve()).then(fn,fn);q.set(adapterId,next.catch(()=>{}));return next;}
// ---- 한 AI 호출 한 번 = 답변 메시지 하나. 인증·예산 게이트 → 실행(부분 출력 스트리밍) → 증거·사용량 기록. ----
// 반환: 저장된 답변 메시지(status done/blocked/error). 예외를 던지지 않는다.
async function runOne(ctx,adapter,{prompt,replyTo,kind='answer',extra={},useSession=true}){
  const {store}=ctx;
  const reply=store.add({role:'assistant',adapter:adapter.id,replyTo,kind,status:'running',text:'',...extra});
  emit(ctx,'message',reply);
  const evidenceDir=path.join(ctx.runs,`${reply.id}-${adapter.id}`);
  const ac=new AbortController();let slot=false;
  ctx.running.add(ac);   // 큐 대기·인증 확인·실행을 하나의 취소 수명으로 (GPT F03): 중지되면 어느 단계든 abort 된다
  try{
    await acquireSlot(ctx);slot=true;
    if(isDisabled(ctx)||ac.signal.aborted){   // 단계마다 다시 본다: 오케스트레이터 중간에 중지돼도 다음 CLI 를 띄우지 않는다 (GPT R08 / Gemini FAIL4)
      store.update(reply.id,{status:'blocked',error:'user_disabled'});
      await persistThenEmit(ctx,reply.id);return store.get(reply.id);
    }
    const auth=await ensureAuth(ctx,adapter,ac.signal);
    if(isDisabled(ctx)||ac.signal.aborted){   // 인증 확인(비동기) 도중 중지됨 → 모델을 띄우지 않는다 (GPT F03)
      store.update(reply.id,{status:'cancelled',error:'cancelled'});
      await persistThenEmit(ctx,reply.id);return store.get(reply.id);
    }
    if(auth.state!=='subscription'){
      const code={api_key:'api_key_auth_detected',third_party:'third_party_auth_detected',not_logged_in:'not_logged_in'}[auth.state]??'auth_unverified';
      store.update(reply.id,{status:'blocked',error:code,authCheck:publicAuth(auth)});
      await persistThenEmit(ctx,reply.id);return store.get(reply.id);
    }
    const b=budgetFor(ctx);
    if(b.exceeded){
      store.update(reply.id,{status:'blocked',error:'budget_exceeded',budget:{month:b.month,tokens:b.tokens,limit:b.limit}});
      await persistThenEmit(ctx,reply.id);return store.get(reply.id);
    }
    const session=useSession?store.session(adapter.id):null,epoch=store.epoch(adapter.id);   // 세대 기록 (GPT R09). 병렬 작업(task)은 세션을 쓰지도 남기지도 않는다 (검수 V18)
    let lastEmit=0;
    const onChunk=(_s,info)=>{   // 스트리밍: 150ms 에 한 번만 화면으로. 저장·증거에는 쓰지 않는다.
      const now=Date.now();if(now-lastEmit<150)return;lastEmit=now;
      emit(ctx,'partial',{id:reply.id,adapter:adapter.id,partial:info.partial,bytes:info.bytes,elapsedMs:info.elapsedMs});
    };
    const r=await runAdapter(adapter,{prompt,cwd:ctx.workspace,session,timeoutMs:config.timeoutMs,evidenceDir,extraEnv:userEnv(ctx,adapter),onChunk,signal:ac.signal});
    if(useSession)store.setSession(adapter.id,r.session,epoch);   // "새 대화" 이후에 끝난 실행은 옛 세션을 되살리지 않는다
    const used=store.addUsage(adapter.id,r.usage);
    store.update(reply.id,{status:'done',text:r.text,usage:r.usage,elapsedMs:r.elapsedMs,session:r.session??session,hash:sha256(r.text),exitCode:r.exitCode,evidence:r.evidence,envBlockedNames:r.envBlockedNames,authCheck:publicAuth(auth),usageMonth:{...used}});
  }catch(e){
    const evidenceFailed=/^evidence_/.test(e.message);
    const stderrTail=typeof e.stderr==='string'&&e.stderr.trim()?e.stderr.trim().split('\n').slice(-8).map(l=>maskLine(l.slice(0,300))).join('\n').slice(-1200):null;   // v0.8.1: 실패 원인을 화면에서 볼 수 있게 stderr 꼬리(가림 처리)를 함께 둔다 — 원문은 증거 파일에
    store.update(reply.id,{status:e.cancelled?'cancelled':'error',error:e.message,stderrTail,exitCode:e.exitCode??null,signal:e.signal??null,timedOut:!!e.timedOut,parseFailed:!!e.parseFailed,elapsedMs:e.elapsedMs??null,evidence:e.evidence??null,evidencePreserved:!!e.evidence&&!evidenceFailed,envBlockedNames:e.envBlockedNames??null,...(evidenceFailed&&typeof e.text==='string'?{text:e.text,hash:sha256(e.text),unstoredAnswer:true}:{})});
  }
  finally{ctx.running.delete(ac);if(slot)releaseSlot(ctx);}
  await persistThenEmit(ctx,reply.id);   // 검수 V13: 디스크에 남은 뒤에만 완료를 알린다
  emit(ctx,'budget',budgetFor(ctx));
  return store.get(reply.id);
}

async function dispatch(ctx,{text,targets,files,handoff}){
  const {store}=ctx;
  const userMsg=store.add({role:'user',text,files,targets,handoffFrom:handoff?.messageId??null});
  emit(ctx,'message',userMsg);await store.save();
  const prompt=composePrompt({text,files,handoff,memory:await readMemory(ctx)});
  const work=Promise.all(targets.map(id=>{const adapter=adapters.find(a=>a.id===id);if(!adapter)return;return serialOn(ctx,adapter.id,()=>runOne(ctx,adapter,{prompt,replyTo:userMsg.id}));}));
  work.catch(e=>console.error('dispatch',e));
  return userMsg;
}

// ---- v0.5 오케스트레이터: 팀장 AI 에게 목표를 주면 ① 계획(JSON) → ② 서버가 워커 AI 들에 분배(병렬) → ③ 팀장이 종합. ----
// 세 단계 모두 일반 호출과 같은 인증·예산·증거 규칙을 탄다. 계획 JSON 은 팀장 답변 본문에서 뽑고, 못 뽑으면 plan_parse_failed 로 끝낸다.
function planPrompt({goal,files,lead,workers,memory}){
  const roster=workers.map(w=>`- "${w.id}": ${w.label}${w.roleHint?' — '+w.roleHint:''}`).join('\n');
  const body=`### HUB:PLAN\n당신은 이 AI 오피스의 팀장(오케스트레이터)입니다. 아래 목표를 읽고, 팀원 AI 에게 나눠 줄 작업을 계획하세요.\n\n[팀원 — worker 값으로 정확히 이 id 를 쓰세요]\n${roster}\n\n[규칙]\n- 작업은 최대 ${ORCH_MAX_TASKS}개. 서로 독립적으로 수행 가능해야 합니다(병렬 실행).\n- 각 작업의 prompt 는 그 팀원이 아무 맥락 없이 읽어도 수행할 수 있게 완결된 지시문으로 쓰세요. 목표의 필요한 부분을 그대로 포함하세요.\n- 팀원에게 맡길 필요 없이 바로 답할 수 있으면 tasks 를 빈 배열로 두고 answer 에 최종 답을 쓰세요.\n- 답변은 아래 JSON 하나만, 다른 설명 없이:\n{"tasks":[{"worker":"<id>","title":"<짧은 제목>","prompt":"<완결된 지시문>"}],"note":"<계획 의도 한 줄>","answer":null}\n\n[목표]\n${goal}`;
  return composePrompt({text:body,files,memory});
}
function synthPrompt({goal,results}){
  const parts=results.map((r,i)=>`--- 작업 ${i+1}: ${r.title||'(제목 없음)'} · 담당 ${r.label} · 상태 ${r.status}${r.error?' ('+r.error+')':''} ---\n${r.text||'(결과 없음)'}`).join('\n\n');
  return `### HUB:SYNTHESIZE\n당신은 팀장입니다. 아래는 당신이 계획해 팀원들이 수행한 작업 결과 전문입니다. 결과를 검토·종합해 목표에 대한 최종 답변을 작성하세요. 결과끼리 모순되면 지적하고, 실패한 작업은 무엇이 빠졌는지 밝히세요.\n\n[목표]\n${goal}\n\n[팀원 결과]\n${parts}`;
}
async function orchestrate(ctx,{text,files,leadId,workerIds}){
  const {store}=ctx;
  const lead=adapters.find(a=>a.id===leadId);
  const workers=workerIds.map(id=>adapters.find(a=>a.id===id)).filter(a=>a&&a.id!==leadId);
  const userMsg=store.add({role:'user',text,files,targets:[leadId],mode:'orchestrate',lead:leadId,workers:workers.map(w=>w.id)});
  emit(ctx,'message',userMsg);await store.save();
  const run=(async()=>{
    const memory=await readMemory(ctx);
    // ① 계획
    const plan=await serialOn(ctx,lead.id,()=>runOne(ctx,lead,{prompt:planPrompt({goal:text,files,lead,workers,memory}),replyTo:userMsg.id,kind:'plan'}));
    if(plan.status!=='done')return;
    if(isDisabled(ctx)){store.update(plan.id,{orchestrateError:'user_disabled'});emit(ctx,'message',store.get(plan.id));await store.save();return;}   // 계획 뒤 중지됨 → 팀원 단계 자체를 만들지 않는다 (GPT R08)
    const parsed=extractPlan(plan.text,workers.map(w=>w.id),ORCH_MAX_TASKS);
    if(!parsed){store.update(plan.id,{status:'error',error:'plan_parse_failed',text:plan.text});emit(ctx,'message',store.get(plan.id));await store.save();return;}
    store.update(plan.id,{plan:{tasks:parsed.tasks.map(t=>({worker:t.worker,title:t.title})),note:parsed.note,dropped:parsed.dropped,requested:parsed.requested}});emit(ctx,'message',store.get(plan.id));await store.save();
    if(!parsed.tasks.length){   // 팀장이 직접 답함
      const final=store.add({role:'assistant',adapter:lead.id,replyTo:userMsg.id,kind:'final',status:'done',text:parsed.answer??plan.text,elapsedMs:0,derivedFrom:plan.id});
      emit(ctx,'message',final);await store.save();return;
    }
    // ② 분배 (병렬, 사용자 동시 실행 상한 안에서). 각 작업 프롬프트에는 메모리를 다시 넣지 않되 첨부 파일 목록은 넣는다 (Gemini FAIL1-4).
    const fileNote=files.length?`\n\n[첨부 파일 — 현재 작업 폴더의 shared/ 안에 있습니다. 직접 읽어서 참고하세요]\n`+files.map(f=>`- shared/${f}`).join('\n'):'';
    const results=await Promise.all(parsed.tasks.map(async(t,i)=>{
      const w=workers.find(x=>x.id===t.worker);
      const r=await runOne(ctx,w,{prompt:`### HUB:TASK ${i+1}/${parsed.tasks.length} — ${t.title}\n${t.prompt}${fileNote}`,replyTo:plan.id,kind:'task',extra:{taskTitle:t.title,taskIndex:i+1},useSession:false});
      return {title:t.title,label:w.label,status:r.status,error:r.error??null,text:r.text??''};
    }));
    // ③ 종합 — 성공한 작업이 하나도 없으면 팀장을 다시 부르지 않는다 (Gemini FAIL4-2). 중지됐으면 runOne 이 막는다.
    if(isDisabled(ctx)){store.update(plan.id,{orchestrateError:'user_disabled'});emit(ctx,'message',store.get(plan.id));await store.save();return;}
    if(results.every(r=>r.status!=='done')){store.update(plan.id,{orchestrateError:'all_tasks_failed'});emit(ctx,'message',store.get(plan.id));await store.save();return;}
    await serialOn(ctx,lead.id,()=>runOne(ctx,lead,{prompt:synthPrompt({goal:text,results}),replyTo:userMsg.id,kind:'final',extra:{derivedFrom:plan.id}}));
  })();
  run.catch(e=>console.error('orchestrate',e));
  return userMsg;
}

// ---- 화면 안 CLI 로그인: 사용자별 HOME 으로 공식 로그인 명령 실행. URL·코드(·가린 마지막 줄)만 화면에, 원문은 사용자 runs/ 에 0600. ----
function beginLogin(ctx,adapter){
  const cur=ctx.logins[adapter.id];
  if(cur&&cur.status==='running')return {error:'login_already_running'};
  const startedAt=new Date().toISOString();
  const state={status:'running',urls:[],codes:[],lastLine:'',error:null,startedAt,handle:null};
  ctx.logins[adapter.id]=state;
  const evidenceDir=path.join(ctx.runs,`login-${adapter.id}-${Date.now()}`);
  const handle=startLogin(adapter,{cwd:ctx.workspace,extraEnv:userEnv(ctx,adapter),timeoutMs:config.loginTimeoutMs??600000,evidenceDir,
    onEvent:e=>{Object.assign(state,{urls:e.urls,codes:e.codes,lastLine:e.lastLine});emit(ctx,'cli-login',{adapterId:adapter.id,login:loginPublic(state)});}});
  if(!handle||handle.error){state.status='error';state.error=handle?.error??'login_not_configured';state.endedAt=new Date().toISOString();return {error:state.error};}
  state.handle=handle;
  handle.done.then(async r=>{
    Object.assign(state,{status:r.status,error:r.error,urls:r.urls??state.urls,codes:r.codes??state.codes,lastLine:'',tail:r.tail??null,exitCode:r.exitCode??null,endedAt:new Date().toISOString(),evidence:r.evidence});   // 끝나면 마지막 줄 비움 (검수 FAIL 4)
    emit(ctx,'cli-login',{adapterId:adapter.id,login:loginPublic(state)});
    await refreshAuth(ctx);   // 로그인 결과를 곧바로 인증 상태에 반영
  });
  return {ok:true,login:loginPublic(state)};
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://x');
    if(req.method==='GET'&&url.pathname==='/healthz')return json(res,{ok:true});   // 배포 플랫폼 헬스체크용 (로그인 불필요). 설정 여부 같은 상태는 내지 않는다 (검수 V04)
    const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
    const isStatic=req.method==='GET'&&/^[\w.\-]+$/.test(file)&&!file.startsWith('api');
    if(isStatic){ // 화면 자체는 로그인 없이 열린다. API 는 전부 세션 필요.
      try{const data=await readFile(new URL('public/'+file,root));res.writeHead(200,{'Content-Type':MIME[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'});return res.end(data);}catch{}
      return json(res,{error:'not_found'},404);
    }
    const user=currentUser(req);
    // ---- 계정 API (로그인 전): 최초 비밀번호 설정 / 로그인 / 로그아웃 ----
    if(req.method==='GET'&&url.pathname==='/api/me'){
      return json(res,user?{user:accounts.publicUser(user)}:{user:null,setupRequired:!owner.isSet},user?200:401);
    }
    if(req.method==='POST'&&['/api/setup','/api/login','/api/logout'].includes(url.pathname)){
      const gate=mutationGate(req);if(gate)return json(res,{error:gate.error},gate.status);
      const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
      if(url.pathname==='/api/setup'){
        if(owner.isSet)return json(res,{error:'already_set'},409);
        if(!setupCode||typeof a.code!=='string'||a.code.length!==setupCode.length||!require_same(a.code,setupCode))return json(res,{error:'setup_code_invalid'},403);
        const r=await owner.setup({password:a.password});
        if(r.error)return json(res,{error:r.error},r.error==='already_set'?409:400);
        await consumeSetupCode();
        const l=await owner.login({password:a.password,key:'setup'});
        setSessionCookie(req,res,l.token);return json(res,{ok:true,user:l.user});
      }
      if(url.pathname==='/api/login'){
        const r=await owner.login({password:a.password,key:clientIp(req)});
        if(r.error)return json(res,{error:r.error},r.error==='too_many_attempts'?429:401);
        setSessionCookie(req,res,r.token);return json(res,{ok:true,user:r.user});
      }
      if(url.pathname==='/api/logout'){const tok=cookies(req).hub;if(user&&tok)closeUserStreams(user.id,sha256(tok));await owner.logout(tok);clearSessionCookie(req,res);return json(res,{ok:true});}
    }
    if(!user)return json(res,{error:'login_required'},401);
    const ctx=await userContext(user);

    if(req.method==='GET'&&url.pathname==='/api/state')return json(res,{...await statePayload(ctx),files:await listFiles(ctx)});
    if(req.method==='GET'&&url.pathname==='/api/memory'){const text=await readMemory(ctx);return json(res,{text,...memoryPublic(text)});}
    if(req.method==='GET'&&url.pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
      res.write('retry: 2000\n\n');res.hubTokenHash=sha256(cookies(req).hub??'');ctx.clients.add(res);req.on('close',()=>ctx.clients.delete(res));
      const tok=cookies(req).hub;const ping=setInterval(()=>{if(!owner.userForToken(tok)){clearInterval(ping);ctx.clients.delete(res);try{res.end();}catch{}return;}res.write(': ping\n\n');},20000);req.on('close',()=>clearInterval(ping));return;
    }
    if(req.method==='GET'&&url.pathname.startsWith('/files/')){
      const name=safeName(decodeURIComponent(url.pathname.slice(7)));const p=path.join(ctx.shared,name);
      try{const st=await stat(p);if(!st.isFile())return json(res,{error:'not_found'},404);}catch{return json(res,{error:'not_found'},404);}
      const ext=path.extname(name).toLowerCase();
      const headers={'Content-Type':MIME[ext]??'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'no-store'};
      if(DOWNLOAD_ONLY.has(ext))headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      res.writeHead(200,headers);
      const stream=createReadStream(p);stream.on('error',()=>res.destroy());return stream.pipe(res);
    }
    // ---- 설정 (1인용): 월 토큰 상한 · 팀장 AI · 비밀번호 변경 ----
    if(req.method==='POST'&&url.pathname.startsWith('/api/settings/')){
      const gate=mutationGate(req);if(gate)return json(res,{error:gate.error},gate.status);
      const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
      if(url.pathname==='/api/settings/budget'){
        const n=a.monthlyTokens===null||a.monthlyTokens===undefined||a.monthlyTokens===''?null:(typeof a.monthlyTokens==='number'||typeof a.monthlyTokens==='string'?Number(a.monthlyTokens):NaN);
        if(n!==null&&!validBudgetTokens(n))return json(res,{error:'budget_invalid'},400);   // 검수 V16: 저장과 같은 검사
        await owner.setBudget(n===null?null:{monthlyTokens:n});ctx.user=owner.user;emit(ctx,'budget',budgetFor(ctx));return json(res,{ok:true,budget:budgetFor(ctx)});
      }
      if(url.pathname==='/api/settings/lead'){
        const id=a.adapterId===null||a.adapterId===undefined||a.adapterId===''?null:String(a.adapterId);
        if(id!==null&&!adapters.some(x=>x.id===id))return json(res,{error:'adapter_not_found'},404);
        await owner.setLead(id);ctx.user=owner.user;emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true,lead:id});
      }
      if(url.pathname==='/api/settings/password'){
        let r;try{r=await owner.changePassword({current:a.current,next:a.next});}catch(e){console.error('password change persist failed',e);return json(res,{error:'persist_failed'},500);}
        if(r.error)return json(res,{error:r.error},r.error==='login_invalid'?401:400);
        closeUserStreams(user.id);   // 검수 V01: 폐기된 세션의 SSE 도 끊는다 (실행 중 작업은 그대로 둔다)
        clearSessionCookie(req,res);return json(res,{ok:true,relogin:true});
      }
      return json(res,{error:'not_found'},404);
    }
    if(req.method==='POST'){
      const gate=mutationGate(req,url.pathname!=='/api/files');
      if(gate)return json(res,{error:gate.error},gate.status);
      if(url.pathname==='/api/send'){
        const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
        if(typeof a.text!=='string'||!a.text.trim())return json(res,{error:'text_required'},400);
        if(a.text.length>LIMITS.textChars)return json(res,{error:'text_too_long',max:LIMITS.textChars},413);
        const files=[...new Set((Array.isArray(a.files)?a.files:[]).map(safeName))].slice(0,50);
        if(a.mode==='orchestrate'){
          const lead=adapters.find(x=>x.id===a.lead);if(!lead)return json(res,{error:'lead_required'},400);
          const workerIds=[...new Set(Array.isArray(a.workers)?a.workers:[])].filter(id=>id!==lead.id&&adapters.some(x=>x.id===id));
          if(!workerIds.length)return json(res,{error:'workers_required'},400);
          const m=await orchestrate(ctx,{text:a.text,files,leadId:lead.id,workerIds});return json(res,{ok:true,id:m.id});
        }
        const targets=[...new Set(Array.isArray(a.targets)?a.targets:[])].filter(id=>adapters.some(x=>x.id===id));if(!targets.length)return json(res,{error:'targets_required'},400);   // 중복 제거 (GPT R10)
        let handoff=null;
        if(a.handoffFrom){const m=ctx.store.get(a.handoffFrom);if(!m||m.role!=='assistant'||m.status!=='done')return json(res,{error:'handoff_source_invalid'},400);handoff={messageId:m.id,fromLabel:adapters.find(x=>x.id===m.adapter)?.label??m.adapter,text:m.text};}
        const m=await dispatch(ctx,{text:a.text,targets,files,handoff});return json(res,{ok:true,id:m.id});
      }
      if(url.pathname==='/api/files'){
        const name=safeName(url.searchParams.get('name'));
        if(Number(req.headers['content-length']??0)>LIMITS.uploadBytes)return json(res,{error:'file_too_large',max:LIMITS.uploadBytes},413);
        let bytes;try{bytes=await bodyBytes(req,LIMITS.uploadBytes);}catch(e){if(e.message==='body_too_large')return json(res,{error:'file_too_large',max:LIMITS.uploadBytes},413);throw e;}
        await writeFile(path.join(ctx.shared,name),bytes,{mode:0o600});emit(ctx,'files',await listFiles(ctx));return json(res,{ok:true,name,bytes:bytes.length});
      }
      if(url.pathname==='/api/save'){
        const a=await bodyJson(req);const m=a&&ctx.store.get(a.messageId);if(!m||typeof m.text!=='string')return json(res,{error:'message_not_found'},404);
        const name=safeName(a.name||`${m.adapter??'user'}-${m.id}.txt`);await writeFile(path.join(ctx.shared,name),m.text,{encoding:'utf8',mode:0o600});emit(ctx,'files',await listFiles(ctx));return json(res,{ok:true,name});
      }
      // ---- v0.5 메모리: 전체 교체 / 답변(또는 메모)을 날짜와 함께 덧붙이기 ----
      if(url.pathname==='/api/memory'){
        const a=await bodyJson(req);if(!a||typeof a.text!=='string')return json(res,{error:'text_required'},400);
        if(a.text.length>LIMITS.textChars)return json(res,{error:'text_too_long',max:LIMITS.textChars},413);
        await writeMemory(ctx,a.text);const mem=memoryPublic(a.text);emit(ctx,'memory',mem);return json(res,{ok:true,...mem});
      }
      if(url.pathname==='/api/memory/append'){
        const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
        let body='';let source='메모';
        if(a.messageId!==undefined&&a.messageId!==null){const m=ctx.store.get(Number(a.messageId));if(!m||typeof m.text!=='string')return json(res,{error:'message_not_found'},404);body=m.text;source=m.role==='user'?'내 메시지':`${adapters.find(x=>x.id===m.adapter)?.label??m.adapter} 답변 #${m.id}`;}
        if(typeof a.note==='string'&&a.note.trim())body=body?`${a.note.trim()}\n\n${body}`:a.note.trim();
        if(!body.trim())return json(res,{error:'text_required'},400);
        const entry=`\n## ${new Date().toISOString().slice(0,16).replace('T',' ')} · ${source}\n${body.trim()}\n`;
        await appendMemory(ctx,entry);const mem=memoryPublic(await readMemory(ctx));emit(ctx,'memory',mem);return json(res,{ok:true,...mem});
      }
      if(url.pathname==='/api/reset'){const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);ctx.store.resetSession(a.adapterId);await ctx.store.save();emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true});}
      if(url.pathname==='/api/auth-check'){await refreshAuth(ctx);return json(res,{ok:true,auth:ctx.authState});}
      if(url.pathname==='/api/cli-login'){
        const a=await bodyJson(req);const adapter=a&&adapters.find(x=>x.id===a.adapterId);if(!adapter)return json(res,{error:'adapter_not_found'},404);
        if(!adapter.login||!Array.isArray(adapter.login.args))return json(res,{error:'login_not_configured'},400);
        const r=beginLogin(ctx,adapter);if(r.error)return json(res,{error:r.error},409);
        emit(ctx,'cli-login',{adapterId:adapter.id,login:r.login});return json(res,{ok:true,login:r.login});
      }
      if(url.pathname==='/api/cli-login/input'){ // 화면에서 입력한 텍스트(인증 코드 등)를 로그인 프로세스의 stdin 으로
        const a=await bodyJson(req);const l=a&&ctx.logins[a.adapterId];if(!l||l.status!=='running'||!l.handle)return json(res,{error:'login_not_running'},409);
        if(typeof a.text!=='string')return json(res,{error:'text_required'},400);
        l.handle.write(a.text);return json(res,{ok:true});
      }
      if(url.pathname==='/api/cli-login/cancel'){const a=await bodyJson(req);const l=a&&ctx.logins[a.adapterId];if(l?.status==='running'&&l.handle)l.handle.cancel();return json(res,{ok:true});}
      return json(res,{error:'not_found'},404);
    }
    json(res,{error:'not_found'},404);
  }catch(e){if(e.message==='body_too_large')return json(res,{error:'body_too_large',max:e.max},413);json(res,{error:/^(state_|accounts_)/.test(e.message)?e.message:'server_error'},500);console.error(e);}
});
const port=Number(process.env.PORT??config.port),host=process.env.HOST??config.host;
if(!allowedHosts.size)for(const h of [`127.0.0.1:${port}`,`localhost:${port}`])allowedHosts.add(h);
server.listen(port,host,()=>{
  console.log(`AI Hub → http://${host}:${port}  (데이터 폴더: ${usersDir}, AI: ${adapters.map(a=>a.id).join(', ')||'없음'})`);
  console.log(`허용 Host: ${ANY_HOST?'모두 (Origin 일치만 검사)':[...allowedHosts].join(', ')}  ·  월 토큰 기본 상한: ${BUDGET_DEFAULT||'무제한'}`);
  if(!owner.isSet)console.log(`아직 비밀번호가 없습니다. 화면의 "AI 오피스 만들기" 에 이 설정 코드를 넣으세요 (1회용, data/setup-code 에도 저장): ${setupCode}`);
  else console.log('주인 비밀번호 설정됨. 화면에서 로그인하세요.');
});
