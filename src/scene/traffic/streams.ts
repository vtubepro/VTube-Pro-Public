// Sky traffic — flying car streams, ground service vehicles and trains on the room's lanes. One InstancedMesh per
// vehicle part (hulls by day) and one additive point cloud of head / tail lights (min pixel size, brighter at night).
// Every vehicle is a pure function of (lane, index, clock): s = s0 + v·t along the lane's arc length; two-way lanes
// split by a lateral offset. Trains (lane `train: {cars, gap, every}`) run consists of cars along their line.
import * as THREE from 'three';
import { Polyline, hash01, type LaneCfg } from './config.ts';

const tv = new THREE.Vector3(), tt = new THREE.Vector3(), side = new THREE.Vector3(), tm = new THREE.Matrix4(), tq = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1), SC = new THREE.Vector3(1, 1, 1);

interface Unit { lane: number; s0: number; v: number; dir: 1 | -1; off: number; dy: number; tint: number; kind: string; car?: number; train?: number; hull: boolean }
interface Part { mesh: THREE.InstancedMesh; kind: string }
export interface VehicleTemplate { parts: { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 }[]; length: number; scale: number }

export class Streams {
  readonly group = new THREE.Group();
  private lines: Polyline[] = [];
  private lanes: LaneCfg[] = [];
  private units: Unit[] = [];
  private byKind = new Map<string, number[]>();
  private parts: Part[] = [];
  private pts: THREE.Points | null = null;
  private ptsMat: THREE.ShaderMaterial | null = null;
  private pos: Float32Array = new Float32Array(0);
  private templates: Record<string, VehicleTemplate>;
  private mats: THREE.Matrix4[] = [];

