# Pro2D → 3D with your own AI

A performer clicks **Make a 3D version with my AI** on any Pro2D avatar (`.vtp2`: one made in VTube Pro from a PSD,
or a model brought over from another 2D app). Their own Claude or ChatGPT desktop app, connected to VTube Pro, builds a 3D VRM
from it in Blender on their computer, checks it against the 2D model from 8 angles and improves it round by round, then
hands it in. The user approves it and it becomes a **new** library avatar (never worn automatically). Their 2D avatar is
not changed. Everything runs on their PC; the model goes only to their own AI company as part of their own chat.

The pipeline underneath is the deterministic 2D → 3D converter ([LIVE2D_TO_3D.md](LIVE2D_TO_3D.md)): it starts
from VTube Pro's own base bodies, already included (Mirelle and Kairo, or the user's own VRoid base), a drawn face (face_kit, never projected), the carved mouth with flat drawn teeth,
hair locks traced from the drawn ink lines, spring chains. The AI does not sculpt from nothing: it starts from that
baseline and improves it with the pipeline's own parameters ("procedural craft") and, only where they can't reach,
with parts it builds in the user's Blender through their Blender MCP.

## For users (the drawer)

The 2D panel's **Make a 3D version with my AI** opens a drawer (`src/ui/to3dPanel.ts`):

