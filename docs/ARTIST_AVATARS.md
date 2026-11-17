# 3D avatars for artists

This guide is for anyone who makes a 3D character for VTube Pro. That includes outfits and accessories for it. You can
use VRoid Studio, Blender, Maya, 3ds Max, Character Creator, or anything that saves `.vrm`, `.glb` or `.fbx`.

How to read it:

- **New to 3D?** You don't have to start here. The easiest ways: [Avatars: the easy way](AVATARS_SIMPLE.md), or let
  an AI build it with [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md). Want to make one yourself?
  Read section 1 (the words) first. Then follow section 14 (VRoid Studio, the easiest) or section 15 (Blender). Use
  section 0 at the very end, as a checklist. Don't worry if some words in it are new.
- **An artist?** Every rule has its exact numbers and names. Skip to the section you need.
- **Just want to add a finished model?** Read [Avatars: the easy way → Add my model](AVATARS_SIMPLE.md#add-my-model) instead.

Numbers marked *recommended* are our advice. Every other number is a real limit in VTube Pro.

| For | Read |
|---|---|
| Adding a model with the buttons, step by step | [Avatars: the easy way → Add my model](AVATARS_SIMPLE.md#add-my-model) |
| Avatars without the technical part | [Avatars: the easy way](AVATARS_SIMPLE.md) |
| A tutorial with a small Blender script | [Avatars by hand](AVATARS_ADVANCED.md) |
| Anime face proportions, eyes and cel shadows | [Face creation](FACE_CREATION.md) |
| Picking the best lip sync for a model | [Best lip sync for me](LIP_SYNC.md) |
| Getting Blender (free) | <https://www.blender.org/download/> |
| Letting Claude or Codex build it for you | [Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md) |
| Rooms instead of characters | [For 3D artists: rooms](ARTIST_ENVIRONMENTS.md) |

Contents: 0 The short version · 1 Words and routes · 2 Files, size and scale · 3 The humanoid rig · 4 Face shapes and
lip sync · 5 Eyes · 6 Mouth and face rules · 7 Materials · 8 Hair and physics · 9 Costumes and accessories (outfits) ·
10 Budgets · 11 Thumbnails · 12 Test it in VTube Pro · 13 What the checker says · 14 VRoid Studio · 15 Blender ·
16 Other programs and formats · 17 With an AI app · 18 Where files live · 19 Sharing · 20 Troubleshooting.

---

## 0. The short version (quick checklist)

Tick every line before you call a model done.

Made it in VRoid Studio? VRoid already takes care of lines 1–6, 12 and 14. Just check line 11 and test it (line 15).

1. **One file.** Save a `.vrm` or `.glb` with the textures inside. Keep it under 300 MB.
2. **Real size in metres.** A human is about 1.5–1.8 m. Feet on the floor at the centre.
3. **Facing the front.** In Blender, the face looks at you when you press numpad 1 (or **View** → **Viewpoint** →
   **Front**). Blender's export turns it the right way for VTube Pro. (In the exported glTF file the character faces
   +Z with +Y up; in Blender it faces −Y with Z up.)
4. **Size and turn baked in.** In Blender, select everything (A), press Ctrl+A and pick **All Transforms**. Without
   this the model can come out tiny or huge. (Artists call this "transforms applied": no leftover scale or rotation on
   the armature or the meshes.)
5. **VRM bone names:** `hips`, `spine`, `chest`, `neck`, `head`, `leftUpperArm`, `leftLowerArm`, `leftHand` and so on.
   Mixamo, Unreal, Unity, Rigify, VRoid and Character Creator names are understood too.
6. **ARKit face shapes:** `eyeBlinkLeft`, `eyeBlinkRight`, `jawOpen`, `mouthClose`, `mouthSmileLeft` and the rest of
   the 52. Ten or more turns on full face tracking. VRM expressions work too.
7. **The face moves cleanly.** Blink closes fully. Lips seal for M, B and P. O and U are round. F tucks the lower lip.
8. **Anime mouths are carved into the face.** Teeth are a flat drawn band, never 3D teeth.
9. **The face is drawn, never projected.** Lines are warm dark brown, never pure black.
10. **Colour numbers (only if you type them in a script or file).** Using Blender's colour picker? Skip this line.
    glTF colour factors and Blender colour sockets are linear: convert sRGB hex first (section 7).
11. **Triangles:** at 37,000 or fewer (outfit included), friends in a party almost always see your real model. Up to
    200,000 is fine. More still works on your own stream.
12. **Swinging parts** are chains of bones with names like `Hair_Front_01 → Hair_Front_02 → Hair_Front_03`.
13. **Outfits** are separate `.glb` files on the same bones and the same rest pose as the model.
14. **No compression.** When you save from Blender, leave **Compression** unticked. (Draco and KTX2 are two kinds of
    file squeezing that VTube Pro can't open. Meshopt is fine.)
15. **Test it in VTube Pro** with **Add my model**. Aim for every line green. Check all 8 sides.

## 1. Words and routes

### Words you'll see

| Word | What it means |
|---|---|
| Model, avatar, character | The 3D file you stream as. |
| Mesh | The surface of the model: points joined into triangles. |
| Vertex | One point of the mesh. |
| Triangles | How detailed the model is. More triangles = heavier for the computer. See the count in Blender: open the **Overlays** menu (two overlapping circles, top right of the 3D view) and tick **Statistics**. **Add my model** shows it on its **Detail** line. |
| Topology | How the triangles are laid out. Good topology bends cleanly. |
| Modifier | A Blender "live effect" (Mirror, Subdivision) that isn't part of the mesh until you **Apply** it. |
| UV | How the flat texture picture wraps onto the model. A UV island is one piece of that wrap. |
| Normals | Which way each bit of surface faces. They decide the shading. |
| Atlas | Many small textures packed into one picture. |
| Draw calls | Separate pieces the graphics card draws one by one. Fewer is faster. |
| Export | Saving a copy in another format, like `.glb`. In Blender: **File** → **Export**. |
| Outliner | The list of parts at the top right of Blender. |
| Skeleton (rig, armature) | Invisible bones inside the model. Tracking moves the bones; the bones move the mesh. |
| Weights (skinning) | How much each bone moves each part of the mesh. A mesh with weights is "skinned". |
| Face shapes | Saved face poses, like "smile" or "blink". Also called blendshapes, shape keys or morph targets. |
| ARKit 52 | A standard list of 52 face shapes. Phone and webcam face tracking uses the same names. |
| Perfect sync | A model with 10 or more ARKit face shapes. VTube Pro then drives each one directly. |
| VRM | A model format made for VTubers (VRoid Studio saves it). Face, eyes and hair settings travel with it. |
| GLB / glTF | The standard 3D format. `.glb` is one file. Most 3D programs can save it. |
| MToon | The toon material inside VRM files. |
| Spring bones | Bones that swing by themselves: hair, skirts, tails, ears. |
| Rest pose | The pose the model is saved in (T-pose or A-pose). |
| Outfit, accessory | Extra `.glb` files worn on the model. Wear one outfit at a time, and any number of accessories. |
| Blender | A free 3D program. VTube Pro runs it for you to convert models and build outfits. |
| Party, host | Streaming together with friends. The host is the person who started the party. |
| `profile.json` | The settings file VTube Pro keeps next to each model. |

### Pick your route

| You have | Best route | What VTube Pro keeps |
|---|---|---|
| A VRoid Studio character | Save as VRM (1.0 or 0.x), then **Add my model** | MToon materials, VRM expressions, eye movement, VRM spring bones |
| A character you made and rigged | Save a `.glb` with VRM bone names and ARKit face shapes | skeleton, weights, face shapes, materials (turned into the toon look), glTF extras |
| A file from another program | Add the `.fbx` (or `.obj`, `.blend` …). VTube Pro converts it with Blender | skeleton, weights, face shapes, materials. Read section 2 first |
| A model with no skeleton | Add it, then let VTube Pro add a skeleton (**Re-rig with Blender**) | a new humanoid skeleton with automatic weights |
| An AI-made mesh (Tripo, Meshy, ComfyUI) | Use it for creatures, mascots and props, or as a sculpt reference | its shape; redo the topology (rebuild how its triangles are laid out) and paint for a real character |

House rule for people characters: start from a proper base. A good base is your own sculpt, or a VRoid model. Never
ship an AI mesh as a human, and never glue a human together from primitive shapes (plain balls, cubes and tubes).

## 2. Files, size and scale

### Formats

| File | What happens | Notes |
|---|---|---|
| `.vrm` (VRM 0.x or 1.0) | Opens as-is, also in the browser version | The best choice for VRoid characters |
| `.glb` | Opens as-is, also in the browser version | The best choice for everything else |
| `.gltf` | Packed into one `.glb` on import | Drop it with its `.bin` and textures (the folder or a `.zip`). Textures are found even when the paths in the file don't match |
| `.pmx` (MMD) | Converted to glTF in the studio | Drop the `.zip` or folder so the textures come along. Japanese bone names, D-bones and the あいうえお / まばたき morphs are matched. `.pmd`: save as `.pmx` in PMX Editor first |
| `.zip` | Unpacked in the studio | The best model inside is used (VRM first); textures, `.bin` and `.mtl` files beside it come along |
| `.fbx` | VTube Pro converts it to `.glb` with Blender | Needs Blender |
| `.blend` | Converted by Blender | Pack the textures first: in Blender, **File → External Data → Pack Resources** |
| `.obj` | Converted by Blender | Drop it with its `.mtl` and textures (folder or `.zip`) to keep the colours |
| `.dae` (COLLADA) | Converted by Blender | Blender 5 no longer reads COLLADA. Save FBX or glTF instead |
| `.stl` | Converted by Blender | No colours, no materials |
| `.ply` | Converted by Blender | No materials |
| `.usd`, `.usda`, `.usdc`, `.usdz` | Converted by Blender | |
| `.abc` (Alembic) | Converted by Blender | Shape only, no skeleton |

Any other file is refused. That includes 2D models (Pro2D, PNGTuber and models from other 2D apps), which go through the 2D importer.

Without Blender, only `.vrm` and `.glb` can be saved. Everything else needs Blender.

### What the conversion keeps and loses

When VTube Pro converts a `.fbx` or `.blend`, Blender:

- keeps the skeleton, weights, face shapes, animations and materials;
- does NOT apply modifiers. An unapplied Mirror or Subdivision is lost. Only the base mesh comes through;
- drops Blender custom properties. So material extras like `vtpShadeShift` (section 7) are lost.

So for full control, save the `.glb` yourself from Blender (section 15). Then nothing is converted.

### Compression

- Meshopt compression (`EXT_meshopt_compression`) works.
- Draco and KTX2 compression do NOT work on avatars. The model won't open.
- In Blender's glTF export window, leave **Data → Compression** off (that is Draco). If you use gltfpack, turn its
  **KTX2 Compression** off.

### Size limits

| Limit | Value |
|---|---|
| **Add my model** (`.vrm`, `.glb`, `.gltf`) | 300 MB. Over that: "This file is over 300 MB. Make a lighter version (fewer triangles, 2K textures), then try again." |
| Files VTube Pro converts with Blender | 500 MB upload. Conversion stops after 10 minutes |
| Browser version | 300 MB |
| One outfit or accessory | 300 MB, `.glb` only |
| Sharing your model in a party | 256 MB. Bigger files can't be sent to friends |

The file must really be a glTF file. A renamed or damaged file gets: "This file doesn’t look like a 3D model (it may be
damaged, or renamed)."

### Units and axes

- **Metres.** A human is about 1.5–1.8 m tall.
- **glTF:** +Y is up. The character faces +Z. Its left hand is on +X.
- **Blender:** Z is up. The character faces −Y. Blender's glTF export converts this for you (**+Y Up**, on by
  default).
