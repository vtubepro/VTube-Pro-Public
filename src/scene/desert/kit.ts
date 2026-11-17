// Desert kit: procedural shapes (unit-sized, base at y = 0) drawn as instanced meshes with ONE shared material, used
// by every placed thing: distant mesas / buttes / spires, city skylines (boxes, domes, towers, spires, tents, beached
// hulls, cranes, windmills), near features (outcrops, crags, rock arches, wreck hulls + ribs, ruins, bone fields) and
// scatter (rocks, dry scrub). A later lane can swap shapes for kit glTF pieces (KIT_* nodes) without touching callers.
// Per instance: instanceMatrix (object -> terrain-local), aKit = (material, tint, window density, compressed?),
// aAnchor = the point distance compression is measured from (city centre / mesa centre / the object itself).
// Material: cel sun + sky ambient, strata bands on stone (by world height), window grids that light one by one at
// night (darkness threshold per window), sand drifts at the base (from the height clipmap), aerial perspective at the
// TRUE distance (compressed objects keep the haze of where they really are). Every pattern is WORLD-anchored (strata,
// rust, which windows light, drifts: glsl.ts wvn + uAnc), so an origin rebase changes nothing on screen.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { CLIP_LEVELS, CLIP_RES, type HeightClipmap } from './clipmap.ts';
import { CLIP_DECODE_GLSL, COMPRESS_GLSL, DESERT_UNIFORMS, NOISE_GLSL, SHADE_GLSL, wn } from './glsl.ts';
import type { DesertUniforms } from './uniforms.ts';
import { rnd } from '../../../shared/desert/noise.ts';

export type Shape = 'box' | 'dome' | 'cyl' | 'cone' | 'hull' | 'rock' | 'crag' | 'arch' | 'rib' | 'mesa' | 'spire' | 'scrub'
  // world-rules kit (src/scene/desert/marks.ts): stranded ships, dead walkers, industry, roads, canyon walls, ruins
  | 'liner' | 'walkerbody' | 'leg' | 'lattice' | 'truss' | 'chimney' | 'pole' | 'palm' | 'cliff' | 'hoodoo' | 'lighthouse'
  | 'deadtree' | 'arcade' | 'tank' | 'prism' | 'girder';
export const SHAPES: Shape[] = ['box', 'dome', 'cyl', 'cone', 'hull', 'rock', 'crag', 'arch', 'rib', 'mesa', 'spire', 'scrub',
  'liner', 'walkerbody', 'leg', 'lattice', 'truss', 'chimney', 'pole', 'palm', 'cliff', 'hoodoo', 'lighthouse', 'deadtree', 'arcade', 'tank', 'prism', 'girder'];
/** Material ids (palette in the shader). */
export const MAT = { adobe: 0, stone: 1, rust: 2, bone: 3, cloth: 4, wood: 5, plaster: 6, scrub: 7, iron: 8, salt: 9, leaf: 10, paint: 11 } as const;
const PAL_N = 12;

// ------------------------------------------------------------------ shapes
function hull(): THREE.BufferGeometry {
  // a ship hull: cross-sections along z (bow at -0.5), half-width w(z), keel at y = 0, deck at y = 1
  const nz = 24, nu = 10;
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i <= nz; i++) {
    const z = -0.5 + i / nz;
    const t = (z + 0.5);                                  // 0 bow .. 1 stern
    const w = 0.5 * Math.pow(Math.sin(Math.min(1, t * 1.6) * Math.PI / 2), 0.7) * (t > 0.92 ? 1 - (t - 0.92) * 1.5 : 1);
    const keel = 0.15 * (1 - Math.min(1, t * 2.5)) ;
    for (let j = 0; j <= nu; j++) {
      const a = -Math.PI / 2 + (j / nu) * Math.PI;        // port deck edge .. keel .. starboard deck edge
      const x = Math.sin(a) * w, y = keel + (1 - keel) * (1 - Math.cos(a) * 0.98);
      pos.push(x, Math.min(1, y), z);
    }
  }
  for (let i = 0; i < nz; i++) for (let j = 0; j < nu; j++) { const a = i * (nu + 1) + j, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
  // deck lid
  const base = pos.length / 3;
  for (let i = 0; i <= nz; i++) { const k = i * (nu + 1); pos.push(pos[k * 3], 1, pos[k * 3 + 2], pos[(k + nu) * 3], 1, pos[(k + nu) * 3 + 2]); }
  for (let i = 0; i < nz; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g.toNonIndexed();
}

function displaced(g: THREE.BufferGeometry, seed: number, amp: number, freq: number, flatTop = 0): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * freq + seed) * Math.cos(v.z * freq * 1.3 + seed * 2) + Math.sin((v.x + v.y + v.z) * freq * 2.1 + seed * 3) * 0.5 + rnd(seed, Math.round(v.x * 97), Math.round(v.y * 89), Math.round(v.z * 83)) * 0.3;
    const k = 1 + amp * n;
    v.x *= k; v.z *= k; v.y *= 1 + amp * 0.5 * n;
    if (flatTop && v.y > flatTop) v.y = flatTop + (v.y - flatTop) * 0.15;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function mesa(seed: number, taper: number): THREE.BufferGeometry {
  // radial noise polygon extruded with a stepped profile: talus skirt (sunk), cliff, cap rim, slightly domed top
  const na = 56;
  const rad: number[] = [];
  for (let i = 0; i < na; i++) { const a = (i / na) * Math.PI * 2; rad.push(1 + 0.16 * Math.sin(a * 3 + seed) + 0.09 * Math.sin(a * 7 + seed * 2.3) + 0.05 * Math.sin(a * 13 + seed * 5.1) + 0.06 * (rnd(seed, i) - 0.5)); }
  const prof: [number, number][] = [[1.55, -0.25], [1.32, 0.02], [1.12, 0.22], [1.04, 0.32], [1.0 * (1 - taper * 0.3), 0.6], [0.97 * (1 - taper * 0.6), 0.93], [0.9 * (1 - taper * 0.75), 1.0], [0.0, 1.03]];
  const pos: number[] = [], idx: number[] = [];
  for (let j = 0; j < prof.length; j++) for (let i = 0; i < na; i++) {
    const a = (i / na) * Math.PI * 2, r = prof[j][0] * rad[i] * (j >= 4 ? 1 + 0.03 * Math.sin(a * 17 + j) : 1);
    pos.push(Math.cos(a) * r, prof[j][1], Math.sin(a) * r);
  }
  for (let j = 0; j + 1 < prof.length; j++) for (let i = 0; i < na; i++) {
    const a = j * na + i, b = j * na + ((i + 1) % na), c = a + na, d = b + na;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();          // smooth (indexed) normals: no faceted stripes on the cliffs
  return g.toNonIndexed();
}

function arch(seed: number): THREE.BufferGeometry {
  // a natural rock arch: a tube along a noisy parabola (span 1, height 1), thick legs, thinner crown
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16, x = t - 0.5;
    pts.push(new THREE.Vector3(x + 0.03 * Math.sin(t * 9 + seed), Math.max(-0.15, 1 - 4 * x * x) * (1 + 0.05 * Math.sin(t * 13 + seed)) - (i === 0 || i === 16 ? 0.15 : 0), 0.04 * Math.sin(t * 7 + seed * 2)));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, 48, 0.055, 10, false);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const u = Math.min(1, Math.max(0, v.x + 0.5));
    curve.getPointAt(u, c);
    const thick = 1.0 + 1.1 * Math.pow(Math.abs(u - 0.5) * 2, 3);       // legs thicker than the crown
    v.sub(c).multiplyScalar(thick * (1 + 0.15 * Math.sin(u * 40 + seed))).add(c);
    p.setXYZ(i, v.x, v.y, v.z * 1.35);
  }
  g.computeVertexNormals();
  return g.toNonIndexed();
}

