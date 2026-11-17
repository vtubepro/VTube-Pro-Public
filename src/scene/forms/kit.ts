// Room-forms kit (shared/forms.ts `forms.kit`): procedural set pieces for rooms that don't author the form nodes in
// their GLB - desks (standard / wide / giant console, split into _L / _R halves that can slide apart), a booster riser,
// a micro perch podium, a host chair, a mech docking cradle (grating deck, hazard rim, four clamps), a ceiling gantry,
// a holo desk, ceiling petals, hangar doors, an iris door, a floor lift, runway chevrons, rotating beacons, a couch and
// a guest landing pad. Every piece is a named node tree in glTF space, so the forms engine animates it exactly like
// authored nodes (it never knows the difference). Light programs find their parts by material name EMIT_<group>
// (runway chevrons: one material each, in name order) and by userData.formSpin / formGlow (beacons).
//
// No canvas, no DOM: textures are DataTextures, so Node tests (tools/forms_unit.ts) build every piece too.
// Look: original retro-orbital hardware (indigo hull, chrome, brass, amber / black hazard trim) - no third-party designs.
import * as THREE from 'three';
import type { KitPieceDef } from '../../../shared/forms.ts';

type P = KitPieceDef['params'];
const n = (p: P, k: string, d: number) => (typeof p[k] === 'number' && Number.isFinite(p[k] as number) ? p[k] as number : d);
const s = (p: P, k: string, d: string) => (typeof p[k] === 'string' ? p[k] as string : d);
const D2R = Math.PI / 180;

/** A generated desk / console top (piece-local; the engine turns it into a world SeatSurface). */
export interface KitSurface { center: THREE.Vector3; yaw: number; halfW: number; halfD: number; top: number }

/** Materials + textures shared by every piece of one room (disposed with it). */
export class KitMaterials {
  private cache = new Map<string, THREE.Material>();
  private tex: THREE.Texture[] = [];
  private stripes: THREE.DataTexture | null = null;
  private grate: THREE.DataTexture | null = null;

  std(key: string, color: string, rough: number, metal: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const k = `std|${key}|${color}|${rough}|${metal}`;
    let m = this.cache.get(k) as THREE.MeshStandardMaterial | undefined;
    if (!m) { m = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: rough, metalness: metal, ...extra }); m.name = `form_${key}`; this.cache.set(k, m); }
    return m;
  }
  /** EMIT_<group>: the forms engine's light programs drive it (one = shared by the group, else a fresh one per call). */
  emit(group: string, color: string, intensity = 2, shared = true): THREE.MeshStandardMaterial {
    const k = `emit|${group}|${color}`;
    if (shared) { const c = this.cache.get(k) as THREE.MeshStandardMaterial | undefined; if (c) return c; }
    const m = new THREE.MeshStandardMaterial({ color: new THREE.Color('#0c0a10'), emissive: new THREE.Color(color), emissiveIntensity: intensity, roughness: 0.4, metalness: 0 });
    m.name = `EMIT_${group}`;
    m.userData.formBase = intensity;
    if (shared) this.cache.set(k, m); else this.cache.set(`${k}|${this.cache.size}`, m);
    return m;
  }
  glass(color: string, opacity: number): THREE.MeshBasicMaterial {
    const k = `glass|${color}|${opacity}`;
    let m = this.cache.get(k) as THREE.MeshBasicMaterial | undefined;
    if (!m) { m = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }); m.name = 'form_holo'; this.cache.set(k, m); }
    return m;
  }
  /** Amber / black diagonal hazard stripes. */
  hazard(): THREE.MeshStandardMaterial {
    if (!this.stripes) {
      const W = 64, d = new Uint8Array(W * W * 4);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const on = ((x + y) % 32) < 16, i = (y * W + x) * 4;
        d[i] = on ? 255 : 22; d[i + 1] = on ? 170 : 18; d[i + 2] = on ? 29 : 26; d[i + 3] = 255;
      }
      this.stripes = new THREE.DataTexture(d, W, W);
      this.stripes.wrapS = this.stripes.wrapT = THREE.RepeatWrapping;
      this.stripes.colorSpace = THREE.SRGBColorSpace;
      this.stripes.magFilter = THREE.LinearFilter;
      this.stripes.needsUpdate = true;
      this.tex.push(this.stripes);
    }
    return this.std('hazard', '#ffffff', 0.5, 0.2, { map: this.stripes });
  }
  /** Deck grating (dark plate with a lighter mesh of holes). */
  grating(): THREE.MeshStandardMaterial {
    if (!this.grate) {
      const W = 64, d = new Uint8Array(W * W * 4);
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const bar = x % 16 < 3 || y % 16 < 3, i = (y * W + x) * 4, v = bar ? 120 : 34;
        d[i] = v; d[i + 1] = v; d[i + 2] = v + 10; d[i + 3] = 255;
      }
      this.grate = new THREE.DataTexture(d, W, W);
      this.grate.wrapS = this.grate.wrapT = THREE.RepeatWrapping;
      this.grate.repeat.set(6, 6);
      this.grate.colorSpace = THREE.SRGBColorSpace;
      this.grate.needsUpdate = true;
      this.tex.push(this.grate);
    }
    return this.std('grating', '#8890a0', 0.55, 0.55, { map: this.grate });
  }
  dispose() {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.tex) t.dispose();
    this.cache.clear(); this.tex = [];
  }
}

