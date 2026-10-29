@echo off
chcp 65001 >nul
rem 코브 애니메이터 시작하기 (윈도우): 더블클릭하면 웹 서버를 켜고 브라우저를 엽니다.
cd /d "%~dp0"

set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 이 없어요. https://www.python.org/downloads/ 에서 설치한 뒤 다시 눌러 주세요.
  echo 설치할 때 "Add python.exe to PATH" 를 꼭 체크하세요.
  pause
  exit /b 1
)

echo 코브 애니메이터를 켜는 중... (이 창을 닫으면 꺼져요)
echo 주소: http://localhost:5173/
start "" http://localhost:5173/
%PY% server.py 5173
pause
