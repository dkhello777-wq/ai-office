// 1인용 계정 (v0.7): 이 서버의 주인 한 명. 비밀번호는 scrypt 해시만 저장, 세션은 토큰 해시만 저장.
// 파일: data/owner.json (0600), data/sessions.json (0600). 모든 쓰기는 tmp→rename, 직렬화.
// 최초 설정: 화면의 "비밀번호 설정"(/api/setup) 또는 환경변수 HUB_PASSWORD (서버 첫 시작 때 한 번 읽어 해시로 저장).
// v0.7.1 (검수 V02·V03·V16): owner.json 은 "없음" 아니면 "완전히 유효함" 둘 중 하나 — 빈 값·깨진 값은 손상으로 거부(fail-closed).
//   비밀번호와 authVersion 을 한 파일에 한 번에 커밋하고, 세션은 발급 당시 authVersion 을 품는다 → 세션 파일 정리가 실패해도 옛 세션은 되살아나지 않는다.
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
const scrypt=promisify(scryptCb);

export const PASSWORD_MIN=10;
export const PASSWORD_MAX=256;   // 검수 V06: 상한 없는 비밀번호는 scrypt 입력을 키운다
const SESSION_TTL_MS=30*24*3600*1000;
const SALT_BYTES=16,HASH_BYTES=64;
const sha256=s=>createHash('sha256').update(s).digest('hex');
const isDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const notExpired=v=>isDate(v)&&Date.parse(v)>=Date.now();
const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&x.length>0&&timingSafeEqual(x,y);};
const b64Len=(s,n)=>{if(typeof s!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(s))return false;try{return Buffer.from(s,'base64').length===n;}catch{return false;}};
// 월 토큰 상한: 0 이상의 안전한 정수만 (검수 V16: 1e100 같은 값은 저장되면 다음 시작을 막는다). API 와 로드가 같은 검사를 쓴다.
export const validBudgetTokens=n=>Number.isSafeInteger(n)&&n>=0;
export const validPassword=p=>typeof p==='string'&&p.length>=PASSWORD_MIN&&p.length<=PASSWORD_MAX;

async function hashPassword(password,salt=randomBytes(SALT_BYTES)){
  const key=await scrypt(password,salt,HASH_BYTES,{N:2**15,r:8,p:1,maxmem:64*1024*1024});
  return {salt:salt.toString('base64'),hash:key.toString('base64')};
}
async function verifyPassword(password,rec){const {hash}=await hashPassword(password,Buffer.from(rec.salt,'base64'));return same(hash,rec.hash);}

class JsonFile{
  constructor(file,initial,validate=null){this.file=file;this.data=initial;this.validate=validate;this.exists=false;}
  // 파일 없음(ENOENT)만 최초 실행. 권한 오류·JSON 손상·스키마 위반은 던진다 — 빈 상태로 덮어쓰지 않는다.
  async load(){
    let raw;try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw Object.assign(new Error('accounts_unreadable'),{cause:e,file:this.file});}
    let d;try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('accounts_corrupt'),{cause:e,file:this.file});}
    if(!d||typeof d!=='object'||Array.isArray(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file});
    if(this.validate&&!this.validate(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file,reason:'schema'});
    this.data=d;this.exists=true;
  }
  save(){
    const run=async()=>{
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(this.data,null,1),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,this.file);this.exists=true;
    };
    this._chain=(this._chain??Promise.resolve()).then(run,run);
    return this._chain;
  }
}

