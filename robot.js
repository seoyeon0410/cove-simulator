// 실제 로봇(MQTT)과 연결하는 패널.
// 전시 로봇 규약(엔지니어 답변서): 브로커 WebSocket → 토픽 booth/<로봇>/cmd 로 JSON 명령을 보내고,
// booth/<로봇>/status(1초마다) · booth/<로봇>/event 를 받는다. 전체 정지는 booth/all/cmd.
// 연결하기 전에는 아무것도 보내지 않으며, 움직이는 명령(씬·센서 모드)은 "주변 확인" 체크 후에만 보낸다.

const $ = (s) => document.querySelector(s);
const DEFAULT_URL = 'ws://192.168.1.232:9001';
const EYES = [['idle', '뜬 눈'], ['blink', '깜빡'], ['look_left', '왼쪽 보기'], ['look_right', '오른쪽 보기'], ['happy', '웃는 눈'],
  ['closed', '감은 눈'], ['tickle', '간지럼'], ['curious', '궁금'], ['heart', '하트'], ['off', '끄기']];
const MODES = [['rest', '휴식'], ['tickle', '간지럽히기'], ['snack', '간식'], ['track', '따라보기'], ['off', '반응 끄기']];

let client = null, st = 'off', lastStatus = 0, torqueArm = 0, statusTimer = null;
let scenes = [], current = null, sig = '';
const listeners = new Set();
const isOn = () => st === 'online' || st === 'live';
// 동작 목록 같은 다른 화면이 쓸 수 있게: 연결 여부 · 씬 목록 · 지금 도는 씬이 바뀔 때만 알린다
function notify() {
  const next = `${isOn()}|${current}|${scenes.join(',')}`;
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
  stop() { return send({ cmd: 'stop' }); },
  openPanel() { openPanel(); },
};
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
  if (next !== 'online' && next !== 'live') $('#rpSafe').checked = false;   // 연결이 끊기면 안전 확인도 다시 받는다
  const names = { off: '연결 안 됨', connecting: '연결 중…', online: '연결됨', live: '상태 수신 중', error: '오류' };
  $('#rpState').textContent = msg || names[next];
  $('#rpState').dataset.s = next;
  $('#robotDot').dataset.s = next;
  $('#robotStop').hidden = !(next === 'online' || next === 'live');
  $('#rpConnect').textContent = next === 'off' || next === 'error' ? '연결' : '연결 해제';
  updateEnabled();
  notify();
}

function updateEnabled() {
  const on = st === 'online' || st === 'live', safe = $('#rpSafe').checked;
  ['rpStop', 'rpStopAll', 'rpTorqueOff', 'rpTorqueOn', 'rpReload'].forEach((id) => ($('#' + id).disabled = !on));
  // 움직이는 명령은 연결 + 주변 확인 체크가 모두 있어야 한다
  document.querySelectorAll('#rpScenes button, #rpModes button, #rpRun').forEach((b) => (b.disabled = !(on && safe)));
  document.querySelectorAll('#rpEyes button').forEach((b) => (b.disabled = !on));
  $('#rpSceneName').disabled = !(on && safe);
}

function send(obj, { all = false } = {}) {
  if (!client || !client.connected) { log('err', '연결되어 있지 않아요'); return false; }
  const t = all ? 'booth/all/cmd' : topic('cmd');
  client.publish(t, JSON.stringify(obj), { qos: 0 });
  log('out', `${all ? '[전체] ' : ''}${JSON.stringify(obj)}`);
  return true;
}