// ---------------------------------------------------------------- tiny geometry helpers
function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, name = ''): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  if (name) o.name = name;
  parent.add(o);
  return o;
}
const box = (w: number, h: number, d: number, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, name = '') => mesh(new THREE.BoxGeometry(w, h, d), m, parent, x, y, z, name);
const cyl = (rt: number, rb: number, h: number, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, seg = 24, name = '') => mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m, parent, x, y, z, name);
function group(name: string, parent?: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
  const g = new THREE.Group(); g.name = name; g.position.set(x, y, z);
  parent?.add(g);
  return g;
}
/** A flat ring (annulus) in the XZ plane, UVs running around it (hazard stripes follow the rim). */
function ringGeo(r0: number, r1: number, seg = 48, h = 0.04): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r1, h, seg, 1, true);
  const inner = new THREE.CylinderGeometry(r0, r0, h, seg, 1, true);
  const top = new THREE.RingGeometry(r0, r1, seg, 1); top.rotateX(-Math.PI / 2); top.translate(0, h / 2, 0);
  // stripes along the ring: u = angle * 8 laps
  const uv = top.attributes.uv as THREE.BufferAttribute, pos = top.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { const a = Math.atan2(pos.getZ(i), pos.getX(i)); uv.setXY(i, (a / (2 * Math.PI)) * r1 * 6, Math.hypot(pos.getX(i), pos.getZ(i)) * 3); }
  inner.scale(-1, 1, 1);
  const parts = [g, inner, top].map((x) => x.toNonIndexed());
  const out = mergeSimple(parts);
  for (const p of [g, inner, top, ...parts]) p.dispose();
  return out;
}
/** Merge non-indexed geometries with position / normal / uv (no deps on BufferGeometryUtils). */
function mergeSimple(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const keys = ['position', 'normal', 'uv'] as const;
  const out = new THREE.BufferGeometry();
  for (const k of keys) {
    const size = k === 'uv' ? 2 : 3;
    const total = list.reduce((a, g) => a + (g.attributes.position as THREE.BufferAttribute).count, 0);
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const g of list) {
      const a = g.attributes[k] as THREE.BufferAttribute | undefined, cnt = (g.attributes.position as THREE.BufferAttribute).count;
      if (a) arr.set((a.array as Float32Array).subarray(0, cnt * size), o);
      o += cnt * size;
    }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  out.computeVertexNormals();
  return out;
}

// ---------------------------------------------------------------- pieces
export interface KitOut { root: THREE.Object3D; surfaces: KitSurface[] }
type Builder = (p: P, name: string, k: KitMaterials) => KitOut;

/** A talk-show desk in two halves (`_L` / `_R`, each pivoting at the desk centre), a `_TOP` marker at the top centre.
 *  style 'console' = a giant's chunky standing console. +Z = the audience side; the host sits behind it at -Z. */
