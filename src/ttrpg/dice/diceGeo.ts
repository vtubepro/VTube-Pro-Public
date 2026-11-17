// Dice shapes (d4 d6 d8 d10 d12 d20; d2 / d3 as relabelled d6s; d100 = a tens d10 + a ones d10): polyhedron faces,
// standard numbering (opposite faces sum to n+1), a numbered texture atlas, and the rotation symmetry group each die
// has — used to FORCE a result: after the physics throw, the visual die is turned by the symmetry that brings the
// face showing the wanted number to the face that ended up on top. The silhouette doesn't change, so it can't be seen.
// Pure three.js math (runs in Node for the tests); textures only when a DOM exists.
import * as THREE from 'three';

export type DieKind = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20';
export interface DieFace { normal: THREE.Vector3; center: THREE.Vector3; verts: THREE.Vector3[]; label: number }
export interface DieShape {
  kind: DieKind;
  faces: DieFace[];
  /** Unique hull vertices (for the physics collider), in "die units" (size 1 ≈ the die's width). */
  hull: Float32Array;
  /** d4 reads the top VERTEX: its labels are per vertex. */
  vertexLabels?: { dir: THREE.Vector3; label: number }[];
  /** Rotation symmetries (body space). */
  group: THREE.Quaternion[];
}

const EPS = 1e-4;

function groupFaces(geo: THREE.BufferGeometry): { normal: THREE.Vector3; verts: THREE.Vector3[] }[] {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const faces: { normal: THREE.Vector3; pts: THREE.Vector3[] }[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    let f = faces.find((x) => x.normal.dot(n) > 1 - 1e-3);
    if (!f) { f = { normal: n, pts: [] }; faces.push(f); }
    for (const p of [a, b, c]) if (!f.pts.some((q) => q.distanceToSquared(p) < EPS)) f.pts.push(p.clone());
  }
  return faces.map((f) => {
    // order the polygon's vertices counter-clockwise around its normal
    const ctr = f.pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / f.pts.length);
    const u = new THREE.Vector3().subVectors(f.pts[0], ctr).normalize(), v = new THREE.Vector3().crossVectors(f.normal, u);
    const verts = f.pts.slice().sort((p, q) => Math.atan2(p.clone().sub(ctr).dot(v), p.clone().sub(ctr).dot(u)) - Math.atan2(q.clone().sub(ctr).dot(v), q.clone().sub(ctr).dot(u)));
    return { normal: f.normal, verts };
  });
}

function d10Geometry(): THREE.BufferGeometry {
  // pentagonal trapezohedron: ring radius 1, ring heights ±c, apex A = c(1+cos36°)/(1−cos36°) (planar kites)
  const c = 0.105, A = c * (1 + Math.cos(Math.PI / 5)) / (1 - Math.cos(Math.PI / 5));
  const ring = Array.from({ length: 10 }, (_, j) => new THREE.Vector3(Math.cos(j * Math.PI / 5), j % 2 ? -c : c, Math.sin(j * Math.PI / 5)));
  const T = new THREE.Vector3(0, A, 0), B = new THREE.Vector3(0, -A, 0);
  const tris: THREE.Vector3[] = [];
  const quad = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3) => { tris.push(p, q, r, p, r, s); };
  for (let k = 0; k < 5; k++) {
    const r0 = ring[(2 * k) % 10], r1 = ring[(2 * k + 1) % 10], r2 = ring[(2 * k + 2) % 10];
    quad(T, r2, r1, r0);
    const s0 = ring[(2 * k + 1) % 10], s1 = ring[(2 * k + 2) % 10], s2 = ring[(2 * k + 3) % 10];
    quad(B, s0, s1, s2);
  }
  const g = new THREE.BufferGeometry().setFromPoints(tris);
  // make every triangle face outward
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i), b = new THREE.Vector3().fromBufferAttribute(pos, i + 1), cc = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(cc, a));
    if (n.dot(a.clone().add(b).add(cc)) < 0) { pos.setXYZ(i + 1, cc.x, cc.y, cc.z); pos.setXYZ(i + 2, b.x, b.y, b.z); }
  }
  return g;
}