- **Feet on the floor** (height 0), centred. VTube Pro also places non-VRM models on the floor by itself.
- **Apply all transforms** on the armature and every mesh (in Blender: **Ctrl+A → All Transforms**). A leftover
  armature scale is the most common reason for a tiny or exploded model.

### What VTube Pro fixes for you

Dropping a model on the studio (**Import a model**, docs/AVATARS_SIMPLE.md "Drop a model anywhere") fixes these in the
file it saves, and lists each fix with a switch under **Details**:

- **Z-up files** (lying down) are stood upright; **centimetres / millimetres / 1/100 scale** are scaled to metres
  (a root node in the saved `.glb`; VRM files are never rewritten).
- **Bone names** of any common scheme are matched to the humanoid and saved as `rig.boneMap` in `profile.json`.
- **Face-shape names** (CC `A01_…`, MMD, Oculus `viseme_…`, VRoid `Fcl_…` in a GLB) are saved as `faceMap`.
- **Old specular-glossiness materials** are turned into metal/rough; **missing textures** are looked for in the whole
  drop (other folders, other case, `.tga` swapped for `.png`).

Also:

- **Centimetres or millimetres:** detected and corrected on screen. Still, save in metres.
- **Facing away:** **Add my model** turns it around. It sets a turn in the model's settings; your file isn't changed.
- **VRM 0.x** is turned to face the front automatically.

The checker reads the height in the file's own units:

| Height in the file | What the checker thinks |
|---|---|
| Over 300 | Saved in millimetres |
| Over 30 | Saved in centimetres |
| Over 4 | "a giant, or exported at 10× scale?" |
| Under 0.02 | Saved at 1/100 scale |

### Real size (small and big characters)

Rooms seat characters by their real height. Normal-sized people need nothing. For a fairy or a giant, set the real
height: in **Add my model** (the **Size** step), or under **Me** → **📏 Real size**.

| Class | Real height | In a room |
|---|---|---|
| Micro | under 0.6 m | Sits on a table or perch |
| Small | 0.6–1.3 m | Normal seats, shown smaller |
| Normal | 1.3–2.1 m | Every normal person is shown at the room's height |
| Large | 2.1–2.6 m | Shown taller |
| Macro | over 2.6 m | Stands at the back of the room |

The **Size** step offers **A normal person**, **Tiny** (0.4 m), **Small** (1.1 m), **Big** (2.4 m) and **Giant**
(5 m). A typed height must be 0.03–100 m. In `profile.json` it is `"size": { "height": 0.4 }`.

### Rest pose

- T-pose, A-pose and creature poses all work. Each bone moves from its own rest direction.
- Knees bend forward. Hands open, fingers slightly spread.

## 3. The humanoid rig: skeleton and bones

The skeleton is what lets the head, arms and body follow the performer.

### The four kinds of model

| Kind | When | What moves |
|---|---|---|
| VRM | The file is a VRM | Everything the VRM has |
| Humanoid | A model with bones attached (weighted), whose bones include at least hips, spine and head | Head, body, arms, legs, fingers (when present) |
| Soft | No skin, or bones that don't look human | VTube Pro bends it with a made-up spine, neck and head. Arms don't move |
| None (static) | No skeleton at all | The model follows the head as one piece |

A soft or static model can get a real skeleton: see "Adding a skeleton" below.

### Bone names

Use the exact VRM humanoid names. They are case-sensitive and always work:

```
hips spine chest upperChest neck head jaw leftEye rightEye
leftShoulder leftUpperArm leftLowerArm leftHand          rightShoulder rightUpperArm rightLowerArm rightHand
leftUpperLeg leftLowerLeg leftFoot leftToes              rightUpperLeg rightLowerLeg rightFoot rightToes
leftThumbMetacarpal leftThumbProximal leftThumbDistal
```

Fingers: `leftIndexProximal`, `leftIndexIntermediate`, `leftIndexDistal`. Then the same three for Middle, Ring and
Little (`leftMiddleProximal` …). Then all of it again with `right` instead of `left`, thumbs included.

Other naming styles are mapped for you. We tested these on this version:

| Rig style | Example names | Result |
|---|---|---|
| Mixamo | `mixamorig:RightArm`, `RightForeArm`, `RightUpLeg`, `Spine1`, `Spine2`, `LeftHandIndex1` | Maps fully |
| Unreal | `pelvis`, `spine_01`…`spine_03`, `neck_01`, `clavicle_l`, `upperarm_l`, `lowerarm_l`, `thigh_l`, `calf_l`, `index_01_l` | Maps fully |
| VRoid | `J_Bip_C_Hips` and the other `J_Bip_*` names | Maps |
| Rigify, Character Creator (`CC_Base_`), 3ds Max (`Bip01`), Unity | | Mapped by rules |
| Eyes and jaw | `Eye_L`, `eye.R`, `Jaw` | Map to `leftEye`, `rightEye`, `jaw` |

Two edge cases:

- A leg made of ONE bone (like `Leg_L`) is read as the lower leg, not the upper leg. Give legs two bones.
- In a short chain `hips → Spine → Head`, the spine is also used as the neck. Add a `neck` bone.

If a rig has hips and head but no spine bones, the bones between them become the neck, spine and chest. A rig with
only a chest uses it as the spine.

### The rules

- **Required:** `hips`, `spine` and `head`. Missing chest or neck bones are filled in from the chain.
- **Order:** `hips → spine → chest → upperChest → neck → head`. Shoulders under the top spine bone. Legs under hips.
- **Fingers are optional.** For good finger tracking a hand needs `MiddleProximal`, plus `IndexProximal` and
  `LittleProximal` (`RingProximal` is used if Little is missing). Without finger bones the hands stay open.
- **Eyes:** `leftEye` and `rightEye` bones at the centre of each eyeball turn for gaze (section 5).
- **Jaw:** a `jaw` bone under `head` opens the mouth when the model has no mouth shapes (section 6).
- **Weights:** at most 4 bones per vertex (a vertex is one point of the mesh), normalised (each point's weights add
  up to 1), no vertex left with no weight. In Blender: select the mesh, switch to **Weight Paint** mode, then use the
  **Weights** menu → **Limit Total** (Limit: 4), then **Weights** → **Normalize All**.
- **Extra bones** (hair, tail, ears, skirt, props) can sit anywhere as children. Their names decide how they swing
  (section 8).

### Long necks and four legs

- **Long neck:** put extra bones between `neck` and `head`, for example `neck → neck_2 → neck_3 → head`. VTube Pro
  spreads the head turn down the whole chain. Fine-tune it under **Tracking** → **Neck & head** (Advanced).
- **Four legs:** turn on **It walks on four legs** in the **Body** step of **Add my model** (not offered for VRM).
  Keep the humanoid chain `hips → spine → chest → neck → head` along the back and up the neck. Name the legs
  `leg_FL_1`, `leg_FL_2` … (front left), `leg_FR_…`, `leg_HL_…` and `leg_HR_…` (H = hind, `_1` = top of the leg). A
  tail is `tail_1`, `tail_2` …; ear roots are `ear_L_1` and `ear_R_1`.
- A four-legged model tracks the face, head and neck. Its legs stand and walk by themselves. Emotes are off.

### Adding a skeleton

A model with no skeleton, or no arm bones, can get one.

- **Dropped on the studio** (Import a model): automatic. VTube Pro renders the model's front, finds the head,
  shoulders, elbows, wrists, hips, knees and ankles with the body tracker, and builds the soft rig on those joints at
  once (no Blender needed). With Blender, the bone-heat autorig then runs in the background on the same joints; a pose
  sweep (arms up / down, head turn, lean, a step: tearing, stretching, flying vertices, the wrong part moving) keeps
  the cleaner of the two, with **Undo**. Creatures and objects (no person found) get a head-and-body rig.

Otherwise you need Blender:

- In **Add my model**: the **Body** step has **Add a skeleton when I save**. **Set it up for me**
  does it too. It runs after saving and takes about a minute.
- In the quick import (**Me** → **Advanced** → **Avatars** → **Import a model**): press **Re-rig with Blender**.
- On a soft model you already use: **Me** → **Advanced** → **Body & physics** → **Soft rig**. Optionally click
  **Left shoulder**, **Left hand**, **Right shoulder** and **Right hand** on the model. Then press
  **Improve rig with Blender (bone heat)**.

Animals, birds, snakes and things (not only people): on **Body & physics** the section **Skeleton for anything** asks what the
model is, then only the taps that type needs on a picture of it. Four legs get `hips spine chest neck head`, `leg_FL_1..`, `tail_1..`
(the names above); birds add `wing_L_1..` and `wing_R_1..`; a snake follows its own curve; a thing gets a root that holds still, a bend
chain along the axis you tapped and spring bones on the loose end. The face still drives the head, neck and back. Details, bone
names and the optional smarter model: AUTORIG_3D.md.

What it does: it removes any old skeleton, builds a skeleton with VRM bone names, and weights every mesh
automatically. It keeps your original file and saves the result as `model_rigged.glb`. It takes about 20 seconds to a
few minutes. Treat it as a starting point: for a character you stream with, check the armpits, hips and fingers.

## 4. Face shapes and lip sync

Face shapes are how a model smiles, blinks and talks. Name them well and VTube Pro drives them with no setup.

### How the face is driven

VTube Pro picks one of these, in this order:

1. **Perfect sync:** the model has 10 or more ARKit shapes (VRM custom expressions named like ARKit count too). Every
   ARKit shape is driven straight from the camera. Named presets are ignored.
