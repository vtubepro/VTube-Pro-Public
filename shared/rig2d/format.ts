// VTube Pro's own rigged-2D puppet format ("VTube Pro 2D rig", .vtp2). Spec: docs/RIG2D_FORMAT.md.
// This file is the SINGLE source of truth: the constants (extension, magic, MIME type), the TypeScript types and the
// zod schema the validator and the published JSON Schema (rig2dJsonSchema()) are made from.
//
// Container: a ZIP archive (shared/rig2d/container.ts) holding
//   mimetype            the MIME type below, first entry, stored (lets tools sniff the file like EPUB / ODF)
//   rig.json            the manifest: this schema (magic + version first)
//   buffers/<n>.bin     little-endian binary arrays referenced by BufferViews (positions, uvs, indices, curves …)
//   textures/<n>.png    the art (PNG or WebP), straight (not premultiplied) alpha; optional normal / emission / rim maps
//   thumb.png           optional preview
// Model space: units are canvas pixels, x right, y DOWN, (0, 0) at the canvas's top-left.
//
// Everything a Live2D Cubism model expresses has a place here (art meshes, draw / render order, masks, blend modes,
// warp + rotation deformers, parameters with multi-parameter keyform grids, blend shapes, glue, parts, physics,
// expressions, motions, part-switching poses, eye-blink / lip-sync roles, hit areas), plus what Live2D lacks: per-part
// depth (2.5D parallax), bones + skinning, normal / rim / emission maps, procedural springs / jiggle / wind, an
// expression state machine with voice / emotion / chat triggers, attachments, particles, costume layers, multi-angle
// view sets, light-aware outlines and animated (sprite-sheet) textures. The runtime (src/avatar/flat/rig2d/) implements
// the core set; docs/RIG2D_FORMAT.md lists what each runtime version supports.
import { IMPORT_LIMITS } from './limits.ts';
import { z } from 'zod';

/** Rename the format here only (extension, magic, MIME type all derive from this block). */
export const RIG2D = {
  /** File extension (with the dot). */
  ext: '.vtp2',
  /** rig.json "magic" field. */
  magic: 'VTP2-RIG',
  /** The `mimetype` entry (first zip entry). */
  mime: 'application/vnd.vtubepro.rig2d+zip',
  /** Manifest file name inside the archive. */
  manifest: 'rig.json',
  /** Current format version written by this code; readers accept <= this. */
  version: 1,
  /** Human name. */
  name: 'VTube Pro 2D rig',
} as const;

/** Limits every reader enforces (untrusted files). */
export const RIG2D_LIMITS = {
  zipEntries: 4096, manifestBytes: 32 << 20, bufferBytes: 512 << 20, totalBytes: 1 << 30, textureBytes: IMPORT_LIMITS.textureBytes, textureSide: IMPORT_LIMITS.textureSide,
  params: 4096, parts: 8192, deformers: 16384, meshes: 16384, vertices: 4_000_000, keysPerAxis: 256, gridAxes: 8, keyformsPerGrid: 65536,
  motions: 2048, curves: 4096, expressions: 1024, physics: 1024, particlesPerStrand: 128,
};

const id = z.string().min(1).max(128);
const name = z.string().max(256);
const fin = z.number().finite();
const idx = z.number().int().min(-1);
const nonneg = z.number().int().min(0);
const vec2 = z.tuple([fin, fin]);
const vec3 = z.tuple([fin, fin, fin]);
const color = z.tuple([fin, fin, fin]);

/** A typed slice of a binary buffer. `count` = number of ELEMENTS (not bytes). Offsets are aligned to the element size. */
export const BufferViewSchema = z.object({
  buffer: nonneg,
  offset: nonneg,
  count: nonneg,
  type: z.enum(['f32', 'i32', 'u32', 'u16', 'i16', 'u8']),
}).strict();
export type BufferView = z.infer<typeof BufferViewSchema>;

// ---------------------------------------------------------------- resources
export const TextureSchema = z.object({
  file: z.string().max(256),
  width: z.number().int().min(1).max(RIG2D_LIMITS.textureSide),
  height: z.number().int().min(1).max(RIG2D_LIMITS.textureSide),
  filter: z.enum(['linear', 'nearest']).default('linear'),
  /** Optional lighting maps, same size + UV layout as `file` (runtime: §8.3):
   *  normal   = tangent-space normal map, RGB = (x, y, z) * 0.5 + 0.5, +x right, +y UP in the picture (OpenGL style);
   *  emission = RGB light the art gives off itself (added after lighting, never darkened by the room);
   *  rim      = R channel = where room-light rim lighting may appear (0 = never, 1 = full). */
  normal: z.string().max(256).optional(),
  emission: z.string().max(256).optional(),
  rim: z.string().max(256).optional(),
  /** Animated texture (§8.10): the image is a sprite sheet of cols × rows equal cells, frame f at column f % cols, row
   *  floor(f / cols) from the top-left. Meshes using the texture are UV-mapped onto the FIRST cell; the runtime shifts
   *  their UVs to the current frame. Frame = floor(time × fps) % frames, or picked by `param` (its range spread over the
   *  frames), `loop: false` = play once then hold the last frame. */
  sheet: z.object({ cols: z.number().int().min(1).max(64), rows: z.number().int().min(1).max(64), frames: z.number().int().min(1).max(4096),
    fps: fin.optional(), param: id.optional(), loop: z.boolean().optional() }).strict().optional(),
}).strict();
export type Rig2DTexture = z.infer<typeof TextureSchema>;

export const ParamSchema = z.object({
  id,
  name,
  min: fin, max: fin, default: fin,
  /** Wraps around (like an angle that turns all the way). */
  repeat: z.boolean().optional(),
  /** 'blend' = a blend-shape parameter (drives `blendShapes`, not keyform grids). */
  kind: z.enum(['normal', 'blend']).optional(),
  group: id.optional(),
  /** Number of decimals editors show. */
  decimals: z.number().int().min(0).max(8).optional(),
}).strict();
export type Rig2DParam = z.infer<typeof ParamSchema>;

/** A keyform grid: the objects that use it have one keyform per grid point. Axis 0 varies fastest:
 *  keyform index = i0 + n0 * (i1 + n1 * (i2 + …)). An empty `axes` list = exactly one keyform (static). */
export const GridSchema = z.object({
  axes: z.array(z.object({ param: nonneg, keys: z.array(fin).min(1).max(RIG2D_LIMITS.keysPerAxis) }).strict()).max(RIG2D_LIMITS.gridAxes),
}).strict();
export type Rig2DGrid = z.infer<typeof GridSchema>;

/** Multiply (rgb, 1 = none) and screen (rgb, 0 = none) colours, one triple per keyform (views of f32 × 3 × keyforms). */
const ColorKeys = z.object({ multiply: BufferViewSchema.optional(), screen: BufferViewSchema.optional() }).strict();

// ---------------------------------------------------------------- structure
export const PartSchema = z.object({
  id, name,
  parent: idx,
  grid: nonneg,
  /** Draw order per keyform (higher = in front; the draw-order groups decide the final order). */
  drawOrder: z.array(fin),
  /** Part opacity (1 = as authored); pose / layers / views fade parts at runtime. */
  opacity: fin.optional(),
  visible: z.boolean(),
  enabled: z.boolean(),
  /** 2.5D: depth of this part (model px; + = toward the viewer). Children add their own. */
  depth: fin.optional(),
}).strict();
export type Rig2DPart = z.infer<typeof PartSchema>;

