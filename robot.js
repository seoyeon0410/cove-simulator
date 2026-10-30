// 실제 로봇(MQTT)과 연결하는 패널.
// 전시 로봇 규약(엔지니어 답변서): 브로커 WebSocket → 토픽 booth/<로봇>/cmd 로 JSON 명령을 보내고,
// booth/<로봇>/status(1초마다) · booth/<로봇>/event 를 받는다. 전체 정지는 booth/all/cmd.
// 연결하기 전에는 아무것도 보내지 않으며, 움직이는 명령(씬·센서 모드)은 "주변 확인" 체크 후에만 보낸다.

import { REST, TICK } from './robotexport.js';

const $ = (s) => document.querySelector(s);
const DEFAULT_URL = 'ws://192.168.1.232:9001';
const EYES = [['idle', '뜬 눈'], ['blink', '깜빡'], ['look_left', '왼쪽 보기'], ['look_right', '오른쪽 보기'], ['happy', '웃는 눈'],
  ['closed', '감은 눈'], ['tickle', '간지럼'], ['curious', '궁금'], ['heart', '하트'], ['off', '끄기']];
const MODES = [['rest', '휴식'], ['tickle', '간지럽히기'], ['snack', '간식'], ['track', '따라보기'], ['off', '반응 끄기']];

