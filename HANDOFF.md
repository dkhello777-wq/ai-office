# AI 오피스 인수인계서 (2026-10-22 16:40 KST)

다음 대화 방(세션)이 이 문서만 읽고 바로 이어갈 수 있게 쓴 메모. 기술 상세는 `README.ko.md`(설치·기능·버전별 변경 기록)에 전부 있으니 여기는 **현재 상태·하던 일·주의할 점**만.

## 0. 사용자

- 비개발자. 한국어. 확인을 받을 때는 **짧고 쉬운 말**로. 코드·명령은 보여 주지 않아도 됨.
- 폰: 안드로이드 크롬 + 홈 화면 앱(PWA). PC: 맥 크롬. 가끔 새벽까지 작업.
- 방침(사용자가 정함):
  - **배포 전에 묻기**: "코드 수정까지만, 배포는 하지 마"라고 하면 커밋·푸시도 보류(main 푸시 = Railway 자동 배포). 올리라고 하면 그때 푸시.
  - **Claude·Codex·Gemini 의 이어가기 세션은 절대 자동으로 끊지 말 것**(진행 중인 코딩 맥락 보호). 자동 새 대화는 **Grok 만**(config `sessionResetTokens`).
  - 명령 실행 중 사용자가 끼어들면(거부) 멈추고 지시를 기다릴 것. 전체 테스트는 오래 걸려 끼어들기 잘 당함.
  - Railway Variables 값은 출력·수정하지 말 것. 볼륨·서비스·기본 도메인 삭제 금지. 요금제 변경 금지.

## 1. 무엇인가

구독 중인 AI(Claude Code · Codex · Antigravity(Gemini) · Grok Build)를 공식 CLI 로 띄워 **단톡방 하나**에서 쓰는 1인용 웹앱. Node.js(의존성 없음) + Docker. 저장소 `dkhello777-wq/ai-office` (main 푸시 → Railway 자동 배포). 이 세션의 클론: `/home/claude/ai-office` (새 세션이면 `add_repo` 로 다시 받기).

- 테스트: `npm test` (node --test, 139개, 3~4분). `hub.test.mjs` 의 orchestrate/V13 두 개가 가끔 타이밍으로 흔들림 — 다시 돌리면 통과.
- 버전·변경 기록: `package.json` version + `README.ko.md` 맨 위 제목과 "v0.x → v0.y" 절. 매 배포마다 둘 다 올려 왔음.
- 커밋 메시지 끝에 `Co-Authored-By`·`Claude-Session` 줄(세션 시스템 안내에 나옴).

## 2. 인프라 (Railway)

- 프로젝트 `ai-office` = `b0365e5a-2850-48c3-9c6c-86134640809c`, 환경 production `8a9e301f-4900-456d-908c-2cd472897c20`
- 서비스 **ai-office**(사장님 방) `163ae807-0d19-41b4-9b9d-e8624b03ba24` — https://ai-office-production-c012.up.railway.app — 볼륨 `/app/data` 5GB
- 서비스 **guest-1**(손님 방) `530e0c18-1b32-4911-ac11-c4369853694e` — https://guest-1-production.up.railway.app — 볼륨 2GB. 같은 저장소라 둘 다 같이 배포됨.
  - 손님(지인 1명)이 10/20 오후 방을 만들어 쓰기 시작(아이폰). 비밀번호는 손님만 앎. 설정 코드는 방이 만들어진 뒤라 더 이상 안 생김.
- Railway MCP 도구로 배포 목록·로그·메트릭을 볼 수 있음(`list-deployments`, `get-logs` — deploy 로그 필터 `[run]`/`저장 공간`, http 로그, `get-service-metrics` DISK_USAGE_GB).
- 서버 로그에 실행마다 `[run] #id adapter status error 초 exit= tok= stderr: …` 한 줄(v0.10.9). 답변 본문은 안 남김.

## 3. 지금 상태 (가장 중요)

1. **Railway 가 빌드를 전면 중지 중** (10/22 12:00 KST~, 상태 페이지 "Railway Platform Outage"). 어제(10/21 새벽)도 같은 일이 있었고 5:52 에 풀렸음.
   - 깃허브 main 은 **v0.10.16**(7c394a0)인데 사이트는 **v0.10.14**. v0.10.15·v0.10.16 배포가 QUEUED 상태로 대기 중 → Railway 복구되면 자동 배포. 로그인·수동 재시도로는 안 풀림(`connect-service-source` 도 "Deploys have been paused temporarily").
   - 확인법: `list-deployments` 상태가 SUCCESS 로 바뀌었는지 + https://status.railway.com/
