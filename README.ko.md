# AI 오피스 v0.7.3 — 구독 중인 AI 들을 단톡방 하나에서 (1인용 · 클라우드)

내 서버 한 대에 띄워 두고, 폰·PC 브라우저로 접속해 **내가 구독 중인 AI 들과 단톡방처럼** 대화합니다. 참여자는 내가 연결한 AI 수만큼: Claude 만 있으면 1:1, ChatGPT(Codex) 까지 연결하면 3인 방.

- **모두에게**: 연결된 AI 전부에게 동시에 보내고 각자 답변 말풍선
- **팀장에게**: 팀장 AI 가 받아서 팀원에게 나누고(② 작업) 종합(③)
- **@클로드 …**: 이름을 부르면 그 AI 에게만
- 답변마다 **→ 다른 AI 검토** · 🧠 기억(메모리) · 💾 저장 · 복사
- API 키·토큰 과금이 아니라 **각 회사 공식 CLI 를 내 구독 계정으로 로그인**해 씁니다 (Claude Code · Codex CLI). 웹 화면을 자동 조작하지 않습니다.

v0.6 의 다인용(계정·초대·관리자)은 뺐습니다. 서버 = 사무실 = 사람 하나. 비밀번호 하나로 들어옵니다.

## 1. 클라우드에 올리기 (Railway 기준, 10분)

1. 이 폴더를 GitHub 저장소로 올립니다 (private 권장).
2. Railway → New Project → Deploy from GitHub repo → 이 저장소. `Dockerfile` 과 `railway.json` 을 자동으로 씁니다.
3. **Variables** 에 추가:
   - `HUB_PASSWORD` = 들어올 때 쓸 비밀번호 (10~256자). 잘못된 값이면 서버가 시작하지 않습니다.
   - 안 넣으면 서버 로그에 **1회용 설정 코드**가 찍힙니다. 첫 화면 "AI 오피스 만들기"에 그 코드 + 비밀번호를 넣어야 주인이 됩니다 (코드 없이는 아무도 못 만듭니다).
   - (선택) `HUB_MONTHLY_TOKENS` 월 토큰 상한. 화면 메뉴에서 정해도 됩니다.
4. Railway 는 프록시 뒤라 `HUB_TRUST_PROXY=1` 을 추가 (로그인 잠금이 접속자별로, 쿠키 Secure). 플랫폼 프록시 IP 를 알면 `HUB_TRUSTED_PROXIES` 에도.
5. **Volume** 추가: mount path `/app/data`. ⚠️ 이게 없으면 재배포 때마다 AI 로그인·대화가 날아갑니다.
6. Settings → Networking → **Generate Domain**. 그 주소를 폰에서 열면 끝. "홈 화면에 추가" 하면 앱처럼 열립니다.

다른 Docker 호스트(Hetzner, Fly, 집 NAS 등)도 같습니다: `docker build -t ai-office . && docker run -p 8787:8787 -v office-data:/app/data -e HUB_PASSWORD=... ai-office`.

## 2. 참여자 연결 (각 AI 한 번씩)

오른쪽 위 아바타 → **참여자** → 각 AI 의 **연결하기**.

- **Claude**: 서버가 `claude auth login` 을 띄우고 화면에 **URL** 이 뜹니다. 폰에서 그 URL 을 열어 Claude 구독 계정으로 로그인 → 화면에 나온 코드를 입력칸에 붙여넣고 전송. 끝나면 "● 연결됨 · pro/max".
- **ChatGPT (Codex)**: `codex login --device-auth`. 미리 ChatGPT 웹 → Settings → Security 에서 **device code 로그인 허용**이 켜져 있어야 합니다. URL 열고 코드 입력.
- **Gemini** (v0.8): Gemini CLI 에는 로그인 명령이 없어서 허브가 가짜 터미널 안에서 `gemini` 를 `NO_BROWSER` 로 띄웁니다. 화면에 뜨는 **Google 로그인 URL** 을 열어 Gemini 를 쓰는 Google 계정으로 로그인 → 마지막에 보이는 **인증 코드**(`4/0A…` 꼴)를 입력칸에 붙여넣고 전송. 로그인 상태는 상태 명령 대신 `~/.gemini/settings.json`(Google 계정 로그인인지)과 `oauth_creds.json`(refresh_token 유무만)으로 판정합니다. API 키·Vertex 는 차단. Google Workspace 계정은 Google Cloud 프로젝트를 요구할 수 있어 개인 Gmail 계정을 권합니다. 세션 이어가기(2턴 기억)는 Gemini 만 아직 없음 — 매 호출 memory.md 와 원문으로 맥락을 줍니다.