function scrub(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const c = new THREE.ConeGeometry(0.18, 0.7 + 0.3 * rnd(7, i), 4);
    c.translate(0, 0.35, 0);
    c.rotateZ((rnd(9, i) - 0.5) * 1.1); c.rotateY(i * 1.3);
    c.translate((rnd(11, i) - 0.5) * 0.5, 0, (rnd(13, i) - 0.5) * 0.5);
    parts.push(c.toNonIndexed());
  }
  const g = mergeGeometries(parts)!;
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------------ world-rules kit shapes
// Unit-sized like the rest (base at y = 0, x / z across +-0.5 unless noted). A part may carry its own colour (aCol: linear
// rgb + weight 1) that overrides the instance's palette material: a ship's cream superstructure over a rust hull, a
// lighthouse's red bands, green palm fronds. Parts without one take the instance material.
type Col = [number, number, number] | null;
function tag(g: THREE.BufferGeometry, col: Col = null): THREE.BufferGeometry {
  const q = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(q.attributes)) if (k !== 'position' && k !== 'normal') q.deleteAttribute(k);
  if (!q.getAttribute('normal')) q.computeVertexNormals();
  const n = q.getAttribute('position').count, c = new Float32Array(n * 4);
  if (col) for (let i = 0; i < n; i++) { c[i * 4] = col[0]; c[i * 4 + 1] = col[1]; c[i * 4 + 2] = col[2]; c[i * 4 + 3] = 1; }
  q.setAttribute('aCol', new THREE.BufferAttribute(c, 4));
  return q;
}
const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts)!;
/** A box from (x0, y0, z0) to (x1, y1, z1). */
const boxAt = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Col = null) =>
  tag(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), col);
/** A cylinder (radius r0 bottom, r1 top) from y0 to y1 at (x, z). */
const cylAt = (x: number, z: number, y0: number, y1: number, r0: number, r1 = r0, seg = 10, col: Col = null) =>
  tag(new THREE.CylinderGeometry(r1, r0, y1 - y0, seg).translate(x, (y0 + y1) / 2, z), col);
/** A thin beam (square section t) from a to b. */
function beam(a: THREE.Vector3, b: THREE.Vector3, t: number, col: Col = null): THREE.BufferGeometry {
  const L = a.distanceTo(b);
  const g = new THREE.BoxGeometry(t, L, t).translate(0, L / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize()));
  return tag(g.translate(a.x, a.y, a.z), col);
}
const V3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const CREAM: Col = [0.62, 0.55, 0.43], SOOT: Col = [0.035, 0.03, 0.028], RED: Col = [0.36, 0.07, 0.04], WHITE: Col = [0.75, 0.72, 0.66];
const BARK: Col = [0.17, 0.11, 0.065], FROND: Col = [0.11, 0.15, 0.045], GLASS: Col = [0.55, 0.42, 0.18];

/** A stranded ocean liner: hull (instance material) + cream superstructure + raked funnels + masts. z = length (bow -z). */
function liner(): THREE.BufferGeometry {
  const h = hull().scale(1, 0.42, 1);
  const P = [tag(h)];
  P.push(boxAt(-0.31, 0.42, -0.27, 0.31, 0.56, 0.22, CREAM), boxAt(-0.25, 0.56, -0.2, 0.25, 0.66, 0.12, CREAM), boxAt(-0.28, 0.66, -0.2, 0.28, 0.72, -0.12, CREAM));
  for (const z of [-0.04, 0.1]) { const f = cylAt(0, z, 0.6, 0.86, 0.05, 0.045, 12, RED); P.push(f, cylAt(0, z, 0.86, 0.95, 0.046, 0.044, 12, SOOT)); }
  P.push(cylAt(0, -0.36, 0.4, 1.0, 0.007, 0.004, 6), cylAt(0, 0.32, 0.4, 0.9, 0.007, 0.004, 6));
  // lifeboats along each side
  for (const sx of [-1, 1]) for (let i = 0; i < 5; i++) P.push(boxAt(sx * 0.3 - 0.02, 0.56, -0.16 + i * 0.07, sx * 0.3 + 0.02, 0.585, -0.12 + i * 0.07, WHITE));
  return merge(P);
}

