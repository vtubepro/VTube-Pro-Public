// The studio's room preview draws the room in a box a few hundred pixels wide, yet it uploaded the room's textures at
// full size (4K wall / floor maps): every big upload kept the graphics card's command queue busy for 30-80 ms, and the
// face tracker's GPU model, which shares that queue, waited behind it (tracking gaps of 150-250 ms on the first Room
// visit, measured). The preview page (never an OBS page) halves its room's image textures until they fit `max` px
// before anything is uploaded; createImageBitmap does the resizing off the page's thread. Data / compressed / video /
// canvas textures and anything that fails keep their original.
import * as THREE from 'three';
import { releaseBitmap } from '../../avatar/gpuDispose.ts';

type Img = ImageBitmap | HTMLImageElement;
const isImg = (x: unknown): x is Img =>
  (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && x instanceof HTMLImageElement);

const floated = new WeakSet<THREE.BufferGeometry>();
/** Integer skin indices (Uint8 / Uint16, read as floats by three.js's shaders) as Float32: Direct3D has no vertex
 *  format that turns integers into floats, so ANGLE builds an extra draw-time variant of every skinned program for them
 *  — synchronously in the graphics card's command queue, 25-80 ms each (measured). Same values, same picture. */
export function floatSkinIndices(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const g = (o as THREE.SkinnedMesh).isSkinnedMesh ? (o as THREE.SkinnedMesh).geometry : null;
    if (!g || floated.has(g)) return;
    floated.add(g);
    const a = g.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    if (!a || !a.array || a.array instanceof Float32Array || (a as unknown as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute) return;
    g.setAttribute('skinIndex', new THREE.BufferAttribute(Float32Array.from(a.array as ArrayLike<number>), a.itemSize));
    n++;
  });
  return n;
}

/** Shrink the image textures under `root` to at most `max` px (longest side, halving). Resolves how many it shrank. */
export async function capPreviewTextures(root: THREE.Object3D, max = 1024): Promise<number> {
  const bySource = new Map<THREE.Texture['source'], THREE.Texture[]>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
      const t = v as THREE.Texture & { isCompressedTexture?: boolean; isDataTexture?: boolean; isVideoTexture?: boolean; isCanvasTexture?: boolean; isCubeTexture?: boolean };
      if (!(v instanceof THREE.Texture) || t.isCompressedTexture || t.isDataTexture || t.isVideoTexture || t.isCanvasTexture || t.isCubeTexture || !isImg(t.image)) continue;
      const l = bySource.get(t.source) ?? [];
      if (!l.includes(t)) l.push(t);
      bySource.set(t.source, l);
    }
  });
  let n = 0;
  await Promise.all([...bySource.values()].map(async (texs) => {
    const img = texs[0].image as Img;
    let w = img instanceof ImageBitmap ? img.width : img.naturalWidth || img.width, h = img instanceof ImageBitmap ? img.height : img.naturalHeight || img.height;
    if (!(w > max || h > max)) return;
    while (w > max || h > max) { w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2)); }
    try {
      // (no premultiply / colour conversion: the same pixels GLTFLoader decoded, only fewer of them)
      const bmp = await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'medium', premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' } as ImageBitmapOptions);
      for (const t of texs) { t.image = bmp; t.needsUpdate = true; }
      n++;
      // the full-size original: closed now unless another source of this room still shows it (else it waits for a GC)
      if (![...bySource.keys()].some((s) => s !== texs[0].source && s.data === img)) releaseBitmap(img);
    } catch { /* keep the original */ }
  }));
  return n;
}