export const OWNER_ID=1;
export class Owner{
  constructor(dataDir){
    this.dataDir=dataDir;
    // 존재하는 owner.json 은 완전해야 한다: salt 16B·hash 64B(base64), createdAt 날짜, authVersion 양의 정수. 선택 항목은 형식 검사.
    this.owner=new JsonFile(path.join(dataDir,'owner.json'),null,d=>{
      if(!b64Len(d.salt,SALT_BYTES)||!b64Len(d.hash,HASH_BYTES)||!isDate(d.createdAt))return false;
      // v0.7.0 파일은 authVersion 이 없다 (재검수 V22): "없음" 은 마이그레이션 대상, 있는데 잘못된 값은 손상
      if(d.authVersion!==undefined&&(!Number.isSafeInteger(d.authVersion)||d.authVersion<1))return false;
      if(d.budget!==undefined&&d.budget!==null&&(!d.budget||typeof d.budget!=='object'||!validBudgetTokens(d.budget.monthlyTokens)))return false;
      if(d.lead!==undefined&&d.lead!==null&&typeof d.lead!=='string')return false;
      return true;
    });
    this.sessions=new JsonFile(path.join(dataDir,'sessions.json'),{sessions:{}},d=>{
      if(!d.sessions||typeof d.sessions!=='object'||Array.isArray(d.sessions))return false;
      for(const [k,s] of Object.entries(d.sessions))if(!/^[0-9a-f]{64}$/.test(k)||!s||typeof s!=='object'||!isDate(s.createdAt)||!isDate(s.expiresAt)||(s.v!==undefined&&!Number.isSafeInteger(s.v)))return false;   // v 없음 = v0.7.0 세션 → 로드 때 폐기
      return true;
    });
    this.failures=new Map();
  }
  // 재검수 V22: 정상 v0.7.0 데이터를 그대로 받는다. owner 에 authVersion:1 을 원자적으로 저장하고(먼저), v 없는 옛 세션은 전부 폐기해 재로그인을 요구한다.
  // owner 만 바뀌고 중단돼도 다음 시작에서 세션 쪽이 다시 정리되므로 어느 지점에서 끊겨도 재시작 가능.
  async load(){
    await this.owner.load();
    if(this.owner.data&&this.owner.data.authVersion===undefined){this.owner.data={...this.owner.data,authVersion:1};await this.owner.save();this.migrated=(this.migrated??[]).concat('owner_auth_version');}
    await this.sessions.load();
    const s=this.sessions.data.sessions;const legacy=Object.keys(s).filter(k=>s[k].v===undefined);
    if(legacy.length){for(const k of legacy)delete s[k];await this.sessions.save();this.migrated=(this.migrated??[]).concat(`sessions_dropped:${legacy.length}`);}
    this.pruneSessions();
  }
  get isSet(){return this.owner.exists&&!!this.owner.data;}
  get authVersion(){return this.owner.data?.authVersion??0;}
  // 고정 사용자 객체 (서버의 사용자 컨텍스트가 id 로 폴더를 만든다)
  get user(){const d=this.owner.data??{};return {id:OWNER_ID,username:'owner',role:'owner',createdAt:d.createdAt??null,budget:d.budget??null,lead:d.lead??null,disabled:false};}
  publicUser(u=this.user){return u?{id:u.id,username:u.username,role:u.role,createdAt:u.createdAt,budget:u.budget??null,lead:u.lead??null}:null;}
  userById(id){return id===OWNER_ID?this.user:null;}

  // ---- 최초 설정: 비밀번호가 없을 때만. 한 번에 한 설정만(직렬화), 해시 뒤에 다시 확인. ----
  async setup({password}){
    const op=async()=>{
      if(this.isSet)return {error:'already_set'};
      if(!validPassword(password))return {error:'password_too_short'};
      const {salt,hash}=await hashPassword(password);
      if(this.isSet)return {error:'already_set'};
      this.owner.data={salt,hash,createdAt:new Date().toISOString(),authVersion:1,budget:null,lead:null};
      await this.owner.save();return {ok:true,user:this.publicUser()};
    };
    this._lock=(this._lock??Promise.resolve()).then(op,op);return this._lock;
  }
  // 비밀번호 변경 = 해시 + authVersion 을 owner.json 에 한 번에 커밋. 커밋 전엔 메모리도 안 바꾼다 (검수 V02).
  // 옛 세션은 v 가 달라 즉시 무효. 세션 파일 비우기는 사후 정리(실패해도 보안에 영향 없음).
  async changePassword({current,next}){
    const op=async()=>{
      if(!this.isSet)return {error:'not_set'};
      if(!(typeof current==='string'&&await verifyPassword(current,this.owner.data)))return {error:'login_invalid'};
      if(!validPassword(next))return {error:'password_too_short'};
      const {salt,hash}=await hashPassword(next);
      const prev=this.owner.data;
      this.owner.data={...prev,salt,hash,authVersion:prev.authVersion+1};
      try{await this.owner.save();}catch(e){this.owner.data=prev;throw e;}
      this.sessions.data.sessions={};this.sessions.save().catch(()=>{});
      return {ok:true,authVersion:this.owner.data.authVersion};
    };
    this._lock=(this._lock??Promise.resolve()).then(op,op);return this._lock;
  }