/** A walker's body (dead trampers): armoured hull, a deck house, a stack and gun stubs (x +-0.5, y 0..1, z +-0.5). */
function walkerBody(): THREE.BufferGeometry {
  const P = [boxAt(-0.5, 0.12, -0.5, 0.5, 0.5, 0.42), tag(new THREE.BoxGeometry(1, 0.2, 0.34).translate(0, 0.2, -0.56)),
    boxAt(-0.42, 0, -0.38, 0.42, 0.14, 0.34), boxAt(-0.3, 0.5, -0.2, 0.3, 0.78, 0.25, CREAM), boxAt(-0.22, 0.78, -0.12, 0.22, 0.88, 0.12, CREAM),
    cylAt(0.12, 0.3, 0.6, 1.0, 0.07, 0.06, 10, SOOT), cylAt(-0.2, -0.38, 0.5, 0.58, 0.09, 0.09, 10)];
  P.push(beam(V3(-0.2, 0.55, -0.38), V3(-0.2, 0.6, -0.72), 0.04), beam(V3(0.25, 0.55, 0.35), V3(0.3, 0.58, 0.7), 0.035));
  for (let i = 0; i < 6; i++) P.push(boxAt(-0.52, 0.18 + i * 0.05, -0.45, 0.52, 0.19 + i * 0.05, 0.4, SOOT));   // armour seams
  return merge(P);
}

/** A walker leg, bent: hip at the origin, knee up and out (+x), foot down at (1, 0): thigh + shin + ram + foot pad. */
function leg(): THREE.BufferGeometry {
  const hip = V3(0, 0.15, 0), knee = V3(0.45, 0.78, 0), foot = V3(0.95, 0.04, 0);
  return merge([beam(hip, knee, 0.09), beam(knee, foot, 0.07), beam(V3(0.08, 0.3, 0.05), V3(0.5, 0.62, 0.05), 0.03, SOOT),
    cylAt(0.95, 0, 0, 0.06, 0.12, 0.1, 10), cylAt(0.45, 0, 0.74, 0.82, 0.07, 0.07, 10)]);
}

/** A lattice pylon: four tapering corner posts, X braces on every face, a crossarm. */
function lattice(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const c = (y: number) => 0.5 - 0.36 * y;
  const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]];
  for (const [sx, sz] of corners) P.push(beam(V3(sx * 0.5, 0, sz * 0.5), V3(sx * 0.14, 1, sz * 0.14), 0.025));
  const lv = [0, 0.22, 0.42, 0.6, 0.76, 0.9];
  for (let k = 0; k + 1 < lv.length; k++) {
    const y0 = lv[k], y1 = lv[k + 1], a = c(y0), b = c(y1);
    for (let f = 0; f < 4; f++) {
      const [x0, z0] = corners[f], [x1, z1] = corners[(f + 1) % 4];
      P.push(beam(V3(x0 * a, y0, z0 * a), V3(x1 * b, y1, z1 * b), 0.012), beam(V3(x1 * a, y0, z1 * a), V3(x0 * b, y1, z0 * b), 0.012));
      P.push(beam(V3(x0 * b, y1, z0 * b), V3(x1 * b, y1, z1 * b), 0.014));
    }
  }
  P.push(boxAt(-0.75, 0.9, -0.03, 0.75, 0.93, 0.03), boxAt(-0.5, 0.97, -0.025, 0.5, 1.0, 0.025));
  for (const x of [-0.7, -0.35, 0.35, 0.7]) P.push(cylAt(x, 0, 0.84, 0.9, 0.015, 0.015, 6, SOOT));
  return merge(P);
}

/** A lattice truss (a gantry's span): x = length (+-0.5), y 0..1, z +-0.5. */
function truss(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  for (const y of [0, 1]) for (const z of [-0.5, 0.5]) P.push(beam(V3(-0.5, y, z), V3(0.5, y, z), 0.05));
  const n = 10;
  for (let i = 0; i < n; i++) {
    const x0 = -0.5 + i / n, x1 = x0 + 1 / n;
    for (const z of [-0.5, 0.5]) P.push(beam(V3(x0, 0, z), V3(x1, 1, z), 0.025), beam(V3(x1, 0, z), V3(x1, 1, z), 0.025));
    P.push(beam(V3(x1, 1, -0.5), V3(x1, 1, 0.5), 0.02), beam(V3(x0, 0, -0.5), V3(x1, 0, 0.5), 0.02));
  }
  return merge(P);
}

/** An industrial chimney: tapering, banded, a sooty crown. */
function chimney(): THREE.BufferGeometry {
  return merge([cylAt(0, 0, 0, 1, 0.5, 0.33, 14), cylAt(0, 0, 0.3, 0.32, 0.465, 0.465, 14, SOOT), cylAt(0, 0, 0.62, 0.64, 0.42, 0.42, 14, SOOT),
    cylAt(0, 0, 0.88, 1.0, 0.36, 0.34, 14, SOOT), cylAt(0, 0, 0.995, 1.02, 0.37, 0.37, 14, SOOT), cylAt(0, 0, 0, 0.04, 0.58, 0.56, 14)]);
}

/** A telegraph pole: post, crossarm, insulators (height 1; scale ~8 m). */
function pole(): THREE.BufferGeometry {
  return merge([cylAt(0, 0, 0, 1, 0.018, 0.013, 6), boxAt(-0.14, 0.9, -0.012, 0.14, 0.925, 0.012), cylAt(-0.11, 0, 0.925, 0.95, 0.008, 0.008, 5, WHITE),
    cylAt(0.11, 0, 0.925, 0.95, 0.008, 0.008, 5, WHITE), cylAt(0, 0, 0.995, 1.015, 0.008, 0.008, 5, WHITE), beam(V3(0, 0.82, 0), V3(-0.1, 0.905, 0), 0.008)]);
}

/** A date palm: a leaning, segmented trunk and a crown of drooping fronds. */
function palm(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const pt = (t: number) => V3(0.14 * t * t, 0.86 * t, 0);
  for (let i = 0; i < 7; i++) P.push(beam(pt(i / 7), pt((i + 1) / 7), 0.045 - 0.012 * (i / 7), BARK));
  const top = pt(1);
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.3, len = 0.32 + 0.08 * Math.sin(k * 2.7);
    const mid = top.clone().add(V3(Math.cos(a) * len * 0.55, 0.07, Math.sin(a) * len * 0.55)), tip = top.clone().add(V3(Math.cos(a) * len, -0.1, Math.sin(a) * len));
    for (const [p0, p1] of [[top, mid], [mid, tip]] as const) {
      const d = p1.clone().sub(p0), L = d.length();
      const g = new THREE.PlaneGeometry(0.075, L).translate(0, L / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize()));
      P.push(tag(g.translate(p0.x, p0.y, p0.z), FROND));
    }
  }
  return merge(P);
}