let client = null, st = 'off', lastStatus = 0, torqueArm = 0, statusTimer = null;
let scenes = [], current = null, sig = '', sync = false, touch = false, touchAt = 0, arm = false, topMm = null, topOk = false, senseAt = 0, motorPos = null, motorAt = 0, torqueOffNow = false, torqueAt = 0, zNow = null, zPresent = false, zNearMm = null, zDropAt = 0, zAt = 0, zSettleUntil = 0, touchEach = null, touchRecent = null, armWeb = false, webBase = null, topBase = null, person = false, frontMm = null, frontDir = null, frontOk = false, frontAt = 0, autoMode = false;
const listeners = new Set();
const isOn = () => st === 'online' || st === 'live';
// 동작 목록 같은 다른 화면이 쓸 수 있게: 연결 여부 · 씬 목록 · 지금 도는 씬이 바뀔 때만 알린다
function notify() {
  const next = `${isOn()}|${current}|${sync}|${scenes.join(',')}`;
  if (next === sig) return;
  sig = next; listeners.forEach((f) => f());
}
export const robot = {
  get connected() { return isOn(); },
  get scenes() { return scenes; },
  get current() { return current; },
  onChange(f) { listeners.add(f); },
  // 'ok' | 'offline'(연결 안 됨) | 'unsafe'(주변 확인 체크 전). 체크 전에는 연결 창을 열어 체크를 안내한다.
  run(name) {
    if (!isOn()) { openPanel(); return 'offline'; }
    if (!$('#rpSafe').checked) { openPanel(); const l = $('#rpSafe').closest('label'); l.classList.remove('flash'); void l.offsetWidth; l.classList.add('flash'); return 'unsafe'; }
    return send({ cmd: 'scene', name }) ? 'ok' : 'offline';
  },
  stop() { setSync(false); return send({ cmd: 'stop' }); },
  // 정지 명령만 보내고 동기는 그대로 둔다 (웹을 일시정지했다가 다시 재생하면 이어서 따라 한다)
  hold() { return send({ cmd: 'stop' }); },
  get sync() { return sync; },
  get touch() { return touch && Date.now() - touchAt < 3500; },     // 로봇 머리의 터치센서(TTP223 ×3) 중 하나라도 닿아 있음 (상태 메시지 sense.touch, 상태가 끊기면 닿지 않은 것으로)
  get arm() { return (arm || armWeb) && topOk && Date.now() - senseAt < 3500; },   // 1번 거리센서(머리, 턱 아래·위 쉘이 아래를 봄) VL53L0X에 팔/손이 들어옴 (sense.arm, 상태가 끊기면 없는 것으로)
  // 로봇 모터의 지금 위치를 웹 각도(도)로 (status.motors 의 pos, 변환은 robotexport.toTicks 의 거꾸로). 값이 오래됐으면 null
  get deg() {
    if (!motorPos || Date.now() - motorAt > 3500) return null;
    return { neck: (REST.id2 - motorPos[2]) / TICK, head: (motorPos[3] - REST.id3) / TICK, tilt: (motorPos[4] - REST.id4) / TICK, body: (motorPos[1] - REST.id1) / 29.6 };
  },
  get torqueOff() { return torqueOffNow && Date.now() - torqueAt < 4000; },   // 모든 모터 토크가 꺼져 있음 (status.motors[].torque)
  get touchEach() { return touchEach && Date.now() - touchAt < 3500 ? touchEach : null; },           // 센서별 지금 닿음 [1, 2, 3]
  get touchRecent() { return touchRecent && Date.now() - touchAt < 3500 ? touchRecent : null; },       // 센서별 최근 1.6초 안에 닿았음 [1, 2, 3]
  get touchSampleAt() { return touchAt; },                          // 터치 값이 마지막으로 들어온 때 (상태 메시지가 올 때마다 바뀐다)
  // 2번 거리센서(몸통 앞, VL53L5CX 4×4): 사람이 가까이(50cm 안 1초) 있으면 person, 가장 가까운 거리 front_mm, 사람 방향 dir(-1 왼쪽 ~ +1 오른쪽)
  get approach() { return zPresent && Date.now() - zAt < 1500; },     // 2번 거리센서 구역 중 하나라도 평소보다 확 가까워짐 (사람·손이 다가옴)
  get approachMm() { return zNearMm; },                              // 다가온 구역 중 가장 가까운 거리 (mm)
  get tofKnown() { return zAt > 0 && Date.now() - zAt < 3500; },
  get tofNearMm() { return zNow ? Math.min(...zNow.filter((v) => v != null), 9999) : null; },   // 지금 가장 가까운 구역 (평소 거리 포함)
  get person() { return person && frontOk && Date.now() - frontAt < 3500; },
  get personKnown() { return frontAt > 0 && Date.now() - frontAt < 3500; },
  get frontOk() { return frontOk; },
  get frontMm() { return frontMm; },
  get frontDir() { return frontDir; },
  get auto() { return autoMode; },                                  // 로봇이 스스로 센서에 반응하는 자동 모드
  get armKnown() { return senseAt > 0 && Date.now() - senseAt < 3500; },
  get topOk() { return topOk; },
  get topMm() { return topMm; },
  get topBase() { return webBase != null ? Math.round(webBase) : topBase; },   // 손이 없을 때의 평소 거리(mm)                                     // 아래 방향 거리 (mm)
  get touchKnown() { return touchAt > 0 && Date.now() - touchAt < 3500; },
  // 웹 재생을 로봇이 실시간으로 따라 하게 한다(pose 명령, 10Hz). 연결 + "주변 확인" 체크가 있어야 켜진다.
  setSync(on) {
    if (!on) { setSync(false); return 'ok'; }
    if (!isOn()) { openPanel(); return 'offline'; }
    if (!$('#rpSafe').checked) { openPanel(); const l = $('#rpSafe').closest('label'); l.classList.remove('flash'); void l.offsetWidth; l.classList.add('flash'); return 'unsafe'; }
    setSync(true); return 'ok';
  },
  // 첫 전송만 기록에 남기고 이후는 조용히 보낸다
  pose(deg) { if (!sync) return false; const first = !poseLogged; poseLogged = true; return send({ cmd: 'pose', deg }, { quiet: !first }); },
  eyes(mode, loud = false) { return send({ cmd: 'eyes', mode }, { quiet: !loud }); },
  openPanel() { openPanel(); },
};
let poseLogged = false;
function setSync(on) {
  if (sync === on) return;
  sync = on; poseLogged = false;
  $('#robotSync').classList.toggle('on', on);
  log('sys', on ? '웹 재생을 로봇이 따라 해요 (실시간 동기)' : '실시간 동기를 껐어요');
  notify();
}
function openPanel() { $('#robotPanel').hidden = false; $('#btnRobot').classList.add('on'); }

const cfg = () => ({ url: $('#rpUrl').value.trim() || DEFAULT_URL, robot: $('#rpRobot').value.trim() || 'robot2' });
const topic = (suffix, robot = cfg().robot) => `booth/${robot}/${suffix}`;

function log(kind, text) {
  const box = $('#rpLog'), row = document.createElement('div');
  row.className = 'rp-line ' + kind;
  const t = new Date().toTimeString().slice(0, 8);
  row.innerHTML = '<span class="t"></span><span class="m"></span>';
  row.children[0].textContent = t; row.children[1].textContent = text;
  box.prepend(row);
  while (box.children.length > 40) box.lastChild.remove();
}

