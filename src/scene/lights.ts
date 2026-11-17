// Room lighting — the hook the LIGHTS engineer implements (beat-reactive programs, strobes, "on air" …).
//
// The SceneRuntime creates one SceneLights per loaded room (via the factory below) and calls:
//   attach(ctx)      once: ctx.room.fixtures (LIGHT_* nodes: group / color / kind 'spot'|'point'|'emissive' +
//                    their EMIT_* materials), ctx.room.emissive (every EMIT_<group> material with its authored
//                    base colour + intensity), ctx.scene to add THREE lights to, ctx.tier for the budget.
//   setState(s)      whenever the host changes SceneState.lights ({ program, reactive, intensity }).
//   update(dt, t)    every rendered frame (t = seconds since the room loaded).
//   dispose()        room unloaded: remove your lights, restore materials.
//
// GPU budget (the face tracker shares the GPU while streaming): every real THREE light adds cost to every
// lit pixel, so keep ≤ LIGHT_BUDGET[tier] real lights and do the rest by modulating EMIT_* materials.
// The post pipeline (bloom) is OFF for performance — emissive "glow" has to come from colour/intensity.
import * as THREE from 'three';
import type { SceneLightsState } from '../../shared/types.ts';
import type { QualityTier } from '../tracking/Tracker.ts';
import type { RoomInfo } from './contract.ts';

export interface SceneLightsContext {
  room: RoomInfo;
  scene: THREE.Scene;
  tier: QualityTier;
  /** Optional (lighting-state effects): scene.json (lightRig anchors), the render camera, performers' faces (world). */
  info?: unknown;
  camera?: THREE.Camera;
  faces?: () => THREE.Vector3[];
  /** Optional: the performers in the room (their avatar object + face centre) — the show lights them. */
  actors?: () => { obj: THREE.Object3D; face: THREE.Vector3 | null }[];
  /** Optional: compile every shader in the scene now (pre-warm the effects rig so the first PRESHOW doesn't hitch). */
  warm?: () => void;
}

export interface SceneLights {
  attach(ctx: SceneLightsContext): void;
  setState(s: SceneLightsState): void;
  update(dt: number, t: number): void;
  dispose(): void;
}

export const LIGHT_BUDGET: Record<QualityTier, number> = { low: 0, medium: 2, high: 3, ultra: 4 };

/** Placeholder: fixtures light up steadily at their authored colour; only `intensity` is honoured. */
export class SteadyLights implements SceneLights {
  private lights: THREE.Light[] = [];
  private ctx: SceneLightsContext | null = null;
  private intensity = 1;

  attach(ctx: SceneLightsContext) {
    this.ctx = ctx;
    let budget = LIGHT_BUDGET[ctx.tier] ?? 2;
    // the budget goes to what lights the performers first: spot cans, then the strongest / widest points
    const weight = (f: (typeof ctx.room.fixtures)[number]) => (f.kind === 'spot' ? 1000 : 0) + (Number(f.extras.intensity) || 1) * (Number(f.extras.range) || 5);
    const real = ctx.room.fixtures.filter((f) => f.kind !== 'emissive').sort((a, b) => weight(b) - weight(a));
    for (const f of real) {
      if (budget <= 0) break;
      const p = f.node.getWorldPosition(new THREE.Vector3());
      const x = f.extras;
      const k = Number.isFinite(Number(x.intensity)) ? Math.max(0, Number(x.intensity)) : 1;   // authored relative strength
      const range = Number(x.range) > 0 ? Number(x.range) : f.kind === 'spot' ? 9 : 6;
      let l: THREE.Light;
      if (f.kind === 'spot') {
        // extras.angle = full cone in degrees (Blender spot size); three.js wants the half angle
        const cone = THREE.MathUtils.degToRad(Math.min(170, Number(x.angle) || 40)) / 2;
        const s = new THREE.SpotLight(f.color, 30 * k, range, cone, Number.isFinite(Number(x.penumbra)) ? Number(x.penumbra) : 0.5, 2);
        s.position.copy(p);
        // aim: extras.target [x, y, z] (glTF space), else along the node's -Z (the beam axis)
        const t = Array.isArray(x.target) && x.target.length >= 3
          ? ctx.room.root.localToWorld(new THREE.Vector3(...(x.target as number[]).slice(0, 3).map(Number)))
          : p.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(f.node.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(3));
        s.target.position.copy(t);
        ctx.scene.add(s.target);
        l = s;
      } else {
        const pl = new THREE.PointLight(f.color, 6 * k, range, 2);
        pl.position.copy(p);
        l = pl;
      }
      l.name = `vtp:${f.name}`;
      l.userData.base = l.intensity;
      ctx.scene.add(l);
      this.lights.push(l);
      budget--;
    }
    this.apply();
  }

  setState(s: SceneLightsState) { this.intensity = s.intensity; this.apply(); }

  private apply() {
    for (const l of this.lights) l.intensity = (l.userData.base as number) * this.intensity;
    for (const e of this.ctx?.room.emissive ?? []) e.material.emissiveIntensity = e.baseIntensity * this.intensity;
  }

  update() { /* steady */ }

  dispose() {
    for (const l of this.lights) { l.removeFromParent(); (l as THREE.SpotLight).target?.removeFromParent(); l.dispose(); }
    this.lights = [];
    for (const e of this.ctx?.room.emissive ?? []) { e.material.emissive.copy(e.baseColor); e.material.emissiveIntensity = e.baseIntensity; }
    this.ctx = null;
  }
}

let factory: () => SceneLights = () => new SteadyLights();
/** The lights engineer installs the real engine here (e.g. from src/scene/lightShow.ts). */
export function setLightsFactory(f: () => SceneLights) { factory = f; }
export function createLights(): SceneLights { return factory(); }
