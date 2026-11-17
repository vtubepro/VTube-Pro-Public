# AI art pipeline — diffusion-painted textures that match the reference

This pipeline lets VTube Pro produce good-looking avatars and rooms with no hand-painting. It uses 2D image
models (which are far ahead of 3D generators) to **paint the textures of an existing 3D model**. The model's
geometry comes from the parametric bases (VRoid / MakeHuman / face_kit), a sculpt, or image-to-3D plus cleanup.
The painting is conditioned on the model's own depth and lineart, on the reference drawings, and on a prompt.
The painted views are then projected back into the model's UVs.

Code: `tools/ai_texture/`. Models and licences: `docs/AI_MODELS.md`.

## One command

```
python tools/ai_texture/run.py <config.json> [--stage render|ref|paint|bake|all] [--views a,b]
```

The config lives next to its working folder. See the docstring of `run.py`; worked configs (Aosabi / Elias / Nux / Skyisles) are in the session report
(scratchpad `ai_art/<character>/cfg_q3.json`). The ComfyUI graphs are exported in `tools/ai_texture/workflows/`. It holds:

- `model` (GLB / VRM), `targets` (the base-colour images to repaint) and `protect_materials` (eyes, teeth, mouth
  cavity, masks — these are never repainted)
- `prompt`, `style` and `negative`
- `refs` (reference images and crops)
- `views` (the AI views, painted in order)
- `ref_views` + `ref_pose` (the exact reference framings, painted first)
- `palette_lock`, `vcolor` (vertex colours for surfaces whose UVs are only a ramp) and `out_model`

## Stages