function setState(next, msg) {
  st = next;
  if (next !== 'online' && next !== 'live') { $('#rpSafe').checked = false; setSync(false); }   // 연결이 끊기면 안전 확인도 다시 받는다
  const names = { off: '연결 안 됨', connecting: '연결 중…', online: '연결됨', live: '상태 수신 중', error: '오류' };
  $('#rpState').textContent = msg || names[next];
  $('#rpState').dataset.s = next;
  $('#robotDot').dataset.s = next;
  $('#robotStop').hidden = $('#robotSync').hidden = !(next === 'online' || next === 'live');
  $('#rpConnect').textContent = next === 'off' || next === 'error' ? '연결' : '연결 해제';
  updateEnabled();
  notify();
}

function updateEnabled() {
  const on = st === 'online' || st === 'live', safe = $('#rpSafe').checked;
  if (!(on && safe)) setSync(false);
  ['rpStop', 'rpStopAll', 'rpTorqueOff', 'rpTorqueOn', 'rpReload', 'headTorqueOff'].forEach((id) => ($('#' + id).disabled = !on));
  // 움직이는 명령은 연결 + 주변 확인 체크가 모두 있어야 한다
  document.querySelectorAll('#rpScenes button, #rpModes button, #rpRun').forEach((b) => (b.disabled = !(on && safe)));
  document.querySelectorAll('#rpEyes button').forEach((b) => (b.disabled = !on));
  $('#rpSceneName').disabled = !(on && safe);
}

function send(obj, { all = false, quiet = false } = {}) {
  if (!client || !client.connected) { if (!quiet) log('err', '연결되어 있지 않아요'); return false; }
  const t = all ? 'booth/all/cmd' : topic('cmd');
  client.publish(t, JSON.stringify(obj), { qos: 0 });
  if (!quiet) log('out', `${all ? '[전체] ' : ''}${JSON.stringify(obj)}`);
  return true;
}

function connect() {
  if (client) { disconnect(); return; }
  const { url, robot } = cfg();
  if (!window.mqtt) { setState('error', 'MQTT 라이브러리를 못 불러왔어요'); return; }
  try { localStorage.setItem('cove-robot', JSON.stringify({ url, robot, auto: true })); } catch { /* 무시 */ }   // auto: 다음에 페이지를 열면 자동으로 다시 연결한다(연결만 하고, 움직이는 건 주변 확인·동기를 따로 켜야 한다)
  setState('connecting');
  log('sys', `연결 시도: ${url} (${robot})`);
  const c = window.mqtt.connect(url, { clientId: 'cove-web-' + Math.random().toString(16).slice(2, 8), connectTimeout: 5000, reconnectPeriod: 3000, clean: true });
  client = c;
  c.on('connect', () => {
    setState('online'); log('sys', '브로커에 연결됐어요');
    c.subscribe([topic('status', robot), topic('event', robot), topic('tof', robot)], (err) => { if (err) log('err', '구독 실패: ' + err.message); });
  });
  c.on('reconnect', () => { if (client === c) setState('connecting'); });
  c.on('close', () => { if (client === c && st !== 'off') setState('connecting', '연결이 끊겼어요 · 다시 시도 중'); });
  c.on('error', (e) => { log('err', '오류: ' + (e && e.message)); if (client === c) setState('error', /connack timeout/i.test((e && e.message) || '') ? `로봇 서버(${url.replace(/^wss?:\/\//, '')})가 응답하지 않아요 · 서버 PC가 켜져 있는지, 같은 와이파이인지 확인하세요 (자동으로 다시 시도 중)` : '연결 오류 (주소를 확인하세요)'); });
  c.on('message', (t, payload) => {
    let msg; const s = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    try { msg = JSON.parse(s); } catch { msg = s; }
    if (t.endsWith('/status')) onStatus(msg);
    else if (t.endsWith('/tof')) onTof(msg);
    else if (t.endsWith('/event')) log('in', typeof msg === 'string' ? msg : (msg.msg || msg.text || JSON.stringify(msg)));
  });
  clearInterval(statusTimer);
  statusTimer = setInterval(() => {                       // 상태가 4초 넘게 안 오면 "연결됨"으로 되돌려 알린다
    if (st === 'live' && Date.now() - lastStatus > 4000) { setState('online', '연결됨 · 로봇 응답 없음'); }
  }, 1000);
}