const desk: Builder = (p, name, k) => {
  const W = n(p, 'w', 2.2), D = n(p, 'd', 0.72), H = n(p, 'h', 0.76), split = p.split !== false;
  const topM = k.std('desktop', s(p, 'color', '#e9dcc0'), 0.4, 0.05), body = k.std('deskbody', s(p, 'body', '#1f6f78'), 0.5, 0.15);
  const trim = k.std('chrome', '#c9ced8', 0.2, 0.8), accent = k.emit(s(p, 'group', 'formdesk'), s(p, 'accent', '#ff4fb4'), 1.8);
  const root = group(name);
  const console = s(p, 'style', '') === 'console';
  for (const side of split ? [-1, 1] : [0]) {
    const half = group(split ? `${name}_${side < 0 ? 'L' : 'R'}` : `${name}_BODY`, root);
    const hw = split ? W / 2 : W, cx = split ? side * W / 4 : 0;
    box(hw - 0.01, 0.05, D, topM, half, cx, H - 0.025, 0);
    box(hw - 0.04, H - 0.12, 0.05, body, half, cx, (H - 0.12) / 2 + 0.04, D / 2 - 0.06);
    box(hw - 0.06, 0.03, 0.02, accent, half, cx, H - 0.08, D / 2 - 0.03);
    box(hw - 0.04, 0.04, 0.05, trim, half, cx, 0.03, D / 2 - 0.06);
    if (console) {
      // a giant's console: a raked panel of lit keys + two heavy feet
      const panel = box(hw * 0.8, 0.04, D * 0.5, k.std('consolepanel', '#262a36', 0.4, 0.5), half, cx, H + 0.06, -D * 0.12);
      panel.rotation.x = -0.35;
      for (let i = 0; i < 6; i++) box(0.12, 0.02, 0.06, accent, half, cx - hw * 0.32 + i * hw * 0.13, H + 0.1, -D * 0.12);
    }
    const ex = split ? side * (W / 2 - 0.04) : 0;
    if (split) box(0.05, H - 0.1, D - 0.1, body, half, ex, (H - 0.1) / 2 + 0.04, -0.02);
    else for (const sx of [-1, 1]) box(0.05, H - 0.1, D - 0.1, body, half, sx * (W / 2 - 0.04), (H - 0.1) / 2 + 0.04, -0.02);
  }
  group(`${name}_TOP`, root, 0, H, 0);
  return { root, surfaces: [{ center: new THREE.Vector3(0, 0, 0), yaw: 0, halfW: W / 2, halfD: D / 2, top: H }] };
};

/** Booster riser under the host chair: a platform with a front step and a lit edge. */
const riser: Builder = (p, name, k) => {
  const W = n(p, 'w', 1.2), D = n(p, 'd', 1.1), H = n(p, 'h', 0.32);
  const root = group(name);
  box(W, H, D, k.std('riser', s(p, 'color', '#2a1f52'), 0.55, 0.15), root, 0, H / 2, 0);
  box(W, 0.02, D, k.grating(), root, 0, H + 0.005, 0);
  box(W * 0.6, H / 2, 0.3, k.std('riser', s(p, 'color', '#2a1f52'), 0.55, 0.15), root, 0, H / 4, D / 2 + 0.15);
  box(W + 0.02, 0.025, 0.025, k.emit(s(p, 'group', 'formdesk'), s(p, 'accent', '#ff4fb4'), 1.6), root, 0, H, D / 2);
  return { root, surfaces: [] };
};

/** Micro perch: a round podium with a lit ring and a tiny mic (sits on the desk top). */
const podium: Builder = (p, name, k) => {
  const R = n(p, 'r', 0.2), H = n(p, 'h', 0.16);
  const root = group(name);
  cyl(R, R * 1.1, H, k.std('chrome', '#c9ced8', 0.2, 0.8), root, 0, H / 2, 0, 28);
  cyl(R * 0.92, R * 0.92, 0.012, k.std('podiumtop', '#1a1238', 0.5, 0.2), root, 0, H + 0.006, 0, 28);
  const ring = mesh(new THREE.TorusGeometry(R * 1.02, 0.012, 6, 32), k.emit(s(p, 'group', 'formdesk'), s(p, 'accent', '#5ff2ff'), 2), root, 0, H * 0.6, 0);
  ring.rotation.x = Math.PI / 2;
  cyl(0.006, 0.006, 0.16, k.std('chrome', '#c9ced8', 0.2, 0.8), root, R * 0.55, H + 0.08, R * 0.3, 6);
  cyl(0.018, 0.018, 0.04, k.std('mic', '#202020', 0.5, 0.3), root, R * 0.55, H + 0.17, R * 0.3, 10);
  return { root, surfaces: [] };
};

