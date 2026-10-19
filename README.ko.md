# AI 오피스 v0.10.5 — 구독 중인 AI 들을 단톡방 하나에서 (1인용 · 클라우드)

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
- **Gemini (Antigravity)** (v0.8.2): Gemini CLI 는 2026년 6월부터 개인 Google 계정 로그인을 거부합니다(`IneligibleTierError`). 그래서 구글이 개인용 후속으로 안내하는 **Antigravity CLI(`agy`)** 를 씁니다 — Google AI Pro/Ultra 구독(무료 플랜도 가능하다고 안내됨)의 Google 계정으로 로그인. **연결하기** → 화면의 Google URL 을 열고 로그인 → 인증 코드를 입력칸에 붙여넣고 전송. ⚠️ agy 는 코드를 **60초**만 기다립니다. 시간이 지나면 새 URL 이 자동으로 뜨니 그 URL 로 다시 하면 됩니다(미리 그 계정으로 Google 에 로그인해 두면 10초면 끝). 로그인 상태는 `agy models` 가 성공하는지로만 판정하고, API 키 모드(`modelProvider: gemini`)·ADC 는 차단. 세션은 `--conversation <id>` 로 이어갑니다.

로그인 정보는 서버의 `/app/data/users/1/home/` 아래에만 저장됩니다. 허브는 토큰을 읽지 않고, 호출 직전마다 공식 CLI 의 **상태 명령**(`claude auth status`, `codex login status`; Gemini 는 `agy models` 성공 여부)으로 "구독 로그인"인지만 확인한 뒤 호출합니다. API 키 모드·서드파티 인증이면 차단합니다.

## 3. 쓰는 법

| 하고 싶은 것 | 어떻게 |
|---|---|
| AI 끼리 서로의 말을 보게 | 기본 켜짐(v0.8.5). 매 호출에 최근 대화가 같이 들어가서 "Claude 말에 덧붙이면…" 식으로 이어 말한다. 메뉴 → 💬 방 대화 공유 에서 끄면 각자 사용자 메시지만 본다 |
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
| V29 | Gemini 화면 연결 1차(Gemini CLI + pty 로그인). 실배포에서 로그인은 되지만 호출이 `IneligibleTierError` 로 거부됨 → v0.8.2 에서 교체. 남은 것: 로그인 힌트에서 토큰 교환 endpoint 제외·최신 URL 우선 |
| v0.8.1 | 실패한 답변 말풍선에 CLI stderr 꼬리(가림 처리)를 표시 |
| v0.8.3–4 | 로그인 종료 후 CLI 마지막 출력·종료 코드 표시 · 참여자 상태에 판정 이유 · agy 인증 판정 수정(`agy models` 는 `--output-format` 을 받지 않아 항상 exit 1 이었음) + auth 파일/허브 표식 폴백 |
| V31 | **v0.8.5 방 대화 공유**: 매 호출 프롬프트 앞에 최근 대화(사용자 + 다른 AI 의 완료 답변, 최근 20개·6천 자)를 붙여 AI 끼리 서로의 말을 보고 이어 말한다. 메뉴 → 💬 방 대화 공유 로 끄기. 팀장 내부 단계(①계획·②작업)는 제외. Gemini `--mode plan` 제거('/plan 모드' 멘트 방지) |
| V30 | **v0.8.2** Gemini → Antigravity CLI(`agy`) 교체: `src/adapters/agy-login.mjs`(pty, 60초 타임아웃 자동 재시도) · `agy-auth-status.mjs`(`agy models` 로 판정, API 키/ADC 차단) · `--input-format stream-json` 으로 프롬프트를 stdin NDJSON 전달 · result 이벤트 파서·usage 정규화 · `--conversation` 재개. Dockerfile 이 공식 스크립트로 agy 설치 |
| UI | 팀장 모드의 ① 계획 말풍선은 분배 요약만 보이고 계획 JSON 원문은 접어 둠(검토·기억 버튼도 없음). 답은 ③ 종합에만 |

### v0.8.6 → v0.8.7 (코딩·검수 환경 — 2026-10-18 실배포 사례 반영)

팀장 모드로 코딩을 시켰더니 다섯 작업이 전부 '완료'인데 결과물이 없었다. 원인은 코드가 아니라 실행 환경 셋.