export const DeformerSchema = z.object({
  id, name,
  kind: z.enum(['warp', 'rotation']),
  /** Parent deformer (-1 = model space) and owning part (-1 = none). */
  parent: idx,
  part: idx,
  grid: nonneg,
  enabled: z.boolean(),
  visible: z.boolean(),
  /** Opacity per keyform. */
  opacity: z.array(fin),
  /** Warp: a (rows + 1) × (cols + 1) lattice of points per keyform (f32 × 2, row-major from the top-left). Children's
   *  coordinates are in the lattice's normalised space ([0, 1]² spans it; outside is extrapolated). */
  warp: z.object({ rows: z.number().int().min(1).max(256), cols: z.number().int().min(1).max(256), quad: z.boolean(), points: BufferViewSchema }).strict().optional(),
  /** Rotation: per keyform an angle (degrees, + = clockwise on screen), origin (in the parent's space), scale and
   *  mirror flags; `baseAngle` is added to every keyform. Children's coordinates are in the rotated frame. */
  rotation: z.object({ baseAngle: fin, angle: z.array(fin), originX: z.array(fin), originY: z.array(fin), scale: z.array(fin),
    reflectX: z.array(z.boolean()), reflectY: z.array(z.boolean()) }).strict().optional(),
  color: ColorKeys.optional(),
}).strict();
export type Rig2DDeformer = z.infer<typeof DeformerSchema>;

export const BLEND_MODES = ['normal', 'add', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'clipToLower', 'sliceFromLower'] as const;
export type Rig2DBlend = typeof BLEND_MODES[number];

export const MeshSchema = z.object({
  id, name,
  part: idx,
  deformer: idx,
  texture: nonneg,
  grid: nonneg,
  vertexCount: z.number().int().min(1).max(65535),
  /** f32 × 2 per vertex, v measured from the TOP of the texture. */
  uvs: BufferViewSchema,
  /** Triangles (u16 or u32 × 3). */
  indices: BufferViewSchema,
  /** f32 × 2 × vertexCount per keyform (in the parent deformer's space). */
  positions: BufferViewSchema,
  opacity: z.array(fin),
  drawOrder: z.array(fin),
  blend: z.enum(BLEND_MODES),
  /** false = back faces are culled. */
  doubleSided: z.boolean(),
  /** Clipping: the mesh shows only where these meshes are drawn (their texture alpha > 0.5); maskInvert = only where
   *  they are NOT. */
  masks: z.array(nonneg).max(64),
  maskInvert: z.boolean().optional(),
  visible: z.boolean(),
  enabled: z.boolean(),
  color: ColorKeys.optional(),
  depth: fin.optional(),
  /** Bones + skinning (§8.2, applied after the deformers, in model space): up to 4 bone indices (u16 × 4) and weights
   *  (f32 × 4, summing to 1; a vertex whose weights sum to 0 is left as the deformers placed it) per vertex. */
  skin: z.object({ joints: BufferViewSchema, weights: BufferViewSchema }).strict().optional(),
  /** Ink outline around this mesh's drawn silhouette (§8.10): `width` in canvas px (drawn in screen space around the
   *  art, also past the mesh's edges: no margin needed), `color` linear RGB 0..1, `opacity` 0..1 (default 1);
   *  lightResponsive = the ink takes the room key light's colour and goes lighter on the lit side. */
  outline: z.object({ width: fin, color, opacity: fin.optional(), lightResponsive: z.boolean().optional() }).strict().optional(),
}).strict();
export type Rig2DMesh = z.infer<typeof MeshSchema>;

/** Render order: groups of objects (meshes and parts) sorted by their evaluated draw order; a part entry reserves room
 *  for its own group's `total` objects. Missing = sort every mesh by draw order. */
export const DrawGroupSchema = z.object({
  min: fin, max: fin, total: nonneg,
  items: z.array(z.object({ kind: z.enum(['mesh', 'part']), index: nonneg, group: idx }).strict()),
}).strict();

export const GlueSchema = z.object({
  id, name: name.optional(),
  a: nonneg, b: nonneg, grid: nonneg,
  intensity: z.array(fin),
  /** pairs of vertex indices (mesh a, mesh b) and their weights (f32 × 2 per pair). */
  pairs: BufferViewSchema,
  weights: BufferViewSchema,
}).strict();

/** Blend shapes: ADDITIVE changes driven by one parameter (on top of the keyform grids). Mesh / warp targets add point
 *  offsets (f32 × 2 × points per key); rotation, part, glue and opacity targets add per-key values. */
export const BlendShapeSchema = z.object({
  target: z.object({ kind: z.enum(['mesh', 'warp', 'rotation', 'part', 'glue']), index: nonneg }).strict(),
  param: nonneg,
  keys: z.array(fin).min(1),
  /** Optional second parameter: a 2D additive grid (e.g. a head yaw × pitch pad). Key index = i + keys.length × j. */
  param2: nonneg.optional(),
  keys2: z.array(fin).min(1).optional(),
  offsets: BufferViewSchema.optional(),
  values: z.object({ angle: z.array(fin).optional(), originX: z.array(fin).optional(), originY: z.array(fin).optional(), scale: z.array(fin).optional(),
    opacity: z.array(fin).optional(), drawOrder: z.array(fin).optional(), intensity: z.array(fin).optional() }).strict().optional(),
  /** Weight limits from other parameters (min of all). */
  constraints: z.array(z.object({ param: nonneg, keys: z.array(fin), weights: z.array(fin) }).strict()).optional(),
}).strict();

// ---------------------------------------------------------------- behaviour
export const STANDARD_ROLES = ['headYaw', 'headPitch', 'headRoll', 'bodyYaw', 'bodyPitch', 'bodyRoll', 'eyeOpenL', 'eyeOpenR', 'eyeSmileL', 'eyeSmileR',
  'gazeX', 'gazeY', 'browLY', 'browRY', 'browLForm', 'browRForm', 'mouthOpen', 'mouthForm', 'cheek', 'breath', 'voice'] as const;

export const RolesSchema = z.object({
  /** Parameters closed by blinks (automatic blinks when untracked). */
  eyeBlink: z.array(id).default([]),
  /** Parameters opened by the voice. */
  lipSync: z.array(id).default([]),
  /** Which parameter each tracked input drives (standard role → parameter id; axis for 2D params). */
  bind: z.partialRecord(z.enum(STANDARD_ROLES), z.union([id, z.object({ param: id, gain: fin.optional(), invert: z.boolean().optional(),
    /** map the role's value [inLo, inHi] onto the parameter's [outLo, outHi] (after gain / invert) */
    range: z.tuple([fin, fin, fin, fin]).optional() }).strict()])).optional(),
}).strict();

export const PhysicsSchema = z.object({
  id, name: name.optional(),
  inputs: z.array(z.object({ param: id, weight: fin, type: z.enum(['x', 'y', 'angle']), reflect: z.boolean() }).strict()).min(1),
  outputs: z.array(z.object({ param: id, particle: nonneg, scale: fin, weight: fin, type: z.enum(['x', 'y', 'angle']), reflect: z.boolean() }).strict()).min(1),
  particles: z.array(z.object({ x: fin, y: fin, mobility: fin, delay: fin, acceleration: fin, radius: fin }).strict()).min(2).max(RIG2D_LIMITS.particlesPerStrand),
  normalize: z.object({ position: vec3, angle: vec3 }).strict(),
}).strict();
export type Rig2DPhysics = z.infer<typeof PhysicsSchema>;

