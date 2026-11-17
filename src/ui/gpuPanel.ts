// Tracking → Advanced → Voice, phone & 2nd camera: GPU tracking on an NVIDIA RTX 50-series card (docs/GPU_TRACKING.md)
//   · GPU lip sync — NVIDIA Audio2Face-3D (tools/gpu/a2f_sidecar.py)
//   · Face expressions — NVIDIA Maxine AR SDK (tools/gpu/vision_sidecar.py --feature maxine; the user installs the SDK)
//   · Whole-body pose — RTMW (tools/gpu/vision_sidecar.py --feature rtmw)
// Costs below were MEASURED on an RTX 5090 (tools/gpu/bench_costs.py, recorded clip, other apps running); the RTX
// 5070 / 5060 figures are ESTIMATES scaled by CUDA-core count (×3.5 / ×5.7), not measurements.
import type { App } from '../app.ts';
import { capabilityChip } from './capabilityView.ts';
import { FEATURE_NAMES } from '../../shared/capability.ts';
import { button, h, slider, toast } from './dom.ts';
import { add, live } from './bits.ts';
import { classifyGpu } from '../../shared/gpuClass.ts';
import { RTMW_NOTE, RTMW_NEEDS_RTX50 } from '../../shared/gpuLicence.ts';

type SideStatus = { running: boolean; starting: boolean; error: string; log: string[]; restarts?: number; exits?: { at: string; code: number | null; reason: string }[] };
type Step = { step: string; state: 'run' | 'ok' | 'skip' | 'warn' | 'error' | 'info'; msg: string; pct?: number };
type Srv = { a2f?: SideStatus; rtmw?: SideStatus; maxine?: SideStatus; python?: string; gpu?: { name: string; vramMB: number; rtx50: boolean; nvidia: boolean; driver?: string; a2f?: 'measured' | 'untested' | 'none'; note?: string };
  have?: { a2fModel: boolean; rtmwModel: boolean; maxineSdk: boolean; venv: boolean; dir?: string }; setup?: { running: boolean; ok: boolean | null; steps: Step[] } };
let srv: Srv = {};
let polling = false;
let polledOnce = false;
async function pollServer() {
  if (polling) return;
  polling = true;
  try { srv = await (await fetch('/api/gpu/status')).json(); } catch { srv = {}; } finally { polling = false; polledOnce = true; }
}

export const REQUIREMENT = 'Requires an NVIDIA RTX 50-series GPU (tested on RTX 5090).';
/** measured on the RTX 5090 (bench_costs.py); est. = scaled estimate */
export const COSTS = {
  a2f: 'RTX 5090 (measured): 30 fps → +1.6 % GPU, 60 fps → +4.8 % GPU · ~1.1 GB VRAM · 0.1–0.25 CPU core · +4–7 ms (median) after the audio it waits for. Estimated: RTX 5070 ≈ +6 % / +17 % GPU, RTX 5060 ≈ +9 % / +27 %.',
  maxine: 'RTX 5090 (measured): ~1 ms per frame, GPU load within noise (< 2 %) at 30 and 60 fps · ~0.6 GB VRAM · ~0.1 CPU core · +3–4 ms (median). Estimated: RTX 5070 / 5060 ≈ +3–6 % GPU.',
  rtmw: 'RTX 5090 (measured): 30 fps → +7.5 % GPU, 60 fps → +12.8 % GPU · ~1.2 GB VRAM · 0.7–1 CPU core · +12–14 ms (median). Estimated: RTX 5070 ≈ +26 % / +45 % GPU, RTX 5060 ≈ +43 % / +73 % — use 30 fps there.',
  all: 'All three on the RTX 5090 (measured): 30 fps → +13.5 % GPU, 60 fps → +24.8 % GPU · ~2.9 GB VRAM · ~1–1.5 CPU cores.',
};

function gpuGate(): { ok: boolean; why: string } {
  const g = srv.gpu;
  if (!polledOnce) return { ok: true, why: '' };
  if (!g || !g.nvidia) return { ok: false, why: `${REQUIREMENT} No NVIDIA GPU was found (nvidia-smi).` };
  if (!g.rtx50) return { ok: false, why: `${REQUIREMENT} Detected: ${g.name}. It isn't supported in VTube Pro yet.` };
  return { ok: true, why: '' };
}

/** RTMW needs an RTX 50-series card, nothing else (no switch, no environment variable): everyone else gets the notice. */
function rtmwGate(): { ok: boolean; why: string } {
  return rtmwOk() ? { ok: true, why: '' } : { ok: false, why: RTMW_NEEDS_RTX50 };
}

