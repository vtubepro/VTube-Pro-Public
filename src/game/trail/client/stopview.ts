// The Trail v2 — the view of a GENERATED stop (shared/trail/stopgen.ts; workstream trailstops). Builds, from the
// LevelDesc's `terrain` + `art`, a crafted-looking place with the theme pack's art:
//   · the ground: the same heightfield the host simulates (rebuilt from its spec), splat-blended with trailart's
//     terrain layers (terrain/terrain.json: ground / grass / mud / rock / shore per biome), + a coarse backdrop ring of
//     hills to the horizon, island undersides + a cloud sea for Skyisles;
//   · road ribbons (the biome's road texture + verge strips), tall-grass cards, lily pads;
//   · structures: every collider drawn with its material key (planks, plaster, shingles, stone, marble, gold …) +
//     the visual-only parts (gable roofs, rocky drums, rings, ropes, signs), merged per material, outlined;
//   · theme kit pieces: SCENERY_<id> from scatter.glb / levels/trail_road.glb, instanced (placeholder decor fallback);
//   · lanterns (point lights).
// Called from world3d.ts setLevel (one hook). Nothing here touches the network or any party member's model.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { LevelDesc, V3 } from '../../../../shared/trail/levels.ts';
import { heightAt, isleEdge, polyDist, terrainGrid, type ArtPart, type StopArt } from '../../../../shared/trail/stopgen.ts';
import { loadThemeGlb, themeFileUrl } from './assets.ts';
import { buildDecor } from './art.ts';
import { outline, prng, textTexture, toonRamp } from './kit.ts';

export interface StopView {
  root: THREE.Group;
  /** meshes for the camera's collision (BVH'd by world3d in idle time) */
  blockers: THREE.Mesh[];
  flickers: THREE.PointLight[];
  tris: number;
  /** the longest synchronous slice of the build (ms): the build yields between phases so a frame can go out */
  sliceMs: number;
}

