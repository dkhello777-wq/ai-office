// 어댑터 = "CLI 하나를 질문→답변 함수로 감싼 것".
// 새 AI 추가: config/adapters.json 에 항목 추가 + 필요하면 PARSERS 에 파서 하나 추가.
import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const ROOT=new URL('../../',import.meta.url).pathname.replace(/\/$/,'');
export async function loadConfig(p=new URL('../../config/adapters.json',import.meta.url)){
  return JSON.parse(await readFile(p,'utf8'));
}
const sha256=b=>createHash('sha256').update(b).digest('hex');

// 각 CLI의 출력에서 {text, session} 을 뽑는 파서들. 원문은 절대 자르지 않는다.
export const PARSERS={
  'claude-json'(stdout){
    let data;
    try{data=JSON.parse(stdout);}
    catch(e){   // --output-format stream-json: 한 줄에 이벤트 하나, 마지막 {"type":"result",...} 가 최종 답변
      let result=null;
      for(const line of stdout.split('\n')){const t=line.trim();if(!t.startsWith('{'))continue;let ev;try{ev=JSON.parse(t);}catch{continue;}if(ev&&ev.type==='result')result=ev;}
      if(!result)throw e;
      data=result;
    }
    return {text:data.result??'',session:data.session_id??null,usage:data.usage??null,raw:data};
  },
  'codex-jsonl'(stdout){
    // codex exec --json: 한 줄에 이벤트 하나. 마지막 assistant/agent 메시지를 답변으로 본다.
    let text='',session=null,usage=null;const events=[];
    for(const line of stdout.split('\n')){
      const t=line.trim();if(!t.startsWith('{'))continue;
      let e;try{e=JSON.parse(t);}catch{continue;}
      events.push(e);
      session=e.thread_id??e.session_id??e.conversation_id??session;
      const item=e.item??e.msg??e;
      const type=item?.type??e.type??'';
      if(/agent_message|assistant|message/.test(type)&&typeof (item.text??item.content??item.message)==='string')text=item.text??item.content??item.message;
      // turn.completed 등의 usage 를 보존 (GPT R02 / Gemini FAIL2). 원문 객체 그대로 — 정규화는 store.normalizeUsage 가 한다 (cached_input 은 input_tokens 에 이미 포함되므로 더하지 않음).
      if(e.usage&&typeof e.usage==='object')usage=e.usage;else if(item?.usage&&typeof item.usage==='object')usage=item.usage;
    }
    if(!text&&!events.length)text=stdout.trim(); // --json 미지원 버전: 평문 그대로
    return {text,session,usage,raw:events};
  },
  'gemini-json'(stdout){
    let data;try{data=JSON.parse(stdout);}catch{return {text:stdout.trim(),session:null,usage:null,raw:null};}
    // v0.8: -o json 의 stats.models[모델].tokens{prompt,candidates,thoughts,...} 를 모델 합산으로 정규화(문서 기준, 실배포에서 확인). 모양이 다르면 stats 원문을 그대로 넘겨 normalizeUsage 가 아는 키만 쓴다.
    let usage=data.stats??null;
    const models=usage?.models;
    if(models&&typeof models==='object'){let input=0,output=0,seen=false;for(const m of Object.values(models)){const t=m?.tokens;if(!t||typeof t!=='object')continue;seen=true;input+=Number(t.prompt)||0;output+=(Number(t.candidates)||0)+(Number(t.thoughts)||0);}if(seen)usage={input,output,raw:models};}
    return {text:data.response??data.result??data.text??'',session:data.session_id??data.sessionId??null,usage,raw:data};
  },
  // v0.8.2 Antigravity CLI(agy) --output-format stream-json: 한 줄에 이벤트 하나, 마지막 {"event":"result"} 가 최종. status 가 SUCCESS 가 아니면 실패로 던진다(agy 는 그때 exit 3 을 내지만 방어).
  'agy-stream-json'(stdout){
    let result=null;
    for(const line of stdout.split('\n')){const t=line.trim();if(!t.startsWith('{'))continue;let ev;try{ev=JSON.parse(t);}catch{continue;}if(ev&&ev.event==='result'&&ev.result&&typeof ev.result==='object')result=ev.result;}
    if(!result)throw new Error('agy_result_missing');
    if(result.status!=='SUCCESS')throw new Error('agy_status_'+String(result.status??'unknown').toLowerCase());
    const u=result.usage&&typeof result.usage==='object'?result.usage:null;
    const usage=u?{input:(Number(u.input_tokens)||0)+(Number(u.cache_read_tokens)||0),output:(Number(u.output_tokens)||0)+(Number(u.thinking_tokens)||0),raw:u}:null;
    return {text:typeof result.response==='string'?result.response:'',session:result.conversation_id||null,usage,raw:result};
  },
  'mock-json'(stdout){const d=JSON.parse(stdout);return {text:d.text,session:d.session,usage:d.usage??null,raw:d};},
  'plain'(stdout){return {text:stdout.trim(),session:null,usage:null,raw:null};}
};