/** GPU lip sync runs on RTX 50 (measured) and, untested, on RTX 20 / 30 / 40 (shared/gpuClass.ts): the other GPU features stay RTX 50 only. */
export const A2F_REQUIREMENT = 'Measured on an RTX 50-series GPU (RTX 5090); an RTX 20 / 30 / 40-series card should work too but is not tested.';
function a2fGate(): { ok: boolean; why: string; untested: boolean } {
  const g = srv.gpu;
  if (!polledOnce) return { ok: true, why: '', untested: false };
  if (!g || !g.nvidia) return { ok: false, why: `${A2F_REQUIREMENT} No NVIDIA GPU was found (nvidia-smi); the browser lip sync is used.`, untested: false };
  const c = classifyGpu(g.name, g.vramMB);
  const kind = g.a2f ?? c.a2f;
  if (kind === 'none') return { ok: false, why: `${A2F_REQUIREMENT} Detected: ${g.name}. ${c.note}`, untested: false };
  return { ok: true, why: kind === 'untested' ? (g.note ?? c.note) : '', untested: kind === 'untested' };
}

function statusLine(get: () => { text: string; col: string }) {
  const st = h('p', { class: 'note', style: 'margin:6px 0 0' });
  let n = 0;
  const paint = () => { if (++n % 90 === 1) void pollServer(); const s = get(); st.textContent = s.text; st.style.color = s.col; };
  paint();
  live(() => { if (!st.isConnected) return false; paint(); return true; });
  return st;
}

function header(title: string, badge = 'RTX 50-series', tip = REQUIREMENT) {
  return h('h3', null, h('span', { class: 'grow' }, title), h('span', { class: 's-badge warn', title: tip }, badge));
}

const post = (url: string, body: unknown = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({}));
/** the last crash / exit reason of a sidecar, if it restarted recently */
function lastExit(x?: SideStatus) { const e = x?.exits?.[x.exits.length - 1]; return e && Date.now() - Date.parse(e.at) < 10 * 60000 && !/turned off/.test(e.reason) ? ` · last exit ${new Date(e.at).toLocaleTimeString()}: ${e.reason}${x?.restarts ? ` (restarted ${x.restarts}×)` : ''}` : ''; }

/** The RTMW body model is part of the GPU setup on an RTX 50-series card (the only cards it was built and measured on). Any other PC
 *  gets the plain notice in RTMW_NEEDS_RTX50 and MediaPipe's body tracking keeps working. */
const rtmwOk = () => !polledOnce || srv.gpu?.rtx50 === true;
const setupParts = (parts: string[]) => (rtmwOk() ? [...parts.slice(0, 2), 'rtmw', ...parts.slice(2)] : parts);

