// One-click setup for the local voice features (docs/LIVE_CAPTIONS.md), on the user's demand only. Same shape as
// tools/gpu/gpu_setup.ts: pinned versions, sha256 on every download, idempotent steps, a dry run, progress callbacks.
//
//   npx tsx tools/voice/voice_setup.ts [--parts runtime,captions,kokoro,gpu] [--model base.en] [--dir <folder>] [--dry-run] [--json]
//   npx tsx tools/voice/voice_setup.ts --uninstall [--dir <folder>]        --status [--dir <folder>]
//   npx tsx tools/voice/voice_setup.ts --verify-pins      (network: do the pinned versions / files still exist and match?)
//
//   runtime   <dir>\venv: Python 3.12 (via Astral's uv, sha256-checked) + onnxruntime (CPU) + numpy + websockets
//   captions  faster-whisper 1.2.1 (MIT) installed WITHOUT its dependency PyAV (PyAV's wheels bundle a GPL FFmpeg: the
//             sidecar passes arrays, never files, see whisper_sidecar.py) + ctranslate2 4.8.3 (MIT) + tokenizers; and one
//             Whisper model in CTranslate2 format (OpenAI Whisper weights are MIT, converted by Systran), CPU int8 by default
//   kokoro    Kokoro-82M v1.0 int8 ONNX (Apache-2.0 weights) + 8 US-English voices + misaki's two pronunciation dictionaries
//             (misaki is Apache-2.0; only its JSON data is unpacked, the package and its espeak-ng / phonemizer GPL
//             dependencies are never installed)
//   gpu       optional: NVIDIA cuBLAS + cuDNN pip wheels so CTranslate2 can use the GPU (NVIDIA's own licence; fetched from
//             PyPI on the user's machine, never bundled). Without it, or if CUDA fails to load, captions run on the CPU.
//
// Nothing here runs unless the user asks (the Captions / Alert voice cards in the studio, or this command). Default folder:
// <repo>\.voice (VTP_VOICE_DIR overrides), next to .gpu. The models are downloaded from huggingface.co at a pinned
// commit and refused unless their sha256 matches.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The VTube Pro folder: the nearest folder upwards whose package.json is "vtube-pro" (bundled helper = one level deep).
function findRepo(start: string): string {
  for (let d = start, i = 0; i < 5; i++) {
    try { if (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'vtube-pro') return d; } catch { /* keep looking */ }
    const up = path.dirname(d); if (up === d) break; d = up;
  }
  return path.resolve(start, '..', '..');
}
export const REPO = findRepo(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIR = process.env.VTP_VOICE_DIR || path.join(REPO, '.voice');

export type Part = 'runtime' | 'captions' | 'kokoro' | 'gpu';
export const ALL_PARTS: Part[] = ['runtime', 'captions', 'kokoro'];
export interface Progress { step: string; state: 'run' | 'ok' | 'skip' | 'warn' | 'error' | 'info'; msg: string; pct?: number }
export interface SetupOpts { dir?: string; parts?: Part[]; model?: WhisperModelId; dryRun?: boolean; onProgress?: (p: Progress) => void; signal?: AbortSignal }

// ---------------------------------------------------------------- pins
const UV_VER = '0.12.19';
export const UV_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VER}/uv-x86_64-pc-windows-msvc.zip`;
// Every package is pinned to ONE version (a floating dependency could change under a user between two installs, or break the
// install after GBs were downloaded). The extra pins were chosen WITHOUT network access from versions seen working here:
// numpy 2.5.3 next to onnxruntime 1.30.0 (the .gpu environment), huggingface-hub 1.24.0 / tqdm 4.69.0 / pyyaml 6.0.3 / websockets 16.1.1
// (installed on this PC), and the CUDA 12 pair cuBLAS 12.8.4.1 + cuDNN 9.10.2.21 (the pair PyTorch 2.8's CUDA 12.8 wheels pin: CTranslate2 4.x
// wants CUDA 12 + cuDNN 9, and cuBLAS 12.8 is the first with RTX 50 kernels). `--verify-pins` (network) re-checks that every one still exists.
export const RUNTIME_PKGS = ['onnxruntime==1.30.0', 'numpy==2.5.3', 'websockets==16.1.1'];
export const CAPTION_PKGS = ['ctranslate2==4.8.3', 'tokenizers==0.23.3', 'huggingface-hub==1.24.0', 'tqdm==4.69.0', 'pyyaml==6.0.3'];
export const FASTER_WHISPER = 'faster-whisper==1.2.1';
export const GPU_PKGS = ['nvidia-cublas-cu12==12.8.4.1', 'nvidia-cudnn-cu12==9.10.2.21'];

/** A file we leave in the voice folder: uninstall only ever deletes a folder that carries it (or looks exactly like one of ours). */
export const VOICE_MARKER = '.vtube-pro-voice';
/** What an install made before the marker existed holds (and nothing else). */
const OWN_ENTRIES = new Set(['venv', 'python', 'uv', 'uv-cache', 'downloads', 'models', VOICE_MARKER]);

export interface PinFile { name: string; sha256: string; bytes: number }
export interface WhisperModel { id: WhisperModelId; repo: string; rev: string; label: string; langs: string; mb: number; files: PinFile[]; note: string }
export type WhisperModelId = 'tiny.en' | 'base.en' | 'small.en' | 'small';
const F = (name: string, bytes: number, sha256: string): PinFile => ({ name, bytes, sha256 });
const TOK_EN = F('tokenizer.json', 2128466, '929c5252409436dce1b38a75d1abbcb5e132d170d8e324e4e04ed915fa2d22df');
const VOC_EN = F('vocabulary.txt', 422309, 'ff77588746d3a2595d32ab5b69ffd7b95ce2441ac57533cb66fc3eb575a115cf');
export const WHISPER_MODELS: Record<WhisperModelId, WhisperModel> = {
  'tiny.en': { id: 'tiny.en', repo: 'Systran/faster-whisper-tiny.en', rev: '0d3d19a32d3338f10357c0889762bd8d64bbdeba', label: 'Tiny (English)', langs: 'English', mb: 76, note: 'fastest, roughest: for weak PCs',
    files: [F('config.json', 2317, '14b1b421a90349bc551b881461426b561a874049cb9e4c4864f2ca384f6a7cc5'), F('model.bin', 75537502, '1a5afae06a4db91c975c9a9d78be5cc110ee4ea022ad57d55492e4550e936b2a'), TOK_EN, VOC_EN] },
  'base.en': { id: 'base.en', repo: 'Systran/faster-whisper-base.en', rev: '3d3d5dee26484f91867d81cb899cfcf72b96be6c', label: 'Base (English)', langs: 'English', mb: 145, note: 'the default: good on a mid-range CPU',
    files: [F('config.json', 2227, 'f3bc3821e9fc76a27bae538e11ae5b677dcdd352b4600429ce7951d398569aeb'), F('model.bin', 145216508, '2a166925539a16005f14ff328359f9b9adb9dc4fb631bb3b227526862e93e2ef'), TOK_EN, VOC_EN] },
  'small.en': { id: 'small.en', repo: 'Systran/faster-whisper-small.en', rev: 'd1d751a5f8271d482d14ca55d9e2deeebbae577f', label: 'Small (English)', langs: 'English', mb: 484, note: 'more accurate: wants a GPU or a fast CPU',
    files: [F('config.json', 2657, '666a9605530ac1f61fa8177f3702b4dacec9966749e42610839fcc32661d5fae'), F('model.bin', 483545366, '62b2a45b05ee59acb4a5341b33ee35e041395d378d418a18acfe4c9e768ee37a'), TOK_EN, VOC_EN] },
  'small': { id: 'small', repo: 'Systran/faster-whisper-small', rev: '536b0662742c02347bc0e980a01041f333bce120', label: 'Small (many languages)', langs: '99 languages', mb: 484, note: 'other languages; wants a GPU or a fast CPU',
    files: [F('config.json', 2370, 'b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828'), F('model.bin', 483546902, '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671'), F('tokenizer.json', 2203239, 'fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab'), F('vocabulary.txt', 459861, '34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913')] },
};
export const DEFAULT_MODEL: WhisperModelId = 'base.en';

export const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_REV = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_FILES: PinFile[] = [
  F('onnx/model_quantized.onnx', 92361116, 'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'),
  F('tokenizer.json', 3497, '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34'),
];
export const KOKORO_VOICES: Record<string, { label: string; file: PinFile }> = {
  af_heart: { label: 'Heart (US, female)', file: F('voices/af_heart.bin', 522240, 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b') },
  af_bella: { label: 'Bella (US, female)', file: F('voices/af_bella.bin', 522240, 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b') },
  af_nicole: { label: 'Nicole (US, female)', file: F('voices/af_nicole.bin', 522240, 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a') },
  af_sarah: { label: 'Sarah (US, female)', file: F('voices/af_sarah.bin', 522240, '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a') },
  af_sky: { label: 'Sky (US, female)', file: F('voices/af_sky.bin', 522240, '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9') },
  am_adam: { label: 'Adam (US, male)', file: F('voices/am_adam.bin', 522240, '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716') },
  am_michael: { label: 'Michael (US, male)', file: F('voices/am_michael.bin', 522240, '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1') },
  am_puck: { label: 'Puck (US, male)', file: F('voices/am_puck.bin', 522240, 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0') },
};
export const MISAKI_WHEEL = { url: 'https://files.pythonhosted.org/packages/82/ec/0ee4110ddb54278b8f21c40a140370ae8f687036c4edf578316602697c56/misaki-0.9.4-py3-none-any.whl', sha256: '90e2eeb169786c014c429e5058d2ea6bcd02d651f2a24450ba6c9ffc0f8da15a', bytes: 0, members: ['misaki/data/us_gold.json', 'misaki/data/us_silver.json'] };

export const SIZES_MB = { runtime: 330, captionsPkgs: 90, kokoro: 92 + 4 + 8 * 0.5 + 6, gpu: 1500 };
export const MINUTES: Record<Part, string> = { runtime: '2–5', captions: '1–4', kokoro: '1–3', gpu: '3–8' };

export const paths = (dir = DEFAULT_DIR) => ({
  dir, venv: path.join(dir, 'venv'), python: path.join(dir, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), uvDir: path.join(dir, 'uv'),
  downloads: path.join(dir, 'downloads'), models: path.join(dir, 'models'),
  whisper: (id: string) => path.join(dir, 'models', 'whisper', id),
  kokoro: path.join(dir, 'models', 'kokoro'),
});

// ---------------------------------------------------------------- helpers
export const sh = (cmd: string, args: string[], opt: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}) =>
  new Promise<{ code: number; out: string }>((res) => {
    const p = spawn(cmd, args, { cwd: opt.cwd, env: opt.env ?? process.env, windowsHide: true });
    let out = '';
    const keep = (b: Buffer) => { out += b.toString('utf8').replace(/\0/g, ''); if (out.length > 20000) out = out.slice(-20000); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    const to = opt.timeout ? setTimeout(() => p.kill(), opt.timeout) : null;
    p.on('error', (e) => { if (to) clearTimeout(to); res({ code: -1, out: String(e) }); });
    p.on('close', (code) => { if (to) clearTimeout(to); res({ code: code ?? -1, out }); });
  });

export async function sha256(file: string) {
  const h = crypto.createHash('sha256');
  await new Promise<void>((res, rej) => fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => res()).on('error', rej));
  return h.digest('hex');
}

/** Download `url` to `dst`, refusing anything whose sha256 is not `sha` (the .part file is deleted). 'cached' when already right. */
export async function download(url: string, dst: string, sha: string | null, p: (pct: number, mb: number) => void, signal?: AbortSignal): Promise<'cached' | 'downloaded'> {
  if (fs.existsSync(dst) && sha && (await sha256(dst)) === sha) return 'cached';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const r = await fetch(url, { redirect: 'follow', signal });
  if (!r.ok || !r.body) throw new Error(`download failed (${r.status}) ${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = dst + '.part', out = fs.createWriteStream(tmp), h = crypto.createHash('sha256');
  let got = 0, last = 0;
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      h.update(chunk); got += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 400) { last = Date.now(); p(total ? got / total : 0, got / 1e6); }
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
  } catch (e) { out.destroy(); fs.rmSync(tmp, { force: true }); throw e; }
  const got256 = h.digest('hex');
  if (sha && got256 !== sha) { fs.rmSync(tmp, { force: true }); throw new Error(`checksum mismatch for ${path.basename(dst)}: the download was damaged or changed; try again`); }
  fs.renameSync(tmp, dst);
  return 'downloaded';
}

