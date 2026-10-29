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
  [24, 4, -36.2], [36, 4, -36.2], [38, 4, -25], [39.5, 22, 0], [41, 22, 0], [49.2, 22, 0],
];
const TICKLE_SECTIONS = [
  [0, 4, '누가 왔어요! 반가워요'], [4, 8, '만져 달라고 몸을 흔들어요'], [8, 14, '간지러워요!'],
  [14, 22, '더 놀고 싶어요'], [22, 39, '너무 웃겨서 뒤로 넘어가요'], [39, 49.2, '기분이 정말 좋아요'],
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
    body += 12 * wave(t, 5, 1.4) * env(t, 5, 7, 0.3);                               // 02 몸통 좌우 2초간 (5~7초, 폭 12°·1.4초 주기: 몸통은 가속 한계가 낮아 이보다 빠르면 폭이 줄어든다)
    { const phi = (2 * Math.PI * (t - 8.8)) / 1.7, e = env(t, 8.8, 12.2);             // 03 목 돌리기 2바퀴: 앞→옆→뒤→옆 (앞뒤 끄덕임 + 좌우 갸웃을 90° 어긋나게)
      head += 10 * Math.cos(phi) * e; sw += 15 * Math.sin(phi) * e; }
    col += 6 * wave(t, 8.5, 0.85) * env(t, 8.5, 12.8);                               // 03 기둥 앞뒤
    body += 12 * wave(t, 14.4, 1.4) * env(t, 14.4, 21.6, 0.7);                       // 04 바디 전체 좌우
    head += 5 * wave(t, 24.5, 0.4) * env(t, 24.5, 37, 1.0);                          // 05 헤드만 앞뒤 (웃음: 폭 5°, 0.4초 주기 — 예전 3.5°·0.5초. 더 빠르게 하면 로봇 가속 한계 때문에 실제 움직임 폭이 줄어든다)
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
const SNACK_SECTIONS = [[0, 3, '누가 왔는지 살펴봐요'], [3, 9, '냄새가 나는 것 같아요'], [9, 14, '이게 뭘까요?'], [14, 20, '먹고 싶어요!'], [20, 25, '냠냠 맛있어요'], [25, 27, '배가 불러요'], [27, 35.2, '행복해요!']];
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

/* ───── 눈 연기 (8×8 도트): [시간, 표정] — 한 동작(장면)마다 표정 2가지. 표정은 키마다 통째로 바뀐다 ───── */
const EYES_REST = [
  [0, '졸린 눈'], [1.2, '뜬 눈'],          // 01 사용자 인식
  [3, '반짝 눈'], [4.2, '신난 눈'],         // 02 휴식 유도
  [9, '뜬 눈'], [10.5, '반짝 눈'],          // 03 몸 올리기 (02 쓰다듬기 반응이 6초로 길어져 3초씩 뒤로)
  [12, '뜬 눈'], [14, '편안한 눈'],         // 04 기대기
  [16, '졸린 눈'], [18.5, '감은 눈'],       // 05 휴식 유지 (4초 길어져 이후는 4초씩 뒤로)
  [25, '뜬 눈'], [27, '신난 눈'], [28.2, '뜬 눈'],   // 06 휴식 종료 (끝까지 서서 뜬 눈으로 마무리)
];
const EYES_TICKLE = [
  [0, '졸린 눈'], [1.2, '뜬 눈'],          // 01 사용자 인식 · 기둥 최대로
  [4, '뜬 눈'], [6, '반짝 눈'],            // 02 헤드 좌우 · 접촉 유도
  [8, '신난 눈'], [11, '신난 눈'],          // 03 간지럼
  [14, '눈물 눈'], [18, '눈물 눈'],         // 04 손 떼면 · 더 놀아달라고
  [22, '신난 눈'], [30, '신난 눈'],         // 05 뒤로 젖히며 웃음
  [39, '뜬 눈'], [43, '하트 눈'],         // 06 제자리 · 끄덕
];
const EYES_SNACK = [
  [0, '졸린 눈'], [1.2, '뜬 눈'],          // 01 사용자 바라보기 · 기둥 올리기
  [3, '뜬 눈'], [6, '반짝 눈'],            // 02 헤드 좌우 탐색
  [9, '놀란 눈'], [11.5, '반짝 눈'],        // 03 까딱까딱 · 이건 뭐지
  [14, '반짝 눈'], [17, '별 눈'],          // 04 고개 · 허리 최대로
  [20, '편안한 눈'], [22.5, '신난 눈'],     // 05 씹기
  [25, '하트 눈'], [26, '신난 눈'],         // 06 만족
  [27, '신난 눈'], [31.5, '윙크'],          // 07 기분 좋은 까딱
];


/* ───── 새 시나리오용: 장면마다 표정 2가지를 자동 배치 (장면 시작 / 장면 중간) ───── */
function autoEyes(durations, pairs) {
  const o = []; let t = 0;
  durations.forEach((d, i) => { o.push([+t.toFixed(2), pairs[i][0]], [+(t + d * 0.5).toFixed(2), pairs[i][1]]); t += d; });
  return o;
}

const SCENARIOS = [
  { name: '시나리오1 휴식', rev: 9, eyes: EYES_REST, natural: true, noTail: true, hold: [{ at: 1, label: '반응하기', touch: true, msg: '쓰다듬어 줄 때까지 기다리고 있어요. 터치센서에 닿으면 자동으로 넘어가요. (아니면 눌러 주세요)' }, { at: 3, label: '숙이기', msg: '머리를 숙이기 직전에 멈춰 있어요. 준비되면 눌러 주세요.' }], steps: [   // 2번째 장면 앞(쓰다듬기 전)과 4번째 장면 앞(머리를 숙이기 전)에서 멈추고, 버튼을 눌러야 이어진다
    { name: '누가 다가왔어요', duration: 3, keys: WAKE },
    { name: '쓰다듬어 줘서 좋아요', duration: 6, keys: [k(0, 25, -34), k(0.75, 25, -34, 0, 6), k(1.5, 25, -34, 0, -6), k(2.25, 25, -34, 0, 6), k(3, 25, -34, 0, -6), k(3.75, 25, -34, 0, 6), k(4.5, 25, -34, 0, -6), k(5.25, 25, -34, 0, 4), k(6, 25, -34)] },   // 신나서 고개를 좌우로 흔드는 반응 (예전 3초 → 6초)
    { name: '팔을 올려 주길 기다려요', duration: 3, keys: [k(0, 25, -34), k(1, 28, -22), k(1.5, 28, -27), k(2, 28, -22), k(2.5, 28, -27), k(3, 28, -22)] },
    { name: '기대니까 편안해요', duration: 4, keys: [k(0, 28, -22), k(1.3, 30, -17, 8), k(2.1, 30.5, -15, 8), k(3.3, 32, -10), k(4, 32, -10)] },   // 처음엔 몸통은 고정한 채 헤드를 정면에서 보이는 왼쪽으로 갸웃(+8°, 로봇 한계 안)하며 대각선으로 숙이다가, 바로 세우며 완전히 기댄다
    { name: '스르르 잠이 와요', duration: 9, keys: [k(0, 32, -10), k(1.5, 31, -8), k(3, 32, -10), k(4.5, 31, -8), k(6, 32, -10), k(7.5, 31, -8), k(9, 30, -8)] },   // 손에 기대서 쉬는 시간 (예전 5초 → 9초)
    { name: '잘 쉬었어요', duration: 4, keys: [k(0, 30, -8), k(1.5, 25, -34), k(2.2, 25, -34, 10), k(3, 25, -34, -10), k(4, 25, -34)] },
  ] },
  { name: '시나리오2 간지럽히기', rev: 4, interp: 'linear', eyes: EYES_TICKLE, tailLabel: '이제 쉬어요', hold: [{ at: 2, label: '간지럽히기', msg: '간지럽혀 주길 기다리고 있어요. 준비되면 눌러 주세요.' }, { at: 3, label: '손 떼기', msg: '간지럽히다가 손을 떼는 순간에 멈춰 있어요. 더 놀고 싶어 하기 전에 준비되면 눌러 주세요.' }, { at: 4, label: '뒤로 넘어가기', msg: '너무 웃겨서 뒤로 넘어가기 직전에 멈춰 있어요. 준비되면 눌러 주세요.' }], steps: tickleMergedSteps() },   // 3번째 장면(간지러워요!) 앞에서 멈추고, 버튼을 누르면 간지럽다는 듯 움직인다
  { name: '시나리오3 간식주기', interp: 'linear', eyes: EYES_SNACK, tailLabel: '졸려요', steps: snackMergedSteps() },
  { name: '시나리오4 인사', eyes: autoEyes([3, 3, 4, 4, 4], [['졸린 눈', '뜬 눈'], ['반짝 눈', '뜬 눈'], ['신난 눈', '윙크'], ['신난 눈', '신난 눈'], ['뜬 눈', '반짝 눈']]), natural: true, tailLabel: '다시 쉬어요', steps: [
    { name: '누가 지나가요', duration: 3, keys: WAKE },
    { name: '반가워서 고개를 들어요', duration: 3, keys: [k(0, 25, -34), k(1.2, 33, -42), k(3, 33, -42)] },
    { name: '안녕! 인사해요', duration: 4, keys: [k(0, 33, -42), k(0.8, 31, -30), k(1.6, 33, -42), k(2.4, 31, -30), k(3.2, 33, -42), k(4, 33, -42)] },
    { name: '같이 놀자고 몸을 흔들어요', duration: 4, keys: [k(0, 33, -42), k(1, 33, -42, 10, 10), k(2, 33, -42, -10, -10), k(3, 33, -42, 10, 10), k(4, 33, -42)] },
    { name: '손 흔들어 주길 기다려요', duration: 4, keys: [k(0, 33, -42), k(1, 30, -36, 20, 0), k(2.5, 30, -36, 20, 0), k(4, 28, -34)] },
  ] },
  { name: '시나리오5 칭찬받기', eyes: autoEyes([3, 4, 4, 4, 4], [['졸린 눈', '뜬 눈'], ['편안한 눈', '감은 눈'], ['신난 눈', '점 눈'], ['신난 눈', '별 눈'], ['하트 눈', '신난 눈']]), natural: true, noSeq: true, tailLabel: '뿌듯하게 쉬어요', steps: [
    { name: '누가 다가와요', duration: 3, keys: WAKE },
    { name: '머리를 쓰다듬어 줘요', duration: 4, keys: [k(0, 25, -34), k(1.2, 27, -24), k(2.4, 27, -22, 0, 4), k(3.2, 27, -22, 0, -4), k(4, 27, -22)] },
    { name: '칭찬해 줘서 부끄러워요', duration: 4, keys: [k(0, 27, -22), k(1.2, 22, -12, -20, 0), k(2.8, 22, -12, -20, 0), k(4, 24, -18)] },
    { name: '기뻐서 폴짝 뛰고 싶어요', duration: 4, keys: [k(0, 24, -18), k(0.5, 31, -32), k(1, 22, -18), k(1.5, 31, -32), k(2, 22, -18), k(2.5, 31, -32), k(3.2, 27, -28), k(4, 27, -28)] },
    { name: '고마워요!', duration: 4, keys: [k(0, 27, -28), k(1.2, 26, -14), k(2.2, 26, -14), k(3.2, 28, -34), k(4, 28, -34)] },
  ] },
  { name: '시나리오6 깜짝 놀람', eyes: autoEyes([4, 3, 5, 4, 4], [['감은 눈', '졸린 눈'], ['놀란 눈', '반짝 눈'], ['뜬 눈', '점 눈'], ['편안한 눈', '졸린 눈'], ['졸린 눈', '감은 눈']]), natural: true, noSeq: true, steps: [
    { name: '쿨쿨 자고 있어요', duration: 4, keys: [k(0, 4, -5), k(2, 5, -6), k(4, 4, -5)] },
    { name: '쿵! 큰 소리에 깜짝!', duration: 3, keys: [k(0, 4, -5), k(0.5, 33, -42), k(3, 33, -42)] },
    { name: '무슨 일인지 두리번거려요', duration: 5, keys: [k(0, 33, -42), k(1, 33, -42, 22, -8), k(2.5, 33, -42, -22, 8), k(4, 33, -42, 18, -6), k(5, 31, -38)] },
    { name: '아무것도 아니구나, 안심해요', duration: 4, keys: [k(0, 31, -38), k(1.5, 24, -28), k(4, 22, -24)] },
    { name: '다시 스르르 졸려요', duration: 4, keys: [k(0, 22, -24), k(2, 10, -12), k(4, 4, -5)] },
  ] },
  { name: '시나리오7 두리번 탐색', eyes: autoEyes([3, 3, 4, 4, 4], [['졸린 눈', '뜬 눈'], ['뜬 눈', '반짝 눈'], ['반짝 눈', '뜬 눈'], ['놀란 눈', '신난 눈'], ['신난 눈', '하트 눈']]), natural: true, tailLabel: '다시 쉬어요', steps: [
    { name: '누가 부르는 것 같아요', duration: 3, keys: WAKE },
    { name: '소리 나는 쪽을 봐요', duration: 3, keys: [k(0, 25, -34), k(1, 28, -34, 16, -12), k(3, 28, -34, 16, -12)] },
    { name: '반대쪽도 살펴봐요', duration: 4, keys: [k(0, 28, -34, 16, -12), k(2, 28, -34, -16, 12), k(4, 28, -34, -16, 12)] },
    { name: '찾았다! 기뻐요', duration: 4, keys: [k(0, 28, -34, -16, 12), k(0.8, 32, -40), k(1.6, 30, -30, 12), k(2.4, 32, -40, -12), k(3.2, 30, -30, 10), k(4, 32, -40)] },
    { name: '같이 놀아요', duration: 4, keys: [k(0, 32, -40), k(1, 30, -36, 0, 10), k(2, 30, -36, 0, -10), k(3, 30, -36, 0, 10), k(4, 30, -36)] },
  ] },
  { name: '시나리오8 작별 인사', eyes: autoEyes([3, 4, 4, 5, 4], [['뜬 눈', '점 눈'], ['눈물 눈', '눈물 눈'], ['뜬 눈', '반짝 눈'], ['신난 눈', '윙크'], ['하트 눈', '별 눈']]), natural: true, tailLabel: '또 올 거예요', steps: [
    { name: '이제 가야 한다고 해요', duration: 3, keys: WAKE },
    { name: '아쉬워서 시무룩해요', duration: 4, keys: [k(0, 25, -34), k(1.5, 20, -20), k(4, 19, -18)] },
    { name: '다시 온다는 말에 힘이 나요', duration: 4, keys: [k(0, 19, -18), k(2, 30, -36), k(4, 30, -36)] },
    { name: '손 흔들며 인사해요', duration: 5, keys: [k(0, 30, -36), k(0.8, 30, -36, 20, 8), k(1.8, 30, -36, -20, -8), k(2.8, 30, -36, 20, 8), k(3.8, 30, -36, -20, -8), k(5, 30, -36)] },
    { name: '또 만나요!', duration: 4, keys: [k(0, 30, -36), k(1.2, 26, -14), k(2.2, 26, -14), k(3.2, 29, -35), k(4, 29, -35)] },
  ] },
];

const whole = SCENARIOS.map((s) => {
  let t0 = 0; const keys = [], markers = [];
  s.steps.forEach((st, i) => {
    markers.push({ t: t0, label: st.name });
    st.keys.forEach((kk, j) => { if (i > 0 && j === 0) return; keys.push([kk[0] + t0, ...kk.slice(1)]); });
    t0 += st.duration;
  });
  return { name: s.name, duration: t0, keys, markers, interp: s.interp, eyes: s.eyes, natural: s.natural, noSeq: s.noSeq, tailLabel: s.tailLabel, noTail: s.noTail, hold: s.hold, rev: s.rev };
});


/* 반복 재생할 때 끝 자세에서 처음(접힌) 자세로 튀지 않도록, 끝에 "제자리로" 구간을 붙여 처음 자세로 부드럽게 돌아온다. */
const TAIL = 1.8;
function withTail(d) {
  if (d.noTail) return d;                              // 끝 자세에서 접지 않고 그대로 서 있는다 (휴식)
  const first = d.keys[0], last = d.keys[d.keys.length - 1];
  if ([1, 2, 3, 4].every((c) => Math.abs((last[c] ?? 0) - (first[c] ?? 0)) < 0.5)) return d;
  const end = last[0];
  return {
    ...d,
    duration: +(d.duration + TAIL).toFixed(3),
    keys: [...d.keys, [+(end + TAIL).toFixed(3), first[1], first[2], first[3] ?? 0, first[4] ?? 0]],
    markers: d.markers ? [...d.markers, { t: end, label: d.tailLabel || '다시 쉬어요' }] : d.markers,
    eyes: d.eyes ? [...d.eyes, [+(end + 0.9).toFixed(2), '졸린 눈']] : d.eyes,
  };
}
/* ───── 표정 모음: 시나리오와 별개로 표정만 하나씩 볼 수 있는 클립 (장면 하나 = 표정 하나) ───── */
const EXPR_MOOD = { '뜬 눈': '말똥말똥', '웃는 눈': '기분 좋아요', '반짝 눈': '궁금해요', '별 눈': '우와, 대단해요!', '하트 눈': '너무 좋아요',
  '윙크': '찡긋~', '신난 눈': '신나요!', '놀란 눈': '깜짝 놀랐어요', '편안한 눈': '느긋해요', '졸린 눈': '졸려요', '감은 눈': '쌔근쌔근 자요', '점 눈': '멍~ 하고 있어요', '슬픈 눈': '시무룩해요', '눈물 눈': '훌쩍훌쩍' };
function expressionClip() {
  const names = Object.keys(EXPR_MOOD), T = 2.4, pose = [28, -33.6];            // 눈이 잘 보이도록 헤드를 수평으로 세운 자세
  return {
    name: '표정 모음', rev: 2, group: '표정', duration: +(names.length * T).toFixed(2), interp: 'linear',
    keys: [[0, pose[0], pose[1], 0, 0], [+(names.length * T / 2).toFixed(2), pose[0], pose[1], 0, 0], [+(names.length * T).toFixed(2), pose[0], pose[1], 0, 0]],
    markers: names.map((n, i) => ({ t: +(i * T).toFixed(2), label: n, desc: EXPR_MOOD[n] })),
    eyes: names.map((n, i) => [+(i * T).toFixed(2), n]),
  };
}
whole.push(expressionClip());

const seq = (items) => items.map((d) => {
  const t = withTail(d);
  let keys = pchipResample(t.noSeq ? t.keys : sequenceNeck(t.keys));
  if (t.natural) keys = springFollow(keys);          // 밑그림만 있는 시나리오는 전체에 스프링 (흔들림 덧씌움이 따로 없는 경우)
  return { ...t, keys: microSway(keys) };
});

export const PRESET_GROUPS = [
  { label: '시나리오', items: seq(whole) },
];
