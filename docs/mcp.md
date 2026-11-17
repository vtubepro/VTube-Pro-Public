# Driving VTube Pro from an AI (MCP)

`server/mcp.ts` is a stdio MCP server that talks to the running VTube Pro HTTP server
(`http://127.0.0.1:5191`, override with `VTP_URL`). Start the app first with `npm run dev`
(or just `npm run dev:server`), then point any MCP client at it. The same tool table is also served as streamable HTTP
on `http://127.0.0.1:5191/mcp` (local token), through the optional remote connector (safe tools only) and by the
built-in "Create with AI" host (a model on this PC). Setup for every client, scopes and the approval click: **[AI_CONNECT.md](AI_CONNECT.md)**.

**The easy way for users:** VTube Pro's **Set up AI creation** page (`tools.html?view=ai-setup`, AI_CONNECT.md §3) adds
the server to Claude Desktop, Claude Code, ChatGPT Desktop / Codex, Grok Build, LM Studio, Cursor, VS Code and Gemini CLI
(preview, backup, merge, verify) and makes sure Blender is found. **Self-test:** add `--self-test` to the command
an app runs (`npx tsx server/mcp.ts --self-test`): it lists the tools in-process,
asks VTube Pro for `status`, prints one line `VTP_MCP_SELFTEST {"ok":true,"tools":51,"helper":"reached","blender":"5.1.0"}`
and exits 0 / 1.

The project-scoped `.mcp.json` registers it as **`vtube-pro`** (`npx tsx server/mcp.ts`), so Claude Code
opened in this folder picks it up automatically. Other clients (Claude Desktop, ChatGPT/Codex, Grok, Cursor…)
can use the same command with the VTube Pro folder as the working directory.

## Knowledge: guides, house rules, resources

On connect the server sends `instructions`: the live-safety and house rules in short, and which guide to read for what.
The guides, the house rules and the generation prompts all come from one file, `server/aiKnowledge.ts`.

| Tool / resource | What you get |
| --- | --- |
| `get_docs` | No arguments: the index of every guide, the resource URIs and the full house rules. `{topic, section?}`: a guide, or only the sections whose `##` / `###` heading contains the `section` word. Topics: `agents`, `pro2d`, `creator`, `avatars`, `environments`, `connect`, `scenes`, `blender`, `faces`, `examples`, `performance`, `moving`, `rules` |
| `get_creator_guide` | The older form, `{doc, section?}` with the same guide keys (`##` headings only). Default `creator`; a copy without it answers a call with no `doc` with the index of the guides it has |
| `get_instruction_pack` | `pack` "room" (default): the copy-paste pack for building a room as a creation package (house rules, package format, the room contract, worked examples). `pack` "pro2d_to_3d" (+ `jobId`): the recipe for turning a Pro2D avatar into 3D ([PRO2D_TO_3D.md](PRO2D_TO_3D.md)); job-filled only for local callers |
| `vtube-pro://docs/<FILE>.md` | Each guide present in this install: `AI_CREATOR_GUIDE.md`, `ARTIST_AVATARS.md`, `ARTIST_ENVIRONMENTS.md`, `AI_CONNECT.md`, `SCENES.md`, `BLENDER_PLAYBOOK.md`, `FACE_CREATION.md`, `BLENDER_EXAMPLES.md`, `PERFORMANCE.md` |
| `vtube-pro://rules/house` | The house rules (live safety, no sound, hands off user data, model custody, licences, quality bar, faces, linear colours, characters, rooms, Blender, honesty) |
| `vtube-pro://contract/room` | The room contract (from ARTIST_ENVIRONMENTS.md) |
| `vtube-pro://contract/avatar` | The avatar checklist, rig and face shapes (from ARTIST_AVATARS.md) |
| `vtube-pro://recipes/one-shot`, `vtube-pro://recipes/room-template`, `vtube-pro://recipes/review` | One-shot recipes, the minimal room build script, the review protocol (from AI_CREATOR_GUIDE.md) |

Read `get_docs {topic:"agents"}` (docs/AGENT_GUIDE.md) before making any avatar or room and run `check_creation` on the
file before handing it over; read `get_docs {topic:"avatars"}` before an avatar or costume and `get_docs {topic:"environments"}` before a room.

## Tools

