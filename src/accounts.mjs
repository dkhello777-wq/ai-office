// 허브 계정·초대 코드·세션. 비밀번호는 scrypt 해시만 저장, 초대 코드도 해시만 저장(원문은 발급 순간 한 번만 보여준다).
// 파일: data/accounts.json (0600), data/sessions.json (0600). 모든 쓰기는 tmp→rename, 직렬화.
import {readFile,writeFile,rename,mkdir,chmod,unlink} from 'node:fs/promises';
import {randomBytes,scrypt as scryptCb,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import path from 'node:path';
const scrypt=promisify(scryptCb);

export const USERNAME_RE=/^[a-z0-9][a-z0-9._-]{2,31}$/;   // 3~32자, 소문자·숫자·._-
export const PASSWORD_MIN=10;
const SESSION_TTL_MS=30*24*3600*1000;
const INVITE_TTL_MS=7*24*3600*1000;
const sha256=s=>createHash('sha256').update(s).digest('hex');
const isId=v=>Number.isSafeInteger(v)&&v>=1;
const isDate=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
// 만료 비교는 "유효한 날짜이고 아직 안 지났을 때"만 통과. NaN 은 만료로 취급 (사용 시점 방어, GPT G01)
const notExpired=v=>isDate(v)&&Date.parse(v)>=Date.now();
const same=(a,b)=>{const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&x.length>0&&timingSafeEqual(x,y);};

async function hashPassword(password,salt=randomBytes(16)){
  const key=await scrypt(password,salt,64,{N:2**15,r:8,p:1,maxmem:64*1024*1024});
  return {salt:salt.toString('base64'),hash:key.toString('base64')};
}
async function verifyPassword(password,rec){
  const {hash}=await hashPassword(password,Buffer.from(rec.salt,'base64'));
  return same(hash,rec.hash);
}

class JsonFile{
  constructor(file,initial,validate=null){this.file=file;this.data=initial;this.validate=validate;}
  // 파일 없음(ENOENT)만 최초 실행. 권한 오류·JSON 손상은 던진다 — 빈 상태로 시작해 bootstrap 을 재발급하거나 ID 를 재사용하면 안 된다 (GPT R05).
  async load(){
    let raw;try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return;throw Object.assign(new Error('accounts_unreadable'),{cause:e,file:this.file});}
    let d;try{d=JSON.parse(raw);}catch(e){throw Object.assign(new Error('accounts_corrupt'),{cause:e,file:this.file});}
    if(!d||typeof d!=='object'||Array.isArray(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file});
    if(this.validate&&!this.validate(d))throw Object.assign(new Error('accounts_corrupt'),{file:this.file,reason:'schema'});
    this.data={...this.data,...d};
  }
  // 직렬화 체인: 한 번의 쓰기 실패가 이후 저장까지 막지 않도록 reject 뒤에도 다음 쓰기를 이어간다 (검수 FAIL 8).
  save(){
    const run=async()=>{
      await mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
      const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(this.data,null,1),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,this.file);
    };
    this._chain=(this._chain??Promise.resolve()).then(run,run);
    return this._chain;
  }
}

