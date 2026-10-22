// AI Office 서버 (v0.7, 1인용): 브라우저(PC/폰) ⇄ 이 서버 ⇄ 각 AI CLI.
// 서버 주인 한 명(비밀번호 하나)이 쓴다. 작업 폴더는 data/users/1/ 하나:
//   home/       → CLI 의 HOME·설정 폴더(로그인 정보가 여기 저장됨: 사용자별 구독 분리)
//   workspace/  → 공유 파일(shared/) 과 CLI 의 작업 폴더, memory.md(사용자 메모리)
//   state.json  → 대화 기록·세션·월별 사용량 / runs/ → 실행 증거(0700/0600)
// v0.5 추가: 사용자 메모리(memory.md 주입·저장) · 월별 토큰 예산 · 오케스트레이터 모드(팀장 AI 가 분배→종합) · 부분 출력 스트리밍
import http from 'node:http';
import {readFile,writeFile,readdir,stat,mkdir,chmod,appendFile,unlink,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {loadConfig,runAdapter,checkAuth,startLogin,maskLine} from './adapters/index.mjs';
import {Store,sha256,normalizeUsage} from './store.mjs';
import {GDrive} from './gdrive.mjs';
import {Push} from './push.mjs';
import {findNewMedia,collectMedia,MEDIA_EXT} from './media.mjs';
import {Owner,OWNER_ID,PASSWORD_MIN,validBudgetTokens,validPassword} from './owner.mjs';
import {randomBytes} from 'node:crypto';
import {extractPlan} from './orchestrate.mjs';
import {startJanitor} from './janitor.mjs';
import {ErrorWindow,workDetail,startBuildingReporter} from './building.mjs';

const root=new URL('../',import.meta.url);
const config=await loadConfig();
const dataDir=path.resolve(new URL('data/',root).pathname);
const usersDir=path.resolve(new URL((config.users?.dir??'data/users')+'/',root).pathname);
await mkdir(dataDir,{recursive:true,mode:0o700});await mkdir(usersDir,{recursive:true,mode:0o700});
for(const d of [dataDir,usersDir]){try{await chmod(d,0o700);}catch{}}
const adapters=config.adapters.filter(a=>a.enabled);
// v0.9.0 저장 공간 안전장치: 사용률이 높아지면 오래된 실행 기록·CLI 대화 기록부터 지운다 (src/janitor.mjs, config.storage 로 조정)
const janitor=startJanitor(usersDir,config.storage??{});
const buildingErrors=new ErrorWindow();   // v0.10.18 최근 24시간 실행 오류 시각 (빌딩 보고용)
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.md':'text/plain; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.m4v':'video/mp4','.pdf':'application/pdf','.webmanifest':'application/manifest+json'};
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
// v0.9.2 구글 드라이브로 보내기 (src/gdrive.mjs): GDRIVE_CLIENT_ID·GDRIVE_CLIENT_SECRET 가 있을 때만 켜진다. 업로드는 사람이 누른 버튼으로만, 권한은 drive.file.
const gdrive=new GDrive({dataDir});await gdrive.load();
// v0.10 푸시 알림 (src/push.mjs): 작업이 끝났을 때·AI 가 허락을 기다릴 때 폰으로. 화면을 보고 있으면(presence) 보내지 않는다.
const push=new Push({dataDir});await push.load();
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
// v0.10.10 SameSite=Lax: 홈 화면 앱(PWA)에서 이미지·파일을 새 탭으로 열면 앱 밖 브라우저로 넘어가며 Strict 쿠키가 안 붙어 login_required 가 났다. 변경(POST)은 mutationGate 의 Origin 검사가 막으므로 Lax 로 충분.
const setSessionCookie=(req,res,token)=>res.setHeader('Set-Cookie',`hub=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30*24*3600}${isSecure(req)?'; Secure':''}`);
const clearSessionCookie=(req,res)=>res.setHeader('Set-Cookie',`hub=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(req)?'; Secure':''}`);

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
    const c={user,dir,home,tmpDir,workspace,shared,runs,memoryFile:path.join(workspace,'memory.md'),store,authState:{},clients:new Set(),logins:{},running:new Set(),active:0,queue:[],haltSeq:0};   // haltSeq: v0.8.8 긴급 중지 횟수 (오케스트레이터가 다음 단계로 가기 전에 비교)
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
const MSG_WINDOW=300;   // v0.10.6 상태 스냅샷에 싣는 최근 메시지 수
function emit(ctx,type,data){const line=`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of ctx.clients)res.write(line);}
// 사용자의 열린 SSE 와 진행 중 CLI 로그인을 닫는다 (계정 중지·로그아웃 시, 검수 FAIL 7). tokenHash 를 주면 그 세션의 SSE 만.
function closeUserStreams(userId,tokenHash=null,{cancelRuns=false}={}){
  const tctx=contexts.get(userId);if(!tctx)return;
  for(const c of [...tctx.clients]){if(tokenHash&&c.hubTokenHash!==tokenHash)continue;try{c.end();}catch{}tctx.clients.delete(c);}
  if(!tokenHash&&cancelRuns){
    for(const l of Object.values(tctx.logins))if(l?.status==='running'&&l.handle)l.handle.cancel();
    haltRuns(tctx);
  }
}
// v0.8.8 긴급 중지: 진행 중인 모든 CLI 프로세스(프로세스 그룹째 SIGTERM→SIGKILL)와 대기열을 끊고, 오케스트레이터가 다음 단계(②분배·③종합)로 넘어가지 못하게 haltSeq 를 올린다.
// 돌려주는 값: 끊은 실행 수. 이미 끝난 답변은 그대로 두고, 끊긴 것은 status 'cancelled' 로 기록된다(증거 파일도 남는다).
export function haltRuns(ctx){
  ctx.haltSeq=(ctx.haltSeq??0)+1;
  const n=ctx.running.size+ctx.queue.length;
  for(const ac of [...ctx.running])ac.abort();   // 진행 중인 모델 실행(인증 확인 단계 포함)도 끊는다 (GPT R08/F03)
  for(const w of ctx.queue.splice(0))w.reject(Object.assign(new Error('cancelled'),{cancelled:true}));   // 대기 중이던 요청은 취소로 끝낸다 (GPT F04)
  return n;
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
  // v0.10.14 AI 별 API 환산 단가(config price)·전체 월 사용량·환율 — 화면이 입력/출력/환산 금액 표를 그린다
  const prices=Object.fromEntries(adapters.filter(a=>a.price&&Number.isFinite(a.price.input)&&Number.isFinite(a.price.output)).map(a=>[a.id,{model:a.price.model??'',input:a.price.input,output:a.price.output,asOf:a.price.asOf??''}]));
  return {month:u.month,tokens:u.tokens,calls:u.total.calls,byAdapter:u.byAdapter,limit,exceeded:limit>0&&u.tokens>=limit,prices,usdKrw:Number(config.usdKrw)||1400,months:ctx.store.state.usage};
}

const loginPublic=l=>l?{status:l.status,urls:l.urls??[],codes:l.codes??[],lastLine:l.lastLine??'',error:l.error??null,startedAt:l.startedAt,endedAt:l.endedAt??null,tail:l.tail??null,exitCode:l.exitCode??null}:null;
// ---- v0.9.3 AI 별 '모두에게 빼기' · 사용 한도 쉬는 시간 ----
// quiet: 모두에게·팀장 분배에서 빠지고 @이름 으로 부를 때만 답한다. 사용자가 정한 값(owner.json quiet) > config 의 quietDefault.
const isQuiet=a=>{const q=owner.user.quiet??{};return typeof q[a.id]==='boolean'?q[a.id]:!!a.quietDefault;};
// 한도 소진: CLI 가 "Individual quota reached … Resets in 159h53m24s" 처럼 알려 주면 그 시각까지 이 AI 를 띄우지 않는다(매번 실패하며 시간만 쓰지 않게). state.json 에 남아 재시작 뒤에도 유지.
export function parseQuota(text){
  const t=String(text??'');
  if(!/individual quota reached|resource_exhausted|quota (?:has been )?(?:reached|exceeded)|(?:usage|weekly|rate) limit (?:reached|exceeded|hit)|(?:reached|exceeded|hit) (?:your|the) (?:usage|weekly) (?:limit|allowance)|out of (?:usage|credits)/i.test(t))return null;   // v0.10: Grok·Codex 류 문구도
  const m=/resets? in\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i.exec(t);
  const ms=m&&(m[1]||m[2]||m[3])?((+m[1]||0)*3600+(+m[2]||0)*60+(+m[3]||0))*1000:null;
  return {resetMs:ms};
}
function cooldownOf(ctx,id){const v=ctx.store.state.cooldowns?.[id];return v&&Date.parse(v)>Date.now()?v:null;}
function setCooldown(ctx,id,iso){const c=ctx.store.state.cooldowns??(ctx.store.state.cooldowns={});if(iso)c[id]=iso;else delete c[id];}
async function statePayload(ctx){
  const memory=await readMemory(ctx);
  return {user:accounts.publicUser(ctx.user),lead:owner.user.lead,adapters:adapters.map(a=>({id:a.id,label:a.label,color:a.color,avatar:typeof a.avatar==='string'&&/^[\w.\-]+\.(png|jpg)$/.test(a.avatar)?a.avatar:null,roleHint:a.roleHint??'',session:ctx.store.session(a.id),auth:ctx.authState[a.id]??null,canLogin:!!(a.login&&Array.isArray(a.login.args)),login:loginPublic(ctx.logins[a.id]),stream:!!a.stream,quiet:isQuiet(a),cooldownUntil:cooldownOf(ctx,a.id),runTimeoutMs:Number.isSafeInteger(a.runTimeoutMs)&&a.runTimeoutMs>0?a.runTimeoutMs:config.timeoutMs})),messages:ctx.store.state.messages.slice(-MSG_WINDOW),older:Math.max(0,ctx.store.state.messages.length-MSG_WINDOW),clearedBefore:ctx.store.clearedBefore(),workspace:ctx.workspace,evidenceRoot:ctx.runs,budget:budgetFor(ctx),memory:memoryPublic(memory),orchestrate:{maxTasks:ORCH_MAX_TASKS},limits:LIMITS};
}
// 프롬프트 합성: (메모리) + (다른 AI 답변 전문) + 본문 + 첨부 안내. 원문을 요약하거나 자르지 않는다.
// v0.8.5 방 대화 공유: 같은 방의 최근 메시지(사용자 + 다른 AI 의 완료된 답변)를 프롬프트 앞에 붙여, AI 끼리 서로의 말을 보고 이어 말할 수 있게 한다.
// 범위: 최근 ROOM.recent 개 · 전체 ROOM.maxChars 자 · 메시지당 ROOM.perMessage 자. 팀장 내부 단계(plan/task)는 제외하고 ③ 종합만 넣는다. 현재 요청(마지막 사용자 메시지)은 제외.
const ROOM={recent:config.room?.recent??20,maxChars:config.room?.maxChars??6000,perMessage:config.room?.perMessage??800};
export function roomContext(ctx,{forAdapter,excludeMessageId}){
  if(ctx.user?.roomShare===false)return '';
  if(adapters.find(a=>a.id===forAdapter)?.roomShare===false)return '';   // v0.9.3: AI 별로 끔 (Gemini 기본: 오버헤드·할당량 절약)
  const label=id=>adapters.find(a=>a.id===id)?.label??id;
  const msgs=ctx.store.state.messages.filter(m=>m.id!==excludeMessageId&&(m.role==='user'||(m.status==='done'&&m.text&&m.kind!=='plan'&&m.kind!=='task'))).slice(-ROOM.recent);
  const lines=[];let total=0;
  for(const m of msgs.reverse()){   // 최신부터 채우고 뒤집는다 — 상한에 걸리면 오래된 것부터 빠진다
    const who=m.role==='user'?'사용자':label(m.adapter)+(m.adapter===forAdapter?' (당신)':'');
    let t=String(m.text).trim();if(t.length>ROOM.perMessage)t=t.slice(0,ROOM.perMessage)+' …(생략)';
    const line=`${who}: ${t}`;if(total+line.length>ROOM.maxChars)break;total+=line.length;lines.push(line);
  }
  if(!lines.length)return '';
  return `[방 대화 — 이 방의 최근 메시지입니다(오래된 것부터). 다른 AI 의 말은 동의·반박·보완해도 됩니다. 당신은 "${label(forAdapter)}" 입니다. 답변에는 이 목록을 다시 쓰지 말고 바로 본론을 쓰세요.]\n${lines.reverse().join('\n')}\n\n`;
}
// v0.8.7 행동 규칙(사용자 지시): 파일 삭제와 추가 과금은 사용자 허락을 받는다. 모든 호출(일반·팀장 ①②③)의 프롬프트 맨 끝에 붙는다.
// CLI 는 비대화형이라 "묻는" 유일한 방법은 멈추고 답변에 적는 것이다. 답변이 [승인 요청] 으로 시작하면 서버가 approvalRequested 로 표시해 화면에서 눈에 띄게 한다.
export const APPROVAL_MARK='[승인 요청]';
// v0.10.2: 만든 이미지·영상·파일은 shared/ 에 — 방 화면이 답변 아래에 바로 보여 준다(다른 곳에 저장해도 서버가 찾아서 올리지만 이름이 길어진다)
export const MEDIA_NOTE='[결과 파일] 이미지·영상·문서 등 파일을 만들면 작업 폴더의 shared/ 폴더에 저장하고, 답에 파일 이름을 적으세요. shared/ 의 이미지·영상은 방 화면에 바로 보입니다.';
export const RULES_NOTE=`[행동 규칙 — 반드시 지키세요]\n1. 파일·폴더 삭제, 비우기, 덮어써서 기존 내용을 없애는 일(rm, git clean/reset --hard, 테이블 drop 등)은 하지 마세요.\n2. 돈이 드는 일 — 유료 API·서비스 결제, 구독, 클라우드 자원 생성·배포, 패키지 공개 등 추가 과금이 생길 수 있는 일 — 은 하지 마세요.\n3. 위 두 가지가 꼭 필요하면 거기서 멈추고, 답변 맨 앞을 "${APPROVAL_MARK}" 로 시작해 무엇을 왜 하려는지와 그 외에 끝낸 일을 적으세요. 사용자가 다음 메시지로 허락하면 그때 진행합니다.\n4. 그 밖의 읽기·수정·새 파일 생성·테스트 실행은 허락 없이 진행하세요. 환경 문제로 안 되면 오류를 그대로 적고, 하지 않은 일을 한 것처럼 쓰지 마세요.\n\n`;
function composePrompt({text,files=[],handoff=null,memory='',room=''}){
  let p='';
  if(memory&&memory.trim())p+=`[내 메모리 — 이전 대화에서 저장해 둔 맥락·결정·취향입니다. 작업 폴더의 memory.md 와 같습니다. 참고만 하고, 사용자 요청이 우선입니다.]\n${memory.trim()}\n\n`;
  if(room)p+=room;
  if(handoff)p+=`[다른 AI(${handoff.fromLabel})의 답변 전문입니다. 그대로 검토·참고하세요.]\n${handoff.text}\n\n[사용자 요청]\n`;
  p+=text;
  if(files.length)p+=`\n\n[첨부 파일 — 현재 작업 폴더의 shared/ 안에 있습니다. 직접 읽어서 참고하세요]\n`+files.map(f=>`- shared/${f}`).join('\n');
  p+=`\n\n`+MEDIA_NOTE;   // v0.10.2
  p+=`\n\n`+RULES_NOTE.trimEnd();   // v0.8.7 행동 규칙은 맨 끝에 (앞부분의 메모리·방 대화·요청 순서는 그대로)
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
// ---- v0.10.2 AI 가 만든 이미지·영상을 답변에 붙인다 (src/media.mjs) ----
async function attachMedia(ctx,adapter,id,since,extraText){
  try{
    const m=ctx.store.get(id);if(!m||(m.status!=='done'&&m.status!=='error'))return;
    const real=async d=>{try{return await realpath(d);}catch{return d;}};
    const allowed=await Promise.all([ctx.workspace,ctx.home].map(real));
    const claimed=ctx.claimedMedia??(ctx.claimedMedia=new Set());
    const files=await findNewMedia({roots:[{dir:ctx.workspace,depth:6},{dir:ctx.home,depth:6}],allowed,since,text:`${m.text??''}\n${extraText??''}`,cwd:ctx.workspace,claimed});
    if(!files.length)return;
    for(const f of files)claimed.add(f.path);
    const media=await collectMedia(files,{shared:ctx.shared,prefix:`${adapter.id}-${id}`,safeName});
    if(!media.length)return;
    for(const x of media)claimed.add(path.join(await real(ctx.shared),x.name));
    ctx.store.update(id,{media});emit(ctx,'files',await listFiles(ctx));
  }catch(e){console.warn('attachMedia',e.message);}
}
// ---- 한 AI 호출 한 번 = 답변 메시지 하나. 인증·예산 게이트 → 실행(부분 출력 스트리밍) → 증거·사용량 기록. ----
// 반환: 저장된 답변 메시지(status done/blocked/error). 예외를 던지지 않는다.
// v0.10.11 자동 새 대화: config 에 sessionResetTokens 를 둔 AI 만(Grok 120k). 기본은 꺼짐 — Claude·Codex·Gemini 는 코딩 맥락을 잃지 않도록 절대 자동으로 세션을 버리지 않는다.
const autoResetOn=adapter=>Number.isFinite(adapter.sessionResetTokens)&&adapter.sessionResetTokens>0;
function sessionTooBig(adapter,usage){return autoResetOn(adapter)&&normalizeUsage(usage).input>adapter.sessionResetTokens;}
async function runOne(ctx,adapter,{prompt,replyTo,kind='answer',extra={},useSession=true}){
  const {store}=ctx;
  const reply=store.add({role:'assistant',adapter:adapter.id,replyTo,kind,status:'running',text:'',...extra});
  emit(ctx,'message',reply);
  const evidenceDir=path.join(ctx.runs,`${reply.id}-${adapter.id}`);
  const ac=new AbortController();let slot=false,runStart=0,mediaText='';
  ctx.running.add(ac);   // 큐 대기·인증 확인·실행을 하나의 취소 수명으로 (GPT F03): 중지되면 어느 단계든 abort 된다
  try{
    await acquireSlot(ctx);slot=true;
    if(isDisabled(ctx)||ac.signal.aborted){   // 단계마다 다시 본다: 오케스트레이터 중간에 중지돼도 다음 CLI 를 띄우지 않는다 (GPT R08 / Gemini FAIL4)
      store.update(reply.id,{status:'blocked',error:'user_disabled'});
      await persistThenEmit(ctx,reply.id);return store.get(reply.id);
    }
    const cool=cooldownOf(ctx,adapter.id);
    if(cool){   // v0.9.3: 한도 소진으로 쉬는 중 — CLI 를 띄우지 않는다
      store.update(reply.id,{status:'blocked',error:'quota_cooldown',resetAt:cool});
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
    runStart=Date.now();   // v0.10.2 이 시각 뒤에 생긴 미디어 파일을 답변에 붙인다
    const r=await runAdapter(adapter,{prompt,cwd:ctx.workspace,session,timeoutMs:Number.isSafeInteger(adapter.runTimeoutMs)&&adapter.runTimeoutMs>0?adapter.runTimeoutMs:config.timeoutMs,evidenceDir,extraEnv:userEnv(ctx,adapter),onChunk,signal:ac.signal});
    if(useSession)store.setSession(adapter.id,r.session,epoch);   // "새 대화" 이후에 끝난 실행은 옛 세션을 되살리지 않는다
    const used=store.addUsage(adapter.id,r.usage);
    mediaText=`${r.stdout??''}\n${r.stderr??''}`;
    const approvalRequested=r.text.trimStart().startsWith(APPROVAL_MARK);   // v0.8.7: 삭제·과금 전 멈춰서 허락을 구한 답변
    if(approvalRequested&&kind==='task'&&!watching(ctx))push.notify('ask',{title:`✋ ${labelOf(adapter.id)}가 허락을 기다려요`,body:firstLine(r.text.replace(/^\s*\[승인 요청\]\s*/,'')),url:`/#m${reply.id}`,tag:`a${reply.id}`}).catch(()=>{});   // v0.10: 팀원은 종합까지 기다리지 않고 바로
    const autoReset=useSession&&sessionTooBig(adapter,r.usage);if(autoReset)store.resetSession(adapter.id);   // v0.10.11 대화가 커지면 다음부터 자동 새 대화 (매번 '새 대화'를 누르지 않아도 됨)
    store.update(reply.id,{status:'done',text:r.text,approvalRequested,usage:r.usage,elapsedMs:r.elapsedMs,session:r.session??session,sessionReset:autoReset||undefined,hash:sha256(r.text),exitCode:r.exitCode,evidence:r.evidence,envBlockedNames:r.envBlockedNames,authCheck:publicAuth(auth),usageMonth:{...used}});
  }catch(e){
    const evidenceFailed=/^evidence_/.test(e.message);
    const stderrTail=typeof e.stderr==='string'&&e.stderr.trim()?e.stderr.trim().split('\n').slice(-8).map(l=>maskLine(l.slice(0,300))).join('\n').slice(-1200):null;   // v0.8.1: 실패 원인을 화면에서 볼 수 있게 stderr 꼬리(가림 처리)를 함께 둔다 — 원문은 증거 파일에
    mediaText=`${e.stdout??''}\n${e.stderr??''}\n${e.text??''}`;
    const quota=!e.cancelled?parseQuota(`${e.stderr??''}\n${e.text??''}\n${e.message??''}`):null;   // v0.9.3 한도 소진 알아보기
    const resetAt=quota?.resetMs?new Date(Date.now()+quota.resetMs).toISOString():null;
    if(resetAt){setCooldown(ctx,adapter.id,resetAt);emit(ctx,'state',await statePayload(ctx));}
    const autoReset=useSession&&!!e.timedOut&&autoResetOn(adapter);if(autoReset)store.resetSession(adapter.id);   // v0.10.11 시간 초과 뒤 자동 새 대화 — 켜 둔 AI(Grok)만
    store.update(reply.id,{status:e.cancelled?'cancelled':'error',error:quota?'quota_exhausted':e.message,sessionReset:autoReset||undefined,cliError:quota?e.message:undefined,resetAt,stderrTail,exitCode:e.exitCode??null,signal:e.signal??null,timedOut:!!e.timedOut,parseFailed:!!e.parseFailed,elapsedMs:e.elapsedMs??null,evidence:e.evidence??null,evidencePreserved:!!e.evidence&&!evidenceFailed,envBlockedNames:e.envBlockedNames??null,...(evidenceFailed&&typeof e.text==='string'?{text:e.text,hash:sha256(e.text),unstoredAnswer:true}:{})});
  }
  finally{ctx.running.delete(ac);if(slot)releaseSlot(ctx);}
  if(runStart)await attachMedia(ctx,adapter,reply.id,runStart,mediaText);   // v0.10.2
  {const m=store.get(reply.id);if(m?.status==='error')buildingErrors.record();   // v0.10.18 빌딩 보고용 오류 수(시각만)
  if(m)console.log(`[run] #${m.id} ${adapter.id} ${m.status}${m.error?' '+m.error:''} ${m.elapsedMs?(m.elapsedMs/1000).toFixed(0)+'s':''} exit=${m.exitCode??'-'}${m.timedOut?' timedOut':''}${m.parseFailed?' parseFailed':''}${m.usage?` tok=${normalizeUsage(m.usage).input}+${normalizeUsage(m.usage).output}`:''}${m.stderrTail?' stderr: '+m.stderrTail.split('\n').at(-1).slice(0,160):''}`);}   // v0.10.9 실행 결과 한 줄(본문 없음) — Railway 로그에서 실패 원인을 볼 수 있게
  await persistThenEmit(ctx,reply.id);   // 검수 V13: 디스크에 남은 뒤에만 완료를 알린다
  emit(ctx,'budget',budgetFor(ctx));
  janitor.maybe();   // v0.9.0: 실행이 끝날 때마다 사용률을 보고, 높으면 바로 정리 (기다리지 않음)
  return store.get(reply.id);
}

