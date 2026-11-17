// Avatar detail: non-face texture cap, at LOAD only (AvatarRuntime.load, after build, before the first frame; the
// avatar is hidden meanwhile). Caps never change mid-show: a new choice applies at the next load.
//   Lighter 2048 px, Lightest 1024 px, Auto 4096 px only when the avatar's textures would take over 1 GB decoded.
//   Skipped: compressed, data (baked-eye copies), video and canvas (costume labels) textures.
//   Protected (never resized): every texture used by a mesh with morph targets, a FACE_RE mesh / material name, or a
//   rest bounding box that touches the face sphere. A texture shared with a protected mesh is protected.
//   Resized: halved until it fits (aspect kept) with createImageBitmap(resizeQuality 'high', no premultiply, no colour
//   conversion: the same pixels GLTFLoader decoded); the old bitmap is closed once nothing in the avatar uses it (never
//   one THREE.Cache could hand to another load). Any failure keeps the original.
import * as THREE from 'three';
import { cappedSize, texBytes, textureCapFor, type AvatarDetailChoice } from '../../../shared/avatarDetail.ts';
import { FACE_RE } from '../../../shared/lod/classify.ts';
import type { DetailSphere } from './extract.ts';
import { releaseBitmap, texturesOf } from '../gpuDispose.ts';

export interface TexCapInfo { cap: number; capped: number; protectedTex: number; beforeMB: number; afterMB: number; ms: number; failed: number }

type TexSource = THREE.Texture['source'];
interface Src { source: TexSource; textures: Set<THREE.Texture>; meshes: Set<THREE.Mesh> }

type Img = ImageBitmap | HTMLImageElement;
const isImg = (x: unknown): x is Img =>
  (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) || (typeof HTMLImageElement !== 'undefined' && x instanceof HTMLImageElement);
const dims = (x: Img) => (x instanceof ImageBitmap ? [x.width, x.height] : [x.naturalWidth || x.width, x.naturalHeight || x.height]);

function skip(t: THREE.Texture): boolean {
  const x = t as THREE.Texture & { isCompressedTexture?: boolean; isDataTexture?: boolean; isData3DTexture?: boolean; isDataArrayTexture?: boolean; isVideoTexture?: boolean; isCanvasTexture?: boolean; isCubeTexture?: boolean; isRenderTargetTexture?: boolean };
  return !!(x.isCompressedTexture || x.isDataTexture || x.isData3DTexture || x.isDataArrayTexture || x.isVideoTexture || x.isCanvasTexture || x.isCubeTexture || x.isRenderTargetTexture) || !isImg(t.image);
}

/** Cap the avatar's non-face textures for this choice. `faceSphere` = the face sphere (world, at rest) or null. */
export async function capTextures(model: THREE.Object3D, choice: AvatarDetailChoice, faceSphere: DetailSphere | null): Promise<TexCapInfo> {
  const t0 = performance.now();
  const srcs = new Map<TexSource, Src>();
  const sphere = faceSphere ? new THREE.Sphere(faceSphere.center, faceSphere.radius) : null;
  const box = new THREE.Box3();
  const protectedMesh = (m: THREE.Mesh) => {
    const g = m.geometry;
    if (Object.values(g.morphAttributes ?? {}).some((l) => (l as unknown[])?.length)) return true;
    const names = [m.name, ...(Array.isArray(m.material) ? m.material : [m.material]).map((x) => x?.name ?? '')].join(' ');
    if (FACE_RE.test(names)) return true;
    if (sphere) {
      if (!g.boundingBox) g.computeBoundingBox();
      box.copy(g.boundingBox!).applyMatrix4(m.matrixWorld);
      if (box.intersectsSphere(sphere)) return true;
    }
    return false;
  };
  model.updateWorldMatrix(true, true);
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) for (const t of texturesOf(mat)) {
      let s = srcs.get(t.source);
      if (!s) { s = { source: t.source, textures: new Set(), meshes: new Set() }; srcs.set(t.source, s); }
      s.textures.add(t); s.meshes.add(m);
    }
  });
  let before = 0;
  const list: { s: Src; img: Img; w: number; h: number; prot: boolean }[] = [];
  for (const s of srcs.values()) {
    const t = [...s.textures][0];
    if ([...s.textures].some(skip)) continue;
    const img = t.image as Img;
    const [w, h] = dims(img);
    if (!(w > 0 && h > 0)) continue;
    before += texBytes(w, h);
    // (outline hulls / shells / patches carry their source's textures: judged by the meshes they belong to)
    const owners = [...s.meshes].filter((m) => !m.userData.vtpOutline && !m.userData.vtpGenerated);
    list.push({ s, img, w, h, prot: (owners.length ? owners : [...s.meshes]).some(protectedMesh) });
  }
  const cap = textureCapFor(choice, before);
  let after = before, capped = 0, failed = 0;
  if (cap > 0) {
    for (const x of list) {
      if (x.prot || Math.max(x.w, x.h) <= cap) continue;
      const [nw, nh] = cappedSize(x.w, x.h, cap);
      try {
        const bmp = await createImageBitmap(x.img, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        x.s.source.data = bmp;
        for (const t of x.s.textures) t.needsUpdate = true;
        after += texBytes(nw, nh) - texBytes(x.w, x.h);
        capped++;
        // the old image: closed once no other source of the avatar still shows it
        if (![...srcs.values()].some((o) => o.source.data === x.img)) releaseBitmap(x.img);
      } catch (e) { failed++; console.warn('avatar detail: texture cap kept the original', e); }
    }
  }
  return { cap, capped, protectedTex: list.filter((x) => x.prot).length, beforeMB: +(before / 1048576).toFixed(1), afterMB: +(after / 1048576).toFixed(1), ms: Math.round(performance.now() - t0), failed };
}
