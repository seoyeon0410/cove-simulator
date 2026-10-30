import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PRESET_GROUPS } from './presets.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyLook, buildEyes, EXPRESSIONS, drawPattern, eyeRows } from './look.js';
import { initRobotPanel, robot } from './robot.js';
import { linkFor, restrictTo, robotOnlyGroups, webSceneName, SCENE_LABEL } from './robotmap.js';
import { csvOf, report, zip, limitFrames, STEP, LIMITS, tiltRange } from './robotexport.js';
import { eyesJson } from './roboteyes.js';
import { initEyeDock, EYE_MIME } from './eyedock.js';
import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.mjs';

const $ = (s) => document.querySelector(s);
const EPS = 1e-4;
const ACCENT = 0xefd9ae;
const FONT = '"Google Sans Flex", "Noto Sans KR", sans-serif';

/* ───────────── 상태 ───────────── */
const S = {
  glb: null,              // { json, bin(ArrayBuffer), name }
  model: null,
  nodes: new Map(),       // glTF node index -> Object3D
  idxOf: new Map(),       // Object3D -> node index
  rest: new Map(),        // node index -> { p, q, s }
  boneIdx: [],            // skin joint node indices
  clips: [],
  clip: 0,
  time: 0,
  playing: false,
  sel: null,              // 선택된 Object3D
  selKeys: new Set(),     // 선택된 키 객체
  autoKey: true,
  loop: false,                                  // 자동 반복하지 않는다 (끝나면 마지막 상태에서 멈춘다)
  showAll: false,
  copied: null,
};

const D2R = Math.PI / 180;
const nodeName = (i) => S.glb.json.nodes[i].name || `node ${i}`;
const curClip = () => S.clips[S.clip];
const fps = () => curClip()?.fps || 30;

/* ───────────── three.js 장면 ───────────── */
const viewEl = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
viewEl.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 100);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;   // 알루미늄·패브릭의 은은한 반사/광택용
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a958c, 0.8));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(1, 2, 1.5);
sun.castShadow = true;
scene.add(sun, sun.target);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
const tc = new TransformControls(camera, renderer.domElement);
tc.setMode('rotate');
tc.setSize(0.75);
const tcHelper = tc.getHelper ? tc.getHelper() : tc;
scene.add(tcHelper);
tc.addEventListener('dragging-changed', (e) => {
  orbit.enabled = !e.value;
  if (!e.value) snapshot();
});
tc.addEventListener('objectChange', () => onNodeEdited());

let grid = null;
let eyes = null;
let markers = [];          // { idx, mesh }
let boneLines = null;
let fitInfo = { center: new THREE.Vector3(), size: 1 };
const markerGeo = new THREE.SphereGeometry(1, 16, 12);

// 바닥: 연한 회색 원판이 가장자리로 갈수록 배경(베이지)에 녹아든다. 그림자는 이 바닥에 떨어진다.
function makeFloor(size, box) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d'), grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.55, '#fff'); grad.addColorStop(1, '#000');
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  const mat = new THREE.MeshStandardMaterial({ color: '#d6d2cb', roughness: 0.95, metalness: 0, alphaMap: new THREE.CanvasTexture(c), transparent: true, envMapIntensity: 0.4 });
  const m = new THREE.Mesh(new THREE.CircleGeometry(size * 2.6, 64), mat);
  m.rotation.x = -Math.PI / 2; m.position.set(fitInfo.center.x, box.min.y - 0.0003, fitInfo.center.z);
  m.receiveShadow = true; m.renderOrder = -1; m.name = '바닥';
  return m;
}
function setupSun(size, center) {
  sun.position.set(center.x + size * 0.55, center.y + size * 1.5, center.z + size * 0.9);
  sun.target.position.copy(center); sun.target.updateMatrixWorld();
  const cam = sun.shadow.camera, r = size * 0.9;
  cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = size * 0.2; cam.far = size * 4; cam.updateProjectionMatrix();
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = size * 0.002; sun.shadow.radius = 5;
}

function resizeView() {
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resizeView).observe(viewEl);

function fitCamera() {
  const { center, size } = fitInfo;
  camera.position.copy(center).add(new THREE.Vector3(1, 0.6, 1).normalize().multiplyScalar(size * 1.85));
  camera.near = size / 200; camera.far = size * 200;
  camera.updateProjectionMatrix();
  orbit.target.copy(center);
  orbit.update();
}

/* ───────────── GLB 읽기 ───────────── */
function parseGLB(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB 파일이 아닙니다');
  let off = 12, json = null, bin = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === 0x004e4942 && !bin) bin = data;
    off += 8 + len;
  }
  return { json, bin: bin || new ArrayBuffer(0) };
}

const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function readAccessor(i) {
  const { json, bin } = S.glb;
  const a = json.accessors[i];
  if (a.componentType !== 5126) throw new Error('float 이외의 애니메이션 데이터는 지원하지 않습니다');
  const bv = json.bufferViews[a.bufferView];
  const n = COMP[a.type];
  const stride = bv.byteStride || n * 4;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const dv = new DataView(bin);
  const out = new Float32Array(a.count * n);
  for (let k = 0; k < a.count; k++)
    for (let c = 0; c < n; c++) out[k * n + c] = dv.getFloat32(base + k * stride + c * 4, true);
  return out;
}

function loadGLB(buffer, name) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = parseGLB(buffer); } catch (e) { return reject(e); }
    new GLTFLoader().parse(buffer.slice(0), '', (gltf) => {
      stopPlay();
      if (S.model) scene.remove(S.model);
      S.glb = { ...parsed, name };
      S.model = gltf.scene;
      scene.add(S.model);
      S.model.updateMatrixWorld(true);

      S.nodes.clear(); S.idxOf.clear(); S.rest.clear();
      for (const [obj, assoc] of gltf.parser.associations) {
        if (assoc && assoc.nodes !== undefined && obj.isObject3D) {
          S.nodes.set(assoc.nodes, obj);
          S.idxOf.set(obj, assoc.nodes);
          S.rest.set(assoc.nodes, { p: obj.position.toArray(), q: obj.quaternion.toArray(), s: obj.scale.toArray() });
        }
      }
      const joints = new Set();
      (parsed.json.skins || []).forEach((sk) => sk.joints.forEach((j) => joints.add(j)));
      S.boneIdx = [...joints].filter((j) => S.nodes.has(j));

      const box = new THREE.Box3().setFromObject(S.model);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      fitInfo = { center: box.getCenter(new THREE.Vector3()), size };
      if (grid) scene.remove(grid);
      grid = makeFloor(size, box);
      scene.add(grid);
      S.model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      setupSun(size, fitInfo.center);
      buildMarkers();
      fitCamera();
      applyLook(S.model);
      const z = new THREE.Vector3(0, 0, 1);
      eyes = buildEyes(S, {
        setPose: () => {
          S.nodes.get(40).quaternion.fromArray(S.rest.get(40).q).multiply(new THREE.Quaternion().setFromAxisAngle(z, 35 * D2R));
          S.nodes.get(37).quaternion.fromArray(S.rest.get(37).q).multiply(new THREE.Quaternion().setFromAxisAngle(z, -42 * D2R));
        },
        resetPose: () => { for (const [i, o] of S.nodes) { const r = S.rest.get(i); o.position.fromArray(r.p); o.quaternion.fromArray(r.q); o.scale.fromArray(r.s); } },
      });
      eyes.onFrame = (pl, pr) => eyeDock.draw(pl, pr);
      if (eyes.rows) eyeDock.draw(...eyes.rows);
      applyOpacity();

      setupIK();
      const saved = loadSaved();
      S.clips = saved?.clips || PRESET_GROUPS[0].items.map(buildPresetClip);
      // 없앤 표정이 저장된 클립에 남아 있으면 바꿔 준다: 표정 모음은 새로 만들고, 나머지는 비슷한 표정으로 대체
      const GONE = { '초롱 눈': '반짝 눈', '또렷한 눈': '뜬 눈' };
      if (saved) S.clips = S.clips.filter((c) => !/칭찬받기|깜짝 놀람|두리번 탐색|작별 인사/.test(c.name)).map((c) => {   // 없앤 시나리오(5 칭찬받기, 6 깜짝 놀람, 7 두리번 탐색, 8 작별 인사)가 저장돼 있으면 지운다
        { const d = PRESET_GROUPS[0].items.find((i) => i.name === c.name); if (d?.rev && c.rev !== d.rev) return buildPresetClip(d); }   // 프리셋이 새로 다듬어졌으면 저장된 예전 클립은 새 것으로 바꾼다
        { const d = PRESET_GROUPS[0].items.find((i) => i.name === c.name); if (d?.hold && c.markers?.length) c.holds = d.hold.map((h) => ({ t: c.markers[h.at].t, label: h.label || '숙이기', msg: h.msg || '', touch: !!h.touch, arm: !!h.arm })); }   // 멈춤 지점은 프리셋 그대로 맞춘다
        if (c.group === '표정' && (c.markers || []).some((m) => GONE[m.label])) { const d = PRESET_GROUPS[0].items.find((i) => i.name === c.name); return d ? buildPresetClip(d) : c; }
        (c.eyes || []).forEach((k) => { for (const f of ['e', 'eL', 'eR']) if (GONE[k[f]]) k[f] = GONE[k[f]]; });
        if (c.group !== '표정') (c.eyes || []).forEach((k) => { for (const f of ['e', 'eL', 'eR']) { if (k[f] === '웃는 눈') k[f] = '신난 눈'; else if (k[f] === '슬픈 눈') k[f] = '눈물 눈'; } });   // 기분 좋을 때 눈은 신난 눈, 슬퍼할 때 눈은 눈물 눈으로 통일 (표정 모음은 그대로)
        return c;
      });
      if (saved && !saved.steps) PRESET_GROUPS[0].items.filter((d) => d.group === '단계별' && !S.clips.some((c) => c.name === d.name)).forEach((d) => S.clips.push(buildPresetClip(d)));   // 저장돼 있던 작업에는 새로 생긴 단계별 동작을 뒤에 붙인다
      S.clip = Math.min(saved?.clip || 0, Math.max(S.clips.length - 1, 0));
      if (!S.clips.length) S.clips = [newClipData('새 클립')];
      S.time = 0;
      S.selKeys.clear();
      hist = []; hi = -1;
      select(S.nodes.get(S.boneIdx[1] ?? S.boneIdx[0]) || null);
      applyPose(0);
      refreshClipUI();
      snapshot(true);
      $('#fileName').textContent = name;
      resolve();
    }, reject);
  });
}

/* ───────────── 본 마커 ───────────── */
function buildMarkers() {
  markers.forEach((m) => scene.remove(m.mesh));
  if (boneLines) scene.remove(boneLines);
  markers = S.boneIdx.map((idx) => {
    const isTarget = nodeName(idx).includes('IK') || nodeName(idx).includes('타겟');
    const mat = new THREE.MeshBasicMaterial({ color: isTarget ? 0xffffff : 0x8a8174, depthTest: false, transparent: true, opacity: 0.95 });
    const mesh = new THREE.Mesh(markerGeo, mat);
    mesh.scale.setScalar(fitInfo.size * 0.012);
    mesh.renderOrder = 10;
    mesh.userData.idx = idx;
    scene.add(mesh);
    return { idx, mesh };
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S.boneIdx.length * 6), 3));
  boneLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x8a8174, depthTest: false, transparent: true, opacity: 0.8 }));
  boneLines.renderOrder = 9;
  boneLines.frustumCulled = false;
  scene.add(boneLines);
}

const _v = new THREE.Vector3();
function updateMarkers() {
  const show = $('#showBones').checked;
  const pos = boneLines.geometry.attributes.position;
  const boneSet = new Set(S.boneIdx);
  S.model.updateMatrixWorld(true);
  markers.forEach((m, k) => {
    const obj = S.nodes.get(m.idx);
    obj.getWorldPosition(m.mesh.position);
    m.mesh.visible = show;
    const sel = obj === S.sel;
    m.mesh.material.color.set(sel ? ACCENT : (/IK|타겟/.test(nodeName(m.idx)) ? 0xffffff : 0x8a8174));
    m.mesh.scale.setScalar(fitInfo.size * (sel ? 0.016 : 0.011));
    let p = obj.parent, parentBone = null;
    while (p) { if (S.idxOf.has(p) && boneSet.has(S.idxOf.get(p))) { parentBone = p; break; } p = p.parent; }
    const a = m.mesh.position;
    const b = parentBone ? parentBone.getWorldPosition(_v) : a;
    pos.setXYZ(k * 2, a.x, a.y, a.z);
    pos.setXYZ(k * 2 + 1, b.x, b.y, b.z);
  });
  pos.needsUpdate = true;
  boneLines.visible = show;
}

function applyOpacity() {
  const o = +$('#opacity').value;
  S.model?.traverse((c) => {
    if (!c.isMesh || c.userData.noOpacity) return;
    [].concat(c.material).forEach((m) => { m.transparent = o < 1; m.opacity = o; m.depthWrite = o >= 1; m.needsUpdate = true; });
  });
}

/* ───────────── 클립 / 키프레임 데이터 ───────────── */
const newClipData = (name, duration = 2, f = 30) => ({ name, duration, fps: f, tracks: {} });
const track = (idx, create = false) => {
  const c = curClip();
  if (!c.tracks[idx] && create) c.tracks[idx] = [];
  return c.tracks[idx];
};

function lerpArr(a, b, f) { return a.map((v, i) => v + (b[i] - v) * f); }
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
function slerpArr(a, b, f) { _qa.fromArray(a); _qb.fromArray(b); return _qa.slerp(_qb, f).toArray(); }

function sampleAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = keys.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
  const a = keys[lo], b = keys[hi];
  let f = (t - a.t) / (b.t - a.t);
  if (a.i === 'step') f = 0;
  else if (a.i === 'smooth') f = f * f * (3 - 2 * f);
  return { p: lerpArr(a.p, b.p, f), q: slerpArr(a.q, b.q, f), s: lerpArr(a.s, b.s, f) };
}

// 눈 키: clip.eyes = [{ t, e: 표정, gx, gy }] — 시간순이고, 다음 키 전까지 그 표정(칸 단위 시선)을 유지한다.
function eyeKeyAt(t) {
  let k = { e: '뜬 눈', gx: 0, gy: 0 };
  for (const x of curClip()?.eyes || []) { if (x.t <= t + 1e-6) k = x; else break; }
  return k;
}
function applyEyes(t) {
  if (!eyes) return;
  const k = eyeKeyAt(t);
  eyes.show(k.e, k.gx || 0, k.gy || 0, t, k.eL || '', k.eR || '');
  const sel = $('#eyeSel');
  if (document.activeElement !== sel && sel.value !== k.e) sel.value = k.e;
  eyeDock.setLabel(k);
}
// 눈 키를 만들거나 고친다. patch = { e } (양쪽, 눈별 선택은 지워짐) | { eL } | { eR } (그 눈만 따로, '' 이면 양쪽과 같게)
function setEyeKey(t, patch) {
  const clip = curClip(); clip.eyes ||= [];
  let ex = clip.eyes.find((x) => Math.abs(x.t - t) < EPS);
  if (!ex) { const cur = eyeKeyAt(t); ex = { t, e: cur.e, gx: 0, gy: 0 }; if (cur.eL) ex.eL = cur.eL; if (cur.eR) ex.eR = cur.eR; clip.eyes.push(ex); clip.eyes.sort((x, y) => x.t - y.t); }
  if ('e' in patch) { ex.e = patch.e; delete ex.eL; delete ex.eR; }
  for (const side of ['eL', 'eR']) if (side in patch) { if (patch[side]) ex[side] = patch[side]; else delete ex[side]; }
}

function applyPose(t) {
  const clip = curClip();
  applyEyes(t);
  for (const [idx, obj] of S.nodes) {
    const keys = clip?.tracks[idx];
    if (keys && keys.length) {
      const r = sampleAt(keys, t);
      obj.position.fromArray(r.p); obj.quaternion.fromArray(r.q); obj.scale.fromArray(r.s);
    } else {
      const r = S.rest.get(idx);
      obj.position.fromArray(r.p); obj.quaternion.fromArray(r.q); obj.scale.fromArray(r.s);
    }
  }
  if ($('#robotLimit').checked && !tc.dragging) limitToRobot();
  manualActive = false;                      // 재생·시간 이동이 자세를 정하면 손 조작은 끝난다
  if ($('#robotSpeed').checked && !exporting) RV.target = readJointAngles();   // 로봇 속도: 이 자세가 목표, 실제 모습은 아래 stepRobotView 가 따라간다
  refreshJointUI();
}

function upsertKey(idx, t, interp) {
  snapRobotView();                              // 로봇 속도로 늦게 따라가는 중이면 키에는 목표 자세가 들어가게 맞춘다
  const keys = track(idx, true);
  const obj = S.nodes.get(idx);
  let k = keys.find((x) => Math.abs(x.t - t) < EPS);
  if (!k) {
    k = { t, i: interp || lastInterp, p: [], q: [], s: [] };
    keys.push(k);
    keys.sort((a, b) => a.t - b.t);
  }
  k.p = obj.position.toArray(); k.q = obj.quaternion.toArray(); k.s = obj.scale.toArray();
  return k;
}
let lastInterp = 'linear';

function keyAt(idx, t) {
  return track(idx)?.find((k) => Math.abs(k.t - t) < EPS);
}

/* GLB 안의 기존 애니메이션 → 편집 가능한 클립 */
function importClips() {
  const { json } = S.glb;
  const near = (a, b) => a.some((v, i) => Math.abs(v - b[i]) > 1e-5);
  return (json.animations || []).map((anim, ai) => {
    const byNode = new Map();
    anim.channels.forEach((ch) => {
      const smp = anim.samplers[ch.sampler];
      const path = ch.target.path;
      if (!['translation', 'rotation', 'scale'].includes(path) || !S.nodes.has(ch.target.node)) return;
      if (!byNode.has(ch.target.node)) byNode.set(ch.target.node, {});
      const times = readAccessor(smp.input);
      const n = path === 'rotation' ? 4 : 3;
      const vals = readAccessor(smp.output);
      byNode.get(ch.target.node)[path] = { times, vals, n, step: smp.interpolation === 'STEP' };
    });
    const clip = newClipData(anim.name || `클립 ${ai + 1}`);
    let maxT = 0;
    byNode.forEach((chs, idx) => {
      const rest = S.rest.get(idx);
      const restOf = { translation: rest.p, rotation: rest.q, scale: rest.s };
      const all = Object.entries(chs);
      let src = all.filter(([, c]) => c.times.length > 2);
      if (!src.length) {
        const moved = all.some(([p, c]) => near(Array.from(c.vals.slice(0, c.n)), restOf[p]));
        if (!moved) return;
        src = all;
      }
      const ts = [...new Set(src.flatMap(([, c]) => Array.from(c.times)).map((t) => +t.toFixed(5)))].sort((a, b) => a - b);
      const sample = (path, t) => {
        const c = chs[path];
        if (!c) return restOf[path].slice();
        const { times, vals, n } = c;
        const get = (k) => Array.from(vals.slice(k * n, k * n + n));
        if (t <= times[0]) return get(0);
        if (t >= times[times.length - 1]) return get(times.length - 1);
        let k = 0; while (times[k + 1] < t) k++;
        if (c.step) return get(k);
        const f = (t - times[k]) / (times[k + 1] - times[k]);
        return path === 'rotation' ? slerpArr(get(k), get(k + 1), f) : lerpArr(get(k), get(k + 1), f);
      };
      clip.tracks[idx] = ts.map((t) => ({ t, i: 'linear', p: sample('translation', t), q: sample('rotation', t), s: sample('scale', t) }));
      maxT = Math.max(maxT, ts[ts.length - 1]);
    });
    clip.duration = Math.max(1, Math.ceil(maxT * 10) / 10);
    return clip;
  });
}

/* 헤드가 하부 폼 안으로 파고들지 않게 한다.
   하부 폼은 수직축 대칭이라, 반지름별 윗면 높이(프로파일)를 만들어 두고 헤드 외피(상판·쿠션·하부판)의 점들이
   그 아래로 파고드는 깊이를 잰다. 파고들면 헤드 각도를 가장 적게 바꿔서 빼내고,
   보정값은 키 사이에서 급하게 변하지 않도록 퍼뜨려 부드럽게 한다. 접힌 기본 자세(헤드가 폼에 얹힌 상태)는 기준으로 허용한다. */
let collisionCache = null;
function collisionData() {
  if (collisionCache?.model === S.model) return collisionCache;
  S.model.updateMatrixWorld(true);
  const shell = [], foam = [];
  const shellNames = ['새_헤드_하부판', '새_쿠션', '새_헤드_상판'];
  const sample = (o, max) => {
    const p = o.geometry.attributes.position, stride = Math.max(1, Math.floor(p.count / max)), pts = [];
    for (let i = 0; i < p.count; i += stride) pts.push(new THREE.Vector3().fromBufferAttribute(p, i));
    return pts;
  };
  let foamMesh = null;
  S.model.traverse((o) => {
    if (!o.isMesh) return;
    if (shellNames.includes(o.name)) shell.push({ mesh: o, pts: sample(o, 1500) });
    if (o.name === '새_하부_폼') foamMesh = o;
  });
  // 폼 윗면 프로파일 (1mm 단위 반지름)
  const box = new THREE.Box3().setFromObject(foamMesh, true), c = box.getCenter(new THREE.Vector3());
  const prof = new Float32Array(160).fill(-Infinity), v = new THREE.Vector3(), p = foamMesh.geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(foamMesh.matrixWorld);
    const r = Math.min(159, Math.floor(Math.hypot(v.x - c.x, v.z - c.z) * 1000));
    if (v.y > prof[r]) prof[r] = v.y;
  }
  return (collisionCache = { model: S.model, shell, prof, cx: c.x, cz: c.z });
}
const _hp = new THREE.Vector3();
function headPenetration() {
  const { shell, prof, cx, cz } = collisionData();
  S.model.updateMatrixWorld(true);
  let worst = 0;
  for (const { mesh, pts } of shell) for (const q of pts) {
    _hp.copy(q).applyMatrix4(mesh.matrixWorld);
    const r = Math.floor(Math.hypot(_hp.x - cx, _hp.z - cz) * 1000);
    if (r >= prof.length) continue;
    const pen = prof[r] - _hp.y;
    if (pen > worst) worst = pen;
  }
  return worst;
}
function clearHeadFromBody(keys, applyPose4) {
  for (const [i, o] of S.nodes) { const r = S.rest.get(i); o.position.fromArray(r.p); o.quaternion.fromArray(r.q); o.scale.fromArray(r.s); }
  const tol = headPenetration() + 0.0005;          // 기본 자세에서 이미 닿아 있는 만큼은 허용
  const fix = keys.map(([, a, b, c = 0, d = 0]) => {
    applyPose4(a, b, c, d);
    if (headPenetration() <= tol) return 0;
    for (let k = 1; k <= 40; k++) for (const sgn of [-1, 1]) {   // 가장 작은 보정부터, 같으면 고개를 드는(−) 쪽 먼저
      applyPose4(a, b + sgn * k, c, d);
      if (headPenetration() <= tol) return sgn * k;
    }
    return 0;
  });
  const n = fix.length, W = 3;
  const wide = fix.map((_, i) => { let best = 0; for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) if (Math.abs(fix[j]) > Math.abs(best)) best = fix[j]; return best; });
  const soft = wide.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) { s += wide[j]; c++; } return s / c; });
  (window.__headFix ||= []).push({ n, tol: +tol.toFixed(4), corrected: fix.filter((x) => x).length, maxFix: Math.max(0, ...fix.map(Math.abs)) });
  return keys.map(([, , b], i) => b + soft[i]);
}

