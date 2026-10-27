// 프리셋 클립. keys: [시간(초), 기둥°, 머리°, 갸웃(헤드 스위블)°, 몸통 좌우 회전°] — 기본(접힌) 포즈가 0°.
// 깨어난 기본 자세는 기둥 25° / 머리 -34° (코브_기상인사 모션에서 가져온 값).
// 눈 LED 표정은 리그에 없어서 모션에는 반영되지 않는다.

const k = (t, col, head, sw = 0, body = 0) => [t, col, head, sw, body];

/* 기둥이 다 움직인 뒤에 헤드가 움직이게 한다.
   기둥과 머리가 함께 크게 변하는 구간(키 사이)을 둘로 쪼갠다:
   기둥이 올라갈 때는 [기둥 먼저 → 헤드], 내려올 때는 [헤드 먼저 → 기둥]. 나머지 값(스위블·몸통)은 구간 내내 보간한다. */
const SEQ_MIN = 3, SEQ_FRAC = 0.6, SEQ_SKIP = 3;   // 처음 일어나는 구간(3초 이전)은 기둥과 헤드를 함께 움직인다
function sequenceNeck(keys) {
  const out = [keys[0]];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    const dCol = b[1] - a[1], dHead = b[2] - a[2];
    if (a[0] >= SEQ_SKIP && Math.abs(dCol) >= SEQ_MIN && Math.abs(dHead) >= SEQ_MIN) {
      const rising = dCol > 0, f = rising ? SEQ_FRAC : 1 - SEQ_FRAC;
      const t = +(a[0] + (b[0] - a[0]) * f).toFixed(3);
      const lerp = (x, y) => (x ?? 0) + ((y ?? 0) - (x ?? 0)) * f;
      out.push([t, rising ? b[1] : a[1], rising ? a[2] : b[2], lerp(a[3], b[3]), lerp(a[4], b[4])]);
    }
    out.push(b);
  }
  return out;
}

/* 키 사이를 속도가 끊기지 않게 잇는다(단조 3차 보간, 오버슈트 없음) — 0.1초 간격으로 샘플링한다.
   기둥→헤드로 쪼갠 구간처럼 멈췄다 출발하는 곳은 자연스럽게 서서히 가속/감속된다. */
function pchipResample(keys, dt = 0.1) {
  const n = keys.length;
  if (n < 3) return keys;
  const T = keys.map((x) => x[0]);
  const chans = [1, 2, 3, 4].map((c) => {
    const y = keys.map((x) => x[c] ?? 0), h = [], d = [];
    for (let i = 0; i < n - 1; i++) { h[i] = T[i + 1] - T[i]; d[i] = h[i] > 1e-9 ? (y[i + 1] - y[i]) / h[i] : 0; }
    const m = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
    }
    return { y, m };
  });
  const out = [], total = Math.round((T[n - 1] - T[0]) / dt);
  let seg = 0;
  for (let i = 0; i <= total; i++) {
    const t = i === total ? T[n - 1] : +(T[0] + i * dt).toFixed(3);
    while (seg < n - 2 && t > T[seg + 1] + 1e-9) seg++;
    const h = T[seg + 1] - T[seg], sN = h > 1e-9 ? Math.max(0, Math.min(1, (t - T[seg]) / h)) : 0;
    const s2 = sN * sN, s3 = s2 * sN;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + sN, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    out.push([t, ...chans.map(({ y, m }) => h00 * y[seg] + h10 * h * m[seg] + h01 * y[seg + 1] + h11 * h * m[seg + 1])]);
  }
  return out;
}


/* ───── 자연스러운 목 움직임 ─────
   1) 스프링 추종: 목(기둥)과 헤드를 "목표 자세를 따라가는 스프링"으로 바꾼다. 목표가 움직이면 목이 먼저 반응하고
      헤드가 조금 늦게 따라오며(팔로스루), 도착할 때 살짝 지나쳤다가 제자리로 안착한다(오버슈트·정착).
   2) 미세한 흔들림: 목이 서 있는 동안 숨 쉬듯 ±0.5° 정도로 아주 천천히 흔들려 멈춘 인형처럼 보이지 않게 한다. */
