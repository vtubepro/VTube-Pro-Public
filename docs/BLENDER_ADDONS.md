# Blender add-ons for VTube Pro (installed, tested, how to use them from scripts)

Free Blender add-ons that help us build **characters** (VRM avatars, ARKit shape keys, spring-bone hair, retopology)
and **environments** (rooms, buildings, terrain, trees, props, UVs). Everything here was downloaded from the official
source only (extensions.blender.org or the project's own GitHub / download link), checked against Blender **5.1.2**
on this machine on **2026-09-27**, and runs **headless** from our build scripts unless marked otherwise.

- The Blender working rules (lock, `live_ok`, low priority, staging) are in [BLENDER_PLAYBOOK.md](BLENDER_PLAYBOOK.md).
- Helper module: [`blender/addons_util.py`](../blender/addons_util.py). Pinned copies: `tools/vendor/blender_addons/`
  (git-ignored, with `manifest.json` = version, licence, source URL, SHA-256 of every zip).
- **Licences.** All of these are GPL / MIT / BSD **tools**. They run inside Blender while we build; none of their
  code is copied into VTube Pro or shipped with it (same rule as MPFB, playbook section 14). What they *produce*
  (meshes, UVs, shape keys, GLBs) is ours.

Contents
1. [What is installed](#1-what-is-installed)
2. [Using add-ons in a headless build script](#2-using-add-ons-in-a-headless-build-script)
3. [What each one is for in our pipeline (with examples)](#3-what-each-one-is-for-in-our-pipeline-with-examples)
4. [The user's own Blender (GUI)](#4-the-users-own-blender-gui)
5. [Verification](#5-verification)
6. [Evaluated but not installed](#6-evaluated-but-not-installed)
7. [Paid add-ons worth buying (the user's decision)](#7-paid-add-ons-worth-buying-the-users-decision)
8. [Updating / adding an add-on](#8-updating--adding-an-add-on)

---

## 1. What is installed

Key = the name you pass to `addons_util.enable(...)`. "Headless" = its main operator ran under
`blender -b --factory-startup` in the smoke test (section 5).

| Key | Add-on | Version | Licence | Source | Headless |
|---|---|---|---|---|---|
| `vrm` | VRM format (VRM Consortium / saturday06) | 4.7.2 | MIT + GPL-3.0+ | [extensions.blender.org/add-ons/vrm](https://extensions.blender.org/add-ons/vrm/) | yes |
| `textools` | TexTools (renderhjs, franMarz, SavMartin) | 1.6.2-dev (master `89cb4cf`) | GPL-3.0+ | [github.com/franMarz/TexTools-Blender](https://github.com/franMarz/TexTools-Blender) | yes, with `uv_editor_context()` |
| `sapling` | Sapling Tree Gen | 0.3.7 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/sapling-tree-gen/) | yes |
| `antlandscape` | A.N.T. Landscape | 0.2.0 | GPL-2.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/antlandscape/) | yes |
| `building_tools` | Building Tools (ranjian0) | 1.0.13 | MIT | [github.com/ranjian0/building_tools](https://github.com/ranjian0/building_tools/releases/tag/v1.0.13) | yes |
| `looptools` | LoopTools | 4.7.7 | GPL-2.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/looptools/) | yes |
| `extra_mesh` | Extra Mesh Objects | 0.4.1 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/extra-mesh-objects/) | yes |
| `extra_curve` | Extra Curve Objects | 0.2.0 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/extra-curve-objectes/) | yes |
| `print3d` | 3D Print Toolbox (mesh checks) | 1.4.1 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/print3d-toolbox/) | yes |
| `cell_fracture` | Cell Fracture | 0.2.1 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/cell-fracture/) | yes |
| `magic_uv` | Magic UV | 6.7.1 | GPL-2.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/magic-uv/) | yes (edit mode) |
| `ivygen` | IvyGen | 0.1.5 | GPL-2.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/ivygen/) | yes |
| `archimesh` | Archimesh | 1.2.5 | GPL-2.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/archimesh/) | yes |
| `skkeeper` | SKkeeper (apply modifiers with shape keys) | 1.8.2 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/shapekey-keeper/) | yes |
| `arkit_tools` | ARKit Blendshape Helper | 0.7.5 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/arkit-blendshape-tools/) | yes |
| `expr_retarget` | Mesh Expression Retargeter | 1.1.0 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/mesh-expression-retargeter/) | enables; workflow is GUI (landmark picking) |
| `hair_bones` | Hair Bone Generator | 1.2.0 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/hair-bone-generator/) | enables; workflow is GUI (tip marking in the view) |
| `lowpoly_trees` | Generate Tree Plugin (low-poly trees) | 1.1.5 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/generate-tree-plugin/) | yes |
| `mpfb` | MPFB (MakeHuman) | 2.0.17 | GPL-3.0+ | [extensions.blender.org](https://extensions.blender.org/add-ons/mpfb/) | enables; **builds use `blender/human_creator/mpfb_env.py`** (it has the asset packs) |
| `faceit` | **Faceit** (Fynn Braren), PAID, user-supplied licensed copy | 2.3.65 | GPL-3.0+ (paid distribution: never redistribute, never commit) | user's purchase (`tools/vendor/blender_addons/faceit/`) | partly: setup, landmarks, rig yes; bind / bake need a UI-context workaround (section 3a) |
| — | **Instant Meshes** (standalone exe, Jakob / Panozzo / Tarini / Sorkine-Hornung) | 2019-11 Windows build | BSD-3-Clause | [github.com/wjakob/instant-meshes](https://github.com/wjakob/instant-meshes) (Windows binary linked from its README) | yes (CLI batch mode) |

Built into Blender 5.1 (no download; enable the same way): `node_wrangler`, `rigify`, `gltf` (`io_scene_gltf2`,
on by default).

Where the files are:

| What | Path |
|---|---|
| Pinned zips + `manifest.json` (SHA-256, source, licence) | `tools/vendor/blender_addons/` |
| Unpacked copies used by scripts (created on first use) | `tools/vendor/blender_addons/_repo/<id>/` (extensions), `_legacy/<module>/` (TexTools, Building Tools) |
| Instant Meshes | `tools/vendor/instant_meshes/Instant Meshes.exe` + `LICENSE.txt` (SHA-256 `f1fe5b5f56d1002ae61dbd76a3fd646229fc1fe15322e7a3744f8ce442c76b2d`) |
| The user's own Blender profile | `%APPDATA%\Blender Foundation\Blender\5.1\extensions\user_default\<id>\` and `...\5.1\scripts\addons\{TexTools,building_tools}\` |

Bake Wrangler was on the request list but **is no longer free** (Superhive: $25 indie / $40 commercial, GPL; the
author offers a free copy on request if you can't afford it). It was not installed; see section 6 for what we use
instead.

---

## 2. Using add-ons in a headless build script

Team builds run `tools\blender_low.cmd -b --factory-startup --python <script> -- <args>` (playbook 3.1).
`--factory-startup` means **no user add-ons are loaded**, so enable what you need at the top of the script:

```python
import os, sys
import bpy
sys.path.insert(0, r'<VTube Pro folder>\blender')   # or a path relative to your script
import addons_util as au

au.enable('vrm', 'antlandscape', 'building_tools')   # raises RuntimeError listing every attempt if one fails
bpy.ops.mesh.landscape_add(subdivision_x=64, subdivision_y=64, mesh_size_x=30, mesh_size_y=30, height=0.6,
                           noise_type='hetero_terrain', random_seed=11, refresh=True)
```

What `enable()` does (in order, first hit wins):
1. unpacks the pinned zip from `tools/vendor/blender_addons/` (once; re-unpacks when the zip's SHA-256 changes) and
   registers `_repo/` as a **session-only** local extension repo `vtp_vendor` (module `bl_ext.vtp_vendor.<id>`);
   legacy add-ons go on `sys.path` from `_legacy/`. Pinned versions = reproducible builds on any machine that has
   the vendor folder;
2. falls back to the same add-on in the running profile (`bl_ext.user_default.<id>`, `bl_ext.blender_org.<id>`,
   or the legacy module name);
3. core add-ons (`rigify`, `node_wrangler`, `io_scene_gltf2`) come from Blender itself.

It enables with `default_set=True` **for the session only**: several add-ons (VRM, Magic UV, Rigify, MPFB) read their
own AddonPreferences and fail without that. Background Blender never auto-saves preferences, so nothing reaches
anyone's `userpref.blend`. **Never call `bpy.ops.wm.save_userpref()` in a build script.**

Other helpers in `addons_util`:
- `au.module('vrm')` returns the imported add-on package (to call its Python API directly).
- `au.uv_editor_context()` is a context override for operators whose `poll()` wants a UV editor (TexTools, some
  Magic UV ops). Background mode has no window, so it borrows the IMAGE_EDITOR area of the factory "UV Editing" screen:
  ```python
  bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
  with au.uv_editor_context():
      bpy.ops.uv.textools_texel_density_get()
      bpy.ops.uv.textools_island_align_world()
  ```
- `au.instant_meshes(obj, faces=4000)` and `au.run_instant_meshes(src, dst, ...)` (section 3, retopology).
- Check everything at once:
  `tools\blender_low.cmd -b --factory-startup --python "<VTube Pro folder>\blender\addons_util.py" -- --check`
  prints `ADDON <key> OK|FAIL <module|error>` per add-on and a final `VTP_OK {...}` / `VTP_FAIL [...]`. Pass keys
  after `--check` to test only some.

Headless gotchas we hit:
- Operators run without a window: pass parameters to the operator instead of relying on the redo panel; select /
  activate objects explicitly (`o.select_set(True)`, `view_layer.objects.active = o`).
- Some add-ons keep settings on `WindowManager` / `Scene` properties rather than operator arguments
  (IvyGen: `bpy.context.window_manager.ivy_gen_props`; ARKit helper: `scene.ak_driver_mesh`). Set those first.
- SKkeeper replaces the object: re-read `bpy.context.view_layer.objects.active` after it runs.
- Instant Meshes' `-f` sizes the quad-*dominant* mesh; pure-quad output is 4x that. `run_instant_meshes` already
  divides by 4 when `dominant=False` (checked: asking for 600 faces gives 642).
- The low-priority rule still applies: `run_instant_meshes` starts the exe at BELOW_NORMAL priority.

---

## 3. What each one is for in our pipeline (with examples)

All examples assume `import bpy, addons_util as au` and a script run under the Blender lock.

### Characters

**VRM (`vrm`)** — the reference implementation of VRM 0.x / 1.0 for Blender: import VRoid / VRM avatars with
humanoid mapping, expressions (blend-shape groups), spring bones and MToon materials; export VRM with all of that.
Use it for the VRoid-import route (anime quality plan), for inspecting any `.vrm` a user brings, and for exporting
VRM builds. Our GLB avatar contract (AI_CREATOR_GUIDE.md) still decides what the app loads; VRM is an input/output
format beside it.

```python
au.enable('vrm')
bpy.ops.import_scene.vrm(filepath=r'...\tools\vendor\vroid\Sendagaya_Shino.vrm')   # CC0 sample
arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
ext = arm.data.vrm_addon_extension          # .spec_version, .vrm0 (0.x data), .vrm1, .spring_bone1
print(len(ext.vrm0.secondary_animation.bone_groups), 'spring groups')
bpy.ops.export_scene.vrm(filepath=r'...\stage\out.vrm')
```
Tested: Sendagaya_Shino imports (1 armature, 3 meshes, 42 shape keys, 17 VRM0 spring groups) and re-exports
(15 MB) headless.

**SKkeeper (`skkeeper`)** — apply modifiers (Subdivision, Mirror, Solidify, …) to a mesh **that has shape keys**,
which Blender refuses to do. Exactly the step our avatar finishing needs before export when a face has ARKit keys.
```python
au.enable('skkeeper')
bpy.context.view_layer.objects.active = head; head.select_set(True)
bpy.ops.sk.apply_mods_sk()          # all modifiers; sk.apply_subd_sk = only subdivision; sk.apply_mods_choice_sk = pick
head = bpy.context.view_layer.objects.active    # SKkeeper builds a new object
```

**ARKit Blendshape Helper (`arkit_tools`)** — creates the 52 ARKit shape-key names (plus L/R base variants), sorts
keys into ARKit order, mirrors L to R, builds drivers. Useful to check / complete naming on a face that must follow
the ARKit contract.
```python
au.enable('arkit_tools')
bpy.context.scene.ak_driver_mesh = face
bpy.ops.ak.add_arkit_shapes()      # adds missing ARKit keys (empty) and sorts them; existing ones are kept
bpy.ops.ak.autosort_shapes()
```
Note: it adds **empty** keys. Sculpting them is still our face kit's job (`blender/face_kit/`).

**Mesh Expression Retargeter (`expr_retarget`)** — transfers shape keys between meshes of **different topology**
(landmark pairs, or automatic "overlapping surfaces" mode when both are aligned). Candidate for moving a good
ARKit set from one head onto another. The workflow is interactive (pick landmark pairs in the view); in the GUI:
N-panel → Mesh Expression Retargeter. Operators: `mer.build_fit_map`, `mer.transfer_all_shape_keys`, …

**Hair Bone Generator (`hair_bones`)** — builds a deform bone chain along a hair strand (for spring-bone hair).
GUI workflow (you mark the tip in the view); `hair_bone.generate_chain(bone_count=5)`. Our `blender/anime_hair/`
kit already generates strand chains procedurally; this is for hand-fixing a strand in the user's Blender.

**MPFB (`mpfb`)** — MakeHuman human generator. Headless builds must keep using
`blender/human_creator/mpfb_env.py` (private user dirs with the CC0 MakeHuman asset packs). The copy in the user's
profile has no asset packs yet; to add them in the GUI: MPFB panel → Apply assets → pick
`tools\vendor\mpfb\makehuman_system_assets_cc0.zip`. (`au.enable('mpfb')` works, but MPFB then makes empty
user-data folders under `%APPDATA%\...\5.1\extensions\.user\vtp_vendor\mpfb` and has no assets: another reason to
use `mpfb_env.py`.)

**Rigify (core, `rigify`)** — meta-rig → control rig. We don't ship Rigify rigs (the app wants the VRM-style humanoid
skeleton), but it is the fastest way to *pose* a character for reference renders. Tested: human meta-rig +
`pose.rigify_generate` headless.

### Retopology and mesh quality

**Instant Meshes** (standalone) — field-aligned quad remesher. Turns an AI mesh (Tripo / Meshy / Higgsfield) or a
sculpt into clean quads with even edge flow at a target face count; then transfer UVs / weights / shape keys back
with a Data Transfer modifier. Much better starting topology for faces that must deform (mouth, eyes) than
Decimate.
```python
new = au.instant_meshes(obj, faces=4000)            # pure quads ~4000 faces, new object "<name>_im"
new = au.instant_meshes(obj, faces=4000, dominant=True, crease=30)   # tri/quad dominant, keep hard edges
au.run_instant_meshes(r'in.obj', r'out.obj', faces=4000)             # file-to-file, no Blender needed
```
It drops UVs, shape keys and weights (it is a retopology). Also runs outside Blender (plain `subprocess`).

**3D Print Toolbox (`print3d`)** — mesh sanity checks: non-manifold edges, self-intersections, zero faces,
thin walls, distorted faces. Good as an automatic QA step before export (AGENTS.md rule 8: fixes as pipeline steps).
```python
bpy.context.view_layer.objects.active = obj; obj.select_set(True)
bpy.ops.mesh.print3d_check_all()        # or print3d_check_solid / _intersect / _degenerate / _thick ...
report = au.module('print3d').report.get()          # tuple of (name, value, indices, ...) items
problems = {r.name: int(r.value) for r in report if r.indices is not None and r.value.isdigit() and int(r.value)}
# e.g. {'Non-manifold Edges': 12, 'Intersect Faces': 4}
```

**LoopTools (`looptools`)** — relax / space / circle / flatten / bridge / curve on selected loops (edit mode).
`bpy.ops.mesh.looptools_relax(iterations='3')`, `looptools_circle()`, `looptools_space()`. Handy after procedural
cuts (eye / mouth rings on a head, road edges).

### UVs and textures

**TexTools (`textools`)** — texel density get / set, island align / straighten / rectify, UV crop / fill,
checker maps, and bakes of ID / AO / curvature / normal maps. Most operators want a UV editor: wrap them in
`au.uv_editor_context()` (section 2). Tested headless: `textools_texel_density_get`, `textools_island_align_world`
(`textools_uv_unwrap` still refuses outside a real window — use `bpy.ops.uv.unwrap()` / `smart_project()` instead).
Latest tag (1.6.1) predates Blender 4.2; we pinned master (1.6.2-dev) which has the 4.3 Principled BSDF bake fixes.

**Magic UV (`magic_uv`)** — UV copy / paste between meshes, pack while keeping identical islands overlapped,
world-scale UV (same texel size across props), align / flip / rotate islands. `bpy.ops.uv.muv_pack_uv()` tested
headless in edit mode.

### Environments (rooms, Trail, props)

**A.N.T. Landscape (`antlandscape`)** — noise terrain (hetero terrain, ridged multifractal, …) as a mesh, plus
displace of existing meshes. Base ground for rooms / Trail stops before we sculpt paths and bake vertex colours.
```python
bpy.ops.mesh.landscape_add(subdivision_x=128, subdivision_y=128, mesh_size_x=20, mesh_size_y=20, height=2.0,
                           noise_type='hetero_terrain', random_seed=3, refresh=True)
```

**Building Tools (`building_tools`)** — procedural buildings: floorplan → floors → windows / doors / balconies /
roof, each on selected faces in edit mode. Fast blockouts of houses, forts, shop fronts for the Trail and rooms.
It also has a Python API (`building_tools.btools.api`: `create_floorplan`, `create_floors`, …).
```python
bpy.ops.btools.add_floorplan(); house = bpy.context.active_object
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.btools.add_floors()
# select the wall faces you want (bmesh), then:
bpy.ops.btools.add_window()          # or add_door, add_balcony, add_roof
bpy.ops.object.mode_set(mode='OBJECT')
```

**Archimesh (`archimesh`)** — parametric rooms (walls with openings), doors, windows, stairs, shelves, kitchen
cabinets, columns, lamps. `bpy.ops.mesh.archimesh_room()`, `archimesh_door()`, `archimesh_window()`,
`archimesh_stairs()`, `archimesh_shelves()` all tested headless. Good for interior blockouts (talk-show sets,
kitchens) before our own detailing and vertex-colour bake.

**Generate Tree Plugin (`lowpoly_trees`)** — low-poly stylised trees and pines as meshes (`treegen.generate()`,
~2.5k tris each with defaults) — the Trail look. **Sapling (`sapling`)** — parametric realistic trees (curves →
convert to mesh): `bpy.ops.curve.tree_add(do_update=True, bevel=True, levels=2, seed=7)`.
**IvyGen (`ivygen`)** — ivy growing over a wall from the 3D cursor (settings on
`bpy.context.window_manager.ivy_gen_props`, then `bpy.ops.curve.ivy_gen(updateIvy=True)`).

**Extra Mesh / Extra Curve Objects (`extra_mesh`, `extra_curve`)** — gears, pipes, step pyramids, round cubes,
twisted torus, spirals, braids, torus knots, profiles. Quick prop parts (millstones, cogs, railings).

**Cell Fracture (`cell_fracture`)** — Voronoi shatter: rubble piles, broken crates, destroyed walls (EFT Customs,
space battle debris). `bpy.ops.object.add_fracture_cell_objects(source={'VERT_OWN'}, source_limit=20)`.

**Node Wrangler (core)** — node-editor helpers for people working in the GUI; nothing for scripts.

### Worked example (tested)

A tiny roadside scene built only with add-ons and exported as one GLB (terrain + house with floors and windows +
low-poly tree + Sapling tree + gear millstone, then a 3D-Print-Toolbox check read back from its report):
[`blender/addons_example.py`](../blender/addons_example.py). Tested: 17 objects, 16,686 tris, 15 draw calls, glTF
validator 0 errors / 0 warnings. The QA step already earns its keep: it reports 4 non-manifold edges on the Building
Tools house (its window cut-outs leave open borders), which is fine for a vertex-colour-baked room prop but would
need `mesh.fill_holes` before a boolean or a solidify.
```text
tools\blender_low.cmd -b --factory-startup --python "<VTube Pro folder>\blender\addons_example.py" -- C:\path\to\stage\example_env.glb
node tools/gltf_validate.mjs C:\path\to\stage\example_env.glb
```

---

### 3a. Faceit (paid, user-supplied): ARKit 52 + tongue + phoneme shape keys on any face

- **Files.** The zip is pinned at `tools/vendor/blender_addons/faceit/faceit-release-v2.3.65.zip`: git-ignored (`/tools/vendor/`), listed in `manifest.json` as key `faceit`, kind `legacy`.
  - `addons_util` unpacks it to `_legacy/faceit` on first use.
  - It is the user's licensed copy: **do not commit, copy into `dist/`, or ship it**.
  - Our scripts only call its operators; the baked shape keys are our data.
- **Enable headless.**
  ```python
  au.enable('faceit')
  ```
  Or check it from the shell: `tools\blender_low.cmd -b --factory-startup --python blender\addons_util.py -- --check faceit` prints `ADDON faceit OK`. That check passed, 2026-09-27.
- **Pipeline.**
  1. Register the face objects and vertex groups (`faceit_main`, eyeballs, teeth, tongue, eyelashes, ...).
  2. Landmarks.
  3. Generate rig.
  4. Bind (`faceit.smart_bind`).
  5. Load expressions (`faceit.append_action_to_faceit_rig`, `expressions_type` = `ARKIT` / `TONGUE` / `PHONEMES` / custom; `auto_scale_anime_eyes` for anime eyes).
  6. Bake (`faceit.generate_shapekeys`).
- **Headless status (tested 2026-09-27).**
  - Steps 1–3 run headless:
    - Setup is plain property / vertex-group writes.
    - The landmark GUI (click-placing a template in the front view) is replaced by fitting the template to feature points we compute, then ray-projecting it onto the face.
    - `faceit.generate_rig` runs with `EXEC_DEFAULT`.
  - `faceit.smart_bind` **fails in background mode**: it sets `context.space_data.overlay.show_relationship_lines`, and there is no 3D view.
  - The workaround is to call the operator class's `execute()` with a proxy context whose `space_data` is a dummy. It is written but not yet run: running it is waiting on the user's OK to execute the add-on's code outside its normal operator path.
- **Recipe and state:** `faceit_headless.py` + `NOTES.md` (session scratch `S\faceit\`).
- **What the app can drive.**
  - ARKit 52 by name.
  - `tongueUp` / `tongueTip` speech extras, when a model has those morphs.
  - Visemes / emotions for non-ARKit models.
  - Faceit's other expressions (custom / "unlimited") need an engine hook before they do anything in the app.
- **User's own Blender.** Faceit is not yet installed in the user profile. To install it, close Blender first, then run `blender.exe -b --python blender\addons_util.py -- --install-user faceit`.

## 4. The user's own Blender (GUI)

The same add-ons are installed and enabled in the user's Blender 5.1 profile (extensions in the "User Default"
repository, TexTools and Building Tools as legacy add-ons). **Restart Blender** to see them (Edit → Preferences →
Add-ons). (Blender was closed when they were installed on 2026-09-27, so nothing should overwrite the new list.)
If any are ever missing, tick them in Preferences → Add-ons, or rerun the installer with Blender closed:

```text
"C:\Program Files\Blender Foundation\Blender 5.1\blender.exe" -b --python "<VTube Pro folder>\blender\addons_util.py" -- --install-user
```

(No `--factory-startup` here on purpose: it loads the user's preferences, installs + enables the vendored zips and
saves the preferences. It refuses to run with `--factory-startup`. The preferences from before the first install
are backed up at `tools/vendor/blender_addons/userpref_backup_2026-09-27.blend`; to undo everything, close Blender,
copy that file over `%APPDATA%\Blender Foundation\Blender\5.1\config\userpref.blend` and delete the add-on folders
listed in section 1. Nothing else in the preferences was changed. The user's Blender MCP add-on refuses to start its
server in background mode, so the install run never opened port 9876.)

Where to find them in the GUI: VRM → File → Import/Export and the N-panel "VRM" tab; TexTools → UV editor N-panel;
Building Tools → 3D view N-panel "Building Tools"; Sapling / A.N.T. / Archimesh / Extra objects / IvyGen → Add menu
(Shift+A) and the N-panel; LoopTools → edit-mode right-click menu; Magic UV → UV editor N-panel; 3D Print Toolbox →
N-panel "3D-Print"; SKkeeper → Object → Apply; ARKit helper, Hair Bone Generator, Expression Retargeter,
MPFB → N-panel tabs.

---

## 5. Verification

Headless smoke test (2026-09-27, Blender 5.1.2, `--factory-startup`, via `addons_util.enable`): **23 / 23 passed** —
every add-on above enabled and its main operator returned `FINISHED` with geometry / data as expected (VRM round
trip, TexTools texel density + align with `uv_editor_context`, Sapling tree, A.N.T. 128² terrain, Building Tools
floorplan + floors, LoopTools relax, gear + step pyramid, spirals, 3D-print checks, 9-cell fracture, Magic UV pack,
ivy, Archimesh room / door / window / stairs / shelves, SKkeeper subdivision with 2 shape keys kept, 71 ARKit keys
added, low-poly tree, MPFB enabled (143 operators), Node Wrangler, Rigify generate, glTF export, Instant Meshes
600-face request → 642 quads). The test script and log are in the addons workstream folder; re-run the quick check
any time with `-- --check` (section 2).

`addons_util.py -- --check`: 22 / 22 keys `OK` (`VTP_OK {"all_ok": true, ...}`).

User's profile (Blender started without `--factory-startup`, after `--install-user`): all 19 add-ons listed as
enabled next to the user's existing ones (Cycles, FBX / glTF / BVH / SVG / UV-layout I/O, Pose Library, Blender MCP
— unchanged), and the VRM, TexTools, Building Tools, A.N.T., Sapling, Archimesh, low-poly tree, Extra Mesh, Cell
Fracture, SKkeeper, ARKit helper and MPFB operators were found / ran `FINISHED` there too.

Known non-issues printed in logs: TexTools prints two `SyntaxWarning: invalid escape sequence` lines on import
(Python 3.13 warning in its code); at Blender exit a few `ImagePreviewCollection ... left open` ResourceWarnings
(add-ons that don't free their icon previews) and sometimes a LoopTools `unregister_class` traceback. All happen
after your script has finished and don't affect results; check your own success marker (playbook 3.3).

---

## 6. Evaluated but not installed

| Add-on | Why not (now) |
|---|---|
| **Bake Wrangler** | No longer free (Superhive $25 / $40, GPL). Our room pipeline bakes lighting to vertex colours with our own `mk_lib.py bake`; TexTools covers ID / AO / curvature map bakes. Worth it only if we move to texture-atlas bakes at scale. |
| **Sverchok** (GPL, v1.4.0) | Node-based parametric modelling for people in the GUI; our builds are Python + geometry nodes already. Reported not activating on Blender 5.1 (ModuleNotFoundError, issue #5371). |
| **BlenderGIS** (GPL) | Real-world DEM / OSM import. Our terrain is stylised and procedural (A.N.T. + our Trail code); it needs network access and optional GDAL. Revisit only for a real-place map. |
| **UV-Packer** (free, closed-source exe) | Replaced by "UnwrellaConnect + Packer-IO", downloaded from uv-packer.com only (not an authorised source for this task). Blender 5.1's own `uv.pack_islands` (concave shapes, rotation) + Magic UV are good enough for our budgets. |
| **Real Snow** | No longer on the extensions platform for 5.x; snow is a runtime environment effect in the app. |
| **Poly Haven Asset Browser** add-on | Paid. We already vendor CC0 Poly Haven assets (`tools/vendor/polyhaven/`) and have Poly Haven skills for agents. |
| **Botaniq** / Geo-Scatter plant packs | Paid (Geo-Scatter's free *Biome-Reader* + free Plant-Library exist; not on the authorised sources list). Low-poly trees + Sapling cover the Trail. |
| **Goo Engine**, Paper Anime Render Helper, line-art modifiers | Anime shading / outlines inside *Blender's* renderer. The app renders with three.js (MToon-style shaders, our own outlines), so Blender-side NPR doesn't reach the stream. |
| **Cats Blender Plugin / Avatar Toolkit** (teamneoneko) | VRChat / MMD avatar prep (PMX import, atlasing, visemes). VRM add-on + our kits cover VRM; MMD models are usually licence-restricted. |
| **MMD Tools** | PMX / VMD import; same licence problem with most MMD content. |
| Shape Key Helper, Apply-modifiers-with-shape-keys, ShapeKey Copy, Pose Shape Keys | Overlap with SKkeeper + ARKit helper + our face kit. |
| Geonode To Shapekey | Niche: bakes geometry-node deformation into shape keys for glTF. Keep in mind for procedural facial deformers. |
| Bake To Single Material, Image Packer, LODGen / expLODe, Vertex Color Forge | Our export pipeline already joins materials, bakes vertex colours and decimates in script. |
| PolyQuilt, F2, Auto Mirror, Snap Utilities Line, Edit Mesh Tools, Hardflow, Bool Tool | Good interactive modelling helpers for a human in the GUI; no value to scripted builds. Install on request. |
| Modular Tree (MTree), Easy Tree, Space-colonization tree | Heavier / native-binary tree generators; the two installed tree tools cover our styles. |
| Wiggle Bones / Jiggle Physics / EXea Jiggle | Preview secondary motion inside Blender; the app runs its own spring bones. |
| CloudRig, Mixamo Rig, Retarget, EasyWeight | Rigging workflows we don't use (VRM humanoid skeleton + our autorig). EasyWeight is a nice GUI weight-paint helper. |
| MB-Lab | Unmaintained for 4.x / 5.x; MPFB is the maintained MakeHuman route (already vendored). |
| mmgpy (adaptive remeshing), Relief Rebake | Instant Meshes covers remeshing better for characters. |

---

## 7. Paid add-ons worth buying (the user's decision)

Prices from Superhive (formerly Blender Market) / the vendor, checked 2026-09-27. All four support Blender 5.x.

| Add-on | Price | What it would give us | Verdict |
|---|---|---|---|
| **Faceit** | $78 (1.8, ARKit expressions) · $99 (2.3, unlimited expressions) · $289 studio | Generates the 52 ARKit shape keys on any face from a few landmark clicks, plus a face rig and mocap import. Directly the "ARKit on any avatar" step. | **Most valuable for characters.** GPL code. Mostly GUI-driven (landmark placement), so our scripts would use its output rather than drive it headless; test scriptability before relying on it. |
| **Auto-Rig Pro** | $25 Lite · $50 Full (yearly updates at 25%) | Smart auto-rig from mesh recognition, game-engine / glTF export, animation retargeting (Remap) from BVH / FBX. | Useful for retargeting mocap / NPC clips and fast rigs of odd characters; our autorig + VRM route already covers humanoids. Buy Full if NPC animation work grows. |
| **Quad Remesher** (Exoside) | $59.90 indie perpetual · $109.90 pro perpetual · $15.99 / 3 months | Best-in-class automatic quad retopology (edge-loop guides, symmetry, density painting). | Clear quality step over Instant Meshes for AI meshes and faces. Command-line / API use exists; worth it if we retopo AI characters often. |
| **Geo-Scatter** | $99 individual · $299 team | Scatter / biome system (grass, forests, rocks) with camera-based LODs; free Biome-Reader for reading biomes. | Nice for dense outdoor rooms, but our scatter must end up as baked GLB instances for three.js anyway; geometry nodes + our code do that. Lowest priority. |

---

## 8. Updating / adding an add-on

1. Download the new zip **only** from extensions.blender.org (`https://extensions.blender.org/api/v1/extensions/`
   lists `archive_url` + `archive_hash` for Blender 5.1) or the project's official GitHub release. Check the
   licence (GPL / MIT / BSD / Apache only) and `blender_version_min/max`.
2. Put it in `tools/vendor/blender_addons/`, add / update its entry in `manifest.json` (key, kind
   `extension|legacy`, module, version, licence, source, download URL, file, sha256), and add a row to
   `ADDONS` in `blender/addons_util.py` if it is new.
3. Run the check with the Blender lock: `... addons_util.py -- --check <key>`; add a smoke line for its main
   operator to your own test script.
4. For the user's Blender: `blender.exe -b --python blender\addons_util.py -- --install-user <key>` with their
   Blender closed.
5. Update the tables in this file.