function disconnect() {
  try { const s = JSON.parse(localStorage.getItem('cove-robot') || '{}'); s.auto = false; localStorage.setItem('cove-robot', JSON.stringify(s)); } catch { /* 무시 */ }   // 직접 끊으면 자동 연결도 끈다
  if (client) { try { client.end(true); } catch { /* 무시 */ } client = null; }
  clearInterval(statusTimer);
  scenes = []; current = null; sceneKey = '';
  $('#rpScenes').textContent = '연결하면 로봇의 씬을 왼쪽 동작 목록에서 동작별로 실행할 수 있어요.';
  setState('off'); log('sys', '연결을 끊었어요');
  $('#rpStatus').innerHTML = '<span class="dim">상태 정보가 아직 없어요</span>';
}

const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : typeof v === 'boolean' ? (v ? '예' : '아니오') : String(v));
function rows(obj, prefix = '', depth = 0, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'scenes') continue;
    if (v && typeof v === 'object' && depth < 2) rows(v, prefix + k + '.', depth + 1, out);
    else if (!(v && typeof v === 'object')) out.push([prefix + k, fmt(v)]);
  }
  return out;
}
let sceneKey = '';
function onStatus(msg) {
  lastStatus = Date.now();
  if (st === 'online' || st === 'live') setState('live');
  const box = $('#rpStatus');
  if (msg && typeof msg === 'object') {
    const list = rows(msg);
    box.innerHTML = '';
    list.slice(0, 40).forEach(([k, v]) => { const r = document.createElement('div'); r.className = 'kv'; r.innerHTML = '<span class="k"></span><span class="v"></span>'; r.children[0].textContent = k; r.children[1].textContent = v; box.appendChild(r); });
    const list2 = Array.isArray(msg.scenes) ? msg.scenes.map((x) => (typeof x === 'string' ? x : x.name)).filter(Boolean) : null;
    if (list2 && list2.join('|') !== sceneKey) { sceneKey = list2.join('|'); scenes = list2; buildScenes(list2); }
    current = typeof msg.scene === 'string' && msg.scene ? msg.scene : null;
    if (msg.sense && typeof msg.sense.touch === 'boolean') { touch = msg.sense.touch; touchAt = Date.now(); }
    if (msg.sense && Array.isArray(msg.sense.touch_each)) { touchEach = msg.sense.touch_each.map(Boolean); touchRecent = Array.isArray(msg.sense.touch_recent) ? msg.sense.touch_recent.map(Boolean) : touchEach; }   // 센서별 [1번 왼쪽 위, 2번 가운데, 3번 오른쪽 위] (로봇 프로그램에 추가한 값)
    if (typeof msg.auto === 'boolean') autoMode = msg.auto;
    if (Array.isArray(msg.motors) && msg.motors.length) { torqueOffNow = msg.motors.every((m) => m && m.torque === false); torqueAt = Date.now(); updateTorqueBtn(); }
    if (msg.sense && typeof msg.sense.person === 'boolean') { person = msg.sense.person; frontMm = typeof msg.sense.front_mm === 'number' ? msg.sense.front_mm : null; frontDir = typeof msg.sense.dir === 'number' ? msg.sense.dir : null; frontOk = !!msg.sense.front_ok; frontAt = Date.now(); }
    if (Array.isArray(msg.motors)) { const prev = motorPos; const p = {}; msg.motors.forEach((m) => { if (m && typeof m.pos === 'number') p[m.id] = m.pos; }); if (p[1] != null && p[2] != null && p[3] != null && p[4] != null) { if (prev && [1, 2, 3, 4].some((id) => Math.abs(p[id] - prev[id]) > 30)) { zSettleUntil = Date.now() + 2500; zHist = null; zPresent = false; zNearMm = null; zStreak = 0; } motorPos = p; motorAt = Date.now(); } }
    if (msg.sense && typeof msg.sense.top_mm === 'number') {
      // 웹에서도 따로 본다: 로봇은 "평소 거리보다 8cm 넘게 가까울 때"만 손으로 치는데, 머리가 접힌 자세처럼 평소 거리가 짧으면 손이 아무리 가까워도 8cm가 안 돼서 못 잡는다.
      // 그래서 평소 거리보다 25% 넘게(그리고 20mm 이상) 가까워지면 손이 있는 것으로 본다. 손이 있는 동안은 기준을 고정하고, 85% 이상 돌아오면 없는 것으로 한다.
      const t = msg.sense.top_mm; topBase = typeof msg.sense.top_base === 'number' ? msg.sense.top_base : null;
      if (webBase == null) webBase = t;
      else if (!armWeb) { if (t < webBase * 0.75 && webBase - t >= 20) armWeb = true; else webBase = webBase * 0.7 + t * 0.3; }
      else if (t > webBase * 0.85) { armWeb = false; webBase = t; }
    }
    if (msg.sense && typeof msg.sense.arm === 'boolean') { arm = msg.sense.arm; topMm = typeof msg.sense.top_mm === 'number' ? msg.sense.top_mm : null; topOk = !!msg.sense.top_ok; senseAt = Date.now(); }
    notify();
  } else box.textContent = String(msg);
}