/* 프리셋: [시간, 기둥°, 머리°, 갸웃°, 몸통°] 키 목록 → 클립 (기본 포즈 기준 상대 각도, IK_타겟은 머리 끝에 맞춰 계산) */
function buildPresetClip(def) {
  const clip = newClipData(def.name, def.duration);
  if (def.markers) clip.markers = def.markers;
  if (def.hold && def.markers) clip.holds = def.hold.map((h) => ({ t: def.markers[h.at].t, label: h.label || '숙이기', msg: h.msg || '', touch: !!h.touch, arm: !!h.arm }));   // 재생 중 여기서 멈추고 버튼을 눌러야 이어간다
  if (def.group) clip.group = def.group;
  if (def.parent) clip.parent = def.parent;                          // 단계별 동작이 속한 시나리오 이름 (시나리오 아래 하위항목으로 보여 줄 때 쓴다)
  if (def.hidden) clip.hidden = true;                                // 동작 목록에는 나오지 않는다(센서가 부르는 시나리오)
  if (def.noTail) clip.keepEnd = true;                               // 끝에서 원자세로 접지 않고 마지막 자세를 유지한다
  if (def.rev) clip.rev = def.rev;                                   // 프리셋 개정 번호 (저장된 예전 클립을 새 프리셋으로 바꾸는 데 쓴다)
  if (def.eyes) clip.eyes = def.eyes.map(([t, e, gx = 0, gy = 0]) => ({ t, e, gx, gy }));
  const ids = { col: S.boneIdx.find((i) => nodeName(i) === '기둥'), head: S.boneIdx.find((i) => nodeName(i) === '머리'), tilt: S.boneIdx.find((i) => /갸웃/.test(nodeName(i))) };
  let rootObj = S.nodes.get(ids.col);
  while (rootObj.parent && S.idxOf.has(rootObj.parent)) rootObj = rootObj.parent;
  ids.body = rootObj === S.nodes.get(ids.col) ? undefined : S.idxOf.get(rootObj);
  const target = IK?.target ? S.idxOf.get(IK.target) : undefined;
  const q = new THREE.Quaternion(), r = new THREE.Quaternion(), axisZ = new THREE.Vector3(0, 0, 1), axisY = new THREE.Vector3(0, 1, 0);
  const pose = (idx, deg, axis) => {
    const o = S.nodes.get(idx), rest = S.rest.get(idx);
    q.fromArray(rest.q).multiply(r.setFromAxisAngle(axis, deg * D2R));
    o.quaternion.copy(q); o.position.fromArray(rest.p); o.scale.fromArray(rest.s);
  };
  const snap = (idx) => { const o = S.nodes.get(idx); return { p: o.position.toArray(), q: o.quaternion.toArray(), s: o.scale.toArray() }; };
  const heads = clearHeadFromBody(def.keys, (a, b, c, d) => {
    pose(ids.col, a, axisZ); pose(ids.head, b, axisZ); if (ids.tilt !== undefined) pose(ids.tilt, c, axisY);
    if (ids.body !== undefined) pose(ids.body, d, axisY);
  });
  for (const [ki, [t, a, , c = 0, d = 0]] of def.keys.entries()) {
    const b = heads[ki];
    pose(ids.col, a, axisZ); pose(ids.head, b, axisZ); if (ids.tilt !== undefined) pose(ids.tilt, c, axisY);
    if (ids.body !== undefined) pose(ids.body, d, axisY);
    if (target !== undefined) { const o = S.nodes.get(target), rest = S.rest.get(target); o.quaternion.fromArray(rest.q); o.scale.fromArray(rest.s); syncTarget(); }
    for (const idx of [ids.col, ids.head, ids.tilt, ids.body, target]) {
      if (idx === undefined) continue;
      (clip.tracks[idx] ||= []).push({ t, i: def.interp || 'smooth', ...snap(idx) });
    }
  }
  return clip;
}

/* ───────────── 저장 / 실행취소 ───────────── */
const SAVE_VERSION = 20; // 저장 형식/기본 클립 구성이 바뀌면 올린다 (이전 자동 저장은 새 기본 클립으로 교체됨)
let hist = [], hi = -1;
const storeKey = () => `cove-anim:${S.glb.name}:${S.nodes.size}`;
function loadSaved() {
  try { const d = JSON.parse(localStorage.getItem(storeKey())); return d?.v === SAVE_VERSION ? d : null; } catch { return null; }
}
function snapshot(initial) {
  const str = JSON.stringify({ v: SAVE_VERSION, clips: S.clips, clip: S.clip, steps: 1 });   // steps: 단계별 동작을 이미 넣었다는 표시 (지운 걸 다시 되살리지 않게)
  if (hist[hi] === str) return;
  hist = hist.slice(0, hi + 1); hist.push(str);
  if (hist.length > 80) hist.shift();
  hi = hist.length - 1;
  try { localStorage.setItem(storeKey(), str); } catch { /* 용량 초과 등은 무시 */ }
  if (!initial) refreshAll();
}
function restoreSnap(str) {
  const d = JSON.parse(str);
  S.clips = d.clips; S.clip = d.clip; S.selKeys.clear();
  S.time = Math.min(S.time, curClip().duration);
  applyPose(S.time);
  refreshClipUI(); refreshAll();
  try { localStorage.setItem(storeKey(), str); } catch { /* */ }
}
const undo = () => { if (hi > 0) restoreSnap(hist[--hi]); };
const redo = () => { if (hi < hist.length - 1) restoreSnap(hist[++hi]); };

/* ───────────── 선택 / 편집 ───────────── */
function select(obj) {
  S.sel = obj;
  if (IK && obj === IK.target) setMode('translate');
  if (obj) tc.attach(obj); else tc.detach();
  buildTree(); refreshAll();
}

function onNodeEdited() {
  if (!S.sel) return;
  const ikOn = IK && $('#ikOn').checked;
  let keyed = [S.sel];
  if (ikOn && S.sel === IK.target) { solveIK(); keyed = [IK.target, IK.tip, IK.root]; }
  else if (ikOn && (S.sel === IK.tip || S.sel === IK.root)) { syncTarget(); keyed = [IK.target, IK.tip, IK.root]; }
  if (S.autoKey) keyed.forEach((o) => upsertKey(S.idxOf.get(o), S.time));
  updateProps(); drawTL();
}

/* ───────────── IK (IK_타겟 → 머리 끝, 기둥·머리 평면 2링크) ───────────── */
// glTF에는 IK 제약이 없어서, 구워진 모션에서 구조를 추정한다:
// 타겟이 항상 같은 본의 로컬 +Y 위치에 있으면 그 본이 체인 끝, 그 부모 본이 체인 뿌리.
// 구워진 모션에서 두 본은 로컬 Z축으로만 회전했으므로 Z축 회전만 푼다.
let IK = null;
function setupIK() {
  IK = null;
  const boneSet = new Set(S.boneIdx);
  const tIdx = S.boneIdx.find((i) => /IK|타겟/.test(nodeName(i)));
  if (tIdx === undefined) return;
  const target = S.nodes.get(tIdx);
  S.model.updateMatrixWorld(true);
  const tw = target.getWorldPosition(new THREE.Vector3());
  for (const i of S.boneIdx) {
    if (i === tIdx) continue;
    const tip = S.nodes.get(i);
    const local = tip.worldToLocal(tw.clone());
    if (Math.abs(local.x) > 1e-3 || Math.abs(local.z) > 1e-3 || local.y <= 0) continue;
    let root = tip.parent;
    while (root && !(S.idxOf.has(root) && boneSet.has(S.idxOf.get(root)))) root = root.parent;
    if (!root) continue;
    IK = { target, tip, root, offset: new THREE.Vector3(0, local.y, 0) };
    return;
  }
}

const _tw = new THREE.Vector3(), _tp = new THREE.Vector3(), _jt = new THREE.Vector3(), _jp = new THREE.Vector3();
function solveIK() {
  const { target, tip, root, offset } = IK;
  S.model.updateMatrixWorld(true);
  target.getWorldPosition(_tw);
  for (let it = 0; it < 40; it++) {
    for (const j of [tip, root]) {
      j.updateWorldMatrix(true, false);
      _tp.copy(offset); tip.localToWorld(_tp);
      _jp.copy(_tp); j.worldToLocal(_jp);
      _jt.copy(_tw); j.worldToLocal(_jt);
      let d = Math.atan2(_jt.y, _jt.x) - Math.atan2(_jp.y, _jp.x);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      j.rotateZ(d);
      S.model.updateMatrixWorld(true);
    }
    _tp.copy(offset); tip.localToWorld(_tp);
    if (_tp.distanceToSquared(_tw) < 1e-12) break;
  }
}
function syncTarget() {
  const { target, tip, offset } = IK;
  S.model.updateMatrixWorld(true);
  const w = tip.localToWorld(offset.clone());
  target.parent.updateWorldMatrix(true, false);
  target.position.copy(target.parent.worldToLocal(w));
}

function insertKeys(all) {
  const idxs = all ? S.boneIdx : (S.sel ? [S.idxOf.get(S.sel)] : []);
  idxs.forEach((i) => upsertKey(i, S.time));
  snapshot();
}

function deleteKeys() {
  const c = curClip();
  if (!S.selKeys.size && S.sel) {
    const k = keyAt(S.idxOf.get(S.sel), S.time);
    if (k) S.selKeys.add(k);
    else if (c.eyes?.some((x) => Math.abs(x.t - S.time) < EPS)) { c.eyes = c.eyes.filter((x) => Math.abs(x.t - S.time) >= EPS); applyEyes(S.time); snapshot(); return; }
  }
  for (const idx in c.tracks) c.tracks[idx] = c.tracks[idx].filter((k) => !S.selKeys.has(k));
  S.selKeys.clear();
  applyPose(S.time);
  snapshot();
}

function resetPose() {
  if (!S.sel) return;
  const r = S.rest.get(S.idxOf.get(S.sel));
  S.sel.position.fromArray(r.p); S.sel.quaternion.fromArray(r.q); S.sel.scale.fromArray(r.s);
  onNodeEdited();
  snapshot();
}

function copyKeys() {
  if (!S.selKeys.size) return;
  const c = curClip(), items = [];
  for (const idx in c.tracks) c.tracks[idx].forEach((k) => S.selKeys.has(k) && items.push({ idx, k: JSON.parse(JSON.stringify(k)) }));
  const t0 = Math.min(...items.map((x) => x.k.t));
  S.copied = items.map((x) => ({ idx: x.idx, k: { ...x.k, t: x.k.t - t0 } }));
  toast(`키 ${items.length}개 복사`);
}
function pasteKeys() {
  if (!S.copied) return;
  const c = curClip();
  S.selKeys.clear();
  S.copied.forEach(({ idx, k }) => {
    const keys = c.tracks[idx] || (c.tracks[idx] = []);
    const t = +(S.time + k.t).toFixed(5);
    const ex = keys.findIndex((x) => Math.abs(x.t - t) < EPS);
    if (ex >= 0) keys.splice(ex, 1);
    const nk = { ...JSON.parse(JSON.stringify(k)), t };
    keys.push(nk); keys.sort((a, b) => a.t - b.t);
    S.selKeys.add(nk);
  });
  applyPose(S.time);
  snapshot();
}

/* ───────────── 재생 ───────────── */
function setTime(t, snap = true) {
  const c = curClip();
  t = Math.max(0, Math.min(c.duration, t));
  if (snap) t = Math.round(t * c.fps) / c.fps;
  S.time = t;
  S.released = new Set([...S.released].filter((x) => x <= t + 1e-6));            // 멈춤 지점 앞으로 돌아가면 다시 멈추게
  if (S.heldAt != null && Math.abs(t - S.heldAt) > 1e-6) { S.heldAt = null; refreshHoldUI(); }
  applyPose(t);
  updateProps(); updateTimeLabel(); drawTL();
}
let homeTimer = 0, playStartedAt = 0;
/* 멈춤 지점(휴식에서 머리를 숙이기 직전): 재생이 거기서 멈추고 [숙이기]를 눌러야 이어진다. 로봇 동기 중에는 멈춤 지점 너머의 자세를 미리 보내지 않는다. */
S.released = new Set(); S.heldAt = null;
const nextHold = (t = S.time) => (curClip()?.holds || []).filter((h) => !S.released.has(h.t) && h.t > t - 1e-6).sort((a, b) => a.t - b.t)[0] || null;
let holdKey = '';
const HEAD_UP = -42;                                              // 머리 들기 목표 (도). 음수 = 얼굴이 위, 허용 범위 -46 ~ 0
function refreshHeadBar() {                                       // 머리 들기·숙이기 버튼은 어느 클립에서나 보인다
  $('#headBar').hidden = false;
}
function refreshHoldUI() {
  refreshHeadBar();                                       // 뷰포트 왼쪽 위의 초록 버튼: 멈춰서 기다리는 그 상황에만, 그 단계의 버튼 하나만 나온다
  const bar = $('#holdBar'); if (!bar) return;
  const holds = curClip()?.holds || [];
  const waiting = S.heldAt != null ? holds.find((h) => Math.abs(h.t - S.heldAt) < 1e-6) : null;
  if (!waiting) { bar.hidden = true; return; }
  const key = `${S.clip}|${waiting.t}|${waiting.label}`;
  if (key !== holdKey) {
    holdKey = key; bar.innerHTML = '';
    const row = document.createElement('div'); row.className = 'hold-item wait';
    row.innerHTML = '<div class="hold-cue"></div><button class="hold-btn"></button><span class="hold-msg"></span>';
    row.querySelector('.hold-cue').textContent = waiting.touch ? '머리를 만져 주세요' : waiting.arm ? '1번 거리센서(머리 아래)에 손을 넣어 주세요' : '';   // 센서로 넘기는 단계는 뷰포트에 큰 안내를 띄운다
    row.querySelector('.hold-cue').hidden = !(waiting.touch || waiting.arm);
    row.querySelector('button').textContent = waiting.label; row.querySelector('.hold-msg').textContent = waiting.msg || '준비되면 눌러 주세요.';
    row.querySelector('button').onclick = releaseHold;
    bar.appendChild(row);
  }
  bar.hidden = false;
}
function releaseHold() {
  if (S.heldAt == null) return;
  S.released.add(S.heldAt); S.heldAt = null; refreshHoldUI();
  if (!S.playing) togglePlay();                                   // 이어서 재생 (로봇 동기 중이면 로봇도 이어서 따라 한다)
}

const cancelHome = () => { clearTimeout(homeTimer); homeTimer = 0; };
// 동기 중에 웹 재생이 끝나거나 멈추면 로봇이 갑자기 서지 않고 원자세(home 씬)로 돌아온다.
// 로봇은 마지막 pose 뒤 2초가 지나야 실시간 조작을 끝내고(조작 중에는 씬이 중단됨) 그 자세를 유지하므로, 그 뒤에 보낸다.
function scheduleHome() {
  cancelHome();
  homeTimer = setTimeout(() => {
    homeTimer = 0;
    if (!robot.sync || S.playing || manualActive) return;            // 그 사이 다시 재생·조작하거나 동기를 껐으면 보내지 않는다
    if (robot.run('home') === 'ok') toast('로봇이 원자세로 돌아가요');
  }, 2300);
}
function stopPlay() {
  const was = S.playing;
  S.playing = false; $('#tPlay').textContent = '▶'; updateProps();
  if (was && robot.connected) {
    if (robot.current) robot.hold();                                 // 로봇이 씬을 재생 중이면 바로 정지
    else if (robot.sync && !curClip()?.keepEnd) scheduleHome();      // 동기 중이면 원자세로 (끝 자세를 유지하는 동작은 제외)
  }
}
function togglePlay() {
  if (S.playing) return stopPlay();
  if (S.heldAt != null) { S.released.add(S.heldAt); S.heldAt = null; refreshHoldUI(); }
  if (S.time >= curClip().duration - EPS) { S.time = 0; S.released.clear(); }   // 끝까지 본 뒤 다시 재생하면 멈춤 지점도 처음부터 다시 걸린다
  cancelHome();
  playStartedAt = performance.now();
  S.playing = true; $('#tPlay').textContent = '❚❚'; updateProps();
}
let lastT = performance.now();
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  if (S.playing) {
    const c = curClip();
    const prevT = S.time;
    S.time += dt;
    const hp = S.sceneLoop ? null : nextHold(prevT);                    // 한 장면만 반복해서 볼 때는 멈추지 않는다
    if (hp && prevT < hp.t - 1e-6 && S.time >= hp.t - 1e-6) {          // 멈춤 지점에 닿으면 정확히 거기서 멈춘다 (로봇은 원자세로 돌아가지 않고 그 자세를 유지)
      S.time = hp.t; S.playing = false; $('#tPlay').textContent = '▶'; S.heldAt = hp.t; S.heldSince = performance.now(); refreshHoldUI(); applyPose(S.time); updateProps(); updateTimeLabel(); drawTL();
      toast(`'${hp.label}' 버튼을 누르면 이어서 움직여요`);
    } else
    if (S.sceneLoop && c.markers?.length) {            // 장면 하나만 볼 때: 그 장면의 끝에서 멈춘다 (되돌아가서 반복하지 않는다)
      const [, b0] = sceneRange(sceneIndex(S.time - dt));
      if (S.time >= b0 - 1e-6) { S.time = b0; applyPose(S.time); updateProps(); updateTimeLabel(); drawTL(); stopPlay(); }
    }
    if (S.time >= c.duration) {
      if (S.loop) { S.time %= c.duration; S.released.clear(); } else { S.time = c.duration; stopPlay(); }
    }
    applyPose(S.time); updateProps(); updateTimeLabel(); drawTL();
  }
  stepRobotView(dt);
  if (S.model) updateMarkers();
  orbit.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

/* ───────────── UI: 트리 / 속성 / 클립 ───────────── */
function buildTree() {
  if (!S.model) return;
  const el = $('#tree'); el.innerHTML = '';
  const boneSet = new Set(S.boneIdx), show = new Set();
  S.boneIdx.forEach((i) => { let o = S.nodes.get(i); while (o) { if (S.idxOf.has(o)) show.add(o); o = o.parent; } });
  const clip = curClip();
  const walk = (o, depth) => {
    let d = depth;
    if (S.idxOf.has(o) && (S.showAll || show.has(o))) {
      const idx = S.idxOf.get(o);
      const row = document.createElement('div');
      const n = clip?.tracks[idx]?.length || 0;
      row.className = 'node' + (boneSet.has(idx) ? ' bone' : '') + (o.isMesh ? ' mesh' : '') + (o === S.sel ? ' sel' : '') + (n ? ' haskeys' : '');
      row.style.paddingLeft = 6 + depth * 14 + 'px';
      row.innerHTML = `<span class="dot"></span><span></span><span class="badge">${n ? n + '키' : ''}</span>`;
      row.children[1].textContent = nodeName(idx);
      row.onclick = () => select(o);
      el.appendChild(row);
      d = depth + 1;
    }
    o.children.forEach((c) => walk(c, d));
  };
  S.model.children.forEach((c) => walk(c, 0));
}

const P = (id) => $('#' + id);
function updateProps() {
  const o = S.sel;
  $('#selName').textContent = o ? nodeName(S.idxOf.get(o)) : '-';
  if (!o) { $('#keyState').textContent = '-'; return; }
  const set = (id, v) => { const el = P(id); if (document.activeElement !== el) el.value = +v.toFixed(4); };
  set('px', o.position.x); set('py', o.position.y); set('pz', o.position.z);
  set('rx', o.rotation.x / D2R); set('ry', o.rotation.y / D2R); set('rz', o.rotation.z / D2R);
  set('sx', o.scale.x); set('sy', o.scale.y); set('sz', o.scale.z);
  const idx = S.idxOf.get(o), keys = track(idx), ks = $('#keyState');
  if (S.playing) { const n = keys?.length || 0; ks.textContent = n ? `▶ 재생 중 (키 ${n}개)` : '▶ 재생 중'; ks.style.color = 'var(--dim)'; }   // 재생 중에는 키 위/사이 상태가 프레임마다 바뀌어 깜빡이므로 고정 문구
  else if (keys && keyAt(idx, S.time)) { ks.textContent = '◆ 현재 프레임에 키 있음'; ks.style.color = 'var(--text)'; }
  else if (keys && keys.length) { ks.textContent = '◇ 보간 중 (키 ' + keys.length + '개)'; ks.style.color = 'var(--dim)'; }
  else { ks.textContent = '키 없음 — 기본 포즈'; ks.style.color = 'var(--dim)'; }
  const kp = $('#keyProps');
  kp.hidden = !S.selKeys.size;
  if (S.selKeys.size) {
    $('#keyCount').textContent = `(${S.selKeys.size}개)`;
    const first = [...S.selKeys][0];
    if (document.activeElement !== $('#keyInterp')) $('#keyInterp').value = first.i;
  }
}
['px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'].forEach((id) => {
  P(id).addEventListener('input', () => {
    const o = S.sel; if (!o) return;
    const v = (k) => parseFloat(P(k).value) || 0;
    o.position.set(v('px'), v('py'), v('pz'));
    o.rotation.set(v('rx') * D2R, v('ry') * D2R, v('rz') * D2R, 'XYZ');
    o.scale.set(v('sx'), v('sy'), v('sz'));
    onNodeEdited();
  });
  P(id).addEventListener('change', () => snapshot());
});

