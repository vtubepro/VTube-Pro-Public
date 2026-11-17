// The Look Lab (looklab.html): every generated festival look plays live on a mini stage (the same renderers as the
// rooms: src/scene/festival/stageRig.ts) - keep it, remove it or star it (buttons, ← / → / ↑ keys, or swipe), filter by
// state / energy / show, search. The picks are saved in this browser (localStorage, LOOKLAB_KEY) and the studio's
// Festival section applies them to the stage ("Use these looks on my stage" does it in one click). The Quality team's
// first pass (shared/festivalQuality.ts) is the starting point. ?sheet=1&from=0&n=36 renders a contact sheet (tests).
// Never plays sound: the music is a synthetic beat grid (numbers only).
import * as THREE from 'three';
import { FlashGate, b64ToBits, bitsToB64, hash3, sanitizeFestivalConfig, type FestivalCuration } from '../../../../shared/festival.ts';
import { ACCENTS, GENRES, LOOKS_VERSION, MOTIONS, RHYTHMS, SPREADS, catalogue, type Look, type Section } from '../../../../shared/festivalLooks.ts';
import { direct, lookFrame, type MusicState } from '../../../../shared/festivalDirector.ts';
import { QUALITY_KILL, QUALITY_NOTES } from '../../../../shared/festivalQuality.ts';
import type { Fixture } from '../common.ts';
import { StageRig, tierFixtures, type WallSpec } from '../stageRig.ts';
import type { CrowdArea } from '../crowd.ts';
import { FestivalGov } from '../gov.ts';

const LOOKLAB_KEY = 'vtp.festival.curation.v1';
const APPLY_KEY = 'vtp.festival.apply';
const q = new URLSearchParams(location.search);
const SHEET = q.get('sheet') === '1';
const cat = catalogue(null);
const looks = cat.looks;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- curation state (this browser)
interface Saved extends FestivalCuration { seen: string }
let kill: boolean[] = [], fav: boolean[] = [], seen: boolean[] = [];
function load() {
  let s: Saved | null = null;
  try { s = JSON.parse(localStorage.getItem(LOOKLAB_KEY) ?? 'null'); } catch { s = null; }
  if (s && s.v === LOOKS_VERSION) { kill = b64ToBits(s.kill, looks.length); fav = b64ToBits(s.fav, looks.length); seen = b64ToBits(s.seen ?? '', looks.length); }
  else { kill = looks.map((l) => QUALITY_KILL.has(l.id)); fav = looks.map(() => false); seen = looks.map(() => false); }
}
function save() {
  const s: Saved = { v: LOOKS_VERSION, kill: bitsToB64(kill), fav: bitsToB64(fav), seen: bitsToB64(seen) };
  try { localStorage.setItem(LOOKLAB_KEY, JSON.stringify(s)); } catch { /* private mode: picks live in this tab only */ }
}
load();

