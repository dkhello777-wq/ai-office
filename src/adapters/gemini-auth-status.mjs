// Gemini CLI 인증 상태 (v0.8). Gemini CLI 0.64 에는 비밀값 없는 `auth status` 명령이 없어서, 사용자 HOME 의 설정·자격 파일만 보고 판정한다.
// 출력은 비밀값 없는 JSON 한 줄: {loggedIn, authType, hasRefreshToken, expired}. 토큰 값은 절대 출력하지 않는다.
//  - settings.json security.auth.selectedType: oauth-personal(Google 계정 로그인) 만 허용. gemini-api-key / vertex-ai / 기타는 차단.
//  - oauth_creds.json: refresh_token 이 있으면 로그인 상태(만료된 access_token 은 CLI 가 알아서 갱신).
import {readFileSync} from 'node:fs';
import path from 'node:path';
const home=process.env.HOME;
const out=o=>{process.stdout.write(JSON.stringify(o)+'\n');process.exit(0);};
if(!home)out({loggedIn:false,authType:null,reason:'home_missing'});
const dir=path.join(home,'.gemini');
let authType=null;
try{const s=JSON.parse(readFileSync(path.join(dir,'settings.json'),'utf8'));authType=s?.security?.auth?.selectedType??s?.selectedAuthType??null;}catch{}
let creds=null;try{creds=JSON.parse(readFileSync(path.join(dir,'oauth_creds.json'),'utf8'));}catch{}
if(!creds||typeof creds!=='object')out({loggedIn:false,authType,reason:'no_credentials'});
const hasRefreshToken=typeof creds.refresh_token==='string'&&creds.refresh_token.length>0;
const expired=typeof creds.expiry_date==='number'?creds.expiry_date<Date.now():null;
out({loggedIn:hasRefreshToken||(expired===false&&typeof creds.access_token==='string'),authType:authType??'oauth-personal',hasRefreshToken,expired});
