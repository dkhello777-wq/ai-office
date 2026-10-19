// v0.10 푸시 알림 (Web Push, 외부 패키지 없이 Node crypto 로).
// - VAPID 키(P-256)는 첫 시작 때 만들어 data/vapid.json(0600)에 둔다. 기기 구독은 data/push.json(0600).
// - 메시지는 RFC 8291(aes128gcm)로 암호화해 보낸다 → 푸시 서버(Google·Apple·Mozilla)는 내용을 못 본다.
// - SSRF 방지: 구독 endpoint 는 알려진 푸시 서비스의 https 주소만 받는다.
// - 410/404 응답(구독 만료·해제)은 그 기기 구독을 지운다.
import {readFile,writeFile,rename,chmod} from 'node:fs/promises';
import {createECDH,createHmac,createCipheriv,randomBytes,generateKeyPairSync,createPrivateKey,sign} from 'node:crypto';
import path from 'node:path';

const b64u=b=>Buffer.from(b).toString('base64url');
const unb64u=s=>Buffer.from(String(s),'base64url');
const hmac=(key,data)=>createHmac('sha256',key).update(data).digest();

// 푸시 서비스 허용 목록 (브라우저가 주는 endpoint 의 호스트)
const PUSH_HOSTS=[/^fcm\.googleapis\.com$/,/^android\.googleapis\.com$/,/^updates\.push\.services\.mozilla\.com$/,/^[\w-]+\.push\.services\.mozilla\.com$/,/^web\.push\.apple\.com$/,/^[\w.-]+\.push\.apple\.com$/,/^[\w.-]+\.notify\.windows\.com$/];
export function validEndpoint(u){
  try{const x=new URL(u);return x.protocol==='https:'&&!x.username&&!x.password&&(x.port===''||x.port==='443')&&PUSH_HOSTS.some(r=>r.test(x.hostname));}catch{return false;}
}
export function validSubscription(s){
  if(!s||typeof s!=='object'||!validEndpoint(s.endpoint)||s.endpoint.length>2000)return false;
  const k=s.keys??{};let p,a;try{p=unb64u(k.p256dh);a=unb64u(k.auth);}catch{return false;}
  return p.length===65&&p[0]===4&&a.length===16;
}

// RFC 8291 aes128gcm: 한 레코드(rs=4096)로 payload 를 암호화한다.
export function encryptPayload(payload,{p256dh,auth},{ecdh=createECDH('prime256v1'),salt=randomBytes(16)}={}){
  const ua=unb64u(p256dh),secret=unb64u(auth);
  let as;try{as=ecdh.getPublicKey();}catch{ecdh.generateKeys();as=ecdh.getPublicKey();}
  const shared=ecdh.computeSecret(ua);
  const prkKey=hmac(secret,shared);
  const ikm=hmac(prkKey,Buffer.concat([Buffer.from('WebPush: info\0'),ua,as,Buffer.from([1])]));
  const prk=hmac(salt,ikm);
  const cek=hmac(prk,Buffer.from('Content-Encoding: aes128gcm\0\x01','binary')).subarray(0,16);
  const nonce=hmac(prk,Buffer.from('Content-Encoding: nonce\0\x01','binary')).subarray(0,12);
  const plain=Buffer.concat([Buffer.from(payload),Buffer.from([2])]);   // 마지막 레코드 구분자
  if(plain.length+16>4096)throw new Error('payload_too_large');
  const c=createCipheriv('aes-128-gcm',cek,nonce);
  const body=Buffer.concat([c.update(plain),c.final(),c.getAuthTag()]);
  const rs=Buffer.alloc(4);rs.writeUInt32BE(4096);
  return Buffer.concat([salt,rs,Buffer.from([as.length]),as,body]);
}

