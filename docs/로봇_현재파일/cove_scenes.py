# -*- coding: utf-8 -*-
"""
COVE 씬 — 코브 애니메이터(웹)의 시나리오·단계 동작만 남긴 버전 (2026-11-03). 예전 씬은 backups 폴더에 있음.

■ 모션: motions/<씬 이름>.csv (웹에서 0.1초 간격으로 구운 절대 틱). 눈: cove_eyes.json 의 같은 이름 시간표.
■ 전체 시나리오(rest·tickle·snack·greet·expressions)는 끝나면 처음 자세(home)로 돌아감.
■ 단계 동작(rest_1_wake …)은 코브 혼자 하는 센서 반응 모드(휴식·간지럽히기·간식 주기)가 차례로 이어 부름.
   단계를 따로 실행해도 튀지 않도록 첫 자세로 0.6초 동안 먼저 감.
■ 아래 ALIASES 는 센서 반응 모드가 부르는 예전 이름을 가장 비슷한 웹 단계로 이어 준 것.
"""

_HOME = {"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}

SCENES = {
    "home": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 3.0}],   # 처음(접힌) 자세 — cove_robot.py 가 씀

    "rest": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}, {"motion": "rest", "smooth": 0, "eyes": "rest"}, _HOME],   # 시나리오1 휴식 (전체)
    "tickle": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}, {"motion": "tickle", "smooth": 0, "eyes": "tickle"}, _HOME],   # 시나리오2 간지럽히기 (전체)
    "snack": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}, {"motion": "snack", "smooth": 0, "eyes": "snack"}, _HOME],   # 시나리오3 간식주기 (전체)
    "greet": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 1.0}, {"motion": "greet", "smooth": 0, "eyes": "greet"}, _HOME],   # 시나리오4 인사 (2번 센서로 일어나 인사)
    "expressions": [{"rel": {1: 0, 2: -321, 3: -375, 4: 0}, "time": 1.0}, {"motion": "expressions", "smooth": 0, "eyes": "expressions"}, _HOME],   # 표정 모음
    "rest_1_wake": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 0.6}, {"motion": "rest_1_wake", "smooth": 0, "eyes": "rest_1_wake"}],   # 휴식 1단계 누가 다가왔어요
    "rest_2_invite": [{"rel": {1: 0, 2: -277, 3: -393, 4: 0}, "time": 0.6}, {"motion": "rest_2_invite", "smooth": 0, "eyes": "rest_2_invite"}],   # 휴식 2단계 쓰다듬어 줘서 좋아요
    "rest_3_nibble": [{"rel": {1: 0, 2: -284, 3: -378, 4: 0}, "time": 0.6}, {"motion": "rest_3_nibble", "smooth": 0, "eyes": "rest_3_nibble"}],   # 휴식 3단계 팔을 올려 주길 기다려요
    "rest_4_lean": [{"rel": {1: 0, 2: -327, 3: -282, 4: 0}, "time": 0.6}, {"motion": "rest_4_lean", "smooth": 0, "eyes": "rest_4_lean"}],   # 휴식 4단계 기대니까 편안해요
    "rest_5_sleep": [{"rel": {1: 0, 2: -367, 3: -124, 4: 0}, "time": 0.6}, {"motion": "rest_5_sleep", "smooth": 0, "eyes": "rest_5_sleep"}],   # 휴식 5단계 스르르 잠이 와요
    "rest_6_release": [{"rel": {1: 0, 2: -337, 3: -96, 4: 0}, "time": 0.6}, {"motion": "rest_6_release", "smooth": 0, "eyes": "rest_6_release"}],   # 휴식 6단계 잘 쉬었어요
    "tickle_1_look": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 0.6}, {"motion": "tickle_1_look", "smooth": 0, "eyes": "tickle_1_look"}],   # 간지럽히기 1단계 누가 왔어요! 반가워요
    "tickle_2_invite": [{"rel": {1: 0, 2: -387, 3: -480, 4: 0}, "time": 0.6}, {"motion": "tickle_2_invite", "smooth": 0, "eyes": "tickle_2_invite"}],   # 간지럽히기 2단계 만져 달라고 몸을 흔들어요
    "tickle_3_squirm": [{"rel": {1: 0, 2: -379, 3: -451, 4: 0}, "time": 0.6}, {"motion": "tickle_3_squirm", "smooth": 0, "eyes": "tickle_3_squirm"}],   # 간지럽히기 3단계 간지러워요!
    "tickle_4_enjoy": [{"rel": {1: 0, 2: -301, 3: -359, 4: 0}, "time": 0.6}, {"motion": "tickle_4_enjoy", "smooth": 0, "eyes": "tickle_4_enjoy"}],   # 간지럽히기 4단계 더 놀고 싶어요
    "tickle_5_laugh": [{"rel": {1: 0, 2: -316, 3: -376, 4: 0}, "time": 0.6}, {"motion": "tickle_5_laugh", "smooth": 0, "eyes": "tickle_5_laugh"}],   # 간지럽히기 5단계 너무 웃겨서 뒤로 넘어가요
    "tickle_6_end": [{"rel": {1: 0, 2: -246, 3: -335, 4: 0}, "time": 0.6}, {"motion": "tickle_6_end", "smooth": 0, "eyes": "tickle_6_end"}],   # 간지럽히기 6단계 기분이 정말 좋아요
    "snack_1_look": [{"rel": {1: 0, 2: 0, 3: 0, 4: 0}, "time": 0.6}, {"motion": "snack_1_look", "smooth": 0, "eyes": "snack_1_look"}],   # 간식주기 1단계 누가 왔는지 살펴봐요
    "snack_2_sniff": [{"rel": {1: 0, 2: -94, 3: -283, 4: 0}, "time": 0.6}, {"motion": "snack_2_sniff", "smooth": 0, "eyes": "snack_2_sniff"}],   # 간식주기 2단계 냄새가 나는 것 같아요
    "snack_3_curious": [{"rel": {1: 0, 2: -318, 3: -487, 4: 0}, "time": 0.6}, {"motion": "snack_3_curious", "smooth": 0, "eyes": "snack_3_curious"}],   # 간식주기 3단계 이게 뭘까요?
    "snack_4_expect": [{"rel": {1: 0, 2: -213, 3: -297, 4: 0}, "time": 0.6}, {"motion": "snack_4_expect", "smooth": 0, "eyes": "snack_4_expect"}],   # 간식주기 4단계 먹고 싶어요!
    "snack_5_eat": [{"rel": {1: 0, 2: -263, 3: -459, 4: 0}, "time": 0.6}, {"motion": "snack_5_eat", "smooth": 0, "eyes": "snack_5_eat"}],   # 간식주기 5단계 냠냠 맛있어요
    "snack_6_full": [{"rel": {1: 0, 2: -223, 3: -186, 4: 0}, "time": 0.6}, {"motion": "snack_6_full", "smooth": 0, "eyes": "snack_6_full"}],   # 간식주기 6단계 배가 불러요
    "snack_7_happy": [{"rel": {1: 0, 2: -226, 3: -12, 4: 0}, "time": 0.6}, {"motion": "snack_7_happy", "smooth": 0, "eyes": "snack_7_happy"}],   # 간식주기 7단계 행복해요!
    "snack_8_sleepy": [{"rel": {1: 0, 2: -184, 3: -210, 4: 0}, "time": 0.6}, {"motion": "snack_8_sleepy", "smooth": 0, "eyes": "snack_8_sleepy"}],   # 간식주기 8단계 졸려요
}

# 센서 반응 모드가 부르는 이름 → 가장 비슷한 웹 단계
ALIASES = {
    "tickle_squirm_loop": "tickle_3_squirm",   # 간지럽히기: 손이 있는 동안 반복 → 3단계 간지러워요!
    "tickle_calm": "tickle_4_enjoy",   # 간지럽히기: 손을 떼면 → 4단계 더 놀고 싶어요
    "snack_3_sniff": "snack_2_sniff",   # 간식주기: 사람이 오래 있으면 → 2단계 냄새가 나는 것 같아요
}
for _a, _t in ALIASES.items():
    SCENES[_a] = SCENES[_t]
