# AI 오피스 — 1인용 클라우드 배포 이미지.
# 서버(Node 22) + 공식 AI CLI 3종(Claude Code · Codex · Antigravity CLI) + git(Codex 가 작업 폴더에 git 저장소를 요구).
# 로그인 정보·대화·파일은 전부 /app/data 에 쌓이므로 그 경로를 영구 볼륨으로 잡아야 재배포해도 유지된다.
# 검수 V21: 검증한 버전으로 고정 (Linux 에서 상태 명령 출력을 확인한 조합). 올릴 때는 adapters.json 파서와 함께 확인.
FROM node:22.22.0-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps gosu tini \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@2.1.302 @openai/codex@0.163.0 \
 && claude --version && codex --version
# v0.8.2: Gemini 는 Antigravity CLI(agy). Gemini CLI 는 2026-06 부터 개인 Google 계정을 거부(IneligibleTierError). 공식 설치 스크립트가 최신판을 /usr/local/bin 에 둔다
# (설치 시점 최신 — 1.4.2 로 Linux 검증. 버전 고정 옵션이 스크립트에 없어 매 빌드 최신). 바이너리는 root 소유라 런타임 자동 업데이트는 실패하고 무시된다.
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh \
 && bash /tmp/agy-install.sh --dir /usr/local/bin && rm /tmp/agy-install.sh \
 && chmod 755 /usr/local/bin/agy && agy --version

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 클라우드 기본값: 모든 인터페이스, 플랫폼이 주는 PORT, Host 목록 검사 끔(Origin 일치는 유지), 프록시 헤더 신뢰, 데이터는 /app/data
ENV HOST=0.0.0.0 \
    PORT=8787 \
    HUB_ALLOWED_HOSTS=* \
    HUB_TRUST_PROXY=0 \
    NODE_ENV=production \
    HOME=/home/office
# (Railway 는 Dockerfile 의 VOLUME 을 거부한다 — 볼륨은 플랫폼에서 /app/data 에 붙인다. docker run 은 -v office-data:/app/data)
EXPOSE 8787

RUN mkdir -p /app/data /home/office && chown -R node:node /app /home/office

# 검수 V08: 플랫폼 볼륨은 root 소유로 마운트된다. 엔트리포인트가 root 로 /app/data 소유권을 맞춘 뒤 gosu 로 node(1000) 로 내려가 실행한다.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1
# tini 가 PID 1: 고아가 된 손자 프로세스를 거둬 좀비로 남지 않게 (검수 V12 보완)
ENTRYPOINT ["tini","--","docker-entrypoint.sh"]
CMD ["node","src/server.mjs"]
