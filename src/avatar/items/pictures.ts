// Turning an item's bytes into something three.js can draw: a picture (PNG / APNG / GIF / WebP / JPEG, animated ones too) on a
// canvas texture, or a small GLB. Decoding reuses the 2D-avatar decoder (src/avatar/flat/frames.ts: WebCodecs ImageDecoder, capped
// frames and pixels). Nothing here touches the network or the disk: bytes come in, GPU/RAM objects go out, and `dispose()` frees them.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { decodePicture, closePicture, frameAt, type DecodedPicture } from '../flat/frames.ts';
import { markShared, releaseBitmap, texturesOf } from '../gpuDispose.ts';

/** Items are small on screen: a picture taller than this is scaled down while decoding. */
export const ITEM_PIC_MAX_H = 384;

export interface ItemPicture {
  /** width / height */
  aspect: number;
  texture: THREE.CanvasTexture;
  /** More than one frame: the owner calls step() while it is on screen. */
  animated: boolean;
  /** Show the frame for `ms` (since the item appeared, looping). Returns true when the texture changed. */
  step(ms: number): boolean;
  dispose(): void;
}

export async function loadPicture(bytes: ArrayBuffer, speed = 1): Promise<ItemPicture> {
  const pic: DecodedPicture = await decodePicture(bytes, ITEM_PIC_MAX_H);
  const canvas = document.createElement('canvas');
  canvas.width = pic.width; canvas.height = pic.height;
  const g = canvas.getContext('2d');
  if (!g) { closePicture(pic); throw new Error('This browser cannot draw pictures here'); }
  const draw = (i: number) => { g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(pic.frames[i], 0, 0, canvas.width, canvas.height); };
  draw(0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  let shown = 0;
  const k = Math.min(4, Math.max(0.1, speed));
  return {
    aspect: pic.width / Math.max(1, pic.height),
    texture,
    animated: pic.frames.length > 1 && pic.total > 0,
    step(ms: number) {
      if (pic.frames.length < 2) return false;
      const i = frameAt(pic, ms * k);
      if (i === shown) return false;
      shown = i; draw(i); texture.needsUpdate = true;
      return true;
    },
    dispose() { texture.dispose(); closePicture(pic); canvas.width = canvas.height = 0; },
  };
}

export interface ItemModel {
  /** Centred on the origin, its longest side 1. */
  root: THREE.Group;
  /** width / height of its box (for the selection frame). */
  aspect: number;
  mixer: THREE.AnimationMixer | null;
  dispose(): void;
}

/** Mark every texture of an item model as shared, so an AVATAR's dispose (gpuDispose.disposeMeshes walks the item holders that hang
 *  under its model) never frees them: it would close their decoded ImageBitmaps for good, and the item would draw black after the
 *  next outfit or accessory change. The item frees them itself (ItemModel.dispose). */
export function protectItemTextures(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of [m.material].flat()) if (mat) for (const t of texturesOf(mat)) markShared(t);
  });
}

const gltf = new GLTFLoader();
/** A small GLB (a hat, a held prop). Cameras and lights it carries are dropped; its first animation, if any, loops. */
export async function loadItemModel(bytes: ArrayBuffer): Promise<ItemModel> {
  const r = await gltf.parseAsync(bytes, '');
  const root = new THREE.Group();
  const scene = r.scene;
  const drop: THREE.Object3D[] = [];
  scene.traverse((o) => { if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) drop.push(o); });
  for (const o of drop) o.removeFromParent();
  scene.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z, 1e-6);
  const mid = box.getCenter(new THREE.Vector3());
  scene.position.sub(mid);
  const holder = new THREE.Group();
  holder.add(scene);
  holder.scale.setScalar(1 / longest);
  root.add(holder);
  root.traverse((o) => { o.userData.vtpNoToon = true; o.userData.vtpItem = true; const m = o as THREE.Mesh; if (m.isMesh) m.frustumCulled = false; });
  protectItemTextures(root);
  const mixer = r.animations.length ? new THREE.AnimationMixer(scene) : null;
  if (mixer) mixer.clipAction(r.animations[0]).play();
  const dispose = () => {
    mixer?.stopAllAction();
    const texs = new Set<THREE.Texture>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      for (const mat of [m.material].flat()) {
        if (!mat) continue;
        for (const t of texturesOf(mat)) texs.add(t);
        mat.dispose();
      }
    });
    for (const t of texs) { t.dispose(); releaseBitmap(t.image); }   // (the decoded bitmaps of a glTF's images are ours to close)
  };
  return { root, aspect: size.x / Math.max(1e-6, size.y), mixer, dispose };
}