function baseGeometry(kind: DieKind): THREE.BufferGeometry {
  switch (kind) {
    case 'd4': return new THREE.TetrahedronGeometry(0.75, 0);
    case 'd6': return new THREE.BoxGeometry(1, 1, 1);
    case 'd8': return new THREE.OctahedronGeometry(0.66, 0);
    case 'd10': { const g = d10Geometry(); g.scale(0.6, 0.6, 0.6); return g; }
    case 'd12': return new THREE.DodecahedronGeometry(0.66, 0);
    case 'd20': return new THREE.IcosahedronGeometry(0.66, 0);
  }
}

/** Opposite faces sum to n+1 (d10: 1..10 with the pairs summing 11 → labels "1".."0"). */
function number(faces: { normal: THREE.Vector3 }[]): number[] {
  const n = faces.length;
  const labels = new Array<number>(n).fill(0);
  const used = new Set<number>();
  // deterministic order: by polar angle of the normal
  const order = faces.map((f, i) => i).sort((i, j) => (faces[j].normal.y - faces[i].normal.y) || (Math.atan2(faces[i].normal.z, faces[i].normal.x) - Math.atan2(faces[j].normal.z, faces[j].normal.x)));
  let next = 1;
  for (const i of order) {
    if (used.has(i)) continue;
    const opp = faces.findIndex((f, k) => k !== i && !used.has(k) && f.normal.dot(faces[i].normal) < -0.999);
    labels[i] = next; used.add(i);
    if (opp >= 0) { labels[opp] = n + 1 - next; used.add(opp); }
    next++;
    if (next > n / 2 && opp >= 0) { /* continue pairing */ }
  }
  // any faces without an opposite (d4) keep sequential labels
  if (labels.some((l) => l === 0)) faces.forEach((_, i) => { labels[i] = i + 1; });
  return labels;
}

function symmetryGroup(faces: { normal: THREE.Vector3; center: THREE.Vector3; verts: THREE.Vector3[] }[]): THREE.Quaternion[] {
  const out: THREE.Quaternion[] = [];
  const frame = (f: { normal: THREE.Vector3; center: THREE.Vector3 }, v: THREE.Vector3) => {
    const z = f.normal.clone(), x = v.clone().sub(f.center).projectOnPlane(z).normalize(), y = new THREE.Vector3().crossVectors(z, x);
    return new THREE.Matrix4().makeBasis(x, y, z);
  };
  const f0 = faces[0], F0inv = frame(f0, f0.verts[0]).invert();
  const normals = faces.map((f) => f.normal);
  const allVerts = faces.flatMap((f) => f.verts);
  for (const f of faces) for (const v of f.verts) {
    const m = frame(f, v).multiply(F0inv);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    // a symmetry maps the whole vertex set onto itself
    const okN = normals.every((n) => { const r = n.clone().applyQuaternion(q); return normals.some((k) => k.dot(r) > 1 - 1e-3); });
    if (!okN) continue;
    const okV = allVerts.every((p) => { const r = p.clone().applyQuaternion(q); return allVerts.some((k) => k.distanceToSquared(r) < 1e-4); });
    if (okV && !out.some((o) => Math.abs(o.dot(q)) > 1 - 1e-6)) out.push(q);
  }
  return out;
}

