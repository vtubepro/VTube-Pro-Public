// Yacht life — effects inside the room: the champagne pop (the bottle shivers, POP: a flash, the cork arcs away, a foam
// fountain, gold sparkles, a confetti burst drifting down). Confetti = the crowd FX atlas (CrowdFx billboards, tinted
// gold / white / rose); flash, sparkles, foam and the cork = SpaceFx sprites / puffs / streaks at room scale. Every
// particle is a pure function of (event start, seed, time) — no state, the same on every page. Pieces that would pass
// in front of a performer's face are skipped.
import * as THREE from 'three';
import { CrowdFx } from '../crowd/crowdFx.ts';
import { SpaceFx, SPRITE } from '../space/fx.ts';
import { yachtRand, type YachtItem } from '../../../shared/yacht.ts';

/** The confetti atlas (4×4 cells) — borrowed from the Studio Swamp's crowd until the yacht room ships its own. */
const ATLAS_URL = new URL('../../../assets/scenes/yacht_life/crowd/crowd_fx.png', import.meta.url).href;

const CONFETTI = ['#ffc83a', '#fff4dc', '#f0a820', '#ff7aa8', '#ffffff', '#e89a30'].map((c) => new THREE.Color(c));
const G = 9.8;
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3(), vD = new THREE.Vector3();
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };

export const CHAMPAGNE_POP = 1.0;
export const CHAMPAGNE_DUR = 7.0;

export class YachtRoomFx {
  readonly group = new THREE.Group();
  crowd: CrowdFx | null = null;
  readonly fx: SpaceFx;
  ready = false;
  /** screen boxes to keep clear (0…1, y down) + the distance of what they protect */
  rects: { x0: number; y0: number; x1: number; y1: number; d: number }[] = [];

  constructor() {
    this.group.name = 'yacht:roomfx';
    this.fx = new SpaceFx({ sprites: 300, smoke: 80, streaks: 40 }, false);
    this.fx.uniforms.uMinPx.value = 0;
    this.group.add(this.fx.group);
  }

  async load(alive: () => boolean) {
    try {
      const tex = await new THREE.TextureLoader().loadAsync(ATLAS_URL);
      if (!alive()) { tex.dispose(); return; }
      this.crowd = new CrowdFx(tex);
      this.group.add(this.crowd.group);
      this.ready = true;
    } catch (e) { console.warn('[yacht] fx atlas failed', e); }
  }

  begin(t: number) { this.fx.begin(t); this.crowd?.begin(); }
  end(cam: THREE.PerspectiveCamera, H: number) {
    this.fx.uniforms.uPx.value = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / Math.max(1, H);
    this.fx.end(); this.crowd?.end();
  }

  private blocked(p: THREE.Vector3, cam: THREE.PerspectiveCamera) {
    const d = p.distanceTo(cam.position);
    if (d < 0.9) return true;                                  // never right in front of the lens
    if (!this.rects.length) return false;
    vD.copy(p).project(cam);
    const x = (vD.x + 1) / 2, y = (1 - vD.y) / 2;
    for (const r of this.rects) if (x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1 && d < r.d + 0.3) return true;
    return false;
  }