| 문제 | 고친 것 |
| --- | --- |
| Codex: `bwrap: Creating new namespace failed: Permission denied` — Codex 자체 샌드박스(bubblewrap)가 컨테이너에서 user namespace 를 못 만들어 **파일 읽기조차 실패**, 기본 정책이 읽기 전용이라 쓰기도 불가 | `codex exec` / `exec resume` 에 `--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`. 컨테이너가 이미 격리돼 있으므로 공식 플래그 설명(externally sandboxed 환경용)대로 내부 샌드박스를 끈다. 명령 출력에 bwrap 오류가 보이면 `sandbox_failed` 로 실패 처리 |
| Gemini(agy): 빈 결과 3회 연속 — 헤드리스에서 도구 승인 요청이 전부 자동 거부돼 `status SUCCESS` + `response ""` | `--dangerously-skip-permissions` 로 자동 승인. 본문이 빈 답변은 `empty_result` 로 실패 처리(어느 CLI 든) |
| Claude: `-p` 비대화형에서 권한 요청에 답할 사람이 없어 파일 쓰기·명령 실행이 자동 거부 + 이미지에 **Python 없음** | `--permission-mode acceptEdits` + `--allowedTools Bash WebSearch WebFetch` + `--disallowedTools` 로 **삭제 명령(rm·rmdir·shred·git clean/reset --hard/push --force)과 과금 가능 CLI(railway·gcloud·aws·az·fly·vercel·heroku·npm publish·stripe)** 거부. Dockerfile 에 Python 3.11 · pip · venv · pytest · make · jq · unzip |
| 사용자 지시: **파일 삭제·추가 과금은 내 허락을 받아라** | 모든 프롬프트(일반·팀장 ①②③) 끝에 [행동 규칙] — 삭제·비우기·과금이 필요하면 멈추고 답변을 `[승인 요청]` 으로 시작해 무엇을 왜 하려는지 쓰게 한다. 서버는 그 답변을 `approvalRequested` 로 표시하고 화면에 ✋ 띠를 띄운다. 사용자가 다음 메시지로 허락하면 진행. Claude 는 위 거부 목록으로 기술적으로도 막히고(확인: `rm` 은 denied, `echo`·`python3`·파일 쓰기는 통과), Codex·agy 는 명령 거부 목록 기능이 없어 규칙 프롬프트로만 전달된다 |
| '완료' 판정이 "CLI 가 exit 0" 뿐이라 실패한 작업도 완료로 보임 | 빈 본문 → `empty_result`, 샌드박스 오류 → `sandbox_failed`. 파서의 고정 오류 코드(`agy_status_*` 등)는 그대로 화면에 |
| 팀원이 "실행은 못 해봤다" 로 끝냄 | ② 작업 프롬프트에 [작업 환경] 안내 — 실행·테스트가 가능하니 실제로 돌리고, 안 되면 오류를 그대로 적게. `npm run doctor` 가 Python·pytest·git 도 점검 |

세 CLI 모두 **읽기·수정·새 파일 생성·테스트 실행은 승인 없이** 한다(삭제·과금만 [승인 요청]). 이 허브가 1인용 격리 컨테이너(비root `node` 사용자, 작업 폴더는 `/app/data/users/1/workspace`)에서만 돌아간다는 전제이며, 공유 서버나 호스트에 직접 띄울 때는 플래그를 빼야 한다. 회귀 테스트: `test/v087-coding-env.test.mjs`.

### v0.8.7 → v0.8.8 (긴급 중지 · python 이름)

| 더한 것 | 내용 |
| --- | --- |
| 🛑 **긴급 중지** | AI 가 하나라도 돌고 있으면 화면 위쪽에 빨간 **긴급 중지** 버튼이 뜬다. 누르면 확인창 없이 즉시 `POST /api/stop` → 돌고 있는 CLI 전부를 프로세스 그룹째 끊고(SIGTERM→3초 뒤 SIGKILL) 대기열도 비운다. 끊긴 답변은 `⏹ 중지됨`, 이미 끝난 답변은 그대로. 팀장 모드는 `haltSeq` 로 ②분배·③종합 단계로 넘어가지 않고 계획 말풍선에 "긴급 중지로 멈춤" 표시. 로그인 진행은 건드리지 않는다. 테스트: `v087-coding-env.test.mjs` 의 emergency stop |
| `python` 이름 | 이미지에 `python-is-python3` 추가 — AI 가 `python` 으로 불러도 된다(Debian 기본은 `python3` 만). 팀원 작업 프롬프트의 [작업 환경] 에 설치 도구 목록과 "환경에 대한 과거 대화('Python 없음' 등)는 믿지 말고 직접 확인" 을 넣었다(방 대화 공유 때문에 옛 답변을 따라 말하는 것 방지) |

