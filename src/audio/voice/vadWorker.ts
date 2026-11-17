// Silero VAD worker: the voice worklet streams 32 ms / 16 kHz windows straight to this worker over a MessagePort
// (audio thread → worker, never through the main thread) and gets a voice probability back per window.
//
// onnxruntime-web is loaded at runtime from /vendor/voice/ (copied from node_modules, see THIRD_PARTY_NOTICES.md)
// rather than bundled, so Vite never has to re-optimise dependencies (which would reload a live studio).
//
// Optional neural visemes (src/tracking/neuralVisemes.ts, off by default): when enabled the worklet also streams the
// same 16 kHz signal in 10 ms chunks ('pcm'); the tiny phone model runs here (~1 % of a core) and posts each frame's
// 17 viseme posteriors to the main thread, stamped with the epoch time (ms) of the instant it describes.
// Idle skip (opt-in, OFF by default: `nv.idle` in 'init' or `{ type: 'nv', idle }`; nothing in the app turns it on yet,
// because the posteriors after a long pause then differ slightly from the always-on model): each chunk carries the
// worklet's voice gate (g: open or fricative); once it has been shut for ~0.5 s the model stops (the front-end keeps
// listening), posts one 'nvIdle' and no frames until the gate opens again (NeuralMerge ignores the model while the
// voice is silent anyway). The worklet's 'nvWake' (posted the moment the gate opens, ahead of the next chunk) wakes it
// and it catches up on the last 90 ms first.
// Personal adaptation (neuralPersonal.ts) records the model's GRU states during the guided setup and re-fits the
// output layer here, off the main thread.
import type * as OrtNS from 'onnxruntime-web';
import { SileroStreams } from './sileroVad.ts';
import { NeuralVisemes, NV_PHONES, nvIdleAfter, type NvFrame, type NvModelJson } from '../../tracking/neuralVisemes.ts';
import { adaptOutput, forceAlign, scriptPhones, withPersonal, type AdaptSample } from '../../tracking/neuralPersonal.ts';
import { A2fLink, type A2fLinkCfg } from './a2fLink.ts';
import { CaptionLink, type CaptionLinkCfg } from './captionLink.ts';

/** 'full' = nv_visemes.json (60 ms of lookahead: best with the lip-sync lookahead >= 80 ms); 'fast' = nv_visemes_fast.json
 *  (20 ms of lookahead: for no / short lookahead, docs/VOICE.md -> Fast neural visemes) */
type NvVariant = 'full' | 'fast';
type Init = { type: 'init'; base: string; nvBase?: string; nvQuery?: string; port: MessagePort; streams: number; nv?: { on: boolean; personal?: { ow: string; ob: string } | null; model?: NvVariant; idle?: boolean } };
type NvRecStep = { kind: 'held'; phone: string } | { kind: 'script'; text: string };
let sil: SileroStreams | null = null;
let port: MessagePort | null = null;
let chain: Promise<void> = Promise.resolve();
let n = 0;
let baseUrl = '';
/** Where the neural viseme model comes from when it is not next to the worker (the server serves it). */
let nvSrc = { base: '', query: '' };
// ---- neural visemes
let nvModel: NvModelJson | null = null;
const nvModels = new Map<NvVariant, NvModelJson>();
let nvVariant: NvVariant = 'full';
let nv: NeuralVisemes | null = null;
let nvOn = false;
/** idle skip opted in (default off: the always-on output) */
let idleSkip = false;
let nvSamples = 0;
let nvMs = 0, nvMsSamples = 0;
let rec: { step: NvRecStep; frames: { lp: Float32Array; h: Float32Array }[] } | null = null;
const recorded: { step: NvRecStep; frames: { lp: Float32Array; h: Float32Array }[] }[] = [];
const NO_TRANSFER: Transferable[] = [];
const post = (m: unknown, tr?: Transferable[]) => (self as unknown as Worker).postMessage(m, tr ?? NO_TRANSFER);
const T0 = performance.timeOrigin;
const epoch = () => T0 + performance.now();
const VIS17 = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W', 'aa', 'E', 'I', 'O', 'U'] as const;
// GPU lip sync (Audio2Face-3D sidecar): the same 16 kHz stream, over a localhost websocket (a2fLink.ts)
const a2f = new A2fLink(post);
// Live captions: the same 16 kHz stream + the gate flag to the local caption service (captionLink.ts, docs/LIVE_CAPTIONS.md)
const cap = new CaptionLink(post);

