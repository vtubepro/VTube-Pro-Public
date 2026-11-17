// 2D environments: a room made of flat layers (pictures, or drawn gradients / hill silhouettes) at different depths
// behind the performers — a "2.5D" stage with real parallax whenever the camera moves, plus an optional slow ambient
// drift. It is an ordinary room (scene.json + a tiny glTF of spots / door / path, cameras in scene.json `cams`), so
// spots, cameras, multi-performer shows, entrances and every avatar kind (3D, 2D cards, walking TVs) work in it; the
// scene.json `flat2d` key turns on the layer engine (src/scene/flat2d/flat2dScene.ts). Pure: the server's "make a 2D
// room from pictures" route, the shipped sample room's build script and the engine all use it. Docs: docs/FLAT_AVATARS.md.
import { safeRel } from './flatAvatar.ts';

export interface Flat2dHills { color: string; /** silhouette height, fraction of the layer */ height: number; seed: number; /** bumps across */ bumps: number; /** 0 = round hills … 1 = jagged peaks */ jag?: number }
/** A sky: vertical gradient, an optional sun (x / y = place in the view 0..1, size = fraction of the view height). */
export interface Flat2dSky { top: string; horizon: string; sun?: { x: number; y: number; color: string; size: number } }
export interface Flat2dClouds { color: string; seed: number; count: number }
export interface Flat2dTrees { color: string; seed: number; count: number; kind: 'round' | 'pine'; /** fraction of the layer */ height: number }
/** A strip of grass blades (foreground: a negative depth puts it in front of the performers' feet); height in metres. */
export interface Flat2dGrass { color: string; seed: number; height: number }
/** A framing element at the edge of the wide shot, in front of the performers (negative depth). */
export interface Flat2dFrame { kind: 'tree' | 'bushes'; color: string; side: 'left' | 'right' | 'both'; seed: number }
export interface Flat2dLayer {
  /** A picture in the room folder (transparent PNG / WebP / JPEG); or one of the kinds drawn by the engine. */
  file?: string;
  gradient?: [top: string, bottom: string];
  sky?: Flat2dSky;
  clouds?: Flat2dClouds;
  hills?: Flat2dHills;
  trees?: Flat2dTrees;
  grass?: Flat2dGrass;
  frame?: Flat2dFrame;
  /** Metres behind the performers' line (z = 0). Bigger = farther = less parallax and more haze. Negative = in front
   *  (grass at their feet, framing elements at the edges). */
  depth: number;
  /** Bottom edge height (m). Default 0 (stands on the ground); sky layers go lower to always cover the view. */
  y?: number;
  /** Size: 'cover' (default) = wide enough for every camera; a number = this width in metres (keeps the picture's aspect). */
  width?: 'cover' | number;
  /** Repeat the picture sideways (clouds, endless hills). */
  repeat?: boolean;
  /** Sideways scroll speed (m/s, repeat layers): drifting clouds. */
  scroll?: number;
  /** 0..1 the top of the layer sways in the wind (grass, leaves). */
  sway?: number;
  opacity?: number;
}
export interface Flat2dConfig {
  layers: Flat2dLayer[];
  /** The floor the performers stand on: a picture (tiled) or a colour (drawn as a grass / floor texture), out to the
   *  farthest layer. */
  ground?: { file?: string; color?: string; tile?: number };
  /** 0..1 slow ambient sway of the layers (as if the camera breathed sideways): parallax even on a still camera. */
  drift: number;
  /** Atmospheric perspective: far layers fade toward this colour (strength 0..1 at the farthest layer). */
  haze?: { color: string; strength: number };
  /** Drifting motes in the air (pollen, dust, embers): count, colour, size (m). */
  particles?: { color: string; count: number; size: number };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const col = (v: unknown): string | null => (typeof v === 'string' && COLOR.test(v) ? v : null);
const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null);

