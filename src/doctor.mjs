// 설치 점검. 질문은 보내지 않고, 비밀값은 출력하지 않는다.
// v0.4: 로그인 상태는 사용자별(data/users/<id>/home)이라 여기서는 보지 않는다 — 화면의 "인증 확인" 버튼을 쓴다.
import {loadConfig,probeAdapter,buildChildEnv} from './adapters/index.mjs';
const config=await loadConfig();
console.log(`Node ${process.version}`);
for(const a of config.adapters){
  const r=await probeAdapter(a);
  const {blockedNames}=buildChildEnv(process.env,a);
  console.log(`${r.installed?'✔':'✖'} ${a.label.padEnd(18)} ${a.command}  ${r.installed?r.version:'설치 안 됨 또는 PATH에 없음'}${a.enabled?'':'  (비활성)'}${a.login?'':'  (화면 로그인 명령 미설정 → 호출 차단)'}`);
  if(blockedNames.length)console.log(`   차단된 부모 환경변수(값 미출력): ${blockedNames.join(', ')}`);
}
console.log('\n각 사용자는 화면의 "CLI 로그인" 버튼으로 자기 폴더(data/users/<id>/home)에 로그인합니다. 허브는 "subscription" 으로 확인된 어댑터만 호출합니다.');
console.log('플래그·인증 패턴이 다르면 config/adapters.json 의 args / authCheck / login 을 설치된 버전에 맞게 고치세요.');
