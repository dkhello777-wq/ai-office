// 1인용 계정 (v0.7): 이 서버의 주인 한 명. 비밀번호는 scrypt 해시만 저장, 세션은 토큰 해시만 저장.
// 파일: data/owner.json (0600), data/sessions.json (0600). 모든 쓰기는 tmp→rename, 직렬화.
// 최초 설정: 화면의 "비밀번호 설정"(/api/setup) 또는 환경변수 HUB_PASSWORD (서버 첫 시작 때 한 번 읽어 해시로 저장).
import {readFile,writeFile,rename,mkdir,chmod} from 'node:fs/promises';
import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
const scrypt=promisify(scryptCb);

export const PASSWORD_MIN=10;
const SESSION_TTL_MS=30*24*3600*1000;
const sha256=s=>createHash('sha256').update(s).digest('hex');
const isDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const notExpired=v=>isDate(v)&&Date.parse(v)>=Date.now();
const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&x.length>0&&timingSafeEqual(x,y);};

async function hashPassword(password,salt=randomBytes(16)){
  const key=await scrypt(password,salt,64,{N:2**15,r:8,p:1,maxmem:64*1024*1024});
  return {salt:salt.toString('base64'),hash:key.toString('base64')};
}
async function verifyPassword(password,rec){const {hash}=await hashPassword(password,Buffer.from(rec.salt,'base64'));return same(hash,rec.hash);}

class JsonFile{
  constructor(file,initial,validate=null){this.file=file;this.data=initial;this.validate=validate;}
  // 파일 없음(ENOENT)만 최초 실행. 권한 오류·JSON 손상은 던진다 — 빈 상태로 덮어쓰지 않는다.
  async load(){
    let raw;try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw Object.assign(new Error('accounts_unreadable'),{cause:e,file:this.file});}
    let d;try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('accounts_corrupt'),{cause:e,file:this.file});}
    if(!d||typeof d!=='object'||Array.isArray(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file});
    if(this.validate&&!this.validate(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file,reason:'schema'});
    this.data={...this.data,...d};
  }
  save(){
    const run=async()=>{
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(this.data,null,1),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,this.file);
    };
    this._chain=(this._chain??Promise.resolve()).then(run,run);
    return this._chain;
  }
}

export const OWNER_ID=1;
export class Owner{
  constructor(dataDir){
    this.dataDir=dataDir;
    this.owner=new JsonFile(path.join(dataDir,'owner.json'),{salt:null,hash:null,createdAt:null,budget:null,lead:null},d=>{
      if(d.salt!==null&&typeof d.salt!=='string')return false;
      if(d.hash!==null&&typeof d.hash!=='string')return false;
      if(d.createdAt!==null&&d.createdAt!==undefined&&!isDate(d.createdAt))return false;
      if(d.budget!==undefined&&d.budget!==null&&(!d.budget||typeof d.budget!=='object'||!Number.isSafeInteger(d.budget.monthlyTokens)||d.budget.monthlyTokens<0))return false;
      if(d.lead!==undefined&&d.lead!==null&&typeof d.lead!=='string')return false;
      return true;
    });
    this.sessions=new JsonFile(path.join(dataDir,'sessions.json'),{sessions:{}},d=>{
      if(!d.sessions||typeof d.sessions!=='object'||Array.isArray(d.sessions))return false;
      for(const [k,s] of Object.entries(d.sessions))if(!/^[0-9a-f]{64}$/.test(k)||!s||typeof s!=='object'||!isDate(s.createdAt)||!isDate(s.expiresAt))return false;
      return true;
    });
    this.failures=new Map();
  }
  async load(){await this.owner.load();await this.sessions.load();this.pruneSessions();}
  get isSet(){return !!(this.owner.data.salt&&this.owner.data.hash);}
  // 고정 사용자 객체 (서버의 사용자 컨텍스트가 id 로 폴더를 만든다)
  get user(){return {id:OWNER_ID,username:'owner',role:'owner',createdAt:this.owner.data.createdAt,budget:this.owner.data.budget??null,lead:this.owner.data.lead??null,disabled:false};}
  publicUser(u=this.user){return u?{id:u.id,username:u.username,role:u.role,createdAt:u.createdAt,budget:u.budget??null,lead:u.lead??null}:null;}
  userById(id){return id===OWNER_ID?this.user:null;}

