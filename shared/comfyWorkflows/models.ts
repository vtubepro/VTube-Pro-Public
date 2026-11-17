// Every model file the shareable VTube Pro ComfyUI workflows use: official Hugging Face repo, the exact revision (commit)
// we checked, the SHA-256 and size that Hugging Face publishes for it (LFS oid), the ComfyUI folder it goes in and its
// licence. Pure data, no imports (studio, helper, website and tests all read it).
//
// Rules (owner, 2026-10-01): only weights whose licence allows commercial use by default; official sources only
// (the model author's repo, or the Comfy-Org repackage of the same weights); never gated repos (the helper never signs
// in anywhere). Downloads use the pinned revision, so the SHA-256 below stays valid even if the repo changes later.
// The one exception is a model with a `restricted` notice (Hunyuan3D, for the Character 3D recipe): it is never bundled
// and never a default; the user's own Yes downloads it, and the consent list shows the notice (who may not use it) first.
//
// HOW TO UPDATE: run `node tools/comfy/pin_models.mjs` (prints revision, size and SHA-256 from the Hugging Face API for
// every entry), paste the changes, bump `checked`, then `npx tsx tools/comfy/build_workflows.ts` and
// `npx tsx tools/comfy_workflows_unit.ts`.

export type ComfyFolder =
  | 'checkpoints' | 'diffusion_models' | 'text_encoders' | 'vae' | 'loras' | 'controlnet' | 'ipadapter' | 'clip_vision'
  | 'upscale_models' | 'background_removal';

export interface ModelFile {
  id: string;
  name: string;
  /** File name inside the ComfyUI folder (what the workflow's loader node names). */
  file: string;
  folder: ComfyFolder;
  bytes: number;
  /** Lower-case hex SHA-256 of the whole file (the Hugging Face LFS oid). */
  sha256: string;
  repo: string;
  /** Repo commit the URL is pinned to. */
  revision: string;
  /** Path inside the repo. */
  path: string;
  licence: string;
  licenceUrl: string;
  /** Where the weights come from originally (when `repo` is a repackage). */
  upstream: string;
  checked: string;
  /** Set for a weight whose licence limits who may use it (not "commercial use OK by default"). The helper shows `text`
   *  above the Yes button and the unit test insists on it; `excluded` names the places the licence does not cover. */
  restricted?: { text: string; excluded: string[] };
}

/** The download URL, pinned to the checked revision. */
export const modelUrl = (m: Pick<ModelFile, 'repo' | 'revision' | 'path'>) =>
  `https://huggingface.co/${m.repo}/resolve/${m.revision}/${m.path.split('/').map(encodeURIComponent).join('/')}`;
/** The human page for the repo (what we link in guides). */
export const modelPage = (m: Pick<ModelFile, 'repo'>) => `https://huggingface.co/${m.repo}`;

export const MODELS_CHECKED = '2026-10-16';

/** The places the Tencent Hunyuan 3D Community Licence does not cover. Every Hunyuan weight below carries it as `restricted.excluded`;
 *  the notice, the AI house rules and the docs all say these same three (tools/hunyuan_policy_unit.ts holds them together). */
export const HUNYUAN_EXCLUDED = ['EU', 'UK', 'South Korea'];
/** The same list in a sentence. */
export const HUNYUAN_PLACES = 'the EU, the UK or South Korea';

/** Shown above the Yes button for the Hunyuan3D weights (Character 3D). Plain words; the licence itself is linked. */
export const HUNYUAN_NOTICE = `Licence: Tencent Hunyuan 3D Community. It does not cover ${HUNYUAN_PLACES}. If you live there, don't download it. A company with over 1 million monthly users needs Tencent's OK first.`;

/** The id of the one recipe that uses Hunyuan3D. */
export const HUNYUAN_RECIPE = 'character-3d';