function refreshClipUI() {
  const sel = $('#clipSel');
  sel.innerHTML = '';
  S.clips.forEach((c, i) => sel.add(new Option(c.name, i)));
  sel.value = S.clip;
  renderClipList();
  { const m = curClip().name.match(/^시나리오(\d+)\s*(.*)$/); $('#clipHead .cur').textContent = m ? `${m[1].padStart(2, '0')} ${m[2]}` : curClip().name; }
  $('#clipDur').value = curClip().duration;
  $('#clipFps').value = curClip().fps;
  refreshAll();
}
/* 동작 목록: 시나리오를 한눈에 보이는 목록으로 (select는 숨겨 두고 값만 동기화).
   로봇이 연결되어 있으면 각 동작 오른쪽의 ▶로 같은 동작의 로봇 씬을 바로 실행하고,
   선택한 동작 아래에는 그 동작에 묶인 로봇 씬(전체 · 장면별 · 관련)이 펼쳐진다. */
const rbOpen = new Set();                                  // 펼쳐 둔 "로봇 전용" 묶음
function runOnRobot(name) {
  const r = robot.run(name);
  if (r === 'unsafe') toast('연결 창에서 "로봇 주변을 확인했어요"를 체크하면 실행돼요');
  else if (r === 'offline') toast('먼저 로봇을 연결해 주세요');
  return r;
}
function sceneChip(name, label) {
  const b = document.createElement('button'); b.className = 'rbc' + (robot.current === name ? ' run' : '');
  b.textContent = label || name; b.title = `로봇에서 씬 "${name}" 실행`;
  b.onclick = (e) => { e.stopPropagation(); runOnRobot(name); };
  return b;
}
function robotBlock(link, clipIdx) {
  const box = document.createElement('div'); box.className = 'rb-block';
  if (!robot.connected) {
    const p = document.createElement('div'); p.className = 'rb-hint'; p.textContent = '실제 로봇에서도 이 동작을 실행할 수 있어요';
    const b = document.createElement('button'); b.className = 'rbc'; b.textContent = '로봇 연결'; b.onclick = (e) => { e.stopPropagation(); robot.openPanel(); };
    box.append(p, b); return box;
  }
  const l = restrictTo(link, robot.scenes), web = webSceneName(S.clips[clipIdx].name, clipIdx);
  const row = (title, nodes) => {
    if (!nodes.length) return;
    const r = document.createElement('div'); r.className = 'rb-row';
    const t = document.createElement('span'); t.className = 'rb-t'; t.textContent = title;
    const c = document.createElement('div'); c.className = 'rb-c'; c.append(...nodes); r.append(t, c); box.appendChild(r);
  };
  const top = [];
  if (robot.scenes.includes(web)) { const b = sceneChip(web, '▶ 웹과 같은 모션'); b.classList.add('main'); b.title = '뷰포트에 보이는 동작 그대로 (웹에서 만든 모션 파일)'; top.push(b); }
  // '▶ 로봇 기본 씬' 버튼은 숨겼다 (웹과 따로 도는 로봇 안의 씬이라서). 되살리려면 l.main 으로 sceneChip()을 top에 넣는다
  row('로봇', top);
  // 장면별·관련 로봇 씬 줄은 숨겼다 (웹 전체 재생과 따로 도는 씬이라 헷갈려서). 되살리려면 l.steps / l.more 로 row()를 다시 부른다
  if (!box.children.length) { box.className = 'rb-block'; box.textContent = '이 로봇에는 연결된 씬이 아직 없어요'; box.classList.add('rb-hint'); }
  return box;
}
// 단계별 동작이 어느 시나리오의 단계인지: 클립에 적어 둔 parent, 없으면(예전에 저장된 것) 그 동작의 첫 장면 이름으로 프리셋에서 찾는다 (동작 이름은 바꿔도 장면 이름은 그대로라서)
const stepParent = new Map(PRESET_GROUPS[0].items.filter((d) => d.group === '단계별').map((d) => [d.markers[0].label, d.parent]));
const parentOf = (c) => c.parent || stepParent.get(c.markers?.[0]?.label) || null;
const scenarioTitle = (c) => c.name.replace(/^시나리오\d+\s*/, '');
// 표정 고르는 작은 창: 고른 표정으로 그 동작의 눈을 통째로 바꾼다 (전에 있던 눈 키는 대체된다, Ctrl+Z로 되돌릴 수 있다)
const stepOrigDef = (c) => PRESET_GROUPS[0].items.find((d) => d.group === '단계별' && d.parent === parentOf(c) && d.markers[0].label === c.markers?.[0]?.label);   // 단계별 동작의 처음(프리셋) 정의
const origEyes = (d) => d.eyes.map(([t, e, gx = 0, gy = 0]) => ({ t, e, gx, gy }));
let eyePicker = null;
function closeEyePicker() { eyePicker?.remove(); eyePicker = null; }
function openEyePicker(anchor, i) {
  closeEyePicker();
  const box = document.createElement('div'); box.className = 'eye-picker';
  const title = document.createElement('div'); title.className = 'ep-t'; title.textContent = '표정 고르기 · 이 동작의 눈을 바꿔요'; box.appendChild(title);
  const origDef = stepOrigDef(S.clips[i]);                                // 이 동작의 처음(프리셋) 눈
  const finish = (name, what) => {
    const playingNow = S.playing, other = S.clip !== i;
    if (other) { const sl = $('#clipSel'); sl.value = String(i); sl.dispatchEvent(new Event('change')); }   // 다른 동작의 버튼이면 그 동작으로 옮겨 간다
    syncEye = '';                                                         // 재생 중이면 다음 0.1초에 로봇 눈도 새 표정으로 다시 보낸다
    applyEyes(S.time); if (!playingNow && name) eyes?.show(name);          // 뷰포트 눈을 지금 바로 바꾼다 (재생 중이면 재생이 이어서 새 표정을 보인다)
    if (robot.connected && !playingNow) robot.eyes(name || eyeKeyAt(S.time).e);   // 재생 중이 아니면 연결된 로봇의 눈도 바로 바꾼다
    if (playingNow && other) playAll();                                    // 재생 중에 다른 동작의 버튼을 눌렀으면 그 동작을 처음부터 이어서 재생한다
    snapshot(); renderClipList(); closeEyePicker();
    toast(`'${S.clips[i].name}'의 표정을 ${what}`);
  };
  if (origDef) {                                                         // 처음 표정으로 되돌리기 (눈이 여러 번 바뀌던 것도 처음 그대로)
    const rb = document.createElement('button'); rb.className = 'ep-reset'; rb.textContent = '↺ 처음 표정으로 되돌리기';
    rb.title = `처음 눈: ${[...new Set(origDef.eyes.map((x) => x[1]))].join(' → ')}`;
    rb.onclick = (e) => { e.stopPropagation(); S.clips[i].eyes = origEyes(origDef); finish(origDef.eyes[0]?.[1], '처음 표정으로 되돌렸어요'); };
    box.appendChild(rb);
  }
  const grid = document.createElement('div'); grid.className = 'ep-g'; box.appendChild(grid);
  EXPRESSIONS.forEach((name) => {
    const b = document.createElement('button'); b.className = 'ep-i' + (S.clips[i].eyes?.[0]?.e === name && S.clips[i].eyes.length === 1 ? ' on' : '');
    const cv = document.createElement('canvas'); cv.width = cv.height = 48; drawPattern(cv, eyeRows(name, 0, 0));
    const l = document.createElement('span'); l.textContent = name; b.append(cv, l);
    b.onclick = (e) => { e.stopPropagation(); S.clips[i].eyes = [{ t: 0, e: name, gx: 0, gy: 0 }]; finish(name, `'${name}'으로 바꿨어요`); };
    grid.appendChild(b);
  });
  document.body.appendChild(box); eyePicker = box;
  const r = anchor.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
  box.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4) + 'px';
}
addEventListener('pointerdown', (e) => { if (eyePicker && !eyePicker.contains(e.target) && !e.target.closest?.('.eye-pick')) closeEyePicker(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEyePicker(); }, true);
let dragStep = -1;                                                    // 끌고 있는 단계별 동작의 번호
function clipRowEl(c, i, sub) {
  const sel = $('#clipSel');
  const wrap = document.createElement('div'); wrap.className = 'clip-row' + (sub ? ' sub' : '');
  const el = document.createElement('button');
  el.className = 'clip-item' + (i === S.clip ? ' on' : ''); el.dataset.i = i;
  const m = c.name.match(/^시나리오(\d+)\s*(.*)$/);                      // "시나리오1 휴식" → 번호 01 + 제목 "휴식"
  el.innerHTML = '<span class="no"></span><span class="nm"></span><span class="du"></span>';
  el.children[0].textContent = m ? m[1].padStart(2, '0') : '';
  el.children[1].textContent = m ? m[2] : c.name;
  el.children[2].textContent = `${+c.duration.toFixed(1)}초`;
  if (c.group === '단계별') {                                          // 시간(초) 왼쪽에 지금 표정을 보여 주는 버튼: 누르면 표정을 골라 이 동작의 눈을 바꾼다
    const cur = c.eyes?.[0]?.e || '뜬 눈', eb = document.createElement('span');
    eb.className = 'eye-pick'; eb.setAttribute('role', 'button'); eb.tabIndex = 0; eb.title = `표정 바꾸기 (지금: ${cur}${c.eyes?.length > 1 ? ' 외 ' + (c.eyes.length - 1) + '개' : ''})`;
    const cv = document.createElement('canvas'); cv.width = cv.height = 48; drawPattern(cv, eyeRows(cur, 0, 0)); eb.appendChild(cv);
    eb.onclick = (e) => { e.stopPropagation(); openEyePicker(eb, i); };
    eb.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openEyePicker(eb, i); } };
    el.insertBefore(eb, el.children[2]); el.classList.add('has-eye');
  }
  el.onclick = () => { sel.value = i; sel.dispatchEvent(new Event('change')); if (c.group === '단계별') playAll(); };   // 단계별 동작은 누르는 바로 처음부터 재생한다
  el.ondblclick = () => startRename(i, el);
  wrap.appendChild(el);
  if (c.group === '단계별' && !sub) {                                  // 단계별 줄은 잡아서 다른 칸(표정만 / 동작만 / 표정 + 동작)으로 끌어 옮길 수 있다
    wrap.draggable = true;
    wrap.ondragstart = (e) => { dragStep = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.name); wrap.classList.add('dragging'); };
    wrap.ondragend = () => { dragStep = -1; wrap.classList.remove('dragging'); document.querySelectorAll('#clipList .cat.over').forEach((x) => x.classList.remove('over')); };
  }
  if (c.group === '단계별') {                                          // 단계별 동작은 줄마다 이름 바꾸기(✎)·지우기(×)를 둔다
    const ed = document.createElement('button'); ed.className = 'rb ed'; ed.textContent = '✎'; ed.title = '이름 바꾸기 (더블클릭도 가능)';
    ed.onclick = () => startRename(i, el);
    const del = document.createElement('button'); del.className = 'rb ed'; del.textContent = '×'; del.title = '이 동작 지우기 (Ctrl+Z로 되돌릴 수 있어요)';
    del.onclick = () => deleteClipAt(i);
    wrap.append(ed, del);
  }
  const link = linkFor(c.name), main = link && robot.connected && restrictTo(link, robot.scenes).main;
  if (main) {
    const rb = document.createElement('button'); rb.className = 'rb' + (robot.current === main ? ' run' : ''); rb.textContent = '▶';
    rb.title = `로봇에서 "${main}" 실행`;
    rb.onclick = () => { if (runOnRobot(main) === 'ok' && i !== S.clip) { sel.value = i; sel.dispatchEvent(new Event('change')); } };
    wrap.appendChild(rb);
  }
  return wrap;
}
// 단계별 동작이 표정만 바뀌는지, 몸(기둥·머리·갸웃·몸통)만 움직이는지, 둘 다인지 가른다. 몸은 어느 관절이든 각도가 10° 넘게 달라지면 움직이는 것으로, 표정은 그 안에서 서로 다른 눈이 두 가지 이상 나오면 바뀌는 것으로 본다
const STEP_KINDS = ['표정만', '동작만', '표정 + 동작'];
function stepKind(c) {
  if (c.kind) return c.kind;                                           // 직접 끌어다 옮겨 둔 곳이 있으면 그대로
  const ids = jointIds(), N = Math.max(4, Math.ceil(c.duration / 0.25));
  let moves = false;
  for (const j of ['neck', 'head', 'tilt', 'body']) {
    let lo = Infinity, hi = -Infinity;
    for (let n = 0; n <= N; n++) { const v = jointDeg(c, ids[j], JOINT_AXES[j], c.duration * n / N); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (hi - lo > 10) { moves = true; break; }
  }
  const face = new Set((c.eyes || []).flatMap((k) => [k.e, k.eL, k.eR]).filter(Boolean)).size > 1;
  return face && moves ? '표정 + 동작' : face ? '표정만' : moves ? '동작만' : '둘 다 거의 없음';
}
let subFolded = new Set(); try { subFolded = new Set(JSON.parse(localStorage.getItem('cove-sub-fold') || '[]')); } catch { /* 무시 */ }   // 접어 둔 시나리오(하위 단계 동작)
let stepsFolded = false; try { stepsFolded = localStorage.getItem('cove-steps-fold') === '1'; } catch { /* 무시 */ }
function renderClipList() {
  const list = $('#clipList');
  list.innerHTML = '';
  let lastGroup = null, stepsDone = false;
  S.clips.forEach((c, i) => {
    if (c.hidden) return;                                               // 센서 전용 시나리오는 목록에 보이지 않는다
    const g = c.group || (c.markers?.length ? '시나리오' : '내 클립');
    if (g !== lastGroup) {
      lastGroup = g; const h = document.createElement('div'); h.className = 'grp'; list.appendChild(h);
      if (g === '단계별') {                                               // 단계별 묶음은 제목을 눌러 접고 펼친다 (상태를 기억한다)
        h.classList.add('fold'); h.setAttribute('role', 'button'); h.title = '눌러서 접기/펼치기';
        h.textContent = `${stepsFolded ? '▸' : '▾'} ${g}`;
        h.onclick = () => { stepsFolded = !stepsFolded; try { localStorage.setItem('cove-steps-fold', stepsFolded ? '1' : '0'); } catch { /* 무시 */ } renderClipList(); };
      } else h.textContent = g;
    }
    if (g === '단계별') {
      if (stepsFolded || stepsDone) return;
      stepsDone = true;                                                 // 단계별 동작은 한 번에 종류별로 나눠 그린다 (표정만 / 동작만 / 표정+동작)
      const cats = { '표정만': [], '동작만': [], '표정 + 동작': [], '둘 다 거의 없음': [] };
      S.clips.forEach((k, j) => { if (k.group === '단계별') (cats[stepKind(k)] ||= []).push([k, j]); });
      Object.entries(cats).forEach(([label, items]) => {
        if (!items.length && !STEP_KINDS.includes(label)) return;       // 세 칸은 비어 있어도 보여 줘서 끌어다 놓을 수 있다
        const box = document.createElement('div'); box.className = 'cat'; box.dataset.kind = label;
        const sh = document.createElement('div'); sh.className = 'grp sub-grp'; sh.textContent = `${label} · ${items.length}`; box.appendChild(sh);
        items.forEach(([k, j]) => box.appendChild(clipRowEl(k, j)));
        if (!items.length) { const em = document.createElement('div'); em.className = 'cat-empty'; em.textContent = '여기로 끌어다 놓아요'; box.appendChild(em); }
        box.ondragover = (e) => { if (dragStep < 0) return; e.preventDefault(); box.classList.add('over'); };
        box.ondragleave = (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('over'); };
        box.ondrop = (e) => {                                            // 끌어 온 동작을 이 칸으로 옮긴다
          e.preventDefault(); box.classList.remove('over');
          const n = dragStep; dragStep = -1;
          if (n < 0 || !S.clips[n] || stepKind(S.clips[n]) === label) return;
          S.clips[n].kind = label; snapshot(); renderClipList(); toast(`'${S.clips[n].name}'을(를) '${label}'으로 옮겼어요`);
        };
        list.appendChild(box);
      });
      return;
    }
    const rowEl = clipRowEl(c, i); list.appendChild(rowEl);
    if (g === '시나리오') {                                             // 각 시나리오 아래에 그 단계 동작이 하위항목으로 항상 펼쳐져 있다. 줄의 ▾를 눌러 접을 수 있다
      const title = scenarioTitle(c), kids = S.clips.map((k, j) => [k, j]).filter(([k]) => k.group === '단계별' && parentOf(k) === title);
      if (kids.length) {
        const folded = subFolded.has(title), cb = document.createElement('button'); cb.className = 'rb fold'; cb.textContent = folded ? '▸' : '▾'; cb.title = folded ? '단계 동작 펼치기' : '단계 동작 접기';
        cb.onclick = () => { if (folded) subFolded.delete(title); else subFolded.add(title); try { localStorage.setItem('cove-sub-fold', JSON.stringify([...subFolded])); } catch { /* 무시 */ } renderClipList(); };
        rowEl.insertBefore(cb, rowEl.children[1]);
        const rs = document.createElement('button'); rs.className = 'rb reset-eyes'; rs.textContent = '↺'; rs.title = `'${title}' 단계 동작의 표정을 모두 처음대로 되돌리기 (Ctrl+Z로 되돌릴 수 있어요)`;
        rs.onclick = (e) => {
          e.stopPropagation(); let n = 0;
          kids.forEach(([k]) => { const d = stepOrigDef(k); if (d) { k.eyes = origEyes(d); n++; } });
          if (!n) return toast('되돌릴 단계 동작이 없어요');
          syncEye = ''; applyEyes(S.time); snapshot(); renderClipList(); toast(`'${title}' 단계 ${n}개의 표정을 처음대로 되돌렸어요`);
        };
        rowEl.insertBefore(rs, rowEl.children[2]);
        if (!folded) kids.forEach(([k, j]) => list.appendChild(clipRowEl(k, j, true)));
      }
    }
    // 선택한 동작 아래의 로봇 씬 묶음(▶ 웹과 같은 모션 등)은 숨겼다. 되살리려면 if (i === S.clip && linkFor(c.name)) list.appendChild(robotBlock(linkFor(c.name), i));
  });
  // '로봇 전용' 묶음(로봇 안의 씬 버튼들)은 없앴다. 시나리오의 단계를 동작으로 쪼갠 '단계별' 묶음은 아래에 그대로 있고, 위 시나리오 밑에도 하위항목으로 보인다
}
robot.onChange(() => { if (!document.querySelector('#clipList input.rename')) renderClipList(); const cb = $('#jtRobot'); if (cb) cb.checked = robot.sync; });
/* ───────────── 로봇용 내보내기 (뷰포트에 보이는 각도 그대로) ───────────── */
const JOINT_AXES = { neck: new THREE.Vector3(0, 0, 1), head: new THREE.Vector3(0, 0, 1), tilt: new THREE.Vector3(0, 1, 0), body: new THREE.Vector3(0, 1, 0) };
function jointIds() {
  const col = S.boneIdx.find((i) => nodeName(i) === '기둥'), head = S.boneIdx.find((i) => nodeName(i) === '머리'), tilt = S.boneIdx.find((i) => /갸웃/.test(nodeName(i)));
  let root = S.nodes.get(col);
  while (root.parent && S.idxOf.has(root.parent)) root = root.parent;
  return { neck: col, head, tilt, body: root === S.nodes.get(col) ? undefined : S.idxOf.get(root) };
}
function jointDeg(clip, idx, axis, t) {                       // 쉬는 자세 대비 회전각(도)
  if (idx === undefined) return 0;
  const rest = S.rest.get(idx), keys = clip.tracks[idx];
  const qc = new THREE.Quaternion().fromArray(keys?.length ? sampleAt(keys, t).q : rest.q);
  const qr = new THREE.Quaternion().fromArray(rest.q).invert().multiply(qc);
  let a = 2 * Math.atan2(axis.x * qr.x + axis.y * qr.y + axis.z * qr.z, qr.w);
  if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
  return a / D2R;
}
/* [로봇 속도] 켜져 있으면 뷰포트의 네 관절이 로봇처럼 움직인다: 목표 자세(재생 중인 동작)를 최대 속도·가속도와 0.15초 지연으로 따라간다.
   값은 엔지니어 답변서 기준(관절 약 206°/s · 215°/s², 몸통 약 79°/s · 83°/s²). 키 값과 내보내기에는 영향이 없다. */
const RV = { cur: null, vel: { neck: 0, head: 0, tilt: 0, body: 0 }, target: null };
const RV_VMAX = { neck: 206, head: 206, tilt: 206, body: 79 }, RV_AMAX = { neck: 215, head: 215, tilt: 215, body: 83 }, RV_TAU = 0.15;
function writeJoints(vals) {
  const ids = jtIds();
  for (const j of ['neck', 'head', 'tilt', 'body']) {
    if (ids[j] === undefined) continue;
    S.nodes.get(ids[j]).quaternion.fromArray(S.rest.get(ids[j]).q).multiply(new THREE.Quaternion().setFromAxisAngle(JOINT_AXES[j], vals[j] * D2R));
  }
  try { if (IK) syncTarget(); } catch { /* 무시 */ }
}
function snapRobotView() {
  if (!RV.cur || !RV.target) return;
  writeJoints(RV.target); RV.cur = { ...RV.target }; RV.vel = { neck: 0, head: 0, tilt: 0, body: 0 };
}
function stepRobotView(dt) {
  const on = $('#robotSpeed').checked && S.model && RV.target && !exporting && !tc.dragging && !manualActive && !jtDrag;
  if (!on) { RV.cur = null; return; }                            // 꺼져 있거나 손으로 조작 중이면 따라가기를 멈추고, 다시 켜지면 지금 자세에서 시작한다
  if (!RV.cur) { RV.cur = { ...RV.target }; RV.vel = { neck: 0, head: 0, tilt: 0, body: 0 }; }
  for (const j of ['neck', 'head', 'tilt', 'body']) {
    const err = RV.target[j] - RV.cur[j];
    const vd = Math.max(-RV_VMAX[j], Math.min(RV_VMAX[j], err / RV_TAU));
    RV.vel[j] += Math.max(-RV_AMAX[j] * dt, Math.min(RV_AMAX[j] * dt, vd - RV.vel[j]));
    RV.cur[j] += RV.vel[j] * dt;
    if (Math.abs(err) < 0.02 && Math.abs(RV.vel[j]) < 1) { RV.cur[j] = RV.target[j]; RV.vel[j] = 0; }
  }
  writeJoints(RV.cur);
}
/* [로봇 한계] 켜져 있으면 뷰포트의 기둥·머리·갸웃을 로봇이 실제로 움직일 수 있는 범위로 잘라서 보여 준다 (키 값은 그대로). */
let jointCache = null;
const jtVal = { neck: 0, head: 0, tilt: 0, body: 0 }, jtUI = {};
let jtDrag = false, manualActive = false;
function limitToRobot() {
  if (!S.model) return;
  if (!jointCache || jointCache.model !== S.model) jointCache = { model: S.model, ids: jointIds() };
  const ids = jointCache.ids, cur = {};
  const read = (j) => {
    if (ids[j] === undefined) return 0;
    const rest = S.rest.get(ids[j]), o = S.nodes.get(ids[j]), ax = JOINT_AXES[j];
    const qr = new THREE.Quaternion().fromArray(rest.q).invert().multiply(o.quaternion);
    let a = 2 * Math.atan2(ax.x * qr.x + ax.y * qr.y + ax.z * qr.z, qr.w);
    if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
    return a / D2R;
  };
  ['neck', 'head', 'tilt'].forEach((j) => { cur[j] = read(j); });
  const lim = limitFrames([{ t: 0, neck: cur.neck, head: cur.head, tilt: cur.tilt, body: 0 }], { tiltSign: +($('#rpTiltSign')?.value || 1) })[0];
  ['neck', 'head', 'tilt'].forEach((j) => {
    if (ids[j] === undefined || Math.abs(lim[j] - cur[j]) < 1e-3) return;
    const rest = S.rest.get(ids[j]), o = S.nodes.get(ids[j]);
    o.quaternion.fromArray(rest.q).multiply(new THREE.Quaternion().setFromAxisAngle(JOINT_AXES[j], lim[j] * D2R));
  });
}
/* [로봇 동기] 켜져 있으면 웹에서 재생하는 동안 0.1초마다 지금 보이는 자세(로봇 한계 적용)를 로봇에 보낸다. 눈도 따라간다(뜬·감은·웃는·하트는 로봇 기본 이름, 나머지는 로봇에 넣은 한글 표정 이름). */
// 로봇에 넣은 눈 파일(cove_eyes.json)의 표정 이름(한글) 그대로 보낸다. (로봇 기본 이름 idle/happy/heart 는 옛 모양이라 쓰지 않는다)
let syncEye = '';
// 재생 중이 아닐 때(멈춤 지점도 아닐 때)도 머리를 쓰다듬으면 신난 눈으로 기뻐하고, 손을 떼고 3초 뒤 원래 눈으로 돌아간다
let lastTorqueWarn = 0;
let happyUntil = 0, happyOn = false, prevTouch = false, wiggleTimer = 0, tapTimer = 0, tapBase = null, tapEnd = 0;
const STROKE_MS = 5000, STROKE_GAP_MS = 2000; let allTouchSince = 0, allGapAt = 0;   // 쓰다듬기로 치는 시간: 세 센서를 전부 이만큼 계속 만져야 한다
let touchState = 'idle';   // 'idle' | 'stroking'
// 일어나기 애니메이션 / 눈 감기 잠금 / 앉기 뒤 접힌 자세 맞추기 타이머 (반응을 한 번에 멈출 수 있게 센서 반응 상태와 함께 둔다)
let standTimer = 0, standLockUntil = 0, sitTimer = 0, sitIv = 0;
// 터치 판정 상태: idle → pending(닿은 걸 처음 봄) → 떨어졌으면 tapwait(다음 센서가 이어 닿는지 한 번 더 본다) → 톡
// 몸도 흔든다: 로봇의 지금 자세를 기준으로 머리를 조금 숙이고 몸통을 3초간 좌우로 (웹 동기가 켜져 있어야 한다 = 주변 확인 + 동기 켬). 끝나면 그 자세로 돌아온다
const WIGGLE_SEC = 3;                                           // 몸 흔드는 시간 (초)
// 재생 안 할 때 센서 반응들(톡·쓰다듬기·1번·2번 기둥 올리기)이 로봇에 자세를 보내는 길을 하나로 맞춘다.
// 관절 조작(머리 들기·일어난 뒤 고개 들기 등) 뒤에는 0.1초마다 그 자세를 계속 보내는 로봇 동기가 따로 돌고 있어서, 반응이 따로 자세를 보내면 두 값이 번갈아 가며 로봇이 떨린다.
// 그래서 조작 중이면 반응도 같은 조작 값(jtVal)을 바꿔서 보내고(한 곳에서만 보낸다), 기준 자세도 로봇이 읽은 값이 아니라 보낸 값에서 잡는다
const idleBase = () => (manualActive ? { neck: jtVal.neck, head: jtVal.head, tilt: jtVal.tilt, body: jtVal.body } : robot.deg);
function driveIdlePose(p) {
  if (manualActive) { Object.assign(jtVal, p); applyManual(); renderJoint(); }
  else robot.pose(p);
}
// 지금 앉아 있는지: 로봇이 연결돼 있으면 로봇의 기둥(15° 미만), 아니면 화면 자세로 본다
const isSitting = () => {
  if ((armActive || armResume) && armBase) return armBase.neck < 15;     // 손 숙이기로 기둥이 낮아진 건 앉은 게 아니다: 숙이기 전 자세로 본다
  const d = robot.connected ? robot.deg : null; return d ? d.neck < 15 : (manualActive ? jtVal.neck : readJointAngles().neck) < 15;
};
// 반응이 끝났을 때 눈을 되돌린다: 앉아 있으면 감은 눈, 아니면 지금 동작의 눈(표정 고르기로 바꾼 눈도 그대로). 재생이 시작됐으면 재생이 눈을 맡긴다
function restoreEyes() {
  if (S.playing) return;
  if (isSitting()) { wasSitting = true; eyes?.show('감은 눈'); if (robot.connected) robot.eyes('감은 눈'); return; }
  applyEyes(S.time); if (robot.connected) robot.eyes('뜬 눈');                 // 화면은 동작의 눈, 로봇은 기본 뜬 눈 (예전과 같다)
}
// 자세를 쓰는 반응(손 숙이기·갸우뚱·쓰다듬기·톡·일어나기)이 하나라도 진행 중인지. 자세는 한 번에 하나만 쓴다: 새 반응은 이게 끝날 때까지 기다리고, 버튼은 이걸 멈추고 자리를 차지한다
// 로봇이 자기 씬(앉기의 home 등)을 돌리고 있는 중: 이때 웹 반응이 자세를 보내면 씬과 부딪치므로 반응을 시작하지 않는다
const robotSceneBusy = () => !!(robot.connected && robot.current);
const motionBusy = () => !!(armActive || sideActive || happyOn || tapTimer || standTimer);
// 버튼(일어나기·머리 들기·숙이기)이 자세를 차지한다: 진행 중인 반응을 모두 멈추고, 로봇이 씬을 돌리고 있으면 그 자리에서 세운다 (두 곳에서 자세를 보내지 않게)
function takeOverPose() {
  const was = motionBusy();
  resetIdleReactions();
  if (robot.connected && robot.sync && robot.current) robot.hold();
  return was;
}
// 머리를 톡톡 치면 고개를 올렸다가(머리 10°, 얼굴이 위) 1.5초 뒤 원래대로. 연타하면 올린 채 시간이 늘어난다. 웹 동기가 켜져 있어야 움직인다
const TAP_UP = 10, TAP_HOLD_MS = 1500;
const TAP_BOW_HEAD = -30, TAP_LIFT_HEAD = -36;                       // 머리가 -30°보다 숙여져(0°에 가까워져) 있으면 톡 쳤을 때 -36°까지 들어 그대로 둔다 (갸웃도 바로 세운다)
function tapRaise() {                                              // 앉아 있는 로봇의 머리에 손이 닿으면 일어난다 (서 있거나 일어나는 중이면 부르지 않는다)
  if (standTimer || !isSitting()) return;
  toast('머리를 만졌어요 · 일어나요');
  $('#standUp').click();
}
function happyWiggle() {
  const base = tapTimer ? tapBase : (robot.sync ? idleBase() : null);   // 고개를 올리던 중이면 올리기 전 자세에서 시작한다
  if (tapTimer) { clearInterval(tapTimer); tapTimer = 0; }
  if (!base || !robot.sync) return;
  clearInterval(wiggleTimer);
  const t0 = performance.now(), r1 = (v) => Math.round(v * 10) / 10;
  wiggleTimer = setInterval(() => {
    if (S.playing || !robot.sync) { clearInterval(wiggleTimer); return; }        // 재생이 시작됐거나 동기가 꺼졌으면 재생·동기에 맡기고 그만둔다
    const t = (performance.now() - t0) / 1000, done = t >= WIGGLE_SEC;
    const e = Math.max(0, Math.min(1, t / 0.5, (WIGGLE_SEC - t) / 0.5)), es = e * e * (3 - 2 * e), off = done ? 0 : 12 * Math.sin((2 * Math.PI * t) / 1.4) * es;
    const bow = 0;                                                             // 머리는 움직이지 않고 몸통만 좌우로 흔든다 (도리도리)
    driveIdlePose({ neck: r1(base.neck), head: r1(Math.min(0, base.head + bow)), tilt: r1(base.tilt), body: r1(base.body + off) });
    if (done) clearInterval(wiggleTimer);
  }, 100);
}
// 1번 거리센서(머리, 턱 아래)에 손이 닿으면(재생 중이 아닐 때): 고개를 갸우뚱(머리를 숙이고 정면에서 보이는 왼쪽으로 갸웃) 하고, 표정은 편안한 눈으로 바꾼다.
// 손이 떨어지고 1.5초 뒤 원래대로. 눈은 뷰포트에만 나온다(로봇 눈은 시선을 못 바꾼다), 고개는 로봇 동기가 켜져 있을 때만 움직인다
const ARM_HEAD = -26, ARM_TILT_FRAC = 0.85, ARM_HOLD_MS = 150, ARM_BACK_SEC = 0.25;   // 손이 떨어지면 바로(0.15초 여유) 고개를 세우고(0.25초) 눈도 뜬 눈으로 돌아온다   // 갸우뚱: 머리를 -26°까지 숙이고(이미 더 숙였으면 그대로) 그 머리 각도에서 로봇이 허용하는 갸웃의 85%만큼 기울인다 (머리를 많이 든 자세에서는 갸웃이 거의 안 되기 때문)
// 손 높이에 맞춰 숙이기: 1번 거리센서(턱 아래) 값이 올 때마다(약 1.5초) 손까지 남은 거리만큼 머리를 더 숙인다.
// 거리가 ARM_STOP_MM(1cm) 이내가 되면 거기서 멈추고 더 숙이지도 눌러 주지도 않는다. 손이 높이 올라오면 그만큼만 숙인다
const ARM_EASE_SEC = 0.5;                                           // 목표를 따라가는 시간 상수(초): 클수록 더 부드럽고 느리게
const ARM_STOP_MM = 10, ARM_DEG_PER_MM = 0.45, ARM_STEP_MAX = 12, ARM_HEAD_RATE = 22;   // mm, 도/mm, 도/값 한 번, 도/초 — 거리가 ARM_STOP_MM(1cm) 이내가 되면 거기서 더 숙이지 않는다. 그 전에는 살살 닿도록 작게·천천히
const ARM_NECK_SPLIT = 0.5, ARM_NECK_DROP_MAX = 20;                // 숙이는 양의 절반은 기둥을 낮춰서 한다(머리 앞쪽만 숙이지 않고 머리 전체가 내려가게). 기둥은 처음보다 최대 이만큼(도)만 낮춘다
let armActive = false, armUntil = 0, armTimer = 0, armBase = null, armT0 = 0, prevArm = false, armResume = false, armWait = false;   // armResume: 터치 반응에 자리를 내줬다가 손이 아직 있으면 같은 처음 자세로 이어간다 / armWait: 다른 반응 중에 손이 들어와서, 끝나면 새로 시작한다
let armHeadT = 0, armHeadCur = 0, armNeckT = 0, armNeckCur = 0, armSample = 0, armTick = 0, armSuppress = false, lastArmAt = 0;   // armSuppress: 톡톡으로 손에서 올라온 뒤, 손이 떠날 때까지 다시 숙이지 않는다
function armLookEnd(keepEyes) {
  armActive = false; clearInterval(armTimer); armTimer = 0;
  if (!keepEyes) restoreEyes();                                     // 눈은 동작의 눈(앉아 있으면 감은 눈)으로 돌아간다. 자리를 내주는 경우에는 다음 반응이 눈을 정한다
}
// 손을 누르고 있는 중에 머리 터치센서(쓰다듬기·갸우뚱·톡)가 닿으면, 숙이기는 잠시 멈추고 터치 반응을 먼저 한다. 터치 반응이 끝났을 때 손이 아직 있으면 숙이기를 다시 이어간다
function yieldToTouch() {
  if (!armActive) return;
  armResume = true; armLookEnd(true);
}
function armLookStart(resumed) {
  const reuse = !!(resumed && armResume && armBase);                 // 자리를 내줬다가 이어가는 경우: 돌아갈 처음 자세는 그대로 두고, 지금 자세에서 이어간다 (숙인 자세를 처음 자세로 잘못 잡지 않게)
  armActive = true; armResume = false; armWait = false; armEyesBack = false; armUntil = Date.now() + ARM_HOLD_MS; armT0 = performance.now();
  standEyesUntil = 0;                                                // 인사 뒤 웃는 눈 유지가 있었으면 그만둔다 (이 반응의 눈이 우선)
  if (!resumed) toast('1번 거리센서에 손이 닿았어요');
  eyes?.show('편안한 눈'); robot.eyes('편안한 눈');                    // 갸우뚱하면서 편안한 표정(뷰포트·로봇 모두)
  if (!reuse) armBase = robot.sync ? idleBase() : null;
  if (armBase) { const cur = reuse ? (idleBase() || armBase) : armBase; armHeadT = armHeadCur = cur.head; armNeckT = armNeckCur = cur.neck; armSample = 0; armTick = performance.now(); }
  clearInterval(armTimer);
  const r1 = (v) => Math.round(v * 10) / 10;
  armTimer = setInterval(() => {
    if (S.playing || S.heldAt != null) { armLookEnd(); return; }     // 재생이 시작되면 재생에 맡긴다
    const now = Date.now(), n = performance.now(), on = now < armUntil;
    const up = Math.min(1, (n - armT0) / 500);
    if (!on && !armEyesBack) { armEyesBack = true; restoreEyes(); }   // 손이 떨어지는 순간 눈부터 돌려놓는다
    if (!on) armDown = Math.max(0, (armDown ?? 1) - 0.1 / ARM_BACK_SEC); else { armDown = 1; armEyesBack = false; }
    const k = Math.min(up, armDown), ks = k * k * (3 - 2 * k);
    if (armBase && robot.sync) {
      const dt = Math.min(0.3, (n - armTick) / 1000); armTick = n;
      const d = robot.topMm, sample = robot.senseSampleAt;
      if (on && d != null && sample !== armSample) {                  // 새 거리 값이 오면 손까지 남은 만큼 머리 목표를 조정한다
        armSample = sample;
        const err = d - ARM_STOP_MM;
        const delta = err > 0 ? Math.min(ARM_STEP_MAX, err * ARM_DEG_PER_MM) : 0;                     // 아직 1cm보다 멀면 더 숙이고, 1cm 이내면 그 자리에서 멈춘다 (더 누르지도 물러나지도 않는다)
        armHeadT = Math.min(0, Math.max(armBase.head, armHeadT + delta * (1 - ARM_NECK_SPLIT)));        // 머리는 절반
        armNeckT = Math.min(armBase.neck, Math.max(Math.max(0, armBase.neck - ARM_NECK_DROP_MAX), armNeckT - delta * ARM_NECK_SPLIT));   // 기둥은 나머지 절반을 낮춘다
      }
      const goal = on ? armHeadT : armBase.head, neckGoal = on ? armNeckT : armBase.neck;   // 손이 떨어지면 처음 각도로 돌아간다
      // 부드럽게: 목표를 향해 남은 거리의 일부씩 다가가서(처음엔 빠르다가 목표에 가까워질수록 느려진다) 거리 값이 1.5초마다 바뀌어도 멈칫하지 않고, 속도는 ARM_HEAD_RATE를 넘지 않는다
      const ease = 1 - Math.exp(-dt / (on ? ARM_EASE_SEC : ARM_EASE_SEC * 0.6)), cap = ARM_HEAD_RATE * dt * (on ? 1 : 2);
      armHeadCur += Math.max(-cap, Math.min(cap, (goal - armHeadCur) * ease)); armNeckCur += Math.max(-cap, Math.min(cap, (neckGoal - armNeckCur) * ease));
      const bow = Math.max(0, Math.min(1, (armHeadCur - armBase.head) / 6)), tiltT = Math.max(0, tiltRange(armHeadCur)[1] * ARM_TILT_FRAC);   // 숙인 만큼 갸웃도 따라 한다
      driveIdlePose({ neck: r1(armNeckCur), head: r1(armHeadCur), tilt: r1(armBase.tilt + (tiltT - armBase.tilt) * bow), body: r1(armBase.body) });
    }
    if (!on && armDown <= 0 && (!armBase || !robot.sync || Math.abs(armHeadCur - armBase.head) < 0.3 && Math.abs(armNeckCur - armBase.neck) < 0.3)) { armDown = 1; armLookEnd(); }   // 손이 떨어지면 머리가 처음 각도로 돌아온 뒤에 끝낸다
  }, 100);
}
let armDown = 1, armEyesBack = false;
// 터치센서 두 개를 같이 만지면 그 방향으로 고개를 들어 갸우뚱하고 눈은 위를 본다: 2+3번(오른쪽) → 3번 쪽, 1+2번(왼쪽) → 1번 쪽.
// 갸웃은 머리를 -26°로 맞춘 뒤 로봇이 허용하는 만큼(85%)이고, 실물 로봇 시험으로 1번 쪽이 −, 3번 쪽이 +다(armLook과 반대). 손이 떨어지면 원래 자세와 뜬 눈으로 돌아온다
const SIDE_NECK = 30, SIDE_NECK_RATE = 30;                          // 쓰다듬을 때 기둥을 올리는 높이(도, 로봇 한계 34)와 올리는 속도(도/초). 이미 더 높으면 그대로 둔다
const SIDE_HEAD = -26, SIDE_TILT_FRAC = 0.85, SIDE_HEAD_RATE = 60, SIDE_TILT_RATE = 70;   // 도, 비율, 도/초, 도/초
let sideNeck = 0, sideUntil = 0, sideActive = false, sideTimer = 0, sideBase = null, sideDirNow = 0, sideT = 0, sideHead = 0, sideTilt = 0;
function sideTouchDir() {                                             // 1: 1+2번(왼쪽), -1: 2+3번(오른쪽), 0: 그 밖
  if (!robot.connected) return 0;
  const e = robot.touchEach; if (!e) return 0;
  if (e[1] && e[0] && !e[2]) return 1;
  if (e[1] && e[2] && !e[0]) return -1;
  return 0;
}
function sideLookEnd() {
  sideActive = false; clearInterval(sideTimer); sideTimer = 0;
  if (S.heldAt == null) restoreEyes();
}
function sideLookStart(dir) {
  sideActive = true; sideDirNow = dir; touchState = 'idle'; sideT = performance.now(); sideUntil = sideT + 2500; standEyesUntil = 0;
  toast(dir > 0 ? '터치 1번 → 2번 · 기둥을 올리고 1번 쪽으로 갸우뚱' : '터치 3번 → 2번 · 기둥을 올리고 3번 쪽으로 갸우뚱');
  eyes?.show('위 보는 눈'); robot.eyes('위 보는 눈');
  sideBase = robot.sync ? idleBase() : null;
  if (sideBase) { sideHead = sideBase.head; sideTilt = sideBase.tilt; sideNeck = sideBase.neck; }
  clearInterval(sideTimer);
  const r1 = (v) => Math.round(v * 10) / 10, step = (cur, to, max) => cur + Math.max(-max, Math.min(max, to - cur));
  sideTimer = setInterval(() => {
    if (S.playing || S.heldAt != null) { sideLookEnd(); return; }
    const n = performance.now(), dt = Math.min(0.3, (n - sideT) / 1000); sideT = n;
    if (robot.touchEach?.[1]) sideUntil = Math.max(sideUntil, n + 800);
    const on = n < sideUntil;                                        // 처음 2.5초는 짧게 쳐도 유지하고, 그 뒤에는 2번에 손이 닿아 있는 동안만 (손을 떼고 0.8초 뒤 돌아온다)
    if (on) eyes?.show('위 보는 눈');
    if (sideBase && robot.sync) {
      const headT = on ? Math.min(0, Math.max(sideBase.head, SIDE_HEAD)) : sideBase.head;
      const [lo, hi] = tiltRange(headT), tiltT = on ? (sideDirNow > 0 ? Math.min(0, lo * SIDE_TILT_FRAC) : Math.max(0, hi * SIDE_TILT_FRAC)) : sideBase.tilt;
      const neckT = on ? Math.max(sideBase.neck, SIDE_NECK) : sideBase.neck;                     // 기둥도 같이 올린다
      sideNeck = step(sideNeck, neckT, SIDE_NECK_RATE * dt); sideHead = step(sideHead, headT, SIDE_HEAD_RATE * dt); sideTilt = step(sideTilt, tiltT, SIDE_TILT_RATE * dt);
      driveIdlePose({ neck: r1(sideNeck), head: r1(sideHead), tilt: r1(sideTilt), body: r1(sideBase.body) });
      if (!on && Math.abs(sideNeck - sideBase.neck) < 0.3 && Math.abs(sideHead - sideBase.head) < 0.2 && Math.abs(sideTilt - sideBase.tilt) < 0.2) sideLookEnd();
    } else if (!on) sideLookEnd();
  }, 100);
}
// 1번·3번을 만진 시각을 기억해 두고, 2번이 새로 닿으면 그 직전(SIDE_GAP_MS 안)에 닿은 쪽 방향으로 한다: 3번 → 2번이면 3번 쪽(−), 1번 → 2번이면 1번 쪽(+).
// 3번을 떼고 나서 2번을 만져도 된다(같이 닿아 있지 않아도). 갸우뚱은 2번에 손이 닿아 있는 동안 이어간다
const SIDE_GAP_MS = 5000, SIDE_LOOK_ON = false;   // SIDE_LOOK_ON: 터치 3번→2번 / 1번→2번 갸우뚱 반응 (지금은 끔)
let sideRise = [0, 0, 0], prevSideEach = [false, false, false], prevSideRecent = [false, false, false];
function sideLook() {
  if (!SIDE_LOOK_ON) return;                                        // 3번→2번 / 1번→2번 갸우뚱은 없앴다
  const idle = !S.playing && S.heldAt == null, e = robot.connected ? robot.touchEach : null, rc = robot.connected ? robot.touchRecent : null;
  if (!e) { prevSideEach = [false, false, false]; prevSideRecent = [false, false, false]; return; }
  const now = Date.now(), o = robot.touchOrder || [];
  [0, 1, 2].forEach((i) => { if ((e[i] && !prevSideEach[i]) || (rc && rc[i] && !prevSideRecent[i])) sideRise[i] = now; });   // 새로 닿았음(짧게 쳐서 센서 값에 못 잡힌 것도 최근 값으로)
  const rose2 = (e[1] && !prevSideEach[1]) || (rc && rc[1] && !prevSideRecent[1]);   // 짧게 톡 친 것도(센서 값은 1.5초마다 와서 이미 손이 떨어졌어도) 최근 1.6초 값으로 잡는다
  prevSideEach = e.slice(); prevSideRecent = rc ? rc.slice() : e.slice();
  if (!rose2 || sideActive || !idle || happyOn || standTimer || robot.auto || robotSceneBusy() || !$('#rpSideLook')?.checked) return;
  let d = 0;
  const i2 = o.lastIndexOf(2), o1 = o.lastIndexOf(1), o3 = o.lastIndexOf(3);
  if (i2 >= 0 && (o1 >= 0 || o3 >= 0) && o1 !== o3) d = o3 > o1 ? (o3 < i2 ? -1 : 0) : (o1 < i2 ? 1 : 0);          // 로봇이 알려 준 닿은 순서가 있으면 그걸로 (3번 → 2번 / 1번 → 2번)
  if (!d) {                                                         // 없거나 같은 값에 섞여 있으면 웹이 본 시각으로: 2번 직전에 가장 최근에 닿은 쪽
    const r1 = sideRise[0], r3 = sideRise[2], r2 = sideRise[1];
    if (r3 && r3 <= r2 && now - r3 < SIDE_GAP_MS && r3 > r1) d = -1;
    else if (r1 && r1 <= r2 && now - r1 < SIDE_GAP_MS && r1 > r3) d = 1;
  }
  if (!d) return;
  if (tapTimer) { clearInterval(tapTimer); tapTimer = 0; }          // 톡 반응 중이었으면 그만두고 갸우뚱으로
  yieldToTouch();                                                   // 손을 누르는 중이었으면 숙이기는 잠시 멈춘다
  sideLookStart(d);
}
// 손을 누르고 있는 중에 머리를 톡톡 치면 손에서 올라온다: 숙이기 전 자세로 돌아가고(눈도 돌아온다), 손이 아직 있어도 떠날 때까지 다시 숙이지 않는다
function armLiftOff() {
  armSuppress = true; armUntil = 0; armResume = false; armWait = false;
  toast('머리를 톡톡 쳤어요 · 손에서 올라가요');
}
function armLook() {
  const a = robot.connected && robot.arm, idle = !S.playing && S.heldAt == null;
  if (a) lastArmAt = Date.now();                                     // 1번 거리센서에 손이 있었던 마지막 때 (2번 센서가 이 손에 반응하지 않게 한다)
  if (a && !armSuppress) armUntil = Date.now() + ARM_HOLD_MS;
  if (!a) armSuppress = false;
  const busy = sideActive || happyOn || tapTimer || standTimer || touchState !== 'idle' || robotSceneBusy();   // 다른 반응이나 로봇 씬이 자세를 쓰는 중 (톡인지 보는 중도 포함)
  if (!a) { armResume = false; armWait = false; }
  else if (!armActive && !armSuppress && idle && !robot.auto && $('#rpArmLook')?.checked) {   // 로봇 자동 모드면 로봇이 직접 반응하므로 웹은 하지 않는다
    if (busy) armWait = true;                                                              // 끝나면 손이 아직 있을 때 시작한다
    else if (!prevArm || armResume || armWait) armLookStart(armResume || armWait);
  }
  prevArm = a;
}
// 2번 거리센서(몸통 앞): 앉아 있을 때 손이 새로 다가오면 시나리오 4 인사를 처음부터 재생한다(목록에는 숨겨 둔 센서 전용, 끝에 접지 않고 선 채로 끝). 로봇이 자동 모드면 로봇이 직접 반응하므로 하지 않는다
let prevPerson = null, personLastStart = 0, standHeadAt = 0;
const STAND_HEAD = -42;                                            // 일어선 뒤 고개를 드는 각도 (도, 음수 = 얼굴이 위, 로봇 한계 -46). 일어서는 장면의 끝 자세는 -34
function standHeadUp() {
  if (!standHeadAt) return;
  const t = performance.now() - standHeadAt;
  if (t > 8000 || S.heldAt != null || motionBusy()) { standHeadAt = 0; return; }   // 다른 일(센서 반응·버튼)이 끼어들었으면 그만둔다
  if (t < 800 || S.playing) return;                                  // 일어서는 장면이 끝날 때까지 기다린다
  standHeadAt = 0;
  if (S.sceneLoop && S.time >= 2.9) {
    setJoint('head', STAND_HEAD); toast('고개를 들어요');
    standEyesUntil = performance.now() + STAND_EYES_MS; standEyesOn(true);   // 다 일어서면 웃는 눈으로 4초 유지했다가 뜬 눈으로
  }
}
// 앉아 있을 때(로봇의 기둥이 15° 미만, 로봇 값이 없으면 화면이 처음 자세)는 눈을 감는다. 앉은 상태가 새로 시작되는 순간 한 번만 바꾼다(그 뒤 표정 고르기 등은 방해하지 않는다)
let wasSitting = false;
function sittingEyes() {
  const d = robot.connected ? robot.deg : null, sitting = d ? isSitting() : (S.time <= 0.05 && !manualActive);
  const idle = !S.playing && S.heldAt == null && !motionBusy() && !armResume && !standEyesUntil && !standHeadAt && performance.now() > standLockUntil;
  if (sitting && idle) {
    if (!wasSitting) { wasSitting = true; eyes?.show('감은 눈'); if (robot.connected) robot.eyes('감은 눈'); }
  } else if (!sitting) wasSitting = false;
}
const STAND_EYES_MS = 4000;
let standEyesUntil = 0;
function standEyesOn(first) {
  if (!standEyesUntil) return;
  if (S.playing || motionBusy()) { standEyesUntil = 0; return; }    // 재생이 시작되거나 다른 반응이 눈을 쓰면 그만둔다 (그쪽 눈이 우선)
  if (performance.now() < standEyesUntil) { eyes?.show('웃는 눈'); if (first) robot.eyes('웃는 눈'); return; }
  standEyesUntil = 0; restoreEyes();
}
function frontApproach() {
  const st = $('#rpFrontState'), on = $('#rpFront')?.checked;
  if (st) st.textContent = !robot.connected ? '(로봇 연결 필요)' : !robot.tofKnown ? '(값 없음)' : `${robot.approach ? '● 다가옴' : '○ 없음'} ${robot.approach ? robot.approachMm : robot.tofNearMm}mm${robot.auto ? ' · 로봇 자동 모드' : ''}`;
  const p = robot.connected && robot.tofKnown ? robot.approach : null;
  if (p === null) { prevPerson = null; return; }
  const rising = prevPerson === false && p === true;                 // 처음 값(이미 사람이 있던 상태)은 다가온 걸로 치지 않는다
  prevPerson = p;
  // 일어난 직후이거나 1번 거리센서(머리)에 손이 있거나 막 떼었을 때(3초)는 2번 센서가 같은 손에 반응하지 않는다 (손이 머리 아래로 들어오면서 몸통 앞도 지나가기 때문)
  const arm1 = robot.arm || armActive || armSuppress || Date.now() - lastArmAt < 3000 || performance.now() < standLockUntil;
  if (!rising || !on || arm1 || robot.auto || S.playing || S.heldAt != null || motionBusy() || robotSceneBusy() || Date.now() - personLastStart < 5000) return;   // 다른 반응이 진행 중이면 끼어들지 않는다
  const idx = S.clips.findIndex((c) => c.name.includes('인사')); if (idx < 0) return;
  // 앉아 있을 때만 일어난다. 앉아 있는지는 로봇의 실제 기둥 위치(15° 미만)로 보고, 로봇 값이 없으면 화면이 처음(또는 끝난) 상태인지로 본다 — 몇 번이고 앉았다 일어난다
  const cur = S.clips[S.clip], d = robot.deg, sitting = d ? isSitting() : (S.time <= 0.05 || S.time >= cur.duration - 0.05);
  if (!sitting) return;
  personLastStart = Date.now();
  toast('사람이 다가왔어요 · 인사해요');
  if (S.clip !== idx) { const sel = $('#clipSel'); sel.value = String(idx); sel.dispatchEvent(new Event('change')); }
  playAll();                                                       // 인사 시나리오를 처음부터 끝까지 재생한다(앉은 자세에서 일어나 인사하고, 끝에 접지 않고 선 채로 끝)
  playStartedAt = performance.now() - 5000;                        // 앞서 보내는 양(로봇이 늦는 약 1초)을 서서히 늘리지 않고 처음부터 다 준다 — 앉은 자세에서 시작이라 튈 걱정이 없다
}
// 2번 거리센서: 서 있는 로봇에게 가까이 올수록 기둥을 더 올린다(손 약 10cm에서 시작, 약 5cm에서 최대 33°). 사람이 떠나면 원래 높이로 내려온다.
// 로봇 동기가 켜져 있고 재생·다른 반응 중이 아닐 때만 움직이고, 기둥만 바꾼다(나머지는 시작할 때 자세 그대로)
const FOLLOW_FAR = 140, FOLLOW_NEAR = 55, NECK_MAX = 33, FOLLOW_RATE = 12;   // mm, mm, 도, 도/초 (다가옴 자체가 손 약 10cm 안이라, 센서 값 140mm에서 시작해 55mm(손 약 5cm)에서 최대)
let followBase = null, followCur = 0, followTimer = 0, sitLock = false, followMm = null;
const FOLLOW_ON = false;                                            // 서 있을 때는 2번 센서를 더 이상 보지 않는다(가까울수록 기둥 올리기 끔). 켜려면 true
function frontFollow() {
  if (!FOLLOW_ON) { followBase = null; return; }
  if (sitLock) { if (!robot.approach) sitLock = false; followBase = null; return; }   // 앉기를 누른 뒤에는 사람이 떠날 때까지 기둥을 올리지 않는다
  if (!robot.connected || !robot.sync || robot.auto || !$('#rpFront')?.checked || S.playing || S.heldAt != null) { followBase = null; return; }   // 꺼졌거나 재생이 시작되면 재생·동기에 맡긴다
  if (motionBusy()) { followTimer = performance.now(); return; }                                                                                 // 다른 반응 중에는 잠시 쉰다
  const near = robot.approach && robot.approachMm != null;
  if (!followBase) {
    const d = near ? idleBase() : null;
    if (!d || d.neck < 15) return;                                   // 앉아 있거나 자세를 모르면 하지 않는다 (일어나는 건 위 동작이 한다)
    followBase = d; followCur = d.neck; followTimer = performance.now();
  }
  const now = performance.now(), dt = Math.min(0.3, (now - followTimer) / 1000); followTimer = now;
  if (near) followMm = followMm == null ? robot.approachMm : followMm + (robot.approachMm - followMm) * 0.25; else followMm = null;   // 거리 값이 튀어도 기둥이 떨지 않게 부드럽게 따라간다
  const k = near ? Math.max(0, Math.min(1, (FOLLOW_FAR - followMm) / (FOLLOW_FAR - FOLLOW_NEAR))) : 0;
  const target = followBase.neck + Math.max(0, NECK_MAX - followBase.neck) * k * k * (3 - 2 * k);
  const step = FOLLOW_RATE * dt;
  if (Math.abs(target - followCur) > 1 || !near) followCur += Math.max(-step, Math.min(step, target - followCur));   // 1° 안쪽 차이는 무시해 미세하게 떨지 않게 한다
  const r1 = (v) => Math.round(v * 10) / 10;
  driveIdlePose({ neck: r1(followCur), head: r1(followBase.head), tilt: r1(followBase.tilt), body: r1(followBase.body) });
  if (!near && Math.abs(followCur - followBase.neck) < 0.15) followBase = null;   // 다 내려왔으면 끝
}
function startStroke() {
  yieldToTouch();                                                   // 손을 누르는 중이었으면 숙이기는 잠시 멈추고, 끝나면 이어간다
  standEyesUntil = 0;
  touchState = 'stroking'; happyOn = true; toast('쓰다듬어 줘서 기뻐요');
  eyes?.show('신난 눈'); robot.eyes('신난 눈');
  happyWiggle();
}
function idleHappy() {
  const now = Date.now(), t = robot.connected && robot.touch, idle = !S.playing && S.heldAt == null;
  // 앉아 있을 때 머리에 손이 닿으면 바로 일어난다 (톡톡이든 쓰다듬든 처음 닿은 순간). 예전에는 "금방 떨어졌는지"를 보려고 센서 값을 두 번 더 기다려서 3초 넘게 걸렸다.
  // 서 있을 때의 쓰다듬기(기뻐하기)는 아래에서 따로 센다. 로봇 센서 값은 1.5초마다 오므로 닿은 뒤 최대 1.5초쯤 걸린다
  if (t && !prevTouch && idle && !standTimer && !robot.auto && !robotSceneBusy() && !sideActive && $('#rpHappy')?.checked) { if (armActive && !armSuppress) armLiftOff(); else if (isSitting()) tapRaise(); }   // 손을 누르는 중이면 올라오고, 앉아 있으면 일어난다
  // 쓰다듬기(기뻐하기)는 터치센서 1·2·3번을 전부 5초 넘게 계속 만졌을 때만 한다
  // 센서 값은 1.5초마다 오고 손바닥이 세 센서를 항상 동시에 덮고 있지는 않으므로: 세 센서가 모두 "최근 1.6초 안에 닿았음"이면 닿고 있는 걸로 보고, 잠깐(2초) 끊겨도 5초를 처음부터 다시 세지 않는다
  const all = !!(robot.connected && robot.touchRecent?.every(Boolean));
  if (all) { allGapAt = 0; if (!allTouchSince) { allTouchSince = now; if (!happyOn && idle) toast('1·2·3번이 모두 닿았어요 · 5초 동안 계속 쓰다듬어 주세요'); } }
  else if (allTouchSince) { if (!allGapAt) allGapAt = now; else if (now - allGapAt > STROKE_GAP_MS) { allTouchSince = 0; allGapAt = 0; } }
  if (allTouchSince && now - allTouchSince >= STROKE_MS && !happyOn && idle && !sideActive && !standTimer && !robot.auto && !robotSceneBusy() && touchState !== 'stroking' && $('#rpHappy')?.checked) startStroke();
  if (happyOn) {
    if (t) happyUntil = now + 3000;
    if (!idle || (!t && now > happyUntil)) {
      happyOn = false; touchState = 'idle';
      if (idle) restoreEyes();                                  // 앉아 있으면 감은 눈, 아니면 동작의 눈으로 (재생이 시작됐으면 재생이 눈을 맡는다)
    }
  }
  prevTouch = t;
}
// 동작 목록 아래 "센서" 줄: 지금 감지 중인 센서를 금색으로 켜고 값을 보여 준다 (터치 · 1번 머리 거리 · 2번 몸통 거리)
const sbLast = {};
function updateSensorBar() {
  const bar = $('#sensorBar'); if (!bar) return;
  const on = robot.connected;
  const setPill = (id, active, small) => {
    const key = id + '|' + (on && active ? 1 : 0) + '|' + small;
    if (sbLast[id] === key) return; sbLast[id] = key;
    const el = $('#' + id); el.classList.toggle('on', !!(on && active)); el.querySelector('small').textContent = small;
  };
  bar.classList.toggle('off', !on);
  const note = !on ? '로봇 연결 필요' : (robot.touch || robot.arm || robot.approach) ? '감지 중' : '대기 중';
  if ($('#sbNote').textContent !== note) $('#sbNote').textContent = note;
  const rec = robot.touchRecent, each = robot.touchEach;      // 센서별 값이 오면 1·2·3번을 따로, 아니면(옛 로봇 프로그램) 세 줄 모두 합친 값으로
  [1, 2, 3].forEach((n) => { const a = rec ? rec[n - 1] : robot.touch; setPill('sbTouch' + n, a, !on ? '' : !robot.touchKnown ? '값 없음' : a ? (each && each[n - 1] ? '닿음' : '방금 닿음') : ''); });
  setPill('sbArm', robot.arm, !on ? '' : !robot.armKnown ? '값 없음' : !robot.topOk ? '센서 없음' : `${robot.arm ? '손 감지 ' : ''}${robot.topMm ?? '-'}mm`);
  setPill('sbFront', robot.approach, !on ? '' : !robot.tofKnown ? '값 없음' : robot.approach ? `다가옴 ${robot.approachMm}mm` : `${robot.tofNearMm}mm`);
}
// 터치센서: 쓰다듬기를 기다리는 멈춤 지점(touch 표시)에서 로봇 머리의 터치센서가 닿으면 "반응하기"를 자동으로 누른다
setInterval(() => {
  const st = $('#rpTouchState'), on = $('#rpTouch')?.checked;
  if (st) st.textContent = !robot.connected ? '(로봇 연결 필요)' : !robot.touchKnown ? '(값 없음)' : robot.touch ? '● 닿음' : '○ 안 닿음';
  const sa = $('#rpArmState'), armOn = $('#rpArm')?.checked;
  if (sa) sa.textContent = !robot.connected ? '(로봇 연결 필요)' : !robot.armKnown ? '(값 없음)' : !robot.topOk ? '(센서 없음)' : `${robot.arm ? '● 손 감지' : '○ 없음'} ${robot.topMm ?? '-'}mm (평소 ${robot.topBase ?? '-'})`;
  if (robot.connected && robot.sync && robot.torqueOff && (S.playing || armActive || happyOn || tapTimer || followBase) && Date.now() - lastTorqueWarn > 15000) { lastTorqueWarn = Date.now(); toast('로봇 모터 토크가 꺼져 있어서 로봇이 움직이지 않아요 · 모터 토크 켜기를 눌러 주세요'); }
  updateSensorBar();
  idleHappy();
  armLook();
  sideLook();
  frontApproach();
  standHeadUp();
  standEyesOn(false);
  sittingEyes();
  frontFollow();
  if (!robot.connected || S.heldAt == null) return;
  const h = (curClip()?.holds || []).find((x) => Math.abs(x.t - S.heldAt) < 1e-6);
  if (on && h?.touch && robot.touch) { toast('터치센서에 닿았어요'); releaseHold(); }
  else if (armOn && h?.arm && robot.arm && performance.now() - (S.heldSince || 0) > 1500) {   // 멈춘 직후 자세가 흔들리며 거리가 변하는 걸 손으로 잘못 보지 않도록 1.5초 뒤부터
    toast('1번 거리센서에 손이 들어왔어요'); releaseHold(); }
}, 100);
function syncPoseAt(t) {                                         // 시각 t 의 자세(로봇 한계 적용)를 로봇에 보낸다
  if (!jointCache || jointCache.model !== S.model) jointCache = { model: S.model, ids: jointIds() };
  const clip = curClip(), ids = jointCache.ids, f = { t };
  for (const j of ['neck', 'head', 'tilt', 'body']) f[j] = jointDeg(clip, ids[j], JOINT_AXES[j], t);
  const l = limitFrames([f], { tiltSign: +($('#rpTiltSign')?.value || 1) })[0], r1 = (v) => Math.round(v * 10) / 10;
  robot.pose({ neck: r1(l.neck), head: r1(l.head), tilt: r1(l.tilt), body: r1(l.body) });
}
setInterval(() => {
  if (!robot.sync) { syncEye = ''; return; }
  if (!S.model) return;
  if (!S.playing) {                                              // 재생 중이 아니어도, 관절 조작 슬라이더를 움직였다면 그 자세를 계속 보낸다
    if (S.heldAt != null) { syncPoseAt(S.heldAt); return; }           // 멈춤 지점에서 기다리는 동안은 그 자세를 계속 보내 로봇이 힘을 유지하게 한다
    if (manualActive) { const r1 = (v) => Math.round(v * 10) / 10; robot.pose({ neck: r1(jtVal.neck), head: r1(jtVal.head), tilt: r1(jtVal.tilt), body: r1(jtVal.body) }); }
    return;
  }
  // 재생을 막 시작했을 때 로봇이 갑자기 튀지 않게, 앞서는 양을 초당 0.6초씩 천천히 늘려서 설정값까지 간다
  const lead = Math.min(Math.max(0, Math.min(2, parseFloat($('#rpLead')?.value) || 0)), 0.6 * (performance.now() - playStartedAt) / 1000);
  const clip = curClip(), hp = nextHold();
  syncPoseAt(Math.min(S.time + lead, hp ? hp.t : clip.duration));      // 로봇이 늦는 만큼(실측 약 1초) 앞선 자세를 보내되, 멈춤 지점 너머는 미리 보내지 않는다
  const cur = (clip.eyes || []).filter((x) => x.t <= S.time + 1e-6).pop(), mode = cur && !cur.eL && !cur.eR && cur.e;
  if (mode && mode !== syncEye) { syncEye = mode; robot.eyes(mode); }
}, 100);
function sampleJoints(clip) {                                 // 0.1초 간격 {t, neck, head, tilt, body}
  const ids = jointIds(), out = [], n = Math.round(clip.duration / STEP);
  for (let i = 0; i <= n; i++) {
    const t = Math.min(i * STEP, clip.duration), f = { t: +(i * STEP).toFixed(1) };
    for (const j of ['neck', 'head', 'tilt', 'body']) f[j] = jointDeg(clip, ids[j], JOINT_AXES[j], t);
    out.push(f);
  }
  return out;
}
function buildRobotExport(opt) {
  const used = new Set(), files = [], lines = [], scenes = [], sceneEyes = {};
  S.clips.forEach((c, i) => {
    let name = webSceneName(c.name, i); while (used.has(name)) name += '_' + i; used.add(name);
    const fr = sampleJoints(c), rp = report(fr, opt);
    files.push({ name: `motions/${name}.csv`, text: csvOf(fr, opt) });
    if (c.eyes?.length) sceneEyes[name] = c.eyes.map(({ t, e, gx, eL, eR }) => ({ t, e, gx, eL, eR }));
    scenes.push(`    "${name}": [{"motion": "${name}"}],   # ${c.name}`);
    const cut = ['neck', 'head', 'tilt', 'body'].filter((j) => rp.secs[j] > 0).map((j) => `${{ neck: '기둥', head: '머리', tilt: '갸웃', body: '몸통' }[j]} ${rp.secs[j].toFixed(1)}초(최대 ${rp.diff[j].toFixed(0)}°)`);
    lines.push({ name: c.name, file: name, sec: +c.duration.toFixed(1), cut, fast: rp.fast, acc: rp.acc });
  });
  files.push({ name: 'cove_eyes.json', text: JSON.stringify(eyesJson(sceneEyes), null, 1) });
  files.push({ name: 'cove_scenes_web.py', text: `# 웹 모션(motions/*.csv)을 재생하는 씬. cove_scenes.py 에 합치거나 이름만 옮겨 쓰세요.\n# 재생 확인용: python3 cove_cmd.py web_rest\nWEB_SCENES = {\n${scenes.join('\n')}\n}\n` });
  files.push({ name: '읽어보세요.txt', text: [
    '웹 모션 → 로봇 파일', '',
    '1) motions/*.csv 를 로봇의 ~/robot-booth/motions/ 에 넣습니다. (첫 줄 t,id1,id2,id3,id4 · 0.1초 간격 · 절대 틱)',
    '2) cove_scenes_web.py 의 씬을 cove_scenes.py 에 추가합니다. (저장하면 자동 반영)',
    '   (눈 표정: cove_eyes.json — 4줄 비트맵 16종 + 깜빡임 + 씬별 표정 시간표. 로봇 기준 좌우입니다)',
    '3) 웹 동작 목록에서 "▶ 웹과 같은 모션"을 누르면 실행됩니다.', '',
    `갸웃(ID4) 방향: 웹 tilt + 일 때 ID4 ${opt.tiltSign > 0 ? '+' : '-'}  /  몸통(ID1) 방향: 웹 body + 일 때 ID1 ${opt.bodySign > 0 ? '+' : '-'}  (확정 전이면 check_tilt / check_body 결과로 맞추세요)`, '',
    '로봇 한계로 잘린 구간', ...lines.map((l) => `- ${l.name} (${l.file}, ${l.sec}초): ${l.cut.length ? l.cut.join(', ') : '잘림 없음'}`),
  ].join('\n') + '\n' });
  return { blob: zip(files), lines };
}

function refreshAll() { buildTree(); updateProps(); updateTimeLabel(); drawTL(); }
/* 장면(구간) 버튼: 버튼을 누르면 그 장면으로 가서 바로 움직인다(그 장면만 반복). [전체]를 누르면 처음부터 끝까지 이어서 재생한다. */
const sceneMarks = () => curClip()?.markers || [];
const sceneIndex = (t) => { let i = 0; sceneMarks().forEach((m, k) => { if (t >= m.t - 1e-6) i = k; }); return i; };
const sceneRange = (i) => { const m = sceneMarks(); return [m[i].t, i + 1 < m.length ? m[i + 1].t : curClip().duration]; };
function gotoScene(i) {
  const m = sceneMarks(); if (!m.length) return;
  setTime(m[Math.max(0, Math.min(m.length - 1, i))].t);
}
function stepScene(dir) {
  const i = sceneIndex(S.time);
  if (S.heldAt != null) { S.heldAt = null; refreshHoldUI(); }      // 멈춰서 기다리던 중이어도 단계 버튼은 바로 먹는다
  if (dir < 0) gotoScene(S.time - sceneRange(i)[0] > 0.5 ? i : i - 1); else gotoScene(i + 1);
  updateSceneTag();
}
function playScene(i) { S.sceneLoop = true; gotoScene(i); if (!S.playing) togglePlay(); updateSceneTag(); }
function playAll() { S.sceneLoop = false; setTime(0); if (!S.playing) togglePlay(); updateSceneTag(); }
let chipKey = '';
function updateSceneTag() {
  const el = $('#sceneTag'), marks = sceneMarks();
  if (!el) return;
  if (!marks.length) { el.hidden = true; $('#situation').hidden = true; $('#vpActions').hidden = true; refreshHoldUI(); return; }
  const i = sceneIndex(S.time), byName = curClip().group === '표정';
  el.hidden = false;
  const box = $('#sceneChips'), key = `${S.clip}|${marks.length}`;
  if (chipKey !== key) {                                   // 칩은 클립이 바뀔 때만 다시 만든다
    chipKey = key; box.innerHTML = '';
    const all = document.createElement('button'); all.className = 'chip all'; all.textContent = '▶ 전체'; all.onclick = playAll; box.appendChild(all);
    marks.forEach((m, k) => {
      const b = document.createElement('button'); b.className = byName ? 'chip' : 'chip num'; b.textContent = byName ? m.label : String(k + 1);
      b.onclick = () => {
        if (byName && $('#sitKeep')?.checked) { eyes?.show(m.label); if (robot.connected) robot.eyes(m.label, true); toast(`${m.label} · 앉은 채로 눈만 바뀌어요`); return; }   // 앉아 있을 땐 몸은 움직이지 않고 눈만 바꾼다
        playScene(k); if (byName && robot.connected) robot.eyes(m.label, true);
      };   // 표정 버튼은 연결된 로봇의 눈도 바로 바꾼다
      box.appendChild(b);
    });
  }
  box.children[0].classList.toggle('on', !S.sceneLoop);
  [...box.children].slice(1).forEach((b, k) => { b.classList.toggle('on', S.sceneLoop && k === i); b.classList.toggle('cur', k === i); });
  refreshHoldUI();
  const mk = marks[i], sit = $('#situation');
  sit.textContent = mk.desc || mk.label; sit.hidden = false;       // 뷰포트 아래쪽에 지금 상황을 보여 준다
  $('#vpActions').hidden = false;
  // 오른쪽 위: 몇 장면 중 몇 단계인지, 그리고 바로 앞·뒤 단계가 무엇인지(이름만). 매 프레임 불리므로 바뀔 때만 쓴다
  const stepTxt = `${i + 1} / ${marks.length} 단계`, pn = i > 0 ? marks[i - 1].label : '(처음 단계예요)', nn = i < marks.length - 1 ? marks[i + 1].label : '(마지막 단계예요)';
  if ($('#vpStep').textContent !== stepTxt) $('#vpStep').textContent = stepTxt;
  if ($('#vpPrevName').textContent !== pn) { $('#vpPrevName').textContent = pn; $('#vpPrev').title = `이전 단계: ${pn} ([)`; }
  if ($('#vpNextName').textContent !== nn) { $('#vpNextName').textContent = nn; $('#vpNext').title = `다음 단계: ${nn} (])`; }
}
function updateTimeLabel() {
  updateSceneTag();
  $('#timeLabel').textContent = `${Math.round(S.time * fps())} / ${S.time.toFixed(2)}s`;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 1800);
}