/** "Set up GPU tracking": one click installs everything a fresh PC needs (tools/gpu/gpu_setup.ts on the server). */
export function gpuSetupCard(app: App, refresh: () => void): HTMLElement {
  const card = h('section', { class: 's-card' });
  const list = h('ol', { class: 's-steps', style: 'margin:6px 0 0' });
  const note = h('p', { class: 'note', style: 'margin:6px 0 0' });
  const icon: Record<string, string> = { run: '…', ok: '✓', skip: '✓', warn: '!', error: '✗', info: '·' };
  const label: Record<string, string> = { check: 'Check GPU, driver and disk', runtime: 'Python GPU runtime (onnxruntime + CUDA)', a2f: 'Audio2Face-3D model', rtmw: 'RTMW body model', maxine: 'NVIDIA AR SDK (Maxine)', done: 'Finished', error: 'Error', uninstall: 'Remove' };
  let n = 0;
  const paint = () => {
    if (++n % 30 === 1) void pollServer();
    const s = srv.setup, hv = srv.have;
    list.replaceChildren(...(s?.steps ?? []).map((x) => h('li', { style: x.state === 'error' ? 'color:var(--err)' : x.state === 'warn' ? 'color:var(--warn)' : '' },
      h('span', null, `${icon[x.state] ?? ''} ${label[x.step] ?? x.step}: ${x.msg}${x.state === 'run' && x.pct !== undefined ? ` (${Math.round(x.pct * 100)} %)` : ''}`))));
    // (never the folder's path: users do not need it, and it can be a developer's work folder)
    note.textContent = hv ? `Installed on this PC: GPU runtime ${hv.venv ? '✓' : '✗'} · Audio2Face model ${hv.a2fModel ? '✓' : '✗'} · RTMW model ${hv.rtmwModel ? '✓' : '✗'} · NVIDIA AR SDK ${hv.maxineSdk ? '✓' : '✗'}` : 'Checking…';
  };
  paint();
  live(() => { if (!list.isConnected) return false; paint(); return true; });
  const run = (body: unknown, confirmText?: string) => {
    if (app.observer) { toast('Observer sandbox: setup runs from your real studio.', 'warn'); return; }
    if (confirmText && !confirm(confirmText)) return;
    void post('/api/gpu/setup', body).then(() => pollServer()).then(refresh);
  };
  add(card, header('Set up GPU tracking'),
    h('p', { class: 'lead' }, 'Installs everything the GPU features need, from the official sources, with checksums: a private Python runtime with the NVIDIA CUDA libraries (~2.1 GB), and the Audio2Face-3D model (NVIDIA, 310 MB). Optional: NVIDIA’s AR SDK for the Maxine face features (1.35 GB download + ~2 GB) — NVIDIA’s own installer opens, Windows asks for admin permission and you accept NVIDIA’s licence. Takes about 5–15 minutes; safe to run again (it only does what is missing).'),
    h('div', { class: 's-row' },
      button('Set up GPU tracking', () => run({ parts: a2fGate().untested ? ['runtime', 'a2f'] : setupParts(['runtime', 'a2f']) }, a2fGate().untested ? `This card is not an RTX 50-series: only GPU lip sync is set up (the Python runtime ~2.1 GB + the Audio2Face model 310 MB), and it is not tested on this card. ${RTMW_NEEDS_RTX50} Continue?` : undefined), 'primary'),
      button('+ NVIDIA AR SDK (Maxine)', () => run({ parts: setupParts(['runtime', 'a2f', 'maxine']) }, 'This downloads NVIDIA’s AR SDK installer (1.35 GB) from nvidia.com and starts it. Windows will ask for admin permission, and NVIDIA’s installer shows its licence. Continue?')),
      button('What would it do?', () => run({ parts: setupParts(['runtime', 'a2f', 'maxine']), dryRun: true }), 'ghost'),
      button('Cancel', () => { void post('/api/gpu/setup/cancel'); }, 'ghost'),
      button('Remove GPU files', () => {
        if (app.observer) return;
        if (!confirm('Remove the GPU runtime and models VTube Pro downloaded (the .gpu folder)? The NVIDIA AR SDK stays installed (remove it in Windows Settings → Apps).')) return;
        void post('/api/gpu/uninstall').then(refresh);
      }, 'danger')),
    list, note);
  return card;
}

