// Generic LOD for room props and background characters: nodes named `<base>_LOD0`, `<base>_LOD1`, `<base>_LOD2` (siblings)
// form a group; one level is shown by its projected size on screen (the LOD0 bounding sphere's diameter in pixels)
// with hysteresis (±15 %), checked a few times a second. A lone `<base>_LOD0` with no LOD1 sibling is optional detail
// (e.g. Kingsmarch's DETAIL_LOD0): shown on Balanced and above, hidden on Performance and when tiny on screen.
//
// The quality level biases it: Performance keeps coarser levels longer (×0.6), High / Ultra finer ones (×1.35 / ×1.8);
// Balanced uses the plain thresholds (a room without _LODn nodes renders exactly as before).
//
// Anything else (e.g. a town crowd) can register its own objects: `gfxLod.add(obj)` scans `obj` for _LODn nodes,
// `gfxLod.remove(obj)` forgets them. `gfxBudget()` tells background systems how rich to be at the current level.
// The Room editor's layer (src/scene/roomObjects.ts) holds levels the user hid (`hold`: never shown while held) and
// re-fits a group the user moved (`refit`), so a hidden LOD object stays hidden and a moved one switches by where it is.
import * as THREE from 'three';
import type { GfxLevel } from '../../../shared/graphics.ts';

const RX = /^(.*)_LOD(\d)$/;
/** Projected diameter (px) above which LOD0 / LOD1 are used (at bias 1); below the last one → the coarsest level. */
const TH = [150, 55];
const HYST = 0.15;

interface Group { root: THREE.Object3D; levels: THREE.Object3D[]; detail: boolean; center: THREE.Vector3; radius: number; cur: number }

export const LOD_BIAS: Record<GfxLevel, number> = { performance: 0.6, balanced: 1, high: 1.35, ultra: 1.8 };

export interface GfxBudget {
  level: GfxLevel;
  /** Multiplier for crowd / ambient NPC counts (1 = the authored count). */
  npcDensity: number;
  /** Distance (m) within which background characters may use their high-detail LOD0. */
  npcDetailDist: number;
  /** Beyond this distance (m) background characters may be drawn as impostors / billboards (Infinity = never). */
  impostorDist: number;
  /** LOD bias (projected-size multiplier). */
  lodBias: number;
}
const BUDGETS: Record<GfxLevel, GfxBudget> = {
  performance: { level: 'performance', npcDensity: 0.6, npcDetailDist: 0, impostorDist: 13, lodBias: LOD_BIAS.performance },
  balanced: { level: 'balanced', npcDensity: 1, npcDetailDist: 0, impostorDist: Infinity, lodBias: 1 },
  high: { level: 'high', npcDensity: 1.25, npcDetailDist: 11, impostorDist: Infinity, lodBias: LOD_BIAS.high },
  ultra: { level: 'ultra', npcDensity: 1.5, npcDetailDist: 20, impostorDist: Infinity, lodBias: LOD_BIAS.ultra },
};
let current: GfxLevel = 'balanced';
/** Background systems (town crowd, raid) read this for their counts / detail. */
export function gfxBudget(): GfxBudget { return BUDGETS[current]; }
export function setGfxBudgetLevel(l: GfxLevel) { current = l; }

export class LodSystem {
  private groups: Group[] = [];
  private owners = new Map<THREE.Object3D, Group[]>();
  /** level node → its group (Room editor: is this node one the LOD system shows / hides?). */
  private groupOf = new WeakMap<THREE.Object3D, Group>();
  /** Levels the user's Room editor layer hid: never shown while held. */
  private held = new WeakSet<THREE.Object3D>();
  private t = 0;
  private sphere = new THREE.Sphere();
  private v = new THREE.Vector3();
  level: GfxLevel = 'balanced';
  /** Stats for the perf report. */
  stats = { groups: 0, lod0: 0, lod1: 0, lod2: 0, hidden: 0 };

