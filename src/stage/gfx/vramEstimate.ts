// How much graphics-card memory one page holds (an ESTIMATE from what three.js was given, not a driver query: browsers
// don't expose one): textures with their mip chains, vertex / index buffers, the post-pipeline render targets and the
// canvas's own drawing buffers. The OBS page reports it with its frame stats (src/output.ts 'obsperf' → the studio's
// diagnostics), so a "one frame every few seconds next to a game" report shows what VTube Pro itself put on the card next
// to what the helper reads for the whole card (shared/gpuStat.ts). docs/PERFORMANCE.md "Gaming next to VTube Pro".
import * as THREE from 'three';
import { texturesOf } from '../../avatar/gpuDispose.ts';

const MB = 1048576;

type AnyTex = THREE.Texture & {
  isCompressedTexture?: boolean; isDataTexture?: boolean; isData3DTexture?: boolean; isDataArrayTexture?: boolean;
  isCubeTexture?: boolean; isRenderTargetTexture?: boolean; isVideoTexture?: boolean; isCanvasTexture?: boolean;
};

/** Bytes per texel for a texture's type (RGBA: RGB uploads are padded to 4 channels by most drivers). */
export function texelBytes(type: number): number {
  if (type === THREE.FloatType) return 16;
  if (type === THREE.HalfFloatType) return 8;
  return 4;
}

const MIP_FILTERS = new Set<number>([THREE.NearestMipmapNearestFilter, THREE.NearestMipmapLinearFilter, THREE.LinearMipmapNearestFilter, THREE.LinearMipmapLinearFilter]);

/** Width × height of an image-like texture source (0 × 0 when unknown / a closed ImageBitmap). */
export function imageSize(img: unknown): [number, number] {
  const x = img as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number } | null;
  if (!x) return [0, 0];
  const w = x.naturalWidth || x.videoWidth || x.width || 0, h = x.naturalHeight || x.videoHeight || x.height || 0;
  return [Number(w) || 0, Number(h) || 0];
}

/** GPU bytes of one texture (estimate; render-target textures are 0: counted with their targets). */
export function textureBytes(t: THREE.Texture): number {
  const x = t as AnyTex;
  if (x.isRenderTargetTexture) return 0;
  const img = t.image as { data?: ArrayBufferView; width?: number; height?: number; depth?: number } | unknown[] | null;
  if (x.isCompressedTexture) {
    let b = 0;
    for (const m of (t.mipmaps ?? []) as { data?: ArrayBufferView }[]) b += m?.data?.byteLength ?? 0;
    return b || ((img as { data?: ArrayBufferView })?.data?.byteLength ?? 0);
  }
  if (x.isDataTexture || x.isData3DTexture || x.isDataArrayTexture) {
    const d = (img as { data?: ArrayBufferView } | null)?.data;
    const b = d?.byteLength ?? 0;
    return t.generateMipmaps && MIP_FILTERS.has(t.minFilter) ? Math.round(b * 4 / 3) : b;
  }
  if (x.isCubeTexture && Array.isArray(img)) {
    let b = 0;
    for (const f of img) { const [w, h] = imageSize(f); b += w * h * texelBytes(t.type); }
    return t.generateMipmaps && MIP_FILTERS.has(t.minFilter) ? Math.round(b * 4 / 3) : b;
  }
  const [w, h] = imageSize(img);
  const base = w * h * texelBytes(t.type);
  return t.generateMipmaps && MIP_FILTERS.has(t.minFilter) && !x.isVideoTexture ? Math.round(base * 4 / 3) : base;
}

/** Bytes of a geometry's buffers (each underlying array once). */
function geometryBytes(g: THREE.BufferGeometry, seen: Set<unknown>): number {
  let b = 0;
  const add = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined) => {
    if (!a) return;
    const arr = (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data.array : (a as THREE.BufferAttribute).array;
    if (!arr || seen.has(arr)) return;
    seen.add(arr);
    b += (arr as ArrayBufferView).byteLength ?? 0;
  };
  for (const k in g.attributes) add(g.attributes[k] as THREE.BufferAttribute);
  add(g.index);
  const morph = g.morphAttributes as Record<string, (THREE.BufferAttribute | THREE.InterleavedBufferAttribute)[] | undefined>;
  for (const k in morph) for (const a of morph[k] ?? []) add(a);
  return b;
}

export interface VramEstimate {
  /** Textures on the graphics card (MB; only ones the renderer uploaded when it can tell). */
  texturesMB: number;
  geometryMB: number;
  /** Post-pipeline / shadow render targets (from the caller). */
  targetsMB: number;
  /** The canvas's drawing buffers (MSAA + resolve + depth + the browser's swap copies). */
  canvasMB: number;
  totalMB: number;
  textures: number;
  /** Of the textures: the ones under each named root (e.g. room / performers), MB. */
  groups: Record<string, number>;
}

/** The page's own estimate. `groups` = named roots whose textures are summed apart (the first root that holds a texture
 *  owns it); `targetBytes` = what Graphics holds in render targets; `msaa` = the canvas's own sample count (0 = none). */
export function estimateVram(renderer: THREE.WebGLRenderer, scene: THREE.Scene, opts: { groups?: Record<string, THREE.Object3D | null>; targetBytes?: number; msaa?: number } = {}): VramEstimate {
  const props = renderer.properties as unknown as { get(o: object): { __webglInit?: boolean } };
  const uploaded = (t: THREE.Texture) => { try { return props.get(t).__webglInit === true; } catch { return true; } };
  const seenSrc = new Set<unknown>(), seenArr = new Set<unknown>(), seenGeo = new Set<THREE.BufferGeometry>();
  const groups: Record<string, number> = {};
  let tex = 0, n = 0, geo = 0;
  const visit = (root: THREE.Object3D, group: string | null) => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry && !seenGeo.has(m.geometry)) { seenGeo.add(m.geometry); geo += geometryBytes(m.geometry, seenArr); }
      const sk = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).skeleton : null;
      const list: THREE.Texture[] = [];
      if (sk?.boneTexture) list.push(sk.boneTexture);
      if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) list.push(...texturesOf(mat));
      for (const t of list) {
        if (seenSrc.has(t.source) || !uploaded(t)) continue;
        seenSrc.add(t.source);
        const b = textureBytes(t);
        tex += b; n++;
        if (group) groups[group] = (groups[group] ?? 0) + b;
      }
    });
  };
  for (const [name, root] of Object.entries(opts.groups ?? {})) if (root) visit(root, name);
  visit(scene, null);
  for (const t of [scene.background, scene.environment]) {
    if (t && (t as THREE.Texture).isTexture && !seenSrc.has((t as THREE.Texture).source)) { seenSrc.add((t as THREE.Texture).source); tex += textureBytes(t as THREE.Texture); n++; }
  }
  // the canvas: (MSAA colour + depth-stencil per sample) + the resolved colour + two swap copies the compositor holds
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  const px = buf.x * buf.y, s = Math.max(0, opts.msaa ?? 0);
  const canvas = s > 1 ? px * 4 * s * 2 + px * 4 * 3 : px * 4 * 2 + px * 4 * 2;
  const targets = opts.targetBytes ?? 0;
  const r = (b: number) => Math.round((b / MB) * 10) / 10;
  for (const k of Object.keys(groups)) groups[k] = r(groups[k]);
  return { texturesMB: r(tex), geometryMB: r(geo), targetsMB: r(targets), canvasMB: r(canvas), totalMB: r(tex + geo + targets + canvas), textures: n, groups };
}
