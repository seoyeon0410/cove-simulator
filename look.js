// 렌더 이미지(패브릭 외피 + 흰 파이핑 + 알루미늄 기둥)에 맞춘 재질과, 8×8 LED 눈.
import * as THREE from 'three';

/* ───────────── 재질 ───────────── */

// 패브릭: 오브젝트 좌표 기반의 고운 노이즈로 색·거칠기·미세한 요철(범프)을 만든다 (UV가 없는 모델이라 셰이더에서 처리)
function fabricMaterial(color, { bump = 0.55, sheen = 0.6, env = 0.3 } = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color, roughness: 1, metalness: 0, sheen, sheenRoughness: 0.8, sheenColor: new THREE.Color('#ffffff'), envMapIntensity: env });
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
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fabH(vec3 p){ return 0.55 * vn(p * 330.0) + 0.3 * vn(p * 115.0) + 0.15 * vn(p * 36.0); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{ float g1 = vn(vObjPos * 420.0), g2 = vn(vObjPos * 130.0), g3 = vn(vObjPos * 38.0);
  diffuseColor.rgb *= 0.92 + 0.11 * g1 + 0.05 * g2 + 0.04 * g3; }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor * (0.9 + 0.2 * vn(vObjPos * 300.0)), 0.0, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{ float hh = fabH(vObjPos); vec2 dH = vec2(dFdx(hh), dFdy(hh)) * ${bump.toFixed(3)};
  vec3 sp = -vViewPosition; vec3 sx = normalize(dFdx(sp)), sy = normalize(dFdy(sp));
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1) * faceDirection;
  normal = normalize(abs(det) * normal - sign(det) * (dH.x * r1 + dH.y * r2)); }`);
  };
  m.customProgramCacheKey = () => `fabric${bump}`;
  return m;
}

export function applyLook(model) {
  // 사진처럼: 헤드는 밝은 회색, 바디 위(폼)는 밝은 회색, 바디 아래(쉘)는 한 톤 어두운 회색
  const headTop = fabricMaterial('#d8d4cc', { bump: 1.0 });
  const cushion = fabricMaterial('#c8c3bb', { bump: 1.0 });
  const foam = fabricMaterial('#c9c4bc', { bump: 1.0 });
  const shell = fabricMaterial('#9d9992', { sheen: 0.45, bump: 1.0 });
  const piping = new THREE.MeshPhysicalMaterial({ color: '#f6f4f0', roughness: 0.4, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.5, envMapIntensity: 0.7 });
  const aluminum = new THREE.MeshPhysicalMaterial({ color: '#cfd2d5', roughness: 0.26, metalness: 1, clearcoat: 0.25, clearcoatRoughness: 0.35, envMapIntensity: 1.25 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#8d8c8a', roughness: 0.85, metalness: 0, envMapIntensity: 0.4 });
  const MAP = {
    '새_헤드_상판': headTop, '새_쿠션': cushion, '새_하부_폼': foam, '새_하부_쉘': shell,
    '새_헤드_하부판': piping, '새_하부_덮개판': piping,
    '기둥_1': aluminum, '본체6': aluminum,
    '새_미끄럼방지_고무링': rubber, '하부_회전판': rubber,
  };
  model.traverse((o) => { if (o.isMesh && MAP[o.name]) o.material = MAP[o.name]; });
}

/* ───────────── 눈: 8×8 LED 매트릭스 한 개 = 눈 한 개 ───────────── */

// 8×8 도트 (위→아래, 왼→오른). 1이 켜진 LED.
const PATTERNS = {
  '뜬 눈': ['00000000', '00000000', '00011000', '00011000', '00011000', '00011000', '00000000', '00000000'],
  '감은 눈': ['00000000', '00000000', '00000000', '00000000', '01111110', '00000000', '00000000', '00000000'],
  '웃는 눈': ['00000000', '00000000', '00011000', '00100100', '01000010', '00000000', '00000000', '00000000'],
  '편안한 눈': ['00000000', '00000011', '00000110', '00001100', '00011000', '00110000', '00000000', '00000000'],
  '졸린 눈': ['00000000', '00000000', '00000000', '00111100', '00111100', '00000000', '00000000', '00000000'],
  '놀란 눈': ['00000000', '00011000', '00111100', '00111100', '00111100', '00111100', '00011000', '00000000'],
};
export const EXPRESSIONS = Object.keys(PATTERNS);

function drawPattern(canvas, rows) {
  const S = canvas.width, cell = S / 8, ctx = canvas.getContext('2d');
  const glow = document.createElement('canvas'); glow.width = glow.height = S;
  const g = glow.getContext('2d');
  g.fillStyle = '#eaf4ff';
  rows.forEach((r, y) => [...r].forEach((v, x) => { if (v === '1') { g.beginPath(); g.roundRect(x * cell + cell * 0.14, y * cell + cell * 0.14, cell * 0.72, cell * 0.72, cell * 0.22); g.fill(); } }));
  ctx.clearRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${cell * 0.55}px)`; ctx.drawImage(glow, 0, 0);     // 천 뒤에서 번지는 빛
  ctx.filter = `blur(${cell * 0.16}px)`; ctx.drawImage(glow, 0, 0); ctx.drawImage(glow, 0, 0);
  ctx.filter = 'none'; ctx.globalCompositeOperation = 'source-over';
}

