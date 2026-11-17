# Third-party notices

Components bundled with VTube Pro's voice front-end (`public/vendor/voice/`, installed from npm; see `package.json`).

| Component | Files | Version | License |
|---|---|---|---|
| RNNoise (Xiph.Org / Mozilla, Jean-Marc Valin), WebAssembly build by Jitsi (`@jitsi/rnnoise-wasm`) | `public/vendor/voice/rnnoise.wasm` | 0.2.1 | RNNoise: BSD-3-Clause · wasm build/wrapper: Apache-2.0 |
| Silero VAD v5 (Silero Team, github.com/snakers4/silero-vad), model file as shipped in `@ricky0123/vad-web` | `public/vendor/voice/silero_vad_v5.onnx` | vad-web 0.0.31 | model: MIT · vad-web package: ISC |
| ONNX Runtime Web (Microsoft) | `public/vendor/voice/ort.wasm.min.mjs`, `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` | 1.30.0 | MIT |
| VTube Pro neural viseme model (own work, trained 2026-09-25 with `tools/nv/`) — **trained on LibriSpeech** (Panayotov, Chen, Povey, Khudanpur; openslr.org/12) with Montreal-Forced-Aligner phone alignments shared by Loren Lugosch (zenodo 2619474, via huggingface.co/datasets/gilkeyio/librispeech-alignments) | `public/vendor/voice/nv_visemes.json` | round 3 | weights: this project's licence · training data: **CC BY 4.0** (attribution below) |


## Basis Universal — Apache License 2.0 (Pro2D texture compression, `public/vendor/basis/`)

| Component | Files | Version | License |
|---|---|---|---|
| Basis Universal GPU texture codec (Binomial LLC), prebuilt WebAssembly encoder + transcoder from the official repository (`webgl/encoder/build`, `webgl/transcoder/build`, tag `v2_50`, downloaded 2026-10-06, unmodified; SHA-256: encoder.js d225ce1e…4a6ffb, encoder.wasm 48d4e39c…0552db, transcoder.js 720dd9bd…834dc8, transcoder.wasm a0f65d4a…f6c139) | `public/vendor/basis/basis_encoder.js`, `basis_encoder.wasm`, `basis_transcoder.js`, `basis_transcoder.wasm` | 2.50 | Apache-2.0 (licence: `docs/licenses/basis_universal_LICENSE.txt`) |

NOTICE (Basis Universal, reproduced as Apache-2.0 §4(d) requires; full text `docs/licenses/basis_universal_NOTICE.txt`):
Basis Universal™ Supercompressed GPU Texture Compression Library. Copyright © 2016–2026 Binomial LLC. All rights reserved
except as granted under the Apache 2.0 license. "Basis Universal" is a trademark of Binomial LLC. Provided "as is", without
warranty of any kind (Apache 2.0 §§7–8).

## LibriSpeech + LibriSpeech alignments — CC BY 4.0 (training data of `nv_visemes.json`)