| Stage | What happens | Where |
|---|---|---|
| **render** | Blender runs headless (CPU Cycles, IDLE priority, 1 spp, no GPU). For every view it writes unlit albedo, a UV + material/image-id pass, and world position and normal passes. For every target image it bakes a UV-space **texel map** (world position, normal, coverage). The optional pose (e.g. arms down, like the model sheet) is applied before baking, so all views in that work folder agree. | `bl_render.py` |
| **sculpt** (optional) | Renders the same cameras from a high-res sculpt (e.g. the user's 2M-vertex Aosabi `AoMenpoCigar01.blend`). ControlNet then sees the sculpted clumps, folds and planes, while the paint still lands on the rig mesh. Turn it on with `sculpt_controls: true`. | `bl_sculpt_passes.py` |
| **ref** | `refmatch.py fit` segments each reference view and renders the model over a sweep of yaws. It fits a similarity transform by silhouette IoU and writes the exact camera: centre, height, yaw, and a 300 mm lens (close to orthographic, like a model sheet). `warp` then aligns the reference into our pixel grid: the similarity is exact, and a smoothed DIS optical flow (silhouette + appearance, clamped to 3 %) takes out the residual. The reference views are painted first at high priority. Init = the warped reference inside the trusted overlap; denoise ≈ 0.3 there and 0.55 elsewhere. The model therefore takes on the drawing's face, colours, shading shapes and details. | `refmatch.py`, `run.py stage_ref` |
| **paint** | Each AI view (face close-ups at 1024², 3/4s, both profiles, back, top, upper and lower body at 896×1152) runs the same steps. (1) Render the current textures through the view (numpy; no Blender round-trip). (2) Run ComfyUI img2img: ControlNet-Union-ProMax with **depth + lineart** (lineart = silhouettes, depth steps, normal creases and material borders, plus optional albedo edges on faces), IP-Adapter-Plus with the matching reference crop, and the prompt. A **Differential Diffusion mask** (per-pixel denoise) is 0 on texels an earlier, better view already painted, 1 on new texels, and 0 on protected materials. (3) Palette lock: k-means classes of the current state keep their mean Lab colour, which stops a black shirt drifting to brown or tan skin going pale. (4) Back-project. | `run.py`, `passes.py`, `backends.py` |
| **back-projection** | Texel-space and gather-based, so there are no holes. A texel is visible in a view when the view's position pass at its projected pixel is the same 3D point (within a few pixel footprints) *and* shows the same image. Weight = facing² × silhouette-distance fade × view priority. **Lock blending**: a later view only contributes where its weight is comparable to the best earlier one, so lower-priority views never ghost over the reference or face passes. | `passes.py visibility_weights`, `run.py Accum` |
| **bake** | Texels no view saw are inpainted (Telea) inside UV islands that were partly painted; islands that were never seen keep their original colour. Optional cel posterise. Islands are dilated by 6 px. Surfaces whose UVs are only a ramp (Aosabi's hair and beard cards) get **per-vertex colours** projected from the same views. A new GLB/VRM is written with **only the image buffers swapped** (`glbio.py`) — rig, morphs, VRM extensions and springs stay byte-identical. | `run.py stage_bake`, `vcolor.py`, `glbio.py` |
| **re-UV** (when needed) | Overlapping or tiled UVs (Nux's hair strip atlas, tiled jacket cloth, fur clumps, boots) get a unique **xatlas** layout. Every vertex attribute, including morph targets, is re-indexed through the vertex map, the old texture is transferred into the new layout, and the material is copied (together with the VRM 0.x materialProperties). Separate MToon shade maps are folded into `_ShadeColor`. | `uvunique.py` |
| **score** | Reference and ours side by side at every reference view, with **silhouette IoU**, **edge chamfer** (‰ of image height), **colour ΔE** (Lab, blurred) and **DINOv2 cosine similarity** (`facebook/dinov2-small`, Apache-2.0). Run it with the ComfyUI venv Python, which has torch + transformers: `<ComfyUI>/.venv/Scripts/python.exe tools/ai_texture/refmatch.py score cfg.json <textures dir> out.png`. | `refmatch.py score` |
| **app check** | Renders the candidate model in the real app renderer (toon or MToon, outlines, post) from your own `?observer=1` tab, at 8+ orbit angles and at the exact reference framings (`refmatch.py appviews` → `vtpRefShots`). It never touches the live avatar or the bus, and the tab is closed afterwards. | `observer_shots.js` |

## Faces, mouths, eyes
- The face close-up (`face0`, 1024², priority 3) and the reference face view (priority 4) are painted before
  anything else. Their texels are locked against later views.
- Eyes, teeth, the mouth cavity and masks are `protect_materials`: their pixels get denoise 0 in every view and
  are never projected. Teeth stay the flat drawn band (house rule — never 3D teeth).
- The prompt adds "closed mouth". The negatives add "open mouth, teeth".
- For comic-style faces, use `albedo_lines` 0.4–0.6 on the face views. It feeds the existing drawn scars,
  brows and lid lines into the lineart control, so they survive the repaint.

## Hair
- Cards with unique UVs (Elias, anime_hair / hair_kit locks) are painted like any other surface.
- Ramp-UV cards (Aosabi v5) take **vertex colours** from the painted views, and the ramp image is flattened
  to white.
- Strip-atlas hair (Nux) is re-UV'd with `uvunique.py` first.
- For new hair, build the geometry with `blender/hair_kit` (closed shell locks with per-lock atlas strips). Then
  paint its atlas with this pipeline.

## Rooms
`tools/ai_texture/tiles.py`:
- `tiles`: seamless material tiles. txt2img → roll by half → repaint the cross band with Differential Diffusion
  → roll back. Then a partial Lab colour match to the tile being replaced, so the room's value balance holds.
  The seam ratio is reported (≈1.0 = invisible seam).
- `sky`: a 360° panorama that wraps in x (roll + band repaint), with a 2× detail pass.
- `tools/ai_texture/atlas.py`: repaints atlas regions (from the room's `layout.json`) with Qwen-Image-Edit, so
  each region's layout, emblems and shapes stay where the UVs expect them. Each region is colour-matched to its
  original. Whole textures work too: pass layout `-`.
- Prop atlases can also be painted with `run.py` on the room GLB, the same way as a character: views = the room
  cameras.

## GPU etiquette (the user streams on the same GPU)
- `backends.gate()` runs `tools/live_ok.py` before **every** job. Since 2026-09-25 it is **IDLE-only**: no GPU job
  starts while the studio is tracking at all (`VTP_AI_IDLE_ONLY=0` relaxes this to <20 ms inference and ≥40 Hz).
  It also waits while nvidia-smi shows >80 % utilisation from someone else. A long job that starts while things are
  healthy can still starve tracking for its whole duration, so keep jobs short.
- `wait_queue()` never stacks jobs on the shared ComfyUI.
- Jobs run one at a time, with a 3 s cooldown between them (`cooldown`). `release()` calls `/free` after each
  batch, so no models stay loaded while idle.
- Measured: while an SDXL 896×1152 job runs, face tracking drops from about 54 Hz to 30–40 Hz; between jobs it
  recovers to about 50 Hz. Jobs take 12–14 s each: a full character (3 reference + 17 AI views) takes about 5 min
  of GPU time.
- Blender always runs on the CPU at IDLE priority.

## Hardware
- Local: an NVIDIA GPU with ≥ 12 GB VRAM for SDXL + ControlNet + IP-Adapter (8 GB works at 768² with
  `--lowvram`), about 25 GB of disk for the models, Blender 4.2+ (5.1 tested) and Python 3.11+ with numpy /
  scipy / opencv / pillow / requests (+ `xatlas` for re-UV).
- Scoring with DINOv2 needs torch + transformers. The ComfyUI venv already has them.

## Public users without ComfyUI: pluggable backend
Everything above talks to one small interface (`tools/ai_texture/backends.py`):

```
backend.paint(job)    -> image      # img2img + mask + controls + refs
backend.generate(job) -> image      # txt2img (concept sheets, tiles, panoramas)
backend.release()
```

A job is plain data: prompt, negative, seed, steps, cfg, denoise, init image, per-pixel mask, controls
(`depth` / `lineart` / `normal` / `tile` images + strengths), refs (IP-Adapter images + weights), size,
checkpoint and LoRAs. Pick the backend with `VTP_AI_BACKEND`:

- `comfyui` / `comfyui=http://127.0.0.1:port` — `LocalComfy`. It builds the API graph itself, so no saved workflow
  is needed. `docs/examples/ai_texture_paint_workflow.json` is the exported graph, for reference.
- Only ComfyUI is used, and only on this PC: the painter never sends a picture to another service. The public default must
  use **commercial-OK** weights (Animagine XL 4.0 / SDXL base, ControlNet-Union, IP-Adapter, see `docs/AI_MODELS.md`).
- The Blender stages and the projection are pure CPU. They run on the user's machine, and
  only the paint jobs go to ComfyUI.

## Wiring into the app's Create tab (plan)
1. **Server**: `POST /api/ai/texture` `{avatarId | modelFile, prompt, refs[], preset}`.
   - Spawns `python tools/ai_texture/run.py` as a job, reusing the existing job runner and `/api/jobs/:id`
     progress (`api.waitJob`).
   - Writes into `library/<id>/_ai/<timestamp>/` — never over the live model.
   - Returns the candidate GLB, the before/after sheet and the scores.
2. **UI**: a "Paint with AI" card in Create, with a reference drop, a style preset (anime cel / comic / painterly),
   a strength slider and a backend picker (Local ComfyUI URL).
   - Shows the reference | ours sheet with the scores.
   - "Apply" copies the candidate over the model with a backup, then reloads the avatar.
3. **Gating**: the server calls the same `live_ok` check before each job and exposes "paused (streaming)" in the
   job status.

## Painters (engine)
- `engine: "qwen"` (default for new configs). **Qwen-Image-Edit-2509 + Lightning 8-step**, commercial-OK.
  - Inputs: image1 = the matching reference crop, image2 = OUR geometry at the exact camera (sculpt-merged surface
    normals by default, or depth / lineart), image3 = the face reference.
  - The instruction is built from `describe` + the per-view `camera` / `instruction` + a pixel-alignment lock
    (`run.py qwen_paint`). A small DIS silhouette snap (`align_to_silhouette`) removes the residual offset.
  - Workflows: `tools/ai_texture/workflows/qwen_edit_view.api.json`,
    `qwen_edit_geometry_paint.api.json`.
- SDXL (Animagine / Illustrious / WAI) + ControlNet-union + IP-Adapter: `sdxl_controlnet_ipadapter_paint.api.json`.
  Kept for comparison. It lost the bake-off.
- Character LoRA: `tools/ai_texture/train_lora.py` trains with ComfyUI's native trainer in short chunks, gated
  between chunks. Result: `aosabi_illu.safetensors` (Illustrious v2, trigger `aosabi`).

## 2D bake-off (`tools/ai_texture/bakeoff.py`) — the quality gate before any projection
Leave-one-out test: generate a held-out reference view from the other reference images, then score it with masked
DINOv2 + colour ΔE.

Aosabi, mean DINO:
| Setup | DINO |
|---|---|
| Qwen-Edit-2509 full | 0.902 |
| Qwen-Edit-2509 Lightning | 0.883–0.895 |
| Qwen-Edit-2509 + Multiple-angles LoRA | 0.84–0.87 |
| WAI-illustrious + IP-Adapter | 0.710 |
| Illustrious v2 + IP-Adapter | 0.704 |
| Animagine 4 + IP-Adapter | 0.673 |
| NoobAI v-pred + IP-Adapter | 0.668 |
| NoobAI eps + IP-Adapter | 0.590 |

The SDXL + character-LoRA setups are on-model for the outfit and hair, but not for the eyepatch.

Geometry-conditioned Qwen views line up with our lineart almost pixel for pixel (`bakeoff_aosabi_geo`).

## Status (2026-09-25) — honest
**What works**
- The whole pipeline: render → reference fit → paint → lock-blended projection → bake → image-only GLB/VRM swap.
- Re-UV (xatlas) for tiled / overlapping UVs.
- Vertex colours for ramp-UV hair.
- The reference-matched cameras and the side-by-side scorer.
- The app-renderer shot harness.
- The 2D generation itself (Qwen).

**What does not work yet: final character textures from per-view painting.** The candidates were reviewed and
**not installed**:

| Character | review_character high findings (installed → AI pass) | By eye |
|---|---|---|
| Aosabi | 13 → 14 | Worse (suit) |
| Elias | 4 → 4 | Face worse |
| Nux | 18 → 20 | Worse (painted teeth on the face skin) |

Causes:
1. Every independently painted view bakes its own cel shading. Across 17 views that becomes blotchy camo on
   clothes, even when the prompt asks for "flat colours only".
2. Drawn facial features are never in exactly the same place in two views, which gives ghost eyes. A drawn grin
   landing on the mouth region breaks the flat-teeth rule.
3. Back views need an explicit BACK lock, or Qwen draws a face or a suit front on them.

Mitigations are in the code: `palette_lock`, `cel_clean`, `protect_ring_px`, `skip_head`, the BACK lock and
`ref_agree_dE` (the semantic guard for reference projection). They reduce these problems but do not remove them.

**Recommended next step:** multi-view-*consistent* generation instead of independent views. Two options:
- Generate a small set of views jointly (MV-Adapter / Hunyuan3D-Paint-style, conditioned on our normals + the
  Qwen reference views + the character LoRA).
- Or limit projection to the reference's own framings (direct projection works well there) and paint the remaining
  surfaces as flat base colours with ink lines only.

**Skyisles:** a new build.
- Base: anime_creator on the CC0 VRoid 'shibu' base, with anime proportions (head ×1.24, hair ×1.22), re-UV'd
  hair.
- Colours: AI-painted from the official faerie turnaround with the Qwen pass (14/17 views, stopped when ComfyUI
  was paused).
- Guild accessory built with costume_kit: cap, feather spring chain, capelet, cape, faerie ears.
- Candidate folder only — not installed. The face still has painted smears and needs the consistent-generation
  step.
