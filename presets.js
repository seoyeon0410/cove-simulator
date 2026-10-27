// 프리셋 클립. keys: [시간(초), 기둥°, 머리°, 갸웃(헤드 스위블)°, 몸통 좌우 회전°] — 기본(접힌) 포즈가 0°.
// 깨어난 기본 자세는 기둥 25° / 머리 -34° (코브_기상인사 모션에서 가져온 값).
// 눈 LED 표정은 리그에 없어서 모션에는 반영되지 않는다.

const k = (t, col, head, sw = 0, body = 0) => [t, col, head, sw, body];

/* 기둥이 다 움직인 뒤에 헤드가 움직이게 한다.
   기둥과 머리가 함께 크게 변하는 구간(키 사이)을 둘로 쪼갠다:
   기둥이 올라갈 때는 [기둥 먼저 → 헤드], 내려올 때는 [헤드 먼저 → 기둥]. 나머지 값(스위블·몸통)은 구간 내내 보간한다. */
const SEQ_MIN = 3, SEQ_FRAC = 0.6;
function sequenceNeck(keys) {
  const out = [keys[0]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    const dCol = b[1] - a[1], dHead = b[2] - a[2];
    if (Math.abs(dCol) >= SEQ_MIN && Math.abs(dHead) >= SEQ_MIN) {
      const rising = dCol > 0, f = rising ? SEQ_FRAC : 1 - SEQ_FRAC;
      const t = +(a[0] + (b[0] - a[0]) * f).toFixed(3);
      const lerp = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * f;
      out.push([t, rising ? b[1] : a[1], rising ? a[2] : b[2], lerp(a[3], b[3]), lerp(a[4], b[4])]);
    }
    out.push(b);
  }
  return out;
}

/* ───── 시나리오 (스토리보드): 단계별 키는 t=0이 이전 단계의 끝 포즈와 같도록 맞춘다 ───── */
const WAKE = [k(0, 0, 0), k(1.2, 14, -20), k(2.2, 27, -37), k(3, 25, -34)];


/* 시나리오2·3은 실제 코브 시연 영상에서 목 높이(기둥)와 머리 기울기를 읽어 만든 키다.
   머리 각도는 목이 높을수록 같이 더 꺾이므로 "수평 기준 + 기울기(왼쪽이 올라가면 +)"로 표기한 뒤 변환한다: head = 기울기 - 1.2 × 기둥 */
const videoKeys = (rows) => sequenceNeck(rows.map(([t, col, tilt]) => [t, col, Math.max(-48, Math.min(8, tilt - 1.2 * col))]));

function videoSteps(rows, bounds) {
  const v = videoKeys(rows);
  const at = (t) => {
    if (t <= v[0][0]) return v[0].slice(1);
    for (let i = 1; i < v.length; i++) if (t <= v[i][0]) {
      const f = (t - v[i - 1][0]) / (v[i][0] - v[i - 1][0]);
      return [v[i - 1][1] + (v[i][1] - v[i - 1][1]) * f, v[i - 1][2] + (v[i][2] - v[i - 1][2]) * f];
    }
    return v[v.length - 1].slice(1);
  };
  return bounds.map(([a, b, name]) => {
    const dur = +(b - a).toFixed(3);
    const mid = v.filter(([t]) => t > a && t < b).map(([t, c, h]) => [+(t - a).toFixed(3), c, h]);
    const [c0, h0] = at(a), [c1, h1] = at(b);
    return { name, duration: dur, keys: [[0, c0, h0], ...mid, [dur, c1, h1]] };
  });
}

// 시나리오2 간지럽히기 (영상 49초): [시간, 기둥°, 기울기°]
const TICKLE_VIDEO = [
  [0, 0, 0], [0.5, 0, 0], [1.5, 8, -10], [2.5, 8, -10], [3.5, 9, -3], [4.5, 11, 3], [5.5, 11, 5], [6.5, 12, -3], [7.5, 14, 0],
  [8.5, 14, 8], [9.5, 13, 10], [10.5, 13, 5], [11.5, 10, -12], [12.5, 15, 5], [13.5, 15, 0], [14.5, 13, -6], [15.5, 13, -5],
  [16.5, 12, -3], [17.5, 12, -3], [18.5, 16, 15], [19.5, 17, 15], [20.5, 24, 25], [21.5, 24, 20], [22.5, 24, 22], [23.5, 24, 20],
  [24.5, 24, 22], [25.5, 24, 15], [26.5, 24, 15], [27.5, 24, 20], [28.5, 24, 25], [29.5, 22, -5], [30.5, 22, -5], [31.5, 22, -5],
  [32.5, 20, 22], [33.5, 20, 20], [34.5, 26, 25], [35.5, 26, 25], [36.5, 26, 25], [37.5, 26, 28], [38.5, 26, 25], [39.5, 20, 5],
  [40.5, 14, -5], [41.5, 14, -3], [42.5, 16, 5], [43.5, 24, 20], [44.5, 24, 28], [45.5, 22, 10], [46.5, 18, 0], [47.5, 18, 0], [49.2, 18, 0],
];
const TICKLE_STEPS = [[0, 4, '01 사용자 인식'], [4, 8, '02 놀아 유도'], [8, 14, '03 첫 터치'], [14, 22, '04 반응 즐기기'], [22, 39, '05 깊은 교감'], [39, 49.2, '06 놀이 마무리']];

