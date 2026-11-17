// Inochi scalar bindings -> existing .vtp2 keyform grids. No format extension.
import { BufferBuilder } from '../container.ts';
import { RIG2D_LIMITS, type Rig2DDoc } from '../format.ts';
import { bracket, type InochiBinding, type InochiParam, type InochiRig } from './inp.ts';
import type { InochiMaterials } from './materialAdapter.ts';

interface ScalarBinding { param: InochiParam; indices: [number, number]; binding: InochiBinding }
const appearance = (prop: string) => prop === 'opacity' || prop.startsWith('tint.') || prop.startsWith('screenTint.');
const clamp = (v: number) => Math.max(0, Math.min(1, v));

function scalar(b: ScalarBinding, values: Map<number, number>) {
  const p = b.param, v = b.binding;
  const coord = (a: 0 | 1) => p.max[a] === p.min[a] ? 0 : ((values.get(b.indices[a]) ?? p.defaults[a]) - p.min[a]) / (p.max[a] - p.min[a]);
  const [x, x1, tx] = bracket(p.axis[0], coord(0)), [y, y1, ty] = p.isVec2 ? bracket(p.axis[1], coord(1)) : [0, 0, 0];
  const row = (j: number) => v.values[x * v.ny + j] * (1 - tx) + v.values[x1 * v.ny + j] * tx;
  return row(y) * (1 - ty) + row(y1) * ty;
}

function gridFor(bindings: ScalarBinding[], params: Rig2DDoc['params']) {
  const keys = new Map<number, Set<number>>();
  for (const b of bindings) for (const a of [0, 1] as const) {
    const i = b.indices[a];
    if (i < 0) continue;
    let k = keys.get(i);
    if (!k) { k = new Set([params[i].min, params[i].max]); keys.set(i, k); }
    for (const v of b.param.axis[a]) {
      const x = b.param.min[a] + v * (b.param.max[a] - b.param.min[a]);
      if (x >= params[i].min && x <= params[i].max) k.add(x);
    }
  }
  const axes = Array.from(keys, ([param, k]) => ({ param, keys: [...k].sort((a, b) => a - b) }));
  const count = axes.reduce((n, a) => n * a.keys.length, 1);
  if (axes.length > RIG2D_LIMITS.gridAxes || axes.some((a) => a.keys.length > RIG2D_LIMITS.keysPerAxis) || count > RIG2D_LIMITS.keyformsPerGrid) {
    throw new Error('This puppet has too many interacting colour or layer controls. Simplify those bindings in Inochi Creator and export it again.');
  }
  return { axes, count };
}

function eachKey(grid: ReturnType<typeof gridFor>, fn: (values: Map<number, number>, i: number) => void) {
  const values = new Map<number, number>();
  for (let i = 0; i < grid.count; i++) {
    let k = i;
    for (const a of grid.axes) { values.set(a.param, a.keys[k % a.keys.length]); k = Math.floor(k / a.keys.length); }
    fn(values, i);
  }
}