const fill=(args,vars)=>args.map(a=>a.replace(/\{(\w+)\}/g,(_,k)=>vars[k]??''));
// v0.8.2: stdin 으로 넘기는 프롬프트의 포장. 'text'(기본) 는 그대로, 'agy-stream-json' 은 agy --input-format stream-json 이 읽는 NDJSON 한 줄 (Linux 1.4.2 검증: {"event":"user","message":{"role":"user","content":...}}).
export const STDIN_WRAPS={text:p=>p,'agy-stream-json':p=>JSON.stringify({event:'user',message:{role:'user',content:p}})+'\n'};

// ---- v0.5 스트리밍(부분 출력): 아직 끝나지 않은 stdout 에서 "지금까지의 답변 본문"을 뽑는 파서. 없는 형식은 null → 화면은 진행 표시만. ----
// 최종 답변은 여전히 PARSERS 가 종료 후 전체 stdout 으로 확정한다. 부분 텍스트는 화면 표시용이며 저장·증거에는 쓰지 않는다.
export const STREAM_PARSERS={
  // codex exec --json / claude stream-json: 한 줄에 이벤트 하나. 지금까지 본 마지막 메시지 텍스트, 또는 delta 누적.
  'jsonl'(partial){
    let text='',delta='';
    for(const line of partial.split('\n')){
      const t=line.trim();if(!t.startsWith('{'))continue;
      let e;try{e=JSON.parse(t);}catch{continue;}
      const item=e.item??e.msg??e.event??e;
      if(typeof e.delta==='string')delta+=e.delta;
      else if(typeof item?.delta?.text==='string')delta+=item.delta.text;
      else if(typeof item?.text==='string'&&/message|assistant/.test(item.type??e.type??''))text=item.text;
      else if(typeof e.result==='string')text=e.result;
    }
    return text||delta||null;
  },
  'mock-stream'(partial){const m=partial.match(/"text":"((?:[^"\\]|\\.)*)/);if(!m)return null;try{return JSON.parse('"'+m[1]+'"');}catch{return m[1];}}
};
// ---- 자식 프로세스 종료: 프로세스 그룹 단위 (GPT R07). ----
// 비-Windows 에서는 detached 로 띄워 자식이 자기 그룹의 리더가 되게 하고, 종료는 kill(-pid) 로 그룹 전체에 보낸다.
// SIGTERM 3초 뒤 SIGKILL. 'exit' 뒤에도 손자가 파이프를 잡고 있어 'close' 가 안 오면 파이프를 끊어 close 를 강제한다.
const GROUP=process.platform!=='win32';
const live=new Set();      // 직접 자식이 아직 close 되지 않은 것들
const pending=new Map();   // 종료 요청됐지만 아직 SIGKILL 을 보내지 않은 그룹: child → {timer, deadline} (직접 자식이 close 돼도 남는다 — GPT G02)
export function spawnChild(command,args,opts){
  const child=spawn(command,args,{...opts,detached:GROUP});
  live.add(child);
  // 검수 V12: 직접 자식이 정상 종료해도 같은 그룹의 손자가 남을 수 있다. 한 번 실행하는 CLI 에서 자식보다 오래 살 정당한 프로세스는 없으므로, close 뒤 잠시 후 그룹 전체에 SIGKILL (없으면 ESRCH, 무해).
  child.once('close',()=>{live.delete(child);if(pending.has(child))return;   // 재검수 V25: SIGTERM 뒤 유예 중이면 예약된 SIGKILL 시점을 지킨다 (손자의 정리 시간 보장)
    if(GROUP&&child.pid&&!child._killed){try{process.kill(-child.pid,'SIGKILL');}catch{}}});
  // exit 뒤 500ms 안에 close 가 없으면(손자가 stdout 을 잡고 있음) 파이프를 끊는다
  child.once('exit',()=>{const t=setTimeout(()=>{for(const st of [child.stdout,child.stderr])try{st?.destroy();}catch{}},500);t.unref?.();child.once('close',()=>clearTimeout(t));});
  return child;
}
function signalTree(child,sig){
  if(GROUP&&child.pid){try{process.kill(-child.pid,sig);return;}catch{}}
  try{child.kill(sig);}catch{}
}
// 직접 자식의 close 는 그룹 전체의 종료가 아니다 (GPT F02): 유예가 지나면 자식이 이미 끝났어도 그룹에 SIGKILL 을 보낸다(없으면 ESRCH, 무해).
// 같은 자식에 더 짧은 유예로 다시 요청하면 마감을 앞당긴다 (GPT G02: 서버 종료 시 1초로 단축).
function killNow(child){const p=pending.get(child);if(p)clearTimeout(p.timer);pending.delete(child);child._killed=true;signalTree(child,"SIGKILL");}
export function terminateChild(child,graceMs=3000){
  const deadline=Date.now()+graceMs;
  const cur=pending.get(child);
  if(cur){if(deadline<cur.deadline){clearTimeout(cur.timer);const timer=setTimeout(()=>killNow(child),graceMs);timer.unref?.();pending.set(child,{timer,deadline});}return;}
  if(child._killed)return;
  signalTree(child,'SIGTERM');
  const timer=setTimeout(()=>killNow(child),graceMs);timer.unref?.();
  pending.set(child,{timer,deadline});
}
// 서버 종료: 이미 종료 대기 중인 그룹은 즉시 SIGKILL, 살아 있는 자식은 SIGTERM 뒤 graceMs 안에 SIGKILL. 전부 보낸 뒤에 resolve 한다.
export function terminateAll(graceMs=1000){
  for(const child of [...pending.keys()])killNow(child);
  for(const child of live)terminateChild(child,graceMs);
  return new Promise(r=>setTimeout(()=>{for(const child of [...pending.keys()])killNow(child);for(const child of live)signalTree(child,'SIGKILL');r();},graceMs+100));
}
export const shutdown=async(code=0)=>{await terminateAll(1000);process.exit(code);};
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{shutdown(0);});