/* ───────────── 타임라인 ───────────── */
const tlc = $('#tl'), ctx = tlc.getContext('2d');
const BAND = 22;
const TL = { LW: 150, RULER: 26, RH: 26, pps: 120, sx: 0, sy: 0, w: 0, h: 0, drag: null };
const tlTop = () => TL.RULER + (curClip()?.markers?.length ? BAND : 0);

function resizeTL() {
  const r = tlc.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  TL.w = r.width; TL.h = r.height;
  tlc.width = r.width * dpr; tlc.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawTL();
}
new ResizeObserver(resizeTL).observe(tlc);

function tlRows() {
  if (!S.model || !$('#tlBones')?.checked) return [];                 // 평소에는 본 줄을 숨기고 장면·눈 줄만 보인다 ("본 트랙"을 켜면 보인다)
  const rows = [...S.boneIdx];
  const clip = curClip();
  for (const idx in clip.tracks) if (clip.tracks[idx].length && !rows.includes(+idx)) rows.push(+idx);
  if (S.sel && !rows.includes(S.idxOf.get(S.sel))) rows.push(S.idxOf.get(S.sel));
  return rows;
}
const PAD = 12;
const t2x = (t) => TL.LW + PAD + t * TL.pps - TL.sx;
const x2t = (x) => (x - TL.LW - PAD + TL.sx) / TL.pps;