// ---------------------------------------------------------------- the mini stage
const canvas = $<HTMLCanvasElement>('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x04050a);
scene.fog = new THREE.Fog(0x05060c, 40, 120);
const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 400);
camera.position.set(0, 6.5, 38); camera.lookAt(0, 7.0, -2);
scene.add(new THREE.HemisphereLight(0x223355, 0x0a0a10, 0.6));
const room = new THREE.Group(); scene.add(room);
const dark = new THREE.MeshStandardMaterial({ color: 0x111218, roughness: 0.8, metalness: 0.2 });
const add = (g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); room.add(o); return o; };
add(new THREE.BoxGeometry(160, 0.2, 140), new THREE.MeshStandardMaterial({ color: 0x0c110d, roughness: 1 }), 0, -0.1, 30);
add(new THREE.BoxGeometry(30, 1.2, 8), dark, 0, 0.6, -3.5);
for (const s of [-1, 1]) add(new THREE.BoxGeometry(1.2, 13, 1.2), dark, s * 14.6, 6.5, -3);
add(new THREE.BoxGeometry(30.4, 1.2, 1.2), dark, 0, 12.6, -3);
add(new THREE.BoxGeometry(28, 0.45, 0.45), new THREE.MeshStandardMaterial({ color: 0x8a9099, metalness: 0.7, roughness: 0.4 }), 0, 9.3, -1.6);
const wallMesh = add(new THREE.PlaneGeometry(18, 9), new THREE.MeshBasicMaterial({ color: 0x050608 }), 0, 6.2, -6.5) as THREE.Mesh;
for (const s of [-1, 1]) add(new THREE.BoxGeometry(1.6, 2.2, 1.2), dark, s * 3, 1.2 + 1.1, -2.4);       // booth-ish blocks
const booth = add(new THREE.BoxGeometry(4.4, 1.0, 0.8), dark, 0, 1.7, -1.6);
void booth;
// fixtures, built like a room's FX_ anchors
const fixtures: Fixture[] = [];
let idx = 0;
const F = (kind: Fixture['kind'], group: string, x: number, y: number, z: number, extras: Record<string, unknown> = {}, hung = false): Fixture => {
  const f: Fixture = { kind, group, index: ++idx, name: `FX_${kind.toUpperCase()}_${group}_${idx}`, pos: new THREE.Vector3(x, y, z), quat: new THREE.Quaternion(), extras, mesh: null, geo: { x: 0, y: 0, z: 0, i: 0, n: 1, seed: hash3(idx, 7) }, hung };
  fixtures.push(f); return f;
};
for (let i = 0; i < 14; i++) F('beam', 'TRUSS', -13 + i * 2, 9.0, -1.6, {}, true);
for (let i = 0; i < 10; i++) F('beam', 'DECK', -13.5 + i * 3, 1.25, -0.2);
for (let i = 0; i < 6; i++) F('beam', 'TOP', -12.5 + i * 5, 13.25, -3);
for (let i = 0; i < 6; i++) F('spot', 'TRUSS', -12.5 + i * 5, 9.0, -1.3, {}, true);
for (let i = 0; i < 6; i++) F('wash', 'TRUSS', -10 + i * 4, 9.0, -1.9, {}, true);
for (let i = 0; i < 12; i++) { const x = -13.75 + i * 2.5; F('par', 'DECK', x, 1.25, 0.25, { aim: [x * 1.1, 14, -3] }); }
for (let i = 0; i < 6; i++) { const x = -12.5 + i * 5; F('strobe', 'TRUSS', x, 8.6, -1.2, { aim: [x * 0.4, 1.5, 20] }); }
for (let i = 0; i < 4; i++) { const x = -9 + i * 6; F('blinder', 'TOP', x, 11.5, -2.3, { aim: [x * 0.4, 1.5, 18] }); }
for (const x of [-9, -3, 3, 9]) F('laser', 'DECK', x, 1.4, 0.2);
const px = (a: THREE.Vector3, b: THREE.Vector3, bars: number) => { const d = b.clone().sub(a); const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), d.clone().normalize()); for (let k = 0; k < bars; k++) { const f = F('pixel', 'FRAME', 0, 0, 0, { length: d.length() / bars * 0.95, pixels: 16 }); f.pos.copy(a).addScaledVector(d, (k + 0.5) / bars); f.quat.copy(q2); } };
px(new THREE.Vector3(-13.9, 1.4, -2.3), new THREE.Vector3(-13.9, 12, -2.3), 5); px(new THREE.Vector3(-13.9, 12, -2.3), new THREE.Vector3(13.9, 12, -2.3), 10); px(new THREE.Vector3(13.9, 12, -2.3), new THREE.Vector3(13.9, 1.4, -2.3), 5);
px(new THREE.Vector3(-15, 1.0, 0.45), new THREE.Vector3(15, 1.0, 0.45), 8);
for (let i = 0; i < 8; i++) F('flame', 'DECK', -12.25 + i * 3.5, 1.25, 0.1);
for (const x of [-11, -4, 4, 11]) F('co2', 'DECK', x, 1.25, -0.1);
for (const s of [-1, 1]) F('confetti', 'DECK', s * 13, 1.3, 0, { aim: [s * 7, 9, 12] });
for (let i = 0; i < 6; i++) F('gerb', 'DECK', -10 + i * 4, 1.25, 0.3);
for (const x of [-6, 6]) F('comet', 'DECK', x, 1.25, -0.4);
for (const x of [-16, 0, 16]) F('firework', 'BACK', x, 0, -18);
const cfg = sanitizeFestivalConfig({ floorY: 0, deckY: 1.2, deckFront: 0.5, haze: 0.8, title: 'LOOK LAB', crowd: { color: '#141720' } })!;
const walls: WallSpec[] = [{ mesh: wallMesh, role: 'main' }];
const areas: CrowdArea[] = [{ center: new THREE.Vector3(0, 0, 11), yaw: Math.PI, rx: 16, rz: 5, density: 1.3, ellipse: false, keepOut: [] }];
const tier = (q.get('tier') as 'low' | 'medium' | 'high' | 'ultra') || 'high';
const rig = new StageRig(tierFixtures(fixtures, tier), tier, cfg, walls, areas, [], new THREE.Box3(new THREE.Vector3(-80, -1, -70), new THREE.Vector3(80, 40, 100)));
room.add(rig.root);
const gate = new FlashGate();

