// v0.9.2 구글 드라이브로 보내기. 파일함(shared)의 파일을 사람이 버튼으로 드라이브의 "AI 오피스" 폴더에 올린다.
// - AI 에게는 드라이브 권한을 주지 않는다. 업로드는 서버가 사용자 요청(버튼)으로만 한다.
// - 권한 범위는 drive.file 하나: 이 앱이 만든 파일·폴더만 보고 고칠 수 있다(드라이브의 다른 파일은 못 본다). Google 분류상 non-sensitive.
// - 로그인은 기기 코드 방식(TV·입력 제한 기기용 OAuth 클라이언트): 화면에 코드와 주소가 뜨고, 폰에서 열어 허용하면 끝 — AI 연결과 같은 흐름.
// - 설정: 환경변수 GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET. 없으면 기능이 꺼진다(손님 방 기본값).
// - 저장: data/gdrive.json (0600) — refresh token 과 폴더 id. 연결 해제 시 토큰을 Google 에 폐기 요청하고 파일을 지운다.
import {readFile,writeFile,rename,unlink,chmod,stat} from 'node:fs/promises';
import path from 'node:path';

const SCOPE='https://www.googleapis.com/auth/drive.file';
const DEVICE_URL='https://oauth2.googleapis.com/device/code';
const TOKEN_URL='https://oauth2.googleapis.com/token';
const REVOKE_URL='https://oauth2.googleapis.com/revoke';
const FILES_URL='https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL='https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME='application/vnd.google-apps.folder';
export const GDRIVE_UPLOAD_MAX=200*1024*1024;

const form=o=>new URLSearchParams(o).toString();
const err=(code,extra={})=>Object.assign(new Error(code),extra);

