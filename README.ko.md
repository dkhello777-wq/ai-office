# AI Hub v0.6.2 — 구독 중인 AI들을 한 화면에서 (다인용 · 메모리 · 예산 · 오케스트레이터)

허브를 한 대(맥 또는 서버)에 켜 두고, 각자 **자기 계정**으로 브라우저(PC/폰)에서 접속해 Claude / ChatGPT(Codex) / Gemini 와 동시에 대화합니다. 사용자마다 대화·파일·AI 로그인이 **자기 폴더 안에서만** 돌아가므로 A 의 구독이 B 에게 섞이지 않습니다. 한 AI의 답변을 버튼 하나로 다른 AI에게 검토시킬 수 있습니다.

API 키·토큰 과금이 아니라, 각 회사의 **공식 CLI**를 각 사용자의 구독 계정으로 로그인해 씁니다. 웹 채팅 화면을 자동 조작하지 않습니다.

## 1. 준비 (허브 컴퓨터, 한 번만)

1. Node.js 22 이상 (`node --version`)
2. 세 CLI 설치 (로그인은 **설치할 때가 아니라** 각 사용자가 화면에서 합니다)
   - Claude Code: `npm install -g @anthropic-ai/claude-code`
   - Codex CLI: `npm install -g @openai/codex`
   - Gemini CLI: `npm install -g @google/gemini-cli`
3. 이 폴더에서 `npm run doctor` → 설치된 CLI 가 ✔ 인지 확인

## 2. 실행과 첫 계정

```sh
npm start
```
콘솔에 **최초 관리자 가입용 초대 코드**(24시간, 1회용)가 찍힙니다(`data/bootstrap-invite` 에도 저장, 0600). 브라우저에서 http://127.0.0.1:8787 → "초대 코드로 가입" 에 그 코드와 아이디·비밀번호(10자 이상)를 넣으면 관리자 계정이 됩니다. 가입이 끝나면 그 코드는 소멸하고 파일도 지워집니다.

## 3. 다른 사람 초대

관리자 화면의 **관리 → "사용자 초대 코드 발급"**. 코드는 발급 순간 한 번만 보이고(서버에는 해시만 저장), 7일 안에 1회 사용할 수 있습니다. 받은 사람은 같은 주소에서 "초대 코드로 가입". 누구나 가입하는 방식은 없습니다(`signup.mode=invite`). 관리자는 초대 코드 취소, 사용자 중지/허용을 할 수 있고, 다른 사용자의 대화·파일은 **관리자도 보지 못합니다**(서버 파일 시스템에서만 접근 가능).

## 4. 각 사용자의 AI 로그인 (화면 안에서)

각 AI 패널의 **"CLI 로그인"** 버튼 → 허브가 그 사용자의 폴더(`data/users/<id>/home`)를 HOME 으로 해서 공식 로그인 명령을 실행하고, 출력 중 **URL 과 일회용 코드만** 화면에 보여줍니다. 사용자는 그 URL 을 자기 브라우저(폰이면 폰)에서 열어 자기 구독 계정으로 로그인합니다. CLI 가 코드 붙여넣기를 요구하면 박스의 입력칸에 넣고 "전송". 끝나면 허브가 인증 상태를 다시 확인해 패널 머리에 표시합니다.

- Claude: `claude auth login` (설정 폴더 `CLAUDE_CONFIG_DIR={home}/.claude`)
- Codex: `codex login --device-auth` (`CODEX_HOME={home}/.codex`). ChatGPT 설정 → Security 에서 device code 로그인이 허용돼 있어야 합니다. `codex exec resume <ID> --json -` 는 Codex 0.158 도움말로 확인됨(GPT 재검증). 실제 계정의 2턴 대화 지속은 맥에서 확인.
- Gemini: 비대화형 로그인·상태 명령을 확인하지 못해 비워 둠 → 확인 전까지 호출 차단.

로그인 명령의 원문 출력은 그 사용자의 `runs/login-*/`(0600) 에만 남습니다. **두 명령의 실제 출력 형식은 허브 컴퓨터에서 1회 확인이 필요합니다**(아래 9절).