const SPRING = { col: [9, 0.62], head: [7, 0.7] };      // [각주파수 ω(rad/s), 감쇠비 ζ]
function springFollow(samples, cfg = SPRING) {
  const n = samples.length, dt = samples[1][0] - samples[0][0], sub = 10, h = dt / sub;
  const out = samples.map((x) => x.slice());
  for (const [c, [w, z]] of [[1, cfg.col], [2, cfg.head]]) {
    let x = samples[0][c], v = 0;
    for (let i = 1; i < n; i++) {
      const a = samples[i - 1][c], b = samples[i][c];
      for (let k = 1; k <= sub; k++) { const tgt = a + ((b - a) * k) / sub; v += (w * w * (tgt - x) - 2 * z * w * v) * h; x += v * h; }
      out[i][c] = x;
    }
  }
  const tEnd = samples[n - 1][0];                    // 끝 0.8초는 원래 목표 자세로 수렴시켜, 끝 자세가 정확히 목표와 같게(반복 이음새 방지)
  out.forEach((x, i) => {
    const q = Math.min(1, Math.max(0, (x[0] - (tEnd - 0.8)) / 0.8)), k = q * q * (3 - 2 * q);
    x[1] = x[1] * (1 - k) + samples[i][1] * k; x[2] = x[2] * (1 - k) + samples[i][2] * k;
    x[1] = Math.min(35.5, Math.max(0, x[1])); x[2] = Math.min(8, Math.max(-50, x[2]));   // 한계를 넘지 않게
  });
  return out;
}
function microSway(keys) {
  return keys.map((k) => {
    const t = k[0], g = Math.min(1, Math.max(0, (k[1] - 2) / 10)), a = g * g * (3 - 2 * g);   // 접힌 자세에서는 0
    const col = k[1] + a * (0.45 * Math.sin((2 * Math.PI * t) / 3.7) + 0.25 * Math.sin((2 * Math.PI * t) / 5.9 + 1.3));
    const head = k[2] + a * (0.7 * Math.sin((2 * Math.PI * t) / 4.3 + 0.6) + 0.3 * Math.sin((2 * Math.PI * t) / 2.9 + 2.1));
    return [t, col, head, k[3], k[4]];
  });
}

/* ───── 시나리오 (스토리보드): 단계별 키는 t=0이 이전 단계의 끝 포즈와 같도록 맞춘다 ───── */
const WAKE = [k(0, 0, 0), k(1.2, 14, -20), k(2.2, 27, -37), k(3, 25, -34)];


/* 시나리오2·3은 실제 코브 시연 영상에서 목 높이(기둥)와 머리 기울기를 읽어 만든 키다.
   머리 각도는 목이 높을수록 같이 더 꺾이므로 "수평 기준 + 기울기(왼쪽이 올라가면 +)"로 표기한 뒤 변환한다: head = 기울기 - 1.2 × 기둥 */
const videoKeys = (rows) => sequenceNeck(rows.map(([t, col, tilt]) => [t, col, Math.max(-48, Math.min(8, tilt - 1.2 * col))]));

/* 시나리오2 간지럽히기: 사용자가 정한 6단계 동작을 0.1초 간격으로 구운 클립. 키: [t, 기둥, 머리, 갸웃(좌우 기울임), 몸통]
   기둥·머리는 "기둥 높이 / 머리 기울기(수평 기준)"로 먼저 곡선을 만들고, 그 위에 단계별 동작을 얹는다. */