// ---- v0.10 푸시: 한 질문의 답이 다 끝나면 한 번, 팀원(②)이 허락을 기다리면 바로 ----
const PRESENCE_MS=45000;   // 화면이 30초마다 "보고 있음" 을 알린다. 45초 안에 신호가 있으면 알림을 보내지 않는다
const watching=ctx=>(ctx.visibleUntil??0)>Date.now();
const firstLine=t=>String(t??'').replace(/\s+/g,' ').trim().slice(0,110);
const labelOf=id=>adapters.find(a=>a.id===id)?.label?.replace(/\s*\(.*\)/,'')??id;
export function roundSummary(messages,userMsgId){
  const plans=new Set(messages.filter(m=>m.replyTo===userMsgId&&m.kind==='plan').map(m=>m.id));
  const mine=messages.filter(m=>m.role==='assistant'&&(m.replyTo===userMsgId||plans.has(m.replyTo)));
  if(!mine.length||mine.some(m=>m.status==='running'))return null;
  const ask=mine.find(m=>m.status==='done'&&m.approvalRequested);
  if(ask)return {kind:'ask',title:`✋ ${labelOf(ask.adapter)}가 허락을 기다려요`,body:firstLine(ask.text.replace(/^\s*\[승인 요청\]\s*/,'')),focus:ask.id};
  const final=mine.find(m=>m.kind==='final');
  const shown=final?[final]:mine.filter(m=>m.kind!=='plan'&&m.kind!=='task');
  const ok=shown.filter(m=>m.status==='done'),bad=mine.filter(m=>m.status==='error'||m.status==='blocked');
  if(!ok.length&&!bad.length)return null;   // 전부 긴급 중지 → 알리지 않음
  const who=[...new Set(ok.map(m=>labelOf(m.adapter)))].join('·');
  const title=ok.length?(final?`✅ 팀 작업 끝 · ${who} 종합`:`💬 ${who} 답변 도착`):'⚠️ 답변 실패';
  const body=ok.length?firstLine(ok[0].text):bad.map(m=>`${labelOf(m.adapter)}: ${m.error}`).join(' · ');
  return {kind:'done',title:bad.length&&ok.length?`${title} (${bad.map(m=>labelOf(m.adapter)).join('·')} 실패)`:title,body,focus:(ok[0]??bad[0]).id};
}
async function notifyRound(ctx,userMsgId){
  try{
    const sum=roundSummary(ctx.store.state.messages,userMsgId);if(!sum||watching(ctx))return;
    await push.notify(sum.kind,{title:sum.title,body:sum.body,url:`/#m${sum.focus}`,tag:`r${userMsgId}`});
  }catch(e){console.warn('notifyRound',e.message);}
}
async function dispatch(ctx,{text,targets,files,handoff}){
  const {store}=ctx;
  const userMsg=store.add({role:'user',text,files,targets,handoffFrom:handoff?.messageId??null});
  emit(ctx,'message',userMsg);await store.save();
  const memory=await readMemory(ctx);
  const work=Promise.all(targets.map(id=>{const adapter=adapters.find(a=>a.id===id);if(!adapter)return;const prompt=composePrompt({text,files,handoff,memory,room:roomContext(ctx,{forAdapter:adapter.id,excludeMessageId:userMsg.id})});return serialOn(ctx,adapter.id,()=>runOne(ctx,adapter,{prompt,replyTo:userMsg.id}));}));
  work.catch(e=>console.error('dispatch',e)).finally(()=>notifyRound(ctx,userMsg.id));   // v0.10 푸시
  return userMsg;
}