## 5. 안전장치 (v0.2–v0.4)
- **계정 필수**: 세션 쿠키 없이는 모든 API 가 401. 비밀번호는 scrypt 해시만 저장, 로그인 10회 실패 시 15분 잠금, 세션 30일.
- **변경 요청 게이트**: Host 허용 목록(`allowedHosts`) · Origin 일치 · JSON 형식까지 확인한 뒤에만 처리(가입·로그인 포함).
- **사용자 격리**: `data/users/<id>/`(0700) 아래 `home/`(CLI 설정·로그인) · `workspace/shared/`(파일) · `state.json`(대화) · `runs/`(증거). CLI 는 그 사용자의 workspace 를 작업 폴더로, home 을 HOME 으로 받습니다. 다른 사용자의 로그인·파일·대화는 API 로 닿지 않습니다.
- **구독 인증 확인**: 호출 직전마다 그 사용자의 HOME 으로 `authCheck` 를 실행해 구조화 파서로 판정. Claude 는 `loggedIn=true`·`authMethod=claude.ai`·`apiProvider=firstParty`·`subscriptionType` 문자열일 때만 호출. `api_key`/`third_party`/미로그인/불명확 → 차단.
- **환경 격리**: 자식 CLI 에는 허용 목록 환경변수만. `*_API_KEY`, `*_BASE_URL`, `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*`, `GOOGLE_*` 등은 절대 전달하지 않음(이름만 기록).
- **실행 증거**: 시도마다 `runs/<메시지ID>-<AI>/` 에 stdout/stderr 원문 전체와 meta.json(0600). 증거 저장 실패는 성공으로 치지 않음. 절삭·요약 없음.
- **UTF-8**: 바이트 수집 후 스트림 디코딩.

### 격리의 한계 (솔직하게)
- 모든 사용자의 CLI 가 **같은 OS 계정**으로 실행됩니다. 폴더 분리(0700)는 다른 OS 사용자를 막지만, 어떤 사용자가 자기 AI 에게 "../다른 폴더를 읽어라" 고 시키면 CLI 의 권한 체계에 따라 읽힐 수 있습니다. 믿을 수 있는 소수(가족·팀)용입니다. 불특정 다수용은 사용자별 OS 계정 또는 컨테이너 분리가 필요합니다(다음 단계).
- macOS 에서 Claude Code 는 로그인 정보를 키체인에 둘 수 있습니다. `CLAUDE_CONFIG_DIR` 로 분리되는지 **반드시** 확인(9절 체크 3). 분리되지 않으면 Claude 는 1인용으로 두고 Codex 만 다인용으로 쓰세요.

## 6. 사용법 (v0.5 추가분 포함)
- **동시 전송** (기본): 입력창 → 선택한 AI 전부에게 동시에. 패널별로 답변.
- **오케스트레이터**: 입력창 위에서 모드를 바꾸고 팀장 AI 를 고른 뒤 팀원 AI 를 체크 → 목표 한 줄만 보내면 ① 팀장이 계획(JSON) → ② 서버가 팀원에게 병렬 분배 → ③ 팀장이 결과를 종합. 세 단계 모두 일반 호출과 같은 인증·예산·증거 규칙. 팀장이 JSON 을 안 내면 `plan_parse_failed` 로 멈추고 본문만 보여준다(팀원 호출 없음). 팀장이 혼자 답할 수 있으면 tasks 를 비우고 바로 답한다.
- **메모리**: 상단 "메모리" → `workspace/memory.md` 편집. 이 내용이 **이 계정의 모든 프롬프트 앞에** 붙는다(CLI 도 작업 폴더에서 같은 파일을 읽을 수 있음). 답변 카드의 "메모리에 추가" 로 답변 전문을 날짜와 함께 덧붙인다. `memory.maxChars`(기본 20,000자)를 넘으면 경고만(주입은 계속).
- **토큰 예산**: 상단에 이번 달 사용량(입력+출력)/상한. 상한은 `config budget.monthlyTokens`(0=무제한) 또는 관리자가 사용자별로. 넘으면 호출 전에 `budget_exceeded` 로 차단(CLI 실행 없음). usage 를 안 주는 CLI 는 0 으로 잡히므로 그 경우 상한은 보조 수단.
- **부분 출력**: 어댑터에 `stream` 파서가 있으면(기본: codex `jsonl`, mock) 답변이 끝나기 전에 지금까지 받은 본문을 패널에 먼저 보여준다. 최종 답변·증거는 종료 후 전체 stdout 으로 확정(부분 텍스트는 저장 안 함). Claude 는 `--output-format json` 이라 부분 출력이 없고, stream-json 으로 바꾸는 방법은 config 의 `_스트리밍` 참고(미검증).
- **내 파일**: 업로드하면 내 `workspace/shared/` 에 저장. 클릭해 선택하면 메시지에 경로가 첨부되고 CLI 가 직접 읽습니다.
- **"→ ○○에게 검토 요청"**: 답변 전문을 다른 AI 에게 넘김. **"파일로 저장"**, **"새 대화"**, **"복사"**.
- PC 는 패널 나란히, 폰은 상단 탭. 폰에서 "홈 화면에 추가" 하면 앱처럼 열립니다.