### v0.8.8 → v0.8.9 (긴 글 접기)

7줄 또는 700자를 넘는 말풍선(내 메시지·AI 답변)은 처음 7줄만 보이고 아래가 흐려지며 **▼ 전체 보기 · N줄** 버튼이 붙는다. 누르면 펼치고 **▲ 접기** 로 다시 접는다. 본문은 그대로 전부 저장·전달되며(복사·💾 저장·→ 검토·🧠 기억 모두 전문) 화면 표시만 접는다. 펼친 상태는 새 메시지가 와도 유지된다. 수정 파일: `public/app.js`(clip·expanded), `public/style.css`(.clip, .clip-btn).

### v0.8.9 → v0.9.0 (저장 공간 안전장치)

2026-10-19 데이터 볼륨(당시 500MB)이 꽉 차 `evidence_write_failed`·`No space left on device` 로 작업이 실패한 사례 반영. `src/janitor.mjs` 가 서버 시작 30초 뒤, 10분마다, 그리고 AI 실행이 끝날 때마다(사용률이 높을 때만) 정리한다.

| 규칙 | 기본값 (`config/adapters.json` 의 `storage`) |
| --- | --- |
| 사용률이 이만큼 넘으면 정리 시작 | 70% (`highPct`) |
| 여기 아래가 될 때까지 오래된 것부터 삭제 | 50% (`lowPct`) |
| 이보다 오래된 기록은 항상 삭제 | 30일 (`maxAgeDays`) |
| 최근 이 시간 안에 바뀐 것은 보호 | 6시간 (`protectHours`) |

**지우는 것**: 실행 증거(`runs/`), Codex·Claude CLI 의 대화 기록 파일(`home/.codex/sessions`·`.codex/log`·`.claude/projects`). **지우지 않는 것**: 작업 폴더의 파일, memory.md, 이 방의 대화(state.json), 로그인 정보. 지울 기록이 바닥났는데도 사용률이 높으면 서버 로그에 "아직 높음"을 남긴다(이때는 작업 폴더를 사람이 정리). 메뉴 → 💽 저장 공간 에서 사용률·마지막 정리를 보고 "지금 정리"(같은 규칙)를 누를 수 있다. API: `GET /api/storage`, `POST /api/storage/cleanup`. 테스트: `test/v090-janitor.test.mjs`.

### v0.9.0 → v0.9.1 (화면 다듬기)

| 고친 것 | 내용 |
| --- | --- |
| 펼치기 위치 | 접힌 말풍선을 펼치면 전체를 다시 그리면서 답변 맨 아래로 내려가던 문제. 이제 그 자리에서 펼쳐지고 말풍선 윗부분이 고정돼 아래로 늘어난다. 접을 때 머리가 화면 위로 숨으면 보이게 맞춘다 |
| 답변 순서 | 모두에게 보낸 질문의 답은 고정 순서(Claude→ChatGPT→Gemini)가 아니라 **먼저 끝난 AI 부터** 위에. 답하는 중인 말풍선은 아래에 모인다(`public/order.js`). 서버가 답이 끝난 시각 `finishedAt` 을 기록하고, 옛 기록은 시작 시각+걸린 시간으로 비교. 팀장 모드 단계 순서는 그대로 |
| 읽던 자리 유지 | 새 소식으로 화면을 다시 그릴 때 화면 맨 위 말풍선의 위치를 기억했다가 되돌린다(맨 아래를 보고 있을 때만 아래로 따라감) |

테스트: `test/v091-ui-order.test.mjs`.

### v0.9.1 → v0.9.2 (하얀 도트 화면 · 캐릭터 · 구글 드라이브로 보내기)

**화면**: 시안 5번 "하얀 도트". 흰 바탕, AI 답은 말풍선 없이 [캐릭터 · 이름 · 걸린 시간] 한 줄 머리 + 들여쓴 본문, AI 사이 얇은 구분선, 내 메시지는 오른쪽 회색 알약. 입력은 테두리 상자 하나에 입력칸과 [+ 첨부 · 모두에게/팀장에게 · 보내기]. 다크 모드 대응, 글꼴 IBM Plex Sans KR.