// 시나리오3 간식주기 (영상 35초)
const SNACK_VIDEO = [
  [0, 0, 0], [0.5, 0, 0], [1.5, 5, -8], [2.5, 8, -14], [3.5, 10, -14], [4.2, 12, -14], [4.7, 12, -14], [5.2, 14, -20],
  [6.2, 24, -5], [6.7, 28, -10], [7.2, 28, -5], [8.5, 28, -10], [10, 28, -8], [11.5, 18, 0], [13, 18, -2], [14.5, 20, -5],
  [16, 20, -3], [17.5, 24, -12], [19, 24, -12], [20.5, 22, -12], [22, 20, -5], [23.5, 20, 0], [25, 20, 10], [26, 18, 30],
  [27, 20, 22], [28, 22, 4], [29, 22, -8], [30, 22, -3], [31, 22, -8], [32, 22, -5], [33, 22, -3], [34, 20, -5], [34.8, 16, 0], [35.2, 16, 0],
];

/* 시나리오3 간식주기: 영상(SNACK_VIDEO)의 목 높이·머리 기울기를 바탕으로, 간식 프롬프트의 동작을 얹었다.
   바라보며 기둥 올리기 → 헤드 좌우 탐색 → 까딱이며 "이건 뭐지" → 고개·허리 최대로 → 씹기 → 만족 → 기분 좋게 까딱.
   0.1초 간격으로 구워서 만든다. 키: [t, 기둥, 머리, 스위블, 몸통] */
const SNACK_SECTIONS = [[0, 3, '01 사용자 바라보기 · 기둥 올리기'], [3, 9, '02 헤드 좌우 탐색'], [9, 14, '03 까딱까딱 · 이건 뭐지'], [14, 20, '04 고개 · 허리 최대로'], [20, 25, '05 씹기'], [25, 27, '06 만족'], [27, 35.2, '07 기분 좋은 까딱']];
function snackMergedSteps() {
  const base = videoKeys(SNACK_VIDEO);
  const at = (t) => {
    if (t <= base[0][0]) return base[0].slice(1);
    for (let i = 1; i < base.length; i++) if (t <= base[i][0]) {
      const f = (t - base[i - 1][0]) / (base[i][0] - base[i - 1][0]);
      return [base[i - 1][1] + (base[i][1] - base[i - 1][1]) * f, base[i - 1][2] + (base[i][2] - base[i - 1][2]) * f];
    }
    return base[base.length - 1].slice(1);
  };
  const bell = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
  const wave = (t, a, period) => Math.sin((2 * Math.PI * (t - a)) / period);
  const keys = [];
  const N = Math.round(35.2 * 10);
  for (let i = 0; i <= N; i++) {
    const t = +(i / 10).toFixed(3);
    let [col, head] = at(t), sw = 0, body = 0;
    if (t >= 4 && t <= 7) sw += -18 * wave(t, 4, 3) * Math.min(1, bell(t, 4, 7) * 2.2);                // 02 좌우 탐색
    if (t > 9.5 && t < 13.5) { const e = bell(t, 9.5, 13.5); sw += 10 * wave(t, 9.5, 0.9) * e; head += 3 * wave(t, 9.5, 0.9) * e; } // 03 까딱
    if (t >= 14.5 && t <= 19.5) col += 5 * bell(t, 14.5, 19.5);                                          // 04 허리를 최대로 세움
    if (t > 20.5 && t < 25) head += 7 * wave(t, 20.5, 0.55) * bell(t, 20.5, 25);                        // 05 씹기
    if (t > 27 && t < 34) { const e = bell(t, 27, 34); sw += 22 * wave(t, 27, 1.6) * e; body += 6 * wave(t, 27, 1.6) * e; col += 1.5 * wave(t, 27, 0.8) * e; } // 07 기분 좋은 까딱
    keys.push([t, col, Math.max(-50, Math.min(8, head)), sw, body]);
  }
  return SNACK_SECTIONS.map(([a, b, name]) => ({
    name, duration: +(b - a).toFixed(3),
    keys: keys.filter(([t]) => t >= a - 1e-6 && t <= b + 1e-6).map(([t, ...r]) => [+(t - a).toFixed(3), ...r]),
  }));
}