// ---- F2: 자식 CLI 환경은 허용 목록만. 부모 셸의 API 키·대체 endpoint·인증 전환 설정은 넘기지 않는다. ----
// 기본 허용: 실행에 필요한 비민감 변수. 어댑터별 envAllow 로 추가(예: CLAUDE_CONFIG_DIR).
export const ENV_ALLOW_DEFAULT=['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','LC_CTYPE','TERM','TMPDIR','TMP','TEMP','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','SYSTEMROOT','SystemRoot','COMSPEC','APPDATA','LOCALAPPDATA','USERPROFILE','PATHEXT','ProgramData'];
// 어떤 어댑터에도 절대 넘기지 않는 이름(패턴). 허용 목록에 있어도 차단.
export const ENV_DENY_PATTERNS=[/API_KEY$/i,/_TOKEN$/i,/SECRET/i,/PASSWORD/i,/BASE_URL$/i,/_ENDPOINT$/i,/^ANTHROPIC_/i,/^OPENAI_/i,/^GEMINI_/i,/^GOOGLE_/i,/^CLAUDE_CODE_USE_/i,/^CLAUDE_CODE_OAUTH/i,/^AWS_/i,/^AZURE_/i,/^GOOGLE_APPLICATION_CREDENTIALS$/i];
// extraEnv: 사용자별 격리 값(HOME, CLAUDE_CONFIG_DIR, CODEX_HOME 등). 허용 목록 뒤에 덮어쓰되 차단 패턴은 그대로 적용한다.
export function buildChildEnv(parentEnv,adapter,extraEnv={}){
  const allow=new Set([...ENV_ALLOW_DEFAULT,...(adapter.envAllow??[])]);
  const env={};const blocked=[];
  for(const [k,v] of Object.entries(parentEnv)){
    if(!allow.has(k))continue;
    if(ENV_DENY_PATTERNS.some(p=>p.test(k))){blocked.push(k);continue;}
    env[k]=v;
  }
  for(const [k,v] of Object.entries(extraEnv)){if(ENV_DENY_PATTERNS.some(p=>p.test(k))){blocked.push(k);continue;}env[k]=v;}
  // 부모 환경에 provider 키/endpoint 형태의 변수가 있으면 이름만 기록(값은 절대 기록 안 함). 넘기지 않는다.
  const present=Object.keys(parentEnv).filter(k=>ENV_DENY_PATTERNS.some(p=>p.test(k)));
  return {env,blockedNames:[...new Set([...blocked,...present])].sort()};
}