const cache = new Map<DieKind, DieShape>();
export function dieShape(kind: DieKind): DieShape {
  let s = cache.get(kind);
  if (s) return s;
  const raw = groupFaces(baseGeometry(kind));
  const faces0 = raw.map((f) => ({ ...f, center: f.verts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / f.verts.length) }));
  const labels = number(faces0);
  const faces: DieFace[] = faces0.map((f, i) => ({ ...f, label: labels[i] }));
  const uniq: THREE.Vector3[] = [];
  for (const f of faces) for (const p of f.verts) if (!uniq.some((q) => q.distanceToSquared(p) < EPS)) uniq.push(p);
  const hull = new Float32Array(uniq.flatMap((p) => [p.x, p.y, p.z]));
  s = { kind, faces, hull, group: symmetryGroup(faces) };
  if (kind === 'd4') s.vertexLabels = uniq.map((p, i) => ({ dir: p.clone().normalize(), label: i + 1 }));
  cache.set(kind, s);
  return s;
}

/** Physical die for a number of sides (d2 / d3 ride on a d6, d100 = 2 d10s). */
export function kindFor(sides: number): DieKind { return sides === 4 ? 'd4' : sides === 8 ? 'd8' : sides === 10 || sides === 100 ? 'd10' : sides === 12 ? 'd12' : sides === 20 ? 'd20' : 'd6'; }

/** Which face (or d4 vertex) index shows `value` for a die with `sides` sides (d2/d3 on a d6: v, v+sides …). */
export function facesShowing(shape: DieShape, sides: number, value: number, tens = false): number[] {
  const lab = (l: number) => (sides === 2 ? ((l - 1) % 2) + 1 : sides === 3 ? Math.ceil(l / 2) : l);
  if (shape.kind === 'd4') return shape.vertexLabels!.map((v, i) => (v.label === value ? i : -1)).filter((i) => i >= 0);
  const want = tens ? value : value; // tens die labels are 1..10 → "00".."90"
  return shape.faces.map((f, i) => (lab(f.label) === want ? i : -1)).filter((i) => i >= 0);
}

/** Index of the face (or d4 vertex) pointing most upward for a body rotation. */
export function upIndex(shape: DieShape, q: THREE.Quaternion): number {
  const up = new THREE.Vector3(0, 1, 0);
  let best = -1, bd = -Infinity;
  const dirs = shape.kind === 'd4' ? shape.vertexLabels!.map((v) => v.dir) : shape.faces.map((f) => f.normal);
  dirs.forEach((d, i) => { const y = d.clone().applyQuaternion(q).dot(up); if (y > bd) { bd = y; best = i; } });
  return best;
}

/** The visual offset (body space) that makes face `from` sit where face `to` is: R · dir(from) = dir(to). */
export function relabel(shape: DieShape, from: number, to: number): THREE.Quaternion {
  const dirs = shape.kind === 'd4' ? shape.vertexLabels!.map((v) => v.dir) : shape.faces.map((f) => f.normal);
  const a = dirs[from], b = dirs[to];
  let best = new THREE.Quaternion(), bd = -Infinity;
  for (const g of shape.group) { const d = a.clone().applyQuaternion(g).dot(b); if (d > bd) { bd = d; best = g; } }
  return best.clone();
}

// ---------------------------------------------------------------- render geometry + numbered atlas (browser only)
export interface DieLook { body: string; ink: string; edge?: string; style: string }
const texCache = new Map<string, THREE.CanvasTexture>();

function atlasLayout(n: number) { const cols = Math.ceil(Math.sqrt(n)); return { cols, rows: Math.ceil(n / cols) }; }