const SCENARIOS = [
  { name: '시나리오1 휴식', steps: [
    { name: '01 사용자 인식', duration: 3, keys: WAKE },
    { name: '02 휴식 유도', duration: 3, keys: [k(0, 25, -34), k(0.75, 25, -34, 0, 5), k(1.5, 25, -34, 0, -5), k(2.25, 25, -34, 0, 5), k(3, 25, -34)] },
    { name: '03 몸 올리기', duration: 3, keys: [k(0, 25, -34), k(1, 28, -22), k(1.5, 28, -27), k(2, 28, -22), k(2.5, 28, -27), k(3, 28, -22)] },
    { name: '04 기대기', duration: 4, keys: [k(0, 28, -22), k(1.5, 32, -10), k(4, 32, -10)] },
    { name: '05 휴식 유지', duration: 5, keys: [k(0, 32, -10), k(1.5, 31, -8), k(3, 32, -10), k(4, 31, -8), k(5, 30, -8)] },
    { name: '06 휴식 종료', duration: 4, keys: [k(0, 30, -8), k(1.5, 25, -34), k(2.2, 25, -34, 10), k(3, 25, -34, -10), k(4, 25, -34)] },
  ] },
  { name: '시나리오2 간지럽히기 (영상)', interp: 'linear', steps: videoSteps(TICKLE_VIDEO, TICKLE_STEPS) },
  { name: '시나리오3 간식주기', interp: 'linear', steps: snackMergedSteps() },
];

const whole = SCENARIOS.map((s) => {
  let t0 = 0; const keys = [], markers = [];
  s.steps.forEach((st, i) => {
    markers.push({ t: t0, label: st.name });
    st.keys.forEach((kk, j) => { if (i > 0 && j === 0) return; keys.push([kk[0] + t0, ...kk.slice(1)]); });
    t0 += st.duration;
  });
  return { name: s.name, duration: t0, keys, markers, interp: s.interp };
});
const steps = SCENARIOS.flatMap((s) => s.steps.map((st) => ({ name: `${s.name} · ${st.name}`, duration: st.duration, keys: st.keys, interp: s.interp })));


const BASIC = [
  { name: '숨쉬기', duration: 4, keys: [[0, 0, 0, 0], [2, 5, -6, 0], [4, 0, 0, 0]] },
  { name: '기상', duration: 3, keys: [[0, 0, 0, 0], [0.6, 3, -3, 0], [1.6, 30, -40, 0], [2.2, 24, -33, 0], [3, 25, -34, 0]] },
  { name: '끄덕끄덕', duration: 3, keys: [[0, 25, -34, 0], [0.5, 25, -20, 0], [1, 25, -36, 0], [1.5, 25, -20, 0], [2, 25, -36, 0], [3, 25, -34, 0]] },
  { name: '갸웃갸웃', duration: 4, keys: [[0, 25, -34, 0], [1, 25, -30, 14], [2, 25, -34, 0], [3, 25, -30, -14], [4, 25, -34, 0]] },
  { name: '두리번', duration: 6, keys: [[0, 25, -34, 0], [1.2, 27, -33, -15], [2.4, 27, -33, -15], [3.6, 23, -34, 15], [4.8, 23, -34, 15], [6, 25, -34, 0]] },
  { name: '졸기', duration: 6, keys: [[0, 25, -34, 0], [1.5, 22, -18, 3], [2.5, 22, -14, 5], [3, 26, -33, 0], [3.4, 25, -34, 0], [4.5, 20, -12, -4], [6, 25, -34, 0]] },
  { name: '놀람', duration: 2.5, keys: [[0, 0, 0, 0], [0.15, 35, -40, 0], [0.5, 32, -38, 8], [0.8, 34, -40, -8], [1.2, 28, -36, 0], [2.5, 25, -34, 0]] },
  { name: '신남', duration: 3, keys: [[0, 15, -22, 10], [0.5, 30, -38, -10], [1, 15, -22, 10], [1.5, 30, -38, -10], [2, 15, -22, 10], [2.5, 30, -38, -10], [3, 15, -22, 10]] },
  { name: '인사', duration: 4, keys: [[0, 25, -34, 0], [1, 35, -12, 0], [2.2, 35, -12, 0], [3.2, 25, -34, 0], [4, 25, -34, 0]] },
  { name: '부끄럼', duration: 3, keys: [[0, 25, -34, 0], [0.8, 12, -8, 12], [2.2, 12, -8, 12], [3, 25, -34, 0]] },
  { name: '잘자', duration: 4, keys: [[0, 25, -34, 0], [1.5, 12, -16, 0], [3, 0, 0, 0], [4, 0, 0, 0]] },
];

const seq = (items) => items.map((d) => ({ ...d, keys: sequenceNeck(d.keys) }));

export const PRESET_GROUPS = [
  { label: '시나리오 전체', items: seq(whole) },
  { label: '시나리오 단계', items: seq(steps) },
  { label: '기본 모션', items: seq(BASIC) },
];
