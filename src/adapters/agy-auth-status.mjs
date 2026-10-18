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
const child=spawn('agy',['models','--output-format','json'],{env:process.env,stdio:['ignore','pipe','pipe']});
let so='',se='';child.stdout.on('data',d=>so+=d);child.stderr.on('data',d=>se+=d);
const t=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}out({loggedIn:false,mode,reason:'timeout'});},25000);
child.on('error',e=>{clearTimeout(t);out({loggedIn:false,mode,reason:e.code==='ENOENT'?'agy_not_found':'spawn_failed'});});
child.on('close',code=>{
  clearTimeout(t);
  const all=(so+'\n'+se).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
  if(code===0){let n=null;try{const j=JSON.parse(so);n=Array.isArray(j)?j.length:Array.isArray(j?.models)?j.models.length:null;}catch{}return out({loggedIn:true,mode,models:n});}
  if(/sign in|not logged in|authentication required/i.test(all))return out({loggedIn:false,mode,reason:'not_signed_in'});
  out({loggedIn:false,mode,reason:'exit_'+code});
});