/** Host chair (rides the riser in the booster form): base, seat, back. Seat top at `seat`. */
const chair: Builder = (p, name, k) => {
  const S = n(p, 'seat', 0.5), W = n(p, 'w', 0.62);
  const root = group(name);
  const fab = k.std('velvet', s(p, 'color', '#7a1440'), 0.95, 0), chrome = k.std('chrome', '#c9ced8', 0.2, 0.8);
  cyl(0.28, 0.32, 0.04, chrome, root, 0, 0.02, 0, 20);
  cyl(0.04, 0.04, S - 0.12, chrome, root, 0, (S - 0.12) / 2 + 0.04, 0, 10);
  box(W, 0.1, W * 0.9, fab, root, 0, S - 0.05, 0);
  box(W, 0.7, 0.12, fab, root, 0, S + 0.32, -W * 0.42);
  return { root, surfaces: [] };
};

/** Mech docking cradle: a round deck (grating top, hazard rim, glowing ring) with four clamps `_CLAMP_01..04` and a
 *  `_RING` light. Deck top at `h`. */
const cradle: Builder = (p, name, k) => {
  const R = n(p, 'r', 2.2), H = n(p, 'h', 0.32), N = Math.round(n(p, 'clamps', 4));
  const root = group(name);
  const hull = k.std('hull', '#1a1238', 0.55, 0.15), steel = k.std('steel', '#3a3f4a', 0.45, 0.6);
  cyl(R, R * 1.04, H - 0.04, steel, root, 0, (H - 0.04) / 2, 0, 48);
  mesh(new THREE.CylinderGeometry(R * 0.86, R * 0.86, 0.02, 48), k.grating(), root, 0, H - 0.01, 0);
  mesh(ringGeo(R * 0.86, R, 64, 0.05), k.hazard(), root, 0, H - 0.02, 0);
  const ringM = k.emit(s(p, 'group', 'formdock'), s(p, 'accent', '#ffb23a'), 2.4);
  const ring = mesh(new THREE.TorusGeometry(R * 0.55, 0.03, 6, 48), ringM, root, 0, H, 0, `${name}_RING`);
  ring.rotation.x = Math.PI / 2;
  cyl(R * 0.2, R * 0.2, 0.03, ringM, root, 0, H, 0, 24);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.PI / N;
    const c = group(`${name}_CLAMP_${String(i + 1).padStart(2, '0')}`, root, Math.sin(a) * R * 0.74, H, Math.cos(a) * R * 0.74);
    c.rotation.y = a;
    box(0.56, 0.5, 0.62, k.hazard(), c, 0, 0.25, 0);
    box(0.6, 0.12, 0.3, steel, c, 0, 0.56, -0.18);
    box(0.4, 0.18, 0.2, hull, c, 0, 0.42, -0.4);
    box(0.08, 0.08, 0.08, k.emit(s(p, 'beacon', 'formbeacon'), '#ffab2e', 2.6), c, 0.22, 0.54, 0.2);
  }
  return { root, surfaces: [] };
};

/** Small landing pad for a big guest (couch zone): deck + hazard rim + glow ring, no clamps. */
const pad: Builder = (p, name, k) => cradle({ ...p, clamps: 0, r: n(p, 'r', 1.7), h: n(p, 'h', 0.18) }, name, k);

