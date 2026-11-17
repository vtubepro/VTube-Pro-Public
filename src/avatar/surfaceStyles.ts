// Procedural SURFACE STYLES: felt / sock puppets, plush, knit, crochet, clay, plastic, vinyl, rubber, porcelain, paper,
// cardboard, painted / brushed metal, glass, crystal, slime, stone, lizard / dragon / snake / fish scales, belly scutes,
// horn keratin, wet frog skin and shell fur — on any avatar (GLB: every shading; VRM: MToon), costume or accessory.
// No textures: every pattern is procedural (src/avatar/surfaceStyleGlsl.ts).
//
// Where a material's style comes from (first match wins):
//   1. profile look.surfaces[<material or mesh name | /regex/>]   (the user's explicit per-part choice; 'none' = off)
//   2. glTF material extras  { "vtpStyle": "felt" }  or  { "vtpStyle": { "style": "felt", "tint": "#e05a3a" } }
//   3. a name token: material or mesh named  "Body@felt", "Belly@scutes", "Horn@keratin"
//   4. the costume / accessory's CostumeDef.surface
//   5. the avatar default look.surface (base model only; eyes, mouth, teeth, tongue, lenses, screens, glow and
//      see-through materials are left alone)
//
// Pipeline (src/avatar/AvatarRuntime.ts):  prepareSurfaceStyles()  → applyToon / applyRealistic / MToon as usual →
// finishSurfaceStyles(): patches each styled material's shader (onBeforeCompile, chained with every other engine
// patch), adds seam stitches / horn axes as vertex attributes, builds shell-fur meshes (one instanced draw per mesh),
// adjusts outlines. Programs compile at load / style change only; per frame there are only uniform writes.
//
// Tiers (setSurfaceQuality, called by src/stage/gfx/Graphics.ts): Performance / Balanced (and Classic, no room) = the
// cheap path (2-octave noise, no sparkle, no shells unless the style says shells:'always'); High = +1 octave, sparkle
// glints, shell fur (6 short / 10 long layers); Ultra = +2 octaves, 12 / 20 layers.

import * as THREE from 'three';
import type { CostumeDef, LookConfig, SurfaceStyle, SurfaceStyleId } from '../../shared/types.ts';
import { FRAG_BUMP_CALL, FRAG_SURFACE_CALL, VERT_PARS, VERT_REST_N, VERT_REST_P, VERT_SHELL, fragPars, type GlslFeatures, type Kernel } from './surfaceStyleGlsl.ts';

// ------------------------------------------------------------------ presets
export type SurfaceCategory = 'Fabric & puppet' | 'Toy & craft' | 'Hard & special' | 'Creature';

/** Everything a style needs, resolved (preset + the user's tweaks). Sizes in metres. */
export interface StylePreset {
  id: SurfaceStyleId;
  label: string;
  category: SurfaceCategory;
  hint: string;
  /** Two sRGB colours a picker can show as a swatch. */
  swatch: [string, string];
  kernel: Kernel;
  /** pattern name → shader variant (first = default). */
  patterns?: string[];
  pattern?: string;
  size: number;
  relief: number;
  variation: number;
  fuzz: number;
  sheenTight: number;
  iridescence: number;
  translucency: number;
  /** 0..1 cel-highlight gloss; null = keep the model's own roughness. */
  gloss: number | null;
  metal?: number;
  opacity?: number;
  stitches: 'auto' | 'none';
  stitchWidth: number;
  stitchPitch: number;
  stitchColor: string;
  furLength: number;
  furDensity: number;
  strandSpacing: number;
  /** 0 = no shells, 1 = short pile, 2 = long fur. */
  shellKind: 0 | 1 | 2;
  droop: number;
  wind: number;
  boil: number;
  wobble: number;
  wear: number;
  belly: number;
  fine: number;
  crackle: number;
  color2: string;
  sheen: string | null;
  outline: number;
  /** Tweaks a picker should offer for this style (SurfaceStyle keys). */
  params: (keyof SurfaceStyle)[];
}

const FAB: (keyof SurfaceStyle)[] = ['tint', 'scale', 'relief', 'fuzz', 'variation', 'stitches', 'stitchColor', 'sheenColor'];
const base = {
  relief: 1, variation: 0.25, fuzz: 0, sheenTight: 0.4, iridescence: 0, translucency: 0, gloss: 0 as number | null,
  stitches: 'none' as 'auto' | 'none', stitchWidth: 0.0025, stitchPitch: 0.007, stitchColor: '#f2eadb', furLength: 0, furDensity: 0.85,
  strandSpacing: 0.0012, shellKind: 0 as 0 | 1 | 2, droop: 0.3, wind: 0.3, boil: 0, wobble: 0, wear: 0, belly: 0, fine: 0,
  crackle: 0, color2: '#888888', sheen: null, outline: 1,
};
type P = Omit<StylePreset, keyof typeof base> & Partial<typeof base>;
const def = (p: P): StylePreset => ({ ...base, ...p });