1. **The checklist**, each row one sentence and one button, plus **Set it all up for me**:

   | Row | Detected how | The button |
   |---|---|---|
   | Your AI app (Claude / ChatGPT) | the app's config has VTube Pro; "talked to VTube Pro 2 min ago" from its calls | Get Claude / Get ChatGPT (links), Connect |
   | Blender | the existing Blender detection (4.2+; 5.1 tested) | Install Blender (the Set up AI creation page) + "Get it yourself" |
   | Blender MCP | add-ons read from Blender's prefs on disk (nothing started; the folder Blender itself uses: `BLENDER_USER_RESOURCES`, a portable install's `portable/`, else `<config>/Blender/<major.minor>`; an add-on installed under another file name, like blender-mcp's `addon.py`, counts by its `bl_info`); the AI app's config; what answers on port 9876; uv (below) | Install it for me / Add to Claude / Open Blender for me / Get it for me (uv alone, about 20 MB) + "Get it yourself" |
   | 3D toolkit | VTube Pro's own Python environment (its Python + a finished-install mark for the same Python version: an interrupted, damaged or older install is not "ready") | Get the 3D toolkit (about 350 MB, once) |
   | Base body | always ready: VTube Pro's own base bodies (Mirelle, Kairo), already included; or your own base | Use my own base / Use VTube Pro's bases instead |
   | Not live right now | OBS streaming / recording, or the studio tracking | (never blocks; Blender opens after the stream) |

   **uv is found wherever it went, with no restart** (`server/to3d/uvFind.ts`, every check): the toolkit's own
   uv, the uvx an AI app's Blender MCP entry starts, the PATH as Windows has it *now* (the user's then the machine's
   `Environment` key, re-read every check), the PATH VTube Pro started with, then the installers' folders (`.exe`
   only on Windows; an empty or tiny file doesn't count) (`~/.local/bin`, `UV_INSTALL_DIR`, `XDG_BIN_HOME`, cargo,
   winget links + packages, Scoop, Chocolatey, pip, Homebrew, ...). The open checklist checks again every 4 s and has
   **Check again** and a **Where we looked** fold (every place and what was there, for support). A failed install
   says why in one sentence plus the next step (offline, disk full, blocked by antivirus, damaged download), and
   stays on screen.

   Every download is one consent sheet that says what, from where and how big. Nothing installs itself: an install or
   an AI-app config change needs a click in VTube Pro's own page on this computer plus the sheet's one-time token
   (the same pattern as Connect your AI: `x-vtp-user-action`, `consent: true`, a token bound to the actions and the
   page's origin, 2 minutes; each action is used up before its work starts).
2. **The tick**: "This is my model, or its artist allows me to make a 3D version of it." A model whose `.vtp2`
   `meta.rights.modification` is `false` can't be converted. Free sample models from other 2D apps: testing on this computer only.
3. **The privacy line**: pictures of the model and its rig details go to Anthropic (Claude) or OpenAI (ChatGPT) as part
   of the user's chat with them. VTube Pro doesn't upload anything itself.
4. **What to expect**: 30–90 minutes. Claude stops after about 20 steps and shows **Continue** (click it each time; the
   drawer reminds you). A long run uses a lot of your AI app's limits.
5. **Start in Claude** opens Claude Desktop with the message filled in (`claude://claude.ai/new?q=…`; press Enter).
   **Start in ChatGPT** copies the message: open the ChatGPT app, pick **Codex** (Work mode may work too; plain Chat
   can't use local tools), paste, Enter.
6. **Your AI is working…**: the steps, the round, the latest 2D / 3D side-by-side, hints when the AI paused
   ("click Continue"), **Waiting for your OK** (the approval page), **Done** with **Wear it** and **Keep improving**.
   **Stop**, **Continue in a new chat** and **Delete this job's files** are always there.

## The Blender MCP (two servers, both on port 9876)

| | MCP for Blender (community, the default) | Blender Lab MCP (official, advanced) |
|---|---|---|
| Version / licence | `mcp-for-blender` 2.1.9 (PyPI), MIT | 1.0.3, GPL-3.0-or-later, Blender 5.1+ |
| Add-on | `blender_mcp.py` in `<Blender user>/scripts/addons`, module `blender_mcp`, starts its server by itself | extension `mcp` (`extensions/<repo>/mcp`), operators `blmcp.server_start/stop`, autostart; needs Blender's **Online access** (`--online-mode`) |
| Wire | one JSON object `{"type","params"}`, no delimiter; `ping` | `{"type":"execute","code","strict_json"}` + `\0` |
| The AI app's entry | `{"command": "<absolute uvx>", "args": ["--from", "mcp-for-blender==2.1.9", "mcp-for-blender"], "env": {"DISABLE_TELEMETRY": "true", "BLENDER_MCP_SAFE_MODE": "1", "VTP_ADDON": "mcp-for-blender"}}` (absolute uvx: apps started from a menu don't see PATH) | the official `.mcpb` opened with Claude Desktop |
| Run code / look | `execute_blender_code` / `look` | `execute_blender_code` / `get_screenshot_of_window_as_image` (`execute_blender_code_for_cli` is never allowed: a second Blender outside the lock) |
| Install (with consent) | VTube Pro's uvx runs `install-addon --addons-dir …`, then the user's Blender (headless, IDLE priority, inside the Blender lock) enables it and saves prefs | the release zip (sha256-pinned) installed as an extension the same way; Blender's own warning quoted on the consent sheet |

Installs are refused while the user is live ("Finish your stream first, or install it later") and while a Blender window
is open (it saves its own preferences when it closes and would switch the add-on off again: "Close Blender first").
Both are checked again right before Blender starts (after the add-on download, and after waiting for the Blender
lock), and a window check that fails or gets no full answer counts as "open" ("We couldn't check whether Blender is
open").
The community / official pick is kept in `<data>/to3d-kit/settings.json`.

Detection: the add-on files on disk and the enabled list in `userpref.blend` (read by its block structure, both the Blender 5 and the older layout; nothing is started), then two framed probes on the port, 2 s each (community `ping` first: the official bridge never answers it). A second Blender
MCP entry on the same port breaks the one the user had: when one of them is ours (tagged `VTP_ADDON`), "Keep just one"
removes ours (backup first); an entry the user added themselves is never changed or removed (the drawer says to remove
one in the app's settings). Never run the community `setup` / `install.ps1` one-liners (they edit app configs by
themselves). Versions, launch, homes, cautions and detection come from the shared AI add-on catalogue
(`shared/aiAddons.ts`, `mcp-for-blender` and `blender-lab-mcp`); config writes go through `server/aiAddons.ts`
(`writeAddonEntry`). Code: `shared/to3d/blenderMcp.ts`, `server/to3d/blenderMcp.ts`.

## The 3D toolkit and the bases

- **Toolkit** (`server/to3d/kit.ts`): uv 0.12.23 from its GitHub release, sha256-pinned per OS / arch; a uv-managed
  CPython 3.12 + venv in `<data>/to3d-kit`; numpy, scipy, opencv-python-headless and Pillow from PyPI with
  `--require-hashes --only-binary :all:` (`blender/to3d/requirements.txt`). Never the system Python, never Blender's.
- **Bases** (`server/to3d/bases.ts`): starts from VTube Pro's own base bodies, already included: the bundled sample
  avatars **Mirelle** (female) and **Kairo** (male), `assets/builtin/<id>/<id>.vrm`, shipped with every copy. Nothing
  to download, so the row is always ready. Both are VRM 0.x VRoid bodies (humanoid bones, a `Face` mesh with VRoid
  `Fcl_*` expressions, VRoid eyes); the pipeline builds on the base body and drops their costumes and headset, as with
  any base. Their measurements (eye, face, head and column proportions) are a generated table,
  `blender/to3d/builtin_bases.json`, made by `blender/to3d/user_base.py builtins --write` and keyed by each file's
  sha256 (`tools/to3d_pipeline_test.py` fails when a bundled avatar changes and the table wasn't regenerated). The
  pipeline gets `--builtin-bases` and picks Mirelle for a female model and Kairo for a male one (`creator.base`
  overrides). **Use my own base**: any VRoid-made VRM 0.x the user owns (their own VRoid Studio export, from the
  library or a file), measured the same way. A VRM 1.0 file is refused with "export it again as VRM 0.0".

## How a job runs (the server)

`<data>/cache/to3d/<job>/`: `job.json` (resumable state), `src/model.vtp2`, `bundle/`, `refs/`, `rounds/<n>/`
(the pipeline's output + `check/`), `work/` (the only folder the AI's Blender code may write; `parts/` for grafts).

1. **Prepare**: `tools/pro2d_bundle.ts export` evaluates the `.vtp2` with the runtime's own evaluator (`RigEval`:
   deformers, glue, blend shapes, bones) into the bundle `blender/live2d/vtp2.py` reads like a `.moc3` (standard Cubism
   ids answered through the rig's own tracking bindings, so an Inochi2D "Head Yaw" works as `ParamAngleX`).
   `blender/to3d/refs.py` draws the references (front, head, the rig's ±30 turns, blink, mouth open, each expression),
   region labels, eye landmarks, cut-outs and the bundle sections. A rig that can't be read as a character (no eyes or
   head turn found) goes the **picture route**: its front picture through the pipeline's image route.
2. **Rounds**: `tools/live2d_to_3d.py --vtp2` with validated overrides; a rebuild runs only what the change needs
   (`full` / `hair` / `springs` / `profile`); a **graft** adds Blender-made parts (`blender/to3d/graft.py`; a part over
   32 MB or a `hide` name over 64 characters is refused before anything reads it; the size is checked again right
   before the graft runs, and by `graft.py` itself).
3. **Check** (one call): the round in the **app renderer** in a separate muted headless browser VTube Pro starts
   (`to3d-render.html`, CPU rasteriser, idle priority, one view at a time while live): 8 angles (0, ±45, ±90, ±135,
   180), an expression / viseme sheet, three eye-aligned head shots; then `blender/to3d/compare.py` (2D ±30 against 3D
   ±20, coverage per drawn region, CIEDE2000 colours, crown / head width in IPD units, the worst region) and
   `tools/review_character.py` (the detectors). The scores only guide; acceptance is the review + the 11-line
   checklist + pass / fail at every angle. No browser on the PC: Blender toon views only, marked approximate (can't be
   submitted).
4. **Submit**: checked → the request goes on the existing approval page (`to3d_submit` answers `waiting_for_ok` at
   once) → on Approve the round is imported as `<name> (3D)` with its 2D references and the job as provenance.

**Live safety**: while OBS streams / records or the studio tracks, only the CPU pipeline runs (IDLE, the Blender lock);
no visible Blender, review renders one view at a time in their own process. VTube Pro never dials OBS when it isn't
connected through VTube Pro. **Off switch**: `settings.json` `{"to3d": {"enabled": false}}` or `VTP_TO3D=0` (on by
default everywhere).

## The AI's side

`get_instruction_pack {"pack":"pro2d_to_3d","jobId":"…"}` serves the recipe (`shared/to3d/pack.ts`; job-filled only
for this computer's own AI apps, never over the internet bridge). It lists the only tools allowed, the frames and
units, the fix order with acceptance checks per region (and a picture-route column), the lever table, the loop and stop
rules (≤ 10 rounds or 2 hours; revert on a review FAIL or a worse checklist line), how to use the Blender MCP, what is
forbidden, and resuming. Tools (`server/to3d/mcpTools.ts`, never in `REMOTE_SAFE`, every call < 45 s):

| Tool | Scope | What |
|---|---|---|
| `to3d_jobs`, `to3d_job` | read | open jobs; one job's state, paths, readiness, Blender MCP tool names, **nextStep** |
| `to3d_bundle` | read | the 2D model by section (summary, parts, params, deformers, physics, expressions, layers, bones, measure, colours, design) |
| `to3d_references`, `to3d_parts` | render | the reference sheet / pictures; mesh cut-outs |
| `to3d_baseline`, `to3d_rebuild`, `to3d_graft`, `to3d_revert` | create | rounds (return at once) |
| `to3d_wait` | read | ≤ 40 s; the newest round + its check with pictures + nextStep |
| `to3d_check` | render | render + compare + review in ONE call |
| `to3d_note` | create | the round's note: text, 11 checklist answers, 8 angles, gaps |
| `to3d_vision` | read | can the AI see pictures? (else numbers-only mode: ≤ 4 rounds, the user judges at Approve) |
| `to3d_open_blender`, `to3d_submit` | create | `waiting_for_ok` at once; VTube Pro acts when the user approves |

**Approvals for every gated tool** (`server/aiconnect.ts` `requestApprovalPolled`, `server/mcpScopes.ts`): Claude
Desktop cancels a tool call after ~60 s, so an ask-scope call waits at most 40 s; still waiting = a normal result
`{"status":"waiting_for_ok"}` and the same request stays on the approval page (10 minutes); the AI calls the same tool
again with the same arguments and it runs once approved. One OK runs one call: two identical calls in flight share
one card and only one of them runs; an OK that lands in the last quarter of a wait (≤ 15 s) is kept for the next
identical call, so the tool itself starts with the full ~60 s. VTube Pro clamps every wait to 40 s. **Approve all …
calls for 30 min (any arguments)** covers every call of that tool from that app, whatever its arguments.
`wait_for_job` waits ≤ 45 s per call.

## Tests

- `npx tsx tools/to3d_setup_unit.ts`: the set-up checklist on fake computers: uv from the official installer, winget,
  a PATH only the registry knows, an AI app's entry; "Get uv" with a plain error; the toolkit complete / interrupted /
  damaged / older; Blender 5.2.x folders, portable Blender, `addon.py`; Where we looked; the consent sheet.
- `node tools/to3d_setup_e2e.mjs --out <dir>`: the checklist page in a muted headless browser on a private server flips
  from "!" to "✓" while open (no restart, no click), Check again, Where we looked, the web-studio path.
- `npx tsx tools/to3d_unit.ts`: overrides schema (+ `--write-spec`), the job rules, readiness rows, live gating,
  prompts, the pack's allow-list against the real tool table, polled approvals, both Blender MCP probes against fake
  servers, prefs on disk, config writes, the toolkit install with fake downloads, store / render / vision.
- `node tools/to3d_e2e.mjs --out <dir>`: a private server in a fake world, a fake AI over the real stdio MCP server,
  the real pipeline + app renderer + review on the self-made test puppet (`tools/rig2d_sample.ts`) on both bundled
  bases (round 0 on Mirelle, a rebuild on Kairo), a graft, the consent token rules, the approval and the library
  import; drawer screenshots (desktop + phone, dark + light).

## Known gaps (honest)

- The baseline is a strong look-alike on an anime base, not a copy: the back of the head and garment shapes are
  invented; accessories other than the neck are the AI's Blender work.
- Picture avatars (PNG 2D avatars) and extra outfits (costume layers) are not converted yet.
- Only two bundled bodies: other body types come from "Use my own base" (a VRoid Studio VRM 0.0 export; the base
  checker refuses VRM 1.0 because the face kit is VRM 0.x).
- Checked against the real add-ons in a private Blender 5.1 user folder (2026-10-06): the official 1.0.3 zip installs, reads back as enabled and its live bridge is identified by the probe; the community add-on enables and reads back as enabled. The community server itself needs Blender's UI loop, so its wire protocol is tested against a fake built from its source.
- `fw_low` (jaw width) is measured from the base mesh (the bundled bases and a user base alike), not from a
  hand-tuned table.