export class Accounts{
  constructor(dataDir){
    this.dataDir=dataDir;
    // 필수 구조 검증 (GPT F01): 문법은 맞지만 필수 항목이 빠진 파일(예: {})을 새 상태로 받아들이면 bootstrap 재발급·ID 재사용이 일어난다.
    // 내부 값까지 검증 (GPT G01): 날짜는 실제로 해석되는 값(Date.parse 가 NaN 이면 만료 비교가 항상 false 가 되어 "영원히 유효"가 됨), id 는 안전한 정수·유일, 참조는 정해진 형태.
    this.accounts=new JsonFile(path.join(dataDir,'accounts.json'),{users:[],invites:[],nextUserId:1},d=>{
      if(!Array.isArray(d.users)||!Array.isArray(d.invites)||!isId(d.nextUserId))return false;
      const ids=new Set();
      for(const u of d.users){
        if(!u||typeof u!=='object'||!isId(u.id)||u.id>=d.nextUserId||ids.has(u.id))return false;ids.add(u.id);
        if(typeof u.username!=='string'||typeof u.salt!=='string'||typeof u.hash!=='string'||!['user','admin'].includes(u.role)||!isDate(u.createdAt))return false;
        if(u.disabled!==undefined&&typeof u.disabled!=='boolean')return false;
        if(u.budget!==undefined&&u.budget!==null&&(!u.budget||typeof u.budget!=='object'||!Number.isSafeInteger(u.budget.monthlyTokens)||u.budget.monthlyTokens<0))return false;
      }
      const invIds=new Set();
      for(const i of d.invites){
        if(!i||typeof i!=='object'||typeof i.id!=='string'||invIds.has(i.id)||typeof i.codeHash!=='string')return false;invIds.add(i.id);
        if(!['user','admin'].includes(i.role)||typeof i.createdBy!=='string'||!isDate(i.createdAt)||!isDate(i.expiresAt)||typeof i.revoked!=='boolean')return false;
        if(!(i.usedBy===null||isId(i.usedBy))||!(i.usedAt===null||isDate(i.usedAt)))return false;
      }
      return true;
    });
    this.sessions=new JsonFile(path.join(dataDir,'sessions.json'),{sessions:{}},d=>{
      if(!d.sessions||typeof d.sessions!=='object'||Array.isArray(d.sessions))return false;
      for(const [k,s] of Object.entries(d.sessions))if(!/^[0-9a-f]{64}$/.test(k)||!s||typeof s!=='object'||!isId(s.userId)||!isDate(s.createdAt)||!isDate(s.expiresAt))return false;
      return true;
    });
    this.failures=new Map();   // 로그인 실패 제한: key → {count, until}
  }
  async load(){await this.accounts.load();await this.sessions.load();this.pruneSessions();}
  get users(){return this.accounts.data.users;}
  hasUsers(){return this.users.length>0;}   // 전원 중지 상태에서도 부트스트랩 코드를 다시 만들지 않는다 (검수 FAIL 6)
  publicUser(u){return u?{id:u.id,username:u.username,role:u.role,createdAt:u.createdAt,disabled:!!u.disabled,budget:u.budget??null}:null;}
  userById(id){return this.users.find(u=>u.id===id)??null;}

