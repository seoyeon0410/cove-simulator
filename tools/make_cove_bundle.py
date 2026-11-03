"""Build the COVE upload bundle from the web export zip.

Usage: python3 -I make_cove_bundle.py <export.zip> <out_dir>
Writes <out_dir>/motions/*.csv, cove_eyes.json, cove_scenes.py with readable scene names
that the robot's own sensor modes (cove_robot.py director) call.
"""
import csv, io, json, os, sys, zipfile

src, out = sys.argv[1], sys.argv[2]
HOME = {1: 1600, 2: 3201, 3: 3074, 4: 2021}

# web export name -> (robot scene name, Korean label, is full scenario)
NAMES = [
    ('web_rest', 'rest', '시나리오1 휴식 (전체)', True),
    ('web_tickle', 'tickle', '시나리오2 간지럽히기 (전체)', True),
    ('web_snack', 'snack', '시나리오3 간식주기 (전체)', True),
    ('web_greet', 'greet', '시나리오4 인사 (2번 센서로 일어나 인사)', True),
    ('web_expressions', 'expressions', '표정 모음', True),
    ('web_clip6', 'rest_1_wake', '휴식 1단계 누가 다가왔어요', False),
    ('web_clip7', 'rest_2_invite', '휴식 2단계 쓰다듬어 줘서 좋아요', False),
    ('web_clip8', 'rest_3_nibble', '휴식 3단계 팔을 올려 주길 기다려요', False),
    ('web_clip9', 'rest_4_lean', '휴식 4단계 기대니까 편안해요', False),
    ('web_clip10', 'rest_5_sleep', '휴식 5단계 스르르 잠이 와요', False),
    ('web_clip11', 'rest_6_release', '휴식 6단계 잘 쉬었어요', False),
    ('web_clip12', 'tickle_1_look', '간지럽히기 1단계 누가 왔어요! 반가워요', False),
    ('web_clip13', 'tickle_2_invite', '간지럽히기 2단계 만져 달라고 몸을 흔들어요', False),
    ('web_clip14', 'tickle_3_squirm', '간지럽히기 3단계 간지러워요!', False),
    ('web_clip15', 'tickle_4_enjoy', '간지럽히기 4단계 더 놀고 싶어요', False),
    ('web_clip16', 'tickle_5_laugh', '간지럽히기 5단계 너무 웃겨서 뒤로 넘어가요', False),
    ('web_clip17', 'tickle_6_end', '간지럽히기 6단계 기분이 정말 좋아요', False),
    ('web_clip18', 'snack_1_look', '간식주기 1단계 누가 왔는지 살펴봐요', False),
    ('web_clip19', 'snack_2_sniff', '간식주기 2단계 냄새가 나는 것 같아요', False),
    ('web_clip20', 'snack_3_curious', '간식주기 3단계 이게 뭘까요?', False),
    ('web_clip21', 'snack_4_expect', '간식주기 4단계 먹고 싶어요!', False),
    ('web_clip22', 'snack_5_eat', '간식주기 5단계 냠냠 맛있어요', False),
    ('web_clip23', 'snack_6_full', '간식주기 6단계 배가 불러요', False),
    ('web_clip24', 'snack_7_happy', '간식주기 7단계 행복해요!', False),
    ('web_clip25', 'snack_8_sleepy', '간식주기 8단계 졸려요', False),
]
# names the robot's sensor modes (cove_robot.py director) call that have no web step of their own -> nearest web step
ALIASES = [
    ('tickle_squirm_loop', 'tickle_3_squirm', '간지럽히기: 손이 있는 동안 반복 → 3단계 간지러워요!'),
    ('tickle_calm', 'tickle_4_enjoy', '간지럽히기: 손을 떼면 → 4단계 더 놀고 싶어요'),
    ('snack_3_sniff', 'snack_2_sniff', '간식주기: 사람이 오래 있으면 → 2단계 냄새가 나는 것 같아요'),
]

z = zipfile.ZipFile(src)
os.makedirs(os.path.join(out, 'motions'), exist_ok=True)
first = {}
for web, name, _, _ in NAMES:
    text = z.read(f'motions/{web}.csv').decode('utf-8')
    with open(os.path.join(out, 'motions', f'{name}.csv'), 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    row = next(r for i, r in enumerate(csv.reader(io.StringIO(text))) if i == 1)
    first[name] = {i: int(row[i]) - HOME[i] for i in (1, 2, 3, 4)}

eyes = json.loads(z.read('cove_eyes.json'))
rename = {web: name for web, name, _, _ in NAMES}
eyes['scenes'] = {rename[k]: v for k, v in eyes.get('scenes', {}).items() if k in rename}
for alias, target, _ in ALIASES:
    if target in eyes['scenes']:
        eyes['scenes'][alias] = eyes['scenes'][target]
with open(os.path.join(out, 'cove_eyes.json'), 'w', encoding='utf-8') as f:
    json.dump(eyes, f, ensure_ascii=False, indent=1)

def rel(d):
    return '{' + ', '.join(f'{i}: {v}' for i, v in d.items()) + '}'

lines = ['# -*- coding: utf-8 -*-', '"""',
         'COVE 씬 — 코브 애니메이터(웹)의 시나리오·단계 동작만 남긴 버전 (2026-11-03). 예전 씬은 backups 폴더에 있음.',
         '',
         '■ 모션: motions/<씬 이름>.csv (웹에서 0.1초 간격으로 구운 절대 틱). 눈: cove_eyes.json 의 같은 이름 시간표.',
         '■ 전체 시나리오(rest·tickle·snack·greet·expressions)는 끝나면 처음 자세(home)로 돌아감.',
         '■ 단계 동작(rest_1_wake …)은 코브 혼자 하는 센서 반응 모드(휴식·간지럽히기·간식 주기)가 차례로 이어 부름.',
         '   단계를 따로 실행해도 튀지 않도록 첫 자세로 0.6초 동안 먼저 감.',
         '■ 아래 ALIASES 는 센서 반응 모드가 부르는 예전 이름을 가장 비슷한 웹 단계로 이어 준 것.',
         '"""', '',
         '_HOME = {"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}', '',
         'SCENES = {',
         '    "home": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 3.0}],   # 처음(접힌) 자세 — cove_robot.py 가 씀',
         '']
for _, name, label, full in NAMES:
    play = f'{{"motion": "{name}", "smooth": 0, "eyes": "{name}"}}'
    if full:
        body = f'[{{"rel": {rel(first[name])}, "time": 1.0}}, {play}, _HOME]'
    else:
        body = f'[{{"rel": {rel(first[name])}, "time": 0.6}}, {play}]'
    lines.append(f'    "{name}": {body},   # {label}')
lines += ['}', '', '# 센서 반응 모드가 부르는 이름 → 가장 비슷한 웹 단계', 'ALIASES = {']
lines += [f'    "{a}": "{t}",   # {why}' for a, t, why in ALIASES]
lines += ['}', 'for _a, _t in ALIASES.items():', '    SCENES[_a] = SCENES[_t]', '']
with open(os.path.join(out, 'cove_scenes.py'), 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print('ok', len(NAMES), 'motions')