/** A canyon wall slab: wide (x), tall (y), shallow (z); vertical fluting, a ragged top, a sunk talus foot. */
function cliff(seed: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 0.45, 16, 10, 3).translate(0, 0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // broad buttresses (a few per slab, not stripes), a ragged rounded top, a battered (sloping) face and a talus foot
    const rib = Math.sin(x * 9 + seed + Math.sin(y * 2.3) * 0.8) * 0.04 + Math.sin(x * 4.1 + seed * 2) * 0.05;
    const top = y > 0.9 ? (Math.sin(x * 7 + seed) * 0.08 + Math.sin(x * 17 + seed * 3) * 0.03) * (y - 0.9) * 10 : 0;
    const batter = (1 - y) * 0.22, flare = (1 - y) ** 3 * 0.3;
    const zs = z > 0 ? 1 : -1;
    p.setXYZ(i, x * (1 + flare * 0.1), y + top, z * (0.7 + batter + flare) + rib * zs * (0.5 + 0.5 * y) - (y > 0.85 ? zs * (y - 0.85) * 0.4 : 0));
  }
  g.computeVertexNormals();             // smooth across each face grid: no faceted stripes
  return tag(g.toNonIndexed());
}

/** A hoodoo: a slim eroded column with a hard cap rock. */
function hoodoo(): THREE.BufferGeometry {
  const col = displaced(new THREE.CylinderGeometry(0.2, 0.3, 0.86, 10, 6).translate(0, 0.43, 0).toNonIndexed(), 4.3, 0.16, 9.5);
  const cap = displaced(new THREE.SphereGeometry(0.42, 10, 6).scale(1, 0.32, 1).translate(0, 0.9, 0).toNonIndexed(), 7.1, 0.12, 6);
  return merge([tag(col), tag(cap)]);
}

/** A lighthouse: banded tapering tower, gallery, lantern, cap (height 1). */
function lighthouse(): THREE.BufferGeometry {
  const P: THREE.BufferGeometry[] = [];
  const r = (y: number) => 0.5 - 0.2 * (y / 0.78);
  for (let k = 0; k < 6; k++) { const y0 = (k / 6) * 0.78, y1 = ((k + 1) / 6) * 0.78; P.push(cylAt(0, 0, y0, y1, r(y0), r(y1), 14, k % 2 ? RED : WHITE)); }
  P.push(cylAt(0, 0, 0.78, 0.8, 0.42, 0.42, 14, SOOT), cylAt(0, 0, 0.8, 0.92, 0.22, 0.22, 12, GLASS), tag(new THREE.ConeGeometry(0.26, 0.1, 12).translate(0, 0.97, 0), SOOT));
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; P.push(beam(V3(Math.cos(a) * 0.4, 0.8, Math.sin(a) * 0.4), V3(Math.cos(a) * 0.4, 0.85, Math.sin(a) * 0.4), 0.01, SOOT)); }
  return merge(P);
}

/** A dead tree: a twisted trunk and a few bare limbs. */
function deadTree(): THREE.BufferGeometry {
  const P = [beam(V3(0, 0, 0), V3(0.05, 0.5, 0.02), 0.07), beam(V3(0.05, 0.5, 0.02), V3(-0.02, 0.72, 0), 0.05)];
  const limbs: [number, number, number, number][] = [[0.05, 0.45, 0.35, 0.82], [0.02, 0.6, -0.32, 0.95], [-0.02, 0.72, 0.12, 1.0], [0.04, 0.3, -0.25, 0.48]];
  for (const [x0, y0, x1, y1] of limbs) P.push(beam(V3(x0, y0, 0), V3(x1, y1, (x1 - x0) * 0.4), 0.03));
  return merge(P);
}

/** One aqueduct bay: two piers, the arch between them, the deck (x +-0.5, y 0..1.05). */
function arcade(): THREE.BufferGeometry {
  const arc = new THREE.TorusGeometry(0.31, 0.09, 6, 14, Math.PI).translate(0, 0.62, 0).scale(1, 1, 1.6);
  return merge([boxAt(-0.5, 0, -0.16, -0.32, 0.64, 0.16), boxAt(0.32, 0, -0.16, 0.5, 0.64, 0.16), tag(arc), boxAt(-0.5, 0.86, -0.17, 0.5, 1.0, 0.17), boxAt(-0.52, 1.0, -0.19, 0.52, 1.05, 0.19)]);
}

/** A storage tank: drum, domed roof, a band, a ladder. */
function tank(): THREE.BufferGeometry {
  return merge([cylAt(0, 0, 0, 0.82, 0.5, 0.5, 18), tag(new THREE.SphereGeometry(0.5, 18, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.3, 1).translate(0, 0.82, 0)),
    cylAt(0, 0, 0.4, 0.43, 0.505, 0.505, 18, SOOT), boxAt(0.49, 0, -0.02, 0.53, 0.9, 0.02, SOOT)]);
}

/** A gable / pediment prism: triangle in x-y (base 1, height 1), length z. */
function prism(): THREE.BufferGeometry {
  const sh = new THREE.Shape([new THREE.Vector2(-0.5, 0), new THREE.Vector2(0.5, 0), new THREE.Vector2(0, 1)]);
  return tag(new THREE.ExtrudeGeometry(sh, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5));
}

/** An I-beam girder along y (0..1): two flanges + the web. */
function girder(): THREE.BufferGeometry {
  return merge([boxAt(-0.5, 0, 0.38, 0.5, 1, 0.5), boxAt(-0.5, 0, -0.5, 0.5, 1, -0.38), boxAt(-0.07, 0, -0.38, 0.07, 1, 0.38)]);
}