function drawTL() {
  if (!S.model || !TL.w) return;
  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim();
  const { LW, RH, w, h } = TL;
  const RUL = TL.RULER, RULER = tlTop();
  const clip = curClip(), rows = tlRows(), f = clip.fps;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = C('--panel'); ctx.fillRect(0, 0, w, h);

  // 클립 길이 밖 영역
  const endX = t2x(clip.duration);
  ctx.fillStyle = '#0005'; ctx.fillRect(Math.max(endX, LW), RULER, w, h);

  // 행
  rows.forEach((idx, r) => {
    const y = RULER + r * RH - TL.sy;
    if (y + RH < RULER || y > h) return;
    ctx.fillStyle = idx === S.idxOf.get(S.sel) ? C('--rowsel') : (r % 2 ? C('--row1') : C('--row2'));
    ctx.fillRect(LW, y, w - LW, RH);
    const keys = clip.tracks[idx] || [];
    if (keys.length) {
      const cy = y + RH / 2, xa = t2x(keys[0].t), xb = t2x(keys[keys.length - 1].t);
      const pitch = keys.length > 1 ? (xb - xa) / (keys.length - 1) : 99;
      const dense = pitch < 24;                       // 키가 촘촘하면 마름모를 줄줄이 찍지 않고 하나의 띠로 보여준다
      const l = Math.max(xa, LW), rr = Math.min(xb, w);
      if (rr > l) {                                   // 첫 키 ~ 마지막 키 구간
        ctx.beginPath(); ctx.rect(l, cy - (dense ? 5 : 1), rr - l, dense ? 10 : 2);
        ctx.fillStyle = dense ? '#4c4739' : '#55503f'; ctx.fill();
        if (dense) { ctx.fillStyle = 'rgba(239,217,174,.8)'; ctx.fillRect(l + 5, cy - 5, Math.max(0, rr - l - 10), 1); }
      }
      keys.forEach((k) => {
        const x = t2x(k.t);
        if (x < LW - 8 || x > w + 8) return;
        const sel = S.selKeys.has(k), now = Math.abs(k.t - S.time) < EPS;
        if (dense && !sel && !now) return;            // 촘촘할 땐 선택한 키와 현재 키만 마름모로
        const r = sel || now ? 6 : 4.5;
        ctx.beginPath(); ctx.moveTo(x, cy - r); ctx.lineTo(x + r, cy); ctx.lineTo(x, cy + r); ctx.lineTo(x - r, cy); ctx.closePath();
        ctx.fillStyle = sel ? '#fff' : (now ? C('--accent') : '#d9d2c4'); ctx.fill();
        if (sel) { ctx.strokeStyle = C('--accent'); ctx.lineWidth = 2; ctx.stroke(); }
      });
      const hk = TL.hover;                              // 마우스가 올라간 키: 빛 번짐 + 큰 마름모 + 시간 표시
      if (hk && keys.includes(hk)) {
        const x = t2x(hk.t);
        if (x >= LW - 8 && x <= w + 8) {
          ctx.strokeStyle = 'rgba(239,217,174,.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 0.5, RULER); ctx.lineTo(x + 0.5, h); ctx.stroke();   // 같은 시간의 세로 안내선
          const g = ctx.createRadialGradient(x, cy, 0, x, cy, 18);
          g.addColorStop(0, 'rgba(239,217,174,.75)'); g.addColorStop(0.45, 'rgba(239,217,174,.28)'); g.addColorStop(1, 'rgba(239,217,174,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, cy, 18, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.moveTo(x, cy - 7.5); ctx.lineTo(x + 7.5, cy); ctx.lineTo(x, cy + 7.5); ctx.lineTo(x - 7.5, cy); ctx.closePath();
          ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = C('--accent'); ctx.lineWidth = 2; ctx.stroke();
          const label = `${hk.t.toFixed(2)}초`; ctx.font = `600 11px ${FONT}`; ctx.textBaseline = 'middle';
          const tw = ctx.measureText(label).width + 12, lx = Math.min(Math.max(x - tw / 2, LW + 2), w - tw - 2), ly = cy - 22;
          ctx.fillStyle = 'rgba(20,20,19,.92)'; ctx.fillRect(lx, ly - 9, tw, 18);
          ctx.fillStyle = C('--accent'); ctx.fillText(label, lx + 6, ly);
        }
      }
    }
  });

  // 눈 행(키는 표정 블록으로 표시)
  {
    const y = RULER + rows.length * RH - TL.sy;
    if (y + RH >= RULER && y <= h) {
      ctx.fillStyle = C('--row2'); ctx.fillRect(LW, y, w - LW, RH);
      (clip.eyes || []).forEach((k, i, arr) => {
        const x0 = t2x(k.t), x1 = t2x(i + 1 < arr.length ? arr[i + 1].t : clip.duration);
        if (x1 < LW || x0 > w) return;
        const l = Math.max(x0, LW);
        ctx.fillStyle = '#3a3428'; ctx.fillRect(l, y + 4, Math.max(2, x1 - l - 1), RH - 8);
        ctx.fillStyle = C('--accent'); ctx.fillRect(l, y + 4, 2, RH - 8);
        ctx.save(); ctx.beginPath(); ctx.rect(l, y, Math.max(2, x1 - l - 1), RH); ctx.clip();
        ctx.fillStyle = C('--text'); ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle';
        ctx.fillText((k.eL || k.eR ? `왼 ${k.eL || k.e} · 오 ${k.eR || k.e}` : k.e) + ((k.gx || k.gy) ? ` (${k.gx || 0},${k.gy || 0})` : ''), l + 6, y + RH / 2);
        ctx.restore();
      });
    }
  }

  // 눈금
  ctx.fillStyle = C('--panel'); ctx.fillRect(LW, 0, w - LW, RUL);
  const steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
  const major = steps.find((s) => s * TL.pps >= 70) || 60;
  ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle';
  const t0 = Math.max(0, Math.floor(x2t(LW) / major) * major), t1 = x2t(w);
  if (TL.pps / f >= 6) {
    ctx.strokeStyle = '#3a3834'; ctx.beginPath();
    for (let fr = Math.floor(x2t(LW) * f); fr / f <= t1; fr++) {
      const x = Math.round(t2x(fr / f)) + 0.5;
      if (x < LW) continue; ctx.moveTo(x, RUL - 5); ctx.lineTo(x, RUL);
    }
    ctx.stroke();
  }
  for (let t = t0; t <= t1; t += major) {
    const x = Math.round(t2x(t)) + 0.5;
    if (x < LW) continue;
    ctx.strokeStyle = '#5a564e'; ctx.beginPath(); ctx.moveTo(x, RUL - 12); ctx.lineTo(x, h); ctx.globalAlpha = 0.35; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.fillStyle = C('--dim'); ctx.fillText(t.toFixed(major < 1 ? 2 : 0) + 's', x + 4, 9);
  }
  // 장면 구간: 눈금 아래 띠로 표시하고 현재 장면을 강조한다
  const marks = clip.markers || [];
  marks.forEach((m, i) => {
    const x0 = t2x(m.t), x1 = t2x(i + 1 < marks.length ? marks[i + 1].t : clip.duration);
    if (x1 < LW || x0 > w) return;
    const cur = S.time >= m.t - 1e-6 && (i + 1 >= marks.length || S.time < marks[i + 1].t - 1e-6);
    const l = Math.max(x0, LW);
    ctx.fillStyle = cur ? '#4a4234' : (i % 2 ? '#201f1d' : '#191917'); ctx.fillRect(l, RUL, x1 - l - 1, BAND - 2);
    if (cur) { ctx.fillStyle = C('--accent'); ctx.fillRect(l, RUL, x1 - l - 1, 2); }
    ctx.save(); ctx.beginPath(); ctx.rect(l, RUL, x1 - l - 1, BAND); ctx.clip();
    ctx.fillStyle = cur ? '#fff' : C('--dim'); ctx.font = `${cur ? 600 : 400} 11px ${FONT}`; ctx.textBaseline = 'middle';
    ctx.fillText(m.label, Math.max(x0, LW) + 6, RUL + BAND / 2 - 0.5);
    ctx.restore();
    if (x0 >= LW) { ctx.strokeStyle = '#5a564e'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, RULER); ctx.lineTo(Math.round(x0) + 0.5, h); ctx.stroke(); ctx.setLineDash([]); }
  });

  // 길이 끝 선
  ctx.strokeStyle = '#8a8579'; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(endX + 0.5, RULER); ctx.lineTo(endX + 0.5, h); ctx.stroke(); ctx.globalAlpha = 1;

  // 라벨 열
  ctx.fillStyle = C('--panel'); ctx.fillRect(0, 0, LW, h);
  ctx.strokeStyle = C('--line'); ctx.beginPath(); ctx.moveTo(LW + 0.5, 0); ctx.lineTo(LW + 0.5, h); ctx.stroke();
  ctx.textBaseline = 'middle';
  rows.forEach((idx, r) => {
    const y = RULER + r * RH - TL.sy;
    if (y + RH < RULER || y > h) return;
    const sel = idx === S.idxOf.get(S.sel);
    ctx.fillStyle = sel ? C('--rowsel') : (r % 2 ? C('--row1') : C('--row2')); ctx.fillRect(0, y, LW, RH);
    const has = (clip.tracks[idx] || []).length;
    ctx.fillStyle = has ? C('--key') : '#5a564e'; ctx.beginPath(); ctx.arc(12, y + RH / 2, 3.5, 0, 7); ctx.fill();
    ctx.fillStyle = sel ? '#fff' : C('--text'); ctx.font = `12px ${FONT}`;
    ctx.fillText(nodeName(idx), 24, y + RH / 2, LW - 30);
  });
  {
    const y = RULER + rows.length * RH - TL.sy;
    if (y + RH >= RULER && y <= h) {
      ctx.fillStyle = C('--row2'); ctx.fillRect(0, y, LW, RH);
      ctx.fillStyle = (clip.eyes || []).length ? C('--key') : '#5a564e'; ctx.beginPath(); ctx.arc(12, y + RH / 2, 3.5, 0, 7); ctx.fill();
      ctx.fillStyle = C('--text'); ctx.font = `12px ${FONT}`; ctx.textBaseline = 'middle'; ctx.fillText('눈 (8×8 도트)', 24, y + RH / 2, LW - 30);
    }
  }
  ctx.fillStyle = C('--panel'); ctx.fillRect(0, 0, LW, RULER);
  if (marks.length) { ctx.fillStyle = C('--dim'); ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle'; ctx.fillText('장면', 12, RUL + BAND / 2); }

  // 눈 그림을 끌어 놓을 위치 표시
  if (TL.dropT != null) { const dx = t2x(TL.dropT); ctx.strokeStyle = C('--accent'); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(dx, 0); ctx.lineTo(dx, h); ctx.stroke(); ctx.setLineDash([]); }

  // 플레이헤드
  const px = t2x(S.time);
  if (px >= LW) {
    ctx.strokeStyle = C('--accent'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = C('--accent'); ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 6, 0); ctx.lineTo(px, 10); ctx.fill();
  }
}

function tlHit(x, y) {
  const rows = tlRows();
  const r = Math.floor((y - tlTop() + TL.sy) / TL.RH);
  const idx = rows[r];
  if (idx === undefined) return {};
  const keys = curClip().tracks[idx] || [];
  let key = null, best = 8;                           // 마우스에 가장 가까운 키 (8px 안)
  for (const k of keys) { const d = Math.abs(t2x(k.t) - x); if (d <= best) { best = d; key = k; } }
  return { idx, key };
}

tlc.addEventListener('pointerdown', (e) => {
  const rect = tlc.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
  tlc.setPointerCapture(e.pointerId);
  if (y < TL.RULER && x >= TL.LW) { TL.drag = { type: 'scrub' }; setTime(x2t(x)); return; }
  if (y < tlTop() && x >= TL.LW) {            // 장면 띠 클릭 → 그 장면의 시작으로 이동
    const marks = curClip().markers || [], t = x2t(x);
    const m = [...marks].reverse().find((mm) => mm.t <= t + 1e-6);
    if (m) setTime(m.t);
    return;
  }
  const hit = tlHit(x, y);
  if (x < TL.LW) { if (hit.idx !== undefined) select(S.nodes.get(hit.idx)); return; }
  if (hit.idx !== undefined && S.nodes.get(hit.idx) !== S.sel) select(S.nodes.get(hit.idx));
  if (hit.key) {
    if (e.shiftKey) { S.selKeys.has(hit.key) ? S.selKeys.delete(hit.key) : S.selKeys.add(hit.key); }
    else if (!S.selKeys.has(hit.key)) { S.selKeys.clear(); S.selKeys.add(hit.key); }
    const origin = new Map();
    for (const idx in curClip().tracks) curClip().tracks[idx].forEach((k) => S.selKeys.has(k) && origin.set(k, k.t));
    TL.drag = { type: 'keys', x0: x, origin, moved: false };
    updateProps(); drawTL();
  } else {
    if (!e.shiftKey) S.selKeys.clear();
    TL.drag = { type: 'scrub' }; setTime(x2t(x));
  }
});
// 마우스를 올리면 키가 빛나며 "여기를 선택할 수 있다"고 알려준다 (촘촘한 키 띠에서도 가까운 키 하나가 나타남)
tlc.addEventListener('pointermove', (e) => {
  if (!TL.drag) {
    const rect = tlc.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const hit = x >= TL.LW && y >= tlTop() ? tlHit(x, y) : {};
    const next = hit.key || null;
    tlc.style.cursor = next ? 'pointer' : (x >= TL.LW && y < TL.RULER ? 'ew-resize' : 'default');
    if (next !== TL.hover) { TL.hover = next; drawTL(); }
    return;
  }
  const d = TL.drag; if (!d) return;
  const rect = tlc.getBoundingClientRect(), x = e.clientX - rect.left;
  if (d.type === 'scrub') setTime(x2t(Math.max(x, TL.LW)));
  else if (d.type === 'keys') {
    const df = Math.round(((x - d.x0) / TL.pps) * fps());
    const minT = Math.min(...d.origin.values());
    const delta = Math.max(df / fps(), -minT);
    if (Math.abs(delta) > EPS) d.moved = true;
    d.origin.forEach((t0, k) => { k.t = +(t0 + delta).toFixed(5); });
    applyPose(S.time); drawTL();
  }
});
tlc.addEventListener('pointerup', () => {
  const d = TL.drag; TL.drag = null;
  if (d?.type === 'keys' && d.moved) {
    const c = curClip();
    for (const idx in c.tracks) {
      const ks = c.tracks[idx];
      // 이동한 키가 겹친 기존 키는 덮어쓴다
      c.tracks[idx] = ks.filter((k) => S.selKeys.has(k) || !ks.some((o) => S.selKeys.has(o) && Math.abs(o.t - k.t) < EPS));
      c.tracks[idx].sort((a, b) => a.t - b.t);
    }
    applyPose(S.time); snapshot();
  }
});
tlc.addEventListener('pointerleave', () => { if (TL.hover) { TL.hover = null; drawTL(); } });
tlc.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const rect = tlc.getBoundingClientRect(), x = e.clientX - rect.left, t = x2t(x);
    TL.pps = Math.max(30, Math.min(600, TL.pps * Math.exp(-e.deltaY * 0.01)));
    TL.sx = Math.max(0, t * TL.pps - (x - TL.LW - PAD));
    $('#zoom').value = TL.pps;
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    TL.sx = Math.max(0, TL.sx + (e.deltaX || e.deltaY));
  } else {
    const max = Math.max(0, (tlRows().length + 1) * TL.RH - (TL.h - tlTop()));
    TL.sy = Math.max(0, Math.min(max, TL.sy + e.deltaY));
  }
  drawTL();
}, { passive: false });
$('#zoom').addEventListener('input', (e) => { TL.pps = +e.target.value; drawTL(); });

