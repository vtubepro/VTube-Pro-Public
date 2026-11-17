// Raceway — the lounge itself: the engine-owned glows (RW_* materials: the buzzing broken tube, the dying I of the bar
// sign, the green clinic cross, alarm beacons, outside beacons, the hangar launch lights, gate pods lit as racers
// pass), the bartender droid on its rail, sparks / steam / confetti, and the two canvases: the RACE BOARD and the PA
// ticker. Every behaviour is a pure function of the wall clock (+ the episode / support data handed in each frame), so
// every OBS page matches.
import * as THREE from 'three';
import { hash32, Rng } from '../../raid/rng.ts';
import { SPRITE, SpaceFx } from '../fx.ts';
import type { RacewayRoom } from './racewayRoom.ts';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const hrand = (...p: (number | string)[]) => hash32(...p) / 4294967296;

export interface BoardRow { pos: number; pilot: string; c1: string; gap: string; last: string; odds: string; state: 'ok' | 'dnf' | 'rejoin' }
export interface BoardData { heat: number; lap: number; rows: BoardRow[]; banner: { title: string; sub: string; tone: 'gold' | 'red' | 'cyan' } | null; ticker: string; live: boolean }

const FONT = "'Bahnschrift SemiBold Condensed', 'Bahnschrift', 'Arial Narrow', 'Impact', sans-serif";
const MONO = "'Consolas', 'Lucida Console', monospace";

class CanvasSurface {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  constructor(w: number, h: number, mesh: THREE.Mesh, emissive = 1.6) {
    this.canvas.width = w; this.canvas.height = h;
    this.g = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.flipY = false;          // glTF UVs (v down)
    this.tex.anisotropy = 4;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    mat.name = 'vtp:raceway:canvas';
    mat.color.setScalar(emissive);
    (mesh as THREE.Mesh).material = mat;
  }
  dispose() { this.tex.dispose(); }
}

export class Lounge {
  readonly group = new THREE.Group();
  readonly fx: SpaceFx;
  private board: CanvasSurface | null = null;
  private ticker: CanvasSurface | null = null;
  private boardKey = '';
  private boardT = 0;
  private tickT = 0;
  private gateMats = new Map<number, THREE.MeshStandardMaterial>();
  private base = new Map<THREE.MeshStandardMaterial, { i: number; c: THREE.Color }>();
  private droidBase: { pos: V3; rot: THREE.Euler } | null = null;
  confetti: { at: number; seed: number }[] = [];
  paQueue: { key: string; text: string; tone: 'alert' | 'info' | 'cheer'; at: number }[] = [];
  private paCur: { key: string; text: string; tone: string; at: number } | null = null;

  constructor(readonly R: RacewayRoom) {
    this.group.name = 'vtp:raceway:lounge';
    this.fx = new SpaceFx({ sprites: 700, smoke: 160, streaks: 80 }, false);
    this.fx.uniforms.uMinPx.value = 1.0;
    this.group.add(this.fx.group);
    for (const [, list] of R.rw) for (const m of list) this.base.set(m, { i: m.emissiveIntensity, c: m.emissive.clone() });
    // per-gate clones of the gate light material (each gate lights up on its own)
    for (const g of R.gates) {
      if (!g.lights) continue;
      const src = (Array.isArray(g.lights.material) ? g.lights.material[0] : g.lights.material) as THREE.MeshStandardMaterial;
      const m = src.clone(); m.name = `${src.name}#${g.g}`;
      g.lights.material = m;
      this.gateMats.set(g.g, m);
      this.base.set(m, { i: src.emissiveIntensity, c: src.emissive.clone() });
    }
    if (R.board) this.board = new CanvasSurface(1280, 720, R.board, 1.35);
    if (R.ticker) this.ticker = new CanvasSurface(2048, 128, R.ticker, 1.8);
    if (R.droid) this.droidBase = { pos: R.droid.position.clone(), rot: R.droid.rotation.clone() };
  }

  dispose() {
    for (const [m, b] of this.base) { m.emissiveIntensity = b.i; m.emissive.copy(b.c); }
    for (const g of this.R.gates) if (g.lights) { const m = this.gateMats.get(g.g); if (m) m.dispose(); }
    if (this.R.droid && this.droidBase) { this.R.droid.position.copy(this.droidBase.pos); this.R.droid.rotation.copy(this.droidBase.rot); }
    this.board?.dispose(); this.ticker?.dispose();
    this.fx.dispose();
    this.group.removeFromParent();
  }

  private set(name: string, k: number, col?: THREE.Color) {
    for (const m of this.R.rw.get(name) ?? []) { const b = this.base.get(m); if (!b) continue; m.emissiveIntensity = b.i * k; if (col) m.emissive.copy(col); }
  }