// ---- the Hunyuan3D policy (DIRECTOR DECISION 2026-10-16), ONE copy for every AI-facing text
// VTube Pro never bundles Hunyuan3D weights. A person may install the Character 3D recipe into THEIR OWN ComfyUI with "Set it up for me":
// their download, the licence notice shown first. An AI may suggest or use it for props, creatures, mascots and non-human characters;
// humans still come from a proper base (the rule "humans from a proper base, never Tripo / Meshy or primitives" covers Hunyuan3D too).
// Who reads these: server/aiKnowledge.ts (house rules, MCP instructions), shared/creatorSkill.ts (the instruction pack), shared/aiAddons.ts,
// server/comfyWorkflowTools.ts, shared/localAi/*. The docs say the same in their own words; tools/hunyuan_policy_unit.ts reads all of them
// against this catalogue and fails when one says something else (a flat "no Hunyuan3D" included).
/** What an AI may use Hunyuan3D for. */
export const HUNYUAN_AI_FOR = 'props, creatures, mascots and non-human characters';
/** The full rule (house rules, the instruction pack's licences). */
export const HUNYUAN_AI_RULE = `Hunyuan3D is never bundled. It comes only through VTube Pro's Character 3D recipe (\`${HUNYUAN_RECIPE}\`, set up with install_comfy_workflow) in the USER's own ComfyUI, as the user's own download after the user's own Yes, with the Tencent Hunyuan 3D Community Licence shown first: it does not cover ${HUNYUAN_PLACES}, so never offer it to someone who lives there. You may suggest or use it for ${HUNYUAN_AI_FOR}. Humans and anime humans never come from it: they start from a proper base (a VRoid CC0 sample or blender/face_kit).`;
/** The short form (the one-paragraph MCP instructions, tool descriptions). */
export const HUNYUAN_AI_RULE_SHORT = `Hunyuan3D only through the Character 3D recipe (${HUNYUAN_RECIPE}) in the user's own ComfyUI (their download after their Yes, never bundled, not for ${HUNYUAN_PLACES}), for ${HUNYUAN_AI_FOR}, never for humans`;