Scopes (AI_CONNECT.md §2; an ask-scope call answers `waiting_for_ok` within ~40 s and runs on the next identical call once approved): **read** and **render** run freely; **create** makes new library items, never worn;
**library** asks by default; **live** and **python** always wait for the user's Approve click in the studio; **diag**
is local only.

| Tool | Scope | What it does |
| --- | --- | --- |
| `get_docs`, `get_creator_guide`, `get_instruction_pack` | read | Guides and rules (above) |
| `status` | read | Blender detection, ComfyUI reachability |
| `list_avatars` / `get_avatar` / `list_costumes` | read | Library listing / full `AvatarProfile` / an avatar's costumes |
| `list_rooms` | read | The rooms the studio can load (shipped, the user's own, linked), as it lists them: each room's `scene.json` plus id, name, model, `ready`, thumb; a room with areas once per area (`<room>~<area>`). It does not open the GLBs: no spot or camera counts (use `check_room` / `validate_room`) |
| `get_job` / `wait_for_job` | read | Poll background jobs (returns the preview image when done) |
| `validate_room` | read | Check any installed room (an area id checks its room) against the room contract and budgets; every problem comes with its fix. SPOT heights are world space (parent transforms count; `stats.spotHeights`), a room with areas is checked area by area (budgets per area) |
| `check_room` | read | The "Add my room" check for an installed room (`roomId`) or a room file on this PC (`path`, .glb / .gltf / .fbx / .blend / .obj): seats found (≥ 1 required, 2+ recommended), cameras, scale, up axis, floor, lights, budget, each with its fix, plus a suggested fix as data (SPOT_xx + SPOT_xx_CAM / CAM_WIDE in glTF space). Not offered to remote (tunnel) clients |
| `room_checklist` | read | The room checklist as data (`vtube-pro.room-checklist/1`): every rule, how it is checked, the fix, what the studio fixes automatically. Also the resource `vtube-pro://checklist/room` |
| `check_creation` | read | The agent file check (`vtp-check`, docs/AGENT_GUIDE.md §9) on a file, folder or .zip on this PC (`path`, optional `kind`): 3D avatars, Pro2D PSDs / part pictures, Live2D, Inochi2D, .vtp2, PNGTuber sets, 3D and 2D rooms. Returns `vtube-pro.check/1` (verdict pass / warn / fail, items with the fix for each). Runs in its own process (server/creationCheck.ts), never on VTube Pro's event loop. Not offered to remote (tunnel) clients |
| `creation_spec` | read | What VTube Pro accepts, as data (`docs/agent-spec.json`, `vtube-pro.agent-spec/1`), whole or one `section` (`avatar3d`, `pro2d`, `live2d`, `pngtuber`, `room3d`, `flat2dRoom` …). Also the resource `vtube-pro://spec/agents` |
| `validate_creation_package` | read | Validate a creation package without building it |
| `ai_addons_status` | read | Which building helpers are ready on this PC (Blender MCP and whether Blender is connected, GIMP + GIMP MCP, Photoshop, ComfyUI, uv, the VTube Pro Creator skill), each missing one with the ONE step to tell the user. Plain text, no paths. Not offered to remote (tunnel) clients |
| `submit_creation_package` | create | Put a package in the studio inbox; the user clicks Build |
| `generate_room` | create | Record a "generate a room" request |
| `generate_avatar` | create | Local ComfyUI generation (the Character 3D recipe: one picture → a plain 3D model) → `jobId` (images may be local paths). Nothing leaves this PC. For anything else build the model with `blender_run_python`. Creatures, mascots, robots, props |
| `render_avatar` | render | Blender renders returned as images so the AI can see the model |
| `update_avatar` | library | Deep-merge a partial profile and save (the studio live-reloads) |
| `import_model` | library | Import a model file from disk (FBX/OBJ/STL/PLY/.blend converted to GLB). A model a creator script built (`blender/human_creator`) has its `profile.json` and `costumes/*.glb` next to it: they come along, and `carried` in the answer says what arrived |
| `import_costume` | library | Add a costume GLB to an avatar (build it with `blender/costume_kit.py` through `blender_run_python`, then import it; `set_costume` wears it) |
| `import_room` | library | Add a room file from disk as a NEW room, exactly like the studio's "Add my room" (`POST /api/rooms/import`): .glb as is, a .gltf with everything embedded packed into one .glb, .fbx / .blend / .obj converted by Blender, checked, `autoSeats` (default on) adds places + cameras below 2 seats; installed into the user's rooms folder, never over an installed room. Its `scene.json` is generated: to ship your own, use a creation package |
| `autorig` | library | skeleton + bone-heat skinning for a person (VRM names), an animal on four legs, a bird, a snake or a thing, from guided taps (`bodyType`, `taps`, shared/rigTaps.ts) → `jobId` |
| `set_costume` | live | Wear / take off a costume (the stream changes at once) |
| `send_command` | live | Broadcast `{type:'command'}` on the live bus (`load`, `expression`, `screenshot`, …) |
| `blender_run_python` | python | Run bpy headless, optionally with an avatar pre-imported; `saveAs` turns `VTP_OUT/model.glb` into an avatar |
| `install_creation_package` | python | Build a package now (Blender headless), validate and install the room |
| `to3d_jobs`, `to3d_job`, `to3d_bundle`, `to3d_wait`, `to3d_vision` | read | Pro2D → 3D jobs: state + `nextStep`, the 2D model by section, waiting (≤ 40 s) with the newest check's pictures, the picture check ([PRO2D_TO_3D.md](PRO2D_TO_3D.md)) |
| `to3d_references`, `to3d_parts`, `to3d_check` | render | the 2D references / cut-outs; ONE call that renders a round in the app renderer (8 angles + expressions), compares it with the 2D and reviews it |
| `to3d_baseline`, `to3d_rebuild`, `to3d_graft`, `to3d_revert`, `to3d_note` | create | rounds (validated design overrides; Blender-MCP parts) and the round's note (11 checklist answers, 8 angles, gaps) |
| `to3d_open_blender`, `to3d_submit` | create | answer `waiting_for_ok` at once; VTube Pro opens Blender / adds the NEW avatar when the user approves |
| `get_diagnostics` / `request_diagnostics` | diag | Latest studio uploads (every 3 s while the camera tracks): `camera.jpg` (640 px), the newer of `stage.jpg` (960 px wide) and `stage.png`, `state.json` / ask for fresh ones, with a full-resolution `stage.png` (waits up to ~4 s for it) |

Blender conventions for scripts: Blender is Z-up; imported glTF models face **-Y** (glTF +Z); write any output
files into `os.environ["VTP_OUT"]`; export GLB with `export_yup=True` (the default). Principled BSDF socket values and
glTF colour factors are **linear**: convert sRGB hex first.

## Checking the server

`npx tsx tools/mcp_stdio_docs_test.ts` (source checkout) spawns the stdio server the way a client does, lists tools and
resources, reads every resource and fetches every guide. It only calls the read-only doc tools and points `VTP_URL` at
a dead port, so it can't reach or change a running app. `npx tsx tools/aiknowledge_unit.ts` and
`npx tsx tools/aiconnect_test.ts` test the shared knowledge and every AI host; `npx tsx tools/mcprooms_unit.ts` the
room tools (`import_room`, `validate_room`, `check_room`, `list_rooms`) and the guides it serves, in temp
folders. `check_room`, `import_room` and `.gltf` packing run in VTube Pro's room-check process
(`server/roomCheckJob.ts`), one at a time at below-normal priority, never on
the event loop that also relays the studio's tracking to OBS: `npx tsx tools/roomcheck_offloop_unit.ts` measures that.
`validate_room`, `validate_creation_package`, `submit_creation_package` and an install's stage and final check run the
Python checker (`tools/aiconnect_package.py`) as their own process the same way (`server/aiPackage.ts` runPy: one at a
time, below-normal priority, 60 s limit); `npx tsx tools/aipackage_offloop_unit.ts` relays 16 ms frames over a real
`/ws` bus while they run and fails on a hitch in ANY run (the old spawnSync held it 160-450 ms, about 1 s on a big room).
Both kinds of process are STARTED off the event loop too, on one worker thread (`server/spawnOffLoop.ts`): on Windows
`spawn()` itself holds the calling thread for the whole process start (60-250 ms on a busy PC). Both tests also check
that nothing starts a child process on VTube Pro's main thread.

## Optional: live Blender GUI via blender-mcp

[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) is a Blender add-on + MCP server that lets an AI
drive a *running, visible* Blender session (you watch it model in the viewport). It is an optional alternative to
VTube Pro's headless `blender_run_python`; it is **not** installed or required. If you use it, export the result as
GLB and bring it in with `import_model`.
