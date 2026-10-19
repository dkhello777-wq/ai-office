// v0.10 푸시 알림: RFC 8291 암호화(브라우저 쪽으로 다시 풀어 확인) · VAPID 서명 · endpoint 허용 목록 · 만료 구독 정리 · 알림 요약
import test from 'node:test';
import assert from 'node:assert/strict';
import {createECDH,createHmac,createDecipheriv,randomBytes,createPublicKey,verify} from 'node:crypto';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Push,encryptPayload,validEndpoint,validSubscription} from '../src/push.mjs';

const b64u=b=>Buffer.from(b).toString('base64url');
const hmac=(k,d)=>createHmac('sha256',k).update(d).digest();
// 브라우저(UA) 역할: 키를 만들고, 받은 본문을 RFC 8291 대로 푼다
function browser(){
  const ua=createECDH('prime256v1');ua.generateKeys();const auth=randomBytes(16);
  const keys={p256dh:b64u(ua.getPublicKey()),auth:b64u(auth)};
  const decrypt=buf=>{
    const salt=buf.subarray(0,16),rs=buf.readUInt32BE(16),idlen=buf[20],as=buf.subarray(21,21+idlen),ct=buf.subarray(21+idlen);
    assert.equal(rs,4096);assert.equal(idlen,65);
    const shared=ua.computeSecret(as);
    const ikm=hmac(hmac(auth,shared),Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(),as,Buffer.from([1])]));
    const prk=hmac(salt,ikm);
    const cek=hmac(prk,Buffer.from('Content-Encoding: aes128gcm\0\x01','binary')).subarray(0,16);
    const nonce=hmac(prk,Buffer.from('Content-Encoding: nonce\0\x01','binary')).subarray(0,12);
    const d=createDecipheriv('aes-128-gcm',cek,nonce);d.setAuthTag(ct.subarray(-16));
    const plain=Buffer.concat([d.update(ct.subarray(0,-16)),d.final()]);
    assert.equal(plain.at(-1),2,'마지막 레코드 구분자');
    return plain.subarray(0,-1).toString();
  };
  return {keys,decrypt};
}

test('암호화: 브라우저 키로 풀면 원래 JSON 이 나온다 (aes128gcm 헤더 형식 포함)', ()=>{
  const b=browser();
  const msg=JSON.stringify({title:'💬 Claude 답변 도착',body:'한글 본문 테스트'});
  assert.equal(b.decrypt(encryptPayload(msg,b.keys)),msg);
  assert.throws(()=>encryptPayload('x'.repeat(5000),b.keys),/payload_too_large/);
});

test('endpoint 허용 목록: 알려진 푸시 서비스의 https 만 (SSRF 방지)', ()=>{
  for(const ok of ['https://fcm.googleapis.com/fcm/send/abc','https://web.push.apple.com/QG9x','https://updates.push.services.mozilla.com/wpush/v2/x','https://wns2-par02p.notify.windows.com/w/?token=x'])assert.ok(validEndpoint(ok),ok);
  for(const bad of ['http://fcm.googleapis.com/x','https://evil.example/fcm.googleapis.com','https://fcm.googleapis.com.evil.example/x','https://user:pw@fcm.googleapis.com/x','https://fcm.googleapis.com:8443/x','https://169.254.169.254/latest','file:///etc/passwd'])assert.ok(!validEndpoint(bad),bad);
  const b=browser();
  assert.ok(validSubscription({endpoint:'https://fcm.googleapis.com/fcm/send/a',keys:b.keys}));
  assert.ok(!validSubscription({endpoint:'https://fcm.googleapis.com/fcm/send/a',keys:{p256dh:'AAAA',auth:b.keys.auth}}));
});

