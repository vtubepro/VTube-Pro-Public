// The optional ML pack for the 3D auto-rig: SkinTokens / TokenRig and UniRig (VAST AI Research / Tsinghua). A helper GPU job
// that turns a mesh into a skeleton + skin weights with a learned model, for the cases the tap-driven templates cannot do
// (odd creatures, many limbs). Nothing here is bundled: the pack installs only when the person asks for it
// (tools/gpu/rigml_setup.ts), every file is pinned to a commit / revision with a sha256, and the first-use notice below must be
// accepted before anything is fetched. Nothing in this repo downloads a model on its own.
//
// Facts checked 2026-10-23 at the sources (Hugging Face model cards + API, the GitHub repos at the pinned commits):
//   SkinTokens  code MIT (repo licence file); weights MIT (HF card); needs an NVIDIA GPU with >= 14 GB (README + card)
//   UniRig      code MIT; weights MIT (HF card); >= 8 GB (HF card)
//   Qwen3-0.6B  Apache-2.0 (HF card + LICENSE file): SkinTokens reads only its config + tokenizer files, never its weights
//   Training data: SkinTokens = ArticulationXL 2.0 (70 %), VRoid Hub (20 %), ModelsResource (10 %); UniRig checkpoint =
//                  Articulation-XL2.0 (CC-BY-4.0 index of Objaverse(-XL) assets, whose own licences are mixed)
//   Facts worth stating (owner decision 2026-10-24: both models are offered to every user, on their click; these are the
//   first-use note's contents, not blocks):
//     * both repos vendor the Michelangelo shape encoder (src/model/michelangelo) whose upstream licence is GPL-3.0
//       (UniRig even ships that GPL text in the folder) inside an MIT repo: it stays in the pack's own folder / process
//     * UniRig's config reads `facebook/opt-350m` (config only, no weights), which is under Meta's OPT licence; the pack
//       fetches that small file itself on the user's PC
//     * both need the `bpy` pip wheel (Blender as a Python module, GPL) in their own virtual environment
//     * the training data above derives from Objaverse(-XL) and VRoid Hub models, which carry their own terms
//   Make-It-Animatable stays OUT: trained on Mixamo characters (house rule: no Mixamo).
// The pack runs as its own process in its own virtual environment; nothing from it is imported, linked or bundled into
// VTube Pro. The helper only passes it a mesh file and reads back a rigged file.

export type RigMlModel = 'skintokens' | 'unirig';