async function loadNv(base: string, personal?: { ow: string; ob: string } | null, variant: NvVariant = nvVariant) {
  let m = nvModels.get(variant);
  if (!m) {
    const file = variant === 'fast' ? 'nv_visemes_fast.json' : 'nv_visemes.json';
    const r = await fetch(`${nvSrc.base || base}${file}${nvSrc.query}`);
    if (!r.ok) throw new Error(`${file} ${r.status}`);
    m = (await r.json()) as NvModelJson;
    nvModels.set(variant, m);
  }
  // a model switch drops anything recorded for the other model's personal fit
  if (variant !== nvVariant) { recorded.length = 0; rec = null; }
  nvModel = m; nvVariant = variant;
  nv = new NeuralVisemes(withPersonal(m, personal ?? null));
  nv.keepHidden = !!rec;   // GRU states are only needed while a guided-setup step is being recorded
  nv.reuseFrames = true;   // frames are copied out in onNvFrame: no garbage per frame
  nv.idleAfter = idleSkip ? nvIdleAfter(m) : 0;
  nvSamples = 0;
  post({ type: 'nvReady', look: m.look, delayMs: Math.round(nv.delay * 1000), personal: !!personal, model: variant });
}

let arrived = 0;
let out: { t: number; v: Float32Array }[] | null = null;
function onNvFrame(f: NvFrame) {
  // the frame describes stream time f.t; the newest sample we hold is at nvSamples / 16 kHz ≈ `arrived`
  const t = arrived - (nvSamples / 16000 - f.t) * 1000;
  const v = new Float32Array(17), s = f.vis17;
  if (s) for (let i = 0; i < 17; i++) v[i] = s[i];
  else for (let i = 0; i < 17; i++) v[i] = f.visemes[VIS17[i]];
  (out ??= []).push({ t, v });
  if (rec && f.hidden) rec.frames.push({ lp: f.phones.map((p) => Math.log(p + 1e-8)), h: f.hidden });
}

/** g: the worklet's voice gate for this chunk (1 open, 0 shut; absent = always run). Never idle while recording, and
 *  never at all unless the idle skip is opted in (nv.idleAfter = 0 otherwise: the always-on output). */
function onPcm(x: Float32Array, g?: number) {
  if (!nv || !nvOn) return;
  const t0 = performance.now();
  arrived = epoch();
  nvSamples += x.length;
  out = null;
  const wasIdle = nv.idle;
  nv.push(x, onNvFrame, g !== 0 || rec !== null);
  nvMs += performance.now() - t0; nvMsSamples += x.length;
  if (out) post({ type: 'nv', frames: out });
  out = null;
  if (nv.idle && !wasIdle) post({ type: 'nvIdle' });
  // worker cost per second of audio (idle seconds included), every 5 s
  if (nvMsSamples >= 80000) { post({ type: 'nvMs', msPerSec: (nvMs / nvMsSamples) * 16000 }); nvMs = 0; nvMsSamples = 0; }
}

/** The worklet's gate just opened, ahead of its next 'pcm' chunk (up to 10 ms away): an idle model catches up now, so
 *  the first rows of the word already find a fresh frame. A no-op unless idle. */
function onWake() {
  if (!nv || !nvOn || !nv.idle) return;
  const t0 = performance.now();
  out = null;
  nv.wake(onNvFrame);
  nvMs += performance.now() - t0;
  if (out) post({ type: 'nv', frames: out });
  out = null;
}

function setIdleSkip(on: boolean) {
  idleSkip = on;
  if (nv && nvModel) nv.idleAfter = on ? nvIdleAfter(nvModel) : 0;
}

function adapt() {
  if (!nvModel) throw new Error('model not loaded');
  const P = (ph: string) => NV_PHONES.indexOf(ph as (typeof NV_PHONES)[number]);
  const data: AdaptSample[] = [];
  for (const r of recorded) {
    if (r.frames.length < 10) continue;
    if (r.step.kind === 'held') {
      const y = P(r.step.phone);
      if (y < 0) continue;
      // the held sound on every frame the base model doesn't call silence; the rest stays silence
      for (const f of r.frames) data.push({ h: f.h, y: Math.exp(f.lp[0]) < 0.5 ? y : 0 });
    } else {
      const seq = scriptPhones(r.step.text);
      if (!seq.phones.length) continue;
      const lab = forceAlign(r.frames.map((f) => f.lp), seq);
      r.frames.forEach((f, i) => data.push({ h: f.h, y: lab[i] }));
    }
  }
  if (data.length < 100) throw new Error('not enough recorded voice');
  return { p: adaptOutput(nvModel, data), n: data.length };
}