/* ───────────── 뷰포트 선택 ───────────── */
const ray = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || !S.model) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
  if (moved > 4 || tc.dragging || tc.axis) return;
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  if ($('#showBones').checked) {
    const m = ray.intersectObjects(markers.map((k) => k.mesh), false)[0];
    if (m) return select(S.nodes.get(m.object.userData.idx));
  }
  const hit = ray.intersectObject(S.model, true)[0];
  if (!hit) return;
  const boneSet = new Set(S.boneIdx);
  let o = hit.object, fallback = null;
  while (o) {
    if (S.idxOf.has(o)) { fallback = o; if (boneSet.has(S.idxOf.get(o))) return select(o); }
    o = o.parent;
  }
  if (fallback) select(fallback);
});

/* ───────────── GLB 내보내기 (원본 리그 유지 + 애니메이션 교체) ───────────── */
function exportGLB() {
  const { json, bin, name } = S.glb;
  const J = JSON.parse(JSON.stringify(json));
  J.accessors = J.accessors || []; J.bufferViews = J.bufferViews || [];
  const chunks = [];
  let offset = bin.byteLength;
  const push = (arr, type, count, minmax) => {
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    J.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const acc = { bufferView: J.bufferViews.length - 1, componentType: 5126, count, type };
    if (minmax) { acc.min = minmax[0]; acc.max = minmax[1]; }
    J.accessors.push(acc);
    chunks.push(bytes); offset += bytes.length;
    return J.accessors.length - 1;
  };
  const differs = (list, base) => list.some((v) => v.some((x, i) => Math.abs(x - base[i]) > 1e-6));

  J.animations = S.clips.map((clip) => {
    const anim = { name: clip.name, samplers: [], channels: [] };
    for (const idxStr in clip.tracks) {
      const idx = +idxStr;
      let keys = clip.tracks[idx];
      if (!keys.length) continue;
      const modes = new Set(keys.slice(0, -1).map((k) => k.i));
      let interp = 'LINEAR';
      if (modes.size === 1 && modes.has('step')) interp = 'STEP';
      else if (modes.has('smooth') || modes.size > 1) {
        // 키마다 보간이 다르면 매 프레임으로 구워서 내보낸다
        const baked = [];
        const end = keys[keys.length - 1].t;
        for (let t = keys[0].t; t < end - EPS; t += 1 / clip.fps) baked.push({ t, ...sampleAt(keys, t) });
        baked.push(keys[keys.length - 1]);
        keys = baked;
      }
      const rest = S.rest.get(idx);
      const times = new Float32Array(keys.map((k) => k.t));
      const input = push(times, 'SCALAR', times.length, [[times[0]], [times[times.length - 1]]]);
      const add = (path, list, base, type, n) => {
        const out = push(new Float32Array(list.flat()), type, list.length);
        anim.samplers.push({ input, output: out, interpolation: interp });
        anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: idx, path } });
      };
      const pp = keys.map((k) => k.p), qq = keys.map((k) => k.q), ss = keys.map((k) => k.s);
      if (differs(pp, rest.p)) add('translation', pp, rest.p, 'VEC3');
      if (differs(qq, rest.q) || !(differs(pp, rest.p) || differs(ss, rest.s))) add('rotation', qq, rest.q, 'VEC4');
      if (differs(ss, rest.s)) add('scale', ss, rest.s, 'VEC3');
    }
    return anim;
  }).filter((a) => a.channels.length);
  if (!J.animations.length) delete J.animations;

  const binLen = offset;
  J.buffers = [{ byteLength: binLen }];
  const jsonBytes = new TextEncoder().encode(JSON.stringify(J));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLen;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true); dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  let p = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(p, binLen, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  out.set(new Uint8Array(bin), p); p += bin.byteLength;
  chunks.forEach((c) => { out.set(c, p); p += c.length; });
  download(new Blob([out], { type: 'model/gltf-binary' }), name.replace(/\.glb$/i, '') + '_animated.glb');
  toast(`내보내기 완료 (애니메이션 ${J.animations?.length || 0}개)`);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ───────────── 이벤트 연결 ───────────── */
// 아래 재생 버튼·스페이스는 "전체 재생": 번호 칩으로 한 장면만 보던 상태를 풀어서, 멈춤 지점(반응하기·숙이기)이 항상 동작하게 한다
const playMain = () => { if (!S.playing) S.sceneLoop = false; togglePlay(); };
$('#tPlay').onclick = playMain;
$('#tStart').onclick = () => setTime(0);
$('#tEnd').onclick = () => setTime(curClip().duration);
$('#tPrev').onclick = () => { stopPlay(); setTime(S.time - 1 / fps()); };
$('#tNext').onclick = () => { stopPlay(); setTime(S.time + 1 / fps()); };
$('#loop').onchange = (e) => (S.loop = e.target.checked);
$('#autoKey').onchange = (e) => (S.autoKey = e.target.checked);
$('#showAll').onchange = (e) => { S.showAll = e.target.checked; buildTree(); };
$('#showBones').onchange = () => {};
// 머리 들기·숙이기는 머리만 움직인다. 로봇이 연결돼 있으면 기둥·갸웃·몸통은 화면 모델 값이 아니라 로봇의 지금 값 그대로 둔다
// (그러지 않으면 앉아 있는 로봇이 화면 모델의 기둥 높이를 따라 일어난다)
function moveHeadOnly(v) {
  if (takeOverPose()) restoreEyes();                               // 반응이 돌고 있었으면 멈추고(두 곳에서 자세를 보내지 않게) 그 반응의 눈도 되돌린다
  const d = robot.connected ? robot.deg : null;
  setJoint('head', v);
  if (d) {
    const [tl, th] = jtLimits('tilt');
    Object.assign(jtVal, { neck: d.neck, tilt: Math.max(tl, Math.min(th, d.tilt)), body: d.body });
    applyManual(); renderJoint();
  }
}
$('#headUp').onclick = () => {
  if (!S.model) return;
  moveHeadOnly(HEAD_UP);
  eyes?.show('뜬 눈'); if (robot.connected) robot.eyes('뜬 눈');          // 머리를 들 때는 눈을 뜬 눈으로
};
$('#headDown').onclick = () => { if (!S.model) return; const cur = readJointAngles().head; moveHeadOnly(cur * 0.5); };   // 절반만 숙인다 (예: -30° → -15°)
$('#vpPrev').onclick = () => stepScene(-1);
$('#vpNext').onclick = () => stepScene(1);
{ const setView = (open) => { $('#viewBody').classList.toggle('closed', !open); $('#viewHead').setAttribute('aria-expanded', open ? 'true' : 'false'); try { localStorage.setItem('cove-view-open', open ? '1' : '0'); } catch { /* 무시 */ } };
  $('#viewHead').onclick = () => setView($('#viewBody').classList.contains('closed'));
  let was = true; try { was = localStorage.getItem('cove-view-open') !== '0'; } catch { /* 무시 */ } setView(was); }
$('#robotLimit').onchange = () => { applyPose(S.time); refreshAll(); };
{ const el = $('#rpLead'); try { const v = localStorage.getItem('cove-sync-lead'); if (v !== null && el) el.value = v; } catch { /* 무시 */ } if (el) { el.onchange = () => { try { localStorage.setItem('cove-sync-lead', el.value); } catch { /* 무시 */ } }; el.onkeydown = (e) => e.stopPropagation(); } }
$('#robotSpeed').onchange = () => { RV.cur = null; applyPose(S.time); refreshAll(); };
$('#rpTiltSign')?.addEventListener('change', () => applyPose(S.time));
$('#opacity').oninput = applyOpacity;
$('#camReset').onclick = fitCamera;
EXPRESSIONS.forEach((n) => $('#eyeSel').add(new Option(n, n)));
// 양쪽 표정 선택 / 눈 만들기 독 (눈 그림을 끌어 놓기)
/* 표정 쓸어서 고르기: 줄 위에서 마우스를 누른 채 좌우로 끌면 그 위치의 표정이 뷰포트(와 연결된 로봇)에 바로 나온다 */
{
  const track = $('#esTrack'), thumb = $('#esThumb'), name = $('#esName'), n = EXPRESSIONS.length;
  const pos = (i) => ((i + 0.5) / n) * 100;
  EXPRESSIONS.forEach((_, i) => { const d = document.createElement('i'); d.style.left = pos(i) + '%'; track.insertBefore(d, thumb); });
  let cur = -1, drag = false, sendT = 0;
  const pick = (ev) => {
    const r = track.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor(((ev.clientX - r.left) / r.width) * n)));
    if (i === cur) return;
    cur = i; const e = EXPRESSIONS[i];
    thumb.style.left = pos(i) + '%'; name.textContent = e;
    eyes?.show(e);
    clearTimeout(sendT); sendT = setTimeout(() => { if (robot.connected) robot.eyes(e, true); }, 120);   // 쓸어 지나가는 동안은 멈춘 표정만 로봇에 보낸다
  };
  track.onpointerdown = (ev) => { ev.preventDefault(); drag = true; track.setPointerCapture(ev.pointerId); pick(ev); };
  track.onpointermove = (ev) => { if (drag) pick(ev); };
  track.onpointerup = track.onpointercancel = () => { drag = false; };
}
$('#eyeSel').onchange = (e) => {                 // 선택한 표정을 현재 시간의 눈 키로 기록한다
  if (!curClip()) return;
  setEyeKey(S.time, { e: e.target.value }); applyEyes(S.time); snapshot();
};
/* ───────────── 관절 조작: 슬라이더로 관절을 손으로 움직여 최소·최대를 본다 ───────────── */
const JT = [['neck', '기둥'], ['head', '머리'], ['tilt', '갸웃'], ['body', '몸통']];
function jtLimits(k) {                                           // [최소, 최대] (도). 갸웃은 지금 머리 각도에 따라 달라진다
  if (k === 'tilt') { const [lo, hi] = tiltRange(jtVal.head), sg = +($('#rpTiltSign')?.value || 1); return sg > 0 ? [lo, hi] : [-hi, -lo]; }
  return LIMITS[k];
}
const jtOpen = () => !$('#jointBody').classList.contains('closed');
function jtIds() { if (!jointCache || jointCache.model !== S.model) jointCache = { model: S.model, ids: jointIds() }; return jointCache.ids; }
function readJointAngles() {                                     // 모델에 지금 보이는 각도
  const ids = jtIds(), out = {};
  for (const j of ['neck', 'head', 'tilt', 'body']) {
    if (ids[j] === undefined) { out[j] = 0; continue; }
    const rest = S.rest.get(ids[j]), ax = JOINT_AXES[j];
    const qr = new THREE.Quaternion().fromArray(rest.q).invert().multiply(S.nodes.get(ids[j]).quaternion);
    let a = 2 * Math.atan2(ax.x * qr.x + ax.y * qr.y + ax.z * qr.z, qr.w);
    if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
    out[j] = a / D2R;
  }
  return out;
}
function renderJoint() {
  for (const [k] of JT) {
    const u = jtUI[k], [lo, hi] = jtLimits(k), v = jtVal[k];
    u.sl.min = lo; u.sl.max = hi; u.sl.value = v;
    if (document.activeElement !== u.num) u.num.value = (+v).toFixed(1);
    u.lo.textContent = `최소 ${(+lo).toFixed(1)}°`; u.hi.textContent = `최대 ${(+hi).toFixed(1)}°`;
    u.cur.textContent = v <= lo + 0.05 ? '최소에 닿음' : v >= hi - 0.05 ? '최대에 닿음' : v < lo - 0.05 || v > hi + 0.05 ? '로봇 범위 밖' : '';
    u.row.classList.toggle('limit', !!u.cur.textContent);
  }
  $('#jointCur').textContent = JT.map(([k, n]) => `${n} ${(+jtVal[k]).toFixed(0)}°`).join(' · ');
}
function refreshJointUI() { if (!S.model || jtDrag || !jtOpen()) return; Object.assign(jtVal, readJointAngles()); renderJoint(); }
function applyManual() {                                         // 슬라이더 값을 네 관절에 적용 (키는 만들지 않는다)
  const ids = jtIds();
  for (const j of ['neck', 'head', 'tilt', 'body']) {
    if (ids[j] === undefined) continue;
    S.nodes.get(ids[j]).quaternion.fromArray(S.rest.get(ids[j]).q).multiply(new THREE.Quaternion().setFromAxisAngle(JOINT_AXES[j], jtVal[j] * D2R));
  }
  try { if (IK) syncTarget(); } catch { /* 무시 */ }
  manualActive = true; drawTL();
}
function setJoint(k, v) {
  if (!S.model) return;
  if (S.playing) stopPlay();
  Object.assign(jtVal, readJointAngles());                       // 다른 관절은 지금 모습 그대로 두고 한 관절만 바꾼다
  const [lo, hi] = jtLimits(k);
  jtVal[k] = Math.max(lo, Math.min(hi, +v || 0));
  if (k === 'head') { const [tl, th] = jtLimits('tilt'); jtVal.tilt = Math.max(tl, Math.min(th, jtVal.tilt)); }
  applyManual(); renderJoint();
}
function initJointPanel() {
  const box = $('#jointRows');
  for (const [k, name] of JT) {
    const row = document.createElement('div'); row.className = 'jt-row';
    row.innerHTML = `<span class="nm">${name}</span><div class="track"><button class="mn" title="최소로">최소</button><input type="range" step="0.5"><button class="mx" title="최대로">최대</button></div><input type="number" step="0.5"><span class="rg"><span class="lo"></span><span class="cur"></span><span class="hi"></span></span>`;
    const u = jtUI[k] = { row, sl: row.querySelector('input[type=range]'), num: row.querySelector('input[type=number]'), lo: row.querySelector('.lo'), hi: row.querySelector('.hi'), cur: row.querySelector('.cur') };
    u.sl.oninput = () => { jtDrag = true; setJoint(k, u.sl.value); };
    u.sl.onchange = u.sl.onblur = () => { jtDrag = false; };
    u.num.onchange = () => setJoint(k, u.num.value);
    u.num.onkeydown = (e) => e.stopPropagation();
    row.querySelector('.mn').onclick = () => setJoint(k, jtLimits(k)[0]);
    row.querySelector('.mx').onclick = () => setJoint(k, jtLimits(k)[1]);
    box.appendChild(row);
  }
  $('#jtRest').onclick = () => { if (!S.model) return; if (S.playing) stopPlay(); Object.assign(jtVal, { neck: 0, head: 0, tilt: 0, body: 0 }); applyManual(); renderJoint(); };
  $('#jtKey').onclick = () => {
    if (!S.model || !curClip()) return;
    const ids = jtIds(), tg = IK?.target ? S.idxOf.get(IK.target) : undefined;
    [ids.neck, ids.head, ids.tilt, ids.body, tg].filter((i) => i !== undefined).forEach((i) => upsertKey(i, S.time));
    snapshot(); toast(`${S.time.toFixed(2)}초에 지금 자세를 키로 찍었어요`);
  };
  $('#jtRobot').onchange = (e) => {
    const r = robot.setSync(e.target.checked);
    if (e.target.checked && r !== 'ok') { e.target.checked = false; toast(r === 'unsafe' ? '연결 창에서 "로봇 주변을 확인했어요"를 체크해 주세요' : '먼저 로봇을 연결해 주세요'); }
  };
  $('#jointHead').onclick = () => {
    const open = !jtOpen();
    $('#jointBody').classList.toggle('closed', !open); $('#jointHead').setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem('cove-joint-open', open ? '1' : '0'); } catch { /* 무시 */ }
    if (open) refreshJointUI();
  };
  let was = false; try { was = localStorage.getItem('cove-joint-open') === '1'; } catch { /* 무시 */ }
  if (was) { $('#jointBody').classList.remove('closed'); $('#jointHead').setAttribute('aria-expanded', 'true'); }
  $('#rpTiltSign')?.addEventListener('change', () => { if (jtOpen()) renderJoint(); });
  renderJoint();
}
initJointPanel();