  // ---- 초대 코드 ----
  async createInvite({createdBy,role='user',ttlMs=INVITE_TTL_MS}){
    const code=randomBytes(12).toString('base64url');   // 16자, 발급 시 한 번만 반환
    const rec={id:randomBytes(6).toString('hex'),codeHash:sha256(code),role:role==='admin'?'admin':'user',createdBy,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+ttlMs).toISOString(),usedBy:null,usedAt:null,revoked:false};
    this.accounts.data.invites.push(rec);await this.accounts.save();
    return {code,invite:this.publicInvite(rec)};
  }
  publicInvite(i){return {id:i.id,role:i.role,createdBy:i.createdBy,createdAt:i.createdAt,expiresAt:i.expiresAt,usedBy:i.usedBy,usedAt:i.usedAt,revoked:i.revoked,state:i.revoked?'revoked':i.usedBy?'used':!notExpired(i.expiresAt)?'expired':'open'};}
  listInvites(){return this.accounts.data.invites.map(i=>this.publicInvite(i));}
  async revokeInvite(id){const i=this.accounts.data.invites.find(x=>x.id===id);if(!i)return false;i.revoked=true;await this.accounts.save();return true;}
  findOpenInvite(code){
    const h=sha256(String(code??''));
    const i=this.accounts.data.invites.find(x=>same(x.codeHash,h));
    if(!i||i.revoked||i.usedBy||!notExpired(i.expiresAt))return null;
    return i;
  }

  // ---- 가입 ----
  // 가입은 직렬화한다: scrypt(~100ms) 동안 다른 가입 요청이 같은 1회용 초대 코드·같은 아이디를 통과하지 못하게 (검수 FAIL 1).
  // 해시가 끝난 뒤 초대 상태(취소·사용·만료)와 아이디 중복을 한 번 더 확인한다.
  async signup({inviteCode,username,password}){
    const op=async()=>{
      username=String(username??'').trim().toLowerCase();
      if(!USERNAME_RE.test(username))return {error:'username_invalid'};
      if(typeof password!=='string'||password.length<PASSWORD_MIN)return {error:'password_too_short'};
      const invite=this.findOpenInvite(inviteCode);if(!invite)return {error:'invite_invalid'};
      if(this.users.some(u=>u.username===username))return {error:'username_taken'};
      const {salt,hash}=await hashPassword(password);
      if(invite.revoked||invite.usedBy||!notExpired(invite.expiresAt))return {error:'invite_invalid'};
      if(this.users.some(u=>u.username===username))return {error:'username_taken'};
      const user={id:this.accounts.data.nextUserId++,username,role:invite.role,salt,hash,createdAt:new Date().toISOString(),invitedBy:invite.createdBy,disabled:false};
      this.users.push(user);invite.usedBy=user.id;invite.usedAt=user.createdAt;
      await this.accounts.save();
      return {user:this.publicUser(user)};
    };
    this._signupLock=(this._signupLock??Promise.resolve()).then(op,op);
    return this._signupLock;
  }

  // ---- 로그인 (실패 제한: 같은 키로 10회 실패 시 15분 잠금) ----
  // 같은 키(IP|아이디)의 로그인은 직렬화한다: 동시 실패가 서로의 카운트를 덮어쓰지 못하게 (GPT R04). 검증 뒤 중지 여부를 다시 본다.
  async login({username,password,key='global'}){
    const op=()=>this._login({username,password,key});
    const locks=this._loginLocks??(this._loginLocks=new Map());
    const chain=(locks.get(key)??Promise.resolve()).then(op,op);
    locks.set(key,chain);
    const cleanup=()=>{if(locks.get(key)===chain)locks.delete(key);};
    chain.then(cleanup,cleanup);   // finally() 는 거부를 전파한 새 Promise 를 만들어 미처리 거부가 된다 (GPT F05)
    return chain;
  }
  async _login({username,password,key}){
    username=String(username??'').trim().toLowerCase();
    const f=this.failures.get(key);
    if(f&&f.until>Date.now())return {error:'too_many_attempts'};
    const user=this.users.find(u=>u.username===username);
    const ok=user&&!user.disabled&&typeof password==='string'&&await verifyPassword(password,user);
    if(!ok||user.disabled){   // 검증 중 중지된 계정도 거부
      const cur=this.failures.get(key);
      const n=(cur&&Date.now()-cur.lastAt<15*60*1000?cur.count:0)+1;   // 15분 안의 연속 실패만 누적 (최신 기록 기준)
      this.failures.set(key,{count:n,lastAt:Date.now(),until:n>=10?Date.now()+15*60*1000:0});
      return {error:'login_invalid'};
    }
    this.failures.delete(key);
    const token=randomBytes(32).toString('base64url');
    this.sessions.data.sessions[sha256(token)]={userId:user.id,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+SESSION_TTL_MS).toISOString()};
    await this.sessions.save();
    return {token,user:this.publicUser(user)};
  }
  async logout(token){if(!token)return;delete this.sessions.data.sessions[sha256(token)];await this.sessions.save();}
  pruneSessions(){const s=this.sessions.data.sessions;let changed=false;for(const [k,v] of Object.entries(s)){if(!notExpired(v.expiresAt)){delete s[k];changed=true;}}if(changed)this.sessions.save();}
  userForToken(token){
    if(!token)return null;
    const s=this.sessions.data.sessions[sha256(token)];
    if(!s||!notExpired(s.expiresAt))return null;
    const u=this.userById(s.userId);
    return u&&!u.disabled?u:null;
  }
  async setDisabled(userId,disabled){
    const u=this.userById(userId);if(!u)return false;u.disabled=!!disabled;
    if(disabled)for(const [k,v] of Object.entries(this.sessions.data.sessions))if(v.userId===userId)delete this.sessions.data.sessions[k];
    await this.accounts.save();await this.sessions.save();return true;
  }

  // ---- v0.5 토큰 예산(사용자별 월 상한). null 이면 config 기본값을 따른다. ----
  async setBudget(userId,budget){
    const u=this.userById(userId);if(!u)return false;
    if(budget===null)delete u.budget;else u.budget={monthlyTokens:Math.max(0,Math.floor(Number(budget.monthlyTokens)||0))};
    await this.accounts.save();return true;
  }

  // ---- 최초 관리자: 사용자가 없으면 관리자용 초대 코드를 만들어 파일(0600)과 콘솔에 남긴다. 가입에 쓰이면 파일 삭제. ----
  async ensureBootstrap(){
    const file=path.join(this.dataDir,'bootstrap-invite');
    if(this.hasUsers()){
      // 사용자가 생겼으면 미사용 부트스트랩 초대도 폐기한다 (파일만 지우면 accounts.json 에 open 상태로 남음 — 검수 FAIL 6)
      let changed=false;
      for(const i of this.accounts.data.invites){if(i.createdBy==='bootstrap'&&!i.usedBy&&!i.revoked){i.revoked=true;changed=true;}}
      if(changed)await this.accounts.save();
      try{await unlink(file);}catch{}return null;
    }
    const open=this.accounts.data.invites.find(i=>i.createdBy==='bootstrap'&&this.publicInvite(i).state==='open');
    if(open){try{return (await readFile(file,'utf8')).trim()||null;}catch{return null;}}
    const {code}=await this.createInvite({createdBy:'bootstrap',role:'admin',ttlMs:24*3600*1000});
    await writeFile(file,code+'\n',{mode:0o600});await chmod(file,0o600);
    return code;
  }
}
