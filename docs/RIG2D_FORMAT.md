# VTube Pro 2D rig format (`.vtp2`), version 1

VTube Pro's own format for rigged 2D puppets: drawn art on deforming meshes, driven by parameters that follow the
performer's face. VTube Pro's 2D runtime draws it. Converted Live2D and Inochi2D models are stored in this format
too: Live2D models via `shared/rig2d/live2d/`, Inochi2D puppets via `shared/rig2d/inochi/`. It is an open,
documented format: a ZIP container with a JSON manifest, binary arrays and textures, validated
by a published JSON Schema.

- **JSON Schema file:** `docs/rig2d.schema.json`. Generated from format.ts with `npx tsx tools/rig2d_unit.ts --write-schema`; the unit test fails when the file is out of date.
- **Single source of truth:** `shared/rig2d/format.ts`. The constants (extension, magic, MIME type, version), the
  TypeScript types and the zod schema live there, and the JSON Schema comes from it (`rig2dJsonSchema()`). To rename
  the format, change the `RIG2D` block only.
- **Container code:** `shared/rig2d/container.ts` (read / write / validate, no dependencies).
- **Evaluator:** `shared/rig2d/evaluate.ts` (parameters to vertices, opacity, colours and render order).
- **Runtime:** `src/avatar/flat/rig2d/` (WebGL renderer + the 2D-avatar `FlatSource`).
- **Tests:** `tools/rig2d_unit.ts`. A self-made sample puppet comes from `tools/rig2d_sample.ts`.

| | |
|---|---|
| Extension | `.vtp2` |
| MIME type (`mimetype` entry) | `application/vnd.vtubepro.rig2d+zip` |
| Manifest magic | `"magic": "VTP2-RIG"` |
| Version | `"version": 1` (readers refuse newer versions with a clear message) |

## 1. Container

A plain ZIP archive, which any archive tool can open.

| Entry | Content |
|---|---|
| `mimetype` | The MIME type above. It is the **first** entry and is **stored** (not deflated), so the file can be sniffed from its first bytes, as with EPUB / ODF. |
| `rig.json` | The manifest (sections 2–8). UTF-8 JSON, at most 32 MB. |
| `buffers/<n>.bin` | Little-endian binary arrays, addressed by **buffer views**. |
| `textures/<n>.png` / `.webp` | The art, as the artist made it. Straight (not premultiplied) alpha, sRGB. Up to 16384 px a side (8192 before beta.12). Optional normal / emission / rim maps share the UV layout. |
| `thumb.png` | Optional preview. |

Writers store every entry. Readers also accept deflated entries, so a file re-saved by another zip tool still opens.
Readers must bounds-check everything and refuse a file whose sizes exceed `RIG2D_LIMITS` (format.ts). A
malformed file must produce a clean error, never a crash or a hang (`tools/rig2d_unit.ts` fuzzes this).

**Buffer view:** `{ buffer, offset, count, type }`.
- `count` is in **elements**.
- `type` is one of `f32 i32 u32 u16 i16 u8`.
- `offset` is in bytes and must be aligned to the element size.
- A view must lie inside its buffer.

## 2. Coordinates and units

- **Canvas:** `canvas.width × canvas.height` pixels. **x points right, y points DOWN.** (0, 0) is the canvas's
  top-left corner.
