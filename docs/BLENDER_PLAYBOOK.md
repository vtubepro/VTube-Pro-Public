# VTube Pro — Blender playbook for AI agents (models, costumes, props, rooms, NPCs)

> AI creation packages (a Blender build script VTube Pro runs locally after an approval click): docs/AI_CONNECT.md.

This is the working manual for **any AI coding agent** (GPT-6 Astra / Codex, Grok Build, Claude, Gemini, Cursor, …)
that builds content for VTube Pro in Blender. It is about *how to work*: the machine, the safety routine, the script
patterns that are proven in this repo, the conventions, testing in the app, and handing work over.

- **What** the engine expects (node names, profile fields, morph names, budgets) lives in
  [AI_CREATOR_GUIDE.md](AI_CREATOR_GUIDE.md) (characters, costumes, rooms, NPCs) and [SCENES.md](SCENES.md) (every room
  system). This playbook links to them instead of repeating them.
- Runnable, tested scripts for every worked example below are in **[BLENDER_EXAMPLES.md](BLENDER_EXAMPLES.md)**.
- Third-party add-ons (VRM, TexTools, Building Tools, A.N.T. Landscape, Sapling, SKkeeper, Instant Meshes, …) and how
  to enable them in a `--factory-startup` script (`blender/addons_util.py`): **[BLENDER_ADDONS.md](BLENDER_ADDONS.md)**.
- Per-agent quick starts: agents/GPT6_ASTRA.md, agents/GROK_BUILD.md.
- [AGENTS.md](../AGENTS.md) (repo root) overrides anything here.

Everything in this file was checked on this machine on 2026-09-26 (Blender 5.1.2, Python 3.14, Node 24, Windows 11).