export const SURFACE_STYLES: StylePreset[] = [
  // ---- fabric & puppet
  def({ id: 'felt', label: 'Felt puppet', category: 'Fabric & puppet', hint: 'Matted felt: fibre fuzz, pilling, velvet rim, sewn seams', swatch: ['#d9543f', '#f2eadb'],
    kernel: 'fibre', patterns: ['felt'], size: 0.003, variation: 0.35, fuzz: 0.6, sheenTight: 0.3, stitches: 'auto', stitchWidth: 0.0035, stitchPitch: 0.009, outline: 0.8, params: [...FAB] }),
  def({ id: 'sock', label: 'Sock puppet', category: 'Fabric & puppet', hint: 'Knitted sock: 2×2 rib, fuzzy yarn, heel seams', swatch: ['#7a8fb8', '#f2eadb'],
    kernel: 'yarn', patterns: ['rib2', 'rib', 'stockinette', 'garter'], size: 0.012, variation: 0.2, fuzz: 0.45, stitches: 'auto', outline: 0.8, params: [...FAB, 'pattern'] }),
  def({ id: 'fleece', label: 'Muppet fleece', category: 'Fabric & puppet', hint: 'Antron-style fleece: long soft nap, strong sheen (shell pile on High / Ultra)', swatch: ['#2f9e6a', '#c8f0d8'],
    kernel: 'fibre', patterns: ['fleece'], size: 0.003, variation: 0.2, fuzz: 0.9, sheenTight: 0.25, furLength: 0.006, furDensity: 0.9, strandSpacing: 0.0011, shellKind: 1, droop: 0.2, stitches: 'auto', outline: 0.6, params: [...FAB, 'furLength', 'furDensity', 'shells'] }),
  def({ id: 'plush', label: 'Plush toy', category: 'Fabric & puppet', hint: 'Minky plush: dense short pile, crushed-nap sheen patches, seams', swatch: ['#e8a6c8', '#fff0f6'],
    kernel: 'fibre', patterns: ['plush'], size: 0.0025, variation: 0.25, fuzz: 1.0, sheenTight: 0.6, furLength: 0.004, furDensity: 0.95, strandSpacing: 0.0009, shellKind: 1, droop: 0.05, stitches: 'auto', outline: 0.7, params: [...FAB, 'furLength', 'shells'] }),
  def({ id: 'knit', label: 'Knitted yarn', category: 'Fabric & puppet', hint: 'Chunky knit: V stitches (stockinette / rib / garter), fuzzy wool', swatch: ['#c9a36b', '#6b4a2b'],
    kernel: 'yarn', patterns: ['stockinette', 'rib', 'rib2', 'garter'], size: 0.016, variation: 0.25, fuzz: 0.35, params: [...FAB, 'pattern'] }),
  def({ id: 'crochet', label: 'Crochet', category: 'Fabric & puppet', hint: 'Amigurumi single crochet: staggered posts, chain bars, deep holes', swatch: ['#f0c75e', '#9a6b1e'],
    kernel: 'yarn', patterns: ['crochet'], size: 0.016, variation: 0.3, fuzz: 0.3, stitches: 'none', params: [...FAB] }),
  // ---- toy & craft
  def({ id: 'clay', label: 'Clay / plasticine', category: 'Toy & craft', hint: 'Claymation: soft lumps, thumbprints, waxy highlight, optional stop-motion boil', swatch: ['#e07b39', '#8c3b1a'],
    kernel: 'clay', size: 0.012, variation: 0.25, translucency: 0.12, gloss: 0, params: ['tint', 'scale', 'relief', 'variation', 'boil'] }),
  def({ id: 'plastic', label: 'Plastic toy', category: 'Toy & craft', hint: 'Injection-moulded toy plastic: crisp highlight, faint orange peel', swatch: ['#e23b3b', '#ffffff'],
    kernel: 'smooth', patterns: ['plastic'], size: 0.002, variation: 0.1, gloss: 0.75, params: ['tint', 'gloss', 'variation'] }),
  def({ id: 'vinyl', label: 'Vinyl figure', category: 'Toy & craft', hint: 'Designer-toy vinyl: soft sheen, slight light bleed', swatch: ['#6fc2d0', '#e8fbff'],
    kernel: 'smooth', patterns: ['vinyl'], size: 0.003, variation: 0.1, gloss: 0.6, translucency: 0.2, params: ['tint', 'gloss', 'translucency'] }),
  def({ id: 'rubber', label: 'Rubber', category: 'Toy & craft', hint: 'Matte moulded rubber: fine grain, soft highlight', swatch: ['#3b3b40', '#ffcc00'],
    kernel: 'smooth', patterns: ['rubber'], size: 0.0015, variation: 0.1, gloss: 0.12, params: ['tint', 'gloss', 'relief'] }),
  def({ id: 'porcelain', label: 'Porcelain / ceramic', category: 'Toy & craft', hint: 'Glazed porcelain doll: glassy highlight, hairline crackle, soft light bleed', swatch: ['#f4f1ea', '#8a93a8'],
    kernel: 'smooth', patterns: ['porcelain'], size: 0.004, variation: 0.3, gloss: 0.9, translucency: 0.22, crackle: 0.6, color2: '#8a93a8', params: ['tint', 'gloss', 'color2', 'wear'] }),
  def({ id: 'paper', label: 'Paper craft', category: 'Toy & craft', hint: 'Paper: pulp fibres, folds and creases', swatch: ['#f3efe4', '#c7bfae'],
    kernel: 'paper', patterns: ['paper'], size: 0.002, variation: 0.2, gloss: 0, outline: 1.2, params: ['tint', 'scale', 'relief'] }),
  def({ id: 'cardboard', label: 'Cardboard', category: 'Toy & craft', hint: 'Corrugated cardboard: flutes, brown speckles, creases', swatch: ['#c49a6c', '#6b4a2b'],
    kernel: 'paper', patterns: ['cardboard'], size: 0.004, variation: 0.25, gloss: 0, color2: '#6b4a2b', outline: 1.2, params: ['tint', 'scale', 'relief', 'color2'] }),
  // ---- hard & special
  def({ id: 'metal_brushed', label: 'Brushed metal', category: 'Hard & special', hint: 'Brushed steel / aluminium: streaks, stylised reflections', swatch: ['#b8bec6', '#6d737b'],
    kernel: 'metal', patterns: ['brushed'], size: 0.002, variation: 0.2, gloss: 0.5, metal: 1, params: ['tint', 'gloss', 'relief'] }),
  def({ id: 'metal_painted', label: 'Painted metal (robot)', category: 'Hard & special', hint: 'Painted robot panels with chipped edges showing bare steel', swatch: ['#d8b23a', '#9aa0a8'],
    kernel: 'metal', patterns: ['painted'], size: 0.004, variation: 0.15, gloss: 0.5, metal: 0, wear: 0.5, color2: '#9aa0a8', params: ['tint', 'gloss', 'wear', 'color2'] }),
  def({ id: 'glass', label: 'Glass', category: 'Hard & special', hint: 'Clear glass: see-through, bright fresnel edges', swatch: ['#cfe8f0', '#ffffff'],
    kernel: 'glass', patterns: ['glass'], size: 0.01, variation: 0, gloss: 1, opacity: 0.35, iridescence: 0.1, outline: 0, params: ['tint', 'iridescence'] }),
  def({ id: 'crystal', label: 'Crystal / gem', category: 'Hard & special', hint: 'Faceted crystal: flat facets, sparkles, rainbow fire', swatch: ['#a98bff', '#e0f7ff'],
    kernel: 'glass', patterns: ['crystal'], size: 0.012, variation: 0.6, gloss: 1, opacity: 0.82, iridescence: 0.6, outline: 0.5, params: ['tint', 'scale', 'iridescence', 'variation'] }),
  def({ id: 'slime', label: 'Slime / jelly', category: 'Hard & special', hint: 'Jelly: glowing translucency, bubbles, glossy, optional wobble', swatch: ['#7be35a', '#e6ffd8'],
    kernel: 'glass', patterns: ['slime'], size: 0.01, variation: 0.3, gloss: 0.85, opacity: 0.9, translucency: 0.8, wobble: 0.4, outline: 0, params: ['tint', 'translucency', 'wobble', 'gloss'] }),
  def({ id: 'stone', label: 'Stone', category: 'Hard & special', hint: 'Carved stone: lumps, cracks, speckles (golems, statues)', swatch: ['#8f8a82', '#3a3530'],
    kernel: 'stone', size: 0.01, variation: 0.4, gloss: 0, color2: '#3a3530', params: ['tint', 'scale', 'relief', 'color2', 'variation'] }),
  // ---- creature
  def({ id: 'scales_lizard', label: 'Lizard scales', category: 'Creature', hint: 'Overlapping small scales, finer on head / hands, pale belly plates', swatch: ['#5d8a3a', '#e8d9a8'],
    kernel: 'scales', patterns: ['overlap', 'hex', 'cycloid', 'keeled', 'diamond'], size: 0.013, variation: 0.35, gloss: 0.2, iridescence: 0.05, belly: 0.8, fine: 1, color2: '#e8d9a8', params: ['tint', 'scale', 'relief', 'variation', 'pattern', 'belly', 'color2', 'iridescence'] }),
  def({ id: 'scales_dragon', label: 'Dragon scales', category: 'Creature', hint: 'Big keeled scales with bright edges, gold belly scutes, iridescent sheen', swatch: ['#8a1f2b', '#d9b25a'],
    kernel: 'scales', patterns: ['keeled', 'hex', 'overlap', 'cycloid', 'diamond'], size: 0.026, variation: 0.3, gloss: 0.25, iridescence: 0.18, belly: 1, fine: 0.8, color2: '#d9b25a', params: ['tint', 'scale', 'relief', 'variation', 'pattern', 'belly', 'color2', 'iridescence'] }),
  def({ id: 'scales_snake', label: 'Snake scales', category: 'Creature', hint: 'Keeled diamond scales, glossy, rainbow sheen', swatch: ['#3d4d2a', '#cfc38a'],
    kernel: 'scales', patterns: ['diamond', 'overlap', 'hex', 'cycloid', 'keeled'], size: 0.012, variation: 0.3, gloss: 0.4, iridescence: 0.15, belly: 0.8, fine: 0.6, color2: '#cfc38a', params: ['tint', 'scale', 'relief', 'variation', 'pattern', 'belly', 'color2', 'iridescence'] }),
  def({ id: 'scales_fish', label: 'Fish scales', category: 'Creature', hint: 'Round overlapping cycloid scales, silvery iridescence', swatch: ['#4f7fa8', '#e6eef2'],
    kernel: 'scales', patterns: ['cycloid', 'overlap', 'hex', 'keeled', 'diamond'], size: 0.015, variation: 0.25, gloss: 0.6, iridescence: 0.35, belly: 0, fine: 0.5, color2: '#e6eef2', params: ['tint', 'scale', 'relief', 'variation', 'pattern', 'belly', 'color2', 'iridescence'] }),
  def({ id: 'scutes', label: 'Belly plates (scutes)', category: 'Creature', hint: 'Wide overlapping plates — for a belly / tail-underside material', swatch: ['#d9b25a', '#8c6a2a'],
    kernel: 'scales', patterns: ['scutes'], size: 0.035, variation: 0.2, gloss: 0.4, params: ['tint', 'scale', 'relief', 'variation'] }),
  def({ id: 'keratin', label: 'Horn / claw keratin', category: 'Creature', hint: 'Horns, claws, beaks: growth rings, streaks, dark tip', swatch: ['#d8c9a3', '#2a211b'],
    kernel: 'keratin', size: 0.004, variation: 0.2, gloss: 0.45, color2: '#2a211b', params: ['tint', 'scale', 'relief', 'color2', 'gloss'] }),
  def({ id: 'wet_skin', label: 'Wet skin (frog)', category: 'Creature', hint: 'Glossy amphibian skin: slick highlights, spots, little warts, paler belly', swatch: ['#4e9a3a', '#2d3b16'],
    kernel: 'wetskin', size: 0.01, variation: 0.3, gloss: 0.85, translucency: 0.25, belly: 0.4, color2: '#2d3b16', params: ['tint', 'scale', 'relief', 'color2', 'belly', 'gloss'] }),
  def({ id: 'fur_short', label: 'Short fur', category: 'Creature', hint: 'Short dense fur (shell layers on High / Ultra)', swatch: ['#a0663a', '#f0d8b8'],
    kernel: 'fibre', patterns: ['fur'], size: 0.0018, variation: 0.3, fuzz: 0.7, sheenTight: 0.3, furLength: 0.008, furDensity: 0.9, strandSpacing: 0.001, shellKind: 1, droop: 0.2, outline: 0.7, params: ['tint', 'fuzz', 'furLength', 'furDensity', 'droop', 'wind', 'shells', 'variation'] }),
  def({ id: 'fur_long', label: 'Long fur', category: 'Creature', hint: 'Long shaggy fur that hangs and sways (shell layers on High / Ultra)', swatch: ['#6b5a4a', '#d8c8b0'],
    kernel: 'fibre', patterns: ['fur'], size: 0.0025, variation: 0.3, fuzz: 0.8, sheenTight: 0.3, furLength: 0.025, furDensity: 0.8, strandSpacing: 0.0016, shellKind: 2, droop: 0.5, wind: 0.4, outline: 0.5, params: ['tint', 'fuzz', 'furLength', 'furDensity', 'droop', 'wind', 'shells', 'variation'] }),
];
const BY_ID = new Map(SURFACE_STYLES.map((s) => [s.id, s]));
export const surfacePreset = (id: string) => BY_ID.get(id as SurfaceStyleId) ?? null;