export function gpuLipSyncCard(app: App, refresh: () => void): HTMLElement {
  const A = app.audio;
  const s = A.a2fStatus;
  const gate = a2fGate();
  const st = statusLine(() => {
    const x = A.a2fStatus, sv = srv.a2f;
    if (!x.on) return { text: A.a2fSettings.optOut ? 'Off (you turned it off) — the voice model + rule engine shape the mouth.' : 'Off — the voice model + rule engine shape the mouth.', col: '' };
    if (srv.have && !srv.have.venv) return { text: 'Not set up yet — press "Set up GPU tracking" above.', col: 'var(--err)' };
    if (x.error && !x.ready) return sv?.starting ? { text: `Starting the GPU sidecar (first start loads the model, ~5 s)…${lastExit(sv)}`, col: 'var(--warn)' } : { text: `${x.error}${sv?.error ? ` · ${sv.error}` : ''}`, col: 'var(--err)' };
    if (!A.active) return { text: 'Waiting for the microphone: press “Start camera & mic” (or “Turn on the microphone too”) on the Camera & tracking page.', col: 'var(--warn)' };
    if (!x.ready) return { text: 'Connecting to the GPU sidecar…', col: 'var(--warn)' };
    if (x.fps < 5) return { text: `Connected, but no frames are arriving (${x.fps}/s) — check the mic and the noise filter${lastExit(sv)}`, col: 'var(--warn)' };
    return { text: `Working on ${x.provider.replace('ExecutionProvider', '')} · ${x.fps} frames/s · waits ${Math.round(x.futureMs)} ms of audio per frame · ${x.netMs.toFixed(1)} ms per frame${x.used ? ` · in the mouth at ${Math.round(x.weight * 100)} % (lag ${x.lagMs} ms)` : ' · waiting for speech'}${lastExit(sv)}`, col: 'var(--ok)' };
  });
  const card = h('section', { class: 's-card' });
  add(card,
    header(FEATURE_NAMES['gpu-lipsync'], gate.untested ? 'RTX 50 · 20/30/40 untested' : 'RTX 50-series', A2F_REQUIREMENT),
    capabilityChip('gpu-lipsync', { always: true }),   // "What can my PC do?" for this card (src/ui/capabilityView.ts)
    h('p', { class: 'lead' }, 'NVIDIA Audio2Face-3D listens to your mic on the graphics card and moves the whole mouth like a real face — jaw, lip rounding, the lower lip under the teeth for F / V, lips pressing for M / B / P. Your camera still does the expressions. Works best with Better lip sync (60–100 ms): the more lookahead, the more of each sound it hears first.'),
    h('p', { class: 'note', title: COSTS.a2f }, `${A2F_REQUIREMENT} Cost: ${COSTS.a2f}`),
    !gate.ok ? h('p', { class: 'note', style: 'color:var(--warn)' }, gate.why) : gate.untested ? h('p', { class: 'note', style: 'color:var(--warn)' }, `Not tested on this card. ${gate.why}`) : null,
    h('p', { class: 'note' }, 'On an RTX 50-series card with the Audio2Face files installed VTube Pro asks once whether to turn this on (it never starts a GPU job by itself the first time, and never while you are live). Your answer is kept on this PC; turn it on or off here any time. Without a GPU the browser lip sync always runs.'),
    h('div', { class: 's-row' }, button(s.on ? 'Turn GPU lip sync off' : 'Turn GPU lip sync on', () => {
      if (app.observer) { toast('Observer sandbox: not changed (it would take the GPU lip sync from your real studio).', 'warn', 5000); return; }
      if (!s.on && !a2fGate().ok) { toast(a2fGate().why, 'warn', 7000); return; }
      A.setA2f({ on: !s.on });
      if (!s.on && A.voiceSettings.filter === 'off') toast('GPU lip sync needs the noise filter (Standard or Strong) — turn it on under Voice lip-sync.', 'warn', 7000);
      void pollServer().then(refresh);
    }, s.on ? '' : 'primary')),
    s.on ? slider('Audio2Face share', s.mix, 0, 1, 0.05, (v) => { if (!app.observer) A.setA2f({ mix: v }); }, 'How much of the mouth shape comes from Audio2Face (the rest: the voice model + rule engine). Seals and F tucks always take the stronger of the two.', { def: 0.75 }) : null,
    s.on ? slider('Mouth size', A.a2fSettings.gain ?? 1, 0.3, 1.6, 0.05, (v) => { if (!app.observer) A.setA2f({ gain: v }); }, '1 = anime-sized (calibrated); lower = the realistic human range.', { def: 1 }) : null,
    st,
    h('p', { class: 'note' }, 'Runs locally (started and watched by VTube Pro: it restarts by itself if it stops). First time: "Set up GPU tracking" above.'),
    h('details', { class: 'note' }, h('summary', null, 'Licence details'), h('p', { class: 'note' }, 'Model: NVIDIA Audio2Face-3D v2.3.1 (NVIDIA Open Model License).')));
  return card;
}

