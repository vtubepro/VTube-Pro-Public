// Darkness-reactive lights: lanterns, street lamps, braziers, windows … that switch on as it gets dark (dusk, storms)
// and off at dawn — each fixture at its own staggered threshold, fading in over ~1 s, optional fire flicker, a power dip
// after a close lightning strike. Rooms mark them per group (scene.json environment.nightLights / windows), per fixture
// (LIGHT_* extras nightOn / nightThreshold / flicker) or per material (EMIT_* extras nightOn).
//
// How: every night-light EMIT_ material on the room's meshes (the light show's per-fixture clones included) gets the
// environment patch with its own glow uniform (emission × level — the light show keeps writing its own colours and
// intensities underneath, nothing fights). The show's real THREE lights of those fixtures are scaled after the show has
// written them. Lit fixtures also feed the "light pools" of the room patch (nearest to the camera first).
import * as THREE from 'three';
import { govChannel, pageGovernor, type GovChannel } from '../../../shared/flashGovernor.ts';
import type { RoomEnvConfig } from '../../../shared/environment.ts';
import { hash01 } from '../../../shared/environment.ts';
import type { RoomInfo, LightFixture } from '../contract.ts';
import { patchEnvMaterial, type GridSpec, EU, MAX_POOLS } from './materials.ts';

export interface NightEntry {
  key: string;
  /** photosensitivity governor channel (flickering entries) */
  gch?: GovChannel;
  group: string;
  pos: THREE.Vector3;
  color: THREE.Color;
  glow: { value: number };
  mats: THREE.Material[];
  lights: THREE.Light[];
  lastI: Map<THREE.Light, number>;
  thr: number; flicker: number; fade: number; day: number;
  seed: number;
  /** Smoothed on-level 0..1 (the target is a pure function of the darkness). */
  level: number;
  pool: boolean; radius: number;
  poolW: number;
  /** Pool-only stand-in for another mesh sharing the owner's material (follows the owner's level). */
  follow?: NightEntry;
}

const groupOf = (name: string) => name.replace(/^EMIT_/, '').replace(/[._]\d+$/, '');
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const noise1 = (x: number, s: number) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash01(s, i, 41) * (1 - u) + hash01(s, i + 1, 41) * u; };
const NIGHTY = /lantern|lamp|street|window|brazier|torch|candle|campfire|fire_?pit|porch|neon_?sign|string_?light|fairy/i;

export class NightLights {
  readonly entries: NightEntry[] = [];
  readonly grids: { group: string; mats: THREE.Material[] }[] = [];
  private tmp = new THREE.Vector3();
  private poolAt = -1e9;
  private camAt = new THREE.Vector3(1e9, 0, 0);
  /** Lit / total (info). */
  lit = 0;