- **Model units:** geometry at the top of the deformer tree uses model units, mapped to pixels as
  `px = x · unit + originX` and `py = y · unit + originY`.
  - Native rigs: `unit = 1`, origin `(0, 0)`, so model units are plain pixels.
  - Converted Live2D models keep their own units (`unit` = Live2D's pixels-per-unit, origin = its canvas origin), so
    no geometry has to be rescaled.
- **UVs:** `u` runs left to right and `v` runs **from the top** of the texture.
- **Angles:** degrees. Positive = clockwise on screen (because y points down).

## 3. Parameters

`params[]`: `{ id, name, min, max, default, repeat?, kind?, group?, decimals? }`.
- `id` is the stable name that bindings, motions and expressions use. The Live2D standard ids (`ParamAngleX` …) are
  recommended for the usual controls.
- `kind: "blend"` marks a blend-shape parameter, which drives `blendShapes` (§5.6) instead of keyform grids.
- Every frame, values are clamped to `[min, max]`.

## 4. Keyform grids

A **grid** spans one or more parameters, each with an increasing list of keys:
`grids[] = { axes: [{ param, keys[] }] }`.
- Every object that uses grid *g* has **one keyform per grid point**.
- **Axis 0 varies fastest:** keyform index = `i0 + n0·(i1 + n1·(i2 + …))`.
- An empty `axes` list means exactly one, static keyform.

**Evaluation at the current parameter values:**
1. For each axis, find the key segment `[k_lo, k_hi]` that contains the value, and the fraction `t` within it.
2. Blend the 2^axes surrounding keyforms **multilinearly**.
3. **Out of range switches the object off:** if a value lies outside an axis's key range (± 0.001), or a
   single-key axis is not at its key, the object (part / deformer / mesh) is disabled. Riggers use this to swap
   variants, such as a raised arm against a lowered arm.

Per-keyform data is either an inline array with exactly one value per keyform (`opacity`, `drawOrder`, rotation
values …) or a buffer view of `keyforms × stride` floats (positions, lattice points, colours).

## 5. Structure

### 5.1 Parts

`parts[] = { id, name, parent, grid, drawOrder[], opacity?, visible, enabled, depth? }`
- Parts form a tree of folders that group meshes and deformers.
- A disabled part disables everything under it.
- Part opacity multiplies down the tree.
- `drawOrder` places a part's group inside its parent's group (§5.5).
- `depth` is 2.5D depth (§8.1).

### 5.2 Deformers

`deformers[] = { id, name, kind, parent, part, grid, enabled, visible, opacity[], warp? | rotation?, color? }`

Deformers form a tree: `parent` is a deformer index, or −1 for model space. Each object's keyform geometry is
expressed in its parent deformer's space and mapped upward deformer by deformer, so each parent is processed
before its children.

**Warp:** `warp = { rows, cols, quad, points }`.
- `points` is a `(rows+1)·(cols+1)` lattice per keyform (`f32 × 2`, row-major from the top-left), in the parent's
  space.
- A child's coordinates are in the lattice's **normalised space**: `[0, 1]²` spans the lattice.
- Inside each cell, `quad: false` interpolates over two triangles split along the bottom-left → top-right diagonal;
  `quad: true` interpolates bilinearly.
- **Outside** `[0, 1]²` the lattice extrapolates along the axes defined by its four corners. Between −2 and 3 it
  blends the edge cells into that frame; beyond that it is purely linear. `shared/rig2d/evaluate.ts warpPoints` is
  the normative implementation.

**Rotation:** `rotation = { baseAngle, angle[], originX[], originY[], scale[], reflectX[], reflectY[] }`, one value
of each per keyform.
- A child point `p` maps to `origin + scale · R(baseAngle + angle) · mirror(p)`.
- `scale` multiplies down a chain of rotations.
- When the parent is itself a deformer, two things happen:
  - the origin is mapped through the parent;
  - the angle gains the parent's local rotation, measured by mapping a short "up" step at the origin through the
    parent.

**Colours** (`color.multiply` / `color.screen`, `f32 × 3` per keyform): multiply colours multiply down the tree;
screen colours combine as `a + b − a·b`.

### 5.3 Meshes (art)

`meshes[] = { id, name, part, deformer, texture, grid, vertexCount, uvs, indices, positions, opacity[], drawOrder[], blend, doubleSided, masks[], maskInvert?, visible, enabled, color?, depth?, skin?, outline? }`

- **Geometry:**
  - `positions`: `keyforms × vertexCount × 2` floats, in the parent deformer's space.
  - `uvs`: `vertexCount × 2` floats.
  - `indices`: triangles, `u16` or `u32`.
- **Blend modes:** `normal` (premultiplied over), `add`, `multiply`, `screen`, `overlay`, `darken`, `lighten`,
  `clipToLower` and `sliceFromLower`. The last two draw only where something is already drawn / not drawn.
- **Clipping:**
  - The mesh shows only where at least one mesh in `masks` is drawn, meaning its texture alpha > 0.5. Mask meshes
    are rendered at their current pose and opacity is ignored.
  - `maskInvert: true` shows the mesh only where none of them is drawn.
- **Culling:** `doubleSided: false` culls back faces. Triangles are counter-clockwise on screen, with y pointing down.
- **Opacity:** the mesh's final opacity = keyform opacity × each parent deformer's opacity × its part's opacity
  (cumulative).
- **Colour:** the final colour per pixel is `rgb = tex.rgb · multiply`, then `rgb = rgb + screen − rgb · screen`,
  then premultiplied by `alpha · opacity`.

### 5.4 Glue

`glue[] = { id, a, b, grid, intensity[], pairs, weights }`
- Welds pairs of vertices of mesh `a` and mesh `b`, for example the seam between a neck and a head.
- `intensity` is per keyform.
- `pairs` holds vertex index pairs `(ia, ib)`. `weights` holds `(wa, wb)` per pair.
- Each weld pulls the two vertices toward each other: `a += (b − a) · wa · intensity` and
  `b −= (b − a) · wb · intensity`.

### 5.5 Render order

`drawGroups[] = { min, max, total, items[{ kind: 'mesh'|'part', index, group }] }`
1. Group 0 is the root. Each group sorts its items by evaluated draw order, clamped to `[min, max]`. Ties keep their
   item order.
2. A **mesh** item takes the next slot.
3. A **part** item with its own group (`group ≥ 0`) reserves `total` slots, and that group fills them.
4. Disabled objects sort at `min`.

The result is the back-to-front list of meshes. Without `drawGroups`, meshes sort by draw order alone.

### 5.6 Blend shapes

`blendShapes[] = { target{kind, index}, param, keys[], param2?, keys2?, offsets? | values?, constraints? }`
- These are additive changes driven by one parameter (or two: `param2` / `keys2` make a 2D grid, blended
  bilinearly, key index = `i + keys.length · j`), applied on top of the keyform grids. Inochi2D's deform and
  transform bindings convert to these.
- **Mesh / warp targets** add point offsets: `keys × points × 2` floats.
- **Rotation, part and glue targets** add per-key values: angle / originX / originY / scale, opacity / drawOrder,
  or intensity.
- `constraints` limit the weight: the minimum over the listed parameters' piecewise-linear weight curves.

## 6. Behaviour

### 6.1 Roles

`roles = { eyeBlink[], lipSync[], bind? }`
- `eyeBlink` lists the parameters closed by blinks: the performer's own blinks, or automatic blinks while the
  camera does not see them.
- `lipSync` lists the parameters opened by the voice.
- `bind` maps tracked inputs to parameters. It may list any subset of the roles. An entry is a parameter id, or
  `{ param, gain?, invert?, range? }`, where `range: [inLo, inHi, outLo, outHi]` maps the role's value onto the
  parameter. The roles are `headYaw headPitch headRoll bodyYaw bodyPitch bodyRoll
  eyeOpenL eyeOpenR eyeSmileL eyeSmileR gazeX gazeY browLY browRY browLForm browRForm mouthOpen mouthForm cheek
  breath voice jawOpen mouthFunnel mouthPuckerWiden mouthPressLipOpen mouthShrug mouthX cheekPuff tongueOut`
  (the last eight are the extended mouth set: offered in the mapping panel, never auto-bound; with `mouthFunnel` or
  `mouthPuckerWiden` bound, `mouthForm` is the corners only, otherwise rounding pulls it negative as before).
  The role list is closed (an older build's strict schema refuses an unknown role), so the five mouth shapes of speech
  (`mouthA` / `mouthI` / `mouthU` / `mouthE` / `mouthO`, parameters `ParamMouthA` ... `ParamMouthO`, made by the auto-rig and
  fed from the voice visemes by `shared/lipBus.ts`) are bound through `extra.vowelBind` (`{ mouthA: "ParamMouthA", ... }`):
  `extra` is a free-form map every build accepts and ignores, so an older build still loads the file and just does not move
  the vowel parameters (`tools/lipbus_unit.ts` validates a new rig with frozen copies of the older schemas).
- Without `bind`, the runtime maps the model automatically (`shared/rig2d/drive.ts` `live2dAutoMap`): Live2D's
  standard ids (and the Cubism 2 aliases), the ids riggers commonly use instead, the parameters' display names
  (English, Japanese, Chinese, Korean), the EyeBlink / LipSync roles, and, for a converted model that came with its
  VTube Studio settings, that mapping (stored by the converter as `extra.vtsBindings`, an array of bindings). Ranges
  are fitted when a parameter uses another scale. The parameter-mapping panel overrides any of it.

### 6.2 Physics (pendulum strands)

`physics[] = { id, inputs[], outputs[], particles[], normalize }`, plus `physicsWorld = { gravity, wind, fps }`.
- **Inputs** move and turn the strand's anchor. Each input's parameter value is normalised into the `normalize`
  range: each side of the default is scaled separately, then weighted by `weight / 100` and summed into x, y or
  angle.
- **Particles** hang in a chain. Each follows its parent at distance `radius`:
  - `mobility` is the share of velocity it keeps;
  - `delay` is how far it lags;
  - `acceleration` is how strongly gravity pulls it.
- **Outputs** read a particle's offset from its parent (x / y), or the angle between its segment and the one above
  it. They then:
  1. multiply the reading by `scale`;
  2. flip its sign if `reflect` is set;
  3. blend the result into the parameter by `weight / 100`;
  4. clamp it to the parameter's range.
- Strands step at a fixed `fps`, with at most 6 steps per frame.

### 6.3 Dynamics

`dynamics[]`: springs, jiggle, wind gusts and bone chains beyond pendulum strands: see §8.4.

### 6.4 Expressions

`expressions[] = { id, name, fadeIn, fadeOut, params[{ param, value, blend }], parts?, key? }`
- `add`: `v + value · w`
- `multiply`: `v · (1 + (value − 1) · w)`
- `overwrite`: `v + (value − v) · w`

`w` eases in and out with each expression's own fades. Expressions apply after tracking, motions and the model
sliders (§8.13).

**Several at once (they stack, like VTube Studio):** an expression can be on because it is held (the studio's "Show",
the bus `flat {expression}`), toggled (its key; any number of toggles at once, `flat {toggle}`) or picked by the state
machine (§8.5). Each fades by its own times. On a shared parameter the one switched on **last** wins, whoever switched
it on: a state that starts after a toggle wins; a toggle pressed while a state shows wins; switching the winner off
gives the other one back (VTube Studio's last-activated rule). While any toggled expression is in the mix, the
parameters combine as VTube Studio does:

- **Overwrite** expressions lerp the value toward theirs in the order they were switched on: the last one switched on
  wins; switching it off gives the earlier one back.
- Then every **Multiply** factor `1 + (value − 1) · w` (they compound: 0.5 × 0.5 = 0.25).
- Then every **Add** `value · w`.

`v' = ov · Π mul + Σ add`, clamped to the parameter's range. With one expression on, the rows above give the same
result. A hat, glasses and a jacket toggle stay on together with a face expression on top. With no toggled expression
(held / state-machine expressions only) the original rule is unchanged: each expression in activation order applies
its blend in turn, clamped after each step.

### 6.5 Motions

`motions[] = { id, name, group, duration, loop, fadeIn, fadeOut, bezierByFraction?, curves[], events?, key? }`

Curves: `{ target: 'param'|'part'|'blink'|'lipSync'|'opacity', id, fadeIn?, fadeOut?, times, values, segments, controls? }`
- There is one segment between each pair of neighbouring points:
  - `0`: linear.
  - `1`: cubic Bézier. Its control points are the next four numbers in `controls`: `t1, v1, t2, v2`. The curve's
    `x(s) = t` is solved for `s`, unless `bezierByFraction`.
  - `2`: hold the start value.
  - `3`: jump to the end value at the segment start.
- Each array is either inline or a buffer view.
- Motions blend over the current values with an eased fade: `v + (m − v) · w`.
- `opacity` curves fade the whole puppet.
- Groups: `Idle` loops under the tracking. Other groups play on hotkeys or state-machine events.

### 6.6 Part switches (poses)

`switches[] = { fade, members[{ part, links[] }] }`. In each switch, the first member whose same-named parameter is on
(> 0.001) fades in, the others fade out, and linked parts follow their member.

### 6.7 Hit areas

`hitAreas[] = { id, name, mesh }` (clickable regions; e.g. head pats).

## 7. Resources

`textures[] = { file, width, height, filter, normal?, emission?, rim?, sheet? }`
- `sheet` = an animated texture: a `cols × rows` sprite sheet with `frames` frames, played at `fps` or picked by a
  parameter.
- Max side 16384 (`RIG2D_LIMITS.textureSide`, from shared/rig2d/limits.ts; 8192 before beta.12: a reader older than
  beta.12 refuses a bigger texture). The file always keeps the **original** pictures; what the GPU gets is made from
  them at load time (§11).

`meta = { name, authors?, license?, licenseUrl?, rights?, notes?, source? }`
- `rights` holds the author's stated terms: users, commercial, redistribution, modification, attribution.
- `source` records a converted model's origin. **The original files are never kept.**

## 8. Beyond Live2D

These are part of version 1 of the format. Every one is **opt-in per model**: a rig without the field renders exactly
as before. The doc comments in `shared/rig2d/format.ts` are normative; this section summarises them. §9 says what the
runtime draws.

### 8.1 Depth / 2.5D parallax

`depth = { yaw?, pitch?, strength }`, plus `depth` on parts and meshes (model px, + = toward the viewer, summed down
the part tree). With `yaw` / `pitch` parameters in degrees, each mesh shifts by `depth · sin(angle) · strength`, so a
head turn moves the nose and fringe further than the back hair.

### 8.2 Bones and skinning

`bones[] = { id, name, parent, deformer?, x, y, angle, length, grid, keyforms{ angle, x, y, scaleX, scaleY } }`, plus
`mesh.skin = { joints: u16 × 4 per vertex, weights: f32 × 4 per vertex }` (joints index `bones`).

- **Local transform:** `translate(x + dx, y + dy) · rotate(angle + da) · scale(sx, sy)` relative to the parent bone.
  - `dx` / `dy` / `da` are the keyform OFFSETS (`keyforms.x / y / angle`, one per keyform of `grid`).
  - `sx` / `sy` are the keyform SCALES (1 = rest).
  - Angles are degrees, + = clockwise on screen (as rotation deformers). Lengths and offsets are model units.
- **Root bones** (`parent` −1) sit in model space, or **follow a deformer** when `deformer` (a deformer index) is set.
  Their `x` / `y` (and their keyform x / y offsets) are then in the deformer's coordinates (normalised [0, 1]² for a
  warp). Each frame the origin is
  mapped through the deformer chain and the angle turned by the chain's local turn there (an "up" probe, exactly as
  a rotation deformer under a parent). Children follow.
- **Skinning** runs after the deformers and glue: `p' = Σ wᵢ · (Bᵢ · Rᵢ⁻¹) · p`.
  - `Bᵢ` = bone *i*'s model-space transform now.
  - `Rᵢ` = the same chain with every keyform offset 0 / scale 1 and no chain physics, evaluated **now**. A bone that
    follows a deformer therefore moves its pivot with the deformer, and only the bone's own motion bends the mesh.
  - Without `deformer`, `Rᵢ` is the constant rest pose.
  - A vertex whose weights sum to 0 is left as the deformers placed it.
- **Bone physics:** a `dynamics` entry of kind `chain` (§8.4).

### 8.3 Lighting maps

`textures[].normal` / `emission` / `rim` (same size and UVs as `file`), plus
`lighting = { tint?, strength?, rim?{ width, strength } }`.

- **normal**: tangent-space normal map, RGB = (x, y, z) · 0.5 + 0.5, +x right, +y **up** in the picture (OpenGL
  style). It gives relief shading from the room's key and fill lights. The shading is normalised so a surface
  facing the viewer keeps its painted colour; `strength` 0..1 (default 0.8).
- **rim**: R channel = where an edge light in the key light's colour may appear. With a normal map, the rim appears
  where normals face away from the viewer. `width` 0..1, `strength` 0..2.
- **emission**: RGB the art gives off itself, added after lighting, never darkened.
- **Light sources:** rooms provide the key / fill directions and colours; card / TV / overlay modes also take the
  light-show colour. With no room, a soft white key comes from the upper left.

### 8.4 Dynamics (procedural secondary motion)

`dynamics[] = { id, kind, input?, output?, bones?, stiffness?, damping?, gain?, strength?, period?, gravity?, limit?, boneLimit?, amount?, meshes?, anchor?, reach?, spread?, stretch?, squash? }`

- **Inputs / outputs:** parameter ids; an input may also be a tracked role, `role:<name>` (`role:headYaw`,
  `role:voice` …).
- **Normalisation:** values are normalised to −1..1 over each parameter's range around its default.
- **Determinism:** fixed 120 Hz steps, so the same inputs give the same output.
- **Amount** (optional, any kind but `pendulum`): a parameter id whose current value (clamped 0..4) scales the motion:
  0 = still, 1 = as authored, 2 = twice. `spring` / `jiggle` / `wind`: their output, first held to −1..1, times the
  amount; `chain`: what drives it (root motion, gravity, wind) times the amount, so `limit` / `boneLimit` still hold.
  The 2D avatar maker gives every swinging part one such parameter (`ParamSwingAmount_<part>`, 0..2, default 1,
  "<part> swing") shared by its chain and its head-turn jiggle, so one control calms or livens all of the part's
  motion, and the studio shows it as a model slider (§8.13). Absent = 1: files without it behave exactly as before.
- **No kick on load:** every solver starts at rest on the first evaluated pose (chains seed their root's position and
  velocity before measuring acceleration; a jump of more than a quarter canvas in one frame reseeds; the root's
  acceleration is low-passed and capped; frame times are clamped to 1/240..1/20 s). Wind fades in over 1 s; pendulums
  and physics strands start from the first frame's pose.

| kind | output | defaults |
|---|---|---|
| `spring` | adds `gain · y` to the output (= `default + gain · y` when nothing else drives it); y follows x like a mass on a spring (a lagging, overshooting copy) | stiffness 60, damping 8, gain 1 |
| `jiggle` | adds `gain · (y − x)`: only the wobble around the input | stiffness 180, damping 6, gain 1 |
| `wind` | adds `gain · strength · wind · gust(t)`; gusts = sum of sines over `period` s, phased by the id; wind = the room's (0..2; 0.3 with no room) | strength 1, period 3 |
| `chain` | the listed `bones` (root first) swing as a damped chain driven by the root's motion, `gravity` (model units / s², +y down) and the wind; adds to the bones' angles; each bone capped at `boneLimit`°, the whole chain's bend at `limit`° | stiffness 40, damping 6, gravity 0, boneLimit 50, limit 90 |
| `follow` | follow-through (below): the listed `meshes` lag, settle fast, stretch along a whip and thin across it; no parameters are written, the final vertex positions move | stiffness 90, damping 2 · 0.85 · √stiffness (≈ 16: near-critical), gravity 0, gain 1, anchor `top`, reach 0.25, spread 0.6, stretch 0.2, squash 0.5 |
| `pendulum` | Inochi2D-style SimplePhysics: a bob hanging `length` px from the evaluated frame of deformer `deformer` (`model` `pendulum` = rigid rod, `spring` = radial spring at `frequency` Hz), gravity `gravity` px/s², critical-damping ratios `angleDamping` / `lengthDamping`, RK4 in ≤ 10 ms steps; writes ABSOLUTE values (clamped, not around the default) to `output` (+ `output2`) by `map`: `angleLength` = (atan2(−x, y)/π, L/length), `lengthAngle` swapped, `xy` = (x·L, 1 − y·L), `yx` swapped, times `outputScale`; `localOnly` keeps the bob in the anchor's parent frame | — |

**Follow-through** (`kind: "follow"`; needs `meshes`: mesh ids, max 256; `output` / `input` are not used). Classic animation follow-through
on a mesh's vertices: fast settle, squash and stretch, overlap travelling outward. Fields: `anchor` (`top` / `bottom` / `left` /
`right` / `center`: the side of each mesh that is held still), `reach` (the fraction of the mesh's rest extent along that axis that
is fully held; the hold then falls off smoothly, a smoothstep, over the same distance again; `center` = distance from the rest
box's centre over half its diagonal), `spread` (0..1: how strongly a vertex follows its mesh neighbours' lag, which carries the
overlap outward from the held side), `squash` (0..1: the free region stretches along the direction it is whipped and thins across
it, about the held side's centre, keeping its area: σ = 1 + squash · min(½, |D| / size) along, 1/σ across, where D is the free
vertices' mean offset; 0 = off), `stretch` (cap on any vertex's offset, a fraction of the mesh's rest diagonal), plus `stiffness`,
`damping` (absent = 2 · 0.85 · √stiffness, near-critical: one soft overshoot, no jelly), `gravity` (model px / s², +y down), `gain`
and `amount` as above. It works on any rig: after the rig is evaluated (`RigEval.update()`, then `Animator.afterEvaluate()`),
every listed mesh's final vertex positions (after the deformers and skinning) are the TARGETS; each vertex is a damped spring
behind its target, coupled to its edge neighbours (the unique edges of the mesh's triangles), pinned toward the target by the
anchor weight, capped by `stretch`, and written back as target + offset (+ the squash) · `gain` · amount. The rest pose is the first
evaluated pose (no kick on load); a mesh whose targets move more than a quarter canvas in one frame (mean over its vertices) starts
again at rest. Fixed 120 Hz steps like the other kinds, the target moving linearly across a frame's steps, so any frame rate gives
the same motion; a mesh belongs to the first follow that lists it. Allocation-free per frame; about 0.15 ms a frame for 5,000
vertices (`tools/rig2d_follow_unit.ts`). The avatar card's framing pads a follow mesh's box by `stretch` × its diagonal × `gain` × the
`amount` parameter's default value.

**Where a follow is stored (compatibility).** A reader built before follow-through (release/b141) validates `dynamics[].kind` against a
closed list and refuses the WHOLE file at an unknown kind, so an avatar with a follow in `dynamics` could not be opened or saved by an
older build or OBS page. Writers (the maker's `.vtp2` export, every re-save) therefore put follow entries, whole and unchanged, in
**`extra.follow`** (a list of `dynamics` entries, all of kind `follow`), a field every older build accepts and ignores, like
`extra.vowelBind` (§6.1). Readers treat `dynamics` plus `extra.follow` as one list (`rig2dDynamics()` in `shared/rig2d/format.ts`; an id in
both counts once, `dynamics` wins) and validate the entries in `extra.follow` with the same rules; a bad entry makes the file invalid. Files
written before this, with `kind: "follow"` inside `dynamics`, still load; saving them again moves the entries to `extra.follow`
(`rig2dForStorage()`). An older build simply shows the avatar without the follow-through. `tools/lipbus_unit.ts` proves a picture-to-life rig
validates against the frozen b141 schema (`tools/frozen/rig2d_format_b141.ts`) and still animates on this build.

### 8.5 Expression state machine

`states.layers[] = { id, name?, initial, states[{ id, expression?, motion?, blend?{ by, points[{ at, expression }] } }], transitions[{ from, to, fade?, on{ kind, value?, above?, below?, after? } }] }`

A state shows an expression, plays a motion once on entry, and/or blends expressions by a value (a 1D blend tree;
`by` = a parameter id or `role:<name>`). Transitions go from a state (`from: '*'` = any) when their trigger fires:

| kind | fires when |
|---|---|
| `voice` | the voice level ≥ `above` (0.15) for `after` s |
| `silence` | the voice < 0.15 for `after` s |
| `emotion` | the detected emotion = `value` (happy / sad / angry / surprised / relaxed), level ≥ `above` (0.5) |
| `chat` | a chat message contains `value` (case-insensitive; empty = any message) |
| `event` | a stream event named `value` arrives (follow / sub / raid / cheer / donation / redeem …) |
| `hotkey` | the studio's held expression / state cue = `value`, or `value` is one of the toggled expressions |
| `param` | parameter (or role) `value` is above / below a bound |
| `timer` | `after` s in the state |

`fade` = the expression cross-fade time. Event sources are wired on the page through `src/avatar/flat/rig2d/world.ts`
(§9).

### 8.6 Attachments

`attachments[] = { id, name, slot, texture, rect, pivot, size, angle?, on, draw?, blend?, rotate? }`

- **Picture:** `rect` = `[u, v, w, h]` in the UV space of `textures[texture]` (an atlas page; v from the **top**).
  `pivot` (0..1 inside the rect) sits on the slot; `size` in model units.
- **Turn:** `angle` degrees are added to the slot's turn; `rotate: false` keeps the picture upright.
- **Slots** (exactly one):
  - `{ bone, x?, y? }`: in the bone's frame;
  - `{ mesh, vertex, vertex2? }`: follows the vertex; vertex → vertex2 is the slot's +x;
  - `{ deformer, x?, y? }`: in that deformer's coordinates.
- **Draw position:** `draw = { above: <mesh id> }` = right after that mesh; else `{ at: 'front' | 'back' }` (default
  front).
- **Shown** when `on`, or when a costume layer that lists it is on.

### 8.7 Particles

`particles[] = { id, slot, texture, rect, rate, life, speed[min,max], angle?, spread, gravity[x,y], size[start,end], spin?, fade?, max?, blend?, draw?, trigger }`

- **Emission:** at a slot (as §8.6), `rate` per second, each particle living `life` s.
- **Motion:** start direction `angle` (0 = up, + clockwise) ± `spread`; `gravity` in model units / s² (+y down).
- **Fade:** `fade` = the share of the life spent fading out.
- **Triggers:** `always`, `voice` (≥ `above`), `param` (`value` ≥ `above`), `expression` (`value` shown). `emotion`,
  `chat`, `event` and `hotkey` emit for `burst` s (default 1).
- **Budget:** `max` per emitter; the graphics tier caps the whole puppet (Low 0, Medium 128, High 512).
- **Determinism:** seeded, so the same frames give the same particles.

### 8.8 Costume layers

`layers[] = { id, name, parts[], attachments?[], group?, on }`: sets of parts and attachments switched at runtime,
one per `group` (outfits). They show as named outfit switches in the studio's 2D panel (live, no reload; a key per
outfit), the Stream Deck's "2D model slider / outfit" switches them by name, and the avatar's costume list picks one
when the costume's name or id matches a layer.

### 8.9 Multi-angle views

`views = { by, sets[{ id, at, parts[] }], blendBand?, hysteresis? }`. `by` = a parameter or `role:headYaw`. One set
shows, fully opaque, until the value is past the midpoint to its neighbour (front / three-quarter / side). Parts in no
set are unaffected.

- **Hand-over:** in a band of ± `blendBand` (default 2, in `by` units) around the midpoint. In the band's first half
  the incoming set comes to full opacity while the outgoing one stays opaque; in the second half the outgoing one goes.
  Two half-transparent heads never show through each other, and nothing behind them shows through.
- **Hysteresis:** the band is shifted `hysteresis` (default 2) past the midpoint in the direction of travel, so the
  hand-over starts at the midpoint and a jittery value near it stays on the current set. Both are capped at a quarter
  of the gap between sets.
- **Authoring tip:** let each set's own turn keyforms run a few degrees past the midpoint (to the band's far edge), so
  the outgoing set keeps turning until the incoming one covers it.

### 8.10 Outlines and animated textures

**Outlines:** `mesh.outline = { width, color, opacity?, lightResponsive? }`.

- `width` is in canvas px. The ink is drawn around the mesh's drawn silhouette in screen space, also past the mesh's
  own edges. The art needs no transparent margin, and it may touch its atlas cell's edge.
- The silhouette reads the mesh's texture only inside the mesh's own UV box (inset half a texel). A neighbouring atlas
  cell's art never turns into ink, and the ink never darkens semi-transparent art (a blush keeps its colour).
- `color` is linear RGB 0..1.
- `lightResponsive`: the ink takes the key light's colour and lightens on the lit side.

**Atlas neighbours:** for native rigs (`meta.source.kind` = `native`), every colour, lighting-map and mask read is
clamped to the mesh's own UV box (inset half a texel). A mesh whose art touches its cell edge draws no line of the
next cell's art. Converted Live2D and Inochi2D rigs sample exactly as their source renderer does (unclamped), so they
stay pixel-identical. Packers should still leave ≥ 4 px edge-extruded gutters: at small sizes the mip levels blend
neighbouring cells.

**Sprite sheets:** `textures[].sheet = { cols, rows, frames, fps?, param?, loop? }`.

- Meshes are UV-mapped on the **first** cell; the runtime shifts the UVs to the current frame.
- Frame f sits at column f % cols, row ⌊f / cols⌋ from the top-left.
- The current frame comes from time × `fps`, or from `param` (its range spread over the frames).

### 8.11 Material bindings

`materialBindings[] = { deformer (index), opacity, multiply[rgb], screen[rgb], bindings[{ channel, param, keys[], param2?, keys2?, values[] }] }`
for what a multilinear keyform grid cannot express: several multiplicative bindings on one parameter axis, and
clamping after composition (Inochi2D opacity / tint / screen-tint bindings). Each frame the carrier deformer's own
keyform opacity / multiply / screen are replaced by: the base values, × every `opacity` / `tint.*` binding, + every
`screenTint.*` binding, each clamped to [0, 1]. They then propagate down the deformer tree as usual. A binding samples
`values` (axis 0 fastest, `keys.length × keys2.length` values) bilinearly with clamped ends. Ordinary colour / opacity
/ draw-order changes stay plain keyforms.

### 8.12 Open schema

`rig2dJsonSchema()` (draft 2020-12; committed as `docs/rig2d.schema.json`) plus the `validateRig2D` cross-reference
checks (indices, per-keyform array lengths, buffer bounds, parent cycles, unknown ids, slots, triggers).

### 8.13 Model sliders (the performer's own parameters)

Not stored in the rig: how the studio lets the performer set and hold any parameter that tracking doesn't move
(chest / body shape, hair length, outfit dissolves, blush strength …). `shared/rig2d/userParams.ts`,
studio side `src/ui/rig2dSliders.ts`.

- **Which parameters:** all except those bound to tracking (automatic or the performer's own mapping), the eye-blink /
  lip-sync roles, physics and dynamics outputs, parameters an idle motion animates, the Cubism standard face / head /
  body ids, the ones a VTube Studio import says it tracks (`extra.vtsTracked`, from `ParameterSettings`), fixed
  ones, and ones that move nothing.
- **Names and order:** the model's display name (Live2D `cdi3.json`), else the id made readable. Chest, body, outfit,
  hair first (English, Japanese and Chinese words: 胸 / おっぱい / 衣装 / 髪 / 头发 …), then face extras, the rest,
  arms and hands last.
- **Live:** the studio's flat cue carries `p: { id: [target, fade s] }` (plus `"layer:<id>": [1 | 0, 0]` for outfit
  layers) with every frame, so OBS and party guests show the same. Each page eases to the target. A parameter that
  feeds physics never changes faster than 0.5 s, so strands swing instead of snapping. A slider back at its default
  is let go. Order in the Animator: after motions, before expressions, so expressions still apply on top.
- **Saved:** the slider positions in `profile.flat.opts.params` (`[[id, value], …]`), outfit switches in `layers`,
  triggers in `paramTriggers`. The model starts at the saved positions with no transition.
- **Triggers:** a key (toggle to a value and back, or step through values), a chat word, a stream event (follow,
  sub, raid, cheer, donation, a channel-point redeem, `redeem:<words>`), a transition time and an optional "back after
  N s". The Stream Deck action "2D model slider / outfit" = bus `flat { param, op: toggle | step | set | reset | on | off,
  value? }`. Keys, the deck and chat change the look for the session; the panel's slider positions are what is saved.
- **Keys the studio keeps** (`shared/studioKeys.ts`): H, C, F, Shift + 1–5 on the number row and the keypad
  (lighting, BRB), Shift + T / R / G / I / P / S / Y (show modes, Slap, the tabletop panel), F1, Esc, Ctrl + K,
  Ctrl / Alt + numbers, Ctrl + Shift + number-row digits (interview cuts), and the browser's own (F3, F5, F6, F7, F10, F11, F12,
  Ctrl + R / F / H / S / P / L / W / T / N …, Alt + arrows). F2, F4, F8, F9 and the other Shift + letters stay free.
  A model never takes them: the key handler leaves them to the studio, a model file's expression on one gets a free
  number key instead (1–9, then 0; never one a model slider / outfit key uses; none left = no key), a VTube Studio
  import brings that expression in without it (one line says which key it got), and the key forms refuse them with
  one sentence. Every expression's key is a button in the 2D panel's Expressions list: click it and press a key
  (Delete = no key); saved per avatar in `profile.flat.opts.exprKeys`.
- **Wardrobe:** wearing a costume whose id or name is a costume layer switches that layer on in the live state too
  (a fresh cue), so a session outfit in the old cue can't switch it back off. Changing to another costume or none
  switches it off again and puts its group back as it was (no costume = the hat is back). A layer that was already
  on before the costume (the panel, a key, the saved switches) stays the performer's: taking the costume off leaves it. An accessory toggle (same
  costume) changes nothing, so a layer switched off in the panel stays off.
- **Chat and events:** each trigger fires at most once per its cooldown (default 2 s, adjustable), each slider /
  outfit at most once per incoming batch, and chat words need at least 3 letters.
- **Never on a tracked parameter:** every page's driver only holds the parameters classified as sliders; when the
  tracking mapping changes, a parameter that is tracked now is let go and leaves the panel and the live cue. Saved
  positions of parameters that are no sliders any more are dropped on the next save, and a save only ever writes the
  avatar its sliders belong to.
- **No reload on stream:** a profile save that only changes Pro2D runtime options (`params`, `layers`, `paramTriggers`,
  `lipGain`, `headGain`, `tune`, `physics`, `idleMotion`, `bindings`, or the thumbnail) is applied to the running rig in place
  on the OBS page and in the studio (`src/avatar/flat/rig2d/liveOpts.ts`): same instance, same GPU objects, no
  missing frame. Once the studio's live cue has reached a page it keeps owning the sliders and the outfit layers, so a
  save of anything else never switches off an outfit a key, the deck or chat put on for the session. An older profile
  fetch that lands after a newer one is ignored. Anything else (a new model file, display mode, `dynamics` …) still
  reloads.
- **How much each part moves** (`flat.opts.tune`, `shared/rig2d/drive.ts` `Rig2DTune`): per standard source
  `[toward +, toward −]`, the multiple of the tracked move away from rest (eyes rest at 1, the rest at 0), 0..2,
  missing = 1. Applied to the source before any binding's range (so a converted model's own parameter scale is kept)
  and clamped to the source's natural range. The studio's parts (`shared/rig2d/tune.ts`) write all sources of a part.
- **Edit rig** (`flat.opts.rigRev`, `server/rigEdit.ts`, `shared/rig2d/rigEdit.ts`): `PUT /api/avatars/:id/rig` saves a
  maker rig (`editor/project.json` inside) over the avatar's own file, keeps the previous one in `.backup/<main>`
  (one step; `POST …/rig/undo` swaps them), keeps every other setting and bumps `rigRev`, which every page reloads for.
  Save and undo run as a small journal (`shared/rig2d/rigJournal.ts`: stage, commit, rename, bump, clear), so a crash
  at any step leaves both rigs on disk and the next save / undo finishes it.
  An imported model (no `editor/project.json`: converted, `meta.source.kind` `live2d` / `inochi2d`, or made
  elsewhere) opens in the maker as an editable copy (`shared/rig2d/edit/adopt.ts`, the reverse of `buildRig`); its first
  save makes it a maker rig and the imported file becomes the backup, so undo brings it back unchanged
  (`checkRigSave(…, { restore: true })`). A stored rig whose `rig.json` can't be read is never overwritten, nor is one
  with `meta.rights.modification: false` (GET …/rig says `locked`; the maker doesn't open it; a save is a 409). GET
  …/rig answers `adopt: true`: an older server doesn't and refuses to save over an imported model, so the studio keeps
  "Save to my avatar" off until it is updated (`rigEditGate`). The maker's saves keep the imported file's name in
  `meta.source.file` (`wasLive2D`: the Live2D sample-model notes survive). Imported pages decode at one scale within
  `editDecodeScale` (at most 256 MiB together); a page that can't be decoded keeps the library save off.

## 9. Runtime support (runtime 2, beta.12)

Everything the format stores renders. A model without a §8 field draws exactly as before: the original shader path;
converted Live2D models are pixel-identical (docs/RIG2D_IMPORT_TESTS.md, regression run).

| Feature | Runtime |
|---|---|
| Meshes, textures, keyform grids, warp + rotation deformers, blend shapes (1D + 2D), glue, draw groups, multiply / screen colours, material bindings | yes |
| Masks (soft, union of mask alpha) incl. inverted; blend modes normal / add / multiply / screen; back-face culling | yes |
| overlay / darken / lighten / clipToLower / sliceFromLower | drawn as normal (no converter emits them) |
| Physics strands, pendulums (Inochi2D), expressions, motions (all segment kinds, fades), part switches, eye blink / lip sync roles | yes |
| Depth parallax, bones + skinning (incl. deformer-following bones), chain physics, springs / jiggle / wind | yes (deterministic fixed steps) |
| Lighting maps (normal / rim / emission) lit by the room's key + fill light and the light-show wash | yes (High / Medium; Low draws flat) |
| State machine (voice, silence, emotion from the face, chat, stream events, hotkey cue, param, timer), blend trees | yes |
| Attachments, costume layers (groups; the avatar's costume picks a layer by id / name), particles | yes (particle budget: Low 0, Medium 128, High 512 per puppet) |
| Multi-angle views, outlines (light-responsive), sprite sheets | yes (Low: 6-tap outlines) |
| Import: Live2D (`.model3.json` + `.moc3` …) | converted 1:1 (docs/RIG2D_IMPORT_TESTS.md: 29 official samples pass) |
| Import: Inochi2D (`.inp` / `.inx`) | converted incl. SimplePhysics → pendulum dynamics, opacity / tint / z-sort bindings, BC7 (DDS) textures |

**Where the world comes from:** `shared/rig2d/world.ts`, fed on the OBS / preview page by
`src/avatar/flat/rig2d/worldFeed.ts`. Each frame it supplies the stage key light (direction in view space, colour ×
intensity), the hemisphere light (fill + ambient), the light show's wash palette, the environment's wind and the
graphics level → tier. Chat messages and stream events (subs, raids, cheers, donations, follows) arrive through the
chat feed. With no feed (classic stage, tests), the defaults apply.

**Framing (where the face and the head are):** never the canvas. A converted model's canvas can be far bigger than
the model, off-centre, or mostly empty. The runtime measures the drawn model at rest:

- **The picture (frame):** the union of the visible meshes over the head / body turn extremes and every expression's
  pose, so neither a turn nor a hotkey prop is cut off.
- **The face:** the visible meshes the eye blinks and the mouth open move. Parameters are found through
  `roles.bind`, `roles.eyeBlink` / `lipSync`, then the Cubism 3 / 2 standard IDs. A blink that warps half the
  model, or a mouth that stretches the whole face, counts only its small meshes. The centre sits between the eyes and
  the mouth; the size is the face itself (brows to chin, across the eyes), as for 3D avatars.
- **The head:** the meshes the head turn / tilt / nod moves, above the chin (hair, ears, hats, a mascot's whole
  head). This also covers rigs that turn the head only through physics outputs (`ParamAugAngleX`, `AngleXPhysic`).
  It gives the head's top above the face and its half width.

Every cam frames these: performer cams and tiles (gaming strip, corner cam), talk cams and the interview set. A bust
seated on a chair is framed where its card sits (it drops onto the seat and grows). The walking TV / monitor shows a
head-and-shoulders crop around them; a picture that is already a bust is shown whole. Checked by
`tools/rig2d_framing_e2e.mts` (every model × every view) and `tools/rig2d_face_unit.ts`.

**Hotkeys:** an expression's own `key` toggles it. A VTube Studio import keeps the model's key (`shared/rig2d/vtsImport.ts`
`vtsKeyCombo`): N1 / Numpad1, letters, F-keys and combinations such as Ctrl + Left arrow or Ctrl + Shift + B. A key the
studio keeps (`shared/studioKeys.ts`: e.g. Ctrl + 1, Alt + 1, H, Shift + 4) is left off on import, and that expression
gets a free number key instead (one import line says which). The number row and the keypad fire the same number.
Expressions without a key get the free number keys 1–9, then 0, in order, never one already taken
(`shared/rig2d/userParams.ts` `expressionKeys`). Each key switches its own
expression on and off; the others stay on (they stack, §6.4), as in VTube Studio.

**Cost:** the runtime measures its own per-frame CPU time (`cpuMs`, shown in the studio's 2D panel). On the heaviest
sample (Mao, 262 meshes) it is 0.61 ms, and 0.81 ms with every feature injected at High
(tools/rig2d_features_e2e.mjs).

## 10. Versioning

- New optional fields can be added within version 1. Readers must ignore what they do not draw, but the strict
  schema refuses unknown fields, so add them to `format.ts` first.
- A change that old readers would misread bumps `version`.
- Editor and vendor data goes in `extra`.

## 11. Texture tiers (a cache beside the file, not part of the format)

High-quality models (8K / 16K pages, several pages) are drawn from **texture tiers**: GPU-compressed copies made from
the original pictures, kept in a rebuildable cache next to the model (HQ decision #10). The `.vtp2` is unchanged
(version 1, original art); a reader that knows nothing about tiers draws the originals.

- **Where:** VTube Pro keeps them in `library/<id>/gpu/<key>/` (server/gpuTiers.ts builds them in the background, in a
  child process at below-normal priority, encoding on worker threads); party guests get the ≤ 2048 tiers inside the party bundle, in RAM only. A missing or evicted cache is made again; the
  model draws from its originals meanwhile and switches when the tiers are ready.
- **Files:** `manifest.json` (status, tiers, pages), `t<k>.layout.json` (the page layout of tier k), `t<k>/p<i>.ktx2`.
- **Key** (`shared/rig2d/gpu/cache.ts cacheKey`, 16 hex): the textures' content (PNG chunk CRCs), every mesh's texture,
  UVs and triangles (the layout depends on them), attachments / particles, and `PIPELINE`: cache + layout versions,
  page size, gutter, alignment, alpha convention, colour convention, mip filter, codec, Basis version and settings.
- **Tier k** = the textures at scale 2^-k (exact premultiplied 2 × 2 area averages), from k = 0 (full size) down to the
  tier whose largest side is ≤ 1024, plus k + 4 for every tier with repacked pages (its tail).
- **Pages** (shared/rig2d/gpu/layout.ts) are at most **4096 px** (every WebGL 2 device takes 4096; a quarter of Android
  phones take nothing bigger). A texture that fits is one page, its UVs unchanged. A bigger one is repacked, and **no
  mesh is ever cut**: each mesh's UV box is a region; regions within the 32 px gutter merge into clusters while a
  cluster still fits a page; a cluster is copied whole with 32 px of its real surroundings, 16 px-aligned, and its
  meshes' UVs move by one exact affine map. A single mesh whose own picture is bigger than a page at that tier is stored
  **smaller** (`PageRect.s`, `MeshMap.s`: area-averaged to fill one page, 4032 px on its longer side): no picture is
  drawn taller than 4096 px, so it still gives about one texel per output pixel when the mesh fills the whole picture.
  Every mesh therefore draws exactly as it does from the original picture: one page, one affine map, the same
  triangles in the same draw call. (Layout v6 drew such a mesh across pages; on Direct3D 11 with MSAA one sample of the
  mesh beneath showed through now and then, varying frame to frame, where two overlapping meshes were split along the
  same screen line.)
  A repacked page holds mip levels 0..4 (exact on the original's mip grid); coarser levels (a strongly squashed mesh: a
  closed mouth or eye) are read from the **tail** — the same texture at tier k + 4, one whole page — at the mesh's
  original UVs, switching where the GPU's own LOD passes 4. Textures with sprite sheets, lighting maps, or used by
  attachments / particles are always one page (scaled further down if they must).
- **Page files:** KTX2 (Khronos), UASTC LDR 4 × 4 + Zstandard, Basis Universal 2.50, quality level 2, no RDO; colours
  **premultiplied** (the DFD's premultiplied flag is set) in the art's own gamma values (the renderer blends them as
  stored); our own mip chain (exact area averages, GPU level sizes `max(1, floor(n / 2^i))`). Levels over the WASM
  encoder's 12 Mi pixel guard are encoded as horizontal strips whose zstd frames are joined into one level.
- **At load** (src/avatar/flat/rig2d/textureTier.ts `pickTextureTier`): per texture, the smallest tier that still gives
  ≥ 1 texel per output pixel at the picture's size (an area-weighted 90th percentile over its meshes at rest), within
  `MAX_TEXTURE_SIZE` and the device's texture budget (desktop 512 MB; phones 48 / 64 / 96 MB by their memory, half
  in low detail, at least 24 MB, the same table as src/avatar/flat/rig2d/textureBudget.ts; software drawing 48 MB); with hysteresis on a re-pick (promotion at once, demotion only when the smaller tier gives
  ≥ 1.5 texels per pixel). Pages are transcoded in a worker to ASTC 4 × 4 (exact from UASTC), BC7, ETC2 RGBA, or RGBA8,
  whichever this GPU's live context takes. "Keep full quality" (`flat.opts.fullQuality`: `true` or texture indices)
  draws those textures from the originals, uncompressed.
- **Hostile files and memory:** every reader of a page picture stops at the size its PNG header promises (and refuses
  a header over 16384 px) — a zlib bomb in a texture is refused in milliseconds; a `.vtp2` upload checks every picture
  its manifest names before it is stored; the server's builder inflates zip entries only up to their declared size,
  and plans the build against the free memory (server/gpuBudget.ts: tiers that don't fit are left out, the cache says
  so in one sentence, and the model uses the best tier that does); the transcoder refuses page sizes a 4096 page can't
  have (`tools/hiq_safety_unit.ts`).
- **Switching tiers while live:** the new pages go up in parts between frames (about 6 MB per step, in strips of block
  rows) while the old tier keeps drawing, then the two swap (`hiq_e2e --frames-only` measures the frame times).
- **Close-ups:** the picture follows its size on screen (src/avatar/flat/rig2d/detailWatch.ts → Rig2DSource.setDetail):
  it grows at once (up to 4096 px on a capable desktop, 2048 elsewhere) when the card is shown bigger than it is drawn,
  including the next room shot announced before the cut (`vtp:camshot`), re-picks the tier, and shrinks back to the
  profile's size only after 2 s comfortably smaller.
- **Seams** are measured, not assumed: `tools/hiq_e2e.mts --seam-only` draws every tier from repacked pages and from the
  original pictures (both uncompressed, our own mips) in four exact poses and fails above 4 / 255 on any pixel
  (premultiplied; the meshes stored smaller are left out and measured on their own), and redraws every frame to check
  it comes out the same each time (`--seam-height 4096` for a 4K close-up, `--seam-repeat N`, `--seam-noaa`,
  `--angle vulkan`).