// ---- F4: 스트림 단위 UTF-8 디코딩 + 원시 바이트 보존 ----
function collector(){
  const chunks=[];const decoder=new TextDecoder('utf-8');let text='';
  return {
    push(buf,onText){chunks.push(buf);const s=decoder.decode(buf,{stream:true});text+=s;if(s&&onText)onText(s);},
    finish(){text+=decoder.decode();return {text,bytes:Buffer.concat(chunks)};}
  };
}

// ---- F1: 실행 증거(원문 전체)를 로컬에 보존. 상태 JSON 에는 경로·길이·해시·종료 정보만 넣는다. ----
// 증거 폴더 0700, 파일 0600 (umask 와 무관하게 chmod 로 강제). 원문·원본 예외 메시지는 여기(로컬)에만 남고,
// 호출자에게 돌아가는 summary 에는 경로·바이트·해시·종료 정보·고정 오류 코드만 들어간다.
export async function writeEvidence(dir,{stdoutBytes,stderrBytes,meta,privateMeta={}}){
  await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);
  for(const [name,bytes] of [['stdout.bin',stdoutBytes],['stderr.bin',stderrBytes]]){const f=path.join(dir,name);await writeFile(f,bytes,{mode:0o600});await chmod(f,0o600);}
  const summary={...meta,stdoutBytes:stdoutBytes.length,stdoutSha256:sha256(stdoutBytes),stderrBytes:stderrBytes.length,stderrSha256:sha256(stderrBytes),dir};
  const f=path.join(dir,'meta.json');await writeFile(f,JSON.stringify({...summary,...privateMeta},null,1),{mode:0o600});await chmod(f,0o600);
  // 기록 후 권한 재확인: 하나라도 열려 있으면 실패로 취급
  for(const name of ['stdout.bin','stderr.bin','meta.json']){const st=await stat(path.join(dir,name));if((st.mode&0o077)!==0)throw new Error('evidence_mode_not_private:'+name);}
  if(((await stat(dir)).mode&0o077)!==0)throw new Error('evidence_dir_not_private');
  return summary;
}

