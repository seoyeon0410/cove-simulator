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
  '하트 눈': ['01100110', '01111110', '00111100', '00011000'],        // 봉우리가 두 칸씩 이어진 6칸 하트 (한 칸짜리 점이 따로 떨어져 보이지 않게)
  '반짝 눈': { frames: [hole(OVAL, [[1, 3]]), hole(OVAL, [[1, 3], [2, 2]]), hole(OVAL, [[1, 3]]), OVAL], ms: 300 },
  '슬픈 눈': { L: SAD_L, R: mirror(SAD_L) },
  '신난 눈': { L: CHEVRON, R: mirror(CHEVRON) },
  '윙크': { L: OVAL, R: HAPPY },
  '편안한 눈': ['00000110', '00001100', '00011000', '00110000'],
  '별 눈': { frames: [STAR, STAR, STAR_SM], ms: 300 },
  '눈물 눈': { frames: [{ L: drop(TEAR_EYE, 2), R: drop(TEAR_EYE, 5) }, { L: drop(TEAR_EYE, 2), R: drop(TEAR_EYE, 5) }, { L: TEAR_EYE, R: TEAR_EYE }, { L: TEAR_EYE, R: TEAR_EYE }], ms: 400 },
  '점 눈': ['00000000', '00011000', '00011000', '00000000'],
};
// 뜬 눈의 깜빡임: 3.8초마다, 60ms 간격 4프레임(반쯤 → 감김 → 감김 → 반쯤) 뒤 뜬 눈으로 복귀
const BLINK = [['00000000', '00011000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00000000', '00111100', '00000000'], ['00000000', '00011000', '00111100', '00000000']];

const pair = (d) => (Array.isArray(d) ? { L: d, R: d } : { L: d.L, R: d.R });
// 웹(보는 사람 기준) → 로봇: 실물 시험으로 확인한 대로 left = 정면에서 볼 때 왼쪽 눈, right = 오른쪽 눈이고
// 글자 순서도 정면에서 본 왼쪽→오른쪽 그대로다 (좌우를 뒤집지 않는다).
const toRobot = (d) => { const { L, R } = pair(d); return { left: L, right: R }; };

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
// 실물 LED는 적어 준 칸보다 한 칸 오른쪽에 켜지고, 맨 오른쪽 칸은 맨 왼쪽 칸으로 넘어간다(2026-10-28 시험).
// 그래서 파일에는 미리 글자를 왼쪽으로 한 칸 돌려(맨 왼쪽 글자는 맨 오른쪽으로) 적어 둔다. 로봇 프로그램에서 이 어긋남을 고치면 HW_ROTATE 를 0으로 한다.
const HW_ROTATE = 1;
const rot = (rows) => (HW_ROTATE ? rows.map((r) => r.slice(HW_ROTATE) + r.slice(0, HW_ROTATE)) : rows);
const hwFrame = (f) => ({ ...f, left: rot(f.left), right: rot(f.right) });
const spreadFrame = (f, k) => ({ ...f, left: shiftOut(f.left, 'left', k.left), right: shiftOut(f.right, 'right', k.right) });

export function eyesJson(sceneEyes) {                          // sceneEyes: { 씬이름: [{t, e, gx}] }
  const eyes = {};
  for (const [name, d] of Object.entries(EYES4)) {
    if (d.frames) {
      const fr = d.frames.map(toRobot), k = spreadFor(fr);
      eyes[name] = { frames: fr.map((f) => ({ ...hwFrame(spreadFrame(f, k)), ms: d.ms })), loop: true };
    } else { const f = toRobot(d); eyes[name] = hwFrame(spreadFrame(f, spreadFor([f]))); }
  }
  const kOpen = spreadFor([toRobot(EYES4['뜬 눈'])]);            // 깜빡임은 뜬 눈과 같은 만큼 밀어서 눈 위치가 흔들리지 않게
  const blink = { for: '뜬 눈', period_s: 3.8, first_s: 1.6, frames: BLINK.map((f) => ({ ...hwFrame(spreadFrame(toRobot(f), kOpen)), ms: 60 })) };
  const scenes = {};
  // 눈을 한쪽씩 따로 고른 곳은 left / right 에 표정 이름을 적는다 (left = 정면에서 볼 때 왼쪽 눈).
  for (const [scene, list] of Object.entries(sceneEyes)) scenes[scene] = list.map((x) => {
    const o = { t: x.t, expr: x.e };
    if (x.gx) o.gx = x.gx;
    if (x.eL || x.eR) { o.left = x.eL || x.e; o.right = x.eR || x.e; }
    return o;
  });
  return {
    version: 1, rows: 4, cols: 8,
    orientation: '정면에서 볼 때 left = 왼쪽 눈, right = 오른쪽 눈. 글자 순서 = 정면에서 본 왼쪽→오른쪽.',
    hw_rotate: HW_ROTATE,
    note: HW_ROTATE ? '실물 LED가 한 칸 오른쪽으로 밀려 켜지고 맨 오른쪽 칸이 맨 왼쪽으로 넘어가서, 이 파일의 글자는 미리 왼쪽으로 한 칸 돌려 두었습니다. 로봇 프로그램에서 이 어긋남을 고친다면 글자를 오른쪽으로 한 칸 되돌려야 합니다.' : '',
    eyes, blink, scenes,
  };
}