const eyeDock = initEyeDock({
  getKey: () => eyeKeyAt(S.time),
  edit: (patch) => { if (!curClip()) return; setEyeKey(S.time, patch); applyEyes(S.time); snapshot(); },
  toast,
});
// 타임라인의 눈 줄에 눈 그림을 끌어 놓으면 그 시간(0.1초 단위)부터 바뀐다
const eyeRowAt = (y) => { const top = TL.RULER + (curClip()?.markers?.length ? BAND : 0) + tlRows().length * TL.RH - TL.sy; return y >= top && y < top + TL.RH; };
tlc.addEventListener('dragover', (e) => {
  if (!e.dataTransfer.types.includes(EYE_MIME)) return;
  const r = tlc.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < TL.LW || !eyeRowAt(y)) { if (TL.dropT != null) { TL.dropT = null; drawTL(); } return; }
  e.preventDefault(); TL.dropT = Math.max(0, Math.min(curClip().duration, Math.round(x2t(x) * 10) / 10)); drawTL();
});
tlc.addEventListener('dragleave', () => { if (TL.dropT != null) { TL.dropT = null; drawTL(); } });
tlc.addEventListener('drop', (e) => {
  const t = TL.dropT; TL.dropT = null;
  let d = null; try { d = JSON.parse(e.dataTransfer.getData(EYE_MIME)); } catch { /* 무시 */ }
  if (t == null || !d) { drawTL(); return; }
  e.preventDefault();
  if (d.e) setEyeKey(t, { e: d.e }); else if (d.eL) { setEyeKey(t, { e: d.eL }); setEyeKey(t, { eL: d.eL, eR: d.eR }); }
  setTime(t); applyEyes(t); snapshot(); toast(`${t.toFixed(1)}초부터 눈이 바뀌어요`);
});
$('#btnKey').onclick = () => insertKeys(false);
$('#btnKeyAll').onclick = () => insertKeys(true);
$('#btnDelKey').onclick = deleteKeys;
$('#btnRest').onclick = resetPose;
// 앉기: 재생·멈춤·센서 반응을 멈추고 처음(접힌) 자세로. 연결돼 있고 주변 확인이 되어 있으면 로봇도 home 씬으로 앉는다.
// 사람이 아직 다가와 있는 동안 기둥 올리기가 다시 일으키지 않도록, 그 사람이 떠날 때까지 기둥 올리기를 쉰다
function resetIdleReactions() {                                    // 진행 중이던 센서 반응(톡·쓰다듬기·1번·갸우뚱·일어나기·앉기 뒤 맞추기·일어난 뒤 눈·기둥)을 모두 멈춘다
  [wiggleTimer, tapTimer, armTimer, sideTimer, standTimer, sitIv].forEach((t) => clearInterval(t)); clearTimeout(sitTimer);
  wiggleTimer = tapTimer = armTimer = sideTimer = standTimer = sitIv = sitTimer = 0; standLockUntil = 0;
  armActive = false; armResume = false; armWait = false; armSuppress = false; armBase = null; sideActive = false; happyOn = false; touchState = 'idle'; allTouchSince = 0; allGapAt = 0; standEyesUntil = 0; standHeadAt = 0; followBase = null;
}
// 일어나: 앉은(접힌) 자세에서 기둥 25° · 머리 -34°(깨어난 기본 자세)로 2.2초에 걸쳐 부드럽게 일어난다. 로봇은 연결돼 있으면 지금 로봇의 자세에서, 아니면 화면 자세에서 시작한다
const STAND_POSE = { neck: 25, head: -34, tilt: 0, body: 0 }, STAND_SEC = 2.2;
$('#standUp').onclick = () => {
  if (!S.model) return;
  if (S.playing) stopPlay();
  S.sceneLoop = false; S.heldAt = null; S.released = new Set(); refreshHoldUI(); updateSceneTag();
  takeOverPose(); sitLock = false;                                                                     // 진행 중인 반응을 멈추고 로봇이 씬(앉기 등)을 돌리고 있으면 세운다
  if ($('#sitKeep')) $('#sitKeep').checked = false;                                                    // 일어났으니 표정 버튼이 다시 몸을 움직일 수 있게 한다
  wasSitting = false; eyes?.show('뜬 눈'); if (robot.connected) robot.eyes('뜬 눈');                    // 일어나면서 눈을 뜬다
  standLockUntil = performance.now() + STAND_SEC * 1000 + 2500;
  const from = (robot.connected && robot.deg) ? { ...robot.deg } : readJointAngles(), t0 = performance.now();
  const r1 = (v) => Math.round(v * 10) / 10;
  standTimer = setInterval(() => {
    if (S.playing) { clearInterval(standTimer); standTimer = 0; return; }
    const k = Math.min(1, (performance.now() - t0) / (STAND_SEC * 1000)), e = k * k * (3 - 2 * k), p = {};
    for (const j of ['neck', 'head', 'tilt', 'body']) p[j] = r1(from[j] + (STAND_POSE[j] - from[j]) * e);
    Object.assign(jtVal, p); applyManual(); renderJoint();                                              // 화면 자세를 바꾸면 로봇 동기가 같은 자세를 로봇에 보낸다
    if (k >= 1) { clearInterval(standTimer); standTimer = 0; eyes?.show('뜬 눈'); if (robot.connected) robot.eyes('뜬 눈'); }   // 다 일어나면 눈을 한 번 더 뜬 눈으로 맞춘다 (타이머를 0으로 해야 다른 반응이 다시 시작된다)
  }, 50);
  toast(robot.sync ? '일어나요' : '일어나요 (화면) · 로봇 동기를 켜면 로봇도 일어나요');
};
$('#sitDown').onclick = () => {
  if (S.playing) stopPlay();
  S.sceneLoop = false; S.heldAt = null; S.released = new Set(); refreshHoldUI();
  setTime(0); updateSceneTag();
  followBase = null; sitLock = true;
  if ($('#sitKeep')) $('#sitKeep').checked = true;                                                    // 앉은 뒤에는 표정 버튼이 몸을 움직여 일으키지 않게 한다
  resetIdleReactions();                                                                               // 진행 중이던 반응은 모두 멈춘다 (로봇에 자세를 계속 보내 home 씬을 방해하지 않게)
  wasSitting = true; eyes?.show('감은 눈'); if (robot.connected) robot.eyes('감은 눈');                  // 앉으면서 눈을 감는다
  clearTimeout(sitTimer); clearInterval(sitIv);
  sitTimer = setTimeout(() => {                                                                       // home 씬(3초)이 끝난 뒤 완전히 접힌 자세(0°)로 한 번 더 맞춘다 (그 사이 일어나기 등을 누르면 취소된다)
    sitTimer = 0; if (S.playing || !robot.sync) return;
    let n = 0; sitIv = setInterval(() => { if (S.playing || ++n > 8) { clearInterval(sitIv); sitIv = 0; return; } robot.pose({ neck: 0, head: 0, tilt: 0, body: 0 }); }, 100);
  }, 3500);
  if (robot.connected) { const r = robot.run('home'); toast(r === 'ok' ? '앉아요' : r === 'unsafe' ? '로봇 주변 확인을 체크하면 로봇도 앉아요' : '앉았어요 (화면)'); } else toast('앉았어요 (화면) · 로봇이 연결돼 있지 않아요');
};
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#keyInterp').onchange = (e) => { lastInterp = e.target.value; S.selKeys.forEach((k) => (k.i = e.target.value)); applyPose(S.time); snapshot(); };

