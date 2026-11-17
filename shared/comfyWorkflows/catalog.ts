// The shareable VTube Pro ComfyUI workflows: the 10 jobs from shared/localAi/workflows.ts (same ids), each built as a
// real ComfyUI graph for three graphics-card sizes. Pure data + builders (no node:, no DOM): the helper builds the
// files in memory for installs, tools/comfy/build_workflows.ts writes them to public/comfy-workflows/ for sharing,
// and the unit test checks both agree.
//
// Tiers (by graphics-card memory; ComfyUI moves parts to system RAM when it must, so "min" works but is slower):
//   small  = 8 GB   SDXL family (SDXL base / Animagine XL 4.0) + ControlNet / IP-Adapter where a job needs them
//   medium = 16 GB  Z-Image-Turbo (pictures, short text) and FLUX.2 [klein] 4B (edits); works from 12 GB
//   large  = 24 GB  Qwen-Image-2512 (best text in pictures) and Qwen-Image-Edit-2511, both with 4-step Lightning LoRAs
// Every picture model is commercial-OK by default (Apache-2.0, MIT, BSD-3-Clause, CreativeML Open RAIL++-M); see models.ts.
// The one 3D recipe (character-3d) uses ComfyUI's built-in Hunyuan3D nodes: its weights carry a licence notice (not for
// the EU, UK or South Korea), are never bundled, and only download after the user's own Yes (models.ts `restricted`).
// Background removal is ComfyUI's built-in RemoveBackground node with BiRefNet (MIT).
import { Graph, normalize, toApi, toUi, type ApiPrompt, type Link, type NodeSchema, type UiWorkflow } from './graph.ts';
import { MODEL_FILES, modelById, modelPage, modelUrl, type ModelFile } from './models.ts';
import { CUSTOM_NODES, type CustomNode } from './nodes.ts';

export const WORKFLOW_PACK_VERSION = '2026.10.01';
export const TESTED_COMFYUI = '0.22.3';
export type TierId = 'small' | 'medium' | 'large';
export interface Tier { id: TierId; label: string; minVramGB: number; recVramGB: number; family: string; note: string }
export const TIERS: Record<TierId, Tier> = {
  small: { id: 'small', label: '8 GB', minVramGB: 8, recVramGB: 8, family: 'SDXL', note: 'Most gaming PCs from the last 5 years. Can\'t write words in pictures: add text in any editor.' },
  medium: { id: 'medium', label: '16 GB', minVramGB: 12, recVramGB: 16, family: 'Z-Image-Turbo + FLUX.2 klein 4B', note: 'Fast and sharp. Writes short words. Works from 12 GB, a bit slower.' },
  large: { id: 'large', label: '24 GB', minVramGB: 20, recVramGB: 24, family: 'Qwen-Image 2512 + Qwen-Image-Edit 2511', note: 'Best quality and the best words in pictures. Uses fp8 weights: an NVIDIA RTX card is best.' },
};
export const TIER_IDS: TierId[] = ['small', 'medium', 'large'];

/** Pick the biggest tier that fits `vramGB` (undefined = none fits). */
export function tierFor(vramGB: number): TierId | undefined {
  return [...TIER_IDS].reverse().find((t) => vramGB >= TIERS[t].minVramGB);
}

// ---------------------------------------------------------------- building blocks
const SEED = 20261001;
const NEG_SDXL = 'lowres, blurry, jpeg artifacts, watermark, signature, text, logo, deformed, bad anatomy, extra fingers, cropped';
const NEG_QWEN = 'blurry, low quality, distorted text, misspelled words, watermark, deformed';

type Sampler = { steps: number; cfg: number; sampler_name: string; scheduler: string };
interface Base { model: Link; clip: Link; vae: Link; s: Sampler; family: 'sdxl' | 'zit' | 'qi' }

function loader(g: Graph, type: string, input: string, modelId: string, extra: Record<string, string | number> = {}, title?: string) {
  const m = modelById(modelId);
  if (!m) throw new Error(`unknown model ${modelId}`);
  const r = g.add(type, { [input]: m.file, ...extra }, { title });
  g.get(r.id)!.models = [{ name: m.file, url: modelUrl(m), directory: m.folder, hash: m.sha256, hash_type: 'SHA256' }];
  return r;
}

