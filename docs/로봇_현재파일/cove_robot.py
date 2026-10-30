#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
로보월드 부스 — COVE 클라이언트 (라즈베리파이 제로 W)

COVE: 사람 팔목이나 손에 압력을 줘서 정서적 안정감을 주는 로봇 (강아지가 장난으로 무는 것처럼).

축 (다이나믹셀 XM430/XC330, U2D2 /dev/ttyUSB0, 115200):
  ID1 하부 회전 (확장 위치 모드, 기어 ≈2.6:1, 출력축 ±180°)      소프트웨어 제한 + 전원 켤 때 원점 근처 규칙
  ID2 머리 들기 (평소 위치 모드, 물 때만 전류 기반 위치 모드)    소프트웨어 제한 + 출력 상한 / 목표 전류(힘 제한)
  ID3 고개 끄덕임 (평소 위치 모드, 물 때만 전류 기반 위치 모드)  소프트웨어 제한 — 씬에서 current 를 기본(100)보다 낮추면 전류 기반으로 바뀌어 그 힘으로 내림
  ID4 머리 스위블 (위치 모드)                                    ID3 위치에 따라 허용 범위가 달라짐 (cove_pair_3_4.json)
눈: HT16K33 8×8 ×2 (I2C 0x70/0x71, 위 4줄만 사용). 센서: ToF (전면 — 다구역 센서로 교체 예정, 위 — 팔 감지), 터치 ×3.

씬 (SCENES): 위치는 "원점 대비 펄스" (rel) 또는 절대값 (move). 모든 목표는 제한을 거친 뒤 모터로 감.
  {"rel": {2: -120, 3: -150}, "time": 2}   원점 대비 위치로 time 초에 걸쳐 이동 (속도 자동)
  {"move": {1: 1600}, "time": 3}           절대 위치
  {"current": {3: 60}}                      ID2·3 힘 제한: 기본(100)보다 낮으면 전류 기반 모드로 바꿔 그 전류로 (물 때), 100 이상이면 평소 모드로
  {"wait": 3} / {"repeat": n, "steps": [...]} / {"eyes": "blink"|"look_left"|"look_right"|"idle"|"off"}
  {"motion": "이름", "speed": 1.0, "smooth": 4}   motions/이름.csv 프레임 재생 (smooth 0 = 스무딩 없이, 웹 모션용)
     + "eyes": "web_rest"  → cove_eyes.json 의 그 씬 표정 시간표를 모션 시간에 맞춰 같이 재생
  눈 이름에는 cove_eyes.json 의 웹 표정 16종("뜬 눈", "웃는 눈" ...)도 쓸 수 있음

테스트:
    python3 cove_robot.py --broker none        # 제어 PC 없이 (모터는 실제로 움직임)
