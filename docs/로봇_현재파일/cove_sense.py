#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
COVE 센서 모음 — ToF(VL53L0X), LD2410C(UART + OUT), 터치 TTP223 ×3

cove_robot.py 에서 import 해서 쓰고, 직접 실행하면 모든 센서 값을 한 줄로 실시간 표시 (읽기 전용):
    python3 cove_sense.py               # Ctrl+C 로 종료
    python3 cove_sense.py --seconds 20

- ToF: Adafruit adafruit-circuitpython-vl53l0x (pip) 사용. 없으면 ToF 만 건너뜀
- LD2410C: /dev/serial0 256000bps 기본 보고 프레임 해석 (상태, 이동/정지 거리·에너지, 감지 거리)
- 터치: gpiozero, 닿으면 HIGH
"""

import argparse
import sys
import threading
import time

PIN_TOUCH = {"left": 17, "center": 27, "right": 22}
PIN_LD_OUT = 23
LD_PORT, LD_BAUD = "/dev/serial0", 256000
LD_STATE = {0: "없음", 1: "이동", 2: "정지", 3: "이동+정지"}


PIN_TOF_XSHUT = 4              # XSHUT 이 연결된 ToF = 전면(사람 감지). 위 ToF(쉘에서 아래를 봄, 팔 감지)는 XSHUT 미연결
                               # (2026-10-26 사용자: 배선이 편해서 전면에 XSHUT. 10-21 엔 위쪽이었음)
TOF_XSHUT_ROLE, TOF_OTHER_ROLE = "front", "top"
TOF_XSHUT_ADDR, TOF_OTHER_ADDR = 0x29, 0x30       # XSHUT 없는 쪽(위)을 0x30 으로 옮기고, XSHUT 있는 쪽(전면)은 0x29 유지


class Tof:
    """VL53L0X 하나. read() → 거리 mm, 읽기 실패나 범위 밖이면 None."""

    def __init__(self, i2c, address=0x29):
        import adafruit_vl53l0x
        self.dev = adafruit_vl53l0x.VL53L0X(i2c, address=address)
        self.dev.measurement_timing_budget = 50000     # 50ms: 속도와 정확도 절충

    def read(self):
        try:
            d = self.dev.range
        except OSError:
            return None
        return None if d >= 8190 else d       # 8190+ = 측정 실패/범위 밖


class MultiTof:
    """전면 VL53L5CX (다구역 ToF, 2026-10-26 교체). 켤 때 펌웨어를 I2C 로 올려서 약 10초 걸림 → 센서 스레드 안에서 만들 것.
    read() → 새 값이 있으면 (zones, raw), 없으면 None.
      zones: 칸별 거리 mm (위 줄부터, 로봇이 볼 때 왼쪽 → 오른쪽), 물체 없음 −1, 측정 실패 None, 약함(MIN_MM 미만) 0
      raw:   센서가 준 거리 그대로 (상태 무시)"""

    MIN_MM = 30                    # 이보다 작은 값은 "약함" 0 — 먼 곳 반사가 약할 때 0mm 로 나옴 (가까운 물체는 읽힘, 2026-10-26 사용자 확인)
    FLIP_X, FLIP_Y = False, False  # 좌우는 이대로 맞음 (2026-10-26 사용자 확인). 위아래는 미확인
    OK_STATUS = (5, 9)             # 유효, 유효(큰 펄스)
    # 거리 늘리기 (2026-10-26 사용자 "값이 너무 적다"): 센서 기본값은 자동 모드 + 측정 시간 5ms 라 먼 반사를 못 모음.
    # 연속 모드 = 측정 주기 전체(10Hz 면 100ms)를 빛 모으는 데 씀 → 4x4 는 스펙상 최대 4m (조명이 밝으면 줄어듦)
    CONTINUOUS = True
    CLOSEST_FIRST = True           # 한 칸에 여러 물체가 겹치면 가까운 쪽 (사람 찾기용)

    def __init__(self, address=0x29, res=4, hz=10):
        from smbus2 import SMBus
        from i2cbus import I2C_BUS
        import vl53l5cx_ctypes as L5
        self.n = res
        self.dev = L5.VL53L5CX(i2c_addr=address, i2c_dev=SMBus(I2C_BUS))
        self.dev.set_resolution(res * res)
        if self.CONTINUOUS:
            self.dev.set_ranging_mode(L5.RANGING_MODE_CONTINUOUS)
        if self.CLOSEST_FIRST:
            self.dev.set_target_order(L5.TARGET_ORDER_CLOSEST)
        self.dev.set_ranging_frequency_hz(hz)
        self.dev.start_ranging()

    def read(self):
        try:
            if not self.dev.data_ready():
                return None
            d = self.dev.get_data()
        except Exception:
            return None
        n, zones, raw = self.n, [], []
        for r in range(n):
            for c in range(n):
                rr = n - 1 - r if self.FLIP_Y else r
                cc = n - 1 - c if self.FLIP_X else c
                k = rr * n + cc
                mm, st, nt = int(d.distance_mm[0][k]), int(d.target_status[0][k]), int(d.nb_target_detected[k])
                raw.append(mm)
                if nt == 0:
                    zones.append(-1)               # 물체 못 찾음 (너무 멀거나 반사 약함) — 상태값은 이 경우 의미 없음
                elif st not in self.OK_STATUS:
                    zones.append(None)             # 측정 실패
                else:
                    zones.append(0 if mm < self.MIN_MM else mm)
        return zones, raw


def open_tofs():
    """ToF 를 찾아서 {"front": Tof, "top": Tof} 로. 둘 다 기본 주소 0x29 라서 XSHUT 으로 순서를 만들어 주소를 나눔:
    1) XSHUT(GPIO4) 을 LOW 로 → 전면 ToF 꺼짐  2) 남아 있는 위 ToF(0x29) 를 열어 주소를 0x30 으로 바꿈
    3) XSHUT 을 HIGH 로 → 전면 ToF 가 0x29 로 켜짐. 전원을 다시 넣으면 둘 다 0x29 로 돌아오므로 매번 이 순서를 밟음.
    위 ToF 가 아직 없으면 전면 하나만 'front' 로 나옴."""
    from i2cbus import RawI2C
    i2c = RawI2C()
    out = {}
    xshut = None
    try:
        from gpiozero import DigitalOutputDevice
        xshut = DigitalOutputDevice(PIN_TOF_XSHUT, initial_value=False)      # XSHUT 쪽(전면) ToF 끔
        time.sleep(0.05)
    except Exception:
        xshut = None
    found = i2c.scan()
    if TOF_OTHER_ADDR in found:                      # 이미 주소가 나뉘어 있음 (프로그램만 재시작한 경우)
        out[TOF_OTHER_ROLE] = Tof(i2c, TOF_OTHER_ADDR)
    elif 0x29 in found:                              # XSHUT 을 LOW 로 했는데도 0x29 가 있음 = XSHUT 없는 쪽(위)
        other = Tof(i2c, 0x29)
        other.dev.set_address(TOF_OTHER_ADDR)
        out[TOF_OTHER_ROLE] = other
    if xshut is not None:
        xshut.value = True                           # 전면 ToF 켬 → 0x29
        time.sleep(0.05)
        try:
            if TOF_XSHUT_ADDR in i2c.scan():
                out[TOF_XSHUT_ROLE] = Tof(i2c, TOF_XSHUT_ADDR)
        except Exception as e:
            # VL53L0X 가 아니면 VL53L5CX(다구역) 로 봄 — 여는 데 10초 걸려서 여기선 표시만, 센서 스레드가 MultiTof 로 엶
            out[TOF_XSHUT_ROLE + "_multi"] = TOF_XSHUT_ADDR
            print(f"XSHUT 쪽 ToF(0x{TOF_XSHUT_ADDR:02x}) 는 VL53L0X 아님 ({e}) → 다구역(VL53L5CX) 으로 열 예정")
        out["_xshut"] = xshut                        # 핀을 계속 HIGH 로 유지해야 하므로 보관
    return out


class LD2410:
    """LD2410C 기본 보고 프레임을 백그라운드로 계속 읽어 마지막 값을 보관."""

    def __init__(self, port=LD_PORT, baud=LD_BAUD, out_pin=PIN_LD_OUT):
        import serial
        self.ser = serial.Serial(port, baud, timeout=0.2)
        self.last = None          # dict(state, moving_cm, moving_e, still_cm, still_e, detect_cm, ts)
        self.frames = 0
        self.out = None
        if out_pin is not None:
            try:
                from gpiozero import DigitalInputDevice
                self.out = DigitalInputDevice(out_pin, pull_up=False)
            except Exception:
                pass
        self._buf = b""
        self._stop = False
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while not self._stop:
            try:
                self._buf += self.ser.read(128)
            except Exception:
                time.sleep(0.1)
                continue
            while True:
                i = self._buf.find(b"\xf4\xf3\xf2\xf1")
                if i < 0:
                    self._buf = self._buf[-3:]
                    break
                if len(self._buf) < i + 6:
                    break
                n = self._buf[i + 4] | (self._buf[i + 5] << 8)
                end = i + 6 + n + 4
                if len(self._buf) < end:
                    break
                body, tail = self._buf[i + 6:i + 6 + n], self._buf[i + 6 + n:end]
                self._buf = self._buf[end:]
                if tail != b"\xf8\xf7\xf6\xf5" or len(body) < 11 or body[0] != 0x02 or body[1] != 0xAA:
                    continue       # 공학 모드 프레임이나 깨진 프레임은 건너뜀
                self.last = {
                    "state": body[2], "moving_cm": body[3] | body[4] << 8, "moving_e": body[5],
                    "still_cm": body[6] | body[7] << 8, "still_e": body[8],
                    "detect_cm": body[9] | body[10] << 8, "ts": time.time(),
                }
                self.frames += 1

    def present(self):
        """OUT 핀 (감지되면 True). OUT 이 없으면 프레임 상태로 판단."""
        if self.out is not None:
            return bool(self.out.value)
        return bool(self.last and self.last["state"] and time.time() - self.last["ts"] < 1.0)

    def close(self):
        self._stop = True
        try:
            self.ser.close()
        except Exception:
            pass
        if self.out is not None:
            self.out.close()


class Touch:
    """터치센서 3개. read() → {"left": bool, "center": bool, "right": bool}"""

    def __init__(self, pins=PIN_TOUCH):
        from gpiozero import DigitalInputDevice
        self.dev = {k: DigitalInputDevice(p, pull_up=False) for k, p in pins.items()}

    def read(self):
        return {k: bool(d.value) for k, d in self.dev.items()}

    def close(self):
        for d in self.dev.values():
            d.close()


def main():
    ap = argparse.ArgumentParser(description="COVE 센서 실시간 표시 (읽기 전용)")
    ap.add_argument("--seconds", type=float, default=0, help="0 = Ctrl+C 까지")
    args = ap.parse_args()
    tofs, ld, touch = {}, None, None
    try:
        tofs = open_tofs()
        print("ToF 준비됨: " + ", ".join(k for k in tofs if not k.startswith("_")))
    except Exception as e:
        print(f"ToF 사용 불가: {e}")
    tof = {k: v for k, v in tofs.items() if not k.startswith("_")}
    try:
        ld = LD2410()
        print("LD2410C 시리얼 준비됨")
    except Exception as e:
        print(f"LD2410C 사용 불가: {e}")
    try:
        touch = Touch()
        print("터치센서 준비됨")
    except Exception as e:
        print(f"터치센서 사용 불가: {e}")
    print("Ctrl+C 로 종료\n")
    t0 = time.time()
    try:
        while not args.seconds or time.time() - t0 < args.seconds:
            parts = []
            for name, t in tof.items():
                d = t.read()
                parts.append(f"ToF{'전면' if name == 'front' else '위'} {'----' if d is None else f'{d:4d}'}mm")
            if ld:
                L = ld.last
                parts.append(f"OUT {'감지' if ld.present() else '없음'}")
                parts.append("레이더 " + (f"{LD_STATE.get(L['state'], L['state'])} 이동{L['moving_cm']:3d}cm/{L['moving_e']:3d} "
                                        f"정지{L['still_cm']:3d}cm/{L['still_e']:3d} 감지{L['detect_cm']:3d}cm ({ld.frames}f)"
                                        if L else "프레임 없음"))
            if touch:
                t = touch.read()
                parts.append("터치 " + " ".join(f"{k[0].upper()}{'■' if v else '□'}" for k, v in t.items()))
            sys.stdout.write("\r\x1b[2K" + " | ".join(parts))
            sys.stdout.flush()
            time.sleep(0.1)
    except KeyboardInterrupt:
        pass
    finally:
        print()
        for s in (ld, touch):
            if s:
                s.close()


if __name__ == "__main__":
    main()
