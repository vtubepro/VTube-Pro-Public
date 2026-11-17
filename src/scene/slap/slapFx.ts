// The "Slap!" gag's cartoon effects (slapScene.ts): the comic SLAP! card, the impact burst (the "impact frame"), stars
// flying off the cheek, the dazed ring of stars over the knocked-out performer, dust / smoke puffs (run-in, skid,
// landing, poof), and the punch / thud sounds.
//
// Everything is SAMPLED from the choreography clock (no per-frame state): a page that loads mid-gag, or two OBS pages
// side by side, draw the same thing at the same moment. The whole group hangs under the target's mount, so it shows
// in their cam tile (stage layouts isolate a tile to its performer's mount) and inside the interview's remote studio.
import { relayShowSound } from '../../audio/showSoundRelay.ts';
import type { SlapKind } from '../../../shared/showSound.ts';
import * as THREE from 'three';
import { SLAP_T, slapRand } from '../../../shared/slap.ts';

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutBack = (k: number) => { const c1 = 2.2, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };

// ---------------------------------------------------------------- textures (drawn once per page)
let texCache: { card: THREE.Texture; star: THREE.Texture; puff: THREE.Texture; burst: THREE.Texture } | null = null;
function textures() {
  if (texCache) return texCache;
  const mk = (w: number, h: number, draw: (x: CanvasRenderingContext2D) => void) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d')!);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  // the comic card: a jagged burst (yellow, red core, warm-dark ink), "SLAP!" in heavy white letters
  const card = mk(640, 400, (x) => {
    const cx = 320, cy = 200, n = 18;
    const burst = (rOut: number, rIn: number, sx: number, sy: number) => {
      x.beginPath();
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? rIn : rOut * (0.86 + 0.14 * ((i * 7) % 5) / 4);
        x.lineTo(cx + Math.cos(a) * r * sx, cy + Math.sin(a) * r * sy);
      }
      x.closePath();
    };
    x.lineJoin = 'round';
    burst(190, 128, 1.55, 0.98); x.fillStyle = '#2a1408'; x.fill();
    burst(176, 118, 1.5, 0.93); x.fillStyle = '#ffd21f'; x.fill();
    burst(120, 88, 1.45, 0.88); x.fillStyle = '#ff4b2b'; x.fill();
    x.font = '900 132px Impact, "Arial Black", "Segoe UI Black", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.save(); x.translate(cx, cy + 6); x.rotate(-0.06);
    x.lineWidth = 22; x.strokeStyle = '#2a1408'; x.strokeText('SLAP!', 0, 0);
    x.fillStyle = '#fffaf0'; x.fillText('SLAP!', 0, 0);
    x.lineWidth = 3; x.strokeStyle = 'rgba(255,210,31,0.9)'; x.strokeText('SLAP!', 0, 0);
    x.restore();
  });
  const star = mk(128, 128, (x) => {
    x.beginPath();
    for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 24 : 58; x.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); }
    x.closePath(); x.lineJoin = 'round';
    x.lineWidth = 9; x.strokeStyle = '#3a2208'; x.stroke();
    x.fillStyle = '#ffe14d'; x.fill();
    x.fillStyle = 'rgba(255,255,255,0.7)'; x.beginPath(); x.arc(52, 50, 9, 0, Math.PI * 2); x.fill();
  });
  const puff = mk(128, 128, (x) => {
    const g = x.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.55, 'rgba(236,232,224,0.7)'); g.addColorStop(1, 'rgba(220,214,204,0)');
    x.fillStyle = g;
    for (const [px, py, r] of [[64, 70, 50], [40, 60, 30], [88, 58, 32], [62, 42, 30]] as const) { x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2); x.fill(); }
  });
  // impact frame: radial speed lines around a hot centre
  const burst = mk(256, 256, (x) => {
    x.translate(128, 128);
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2 + ((i * 13) % 7) * 0.02, r0 = 34 + ((i * 5) % 4) * 6, r1 = 118 - ((i * 3) % 5) * 7;
      x.strokeStyle = i % 2 ? 'rgba(255,255,255,0.95)' : 'rgba(255,214,60,0.95)';
      x.lineWidth = 3 + (i % 3) * 2.5; x.lineCap = 'round';
      x.beginPath(); x.moveTo(Math.cos(a) * r0, Math.sin(a) * r0); x.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); x.stroke();
    }
    const g = x.createRadialGradient(0, 0, 0, 0, 0, 22); g.addColorStop(0, 'rgba(255,255,255,0.75)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, 22, 0, Math.PI * 2); x.fill();
  });
  texCache = { card, star, puff, burst };
  return texCache;
}

