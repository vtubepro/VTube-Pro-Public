// Gesture effects: emoji/sprite bursts that pop out of the avatar's hand and float up.
// Cheap (a pool of sprites with canvas-drawn emoji textures) and identical in studio + OBS output.

import * as THREE from 'three';
import type { GestureKind } from '../tracking/gestures.ts';
import { markShared } from './gpuDispose.ts';

const BURSTS: Record<GestureKind, { glyphs: string[]; count: number; spread: number; rise: number }> = {
  thumbs_up: { glyphs: ['👍', '✨', '✨'], count: 5, spread: 0.6, rise: 1 },
  thumbs_down: { glyphs: ['👎', '💢'], count: 4, spread: 0.5, rise: 0.6 },
  peace: { glyphs: ['✌️', '✨', '⭐'], count: 6, spread: 0.7, rise: 1 },
  love: { glyphs: ['❤️', '💖', '💕'], count: 8, spread: 0.8, rise: 1.2 },
  fist: { glyphs: ['💥', '💪'], count: 4, spread: 0.9, rise: 0.4 },
  point: { glyphs: ['❗', '💡'], count: 3, spread: 0.3, rise: 1.4 },
  wave: { glyphs: ['👋', '✨'], count: 4, spread: 0.6, rise: 0.8 },
  palm: { glyphs: ['✋'], count: 1, spread: 0.2, rise: 0.5 },
};

const texCache = new Map<string, THREE.CanvasTexture>();
function glyphTexture(g: string) {
  let t = texCache.get(g);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.font = '100px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(g, 64, 70);
  t = markShared(new THREE.CanvasTexture(c));   // page-wide glyph cache: never freed with one avatar
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(g, t);
  return t;
}

interface P { s: THREE.Sprite; v: THREE.Vector3; age: number; life: number; size: number; spin: number }

export class GestureEffects {
  private parts: P[] = [];
  readonly group = new THREE.Group();
  private seen = 0;

  constructor(private scale: number) { this.group.name = 'vtp_fx'; }

  /** Spawn events we haven't shown yet (events carry increasing ids). */
  consume(events: { id: number; kind: string; side: string }[] | undefined, at: (side: string) => THREE.Vector3 | null) {
    if (!events) return;
    for (const e of events) {
      if (e.id <= this.seen) continue;
      this.seen = e.id;
      const p = at(e.side);
      if (p) this.burst(e.kind as GestureKind, p);
    }
  }

  burst(kind: GestureKind, pos: THREE.Vector3) {
    const b = BURSTS[kind];
    if (!b) return;
    const S = this.scale;
    for (let i = 0; i < b.count; i++) {
      const mat = new THREE.SpriteMaterial({ map: glyphTexture(b.glyphs[i % b.glyphs.length]), transparent: true, depthWrite: false, depthTest: false });
      const s = new THREE.Sprite(mat);
      s.renderOrder = 20;
      s.position.copy(pos);
      const a = (i / b.count) * Math.PI * 2 + Math.random() * 0.8;
      const v = new THREE.Vector3(Math.cos(a) * b.spread * 0.35, 0.55 * b.rise + Math.random() * 0.3, Math.sin(a) * 0.15 + 0.25).multiplyScalar(S);
      const size = (i === 0 ? 0.2 : 0.11 + Math.random() * 0.05) * S;
      this.group.add(s);
      this.parts.push({ s, v, age: 0, life: 1.1 + Math.random() * 0.5, size, spin: (Math.random() - 0.5) * 3 });
    }
  }

  update(dt: number) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) { p.s.removeFromParent(); p.s.material.dispose(); this.parts.splice(i, 1); continue; }
      p.v.multiplyScalar(Math.exp(-1.6 * dt));
      p.s.position.addScaledVector(p.v, dt);
      const pop = k < 0.15 ? THREE.MathUtils.smoothstep(k, 0, 0.15) * 1.25 : 1.25 - 0.25 * THREE.MathUtils.smoothstep(k, 0.15, 0.35);
      p.s.scale.setScalar(p.size * pop);
      p.s.material.rotation += p.spin * dt;
      p.s.material.opacity = 1 - THREE.MathUtils.smoothstep(k, 0.65, 1);
    }
  }

  dispose() { for (const p of this.parts) p.s.material.dispose(); this.group.removeFromParent(); this.parts = []; }
}

/** Short facial reactions per gesture (added on top of tracking for ~1.2 s). */
export const REACTIONS: Record<GestureKind, Record<string, number>> = {
  thumbs_up: { mouthSmileLeft: 0.8, mouthSmileRight: 0.8, cheekSquintLeft: 0.4, cheekSquintRight: 0.4 },
  thumbs_down: { mouthFrownLeft: 0.8, mouthFrownRight: 0.8, browDownLeft: 0.6, browDownRight: 0.6 },
  peace: { mouthSmileLeft: 0.9, mouthSmileRight: 0.6, eyeBlinkRight: 1 },
  love: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.8, cheekSquintRight: 0.8, eyeSquintLeft: 0.5, eyeSquintRight: 0.5 },
  fist: { browDownLeft: 0.7, browDownRight: 0.7, mouthPressLeft: 0.7, mouthPressRight: 0.7 },
  point: { browInnerUp: 0.8, browOuterUpLeft: 0.8, browOuterUpRight: 0.8, eyeWideLeft: 0.6, eyeWideRight: 0.6 },
  wave: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7 },
  palm: {},
};
