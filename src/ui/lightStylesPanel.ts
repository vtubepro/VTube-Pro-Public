// Scene tab → Lights → "Music styles" (shared/lightStyles.ts): pick a room-agnostic light choreography — sweeps,
// ping-pong, spirals, shockwaves, call-and-response, rainbow rolls, police alternates, kick hits, blackout → hit, builds
// and drops — or Auto (follows the music's energy), with live mini previews (the same maths the OBS page runs, on a
// virtual 12 × 4 rig at 128 BPM), ▶ preview in the Scene preview only, speed / strobes / which lighting states it
// drives, and the host's own saved styles. Stream Deck: POST /api/scene/lighting {"style":"neon_rave"}.
import type { App } from '../app.ts';
import type { LightingLook } from '../../shared/types.ts';
import { forScripts } from './forScripts.ts';
import { lookOf, PALETTES } from '../../shared/lightShow.ts';
import { DEFAULT_STYLE_OPTS, LIGHT_STYLES, STYLE_CATS, autoStyle, resolveStyle, styleEval, styleLayer, type FixGeo, type LightStyle, type StyleIn, type StyleOut, type StyleSection } from '../../shared/lightStyles.ts';
import { button, h, slider, toggle } from './dom.ts';

const CSS = `
.ls-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap:6px; margin:4px 0 8px; }
.ls-card { border:1px solid var(--line); border-radius:8px; background:#12151b; padding:4px; cursor:pointer; position:relative; }
.ls-card.cur { border-color:#ff4fd8; box-shadow:0 0 10px #ff4fd855; }
.ls-card canvas { width:100%; height:30px; display:block; border-radius:5px; background:#05060a; }
.ls-card .nm { font-size:12px; font-weight:700; margin:3px 2px 0; display:flex; justify-content:space-between; align-items:center; gap:4px; }
.ls-card .nm button { padding:0 6px; font-size:11px; }
.ls-card .vb { font-size:10px; color:var(--dim); margin:1px 2px 0; line-height:1.2; }
.ls-cat { font-size:11px; color:var(--dim); margin:6px 0 2px; text-transform:uppercase; letter-spacing:.06em; }
.ls-mine { display:grid; grid-template-columns: 1fr auto auto; gap:4px; align-items:center; margin:2px 0; }
`;
let css = false;

