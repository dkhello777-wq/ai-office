# AI 오피스 — 1인용 클라우드 배포 이미지.
# 서버(Node 22) + 공식 AI CLI 3종(Claude Code · Codex · Gemini CLI) + git(Codex 가 작업 폴더에 git 저장소를 요구).
# 로그인 정보·대화·파일은 전부 /app/data 에 쌓이므로 그 경로를 영구 볼륨으로 잡아야 재배포해도 유지된다.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep procps \
 && rm -rf /var/lib/apt/lists/*

# 공식 CLI (버전 고정은 하지 않음 — 각 회사가 자주 올리고, 로그인 방식이 바뀌면 최신이 맞다)
RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli \
 && claude --version && codex --version && gemini --version

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY config ./config
COPY workspace ./workspace

# 클라우드 기본값: 모든 인터페이스, 플랫폼이 주는 PORT, Host 목록 검사 끔(Origin 일치는 유지), 데이터는 /app/data
ENV HOST=0.0.0.0 \
    PORT=8787 \
    HUB_ALLOWED_HOSTS=* \
    NODE_ENV=production
VOLUME ["/app/data"]
EXPOSE 8787

# 루트로 돌리지 않는다. CLI 들이 HOME 아래에 설정을 쓰므로 HOME 을 /app/data 바깥의 쓰기 가능한 곳으로.
RUN mkdir -p /app/data /home/office && chown -R node:node /app /home/office
USER node
ENV HOME=/home/office

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node","src/server.mjs"]
