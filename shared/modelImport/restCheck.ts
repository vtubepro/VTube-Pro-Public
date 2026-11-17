// Did a fix keep the model in one piece? The skinned rest shape of a glTF (every vertex through its joints' rest world
// matrices × inverse bind matrices, exactly what a renderer shows with all bones at rest), compared before and after
// the import's file fixes (root scale / rotation, renames, packing, blink shapes). The fixed file must be the source
// shape moved by the root fix and nothing else: every vertex within 0.5 % of the height, and every pair of vertices
// that touched in the source (different bones, closer than 1.5 % of the height) still touching. Pure; used by
// prepare.ts (a fix that would break the shape is dropped) and the tests.
import { apply, mul, readAccessor, worldMatrices, type GltfDoc, type Mat4 } from './gltf.ts';

export interface RestShape { points: Float32Array; joint: Int32Array; count: number; height: number }

/** Every vertex of every mesh in file space at rest (skinned meshes through their skin), with its main joint. */
export function restShape(doc: GltfDoc, maxPerPrim = 60_000): RestShape {
  const json = doc.json;
  const { world } = worldMatrices(json);
  const pts: number[] = [], jnt: number[] = [];
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  nodes.forEach((n: { mesh?: number; skin?: number }, ni: number) => {
    const mesh = typeof n?.mesh === 'number' ? json.meshes?.[n.mesh] : null;
    if (!mesh) return;
    const skin = typeof n.skin === 'number' ? json.skins?.[n.skin] : null;
    let mats: Mat4[] | null = null;
    if (skin?.joints?.length) {
      const ibm = typeof skin.inverseBindMatrices === 'number' ? readAccessor(doc, skin.inverseBindMatrices)?.data : null;
      mats = skin.joints.map((j: number, k: number) => (ibm ? mul(world[j], Float64Array.from(ibm.subarray(k * 16, k * 16 + 16))) : world[j]));
    }
    for (const p of mesh.primitives ?? []) {
      const P = readAccessor(doc, p?.attributes?.POSITION, maxPerPrim);
      if (!P) continue;
      const J = mats ? readAccessor(doc, p.attributes.JOINTS_0, maxPerPrim) : null;
      const W = mats ? readAccessor(doc, p.attributes.WEIGHTS_0, maxPerPrim) : null;
      for (let i = 0; i < P.count; i++) {
        const v = [P.data[i * 3], P.data[i * 3 + 1], P.data[i * 3 + 2]];
        if (mats && J && W) {
          let x = 0, y = 0, z = 0, best = 0, bj = -1;
          for (let k = 0; k < 4; k++) {
            const w = W.data[i * 4 + k];
            if (!(w > 0)) continue;
            const ji = J.data[i * 4 + k];
            const q = apply(mats[ji] ?? world[ni], v);
            x += w * q[0]; y += w * q[1]; z += w * q[2];
            if (w > best) { best = w; bj = skin.joints[ji]; }
          }
          pts.push(x, y, z); jnt.push(bj);
        } else { const q = apply(world[ni], v); pts.push(q[0], q[1], q[2]); jnt.push(-1); }
      }
    }
  });
  const points = Float32Array.from(pts);
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < points.length; i += 3) { lo = Math.min(lo, points[i]); hi = Math.max(hi, points[i]); }
  return { points, joint: Int32Array.from(jnt), count: jnt.length, height: Number.isFinite(hi - lo) ? hi - lo : 0 };
}

export interface RestCompare { ok: boolean; maxErr: number; meanErr: number; contacts: number; broken: number; why: string }

/** `after` must equal `before` moved by the root fix `move` (a point transform). Errors are fractions of the height. */
export function compareRest(before: RestShape, after: RestShape, move: (p: [number, number, number]) => [number, number, number]): RestCompare {
  if (before.count !== after.count || !before.count) return { ok: before.count === after.count, maxErr: 0, meanErr: 0, contacts: 0, broken: 0, why: before.count === after.count ? 'empty' : `vertex count changed (${before.count} → ${after.count})` };
  const moved = new Float32Array(before.points.length);
  for (let i = 0; i < before.count; i++) { const q = move([before.points[i * 3], before.points[i * 3 + 1], before.points[i * 3 + 2]]); moved.set(q, i * 3); }
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i < moved.length; i += 3) { lo = Math.min(lo, moved[i]); hi = Math.max(hi, moved[i]); }
  const H = Math.max(1e-9, hi - lo);
  let maxErr = 0, sum = 0;
  for (let i = 0; i < before.count; i++) {
    const e = Math.hypot(moved[i * 3] - after.points[i * 3], moved[i * 3 + 1] - after.points[i * 3 + 1], moved[i * 3 + 2] - after.points[i * 3 + 2]) / H;
    maxErr = Math.max(maxErr, e); sum += e;
  }
  // touching pairs across bones (a grid hash keeps it linear)
  const cell = 0.015 * H, grid = new Map<string, number[]>();
  const step = Math.max(1, Math.floor(before.count / 20000));
  for (let i = 0; i < before.count; i += step) { const k = `${Math.floor(moved[i * 3] / cell)},${Math.floor(moved[i * 3 + 1] / cell)},${Math.floor(moved[i * 3 + 2] / cell)}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
  let contacts = 0, broken = 0;
  for (const list of grid.values()) for (let a = 0; a < list.length && contacts < 50000; a++) for (let b = a + 1; b < list.length; b++) {
    const i = list[a], j = list[b];
    if (before.joint[i] === before.joint[j]) continue;
    contacts++;
    const d = Math.hypot(after.points[i * 3] - after.points[j * 3], after.points[i * 3 + 1] - after.points[j * 3 + 1], after.points[i * 3 + 2] - after.points[j * 3 + 2]) / H;
    if (d > 0.025) broken++;
  }
  const ok = maxErr < 0.005 && broken === 0;
  return { ok, maxErr, meanErr: sum / before.count, contacts, broken, why: ok ? '' : broken ? `${broken} touching pairs came apart` : `the shape moved by up to ${(maxErr * 100).toFixed(1)} % of its height` };
}