2. **사장님 방 디스크 ~94%** (5GB 중 4.7GB, 이틀 새 2.1→4.7GB). 자동 정리는 실행 기록·로그만 지워서 못 내림("아직 높음 — 작업 폴더 확인 필요"). 100% 되면 답변 저장 실패(persist_failed).
   - 해결책은 v0.10.15/16 에 들어 있음: 메뉴 → 💽 저장 공간에서 **무엇이 큰지** 보고 [지우기], 그리고 **"[2]일 지난 자료 · 미리보기·지우기"** 버튼(사용자 요청: "최근 2일치 자료 외엔 다 지워줘").
   - **배포가 되면 사용자에게 그 버튼을 눌러 달라고 안내**하는 게 첫 할 일. (서버 파일은 우리가 직접 못 지움 — 로그인 필요, 비밀번호는 받지 않기로 함.)
3. 그록: 10/21 새벽 자료 조사 중 30분 시간 초과 반복(대화 전체를 매 턴 재전송, 900KB). v0.10.12 부터 입력 12만 토큰 초과·시간 초과 시 그록만 자동 새 대화. 사용자에게 "첫 질문 전에 그록 새 대화 한 번" 안내했음(눌렀는지는 미확인).

## 4. 이번 세션에서 한 것 (v0.10.4 → v0.10.16)

| 버전 | 내용 |
|---|---|
| 0.10.4 | 폰에서 📎 안 눌리던 것: label+hidden input → 버튼이 input.click() |
| 0.10.5 | 🧹 방 비우기(대화 삭제 + 모든 AI 새 대화, 답하는 중이면 거절) |
| 0.10.6 | 가벼운 화면: 최근 60개만 그림 + "이전 대화 더 보기", content-visibility, 스냅샷 300개 + `/api/messages` |
| 0.10.7 | 따라가기 스크롤(↓ 새 글 버튼) · 첨부 미리보기 카드(텍스트 앞부분·영상·아이콘) |
| 0.10.8 | AI 가 쓰는 동안 화면이 위로 튀던 것: 타임라인 키 기반 재배치(전체 innerHTML 재생성 금지) |
| 0.10.9 | `[run]` 실행 결과 로그 |
| 0.10.10 | 이미지 라이트박스(앱 안에서 크게·저장·꾹 눌러 저장) · 쿠키 SameSite=Lax(PWA 에서 새 탭 열면 로그인 풀리던 것) |
| 0.10.11~12 | 자동 새 대화 — **Grok 만**(사용자가 Claude 까지 끊기는 건 거부) |
| 0.10.13 | 실패 이유를 쉬운 말로(무슨 일·추정 원인·다음 할 일), 원래 오류는 접음 |
| 0.10.14 | 토큰 예산: AI 별 입력/출력/횟수 + API 환산 금액($·₩, config `price`·`usdKrw`) |
| 0.10.15 | 저장 공간 시트: 영역별 크기·큰 항목 상위 25·[지우기]·캐시도 자동 정리 (`/api/storage?detail=1`, `/api/storage/delete`) |
| 0.10.16 | "N일 지난 자료" 미리보기→삭제 (`/api/storage/purge {days,dryRun}`) |

손님 연결 가이드(Claude Docs, 제목 "AI 오피스 손님 연결 가이드")도 Grok·새 기능에 맞게 갱신함.

## 5. 다음 할 일 후보

- [ ] Railway 복구 확인 → v0.10.16 배포 확인 → 사용자에게 저장 공간 정리 버튼 안내 → 사용률 내려갔는지 확인(`get-service-metrics` DISK_USAGE_GB)
- [ ] 디스크가 왜 불었는지 원인(저장 공간 시트의 "큰 항목"을 사용자가 캡처해 주면) → 재발 방지(예: 작업 폴더 상한, AI 에게 큰 파일은 shared 에 안 남기도록 프롬프트)
- [ ] 그록 느림 재발 여부 지켜보기(`[run] … grok` 로그)
- [ ] 손님 방 지인 사용 문의 대응(가이드 링크 전달됨)
- README "아직 없는 것" 절: 부분 출력(stream-json), 승인 큐, 대화 검색·내보내기 등

## 6. 자주 쓰는 확인 명령

- 배포 상태: Railway MCP `list-deployments` (projectId 위). 사이트 버전은 README 제목/`package.json`과 배포 commitMessage 로 대조.
- 오류 원인: `get-logs` serviceId + filter `[run]` (deploy 스트림).
- 디스크: `get-service-metrics` measurements `["DISK_USAGE_GB"]`.
- 로컬 브라우저 확인: Playwright 스크립트들이 `/tmp/.../scratchpad/pw/` 에 있었음(세션 끝나면 사라짐). 패턴: mock 어댑터(`src/adapters/mock-cli.mjs`)로 서버 띄우고 Pixel 7 에뮬레이션.