/** Ceiling gantry: a square frame hung from four cables, umbilical hoses, four work lights. Hangs `h` above the floor. */
const gantry: Builder = (p, name, k) => {
  const W = n(p, 'w', 3.4), Y = n(p, 'h', 5.4), L = n(p, 'cable', 2.0);
  const root = group(name);
  const steel = k.std('steel', '#3a3f4a', 0.45, 0.6), hz = k.hazard();
  for (const [x, z, w, d] of [[0, W / 2, W, 0.18], [0, -W / 2, W, 0.18], [W / 2, 0, 0.18, W], [-W / 2, 0, 0.18, W]] as const) box(w, 0.22, d, hz, root, x, Y, z);
  const hoseM = k.std('hose', '#14121a', 0.8, 0.1), lightM = k.emit(s(p, 'group', 'formwork'), '#fff2d0', 2.2);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    cyl(0.025, 0.025, L, steel, root, x * W / 2, Y + L / 2, z * W / 2, 6);
    const hose = mesh(new THREE.TorusGeometry(0.55, 0.05, 6, 16, Math.PI), hoseM, root, x * W * 0.32, Y - 0.5, z * W * 0.32);
    hose.rotation.set(0, Math.atan2(x, z), Math.PI / 2);
    const lamp = box(0.32, 0.14, 0.2, lightM, root, x * W * 0.45, Y - 0.16, z * W * 0.45, `${name}_LIGHT_${x > 0 ? 'R' : 'L'}${z > 0 ? 'F' : 'B'}`);
    lamp.userData.formGlow = { group: s(p, 'group', 'formwork'), size: 0.35 };
  }
  return { root, surfaces: [] };
};

/** Rotating amber beacon (program 'rotate' spins `_SPIN`, glow halo drawn by the engine). */
const beacon: Builder = (p, name, k) => {
  const g = s(p, 'group', 'formbeacon'), c = s(p, 'color', '#ffab2e');
  const root = group(name);
  cyl(0.11, 0.13, 0.08, k.std('steel', '#3a3f4a', 0.45, 0.6), root, 0, 0.04, 0, 16);
  const dome = mesh(new THREE.SphereGeometry(0.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), k.emit(g, c, 2.6), root, 0, 0.08, 0);
  dome.userData.formGlow = { group: g, size: 0.5 };
  const spin = group(`${name}_SPIN`, root, 0, 0.13, 0);
  spin.userData.formSpin = g;
  for (const sx of [-1, 1]) mesh(new THREE.PlaneGeometry(0.5, 0.09), k.glass(c, 0.2), spin, sx * 0.3, 0, 0);
  return { root, surfaces: [] };
};

/** Runway chevrons from the origin along +Z (`len` m, `count` chevrons, each its own EMIT_<group> material: 'chase'). */
const runway: Builder = (p, name, k) => {
  const L = n(p, 'len', 8), W = n(p, 'w', 1.6), N = Math.round(n(p, 'count', 10)), g = s(p, 'group', 'formrunway'), c = s(p, 'color', '#ffd25a');
  const root = group(name);
  for (let i = 0; i < N; i++) {
    const ch = group(`${name}_CHEV_${String(i + 1).padStart(2, '0')}`, root, 0, 0.012, (i + 0.5) * (L / N));
    const m = k.emit(g, c, 1.8, false);
    for (const sx of [-1, 1]) { const b = box(W * 0.55, 0.012, 0.16, m, ch, sx * W * 0.24, 0, 0); b.rotation.y = sx * 0.55; }
  }
  return { root, surfaces: [] };
};

/** Hangar doors in a wall frame: leaves `_L` / `_R` slide apart along local X; hazard pillars, beacons on top. The door
 *  plane is local XY at z = 0, +Z = into the room. */
const hangar: Builder = (p, name, k) => {
  const W = n(p, 'w', 6), H = n(p, 'h', 7), T = n(p, 't', 0.3);
  const root = group(name);
  const hull = k.std('hull', '#1a1238', 0.55, 0.15), steel = k.std('steel', '#3a3f4a', 0.45, 0.6), rib = k.std('rib', '#2a1f52', 0.5, 0.3);
  for (const sx of [-1, 1]) box(0.6, H + 0.6, T + 0.3, k.hazard(), root, sx * (W / 2 + 0.3), (H + 0.6) / 2, 0);
  box(W + 1.8, 0.7, T + 0.3, hull, root, 0, H + 0.35, 0);
  for (const sx of [-1, 1]) {
    const leaf = group(`${name}_${sx < 0 ? 'L' : 'R'}`, root, sx * W / 4, 0, 0);
    box(W / 2 - 0.02, H, T, steel, leaf, 0, H / 2, 0);
    for (let i = 1; i < 5; i++) box(W / 2 - 0.2, 0.08, T + 0.04, rib, leaf, 0, (H / 5) * i, 0);
    box(0.12, H * 0.9, T + 0.06, k.hazard(), leaf, -sx * (W / 4 - 0.08), H * 0.45, 0);
    box(W / 2 - 0.6, 0.12, T + 0.05, k.emit(s(p, 'group', 'formdoor'), '#5ff2ff', 1.4), leaf, 0, H * 0.62, 0);
  }
  for (const sx of [-1, 1]) {
    const b = beacon({ group: s(p, 'beacon', 'formbeacon') }, `${name}_BEACON_${sx < 0 ? 'L' : 'R'}`, k);
    b.root.position.set(sx * (W / 2 + 0.3), H + 0.7, T / 2 + 0.1);
    root.add(b.root);
  }
  return { root, surfaces: [] };
};

