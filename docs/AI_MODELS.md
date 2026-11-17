# AI model manifest

Weights used by the AI art pipeline (`tools/ai_texture/`, see `docs/AI_ART_PIPELINE.md`). All weights are
`.safetensors` (no pickles). Local install: `<ComfyUI folder>\models\<folder>`.

**Public-product rule:** the app's defaults must use models whose licence allows commercial use of outputs
(marked **commercial OK**). Models marked **restricted** are fine for the user's own local use but must not be
the shipped default without a licence review.

| Model | Folder | Source URL | Licence | Commercial | Size (bytes) | SHA-256 | Added |
|---|---|---|---|---|---|---|---|
| Animagine XL 4.0 (opt) — default anime painter | checkpoints | https://huggingface.co/cagliostrolab/animagine-xl-4.0/blob/main/animagine-xl-4.0-opt.safetensors | CreativeML Open RAIL++-M | **commercial OK** (use-based restrictions of RAIL apply) | 6938350040 | `6327eca98bfb6538dd7a4edce22484a1bbc57a8cff6b11d075d40da1afb847ac` | 2026-09-25 (this pipeline) |
| NoobAI-XL v1.1 — alt anime painter (stronger character knowledge) | checkpoints | https://huggingface.co/Laxhar/noobai-XL-1.1/blob/main/NoobAI-XL-v1.1.safetensors | fair-ai-public-license-1.0-sd (+ NoobAI terms) | **restricted** — outputs usable, but derivatives/hosted use carry share-alike + notice terms; review before shipping | 7105349958 | `6681e8e4b134c81f16533acedb0d406d7e5e366e1624b4105178c64d00b05d51` | 2026-09-25 (this pipeline) |
| IP-Adapter Plus SDXL (ViT-H) — reference/style transfer | ipadapter | https://huggingface.co/h94/IP-Adapter/blob/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors | Apache-2.0 | **commercial OK** | 847517512 | `3f5062b8400c94b7159665b21ba5c62acdcd7682262743d7f2aefedef00e6581` | 2026-09-25 (this pipeline) |
| IP-Adapter Plus-Face SDXL (ViT-H) | ipadapter | https://huggingface.co/h94/IP-Adapter/blob/main/sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors | Apache-2.0 | **commercial OK** | 847517512 | `677ad8860204f7d0bfba12d29e6c31ded9beefdf3e4bbd102518357d31a292c1` | pre-existing |
| ControlNet Union SDXL 1.0 ProMax (xinsir) — depth / lineart / normal / tile / repaint | controlnet | https://huggingface.co/xinsir/controlnet-union-sdxl-1.0 | Apache-2.0 | **commercial OK** | 2513342408 | `9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc` | pre-existing |
| **Qwen-Image-Edit-2509 fp8** — WINNER of the 2D bake-off (reference-conditioned on-model views; geometry-aligned painting from a normal/depth/lineart render) | diffusion_models | https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI (split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors) | Apache-2.0 | **commercial OK** | 20430698424 | `318568f61951ab9da21100c7b896e3c1da67f0d2efad6421545e022cfaa2b2b4` | 2026-09-25 |
| Qwen-Image-Edit-2509 Lightning 8-step LoRA | loras | https://huggingface.co/lightx2v/Qwen-Image-Lightning (Qwen-Image-Edit-2509/…-8steps-V1.0-bf16) | Apache-2.0 | **commercial OK** | 849608296 | `b5c48ba90d22294cc4e20ea4a347496e2136295ad438ff79ad4fe841f28d7f72` | 2026-09-25 |
| Qwen-Edit-2509 Multiple-angles LoRA (camera-rotation edits; tested, not better) | loras | https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI (split_files/loras) | Apache-2.0 (repo) | **commercial OK** (check upstream author terms) | 236117032 | `e0cea9508025a39e41f50da0e7d10fbd9db182d057c745136a42ef8829914c8f` | 2026-09-25 |
| Qwen-Image fp8 (text-to-image: room tiles, sky panoramas) | unet | https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI | Apache-2.0 | **commercial OK** | 20430635136 | `98763a127701eb6fb59096f7742cb3aa7d64ed510b9f4e882d8351f8176e3ce3` | pre-existing |
| Qwen-Image Lightning 8-step V2 LoRA | loras | https://huggingface.co/lightx2v/Qwen-Image-Lightning | Apache-2.0 | **commercial OK** | 849608296 | `5bdbf69912280a9944be9b3aacd8db0cfbb429fcbd66c994d7b38b5a37e357ee` | 2026-09-25 |
| Qwen2.5-VL 7B fp8 (Qwen text encoder) / Qwen-Image VAE | text_encoders / vae | https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI | Apache-2.0 | **commercial OK** | 9384670680 / 253806246 | `cb5636d8…c0b4` / `a70580f0…1f` | pre-existing |
| Illustrious-XL v2.0 (SDXL anime base; LoRA training base) | checkpoints | https://huggingface.co/OnomaAIResearch/Illustrious-XL-v2.0 | CreativeML OpenRAIL-M (HF card) | **commercial OK** (RAIL use restrictions) | 6938040674 | `c2a1a3eaa13d4c107dc7e00c3fe830cab427aa026362740ea094745b3422a331` | 2026-09-25 |
| WAI-illustrious-SDXL v17 | checkpoints | https://civitai.com/models/827184 (version 2883731) | Illustrious licence + Civitai terms: allowCommercialUse = Image, RentCivit | **restricted** (images OK, no hosting/selling the model) | 6938040682 | `f116b0c78ff441467b0cdc8f1936e1ed18ea31e9997c7b132b1b8db533f0bd04` | 2026-09-25 |
| NoobAI-XL v-pred 1.0 | checkpoints | https://huggingface.co/Laxhar/noobai-XL-Vpred-1.0 | fair-ai-public-license-1.0-sd | **restricted** | 7105350110 | `ea349eeae87ca8d25ba902c93810f7ca83e5c82f920edf12f273af004ae02819` | 2026-09-25 |
| SDXL base 1.0 | checkpoints | https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0 | CreativeML Open RAIL++-M | **commercial OK** | 6938078334 | `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b` | 2026-09-25 |
| DINOv2-small (scoring: identity / perceptual similarity) | ComfyUI/models/dinov2/dinov2-small | https://huggingface.co/facebook/dinov2-small | Apache-2.0 | **commercial OK** | 88249960 | `ae1e99fcefd534ed978cdeb8326f08030c96e28b7a81ffcbc98a857c84d14be1` | 2026-09-25 |
| aosabi_illu (Aosabi character LoRA, trained here on the user's own reference drawings; trigger `aosabi`) | loras | local (tools/ai_texture/train_lora.py, ComfyUI native trainer) | user's own character; base Illustrious-XL v2 (OpenRAIL-M) | own use | — | — | 2026-09-25 |
| CLIP-ViT-H-14 laion2B (IP-Adapter image encoder) | clip_vision | https://huggingface.co/laion/CLIP-ViT-H-14-laion2B-s32B-b79K | MIT | **commercial OK** | 2528373448 | `6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030` | pre-existing |

Pre-existing on this PC but **not used** by the pipeline: Flux.2 dev fp8 (FLUX.2 [dev] non-commercial licence),
Qwen-Image fp8 (Apache-2.0 — a good commercial-OK upgrade path for a future higher-end painter; needs ~20 GB
VRAM, too heavy next to live tracking), Wan 2.2, LTX 2.3, Hunyuan3D 2.1 (Tencent Hunyuan community licence —
**restricted**: excludes EU/UK/South Korea; never shipped, only the user's own Character 3D download, RESOURCES.md section 7).

Custom nodes used (already installed, no new nodes added): `comfyui_ipadapter_plus` (cubiq, GPL-3.0),
core ComfyUI nodes (`SetUnionControlNetType`, `DifferentialDiffusion`, `ControlNetApplyAdvanced`,
`TextEncodeQwenImageEditPlus`, `TrainLoraNode` / `SaveLoRA` for LoRA training, …). Python packages: `xatlas`
(MIT, pip) for unique UV layouts in `tools/ai_texture/uvunique.py`. Civitai model **WAI-Mature-illustrious** needs a
logged-in download (not fetched).

Note: the CineForge inventory listed 31 checkpoints / 394 LoRAs, but on 2026-09-25 the ComfyUI `checkpoints/`
and `loras/` folders were empty (the inventory is stale), so the two SDXL checkpoints above were downloaded.

## Image-to-3D / multi-view models (reference -> avatar geometry, `docs/AI_ART_PIPELINE.md` "Reference -> avatar")

Run through ComfyUI's **native** Hunyuan3D nodes (no custom nodes; the Hunyuan3D licence is restricted, see the table and RESOURCES.md section 7) or a standalone venv layered on ComfyUI's torch
(`C:\Users\<you>\ai3d\venv_tsg`, a `.pth` points at ComfyUI's site-packages; only `jaxtyping`, `typeguard`,
`pymeshlab`, `peft` were pip-installed into it). GPU jobs only while `tools/live_ok.py` reports IDLE.

| Model | Folder | Source URL | Licence | Commercial | Size (bytes) | SHA-256 | Added |
|---|---|---|---|---|---|---|---|
| Hunyuan3D-2.1 shape DiT (Comfy-Org repackage, single image -> shape) | checkpoints/hunyuan_3d_v2.1.safetensors | https://huggingface.co/Comfy-Org/hunyuan3D_2.1_repackaged | Tencent Hunyuan 3D 2.1 Community Licence | **restricted**: territory excludes the EU, UK and South Korea; >1 M MAU needs a Tencent licence; fine for the user's local use (the Character 3D recipe, their own download after their Yes), NOT a shipped default | 7365943290 | `5f21e98a6cb99b13b5e224abaee33929570fff7af2b6a0060001559a04ba9d72` | 2026-09-25 |
| Hunyuan3D-2mv shape DiT fp16 (front/left/back/right views -> shape) | checkpoints/hunyuan3d-dit-v2-mv_fp16.safetensors | https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged (split_files) = tencent/Hunyuan3D-2mv | Tencent Hunyuan 3D 2.0 Community Licence | **restricted** (same territory / MAU terms) | 4928151562 | `d36f5881bcdc56726b73e517cd444c13c60732431622da7268145355c8d38e9c` | 2026-09-25 |
| TripoSG 1.5B (image -> shape; VAST-AI) - the commercial-OK alternative | models/triposg (diffusers layout: transformer, vae, image_encoder_dinov2) | https://huggingface.co/VAST-AI/TripoSG + code https://github.com/VAST-AI-Research/TripoSG (commit fc5c409) | MIT | **commercial OK** | 5758280104 + 970685468 + 1217522888 | transformer `9192b5923f7b605b394192809aa2ceb73bf0f4009674d8e3b999b45bb97d4bf2`, vae `a2e667c24927a5a35e5f19fcb4c75890e9399aa966b6db8131d7df733a750c8b`, dinov2 `399fba97a95f22c36834418bc69373364a99af3a1153da1c0fb31db567c92e23` | 2026-09-25 |

Evaluated but **not** downloaded / not usable here:
* **TRELLIS.2-4B** (Microsoft, MIT): needs `facebook/dinov3-vitl16-pretrain-lvd1689m`, a *gated* Hugging Face repo
  (licence acceptance + token by the user) and `briaai/RMBG-2.0` (gated, non-commercial; replaceable by our own
  mask). It also needs custom CUDA extensions (o-voxel, flexgemm, cumesh) built for sm_120. Revisit if the user
  accepts the DINOv3 licence - it is the strongest MIT-licensed option for the public product.
* **Hunyuan3D-2.1 Paint** (PBR texturing): official weights are `.bin` pickles from Tencent's own repo (allowed
  source) but need the custom rasteriser extension; not installed. Our texture comes from the reference drawings
  (cel palette + baked label texture) instead.
* **MV-Adapter** (Apache-2.0, `huanngzh/mv-adapter`), **CharacterGen / StdGEN** (anime A-pose / decomposed
  characters, trained on VRoid-style data), **Era3D, SV3D, Zero123++, PSHuman, InstantMesh, LGM, SPAR3D, TripoSR**:
  not downloaded. The rig's own rest-pose skeleton + depth, rendered from the base avatar and fed to SDXL
  ControlNet-union (openpose + depth) with IP-Adapter, already gives consistent on-model A-pose front/side/back
  views for Hunyuan3D-2mv; MV-Adapter / Hunyuan3D-Paint remain the candidates for joint multi-view texturing.

## Voice / lip-sync models (runtime, studio)

| Model | File | Source | Licence | Commercial | Notes |
|---|---|---|---|---|---|
| Neural visemes (tiny streaming phone recogniser, conv + GRU, own work) | `public/vendor/voice/nv_visemes.json` (JSON, float32 base64; not a pickle) | trained here, `tools/nv/` (LibriSpeech train-clean-100 + MFA alignments) | weights: this project's licence; data CC BY 4.0 (attribution in THIRD_PARTY_NOTICES.md) | **commercial OK** | experimental, off by default (docs/VOICE.md) |
| Silero VAD v5 | `public/vendor/voice/silero_vad_v5.onnx` | github.com/snakers4/silero-vad | MIT | **commercial OK** | voice gate |
| wav2arkit_cpu | `tools/vendor/` | see THIRD_PARTY_NOTICES.md | Apache-2.0 | evaluation only | not loaded at runtime |
| Rhubarb Lip Sync 1.14.0 (offline lip sync of the GM's voice lines; HeadAudio was evaluated only, not shipped) | `tools/vendor/rhubarb/` (Windows zip) | see THIRD_PARTY_NOTICES.md | MIT (+ BSD / Boost deps) | **commercial OK** (keep its LICENSE.md) | run by `server/lipsync/rhubarb.ts` as a separate headless process, only when installed |
| NVIDIA Audio2Face-3D v2.3.1 Claire (GPU lip sync, optional) | `tools/vendor/audio2face3d_claire/` | huggingface.co/nvidia/Audio2Face-3D-v2.3.1-Claire | NVIDIA Open Model License | **commercial OK** (keep the notice) | runs in `tools/gpu/a2f_sidecar.py` on the user's GPU, off by default (docs/GPU_TRACKING.md) |

## GPU tracking sidecars (optional, RTX 50-series; docs/GPU_TRACKING.md)

| Model | File | Source | Licence | Commercial | Notes |
|---|---|---|---|---|---|
| RTMW-x whole-body (rtmw-dw-x-l_simcc-cocktail14_270e-384x288, ONNX) | `%LOCALAPPDATA%\VTubePro\gpu\models\rtmw\end2end.onnx` (downloaded by `tools/gpu/setup_gpu.py --rtmw`, sha256-checked) | download.openmmlab.com (OpenMMLab mmpose RTMW release) | Code Apache-2.0 (mmpose); the weights have NO licence of their own and were trained on "cocktail14", which includes InterHand2.6M (CC BY-NC 4.0) and Human-Art (non-commercial) | offered to every user, downloaded on their click (owner decision 2026-10-24); the app states the weights note (`shared/gpuLicence.ts`) and does not block. The Apache-2.0 alternative in the app is MediaPipe Pose + Hand Landmarker | 133 keypoints incl. hands |
| NVIDIA Maxine AR SDK 0.8.7 (Face Expressions) | installed by the user (`nvidia_ar_sdk_installer_v0.8.7_blackwell.exe`) | nvidia.com/broadcast-sdk-resources | NVIDIA Maxine EULA | not redistributed by VTube Pro | called through ctypes in `tools/gpu/maxine_core.py` |


## Face capture (runtime, studio)

| Model | File | Source | Licence | Commercial | Notes |
|---|---|---|---|---|---|
| MediaPipe Face Landmarker (face mesh V2 + 52 blendshapes) | `public/mediapipe/face_landmarker.task` | google-ai-edge/mediapipe | Apache-2.0 | **commercial OK** | also run on camera 2 in the two-camera mode (docs/MULTICAM.md); no new weights were added for it |

Evaluated for face capture on 2026-09-25 and **not adopted** (licence or benefit; full notes in docs/MULTICAM.md →
"State of the art"): InsightFace / SCRFD (models non-commercial), 3DDFA_V2 / V3 and SynergyNet (300W-LP / Basel Face
Model data restrictions), DECA / EMOCA / SMIRK / SPECTRE and other FLAME-family trackers (non-commercial FLAME / training
data), L2CS-Net / ETH-XGaze / UniGaze gaze models (non-commercial training data), Microsoft FaceSynthetics (non-commercial),
Meta Sapiens (CC BY-NC / restrictive). Candidate for an optional RTX-only native sidecar: NVIDIA Maxine AR SDK (face
expressions / gaze; NVIDIA SDK licence — needs legal review before shipping).
