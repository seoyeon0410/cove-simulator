import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PRESET_GROUPS } from './presets.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { applyLook, buildEyes, EXPRESSIONS } from './look.js';
import { initRobotPanel, robot } from './robot.js';
import { linkFor, restrictTo, robotOnlyGroups, webSceneName } from './robotmap.js';
import { csvOf, report, zip, limitFrames, STEP } from './robotexport.js';
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
  loop: true,
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
}

function upsertKey(idx, t, interp) {
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
  if (def.group) clip.group = def.group;
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
  const str = JSON.stringify({ v: SAVE_VERSION, clips: S.clips, clip: S.clip });
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
  applyPose(t);
  updateProps(); updateTimeLabel(); drawTL();
}
function stopPlay() {
  const was = S.playing;
  S.playing = false; $('#tPlay').textContent = '▶'; updateProps();
  // 웹 재생을 멈추면 로봇도 바로 멈춘다: 동기 중이거나 로봇이 씬을 재생 중일 때 정지 명령을 보낸다 (동기는 켜진 채로 둔다)
  if (was && robot.connected && (robot.sync || robot.current)) robot.hold();
}
function togglePlay() {
  if (S.playing) return stopPlay();
  if (S.time >= curClip().duration - EPS) S.time = 0;
  S.playing = true; $('#tPlay').textContent = '❚❚'; updateProps();
}
let lastT = performance.now();
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.1); lastT = now;
  if (S.playing) {
    const c = curClip();
    S.time += dt;
    if (S.sceneLoop && c.markers?.length) {            // 장면 반복: 지금 보고 있는 장면의 끝에 닿으면 그 장면의 처음으로
      const [a0, b0] = sceneRange(sceneIndex(S.time - dt));
      if (S.time >= b0) S.time = a0 + (S.time - b0);
    }
    if (S.time >= c.duration) {
      if (S.loop) S.time %= c.duration; else { S.time = c.duration; stopPlay(); }
    }
    applyPose(S.time); updateProps(); updateTimeLabel(); drawTL();
  }
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
  if (l.main) { const b = sceneChip(l.main, '▶ 로봇 기본 씬'); top.push(b); }
  row('로봇', top);
  row('장면별', l.steps.map((n) => sceneChip(n, n.replace(/^[a-z]+_(\d+)_/, '$1 '))));
  row('관련', l.more.map((n) => sceneChip(n)));
  if (!box.children.length) { box.className = 'rb-block'; box.textContent = '이 로봇에는 연결된 씬이 아직 없어요'; box.classList.add('rb-hint'); }
  return box;
}
function renderClipList() {
  const sel = $('#clipSel'), list = $('#clipList');
  list.innerHTML = '';
  let lastGroup = null;
  S.clips.forEach((c, i) => {
    const g = c.group || (c.markers?.length ? '시나리오' : '내 클립');
    if (g !== lastGroup) { lastGroup = g; const h = document.createElement('div'); h.className = 'grp'; h.textContent = g; list.appendChild(h); }
    const wrap = document.createElement('div'); wrap.className = 'clip-row';
    const el = document.createElement('button');
    el.className = 'clip-item' + (i === S.clip ? ' on' : '');
    const m = c.name.match(/^시나리오(\d+)\s*(.*)$/);                      // "시나리오1 휴식" → 번호 01 + 제목 "휴식"
    el.innerHTML = '<span class="no"></span><span class="nm"></span><span class="du"></span>';
    el.children[0].textContent = m ? m[1].padStart(2, '0') : '';
    el.children[1].textContent = m ? m[2] : c.name;
    el.children[2].textContent = `${+c.duration.toFixed(1)}초`;
    el.onclick = () => { sel.value = i; sel.dispatchEvent(new Event('change')); };
    el.ondblclick = () => startRename(i);
    wrap.appendChild(el);
    const link = linkFor(c.name), main = link && robot.connected && restrictTo(link, robot.scenes).main;
    if (main) {
      const rb = document.createElement('button'); rb.className = 'rb' + (robot.current === main ? ' run' : ''); rb.textContent = '▶';
      rb.title = `로봇에서 "${main}" 실행`;
      rb.onclick = () => { if (runOnRobot(main) === 'ok' && i !== S.clip) { sel.value = i; sel.dispatchEvent(new Event('change')); } };
      wrap.appendChild(rb);
    }
    list.appendChild(wrap);
    if (i === S.clip && link) list.appendChild(robotBlock(link, i));
  });
  if (robot.connected && robot.scenes.length) {
    const groups = robotOnlyGroups(robot.scenes);
    if (groups.length) { const h = document.createElement('div'); h.className = 'grp'; h.textContent = '로봇 전용'; list.appendChild(h); }
    groups.forEach((g) => {
      const open = rbOpen.has(g.label);
      const el = document.createElement('button'); el.className = 'clip-item rb-only';
      el.innerHTML = '<span class="no"></span><span class="nm"></span><span class="du"></span>';
      el.children[0].textContent = open ? '−' : '+'; el.children[1].textContent = g.label; el.children[2].textContent = `${g.scenes.length}개`;
      el.onclick = () => { if (open) rbOpen.delete(g.label); else rbOpen.add(g.label); renderClipList(); };
      list.appendChild(el);
      if (open) {
        const box = document.createElement('div'); box.className = 'rb-block';
        const c = document.createElement('div'); c.className = 'rb-c'; c.append(...g.scenes.map((n) => sceneChip(n))); box.appendChild(c);
        list.appendChild(box);
      }
    });
  }
}
robot.onChange(() => { if (!document.querySelector('#clipList input.rename')) renderClipList(); });
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
/* [로봇 한계] 켜져 있으면 뷰포트의 기둥·머리·갸웃을 로봇이 실제로 움직일 수 있는 범위로 잘라서 보여 준다 (키 값은 그대로). */
let jointCache = null;
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
setInterval(() => {
  if (!robot.sync) { syncEye = ''; return; }
  if (!S.model || !S.playing) return;
  if (!jointCache || jointCache.model !== S.model) jointCache = { model: S.model, ids: jointIds() };
  const clip = curClip(), t = Math.min(S.time + 0.1, clip.duration), ids = jointCache.ids, f = { t };      // 0.1초 앞의 자세 (로봇이 0.15초에 걸쳐 따라오므로)
  for (const j of ['neck', 'head', 'tilt', 'body']) f[j] = jointDeg(clip, ids[j], JOINT_AXES[j], t);
  const l = limitFrames([f], { tiltSign: +($('#rpTiltSign')?.value || 1) })[0], r1 = (v) => Math.round(v * 10) / 10;
  robot.pose({ neck: r1(l.neck), head: r1(l.head), tilt: r1(l.tilt), body: r1(l.body) });
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
  if (dir < 0) gotoScene(S.time - sceneRange(i)[0] > 0.5 ? i : i - 1); else gotoScene(i + 1);
}
function playScene(i) { S.sceneLoop = true; gotoScene(i); if (!S.playing) togglePlay(); updateSceneTag(); }
function playAll() { S.sceneLoop = false; setTime(0); if (!S.playing) togglePlay(); updateSceneTag(); }
let chipKey = '';
function updateSceneTag() {
  const el = $('#sceneTag'), marks = sceneMarks();
  if (!el) return;
  if (!marks.length) { el.hidden = true; return; }
  const i = sceneIndex(S.time), byName = curClip().group === '표정';
  el.hidden = false;
  const box = $('#sceneChips'), key = `${S.clip}|${marks.length}`;
  if (chipKey !== key) {                                   // 칩은 클립이 바뀔 때만 다시 만든다
    chipKey = key; box.innerHTML = '';
    const all = document.createElement('button'); all.className = 'chip all'; all.textContent = '▶ 전체'; all.onclick = playAll; box.appendChild(all);
    marks.forEach((m, k) => {
      const b = document.createElement('button'); b.className = byName ? 'chip' : 'chip num'; b.textContent = byName ? m.label : String(k + 1);
      b.onclick = () => { playScene(k); if (byName && robot.connected) robot.eyes(m.label, true); };   // 표정 버튼은 연결된 로봇의 눈도 바로 바꾼다
      box.appendChild(b);
    });
  }
  box.children[0].classList.toggle('on', !S.sceneLoop);
  [...box.children].slice(1).forEach((b, k) => { b.classList.toggle('on', S.sceneLoop && k === i); b.classList.toggle('cur', k === i); });
  const mk = marks[i];
  el.querySelector('.desc').textContent = mk.desc || mk.label;
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
  if (!S.model) return [];
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
$('#tPlay').onclick = togglePlay;
$('#tStart').onclick = () => setTime(0);
$('#tEnd').onclick = () => setTime(curClip().duration);
$('#tPrev').onclick = () => { stopPlay(); setTime(S.time - 1 / fps()); };
$('#tNext').onclick = () => { stopPlay(); setTime(S.time + 1 / fps()); };
$('#loop').onchange = (e) => (S.loop = e.target.checked);
$('#autoKey').onchange = (e) => (S.autoKey = e.target.checked);
$('#showAll').onchange = (e) => { S.showAll = e.target.checked; buildTree(); };
$('#showBones').onchange = () => {};
$('#robotLimit').onchange = () => { applyPose(S.time); refreshAll(); };
$('#rpTiltSign')?.addEventListener('change', () => applyPose(S.time));
$('#opacity').oninput = applyOpacity;
$('#camReset').onclick = fitCamera;
EXPRESSIONS.forEach((n) => $('#eyeSel').add(new Option(n, n)));
// 양쪽 표정 선택 / 눈 만들기 독 (눈 그림을 끌어 놓기)
$('#eyeSel').onchange = (e) => {                 // 선택한 표정을 현재 시간의 눈 키로 기록한다
  if (!curClip()) return;
  setEyeKey(S.time, { e: e.target.value }); applyEyes(S.time); snapshot();
};
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

$('#clipSel').onchange = (e) => { S.clip = +e.target.value; S.selKeys.clear(); S.time = Math.min(S.time, curClip().duration); applyPose(S.time); refreshClipUI(); snapshot(); };
$('#clipNew').onclick = () => { const nc = newClipData(`새 클립 ${S.clips.filter((x) => x.group === '내 클립').length + 1}`); nc.group = '내 클립'; S.clips.push(nc); S.clip = S.clips.length - 1; S.selKeys.clear(); S.time = 0; applyPose(0); refreshClipUI(); snapshot(); };
$('#clipDup').onclick = () => { const c = JSON.parse(JSON.stringify(curClip())); c.name += ' 복사'; c.group = '내 클립'; S.clips.push(c); S.clip = S.clips.length - 1; S.selKeys.clear(); refreshClipUI(); snapshot(); };
// 이름 바꾸기: 브라우저 prompt 대신 목록 줄 안에서 바로 입력한다 (Enter 확정 · Esc 취소)
function startRename(i) {
  const row = [...document.querySelectorAll('#clipList .clip-item')][i]; if (!row) return;
  const nmEl = row.querySelector('.nm'), input = document.createElement('input');
  input.type = 'text'; input.value = S.clips[i].name; input.className = 'rename';
  nmEl.replaceWith(input); input.focus(); input.select();
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
$('#clipDel').onclick = () => {
  if (S.clips.length < 2) return toast('마지막 클립은 삭제할 수 없어요');
  const name = curClip().name;                    // 확인 창 대신 바로 지우고, Ctrl+Z로 되돌릴 수 있게 한다
  S.clips.splice(S.clip, 1); S.clip = Math.max(0, S.clip - 1); S.selKeys.clear(); applyPose(S.time); refreshClipUI(); snapshot();
  toast(`'${name}' 삭제했어요 · Ctrl+Z로 되돌릴 수 있어요`);
};
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
setClipOpen(clipOpenSaved);
$('#editSw').onchange = (e) => setEditOpen(e.target.checked);
let editWas = false; try { editWas = localStorage.getItem('cove-edit-open') === '1'; } catch { /* 무시 */ }
setEditOpen(editWas);
$('#btnOpen').onclick = () => $('#fileGlb').click();
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
    case ' ': e.preventDefault(); togglePlay(); break;
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
window.__cove = { S, exportGLB, getEyes: () => eyes, camera, orbit, THREE, renderer, scene, setTime, sampleJoints, buildRobotExport };