export class GDrive{
  constructor({dataDir,clientId=process.env.GDRIVE_CLIENT_ID,clientSecret=process.env.GDRIVE_CLIENT_SECRET,folderName='AI 오피스',fetchImpl=globalThis.fetch,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms)}){
    this.file=path.join(dataDir,'gdrive.json');
    this.clientId=String(clientId??'').trim();this.clientSecret=String(clientSecret??'').trim();
    this.folderName=folderName;this.fetch=fetchImpl;this.now=now;this.setTimer=setTimer;
    this.data=null;this.pending=null;this.lastError=null;this.access=null;
  }
  get configured(){return !!(this.clientId&&this.clientSecret);}
  get connected(){return !!this.data?.refreshToken;}
  async load(){
    try{const d=JSON.parse(await readFile(this.file,'utf8'));if(d&&typeof d.refreshToken==='string'&&d.refreshToken)this.data=d;}
    catch(e){if(e.code!=='ENOENT')console.error('gdrive.json 을 읽지 못함 — 다시 연결하세요',e.message);}
  }
  async save(){const tmp=this.file+'.tmp';await writeFile(tmp,JSON.stringify(this.data),{mode:0o600});await chmod(tmp,0o600);await rename(tmp,this.file);}
  status(){
    const p=this.pending&&this.pending.expiresAt>this.now()?{userCode:this.pending.userCode,verificationUrl:this.pending.verificationUrl,expiresAt:new Date(this.pending.expiresAt).toISOString()}:null;
    return {configured:this.configured,connected:this.connected,pending:p,folderUrl:this.data?.folderId?`https://drive.google.com/drive/folders/${this.data.folderId}`:null,connectedAt:this.data?.connectedAt??null,lastError:this.lastError};
  }
  async _json(r){const t=await r.text();try{return JSON.parse(t);}catch{return {raw:t.slice(0,200)};}}

  // ---- 연결: 기기 코드 발급 → 백그라운드로 토큰 폴링 ----
  async connect(){
    if(!this.configured)throw err('gdrive_not_configured');
    if(this.pending&&this.pending.expiresAt>this.now())return this.status();
    const r=await this.fetch(DEVICE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({client_id:this.clientId,scope:SCOPE})});
    const j=await this._json(r);
    if(!r.ok||!j.device_code)throw err('gdrive_device_failed',{detail:j.error??r.status});
    const p={deviceCode:j.device_code,userCode:j.user_code,verificationUrl:j.verification_url??j.verification_uri,expiresAt:this.now()+Number(j.expires_in??1800)*1000,interval:Math.max(5,Number(j.interval??5))};
    this.pending=p;this.lastError=null;
    this._schedule(p);
    return this.status();
  }
  _schedule(p){this.setTimer(()=>this._poll(p).catch(e=>{if(this.pending===p){this.pending=null;this.lastError=e.message;}}),p.interval*1000);}
  async _poll(p){
    if(this.pending!==p)return;   // 취소·재시작됨
    if(p.expiresAt<=this.now()){this.pending=null;this.lastError='gdrive_code_expired';return;}
    const r=await this.fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({client_id:this.clientId,client_secret:this.clientSecret,device_code:p.deviceCode,grant_type:'urn:ietf:params:oauth:grant-type:device_code'})});
    const j=await this._json(r);
    if(r.ok&&j.refresh_token){
      if(this.pending!==p)return;
      if(typeof j.scope==='string'&&!j.scope.split(' ').includes(SCOPE))throw err('gdrive_scope_denied');
      this.data={refreshToken:j.refresh_token,folderId:this.data?.folderId??null,connectedAt:new Date(this.now()).toISOString()};
      this.access={token:j.access_token,until:this.now()+(Number(j.expires_in??3600)-60)*1000};
      await this.save();this.pending=null;this.lastError=null;return;
    }
    if(j.error==='authorization_pending'){this._schedule(p);return;}
    if(j.error==='slow_down'){p.interval+=5;this._schedule(p);return;}
    throw err(j.error==='access_denied'?'gdrive_access_denied':'gdrive_token_failed',{detail:j.error});
  }
  cancel(){this.pending=null;}

  async disconnect(){
    const tok=this.data?.refreshToken;this.pending=null;this.access=null;this.data=null;
    try{await unlink(this.file);}catch{}
    if(tok){try{await this.fetch(REVOKE_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({token:tok})});}catch{}}
    return this.status();
  }

  async _token(){
    if(!this.connected)throw err('gdrive_not_connected');
    if(this.access&&this.access.until>this.now())return this.access.token;
    const r=await this.fetch(TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form({client_id:this.clientId,client_secret:this.clientSecret,refresh_token:this.data.refreshToken,grant_type:'refresh_token'})});
    const j=await this._json(r);
    if(!r.ok||!j.access_token){
      if(j.error==='invalid_grant'){this.data=null;this.access=null;try{await unlink(this.file);}catch{}throw err('gdrive_reconnect_required');}   // 사용자가 권한을 거둠·만료
      throw err('gdrive_token_failed',{detail:j.error??r.status});
    }
    this.access={token:j.access_token,until:this.now()+(Number(j.expires_in??3600)-60)*1000};
    return this.access.token;
  }
  async _folder(tok){
    const id=this.data.folderId;
    if(id){
      const r=await this.fetch(`${FILES_URL}/${encodeURIComponent(id)}?fields=id,trashed`,{headers:{Authorization:`Bearer ${tok}`}});
      if(r.ok){const j=await this._json(r);if(!j.trashed)return id;}
    }
    const r=await this.fetch(`${FILES_URL}?fields=id`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({name:this.folderName,mimeType:FOLDER_MIME})});
    const j=await this._json(r);if(!r.ok||!j.id)throw err('gdrive_folder_failed',{detail:j.error?.message??r.status});
    this.data.folderId=j.id;await this.save();return j.id;
  }
  // 파일 하나를 폴더에 올린다 (resumable: 크기와 무관하게 같은 경로). 같은 이름이 있어도 새 파일로 올린다(드라이브는 이름 중복 허용).
  async upload(filePath,name,mimeType='application/octet-stream'){
    const st=await stat(filePath);if(!st.isFile())throw err('file_not_found');
    if(st.size>GDRIVE_UPLOAD_MAX)throw err('gdrive_file_too_large',{max:GDRIVE_UPLOAD_MAX});
    const tok=await this._token();const folder=await this._folder(tok);
    const init=await this.fetch(`${UPLOAD_URL}?uploadType=resumable&fields=id,name,webViewLink`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType,'X-Upload-Content-Length':String(st.size)},body:JSON.stringify({name,parents:[folder]})});
    const loc=init.headers.get('location');
    if(!init.ok||!loc)throw err('gdrive_upload_failed',{detail:(await this._json(init)).error?.message??init.status});
    const bytes=await readFile(filePath);
    const put=await this.fetch(loc,{method:'PUT',headers:{'Content-Type':mimeType,'Content-Length':String(bytes.length)},body:bytes});
    const j=await this._json(put);
    if(!put.ok||!j.id)throw err('gdrive_upload_failed',{detail:j.error?.message??put.status});
    return {id:j.id,name:j.name??name,link:j.webViewLink??`https://drive.google.com/file/d/${j.id}/view`};
  }
}
