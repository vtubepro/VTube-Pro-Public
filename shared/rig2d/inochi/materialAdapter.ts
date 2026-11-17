// Runtime of the canonical `materialBindings` (docs/RIG2D_FORMAT.md §8.11): cases a multilinear keyform grid cannot
// represent exactly (two factors of the same parameter, clamping AFTER composition). Ordinary looks use keyforms alone.
// (Files written before the field existed carried it in `extra['vtubepro.inochi.materialBindings']`; still read.)
import { z } from 'zod';
import type { Rig2DDoc } from '../format.ts';

export const INOCHI_MATERIAL_ADAPTER = 'vtubepro.inochi.materialBindings';
const fin = z.number().finite(), index = z.number().int().nonnegative();
const keys = z.array(fin).min(1).max(256).refine((a) => a.every((v, i) => i === 0 || v > a[i - 1]));
const MaterialSchema = z.object({ version: z.literal(1), carriers: z.array(z.object({
  deformer: index, opacity: fin, multiply: z.tuple([fin, fin, fin]), screen: z.tuple([fin, fin, fin]),
  bindings: z.array(z.object({
    channel: z.enum(['opacity', 'tint.r', 'tint.g', 'tint.b', 'screenTint.r', 'screenTint.g', 'screenTint.b']),
    param: index, keys, param2: index.optional(), keys2: keys.optional(), values: z.array(fin).min(1).max(65536),
  }).strict()).max(4096),
}).strict()).max(16384) }).strict();
export type InochiMaterials = z.infer<typeof MaterialSchema>;
const cl = (v: number) => Math.max(0, Math.min(1, v));
function segment(keys: number[], v: number): [number, number, number] {
  let lo = 0;
  while (lo < keys.length - 2 && v > keys[lo + 1]) lo++;
  const hi = Math.min(lo + 1, keys.length - 1);
  return [lo, hi, hi === lo ? 0 : cl((v - keys[lo]) / (keys[hi] - keys[lo]))];
}

export function createInochiMaterialAdapter(doc: Rig2DDoc) {
  // canonical field (format §8.11); the earlier `extra` adapter key is still read for files written before it
  const raw = doc.materialBindings?.length ? { version: 1, carriers: doc.materialBindings } : doc.extra?.[INOCHI_MATERIAL_ADAPTER];
  if (raw === undefined) return null;
  const p = MaterialSchema.safeParse(raw);
  if (!p.success || p.data.carriers.some((c) => c.deformer >= doc.deformers.length || c.bindings.some((b) =>
    b.param >= doc.params.length || (b.param2 !== undefined && b.param2 >= doc.params.length) ||
    (b.param2 !== undefined) !== (b.keys2 !== undefined) || b.values.length !== b.keys.length * (b.keys2?.length ?? 1)))) {
    throw new Error('The puppet’s colour controls are damaged. Import the original puppet again.');
  }
  const carriers = p.data.carriers;
  return { apply(values: Float64Array, opacity: Float64Array, multiply: Float64Array, screen: Float64Array) {
    for (const c of carriers) {
      const at = c.deformer * 3;
      opacity[c.deformer] = c.opacity;
      multiply.set(c.multiply, at); screen.set(c.screen, at);
      for (const b of c.bindings) {
        const [x0, x1, tx] = segment(b.keys, values[b.param]);
        const [y0, y1, ty] = b.keys2 ? segment(b.keys2, values[b.param2!]) : [0, 0, 0];
        const nx = b.keys.length, row = (y: number) => b.values[x0 + nx * y] * (1 - tx) + b.values[x1 + nx * y] * tx;
        const v = row(y0) * (1 - ty) + row(y1) * ty, k = 'rgb'.indexOf(b.channel.slice(-1));
        if (b.channel === 'opacity') opacity[c.deformer] *= v;
        else if (b.channel.startsWith('tint.')) multiply[at + k] *= v;
        else screen[at + k] += v;
      }
      opacity[c.deformer] = cl(opacity[c.deformer]);
      for (let k = 0; k < 3; k++) { multiply[at + k] = cl(multiply[at + k]); screen[at + k] = cl(screen[at + k]); }
    }
  } };
}