  /** hullDist: lanes whose nearest point is further than this from the room origin show lights only (hulls would be < 2 px) */
  constructor(lanes: LaneCfg[], toWorld: (p: THREE.Vector3) => THREE.Vector3, templates: Record<string, VehicleTemplate>, density = 1, seed = 18, hullDist = 1100) {
    this.group.name = 'vtp:traffic-streams';
    this.templates = templates;
    lanes.filter((l) => l.kind !== 'cruise' && ((l.cars ?? 0) > 0 || l.train) && l.points.length >= 2).forEach((l) => {
      const pts = l.points.map((p) => { const v = toWorld(new THREE.Vector3(...p)); return [v.x, v.y, v.z] as [number, number, number]; });
      const line = new Polyline(pts, !!l.closed);
      const li = this.lines.length;
      this.lines.push(line); this.lanes.push(l);
      const kind = (l as LaneCfg & { vehicle?: string }).vehicle ?? (l.train ? 'tram' : 'car');
      const near = Math.min(...line.pts.map((p) => p.length()));
      const hull = kind !== 'car' || near < hullDist;
      if (l.train) {
        const tr = l.train as { cars?: number; gap?: number; every?: number };
        const n = Math.max(1, Math.round(line.length / ((tr.every ?? 90) * (l.speed ?? 30))));
        const carLen = (templates[kind]?.length ?? 24) * (templates[kind]?.scale ?? 1) + (tr.gap ?? 1.2);
        for (let k = 0; k < n; k++) for (let c = 0; c < (tr.cars ?? 5); c++) {
          const two = (l.twoWay ?? 0) > 0 && k % 2 === 1;
          this.units.push({ lane: li, s0: (line.length * k) / n - c * carLen * (two ? -1 : 1), v: l.speed ?? 30, dir: two ? -1 : 1, off: two ? -(l.width ?? 6) / 2 : (l.twoWay ? (l.width ?? 6) / 2 : 0), dy: 0, tint: 0, kind, car: c, train: k, hull: true });
        }
        return;
      }
      const n = Math.round((l.cars ?? 0) * density);
      for (let i = 0; i < n; i++) {
        const h = (k: number) => hash01(seed + li * 131, i, k);
        const two = (l.twoWay ?? 1) > 0 && h(1) < 0.5;
        this.units.push({ lane: li, s0: line.length * h(2), v: (l.speed ?? 35) * (0.8 + 0.4 * h(3)), dir: two ? -1 : 1,
          off: ((two ? -1 : 1) * 0.25 + (h(4) - 0.5) * 0.3) * (l.width ?? 10), dy: (h(5) - 0.5) * (kind === 'tug' ? 0 : 6), tint: h(6), kind, hull });
      }
    });
    const N = this.units.length;
    if (!N) return;
    this.units.forEach((u, i) => { if (!u.hull) return; const a = this.byKind.get(u.kind) ?? []; a.push(i); this.byKind.set(u.kind, a); });
    const tints = [0x8a2a20, 0x2a3a60, 0xb0aca4, 0x1a1a1c, 0x6a5020];
    const c = new THREE.Color();
    for (const [kind, idx] of this.byKind) {
      const tpl = templates[kind];
      if (!tpl) continue;
      for (const pt of tpl.parts) {
        const mesh = new THREE.InstancedMesh(pt.geometry, pt.material, idx.length);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = false;
        mesh.userData.local = pt.matrix;
        if (kind === 'car' && !/^EMIT_/.test(pt.material.name)) idx.forEach((ui, j) => mesh.setColorAt(j, c.setHex(tints[Math.floor(this.units[ui].tint * tints.length) % tints.length])));
        this.parts.push({ mesh, kind });
        this.group.add(mesh);
      }
    }
    // 2 lights per unit: head (warm white) + tail (red); trains: one warm window glow per car
    this.pos = new Float32Array(N * 2 * 3);
    const col = new Float32Array(N * 2 * 3);
    for (let i = 0; i < N; i++) {
      const tr = this.units[i].kind === 'tram';
      col.set(tr ? [1.0, 0.8, 0.5] : [1.0, 0.92, 0.78], i * 6);
      col.set(tr ? [1.0, 0.8, 0.5] : this.units[i].kind === 'tug' ? [1.0, 0.6, 0.1] : [1.0, 0.16, 0.08], i * 6 + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.ptsMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: { uGain: { value: 1 }, uSize: { value: 2.6 }, uScale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute vec3 color; varying vec3 vC; uniform float uSize; uniform float uScale;
        void main() { vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = max(2.0, uSize * uScale / max(1.0, -mv.z)); }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; uniform float uGain;
        void main() { vec2 d = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(d)); gl_FragColor = vec4(vC * a * uGain, a); }`,
    });
    this.pts = new THREE.Points(g, this.ptsMat);
    this.pts.frustumCulled = false;
    this.group.add(this.pts);
  }

  get count() { return this.units.length; }
  countOf(kind: string) { return this.units.filter((u) => u.kind === kind).length; }
  get hulls() { return this.units.filter((u) => u.hull).length; }

  update(t: number, night: number, viewportH: number) {
    if (!this.units.length) return;
    const pos = this.pos;
    const mats = this.mats;
    if (mats.length !== this.units.length) { mats.length = 0; for (let i = 0; i < this.units.length; i++) mats.push(new THREE.Matrix4()); }
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const line = this.lines[u.lane];
      const s = u.s0 + u.dir * u.v * t;
      line.at(s, tv, tt);
      if (u.dir < 0) tt.negate();
      side.crossVectors(tt, UP).normalize();
      tv.addScaledVector(side, u.off); tv.y += u.dy;
      tq.setFromUnitVectors(FWD, tt);
      const sc = this.templates[u.kind]?.scale ?? 1;
      mats[i].compose(tv, tq, SC.set(sc, sc, sc));
      const L = (this.templates[u.kind]?.length ?? 6) * sc * 0.5;
      const hy = u.kind === 'tram' ? 2.6 : 0.6;
      pos[i * 6] = tv.x + tt.x * L; pos[i * 6 + 1] = tv.y + tt.y * L + hy; pos[i * 6 + 2] = tv.z + tt.z * L;
      pos[i * 6 + 3] = tv.x - tt.x * L; pos[i * 6 + 4] = tv.y - tt.y * L + hy; pos[i * 6 + 5] = tv.z - tt.z * L;
    }
    for (const p of this.parts) {
      const idx = this.byKind.get(p.kind)!;
      const local = p.mesh.userData.local as THREE.Matrix4;
      for (let j = 0; j < idx.length; j++) p.mesh.setMatrixAt(j, tm.multiplyMatrices(mats[idx[j]], local));
      p.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.pts) (this.pts.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    if (this.ptsMat) { this.ptsMat.uniforms.uGain.value = 0.35 + 1.1 * night; this.ptsMat.uniforms.uScale.value = viewportH * 0.9; }
  }

  dispose() {
    for (const p of this.parts) p.mesh.dispose();
    this.pts?.geometry.dispose(); this.ptsMat?.dispose();
    this.group.removeFromParent();
  }
}

/** Flatten a ship-GLB template (LOD root + children) into instanceable parts, in the template's own space. */
export function vehicleTemplate(root: THREE.Object3D, length: number, scale = 1): VehicleTemplate {
  root.updateMatrixWorld(true);
  const inv = root.matrixWorld.clone().invert();
  const parts: VehicleTemplate['parts'] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mt of Array.isArray(m.material) ? m.material : [m.material]) parts.push({ geometry: m.geometry, material: mt, matrix: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) });
  });
  return { parts, length, scale };
}