**캐릭터 아바타**: `public/avatar-{claude,codex,gemini}.jpg` (192px). `config/adapters.json` 의 `avatar` 로 지정하고, 이미지를 못 불러오면 예전처럼 색 동그라미 + 첫 글자. 색도 캐릭터 배경에 맞춤.

**구글 드라이브로 보내기** (`src/gdrive.mjs`): 메뉴 → 📁 파일함 · 드라이브.
- 연결: [드라이브 연결] → 화면의 주소를 열고 코드 입력 → 허용. AI 연결과 같은 기기 코드 방식.
- 보내기: 파일마다 [드라이브로] → 내 드라이브의 "AI 오피스" 폴더에 올라간다. AI 가 코드를 shared 폴더에 zip 으로 넣게 한 뒤 누르면 된다.
- 권한은 `drive.file` 하나: 이 앱이 만든 폴더·파일만 보고 고칠 수 있고 드라이브의 다른 파일은 못 본다. AI 에게는 드라이브 권한을 주지 않고, 업로드는 사람이 누른 버튼으로만 한다.
- 설정(주인 방만): Google Cloud 콘솔에서 OAuth 클라이언트 **"TV 및 입력 제한 기기"** 를 만들고 Railway Variables 에 `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`. OAuth 동의 화면은 **프로덕션으로 게시**(테스트 상태면 7일마다 다시 연결해야 함 · drive.file 은 비민감 범위라 심사 없음). 변수가 없으면 기능이 꺼진다(손님 방 기본).
- 저장: `data/gdrive.json`(0600, refresh token·폴더 id). 연결 해제 시 Google 에 토큰 폐기 요청 후 삭제. 같은 컨테이너의 AI 프로세스가 이 파일을 읽을 수는 있지만 범위가 drive.file 이라 앱 폴더 밖은 닿지 않는다.

테스트: `test/v092-gdrive.test.mjs` (가짜 Google 로 연결·폴더·업로드·만료·해제).

### v0.9.2 → v0.10.0 (Grok · 푸시 알림 · Gemini 쉬기)

**Grok 참여** (Grok Build CLI 1.0.62, `@xai-official/grok`): 참여자 → Grok → 연결하기 → 화면의 주소를 열고 코드 입력(기기 코드 방식, X 구독 Premium 이상 계정). 역할: 트렌드 분석·자료 조사(X 실시간 반응·웹 검색). `@그록` 으로 부를 수 있고 기본으로 모두에게에 들어간다.
- 프롬프트는 사용자 임시 폴더의 0600 파일로 넘기고(`promptVia: "file"`, Node 의 pipe 는 소켓이라 `/dev/stdin` 을 못 연다) 끝나면 지운다.
- 인증: 상태 명령이 없어 `src/adapters/grok-auth-status.mjs` 가 `~/.grok/auth.json` 의 **키 이름만** 보고 판정(세션 토큰 → 구독, api_key·config.toml 의 모델 키 → 차단). `XAI_API_KEY` 는 넘기지 않는다.
- 안전: `--always-approve` + `--deny` 규칙(삭제·강제 git·클라우드/결제 CLI). Grok 은 deny 가 always-approve 보다 우선이라 기술적으로 막힌다.
- 사용량은 X 구독의 주간 공용 한도(그록 앱·Cursor 와 함께)에서 나간다.

**푸시 알림** (`src/push.mjs`, `public/sw.js`): 메뉴 → 🔔 알림 → 이 기기에서 알림 받기. 한 질문의 답이 다 끝나면 한 번, AI 가 [승인 요청] 으로 멈추면 바로. 화면을 보고 있는 동안(30초마다 신호, 45초 유효)은 보내지 않는다. Web Push(VAPID) + RFC 8291 암호화를 외부 패키지 없이 구현 — 크롬은 FCM, 사파리는 Apple 푸시를 거치지만 내용은 암호화돼 있다. 아이폰은 홈 화면에 추가한 앱에서만 된다(iOS 16.4+). 구독 주소는 알려진 푸시 서비스만 받는다.