/** Procedural secondary motion beyond pendulum strands (§6.3). Inputs and outputs are parameter ids; an input may also be
 *  a tracked role ("role:headYaw", "role:voice" …, shared/rig2d/drive.ts). Values are normalised to −1..1 over each
 *  parameter's range around its default. Fixed 120 Hz steps: the same inputs give the same output on every page.
 *   (each ADDS to its output parameter's value: = default + … when nothing else drives it)
 *   spring : out = default + gain × y, y follows the input like a mass on a spring (stiffness k, damping c): a lagging,
 *            overshooting copy of it (a ponytail following the head turn).
 *   jiggle : out = default + gain × (y − x): only the wobble around the input (a hat or chest bouncing when the head
 *            moves, ears flicking when talking starts).
 *   wind   : out = default + gain × strength × wind × gust(t): gusts (sum of sines, `period` s, phase from the id) times
 *            the room's wind (0..2, 0.3 where there is no room).
 *   chain  : bone physics (§8.2): the listed bones (root first) swing as a damped chain driven by the root's motion,
 *            gravity (`gravity`, model px / s², +y down) and the room's wind; adds to the bones' angles; capped by
 *            `boneLimit` per bone (default 50°) and `limit` for the whole chain (default 90°).
 *   follow  : follow-through on a mesh's vertices (§8.4, shared/rig2d/follow.ts): the listed `meshes` lag behind whatever moves
 *            them and settle fast (damping defaults to near-critical, 1.7·√stiffness); the `anchor` side of each mesh (`reach` of
 *            its extent, then a smooth fall-off over the same again) is held, `spread` (0..1) lets the overlap travel outward
 *            from it, `squash` (0..1) stretches the free region along a whip and thins it across (area kept), `stretch` caps
 *            any vertex's offset (a fraction of the mesh's size). Written to the final vertex positions after skinning, so it
 *            rides on every parent, bone and slider. Uses stiffness / damping / gravity / gain / amount too.
 *  `amount` (any kind but pendulum): a parameter whose CURRENT value scales the solver's motion — 0 = still, 1 = as
 *  authored, 2 = twice (clamped 0..4): springs / jiggle / wind multiply their output (first held to −1..1) by it, a chain multiplies what
 *  drives it (root motion, gravity, wind), so its limits still hold. One control for a part's whole swing, which a
 *  performer can hold as a model slider; absent = 1 (files without it behave exactly as before).
 *  Every solver starts AT REST on the first evaluated pose (no kick when a rig loads); wind fades in over 1 s. */
export const DynamicSchema = z.object({
  id, kind: z.enum(['spring', 'jiggle', 'wind', 'chain', 'pendulum', 'follow']),
  input: id.optional(),
  output: id.optional(),
  /** pendulum: the second output (y of the mapping) — absent = a single output. */
  output2: id.optional(),
  /** pendulum: the deformer whose evaluated frame is the anchor (its origin moves the pivot). */
  deformer: id.optional(),
  /** pendulum: 'pendulum' = rigid rod, 'spring' = spring pendulum (radial spring at `frequency`). */
  model: z.enum(['pendulum', 'spring']).optional(),
  /** pendulum: how the bob maps onto (output, output2): angle = atan2(−x, y) / π, length = L / length, x / y = the bob's
   *  direction × length in the anchor frame (xy: x and 1 − y; yx swapped). */
  map: z.enum(['angleLength', 'lengthAngle', 'xy', 'yx']).optional(),
  /** pendulum: rest length (model px), spring frequency (Hz), critical-damping ratios. */
  length: fin.optional(), frequency: fin.optional(), angleDamping: fin.optional(), lengthDamping: fin.optional(),
  outputScale: vec2.optional(),
  /** pendulum: the bob lives in the anchor's parent frame (moves only with the anchor's own local motion). */
  localOnly: z.boolean().optional(),
  /** chain: bone ids, root first. */
  bones: z.array(id).max(64).optional(),
  stiffness: fin.optional(), damping: fin.optional(), gain: fin.optional(),
  strength: fin.optional(), period: fin.optional(), gravity: fin.optional(),
  /** chain: cap on the whole chain's bend (the sum of its bones' swing), degrees (default 90), and on each bone's own
   *  swing relative to its parent (default 50). */
  limit: fin.optional(), boneLimit: fin.optional(),
  /** follow: the mesh ids that follow through, which side of each is held still (default top), the fraction of its extent that is
   *  fully held (reach, default 0.25), neighbour coupling 0..1 (spread, default 0.6), the cap on any vertex's offset as a
   *  fraction of the mesh's diagonal (stretch, default 0.2) and the squash and stretch 0..1 (squash, default 0.5). */
  meshes: z.array(id).max(256).optional(),
  anchor: z.enum(['top', 'bottom', 'left', 'right', 'center']).optional(),
  reach: fin.optional(), spread: fin.optional(), stretch: fin.optional(), squash: fin.optional(),
  /** a parameter whose value scales this solver's motion (0 = still, 1 = as authored; see above) */
  amount: id.optional(),
}).strict();
export type Rig2DDynamic = z.infer<typeof DynamicSchema>;

/** Scalar colour / opacity operators on a deformer (§8.11) for what a multilinear keyform grid cannot express: several
 *  multiplicative bindings on one parameter axis, and clamping AFTER composition. Each frame the carrier deformer's own
 *  keyform opacity / multiply / screen are REPLACED by: base values; × every opacity and tint binding; + every screen
 *  binding; each result clamped to [0, 1]; then they propagate down the deformer tree as usual. A binding samples its
 *  `values` (axis 0 fastest, `keys.length × keys2.length`) bilinearly with clamped ends. */
export const MaterialBindingSchema = z.object({
  deformer: nonneg,
  opacity: fin, multiply: color, screen: color,
  bindings: z.array(z.object({
    channel: z.enum(['opacity', 'tint.r', 'tint.g', 'tint.b', 'screenTint.r', 'screenTint.g', 'screenTint.b']),
    param: nonneg, keys: z.array(fin).min(1).max(256), param2: nonneg.optional(), keys2: z.array(fin).min(1).max(256).optional(),
    values: z.array(fin).min(1).max(65536),
  }).strict()).max(4096),
}).strict();
export type Rig2DMaterialBinding = z.infer<typeof MaterialBindingSchema>;

export const ExpressionSchema = z.object({
  id, name,
  fadeIn: fin, fadeOut: fin,
  params: z.array(z.object({ param: id, value: fin, blend: z.enum(['add', 'multiply', 'overwrite']) }).strict()),
  parts: z.array(z.object({ part: id, opacity: fin }).strict()).optional(),
  key: z.string().max(24).optional(),
}).strict();
export type Rig2DExpression = z.infer<typeof ExpressionSchema>;

/** A motion curve: `times` / `values` are the points; `segments` has one entry per gap between points:
 *  0 linear, 1 cubic Bézier (two control points per segment in `controls`: t1, v1, t2, v2), 2 hold the start value,
 *  3 jump to the end value at the segment start. Inline arrays or buffer views (long curves). */
export const CurveSchema = z.object({
  /** param / part (opacity) by id; blink / lipSync scale the eye-blink / lip-sync roles; opacity = the whole puppet's
   *  opacity (id ignored, use "Opacity"). */
  target: z.enum(['param', 'part', 'blink', 'lipSync', 'opacity']),
  id,
  fadeIn: fin.optional(), fadeOut: fin.optional(),
  times: z.union([z.array(fin), BufferViewSchema]),
  values: z.union([z.array(fin), BufferViewSchema]),
  segments: z.union([z.array(z.number().int().min(0).max(3)), BufferViewSchema]),
  controls: z.union([z.array(fin), BufferViewSchema]).optional(),
}).strict();
export type Rig2DCurve = z.infer<typeof CurveSchema>;

