// The club's drop burst for the DJ's analysed track (sparks + CO2 + confetti on the drop's exact downbeat): planned ONCE
// per drop (no per-frame allocation) and gated like every other spawned flash: with Safe flashes on, each spark fountain
// and CO2 jet goes through SpotFlashGate (one flash per ~2 m spot per 360 ms, shared/flashGovernor.ts) at the drop's
// time. (Confetti doesn't light anything: not gated.)
import * as THREE from 'three';
import { pageGovernor, SpotFlashGate } from '../../../shared/flashGovernor.ts';

export interface DropBurst {
  /** the drop's time (epoch ms) */
  at: number;
  seed: number;
  spark: THREE.Vector3[];
  co2: THREE.Vector3[];
  conf: { at: THREE.Vector3; dir: THREE.Vector3 }[];
  /** spark / CO2 emitters the flash limit held back */
  held: number;
}
/** The emitters' positions (room-local) + each confetti cannon's aim. */
export interface DropEmitters { spark: THREE.Vector3[]; co2: THREE.Vector3[]; conf: { at: THREE.Vector3; aimZ: number }[] }

export function planDropBurst(at: number, seed: number, em: DropEmitters, gate: SpotFlashGate, safe = pageGovernor().safe): DropBurst {
  let held = 0;
  const pass = (p: THREE.Vector3) => { const ok = gate.allow(p.x, p.y, p.z, at, safe); if (!ok) held++; return ok; };
  return {
    at, seed,
    spark: em.spark.filter(pass).map((p) => p.clone()),
    co2: em.co2.filter(pass).map((p) => p.clone()),
    conf: em.conf.map((c) => ({ at: c.at.clone(), dir: new THREE.Vector3(-c.at.x * 0.08, 0.55, c.aimZ - c.at.z).normalize() })),
    held,
  };
}