function sdxlBase(g: Graph, ckpt: 'sdxl-base' | 'animagine-xl-4'): Base {
  const ck = loader(g, 'CheckpointLoaderSimple', 'ckpt_name', ckpt);
  const s = ckpt === 'animagine-xl-4'
    ? { steps: 28, cfg: 5, sampler_name: 'euler_ancestral', scheduler: 'normal' }
    : { steps: 28, cfg: 6, sampler_name: 'dpmpp_2m', scheduler: 'karras' };
  return { model: ck.out(0), clip: ck.out(1), vae: ck.out(2), s, family: 'sdxl' };
}
function zitBase(g: Graph): Base {
  const unet = loader(g, 'UNETLoader', 'unet_name', 'z-image-turbo', { weight_dtype: 'default' });
  const clip = loader(g, 'CLIPLoader', 'clip_name', 'qwen3-4b-te', { type: 'lumina2', device: 'default' });
  const vae = loader(g, 'VAELoader', 'vae_name', 'z-image-vae');
  const ms = g.add('ModelSamplingAuraFlow', { model: unet.out(), shift: 3 });
  return { model: ms.out(), clip: clip.out(), vae: vae.out(), s: { steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple' }, family: 'zit' };
}
function qiBase(g: Graph): Base {
  const unet = loader(g, 'UNETLoader', 'unet_name', 'qwen-image-2512', { weight_dtype: 'default' });
  const lora = loader(g, 'LoraLoaderModelOnly', 'lora_name', 'qwen-image-2512-lightning', { strength_model: 1 }, 'Lightning LoRA (4 steps)');
  g.get(lora.id)!.inputs.model = unet.out();
  const ms = g.add('ModelSamplingAuraFlow', { model: lora.out(), shift: 3.1 });
  const clip = loader(g, 'CLIPLoader', 'clip_name', 'qwen25-vl-7b-te', { type: 'qwen_image', device: 'default' });
  const vae = loader(g, 'VAELoader', 'vae_name', 'qwen-image-vae');
  return { model: ms.out(), clip: clip.out(), vae: vae.out(), s: { steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple' }, family: 'qi' };
}

interface Cond { pos: Link; neg: Link }
function encode(g: Graph, b: Base, prompt: string, negative?: string): Cond {
  const pos = g.add('CLIPTextEncode', { text: prompt, clip: b.clip }, { title: 'Your prompt: describe the picture', highlight: true });
  if (b.family === 'zit') return { pos: pos.out(), neg: g.add('ConditioningZeroOut', { conditioning: pos.out() }).out() };
  const neg = g.add('CLIPTextEncode', { text: negative ?? (b.family === 'qi' ? NEG_QWEN : NEG_SDXL), clip: b.clip }, { title: 'Things to avoid' });
  return { pos: pos.out(), neg: neg.out() };
}
function emptyLatent(g: Graph, b: Base, width: number, height: number): Link {
  return g.add(b.family === 'sdxl' ? 'EmptyLatentImage' : 'EmptySD3LatentImage', { width, height, batch_size: 1 }, { title: `Picture size ${width}x${height}` }).out();
}
function sample(g: Graph, b: Base, c: Cond, latent: Link, denoise = 1, model?: Link): Link {
  const ks = g.add('KSampler', { model: model ?? b.model, seed: SEED, ...b.s, positive: c.pos, negative: c.neg, latent_image: latent, denoise });
  return g.add('VAEDecode', { samples: ks.out(), vae: b.vae }).out();
}
function txt2img(g: Graph, b: Base, prompt: string, w: number, h: number, negative?: string, model?: Link) {
  const c = encode(g, b, prompt, negative);
  return { image: sample(g, b, c, emptyLatent(g, b, w, h), 1, model), c };
}
function save(g: Graph, image: Link, prefix: string, title = 'Save the picture') {
  g.add('SaveImage', { images: image, filename_prefix: `VTubePro/${prefix}` }, { title });
}
function loadImage(g: Graph, file: string, title: string): Link {
  return g.add('LoadImage', { image: file }, { title, highlight: true }).out();
}
function upscaleTo(g: Graph, image: Link, width: number, height: number): Link {
  const um = loader(g, 'UpscaleModelLoader', 'model_name', 'realesrgan-x4');
  const up = g.add('ImageUpscaleWithModel', { upscale_model: um.out(), image });
  return g.add('ImageScale', { image: up.out(), upscale_method: 'lanczos', width, height, crop: 'center' }, { title: `Final size ${width}x${height}` }).out();
}
function sameSizeAs(g: Graph, image: Link, like: Link): Link {
  const sz = g.add('GetImageSize', { image: like }, { title: 'Original size' });
  return g.add('ImageScale', { image, upscale_method: 'lanczos', width: sz.out(0), height: sz.out(1), crop: 'disabled' }, { title: 'Back to the original size' }).out();
}
function removeBg(g: Graph, image: Link): { rgba: Link; fg: Link } {
  const bm = loader(g, 'LoadBackgroundRemovalModel', 'bg_removal_name', 'birefnet', {}, 'Background remover (BiRefNet, MIT)');
  const m = g.add('RemoveBackground', { image, bg_removal_model: bm.out() });
  const inv = g.add('InvertMask', { mask: m.out() });
  const rgba = g.add('JoinImageWithAlpha', { image, alpha: inv.out() }, { title: 'Transparent background' });
  return { rgba: rgba.out(), fg: m.out() };
}

/** Just the cut-out matte (1 = the character), without the transparent copy removeBg also makes. */
function cutMask(g: Graph, image: Link): Link {
  const bm = loader(g, 'LoadBackgroundRemovalModel', 'bg_removal_name', 'birefnet', {}, 'Background remover (BiRefNet, MIT)');
  return g.add('RemoveBackground', { image, bg_removal_model: bm.out() }, { title: 'Find the character' }).out();
}

/** Picture -> 3D shape with ComfyUI's built-in Hunyuan3D nodes (the same chain as ComfyUI's own Hunyuan3D template). The
 *  character is cut out, put on plain white and centred in a square first: the model expects one object on a clean ground. */
function characterShape(g: Graph, modelId: 'hunyuan3d-2' | 'hunyuan3d-21', o: { steps: number; cfg: number; latent: number; octree: number }) {
  const pic = loadImage(g, IN_CHARACTER, 'Your character picture (whole body, front view)');
  const work = g.add('ImageScaleToTotalPixels', { image: pic, upscale_method: 'lanczos', megapixels: 1, resolution_steps: 8 }, { title: 'Work at about 1 megapixel' });
  const fg = cutMask(g, work.out());
  const size = g.add('GetImageSize', { image: work.out() });
  const solid = g.add('SolidMask', { value: 1, width: size.out(0), height: size.out(1) });
  const white = g.add('MaskToImage', { mask: solid.out() }, { title: 'Plain white background' });
  const flat = g.add('ImageCompositeMasked', { destination: white.out(), source: work.out(), x: 0, y: 0, resize_source: false, mask: fg }, { title: 'Character on white' });
  const square = g.add('ResizeAndPadImage', { image: flat.out(), target_width: 1024, target_height: 1024, padding_color: 'white', interpolation: 'lanczos' }, { title: 'Centre in a square' });
  const ck = loader(g, 'ImageOnlyCheckpointLoader', 'ckpt_name', modelId);
  const enc = g.add('CLIPVisionEncode', { clip_vision: ck.out(1), image: square.out(), crop: 'center' });
  const cond = g.add('Hunyuan3Dv2Conditioning', { clip_vision_output: enc.out() });
  const latent = g.add('EmptyLatentHunyuan3Dv2', { resolution: o.latent, batch_size: 1 });
  const ms = g.add('ModelSamplingAuraFlow', { model: ck.out(0), shift: 1 });
  const ks = g.add('KSampler', { model: ms.out(), seed: SEED, steps: o.steps, cfg: o.cfg, sampler_name: 'euler', scheduler: 'normal', positive: cond.out(0), negative: cond.out(1), latent_image: latent.out(), denoise: 1 });
  const vox = g.add('VAEDecodeHunyuan3D', { samples: ks.out(), vae: ck.out(2), num_chunks: 8000, octree_resolution: o.octree });
  const mesh = g.add('VoxelToMesh', { voxel: vox.out(), algorithm: 'surface net', threshold: 0.6 });
  g.add('SaveGLB', { mesh: mesh.out(), filename_prefix: 'VTubePro/character' }, { title: 'Save the 3D character (.glb)' });
}

/** Roll the picture by half (so the old edges meet in the middle), repaint a band over the seam, blend it back in. */
function makeSeamless(g: Graph, b: Base, c: Cond, image: Link, W: number, H: number, both: boolean, denoise: number): Link {
  const L = g.add('ImageCrop', { image, width: W / 2, height: H, x: 0, y: 0 }, { title: 'Left half' });
  const R = g.add('ImageCrop', { image, width: W / 2, height: H, x: W / 2, y: 0 }, { title: 'Right half' });
  let rolled = g.add('ImageStitch', { image1: R.out(), direction: 'right', match_image_size: false, spacing_width: 0, spacing_color: 'white', image2: L.out() }, { title: 'Swap halves (edges meet in the middle)' }).out();
  const band = Math.round(Math.min(W, H) / 8 / 8) * 8;
  const base = g.add('SolidMask', { value: 0, width: W, height: H });
  const vb = g.add('SolidMask', { value: 1, width: band, height: H });
  let mask = g.add('MaskComposite', { destination: base.out(), source: vb.out(), x: W / 2 - band / 2, y: 0, operation: 'add' }, { title: 'Seam band' }).out();
  if (both) {
    const T = g.add('ImageCrop', { image: rolled, width: W, height: H / 2, x: 0, y: 0 }, { title: 'Top half' });
    const B = g.add('ImageCrop', { image: rolled, width: W, height: H / 2, x: 0, y: H / 2 }, { title: 'Bottom half' });
    rolled = g.add('ImageStitch', { image1: B.out(), direction: 'down', match_image_size: false, spacing_width: 0, spacing_color: 'white', image2: T.out() }, { title: 'Swap top and bottom' }).out();
    const hb = g.add('SolidMask', { value: 1, width: W, height: band });
    mask = g.add('MaskComposite', { destination: mask, source: hb.out(), x: 0, y: H / 2 - band / 2, operation: 'add' }, { title: 'Seam cross' }).out();
  }
  const lat = g.add('VAEEncode', { pixels: rolled, vae: b.vae });
  const masked = g.add('SetLatentNoiseMask', { samples: lat.out(), mask });
  const repaint = sample(g, b, c, masked.out(), denoise);
  const soft = g.add('ImageBlur', { image: g.add('MaskToImage', { mask }).out(), blur_radius: 31, sigma: 10 }, { title: 'Soft seam edge' });
  const softMask = g.add('ImageToMask', { image: soft.out(), channel: 'red' });
  return g.add('ImageCompositeMasked', { destination: rolled, source: repaint, x: 0, y: 0, resize_source: false, mask: softMask.out() }, { title: 'Seamless result' }).out();
}

// ---- edits
function qieEdit(g: Graph, images: Link[], prompt: string): Link {
  const unet = loader(g, 'UNETLoader', 'unet_name', 'qwen-image-edit-2511', { weight_dtype: 'default' });
  const ms = g.add('ModelSamplingAuraFlow', { model: unet.out(), shift: 3.1 });
  const norm = g.add('CFGNorm', { model: ms.out(), strength: 1 });
  const lora = loader(g, 'LoraLoaderModelOnly', 'lora_name', 'qwen-image-edit-2511-lightning', { strength_model: 1 }, 'Lightning LoRA (4 steps)');
  g.get(lora.id)!.inputs.model = norm.out();
  const clip = loader(g, 'CLIPLoader', 'clip_name', 'qwen25-vl-7b-te', { type: 'qwen_image', device: 'default' });
  const vae = loader(g, 'VAELoader', 'vae_name', 'qwen-image-vae');
  const first = g.add('FluxKontextImageScale', { image: images[0] }, { title: 'Fit image 1 to the model' });
  const imgs: Record<string, Link> = { image1: first.out() };
  images.slice(1).forEach((im, i) => { imgs[`image${i + 2}`] = im; });
  const pos = g.add('TextEncodeQwenImageEditPlus', { clip: clip.out(), prompt, vae: vae.out(), ...imgs }, { title: 'Your edit: say what to change', highlight: true });
  const neg = g.add('TextEncodeQwenImageEditPlus', { clip: clip.out(), prompt: '', vae: vae.out(), ...imgs }, { title: 'Negative (leave empty)' });
  const p2 = g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: pos.out(), reference_latents_method: 'index_timestep_zero' });
  const n2 = g.add('FluxKontextMultiReferenceLatentMethod', { conditioning: neg.out(), reference_latents_method: 'index_timestep_zero' });
  const lat = g.add('VAEEncode', { pixels: first.out(), vae: vae.out() });
  const ks = g.add('KSampler', { model: lora.out(), seed: SEED, steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: p2.out(), negative: n2.out(), latent_image: lat.out(), denoise: 1 });
  return g.add('VAEDecode', { samples: ks.out(), vae: vae.out() }).out();
}
function kleinEdit(g: Graph, images: Link[], prompt: string): Link {
  const unet = loader(g, 'UNETLoader', 'unet_name', 'flux2-klein-4b', { weight_dtype: 'default' });
  const clip = loader(g, 'CLIPLoader', 'clip_name', 'qwen3-4b-te', { type: 'flux2', device: 'default' });
  const vae = loader(g, 'VAELoader', 'vae_name', 'flux2-vae');
  const first = g.add('ImageScaleToTotalPixels', { image: images[0], upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }, { title: 'Image 1 at about 1 megapixel' });
  const size = g.add('GetImageSize', { image: first.out() });
  const pos = g.add('CLIPTextEncode', { text: prompt, clip: clip.out() }, { title: 'Your edit: say what to change', highlight: true });
  let p = pos.out();
  let n = g.add('ConditioningZeroOut', { conditioning: pos.out() }).out();
  const refs = [first.out(), ...images.slice(1).map((im, i) => g.add('ImageScaleToTotalPixels', { image: im, upscale_method: 'lanczos', megapixels: 1, resolution_steps: 16 }, { title: `Image ${i + 2} at about 1 megapixel` }).out())];
  for (const r of refs) {
    const lat = g.add('VAEEncode', { pixels: r, vae: vae.out() });
    p = g.add('ReferenceLatent', { conditioning: p, latent: lat.out() }).out();
    n = g.add('ReferenceLatent', { conditioning: n, latent: lat.out() }).out();
  }
  const guider = g.add('CFGGuider', { model: unet.out(), positive: p, negative: n, cfg: 1 });
  const sampler = g.add('KSamplerSelect', { sampler_name: 'euler' });
  const sched = g.add('Flux2Scheduler', { steps: 4, width: size.out(0), height: size.out(1) });
  const noise = g.add('RandomNoise', { noise_seed: SEED });
  const empty = g.add('EmptyFlux2LatentImage', { width: size.out(0), height: size.out(1), batch_size: 1 });
  const out = g.add('SamplerCustomAdvanced', { noise: noise.out(), guider: guider.out(), sampler: sampler.out(), sigmas: sched.out(), latent_image: empty.out() });
  return g.add('VAEDecode', { samples: out.out(0), vae: vae.out() }).out();
}
/** SDXL img2img that keeps the layout (ControlNet Union, lineart / canny) and optionally copies a reference look (IP-Adapter). */
function sdxlRepaint(g: Graph, image: Link, prompt: string, o: { ref?: Link; denoise: number }): Link {
  const b = sdxlBase(g, 'animagine-xl-4');
  const work = g.add('ImageScaleToTotalPixels', { image, upscale_method: 'lanczos', megapixels: 1, resolution_steps: 8 }, { title: 'Work at about 1 megapixel' });
  const edges = g.add('Canny', { image: work.out(), low_threshold: 0.2, high_threshold: 0.5 }, { title: 'Lines to keep' });
  const cn = loader(g, 'ControlNetLoader', 'control_net_name', 'controlnet-union-sdxl');
  const cnu = g.add('SetUnionControlNetType', { control_net: cn.out(), type: 'canny/lineart/anime_lineart/mlsd' });
  const c = encode(g, b, prompt);
  const ap = g.add('ControlNetApplyAdvanced', { positive: c.pos, negative: c.neg, control_net: cnu.out(), image: edges.out(), strength: 0.8, start_percent: 0, end_percent: 0.9, vae: b.vae }, { title: 'Keep every line in place' });
  let model = b.model;
  if (o.ref) {
    const ipm = loader(g, 'IPAdapterModelLoader', 'ipadapter_file', 'ipadapter-plus-sdxl');
    const cv = loader(g, 'CLIPVisionLoader', 'clip_name', 'clip-vision-vit-h');
    model = g.add('IPAdapterAdvanced', { model: b.model, ipadapter: ipm.out(), image: o.ref, weight: 0.7, weight_type: 'style transfer', combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only', clip_vision: cv.out() }, { title: 'Copy the look of your reference' }).out();
  }
  const lat = g.add('VAEEncode', { pixels: work.out(), vae: b.vae });
  return sample(g, b, { pos: ap.out(0), neg: ap.out(1) }, lat.out(), o.denoise, model);
}

// ---------------------------------------------------------------- the workflows
export interface IoSpec { node: string; kind: 'image' | 'text'; what: string; default: string }
export interface OutSpec { node: string; what: string; size: string; format: 'PNG' | 'PNG with transparency' | 'GLB' }
export interface Built { graph: Graph; inputs: IoSpec[]; outputs: OutSpec[]; settings: string }
export interface WorkflowDef {
  id: string;
  /** shared/localAi/workflows.ts TaskId */
  task: string;
  title: string;
  /** Short name for buttons / file names. */
  short: string;
  forWhat: string;
  output: string;
  vtp: string;
  /** The words a user says to their AI. */
  ask: string;
  steps: string[];
  tips: string[];
  tiers: Partial<Record<TierId, () => Built>>;
  /** What the models are called per size, when it is not the tier's picture family (the 3D recipe). */
  family?: Partial<Record<TierId, string>>;
}

/** Record which nodes the user changes / where results land (by node id) after the graph is built. */
function io(g: Graph, settings: string, outputs: { what: string; size: string; format?: OutSpec['format'] }[]): Built {
  const inputs: IoSpec[] = [];
  for (const n of g.nodes) {
    if (n.type === 'LoadImage') inputs.push({ node: n.id, kind: 'image', what: n.title ?? 'Picture', default: String(n.inputs.image) });
    else if (n.highlight && typeof (n.inputs.text ?? n.inputs.prompt) === 'string') inputs.push({ node: n.id, kind: 'text', what: n.title ?? 'Prompt', default: String(n.inputs.text ?? n.inputs.prompt) });
  }
  const saves = g.nodes.filter((n) => n.type === 'SaveImage' || n.type === 'SaveGLB');
  return { graph: g, inputs, settings, outputs: saves.map((n, i) => ({ node: n.id, what: outputs[i]?.what ?? (n.type === 'SaveGLB' ? '3D model' : 'Picture'), size: outputs[i]?.size ?? '', format: outputs[i]?.format ?? (n.type === 'SaveGLB' ? 'GLB' : 'PNG') })) };
}

const IN_TEXTURE = 'vtp_texture.png';
const IN_REFERENCE = 'vtp_reference.png';
const IN_AVATAR = 'vtp_avatar.png';
const IN_CHARACTER = 'vtp_character.png';

export const WORKFLOW_DEFS: WorkflowDef[] = [
  {
    id: 'character-3d', task: 'character-3d', short: 'Character 3D',
    title: 'Character 3D: turn a picture into a 3D model',
    forWhat: 'A picture of your character (whole body, facing front) turned into a 3D model on your own computer. The model is plain grey: it has the shape, not the colours.',
    output: 'A .glb 3D model in ComfyUI\'s output/VTubePro folder.',
    vtp: 'The Create tab\'s "Create my character" runs this for you. Or add the .glb with "Add my model", then paint it (Create tab, "Paint with AI") or finish it in Blender. VTube Pro adds the eyes and mouth.',
    ask: 'Set up the VTube Pro character 3D workflow in ComfyUI',
    steps: ['Load a picture of your character in "Your character picture": whole body, facing the front, one character.', 'Press Run. It takes a few minutes, so do it when you are not live.'],
    tips: ['Original characters only: no existing characters, logos or game art.', 'A plain background and even light give the cleanest shape.', 'The Hunyuan3D licence does not cover the EU, the UK or South Korea: if you live there, use another way to make your character.'],
    family: { small: 'Hunyuan3D 2.0', medium: 'Hunyuan3D 2.1', large: 'Hunyuan3D 2.1, finer detail' },
    tiers: {
      small: () => {
        const g = new Graph();
        characterShape(g, 'hunyuan3d-2', { steps: 20, cfg: 8, latent: 3072, octree: 256 });
        return io(g, 'Hunyuan3D 2.0: 20 steps, CFG 8, shape detail 256. Cuts the character out and puts it on white first.', [{ what: '3D character (grey)', size: 'about 100k triangles' }]);
      },
      medium: () => {
        const g = new Graph();
        characterShape(g, 'hunyuan3d-21', { steps: 30, cfg: 5, latent: 4096, octree: 256 });
        return io(g, 'Hunyuan3D 2.1: 30 steps, CFG 5, shape detail 256. Cuts the character out and puts it on white first.', [{ what: '3D character (grey)', size: 'about 100k triangles' }]);
      },
      large: () => {
        const g = new Graph();
        characterShape(g, 'hunyuan3d-21', { steps: 50, cfg: 5, latent: 4096, octree: 384 });
        return io(g, 'Hunyuan3D 2.1: 50 steps, CFG 5, shape detail 384. Cuts the character out and puts it on white first.', [{ what: '3D character (grey, finer)', size: 'about 200k triangles' }]);
      },
    },
  },
  {
    id: 'avatar-texture-repaint', task: 'avatar-texture', short: 'Avatar texture repaint',
    title: 'Repaint an avatar texture from a reference picture',
    forWhat: 'Your model\'s texture sheet repainted in the colours and materials of a character picture. Every seam stays where it is.',
    output: 'A PNG the same size as your texture. Save it as a new file; keep the original.',
    vtp: 'Open your model in Blender (or the costume editor), swap the texture for the new PNG and check it from every side. For whole-model paint by camera views, VTube Pro\'s own painter (Create tab, "Paint with AI") does more.',
    ask: 'Set up the VTube Pro avatar texture repaint workflow in ComfyUI',
    steps: ['Load your texture sheet (the PNG from your model) in "Your texture".', 'Load a picture of the character in "Your reference".', 'Change the words if you like, then press Run.'],
    tips: ['Faces stay hand-drawn: repaint clothes and hair, then fix the face by hand.', 'If a seam moved, lower "denoise" (small) or say "keep every line" (medium, large).', 'Run it when you are not live.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const ref = loadImage(g, IN_REFERENCE, 'Your reference (character picture)');
        const out = sdxlRepaint(g, tex, 'game character texture sheet, flat colours, clean anime cel shading, same layout, same seams', { ref, denoise: 0.6 });
        save(g, sameSizeAs(g, out, tex), 'avatar-texture');
        return io(g, '28 steps, CFG 5, denoise 0.6, ControlNet 0.8, IP-Adapter 0.7 (style transfer).', [{ what: 'Repainted texture', size: 'same as your texture' }]);
      },
      medium: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const ref = loadImage(g, IN_REFERENCE, 'Your reference (character picture)');
        const out = kleinEdit(g, [tex, ref], 'Repaint image 1 using the colours and materials of the character in image 2. Keep every shape, seam, island and line of image 1 exactly where it is. Flat even lighting, no shadows.');
        save(g, sameSizeAs(g, out, tex), 'avatar-texture');
        return io(g, '4 steps (distilled), CFG 1.', [{ what: 'Repainted texture', size: 'same as your texture' }]);
      },
      large: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const ref = loadImage(g, IN_REFERENCE, 'Your reference (character picture)');
        const out = qieEdit(g, [tex, ref], 'Repaint image 1 using the colours and materials of the character in image 2. Keep every shape, seam, island and line of image 1 exactly where it is. Flat even lighting, no shadows.');
        save(g, sameSizeAs(g, out, tex), 'avatar-texture');
        return io(g, '4 steps with the Lightning LoRA, CFG 1.', [{ what: 'Repainted texture', size: 'same as your texture' }]);
      },
    },
  },
  {
    id: 'avatar-skin-variant', task: 'avatar-skin', short: 'Outfit or skin variant',
    title: 'New outfit colours or a skin variant',
    forWhat: 'A recolour or restyle of a texture (a winter jacket, a red version) that still fits your model.',
    output: 'A PNG the same size as the original texture.',
    vtp: 'Add it as a new costume or texture set (the Costumes tab, or import_costume for AIs). Never overwrite the original.',
    ask: 'Set up the VTube Pro outfit variant workflow in ComfyUI',
    steps: ['Load the texture in "Your texture".', 'Say the change in words, like "make the jacket dark green wool".', 'Press Run. Try a few times and keep the best.'],
    tips: ['Name what must not change: "keep the emblem and every seam".', 'Picture size stays the same as the original, so it fits your model.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const out = sdxlRepaint(g, tex, 'game character texture sheet, dark green wool jacket, same layout, same seams, flat colours', { denoise: 0.5 });
        save(g, sameSizeAs(g, out, tex), 'skin-variant');
        return io(g, '28 steps, CFG 5, denoise 0.5 (lower keeps more), ControlNet 0.8.', [{ what: 'New texture', size: 'same as your texture' }]);
      },
      medium: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const out = kleinEdit(g, [tex], 'Make the jacket dark green wool. Keep every seam, emblem, shape and line exactly where it is. Flat even lighting.');
        save(g, sameSizeAs(g, out, tex), 'skin-variant');
        return io(g, '4 steps, CFG 1.', [{ what: 'New texture', size: 'same as your texture' }]);
      },
      large: () => {
        const g = new Graph();
        const tex = loadImage(g, IN_TEXTURE, 'Your texture (from your model)');
        const out = qieEdit(g, [tex], 'Make the jacket dark green wool. Keep every seam, emblem, shape and line exactly where it is. Flat even lighting.');
        save(g, sameSizeAs(g, out, tex), 'skin-variant');
        return io(g, '4 steps with the Lightning LoRA, CFG 1.', [{ what: 'New texture', size: 'same as your texture' }]);
      },
    },
  },
  {
    id: 'character-concept-sheet', task: 'concept-sheet', short: 'Character reference sheet',
    title: 'Character reference sheet (front, side, back)',
    forWhat: 'Front, side and back views of an original character, to model from or to paint textures with.',
    output: 'One wide sheet, 2048x1024 PNG, plain background.',
    vtp: 'Use it as the reference for the texture repaint workflow and for your model maker.',
    ask: 'Set up the VTube Pro character sheet workflow in ComfyUI',
    steps: ['Describe your character in "Your prompt": hair, eyes, outfit, colours.', 'Press Run a few times and keep the most consistent sheet.'],
    tips: ['Original designs only: no existing characters, logos or game outfits.', 'A neutral A-pose and even light make modelling easier.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'animagine-xl-4');
        const { image } = txt2img(g, b, 'character sheet, multiple views, front view, side view, back view, full body, a-pose, simple white background, 1girl, silver hair, teal eyes, oversized hoodie, sneakers, masterpiece, best quality', 1536, 768);
        save(g, upscaleTo(g, image, 2048, 1024), 'character-sheet');
        return io(g, '1536x768, 28 steps, CFG 5, then Real-ESRGAN to 2048x1024.', [{ what: 'Reference sheet', size: '2048x1024' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const { image } = txt2img(g, b, 'Character turnaround sheet of an original anime-style character: front view, side view and back view side by side, full body, neutral A-pose, plain white background, even studio light. Silver hair, teal eyes, oversized hoodie, sneakers.', 1536, 768);
        save(g, upscaleTo(g, image, 2048, 1024), 'character-sheet');
        return io(g, '1536x768, 8 steps, CFG 1, then Real-ESRGAN to 2048x1024.', [{ what: 'Reference sheet', size: '2048x1024' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const { image } = txt2img(g, b, 'Character turnaround sheet of an original anime-style character: front view, side view and back view side by side, full body, neutral A-pose, plain white background, even studio light. Silver hair, teal eyes, oversized hoodie, sneakers.', 1664, 832);
        save(g, upscaleTo(g, image, 2048, 1024), 'character-sheet');
        return io(g, '1664x832, 4 steps (Lightning), CFG 1, then Real-ESRGAN to 2048x1024.', [{ what: 'Reference sheet', size: '2048x1024' }]);
      },
    },
  },
  {
    id: 'room-seamless-tiles', task: 'room-tiles', short: 'Seamless room tiles',
    title: 'Seamless tiles for rooms (floors, walls, fabric)',
    forWhat: 'Square textures that repeat with no visible seam: wood floor, brick, carpet, tiles, fabric.',
    output: '1024x1024 PNG that tiles in both directions.',
    vtp: 'Use it in your room\'s material in Blender (or the room creation package). 1024 px fits VTube Pro\'s texture budget.',
    ask: 'Set up the VTube Pro seamless tile workflow in ComfyUI',
    steps: ['Say the material in "Your prompt" (keep "flat, even lighting").', 'Press Run. The workflow swaps the halves and repaints the seams for you.'],
    tips: ['Baked shadows repeat badly: ask for flat, even light.', 'Check it: put four copies side by side in any editor.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'sdxl-base');
        const prompt = 'top-down flat texture of old oak floor planks, seamless, even lighting, no shadows, no perspective, high detail';
        const { image, c } = txt2img(g, b, prompt, 1024, 1024);
        save(g, makeSeamless(g, b, c, image, 1024, 1024, true, 0.75), 'room-tile');
        return io(g, '1024x1024, 28 steps, CFG 6; seam band repainted at denoise 0.75.', [{ what: 'Seamless tile', size: '1024x1024' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const prompt = 'Top-down flat texture of old oak floor planks, photographed straight down, perfectly even lighting, no shadows, no perspective, fills the whole frame.';
        const { image, c } = txt2img(g, b, prompt, 1024, 1024);
        save(g, makeSeamless(g, b, c, image, 1024, 1024, true, 0.7), 'room-tile');
        return io(g, '1024x1024, 8 steps, CFG 1; seam band repainted at denoise 0.7.', [{ what: 'Seamless tile', size: '1024x1024' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const prompt = 'Top-down flat texture of old oak floor planks, photographed straight down, perfectly even lighting, no shadows, no perspective, fills the whole frame.';
        const { image, c } = txt2img(g, b, prompt, 1024, 1024);
        save(g, makeSeamless(g, b, c, image, 1024, 1024, true, 0.7), 'room-tile');
        return io(g, '1024x1024, 4 steps (Lightning), CFG 1; seam band repainted at denoise 0.7.', [{ what: 'Seamless tile', size: '1024x1024' }]);
      },
    },
  },
  {
    id: 'room-skybox-360', task: 'skybox', short: '360 sky',
    title: '360 sky or backdrop panorama',
    forWhat: 'A wrap-around sky or far backdrop (sunset city, space, forest) for outside your windows.',
    output: '4096x2048 PNG (2:1, wraps left to right).',
    vtp: 'Put it on your room\'s sky mesh with a material named M_Sky (or SKY_...) so the room\'s lighting tints it.',
    ask: 'Set up the VTube Pro 360 sky workflow in ComfyUI',
    steps: ['Describe the place in "Your prompt". Keep "horizon in the middle".', 'Press Run. The left and right edges are joined for you.'],
    tips: ['Plain sky at the top and plain ground at the bottom hide the stretching.', 'Keep people out of panoramas.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'sdxl-base');
        const prompt = 'equirectangular 360 panorama, sunset over a neon city skyline, horizon in the middle, clear sky above, no people, wide angle';
        const { image, c } = txt2img(g, b, prompt, 1536, 768);
        save(g, upscaleTo(g, makeSeamless(g, b, c, image, 1536, 768, false, 0.75), 4096, 2048), 'sky-360');
        return io(g, '1536x768, left-right seam repainted, Real-ESRGAN to 4096x2048.', [{ what: '360 panorama', size: '4096x2048' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const prompt = 'Equirectangular 360-degree panorama: sunset over a neon city skyline, horizon exactly in the middle, clear sky above, plain street below, no people.';
        const { image, c } = txt2img(g, b, prompt, 2048, 1024);
        save(g, upscaleTo(g, makeSeamless(g, b, c, image, 2048, 1024, false, 0.7), 4096, 2048), 'sky-360');
        return io(g, '2048x1024, 8 steps, left-right seam repainted, Real-ESRGAN to 4096x2048.', [{ what: '360 panorama', size: '4096x2048' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const prompt = 'Equirectangular 360-degree panorama: sunset over a neon city skyline, horizon exactly in the middle, clear sky above, plain street below, no people.';
        const { image, c } = txt2img(g, b, prompt, 1664, 832);
        save(g, upscaleTo(g, makeSeamless(g, b, c, image, 1664, 832, false, 0.7), 4096, 2048), 'sky-360');
        return io(g, '1664x832, 4 steps (Lightning), left-right seam repainted, Real-ESRGAN to 4096x2048.', [{ what: '360 panorama', size: '4096x2048' }]);
      },
    },
  },
  {
    id: 'room-screen-posters', task: 'room-art', short: 'Poster or sign with text',
    title: 'Posters and signs with words, for your room',
    forWhat: 'Wall posters, shop signs, menu boards and banners with readable words.',
    output: '1024x2048 PNG (portrait poster). Power-of-two, so it works as a texture.',
    vtp: 'Put it on a poster or sign in your room (Blender), or use it as the in-room screen picture.',
    ask: 'Set up the VTube Pro poster workflow in ComfyUI',
    steps: ['Write the words in quotes inside "Your prompt", like the title "LATE NIGHT RAMEN".', 'Press Run. Small: add the words in any editor afterwards.'],
    tips: ['No real brands or logos: make your own designs.', 'Short titles come out best (2-4 words).'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'sdxl-base');
        const { image } = txt2img(g, b, 'retro poster art, steaming ramen bowl, neon city night, bold graphic shapes, large blank space at the top for a title', 704, 1408);
        save(g, upscaleTo(g, image, 1024, 2048), 'poster');
        return io(g, '704x1408, 28 steps, CFG 6, Real-ESRGAN to 1024x2048. SDXL can\'t write: add the words yourself.', [{ what: 'Poster', size: '1024x2048' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const { image } = txt2img(g, b, 'Retro poster with the title "LATE NIGHT RAMEN" in big bold letters at the top, a steaming ramen bowl, neon city at night, bold graphic shapes.', 768, 1536);
        save(g, upscaleTo(g, image, 1024, 2048), 'poster');
        return io(g, '768x1536, 8 steps, CFG 1, Real-ESRGAN to 1024x2048.', [{ what: 'Poster', size: '1024x2048' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const { image } = txt2img(g, b, 'Retro poster with the title "LATE NIGHT RAMEN" in big bold letters at the top and "OPEN TILL 3AM" small at the bottom, a steaming ramen bowl, neon city at night, bold graphic shapes.', 832, 1664);
        save(g, upscaleTo(g, image, 1024, 2048), 'poster');
        return io(g, '832x1664, 4 steps (Lightning), CFG 1, Real-ESRGAN to 1024x2048.', [{ what: 'Poster', size: '1024x2048' }]);
      },
    },
  },
  {
    id: 'decals-stickers', task: 'decal', short: 'Decals and stickers',
    title: 'Decals, stickers and emblems with a see-through background',
    forWhat: 'Graffiti, stickers, patches and your own emblems for walls and costumes.',
    output: '1024x1024 PNG with a transparent background.',
    vtp: 'Use it as a decal in your room or a patch on a costume. Pack several into one 2048 sheet to save memory.',
    ask: 'Set up the VTube Pro sticker workflow in ComfyUI',
    steps: ['Describe the sticker in "Your prompt" (keep "plain white background").', 'Press Run. The background is removed for you.'],
    tips: ['A plain background gives the cleanest cut-out.', 'Thick outlines read well from far away.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'sdxl-base');
        const { image } = txt2img(g, b, 'sticker of a cute cartoon frog holding a game controller, flat vector style, thick white outline, centered, plain white background', 1024, 1024);
        save(g, removeBg(g, image).rgba, 'decal');
        return io(g, '1024x1024, 28 steps, CFG 6, BiRefNet cut-out.', [{ what: 'Sticker', size: '1024x1024', format: 'PNG with transparency' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const { image } = txt2img(g, b, 'A sticker of a cute cartoon frog holding a game controller, flat vector style, thick white outline, centered, plain white background.', 1024, 1024);
        save(g, removeBg(g, image).rgba, 'decal');
        return io(g, '1024x1024, 8 steps, CFG 1, BiRefNet cut-out.', [{ what: 'Sticker', size: '1024x1024', format: 'PNG with transparency' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const { image } = txt2img(g, b, 'A sticker of a cute cartoon frog holding a game controller with the word "GG" on its shirt, flat vector style, thick white outline, centered, plain white background.', 1024, 1024);
        save(g, removeBg(g, image).rgba, 'decal');
        return io(g, '1024x1024, 4 steps (Lightning), CFG 1, BiRefNet cut-out.', [{ what: 'Sticker', size: '1024x1024', format: 'PNG with transparency' }]);
      },
    },
  },
  {
    id: 'stream-thumbnail', task: 'thumbnail', short: 'Stream thumbnail',
    title: 'Stream and video thumbnails with your avatar',
    forWhat: 'A 16:9 thumbnail: a generated background, a big title, and your avatar cut out on top.',
    output: '1280x720 PNG (YouTube and Twitch size).',
    vtp: 'Take a picture of your avatar in the studio (a clean background helps), load it as "Your avatar", run, upload the result.',
    ask: 'Set up the VTube Pro thumbnail workflow in ComfyUI',
    steps: ['Load a picture of your avatar in "Your avatar".', 'Change the theme and the title words in "Your prompt".', 'Press Run. Your avatar is cut out and placed on the right.'],
    tips: ['3-4 big words at most. Strong contrast.', 'Your avatar\'s face should be large.', 'Don\'t use other creators\' art or game key art.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a studio picture)');
        const b = sdxlBase(g, 'sdxl-base');
        const { image } = txt2img(g, b, 'youtube thumbnail background, cozy neon arcade at night, vibrant colours, high contrast, empty space on the left for a title', 1344, 768);
        const av = g.add('ImageScale', { image: avatar, upscale_method: 'lanczos', width: 0, height: 730, crop: 'disabled' }, { title: 'Avatar height' });
        const cut = removeBg(g, av.out());
        const comp = g.add('ImageCompositeMasked', { destination: image, source: av.out(), x: 760, y: 38, resize_source: false, mask: cut.fg }, { title: 'Place your avatar (x, y)', highlight: true });
        save(g, g.add('ImageScale', { image: comp.out(), upscale_method: 'lanczos', width: 1280, height: 720, crop: 'center' }, { title: 'Final size 1280x720' }).out(), 'thumbnail');
        return io(g, '1344x768 background, 28 steps, CFG 6; avatar cut out with BiRefNet; add the title in any editor.', [{ what: 'Thumbnail', size: '1280x720' }]);
      },
      medium: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a studio picture)');
        const b = zitBase(g);
        const { image } = txt2img(g, b, 'YouTube thumbnail background: a cozy neon arcade at night, vibrant colours, high contrast. Big bold title text "LATE NIGHT GAMES" on the left side.', 1280, 720);
        const av = g.add('ImageScale', { image: avatar, upscale_method: 'lanczos', width: 0, height: 690, crop: 'disabled' }, { title: 'Avatar height' });
        const cut = removeBg(g, av.out());
        const comp = g.add('ImageCompositeMasked', { destination: image, source: av.out(), x: 720, y: 30, resize_source: false, mask: cut.fg }, { title: 'Place your avatar (x, y)', highlight: true });
        save(g, comp.out(), 'thumbnail');
        return io(g, '1280x720, 8 steps, CFG 1; avatar cut out with BiRefNet.', [{ what: 'Thumbnail', size: '1280x720' }]);
      },
      large: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a studio picture)');
        const b = qiBase(g);
        const { image } = txt2img(g, b, 'YouTube thumbnail background: a cozy neon arcade at night, vibrant colours, high contrast. Big bold title text "LATE NIGHT GAMES" on the left side.', 1664, 928);
        const av = g.add('ImageScale', { image: avatar, upscale_method: 'lanczos', width: 0, height: 890, crop: 'disabled' }, { title: 'Avatar height' });
        const cut = removeBg(g, av.out());
        const comp = g.add('ImageCompositeMasked', { destination: image, source: av.out(), x: 940, y: 38, resize_source: false, mask: cut.fg }, { title: 'Place your avatar (x, y)', highlight: true });
        save(g, g.add('ImageScale', { image: comp.out(), upscale_method: 'lanczos', width: 1280, height: 720, crop: 'center' }, { title: 'Final size 1280x720' }).out(), 'thumbnail');
        return io(g, '1664x928, 4 steps (Lightning), CFG 1; avatar cut out with BiRefNet.', [{ what: 'Thumbnail', size: '1280x720' }]);
      },
    },
  },
  {
    id: 'stream-overlay', task: 'overlay', short: 'Overlays and screens',
    title: 'Overlays: Starting soon, Be right back and panels',
    forWhat: 'A full-screen "Starting soon" or "Be right back" picture, or a panel background, in your style.',
    output: '1920x1080 PNG.',
    vtp: 'Add it in OBS as an Image source, or use it as the in-room screen picture.',
    ask: 'Set up the VTube Pro overlay workflow in ComfyUI',
    steps: ['Describe the scene in "Your prompt" (medium and large can write the words).', 'Press Run.'],
    tips: ['Keep the middle calm if your avatar or a game goes there.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const b = sdxlBase(g, 'sdxl-base');
        const { image } = txt2img(g, b, 'cozy pixel art bedroom at night, soft fairy lights, rain on the window, calm empty centre, stream starting soon screen background', 1344, 768);
        save(g, upscaleTo(g, image, 1920, 1080), 'overlay');
        return io(g, '1344x768, 28 steps, CFG 6, Real-ESRGAN to 1920x1080. Add the words in any editor.', [{ what: 'Overlay', size: '1920x1080' }]);
      },
      medium: () => {
        const g = new Graph();
        const b = zitBase(g);
        const { image } = txt2img(g, b, 'Cozy pixel-art bedroom at night with soft fairy lights and rain on the window. The words "STARTING SOON" in big friendly letters at the bottom.', 1920, 1088);
        save(g, g.add('ImageCrop', { image, width: 1920, height: 1080, x: 0, y: 4 }, { title: 'Final size 1920x1080' }).out(), 'overlay');
        return io(g, '1920x1088, 8 steps, CFG 1, cropped to 1920x1080.', [{ what: 'Overlay', size: '1920x1080' }]);
      },
      large: () => {
        const g = new Graph();
        const b = qiBase(g);
        const { image } = txt2img(g, b, 'Cozy pixel-art bedroom at night with soft fairy lights and rain on the window. The words "STARTING SOON" in big friendly letters at the bottom.', 1664, 928);
        save(g, upscaleTo(g, image, 1920, 1080), 'overlay');
        return io(g, '1664x928, 4 steps (Lightning), CFG 1, Real-ESRGAN to 1920x1080.', [{ what: 'Overlay', size: '1920x1080' }]);
      },
    },
  },
  {
    id: 'chat-emotes', task: 'emote', short: 'Chat emotes',
    title: 'Chat emotes of your character',
    forWhat: 'Little expressive faces of your character for Twitch, YouTube and Discord chat.',
    output: 'Transparent PNGs: 1024 px master plus 112, 56 and 28 px (Twitch sizes).',
    vtp: 'Pose your avatar\'s face in the studio, take a picture, load it as "Your avatar". The emotes then match your model.',
    ask: 'Set up the VTube Pro emote workflow in ComfyUI',
    steps: ['Load a close-up picture of your avatar in "Your avatar".', 'Change the emotion in "Your prompt" (laughing, crying, love...).', 'Press Run. You get four sizes with see-through backgrounds.'],
    tips: ['Check the 28 px one: if you can\'t read it that small, simplify.', 'Big expressions and thick outlines survive shrinking.', 'Each platform has its own emote rules: read them before uploading.'],
    tiers: {
      small: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a face close-up)');
        const b = sdxlBase(g, 'animagine-xl-4');
        const ipm = loader(g, 'IPAdapterModelLoader', 'ipadapter_file', 'ipadapter-plus-sdxl');
        const cv = loader(g, 'CLIPVisionLoader', 'clip_name', 'clip-vision-vit-h');
        const model = g.add('IPAdapterAdvanced', { model: b.model, ipadapter: ipm.out(), image: avatar, weight: 0.75, weight_type: 'linear', combine_embeds: 'concat', start_at: 0, end_at: 1, embeds_scaling: 'V only', clip_vision: cv.out() }, { title: 'Look like your avatar' }).out();
        const { image } = txt2img(g, b, 'chibi, chat emote, 1girl, laughing, closed eyes, open mouth, thick outline, simple shading, head and shoulders, white background', 1024, 1024, undefined, model);
        emoteSizes(g, removeBg(g, image).rgba);
        return io(g, '1024x1024, 28 steps, CFG 5, IP-Adapter 0.75 from your picture, BiRefNet cut-out.', EMOTE_OUTS);
      },
      medium: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a face close-up)');
        const out = kleinEdit(g, [avatar], 'Turn this character into a chibi chat emote: laughing with closed eyes and open mouth, thick outline, simple shading, head and shoulders, plain white background.');
        emoteSizes(g, removeBg(g, out).rgba);
        return io(g, '4 steps, CFG 1, BiRefNet cut-out.', EMOTE_OUTS);
      },
      large: () => {
        const g = new Graph();
        const avatar = loadImage(g, IN_AVATAR, 'Your avatar (a face close-up)');
        const out = qieEdit(g, [avatar], 'Turn this character into a chibi chat emote: laughing with closed eyes and open mouth, thick outline, simple shading, head and shoulders, plain white background.');
        emoteSizes(g, removeBg(g, out).rgba);
        return io(g, '4 steps with the Lightning LoRA, CFG 1, BiRefNet cut-out.', EMOTE_OUTS);
      },
    },
  },
];
const EMOTE_OUTS = [
  { what: 'Emote master', size: '1024 px', format: 'PNG with transparency' as const },
  { what: 'Emote 112 px', size: '112x112', format: 'PNG with transparency' as const },
  { what: 'Emote 56 px', size: '56x56', format: 'PNG with transparency' as const },
  { what: 'Emote 28 px', size: '28x28', format: 'PNG with transparency' as const },
];
function emoteSizes(g: Graph, rgba: Link) {
  const sq = g.add('ImageScale', { image: rgba, upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'center' }, { title: 'Square 1024' });
  save(g, sq.out(), 'emote-1024', 'Save the master (1024)');
  for (const px of [112, 56, 28]) save(g, g.add('ImageScale', { image: sq.out(), upscale_method: 'area', width: px, height: px, crop: 'disabled' }, { title: `${px} px` }).out(), `emote-${px}`, `Save ${px} px`);
}

// ---------------------------------------------------------------- manifests + files
export const MANIFEST_SCHEMA = 'vtubepro.comfy-workflow/1';
export interface ManifestModel {
  id: string; name: string; file: string; folder: string; bytes: number; sha256: string; url: string; page: string;
  repo: string; revision: string; licence: string; licenceUrl: string; upstream: string;
  /** Present when the licence limits who may use the weights (see models.ts). */
  restricted?: { text: string; excluded: string[] };
}
export interface ManifestNode { id: string; name: string; folder: string; repo: string; commit: string; licence: string; pip: string[]; managerSearch: string }
export interface WorkflowManifest {
  schema: typeof MANIFEST_SCHEMA;
  id: string; tier: TierId; key: string; title: string; short: string; task: string; version: string; checked: string;
  vram: { minGB: number; recommendedGB: number; label: string };
  comfyui: { tested: string; note: string };
  models: ManifestModel[];
  customNodes: ManifestNode[];
  downloadBytes: number;
  inputs: IoSpec[]; outputs: OutSpec[]; settings: string;
  forWhat: string; output: string; vtp: string; ask: string; steps: string[]; tips: string[];
  licenceSummary: string;
  /** Plain-words licence notices the user must see before downloading (only when a model is restricted). */
  notices?: string[];
  files: { api: string; ui: string; manifest: string };
}
export interface BuiltWorkflow { manifest: WorkflowManifest; api: ApiPrompt; ui: UiWorkflow }

export const workflowKey = (id: string, tier: TierId) => `${id}/${tier}`;
export const workflowFiles = (id: string, tier: TierId) => ({ api: `${id}/${tier}.api.json`, ui: `${id}/${tier}.workflow.json`, manifest: `${id}/${tier}.manifest.json` });
export const uiFileName = (d: WorkflowDef, tier: TierId) => `VTube Pro - ${d.short} (${TIERS[tier].label}).json`.replace(/[\\/:*?"<>|]/g, '-');

const MODEL_BY_FILE = new Map(MODEL_FILES.map((m) => [`${m.folder}/${m.file}`, m]));
/** The model files a graph loads (from its loader nodes), in first-use order. */
function modelsOf(g: Graph): ModelFile[] {
  const out = new Map<string, ModelFile>();
  for (const n of g.nodes) for (const m of n.models ?? []) {
    const found = MODEL_BY_FILE.get(`${m.directory}/${m.name}`);
    if (!found) throw new Error(`model ${m.directory}/${m.name} is not in models.ts`);
    out.set(found.id, found);
  }
  return [...out.values()];
}
/** The licence notices of the restricted models in `models` (each text once). */
export const noticesOf = (models: Pick<ModelFile, 'restricted'>[]): string[] => [...new Set(models.flatMap((m) => (m.restricted ? [m.restricted.text] : [])))];
function nodesOf(g: Graph): CustomNode[] {
  const used = new Set(g.nodes.map((n) => n.type));
  return CUSTOM_NODES.filter((c) => c.classes.some((k) => used.has(k)));
}

function startNote(d: WorkflowDef, tier: TierId, models: ModelFile[], nodes: CustomNode[], b: Built): string {
  const t = TIERS[tier];
  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
  return [
    `# ${d.title}`,
    `**VTube Pro workflow, ${t.label} graphics card** (${d.family?.[tier] ?? t.family}). Pack ${WORKFLOW_PACK_VERSION}.`,
    '',
    d.forWhat,
    '',
    '## How to use it',
    ...d.steps.map((s, i) => `${i + 1}. ${s}`),
    `${d.steps.length + 1}. Find the result in ComfyUI's **output/VTubePro** folder (or right-click the picture > Save Image).`,
    '',
    'The **green boxes** are the ones to change.',
    '',
    `**You get:** ${d.output}`,
    '',
    `**In VTube Pro:** ${d.vtp}`,
    '',
    `**Settings:** ${b.settings}`,
    '',
    models.some((m) => m.restricted) ? '## Models (read the licence note first)' : '## Models (all allow commercial use)',
    ...models.map((m) => `- [${m.file}](${modelPage(m)}) (${gb(m.bytes)}) in \`models/${m.folder}\`: ${m.licence}`),
    ...noticesOf(models).flatMap((n) => ['', `**${n}**`]),
    ...(nodes.length ? ['', '## Custom node', ...nodes.map((n) => `- [${n.name}](${n.repo}) at commit \`${n.commit.slice(0, 10)}\` (${n.licence}). Install it with ComfyUI Manager ("Install Missing Custom Nodes"), then restart ComfyUI.`)] : []),
    '',
    'Missing a model? ComfyUI offers to download it when you open this workflow. Or ask your AI: ',
    `*"${d.ask}"*: VTube Pro downloads every file from its official page, checks it, and adds this workflow, after you say yes.`,
    '',
    '## Tips',
    ...d.tips.map((s) => `- ${s}`),
    '- Make pictures when you are not live: picture AI slows face tracking.',
  ].join('\n');
}

/** One line of licence facts. A restricted model is named first and never described as commercial-OK. */
function licenceSummary(models: ModelFile[], nodes: CustomNode[]): string {
  const names = (l: ModelFile[]) => [...new Set(l.map((m) => m.licence.split(' (')[0]))].join(', ');
  const free = models.filter((m) => !m.restricted);
  const limited = models.filter((m) => m.restricted);
  return [
    limited.length ? `Check the licence first. ${noticesOf(limited).join(' ')}` : '',
    free.length ? `${limited.length ? 'The other models: commercial' : 'Commercial'} use OK by default: ${names(free)}.` : '',
    nodes.length ? `Custom node code: ${nodes.map((n) => `${n.name} (${n.licence.split(' (')[0]})`).join(', ')}.` : '',
  ].filter(Boolean).join(' ');
}

/** Build one workflow (graph + both files + manifest). `schema` = the pinned node schema (nodeSchema.json). */
export function buildWorkflow(d: WorkflowDef, tier: TierId, schema: NodeSchema): BuiltWorkflow {
  const make = d.tiers[tier];
  if (!make) throw new Error(`${d.id} has no ${tier} tier`);
  const b = make();
  const g = normalize(b.graph, schema);
  const models = modelsOf(g);
  const nodes = nodesOf(g);
  g.note('Start here', startNote(d, tier, models, nodes, b));
  const files = workflowFiles(d.id, tier);
  const manifest: WorkflowManifest = {
    schema: MANIFEST_SCHEMA, id: d.id, tier, key: workflowKey(d.id, tier), title: d.title, short: d.short, task: d.task,
    version: WORKFLOW_PACK_VERSION, checked: '2026-10-01',
    vram: { minGB: TIERS[tier].minVramGB, recommendedGB: TIERS[tier].recVramGB, label: TIERS[tier].label },
    comfyui: { tested: TESTED_COMFYUI, note: 'Uses only built-in ComfyUI nodes (plus the custom node listed, if any). Update ComfyUI if a node shows red.' },
    models: models.map((m) => ({ id: m.id, name: m.name, file: m.file, folder: m.folder, bytes: m.bytes, sha256: m.sha256, url: modelUrl(m), page: modelPage(m), repo: m.repo, revision: m.revision, licence: m.licence, licenceUrl: m.licenceUrl, upstream: m.upstream, ...(m.restricted ? { restricted: m.restricted } : {}) })),
    customNodes: nodes.map((n) => ({ id: n.id, name: n.name, folder: n.folder, repo: n.repo, commit: n.commit, licence: n.licence, pip: n.pip, managerSearch: n.managerSearch })),
    downloadBytes: models.reduce((s, m) => s + m.bytes, 0),
    inputs: b.inputs, outputs: b.outputs, settings: b.settings,
    forWhat: d.forWhat, output: d.output, vtp: d.vtp, ask: d.ask, steps: d.steps, tips: d.tips,
    licenceSummary: licenceSummary(models, nodes),
    ...(noticesOf(models).length ? { notices: noticesOf(models) } : {}),
    files,
  };
  const api = toApi(g, schema);
  const ui = toUi(g, schema, { vtubePro: { workflow: d.id, tier, version: WORKFLOW_PACK_VERSION, manifest: files.manifest } });
  return { manifest, api, ui };
}

/** Every (workflow, tier) pair. */
export function allKeys(): { def: WorkflowDef; tier: TierId }[] {
  return WORKFLOW_DEFS.flatMap((def) => TIER_IDS.filter((t) => def.tiers[t]).map((tier) => ({ def, tier })));
}
export const workflowDef = (id: string) => WORKFLOW_DEFS.find((d) => d.id === id || d.task === id);

/** The index file (public/comfy-workflows/index.json). */
export function buildIndex(schema: NodeSchema) {
  return {
    schema: 'vtubepro.comfy-workflow-index/1', version: WORKFLOW_PACK_VERSION, checked: '2026-10-01', testedComfyUI: TESTED_COMFYUI,
    tiers: TIERS,
    workflows: WORKFLOW_DEFS.map((d) => ({
      id: d.id, task: d.task, title: d.title, short: d.short, forWhat: d.forWhat, ask: d.ask,
      tiers: TIER_IDS.filter((t) => d.tiers[t]).map((t) => {
        const m = buildWorkflow(d, t, schema).manifest;
        return { tier: t, label: TIERS[t].label, downloadBytes: m.downloadBytes, models: m.models.map((x) => x.file), customNodes: m.customNodes.map((x) => x.name), ...(m.notices ? { notices: m.notices } : {}), files: m.files };
      }),
    })),
  };
}