export const MotionSchema = z.object({
  id, name, group: z.string().max(64),
  duration: fin, loop: z.boolean(), fadeIn: fin, fadeOut: fin,
  /** Bézier timing: true = control-point times are only hints (evaluate by curve fraction), false = solve x(t). */
  bezierByFraction: z.boolean().optional(),
  curves: z.array(CurveSchema).max(RIG2D_LIMITS.curves),
  events: z.array(z.object({ t: fin, value: z.string().max(256) }).strict()).optional(),
  key: z.string().max(24).optional(),
}).strict();
export type Rig2DMotion = z.infer<typeof MotionSchema>;

/** Part switching: in each group the first member whose same-named parameter is on (> 0.001) shows, the rest fade out. */
export const SwitchSchema = z.object({ fade: fin, members: z.array(z.object({ part: id, links: z.array(id) }).strict()).min(1) }).strict();

export const HitAreaSchema = z.object({ id, name, mesh: id }).strict();

// ---------------------------------------------------------------- beyond Live2D
/** Bones (§8.2). A bone's local transform = translate(x + dx, y + dy) · rotate(angle + da) · scale(sx, sy) relative to
 *  its parent bone; dx / dy / da are its keyform OFFSETS and sx / sy its keyform SCALES (1 = rest), blended on `grid` like
 *  any keyform. Angles in degrees, + = clockwise on screen (as rotation deformers). Lengths and offsets are model units.
 *  A ROOT bone (parent −1) sits in model space, or — with `deformer` (a deformer index) — follows that deformer: its x / y
 *  (and its keyform x / y offsets) are then in the deformer's coordinates (normalised [0, 1]² for a warp) and each frame its origin is mapped through the
 *  deformer chain and its angle turned by the chain's local turn there (an "up" probe, exactly as a rotation deformer
 *  under a parent); its children follow it.
 *  Skinning (mesh.skin) runs after the deformers: p' = Σ wᵢ · (Bᵢ · Rᵢ⁻¹) · p, p = the vertex after deformers + glue,
 *  Bᵢ = bone i's model-space transform now, Rᵢ = the same chain with every keyform offset 0 / scale 1 and no chain
 *  physics — evaluated NOW, so a bone that follows a deformer moves its pivot with the deformer and only the bone's own
 *  motion bends the mesh (no double transform). Without `deformer`, Rᵢ is the constant rest pose. */
export const BoneSchema = z.object({
  id, name, parent: idx,
  deformer: idx.optional(),
  x: fin, y: fin, angle: fin, length: fin,
  grid: nonneg,
  keyforms: z.object({ angle: z.array(fin), x: z.array(fin), y: z.array(fin), scaleX: z.array(fin), scaleY: z.array(fin) }).strict(),
}).strict();
export type Rig2DBone = z.infer<typeof BoneSchema>;

/** The expression state machine (§8.5). Each layer is in one state; a state shows an expression, plays a motion once on
 *  entry, and / or blends expressions by a value (1D blend tree). Transitions from a state ('*' = any) fire on:
 *   voice   : voice level ≥ above (default 0.15) for `after` s      silence : voice < 0.15 for `after` s
 *   emotion : the performer's detected emotion = value (happy, sad, angry, surprised, neutral …), level ≥ above
 *   chat    : a chat message containing `value` (case-insensitive; empty = any message)
 *   event   : a stream event named `value` (follow, sub, raid, cheer, donation, redeem …)
 *   hotkey  : the studio held state / expression cue = value      param : parameter `value` above / below a bound
 *   timer   : `after` s in the state
 *  `fade` = cross-fade time of the expressions (default: the expressions' own). */
export const StateMachineSchema = z.object({
  layers: z.array(z.object({
    id, name: name.optional(), initial: id,
    states: z.array(z.object({
      id,
      expression: id.optional(),
      motion: id.optional(),
      /** 1D blend tree: expressions weighted by a value: a parameter id or a role ("role:voice", "role:mouthForm" …). */
      blend: z.object({ by: id, points: z.array(z.object({ at: fin, expression: id }).strict()).min(2) }).strict().optional(),
    }).strict()).min(1),
    transitions: z.array(z.object({
      from: z.string().max(128), to: id, fade: fin.optional(),
      on: z.object({
        kind: z.enum(['voice', 'silence', 'emotion', 'chat', 'hotkey', 'param', 'timer', 'event']),
        value: z.string().max(128).optional(), above: fin.optional(), below: fin.optional(), after: fin.optional(),
      }).strict(),
    }).strict()),
  }).strict()),
}).strict();
export type Rig2DStates = z.infer<typeof StateMachineSchema>;

/** Where an attachment / particle emitter sits (§8.6): on a bone (bone frame, x / y in the bone's local units), on a
 *  mesh vertex (follows it; `vertex2` gives the orientation: the direction vertex → vertex2 is the slot's +x), or in a
 *  deformer's space (x / y in that deformer's coordinates: normalised for warps). */
export const SlotSchema = z.object({ bone: id.optional(), mesh: id.optional(), vertex: nonneg.optional(), vertex2: nonneg.optional(), deformer: id.optional(),
  x: fin.optional(), y: fin.optional() }).strict();
/** Draw position: right after the mesh `above` (on top of it), or 'front' / 'back' of everything (default front). */
const DrawAt = z.object({ above: id.optional(), at: z.enum(['front', 'back']).optional() }).strict();

/** Attachments (§8.6): a textured picture pinned to a slot (held props, hats, glasses …). `rect` = the picture's texture
 *  rectangle (u, v, w, h, v from the top), `pivot` (0..1 inside the rect) sits on the slot, `size` in model units,
 *  `angle` degrees added to the slot's turn. Shown when `on` (or switched by a costume layer). */
export const AttachmentSchema = z.object({
  id, name,
  slot: SlotSchema,
  texture: nonneg,
  rect: z.tuple([fin, fin, fin, fin]), pivot: vec2,
  size: vec2, angle: fin.optional(),
  on: z.boolean(),
  draw: DrawAt.optional(),
  blend: z.enum(['normal', 'add', 'multiply', 'screen']).optional(),
  /** Follows the slot's turn (default true); false = stays upright (a hanging sign). */
  rotate: z.boolean().optional(),
}).strict();
export type Rig2DAttachment = z.infer<typeof AttachmentSchema>;

/** Particle emitters (§8.7): sparkles, tears, sweat, steam, hearts … emitted at a slot while the trigger holds.
 *  `rate` per second, `life` s, `speed` [min, max] model units / s in direction `angle` (degrees, 0 = up, + = clockwise)
 *  ± `spread` degrees, `gravity` [x, y] model units / s² (+y down), `size` [start, end] model units, `spin` degrees / s,
 *  `fade` = share of the life spent fading out (default 0.3), `max` = the emitter's cap (the graphics tier caps the
 *  whole puppet: Low 0 … High 512). Seeded: the same frames give the same particles. */
export const ParticleSchema = z.object({
  id, name: name.optional(),
  slot: SlotSchema,
  texture: nonneg, rect: z.tuple([fin, fin, fin, fin]),
  rate: fin, life: fin, speed: vec2, angle: fin.optional(), spread: fin, gravity: vec2, size: vec2, spin: fin.optional(), fade: fin.optional(),
  max: z.number().int().min(1).max(4096).optional(),
  blend: z.enum(['normal', 'add', 'screen']).optional(),
  draw: DrawAt.optional(),
  /** always · voice (level ≥ above) · param (`value` id ≥ above) · emotion (= value) · chat (contains value) · event
   *  (= value) · hotkey (cue = value) · expression (the expression `value` shows) — event-like triggers emit for
   *  `burst` s (default 1). */
  trigger: z.object({ kind: z.enum(['always', 'voice', 'emotion', 'chat', 'hotkey', 'param', 'event', 'expression']), value: z.string().max(128).optional(),
    above: fin.optional(), burst: fin.optional() }).strict(),
}).strict();
export type Rig2DParticle = z.infer<typeof ParticleSchema>;