2. **Some shapes:** fewer than 10 ARKit shapes. Those are still driven, plus vowel, blink and emotion presets.
3. **A jaw bone:** the mouth opens and closes (section 6).
4. **Nothing:** VTube Pro adds a drawn mouth and drawn eyes (end of this section).

VRM files also use their VRM expressions: `aa ih ou ee oh`, `blink blinkLeft blinkRight`, and
`happy angry sad surprised relaxed`.

### The 52 ARKit shapes

Names are matched without caring about case, spaces, `_` or `-`. Each shape below says what it does and what happens
when your model doesn't have it.

| Shape(s) | What it does | If it's missing |
|---|---|---|
| `eyeBlinkLeft`, `eyeBlinkRight` | Closes one eye fully | No blink, unless the model has a `blink` preset. VTube Pro can add drawn eyes |
| `eyeLookUpLeft/Right`, `eyeLookDownLeft/Right`, `eyeLookInLeft/Right`, `eyeLookOutLeft/Right` | Turns the eyes | Eye bones or VRM look-at turn the eyes instead |
| `eyeSquintLeft/Right` | Narrows the eye (smiles, anger) | Less expression around the eyes |
| `eyeWideLeft/Right` | Opens the eye wide (surprise) | Less surprise |
| `browDownLeft/Right` | Lowers the brow (anger, focus) | Flat brows |
| `browInnerUp` | Raises the inner brows (worry, sadness) | Flat brows |
| `browOuterUpLeft/Right` | Raises the outer brows (surprise) | Flat brows |
| `cheekPuff` | Puffs both cheeks | No puff; used a little for P, B and M |
| `cheekSquintLeft/Right` | Raises the cheek under the eye (smiling) | Smiles look flatter |
| `noseSneerLeft/Right` | Wrinkles the nose (disgust, anger) | Less anger |
| `jawOpen` | Drops the jaw and opens the mouth | The most important one. Without it the mouth needs vowel presets, a jaw bone or a drawn mouth |
| `jawForward`, `jawLeft`, `jawRight` | Moves the jaw forward or sideways | Small loss |
| `mouthClose` | Brings the lips together while the jaw stays open | Lips can't fully seal for M, B, P |
| `mouthPressLeft/Right` | Presses the lips together | M, B, P look weaker |
| `mouthPucker` | Pushes the lips forward into a small round shape (U, W, a kiss) | VTube Pro uses the closest shape it has |
| `mouthFunnel` | Rounds and opens the lips (O, CH) | Round vowels look flat |
| `mouthRollLower`, `mouthRollUpper` | Rolls a lip inward (F, V, M) | F and V are made from press + lip raise |
| `mouthShrugLower`, `mouthShrugUpper` | Pushes a lip up | Small loss |
| `mouthSmileLeft/Right` | Pulls the mouth corners up | No smile, unless the model has a `happy` preset |
| `mouthFrownLeft/Right` | Pulls the mouth corners down | No frown |
| `mouthDimpleLeft/Right` | Pulls the corners back (tight smile) | Small loss |
| `mouthStretchLeft/Right` | Stretches the mouth wide (E, I, S) | E and I look weaker |
| `mouthUpperUpLeft/Right` | Raises the upper lip | F, S and CH look weaker |
| `mouthLowerDownLeft/Right` | Lowers the lower lip | Open vowels look weaker |
| `mouthLeft`, `mouthRight` | Moves the whole mouth sideways (smirk) | Small loss |
| `tongueOut` | Sticks the tongue out | No tongue; used a little for TH |

If you can't make all 52, make them in this order *(recommended)*:

| Priority | Shapes | Why |
|---|---|---|
| 1 | `eyeBlinkLeft`, `eyeBlinkRight`, `jawOpen`, `mouthClose` | blinking and talking |
| 2 | `mouthFunnel`, `mouthPucker`, `mouthSmileLeft/Right`, `mouthPressLeft/Right` | round vowels, smiles, sealed lips |
| 3 | `mouthRollLower`, `mouthUpperUpLeft/Right`, `mouthLowerDownLeft/Right`, `mouthStretchLeft/Right` | F, V, S, E, I |
| 4 | `browInnerUp`, `browDownLeft/Right`, `browOuterUpLeft/Right`, `eyeWideLeft/Right`, `eyeSquintLeft/Right`, `cheekSquintLeft/Right` | emotion |
| 5 | the rest | polish |

### Other names VTube Pro understands

**Name clean-up.** Everything before the last `.`, `:` or `|` is dropped (`blendShape1.jawOpen` → `jawOpen`). A
leading `arkit`, `blendShape1` or `bs` is dropped. A trailing `L` or `R` means Left or Right (`eyeBlink_L` →
`eyeBlinkLeft`).

**Presets** (for models without ARKit shapes):

| Job | Names that work (VRM 0.x, VRChat, MMD and common names) |
|---|---|
| Vowel A (`aa`) | `a`, `aa`, `vrc.v_aa`, `mouth_a`, `v_aa`, `あ` |
| Vowels I, U, E, O | the same pattern: `i` / `ih`, `u` / `ou`, `e` / `ee`, `o` / `oh`, `vrc.v_ih` …, `mouth_i` …, `い う え お` |
| Blink | `blink`, `eyeclose`, `eyesclosed`, `blinkboth`, `まばたき` |
| Blink left / right | `blink_l`, `blinkLeft`, `wink_l`, `eyeCloseLeft` / `blink_r`, `blinkRight`, `wink_r`, `eyeCloseRight` |
| Happy | `joy`, `happy`, `smile`, `fun`, `笑い`, `にこり` |
| Angry | `angry`, `anger`, `怒り` |
| Sad | `sorrow`, `sad`, `sadness`, `困る` |
| Surprised | `surprised`, `surprise`, `驚き`, `びっくり` |

**Speech extras** (optional, not ARKit): `tongueUp` lifts the tongue tip behind the upper teeth (L, N, D).
`tongueTip` puts the tongue between the teeth (TH).

**Ignored:** shapes whose names start with `vtp_`.

**Unusual names.** VRoid's `Fcl_*` shapes in a plain `.glb` or `.fbx` (not VRM) are not read by themselves. Neither are
hand-made names like `MouthOpen`. **Add my model** matches them for you. **Set it up for me** does it in one click. Or
use the **Face shapes** step of **Walk me through it** to pick a shape for each job. Your picks are saved in the
model's settings (`faceMap`, up to 400 names). Examples it knows:

| Your shape | Becomes |
|---|---|
| `Fcl_MTH_A`, `_I`, `_U`, `_E`, `_O` | the vowels `aa`, `ih`, `ou`, `ee`, `oh` |
| `Fcl_EYE_Close`, `Fcl_EYE_Close_L`, `_R` | blink, blink left, blink right |
| `Fcl_ALL_Joy`, `_Angry`, `_Sorrow`, `_Surprised`, `_Fun` | happy, angry, sad, surprised, happy |
| `Fcl_MTH_Close` | `mouthClose` |
| `MouthOpen`, `JawDown` | `jawOpen` |
| `Smile_L`, `Smile_R` | `mouthSmileLeft`, `mouthSmileRight` |
| `EyeClosed_L`, `EyeClosed_R` | blink left, blink right |
| `Frown`, `Pucker`, `Ooh`, `BrowsUp`, `Tongue`, `Puff` | sad, `mouthPucker`, `ou`, `browInnerUp`, `tongueOut`, `cheekPuff` |

With perfect sync, only ARKit names are suggested.

Where names are read: from the glTF mesh's `extras.targetNames`. Blender's glTF export writes them when **Shape Keys**
is on.

### How each shape must move

- `mouthClose` works on top of `jawOpen`: at `jawOpen` 1 plus `mouthClose` 1, the lips meet while the jaw stays down.
- `mouthClose` plus `mouthPressLeft/Right` at `jawOpen` 0 seal the lips fully (P, B, M). No gap, no teeth.
- `mouthPucker` and `mouthFunnel` make a ROUND opening (O, U, W), not a slit.
- `mouthRollLower` (with a little `mouthUpperUp`) tucks the lower lip under the upper teeth (F, V).
- Left and right shapes move only their own side. The character's left is +X.
- Shapes never move the eyes, the hairline or the neck seam.
- **Strength:** a full `jawOpen` should drop the chin about 1.4 % of the model's height (about 2.4 cm on a 1.7 m
  character). VTube Pro measures every model and evens out weak or strong shapes. But only a little: the `jawOpen`
  gain stays between 0.88× and 1.25×. Shapes are never pushed past 100 %.
- If your pucker and funnel shapes open the lips by themselves, add the node extra `"vtp_round_opens": true`. The jaw
  then stays shut on round sounds.

### Lip sync: the 17 mouth shapes of speech (visemes)

With the mic on, VTube Pro splits speech into 17 sounds (visemes). Each one is a mix of face shapes. Make your shapes
so these mixes read well. Values are at full strength; "Left/Right" shapes are used as a pair.

You don't type these numbers anywhere. VTube Pro mixes them for you. They're here so you can check each sound looks
right with your shapes.

| Sound | Example | Mix |
|---|---|---|
| `sil` | silence | nothing |
| `PP` | P, B, M | `mouthClose` 0.5, `mouthPress` 0.85, `mouthRollUpper` 0.3, `mouthRollLower` 0.3, `cheekPuff` 0.12: lips sealed |
| `FF` | F, V | `jawOpen` 0.05, `mouthRollLower` 0.8, `mouthShrugLower` 0.35, `mouthUpperUp` 0.3 |
| `TH` | TH | `jawOpen` 0.16, `mouthUpperUp` 0.12, `tongueOut` 0.22, tongue between the teeth |
| `DD` | D, T | `jawOpen` 0.14, `mouthStretch` 0.15, `mouthUpperUp` 0.1, tongue up |
| `kk` | K, G | `jawOpen` 0.24, `mouthStretch` 0.12 |
| `CH` | CH, SH, J | `jawOpen` 0.07, `mouthFunnel` 0.6, `mouthPucker` 0.4, `mouthUpperUp` 0.25 |
| `SS` | S, Z | `jawOpen` 0.04, `mouthStretch` 0.45, `mouthUpperUp` 0.18, `mouthLowerDown` 0.15 |
| `nn` | N | `jawOpen` 0.1, `mouthClose` 0.1, tongue up |
| `RR` | R | `jawOpen` 0.17, `mouthFunnel` 0.5, `mouthPucker` 0.3 |
| `L` | L | `jawOpen` 0.34, `mouthStretch` 0.1, tongue tip up |
| `W` | W | `jawOpen` 0.05, `mouthPucker` 1, `mouthFunnel` 0.25 |
| `aa` | "ah" | `jawOpen` 0.8, `mouthLowerDown` 0.3 |
| `E` | "eh" | `jawOpen` 0.42, `mouthStretch` 0.45, `mouthUpperUp` 0.12 |
| `I` | "ee" | `jawOpen` 0.18, `mouthStretch` 0.7, `mouthSmile` 0.12 |
| `O` | "oh" | `jawOpen` 0.52, `mouthFunnel` 0.85 |
| `U` | "oo" | `jawOpen` 0.14, `mouthPucker` 0.9, `mouthFunnel` 0.3 |

