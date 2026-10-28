# COVE 모션 작업 — Claude 작업 지침

이 폴더의 사용자는 **디자이너**입니다 (엔지니어 아님). COVE 로봇의 모션(씬)을 만들고 고칩니다.
사람용 안내서는 `COVE_시작하기.md` — 사용자가 그 순서대로 말을 걸어 옵니다. 함께 읽어 두세요.

## 말하는 방식
- 쉬운 한국어. 펄스·전류·SSH·파이썬 같은 용어는 꼭 필요할 때만, 짧게 풀어서.
- 코드나 숫자 표를 먼저 보여 주지 말고, **"이렇게 움직입니다"를 말로** 설명. 사용자가 원하면 보여 줌.
- 사용자의 감성적인 표현("졸린 느낌", "살짝", "반가운 듯")을 아래 표를 기준으로 숫자로 바꾸고, 어떻게 해석했는지 한 줄로 알려 줄 것.
- 로봇을 움직이기 전에는 "움직입니다, 손 비켜 주세요" 한 줄을 꼭 말할 것.

## 연결 정보
- COVE = 라즈베리파이 (사용자 이름 `sh`, 주소 `192.168.1.88`, 이름으로는 `cove.local`). 노트북이 와이파이 `HIDELAB_ROBOWORLD` 에 있어야 닿음.
- 비밀번호 로그인은 막혀 있고 **열쇠(SSH 키)로만** 접속됨. sudo 는 쓰지 말 것 (비밀번호가 필요하고, 필요한 작업도 없음).

### 처음 접속 설정 ("코브 접속 설정 해줘")
1. 노트북에 COVE 전용 키 만들기 (비밀번호 문구 없이): 파일 `~/.ssh/cove_key`
   - macOS/Linux: `ssh-keygen -t ed25519 -f ~/.ssh/cove_key -N "" -C cove-designer`
   - Windows PowerShell 5.1 은 빈 인자 `""` 를 넘기지 못하므로: `cmd /c ssh-keygen -t ed25519 -f "%USERPROFILE%\.ssh\cove_key" -N "" -C cove-designer`
2. `~/.ssh/config` 에 추가 (이미 있으면 건너뜀):
   ```
   Host cove
       HostName 192.168.1.88
       User sh
       IdentityFile ~/.ssh/cove_key
       IdentitiesOnly yes
   ```
3. `~/.ssh/cove_key.pub` 의 내용(한 줄)을 사용자에게 보여 주고 **"이 한 줄을 담당자에게 보내 주세요"** 라고 안내. 담당자가 COVE 의 `~/.ssh/authorized_keys` 에 등록해 줌.
4. 등록됐다고 하면 확인: `ssh -o BatchMode=yes -o ConnectTimeout=10 cove echo ok` → `ok`.
   - 주소가 바뀌었을 수 있으면 `cove.local` 로도 시도.

## COVE 안의 파일 (`~/robot-booth/`)
| 파일 | 누가 | 설명 |
|---|---|---|
| **`cove_scenes.py`** | **수정하는 유일한 파일** | 모든 씬 정의. 맨 위 주석에 형식·범위·안전 규칙 |
| `cove_scene_check.py` | 실행만 | 씬 검사 (범위에 잘리는 값, 너무 빠른 구간, 총 시간, 처음 자세로 안 끝나는 씬) |
| `cove_cmd.py` | 실행만 | 씬 실행/멈춤/힘 빼기 등 명령 |
| `cove_start.sh` | 실행만 | COVE 프로그램 켜기/끄기/상태 |
| `motions/*.csv` | 손으로 기록한 동작 (선택) | `motion_record.py` 로 만듦 |
| 그 밖의 모든 파일 (`cove_robot.py`, `pair_limit.py`, `booth_base.py`, `light_robot.py`, `cove_pair_3_4.json`, `dxl_*.py`, `hw_check.py` …) | **절대 수정·실행 금지** (hw_check 의 읽기 전용 표 보기는 예외) | 측정·시험으로 정한 값과 안전 장치. 바꾸면 기구가 부서지거나 사람이 다칠 수 있음 |