/** A pinned file from huggingface.co at a fixed commit. */
export const hfUrl = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

// ---------------------------------------------------------------- what is installed
export interface VoiceInspect {
  dir: string; runtime: boolean; captionsPkgs: boolean; gpuPkgs: boolean;
  models: WhisperModelId[]; kokoro: boolean; kokoroVoices: string[];
}
const fileOk = (f: string, bytes: number) => { try { return fs.statSync(f).size === bytes; } catch { return false; } };
/** <venv>/Lib/site-packages (Windows) or <venv>/lib/python3.x/site-packages. */
export function sitePackages(venv: string): string {
  if (process.platform === 'win32') return path.join(venv, 'Lib', 'site-packages');
  try { const py = fs.readdirSync(path.join(venv, 'lib')).find((e) => /^python3/.test(e)); return path.join(venv, 'lib', py ?? 'python3.12', 'site-packages'); } catch { return path.join(venv, 'lib', 'python3.12', 'site-packages'); }
}
export function inspect(dir = DEFAULT_DIR): VoiceInspect {
  const P = paths(dir);
  const site = sitePackages(P.venv);
  const has = (name: string) => { try { return fs.readdirSync(site).some((e) => e.toLowerCase().replace(/-/g, '_').startsWith(name)); } catch { return false; } };
  const models = (Object.keys(WHISPER_MODELS) as WhisperModelId[]).filter((id) => WHISPER_MODELS[id].files.every((f) => fileOk(path.join(P.whisper(id), f.name), f.bytes)));
  const kokoroBase = KOKORO_FILES.every((f) => fileOk(path.join(P.kokoro, f.name), f.bytes)) && fs.existsSync(path.join(P.kokoro, 'misaki', 'us_gold.json')) && fs.existsSync(path.join(P.kokoro, 'misaki', 'us_silver.json'));
  const voices = Object.keys(KOKORO_VOICES).filter((v) => fileOk(path.join(P.kokoro, KOKORO_VOICES[v].file.name), KOKORO_VOICES[v].file.bytes));
  return {
    dir, runtime: fs.existsSync(P.python), captionsPkgs: has('faster_whisper') && has('ctranslate2'), gpuPkgs: has('nvidia_cudnn') && has('nvidia_cublas'),
    models, kokoro: kokoroBase && voices.length > 0, kokoroVoices: kokoroBase ? voices : [],
  };
}