self.onmessage = async (e: MessageEvent<Init | { type: string; [k: string]: unknown }>) => {
  const d = e.data as Omit<Init, 'type'> & { type: string; on?: boolean; step?: NvRecStep; personal?: { ow: string; ob: string } | null; model?: NvVariant; idle?: boolean };
  if (d?.type === 'nv') {
    // runtime toggle: { on, personal?, model?, idle? } (a message with only `idle` leaves the model on / off as it is)
    if (typeof d.idle === 'boolean') setIdleSkip(d.idle);
    if (!('on' in d)) return;
    nvOn = !!d.on;
    const variant = d.model ?? nvVariant;
    try { if (nvOn && (!nv || 'personal' in d || variant !== nvVariant)) await loadNv(baseUrl, d.personal ?? null, variant); }
    catch (err) { nvOn = false; post({ type: 'nvError', error: String((err as Error)?.message ?? err) }); }
    return;
  }
  if (d?.type === 'a2f') { a2f.configure(d as unknown as A2fLinkCfg); return; }
  if (d?.type === 'cap') { cap.configure(d as unknown as CaptionLinkCfg); return; }
  if (d?.type === 'nvRec') {
    if (d.step) { rec = { step: d.step, frames: [] }; }
    else if (rec) { recorded.push(rec); post({ type: 'nvRecDone', frames: rec.frames.length }); rec = null; }
    if (nv) nv.keepHidden = !!rec;
    return;
  }
  if (d?.type === 'nvAdapt') {
    try {
      const r = adapt();
      recorded.length = 0;
      if (r.p) await loadNv(baseUrl, { ow: r.p.ow, ob: r.p.ob });
      post({ type: 'nvPersonal', personal: r.p ? { ow: r.p.ow, ob: r.p.ob } : null, n: r.n, loss: r.p?.loss ?? 0 });
    } catch (err) { recorded.length = 0; post({ type: 'nvPersonal', personal: null, error: String((err as Error)?.message ?? err) }); }
    return;
  }
  if (d?.type !== 'init') return;
  baseUrl = d.base;
  nvSrc = { base: d.nvBase ?? '', query: d.nvQuery ?? '' };
  if (d.nv?.model) nvVariant = d.nv.model;
  if (typeof d.nv?.idle === 'boolean') setIdleSkip(d.nv.idle);
  if (d.nv?.on) { nvOn = true; loadNv(d.base, d.nv.personal, nvVariant).catch((err) => { nvOn = false; post({ type: 'nvError', error: String((err as Error)?.message ?? err) }); }); }
  port = d.port;
  port.onmessage = (m: MessageEvent<{ type: string; seq: number; x: Float32Array; g?: number }>) => {
    const c = m.data;
    if (c?.type === 'pcm') { try { a2f.push(c.x); } catch { /* never into the audio path */ } try { cap.push(c.x, c.g); } catch { /* never into the audio path */ } try { onPcm(c.x, c.g); } catch (err) { post({ type: 'nvError', error: String((err as Error)?.message ?? err) }); nvOn = false; } return; }
    if (c?.type === 'nvWake') { try { onWake(); } catch (err) { post({ type: 'nvError', error: String((err as Error)?.message ?? err) }); nvOn = false; } return; }
    if (c?.type !== 'chunk' || !sil) return;
    // strictly in order: each window updates the model's recurrent state
    chain = chain.then(async () => {
      const p = await sil!.process(c.x, c.seq);
      port!.postMessage({ type: 'p', p, seq: c.seq });
      if (++n % 100 === 0) post({ type: 'ms', ms: sil!.ms });
    }).catch((err) => { post({ type: 'error', error: String((err as Error)?.message ?? err) }); });
  };
  try {
    const ort = (await import(/* @vite-ignore */ `${d.base}ort.wasm.min.mjs`)) as typeof OrtNS;
    ort.env.wasm.numThreads = 1;          // no SharedArrayBuffer / COOP needed; ~0.4 ms per window anyway
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = d.base;
    ort.env.logLevel = 'error';
    const model = await (await fetch(`${d.base}silero_vad_v5.onnx`)).arrayBuffer();
    sil = await SileroStreams.create(ort, model, d.streams);
    post({ type: 'ready' });
  } catch (err) {
    post({ type: 'error', error: String((err as Error)?.message ?? err) });
  }
};
