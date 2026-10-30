#!/bin/bash
# 로봇 터치센서 신호선(GPIO 17, 22, 27)을 0.1초마다 실시간으로 보여 준다. 읽기만 하고 로봇은 움직이지 않는다.
# ssh 별칭 cove(로봇)로 접속할 수 있어야 한다.
clear
echo "터치센서 확인 (앞에서 바라볼 때: 1 = 왼쪽 위(17), 2 = 가운데 조금 아래(27), 3 = 오른쪽 위(22))"
echo "센서를 하나씩 눌러 보세요. 눌렀을 때 켜지는 숫자(17 / 22 / 27)를 보시면 됩니다. 끝내려면 Ctrl-C"
echo
ssh -o BatchMode=yes cove 'while true; do pinctrl get 17,22,27 | awk "{printf \"%s%s \", \$1, \$5}"; echo; sleep 0.1; done' | while read -r l; do
  l=${l//:hi/ ●켜짐}
  l=${l//:lo/ ○ 꺼짐}
  printf "\r  신호선  %s      " "$l"
done