/* 2번 거리센서(몸통 앞 4×4)의 구역별 거리(0.2초마다, booth/<id>/tof 의 z). 로봇의 person(50cm 안 1초)은 센서 앞에 항상 뭔가 가까이 있으면(지금은 약 6cm) 늘 true라서 "다가옴"을 가를 수 없다.
   그래서 구역마다 최근 5초(25개)의 중앙값을 평소 거리로 삼고, 어느 구역이든 평소보다 30% 넘게(그리고 20mm 이상) 가까워지면서 센서 값이 140mm(손 약 10cm) 이하인 상태가 0.4초(2개) 이어지면(평소의 절반 아래로 확 가까워지면 첫 값 0.2초) 다가온 것으로 본다.
   (일부 구역은 가끔 튀는 값이 있어서 평균 대신 중앙값을 쓴다.) 다가온 동안은 평소 거리를 거의 갱신하지 않고, 다가온 구역 중 가장 가까운 거리가 approachMm.
   로봇이 움직여 센서 보는 곳이 바뀌면(모터 위치가 달라지면) 평소 거리를 새로 잡고 2.5초는 보지 않는다. */
const Z_WIN = 25, Z_MAX_MM = 140;                                 // 다가옴은 손이 약 10cm 안일 때만. 센서 값은 실제보다 1~2cm 크게 나와서(손 10cm ≈ 120mm, 5cm ≈ 58mm) 140mm 이하로 본다
let zHist = null, zStreak = 0, zSkip = 0;
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
function onTof(msg) {
  if (!msg || !Array.isArray(msg.z)) return;
  const now = Date.now(), z = msg.z.map((v) => (typeof v === 'number' && v > 0 ? v : null));
  zAt = now; zNow = z;
  if (!zHist || zHist.length !== z.length) zHist = z.map(() => []);
  if (now < zSettleUntil) { zHist = z.map((v) => (v != null ? [v] : [])); zPresent = false; zStreak = 0; return; }
  let drop = null, strong = false;
  z.forEach((v, i) => {
    const h = zHist[i];
    if (v == null || h.length < 5) return;                            // 평소 거리를 모으는 중(1초)에는 보지 않는다
    const base = median(h);
    if (v <= Z_MAX_MM && v < base * 0.7 && base - v >= 20) { drop = drop == null ? v : Math.min(drop, v); if (v < base * 0.5 && base - v >= 40) strong = true; }   // 절반 아래로 확 가까워진 건 첫 값에서 바로
  });
  if (drop != null) { zStreak++; if (zStreak >= 2 || strong) { zPresent = true; zNearMm = drop; zDropAt = now; } }
  else { zStreak = 0; if (zPresent && now - zDropAt > 1500) { zPresent = false; zNearMm = null; } }
  zSkip = zPresent ? zSkip + 1 : 0;
  if (!zPresent || zSkip % 5 === 0) z.forEach((v, i) => { if (v != null) { zHist[i].push(v); if (zHist[i].length > Z_WIN) zHist[i].shift(); } });
}

// 모든 모터의 토크가 꺼져 있으면(로봇이 "정지 (토크 해제)" 상태) 로봇은 어떤 자세 명령도 따라 하지 않는다. 오른쪽 패널의 빨간 버튼이 그때는 "모터 토크 켜기"가 된다.
function updateTorqueBtn() {
  const b = $('#headTorqueOff'); if (!b || b.classList.contains('armed')) return;
  const off = torqueOffNow && Date.now() - torqueAt < 4000;
  b.textContent = off ? '모터 토크 켜기 (지금 꺼져 있어요)' : '모터 토크 끄기';
  b.classList.toggle('torque-is-off', off);
}

function buildScenes(list) {
  $('#rpScenes').textContent = list.length ? `로봇에 씬 ${list.length}개가 있어요. 왼쪽 동작 목록에서 동작별로 실행하세요.` : '로봇에 씬이 없어요';
  updateEnabled();
}