// CLI 실행. 프롬프트는 stdin 으로 통째로 전달(기본), cwd 는 공유 작업 폴더.
// evidenceDir 를 주면 stdout/stderr 원문 전체와 종료 정보를 그 폴더에 보존한다.
// 세션 재개: resumeMode 'append'(기본) 는 args 뒤에 resumeArgs 를 붙이고, 'replace' 는 resumeArgs 가 명령 전체를 대신한다
// (GPT R03: codex 는 `exec resume <ID>` 서브커맨드라 append 로는 만들 수 없음).
export function buildArgs(adapter,{prompt,session}){
  const viaStdin=(adapter.promptVia??'stdin')==='stdin';
  const vars={prompt:viaStdin?'':prompt,session,root:ROOT};
  const resume=session&&adapter.resumeArgs?.length;
  const args=resume&&adapter.resumeMode==='replace'?fill(adapter.resumeArgs,vars):[...fill(adapter.args,vars),...(resume?fill(adapter.resumeArgs,vars):[])];
  return args.filter(a=>!(viaStdin&&a===''));
}
export function runAdapter(adapter,{prompt,cwd,session=null,timeoutMs=900000,onChunk=()=>{},evidenceDir=null,parentEnv=process.env,extraEnv={},signal=null}){
  return new Promise((resolve,reject)=>{
    const viaStdin=(adapter.promptVia??'stdin')==='stdin';
    const args=buildArgs(adapter,{prompt,session});
    const {env,blockedNames}=buildChildEnv(parentEnv,adapter,extraEnv);
    const startedAt=Date.now();
    if(signal?.aborted)return reject(Object.assign(new Error('cancelled'),{cancelled:true,envBlockedNames:blockedNames}));
    let child;
    try{child=spawnChild(adapter.command,args,{cwd,env,stdio:[viaStdin?'pipe':'ignore','pipe','pipe']});}
    catch(e){return reject(Object.assign(new Error('spawn_failed'),{cause:e}));}
    if(viaStdin){child.stdin.on('error',()=>{});child.stdin.end((STDIN_WRAPS[adapter.stdinFormat??'text']??STDIN_WRAPS.text)(prompt));}
    const out=collector(),err=collector();let timedOut=false,cancelled=false;
    const timer=setTimeout(()=>{timedOut=true;terminateChild(child);},timeoutMs);
    const onAbort=()=>{cancelled=true;terminateChild(child,1000);};   // 계정 중지 등 외부 취소 (GPT R08)
    signal?.addEventListener('abort',onAbort,{once:true});
    // 스트리밍: 어댑터에 stream 파서가 있으면 청크마다 "지금까지의 본문"을 onChunk 로 알린다 (없으면 원시 청크 문자열만)
    const streamParser=adapter.stream&&STREAM_PARSERS[adapter.stream]?STREAM_PARSERS[adapter.stream]:null;
    let seen='';
    child.stdout.on('data',d=>out.push(d,s=>{seen+=s;let partial=null;if(streamParser){try{partial=streamParser(seen);}catch{partial=null;}}onChunk(s,{partial,bytes:Buffer.byteLength(seen),elapsedMs:Date.now()-startedAt});}));
    child.stderr.on('data',d=>err.push(d));
    const finish=async(code,sig)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      const elapsedMs=Date.now()-startedAt;const signal_=sig;
      const o=out.finish(),e=err.finish();
      let parsed=null,parseError=null;   // parseError(원본 예외 문자열)는 로컬 meta.json 에만 기록한다 (R4)
      if(code===0){try{parsed=(PARSERS[adapter.parse]??PARSERS.plain)(o.text);}catch(x){parseError=x.message;}}
      const meta={adapter:adapter.id,command:adapter.command,args,exitCode:code,signal:signal_,timedOut,cancelled,parseFailed:parseError!==null,elapsedMs,startedAt:new Date(startedAt).toISOString(),envBlockedNames:blockedNames};
      let evidence=null,evidenceError=null;
      if(evidenceDir){try{evidence=await writeEvidence(evidenceDir,{stdoutBytes:o.bytes,stderrBytes:e.bytes,meta,privateMeta:{parseError}});}catch(x){evidenceError=x.message.startsWith('evidence_')?x.message.split(':')[0]:'evidence_write_failed';}}
      const base={stdout:o.text,stderr:e.text,exitCode:code,signal:signal_,timedOut,cancelled,elapsedMs,evidence,evidenceError,envBlockedNames:blockedNames};
      // R3: 증거 보존이 요구된 실행에서 보존이 실패하면 성공으로 확정하지 않는다. 답변 본문은 메모리 결과로 돌려주되 오류로 표시.
      if(evidenceDir&&evidenceError)return reject(Object.assign(new Error(evidenceError),{...base,...(parsed??{})}));
      if(cancelled)return reject(Object.assign(new Error('cancelled'),base));
      if(timedOut)return reject(Object.assign(new Error('cli_timeout'),{...base,partialText:parsed?.text??null}));   // 검수 V11: SIGTERM 을 받고 exit 0 으로 끝내도 시간 초과는 성공이 아니다
      if(code!==0)return reject(Object.assign(new Error('cli_exit_'+(code??signal_)),base));
      if(parseError)return reject(Object.assign(new Error('parse_failed'),{...base,parseFailed:true}));
      resolve({...parsed,...base});
    };
    child.on('error',x=>{clearTimeout(timer);reject(Object.assign(new Error(x.code==='ENOENT'?'cli_not_found':'spawn_failed'),{cause:x,stderr:err.finish().text,envBlockedNames:blockedNames}));});
    child.on('close',(code,signal)=>{finish(code,signal).catch(reject);});
  });
}

// 설치 점검 (doctor). 실제 질문은 보내지 않는다. 로그인 여부는 checkAuth 가 따로 본다.
export function probeAdapter(adapter,parentEnv=process.env,extraEnv={}){
  return new Promise(resolve=>{
    const {env}=buildChildEnv(parentEnv,adapter,extraEnv);
    let child;
    try{child=spawnChild(adapter.command,adapter.versionArgs??['--version'],{env,stdio:['ignore','pipe','pipe']});}
    catch{return resolve({id:adapter.id,installed:false});}
    const out=collector();child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>out.push(d));
    child.on('error',()=>resolve({id:adapter.id,installed:false}));
    child.on('close',code=>resolve({id:adapter.id,installed:code===0,version:out.finish().text.trim().split('\n')[0]}));
  });
}