"""

import argparse
import math
import os
import signal
import socket
import threading
import time

from booth_base import BaseRobot
from light_robot import BROKER_PORT, DxlIO
from pair_limit import DEFAULT_FILE as PAIR_FILE, PairLimit

ROBOT_ID = "robot2"
ROBOT_NAME = "COVE"
VERSION = "cove-0.3"

DXL_PORT, DXL_BAUD = "/dev/ttyUSB0", 115200
IDS = [1, 2, 3, 4]
AXIS_NAME = {1: "하부 회전", 2: "머리 들기", 3: "끄덕임", 4: "스위블"}
OP_MODE = {1: 4, 2: 3, 3: 3, 4: 3}       # 평소(모션 쇼) 제어 모드. ID2·3 은 물 때만 SOFT_MODE 로 바꿈
SOFT_MODE = 5                            # 전류 기반 위치 모드 — 사람 손을 물 때 (씬의 current 가 기본보다 낮을 때)
TICKS_PER_REV = 4096

# ---- 확정값 (2026-10-21 쉘 조립 후 손으로 측정) ----
HOME = {1: 1600, 2: 3201, 3: 3074, 4: 2021}
LIMIT = {1: (-3113, 6232), 2: (2811, 3209), 3: (2545, 3077), 4: (1827, 2211)}   # 원점 쪽 끝은 측정값 그대로(원점이 끝에 있음), 반대쪽은 20 여유. ID4 는 PairLimit 가 더 좁힘
WRAP_BY_HOME = {1}                 # 다회전 축: 전원 켤 때 원점 근처(±반 바퀴)에 있다고 가정
GOAL_CURRENT = {2: 100, 3: 100}    # 기본 목표 전류 (raw, XM430 1 ≈ 2.69mA). 씬의 current 가 이보다 낮으면 물기(전류 기반 모드)
# 평소 위치 모드 게인 P/I/D (RAM 이라 켤 때마다 씀).
# 10-23: 전류 기반 모드(P800~2500, D4700)는 빠른 모션에서 눈에 띄게 떨림 → 평소엔 위치 모드 P800 D0 (사용자 비교: "훨씬 부드러움").
# 위치 모드는 목표를 조금 늦게(최대 ~45펄스) 따라가며 급한 목표 변화를 뭉갬. 스위블은 P800 D0 이 최적 (P1200 이상은 헌팅)
POS_GAIN = {2: {"P": 800, "I": 0, "D": 0}, 3: {"P": 800, "I": 0, "D": 0}, 4: {"P": 800, "I": 0, "D": 0}}
SOFT_GAIN = {"P": 800, "I": 0, "D": 4700}    # 물기(전류 기반) 게인 — 전류 기반은 D 를 낮추면 스프링처럼 진동 (10-05 확인)
SHOW_PWM = {2: 400, 3: 400}        # 평소 모드 출력 상한(Goal PWM, 최대 885) = 손이 끼었을 때 힘 제한. 400 까지는 움직임 차이 없음, 250 이면 고개가 못 따라감 (10-23)
START_VEL, MAX_VEL, ACC = 30, 150, 10        # 시작 복귀 속도 / 씬 속도 상한 / 가속
ARRIVE_TOL, HOMING_TIMEOUT = 20, 20.0
LIFT_SIGN = {2: -1, 3: -1}         # "들기" 방향: 원점이 범위 끝(아래)이라 값이 작아지는 쪽이 들림
SWIVEL_LOCK_W = 40                 # ID3 위치에서 ID4 허용 폭이 이보다 좁으면 "스위블 잠김 구간" → ID4 힘 뺌
IDLE_TORQUE_OFF = (2,)             # 씬이 돌지 않을 때 토크를 끌 축 (머리 들기: 가만히 있을 때 건드리면 위치 추종하며 떨어서 — 10-21 사용자 요청)

LOCAL_CMD_PORT = 47901             # cove_cmd.py → 클라이언트 (같은 파이 안에서만)

# ---- 센서 반응 (시나리오 모드) — COVE_센서_요청서.md (2026-10-23). 거리·시간은 시작값, 현장에서 조정 ----
MODES = ["rest", "tickle", "snack", "track"]
MODE_NAME = {"rest": "휴식", "tickle": "간지럽히기", "snack": "간식 주기", "track": "따라보기"}
# 따라보기 (2026-10-26): 전면 다구역 ToF 의 사람 방향(dir, −1 왼쪽 ~ +1 오른쪽)이 가운데가 되도록 하부 회전(ID1)을 돌림
TRACK_SIGN = -1                    # dir + (오른쪽) 일 때 ID1 을 − 로 돌림 (2026-10-26 첫 시험: +1 이면 반대로 돎 → −1)
TRACK_GAIN = 250                   # dir 1.0 당 한 번에 보낼 회전량 (펄스, ID1 1° ≈ 30펄스, 센서 가장자리 열 ≈ 17°)
TRACK_DEAD = 0.2                   # |dir| 이 이보다 작으면 가운데로 보고 안 돌림
TRACK_RANGE = 600                  # 원점에서 ± 이 범위 안에서만 (약 ±20°, 방향 확인 후 넓힐 것)
TRACK_VEL = 40                     # 회전 속도 (Profile Vel)
TRACK_LOST_SEC = 3.0               # 사람이 이 시간 안 보이면 천천히 원점으로
PERSON_MM, PERSON_SEC = 500, 1.0   # 사람 인식: 전면 50cm 이내 1초
LEAVE_SEC = 5.0                    # 사람이 떠남: 전면 50cm 밖 5초
NEAR_MM, NEAR_SEC = 200, 2.0       # 간식 소품 가까이: 20cm 이내, 기대는 2초 유지
WAIT_TIMEOUT = 15.0                # 기다리는 단계에서 다음 감지가 없으면 정리
TOUCH_END_SEC = 5.0                # 간지럽히기: 터치 없이 5초면 마무리
TICKLE_LAUGH_SEC = 5.0             # 간지럽히기: 연속 터치 5초 넘으면 웃음
REST_SLEEP_ARM_SEC = 5.0           # 휴식: 기대기 끝난 뒤 팔이 5초 계속 있으면 잠
REST_ARM_OUT_SEC = 3.0             # 휴식: 팔이 3초 빠져 있으면 종료
REST_SLEEP_MAX = 90.0              # 휴식: 잠든 뒤 아무 감지 없어도 이 시간 지나면 종료 (rest_6_release)
SNACK_HAND_OUT_SEC = 0.8           # 간식: 손이 빠진 뒤 이만큼 지나면 먹기 시작
ARM_DELTA_MM = 80                  # 위 ToF: 평소 거리보다 8cm 넘게 가까우면 팔/손 있음
COOLDOWN_SEC = 20.0                # 시나리오가 끝난 뒤, 사람이 떠나지 않아도 다시 시작하기까지
EYE_ADDR = {"left": 0x70, "right": 0x71}
EYE_BRIGHT = 8
PIN_TOUCH = {"left": 17, "center": 27, "right": 22}
PIN_TOF_XSHUT = 4                  # 전면 ToF(사람 감지) XSHUT — 위 ToF 와 주소 분리에 사용 (2026-10-26 전면으로 변경)
MULTI_RES, MULTI_HZ = 4, 10        # 전면 다구역 ToF(VL53L5CX, 2026-10-26 교체): 4x4, 초당 10회
DIR_MM = 2500                      # 이 거리 안의 가장 가까운 물체로 사람 방향(왼쪽~오른쪽)을 계산 (연속 모드로 거리 늘려서 1500 → 2500)
TOF_PUB_SEC = 0.2                  # 대시보드로 4x4 값을 보내는 간격 (booth/<id>/tof)

# ---- 웹(코브 애니메이터) 실시간 조그: {"cmd":"pose","deg":{"neck":10,"head":-12,"tilt":0,"body":0}} (2026-10-28 웹 요청서 4번) ----
# 웹 각도 0° = 접힌 기본 자세 = HOME. neck = ID2, head = ID3 (목 기준 상대각), tilt = ID4, body = ID1 (COVE_인수인계/로봇연동_답변서.md 2번)
DEG_TICKS = 4096 / 360             # ID2~4 는 모터 축 = 관절 (1:1)
BODY_TICKS_PER_DEG = 29.6          # ID1 기어 약 2.6:1
WEB_SIGN = {"neck": -1, "head": 1, "tilt": 1, "body": 1}   # 웹 + 일 때 틱 방향. neck·head 확인됨, body 확인됨 (10-26 따라보기: ID1 + = 로봇 왼쪽 = 웹 body +),
                                                          # tilt 는 웹 가정(+ = 머리 위쪽이 로봇 오른쪽) — check_tilt 로 확인 후 고칠 것
WEB_JOINT_ID = {"neck": 2, "head": 3, "tilt": 4, "body": 1}
POSE_DT = 0.15                     # 한 프레임을 이 시간에 걸쳐 감 (10Hz 로 들어오면 살짝 겹쳐서 부드럽게)
POSE_END_SEC = 2.0                 # 이 시간 pose 가 안 오면 실시간 조그 끝 (그 자리 유지, ID2 토크는 다시 끔)


def web_pose_targets(deg):
    """웹 각도 dict → 모터 절대 틱 dict (범위 제한은 Motors.goto 가 함)"""
    out = {}
    for name, v in deg.items():
        i = WEB_JOINT_ID.get(name)
        if i is None or v is None:
            continue
        k = BODY_TICKS_PER_DEG if name == "body" else DEG_TICKS
        out[i] = round(HOME[i] + WEB_SIGN[name] * k * float(v))
    return out

A_TORQUE, A_HWERR, A_POS_D, A_POS_I, A_POS_P, A_GOALCUR, A_ACC, A_VEL, A_GOAL, A_CUR, A_POS, A_VOLT, A_TEMP = \
    64, 70, 80, 82, 84, 102, 108, 112, 116, 126, 132, 144, 146
A_MODE, A_GOALPWM = 11, 100
VEL_TICKS = 0.229 / 60 * TICKS_PER_REV

# ---- 씬: cove_scenes.py 에 정의 (모션 작성자는 그 파일만 수정). {"cmd":"reload"} 로 재시작 없이 다시 읽음 ----
import importlib
import cove_scenes

SCENES = cove_scenes.SCENES
MOTION_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "motions")


def reload_scenes():
    global SCENES
    importlib.reload(cove_scenes)
    SCENES = cove_scenes.SCENES
    return list(SCENES)


def load_motion(name, smooth=4):
    """motions/<name>.csv (motion_record.py 형식) → (ts, {id: [pos...]})  위치는 절대 모터값.
    smooth = 앞뒤로 평균 낼 프레임 수 (기본 4 = 9점 이동 평균, 손 기록용). 0 = 그대로 (웹 모션처럼 이미 매끈한 것)"""
    path = os.path.join(MOTION_DIR, name + ".csv")
    with open(path, encoding="utf-8") as f:
        lines = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
    ids = [int(h[2:]) for h in lines[0].split(",")[1:]]
    rows = [[float(x) for x in ln.split(",")] for ln in lines[1:]]
    ts = [r[0] for r in rows]
    cols = {}
    for k, i in enumerate(ids):
        col = [r[k + 1] for r in rows]
        s = max(0, int(smooth))
        sm = [sum(col[max(0, n - s):n + s + 1]) / len(col[max(0, n - s):n + s + 1]) for n in range(len(col))]   # (2s+1)점 이동 평균
        cols[i] = [round(v) for v in sm]
    return ts, cols


def clamp1(i, v):
    lo, hi = LIMIT[i]
    return max(lo, min(hi, v))


# =====================================================================
# 모터
# =====================================================================
class Motors:
    """모든 위치는 '논리 위치' = 원시값 + 전원 재투입 보정(ID1)."""

    def __init__(self, io, pair):
        self.io, self.pair = io, pair
        self.lock = threading.RLock()
        self.offset = {i: 0 for i in IDS}
        self.goal, self.vel, self.cur, self.mode = {}, {}, {}, {}
        self.on = False
        self.free4 = False             # 스위블(ID4) 힘을 일부러 빼 둔 상태 (_swivel_free_check)

    def _r(self, i, a, n):
        with self.lock:
            return self.io.read(i, a, n)

    def _w(self, i, a, n, v):
        with self.lock:
            return self.io.write(i, a, n, v)

    def prepare(self):
        for i in IDS:
            raw = self._r(i, A_POS, 4)
            if raw is None:
                raise RuntimeError(f"ID{i} {AXIS_NAME[i]} 응답 없음")
            err = self._r(i, A_HWERR, 1)
            if err:
                raise RuntimeError(f"ID{i} {AXIS_NAME[i]} HW 에러 0x{err:02X} (전원을 껐다 켜야 함)")
            if i in WRAP_BY_HOME:
                cands = [k * TICKS_PER_REV for k in range(-3, 4)]
                self.offset[i] = min(cands, key=lambda o: abs(raw + o - HOME[i]))
            p = raw + self.offset[i]
            lo, hi = LIMIT[i]
            if not lo - 150 <= p <= hi + 150:
                raise RuntimeError(f"ID{i} {AXIS_NAME[i]} 현재 {p} 가 범위 {lo}~{hi} 밖 (손으로 범위 안에 두고 다시)")

    def pos(self, i):
        raw = self._r(i, A_POS, 4)
        return None if raw is None else raw + self.offset[i]

    def _set_regs(self, i, mode, vel, cur=None):
        """제어 모드는 이미 맞춰진 상태에서: 모드별 게인·힘 제한·프로파일 (RAM — 토크가 켜져 있어도 됨).
        모드를 바꾸면 모터가 게인을 기본값으로 되돌리므로 바꾼 뒤 반드시 다시 씀."""
        ok = True
        if cur is not None:
            ok = self._w(i, A_GOALCUR, 2, cur)
        if ok and i in GOAL_CURRENT:
            soft = mode == SOFT_MODE
            g = SOFT_GAIN if soft else POS_GAIN[i]
            ok = (self._w(i, A_POS_D, 2, g["D"]) and self._w(i, A_POS_I, 2, g["I"]) and self._w(i, A_POS_P, 2, g["P"])
                  and self._w(i, A_GOALPWM, 2, 885 if soft else SHOW_PWM.get(i, 885)))
        elif ok and i in POS_GAIN:
            g = POS_GAIN[i]
            ok = self._w(i, A_POS_D, 2, g["D"]) and self._w(i, A_POS_I, 2, g["I"]) and self._w(i, A_POS_P, 2, g["P"])
        return ok and self._w(i, A_ACC, 4, ACC) and self._w(i, A_VEL, 4, vel)

    def enable(self, vel):
        for i in IDS:
            p = self.pos(i)
            ok = p is not None and self._w(i, A_TORQUE, 1, 0)
            if ok and self._r(i, A_MODE, 1) != OP_MODE[i]:          # EEPROM — 다를 때만 씀
                ok = self._w(i, A_MODE, 1, OP_MODE[i])
            ok = ok and self._set_regs(i, OP_MODE[i], vel)
            if ok:
                self.mode[i] = OP_MODE[i]
            if i in GOAL_CURRENT:
                self.cur[i] = GOAL_CURRENT[i]
            ok = ok and self._w(i, A_GOAL, 4, p - self.offset[i]) and self._w(i, A_TORQUE, 1, 1)
            if not ok:
                raise RuntimeError(f"ID{i} {AXIS_NAME[i]} 토크 켜기 실패")
            self.goal[i], self.vel[i] = p, vel
        self.on, self.free4 = True, False

    def torque_one(self, i, on):
        """축 하나만 토크 켜기/끄기. 켤 때는 목표를 현재 위치로 맞춰 튀지 않게."""
        if on:
            p = self.pos(i)
            if p is None:
                return False
            ok = self._w(i, A_GOAL, 4, p - self.offset[i]) and self._w(i, A_TORQUE, 1, 1)
            if ok:
                self.goal[i] = p
            return ok
        return self._w(i, A_TORQUE, 1, 0)

    def set_current(self, i, raw):
        """ID2·3 힘 제한. 기본(GOAL_CURRENT)보다 낮으면 전류 기반 모드로 바꿔 그 전류로 (물기), 기본 이상이면 평소 위치 모드로.
        모드는 토크가 꺼져야 바뀌어서, 토크 끄기 → 모드 → 현재 위치 목표 → 토크 켜기 네 번만 쓰고 바로 켬
        (10-23: 이것저것 같이 쓰면 0.3초 꺼져서 든 고개가 190펄스 떨어졌음). 게인 등은 켠 뒤에 쓰고, 가던 목표가 있으면 이어서 감."""
        if i not in GOAL_CURRENT:
            return False
        raw = max(0, min(1193, int(raw)))
        want = SOFT_MODE if raw < GOAL_CURRENT[i] else OP_MODE[i]
        with self.lock:
            if want != self.mode.get(i):
                was_on = self._r(i, A_TORQUE, 1) == 1
                if want == SOFT_MODE:
                    self._w(i, A_GOALCUR, 2, raw)          # 켜지는 순간부터 그 힘으로 (켠 뒤에도 한 번 더 씀)
                p = self.pos(i)
                ok = p is not None and self._w(i, A_TORQUE, 1, 0) and self._w(i, A_MODE, 1, want)
                ok = ok and self._w(i, A_GOAL, 4, p - self.offset[i]) and (not was_on or self._w(i, A_TORQUE, 1, 1))
                if not ok:
                    return False
                self.mode[i] = want
                ok = self._set_regs(i, want, self.vel.get(i, START_VEL), raw if want == SOFT_MODE else None)
                g = self.goal.get(i, p)
                if was_on and abs(g - p) > 2:
                    self._w(i, A_GOAL, 4, g - self.offset[i])
                if not ok:
                    return False
            elif want == SOFT_MODE and not self._w(i, A_GOALCUR, 2, raw):
                return False
            self.cur[i] = raw
            return True

    def limited(self, targets):
        """목표 dict 를 모든 제한을 거친 dict 로 (빠진 축은 현재 목표 유지)"""
        t = {i: targets.get(i, self.goal.get(i, HOME[i])) for i in IDS}
        t = {i: clamp1(i, v) for i, v in t.items()}
        if self.pair:
            t[3], t[4] = self.pair.clamp(t[3], t[4])
        return t

    def _swivel_free_check(self, t):
        """고개(ID3)가 스위블이 기구적으로 잠기는 구간(맨 아래·맨 위)으로 가고 스위블(ID4)을 따로 움직이지 않으면
        ID4 힘을 뺌 — 잠긴 상태에서 위치를 고집하면 기구와 싸우며 떨기 때문 (2026-10-23 측정: 힘 빼면 떨림 0).
        스위블을 움직이거나 고개가 잠김 구간을 벗어나면 현재 위치에서 다시 힘을 줌."""
        if not self.pair:
            return
        lo, hi = self.pair.dep_range(t[3])
        locked = hi - lo < SWIVEL_LOCK_W
        commanding = abs(t[4] - self.goal.get(4, t[4])) > 10
        if locked and not commanding:
            if not self.free4 and self._w(4, A_TORQUE, 1, 0):
                self.free4 = True
        elif self.free4:
            if self.torque_one(4, True):
                self.free4 = False

    def goto(self, targets, duration=None, vel=None):
        """targets 를 제한 적용 후 전송. duration 이 있으면 축별 속도를 거리/시간으로 계산."""
        t = self.limited(targets)
        self._swivel_free_check(t)
        for i, v in t.items():
            if i == 4 and self.free4:
                self.goal[4] = v           # 힘 뺀 동안은 목표만 기억 (다시 힘 줄 때 현재 위치에서 시작)
                continue
            dist = abs(v - self.goal.get(i, v))
            if not dist and (duration or vel == self.vel.get(i)):
                continue
            vv = vel
            if duration:
                vv = max(1, min(MAX_VEL, round(dist / duration / VEL_TICKS)))
            if vv is not None and vv != self.vel.get(i) and self._w(i, A_VEL, 4, vv):
                self.vel[i] = vv
            if self._w(i, A_GOAL, 4, v - self.offset[i]):
                self.goal[i] = v
        return t

    def arrived(self, tol=ARRIVE_TOL):
        for i in IDS:
            if i == 4 and self.free4:      # 힘 뺀 스위블은 기구가 정하는 자리에 있음 → 도착 판정에서 뺌
                continue
            p = self.pos(i)
            if p is None or abs(p - self.goal.get(i, p)) > tol:
                return False
        return True

    def hold(self):
        for i in IDS:
            p = self.pos(i)
            if p is not None and self._w(i, A_GOAL, 4, p - self.offset[i]):
                self.goal[i] = p

    def torque_off(self):
        done = []
        with self.lock:
            self.io.reset()
            for i in IDS:
                for _ in range(3):
                    if self._w(i, A_TORQUE, 1, 0) and self._r(i, A_TORQUE, 1) == 0:
                        done.append(i)
                        break
                    time.sleep(0.05)
        self.on = False
        return done

    def read_status(self):
        out = []
        for i in IDS:
            p = self.pos(i)
            if p is None:
                out.append({"id": i, "ok": False})
                continue
            volt, cur = self._r(i, A_VOLT, 2), self._r(i, A_CUR, 2)
            if cur is not None and cur > 0x7FFF:
                cur -= 1 << 16
            out.append({"id": i, "ok": True, "pos": p, "goal": self.goal.get(i),
                        "temp": self._r(i, A_TEMP, 1), "volt": round(volt * 0.1, 1) if volt is not None else None,
                        "err": self._r(i, A_HWERR, 1) or 0, "torque": bool(self._r(i, A_TORQUE, 1)),
                        "current_ma": round(cur * 2.69) if cur is not None else None,
                        "goal_current": self.cur.get(i), "mode": self.mode.get(i)})
        return out

    def close(self):
        self.io.close()


# =====================================================================
# 눈 (HT16K33 ×2, 위 4줄 × 8칸). 별도 스레드에서 25fps
# =====================================================================
EYES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cove_eyes.json")


def load_web_eyes(path=EYES_FILE):
    """웹(코브 애니메이터) 눈 표정 cove_eyes.json → (표정, 깜빡임, 씬별 시간표).
    표정: {이름: {"frames": [(왼쪽 4줄, 오른쪽 4줄, ms), ...], "loop": bool}}. 한 줄 "00011000" → 비트 7 = 로봇 기준 왼쪽 칸"""
    import json
    with open(path, encoding="utf-8") as f:
        d = json.load(f)

    def rows(e):
        left = [int(s, 2) for s in e["left"]]
        right = [int(s, 2) for s in e.get("right", e["left"])]
        return left, right, int(e.get("ms", 0))

    shapes = {}
    for name, e in d.get("eyes", {}).items():
        fr = [rows(x) for x in e["frames"]] if "frames" in e else [rows(e)]
        shapes[name] = {"frames": fr, "loop": bool(e.get("loop", True))}
    b = d.get("blink")
    blink = None
    if b:
        blink = {"for": b.get("for"), "period": float(b.get("period_s", 3.8)), "first": float(b.get("first_s", 1.6)),
                 "frames": [rows(x) for x in b.get("frames", [])]}
    return shapes, blink, d.get("scenes", {})


class Eyes:
    def __init__(self, log):
        self.log, self.dev, self.mode = log, {}, "idle"
        self.lock = threading.Lock()
        self.gx = 0                                   # 웹 표정 시선: 오른쪽으로 옮길 칸 수 (− 왼쪽)
        self.web, self.web_blink, self.timelines, self._web_mtime = {}, None, {}, None
        self.reload_web()
        try:
            from ht16k33 import Matrix8x8
            for name, addr in EYE_ADDR.items():
                m = Matrix8x8(addr)
                m.brightness(EYE_BRIGHT)
                self.dev[name] = m
        except Exception as e:
            self.log(f"눈 매트릭스 초기화 실패 ({e}) — 눈 없이 동작", "warn")
            self.dev = {}
        if self.dev:
            threading.Thread(target=self._loop, daemon=True).start()

    def set(self, mode, gx=0):
        with self.lock:
            self.mode = mode
            self.mode_t = time.time()
            self.gx = int(round(gx or 0))

    def reload_web(self):
        """cove_eyes.json (웹 표정 16종 + 깜빡임 + 씬별 시간표) 를 다시 읽음. 파일이 없으면 웹 표정 없이"""
        try:
            m = os.path.getmtime(EYES_FILE)
        except OSError:
            return False
        if m == self._web_mtime:
            return False
        try:
            shapes, blink, tl = load_web_eyes()
        except Exception as e:
            self.log(f"눈 표정 파일 오류 (이전 것 유지): {e}", "warn")
            self._web_mtime = m
            return False
        with self.lock:
            self.web, self.web_blink, self.timelines, self._web_mtime = shapes, blink, tl, m
        self.log(f"웹 눈 표정 {len(shapes)}종, 시간표 {len(tl)}개 읽음")
        return True

    def timeline(self, name):
        """씬별 표정 시간표 [(t, 표정, gx), ...] (t 순)"""
        tl = self.timelines.get(name) or []
        return sorted(((float(e["t"]), e["expr"], e.get("gx", 0)) for e in tl), key=lambda x: x[0])

    def _web_frame(self, t):
        """웹 표정 한 프레임 (왼쪽 4줄, 오른쪽 4줄)"""
        e, k = self.web[self.mode], t - self.mode_t
        b = self.web_blink
        if b and b["frames"] and self.mode == b["for"] and k >= b["first"]:
            q = (k - b["first"]) % b["period"]
            for left, right, ms in b["frames"]:          # 깜빡임 중이면 그 프레임
                if q < ms / 1000:
                    return left, right
                q -= ms / 1000
        fr = e["frames"]
        if len(fr) == 1:
            return fr[0][0], fr[0][1]
        total = sum(ms for _, _, ms in fr) or 1
        q = (k * 1000) % total if e["loop"] else min(k * 1000, total - 1)
        for left, right, ms in fr:
            if q < ms:
                return left, right
            q -= ms
        return fr[-1][0], fr[-1][1]

    # 고정 눈 모양 (위 4줄, 비트 7 = 왼쪽 칸). 디자이너 요청서(2026-10-23) 시작안 그대로.
    # 값이 하나면 두 눈 같음, (왼쪽 매트릭스 0x70, 오른쪽 0x71) 튜플이면 눈마다 다름.
    SHAPES = {
        "happy":   [0b00011000, 0b00100100, 0b01000010, 0b10000001],   # 웃는 눈 ^ ^
        "closed":  [0b00000000, 0b00000000, 0b10000001, 0b01111110],   # 감은 눈 ‿ ‿
        "tickle":  ([0b11100000, 0b00011100, 0b00011100, 0b11100000],  # 간지러운 눈: 0x70 쪽 '>'
                    [0b00000111, 0b00111000, 0b00111000, 0b00000111]), #               0x71 쪽 '<'
        "curious": [0b01111110, 0b11100111, 0b11111111, 0b01111110],   # 호기심 눈
        "heart":   [0b01100110, 0b11111111, 0b01111110, 0b00011000],   # 기대 눈 (하트)
    }

    def _frame(self, t):
        """→ (왼쪽 매트릭스 프레임, 오른쪽 매트릭스 프레임)"""
        m = self.mode
        if m == "off":
            f = [0] * 8
            return f, f
        if m in self.web:
            l, r = self._web_frame(t)
            g = self.gx
            sh = (lambda v: (v >> g) & 0xFF) if g >= 0 else (lambda v: (v << -g) & 0xFF)
            return [sh(v) for v in l] + [0] * 4, [sh(v) for v in r] + [0] * 4
        if m in self.SHAPES:
            s = self.SHAPES[m]
            l, r = s if isinstance(s, tuple) else (s, s)
            return list(l) + [0] * 4, list(r) + [0] * 4
        if m == "blink":                          # 1초간 빠르게 두 번 깜빡인 뒤 idle 로
            k = (t - self.mode_t)
            if k > 1.0:
                self.mode = "idle"
            elif (k % 0.5) < 0.15:
                f = [0, 0b11111111, 0b11111111, 0, 0, 0, 0, 0]
                return f, f
        if m in ("look_left", "look_right"):
            x = 0 if m == "look_left" else 6
        else:                                     # idle: 천천히 좌우 + 4초마다 깜빡
            x = int(round(3 + 3 * math.sin(t * 0.8)))
            if (t % 4.0) < 0.14:
                f = [0, 0b11000000 >> x, 0b11000000 >> x, 0, 0, 0, 0, 0]
                return f, f
        col = (0b11000000 >> x) & 0xFF
        f = [col, col, col, col, 0, 0, 0, 0]
        return f, f

    def _loop(self):
        self.mode_t = time.time()
        next_check = 0.0
        while True:
            if time.time() >= next_check:            # cove_eyes.json 이 바뀌면 다시 읽음 (2초마다 확인)
                next_check = time.time() + 2.0
                self.reload_web()
            try:
                with self.lock:
                    fl, fr = self._frame(time.time())
                for name, d in self.dev.items():
                    d.show(fl if name == "left" else fr)
            except OSError:
                pass
            time.sleep(0.04)

    def close(self):
        for d in self.dev.values():
            try:
                d.close()
            except Exception:
                pass


# =====================================================================
# 센서 (ToF 전면 = 사람, ToF 위 = 팔/손, 터치 3개) — 백그라운드로 계속 읽고 "얼마나 오래" 를 계산
# =====================================================================
class Senses:
    TOUCH_GAP = 0.3                # 이보다 짧게 떨어졌다 붙으면 계속 닿아 있는 것으로 봄

    def __init__(self, log):
        self.log = log
        self.lock = threading.Lock()
        now = time.time()
        self.front = self.top = None
        self.top_base = None
        self.person_since = None; self.away_since = now          # 전면 PERSON_MM 이내
        self.close_since = None                                   # 전면 NEAR_MM 이내
        self.arm_since = None; self.clear_since = now             # 위 ToF 팔/손
        self.touch_since = None; self.touch_last = 0.0
        self.touch_each = [False, False, False]          # 센서별 지금 닿음 [왼쪽, 가운데, 오른쪽] (앞에서 볼 때 1·2·3번)
        self.touch_each_t = [0.0, 0.0, 0.0]              # 센서별 마지막으로 닿은 시각
        self.touch_events = []                           # 센서가 새로 닿은 순서 [(시각, 센서 번호 1~3)] — 3번 먼저 2번 나중 같은 순서를 웹이 알 수 있게
        self.touch_dev = self.tof_front = self.tof_top = None
        self.multi_addr, self.tof_multi = None, None              # 전면 다구역 ToF (VL53L5CX)
        self.zones, self.zones_t, self.front_dir = None, 0.0, None
        try:
            from cove_sense import Touch
            self.touch_dev = Touch(PIN_TOUCH)
        except Exception as e:
            self.log(f"터치센서 사용 불가: {e}", "warn")
        try:
            from cove_sense import open_tofs
            t = open_tofs()
            self.tof_front, self.tof_top, self._xshut = t.get("front"), t.get("top"), t.get("_xshut")
            self.multi_addr = t.get("front_multi")
            front = "있음" if self.tof_front else ("다구역(VL53L5CX) — 여는 중 약 10초" if self.multi_addr else "없음")
            self.log(f"ToF: 전면 {front}, 위 {'있음' if self.tof_top else '없음 (팔/손 감지 불가)'}")
        except Exception as e:
            self.log(f"ToF 사용 불가: {e}", "warn")
        threading.Thread(target=self._touch_loop, daemon=True).start()
        threading.Thread(target=self._tof_loop, daemon=True).start()

    def _touch_loop(self):
        while True:
            if self.touch_dev:
                try:
                    st = self.touch_dev.read()
                    on = any(st.values())
                    each = [bool(st.get("left")), bool(st.get("center")), bool(st.get("right"))]
                except Exception:
                    on = False
                    each = [False, False, False]
                now = time.time()
                with self.lock:
                    for i, v in enumerate(each):
                        if v and not self.touch_each[i]:
                            self.touch_events.append((now, i + 1))
                    self.touch_events = [e for e in self.touch_events if now - e[0] <= 3.0][-6:]
                    self.touch_each = each
                    for i, v in enumerate(each):
                        if v:
                            self.touch_each_t[i] = now
                    if on:
                        if self.touch_since is None or now - self.touch_last > self.TOUCH_GAP:
                            self.touch_since = now
                        self.touch_last = now
            time.sleep(0.02)

    def _open_multi(self):
        try:
            from cove_sense import MultiTof
            t0 = time.time()
            self.tof_multi = MultiTof(self.multi_addr, res=MULTI_RES, hz=MULTI_HZ)
            self.log(f"전면 다구역 ToF 준비 ({MULTI_RES}x{MULTI_RES}, {MULTI_HZ}Hz, {time.time() - t0:.0f}초)")
        except Exception as e:
            self.log(f"전면 다구역 ToF 열기 실패: {e}", "warn")
        self.multi_addr = None

    def _multi_front(self, zones):
        """칸별 거리 → (가장 가까운 유효 거리, 방향 −1 왼쪽 ~ +1 오른쪽). 방향은 가장 가까운 것 +150mm 안의 칸들 열 평균,
        DIR_MM 보다 멀면 None"""
        n = MULTI_RES
        valid = [(mm, k % n) for k, mm in enumerate(zones) if mm and mm > 0]   # −1 없음, 0 약함, None 실패 제외
        if not valid:
            return None, None
        near = min(mm for mm, _ in valid)
        if near > DIR_MM:
            return near, None
        cols = [c for mm, c in valid if mm <= near + 150]
        return near, round((sum(cols) / len(cols) - (n - 1) / 2) / ((n - 1) / 2), 2)

    def _tof_loop(self):
        if self.multi_addr:
            self._open_multi()
        while True:
            fresh = True
            if self.tof_front:
                f = self.tof_front.read()
            elif self.tof_multi:
                r = self.tof_multi.read()
                fresh = r is not None
                if fresh:
                    f, d = self._multi_front(r[0])
                    with self.lock:
                        self.zones, self.zones_t, self.front_dir = r[0], time.time(), d
            else:
                f = None
            t = self.tof_top.read() if self.tof_top else None
            now = time.time()
            with self.lock:
                if fresh:
                    self.front = f
                    if f is not None and f <= PERSON_MM:
                        self.person_since = self.person_since or now
                        self.away_since = None
                    else:
                        self.away_since = self.away_since or now
                        self.person_since = None
                    if f is not None and f <= NEAR_MM:
                        self.close_since = self.close_since or now
                    else:
                        self.close_since = None
                self.top = t
                arm = False
                if t is not None and self.top_base is not None:
                    arm = self.top_base - t > ARM_DELTA_MM
                if t is not None and not arm:     # 팔이 없을 때만 바닥 거리를 천천히 따라감
                    self.top_base = t if self.top_base is None else self.top_base * 0.95 + t * 0.05
                if arm:
                    self.arm_since = self.arm_since or now
                    self.clear_since = None
                else:
                    self.clear_since = self.clear_since or now
                    self.arm_since = None
            if not (self.tof_front or self.tof_top):
                time.sleep(0.02 if self.tof_multi else 0.5)

    # ---- "얼마나 오래" (초). 해당 상태가 아니면 0 ----
    def _for(self, since):
        return time.time() - since if since else 0.0

    def person_for(self):
        return self._for(self.person_since)

    def away_for(self):
        return self._for(self.away_since)

    def close_for(self):
        return self._for(self.close_since)

    def arm_for(self):
        return self._for(self.arm_since) if self.tof_top else 0.0

    def clear_for(self):
        return self._for(self.clear_since) if self.tof_top else 9999.0

    def touched_for(self):
        with self.lock:
            if self.touch_since and time.time() - self.touch_last <= self.TOUCH_GAP:
                return time.time() - self.touch_since
        return 0.0

    def untouched_for(self):
        return time.time() - self.touch_last if self.touch_last else 9999.0

    def snapshot(self):
        return {"front_mm": self.front, "top_mm": self.top,
                "top_base": round(self.top_base) if self.top_base else None,
                "person": self.person_for() > 0, "close": self.close_for() > 0,
                "arm": self.arm_for() > 0, "touch": self.touched_for() > 0,
                "touch_each": list(self.touch_each),                                            # 센서별 지금 닿음 [1번 왼쪽, 2번 가운데, 3번 오른쪽]
                "touch_order": [n for t, n in self.touch_events if time.time() - t <= 3.0],            # 최근 3초 안에 새로 닿은 센서 번호를 닿은 순서대로 (예: [3, 2] = 3번 먼저, 2번 나중)
                "touch_recent": [time.time() - t <= 1.6 for t in self.touch_each_t],            # 센서별 최근 1.6초 안에 닿았음(상태 값이 1.5초마다라 짧게 쳐도 놓치지 않게)
                "top_ok": bool(self.tof_top), "front_ok": bool(self.tof_front or self.tof_multi),
                "front_multi": bool(self.tof_multi), "dir": self.front_dir}

    def zones_msg(self):
        """대시보드 실시간 4x4 표시용 (booth/<id>/tof). 새 값이 없으면 None"""
        with self.lock:
            if not self.zones or time.time() - self.zones_t > 1.0:
                return None
            return {"n": MULTI_RES, "z": self.zones, "dir": self.front_dir, "near": self.front,
                    "person_mm": PERSON_MM, "dir_mm": DIR_MM, "ts": round(self.zones_t, 2)}


# =====================================================================
# 로봇
# =====================================================================
def flatten(steps):
    for st in steps:
        if "repeat" in st:
            for _ in range(int(st["repeat"])):
                yield from flatten(st["steps"])
        else:
            yield st


class Player:
    def __init__(self, name, source):
        self.name, self.source = name, source
        self.steps, self.idx, self.until = list(flatten(SCENES[name])), 0, 0.0
        self.motion = None             # 재생 중인 기록 동작: (t0, ts, cols, speed, k)
        self.eye_tl, self.eye_i = [], 0  # 기록 동작과 같이 도는 눈 표정 시간표 [(t, 표정, gx)] (웹 모션)


class Robot(BaseRobot):
    # state: init → homing → ready(대기/씬 재생) / stopped / error
    def __init__(self, args):
        super().__init__(args, args.id, ROBOT_NAME, VERSION)
        self.state, self.after = "init", "ready"
        self.mot, self.next_init, self.fault = None, 0.0, None
        self.player, self.homing_deadline, self.t_check = None, 0.0, 0.0
        self.auto = False                  # 데모 반복은 아직 없음 (센서 반응 단계에서)
        try:
            self.pair = PairLimit.load(PAIR_FILE)
            self.log("ID3→ID4 연동 제한 로드")
        except Exception as e:
            self.pair = None
            self.log(f"ID3→ID4 연동 제한 없음 ({e}) — ID4 는 단순 범위만 적용", "warn")
        self.eyes = Eyes(self.log)
        # 센서 반응 (시나리오 모드)
        self.mode = None                   # None(센서 반응 끔) / "rest" / "tickle" / "snack"
        self.d_state, self.d_t = "idle", time.time()
        self.d_pending = None              # 휴식 중 모드를 바꾸면 rest_6_release 뒤에 적용
        self.d_need_leave, self.d_cool_until = False, 0.0
        self.d_warned = set()
        self.posing, self.pose_t = False, 0.0       # 웹 실시간 조그 중인지
        self.senses = Senses(self.log)
        threading.Thread(target=self._tof_pub_loop, daemon=True).start()

    def _tof_pub_loop(self):
        """전면 다구역 ToF 4x4 값을 대시보드로 (상태 1초 간격보다 자주)"""
        import json
        while True:
            time.sleep(TOF_PUB_SEC)
            if not (self.client and self.connected):
                continue
            m = self.senses.zones_msg()
            if m:
                self.client.publish(f"booth/{self.id}/tof", json.dumps(m), qos=0)

    # ---------- 센서 반응 (시나리오 모드) ----------
    def _set_mode(self, name):
        name = name if name in MODES else None
        if self.d_state in ("r3a", "r3", "r5", "r6"):          # 휴식에서 팔이 머리 밑에 있을 수 있음 → 반드시 놓아주고 바꿈
            self.d_pending = name or "off"
            if self.d_state != "r6" and not self.player:
                self._d_go("r6", "rest_6_release")
            self.log(f"모드 변경 예약 → 먼저 rest_6_release 로 놓아줌")
            return
        if self.mode == "track" and name != "track" and self.mot and self.mot.on and not self.player:
            self.mot.goto({1: HOME[1]}, vel=TRACK_VEL // 2)          # 따라보기를 끄면 정면으로
        self.mode = name
        self.d_state, self.d_t, self.d_need_leave = "idle", time.time(), False
        self.log(f"센서 반응 모드: {MODE_NAME.get(name, '끔')}")
        if not name and self.mot and self.mot.on and not self.player:
            self._idle_torque(False)

    # 조각이 없을 때 대신 쓸 조각 (요청서: 반복 꼬기가 없으면 tickle_3_squirm 한 번 틀고 끝나면 판단)
    PIECE_FALLBACK = {"tickle_squirm_loop": "tickle_3_squirm"}

    def _d_go(self, state, piece=None):
        """다음 단계로. piece 가 있으면 그 조각을 틀고, 없으면 바로 상태만 바꿈"""
        if piece and piece not in SCENES and self.PIECE_FALLBACK.get(piece) in SCENES:
            piece = self.PIECE_FALLBACK[piece]
        if piece:
            if piece not in SCENES:
                if piece not in self.d_warned:
                    self.d_warned.add(piece)
                    self.log(f"씬 '{piece}' 가 cove_scenes.py 에 없음 — 이 단계 건너뜀", "warn")
            else:
                self._play(piece, "sensor")
        self.d_state, self.d_t = state, time.time()

    def _d_finish(self, piece=None):
        """시나리오 끝: 정리 조각을 틀고 'end' → 끝나면 대기 (사람이 떠나거나 COOLDOWN 지나야 다시 시작)"""
        self._d_go("end", piece)

    def _track_tick(self, now):
        """따라보기: 새 4x4 값이 올 때마다 사람 방향만큼 ID1 을 돌림 (현재 위치 기준이라 쌓이지 않음). 안 보이면 원점으로."""
        s = self.senses
        if s.zones_t <= getattr(self, "_track_t", 0):
            return
        self._track_t = s.zones_t
        d = s.front_dir
        if d is not None:
            self._track_seen = now
            if abs(d) > TRACK_DEAD:
                p = self.mot.pos(1)
                if p is not None:
                    tgt = max(HOME[1] - TRACK_RANGE, min(HOME[1] + TRACK_RANGE, round(p + TRACK_SIGN * d * TRACK_GAIN)))
                    self.mot.goto({1: tgt}, vel=TRACK_VEL)
        elif now - getattr(self, "_track_seen", 0) > TRACK_LOST_SEC and self.mot.goal.get(1) != HOME[1]:
            self.mot.goto({1: HOME[1]}, vel=TRACK_VEL // 2)

    def _director(self, now):
        if self.state != "ready" or not self.mot or not self.mot.on or self.player or self.posing:
            return
        s, st, dt = self.senses, self.d_state, now - self.d_t
        if st == "end":
            self.d_state, self.d_t = "idle", now
            self.d_need_leave, self.d_cool_until = True, now + COOLDOWN_SEC
            self._idle_torque(False)
            if self.d_pending:
                p, self.d_pending = self.d_pending, None
                self._set_mode(None if p == "off" else p)
            return
        if not self.mode:
            return
        if self.mode == "track":
            self._track_tick(now)
            return
        away = s.away_for() >= LEAVE_SEC
        timeout = dt > WAIT_TIMEOUT
        if st == "idle":
            if self.d_need_leave:
                if s.away_for() >= 3.0 or now >= self.d_cool_until:
                    self.d_need_leave = False
                else:
                    return
            if s.person_for() >= PERSON_SEC:
                first = {"rest": ("r1", "rest_1_wake"), "tickle": ("t1", "tickle_1_look"), "snack": ("s1", "snack_1_look")}
                self.log(f"사람 인식 → {MODE_NAME[self.mode]} 시작")
                self._d_go(*first[self.mode])
            return

        # ---- #1 휴식 ----
        if st == "r1":
            if s.touched_for() > 0:
                self._d_go("r2", "rest_2_invite")
            elif timeout or away:
                self._d_finish("home")
        elif st == "r2":
            if s.arm_for() >= 0.3:
                if "rest_3_hug" in SCENES:
                    self._d_go("r3", "rest_3_hug")
                else:                                      # 디자이너가 둘로 나눔: 오물오물(nibble) → 기대기(lean)
                    self._d_go("r3a", "rest_3_nibble")
            elif (timeout or away) and s.arm_for() == 0:
                self._d_finish("home")
        elif st == "r3a":                                  # 오물오물 끝 → 바로 기대기
            self._d_go("r3", "rest_4_lean")
        elif st == "r3":                                   # 기대기 끝 (고개 힘 60 유지 중)
            if s.touched_for() > 0 or s.clear_for() >= REST_ARM_OUT_SEC or timeout or away:
                self._d_go("r6", "rest_6_release")
            elif dt >= REST_SLEEP_ARM_SEC and s.arm_for() >= REST_SLEEP_ARM_SEC:
                self._d_go("r5", "rest_5_sleep")
        elif st == "r5":                                   # 잠듦
            if s.touched_for() > 0 or s.clear_for() >= REST_ARM_OUT_SEC or dt > REST_SLEEP_MAX:
                self._d_go("r6", "rest_6_release")
        elif st == "r6":                                   # 놓아주기 끝
            self._d_finish()

        # ---- #2 간지럽히기 ----
        elif st == "t1":
            if s.touched_for() > 0:
                self._d_go("ts", "tickle_squirm_loop")
            elif timeout or away:
                self._d_finish("tickle_6_end")
        elif st == "ts":                                   # 꼬기 한 번 끝
            if s.touched_for() >= TICKLE_LAUGH_SEC:
                self._d_go("tl", "tickle_5_laugh")
            elif s.touched_for() > 0:
                self._d_go("ts", "tickle_squirm_loop")
            else:
                self._d_go("tc", "tickle_calm")
        elif st in ("tc", "tl"):                           # 진정/웃음 끝 → 다음 터치 기다림
            if s.touched_for() > 0:
                self._d_go("ts", "tickle_squirm_loop")
            elif s.untouched_for() >= TOUCH_END_SEC and dt >= TOUCH_END_SEC or away:
                self._d_finish("tickle_6_end")

        # ---- #3 간식 주기 ----
        elif st == "s1":
            if s.close_for() > 0.2:
                self._d_go("s3", "snack_3_sniff")
            elif timeout or away:
                self._d_finish("home")
        elif st == "s3":
            if s.close_for() >= NEAR_SEC:
                self._d_go("s4", "snack_4_expect")
            elif timeout or away:
                self._d_finish("home")
        elif st == "s4":                                   # 입 벌림 — 손이 들어오길 기다림
            if s.arm_for() >= 0.2:
                self._d_go("s4h")
            elif timeout or away:
                self._d_finish("home")
        elif st == "s4h":                                  # 손 들어옴 — 빠질 때까지 기다렸다가 먹기 (안전)
            if s.clear_for() >= SNACK_HAND_OUT_SEC:
                self._d_finish("snack_5_eat")

    # ---------- 상태 전환 ----------
    def _start_homing(self, after="ready", vel=START_VEL):
        if self.player:
            self.log(f"씬 '{self.player.name}' 중단됨")
            self.player = None
        for i in (2, 3):
            self.mot.set_current(i, GOAL_CURRENT[i])
        self.mot.goto(dict(HOME), vel=vel)
        self.state, self.after = "homing", after
        self.homing_deadline = time.time() + HOMING_TIMEOUT

    def _stop(self, reason):
        self.player = None
        hugging = self.d_state in ("r3a", "r3", "r5")
        self.mode, self.d_state, self.d_pending = None, "idle", None      # 정지하면 센서 반응도 끔
        if self.mot and self.mot.on:
            self.mot.hold()
            if not hugging:
                self._idle_torque(False)
        self.state = "stopped" if self.state != "error" else "error"
        self.log(f"정지 ({reason}), 센서 반응 꺼짐" + (" — 팔이 머리 밑에 있으면 rest_6_release 실행" if hugging else ""), "warn")

    # ---------- 씬 ----------
    def _idle_torque(self, on):
        """씬 시작 시 IDLE_TORQUE_OFF 축 토크 켜기, 끝나면 끄기"""
        for i in IDLE_TORQUE_OFF:
            if not self.mot.torque_one(i, on):
                self.log(f"ID{i} {AXIS_NAME[i]} 토크 {'켜기' if on else '끄기'} 실패", "warn")

    def _play(self, name, source):
        self._idle_torque(True)
        self.player = Player(name, source)
        self.log(f"씬 '{name}' 시작 ({'자동' if source == 'auto' else '트리거'})")

    def _scene_done(self, msg):
        self.log(msg)
        self.player = None
        if self.mode and self.d_state not in ("idle",):
            self.d_t = time.time()         # 기다리는 시간은 조각이 끝난 때부터. 시나리오 중에는 목(ID2) 힘 유지
        else:
            self._idle_torque(False)

    def _tick_motion(self, now):
        """기록 동작(CSV) 재생: 3프레임 앞을 목표로, 거기까지 맞춰 가는 속도로 (motion_play.py 와 같은 방식). 끝나면 True"""
        t0, ts, cols, speed, k = self.player.motion
        t = (now - t0) * speed
        tl = self.player.eye_tl                  # 웹 표정 시간표 (모션 시간 기준)
        while self.player.eye_i < len(tl) and tl[self.player.eye_i][0] <= t:
            _, expr, gx = tl[self.player.eye_i]
            self.eyes.set(expr, gx)
            self.player.eye_i += 1
        while k < len(ts) and ts[k] <= t:
            nk = min(k + 3, len(ts) - 1)
            dt = max(0.02, (ts[nk] - ts[k]) / speed)
            targets = {i: cols[i][nk] for i in cols if i in IDS}
            for i in targets:
                vel = max(2, min(MAX_VEL, round(abs(cols[i][nk] - cols[i][k]) / dt / VEL_TICKS)))
                self.mot.goto({i: targets[i]}, vel=vel)
            k += 1
        self.player.motion = (t0, ts, cols, speed, k)
        return k >= len(ts)

    def _tick_player(self, now):
        p = self.player
        if p.motion:
            if not self._tick_motion(now):
                return False
            p.motion = None
        while p.idx < len(p.steps) and now >= p.until:
            st = p.steps[p.idx]
            p.idx += 1
            if "motion" in st:
                try:
                    ts, cols = load_motion(str(st["motion"]), st.get("smooth", 4))
                    p.motion = (now, ts, cols, float(st.get("speed", 1.0)), 0)
                    p.eye_tl, p.eye_i = self.eyes.timeline(st["eyes"]) if st.get("eyes") else [], 0
                    return False
                except Exception as e:
                    self.log(f"기록 동작 '{st['motion']}' 재생 실패: {e}", "warn")
            elif "rel" in st or "move" in st:
                t = float(st.get("time", 0))
                targets = {int(k): int(v) for k, v in st.get("move", {}).items()}
                targets.update({int(k): HOME[int(k)] + int(v) for k, v in st.get("rel", {}).items()})
                self.mot.goto(targets, duration=t or None, vel=None if t else MAX_VEL)
                p.until = now + t
            elif "current" in st:
                for k, v in st["current"].items():
                    self.mot.set_current(int(k), int(v))
            elif "eyes" in st:
                self.eyes.set(st["eyes"])
            elif "wait" in st:
                p.until = now + float(st["wait"])
        return p.idx >= len(p.steps) and now >= p.until

    # ---------- 명령 ----------
    def do_cmd(self, cmd):
        c = cmd.get("cmd")
        if c in SCENES:
            cmd, c = {"cmd": "scene", "name": c}, "scene"
        if c == "stop":
            if self.mot:
                self._stop("정지 명령")
        elif c == "torque":
            if cmd.get("on", True):
                if self.mot and not self.mot.on:
                    self.mot.enable(START_VEL)
                    self.state = "stopped"
                    self.log("토크 켜짐 (현재 위치 유지). 'home' 씬으로 원점 복귀 가능")
            else:
                if self.mot:
                    self._stop("토크 해제")
                    self.log(f"토크 꺼짐 확인: ID {self.mot.torque_off()}", "warn")
        elif c == "scene":
            name = cmd.get("name")
            if self.state in ("init", "error"):
                self.log(f"지금은 씬 실행 불가 ({self.state})", "warn")
            elif name not in SCENES:
                self.log(f"알 수 없는 씬: {name}", "warn")
            elif not self.mot.on:
                self.log("토크가 꺼져 있어 씬 실행 불가 — 토크 켜기 먼저", "warn")
            elif self.state == "homing":
                self.log("초기 위치로 가는 중이라 씬 무시", "warn")
            elif self.d_state in ("r3a", "r3", "r5") and name != "rest_6_release":
                self.log("휴식 중(팔이 머리 밑에 있을 수 있음) — rest_6_release 외의 씬은 거부", "warn")
            else:
                if self.player:
                    self.log(f"씬 '{self.player.name}' 중단됨")
                self.state = "ready"
                if self.mode:                    # 센서 시나리오 도중 손으로 튼 씬: 끝나면 대기로
                    self.d_state = "end"
                self._play(name, "manual")
        elif c == "mode":                        # {"cmd":"mode","name":"rest"|"tickle"|"snack"|"off"}
            self._set_mode(str(cmd.get("name", "off")))
        elif c == "pose":                        # 웹 실시간 조그 {"cmd":"pose","deg":{"neck":..,"head":..,"tilt":..,"body":..}}
            if not (self.mot and self.mot.on) or self.state not in ("ready", "stopped"):
                return
            if self.d_state in ("r3a", "r3", "r5"):
                self.log("휴식 중(팔이 머리 밑에 있을 수 있음) — pose 무시", "warn")
                return
            if self.player:
                self.log(f"씬 '{self.player.name}' 중단 — 웹 실시간 조그")
                self.player = None
            if not self.posing:
                self.posing = True
                self._idle_torque(True)
                self.log("웹 실시간 조그 시작 (pose)")
            self.pose_t = time.time()
            self.state = "ready"
            self.mot.goto(web_pose_targets(cmd.get("deg", {})), duration=POSE_DT)
        elif c == "current":                     # {"cmd":"current","id":3,"value":80}
            if self.mot and self.mot.set_current(int(cmd.get("id", 0)), int(cmd.get("value", 0))):
                self.log(f"ID{cmd.get('id')} 목표 전류 {cmd.get('value')}")
        elif c == "eyes":
            self.eyes.set(str(cmd.get("mode", "idle")))
        elif c == "reload":                      # cove_scenes.py 다시 읽기 (모션 수정 후 재시작 없이)
            try:
                self.log(f"씬 다시 읽음: {', '.join(reload_scenes())}")
            except Exception as e:
                self.log(f"씬 파일 오류 (이전 씬 유지): {e}", "error")
        elif c == "auto":
            self.auto = bool(cmd.get("on", True))
            self.log(f"자동 반복 {'켜짐' if self.auto else '꺼짐'} (아직 데모 씬 없음)")
        else:
            super().do_cmd(cmd)

    # ---------- 준비 / 루프 ----------
    def _init_hw(self):
        io = None
        try:
            io = DxlIO(self.args.dxl_port, self.args.dxl_baud)
            mot = Motors(io, self.pair)
            mot.prepare()
            for i in IDS:
                self.log(f"ID{i} {AXIS_NAME[i]}: 현재 {mot.pos(i)} (보정 {mot.offset[i]:+d}) → 원점 {HOME[i]}")
            mot.enable(START_VEL)
            self.mot = mot
            self._start_homing("ready", START_VEL)
            self.log("토크 켜짐, 원점으로 이동 중")
        except Exception as e:
            if io:
                io.close()
            self.log(f"하드웨어 준비 실패: {e} — 5초 뒤 다시 시도", "error")
            self.next_init = time.time() + 5

    # ---------- 씬 파일 자동 반영 / 로컬 명령 ----------
    def _watch_scenes(self, now):
        """cove_scenes.py 가 바뀌면 자동으로 다시 읽음 (모션 작성자가 저장만 하면 반영). 씬 재생 중에는 끝난 뒤 반영."""
        if now - getattr(self, "_scene_check_t", 0) < 1.0 or self.player:
            return
        self._scene_check_t = now
        try:
            m = os.path.getmtime(cove_scenes.__file__)
        except OSError:
            return
        if getattr(self, "_scene_mtime", None) is None:
            self._scene_mtime = m
        elif m != self._scene_mtime:
            self._scene_mtime = m
            try:
                self.log(f"씬 파일 바뀜 → 다시 읽음: {', '.join(reload_scenes())}")
            except Exception as e:
                self.log(f"씬 파일 오류 (이전 씬 유지): {e}", "error")

    def start_local_cmd(self):
        """같은 파이 안에서 명령 받기 (UDP 127.0.0.1:47901) — cove_cmd.py 가 보냄. 제어 PC 없이도 씬 실행 가능."""
        import json

        def loop():
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.bind(("127.0.0.1", LOCAL_CMD_PORT))
            except OSError as e:
                self.log(f"로컬 명령 포트 {LOCAL_CMD_PORT} 사용 불가: {e}", "warn")
                return
            while True:
                data, _ = s.recvfrom(4096)
                self.handle(data)

        threading.Thread(target=loop, daemon=True).start()

    def run(self):
        while not self.quit:
            now = time.time()
            self._watch_scenes(now)
            if self.mot is None:
                if now >= self.next_init:
                    self._init_hw()
                time.sleep(0.05)
                continue
            try:
                self.pump_cmds(0.0)
                if self.fault and self.state != "error":
                    self.player, self.state = None, "error"
                    self.log(f"{self.fault} — 동작 중지. 모터 전원을 껐다 켠 뒤 다시 실행", "error")
                if self.state == "homing":
                    if now - self.t_check >= 0.1:
                        self.t_check = now
                        if self.mot.arrived() or now > self.homing_deadline:
                            self.state = self.after
                            self._idle_torque(False)
                            self.log("원점 도착, 대기 (씬: " + ", ".join(SCENES) + "). ID2 토크는 씬 중에만 켬")
                elif self.state == "ready" and self.player:
                    if self._tick_player(now):
                        self._scene_done(f"씬 '{self.player.name}' 완료")
                if self.posing and now - self.pose_t > POSE_END_SEC:
                    self.posing = False
                    self.log("웹 실시간 조그 끝 (지금 자세 유지)")
                    near_home = all(abs(self.mot.goal.get(i, HOME[i]) - HOME[i]) < 30 for i in IDLE_TORQUE_OFF)
                    if not self.player and not self.mode and near_home:      # 목을 든 채로 끝나면 토크 유지 (끄면 처짐)
                        self._idle_torque(False)
                self._director(now)
            except Exception as e:
                self.log(f"오류: {e}", "error")
                time.sleep(0.5)
            time.sleep(0.03)

    def shutdown(self):
        try:
            if self.mot and self.mot.on and self.state not in ("error",):
                print("종료 중 — 원점으로 이동 (Ctrl+C 한 번 더: 바로 토크 끔)", flush=True)
                self.player = None
                if self.d_state in ("r3a", "r3", "r5"):          # 휴식 중: 팔이 빠지도록 고개부터 들고 5초 기다림
                    self.mot.set_current(3, GOAL_CURRENT[3])
                    self.mot.goto({3: HOME[3] - 500}, vel=START_VEL)
                    end = time.time() + 5
                    while time.time() < end and self.quit < 2:
                        time.sleep(0.1)
                self.mot.goto(dict(HOME), vel=START_VEL)
                end = time.time() + HOMING_TIMEOUT
                while time.time() < end and self.quit < 2 and not self.mot.arrived():
                    time.sleep(0.1)
        except Exception as e:
            print(f"[경고] 종료 중 오류: {e}", flush=True)
        if self.mot:
            print(f"토크 꺼짐 확인: ID {self.mot.torque_off() or '없음'}", flush=True)
            self.mot.close()
        self.eyes.set("off")
        time.sleep(0.1)
        self.eyes.close()
        self.stop_mqtt()

    # ---------- 상태 ----------
    def status(self):
        motors = []
        if self.mot:
            try:
                motors = self.mot.read_status()
            except Exception:
                motors = [{"id": i, "ok": False} for i in IDS]
            bad = [m["id"] for m in motors if m.get("err")]
            if bad:
                self.fault = f"ID {bad} HW 에러"
        p = self.player
        state = ("auto" if p.source == "auto" else "running") if (p and self.state == "ready") else \
            ("idle" if self.state == "ready" else self.state)
        return self.base_status(state=state, scene=p.name if p else None, source=p.source if p else None,
                                auto=self.auto, scenes=list(SCENES), motors=motors, eyes=self.eyes.mode,
                                modes=MODES, mode_names=MODE_NAME, mode=self.mode, step=self.d_state,
                                sense=self.senses.snapshot())


def main():
    ap = argparse.ArgumentParser(description="로보월드 부스 — COVE 클라이언트")
    ap.add_argument("--id", default=ROBOT_ID or socket.gethostname().split(".")[0])
    ap.add_argument("--broker", default="auto", help='"auto", 제어 PC 주소, 또는 "none"')
    ap.add_argument("--port", type=int, default=BROKER_PORT)
    ap.add_argument("--dxl-port", default=DXL_PORT)
    ap.add_argument("--dxl-baud", type=int, default=DXL_BAUD)
    args = ap.parse_args()

    robot = Robot(args)
    print(f"COVE '{args.id}' 시작 — Ctrl+C: 원점으로 간 뒤 토크 끄고 종료", flush=True)

    def _quit(*_):
        robot.quit += 1

    signal.signal(signal.SIGINT, _quit)
    signal.signal(signal.SIGTERM, _quit)
    robot.start_threads()
    robot.start_local_cmd()
    robot.run()
    robot.shutdown()


if __name__ == "__main__":
    main()