// ---------------------------------------------------------------- materials
type MatDef = { c: string; tex?: TexKind; tile?: number; e?: string; ei?: number; unlit?: boolean; side?: THREE.Side };
type TexKind = 'planks' | 'boards' | 'shingle' | 'stone' | 'marble' | 'grain' | 'rockt' | 'stripes';
const PAL: Record<string, Record<string, MatDef>> = {
  bayou: {
    wall: { c: '#4f7a52', tex: 'boards', tile: 2.2 }, plank: { c: '#a07c52', tex: 'planks', tile: 2.4 }, trim: { c: '#b7dc5a', tex: 'grain', tile: 1.5 },
    roof: { c: '#7a3f78', tex: 'shingle', tile: 1.6 }, wood: { c: '#86603c', tex: 'grain', tile: 1.2 }, wood_dark: { c: '#4d3826', tex: 'grain', tile: 1.2 },
    rock: { c: '#8a8272', tex: 'rockt', tile: 5 }, stone: { c: '#8e8c82', tex: 'stone', tile: 2 }, marble: { c: '#e6e1d4', tex: 'marble', tile: 3 },
    gold: { c: '#e2b24a' }, cloth: { c: '#ff6ab8', tex: 'stripes', tile: 2.4 }, cloth2: { c: '#3cc6e0', tex: 'stripes', tile: 2.4 }, metal: { c: '#6d7278' },
    neon: { c: '#ff58d0', e: '#ff3fd2', ei: 1.4 }, neon2: { c: '#46e8ff', e: '#35e3ff', ei: 1.4 }, glow: { c: '#ffe0a0', e: '#ffc050', ei: 1.5 },
    crystal: { c: '#9fe0ff', e: '#4fb8ff', ei: 0.9 }, rope: { c: '#c9b287' }, moss: { c: '#5f8a3a', tex: 'grain', tile: 2 }, cloud: { c: '#f2f4ff' }, paper: { c: '#efe6cc' },
  },
  skyisles: {
    wall: { c: '#ffffff', tex: 'marble', tile: 2.6 }, plank: { c: '#efe2c6', tex: 'planks', tile: 2.4 }, trim: { c: '#f0c050' },
    roof: { c: '#d8404e', tex: 'shingle', tile: 1.6 }, wood: { c: '#e9dbc2', tex: 'grain', tile: 1.2 }, wood_dark: { c: '#a8865e', tex: 'grain', tile: 1.2 },
    rock: { c: '#d0d6e8', tex: 'rockt', tile: 5 }, stone: { c: '#dcdde6', tex: 'stone', tile: 2 }, marble: { c: '#f6f3ee', tex: 'marble', tile: 3 },
    gold: { c: '#f2c14e', e: '#8a5a00', ei: 0.15 }, cloth: { c: '#e8485a', tex: 'stripes', tile: 2.4 }, cloth2: { c: '#8fc8f0', tex: 'stripes', tile: 2.4 }, metal: { c: '#b8bcc8' },
    neon: { c: '#ffd0f0', e: '#ff9ae0', ei: 1.1 }, neon2: { c: '#c8f0ff', e: '#9fe0ff', ei: 1.1 }, glow: { c: '#fff4c0', e: '#ffe070', ei: 1.5 },
    crystal: { c: '#bfe8ff', e: '#7fd0ff', ei: 1.1 }, rope: { c: '#f2c14e' }, moss: { c: '#b8e39a', tex: 'grain', tile: 2 }, cloud: { c: '#ffffff' }, paper: { c: '#fbf6ea' },
  },
  frontier: {
    wall: { c: '#a8875c', tex: 'boards', tile: 2.2 }, plank: { c: '#9c7c52', tex: 'planks', tile: 2.4 }, trim: { c: '#6e3b2a', tex: 'grain', tile: 1.5 },
    roof: { c: '#6e4a36', tex: 'shingle', tile: 1.6 }, wood: { c: '#7a5533', tex: 'grain', tile: 1.2 }, wood_dark: { c: '#4a3524', tex: 'grain', tile: 1.2 },
    rock: { c: '#9a8a78', tex: 'rockt', tile: 5 }, stone: { c: '#9a948a', tex: 'stone', tile: 2 }, marble: { c: '#e8e4dc', tex: 'marble', tile: 3 },
    gold: { c: '#d8a84a' }, cloth: { c: '#d85a4a', tex: 'stripes', tile: 2.4 }, cloth2: { c: '#4a7eb8', tex: 'stripes', tile: 2.4 }, metal: { c: '#6d7278' },
    neon: { c: '#ffb070', e: '#ff8a3a', ei: 1.0 }, neon2: { c: '#a0e0ff', e: '#60c0ff', ei: 1.0 }, glow: { c: '#ffe0a0', e: '#ffc050', ei: 1.5 },
    crystal: { c: '#9fe0ff', e: '#4fb8ff', ei: 0.9 }, rope: { c: '#c9b287' }, moss: { c: '#6a8a3a', tex: 'grain', tile: 2 }, cloud: { c: '#f4f4f4' }, paper: { c: '#efe6cc' },
  },
};
const texCache = new Map<string, THREE.Texture>();
/** Grey-scale detail textures drawn once (the material colour tints them). */
function detailTex(kind: TexKind): THREE.Texture {
  const hit = texCache.get(kind);
  if (hit) return hit;
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, r = prng(kind.length * 7919 + 13);
  const shade = (v: number) => { const x = Math.max(0, Math.min(255, Math.round(v * 255))); return `rgb(${x},${x},${x})`; };
  g.fillStyle = shade(0.9); g.fillRect(0, 0, S, S);
  if (kind === 'stripes') {
    for (let i = 0; i < 8; i++) { g.fillStyle = shade(i % 2 ? 1 : 0.62); g.fillRect(i * S / 8, 0, S / 8, S); }
  } else if (kind === 'planks' || kind === 'boards') {
    const n = kind === 'planks' ? 6 : 5;
    for (let i = 0; i < n; i++) {
      const y0 = i * S / n; g.fillStyle = shade(0.8 + r() * 0.17); g.fillRect(0, y0, S, S / n);
      for (let k = 0; k < 14; k++) { g.strokeStyle = shade(0.72 + r() * 0.12); g.lineWidth = 1 + r() * 1.5; g.beginPath(); const yy = y0 + r() * S / n; g.moveTo(0, yy); g.bezierCurveTo(S * 0.3, yy + (r() - 0.5) * 6, S * 0.7, yy + (r() - 0.5) * 6, S, yy); g.stroke(); }
      g.fillStyle = shade(0.42); g.fillRect(0, y0, S, 3);
      const cut = r() * S; g.fillRect(cut, y0, 3, S / n);
      if (kind === 'boards') for (const x of [cut - 10, cut + 12]) { g.fillStyle = shade(0.35); g.beginPath(); g.arc((x + S) % S, y0 + S / n / 2, 2.5, 0, 6.28); g.fill(); }
    }
  } else if (kind === 'shingle') {
    const rows = 8, w = S / 6;
    for (let i = 0; i < rows; i++) for (let k = -1; k < 7; k++) {
      const x = k * w + (i % 2 ? w / 2 : 0), y = i * S / rows;
      g.fillStyle = shade(0.72 + r() * 0.25); g.beginPath(); g.moveTo(x + 1, y); g.lineTo(x + w - 1, y); g.lineTo(x + w - 1, y + S / rows * 0.85); g.quadraticCurveTo(x + w / 2, y + S / rows * 1.15, x + 1, y + S / rows * 0.85); g.closePath(); g.fill();
      g.strokeStyle = shade(0.45); g.lineWidth = 2; g.stroke();
    }
  } else if (kind === 'stone' || kind === 'marble') {
    const rows = kind === 'stone' ? 6 : 4;
    for (let i = 0; i < rows; i++) for (let k = -1; k < 5; k++) {
      const w = S / (kind === 'stone' ? 3.5 : 2), x = k * w + (i % 2 ? w / 2 : 0), y = i * S / rows;
      g.fillStyle = shade(kind === 'marble' ? 0.9 + r() * 0.08 : 0.72 + r() * 0.22); g.fillRect(x + 2, y + 2, w - 4, S / rows - 4);
    }
    if (kind === 'marble') for (let k = 0; k < 10; k++) { g.strokeStyle = shade(0.78); g.lineWidth = 1; g.beginPath(); let x = r() * S, y = r() * S; g.moveTo(x, y); for (let j = 0; j < 6; j++) { x += (r() - 0.5) * 60; y += r() * 40; g.lineTo(x, y); } g.stroke(); }
  } else {
    // grain / rockt: soft noise blotches
    const n = kind === 'rockt' ? 260 : 160;
    for (let i = 0; i < n; i++) { g.fillStyle = shade(0.68 + r() * 0.3); const s = kind === 'rockt' ? 6 + r() * 26 : 2 + r() * 8; g.beginPath(); g.ellipse(r() * S, r() * S, s, kind === 'grain' ? s * 0.25 : s * (0.5 + r() * 0.5), kind === 'grain' ? 0 : r() * 3, 0, 6.28); g.fill(); }
    if (kind === 'rockt') for (let i = 0; i < 26; i++) { g.strokeStyle = shade(0.4 + r() * 0.2); g.lineWidth = 1 + r() * 2; g.beginPath(); let x = r() * S, y = r() * S; g.moveTo(x, y); for (let j = 0; j < 4; j++) { x += (r() - 0.5) * 50; y += (r() - 0.5) * 30; g.lineTo(x, y); } g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  texCache.set(kind, t);
  return t;
}
const matCache = new Map<string, THREE.Material>();
function mat(theme: string, key: string, rockTex: THREE.Texture | null): { m: THREE.Material; tile: number } {
  const d = (PAL[theme] ?? PAL.frontier)[key] ?? { c: '#aaaaaa' };
  const k = `${theme}|${key}|${rockTex ? 1 : 0}`;
  let m = matCache.get(k);
  if (!m) {
    const tm = new THREE.MeshToonMaterial({ color: new THREE.Color(d.c), gradientMap: toonRamp(), side: d.side ?? THREE.FrontSide });
    if (d.tex) tm.map = d.tex === 'rockt' && rockTex ? rockTex : detailTex(d.tex);
    if (d.e) { tm.emissive = new THREE.Color(d.e); tm.emissiveIntensity = d.ei ?? 1; }
    m = tm; matCache.set(k, m);
  }
  return { m, tile: d.tile ?? 2 };
}

// ---------------------------------------------------------------- geometry helpers (world-scaled UVs, baked transforms)
function boxGeo(he: V3, tile: number): THREE.BufferGeometry {
  const w = he[0] * 2, h = he[1] * 2, d = he[2] * 2;
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const faces: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) for (let i = 0; i < 4; i++) { const j = f * 4 + i; uv.setXY(j, uv.getX(j) * faces[f][0] / tile, uv.getY(j) * faces[f][1] / tile); }
  return g;
}
function cylGeo(r: number, r2: number, hh: number, tile: number, seg = 16): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r2, r, hh * 2, seg, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute, torso = (seg + 1) * 2;
  const circ = Math.PI * (r + r2);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, i < torso ? uv.getX(i) * circ / tile : uv.getX(i) * 2 * r / tile, i < torso ? uv.getY(i) * hh * 2 / tile : uv.getY(i) * 2 * r / tile);
  return g;
}
/** A rocky drum: a tapered cylinder with noisy radius (+ strata), open at neither end. */
function drumGeo(r0: number, r1: number, h: number, seed: number, tile: number): THREE.BufferGeometry {
  const seg = 20, rows = Math.max(2, Math.ceil(h / 1.2));
  const g = new THREE.CylinderGeometry(r1, r0, h, seg, rows);
  g.translate(0, h / 2, 0);
  const p = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute;
  const rnd = prng(seed);
  const bumps = Array.from({ length: seg * (rows + 1) + 8 }, () => rnd());
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), rr = Math.hypot(x, z);
    if (rr < 1e-3) continue;
    const a = Math.atan2(z, x), ai = Math.round(((a + Math.PI) / (2 * Math.PI)) * seg) % seg, yi = Math.round((y / h) * rows);
    const k = 1 + (bumps[yi * seg + ai] - 0.5) * 0.22 + Math.sin(y * 2.3 + seed) * 0.03;
    p.setXYZ(i, x * k, y, z * k);
  }
  const circ = Math.PI * (r0 + r1);
  const torso = (seg + 1) * (rows + 1);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, i < torso ? uv.getX(i) * circ / tile : uv.getX(i) * 2 * r0 / tile, i < torso ? uv.getY(i) * h / tile : uv.getY(i) * 2 * r0 / tile);
  g.computeVertexNormals();
  return g;
}
/** A gable roof (ridge along local X) over a w × d footprint, rising `he[1]`. Double-sided material. */
function gableGeo(he: V3, tile: number): THREE.BufferGeometry {
  const [hx, hy, hz] = he;
  const sl = Math.hypot(hz, hy);
  const P = [-hx, 0, hz, hx, 0, hz, hx, hy, 0, -hx, hy, 0, /* back */ hx, 0, -hz, -hx, 0, -hz, -hx, hy, 0, hx, hy, 0, /* gables */ -hx, 0, -hz, -hx, 0, hz, -hx, hy, 0, hx, 0, hz, hx, 0, -hz, hx, hy, 0];
  const U = [0, 0, 2 * hx, 0, 2 * hx, sl, 0, sl, 0, 0, 2 * hx, 0, 2 * hx, sl, 0, sl, 0, 0, 2 * hz, 0, hz, hy, 0, 0, 2 * hz, 0, hz, hy].map((v) => v / tile);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
  g.computeVertexNormals();
  return g;
}
function ropeGeo(a: V3, b: V3, sag: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push(new THREE.Vector3(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t)); }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.03, 5, false);
}
function ringGeo(R: number, r: number, a0: number, a1: number): THREE.BufferGeometry {
  // point(a) = R·(sin a · X + cos a · Y), a ∈ [a0, a1]  →  torus angle θ = π/2 − a
  const g = new THREE.TorusGeometry(R, r, 8, Math.max(6, Math.round((a1 - a0) * 10)), a1 - a0);
  g.rotateZ(Math.PI / 2 - a1);
  return g;
}
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpP = new THREE.Vector3(), tmpS = new THREE.Vector3(1, 1, 1);
function place(g: THREE.BufferGeometry, p: V3, q?: [number, number, number, number], s?: V3): THREE.BufferGeometry {
  tmpM.compose(tmpP.set(p[0], p[1], p[2]), q ? tmpQ.set(q[0], q[1], q[2], q[3]) : tmpQ.identity(), s ? tmpS.set(s[0], s[1], s[2]) : tmpS.set(1, 1, 1));
  return g.applyMatrix4(tmpM);
}
const yawQ = (y: number): [number, number, number, number] => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
/** position + normal + uv only, non-indexed-safe merge input */
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.index) { const n = g.attributes.position.count; g.setIndex(Array.from({ length: n }, (_, i) => i)); }
  if (!g.attributes.normal) g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- the theme pack's terrain layers