/* 8×8 도트 매트릭스라서 눈의 모든 움직임은 "도트 한 칸" 단위의 프레임으로만 만든다(중간 값 없음):
   - 시선: 패턴을 칸 단위(−2~+2)로 밀기
   - 깜빡임: 눈 높이를 4줄 → 2줄 → 1줄로 줄였다가 되돌리는 5프레임 (60ms 간격)
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
function framePattern(name, gx, gy, stage) {
  let rows = (PATTERNS[name] || PATTERNS['뜬 눈']).map((r) => r.split(''));
  if (name === '뜬 눈' && stage === 1) rows = rows.map((r, y) => (y === 3 || y === 4 ? r : r.map(() => '0')));
  if (name === '뜬 눈' && stage === 2) rows = rows.map((r, y) => (y === 4 ? '00111100'.split('') : r.map(() => '0')));
  const out = Array.from({ length: 8 }, () => Array(8).fill('0'));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const sx = x - gx, sy = y - gy;
    if (sx >= 0 && sx < 8 && sy >= 0 && sy < 8) out[y][x] = rows[sy][sx];
  }
  return out.map((r) => r.join(''));
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
  mats.sort((a, b) => a.name.length - b.name.length);

  setPose();                                    // 헤드가 수평으로 선 자세에서 계산
  S.model.updateMatrixWorld(true);
  const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(colN.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const front = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), zAxis).normalize().multiplyScalar(-1);
  const ray = new THREE.Raycaster(), group = new THREE.Group(); group.name = '눈';
  const canvases = [], textures = [];
  const SIZE = 0.020;                           // 패널 한 변 20mm (도트 간격 2.5mm)
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
    group.add(mesh); canvases.push(canvas); textures.push(tex);
  }
  tiltN.add(group);
  resetPose();

  let lastKey = '';
  const api = {
    group,
    // 표정 이름·시선(도트 칸 수)·시각 t(깜빡임용)에 맞는 프레임을 그린다. 같은 프레임이면 다시 그리지 않는다.
    show(name, gx = 0, gy = 0, t = 0) {
      const stage = name === '뜬 눈' ? blinkStage(t) : 0;
      const key = `${name}|${gx}|${gy}|${stage}`;
      if (key === lastKey) return;
      lastKey = key;
      const rows = framePattern(name, gx, gy, stage);
      canvases.forEach((cv, i) => { drawPattern(cv, rows); textures[i].needsUpdate = true; });
    },
    count: canvases.length,
  };
  api.show('뜬 눈');
  return api;
}
