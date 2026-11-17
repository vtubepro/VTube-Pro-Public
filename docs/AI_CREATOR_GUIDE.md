# VTube Pro — AI creator guide (characters, costumes, rooms, NPCs)

> **Connecting an AI (Claude Desktop / ChatGPT / Grok / local models) or building a room end to end from a chat:** see docs/AI_CONNECT.md (also `get_docs {topic:"connect"}`).
> **Production checklists for artists and AIs:** docs/ARTIST_AVATARS.md (`get_docs {topic:"avatars"}`) and docs/ARTIST_ENVIRONMENTS.md (`get_docs {topic:"environments"}`).

This is the manual for **any AI model** (Claude, GPT, Grok, Gemini …) building content for VTube Pro. It exists
so a creation looks good **the first time**. Every name, field and path below was checked against the code (file
references in brackets). Where something is optional or experimental it says so.

Read [AGENTS.md](../AGENTS.md) first: the golden rules there (the user may be streaming live, don't touch
`library/` `cache/` `config/` `dist/`, low-priority Blender, keep `tsc` passing) override anything here. **How to work
in Blender** (the lock, headless vs live-window builds, glTF axes, light bake, testing in the app, tested example
scripts): [BLENDER_PLAYBOOK.md](BLENDER_PLAYBOOK.md).