## 작업 순서
1. **연결 확인**: `ssh cove "bash ~/robot-booth/cove_start.sh status"`
   - 꺼져 있으면 사용자에게 "COVE 가 처음 자세로 움직입니다" 알린 뒤 `ssh cove "bash ~/robot-booth/cove_start.sh"` (켜지면서 처음 자세로 감).
2. **그날 첫 수정 전 백업**: `ssh cove "mkdir -p ~/robot-booth/backups && cp ~/robot-booth/cove_scenes.py ~/robot-booth/backups/cove_scenes_$(date +%m%d_%H%M).py"`
3. **수정**: 파일을 노트북으로 가져와(`scp cove:~/robot-booth/cove_scenes.py .`) 고친 뒤 다시 올림(`scp cove_scenes.py cove:~/robot-booth/`). 노트북 쪽 복사본은 이 폴더에 두어도 됨.
4. **검사**: `ssh cove "cd ~/robot-booth && python3 cove_scene_check.py <씬이름>"` → **경고 0개**가 될 때까지 고침. 경고 내용(잘림/속도)은 사용자에게 쉬운 말로 설명.
5. **반영**: 파일을 올리면 COVE 프로그램이 **1초 안에 자동으로 다시 읽음** (씬이 도는 중이면 끝난 뒤). 문법 오류면 이전 씬을 그대로 쓰고 로그에 오류를 남김 → `python3 cove_cmd.py log` 로 확인.
6. **실행**: "손 비켜 주세요" 안내 후 `ssh cove "cd ~/robot-booth && python3 cove_cmd.py <씬이름>"`. 결과는 `python3 cove_cmd.py log`.
7. **반복**: 사용자 피드백으로 3~6.
8. **정리** ("작업 정리해줘"): COVE 에 `~/robot-booth/SCENES_NOTES.md` 를 만들어(또는 갱신) 씬마다 **이름 / 무슨 동작인지 한두 문장 / 총 시간 / 사람이 팔을 넣는 타이밍이 있으면 그 시점** 을 적고, 같은 내용을 사용자에게 보여 주며 "담당자에게 이 목록과 함께 다 했다고 알려 주세요" 라고 안내.

### 자주 쓰는 명령
```
ssh cove "cd ~/robot-booth && python3 cove_cmd.py list"          # 씬 목록
ssh cove "cd ~/robot-booth && python3 cove_cmd.py stop"          # 멈춤 ("멈춰")
ssh cove "cd ~/robot-booth && python3 cove_cmd.py home"          # 처음 자세 ("처음 자세로")
ssh cove "cd ~/robot-booth && python3 cove_cmd.py torque_off"    # 힘 빼기 ("힘 빼줘")
ssh cove "cd ~/robot-booth && python3 cove_cmd.py torque_on"     # 힘 다시 주기 ("힘 줘") — 그 자리 유지
ssh cove "cd ~/robot-booth && python3 cove_cmd.py eyes blink"    # 눈만 바꾸기
ssh cove "cd ~/robot-booth && python3 cove_cmd.py log"           # 최근 기록 (온도·오류 포함)
```

## 씬 형식 (자세한 건 cove_scenes.py 맨 위 주석)
```python
"hello": [
    {"eyes": "blink"},
    {"rel": {2: -120, 3: -160}, "time": 2.0},   # 목·고개 살짝 들기
    {"rel": {4: -90}, "time": 1.0},              # 고개 왼쪽
    {"rel": {4: 0}, "time": 1.0},
    {"rel": {2: 0, 3: 0}, "time": 2.0},          # 처음 자세
    {"eyes": "idle"},
],
```
- `rel` = 처음 자세 대비 위치, `time` = 그 위치까지 걸리는 초 (여러 부위 동시). 적지 않은 부위는 그대로 있음.
- `wait` 초 기다림, `eyes` 표정, `repeat` 반복, `current` 힘 세기, `motion` 손으로 기록한 동작 재생.