로그인 정보는 서버의 `/app/data/users/1/home/` 아래에만 저장됩니다. 허브는 토큰을 읽지 않고, 호출 직전마다 공식 CLI 의 **상태 명령**(`claude auth status`, `codex login status`; Gemini 는 설정·자격 파일의 종류만 확인)으로 "구독 로그인"인지만 확인한 뒤 호출합니다. API 키 모드·서드파티 인증이면 차단합니다.

## 3. 쓰는 법

| 하고 싶은 것 | 어떻게 |
|---|---|
| 여러 AI 답을 비교 | 입력창 위 **모두에게** 켜고 보내기 |
| 한 AI 에게만 | `@클로드 …`, `@코덱스 …` (한국어·영어 별칭 모두 됨) |
| 팀으로 일 시키기 | 참여자에서 **팀장으로** 지정 → 입력창 위 **팀장에게** → 목표 한 줄 |
| A 의 답을 B 가 검토 | A 답변 아래 **→ B 검토** |
| 파일 주기 | 📎 로 올리면 이번 메시지에 첨부. AI 가 작업 폴더에서 직접 읽음 |
| 항상 기억시키기 | 메뉴 → 🧠 메모리 (모든 메시지 앞에 붙음) · 답변 아래 🧠 기억 |
| 비용 통제 | 메뉴 → 📊 토큰 예산 (월 상한, 넘으면 호출 전 차단) |

## 4. 안전장치 (v0.6 에서 이어받음)

- 세션 쿠키 없이는 모든 API 401. 비밀번호는 scrypt 해시만, 10회 실패 시 15분 잠금, 세션 30일.
- 변경 요청은 Origin 일치 + JSON 형식 확인 뒤에만 (CSRF 방어). `HUB_ALLOWED_HOSTS=*` 는 Host 목록 검사만 끕니다.
- 자식 CLI 에는 허용 목록 환경변수만. `*_API_KEY`, `*_TOKEN`, `ANTHROPIC_*`, `OPENAI_*`, `GEMINI_*` 등은 절대 전달 안 함.
- 실행마다 `runs/<메시지ID>-<AI>/` 에 stdout/stderr 원문 전체 보존 (답변 아래 "실행 증거").
- 호출 직전 인증 확인 → 예산 확인 → 실행. 둘 중 하나라도 막히면 CLI 를 띄우지 않습니다.
- 종료 시 자식 프로세스 그룹까지 정리 (SIGTERM → SIGKILL).

## 5. 설정 · 환경변수

| 변수 | 뜻 | 기본 |
|---|---|---|
| `HUB_PASSWORD` | 최초 비밀번호 (이미 있으면 무시, 잘못되면 시작 거부) | 없음 → 로그의 설정 코드로 화면에서 설정 |
| `HUB_MONTHLY_TOKENS` | 월 토큰 상한 (0 이상 정수) | 0 = 무제한 |
| `PORT` / `HOST` | 수신 포트·주소 | Docker: 8787 / 0.0.0.0 |
| `HUB_ALLOWED_HOSTS` | Host 허용 목록(콤마) 또는 `*` | Docker: `*` |
| `HUB_TRUST_PROXY` | `1` 이면 x-forwarded-for/proto 를 믿음. **프록시 뒤에서만** 켜고, 직접 노출된 서버에선 끔 | Docker: `0` |
| `HUB_TRUSTED_PROXIES` | 신뢰할 프록시 IP/CIDR 목록(콤마). 있으면 소켓 상대가 이 안에 있을 때만 헤더를 믿고, XFF 는 오른쪽부터 이 목록에 없는 첫 값을 씀 | 비움 = 모든 peer (프록시가 직접 노출을 막는 플랫폼에서만) |