Models with only vowel presets get vowel mixes instead (for example P, B, M = a closed mouth; W = `ou` 0.9).
Missing shapes are replaced by the closest ones the model has. Smiles and frowns stay on while talking.

How good lip sync looks, by model:

| The model has | Result |
|---|---|
| All 52 ARKit shapes | Everything works, including GPU lip sync |
| Its own mouth shapes | Almost everything |
| Vowels only (A I U E O) | Talking looks right; lips can't fully press for M, B, P |
| A jaw bone | Open and close: great for robots and puppets |
| No mouth shapes | **Add my model** adds a drawn mouth |

More: [Best lip sync for me](LIP_SYNC.md).

### When face shapes are missing

**Set it up for me** fills the gaps. Your file is never changed:

- **No mouth shapes and no jaw bone:** it adds a drawn mouth, placed from a guess of the face.
- **No blink, and the eyes look painted on** (a textured model that isn't a robot or a VRM): it swaps the painted
  eyes for tracked eyes (section 5).
- **No blink otherwise:** it adds drawn eyes (round "inset" eyes, or screen eyes for robots).

A model with no blink shapes and no drawn eyes shows a warning under **Me** → **Advanced** → **Avatars**: "This model
has no eye shapes — place procedural eyes in the Face tab." A model with no mouth shapes, no jaw and no drawn mouth
gets the same warning for the mouth.

Change the drawn face later under **Me** → **Advanced** → **Face**. Eye styles: Bulb, Inset, Painted, Anime and LED
screen. Pupils: Round, Star, Heart and Slit. Mouths: Drawn (flat), Sculpted (the skin moves with the jaw) and Carved
(real depth, flat anime teeth).

## 5. Eyes

### What turns the eyes

- **VRM:** the VRM look-at settings.
- **Other models:** the `leftEye` and `rightEye` bones. They turn up to 20° by default, and 70 % of that up and down.
- **Perfect-sync models:** the `eyeLook*` shapes.

Put each eye bone at the centre of its eyeball. Weight the eyeball fully (1.0) to its eye bone.

### Rules for good eyes

1. **Blink closes fully.** The lid line lands slightly below the eye centre. Lashes move with the lid. No eyeball or
   iris shows through. Check at a 3/4 view: clipping shows there.
2. **Keep the upper lash line thin,** sitting across the lid edge. A thick line painted on the lid skin becomes a black
   blob when the eye closes.
3. **Iris at least 256 px** *(recommended)*. Catchlights in the same place on both eyes. A soft lid shadow on the white.
4. **Glasses, goggles and visors:** put `lens`, `glass`, `visor` or `goggle` in the material name. VTube Pro makes
   them see-through (an opaque one is set to 30 % opacity), draws them after the eyes, and stops them casting shadows.

Full construction rules: [Face creation](FACE_CREATION.md).

### Painted-on eyes

Many bought or AI-made models have the eyes painted into the face texture. They can't blink or look around. VTube Pro
can cover them with tracked eyes. Your file is never changed.

- **Add my model** → **Eyes** step → **Swap painted eyes**. Or under **Me** → **Advanced** → **Face**, turn on
  **Replace the model’s painted eyes (tracked eyes)**.
- If the eyes land in the wrong place, place the markers by hand, then press **Fit to the painted eyes**.
- Not for VRM files: their eyes already track.
- Limits: heavy painted shading around the eye stays. The new eye is anime-styled.

Making the model yourself? Don't paint the eyes in. Model eyeballs with eye bones and blink shapes, or leave the face
blank for drawn eyes.

## 6. Mouth and face rules

These are house rules. They come from models that were built, shipped and rejected.

### The mouth

1. **Carved into the face.** The opening is part of the head, with a shallow inside pocket behind it. Never a flat
   mouth sticker on top of the skin.
2. **Teeth are flat and drawn:** a white band in the texture or material. Never model 3D teeth: they look bad at stream
   size. A drawn tooth row may slide into view with the jaw.
3. **Closed anime mouth:** one short, crisp line or a small smirk. About 0.6 of an eye width on girls. No drawn lips
   on anime girls.
4. **Beards and moustaches follow the lips.** Weight them to the same jaw and mouth movement, or give them the same face
   shapes. Name them `beard` or `moustache` (or `mustache`, or end the name with `_nopatch`, or add the node extra
   `vtpNoPatch`). Then the drawn mouth never paints onto them.
5. **Inside the mouth:** materials named with `mouth`, `tongue`, `interior`, `cavity`, `throat` or `gum` get almost no
   rim light. Make inside faces flat and double-sided, or the outline shows through as black blobs.

### A jaw or puppet mouth (robots, puppets, creatures)

A mouth moved by bones is found from the bone names:

| Part | Names that work | How far it moves |
|---|---|---|
| Lower jaw | `jaw`, `jaw_lower`, `lower_jaw`, `jawbone`, `mouth_lower`, `lower_mouth`, `chin` | Drops 20° |
| Puppet top | `upper_head`, `head_upper`, `upper_jaw`, `jaw_upper`, `mouth_upper`, `upper_mouth`, `head_top`, `skull_top` | With a puppet top: jaw drops 10°, top tips back 22° |

The jaw is used only when the mouth isn't drawn and the model has neither 10+ ARKit shapes nor vowel presets.

Robot light mouth: name a material `voice_glow` (or `VoiceGlow`). Its glow pulses with the voice.

### Mouth rules (any model with its own mouth shapes or a jaw)

Small character touches in `profile.json` under `mouth` (all optional):

| Setting | What it does |
|---|---|
| `"rig": { …, "bounce": 0.4 }` | Jaw follow-through: the jaw springs a little past its target on fast opens, then settles (0..1) |
| `"rules": { "cornerBias": 0.12 }` | A resting smile (0..1) or frown (-1..0). A real frown or smile from the camera still wins |
| `"rules": { "visemeOpen": { "I": 0.5, "E": 0.7, "aa": 1.1 } }` | How far the jaw opens per mouth sound (×). Wide cartoon mouths look best with a small "I" and "E" and a big "aa" |
| `"rules": { "puff": { "shape": "throatPuff", "amount": 0.8, "threshold": 0.45, "idle": 0.2 } }` | A shape that swells when you talk LOUD: a throat sac, puffed cheeks. `shape` is your model's own shape key (any name) or `cheekPuff`. `idle` adds a slow breathing pulse while you're quiet |

Name a shape key `throatPuff` (or `throatSac`, `vocalSac`) and the puff works by itself, with no settings at all
(`"puff": null` turns it off). A puff shape key that only this rule drives must be saved at value 0 (in Blender: the shape key's **Value** = 0 before
export). Otherwise it shows at full strength until you first talk loudly.

### The face is drawn, never projected

- Never project a photo, an AI render or a low-resolution crop onto the mesh. Under toon light it turns to mush.
  References are for measuring, not for pixels.
- Paint the face in UV space *(recommended: its own 2048² texture)*: flat cel tones (2–3 skin tones), hard shadow
  shapes, crisp lines.
- Lines are dark warm brown or plum (about `#2a1a22`), never pure black. Shadows are warm (about `#f3d5c0` →
  `#d99a8c`), never grey.
- No baked lighting in the colour texture. Only small darks: nostrils, mouth corners, the lid crease.

### Face topology

- Rings of edges around each eye and around the mouth. Mouth corners without poles (points where 3, 5 or more edges
  meet), with two rings around them.
- A little geometry inside the lip line, so an open mouth shows depth.
- Eyelids that can close onto one clean line.
- When you reduce triangles, reduce hair and clothes first. Never the face and hands.

## 7. Materials and the toon look

### VRM: MToon

VRM files keep their MToon materials. VTube Pro scales their lit and shade colours by an exposure value, because MToon
is made for darker scenes. The default is 0.6; the sample VRMs use 0.66. In **Add my model** the **Look** step offers
**Darker** (0.5), **Normal** (0.6) and **Brighter** (0.75).

MToon values that work *(recommended)*. Set these in the MToon panel of the VRM add-on for Blender, or in UniVRM in
Unity:

| Material | ShadeShift | ShadeToony | Outline | Notes |
|---|---|---|---|---|
| Face skin | −0.35 … −0.6 with smooth "proxy" normals (−0.9 flat lit) | 0.9 | 0.05–0.08, masked around nose, mouth, eyes | shade colour = the skin's own shade tone, not grey-pink |
| Eye white, iris, lash line, brows | −0.9 | 0.9 | 0 | paint the eye-white shadow |
| Mouth | −0.6 | 0.9 | 0 | rim off |

Rim light off on faces (it reads as sweat). Remove VRoid's face matcap. Details: [Face creation](FACE_CREATION.md).

### GLB: the four looks

Every material in a `.glb` is turned into one of these looks. Pick it in the **Look** step:

| Look | What it does | Default for |
|---|---|---|
| **Anime** | Clean cel shading, shadows tinted by the colour (never grey), soft rim, outlines | most models |
| **Classic toon** | Simple shading bands | |
| **Toy** | Shiny: keeps your own PBR materials with studio reflections and outlines | robots and props |
| **Realistic** | Keeps your own PBR materials, no outlines | realistic characters |

What the toon look keeps from your material: base colour and texture, alpha (opacity, alpha mask), normal map,
emission colour and texture, double-sided, vertex colours. Roughness and metal maps are not used. One exception: metal
parts keep a shiny treatment. A part counts as metal when its metalness is 0.3 or more. It also counts when the
material name has `steel`, `metal`, `chrome`, `brass`, `gold`, `silver`, `iron`, `copper`, `bronze` or `alumin`, and
the metalness is above 0.05.

Outlines are drawn around every mesh, tinted from its colour. Fully see-through meshes (opacity under 0.95) get none.

### Names VTube Pro reacts to

| Put this in the name | What happens |
|---|---|
| `hair`, `bang`, `fringe`, `ponytail`, `twintail` (mesh or material) | Shiny "angel ring" highlight on hair |
| `lens`, `glass`, `visor`, `goggle` (material) | See-through, drawn after the eyes (section 5) |
| `mouth`, `tongue`, `interior`, `cavity`, `throat`, `gum` (material) | Rim light almost off |
| `voice_glow` or `VoiceGlow` (material) | Glows with the voice |
| `robot`, `mech`, `android`, `droid`, `cyborg` (any material or mesh) | **Add my model** treats it as a robot: **Toy** look, solid parts, screen eyes |
| Mostly metal words (`steel`, `metal`, `chrome`, `iron`, `bolt`, `bezel`, `screen`, `servo`, `piston`, `panel`): 40 % or more of the names | Treated as a robot too |
| `Part@style`, like `Body@felt` (material or mesh) | That part gets a surface style (below) |

### glTF extras (custom properties)

In Blender, add these as Custom Properties on the material or object. Then export with
**Include → Custom Properties** on.

How to add one: **Material** tab (the red ball) → scroll to **Custom Properties** → **New**. Click the gear next to
the new property. Set **Property Name** to `vtpShadeShift`, **Type** to Float, and type the value. For an object, do
the same in the **Object** tab (the orange square).

| Extra | Where | Values | What it does |
|---|---|---|---|
| `vtpShadeShift` | material | −1 to 1 | Moves the shadow edge. Negative = lit further round the form. Faces: about −0.1 to −0.5. Use the same value on face and body skin so the neck has no seam |
| `vtpRim` | material | 0 to 2 | Rim light strength (a multiplier) |
| `vtpDepthWrite` | material | `false` | For layered see-through cards (iris, lash line) |
| `vtpStyle` | material | a style name, or `{ "style": "felt", "tint": "#e05a3a" }` | Surface style |
| `vtpRenderOrder` | object | a number | Drawing order of see-through layers (iris < line < lash) |
| `vtpNoPatch` | object | `true` | The drawn mouth never paints on it |
| `vtp_round_opens` | object | `true` | Pucker and funnel shapes open the lips by themselves |

Surface styles: `felt`, `sock`, `fleece`, `plush`, `knit`, `crochet`, `clay`, `plastic`, `vinyl`, `rubber`,
`porcelain`, `paper`, `cardboard`, `metal_brushed`, `metal_painted`, `glass`, `crystal`, `slime`, `stone`,
`scales_lizard`, `scales_dragon`, `scales_snake`, `scales_fish`, `scutes`, `keratin`, `wet_skin`, `fur_short`,
`fur_long`. They are drawn by VTube Pro, with no textures. Fur shows on High and Ultra graphics. Performers can also
pick a style on **Me** → **✨ Material style**.

### Colours are linear

**Picking colours in Blender's colour picker? You can skip this part.** It only matters when you or an AI type colour
numbers into a script or file.

glTF `baseColorFactor` and `emissiveFactor` store LINEAR values. Blender's colour sockets are linear too. Type an sRGB
value straight in and the colour comes out too light: a "black" written as sRGB 0.07 shows as mid-grey. Convert each
channel of a hex colour (0 to 1) first:

```
linear = c / 12.92                      if c <= 0.04045
linear = ((c + 0.055) / 1.055) ** 2.4   otherwise
```

Blender's colour picker (its hex field) converts for you. The trap is scripts and hand-edited files. Colour textures
are different: they are sRGB, and the exporter labels them correctly.

### Textures *(recommended)*

VTube Pro doesn't check texture sizes. These are our recommendations:

- PNG or JPEG, power-of-two sizes.
- Face: its own 2048² texture. A 4K body atlas leaves the face under 600 px.
- Body and outfit: 2048² to 4096².
- Iris: 256 px or more per iris.
- Pad 8–16 px past every UV island.
- No photo textures and no fine noise: the toon look turns noise into speckles.

### Shading normals and outlines

- Toon shading from raw mesh normals makes blotches around the nose, lips and eye sockets. Transfer normals from a
  smooth shape (an egg shape or a smoothed copy of the head): 100 % on cheeks, forehead and mouth, 60–80 % around the
  nose. Export the custom normals; turn **Shape Key Normals** off.
- How, in Blender: on the head, **Add Modifier** → **Edit** → **Data Transfer**. Set **Source** to a smoothed copy of
  the head. Tick **Face Corner Data** and pick **Custom Normals**. Set a vertex group to limit it to the face. Then, in
  the export: **Data** → **Mesh** → **Normals** on, and **Data** → **Shape Keys** → **Shape Key Normals** off.
- Outlines keep the same width on screen and don't tear at UV seams. On VRM, use MToon's outline width mask to remove
  lines around the nose, mouth and eyelids.

## 8. Hair, physics and spring bones

### VRM

VRM files use their own spring bones (VRM 1.0 spring bones or VRM 0.x "secondary animation"). Make them in VRoid
Studio, UniVRM or the VRM add-on for Blender. VTube Pro's automatic chains, colliders and wind are off for VRM. Jiggle
bones (below) still work on VRM while automatic springs are on.

### GLB: automatic spring chains

With automatic chains on (the default), any extra bone whose name contains one of these starts a swinging chain over
its child bones:

`hair` `bang` `fringe` `ponytail` `braid` `twintail` `pigtail` `tail` `ear` (not `earring`) `skirt` `dress` `cape`
`cloak` `coat_tail` `ribbon` `bow` `tie` `scarf` `sleeve` `tassel` `chain` `pendant` `earring` `antenna` `ahoge`
`tentacle` `feather` `plume` `pom_pom` `sash` `strap` `hat` `hood`

- **Every swinging bone needs a child bone.** Name chains like `Hair_Front_01 → Hair_Front_02 → Hair_Front_03`, 2 to 4
  bones per chain *(recommended)*.
- **The chain starts** at the first matching bone whose parent doesn't match.
- **Watch for accidental matches.** The word can be anywhere in the name, in any case. A helper bone `elbow_twist`
  contains `bow`; `beard` contains `ear`. Rename such bones. Or switch off **Auto hair/tail/accessory springs** under
  **Me** → **Advanced** → **Body & physics**.
- **Settings:** stiffness 1.1, drag 0.4, gravity 0.35. Bones named `hat` or `hood` are stiffer (3.2, 0.55, 0.1).
  Stiffness eases off toward the tip. To keep hair out of the body, VTube Pro adds a sphere on the head and neck and a
  capsule on the chest.

### Jiggle bones

Bones whose names contain `breast`, `bust`, `oppai`, `boob`, `belly_jiggle`, `jiggle`, `butt`, `glute` or `cheek_`
jiggle softly instead of swinging. You can also add soft areas without bones: **Me** → **Advanced** →
**Body & physics** → **Add jiggle region**.

### Your own settings

In **Add my model**, the **Hair & clothes** step has **Swinging on** / **Off** and **Wind** (**None**, **A breeze**,
**Windy**; not for VRM). Press **Shake it** to test.

Your own chain settings go in `profile.json` (section 18):

```json
"physics": { "chains": [{ "rootBone": "Hair_Back_01", "stiffness": 1.5, "drag": 0.4, "gravity": 0.3, "radius": 0.03 }] }
```

### Hair that looks good *(recommended)*

- Clumped cards or ribbons laid along guide curves, with shading normals that follow the strands.
- One clear form band, ink edges, and the angel ring (name the material `hair`).
- A hard fringe shadow painted on the forehead.
- Locks stay about 1.05–1.08 skull radii from the head. Pull buried hair out; don't delete it (holes at the nape).
- On VRM: one spring group per layer (a stiff fringe, a looser back).

### Skirts when sitting (automatic)

Sitting lifts the thighs, which lifts a skirt off the lap. While a character sits, VTube Pro lays a cloth over the lap
in the skirt's own material. You don't need to do anything. It finds skirts by shape: one surface that wraps both
legs below the crotch. Trousers or shorts that close over the crotch count as covered. A very short skirt? Put
`skirt` or `dress` in its mesh or material name (`gown`, `robe`, `kilt` and `kimono` work too).

## 9. Costumes and accessories (outfits, hats, props)

An **outfit** changes the clothes. You wear one at a time. An **accessory** goes on top: a hat, glasses, a headset, a
held prop. You can wear any number at once. In the files both are called costumes.

### How they work

- Each one is its own `.glb` file.
- It is weighted to the SAME bone names as the model file, with the SAME rest pose.
- VTube Pro matches bones by exact name. Then it binds the clothes onto the model's own bones. So tracking, swinging
  and outlines work on the clothes too.
- Its skin uses the outfit file's own bind data. So every shared bone must sit in exactly the same rest position and
  rotation as in the model file. If not, the clothes float, twist or tear.
- **Extra bones** (a feather, a sash end, a held cane) are fine. Each one is attached under the model bone that has
  the same name as its parent. If there is no such bone, it goes on the model's root, with a warning.
- **Parts without weights** stick to the model bone that has their parent's name. A hat parented to `head` follows
  the head.
- The bone names are the names in your model FILE. For a VRoid model that means its `J_Bip_*` names, not the VRM names.

### Fit: no clipping

When an outfit loads, VTube Pro pushes the clothes slightly out of the body. It also hides the body triangles the
clothes fully cover. Accessories sit on the surface and are not pushed out.

### Rules *(recommended unless marked)*

- **Never cover the face.**
- **Layers:** body < shirt (0.012–0.02 m out) < vest or robe (0.03–0.05 m) < straps and belts (+0.01 m) < pouches.
  Tuck sleeve tops under the coat instead of butting edges.
- **35,000 triangles or fewer** per outfit or accessory.
- **Hats** sit on a `hat` bone, or on `head`, and clear the eyes.
- **Straps, collars and patches** sit tight on the body (within about 4 mm). Rigid parts don't follow face shapes: build
  a strap as a rigid ribbon, not a decal on a moving brow.
- **Held props** (a bat, a cane, a mic): weight them 100 % to `leftHand` or `rightHand`. Then set its grip (`left`,
  `right` or `both`) so the hand closes on it while it is worn.

### Adding one in VTube Pro

1. Wear the model the outfit is for.
2. Open **Me** → **Advanced** → **Outfits** (the **Wardrobe**).
3. Drop the `.glb` on **Import costume GLB…**, or click it. Only `.glb` files work, and you need Blender.
4. It is added and worn right away. Its name is the file name: `Summer dress.glb` shows as "Summer dress".

What the import can warn about:

| Warning | What it means |
|---|---|
| "The costume has no skinned meshes — it will not follow the body" | Nothing is weighted. Only parts attached to named bones move |
| "None of the costume's bones match the avatar's skeleton" | The bone names differ from the model file. Rebuild it on the model's own skeleton |
| "N costume-only bone(s) will be grafted onto the avatar skeleton" | Extra bones were found. Fine for feathers, tails and props |

An imported file always becomes an outfit. No button makes it an accessory, or sets what it hides, the grip or the
fit. For that, edit `profile.json` (section 18), or ask an AI app connected to VTube Pro to do it.

### Switching outfits

- In Simple mode, **Me** → **Outfit**: tap one. Accessories appear as switches under it.
- Keys while streaming: **Ctrl+1** … **Ctrl+9** wear outfits 1–9, the numbers on the outfit cards. **Ctrl+0** = the
  default look. In a browser tab, Ctrl+number may switch browser tabs: use **Alt+1** … **Alt+9** and **Alt+0** there.
- Text on clothes (a name on a T-shirt or a hat band) is a label: VTube Pro paints the text on a named material. Edit it
  live under **Labels** in the Wardrobe.
- Remove one with the ✕ on its card. It goes to the trash folder, not away for good. Built-in outfits can't be removed.

### A real example

The sample model Mirelle (a VRoid VRM) has four outfits and one accessory. Each outfit hides the model's own clothes
meshes, named `Outfit_Tops`, `Outfit_Bottoms`, `Outfit_Shoes` and `Outfit_Accessory` in that model. Check your own
model's part names in Blender's Outliner. The headset is an accessory that hides nothing.

```json
"costumes": [
  { "id": "mirelle_streamer", "name": "Streamer hoodie", "kind": "outfit",
    "file": "costumes/mirelle_streamer.glb", "thumbnail": "costumes/mirelle_streamer_thumb.png",
    "hides": ["Outfit_Tops", "Outfit_Bottoms", "Outfit_Shoes", "Outfit_Accessory"] },
  { "id": "mirelle_headset", "name": "Streamer headset", "kind": "accessory",
    "file": "costumes/mirelle_headset.glb", "thumbnail": "costumes/mirelle_headset_thumb.png",
    "hides": [] }
]
```

### Make an outfit in Blender, step by step

1. **Open the model in Blender.** Best: the `.blend` you made the model in. Otherwise import the model file with
   **File → Import → glTF 2.0 (.glb/.gltf)**. Keep **Bone Dir** on
   **Blender (best for import/export round trip)** (the default). A `.vrm` is a glTF file too: rename a copy to
   `.glb` if Blender doesn't list it. On Windows, first make the endings visible: in File Explorer, **View** →
   **Show** → **File name extensions**. Then right-click a copy → **Rename**, and change `.vrm` to `.glb`.
2. **Never move, rotate, rename or delete an existing bone.** That is what keeps the rest pose identical.
3. **Model the clothes on the body** in the rest pose. Keep the layer gaps from the rules above.
4. **Weight the clothes to the model's armature** (copy the weights from the body):
   - Click the clothes. Open the wrench tab (**Modifiers**) → **Add Modifier** → **Edit** → **Data Transfer**.
   - Set **Source** to the body. Tick **Vertex Data** and pick **Vertex Groups**.
   - Press **Generate Data Layers**. Without this, nothing is copied.
   - Pose the armature to check, then open the modifier's ⌄ menu → **Apply**.
   - Next: **Add Modifier** → **Deform** → **Armature**, and set **Object** to the model's armature.
   - Clean up to 4 bones per vertex (section 3, **Weights**).
   - The easier, more reliable route is VTube Pro's outfit kit through an AI app (see "Easier routes" below).
5. **Extra swinging bones** (a sash, a tail, a feather) are new bones under an existing bone. Name them with a swing
   word (section 8), like `sash_1 → sash_2`.
6. **Select only the clothes and the armature.**
7. **Export:** **File → Export → glTF 2.0 (.glb/.gltf)**, with these settings (Blender 5.1 names; on an older
   Blender some boxes sit in slightly different places, see section 15):
   - **Format:** **glTF Binary (.glb)**
   - **Include:** **Selected Objects** on
   - **Transform:** **+Y Up** on
   - **Data → Mesh:** **Apply Modifiers** on (outfits have no face shapes)
   - **Data → Shape Keys:** off
   - **Data → Armature:** **Use Rest Position Armature** on, **Export Deformation Bones Only** off
   - **Data → Compression:** off
   - **Animation:** off
8. **Name the file** the way the outfit should be called. Add it with **Import costume GLB…** and look at it from all
   sides.

For an accessory, do the same, then set `"kind": "accessory"` (section 18). A rigid hat or glasses can skip the
weights: parent the object to the `head` bone.

Easier routes:

- An AI app connected to VTube Pro can build one for you (section 17). VTube Pro's Blender outfit kit
  (`costume_kit.py`) is included. It measures the body, grows the clothes from it, copies the weights, and
  checks the rest pose for you.

## 10. Budgets

| What | Real limit in VTube Pro | Recommended |
|---|---|---|
| Model file | 300 MB (**Add my model**, browser version). 500 MB for files Blender converts | As light as you can. 2K textures |
| Model file in a party | 256 MB | |
| Triangles in a party | 200,000 per avatar including the worn outfit, by default. Warning from 170,000. The host picks 20,000 to 500,000 under **Max triangles per avatar** | 37,000 or fewer: friends see your real model unless the host picks a lower limit |
| Triangles on your own stream | none | 60,000–80,000 for a head-and-shoulders character. Face: 1,500–4,000 (anime) or 5,000–12,000 (semi-real) |
| One outfit or accessory | 300 MB, `.glb` only | 35,000 triangles or fewer |
| Materials and draw calls | none | about 25 materials and 40 draw calls or fewer. Merge and atlas |
| Textures | none | see section 7 |
| Bones per vertex | | 4 or fewer, normalised |
| Matched face-shape names (`faceMap`) | 400 | |
| Performers in one party | 8 | |

Triangles are counted every time a mesh is used. A mesh used three times counts three times.

**The party version.** Over the host's limit, friends see an automatic lighter copy. Only the triangles are reduced.
Every point, face shape, weight, UV seam, material and VRM setting is kept. The face is protected: the body and clothes
lose triangles first. Preview it under **Me** → **📏 Real size** → **Preview party version**.

## 11. Thumbnails

- **Model picture:** **Add my model** saves a picture of its preview (`thumb.png`). If a model has no picture,
  the studio takes one from the stage on a clear background. VTube Pro can also render one with Blender (512 px,
  front view).
- **Outfit picture:** when Blender is installed, VTube Pro renders one after the import (384 px, front view, worn on
  the model). No picture yet? Press the 📷 button on the outfit's card (**Render a thumbnail with Blender**).
- **Your own pictures:** PNG files. `thumb.png` in the model's folder, and `costumes/<id>_thumb.png` for each outfit
  (section 18).

## 12. Test it in VTube Pro, step by step

Judge the model where viewers see it: in VTube Pro. Blender's viewport doesn't show the toon look, the outlines or the
exposure.

### Step 1: Add it

1. Open **Me** → **Add my model**. (Also in **Create** under **Bring your own model**, and in **Settings** →
   **Guided set-ups**.)
2. Drop the file, or press **Choose a file**.
3. A 3D preview opens. Only you see it: nothing changes on your stream.

### Step 2: Read the check

The report card lists what your model can do (section 13 explains each line):

- green ✓ = good, nothing to do;
- yellow ! = works, but could be better;
- red ✕ = missing; VTube Pro can usually add it.

Press the test buttons under the preview: **Smile**, **Say “Ahh”**, **Blink**, **Look ←** and **Look →**.

All green? Press **Looks good: save it**, or **Fine-tune it** to adjust. Otherwise press **Next: set it up**.

### Step 3: Set it up

- **Set it up for me** (recommended): VTube Pro fixes what it can and shows a before / after. Then press **Save it**,
  or **Fine-tune it myself**.
- **Walk me through it:** one thing per step, with **Back**, **Skip** and **Undo**. The steps are **Name**, **Size**,
  **Body**, **Face shapes** (only for non-VRM models with shapes), **Mouth**, **Eyes**, **Look**, **Hair & clothes**,
  **Camera** and **Check all sides**. The **Mouth** step adds **Say “Ooh”**, **Say “Eee”** and **Say “Mmm”** tests.
- **Check all sides** takes 8 pictures: front, front turned, side, back turned, back, back other side, other side,
  front other side. Look for hair through shoulders, holes and floating parts.

### Step 4: Save and wear it

Press **Save it** (or **Looks good: save it**). You'll see **Ready in VTube Pro!**. Press **Use it now** to wear it.

### Step 5: Test it properly

1. **Expressions:** **Me** → **Try your expressions** (keys 1–9 work too): **Neutral**, **Talk**, **Smile**,
   **Big grin**, **Surprised**, **Angry**, **Sad**, **Ooh**, **Oh!**, **Blink**, **Wink**, **Puff**.
2. **Speech shapes:** **Me** → **Advanced** → **Face** → **Test expressions** has more, like **M/B/P**, **F / V**,
   **S / SH**, **EE**, **Tongue** and **Jaw side**. M/B/P must seal the lips.
3. **Lip sync:** turn on the mic and talk. Say "pop", "five", "see", "oh" and "you".
4. **The facts:** **Me** → **Advanced** → **Avatars** → **Loaded model** shows the kind of skeleton, triangles,
   meshes, bones, swinging bones, face shapes found, and any warnings.
5. **Hard poses:** head turned 45°, arms up, elbows bent, leaning. Check armpits, hips and fingers.
6. **Room light:** load a room. Try **Graphics quality** levels in **Room**. Surface styles and fur change with it.
7. **Party version:** over 37,000 triangles? Preview it under **📏 Real size** → **Preview party version**.
8. **Compare** with your reference at the same angle. Fix the three biggest differences. Repeat.

Common problems to hunt: floating straps, stripes in hair, noisy textures, body through clothes, hair through
shoulders, lips that don't seal, eyes that don't close, black blobs at the lash line, grey shadows, pure-black lines, a
"sticker" mouth.

### The quick import

**Me** → **Advanced** → **Avatars** → **Import a model** is the older one-step import. It shows a short rigging check
(Skeleton, Face shapes, Size, Detail) with **Re-rig with Blender**, **Set up the face**, and
**Use as is (limited tracking)** or **Done**. Without Blender it offers **Install Blender (one click)** and
**Download from blender.org**.

## 13. What the checker says

The **Add my model** report card, line by line. A line that needs Blender says so.

| Line | Green ✓ | Yellow ! or red ✕ | What to do |
|---|---|---|---|
| File | "Your model file opens right here" (or "will be converted on your PC") | "needs Blender to convert"; red "We can’t open this kind of file" | Save `.glb` or `.vrm`, or install Blender |
| Facing | "we turned it around" | "Your model faces away from the camera" | Nothing: it is turned for you |
| Body | "a full skeleton: head, arms and legs follow you" (or "Head, body and arms follow you" without legs) | "arms won’t move"; "no skeleton: it will lean and nod"; red "it moves as one piece" | Rename bones (section 3), or add a skeleton |
| Fingers | "Its fingers can copy your hands" | "No finger bones: the hands stay open" | Optional |
| Smile | "Your model’s face can smile" | "can smile once we match its face shapes"; "can’t smile yet" | Add `mouthSmileLeft/Right` or a `happy` preset |
| Mouth | "can talk and make faces", "can talk", "opens and closes with a jaw" | "unusual names — we’ll match them"; red "No mouth shapes found — we can add basic ones" | Add `jawOpen` and mouth shapes, or let it draw a mouth |
| Blink | "Your model can blink" | "once we match its eye shapes"; "The eyes look painted on"; "No eyes that blink found" | Add `eyeBlinkLeft/Right`, or let it swap or draw the eyes |
| Look | "The eyes can look around" | "The eyes can’t look around" | Add `leftEye` / `rightEye` bones |
| Shapes | | "face shapes with unusual names — we can match them" | **Set it up for me** matches them |
| Size | "Your model is … tall" | "saved in centimetres" or "millimetres"; "is that right?" | Save in metres; set the real size |
| Detail | "Light enough for group streams with friends" (≤ 37,000) or "great solo" (≤ 200,000) | "Very detailed" (over 200,000) | Fine solo; friends get the party version |
| Swinging | "Hair and clothes can swing" | (always green) | Add spring bones (section 8) |

What the sample models score:

| Model | File | Triangles | Result |
|---|---|---|---|
| Mirelle | VRM 0.x, 16.4 MB, 1.67 m, 15 VRM expressions, 32 spring joints | 26,785 | All green |
| Kairo | VRM 0.x, 18.0 MB, 1.94 m, 16 spring joints | 23,864 | All green |
| Sprocket (robot) | GLB, 1.4 MB, 1.53 m, jaw mouth, no blink | 37,894 | Yellow for smile, blink and look. **Set it up for me** adds screen eyes, the **Toy** look and swinging bones |

## 14. Workflow: VRoid Studio

VRoid Studio is a free app for anime characters. Its VRM files work best in VTube Pro.

1. **Make your character.** Get VRoid Studio (free, from vroid.com or Steam) and make your character in it.
2. **Save it as VRM** with VRoid Studio's export: its export button at the top right → **Export as VRM**. Pick VRM 1.0
   or VRM 0.x: both work. Next it asks for a title, your name and who may use the model. Any answers are fine for your
   own stream. Pick stricter ones if you'll share it.
3. **Heavy file?** VRoid Studio's export settings can reduce polygons and materials. Aim for 37,000 triangles or
   fewer.
4. **Add it:** **Me** → **Add my model** → **Choose a file**. A VRoid model is usually all green.
5. **Look** step: try **Darker**, **Normal** or **Brighter** for the studio lights.
6. **Save it** → **Use it now**. Then test (section 12).

Good to know:

- The VRM keeps its face expressions, eye movement and hair springs.
- Painted-eye replacement is off for VRM: its eyes already track.
- Saved as a plain `.glb` or `.fbx` instead? Then its `Fcl_*` face shapes need matching. **Set it up for me** does it.
  VRM is better.
- More outfits for one character: make outfit files (section 9). Each VRoid export is a separate character.
- Licences: VRoid's sample models have their own terms. Share only what you may share (section 19).

## 15. Workflow: Blender

From an empty scene to a model in VTube Pro.

Be honest with yourself first: building a whole character from nothing takes weeks to learn. For a first model, start
from VRoid (section 14), follow [Avatars by hand](AVATARS_ADVANCED.md), or let an AI start it (section 17). The steps
below say which keys to press; modelling a body well is a skill of its own.

1. **Set up.** Blender already works in metres (**Scene** tab → **Units**: **Metric**, **Unit Scale** 1.0). Build the
   character standing on the floor at the centre. Press numpad 1 (or **View** → **Viewpoint** → **Front**): the
   character faces you. That's Blender's −Y.
2. **Model** the body in a T-pose or A-pose. Face rules: section 6. Budgets: section 10.
3. **Apply modifiers first.** Apply Mirror, Subdivision and the rest BEFORE you make face shapes: in the wrench tab
   (**Modifiers**), open each modifier's ⌄ menu → **Apply**. If the glTF export applies modifiers, it drops the shape
   keys. The conversion doesn't apply them at all.
4. **Apply transforms:** in Object Mode, press A to select all, then **Ctrl+A → All Transforms**.
5. **Armature:** Shift+A → **Armature** adds one bone. Press Tab to edit it. Select the tip and press E to grow the
   next bone. Rename each bone with F2 to its VRM name (`hips`, `spine`, `chest` …, section 3). Add `leftEye`,
   `rightEye` and `jaw` if you have them. Add chains for hair, tails and skirts with swing words in their names
   (section 8). Press Tab again when you're done.
6. **Weights:** click the body, Shift-click the armature, then press Ctrl+P → **With Automatic Weights**. Then fix
   them in **Weight Paint** mode, and keep 4 bones per vertex or fewer (section 3, **Weights**).
7. **Face shapes:** select the head and open the green-triangle tab (**Object Data**) → **Shape Keys**. Press **+**
   twice (the first one is "Basis"). Double-click the new one and rename it `jawOpen`. Press Tab, move the chin down,
   press Tab again. Slide its **Value** to test. Use ARKit names (section 4). Start with `eyeBlinkLeft`,
   `eyeBlinkRight`, `jawOpen` and `mouthClose`. Check each one seals, rounds and closes as it should.
8. **Materials:** name them by part (`Skin`, `Hair`, `Eyes`, `Mouth`, `Glass`). Colours as linear numbers (section 7).
   Add custom properties like `vtpShadeShift` if you want them.
9. **Export:** **File → Export → glTF 2.0 (.glb/.gltf)**, with these settings (Blender 5.1 names; older Blender? Some
   boxes sit in slightly different places. Get the current version from <https://www.blender.org/download/>):
   - **Format:** **glTF Binary (.glb)**
   - **Include:** **Custom Properties** on (for `vtp*` extras)
   - **Transform:** **+Y Up** on
   - **Data → Mesh:** **Apply Modifiers** off (it would drop your shape keys)
   - **Data → Shape Keys:** on
   - **Data → Armature:** **Use Rest Position Armature** on, **Export Deformation Bones Only** off (it could drop
     swinging bones)
   - **Data → Material → Images:** **Automatic** (PNG and JPEG)
   - **Data → Compression:** off
10. **Add it** with **Add my model** and test (section 12).

Want to check a file without VTube Pro? Re-import the `.glb` into a fresh Blender scene. Look at the scale, the facing,
the shape keys and the bone names.

## 16. Workflow: other programs and other formats

**Best:** save `.glb` straight from your program, with the rules in sections 2–4. Then nothing is converted.

**FBX** (Maya, 3ds Max, Character Creator, Mixamo, Unity, Unreal):

- Add the `.fbx` with **Add my model**. VTube Pro opens it with Blender and converts it.
- Skeleton, weights, face shapes and materials come along. Mixamo, Unreal, Unity and Character Creator bone names are
  understood.
- Blender custom properties and unapplied modifiers are lost (section 2).
- Textures not showing? Embed them in the FBX, or save a `.glb` instead.
- Character Creator and other face systems: rename or add face shapes with ARKit names. Or let **Set it up for me**
  match common names.

**OBJ, STL, PLY:** shape only (OBJ loses its `.mtl` colours; STL has no colours). No skeleton: VTube Pro bends the
model with a soft rig. Add a skeleton (section 3), or rig it yourself and save `.glb`.

**.blend:** pack the textures first (**File → External Data → Pack Resources**). The file opens as it was last saved.

**USD, USDZ:** converted by Blender. Check materials afterwards.

**Alembic (.abc):** shape only, no skeleton.

**COLLADA (.dae):** Blender 5 can't read it. Save FBX or glTF from your program.

**A static model** (a statue, a mascot, an AI mesh): add it, then add a skeleton. Or keep it static: it follows the
head as one piece. For a face, let **Set it up for me** add drawn eyes and a mouth.

## 17. With an AI app (Claude or Codex)

An AI app can build or fix a model for you. Step by step, with Opus 5.5 and GPT-6.1 examples:
[Make a model with Claude or Codex](MAKE_WITH_CLAUDE_OR_CODEX.md).

- **Which app?** Claude Desktop is the Claude app for Windows and Mac (the easiest). The ChatGPT desktop app works the
  same way. Claude Code and Codex are assistants that run in a terminal or code editor.
- **Pick the model:** see [Pick the model](MAKE_WITH_CLAUDE_OR_CODEX.md#pick-the-model). In short: Opus 5.5 in Claude
  Desktop or Claude Code, GPT-6.1 in Codex. In Claude Desktop, use the app's model menu. In Claude Code or Codex, type
  `/model` (Claude Code can also start with `--model opus`).
- **Connect the app to VTube Pro first:** see [AI connectors](AI_CONNECT.md).
- **What you'll see:** your AI app may ask "Allow?" before it uses a tool: say yes. The **AI connectors**
  page then shows, for example, "wants to run blender_run_python". Press **Approve once** if it's what you asked for.
- **Cost:** VTube Pro adds no cost and asks for no account or key. Your AI app is between you and its maker.

What the AI can do through VTube Pro's tools:

| Tool | What it does | Asks you first? |
|---|---|---|
| `list_avatars`, `get_avatar`, `list_costumes` | Reads your models and their settings | No |
| `get_docs` | Reads VTube Pro's guides. Some copies don't include them: paste section 0 into the chat | No |
| `render_avatar` | Renders a model in Blender: front, left, right, back, three-quarter or top, 64–2048 px | No |
| `generate_avatar` | **Describe your character**: a new model from one picture, made by ComfyUI on your computer | No, but it needs ComfyUI set up on your computer |
| `update_avatar`, `import_model`, `import_costume`, `autorig` | Changes your models | Yes, by default |
| `import_room` | Adds a room you made as a new room (never replaces one) | Yes, by default |
| `set_costume` | Wears an outfit (shows on stream) | Every time (unless you picked **Approve all … calls for 30 min (any arguments)**) |
| `blender_run_python` | Runs a Blender script it writes | Every time (unless you picked **Approve all … calls for 30 min (any arguments)**) |

- **"Asks you first"** means the request waits on VTube Pro's **AI connectors** page, under **Approvals**. Press
  **Approve once**, **Approve all … calls for 30 min (any arguments)** or **Deny**. Keep that page open while the AI works. No answer in 10 minutes
  counts as **Deny**. Lost track? Open **Create** → **Check what Claude made**.
- **Without ComfyUI:** `generate_avatar` doesn't work. Ask the AI to write its own Blender script with
  `blender_run_python` instead. It saves `model.glb` and passes a name (`saveAs`) to make a new avatar. For an outfit,
  it builds the outfit GLB the same way and adds it with `import_costume`.
- **Over the internet bridge** (the switch on the AI connectors page for AI apps that run on a website, like Grok on
  grok.com), the AI sees only safe tools: no imports, no Blender scripts, no live changes. It can still render
  previews.
- If your copy doesn't include this guide for the AI to read, paste section 0 into the chat, so it knows the rules.

Example asks (they work the same with Opus 5.5 and GPT-6.1). Before you use them:

- Replace `[paste section 0]` with the checklist itself: select section 0 on this page, press Ctrl+C, click in your
  message and press Ctrl+V.
- Words like `VTP_OUT`, `saveAs` and `avatarId` are for the AI. `VTP_OUT` is a work folder VTube Pro makes for it,
  `saveAs` is the name the new avatar gets, and `avatarId` is the id the AI looks up itself. You don't need to make or
  find anything.

> "Use VTube Pro's blender_run_python to build a friendly robot mascot, about 1.2 m tall. Follow these rules: [paste
> section 0]. Use VRM bone names, name materials by part, and keep it under 37,000 triangles. Save VTP_OUT/model.glb
> with saveAs "Bolt". Then render it from the front, three-quarter and back, and tell me what you checked."

> "My avatar is called Bolt. Find its avatarId with list_avatars, then use blender_run_python with it and VTube Pro's
> costume_kit to make a yellow raincoat with a hood. Save the .glb to my Documents folder, then add it with
> import_costume."

> "My avatar Bolt has a headset outfit I imported. Look at Bolt with get_avatar. Make the headset an accessory with
> update_avatar, and send the whole costumes list (so none of my other outfits get deleted)."

After the AI is done, check its work like any model: **Add my model** or **Me** → **Advanced** → **Avatars** →
**Loaded model**, the 8 sides, and the expression tests (section 12).

**Where it shows up:** a new avatar is a new tile in **Me** → **Your avatar** (reload the studio page if it's
missing). An outfit is under **Me** → **Outfit**, on the avatar it was made for.

A character made with `generate_avatar` (the **Describe your character** maker in Create) has no face of its own.
Place its eyes and mouth under **Me** → **Advanced** → **Face**.

## 18. Where your files live (and `profile.json`)

### Folders

Each model is a folder in your library:

| Computer | Library folder |
|---|---|
| Windows | `%APPDATA%\VTube Pro\library` |
| Mac | `~/Library/Application Support/VTube Pro/library` |
| Linux | `~/.config/vtube-pro/library` |

To open it on Windows: press Windows+R, paste `%APPDATA%\VTube Pro\library` and press Enter. On a Mac: in Finder,
press Shift+Cmd+G, paste the path and press Return.

```
<model id>/
  model.vrm, model.glb or model.gltf   the model (converted files become model.glb;
                                       after Re-rig with Blender: model_rigged.glb)
  profile.json                    its settings
  thumb.png                       its picture
  costumes/
    <outfit id>.glb               an outfit or accessory, with the model's whole armature
    <outfit id>_thumb.png         its picture
```

- A new model's id is its name in small letters plus 6 random characters.
- Only `profile.json` lists the outfits. Other files in the folder (like a `.costume.json`) are ignored.
- Deleted models and outfits go to the `.trash` folder inside the library.
- Only the sample avatars that come with VTube Pro live in the program folder (`assets/builtin`), and they can't be
  deleted. Never put your own model there: an update replaces that folder. Import it instead (**Add my model**, or the
  `import_model` tool) and VTube Pro puts it in the library above. **Add my model** takes the model file only; the
  `import_model` tool also brings along the `profile.json` and `costumes/` folder that a creator script (the human creator)
  left next to the model.
  If one is left there anyway, VTube Pro moves it into your library at its next start, and the setup moves it
  there before they replace the program folder, so an update never deletes it.
- In the browser version, models live in this browser's own storage, not in a folder.

### Editing `profile.json`

Most people never need this. It is for making an accessory, hiding base meshes, or setting a grip or fit.

1. Wear a different model first (so VTube Pro doesn't save over your change).
2. Save a copy of `profile.json` next to it. Then open `profile.json` in Notepad (Windows) or TextEdit (Mac:
   **Format** → **Make Plain Text**).
3. Change only the values. Keep every quote, comma and bracket: one missing comma stops the model loading. Save.
4. Reload the studio page and wear the model again. If it won't load, put your copy back.

Leave `"source"` out, or keep `"import"`. `"builtin"` means "comes with VTube Pro", and only the sample avatars are that:
an avatar of yours marked `"builtin"` is still treated as yours (you can delete it), but don't copy a sample's whole
`profile.json` as a starting point; change only the values you need.

A costume entry, with every field:

| Field | What it does |
|---|---|
| `id` | Its id: the name in small letters with hyphens (`Summer dress.glb` → `summer-dress`, then `-2`, `-3` … if taken). Check the real id in `profile.json` before editing |
| `name` | The name people see |
| `file` | `costumes/<id>.glb` |
| `thumbnail` | `costumes/<id>_thumb.png` |
| `kind` | `"outfit"` (default, one at a time) or `"accessory"` (any number) |
| `hides` | Names of the model's own meshes to hide while it's worn |
| `grip` | `"left"`, `"right"` or `"both"`: that hand closes on a held prop |
| `fit` | `{ "margin": 0.006, "hideBody": true }`: push-out (a share of the height; 0 = off) and hiding the covered body |
| `eyes` | Eye settings while worn (for example a different iris colour) |
| `labels` | Text painted on a material: `[{ "material": "HatBand", "text": "HELLO", "color": "#1a1a1a", "background": "#ffd23f" }]` |
| `surface` | A surface style for the whole piece (section 7) |

An example model with a held mic as an accessory:

```json
{
  "version": 1,
  "id": "my_mascot",
  "name": "My Mascot",
  "modelFile": "model.glb",
  "size": { "height": 0.9 },
  "costumes": [
    { "id": "mic", "name": "Microphone", "kind": "accessory", "file": "costumes/mic.glb",
      "thumbnail": "costumes/mic_thumb.png", "hides": [], "grip": "right" }
  ],
  "costume": null,
  "accessories": ["mic"]
}
```

Missing fields get their defaults. `costume` is the worn outfit (`null` = the model's own look). `accessories` lists the
worn accessories.

## 19. Share it with friends

- **There's no export button.** To give a model to a friend, send them your original `.vrm` or `.glb`, plus any outfit
  `.glb` files. They add it with **Add my model** and **Import costume GLB…**.
- **In a party** your model is sent to the other performers by itself. It must be one self-contained `.glb` or `.vrm`
  under 256 MB. A `.gltf` that points to other files can't be sent. Over the host's triangle limit, they see the party
  version (section 10).
- **Their models stay theirs.** Another performer's model lives only in memory. Never save, copy or share it.

**Licences.** Share only what you may share:

- Check the licence of every base model, texture, hair preset and motion you used.
- VRoid sample models: only the ones marked CC0 are free to share.
- Never share Mixamo files, models from games, or anything with a non-commercial licence.
- Logos and characters you don't own: make an original design instead.

## 20. Troubleshooting

| Problem | Why | Fix |
|---|---|---|
| "We couldn’t open this model" | Draco or KTX2 compression, or a broken file | Save without compression, as `.glb` or `.vrm` |
| "This .gltf references external .bin/texture files" | A `.gltf` in several files | Save `.glb` |
| "This file is over 300 MB" | Too heavy | Fewer triangles, 2K textures |
| A conversion error on `.fbx`, `.obj`, `.blend` … | Blender is missing or too old | Install Blender (free), or save `.glb` / `.vrm` |
| Tiny, huge or exploded model | Unapplied scale, or centimetres | Apply all transforms. Save in metres |
| Model lies down or faces away | Wrong up axis, or saved facing backwards | Export with **+Y Up**. Facing away is turned for you |
| One arm or leg doesn't move | Unusual bone names, or a one-bone leg | Rename to VRM names (section 3). Give legs two bones |
| Arms don't move at all | No arm bones (a soft or static model) | **Re-rig with Blender**, or rig it yourself |
| Face doesn't move, except maybe the jaw | No ARKit or VRM shapes, or VRoid `Fcl_*` names in a `.glb` | Add ARKit shapes, save VRM, or **Set it up for me** |
| Half the model (or the smooth version) is missing after Blender converted a `.blend` / `.fbx` | The conversion doesn't apply modifiers like Mirror or Subdivision | Apply modifiers before making shape keys. Export the `.glb` yourself |
| My `vtpShadeShift` (or other extra) does nothing | Custom properties weren't exported, or Blender converted the file | Export `.glb` with **Custom Properties** on |
| Lips don't close on M, B, P | `mouthClose` / `mouthPress` don't seal at `jawOpen` 0 | Re-sculpt the seal |
| O and U look like slits | Pucker and funnel too flat | Make a round opening; maybe add `vtp_round_opens` |
| Mouth barely moves, or opens too far | `jawOpen` far from 1.4 % of the height | Re-sculpt `jawOpen` (section 4) |
| Black blob when blinking | Thick lash line painted on the lid | A thin line across the lid edge |
| Eyes can't blink or look around | Eyes painted into the texture | **Swap painted eyes**, or model real eyes |
| Colours too light, grey blacks | sRGB numbers typed into linear colours | Convert to linear (section 7) |
| Blotchy shadows on nose and lips | Shading from raw mesh normals | Smooth "proxy" normals |
| Muddy face | A photo or render projected on the face | Paint a drawn face |
| Black blobs in the mouth or nose | Outline showing through openings | Make inside faces flat and double-sided |
| Hair doesn't swing | Chain bones without children, or names without a swing word | Add child bones; use `hair`, `tail` … in the names |
| Something swings that shouldn't | A bone name contains a swing word (`elbow` has `bow`) | Rename the bone, or switch swinging off |
| Glasses hide the eyes | Material name without a glass word | Put `glass` or `lens` in the material name |
| Outfit floats, twists or tears | Different rest pose or bone names than the model file | Rebuild it on the model's own armature without touching bones |
| An imported accessory shows up as an outfit | Imports are always outfits | Set `"kind": "accessory"` in `profile.json` |
| Body pokes through an accessory | Accessories aren't pushed out | Add `"fit": { "hideBody": true }` to it |
| Friends see a simpler model | Over the party triangle limit | Lighter model (37,000 or fewer), or ask the host to raise the limit |
| Friends can't get my model | File over 256 MB, or a multi-file `.gltf` | One `.glb` / `.vrm` under 256 MB |