export function makeShape(s: Shape): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (s) {
    case 'box': g = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0); break;
    case 'dome': g = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 2, 1); break;
    case 'cyl': g = new THREE.CylinderGeometry(0.5, 0.5, 1, 12).translate(0, 0.5, 0); break;
    case 'cone': g = new THREE.ConeGeometry(0.5, 1, 8).translate(0, 0.5, 0); break;
    case 'hull': g = hull(); break;
    case 'rock': g = displaced(new THREE.IcosahedronGeometry(0.5, 2).translate(0, 0.3, 0), 3.1, 0.22, 5.5); break;
    case 'crag': g = displaced(new THREE.CylinderGeometry(0.42, 0.55, 1, 9, 4).translate(0, 0.5, 0).toNonIndexed(), 5.7, 0.18, 6.5, 0.92); break;
    case 'arch': g = arch(1.7); break;
    case 'rib': g = new THREE.TorusGeometry(0.5, 0.05, 6, 18, Math.PI).rotateZ(0).translate(0, 0, 0); break;
    case 'mesa': g = mesa(2.2, 0); break;
    case 'spire': g = mesa(4.9, 0.85); break;
    case 'scrub': g = scrub(); break;
    case 'liner': g = liner(); break;
    case 'walkerbody': g = walkerBody(); break;
    case 'leg': g = leg(); break;
    case 'lattice': g = lattice(); break;
    case 'truss': g = truss(); break;
    case 'chimney': g = chimney(); break;
    case 'pole': g = pole(); break;
    case 'palm': g = palm(); break;
    case 'cliff': g = cliff(3.3); break;
    case 'hoodoo': g = hoodoo(); break;
    case 'lighthouse': g = lighthouse(); break;
    case 'deadtree': g = deadTree(); break;
    case 'arcade': g = arcade(); break;
    case 'tank': g = tank(); break;
    case 'prism': g = prism(); break;
    case 'girder': g = girder(); break;
  }
  if (g.index) g = g.toNonIndexed();
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  // keep only what the material reads (+ a zero part colour where the shape has none)
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'aCol') g.deleteAttribute(k);
  if (!g.getAttribute('aCol')) g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 4), 4));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ material
const VS = /* glsl */ `
precision highp float;
${DESERT_UNIFORMS}
${COMPRESS_GLSL}
in vec4 aKit;       // material, tint, window density, compressed (0/1)
in vec3 aAnchor;    // compression anchor (terrain-local)
in vec4 aCol;       // part colour (linear rgb, weight): overrides the palette material on that part
varying vec4 vCol;
varying vec3 vPt;   // TRUE terrain-local position (fog, strata)
varying vec3 vNt;
varying vec3 vObj;
varying vec4 vKit;
varying vec3 vScale;
void main() {
  vec4 pt = instanceMatrix * vec4(position, 1.0);
  mat3 m3 = mat3(instanceMatrix);
  vNt = normalize(inverse(transpose(m3)) * normal);
  vScale = vec3(length(m3[0]), length(m3[1]), length(m3[2]));
  vPt = pt.xyz;
  vObj = position;
  vKit = aKit;
  vCol = aCol;
  vec3 p = pt.xyz;
  if (aKit.w > 0.5) {
    float D = max(1.0, length(aAnchor.xz - uCamT.xz));
    float k = dCompress(D) / D;
    p = uCamT + (p - uCamT) * k;
    p.y -= dDrop(D) * k;
    // heat shimmer: far silhouettes near the ground waver in the rising air (clear, hot, daytime; none in a storm)
    float shim = uDayK * (1.0 - uStorm) * smoothstep(1500.0, 6000.0, D) * (1.0 - smoothstep(0.0, 140.0, pt.y - aAnchor.y));
    p.x += shim * k * 1.6 * sin(uTime * 5.3 + pt.y * 0.21 + pt.z * 0.013);
    p.y += shim * k * 0.9 * sin(uTime * 3.7 + pt.x * 0.017);
  }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FS = /* glsl */ `
