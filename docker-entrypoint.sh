#!/bin/sh
# root 로 시작했으면 데이터 볼륨 소유권을 맞추고 node 사용자로 내려간다 (검수 V08). 이미 non-root 면 그대로 실행.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data /home/office
  chown -R node:node /app/data /home/office
  exec gosu node "$@"
fi
exec "$@"