/** How much of the relief bends the shading normal (the rest is albedo detail shading): structural patterns 1,
 *  fine noise low (it would dither the cel terminator and the crisp toon highlights). */
const BUMP_NORMAL: Record<Kernel, number> = { scales: 1, yarn: 0.85, stone: 0.8, keratin: 0.3, glass: 1, clay: 0.3, fibre: 0.15, smooth: 0.1, paper: 0.2, metal: 0.25, wetskin: 0.35 };

const MATTE = new Set<Kernel>(['fibre', 'yarn', 'clay', 'paper', 'stone']);

const VARIANTS: Record<Kernel, Record<string, number>> = {
  fibre: { felt: 0, fleece: 1, plush: 2, fur: 3 },
  yarn: { stockinette: 0, rib: 1, rib2: 2, garter: 3, crochet: 4 },
  clay: {}, stone: {}, keratin: {}, wetskin: {},
  smooth: { plastic: 0, vinyl: 1, rubber: 2, porcelain: 3 },
  paper: { paper: 0, cardboard: 1 },
  metal: { brushed: 0, painted: 1 },
  glass: { glass: 0, crystal: 1, slime: 2 },
  scales: { hex: 0, overlap: 1, cycloid: 2, keeled: 3, diamond: 4, scutes: 5 },
};

/** A style id or spec → the full spec (null = none / unknown). */
export function normalizeSurface(x: unknown): SurfaceStyle | null {
  if (!x) return null;
  if (typeof x === 'string') {
    const t = x.trim();
    if (t.startsWith('{')) { try { return normalizeSurface(JSON.parse(t)); } catch { return null; } }
    return t === 'none' ? { style: 'none' } : BY_ID.has(t as SurfaceStyleId) ? { style: t as SurfaceStyleId } : null;
  }
  if (typeof x === 'object' && typeof (x as SurfaceStyle).style === 'string') {
    const s = x as SurfaceStyle;
    return s.style === 'none' || BY_ID.has(s.style) ? s : null;
  }
  return null;
}

// ------------------------------------------------------------------ resolution
const EXCLUDE_RE = /eye|iris|pupil|sclera|cornea|lens|glass|visor|goggle|teeth|tooth|tongue|mouth|interior|cavity|throat|gum|voice_?glow|screen|(^|[_\W])led([_\W]|$)|decal|^emit_|vtp-/i;
const TOKEN_RE = /@([a-z_]+)/i;

function lookupMap(map: Record<string, SurfaceStyle | SurfaceStyleId> | undefined, names: string[]): SurfaceStyle | null {
  if (!map) return null;
  for (const n of names) if (n && map[n] !== undefined) return normalizeSurface(map[n]) ?? null;
  for (const [k, v] of Object.entries(map)) {
    const m = /^\/(.+)\/([a-z]*)$/.exec(k);
    if (!m) continue;
    let re: RegExp;
    try { re = new RegExp(m[1], m[2] || 'i'); } catch { continue; }
    if (names.some((n) => n && re.test(n))) return normalizeSurface(v);
  }
  return null;
}

/** Where the style of this (mesh, material) comes from. Null = unstyled. */
export function surfaceStyleFor(mesh: THREE.Mesh, m: THREE.Material, look: LookConfig | undefined, costume: CostumeDef['surface'] | undefined): SurfaceStyle | null {
  const names = [m.name, mesh.name];
  const pick = (s: SurfaceStyle | null) => (s && s.style !== 'none' ? s : null);
  const ov = lookupMap(look?.surfaces, names);
  if (ov) return pick(ov);
  const ex = normalizeSurface(m.userData?.vtpStyle ?? (m.userData?.source as THREE.Material | undefined)?.userData?.vtpStyle);
  if (ex) return pick(ex);
  for (const n of names) {
    const t = TOKEN_RE.exec(n ?? '');
    if (t) { const s = normalizeSurface(t[1].toLowerCase()); if (s) return pick(s); }
  }
  if (mesh.userData.vtpCostume) return pick(normalizeSurface(costume));
  const d = normalizeSurface(look?.surface);
  if (!d || d.style === 'none') return null;
  if (names.some((n) => n && EXCLUDE_RE.test(n))) return null;
  if (m.transparent && m.opacity < 0.9) return null;
  const e = (m as THREE.MeshStandardMaterial).emissive;
  if (e && (m as THREE.MeshStandardMaterial).emissiveIntensity * (e.r + e.g + e.b) > 0.9) return null;
  return d;
}

// ------------------------------------------------------------------ resolved params
interface Resolved {
  spec: SurfaceStyle;
  pattern: string;
  preset: StylePreset;
  variant: number;
  stitches: 'auto' | 'seams' | 'authored' | 'none';
  shells: 'auto' | 'always' | 'off';
  mapping: 'object' | 'uv';
}

function resolve(spec: SurfaceStyle): Resolved {
  const p = BY_ID.get(spec.style)!;
  const table = VARIANTS[p.kernel];
  const pat = spec.pattern && table[spec.pattern] !== undefined ? spec.pattern : (p.patterns?.[0] ?? '');
  return {
    spec, preset: p, variant: table[pat] ?? 0, pattern: pat,
    stitches: spec.stitches ?? p.stitches,
    shells: p.shellKind ? spec.shells ?? 'auto' : 'off',
    mapping: spec.mapping ?? 'object',
  };
}

const lin = (hex: string | null | undefined, fb: string) => new THREE.Color().setStyle(hex || fb, THREE.SRGBColorSpace);
const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const c01 = (x: number) => THREE.MathUtils.clamp(x, 0, 1);

type U = Record<string, THREE.IUniform>;
/** Shared by every styled material on the page: quality (0 balanced · 1 high · 2 ultra) and time (s). */
const GLOBAL = { uVtpSQ: { value: 0 }, uVtpSTime: { value: 0 } };