document.querySelectorAll('#modeSeg button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
function setMode(m) {
  tc.setMode(m);
  document.querySelectorAll('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
}
$('#spaceBtn').onclick = () => {
  tc.setSpace(tc.space === 'local' ? 'world' : 'local');
  $('#spaceBtn').textContent = tc.space === 'local' ? '로컬' : '월드';
};
tc.setSpace('local');

// 동작 목록에서 시나리오를 누르면(이미 고른 것을 다시 눌러도) 무조건 처음 상태로: 재생을 멈추고 0초, 멈춤 기록·진행 중이던 센서 반응도 모두 초기화
$('#clipSel').onchange = (e) => {
  S.clip = +e.target.value; S.selKeys.clear(); S.released = new Set(); S.heldAt = null; refreshHoldUI();
  if (S.playing) stopPlay();
  S.sceneLoop = false; S.time = 0; resetIdleReactions();
  applyPose(S.time); refreshClipUI(); updateSceneTag(); snapshot();
};
$('#clipNew').onclick = () => { const nc = newClipData(`새 클립 ${S.clips.filter((x) => x.group === '내 클립').length + 1}`); nc.group = '내 클립'; S.clips.push(nc); S.clip = S.clips.length - 1; S.selKeys.clear(); S.time = 0; applyPose(0); refreshClipUI(); snapshot(); };
$('#clipDup').onclick = () => { const c = JSON.parse(JSON.stringify(curClip())); c.name += ' 복사'; c.group = '내 클립'; S.clips.push(c); S.clip = S.clips.length - 1; S.selKeys.clear(); refreshClipUI(); snapshot(); };
// 이름 바꾸기: 브라우저 prompt 대신 목록 줄 안에서 바로 입력한다 (Enter 확정 · Esc 취소)
function startRename(i, rowEl) {
  const row = rowEl || document.querySelector(`#clipList .clip-item[data-i="${i}"]`); if (!row) return;   // 숨긴 클립이 있어서 목록 순서와 클립 번호가 다를 수 있다
  const input = document.createElement('input');
  input.type = 'text'; input.value = S.clips[i].name; input.className = 'rename';
  row.style.display = 'none'; row.parentElement.insertBefore(input, row);   // 버튼 안에 입력칸을 두면 띄어쓰기(스페이스)가 버튼 동작으로 먹혀서, 버튼 옆에 따로 둔다
  input.focus(); input.select();
  let done = false;
  const finish = (ok) => {
    if (done) return; done = true;
    const v = input.value.trim();
    if (ok && v && v !== S.clips[i].name) { S.clips[i].name = v; snapshot(); }
    refreshClipUI();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}
$('#clipRen').onclick = () => startRename(S.clip);
function deleteClipAt(i) {
  if (S.clips.length < 2) return toast('마지막 클립은 삭제할 수 없어요');
  const name = S.clips[i].name;                   // 확인 창 대신 바로 지우고, Ctrl+Z로 되돌릴 수 있게 한다
  if (S.playing) stopPlay();
  S.clips.splice(i, 1); S.clip = i < S.clip ? S.clip - 1 : Math.min(S.clip, S.clips.length - 1); S.selKeys.clear(); S.time = 0; applyPose(0); refreshClipUI(); snapshot();
  toast(`'${name}' 삭제했어요 · Ctrl+Z로 되돌릴 수 있어요`);
}
$('#clipDel').onclick = () => deleteClipAt(S.clip);
$('#clipDur').onchange = (e) => { curClip().duration = Math.max(0.1, +e.target.value || 1); setTime(S.time); snapshot(); };
$('#clipFps').onchange = (e) => { curClip().fps = +e.target.value; setTime(S.time); snapshot(); };
$('#presetAdd').onchange = (e) => {
  const [g, i] = e.target.value.split(':').map(Number);
  const def = PRESET_GROUPS[g]?.items[i]; e.target.value = '';
  if (!def) return;
  S.clips.push(buildPresetClip(def)); S.clip = S.clips.length - 1; S.selKeys.clear(); S.time = 0;
  applyPose(0); refreshClipUI(); snapshot(); toast(`'${def.name}' 추가`);
};
PRESET_GROUPS.forEach((grp, g) => {
  const og = document.createElement('optgroup'); og.label = grp.label;
  grp.items.forEach((d, i) => og.appendChild(new Option(d.name, `${g}:${i}`)));
  $('#presetAdd').appendChild(og);
});
$('#presetAdd').value = '';
document.fonts?.ready.then(drawTL);
$('#clipReimport').onclick = () => {
  S.clips = importClips();
  if (!S.clips.length) S.clips = [newClipData('새 클립')];
  S.clip = 0; S.selKeys.clear(); applyPose(0); S.time = 0; refreshClipUI(); snapshot();
};

// 편집 패널 열기/닫기 (선택을 기억한다). 열려 있으면 [편집] 버튼이 강조 색, 닫혀 있으면 평범한 버튼
function setEditOpen(on) {
  document.body.classList.toggle('edit-open', on);
  $('#editSw').checked = on;
  try { localStorage.setItem('cove-edit-open', on ? '1' : '0'); } catch { /* 무시 */ }
  requestAnimationFrame(() => { resizeView(); resizeTL(); });
}
// 시나리오 창 접기/펼치기 (상태를 기억한다). 접혀 있어도 제목 줄에 지금 선택한 클립 이름이 보인다.
function setClipOpen(open) {
  $('#clipBody').classList.toggle('closed', !open);
  $('#clipHead').setAttribute('aria-expanded', open ? 'true' : 'false');
  try { localStorage.setItem('cove-clip-open', open ? '1' : '0'); } catch { /* 무시 */ }
}
$('#clipHead').onclick = () => setClipOpen($('#clipBody').classList.contains('closed'));
let clipOpenSaved = true; try { clipOpenSaved = localStorage.getItem('cove-clip-open') !== '0'; } catch { /* 무시 */ }
setClipOpen(true);   // 제목 줄(동작 목록)은 숨겼으므로 목록은 항상 펼쳐 둔다
$('#editSw').onchange = (e) => setEditOpen(e.target.checked);
let editWas = false; try { editWas = localStorage.getItem('cove-edit-open') === '1'; } catch { /* 무시 */ }
setEditOpen(editWas);
$('#btnOpen').onclick = () => $('#fileGlb').click();
// 패널 맞춤: 타임라인을 위로 늘려 가운데·오른쪽 패널이 낮아져 내용이 넘치면 여백을 줄여(tight) 최대한 스크롤 없이 칸에 맞춘다
{
  const panels = () => [$('#left'), $('#right')];
  const fit = () => {
    const b = document.body; b.classList.remove('tight');
    if (panels().some((p) => p && p.scrollHeight > p.clientHeight + 1)) b.classList.add('tight');
  };
  window.fitPanels = fit;
  const ro = new ResizeObserver(fit); panels().forEach((p) => p && ro.observe(p));
  document.addEventListener('toggle', fit, true); document.addEventListener('click', () => setTimeout(fit, 320), true);
  window.addEventListener('resize', fit); setInterval(fit, 1000); setTimeout(fit, 500);
}
// 타임라인 높이 조절: 손잡이를 위아래로 끌면 높이가 바뀌고(90~480px) 값은 기억한다. 더블클릭하면 기본(160px)
{
  const h = $('#tlResize'), MIN = 90, MAX = 480, DEF = 160;
  const set = (v) => { v = Math.round(Math.max(MIN, Math.min(MAX, v))); document.documentElement.style.setProperty('--tl-h', v + 'px'); try { localStorage.setItem('cove-tl-h', String(v)); } catch { /* 무시 */ } return v; };
  try { const v = +localStorage.getItem('cove-tl-h'); if (v) set(v); } catch { /* 무시 */ }
  let y0 = 0, h0 = 0;
  h.onpointerdown = (e) => { e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag'); y0 = e.clientY; h0 = document.querySelector('footer').getBoundingClientRect().height; };
  h.onpointermove = (e) => { if (h.classList.contains('drag')) set(h0 + (y0 - e.clientY)); };
  h.onpointerup = h.onpointercancel = () => h.classList.remove('drag');
  h.ondblclick = () => set(DEF);
  // 완전 접기: 버튼을 누르면 타임라인이 막대 한 줄만 남기고 접히고, 다시 누르면 원래 높이로 펼쳐진다 (상태를 기억한다)
  const fold = $('#tlFold');
  const setFold = (on) => {
    document.body.classList.toggle('tl-collapsed', on); fold.textContent = on ? '▴ 타임라인 펼치기' : '▾ 접기';
    try { localStorage.setItem('cove-tl-fold', on ? '1' : '0'); } catch { /* 무시 */ }
    requestAnimationFrame(() => { resizeView(); resizeTL(); });
  };
  fold.onclick = () => setFold(!document.body.classList.contains('tl-collapsed'));
  let was = false; try { was = localStorage.getItem('cove-tl-fold') === '1'; } catch { /* 무시 */ }
  setFold(was);
}
{ const b = $('#tlBones'); try { b.checked = localStorage.getItem('cove-tl-bones') === '1'; } catch { /* 무시 */ } b.onchange = () => { try { localStorage.setItem('cove-tl-bones', b.checked ? '1' : '0'); } catch { /* 무시 */ } TL.sy = 0; drawTL(); }; }
// 파일 메뉴: 항목을 누르거나 메뉴 바깥을 누르면 닫는다
document.querySelectorAll('#fileMenu .menu-pop button').forEach((b) => b.addEventListener('click', () => { $('#fileMenu').open = false; }));
document.addEventListener('pointerdown', (e) => { const m = $('#fileMenu'); if (m?.open && !m.contains(e.target)) m.open = false; });
$('#fileGlb').onchange = (e) => openFile(e.target.files[0]);
async function openFile(f) {
  if (!f) return;
  try { await loadGLB(await f.arrayBuffer(), f.name); toast(`${f.name} 불러옴`); }
  catch (err) { console.error(err); toast('GLB를 읽을 수 없어요: ' + err.message); }
}
$('#btnExport').onclick = exportGLB;

/* ───────────── PNG / MP4 내보내기 ───────────── */
const dlg = $('#mediaDlg');
$('#btnMedia').onclick = () => { updateMediaDlg(); dlg.showModal(); };
$('#mdClose').onclick = () => { if (!exporting) dlg.close(); };
document.querySelectorAll('input[name=mdFmt]').forEach((r) => (r.onchange = updateMediaDlg));
function updateMediaDlg() {
  const mp4 = document.querySelector('input[name=mdFmt]:checked').value === 'mp4';
  const bg = $('#mdBg'); const opt = bg.querySelector('option[value=clear]');
  opt.disabled = mp4; if (mp4 && bg.value === 'clear') bg.value = 'dark';
  $('#mdInfo').textContent = mp4
    ? `${curClip().name} · ${curClip().duration}초 · ${curClip().fps}fps (${Math.round(curClip().duration * curClip().fps)}프레임)`
    : `${curClip().name} · 프레임 ${Math.round(S.time * fps())} (${S.time.toFixed(2)}초)`;
  $('#mdGo').textContent = mp4 ? 'MP4 만들기' : 'PNG 저장';
}

let exporting = false, expRenderer = null;
const BG = { beige: [0xe4dccf, 1], dark: [0x232628, 1], light: [0xf1f2f4, 1], clear: [0x000000, 0] };
function setupExportRender(w, h, bgKey) {
  if (!expRenderer) expRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  expRenderer.setPixelRatio(1);
  expRenderer.setSize(w, h, false);
  expRenderer.shadowMap.enabled = true; expRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
  expRenderer.setClearColor(BG[bgKey][0], BG[bgKey][1]);
  const prevEnv = scene.environment;            // WebGL 자원은 렌더러(컨텍스트)별이라 내보내기용 환경맵을 따로 만든다
  const expPmrem = new THREE.PMREMGenerator(expRenderer);
  scene.environment = expPmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const hidden = [tcHelper, bgKey === 'clear' ? grid : null, boneLines, ...markers.map((m) => m.mesh)].filter(Boolean);
  const prev = hidden.map((o) => o.visible);
  hidden.forEach((o) => (o.visible = false));
  const aspect = camera.aspect;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  return {
    render: () => expRenderer.render(scene, camera),
    canvas: expRenderer.domElement,
    restore: () => {
      scene.environment = prevEnv;
      hidden.forEach((o, i) => (o.visible = prev[i]));
      camera.aspect = aspect; camera.updateProjectionMatrix();
      applyPose(S.time);
    },
  };
}
const RES = { '720': [1280, 720], '1080': [1920, 1080], sq: [1080, 1080], v: [1080, 1920] };

$('#mdGo').onclick = async () => {
  if (exporting) return;
  const mp4 = document.querySelector('input[name=mdFmt]:checked').value === 'mp4';
  const [w, h] = RES[$('#mdRes').value];
  const bg = $('#mdBg').value;
  const base = `${S.glb.name.replace(/\.glb$/i, '')}_${curClip().name}`;
  exporting = true; stopPlay();
  $('#mdGo').disabled = true; $('#mdClose').disabled = true;
  const status = $('#mdStatus'), bar = $('#mdBar');
  const job = setupExportRender(w, h, bg);
  try {
    if (!mp4) {
      applyPose(S.time); job.render();
      const blob = await new Promise((res) => job.canvas.toBlob(res, 'image/png'));
      download(blob, `${base}_f${Math.round(S.time * fps())}.png`);
      status.textContent = '저장했어요';
    } else {
      if (typeof VideoEncoder === 'undefined') throw new Error('이 브라우저는 MP4 인코딩(WebCodecs)을 지원하지 않아요');
      const f = curClip().fps, total = Math.max(1, Math.round(curClip().duration * f));
      const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: 'avc', width: w, height: h }, fastStart: 'in-memory' });
      let encErr = null;
      const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (encErr = e) });
      const codec = h * w > 1280 * 720 ? 'avc1.64002A' : 'avc1.64001F';
      const cfg = { codec, width: w, height: h, bitrate: w * h * f * 0.12, framerate: f };
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (!sup.supported) throw new Error('H.264 인코딩을 지원하지 않는 환경이에요');
      enc.configure(cfg);
      for (let i = 0; i < total; i++) {
        if (encErr) throw encErr;
        applyPose(i / f); job.render();
        const frame = new VideoFrame(job.canvas, { timestamp: Math.round((i * 1e6) / f), duration: Math.round(1e6 / f) });
        enc.encode(frame, { keyFrame: i % f === 0 });
        frame.close();
        bar.value = (i + 1) / total;
        status.textContent = `인코딩 ${i + 1} / ${total}`;
        while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
        if (i % 4 === 0) await new Promise((r) => setTimeout(r));
      }
      await enc.flush(); enc.close(); muxer.finalize();
      download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), `${base}.mp4`);
      status.textContent = '저장했어요';
    }
  } catch (err) {
    console.error(err); status.textContent = '실패: ' + err.message;
  } finally {
    job.restore();
    exporting = false; $('#mdGo').disabled = false; $('#mdClose').disabled = false;
    setTimeout(() => { bar.value = 0; }, 800);
  }
};
$('#btnSaveProj').onclick = () => download(new Blob([JSON.stringify({ version: 1, glb: S.glb.name, clips: S.clips }, null, 1)], { type: 'application/json' }), S.glb.name.replace(/\.glb$/i, '') + '_project.json');
$('#btnLoadProj').onclick = () => $('#fileProj').click();
$('#fileProj').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.clips) || !d.clips.length) throw new Error('클립이 없습니다');
    S.clips = d.clips; S.clip = 0; S.selKeys.clear(); S.time = 0; applyPose(0); refreshClipUI(); snapshot(); toast('프로젝트를 불러왔어요');
  } catch (err) { toast('프로젝트 파일 오류: ' + err.message); }
  e.target.value = '';
};

// 드래그 앤 드롭
const drop = $('#drop');
addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('show'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('show'); });
addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('show'); openFile(e.dataTransfer.files[0]); });

// 단축키
addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
  if (tag === 'SELECT') return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); copyKeys(); return; }
  if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteKeys(); return; }
  if (mod) return;
  switch (e.key) {
    case ' ': e.preventDefault(); playMain(); break;
    case 'ArrowLeft': e.preventDefault(); stopPlay(); setTime(S.time - (e.shiftKey ? 10 : 1) / fps()); break;
    case 'ArrowRight': e.preventDefault(); stopPlay(); setTime(S.time + (e.shiftKey ? 10 : 1) / fps()); break;
    case '[': stepScene(-1); break;
    case ']': stepScene(1); break;
    case 'Home': setTime(0); break;
    case 'End': setTime(curClip().duration); break;
    case 'i': case 'I': insertKeys(e.shiftKey); break;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteKeys(); break;
    case 'w': case 'W': setMode('translate'); break;
    case 'e': case 'E': setMode('rotate'); break;
    case 'r': case 'R': setMode('scale'); break;
    case 'q': case 'Q': $('#spaceBtn').click(); break;
    case 'Escape': S.selKeys.clear(); refreshAll(); break;
  }
});

/* ───────────── 시작 ───────────── */
initRobotPanel({ exportFiles: buildRobotExport });
resizeView();
requestAnimationFrame(frame);
(async () => {
  try {
    const res = await fetch('assets/cove.glb');
    if (!res.ok) throw new Error(res.status);
    await loadGLB(await res.arrayBuffer(), 'cove.glb');
  } catch (err) {
    console.error(err);
    toast('기본 모델을 못 불러왔어요. GLB를 끌어다 놓거나 [GLB 열기]를 누르세요.');
  }
})();
addEventListener('beforeunload', () => { try { if (S.glb) snapshot(true); } catch { /* */ } });
window.__cove = { S, exportGLB, getEyes: () => eyes, camera, orbit, THREE, renderer, scene, setTime, sampleJoints, buildRobotExport, buildPresetByName: (n) => { const d = PRESET_GROUPS[0].items.find((i) => i.name === n); return d ? buildPresetClip(d) : null; }, snapshot };