export interface PackFile {
  /** Path inside the pack folder. */
  path: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface RigMlSpec {
  id: RigMlModel;
  label: string;
  /** Smallest NVIDIA GPU memory the authors state, GiB. */
  minVramGB: number;
  /** Rough disk need with its Python environment, GB. */
  diskGB: number;
  code: { repo: string; commit: string; license: 'MIT'; url: string; sha256: string; bytes: number; entry: string };
  hf: { repo: string; revision: string };
  files: PackFile[];
  /** Short factual notes shown with the model (ids into NOTE_TEXT); they inform, they never block. */
  notes: string[];
  /** Plain-words summary for the install card. */
  summary: string;
}

const HF = 'https://huggingface.co';
const GH = 'https://codeload.' + 'git' + 'hub.com';
const QWEN_REV = 'c1899de289a04d12100db370d81485cdf75e47ca';
const qwen = (name: string, sha256: string, bytes: number): PackFile => ({ path: `models/Qwen3-0.6B/${name}`, url: `${HF}/Qwen/Qwen3-0.6B/resolve/${QWEN_REV}/${name}`, sha256, bytes });
const ST_REV = '79736cad0fd84de384d5eede659b4ebd24effe33';
const UR_REV = '36842e2b5947e9e60f89275b83208c8e74071c63';

export const RIG_ML: Readonly<Record<RigMlModel, RigMlSpec>> = {
  skintokens: {
    id: 'skintokens',
    label: 'Smart skeleton (SkinTokens)',
    minVramGB: 14,
    diskGB: 9,
    code: { repo: 'VAST-AI-Research/SkinTokens', commit: '273b691d35989d71cd17ff2895fdc735097b92d1', license: 'MIT', url: `${GH}/VAST-AI-Research/SkinTokens/zip/273b691d35989d71cd17ff2895fdc735097b92d1`, sha256: '528123c3447041e20762f90a743ecb30e1744c7818c28f49cb8f5ff70477be3c', bytes: 13711030, entry: 'demo.py' },
    hf: { repo: 'VAST-AI/SkinTokens', revision: ST_REV },
    files: [
      { path: 'experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt', url: `${HF}/VAST-AI/SkinTokens/resolve/${ST_REV}/experiments/articulation_xl_quantization_256_token_4/grpo_1400.ckpt`, sha256: 'f4e4706a11cfb520cdde65156a0358545e4fbf8f36237aca01ea5e79d5cb5692', bytes: 1131603979 },
      { path: 'experiments/skin_vae_2_10_32768/last.ckpt', url: `${HF}/VAST-AI/SkinTokens/resolve/${ST_REV}/experiments/skin_vae_2_10_32768/last.ckpt`, sha256: '4843f49e58afff88345806b94ca82e6cc9d8def6e7432e2853c677b154de0ed4', bytes: 487311745 },
      qwen('config.json', '660db3b73d788119c04535e48cf9be5f55bc3100841a718637ae695b442f27dd', 726),
      qwen('generation_config.json', '2325da0f15bb848e018c5ae071b7943332e9f871d6b60e2ed22ca97d4cb993d2', 239),
      qwen('tokenizer_config.json', 'd5d09f07b48c3086c508b30d1c9114bd1189145b74e982a265350c923acd8101', 9732),
      qwen('vocab.json', 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910', 2776833),
      qwen('merges.txt', '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5', 1671853),
      qwen('tokenizer.json', 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4', 11422654),
      qwen('LICENSE', '832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e', 11343),
    ],
    notes: ['gpl-shape-encoder', 'training-data'],
    summary: 'The best quality: skeleton and skin weights in one pass. Needs a graphics card with 14 GB or more.',
  },
  unirig: {
    id: 'unirig',
    label: 'Smart skeleton, smaller card (UniRig)',
    minVramGB: 8,
    diskGB: 12,
    code: { repo: 'VAST-AI-Research/UniRig', commit: '6793c6640ff01c8fb389f3993434124bb43d2933', license: 'MIT', url: `${GH}/VAST-AI-Research/UniRig/zip/6793c6640ff01c8fb389f3993434124bb43d2933`, sha256: 'a8a59be5b7afa9be2da47fc0ac01423c9288cbb1f614eb63a2343d798a569ba3', bytes: 22897461, entry: 'run.py' },
    hf: { repo: 'VAST-AI/UniRig', revision: UR_REV },
    files: [
      // (the rignet checkpoint is left out on purpose: trained on the RigNet / ModelsResource data set)
      { path: 'skeleton/articulation-xl_quantization_256/model.ckpt', url: `${HF}/VAST-AI/UniRig/resolve/${UR_REV}/skeleton/articulation-xl_quantization_256/model.ckpt`, sha256: 'd8cf9b42d56e7bc316d293597ecf8c4c39a8631cdd44a261ecf388242fabd0f4', bytes: 1439617174 },
      { path: 'skin/articulation-xl/model.ckpt', url: `${HF}/VAST-AI/UniRig/resolve/${UR_REV}/skin/articulation-xl/model.ckpt`, sha256: '9d40cf42fb9d4c10d8b373d9f4f557c6fbbc5ebacae7ae6b3dce5a0d8a18bc33', bytes: 4375464854 },
    ],
    notes: ['gpl-shape-encoder', 'training-data', 'opt-config'],
    summary: 'Works on smaller graphics cards (8 GB or more). Skeleton first, then skin weights.',
  },
};

export const RIG_ML_MODELS: readonly RigMlModel[] = ['skintokens', 'unirig'];

/** The factual notes, in plain words. */
export const NOTE_TEXT: Readonly<Record<string, string>> = {
  'gpl-shape-encoder': 'Its code folder includes a shape-reading part licensed GPL-3.0 (Michelangelo) inside an MIT project; it stays in the add-on’s own folder and process.',
  'training-data': 'It learned from public 3D collections (Objaverse and VRoid Hub models) whose items carry their own licences.',
  'opt-config': 'It reads a small settings file from Meta’s OPT-350m, which is under Meta’s OPT licence; the add-on fetches it on your PC.',
};

/** Shown before the first install and again (shorter) before each run; the person must accept it. Bump the version when it changes. */
export const RIG_ML_NOTICE_VERSION = 2;
export const RIG_ML_NOTICE: readonly string[] = [
  'This is an optional add-on that downloads a few GB from Hugging Face and GitHub, only now that you asked. VTube Pro never includes it.',
  'It runs on your graphics card as a separate program. Your model file never leaves this PC.',
  'The AI learned from public 3D collections (Objaverse and VRoid Hub models). Those items have many different licences, and the makers published the trained files under the MIT licence.',
  'UniRig also reads a small settings file from Meta’s OPT-350m, which is under Meta’s OPT licence. You download it; it is not part of VTube Pro.',
  'Parts of its code carry other licences (one shape-reading part is GPL-3.0). It stays inside its own folder and is not linked into VTube Pro.',
  'The result is only a starting skeleton. Check the shoulders, hips and fingers before you stream with it.',
];

// ---------------------------------------------------------------- graphics-memory tiers (owner decision 2026-10-24)
//   normal     the card meets the authors' figure (SkinTokens 14 GB, UniRig 8 GB): the model runs as its README says
//   staged     between the staged floor and that figure: a LOW-MEMORY STAGED MODE that works by itself (no question asked):
//                a decimated copy ("proxy") of the mesh is rigged, one model step per process so the card is emptied between steps,
//                with the real knobs the pinned repos expose (UniRig: --faces_target_count, num_beams, num_train_vertex; SkinTokens:
//                --num_beams), then the skin weights are transferred to the full mesh (blender/weight_transfer.py)
//   templates  below the floor, or no NVIDIA card: the no-AI Blender skeleton (blender/autorig.py) rigs the model instead
// The staged floors are estimates (UNVERIFIED on real models: nothing is downloaded or run here); the figures below are ours.
export type RigTier = 'normal' | 'staged' | 'templates';

/** Smallest card the staged mode is offered on, GB (SkinTokens is one big unified step, so its floor is higher). */
export const STAGED_FLOOR_GB: Readonly<Record<RigMlModel, number>> = { skintokens: 6, unirig: 4 };

/** Proxy size and low-memory knobs by graphics memory (GB). Retry = the "smaller proxy" of an out-of-memory second attempt. */
export const STAGED_TIERS: readonly { minGB: number; proxyFaces: number; beams: number; skinChunk: number }[] = [
  { minGB: 6, proxyFaces: 20000, beams: 5, skinChunk: 256 },
  { minGB: 0, proxyFaces: 10000, beams: 3, skinChunk: 128 },
];
export const MIN_PROXY_FACES = 4000;
export const RETRY_KNOBS = { beams: 2, skinChunk: 64 } as const;

export interface VramVerdict { ok: boolean; tier: RigTier; usable: boolean; need: number; floor: number; have: number; why: string; minutes: number | null }

const SHORT_NAME: Record<RigMlModel, string> = { skintokens: 'SkinTokens', unirig: 'UniRig' };
const BLENDER_TEXT = 'VTube Pro uses its no-AI Blender skeleton instead, which works on any PC.';

/** About how long a staged run takes on this card (an estimate: the model steps reload one at a time). */
export function stagedMinutes(model: RigMlModel, haveGB: number): number {
  return Math.min(30, Math.max(8, Math.round(6 + (RIG_ML[model].minVramGB - haveGB) * 2)));
}

/** nvidia-smi reports MiB: a "14 GB" card shows 14 * 1024. Zero means no NVIDIA GPU was found. */
export function vramVerdict(model: RigMlModel, vramMB: number): VramVerdict {
  const need = RIG_ML[model].minVramGB, floor = STAGED_FLOOR_GB[model], have = Math.round((vramMB / 1024) * 10) / 10, name = SHORT_NAME[model];
  const base = { need, floor, have };
  if (!vramMB) return { ...base, have: 0, ok: false, tier: 'templates', usable: false, minutes: null, why: `No NVIDIA graphics card was found, and this add-on runs on NVIDIA’s CUDA. ${BLENDER_TEXT}` };
  if (vramMB >= need * 1024 - 64) return { ...base, ok: true, tier: 'normal', usable: true, minutes: null, why: '' };
  if (vramMB >= floor * 1024 - 64) {
    const minutes = stagedMinutes(model, have);
    return { ...base, ok: false, tier: 'staged', usable: true, minutes, why: `This will take longer on your card (about ${minutes} min): ${name} wants ${need} GB of graphics memory and yours has ${have} GB, so it runs in a low-memory staged mode (a smaller copy of your model, one step at a time).` };
  }
  return { ...base, ok: false, tier: 'templates', usable: false, minutes: null, why: `${name} needs a graphics card with at least ${floor} GB (${need} GB for full speed); yours has ${have} GB. ${BLENDER_TEXT}` };
}

/** The best model this card runs at full speed: SkinTokens when it fits, else UniRig, else null. */
export function pickModel(vramMB: number, opts: { prefer?: RigMlModel } = {}): RigMlModel | null {
  const order: RigMlModel[] = opts.prefer ? [opts.prefer, ...RIG_ML_MODELS.filter((m) => m !== opts.prefer)] : ['skintokens', 'unirig'];
  for (const m of order) if (vramVerdict(m, vramMB).ok) return m;
  return null;
}

/** The model to suggest: the best that fits at full speed, else UniRig in staged mode (it has the lowest floor), else null (templates). */
export function suggestModel(vramMB: number): RigMlModel | null {
  return pickModel(vramMB) ?? (vramVerdict('unirig', vramMB).usable ? 'unirig' : null);
}

export interface RigPlan {
  mode: RigTier;
  model: RigMlModel | null;
  /** Staged only: the decimated copy's face count, the smaller one for the automatic out-of-memory retry, and the knobs. */
  proxyFaces: number | null;
  retryFaces: number | null;
  beams: number | null;
  skinChunk: number | null;
  minutes: number | null;
  message: string;
}

/** Which way to rig on this card: the tier table in one place (tools/rigml_unit.ts tests it). `prefer` = a model the person picked. */
export function rigPlan(vramMB: number, opts: { prefer?: RigMlModel } = {}): RigPlan {
  const none = { proxyFaces: null, retryFaces: null, beams: null, skinChunk: null, minutes: null };
  const model = opts.prefer ?? suggestModel(vramMB);
  if (!model) return { mode: 'templates', model: null, ...none, message: vramVerdict('unirig', vramMB).why };
  const v = vramVerdict(model, vramMB);
  if (v.tier === 'normal') return { mode: 'normal', model, ...none, message: '' };
  if (v.tier === 'templates') return { mode: 'templates', model: null, ...none, message: v.why };
  const t = STAGED_TIERS.find((x) => v.have >= x.minGB) ?? STAGED_TIERS[STAGED_TIERS.length - 1];
  return { mode: 'staged', model, proxyFaces: t.proxyFaces, retryFaces: Math.max(MIN_PROXY_FACES, Math.floor(t.proxyFaces / 2)), beams: t.beams, skinChunk: t.skinChunk, minutes: v.minutes, message: v.why };
}

/** The plain message for a job that ran out of graphics memory: what happened and what would work. */
export function outOfMemoryText(model: RigMlModel, haveGB: number | null): string {
  const card = haveGB ? ` (this card has ${haveGB} GB)` : '';
  const need = RIG_ML[model].minVramGB;
  if (model === 'skintokens') return `SkinTokens ran out of graphics memory${card}; it wants ${need} GB. UniRig needs only ${RIG_ML.unirig.minVramGB} GB and is the better choice on a smaller card, or use “Skeleton for anything” (Blender), which needs no graphics memory.`;
  return `UniRig ran out of graphics memory${card}; it wants ${need} GB. Close other programs that use the graphics card (games, OBS scenes, browsers) and try again, or use “Skeleton for anything” (Blender), which needs no graphics memory.`;
}

export const packBytes = (m: RigMlModel) => RIG_ML[m].files.reduce((s, f) => s + f.bytes, 0) + RIG_ML[m].code.bytes;

/** True when `p` is a safe relative path inside the pack (no .., no absolute, no drive letters). */
export const safePackPath = (p: string) => !!p && !/^([/\\]|[a-z]:)/i.test(p) && !p.split(/[\\/]/).some((s) => s === '..' || s === '');