  // ---- 로그인 (같은 키로 10회 실패 시 15분 잠금, 키별 직렬화) ----
  async login({password,key='global'}){
    const op=()=>this._login({password,key});
    const locks=this._loginLocks??(this._loginLocks=new Map());
    const chain=(locks.get(key)??Promise.resolve()).then(op,op);
    locks.set(key,chain);const cleanup=()=>{if(locks.get(key)===chain)locks.delete(key);};chain.then(cleanup,cleanup);
    return chain;
  }
  // 재검수 V24 보완: 키(IP)를 아무리 바꿔도 전체 실패가 1분에 20회를 넘으면 1분간 모든 로그인을 거부한다 (무차별 대입 차단, 창은 1분뿐).
  _globalGate(){const g=this._global??(this._global={count:0,windowStart:Date.now(),until:0});const now=Date.now();if(now-g.windowStart>60000){g.count=0;g.windowStart=now;}return g;}
  async _login({password,key}){
    const g=this._globalGate();if(g.until>Date.now())return {error:'too_many_attempts'};
    const f=this.failures.get(key);
    if(f&&f.until>Date.now())return {error:'too_many_attempts'};
    // 재검수 V23: 검증 시작 시점의 해시·버전을 잡아 두고, scrypt 가 끝났을 때 바뀌어 있으면(그 사이 비밀번호 변경) 발급하지 않는다.
    const rec=this.owner.data,version=this.authVersion;
    const ok=this.isSet&&typeof password==='string'&&password.length<=PASSWORD_MAX&&await verifyPassword(password,rec)&&this.owner.data===rec&&this.authVersion===version;
    if(!ok){
      const cur=this.failures.get(key);const n=(cur&&Date.now()-cur.lastAt<15*60*1000?cur.count:0)+1;
      this.failures.set(key,{count:n,lastAt:Date.now(),until:n>=10?Date.now()+15*60*1000:0});
      g.count++;if(g.count>=20)g.until=Date.now()+60*1000;
      return {error:'login_invalid'};
    }
    this.failures.delete(key);
    const token=randomBytes(32).toString('base64url');
    this.sessions.data.sessions[sha256(token)]={createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString(),v:version};
    await this.sessions.save();
    return {token,user:this.publicUser()};
  }
  async logout(token){if(!token)return;delete this.sessions.data.sessions[sha256(token)];await this.sessions.save();}
  pruneSessions(){const s=this.sessions.data.sessions;let changed=false;for(const [k,v] of Object.entries(s)){if(!notExpired(v.expiresAt)||v.v!==this.authVersion){delete s[k];changed=true;}}if(changed)this.sessions.save().catch(()=>{});}
  userForToken(token){
    if(!token||!this.isSet)return null;
    const s=this.sessions.data.sessions[sha256(token)];
    return s&&notExpired(s.expiresAt)&&s.v===this.authVersion?this.user:null;
  }

  // ---- 설정: 월 토큰 상한(null=config 기본값), 팀장 AI ----
  async setBudget(budget){
    if(budget===null)this.owner.data.budget=null;
    else{const n=budget?.monthlyTokens;if(!validBudgetTokens(n))return false;this.owner.data.budget={monthlyTokens:n};}
    await this.owner.save();return true;
  }
  async setLead(adapterId){this.owner.data.lead=adapterId??null;await this.owner.save();return true;}
}
