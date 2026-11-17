// Which texture tier each of a 2D model's textures uses on this device (HQ decision #10), chosen by SCREEN-SPACE DEMAND:
// how many texels of the texture land on one output pixel when the model is drawn at the size this page shows it. The
// smallest tier that still gives ≥ TARGET texels per pixel is enough (the GPU would sample a smaller mip anyway: the
// extra resolution only costs memory). Then the device's limits: every page ≤ MAX_TEXTURE_SIZE, the whole model within
// the texture budget (phones, software drawing). With hysteresis: a re-pick (the output grew for a close-up / 4K) promotes
// at once, but demotes only when the smaller tier is comfortably enough, so the tier never flips back and forth.
// Pure: tools/hiq_pick_unit.ts.
import type { Rig2DDoc } from '../format.ts';
import { f32, viewArray } from '../container.ts';
import { TARGET_BPP, type GpuTarget } from './basis.ts';

/** texels per output pixel the chosen tier must give (≥ 1: no visible loss; the renderer's −1 LOD bias then still
 *  samples the sharpest level it has) */
export const TARGET = 1;
/** demote only when the smaller tier gives ≥ this × TARGET */
export const DEMOTE_MARGIN = 1.5;

export interface PickDevice {
  maxTexture: number;
  target: GpuTarget;
  /** texture memory this model may take (bytes, the chosen pages incl. mip chains) */
  budget: number;
}
export interface TierInfo { k: number; pages: { source: number; w: number; h: number }[] }

/** The texture memory budget for one model on a device class. Phones use the same table as the decoded pictures
 *  (src/avatar/flat/rig2d/textureBudget.ts decodeBudgetFor, lane mobile2d; tools/hiq_pick_unit.ts checks they agree):
 *  by navigator.deviceMemory ≤ 3 GB 48 MB, 4–5 GB 64 MB, ≥ 6 GB 96 MB, unknown (iPhones) 64 MB; half in low detail,
 *  at least 24 MB. */
export function textureBudget(d: { deviceClass: 'phone' | 'desktop'; software: boolean; lowDetail: boolean; memoryGB?: number }): number {
  const MiB = 1 << 20;
  if (d.software) return 48 * MiB;
  if (d.deviceClass === 'phone') {
    const gb = d.memoryGB, base = gb === undefined ? 64 * MiB : gb <= 3 ? 48 * MiB : gb < 6 ? 64 * MiB : 96 * MiB;
    return d.lowDetail ? Math.max(24 * MiB, base / 2) : base;
  }
  return d.lowDetail ? 128 * MiB : 512 * MiB;
}

/** Best GPU format the device takes (ASTC 4×4 is exact from UASTC; BC7 nearly; ETC2 RGBA; else RGBA8). */
export function bestTarget(c: { astc: boolean; bc7: boolean; etc2: boolean }, software = false): GpuTarget {
  if (software) return 'rgba';
  return c.astc ? 'astc' : c.bc7 ? 'bc7' : c.etc2 ? 'etc2' : 'rgba';
}

/** Texels per model unit of each texture at full size (an area-weighted 90th percentile over its meshes at rest: the
 *  detailed parts set the demand). `rest[m]` = mesh m's vertex positions (x, y pairs, model units). */
export function texelDensity(doc: Rig2DDoc, buffers: readonly Uint8Array[], rest: ArrayLike<number>[]): number[] {
  const per: { d: number; a: number }[][] = doc.textures.map(() => []);
  doc.meshes.forEach((m, mi) => {
    const tx = doc.textures[m.texture], p = rest[mi];
    if (!tx || !p) return;
    const uv = f32(buffers, m.uvs), ix = viewArray(buffers, m.indices);
    let au = 0, ap = 0;
    for (let q = 0; q + 2 < ix.length; q += 3) {
      const a = ix[q], b = ix[q + 1], c = ix[q + 2];
      au += Math.abs((uv[b * 2] - uv[a * 2]) * (uv[c * 2 + 1] - uv[a * 2 + 1]) - (uv[c * 2] - uv[a * 2]) * (uv[b * 2 + 1] - uv[a * 2 + 1])) / 2;
      ap += Math.abs((p[b * 2] - p[a * 2]) * (p[c * 2 + 1] - p[a * 2 + 1]) - (p[c * 2] - p[a * 2]) * (p[b * 2 + 1] - p[a * 2 + 1])) / 2;
    }
    if (au > 0 && ap > 1e-12) per[m.texture].push({ d: Math.sqrt(au * tx.width * tx.height / ap), a: ap });
  });
  return per.map((l) => {
    if (!l.length) return 0;
    l.sort((x, y) => x.d - y.d);
    const tot = l.reduce((s, x) => s + x.a, 0);
    let acc = 0;
    for (const x of l) { acc += x.a; if (acc >= tot * 0.9) return x.d; }
    return l[l.length - 1].d;
  });
}

const vram = (pages: { w: number; h: number }[], target: GpuTarget) => pages.reduce((s, p) => s + p.w * p.h, 0) * TARGET_BPP[target] * 4 / 3;

/** Per texture: the tier k to use (or −1: no tier fits this device: draw from the original, scaled). `density` =
 *  texelDensity(); `pxPerUnit` = output px per model unit; `prev` = the current choice (hysteresis). */
export function pickTiers(tiers: TierInfo[], density: number[], pxPerUnit: number, dev: PickDevice, prev?: number[]): number[] {
  const nTex = density.length;
  const avail = tiers.slice().sort((a, b) => a.k - b.k);
  const pagesOf = (k: number, t: number) => avail.find((x) => x.k === k)?.pages.filter((p) => p.source === t) ?? [];
  const fits = (k: number, t: number) => { const ps = pagesOf(k, t); return ps.length > 0 && ps.every((p) => p.w <= dev.maxTexture && p.h <= dev.maxTexture); };
  const out: number[] = [];
  for (let t = 0; t < nTex; t++) {
    const ks = avail.map((x) => x.k).filter((k) => fits(k, t));
    if (!ks.length) { out.push(-1); continue; }
    const tpp = (k: number) => density[t] * 2 ** -k / Math.max(1e-9, pxPerUnit);   // texels per output px at tier k
    // the smallest tier with enough texels (density unknown → the full one)
    let want = density[t] > 0 ? ks[0] : ks[0];
    if (density[t] > 0) for (const k of ks) if (tpp(k) >= TARGET) want = k;
    const p = prev?.[t];
    if (p !== undefined && p >= 0 && ks.includes(p) && want > p && tpp(want) < TARGET * DEMOTE_MARGIN) want = p;   // keep (hysteresis)
    out.push(want);
  }
  // the budget: shrink the texture taking the most memory, one tier at a time
  for (let guard = 0; guard < 64; guard++) {
    const total = out.reduce((s, k, t) => s + (k >= 0 ? vram(pagesOf(k, t), dev.target) : 0), 0);
    if (total <= dev.budget) break;
    let worst = -1, wb = 0;
    out.forEach((k, t) => { if (k < 0) return; const nk = avail.map((x) => x.k).filter((x) => x > k && fits(x, t))[0]; if (nk === undefined) return; const b = vram(pagesOf(k, t), dev.target); if (b > wb) { wb = b; worst = t; } });
    if (worst < 0) break;
    out[worst] = avail.map((x) => x.k).filter((x) => x > out[worst] && fits(x, worst))[0];
  }
  return out;
}