/** Iris door: a hazard ring with `blades` blades `_BLADE_xx`, each pivoting at the rim about local Z (rotate them by
 *  `turn` degrees to open). Door plane = local XY, centre at height `y`. */
const iris: Builder = (p, name, k) => {
  const R = n(p, 'r', 3.2), N = Math.round(n(p, 'blades', 10)), Y = n(p, 'y', R + 0.2);
  const root = group(name);
  const frame = mesh(new THREE.TorusGeometry(R + 0.25, 0.32, 10, 48), k.hazard(), root, 0, Y, 0);
  void frame;
  const steel = k.std('steel', '#3a3f4a', 0.45, 0.6);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const piv = group(`${name}_BLADE_${String(i + 1).padStart(2, '0')}`, root, Math.cos(a) * R, Y + Math.sin(a) * R, 0);
    piv.rotation.z = a + Math.PI;
    // the blade: a long wedge from the pivot to past the centre (overlapping its neighbours when closed)
    const sh = new THREE.Shape();
    const w = (2 * Math.PI * R) / N;
    sh.moveTo(0, -w * 0.62); sh.lineTo(R * 1.02, -w * 0.12); sh.lineTo(R * 1.02, w * 0.3); sh.lineTo(0, w * 0.62); sh.lineTo(0, -w * 0.62);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.08, bevelEnabled: false });
    g.translate(0, 0, -0.04 + (i % 2) * 0.02);
    mesh(g, steel, piv);
  }
  for (const sx of [-1, 1]) {
    const b = beacon({ group: s(p, 'beacon', 'formbeacon') }, `${name}_BEACON_${sx < 0 ? 'L' : 'R'}`, k);
    b.root.position.set(sx * (R + 0.9), Y + R * 0.7, 0.35);
    root.add(b.root);
  }
  return { root, surfaces: [] };
};

/** Floor lift: hatch leaves `_HATCH_L` / `_HATCH_R` flush with the floor (slide apart along X) and a `_PLATFORM` the
 *  big-entrance mover raises with the performer. */
const lift: Builder = (p, name, k) => {
  const R = n(p, 'r', 1.8);
  const root = group(name);
  mesh(ringGeo(R, R + 0.18, 48, 0.02), k.hazard(), root, 0, 0.01, 0);
  for (const sx of [-1, 1]) {
    const leaf = group(`${name}_HATCH_${sx < 0 ? 'L' : 'R'}`, root, sx * R / 2, 0, 0);
    box(R - 0.01, 0.03, R * 2, k.grating(), leaf, 0, 0.012, 0);
  }
  const plat = group(`${name}_PLATFORM`, root, 0, -0.02, 0);
  cyl(R * 0.98, R * 0.98, 0.12, k.std('steel', '#3a3f4a', 0.45, 0.6), plat, 0, -0.06, 0, 40);
  const ring = mesh(new THREE.TorusGeometry(R * 0.8, 0.025, 6, 40), k.emit(s(p, 'group', 'formdock'), '#ffb23a', 2.2), plat, 0, 0.005, 0);
  ring.rotation.x = Math.PI / 2;
  return { root, surfaces: [] };
};

