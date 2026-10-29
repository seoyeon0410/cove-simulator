#!/bin/bash
# 코브 애니메이터 시작하기 (맥): 더블클릭하면 웹 서버를 켜고 브라우저를 엽니다.
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 가 없어요. https://www.python.org/downloads/ 에서 설치한 뒤 다시 눌러 주세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫혀요"
  exit 1
fi

PORT=5173
URL="http://localhost:$PORT/"

if lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "이미 켜져 있어요. 브라우저만 엽니다."
  open "$URL"
  exit 0
fi

echo "코브 애니메이터를 켜는 중... (이 창을 닫으면 꺼져요)"
echo "주소: $URL"
( sleep 1; open "$URL" ) &
python3 server.py $PORT