interface TerrainSet { ground: THREE.Texture; grass: THREE.Texture; mud: THREE.Texture; rock: THREE.Texture; shore: THREE.Texture; road: THREE.Texture; verge: THREE.Texture | null; detail: THREE.Texture | null; tiles: number[]; roadTile: number; packed: boolean }
const terrainSets = new Map<string, Promise<TerrainSet>>();
const loader = new THREE.TextureLoader();
function loadTex(url: string): Promise<THREE.Texture | null> {
  return new Promise((res) => loader.load(url, (t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; res(t); }, undefined, () => res(null)));
}
function flatTex(color: string, seed: number, blotch = 0.08): THREE.Texture {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, r = prng(seed), base = new THREE.Color(color);
  g.fillStyle = `#${base.getHexString()}`; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 180; i++) { const v = base.clone().offsetHSL((r() - 0.5) * 0.02, (r() - 0.5) * 0.06, (r() - 0.5) * blotch); g.fillStyle = `#${v.getHexString()}`; const s = 3 + r() * 14; g.beginPath(); g.ellipse(r() * S, r() * S, s, s * 0.7, r() * 3, 0, 6.28); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const FALLBACK_COLORS: Record<string, string[]> = {
  bayou: ['#4a5d2c', '#5d7a33', '#4b3a26', '#6a665a', '#7d7050', '#6e5a3c'], skyisles: ['#9fd08a', '#b8e39a', '#a8b08a', '#d8d2c8', '#efe6cf', '#e8dcb8'],
  frontier: ['#8b7a55', '#9aa35a', '#5a4a33', '#8a8378', '#b8a67c', '#9c8457'],
};
function terrainSet(theme: string, bi: number): Promise<TerrainSet> {
  const key = `${theme}|${bi}`;
  let p = terrainSets.get(key);
  if (!p) {
    p = (async () => {
      const fc = FALLBACK_COLORS[theme] ?? FALLBACK_COLORS.frontier;
      const fb = (): TerrainSet => ({ ground: flatTex(fc[0], 1), grass: flatTex(fc[1], 2), mud: flatTex(fc[2], 3), rock: flatTex(fc[3], 4, 0.14), shore: flatTex(fc[4], 5), road: flatTex(fc[5], 6, 0.12), verge: null, detail: null, tiles: [6, 4, 5, 6, 5], roadTile: 4, packed: false });
      try {
        const j = await fetch(themeFileUrl(theme, 'terrain/terrain.json')).then((r) => (r.ok ? r.json() : null)) as { biomes?: Record<string, { layers: Record<string, { file: string; tileM?: number }>; road?: { file: string; tileM?: number }; verge?: { file: string }; detail?: string }> } | null;
        const biomes = j?.biomes ? Object.values(j.biomes) : [];
        const b = biomes[Math.min(bi, biomes.length - 1)];
        if (!b) return fb();
        const L = b.layers, get = (f?: string) => (f ? loadTex(themeFileUrl(theme, f)) : Promise.resolve(null));
        const [ground, grass, mud, rock, shore, road, verge, detail] = await Promise.all([get(L.ground?.file), get(L.grass?.file), get(L.mud?.file), get(L.rock?.file), get(L.shore?.file), get(b.road?.file), get(b.verge?.file), get(b.detail)]);
        const f = fb();
        return { ground: ground ?? f.ground, grass: grass ?? f.grass, mud: mud ?? f.mud, rock: rock ?? f.rock, shore: shore ?? f.shore, road: road ?? f.road, verge, detail,
          tiles: ['ground', 'grass', 'mud', 'rock', 'shore'].map((k, i) => L[k]?.tileM ?? f.tiles[i]), roadTile: b.road?.tileM ?? 4, packed: !!ground };
      } catch { return fb(); }
    })();
    terrainSets.set(key, p);
  }
  return p;
}
function terrainMaterial(ts: TerrainSet): THREE.MeshToonMaterial {
  const m = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: toonRamp(), map: ts.ground });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tGrass = { value: ts.grass }; sh.uniforms.tMud = { value: ts.mud }; sh.uniforms.tRock = { value: ts.rock }; sh.uniforms.tShore = { value: ts.shore };
    sh.uniforms.tDetail = { value: ts.detail ?? ts.ground }; sh.uniforms.uTiles = { value: new THREE.Vector4(1 / ts.tiles[0], 1 / ts.tiles[1], 1 / ts.tiles[2], 1 / ts.tiles[3]) }; sh.uniforms.uTileSh = { value: 1 / ts.tiles[4] };
    sh.uniforms.uDetail = { value: ts.detail ? 1 : 0 };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec4 splat;\nvarying vec4 vSplat;\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat;\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform sampler2D tGrass; uniform sampler2D tMud; uniform sampler2D tRock; uniform sampler2D tShore; uniform sampler2D tDetail; uniform vec4 uTiles; uniform float uTileSh; uniform float uDetail;\nvarying vec4 vSplat;\nvarying vec3 vWP;\nvarying vec3 vWN;')
      .replace('#include <map_fragment>', `
        vec2 wuv = vWP.xz;
        vec3 cG = texture2D(map, wuv * uTiles.x).rgb;
        vec3 cGr = texture2D(tGrass, wuv * uTiles.y + 0.37).rgb;
        vec3 cM = texture2D(tMud, wuv * uTiles.z + 0.11).rgb;
        vec3 n = abs(normalize(vWN)); n = n / (n.x + n.y + n.z);
        vec3 cR = texture2D(tRock, vWP.zy * uTiles.w).rgb * n.x + texture2D(tRock, vWP.xz * uTiles.w).rgb * n.y + texture2D(tRock, vWP.xy * uTiles.w).rgb * n.z;
        vec3 cS = texture2D(tShore, wuv * uTileSh + 0.71).rgb;
        vec3 col = cG;
        col = mix(col, cGr, smoothstep(0.25, 0.75, vSplat.x));
        col = mix(col, cM, smoothstep(0.2, 0.7, vSplat.y));
        col = mix(col, cS, smoothstep(0.2, 0.7, vSplat.w));
        col = mix(col, cR, smoothstep(0.3, 0.7, vSplat.z));
        if (uDetail > 0.5) col *= mix(0.86, 1.12, texture2D(tDetail, wuv * 0.23).r);
        diffuseColor.rgb *= col;`);
  };
  m.customProgramCacheKey = () => 'trail-stop-terrain';
  return m;
}

