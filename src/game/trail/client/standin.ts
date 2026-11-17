// The Trail — what a performer looks like when their own model isn't (yet) here: a friendly labelled mannequin in their
// colour (instant, while loading / waiting), and the library stand-in avatar (a shipped builtin, for bots and for
// performers whose avatar can't be had). Also the load helpers (timeout, retry schedule). Never a bare grey capsule.
import * as THREE from 'three';
import type { AvatarProfile } from '../../../../shared/types.ts';
import { outline, toon, unitCapsule, unitSphere } from './kit.ts';

/** A model load that takes longer than this is treated as failed (and retried); a late result is disposed. */
export const LOAD_TIMEOUT_MS = 45000;
/** Retry back-off (s) after failed loads; the last value repeats. */
export const RETRY_S = [2, 5, 10, 20, 30];

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

let list: Promise<AvatarProfile[]> | null = null;
/** Shipped avatars first in this order when present (light, humanoid); else any builtin biped; else any biped. */
const PREFER = ['robot'];
/** A library stand-in avatar id for a player (deterministic per player; bots get different ones). null = none. */
export async function standInAvatarId(playerId: string): Promise<string | null> {
  list ??= fetch('/api/avatars').then((r) => (r.ok ? r.json() as Promise<AvatarProfile[]> : [])).catch(() => []);
  const all = (await list).filter((p) => p && p.id && p.modelFile && (p as { body?: string }).body !== 'quadruped' && p.id !== 'tv_performer');
  if (!all.length) { list = null; return null; }
  const built = all.filter((p) => (p as { source?: string }).source === 'builtin');
  const pool = built.length ? built : all;
  const pref = PREFER.map((id) => pool.find((p) => p.id === id)).filter((p): p is AvatarProfile => !!p);
  const pick = (pref.length ? pref : pool).slice(0, 3);
  let h = 0; for (let i = 0; i < playerId.length; i++) h = (h * 31 + playerId.charCodeAt(i)) | 0;
  return pick[Math.abs(h) % pick.length].id;
}

/** The mannequin: a toon capsule body + head with eyes, in the player's colour; bobs along while it walks. */
export class StandIn {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private arms: THREE.Mesh[] = [];
  private t = 0;
  private wave = 0;
  constructor(color: string) {
    const c = new THREE.Color(color);
    const skin = toon(`#${c.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString()}`);
    const cloth = toon(color);
    const dark = toon('#1c140f');
    const torso = new THREE.Mesh(unitCapsule(), cloth); torso.scale.set(0.16, 0.105, 0.13); torso.position.y = 0.37;
    const head = new THREE.Mesh(unitSphere(20), skin); head.scale.setScalar(0.125); head.position.y = 0.86;
    const eyes = [-1, 1].map((s) => { const e = new THREE.Mesh(unitSphere(10), dark); e.scale.set(0.018, 0.026, 0.012); e.position.set(0.045 * s, 0.875, 0.112); return e; });
    this.arms = [-1, 1].map((s) => { const a = new THREE.Mesh(unitCapsule(), cloth); a.scale.set(0.045, 0.06, 0.045); a.position.set(0.2 * s, 0.5, 0); return a; });
    const legs = [-1, 1].map((s) => { const l = new THREE.Mesh(unitCapsule(), cloth); l.scale.set(0.055, 0.06, 0.055); l.position.set(0.075 * s, 0.1, 0); return l; });
    this.body.add(torso, head, ...eyes, ...this.arms, ...legs);
    outline(this.body, 0.004);
    this.body.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
    this.root.add(this.body);
    this.root.visible = false;
  }
  show(on: boolean) { this.root.visible = on; }
  setHeight(h: number) { this.root.scale.setScalar(h); }
  emote(id: string) { if (id === 'wave' || id === 'cheer' || id === 'point') this.wave = 2; }
  /** gaitRate = strides per second-ish (speed / height). */
  update(dt: number, gaitRate: number, seated: boolean, rag: boolean, holding: boolean) {
    if (!this.root.visible) return;
    this.t += dt * (2 + gaitRate * 5);
    const g = Math.min(1, gaitRate * 2);
    this.body.position.y = seated ? -0.18 : Math.abs(Math.sin(this.t)) * 0.04 * g;
    this.body.rotation.z = rag ? Math.sin(this.t * 3) * 0.5 : Math.sin(this.t) * 0.08 * g;
    this.wave = Math.max(0, this.wave - dt);
    this.arms.forEach((a, i) => {
      const s = i ? 1 : -1;
      a.rotation.x = holding ? -1.3 : Math.sin(this.t + i * Math.PI) * 0.5 * g;
      a.rotation.z = this.wave > 0 && i === 0 ? -2.6 + Math.sin(this.wave * 14) * 0.3 : s * 0.12;
    });
  }
  dispose() { this.root.removeFromParent(); }
}
