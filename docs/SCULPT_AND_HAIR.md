# Sculpting stylised characters and HAIR, and reviewing them properly

Written 2026-09-25, after Aosabi v5 ("still sucks … you need serious help in sculpting models of characters,
especially hair"). This covers three things:

- what free tools and resources exist (licences checked);
- the techniques we now use (`blender/hair_kit`);
- how to review a character so defects are caught before a human sees them (`tools/review_character.py`).

Companion docs: `docs/FACE_CREATION.md` (faces) and `docs/RESOURCES.md` (general assets and licences).

> **Why v5 failed and why we missed it.** The hair was cut out of a sculpt and toned by relief. That gave flat
> ribbons with stripes, seen edge-on and from behind. The beard was relief noise. The eye-patch strap floats 3 mm
> off the skin. A beard flap hovers under the chin. The suit has black blobs painted on it. Our reviews only
> looked at the face from the front and at 3/4, in Blender, by eye. The fix has two parts:
>
> 1. a real hair pipeline (mass → guides → strands → locks);
> 2. an automatic multi-angle review in the studio's own shading, with failure detectors that are proven to
>    catch every v5 defect and to pass clean VRoid models.

---

## 1. Free tools and resources (research, view only, nothing downloaded)

"Verified" means the licence was read on the official page or repo. "Secondary" means it comes from news sites or
search snippets, so check it again before relying on it. Ship-ability rules are the same as in `docs/RESOURCES.md`:
CC0, MIT, BSD, Apache and CC-BY (with credit) can ship. GPL add-ons are fine as tools inside Blender, but we never
ship their code. NC, ND and proprietary items are reference only.

### 1.1 Official Blender assets and hair nodes
| item | licence | size | what it gives us |
|---|---|---|---|
| **Human Base Meshes v1.4.1** (blender.org/download/demo-files → Asset Bundles) | **CC0** (verified) | ~49 MB, Blender 4.2+ | 17 clean, animation-ready base meshes: realistic and **stylised** male and female bodies, heads, hands, feet, jaws, eyeballs. Appendable headless with `bpy.data.libraries.load`. It can ship. This is the best replacement for hand-built base heads. |
| **Essentials hair node groups** (bundled with Blender 3.5+; `datafiles/assets/nodes/procedural_hair_node_assets.blend`; already on this machine) | ships with Blender (GPL tool). The geometry we generate is ours. | 0 (installed) | Interpolate, Clump, Curl, Frizz, Trim, Smooth, Roll, Rotate, Braid, Shrinkwrap, Displace, Noise, Set Hair Curve Profile, Attach to Surface, Create Guide Index Map, Curve Info/Root/Tip/Segment… Docs: docs.blender.org/manual/en/latest/modeling/geometry_nodes/hair/. **`hair_kit.strands.gn_stack` runs them headless** (probed: 26 groups load). |
| **Snow character rig v4** (studio.blender.org/characters/snow/v4/) | CC-BY (verified; credit "Snow Rig (CC) Blender Foundation") | ~106 MB, 4.1+ | The best official example of stylised hair as mesh topology. Use it to study lock layering and retopology. |
| **Stylized Character Workflow** course (Snow; lessons "Hair Retopology", "Procedural Skin & Hair Anisotropy") | CC-BY lesson content (secondary: Blender Studio training often needs a subscription, so check) | streaming | The sculpt → retopo → shade workflow for stylised hair, from Blender's own studio. |
| Rain, Ellie, Sprite (Sprite Fright) rigs | CC-BY (secondary for Ellie and Sprite) | 50–150 MB each | Stylised face and hair references. Anything derived from them needs a credit. |
| Blender Studio blog "procedural hair nodes", "Introducing hair assets in 3.5" | free articles | – | Background on the node groups above. |

### 1.2 Hair-card and hair-mesh generators
| item | licence / price | notes |
|---|---|---|
| **Hair Cards from Curves** (D. Bystedt, 3dbystedt.gumroad.com) | free / pay-what-you-want; **licence not stated** | A GN setup that deforms card strips along curves, twist-aligned to the scalp. Reference only; we rebuilt the idea ourselves in `hair_kit.locks`. |
| HairNet (github Jandals/HairNet) | GPL (secondary), v0.5.1 | Legacy: mesh sheets become particle guides. Low value now that curves hair exists. |
| **Hair Tool** (B. Styperek) | **PAID** (~$40–80, not verified), GPL code | The most complete card tool: cards from curves, auto UVs, bake, bones, 30+ presets. Not needed. |
| Anime Hair Maker (Superhive) | **PAID $27**, GPL | Nine bevel profiles and taper curves. A good model of the curve + bevel anime approach. |
| Stylized Hair PRO v4, KAMI (for 3.2+) | **PAID** | GN-based stylising. Not needed. |
| HairArranger (github s-nako) | free, no licence shown | Anime curves with extrusion objects. Reference only. |
| Epic UE5 Hair Card Generator | Unreal only | Its pipeline is the one to copy (clump strands, fit cards per clump, atlas). `hair_kit` follows it. |

**Decision:** nothing here needs to ship. `hair_kit` implements the pipeline in our own code and uses only Blender's
bundled node groups.

### 1.3 Stylised and anime hair workflows (free learning)
* **Curve ribbons with a crescent bevel and a taper.** Use a curved (crescent or leaf) profile, never a flat strip,
  let neighbouring locks overlap, and taper from a thick root to a point. Free videos: "Setting up Anime or Stylized
  Hair in Blender 4.3 with curves" (youtube OXLh51fBJwc), "Anime Hair Modeling & Texturing" (youtube
  Ux55E8zwf_o). `hair_kit.locks` builds exactly this cross-section as a closed shell.