## 6-000. v0.6.1 → v0.6.2 (GPT 3차 G01·G02)
- 저장 파일 내부 값 검증: 세션·초대의 만료 시각은 실제 날짜로 해석돼야 하고(아니면 손상), 사용 시점에도 `NaN` 은 만료로 취급. 메시지 id 유일성, usage 의 input/output/calls 는 비음수 정수, epochs·sessions 값 형식. 사용자 role/createdAt/budget, 초대 role/usedBy/usedAt/revoked 형식.
- 서버 종료: 종료 대기 중인 프로세스 그룹(직접 자식이 이미 close 된 것 포함)을 즉시 SIGKILL, 살아 있는 자식은 SIGTERM→1초→SIGKILL 을 전부 보낸 뒤에 exit. 같은 자식에 더 짧은 유예로 재요청하면 마감을 앞당김.
- 테스트 59 → 65.

## 6-00. v0.6 → v0.6.1 (GPT 재검증 F01~F05)
- 저장 파일 필수 구조 검증: accounts(users/invites 배열, nextUserId 정수 > 모든 id, 사용자 id 유일), sessions(sessions 객체), state(messages 배열, nextId 정수 > 모든 메시지 id). `{}` 같은 "문법은 맞지만 빈" 파일도 손상으로 거부.
- 프로세스 그룹 종료: 직접 자식이 먼저 끝나도 유예 뒤 그룹 SIGKILL (SIGTERM 무시하는 손자 처리).
- 계정 중지: 큐 대기·인증 확인·실행을 하나의 취소 수명으로. 인증 확인 중 중지되면 모델을 띄우지 않고 `cancelled`, 대기 중이던 요청도 `cancelled` 로 끝남(재활성화 뒤 running 잔존 없음).
- 로그인 직렬화 정리 Promise 의 미처리 거부 제거(저장 실패가 프로세스를 죽이지 않음).
- Codex `exec resume <ID> --json -` 문법은 GPT 가 실제 0.158 도움말로 확인(미검증 해제). 테스트 52 → 59.

## 6-0. v0.5 → v0.6 에서 고친 것 (GPT 검수 R01~R12 + Gemini 검수 FAIL 1~5)
- **Codex 연결**: `login status` 가 stderr 로 나오므로 인증 판정이 stdout+stderr 를 본다(파서별 기본, `authCheck.output` 으로 조정). 세션 재개는 `codex exec resume <ID>` 서브커맨드(`resumeMode: replace`). `turn.completed` 의 usage 를 예산에 집계. 사용자 workspace 를 `git init`(codex 요구 조건).
- **계정·보호**: 같은 키의 로그인을 직렬화해 동시 실패 카운트가 유실되지 않음. 손상된 accounts/state 파일은 빈 상태로 덮지 않고 시작/요청을 거부(ENOENT 만 최초 실행). 계정 중지 시 진행 중 CLI 실행을 끊고(프로세스 그룹) 오케스트레이터 다음 단계도 만들지 않음. `/files/` 의 html·svg·js 는 다운로드 강제 + `CSP sandbox` + nosniff.
- **실행 통제**: targets 중복 제거, 사용자별 동시 실행 상한(`limits.concurrentPerUser`), 업로드·글자 수 상한. 타임아웃·취소는 프로세스 그룹 전체에 SIGTERM→SIGKILL, 손자가 파이프를 잡아도 close 를 강제. "새 대화" 뒤 늦게 끝난 실행이 옛 세션을 되살리지 않음(epoch).
- **오케스트레이터**: 계획 JSON 검증 강화(유효 작업도 answer 도 없으면 실패, 복수 코드 펜스, 버린 작업 수 표시), 팀원 프롬프트에 첨부 목록, 모든 팀원 실패 시 종합 생략.
- **화면**: SSE (재)연결 때 서버 스냅샷을 id 로 병합해 끊긴 동안 놓친 완료·예산 복구. `maskLine` 이 `access_token` 류와 URL `#` 프래그먼트도 가림. 메모리 쓰기 직렬화, `messageId:null` 메모 허용.
- 테스트 35 → 52 (`test/codex-review.test.mjs` = GPT 검수 12개, R03 만 replace 모드에 맞춰 더 강하게 수정).