The neural viseme model was trained on "LibriSpeech ASR corpus" by Vassil Panayotov, Guoguo Chen, Daniel Povey and
Sanjeev Khudanpur (https://www.openslr.org/12, derived from LibriVox audiobooks), licensed CC BY 4.0
(https://creativecommons.org/licenses/by/4.0/), using the Montreal Forced Aligner phone alignments published by Loren
Lugosch (https://zenodo.org/record/2619474) as redistributed in https://huggingface.co/datasets/gilkeyio/librispeech-alignments
(CC BY 4.0). Changes: audio re-mixed with synthetic noise, equalisation, gain and room reverberation for training; only
the trained weights are distributed — no audio or transcripts. Neither the dataset authors nor LibriVox endorse this project.

## RNNoise — BSD 3-Clause

Copyright (c) 2017, Mozilla
Copyright (c) 2007-2017, Jean-Marc Valin
Copyright (c) 2005-2017, Xiph.Org Foundation
Copyright (c) 2003-2004, Mark Borgerding

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

- Redistributions of source code must retain the above copyright notice, this list of conditions and the following
  disclaimer.
- Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
  disclaimer in the documentation and/or other materials provided with the distribution.
- Neither the name of the Xiph.Org Foundation nor the names of its contributors may be used to endorse or promote
  products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE FOUNDATION OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF
USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## @jitsi/rnnoise-wasm — Apache License 2.0

Copyright Jitsi / 8x8, Inc. Licensed under the Apache License, Version 2.0 (the full text ships in
`node_modules/@jitsi/rnnoise-wasm/LICENSE`; http://www.apache.org/licenses/LICENSE-2.0). The `.wasm` file is used
unmodified; VTube Pro instantiates it directly instead of through the package's JavaScript glue.

## Silero VAD — MIT

Copyright (c) 2020-present Silero Team

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## @ricky0123/vad-web — ISC

Copyright (c) ricky0123. Permission to use, copy, modify, and/or distribute this software for any purpose with or
without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all
copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE. (Only
its bundled Silero model file is used.)

## ONNX Runtime Web — MIT

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Models and tools in `tools/vendor/` (downloaded 2026-09-25, user-approved; SHA-256 verified against Hugging Face LFS)

These are **development / evaluation assets** — none is loaded by the studio, the OBS page or the server at runtime today
(see docs/VOICE.md "Neural lip sync evaluation"). If any is shipped to users later, its notice below must ship with it.

| Component | Files | Source | License |
|---|---|---|---|
| wav2arkit_cpu (myned-ai; wav2vec2-base-960h + LAM Audio2Expression, fused) | `tools/vendor/wav2arkit_cpu/` (`wav2arkit_cpu.onnx` + `.onnx.data`, 404 MB fp32) | https://huggingface.co/myned-ai/wav2arkit_cpu | Apache-2.0 (model card; base models facebook/wav2vec2-base-960h and 3DAIGC/LAM_audio2exp are Apache-2.0; LAM does not document its training data) |
| NVIDIA Audio2Face-3D v2.3.1 Claire (regression) | `tools/vendor/audio2face3d_claire/` (307 MB) + `NOTICE.txt`, `LICENSE-NVIDIA-Open-Model-License.txt` | https://huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire | NVIDIA Open Model License (commercial use allowed; redistribution requires the agreement + the notice below; terminates if safety guardrails are bypassed without a substantially similar replacement) |
| Rhubarb Lip Sync 1.14.0 (Daniel S. Wolf), Windows release zip — test reference AND offline lip sync of the AI game master's rendered voice lines (`server/lipsync/rhubarb.ts`, run headless as a separate process, only when installed; ships with its `LICENSE.md`) | `tools/vendor/rhubarb/Rhubarb-Lip-Sync-1.14.0-Windows.zip`, `LICENSE.md` | https://github.com/DanielSWolf/rhubarb-lip-sync/releases/tag/v1.14.0 | MIT (dependencies MIT / BSD / Boost and similar, see its LICENSE.md) |
| RTMW-x whole-body pose (OpenMMLab mmpose), ONNX: downloaded per user by `tools/gpu/setup_gpu.py --rtmw`, not in the repo | `%LOCALAPPDATA%\VTubePro\gpu\models\rtmw\` | https://download.openmmlab.com/mmpose/v1/projects/rtmw/onnx_sdk/ | **Not shipped in the repo or the installer; offered to every user, downloaded from OpenMMLab on their click (owner decision 2026-10-24).** Note: code Apache-2.0 (mmpose), but the checkpoint has no licence of its own and was trained on Cocktail14 (incl. InterHand2.6M CC BY-NC 4.0, Human-Art non-commercial, WFLW / 300W / COFW / LaPa / AI Challenger / Halpe / UBody research data). It runs on the user's own PC (`shared/gpuLicence.ts` holds the one-line note the app shows). Apache-2.0 alternative always in the app: MediaPipe Pose + Hand Landmarker |
| NVIDIA Maxine AR SDK: NOT included; the user installs NVIDIA's runtime and VTube Pro only calls its API | `C:\Program Files\NVIDIA Corporation\NVIDIA AR SDK` | https://www.nvidia.com/broadcast-sdk-resources | NVIDIA Maxine EULA (in the SDK folder) |
| Depth Anything V2 Small, ONNX export (onnx-community) | `tools/vendor/depth_anything_v2_small/onnx/model_fp16.onnx`, `model_q4f16.onnx` | https://huggingface.co/onnx-community/depth-anything-v2-small | Apache-2.0 (the Small model only — Base / Large / Giant are CC-BY-NC-4.0 and must not be used) |

Not downloaded (licence not as required): ZIPA-CR small ONNX (no licence on the ONNX repo). RTMW (code Apache-2.0, no weights
licence, trained on research-licensed datasets) is a per-user download on the user's click: see the RTMW row above.

### NVIDIA Audio2Face-3D — required notice

Licensed by NVIDIA Corporation under the NVIDIA Open Model License

(Full agreement: `tools/vendor/audio2face3d_claire/LICENSE-NVIDIA-Open-Model-License.txt`.)

### wav2arkit_cpu, Depth Anything V2 Small — Apache License 2.0

Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Model files are used
unmodified.

### Rhubarb Lip Sync — MIT License

Copyright (c) 2015-2016 Daniel Wolf. Full text including third-party dependency licences:
`tools/vendor/rhubarb/LICENSE.md` (a copy: `docs/licenses/rhubarb_LICENSE.md`). Its dependencies are MIT / BSD / Boost: Boost,
CMU Sphinx US English acoustic model, cppformat, Flite, Microsoft GSL, libogg, PocketSphinx, Sound Change Applier, sphinxbase,
TCLAP, UTF8-CPP, utf8proc (MIT + Unicode data licence), libvorbis, WebRTC, and `whereami` (WTFPL: permissive; no GPL / AGPL / NC
anywhere). The release zip also carries Spine / After Effects / Vegas extras and test wavs; VTube Pro uses only `rhubarb.exe`
and `res/`.

### HeadAudio (met4citizen) — evaluated only

MIT (Copyright (c) 2025 Mika Suominen). HeadAudio 1.0.0 was run in a scratch folder to measure it against our own lip sync
(`tools/eval_headaudio.ts`, docs/VOICE.md); it is **not** a dependency and not bundled. Its model was trained on Kokoro TTS voices.

---

# Rendering, animation and asset-library components (added 2026-09-25)

Raw downloads live in `tools/vendor/<source>/` (with each pack's own licence file); what ships is listed per row. Full
file list with sizes and SHA-256: the download manifest of 2026-09-25 (`docs/ASSET_LIBRARY.md` → Provenance).

| Component | Where it ships | Version / files | License | Source |
|---|---|---|---|---|
| **postprocessing** (Raoul van Rüschen / pmndrs) — SMAA edge-detection + weights materials, SMAA lookup images | bundled JS (`src/stage/post/Pipeline.ts`) | npm 6.39.5 | Zlib (text below) | https://github.com/pmndrs/postprocessing |
| **N8AO** (N8python) — screen-space ambient occlusion | bundled JS (`src/stage/post/Pipeline.ts`) | npm 2.0.1 | CC0 1.0 (repo LICENSE; the npm metadata says ISC) | https://github.com/N8python/n8ao |
| **@pixiv/three-vrm-animation** (pixiv Inc.) — VRMA loader | bundled JS (`src/avatar/emotes.ts`) | npm 3.5.5 (+ @pixiv/types-vrmc-vrm-animation-1.0 3.5.5) | MIT, © 2019-2026 pixiv Inc. | https://github.com/pixiv/three-vrm |
| **Poly Haven HDRIs**: small_harbour_sunset, belfast_sunset_puresky, empty_warehouse_01, hospital_room_2, rogland_clear_night, fireplace, abandoned_factory_canteen_01 | `assets/hdri/<name>_1k.hdr` (downscaled by `tools/hdri_prep.py`; 2k originals in `tools/vendor/polyhaven/hdri/`) | 2k .hdr | CC0 1.0 | https://polyhaven.com/hdris (per asset: polyhaven.com/a/<name>) |
| **Poly Haven models**: modular_wooden_pier, wooden_barrels_01, wooden_crate_02, wooden_lantern_01 (1k glTF) | `assets/library/props/polyhaven_harbour/` | 1k glTF + textures | CC0 1.0 | https://polyhaven.com/models |
| **Quaternius — Universal Animation Library 1 + 2** (Standard) | retargeted clips: `assets/library/anims/npc/*.json`, `assets/library/anims/vrma/*.vrma` | Standard (free) GLB/FBX | CC0 1.0 | https://quaternius.itch.io/universal-animation-library, …/universal-animation-library-2 |
| **Quaternius — Universal Base Characters** (Standard) | raw only (`tools/vendor/quaternius/`), for future NPC bodies | Standard | CC0 1.0 | https://quaternius.itch.io/universal-base-characters |
| **Quaternius — Modular Sci-Fi MegaKit, Fantasy Props MegaKit** (Standard) | `assets/library/props/quaternius_scifi_megakit/`, `…/quaternius_fantasy_props/` | glTF + textures | CC0 1.0 | https://quaternius.itch.io/modular-sci-fi-megakit, …/fantasy-props-megakit |
| **KayKit — Dungeon Remastered 1.1** (Kay Lousberg, free tier) | `assets/library/props/kaykit_dungeon/` | glTF + atlas | CC0 1.0 (please don't resell unmodified copies) | https://kaylousberg.itch.io/kaykit-dungeon-pack |
| **Kenney — Impact Sounds, UI Audio** | `assets/library/sounds/kenney_impact/`, `…/kenney_ui/` | 130 + 51 .ogg | CC0 1.0 | https://kenney.nl/assets/impact-sounds, https://kenney.nl/assets/ui-audio |
| **Kenney — Impact Sounds, UI Audio** (12 starter stings, unmodified copies) | `assets/library/stings/*.ogg` (bell, blip, bonk, clang, click, crash, glass, pickaxe, pop, punch, thud, tin) | .ogg | CC0 1.0 | https://kenney.nl/assets/impact-sounds, https://kenney.nl/assets/ui-audio |
| **VTube Pro starter stickers and Throw & Bonk props** (own work, drawn from plain shapes, no outside art) | `assets/library/stickers/`, `assets/library/throwables/` | 10 .png, 13 .svg | CC0 1.0 | https://creativecommons.org/publicdomain/zero/1.0/ |
| **The 100STYLE Dataset – Ian Mason** (Mason, Starke, Komura 2022): 12 styles (Neutral, Proud, Old, Drunk, HandsInPockets, Depressed, Strutting, Tiptoe, Heavyset, OnPhoneRight, ArmsBehindBack, Rushed) × forward walk + idle | retargeted loops `style_*` in `assets/library/anims/npc/*.json` (BVH originals in `tools/vendor/100style/`) | BVH, Frame_Cuts.csv, Dataset_List.csv | **CC BY 4.0 — credit required**: "The 100STYLE Dataset – Ian Mason" (shown in Setup → Credits) | https://www.ianxmason.com/100style/ |

Changes made to CC-BY material (100STYLE): retargeted to the VTube Pro NPC skeleton, trimmed to one loop per take,
facing / root drift removed, seam cross-faded, resampled to 30 fps (tools/retarget/retarget.py). CC0 packs are used
as-is (glTF buffer / texture paths rewritten when staged; one Sci-Fi MegaKit decal referenced a misnamed buffer and was
pointed at the file that ships).

## postprocessing — Zlib

Copyright © 2015 Raoul van Rüschen

This software is provided 'as-is', without any express or implied warranty. In no event will the authors be held
liable for any damages arising from the use of this software.

Permission is granted to anyone to use this software for any purpose, including commercial applications, and to alter
it and redistribute it freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim that you wrote the original software. If
   you use this software in a product, an acknowledgment in the product documentation would be appreciated but is not
   required.
2. Altered source versions must be plainly marked as such, and must not be misrepresented as being the original
   software.
3. This notice may not be removed or altered from any source distribution.

## @pixiv/three-vrm-animation — MIT

Copyright (c) 2019-2026 pixiv Inc. Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions: The
above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## 100STYLE — CC BY 4.0

"The 100STYLE Dataset – Ian Mason" — https://www.ianxmason.com/100style/ — licensed under the Creative Commons
Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/). Paper: I. Mason, S. Starke,
T. Komura, "Real-Time Style Modelling of Human Locomotion via Feature-Wise Transformations and Local Motion Phases",
Proc. ACM Comput. Graph. Interact. Tech. 5(1), 2022.

## Blender Human Base Meshes v1.4.1 (dev/build asset)
- Source: https://mirror.blender.org/demo/asset-bundles/human-base-meshes/human-base-meshes-bundle-v1.4.1.zip (Blender Foundation demo files)
- License: CC0 1.0 (public domain dedication)
- Local path: tools/vendor/blender_human_base_meshes/ (not committed); SHA-256 of the zip: 811f43accbb31a88266d932f8f5563b2d13586fca0ba2693aad1f5fe582b3515

## glTF-Validator (npm `gltf-validator`, dev dependency)
- Source: https://github.com/KhronosGroup/glTF-Validator — License: Apache-2.0

## pixelmatch (npm, dev dependency)
- Source: https://github.com/mapbox/pixelmatch — License: ISC

## MediaPipe Face Mesh topology — Apache License 2.0

`src/tracking/multicam/faceMesh.ts` embeds the 852-triangle face-mesh tessellation (`FACE_LANDMARKS_TESSELATION`) and the
landmark index groups (lips, eyes, brows, face oval, irises) of Google's MediaPipe Face Landmarker
(https://github.com/google-ai-edge/mediapipe, Copyright 2023 The MediaPipe Authors), licensed under the Apache License,
Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). No model weights are copied: the app keeps using the
`face_landmarker.task` it already ships. The dev-only benchmark `tools/multicam_render.py` uses the `mediapipe`,
`opencv-python-headless` and `numpy` Python packages (Apache-2.0 / Apache-2.0 / BSD-3-Clause) in a scratch virtualenv;
they are not bundled.

## MediaPipe FaceLandmarker graph (processor-only face tracker) — Apache License 2.0

`src/tracking/cpuFace/faceGraph.ts`, `geometry.ts` and `imageOps.ts` are TypeScript ports of the logic of MediaPipe's
FaceLandmarker graph (https://github.com/google-ai-edge/mediapipe, Copyright 2023 The MediaPipe Authors, Apache License,
Version 2.0): face_landmarker_graph.cc, face_detector_graph.cc, face_landmarks_detector_graph.cc,
face_blendshapes_graph.cc, the SSD-anchor / tensors-to-detections / weighted non-max-suppression / detections-to-rects /
rect-transformation / landmark-projection / one-euro landmark-smoothing / landmarks-to-tensor calculators, the
image-to-tensor (OpenCV) preprocessing and the face geometry pipeline with its Procrustes solver. It includes the
blendshape names and the 146-landmark blendshape input subset. Modified for this app: a different runtime
(onnxruntime-web, see above), CPU-pixel input, one face, the studio's crop frame for the transformation matrix. No
model weights are copied or changed: the worker converts the `face_landmarker.task` the app already ships, in memory.

## qrcode-generator 2.0.4 — MIT

`src/vendor/qrcode-generator.js` (+ `qrcode-generator.d.ts`) is `dist/qrcode.mjs` of the npm package qrcode-generator
2.0.4 (https://github.com/kazuhikoarase/qrcode-generator), vendored unmodified on 2026-10-01 (owner-approved; SHA-256 of
the original in the file header). Copyright (c) 2009 Kazuhiko Arase, MIT License (full text in the file header). Used by
`src/ui/inviteQr.ts` for the QR code on the "Invite someone" sheet. "QR Code" is a registered trademark of DENSO WAVE
INCORPORATED.

## Live2D import: format knowledge sources (no code copied)

The Live2D importer (`shared/rig2d/live2d/`) converts a user's Live2D model into VTube Pro's own `.vtp2` rig. Its
`.moc3` reader is project code (a port of `blender/live2d/moc3.py`), written with knowledge from:
- **moc3ingbird** by the OpenL2D Project Developers (https://github.com/OpenL2D/moc3ingbird): the MOC3 ImHex
  pattern / format notes, Free Development Public License 1.0-US;
- **moc3-rs** by MahouTechnologies (https://github.com/MahouTechnologies/moc3-rs): deformer maths, MIT or Apache-2.0.
No code from either project is included. No Live2D Cubism Core / SDK / Framework / Editor code is used or shipped;
"Live2D" and "Cubism" are trademarks of Live2D Inc. Details: docs/RIG2D_IMPORT_PROVENANCE.md.

## Optional external tools (not bundled)

| Tool | Used by | Licence | How it is used |
|---|---|---|---|
| FFmpeg 8.1+ with the `gfxcapture` filter (e.g. `winget install ffmpeg`, gyan.dev builds) | `server/screenFeed.ts` — Fast window feed for the react screen (Windows) | LGPL-2.1+ / GPL (depends on the build the user installs; the gyan.dev "full" build is GPL-3.0) | Found on the user's PC and run as a separate process (`ffmpeg -filter_complex gfxcapture=… -c:v libx264 … -f h264 pipe:1`); its output is read from a pipe. VTube Pro ships no FFmpeg code or binaries. Without it the feature is simply unavailable. |
| Blender add-ons in `tools/vendor/blender_addons/` (VRM MIT+GPL-3, TexTools GPL-3, Building Tools MIT, Sapling / A.N.T. / LoopTools / Archimesh / Magic UV / … GPL-2+/GPL-3+) and Instant Meshes (`tools/vendor/instant_meshes/`, BSD-3-Clause) — downloaded 2026-09-27, user-approved, from extensions.blender.org / the projects' official GitHub | Content build scripts (`blender/addons_util.py`), the user's own Blender | see `docs/BLENDER_ADDONS.md` (versions, sources, SHA-256 in `tools/vendor/blender_addons/manifest.json`) | Build-time tools only: run inside Blender / as a separate process on the developer's PC. None of their code or binaries ship with VTube Pro; only the meshes / UVs / GLBs we make with them do. |

## Local voice pack: live captions + Kokoro alert voice (downloaded on the user's demand into `.voice/`, never bundled)

Installed only when the user presses "Install" (tools/voice/voice_setup.ts: pinned versions, sha256 on every file). All run
on the user's own PC; nothing here sends audio or text anywhere. No GPL / AGPL / non-commercial component is installed.

| Component | Used for | Licence | Notes |
|---|---|---|---|
| faster-whisper 1.2.1 (SYSTRAN) | live captions | MIT | installed with `--no-deps`: its dependency **PyAV is deliberately not installed** (PyAV's wheels bundle an FFmpeg built with x264 / x265, which is GPL); the sidecar passes arrays, never files, and `tools/voice/whisper_sidecar.py` puts an empty `av` stand-in in place |
| CTranslate2 4.8.3 (OpenNMT / SYSTRAN) | inference engine of faster-whisper | MIT | |
| OpenAI Whisper weights, converted to CTranslate2 by SYSTRAN (`Systran/faster-whisper-tiny.en`, `-base.en`, `-small.en`, `-small`; pinned commits) | live captions | MIT | Hugging Face model cards say `license: mit` |
| tokenizers 0.23.3, huggingface-hub, tqdm, PyYAML | faster-whisper's imports | Apache-2.0 · Apache-2.0 · MPL-2.0 AND MIT · MIT | the sidecar sets `HF_HUB_OFFLINE=1`: nothing is fetched at run time |
| onnxruntime 1.30.0 (Microsoft), numpy, websockets 16.1.1 | the private Python runtime | MIT · BSD-3-Clause · BSD-3-Clause | |
| uv 0.12.19 (Astral) | creates the private Python 3.12 environment | MIT OR Apache-2.0 | sha256-checked download from the official GitHub release |
| NVIDIA cuBLAS + cuDNN (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) | optional: captions on an NVIDIA GPU | NVIDIA proprietary licence (redistributable libraries) | only if the user presses "use my NVIDIA graphics card"; pip downloads them from PyPI onto their machine; never bundled; if CUDA fails to load the captions run on the CPU |
| **Kokoro-82M v1.0** (hexgrad; ONNX export `onnx-community/Kokoro-82M-v1.0-ONNX`, pinned commit, int8 `model_quantized.onnx`) + 8 US-English voice packs | alert voice (read-aloud engine "Kokoro") | Apache-2.0 (weights and voices) | see the training-data attribution below |
| misaki 0.9.4 (hexgrad): only its two pronunciation dictionaries `us_gold.json` / `us_silver.json`, unpacked from the pinned wheel | Kokoro text -> phonemes (`tools/voice/kokoro_g2p.py`, our own small G2P) | Apache-2.0 | misaki's `[en]` extra pulls in **espeak-ng and phonemizer (GPL-3.0)**; they are never installed, and unknown words are spelled out instead |
| LocalAgreement stable-prefix policy (Macháček, Dabre, Bojar: "Turning Whisper into Real-Time Transcription System", 2023) | live captions (`server/captions/agreement.ts`) | idea from a paper; **no code copied** | the SimulStreaming project (ufal) is MIT-licensed, but its AlignAtt policy needs Whisper's cross-attention, which CTranslate2 does not expose |

Kokoro training data (from the model card, hexgrad/Kokoro-82M): "trained exclusively on permissive/non-copyrighted audio data
and IPA phoneme labels" (public domain; Apache / MIT licensed audio; synthetic audio from closed TTS providers). The card
names two CC BY sets used for v1.0, whose attribution is reproduced here: **Koniwa `tnc`** (<1 h, CC BY 3.0,
https://github.com/koniwa/koniwa) and **SIWIS** (<11 h, CC BY 4.0, https://datashare.ed.ac.uk/handle/10283/2353). Neither
author endorses this project.

## VTube Pro sample anime avatars (Mirelle, Kairo)
Built by `assets/builtin/<id>/build/build_anime.py` from pixiv Inc.'s classic VRoid sample models (Sendagaya Shino, Sakurada Fumiriya, HairSample_Female, HairSample_Male, Darkness Shibu; `tools/vendor/vroid`), which carry `licenseName: CC0` (commercial use + redistribution allowed) in their VRM meta. Faces, colours, garment textures and accessories were repainted / built by the VTube Pro pipeline. Original designs; no existing characters or game IP.

## Inochi2D / inox2d ? BSD-2-Clause

The Inochi importer and SimplePhysics adapter use the public INP format and the
reference equations and serialization rules in Inochi2D v0.8.7 (commit
`e2235f6f29688d4013a0eec116a37ec8af8f1fb5`) and inox2d
`d4dd9dd7f16b775042cbda44370570abf9a8cf81`. SimplePhysics was authored by
Asahi Lina (Copyright ? 2022, Inochi2D Project). No third-party puppets ship.

Sources: https://github.com/Inochi2D/inochi2d and https://github.com/Inochi2D/inox2d.
The following notices are retained for the reference-derived implementation:

```text
BSD 2-Clause License

Copyright (c) 2020, Inochi2D Project
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

```text
Copyright (c) 2022 Speykious <speykious@gmail.com> and Inochi2D Project

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.
```

## BC7 / BPTC and DDS format knowledge

`shared/rig2d/inochi/bc7.ts` is an original TypeScript decoder. Its bit layouts,
partition/anchor constants and interpolation weights follow the Khronos Data
Format specification, BPTC chapter (https://registry.khronos.org/DataFormat/specs/1.4/dataformat.1.4.html#BPTC),
and Microsoft's BC7 and DDS_HEADER / DDS_HEADER_DXT10 documentation
(https://learn.microsoft.com/en-us/windows/win32/direct3d11/bc7-format).
No third-party decoder code or binary is included. Tests pack original synthetic
blocks from these format definitions; they contain no artist assets.

## DJ sync: protocol sources (`server/music/`, `shared/musicClock.ts`, `shared/djControllers.ts`, `shared/dmxIn.ts`)

DJ sync only **receives** data from DJ gear and DJ software. Its protocol code is project code written from published
protocol knowledge, plus one MIT port:
- **go-stagelinq** by Carl Kittelberger (https://github.com/icedream/go-stagelinq), MIT: the StageLinQ wire format in
  `server/music/stagelinqProto.ts` is a TypeScript port of its message layouts. Notice:
  > MIT License — Copyright (c) 2021 Carl Kittelberger <icedream@icedream.pw>
  > Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
  > documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
  > rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
  > persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright notice
  > and this permission notice shall be included in all copies or substantial portions of the Software. THE SOFTWARE IS
  > PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  > MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
  > HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
  > ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
- **PyStageLinQ** (Jaxcie, MIT) protocol notes (the token rule). No code copied.
- **Pro DJ Link**: packet layouts from Deep Symmetry's published protocol analysis (djl-analysis / dysentery,
  crate-digger ANLZ docs), cross-checked against **prolink-connect** (Copyright (c) 2013 Evan Purkhiser, MIT). Facts
  only: no code from beat-link (EPL-2.0), crate-digger's `.ksy` files (EPL-1.0) or `rekordbox-parser` (LGPL) is used.
- **Controller maps**: MIDI numbers from Hercules' published MIDI command lists and from public mappings (Mixxx,
  community DDJ-FLX6 / Prime 4 maps): numeric facts only, no mapping code copied.
- **OS2L** (os2l.org), **Art-Net 4** and **ANSI E1.31 (sACN)**: implemented from the published specifications.
  Art-Net™ Designed by and Copyright Artistic Licence Engineering Ltd.
- Deliberately **not** used: chrisle/StageLinq and MarByteBeep/StageLinq (GPL-3.0 history), the Ableton Link SDK
  (GPLv2+ without Ableton's proprietary licence), rkbx_link (GPL-3.0; we only receive OSC from it if the user runs it).

## Optional external tools for DJ sync (not bundled)

| Tool | Used by | Licence | How it is used |
|---|---|---|---|
| Carabiner (Deep Symmetry), the Ableton Link bridge | `server/music/link.ts` | GPL-2.0-or-later (embeds Ableton Link) | The user downloads it; VTube Pro talks to it over its local text protocol on 127.0.0.1:17000 (and can start the copy the user downloaded when they press a button). No Carabiner or Link code ships with VTube Pro. |
| traktor-api-client (community QML mod for Traktor) | `server/music/traktor.ts` (off by default) | MIT | The user installs it into Traktor themselves; VTube Pro only receives its HTTP posts on localhost. |
| `@julusian/midi` (RtMidi, native) | `server/music/midi.ts` (loaded only if present) | MIT | Optional native MIDI in VTube Pro; not installed by default (the studio page's Web MIDI covers everyone). |

## DJ sync: Track library (`server/music/library/`, `server/music/trackSync.ts`, `shared/track*.ts`, `shared/audioAlign.ts`)

Everything here is project code written from published format documentation; DJ apps' files are only **read**.
- **rekordbox analysis files (ANLZ)** and the **rekordbox XML** collection: layouts from Deep Symmetry's published format
  analysis (djl-analysis "Analysis Files") and rekordbox's official XML format list. The phrase tag's fixed XOR mask is
  public format knowledge (already used by DJ sync). No crate-digger `.ksy` / generated parser (EPL), no
  `rekordbox-parser` (LGPL), no `pyrekordbox` code. rekordbox's encrypted `master.db` and OneLibrary databases are never
  opened, and no key is shipped or derived.
- **Serato tags**: payload layouts as documented by Holzhaus/serato-tags (MIT; "Copyright 2019 Jan
  Holthuis"). Its sample tag files are fetched by the tests at test time only (not shipped).
- **Engine DJ** `m.db`: SQLite opened read-only; blob layouts from the Mixxx wiki's "Engine Library Format" notes (facts
  only; no Mixxx or libdjinterop (LGPL) code). libdjinterop's schema SQL is fetched by the tests at test time only.
- **Traktor** `collection.nml`, **VirtualDJ** `database.xml`, **Mixxx** `mixxxdb.sqlite`: read from their documented /
  observable formats; Mixxx's beat-grid protobufs are decoded from the generic protobuf wire format (no Mixxx `.proto`
  file or code, GPL).
- **Audio matching** (`shared/landmarks.ts`, `shared/audioAlign.ts`): spectral-peak landmark hashing (the published
  constellation idea; Shazam's core patent US6990453 expired on 2024-01-07) and onset-envelope cross-correlation, both
  written for this project; the "accept only an unambiguous answer, two checks must agree" idea follows
  LightD31/artnet-lightshow (MIT). No fingerprint library or its code (no Chromaprint, Olaf, Panako, audfprint, Dejavu).
- Tests use rekordcrate's published demo export files (MPL-2.0 test data) fetched at test time; nothing is committed.

## Optional model for the Track library (not bundled; the user fetches it with one click)

| Model | Used by | Licence | How it is used |
|---|---|---|---|
| Beat This! `final0` (F. Foscarin, J. Schlüter, G. Widmer, ISMIR 2024), int8 ONNX build from CattyCathy/beat-this-onnx v0.0.1 (SHA-256 `58601cfb…f936`, 21 955 054 bytes) | `server/music/library/beatThis.ts` | MIT (code and weights), © 2024 Institute of Computational Perception, JKU Linz. The authors note that some training audio was copyrighted or under limited licences; the weights themselves are MIT. | Downloaded only when the user presses "Get it", checked byte-for-byte against the pinned checksum, run with ONNX Runtime Web (WASM) in VTube Pro's analysis worker. Its log-mel front end and post-processing are this project's own code. |
| ffmpeg (user-installed, optional) | `server/music/library/decode.ts` | LGPL / GPL depending on the user's build | Used only if the user already has it: decodes music files to PCM in memory at low priority. Never shipped. |

## OpenSeeFace — BSD 2-Clause (low-power face tracker; code derived, models fetched by the user)

OpenSeeFace by Emiliana (https://github.com/emilianavt/OpenSeeFace). Checked at the source on 2026-10-23: the repository
LICENSE is BSD 2-Clause, and its README ("License") says "The code and models are distributed under the BSD 2-clause license."

| What | Where | How it is used |
|---|---|---|
| Algorithm and data derived from `tracker.py` (the models' input / output layout, the landmark decode, the crop margins, the 66-point 3D reference face); everything else (pose fit, expression ratios, tracker loop) is this project's own | `src/tracking/openSeeFace/osfCore.ts` | Runs the two networks on ONNX Runtime Web (WebAssembly CPU) in a worker; no Python |
| `mnv3_detection_opt.onnx` (568 302 bytes) and `lm_model1_opt.onnx` (4 842 329 bytes), git blob ids `60bbf7a4…c3` / `07c402f6…f8186`, from commit `50c09741897010faad721a218b2bbe14ecad6251` | `%APPDATA%\VTube Pro\models\openseeface\` (VTube Pro's data folder) | **Not bundled and never downloaded by a build or a test.** Fetched only when the user presses "Get the low-power tracker", from the pinned commit, and checked against size and blob id before they are kept (`server/tracking/openSeeFace.ts`). The gaze model (`mnv3_gaze32_split_opt.onnx`) is not used. |

Caveat recorded for the owner: the README says the landmark model was trained on a 66-point version of LS3D-W, then on WFLW
(both research datasets) plus "additional custom data" that is not redistributable. The author licenses the weights under BSD-2
himself, which is the grant relied on here; unlike RTMW (no weights licence at all) this is an explicit permissive statement from
the weights' author. Owner decision 2026-10-24: the "Get the low-power tracker" button ships to every user, on their click, with no gate
(`src/ui/faceChainPanel.ts`).

```
BSD 2-Clause License

Copyright (c) 2019, Emiliana (https://twitter.com/Emiliana_vt / https://github.com/emilianavt/)

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

## Optional ML rigging pack: UniRig, SkinTokens (not bundled; offered to every user and downloaded on their click)

Catalogue and pins: `shared/rigMl.ts`. Checked 2026-10-23 at the sources. Details and what was not verified: `docs/AUTORIG_3D.md`.

| Component | Used by | Licence | Note |
|---|---|---|---|
| SkinTokens / TokenRig (VAST AI Research, Tsinghua), code at commit `273b691d`, weights `VAST-AI/SkinTokens` revision `79736cad` | `tools/gpu/rigml_setup.ts`, `tools/gpu/rigml_worker.py` (separate process, own Python environment) | MIT (code and weights) | training data: ArticulationXL 2.0, VRoid Hub, ModelsResource |
| UniRig (VAST AI Research, Tsinghua), code at commit `6793c664`, weights `VAST-AI/UniRig` revision `36842e2b` (articulation-xl skeleton + skin checkpoints only) | same | MIT (code and weights) | note: its model config reads the `facebook/opt-350m` settings file (config only, no weights), which is under Meta's OPT licence; the pack fetches that small file itself on the user's PC and the install note says so. Training data Articulation-XL2.0 (CC-BY-4.0, Objaverse assets with mixed licences) |
| Michelangelo shape encoder, vendored inside both repositories | inside the pack only | GPL-3.0 upstream (UniRig ships the GPL text in `src/model/michelangelo`) | never bundled, never linked into VTube Pro; the first-use notice names it |
| Qwen3-0.6B config + tokenizer files (not the weights) | SkinTokens, at the pinned revision `c1899de2` | Apache-2.0 | sha256 per file in `shared/rigMl.ts` |
| `bpy` (Blender as a Python module), flash-attn, PyTorch | the pack's own environment | GPL / BSD / BSD | installed on demand into `.gpu/rigml/<model>/venv`, removed with the pack |

Make-It-Animatable is not used: it is trained on Mixamo characters.

## CC0 clips: Mesh2Motion (not bundled; the user fetches a pack)

`Mesh2Motion/mesh2motion-assets` (commit `c5b0b6c8`): LICENSE CC0-1.0; the README states code under MIT and "the art assets (3d models, rigs,
animations) are all licensed under CC0". The loader (`src/avatar/clips.ts`) accepts only packs whose licence line is CC0 / public domain /
self-made and refuses Mixamo files. Not used from that repository: `3d-models/CC-SA/` (share-alike) and `motion-capture/` (capture source not
stated). The two starter clips in `assets/clips/` are made by `tools/make_starter_clips.py` for this project and released as CC0.