function makeUniforms(): U {
  return {
    uVtpS0: { value: new THREE.Vector4() }, uVtpS1: { value: new THREE.Vector4() }, uVtpS2: { value: new THREE.Vector4() },
    uVtpS3: { value: new THREE.Vector4() }, uVtpS4: { value: new THREE.Vector4() },
    uVtpSC2: { value: new THREE.Color() }, uVtpSCS: { value: new THREE.Color() }, uVtpSSheen: { value: new THREE.Color() },
    uVtpSTint: { value: new THREE.Vector4() }, uVtpSTintRef: { value: 0.5 }, uVtpSH: { value: 1.6 }, uVtpSBM: { value: 0 }, uVtpSBN: { value: 1 },
    uVtpSM: { value: new THREE.Matrix3() }, uVtpST3: { value: new THREE.Vector3() }, uVtpSU: { value: 1 },
    uVtpShellN: { value: 1 }, uVtpSway: { value: new THREE.Vector3(0, -0.3, 0) },
    ...GLOBAL,
  };
}

/** Write the (live-tunable) numbers + colours of a resolved style into its uniforms. */
function writeParams(U: U, r: Resolved, tintRef: number) {
  const s = r.spec, p = r.preset;
  // presets are tuned for a ~1.6 m performer: a chibi / small critter gets proportionally smaller detail
  const hk = THREE.MathUtils.clamp((U.uVtpSH.value as number) / 1.6, 0.6, 1.5);
  const size = p.size * hk * THREE.MathUtils.clamp(num(s.scale, 1), 0.2, 5);
  const gloss = s.gloss !== undefined ? c01(s.gloss) : p.gloss ?? 0;
  (U.uVtpS0.value as THREE.Vector4).set(size, THREE.MathUtils.clamp(num(s.relief, 1), 0, 3) * p.relief, c01(num(s.variation, p.variation)), Math.max(0, num(s.fuzz, 1)) * p.fuzz);
  (U.uVtpS1.value as THREE.Vector4).set(c01(num(s.iridescence, p.iridescence)), c01(num(s.translucency, p.translucency)), c01(num(s.wear, p.wear)), c01(num(s.boil, p.boil)));
  (U.uVtpS2.value as THREE.Vector4).set(gloss, Math.max(0.0005, num(s.stitchWidth, p.stitchWidth)), p.sheenTight, c01(num(s.belly, p.belly)));
  const fur = Math.max(0, num(s.furLength, p.furLength));
  (U.uVtpS3.value as THREE.Vector4).set(fur, p.strandSpacing * Math.sqrt(Math.max(0.2, fur / Math.max(p.furLength, 1e-4))) * THREE.MathUtils.clamp(num(s.scale, 1), 0.5, 2), 0.004 * c01(num(s.wobble, p.wobble)), p.stitchPitch * THREE.MathUtils.clamp(num(s.scale, 1), 0.5, 2));
  (U.uVtpS4.value as THREE.Vector4).set(p.fine, c01(num(s.furDensity, p.furDensity)), p.id === 'porcelain' ? c01(num(s.wear, 0) + p.crackle) : p.crackle, 40 / THREE.MathUtils.clamp(num(s.scale, 1), 0.2, 5));
  (U.uVtpSC2.value as THREE.Color).copy(lin(s.color2, p.color2));
  (U.uVtpSCS.value as THREE.Color).copy(lin(s.stitchColor, p.stitchColor));
  (U.uVtpSSheen.value as THREE.Color).copy(lin(s.sheenColor ?? p.sheen, '#ffffff'));
  const t = U.uVtpSTint.value as THREE.Vector4;
  if (s.tint) { const c = lin(s.tint, '#ffffff'); t.set(c.r, c.g, c.b, 1); } else t.set(1, 1, 1, 0);
  U.uVtpSTintRef.value = tintRef;
}

// ------------------------------------------------------------------ mesh frame + geometry analysis
interface Frame { M: THREE.Matrix3; T: THREE.Vector3; unit: number }

function meshFrame(mesh: THREE.Mesh, wrapperInv: THREE.Matrix4, origin: THREE.Vector3): Frame {
  mesh.updateWorldMatrix(true, false);
  const m4 = new THREE.Matrix4().multiplyMatrices(wrapperInv, mesh.matrixWorld);
  const M = new THREE.Matrix3().setFromMatrix4(m4);
  const T = new THREE.Vector3().setFromMatrixPosition(m4).sub(origin);
  const e = m4.elements;
  const unit = (Math.hypot(e[0], e[1], e[2]) + Math.hypot(e[4], e[5], e[6]) + Math.hypot(e[8], e[9], e[10])) / 3;
  return { M, T, unit };
}
const sameFrame = (a: Frame, b: Frame) => a.T.distanceTo(b.T) < 1e-4 && a.M.elements.every((x, i) => Math.abs(x - b.M.elements[i]) < 1e-4);