  /** Find + patch. `scene` = where the light show's real lights live (named vtp:<LIGHT_ node>). */
  build(room: RoomInfo, cfg: RoomEnvConfig, scene: THREE.Scene, skip: Set<THREE.Object3D>, seed: number) {
    const nl = cfg.nightLights ?? {};
    const win = cfg.windows ?? {};
    const fixByNode = new Map<THREE.Object3D, LightFixture>();
    for (const f of room.fixtures) fixByNode.set(f.node, f);
    const isNight = (group: string, fx: LightFixture | null, m: THREE.Material | null) =>
      group in nl || fx?.extras.nightOn === true || m?.userData?.nightOn === true || (cfg.nightLights === undefined && NIGHTY.test(group) && !(group in win));
    const entries = new Map<string, NightEntry>();
    const matOwner = new Map<THREE.Material, NightEntry>();
    const gridMats = new Map<string, THREE.Material[]>();
    const make = (key: string, group: string, pos: THREE.Vector3, color: THREE.Color, fx: LightFixture | null, m: THREE.Material | null): NightEntry => {
      const g = nl[group] ?? {};
      const ex = { ...(m?.userData ?? {}), ...(fx?.extras ?? {}) } as Record<string, unknown>;
      const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      const sd = hash01(seed, hashStr(key), 5);
      const stagger = num(ex.nightStagger, g.stagger ?? 0.09);
      return {
        key, group, pos, color, glow: { value: 1 }, mats: [], lights: [], lastI: new Map(),
        thr: Math.min(0.97, Math.max(0.02, num(ex.nightThreshold, g.threshold ?? 0.5) + (sd - 0.5) * 2 * stagger)),
        flicker: Math.min(1, Math.max(0, num(ex.flicker, g.flicker ?? (/fire|brazier|torch|candle|lantern/i.test(group) ? 0.25 : 0)))),
        fade: Math.max(0.05, num(ex.nightFade, g.fade ?? 1.1)), day: Math.min(1, Math.max(0, num(ex.nightDay, g.day ?? 0))),
        seed: Math.floor(sd * 1e6), level: -1, pool: fx ? (g.pools ?? (fx.kind !== 'emissive' || /lantern|lamp|street|brazier|torch|fire/i.test(group))) : (g.pools ?? /lantern|lamp|street|brazier|torch|fire|candle/i.test(group)),
        radius: num(ex.poolRadius, g.radius ?? (fx?.kind === 'spot' ? 7 : 5.5)), poolW: 0,
      };
    };
    room.root.updateMatrixWorld(true);
    room.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (skip.has(p)) return;
      let fx: LightFixture | null = null;
      for (let p: THREE.Object3D | null = o; p && !fx; p = p.parent) fx = fixByNode.get(p) ?? null;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!/^EMIT_/.test(m.name) || !(m as THREE.MeshStandardMaterial).isMeshStandardMaterial) continue;
        const group = groupOf(m.name);
        if (group in win) {
          const list = gridMats.get(group) ?? [];
          if (!list.includes(m)) { list.push(m); gridMats.set(group, list); }
          continue;
        }
        const own = fx && fx.group === group ? fx : null;
        if (!isNight(group, own, m)) continue;
        const key = own ? own.name : `${mesh.name || mesh.uuid}:${group}`;
        let e = matOwner.get(m) ?? entries.get(key);
        if (!e) {
          const pos = own ? own.node.getWorldPosition(new THREE.Vector3()) : new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
          const col = own ? own.color.clone() : (m as THREE.MeshStandardMaterial).emissive.clone();
          e = make(key, group, pos, col, own, m);
          // big emissive meshes (a whole facade, a neon strip across the room) don't make pools
          if (!own && new THREE.Box3().setFromObject(mesh).getSize(this.tmp).length() > 3.5) e.pool = false;
          entries.set(key, e);
        }
        if (!matOwner.has(m)) {
          matOwner.set(m, e);
          if (patchEnvMaterial(m, { lit: true, glow: e.glow })) e.mats.push(m);
        } else if (!own && e.key !== key && !entries.has(key)) {
          // another small mesh sharing this material (e.g. 20 lanterns, one material): its own light pool, same level
          const bb = new THREE.Box3().setFromObject(mesh);
          if (bb.getSize(this.tmp).length() <= 3.5 && e.pool !== false) {
            const f = make(key, group, bb.getCenter(new THREE.Vector3()), e.color, null, m);
            f.follow = e; f.pool = true; f.radius = Math.min(f.radius, 2.2);
            entries.set(key, f);
          }
        }
      }
    });
    // the light show's real lights for these fixtures
    for (const e of entries.values()) {
      const l = scene.getObjectByName(`vtp:${e.key}`) as THREE.Light | undefined;
      if (l && (l as THREE.Light).isLight) e.lights.push(l);
    }
    // point / spot fixtures of night groups with no emissive mesh (bare empties): pools + real lights only
    for (const f of room.fixtures) {
      if (entries.has(f.name) || !isNight(f.group, f, null)) continue;
      if (f.kind === 'emissive') continue;
      const e = make(f.name, f.group, f.node.getWorldPosition(new THREE.Vector3()), f.color.clone(), f, null);
      const l = scene.getObjectByName(`vtp:${f.name}`) as THREE.Light | undefined;
      if (l && l.isLight) e.lights.push(l);
      entries.set(f.name, e);
    }
    this.entries.push(...entries.values());
    // window grids
    for (const [group, mats] of gridMats) {
      const spec = gridSpec(win[group] ?? {});
      const done: THREE.Material[] = [];
      for (const m of mats) if (patchEnvMaterial(m, { lit: true, grid: spec })) done.push(m);
      this.grids.push({ group, mats: done });
    }
  }

  /** Levels for this frame. `showK` = how much the light show owns the night groups (PRESHOW / OUTRO looks). */
  update(dt: number, dark: number, tSec: number, on: boolean, showK: number, dip: number) {
    let lit = 0;
    for (const e of this.entries) {
      if (e.follow) continue;
      const target = on ? Math.max(e.day, smooth(e.thr, e.thr + 0.035, dark)) : 1;
      if (e.level < 0) e.level = target;
      else e.level += (target - e.level) * (1 - Math.exp(-Math.max(0, dt) / (e.fade * 0.45)));
      let g = e.level;
      if (e.flicker > 0 && g > 0.01) g *= 1 - e.flicker * (0.5 * noise1(tSec * 7.3, e.seed) + 0.25 * noise1(tSec * 19.1, e.seed + 3));
      if (dip > 0 && on) g *= 1 - dip * (0.55 + 0.45 * noise1(tSec * 40, e.seed + 9));
      g = g + (1 - g) * showK;
      // photosensitivity: a flickering fire / lamp is an output on the page's governor (a 19 % flicker at ~3.6 a second
      // would count as flashing); a steady one passes unchanged
      if (e.flicker > 0 || dip > 0) g = pageGovernor(performance.timeOrigin + performance.now()).step(e.gch ??= govChannel(`night:${e.key}`), g);
      e.glow.value = g;
      if (e.level > 0.5) lit++;
    }
    this.lit = lit;
  }

  /** After the light show wrote its real lights this frame: scale the night fixtures' ones. A value that is still
   *  what we wrote last frame means nobody rewrote it (a steady placeholder engine) → keep using the remembered base. */
  scaleRealLights() {
    for (const e of this.entries) for (const l of e.lights) {
      const last = e.lastI.get(l);
      let base = l.intensity;
      if (last !== undefined && l.intensity === last.valueOf() && l.userData.vtpEnvBase !== undefined) base = l.userData.vtpEnvBase as number;
      l.userData.vtpEnvBase = base;
      const v = base * e.glow.value;
      l.intensity = v;
      e.lastI.set(l, v);
    }
  }
  restoreRealLights() {
    for (const e of this.entries) for (const l of e.lights) { if (l.userData.vtpEnvBase !== undefined) { l.intensity = l.userData.vtpEnvBase as number; delete l.userData.vtpEnvBase; } }
  }

  /** Nearest lit fixtures → the room patch's light pools (re-picked when the camera moves ≥ 0.5 m or every 2 s). */
  pools(cam: THREE.Vector3, max: number, dt: number, now: number, strength: number) {
    const cand = this.entries.filter((e) => e.pool);
    if (now - this.poolAt > 2000 || cam.distanceToSquared(this.camAt) > 0.25) {
      this.poolAt = now; this.camAt.copy(cam);
      // near + big first (a street lamp 12 m away beats a fairy light 4 m away)
      const order = cand.map((e) => ({ e, d: e.pos.distanceTo(cam) / Math.max(0.5, e.radius) })).filter((x) => x.d * x.e.radius < 60).sort((a, b) => a.d - b.d).slice(0, max);
      const want = new Set(order.map((x) => x.e));
      for (const e of cand) (e as NightEntry & { want?: boolean }).want = want.has(e);
    }
    let n = 0;
    const k = 1 - Math.exp(-Math.max(0, dt) / 0.35);
    const list = cand.sort((a, b) => b.poolW - a.poolW);
    for (const e of list) {
      e.poolW += (((e as NightEntry & { want?: boolean }).want ? 1 : 0) - e.poolW) * k;
      if (e.poolW < 0.01 || n >= Math.min(max, MAX_POOLS)) continue;
      const lv = (e.follow ?? e).glow.value * e.poolW * strength;
      if (lv < 0.005) continue;
      EU.uEnvPool.value[n].set(e.pos.x, e.pos.y, e.pos.z, e.radius);
      EU.uEnvPoolCol.value[n].set(e.color.r, e.color.g, e.color.b).multiplyScalar(0.85 * lv);
      n++;
    }
    EU.uEnvPoolN.value = n;
    return n;
  }
}

function hashStr(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

function gridSpec(w: NonNullable<RoomEnvConfig['windows']>[string]): GridSpec {
  const cols = (w.colors?.length ? w.colors : ['#ffcf8a', '#ffe2b0', '#ffc070', '#dfe8ff']).slice(0, 4).map((c) => { try { return new THREE.Color(c); } catch { return new THREE.Color('#ffd49a'); } });
  const pair = (v: unknown, d: [number, number]): [number, number] => (Array.isArray(v) && v.length >= 2 && v.every((x) => typeof x === 'number' && x > 0) ? [v[0], v[1]] : d);
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return {
    mode: w.mode === 'uv' ? 'uv' : 'world', cell: pair(w.cell, [1.8, 3.2]), grid: pair(w.grid, [8, 16]), frame: n(w.frame, 0.02, 0.45, 0.22),
    lit: n(w.lit, 0, 1, 0.72), late: n(w.late, 0, 1, 0.35), tv: n(w.tv, 0, 1, 0.08), threshold: n(w.threshold, 0.05, 0.95, 0.45), spread: n(w.spread, 0, 0.5, 0.22), colors: cols,
  };
}
