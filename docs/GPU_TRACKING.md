# GPU tracking sidecars (optional, NVIDIA RTX 50-series)

**Requires an NVIDIA RTX 50-series GPU (tested on RTX 5090).** Three optional add-ons run on the graphics card as small
local Python processes ("sidecars"). The server starts and stops them. The studio page talks to them over localhost
websockets. All three are off by default. Each falls back cleanly: if a sidecar is missing or dies, the old path carries on.

| Feature | What it does | Sidecar | Port | Setting |
|---|---|---|---|---|
| GPU lip sync | NVIDIA **Audio2Face-3D** v2.3.1 (Claire): mic → 52 ARKit blendshapes → blended into the viseme rig | `tools/gpu/a2f_sidecar.py` | 5197 | Tracking → Advanced → Voice, phone & 2nd camera → *GPU lip sync (Audio2Face)* |
| Face expressions | NVIDIA **Maxine AR SDK** Face Expression Estimation: webcam → 53 ARKit-style coefficients, replacing MediaPipe's blendshape scores (mixed by *Maxine share*) | `tools/gpu/vision_sidecar.py --feature maxine` | 5199 | same page → *Face expressions (NVIDIA Maxine)* |
| Whole-body pose (see Licences for the weights note) | **RTMW-x** (OpenMMLab): webcam → 133 body / hand / finger points, refining MediaPipe's 2D arm and hand landmarks | `tools/gpu/vision_sidecar.py --feature rtmw` | 5198 | same page → *Whole-body & finger pose (RTMW)* |
| My face model (opt-in, not a sidecar) | A small network taught on the performer's own face (a ~2.5 minute routine, trained on this PC) that replaces MediaPipe's score on the channels where it proved better on frames it never saw. Maxine can be its *teacher*; with Maxine on, the face model wins the channels it was adopted for and Maxine keeps the rest. See FACE_MODEL.md | – (runs in the face worker) | – | same page → *My face model* |

