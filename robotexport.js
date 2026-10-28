// 웹 동작(뷰포트에 보이는 각도) → 로봇용 모션 파일(motions/이름.csv, 0.1초 간격 절대 틱) 변환.
// 매핑·한계는 엔지니어 답변서 2·3번을 따른다. 방향이 아직 확정되지 않은 갸웃(tilt)·몸통(body)은 부호를 옵션으로 둔다.
export const TICK = 4096 / 360;
export const REST = { id1: 1600, id2: 3201, id3: 3074, id4: 2021 };
export const STEP = 0.1;
// 관절 한계(도). body는 ±180이지만 시험이 끝나기 전에는 ±90까지만 쓴다.
const NECK = [0, 34], HEAD = [-46, 0], BODY = [-90, 90];
export const LIMITS = { neck: NECK, head: HEAD, body: BODY };
// head 각도별 tilt 허용 범위 (실측, ID4 + 방향 기준, 사이는 직선 보간)
const TILT_ENV = [[-47.8, 0, 0], [-43.8, 0, 0], [-40.5, 0, 0], [-27.2, -6.5, 7.6], [-25.4, -15.3, 14.9], [-12, -13.9, 6.9], [-7.2, -8, 4.9], [-2.8, -7.1, 9.1], [0, 0, 0]];
const MAXV = { neck: 200, head: 200, tilt: 200, body: 80 }, MAXA = 200;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export function tiltRange(head) {
  const e = TILT_ENV;
  if (head <= e[0][0]) return [e[0][1], e[0][2]];
  for (let i = 1; i < e.length; i++) if (head <= e[i][0]) {
    const [h0, a0, b0] = e[i - 1], [h1, a1, b1] = e[i], f = (head - h0) / (h1 - h0);
    return [a0 + (a1 - a0) * f, b0 + (b1 - b0) * f];
  }
  return [0, 0];
}

// frames: [{t, neck, head, tilt, body}] (웹 각도). opt.tiltSign / opt.bodySign: ID4 +방향이 웹 tilt +와 같으면 1, 반대면 -1 (몸통도 같다)
export function limitFrames(frames, opt = {}) {
  const ts = opt.tiltSign || 1;
  return frames.map((f) => {
    const neck = clamp(f.neck, ...NECK), head = clamp(f.head, ...HEAD), body = clamp(f.body, ...BODY);
    const [lo, hi] = tiltRange(head), a = clamp(ts * f.tilt, lo, hi);
    return { t: f.t, neck, head, tilt: ts * a, body };
  });
}

export function toTicks(f, opt = {}) {
  const ts = opt.tiltSign || 1, bs = opt.bodySign || 1;
  return {
    id1: Math.round(REST.id1 + bs * 29.6 * f.body),
    id2: Math.round(REST.id2 - TICK * f.neck),
    id3: Math.round(REST.id3 + TICK * f.head),
    id4: Math.round(REST.id4 + ts * TICK * f.tilt),
  };
}

export function csvOf(frames, opt = {}) {
  const rows = limitFrames(frames, opt).map((f) => { const k = toTicks(f, opt); return `${f.t.toFixed(1)},${k.id1},${k.id2},${k.id3},${k.id4}`; });
  return 't,id1,id2,id3,id4\n' + rows.join('\n') + '\n';
}

// 뷰포트 모션과 로봇용 모션이 얼마나 다른지 요약
export function report(frames, opt = {}) {
  const lim = limitFrames(frames, opt), J = ['neck', 'head', 'tilt', 'body'], out = { diff: {}, secs: {}, vel: {}, acc: 0 };
  J.forEach((j) => {
    let max = 0, n = 0, vmax = 0;
    lim.forEach((f, i) => {
      const d = Math.abs(f[j] - frames[i][j]); max = Math.max(max, d); if (d > 0.5) n++;
      if (i) vmax = Math.max(vmax, Math.abs(f[j] - lim[i - 1][j]) / STEP);
      if (i > 1) out.acc = Math.max(out.acc, Math.abs(f[j] - 2 * lim[i - 1][j] + lim[i - 2][j]) / (STEP * STEP) * (j === 'body' ? 0 : 1));
    });
    out.diff[j] = max; out.secs[j] = n * STEP; out.vel[j] = vmax;
  });
  out.fast = J.filter((j) => out.vel[j] > MAXV[j]);
  return out;
}

/* 압축 없는 ZIP (저장만) */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) {                                     // files: [{name, text}]
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const nm = enc.encode(f.name), data = enc.encode(f.text), crc = crc32(data);
    const head = new Uint8Array([0x50, 0x4b, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0]);
    parts.push(head, nm, data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0x21, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(off)]), nm);
    off += head.length + nm.length + data.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(off), 0, 0]);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