// ---------------------------------------------------------------- music (synthetic grid, numbers only)
let mode: Section = 'drop';
let bpm = 150;
const t0 = performance.now();
function music(nowMs: number, look: Look): MusicState {
  const beat = ((nowMs - t0) / 60000) * bpm + 0.001;
  const bi = Math.floor(beat), cyc = 32, c = ((bi % cyc) + cyc) % cyc, start = bi - c;
  const ph = beat - bi;
  let sec: Section = mode, lastDrop = -Infinity, nextDrop: number | null = null, dropCount = 0, kickOn = true, sectionStart = start;
  if (mode === 'drop') { if (c < 24) { sec = 'drop'; lastDrop = start; dropCount = 1 + Math.floor(bi / cyc); } else { sec = 'build'; sectionStart = start + 24; nextDrop = start + cyc; lastDrop = start; dropCount = 1 + Math.floor(bi / cyc); kickOn = false; } }
  else if (mode === 'build') { sec = 'build'; nextDrop = start + cyc; kickOn = false; }
  else if (mode === 'breakdown' || mode === 'intro') kickOn = false;
  void look;
  return { live: false, bpm, beat, barPos: ((beat % 4) + 4) % 4, bar: Math.floor(bi / 4), section: sec, sectionStart, prevSection: 'groove', energy: sec === 'drop' ? 1 : sec === 'build' ? 0.7 : sec === 'breakdown' ? 0.3 : 0.75,
    kick: kickOn ? Math.exp(-ph * 5) : 0, snare: 0, hat: 0, kickOn, lastDrop, dropCount, nextDrop, known: true };
}