// ---- v0.5 오케스트레이터: 팀장 AI 에게 목표를 주면 ① 계획(JSON) → ② 서버가 워커 AI 들에 분배(병렬) → ③ 팀장이 종합. ----
// 세 단계 모두 일반 호출과 같은 인증·예산·증거 규칙을 탄다. 계획 JSON 은 팀장 답변 본문에서 뽑고, 못 뽑으면 plan_parse_failed 로 끝낸다.
function planPrompt({goal,files,lead,workers,memory,room=''}){
  const roster=workers.map(w=>`- "${w.id}": ${w.label}${w.roleHint?' — '+w.roleHint:''}`).join('\n');
  const body=`### HUB:PLAN\n당신은 이 AI 오피스의 팀장(오케스트레이터)입니다. 아래 목표를 읽고, 팀원 AI 에게 나눠 줄 작업을 계획하세요.\n\n[팀원 — worker 값으로 정확히 이 id 를 쓰세요]\n${roster}\n\n[규칙]\n- 작업은 최대 ${ORCH_MAX_TASKS}개. 서로 독립적으로 수행 가능해야 합니다(병렬 실행).\n- 각 작업의 prompt 는 그 팀원이 아무 맥락 없이 읽어도 수행할 수 있게 완결된 지시문으로 쓰세요. 목표의 필요한 부분을 그대로 포함하세요.\n- 팀원에게 맡길 필요 없이 바로 답할 수 있으면 tasks 를 빈 배열로 두고 answer 에 최종 답을 쓰세요.\n- 답변은 아래 JSON 하나만, 다른 설명 없이:\n{"tasks":[{"worker":"<id>","title":"<짧은 제목>","prompt":"<완결된 지시문>"}],"note":"<계획 의도 한 줄>","answer":null}\n\n[목표]\n${goal}`;
  return composePrompt({text:body,files,memory,room});
}
function synthPrompt({goal,results}){
  const parts=results.map((r,i)=>`--- 작업 ${i+1}: ${r.title||'(제목 없음)'} · 담당 ${r.label} · 상태 ${r.status}${r.error?' ('+r.error+')':''} ---\n${r.text||'(결과 없음)'}`).join('\n\n');
  return `### HUB:SYNTHESIZE\n당신은 팀장입니다. 아래는 당신이 계획해 팀원들이 수행한 작업 결과 전문입니다. 결과를 검토·종합해 목표에 대한 최종 답변을 작성하세요. 결과끼리 모순되면 지적하고, 실패한 작업은 무엇이 빠졌는지 밝히세요. 팀원이 "${APPROVAL_MARK}" 으로 멈춘 작업이 있으면 최종 답변 맨 앞에 그 요청들을 모아 사용자가 허락/거부를 고를 수 있게 적으세요.\n\n[목표]\n${goal}\n\n[팀원 결과]\n${parts}`;
}
async function orchestrate(ctx,{text,files,leadId,workerIds}){
  const {store}=ctx;
  const lead=adapters.find(a=>a.id===leadId);
  const workers=workerIds.map(id=>adapters.find(a=>a.id===id)).filter(a=>a&&a.id!==leadId);
  const userMsg=store.add({role:'user',text,files,targets:[leadId],mode:'orchestrate',lead:leadId,workers:workers.map(w=>w.id)});
  emit(ctx,'message',userMsg);await store.save();
  const run=(async()=>{
    const memory=await readMemory(ctx);
    const haltSeq=ctx.haltSeq;   // v0.8.8: 이 오케스트레이션이 시작된 뒤 긴급 중지가 눌렸으면 다음 단계로 가지 않는다
    const halted=()=>isDisabled(ctx)||ctx.haltSeq!==haltSeq;
    // ① 계획
    const plan=await serialOn(ctx,lead.id,()=>runOne(ctx,lead,{prompt:planPrompt({goal:text,files,lead,workers,memory,room:roomContext(ctx,{forAdapter:lead.id,excludeMessageId:userMsg.id})}),replyTo:userMsg.id,kind:'plan'}));
    if(plan.status!=='done')return;
    if(halted()){store.update(plan.id,{orchestrateError:'stopped'});emit(ctx,'message',store.get(plan.id));await store.save();return;}   // 계획 뒤 중지됨 → 팀원 단계 자체를 만들지 않는다 (GPT R08)
    const parsed=extractPlan(plan.text,workers.map(w=>w.id),ORCH_MAX_TASKS);
    if(!parsed){store.update(plan.id,{status:'error',error:'plan_parse_failed',text:plan.text});emit(ctx,'message',store.get(plan.id));await store.save();return;}
    store.update(plan.id,{plan:{tasks:parsed.tasks.map(t=>({worker:t.worker,title:t.title})),note:parsed.note,dropped:parsed.dropped,requested:parsed.requested}});emit(ctx,'message',store.get(plan.id));await store.save();
    if(!parsed.tasks.length){   // 팀장이 직접 답함
      const final=store.add({role:'assistant',adapter:lead.id,replyTo:userMsg.id,kind:'final',status:'done',text:parsed.answer??plan.text,elapsedMs:0,derivedFrom:plan.id});
      emit(ctx,'message',final);await store.save();return;
    }
    // ② 분배 (병렬, 사용자 동시 실행 상한 안에서). 각 작업 프롬프트에는 메모리를 다시 넣지 않되 첨부 파일 목록은 넣는다 (Gemini FAIL1-4).
    const fileNote=files.length?`\n\n[첨부 파일 — 현재 작업 폴더의 shared/ 안에 있습니다. 직접 읽어서 참고하세요]\n`+files.map(f=>`- shared/${f}`).join('\n'):'';
    // v0.8.7: 팀원 작업 프롬프트에도 행동 규칙(삭제·과금 금지 → [승인 요청])과 작업 환경을 붙인다 — 실행·테스트가 가능하니 "못 해봤다"로 끝내지 말고 실제로 돌려 보게.
    const envNote=`\n\n[작업 환경] 현재 작업 폴더에서 파일 읽기·쓰기와 명령 실행이 가능합니다. 설치된 도구: python3(= python, 3.11)·pip3·pytest·Node 22·npm·git·make·jq. 환경에 대한 과거 대화 내용("Python 이 없다" 등)은 믿지 말고 \`python3 --version\` 처럼 직접 확인하세요. 코드를 바꿨으면 실제로 실행·테스트해 결과를 보고하세요.\n\n${MEDIA_NOTE}`;
    const results=await Promise.all(parsed.tasks.map(async(t,i)=>{
      const w=workers.find(x=>x.id===t.worker);
      const r=await runOne(ctx,w,{prompt:`### HUB:TASK ${i+1}/${parsed.tasks.length} — ${t.title}\n${t.prompt}${envNote}${fileNote}\n\n${RULES_NOTE.trimEnd()}`,replyTo:plan.id,kind:'task',extra:{taskTitle:t.title,taskIndex:i+1},useSession:false});
      return {title:t.title,label:w.label,status:r.status+(r.approvalRequested?' (승인 요청 — 사용자 허락 대기)':''),error:r.error??null,text:r.text??''};
    }));
    // ③ 종합 — 성공한 작업이 하나도 없으면 팀장을 다시 부르지 않는다 (Gemini FAIL4-2). 중지됐으면 runOne 이 막는다.
    if(halted()){store.update(plan.id,{orchestrateError:'stopped'});emit(ctx,'message',store.get(plan.id));await store.save();return;}   // 긴급 중지 → 끝난 작업이 있어도 ③ 종합을 띄우지 않는다
    if(results.every(r=>r.status!=='done')){store.update(plan.id,{orchestrateError:'all_tasks_failed'});emit(ctx,'message',store.get(plan.id));await store.save();return;}
    await serialOn(ctx,lead.id,()=>runOne(ctx,lead,{prompt:synthPrompt({goal:text,results}),replyTo:userMsg.id,kind:'final',extra:{derivedFrom:plan.id}}));
  })();
  run.catch(e=>console.error('orchestrate',e)).finally(()=>notifyRound(ctx,userMsg.id));   // v0.10 푸시
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
    // v0.10.6 옛 메시지는 필요할 때만: 상태 스냅샷은 최근 MSG_WINDOW 개만 싣고(대화가 쌓이면 스냅샷이 수 MB → 화면이 느려짐), 더 위는 여기서 100개씩
    if(req.method==='GET'&&url.pathname==='/api/messages'){const before=Number(url.searchParams.get('before'));const lim=Math.min(300,Math.max(1,Number(url.searchParams.get('limit'))||100));const all=ctx.store.state.messages;const olderAll=Number.isSafeInteger(before)?all.filter(m=>m.id<before):all;return json(res,{messages:olderAll.slice(-lim),older:Math.max(0,olderAll.length-lim)});}
    if(req.method==='GET'&&url.pathname==='/api/storage')return json(res,await janitor.info(url.searchParams.get('detail')==='1'));   // v0.9.0 · v0.10.15 detail=1: 무엇이 큰지
    if(req.method==='GET'&&url.pathname==='/api/gdrive')return json(res,gdrive.status());   // v0.9.2
    if(req.method==='GET'&&url.pathname==='/api/push')return json(res,push.status(url.searchParams.get('endpoint')));   // v0.10
    if(req.method==='GET'&&url.pathname==='/api/memory'){const text=await readMemory(ctx);return json(res,{text,...memoryPublic(text)});}
    if(req.method==='GET'&&url.pathname==='/api/events'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
      res.write('retry: 2000\n\n');res.hubTokenHash=sha256(cookies(req).hub??'');ctx.clients.add(res);req.on('close',()=>ctx.clients.delete(res));
      const tok=cookies(req).hub;const ping=setInterval(()=>{if(!owner.userForToken(tok)){clearInterval(ping);ctx.clients.delete(res);try{res.end();}catch{}return;}res.write(': ping\n\n');},20000);req.on('close',()=>clearInterval(ping));return;
    }
    if(req.method==='GET'&&url.pathname.startsWith('/files/')){
      const name=safeName(decodeURIComponent(url.pathname.slice(7)));const p=path.join(ctx.shared,name);
      let st;try{st=await stat(p);if(!st.isFile())return json(res,{error:'not_found'},404);}catch{return json(res,{error:'not_found'},404);}
      const ext=path.extname(name).toLowerCase();
      const headers={'Content-Type':MIME[ext]??'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Cache-Control':'private, max-age=3600','Accept-Ranges':'bytes'};
      if(DOWNLOAD_ONLY.has(ext))headers['Content-Disposition']=`attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
      // v0.10.2 영상 재생(특히 사파리)은 Range 요청을 쓴다: bytes=a-b 한 구간만 지원
      const rm=/^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range??''));
      if(rm&&(rm[1]||rm[2])){
        let start=rm[1]===''?Math.max(0,st.size-Number(rm[2])):Number(rm[1]);let end=rm[1]===''||rm[2]===''?st.size-1:Math.min(Number(rm[2]),st.size-1);
        if(!(start<=end&&start<st.size)){res.writeHead(416,{'Content-Range':`bytes */${st.size}`});return res.end();}
        res.writeHead(206,{...headers,'Content-Range':`bytes ${start}-${end}/${st.size}`,'Content-Length':String(end-start+1)});
        const stream=createReadStream(p,{start,end});stream.on('error',()=>res.destroy());return stream.pipe(res);
      }
      res.writeHead(200,{...headers,'Content-Length':String(st.size)});
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
      if(url.pathname==='/api/settings/quiet'){   // v0.9.3
        const ad=adapters.find(x=>x.id===a.adapterId);if(!ad)return json(res,{error:'adapter_not_found'},404);
        if(typeof a.quiet!=='boolean')return json(res,{error:'quiet_invalid'},400);
        await owner.setQuiet(ad.id,a.quiet);ctx.user=owner.user;emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true,quiet:a.quiet});
      }
      if(url.pathname==='/api/settings/cooldown-clear'){   // v0.9.3: 한도 쉬는 시간 직접 풀기(업그레이드했을 때 등)
        const ad=adapters.find(x=>x.id===a.adapterId);if(!ad)return json(res,{error:'adapter_not_found'},404);
        setCooldown(ctx,ad.id,null);await ctx.store.save();emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true});
      }
      if(url.pathname==='/api/settings/room'){
        if(typeof a.share!=='boolean')return json(res,{error:'share_invalid'},400);
        await owner.setRoomShare(a.share);ctx.user=owner.user;emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true,roomShare:a.share});
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
        await writeFile(path.join(ctx.shared,name),bytes,{mode:0o600});(ctx.claimedMedia??(ctx.claimedMedia=new Set())).add(await realpath(path.join(ctx.shared,name)));emit(ctx,'files',await listFiles(ctx));return json(res,{ok:true,name,bytes:bytes.length});   // v0.10.2: 사용자가 올린 파일은 AI 결과로 붙이지 않는다
      }
      // ---- v0.10 푸시 알림 · 화면 보고 있음 신호 ----
      if(url.pathname==='/api/presence'){const a=await bodyJson(req);ctx.visibleUntil=a?.visible?Date.now()+PRESENCE_MS:0;return json(res,{ok:true});}
      if(url.pathname.startsWith('/api/push/')){
        const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
        if(url.pathname==='/api/push/subscribe'){const r=await push.subscribe(a.subscription,a.label);return json(res,r.error?{error:r.error}:push.status(a.subscription?.endpoint),r.error?400:200);}
        if(url.pathname==='/api/push/unsubscribe'){await push.unsubscribe(String(a.endpoint??''));return json(res,push.status());}
        if(url.pathname==='/api/push/prefs'){await push.setPrefs(a);return json(res,push.status(a.endpoint));}
        if(url.pathname==='/api/push/test'){const n=await push.notify('test',{title:'🔔 AI 오피스 알림 테스트',body:'이렇게 알려 드릴게요. 눌러서 방으로 가기',url:'/',tag:'test'});return json(res,{ok:true,sent:n});}
        return json(res,{error:'not_found'},404);
      }
      // ---- v0.9.2 구글 드라이브: 연결(기기 코드) · 해제 · 파일함 파일 올리기 ----
      if(url.pathname.startsWith('/api/gdrive/')){
        const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);
        try{
          if(url.pathname==='/api/gdrive/connect')return json(res,await gdrive.connect());
          if(url.pathname==='/api/gdrive/cancel'){gdrive.cancel();return json(res,gdrive.status());}
          if(url.pathname==='/api/gdrive/disconnect')return json(res,await gdrive.disconnect());
          if(url.pathname==='/api/gdrive/upload'){
            const name=safeName(a.name);const p=path.join(ctx.shared,name);
            const r=await gdrive.upload(p,name,(MIME[path.extname(name).toLowerCase()]??'application/octet-stream').split(';')[0]);
            return json(res,{ok:true,...r});
          }
        }catch(e){
          if(e.code==='ENOENT'||e.message==='file_not_found')return json(res,{error:'file_not_found'},404);
          console.error('gdrive',e.message,e.detail??'');
          const st={gdrive_not_configured:409,gdrive_not_connected:409,gdrive_reconnect_required:409,gdrive_file_too_large:413}[e.message]??502;
          return json(res,{error:e.message,...(e.max?{max:e.max}:{})},st);
        }
        return json(res,{error:'not_found'},404);
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
      // v0.10.5 방 비우기: AI 가 답하는 중이면 거절(먼저 긴급 중지). 대화 기록 삭제 + 모든 AI 새 대화. 파일함·메모리·사용량은 그대로.
      if(url.pathname==='/api/clear'){if(ctx.running.size||ctx.queue.length)return json(res,{error:'busy'},409);const n=ctx.store.clear(adapters.map(a=>a.id));await ctx.store.save();emit(ctx,'cleared',{clearedBefore:ctx.store.clearedBefore()});emit(ctx,'state',await statePayload(ctx));return json(res,{ok:true,removed:n});}
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
      // v0.8.8 긴급 중지: 돌고 있는 AI 전부(팀장·팀원·일반 답변)와 대기열을 즉시 끊는다. 로그인 진행은 건드리지 않는다.
      if(url.pathname==='/api/storage/delete'){const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);const r=await janitor.deletePath(String(ctx.user?.id??'1'),String(a.path??''));if(r.error)return json(res,r,r.error==='not_found'?404:r.error==='not_deletable'?403:400);emit(ctx,'files',await listFiles(ctx));return json(res,{...r,...(await janitor.info())});}   // v0.10.15 고른 항목 지우기
      if(url.pathname==='/api/storage/purge'){const a=await bodyJson(req);if(!a)return json(res,{error:'invalid_json'},400);const days=Number(a.days);if(!Number.isFinite(days)||days<0||days>3650)return json(res,{error:'days_invalid'},400);const r=await janitor.purgeOld(String(ctx.user?.id??'1'),{days,dryRun:!!a.dryRun});if(r.error)return json(res,r,400);if(!a.dryRun)emit(ctx,'files',await listFiles(ctx));return json(res,{...r,...(await janitor.info())});}   // v0.10.16 N일 지난 자료 지우기(미리보기 dryRun)
      if(url.pathname==='/api/storage/cleanup'){const r=await janitor.run('manual');return json(res,{ok:!!r,result:r,...(await janitor.info())});}   // v0.9.0 지금 정리 (규칙은 자동 정리와 같다)
      if(url.pathname==='/api/stop'){const stopped=haltRuns(ctx);console.log(`긴급 중지: 실행 ${stopped}건 끊음`);return json(res,{ok:true,stopped});}
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
// v0.10.18 AI 빌딩 보고 (src/building.mjs): BUILDING_URL + BUILDING_REPORT_KEY 가 있을 때만. 버전·디스크·오류 수·작업 수와 작업 목록·결정 질문(v0.10.19)을 5분마다(BUILDING_INTERVAL_SEC) 보낸다.
if(process.env.BUILDING_URL&&process.env.BUILDING_REPORT_KEY){
  const version=JSON.parse(await readFile(new URL('package.json',root),'utf8')).version;
  startBuildingReporter({url:process.env.BUILDING_URL,key:process.env.BUILDING_REPORT_KEY,version,intervalSec:Number(process.env.BUILDING_INTERVAL_SEC||300)||300,
    getDisk:async()=>(await janitor.info()).usage,getWork:()=>workDetail(contexts.values().next().value,{label:labelOf}),errors:buildingErrors});
}else console.log('AI 빌딩 보고: 꺼짐 (BUILDING_URL·BUILDING_REPORT_KEY 없음)');