/** Costume layers (§8.8): sets of parts and attachments switched together at runtime; `group` = only one layer of the
 *  group at a time (outfits); `on` = shown by default. The studio's 2D panel / costume list switches them. */
export const LayerSchema = z.object({ id, name, parts: z.array(id), attachments: z.array(id).optional(), group: z.string().max(64).optional(), on: z.boolean() }).strict();

/** Multi-angle views (§8.4): part sets drawn for different head turns; `by` = the turn parameter (or "role:headYaw"),
 *  each set shows fully at its `at` value and cross-fades to its neighbours in between. Parts in no set are unaffected. */
export const ViewsSchema = z.object({
  by: id,
  sets: z.array(z.object({ id, at: fin, parts: z.array(id) }).strict()).min(2),
  /** Hand-over between neighbouring sets (§8.9): half-width of the band around the midpoint, in `by` units (default 2),
   *  and the hysteresis that keeps the current set until the value is this far past the midpoint (default 2: the hand-over starts AT the midpoint). */
  blendBand: fin.optional(), hysteresis: fin.optional(),
}).strict();

export const DepthSchema = z.object({
  /** Parameters (degrees) that turn the whole puppet; parts / meshes with `depth` shift by depth × sin(angle) × strength. */
  yaw: id.optional(), pitch: id.optional(), strength: fin,
}).strict();

/** Room lighting (§8.3). Without texture maps, the puppet stays flat (the card's room tint applies as before). With a
 *  normal map: relief shading from the room's key + fill lights, normalised so a surface facing the viewer keeps its
 *  painted colour (strength 0..1, default 0.8). Rim: light-coloured edge light where the rim map allows (and, with a
 *  normal map, where normals face away from the viewer), `width` 0..1, `strength` 0..2. Emission maps always add. */
export const LightingSchema = z.object({
  tint: fin.optional(),
  strength: fin.optional(),
  rim: z.object({ width: fin, strength: fin }).strict().optional(),
}).strict();

// ---------------------------------------------------------------- the document
export const MetaSchema = z.object({
  name, authors: z.array(name).max(32).optional(), license: z.string().max(512).optional(), licenseUrl: z.string().max(512).optional(),
  /** Usage rights as stated by the author. */
  rights: z.object({ users: z.enum(['author', 'licensees', 'everyone']).optional(), commercial: z.boolean().optional(), redistribution: z.boolean().optional(),
    modification: z.boolean().optional(), attribution: z.boolean().optional() }).strict().optional(),
  notes: z.string().max(4096).optional(),
  /** Where it came from (converted models keep a pointer; the original files are not kept). */
  source: z.object({ kind: z.enum(['native', 'live2d', 'inochi2d']), file: z.string().max(256).optional(), version: z.string().max(64).optional(),
    converter: z.string().max(128).optional(), at: z.string().max(64).optional() }).strict().optional(),
}).strict();

export const Rig2DDocSchema = z.object({
  magic: z.literal(RIG2D.magic),
  version: z.number().int().min(1).max(RIG2D.version),
  meta: MetaSchema,
  /** The picture area in px. Geometry at the top of the deformer tree is in MODEL UNITS: px = x × unit + originX,
   *  py = y × unit + originY (native rigs: unit 1, origin 0 = plain pixels; converted Live2D models keep their units). */
  canvas: z.object({ width: fin, height: fin, unit: fin.optional(), originX: fin.optional(), originY: fin.optional() }).strict(),
  buffers: z.array(z.object({ file: z.string().max(256), byteLength: nonneg }).strict()).max(256),
  textures: z.array(TextureSchema).max(256),
  params: z.array(ParamSchema).max(RIG2D_LIMITS.params),
  grids: z.array(GridSchema),
  parts: z.array(PartSchema).max(RIG2D_LIMITS.parts),
  deformers: z.array(DeformerSchema).max(RIG2D_LIMITS.deformers),
  meshes: z.array(MeshSchema).max(RIG2D_LIMITS.meshes),
  drawGroups: z.array(DrawGroupSchema).optional(),
  glue: z.array(GlueSchema).optional(),
  blendShapes: z.array(BlendShapeSchema).optional(),
  roles: RolesSchema,
  physics: z.array(PhysicsSchema).max(RIG2D_LIMITS.physics).optional(),
  physicsWorld: z.object({ gravity: vec2, wind: vec2, fps: fin }).strict().optional(),
  dynamics: z.array(DynamicSchema).optional(),
  materialBindings: z.array(MaterialBindingSchema).max(16384).optional(),
  expressions: z.array(ExpressionSchema).max(RIG2D_LIMITS.expressions).optional(),
  motions: z.array(MotionSchema).max(RIG2D_LIMITS.motions).optional(),
  switches: z.array(SwitchSchema).optional(),
  hitAreas: z.array(HitAreaSchema).optional(),
  bones: z.array(BoneSchema).optional(),
  states: StateMachineSchema.optional(),
  attachments: z.array(AttachmentSchema).optional(),
  particles: z.array(ParticleSchema).optional(),
  layers: z.array(LayerSchema).optional(),
  views: ViewsSchema.optional(),
  depth: DepthSchema.optional(),
  lighting: LightingSchema.optional(),
  /** Vendor / editor data (ignored by the runtime). */
  extra: z.record(z.string().max(128), z.unknown()).optional(),
}).strict();
export type Rig2DDoc = z.infer<typeof Rig2DDocSchema>;

/** The published JSON Schema (draft 2020-12) of rig.json, generated from the zod schema above. */
export function rig2dJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(Rig2DDocSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}

const ELEM: Record<BufferView['type'], number> = { f32: 4, i32: 4, u32: 4, u16: 2, i16: 2, u8: 1 };
export const elemSize = (t: BufferView['type']) => ELEM[t];

export interface Rig2DIssue { path: string; message: string }

/** Follow-through entries (kind 'follow', §8.4) live in `extra.follow` in a written file, NOT in `dynamics`: release/b141's
 *  strict DynamicSchema refuses a dynamics entry of an unknown kind, so one in `dynamics` makes an older version / OBS page
 *  refuse the whole avatar. `extra` is ignored by every older build (the same trick as `extra.vowelBind`). Files written
 *  before this (kind 'follow' inside `dynamics`) still load. */
export const FOLLOW_EXTRA_KEY = 'follow';

/** The follow entries stored in `extra.follow` that parse as a follow (anything else is skipped; validateRig2D reports it). */
function extraFollows(doc: { extra?: Record<string, unknown> }): Rig2DDynamic[] {
  const raw = doc.extra?.[FOLLOW_EXTRA_KEY];
  if (!Array.isArray(raw)) return [];
  const out: Rig2DDynamic[] = [];
  for (const y of raw) { const r = DynamicSchema.safeParse(y); if (r.success && r.data.kind === 'follow') out.push(r.data); }
  return out;
}

/** Every dynamics entry of a rig: `dynamics` plus the follow-throughs of `extra.follow` (an id in both counts once, `dynamics` wins).
 *  What the runtime, the adopter and the parameter classifier read instead of `doc.dynamics`. */
