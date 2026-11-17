# Building an avatar by hand (in-depth)

For people who model, rig and texture their own characters in Blender, VRoid Studio, Maya, 3ds Max, ZBrush, etc.
If you only want to use the studio's buttons, read **[AVATARS_SIMPLE.md](AVATARS_SIMPLE.md)**.

This is the tutorial. The complete reference tables (every morph alias, every profile field, every lesson learned) are
in **[AI_CREATOR_GUIDE.md](AI_CREATOR_GUIDE.md)**. Section links like *(guide §3.1)* point there. Blender workflow and
safety: **[BLENDER_PLAYBOOK.md](BLENDER_PLAYBOOK.md)**. Faces in depth: **[FACE_CREATION.md](FACE_CREATION.md)**.

Contents: 1 Formats · 2 Axes, units, scale · 3 The skeleton · 4 Face shapes · 5 Eyes · 6 Drawn vs textured faces ·
7 Spring bones and physics · 8 Materials and toon look · 9 Costumes and accessories · 10 Polycount and the party
version · 11 The import check · 12 Validation and testing · 13 Worked examples.

---

## 1. Formats

| Format | Path in the app | Keeps | Notes |
|---|---|---|---|
| **VRM 1.0 / VRM 0.x** (`.vrm`) | loaded as-is | MToon, VRM expressions, `lookAt`, VRM spring bones, humanoid map | Best for anime humans. VRM 0.x is turned to face +Z automatically |
| **glTF 2.0 binary** (`.glb`) | loaded as-is | skin, morph targets, materials, node/material extras | Best for creatures, mascots, robots. Materials become the engine toon (§8) |
| **glTF 2.0** (`.gltf`) | loaded as-is | same | Must be self-contained (`data:` URIs). External `.bin` / images are rejected: export `.glb` |
| FBX (`.fbx`) | converted to GLB by headless Blender | armature, skin, shape keys, materials | Blender's FBX importer (falls back to the C++ one) |
| OBJ (`.obj`) | converted | geometry, UVs, material slots | Single-file upload: the `.mtl` and textures are NOT uploaded. Export GLB from your tool for colours |
| `.blend` | converted | the file as saved | Pack textures (File → External Data → Pack) or they are lost |
| `.dae`, `.stl`, `.ply`, `.usd/.usda/.usdc/.usdz`, `.abc` | converted | geometry (+ whatever Blender's importer keeps) | `.dae` only on Blender builds that still ship COLLADA; STL/PLY have no materials |

Conversion runs `blender/convert.py` (import → export GLB) at low priority on the user's PC. Anything not VRM/GLB/glTF
needs Blender installed. Code: `server/routes/avatars.ts` (`KEEP_AS_IS`, `CONVERT`), `blender/common.py`
(`import_model`), `shared/importCheck.ts` (the format table the dialog uses).

## 2. Axes, units, scale

- **Metres.** A human is ~1.5–1.8 units tall. Centimetre exports (170 units) are detected and normalised for
  placement, but export in metres anyway.
- glTF: **+Y up, the character faces +Z**, its left hand on +X. In Blender that is **Z up, facing −Y** (the glTF
  exporter converts with "+Y Up" on, the default).
- Feet on the ground at the origin. Apply all transforms (Ctrl+A → All Transforms) on the armature and meshes before
  export: an unapplied scale on the armature is the #1 cause of "tiny / exploding" imports.
- **Real size**: a character that is not human-sized sets `"size": { "height": 0.3 }` (metres) in `profile.json`, or
  the user sets it in **Me → 📏 Real size**. Classes: micro < 0.6 m (table perches), small, normal 1.3–2.1 m
  (equalised), large, macro > 2.6 m (back of the room). Details: [SCENES.md "Avatar size classes"](SCENES.md).

## 3. The skeleton (humanoid rig)

The runtime decides a **rig kind** at load (`src/avatar/AvatarRuntime.ts`, guide §2.2):

| Kind | When | Tracking |
|---|---|---|
| `vrm` | the file is a VRM | full: head, spine, arms, fingers, legs, eyes |
| `humanoid` | a skinned mesh whose bones map to at least `hips` + `spine` + `head` | full, for every bone that maps |
| `soft` | no skin, or bones that don't look humanoid | a generated spine/neck/head chain bends the mesh. **No arms** unless you click the arm markers |
| `none` | static | the model follows the head as one piece |

**Use the exact VRM bone names** (case-sensitive) and nothing can go wrong:

```
hips spine chest upperChest neck head jaw leftEye rightEye
leftShoulder leftUpperArm leftLowerArm leftHand            rightShoulder rightUpperArm rightLowerArm rightHand
leftUpperLeg leftLowerLeg leftFoot leftToes                rightUpperLeg rightLowerLeg rightFoot rightToes
leftThumbMetacarpal leftThumbProximal leftThumbDistal
left{Index,Middle,Ring,Little}{Proximal,Intermediate,Distal}      (and the same for right…)
```

- Required: `hips`, `spine`, `head`. Everything else is optional; missing chest/neck are filled from the chain.
- Hierarchy: `hips → spine → chest → upperChest → neck → head`; shoulders under the top spine bone; legs under hips.
- Extra bones (hair, tail, ears, skirt, `hat`, `jaw`) can be added anywhere as children. They get springs by name (§7).
- Other conventions (Mixamo `mixamorig:`, Rigify `DEF-`, CC `CC_Base_`, VRoid `J_Bip_L_`, Unreal `upperarm_l`) are
  mapped by rules, **with known traps**: Mixamo names that start with `Right` (`RightArm`, `RightUpLeg`) are not
  mapped; suffix-sided stems that start with l/r (`lowerarm_l`, `Leg_L`) are misread; Mixamo `Spine1` is dropped.
  Rename to VRM names before export if you use those rigs (guide §2.3).
- **Rest pose**: T-pose, A-pose and creature rests all work (the retargeter uses each bone's rest direction). Knees
  must bend forward. For finger tracking the hand needs `MiddleProximal` plus `IndexProximal` and `LittleProximal`.
- **Weights**: normalised, at most 4 influences per vertex (glTF). No vertex left unweighted (it stays in place while
  the body moves).
- Long necks and four-legged characters have their own rigs: guide §2.6.

**No rig at all?** Import it anyway: the app builds a soft rig instantly, and the import check offers
**Re-rig with Blender**, which runs `blender/autorig.py` (bone-heat weights onto a generated humanoid armature, with
envelope / nearest-bone fallback for non-manifold meshes). The same thing is `POST /api/avatars/:id/autorig` and the
MCP tool `autorig`.

## 4. Face shapes (blendshapes / shape keys / morph targets)

The face is driven by **ARKit 52** names, VRM expressions, or simple named presets, in that priority
(`src/avatar/expressions.ts`, guide §3.1).

**ARKit 52** ("perfect sync": with 10 or more of these the engine drives each one directly):

```
eyeBlinkLeft eyeBlinkRight eyeLookDownLeft eyeLookDownRight eyeLookInLeft eyeLookInRight eyeLookOutLeft eyeLookOutRight
eyeLookUpLeft eyeLookUpRight eyeSquintLeft eyeSquintRight eyeWideLeft eyeWideRight
jawForward jawLeft jawRight jawOpen
mouthClose mouthFunnel mouthPucker mouthLeft mouthRight mouthSmileLeft mouthSmileRight mouthFrownLeft mouthFrownRight
mouthDimpleLeft mouthDimpleRight mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper mouthShrugLower
mouthShrugUpper mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight mouthUpperUpLeft mouthUpperUpRight
browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight
cheekPuff cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight tongueOut
```

Matching ignores case, separators and prefixes like `blendShape1.`; `_L`/`_R` suffixes expand to Left/Right.
`mouthClose` is relative to `jawOpen` (lips together while the jaw is open). Optional speech extras: `tongueUp`
(L, N, D) and `tongueTip` (TH).

**VRM expressions / visemes**: `aa ih ou ee oh` (vowels), `blink blinkLeft blinkRight`, `happy angry sad surprised
relaxed`. VRM custom expressions named like ARKit shapes also count.

**Named presets** for plain GLBs: `a/i/u/e/o` (and `vrc.v_aa`, `mouth_a`, `あ` …), `blink`, `blink_l`, `joy`,
`angry`, `sorrow`, `surprised`. Watch out: VRoid's `Fcl_MTH_A` vowels are **not** recognised in a plain GLB: export
VRM or add ARKit shapes.

**Lip sync** uses 17 visemes (`sil PP FF TH DD kk CH SS nn RR L W aa E I O U`), mapped onto whatever ARKit channels
your model has, strength-normalised per model (guide §3.2). What your shapes must do:
- `mouthClose` + `mouthPress*` at `jawOpen` 0 fully seal the lips (P, B, M).
- `mouthPucker` / `mouthFunnel` make a **round** opening (O, U, W), not a slit.
- `mouthRollLower` (+ `mouthUpperUp*`) tucks the lower lip under the upper teeth (F, V).
- House style: anime mouths are carved into the face, teeth are flat and drawn (never 3D geometry) (guide §3.3).

**No face shapes at all?** The app adds a procedural mouth (drawn, cavity or 3D styles) and procedural eyes you place
with markers (**Me → Fine-tune → Face**). A modelled jaw bone named `jaw` / `lowerJaw` / `chin` is found and hinged
automatically (guide §3.3, `src/avatar/jawRig.ts`).

## 5. Eyes

- **Gaze**: bones `leftEye` / `rightEye` (also `Eye_L`, `eye.R`, `LeftEye`) are rotated; VRM uses `lookAt`; or
  `eyeLook*` shapes.
- **Blink**: `eyeBlinkLeft/Right`, VRM `blink`, or named `blink*`. It must close fully, the lid line landing slightly
  below the eye centre, lashes moving with the lid, no iris showing through at 3/4 view.
- **Procedural eyes** for creatures and faceless meshes: `bulb`, `inset`, `decal`, `led`, `anime` styles
  (guide §3.4).

## 6. Drawn faces vs textured faces

- **Drawn (recommended)**: flat cel tones, hard shadow shapes, crisp dark-warm lines, own 2048² face texture, no baked
  lighting. This is what reads well at stream size and under the toon shader.
- **Textured / realistic**: allowed, but: **never project a photo or an AI render onto the mesh** (it becomes "mush"
  under toon lighting). Paint in UV space. Keep lines warm (`#2a1a22`), never pure black; shadows warm, never grey.
- Details and tools (`blender/face_kit/`): guide §5.2 and [FACE_CREATION.md](FACE_CREATION.md).

## 7. Spring bones and physics

- **VRM**: the file's own VRM spring bones run (author them in VRoid / UniVRM / the Blender VRM add-on). The engine's
  auto chains and jiggle regions are skipped on VRM.
- **GLB**: with auto chains on (default), any non-humanoid bone whose name contains `hair`, `bang`, `ponytail`,
  `braid`, `twintail`, `tail`, `ear`, `skirt`, `dress`, `cape`, `coat_tail`, `ribbon`, `bow`, `tie`, `scarf`,
  `sleeve`, `tassel`, `chain`, `earring`, `antenna`, `ahoge`, `tentacle`, `feather`, `sash`, `strap`, `hat`, `hood`,
  `breast` … starts a spring chain over its children. **Each joint needs a child bone** to swing. Name chains
  `Hair_Front_01 → Hair_Front_02 → Hair_Front_03`.
- Explicit chains: `profile.json` `physics.chains: [{ rootBone, stiffness, drag, gravity, radius }]`.
- Colliders (head, neck, chest) are automatic. Jiggle: bones named `breast`, `belly_jiggle`, `butt`, `cheek_` or
  regions clicked in **Me → Advanced → Body**. Guide §6.

## 8. Materials and the toon look

- **VRM** keeps MToon. Values that work: guide §5.1 and [FACE_CREATION.md §4](FACE_CREATION.md).
- **GLB**: every material becomes the engine toon: cel shadow tinted by the albedo, rim, outlines, angel ring on hair.
  Material extras: `vtpShadeShift` (−1..1; faces ≈ −0.1 … −0.5; use the same value on face and body skin),
  `vtpRim` (0..2).
- **Names matter**: `hair`/`bang`/`fringe` → angel ring; `steel`/`metal`/`gold`… → stylised metal;
  `lens`/`glass`/`visor` → transparent; `voice_glow` → pulses with speech; `mouth`/`tongue`/`cavity` → no rim.
- **glTF colour factors are linear**: convert sRGB hex before writing `baseColorFactor`.
- Textures: PNG/JPEG, power of two, 2048² face, 2048–4096² body atlas, ≥ 256 px per iris. Dilate 8–16 px past UV
  islands. Surface styles (felt, plush, clay, scales, fur): guide §5.5.

## 9. Costumes and accessories

A **costume** (outfit) or **accessory** is a separate GLB skinned to the **same bone names and the same rest pose** as
the base avatar (bones are matched by exact name, inverse bind matrices must match). Unskinned meshes attach rigidly
to the base node with the same name as their parent (a hat parented to `head`).

**File layout** (an imported avatar lives in `library/<id>/`, a shipped one in `assets/builtin/<id>/`):

```
<avatar>/
  profile.json               the AvatarProfile (costumes listed in "costumes": [...])
  model.glb | <id>.vrm       the base model
  thumb.png
  costumes/
    aviators.glb             the costume/accessory mesh + the full base armature
    aviators.costume.json    its CostumeDef: {id, name, file, thumbnail, hides, kind, fit, grip, labels}
    aviators_thumb.png
```

`CostumeDef` essentials: `kind: "outfit"` (one at a time) or `"accessory"` (any number, layered); `hides`: base mesh
names hidden while worn; `fit.margin` / `fit.hideBody` (anti-clip); `grip: "left"|"right"|"both"` closes that hand for
held props. Full list: guide §7.

Build them with **`blender/costume_kit.py`**: it loads the base, measures landmarks, grows garments from the body,
copies the body's skin weights and exports only the costume meshes plus the base armature, with a clip report.
Rules: never cover the face; layer offsets body < shirt (0.012–0.02) < vest/robe (0.03–0.05); **≤ 35k triangles per
costume**. Import a finished one with **Me → Advanced → Wardrobe → Import**, the MCP tool `import_costume`, or
`POST /api/avatars/:id/costumes/import`.

Check compatibility before importing:
```
python tools/check_costume.py base.glb costume.glb       # exit 0 = same parents, rest TRS and inverse binds
```

## 10. Polycount and the automatic party version

| | Target |
|---|---|
| Bust-framed anime avatar | ≤ 60–80k triangles total; face 1.5–4k (anime) / 5–12k (semi-real) |
| **Party-friendly** | **≤ 37,000 triangles** (model + worn costume): your real model is shared even in parties whose host lowered the limit |
| Party warning / hard cap | 170,000 warn / **200,000 cap** (host can change it) |
| Draw calls / materials | ≤ ~40 / ≤ ~25 (atlas and join) |

Solo, any size loads. In a party, a heavier avatar is shared as an **automatic party version** (`server/partyLod.ts`:
hidden geometry dropped, body and clothes decimated first, face, shape keys and rig kept). Preview it in
**Me → 📏 Real size**, or `GET /api/avatars/:id/party-lod`. Details: [MULTIPLAYER_DISCORD.md](MULTIPLAYER_DISCORD.md).

On your own PC a very heavy avatar can also be drawn lighter while you stream: **Avatar detail** (**Room** → **Advanced**
→ **Graphics quality**; with no room loaded it is a section of its own under **Room** → **Advanced**, and the settings
search finds it) swaps the body / clothes / hair triangles for simpler ones only where the difference is tiny (about a
pixel with the avatar standing; bent elbows and knees can show a few pixels), never the face (every triangle a shape key or a jaw / eye bone moves, every face-named part and everything near the face
stays). It does not change the file or the party version. Details:
PERFORMANCE.md.

## 11. The import check (what the app tells the user)

On every import the studio shows *"We'll check your model's rigging…"*, uploads the file, loads it and lists:

| Line | Green | Yellow | Red |
|---|---|---|---|
| Format | VRM / GLB / glTF (loaded as-is) | converted by Blender (FBX, OBJ, BLEND…) | unsupported, or needs Blender and none is installed |
| Skeleton | VRM or humanoid bones found (lists missing arms / legs / fingers / eyes) | soft rig (no arms) | none / static |
| Face shapes | ≥ 10 ARKit shapes, or VRM expressions / vowel visemes | a few shapes, or no visemes (lip sync falls back to jaw) | none: the procedural face will be used |
| Scale | 0.3–3 m | tiny or huge (likely cm or mm units): corrected for placement | |
| Polycount | ≤ 37k (party-friendly) | ≤ 200k (fine; a party version is used only if a host lowered the limit) | > 200k (parties get the automatic party version) |

Actions: **Re-rig with Blender** (`autorig`), **Set up the face** (opens the Face panel, procedural mouth/eyes),
**Use as is (limited tracking)**. Without Blender, the dialog links the one-click installer
(`POST /api/aiconnect/install-blender`, a visible winget window) and blender.org. The pure logic is
`shared/importCheck.ts` (unit tests: `npx tsx tools/importcheck_test.ts`).

## 12. Validation and testing

Run these before you call a model done (all safe while the user is live; Blender at low priority):

| Tool | What it checks |
|---|---|
| `node tools/gltf_validate.mjs model.glb` | Khronos glTF-Validator: structural errors, bad accessors, non-normalised weights |
| `tools\blender_low.cmd -b --factory-startup --python blender\inspect.py -- '{"input":"model.glb"}'` | meshes, vertices, shape keys, bones, materials, bbox |
| `python tools/review_character.py model.glb out_dir --profile profile.json` | 17 renders in the app's toon look + defect detectors (floating bits, gaps, stripes, noise, clipping). Ship only PASS |
| `python tools/check_costume.py base.glb costume.glb` | costume ↔ base skeleton compatibility |
| In the studio (observer tab `?observer=1`) | **Me → Try your expressions**, keys 1–9, mic lip sync, emotes, **Me → Advanced → Avatars → Loaded model** (rig kind, bones, ARKit count, warnings) |

Review in the **app's renderer from 8+ angles including both profiles** (guide §9). Blender previews lie about toon
shading and outlines.

## 13. Worked examples

### A. VRoid Studio → VRM (the easiest good-looking route)
1. Make the character in VRoid Studio. Keep the default hair bones and expressions.
2. **Export → VRM 1.0** (or 0.x). Polygon reduction: aim ≤ 37k if you play in parties; bone reduction off.
3. Import in VTube Pro. The check shows: Format ✓ VRM, Skeleton ✓ vrm, Face ✓ VRM expressions (+ ARKit if you added
   perfect-sync shapes), Scale ✓.
4. Optional: add ARKit 52 with a perfect-sync tool for richer faces.

### B. A Blender-made mascot (GLB with VRM bone names and a few shapes)
Run in Blender (Scripting tab or headless). It builds a simple rigged blob with a jaw and blink, the smallest thing
that tracks fully:

```python
import bpy, bmesh
bpy.ops.wm.read_factory_settings(use_empty=True)
# body: a squashed sphere, 1.2 m tall, feet at 0, facing -Y (glTF +Z)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(0, 0, 0.6), segments=32, ring_count=16)
body = bpy.context.object; body.name = "Body"; body.scale = (1, 0.9, 1.2)
bpy.ops.object.transform_apply(scale=True)
# armature with exact VRM names
bpy.ops.object.armature_add(location=(0, 0, 0)); arm = bpy.context.object; arm.name = "Armature"
bpy.ops.object.mode_set(mode='EDIT'); eb = arm.data.edit_bones; eb.remove(eb[0])
def bone(name, head, tail, parent=None):
    b = eb.new(name); b.head = head; b.tail = tail
    if parent: b.parent = eb[parent]
    return b
bone("hips", (0, 0, 0.35), (0, 0, 0.5)); bone("spine", (0, 0, 0.5), (0, 0, 0.7), "hips")
bone("neck", (0, 0, 0.7), (0, 0, 0.85), "spine"); bone("head", (0, 0, 0.85), (0, 0, 1.2), "neck")
bpy.ops.object.mode_set(mode='OBJECT')
# skin with automatic (bone heat) weights
body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
# face shapes: ARKit names (here crude: move vertices near the mouth / eyes)
body.shape_key_add(name="Basis")
jaw = body.shape_key_add(name="jawOpen"); blink = body.shape_key_add(name="eyeBlinkLeft")
for i, v in enumerate(body.data.vertices):
    x, y, z = v.co
    if y < -0.3 and 0.65 < z < 0.8 and abs(x) < 0.15: jaw.data[i].co.z -= 0.06
    if y < -0.3 and 0.9 < z < 1.0 and 0.08 < x < 0.22: blink.data[i].co.z -= 0.03
bpy.ops.export_scene.gltf(filepath=bpy.path.abspath("//mascot.glb"), export_format='GLB',
                          export_skins=True, export_morph=True, export_extras=True, export_yup=True)
```

Import `mascot.glb`: Skeleton ✓ humanoid (arms missing: yellow), Face: 2 shapes (yellow, the rest is procedural).
Add `leftUpperArm`… bones to get arm tracking, and the other ARKit shapes (at least `eyeBlinkRight`,
`mouthSmileLeft/Right`, `mouthFunnel`, `mouthPucker`, `mouthClose`) for real expressions.
Full, tested Blender recipes: [BLENDER_EXAMPLES.md](BLENDER_EXAMPLES.md).

### C. A downloaded static model (no rig)
1. Import the `.glb` / `.obj` / `.fbx`. The check shows Skeleton ✕ (static) or yellow (soft rig).
2. Click **Re-rig with Blender**. About 20 s to a few minutes later the model reloads as `model_rigged.glb` with a
   humanoid armature and bone-heat weights.
3. Click **Set up the face**, place the eye and mouth markers.
4. Review from 8 angles. If weights are wrong around the armpits, fix them in Blender and re-import.

### D. A costume for an existing avatar
See the docstring of `blender/costume_kit.py` and the real builds `(an internal build)`,
`assets/builtin/frogsuit/build_crowbar.py`. Check with `tools/check_costume.py`, then import it in the Wardrobe.