// ---------------------------------------------------------------- kits (SCENERY_<id> templates, instanced)
const kitSets = new Map<string, Promise<Map<string, THREE.Object3D>>>();
function kitSet(theme: string): Promise<Map<string, THREE.Object3D>> {
  let p = kitSets.get(theme);
  if (!p) {
    p = (async () => {
      const out = new Map<string, THREE.Object3D>();
      for (const rel of ['scatter.glb', 'levels/trail_road.glb']) {
        const g = await loadThemeGlb(theme, rel).catch(() => null);
        if (!g) continue;
        g.updateMatrixWorld(true);
        g.traverse((o) => { const m = /^SCENERY_(.+)$/.exec(o.name); if (m && !/_(mesh|LOD\d)$/.test(o.name) && !out.has(m[1])) out.set(m[1], o); });
      }
      return out;
    })();
    kitSets.set(theme, p);
  }
  return p;
}

// ---------------------------------------------------------------- build
export async function buildStopView(desc: LevelDesc, o: { night: boolean }): Promise<StopView | null> {
  const art = desc.art as StopArt | undefined, T = desc.terrain;
  if (!art || !T) return null;
  const theme = desc.theme, spec = T.spec;
  const root = new THREE.Group(); root.name = 'STOPGEN';
  const blockers: THREE.Mesh[] = [], flickers: THREE.PointLight[] = [];
  let tris = 0;
  const [ts, kits] = await Promise.all([terrainSet(theme, art.bi), kitSet(theme)]);
  let sliceMs = 0, t0 = performance.now();
  const breathe = async () => { sliceMs = Math.max(sliceMs, performance.now() - t0); await new Promise((r) => setTimeout(r, 0)); t0 = performance.now(); };
  const isles = !!spec.isles?.length;
  const waters = desc.water;
  const nearWater = (x: number, z: number) => { for (const w of waters) if (Math.abs(x - w.p[0]) <= w.he[0] + 2 && Math.abs(z - w.p[2]) <= w.he[2] + 2) return w.level; return null; };
  // ---- the ground: the physics grid (1 m) + a coarse backdrop ring to the horizon
  const paint = art.paint;
  const splatAt = (x: number, z: number, h: number, ny: number, out: number[], far = false) => {
    let grass = (theme === 'skyisles' ? 0.62 : 0.4) + (noise2(x * 0.11, z * 0.11) - 0.5) * 1.2, mud = 0, rock = Math.max(0, Math.min(1, (0.93 - ny) * 5)), shore = 0;
    const wl = nearWater(x, z);
    if (wl !== null && h < wl + 0.32) shore = Math.max(shore, Math.min(1, (wl + 0.32 - h) * 4));
    for (let i = 0; i < paint.length; i += 4) {
      const d = Math.hypot(x - paint[i + 1], z - paint[i + 2]), r = paint[i + 3];
      if (d > r) continue;
      const k = paint[i], w = Math.max(0, Math.min(1, (1 - d / r) * 1.6 + (noise2(x * 0.35 + i, z * 0.35) - 0.5) * 1.1 - 0.25));
      if (k === 0) mud = Math.max(mud, w * 1.3); else if (k === 1) rock = Math.max(rock, w); else if (k === 2) shore = Math.max(shore, w * 1.2); else if (k === 3) grass += w; else grass -= w * 1.2;
    }
    if (isles) { const e = isleEdge(spec, x, z).e; if (e > 0.86) rock = Math.max(rock, (e - 0.86) * 8); }
    if (far) grass += 0.25;
    out.push(Math.max(0, Math.min(1, grass)), Math.min(1, mud), Math.min(1, rock), Math.min(1, shore));
  };
  const grid = terrainGrid(T);
  await breathe();
  const n = T.n, step = T.size / (n - 1), x0 = T.cx - T.size / 2, z0 = T.cz - T.size / 2;
  const addGround = (nx: number, nz: number, stepX: number, gx0: number, gz0: number, hAt: (ix: number, iz: number, x: number, z: number) => number, keepQuad: (ix: number, iz: number) => boolean, far: boolean) => {
    const pos = new Float32Array(nx * nz * 3), hs = new Float32Array(nx * nz), vd = new Uint8Array(nx * nz);
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const x = gx0 + ix * stepX, z = gz0 + iz * stepX; let h = hAt(ix, iz, x, z);
      if (h < -10) { vd[iz * nx + ix] = 1; h = -3.5; }
      hs[iz * nx + ix] = h; pos.set([x, h, z], (iz * nx + ix) * 3);
    }
    // island rims: pull each void vertex that borders ground half-way toward it (a softer outline than the 1 m grid's steps)
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix; if (!vd[i]) continue;
      let ax = 0, az = 0, k = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const jx = ix + dx, jz = iz + dz; if (jx < 0 || jz < 0 || jx >= nx || jz >= nz || vd[jz * nx + jx]) continue; ax += pos[(jz * nx + jx) * 3]; az += pos[(jz * nx + jx) * 3 + 2]; k++; }
      if (k) { pos[i * 3] += (ax / k - pos[i * 3]) * 0.5; pos[i * 3 + 2] += (az / k - pos[i * 3 + 2]) * 0.5; }
    }
    const idx: number[] = [];
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      if (!keepQuad(ix, iz)) continue;
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      if (!(vd[a] && vd[c] && vd[b])) idx.push(a, c, b);
      if (!(vd[b] && vd[c] && vd[d])) idx.push(b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const nrm = g.attributes.normal as THREE.BufferAttribute, sp: number[] = [];
    for (let i = 0; i < nx * nz; i++) splatAt(pos[i * 3], pos[i * 3 + 2], hs[i], nrm.getY(i), sp, far);
    g.setAttribute('splat', new THREE.Float32BufferAttribute(sp, 4));
    const m = new THREE.Mesh(g, terrainMaterial(ts));
    m.receiveShadow = true; m.castShadow = false; m.name = far ? 'STOP_backdrop' : 'STOP_ground';
    root.add(m); tris += idx.length / 3;
    return m;
  };
  const ground = addGround(n, n, step, x0, z0, (ix, iz) => grid[iz * n + ix], () => true, false);
  blockers.push(ground);
  await breathe();
  if (!isles) {
    const half = T.size / 2, R = half + 110, st = 4, nn = Math.ceil((2 * R) / st) + 1;
    const far = addGround(nn, nn, st, -R, -R, (_ix, _iz, x, z) => {
      const d = Math.max(Math.abs(x), Math.abs(z)) - half;
      return heightAt(spec, x, z) + (d > 4 ? Math.pow(d / 40, 1.4) * (6 + noise2(x * 0.02, z * 0.02) * 16) : 0) - 0.06;
    }, (ix, iz) => { const x = -R + (ix + 0.5) * st, z = -R + (iz + 0.5) * st; return Math.max(Math.abs(x), Math.abs(z)) > half - 2; }, true);
    void far;
  } else {
    // island undersides + the cloud sea
    for (const s of spec.isles!) {
      const r = Math.max(s.rx, s.rz), h = r * 0.75 + 4;
      const g = new THREE.ConeGeometry(r * 1.02, h, 18, 4, true);
      g.rotateX(Math.PI); g.translate(0, -h / 2, 0);
      const p = g.attributes.position as THREE.BufferAttribute, rnd = prng(Math.round(s.x * 31 + s.z * 17));
      for (let i = 0; i < p.count; i++) { const k = 1 + (rnd() - 0.5) * 0.18; p.setXYZ(i, p.getX(i) * k * (s.rx / r), p.getY(i), p.getZ(i) * k * (s.rz / r)); }
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat(theme, 'rock', ts.packed ? ts.rock : null).m);
      m.position.set(s.x, s.h - 3.3, s.z); root.add(m); tris += 18 * 4 * 2;
    }
    if (art.cloudSea !== undefined) {
      const c = document.createElement('canvas'); c.width = c.height = 256; const g2 = c.getContext('2d')!, r = prng(5);
      g2.fillStyle = '#e6ecff'; g2.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 90; i++) { const x = r() * 256, y = r() * 256, s = 12 + r() * 40; const gr = g2.createRadialGradient(x, y, 0, x, y, s); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g2.fillStyle = gr; g2.fillRect(x - s, y - s, s * 2, s * 2); }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(14, 14); t.colorSpace = THREE.SRGBColorSpace;
      const sea = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshBasicMaterial({ map: t, color: new THREE.Color(desc.sky.bottom).lerp(new THREE.Color('#ffffff'), 0.5) }));
      sea.rotation.x = -Math.PI / 2; sea.position.y = art.cloudSea; root.add(sea);
    }
  }
  // the river goes on past the walls (a plain water band; the sim's water is world3d's)
  if (desc.kind === 'river' && desc.water[0] && spec.chans[0]) {
    const w = desc.water[0], ch = spec.chans[0];
    for (const side of [-1, 1]) {
      const xs: number[] = [], zs: number[] = [];
      for (let i = 0; i < ch.xs.length; i++) if (side * ch.xs[i] >= w.he[0] - 1) { xs.push(ch.xs[i]); zs.push(ch.zs[i]); }
      if (xs.length < 2) continue;
      const ribbon = ribbonGeo(xs.flatMap((x, i) => [x, zs[i]]), ch.half * 2 + ch.bank * 1.2, () => w.level - 0.01, 1);
      const m = new THREE.Mesh(ribbon, new THREE.MeshBasicMaterial({ color: w.color ?? '#3f6b3a', transparent: true, opacity: 0.8, depthWrite: false }));
      m.renderOrder = 2; root.add(m);
    }
  }
  await breathe();
  // ---- roads (the biome's road texture + verge strips)
  const roadMat = new THREE.MeshToonMaterial({ map: ts.road, gradientMap: toonRamp(), color: '#ffffff', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const vergeMat = ts.verge ? new THREE.MeshToonMaterial({ map: ts.verge, gradientMap: toonRamp(), transparent: true, alphaTest: 0.25, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }) : null;
  const hAtW = (x: number, z: number) => { const ix = Math.round((x - x0) / step), iz = Math.round((z - z0) / step); return ix >= 0 && iz >= 0 && ix < n && iz < n ? heightAt(spec, x, z) : heightAt(spec, x, z) - 0.06; };
  for (const rd of art.roads) {
    const w = rd.k === 'path' ? rd.w * 0.8 : rd.w;
    const g = ribbonGeo(rd.pts, w, (x, z) => hAtW(x, z) + 0.05, ts.roadTile, 5);
    const m = new THREE.Mesh(g, roadMat); m.receiveShadow = true; root.add(m); tris += g.index!.count / 3;
    if (vergeMat) for (const side of [-1, 1]) { const vg = ribbonGeo(rd.pts, 1.2, (x, z) => hAtW(x, z) + 0.06, 4, 3, side * (w / 2 + 0.55), side); const vm = new THREE.Mesh(vg, vergeMat); root.add(vm); }
  }
  // ---- structures: colliders by material + visual parts, merged per material
  const rockTex = ts.packed ? ts.rock : null;
  const buckets = new Map<string, THREE.BufferGeometry[]>();
  const put = (key: string, g: THREE.BufferGeometry) => { if (!key) { g.dispose(); return; } let b = buckets.get(key); if (!b) buckets.set(key, (b = [])); b.push(clean(g)); };
  desc.cols.forEach((c, i) => {
    const key = art.colMat[i];
    if (!key || c.tag === 'invisible') return;
    const tile = mat(theme, key, rockTex).tile;
    if (c.shape === 'box' && c.he) put(key, place(boxGeo(c.he, tile), c.p, c.q));
    else if (c.shape === 'cylinder') put(key, place(cylGeo(c.r!, c.r!, c.hh!, tile, c.r! > 2 ? 28 : 14), c.p, c.q));
  });
  const signs: THREE.Object3D[] = [];
  for (const pt of art.parts) {
    const tile = 'm' in pt && pt.m ? mat(theme, pt.m, rockTex).tile : 1;
    switch (pt.t) {
      case 'box': put(pt.m, place(boxGeo(pt.he, tile), pt.p, pt.q)); break;
      case 'cyl': put(pt.m, place(cylGeo(pt.r, pt.r2 ?? pt.r, pt.hh, tile, pt.seg ?? 14), pt.p, pt.q)); break;
      case 'ball': put(pt.m, place(new THREE.SphereGeometry(1, 12, 8), pt.p, undefined, pt.s)); break;
      case 'gable': put(pt.m, place(gableGeo(pt.he, tile), pt.p, yawQ(pt.yaw))); break;
      case 'rope': put(pt.m ?? 'rope', ropeGeo(pt.a, pt.b, pt.sag)); break;
      case 'drum': put(pt.m, place(drumGeo(pt.r0, pt.r1, pt.h, pt.seed, tile), pt.p)); break;
      case 'ring': put(pt.m, place(ringGeo(pt.R, pt.r, pt.a0, pt.a1), pt.p, yawQ(pt.yaw))); break;
      case 'sign': signs.push(buildSign(pt, theme)); break;
    }
  }
  for (const [key, list] of buckets) {
    const g = mergeGeometries(list, false);
    for (const x of list) x.dispose();
    if (!g) continue;
    const m = new THREE.Mesh(g, key === 'roof' || key === 'cloth' || key === 'cloth2' ? doubleSided(mat(theme, key, rockTex).m) : mat(theme, key, rockTex).m);
    m.castShadow = !['rope', 'glow', 'neon', 'neon2', 'crystal', 'cloud'].includes(key); m.receiveShadow = true; m.name = `STOP_${key}`;
    root.add(m); tris += (g.index?.count ?? g.attributes.position.count) / 3;
    if (!['rope', 'glow', 'neon', 'neon2', 'crystal', 'cloud', 'gold'].includes(key)) { outline(m, 0.0022); blockers.push(m); }
  }
  for (const s of signs) root.add(s);
  await breathe();
  // ---- theme kit pieces (instanced per template mesh; placeholder decor when the pack has no kit)
  const at = art.kit.at;
  const byId = new Map<number, number[]>();
  for (let j = 0; j < at.length; j += 6) { const l = byId.get(at[j]); if (l) l.push(j); else byId.set(at[j], [j]); }
  const pm = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), rel = new THREE.Matrix4(), inv = new THREE.Matrix4();
  for (const [ii, list] of byId) {
    const id = art.kit.ids[ii], tpl = kits.get(id);
    if (tpl) {
      inv.copy(tpl.matrixWorld).invert();
      const meshes: THREE.Mesh[] = [];
      tpl.traverse((x) => { const mm = x as THREE.Mesh; if (!mm.isMesh) return; for (let y: THREE.Object3D | null = mm; y && y !== tpl.parent; y = y.parent) if (!y.visible) return; meshes.push(mm); });
      for (const mm of meshes) {
        rel.multiplyMatrices(inv, mm.matrixWorld);
        const im = new THREE.InstancedMesh(mm.geometry, mm.material, list.length);
        list.forEach((j, k) => { pm.compose(pv.set(at[j + 1], at[j + 2], at[j + 3]), q.setFromAxisAngle(sv.set(0, 1, 0), at[j + 4] / 100), sv.setScalar(at[j + 5] / 100)); pm.multiply(rel); im.setMatrixAt(k, pm); });
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false; im.name = `KIT_${id}`;
        root.add(im);
        tris += ((mm.geometry.index?.count ?? mm.geometry.attributes.position.count) / 3) * list.length;
      }
    } else {
      for (const j of list) { const d = buildDecor(art.kit.fb[ii], theme, at[j + 5] / 100); d.position.set(at[j + 1], at[j + 2], at[j + 3]); d.rotation.y = at[j + 4] / 100; root.add(d); }
    }
  }
  // ---- tall grass cards + lily pads
  if (art.grass.length) {
    const cards: [number, number, number, number, number][] = [];
    const r = prng(art.grass.length * 131 + 7);
    for (let i = 0; i < art.grass.length; i += 4) {
      const [gx, gz, hx, hz] = [art.grass[i], art.grass[i + 1], art.grass[i + 2], art.grass[i + 3]];
      const nC = Math.round(hx * hz * 4 * 1.6);
      for (let k = 0; k < nC; k++) { const x = gx + (r() * 2 - 1) * hx, z = gz + (r() * 2 - 1) * hz; cards.push([x, hAtW(x, z) - 0.05, z, r() * Math.PI, 0.9 + r() * 0.55]); }
    }
    const geo = new THREE.PlaneGeometry(1.1, 1, 1, 1); geo.translate(0, 0.5, 0);
    const gm = new THREE.MeshToonMaterial({ map: bladesTex(theme), gradientMap: toonRamp(), alphaTest: 0.45, side: THREE.DoubleSide, color: '#ffffff' });
    const im = new THREE.InstancedMesh(geo, gm, cards.length * 2);
    cards.forEach(([x, y, z, yaw, s], k) => { for (let t = 0; t < 2; t++) { pm.compose(pv.set(x, y, z), q.setFromAxisAngle(sv.set(0, 1, 0), yaw + t * Math.PI / 2), sv.set(s, s * 1.05, s)); im.setMatrixAt(k * 2 + t, pm); } });
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.receiveShadow = true; im.name = 'STOP_tallgrass';
    root.add(im); tris += cards.length * 4;
  }
  if (art.lily?.length) {
    const geo = new THREE.CircleGeometry(1, 12, 0.3, Math.PI * 1.85); geo.rotateX(-Math.PI / 2);
    const im = new THREE.InstancedMesh(geo, new THREE.MeshToonMaterial({ color: '#4f9a3a', gradientMap: toonRamp(), side: THREE.DoubleSide }), art.lily.length / 3);
    for (let i = 0; i < art.lily.length; i += 3) { const x = art.lily[i], z = art.lily[i + 1]; pm.compose(pv.set(x, (nearWater(x, z) ?? 0) + 0.03, z), q.setFromAxisAngle(sv.set(0, 1, 0), i * 1.7), sv.setScalar(art.lily[i + 2])); im.setMatrixAt(i / 3, pm); }
    im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; root.add(im);
  }
  // ---- lights (the view keeps ≤ 5)
  for (const l of art.lights.slice(0, 5)) {
    if (l.n && !o.night) continue;
    const base = l.i * (o.night ? 16 : 7);
    const pl = new THREE.PointLight(l.c, base, l.r, 2);
    pl.position.set(...l.p); pl.userData.base = base;
    root.add(pl);
    if (l.f) flickers.push(pl);
  }
  root.updateMatrixWorld(true);
  sliceMs = Math.max(sliceMs, performance.now() - t0);
  return { root, blockers, flickers, tris: Math.round(tris), sliceMs: Math.round(sliceMs * 10) / 10 };
}

