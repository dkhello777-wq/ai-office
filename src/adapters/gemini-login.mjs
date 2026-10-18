// Gemini CLI 로그인 래퍼 (v0.8). Gemini CLI 0.64 에는 `login` 서브커맨드가 없고, 헤드리스(-p)에서는 인증을 시작하지 않는다
// ("Manual authorization is required but the current session is non-interactive"). 대신 대화형 모드를 가짜 터미널(script) 아래서
// NO_BROWSER=true 로 띄우면 Google OAuth URL 을 출력하고 "Enter the authorization code:" 로 코드를 기다린다 (Linux 0.64.0 검증).
// 이 래퍼는: 1) settings.json 에 Google 계정 로그인(oauth-personal)을 지정 2) script 로 pty 를 만들어 gemini 실행 3) 허브가 stdin 으로 넘긴 코드를 pty 로 전달
// 4) $HOME/.gemini/oauth_creds.json 이 생기면 로그인 완료로 보고 gemini 를 종료 (대화형 화면으로 넘어가지 않게). 출력은 그대로 stdout 으로 흘려 허브가 URL 만 뽑는다.
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import path from 'node:path';

const home=process.env.HOME;
if(!home){console.error('gemini-login: HOME missing');process.exit(2);}
const dir=path.join(home,'.gemini');mkdirSync(dir,{recursive:true,mode:0o700});
const settingsPath=path.join(dir,'settings.json');
let settings={};try{settings=JSON.parse(readFileSync(settingsPath,'utf8'));}catch{}
settings.security={...(settings.security??{}),auth:{...(settings.security?.auth??{}),selectedType:'oauth-personal'}};
writeFileSync(settingsPath,JSON.stringify(settings,null,2),{mode:0o600});

const creds=path.join(dir,'oauth_creds.json');
const before=existsSync(creds)?statSync(creds).mtimeMs:0;
// script -q: 조용히, -e: 자식 종료 코드 반환, -c: 명령. 기록 파일은 /dev/null.
const child=spawn('script',['-qec','gemini','/dev/null'],{env:{...process.env,NO_BROWSER:'true',TERM:'xterm-256color',GEMINI_CLI_TRUST_WORKSPACE:'true'},stdio:['pipe','pipe','pipe']});
child.on('error',e=>{console.error('gemini-login: '+(e.code==='ENOENT'?'script(bsdutils) not found':'spawn failed'));process.exit(3);});
child.stdout.on('data',d=>process.stdout.write(d));child.stderr.on('data',d=>process.stderr.write(d));
process.stdin.on('data',d=>{try{child.stdin.write(d);}catch{}});
let finished=false;
const finish=code=>{if(finished)return;finished=true;clearInterval(poll);try{child.kill('SIGTERM');}catch{}setTimeout(()=>{try{child.kill('SIGKILL');}catch{}process.exit(code);},1500);};
const poll=setInterval(()=>{
  try{const st=statSync(creds);if(st.mtimeMs>before&&st.size>0){process.stdout.write('\nGemini login complete.\n');finish(0);}}catch{}
},1000);
child.on('close',code=>{if(finished)return;clearInterval(poll);process.exit(existsSync(creds)&&statSync(creds).mtimeMs>before?0:(code??1));});