export function sanitizeFlat2d(v: unknown): Flat2dConfig | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  const layers: Flat2dLayer[] = [];
  for (const raw of Array.isArray(b.layers) ? b.layers.slice(0, 20) : []) {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const l: Flat2dLayer = { depth: num(o.depth, -10, 400, 20) };
    const f = safeRel(o.file);
    const sk = obj(o.sky), cl = obj(o.clouds), h = obj(o.hills), tr = obj(o.trees), gr = obj(o.grass), fr = obj(o.frame);
    if (f) l.file = f;
    else if (Array.isArray(o.gradient) && o.gradient.length === 2 && o.gradient.every((c) => col(c))) l.gradient = [o.gradient[0] as string, o.gradient[1] as string];
    else if (sk && col(sk.top) && col(sk.horizon)) {
      const sun = obj(sk.sun);
      l.sky = { top: col(sk.top)!, horizon: col(sk.horizon)!, ...(sun && col(sun.color) ? { sun: { x: num(sun.x, 0, 1, 0.7), y: num(sun.y, 0, 1, 0.3), color: col(sun.color)!, size: num(sun.size, 0.01, 0.4, 0.06) } } : {}) };
    } else if (cl && col(cl.color)) l.clouds = { color: col(cl.color)!, seed: Math.round(num(cl.seed, 0, 1e6, 1)), count: Math.round(num(cl.count, 1, 30, 8)) };
    else if (h && col(h.color)) l.hills = { color: col(h.color)!, height: num(h.height, 0.05, 1, 0.4), seed: Math.round(num(h.seed, 0, 1e6, 1)), bumps: num(h.bumps, 1, 40, 5), ...(typeof h.jag === 'number' ? { jag: num(h.jag, 0, 1, 0) } : {}) };
    else if (tr && col(tr.color)) l.trees = { color: col(tr.color)!, seed: Math.round(num(tr.seed, 0, 1e6, 1)), count: Math.round(num(tr.count, 1, 60, 16)), kind: tr.kind === 'pine' ? 'pine' : 'round', height: num(tr.height, 0.1, 1, 0.5) };
    else if (gr && col(gr.color)) l.grass = { color: col(gr.color)!, seed: Math.round(num(gr.seed, 0, 1e6, 1)), height: num(gr.height, 0.05, 1.5, 0.3) };
    else if (fr && col(fr.color)) l.frame = { kind: fr.kind === 'bushes' ? 'bushes' : 'tree', color: col(fr.color)!, side: fr.side === 'left' || fr.side === 'right' ? fr.side : 'both', seed: Math.round(num(fr.seed, 0, 1e6, 1)) };
    else continue;
    // (only grass and framing elements may stand in front of the performers)
    if (l.depth < 0.5 && !l.grass && !l.frame) l.depth = 0.5;
    if (typeof o.y === 'number') l.y = num(o.y, -100, 100, 0);
    if (typeof o.width === 'number') l.width = num(o.width, 0.5, 2000, 20);
    if (o.repeat === true) l.repeat = true;
    if (typeof o.scroll === 'number') l.scroll = num(o.scroll, -5, 5, 0);
    if (typeof o.sway === 'number') l.sway = num(o.sway, 0, 1, 0);
    if (typeof o.opacity === 'number') l.opacity = num(o.opacity, 0, 1, 1);
    layers.push(l);
  }
  if (!layers.length) return null;
  layers.sort((a, b2) => b2.depth - a.depth);   // far → near (drawing order)
  const out: Flat2dConfig = { layers, drift: num(b.drift, 0, 1, 0.35) };
  const g = obj(b.ground);
  if (g) {
    const gf = safeRel(g.file);
    out.ground = { ...(gf ? { file: gf } : {}), ...(col(g.color) ? { color: col(g.color)! } : {}), tile: num(g.tile, 0.2, 50, 2) };
  }
  const hz = obj(b.haze);
  if (hz && col(hz.color)) out.haze = { color: col(hz.color)!, strength: num(hz.strength, 0, 1, 0.6) };
  const pt = obj(b.particles);
  if (pt && col(pt.color)) out.particles = { color: col(pt.color)!, count: Math.round(num(pt.count, 0, 300, 60)), size: num(pt.size, 0.005, 0.3, 0.04) };
  return out;
}

// ---------------------------------------------------------------- the room around the layers
export interface Flat2dRoomOptions {
  /** Performer places side by side on the ground line (1 … 8). */
  spots: number;
  /** Gap between places (m). */
  gap?: number;
}