`config/adapters.json`: AI 목록·명령·파서·역할 한 줄(`roleHint`). 새 AI 는 항목 하나 추가.

## 6. 개발

```sh
npm test          # 60개 (가짜 CLI 로 전체 흐름)
npm run doctor    # 설치된 CLI 확인
npm start         # http://127.0.0.1:8787
```

구조: `src/server.mjs`(HTTP+SSE, 게이트, 오케스트레이터, CLI 로그인 중계) · `src/owner.mjs`(비밀번호·세션) · `src/adapters/`(CLI 실행·파싱·인증 확인) · `src/store.mjs`(대화·사용량) · `public/`(단톡방 화면).

## 7. v0.7.0 → v0.7.1 (독립 검수 V01~V21 반영)

21건 전부 수정. 검수자의 재현 스크립트를 수정본에 다시 돌려 전부 반전됨을 확인했고, 같은 시나리오를 `test/v071-audit.test.mjs` 16개로 고정했다 (테스트 60 → 76).

| ID | 고친 것 |
| --- | --- |
| V01 | 비밀번호 변경 시 열린 SSE 전부 종료, SSE 는 20초마다 세션 유효성 재확인, 화면도 게이트로 나가면 스트림 닫음 |
| V02 | `owner.json` 에 `authVersion` 을 비밀번호 해시와 한 번에 커밋. 세션은 발급 당시 버전을 품고, 버전이 다르면 무효 (세션 파일 정리 실패와 무관) |
| V03 | 존재하는 `owner.json` 은 salt 16B·hash 64B·createdAt·authVersion 이 전부 유효해야 함. 아니면 `accounts_corrupt` 로 시작 거부 |
| V04 | 잘못된 `HUB_PASSWORD` 면 시작 거부. 비밀번호 없으면 1회용 설정 코드(로그·`data/setup-code`) 없이는 `/api/setup` 403. `/healthz` 는 `{ok:true}` 만 |
| V05 | `HUB_TRUST_PROXY=1` 일 때만 `x-forwarded-for`(잠금 키)·`x-forwarded-proto`(Secure 쿠키) 신뢰 |
| V06 | 본문 리더가 청크마다 누적 바이트 검사 → JSON 64KB, 업로드 `limits.uploadBytes` 초과 시 즉시 413. 비밀번호 256자 상한 |
| V07 | `COPY workspace` 제거 (작업 폴더는 서버가 `data/users/1/workspace` 에 만든다) |
| V08 | 엔트리포인트가 root 로 `/app/data` 소유권을 맞춘 뒤 `gosu` 로 node(1000) 로 내려감. `tini` 가 PID 1 |
| V09 | 인증 확인을 실행과 같은 작업 폴더(cwd)에서 수행 → 프로젝트 설정으로 인증 방식이 갈라지지 않음 |
| V10 | 로그인 URL 의 `#프래그먼트` 제거, 쿼리에 access/refresh/id 토큰 키가 있으면 화면에 안 보냄 (OAuth state·code_challenge 는 유지) |
| V11 | 시간 초과가 exit 0 보다 우선 → `cli_timeout` / `login_timeout` |
| V12 | 직접 자식이 끝나면 프로세스 그룹에 즉시 SIGKILL (한 번 실행하는 CLI 에서 자식보다 오래 살 정당한 손자는 없음) |
| V13 | 완료 상태는 `state.json` 저장이 끝난 뒤에만 알림. 저장 실패 → `persist_failed` 오류 (본문은 메모리에만, `unstoredAnswer`) |
| V14 | 재시작 시 남은 `running` 메시지는 `interrupted` 오류로 닫음 (자동 재실행 없음) |
| V15 | 컨텍스트 생성 때 인증 상태를 비동기로 갱신 → 재배포 뒤에도 참여자가 바로 "연결됨". 확인 전엔 "확인 중" |
| V16 | 월 상한은 API·`setBudget`·로드·`HUB_MONTHLY_TOKENS` 모두 `Number.isSafeInteger(n) && n>=0` |
| V17 | Claude `cache_read/cache_creation_input_tokens` 를 입력에 합산 (Codex `cached_input_tokens` 는 중복이라 제외) |
| V18 | 같은 AI 의 일반 대화는 어댑터별 직렬 큐. 팀장 분배의 ② 작업은 세션을 쓰지도 남기지도 않음 |
| V19 | 메시지마다 단조 증가 `seq`. 화면은 seq 가 큰 쪽만 받고, seq 없는 옛 데이터는 끝난 상태를 되돌리지 않음 |
| V20 | 멘션은 문장 시작/공백 뒤 `@` + 별칭 전체 일치(+에게·한테·야·님·아·씨). 이메일·`@scope/pkg` 제외 |
| V21 | Node 22.22.0, claude-code 2.1.302, codex 0.163.0, gemini-cli 0.64.0 고정 |