export function rig2dDynamics(doc: { dynamics?: Rig2DDynamic[]; extra?: Record<string, unknown> }): Rig2DDynamic[] {
  const base = doc.dynamics ?? [];
  const more = extraFollows(doc);
  if (!more.length) return base;
  const have = new Set(base.map((y) => y.id));
  return [...base, ...more.filter((y) => !have.has(y.id))];
}

/** The document as it is WRITTEN: every follow-through moved out of `dynamics` into `extra.follow` (see FOLLOW_EXTRA_KEY), so a
 *  build that predates follow-through still loads the file. Returns the same object when there is nothing to move. */
export function rig2dForStorage<T extends { dynamics?: Rig2DDynamic[]; extra?: Record<string, unknown> }>(doc: T): T {
  const moved = (doc.dynamics ?? []).filter((y) => y.kind === 'follow');
  if (!moved.length) return doc;
  const keep = (doc.dynamics ?? []).filter((y) => y.kind !== 'follow');
  const ids = new Set(moved.map((y) => y.id));
  const old = Array.isArray(doc.extra?.[FOLLOW_EXTRA_KEY]) ? (doc.extra![FOLLOW_EXTRA_KEY] as unknown[]).filter((y) => !ids.has((y as { id?: string } | null)?.id as string)) : [];
  const out = { ...doc, extra: { ...(doc.extra ?? {}), [FOLLOW_EXTRA_KEY]: [...old, ...moved] } };
  if (keep.length) out.dynamics = keep; else delete out.dynamics;
  return out;
}

/** Validate a parsed rig.json: schema + every cross reference + buffer view bounds (`bufferBytes[i]` = actual size of
 *  buffer i). Returns the typed document or the list of problems. */