/** The room's glTF (empties only: SPOT_xx facing the camera, DOOR + DOOR_OUTSIDE + PATH_xx entering from the left)
 *  and its scene.json camera / ambience keys. The layers + ground are drawn by the engine, not the glTF. */
export function flat2dRoomFiles(name: string, flat2d: Flat2dConfig, o: Flat2dRoomOptions): { gltf: Record<string, unknown>; sceneJson: Record<string, unknown> } {
  const n = Math.max(1, Math.min(8, Math.round(o.spots)));
  const gap = o.gap ?? 1.25;
  const nodes: Record<string, unknown>[] = [];
  const xs = Array.from({ length: n }, (_, i) => (i - (n - 1) / 2) * gap);
  xs.forEach((x, i) => nodes.push({ name: `SPOT_${String(i + 1).padStart(2, '0')}`, translation: [+x.toFixed(3), 0, 0], extras: { pose: 'stand', label: `Place ${i + 1}` } }));
  const left = (xs[0] ?? 0) - 3.2;
  // the entrance: walk in from off-screen left along the ground line (a 2D stage has no real door)
  nodes.push({ name: 'DOOR_OUTSIDE', translation: [+(left - 2.5).toFixed(3), 0, 0.4], rotation: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] });
  nodes.push({ name: 'DOOR', translation: [+left.toFixed(3), 0, 0.4] });
  nodes.push({ name: 'PATH_01', translation: [+(left + 1.2).toFixed(3), 0, 0.4] });
  const gltf = { asset: { version: '2.0', generator: 'VTube Pro 2D environment' }, scene: 0, scenes: [{ name, nodes: nodes.map((_, i) => i) }], nodes };
  // cameras: a wide shot of everyone, a talk shot per place, a slightly lower "hero" angle
  const span = Math.max(2.4, n * gap + 1.2);
  const wideZ = +(span * 0.95 + 2.4).toFixed(2);
  const cams: Record<string, unknown> = {
    CAM_WIDE: { pos: [0, 1.35, wideZ], target: [0, 1.1, 0], fov: 35 },
    CAM_GROUP: { pos: [0, 1.4, +(wideZ * 0.8).toFixed(2)], target: [0, 1.2, 0], fov: 35 },
    CAM_LOW: { pos: [0.6, 0.75, +(wideZ * 0.85).toFixed(2)], target: [0, 1.25, 0], fov: 38 },
  };
  xs.forEach((x, i) => { cams[`SPOT_${String(i + 1).padStart(2, '0')}_CAM`] = { pos: [+(x * 0.85).toFixed(3), 1.5, 2.6], target: [+x.toFixed(3), 1.38, 0], fov: 32 }; });
  const sky = flat2d.layers[0]?.gradient?.[0] ?? flat2d.layers[0]?.sky?.horizon ?? '#8fc6ff';
  // the ground fades into the haze far away (the layers haze themselves; performers stay clear: fog starts past them)
  const fog = flat2d.haze ? { fog: flat2d.haze.color, fogNear: 30, fogFar: 170 } : {};
  const sceneJson = {
    id: '', name, model: 'room.gltf', modes: ['talk'], defaultCamera: 'CAM_WIDE', avatarHeight: 1.6,
    ambience: { background: sky, exposure: 1, ...fog }, cams, flat2d,
    // what framing treats as the room: the stage strip in front of the layers
    bounds: [+(Math.min(-3, (xs[0] ?? 0) - 2)).toFixed(2), 0, -3, +(Math.max(3, (xs[n - 1] ?? 0) + 2)).toFixed(2), 3.2, 4],
    lights: { programs: ['steady'] },
  };
  return { gltf, sceneJson };
}

/** The shipped sample, drawn entirely by the engine (no pictures): a park at golden hour — a warm sky with a low sun,
 *  drifting clouds, hazy mountains, hills and two tree lines fading with distance, a grass meadow, grass blades at the
 *  performers' feet, a tree and bushes framing the wide shot, pollen in the air. */
