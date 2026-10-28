// "눈 만들기" 독: 눈 그림(팔레트)을 끌어서 왼쪽·오른쪽 눈 칸이나 타임라인의 눈 줄에 넣어 표정을 직접 만든다.
// 드래그 데이터: { e } 눈 한 개 그림(표정 이름) | { eL, eR } 두 눈이 이미 짝지어진 "내 표정"
import { drawPattern, eyeRows, EXPRESSIONS } from './look.js';

export const EYE_MIME = 'application/x-cove-eye';
const $ = (s) => document.querySelector(s);
const MY_KEY = 'cove-my-eyes';

function tile(cls, size) {
  const c = document.createElement('canvas'); c.width = c.height = size; c.className = cls; return c;
}

// api: { getKey(): 지금 시간의 눈 키, edit(patch): 눈 키 수정(+그리기·저장), toast(msg) }
export function initEyeDock(api) {
  const pal = $('#edPal');
  let mine = []; try { mine = JSON.parse(localStorage.getItem(MY_KEY) || '[]'); } catch { /* 무시 */ }
  const saveMine = () => { try { localStorage.setItem(MY_KEY, JSON.stringify(mine)); } catch { /* 무시 */ } };
  const slots = { L: $('#edSlotL canvas'), R: $('#edSlotR canvas') };

  const startDrag = (e, payload) => { e.dataTransfer.setData(EYE_MIME, JSON.stringify(payload)); e.dataTransfer.setData('text/plain', JSON.stringify(payload)); e.dataTransfer.effectAllowed = 'copy'; };
  const readDrop = (e) => { try { return JSON.parse(e.dataTransfer.getData(EYE_MIME)); } catch { return null; } };

  function build() {
    pal.innerHTML = '';
    EXPRESSIONS.forEach((name) => {
      const b = document.createElement('div'); b.className = 'ed-eye'; b.draggable = true; b.title = `${name} — 끌어서 넣기 · 클릭하면 양쪽 눈`;
      const c = tile('', 56); drawPattern(c, eyeRows(name, 0, 0)); b.appendChild(c);
      const l = document.createElement('span'); l.textContent = name; b.appendChild(l);
      b.ondragstart = (e) => startDrag(e, { e: name });
      b.onclick = () => api.edit({ e: name });
      pal.appendChild(b);
    });
    mine.forEach((m, i) => {
      const b = document.createElement('div'); b.className = 'ed-eye mine'; b.draggable = true; b.title = `${m.name} — 끌어서 넣기 · 클릭하면 이 표정으로`;
      const w = document.createElement('div'); w.className = 'pair';
      [[m.eL, 0], [m.eR, 1]].forEach(([n, side]) => { const c = tile('', 40); drawPattern(c, eyeRows(n, side, 0)); w.appendChild(c); });
      b.appendChild(w);
      const l = document.createElement('span'); l.textContent = m.name; b.appendChild(l);
      const x = document.createElement('button'); x.className = 'del'; x.textContent = '×'; x.title = '내 표정 지우기';
      x.onclick = (ev) => { ev.stopPropagation(); mine.splice(i, 1); saveMine(); build(); };
      b.appendChild(x);
      b.ondragstart = (e) => startDrag(e, { eL: m.eL, eR: m.eR });
      b.onclick = () => api.edit({ eL: m.eL, eR: m.eR });
      pal.appendChild(b);
    });
  }
  build();

  // 눈 칸: 왼쪽/오른쪽 (보는 사람 기준). 여기에 끌어 놓으면 그 눈만 바뀐다. 칸의 눈을 다른 칸으로 끌어서 복사할 수도 있다.
  for (const side of ['L', 'R']) {
    const el = $('#edSlot' + side);
    el.ondragover = (e) => { if (e.dataTransfer.types.includes(EYE_MIME)) { e.preventDefault(); el.classList.add('over'); } };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = (e) => {
      e.preventDefault(); el.classList.remove('over');
      const d = readDrop(e); if (!d) return;
      if (d.e) api.edit({ ['e' + side]: d.e }); else if (d.eL) api.edit({ eL: d.eL, eR: d.eR });
    };
    el.draggable = true;
    el.ondragstart = (e) => { const k = api.getKey(); startDrag(e, { e: (side === 'L' ? k.eL : k.eR) || k.e }); };
  }
  $('#edReset').onclick = () => { const k = api.getKey(); api.edit({ e: k.eL || k.e }); };
  $('#edSwap').onclick = () => { const k = api.getKey(); api.edit({ eL: k.eR || k.e, eR: k.eL || k.e }); };
  $('#edSave').onclick = () => {
    const k = api.getKey(), n = `내 표정 ${mine.length + 1}`;
    mine.push({ name: n, eL: k.eL || k.e, eR: k.eR || k.e }); saveMine(); build(); api.toast(`'${n}'을 저장했어요 · 눈 목록 끝에 있어요`);
  };

  // 오른쪽 패널의 "눈 만들기" 접기/펼치기 (상태를 기억한다). 뷰포트의 [눈 만들기] 버튼도 같은 일을 하고, 펼칠 때 그 자리로 스크롤한다.
  const open = (on, scroll) => {
    $('#eyeBody').classList.toggle('closed', !on); $('#eyeHead').setAttribute('aria-expanded', on ? 'true' : 'false'); $('#btnEyeMaker').classList.toggle('on', on);
    try { localStorage.setItem('cove-eye-dock', on ? '1' : '0'); } catch { /* 무시 */ }
    if (on && scroll) setTimeout(() => $('#eyeSec').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 120);
  };
  const isOpen = () => !$('#eyeBody').classList.contains('closed');
  $('#eyeHead').onclick = () => open(!isOpen());
  $('#btnEyeMaker').onclick = () => open(!isOpen(), true);
  let was = false; try { was = localStorage.getItem('cove-eye-dock') === '1'; } catch { /* 무시 */ }
  open(was);

  return {
    // 뷰포트의 눈 프레임이 바뀔 때마다 두 칸에도 같은 그림을 그린다
    draw(pl, pr) { if (pl) drawPattern(slots.L, pl); if (pr) drawPattern(slots.R, pr); },
    setLabel(k) {
      $('#edSlotL .nm').textContent = k.eL || k.e; $('#edSlotR .nm').textContent = k.eR || k.e;
      $('#eyeCur').textContent = k.eL || k.eR ? `왼 ${k.eL || k.e} · 오 ${k.eR || k.e}` : k.e;
    },
  };
}