export function validateRig2D(json: unknown, bufferBytes?: readonly number[]): { ok: true; doc: Rig2DDoc } | { ok: false; issues: Rig2DIssue[] } {
  const r = Rig2DDocSchema.safeParse(json);
  if (!r.success) return { ok: false, issues: r.error.issues.slice(0, 50).map((i) => ({ path: i.path.join('.'), message: i.message })) };
  const d = r.data, issues: Rig2DIssue[] = [];
  const bad = (path: string, message: string) => { if (issues.length < 200) issues.push({ path, message }); };
  const sizes = bufferBytes ?? d.buffers.map((b) => b.byteLength);
  const view = (v: BufferView | undefined, path: string, want?: number, types?: BufferView['type'][]) => {
    if (!v) return;
    if (v.buffer >= d.buffers.length) return bad(path, 'buffer index out of range');
    const es = ELEM[v.type];
    if (v.offset % es) bad(path, 'offset not aligned to the element size');
    if (v.offset + v.count * es > (sizes[v.buffer] ?? 0)) bad(path, 'view runs past the end of its buffer');
    if (want !== undefined && v.count !== want) bad(path, `expected ${want} elements, got ${v.count}`);
    if (types && !types.includes(v.type)) bad(path, `type must be ${types.join(' / ')}`);
  };
  const nP = d.params.length;
  const kfCount = d.grids.map((g, gi) => {
    let n = 1;
    g.axes.forEach((a, ai) => {
      if (a.param >= nP) bad(`grids.${gi}.axes.${ai}.param`, 'parameter index out of range');
      for (let k = 1; k < a.keys.length; k++) if (!(a.keys[k] > a.keys[k - 1])) bad(`grids.${gi}.axes.${ai}.keys`, 'keys must increase');
      n *= a.keys.length;
    });
    if (n > RIG2D_LIMITS.keyformsPerGrid) bad(`grids.${gi}`, 'too many keyforms');
    return n;
  });
  const grid = (g: number, path: string) => { if (g >= d.grids.length) { bad(path, 'grid index out of range'); return 0; } return kfCount[g]; };
  const per = (a: unknown[] | undefined, n: number, path: string) => { if (a && a.length !== n) bad(path, `expected ${n} values (one per keyform), got ${a.length}`); };
  const ids = (list: { id: string }[], what: string) => { const s = new Set<string>(); list.forEach((x, i) => { if (s.has(x.id)) bad(`${what}.${i}.id`, `duplicate id "${x.id}"`); s.add(x.id); }); return s; };
  const paramIds = ids(d.params, 'params'), partIds = ids(d.parts, 'parts'); ids(d.deformers, 'deformers'); const meshIds = ids(d.meshes, 'meshes');
  d.params.forEach((p, i) => { if (!(p.min <= p.default && p.default <= p.max)) bad(`params.${i}`, 'default must lie in [min, max]'); });
  d.parts.forEach((p, i) => {
    if (p.parent >= d.parts.length || p.parent === i) bad(`parts.${i}.parent`, 'bad parent');
    per(p.drawOrder, grid(p.grid, `parts.${i}.grid`), `parts.${i}.drawOrder`);
  });
  // parents must not form cycles
  const acyclic = (n: number, parent: (i: number) => number, what: string) => {
    for (let i = 0; i < n; i++) { let k = parent(i), steps = 0; while (k >= 0 && steps++ <= n) { if (k === i) { bad(`${what}.${i}.parent`, 'parent cycle'); break; } k = parent(k); } }
  };
  acyclic(d.parts.length, (i) => d.parts[i]?.parent ?? -1, 'parts');
  d.deformers.forEach((f, i) => {
    const n = grid(f.grid, `deformers.${i}.grid`);
    if (f.parent >= d.deformers.length || f.parent === i) bad(`deformers.${i}.parent`, 'bad parent');
    if (f.part >= d.parts.length) bad(`deformers.${i}.part`, 'part index out of range');
    per(f.opacity, n, `deformers.${i}.opacity`);
    if (f.kind === 'warp') {
      if (!f.warp) bad(`deformers.${i}.warp`, 'warp deformer needs warp data');
      else view(f.warp.points, `deformers.${i}.warp.points`, n * (f.warp.rows + 1) * (f.warp.cols + 1) * 2, ['f32']);
    } else if (!f.rotation) bad(`deformers.${i}.rotation`, 'rotation deformer needs rotation data');
    else for (const k of ['angle', 'originX', 'originY', 'scale', 'reflectX', 'reflectY'] as const) per(f.rotation[k], n, `deformers.${i}.rotation.${k}`);
    view(f.color?.multiply, `deformers.${i}.color.multiply`, n * 3, ['f32']); view(f.color?.screen, `deformers.${i}.color.screen`, n * 3, ['f32']);
  });
  acyclic(d.deformers.length, (i) => d.deformers[i]?.parent ?? -1, 'deformers');
  let verts = 0;
  d.meshes.forEach((m, i) => {
    const n = grid(m.grid, `meshes.${i}.grid`);
    verts += m.vertexCount;
    if (m.part >= d.parts.length) bad(`meshes.${i}.part`, 'part index out of range');
    if (m.deformer >= d.deformers.length) bad(`meshes.${i}.deformer`, 'deformer index out of range');
    if (m.texture >= d.textures.length) bad(`meshes.${i}.texture`, 'texture index out of range');
    view(m.uvs, `meshes.${i}.uvs`, m.vertexCount * 2, ['f32']);
    view(m.positions, `meshes.${i}.positions`, n * m.vertexCount * 2, ['f32']);
    view(m.indices, `meshes.${i}.indices`, undefined, ['u16', 'u32']);
    if (m.indices.count % 3) bad(`meshes.${i}.indices`, 'index count must be a multiple of 3');
    per(m.opacity, n, `meshes.${i}.opacity`); per(m.drawOrder, n, `meshes.${i}.drawOrder`);
    m.masks.forEach((k, j) => { if (k >= d.meshes.length || k === i) bad(`meshes.${i}.masks.${j}`, 'mask mesh index out of range'); });
    view(m.color?.multiply, `meshes.${i}.color.multiply`, n * 3, ['f32']); view(m.color?.screen, `meshes.${i}.color.screen`, n * 3, ['f32']);
    if (m.skin) { view(m.skin.joints, `meshes.${i}.skin.joints`, m.vertexCount * 4, ['u16']); view(m.skin.weights, `meshes.${i}.skin.weights`, m.vertexCount * 4, ['f32']); }
  });
  if (verts > RIG2D_LIMITS.vertices) bad('meshes', 'too many vertices');
  d.drawGroups?.forEach((g, gi) => g.items.forEach((it, j) => {
    if (it.index >= (it.kind === 'mesh' ? d.meshes.length : d.parts.length)) bad(`drawGroups.${gi}.items.${j}`, 'index out of range');
    if (it.group >= (d.drawGroups?.length ?? 0)) bad(`drawGroups.${gi}.items.${j}.group`, 'group index out of range');
  }));
  d.glue?.forEach((g, i) => {
    const n = grid(g.grid, `glue.${i}.grid`);
    if (g.a >= d.meshes.length || g.b >= d.meshes.length) bad(`glue.${i}`, 'mesh index out of range');
    per(g.intensity, n, `glue.${i}.intensity`);
    view(g.pairs, `glue.${i}.pairs`, undefined, ['u16', 'i32', 'u32']); view(g.weights, `glue.${i}.weights`, g.pairs.count, ['f32']);
  });
  d.blendShapes?.forEach((b, i) => {
    if (b.param >= nP) bad(`blendShapes.${i}.param`, 'parameter index out of range');
    const t = b.target, path = `blendShapes.${i}`;
    if ((b.param2 === undefined) !== (b.keys2 === undefined)) bad(path, 'param2 and keys2 go together');
    if (b.param2 !== undefined && b.param2 >= nP) bad(`${path}.param2`, 'parameter index out of range');
    for (const ks of [b.keys, b.keys2 ?? []]) for (let k = 1; k < ks.length; k++) if (!(ks[k] > ks[k - 1])) bad(path, 'keys must increase');
    const nk = b.keys.length * (b.keys2?.length ?? 1);
    if (t.kind === 'mesh' || t.kind === 'warp') {
      const pts = t.kind === 'mesh' ? d.meshes[t.index]?.vertexCount : (() => { const f = d.deformers[t.index]; return f?.kind === 'warp' && f.warp ? (f.warp.rows + 1) * (f.warp.cols + 1) : undefined; })();
      if (pts === undefined) bad(`${path}.target`, 'target out of range or not a warp');
      else if (!b.offsets) bad(`${path}.offsets`, 'mesh / warp blend shapes need offsets');
      else view(b.offsets, `${path}.offsets`, nk * pts * 2, ['f32']);
    } else {
      const n = t.kind === 'rotation' ? (d.deformers[t.index]?.kind === 'rotation' ? 1 : undefined) : t.kind === 'part' ? (t.index < d.parts.length ? 1 : undefined) : (t.index < (d.glue?.length ?? 0) ? 1 : undefined);
      if (n === undefined) bad(`${path}.target`, 'target out of range');
      for (const [k, v] of Object.entries(b.values ?? {})) if (v && v.length !== nk) bad(`${path}.values.${k}`, 'one value per key');
    }
    b.constraints?.forEach((c, j) => { if (c.param >= nP || c.keys.length !== c.weights.length) bad(`${path}.constraints.${j}`, 'bad constraint'); });
  });
  const pid = (s: string, path: string) => { if (!paramIds.has(s)) bad(path, `unknown parameter "${s}"`); };
  d.roles.eyeBlink.forEach((s, i) => pid(s, `roles.eyeBlink.${i}`)); d.roles.lipSync.forEach((s, i) => pid(s, `roles.lipSync.${i}`));
  for (const [k, v] of Object.entries(d.roles.bind ?? {})) pid(typeof v === 'string' ? v : v.param, `roles.bind.${k}`);
  d.physics?.forEach((p, i) => {
    p.inputs.forEach((x, j) => pid(x.param, `physics.${i}.inputs.${j}`));
    p.outputs.forEach((x, j) => { pid(x.param, `physics.${i}.outputs.${j}`); if (x.particle >= p.particles.length) bad(`physics.${i}.outputs.${j}.particle`, 'particle index out of range'); });
  });
  d.expressions?.forEach((e, i) => { e.params.forEach((x, j) => pid(x.param, `expressions.${i}.params.${j}`)); e.parts?.forEach((x, j) => { if (!partIds.has(x.part)) bad(`expressions.${i}.parts.${j}`, 'unknown part'); }); });
  d.motions?.forEach((m, i) => m.curves.forEach((c, j) => {
    const path = `motions.${i}.curves.${j}`;
    if (c.target === 'param') pid(c.id, path);
    if (c.target === 'part' && !partIds.has(c.id)) bad(path, `unknown part "${c.id}"`);
    if (Array.isArray(c.times) && Array.isArray(c.values) && Array.isArray(c.segments)) {
      if (c.times.length !== c.values.length || c.times.length < 1) bad(path, 'times and values must have the same length (>= 1)');
      if (c.segments.length !== Math.max(0, c.times.length - 1)) bad(path, 'one segment per gap between points');
      for (let k = 1; k < c.times.length; k++) if (c.times[k] < c.times[k - 1]) bad(path, 'times must not decrease');
      const nb = c.segments.filter((s) => s === 1).length;
      if (nb && (!Array.isArray(c.controls) || c.controls.length !== nb * 4)) bad(path, 'four control values per Bézier segment');
    } else for (const k of ['times', 'values', 'segments', 'controls'] as const) { const v = c[k]; if (v && !Array.isArray(v)) view(v, `${path}.${k}`); }
  }));
  d.switches?.forEach((s, i) => s.members.forEach((m, j) => { for (const p of [m.part, ...m.links]) if (!partIds.has(p)) bad(`switches.${i}.members.${j}`, `unknown part "${p}"`); }));
  d.hitAreas?.forEach((h, i) => { if (!meshIds.has(h.mesh)) bad(`hitAreas.${i}.mesh`, 'unknown mesh'); });
  const boneIds = new Set((d.bones ?? []).map((b) => b.id)), defIds = new Set(d.deformers.map((f) => f.id)), attIds = new Set((d.attachments ?? []).map((a) => a.id));
  const valueRef = (s: string, path: string) => { if (s.startsWith('role:')) { if (!(STANDARD_ROLES as readonly string[]).includes(s.slice(5))) bad(path, `unknown role "${s.slice(5)}"`); } else pid(s, path); };
  d.layers?.forEach((l, i) => { l.parts.forEach((p) => { if (!partIds.has(p)) bad(`layers.${i}.parts`, `unknown part "${p}"`); }); l.attachments?.forEach((a) => { if (!attIds.has(a)) bad(`layers.${i}.attachments`, `unknown attachment "${a}"`); }); });
  d.views?.sets.forEach((s, i) => s.parts.forEach((p) => { if (!partIds.has(p)) bad(`views.sets.${i}.parts`, `unknown part "${p}"`); }));
  if (d.views) valueRef(d.views.by, 'views.by');
  if (d.depth?.yaw) pid(d.depth.yaw, 'depth.yaw');
  if (d.depth?.pitch) pid(d.depth.pitch, 'depth.pitch');
  const slot = (sl: z.infer<typeof SlotSchema>, path: string) => {
    const n = [sl.bone, sl.mesh, sl.deformer].filter((x) => x !== undefined).length;
    if (n !== 1) bad(path, 'a slot names exactly one of bone / mesh / deformer');
    if (sl.bone !== undefined && !boneIds.has(sl.bone)) bad(path, `unknown bone "${sl.bone}"`);
    if (sl.deformer !== undefined && !defIds.has(sl.deformer)) bad(path, `unknown deformer "${sl.deformer}"`);
    if (sl.mesh !== undefined) {
      const m = d.meshes.find((x) => x.id === sl.mesh);
      if (!m) bad(path, `unknown mesh "${sl.mesh}"`);
      else if ((sl.vertex ?? 0) >= m.vertexCount || (sl.vertex2 ?? 0) >= m.vertexCount) bad(path, 'vertex out of range');
    }
  };
  const drawAt = (dr: { above?: string } | undefined, path: string) => { if (dr?.above && !meshIds.has(dr.above)) bad(path, `unknown mesh "${dr.above}"`); };
  d.attachments?.forEach((a, i) => { if (a.texture >= d.textures.length) bad(`attachments.${i}.texture`, 'texture index out of range'); slot(a.slot, `attachments.${i}.slot`); drawAt(a.draw, `attachments.${i}.draw`); });
  d.particles?.forEach((a, i) => { if (a.texture >= d.textures.length) bad(`particles.${i}.texture`, 'texture index out of range'); slot(a.slot, `particles.${i}.slot`); drawAt(a.draw, `particles.${i}.draw`);
    if (a.trigger.kind === 'param' && a.trigger.value) valueRef(a.trigger.value, `particles.${i}.trigger.value`); });
  const rawFollow = d.extra?.[FOLLOW_EXTRA_KEY];
  if (rawFollow !== undefined && !Array.isArray(rawFollow)) bad(`extra.${FOLLOW_EXTRA_KEY}`, 'must be a list of follow-throughs');
  else (rawFollow as unknown[] | undefined)?.forEach((y, i) => { const r = DynamicSchema.safeParse(y); if (!r.success || r.data.kind !== 'follow') bad(`extra.${FOLLOW_EXTRA_KEY}.${i}`, r.success ? 'must be a follow' : r.error.issues[0]?.message ?? 'not a follow'); });
  // (the follow-throughs of extra.follow are checked like the ones in dynamics: same meshes / amount rules)
  const dynChecked = [...(d.dynamics ?? []).map((y, i) => ({ y, path: `dynamics.${i}` })),
    ...extraFollows(d).filter((y) => !(d.dynamics ?? []).some((x) => x.id === y.id)).map((y, i) => ({ y, path: `extra.${FOLLOW_EXTRA_KEY}.${i}` }))];
  dynChecked.forEach(({ y, path }) => {
    if (y.amount !== undefined) { if (y.kind === 'pendulum') bad(`${path}.amount`, 'a pendulum has no amount'); else pid(y.amount, `${path}.amount`); }
    if (y.kind === 'follow') { if (!y.meshes?.length) bad(path, 'a follow lists its meshes'); y.meshes?.forEach((m) => { if (!meshIds.has(m)) bad(path, `unknown mesh "${m}"`); }); return; }
    if (y.kind === 'chain') { if (!y.bones?.length) bad(path, 'a chain lists its bones'); y.bones?.forEach((b) => { if (!boneIds.has(b)) bad(path, `unknown bone "${b}"`); }); return; }
    if (y.kind === 'pendulum') {
      if (!y.deformer || !defIds.has(y.deformer)) bad(path, 'a pendulum needs its anchor deformer');
      if (!y.output) bad(path, 'needs an output parameter'); else pid(y.output, `${path}.output`);
      if (y.output2) pid(y.output2, `${path}.output2`);
      if (!(y.length! > 0) || !(y.frequency! > 0) || !(y.gravity! >= 0)) bad(path, 'a pendulum needs length > 0, frequency > 0, gravity ≥ 0');
      return;
    }
    if (!y.output) bad(path, 'needs an output parameter'); else pid(y.output, `${path}.output`);
    if (y.kind !== 'wind') { if (!y.input) bad(path, 'needs an input'); else valueRef(y.input, `${path}.input`); }
  });
  const expIds = new Set((d.expressions ?? []).map((e) => e.id)), motIds = new Set((d.motions ?? []).map((m) => m.id));
  d.states?.layers.forEach((L, li) => {
    const sids = new Set(L.states.map((x) => x.id));
    if (!sids.has(L.initial)) bad(`states.layers.${li}.initial`, `unknown state "${L.initial}"`);
    L.states.forEach((st, si) => {
      const path = `states.layers.${li}.states.${si}`;
      if (st.expression && !expIds.has(st.expression)) bad(path, `unknown expression "${st.expression}"`);
      if (st.motion && !motIds.has(st.motion)) bad(path, `unknown motion "${st.motion}"`);
      if (st.blend) { valueRef(st.blend.by, `${path}.blend.by`); st.blend.points.forEach((pt) => { if (!expIds.has(pt.expression)) bad(path, `unknown expression "${pt.expression}"`); }); }
    });
    L.transitions.forEach((t, ti) => { const path = `states.layers.${li}.transitions.${ti}`; if (t.from !== '*' && !sids.has(t.from)) bad(path, `unknown state "${t.from}"`); if (!sids.has(t.to)) bad(path, `unknown state "${t.to}"`);
      if (t.on.kind === 'param' && t.on.value) valueRef(t.on.value, `${path}.on.value`); });
  });
  d.textures.forEach((t, i) => { if (t.sheet && t.sheet.frames > t.sheet.cols * t.sheet.rows) bad(`textures.${i}.sheet`, 'more frames than cells'); if (t.sheet?.param) pid(t.sheet.param, `textures.${i}.sheet.param`); });
  d.bones?.forEach((b, i) => { const n = grid(b.grid, `bones.${i}.grid`); if (b.parent >= (d.bones?.length ?? 0) || b.parent === i) bad(`bones.${i}.parent`, 'bad parent');
    if (b.deformer !== undefined && b.deformer >= 0 && (b.deformer >= d.deformers.length || b.parent >= 0)) bad(`bones.${i}.deformer`, 'deformer out of range, or set on a non-root bone'); for (const k of ['angle', 'x', 'y', 'scaleX', 'scaleY'] as const) per(b.keyforms[k], n, `bones.${i}.keyforms.${k}`); });
  d.meshes.forEach((m, i) => { if (m.skin && !(d.bones?.length)) bad(`meshes.${i}.skin`, 'skinned mesh but no bones'); });
  d.materialBindings?.forEach((c, i) => {
    if (c.deformer >= d.deformers.length) bad(`materialBindings.${i}.deformer`, 'deformer index out of range');
    c.bindings.forEach((b, j) => {
      const path = `materialBindings.${i}.bindings.${j}`;
      if (b.param >= nP || (b.param2 !== undefined && b.param2 >= nP)) bad(path, 'parameter index out of range');
      if ((b.param2 === undefined) !== (b.keys2 === undefined)) bad(path, 'param2 and keys2 go together');
      for (const ks of [b.keys, b.keys2 ?? []]) for (let k = 1; k < ks.length; k++) if (!(ks[k] > ks[k - 1])) bad(path, 'keys must increase');
      if (b.values.length !== b.keys.length * (b.keys2?.length ?? 1)) bad(path, 'one value per key (pair)');
    });
  });
  if (d.bones) acyclic(d.bones.length, (i) => d.bones![i]?.parent ?? -1, 'bones');
  return issues.length ? { ok: false, issues } : { ok: true, doc: d };
}