// ---- F2/R1: 인증 종류 확인. 공식 CLI 의 비밀값 없는 상태 명령 stdout 을 **구조화 파서**로 판정한다. ----
// 결과 필드는 허용된 것만: {state, reason, authMethod?, apiProvider?, subscriptionType?, exitCode}. 원문 출력은 돌려주지 않는다.
// state: 'subscription' | 'api_key' | 'third_party' | 'not_logged_in' | 'unverified'. subscription 만 호출 허용.
export const AUTH_PARSERS={
  // Claude Code `claude auth status` (JSON). 허용: loggedIn=true, authMethod='claude.ai', apiProvider='firstParty', subscriptionType 문자열.
  // 차단: api_key, api_key_helper, third_party, oauth_token(불명확한 OAuth), 알 수 없는 값/필드 형식.
  'claude-json'(stdout){
    let d;try{d=JSON.parse(stdout);}catch{return {state:'unverified',reason:'malformed_json'};}
    if(!d||typeof d!=='object'||Array.isArray(d))return {state:'unverified',reason:'unexpected_shape'};
    const fields={authMethod:typeof d.authMethod==='string'?d.authMethod:null,apiProvider:typeof d.apiProvider==='string'?d.apiProvider:null,subscriptionType:typeof d.subscriptionType==='string'?d.subscriptionType:null};
    if(d.loggedIn===false)return {state:'not_logged_in',reason:'logged_in_false',...fields};
    if(d.loggedIn!==true)return {state:'unverified',reason:'logged_in_missing',...fields};
    if(['api_key','api_key_helper'].includes(fields.authMethod))return {state:'api_key',reason:'auth_method_'+fields.authMethod,...fields};
    if(fields.authMethod==='third_party'||(fields.apiProvider&&fields.apiProvider!=='firstParty'))return {state:'third_party',reason:'provider_'+(fields.apiProvider??'unknown'),...fields};
    if(fields.authMethod!=='claude.ai')return {state:'unverified',reason:'auth_method_'+(fields.authMethod??'missing'),...fields};
    if(fields.apiProvider!=='firstParty')return {state:'unverified',reason:'api_provider_'+(fields.apiProvider??'missing'),...fields};
    if(!fields.subscriptionType)return {state:'unverified',reason:'subscription_type_missing',...fields};
    return {state:'subscription',reason:'claude_ai_first_party_subscription',...fields};
  },
  // Codex CLI `codex login status` (텍스트). 행 단위 앵커 매칭. 출력 형식은 설치본에서 검증 필요.
  'codex-text'(stdout){
    const lines=stdout.split('\n').map(l=>l.trim()).filter(Boolean);
    if(lines.some(l=>/^Logged in using ChatGPT\b/i.test(l)))return {state:'subscription',reason:'chatgpt_login_line',authMethod:'chatgpt'};
    if(lines.some(l=>/^Logged in using an? API key\b/i.test(l)||/\bAPI key\b/i.test(l)))return {state:'api_key',reason:'api_key_line',authMethod:'api_key'};
    if(lines.some(l=>/^Not logged in\b/i.test(l)))return {state:'not_logged_in',reason:'not_logged_in_line'};
    return {state:'unverified',reason:lines.length?'unrecognized_output':'empty_output'};
  },
  // v0.8.2 Antigravity CLI: src/adapters/agy-auth-status.mjs 의 JSON {loggedIn, mode}. mode 'account'(Google 계정 로그인) 만 허용, 'gemini-api-key'(settings.json modelProvider=gemini) 는 차단, 'adc' 는 서드파티.
  'agy-json'(stdout){
    let d;try{d=JSON.parse(stdout);}catch{return {state:'unverified',reason:'malformed_json'};}
    if(!d||typeof d!=='object'||Array.isArray(d))return {state:'unverified',reason:'unexpected_shape'};
    const mode=typeof d.mode==='string'?d.mode:null;
    if(mode==='gemini-api-key')return {state:'api_key',reason:'model_provider_gemini_api_key',authMethod:mode};
    if(mode&&mode!=='account')return {state:'third_party',reason:'mode_'+mode,authMethod:mode};
    if(d.loggedIn===false)return {state:'not_logged_in',reason:typeof d.reason==='string'?d.reason.slice(0,40):'logged_in_false',authMethod:mode};
    if(d.loggedIn!==true)return {state:'unverified',reason:'logged_in_missing',authMethod:mode};
    return {state:'subscription',reason:'google_account_antigravity',authMethod:'account',apiProvider:'google',subscriptionType:typeof d.tier==='string'?d.tier:'google-account'};
  },
  // 테스트용 모의 CLI: Claude 와 같은 JSON 형식
  'mock-json'(stdout){return AUTH_PARSERS['claude-json'](stdout);}
};
// 어떤 스트림을 판정에 쓰는지는 파서별로 정한다 (GPT R01: codex 0.158 의 `login status` 는 "Logged in using ChatGPT" 를 stderr 로 낸다).
// JSON 파서(claude)는 stdout 만 — stderr 경고가 섞이면 JSON 이 깨지므로 합치지 않는다. 텍스트 행 파서(codex)는 stdout 다음 stderr 를 이어 붙여 본다.
// 어댑터 authCheck.output 으로 덮어쓸 수 있다: 'stdout' | 'stderr' | 'both'.
export const AUTH_PARSER_STREAMS={'claude-json':'stdout','codex-text':'both','agy-json':'stdout','mock-json':'stdout'};
export function checkAuth(adapter,parentEnv=process.env,extraEnv={},signal=null,cwd=undefined){   // cwd: 실행과 같은 작업 폴더를 주면 프로젝트 설정(.claude/settings.json 등)까지 같은 조건으로 판정 (검수 V09)
  const check=adapter.authCheck;
  if(!check||!Array.isArray(check.args)||!AUTH_PARSERS[check.parser])return Promise.resolve({id:adapter.id,state:'unverified',reason:'no_auth_check_configured'});
  const streams=check.output??AUTH_PARSER_STREAMS[check.parser]??'stdout';
  return new Promise(resolve=>{
    const {env}=buildChildEnv(parentEnv,adapter,extraEnv);
    let child;
    try{child=spawnChild(check.command??adapter.command,fill(check.args,{root:ROOT}),{env,cwd,stdio:['ignore','pipe','pipe']});}   // v0.8: command 를 덮어쓸 수 있다 (Gemini 는 상태 명령이 없어 허브의 node 스크립트가 파일을 읽어 판정)
    catch{return resolve({id:adapter.id,state:'unverified',reason:'spawn_failed'});}
    const out=collector(),err=collector();
    child.stdout.on('data',d=>out.push(d));child.stderr.on('data',d=>err.push(d));
    const timer=setTimeout(()=>terminateChild(child),check.timeoutMs??15000);
    let aborted=false;const onAbort=()=>{aborted=true;terminateChild(child,1000);};signal?.addEventListener('abort',onAbort,{once:true});
    child.on('error',()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);resolve({id:adapter.id,state:'unverified',reason:'spawn_failed'});});
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
      const o=out.finish(),e=err.finish();
      if(aborted)return resolve({id:adapter.id,state:'unverified',reason:'cancelled',exitCode:code});
      const text=streams==='stderr'?e.text:streams==='both'?o.text+'\n'+e.text:o.text;
      // 종료 코드가 0 이 아니어도 출력이 "미로그인"을 분명히 말하면 그대로 판정한다 (Codex 0.163 `login status` 는 Not logged in 을 내고 exit 1 — Linux 검증). 그 외 비정상 종료는 unverified.
      if(code!==0){let r=null;try{r=AUTH_PARSERS[check.parser](text);}catch{}if(r?.state==='not_logged_in')return resolve({id:adapter.id,...r,exitCode:code,stderrBytes:e.bytes.length,judgedFrom:streams});return resolve({id:adapter.id,state:'unverified',reason:'exit_'+code,exitCode:code,stderrBytes:e.bytes.length});}
      const r=AUTH_PARSERS[check.parser](text);
      resolve({id:adapter.id,...r,exitCode:code,stderrBytes:e.bytes.length,judgedFrom:streams});
    });
  });
}