  /** at = where the bottle stands (base); away = horizontal unit vector the cork flies towards */
  champagne(it: YachtItem, t: number, at: THREE.Vector3, away: THREE.Vector3, bottle: THREE.Object3D | null, cam: THREE.PerspectiveCamera) {
    const u = t - it.start / 1000;
    if (u < 0 || u > CHAMPAGNE_DUR) return;
    const h = it.seed;
    const s = 1;
    // the bottle: pops up, shivers (the cork working loose), stands proud, fades
    if (bottle) {
      bottle.visible = true;
      const k = smooth(u / 0.25) * (1 - smooth((u - (CHAMPAGNE_DUR - 0.4)) / 0.4));
      bottle.scale.setScalar(Math.max(0.001, k * s));
      bottle.position.copy(at);
      const shake = u < CHAMPAGNE_POP ? Math.sin(u * 55) * 0.05 * smooth(u / CHAMPAGNE_POP) : Math.max(0, 0.18 - (u - CHAMPAGNE_POP) * 0.4) * Math.sin(u * 20);
      bottle.rotation.set(0, Math.atan2(away.x, away.z), shake);
    }
    const top = vA.copy(at); top.y += 0.34 * s;
    const up = u - CHAMPAGNE_POP;
    if (up < 0) {
      // a tiny wisp of glow at the neck as it's about to go
      this.fx.sprite(top, 0.03, 0.9 * smooth(u / CHAMPAGNE_POP), 0.8, 0.5, 0.6, SPRITE.glow);
      return;
    }
    // POP: flash + ring
    if (up < 0.18) { this.fx.sprite(top, 0.2, 2.2, 2.0, 1.6, 1 - up / 0.18, SPRITE.flare, 0.1); this.fx.sprite(top, 0.06 + up * 0.8, 1.4, 1.3, 1.1, 1 - up / 0.18, SPRITE.ring); }
    // the cork: a ballistic arc away from the host, a short streak behind it
    if (up < 1.1) {
      const vx = 1.1 + 0.4 * yachtRand(h, 1), vy = 3.4 + 0.5 * yachtRand(h, 2);
      const cp = vB.copy(top).addScaledVector(away, vx * up); cp.y += vy * up - 0.5 * G * up * up;
      const pp = vC.copy(top).addScaledVector(away, vx * Math.max(0, up - 0.05)); pp.y += vy * Math.max(0, up - 0.05) - 0.5 * G * Math.max(0, up - 0.05) ** 2;
      if (!this.blocked(cp, cam)) { this.fx.line(pp, cp, 0.004, 0, 1.2, 1.1, 0.9, 0.8 * (1 - up / 1.1)); this.fx.sprite(cp, 0.02, 1.4, 1.2, 0.9, 1, SPRITE.spark, up); }
    }
    // foam fountain (alpha puffs) + droplets
    for (let i = 0; i < 26; i++) {
      const t0 = (i / 26) * 0.7, tt = up - t0;
      if (tt < 0 || tt > 1.1) continue;
      const a = yachtRand(h, i, 3) * Math.PI * 2, c = 0.15 + 0.35 * yachtRand(h, i, 4);
      const sp = 1.2 + 1.1 * yachtRand(h, i, 5);
      const vx = Math.cos(a) * c * sp, vz = Math.sin(a) * c * sp, vy = sp * (1 - c * 0.5);
      const p = vB.set(top.x + vx * tt, top.y + vy * tt - 0.5 * G * tt * tt, top.z + vz * tt);
      if (p.y < at.y) continue;
      if (this.blocked(p, cam)) continue;
      const fade = 1 - tt / 1.1;
      this.fx.puff(p, 0.014 + 0.032 * tt, 0.98, 0.95, 0.86, 0.85 * fade, i * 0.13);
      if (i % 2 === 0) this.fx.sprite(p, 0.008, 1.3 * fade, 1.2 * fade, 0.9 * fade, 1, SPRITE.spark, i * 0.2);
    }
    // gold sparkles: a slow twinkling fountain for ~2.5 s
    for (let i = 0; i < 40; i++) {
      const t0 = (i / 40) * 1.6, tt = up - t0;
      if (tt < 0 || tt > 1.6) continue;
      const a = yachtRand(h, i, 6) * Math.PI * 2, c = 0.3 + 0.5 * yachtRand(h, i, 7);
      const sp = 1.6 + 1.2 * yachtRand(h, i, 8);
      const p = vB.set(top.x + Math.cos(a) * c * sp * tt, top.y + sp * tt - 0.5 * 4.5 * tt * tt, top.z + Math.sin(a) * c * sp * tt);
      if (this.blocked(p, cam)) continue;
      const tw = 0.4 + 0.6 * yachtRand(h, i, Math.floor(t * 24));
      const f = (1 - tt / 1.6) * tw;
      this.fx.sprite(p, 0.022, 2.0 * f, 1.5 * f, 0.6 * f, 1, SPRITE.spark, i * 0.37);
    }
    // confetti: a burst up and out, then a slow flutter down (drag: v → terminal, closed form)
    const C = this.crowd;
    if (C) {
      const tau = 0.32, vt = -0.55;
      for (let i = 0; i < 64; i++) {
        const tt = up - (i % 4) * 0.04;
        if (tt < 0 || tt > 4.2) continue;
        const a = yachtRand(h, i, 9) * Math.PI * 2, c = 0.25 + 0.6 * yachtRand(h, i, 10);
        const sp = 3.2 + 2.2 * yachtRand(h, i, 11);
        const v0x = Math.cos(a) * c * sp, v0z = Math.sin(a) * c * sp, v0y = sp * (1 - c * 0.45);
        const e = 1 - Math.exp(-tt / tau);
        const p = vB.set(top.x + v0x * tau * e, top.y + vt * tt + (v0y - vt) * tau * e, top.z + v0z * tau * e);
        p.x += Math.sin(tt * 5 + i) * 0.05 * smooth(tt); p.z += Math.cos(tt * 4 + i * 1.7) * 0.05 * smooth(tt);
        if (p.y < at.y - 0.9) continue;
        if (this.blocked(p, cam)) continue;
        const fade = 1 - smooth((tt - 3.2) / 1.0);
        C.bill('confetti', p, 0.06 * fade, cam, tt * (3 + (i % 5)) + i, CONFETTI[i % CONFETTI.length]);
      }
      if (up < 0.5) C.bill('spark', top, 0.18 + up * 0.5, cam, h % 7, CONFETTI[0]);
    }
  }

  dispose() {
    this.crowd?.dispose(); this.crowd = null;
    this.fx.dispose();
    this.group.removeFromParent();
    this.ready = false;
  }
}
