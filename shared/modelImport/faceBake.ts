// Make a model's own modelled eyes blink: blink morph targets baked into the GLB the import saves. The eyes are the
// primitives whose material the face check found the eyes made of (src/avatar/faceFeatures.ts). For each side (the
// character's left / right of the eyes' middle) every eye vertex is squashed toward that eye's centre along the model's
// up axis (to 8 %): a closed eye reads as a line, like a drawn lid. Named blink + blinkLeft / blinkRight (the studio's
// own blink keys, shared/morphNames.ts), so tracking drives them with no setup. Pure: tests in tools/model_import_unit.ts.
import { mul, readAccessor, worldMatrices, type GltfDoc, type Json, type Mat4 } from './gltf.ts';

const SQUASH = 0.08;

/** The local-space vector that the bind matrix maps to the file-space up axis (0, 1, 0): column 1 of the inverse of
 *  its 3×3 part. */
function localUp(m: Mat4): [number, number, number] {
  const A = (r: number, c: number) => m[c * 4 + r];
  const a = A(0, 0), b = A(0, 1), c = A(0, 2), d = A(1, 0), e = A(1, 1), f = A(1, 2), g = A(2, 0), h = A(2, 1), i = A(2, 2);
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1;
  // inverse column 1 = (-(b*i - c*h), a*i - c*g, -(a*h - b*g)) / det
  return [-(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det];
}

/** Adds blinkLeft / blinkRight (or one blink) targets to the meshes using `materialNames`. `leftIsPlusX`: the model's left
 *  is +x in the file (it faces +z); false when it is stored facing away. Returns the names added, or [] when nothing
 *  matched (the doc is unchanged then). Mutates doc (json + one appended buffer). */
export function bakeBlink(doc: GltfDoc, materialNames: readonly string[], leftIsPlusX = true): string[] {
  const json = doc.json;
  const mats: Json[] = Array.isArray(json.materials) ? json.materials : [];
  const want = new Set(mats.map((m, i) => (materialNames.includes(String(m?.name ?? '')) ? i : -1)).filter((i) => i >= 0));
  if (!want.size) return [];
  const nodes: Json[] = json.nodes ?? [], meshes: Json[] = json.meshes ?? [], skins: Json[] = json.skins ?? [];
  const { world } = worldMatrices(json);
  // the bind matrix (vertex → file space) of each mesh: its node, or a skin's first joint × inverse bind
  const bind = new Map<number, Mat4>();
  nodes.forEach((n, ni) => {
    if (typeof n?.mesh !== 'number' || bind.has(n.mesh)) return;
    let M = world[ni];
    const sk = typeof n.skin === 'number' ? skins[n.skin] : null;
    if (sk?.joints?.length) {
      const ibm = typeof sk.inverseBindMatrices === 'number' ? readAccessor(doc, sk.inverseBindMatrices, 1)?.data : null;
      M = ibm ? mul(world[sk.joints[0]], Float64Array.from(ibm.subarray(0, 16))) : world[sk.joints[0]];
    }
    bind.set(n.mesh, M);
  });
  // every eye vertex in file space, to find the middle and the two eyes
  type P = { mesh: number; prim: number; data: Float32Array; count: number; M: Mat4 };
  const prims: P[] = [];
  meshes.forEach((m, mi) => (m?.primitives ?? []).forEach((p: Json, pi: number) => {
    if (!want.has(p?.material) || typeof p?.attributes?.POSITION !== 'number' || !bind.has(mi)) return;
    const a = readAccessor(doc, p.attributes.POSITION);
    if (a) prims.push({ mesh: mi, prim: pi, data: a.data, count: a.count, M: bind.get(mi)! });
  }));
  if (!prims.length) return [];
  const W = (P: P, k: number): [number, number, number] => { const M = P.M, x = P.data[k * 3], y = P.data[k * 3 + 1], z = P.data[k * 3 + 2]; return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]; };
  let sx = 0, n = 0;
  for (const P of prims) for (let k = 0; k < P.count; k++) { sx += W(P, k)[0]; n++; }
  const mx = sx / Math.max(1, n);
  const sideOf = (x: number) => ((x > mx) === leftIsPlusX ? 'left' : 'right');
  const centre: Record<string, [number, number, number, number]> = { left: [0, 0, 0, 0], right: [0, 0, 0, 0] };
  for (const P of prims) for (let k = 0; k < P.count; k++) { const w = W(P, k), c = centre[sideOf(w[0])]; c[0] += w[0]; c[1] += w[1]; c[2] += w[2]; c[3]++; }
  const sides = (['left', 'right'] as const).filter((s) => centre[s][3] > 0);
  // the studio drives 'blink' with both eyes and blinkLeft / blinkRight only for one eye on its own (a wink)
  const names = sides.length === 2 ? ['blink', 'blinkLeft', 'blinkRight'] : ['blink'];
  // new data goes into one appended buffer
  const parts: Uint8Array[] = []; let len = 0;
  const bi = (json.buffers ??= []).length;
  const add = (arr: Float32Array | Uint32Array, type: string, count: number, extra: Json = {}) => {
    const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    (json.bufferViews ??= []).push({ buffer: bi, byteOffset: len, byteLength: b.byteLength });
    parts.push(b.slice()); len += b.byteLength;
    (json.accessors ??= []).push({ bufferView: json.bufferViews.length - 1, componentType: arr instanceof Float32Array ? 5126 : 5125, count, type, ...extra });
    return json.accessors.length - 1;
  };
  const touched = new Set(prims.map((p) => p.mesh));
  for (const mi of touched) {
    const mesh = meshes[mi];
    const before = mesh.primitives[0]?.targets?.length ?? 0;
    const tn: string[] = Array.isArray(mesh.extras?.targetNames) ? [...mesh.extras.targetNames] : Array.from({ length: before }, (_, i) => `morph_${i}`);
    mesh.primitives.forEach((p: Json, pi: number) => {
      p.targets ??= [];
      const P = prims.find((x) => x.mesh === mi && x.prim === pi);
      for (const nm of names) {
        const side = nm === 'blinkLeft' ? 'left' : nm === 'blinkRight' ? 'right' : null;
        if (!P) {
          // other primitives of this mesh: an empty (sparse, one zero) target, glTF wants the same count everywhere
          const cnt = json.accessors[p.attributes.POSITION].count;
          const idx = add(new Uint32Array([0]), 'SCALAR', 1), val = add(new Float32Array(3), 'VEC3', 1);
          json.accessors.push({ componentType: 5126, count: cnt, type: 'VEC3', min: [0, 0, 0], max: [0, 0, 0], sparse: { count: 1, indices: { bufferView: json.accessors[idx].bufferView, componentType: 5125 }, values: { bufferView: json.accessors[val].bufferView } } });
          p.targets.push({ POSITION: json.accessors.length - 1 });
          continue;
        }
        const up = localUp(P.M);
        const D = new Float32Array(P.count * 3);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < P.count; k++) {
          const w = W(P, k);
          const s = sideOf(w[0]);
          if (side && s !== side) continue;
          const c = centre[s], cy = c[1] / c[3];
          const dy = (cy + (w[1] - cy) * SQUASH) - w[1]; // world delta (0, dy, 0) → local
          D[k * 3] = up[0] * dy; D[k * 3 + 1] = up[1] * dy; D[k * 3 + 2] = up[2] * dy;
        }
        for (let k = 0; k < D.length; k++) { lo[k % 3] = Math.min(lo[k % 3], D[k]); hi[k % 3] = Math.max(hi[k % 3], D[k]); }
        p.targets.push({ POSITION: add(D, 'VEC3', P.count, { min: lo, max: hi }) });
      }
    });
    mesh.weights = [...(Array.isArray(mesh.weights) ? mesh.weights : new Array(before).fill(0)), ...names.map(() => 0)];
    mesh.extras = { ...(mesh.extras ?? {}), targetNames: [...tn, ...names] };
  }
  const bin = new Uint8Array(len); let o = 0;
  for (const b of parts) { bin.set(b, o); o += b.byteLength; }
  json.buffers.push({ byteLength: len });
  doc.buffers.push(bin);
  return names;
}