**Gemini 쉬기** (v0.9.3 작업 포함): Antigravity 의 주간 개인 한도가 앱 사용량과 따로 빨리 닳아, 기본으로 모두에게·팀장 분배에서 빼고(`quietDefault`) 방 대화도 붙이지 않는다(`roomShare:false`). `@제미나이` 로 부르면 답한다. 참여자 화면에서 AI 마다 "모두에게 포함" 을 켜고 끌 수 있다. 한도 소진 오류("Resets in 159h…")를 알아보면 그 시각까지 그 AI 를 띄우지 않고 "10/25 초기화" 처럼 표시한다(직접 풀기 가능).

테스트: `test/v093-quota.test.mjs`, `test/v10-push.test.mjs`, `test/v10-grok.test.mjs` (전체 119개).

### v0.10.0 → v0.10.1 (Grok 자료 조사 시간)

Grok 의 자료 조사가 15분 제한에 걸려 끊긴 사례 반영. AI 별 제한 시간(`runTimeoutMs`)을 둘 수 있게 하고 **Grok 만 30분**, 나머지는 기본 15분(`timeoutMs`). 대신 Grok 에 `--max-turns 40` 을 걸어 같은 검색을 끝없이 반복하는 것은 막는다.

### v0.10.1 → v0.10.2 (AI 가 만든 이미지·영상을 방에)

AI 가 이미지를 만들어도 다른 곳에 저장하고 방에는 못 올리던 문제. `src/media.mjs`: 답이 끝나면(완료·오류 모두) 그 실행 동안 새로 생긴 이미지·영상(png·jpg·gif·webp·mp4·webm·mov)을 작업 폴더와 사용자 홈(~/.grok 등) 아래에서 찾아 **파일함(shared)에 복사하고 답변에 붙인다**. 답·출력에 경로가 적힌 파일이 먼저, 이 사용자 폴더 밖 경로는 받지 않고, 사용자가 올린 파일·이미 붙인 파일은 다시 붙이지 않는다. SVG 는 제외(다운로드만). 화면은 답변 아래에 이미지(누르면 원본)·영상 플레이어를 바로 보여 주고, `/files/` 는 영상용 Range 요청(206)을 지원한다. 프롬프트에도 "결과 파일은 shared/ 에 저장하고 이름을 적으라" 는 안내를 붙였다.

### v0.10.2 → v0.10.3 (끌어다 놓기 · 붙여넣기 첨부)

PC 에서 파일·이미지를 화면 어디에나 **끌어다 놓으면** 첨부(놓는 동안 안내 띠), 입력칸에서 **Ctrl/Cmd+V** 로 이미지·파일을 붙여넣어도 첨부(글자만이면 평소처럼 입력). 📎·끌어다 놓기·붙여넣기가 같은 업로드 함수를 쓰고, 붙여넣은 스크린샷은 `붙여넣기-<시각>.png` 로 이름이 겹치지 않는다. 첨부한 이미지는 입력창 위에 미리보기(누르면 빼기), 보낸 메시지에도 그림으로 보인다.

### v0.10.3 → v0.10.4 (폰에서 📎 첨부 고침)

폰(안드로이드 크롬·홈 화면 앱)에서 📎 를 눌러도 파일 선택창이 안 열리던 문제. `label` 로 감싼 `display:none` 파일 입력 대신 **진짜 버튼이 숨긴 입력의 `click()`** 을 부른다. 올리기가 실패하면 토스트에 이유(응답 코드)를 같이 보여 준다.

### v0.10.4 → v0.10.5 (🧹 방 비우기)

메뉴 > **🧹 방 비우기**: 확인을 거쳐 방의 대화 기록을 모두 지우고 모든 AI 를 새 대화로 시작한다(이전 맥락을 잊음). 파일함·메모리·토큰 예산·쉬는 시간은 그대로. AI 가 답하는 중이면 거절(먼저 긴급 중지). 메시지 번호는 이어서 커지고, 화면은 `clearedBefore` 미만의 옛 메시지를 버린다(`cleared` 이벤트·스냅샷 둘 다). `POST /api/clear` → `{ok, removed}`.

## 8. 아직 없는 것 (v0.8 후보)

- Grok · Gemini 부분 출력(agy stream-json 의 step_update 텍스트)
- 승인 큐: "돈 쓰기·삭제 전엔 물어봐" 를 방 안의 [승인]/[거부] 버튼으로
- Claude 부분 출력(stream-json), 도구 권한 모드(`--permission-mode`) 설정
- 대화 검색·내보내기, 스케줄 실행, Grok 부분 출력(streaming-json)