// ---------------------------------------------------------------- the frame
let cur = 0;
// the same photosensitivity governor as a stage (its own here: the lab has no room light show)
const gov = new FestivalGov(); gov.bind(null);
function frameFor(look: Look, nowMs: number, dt: number, pyro = true) {
  const m = music(nowMs, look);
  const d = direct(cat, cat.shows[0].id, m, { pyro, pinned: look.id, cfg });
  const lf = lookFrame(cat, d.look, m, d);
  const spb = 60 / m.bpm;
  gov.frame(nowMs, m.beat, m.bpm, true, gate.safe);
  rig.frame({ d, m, lf, pf: null, level: 1, master: 1 - d.blackout, gate: (k, at) => gate.depth(k, at * spb * 1000), gov, safe: gate.safe, warn: gate.safe ? 'off' : 'badge',
    nowSec: (nowMs - t0) / 1000, dt, cam: camera.position, faces: null, faceList: [], haze: cfg.haze, nowMs });
  return { m, d };
}
function resize() {
  const w = canvas.clientWidth || 1280, h = canvas.clientHeight || 720;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- contact sheet (tests / the Sheet button)
if (SHEET) {
  document.body.classList.add('sheet');
  const from = Number(q.get('from') ?? 0), n = Number(q.get('n') ?? 36), cols = Number(q.get('cols') ?? 6);
  const ids = (q.get('ids') ?? '').split(',').filter(Boolean);
  // (&family=<show-pack family>: that family's looks, from / n within it)
  const fam = q.get('family');
  const pool = fam ? looks.filter((l) => l.pack?.family === fam) : looks;
  const list = ids.length ? looks.filter((l) => ids.includes(l.id)) : pool.slice(from, from + n);
  const rows = Math.ceil(list.length / cols);
  const wrap = $('stageWrap'); wrap.style.aspectRatio = 'auto'; wrap.style.height = '100vh'; wrap.style.borderRadius = '0';
  $('left').style.padding = '0';
  resize();
  const W = canvas.width, H = canvas.height, tw = Math.floor(W / cols), th = Math.floor(H / rows);
  renderer.setScissorTest(true);
  camera.aspect = tw / th; camera.updateProjectionMatrix();
  const labels = document.createElement('div'); labels.style.cssText = 'position:absolute;inset:0;pointer-events:none';
  list.forEach((look, i) => {
    // a fixed moment that shows the look: drops 2.3 beats in, grooves / chill mid-bar
    mode = look.pack?.family === 'build' ? 'build' : look.cls === 'peak' ? 'drop' : look.cls === 'mid' ? 'groove' : 'breakdown';
    const beatAt = mode === 'build' ? 21.3 : look.cls === 'peak' ? 2.3 : 5.6;
    const nowMs = t0 + (beatAt / bpm) * 60000;
    // (each tile shows its own wall visual: the walls' 0.6 s cross-fade from the previous tile is skipped)
    const lw = rig.walls as unknown as { xf?: { to: number } } | null; if (lw?.xf) lw.xf.to = -1;
    const x = (i % cols) * tw, y = H - (Math.floor(i / cols) + 1) * th;
    renderer.setViewport(x, y, tw, th); renderer.setScissor(x, y, tw, th);
    // 1.2 s of frames up to the moment: the photosensitivity governor's windows open and every light settles on this
    // look (a jump straight from the previous tile's look would show what the governor still holds)
    const stats = q.get('stats') === '1';
    const gl = renderer.getContext(), px = stats ? new Uint8Array(tw * th * 4) : null;
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    let sum = 0, lit = 0, white = 0, n = 0, lo = Infinity, nextQ = nowMs - (1 / bpm) * 60000;
    for (let t = nowMs - 1200; t <= nowMs + 1; t += 1000 / 60) {
      frameFor(look, Math.min(t, nowMs), 1 / 60, false);
      // (&stats=1: what the look shows over its last beat - 4 moments a quarter beat apart: mean linear luminance, the
      // lit / blown-out share of its pixels - the curation pass)
      if (stats && px && t >= nextQ) {
        nextQ += (0.25 / bpm) * 60000;
        renderer.render(scene, camera); gl.readPixels(x, y, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s1 = 0, n1 = 0;
        for (let k = 0; k < px.length; k += 16) { const l = 0.2126 * lin(px[k]) + 0.7152 * lin(px[k + 1]) + 0.0722 * lin(px[k + 2]); s1 += l; if (l > 0.03) lit++; if (px[k] > 225 && px[k + 1] > 225 && px[k + 2] > 225) white++; n1++; }
        sum += s1; n += n1; lo = Math.min(lo, s1 / n1);
      }
    }
    renderer.render(scene, camera);
    if (stats) ((window as unknown as { vtpLabStats: Record<string, unknown> }).vtpLabStats ??= {})[look.id] = { name: look.name, cls: look.cls, family: look.pack?.family ?? 'base', mean: +(sum / Math.max(1, n)).toFixed(4), low: +lo.toFixed(4), lit: +(lit / Math.max(1, n)).toFixed(3), white: +(white / Math.max(1, n)).toFixed(3) };
    const lb = document.createElement('div');
    const cssW = canvas.clientWidth / cols, cssH = canvas.clientHeight / rows;
    lb.style.cssText = `position:absolute;left:${(i % cols) * cssW + 6}px;top:${Math.floor(i / cols) * cssH + 4}px;font:600 12px Segoe UI;color:#fff;text-shadow:0 1px 2px #000;`;
    lb.textContent = `${from + i + 1}. ${look.name} · ${look.id}${look.pack ? ` · ${look.pack.family}` : ''}${kill[looks.indexOf(look)] ? '  ✗' : ''}`;
    labels.append(lb);
  });
  wrap.append(labels);
  (window as unknown as { vtpLabReady: boolean }).vtpLabReady = true;
} else {
  // ---------------------------------------------------------------- interactive
  const order = () => {
    const qs = ($<HTMLInputElement>('q').value || '').toLowerCase();
    const st = $<HTMLSelectElement>('fState').value, cl = $<HTMLSelectElement>('fCls').value, sh = $<HTMLSelectElement>('fShow').value;
    const show = sh ? cat.showById.get(sh) : null;
    const inShow = show ? new Set([...Object.values(show.sections).flat(), ...Object.values(show.pack ?? {}).flat()]) : null;
    return looks.map((l, i) => ({ l, i })).filter(({ l, i }) =>
      (!qs || `${l.name} ${l.motion} ${l.rhythm} ${l.palette} ${l.accent} ${l.pack ? `${l.pack.family} ${l.pack.sub} show pack` : ''}`.toLowerCase().includes(qs))
      && (!cl || l.cls === cl) && (!inShow || inShow.has(l.id))
      && (st === 'all' || (st === 'todo' && !seen[i]) || (st === 'keep' && seen[i] && !kill[i]) || (st === 'kill' && kill[i]) || (st === 'fav' && fav[i])));
  };
  const showSel = $<HTMLSelectElement>('fShow');
  for (const g of GENRES) { const og = document.createElement('optgroup'); og.label = g.name; for (const s of cat.shows.filter((x) => x.genre === g.id)) { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; og.append(o); } showSel.append(og); }
  const secBar = $('sections');
  const secs: [Section, string][] = [['groove', 'Groove'], ['build', 'Build-up'], ['drop', 'Drop'], ['breakdown', 'Breakdown']];
  const secBtns = secs.map(([s, label]) => { const b = document.createElement('button'); b.textContent = label; b.onclick = () => { mode = s; paintSecs(); }; secBar.append(b); return [s, b] as const; });
  const paintSecs = () => secBtns.forEach(([s, b]) => b.classList.toggle('on', s === mode));
  paintSecs();
  const bpmIn = $<HTMLInputElement>('bpm');
  bpmIn.oninput = () => { bpm = Number(bpmIn.value); $('bpmV').textContent = `${bpm} BPM`; };
  $<HTMLInputElement>('strobe').onchange = (e) => { gate.safe = !(e.target as HTMLInputElement).checked; gate.reset(); };
  const list = $('list');
  const toast = (t: string) => { const el = $('toast'); el.textContent = t; el.style.opacity = '1'; clearTimeout((toast as unknown as { h: number }).h); (toast as unknown as { h: number }).h = window.setTimeout(() => { el.style.opacity = '0'; }, 1800); };
  const paintList = () => {
    const rows = order();
    list.textContent = '';
    for (const { l, i } of rows.slice(0, 400)) {
      const el = document.createElement('div'); el.className = `item${i === cur ? ' sel' : ''}`;
      const sw = document.createElement('div'); sw.className = 'swatches';
      for (const c of cat.palettes.get(l.palette)!.colors.slice(0, 4)) { const s = document.createElement('div'); s.className = 'sw'; s.style.background = c; s.style.width = '12px'; sw.append(s); }
      const n = document.createElement('div'); n.className = 'n';
      n.innerHTML = `<div>${l.name}</div><small>${l.cls === 'peak' ? 'Drop' : l.cls === 'mid' ? 'Groove' : 'Chill'} · ${l.pack ? `show pack: ${l.pack.family}` : `${l.motion} · ${l.rhythm}`}</small>`;
      const tag = document.createElement('span');
      tag.className = `tag ${kill[i] ? (QUALITY_KILL.has(l.id) && !seen[i] ? 'q' : 'x') : fav[i] ? 'f' : seen[i] ? 'k' : ''}`;
      tag.textContent = kill[i] ? (QUALITY_KILL.has(l.id) && !seen[i] ? 'Quality: removed' : 'Removed') : fav[i] ? '★' : seen[i] ? 'Kept' : 'New';
      if (QUALITY_NOTES[l.id]) tag.title = QUALITY_NOTES[l.id];
      el.append(sw, n, tag);
      el.onclick = () => { cur = i; paint(); };
      list.append(el);
    }
    const nSeen = seen.filter(Boolean).length, nKill = kill.filter(Boolean).length, nFav = fav.filter(Boolean).length;
    $('count').textContent = `${nSeen} / ${looks.length} reviewed · ${looks.length - nKill} in your shows · ${nFav} ★`;
    $('prog').innerHTML = `<i style="width:${(nSeen - nKill) / looks.length * 100}%;background:var(--ok)"></i><i style="width:${nKill / looks.length * 100}%;background:var(--bad)"></i>`;
  };
  const paint = () => {
    const l = looks[cur];
    $('hName').textContent = l.name;
    $('hMeta').textContent = `${l.cls === 'peak' ? 'Drop look' : l.cls === 'mid' ? 'Groove look' : 'Chill look'} · energy ${Math.round(l.energy * 100)} %`;
    const pal = cat.palettes.get(l.palette)!;
    $('sw').innerHTML = pal.colors.map((c) => `<div class="sw" style="background:${c}" title="${c}"></div>`).join('') + `<span class="note" style="margin-left:8px">${pal.name}</span>`;
    const shows = cat.shows.filter((s) => [...Object.values(s.sections), ...Object.values(s.pack ?? {})].some((v) => v.includes(l.id))).map((s) => s.name);
    const nm = (list2: { id: string; name: string }[], id: string) => list2.find((x) => x.id === id)?.name ?? id;
    if (l.pack) { $('info').innerHTML = `<span>Show pack</span><b>${l.pack.family} · ${l.pack.sub}</b><span>Beams</span><b>${l.pack.beam.form} · ${l.pack.level.target} ${l.pack.level.motion} · ${l.pack.level.shape}</b><span>Lasers</span><b>${l.pack.laser ? `${l.pack.laser.form} · ${l.pack.laser.target}` : 'off'} · screen ${l.wall}</b><span>Fits</span><b>${l.pack.genres.join(', ')} · ${l.pack.sections.join(', ')}</b><span>Plays in</span><b>${shows.slice(0, 4).join(', ') || 'no show yet'}${shows.length > 4 ? ` +${shows.length - 4}` : ''}</b>`; }
    else $('info').innerHTML = `<span>Movement</span><b>${nm(MOTIONS, l.motion)}</b><span>Rhythm</span><b>${nm(RHYTHMS, l.rhythm)} (beams: ${nm(RHYTHMS, l.beamRhythm)})</b><span>Spread</span><b>${nm(SPREADS, l.spread)}</b><span>Accents</span><b>${nm(ACCENTS, l.accent)} · lasers ${l.laser} · screen ${l.wall}</b><span>Plays in</span><b>${shows.slice(0, 4).join(', ') || 'no show yet'}${shows.length > 4 ? ` +${shows.length - 4}` : ''}</b>`;
    $('bFav').classList.toggle('on', fav[cur]);
    mode = l.cls === 'peak' ? 'drop' : l.cls === 'chill' ? 'breakdown' : 'groove'; paintSecs();
    paintList();
  };
  const next = () => { const rows = order(); const at = rows.findIndex((r) => r.i === cur); const nx = rows.slice(at + 1).find((r) => !seen[r.i]) ?? rows[at + 1] ?? rows[0]; if (nx) cur = nx.i; paint(); };
  const flash = (t: string, c: string) => { const s = $('swipe'); s.textContent = t; s.style.color = c; s.style.opacity = '1'; setTimeout(() => { s.style.opacity = '0'; }, 380); };
  const decide = (k: 'keep' | 'kill' | 'fav') => {
    if (k === 'fav') { fav[cur] = !fav[cur]; if (fav[cur]) { kill[cur] = false; seen[cur] = true; } flash('★', 'var(--fav)'); save(); paint(); return; }
    seen[cur] = true; kill[cur] = k === 'kill'; if (kill[cur]) fav[cur] = false;
    flash(k === 'kill' ? '✗' : '✓', k === 'kill' ? 'var(--bad)' : 'var(--ok)');
    save(); next();
  };
  $('bKill').onclick = () => decide('kill'); $('bKeep').onclick = () => decide('keep'); $('bFav').onclick = () => decide('fav');
  addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'ArrowLeft') decide('kill'); else if (e.key === 'ArrowRight') decide('keep'); else if (e.key === 'ArrowUp') decide('fav'); else if (e.key === 'ArrowDown') next(); else return;
    e.preventDefault();
  });
  // swipe on the stage
  let sx = 0, sy = 0, down = false;
  const wrap = $('stageWrap');
  wrap.addEventListener('pointerdown', (e) => { down = true; sx = e.clientX; sy = e.clientY; });
  wrap.addEventListener('pointerup', (e) => { if (!down) return; down = false; const dx = e.clientX - sx, dy = e.clientY - sy; if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) decide(dx > 0 ? 'keep' : 'kill'); });
  for (const id of ['q', 'fState', 'fCls', 'fShow']) $(id).addEventListener('input', paintList);
  $('bUse').onclick = () => { save(); try { localStorage.setItem(APPLY_KEY, String(Date.now())); } catch { /* */ } toast('Saved. Your studio now uses these looks (Scene tab → Festival stage).'); };
  $('bSheet').onclick = () => { const ids = order().slice(0, 36).map((r) => r.l.id).join(','); window.open(`/looklab.html?sheet=1&ids=${ids}`, '_blank'); };
  $('bExport').onclick = () => { save(); const blob = new Blob([localStorage.getItem(LOOKLAB_KEY) ?? '{}'], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'festival-looks.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); };
  $('bImport').onclick = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json'; inp.onchange = async () => { const f = inp.files?.[0]; if (!f) return; try { const s = JSON.parse(await f.text()) as Saved; if (s.v !== LOOKS_VERSION) { toast('That file is from another version of the looks.'); return; } localStorage.setItem(LOOKLAB_KEY, JSON.stringify(s)); load(); paint(); toast('Loaded your picks.'); } catch { toast('That file is not a Look Lab file.'); } }; inp.click(); };
  $('bReset').onclick = () => { if (!confirm('Start over from the Quality team’s first pass? Your picks in this browser are replaced.')) return; try { localStorage.removeItem(LOOKLAB_KEY); } catch { /* */ } load(); cur = 0; paint(); };
  cur = Math.max(0, seen.findIndex((s) => !s));
  paint();
  let last = performance.now();
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    resize();
    const { m, d } = frameFor(looks[cur], now, dt);
    $('hMusic').textContent = `${Math.round(m.bpm)} BPM · ${d.section}${d.countdown != null ? ` · drop in ${d.countdown}` : ''}`;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as unknown as { vtpLab: unknown }).vtpLab = { looks, rig, decide, set: (i: number) => { cur = i; paint(); }, state: () => ({ cur, kill: kill.filter(Boolean).length, seen: seen.filter(Boolean).length }) };
  (window as unknown as { vtpLabReady: boolean }).vtpLabReady = true;
}