  /** gates: lit (0..1) by the nearest racer passing; alarm 0..1; cheer 0..1 (support) */
  update(t: number, dt: number, s: { alarm: number; cheer: number; gateHeat: Map<number, number>; launch: number; turretFire: number[] }) {
    this.fx.begin(t % 3600);
    // the broken fluorescent tube: mostly on, stutters, the odd long blackout; a spark burst when it re-strikes
    const k50 = Math.floor(t * 20);
    const cyc = t % 23;
    let fl = 1;
    const hr = hrand(k50, 'fl');
    if (cyc > 17 && cyc < 17.6) fl = hr < 0.5 ? 0 : 0.35;
    else if (cyc > 19.5 && cyc < 21.3) fl = 0.02;
    else if (hr < 0.06) fl = 0.3;
    this.set('RW_flicker', fl);
    // the I of DEAD STICK: dies for a while every few minutes, buzzes back
    const ci = t % 197;
    let di = 1;
    if (ci > 150 && ci < 178) di = 0.03;
    else if (ci > 145 && ci < 150 || ci > 178 && ci < 181) di = hrand(Math.floor(t * 14), 'di') < 0.5 ? 0.05 : 1;
    this.set('RW_deadI', di);
    // clinic: a slow green pulse
    this.set('RW_clinic', 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.8)) ** 2);
    // alarm beacons in the lounge (red, ≤ 1 Hz) + outside beacons (steady blink)
    const al = s.alarm;
    this.set('RW_alarm', al > 0.01 ? 0.2 + al * 18 * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9)) : 0.12);
    this.set('RW_beacon', (t % 1.4) < 0.18 ? 1.6 : 0.12);
    this.set('RW_launch', s.launch > 0 ? 0.3 + 2.5 * ((Math.floor(t * 8) % 4) === 0 ? 1 : 0.25) : 0.35);
    this.set('RW_turret', 1 + 3 * Math.max(0, ...s.turretFire, 0));
    this.set('RW_start', 0.8 + 0.4 * Math.sin(t * 6));
    for (const [g, m] of this.gateMats) {
      const b = this.base.get(m)!;
      const h = s.gateHeat.get(g) ?? 0;
      m.emissiveIntensity = b.i * (0.35 + 2.6 * h);
    }
    // the bartender droid: rides its rail between stops (the taps), bobbing; spins when the bar cheers
    const D = this.R.droid, P = this.R.droidPath;
    if (D && P && this.droidBase) {
      const seg = 9.0, k = Math.floor(t / seg), u = (t - k * seg) / seg;
      const a = hrand(k, 'dr'), b = hrand(k + 1, 'dr');
      const move = smooth((u - 0.55) / 0.35);
      const x = a + (b - a) * move;
      D.position.copy(P[0]).lerp(P[1], x);
      D.position.y += Math.sin(t * 2.1) * 0.03;
      D.rotation.set(this.droidBase.rot.x, this.droidBase.rot.y + (s.cheer > 0 ? s.cheer * Math.PI * 4 : Math.sin(t * 0.7) * 0.4), this.droidBase.rot.z + (move > 0 && move < 1 ? 0.12 : 0));
      if (u < 0.5 && ((k % 3) === 0) && u > 0.15) {
        // pouring: a thin amber stream + sparkle under the droid
        const p = D.position.clone().add(V(0, -0.45, 0));
        this.fx.line(p, p.clone().add(V(0, -0.9, 0)), 0.006, 1.0, 1.2, 0.7, 0.2, 0.6, true);
        if (hrand(Math.floor(t * 10), 'sp') < 0.4) this.fx.sprite(p.clone().add(V(0, -0.9, 0)), 0.05, 1.4, 1.0, 0.5, 0.8, SPRITE.spark, (t * 3) % 1);
      }
    }
    // sparks (the broken tube's loose end, the junction box) + the steam vent
    for (const f of this.R.fx) {
      const kind = /STEAM/.test(f.name) ? 'steam' : /CONFETTI/.test(f.name) ? 'confetti' : 'sparks';
      if (kind === 'sparks') {
        const per = /01/.test(f.name) ? 7.3 : 11.1;
        const kk = Math.floor(t / per), age = t - kk * per - hrand(kk, f.name) * (per - 2);
        if (age > 0 && age < 1.4) this.sparks(f.pos, f.fwd, age, hash32(kk, f.name));
        // the tube flickers with its own sparks
        if (/01/.test(f.name) && age > 0 && age < 0.25) this.set('RW_flicker', 1.6);
      } else if (kind === 'steam') {
        const per = 13, kk = Math.floor(t / per), age = t - kk * per;
        // thin wisps: many small, faint puffs that spread and drift (a few big dense ones read as a grey ball)
        if (age < 4.5) for (let i = 0; i < 14; i++) {
          const a = age - i * 0.12; if (a < 0 || a > 2.4) continue;
          const j = hrand(kk * 31 + i, 'st') - 0.5, j2 = hrand(kk * 17 + i, 'st2') - 0.5;
          const p = f.pos.clone().addScaledVector(f.fwd, a * 0.9).add(V(j * a * 0.5, a * 0.45, j2 * a * 0.5));
          this.fx.puff(p, 0.05 + a * 0.13, 0.78, 0.8, 0.84, 0.11 * (1 - a / 2.4) * (age < 3.5 ? 1 : 1 - (age - 3.5)), (kk * 7 + i) / 11);
        }
      } else {
        for (const c of this.confetti) { const age = t - c.at; if (age >= 0 && age < 6) this.confettiBurst(f.pos, f.fwd, age, c.seed); }
      }
    }
    this.fx.end();
  }

  private sparks(p: V3, d: V3, age: number, seed: number) {
    const r = new Rng(seed);
    if (age < 0.12) this.fx.sprite(p, 0.18, 1.6, 1.3, 0.8, 1 - age / 0.12, SPRITE.flare, r.next());
    for (let i = 0; i < 26; i++) {
      const v = d.clone().multiplyScalar(r.range(0.6, 2.2)).add(V(r.range(-1.2, 1.2), r.range(-0.2, 1.4), r.range(-1.2, 1.2)));
      const t0 = r.range(0, 0.3), a = age - t0;
      if (a < 0 || a > 1.0) continue;
      const pos = p.clone().addScaledVector(v, a).add(V(0, -4.9 * a * a, 0));
      const pv = v.clone().add(V(0, -9.8 * a, 0)).normalize();
      this.fx.line(pos.clone().addScaledVector(pv, -0.05), pos, 0.004, 1.2, 1.5, 0.9, 0.4, 1 - a, false);
    }
  }
  private confettiBurst(p: V3, d: V3, age: number, seed: number) {
    const r = new Rng(seed);
    const cols = [[1.5, 0.3, 1.2], [0.4, 1.5, 0.3], [0.3, 1.2, 1.5], [1.5, 1.3, 0.2], [1.5, 0.5, 0.2]];
    if (age < 0.2) this.fx.sprite(p, 0.4, 1.5, 1.3, 1.0, 1 - age / 0.2, SPRITE.flare, 0.2);
    for (let i = 0; i < 140; i++) {
      const v = d.clone().multiplyScalar(r.range(1.5, 4.5)).add(V(r.range(-1.8, 1.8), r.range(1.0, 4.5), r.range(-1.8, 1.8)));
      const a = age - r.range(0, 0.6);
      if (a < 0) continue;
      const drag = 1.6;
      const pos = p.clone().addScaledVector(v, (1 - Math.exp(-a * drag)) / drag).add(V(Math.sin(a * 5 + i) * 0.1, -1.2 * a, Math.cos(a * 4 + i) * 0.1));
      if (pos.y < 0.02) pos.y = 0.02;
      const c = cols[i % cols.length];
      this.fx.sprite(pos, 0.035, c[0], c[1], c[2], clamp01(1.3 - a / 5), SPRITE.spark, (i * 0.37 + a * 2) % 1);
    }
  }

  // ------------------------------------------------------------------------------------------ the RACE BOARD
  drawBoard(t: number, dt: number, d: BoardData) {
    const S = this.board;
    if (!S) return;
    this.boardT -= dt;
    const key = JSON.stringify(d) + (Math.floor(t * 2) % 2);
    if (this.boardT > 0 || key === this.boardKey) return;
    this.boardT = 0.25; this.boardKey = key;
    const g = S.g, W = 1280, H = 720;
    g.fillStyle = '#07090c'; g.fillRect(0, 0, W, H);
    // header
    g.fillStyle = '#e8402a'; g.fillRect(0, 0, W, 92);
    g.fillStyle = '#0a0a0a'; g.font = `700 64px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText('RUST RINGS', 28, 48);
    g.font = `700 40px ${FONT}`; g.textAlign = 'right';
    g.fillText(`HEAT ${d.heat}  //  LAP ${d.lap}`, W - 110, 48);
    if (d.live && Math.floor(t * 2) % 2 === 0) { g.fillStyle = '#ffffff'; g.beginPath(); g.arc(W - 70, 48, 14, 0, 6.283); g.fill(); }
    g.fillStyle = '#0a0a0a'; g.font = `700 22px ${FONT}`; g.fillText('LIVE', W - 20, 48);
    // column heads
    g.fillStyle = '#6a7480'; g.font = `600 26px ${FONT}`; g.textAlign = 'left';
    const cols = [30, 110, 560, 760, 990, 1180];
    ['POS', 'PILOT', 'GAP', 'LAST LAP', 'ODDS'].forEach((h, i) => g.fillText(h, cols[i], 122));
    g.fillStyle = '#20262c'; g.fillRect(20, 140, W - 40, 3);
    const rowH = 58;
    d.rows.slice(0, 8).forEach((r, i) => {
      const y = 175 + i * rowH;
      if (i % 2 === 0) { g.fillStyle = '#0d1116'; g.fillRect(20, y - rowH / 2 + 2, W - 40, rowH - 4); }
      g.textAlign = 'left';
      g.fillStyle = i === 0 ? '#f2c230' : '#e8e8e8'; g.font = `700 40px ${FONT}`;
      g.fillText(String(r.pos), cols[0], y);
      g.fillStyle = r.c1; g.fillRect(cols[1], y - 18, 14, 36);
      g.fillStyle = r.state === 'dnf' ? '#ff4a3a' : '#f2f2f2'; g.font = `700 38px ${FONT}`;
      g.fillText(r.pilot, cols[1] + 28, y);
      g.font = `600 34px ${MONO}`;
      if (r.state === 'dnf') { g.fillStyle = '#ff4a3a'; g.fillText('DNF - FOUND A ROCK', cols[2], y); }
      else if (r.state === 'rejoin') { g.fillStyle = '#3ae6ff'; g.fillText('REJOINING', cols[2], y); }
      else { g.fillStyle = '#9ad8ff'; g.fillText(r.gap, cols[2], y); g.fillStyle = '#c8ccd0'; g.fillText(r.last, cols[3], y); }
      g.fillStyle = '#ffae2e'; g.font = `700 34px ${FONT}`; g.textAlign = 'right'; g.fillText(r.odds, W - 34, y);
    });
    // footer ticker
    g.fillStyle = '#12161b'; g.fillRect(0, H - 70, W, 70);
    g.fillStyle = '#ffae2e'; g.font = `700 34px ${FONT}`; g.textAlign = 'left';
    const tw = g.measureText(d.ticker).width + 120;
    const off = (t * 110) % tw;
    for (let x = -off; x < W; x += tw) g.fillText(d.ticker, x + 20, H - 35);
    // banner overlay
    if (d.banner) {
      const col = d.banner.tone === 'gold' ? '#f2c230' : d.banner.tone === 'red' ? '#ff3a2a' : '#3ae6ff';
      const pulse = 0.85 + 0.15 * Math.sin(t * 8);
      g.fillStyle = 'rgba(0,0,0,0.78)'; g.fillRect(0, 210, W, 300);
      g.fillStyle = col; g.globalAlpha = pulse; g.fillRect(0, 210, W, 10); g.fillRect(0, 500, W, 10); g.globalAlpha = 1;
      g.textAlign = 'center'; g.fillStyle = col; g.font = `700 104px ${FONT}`;
      fitText(g, d.banner.title, W / 2, 320, W - 80, 104);
      g.fillStyle = '#ffffff'; g.font = `700 58px ${FONT}`;
      fitText(g, d.banner.sub, W / 2, 430, W - 80, 58);
    }
    // LED grain
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1);
    S.tex.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------ the PA ticker
  drawTicker(t: number, dt: number, text: string, tone: 'alert' | 'info' | 'cheer') {
    const S = this.ticker;
    if (!S) return;
    this.tickT -= dt;
    if (this.tickT > 0) return;
    this.tickT = 1 / 24;
    const g = S.g, W = 2048, H = 128;
    g.fillStyle = '#050403'; g.fillRect(0, 0, W, H);
    const col = tone === 'alert' ? (Math.floor(t * 2.5) % 2 ? '#ff3a1a' : '#ff8a5a') : tone === 'cheer' ? '#7aff5a' : '#ffae2e';
    g.fillStyle = col; g.font = `700 88px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = 'left';
    const msg = `${text}     ///     `;
    const tw = g.measureText(msg).width;
    const off = (t * 260) % tw;
    for (let x = -off; x < W; x += tw) g.fillText(msg, x, H / 2 + 4);
    // LED dot mask
    g.fillStyle = 'rgba(0,0,0,0.55)';
    for (let x = 0; x < W; x += 8) g.fillRect(x, 0, 2, H);
    for (let y = 0; y < H; y += 8) g.fillRect(0, y, W, 2);
    S.tex.needsUpdate = true;
  }
}

function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, size: number) {
  let s = size;
  const f = g.font;
  while (s > 20 && g.measureText(text).width > maxW) { s -= 4; g.font = f.replace(/\d+px/, `${s}px`); }
  g.fillText(text, x, y);
}
