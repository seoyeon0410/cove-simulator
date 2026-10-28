// 로봇 눈(8칸 × 위 4줄)용 표정 비트맵. 웹의 8×8 표정 16종을 4줄 안에서 다시 그렸다.
// 웹 8×8 눈에서 쓰던 가운데 줄(3행 근처)이 4줄에서는 1~2행이 되도록 위쪽으로 올려서 그렸다.
// 문자열은 위→아래 4줄, 한 줄 8글자('1' = 켜짐). 아래 값은 "웹 화면에서 보는 사람 기준"(왼쪽 눈 L · 오른쪽 눈 R)이고,
// 내보낼 때 로봇 기준(맨 왼쪽 글자 = 로봇의 왼쪽 칸, left = 로봇의 왼쪽 눈)으로 좌우를 뒤집어서 담는다.
const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));
const OVAL = ['00011000', '00111100', '00111100', '00011000'];
const HAPPY = ['00111100', '01100110', '01000010', '00000000'];                 // 6칸 폭, 윗부분만 두 칸 굵기 (끝은 한 칸이라 튀어나와 보이지 않게)
const SAD_L = ['00000011', '00001110', '00111100', '01110000'];
const CHEVRON = ['01100000', '00011000', '00011000', '01100000'];
const hole = (rows, pts) => rows.map((r, y) => [...r].map((v, x) => (pts.some(([py, px]) => py === y && px === x) ? '0' : v)).join(''));
const STAR = ['00011000', '01111110', '00111100', '01100110'];
const STAR_SM = ['00000000', '00011000', '00111100', '00011000'];
const TEAR_EYE = ['00011000', '00111100', '00011000', '00000000'];
const drop = (rows, x) => rows.map((r, y) => (y === 3 ? [...r].map((v, j) => (j === x ? '1' : v)).join('') : r));

// 값: rows(두 눈 같음) | {L, R} | {frames:[rows | {L,R}], ms, loop}
export const EYES4 = {
  '뜬 눈': OVAL,
  '감은 눈': ['00000000', '00000000', '01000010', '00111100'],
  '웃는 눈': HAPPY,
  '졸린 눈': ['00000000', '00111100', '00111100', '00011000'],
  '놀란 눈': ['00111100', '01100110', '01100110', '00111100'],
  '하트 눈': ['00100100', '00111100', '00011000', '00000000'],        // 가운데 4칸에 작게 (너무 크면 가장자리에서 깨져 보임)
  '반짝 눈': { frames: [hole(OVAL, [[1, 3]]), hole(OVAL, [[1, 3], [2, 2]]), hole(OVAL, [[1, 3]]), OVAL], ms: 300 },
  '슬픈 눈': { L: SAD_L, R: mirror(SAD_L) },
  '신난 눈': { L: CHEVRON, R: mirror(CHEVRON) },
  '윙크': { L: OVAL, R: HAPPY },
  '편안한 눈': ['00000110', '00001100', '00011000', '00110000'],
  '별 눈': { frames: [STAR, STAR, STAR_SM], ms: 300 },
  '초롱 눈': ['00111100', '01001110', '01111110', '00111100'],
  '눈물 눈': { frames: [{ L: drop(TEAR_EYE, 2), R: drop(TEAR_EYE, 5) }, { L: drop(TEAR_EYE, 2), R: drop(TEAR_EYE, 5) }, { L: TEAR_EYE, R: TEAR_EYE }, { L: TEAR_EYE, R: TEAR_EYE }], ms: 400 },
  '점 눈': ['00000000', '00011000', '00011000', '00000000'],
  '또렷한 눈': ['00111100', '01000010', '01011010', '00111100'],
};
// 뜬 눈의 깜빡임: 3.8초마다, 60ms 간격 4프레임(반쯤 → 감김 → 감김 → 반쯤) 뒤 뜬 눈으로 복귀
const BLINK = [['00000000', '00011000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00011000', '00111100', '00000000']];

const pair = (d) => (Array.isArray(d) ? { L: d, R: d } : { L: d.L, R: d.R });
// 웹(보는 사람 기준) → 로봇 기준: 로봇의 왼쪽 눈 = 보는 사람 기준 오른쪽 눈, 글자 순서도 좌우 반전
const toRobot = (d) => { const { L, R } = pair(d); return { left: mirror(R), right: mirror(L) }; };

// 두 눈 사이를 최대한 벌린다: 로봇의 왼쪽 눈은 왼쪽(바깥)으로, 오른쪽 눈은 오른쪽(바깥)으로 밀어서
// 켜진 점이 바깥 가장자리에서 OUTER_MARGIN 칸 떨어진 곳까지 가게 한다. (표정마다 그 표정에서 밀 수 있는 만큼)
// 가장자리 칸이 가려져 잘려 보이면 OUTER_MARGIN 을 1로 올리면 된다.
const OUTER_MARGIN = 0;
const gapOf = (rows, side) => rows.reduce((g, r) => (r.includes('1') ? Math.min(g, side === 'left' ? r.indexOf('1') : 7 - r.lastIndexOf('1')) : g), 8);
const shiftOut = (rows, side, k) => (!k ? rows : rows.map((r) => (side === 'left' ? r.slice(k) + '0'.repeat(k) : '0'.repeat(k) + r.slice(0, 8 - k))));
const spreadFor = (frames) => ({                                // frames: [{left, right}] → 쪽마다 밀 칸 수
  left: Math.max(0, Math.min(...frames.map((f) => gapOf(f.left, 'left'))) - OUTER_MARGIN) % 8,
  right: Math.max(0, Math.min(...frames.map((f) => gapOf(f.right, 'right'))) - OUTER_MARGIN) % 8,
});
const spreadFrame = (f, k) => ({ ...f, left: shiftOut(f.left, 'left', k.left), right: shiftOut(f.right, 'right', k.right) });

export function eyesJson(sceneEyes) {                          // sceneEyes: { 씬이름: [{t, e, gx}] }
  const eyes = {};
  for (const [name, d] of Object.entries(EYES4)) {
    if (d.frames) {
      const fr = d.frames.map(toRobot), k = spreadFor(fr);
      eyes[name] = { frames: fr.map((f) => ({ ...spreadFrame(f, k), ms: d.ms })), loop: true };
    } else eyes[name] = spreadFrame(toRobot(d), spreadFor([toRobot(d)]));
  }
  const kOpen = spreadFor([toRobot(EYES4['뜬 눈'])]);            // 깜빡임은 뜬 눈과 같은 만큼 밀어서 눈 위치가 흔들리지 않게
  const blink = { for: '뜬 눈', period_s: 3.8, first_s: 1.6, frames: BLINK.map((f) => ({ ...spreadFrame(toRobot(f), kOpen), ms: 60 })) };
  const scenes = {};
  // 눈을 한쪽씩 따로 고른 곳은 left / right 에 로봇 기준 표정 이름을 적는다 (웹의 왼쪽 눈 = 로봇의 오른쪽 눈).
  for (const [scene, list] of Object.entries(sceneEyes)) scenes[scene] = list.map((x) => {
    const o = { t: x.t, expr: x.e };
    if (x.gx) o.gx = x.gx;
    if (x.eL || x.eR) { o.left = x.eR || x.e; o.right = x.eL || x.e; }
    return o;
  });
  return { version: 1, rows: 4, cols: 8, orientation: '로봇 기준 (left = 로봇의 왼쪽 눈 0x70, 맨 왼쪽 글자 = 로봇의 왼쪽 칸)', eyes, blink, scenes };
}
