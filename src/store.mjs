// 대화 기록·세션·사용량 저장 (사용자별 state.json, 0600). 메시지 원문은 절대 자르지 않는다.
import {readFile,writeFile,mkdir,rename,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const sha256=s=>createHash('sha256').update(s).digest('hex');
export const monthKey=(d=new Date())=>d.toISOString().slice(0,7);   // 'YYYY-MM' (UTC)

// 각 CLI 의 usage 형식이 다르므로 한 가지 숫자로 정규화한다: {input, output}. 알 수 없는 형식은 0 으로 집계(원문은 메시지에 그대로 남음).
export function normalizeUsage(u){
  if(!u||typeof u!=='object')return {input:0,output:0};
  const n=v=>Number.isFinite(Number(v))&&Number(v)>0?Math.floor(Number(v)):0;   // 음수·소수 방어 (Gemini FAIL2)
  // 검수 V17: Claude 의 cache_read/cache_creation 은 input_tokens 와 별도 필드라 더해야 한다. Codex 의 cached_input_tokens 는 input_tokens 에 이미 포함되므로 더하지 않는다.
  const input=n(u.input??u.input_tokens??u.prompt_tokens??u.promptTokenCount??u.promptTokens)+n(u.cache_read_input_tokens)+n(u.cache_creation_input_tokens);
  const output=n(u.output??u.output_tokens??u.completion_tokens??u.candidatesTokenCount??u.outputTokens);
  return {input,output};
}

export class Store{
  constructor(path){this.path=path;this.state={messages:[],sessions:{},nextId:1,usage:{},epochs:{},seq:0};}
  // 검수 V19: 메시지마다 단조 증가 seq. 화면은 seq 가 큰 쪽만 받아들여 늦게 온 옛 스냅샷이 최신 상태를 되돌리지 못한다.
  bump(m){m.seq=++this.state.seq;return m;}
  // 파일 없음(ENOENT)만 "새 상태". 읽기 실패·JSON 손상은 던져서 빈 상태로 덮어쓰지 않는다 (GPT R05).
  async load(){
    let raw;try{raw=await readFile(this.path,'utf8');}catch(e){if(e.code==='ENOENT')return;throw Object.assign(new Error('state_unreadable'),{cause:e,file:String(this.path)});}
    let d;try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('state_corrupt'),{cause:e,file:String(this.path)});}
    // 필수: messages 배열, nextId 정수(모든 메시지 id 보다 큼). usage/epochs/sessions 는 후속 버전에서 추가된 선택 항목이라 없으면 기본값 (GPT F01).
    const bad=reason=>Object.assign(new Error('state_corrupt'),{file:String(this.path),reason});
    const isNat=v=>Number.isSafeInteger(v)&&v>=0,isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);
    if(!isObj(d)||!Array.isArray(d.messages)||!Number.isSafeInteger(d.nextId)||d.nextId<1)throw bad('schema');
    const ids=new Set();   // 메시지 id: 양의 안전한 정수, 유일, nextId 미만 (GPT G01c)
    for(const m of d.messages){if(!isObj(m)||!Number.isSafeInteger(m.id)||m.id<1||m.id>=d.nextId||ids.has(m.id))throw bad('message_id');ids.add(m.id);}
    for(const k of ['usage','epochs','sessions'])if(d[k]!==undefined&&!isObj(d[k]))throw bad(k);
    // 선택 항목은 "없음"(이전 버전)과 "있는데 손상"을 구분한다: 있으면 내부 값까지 검사 (GPT G01d)
    if(d.usage)for(const [month,byAdapter] of Object.entries(d.usage)){
      if(!/^\d{4}-\d{2}$/.test(month)||!isObj(byAdapter))throw bad('usage_month');
      for(const a of Object.values(byAdapter))if(!isObj(a)||!isNat(a.input)||!isNat(a.output)||!isNat(a.calls))throw bad('usage_value');
    }
    if(d.epochs)for(const v of Object.values(d.epochs))if(!isNat(v))throw bad('epochs');
    if(d.sessions)for(const v of Object.values(d.sessions))if(!(typeof v==='string'||v===null))throw bad('sessions');
    if(d.seq!==undefined&&!isNat(d.seq))throw bad('seq');
    this.state=d;if(!this.state.usage)this.state.usage={};if(!this.state.epochs)this.state.epochs={};if(!this.state.sessions)this.state.sessions={};if(!Number.isSafeInteger(this.state.seq))this.state.seq=Math.max(0,...this.state.messages.map(m=>Number.isSafeInteger(m.seq)?m.seq:0));
  }
  // 저장은 항상 직렬화: 동시에 두 AI가 끝나도 tmp→rename 이 겹치지 않는다. 한 번 실패해도 다음 저장은 이어간다 (검수 FAIL 8). 파일은 0600 (검수 FAIL 9).
  save(){
    const run=async()=>{
      await mkdir(new URL('.',this.path),{recursive:true,mode:0o700});
      const tmp=new URL(this.path.href+'.tmp');
      await writeFile(tmp,JSON.stringify(this.state),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,this.path);
    };
    this._chain=(this._chain??Promise.resolve()).then(run,run);
    return this._chain;
  }
  add(message){const m={id:this.state.nextId++,at:new Date().toISOString(),...message};if(typeof m.text==='string')m.hash=sha256(m.text);this.state.messages.push(m);return this.bump(m);}
  update(id,patch){const m=this.state.messages.find(x=>x.id===id);if(m){Object.assign(m,patch);this.bump(m);}return m;}
  get(id){return this.state.messages.find(x=>x.id===id)??null;}
  session(adapterId){return this.state.sessions[adapterId]??null;}
  // 세대(epoch): "새 대화" 뒤에 늦게 끝난 이전 실행이 옛 세션을 되살리지 못하게 한다 (GPT R09). 시작 때 epoch 를 받아 두고 같은 세대일 때만 저장.
  epoch(adapterId){return this.state.epochs[adapterId]??0;}
  setSession(adapterId,session,epoch=null){if(!session)return false;if(epoch!==null&&epoch!==this.epoch(adapterId))return false;this.state.sessions[adapterId]=session;return true;}
  resetSession(adapterId){delete this.state.sessions[adapterId];this.state.epochs[adapterId]=this.epoch(adapterId)+1;}

  // ---- v0.5 토큰 예산: 월별·AI별 누적 (벤치마킹: 에이전트별 예산) ----
  addUsage(adapterId,usage,month=monthKey()){
    const {input,output}=normalizeUsage(usage);
    const m=this.state.usage[month]??(this.state.usage[month]={});
    const a=m[adapterId]??(m[adapterId]={input:0,output:0,calls:0});
    a.input+=input;a.output+=output;a.calls+=1;
    return a;
  }
  usageFor(month=monthKey()){
    const m=this.state.usage[month]??{};
    const total=Object.values(m).reduce((s,a)=>({input:s.input+a.input,output:s.output+a.output,calls:s.calls+a.calls}),{input:0,output:0,calls:0});
    return {month,byAdapter:m,total,tokens:total.input+total.output};
  }
}
