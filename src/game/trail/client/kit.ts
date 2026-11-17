// The Trail — small three.js kit for the placeholder (grey-box) art: toon materials with a shared 3-step ramp, inverted
// hull outlines, text sprites / canvas labels, primitive builders. Everything trailart delivers replaces these.
import * as THREE from 'three';
import { outlineMaterial, setOutlineMinPixels } from '../../../avatar/toon.ts';

let ramp: THREE.DataTexture | null = null;
/** 3-step cel ramp (dark · mid · lit). */
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}
const matCache = new Map<string, THREE.Material>();
/** Cached toon material by colour (+ emissive). Colours are sRGB hex strings. */
export function toon(color: string, o: { emissive?: string; ei?: number; transparent?: number; side?: THREE.Side; flat?: boolean } = {}): THREE.Material {
  const key = `${color}|${o.emissive ?? ''}|${o.ei ?? 1}|${o.transparent ?? 1}|${o.side ?? 0}|${o.flat ? 1 : 0}`;
  let m = matCache.get(key);
  if (!m) {
    const mm = new THREE.MeshToonMaterial({ color: new THREE.Color(color), gradientMap: toonRamp() });
    if (o.emissive) { mm.emissive = new THREE.Color(o.emissive); mm.emissiveIntensity = o.ei ?? 1; }
    if (o.transparent !== undefined && o.transparent < 1) { mm.transparent = true; mm.opacity = o.transparent; mm.depthWrite = false; }
    if (o.side !== undefined) mm.side = o.side;
    m = mm;
    matCache.set(key, m);
  }
  return m;
}
const outlineCache = new Map<string, THREE.Material>();
/** Add a dark-warm inverted-hull outline to every mesh under `root` (skips transparent / tiny meshes). */
export function outline(root: THREE.Object3D, width = 0.0022, color = '#1c140f') {
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.noOutline && !(m.material as THREE.Material).transparent) meshes.push(m); });
  for (const m of meshes) {
    const k = `${color}|${width}`;
    let mat = outlineCache.get(k);
    if (!mat) { mat = outlineMaterial(color, width); outlineCache.set(k, mat); }
    const o = new THREE.Mesh(m.geometry, mat);
    o.userData.noOutline = true; o.userData.isOutline = true;
    o.raycast = () => {};
    m.add(o);
  }
}
export function onResizeOutlines(h: number) { setOutlineMinPixels(h, 1.2); }

// ---------------------------------------------------------------- primitives
const geoCache = new Map<string, THREE.BufferGeometry>();
const G = <T extends THREE.BufferGeometry>(k: string, make: () => T): T => { let g = geoCache.get(k) as T | undefined; if (!g) { g = make(); geoCache.set(k, g); } return g; };
export const unitBox = () => G('box', () => new THREE.BoxGeometry(1, 1, 1));
export const unitSphere = (seg = 16) => G(`sph${seg}`, () => new THREE.SphereGeometry(1, seg, Math.max(6, seg * 0.66)));
export const unitCyl = (seg = 16) => G(`cyl${seg}`, () => new THREE.CylinderGeometry(1, 1, 1, seg));
export const unitCone = (seg = 12) => G(`cone${seg}`, () => new THREE.ConeGeometry(1, 1, seg));
export const unitTorus = () => G('torus', () => new THREE.TorusGeometry(1, 0.18, 8, 20));
export const unitCapsule = () => G('capsule', () => new THREE.CapsuleGeometry(1, 2, 6, 12));
export const unitOcta = () => G('octa', () => new THREE.OctahedronGeometry(1, 0));
export const unitDodeca = () => G('dodeca', () => new THREE.DodecahedronGeometry(1, 0));

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, p: [number, number, number] = [0, 0, 0], s: [number, number, number] | number = 1, r: [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(...p);
  if (typeof s === 'number') m.scale.setScalar(s); else m.scale.set(...s);
  m.rotation.set(...r);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
export const box = (color: string, p: [number, number, number], s: [number, number, number], r?: [number, number, number]) => mesh(unitBox(), toon(color), p, s, r);
export const ball = (color: string, p: [number, number, number], s: [number, number, number] | number, o: Parameters<typeof toon>[1] = {}) => mesh(unitSphere(), toon(color, o), p, s);
export const cyl = (color: string, p: [number, number, number], r: number, h: number, rot?: [number, number, number], o: Parameters<typeof toon>[1] = {}) => mesh(unitCyl(), toon(color, o), p, [r, h, r], rot);
export const cone = (color: string, p: [number, number, number], r: number, h: number, rot?: [number, number, number]) => mesh(unitCone(), toon(color), p, [r, h, r], rot);

// ---------------------------------------------------------------- text
/** A canvas texture with centred text (labels on crates, signs, epitaphs). */
export function textTexture(lines: string[], o: { w?: number; h?: number; bg?: string; fg?: string; font?: string; border?: string; size?: number } = {}): THREE.CanvasTexture {
  const w = o.w ?? 512, h = o.h ?? 256;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  if (o.bg) { g.fillStyle = o.bg; g.fillRect(0, 0, w, h); }
  if (o.border) { g.strokeStyle = o.border; g.lineWidth = h * 0.05; g.strokeRect(h * 0.04, h * 0.04, w - h * 0.08, h - h * 0.08); }
  g.fillStyle = o.fg ?? '#fff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const size = o.size ?? Math.min(h / (lines.length + 0.6), w / Math.max(6, Math.max(...lines.map((l) => l.length)) * 0.62));
  g.font = `${o.font ?? '800'} ${size}px "Bahnschrift", "Arial Narrow", "Segoe UI", sans-serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * size * 1.1, w * 0.94));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
/** A camera-facing label (name plates, price tags). */
export function labelSprite(text: string, o: { fg?: string; bg?: string; height?: number; bold?: boolean } = {}): THREE.Sprite {
  const pad = 18, size = 44;
  const c = document.createElement('canvas');
  const g = c.getContext('2d')!;
  const font = `${o.bold === false ? 600 : 800} ${size}px "Bahnschrift", "Segoe UI", sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + pad * 2;
  c.width = Math.max(64, w); c.height = size + pad;   // (resizing resets the context state)
  const g2 = c.getContext('2d')!;
  g2.font = font;
  if (o.bg !== 'none') { g2.fillStyle = o.bg ?? 'rgba(12,14,18,0.72)'; roundRect(g2, 0, 0, c.width, c.height, c.height / 2); g2.fill(); }
  g2.fillStyle = o.fg ?? '#fff'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
  g2.fillText(text, c.width / 2, c.height / 2 + 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  const hgt = o.height ?? 0.22;
  s.scale.set(hgt * (c.width / c.height), hgt, 1);
  s.renderOrder = 20;
  return s;
}
export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

/** Deterministic tiny PRNG for cosmetic scatter. */
export function prng(seed: number) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
export function disposeTree(o: THREE.Object3D) {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (m.isMesh && m.geometry && ![...geoCache.values()].includes(m.geometry)) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && (mat as THREE.SpriteMaterial).map && (x as THREE.Sprite).isSprite) { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose(); }
  });
}