// ---- v0.4: 화면 안에서 CLI 로그인. 공식 로그인 명령을 사용자별 환경(HOME 등)으로 띄우고, 출력에서 URL·일회용 코드만 뽑아 화면에 보낸다. ----
// 사용자가 화면에서 입력한 텍스트(예: 붙여넣을 인증 코드)는 stdin 으로 전달한다. 원문 출력 전체는 사용자 폴더의 증거 파일(0600)에만 남는다.
const URL_RE=/https?:\/\/[^\s'"<>)\]]+/g;
const CODE_RE=/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/g;
// 검수 V10: URL 의 #프래그먼트는 통째로 버린다(implicit flow 토큰이 실리는 자리). 쿼리에 access/refresh/id 토큰 키가 있으면 그 URL 은 화면에 안 보낸다.
// OAuth authorize URL 의 code_challenge·state 같은 정상 파라미터는 로그인에 필요하므로 그대로 둔다.
const TOKEN_QUERY_RE=/[?&](access_token|refresh_token|id_token|token|api_key|apikey|secret)=/i;
export function sanitizeLoginUrl(u){const noFrag=u.split('#')[0];if(TOKEN_QUERY_RE.test(noFrag))return null;return noFrag;}
// V28 (실배포에서 발견): Codex 는 URL 뒤에 ANSI 색상 코드(\x1b[0m 등)를 붙여 출력한다. 제거하지 않으면 URL 에 섞여 들어가 주소가 깨진다.
const ANSI_RE=/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export const stripAnsi=s=>String(s??'').replace(ANSI_RE,'');
export function extractLoginHints(raw){
  const text=stripAnsi(raw);
  // v0.8: 토큰 교환 endpoint(…/token) 는 사용자가 열 주소가 아니다(Gemini 가 코드 오류 뒤 로그에 남김). 코드가 틀려 새 URL 이 다시 나오면 최신 것이 앞에 오도록 역순.
  const urls=[...new Set((text.match(URL_RE)??[]).map(u=>sanitizeLoginUrl(u.replace(/[.,;]+$/,''))).filter(u=>u&&!/\/token\/?$/i.test(u.split('?')[0])))].reverse();
  const codes=[...new Set(text.match(CODE_RE)??[])];
  return {urls,codes};
}
// 진행 표시용 마지막 줄은 비밀값처럼 보이는 것을 가린 뒤에만 화면으로 보낸다 (검수 FAIL 4). 원문은 증거 파일에만.
// 가리는 것: key=value / key: value 꼴의 토큰·시크릿(access_token 처럼 밑줄이 붙은 이름 포함), Bearer, JWT, 32자 이상 난수 덩어리, URL 의 ?쿼리와 #프래그먼트.
export function maskLine(line){
  return stripAnsi(line)
    .replace(/\b([a-z0-9_-]*?(?:token|secret|password|passwd|api[_-]?key|authorization|cookie|session)[a-z0-9_-]*)\b(\s*[=:]\s*)(?:Bearer\s+)?\S+/gi,(_,k,sep)=>k+sep+'[가림]')
    .replace(/\bBearer\s+\S+/gi,'Bearer [가림]')
    .replace(/(https?:\/\/[^\s?#'"<>]+)([?#])[^\s'"<>]*/g,'$1$2[가림]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,'[가림]')
    .replace(/\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{32,}={0,2}\b/g,'[가림]');
}
export function startLogin(adapter,{cwd,parentEnv=process.env,extraEnv={},timeoutMs=600000,onEvent=()=>{},evidenceDir=null}){
  const login=adapter.login;
  if(!login||!Array.isArray(login.args))return null;
  const {env,blockedNames}=buildChildEnv(parentEnv,adapter,extraEnv);
  const args=fill(login.args,{root:ROOT});
  let child;
  try{child=spawnChild(login.command??adapter.command,args,{cwd,env,stdio:['pipe','pipe','pipe']});}   // v0.8: login.command 로 래퍼 실행 가능 (Gemini 는 pty 래퍼)
  catch(e){return {error:'spawn_failed'};}
  child.stdin.on('error',()=>{});
  const out=collector(),err=collector();let combined='';let timedOut=false;const startedAt=Date.now();
  const push=(c,d)=>{c.push(d,s=>{combined+=s;const h=extractLoginHints(combined);onEvent({status:'running',...h,lastLine:maskLine(combined.trimEnd().split('\n').at(-1)?.slice(0,300)??'')});});};
  child.stdout.on('data',d=>push(out,d));child.stderr.on('data',d=>push(err,d));
  const timer=setTimeout(()=>{timedOut=true;terminateChild(child);},timeoutMs);
  const done=new Promise(resolve=>{
    child.on('error',x=>{clearTimeout(timer);resolve({status:'error',error:x.code==='ENOENT'?'cli_not_found':'spawn_failed'});});
    child.on('close',async(code,signal)=>{
      clearTimeout(timer);
      const o=out.finish(),e=err.finish();
      let evidence=null,evidenceError=null;
      if(evidenceDir){try{evidence=await writeEvidence(evidenceDir,{stdoutBytes:o.bytes,stderrBytes:e.bytes,meta:{adapter:adapter.id,kind:'login',command:adapter.command,args,exitCode:code,signal,timedOut,elapsedMs:Date.now()-startedAt,envBlockedNames:blockedNames}});}catch(x){evidenceError='evidence_write_failed';}}
      const h=extractLoginHints(combined);
      // R3: 증거 저장 실패는 로그인에서도 성공이 아니다 (검수 FAIL 3)
      const errCode=evidenceDir&&evidenceError?evidenceError:timedOut?'login_timeout':code===0?null:'login_exit_'+(code??signal);   // 검수 V11: 시간 초과가 exit 0 보다 우선
      resolve({status:errCode===null?'done':'error',error:errCode,exitCode:code,signal,timedOut,evidence,evidenceError,...h});
    });
  });
  return {
    write(text){try{child.stdin.write(String(text).endsWith('\n')?String(text):String(text)+'\n');}catch{}},
    cancel(){terminateChild(child);},
    done
  };
}
