// 테스트용 가짜 CLI. 실제 AI 없이 허브의 흐름을 확인한다. 비밀값·네트워크 없음.
// 모드(인자): --version | --auth-status | --login | --mode <normal|split|fail|badjson|envdump>
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('mock-cli 0.4.0');process.exit(0);}
// --login: 실제 CLI 의 device/URL 로그인처럼 URL 과 코드를 출력하고 stdin 에서 'OK' 한 줄을 기다린 뒤 $HOME/.mock-auth 에 표식을 남긴다.
if(args[0]==='--login'){
  process.stdout.write('Open https://mock.invalid/device in your browser\nEnter code: MOCK-1234\nWaiting for authentication...\n');
  const line=await new Promise(r=>{let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{d+=c;if(d.includes('\n'))r(d.split('\n')[0]);});process.stdin.on('end',()=>r(d));});
  if(line.trim()!=='OK'){process.stderr.write('mock login rejected\n');process.exit(2);}
  mkdirSync(process.env.HOME,{recursive:true});writeFileSync(join(process.env.HOME,'.mock-auth'),JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'}));
  process.stdout.write('Logged in.\n');process.exit(0);
}
if(args[0]==='--auth-status'){
  // Claude `auth status` 와 같은 JSON 형식. MOCK_AUTH 는 테스트가 envAllow 로 명시적으로 넘길 때만 보인다.
  // MOCK_AUTH_JSON 이 있으면 그 문자열을 그대로 출력(배포 config 파서에 대한 fixture 주입용). stderr 경고도 함께 낸다.
  process.stderr.write('warning: synthetic stderr noise\n');
  if(process.env.MOCK_AUTH_JSON){process.stdout.write(process.env.MOCK_AUTH_JSON);process.exit(0);}
  // MOCK_AUTH 가 없으면 $HOME/.mock-auth 표식(--login 으로 생성)을 본다 → 사용자별 HOME 격리 검증용
  if(!process.env.MOCK_AUTH){try{process.stdout.write(readFileSync(join(process.env.HOME??'','.mock-auth'),'utf8'));}catch{console.log(JSON.stringify({loggedIn:false}));}process.exit(0);}
  const mode=process.env.MOCK_AUTH;
  const fixtures={subscription:{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'},apikey:{loggedIn:true,authMethod:'api_key',apiProvider:'firstParty',subscriptionType:null},none:{loggedIn:false,authMethod:null,apiProvider:null,subscriptionType:null}};
  console.log(JSON.stringify(fixtures[mode]??fixtures.subscription));
  process.exit(0);
}
const mi=args.indexOf('--mode');const mode=mi>=0?args[mi+1]:'normal';
let prompt=args.find(a=>!a.startsWith('--')&&a!==args[args.indexOf('--session')+1]&&a!==mode)??'';
if(!prompt&&!process.stdin.isTTY){prompt=await new Promise(r=>{let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>r(d));});}
const si=args.indexOf('--session');
const session=si>=0?args[si+1]:'mock-'+Math.random().toString(16).slice(2,10);
const write=(stream,buf)=>new Promise(r=>stream.write(buf,r));
if(mode==='split'){
  // 다중 바이트 문자를 바이트 경계에서 쪼개 보낸다 (F4 재현용)
  const text=JSON.stringify({text:'가나다😀 한글 응답 '.repeat(300),session,usage:null});
  const bytes=Buffer.from(text,'utf8');
  for(let i=0;i<bytes.length;i+=1){await write(process.stdout,bytes.subarray(i,i+1));}
  const errBytes=Buffer.from('경고: 다중바이트 stderr 😀\n','utf8');
  for(let i=0;i<errBytes.length;i+=1){await write(process.stderr,errBytes.subarray(i,i+1));}
  process.exit(0);
}
if(mode==='fail'){
  await write(process.stdout,'BEGIN-STDOUT '+'x'.repeat(9000)+' END-STDOUT\n');
  await write(process.stderr,'BEGIN-STDERR '+'y'.repeat(9000)+' END-STDERR\n');
  process.exit(3);
}
if(mode==='badjson'){await write(process.stdout,'{"text": "unterminated');process.exit(0);}
if(mode==='envdump'){
  const keys=Object.keys(process.env).filter(k=>/^(HUB_REVIEW_MARKER|FAKE_API_KEY|FAKE_BASE_URL|PATH)$/.test(k)).sort();
  console.log(JSON.stringify({text:'env:'+keys.join(','),session,usage:null}));process.exit(0);
}
// v0.5 오케스트레이터 모의: 서버가 보내는 단계 표식에 맞춰 계획 JSON / 종합 답변을 낸다.
//   HUB:PLAN      → 프롬프트의 [팀원] 목록에서 id 를 읽어 팀원마다 작업 1개씩 계획 (MOCK_PLAN=direct 면 tasks 비우고 answer 로 직접 답, MOCK_PLAN=garbage 면 JSON 아님)
//   HUB:SYNTHESIZE→ 받은 결과들을 한 줄씩 인용해 종합
//   HUB:TASK      → 작업 제목을 되읊음
if(/^### HUB:PLAN/m.test(prompt)){
  const ids=[...prompt.matchAll(/^- "([^"]+)":/gm)].map(m=>m[1]);
  let text;
  if(process.env.MOCK_PLAN==='garbage')text='계획을 세우겠습니다. (JSON 없음)';
  else if(process.env.MOCK_PLAN==='direct')text=JSON.stringify({tasks:[],note:'직접 답함',answer:'[mock 팀장 직접 답변] 팀원 없이 처리했습니다.'});
  else text='계획입니다.\n```json\n'+JSON.stringify({tasks:ids.map((id,i)=>({worker:id,title:`작업${i+1} for ${id}`,prompt:`[mock 지시] ${id} 가 할 일 ${i+1}`})),note:'팀원마다 하나씩',answer:null},null,1)+'\n```';
  console.log(JSON.stringify({text,session,usage:{input:prompt.length,output:text.length}}));process.exit(0);
}
if(/^### HUB:SYNTHESIZE/m.test(prompt)){
  const lines=[...prompt.matchAll(/^--- 작업 (\d+): ([^·]+)·/gm)].map(m=>`작업${m[1]} ${m[2].trim()}`);
  const text=`[mock 종합] 결과 ${lines.length}건 종합: ${lines.join(' / ')}`;
  console.log(JSON.stringify({text,session,usage:{input:prompt.length,output:text.length}}));process.exit(0);
}
const text=`[mock 답변] 받은 프롬프트 ${prompt.length}자. 세션 ${session}.\n첫 줄: ${prompt.split('\n')[0].slice(0,80)}`;
if(mode==='stream'){   // 부분 출력 스트리밍 확인용: JSON 을 조각내어 천천히 보낸다
  const full=JSON.stringify({text,session,usage:{input:prompt.length,output:text.length}});
  for(let i=0;i<full.length;i+=12){await write(process.stdout,full.slice(i,i+12));await new Promise(r=>setTimeout(r,40));}
  process.exit(0);
}
console.log(JSON.stringify({text,session,usage:{input:prompt.length,output:text.length}}));