**검수가 지적했지만 코드로 못 닫은 것**: 실제 Claude/Codex 의 비 TTY 로그인 완주, Railway 프록시 뒤 SSE, 재배포 후 2턴 이어가기는 실제 배포에서만 확인 가능 (테스트 가이드 2·3단계). TTY 가 꼭 필요하면 PTY 중계(`node-pty`)를 v0.8 에서.

### v0.7.1 → v0.7.2 (재검수 V22~V25)

| ID | 고친 것 |
| --- | --- |
| V22 | v0.7.0 데이터 마이그레이션: `authVersion` 없는 owner.json 은 1 을 붙여 원자적으로 저장, `v` 없는 옛 세션은 폐기(재로그인). 어느 지점에서 끊겨도 재시작 가능 |
| V23 | 로그인은 검증 시작 시점의 해시·버전을 잡고, 끝났을 때 바뀌어 있으면 거부. 세션은 잡아 둔 버전으로 발급 → 변경 전 발급된 세션도 커밋 즉시 무효 |
| V24 | `HUB_TRUST_PROXY` 기본 0. `HUB_TRUSTED_PROXIES` 로 신뢰 peer 제한, XFF 는 오른쪽부터 읽어 클라이언트가 앞에 붙인 값 무시, IP 형식 검증. 키를 돌려도 전체 실패 20회/분 뒤 1분간 전부 429 |
| V25 | SIGTERM 뒤 유예 중인 그룹은 close 가 와도 예약된 SIGKILL 시점을 지킴 (손자의 정리 시간 보장). 정상 종료 뒤 잔존 프로세스 즉시 정리는 유지 |

### v0.7.2 → v0.7.3 (재검수 V26·V27)

| ID | 고친 것 |
| --- | --- |
| V26 | `HUB_TRUSTED_PROXIES` 항목이 하나라도 잘못되면(`/33`, 빈 prefix, IP 아님) 시작 거부. 잘못된 항목을 조용히 버려 "모든 peer 신뢰"로 바뀌는 일 없음. `/0` 은 명시했을 때만 |
| V27 | 직접 짠 CIDR 파서 제거 → Node 내장 `net.BlockList` (`src/trusted.mjs`). IPv4-mapped IPv6(`::ffff:a.b.c.d`), 압축 표기, embedded IPv4 모두 정확히 비교 |

### v0.7.4 → v0.8.0

| ID | 고친/더한 것 |
| --- | --- |
| V29 | Gemini 화면 연결: `src/adapters/gemini-login.mjs`(pty + NO_BROWSER, URL 출력까지 Linux 검증) · `gemini-auth-status.mjs`(파일 기반 판정, 토큰 값은 출력 안 함) · `-o json` 의 `stats.models` 토큰 합산 · 로그인 힌트에서 토큰 교환 endpoint 제외 |
| UI | 팀장 모드의 ① 계획 말풍선은 분배 요약만 보이고 계획 JSON 원문은 접어 둠(검토·기억 버튼도 없음). 답은 ③ 종합에만 |

## 8. 아직 없는 것 (v0.8 후보)

- Gemini 세션 이어가기(`--resume` 이 ID 가 아니라 번호라 보류) · Grok
- 승인 큐: "돈 쓰기·삭제 전엔 물어봐" 를 방 안의 [승인]/[거부] 버튼으로
- Claude 부분 출력(stream-json), 도구 권한 모드(`--permission-mode`) 설정
- 푸시 알림, 대화 검색·내보내기, 스케줄 실행