export const MODEL_FILES: ModelFile[] = [
  { id: 'sdxl-base', name: 'SDXL base 1.0', file: 'sd_xl_base_1.0.safetensors', folder: 'checkpoints', bytes: 6938078334,
    sha256: '31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b',
    repo: 'stabilityai/stable-diffusion-xl-base-1.0', revision: '462165984030d82259a11f4367a4eed129e94a7b', path: 'sd_xl_base_1.0.safetensors',
    licence: 'CreativeML Open RAIL++-M', licenceUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md', upstream: 'stabilityai/stable-diffusion-xl-base-1.0', checked: '2026-10-01' },
  { id: 'animagine-xl-4', name: 'Animagine XL 4.0 (opt)', file: 'animagine-xl-4.0-opt.safetensors', folder: 'checkpoints', bytes: 6938350040,
    sha256: '6327eca98bfb6538dd7a4edce22484a1bbc57a8cff6b11d075d40da1afb847ac',
    repo: 'cagliostrolab/animagine-xl-4.0', revision: '2b7c1b397761bf5bd3cc42e5b39ec99314a75a96', path: 'animagine-xl-4.0-opt.safetensors',
    licence: 'CreativeML Open RAIL++-M', licenceUrl: 'https://huggingface.co/cagliostrolab/animagine-xl-4.0', upstream: 'cagliostrolab/animagine-xl-4.0', checked: '2026-10-01' },
  { id: 'controlnet-union-sdxl', name: 'ControlNet Union SDXL ProMax (xinsir)', file: 'controlnet-union-sdxl-promax.safetensors', folder: 'controlnet', bytes: 2513342408,
    sha256: '9fae2e50cb431bfcbe05822b59ec2228df545ef27f711dea8949e9f4ed9f7cdc',
    repo: 'xinsir/controlnet-union-sdxl-1.0', revision: '801a4a3fa3d4c936f4feea95b98607bc6726f80c', path: 'diffusion_pytorch_model_promax.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0', upstream: 'xinsir/controlnet-union-sdxl-1.0', checked: '2026-10-01' },
  { id: 'ipadapter-plus-sdxl', name: 'IP-Adapter Plus SDXL (ViT-H)', file: 'ip-adapter-plus_sdxl_vit-h.safetensors', folder: 'ipadapter', bytes: 847517512,
    sha256: '3f5062b8400c94b7159665b21ba5c62acdcd7682262743d7f2aefedef00e6581',
    repo: 'h94/IP-Adapter', revision: '018e402774aeeddd60609b4ecdb7e298259dc729', path: 'sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/h94/IP-Adapter', upstream: 'h94/IP-Adapter', checked: '2026-10-01' },
  { id: 'clip-vision-vit-h', name: 'CLIP ViT-H-14 image encoder (for IP-Adapter)', file: 'CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors', folder: 'clip_vision', bytes: 2528373448,
    sha256: '6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030',
    repo: 'h94/IP-Adapter', revision: '018e402774aeeddd60609b4ecdb7e298259dc729', path: 'models/image_encoder/model.safetensors',
    licence: 'Apache-2.0 (h94/IP-Adapter repo; the OpenCLIP ViT-H-14 weights are MIT)', licenceUrl: 'https://huggingface.co/h94/IP-Adapter', upstream: 'laion/CLIP-ViT-H-14-laion2B-s32B-b79K', checked: '2026-10-01' },
  { id: 'realesrgan-x4', name: 'Real-ESRGAN x4plus (upscaler)', file: 'RealESRGAN_x4plus.safetensors', folder: 'upscale_models', bytes: 66857836,
    sha256: '37f9a931c215f040aa6d50f711f2cb115f713c46df1d0d6469a8bd7bfe9a60bb',
    repo: 'Comfy-Org/Real-ESRGAN_repackaged', revision: '5fd49b7b278836f48af63ecd314d0f98ab336105', path: 'RealESRGAN_x4plus.safetensors',
    licence: 'BSD-3-Clause', licenceUrl: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE', upstream: 'xinntao/Real-ESRGAN', checked: '2026-10-01' },
  { id: 'birefnet', name: 'BiRefNet (background remover)', file: 'birefnet.safetensors', folder: 'background_removal', bytes: 444473596,
    sha256: '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154',
    repo: 'Comfy-Org/BiRefNet', revision: '25511f8787e51912e1480706b4e47b8f467fbf72', path: 'background_removal/birefnet.safetensors',
    licence: 'MIT', licenceUrl: 'https://huggingface.co/ZhengPeng7/BiRefNet', upstream: 'ZhengPeng7/BiRefNet (same SHA-256 as its model.safetensors)', checked: '2026-10-01' },
  { id: 'z-image-turbo', name: 'Z-Image-Turbo (bf16)', file: 'z_image_turbo_bf16.safetensors', folder: 'diffusion_models', bytes: 12309866400,
    sha256: '2407613050b809ffdff18a4ac99af83ea6b95443ecebdf80e064a79c825574a6',
    repo: 'Comfy-Org/z_image_turbo', revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', path: 'split_files/diffusion_models/z_image_turbo_bf16.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', upstream: 'Tongyi-MAI/Z-Image-Turbo', checked: '2026-10-01' },
  { id: 'qwen3-4b-te', name: 'Qwen3 4B text encoder (for Z-Image-Turbo and FLUX.2 klein 4B)', file: 'qwen_3_4b.safetensors', folder: 'text_encoders', bytes: 8044982048,
    sha256: '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
    repo: 'Comfy-Org/z_image_turbo', revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', path: 'split_files/text_encoders/qwen_3_4b.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', upstream: 'Qwen/Qwen3-4B (same SHA-256 in Comfy-Org/flux2-klein)', checked: '2026-10-01' },
  { id: 'z-image-vae', name: 'Z-Image VAE (ae)', file: 'ae.safetensors', folder: 'vae', bytes: 335304388,
    sha256: 'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
    repo: 'Comfy-Org/z_image_turbo', revision: '6fc90a3b1b653e935a0d175e260736de25b84df5', path: 'split_files/vae/ae.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Tongyi-MAI/Z-Image-Turbo', upstream: 'Tongyi-MAI/Z-Image-Turbo', checked: '2026-10-01' },
  { id: 'flux2-klein-4b', name: 'FLUX.2 [klein] 4B (distilled)', file: 'flux-2-klein-4b.safetensors', folder: 'diffusion_models', bytes: 7751105712,
    sha256: 'ec3d4e733a771f61c052fb4856c48b336c55eaf2c65487c2a1faeb9bbda7a343',
    repo: 'Comfy-Org/flux2-klein', revision: '5f526678002e43af5551dadb73ce2e8c91b43afe', path: 'split_files/diffusion_models/flux-2-klein-4b.safetensors',
    licence: 'Apache-2.0 (the 4B only; FLUX.2 klein 9B is non-commercial)', licenceUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B', upstream: 'black-forest-labs/FLUX.2-klein-4B (same SHA-256)', checked: '2026-10-01' },
  { id: 'flux2-vae', name: 'FLUX.2 VAE', file: 'flux2-vae.safetensors', folder: 'vae', bytes: 336211292,
    sha256: '868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3',
    repo: 'Comfy-Org/flux2-klein', revision: '5f526678002e43af5551dadb73ce2e8c91b43afe', path: 'split_files/vae/flux2-vae.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Comfy-Org/flux2-klein', upstream: 'black-forest-labs/FLUX.2-klein-4B', checked: '2026-10-01' },
  { id: 'qwen-image-2512', name: 'Qwen-Image-2512 (fp8)', file: 'qwen_image_2512_fp8_e4m3fn.safetensors', folder: 'diffusion_models', bytes: 20430679144,
    sha256: '5dc80554d5d83390046a2f4a94ece06afb7700bf7b0aaf8bde9769793875876b',
    repo: 'Comfy-Org/Qwen-Image_ComfyUI', revision: '1f12b17be14c89b026c51a91d67c32f84bb047bc', path: 'split_files/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image-2512', upstream: 'Qwen/Qwen-Image-2512', checked: '2026-10-01' },
  { id: 'qwen25-vl-7b-te', name: 'Qwen2.5-VL 7B text encoder (fp8)', file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', folder: 'text_encoders', bytes: 9384670680,
    sha256: 'cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4',
    repo: 'Comfy-Org/Qwen-Image_ComfyUI', revision: '1f12b17be14c89b026c51a91d67c32f84bb047bc', path: 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI', upstream: 'Qwen/Qwen2.5-VL-7B-Instruct', checked: '2026-10-01' },
  { id: 'qwen-image-vae', name: 'Qwen-Image VAE', file: 'qwen_image_vae.safetensors', folder: 'vae', bytes: 253806246,
    sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f',
    repo: 'Comfy-Org/Qwen-Image_ComfyUI', revision: '1f12b17be14c89b026c51a91d67c32f84bb047bc', path: 'split_files/vae/qwen_image_vae.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image-2512', upstream: 'Qwen/Qwen-Image', checked: '2026-10-01' },
  { id: 'qwen-image-2512-lightning', name: 'Qwen-Image-2512 Lightning 4-step LoRA', file: 'Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors', folder: 'loras', bytes: 849608296,
    sha256: 'de0d236e54ecf2c43b32447d13478c6eae0d361b1fed48c69675b084fa240d87',
    repo: 'lightx2v/Qwen-Image-2512-Lightning', revision: 'a52649c9d0f6e1a248bff13f0df33bb8a2abdb52', path: 'Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning', upstream: 'lightx2v/Qwen-Image-2512-Lightning', checked: '2026-10-01' },
  { id: 'qwen-image-edit-2511', name: 'Qwen-Image-Edit-2511 (fp8 mixed)', file: 'qwen_image_edit_2511_fp8mixed.safetensors', folder: 'diffusion_models', bytes: 20533762817,
    sha256: 'c9fdc158e46d3b61ef75f21ae866ca2fe808bf4a53643120d1c1e87c19280a4e',
    repo: 'Comfy-Org/Qwen-Image-Edit_ComfyUI', revision: 'f68ace85e60b4a02a323e394253731947657b7d2', path: 'split_files/diffusion_models/qwen_image_edit_2511_fp8mixed.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/Qwen/Qwen-Image-Edit-2511', upstream: 'Qwen/Qwen-Image-Edit-2511', checked: '2026-10-01' },
  { id: 'qwen-image-edit-2511-lightning', name: 'Qwen-Image-Edit-2511 Lightning 4-step LoRA', file: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', folder: 'loras', bytes: 849608296,
    sha256: '22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f',
    repo: 'lightx2v/Qwen-Image-Edit-2511-Lightning', revision: 'd74eba145674fd7e31b949324e148e21e7118abd', path: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors',
    licence: 'Apache-2.0', licenceUrl: 'https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning', upstream: 'lightx2v/Qwen-Image-Edit-2511-Lightning', checked: '2026-10-01' },
  { id: 'hunyuan3d-2', name: 'Hunyuan3D 2.0 shape model (fp16)', file: 'hunyuan3d-dit-v2_fp16.safetensors', folder: 'checkpoints', bytes: 4928151562,
    sha256: '360bc281fc956d4acac0c3d36d5ec0ebf8cdddbf4b8892e894d12419388d479b',
    repo: 'Comfy-Org/hunyuan3D_2.0_repackaged', revision: '6da110fc4bbaa23cc4fe7d20129c54c2aac28f80', path: 'split_files/hunyuan3d-dit-v2_fp16.safetensors',
    licence: 'Tencent Hunyuan 3D 2.0 Community (not for use in the EU, UK or South Korea)', licenceUrl: 'https://huggingface.co/Comfy-Org/hunyuan3D_2.0_repackaged/blob/main/LICENSE', upstream: 'tencent/Hunyuan3D-2 (Comfy-Org repackage of the same weights)', checked: '2026-10-16',
    restricted: { text: HUNYUAN_NOTICE, excluded: [...HUNYUAN_EXCLUDED] } },
  { id: 'hunyuan3d-21', name: 'Hunyuan3D 2.1 shape model', file: 'hunyuan_3d_v2.1.safetensors', folder: 'checkpoints', bytes: 7365943290,
    sha256: '5f21e98a6cb99b13b5e224abaee33929570fff7af2b6a0060001559a04ba9d72',
    repo: 'Comfy-Org/hunyuan3D_2.1_repackaged', revision: '606def5076d38b387b005caf93b5336c56ca99f9', path: 'hunyuan_3d_v2.1.safetensors',
    licence: 'Tencent Hunyuan 3D 2.1 Community (not for use in the EU, UK or South Korea)', licenceUrl: 'https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE', upstream: 'tencent/Hunyuan3D-2.1 (Comfy-Org repackage of the same weights)', checked: '2026-10-16',
    restricted: { text: HUNYUAN_NOTICE, excluded: [...HUNYUAN_EXCLUDED] } },
];

export const modelById = (id: string) => MODEL_FILES.find((m) => m.id === id);
