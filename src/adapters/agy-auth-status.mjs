// Antigravity CLI(agy) 인증 상태 (v0.8.2). agy 에는 상태 명령이 없지만 `agy models` 가 로그인 없이는 exit 1 + "Please sign in" 을 낸다(Linux 1.4.2 검증).
// 토큰 값은 절대 읽지 않는다. 출력: {loggedIn, mode, tier?, reason?} 한 줄.
//  - mode: settings.json(~/.gemini/antigravity-cli/settings.json) 의 modelProvider 가 'gemini' 면 'gemini-api-key'(차단), AGY_ADC_AUTH 가 켜져 있으면 'adc'(차단), 그 외 'account'.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import path from 'node:path';
const home=process.env.HOME;
const out=o=>{process.stdout.write(JSON.stringify(o)+'\n');process.exit(0);};
if(!home)out({loggedIn:false,mode:null,reason:'home_missing'});
let mode='account';
try{const s=JSON.parse(readFileSync(path.join(home,'.gemini/antigravity-cli/settings.json'),'utf8'));if(s?.modelProvider==='gemini')mode='gemini-api-key';}catch{}
if(process.env.AGY_ADC_AUTH)mode='adc';
if(mode!=='account')out({loggedIn:false,mode});
// v0.8.4: 실배포에서 로그인(SUCCESS)이 됐는데도 `agy models` 가 exit 1 을 내는 경우가 있어, 1차로 agy 의 파일 저장소(auth.json — 컨테이너엔 D-Bus 가 없어 파일로 폴백)의 **존재만** 확인한다. 내용은 읽지 않는다.
import {readdirSync,statSync} from 'node:fs';
function findAuthFile(dir,depth){let out=[];let ents=[];try{ents=readdirSync(dir,{withFileTypes:true});}catch{return out;}for(const e of ents){const p=path.join(dir,e.name);if(e.isDirectory()){if(depth>0&&!/^(log|logs|cache|crashes|updater|plugins|builtin|worktrees|tmp)$/.test(e.name))out=out.concat(findAuthFile(p,depth-1));}else if(/^auth\.json$/.test(e.name)){try{if(statSync(p).size>2)out.push(p);}catch{}}}return out;}
const authFiles=[...findAuthFile(path.join(home,'.gemini/antigravity-cli'),3),...findAuthFile(path.join(home,'.config/antigravity'),3)];
if(authFiles.length)out({loggedIn:true,mode,via:'auth_file',files:authFiles.length});
// 2차: 허브 로그인 래퍼가 SUCCESS 를 확인했을 때 남기는 표식(비밀값 없음). 토큰이 나중에 만료·로그아웃되면 호출이 실패로 드러나고, 사용자가 다시 연결하면 된다.
try{if(statSync(path.join(home,'.gemini/antigravity-cli/hub-login-ok')).size>=0)out({loggedIn:true,mode,via:'hub_marker'});}catch{}
const child=spawn('agy',['models'],{env:process.env,stdio:['ignore','pipe','pipe']});
let so='',se='';child.stdout.on('data',d=>so+=d);child.stderr.on('data',d=>se+=d);
const t=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}out({loggedIn:false,mode,reason:'timeout'});},25000);
child.on('error',e=>{clearTimeout(t);out({loggedIn:false,mode,reason:e.code==='ENOENT'?'agy_not_found':'spawn_failed'});});
child.on('close',code=>{
  clearTimeout(t);
  const all=(so+'\n'+se).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
  if(code===0)return out({loggedIn:true,mode,via:'agy_models'});   // 1.4.2 의 models 는 --output-format 을 받지 않는다(실배포에서 exit 1 로 확인) — 종료 코드만 본다
  if(/sign in|not logged in|authentication required/i.test(all))return out({loggedIn:false,mode,reason:'not_signed_in'});
  out({loggedIn:false,mode,reason:'exit_'+code+': '+all.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0,100)});
});
