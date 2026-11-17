# Two webcams (multi-camera face capture)

A second USB webcam next to the main one (e.g. a Logitech StreamCam next to the Elgato Facecam). Code:
`src/tracking/multicam/*` (math, calibration, fusion, manager), UI `src/ui/multicamPanel.ts` (Tracking card, the
"Use two webcams" wizard, Tracking → Advanced → Voice, phone & 2nd camera). Benchmarks: `tools/eval_multicam.ts`,
`tools/multicam_render.py`.

## Roles

| Role | Camera 2 placement | What it does |
|---|---|---|
| **Stereo** | 30–60 cm to the side of the main camera, same height or a bit lower, aimed at your face; both see the whole face | Self-calibrated two-view fusion. The main camera stays in charge; camera 2 takes over the face regions the main camera can't see (hand over the mouth, head turned far away), carries the whole face when the main camera loses it, and measures the true distance |
| **Close-up mouth** | Below the monitor / on the desk, 35–50 cm away, tilted up at the mouth; the whole face still in frame | Mouth / jaw blendshapes weighted towards camera 2 (works uncalibrated; calibrated it also uses the stereo path) |
| **Body & hands** | Behind / above the main camera, 1–2 m away, same direction, head-to-hands in frame | Pose + hands (+ gestures) come from camera 2; the main camera can be tight on the face. Camera 2 follows the **Hands** / **Body** switches (Tracking): what is off isn't tracked there either, and with both off camera 2 rests |

## How it works

- **Second tracker**: its own Web Worker (face model on the GPU delegate; `Tracker` with `allowMain = false`), a
  face-rate cap (default 30/s) and a gate: camera 2 is only fed while the main camera's face model is idle (or when
  it is overdue), so the main camera's face latency does not grow. Default 1280×720@30.
- **Fallback**: camera 2 unplugged / stalled (> 1.5 s) / worker crash / picture shape change → the main camera alone
  on the next frame; re-opened automatically when the device returns. Fusion errors are caught per frame.
- **Self-calibration** (`stereoCalib.ts`, ~15 s look-around, solved in a worker in ~1 s): clock offset from
  cross-correlating the speed of the face in both views; rotation initialised from MediaPipe's per-camera poses;
  baseline direction from linear epipolar constraints; Levenberg–Marquardt on the reprojection error over rotation,
  baseline direction and both focal lengths (6 % prior around the spec FOV); metric scale from the triangulated irises
  (11.7 mm; 63 mm inter-pupil as a sanity check). **Only feature landmarks** (eye corners/lids, irises, nostrils,
  nose tip, lip corners/centre, brows) are used: MediaPipe places points on smooth skin from its shape prior, and
  those don't land on the same physical spot from two directions.
- **Fusion** (`stereoFuse.ts`, ~1.5 ms/frame), output is a normal FaceLandmarker result in the main camera's image,
  so FaceSolver and everything after it is unchanged:
  - the main camera's landmarks and rotation are kept wherever it sees the face (robust style);
  - a region covered by a tracked hand is taken over (80 ms ramp) from camera 2 — its rays at the triangulated depth,
    rigidly motion-compensated to the main camera's time, plus a per-landmark offset learned while both are clean;
  - blendshapes are fused per face region by visibility (mesh normals vs each camera), occlusion and age; camera 2's
    coefficients go through a per-channel linear map learned online (a camera below reads jawOpen differently);
  - main camera lost the face → "B-only": the face re-projected from camera 2, its rotation with a learned bias.
  - `style = 'blend'` (averaging everywhere) exists for experiments; it did not beat the main camera on real
    MediaPipe data (below).

## Results (2026-09-25)

Recorded guided clip (Elgato, 1280×720) as camera A. Camera B: (1) **rendered** — the clip re-rendered from a virtual
second camera 25° to the side (face mesh textured with the real frames) and run through the **real MediaPipe**;
(2) **synthetic** — the truth projected at 35° plus MediaPipe noise transplanted from elsewhere in the clip. B at
30 fps, 23 ms clock offset. Truth = the clip's landmarks smoothed over ±35 ms.