  // ---- 최초 설정: 비밀번호가 없을 때만. 환경변수 HUB_PASSWORD 가 있으면 서버가 시작할 때 이걸로 설정한다. ----
  async setup({password}){
    const op=async()=>{
      if(this.isSet)return {error:'already_set'};
      if(typeof password!=='string'||password.length<PASSWORD_MIN)return {error:'password_too_short'};
      const {salt,hash}=await hashPassword(password);
      if(this.isSet)return {error:'already_set'};
      Object.assign(this.owner.data,{salt,hash,createdAt:new Date().toISOString()});
      await this.owner.save();return {ok:true,user:this.publicUser()};
    };
    this._lock=(this._lock??Promise.resolve()).then(op,op);return this._lock;
  }
  async changePassword({current,next}){
    if(!this.isSet)return {error:'not_set'};
    if(!(typeof current==='string'&&await verifyPassword(current,this.owner.data)))return {error:'login_invalid'};
    if(typeof next!=='string'||next.length<PASSWORD_MIN)return {error:'password_too_short'};
    const {salt,hash}=await hashPassword(next);Object.assign(this.owner.data,{salt,hash});await this.owner.save();
    this.sessions.data.sessions={};await this.sessions.save();   // 바꾸면 모든 기기에서 다시 로그인
    return {ok:true};
  }

  // ---- 로그인 (같은 키로 10회 실패 시 15분 잠금, 키별 직렬화) ----
  async login({password,key='global'}){
    const op=()=>this._login({password,key});
    const locks=this._loginLocks??(this._loginLocks=new Map());
    const chain=(locks.get(key)??Promise.resolve()).then(op,op);
    locks.set(key,chain);const cleanup=()=>{if(locks.get(key)===chain)locks.delete(key);};chain.then(cleanup,cleanup);
    return chain;
  }
  async _login({password,key}){
    const f=this.failures.get(key);
    if(f&&f.until>Date.now())return {error:'too_many_attempts'};
    const ok=this.isSet&&typeof password==='string'&&await verifyPassword(password,this.owner.data);
    if(!ok){
      const cur=this.failures.get(key);const n=(cur&&Date.now()-cur.lastAt<15*60*1000?cur.count:0)+1;
      this.failures.set(key,{count:n,lastAt:Date.now(),until:n>=10?Date.now()+15*60*1000:0});
      return {error:'login_invalid'};
    }
    this.failures.delete(key);
    const token=randomBytes(32).toString('base64url');
    this.sessions.data.sessions[sha256(token)]={createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()};
    await this.sessions.save();
    return {token,user:this.publicUser()};
  }
  async logout(token){if(!token)return;delete this.sessions.data.sessions[sha256(token)];await this.sessions.save();}
  pruneSessions(){const s=this.sessions.data.sessions;let changed=false;for(const [k,v] of Object.entries(s)){if(!notExpired(v.expiresAt)){delete s[k];changed=true;}}if(changed)this.sessions.save();}
  userForToken(token){
    if(!token||!this.isSet)return null;
    const s=this.sessions.data.sessions[sha256(token)];
    return s&&notExpired(s.expiresAt)?this.user:null;
  }

  // ---- 설정: 월 토큰 상한(null=config 기본값), 팀장 AI ----
  async setBudget(budget){
    if(budget===null)this.owner.data.budget=null;else this.owner.data.budget={monthlyTokens:Math.max(0,Math.floor(Number(budget.monthlyTokens)||0))};
    await this.owner.save();return true;
  }
  async setLead(adapterId){this.owner.data.lead=adapterId??null;await this.owner.save();return true;}
}
