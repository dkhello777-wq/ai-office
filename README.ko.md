# AI 오피스 v0.7 — 구독 중인 AI 들을 단톡방 하나에서 (1인용 · 클라우드)

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
   - `HUB_PASSWORD` = 들어올 때 쓸 비밀번호 (10자 이상). 안 넣으면 첫 화면에서 정합니다.
   - (선택) `HUB_MONTHLY_TOKENS` 대신 화면 메뉴에서 예산을 정해도 됩니다.
4. **Volume** 추가: mount path `/app/data`. ⚠️ 이게 없으면 재배포 때마다 AI 로그인·대화가 날아갑니다.
5. Settings → Networking → **Generate Domain**. 그 주소를 폰에서 열면 끝. "홈 화면에 추가" 하면 앱처럼 열립니다.

다른 Docker 호스트(Hetzner, Fly, 집 NAS 등)도 같습니다: `docker build -t ai-office . && docker run -p 8787:8787 -v office-data:/app/data -e HUB_PASSWORD=... ai-office`.

## 2. 참여자 연결 (각 AI 한 번씩)

오른쪽 위 아바타 → **참여자** → 각 AI 의 **연결하기**.

- **Claude**: 서버가 `claude auth login` 을 띄우고 화면에 **URL** 이 뜹니다. 폰에서 그 URL 을 열어 Claude 구독 계정으로 로그인 → 화면에 나온 코드를 입력칸에 붙여넣고 전송. 끝나면 "● 연결됨 · pro/max".
- **ChatGPT (Codex)**: `codex login --device-auth`. 미리 ChatGPT 웹 → Settings → Security 에서 **device code 로그인 허용**이 켜져 있어야 합니다. URL 열고 코드 입력.
- **Gemini**: 아직 화면 연결 미지원 (v0.8 예정). 참여자 목록에는 보이지만 연결 버튼이 없습니다.

로그인 정보는 서버의 `/app/data/users/1/home/` 아래에만 저장됩니다. 허브는 토큰을 읽지 않고, 호출 직전마다 공식 CLI 의 **상태 명령**(`claude auth status`, `codex login status`)으로 "구독 로그인"인지만 확인한 뒤 호출합니다. API 키 모드·서드파티 인증이면 차단합니다.

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
| `HUB_PASSWORD` | 최초 비밀번호 (이미 있으면 무시) | 없음 → 화면에서 설정 |
| `PORT` / `HOST` | 수신 포트·주소 | Docker: 8787 / 0.0.0.0 |
| `HUB_ALLOWED_HOSTS` | Host 허용 목록(콤마) 또는 `*` | Docker: `*` |

`config/adapters.json`: AI 목록·명령·파서·역할 한 줄(`roleHint`). 새 AI 는 항목 하나 추가.

## 6. 개발

```sh
npm test          # 60개 (가짜 CLI 로 전체 흐름)
npm run doctor    # 설치된 CLI 확인
npm start         # http://127.0.0.1:8787
```

구조: `src/server.mjs`(HTTP+SSE, 게이트, 오케스트레이터, CLI 로그인 중계) · `src/owner.mjs`(비밀번호·세션) · `src/adapters/`(CLI 실행·파싱·인증 확인) · `src/store.mjs`(대화·사용량) · `public/`(단톡방 화면).

## 7. 아직 없는 것 (v0.8 후보)

- Gemini 화면 연결 (OAuth 비브라우저 흐름 확인 필요) · Grok
- 승인 큐: "돈 쓰기·삭제 전엔 물어봐" 를 방 안의 [승인]/[거부] 버튼으로
- Claude 부분 출력(stream-json), 도구 권한 모드(`--permission-mode`) 설정
- 푸시 알림, 대화 검색·내보내기, 스케줄 실행