| Metric | Main camera alone | Two cameras (rendered, real MediaPipe) | Two cameras (synthetic) |
|---|---|---|---|
| Calibration: rotation / baseline-direction error | — | 2.5° / 1.1° (10.5° before feature-only landmarks) | 0.4° / 0.5° |
| Calibration: baseline (vs truth), focal errors | — | −6 %, < 1 % | −0.7 %, < 0.5 % |
| Landmark error, clean frames | 0.54–0.88 px per region | identical (main camera kept) | identical |
| Landmark error, whole clip incl. hand-over-mouth | 0.86 px | 0.58 px | 0.58 px |
| Mouth blendshape error while a hand covers the mouth | 0.039 | 0.025 | 0.006 |
| Frames with a face while the main camera loses it (1.9 s) | 0 / 90 | 90 / 90 (8–13 px, 0.3–1.5°) | 90 / 90 |
| Head rotation jitter (rest) | 0.100° | 0.101° | 0.099° |
| Triangulated head distance, rms vs truth | — | 2.1 mm | 0.8 mm |
| Very late / slow camera 2 (150 ms, 10 fps) | — | falls back to mono most of the time, no instability | |

Honest summary: with both cameras seeing you clearly, the output is the main camera's (the fusion never made clean
frames better on real MediaPipe data — cross-view landmark disagreement is larger than MediaPipe's own noise). The
gains are **robustness**: hand over the mouth, head turned away, main camera losing you, plus a measured distance.
The existing rest stabiliser already takes head jitter to ~0.1°.

End-to-end in the browser (observer sandbox, both views as video files): wizard calibration finished by itself,
"Great · 11 cm apart · 23° · 1.3 px"; fusion ran at 1.5–1.8 ms/frame. With the live studio also running, camera 2
got 9–14 results/s at 23–30 ms in a hidden background tab — expect more with the studio in front.
Real Logitech StreamCam (ffmpeg, 5 s, 1280×720@30): 150/150 frames with a face, 9.8 ms per frame on the CPU.

Not validated yet: a real Elgato + Logitech stereo calibration (the Elgato belongs to the live studio).

## Setting it up (for the performer)

1. Plug the second webcam into a different USB port than the main one (another side of the PC if possible).
2. **Tracking** → **📷📷 Second webcam** → *Use two webcams* (or Settings → Guided set-ups → Use two webcams). The main camera
   must be on.
3. Pick the role, pick camera 2, click *Turn on camera 2*. Both pictures show green/blue face points.
4. Place it as the wizard says for the role (table above). Don't move either camera afterwards.
5. Calibrate (stereo; optional for the close-up mouth): sit normally, slowly turn your head left and right, then nod —
   it finishes by itself (about 15 s) and shows how good it is. "Poor": slower, bigger turns, better light.
6. Before / after: 12 s — sit still, talk, cover your mouth, turn away; watch camera 2 take over.
7. It then starts with the main camera every time. Tracking → Advanced → Voice, phone & 2nd camera has resolution, frame rate, camera-2 rate and
   "keep my face when only camera 2 sees it". If a camera gets bumped, calibrate again.

## State of the art (web research 2026-09-25, licences)

Full notes with sources: the multicam research report delivered with this work. Short version:
- Keep MediaPipe Face Landmarker (Apache-2.0) as the backbone; no newer face mesh / blendshape model was found for
  2024–2026. Its blendshape head reads x,y of 146 landmarks (an Apache-2.0 PyTorch port exists) → a per-user
  fine-tune on our own calibration capture is the most promising commercial-safe upgrade.
- Optional RTX tier: NVIDIA Maxine AR SDK (53 ARKit-mappable expressions, gaze, pose; ~1–2 ms on an RTX 5090) as a
  native sidecar; commercial use allowed on NVIDIA GPUs with branding — the EULA needs a legal review first.
- Not usable in the product (non-commercial weights or training data): InsightFace models, 3DDFA_V2/V3, SynergyNet,
  DECA / EMOCA / SMIRK / SPECTRE and other FLAME-family trackers, L2CS-Net / ETH-XGaze / UniGaze gaze models,
  Microsoft FaceSynthetics, Meta Sapiens. FreeMoCap is AGPL (don't embed); aniposelib (BSD-2) is a safe reference.