function connect() {
  if (client) { disconnect(); return; }
  const { url, robot } = cfg();
  if (!window.mqtt) { setState('error', 'MQTT 라이브러리를 못 불러왔어요'); return; }
  try { localStorage.setItem('cove-robot', JSON.stringify({ url, robot })); } catch { /* 무시 */ }
  setState('connecting');
  log('sys', `연결 시도: ${url} (${robot})`);
  const c = window.mqtt.connect(url, { clientId: 'cove-web-' + Math.random().toString(16).slice(2, 8), connectTimeout: 5000, reconnectPeriod: 3000, clean: true });
  client = c;
  c.on('connect', () => {
    setState('online'); log('sys', '브로커에 연결됐어요');
    c.subscribe([topic('status', robot), topic('event', robot)], (err) => { if (err) log('err', '구독 실패: ' + err.message); });
  });
  c.on('reconnect', () => { if (client === c) setState('connecting'); });
  c.on('close', () => { if (client === c && st !== 'off') setState('connecting', '연결이 끊겼어요 · 다시 시도 중'); });
  c.on('error', (e) => { log('err', '오류: ' + (e && e.message)); if (client === c) setState('error', '연결 오류 (주소를 확인하세요)'); });
  c.on('message', (t, payload) => {
    let msg; const s = typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
    try { msg = JSON.parse(s); } catch { msg = s; }
    if (t.endsWith('/status')) onStatus(msg);
    else if (t.endsWith('/event')) log('in', typeof msg === 'string' ? msg : (msg.msg || msg.text || JSON.stringify(msg)));
  });
  clearInterval(statusTimer);
  statusTimer = setInterval(() => {                       // 상태가 4초 넘게 안 오면 "연결됨"으로 되돌려 알린다
    if (st === 'live' && Date.now() - lastStatus > 4000) { setState('online', '연결됨 · 로봇 응답 없음'); }
  }, 1000);
}

function disconnect() {
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
    notify();
  } else box.textContent = String(msg);
}

function buildScenes(list) {
  $('#rpScenes').textContent = list.length ? `로봇에 씬 ${list.length}개가 있어요. 왼쪽 동작 목록에서 동작별로 실행하세요.` : '로봇에 씬이 없어요';
  updateEnabled();
}

export function initRobotPanel({ exportFiles } = {}) {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('cove-robot') || '{}'); } catch { /* 무시 */ }
  $('#rpUrl').value = saved.url || DEFAULT_URL; $('#rpRobot').value = saved.robot || 'robot2';

  EYES.forEach(([m, label]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = () => send({ cmd: 'eyes', mode: m }); $('#rpEyes').appendChild(b); });
  MODES.forEach(([m, label]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = label; b.onclick = () => send({ cmd: 'mode', name: m }); $('#rpModes').appendChild(b); });

  const panel = $('#robotPanel');
  $('#btnRobot').onclick = () => { panel.hidden = !panel.hidden; $('#btnRobot').classList.toggle('on', !panel.hidden); };
  $('#rpClose').onclick = () => { panel.hidden = true; $('#btnRobot').classList.remove('on'); };
  $('#rpConnect').onclick = connect;
  const stop = () => send({ cmd: 'stop' });
  $('#rpStop').onclick = stop; $('#robotStop').onclick = stop;
  $('#rpStopAll').onclick = () => send({ cmd: 'stop' }, { all: true });
  $('#rpTorqueOn').onclick = () => send({ cmd: 'torque', on: true });
  $('#rpTorqueOff').onclick = () => {                         // 머리가 처질 수 있어서 두 번 눌러야 실행
    const b = $('#rpTorqueOff');
    if (!torqueArm) { torqueArm = setTimeout(() => { torqueArm = 0; b.textContent = '토크 해제'; b.classList.remove('armed'); }, 3000); b.textContent = '한 번 더 누르면 해제 (머리가 처질 수 있어요)'; b.classList.add('armed'); return; }
    clearTimeout(torqueArm); torqueArm = 0; b.textContent = '토크 해제'; b.classList.remove('armed');
    send({ cmd: 'torque', on: false });
  };
  $('#rpReload').onclick = () => send({ cmd: 'reload' });
  $('#rpRun').onclick = () => { const n = $('#rpSceneName').value.trim(); if (n) send({ cmd: 'scene', name: n }); };
  $('#rpSceneName').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') $('#rpRun').click(); };
  $('#rpUrl').onkeydown = $('#rpRobot').onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') connect(); };
  $('#rpSafe').onchange = updateEnabled;
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