## 6-1. v0.4 → v0.5 에서 고친 것 (Gemini 독립 검수 FAIL 9건)
동시 가입 경쟁(초대 코드 1회성·아이디 중복) 직렬화 · 로그인 잠금 키 trim 정규화 · 로그인 증거 저장 실패는 오류(R3) · 로그인 마지막 줄 마스킹+종료 시 비움 · SIGTERM→3초 뒤 SIGKILL · 부트스트랩 초대 폐기(전원 중지 시 재발급 없음) · userContext 초기화 경쟁 제거, 중지/로그아웃 시 SSE·로그인 프로세스 종료 · 저장 체인 오류 복구 · `.`/`..` 파일명 금지, state.json 0600, TMPDIR/APPDATA 사용자별 분리. 각 항목은 `npm test` 의 `audit:` 테스트가 재현한다.


## 7. 폰·외부에서 쓰기 (별도 승인 후)
기본은 127.0.0.1 전용. 외부 노출은 승인된 방식(Cloudflare Tunnel + Access 등)으로만 하고, 그때 `HUB_ALLOWED_HOSTS=허브.hostname` 로 Host 허용 목록을 맞춥니다. HTTPS 뒤에서는(`x-forwarded-proto: https`) 쿠키에 Secure 가 붙습니다.

## 8. 설정 (`config/adapters.json`)
- `args`/`resumeArgs`/`parse`: 호출 인자와 출력 파서. 프롬프트는 stdin.
- `authCheck`: 비밀값 없는 상태 명령 + 파서. `login`: 화면 로그인 명령. `perUserEnv`: `{home}` 치환으로 사용자별 설정 폴더.
- `users.dir`, `signup.mode`(invite), `loginTimeoutMs`, `authCacheMs`(0 = 매번 확인).
- v0.5: `roleHint`(팀장이 분배할 때 보는 역할 한 줄), `stream`(부분 출력 파서 이름), `budget.monthlyTokens`, `memory.maxChars`, `orchestrate.maxTasks`.
- v0.6: `resumeMode`(`append`|`replace`), `authCheck.output`(`stdout`|`stderr`|`both`), `limits.{uploadBytes,textChars,concurrentPerUser}`.

## 9. 허브 컴퓨터에서 1회 확인할 것 (미검증 항목)
1. `npm test` 65/65.
2. `npm start` → 콘솔 초대 코드로 관리자 가입 → **관리** 에서 초대 코드 발급 → 다른 브라우저/폰에서 두 번째 계정 가입.
3. 계정 A 에서 Claude "CLI 로그인" → URL 이 뜨는지, 코드 입력이 필요한지, 끝난 뒤 패널에 "구독 로그인 확인" 이 뜨는지. **계정 B 에서는 여전히 "로그인 안 됨" 이어야 함**(키체인 공유 여부 확인). B 로도 로그인해 둘 다 각자 계정으로 뜨는지.
4. Codex 동일(`--device-auth` 가 거부되면 ChatGPT 설정에서 허용 후 재시도).
5. 각 계정에서 1회 메시지: "연결 확인입니다. 도구 실행·파일 접근·웹 검색 없이 OK 한 단어만 답하세요."
6. 실패하면 답변 카드 "실행 증거" 의 폴더에서 stdout/stderr 원문 확인(로컬에서만 보기).

## 10. 구조
```
src/server.mjs        허브 (HTTP + SSE), 계정 게이트, 사용자별 컨텍스트, CLI 로그인 중계
src/accounts.mjs      계정·초대 코드·세션 (scrypt, 해시만 저장)
src/adapters/         CLI 실행·파싱·인증 확인·로그인·부분 출력 파서 (index.mjs), 테스트용 가짜 CLI (mock-cli.mjs)
src/orchestrate.mjs   팀장 답변에서 계획 JSON 추출
src/store.mjs         대화·세션·월별 사용량(토큰 예산)
public/               화면 — 가입/로그인, 패널, CLI 로그인 박스, 관리자
config/adapters.json  AI 목록과 명령
data/users/<id>/      사용자별 home / workspace/shared / workspace/memory.md / state.json / runs
test/                 가짜 CLI 로 전체 흐름 검증 (npm test)
```

## 11. 아직 없는 것
- Claude 부분 출력(stream-json 전환 미검증) · 비밀번호 변경/재설정 · 사용자별 OS 계정 격리 · 대화 검색/내보내기 · Gemini 로그인 명령 확인 · 오케스트레이터 작업 간 의존(지금은 전부 병렬·독립) · 스케줄 실행(무인)