precision highp float; precision highp int; precision highp sampler2DArray;
${DESERT_UNIFORMS}
uniform highp sampler2DArray uH;
uniform vec4 uClip[${CLIP_LEVELS}];
uniform vec3 uPal[${PAL_N}];
uniform vec3 uWin;            // window colour (warm)
uniform float uPack;
varying vec3 vPt;
varying vec3 vNt;
varying vec3 vObj;
varying vec4 vKit;
varying vec3 vScale;
varying vec4 vCol;
${NOISE_GLSL}
${SHADE_GLSL}
${CLIP_DECODE_GLSL}
float groundH(vec2 p) {
  for (int l = 0; l < ${CLIP_LEVELS}; l++) {
    vec4 c = uClip[l];
    vec2 t = (p - c.xy) * c.w;
    if (all(greaterThan(t, vec2(2.0))) && all(lessThan(t, vec2(${CLIP_RES - 3}.0)))) {
      ivec2 i = ivec2(floor(t)); vec2 f = t - vec2(i);
      float a = clipHd(texelFetch(uH, ivec3(i, l), 0)), b = clipHd(texelFetch(uH, ivec3(i + ivec2(1, 0), l), 0));
      float d = clipHd(texelFetch(uH, ivec3(i + ivec2(0, 1), l), 0)), e = clipHd(texelFetch(uH, ivec3(i + ivec2(1, 1), l), 0));
      return mix(mix(a, b, f.x), mix(d, e, f.x), f.y);
    }
  }
  return -1e4;
}
void main() {
  vec3 N = normalize(vNt);
  if (!gl_FrontFacing) N = -N;
  int mat = int(vKit.x + 0.5);
  vec3 alb = uPal[mat];
  float tint = vKit.y;
  alb *= 0.86 + 0.28 * tint;
  alb = mix(alb, vCol.rgb * (0.9 + 0.2 * tint), vCol.a);
  vec3 p = vPt;
  vec2 pw = p.xz + uAnc.xy;                 // world mod 4096 m (anchored patterns)
  float dist = length(p - uCamT);
  // stone: strata bands by world height + darker cliffs, paler caps
  if (mat == 1) {
    float band = sin(p.y * 0.42 + wvn(wq(pw, ${wn(0.002)}), ${wn(0.002)}, 31u) * 1.2) * 0.5 + 0.5;
    float band2 = sin(p.y * 1.7 + wvn(wq(pw, ${wn(0.01)}), ${wn(0.01)}, 32u) * 0.8) * 0.5 + 0.5;
    alb *= 0.82 + 0.22 * band + 0.08 * band2;
    alb = mix(alb, alb * vec3(1.12, 0.92, 0.8), smoothstep(0.6, 0.95, band) * 0.6);
    alb = mix(alb, uPal[0] * 1.05, smoothstep(0.75, 0.95, N.y) * 0.55);       // sand-dusted tops
  }
  if (mat == 2 || mat == 8 || mat == 11) alb *= 0.8 + 0.4 * wvn(wq(pw, ${wn(0.3)}) + p.y, ${wn(0.3)}, 33u);   // rust blotches
  if (mat == 11) alb = mix(alb, uPal[2], smoothstep(0.45, 0.8, wvn(wq(pw, ${wn(0.08)}) + p.y * 0.2, ${wn(0.08)}, 35u)));   // paint flaking to rust
  // windows: a grid on vertical faces; each window lights at its own darkness (some stay dark, some go out late)
  vec3 emit = vec3(0.0);
  if (vKit.z > 0.01 && abs(N.y) < 0.5) {
    vec2 f = vec2((abs(N.x) > abs(N.z) ? vObj.z * vScale.z : vObj.x * vScale.x), vObj.y * vScale.y);
    vec2 cell = floor(f / vec2(3.2, 3.6));
    vec2 inC = fract(f / vec2(3.2, 3.6));
    float win = step(0.3, inC.x) * step(inC.x, 0.7) * step(0.35, inC.y) * step(inC.y, 0.75) * step(1.0, vObj.y * vScale.y);
    // which windows light: hashed per wall cell and per ~10 m world cell (world-anchored)
    float h = whf(ivec2(cell) + 1024, wh32(wwrap(floor(wq(pw, ${wn(0.1)})), ${wn(0.1)}), 0x51u));
    float on = step(h, vKit.z * 0.75) * smoothstep(0.2 + 0.6 * fract(h * 13.7), 0.3 + 0.6 * fract(h * 13.7), uDark);
    alb = mix(alb, alb * 0.45, win * 0.7);
    // far away a window is sub-pixel: the wall shows the AVERAGE lit fraction instead of aliasing to black
    float farK = smoothstep(500.0, 2500.0, dist);
    float avgOn = vKit.z * 0.75 * 0.24 * smoothstep(0.2, 0.7, uDark);
    emit = uWin * mix(win * on * (0.75 + 0.5 * fract(h * 7.3)), avgOn * 1.4, farK) * (1.0 - uStorm * 0.5);
  }
  // sand drifts at the base (near, uncompressed things only)
  if (vKit.w < 0.5 && dist < 900.0) {
    float g = groundH(p.xz);
    float drift = 0.5 + 1.2 * wvn(wq(pw, ${wn(0.25)}), ${wn(0.25)}, 34u) + 1.5 * smoothstep(0.3, 0.9, N.y);
    float k = 1.0 - smoothstep(g + drift * 0.4, g + drift, p.y);
    alb = mix(alb, uPal[0], k * (1.0 - smoothstep(600.0, 900.0, dist)));
  }
  float ao = 0.75 + 0.25 * smoothstep(0.0, 6.0, p.y - (vPt.y - vObj.y * vScale.y));
  alb = mix(alb, vec3(dot(alb, vec3(0.3, 0.59, 0.11))) * vec3(0.78, 0.88, 1.12), (1.0 - uDayK) * 0.55);
  vec3 col = dLight(alb, N, 1.0, ao);
  col += alb * dFireLight(p, N);
  col += emit;
  // rim of haze light on silhouettes against a low sun
  vec3 V = normalize(uCamT - p);
  col += uHazeSun * pow(1.0 - max(dot(N, V), 0.0), 3.0) * pow(max(dot(-V, uSunT), 0.0), 3.0) * 0.25;
  col = dApplyFog(col, uCamT, p);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export interface KitInstance { shape: Shape; m: THREE.Matrix4; mat: number; tint: number; emit: number; compressed: boolean; anchor: THREE.Vector3 }

/** The solid pieces a layer has placed (terrain-local, uncompressed only): an oriented box per piece (the inverse of its
 *  instance matrix + its shape's unit bounds) and a bounding sphere for a quick reject. Cameras keep out of them. */
export interface KitSolids { n: number; inv: Float32Array; box: Float32Array; sphere: Float32Array; geo?: (THREE.BufferGeometry | null)[] }
const SOLID_TM = new THREE.Matrix4(), SOLID_TB = new THREE.Box3(), SOLID_TS = new THREE.Sphere();
/** Shapes whose box is a fair stand-in for the piece; every other shape (arches, ribs, lattices, cliffs, mesas, hulls,
 *  trees...) is tested against its own triangles once its box is hit (a lens under an arch, between ribs or in front of
 *  a cliff face is not inside them: a cliff's box is 150 m of mostly air). */
const BOXY = new Set<string>(['box', 'cyl', 'cone', 'dome', 'rock', 'crag', 'tank', 'prism', 'chimney']);
/** one geometry per shape for the solid tests (built on first use, never drawn) */
const SOLID_SHAPES = new Map<string, THREE.BufferGeometry>();
function solidShape(s: Shape): THREE.BufferGeometry {
  let g = SOLID_SHAPES.get(s);
  if (!g) { g = makeShape(s); g.computeBoundingBox(); SOLID_SHAPES.set(s, g); }
  return g;
}
/** Pieces placed in WORLD coordinates (shape, position, rotation, scale) -> solids (reusing `S`'s buffers). Pure. */
export function partsSolids(parts: readonly { shape: Shape; x: number; y: number; z: number; q: THREE.Quaternion; s: THREE.Vector3 }[], S: KitSolids): KitSolids {
  if (S.inv.length < parts.length * 16) { S.inv = new Float32Array(parts.length * 16); S.box = new Float32Array(parts.length * 6); S.sphere = new Float32Array(parts.length * 4); }
  S.n = 0; S.geo = S.geo ?? []; S.geo.length = 0;
  for (const p of parts) {
    if (p.shape === 'scrub') continue;                                   // (a bush is no wall)
    const g = solidShape(p.shape), bb = g.boundingBox!, j = S.n++;
    SOLID_TM.compose(SOLID_V.set(p.x, p.y, p.z), p.q, p.s);
    SOLID_TB.copy(bb).applyMatrix4(SOLID_TM).getBoundingSphere(SOLID_TS);
    S.inv.set(SOLID_TM.invert().elements, j * 16);
    S.box.set([bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z], j * 6);
    S.sphere[j * 4] = SOLID_TS.center.x; S.sphere[j * 4 + 1] = SOLID_TS.center.y; S.sphere[j * 4 + 2] = SOLID_TS.center.z; S.sphere[j * 4 + 3] = SOLID_TS.radius;
    S.geo[j] = BOXY.has(p.shape) ? null : g;
  }
  return S;
}
const SOLID_V = new THREE.Vector3();
const SOLID_MESH = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
const SOLID_RC = new THREE.Raycaster(), SOLID_HITS: THREE.Intersection[] = [];
const SA = new THREE.Vector3(), SB = new THREE.Vector3(), SD = new THREE.Vector3(), SN1 = new THREE.Vector3(), SN2 = new THREE.Vector3();
/** a local segment a..b through the piece's own triangles (or, from a, an odd number of crossings straight up: inside) */
function meshHit(g: THREE.BufferGeometry, a: THREE.Vector3, b: THREE.Vector3, inside: boolean): boolean {
  SOLID_MESH.geometry = g;
  SOLID_MESH.updateMatrixWorld();
  const L = SD.copy(b).sub(a).length();
  if (L > 1e-9) {
    SOLID_RC.set(a, SD.divideScalar(L)); SOLID_RC.near = 0; SOLID_RC.far = L;
    SOLID_HITS.length = 0; SOLID_MESH.raycast(SOLID_RC, SOLID_HITS);
    if (SOLID_HITS.length) return true;
  }
  if (!inside) return false;
  SOLID_RC.set(a, SD.set(0, 1, 0)); SOLID_RC.near = 0; SOLID_RC.far = 1e6;
  SOLID_HITS.length = 0; SOLID_MESH.raycast(SOLID_RC, SOLID_HITS);
  return SOLID_HITS.length % 2 === 1;
}
/** Does the segment a..b (terrain-local) pass through a piece, or come within `pad` m of its box? (a point: a === b) */
export function solidHit(S: KitSolids, ax: number, ay: number, az: number, bx: number, by: number, bz: number, pad = 0): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az, L2 = dx * dx + dy * dy + dz * dz;
  for (let i = 0; i < S.n; i++) {
    const s = i * 4, cx = S.sphere[s], cy = S.sphere[s + 1], cz = S.sphere[s + 2], r = S.sphere[s + 3] + pad;
    // (quick reject: the segment's closest approach to the bounding sphere)
    let t = L2 > 1e-9 ? ((cx - ax) * dx + (cy - ay) * dy + (cz - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + dx * t - cx, qy = ay + dy * t - cy, qz = az + dz * t - cz;
    if (qx * qx + qy * qy + qz * qz > r * r) continue;
    // the box in the piece's own frame (unit shape bounds), the segment through its inverse matrix; pad in world metres
    // over the piece's scale (columns of the inverse = 1 / scale along each local axis)
    const e = S.inv, o = i * 16, B = S.box, k = i * 6;
    const lx = (x: number, y: number, z: number) => e[o] * x + e[o + 4] * y + e[o + 8] * z + e[o + 12];
    const ly = (x: number, y: number, z: number) => e[o + 1] * x + e[o + 5] * y + e[o + 9] * z + e[o + 13];
    const lz = (x: number, y: number, z: number) => e[o + 2] * x + e[o + 6] * y + e[o + 10] * z + e[o + 14];
    const p0 = [lx(ax, ay, az), ly(ax, ay, az), lz(ax, ay, az)], p1 = [lx(bx, by, bz), ly(bx, by, bz), lz(bx, by, bz)];
    const sc = [Math.hypot(e[o], e[o + 4], e[o + 8]), Math.hypot(e[o + 1], e[o + 5], e[o + 9]), Math.hypot(e[o + 2], e[o + 6], e[o + 10])];
    let t0 = 0, t1 = 1, hit = true;
    for (let ax3 = 0; ax3 < 3 && hit; ax3++) {
      const lo = B[k + ax3] - pad * sc[ax3], hi = B[k + 3 + ax3] + pad * sc[ax3], p = p0[ax3], d = p1[ax3] - p;
      if (Math.abs(d) < 1e-12) { if (p < lo || p > hi) hit = false; continue; }
      let ta = (lo - p) / d, tb = (hi - p) / d;
      if (ta > tb) { const x = ta; ta = tb; tb = x; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) hit = false;
    }
    if (!hit) continue;
    const g = S.geo?.[i];
    if (!g) return true;
    // (the piece's own triangles, in its own frame: the segment - with a pad, also the four parallel segments `pad` m
    // off it, so a thin rib or a small rock beside the path counts - or for a point with a pad three pad-long crosses
    // through it, plus the inside test)
    const L = (x: number, y: number, z: number, out: THREE.Vector3) => out.set(lx(x, y, z), ly(x, y, z), lz(x, y, z));
    if (L2 > 1e-9) {
      if (meshHit(g, L(ax, ay, az, SA), L(bx, by, bz, SB), false)) return true;
      if (pad > 0) {
        const n1 = SN1.set(dx, dy, dz).normalize(), n2 = SN2.set(0, 1, 0);
        if (Math.abs(n1.y) > 0.9) n2.set(1, 0, 0);
        n2.cross(n1).normalize(); n1.cross(n2).normalize();          // (n1, n2: perpendicular to the segment and each other)
        for (const [p, q] of [[n1, 1], [n1, -1], [n2, 1], [n2, -1]] as [THREE.Vector3, number][]) {
          const ox = p.x * pad * q, oy = p.y * pad * q, oz = p.z * pad * q;
          if (meshHit(g, L(ax + ox, ay + oy, az + oz, SA), L(bx + ox, by + oy, bz + oz, SB), false)) return true;
        }
      }
      continue;
    }
    if (pad <= 0) { if (meshHit(g, L(ax, ay, az, SA), L(bx, by, bz, SB), true)) return true; continue; }
    if (meshHit(g, L(ax - pad, ay, az, SA), L(ax + pad, ay, az, SB), false) || meshHit(g, L(ax, ay - pad, az, SA), L(ax, ay + pad, az, SB), false)
      || meshHit(g, L(ax, ay, az - pad, SA), L(ax, ay, az + pad, SB), false) || meshHit(g, L(ax, ay, az, SA), L(ax, ay, az, SB), true)) return true;
  }
  return false;
}

/** One InstancedMesh per shape, sharing one material. fill() rewrites everything (callers do it only when their
 *  active set changes: camera cell, origin rebase, quality). */
export class KitLayer {
  readonly group = new THREE.Group();
  readonly material: THREE.ShaderMaterial;
  private meshes = new Map<Shape, { mesh: THREE.InstancedMesh; kit: THREE.InstancedBufferAttribute; anchor: THREE.InstancedBufferAttribute; cap: number }>();
  counts: Record<string, number> = {};
  /** the solid pieces placed by the last fill() (terrain-local; cameras keep out of them) */
  /** The placed pieces as solids for camera plans. A new object on every fill, never written after: a plan in flight
   *  (DesertWorld.solidSet) keeps the set it started with when the layer refills under it. */
  solids: KitSolids = { n: 0, inv: new Float32Array(0), box: new Float32Array(0), sphere: new Float32Array(0) };

  constructor(name: string, du: DesertUniforms, clip: HeightClipmap, caps: Partial<Record<Shape, number>>) {
    const pal = ['#d6a466', '#b77850', '#6e4a36', '#e7dcc6', '#d8c8a8', '#7a5638', '#e9dfcc', '#8a8048', '#4d4038', '#efe8da', '#5d6a32', '#8e4434'].map((h) => new THREE.Color(h));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, fog: false, lights: false,
      uniforms: { ...du, uH: clip.hTexU, uPack: clip.packU, uClip: clip.clipU, uPal: { value: pal }, uWin: { value: new THREE.Color('#ffb25a').multiplyScalar(1.6) } },
    });
    this.material.name = `vtp:desert:kit:${name}`;
    this.group.name = `vtp:desert:${name}`;
    for (const s of SHAPES) {
      const cap = caps[s] ?? 0;
      if (!cap) continue;
      const g = makeShape(s);
      // (the camera planner's solid tests share the drawn geometry: no second build of the shape)
      if (!SOLID_SHAPES.has(s)) { g.computeBoundingBox(); SOLID_SHAPES.set(s, g); }
      const kit = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      const anchor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      g.setAttribute('aKit', kit); g.setAttribute('aAnchor', anchor);
      const mesh = new THREE.InstancedMesh(g, this.material, cap);
      mesh.name = `vtp:desert:${name}:${s}`;
      mesh.frustumCulled = false;        // positions are compressed in the shader
      // three sorts opaque objects by the projected centre of InstancedMesh.boundingSphere, which it computes ONCE from
      // whatever instances the mesh held then: a history-dependent draw order (two pages that reached the same set by
      // different paths drew overlapping kit pieces in a different order). A fixed sphere keeps the order = creation order.
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
      mesh.count = 0;
      mesh.visible = false;
      mesh.renderOrder = 5;
      this.group.add(mesh);
      this.meshes.set(s, { mesh, kit, anchor, cap });
    }
  }

  fill(list: KitInstance[]) {
    const n = new Map<Shape, number>();
    // (the solids of the uncompressed pieces only: a layer of compressed pieces - the walkers, filled every frame - keeps
    // its one empty set and allocates nothing)
    let ns = 0;
    for (const it of list) if (!it.compressed) ns++;
    const S: KitSolids = ns === 0 && this.solids.n === 0 ? this.solids
      : { n: 0, inv: new Float32Array(ns * 16), box: new Float32Array(ns * 6), sphere: new Float32Array(ns * 4), geo: [] };
    this.solids = S;
    for (const it of list) {
      const M = this.meshes.get(it.shape);
      if (!M) continue;
      const i = n.get(it.shape) ?? 0;
      if (i >= M.cap) continue;
      if (!it.compressed) {
        const g = M.mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const j = S.n++;
        S.geo![j] = BOXY.has(it.shape) ? null : g;
        S.inv.set(SOLID_TM.copy(it.m).invert().elements, j * 16);
        const bb = g.boundingBox!;
        S.box.set([bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z], j * 6);
        SOLID_TB.copy(bb).applyMatrix4(it.m).getBoundingSphere(SOLID_TS);
        S.sphere[j * 4] = SOLID_TS.center.x; S.sphere[j * 4 + 1] = SOLID_TS.center.y; S.sphere[j * 4 + 2] = SOLID_TS.center.z; S.sphere[j * 4 + 3] = SOLID_TS.radius;
      }
      M.mesh.setMatrixAt(i, it.m);
      M.kit.setXYZW(i, it.mat, it.tint, it.emit, it.compressed ? 1 : 0);
      M.anchor.setXYZ(i, it.anchor.x, it.anchor.y, it.anchor.z);
      n.set(it.shape, i + 1);
    }
    this.counts = {};
    for (const [s, M] of this.meshes) {
      const c = n.get(s) ?? 0;
      M.mesh.count = c; M.mesh.visible = c > 0;
      M.mesh.instanceMatrix.needsUpdate = true; M.kit.needsUpdate = true; M.anchor.needsUpdate = true;
      if (c) this.counts[s] = c;
    }
  }

  get draws() { let d = 0; for (const M of this.meshes.values()) if (M.mesh.visible) d++; return d; }

  dispose() { for (const M of this.meshes.values()) { M.mesh.geometry.dispose(); M.mesh.dispose(); } this.material.dispose(); }
}