Contents
1. [How content reaches the screen](#1-how-content-reaches-the-screen)
2. [Characters: formats, rig, bone names](#2-characters-formats-rig-bone-names)
3. [Faces: morph names, visemes, mouth rules, eyes](#3-faces-morph-names-visemes-mouth-rules-eyes)
4. [profile.json (AvatarProfile) — annotated](#4-profilejson-avatarprofile--annotated)
5. [Materials, toon shading, textures, hair](#5-materials-toon-shading-textures-hair)
6. [Physics: spring chains and jiggle](#6-physics-spring-chains-and-jiggle)
7. [Costumes and accessories](#7-costumes-and-accessories)
8. [Pipelines and toolkits (VRoid, face_kit, anime_hair, AI meshes, creatures)](#8-pipelines-and-toolkits)
9. [Review protocol (mandatory)](#9-review-protocol-mandatory)
10. [Rooms (environments)](#10-rooms-environments)
11. [Animation and NPCs](#11-animation-and-npcs)
12. [Driving the app: MCP, REST, bus, OBS](#12-driving-the-app-mcp-rest-bus-obs)
13. [One-shot recipes](#13-one-shot-recipes)
14. [Hard-won lessons (what failed and why)](#14-hard-won-lessons-what-failed-and-why)

---

## 1. How content reaches the screen

- **Avatars** live in `library/<id>/` (the user's, **never edit it**) or `assets/builtin/<id>/` (shipped by VTube Pro itself:
  VTube Pro treats any other folder there as the user's own and moves it to `library/`). Each
  folder holds `profile.json` plus the model file (`modelFile`), optional `thumb.png` and `costumes/*.glb`
  [server/library.ts]. A builtin that the user edited gets an override `library/<id>/profile.json`.
- **Rooms** live in `assets/scenes/<id>/`: `scene.json` + `scene.glb` (+ `preview.png` / `thumb.png`,
  sources). A folder is discovered automatically if its id matches `/^[a-z0-9][a-z0-9_-]{0,47}$/` and its
  scene.json parses [server/routes/scenes.ts, shared/scene.ts].
- The studio (`:5190`) and OBS output (`:5191/output.html`) run the same avatar runtime
  (`src/avatar/AvatarRuntime.ts`). Build order: load → rig (VRM | name-mapped humanoid | soft rig) →
  costume/accessories → jiggle bones → procedural mouth/eyes → toon + outlines → spring chains →
  expression driver → retargeter → jaw rig → viseme rig → prop FX.
- **Coordinate contract** [shared/types.ts]: glTF space, **metres, +Y up, the model faces +Z**, character
  left = +X. In Blender: Z-up, the character faces **−Y**, character left = +X; export with `export_yup=True`.
  Profile markers (eyes, mouth, jiggle centres) are in raw glTF scene space.

## 2. Characters: formats, rig, bone names

### 2.1 Formats
- Kept as-is: `.vrm` (VRM 0.x and 1.0), `.glb`, `.gltf`. Converted to GLB by Blender on import: `.fbx .obj
  .stl .ply .dae .blend` [server/routes/avatars.ts].
- **VRM** is the best route for anime humans: MToon materials, VRM expressions, `lookAt`, VRM spring bones all
  work natively. VRM 0.x is rotated to face +Z automatically (`VRMUtils.rotateVRM0`).
- **GLB** for creatures, mascots, robots, props-as-characters: the engine converts materials to its own toon
  shader and adds outlines.

### 2.2 Rig kinds (`profile.rig.kind`)
| kind | when |
|---|---|
| `vrm` | the file is a VRM |
| `humanoid` | a skinned GLB whose bones map to `hips` + `spine` + `head` (minimum, `isHumanoid`) |
| `soft` | no skin / unrecognised skeleton: a procedural skeleton is generated from `rig.soft` (or a guess). **Auto soft rigs have no arms.** Use `autorig` (bone heat) or rig properly |
| `none` | static |

`rig.mechanical: true` = robots: rigid parts, servo feel, no squash/stretch, materials named `*VoiceGlow*`
light up with the voice.

### 2.3 Bone names — use the exact VRM names
The safest, 100 %-reliable choice is the **exact, case-sensitive VRM humanoid names** [src/avatar/humanoid.ts `VRM_NAMES`]:

```
hips spine chest upperChest neck head jaw leftEye rightEye
leftShoulder leftUpperArm leftLowerArm leftHand      (and right…)
leftUpperLeg leftLowerLeg leftFoot leftToes           (and right…)
leftThumbMetacarpal leftThumbProximal leftThumbDistal
left{Index,Middle,Ring,Little}{Proximal,Intermediate,Distal}   (and right…)
```

Required: `hips`, `spine`, `head`. Everything else is optional (missing fingers fold their curl into the
parent; missing neck/spine/chest are filled from the hips→head chain). Extra bones (hair, tail, `hat`, `jaw`)
may be added freely as children.

Other naming schemes are mapped by rules (prefix strip of `mixamorig:`, `DEF-`, `ORG-`, `CC_Base_`,
`J_Bip_L_` …, lowercase, separators removed, `left/l/right/r` as prefix or suffix). **Known matcher bugs — avoid
these names** (verified by simulation; fix pending):
- Names **starting with `Right`** (e.g. Mixamo `mixamorig:RightArm`, `RightUpLeg`) lose their first letters to
  the `rig` prefix rule and are **not mapped** → the right arm/leg won't track, with no warning. Rename to VRM
  names or `R_UpperArm` style before shipping.
- Suffix-sided names whose stem starts with `l`/`r` (`lowerarm_l`, `LowerLeg_L`, `Leg_L`, `ring_01_r`) are misread.
  `upperarm_l`, `hand_r`, `calf_r`, `thigh_l`, `DEF-forearm.R`, `index_01_l` are fine.
- Mixamo `Spine1` is dropped (Spine→spine, Spine2→chest, no upperChest).

### 2.4 Rest pose
T-pose, A-pose and creature rests all work: the retargeter swings each bone's **rest direction** onto the
tracked direction [src/avatar/retarget.ts]. Requirements: model faces +Z (glTF), left = +X, knees bend
forward, the hand has `MiddleProximal` (forward axis) and `IndexProximal` + `LittleProximal` (side axis) if you
want finger tracking. Emotes (VRMA) correct non-T rests automatically.

### 2.5 Budgets (recommended; the party polycount limit IS enforced)
| | target |
|---|---|
| Triangles, bust-framed anime avatar | ≤ 60–80k total; face 1.5–4k (anime) / 5–12k (semi-real). **Multiplayer parties cap avatars at 200,000 triangles (model + worn costume; the host can change it) and warn from 170,000** — heavier avatars are shared as an automatic party version (hidden geometry dropped, body and clothes simplified first, face / shape keys / rig kept; docs/MULTIPLAYER_DISCORD.md → Party version). Build party-friendly: ≤ 37k lets every party see your real model |
| Draw calls | ≤ ~40 (consolidate primitives, atlas materials: Nux went 310 → 32) |
| Materials | ≤ ~25 |
| Face texture | **its own 2048² texture** (a 4K body atlas gives the face < 600 px — too low) |
| Body / outfit atlas | 2048²–4096² |
| Iris | ≥ 256 px per iris |
Every avatar is on screen next to up to 7 others and the face tracker shares the GPU: be frugal.

**Real size.** A character that isn't human-sized must say so in `profile.json`: `"size": { "height": 0.3 }` (metres,
the character's real height). Fairies / pets (< 0.6 m) sit on table perches, giants (> 2.6 m) stand at the back of
rooms, chibis / ogres are shown smaller / taller; leave it out for any human-sized character (they are all shown at the
room's height). Export in metres anyway — centimetre / 10× exports are corrected, but only for placement.

### 2.6 Long necks and four-legged characters [shared/neck.ts, src/avatar/neckRig.ts, src/avatar/quadruped.ts]
- **Neck chain.** Put extra bones between the humanoid `neck` and `head` (`neck` → `neck_2` → `neck_3` → `neck_4` →
  `head`; any names that are not humanoid names). The app measures the chain at load and spreads the head rotation down
  it instead of the stock 40 % neck / 60 % head split, so a long neck bends as a curve instead of whipping.
- **Skin the neck with joint-centred hat weights** (each vertex blends the two bones whose joints bracket it, linearly
  by arc length). Then the neck bends smoothly AND stretches evenly when the neck length changes.
- `profile.neck` (all optional, missing = auto from the neck's share of the height; human necks stay unchanged):
  `length` 0.5–2.5 (× as modelled, live), `sway` 0–1 (body lean / breathing passed up the neck), `tilt` 0–1.5 (head roll),
  `stiffness` 0–1 (0 = bends evenly, 1 = head turns on a still neck), `maxTurn` 20–120° (soft limit), `smoothing` 0–1.
  UI: Tracking → "Neck & head" (presets Short 0.6× / Normal / Long 1.6× / Extra long 2.3×).
- **Quadrupeds**: `"body": "quadruped"`. Keep the humanoid chain `hips → spine → chest → upperChest → neck… → head`
  (+ `leftEye` / `rightEye`) along the back and up the neck; name the legs `leg_FL_1..3`, `leg_FR_…`, `leg_HL_…`,
  `leg_HR_…` (F = front, H = hind, _1 = top), the tail `tail_1…`, the ear roots `ear_L_1` / `ear_R_1` (start ear spring
  chains one bone lower). Face / head / neck are tracked; arm, hand and leg tracking is ignored; the legs stay planted
  with a weight shift, tail swish, ear flicks, the odd hoof shuffle and a walk gait in rooms; no emotes; at seats it
  stands in front of the chair. Example: `assets/builtin/llama/build` (the llama, 4-bone neck, `We Todd :)` medallion).

## 3. Faces: morph names, visemes, mouth rules, eyes

### 3.1 Morph (blendshape) names the engine reads [src/avatar/expressions.ts, src/core/arkit.ts]
Priority per morph: speech extras → ARKit → named presets. Morphs named `vtp_*` are ignored (engine-generated).

**ARKit 52** (perfect sync — engine enters perfect-sync mode with **≥ 10** ARKit shapes; partial sets still drive):
```
eyeBlinkLeft eyeBlinkRight eyeLookDownLeft eyeLookDownRight eyeLookInLeft eyeLookInRight eyeLookOutLeft
eyeLookOutRight eyeLookUpLeft eyeLookUpRight eyeSquintLeft eyeSquintRight eyeWideLeft eyeWideRight
jawForward jawLeft jawRight jawOpen
mouthClose mouthFunnel mouthPucker mouthLeft mouthRight mouthSmileLeft mouthSmileRight mouthFrownLeft
mouthFrownRight mouthDimpleLeft mouthDimpleRight mouthStretchLeft mouthStretchRight mouthRollLower mouthRollUpper
mouthShrugLower mouthShrugUpper mouthPressLeft mouthPressRight mouthLowerDownLeft mouthLowerDownRight
mouthUpperUpLeft mouthUpperUpRight
browDownLeft browDownRight browInnerUp browOuterUpLeft browOuterUpRight
cheekPuff cheekSquintLeft cheekSquintRight noseSneerLeft noseSneerRight tongueOut
```
Matching is case-insensitive after stripping `blendShape1.` / `Face:` / `arkit` / `bs` prefixes and
separators; `_L`/`_R`/`L`/`R` suffixes expand to Left/Right. `mouthClose` is relative to `jawOpen` (lips together
while the jaw is open).

**Speech extras (optional, not ARKit):** morphs named `tongueUp` (tongue tip behind the upper teeth — L, N, D)
and `tongueTip` (tongue between the teeth — TH). Driven by the viseme rig. `tongueOut` is the ARKit one.

**Named presets** (for models without ARKit): vowels `a/aa/vrc.v_aa/mouth_a/mth_a/あ`, `i`, `u`, `e`, `o`
equivalents; `blink`, `blinkLeft`/`blink_l`/`wink_l`, `blinkRight`; emotions `joy/happy/smile/fun`,
`angry`, `sorrow/sad`, `surprised`. VRM expressions (`aa ih ou ee oh blink blinkLeft blinkRight happy angry sad
surprised relaxed`) are driven through three-vrm; VRM custom expressions named like ARKit shapes also count.
VRoid raw `Fcl_MTH_Close`, `Fcl_MTH_Small`, `Fcl_EYE_{Joy,Angry,Sorrow,Surprised}`, `Fcl_BRW_*` are used by
the viseme rig when not bound to a VRM expression. **Gotcha:** in a plain GLB (not VRM) VRoid `Fcl_MTH_A`
vowels are *not* recognised — export VRM, or add ARKit shapes.

Node extra `vtp_round_opens: true` (on any node): your pucker/funnel shapes open the lips themselves, so the
jaw stays shut on rounded visemes.

### 3.2 The 17 visemes and what your shapes must do [src/tracking/visemes.ts, src/avatar/visemeRig.ts]
`sil PP FF TH DD kk CH SS nn RR L W aa E I O U`. With the mic on, voice-timed viseme weights are turned into
ARKit channels per model (strength-normalised so weak and strong rigs look alike; influence is never pushed
above 1). This is the target each viseme is rendered as — **author your shapes so these combinations read**:

| viseme | ARKit-space target (full intensity) | must look like |
|---|---|---|
| PP (m b p) | mouthClose .5, mouthPress .85, mouthRollUpper .3, mouthRollLower .3, cheekPuff .12, closure 1 | **lips fully sealed** — no gap, no teeth |
| FF (f v) | jawOpen .05, mouthRollLower .8, mouthShrugLower .35, mouthUpperUp .3 | **lower lip tucked under the upper teeth** |
| TH | jawOpen .16, mouthUpperUp .12, tongueOut .22, tongueTip 1 | tongue tip between the teeth |
| DD (t d) | jawOpen .14, mouthStretch .15, mouthUpperUp .1, tongueUp .55 | small open, tongue up |
| kk | jawOpen .24, mouthStretch .12 | |
| CH (sh ch) | jawOpen .07, mouthFunnel .6, mouthPucker .4, mouthUpperUp .25 | teeth visible, lips forward |
| SS | jawOpen .04, mouthStretch .45, mouthUpperUp .18, mouthLowerDown .15 | teeth together, lips apart |
| nn | jawOpen .1, mouthClose .1, tongueUp .65 | |
| RR | jawOpen .17, mouthFunnel .5, mouthPucker .3 | |
| L | jawOpen .34, mouthStretch .1, **tongueUp 1** | tongue tip raised, visible |
| W | jawOpen .05, mouthPucker 1, mouthFunnel .25 | small round |
| aa | jawOpen .8, mouthLowerDown .3 | tall rounded D |
| E | jawOpen .42, mouthStretch .45, mouthUpperUp .12 | wide trapezoid |
| I | jawOpen .18, mouthStretch .7, mouthSmile .12 | wide flat slot |
| O | jawOpen .52, mouthFunnel .85 | **round O** |
| U | jawOpen .14, mouthPucker .9, mouthFunnel .3 | **small round OO** |

Emotions own the mouth corners (a smile survives speech); an angry shout bares the teeth.

### 3.3 Mouth rules (house style — non-negotiable)
1. **Anime mouths are carved into the face.** Interior depth is fine; the opening is part of the face surface,
   never a sticker floating on top of the skin or on top of a moustache.
2. **Teeth are flat and drawn** — a white band / shape in the texture or shader. **Never build 3D teeth
   geometry** (the user: 3D teeth "look horrible"). Drawn teeth rows may slide into view with the jaw (Nux).
3. **Lip seal:** `mouthClose` + `mouthPress` at `jawOpen` 0 must close the lips completely (PP/B/M). Test it.
4. **Round OO / O:** pucker and funnel must make a round opening, not a slit.
5. **FF:** `mouthRollLower` (+ `mouthUpperUp`) tucks the lower lip under the upper teeth.
6. **L:** a `tongueUp` shape (or the procedural mouth's tongue) lifts the tip behind the upper teeth.
7. **Beard / moustache follow the lips**: skin them to the same jaw/mouth deformation (or give them the same
   shape keys); the procedural mouth never draws onto meshes named `/mustache|moustache|beard|_nopatch/i` or with
   node extra `vtpNoPatch` [src/avatar/surfacePatch.ts].
8. Closed anime mouth = one short crisp line (or a readable smirk), small (~0.6 eye width on girls). No drawn
   lips on anime girls. Cavity materials (`/mouth|tongue|interior|cavity|throat|gum/i`) get almost no rim light.
9. Pole-free mouth corners with 2 loops around them; a little geometry inside the lip line so opening shows depth.

**No mouth shapes at all?** Use the procedural mouth: `mouth.mode: 'procedural'` + `mouth.center` marker. Styles:
`toon` (drawn on a conforming patch), `cavity` (+ generated skin morphs `vtp_jawOpen`, `vtp_smileL/R`,
`vtp_pucker`, `vtp_cheekPuff`, `vtp_frownL/R`, `vtp_jawSide`), `3d` (cavity + carved stencil portal with a real
interior, hinged jaw, 3D tongue; teeth still drawn; opt-in). **Modelled mouth with a jaw bone** (frogs, robots,
puppets): `mouth.rig = {kind:'jaw'|'puppet', jawBone, openAngle, upperBone?, upperAngle?, sideAngle?, drive?:
'motion'|'light'}`. Auto-detected (only when the model has no ARKit / visemes and the mouth isn't procedural) from
bones named `/^(jaw|jaw_?lower|lower_?jaw|jawbone|mouth_?lower|lower_?mouth|chin)$/i` (+ upper
`/^(upper_?head|head_?upper|upper_?jaw|jaw_?upper|mouth_?upper|upper_?mouth|head_?top|skull_?top)$/i` → puppet)
[src/avatar/jawRig.ts]. The jaw hinge axis is found automatically (avatar left-right). `rig.bounce` (0..1, default 0)
adds cartoon follow-through: the jaw springs a little past its target on fast opens and settles (never past closed).

**Mouth rules** (`mouth.rules`, optional, any mouth with its own shapes or a jaw rig) [src/avatar/mouthRules.ts]:
`cornerBias` (0..1 resting smile, -1..0 resting frown; gives way to the opposite expression), `visemeOpen` (jaw opening
per viseme ×, e.g. `{"I": 0.5, "E": 0.7, "aa": 1.1}`: a very wide cartoon mouth reads better with a small I / E and a big
aa), `puff` (`{shape, amount, threshold, attack, release, idle, idleRate}`: a morph of the model's own (any name, e.g. a
`throatPuff` vocal sac) or an ARKit channel (`cheekPuff`) that swells on LOUD speech, plus an optional slow breathing
pulse while quiet). **Automatic:** a model with a morph named `throatPuff` / `throatSac` / `vocalSac` gets the puff (and
the idle pulse) with no profile setup (`"puff": null` switches it off). A puff morph the engine doesn't otherwise drive
must export with a **default weight of 0**
(Blender: `shape_key.value = 0`; glTF `mesh.weights`), or it shows at full strength until the rule first drives it.

### 3.4 Eyes
- **Model eyes**: bones `leftEye` / `rightEye` (or `Eye_L`, `eye.R`, `LeftEye`) are rotated for gaze
  (up to `eyes.gazeRange` degrees); VRM uses `lookAt`. Blink comes from `eyeBlinkLeft/Right`, named
  `blink*` shapes or VRM `blink`. With `eyes.mode:'model'` and no blink shapes and no lookAt the app warns
  "This model has no eye shapes".
- **Blink must close fully**: the closed lid line lands slightly *below* the eye centre; lash line, eyeline and
  lashes move with the lid (VRoid does this on every eye part); **no eyeball or iris showing through the closed
  lid**; test at 3/4 view (clipping hides at front view).
- **Lash line is geometry-aligned**: the upper lash line straddles the lid margin and stays thin; a thick line
  painted onto lid skin becomes a black blob when the eye closes.
- **Procedural eyes** (`eyes.mode:'procedural'` + `left`/`right` markers) for creatures and faceless meshes:
  `bulb` (spheres ON the surface — frogs), `inset` (pushed in), `decal` (flat cartoon), `led` (robots:
  emissive, shutter blink), `anime` (gacha eyes on a patch: `pupilShape` round|star|heart|slit, `irisColor2`,
  `lashColor`, `lashWing`, `lashThickness`, `lowerLash`, `pupilColor`). Bulb/inset spheres parent to the bone
  that dominates skinning near the marker.
- Full construction rules (sclera lid shadow, iris gradient, catchlights, lash weights by sex): **docs/FACE_CREATION.md §2**.

## 4. profile.json (AvatarProfile) — annotated
Type: `AvatarProfile` in `shared/types.ts`; defaults in `shared/defaults.ts` (`normalizeProfile` fills anything
missing, so a profile may be partial). JSON has no comments — the `//` lines below are explanations only; strip
them. Real example: `(an internal build)` (a creature with bulb eyes, jaw-rigged model mouth,
belly jiggle, a hat chain, 4 costumes).

```jsonc
{
  "version": 1,
  "id": "my_avatar",                 // = folder name, /^[a-z0-9][a-z0-9._-]{0,80}$/i
  "name": "My Avatar",
  "modelFile": "my_avatar.vrm",      // relative to the avatar folder (glb/gltf/vrm)
  "thumbnail": "thumb.png",
  "source": "import",                // import|comfy|builtin|builtin-test (older libraries may hold tripo|meshy|blender-ai). Use "import" (or leave it out): "builtin" = ships with VTube Pro
  "createdAt": "2026-09-25T12:00:00.000Z",
  "transform": { "scale": 1, "offset": [0, 0, 0], "yaw": 0 },   // offset all-zero = auto-ground (non-VRM)
  "eyes": {
    "mode": "model",                 // model | procedural | none
    "style": "anime",                // bulb | inset | decal | led | anime   (procedural only)
    "left": null, "right": null,     // {position:[x,y,z], normal:[x,y,z]} glTF space, character left = +X
    "size": 0.06, "protrusion": 0.55, "scleraColor": "#ffffff", "irisColor": "#3a6ad6",
    "irisSize": 0.42, "pupilSize": 0.75, "lidColor": null, "outline": true,
    "gazeRange": 28, "restOpen": 1, "highlight": true
  },
  "mouth": {
    "mode": "model",                 // model (own shapes / jaw rig) | procedural | none
    "style": "cavity",               // toon | cavity | 3d (procedural only)
    "center": null,                  // SurfaceMarker for procedural mouths
    "width": 0.07, "openHeight": 0.06, "influence": 0.12,
    "lipColor": "#1a1a1a", "interiorColor": "#3a0d12", "tongueColor": "#e0607a", "teethColor": "#f7f7f2",
    "showTeeth": false, "showTongue": true, "lineWidth": 0.006, "restCurve": 0
    // "rig": { "kind": "jaw", "jawBone": "jaw", "openAngle": 30, "sideAngle": 0, "bounce": 0.4 }   // modelled jaw mouths
    // "rules": { "cornerBias": 0.1, "visemeOpen": { "I": 0.5, "E": 0.7 }, "puff": { "shape": "cheekPuff", "threshold": 0.5 } }
  },
  "brows": { "enabled": false, "color": "#1a1a1a", "thickness": 0.008 },       // floating brows (procedural faces)
  "look": {                          // non-VRM surface look; VRM only uses vrmExposure
    "shading": "anime",              // anime | classic | realistic | toy (robots/props)
    "rim": 0.5, "shadowTint": "#ceb6c2", "softness": 0.15, "hairShine": 0.6
    // optional: bloom, saturation, contrast, gloss, stylize, hairMeshes: [...], noseHighlight, vrmExposure (~0.6)
  },
  "blush": { "enabled": false, "color": "#ff8a9a", "rest": 0.3, "hatch": true },
  "rig": { "kind": "vrm" },          // vrm | humanoid | soft | none  (+ "mechanical": true for robots)
  "physics": {
    "enabled": true,
    "jiggle": [],                    // {id,name,center,radius,stiffness,damping,amount,parentBone?} — NOT simulated on VRM
    "chains": [],                    // {rootBone,stiffness,drag,gravity,radius} — non-VRM only
    "autoChains": true, "wind": 0
  },
  "tracking": {                      // defaults are good; tune per character
    "expressiveness": 1.15, "gains": {}, "smoothing": 0.45, "headRotationScale": 1, "bodyFollow": 0.6,
    "mirror": true, "trackHands": true, "trackBody": true, "audioLipSync": false, "facialHair": -1,
    "translate": [1, 0.7, 1.2], "armExaggeration": 1.25, "armBounce": 0.45, "gestureFx": true,
    "gestureReactions": true, "expressionBoost": 1, "cartoon": 1, "enunciation": 1.3
  },
  "speechMotion": { "enabled": true },   // optional talking body language: nod, tilt, turn, brow, blink, asymmetry, gaze, smile, sway, voiceLife
  "costumes": [],                    // CostumeDef[] (section 7)
  "costume": null,                   // active outfit id
  "accessories": []                  // accessory ids worn on top
}
```

Tips: anime humans in VRM → `eyes.mode:'model'`, `mouth.mode:'model'`, `rig.kind:'vrm'`. Creatures with no face
shapes → procedural eyes (`bulb`/`anime`) + procedural mouth, or a jaw rig. `cartoon: 0` for realistic
characters; robots `look.shading:'toy'` + `rig.mechanical:true`.

## 5. Materials, toon shading, textures, hair

### 5.1 Shading
- **VRM**: MToon is kept (no engine toon, no engine outlines). `color` and `shadeColorFactor` are multiplied by
  `look.vrmExposure` (default 0.6) because MToon is authored for dimmer scenes. MToon values that work are in
  docs/FACE_CREATION.md §4 (face `_ShadeShift` −0.35…−0.6 with proxy normals, `_ShadeToony` 0.9, rim off on
  faces, matcap removed, warm skin shade colour).
- **GLB**: every material becomes the engine toon (`look.shading`): albedo-tinted cel shadow (never grey), a
  warm terminator band, soft rim, angel ring on hair, inverted-hull outlines tinted from the surface colour
  (~1.3 px min width). Material **glTF extras** honoured [src/avatar/toon.ts]:
  - `vtpShadeShift` (−1..1, default 0): MToon-style terminator shift; negative = lit further round the form.
    Put the same value on face and body skin (no neck seam). Faces ≈ −0.1 (comic) to −0.5 (mostly lit).
  - `vtpRim` (multiplier, clamped 0..2, default 1; cavity-named materials default 0.1).
- Surface styles (felt, scales, clay, plush, fur…): `look.surface`, extras `vtpStyle`, or `Name@style` — §5.5.
- Name rules: hair `/hair|bang|fringe|ponytail|twintail/i` (or `look.hairMeshes`) → angel ring; metal
  `/steel|metal|chrome|brass|gold|silver|iron|copper|bronze|alumin/i` → stylised PBR; glass
  `/lens|glass|visor|goggle/i` → transparent; `/voice_?glow/i` → pulses with speech.
- **glTF colour factors are LINEAR.** Convert sRGB hex before writing `baseColorFactor` / `emissiveFactor`
  (`((c+0.055)/1.055)^2.4`). "Black" written as sRGB 0.07 renders mid-grey.
- Outlines tear at UV seams unless normals are averaged (the engine averages); kill outlines around nose, mouth,
  eyelids (MToon `_OutlineWidthTexture`, or rely on the engine skipping transparent materials).

### 5.2 Textures — draw, never project
- **Never project a low-res reference or a photo/AI render onto the mesh.** That produced "blotchy mush" (Aosabi
  v1: a ~60 px face crop). References are for *measuring*, never for pixels.
- Faces: own 2K texture, vector marks evaluated per texel (SDF strokes/ellipses, anti-aliased by texel size),
  **flat cel tones + hard shadow shapes + crisp lines**. 2–3 skin tones only. Shadows warm and saturated
  (`#f3d5c0` → `#d99a8c`), never grey. Lines dark warm brown/plum (`#2a1a22`), never pure black. No baked
  lighting in the albedo (only occlusion darks: nostrils, mouth corners, lid crease).
- No noise: no photo texture, no per-texel random dots, no weave moiré. Procedural marks are sparse, long,
  tapered. Dilate every texture 8–16 px past its UV islands.
- Toolkits: `blender/face_kit/raster.py` (`posmap`, `zraster`, `dilate`) + `sdf.py` (ellipse SDF, tapered
  polylines, Béziers, alpha-over). `tools/texproject.py` exists for re-texturing, but its projection mode is
  exactly what must not be used for faces.

### 5.3 Shading normals
Toon shading from raw mesh normals paints blotches around nose, lips, sockets, hair clumps and beard spikes, and the
terminator crawls while talking. Transfer **proxy normals** from a smooth ellipsoid/smoothed copy (Blender Data
Transfer → custom normals): 100 % on cheeks/forehead/mouth region, 60–80 % around the nose. Export with morph
normals off. Done automatically by `face_kit` (`proxy_normals`, `shading_normals`) and `anime_hair`
(`clean_normals`). The engine reads exported custom normals.

### 5.4 Hair (as important as the face)
- **Clumped cards/ribbons (layered tapered clumps on guide curves)**, not strands, never flat stripey ribbons
  (the review tool flags R4 flat cards / R5 stripes). Toolkit: `blender/anime_hair` (clumps on guides, proxy
  normals, clean palette with one form band + ink edges + zig-zag **angel ring**, spring-chain weights, style
  library, `fit.py` harness on a real VRM). `blender/hair_kit` and `face_kit/hair_styles.py` for comic hair.
- Strand-direction shading: the proxy normals give big clean cel shapes; the angel ring rides the head.
- Hand-laid locks stay at ~1.05–1.08 skull radii or the top balloons; buried hair is conformed with a gap, never
  deleted (holes at the nape). Paint a hard fringe shadow band on the forehead.
- For VRM hair: MToon, `_OutlineWidth 0` + a separate ink hull mesh (MToon outline can't be used with proxy
  normals), one VRM spring group per layer (stiff fringe, looser back).

### 5.5 Surface render styles (felt / sock puppets, plush, knit, clay, scales, fur…) [src/avatar/surfaceStyles.ts]
Procedural material looks — no textures, no downloads — on **any** avatar: GLB (every `look.shading`) and VRM (MToon is
patched in place), costumes and accessories. Patterns live in the avatar's **rest space** (metres, seam-free, glued to the
skin while it moves). Structural relief (scales, knit, stitches, plates) bends the shading normal; fine noise (fibres,
clay lumps, grain) only shades the albedo, so the crisp cel terminator and toon highlights stay clean. The toon outlines,
toon+ rim (High / Ultra) and the light show's performer light (SHOW / PRESHOW beams, washes, mirror-ball sparkle) all work
on top — styled parts still get and show the show lighting.

| id | look | notes |
|---|---|---|
| `felt` | matted felt puppet: fibre fuzz, pilling, velvet rim, **sewn seams** | pair with `eyes.puppet: 'googly'` |
| `sock` | knitted sock: 2×2 rib (`pattern`: `rib2` `rib` `stockinette` `garter`), fuzzy yarn, seams | `eyes.puppet: 'button'` |
| `fleece` | Muppet (Antron) fleece: soft nap + strong sheen; **shell pile on High / Ultra** | |
| `plush` | minky plush toy: dense short pile, crushed-nap sheen patches, seams, shells on High / Ultra | |
| `knit` / `crochet` | chunky knit V stitches / amigurumi single crochet with holes | |
| `clay` | plasticine: soft lumps, thumbprints, waxy highlight; `boil` 0..1 = stop-motion re-sculpt 12×/s | |
| `plastic` `vinyl` `rubber` `porcelain` | toy plastic (crisp cel highlight), designer vinyl (light bleed), matte rubber, glazed porcelain + hairline crackle (`color2`) | |
| `paper` `cardboard` | pulp fibres, folds / creases; corrugation flutes + speckles | |
| `metal_brushed` `metal_painted` | brushed steel (stylised reflections) / painted robot panels with **chipped edges** (`wear`; bare metal = `color2`) | |
| `glass` `crystal` `slime` | see-through + fresnel edges / flat facets + sparkle + rainbow fire / jelly: glow, bubbles, `wobble` | outlines off / thin |
| `stone` | lumps, cracks (`color2`), speckles; greys the model colours unless `tint` is set | golems, statues |
| `scales_lizard` `scales_dragon` `scales_snake` `scales_fish` | overlapping / keeled / diamond / cycloid scales (`pattern`: `overlap` `hex` `cycloid` `keeled` `diamond`), finer on head, hands and feet, per-scale colour variation, bright free edges, iridescence, **belly plates** (`belly`, colour `color2`) | the belly follows a painted light belly patch in the texture when there is one, else a soft front ellipse |
| `scutes` | wide overlapping plates — for a belly / tail-underside material | |
| `keratin` | horns, claws, beaks: growth rings from the thick base to the dark tip (`color2`) — the axis is found per connected piece | |
| `wet_skin` | glossy amphibian: slick highlights, soft spots (`color2`), little warts, paler belly | |
| `fur_short` `fur_long` | fibre shading on every tier; **shell fur** on High / Ultra that hangs (`droop`), sways (`wind`) and lags behind your motion | vertex colour R = length map |

**Where a material's style comes from** (first match wins):
1. `profile.look.surfaces` — `{ "<material or mesh name>": "felt", "/Jacket|Coat/": { "style": "plush", "tint": "#b3262e" }, "Eyes": "none" }`
   (exact names or `/regex/flags`; `'none'` opts a part out).
2. **glTF material extras** `vtpStyle` — a string (`"felt"`) or an object / JSON string with any tweak below. In Blender:
   material → Custom Properties → `vtpStyle` = `felt` (export with `export_extras=True`).
3. **Name token** in the material or mesh name: `Body@felt`, `Belly@scutes`, `Horn_L@keratin`, `Collar@fur_long`.
4. `CostumeDef.surface` — the whole costume / accessory in one style.
5. `profile.look.surface` — the avatar default (base model only). Skipped automatically: eyes, iris, sclera, lenses,
   glass, visors, teeth, tongue, mouth interiors, screens, `*VoiceGlow*`, decals, `EMIT_*`, emissive and see-through parts.

**Tweaks** (`SurfaceStyle` in shared/types.ts, all optional — unset = the preset): `tint` (sRGB; re-colours but keeps the
texture's light / dark detail), `color2`, `sheenColor`, `scale` (pattern size ×), `relief`, `fuzz`, `variation`,
`iridescence`, `translucency`, `gloss` (0 matte … 1 mirror-like cel highlight), `pattern`, `belly`, `stitches` (`auto` |
`seams` | `authored` | `none`), `stitchColor`, `stitchWidth` (m), `furLength` (m), `furDensity`, `shells` (`auto` |
`always` | `off`), `droop`, `wind`, `boil`, `wobble`, `wear`, `outline` (outline width ×, 0 = none), `mapping` (`object`
default, `uv` = the model's UVs). Preset sizes assume a ~1.6 m performer and scale with the avatar's height.

**Stitches / seams.** `auto` uses an authored `_STITCH` vertex attribute (float, 1 on the stitch line — Blender: a float
attribute named `_STITCH`, exported with "Attributes") when present, otherwise the mesh's **UV seams and open borders**
(hems) — so mark seams in Blender where the puppet should look sewn. Meshes whose UVs are chopped into many islands (AI
atlases) get no automatic stitches (it would be stitches everywhere); author `_STITCH` there, or `stitches: 'seams'`.

**Puppet eyes** (`eyes.puppet`, bulb / inset eyes): `button` (irisColor = button, scleraColor = thread), `googly`
(loose pupil that falls with gravity and swings when you move, still nudged by your gaze), `felt` (felt discs).

**Tiers.** Performance / Balanced / Classic (no room): the cheap path (2-octave noise, no glints, no shells unless
`shells: 'always'`). High: +1 octave, glints, shell fur (6 short / 10 long layers, ONE instanced draw per furry mesh).
Ultra: +2 octaves, 12 / 20 layers. Tier steps only change uniforms and shell visibility; every program compiles at avatar
load / style change and hidden shells are pre-warmed by the gfx compile pass (no mid-show compiles). In the studio a style
or pattern change rebuilds the avatar; colours and sliders update live.

**AI / creator checklist.** Tag the material, not the mesh, when a mesh has several parts (claws vs skin). Keep the base
colour you want in the texture (styles modulate it) or set `tint`; a light painted belly patch becomes the belly plates.
Scales and knit need no UVs; fur wants a closed, smooth mesh (shells follow its normals) — keep face fur short with a
vertex-colour length map. Judge in the app renderer from 8+ angles at Balanced AND High, under SHOW and PRESHOW lighting
(`output.html?sceneTest=<room>&avatar=<id>&gfx=high`; `vtpOut.runtime.surfaces.info()` lists what got which style).

API for UI / tools: `SURFACE_STYLES` (id, label, category, hint, swatch, patterns, params = the tweaks worth showing),
`surfacePreset(id)`, `normalizeSurface(x)`, `runtime.surfaces.info()` / `runtime.setLook(look)` (live params),
`setSurfaceQuality(level)`. The studio's minimal picker is `src/ui/surfacePanel.ts` (Look → Surface style) — the UI
overhaul can replace it with swatch cards built from `SURFACE_STYLES` (group by `category`, show `hint`, offer `params`).

## 6. Physics: spring chains and jiggle
[src/avatar/physics.ts]
- **VRM**: the file's own VRM spring bones run; the engine's chains and colliders are skipped, and **jiggle
  regions are not simulated on VRM**. Author springs in the VRM.
- **Non-VRM**, `physics.autoChains: true`: every non-humanoid bone whose name matches
  `/(hair|bang|fringe|ponytail|braid|twintail|pigtail|tail|ear(?!ring)|skirt|dress|cape|cloak|coat_?tail|ribbon|bow|tie|scarf|sleeve|tassel|chain|pendant|earring|antenna|ahoge|tentacle|feather|plume|pom_?pom|sash|strap|hat|hood|breast|bust|oppai|boob|chest_?soft)/i`
  and whose parent is not also such a bone starts a chain over all its descendants (first child = next joint).
  Defaults: stiffness 1.1, drag 0.4, gravity 0.35 (`hat`/`hood`: 3.2 / 0.55 / 0.1), stiffness ×0.85 per depth.
  So: name chain roots `Hair_Front_01`, `Tail_01` → `Tail_02` …; each joint needs a child bone to be a spring.
- Explicit chains: `physics.chains: [{rootBone, stiffness, drag, gravity, radius}]`.
- Colliders are automatic (head sphere, neck sphere, chest capsule).
- Jiggle: bones matching `/(breast|bust|oppai|boob|belly_?jiggle|jiggle|butt|glute|cheek_)/i`, or profile regions
  (`center`, `radius`, `parentBone`) that inject `vtp_jiggle_<id>` bones. 120 Hz fixed step.

## 7. Costumes and accessories
[src/avatar/costumes.ts, costumeFit.ts, server/costumes.ts]
- A costume is a **separate GLB skinned to the SAME bone names and rest pose** as the base (+ optional extra bones
  parented to base bones: feathers, cane, sash tails — they get springs by name). Bones are matched by exact name;
  the costume's inverseBindMatrices are reused, so rest poses must match exactly.
- **Build them with `blender/costume_kit.py`** (loads the base, measures landmarks, grows garments from the
  body, skins from the body's weights, exports only costume meshes + the full base armature; worked example in
  its docstring, real ones in `(an internal build)`, `frogsuit/build_crowbar.py`).
  Kit rules: never cover the face (`kit.face_box()`; `export_costume` warns); layer offsets body < shell
  (0.012–0.02) < vest/robe (0.03–0.05) < straps/belts (+0.01) < pouches; tuck sleeve/trouser tops under the
  shirt/coat instead of butting edges; hats are rigid on `hat` (else `head`) and clear the eyes; bone chains 2–4
  bones; **≤ 35k tris per costume** (`export_costume(..., max_tris=35000)`); don't hand-tune offsets against
  clipping — `export_costume` runs `fit_to_body()` and prints a `CLIP_REPORT` for head-yaw / arms-up / elbow /
  lean poses (hundreds of hits = loosen the garment or `skin_to_body` it). Check with
  `python tools/check_costume.py base.glb costume.glb` (same parent, rest TRS and inverse bind matrix per shared
  bone; exit 0 = compatible). Preview: `blender/costume_preview.py -- base.glb costume.glb out_prefix`.
- Unskinned meshes attach **rigidly** to the base node whose name equals their parent's name (a hat under a
  node named `head`).
- `CostumeDef` fields: `id`, `name`, `file` (`costumes/<id>.glb`), `thumbnail`, `hides` (base mesh names hidden
  while worn), `kind` (`outfit` default | `accessory`), `eyes` (Partial EyeConfig while worn), `labels`
  (runtime text painted on a material: `{material, text, color, background, font, aspect}`), `fit`, `prompt`,
  `source`. One `costume` (outfit) at a time; any number of `accessories` layer on top.
- Held props (bats, canes, brass knuckles): `grip: 'left' | 'right' | 'both'` on the CostumeDef closes that hand (character's
  side) into a grip while it is worn; tracked fingers can still curl further, never open past it. Skin the prop 100 % to
  `leftHand` / `rightHand` (rings on the finger bones) with the grip centre in the palm of the open rest hand
  (`assets/builtin/hooded_thug/build/build_thug.py` `s_props`).
- `fit` (anti-clip pass at load): `margin` (fraction of height, default 0.006; 0 = no push-out), `hideBody`
  (default true for outfits: drops body triangles the costume fully covers), `hideInside: [{center, radius,
  bone}]` (spheres always treated as covered, e.g. a mask's mouth cavity). Accessories get **no fit** unless
  `fit.hideBody === true`; **`hideInside` only works on accessories** (outfits ignore it).
- **Prop FX** (by name, no schema) [src/avatar/propFx.ts]: materials named `*Ember*` (MeshStandard with
  emissive) smoulder and flare when the lips press/pucker (cigars); meshes named `*SmokeEmitter*` /
  `*smoke_emitter*` are hidden markers that puff billboard smoke from their first vertex — **SmokeEmitter only
  works inside an accessory GLB** (the marker prep runs for accessories only).
- Costume meshes never get the procedural mouth/eyes. Keep straps/collars/patches tight to the body (review
  detector G2 flags anything > 4 mm off the surface): **rigid props don't ride skin morphs** — build a strap as a
  rigid ribbon (`face_kit` `strap_ribbon`), an eyepatch as a membrane cap (`patch_cap`).

## 8. Pipelines and toolkits

Run Blender only via `tools\blender_low.cmd -b --factory-startup --python <script> -- <args>`; run Python
kits from the repo root (not from `blender/` — `blender/inspect.py` shadows the stdlib module).

| Goal | Route (proven) | Tool |
|---|---|---|
| Anime girl/boy VTuber | CC0 pixiv VRoid sample bases (`tools/vendor/vroid`: Sendagaya_Shino/Shibu, Darkness_Shibu, Sakurada_Fumiriya, HairSample_Male/Female) → parametric build → face repaint → hair → VRM | `blender/anime_creator/build.py <params.json> <out_dir>` (presets in `blender/anime_creator/presets/`), `python blender/face_kit/anime_face.py <preset> <out_dir>` (presets `gacha_girl`, `vtuber_girl`, `anime_boy`, `chibi`), `blender/anime_hair` |
| Import a user's VRoid / VRM | import as-is, tune `look.vrmExposure`, check eyes/mouth/visemes | `import_model` (with permission) |
| Comic / semi-real human | MakeHuman (MPFB) base → `HFace` finishing | `python blender/face_kit/comic_face.py comic_bearded_man <out_dir>` (also `comic_woman`) |
| Creature / mascot (frog, bee, dragon) | fully scripted Blender/numpy build: implicit/SDF body, grid face with modelled mouth + ARKit mouth shapes, jaw bone, painted cel texture from 3D position, bulb or model eyes | `(an internal build)`, `(an internal build)` |
| Robot / object | GLB, `look.shading:'toy'`, `rig.mechanical`, LED eyes, jaw or `VoiceGlow` drive | `assets/builtin/robot/build_robot.py` |
| Outfit / prop for an avatar | costume_kit | `blender/costume_kit.py`, `tools/check_costume.py` |
| Unrigged mesh | autorig (bone heat, VRM names) from a soft-rig config | MCP `autorig`, `blender/autorig.py` |

**Never** push humans / anime humans through Tripo/Meshy/Hunyuan3D, and **never** generate anime characters from scratch
with procedural Blender meshes (rejected as "atrocious"). Rules for anime faces: docs/FACE_CREATION.md.

### 8.1 AI meshes (Tripo, Meshy, ComfyUI) → avatar [(an internal build)
**An AI mesh is a sculpt reference, never the avatar.** Its topology is triangle soup with no face loops or rig,
and its texture has baked blotchy light. Keep its **shape** (proportions, silhouette, hair clumps, fold relief);
discard its topology and pixels:
1. Import, print the bbox, normalise height and yaw (Tripo arrives at arbitrary scale; faces −X → yaw −90).
2. Dump P/N/UV/tris to npz; label vertices by texture HSV + height/side rules into class masks (front/side/back)
   — a consistent turnaround for fitting.
3. Transfer the face shape onto a proper base head with a smoothed displacement field; move eyes and mouth
   **rigidly** (else "goggles" and a pinched beak).
4. AI hair can be kept (solidify, voxel remesh, decimate; conform buried vertices, never delete).
5. Bake AI relief into designed cel shadows / ink (thresholds high enough that mesh noise never becomes ink).
6. Proxy normals on skin, beard, hair, clothes; export with morph normals off.
7. Paint every texture yourself as clean cel art. QA: bounds assert + in-app review.
For creatures/objects an AI mesh can be a starting sculpt; `generate_avatar` with `faceless: true` lets VTube Pro
add procedural eyes and mouth. Finishing an AI-generated, auto-rigged GLB that you keep (mascots, the frogsuit
uncle, the gas-mask trooper):
- `blender/finish_generated.py -- config.json` — applies transforms (cm rigs), **renames Meshy/Mixamo bones to
  VRM names** (handles both spine orders), deletes parts, adds extra bones, glass lenses, and prints face MARKERS
  in glTF coordinates for profile.json.
- `blender/cleanup_lib.py` (`import cleanup_lib as C`; existing bones are never moved so costumes keep binding):
  `C.smooth_body`, `C.fix_elbows` (Meshy's elbow "horns"), `C.replace_hands` (`fuse=True` = one glove, no sausage
  fingers), `C.lens_disc`, `C.fix_unweighted`, `C.remesh_smooth`, `C.export`; `blender/avatar_polish.py`
  (`rebuild_body` voxel remesh + fairing, `smart_uv`, `Painter` flat repaint, **`carve_mouth`**: real opening +
  cavity + `jaw` bone + ARKit keys, flat painted teeth band). Worked example: `assets/builtin/frogsuit/cleanup_uncle.py`.
- `tools/texproject.py` projects a clean drawn turnaround onto a body with a flat palette for unseen texels —
  acceptable for bodies/clothes from a *clean drawn* turnaround, **never for faces** (use a drawn face plate).

### 8.2 How the creature faces were built (copy these techniques)
- **Sprocket v2** (`build_frog_v2.py`): procedural `bulb` eyes on markers; mouth = split seam (upper + lower
  lip rows) closed by a watertight bag + tongue in the body mesh, `jaw` bone (weights 0 at the fixed corners),
  26 ARKit warps in the surface's (azimuth, elevation) space, `--cliptest` checks them; no teeth. Rounded vowels:
  "a small clean OVAL drawn in the face, not a pinched slit" — the wide mouth gathers, the lips part on a true
  ellipse, the skin domes forward; `vtp_round_opens` keeps the jaw shut on rounded shapes.
- **one model** (an internal build): modelled eyes — an eyeball sphere fitted to the face 1.2 mm under the skin,
  the face sculpted around it (lid bed), eye holes with harmonically relaxed concentric lid loops, blink keys that
  move lid vertices perpendicular to the corner axis so the rims close onto one clean line (nothing folds), the
  eyeball cap curls under the face beyond the opening (never pokes through), `leftEye`/`rightEye` at the sphere
  centres, a painted all-iris texture with highlights fixed upper-left on both eyes (+ emission). Mouth: ':3' split
  seam in a shallow crease + bag + tongue dome, jawOpen as a skin warp; **fangs = flat triangular decals riding
  the upper lip in every shape key**. Head normals blended toward a big sphere; `vtpRim` 0 on the mouth.
- Riotfrog / robot / the puppet avatar: same carved-bag family (the puppet: puppet wedge via `blender/puppet_lib.py`).
  Check jaw rigs with `blender/rig_review.py -- model.glb out_dir [profile.json]`.

### 8.3 Every fix becomes a pipeline step
The product ships to non-experts and must one-shot. Anything you fix by hand (a cleanup, a despeckle, a sleeve
cap) goes into a reusable parameterised step (`blender/cleanup_lib.py`, a kit function, a build-script stage) so
a rebuild reproduces it. Build scripts must be **one command, no manual steps** (see `its build script`).

## 9. Review protocol (mandatory)
Do not show or install anything until it passes this. Front and 3/4 face crops alone missed stripey hair
ribbons, a noisy beard, a floating strap and suit smears (Aosabi v5: "the fact that you can't tell it's awful
shows you need serious help").

1. **Automated review** (CPU Blender, low priority, safe while live):
   ```
   python tools/review_character.py <model.glb|vrm> <out_dir> --profile profile.json [--ref ref.png ...] [--focus hair|all] [--res 1024] [--only views]
   ```
   Renders 17 views in the studio toon look (bust front, both 3/4, **both profiles**, back, back 3/4, low, high,
   head close-ups incl. top, full body) and runs detectors: G1 floating islands, G2 stand-off (straps bridging air),
   G3 specks, R1 detached pieces, R2 see-through gaps, R3 culled back faces, R4 flat cards, R5 stripes/banding,
   R6 texture noise, R7 terminator noise, R8 smears/blotches, R9 poke-through (clipping), R10 ragged silhouette.
   Output: `report.md`, `report.json`, `sheet_views.png`, `sheet_marked.png`, `sheet_head_full.png`,
   `sheet_clay.png`. Verdict **FAIL** (any high or ≥ 3 medium) / WARN / PASS. Ship only PASS (or WARN you can
   justify). Costumes: also `tools/check_costume.py`. Under the hood it uses
   `blender/review_char/render_passes.py` (numpy re-evaluation of the app's toon shader + a clay pass + a
   light-flip pass that exposes baked lighting); quick looks: `blender/review_avatar.py -- model.glb out_prefix
   [--views ...] [--keys "jawOpen=1"]`. Before heavy Blender work, `python tools/live_ok.py` (exit 1 = the live
   studio is struggling: wait).
2. **In the app renderer** (Blender previews lie about MToon exposure, outline weight, shade tint): 8+ angles —
   front, both 3/4, **both profiles**, back, full bust, head close-up — plus an expression/viseme sheet: blink
   (fully closed, no eyeball through lids), smile, surprise, angry, `aa`, `oo`, `ee`, `ff`, and PP (lips sealed).
   - Use your OWN tab: `output.html?avatar=<id>&preview=1&observer=1&focus=head|bust|full&fps=30&adaptive=0`
     (only for avatars already in `assets/builtin` or that the user imported). **Close it right after.**
   - That tab still **receives the performer's live tracking** — the user's face and arms will contaminate your
     screenshots ("mouth reads open", "sleeves flare" were the user, not the model). Freeze it: in the console,
     `s.sync.push = () => {}; s.sync.steps = () => []`, zero `s.frame` (face / mouth / visemes / lips / head /
     gaze / bones), set `s.lastFrameAt = performance.now()` before each `vtpOut.step(1)` (see the Aosabi
     pipeline doc for the exact handles). Drive expressions by writing `s.frame.face` yourself.
   - To preview a candidate without installing it, serve its GLB from your own local read-only server and
     redirect the tab's `fetch` for the model file (Aosabi `review/serve_glb.py`).
3. **Against the reference at identical framing** (docs/FACE_CREATION.md §8): same crop, same yaw; list the 3
   biggest differences, fix, repeat. Silhouette IoU is not a quality metric. For real characters, the character's
   **current official art** is the primary reference (AI turnaround sheets drift).
4. **Common failures to hunt for**: floating parts (straps, collars, patches off the surface), stripes in hair,
   noise/smears in textures, clipping (body through clothes, hair through shoulders, teeth through lips),
   broken silhouettes, mouth not closing (PP), eyes not closing (blink), lash line blobs on blink, terminator
   blotches on nose/hair, black outline blobs at the nose/mouth, grey shadows, pure-black lines, "sticker" look.
5. **Never install a version that looks worse than the previous one.** Answer the 11-point self-review checklist
   in docs/FACE_CREATION.md §8 with "yes" on every line.

## 10. Rooms (environments)
Full contract: **docs/SCENES.md**. This section is the checklist + template.

### 10.1 Folder, units, discovery
`assets/scenes/<id>/` → `scene.json`, `scene.glb` (name from `scene.json model`, default `scene.glb`),
`preview.png` (1280×720 from CAM_WIDE), `thumb.png` (480×270), sources under `blender/`, optional `README.md`,
`textures/`, `lut.png` (1024×32 colour-grade strip). Metres, **+Y up, stage front = +Z** (towards the default
camera). In Blender: stage front = **−Y**; an empty's glTF +Z = its local **Blender −Y**; cameras look down −Z.
Export with `export_yup=True, export_extras=True, export_cameras=True, export_lights=False, export_apply=True`
(custom properties → glTF extras, which the engine reads as `userData`).

### 10.2 Node contract (core) [src/scene/contract.ts]
| Node | Meaning / extras |
|---|---|
| `SPOT_01`…`SPOT_12` | Avatar positions; origin = feet on the floor; **+Z = the way the avatar faces**. `pose` `"sit"`/`"stand"`; sit: `seatHeight` (default 0.45, 0.15–1.4), `seatDepth` (0.5); `label`; `approach` = flat `[x,y,z, …]` glTF points (≤ 32) to route around furniture; `leavePathAt` = `"PATH_02"` (else nearest) |
| `SPOT_xx_CAM` | talk camera for that spot (else automatic) |
| `DOOR` | door leaf, origin = **hinge**, rotates about local +Y; `openAngle` (deg, default 95). Swing it outward so it never sweeps the room |
| `DOOR_OUTSIDE` | spawn point just outside the door, facing in |
| `PATH_01…` | waypoints door → room centre. Walls are NOT modelled — the lanes keep walkers inside |
| `SCREEN` | react screen: 16:9 plane mesh, UVs 0..1, faces the camera; `restOffsetY` (how far above its shown position it rests). The surface = the node mesh, else a child named `*surface*`, else the largest child |
| `SCREEN_SOLO_xx` / `SCREEN_SOLO` | optional solo-react side screen (empty; origin = surface centre, +Z faces the viewer, `width` default 2.4) — or scene.json `soloScreens` |
| `CAM_WIDE`, `CAM_REACT`, `CAM_*` | glTF cameras (vertical fov, default 35). `CAM_REACT` frames the screen at ~80 % of the width. `CAM_DOOR` is used by the entrance follow cam |
| `LIGHT_*` | fixtures: `group` (e.g. neon, spots, lamps, sign), `color` (hex), `kind` (`spot`/`point`/`emissive`); optional `range`, `intensity`, `angle`, `penumbra`, `target` [x,y,z]; night: `nightOn`, `nightThreshold`, `nightStagger`, `flicker`, `nightFade`, `nightDay`, `poolRadius` |
| material `EMIT_<group>` | emissive material the light engine modulates (`EMIT_neon.001` → group `neon`); MeshStandard |
| `COLLIDE_*` | simple box meshes walkers avoid (hidden; boxes taller than 0.9 m ignored; inflated 0.2 m) |
| `FX_BEAM_xx`, `FX_LASER_xx`, `FX_BALL` | effects-rig anchors (or scene.json `lightRig`) |
| `CHAT_MONITOR[_xx]`, `CHAT_BOARD[_xx]`, `CHAT_BUDDY[_xx]` | chat monitor / support board / Sprocket spot (origin = display centre, +Z to camera, `width`); or scene.json `chatMonitors` / `chatBoards` / `chatBuddy` keyed by `SPOT_xx` |
| `GOAL_BOARD[_xx]` | the GOALS board (goals + subathon timer; 16:9, `width` default 1.6 m); or scene.json `goalBoards` keyed by `SPOT_xx`; falls back to the chat board spot; it never covers a live timer display (it winches up in a shot where it would hang in front of one) |
| `TIMER_DISPLAY[_xx]` | a mesh with UVs that shows the live subathon countdown (big `H:MM:SS`, `+10:00` pop, happy hour / hype / sleep / paused badges) drawn onto its UVs; use a flat plane with a normal unwrap; extras `style` (`digits`/`neon`/`lcd`), `color`, `show` (`remaining`/`uptime`/`both`), `label`, `fit` (0.3 to 1, default 1: shrinks the panel + digits about the centre; about 0.8 when the plane is wider than the glowing thing it sits behind), `glass` (0.5 to 1: panel opacity); or scene.json `timerDisplays: [{"node": "<mesh name>", ...}]` on an existing mesh; nothing is drawn while no subathon runs |
| `SOLO_SKIN`, `CHAT_MONITOR_SKIN`, `CHAT_BOARD_SKIN`, `*_SKIN` | own screen-rig housings (templates; child `*_RECT` = picture bounds, `*_FIXED` = stays put) |
| `DOOR_LOCKED` / `DOOR_UNLOCKED` | optional LEDs following the door |
| any node with extras `hiddenUntilBroken: true` | hidden at load |
| `*_LOD0` / `*_LOD1` / `*_LOD2` siblings | shown by projected size; a lone `*_LOD0` (e.g. `DETAIL_LOD0`) = optional detail hidden on Performance |

### 10.3 Optional systems (all additive — see docs/SCENES.md for every extra)
- **Background combat (raid)**: `BG_NAV_xx` (`links`, `cover`), `BG_COVER_xx` (+Z faces the threat; `stance`,
  `role: pmc_ambush|guard`), `BG_LOOT_xx` (`kind` crate|jacket|weapon_box|safe|filing_cabinet|med),
  `BG_SPAWN_xx` / `BG_EXIT_xx` (`nav`, `bodyDump`), `BG_ZONE_xx` (mesh box or empty; `keepOut`), `BG_GLASS_xx`,
  `PATROL_PATH_xx` (`formation` file|column|wedge, `width`), `PATROL_PAUSE_xx` (`at`, `seconds`, `lookAt`,
  `guardSlots`, `action`), `CAM_RAID_xx`, `EVENT_TAGILLA_ENTER/EXIT/ROAR/PATH_xx/STRIKE_xx`, `SMASH_xx` with
  `SMASH_xx_intact` + `SMASH_xx_piece_*`. scene.json `raid {factions, npcHeight, donationEvent, boss, patrol,
  tagillaSightline, tagilla, bigEvent}`. Keep every BG_* point **behind the performers**.
- **Space**: `SPACE_VIEW`, `SPACE_PLANET`, `SPACE_MOON`, `SPACE_SUN`, `SPACE_SHIP_xx`, `SPACE_LANE_xx`,
  `SPACE_WARP_xx`, `SPACE_ENEMY_APPROACH_xx`, `SPACE_CANNON_xx`, `SPACE_BATTLE_xx`, `SPACE_ZONE`,
  `SPACE_KEEPOUT_xx`, own meshes `PLANET` / `SPACE_SKY` / `MOON` / `SPACE_FLEET`; cryo join `CRYO_POD_xx`
  (+`_door`, `_out`), `JOIN_PATH_xx`, `CAM_CRYO`; drop-pod leave `DROP_POD_xx` (+`_hatch`, `_board`),
  `LAUNCH_TUBE_xx`, `LEAVE_PATH_xx`, `CAM_DROPBAY`, `CAM_VIEWPORT`. scene.json `space {...}`, `entrance: "cryo"`,
  `exit: "droppod"`. Emissive `EMIT_alert` / `EMIT_alarm` pulse on red alert.
- **Town (living harbour)**: scene.json `town`; anchors `BOB_*`, `SWAY_*`, `SHIPLANE_xx`, `WAVE_BREAK_*`, `PERCH_*`,
  `FX_EMBERS_*`, `FX_MOTES_*`, `FX_SMOKE_*`, `TOWN_NAV_*`, `TOWN_POI_*`, `TOWN_HOME_*`, units `UNIT_<id>`
  (+`_LOD1`) / `PROP_<id>` — see `assets/scenes/poe2_kingsmarch/README.md`.
- **Environment (time of day + weather)**: scene.json `"environment": {}` minimum; `sky`, `climate`, `north`,
  `sunrise`/`sunset`, `default`, `night`, `nightLights`, `windows` (`EMIT_<group>` facades, mode world|uv),
  `puddles`, `dry` boxes or `ENV_DRY_*` nodes, `bakedAt` + `sun: 0` for rooms baked at one time of day.
  Materials `M_Sky*`/`GFX_SKY*`/`SKY_*` (sky), foliage/cloth names sway (put mesh origins at the base / pole side).
- **Graphics tiers**: `gfx.hdri` (`small_harbour_sunset`, `belfast_sunset_puresky`, `empty_warehouse_01`,
  `hospital_room_2`, `rogland_clear_night`, `fireplace`, `abandoned_factory_canteen_01`), `gfx` look overrides
  (grade, bloom, haze, rim, reflect, shafts, dof …), water materials `M_Sea`/`M_Water`/`GFX_WATER*`, sky `M_Sky`.
- **Screen skins**: `"screenSkin": "studio"|"scrying"|"hologram"|"terragroup"|"tarp"|"bedsheet"` or an object
  with `theme` / `node` / `motion` (drop|rise|unroll|swing|hologram|shimmer) / `powerOn` (crt|hologram|shimmer|fade)
  / per-prop `solo`, `monitor`, `board`.
- **Sky traffic**: scene.json `traffic` (see `assets/scenes/sc_area18/README.md`).
- **Areas (several locations in one room)**: scene.json `areas {<key>: {name, label, icon, bounds, …overrides}}` +
  `defaultArea`; every node of an area is named `<AREA>__<name>` (`BAR__SPOT_01`, `BAR__CAM_WIDE` …) and the page strips
  the prefix of the loaded area / drops the others — each area is a full room (spots, cameras, door, screen, chat
  anchors) with its own id `<room>~<area>`. Reference: `assets/scenes/sc_890jump` (docs/SCENES.md → Areas).
- **Yacht life (crew, drinks, fireworks, flybys, fleets)**: scene.json `yacht` + `YACHT_SERVICE` / `YACHT_BAR` /
  `YACHT_POUR` / `YACHT_DRINK_xx` / `YACHT_ROUTE_<X>_nn` / `YACHT_SKY_nn` / `CAM_EXTERIOR` (docs/SCENES.md → Yacht life).
- **Interview mode (talk show)**: scene.json `interview` (all optional: `theme`, `host` spot, `desk` "room" / "none" / place,
  `monitor` {style, width, position, yaw, side}, `guests` spots, `sidekick` {stand, position, yaw}, `shots`) — without it the
  desk / guest monitor / sidekick are placed automatically from the host's chair (docs/SCENES.md → Interview mode).

### 10.4 scene.json [shared/types.ts `SceneInfo`]
```json
{
  "id": "my_room",
  "name": "My Room",
  "model": "scene.glb",
  "modes": ["talk", "react"],
  "defaultCamera": "CAM_WIDE",
  "ambience": { "background": "#15171c", "fog": "#15171c", "fogNear": 9, "fogFar": 26, "exposure": 0.8 },
  "avatarHeight": 1.5,
  "lights": { "programs": ["steady", "show"] }
}
```
`background` omitted = transparent; `exposure` (0.1–3) scales room material colours (not `EMIT_*`); the stage
lights are tuned for the toon avatars, so darken the room here rather than dimming the avatars. `id` always
comes from the folder name. Also read: `soloScreens`, `screenSkin`, `raid`, `space`, `entrance`, `exit`,
`environment`, `gfx`, `hdri`, `lightRig`, `town`, `traffic`, `chatMonitors`/`chatBoards`/`chatBuddy`, `spotSizes` /
`sizeSpots` / `autoSizeSpots` (size-class spots: fairy perches, a giant's back-row place). If a
build script regenerates scene.json, it must **keep hand-added keys**.

### 10.5 Lighting and budgets
- The engine turns **room shadows off**: bake AO, gradients, light spill and the sun into vertex colours
  (`COLOR_0`, multiplied automatically) or textures. Don't export punctual lights; mark fixtures with `LIGHT_*`
  (`kind: spot|point` become real lights within the budget: low 0 / medium 2 / high 3 / ultra 4, spots first).
  Everything else = animated `EMIT_<group>` materials.
- Room budget (shipped rooms): **≤ 80k visible triangles, ≤ 25 MB GLB**, ≈ 170–180 draw calls, 2048² atlases +
  1024² tiling textures. Kilometre-scale exteriors: compress far geometry toward the viewer (depth precision),
  `gfx.haze.density` ≈ 0.0005.
- Use CC0 set dressing from `assets/library/props/*` (docs/ASSET_LIBRARY.md); restyle to the room's toon ramp.

### 10.6 Room lessons (checklist)
- [ ] Every prop faces the right way (+Z = front; armchairs/stools turned toward the action). Check in the engine.
- [ ] **Nothing blocks the react screen, the solo screen or a performer's face from any camera**: sample
      sightlines (corners, edges, centre of each screen; each spot's face) from CAM_WIDE, CAM_REACT, every
      SPOT_xx_CAM and the automatic talk cameras. Factory once had a desk radio + lamp poking into the solo
      two-shot; the DJ booth hides short avatars at Studio SPOT_09.
- [ ] Performers are not in shadow: keep lamps/fixtures from putting faces in the dark; don't bake dark gradients
      over the spots.
- [ ] Spots behind desks/bars/armchairs have `approach` + `leavePathAt` so walks don't clip furniture; floors at y = 0.
- [ ] Landmarks come from references (the room must read as the place in one glance); original homage designs only
      — no game files, logos or textures.
- [ ] Solo screen / chat props sit on the side away from raid/event zones; BG_* stays behind performers.
- [ ] **Test every camera in the engine after every build stage**, not only at the end.

### 10.7 Minimal working room (template)
Save as `assets/scenes/my_room/blender/build_my_room.py` and run
`tools\blender_low.cmd -b --factory-startup --python assets/scenes/my_room/blender/build_my_room.py`.
It writes `scene.glb` + `scene.json` one folder up. Modelled on `assets/scenes/test_room/build_test_room.py`
(read that for more fixtures: armchairs, stools, DJ desk, spot lights).

```python
"""Minimal VTube Pro room: shell, door, path, 3 couch spots + 2 stand spots, react screen, lights, cameras."""
import json, math, os
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOM = os.path.dirname(HERE)                     # assets/scenes/my_room
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

def srgb(h):                                     # hex -> linear (glTF colour factors are linear)
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)

MATS = {}
def mat(name, hex_, rough=0.8, emit=None, strength=1.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*srgb(hex_), 1); b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*srgb(emit), 1); b.inputs['Emission Strength'].default_value = strength
    MATS[name] = m; return m

def box(name, center, size, material, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=center); o = bpy.context.active_object
    o.name = name; o.scale = size; bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(material)
    if parent: o.parent = parent
    return o

def empty(name, loc, yaw_deg=0.0, **props):
    """yaw 0 = faces stage front (Blender -Y = glTF +Z); + = turned toward +X. props -> glTF extras."""
    o = bpy.data.objects.new(name, None); o.empty_display_type = 'SINGLE_ARROW'
    o.location = loc; o.rotation_euler = (0, 0, math.radians(yaw_deg))
    for k, v in props.items(): o[k] = v
    scn.collection.objects.link(o); return o

def camera(name, loc, target, fov_deg=35.0):
    cd = bpy.data.cameras.new(name); cd.sensor_fit = 'VERTICAL'; cd.angle_y = math.radians(fov_deg)
    cd.clip_start, cd.clip_end = 0.05, 100
    o = bpy.data.objects.new(name, cd); o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    scn.collection.objects.link(o); return o

# ---- shell: 8 x 6 x 3.4 m, open front (Blender -Y), door in the left wall
W, D, H = 8.0, 6.0, 3.4; X0, X1, YB, YF = -W / 2, W / 2, D / 2, -D / 2
wall, floor = mat('Wall', '#6f7c8a'), mat('Floor', '#8a6b4e', 0.6)
box('Floor', (0, 0, -0.05), (W, D, 0.1), floor)
box('Ceiling', (0, 0, H + 0.05), (W, D, 0.1), mat('Ceiling', '#9aa3ad'))
box('WallBack', (0, YB + 0.05, H / 2), (W, 0.1, H), wall)
box('WallRight', (X1 + 0.05, 0, H / 2), (0.1, D, H), wall)
DY, DW, DH = -1.5, 1.0, 2.1; lo, hi = DY - DW / 2, DY + DW / 2
box('WallLeftA', (X0 - 0.05, (YF + lo) / 2, H / 2), (0.1, lo - YF, H), wall)
box('WallLeftB', (X0 - 0.05, (hi + YB) / 2, H / 2), (0.1, YB - hi, H), wall)
box('WallLeftTop', (X0 - 0.05, DY, (DH + H) / 2), (0.1, DW, H - DH), wall)
box('Hallway', (X0 - 1.0, DY, -0.05), (2.0, 1.6, 0.1), floor)

# ---- DOOR: origin = hinge, leaf extends toward the front, rotates about local Z (glTF +Y)
bpy.ops.mesh.primitive_cube_add(size=1); leaf = bpy.context.active_object
leaf.name = 'DOOR'; leaf.scale = (0.05, DW, DH); bpy.ops.object.transform_apply(scale=True)
for v in leaf.data.vertices: v.co.y -= DW / 2; v.co.z += DH / 2
leaf.location = (X0 - 0.05, hi, 0); leaf.data.materials.append(mat('Door', '#7a4a2a')); leaf['openAngle'] = 95.0
empty('DOOR_OUTSIDE', (X0 - 1.2, DY, 0), yaw_deg=90)          # faces into the room (+X)
empty('PATH_01', (X0 + 0.7, DY, 0)); empty('PATH_02', (-1.5, -0.4, 0)); empty('PATH_03', (0, -0.2, 0))

# ---- couch (seat 0.45 m) against the back wall + its spots; stand spots in front
couch = mat('Couch', '#3f7f5a', 0.9); CY = 2.3
box('CouchBase', (0, CY + 0.05, 0.2), (3.3, 0.9, 0.4), couch)
box('CouchBack', (0, CY + 0.45, 0.72), (3.3, 0.22, 0.65), couch)
box('COLLIDE_Couch', (0, CY + 0.05, 0.3), (3.3, 0.9, 0.6), couch)   # walkers route around it (hidden)
for i, x in enumerate((-1.0, 0.0, 1.0)):
    empty(f'SPOT_{i + 1:02d}', (x, CY - 0.05, 0), pose='sit', seatHeight=0.45, seatDepth=0.55,
          label=['Couch left', 'Couch middle', 'Couch right'][i])
empty('SPOT_04', (-1.3, -1.25, 0), yaw_deg=12, pose='stand', label='Stand left')
empty('SPOT_05', (1.3, -1.25, 0), yaw_deg=-12, pose='stand', label='Stand right')

# ---- react SCREEN: 3.2 x 1.8 (16:9) plane on the back wall, facing Blender -Y (glTF +Z); rests 2 m up
SW, SH, SZ = 3.2, 1.8, 1.98
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, YB - 0.04, SZ), rotation=(math.radians(90), 0, 0))
scr = bpy.context.active_object; scr.name = 'SCREEN'; scr.scale = (SW, SH, 1)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
scr.data.materials.append(mat('ScreenSurface', '#050505', 0.3)); scr['restOffsetY'] = 2.0

# ---- lights: an emissive neon strip (group neon) + a point-light lamp (group lamps)
neon = box('LIGHT_NEON_01', (0, YB - 0.03, H - 0.3), (6.0, 0.04, 0.04),
           mat('EMIT_neon', '#39ff88', 0.4, emit='#39ff88', strength=3.0))
neon['group'], neon['color'], neon['kind'] = 'neon', '#39ff88', 'emissive'
lamp = box('LIGHT_LAMP_01', (3.4, 1.8, 1.6), (0.35, 0.35, 0.3), mat('EMIT_lamps', '#ffd9a0', emit='#ffd9a0', strength=2.5))
lamp['group'], lamp['color'], lamp['kind'] = 'lamps', '#ffd9a0', 'point'

# ---- cameras (look down -Z). CAM_REACT: vfov 35 -> 16:9 hfov 58.6; screen at 80% width -> d = 3.57 m
camera('CAM_WIDE', (0, -6.2, 1.75), (0, 0.6, 1.0), 38)
camera('CAM_REACT', (0, YB - 0.04 - 3.57, SZ), (0, YB, SZ), 35)
camera('CAM_DOOR', (X0 + 2.5, -3.2, 1.7), (X0, DY, 1.2), 40)

# ---- export (+ scene.json that keeps hand-added keys)
bpy.ops.export_scene.gltf(filepath=os.path.join(ROOM, 'scene.glb'), export_format='GLB', export_yup=True,
                          export_extras=True, export_cameras=True, export_lights=False, export_apply=True,
                          export_materials='EXPORT', use_selection=False)
sj = os.path.join(ROOM, 'scene.json')
info = json.load(open(sj, encoding='utf-8')) if os.path.exists(sj) else {}
info.update({'id': os.path.basename(ROOM), 'name': info.get('name', 'My Room'), 'model': 'scene.glb',
             'modes': ['talk', 'react'], 'defaultCamera': 'CAM_WIDE', 'avatarHeight': 1.5})
info.setdefault('ambience', {'background': '#15171c', 'fog': '#15171c', 'fogNear': 9, 'fogFar': 26, 'exposure': 0.8})
info.setdefault('lights', {'programs': ['steady', 'show']})
json.dump(info, open(sj, 'w', encoding='utf-8'), indent=2)
print('room written ->', ROOM)
```

### 10.8 Testing a room (never on the live bus)
- `output.html?sceneTest=<id>&cam=wide|group|talk|react|CAM_x&mode=react&spot=1..12&extra=frog,robot&screen=placeholder`
  (`extra` = library avatars as stand-in guests). Hidden tabs pause rAF: draw frames with `vtpOut.step(n, dt)`.
- Systems: `&beatDemo=128` (lights), `&raid=hot&raidSeed=7&raidAt=<s>`, `&space=hot&spaceSeed=7`,
  `&env=h19.2,storm`, `&chat=monitor,panel,buddy,goal`, `&gfx=high`, `&tier=low`.
- Console: `vtpOut.scene`, `vtpOut.debugScene(state)`, `vtpOut.lights()`, `vtpOut.raid.debug()`,
  `vtpOut.space.debug()`, `vtpOut.env.debug()`, `vtpOut.town.debug()`; walks: `vtpOut.scene.mover.manual = true`.
- An `?observer=1` studio's Scene tab is a sandbox (never saved or sent). Close test tabs when done.

## 11. Animation and NPCs
- **Library** (docs/ANIMATION_LIBRARY.md): CC0 Quaternius UAL + CC-BY 100STYLE retargeted by
  `tools/retarget/retarget.py` (world-delta-from-rest method) into `assets/library/anims/npc/*.json` (raid/town
  NPC clips: `ual_*`, `style_*_walk|idle`) and `assets/library/anims/vrma/*.vrma` (avatar emotes). Rebuild:
  `tools\blender_low.cmd -b --factory-startup --python tools/retarget/retarget.py -- tools/retarget/retarget.json`.
- **Avatar emotes**: VRMA (VRM Animation 1.0, T-posed humanoid, 30 fps) on VRM + humanoid-mapped rigs; the head
  keeps 65 % of face tracking. Command `emote {name, loop?}` / `{stop:true}`. Built-ins: dance, yes, idle_no,
  idle_fold_arms, idle_talking, idle_talking_phone, consume, punch_jab, spell_simple_shoot, idle_rail_call, interact.
- **NPC skeleton** (raid + town, 20 bones): Hips, Spine, Chest, Neck, Head, Shoulder_L/R, UpperArm_L/R,
  LowerArm_L/R, Hand_L/R, UpperLeg_L/R, LowerLeg_L/R, Foot_L/R, Gun (prop socket). New NPC bodies must use it
  (or be added to the retarget map). LOD: `UNIT_<id>` + `UNIT_<id>_LOD1` on the same skeleton; ink outlines as an
  inverted hull with `_ONORMAL`.
- **Determinism / sync rules** (raid, space, town, traffic, environment, walks): every page (studio preview, each
  OBS page, each party guest) computes the same thing from **room data + host-stamped seed/epoch/events + wall
  clock**, with no per-frame messages. So: no `Math.random()` in plans (use the seeded hash), no dependence on
  frame rate or the camera in the simulation (only rendering may look at the camera), events are stamped by the
  host (`{k, at, id}`), and a page opened mid-event must land mid-event. Keep per-frame cost ≤ ~1 ms (spread
  planning over frames), pre-compile shaders on attach, and fade anything that would cover a face or the react screen.

## 12. Driving the app: MCP, REST, bus, OBS

### 12.1 MCP server (`server/mcp.ts`, stdio; registered as `vtube-pro` in `.mcp.json` / `.codex/config.toml`)
Needs the app running (`npm run dev`). ⚠ = changes what the user sees or writes their library — only when asked.
| tool | effect |
|---|---|
| `get_docs` | the guide index + house rules; `{topic, section?}` returns a guide (`creator` = this one, `avatars`, `environments`, `connect`, `scenes`, `blender`, `faces`, `examples`, `performance`) or the matching `##` / `###` sections |
| `get_creator_guide` | returns this guide (optional `section`: a heading word, e.g. `rooms`, `mouth`, `review`; `doc` picks another guide) |
| `status` | Blender / ComfyUI |
| `list_avatars`, `get_avatar`, `list_costumes` | read-only |
| `render_avatar` | Blender renders (views front/left/right/back/three_quarter/top) returned as images — safe preview |
| `get_diagnostics` | latest `camera.jpg` (640 px), the newer of `stage.jpg` (960 px wide) and `stage.png` (full resolution from `request_diagnostics`, or an older studio's), `state.json` from the live studio, uploaded every 3 s while the camera tracks (read-only) |
| `request_diagnostics` | broadcasts `diag` (harmless upload, but it is a bus command); waits for and returns a fresh full-resolution `stage.png` (usually ~1 s, at most ~4 s) |
| `blender_run_python` | headless bpy; outputs in `os.environ["VTP_OUT"]`; ⚠ with `saveAs` it creates a library avatar |
| ⚠ `update_avatar` | deep-merge + save a profile → the live studio and OBS reload it |
| ⚠ `set_costume` | switches the costume live |
| ⚠ `import_model`, `generate_avatar` | writes a new avatar into `library/` |
| ⚠ `import_costume` | writes a costume (it is not worn until `set_costume`) |
| ⚠ `autorig` | job that rigs an avatar |
| ⚠ `send_command` | broadcast to every page incl. the live studio and OBS |
Rooms, packages and validation tools: docs/mcp.md. Resources: `vtube-pro://docs/AI_CREATOR_GUIDE.md` (this file), one per
guide (`vtube-pro://docs/ARTIST_AVATARS.md` …), `vtube-pro://rules/house`, `vtube-pro://contract/room`,
`vtube-pro://contract/avatar`, `vtube-pro://recipes/one-shot`, `vtube-pro://recipes/room-template`, `vtube-pro://recipes/review`.

### 12.2 REST (server `:5191`)
`GET /api/status`, `GET /api/avatars`, `GET|PUT|DELETE /api/avatars/:id` (DELETE moves it to library/.trash; `POST /api/avatars/:id/restore {from?}` brings it back), `POST /api/avatars/import?filename=&name=`
(raw body), `GET /api/avatars/:id/costumes`, `POST /api/avatars/:id/costumes/import`, `POST /api/avatars/:id/render`,
`POST /api/avatars/:id/autorig`, `POST /api/blender/run`, `POST /api/generate`, `GET /api/jobs/:id`,
`GET /api/scenes`, `GET /api/scenes/:id/file/*`, `GET|PUT /api/scene` (host scene state → OBS + guests),
`POST /api/scene/lighting {state}`, `GET /api/diag`, `GET /api/diag/:name`, `POST /api/command {command, args}`.

### 12.3 Bus commands (`POST /api/command` or MCP `send_command`) [src/app.ts `onCommand`]
`load {avatarId}` · `expression {name, seconds}` or `{face:{<ARKit>:v}, seconds}` · `focus {focus: full|bust|head}` ·
`screenshot` · `rebuild` · `diag` · `gesture {kind, side}` · `recordClip` · `costume {id|null}` ·
`accessory {id, on}` · `scene {camera?, mode?, sceneId?, focus?, lighting?, raid?, space?, env?}` ·
`emote {name, loop?} | {stop:true}`. Expression presets: Neutral, Talk, Smile, Big grin, Surprised, Angry, …
(`TEST_EXPRESSIONS` in src/app.ts). **All of these reach the live studio.**

### 12.4 OBS
OBS loads `http://127.0.0.1:5191/output.html` from `dist/` (`?focus=bust|head|full`, `&avatar=<id>` pins one,
`&fps=30`). Client changes reach OBS only after `npm run build` — only when the user asks. The output locks onto
one publisher; a second studio tab fights it.

## 13. One-shot recipes

### (a) Anime girl VTuber from a reference image
1. Study the reference (current official art if it's an existing character): hair silhouette and colours, eye
   colour/shape, outfit, accessories. Write the measurements down (FACE_CREATION §1 ratios).
2. Pick the base: VRoid CC0 female sample closest in hair length/body (`Sendagaya_Shino`, `HairSample_Female`, …).
   Start from a preset (`blender/anime_creator/presets/anime_*.json`, `face_kit/presets/gacha_girl.json` or
   `vtuber_girl.json`); set colours, face shape, eye scale.
3. Build: `python blender/face_kit/anime_face.py <preset> <out_dir>` (or `anime_creator/build.py <params.json>
   <out_dir>`). You get `<id>.vrm` + `profile.json`. Faces are repainted as vector marks at 2× VRoid resolution with
   proxy normals and crisp MToon — **don't hand-paint over it with projected pixels**.
4. Hair: if the base hairstyle isn't right, build it with `blender/anime_hair` (`fit.py <vrm> none <p> geo=1`
   → `locks()` spec in 5 layers → iterate `fit.py` → `export=`). Clumps, proxy normals, angel ring, one spring
   group per layer.
5. Outfit: `costume_kit` costumes or VRoid garments; accessories as `kind:'accessory'`.
6. Mouth: VRoid mouth with a crisp closed line; drawn teeth; verify PP seal, OO round, FF tuck, L tongue.
7. Review (section 9): `tools/review_character.py` → PASS; app-renderer sheet at 8+ angles + visemes + blink;
   side-by-side with the reference; fix the 3 biggest differences; repeat.
8. Deliver the folder to the user (or `assets/builtin/<id>/` in a source checkout, if they want it shipped with the app); import only when asked.
   The human creator (`blender/human_creator/build.py`) builds in the temp folder (`<temp>/vtp_human/<id>/out/`) when it runs from a
   release. Import it with `import_model` on the `.glb` there: the `profile.json` next to it (eye and mouth anchors, hair chains,
   tracking) and its `costumes/*.glb` come along as the user's own, and the answer's `carried` lists what arrived and any outfit
   that did not. `import_model` on a plain model file brings the model only.

### (b) Creature / mascot (Sprocket, one model)
1. Design sheet from the reference: silhouette, where the eyes are (a frog's sit ON TOP of the head), mouth type.
2. Script the whole build (one command, reproducible): body as implicit/SDF shape sampled on a grid, **face grid
   with the mouth seam split into upper/lower lip rows closed by a watertight mouth bag**, lower lip/chin/tongue
   weighted to a `jaw` bone (child of `head`), ARKit mouth shape keys as warps in the surface's own parameter
   space (lips slide ON the head; upper and lower lip move identically except in shapes that part them → no
   crossing lips), no teeth (or drawn teeth), texture painted as a function of 3D position (flat cel tones,
   anti-aliased marks). See `build_frog_v2.py` and an internal build.
3. Rig with VRM bone names; extra bones for hat/tail/antennae/wings get spring chains by name.
4. Eyes: `bulb` procedural eyes with markers on the head, or modelled eyes with `leftEye`/`rightEye` + blink shapes.
5. profile.json: `mouth.mode:'model'` + `rig {kind:'jaw', jawBone:'jaw', openAngle}` (or procedural mouth),
   jiggle for the belly, chains for the hat, `look.shading:'anime'`.
6. Costumes with `costume_kit` against the same armature (frog_v2 kept v1's bones so every v1 costume fits).
7. Review as in section 9 (visemes especially: PP seal and O/U round on a wide frog mouth).

### (c) Themed room
1. Collect references; list the 3–5 landmarks that make the place recognisable. Plan the stage: where the host
   sits, where guests sit, where the react screen and solo screen go, camera positions — **before modelling**.
2. Start from the template (10.7): shell, door + DOOR_OUTSIDE + PATH_*, spots (sit/stand, seatHeight, approach),
   SCREEN, CAM_WIDE / CAM_REACT / CAM_DOOR / SPOT_xx_CAM. Export and **test in the engine now**
   (`output.html?sceneTest=<id>&extra=frog,robot`, every camera, walk-ins).
3. Block in the landmarks and furniture; add COLLIDE_* boxes and `approach` points; re-test walks and sightlines.
4. Detail pass within budget (≤ 80k tris, ≤ 25 MB): CC0 props from `assets/library/props`, texture atlases,
   baked vertex-colour lighting (no shadows at runtime), `LIGHT_*` + `EMIT_<group>` fixtures, LODs.
5. Optional systems: environment, raid anchors, screen skin, HDRI, chat anchors — each tested with its URL param.
6. Sightline check from every camera (screens + faces), props facing the right way, faces not in shadow.
7. `preview.png` (1280×720 from CAM_WIDE) + `thumb.png`; README with the contract used and the budget.

## 14. Hard-won lessons (what failed and why)
| failure | cause | rule |
|---|---|---|
| 3D teeth looked horrible (Grumpy Frogsuit Uncle) | modelled teeth geometry | teeth are a flat drawn band, always |
| Aosabi v1 face = blotchy mush | a ~60 px reference crop projected onto the mesh; judged by silhouette IoU | draw vector faces at 2K; judge by eye in the app |
| Aosabi v5 "still sucks" | reviews used only front/3-4 face crops: missed stripey hair ribbons, noisy beard, floating strap, suit smears | 8+ angles incl. both profiles + full bust + automated detectors |
| Procedural from-scratch anime characters "atrocious" | no proper base topology | VRoid CC0 bases / face_kit only |
| Meshy/Tripo humans | triangle soup, baked light, no loops | AI mesh = sculpt reference only |
| Nux remake drifted from the real character | an AI turnaround sheet invented features | the character's current official art is the primary reference |
| "Mouth reads open" / "sleeves flare" in reviews | the observer tab received the user's live tracking | freeze the tab's frames before capturing |
| OBS "keeps changing and spazzing out" | a test tab saved costumes / loaded avatars; a second (non-observer) studio fought the real one | observer-only testing, never save profiles or send commands |
| Hidden observer tab slowed live face tracking (48 → 9 ms once closed) | background worker ticks at 60 Hz | close test tabs immediately |
| Lash line turned into a black blob on blink | thick line painted on the lid skin | thin lash line straddling the lid margin |
| Eyepatch rendered mid-grey | sRGB value written into a linear colour factor | convert to linear |
| Painted strap kinked with browDown | rigid prop rode the skin morphs | rigid ribbon / membrane cap, morphs zeroed |
| Terminator blotches on nose/hair/beard | shading from raw mesh normals | proxy normals |
| Helmet-like hair | MakeHuman card hair recoloured flat | clumped hair toolkit |
| Black blobs through mouth/nostril holes | outline hull visible through hidden cavity triangles | cavity tris → flat double-sided materials |
| Shoe crushed to one triangle | Decimate ratio applied to the whole mesh | keep a share of heavy parts per vertex group |
| Right arm of a Mixamo rig doesn't track | bone-name matcher bug with `Right*` names | exact VRM bone names |
| Desk radio in the solo two-shot (Factory) | prop in the screen sightline | sample sightlines per spot from every camera |