const sprite = (map: THREE.Texture, order: number) => {
  const m = new THREE.SpriteMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false });
  const s = new THREE.Sprite(m);
  s.renderOrder = order;
  s.frustumCulled = false;
  s.visible = false;
  return s;
};

/** Where things go this gag (target-mount space, metres) — fixed when the gag is planned. */
export interface FxSpec {
  /** The cheek (impact point). */
  impact: THREE.Vector3;
  /** Card centre, width; `side` = which side the minion came from (the card leans that way). */
  card: THREE.Vector3;
  cardW: number;
  side: 1 | -1;
  /** Face size (m) — stars scale with it. */
  face: number;
  /** Puffs: time (choreography s), place, size (m). */
  puffs: { t: number; at: THREE.Vector3; size: number }[];
  /** The dazed ring: centre (over the head while down, target-mount space, sampled live) + window. */
  ringFrom: number;
  ringTo: number;
  seed: number;
  /** Close framing (cam tiles / the interview monitor): smaller card + stars. */
  close: boolean;
}

export class SlapFx {
  readonly root = new THREE.Group();
  private card: THREE.Sprite;
  private burst: THREE.Sprite;
  private stars: THREE.Sprite[] = [];
  private ring: THREE.Sprite[] = [];
  private puffs: THREE.Sprite[] = [];
  /** The ring's centre (set by the scene each frame: over the knocked-out head). */
  readonly ringAt = new THREE.Vector3();
  cardHidden = false;

  constructor() {
    const t = textures();
    this.root.name = 'vtp:slap:fx';
    this.card = sprite(t.card, 1003);
    this.burst = sprite(t.burst, 1002);
    for (let i = 0; i < 8; i++) this.stars.push(sprite(t.star, 1001));
    for (let i = 0; i < 5; i++) this.ring.push(sprite(t.star, 1001));
    for (let i = 0; i < 12; i++) { const p = sprite(t.puff, 999); (p.material as THREE.SpriteMaterial).depthTest = true; this.puffs.push(p); }
    this.root.add(this.card, this.burst, ...this.stars, ...this.ring, ...this.puffs);
  }

