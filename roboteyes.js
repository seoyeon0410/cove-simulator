// 로봇 눈(8칸 × 위 4줄)용 표정 비트맵. 웹의 8×8 표정 16종을 4줄 안에서 다시 그렸다.
// 웹 8×8 눈에서 쓰던 가운데 줄(3행 근처)이 4줄에서는 1~2행이 되도록 위쪽으로 올려서 그렸다.
// 문자열은 위→아래 4줄, 한 줄 8글자('1' = 켜짐). 아래 값은 "웹 화면에서 보는 사람 기준"(왼쪽 눈 L · 오른쪽 눈 R)이고,
// 내보낼 때 로봇 기준(맨 왼쪽 글자 = 로봇의 왼쪽 칸, left = 로봇의 왼쪽 눈)으로 좌우를 뒤집어서 담는다.
const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));
const OVAL = ['00011000', '00111100', '00111100', '00011000'];
const HAPPY = ['00011000', '00100100', '01000010', '00000000'];
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
  '하트 눈': ['01100110', '01111110', '00111100', '00011000'],
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
  '가로 눈': ['00000000', '01111110', '11111111', '01111110'],
  '일자 눈': ['00000000', '01111110', '01111110', '00000000'],
  '반달 눈': ['00000000', '11111111', '01111110', '00111100'],
  '가로 웃는 눈': ['00111100', '01000010', '10000001', '00000000'],
};
// 뜬 눈의 깜빡임: 3.8초마다, 60ms 간격 4프레임(반쯤 → 감김 → 감김 → 반쯤) 뒤 뜬 눈으로 복귀
const BLINK = [['00000000', '00011000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00011000', '00111100', '00000000']];

const pair = (d) => (Array.isArray(d) ? { L: d, R: d } : { L: d.L, R: d.R });
// 웹(보는 사람 기준) → 로봇 기준: 로봇의 왼쪽 눈 = 보는 사람 기준 오른쪽 눈, 글자 순서도 좌우 반전
const toRobot = (d) => { const { L, R } = pair(d); return { left: mirror(R), right: mirror(L) }; };

export function eyesJson(sceneEyes) {                          // sceneEyes: { 씬이름: [{t, e, gx}] }
  const eyes = {};
  for (const [name, d] of Object.entries(EYES4)) {
    if (d.frames) eyes[name] = { frames: d.frames.map((f) => ({ ...toRobot(f), ms: d.ms })), loop: true };
    else eyes[name] = toRobot(d);
  }
  const blink = { for: '뜬 눈', period_s: 3.8, first_s: 1.6, frames: BLINK.map((f) => ({ ...toRobot(f), ms: 60 })) };
  const scenes = {};
  // 눈을 한쪽씩 따로 고른 곳은 left / right 에 로봇 기준 표정 이름을 적는다 (웹의 왼쪽 눈 = 로봇의 오른쪽 눈).
  // 그 눈에는 eyes[이름].solo 를 쓴다 (없으면 그 눈 쪽 비트맵 eyes[이름].left / .right, 윙크는 어느 쪽이든 윙크하는 눈).
  for (const [scene, list] of Object.entries(sceneEyes)) scenes[scene] = list.map((x) => {
    const o = { t: x.t, expr: x.e };
    if (x.gx) o.gx = x.gx;
    if (x.eL || x.eR) { o.left = x.eR || x.e; o.right = x.eL || x.e; }
    return o;
  });
  for (const [name, d] of Object.entries(EYES4)) {                           // 눈 한쪽에만 쓸 때의 비트맵
    const side = (frame, s) => (name === '윙크' ? mirror(HAPPY) : toRobot(frame)[s]);
    const solo = (frame) => ({ left: side(frame, 'left'), right: side(frame, 'right') });
    eyes[name].solo = d.frames ? d.frames.map((f) => ({ ...solo(f), ms: d.ms })) : solo(d);
  }
  return { version: 1, rows: 4, cols: 8, orientation: '로봇 기준 (left = 로봇의 왼쪽 눈 0x70, 맨 왼쪽 글자 = 로봇의 왼쪽 칸)', eyes, blink, scenes };
}