export const SAMPLE_FLAT2D: Flat2dConfig = {
  drift: 0.35,
  haze: { color: '#f2d7bd', strength: 0.78 },
  ground: { color: '#4f913d', tile: 3 },
  particles: { color: '#fff1bd', count: 80, size: 0.03 },
  layers: [
    { sky: { top: '#3d74c7', horizon: '#ffd6a0', sun: { x: 0.66, y: 0.6, color: '#fff3cf', size: 0.06 } }, depth: 150, y: -40 },
    { clouds: { color: '#fff5ec', seed: 3, count: 9 }, depth: 130, repeat: true, scroll: 0.22 },
    { hills: { color: '#8b93b9', height: 0.62, seed: 11, bumps: 3.2, jag: 0.85 }, depth: 105 },
    { hills: { color: '#7aa37b', height: 0.42, seed: 5, bumps: 4.5 }, depth: 70 },
    { trees: { color: '#3f7d4c', seed: 9, count: 34, kind: 'pine', height: 0.55 }, depth: 42 },
    { hills: { color: '#4f9446', height: 0.3, seed: 23, bumps: 6 }, depth: 24 },
    { trees: { color: '#2f6d3b', seed: 4, count: 13, kind: 'round', height: 0.62 }, depth: 13, sway: 0.18 },
    { grass: { color: '#4b9a3a', seed: 2, height: 0.22 }, depth: -1.1, sway: 0.7 },
    { frame: { kind: 'tree', color: '#23492b', side: 'left', seed: 1 }, depth: -3.2, sway: 0.12 },
    { frame: { kind: 'bushes', color: '#2a5e31', side: 'right', seed: 2 }, depth: -2.4, sway: 0.3 },
  ],
};

// ---------------------------------------------------------------- a 2D room from the user's pictures
const IMG = /\.(png|webp|jpe?g|gif)$/i;
/** Layers from picture names, far → near: names sort the order (number them: 1_sky.png, 2_hills.png, 3_trees.png);
 *  'sky' / 'background' / 'backdrop' go to the back, 'ground' / 'floor' becomes the ground, 'clouds' scroll. Depths are
 *  spread from far (100 m) to near (6 m) so each layer gets its own parallax. */
export function planFlat2dLayers(files: string[]): Flat2dConfig | { error: string } {
  const pics = files.filter((f) => IMG.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const base = (f: string) => (f.split('/').pop() ?? f).toLowerCase();
  const groundFile = pics.find((f) => /(^|[^a-z])(ground|floor)([^a-z]|$)/.test(base(f)));
  let layers = pics.filter((f) => f !== groundFile);
  if (!layers.length) return { error: 'Add at least one background picture (PNG / WebP / JPEG).' };
  if (layers.length > 12) return { error: 'At most 12 layers.' };
  const back = layers.filter((f) => /(sky|background|backdrop|^bg[^a-z])/.test(base(f)));
  layers = [...back, ...layers.filter((f) => !back.includes(f))];
  const n = layers.length;
  const out: Flat2dLayer[] = layers.map((f, i) => {
    const depth = n === 1 ? 60 : +(100 * Math.pow(6 / 100, i / (n - 1))).toFixed(2);
    const clouds = /cloud/.test(base(f));
    return { file: f, depth, ...(i === 0 ? { y: -20 } : {}), ...(clouds ? { repeat: true, scroll: 0.15 } : {}) };
  });
  return { layers: out, drift: 0.35, ...(groundFile ? { ground: { file: groundFile, tile: 2 } } : { ground: { color: '#4a5a46' } }) };
}

/** Seeded hill silhouette: heights 0..1 across `n` samples (pure: tests). */
export function hillProfile(seed: number, bumps: number, jag: number, n: number): Float32Array {
  let s = (seed * 2654435761) >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const waves = [0, 1, 2, 3].map((k) => ({ f: bumps * (1 + k * 1.7) * (0.8 + rnd() * 0.4), p: rnd() * Math.PI * 2, a: 1 / (1 + k * 1.6) }));
  const out = new Float32Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    let v = 0;
    for (const w of waves) { const sn = Math.sin(x * Math.PI * 2 * w.f / 2 + w.p); v += w.a * ((1 - jag) * sn + jag * (1 - 2 * Math.abs(sn))); }
    out[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  for (let i = 0; i < n; i++) out[i] = 0.35 + 0.65 * (out[i] - lo) / Math.max(1e-6, hi - lo);
  return out;
}