export class Push{
  constructor({dataDir,subject=process.env.HUB_PUSH_SUBJECT??'mailto:ai-office@localhost',fetchImpl=globalThis.fetch,now=()=>Date.now()}){
    this.keyFile=path.join(dataDir,'vapid.json');this.subFile=path.join(dataDir,'push.json');
    this.subject=subject;this.fetch=fetchImpl;this.now=now;
    this.vapid=null;this.data={subs:[],prefs:{done:true,ask:true}};
  }
  async _write(file,obj){const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(obj),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,file);}
  async load(){
    try{this.vapid=JSON.parse(await readFile(this.keyFile,'utf8'));if(!this.vapid?.publicKey||!this.vapid?.privateJwk)this.vapid=null;}catch{}
    if(!this.vapid){
      const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
      const jwk=privateKey.export({format:'jwk'});const pub=publicKey.export({format:'jwk'});
      this.vapid={publicKey:b64u(Buffer.concat([Buffer.from([4]),unb64u(pub.x),unb64u(pub.y)])),privateJwk:jwk,createdAt:new Date(this.now()).toISOString()};
      await this._write(this.keyFile,this.vapid);
    }
    try{const d=JSON.parse(await readFile(this.subFile,'utf8'));if(Array.isArray(d.subs))this.data={subs:d.subs.filter(validSubscription),prefs:{done:d.prefs?.done!==false,ask:d.prefs?.ask!==false}};}catch{}
  }
  save(){this._chain=(this._chain??Promise.resolve()).then(()=>this._write(this.subFile,this.data),()=>this._write(this.subFile,this.data));return this._chain;}
  get publicKey(){return this.vapid?.publicKey??null;}
  status(endpoint=null){return {publicKey:this.publicKey,devices:this.data.subs.length,thisDevice:!!(endpoint&&this.data.subs.some(s=>s.endpoint===endpoint)),prefs:this.data.prefs};}
  async subscribe(sub,label=''){
    if(!validSubscription(sub))return {error:'push_subscription_invalid'};
    this.data.subs=this.data.subs.filter(s=>s.endpoint!==sub.endpoint);
    this.data.subs.push({endpoint:sub.endpoint,keys:{p256dh:sub.keys.p256dh,auth:sub.keys.auth},label:String(label).slice(0,80),createdAt:new Date(this.now()).toISOString()});
    this.data.subs=this.data.subs.slice(-10);   // 기기 10대까지
    await this.save();return {ok:true};
  }
  async unsubscribe(endpoint){this.data.subs=this.data.subs.filter(s=>s.endpoint!==endpoint);await this.save();return {ok:true};}
  async setPrefs(p){for(const k of ['done','ask'])if(typeof p?.[k]==='boolean')this.data.prefs[k]=p[k];await this.save();return this.data.prefs;}

  _jwt(aud){
    const key=createPrivateKey({key:this.vapid.privateJwk,format:'jwk'});
    const head=b64u(JSON.stringify({typ:'JWT',alg:'ES256'}));
    const claims=b64u(JSON.stringify({aud,exp:Math.floor(this.now()/1000)+12*3600,sub:this.subject}));
    const sig=sign('sha256',Buffer.from(`${head}.${claims}`),{key,dsaEncoding:'ieee-p1363'});
    return `${head}.${claims}.${b64u(sig)}`;
  }
  async _sendOne(sub,payload,{ttl=3600,urgency='normal',topic}={}){
    const body=encryptPayload(payload,sub.keys);
    const aud=new URL(sub.endpoint).origin;
    const headers={'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream','TTL':String(ttl),'Urgency':urgency,'Authorization':`vapid t=${this._jwt(aud)}, k=${this.publicKey}`};
    if(topic)headers.Topic=String(topic).replace(/[^A-Za-z0-9_-]/g,'').slice(0,32);
    const r=await this.fetch(sub.endpoint,{method:'POST',headers,body});
    return r.status;
  }
  // kind: 'done' | 'ask' | 'test'. 설정에서 끈 종류는 보내지 않는다. 결과: 보낸 기기 수.
  async notify(kind,{title,body,url='/',tag}){
    if(kind!=='test'&&this.data.prefs[kind]===false)return 0;
    if(!this.vapid||!this.data.subs.length)return 0;
    const payload=JSON.stringify({title:String(title).slice(0,80),body:String(body??'').slice(0,240),url,tag:tag??kind});
    let sent=0,dead=[];
    await Promise.all(this.data.subs.map(async s=>{
      try{const st=await this._sendOne(s,payload,{urgency:kind==='ask'?'high':'normal',topic:tag});if(st>=200&&st<300)sent++;else if(st===404||st===410)dead.push(s.endpoint);else console.warn('push 실패',st,new URL(s.endpoint).hostname);}
      catch(e){console.warn('push 오류',e.message);}
    }));
    if(dead.length){this.data.subs=this.data.subs.filter(s=>!dead.includes(s.endpoint));await this.save();}
    return sent;
  }
}