export function convertScalarBindings(rig: InochiRig, pIndex: [number, number][], params: Rig2DDoc['params'], grids: Rig2DDoc['grids'],
  deformers: Rig2DDoc['deformers'], meshes: Rig2DDoc['meshes'], nodeMesh: Int32Array, B: BufferBuilder, warn: (s: string) => void) {
  const byNode = new Map<number, ScalarBinding[]>();
  const carriers: InochiMaterials['carriers'] = [];
  rig.puppet.params.forEach((param, i) => {
    for (const binding of param.bindings) {
      if (!appearance(binding.prop) && binding.prop !== 'zSort') continue;
      const ni = rig.byUuid.get(binding.node);
      if (ni === undefined) continue;
      if (binding.mode !== 'Linear') warn('Some bindings use non-linear interpolation: blended linearly.');
      const list = byNode.get(ni) ?? []; list.push({ param, indices: pIndex[i], binding }); byNode.set(ni, list);
    }
  });
  rig.nodes.forEach((r, ni) => {
    const mi = nodeMesh[ni];
    if (mi < 0) {
      if ((byNode.get(ni) ?? []).some((b) => appearance(b.binding.prop))) warn('Colour / opacity on composite groups is not converted. Export those controls on separate parts in Inochi Creator.');
      return;
    }
    const mesh = meshes[mi], n = r.node;
    const looks = (byNode.get(ni) ?? []).filter((b) => appearance(b.binding.prop));
    // A material carrier affects only this drawable, not its geometric children.
    if (looks.length) {
      // Products with a shared axis are polynomial, not multilinear; they need the operator adapter.
      let exact = looks.some((a, i) => looks.slice(i + 1).some((b) => a.binding.prop === b.binding.prop &&
        a.binding.prop !== 'zSort' && !a.binding.prop.startsWith('screenTint.') && a.indices.some((p) => p >= 0 && b.indices.includes(p))));
      const g = gridFor(looks, params), grid = grids.length; grids.push({ axes: g.axes });
      const opacity: number[] = [], mul: number[] = [], scr: number[] = [];
      eachKey(g, (values) => {
        let op = n.opacity ?? 1;
        const tint = [...(n.tint ?? [1, 1, 1])], screen = [...(n.screenTint ?? [0, 0, 0])];
        for (const b of looks) {
          const p = b.binding.prop, v = scalar(b, values), c = 'rgb'.indexOf(p.slice(-1));
          if (p === 'opacity') op *= v;
          else if (p.startsWith('tint.')) tint[c] *= v;
          else screen[c] += v;
        }
        exact ||= [op, ...tint, ...screen].some((v) => v < 0 || v > 1);
        opacity.push(clamp(op)); mul.push(...tint.map(clamp)); scr.push(...screen.map(clamp));
      });
      const fill = (v: number) => new Array<number>(g.count).fill(v);
      const f = new Array<boolean>(g.count).fill(false);
      deformers.push({ id: `look_${n.uuid}`, name: `${n.name} colour`.slice(0, 256), kind: 'rotation', parent: mesh.deformer, part: -1, grid,
        enabled: true, visible: true, opacity, color: { multiply: B.f32(mul), screen: B.f32(scr) },
        rotation: { baseAngle: 0, angle: fill(0), originX: fill(0), originY: fill(0), scale: fill(1), reflectX: f, reflectY: [...f] } });
      mesh.deformer = deformers.length - 1; mesh.opacity = [1]; delete mesh.color;
      if (exact) carriers.push({ deformer: mesh.deformer, opacity: n.opacity ?? 1, multiply: n.tint ?? [1, 1, 1], screen: n.screenTint ?? [0, 0, 0],
        bindings: looks.map((b) => {
          const p = b.param, keys = p.axis[0].map((a) => p.min[0] + a * (p.max[0] - p.min[0]));
          const keys2 = p.isVec2 ? p.axis[1].map((a) => p.min[1] + a * (p.max[1] - p.min[1])) : undefined;
          const values = Array.from({ length: keys.length * (keys2?.length ?? 1) }, (_, i) => b.binding.values[(i % keys.length) * b.binding.ny + Math.floor(i / keys.length)]);
          return { channel: b.binding.prop as InochiMaterials['carriers'][number]['bindings'][number]['channel'], param: b.indices[0], keys,
            ...(keys2 ? { param2: b.indices[1], keys2 } : {}), values };
        }) });
    }
    const orders: ScalarBinding[] = [];
    let baseZ = 0;
    for (let p = ni; p >= 0; p = rig.nodes[p].parent) {
      baseZ += rig.nodes[p].node.zsort;
      orders.push(...(byNode.get(p) ?? []).filter((b) => b.binding.prop === 'zSort'));
    }
    // Use authored zSort, not the default parameter pose (which already includes binding offsets).
    mesh.drawOrder = [-baseZ];
    if (orders.length) {
      const g = gridFor(orders, params), stride = n.mesh!.verts.length;
      if (g.count * stride * 4 > 64 * 1024 * 1024) throw new Error('This puppet has too many layer-order keyforms. Simplify its layer controls in Inochi Creator and export it again.');
      mesh.grid = grids.length; grids.push({ axes: g.axes });
      const pos = new Float32Array(g.count * stride), drawOrder: number[] = [];
      eachKey(g, (values, i) => {
        for (let k = 0; k < stride; k++) pos[i * stride + k] = n.mesh!.verts[k] - n.mesh!.origin[k % 2];
        drawOrder.push(-baseZ - orders.reduce((s, b) => s + scalar(b, values), 0));
      });
      mesh.positions = B.add(pos, 'f32'); mesh.drawOrder = drawOrder;
      mesh.opacity = new Array(g.count).fill(mesh.opacity[0]);
      // Static colours still need one triple per mesh keyform.
      if (mesh.color) mesh.color = { multiply: B.f32(Array.from({ length: g.count }, () => n.tint ?? [1, 1, 1]).flat()), screen: B.f32(Array.from({ length: g.count }, () => n.screenTint ?? [0, 0, 0]).flat()) };
    }
  });
  return carriers.length ? { version: 1 as const, carriers } : null;
}