/** Ceiling petals around an opening: `count` panels `_PETAL_xx`, each hinged at the outer rim (rotate X to fold up). */
const petals: Builder = (p, name, k) => {
  const R = n(p, 'r', 2.6), N = Math.round(n(p, 'count', 8)), Y = n(p, 'y', 6.2);
  const root = group(name);
  const hull = k.std('rib', '#2a1f52', 0.5, 0.3);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const hinge = group(`${name}_PETAL_${String(i + 1).padStart(2, '0')}`, root, Math.sin(a) * R, Y, Math.cos(a) * R);
    hinge.rotation.y = a + Math.PI;
    const sh = new THREE.Shape(), w = Math.tan(Math.PI / N) * R;
    sh.moveTo(-w, 0); sh.lineTo(w, 0); sh.lineTo(0.02, R); sh.lineTo(-0.02, R); sh.lineTo(-w, 0);
    const g = new THREE.ExtrudeGeometry(sh, { depth: 0.08, bevelEnabled: false });
    g.rotateX(Math.PI / 2);                                       // shape plane -> XZ, pointing +Z from the hinge
    mesh(g, hull, hinge, 0, 0.04, 0);
  }
  mesh(ringGeo(R, R + 0.3, 48, 0.12), k.hazard(), root, 0, Y + 0.02, 0);
  return { root, surfaces: [] };
};

/** Guest couch (curved velvet), seat top at `seat`. */
const couch: Builder = (p, name, k) => {
  const W = n(p, 'w', 2.4), S = n(p, 'seat', 0.45);
  const root = group(name);
  const fab = k.std('velvet', s(p, 'color', '#7a1440'), 0.95, 0), base = k.std('rib', '#2a1f52', 0.5, 0.3);
  box(W, 0.12, 0.8, base, root, 0, 0.06, 0);
  box(W, S - 0.12, 0.8, fab, root, 0, (S - 0.12) / 2 + 0.12, 0);
  box(W, 0.6, 0.2, fab, root, 0, S + 0.24, -0.34);
  for (const sx of [-1, 1]) box(0.2, 0.3, 0.8, fab, root, sx * (W / 2 - 0.1), S + 0.1, 0);
  return { root, surfaces: [] };
};

/** Holo desk plate for a mech pilot: a translucent cyan slab with lit edges (the engine floats it at the pilot's face). */
const holo: Builder = (p, name, k) => {
  const W = n(p, 'w', 1.5), D = n(p, 'd', 0.5);
  const root = group(name);
  box(W, 0.02, D, k.glass(s(p, 'color', '#46e6ff'), 0.28), root, 0, 0, 0);
  const edge = k.emit(s(p, 'group', 'formholo'), s(p, 'color', '#46e6ff'), 2.4);
  for (const z of [-D / 2, D / 2]) box(W, 0.012, 0.012, edge, root, 0, 0.012, z);
  for (const x of [-W / 2, W / 2]) box(0.012, 0.012, D, edge, root, x, 0.012, 0);
  for (let i = 0; i < 5; i++) box(W * 0.12, 0.004, D * 0.3, k.glass('#ff4fb4', 0.4), root, -W * 0.36 + i * W * 0.18, 0.014, -D * 0.1);
  return { root, surfaces: [] };
};

/** A dark slot in the floor where a piece rises from. */
const slot: Builder = (p, name, k) => {
  const root = group(name);
  box(n(p, 'w', 2.4), 0.012, n(p, 'd', 0.9), k.std('slot', '#07060a', 0.9, 0), root, 0, 0.006, 0);
  return { root, surfaces: [] };
};

/** An empty marker (FX anchors, path points). */
const marker: Builder = (_p, name) => ({ root: group(name), surfaces: [] });

export const KIT: Record<string, Builder> = { desk, riser, podium, chair, cradle, pad, gantry, beacon, runway, hangar, iris, lift, petals, couch, holo, slot, marker };

/** Build one kit piece in glTF space (null = unknown piece). Surfaces come back in the piece's own frame. */
export function buildKitPiece(def: KitPieceDef, k: KitMaterials): KitOut | null {
  const b = KIT[def.piece];
  if (!b) return null;
  const out = b(def.params, def.name, k);
  out.root.name = def.name;
  out.root.position.set(def.at[0], def.at[1], def.at[2]);
  out.root.rotation.y = def.yaw * D2R;
  out.root.userData.formKit = def.piece;
  return out;
}