const TICKLE_BASE = [
  [0, 0, 0], [0.4, 0, 0], [2, 35, 0], [4, 35, 0], [5, 33, 0], [8, 33, 0], [9, 27, 0], [14, 27, 0], [15, 28, 0], [22, 28, 0],
  [24, 4, -35], [36, 4, -35], [38, 4, -25], [39.5, 22, 0], [41, 22, 0], [49.2, 22, 0],
];
const TICKLE_SECTIONS = [
  [0, 4, '01 사용자 인식 · 기둥 최대로'], [4, 8, '02 헤드 좌우 5° · 접촉 유도'], [8, 14, '03 간지럼 · 목 돌리기 2바퀴 · 기둥 앞뒤'],
  [14, 22, '04 손 떼면 · 바디 좌우 흔들기'], [22, 39, '05 뒤로 최대한 젖히기 · 헤드 앞뒤'], [39, 49.2, '06 제자리 · 헤드 끄덕'],
];
function tickleMergedSteps() {
  const base = springFollow(pchipResample(videoKeys(TICKLE_BASE)));   // 0.1초 격자, 속도가 이어지는 곡선 → 스프링으로 따라가기
  const wave = (t, a, period) => Math.sin((2 * Math.PI * (t - a)) / period);
  const env = (t, a, b, r = 0.5) => { const x = Math.max(0, Math.min(1, (t - a) / r, (b - t) / r)); return x * x * (3 - 2 * x); };   // 양 끝을 부드럽게(속도가 이어지게) 줄이는 포락선
  const keys = [];
  const N = Math.round(49.2 * 10);
  for (let i = 0; i <= N; i++) {
    const t = +(i / 10).toFixed(3);
    let [col, head] = base[i].slice(1, 3), sw = 0, body = 0;
    sw += 5 * wave(t, 4, 1.0) * env(t, 4.2, 7.8);                                   // 02 헤드 좌우 5°
    { const phi = (2 * Math.PI * (t - 8.8)) / 1.7, e = env(t, 8.8, 12.2);             // 03 목 돌리기 2바퀴: 앞→옆→뒤→옆 (앞뒤 끄덕임 + 좌우 갸웃을 90° 어긋나게)
      head += 10 * Math.cos(phi) * e; sw += 15 * Math.sin(phi) * e; }
    col += 6 * wave(t, 8.5, 0.85) * env(t, 8.5, 12.8);                               // 03 기둥 앞뒤
    body += 12 * wave(t, 14.4, 1.4) * env(t, 14.4, 21.6, 0.7);                       // 04 바디 전체 좌우
    head += 3.5 * wave(t, 24.5, 0.5) * env(t, 24.5, 37, 1.0);                        // 05 헤드만 앞뒤 (웃음: 폭 3.5°, 0.5초 주기)
    head += 9 * wave(t, 40.5, 0.9) * env(t, 40.5, 48.5);                             // 06 헤드 끄덕
    keys.push([t, col, Math.max(-50, Math.min(8, head)), sw, body]);
  }
  return TICKLE_SECTIONS.map(([a, b, name]) => ({
    name, duration: +(b - a).toFixed(3),
    keys: keys.filter(([t]) => t >= a - 1e-6 && t <= b + 1e-6).map(([t, ...r]) => [+(t - a).toFixed(3), ...r]),
  }));
}

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
  const base = springFollow(pchipResample(videoKeys(SNACK_VIDEO)));   // 0.1초 격자, 속도가 이어지는 곡선 → 스프링으로 따라가기
  const bell = (t, a, b) => (t <= a || t >= b ? 0 : Math.sin((Math.PI * (t - a)) / (b - a)));
  const wave = (t, a, period) => Math.sin((2 * Math.PI * (t - a)) / period);
  const keys = [];
  const N = Math.round(35.2 * 10);
  for (let i = 0; i <= N; i++) {
    const t = +(i / 10).toFixed(3);
    let [col, head] = base[i].slice(1, 3), sw = 0, body = 0;
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

/* ───── 눈 연기 (8×8 도트): [시간, 표정, 시선 가로(칸), 시선 세로(칸)] — 표정은 키마다 통째로 바뀌고, 시선은 칸 단위로만 움직인다 ───── */
const gazeSweep = (a, b, step, amp, name = '뜬 눈') => { const o = []; let s = 1, t = a; while (t < b - 1e-6) { o.push([+t.toFixed(2), name, s * amp, 0]); s = -s; t += step; } o.push([b, name, 0, 0]); return o; };
const EYES_REST = [
  [0, '졸린 눈'], [1.2, '뜬 눈'], [2.5, '반짝 눈'],   // 01 사용자 인식: 눈을 뜨고 반가워함
  [3.2, '웃는 눈'],                                  // 02 휴식 유도: 쓰다듬에 좋아함
  [6, '뜬 눈', 1, 0], [7.5, '뜬 눈', 0, 0],           // 03 몸 올리기: 팔을 보며 시선을 살짝 옮김
  [9.5, '편안한 눈'],                                // 04 기대기: 느긋한 눈
  [13, '뜬 눈'], [15, '졸린 눈'], [16, '감은 눈'],     // 05 휴식 유지: 깜빡이다가 감음
  [18.2, '졸린 눈'], [19.2, '뜬 눈'], [20.4, '웃는 눈'], // 06 휴식 종료: 눈을 뜨고 웃으며 배웅
];
const EYES_TICKLE = [
  [0, '졸린 눈'], [1.2, '뜬 눈'], [2.6, '반짝 눈'],   // 01 사용자 인식
  ...gazeSweep(4.2, 7.8, 0.6, 1),                    // 02 헤드 좌우 5° 와 같이 시선도 좌우 한 칸씩
  [8, '신난 눈'], [10.5, '웃는 눈'], [12.5, '신난 눈'], // 03 간지럼: > < 와 ^^ 를 오가며 간지러워함
  ...gazeSweep(14.4, 21.6, 0.7, 1, '슬픈 눈'),         // 04 손 떼면: 더 놀아달라고 조르는 처진 눈, 시선이 좌우로
  [22, '반짝 눈'], [22.8, '웃는 눈'],                 // 05 뒤로 젖혀 웃음
  [30, '신난 눈'], [32, '웃는 눈'], [36, '신난 눈'], [38, '웃는 눈'],
  [39.3, '뜬 눈'], [41, '윙크'], [43, '하트 눈'], [47.2, '뜬 눈'], // 06 제자리: 윙크, 하트, 다시 눈 뜸
];
const EYES_SNACK = [
  [0, '졸린 눈'], [1.2, '뜬 눈'],                    // 01 사용자 바라보기
  ...gazeSweep(4, 7.5, 1.5, 2),                      // 02 헤드 좌우 탐색
  [9, '놀란 눈'], [11.5, '반짝 눈'],                  // 03 이건 뭐지: 놀람 → 궁금해서 반짝
  [20, '웃는 눈'],                                   // 05 씹기
  [25, '하트 눈'], [29.5, '신난 눈'], [31, '웃는 눈'], [32.8, '윙크'], [34, '뜬 눈'], // 06~07 만족: 하트, > <, 윙크
];

const SCENARIOS = [
  { name: '시나리오1 휴식', eyes: EYES_REST, natural: true, steps: [
    { name: '01 사용자 인식', duration: 3, keys: WAKE },
    { name: '02 휴식 유도', duration: 3, keys: [k(0, 25, -34), k(0.75, 25, -34, 0, 5), k(1.5, 25, -34, 0, -5), k(2.25, 25, -34, 0, 5), k(3, 25, -34)] },
    { name: '03 몸 올리기', duration: 3, keys: [k(0, 25, -34), k(1, 28, -22), k(1.5, 28, -27), k(2, 28, -22), k(2.5, 28, -27), k(3, 28, -22)] },
    { name: '04 기대기', duration: 4, keys: [k(0, 28, -22), k(1.5, 32, -10), k(4, 32, -10)] },
    { name: '05 휴식 유지', duration: 5, keys: [k(0, 32, -10), k(1.5, 31, -8), k(3, 32, -10), k(4, 31, -8), k(5, 30, -8)] },
    { name: '06 휴식 종료', duration: 4, keys: [k(0, 30, -8), k(1.5, 25, -34), k(2.2, 25, -34, 10), k(3, 25, -34, -10), k(4, 25, -34)] },
  ] },
  { name: '시나리오2 간지럽히기', interp: 'linear', eyes: EYES_TICKLE, steps: tickleMergedSteps() },
  { name: '시나리오3 간식주기', interp: 'linear', eyes: EYES_SNACK, steps: snackMergedSteps() },
];

const whole = SCENARIOS.map((s) => {
  let t0 = 0; const keys = [], markers = [];
  s.steps.forEach((st, i) => {
    markers.push({ t: t0, label: st.name });
    st.keys.forEach((kk, j) => { if (i > 0 && j === 0) return; keys.push([kk[0] + t0, ...kk.slice(1)]); });
    t0 += st.duration;
  });
  return { name: s.name, duration: t0, keys, markers, interp: s.interp, eyes: s.eyes, natural: s.natural };
});


/* 반복 재생할 때 끝 자세에서 처음(접힌) 자세로 튀지 않도록, 끝에 "제자리로" 구간을 붙여 처음 자세로 부드럽게 돌아온다. */
const TAIL = 1.8;
function withTail(d) {
  const first = d.keys[0], last = d.keys[d.keys.length - 1];
  if ([1, 2, 3, 4].every((c) => Math.abs((last[c] ?? 0) - (first[c] ?? 0)) < 0.5)) return d;
  const end = last[0];
  return {
    ...d,
    duration: +(d.duration + TAIL).toFixed(3),
    keys: [...d.keys, [+(end + TAIL).toFixed(3), first[1], first[2], first[3] ?? 0, first[4] ?? 0]],
    markers: d.markers ? [...d.markers, { t: end, label: '마무리 · 제자리로' }] : d.markers,
    eyes: d.eyes ? [...d.eyes, [+(end + 0.9).toFixed(2), '졸린 눈']] : d.eyes,
  };
}
const seq = (items) => items.map((d) => {
  const t = withTail(d);
  let keys = pchipResample(sequenceNeck(t.keys));
  if (t.natural) keys = springFollow(keys);          // 밑그림만 있는 시나리오는 전체에 스프링 (흔들림 덧씌움이 따로 없는 경우)
  return { ...t, keys: microSway(keys) };
});

export const PRESET_GROUPS = [
  { label: '시나리오', items: seq(whole) },
];