function visionCard(app: App, refresh: () => void, f: 'maxine' | 'rtmw'): HTMLElement {
  const G = app.gpuVision;
  const on = G.settings[f].on;
  const gate = f === 'rtmw' ? rtmwGate() : gpuGate();
  const title = FEATURE_NAMES[f];
  const lead = f === 'maxine'
    ? 'NVIDIA Maxine AR SDK reads your 52 face expressions (ARKit style) on the graphics card from the same webcam frames — steadier eyes and lip shapes than the browser model (on the test clip: resting blink 0.03 vs 0.27, lips seen closing on M / B / P). MediaPipe keeps head pose and landmarks. Needs NVIDIA\u2019s own AR SDK runtime (free, not included).'
    : 'RTMW (OpenMMLab) finds 133 body, hand and finger points on the graphics card from the same webcam frames and steadies the arm and finger positions MediaPipe found. Needs your hands in view.';
  const st = statusLine(() => {
    const x = G.status(f), sv = srv[f];
    if (!x.on) return { text: 'Off.', col: '' };
    if (f === 'maxine' && srv.have && !srv.have.maxineSdk) return { text: 'NVIDIA AR SDK not installed — see the steps below.', col: 'var(--err)' };
    if (f === 'rtmw' && srv.have && !srv.have.rtmwModel) return { text: 'RTMW model missing — press "Set up GPU tracking" above.', col: 'var(--err)' };
    if (!app.trackingOn) return { text: 'Waiting for the camera: press “Start camera & mic” on the Camera & tracking page.', col: 'var(--warn)' };
    if (srv.have && !srv.have.venv) return { text: 'Not set up yet — press "Set up GPU tracking" above.', col: 'var(--err)' };
    if (!x.ready) return sv?.starting ? { text: `Starting the GPU sidecar…${lastExit(sv)}`, col: 'var(--warn)' } : { text: `${x.error || sv?.error || 'Connecting…'}${lastExit(sv)}`, col: x.error ? 'var(--err)' : 'var(--warn)' };
    const sm = G.summary()[f];
    const w = f === 'maxine' ? ` · ${Math.round((G.summary().maxine.weight) * 100)} % of each face expression${G.summary().maxine.rangeSamples < 150 ? ' (learning your range, ~5 s)' : ''}` : ` · ${G.summary().rtmw.pointsReplaced} points refined`;
    return { text: `Working · ${x.provider} · ${sm.fps} results/s · ${x.ms.toFixed(1)} ms per frame${x.used ? w : ' · no fresh result (camera on? face / arms in view?)'}${lastExit(sv)}`, col: x.used ? 'var(--ok)' : 'var(--warn)' };
  });
  const card = h('section', { class: 's-card' });
  add(card, header(title), capabilityChip(f, { always: true }), h('p', { class: 'lead' }, lead),
    h('p', { class: 'note', title: COSTS[f] }, `${REQUIREMENT} Cost: ${COSTS[f]}`),
    !gate.ok ? h('p', { class: 'note', style: 'color:var(--warn)' }, gate.why) : null,
    h('div', { class: 's-row' }, button(on ? 'Turn off' : 'Turn on', () => {
      if (app.observer) { toast('Observer sandbox: not changed (it would take the sidecar from your real studio).', 'warn', 5000); return; }
      const g = f === 'rtmw' ? rtmwGate() : gpuGate();
      if (!on && !g.ok) { toast(g.why, 'warn', 7000); return; }
      G.set({ [f]: { ...G.settings[f], on: !on } } as never);
      void pollServer().then(refresh);
    }, on ? '' : 'primary'),
    h('label', { class: 'row toggle', title: 'How many camera pictures a second go to the graphics card (it applies to both camera features here). 60 follows fast movement more closely but costs about twice the graphics-card work.' }, h('span', { class: 'lbl' }, 'Smoother, 60 a second'), h('span', { class: 'switch' }, h('input', { type: 'checkbox', checked: G.settings.fps >= 60, onChange: (e: Event) => { if (!app.observer) G.set({ fps: (e.target as HTMLInputElement).checked ? 60 : 30 }); } }), h('i')))),
    h('p', { class: 'note', style: 'margin:4px 0 0' }, 'Off = 30 camera pictures a second (the default). On = 60: smoother, but about twice the graphics-card work. It applies to both camera features here.'),
    f === 'maxine' && on ? slider('Maxine share', G.settings.maxine.mix, 0, 1, 0.05, (v) => { if (!app.observer) G.set({ maxine: { ...G.settings.maxine, mix: v } }); }, 'How much of each face expression comes from Maxine (the rest: MediaPipe).', { def: 0.8 }) : null,
    st,
    f === 'maxine' ? h('p', { class: 'note' }, 'Install once: press "+ NVIDIA AR SDK (Maxine)" above (it fetches and starts NVIDIA’s installer), or download ', h('b', null, 'nvidia_ar_sdk_installer_v0.8.7_blackwell.exe'), ' (AR SDK for RTX 50-series) from NVIDIA\u2019s page ', h('b', null, 'https://www.nvidia.com/broadcast-sdk-resources'), ' and run it. It goes to C:\\Program Files\\NVIDIA Corporation\\NVIDIA AR SDK. Use only NVIDIA\u2019s own download (not copies on other sites).') : null,
      h('details', { class: 'note' }, h('summary', null, 'Licence details'),
        h('p', { class: 'note' }, f === 'maxine' ? 'NVIDIA Maxine licence; not bundled with VTube Pro.' : RTMW_NOTE + ' Model: rtmw-dw-x-l, 384×288.')));
  return card;
}

/** All GPU tracking cards (the Voice / phone / 2nd camera area). */
export function gpuTrackingCards(app: App, refresh: () => void): HTMLElement {
  const wrap = h('div');
  add(wrap, h('p', { class: 'note', title: COSTS.all }, `GPU tracking — ${REQUIREMENT} ${COSTS.all}`),
    gpuSetupCard(app, refresh), gpuLipSyncCard(app, refresh), visionCard(app, refresh, 'maxine'), visionCard(app, refresh, 'rtmw'));
  if (!polledOnce) void pollServer().then(() => { if (wrap.isConnected) refresh(); });
  return wrap;
}