export function initRobotPanel({ exportFiles } = {}) {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('cove-robot') || '{}'); } catch { /* 무시 */ }
  $('#rpUrl').value = saved.url || DEFAULT_URL; $('#rpRobot').value = saved.robot || 'robot2';
  if (saved.auto) setTimeout(() => { if (!client) connect(); }, 800);   // 지난번에 연결해 두었으면 새로고침해도 자동으로 다시 연결한다

  EYES.forEach(([m, label]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = () => send({ cmd: 'eyes', mode: m }); $('#rpEyes').appendChild(b); });
  MODES.forEach(([m, label]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = () => send({ cmd: 'mode', name: m }); $('#rpModes').appendChild(b); });

  const panel = $('#robotPanel');
  $('#btnRobot').onclick = () => { panel.hidden = !panel.hidden; $('#btnRobot').classList.toggle('on', !panel.hidden); };
  $('#rpClose').onclick = () => { panel.hidden = true; $('#btnRobot').classList.remove('on'); };
  $('#rpConnect').onclick = connect;
  const stop = () => { setSync(false); send({ cmd: 'stop' }); };
  $('#rpStop').onclick = stop; $('#robotStop').onclick = stop;
  $('#rpStopAll').onclick = () => { setSync(false); send({ cmd: 'stop' }, { all: true }); };
  $('#rpTorqueOn').onclick = () => send({ cmd: 'torque', on: true });
  $('#rpTorqueOff').onclick = () => {                         // 머리가 처질 수 있어서 두 번 눌러야 실행
    const b = $('#rpTorqueOff');
    if (!torqueArm) { torqueArm = setTimeout(() => { torqueArm = 0; b.textContent = '토크 해제'; b.classList.remove('armed'); }, 3000); b.textContent = '한 번 더 누르면 해제 (머리가 처질 수 있어요)'; b.classList.add('armed'); return; }
    clearTimeout(torqueArm); torqueArm = 0; b.textContent = '토크 해제'; b.classList.remove('armed');
    send({ cmd: 'torque', on: false });
  };
  // 오른쪽 패널의 빨간 버튼: 위 "토크 해제"와 같은 일. 머리가 처질 수 있어서 두 번 눌러야 하고, 끄기 전에 웹 동기도 끈다
  let headTorqueArm = 0;
  $('#headTorqueOff').onclick = () => {
    const b = $('#headTorqueOff');
    if (torqueOffNow && Date.now() - torqueAt < 4000) { send({ cmd: 'torque', on: true }); return; }   // 꺼져 있을 때는 한 번에 켠다
    if (!headTorqueArm) { headTorqueArm = setTimeout(() => { headTorqueArm = 0; b.classList.remove('armed'); updateTorqueBtn(); }, 3000); b.textContent = '한 번 더 누르면 꺼요 (머리가 처질 수 있어요)'; b.classList.add('armed'); return; }
    clearTimeout(headTorqueArm); headTorqueArm = 0; b.classList.remove('armed'); updateTorqueBtn();
    setSync(false); send({ cmd: 'torque', on: false });
  };
  $('#rpReload').onclick = () => send({ cmd: 'reload' });
  $('#rpRun').onclick = () => { const n = $('#rpSceneName').value.trim(); if (n) send({ cmd: 'scene', name: n }); };
  $('#rpSceneName').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#rpRun').click(); };
  $('#rpUrl').onkeydown = $('#rpRobot').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') connect(); };
  $('#rpSafe').onchange = updateEnabled;
  $('#robotSync').onclick = () => {
    const r = robot.setSync(!sync);
    if (r === 'unsafe') log('err', '"로봇 주변을 확인했어요"를 체크하면 동기를 켤 수 있어요');
  };
  $('#rpExport').onclick = () => {
    if (!exportFiles) return;
    const { blob, lines } = exportFiles({ tiltSign: +$('#rpTiltSign').value, bodySign: +$('#rpBodySign').value });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'cove_web_motions.zip'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    const box = $('#rpExpReport'); box.innerHTML = '';
    lines.forEach((l) => {
      const r = document.createElement('div'); r.className = 'kv'; r.innerHTML = '<span class="k"></span><span class="v"></span>';
      r.children[0].textContent = `${l.name.replace(/^시나리오\d+\s*/, '')} (${l.file})`;
      r.children[1].textContent = l.cut.length ? '잘림 · ' + l.cut.join(', ') : '그대로';
      box.appendChild(r);
    });
    log('sys', `로봇용 모션 ${lines.length}개 파일을 만들었어요`);
  };
  setState('off');
  window.__robot = { send, robot, connect, disconnect, get state() { return st; } };
}