The UI checks the GPU with `nvidia-smi` (`GET /api/gpu/status`). The Maxine and RTMW cards need an RTX 50-series card (Maxine's NVIDIA installer is an RTX 50 build; RTMW was built and measured on RTX 50 only). RTMW has no other condition: it is on for every RTX 50 owner, with no switch and no environment variable. On any other PC the app says "Whole-body tracking (RTMW) needs an NVIDIA RTX 50-series card; MediaPipe's body tracking keeps working." (panel, capability row and GPU setup all use that sentence). **GPU lip sync** is also offered on RTX 20 / 30 / 40 (see "Which cards" below). A PC with no NVIDIA card cannot run these (they run on NVIDIA's CUDA); the cards say so, and MediaPipe's built-in tracking keeps working. NVIDIA supports Maxine on RTX 20/30/40/50, with a separate installer per
generation. VTube Pro was only built and measured on RTX 50, so it only enables these features there.

## Setup (any PC with an RTX 50-series card; nothing needs to be installed first)

**In the app:** Tracking → Advanced → Voice, phone & 2nd camera → **Set up GPU tracking**. Or run
`START_HERE.bat -Gpu`, or `npx tsx tools/gpu/gpu_setup.ts`. All three run the same code, `tools/gpu/gpu_setup.ts`.
It runs on Node only, so no Python needs to be installed beforehand.

| Step | What it does | Disk | Time |
|---|---|---|---|
| Check | Needs an NVIDIA GPU, a driver ≥ 580 (CUDA 13) and enough free disk space. Stops with a plain message otherwise. A card that is not RTX 50-series skips RTMW and Maxine with the notice above and keeps lip sync on RTX 20 / 30 / 40 | – | seconds |
| Runtime | Gets Astral's `uv` (official GitHub release, sha256 from the release) unless it's already on PATH. `uv` fetches Python 3.12 and installs the pinned packages into `.gpu\venv`: `onnxruntime-gpu[cuda,cudnn]==1.30.0` (the CUDA 13 + cuDNN 9 runtime DLLs come as NVIDIA pip wheels, so there is no CUDA toolkit to install), numpy, websockets, opencv-python-headless, psutil. Then it checks that CUDA loads | ~2.1 GB | 2–6 min |
| Audio2Face-3D | 13 files from `huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire`, pinned to a commit, each sha256-checked. Skipped if `tools/vendor/audio2face3d_claire` is complete | ~310 MB | 1–3 min |
| RTMW (part of the normal setup, downloaded on your click) | The official OpenMMLab zip (sha256-checked), unpacked to `.gpu\models\rtmw` | ~450 MB | 1–2 min |
| Maxine (asks first) | NVIDIA's own `nvidia_ar_sdk_installer_v0.8.7_blackwell.exe`, downloaded from NVIDIA's URL and sha256-checked (`db73b725…a847c`, which matches the copy the user downloaded). NVIDIA's installer is then **started for the user**: Windows asks for admin permission, the user goes through NVIDIA's licence, and the setup checks the result | 1.35 GB download + ~2 GB | 3–8 min |

How it behaves:
- It is idempotent. Every step checks first and skips what is already there.
- Downloads resume from scratch and are verified before use. A failed step says what to do, and the button runs it again.
- **Cancel** aborts downloads. **What would it do?** is a dry run: it shows the plan and sizes without changing anything.
- **Remove GPU files** deletes `.gpu\` (runtime, models, downloads). Remove the NVIDIA AR SDK in Windows Settings → Apps.
- It installs into `<repo>\.gpu\` (git-ignored). Override with `--dir` or `VTP_GPU_DIR`. The server also finds an
  older `%LOCALAPPDATA%\VTubePro\gpu`.
- Why not AppData: packaged apps (for example a terminal inside the Claude desktop app) see a private copy of
  AppData. A runtime created there is invisible to a server started from START.bat.

Licences:
- **The NVIDIA AR SDK installer is never bundled** with VTube Pro. It is under the NVIDIA Maxine EULA, so the setup
  downloads it from NVIDIA for the user.
- Audio2Face-3D: NVIDIA Open Model License (the notice is in THIRD_PARTY_NOTICES.md).
- RTMW: the code (mmpose) is Apache-2.0, **the weights have no licence of their own** and were trained on "Cocktail14",
  which includes InterHand2.6M (CC BY-NC 4.0, its README) and Human-Art (released for non-commercial use on request) and
  research-only face / body sets (WFLW, 300W, COFW, LaPa, AI Challenger, Halpe, UBody); checked at the OpenMMLab and
  dataset pages on 2026-10-23. Owner decision 2026-10-24: RTMW is offered to every user like the other sidecars. The
  setup downloads it from OpenMMLab on the user's click (sha256-checked) and it runs on the user's PC; the app states
  the fact above (`shared/gpuLicence.ts`) and does not block anything. The Apache-2.0 alternative that is always there is
  MediaPipe Pose + Hand Landmarker.
- onnxruntime-gpu: MIT. The NVIDIA CUDA / cuDNN pip wheels are under the NVIDIA licences shown on their PyPI pages.
- uv: MIT / Apache-2.0.

Tested on 2026-09-27:
- The dry run.
- A full run into a scratch folder with no `uv` on PATH and no `tools/vendor`: uv download, Python 3.12, onnxruntime
  with CUDA, the Audio2Face files from Hugging Face, and RTMW. A second run skipped every step.
- The Maxine branch was only checked up to "already installed" on this PC. The download itself was verified by hash.

Turning a feature on starts its sidecar through the server (`POST /api/gpu/<a2f|maxine|rtmw> {on}`). Overrides:
`VTP_GPU_PYTHON`, `VTP_GPU_DIR`, `VTP_RTMW_MODEL`, `VTP_A2F_MODEL_DIR` and `VTP_MAXINE_DIR`.

**Staying up.** The server supervises every sidecar that is switched on:
- If a sidecar exits, the server restarts it after 1 s, 2 s, 4 s and so on, up to 30 s between tries.
- It keeps every exit with its time and reason (`/api/gpu/status` → `exits`), and the UI shows the last one.
- The studio also asks the server to (re)start a sidecar when no results have arrived for 8 s. This covers a server
  restart, which kills the sidecars with it.
- The studio never stops reconnecting while a feature is on. After a page reload, an old page's socket could take
  the sidecar and then die (close code 4000); before this fix, that left GPU lip sync silently gone.

**Seeing that it works:**
- The status bar shows `GPU A2F ✓60 Maxine ✓30 RTMW ✓30`: ✓ followed by the results per second.
  - ✗ = the sidecar is not connected (it restarts by itself).
  - idle = connected, but nothing reaches the avatar.
  - RTMW only refines the body and hands: with both **Hands** and **Body** off (Tracking) it gets no frames on purpose
    and is never counted as a problem.
- `cache/diag/state.json` → `gpu` has, per source:
  - on / ready / fps / ms / age
  - A2F: `weight` (its share of the mouth right now) and `used`
  - Maxine: `weight` (share of each face expression) and `rangeSamples`
  - RTMW: `pointsReplaced`

Sidecars bind `127.0.0.1` only. Each one serves one studio at a time (a new connection replaces the old one), which is
why observer tabs never connect. A sidecar exits by itself when the server that started it is gone (`--parent-pid`), and
the server stops only the processes it started.

## Costs (measured on the RTX 5090, `tools/gpu/bench_costs.py`)

Method:
- The recorded clip is streamed in real time: 16 kHz audio in 10 ms chunks, and 640×360 JPEG frames at 30 or 60 fps.
- GPU utilisation is the `nvidia-smi` mean minus an idle baseline (18.4 %, other apps running). Changes under ~2 % are noise.
- VRAM is the total increase. Per-process VRAM isn't reported on Windows WDDM.
- CPU is the sidecar processes' CPU time divided by wall time.
- Latency is the time from sending to getting the result back. For Audio2Face, it is counted from the moment the audio
  it waits for (the future budget) has arrived.

| Feature | fps | GPU (+%) | VRAM | CPU cores | Added latency median / p95 |
|---|---|---|---|---|---|
| Audio2Face-3D | 30 | +1.6 | ~1.1 GB | 0.11 | 4.3 / 8.8 ms (+ the future budget, 20–150 ms, see below) |
| Audio2Face-3D | 60 | +4.8 | ~1.1 GB | 0.25 | 6.8 / 16.5 ms |
| Maxine face expressions | 30 | < 2 (noise) | ~0.6 GB | 0.11 | 2.9 / 5.0 ms |
| Maxine face expressions | 60 | < 2 (noise) | ~0.6 GB | 0.08 | 3.7 / 5.6 ms |
| RTMW-x whole body | 30 | +7.5 | ~1.2 GB | 0.72 | 12.3 / 24.8 ms |
| RTMW-x whole body | 60 | +12.8 | ~1.2 GB | 0.93 | 13.6 / 24.1 ms |
| **All three** | 30 | **+13.5** | **~2.9 GB** | 0.98 | A2F 6.3, Maxine 3.9, RTMW 13.3 ms |
| **All three** | 60 | **+24.8** | **~2.9 GB** | 1.52 | A2F 7.3, Maxine 4.5, RTMW 18.9 ms |

Per-inference times:
- Audio2Face network: 2.7 ms with a CUDA graph (7 ms without).
- Audio2Face blendshape solve: 0.3 ms (numpy active-set QP).
- Maxine: about 1 ms per frame.
- RTMW-x: 8 ms per frame. Most of its CPU is JPEG decoding and the crop.

Not measured: the studio's own JPEG encode for the camera features (one `drawImage` plus an async `convertToBlob` per
sent frame, on the main thread).

**Estimates for smaller RTX 50 cards** (not measured). These scale the GPU time by CUDA cores (5090: 21,760 · 5070:
6,144 → ×3.5 · 5060: 3,840 → ×5.7). VRAM stays the same.

| | Audio2Face 30 / 60 fps | Maxine | RTMW 30 / 60 fps | All three 30 fps |
|---|---|---|---|---|
| RTX 5070 (est.) | +6 % / +17 % | +3–6 % | +26 % / +45 % | ~+47 % |
| RTX 5060 (est.) | +9 % / +27 % | +3–6 % | +43 % / +73 % | ~+77 % (too much while gaming; use 30 fps and skip RTMW) |

## Which cards can run GPU lip sync, and the one question (`shared/gpuClass.ts`, `src/tracking/lipEngine.ts`, `src/tracking/a2fControl.ts`)

| Card | Audio2Face lip sync | Status |
|---|---|---|
| GeForce RTX 50-series (and RTX PRO Blackwell) | offered; with the Audio2Face files installed the studio **asks once** ("Your NVIDIA card can run better lip sync. Turn it on?"), never a GPU job by itself the first time | **measured** (RTX 5090; smaller 50-series cards are estimates) |
| GeForce RTX 20 / 30 / 40-series and the workstation cards (RTX A = Ampere, RTX ... Ada, Quadro RTX = Turing), at least 4 GB video memory | offered in *Tracking -> GPU lip sync*, never on by itself; the setup installs only the lip-sync runtime + model there | **untested**: shown with "not tested on this card" |
| GTX, AMD, Intel, no NVIDIA card, an RTX card under 4 GB | not offered: the browser engine (`src/tracking/neuralVisemes.ts` + the rule engine) | n/a |

* **Can RTX 20 / 30 / 40 run it?** It should. The sidecar uses `onnxruntime-gpu` with the CUDA 13 runtime that NVIDIA ships as pip
  wheels; CUDA 13 supports compute capability 7.5 and newer, which is Turing (RTX 20), Ampere (30) and Ada (40); the network is a
  plain convolution / GRU model; the same model needs ~1.1 GB. That is reasoning from the runtime's support list: **nobody has
  run it on one of those cards** (this PC has an RTX 5090), so it is offered with an honest note and the browser engine stays as
  the fallback. Needs a driver of 580 or newer (the setup checks it).
* **Generation comes from the card's family, never from the digits alone.** "NVIDIA RTX 5000 Ada Generation" is an Ada card, "RTX A5000"
  is Ampere, "Quadro RTX 5000" is Turing: none is a 50-series. 50-series = a GeForce RTX 50xx name (laptop variants too) or a
  Blackwell marker; the same rule is used by VTube Pro (`/api/gpu/status`), the GPU setup and the lip-sync advisor
  (`tools/lipengine_unit.ts` checks 30 real card names).
* **The question, not a start.** `chooseLipEngine` (pure): a measured card + files installed + never answered -> the studio shows a
  small non-blocking card, once: *Your NVIDIA card can run better lip sync. Turn it on?* [Turn on] [Not now]. **Nothing starts by
  itself the first time**, and nothing starts while OBS is streaming or recording (VTube Pro's check, below). Not asked while live.
* **The answer lives on the server** (`config/gpu.json`, `server/gpuChoice.ts`), not only in the browser: *accepted* = it stays on
  (a later session, even with a cleared browser, switches it on again once the mic is on); *declined* = never asked again (Tracking ->
  GPU lip sync still turns it on by hand, which counts as accepted). An "off" saved before this existed counts as declined.
* **The server's gate** (`POST /api/gpu/a2f`, `a2fStartDecision`, `tools/gpu_a2f_gate_unit.ts`): a start is refused (409) on a card that
  can't run it and while OBS is streaming / recording (the updater's own live signal), and (403) when nobody asked: neither a click
  (`user: true`) nor a saved "accepted". **When the server can't tell whether you are live** (OBS not linked or not answering: the
  signal is null), even an accepted owner is not auto-started at studio load: only a live reading taken at that very moment saying
  "idle" authorises an automatic start (nothing is cached: an idle seen earlier says nothing about now), otherwise it answers `needsClick` and the studio shows a small chip, "GPU lip sync is
  ready - Start"; only that click (`user: true`) starts it. A start from a saved setting is never sent as a click. Turning it off is
  never refused. The studio shows the reason in the GPU lip-sync status line.
* The browser engine always runs: a slow, dead or missing sidecar costs only the extra detail. Observer sandboxes never decide.

## Audio2Face-3D lip sync: how it works

```
mic → voice worklet (16 kHz, 10 ms chunks) → VAD worker ──ws──► a2f_sidecar.py (GPU)
                                                     ◄── 52 ARKit weights per frame, stamped with the audio instant
AudioLipSync.a2fMerge (by content time, like the neural visemes) → frame.a2f (gained mouth channels + k)
  → VisemeRig: seal / tuck = max(engine, A2F) · round / spread = max · jaw blended 60 % · lip detail channels on ARKit faces
```

- **The network needs future audio.** It sees a 0.52 s window centred on the frame, so full quality needs 260 ms of
  audio after the frame's instant.
  - Live, each frame waits `futureMs = clamp(lookahead − 30, 20, 150)` ms. The rest of the window is filled with a
    fading mirror of the last audio it heard.
  - Filling with zeros made the model expect silence and shrank the jaw by 52 % at 60 ms. The mirror keeps the full size.
  - Correlation with the full-context output on the clip:

    | Future audio | Correlation |
    |---|---|
    | 150 ms | 0.95–0.98 |
    | 100 ms | 0.84–0.95 |
    | 60 ms | 0.63–0.91 |
    | 30 ms | 0.46–0.83 |

    Rounding (pucker) needs the most future; the jaw needs the least.
  - It works best with **Better lip sync at 80–100 ms**. At 60 ms it still helps.
- **The blendshape solve** re-implements the SDK objective from `bs_skin_config.json`:
  - L2, L1, temporal and symmetry terms, the active poses, and the multipliers.
  - It runs as a small bounded QP over the 10,085 frontal-mask vertices, precomputed against the PCA basis.
  - The rest face is the network's own output for silence. Solving against the blendshape neutral left a constant
    0.1–0.2 of shrug, frown and brow on every frame.
- **Gains** (`A2F_GAIN` in `src/tracking/a2fMerge.ts`) map Claire's realistic range onto the anime range, e.g. held
  "aa" jaw 0.22 → 0.7. The *Mouth size* slider scales them.
- **The voice gate still decides what counts as speech.** A2F fades in within 40 ms of the engine hearing speech and
  out 200 ms after it, so keyboard clicks don't move the mouth.
- **F/V on humanoid avatars:** Skyisles, Aosabi and Elias all have `mouthRollLower`, so F/V is drawn as lower-lip roll,
  shrug and upper-lip lift. Models without `mouthRollLower` keep the rig's existing substitute (press plus lip raise,
  VRM "ih" + close).

### Tongue, eyes and emotion channels (`tools/gpu/a2f_extras_eval.py`, recorded clip, CPU run)

The sidecar's stream carries 60 channels: the 52 ARKit weights, with `tongueOut` and the `eyeLook*` slots now filled (they were
always 0), then 8 tongue poses (`tongueTipUp / TipDown / Up / Down / Stretch / Wide / Narrow / In`) from A2F's own 16-pose tongue
rig (same bounded solve as the skin, against the network's silence as the rest tongue). An older client ignores the extra names; an
older sidecar just has none (`tools/a2f_link_test.ts` checks the live chain). What they do on an avatar, honestly:

* **Tongue** (A2F's alone: the camera can't see it): speech moves the poses to 0.02-0.2 (`tongueDown`, `tongueIn` the most) and
  `tongueOut` itself to <= 0.03, because nobody sticks the tongue out while talking; gains x3-x8 (`A2F_EXTRA_GAIN`). It feeds
  `tongueOut` on ARKit faces, the procedural mouth's tongue-up / tip, and the Pro2D `tongueOut`. Expect little visible change.
* **Eyes**: the network's eye rotation is nearly constant (rest 0.19 rad) with +-0.03-0.1 rad of motion that *follows the jaw*
  (correlation -0.54 with jawOpen): it is micro-motion, not gaze. Mapped to `eyeLook*` per eye against a running rest, x0.6,
  and would be used only while the camera has lost the performer. **It is computed and carried but NOT applied** (dev flag
  `localStorage vtp.dev.a2fEyes = '1'`, `a2fDev.eyes` in `shared/lipBus.ts`): the up / down sign is the network's convention, NVIDIA's
  docs don't give it and it could not be checked against a reference, so nothing reads it as a gaze until it is verified. The
  left / right pairing logic (left-out + right-in = avatar-left) is tested with the flag on.
* **Emotion**: Audio2Face's emotion is an *input*. With the default neutral emotion its brows, cheek squint, eye-wide and nose
  sneer stay <= 0.07 on the clip, so they are wired (raise-only, 35 % while the camera tracks, whole when it has lost the face)
  but do nothing visible. Feeding an explicit emotion makes them move (eyeWide 0.34 amazement / 0.41 fear, brow-outer 0.14 grief),
  but it also moves the mouth (anger raised the smile channel to 0.27): the studio does not send one, and mapping our emotion
  estimate onto A2F's ten is not validated.
* The 3D rig and the Pro2D drive read all of it through `shared/lipBus.ts` (`readA2f`), which applies the camera rules.

### Measured on the recorded clip (`tools/eval_a2f.ts`, the real viseme rig, 32 hand labels)

| Lookahead (future) | Measure | Before | +A2F |
|---|---|---|---|
| 60 ms (30 ms) | M/B/P sealed, cam+mic / mic only | 10/11 / 7/11 | 10/11 / **8/11** |
| | F/V tucked | 3/4 | 3/4 |
| | jaw vs the performer's real (camera) jaw, Pearson r, cam+mic / mic | 0.544 / 0.518 | **0.557 / 0.536** |
| | mouth width vs real, r, cam+mic / mic | 0.187 / 0.025 | **0.193 / 0.032** |
| | held "oo" pucker (mic) | 0.614 | **0.651** |
| | "ee" spread − "oo" (mic) | 0.487 | 0.400 (less contrast) |
| 100 ms (70 ms) | jaw vs real jaw, r, cam+mic / mic | 0.626 / 0.555 | **0.656 / 0.598** |
| | mouth width vs real, r, cam+mic / mic | 0.228 / 0.028 | **0.242 / 0.079** |
| | M/B/P sealed (mic) | 7/11 | **8/11** |

What these numbers mean:
- The mouth follows the performer's real mouth a bit better, and one more M/B/P seals without the camera.
- F/V did not change on this clip. The engine's categorical detectors already catch 3 of the 4 labelled F/Vs, and the
  one it misses is the borderline "fluFFy".
- An earlier blend that *replaced* rounding and spreading scored higher on "follows the real mouth" (mic-only width
  r 0.157) but lost vowel contrast. The shipped blend keeps the contrast.
- Filmstrips (`tools/a2f_strip.ts`, the app renderer, before / +A2F 60 / +A2F 100) are in the gputrack scratch folder:
  `shots/zoom_<avatar>_<t>.jpg`.
- The live chain was checked end to end in Node (`tools/a2f_link_test.ts`: a2fLink → sidecar → A2fMerge). About
  60 frames/s arrived, each about 71 ms after its instant with futureMs 60 (60 ms wait + 11 ms), and a frame was
  available for 591 of 600 ticks.
- **Not tested:** a browser run with a real microphone.

## Maxine face expressions: checked on the clip (`maxine_core.py`, clip at 640×360)

- 1.0 ms median per frame (p95 1.7 ms). A face was found in all 4,362 frames.
- Correlation with MediaPipe while talking:

  | jawOpen | pucker | smile | rollLower | mouthClose | funnel |
  |---|---|---|---|---|---|
  | 0.85 | 0.82 | 0.81 | 0.81 | 0.59 | 0.36 |

- Maxine shows less resting noise:

  | At rest | MediaPipe | Maxine |
  |---|---|---|
  | blink | 0.27 | 0.03 |
  | lower-lip roll | 0.18 | 0.03 |

- On "mama baba papa" Maxine sees the lips close (mouthClose 0.20, MediaPipe 0.03).
- Winks are on the correct side.
- Maxine gives smaller values than MediaPipe for pucker ("oo" 0.34 vs 0.83), so *Maxine share* defaults to 0.8. The
  rest of the pipeline (natural capture, per-user calibration) re-normalises expression sizes.
- The studio sends frames at 30 or 60 fps as JPEG. Results are folded into MediaPipe's blendshape scores before
  `FaceSolver` runs (`src/tracking/gpuVision.ts`). Head pose and landmarks stay MediaPipe's.
- **Range alignment** (added 2026-09-27, after "something is missing" with everything on):
  - Before blending, each Maxine channel is mapped into MediaPipe's own range for this performer, using the running
    10th / 95th percentiles of both on the same frames (last 60 s).
  - Why: the face calibration, natural capture and expression model were learned on MediaPipe's numbers. Raw Maxine
    values (resting blink 0.03 where MediaPipe says 0.27, "oo" pucker 0.34 where MediaPipe says 0.83) made the
    calibrated face read as eyes wide open and small mouth shapes.
  - Until about 5 s of paired frames exist, only 30 % of Maxine is used.
- Eye gaze: the AR SDK's gaze output belongs to its *GazeRedirection* feature, which is not wired. The expression
  coefficients already include eyeLook*.
- **Not tested:** a live browser session with the webcam.

## RTMW whole body: checked on the clip

- 8.0 ms per frame on the network (p95 9.2 ms).
- The recorded clip only shows head and shoulders, with no hands. **Arm and hand accuracy before / after could not be
  measured on it.** What was checked:
  - After mapping SimCC scores to confidence and zeroing points outside the picture, there were 0 phantom hands in
    4,362 frames.
  - Shoulders were found (mean confidence 0.69).
  - Shoulder jitter is 2.0 px (2nd difference at 640 px) with the smoothed crop, down from 5.6 px with the raw crop.
- Integration: where RTMW is confident (> 0.5), MediaPipe Pose's 2D arm and hip landmarks and each detected hand's 21
  points are replaced by RTMW's. MediaPipe keeps depth, visibility and world landmarks.
- Hands MediaPipe misses are not added yet. That would need world landmarks.
- Next step: record a clip with hands in view (Track → Record expression test clip, arms moving) and compare
  `tools/eval_body.ts`-style jitter and dropout with and without RTMW.

## Files

- `shared/gpuClass.ts` (which cards), `src/tracking/lipEngine.ts` (the choice), `shared/lipBus.ts` (what the avatars read)
- `tools/gpu/`:
  - `a2f_core.py`, `a2f_sidecar.py`, `a2f_offline.py`, `a2f_extras_eval.py`
  - `maxine_core.py`, `rtmw_core.py`, `vision_sidecar.py`
  - `bench_costs.py`, `gpu_setup.ts` (the installer; `setup_gpu.py` forwards to it)
- `server/gpuSidecars.ts` (+1 line in `server/index.ts`)
- `src/audio/voice/a2fLink.ts` (+ hooks in `vadWorker.ts`, `voice-worklet.js`, `voiceFrontEnd.ts`)
- `src/tracking/a2fMerge.ts` (+ `audioLipSync.ts`)
- `src/tracking/gpuVision.ts`
- `src/avatar/visemeRig.ts` (A2F block)
- `shared/types.ts` (`TrackingFrame.a2f`), `src/outputSync.ts` (copies it to OBS)
- `src/app.ts` (4 small hooks)
- `src/ui/gpuPanel.ts` (+ `shell.ts`)
- Tools: `tools/eval_a2f.ts`, `tools/a2f_strip.ts`, `tools/a2f_link_test.ts`, `tools/lipengine_unit.ts`, `tools/lipbus_unit.ts`
