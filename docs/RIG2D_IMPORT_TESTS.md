# Live2D import: sample ladder and fidelity gate

When someone drops a Live2D model (a zip, or the folder of a `.model3.json` and its files), VTube Pro converts it into
its own rig format, `.vtp2` (docs/RIG2D_FORMAT.md). The original Live2D files are not kept, and the converted model
is drawn by VTube Pro's own runtime. This file covers:

- the test models (where to get them: **never commit, ship or copy them into a repo**);
- the gate a conversion must pass;
- the latest results.

Provenance of the format knowledge: docs/RIG2D_IMPORT_PROVENANCE.md.

## 1. Sample ladder (29 models)

All test models are **Live2D's official free sample models**, used **for local testing only** under the Live2D Free
Material License (owner-approved). Get them from [live2d.com/en/learn/sample](https://www.live2d.com/en/learn/sample/),
or from the `Samples/Resources` folder of Live2D's CubismWebSamples repository (model folders only, no SDK code).
Keep them in a scratch folder outside every repo, for example `…/vtp-b12/live2d_samples/`. The gate finds every
`*.model3.json` below that folder.

Third-party characters among Live2D's samples (Hatsune Miku, Zundamon, Unity-chan) were left out on purpose. The
"Parameter Controller" sample ships only editor files (`.cmo3`), not a runtime model.

| Model | .moc3 version | Meshes / params / deformers | What it exercises |
|---|---|---|---|
| Haru | 1 (Cubism 3.0) | 84 / 42 / 97 | masks, pose part switching, 8 expressions, stepped motion segments, motion curves for parts the model lacks |
| haru_greeter_t05 | 1 | 84 / 42 / 97 | 27 motions |
| Natori | 1 | 176 / 96 / 180 | 3 draw-order groups, multiply, 11 glue, 11 expressions |
| Wanko | 1 | 34 / 25 / 34 | Cubism 2-style ids (`PARAM_ANGLE_X`), 33 **single-sided** (culled) meshes |
| ni-j, nico, nietzsche, nipsilon, nito | **2 (Cubism 3.3)** | 89–101 / 66 / 102–115 | five models sharing one runtime folder, poses, 21 motions each |
| chitose, haruto, koharu, hijiki, tororo | 3 (Cubism 4.0) | 56–90 / 31–52 | expressions, poses, physics |
| Epsilon, Epsilon_free, hibiki, izumi_illust | 3 | 58–69 | 46–67 single-sided meshes each |
| Gantzert_Felixander | 3 | 238 / 74 / 89 | 49 masked, **54 additive** meshes, 13.7 MB of textures |
| Hiyori | 3 | 134 / 70 / 104 | 26 glue, 11 physics strands |
| Mark | 3 | 30 / 21 / 28 | minimal; motion `Model` curves (`EyeBlink`, `Opacity`) |
| miara_pro_t03 | 3 | 187 / 138 / 164 | 36 glue, 19 physics strands, deep rotation chains |
| Rice | 3 | 178 / 96 / 138 | 12 masked incl. **7 inverted**, 21 additive, 9 culled, 33 glue |
| simple | 3 | 17 / 24 / 1 | almost no deformers |
| tsumiki | 3 | 89 / 46 / 89 | 23 motions, 10 expressions |
| kei_basic_free, kei_vowels_pro | 5 (Cubism 4.2+/5) | 59 / 27–31 | kei_vowels_pro: **45 blend shapes** (vowel mouth shapes) |
| Mao | 5 | 262 / 132 / 178 | 37 masked (10 inverted), 15 additive, 8 multiply, **76 colour keyforms**, **124 blend shapes** incl. rotation / part, 16 physics strands, poses |
| Ren | 6 (Cubism 5.3) | 198 / 73 / 150 | 29 draw-order groups (slot totals larger than the mesh count), 60 blend shapes, colour keyforms |

**Version 4 (Cubism 4.2):** no official sample uses it. It is covered by a synthetic v4 file from our own writer
(`tools/rig2d_moc3_unit.ts`, including a blend-shape parameter), checked vertex for vertex against the Python
evaluator. v4 colour keyforms (`colBegin + keyform`) remain unverified by a real file.

**Community models:** four free community models (local testing only, never committed) were imported from their
creators' own zips, including a real version-4 `.moc3` and three VTube Studio packages (section 3d). The official
set covers the rendering features (extreme mask counts, multiple texture pages, inverted masks, culling, high-res
textures, many parameters); the community zips cover how real deliveries are packed.

## 2. The gate

A conversion passes only when **all** of the following hold:

1. **Structure 1:1** (`npx tsx tools/rig2d_import_gate.ts`), counted against the source files:
   - parameters (range, default, repeat), parts, warp / rotation deformers, art meshes, mask links, draw-order
     groups, glue, blend-shape bindings, textures;
   - every keyform (mesh / warp / rotation keyforms plus blend-shape keyforms = the source's section sizes);
   - every motion curve and **every segment kind** (linear / Bézier / stepped / inverse stepped). Curves aimed at
     parameters or parts the model doesn't have are counted and reported, never silently dropped;
   - every expression parameter with its blend (`Add` / `Multiply` / `Overwrite`);
   - physics settings, inputs, outputs and particles (equal to `Meta.TotalInputCount` / `TotalOutputCount` /
     `VertexCount`);
   - pose groups, and the eye-blink / lip-sync ids.
2. **Every vertex**, at 15 poses: default, head X / Y / Z extremes, eyes closed, mouth open and forms, body
   extremes, eye balls, and a mixed pose.
   - Each pose is evaluated by our TypeScript runtime and by the project's clean-room Python evaluator
     (`blender/live2d/moc3.py` via `tools/rig2d_oracle.py`). They are separate implementations, so a conversion
     bug cannot hide in both.
   - **Pass:** max vertex error ≤ 0.25 canvas px, identical render order, identical enabled flags, opacity error
     ≤ 1e-4.
   - **Why 0.25 px:** a quarter of a source pixel is invisible at any output size. Deep rotation chains differ by
     float rounding (up to 0.13 px, in miara).
   - Cubism 5 rotation / part / glue blend shapes are not in the Python evaluator, so those are left out of this
     comparison and checked by the pixel gate instead.
3. **Physics behaviour:** with the head swinging for 2 s and then resting for 4 s, every physics output stays finite
   and in range, moves (> 2 % of its range), and settles back (residual < 10 %).
4. **Pixels** (`node tools/rig2d_render_gate.mjs`):
   - **What is compared:** our WebGL renderer draws 5 poses of every converted model (default, head turn, head
     tilt, eyes closed + mouth open, a mixed pose) at 800 px tall on white. Each is compared with an independent
     software rasteriser of the source model (`tools/rig2d_pyref.py`: masks incl. inverted, add / multiply, draw
     order, default pose visibility).
   - **Pass:** mean absolute error ≤ 2 / 255, and **no blob larger than 30 connected pixels** still off by
     > 24 / 255 after both pictures are blurred by about 1 px and the difference is eroded by 1 px.
   - **Why this metric:** the two renderers differ only in antialiasing (MSAA vs 2× supersampling) and texture
     filtering (mip-mapped vs bilinear). Those differences scatter into specks and 1–2 px lines, which the
     blur / erode removes. A missing part, broken mask, wrong blend mode or wrong draw order leaves a solid area.
   - **Calibration (the metric must catch real faults):** per model, four faults are injected into our renderer:
     - all masks off;
     - add / multiply drawn as normal;
     - a typical upper mesh hidden;
     - the most-overlapping adjacent pair swapped in the render order.
     Every fault that visibly changes our own picture (by the same metric) must fail against the reference.
   - **Premultiplied alpha probe:** a 50 %-alpha (100, 200, 50) quad over black must give exactly (50, 100, 25).
     This catches the straight-vs-premultiplied texture bug: the probe was checked to fail on the old code.
5. **Robustness** (`npx tsx tools/rig2d_moc3_unit.ts`):
   - Hostile files must end in a clean result or one plain error, never a crash or a hang (> 2 s): 3 000 variants
     of a synthetic v3 `.moc3`, 1 500 of a synthetic v4, and 300 mutated variants each of two local samples. The
     variants mutate the header, offset and count tables and indices, and truncate the file.
   - The synthetic models also match the Python evaluator vertex for vertex.
6. **End to end** (`npx tsx tools/rig2d_e2e.mts`, private server on port 5921, muted headless Chrome):
   - Dropping a Live2D zip / `.vtp2` / `.inp` through the real import route converts it. Only `model.vtp2` and
     `profile.json` are stored, and the user sees one line.
   - The avatar draws (canvas content checked) in a room, as an overlay, on a walking TV and on a monitor. It
     follows synthetic tracking (turn, talk, blink), plays an expression cue and a motion cue, and doesn't leak GPU
     textures over reloads.
   - The studio panel works at desktop and phone widths, in dark and light themes.

**Live2D's own output** is not a pixel reference here:

- Running the Cubism Core locally is off-limits (clean room).
- Live2D's sample pages show only promotional collages, not renders at set parameter values.

Those preview pictures are kept as screenshots (`tools/rig2d_viewer_refs.mjs`, scratch folder only) for a
side-by-side look. They are not used for a score.

## 3. Results (2026-10-06)

**Structure + vertices + physics:** 29 / 29 PASS.

| Model | v | Max vertex error | Notes |
|---|---|---|---|
| Haru, haru_greeter_t05, Natori, Wanko | 1 | ≤ 0.0004 px | Haru: 6 motion curves aim at parts the model lacks (reported) |
| ni-j, nico, nietzsche, nipsilon, nito | 2 | ≤ 0.0002 px | |
| chitose, Epsilon, Epsilon_free, Gantzert_Felixander, haruto, hibiki, hijiki, Hiyori, izumi_illust, koharu, Mark, Rice, simple, tororo, tsumiki | 3 | ≤ 0.0003 px | |
| miara_pro_t03 | 3 | 0.128 px | float rounding in a 9-deep rotation chain (worst vertex 6e-5 model units) |
| kei_basic_free, kei_vowels_pro, Mao | 5 | ≤ 0.0003 px | Mao: 8 rotation / part blend shapes → pixel gate |
| Ren | 6 | 0.0003 px | 4 rotation blend shapes → pixel gate |

Render order, enabled flags and opacity match exactly everywhere (15 poses × 29 models).

**Pixels:** 145 / 145 poses PASS, the largest blob is **0 px for every model and pose**, and the premultiplied
alpha probe passes. The table shows the worst of 5 poses: mean error over 0–255, and the share of covered pixels
off by > 24 before blurring (antialiasing and sampling specks).

| Model | MAE | Raw specks | Blob |
|---|---|---|---|
| chitose | 0.40 | 0.35 % | 0 |
| Epsilon / Epsilon_free | 0.60 | 0.42 % | 0 |
| Gantzert_Felixander | 0.48 | 0.21 % | 0 |
| Haru / haru_greeter_t05 | 0.54 / 0.44 | 0.81 / 0.66 % | 0 |
| haruto / koharu | 0.39 / 0.45 | 0.13 / 0.20 % | 0 |
| hibiki | 0.52 | 0.45 % | 0 |
| hijiki / tororo | 0.10 / 0.04 | 0.02 / 0.00 % | 0 |
| Hiyori | 0.46 | 0.45 % | 0 |
| izumi_illust | 0.22 | 0.02 % | 0 |
| kei_basic_free / kei_vowels_pro | 0.17 | 0.00 % | 0 |
| Mao | 0.72 | 1.19 % | 0 |
| Mark | 0.20 | 0.23 % | 0 |
| miara_pro_t03 | 0.77 | 0.71 % | 0 |
| Natori | 0.48 | 0.44 % | 0 |
| ni-j / nico / nietzsche / nipsilon / nito | 0.30–0.48 | 0.35–0.63 % | 0 |
| Ren | 0.53 | 0.68 % | 0 |
| Rice | 0.11 | 0.05 % | 0 |
| simple | 0.26 | 0.05 % | 0 |
| tsumiki | 0.60 | 0.76 % | 0 |
| Wanko | 0.06 | 0.02 % | 0 |

**Fault calibration:** 35 injected faults visibly changed our picture, and **35 / 35 were caught** (0 missed).
81 faults had no visible effect on that model and pose; for example, a mask that never clips anything at rest, or
additive glows at zero opacity.

**Fixed along the way** (found by this gate):

- textures were treated as premultiplied while they were straight;
- 1–2 px ink lines were thinned by mip-mapping (now a −1 LOD bias);
- back-face winding was measured;
- draw-order group totals can exceed the mesh count;
- motion `Model/Opacity` curves were added;
- Cubism 2-style ids are handled in framing and tests.

## 3b. Regression after runtime 2 (beta.12 advanced features)

Runtime 2 added bones, lighting, dynamics, a state machine, attachments, particles, views, outlines and sprite sheets
(docs/RIG2D_FORMAT.md §8). These are all opt-in per model, and converted Live2D models use none of them. Re-run on
the full 29-model ladder:

- **Structure + every vertex:** 29/29 PASS, with the same maximum errors as above.
- **Pixels vs the Python reference:** 145/145 poses pass (largest blob 0 px). The fault calibration still catches
  every visible fault.
- **Pixel regression vs runtime 1's own renders** (`node tools/rig2d_render_gate.mjs --baseline <runtime-1 renders>`):
  - 91 of 145 pictures are byte-identical.
  - 54 differ in 1–5 channel values of at most 1/255.
  - That is the GPU's own run-to-run noise: two runs of the same code differ the same way (measured: 5 of 15
    pictures, 1–3 values, max 1).
- **Performance fix found by the runtime-2 checks:** the renderer read the index buffer's size back from the GPU
  (`getBufferParameter`) every frame. That synchronous round trip stalled the OBS page about 9 ms per 2D rig per
  frame. The size is now tracked on the CPU side, and a whole OBS-page step with a rig takes 0.6 ms.

### 3c. Release-blocker probes (beta.12)

`node tools/rig2d_probe_e2e.mjs --out <dir> [--tag before|after]` runs the real runtime in a muted headless Chrome:

- **Blush through every shader path:** plain, lit, outline, particle and attachment, both normal and additive. Every
  path gives the exact composite.
  - Before the fix, the outline path drew ink under the semi-transparent blush (159,103,119 against 178,125,135).
  - The puppet's white cheeks are its own art: an additive pink blush over pale skin saturates to white.
- **Atlas bleed:** an outlined mesh whose art touches its cell edge, next to an inked neighbour cell.
  - Foreign ink: 2353 px before, 0 after. The colour pass with no outline: 547 px before, 0 after (native rigs).
- **Outline stacking:** an outlined mesh over a bigger outlined mesh draws no lines along its geometry box (stray px
  before: 2580; 0 after).
- **Multi-angle views:** a yaw sweep 0° → 18° → 0°.
  - The background never shows through (before: up to 25 %).
  - Two sets share the screen only inside the hand-over band (before: 34 of 74 sweep values outside it).
- **Live2D ladder after these changes:** 145/145 against the Python reference. Against our own earlier renders, 92
  are byte-identical and 53 differ by at most 1/255 (GPU noise), so converted Live2D models are unchanged.

### 3d. Framing in every view + VTube Studio hotkey expressions (beta.12)

- **The bug (realqa party test):** a converted guest was drawn tiny at the far right of its gaming-strip tile, behind
  the chairs.
  - The rig's face measure covered the whole (chibi) head: 1.09 m for the Slime card.
  - The tile cam then added 1.15× that as head room, giving a 2.6 m tall frame for a 1.5 m character.
  - A seated bust was also aimed at where it would stand, not where its card sits.
- **The fix:** the drawn face and head are measured from the rig's meshes (docs/RIG2D_FORMAT.md §9, "Framing"). A
  2D card's head is used as the exact head (`RestMetrics.headExact`) instead of its card box with margins. Seated busts
  are framed at the seat; the TV / monitor crop to head and shoulders; the frame holds every expression.
- **The check** (`tools/rig2d_framing_e2e.mts`, private server, every model imported through the real route, as this
  PC's avatar and as a party guest beside a 3D host). Ground truth is the drawn eyes and mouth, mapped through the exact
  camera of each view.
  - Gaming-strip tile, corner cam, walking TV picture, overlay: the face centre in the safe area, and the face 16–75 %
    of a cam's height.
  - Wide room, talk and interview shots: the face fully in view.
  - Rooms: vtubepro_studio and test_room. Models: the 29 samples and the 4 community models.
  - **Before** (old code, vtubepro_studio): 34 of 66 gaming-strip tiles, 14 of 33 corner cams and 1 of 66 talk shots
    failed (faces 4–14 % of a tile, or below it).
  - **After:** 816 / 816 pass (36 imports × 2 rooms × every view).
  - A face measure missing or wrong is also caught without a browser: `tools/rig2d_face_unit.ts`, 283 checks on every
    model.
- **VTube Studio hotkey expressions** (`tools/rig2d_vts_expr_unit.ts`): Slime (4, on Numpad1–4), liam (5 incl. a
  black-and-white tint) and moth (2, on Ctrl + Left / Right arrow, the same keys as in VTube Studio).
  - Pressed as the studio does, each sets its parameters exactly as its `.exp3.json` says (Add / Multiply /
    Overwrite).
  - Each changes the drawn model and is fully gone after the toggle-off.
  - No two expressions share a key.
  - All of a model's hotkeys on together stack exactly as VTube Studio does (Overwrites in the order they were switched
    on, then every Multiply, then every Add), in the pressed order, the reverse order and with the first one off.
  - Model sliders on the same models (`tools/rig2d_params_probe.ts`): liam's five toggles, Slime's Exclaim / Shadow /
    Cheese toggles and moth's hand raises are offered as sliders too; face expressions stay expressions.
- **Still room-dependent:** a short whole-body character standing in front of a desk chair (its face below the desk's
  line of sight) gets its tile from a higher, side-on angle. The face stays centred and readable, but the angle is
  steeper than for a seated 3D avatar.

### 3e. Real users' models (beta.12 hardening)

Four tools; samples and community models stay outside the repo, and each tool skips when they are absent.

- **Messy uploads** (`npx tsx tools/live2d_chaos_unit.ts [--fuzz N]`): about 90 uploads built in memory from the
  samples go through the real import route on a private port. Each must import (only `model.vtp2` stored; it reads
  back and animates with finite vertices) or be refused with one plain sentence (nothing stored, under 20 s). The
  uploads cover:
  - folders and paths: nested / long / spaced paths, the whole Cubism export tree with 400 MB of PSDs (skipped
    unread), a zip over the 320 MB limit (repacked by the studio first);
  - references: wrong case, backslashes, absolute paths from the artist's PC, URL-encoded names, a renamed texture
    folder, no `Textures` list;
  - names: Japanese / Chinese / Korean / emoji / NFD (macOS) names, Shift-JIS and GBK names without the UTF-8 flag;
  - missing and extra files, junk files, two models plus a broken backup copy, a zip inside a zip, a stored
    (dropped-folder) zip;
  - archives and lone files: rar / 7z / gz / password / LZMA / Cubism 2 / `.cmo3`-only / lone files, cut-off and
    CRC-damaged zips;
  - textures: JPEG / WebP / indexed / 8192 px / 9000 px / not-a-picture;
  - JSON: BOM, comments, trailing commas, numbers as strings, prototype keys, type-confused side files, a
    5,000-curve + 200,000-point motion;
  - behaviour: empty / wrong LipSync + EyeBlink, HitAreas, a VTube Studio packaged model;
  - odd canvases, reference path traversal, a lying zip bomb (stopped in milliseconds), entry floods;
  - a route fuzz: 400 cases, 191 imported, 209 refused with a sentence, 0 bad.
  Result: 716/716 (after the review fixes: one budget across zips in a zip, the studio repack in a worker with an
  inflate budget, every texture checked whole (cut-off / corrupted pictures refused at import), the converted
  container read back before it is stored, resolver ownership + ambiguity).
- **Mapping** (`tools/live2d_mapping_unit.ts`): the per-model report of what drives what, and equivalence tests.
  Hiyori with every parameter id replaced (in the `.moc3` and every side file) moves exactly like the original
  (0.0000 px over 90 tracked frames) when its display names are Japanese, Chinese, Korean or English, with common
  rigger ids and no names, and with ±1 heads / 0..10 mouths. With meaningless ids and only a VTube Studio file, the
  14 parameters that file maps are driven identically. With nothing but the model3.json groups, eyes and mouth still
  work. Haru, Ren, Natori and kei show the same.
- **Runtime** (`tools/live2d_runtime_unit.ts`): every sample and community model; no physics kick at load (< 3 % of
  a parameter's range in the first second, beyond the breathing's own sway), 30 s of wild tracking finite and in
  range, every expression and motion plays, the per-frame cost.
- **Soak on the OBS page** (`tools/live2d_soak_e2e.mts`, muted headless Chrome, private port): the results are in
  the table below.
- **Fixed by these tools:**
  - an sRGB canvas texture upload slow path (3-10 ms per frame per 2D avatar);
  - a light-show material leak (every earlier avatar stayed in memory);
  - blend shapes 6× faster;
  - physics settle;
  - side files VTube Studio loads but `model3.json` doesn't list;
  - string-valued expression values (converted to 0 before);
  - the many upload failures above.

| Soak (RTX 5090, ANGLE D3D11) | Result |
|---|---|
| Load / unload 50× (Mao) | three.js textures 4 → 4, geometries 42 → 42, 2D GPU objects unchanged, JS heap 96.3 → 97.9 MB |
| Switch 50× over 7 models | GPU objects flat, one rig held, JS heap 98.3 → 95.0 MB |
| 30 simulated minutes at 60 fps (talking, blinks, expression / motion cues) | page step p50 0.6-0.7 ms, p99 1.3-2.3 ms; heap 93.8 → 94.1 MB; GPU objects flat |
| Party: 3 Live2D models on one page | one GPU rig each |
| Card / overlay / walking TV / monitor / 2D room, light show + BRB | drawn in every mode |
| Whole OBS-page step, High (Mao / Ren / Gantzert / slime / Hiyori) | 0.8 / 0.7 / 0.9 / 0.7 / 0.6 ms (before: 7.3 / 4.1 / 10.3 / 7.1 / 3.5) |
| Rig CPU per frame at High (animate + evaluate) | 0.14-0.36 ms |

## 4. Known gaps (be honest)

- **Physics feel:** physics settings are converted 1:1, but the strand simulation is VTube Pro's own, so the swing
  can differ from Live2D's (amplitude, settle time). A numeric reference isn't possible in the clean room.
- **Cubism 5 rotation / part / glue blend shapes** (Mao, Ren) are verified only by the pixel gate at the 5 test
  poses, not vertex for vertex.
- **v4 colour keyforms:** read as `colBegin + keyform`, an assumption with no real v4 file to check against.
- **Mask edges:** masks are soft, as in Live2D, rendered at the output resolution.
- **Non-Live2D blend modes:** overlay / darken / lighten / clipToLower / sliceFromLower exist in the format; runtime 1
  draws them as normal. Live2D models use only normal / add / multiply.
- **Not opened (one sentence each instead):** `.rar` / `.7z` / `.gz`, password zips, exotic zip methods, Cubism 2
  models (`.moc`), editor projects (`.cmo3`). Textures over 8192 px are refused for now (the limits live in one place,
  `shared/rig2d/limits.ts`). What a model DECODES is governed by `rig2dDecodeBudget()` there: a model over it still
  loads, its pages decoded one at a time and scaled down to fit (checked in the soak: an 8 MiB budget decodes
  Hiyori's 2048 px pages at 1024 px).
- **Mapping limits:** a model with meaningless parameter ids, no display names and no VTube Studio file gets only
  its eyes and mouth (from the model3.json groups); the head turn then needs one pick in Details. Vowel parameters
  (ParamA / I / U / E / O) follow the voice through the LipSync group only (no per-vowel visemes). Arm / hand
  parameters are not driven by tracking. VTube Studio hotkeys keep their keys, combinations included (Ctrl + Left
  arrow, Ctrl + Shift + B), except a key the studio keeps (Ctrl / Alt + a number, H, Shift + 1–5 …:
  `shared/studioKeys.ts`): that expression gets a free number key instead, and the import says which.
- **Graphics tiers:** Low changes nothing for converted Live2D models (they have no lighting maps or outlines to
  drop); at 0.6-0.9 ms per OBS-page step on the heaviest samples there is nothing to save.
- **Measured on one PC** (RTX 5090). The removed slow paths were CPU-side in the browser's GPU process, so slower
  machines gain more, but their absolute numbers are unmeasured.
