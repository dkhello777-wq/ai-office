// Antigravity CLI(agy) 로그인 래퍼 (v0.8.2). agy 에는 login 명령이 없고, 터미널이 아니면 "fail fast" 한다. 대신 가짜 터미널(script) 안에서 -p 로 띄우면
// "Authentication required. Please visit the URL to log in:" + Google OAuth URL 을 출력하고 "paste the authorization code here" 로 코드를 기다린다 (Linux 1.4.2 검증).
// 제약: agy 는 코드 입력을 60초만 기다리고 "authentication timed out" 으로 끝난다. 그러면 이 래퍼가 자동으로 다시 띄운다(새 URL — 화면에는 최신 URL 이 맨 앞).
// 코드가 맞으면 agy 는 바로 확인용 프롬프트를 실행하고 JSON 으로 status SUCCESS 를 내며 종료 → exit 0. 토큰은 agy 가 알아서 저장한다(컨테이너엔 D-Bus 가 없어 파일 저장으로 폴백 — 로그에서 확인).
import {spawn} from 'node:child_process';

const MAX_ROUNDS=Number(process.env.AGY_LOGIN_ROUNDS||8);
const PROMPT='로그인 확인입니다. 도구를 쓰지 말고 "OK" 한 단어만 답하세요.';
let round=0,finished=false,child=null;
process.stdin.on('data',d=>{try{child?.stdin.write(d);}catch{}});
process.stdin.on('end',()=>{});
const stripAnsi=s=>String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'');
function launch(){
  round++;
  if(round>MAX_ROUNDS){process.stdout.write('\nagy-login: 시도 횟수 초과. 참여자에서 다시 연결하기를 눌러 주세요.\n');process.exit(1);}
  let buf='';
  // script -q 조용히, -e 자식 종료코드 반환, -c 명령; 기록 파일은 /dev/null. 프롬프트는 -p= 로 붙여 넘긴다(agy 는 -p 뒤 인자를 프롬프트로 삼는다).
  child=spawn('script',['-qec',`agy --output-format json --print-timeout 120s -p=${JSON.stringify(PROMPT)}`,'/dev/null'],{env:{...process.env,TERM:'xterm-256color'},stdio:['pipe','pipe','pipe']});
  child.on('error',e=>{console.error('agy-login: '+(e.code==='ENOENT'?'script(bsdutils) not found':'spawn failed'));process.exit(3);});
  child.stdout.on('data',d=>{buf+=d;process.stdout.write(d);});
  child.stderr.on('data',d=>{buf+=d;process.stderr.write(d);});
  child.on('close',code=>{
    if(finished)return;
    const text=stripAnsi(buf);
    let ok=false;for(const line of text.split(/\r?\n/)){const t=line.trim();if(!t.startsWith('{'))continue;try{const j=JSON.parse(t);if(j&&j.status==='SUCCESS')ok=true;}catch{}}
    if(ok){finished=true;process.stdout.write('\nAntigravity login complete.\n');return process.exit(0);}
    if(/authentication timed out|authentication failed or timed out/i.test(text)){process.stdout.write(`\n[${round}/${MAX_ROUNDS}] 60초 안에 코드가 들어오지 않아 새 로그인 URL 을 다시 받습니다. 위에 새로 뜨는 URL 로 진행하세요.\n`);return setTimeout(launch,500);}
    finished=true;process.exit(code??1);
  });
}
launch();