/** Mesh geometry with per-face UVs into a label atlas (cell i = face i). */
export function dieGeometry(shape: DieShape): THREE.BufferGeometry {
  const { cols, rows } = atlasLayout(shape.faces.length);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  shape.faces.forEach((f, i) => {
    const cx = (i % cols + 0.5) / cols, cy = 1 - (Math.floor(i / cols) + 0.5) / rows;
    const u = f.verts[0].clone().sub(f.center).normalize(), v = new THREE.Vector3().crossVectors(f.normal, u);
    const R = Math.max(...f.verts.map((p) => p.distanceTo(f.center)));
    const toUv = (p: THREE.Vector3) => { const d = p.clone().sub(f.center); return [cx + (d.dot(v) / R) * 0.47 / cols, cy + (d.dot(u) / R) * 0.47 / rows]; };
    for (let k = 1; k + 1 < f.verts.length; k++) for (const p of [f.verts[0], f.verts[k], f.verts[k + 1]]) {
      pos.push(p.x, p.y, p.z); nor.push(f.normal.x, f.normal.y, f.normal.z); uv.push(...toUv(p));
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

/** Face label text (d10 shows 1-9 and 0; the tens die 00-90; d2 / d3 ride on d6 faces). */
export function faceText(shape: DieShape, label: number, sides: number, tens: boolean): string {
  if (tens) return label === 10 ? '00' : `${label}0`;
  if (sides === 10 || sides === 100) return label === 10 ? '0' : String(label);
  if (sides === 2) return String(((label - 1) % 2) + 1);
  if (sides === 3) return String(Math.ceil(label / 2));
  return String(label);
}

export function dieTexture(shape: DieShape, sides: number, tens: boolean, look: DieLook): THREE.CanvasTexture {
  const key = `${shape.kind}:${sides}:${tens}:${look.body}:${look.ink}:${look.style}`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const { cols, rows } = atlasLayout(shape.faces.length);
  const cell = 128;
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = rows * cell;
  const x = c.getContext('2d')!;
  x.fillStyle = look.body; x.fillRect(0, 0, c.width, c.height);
  // subtle speckle / marble so the body reads as a material, not flat plastic
  const rnd = mulberry(shape.faces.length * 97 + sides);
  for (let i = 0; i < 700; i++) { x.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.05})`; x.beginPath(); x.arc(rnd() * c.width, rnd() * c.height, 1 + rnd() * 6, 0, 7); x.fill(); }
  x.textAlign = 'center'; x.textBaseline = 'middle';
  shape.faces.forEach((f, i) => {
    const cx = (i % cols + 0.5) * cell, cy = (Math.floor(i / cols) + 0.5) * cell;
    if (shape.kind === 'd4') {
      // three numbers near the corners, each upright when its corner points up
      const u = f.verts[0].clone().sub(f.center).normalize(), v = new THREE.Vector3().crossVectors(f.normal, u);
      const R = Math.max(...f.verts.map((p) => p.distanceTo(f.center)));
      for (const p of f.verts) {
        const vi = shape.vertexLabels!.findIndex((vl) => vl.dir.distanceTo(p.clone().normalize()) < 1e-3);
        const d = p.clone().sub(f.center);
        const px = cx + (d.dot(v) / R) * 0.47 * cell * 0.55, py = cy - (d.dot(u) / R) * 0.47 * cell * 0.55;
        x.save(); x.translate(px, py); x.rotate(Math.atan2(px - cx, -(py - cy)));
        x.font = `900 ${cell * 0.24}px system-ui, Arial`; x.fillStyle = look.ink; x.fillText(String(shape.vertexLabels![vi]?.label ?? '?'), 0, 0); x.restore();
      }
      return;
    }
    const t = faceText(shape, f.label, sides, tens);
    const size = shape.kind === 'd6' ? 0.5 : shape.kind === 'd20' ? 0.34 : shape.kind === 'd10' ? (tens ? 0.28 : 0.36) : 0.4;
    x.font = `900 ${cell * size}px system-ui, "Segoe UI", Arial`;
    if (look.edge) { x.lineWidth = cell * 0.035; x.strokeStyle = look.edge; x.strokeText(t, cx, cy); }
    x.fillStyle = look.ink; x.fillText(t, cx, cy);
    if (t === '6' || t === '9') { x.fillRect(cx - cell * 0.1, cy + cell * size * 0.45, cell * 0.2, cell * 0.035); }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  texCache.set(key, tex);
  return tex;
}

function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