* **Sculpt, then retopologise:** Blender Studio's Snow course; YanSculpts' free hair mini-tutorials; Grant Abbitt's
  free stylised-face videos (his anime course is paid).
* **Toon hair highlights ("angel ring"):**
  * Unity Toon Shader AngelRing docs: a camera-fixed band via UV2 (reference only).
  * Scheuermann's ATI hair-rendering paper: Kajiya-Kay with shifted tangents.
  * **MooaToon "Stylized Kajiya-Kay via tangent transfer":** tangents taken from a head ellipsoid, so the highlight
    is one clean band. This matches our approach (the studio shader's ring uses the head up-axis, and `hair_kit`
    paints a world-height-aligned band).
  * Genshin shader breakdowns (Adrian Mendez, Ben Ayers): reference only.
* **VRoid samples** (CC0 per pixiv's FAQ; already in `tools/vendor/vroid`): the best shippable design reference for
  gacha hair topology. They are also our **negative control** for the review tool.

### 1.4 Scriptable sculpting in bpy (what works headless)
* `bpy.ops.sculpt.brush_stroke` needs a 3D View region, so it fails or does nothing under `blender -b`.
  **Don't use brushes headless.** Displace vertices with numpy or bmesh using our own falloffs, or use geometry
  nodes.
* **Voxel remesh** (`mesh.remesh_voxel_size` + `object.voxel_remesh`, or the Remesh modifier) works headless. We use
  it for the proxy normals and the collision hull.
* **Multires** subdivide + reshape, plus Shrinkwrap: a reliable headless "project detail".
* **Cloth / soft body** on lock meshes, pinned at the roots and baked with `ptcache.bake_all`: an option to settle
  hair so it doesn't intersect. Not needed now that guides live on masses.
* **GN SDF / volume grids** (Blender 5.x: Mesh to SDF Grid, SDF Boolean / Fillet / Offset / Mean / Median, Grid to
  Mesh…; check each one in 5.1). Procedural sculpting: union locks into one smooth shell, or smooth a noisy beard.
  The same idea as our `HairMass` implicit surface, but in GN.

### 1.5 Retopology
| tool | licence | notes |
|---|---|---|
| QuadriFlow (built in) | GPL tool | `object.quadriflow_remesh()`, headless. Voxel-remesh first, because it can hang on non-manifold input. |
| **Instant Meshes** (github wjakob/instant-meshes) | **BSD-3** (verified) | Batch CLI (`-o`, `-f`/`-v`/`-s`, `-d`, `-D`). A subprocess from the pipeline; the binary could even ship. |
| Quad Remesher (Exoside) | **PAID** (Blender Indie $59.90, Pro $109.90) | The best auto-quads, but proprietary. |
| RetopoFlow 4 | PAID binaries ($86), GPL source | Manual only. Not for automation. |

### 1.6 Baking
The Cycles bake API (`object.bake(type='NORMAL'|'AO'|'EMIT', use_selected_to_active=True, cage_extrusion=…)`)
works headless with an active Image Texture node. For curvature: Cycles *Pointiness* via an Emit bake, or GN edge
angle / SDF mean curvature stored as an attribute. PAWS Bakery, BakeLab and Bake Wrangler are free helpers but not
needed.

### 1.7 MPFB2 (MakeHuman)
The add-on is GPL-3 (extensions.blender.org, 42.9 MB). Its asset packs: **System Assets CC0**, **Hair 01 CC0**
(stylised low-poly), System Hair Materials CC0, Hair 02 and 03 CC-BY, and a "Hair Editor" pack (CC0) for its GN
hair. The Hair 01 meshes are shippable starting shapes, but realistic rather than anime.

### 1.8 Review / QA tools
| tool | licence | use |
|---|---|---|
| **glTF-Validator** (Khronos, npm `gltf-validator`) | Apache-2.0 (verified) | Validates every exported GLB (spec errors, bad accessors). |
| **gltf-transform inspect** (npm `@gltf-transform/cli`) | MIT (secondary) | Per-mesh draw calls, vertex and texture budgets. |
| pixelmatch (npm) | ISC (verified) | Anti-alias-aware render diffs (before/after regressions). |
| LPIPS (pip `lpips`) | BSD-2 (verified); weights 2.8–59 MB but **needs PyTorch** | Perceptual similarity to a reference render. A heavy dependency. |
| 3D-Print Toolbox (extension) | GPL-3 | Non-manifold, intersection and thin-wall checks (a tool only). |
| `mathutils.bvhtree.BVHTree.overlap()` | Blender built-in | Self-intersection between parts in a few lines (a candidate detector G5). |

---

## 2. Hair: the technique we use now (`blender/hair_kit`, see its README)

1. **Block the mass.** Nested implicit surfaces, one per layer, each 6 to 40 mm off the head. Each contains the real
   head (ears and sideburns), adds top volume, and smoothly unions a curtain that falls behind the ears and drapes
   over a smooth, cone-sloped envelope of the neck, collar and shoulders.
2. **Guides are streamlines on the mass.** They rise off the scalp (quiff), are combed back along the meridian,
   fall down the curtain, slide back off the shoulders, and stop at a target tip height, with length and width
   fitted to the reference silhouette. Neighbouring guides wave in phase (the phase follows azimuth). Sculpted hair
   can seed guides instead: `guides_on_shell()`.
3. **Strands.** Children around each guide (an ellipse across the flow), interpolated from nearby guides, clumped,
   then passed through Blender's **Essentials** Smooth and Frizz node groups on a real Curves object.
4. **Locks.** Each clump becomes a closed crescent-shell mesh. Width and orientation come from the strands' spread,
   and the lock lies like a shingle (lateral axis around the body). Broad-then-wedge tips, optional forks,
   anti-fold narrowing, unique atlas UVs.
5. **Paint.** Flat layer tones, root→tip gradient, edge darkening for lock separation, few tapered strand lines,
   and an **angel-ring band at one world height**. The engine's live ring (`look.hairShine`) stays low or at 0 when
   the band is painted.
6. **Clean cel normals.** A proxy (inflate → voxel remesh → smooth) and custom-normal transfer give one terminator
   over the whole hairdo.
7. **Rig.** Six azimuth groups of 4-bone spring chains on the head bone, written to `profile.physics.chains`.
   **LOD1** (about 55 % of the triangles) and **LOD2** (cards, about 2 k triangles).
8. **Review** with `tools/review_character.py --focus hair`, and iterate until it passes **and** looks right.

Demo: Aosabi's body with the v5 hair removed, plus new long, wild, swept-back reddish-brown hair. It took 30
iterations, each rebuilt and reviewed, and every early one failed visibly (see the README rules). The final v30
is **WARN** across all 17 views: 0 high findings; 2 medium (a 70 px slit seen from the low angle, and 8 % back
faces in one profile); small low-severity clipping against Aosabi's own jacket. It has 66 locks (87 with forks):
LOD0 127 k triangles, LOD1 68 k, LOD2 2.8 k.

Remaining gap to the reference: the drawing has chunkier S-waves, lighter strand highlights and more
ragged tips. The demo is cleaner and a little more "groomed".


### 2.1 "Match my reference": `tools/ref_match.py` (automatic, any user's reference)
Goal: reproduce the user's drawing, not some generic "nice hair". The loop runs fully headless and pauses whenever
`live_ok.py` reports STRUGGLING:
```
python tools/ref_match.py assets/reference/aosabi/ref_match.json <out_dir> [--iters 90]
```

1. **Config** (`ref_match.json`). The avatar and profile, then one entry per reference view:
   - image and crop;
   - candidate yaws;
   - framing (`bust` or `head`);
   - an optional turnaround `group` (views that share one drawing scale; one of them is the `scale_master`);
   - **keypoints**: the visible eye and the mouth, or for a back view the head-axis x plus the eye and mouth
     heights.

   The model's own 3D keypoints go in `model_kp`. A user marks about 2 points per view; that is the only manual
   step. MediaPipe's face landmarker is installed locally (`public/mediapipe/face_landmarker.task`) and was tried
   for automatic keypoints, but it only detects 1 of the 4 stylised Aosabi views, so it is not used yet.
2. **Targets from the drawing** (numpy):
   - hair mask: an HSV box, keeping the pieces connected to the head;
   - skin mask;
   - **line art**: a black top-hat of the luma (thin dark ridges only, not dark shadow areas); these are the lock
     boundaries;
   - hair palette: 3 clusters (shadow, base, highlight);
   - hem / tip line: the lowest hair pixel per column.
3. **Camera match.** Each candidate yaw is rendered in the studio toon look. The yaw kept is the one whose
   projected eye→mouth offset ratio matches the drawing. The similarity (scale and shift) maps the projected model
   keypoints onto the marked ones. Views on one turnaround sheet share the master's scale.
4. **Scores per view**, in reference pixels:
   - hair IoU, with the beard region ignored;
   - line-art chamfer, in % of head height;
   - tip-line error, in % of head height;
   - palette distance.

   `total = (1-IoU) + 2·chamfer + 1.5·tips + palette`.
5. **Search.** The hair palette is taken directly from the reference clusters. After that, coordinate descent runs
   over the hair_kit style parameters (`styles.MATCH_DEFAULTS`):
   - tip heights (back and sides), mass offset (volume), width, curtain flare, S-wave amplitude and frequency;
   - tip raggedness and forks, quiff rise, top volume, crown spikes, flicks;
   - side locks in front of or behind the shoulders, fringe locks over the forehead;
   - lock counts.

   Each candidate is a `--fast` hair build plus a 512 px render plus a score, about 45 s. The search stops when a
   sweep, followed by a half-step sweep, brings no improvement.
6. **Output.** `compare_start.png` and `compare_best.png` show reference | ours at identical framing for every view
   with the scores. Also written: `history.json` (every candidate), `best_params.json` (feed it to
   `hair_kit/build.py --params` for the full build) and `target_<view>.png` (the extracted masks, to check the
   extraction).

**Visual hull (`--hull`).** The hair volume is carved from the calibrated silhouettes:
- a voxel is kept only if, in every hull view, it lands on reference hair (with a tolerance band) or is hidden
  behind the hair-less body;
- it must also be visibly on hair in at least one view.

The result is saved as an SDF (`hull.npz`, `hull_check.png`) and used by `hair_kit.core.VoxelMass`, so the style's
layers lie on it and streamlines stop at its hem.

**Status 2026-09-25 (Aosabi): not yet "the same hair".**
- The parameter search went from 1.239 to 1.172 in 31 evaluations before it was stopped.
- The first hull build scores 1.45.
- Per-view hair IoU is 0.39–0.65.

Blockers found:
- The AI turnaround views disagree with each other: head height, hem and hairline drift between them.
- The drawing's body (arms down, narrower shoulders) differs from the T-posed model, so occlusion and fits are
  approximate.
- The search only tunes a style's global parameters; it cannot place specific locks.

The next step that can reach "same hair" is **lock tracing**: extract lock centrelines from the line art in the
back and side views, pair them up, lift them to 3D with the calibrated cameras, and use them directly as guides.
Each lock then follows the drawing, instead of a style approximating it.

**Lock tracing (`--trace`, implemented 2026-09-25).**

How it works:
- The drawn locks are found as evenly spaced streamlines (Jobard–Lefer) of the drawing's stroke-direction field,
  a structure tensor of the luma inside the hair mask, with the beard masked out using the model's beard.
- Each streamline is lifted to 3D by sphere-tracing rays from the matched camera onto the visual hull, and its
  width is converted from pixels to metres at the hit depth.
- Duplicates across views are dropped by 3D proximity.
- Roots go to the nearest scalp point above the hairline, with the root segment projected over the head mass.
  Fragments more than 10 cm from the scalp are dropped.
- `traced_mode`: `add` (style coverage plus the drawn locks on top, the default) or `replace`.
- The score also has a **flow** term: the orientation histogram of the lines, so straight locks lose to the
  drawing's S-waves.

Result on Aosabi: 58–83 locks traced from four views. Its first builds scored 1.42–1.73 (with the flow term),
which does **not** yet beat the non-hull parameter search. The hull's hem is too long at the back, and the traced
locks read as scraggly strands because the streamline width and spacing are not yet fitted per lock.

Also in the review now:
- glTF-Validator runs in every review (finding V1).
- pixelmatch before/after diffs with `--before <old review dir>`.

Limits and next steps:
- **Scoring.** No neural perceptual score is used, because no model download was approved. DINO or CLIP features
  would add a "does it look like the same hair" term.
- **Structure.** The optimiser only searches the style's parameters. Structure the style cannot express (a specific
  lock's shape) needs new style elements, as the fringe and crown spikes were for Aosabi.
- **Texture.** The lock atlas is painted procedurally from the reference palette. Repainting it conditioned on the
  reference (ComfyUI) would be the next step for the highlight streak shapes.
- **Other character parts.** The same loop (keypoints → camera → masks, lines and palette → parameter search)
  applies to other parts, e.g. beard, jacket or face paint. Each needs its own parameterised builder.
- **In the app.** A later version could run from the app ("match my reference").

---

## 3. Reviewing a character (the part we got wrong)

### 3.1 Manual multi-angle checklist (every build, before anyone else sees it)
Render in the **studio look** (the app's anime shader, key light fixed to the camera, outlines, no tone mapping).
Use at least these views: **bust front, 3/4 left, 3/4 right, profile left, profile right, back, back-3/4 both sides,
low angle (camera 22° below), high angle (28° above), head close-ups (front, 3/4 both, profile, top), full body front
and 3/4**. For each view, go down this list:

1. **Silhouette.** Does it read at thumbnail size? No broken pieces, holes or needles sticking out sideways.
2. **Floating geometry.** Straps, patches, collars, beards and flaps must sit on what they wrap (at most 2 mm on the
   head). No hovering sheets.
3. **Stripes / banding.** Hair and cloth show big flat cel shapes, not dense parallel light/dark bands.
4. **Noise.** No relief noise or speckled shadows (beard, face, hair).
5. **Smears / blotches.** No ragged dark blobs on light cloth or skin that aren't designed shapes.
6. **Clipping.** No skin through hair, shirt through jacket, or hair inside garments.
7. **Back faces / holes.** No see-through surfaces from behind or below.
8. **Likeness.** Side by side with the reference at the same framing: silhouette, proportions, colour. Then list the
   3 biggest differences.
9. **Motion.** Expressions and visemes (FACE_CREATION §8); spring chains in the studio's own `?observer=1` tab with
   tracking frozen.

### 3.2 Automated: `tools/review_character.py`
```
python tools/review_character.py <model.glb> <out_dir> [--profile profile.json] [--focus hair|all] [--only v1,v2]
```
* **Renderer** (`blender/review_char/render_passes.py`). This runs on the CPU in Cycles at low priority, so it never
  touches the GPU the live tracker uses. It renders exact 1-sample data passes: albedo, custom shading normals,
  position, ids and emission. Alpha-clip and back-face culling behave like three.js. VRM 0.x models are turned to
  face the camera.

  numpy then evaluates the **app's own anime shader formula** from `src/avatar/toon.ts`: terminator at 0.2 +
  `vtpShadeShift`, the albedo-derived shade tint, warm band, fresnel rim, gloss highlight and angel ring. It uses
  `Stage.ts` KEY_DIR fixed to the camera, a screen-space inverted-hull outline (coloured lineart, about 1.45 px),
  sRGB out and 2× supersampling.

  The result matches the user's studio screenshot of v5 almost pixel for pixel in content. It also writes clay
  (forms only) and light-flip renders. 17 views take about 2–3 min.
* **Detectors:**
  * **G1** floating islands / hair not rooted on the scalp
  * **G2** thin straps and flaps hovering off the surface (more than 2 mm on the head, 5 mm elsewhere)
  * **G3** debris specks
  * **G4** runaway hair
  * **R1** detached silhouette pieces
  * **R2** see-through slits between parts
  * **R3** culled back faces (holes in the studio)
  * **R4** paper-thin sheets / flat cards seen from behind
  * **R5** stripes (thin elongated tone bands)
  * **R6** albedo noise
  * **R7** fragmented cel shading
  * **R8** ragged dark smears enclosed by a light surface
  * **R9** poke-through (depth-continuous islands of one part inside another)
  * **R10** ragged silhouette
  * **R11** needle spikes pointing sideways or up

  Region metrics are judged on the **median over views**. Every finding is numbered and boxed on the annotated
  sheets.
* **Calibration.** Two negative controls, both clean CC0 VRoid samples: HairSample_Male gives **PASS**; Sendagaya
  Shino gives **WARN** for 2 tiny hair-tip detachments, one single-view spike, and low R9 where skin shows between
  locks.

  Positive case, Aosabi v5: **FAIL** with all of the user-visible defects found:
  * strap hovering (G2);
  * beard flap under the chin (G2);
  * flat stripey hair cards seen from behind (R4, 28 %);
  * noisy beard, hair and face shading (R6, R7);
  * black smears on the suit (R8);
  * skin, shirt and hair poke-through (R9);
  * holes, needles and specks.

  Thresholds with their calibration values are in `TH` at the top of the tool.
* **Limits.**
  * It cannot judge *appeal* or likeness; the manual checklist items 8–9 stay.
  * The screen-space outline approximates the hull.
  * Key-light shadow maps (hair shadow on the face) are not simulated.
  * VRM MToon colours aren't imported by Blender (VRM textures render white-ish), so VRMs are reviewed on geometry
    and shading only.

---

## 4. Download proposals (ask the user; nothing has been downloaded)

| # | item | URL | licence | size | what it enables |
|---|---|---|---|---|---|
| 1 | **Blender Human Base Meshes v1.4.1** | https://www.blender.org/download/demo-files/ (Asset Bundles) | CC0 | ~49 MB | Clean stylised and realistic base heads and bodies with animation topology. Replaces hand-built and conformed heads, which were the root of the v4/v5 face problems. Can ship. |
| 2 | **Instant Meshes** (Windows binary) | https://github.com/wjakob/instant-meshes (release zip) | BSD-3 | a few MB (not listed) | Automatic quad retopology of sculpts (hair masses, beard shells, garments) from the pipeline. |
| 3 | **glTF-Validator** (npm `gltf-validator`) | https://github.com/KhronosGroup/glTF-Validator | Apache-2.0 | ~2 MB npm | A spec check of every exported avatar in the review run. |
| 4 | **Snow character rig v4** | https://studio.blender.org/characters/snow/v4/ | CC-BY | ~106 MB | Reference: production stylised hair topology, lock layering and hair shading, to study and compare against. Don't ship derived pieces without a credit. |
| 5 | MPFB2 System Assets + Hair 01 (CC0) | https://static.makehumancommunity.org/assets/assetpacks.html | CC0 | not listed (tens of MB) | More CC0 base proxies and low-poly hair shapes for the comic/human path (optional). |
| 6 | pixelmatch (npm) | https://github.com/mapbox/pixelmatch | ISC | <50 KB | Before/after render diffs in the review tool (optional; numpy already covers most of it). |
| – | not proposed | Hair Tool, Anime Hair Maker, Quad Remesher, RetopoFlow | paid | – | Not needed: `hair_kit` covers the pipeline with bundled Blender features. |
| – | not proposed | LPIPS | BSD-2 | needs PyTorch (~2 GB) | Too heavy for the benefit. |