function doubleSided(m: THREE.Material): THREE.Material {
  const k = `ds|${m.uuid}`;
  let d = matCache.get(k);
  if (!d) { d = m.clone(); d.side = THREE.DoubleSide; matCache.set(k, d); }
  return d;
}
/** A ribbon along a polyline (x, z pairs): `w` wide, y from `hAt`, v along its length / `tile`; `off` shifts it sideways
 *  (verge strips), `vSide` flips the verge texture's V (0 at the road edge). */
function ribbonGeo(pts: number[], w: number, hAt: (x: number, z: number) => number, tile: number, across = 3, off = 0, vSide = 0): THREE.BufferGeometry {
  const P: number[] = [], U: number[] = [], I: number[] = [];
  const m = pts.length / 2;
  let s = 0;
  for (let i = 0; i < m; i++) {
    const x = pts[i * 2], z = pts[i * 2 + 1];
    const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
    let tx = pts[b * 2] - pts[a * 2], tz = pts[b * 2 + 1] - pts[a * 2 + 1]; const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
    if (i > 0) s += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1]);
    for (let k = 0; k < across; k++) {
      const u = k / (across - 1), o = off + (u - 0.5) * w;
      const px = x - tz * o, pz = z + tx * o;
      P.push(px, hAt(px, pz), pz);
      if (vSide) U.push(s / tile, vSide > 0 ? u : 1 - u); else U.push(u, s / tile);
    }
    if (i > 0) for (let k = 0; k < across - 1; k++) { const a0 = (i - 1) * across + k, b0 = i * across + k; I.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I); g.computeVertexNormals();
  return g;
}
const signStyle: Record<string, { bg: string; fg: string; border?: string; unlit?: boolean }> = {
  board: { bg: '#e6d4a8', fg: '#3a2616', border: '#6b4a2e' }, swamp: { bg: '#1c3a26', fg: '#b8ff5a', border: '#8dff3a' }, neon: { bg: '#140e1c', fg: '#ff66dc', border: '#35e3ff', unlit: true },
  gold: { bg: '#fbf6ea', fg: '#9a6a10', border: '#f2c14e' }, paper: { bg: '#f4ecd8', fg: '#3a3020', border: '#b8a070' }, wall: { bg: '#ece2cc', fg: '#6a3a1a', border: '#8a6a44' },
};
function buildSign(pt: Extract<ArtPart, { t: 'sign' }>, theme: string): THREE.Object3D {
  const st = signStyle[pt.style] ?? signStyle.board;
  const g = new THREE.Group();
  const W = 512, H = Math.max(96, Math.round(512 * pt.h / pt.w));
  const tex = textTexture(pt.text.map((t) => t.slice(0, 28)), { w: W, h: Math.min(512, H), bg: st.bg, fg: st.fg, border: st.border });
  const face = new THREE.Mesh(new THREE.PlaneGeometry(pt.w, pt.h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  face.position.z = 0.035;
  const back = new THREE.Mesh(new THREE.BoxGeometry(pt.w + 0.08, pt.h + 0.08, 0.06), mat(theme, pt.style === 'gold' ? 'gold' : 'wood_dark', null).m);
  g.add(back, face);
  g.position.set(...pt.p); g.rotation.y = pt.yaw;
  return g;
}
let blades: THREE.Texture | null = null;
function bladesTex(theme: string): THREE.Texture {
  if (blades && blades.userData.theme === theme) return blades;
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, r = prng(theme.length * 97 + 3);
  const cols = theme === 'skyisles' ? ['#9fdc7a', '#b8ec90', '#86c86a', '#d8f0a0'] : theme === 'bayou' ? ['#5d8a33', '#6f9a3a', '#4f7a2a', '#8aa84e'] : ['#9aa84e', '#b0b860', '#8a9a44', '#c8c070'];
  for (let i = 0; i < 70; i++) {
    const x = 8 + r() * (S - 16), h = S * (0.55 + r() * 0.45), bend = (r() - 0.5) * 40, w = 3 + r() * 5;
    g.fillStyle = cols[Math.floor(r() * cols.length)];
    g.beginPath(); g.moveTo(x - w, S); g.quadraticCurveTo(x + bend * 0.4, S - h * 0.6, x + bend, S - h); g.quadraticCurveTo(x + bend * 0.4 + 1, S - h * 0.6, x + w, S); g.closePath(); g.fill();
  }
  if (theme !== 'frontier') for (let i = 0; i < 10; i++) { g.fillStyle = theme === 'skyisles' ? '#ffe0f0' : '#ff9ad8'; g.beginPath(); g.arc(10 + r() * (S - 20), S * (0.1 + r() * 0.4), 3 + r() * 3, 0, 6.28); g.fill(); }
  blades = new THREE.CanvasTexture(c); blades.colorSpace = THREE.SRGBColorSpace; blades.userData.theme = theme;
  return blades;
}
/** cheap smooth 2-D value noise (visual only) */
function noise2(x: number, z: number): number {
  const h = (a: number, b: number) => { let t = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); t = Math.imul(t ^ (t >>> 13), 1274126177); return ((t ^ (t >>> 16)) >>> 0) / 4294967296; };
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h(xi, zi), b = h(xi + 1, zi), c = h(xi, zi + 1), d = h(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
void polyDist;
