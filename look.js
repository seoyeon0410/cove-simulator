// 렌더 이미지(패브릭 외피 + 흰 파이핑 + 알루미늄 기둥)에 맞춘 재질과, 8×8 LED 눈.
import * as THREE from 'three';

/* ───────────── 재질 ───────────── */

// 패브릭: 오브젝트 좌표 기반의 고운 노이즈로 색·질감을 흩어 펠트/니트 느낌을 낸다 (UV가 없는 모델이라 셰이더에서 처리)
function fabricMaterial(color) {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: 1, metalness: 0, sheen: 0.55, sheenRoughness: 0.85, sheenColor: new THREE.Color('#ffffff'), envMapIntensity: 0.28 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vObjPos;
float h31(vec3 p){ p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vn(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{ float g1 = vn(vObjPos * 420.0), g2 = vn(vObjPos * 130.0), g3 = vn(vObjPos * 38.0);
  diffuseColor.rgb *= 0.93 + 0.10 * g1 + 0.05 * g2 + 0.04 * g3; }`);
  };
  return m;
}

export function applyLook(model) {
  const fabric = fabricMaterial('#ddd5c9');
  const piping = new THREE.MeshStandardMaterial({ color: '#f4f2ee', roughness: 0.55, metalness: 0, envMapIntensity: 0.6 });
  const aluminum = new THREE.MeshStandardMaterial({ color: '#c6c9cc', roughness: 0.32, metalness: 1, envMapIntensity: 1.1 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#8d8c8a', roughness: 0.9, metalness: 0 });
  const FABRIC = ['새_헤드_상판', '새_쿠션', '새_하부_폼', '새_하부_쉘'];
  const PIPING = ['새_헤드_하부판', '새_하부_덮개판'];
  const ALU = ['기둥_1', '본체6'];
  const RUBBER = ['새_미끄럼방지_고무링', '하부_회전판'];
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (FABRIC.includes(o.name)) o.material = fabric;
    else if (PIPING.includes(o.name)) o.material = piping;
    else if (ALU.includes(o.name)) o.material = aluminum;
    else if (RUBBER.includes(o.name)) o.material = rubber;
  });
}

/* ───────────── 눈: 8×8 LED 매트릭스 한 개 = 눈 한 개 ───────────── */

// 8×8 도트 (위→아래, 왼→오른). 1이 켜진 LED. 눈의 가운데 줄은 3행 근처로 맞춰서 표정이 바뀌어도 눈 높이가 흔들리지 않는다.
// 값 형태: rows(두 눈 같은 모양) | { L, R }(보는 사람 기준 왼쪽·오른쪽 눈이 서로 다름) | { frames, step }(여러 프레임이 도는 애니메이션)
const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));
const OVAL = ['00000000', '00011000', '00111100', '00111100', '00111100', '00011000', '00000000', '00000000'];   // 4×5 둥근 타원
const HAPPY = ['00000000', '00000000', '00011000', '00100100', '01000010', '00000000', '00000000', '00000000'];  // ^
const CHEVRON = ['00000000', '01100000', '00011000', '00001100', '00011000', '01100000', '00000000', '00000000']; // >
const SAD_L = ['00000000', '00000011', '00001110', '00111100', '01110000', '00000000', '00000000', '00000000'];   // 바깥쪽이 처진 눈
const SPARK = (off) => OVAL.map((r, y) => r.split('').map((v, x) => (off.some(([oy, ox]) => oy === y && ox === x) ? '0' : v)).join(''));
const PATTERNS = {
  '뜬 눈': OVAL,
  '감은 눈': ['00000000', '00000000', '00000000', '01000010', '00111100', '00000000', '00000000', '00000000'],   // ∪ 편안히 감은 눈
  '웃는 눈': HAPPY,
  '졸린 눈': ['00000000', '00000000', '00000000', '00111100', '00111100', '00011000', '00000000', '00000000'],   // 눈꺼풀이 반쯤 내려온 눈
  '놀란 눈': ['00000000', '00111100', '01111110', '01100110', '01100110', '01111110', '00111100', '00000000'],   // 동공이 비어 있는 큰 눈
  '하트 눈': ['00000000', '01100110', '01111110', '01111110', '00111100', '00011000', '00000000', '00000000'],   // ♥
  '반짝 눈': { frames: [SPARK([[2, 3]]), SPARK([[2, 3], [3, 2]]), SPARK([[2, 3]]), OVAL], step: 0.3 },            // 눈동자에 하이라이트가 반짝
  '슬픈 눈': { L: SAD_L, R: mirror(SAD_L) },                                                                      // 조르는 듯 처진 눈
  '신난 눈': { L: CHEVRON, R: mirror(CHEVRON) },                                                                  // > <
  '윙크': { L: OVAL, R: HAPPY },                                                                                  // 한쪽 눈만 ^
  '편안한 눈': ['00000000', '00000011', '00000110', '00001100', '00011000', '00110000', '00000000', '00000000'],   // ↗ 느긋한 눈
};
export const EXPRESSIONS = Object.keys(PATTERNS);

// LED 한 칸마다 또렷한 동그란 점(밝은 중심 + 얇은 헤일로)을 찍고, 천 뒤에서 은은하게 번지도록 두 겹으로 합성한다.
// 꺼진 칸은 아무것도 그리지 않는다(천 뒤라 보이지 않음).
function drawPattern(canvas, rows) {
  const S = canvas.width, cell = S / 8, ctx = canvas.getContext('2d');
  const dots = document.createElement('canvas'); dots.width = dots.height = S;
  const g = dots.getContext('2d');
  rows.forEach((r, y) => [...r].forEach((v, x) => {
    if (v !== '1') return;
    const cx = (x + 0.5) * cell, cy = (y + 0.5) * cell;
    const R = cell * 0.5;                          // 이웃 칸과 살짝만 닿아 한 칸 한 칸이 구분되어 보이도록
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, 'rgba(252,254,255,1)');
    grad.addColorStop(0.5, 'rgba(232,243,255,.96)');
    grad.addColorStop(0.82, 'rgba(200,224,255,.4)');
    grad.addColorStop(1, 'rgba(200,224,255,0)');
    g.fillStyle = grad; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  }));
  ctx.clearRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${cell * 0.1}px)`; ctx.drawImage(dots, 0, 0);               // 도트 자체 (거의 선명)
  ctx.globalAlpha = 0.34; ctx.filter = `blur(${cell * 0.5}px)`; ctx.drawImage(dots, 0, 0);   // 천에 번지는 빛
  ctx.globalAlpha = 1; ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
}

/* 8×8 도트 매트릭스라서 눈의 모든 움직임은 "도트 한 칸" 단위의 프레임으로만 만든다(중간 값 없음):
   - 시선: 패턴을 칸 단위(−2~+2)로 밀기
   - 깜빡임: 눈 높이를 5줄 → 3줄 → 1줄로 줄였다가 되돌리는 5프레임 (60ms 간격)
   - 표정 전환: 프레임이 바뀌는 순간 통째로 교체 (LED가 한 번에 바뀌는 것처럼) */
const BLINK_FRAMES = [1, 2, 2, 1, 0];          // 0 = 뜬 눈, 1 = 반쯤, 2 = 감김
const BLINK_STEP = 0.06;
function blinkStage(t) {                       // 3.8초마다, 조금씩 어긋나게 한 번씩 깜빡임 (시간만으로 결정되어 재생·내보내기에서 같다)
  const P = 3.8, n = Math.floor((t - 1.6) / P);
  if (n < 0) return 0;
  const start = 1.6 + n * P + 0.9 * (0.5 + 0.5 * Math.sin(n * 12.9898));
  const ph = t - start;
  if (ph < 0 || ph >= BLINK_FRAMES.length * BLINK_STEP) return 0;
  return BLINK_FRAMES[Math.floor(ph / BLINK_STEP)];
}
const BLINK = { 1: ['00000000', '00000000', '00011000', '00111100', '00011000', '00000000', '00000000', '00000000'],    // 반쯤 감김
                2: ['00000000', '00000000', '00000000', '00111100', '00000000', '00000000', '00000000', '00000000'] };  // 감김
const shiftRows = (rows, gx, gy) => {
  const src = rows.map((r) => r.split('')), out = Array.from({ length: 8 }, () => Array(8).fill('0'));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const sx = x - gx, sy = y - gy;
    if (sx >= 0 && sx < 8 && sy >= 0 && sy < 8) out[y][x] = src[sy][sx];
  }
  return out.map((r) => r.join(''));
};
// 반환: [보는 사람 기준 왼쪽 눈 프레임, 오른쪽 눈 프레임]
function framePattern(name, gx, gy, stage, t) {
  const def = PATTERNS[name] || PATTERNS['뜬 눈'];
  let L, R;
  if (Array.isArray(def)) L = R = def;
  else if (def.frames) { L = R = def.frames[Math.floor(t / def.step) % def.frames.length]; }
  else { L = def.L; R = def.R; }
  if (name === '뜬 눈' && BLINK[stage]) L = R = BLINK[stage];
  return [shiftRows(L, gx, gy), shiftRows(R, gx, gy)];
}

// 두 LED 매트릭스 앞쪽 헤드 외피 위에 눈 패널을 올린다.
// 머리 앞 방향은 (기둥 평면의 수평축)이고, 매트릭스 중심에서 앞으로 쏜 광선이 헤드 외피를 뚫고 나오는 점이 눈 위치다.
export function buildEyes(S, { setPose, resetPose }) {
  const colN = S.nodes.get(40), tiltN = S.nodes.get(34);
  const mats = [], shell = [];
  S.model.traverse((o) => {
    if (!o.isMesh) return;
    if (/KeyStudio-HT16K33-8x8-LED-Matrix/.test(o.name)) mats.push(o);
    if (['새_헤드_상판', '새_쿠션', '새_헤드_하부판'].includes(o.name)) shell.push(o);
  });
  if (mats.length < 2 || !colN || !tiltN) return null;

  setPose();                                    // 헤드가 수평으로 선 자세에서 계산
  S.model.updateMatrixWorld(true);
  const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(colN.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const front = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize().multiplyScalar(-1);
  const ray = new THREE.Raycaster(), group = new THREE.Group(); group.name = '눈';
  const canvases = [], textures = [], eyeList = [];
  const viewerRight = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), front).normalize();   // 정면에서 마주 본 사람의 오른쪽
  const SIZE = 0.016;                           // 패널 한 변 16mm (도트 간격 2mm)
  const GAP_IN = 0.003, RAISE = 0.007;          // 미간을 눈 한쪽당 3mm씩 좁히고, 7mm 위로 올린다
  const tiltQ = tiltN.getWorldQuaternion(new THREE.Quaternion()).invert();

  const centers = mats.map((m) => new THREE.Box3().setFromObject(m, true).getCenter(new THREE.Vector3()));
  const mid = centers[0].clone().add(centers[1]).multiplyScalar(0.5);
  for (let mi = 0; mi < mats.length; mi++) {
    const c = centers[mi].clone();
    const toMid = mid.clone().sub(c); toMid.y = 0; if (toMid.length() > 1e-6) c.addScaledVector(toMid.normalize(), GAP_IN);
    c.y += RAISE;
    ray.set(c.clone().addScaledVector(front, 0.3), front.clone().negate());   // 밖에서 매트릭스 중심 쪽으로 쏴서
    const hits = ray.intersectObjects(shell, false);
    if (!hits.length) continue;
    const hit = hits[0];                        // 처음 닿는 곳 = 헤드 바깥 표면
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    if (n.dot(front) < 0) n.negate();
    const pos = hit.point.clone().addScaledVector(n, 0.0004);

    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE), mat);
    mesh.userData.noOpacity = true; mesh.renderOrder = 5;
    const look = new THREE.Object3D(); look.position.copy(pos); look.up.set(0, 1, 0); look.lookAt(pos.clone().add(n));
    mesh.position.copy(tiltN.worldToLocal(pos.clone()));
    mesh.quaternion.copy(tiltQ.clone().multiply(look.quaternion));
    group.add(mesh); eyeList.push({ canvas, tex, x: pos.dot(viewerRight) });
  }
  eyeList.sort((a, b) => a.x - b.x);                      // 보는 사람 기준 왼쪽 → 오른쪽 순서
  eyeList.forEach((e) => { canvases.push(e.canvas); textures.push(e.tex); });
  tiltN.add(group);
  resetPose();

  let lastKey = '';
  const api = {
    group,
    // 표정 이름·시선(도트 칸 수)·시각 t(깜빡임용)에 맞는 프레임을 그린다. 같은 프레임이면 다시 그리지 않는다.
    show(name, gx = 0, gy = 0, t = 0) {
      const def = PATTERNS[name];
      const stage = name === '뜬 눈' ? blinkStage(t) : 0;
      const frame = def && def.frames ? Math.floor(t / def.step) % def.frames.length : 0;
      const key = `${name}|${gx}|${gy}|${stage}|${frame}`;
      if (key === lastKey) return;
      lastKey = key;
      const [pl, pr] = framePattern(name, gx, gy, stage, t);
      canvases.forEach((cv, i) => { drawPattern(cv, i === 0 ? pl : pr); textures[i].needsUpdate = true; });
    },
    count: canvases.length,
  };
  api.show('뜬 눈');
  return api;
}