Contents
1. [The five rules that protect the stream](#1-the-five-rules-that-protect-the-stream)
2. [Machine and tools](#2-machine-and-tools)
3. [Running Blender: headless, locked, or in a live window](#3-running-blender-headless-locked-or-in-a-live-window)
4. [Coordinates, units, colours and glTF export](#4-coordinates-units-colours-and-gltf-export)
5. [Props](#5-props)
6. [Rooms (environments)](#6-rooms-environments)
7. [Light baking, materials, EMIT groups and textures](#7-light-baking-materials-emit-groups-and-textures)
8. [Costumes and accessories](#8-costumes-and-accessories)
9. [Avatars and characters](#9-avatars-and-characters)
10. [NPCs and animation clips](#10-npcs-and-animation-clips)
11. [Testing in the app renderer](#11-testing-in-the-app-renderer)
12. [Review protocol and evidence](#12-review-protocol-and-evidence)
13. [Delivering: staging, install scripts, handoff](#13-delivering-staging-install-scripts-handoff)
14. [Licences and AI services](#14-licences-and-ai-services)
15. [Pitfalls we already paid for](#15-pitfalls-we-already-paid-for)
16. [Command cheat sheet (PowerShell and bash)](#16-command-cheat-sheet-powershell-and-bash)

---

## 1. The five rules that protect the stream

The person who runs this app streams with it. The studio (`localhost:5190`), the server (`127.0.0.1:5191`) and OBS
(`127.0.0.1:5191/output.html`) may be live while you work. These rules come from real incidents.

1. **Check the live state before anything heavy.** `python tools/live_ok.py` prints one line and exits 0 or 1:
   - `IDLE (studio not tracking / no fresh data)`: the user is not tracking. Heavy work is fine.
   - `OK`: the studio is tracking — **the user may be on air**. Headless low-priority Blender is allowed; no GUI
     Blender windows, no GPU renders (Eevee / Cycles), at most one test tab.
   - `STRUGGLING` (exit 1): tracking is suffering. Stop and retry in 30 s.
   Run it before every Blender run, headless browser, big build or render.
2. **Never touch the user's data or live state.** Don't edit `library/`, `cache/`, `config/`, `dist/`. Don't save
   files under `src/`, `server/`, `shared/`, `relay/` in the live tree (a save hot-reloads the studio or restarts the
   server). Don't call `PUT /api/avatars/*`, `PUT /api/scene`, `POST /api/command`, or the MCP tools `update_avatar`,
   `set_costume`, `send_command`, `import_*`, `generate_avatar`, `autorig`, or
   `blender_run_python` with `saveAs`. Don't open `http://localhost:5190/` without `?observer=1`.
3. **One Blender job at a time, at low priority, on the CPU.** Take the Blender lock (section 3.2), run through
   `tools\blender_low.cmd`, release the lock the moment the run ends.
4. **Stage, don't overwrite.** New content goes to a staging folder first. You replace a shipped asset in place only
   when the user asked for exactly that, and you back up the original first. Code changes ship as an install script
   that the user runs (section 13).
5. **Never touch a Blender you did not start.** The user may have their own Blender open with unsaved work. Don't
   close it, script it or send it input. Only stop processes you started yourself.

Also: no git commits, pushes, package installs or downloads unless the user asks. Quality rules (carved mouths,
flat drawn teeth, drawn faces, 8-angle review) are in section 9 and section 12.

---

## 2. Machine and tools

| Thing | Where / version | Notes |
|---|---|---|
| Repo root | `<VTube Pro folder>` | the path has a **space**: always quote it |
| Blender | `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe` (5.1.2) | not on PATH. Headless runs use `tools\blender_low.cmd` |
| Low-priority wrapper | `tools\blender_low.cmd` | `start "" /low /b /wait blender.exe %*`. **It always exits 0**: detect failures from the log (section 3.3) |
| Python | `python` = 3.14 (`C:\Python314`) | numpy, Pillow, scipy, opencv present. Used by texture painters, review tools, face kits |
| Node | `node` 24, `npx tsx`, `npx tsc`, `npx vite` | `npm run typecheck` = `npx tsc --noEmit -p .` |
| glTF validator | `node tools/gltf_validate.mjs <file.glb>` | Khronos validator, prints errors / triangles / draw calls as JSON |
| Blender kits | `blender/` | `costume_kit.py`, `face_kit/`, `anime_hair/`, `anime_creator/`, `cleanup_lib.py`, `avatar_polish.py`, `finish_generated.py`, `autorig.py`, `live2d/` |
| Review tools | `tools/review_character.py`, `tools/check_costume.py`, `tools/cam_eval/`, `blender/review_avatar.py`, `blender/rig_review.py` | section 12 |
| Vendored CC0 sources | `tools/vendor/` (git-ignored): `vroid/` (6 CC0 VRoid samples), `quaternius/` (Universal Base Characters + Animation Library 1 and 2), `polyhaven/`, `kaykit/`, `kenney/` | read only |
| CC0 prop library | `assets/library/props/<kit>/` (git-ignored, optional pack) | [ASSET_LIBRARY.md](ASSET_LIBRARY.md) |
| Room build scripts | `assets/scenes/<id>/blender/*.py` | the best teachers: `my_kitchen_room/blender/mk_room.py` + `mk_lib.py` + `mk_paint.py` |

Run Python kits **from the repo root**, never from inside `blender/`: `blender/inspect.py` shadows the standard
library's `inspect` module.

Blender 5.1 prints `DeprecationWarning: 'Material.use_nodes' is expected to be removed in Blender 6.0` for the
node-material pattern used everywhere here. It is harmless in 5.1.

---

## 3. Running Blender: headless, locked, or in a live window

### 3.1 Headless (the default)

```text
tools\blender_low.cmd -b --factory-startup --python <ABSOLUTE path to script.py> -- <your args>
```

- `--factory-startup` always: no user add-ons or preferences leak into your build.
- Your script reads its own arguments after `--`:
  `ARGV = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []`.
- Give Blender **real absolute paths**. It cannot import through directory junctions, and private test trees use
  junctions.
- From Git Bash, wrap it in `cmd //c "tools\\blender_low.cmd -b --factory-startup --python C:\\...\\x.py -- args"`.
- Keep each run short (one build or one render). Don't start a second Blender while one runs.

### 3.2 The Blender lock (team etiquette)

Several agents may work on this machine at once. Exactly one Blender job may run at a time.

- **Lock** = a directory, created atomically (`mkdir` fails if it exists). Path: `%VTP_BLENDER_LOCK%` if that
  environment variable is set (a coordinator or the user may set it for everyone), else
  `%TEMP%\vtp_blender.lock` (= `%TEMP%\vtp_blender.lock`). If the user or a coordinating
  agent names a different lock path, use theirs.
- Write `<your agent name> <what> <time>` into `owner.txt` inside it.
- If the lock exists, wait 30 s and retry. Also wait while any other **headless** `blender.exe` (command line
  contains ` -b `) is running: someone may be using a lock you don't know about. A GUI Blender without `-b` is
  probably the user's own window: leave it alone and don't wait for it.
- Remove the lock directory as soon as your run ends, also on errors (`finally`). Don't hold it while you think.

PowerShell (tested):

```powershell
$lock = if ($env:VTP_BLENDER_LOCK) { $env:VTP_BLENDER_LOCK } else { "$env:TEMP\vtp_blender.lock" }
$log  = "$env:TEMP\vtp_build_$(Get-Date -Format yyyyMMdd_HHmmss).log"
python tools/live_ok.py; while ($LASTEXITCODE -ne 0) { Start-Sleep 30; python tools/live_ok.py }
while (Get-CimInstance Win32_Process -Filter "Name='blender.exe'" | Where-Object { $_.CommandLine -match '\s-b\s' }) { Start-Sleep 30 }
while ($true) { try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null; break }
                catch { Write-Host "Blender lock held by $(Get-Content "$lock\owner.txt" -ErrorAction SilentlyContinue)"; Start-Sleep 30 } }
"gpt6-astra build_my_room $(Get-Date -Format s)" | Set-Content "$lock\owner.txt"
try {
  & .\tools\blender_low.cmd -b --factory-startup --python "$PWD\assets\scenes\my_room\blender\build_my_room.py" -- --out "$PWD\..\stage\my_room" *> $log
  if (Select-String -Path $log -Pattern 'Traceback' -Quiet) { throw "Blender script failed - see $log" }
} finally { [System.IO.Directory]::Delete($lock, $true) }
```

Git Bash (the form other agents here use):

```bash
LOCK="${VTP_BLENDER_LOCK:-$TEMP/vtp_blender.lock}"
until python tools/live_ok.py; do sleep 30; done
until mkdir "$LOCK" 2>/dev/null; do echo "lock busy: $(cat "$LOCK/owner.txt" 2>/dev/null)"; sleep 30; done
echo "grok-build build_my_room $(date -Is)" > "$LOCK/owner.txt"
trap 'rm -rf "$LOCK"' EXIT
cmd //c "tools\\blender_low.cmd -b --factory-startup --python C:\\path\\to\\build_my_room.py -- --out C:\\path\\to\\stage\\my_room" > build.log 2>&1
grep -q Traceback build.log && { echo "Blender script failed"; tail -30 build.log; }
rm -rf "$LOCK"; trap - EXIT
```

A reusable Python wrapper that waits for `live_ok`, takes the lock from `VTP_BLENDER_LOCK`, runs the script at low
priority, streams the log and turns a `Traceback` into a non-zero exit exists locally at
`(an internal build)` (git-ignored build folder; copy it, don't import it):
`python run_blender.py <script.py> [args...]` with `VTP_BLENDER_LOCK` / `VTP_BLENDER_OWNER` set.

### 3.3 Detecting failure

`blender_low.cmd` exits 0 even when your script raises (checked: `--python-exit-code 3` works on `blender.exe`
directly but the wrapper still returns 0). Always:
- grep the log for `Traceback`;
- print one unmistakable success line at the end of the script (`print('ROOM_OK', tris, bytes)`) and check for it;
- inspect the output file (`node tools/gltf_validate.mjs out.glb`).

### 3.4 The live window (the user wants to watch builds)

The user asked to **watch** builds happen, especially rooms: a visible Blender window that builds the room step by
step, the viewport easing onto each new part, the header showing `Building 3/6: <step>`. Every new room must be built
this way at least once, **when the user is off air** (`live_ok` says IDLE) or when they ask for it.

The pattern (from `assets/scenes/my_kitchen_room/blender/mk_room.py`, reduced in
[BLENDER_EXAMPLES.md → Example B](BLENDER_EXAMPLES.md#example-b--a-small-room-headless-or-live-window)):

```python
STEPS = []
def step(title, focus=(0, 1.2, 0), dist=12.0, yaw=20.0, pitch=62.0):     # focus in glTF coordinates
    def deco(fn):
        STEPS.append((title, fn, focus, dist, yaw, pitch)); return fn
    return deco

@step('Shell: floor, walls, ceiling', (0, 1.0, 0), 14, 25, 60)
def shell(): ...

def main():
    reset()
    if LIVE and not bpy.app.background:          # GUI: one step per timer tick, the UI stays responsive
        bpy.app.timers.register(live_setup, first_interval=0.5)                  # solid shading, cavity, no grid
        bpy.app.timers.register(orbit_tick, first_interval=1.0, persistent=True) # eases the view to the step focus
        bpy.app.timers.register(live_step, first_interval=2.0)                   # header text, then run the step
    else:                                          # headless: run every step in order
        for title, fn, *_ in STEPS: fn()
```

- `live_step` sets `area.header_text_set('Building %d/%d: %s' % …)` and **returns** the delay until the next step
  (return `0.6` once to show the header before a long step, `None` to stop). Wrap each step in `try` and show
  `FAILED at <step>` in the header on error.
- Hide the ceiling / front wall with `hide_set(True)` after each step ("dollhouse" view) and switch the viewport to
  `shading.color_type = 'VERTEX'` after the bake step so the baked light shows. `unhide_all()` before joining,
  baking and exporting.
- Launch it as a normal (not `-b`) Blender at below-normal priority, never touching the user's own window:

```powershell
$blender = Join-Path $env:ProgramFiles 'Blender Foundation\Blender 5.1\blender.exe'
$script  = "$PWD\assets\scenes\my_room\blender\build_my_room.py"
$p = Start-Process $blender -ArgumentList "--factory-startup --python `"$script`" -- --live" -PassThru
$p.PriorityClass = 'BelowNormal'
```

  (Pass the whole argument list as one string with embedded quotes: Windows PowerShell 5.1 does not quote array
  elements that contain spaces.) Hold the Blender lock until the log says the export finished; the window may stay
  open afterwards for the user to orbit. Close only your own instance (`Stop-Process -Id $p.Id`), and only when the
  user is done looking.
- Test the same script headless first. The live runner and the headless runner must produce the same file (checked
  for Example B: same 4,422 triangles either way).

---

## 4. Coordinates, units, colours and glTF export

### 4.1 Spaces

| | Up | Front (what faces the camera) | Character left | Units |
|---|---|---|---|---|
| glTF / the engine | +Y | **+Z** (stage front; avatars face +Z) | +X | metres |
| Blender | +Z | **−Y** | +X | metres |

- Write build scripts in **glTF coordinates** and convert with one helper, as every room here does:
  `def G(x, y, z): return Vector((x, -z, y))` (glTF → Blender). Sizes too: a box of glTF size `(sx, sy, sz)` is
  Blender size `(sx, sz, sy)`.
- An empty's glTF +Z is its local Blender −Y. So an anchor with `rotation_euler = (0, 0, radians(yaw))` faces the
  stage front at yaw 0 and turns towards +X for positive yaw.
- Cameras look down their local −Z: `cam.rotation_euler = (G(*target) - G(*pos)).to_track_quat('-Z', 'Y').to_euler()`;
  `sensor_fit = 'VERTICAL'`, `angle_y = radians(vfov)` (the engine reads vertical fov; 35–46° is typical).
- Export with `export_yup=True`. Characters in Blender face −Y with +X = the character's left, feet at z = 0.
- Custom properties on objects (`ob['pose'] = 'sit'`) and materials become glTF `extras` with `export_extras=True`;
  the engine reads them as `userData`. Lists work (`approach = [x, y, z, x, y, z]`).
- Origins matter: door leaves rotate about their origin (put it on the hinge), `SPOT_xx` origins are the feet on the
  floor, props and foliage should have their origin at the base (the environment engine sways around it). Move an
  origin without moving geometry: `ob.data.transform(Matrix.Translation(-d)); ob.location += d`.

### 4.2 Colours

glTF colour factors are **linear**. Writing an sRGB hex value straight into `baseColorFactor` renders too light
("black" 0.07 becomes mid-grey — the eyepatch incident). Convert every hex colour:

```python
def lin(h):
    h = h.lstrip('#'); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)
```

Image textures are sRGB (the exporter tags them); only factors need `lin()`. Vertex colours (`COLOR_0`) are linear
multipliers.

### 4.3 Export settings by content type

Filter options through the exporter's own property list so a renamed option never crashes a build:

```python
ok = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in ok or k == 'filepath'})
```

| Content | Key options | Notes |
|---|---|---|
| Room `scene.glb` | `export_yup, export_apply, export_extras, export_cameras=True, export_lights=False, export_vertex_color='ACTIVE', export_all_vertex_colors=False, export_animations=False` (True + `export_animation_mode='ACTIONS'` for room clips), `use_selection=True` on an `EXPORT` collection | lights are `LIGHT_*` nodes, never punctual lights |
| Prop GLB | `export_yup, export_apply, export_extras, export_lights=False, export_cameras=False` | origin at the base |
| Costume | `costume_kit.export_costume()` only | exports costume meshes + the FULL base armature with the identical rest pose |
| NPC with clips | `export_skins=True, export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True, export_anim_single_armature=True, export_reset_pose_bones=True, export_apply=False, export_morph=False` | one action per clip, every bone keyed (mk_frogs.py) |
| Avatar GLB | skins + morphs on, `export_morph_normal=False` | morph normals off (proxy normals would be overwritten) |

### 4.4 GLB post-processing

The exporter can't write every field the engine wants. Rooms patch the GLB JSON chunk after export
(`read_glb` / `write_glb`, 20 lines, in Example B): exact `emissiveFactor` + `KHR_materials_emissive_strength` and
`extras {group, color}` on `EMIT_*` materials, `alphaMode` MASK for sign atlases, BLEND + zero alpha for hidden
collider materials, metallic 0 on everything that isn't metal, an `asset.extras` provenance note, then a triangle
count from the accessors. Always re-read the file afterwards and validate it.

---

## 5. Props

A prop is either part of a room build (built by the room script, joined into a bucket, baked with the room) or a
stand-alone GLB (for review, for reuse, or for `assets/library`). Rules:

- Metres, front = glTF +Z, origin at the base centre, on the floor (y = 0).
- Low poly with bevels only where the silhouette needs them. Rooms are ≤ 80k visible triangles in total.
- One material per look, colours through `lin()`, flat cel-friendly colours. Glowing parts use an `EMIT_<group>`
  material; the fixture node itself is `LIGHT_<NAME>` with extras `group`, `color` (hex), `kind`
  (`emissive` | `point` | `spot`), optional `range`, `intensity`, `angle`, `target`.
- Bake AO / light into `COLOR_0` (no runtime shadows in rooms).
- CC0 props from `assets/library/props/` can be imported with `bpy.ops.import_scene.gltf`; restyle them to the room's
  palette.

Worked example: **[BLENDER_EXAMPLES.md → Example A](BLENDER_EXAMPLES.md#example-a--a-stand-alone-prop)** — a desk
lamp built from two lathe profiles, an `EMIT_lamps` shade on a `LIGHT_DESK_01` node, AO baked into `COLOR_0`,
exported and validated (384 triangles, 0 validator errors). The core of it:

```python
def lathe(profile, n=24):            # [(radius, height)] in glTF metres, revolved about the vertical axis
    bm = bmesh.new()
    rings = [[bm.verts.new(G(r * math.cos(a), y, r * math.sin(a))) for r, y in profile]
             for a in (i / n * math.tau for i in range(n))]
    for i in range(n):
        A, B = rings[i], rings[(i + 1) % n]
        for j in range(len(profile) - 1):
            bm.faces.new((A[j], A[j + 1], B[j + 1], B[j]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm

shade = material('EMIT_lamps', '#ffd28a', emit='#ffd28a', strength=2.4)
lamp = obj('LIGHT_DESK_01', lathe([(0.03, 0.40), (0.07, 0.40), (0.12, 0.52), (0.035, 0.52)]), shade)
lamp['group'], lamp['color'], lamp['kind'], lamp['range'] = 'lamps', '#ffd28a', 'point', 3.0
```

For avatar props (a cane, a cigar, a hat) use a costume accessory instead (section 8): they must ride the skeleton.

---

## 6. Rooms (environments)

### 6.1 Read first

- [SCENES.md](SCENES.md): "Named nodes in scene.glb", "scene.json", "Avatars in a room", "Avatar size classes",
  "Cameras", "Test URLs", "Hook: entrances", "Lights", "Chat & events", "Room animation clips", "Graphics quality",
  "Environment: time of day, weather, night lights", plus the optional systems (raid, space, town, traffic, kitchen)
  only if your room uses them.
- [AI_CREATOR_GUIDE.md](AI_CREATOR_GUIDE.md) §10 (checklist, node table, the minimal template) and recipe §13(c).
- One real build script end to end: `assets/scenes/my_kitchen_room/blender/mk_room.py` (+ `mk_lib.py`).
  Others under `assets/scenes/`: `test_room/build_test_room.py` (small), `my_room/blender/build_scene.py`,
  `gzw_fob/blender/*.py` (large exterior, split into modules), `gzw_crimson_camp/blender/make_sheets.py` (contact
  sheets from review renders).

### 6.2 Room contract checklist (compact)

Folder `assets/scenes/<id>/` (id: lowercase `[a-z0-9_-]`, ≤ 48 chars): `scene.glb`, `scene.json`, `preview.png`
(1280×720 from `CAM_WIDE`), `thumb.png` (480×270), `blender/` (sources), optional `textures/`, `README.md`.

- [ ] `SPOT_01`…`SPOT_12`: origin = feet on the floor, +Z = facing; extras `pose` (`sit`/`stand`), `seatHeight`,
      `seatDepth`, `label`, `approach` (flat glTF points, routes around furniture), `leavePathAt`; optional `sizes`.
- [ ] `DOOR` (origin = hinge, rotates about local +Y, `openAngle`; swing it outward, a negative angle swings the
      other way), `DOOR_OUTSIDE`, `PATH_01…`.
- [ ] `SCREEN`: 16:9 plane, UVs 0..1, facing the camera, `restOffsetY`. Optional `SCREEN_SOLO[_xx]` (`width`).
- [ ] Cameras `CAM_WIDE`, `CAM_REACT` (screen ≈ 80 % of the frame width), `CAM_DOOR`, optional `SPOT_xx_CAM`, any
      `CAM_*`.
- [ ] `LIGHT_*` fixtures + `EMIT_<group>` materials; `COLLIDE_*` boxes (≤ 0.9 m tall) around furniture.
- [ ] Optional: `CHAT_MONITOR` / `CHAT_BOARD` / `CHAT_BUDDY` anchors, `FX_BEAM_xx`, `*_LOD0/1/2`, room clips,
      `environment`, `gfx`, `screenSkin` in scene.json.
- [ ] Floors at y = 0, walls not required (paths keep walkers inside), nothing between any camera and a performer's
      face or the screens, performers not in baked shadow.
- [ ] Budget: ≤ 80k visible triangles, ≤ 25 MB GLB, ~170–180 draw calls max, 2048² atlases, 1024² tiling textures.
- [ ] `scene.json` regenerated by the script **keeps hand-added keys** (merge, don't overwrite).
- [ ] Every camera, walk-in and the react mode tested in the app after every build stage (section 11).
- [ ] Original homage designs only: no game files, logos, textures or brand artwork files.

### 6.3 How the proven room scripts are organised

1. **Library module** (`mk_lib.py`, `eot_lib.py`, `bw_lib.py`, `fob_lib.py`): `G()`, `lin()`, a material registry
   (`mat(name)` builds each material once from tables: flat colours, tiling textures, `EMIT` groups), bmesh
   primitives (`box`, `cyl`, `lathe`, `prism`, `tube`, `quad`), UV projection (box / cylindrical / atlas region), the
   bucket system and the bake.
2. **Buckets.** Every part is built as a bmesh in Blender space and added to a named bucket (`add_bm(bucket, bm,
   material)` → an object in a `WORK` collection). Buckets are joined into a few big objects (`WALLS`, `COUNTER`,
   `LOUNGE` …) in an `EXPORT` collection before baking. Few objects = few draw calls; one material per look keeps
   primitives low.
3. **Big faces are subdivided** (`gbox`: quad grids ≤ 0.5 m) so the per-vertex light bake has resolution.
4. **Steps** decorated with `@step(title, focus, dist, yaw, pitch)`, run headless or live (section 3.4).
5. **Anchors** (spots, doors, paths, screens, colliders, cameras) in their own step, with a `cams` dict written into
   scene.json for tools.
6. **Bake**, then **export + GLB post-process + scene.json merge**, then save a `.blend` next to the script (git-ignored)
   for inspection.

**Worked example:** [BLENDER_EXAMPLES.md → Example B](BLENDER_EXAMPLES.md#example-b--a-small-room-headless-or-live-window)
is a complete, self-contained small room in one script (shell with a door hole, couch with three sit spots and two
stand spots, react + solo screen, neon strip + floor lamp fixtures, colliders, four cameras, vertex-colour bake,
GLB post-processing, scene.json merge, headless and live-window runners). It was built headless and in a live window,
validated (0 errors, 4,422 triangles, 13 draw calls) and rendered in the app with Sprocket, Sprocket and a third
avatar seated on the couch. Copy it to `assets/scenes/<id>/blender/build_<id>.py` (or a staging folder) and grow it.

### 6.4 Designing the room (before modelling)

- Collect references and list the 3–5 landmarks that make the place readable in one glance.
- Plan the stage first: host seat, guest seats, react screen, solo screen, chat props, door, walk path, cameras.
  Block it out with boxes, export, and test it in the app **before** detailing.
- The default wide camera sees the performers from the front; keep everything tall (shelves, lamps, pillars, signs)
  out of the lines between the cameras and the faces / screens. The camera QA harness checks this (section 11.5).
- Rooms "work" at 1.5 m avatar height (`avatarHeight`). Seats are 0.42–0.5 m, counters 0.9 m, doors 2.1 m.

---

## 7. Light baking, materials, EMIT groups and textures

### 7.1 Why bake

The engine turns room shadows off and adds its own stage lights for the toon avatars. The room's look (AO, key light,
window spill, lamp pools) must be baked: into `COLOR_0` (vertex colours, multiplied into the material colour by the
engine) or into textures. Real-time lights come only from `LIGHT_*` nodes with `kind: point|spot` (a budget of 0–4
depending on the graphics tier), everything else glows through `EMIT_<group>` materials.

### 7.2 The vertex-colour bake (mk_lib.py `bake`, reduced in Example B)

Per face corner: `ambient × (0.55 + 0.45·up) + key × (N·L, shadow-tested with one BVH ray) + a wrap term + a fill
from below + light pools (position, colour, radius, strength) → × AO (14 hemisphere rays) × tint`, clamped to 0..1.
Cached per (vertex, rounded normal) so it runs in well under a second for small rooms.

- Build the BVH from the baked meshes but **leave out the ceiling** when the key light is overhead (it would shadow
  the whole room) and leave out `EMIT_*`, glass, screens and hidden materials.
- Pools are cheap "light spill": put one under every lamp, neon strip, window and screen. Keep the performers' spots
  bright; never bake a dark gradient over a seat.
- A per-part `tint` attribute lets one material serve many colours (skirting boards, stained panels) — see 7.3.

### 7.3 The tint and COLOR_0 pitfalls (both hit in the kitchen)

1. **Joined parts without a tint bake black.** `join()` gives every part the union of attributes. A part that had
   no `tint` gets tint `(0, 0, 0)`, and the bake multiplies by it. `mk_lib.bake` works around it by treating an
   all-zero tint as "untinted" (so a real black tint is impossible). Better: **give every part a tint**, white by
   default (Example B `add()` does this).
2. **Removing the tint after creating the bake colour drops `COLOR_0` from the export.** A `FLOAT_COLOR` attribute
   is a colour attribute. When `tint` is the mesh's render colour (it is whenever the join's active part carried a
   tint, or every part did) and you create `Col`, make it active and *then* remove `tint`, the render-colour index is
   left pointing at nothing and the glTF exporter writes **no `COLOR_0`**: the mesh renders unbaked. In the shipped
   kitchen (`mk_lib.py`), `LOUNGE` (18,818 triangles) and `KITCHEN_DOOR_FREEZER` lost their bake this way (checked in
   `scene.glb`: no `COLOR_0` on those meshes; `KITCHEN_FLOOR`, whose first part is untinted, kept it). Example B lost
   it on every baked mesh before the fix. The fix, verified in Example B:

```python
tint = me.attributes.get('tint')
tints = [tuple(d.color[:3]) for d in tint.data] if tint else None
if tint:
    me.attributes.remove(tint)                       # BEFORE adding the bake colour
attr = me.color_attributes.new('Col', 'FLOAT_COLOR', 'CORNER')
# ... fill attr ...
me.color_attributes.active_color = attr
me.color_attributes.render_color_index = me.color_attributes.active_color_index   # what the exporter writes
```

   Also strip `tint` from meshes you don't bake (lights, colliders) before export, or it is exported as `COLOR_0`.
   After every export, check which meshes carry `COLOR_0` (a 5-line JSON read, see BLENDER_EXAMPLES.md "Checking a
   GLB").

### 7.4 Materials

- Name materials by look (`M_Wall`, `M_Steel`), build each once from a table, and set `m.diffuse_color` too so the
  solid-mode live window shows the right colour.
- `EMIT_<group>` (e.g. `EMIT_neon`, `EMIT_neon.001` is the same group): emissive materials the light engine animates
  per group (programs, beat pulse, night lights). Base colour ≈ 5 % of the emissive colour. Declare the groups and
  their colours in scene.json `lights.groups`. Room exposure (scene.json `ambience.exposure`) does not affect them.
- Metals: name-based stylised PBR for avatars; for rooms set `metallicFactor` 0.3–0.4 only on real metal, 0 elsewhere.
- Glass: `alphaMode` BLEND, alpha ≈ 0.35. Sign atlases with transparency: `alphaMode` MASK, cutoff 0.5.
- Special names the engines read: sky `M_Sky*` / `GFX_SKY*` / `SKY_*`, water `M_Sea` / `M_Water` / `GFX_WATER*`,
  foliage / cloth names sway (SCENES.md "Environment" and "Graphics quality").

### 7.5 Painting textures (mk_paint.py approach)

`assets/scenes/my_kitchen_room/blender/mk_paint.py` draws every texture of the kitchen with **system Python + numpy
+ Pillow**, no downloads and no AI: tiling floors / tiles / steel / wood from value noise and grout lines, a 2048²
signs atlas drawn with `ImageDraw` + Windows fonts (`C:\Windows\Fonts\impact.ttf`, `arialbd.ttf`), a menu atlas and an
FX atlas. It writes the atlas regions into `textures/layout.json` (`[u0, v0, w, h]`, Blender UV with v up) and the room
script maps quads onto those regions. Run it before the room build: `python mk_paint.py`.

Rules that keep textures clean in the toon renderer: flat colours with a few deliberate value steps, no photo
textures, no per-texel random noise at high contrast, long thin marks rather than dots, dilate every atlas region
8–16 px, text large enough to read at 720p from the wide camera. Parody signs are original drawings: never real
logos or brand artwork files.

AI-painted textures (a cloud service or ComfyUI) are allowed for props and rooms when they look better, but they must be
cleaned to flat cel colours and must stay inside any spending allowance the user gave you (section 14).

---

## 8. Costumes and accessories

Read [AI_CREATOR_GUIDE.md](AI_CREATOR_GUIDE.md) §7 first. The essentials:

- A costume is a **separate GLB skinned to the same bone names and the identical rest pose** as the base avatar.
  Build it with `blender/costume_kit.py` (it loads the base, measures landmarks, grows garments from the body, copies
  the body's weights, exports only the costume meshes + the full base armature).
- Never cover the face (`kit.face_box()`), keep layer offsets (body < shell 0.012–0.02 < vest 0.03–0.05 < straps
  +0.01), ≤ 35k triangles per costume, and read the `CLIP_REPORT` that `export_costume` prints (hundreds of hits =
  loosen the garment).
- Check compatibility: `python tools/check_costume.py <base.glb> <costume.glb>` (exit 0 = same parents, rest
  transforms and inverse bind matrices for every shared bone).
- Accessories (`kind: 'accessory'`) layer on top of the outfit; props such as canes and cigars go there
  (`*Ember*` materials glow with the lips, `*SmokeEmitter*` meshes puff smoke — accessory GLBs only).
- The real costume scripts (`(an internal build)`) **write into the builtin avatar's
  `profile.json` and `costumes/` folder**. Builtins may be the avatar the user is wearing live: run your costume into
  a staging folder and let the user import it.

Worked example: [BLENDER_EXAMPLES.md → Example C](BLENDER_EXAMPLES.md#example-c--a-costume-for-sprocket) — a
scout outfit (shirt shell, short sleeves, belt with a brass buckle, helmet) for Sprocket, exported to staging:
12,428 triangles, CLIP_REPORT total 54, `check_costume.py` OK. `kit.render_preview()` renders with Eevee (GPU): run it
only when `live_ok` says IDLE.

---

## 9. Avatars and characters

### 9.1 House rules (non-negotiable, the user's own words behind each)

- **Anime mouths are carved into the face.** The opening is part of the face surface, never a sticker on top.
- **Teeth are flat and drawn** (a white band in the texture / shader). Never build 3D teeth geometry.
- **Faces are drawn, never projected.** Own 2K face texture, vector marks evaluated per texel, flat cel tones, hard
  shadow shapes, dark warm lines (never pure black), warm shadows (never grey). Never project a photo, an AI render
  or a low-res crop onto a face.
- **Hair = clumped cards / ribbons** with proxy normals and an angel ring, never stripey flat ribbons.
- **Humans and anime humans start from a proper base** (CC0 VRoid samples, `blender/face_kit`, MakeHuman for comic
  faces). Never from Tripo / Meshy / Hunyuan3D meshes, never from scratch-built procedural meshes.
- **Appealing faces are make-or-break**, especially female anime faces. Judge in the app renderer next to the
  reference at the same framing; never install a face that looks worse than the one it replaces.

### 9.2 Pick the route

| Goal | Route | Start here |
|---|---|---|
| Anime girl / boy | CC0 VRoid base (`tools/vendor/vroid/*.vrm`: Sendagaya_Shino, Sendagaya_Shibu, Darkness_Shibu, Sakurada_Fumiriya, HairSample_Female, HairSample_Male) → `anime_creator` params → `face_kit.VFace` repaint → hair → VRM | `python blender/face_kit/anime_face.py <preset> <out_dir>` (presets `gacha_girl`, `vtuber_girl`, `anime_boy`, `chibi`); `blender/anime_creator/presets/anime_*.json` |
| Anime eyes (any pipeline) | `blender/face_kit/anime_eyes.py`: `preset('female' \| 'male', **overrides)`, `blend(a, b, t)`, `design(p, inner, outer)`, `mirror`, `render`, `preview` | `python blender/face_kit/anime_eyes.py <existing_dir>` writes F / M / blend sheets (the folder must exist). Rules: [FACE_CREATION.md](FACE_CREATION.md) §2.1 |
| Anime hair | `blender/anime_hair`: clumps on guide curves, proxy normals, clean palette, angel ring, spring-chain weights; `style='drawn'` for drawn-art pipelines | `fit.py <vrm> none <prefix> geo=1` → write a `locks()` spec → iterate `fit.py` → `export=` ([README](../blender/anime_hair/README.md)) |
| Comic / semi-real human | MakeHuman base → `HFace` | `python blender/face_kit/comic_face.py comic_bearded_man <out_dir>` |
| Performer's Live2D model → 3D | `tools/live2d_to_3d.py` (clean-room moc3 reader, VRoid base, drawn eyes, drawn-hair locks) | [LIVE2D_TO_3D.md](LIVE2D_TO_3D.md) — permission and licence rules first |
| Creature / mascot | scripted SDF body, face grid with a split mouth seam + mouth bag, `jaw` bone, ARKit warps, bulb eyes | `(an internal build)`, `(an internal build)` |
| Robot / object | GLB, `look.shading:'toy'`, `rig.mechanical`, LED eyes, jaw or `VoiceGlow` | `assets/builtin/robot/build_robot.py` |
| AI mesh you must keep (mascots) | finish, rename bones to VRM names, clean up, carve a mouth | `blender/finish_generated.py`, `blender/cleanup_lib.py`, `blender/avatar_polish.py` (`carve_mouth`), example `assets/builtin/frogsuit/cleanup_uncle.py` |

### 9.3 Rig, morphs, springs (the contract)

- Bone names: the exact VRM humanoid names (`hips spine chest upperChest neck head leftUpperArm …`). Avoid names
  starting with `Right` and suffix-sided stems starting with `l` / `r` (matcher bugs, AI_CREATOR_GUIDE §2.3).
- Morphs: ARKit 52 names (≥ 10 → perfect-sync mode) + optional `tongueUp` / `tongueTip`; the PP seal, round O / U,
  FF tuck and L tongue must read (AI_CREATOR_GUIDE §3.2–3.3). Morphs named `vtp_*` are engine-generated.
- Springs: non-VRM rigs get chains automatically from bone names (`Hair_*`, `Tail_01 → Tail_02`, `skirt`, `cape`,
  `ribbon` …; each joint needs a child bone) or explicitly via `physics.chains`. VRM uses its own spring bones.
- `profile.json`: AI_CREATOR_GUIDE §4. Real size for non-human-sized characters: `"size": {"height": 0.3}` (metres;
  fairies < 0.6 m sit on perches, giants > 2.6 m stand at the back). Export in metres regardless.
- **Party budget: 37,000 triangles** (model + worn costume; warning from 30,000). Heavier avatars are shared as an
  automatic party version. Preview what guests would get:
  `npx tsx tools/party_lod.ts <model.glb> <out.glb> [--max 37000] [--costume <c.glb> <c_out.glb>]`.
  Build party-friendly (≤ 37k) so every guest sees the real model.
- Budgets: 60–80k triangles bust-framed, ≤ ~40 draw calls, ≤ ~25 materials, **a 2048² face texture of its own**,
  ≥ 256 px per iris.

### 9.4 AI meshes (Tripo, Meshy, Higgsfield 3D) — what we learned

From [(an internal build) and the
Skyisles / a streamer rebuilds (2026-09-26):

- **An AI mesh is a sculpt reference, not the avatar** (for humans). Keep its shape, discard its topology and pixels.
  Print the bounding box first: AI exports arrive at any scale and yaw (Tripo faces −X → yaw −90).
- **Weld the glTF import.** Every UV seam arrives as duplicate vertices; bone heat and posing treat them as separate
  islands and the mesh tears when it bends (a streamer: 3,412 → 2,486 vertices after
  `bmesh.ops.remove_doubles(dist=1e-6)`). Clear imported custom normals after welding / posing (they go stale).
- **Meshy welds parts together** (fringe into the face, cape into the shirt). Spring-chain weights must fade in with
  surface distance from the welded part, or the cape tears; unweld sleeves from a capelet; keep the face surface
  still and put eyes / lids / brows on small separate meshes (Skyisles `FacePlate`).
- **Mirror-check the skeleton.** Skyisles's right wrist bone sat 9.9 cm off, in the middle of the forearm.
- **Drop zero-area slivers** (Skyisles: 1,163): their outline hulls draw as dark "freckles".
- **Repaint every texture** as flat cel colour: the AI texture's lightness can survive only as structure (strand
  lines, fold relief → designed cel shadow steps). Remove baked light, speckle and black noise.
- Decimate hair / clothes, never the face and hands (Skyisles 140k → 89k triangles).

### 9.5 Rigging and re-rigging pitfalls (a streamer re-rig, kitchen NPCs)

The full 6-step re-rig is `build_brute()` in `assets/scenes/my_kitchen_room/blender/mk_humans.py`:

1. Face the rig −Y, scale to the real height, stand the lowest vertex on z = 0.
2. **Pose-match parents before children.** Swing each arm as a rigid unit; a bent arm is matched by its direction
   **and** its elbow hinge axis (then straightened about the hinge — shortest-arc rotation leaves the forearm roll
   arbitrary). **Never turn the clavicles** to the target skeleton's clavicles: the mannequin's point backwards and
   turning them swung the arms 28° behind the body; every clip then twisted the arms.
3. Bake the posed mesh with a **Corrective Smooth** on the limbs (no crushed elbows / shoulders).
4. Refit joints from the mesh: Tripo puts the "ankle" at the sole (the feet sank 7 cm); measure ankles and balls on
   the mesh; spread spine joints like the target's; keep bone orientations so existing clips play unchanged.
5. Skin = 60 % Blender bone heat + 40 % source weights, max 4 influences (fists stay rigid).
6. Clips: resample, keep the lowest mesh point on the floor every frame, re-time locomotion loops so the planted foot
   moves at the speed the game planner moves the NPC (foot sliding otherwise).

Other lessons: the engine's generated procedural-mouth morphs once renamed a mesh's own shapes to `'0'`, `'1'` (never
driven; fixed in `src/avatar/surfacePatch.ts` 2026-09-26 — if a model's blink / ARKit shapes do nothing, check
`morphTargetDictionary` names). Put the same `vtpShadeShift` on face and body skin (no neck seam). Keep bangs'
spring chains stiff (they follow the head at ~45 %) so no hair crosses the face on fast turns.

---

## 10. NPCs and animation clips

- NPC skeletons: the 20-bone NPC rig (raid / town) or the Quaternius mannequin (kitchen humans), see
  AI_CREATOR_GUIDE §11 and [ANIMATION_LIBRARY.md](ANIMATION_LIBRARY.md). CC0 clips: Quaternius Universal Animation
  Library 1 + 2 (`tools/vendor/quaternius/…/UAL1_Standard.glb`, `UAL2_Standard.glb`) — import the GLB, keep the
  actions you need, delete the rig (`load_ual()` in `mk_humans.py`).
- **Hand-keyed clips with a small FK pose solver** (`mk_frogs.py`, `mk_humans.py`): a clip is a Python function
  `t → spec` where spec maps bone names to `dir` (aim the bone at a vector in character space: out, forward, up per
  side), `rot` (Euler degrees), `loc` (hips) and `scl` (eyes / brows). `solve(spec)` walks the bones parents-first
  in armature space from the rest matrices and returns local quaternions; a loop keys every bone every frame (or
  every 2nd) into one action per clip, `use_cyclic` for loops:

```python
@clip('idle', 2.4)
def _idle(t):
    T = 2.4; sp = {}; b = math.sin(math.tau * t / T)
    body(sp, hips=(0, 0, 0.004 * b), spine=(1.5 * b, 0, 0), head=(-2 * b, 0, 5 * math.sin(math.tau * t / T + 1)))
    arm(sp, 1, (0.42, 0.05, -0.9), (0.3, 0.12, -0.95)); arm(sp, -1, (0.42, 0.05, -0.9), (0.3, 0.12, -0.95))
    stand(sp); face(sp, blink=blink_at(t, 2.4, 0.9))
    return sp
```

  Lessons (a streamer pass): smoothstep-only keys look robotic — use Hermite / Catmull-Rom splines through keys
  (`spl()`); plant feet with 2-bone leg IK instead of FK; aim `dir` at the child joint, not the bone's Y axis; check
  finger-curl sign (the manager's fingers once bent backwards); every clip gets `finish_clips` (floor contact per
  frame, locomotion re-timed to the planner's speeds).
- Review strips: both NPC scripts take `--render DIR` (Workbench strips of every clip) and `mk_humans.py` takes
  `--out DIR` (build into staging instead of over `npc/`). Workbench is fine while live; Eevee is not.
- **Room clips** (any room, `src/scene/roomClips.ts`): export actions with `export_animation_mode='ACTIONS'`; seamless
  loops, whole frames at 24 fps; never key an engine-driven node (`BOB_*`, `SWAY_*`, doors, spots, cameras) — key a
  child.
- Determinism: anything the engine plays must be computable from room data + host seed + wall clock (no random per
  page). Keep that in mind when a room needs NPC anchors (SCENES.md sections per engine).

---

## 11. Testing in the app renderer

Blender previews lie about toon shading, outlines, exposure and the engine's lights. Judge in the app.

### 11.1 Private test tree + read-only mock (recommended)

A private copy of the client with its own Vite port, proxying `/api` and `/library` to a small **read-only** mock
that serves rooms and avatars from disk (including your staging folders) and refuses every write. It never talks to
the live server or bus, so it can't change the stream and it doesn't receive the user's live tracking.

1. `S` = your scratch folder. Copy `src`, `shared`, `server`, `index.html`, `output.html`, `dj.html`,
   `tsconfig.json`, `package.json` from the repo into `S\tree`; junction `node_modules`, `public`, `assets`:
   `New-Item -ItemType Junction -Path "$S\tree\node_modules" -Target "$REPO\node_modules"` (same for the others).
2. Put the private `vite.config.ts` from BLENDER_EXAMPLES.md into `S\tree` (own port 5790, own HMR port, own
   `cacheDir: '.vite_private'`, proxy to the mock).
3. Start the mock: `python mock.py --port 5793 --stage <folder of staged rooms> [--stage-avatars <folder of staged
   avatars>]` (BLENDER_EXAMPLES.md), then `npx vite` inside `S\tree`.
4. Open **one** tab, e.g. `http://127.0.0.1:5790/output.html?sceneTest=<room>&cam=wide&extra=frog,robot&screen=placeholder&fps=30`.
5. When done: close the tab, stop Vite and the mock.

If you use the real dev server instead (`localhost:5190`), use only `output.html?sceneTest=…` / `?avatar=…&observer=1`
pages or `/?observer=1` studios. Those pages **do** receive the performer's live tracking: freeze them before
capturing (11.4).

### 11.2 Test URLs

- Rooms: `output.html?sceneTest=<id>&cam=wide|group|talk|react|CAM_x&mode=react&spot=1..12&extra=frog,robot&screen=placeholder`.
  Systems: `&beatDemo=128`, `&env=h19.2,storm`, `&chat=monitor,panel,buddy,goal`, `&gfx=high`, `&tier=low`,
  `&raid=hot&raidSeed=7&raidAt=<s>`, `&space=hot`, `&kitchen=on,fight&kitchenAt=12`.
- Avatars: `output.html?avatar=<id>&preview=1&observer=1&focus=head|bust|full&fps=30&adaptive=0`.

### 11.3 Debug handles (`vtpOut` in the page console)

`vtpOut.scene` (SceneRuntime: `.room.spots`, `.room.cameras` (Map), `.room.fixtures`, `.room.emissive`,
`.room.colliders`, `.room.pathNames`, `.stage.renderer`), `vtpOut.step(n, dt)` (draw frames by hand, also in hidden
tabs), `vtpOut.debugScene(state)`, `vtpOut.lights()`, `vtpOut.slots` / `vtpOut.runtime` (avatars;
`vtpOut.runtime.surfaces.info()`), `vtpOut.env.debug()`, `vtpOut.raid.debug()`, `vtpOut.space.debug()`,
`vtpOut.town.debug()`, `vtpOut.kitchen.debug()`, `vtpOut.gfx.info()`, `await vtpOut.camEval()`. Walks:
`vtpOut.scene.mover.manual = true`. Manual clocks: `vtpOut.<engine>.scene.manual = true; .clock = …`.

A quick contract check after loading a room (this is what Example B returned):

```js
const r = vtpOut.scene.room;
({ cams: [...r.cameras.keys()], spots: r.spots.filter(Boolean).map(s => s.name ?? s.node?.name),
   fixtures: (r.fixtures || []).map(f => f.node?.name ?? f.name), emissive: (r.emissive || []).map(e => e.group ?? e.name),
   colliders: (r.colliders || []).length, path: r.pathNames })
// Example B gave: cams CAM_WIDE, CAM_REACT, CAM_DOOR · spots SPOT_01..05 · fixtures LIGHT_NEON_01, LIGHT_LAMP_01 ·
// emissive neon, lamps · colliders 2 · path PATH_01..03
```

### 11.4 Screenshots, preview.png and thumb.png

The output canvas has no preserved drawing buffer: draw a frame and copy it **in the same synchronous call**.

```js
const src = vtpOut.scene.stage.renderer.domElement;
const shot = (w, h, name) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
  vtpOut.step(1); const a = w / h; let cw = src.width, ch = cw / a; if (ch > src.height) { ch = src.height; cw = ch * a; }
  c.getContext('2d').drawImage(src, (src.width - cw) / 2, (src.height - ch) / 2, cw, ch, 0, 0, w, h);
  return fetch('http://127.0.0.1:5793/save?name=' + name, { method: 'POST', mode: 'no-cors', body: c.toDataURL('image/png') }); };
await shot(1280, 720, 'preview.png'); await shot(480, 270, 'thumb.png');
```

The mock's `POST /save` writes the image into its `shots/` folder (the only write it allows). For an avatar tab on
the real dev server, freeze the live tracking first (`const s = vtpOut.slots[0]; s.sync.push = () => {};
s.sync.steps = () => [];` zero `s.frame` face / mouth / visemes / head / gaze / bones, and set
`s.lastFrameAt = performance.now()` before every `vtpOut.step(1)`), or the user's own face and arms end up in your
screenshots ("mouth reads open", "sleeves flare" were the user, not the model).

### 11.5 Camera QA harness (rooms)

`tools/cam_eval` renders every room × shot type in headless Chrome and scores faces hidden / cut, void pixels, props
over faces or the screen, clutter in front of the lens. It **refuses while the studio tracks**
(`live_ok` must say IDLE):

```text
python tools/cam_eval/cam_eval.py --label mine --rooms <id> [--parts shots,entrances]
python tools/cam_eval/sheets.py mine [--compare older_label]
python tools/cam_eval/probe.py <room> cands.json out.jpg      # try candidate cameras / solo screens first
```

It needs a dev server (`--port`, default 5190 = `npm run dev`); point it at your private Vite port instead of the
live one. Output: `%TEMP%\vtp_cam_eval` (or `$VTP_CAM_EVAL_DIR`). Write winning cameras into scene.json
`cameraOverrides` / `soloScreens`. Details: `tools/cam_eval/README.md`.

---

## 12. Review protocol and evidence

- **Characters**: `python tools/review_character.py <model.glb|vrm> <out_dir> --profile profile.json [--ref ref.png]`
  (17 views in the studio toon look + detectors G1–G3, R1–R10; ship PASS, or a WARN you can justify). Then the app
  renderer: 8+ angles (front, both 3/4, **both profiles**, back, full bust, head close-up) plus an expression /
  viseme sheet (blink fully closed, smile, surprise, angry, aa, oo, ee, ff, PP sealed). Then side by side with the
  reference at identical framing; list the 3 biggest differences, fix, repeat. FACE_CREATION.md §8's 11-point
  self-review must be all "yes".
- **Costumes**: `tools/check_costume.py`, the CLIP_REPORT, and the app at arms-up / head-yaw poses.
- **Rooms**: every camera, react mode, a walk-in to every spot, stand-ins at every seat (`&extra=`), the camera QA
  harness, `node tools/gltf_validate.mjs scene.glb` (0 errors), triangle / size budget, `COLOR_0` present on every
  baked mesh.
- **NPCs**: `--render` strips of every clip from 3/4 and profile with a floor line; lowest-point-per-frame metrics
  for floor contact; then the app on the manual clock.
- **Evidence**: save before / after sheets at identical framing (same camera, same pose) and name the files in your
  handoff. Be honest about what you did not verify. Never install something that looks worse than what it replaces.

---

## 13. Delivering: staging, install scripts, handoff

- **Content** (rooms, avatars, costumes, props): build into a staging folder (`--out DIR`). When the user asks for it
  to ship or replace something: back up the existing folder (`<asset>/backup/<stamp>/`, git-ignored), then copy in.
  Rooms are discovered automatically from `assets/scenes/<id>/`; avatars and costumes are imported by the user.
- **Code** (anything under `src/`, `server/`, `shared/`): develop in a private tree, deliver an install script the
  user runs. The pattern (tested skeleton in BLENDER_EXAMPLES.md "Install script"): snapshot `base/` of every live
  file you change when you start; at install time, 3-way `git merge-file` (live now, base, yours) per file, abort on
  any conflict, typecheck the merged set in a temp copy, write each file via temp + `os.replace`, refuse while
  `live_ok` shows tracking unless `--now`, `--check` = dry run. Preserve CRLF (byte-exact reads / writes). OBS picks up
  client changes only after `npx vite build --emptyOutDir false` — the user's call.
- **Every fix is a pipeline step** (AGENTS.md rule 8): a script stage, a kit function or a runtime default, never a
  one-off hand edit. Build scripts are one command, reproducible, and write a success line.
- **Handoff**: plain-language summary, files changed / created, how you verified (paths to sheets / screenshots), the
  exact command to install or rebuild, what is left or risky. Keep build scripts next to the asset
  (`assets/scenes/<id>/blender/`, `assets/builtin/<id>/build/`) so the next agent can rebuild it.
- **Personal content never ships.** The public release is the engine + one original sample model + one original
  sample room. Rooms themed on games, the user's own characters and anything made from their photos are personal
  (see each room's README). Keep them out of anything public.

---

## 14. Licences and AI services

- Licences: [RESOURCES.md](RESOURCES.md) §7 (traps) and [ASSET_LIBRARY.md](ASSET_LIBRARY.md). Usable: CC0 (Quaternius,
  Poly Haven, KayKit, Kenney), the CC0 VRoid samples only (not VRoid Studio presets, not AvatarSample_A–Z), MIT /
  Apache / BSD code, CC-BY with credit. Not usable: Mixamo redistribution, NC / ND datasets, Live2D Cubism
  code, game files / logos / textures. Hunyuan3D is never bundled; it is usable only through the Character 3D recipe in the
  user's own ComfyUI (their download, RESOURCES.md §7), for props, creatures, mascots and non-human characters, never for humans. GPL Blender add-ons may be used as tools; their code never ships.
- Downloads only when the user allows them; record source, licence, size and SHA-256 (THIRD_PARTY_NOTICES.md).
- **Cloud AI services** (image / video / image-to-3D): VTube Pro itself never calls one and never holds a key for one.
  Use the user's own AI app, or the local ComfyUI recipes. Don't paste a key into a script, a package or the library.
- Local ComfyUI shares the GPU with live face tracking: only when `live_ok` says IDLE.

---

## 15. Pitfalls we already paid for

| Symptom | Cause | Rule |
|---|---|---|
| Blender "succeeded" but produced nothing | `blender_low.cmd` always exits 0 | grep the log for `Traceback`, print a success line |
| Import fails on a path in the test tree | Blender can't follow directory junctions | pass real absolute paths |
| `import inspect` breaks a kit | running from inside `blender/` | run kits from the repo root |
| Room meshes render unbaked | `tint` removed after the bake colour was added → no `COLOR_0` exported | remove `tint` first, set `render_color_index` (7.3) |
| Parts of a joined mesh bake black | untinted parts get tint 0 on join | tint every part (white default) |
| Whole room in shadow | the ceiling is in the key-light BVH | leave the ceiling / emitters out of the BVH |
| Colours too light / "black" is grey | sRGB hex written into linear factors | `lin()` every factor |
| Props face the wrong way | Blender −Y vs glTF +Z confusion | author in glTF coordinates with `G()`; check in the app |
| Desk radio in the solo two-shot | prop in a camera sightline | sample sightlines from every camera (cam_eval) |
| Mesh tears when the NPC bends | UV-seam duplicate vertices from the glTF import | weld (`remove_doubles 1e-6`) before weighting |
| Arms twist behind the body in every clip | clavicles turned to the target's backward clavicles | never turn clavicles in a pose-match; match elbow hinge axes |
| Feet sink 7 cm | Tripo ankle at the sole | measure ankles on the mesh, plant clips per frame |
| NPC feet slide | clip stride speed ≠ planner speed | re-time locomotion clips to the planner speed |
| Blink / ARKit shapes do nothing | engine renamed morphs `'0'`, `'1'` (fixed 2026-09-26) | check `morphTargetDictionary` names |
| An extra shape key (a puff sac) shows at full strength at rest | `shape_key_add` keys exported with glTF default weight 1; the engine only overwrites the shapes it drives | set `key.value = 0` for every key before export |
| Cape tears when arms move | AI mesh welded cape into shirt | fade chain weights by surface distance; unweld |
| Dark freckles on the face | outline hulls of zero-area slivers | drop slivers |
| 3D teeth "look horrible" | modelled teeth | flat drawn teeth only |
| Face "blotchy mush" | projected low-res reference | draw vector faces at 2K |
| "Mouth reads open" in review shots | observer tab received live tracking | private tree or freeze frames |
| OBS "spazzing out" | a test tab loaded avatars / saved costumes; a second studio | observer / private pages only, never save or send commands |
| Live tracking slowed | a hidden test tab ticking at 60 Hz, a GPU render | one tab, close it right away; no GPU renders while live |
| Costume script edited a live profile | builtin costume scripts write `../profile.json` | build costumes into staging |

---

## 16. Command cheat sheet (PowerShell and bash)

All from the repo root. Quote paths: the repo path contains a space.

| Task | PowerShell | Git Bash |
|---|---|---|
| Live check | `python tools/live_ok.py; $LASTEXITCODE` | `python tools/live_ok.py; echo $?` |
| Blender version (under the lock) | `& .\tools\blender_low.cmd --version` | `cmd //c "tools\\blender_low.cmd --version"` |
| Headless build | `& .\tools\blender_low.cmd -b --factory-startup --python "$PWD\path\x.py" -- args *> $log` | `cmd //c "tools\\blender_low.cmd -b --factory-startup --python C:\\...\\x.py -- args" > log 2>&1` |
| Validate a GLB | `node tools/gltf_validate.mjs path\scene.glb` | same |
| Costume check | `python tools/check_costume.py base.glb costume.glb` | same |
| Character review | `python tools/review_character.py model.glb out_dir --profile profile.json` | same |
| Party version | `npx tsx tools/party_lod.ts model.glb out.glb --max 37000` | same |
| Anime eye sheets | `New-Item -ItemType Directory -Force out \| Out-Null; python blender/face_kit/anime_eyes.py out` | `mkdir -p out && python blender/face_kit/anime_eyes.py out` |
| Anime face build | `python blender/face_kit/anime_face.py gacha_girl out_dir` | same |
| Kitchen textures | `python assets/scenes/my_kitchen_room/blender/mk_paint.py` (rewrites the room's textures: staging copy first) | same |
| Typecheck | `npx tsc --noEmit -p .` | same |
| Running Blenders | `Get-CimInstance Win32_Process -Filter "Name='blender.exe'" \| Select ProcessId, CommandLine` | `tasklist //fi "imagename eq blender.exe"` |