// ---------------------------------------------------------------- the mini previews (one shared animation loop)
const COLS = 12, ROWS = 4;
const GEO: FixGeo[] = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
  const x = c / (COLS - 1), z = r / (ROWS - 1), y = r === 0 ? 0.9 : r === ROWS - 1 ? 0.05 : 0.5;
  const dx = x - 0.5, dz = z - 0.5;
  GEO.push({ x, y, z, ang: (Math.atan2(dz, dx) / (Math.PI * 2) + 1) % 1, r: Math.min(1, Math.hypot(dx * 1.1, dz * 0.9) / 0.55), i: r * COLS + c, n: COLS * ROWS, seed: ((r * 7 + c * 13) % 17) / 17 });
}
const previews = new Map<HTMLCanvasElement, () => LightStyle>();
let raf = 0;
const SEC: [StyleSection, number][] = [['groove', 16], ['build', 8], ['drop', 8], ['breakdown', 8]];
function tick() {
  raf = 0;
  const alive = [...previews.keys()].filter((c) => c.isConnected);
  for (const c of previews.keys()) if (!c.isConnected) previews.delete(c);
  if (!alive.length) return;
  const now = performance.now();
  const beat = now / (60000 / 128);
  // a 40-beat demo arrangement: groove · build · drop · breakdown
  let b = beat % 40, sec: StyleSection = 'groove', from = 0;
  for (const [s, n] of SEC) { if (b < n) { sec = s; break; } b -= n; from += n; }
  const kickAge = (beat % 1) * (60000 / 128), snareAge = ((beat + 1) % 2) * (60000 / 128), hatAge = ((beat * 2) % 1) * (30000 / 128);
  const inp: StyleIn = { beat, barPos: beat % 4, bar: Math.floor(beat / 4), phrase: Math.floor(beat / 32), kickAge: sec === 'breakdown' ? 99999 : kickAge, snareAge, hatAge, hatSeq: Math.floor(beat * 2), kickSeq: Math.floor(beat), snareSeq: Math.floor(beat / 2),
    dropAge: sec === 'drop' ? (beat % 40 - 24) * (60000 / 128) : 99999, energy: sec === 'drop' ? 0.9 : 0.6, buildK: sec === 'build' ? b / 8 : 0, speed: 1, strobes: true, gate: () => 1, now };
  const out: StyleOut = { lv: 0, mix: 0, hue: 0, white: 0 };
  for (const cv of alive) {
    const st = previews.get(cv)!();
    const g = cv.getContext('2d')!;
    const W = cv.width, H = cv.height, cw = W / COLS, ch = H / ROWS;
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    const pal = st.palette[Math.floor(beat / 32) % st.palette.length];
    const layer = styleLayer(st, sec);
    for (const f of GEO) {
      styleEval(layer, f, inp, out);
      const col = out.hue ? hsl(out.hue) : mixHex(pal[0], pal[1], out.mix);
      const v = Math.min(1, out.lv);
      const r = col[0] + (255 - col[0]) * out.white, gg = col[1] + (255 - col[1]) * out.white, bb = col[2] + (255 - col[2]) * out.white;
      g.fillStyle = `rgb(${Math.round(r * v)},${Math.round(gg * v)},${Math.round(bb * v)})`;
      const cx = (f.i % COLS) * cw + cw / 2, cy = Math.floor(f.i / COLS) * ch + ch / 2;
      g.beginPath(); g.arc(cx, cy, Math.min(cw, ch) * 0.38, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.55)'; g.font = '9px sans-serif'; g.fillText(sec, 3, H - 3);
  }
  raf = requestAnimationFrame(tick);
}
const hex = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const mixHex = (a: string, b: string, k: number) => { const A = hex(a), B = hex(b); return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k]; };
function hsl(hh: number) { const f = (n: number) => { const k = (n + hh * 12) % 12; const a = 0.5; return 255 * (0.55 - a * 0.9 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; }
function preview(get: () => LightStyle) {
  const cv = h('canvas', { width: 240, height: 76 }) as HTMLCanvasElement;
  previews.set(cv, get);
  if (!raf) raf = requestAnimationFrame(tick);
  return cv;
}

let saveName = '';
const openCats = new Set<string>();
let savePal = '';

export function stylesSection(app: App, rerender: () => void): HTMLElement {
  if (!css) { document.head.append(h('style', null, CSS)); css = true; }
  const S = app.scene, L = S.effective.lights, edit = S.canEdit;
  const cur = L.style ?? '';
  const opts = L.styleOpts ?? DEFAULT_STYLE_OPTS;
  const previewing = (S as unknown as { previewing: LightingLook | null }).previewing;
  const prevId = previewing?.style ?? '';
  const use = (id: string) => { S.previewLook(null); S.setLights({ style: id || undefined }); };
  const play = (id: string) => {
    if (prevId === id) { S.previewLook(null); return; }
    const base = lookOf(L, 'preshow');
    S.previewLook({ ...base, style: id, music: 'auto', fx: Math.max(0.6, base.fx) });
  };
  const card = (id: string, st: LightStyle, name: string, vibe: string) => {
    const on = cur === id;
    return h('div', { class: `ls-card ${on ? 'cur' : ''}`, title: vibe, onClick: () => { if (edit) use(id); } },
      preview(() => st),
      h('div', { class: 'nm' }, h('span', null, name), h('button', { class: 'btn', title: 'Preview in the Scene-tab preview only', onClick: (e: Event) => { e.stopPropagation(); play(id); } }, prevId === id ? '■' : '▶')),
      h('div', { class: 'vb' }, vibe));
  };
  // Auto: the preview shows what it would pick for a mid-energy groove right now
  const autoNow = () => autoStyle(Math.floor(performance.now() / (60000 / 128) / 64), 0, 0.6, 'groove');
  // one folding group per category: Signature + the category of the style in use start open
  const curCat = resolveStyle(cur, L.userStyles)?.style.cat;
  const cats = STYLE_CATS.map((c) => {
    const list = LIGHT_STYLES.filter((s) => s.cat === c.id);
    const d = h('details', { open: c.id === 'signature' || c.id === curCat || openCats.has(c.id) },
      h('summary', { class: 'ls-cat', style: 'cursor:pointer' }, `${c.label} (${list.length})`),
      h('div', { class: 'ls-grid' }, ...list.map((s) => card(s.id, s, s.name, s.vibe))));
    d.addEventListener('toggle', () => { if ((d as HTMLDetailsElement).open) openCats.add(c.id); else openCats.delete(c.id); });
    return d;
  });
  const mine = (L.userStyles ?? []).map((u, i) => {
    const r = resolveStyle(`u:${i}`, L.userStyles);
    return h('div', { class: 'ls-mine' },
      h('span', null, `★ ${u.name}`, h('small', { style: 'color:var(--dim)' }, ` (${r?.style.name ?? u.base}${u.speed && u.speed !== 1 ? `, ${u.speed}×` : ''})`)),
      edit ? button(cur === `u:${i}` ? 'In use' : 'Use', () => use(`u:${i}`), cur === `u:${i}` ? 'primary' : '') : h('span'),
      edit ? button('✕', () => { const next = (L.userStyles ?? []).filter((_, k) => k !== i); S.setLights({ userStyles: next.length ? next : undefined, ...(cur.startsWith('u:') ? { style: undefined } : {}) }); }) : h('span'));
  });
  const baseId = cur && !cur.startsWith('u:') && cur !== 'auto' ? cur : resolveStyle(cur, L.userStyles)?.style.id ?? 'neon_rave';
  const nameIn = h('input', { type: 'text', placeholder: 'Name (e.g. Friday bangers)', value: saveName, style: 'width:100%', onInput: (e: Event) => { saveName = (e.target as HTMLInputElement).value; } });
  const palSel = h('select', { onChange: (e: Event) => { savePal = (e.target as HTMLSelectElement).value; } },
    h('option', { value: '', selected: !savePal }, 'The style’s own colours'),
    ...Object.entries(PALETTES).filter(([k]) => !k.startsWith('p_') && k !== 'authored').map(([k, p]) => h('option', { value: k, selected: savePal === k }, p.label)));
  const save = () => {
    const list = [...(L.userStyles ?? [])];
    if (list.length >= 12) return;
    list.push({ name: (saveName || `${LIGHT_STYLES.find((s) => s.id === baseId)?.name ?? 'My'} (mine)`).slice(0, 32), base: baseId, ...(savePal ? { palette: PALETTES[savePal].pairs } : {}), ...(opts.speed !== 1 ? { speed: opts.speed } : {}) });
    saveName = ''; S.setLights({ userStyles: list, style: `u:${list.length - 1}` });
  };
  const states = (['preshow', 'show', 'outro', 'react', 'brb'] as const).map((sid) => h('label', { style: 'margin-right:8px;font-size:12px' },
    h('input', { type: 'checkbox', checked: opts.states.includes(sid), disabled: !edit, onChange: (e: Event) => {
      const on = (e.target as HTMLInputElement).checked; const next = on ? [...new Set([...opts.states, sid])] : opts.states.filter((x) => x !== sid);
      S.setLights({ styleOpts: { ...opts, states: next } });
    } }), ` ${sid[0].toUpperCase() + sid.slice(1)}`));
  const box = h('div', null,
    h('p', { class: 'note', style: 'margin:10px 0 2px' }, h('b', null, 'Music styles'), ' — light choreography for any room: every show light is placed by where it hangs, so sweeps, spirals and shockwaves travel across YOUR room on the beat; builds speed up, drops blast, breakdowns breathe. Practical lamps keep their own programs.'),
    previewing?.style ? h('div', { class: 'lt-pb-prev' }, `Previewing "${resolveStyle(previewing.style, L.userStyles)?.style.name ?? previewing.style}" in the Scene-tab preview only. `, button('Stop preview', () => S.previewLook(null))) : h('span'),
    h('div', { class: 'ls-grid' },
      h('div', { class: `ls-card ${cur === '' ? 'cur' : ''}`, onClick: () => { if (edit) use(''); }, title: 'The classic per-group programs (Lights → groups, the lighting-state presets)' },
        h('div', { class: 'nm' }, h('span', null, 'Off (classic programs)')), h('div', { class: 'vb' }, 'Each light group runs its own program')),
      h('div', { class: `ls-card ${cur === 'auto' ? 'cur' : ''}`, onClick: () => { if (edit) use('auto'); }, title: 'Picks a style from the music every 16 bars and on every drop: moods in breakdowns, sweeps in grooves, hits and shockwaves in bangers' },
        preview(autoNow), h('div', { class: 'nm' }, h('span', null, '🎲 Auto'), h('button', { class: 'btn', onClick: (e: Event) => { e.stopPropagation(); play('auto'); } }, prevId === 'auto' ? '■' : '▶')),
        h('div', { class: 'vb' }, 'Follows the music’s energy'))),
    ...cats,
    slider('Style speed', opts.speed, 0.5, 2, 0.05, (v) => S.setLights({ styleOpts: { ...opts, speed: v } }), 'Sweeps, spirals and waves per bar', (v) => `${v.toFixed(2)}×`, { def: 1 }),
    toggle('Strobe / white hits', opts.strobes, (v) => S.setLights({ styleOpts: { ...opts, strobes: v } }), 'Off: no white strobe hits (colour pulses only). The photosensitivity limit above always applies.'),
    h('div', { class: 'row' }, h('span', { class: 'lbl' }, 'Drives'), h('span', null, ...states)),
    h('div', { class: 'ls-cat' }, 'My styles'),
    ...(mine.length ? mine : [h('p', { class: 'note' }, 'Save a style with your own colours and speed:')]),
    edit ? h('div', { class: 'btns tight' }, nameIn, palSel, button('★ Save current', save, 'primary')) : h('span'),
    forScripts('Stream Deck / scripts: POST http://127.0.0.1:5191/api/scene/lighting {"style":"neon_rave"} (or "auto", "off", "u:0").'));
  if (!edit) for (const x of box.querySelectorAll('input,select')) (x as HTMLInputElement).disabled = true;
  void rerender;
  return box;
}