  /** Draw the effects at choreography time `tau` (hit-stop folded in) — stateless. */
  sample(tau: number, s: FxSpec) {
    const I = SLAP_T.impact, ti = tau - I;
    // ---- impact frame: burst lines for ~0.12 s (the hit-stop), a quick flash of the card
    const bOn = ti >= 0 && ti < 0.16;
    this.burst.visible = bOn;
    if (bOn) {
      const k = clamp01(ti / 0.16);
      const w = s.face * (s.close ? 2.2 : 2.7) * (0.6 + 0.5 * k);
      this.burst.position.copy(s.impact);
      this.burst.scale.set(w, w, 1);
      (this.burst.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - k * k);
      (this.burst.material as THREE.SpriteMaterial).rotation = slapRand(s.seed, 3) * Math.PI;
    }
    // ---- the SLAP! card: pops in with an overshoot, holds, pops out
    const cOn = ti >= 0.02 && ti < 1.05 && !this.cardHidden;
    this.card.visible = cOn;
    if (cOn) {
      const k = ti - 0.02;
      const pop = k < 0.14 ? easeOutBack(clamp01(k / 0.14)) : k > 0.88 ? 1 - clamp01((k - 0.88) / 0.15) : 1 + 0.03 * Math.sin(k * 26) * Math.exp(-k * 5);
      const w = s.cardW * Math.max(0.001, pop);
      this.card.position.copy(s.card).add(new THREE.Vector3(0, 0.04 * s.face * Math.min(1, k * 4), 0));
      this.card.scale.set(w, w * (400 / 640), 1);
      const m = this.card.material as THREE.SpriteMaterial;
      m.rotation = (s.side * 0.12) + (slapRand(s.seed, 4) - 0.5) * 0.1;
      m.opacity = 1;
      // (first frames flash white-hot: the impact)
      m.color.setScalar(k < 0.05 ? 1.6 : 1);
    }
    // ---- stars flying off the cheek (away from the slap)
    for (let i = 0; i < this.stars.length; i++) {
      const sp = this.stars[i], k = (ti - 0.01) / 0.62;
      sp.visible = k >= 0 && k < 1;
      if (!sp.visible) continue;
      const a = (i / this.stars.length) * Math.PI * 2 + slapRand(s.seed, 10 + i) * 0.6;
      const r = s.face * (s.close ? 1.5 : 2.2) * (0.35 + 0.65 * Math.sqrt(k)) * (0.75 + 0.5 * slapRand(s.seed, 30 + i));
      const dir = new THREE.Vector3(Math.cos(a) * 0.6 - s.side * 0.8, Math.sin(a), 0.35 * Math.cos(a * 2)).normalize();
      sp.position.copy(s.impact).addScaledVector(dir, r).add(new THREE.Vector3(0, -0.4 * s.face * k * k, 0));
      const sz = s.face * (s.close ? 0.3 : 0.38) * (1 - 0.6 * k) * (0.7 + 0.6 * slapRand(s.seed, 50 + i));
      sp.scale.set(sz, sz, 1);
      (sp.material as THREE.SpriteMaterial).opacity = 1 - k * k;
      (sp.material as THREE.SpriteMaterial).rotation = k * 6 * (i % 2 ? 1 : -1);
    }
    // ---- dazed ring over the head
    const rk = (tau - I - s.ringFrom) / Math.max(0.1, s.ringTo - s.ringFrom);
    for (let i = 0; i < this.ring.length; i++) {
      const sp = this.ring[i];
      sp.visible = rk >= 0 && rk < 1;
      if (!sp.visible) continue;
      const fade = Math.min(1, rk * 6, (1 - rk) * 5);
      const a = (i / this.ring.length) * Math.PI * 2 + (tau - I) * 5.5;
      const R = s.face * 0.75;
      sp.position.copy(this.ringAt).add(new THREE.Vector3(Math.cos(a) * R, 0.12 * s.face * Math.sin(a * 2 + 1), Math.sin(a) * R * 0.55));
      const sz = s.face * 0.3 * fade;
      sp.scale.set(sz, sz, 1);
      (sp.material as THREE.SpriteMaterial).opacity = fade;
      (sp.material as THREE.SpriteMaterial).rotation = a;
    }
    // ---- puffs (dust / smoke): grow, rise a little, fade
    for (let i = 0; i < this.puffs.length; i++) {
      const sp = this.puffs[i], p = s.puffs[i];
      const k = p ? (tau - p.t) / 0.55 : -1;
      sp.visible = !!p && k >= 0 && k < 1;
      if (!sp.visible || !p) continue;
      const sz = p.size * (0.45 + 0.9 * Math.sqrt(k));
      sp.position.copy(p.at).add(new THREE.Vector3(0, p.size * 0.35 * k, 0));
      sp.scale.set(sz, sz, 1);
      (sp.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - k) * Math.min(1, k * 8);
      (sp.material as THREE.SpriteMaterial).rotation = slapRand(s.seed, 70 + i) * 6 + k;
    }
  }

  /** Screen rect (fractions, top-left origin) of the card at its full size for a camera — the OBS-hole check. */
  cardRect(s: FxSpec, parent: THREE.Object3D, cam: THREE.Camera): { x: number; y: number; w: number; h: number } | null {
    parent.updateWorldMatrix(true, false);
    const c = parent.localToWorld(s.card.clone());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const hw = s.cardW * 0.55, hh = s.cardW * 0.36;
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => c.clone().addScaledVector(right, a * hw).addScaledVector(up, b * hh).project(cam));
    if (pts.some((p) => p.z > 1)) return null;
    const xs = pts.map((p) => (p.x + 1) / 2), ys = pts.map((p) => (1 - p.y) / 2);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  hide() { for (const c of this.root.children) c.visible = false; }
  dispose() {
    this.root.removeFromParent();
    for (const c of this.root.children) ((c as THREE.Sprite).material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------- sounds: played by the STUDIO (src/audio/mixer/showSounds.ts,
// CC0 Kenney impact pack); an OBS page only reports them (output pages are silent: src/audio/silentPage.ts)
export class SlapSound {
  volume = 0.7;
  /** (the studio loads the sounds itself) */
  preload() { /* nothing to warm up on an OBS page */ }
  /** One punch / landing / poof of gag `seed`; `key` tells two of the same kind apart (the poof in and out). */
  play(kind: SlapKind, seed: number, gain = 1, rate = 1, key = '') {
    if (this.volume <= 0) return;
    relayShowSound(`slap:${kind}:${seed}${key ? `:${key}` : ''}`, { k: 'slap', kind, seed, gain: (gain * this.volume) / 0.7, rate });
  }
}
