// 로봇 전용 씬 버튼에 보여 줄 한글 이름 (여기에 없는 씬은 로봇 씬 이름 그대로). 실행은 원래 씬 이름으로 한다
export const SCENE_LABEL = { home: '원점 자세', tickle_squirm_loop: '간지러워요 (반복)', tickle_calm: '더 놀고 싶어요 (손 뗌)', snack_3_sniff: '냄새가 나는 것 같아요 (센서)' };   // 2026-11-03: 코브 씬을 웹 시나리오·단계 동작만 남기고 바꿨다

// 웹 동작(시나리오) ↔ 로봇 씬 연결표. 키는 동작 이름에서 "시나리오N "을 뺀 제목이다.
//   main  : 처음부터 끝까지 한 번에 도는 씬
//   steps : 장면(1, 2, 3 …)별 씬
//   more  : 같은 동작에 속하는 그 밖의 씬
// 이름이 바뀐 동작이나 직접 만든 클립에는 연결되지 않는다. 로봇 씬이 늘어나면 아래 표에 적어 주면 된다.
export const LINKS = {
  '휴식': { web: 'web_rest', main: 'rest', steps: ['rest_1_wake', 'rest_2_invite', 'rest_3_nibble', 'rest_4_lean', 'rest_5_sleep', 'rest_6_release'] },
  '간지럽히기': { web: 'web_tickle', main: 'tickle', steps: ['tickle_1_look', 'tickle_2_invite', 'tickle_3_squirm', 'tickle_4_enjoy', 'tickle_5_laugh', 'tickle_6_end'], more: ['tickle_squirm_loop', 'tickle_calm'] },
  '간식주기': { web: 'web_snack', main: 'snack', steps: ['snack_1_look', 'snack_2_sniff', 'snack_3_curious', 'snack_4_expect', 'snack_5_eat', 'snack_6_full', 'snack_7_happy', 'snack_8_sleepy'], more: ['snack_3_sniff'] },
  '인사': { web: 'web_greet', main: 'greet' },
  '표정 모음': { web: 'web_expressions', main: 'expressions' },
};

// 웹에 같은 동작이 없는 로봇 전용 씬 묶음. 여기에도 없는 씬은 자동으로 "기타"에 모인다.
export const ROBOT_ONLY = [
  { label: '기본 자세', scenes: ['home'] },
];

// 웹 모션 그대로 만든 로봇 파일/씬 이름 (영문). 연결표에 없는 동작은 web_clip번호.
export const webSceneName = (clipName, index) => (LINKS[clipName.replace(/^시나리오\d+\s*/, '')]?.web) || `web_clip${index + 1}`;
export const linkFor = (clipName) => LINKS[clipName.replace(/^시나리오\d+\s*/, '')] || null;

// 연결된 로봇에 실제로 있는 씬만 남긴 연결표와, 어느 동작에도 속하지 않은 로봇 전용 묶음을 만든다.
export function restrictTo(link, scenes) {
  const has = new Set(scenes), keep = (a) => (a || []).filter((n) => has.has(n));
  return { main: link.main && has.has(link.main) ? link.main : null, steps: keep(link.steps), more: keep(link.more) };
}
// 화면에 보이지 않게 할 로봇 씬 (토토로 5개). 목록에서만 숨기고 로봇에는 그대로 있다
const HIDDEN_SCENES = (n) => /^totoro_/.test(n);
export function robotOnlyGroups(scenes) {
  scenes = scenes.filter((n) => !HIDDEN_SCENES(n));
  const used = new Set();
  Object.values(LINKS).forEach((l) => [l.main, l.web, ...(l.steps || []), ...(l.more || [])].forEach((n) => n && used.add(n)));
  const groups = ROBOT_ONLY.map((g) => ({ label: g.label, scenes: g.scenes.filter((n) => scenes.includes(n)) }));
  groups.forEach((g) => g.scenes.forEach((n) => used.add(n)));
  const rest = scenes.filter((n) => !used.has(n));
  if (rest.length) groups.push({ label: '기타', scenes: rest });
  return groups.filter((g) => g.scenes.length);
}