/** Welded vertex ids (same position) for a geometry. */
function weld(g: THREE.BufferGeometry): { id: Int32Array; count: number } {
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.boundingBox) g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3()).length() || 1;
  const q = 1e5 / size;
  const map = new Map<string, number>();
  const id = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${Math.round(pos.getX(i) * q)},${Math.round(pos.getY(i) * q)},${Math.round(pos.getZ(i) * q)}`;
    let v = map.get(k);
    if (v === undefined) { v = map.size; map.set(k, v); }
    id[i] = v;
  }
  return { id, count: map.size };
}

/** Triangles (index triples) of the geometry groups that use material slot `slot` (all when not multi-material). */
function trianglesOf(g: THREE.BufferGeometry, slot: number | null): number[] {
  const idx = g.index;
  const n = idx ? idx.count : (g.attributes.position as THREE.BufferAttribute).count;
  const at = (i: number) => (idx ? idx.getX(i) : i);
  const out: number[] = [];
  const ranges = slot === null || !g.groups.length ? [{ start: 0, count: n }] : g.groups.filter((gr) => (gr.materialIndex ?? 0) === slot);
  for (const r of ranges) for (let i = r.start; i + 2 < Math.min(n, r.start + r.count); i += 3) out.push(at(i), at(i + 1), at(i + 2));
  return out;
}

class MinHeap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v; k.push(key); v.push(val);
    let i = k.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop(): [number, number] {
    const k = this.k, v = this.v; const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Stitch field: per vertex (distance to the nearest seam in metres, seam tangent in the avatar frame). Seams = the
 * authored `_stitch` attribute (> 0.5) when present, else UV seams + open borders. Returns false when there is
 * nothing to stitch (or 'auto' found too many seams: a fragmented AI atlas would be stitches everywhere).
 */
function buildStitches(g: THREE.BufferGeometry, tris: number[], fr: Frame, mode: Resolved['stitches'], maxDist: number): boolean {
  if (g.attributes.vtpStitch) return true;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute | undefined;
  const authored = (g.attributes._stitch ?? g.attributes.stitch) as THREE.BufferAttribute | undefined;
  const useAuth = mode === 'authored' || (mode === 'auto' && !!authored);
  if (mode === 'authored' && !authored) return false;
  const { id } = weld(g);
  // welded edges → (count, the original vertex pairs)
  const edges = new Map<number, { n: number; a: number; b: number; uvSplit: boolean }>();
  const key = (a: number, b: number) => (a < b ? a * 4194304 + b : b * 4194304 + a);
  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const i = tris[t + e], j = tris[t + (e + 1) % 3];
      const a = id[i], b = id[j];
      if (a === b) continue;
      const k = key(a, b);
      const o = edges.get(k);
      if (!o) { edges.set(k, { n: 1, a: i, b: j, uvSplit: false }); continue; }
      o.n++;
      if (uv && !o.uvSplit) {
        // same welded edge, different UVs at the matching ends → UV seam
        const [p, q] = id[o.a] === a ? [o.a, o.b] : [o.b, o.a];
        const d = Math.abs(uv.getX(p) - uv.getX(i)) + Math.abs(uv.getY(p) - uv.getY(i)) + Math.abs(uv.getX(q) - uv.getX(j)) + Math.abs(uv.getY(q) - uv.getY(j));
        if (d > 1e-4) o.uvSplit = true;
      }
    }
  }
  const seeds: [number, number][] = [];
  for (const o of edges.values()) {
    const on = useAuth ? authored!.getX(o.a) > 0.5 && authored!.getX(o.b) > 0.5 : o.n === 1 || o.uvSplit;
    if (on) seeds.push([o.a, o.b]);
  }
  if (!seeds.length) return false;
  if (!useAuth && mode === 'auto' && seeds.length > edges.size * 0.035) return false;
  // avatar-frame positions
  const n = pos.count;
  const P = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < n; i++) { v.fromBufferAttribute(pos, i).applyMatrix3(fr.M); P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z; }
  // adjacency over original vertices + welded twins (distance 0)
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) { const i = tris[t + e], j = tris[t + (e + 1) % 3]; adj[i].push(j); adj[j].push(i); }
  const twins = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const l = twins.get(id[i]); if (l) l.push(i); else twins.set(id[i], [i]); }
  const dist = new Float32Array(n).fill(1e9);
  const tan = new Float32Array(n * 3);
  const heap = new MinHeap();
  for (const [a, b] of seeds) {
    let tx = P[b * 3] - P[a * 3], ty = P[b * 3 + 1] - P[a * 3 + 1], tz = P[b * 3 + 2] - P[a * 3 + 2];
    const l = Math.hypot(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
    // canonical sign: largest component positive (dashes don't flip phase along the seam)
    const big = Math.abs(tx) >= Math.abs(ty) && Math.abs(tx) >= Math.abs(tz) ? tx : Math.abs(ty) >= Math.abs(tz) ? ty : tz;
    if (big < 0) { tx = -tx; ty = -ty; tz = -tz; }
    for (const s of [a, b]) for (const w of twins.get(id[s]) ?? [s]) {
      if (dist[w] === 0) { tan[w * 3] += tx; tan[w * 3 + 1] += ty; tan[w * 3 + 2] += tz; continue; }
      dist[w] = 0; tan[w * 3] = tx; tan[w * 3 + 1] = ty; tan[w * 3 + 2] = tz; heap.push(0, w);
    }
  }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i] || d > maxDist) continue;
    for (const j of adj[i]) {
      const nd = d + Math.hypot(P[j * 3] - P[i * 3], P[j * 3 + 1] - P[i * 3 + 1], P[j * 3 + 2] - P[i * 3 + 2]);
      if (nd < dist[j]) { dist[j] = nd; tan[j * 3] = tan[i * 3]; tan[j * 3 + 1] = tan[i * 3 + 1]; tan[j * 3 + 2] = tan[i * 3 + 2]; heap.push(nd, j); }
    }
  }
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(tan[i * 3], tan[i * 3 + 1], tan[i * 3 + 2]) || 1;
    out[i * 4] = Math.min(dist[i], 1); out[i * 4 + 1] = tan[i * 3] / l; out[i * 4 + 2] = tan[i * 3 + 1] / l; out[i * 4 + 3] = tan[i * 3 + 2] / l;
  }
  g.setAttribute('vtpStitch', new THREE.BufferAttribute(out, 4));
  return true;
}

/** Horns / claws: per connected piece, the long axis (PCA) from the thick base to the thin tip → (t 0..1, length m). */
function buildKeratin(g: THREE.BufferGeometry, tris: number[], fr: Frame): boolean {
  if (g.attributes.vtpKer) return true;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const { id, count } = weld(g);
  const parent = new Int32Array(count).map((_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 2; e++) { const a = find(id[tris[t + e]]), b = find(id[tris[t + e + 1]]); if (a !== b) parent[a] = b; }
  const used = new Uint8Array(n);
  for (const i of tris) used[i] = 1;
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) if (used[i]) { const r = find(id[i]); const l = groups.get(r); if (l) l.push(i); else groups.set(r, [i]); }
  const out = new Float32Array(n * 2);
  const v = new THREE.Vector3();
  for (const verts of groups.values()) {
    const pts = verts.map((i) => v.fromBufferAttribute(pos, i).applyMatrix3(fr.M).clone());
    const c = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    // power iteration on the covariance
    const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of pts) { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a * 3 + b] += d[a] * d[b]; }
    let ax = new THREE.Vector3(0.3, 0.9, 0.2).normalize();
    for (let it = 0; it < 24; it++) { ax = new THREE.Vector3(C[0] * ax.x + C[1] * ax.y + C[2] * ax.z, C[3] * ax.x + C[4] * ax.y + C[5] * ax.z, C[6] * ax.x + C[7] * ax.y + C[8] * ax.z); if (ax.lengthSq() < 1e-20) { ax.set(0, 1, 0); break; } ax.normalize(); }
    let lo = Infinity, hi = -Infinity;
    const ts = pts.map((p) => { const t = p.clone().sub(c).dot(ax); lo = Math.min(lo, t); hi = Math.max(hi, t); return t; });
    const len = Math.max(hi - lo, 1e-4);
    // thick end = base: mean radius of the last 15 % at each end
    const rad = (fromLo: boolean) => { let s = 0, k = 0; pts.forEach((p, i) => { const u = (ts[i] - lo) / len; if (fromLo ? u < 0.15 : u > 0.85) { s += p.clone().sub(c).addScaledVector(ax, -ts[i]).length(); k++; } }); return k ? s / k : 0; };
    const flip = rad(false) > rad(true);
    verts.forEach((vi, i) => { const u = (ts[i] - lo) / len; out[vi * 2] = flip ? 1 - u : u; out[vi * 2 + 1] = len; });
  }
  g.setAttribute('vtpKer', new THREE.BufferAttribute(out, 2));
  return true;
}

/** Average linear luminance of the material's albedo (colour × texture) — the re-colour keeps detail relative to it —
 *  and whether the texture has a distinct light patch (a painted belly: 5–45 % of the texels ≥ 1.3 × the mean). */
function albedoStats(m: THREE.Material): { lum: number; lightPatch: boolean } {
  const mm = m as THREE.MeshStandardMaterial;
  const c = mm.color ?? new THREE.Color(1, 1, 1);
  let t = 1, patch = false;
  const img = mm.map?.image as CanvasImageSource & { width?: number; height?: number } | undefined;
  if (img && img.width) {
    try {
      const N = 16;
      const cv = document.createElement('canvas'); cv.width = cv.height = N;
      const ctx = cv.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0, N, N);
      const d = ctx.getImageData(0, 0, N, N).data;
      const toLin = (x: number) => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const L: number[] = [];
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 8) L.push(0.2126 * toLin(d[i]) + 0.7152 * toLin(d[i + 1]) + 0.0722 * toLin(d[i + 2]));
      if (L.length) {
        // the dominant (median) tone is the reference: a light belly patch or a dark print doesn't move it
        const sorted = [...L].sort((a, b) => a - b);
        t = sorted[Math.floor(sorted.length / 2)];
        const light = L.filter((x) => x > t * 1.3).length / L.length;
        patch = light > 0.05 && light < 0.45;
      }
    } catch { /* tainted / no DOM */ }
  }
  return { lum: Math.max(0.02, (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * t), lightPatch: patch };
}

// ------------------------------------------------------------------ shader patch
const RE = {
  morphN: /^[ \t]*#include <morphnormal_vertex>/m,
  morphT: /^[ \t]*#include <morphtarget_vertex>/m,
  project: /^[ \t]*#include <project_vertex>/m,
  common: /^[ \t]*#include <common>/m,
  // built-ins: after <color_fragment>; MToon: before its commented "// #include <alphamap_fragment>" (after the vColor multiply)
  color: /^[ \t]*#include <color_fragment>/m,
  mtoonAlpha: /^[ \t]*\/\/ #include <alphamap_fragment>/m,
  emissive: /^[ \t]*#include <emissivemap_fragment>/m,
  mtoonEmissive: /^[ \t]*\/\/ #include <emissivemap_fragment>/m,
  rough: /^[ \t]*#include <roughnessmap_fragment>/m,
  metal: /^[ \t]*#include <metalnessmap_fragment>/m,
  opaque: /^[ \t]*#include <opaque_fragment>/m,
};
const MTOON_OUT = 'gl_FragColor = vec4( col, diffuseColor.a );';
const MTOON_SHADE = 'material.shadingShift = shadingShiftFactor;';

function installPatch(m: THREE.Material, U: U, f: GlslFeatures, shellMat: boolean) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  if (!shellMat) { m.userData.vtpSurfPrevCompile = prev; m.userData.vtpSurfPrevKey = prevKey; }
  const key = `vtpsurf1:${f.kernel}${f.variant}${f.stitch ? 's' : ''}${f.shell ? 'h' : ''}${f.uv ? 'u' : ''}${f.wobble ? 'w' : ''}${f.keratinAttr ? 'k' : ''}${f.spec ? 'p' : ''}${f.furVC ? 'c' : ''}`;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    const mtoon = fs.includes('void postCorrection') && fs.includes(MTOON_OUT);
    if (!RE.morphN.test(vs) || !RE.morphT.test(vs) || !RE.project.test(vs) || !RE.common.test(vs)) return;
    const colorOk = mtoon ? RE.mtoonAlpha.test(fs) : RE.color.test(fs);
    const bumpOk = mtoon ? RE.mtoonEmissive.test(fs) : RE.emissive.test(fs);
    const outOk = mtoon || RE.opaque.test(fs);
    if (!colorOk || !bumpOk || !outOk || !fs.includes('vViewPosition')) return;
    vs = vs.replace(RE.common, (s) => `${s}\n${VERT_PARS(f)}`)
      .replace(RE.morphN, (s) => `${s}\n${VERT_REST_N}`)
      .replace(RE.morphT, (s) => `${s}\n${VERT_REST_P(f)}`);
    if (f.shell) vs = vs.replace(RE.project, (s) => `${VERT_SHELL}\n${s}`);
    // after every host declaration (vViewPosition, vNormal, directionalLights…), before main
    const mainAt = fs.lastIndexOf('void main(');
    if (mainAt < 0) return;
    fs = `${fs.slice(0, mainAt)}${fragPars(f)}\n${fs.slice(mainAt)}`;
    fs = mtoon ? fs.replace(RE.mtoonAlpha, (s) => `${FRAG_SURFACE_CALL}${s}`) : fs.replace(RE.color, (s) => `${s}\n${FRAG_SURFACE_CALL}`);
    fs = mtoon ? fs.replace(RE.mtoonEmissive, (s) => `${FRAG_BUMP_CALL}${s}`) : fs.replace(RE.emissive, (s) => `${FRAG_BUMP_CALL}${s}`);
    if (mtoon) {
      // MToon's shade colour gets the same pattern (ratio of styled / original albedo)
      if (fs.includes(MTOON_SHADE)) fs = fs.replace(MTOON_SHADE, `${MTOON_SHADE}\n  material.shadeColor *= clamp( diffuseColor.rgb / max( vtpSgAlb0, vec3( 0.02 ) ), 0.0, 2.0 );`);
      const at = fs.lastIndexOf(MTOON_OUT);
      fs = `${fs.slice(0, at)}#ifndef OUTLINE\n  col += vtpSf_light( normalize( normal ), normalize( vViewPosition ), diffuseColor.rgb );\n  #endif\n  ${fs.slice(at)}`;
    } else {
      // PBR hosts: per-pixel roughness / metalness (worn paint = bare shiny metal)
      if (RE.rough.test(fs)) fs = fs.replace(RE.rough, (s) => `${s}\n  roughnessFactor = mix( roughnessFactor, 0.3, vtpSgMetal );`);
      if (RE.metal.test(fs)) fs = fs.replace(RE.metal, (s) => `${s}\n  metalnessFactor = mix( metalnessFactor, 1.0, vtpSgMetal );`);
      fs = fs.replace(RE.opaque, (s) => `  outgoingLight += vtpSf_light( normalize( normal ), normalize( vViewPosition ), diffuseColor.rgb );\n${s}`);
    }
    Object.assign(sh.uniforms, U);
    sh.vertexShader = vs;
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|${key}${shellMat ? '|shell' : ''}`; };
  m.defines = { ...(m.defines ?? {}), ...(f.furVC ? { VTP_FURVC: '' } : {}), ...(f.uv ? { VTP_SUV: '' } : {}) };
  m.needsUpdate = true;
}

/** Glossy styles on hosts that shade from the source PBR values: set roughness / metalness before conversion. */
function precondition(m: THREE.Material, r: Resolved) {
  const std = m as THREE.MeshStandardMaterial;
  const s = r.spec, p = r.preset;
  const gloss = s.gloss !== undefined ? c01(s.gloss) : p.gloss;
  if (std.isMeshStandardMaterial) {
    if (gloss !== null) { std.roughness = gloss <= 0.02 ? 1 : THREE.MathUtils.clamp(0.72 - 0.5 * gloss, 0.04, 1); std.roughnessMap = null; }
    if (p.metal !== undefined) { std.metalness = p.metal; std.metalnessMap = null; }
    else if (gloss !== null && std.metalness >= 0.999 && !std.metalnessMap) std.metalness = 0; // glTF "unspecified" 1/1
  }
  // fibre / yarn: the engine's hard anime rim reads as plastic sheen — soften it (the style adds a velvet sheen instead)
  if ((p.kernel === 'fibre' || p.kernel === 'yarn') && typeof m.userData.vtpRim !== 'number') m.userData.vtpRim = 0.35;
  if (p.opacity !== undefined && p.opacity < 1) {
    m.transparent = true;
    m.opacity = Math.min(m.opacity, p.opacity);
    m.depthWrite = p.opacity > 0.7;
  }
}

// ------------------------------------------------------------------ public: prepare / finish
interface Entry { mesh: THREE.Mesh; slot: number | null; r: Resolved; frame: Frame }

export interface SurfacePrep {
  entries: Entry[];
  origin: THREE.Vector3;
  height: number;
  wrapperInv: THREE.Matrix4;
}

/**
 * Before the look is applied: resolve every (mesh, material slot), clone a styled material shared by meshes with a
 * different frame, and precondition source materials (roughness / metalness / opacity). Null = nothing styled.
 * `costumes`: each worn costume / accessory's meshes + its def.surface.
 */
export function prepareSurfaceStyles(model: THREE.Object3D, wrapper: THREE.Object3D, look: LookConfig | undefined,
  costumes: { meshes: THREE.Mesh[]; surface?: CostumeDef['surface'] }[] = []): SurfacePrep | null {
  const costumeOf = new Map<THREE.Mesh, CostumeDef['surface']>();
  for (const c of costumes) for (const m of c.meshes) costumeOf.set(m, c.surface);
  wrapper.updateWorldMatrix(true, true);
  const wrapperInv = wrapper.matrixWorld.clone().invert();
  const meshes: THREE.Mesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.vtpOutline || m.userData.vtpGenerated || m.userData.vtpHidden || m.userData.vtpShell || !m.geometry?.attributes.position) return;
    meshes.push(m);
  });
  // avatar frame: feet centre, height (rest pose)
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const m of meshes) {
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    m.updateWorldMatrix(true, false);
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(wrapperInv, m.matrixWorld));
    box.union(tmp);
  }
  if (box.isEmpty()) return null;
  const origin = new THREE.Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  const height = Math.max(0.05, box.max.y - box.min.y);
  const entries: Entry[] = [];
  const owner = new Map<THREE.Material, Frame>();
  for (const mesh of meshes) {
    const multi = Array.isArray(mesh.material);
    const mats = multi ? [...(mesh.material as THREE.Material[])] : [mesh.material as THREE.Material];
    let changed = false;
    mats.forEach((m0, slot) => {
      if (!m0 || (m0 as THREE.ShaderMaterial).isShaderMaterial && !(m0 as { isMToonMaterial?: boolean }).isMToonMaterial) return;
      if ((m0 as { isOutline?: boolean }).isOutline) return; // MToon outline pass: sized in finishSurfaceStyles
      const spec = surfaceStyleFor(mesh, m0, look, costumeOf.get(mesh));
      if (!spec) return;
      const r = resolve(spec);
      const frame = meshFrame(mesh, wrapperInv, origin);
      let m = m0;
      const prev = owner.get(m0);
      if (prev && !sameFrame(prev, frame)) {
        // shared by a mesh with another frame: own copy (uniforms are per material)
        const ud = m0.userData; m0.userData = {};
        m = m0.clone(); m0.userData = ud; m.userData = { ...ud };
        mats[slot] = m; changed = true;
      } else owner.set(m0, frame);
      precondition(m, r);
      m.userData.vtpStyleSpec = r;
      entries.push({ mesh, slot: multi ? slot : null, r, frame });
    });
    if (changed) mesh.material = multi ? mats : mats[0];
  }
  return entries.length ? { entries, origin, height, wrapperInv } : null;
}

interface ShellRec { mesh: THREE.Mesh; kind: 1 | 2; always: boolean; mats: THREE.Material[] }
interface MatRec { mat: THREE.Material; r: Resolved; U: U; tintRef: number; fromLook: boolean }

const ALL = new Set<SurfaceStyles>();
let quality: 0 | 1 | 2 = 0;
const SHELLS: Record<0 | 1 | 2, [number, number]> = { 0: [4, 8], 1: [6, 10], 2: [12, 20] }; // [short, long] per quality

/** A styled avatar: live params, shells, sway physics. Created by finishSurfaceStyles(). */
export class SurfaceStyles {
  mats: MatRec[] = [];
  shells: ShellRec[] = [];
  private sway = new THREE.Vector3(0, -0.3, 0);
  private swayU: THREE.IUniform = { value: new THREE.Vector3(0, -0.3, 0) };
  private lastPos: THREE.Vector3 | null = null;
  private vel = new THREE.Vector3();
  private lag = new THREE.Vector3();
  private lagV = new THREE.Vector3();
  private t = 0;
  private droop = 0;
  private wind = 0;
  warnings: string[] = [];

  /** Per frame (cheap: a spring + uniform writes). `anchor` = the object whose world motion shakes the fur. */
  update(dt: number, anchor: THREE.Object3D) {
    GLOBAL.uVtpSTime.value = (performance.now() / 1000) % 3600;
    if (!this.shells.length || dt <= 0) return;
    this.t += dt;
    const p = anchor.getWorldPosition(new THREE.Vector3());
    if (this.lastPos) {
      const v = p.clone().sub(this.lastPos).multiplyScalar(1 / Math.max(dt, 1e-3));
      const acc = v.clone().sub(this.vel).multiplyScalar(1 / Math.max(dt, 1e-3));
      this.vel.copy(v);
      // damped spring: fur lags behind accelerations (inertia), then settles
      this.lagV.addScaledVector(acc, -0.012 * dt).addScaledVector(this.lag, -60 * dt).multiplyScalar(Math.exp(-7 * dt));
      this.lag.addScaledVector(this.lagV, dt).clampLength(0, 0.8);
    }
    this.lastPos = p;
    const w = this.wind * (0.35 + 0.25 * Math.sin(this.t * 0.7) + 0.15 * Math.sin(this.t * 2.3 + 1.3));
    this.sway.set(w * 0.8 + this.lag.x, -this.droop * 0.9 + this.lag.y, w * 0.35 + this.lag.z);
    (this.swayU.value as THREE.Vector3).copy(this.sway);
  }

  /** Live look edit: numbers / colours update without a rebuild (a new style / pattern / stitch mode needs one). */
  setLook(look: LookConfig) {
    for (const rec of this.mats) {
      if (!rec.fromLook) continue;
      const names = [rec.mat.name, (rec.mat.userData.source as THREE.Material | undefined)?.name ?? ''];
      const spec = lookupMap(look.surfaces, names) ?? normalizeSurface(look.surface);
      if (!spec || spec.style !== rec.r.spec.style) continue;
      rec.r = { ...rec.r, spec };
      writeParams(rec.U, rec.r, rec.tintRef);
    }
  }

  /** Shell layer count for the current quality (0 = hidden). */
  applyQuality() {
    for (const s of this.shells) {
      const n = quality === 0 && !s.always ? 0 : SHELLS[quality][s.kind - 1];
      const g = s.mesh.geometry as THREE.InstancedBufferGeometry;
      g.instanceCount = Math.max(1, n);
      s.mesh.visible = n > 0;
      for (const m of s.mats) { const u = (m.userData.vtpSurfU as U | undefined)?.uVtpShellN; if (u) u.value = Math.max(1, n); }
    }
  }

  info() {
    return {
      materials: this.mats.map((m) => ({ name: m.mat.name, style: m.r.spec.style, pattern: m.r.pattern || undefined })),
      shells: this.shells.map((s) => ({ mesh: s.mesh.name, layers: s.mesh.visible ? (s.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount : 0 })),
      quality, warnings: this.warnings,
    };
  }

  dispose() {
    ALL.delete(this);
    for (const s of this.shells) { s.mesh.removeFromParent(); s.mesh.geometry.dispose(); for (const m of s.mats) m.dispose(); }
    this.shells = [];
  }

  /** @internal */ get swayUniform() { return this.swayU; }
  /** @internal */ setWind(droop: number, wind: number) { this.droop = Math.max(this.droop, droop); this.wind = Math.max(this.wind, wind); }
}

/** After applyToon / applyRealistic / the MToon exposure pass: patch shaders, add attributes, shells, outline widths. */
export function finishSurfaceStyles(prep: SurfacePrep | null, model: THREE.Object3D, outlines: THREE.Mesh[], look: LookConfig | undefined,
  face: { p: THREE.Vector3; r: number }[] = []): SurfaceStyles | null {
  if (!prep) return null;
  // face features (world, rest pose) -> avatar frame: shell fur keeps clear of them
  const faceU = [0, 1, 2].map((i) => { const f = face[i]; if (!f) return new THREE.Vector4(0, 0, 0, 0); const v = f.p.clone().applyMatrix4(prep.wrapperInv).sub(prep.origin); return new THREE.Vector4(v.x, v.y, v.z, f.r); });
  const out = new SurfaceStyles();
  const done = new Map<THREE.Material, MatRec>();
  const stitched = new WeakSet<THREE.BufferGeometry>();
  for (const e of prep.entries) {
    const mat = currentMaterial(e.mesh, e.slot);
    if (!mat) continue;
    const r = e.r, p = r.preset;
    const g = e.mesh.geometry;
    const tris = r.stitches !== 'none' || p.kernel === 'keratin' ? trianglesOf(g, e.slot) : [];
    let stitch = false;
    if (r.stitches !== 'none') {
      try { stitch = stitched.has(g) || buildStitches(g, tris, e.frame, r.stitches, Math.max(0.02, (r.spec.stitchWidth ?? p.stitchWidth) * 3)); }
      catch (err) { out.warnings.push(`stitches on '${e.mesh.name}': ${(err as Error).message}`); }
      if (stitch) stitched.add(g);
    }
    let ker = false;
    if (p.kernel === 'keratin') { try { ker = buildKeratin(g, tris, e.frame); } catch (err) { out.warnings.push(`keratin on '${e.mesh.name}': ${(err as Error).message}`); } }
    let rec = done.get(mat);
    if (rec) {
      // a second mesh on an already patched material: its geometry needs the attributes the program reads
      const f0 = rec.mat.userData.vtpSurfF as GlslFeatures;
      const n = (g.attributes.position as THREE.BufferAttribute).count;
      if (f0.stitch && !g.attributes.vtpStitch) { const a = new Float32Array(n * 4); for (let i = 0; i < n; i++) { a[i * 4] = 1; a[i * 4 + 2] = 1; } g.setAttribute('vtpStitch', new THREE.BufferAttribute(a, 4)); }
      if (f0.keratinAttr && !g.attributes.vtpKer) g.setAttribute('vtpKer', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (!rec) {
      const U = makeUniforms();
      (U.uVtpSM.value as THREE.Matrix3).copy(e.frame.M);
      (U.uVtpST3.value as THREE.Vector3).copy(e.frame.T);
      U.uVtpSU.value = e.frame.unit;
      U.uVtpSH.value = prep.height;
      U.uVtpSway = out.swayUniform;
      const src = (mat.userData.source as THREE.Material | undefined) ?? mat;
      const st = albedoStats(src);
      const tintRef = st.lum;
      U.uVtpSBM.value = st.lightPatch ? 1 : 0;
      U.uVtpSBN.value = Math.min(1, BUMP_NORMAL[p.kernel] + (stitch ? 0.25 : 0));
      writeParams(U, r, tintRef);
      const isMToon = !!(mat as { isMToonMaterial?: boolean }).isMToonMaterial;
      const hasGloss = !!(mat.defines && 'VTP_GLOSS' in mat.defines);
      const pbr = (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial;
      const gloss = (U.uVtpS2.value as THREE.Vector4).x;
      const f: GlslFeatures = {
        kernel: p.kernel, variant: r.variant, stitch, shell: false, uv: r.mapping === 'uv' && !!g.attributes.uv,
        wobble: (U.uVtpS3.value as THREE.Vector4).z > 0, keratinAttr: ker, spec: !pbr && !hasGloss && gloss > 0.02 && (isMToon || (mat as THREE.MeshToonMaterial).isMeshToonMaterial === true),
        furVC: false,
      };
      installPatch(mat, U, f, false);
      mat.userData.vtpSurfU = U;
      mat.userData.vtpSurfF = f;
      // toon+ (High / Ultra) stepped highlight weight: matte styles none, glossy ones scaled by their gloss
      mat.userData.vtpSurfSpec = MATTE.has(p.kernel) ? 0 : 0.45 * gloss;
      const fromLook = !!look && (lookupMap(look.surfaces, [src.name, mat.name]) !== null || (!e.mesh.userData.vtpCostume && normalizeSurface(look.surface)?.style === r.spec.style));
      rec = { mat, r, U, tintRef, fromLook };
      done.set(mat, rec);
      out.mats.push(rec);
    }
    // shells (fur / pile): one instanced mesh per (mesh, slot)
    if (r.shells !== 'off' && p.shellKind && (r.spec.furLength ?? p.furLength) > 0.0005) {
      try { out.shells.push(makeShell(e.mesh, e.slot, mat, rec, r.shells === 'always', p.shellKind, faceU)); out.setWind(num(r.spec.droop, p.droop), num(r.spec.wind, p.wind)); }
      catch (err) { out.warnings.push(`fur shells on '${e.mesh.name}': ${(err as Error).message}`); }
    }
  }
  // outlines: per-style width (0 = none)
  for (const o of outlines) {
    for (const om of ([] as THREE.Material[]).concat(o.material)) {
      if (!om || om.userData.vtpSurfOutline) continue;
      const src = om.userData.vtpSrc as THREE.Material | undefined;
      const r = src?.userData.vtpStyleSpec as Resolved | undefined;
      if (!r) continue;
      om.userData.vtpSurfOutline = true;
      const k = Math.max(0, num(r.spec.outline, r.preset.outline));
      const u = (om as THREE.ShaderMaterial).uniforms?.uWidth;
      if (k < 0.01) om.visible = false;
      else if (u) u.value *= k;
    }
  }
  // VRM: MToon outline materials ("<name> (Outline)") follow their styled material's outline width
  const styledByName = new Map(out.mats.map((r) => [r.mat.name, r]));
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
      const mo = m as THREE.Material & { isOutline?: boolean; outlineWidthFactor?: number };
      if (!mo?.isOutline || mo.userData.vtpSurfOutline) continue;
      const rec = styledByName.get(mo.name.replace(/ \(Outline\)$/, ''));
      if (!rec) continue;
      mo.userData.vtpSurfOutline = true;
      const k = Math.max(0, num(rec.r.spec.outline, rec.r.preset.outline));
      if (k < 0.01) mo.visible = false;
      else if (typeof mo.outlineWidthFactor === 'number') mo.outlineWidthFactor *= k;
    }
  });
  ALL.add(out);
  out.applyQuality();
  return out;
}

function currentMaterial(mesh: THREE.Mesh, slot: number | null): THREE.Material | null {
  const m = mesh.material;
  return (Array.isArray(m) ? m[slot ?? 0] : m) ?? null;
}

function makeShell(mesh: THREE.Mesh, slot: number | null, mat: THREE.Material, rec: MatRec, always: boolean, kind: 1 | 2, faceU: THREE.Vector4[]): ShellRec {
  const src = mesh.geometry;
  const g = new THREE.InstancedBufferGeometry();
  g.index = src.index;
  for (const [k, a] of Object.entries(src.attributes)) g.setAttribute(k, a);
  g.morphAttributes = src.morphAttributes;
  g.morphTargetsRelative = src.morphTargetsRelative;
  for (const gr of src.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  g.boundingBox = src.boundingBox; g.boundingSphere = src.boundingSphere;
  g.instanceCount = 1;
  // shell material: the host's own material type + all its patches (same closure), plus the shell layer code
  const ud = mat.userData; mat.userData = {};
  const sm = mat.clone();
  mat.userData = ud;
  sm.userData = { source: ud.source, vtpShell: true, vtpSurfSpec: ud.vtpSurfSpec };
  sm.onBeforeCompile = baseCompile(mat);
  sm.customProgramCacheKey = baseKey(mat);
  sm.defines = { ...(mat.defines ?? {}) };
  sm.transparent = false; sm.depthWrite = true; sm.opacity = 1;
  const f = { ...(mat.userData.vtpSurfF as GlslFeatures), shell: true, furVC: !!src.attributes.color };
  const U = { ...rec.U, uVtpShellN: { value: 1 }, uVtpSFace: { value: faceU } };
  installPatch(sm, U, f, true);
  sm.userData.vtpSurfU = U;
  let shellMats: THREE.Material | THREE.Material[] = sm;
  if (slot !== null && Array.isArray(mesh.material)) {
    const arr: THREE.Material[] = [];
    (mesh.material as THREE.Material[]).forEach((_, i) => { arr[i] = i === slot ? sm : hiddenMat(); });
    shellMats = arr;
  }
  let shell: THREE.Mesh;
  if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
    const sk = mesh as THREE.SkinnedMesh;
    const s = new THREE.SkinnedMesh(g, shellMats);
    s.bind(sk.skeleton, sk.bindMatrix);
    shell = s;
  } else shell = new THREE.Mesh(g, shellMats);
  shell.name = `${mesh.name}_vtpFur`;
  shell.userData.vtpShell = true; shell.userData.vtpNoToon = true; shell.userData.vtpGenerated = true;
  shell.position.copy(mesh.position); shell.quaternion.copy(mesh.quaternion); shell.scale.copy(mesh.scale);
  shell.frustumCulled = false;
  shell.castShadow = false; shell.receiveShadow = true;
  shell.morphTargetDictionary = mesh.morphTargetDictionary;
  shell.morphTargetInfluences = mesh.morphTargetInfluences;
  mesh.parent?.add(shell);
  return { mesh: shell, kind, always, mats: [sm] };
}

/** Other slots of a multi-material shell mesh: never drawn (the renderer skips invisible group materials). */
let hidden: THREE.MeshBasicMaterial | null = null;
function hiddenMat() { return (hidden ??= Object.assign(new THREE.MeshBasicMaterial({ visible: false }), { name: 'vtp-hidden' })); }

// the host material's onBeforeCompile / cache key BEFORE our patch (the shell adds its own copy of the patch)
function baseCompile(m: THREE.Material): THREE.Material['onBeforeCompile'] { return (m.userData.vtpSurfPrevCompile as THREE.Material['onBeforeCompile'] | undefined) ?? m.onBeforeCompile; }
function baseKey(m: THREE.Material): () => string { return (m.userData.vtpSurfPrevKey as (() => string) | undefined) ?? m.customProgramCacheKey; }

// ------------------------------------------------------------------ page-level controls
/** Graphics tier → style quality (Performance / Balanced / Classic = 0, High = 1, Ultra = 2). No compiles. */
export function setSurfaceQuality(level: 'performance' | 'balanced' | 'high' | 'ultra' | string) {
  const q = level === 'ultra' ? 2 : level === 'high' ? 1 : 0;
  GLOBAL.uVtpSQ.value = q;
  if (q === quality) return;
  quality = q;
  for (const s of ALL) s.applyQuality();
}
export const surfaceQuality = () => quality;

/** Pre-warm: run `fn` (e.g. renderer.compile) with every hidden shell mesh visible, so a later tier step shows them
 *  without compiling mid-show. */
export function withSurfaceShells<T>(fn: () => T): T {
  const hidden: THREE.Mesh[] = [];
  for (const s of ALL) for (const r of s.shells) if (!r.mesh.visible) { r.mesh.visible = true; hidden.push(r.mesh); }
  try { return fn(); } finally { for (const m of hidden) m.visible = false; }
}
