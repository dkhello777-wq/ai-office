// v0.10 Grok Build CLI(grok) 인증 상태. grok 에는 상태 명령이 없어 로그인 파일의 "모양"만 본다 — 토큰 값은 읽어 내보내지 않는다.
// 출력: {loggedIn, mode, reason?} 한 줄.
//  - mode 'account'  : ~/.grok/auth.json 에 grok.com 세션 토큰 계열 키(access/refresh/session/id token)가 있음 → 구독 로그인
//  - mode 'api-key'  : auth.json 에 api_key 만 있거나, ~/.grok/config.toml 에 모델별 api_key/env_key 가 있음 → 차단(구독만 허용)
// XAI_API_KEY 환경변수는 허브가 자식 프로세스에 넘기지 않는다(ENV_DENY_PATTERNS 의 /API_KEY$/). 또 grok -p(헤드리스)는 grok.com 세션을 요구한다.
import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
const out=o=>{process.stdout.write(JSON.stringify(o)+'\n');process.exit(0);};
if(!process.env.HOME&&!process.env.GROK_HOME)out({loggedIn:false,mode:null,reason:'home_missing'});
const dir=process.env.GROK_HOME||path.join(process.env.HOME,'.grok');
try{const toml=readFileSync(path.join(dir,'config.toml'),'utf8');if(/^\s*(api_key|env_key)\s*=/m.test(toml))out({loggedIn:false,mode:'api-key',reason:'config_api_key'});}catch{}
let raw;
try{if(statSync(path.join(dir,'auth.json')).size<=2)out({loggedIn:false,mode:null,reason:'auth_empty'});raw=readFileSync(path.join(dir,'auth.json'),'utf8');}
catch{out({loggedIn:false,mode:null,reason:'auth_missing'});}
let d;try{d=JSON.parse(raw);}catch{out({loggedIn:true,mode:'account',reason:'auth_unparsed'});}   // 형식이 바뀌어도 파일이 있으면 로그인으로 본다(호출이 실패하면 드러남)
const keys=new Set();
(function walk(v,depth){if(!v||typeof v!=='object'||depth>6)return;for(const [k,x] of Object.entries(v)){if(x!==null&&x!==''&&x!==undefined)keys.add(k.toLowerCase());walk(x,depth+1);}})(d,0);
const session=['access_token','refresh_token','session_token','id_token','accesstoken','refreshtoken'].some(k=>keys.has(k));
if(session)out({loggedIn:true,mode:'account'});
if(keys.has('api_key')||keys.has('apikey'))out({loggedIn:false,mode:'api-key',reason:'auth_api_key'});
out({loggedIn:false,mode:null,reason:'no_session_token'});