## 부위 → 숫자 번역표
| 부위 | 번호 | 처음 자세 | 방향 | 갈 수 있는 범위 (처음 자세 대비) | 감 잡기 |
|---|---|---|---|---|---|
| 몸통 돌리기 | 1 | 0 = 정면 | `+`/`−` 좌우 (어느 쪽이 왼쪽인지는 첫 실행 때 사용자에게 확인 후 SCENES_NOTES.md 에 기록) | −4713 ~ +4632 | 약 **26 = 1°**, 4700 ≈ 180° |
| 목 들기 | 2 | 0 = 내려앉음 | **`−` 가 위로** | −390 ~ 0 | −390 = 끝까지, −190 = 반쯤 |
| 고개 들기/내리기 | 3 | 0 = 내림 | **`−` 가 위로** | −529 ~ 0 | −500 = 거의 끝까지, −160 = 살짝 |
| 고개 좌우 | 4 | 0 = 가운데 | `+`/`−` 좌우 (`−` 쪽 = 눈의 look_left 와 맞춰 씀) | 고개(3) 높이에 따라: 3이 0 근처나 −529 근처면 **0 (못 움직임)**, 3이 −160 ~ −300 일 때 약 **±100~150** | ±90 = 또렷한 갸웃 |

말 → 숫자 기준:
- 크기: "살짝" ≈ 범위의 20~30%, "적당히" ≈ 50%, "크게/끝까지" ≈ 80~100%.
- 속도(`time`): "천천히/졸린" 3~4초, "보통" 2초, "빠르게/깜짝" 0.8~1.2초. 큰 움직임을 1초 미만으로 쓰면 속도 상한에 걸려 늦어짐 — 검사 도구가 알려 줌.
- 고개 좌우(4)를 쓰려면 먼저 고개(3)를 −160 ~ −300 으로 들어 둘 것. 안 그러면 안 움직임.
- 눈: `idle`(평소 두리번) `blink` `look_left` `look_right` `off`.

## 반드시 지킬 것
1. **수정은 `cove_scenes.py` 만.** 다른 파일·설정·모터 값은 손대지 말 것.
2. `current` 는 **100 이하만** (기본 100, 물기 60). 낮췄으면 씬 끝에 `{"current": {3: 100}}` 처럼 되돌릴 것.
3. 씬은 **처음 자세(모두 0)로 끝낼 것** — 예외는 사용자가 원할 때만, SCENES_NOTES.md 에 적기.
4. 새 씬은 `cove_scene_check.py` **경고 0개** 확인 후 실행. 처음 실행은 **손을 넣지 않은 빈 상태**로.
5. 씬 이름은 **영어 소문자·숫자·밑줄** (예: `hello`, `sleepy_wake`). 전시 웹 버튼 이름이 됨.
6. 기존 `home` 은 지우거나 바꾸지 말 것 (전시 프로그램이 씀). `wake`, `bite` 는 고쳐도 되지만 바꾼 내용을 SCENES_NOTES.md 에 기록.
7. sudo, 시스템 설정, 재부팅, 파일 삭제 금지. 막히면 사용자에게 "담당자에게 물어보세요" 라고 안내.
8. 이상 동작·오류(모터 응답 없음, HW 에러, 온도 70°C 이상)가 보이면 즉시 `cove_cmd.py stop` 또는 `torque_off` 후 사용자에게 알림.

## 문제 해결
| 증상 | 확인 |
|---|---|
| `ssh` 시간 초과 | COVE 전원(켜고 2~3분), 노트북 와이파이 `HIDELAB_ROBOWORLD`, `cove.local` 로 시도 |
| `Permission denied (publickey)` | 담당자가 공개 열쇠를 아직 등록 안 함 |
| `cove_cmd.py` 가 "꺼져 있습니다" | `bash ~/robot-booth/cove_start.sh` (움직임 안내 먼저) |
| 로그에 "하드웨어 준비 실패 … 범위 밖" | 몸통이 정면이 아닐 때 켜진 것 → 사용자에게 전원 끄고 몸통을 정면으로 돌린 뒤 다시 켜 달라고 안내 |
| 로그에 "씬 파일 오류" | 방금 올린 `cove_scenes.py` 의 문법 오류 → 고쳐서 다시 올림 (그동안 이전 씬으로 동작) |
| 로그에 "HW 에러" | 모터 보호 동작 → 사용자에게 COVE 전원을 껐다 켜 달라고 안내, 계속되면 담당자 |