test('보내기: VAPID 서명이 공개키로 검증되고, 꺼 둔 종류는 안 보내고, 410 이면 그 기기를 지운다', async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'v10-'));
  const sent=[];let status=201;
  const fetchImpl=async(url,opt)=>{sent.push({url,opt});return {status};};
  const p=new Push({dataDir:dir,fetchImpl,subject:'mailto:test@example.com'});await p.load();
  assert.equal((await stat(path.join(dir,'vapid.json'))).mode&0o777,0o600);
  const b=browser();const ep='https://fcm.googleapis.com/fcm/send/dev1';
  assert.deepEqual(await p.subscribe({endpoint:'https://evil.example/x',keys:b.keys}),{error:'push_subscription_invalid'});
  await p.subscribe({endpoint:ep,keys:b.keys},'phone');
  assert.equal(p.status(ep).thisDevice,true);
  assert.equal(await p.notify('done',{title:'끝',body:'본문',url:'/#m5',tag:'r4'}),1);
  const {opt}=sent[0];
  assert.equal(opt.headers['Content-Encoding'],'aes128gcm');assert.equal(opt.headers.TTL,'3600');
  assert.deepEqual(JSON.parse(b.decrypt(opt.body)),{title:'끝',body:'본문',url:'/#m5',tag:'r4'});
  // VAPID: "vapid t=<jwt>, k=<공개키>" — 공개키로 서명 검증, aud 는 푸시 서비스 origin
  const m=/^vapid t=([^,]+), k=(.+)$/.exec(opt.headers.Authorization);assert.ok(m);
  assert.equal(m[2],p.publicKey);
  const [h,c,sig]=m[1].split('.');const claims=JSON.parse(Buffer.from(c,'base64url'));
  assert.equal(claims.aud,'https://fcm.googleapis.com');assert.equal(claims.sub,'mailto:test@example.com');
  const raw=Buffer.from(p.publicKey,'base64url');
  const pub=createPublicKey({key:{kty:'EC',crv:'P-256',x:b64u(raw.subarray(1,33)),y:b64u(raw.subarray(33))},format:'jwk'});
  assert.ok(verify('sha256',Buffer.from(`${h}.${c}`),{key:pub,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
  // 설정에서 끔
  await p.setPrefs({done:false});
  assert.equal(await p.notify('done',{title:'x'}),0);assert.equal(sent.length,1);
  assert.equal(await p.notify('ask',{title:'✋'}),1);assert.equal(sent[1].opt.headers.Urgency,'high');
  // 만료(410) → 구독 삭제, 파일에도 반영
  status=410;await p.notify('ask',{title:'✋'});
  assert.equal(p.status().devices,0);
  const saved=JSON.parse(await readFile(path.join(dir,'push.json'),'utf8'));assert.equal(saved.subs.length,0);assert.equal(saved.prefs.done,false);
  // 재시작해도 같은 VAPID 키
  const p2=new Push({dataDir:dir,fetchImpl});await p2.load();assert.equal(p2.publicKey,p.publicKey);
});

test('알림 요약(roundSummary): 다 끝나야 한 번, 승인 요청이 먼저, 팀 작업은 종합으로, 실패도 알린다', async()=>{
  const src=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
  const body=src.slice(src.indexOf('export function roundSummary'),src.indexOf('async function notifyRound'));
  const labels={claude:'Claude',codex:'ChatGPT (Codex)',gemini:'Gemini (Antigravity)'};
  const roundSummary=new Function('adapters',`const firstLine=t=>String(t??'').replace(/\\s+/g,' ').trim().slice(0,110);const labelOf=id=>adapters.find(a=>a.id===id)?.label?.replace(/\\s*\\(.*\\)/,'')??id;${body.replace('export ','')};return roundSummary;`)(Object.entries(labels).map(([id,label])=>({id,label})));
  const U={id:1,role:'user'};
  assert.equal(roundSummary([U,{id:2,role:'assistant',replyTo:1,adapter:'claude',status:'done',text:'a'},{id:3,role:'assistant',replyTo:1,adapter:'codex',status:'running'}],1),null,'아직 답하는 중');
  let s=roundSummary([U,{id:2,role:'assistant',replyTo:1,adapter:'claude',status:'done',text:'첫 줄\n둘째'},{id:3,role:'assistant',replyTo:1,adapter:'gemini',status:'error',error:'quota_exhausted'}],1);
  assert.equal(s.kind,'done');assert.equal(s.title,'💬 Claude 답변 도착 (Gemini 실패)');assert.equal(s.body,'첫 줄 둘째');assert.equal(s.focus,2);
  s=roundSummary([U,{id:2,role:'assistant',replyTo:1,adapter:'codex',status:'done',approvalRequested:true,text:'[승인 요청] rm 이 필요해요'}],1);
  assert.equal(s.kind,'ask');assert.equal(s.title,'✋ ChatGPT가 허락을 기다려요');assert.equal(s.body,'rm 이 필요해요');
  s=roundSummary([U,{id:2,role:'assistant',replyTo:1,adapter:'claude',kind:'plan',status:'done',text:'{}'},{id:3,role:'assistant',replyTo:2,adapter:'codex',kind:'task',status:'done',text:'t'},{id:4,role:'assistant',replyTo:1,adapter:'claude',kind:'final',status:'done',text:'종합 결과'}],1);
  assert.equal(s.title,'✅ 팀 작업 끝 · Claude 종합');assert.equal(s.focus,4);
  assert.equal(roundSummary([U,{id:2,role:'assistant',replyTo:1,adapter:'claude',status:'cancelled'}],1),null,'긴급 중지는 알리지 않음');
});

test('화면: 서비스 워커·매니페스트·알림 시트, 보고 있음 신호, 서버 연결', async()=>{
  const read=f=>readFile(new URL('../'+f,import.meta.url),'utf8');
  const [html,app,sw,man,srv]=await Promise.all(['public/index.html','public/app.js','public/sw.js','public/manifest.webmanifest','src/server.mjs'].map(read));
  assert.match(html,/rel="manifest"/);assert.match(html,/id="m-push"/);assert.match(html,/id="push"/);
  assert.equal(JSON.parse(man).display,'standalone');
  assert.match(sw,/addEventListener\('push'/);assert.match(sw,/notificationclick/);
  assert.match(app,/register\('\/sw\.js'\)/);assert.match(app,/userVisibleOnly:true/);assert.match(app,/\/api\/presence/);
  assert.match(srv,/finally\(\(\)=>notifyRound\(ctx,userMsg\.id\)\)[^\n]*\n  return userMsg;/);
  assert.equal((srv.match(/notifyRound\(ctx,userMsg\.id\)/g)??[]).length,2,'모두에게·팀장 둘 다');
  assert.match(srv,/if\(!sum\|\|watching\(ctx\)\)return;/,'화면을 보고 있으면 안 보냄');
});