  /** Scan `root` for _LODn nodes and register them. */
  add(root: THREE.Object3D) {
    if (this.owners.has(root)) return;
    const byKey = new Map<string, { parent: THREE.Object3D; levels: THREE.Object3D[] }>();
    root.traverse((o) => {
      const m = RX.exec(o.name);
      if (!m || !o.parent) return;
      // (GLTFLoader splits multi-material meshes into Name_1 … children; those carry no _LOD suffix, so they ride along)
      const key = `${o.parent.uuid}|${m[1]}`;
      let e = byKey.get(key);
      if (!e) { e = { parent: o.parent, levels: [] }; byKey.set(key, e); }
      e.levels[+m[2]] = o;
    });
    const list: Group[] = [];
    for (const e of byKey.values()) {
      const levels = e.levels.filter(Boolean);
      if (!levels.length) continue;
      const box = new THREE.Box3().setFromObject(levels[0]);
      const s = box.getBoundingSphere(new THREE.Sphere());
      // keep the sphere in the group's parent space (rooms / crowds may move)
      const local = e.parent.worldToLocal(s.center.clone());
      const g: Group = { root: e.parent, levels, detail: levels.length === 1 && !!e.levels[0], center: local, radius: Math.max(0.05, s.radius), cur: -1 };
      for (const l of levels) { this.groupOf.set(l, g); if (this.held.has(l)) l.visible = false; }
      list.push(g);
      this.groups.push(g);
    }
    this.owners.set(root, list);
    this.t = 1e9;   // decide on the next update
  }

  remove(root: THREE.Object3D) {
    const list = this.owners.get(root);
    if (!list) return;
    this.owners.delete(root);
    const drop = new Set(list);
    this.groups = this.groups.filter((g) => !drop.has(g));
    for (const g of list) for (const l of g.levels) l.visible = true;
  }

  clear() { for (const r of [...this.owners.keys()]) this.remove(r); }

  /** Is `node` a level this system shows / hides? */
  manages(node: THREE.Object3D): boolean { return this.groupOf.has(node); }
  /** The Room editor hid (`on`) or showed again a level: a held level is never shown; a released one gets the level the
   *  system picks on its next check. */
  hold(node: THREE.Object3D, on: boolean) {
    if (on) { this.held.add(node); node.visible = false; return; }
    if (!this.held.has(node)) return;
    this.held.delete(node);
    const g = this.groupOf.get(node);
    if (g) { g.cur = -1; this.t = 1e9; }
  }
  /** A level's group was moved (Room editor): its size test follows it. */
  refit(node: THREE.Object3D) {
    const g = this.groupOf.get(node);
    if (!g) return;
    const s = new THREE.Box3().setFromObject(g.levels[0]).getBoundingSphere(new THREE.Sphere());
    if (!Number.isFinite(s.radius) || s.radius <= 0) return;
    g.center.copy(g.root.worldToLocal(s.center.clone()));
    g.radius = Math.max(0.05, s.radius);
    this.t = 1e9;
  }

  /** Every ~0.2 s (or right away after a change). */
  update(dt: number, camera: THREE.PerspectiveCamera, viewportH: number, force = false) {
    this.t += dt;
    if (!force && this.t < 0.2) return;
    this.t = 0;
    const bias = LOD_BIAS[this.level];
    const k = viewportH / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / Math.max(camera.zoom, 0.05));
    const st = { groups: this.groups.length, lod0: 0, lod1: 0, lod2: 0, hidden: 0 };
    for (const g of this.groups) {
      const c = this.v.copy(g.center);
      g.root.localToWorld(c);
      const scale = g.root.getWorldScale(this.sphere.center).x || 1;
      const dist = Math.max(0.01, c.distanceTo(camera.position));
      const px = (2 * g.radius * scale / dist) * k * bias;
      let want: number;
      if (g.detail) {
        const on = this.level !== 'performance' && px > (g.cur === 0 ? 8 : 10);
        want = on ? 0 : -2;
      } else {
        const n = g.levels.length;
        want = n - 1;
        for (let i = 0; i < Math.min(n - 1, TH.length); i++) {
          // hysteresis: stepping finer needs +15 %, staying needs only −15 %
          const th = TH[i] * (g.cur >= 0 && g.cur <= i ? 1 - HYST : 1 + HYST);
          if (px >= th) { want = i; break; }
        }
      }
      if (want !== g.cur) {
        g.cur = want;
        g.levels.forEach((l, i) => { l.visible = i === want && !this.held.has(l); });
      }
      if (want === -2) st.hidden++; else if (want === 0) st.lod0++; else if (want === 1) st.lod1++; else st.lod2++;
    }
    this.stats = st;
  }
}

/** The page's LOD system (rooms register on load; other systems may add their own roots). */
export const gfxLod = new LodSystem();