async function findUv(P: ReturnType<typeof paths>) {
  const local = path.join(P.uvDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
  if (fs.existsSync(local)) return local;
  const r = await sh('uv', ['--version']);
  return r.code === 0 ? 'uv' : null;
}

// ---------------------------------------------------------------- the setup
export async function runSetup(o: SetupOpts = {}): Promise<boolean> {
  const P = paths(o.dir ?? DEFAULT_DIR), parts = o.parts ?? ALL_PARTS, dry = !!o.dryRun;
  const modelId: WhisperModelId = o.model && WHISPER_MODELS[o.model] ? o.model : DEFAULT_MODEL;
  const say = (step: string, state: Progress['state'], msg: string, pct?: number) => o.onProgress?.({ step, state, msg, pct });
  const have = inspect(P.dir);
  let ok = true;
  const need = (have.runtime ? 0 : SIZES_MB.runtime)
    + (parts.includes('captions') ? (have.captionsPkgs ? 0 : SIZES_MB.captionsPkgs) + (have.models.includes(modelId) ? 0 : WHISPER_MODELS[modelId].mb) : 0)
    + (parts.includes('kokoro') ? (have.kokoro ? 0 : SIZES_MB.kokoro) : 0) + (parts.includes('gpu') && !have.gpuPkgs ? SIZES_MB.gpu : 0);
  try {
    let d = P.dir; while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
    const freeMB = Math.round((fs.statfsSync(d).bavail * fs.statfsSync(d).bsize) / 1e6);
    say('check', 'ok', `about ${(need / 1024).toFixed(1)} GB to download into ${P.dir}; ${(freeMB / 1024).toFixed(1)} GB free`);
    if (freeMB && freeMB < need + 500) { say('check', 'error', `Not enough disk space: about ${(need / 1024).toFixed(1)} GB needed, ${(freeMB / 1024).toFixed(1)} GB free.`); return false; }
  } catch { say('check', 'info', 'could not read the free disk space'); }
  if (!dry) {
    fs.mkdirSync(P.dir, { recursive: true });
    const mk = path.join(P.dir, VOICE_MARKER);
    if (!fs.existsSync(mk)) { try { fs.writeFileSync(mk, JSON.stringify({ app: 'VTube Pro', what: 'voice pack (live captions, alert voice): safe to delete from the studio\'s Uninstall button', at: new Date().toISOString() })); } catch { /* the folder stays recognisable by its contents */ } }
  }
  const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(P.dir, 'python'), UV_CACHE_DIR: path.join(P.dir, 'uv-cache') };
  let uv: string | null = null;
  const pip = async (args: string[]) => {
    uv ??= await findUv(P);
    if (!uv) throw new Error('uv is missing');
    const r = await sh(uv, ['pip', 'install', '--python', P.python, ...args], { env });
    if (r.code !== 0) throw new Error('package install failed: ' + r.out.slice(-600));
  };

  // ---- runtime (Python 3.12 venv + the shared packages)
  if (!have.runtime) {
    if (dry) say('runtime', 'info', `would: get uv ${UV_VER} if missing, create ${P.venv} (Python 3.12), install ${RUNTIME_PKGS.join(', ')}`);
    else {
      uv = await findUv(P);
      if (!uv && process.platform !== 'win32') {
        say('runtime', 'error', `The one-click voice setup only knows how to fetch its Python tool (uv) on Windows. On ${process.platform === 'darwin' ? 'macOS' : 'Linux'}, install uv yourself (https://docs.astral.sh/uv/), then press the button again.`);
        return false;
      }
      if (!uv) {
        say('runtime', 'run', 'Downloading the Python installer tool (uv, 18 MB)…');
        const sha = (await (await fetch(UV_URL + '.sha256')).text()).trim().split(/\s+/)[0];
        const zip = path.join(P.downloads, 'uv.zip');
        await download(UV_URL, zip, sha, (x) => say('runtime', 'run', 'Downloading uv…', x * 0.1), o.signal);
        fs.mkdirSync(P.uvDir, { recursive: true });
        const r = await sh('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${P.uvDir}'`]);
        if (r.code !== 0) throw new Error('could not unpack uv: ' + r.out.slice(-300));
        uv = path.join(P.uvDir, 'uv.exe'); fs.rmSync(zip, { force: true });
      }
      say('runtime', 'run', 'Creating the Python 3.12 environment…', 0.15);
      const r = await sh(uv, ['venv', '--python', '3.12', P.venv], { env });
      if (r.code !== 0) throw new Error('venv failed: ' + r.out.slice(-400));
      say('runtime', 'run', 'Installing onnxruntime, numpy, websockets…', 0.3);
      await pip(RUNTIME_PKGS);
    }
  } else say('runtime', 'skip', 'Python runtime already there');

  // ---- captions
  if (parts.includes('captions')) {
    const m = WHISPER_MODELS[modelId];
    if (!have.captionsPkgs) {
      if (dry) say('captions', 'info', `would: pip install ${CAPTION_PKGS.join(' ')} and ${FASTER_WHISPER} --no-deps (so PyAV, which bundles a GPL FFmpeg, is never installed)`);
      else {
        say('captions', 'run', 'Installing faster-whisper (MIT) and CTranslate2 (MIT)…', 0.1);
        await pip(CAPTION_PKGS);
        await pip(['--no-deps', FASTER_WHISPER]);
      }
    } else say('captions', 'skip', 'faster-whisper already there');
    if (have.models.includes(modelId)) say('captions', 'skip', `Whisper ${m.label} already there`);
    else if (dry) say('captions', 'info', `would download ${m.files.length} files (~${m.mb} MB) of ${m.repo}@${m.rev.slice(0, 8)} into ${P.whisper(modelId)}`);
    else {
      for (let i = 0; i < m.files.length; i++) {
        const f = m.files[i];
        await download(hfUrl(m.repo, m.rev, f.name), path.join(P.whisper(modelId), f.name), f.sha256, (x, mb) => say('captions', 'run', `Downloading Whisper ${m.label} (${f.name}, ${mb.toFixed(0)} MB)…`, 0.3 + 0.7 * (i + x) / m.files.length), o.signal);
      }
    }
    if (!dry) {
      const r = await sh(P.python, [path.join(REPO, 'tools', 'voice', 'whisper_sidecar.py'), '--check'], { timeout: 60000 });
      if (r.code === 0 && /"ok": ?true/.test(r.out)) say('captions', 'ok', `Live captions are ready (${m.label}, MIT licence). Turn them on in the studio.`);
      else { ok = false; say('captions', 'error', `The caption engine does not start: ${r.out.slice(-300)}`); }
    }
  }

  // ---- gpu
  if (parts.includes('gpu')) {
    if (have.gpuPkgs) say('gpu', 'skip', 'NVIDIA CUDA libraries already there');
    else if (dry) say('gpu', 'info', `would: pip install ${GPU_PKGS.join(' ')} (~1.5 GB, NVIDIA's licence, from PyPI; captions use the GPU when it loads and fall back to the CPU if not)`);
    else { say('gpu', 'run', 'Installing NVIDIA cuBLAS + cuDNN (about 1.5 GB)…', 0.2); await pip(GPU_PKGS); say('gpu', 'ok', 'CUDA libraries installed. Captions use the GPU if it works, else the CPU.'); }
  }

  // ---- kokoro
  if (parts.includes('kokoro')) {
    if (have.kokoro) say('kokoro', 'skip', 'Kokoro alert voice already there');
    else if (dry) say('kokoro', 'info', `would download Kokoro-82M int8 (92 MB) + ${Object.keys(KOKORO_VOICES).length} voices from ${KOKORO_REPO}@${KOKORO_REV.slice(0, 8)}, and unpack misaki's two dictionaries from its pinned wheel`);
    else {
      const files = [...KOKORO_FILES, ...Object.values(KOKORO_VOICES).map((v) => v.file)];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        await download(hfUrl(KOKORO_REPO, KOKORO_REV, f.name), path.join(P.kokoro, f.name), f.sha256, (x, mb) => say('kokoro', 'run', `Downloading Kokoro (${f.name}, ${mb.toFixed(0)} MB)…`, 0.7 * (i + x) / files.length), o.signal);
      }
      const whl = path.join(P.downloads, 'misaki.whl');
      await download(MISAKI_WHEEL.url, whl, MISAKI_WHEEL.sha256, (x) => say('kokoro', 'run', 'Downloading the pronunciation dictionaries…', 0.7 + 0.2 * x), o.signal);
      const unpack = `import zipfile,sys,os\nz=zipfile.ZipFile(sys.argv[1]);d=sys.argv[2];os.makedirs(d,exist_ok=True)\nfor m in sys.argv[3:]:\n    open(os.path.join(d,os.path.basename(m)),'wb').write(z.read(m))\nlic=[n for n in z.namelist() if n.lower().endswith(('license','license.txt','licence'))]\nfor n in lic[:1]: open(os.path.join(d,'LICENSE'),'wb').write(z.read(n))`;
      const r = await sh(P.python, ['-c', unpack, whl, path.join(P.kokoro, 'misaki'), ...MISAKI_WHEEL.members]);
      if (r.code !== 0) throw new Error('could not unpack the dictionaries: ' + r.out.slice(-300));
      fs.rmSync(whl, { force: true });
      const c = await sh(P.python, [path.join(REPO, 'tools', 'voice', 'kokoro_sidecar.py'), '--check'], { timeout: 60000 });
      if (c.code === 0 && /"ok": ?true/.test(c.out)) say('kokoro', 'ok', 'Kokoro alert voice ready (Apache-2.0 weights; trained on permissive audio, some CC BY: see THIRD_PARTY_NOTICES.md).');
      else { ok = false; say('kokoro', 'error', `The alert voice does not start: ${c.out.slice(-300)}`); }
    }
  }
  say('done', ok ? 'ok' : 'warn', ok ? (dry ? 'Dry run finished: nothing was changed.' : 'Voice features are set up.') : 'Finished with problems: see the steps above.');
  return ok;
}

/** Is this folder a voice pack of ours? Its marker file, or (an install from before the marker) nothing in it but the folders we make. */
export function isVoiceFolder(dir: string): boolean {
  try {
    if (fs.existsSync(path.join(dir, VOICE_MARKER))) return true;
    const names = fs.readdirSync(dir);
    return names.length > 0 && names.every((e) => OWN_ENTRIES.has(e));
  } catch { return false; }
}

/** Remove the voice pack (or just its caption / alert-voice models). Refuses a folder that is not ours: VTP_VOICE_DIR may point
 *  anywhere, and a delete must never take someone's own files with it. Returns false when it refused. */
export function uninstall(dir = DEFAULT_DIR, onProgress?: (p: Progress) => void, part?: 'captions' | 'kokoro'): boolean {
  const P = paths(dir);
  if (!fs.existsSync(P.dir)) { onProgress?.({ step: 'uninstall', state: 'skip', msg: 'Nothing to remove.' }); return true; }
  if (!isVoiceFolder(P.dir)) {
    onProgress?.({ step: 'uninstall', state: 'error', msg: `Refused: ${P.dir} is not a VTube Pro voice folder (it has no ${VOICE_MARKER} marker and holds other files). Nothing was deleted; remove it yourself if you are sure.` });
    return false;
  }
  if (part === 'captions') fs.rmSync(path.join(P.models, 'whisper'), { recursive: true, force: true });
  else if (part === 'kokoro') fs.rmSync(P.kokoro, { recursive: true, force: true });
  else if (fs.existsSync(P.dir)) fs.rmSync(P.dir, { recursive: true, force: true });
  onProgress?.({ step: 'uninstall', state: 'ok', msg: part ? `Removed the ${part} models from ${P.dir}.` : `Removed ${P.dir} (Python runtime, models, downloads).` });
  return true;
}

// ---------------------------------------------------------------- do the pins still exist? (run by a person, never by the tests)
export interface PinCheck { item: string; ok: boolean; detail: string }
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Ask PyPI / Hugging Face / GitHub whether every pinned version and file is still there and still the same size / sha256.
 *  `npx tsx tools/voice/voice_setup.ts --verify-pins` (needs the network; the unit tests drive it with a fake `fetch`).
 *  - pip pins (`name==x.y.z`): https://pypi.org/pypi/<name>/<x.y.z>/json must answer 200;
 *  - model files: a HEAD on the pinned-commit URL (Hugging Face answers the redirect with `x-linked-size` and, for large
 *    files, `x-linked-etag` = the file's sha256); size must equal ours, and the sha256 must when it is given;
 *  - the misaki wheel: PyPI's JSON must list that file with our sha256; the uv release must answer. */
export async function verifyPins(f: FetchFn = fetch): Promise<PinCheck[]> {
  const out: PinCheck[] = [];
  const add = (item: string, ok: boolean, detail: string) => out.push({ item, ok, detail });
  const pins = [...RUNTIME_PKGS, ...CAPTION_PKGS, FASTER_WHISPER, ...GPU_PKGS].filter((p) => /^[A-Za-z0-9_.-]+==\d[\w.]*$/.test(p));
  for (const p of pins) {
    const [name, ver] = p.split('==');
    try { const r = await f(`https://pypi.org/pypi/${name}/${ver}/json`); add(`pip ${p}`, r.status === 200, `PyPI answered ${r.status}`); }
    catch (e) { add(`pip ${p}`, false, String((e as Error).message)); }
  }
  const files: { item: string; url: string; pin: PinFile }[] = [];
  for (const m of Object.values(WHISPER_MODELS)) for (const pin of m.files) files.push({ item: `${m.repo}/${pin.name}`, url: hfUrl(m.repo, m.rev, pin.name), pin });
  for (const pin of [...KOKORO_FILES, ...Object.values(KOKORO_VOICES).map((v) => v.file)]) files.push({ item: `${KOKORO_REPO}/${pin.name}`, url: hfUrl(KOKORO_REPO, KOKORO_REV, pin.name), pin });
  for (const { item, url, pin } of files) {
    try {
      const r = await f(url, { method: 'HEAD', redirect: 'manual' });
      if (r.status >= 400) { add(item, false, `answered ${r.status}`); continue; }
      const size = Number(r.headers.get('x-linked-size') ?? r.headers.get('content-length'));
      const etag = (r.headers.get('x-linked-etag') ?? '').replace(/"/g, '');
      const sizeOk = Number.isFinite(size) && size === pin.bytes;
      const shaOk = /^[0-9a-f]{64}$/.test(etag) ? etag === pin.sha256 : true;
      add(item, sizeOk && shaOk, sizeOk ? (shaOk ? `${pin.bytes} bytes${/^[0-9a-f]{64}$/.test(etag) ? ', sha256 matches' : ''}` : 'sha256 differs from the pin') : `size ${size} differs from the pin (${pin.bytes})`);
    } catch (e) { add(item, false, String((e as Error).message)); }
  }
  try {
    const r = await f('https://pypi.org/pypi/misaki/0.9.4/json');
    const j = await r.json() as { urls?: { url: string; digests?: { sha256?: string } }[] };
    const hit = j.urls?.find((u) => u.url === MISAKI_WHEEL.url);
    add('misaki 0.9.4 wheel', !!hit && hit.digests?.sha256 === MISAKI_WHEEL.sha256, hit ? (hit.digests?.sha256 === MISAKI_WHEEL.sha256 ? 'sha256 matches' : 'sha256 differs from the pin') : 'file not listed');
  } catch (e) { add('misaki 0.9.4 wheel', false, String((e as Error).message)); }
  try { const r = await f(UV_URL, { method: 'HEAD', redirect: 'manual' }); add(`uv ${UV_VER}`, r.status < 400, `GitHub answered ${r.status}`); } catch (e) { add(`uv ${UV_VER}`, false, String((e as Error).message)); }
  return out;
}

// ---- command line (the file-name test: bundled into dist-helper/index.mjs, import.meta.url IS argv[1])
if (process.argv[1] && /voice_setup\.[cm]?[tj]s$/.test(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), arg = (k: string) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const json = a.includes('--json');
  const log = (p: Progress) => console.log(json ? JSON.stringify(p) : `[${p.state}] ${p.step}: ${p.msg}${p.pct !== undefined ? ` (${Math.round(p.pct * 100)} %)` : ''}`);
  const dir = arg('--dir') ?? DEFAULT_DIR;
  if (a.includes('--uninstall')) { process.exit(uninstall(dir, log) ? 0 : 1); }
  else if (a.includes('--status')) { console.log(JSON.stringify(inspect(dir), null, 1)); process.exit(0); }
  else if (a.includes('--verify-pins')) {
    void verifyPins().then((r) => { for (const c of r) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.item}: ${c.detail}`); process.exit(r.every((c) => c.ok) ? 0 : 1); });
  }
  else {
    const parts = (arg('--parts')?.split(',') as Part[] | undefined) ?? ALL_PARTS;
    runSetup({ dir, parts, model: arg('--model') as WhisperModelId | undefined, dryRun: a.includes('--dry-run'), onProgress: log })
      .then((ok) => process.exit(ok ? 0 : 1))
      .catch((e) => { log({ step: 'error', state: 'error', msg: String((e as Error).message ?? e) }); process.exit(1); });
  }
}
