// "Best lip sync for me" (owner, 2026-10-01): one guide that checks the current avatar's mouth, this computer, the mic
// and the camera, recommends Basic / Good / Best with plain reasons, applies a tier in one click, warns with the exact
// limits when someone picks more than their computer comfortably handles ("Use it anyway" / "Pick the safe option"),
// and ends with a guided test ("Say these words") that shows a muted level meter, a live mouth preview and a score.
// The same warning pattern is the general "Hardware check" for the other heavy features (graphics, GPU tracking,
// local AI): openHardwareCheck() and confirmHeavy().
//
// The logic is pure and unit-tested (shared/lipsyncAdvisor.ts, tools/lipsync_unit.ts). This file only gathers facts and
// draws. Reused, not copied: the model check (model-onboarding: runtimeFacts + faceCaps), the consented hardware scan
// (ai-local: GET /api/local-ai/last, POST /api/local-ai/scan {consent:true} only after "Yes, check my computer"), the
// GPU helpers' status (GET /api/gpu/status) and the voice / tracking settings the existing panels use.
//
// SOUND: none, ever. The test never plays anything back. Its meter reads the studio's own mic analysis (the lip-sync
// graph ends in a gain-0 sink); the observer test hook builds its own analyser on an AudioContext with sinkId
// {type:'none'} and never connects to the destination.
// Observer pages (?observer=1) never change settings: "Use Good" is a dry run there. `?lipsyncTest=<step>` (observer
// pages only) opens a step with a canned setup for screenshots: check | pick | warn | done | try | score | hw.
import type { App } from '../app.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { live } from './bits.ts';
import { LOOKAHEAD_KEY } from '../tracking/lipLookahead.ts';
import { micLevel, startCamera, startMic, copyText } from './liveOps.ts';
import {
  FAMILY_NAMES, HEAVY, OPTIONS, TEST_WORDS, TIER_LINES, TIER_NAMES, TIERS, WORD_SECONDS,
  checkHeavy, isBluetoothMic, machineFromBrowser, machineFromScan, optionById, planFor, readMachine, recommend, restMarginFor, scoreTest, scoreWord,
  type AvatarFacts, type CamFacts, type Fix, type HeavyCheck, type HeavyId, type LipPlan, type LipTier, type MachineFacts, type MicFacts,
  type Recommendation, type SetupFacts, type SidecarFacts, type TestSample, type TestScore, type TrackTier, type WordResult,
} from '../../shared/lipsyncAdvisor.ts';
import type { HwInfo } from '../../shared/localAi/recommend.ts';
import { isObserverTab } from './observerMode.ts';
import { obsMicButton } from './lipsyncObs.ts';
import { SLACK_MAX } from '../tracking/slackMouth.ts';

/** "Open Local AI": the Local AI page of this server (same origin). */
function openLocalAi(): void {
  window.open('/local-ai', '_blank', 'noopener');
}

/** How the guide reaches the rest of the studio (optional: from the shell / the Help menu). */
export interface GuideNav { go?(area: string): void; advanced?(area: string, sub?: string): void; wizard?(id: string, step?: string): void }
export interface GuideOpts { from?: 'first-run' | 'avatar' | 'golive' | 'help'; step?: 'check' | 'pick' | 'try'; nav?: GuideNav }

const TEST = (() => { try { const q = new URLSearchParams(location.search); return isObserverTab() ? q.get('lipsyncTest') : null; } catch { return null; } })();

// ================================================================ facts

let browserCache: Promise<Pick<MachineFacts, 'webgl2' | 'renderer' | 'softwareGl' | 'webgpu'> & { cores: number; deviceMemory: number | null }> | null = null;
/** What any page can read: threads, rough memory, the 3D renderer, WebGPU (no prompt, nothing stored). */
function browserFacts() {
  browserCache ??= (async () => {
    let renderer = '', webgl2 = false;
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      webgl2 = !!gl;
      if (gl) {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        renderer = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    } catch { /* no 3D */ }
    let webgpu: boolean | null = null;
    try {
      const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      webgpu = gpu ? !!(await Promise.race([gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(null), 1500))])) : false;
    } catch { webgpu = false; }
    const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null;
    return { webgl2, renderer, softwareGl: /swiftshader|llvmpipe|software|basic render/i.test(renderer), webgpu, cores: navigator.hardwareConcurrency || 4, deviceMemory };
  })();
  return browserCache;
}

const json = async <T>(url: string, init?: RequestInit): Promise<T | null> => {
  try { const r = await fetch(url, init); return r.ok ? (await r.json()) as T : null; } catch { return null; }
};

async function helperKind(): Promise<SetupFacts['helper']> {
  return 'local';
}

/** The avatar's mouth, from model-onboarding's own check (no copy of its rules). */
async function avatarFacts(app: App): Promise<AvatarFacts | null> {
  const rt = app.runtime, p = app.profile;
  if (!rt || !p) return null;
  try {
    const [{ runtimeFacts }, { faceCaps, perfectSync }] = await Promise.all([import('../onboarding/modelPreview.ts'), import('../onboarding/modelCheck.ts')]);
    const f = runtimeFacts(rt, p.modelFile);
    const c = faceCaps(f);
    return { name: p.name, mouth: c.mouth, vowels: c.vowels, seal: c.seal, mouthShapes: c.arkit.filter((k) => k.startsWith('mouth') || k === 'jawOpen').length, perfectSync: perfectSync(f.morphs, p.faceMap) };
  } catch { return { name: p.name, mouth: rt.info.proceduralMouth ? 'drawn' : 'vowels', vowels: [], seal: false, mouthShapes: 0, perfectSync: false }; }
}

function micFacts(app: App): MicFacts | null {
  const A = app.audio;
  if (!A.active) return { on: false, label: '', bluetooth: false, filterOn: false };
  return { on: true, label: A.deviceLabel, bluetooth: isBluetoothMic(A.deviceLabel), filterOn: !!A.fx };
}
function camFacts(app: App): CamFacts {
  if (!app.trackingOn) return { on: false, width: 0, height: 0, fps: 0, trackHz: 0, faceMs: 0, cpuTracking: false };
  const m = /(\d+)×(\d+)@(\d+)/.exec(app.stats.camera ?? '');
  return { on: true, width: Number(m?.[1] ?? app.mainCam?.w ?? 0), height: Number(m?.[2] ?? app.mainCam?.h ?? 0), fps: Number(m?.[3] ?? 0),
    trackHz: app.stats.trackFps ?? 0, faceMs: app.tracker.timing?.face ?? app.stats.inferMs ?? 0, cpuTracking: faceOnCpu(app) };
}
/** The FACE model runs on the processor (per model once results arrive: Auto can move the face alone, e.g.
 *  'face CPU · pose GPU · hands GPU'; else the tracker's summary: the main-thread fallback, or everything on the CPU). */
function faceOnCpu(app: App): boolean {
  let d: string | undefined;
  try { d = app.tracker.models?.().roles?.face?.delegate; } catch { /* older tracker */ }
  return (d ?? app.tracker.delegate ?? app.stats.delegate) === 'CPU';
}

type GpuStatus = { gpu?: { name: string; vramMB: number; rtx50: boolean; nvidia: boolean }; have?: { venv: boolean; maxineSdk: boolean } };
async function sidecarFacts(helper: SetupFacts['helper']): Promise<SidecarFacts | null> {
  if (helper === 'none') return null;
  const s = await json<GpuStatus>('/api/gpu/status');
  if (!s?.gpu) return s ? { nvidia: false, rtx50: false, gpuName: '', vramMB: 0, setUp: !!s.have?.venv, maxineSdk: !!s.have?.maxineSdk } : null;
  return { nvidia: s.gpu.nvidia, rtx50: s.gpu.rtx50, gpuName: s.gpu.name, vramMB: s.gpu.vramMB, setUp: !!s.have?.venv, maxineSdk: !!s.have?.maxineSdk };
}

/** The helper's last consented scan (this helper run), if any. Never starts a scan. */
async function lastScan(helper: SetupFacts['helper']): Promise<HwInfo | null> {
  if (helper === 'none') return null;
  const r = await json<{ scanned?: boolean; hw?: HwInfo }>('/api/local-ai/last');
  return r?.scanned && r.hw ? r.hw : null;
}
/** Only after the user said yes ("Yes, check my computer"). Read-only; the result stays in the helper's memory. */
async function consentedScan(): Promise<HwInfo | null> {
  const r = await json<{ hw?: HwInfo }>('/api/local-ai/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }) });
  return r?.hw ?? null;
}

export async function gatherFacts(app: App, opts: { hw?: HwInfo | null } = {}): Promise<SetupFacts> {
  const helper = await helperKind();
  const [b, avatar, sidecars, hw] = await Promise.all([browserFacts(), avatarFacts(app), sidecarFacts(helper), opts.hw !== undefined ? Promise.resolve(opts.hw) : lastScan(helper)]);
  const machine = hw ? machineFromScan(hw, b) : machineFromBrowser({ cores: b.cores, deviceMemory: b.deviceMemory, renderer: b.renderer, webgl2: b.webgl2, webgpu: b.webgpu, platform: navigator.platform, ua: navigator.userAgent });
  return { machine, avatar, mic: micFacts(app), camera: camFacts(app), helper, sidecars };
}

// ================================================================ apply

const TRACK_OF = (app: App) => app.tier as TrackTier;

/** Do it: the same switches the Voice / Natural / GPU panels use. Observer pages: a dry run (nothing changes). */
export async function applyPlan(app: App, plan: LipPlan): Promise<string[]> {
  const done: string[] = [];
  const dry = app.observer;
  const A = app.audio;
  const say = (t: string) => done.push(t);
  if (plan.filterOn && A.voiceSettings.filter === 'off') { if (!dry) { try { await A.setVoiceSettings({ filter: 'standard' }); } catch { /* raw mic */ } } say('Noise filter on.'); }
  if (plan.voiceModel) { if (!dry) A.setNeural({ on: true, mix: -1 }); say('Sound shapes on.'); }
  if (app.lookahead.delayMs !== plan.lookaheadMs) {
    if (!dry) { app.lookahead.delayMs = plan.lookaheadMs; try { localStorage.setItem(LOOKAHEAD_KEY, String(plan.lookaheadMs)); } catch { /* private mode */ } }
    say(plan.lookaheadMs ? `Shapes land on time (${plan.lookaheadMs} ms).` : 'No mic delay needed.');
  }
  if (plan.natural === true && !app.face.natural.enabled) { if (!dry) app.face.natural.setEnabled(true); say('Natural mode on.'); }
  if (app.tracker.mouthImage !== plan.mouthDetail) {
    if (!dry) { app.tracker.mouthImage = plan.mouthDetail; try { localStorage.setItem('vtp.mouthImage', plan.mouthDetail ? '1' : '0'); } catch { /* private mode */ } }
    say(plan.mouthDetail ? 'Teeth and tongue on.' : 'Teeth and tongue off.');
  }
  if (A.a2fSettings.on !== plan.gpuLipSync) { if (!dry) A.setA2f({ on: plan.gpuLipSync }); say(plan.gpuLipSync ? 'GPU lip sync on.' : 'GPU lip sync off.'); }
  if (plan.tracking && plan.tracking !== TRACK_OF(app)) { if (!dry) app.setTier(plan.tracking); say(`Face tracking quality: ${plan.tracking}.`); }
  return done;
}

// ================================================================ the dialog

let openEl: HTMLElement | null = null;
let cssDone = false;
type Step = 'check' | 'pick' | 'warn' | 'done' | 'try' | 'score';
const STEP_NO: Record<Step, number> = { check: 1, pick: 2, warn: 2, done: 2, try: 3, score: 3 };

interface State {
  step: Step;
  facts: SetupFacts | null;
  rec: Recommendation | null;
  pick: LipTier | null;
  applied: { tier: LipTier; lines: string[]; plan: LipPlan } | null;
  scanning: boolean;
  scanAsk: boolean;
  scanError: string;
  test: { running: boolean; ix: number; t0: number; samples: TestSample[][]; results: WordResult[]; score: TestScore | null; suggestMax?: number | null };
}

export function openLipSyncGuide(app: App, opts: GuideOpts = {}) {
  if (openEl) return;
  injectCss();
  const st: State = { step: opts.step ?? 'check', facts: null, rec: null, pick: null, applied: null, scanning: false, scanAsk: false, scanError: '',
    test: { running: false, ix: 0, t0: 0, samples: [], results: [], score: null } };
  const prev = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'ls-body' });
  const dlg = h('div', { class: 'ls-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ls-title', tabindex: -1 }, body);
  const back = h('div', { class: 'ls-back', onClick: (e: Event) => { if (e.target === back) close(); } }, dlg);
  openEl = back;
  let meter: MeterSource | null = null;
  const close = () => {
    if (!openEl) return;
    st.test.running = false;
    meter?.stop(); meter = null;
    back.classList.add('out');
    const el = back; openEl = null;
    window.setTimeout(() => el.remove(), 170);
    window.removeEventListener('keydown', onKey, true);
    prev?.focus?.();
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);

  const refreshFacts = async (hw?: HwInfo | null) => {
    st.facts = TEST ? testFacts(TEST_SCENARIO) : await gatherFacts(app, hw !== undefined ? { hw } : {});
    st.rec = recommend(st.facts);
    st.pick ??= st.rec.tier;
    paint();
  };

  const paint = () => {
    body.replaceChildren(...nn(view()));
    back.classList.toggle('dock', st.step === 'try' || st.step === 'score');
  };

  // ---------------------------------------------------------------- views
  const head = (title: string, lead: string, next?: string) => [
    h('div', { class: 'ls-top' },
      h('p', { class: 'ls-eyebrow' }, h('i', { 'aria-hidden': 'true' }), `Step ${STEP_NO[st.step]} of 3 · Best lip sync for me`),
      h('button', { class: 'ls-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: close }, icon('x', 18))),
    h('h2', { id: 'ls-title' }, title),
    h('p', { class: 'ls-lead' }, lead),
    next ? h('p', { class: 'ls-next' }, h('b', null, 'Next · '), next) : null,
  ];

  const view = (): (Node | null)[] => {
    const f = st.facts, rec = st.rec;
    if (!f || !rec) return [...head('Checking your setup…', 'This takes a second. Nothing is changed yet.'), h('div', { class: 'ls-spin', 'aria-hidden': 'true' })];
    switch (st.step) {
      case 'check': return checkView(f, rec);
      case 'pick': return pickView(f, rec);
      case 'warn': return warnView(f, rec);
      case 'done': return doneView();
      case 'try': return tryView(f);
      case 'score': return scoreView(f);
    }
  };

  // 1. check ----------------------------------------------------------
  const row = (state: 'ok' | 'warn' | 'err' | 'off', ic: string, title: string, detail: string, act?: Node | null) =>
    h('div', { class: `ls-row ${state}` }, h('span', { class: 'ls-ic', 'aria-hidden': 'true' }, icon(ic, 18)), h('div', { class: 'ls-words' }, h('b', null, title), h('span', null, detail)), act ?? null);
  const btn = (text: string, run: () => void, cls = '') => h('button', { class: `ls-btn ${cls}`, onClick: run }, text);
  const fixBtn = (fix: Fix): Node | null => {
    if (fix === 'mic') return btn('Turn on mic', () => void startMic(app).then(() => refreshFacts()));
    if (fix === 'camera') return btn('Turn on camera', () => void startCamera(app).then(() => refreshFacts()));
    if (fix === 'model') return btn('Fix my model', () => { close(); void import('./modelWizard.ts').then((m) => m.openModelWizard(app)).catch(() => opts.nav?.go?.('me')); });
    if (fix === 'gpu-setup') return opts.nav?.advanced ? btn('Open GPU setup', () => { close(); opts.nav!.advanced!('live', 'voice'); }) : null;
    return null;
  };

  const checkView = (f: SetupFacts, rec: Recommendation): (Node | null)[] => {
    const a = f.avatar, m = f.machine, read = rec.machine;
    const MOUTH: Record<AvatarFacts['mouth'], string> = {
      shapes: `${a?.perfectSync ? 'Full face shapes' : `${a?.mouthShapes ?? 0} mouth shapes`}. Every lip sync level shows well.`,
      vowels: `Talks with ${a?.vowels.length ? a.vowels.map((v) => v.toUpperCase()).join(' ') : 'open and close'} shapes. ${a?.seal ? 'Lips can press for M, B, P.' : 'Lips can’t fully press for M, B, P.'}`,
      jaw: 'Opens and closes with a jaw. Great for robots and puppets.',
      drawn: 'VTube Pro draws its mouth. It follows every sound.',
      none: 'No mouth shapes yet. We can add a drawn mouth.',
    };
    const gpu = m.gpu;
    const compLine = `${m.cores} threads${m.ramGB ? ` · ${Math.round(m.ramGB)}${m.source === 'browser' && m.ramGB >= 8 ? '+' : ''} GB memory` : ''}${gpu ? ` · ${gpu.name}${gpu.vramGB ? ` (${gpu.vramGuess ? 'about ' : ''}${gpu.vramGB} GB)` : ''}` : ''}`;
    const CLS = { low: 'On the lighter side', mid: 'Good for streaming', high: 'Plenty of power' } as const;
    const scanBox = st.scanAsk ? h('div', { class: 'ls-consent' },
      h('b', null, 'Check your computer in detail?'),
      h('p', null, 'VTube Pro reads your graphics card, memory and processor. Nothing is saved or sent anywhere.'),
      h('div', { class: 'ls-btns' },
        btn(st.scanning ? 'Checking…' : 'Yes, check my computer', () => {
          if (st.scanning) return;
          st.scanning = true; st.scanError = ''; paint();
          void (TEST ? Promise.resolve(null) : consentedScan()).then(async (hw) => {
            st.scanning = false; st.scanAsk = false;
            if (!hw && !TEST) st.scanError = 'The check didn’t finish. We used what your browser can see.';
            await refreshFacts(hw ?? null);
          });
        }, 'primary'),
        btn('Not now', () => { st.scanAsk = false; paint(); }, 'ghost'))) : null;
    const canScan = f.helper !== 'none' && m.source === 'browser';
    return [
      ...head('Let’s find your best lip sync', 'We check your model, computer, mic and camera. Then we pick what fits.', 'Press Show my best setup.'),
      h('div', { class: 'ls-rows' },
        row(a ? (a.mouth === 'none' ? 'err' : a.mouth === 'vowels' && !a.seal ? 'warn' : 'ok') : 'off', 'me', a ? `Your model: ${a.name}` : 'No avatar yet', a ? MOUTH[a.mouth] : 'Pick an avatar in Me first.', a?.mouth === 'none' ? fixBtn('model') : null),
        row(read.cls === 'low' ? 'warn' : 'ok', 'power', `Your computer: ${CLS[read.cls]}`, compLine,
          canScan && !st.scanAsk ? btn('Check in detail', () => { st.scanAsk = true; paint(); }, 'ghost') : m.source === 'scan' ? h('span', { class: 'ls-tag' }, 'checked') : null),
        scanBox,
        st.scanError ? h('p', { class: 'ls-note warn' }, st.scanError) : null,
        row(f.mic?.on ? (f.mic.bluetooth ? 'warn' : 'ok') : 'off', 'mic', f.mic?.on ? 'Microphone on' : 'Microphone off', f.mic?.on ? (f.mic.bluetooth ? `${f.mic.label}: Bluetooth mics sound muffled.` : f.mic.label || 'Your mic is ready.') : 'The mouth follows your voice when it is on.', f.mic?.on ? null : fixBtn('mic')),
        row(f.camera?.on ? (f.camera.trackHz > 0 && f.camera.trackHz < 20 ? 'warn' : 'ok') : 'off', 'camera', f.camera?.on ? 'Camera on' : 'Camera off',
          f.camera?.on ? `${f.camera.width && f.camera.height ? `${f.camera.width}×${f.camera.height}` : 'Tracking'}${f.camera.trackHz ? ` · ${Math.round(f.camera.trackHz)} updates a second` : ''}.` : 'Your face drives the expressions when it is on.', f.camera?.on ? null : fixBtn('camera'))),
      details('What we looked at', [
        ...read.why,
        m.source === 'scan' ? 'Computer facts come from VTube Pro’s check (you said yes). They stay in its memory only.' : 'Computer facts come from your browser only. It shows memory rounded down.',
        `3D drawing: ${m.webgl2 ? 'WebGL 2 works' : 'WebGL 2 missing'}${m.renderer ? ` (${m.renderer})` : ''}. WebGPU: ${m.webgpu === null ? 'not checked' : m.webgpu ? 'available' : 'not available'}.`,
        f.sidecars ? `GPU add-ons: ${f.sidecars.gpuName || 'no NVIDIA card'}${f.sidecars.rtx50 ? ' (RTX 50-series)' : ''} · ${f.sidecars.setUp ? 'set up' : 'not set up'}.` : 'GPU add-ons: VTube Pro is not connected.',
      ]),
      h('div', { class: 'ls-foot' }, btn('Show my best setup', () => { st.step = 'pick'; paint(); }, 'primary big'), btn('Close', close, 'ghost')),
    ];
  };

  // 2. pick ----------------------------------------------------------
  const tierCard = (t: LipTier, f: SetupFacts, rec: Recommendation) => {
    const rep = rec.tiers[t];
    const isRec = rec.tier === t, on = st.pick === t;
    const stretch = rep.stretch.filter((s) => s.id !== 'voice').length > 0;
    const own = OPTIONS.filter((o) => o.tier === t);
    const items = (t === 'basic' ? own : [{ id: 'prev' } as const, ...own]).map((o) => {
      if (o.id === 'prev') return h('li', { class: 'ok' }, h('span', { 'aria-hidden': 'true' }, '✓'), `Everything in ${t === 'good' ? 'Basic' : 'Good'}`);
      const sk = rep.skipped.find((s) => s.id === o.id), sx = rep.stretch.find((s) => s.id === o.id);
      return h('li', { class: sk ? 'skip' : sx ? 'warn' : 'ok', title: sk ? sk.why : sx ? sx.limits.join(' ') : o.what },
        h('span', { 'aria-hidden': 'true' }, sk ? '–' : sx ? '!' : '✓'), o.name, sk ? h('small', null, sk.why) : null);
    });
    return h('button', { class: `ls-tier ${on ? 'on' : ''} ${isRec ? 'rec' : ''}`, role: 'radio', 'aria-checked': String(on), 'data-tier': t, onClick: () => { st.pick = t; paint(); } },
      h('span', { class: 'ls-tier-top' }, h('b', null, TIER_NAMES[t]), isRec ? h('span', { class: 'ls-badge' }, 'Best for you') : stretch ? h('span', { class: 'ls-badge warn' }, 'A stretch here') : null),
      h('span', { class: 'ls-tier-line' }, TIER_LINES[t]),
      h('ul', null, ...items));
  };
  const pickView = (f: SetupFacts, rec: Recommendation): (Node | null)[] => {
    const t = st.pick ?? rec.tier;
    const rep = rec.tiers[t];
    const stretch = rep.stretch.filter((s) => s.id !== 'voice');
    const notes = OPTIONS.filter((o) => rep.applied.includes(o.id) && o.notes?.length).flatMap((o) => o.notes!);
    return [
      ...head(`We recommend ${TIER_NAMES[rec.tier]}`, rec.why[0] ?? 'This fits your computer and your model.', `Press Use ${TIER_NAMES[t]}. You can change it any time.`),
      rec.first.length ? h('div', { class: 'ls-first' }, ...rec.first.map((x) => h('div', { class: 'ls-firstrow' }, h('span', null, x.text), fixBtn(x.fix)))) : null,
      h('div', { class: 'ls-tiers', role: 'radiogroup', 'aria-label': 'Lip sync level' }, ...TIERS.map((x) => tierCard(x, f, rec))),
      rec.why.length > 1 ? h('p', { class: 'ls-note' }, rec.why.slice(1).join(' ')) : null,
      notes.length ? h('div', { class: 'ls-know' }, h('b', null, 'Good to know'), h('ul', null, ...notes.map((n) => h('li', null, n)))) : null,
      details('What each level turns on', OPTIONS.map((o) => `${o.name} (${TIER_NAMES[o.tier]}+): ${o.tech}`)),
      h('div', { class: 'ls-foot' },
        btn(`Use ${TIER_NAMES[t]}`, () => { if (stretch.length) { st.step = 'warn'; paint(); } else void doApply(t); }, 'primary big'),
        btn('Back', () => { st.step = 'check'; paint(); }, 'ghost')),
    ];
  };

  // 2b. the warning ------------------------------------------------------
  const warnView = (f: SetupFacts, rec: Recommendation): (Node | null)[] => {
    const t = st.pick ?? rec.tier;
    const rep = rec.tiers[t];
    const lines = rep.stretch.filter((s) => s.id !== 'voice');
    const limits = [...new Set(lines.flatMap((s) => s.limits))];
    return [
      ...head(`${TIER_NAMES[t]} is a stretch for this computer`, 'It will still work. Here is what you may notice.', `Use it anyway, or pick ${TIER_NAMES[rec.tier]}.`),
      h('div', { class: 'ls-warn', role: 'alert' },
        h('div', { class: 'ls-warn-ic', 'aria-hidden': 'true' }, '!'),
        h('div', null,
          h('b', null, 'You may notice'),
          h('ul', null, ...limits.map((l) => h('li', null, l))),
          h('p', { class: 'ls-warn-from' }, `From: ${lines.map((s) => optionById(s.id).name).join(', ')}.`))),
      rep.skipped.length ? h('p', { class: 'ls-note' }, `Left out here: ${rep.skipped.map((s) => `${optionById(s.id).name} (${lower1(s.why.replace(/\.$/, ''))})`).join('; ')}.`) : null,
      h('p', { class: 'ls-note' }, 'You can switch back any time from Help → Best lip sync for me.'),
      h('div', { class: 'ls-foot' },
        btn('Pick the safe option', () => { st.pick = rec.tier; void doApply(rec.tier); }, 'primary big'),
        btn('Use it anyway', () => void doApply(t), 'big'),
        btn('Back', () => { st.step = 'pick'; paint(); }, 'ghost')),
    ];
  };

  const doApply = async (t: LipTier) => {
    const f = st.facts!;
    const plan = planFor(t, f, { tracking: TRACK_OF(app) });
    const lines = await applyPlan(app, plan);
    st.applied = { tier: t, lines, plan };
    st.step = 'done';
    paint();
    if (app.observer) toast('Observer sandbox: a dry run. Nothing was changed.', 'info', 5000);
  };

  // 2c. done -------------------------------------------------------------
  const doneView = (): (Node | null)[] => {
    const a = st.applied!;
    const d = a.plan.lookaheadMs;
    return [
      ...head(`You’re all set: ${TIER_NAMES[a.tier]} lip sync`, app.observer ? 'Observer sandbox: this was a dry run. Your real studio is unchanged.' : 'Saved on this computer. It works with every avatar.', 'Try it: say a few words and watch the mouth.'),
      h('ul', { class: 'ls-donelist' }, ...(a.lines.length ? a.lines : ['Everything was already set.']).map((l) => h('li', null, h('span', { 'aria-hidden': 'true' }, '✓'), l))),
      a.plan.skipped.length ? h('p', { class: 'ls-note' }, `Left out: ${a.plan.skipped.map((s) => optionById(s.id).name).join(', ')}.`) : null,
      d ? h('div', { class: 'ls-obs' },
        h('b', null, `One more thing in OBS: delay your mic by ${d} ms`),
        obsMicButton(d, app.observer),
        h('p', null, 'Or by hand:'),
        h('ol', null,
          h('li', null, 'In OBS, open Audio Mixer, then the ⋮ menu on your mic.'),
          h('li', null, 'Pick Advanced Audio Properties.'),
          h('li', null, `Set Sync Offset to ${d} ms. `, h('button', { class: 'ls-link', onClick: () => copyText(String(d), 'Sync Offset') }, 'Copy'))),
        h('p', null, 'Viewers then hear you right on the mouth.')) : a.tier === 'basic' ? h('div', { class: 'ls-note' }, 'If you set a Sync Offset on your mic in OBS before, set it back to 0 ms.', obsMicButton(0, app.observer)) : null,
      a.plan.runTest ? h('p', { class: 'ls-note' }, 'Tip: the 45-second test (Tracking) tunes it to your voice.') : null,
      h('div', { class: 'ls-foot' }, btn('Try it now', () => { st.step = 'try'; paint(); }, 'primary big'), btn('Done', close, 'ghost')),
    ];
  };

  // 3. try ---------------------------------------------------------------
  const mouthCv = h('canvas', { class: 'ls-mouth', width: 240, height: 120, 'aria-label': 'Live mouth preview' });
  const tryView = (f: SetupFacts): (Node | null)[] => {
    const T = st.test;
    const w = TEST_WORDS[Math.min(T.ix, TEST_WORDS.length - 1)];
    const micOk = app.audio.active || !!TEST;
    const bar = h('i', { style: 'width:0%' });
    const prog = h('i', { style: 'width:0%' });
    meter ??= makeMeter(app);
    live(() => {
      if (!bar.isConnected) return false;
      bar.style.width = `${Math.round((meter?.level() ?? 0) * 100)}%`;
      if (T.running) prog.style.width = `${Math.min(100, ((performance.now() - T.t0) / (WORD_SECONDS * 1000)) * 100)}%`;
      return true;
    });
    drawLoop(mouthCv, () => (meter ? meter.mouth() : null));
    return [
      ...head('Say these words', 'Say each one out loud. Watch the mouth. Nothing is recorded or played back.', T.running ? 'Keep going. The next word comes by itself.' : 'Press Start the test.'),
      h('div', { class: 'ls-try' },
        h('div', { class: 'ls-word', 'aria-live': 'polite' },
          h('span', { class: 'ls-wordn' }, T.running ? `Word ${T.ix + 1} of ${TEST_WORDS.length}` : `${TEST_WORDS.length} short lines`),
          h('b', null, T.running ? (w.quiet ? 'Now stay quiet and relax your face' : `“${w.say}”`) : `${TEST_WORDS.filter((x) => !x.quiet).map((x) => `“${x.say}”`).join(' · ')}, then a few quiet seconds`),
          T.running ? h('div', { class: 'ls-prog' }, prog) : null),
        h('div', { class: 'ls-live' },
          h('div', null, h('span', { class: 'ls-cap' }, 'Your voice'), h('div', { class: 'ls-meter', role: 'meter', 'aria-label': 'Microphone level' }, bar)),
          h('div', null, h('span', { class: 'ls-cap' }, 'The mouth'), mouthCv))),
      !micOk ? h('div', { class: 'ls-firstrow' }, h('span', null, 'Turn on your microphone to take the test.'), fixBtn('mic')) : null,
      h('p', { class: 'ls-note' }, 'Your avatar moves too. The meter only shows your level. There is no sound.'),
      h('div', { class: 'ls-foot' },
        T.running ? btn('Stop', () => { T.running = false; paint(); }, 'big') : btn('Start the test', () => startTest(f), micOk ? 'primary big' : 'big'),
        btn('Back', () => { T.running = false; st.step = st.applied ? 'done' : 'pick'; paint(); }, 'ghost')),
    ];
  };
  const startTest = (f: SetupFacts) => {
    if (!app.audio.active && !TEST) { toast('Turn on your microphone first.', 'warn'); return; }
    const T = st.test;
    T.running = true; T.ix = 0; T.samples = TEST_WORDS.map(() => []); T.results = []; T.score = null; T.t0 = performance.now();
    paint();
    const tick = () => {
      if (!T.running || !openEl) return;
      const s = meter?.sample();
      if (s) T.samples[T.ix].push(s);
      if (performance.now() - T.t0 >= WORD_SECONDS * 1000) {
        const tw = TEST_WORDS[T.ix];
        T.results.push(scoreWord(tw, T.samples[T.ix]));
        // the quiet line: a mouth that stayed open while quiet → OFFER this performer's resting mouth (saved only on "Use it")
        if (tw.quiet) T.suggestMax = (T.results[T.results.length - 1].restOpen ?? 0) > 0.25 ? restMarginFor(T.samples[T.ix], app.face.slack.max) : null;
        T.ix++;
        if (T.ix >= TEST_WORDS.length) {
          T.running = false;
          T.score = scoreTest(T.results, { avatar: f.avatar, mic: f.mic, tier: st.applied?.tier ?? st.rec?.tier });
          st.step = 'score'; paint(); return;
        }
        T.t0 = performance.now(); paint();
      }
      window.setTimeout(tick, 33);
    };
    tick();
  };
  /** The resting-mouth margin (slackMouth.ts): the value the quiet line suggests (saved only on "Use it"), or the one in
   *  use with a Reset back to the default. Observers: never saved. */
  const restMouthCard = (): Node | null => {
    const saved = (() => { try { return localStorage.getItem('vtp.slackMax'); } catch { return null; } })();
    const sug = st.test.suggestMax;
    const pct = (v: number) => `${Math.round(v * 100)} %`;
    if (sug) return h('div', { class: 'ls-know', 'data-ui': 'rest-mouth' },
      h('b', null, 'Teach it your resting mouth?'),
      h('p', null, `Your lips rest a little apart. We can treat a resting opening up to ${pct(sug)} of your eye width as closed (now ${pct(app.face.slack.max)}).`),
      h('div', { class: 'ls-foot' },
        btn('Use it', () => { st.test.suggestMax = null; if (!app.observer) { app.face.slack.max = sug; try { localStorage.setItem('vtp.slackMax', String(sug)); } catch { /* private mode */ } } toast(app.observer ? 'Observer sandbox: not saved.' : 'Saved: your resting mouth reads as closed now. Test again to check.', 'ok', 5000); paint(); }, 'primary'),
        btn('Not now', () => { st.test.suggestMax = null; paint(); }, 'ghost')));
    if (saved) return h('div', { class: 'ls-know', 'data-ui': 'rest-mouth' },
      h('p', null, `Your resting mouth is tuned: up to ${pct(Number(saved))} of your eye width reads as closed.`),
      btn('Reset to the default', () => { try { localStorage.removeItem('vtp.slackMax'); } catch { /* */ } app.face.slack.max = SLACK_MAX; toast('Reset: the default resting mouth again.', 'ok', 4000); paint(); }, 'ghost'));
    return null;
  };
  const scoreView = (f: SetupFacts): (Node | null)[] => {
    const s = st.test.score ?? scoreTest(st.test.results, { avatar: f.avatar, mic: f.mic });
    const fams = (r: WordResult) => r.found.map((x) => FAMILY_NAMES[x]).join(', ') || 'no clear shape';
    return [
      ...head(s.headline, s.grade === 'help' ? 'Here is what would help most.' : 'Here is how each line went.', s.grade === 'great' ? 'You’re ready to stream.' : 'Try a tip, then test again.'),
      h('div', { class: `ls-score ${s.grade}` }, h('b', null, String(s.score)), h('span', null, 'out of 100')),
      h('ul', { class: 'ls-words-res' }, ...st.test.results.map((r, i) => h('li', { class: r.score >= 75 ? 'ok' : r.score >= 50 ? 'warn' : 'err' },
        h('b', null, TEST_WORDS[i].quiet ? 'A few quiet seconds' : `“${TEST_WORDS[i].say}”`), h('span', null, r.restOpen !== undefined ? (r.restOpen > 0.25 ? 'The mouth stayed a little open.' : 'The mouth stayed shut. Good.') : TEST_WORDS[i].quiet ? 'You were talking, so we skipped this one.' : !r.heard ? 'Not heard.' : !r.moved ? 'Heard, but the mouth barely moved.' : `Showed: ${fams(r)}.`)))),
      s.tips.length ? h('div', { class: 'ls-know' }, h('b', null, 'Tips'), h('ul', null, ...s.tips.map((t) => h('li', null, t)))) : null,
      restMouthCard(),
      h('div', { class: 'ls-foot' }, btn('Test again', () => { st.step = 'try'; st.test.results = []; paint(); }, s.grade === 'great' ? 'big' : 'primary big'),
        s.grade !== 'great' ? btn('Change my level', () => { st.step = 'pick'; paint(); }) : null,
        btn('Done', close, s.grade === 'great' ? 'primary big' : 'ghost')),
    ];
  };

  document.body.append(back);
  paint();
  dlg.focus({ preventScroll: true });
  void refreshFacts().then(() => {
    if (TEST === 'pick' || TEST === 'warn' || TEST === 'done' || TEST === 'try' || TEST === 'score') {
      if (TEST === 'warn') { st.pick = 'best'; st.step = 'warn'; }
      else if (TEST === 'done') { void doApply(st.rec!.tier); return; }
      else if (TEST === 'score') { st.test.results = TEST_WORDS.map((w, i) => (w.quiet ? { id: w.id, heard: true, moved: true, found: [], missing: [], score: 45, restOpen: 0.4 } : { id: w.id, heard: true, moved: true, found: i === 1 ? [] : w.expect, missing: i === 1 ? w.expect : [], score: i === 1 ? 50 : 100 })); st.test.score = scoreTest(st.test.results, { avatar: st.facts!.avatar, mic: st.facts!.mic, tier: 'good' }); st.test.suggestMax = 0.17; st.step = 'score'; }
      else st.step = TEST as Step;
      paint();
    }
  });
}

// ================================================================ meter + mouth preview (silent)

interface MouthNow { open: number; wide: number; pucker: number; closure: number; fv: number }
interface MeterSource { level(): number; mouth(): MouthNow | null; sample(): TestSample; stop(): void }

/** The studio's own mic analysis + the fused mouth. Observer test pages: a private muted analyser on the (fake) mic. */
function makeMeter(app: App): MeterSource {
  if (app.audio.active || !TEST) {
    return {
      level: () => micLevel(app),
      mouth: () => { const m = app.frame.mouth; return { open: m.open, wide: m.wide, pucker: Math.max(m.pucker, m.funnel), closure: m.closure ?? 0, fv: m.fv ?? 0 }; },
      sample: () => {
        const m = app.frame.mouth, st = app.audio.fx?.stat;
        return { level: micLevel(app), voiced: st ? st.gate > 0 : app.audio.last.level > 0.05, open: m.open, closure: m.closure ?? 0, fv: m.fv ?? 0, pucker: m.pucker, funnel: m.funnel, wide: m.wide, vis: app.frame.visemes,
          ...(app.frame.tracked ? { gap: Math.max(0, app.face.lipGap - app.face.lipRestN) } : {}) };
      },
      stop: () => { /* the studio owns its mic */ },
    };
  }
  // test hook only (observer + ?lipsyncTest): a silent analyser on a fresh (fake, headless) mic stream
  let lvl = 0, an: AnalyserNode | null = null, ctx: AudioContext | null = null, stream: MediaStream | null = null, stopped = false;
  const buf = new Float32Array(1024);
  void navigator.mediaDevices?.getUserMedia({ audio: true }).then((s) => {
    if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    ctx = new AudioContext({ sinkId: { type: 'none' } } as AudioContextOptions);
    an = ctx.createAnalyser(); an.fftSize = 1024;
    ctx.createMediaStreamSource(s).connect(an); // analysis only: never connected to the speakers
  }).catch(() => { /* no mic: the meter stays at 0 */ });
  const read = () => {
    if (!an) return 0;
    an.getFloatTimeDomainData(buf);
    let e = 0; for (const x of buf) e += x * x;
    const db = 10 * Math.log10(e / buf.length + 1e-12);
    lvl = Math.min(1, Math.max(0, (db + 70) / 60));
    return lvl;
  };
  const mouth = (): MouthNow => { const l = read(); const t = performance.now() / 1000; return { open: l * 0.8, wide: 0.3 + 0.3 * Math.sin(t * 2.1), pucker: Math.max(0, Math.sin(t * 1.3)) * 0.5, closure: l < 0.2 ? 0.6 : 0, fv: 0 }; };
  return {
    level: () => read(),
    mouth,
    sample: () => { const m = mouth(); return { level: lvl, voiced: lvl > 0.12, open: m.open, closure: m.closure, fv: m.fv, pucker: m.pucker, funnel: 0, wide: m.wide }; },
    stop: () => { stopped = true; stream?.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => {}); an = null; },
  };
}

const drawing = new WeakSet<HTMLCanvasElement>();
/** A simple drawn mouth from the live values (what the avatar's mouth gets), ~30 fps while on screen. */
function drawLoop(cv: HTMLCanvasElement, get: () => MouthNow | null) {
  if (drawing.has(cv)) return;
  drawing.add(cv);
  const g = cv.getContext('2d');
  if (!g) return;
  const sm = { open: 0, wide: 0, pucker: 0, closure: 0, fv: 0 };
  const frame = () => {
    if (!cv.isConnected) { drawing.delete(cv); return; }
    const m = get();
    if (m) for (const k of Object.keys(sm) as (keyof MouthNow)[]) sm[k] += (Math.max(0, Math.min(1, m[k])) - sm[k]) * 0.5;
    const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2;
    g.clearRect(0, 0, W, H);
    const half = 70 * (1 + 0.35 * sm.wide - 0.45 * sm.pucker);
    const open = Math.max(2, 46 * sm.open * (1 - 0.85 * sm.closure));
    // lips
    g.lineJoin = 'round';
    g.fillStyle = '#2a0f14';
    g.strokeStyle = '#7bd88f';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(cx - half, cy);
    g.bezierCurveTo(cx - half * 0.5, cy - open * 0.9 - 6, cx + half * 0.5, cy - open * 0.9 - 6, cx + half, cy);
    g.bezierCurveTo(cx + half * 0.5, cy + open + 6, cx - half * 0.5, cy + open + 6, cx - half, cy);
    g.closePath();
    g.fill(); g.stroke();
    // teeth on the lip (F / V)
    if (sm.fv > 0.15) { g.fillStyle = '#eef3ef'; g.fillRect(cx - half * 0.45, cy - 3, half * 0.9, 6 * sm.fv + 2); }
    window.setTimeout(() => requestAnimationFrame(frame), 33);
  };
  frame();
}

// ================================================================ the general hardware check

/** A small "Use it anyway / Pick the safe option" dialog for one heavy feature. Resolves 'ok' when it fits. */
export async function confirmHeavy(app: App, id: HeavyId, facts?: SetupFacts): Promise<'ok' | 'use' | 'safe' | 'blocked'> {
  const f = facts ?? (TEST ? testFacts(TEST_SCENARIO) : await gatherFacts(app));
  const c = checkHeavy(id, f);
  if (c.fit === 'ok') return 'ok';
  injectCss();
  return new Promise((resolve) => {
    const done = (v: 'use' | 'safe' | 'blocked') => { back.remove(); window.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(c.fit === 'blocked' ? 'blocked' : 'safe'); } };
    const blocked = c.fit === 'blocked';
    const dlg = h('div', { class: 'ls-dlg small', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'ls-hw-t', tabindex: -1 },
      h('p', { class: 'ls-eyebrow' }, h('i', { 'aria-hidden': 'true' }), 'Hardware check'),
      h('h2', { id: 'ls-hw-t' }, blocked ? `${c.name} can’t run here yet` : `${c.name} is a stretch for this computer`),
      h('p', { class: 'ls-lead' }, blocked ? 'Here is what it needs.' : 'It will still work. Here is what you may notice.'),
      h('div', { class: 'ls-warn' }, h('div', { class: 'ls-warn-ic', 'aria-hidden': 'true' }, '!'), h('ul', null, ...c.limits.map((l) => h('li', null, l)))),
      h('div', { class: 'ls-foot' },
        blocked ? h('button', { class: 'ls-btn primary big', onClick: () => done('blocked') }, 'Got it')
          : [h('button', { class: 'ls-btn primary big', onClick: () => done('safe') }, 'Pick the safe option'), h('button', { class: 'ls-btn big', onClick: () => done('use') }, 'Use it anyway')]));
    const back = h('div', { class: 'ls-back', onClick: (e: Event) => { if (e.target === back) done(blocked ? 'blocked' : 'safe'); } }, dlg);
    window.addEventListener('keydown', onKey, true);
    document.body.append(back);
    dlg.focus({ preventScroll: true });
  });
}

/** "Check my computer": every heavy feature, what fits, and the exact limits. */
export function openHardwareCheck(app: App, opts: { nav?: GuideNav } = {}) {
  if (openEl) return;
  injectCss();
  const body = h('div', { class: 'ls-body' });
  const dlg = h('div', { class: 'ls-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ls-title', tabindex: -1 }, body);
  const back = h('div', { class: 'ls-back', onClick: (e: Event) => { if (e.target === back) close(); } }, dlg);
  openEl = back;
  const close = () => { if (!openEl) return; back.remove(); openEl = null; window.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  window.addEventListener('keydown', onKey, true);
  let facts: SetupFacts | null = null, asking = false, busy = false;
  const FIT = { ok: ['ok', 'Fits'], stretch: ['warn', 'A stretch'], blocked: ['off', 'Not here yet'] } as const;
  const S = app.scene as unknown as { setGfx?(p: { obs?: string }): void };
  const act = (c: HeavyCheck): Node | null => {
    const b = (t: string, run: () => void, cls = '') => h('button', { class: `ls-btn ${cls}`, onClick: run }, t);
    switch (c.id) {
      case 'lipsync': return b('Open the guide', () => { close(); openLipSyncGuide(app, { from: 'help', nav: opts.nav }); }, 'primary');
      case 'graphics-high': case 'graphics-ultra': {
        const lvl = c.id === 'graphics-high' ? 'high' : 'ultra';
        return b(`Use ${lvl === 'high' ? 'High' : 'Ultra'}`, () => void confirmHeavy(app, c.id, facts!).then((v) => {
          if (v === 'blocked') return;
          const pick = v === 'safe' ? 'balanced' : lvl;
          if (app.observer) { toast('Observer sandbox: graphics not changed.', 'info'); return; }
          S.setGfx?.({ obs: pick });
          toast(`Graphics: ${pick === 'balanced' ? 'Medium' : lvl === 'high' ? 'High' : 'Ultra'}.`, 'ok');
        }));
      }
      case 'gpu-tracking': return opts.nav?.advanced ? b('Open GPU tracking', () => { close(); opts.nav!.advanced!('live', 'voice'); }) : null;
      case 'local-ai': return b('Open Local AI', () => openLocalAi());
    }
  };
  const paint = () => {
    const head = [
      h('div', { class: 'ls-top' }, h('p', { class: 'ls-eyebrow' }, h('i', { 'aria-hidden': 'true' }), 'Hardware check'),
        h('button', { class: 'ls-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: close }, icon('x', 18))),
      h('h2', { id: 'ls-title' }, 'What your computer handles well'),
      h('p', { class: 'ls-lead' }, 'You can still use anything. We just tell you what to expect.'),
    ];
    if (!facts) { body.replaceChildren(...head, h('div', { class: 'ls-spin' })); return; }
    const read = readMachine(facts.machine);
    const g = facts.machine.gpu;
    const rows = HEAVY.map((x) => checkHeavy(x.id, facts!)).map((c) => h('div', { class: `ls-row ${FIT[c.fit][0]}`, 'data-heavy': c.id },
      h('span', { class: 'ls-pill' }, FIT[c.fit][1]),
      h('div', { class: 'ls-words' }, h('b', null, c.name), h('span', null, c.what), c.limits.length ? h('ul', { class: 'ls-lim' }, ...c.limits.map((l) => h('li', null, l))) : null),
      act(c)));
    body.replaceChildren(...nn([...head,
      h('p', { class: 'ls-note' }, `${facts.machine.cores} threads${facts.machine.ramGB ? ` · ${Math.round(facts.machine.ramGB)}${facts.machine.source === 'browser' ? '+' : ''} GB memory` : ''}${g ? ` · ${g.name}` : ''} · ${read.cls === 'high' ? 'plenty of power' : read.cls === 'mid' ? 'good for streaming' : 'on the lighter side'}.`),
      facts.helper !== 'none' && facts.machine.source === 'browser'
        ? (asking ? h('div', { class: 'ls-consent' }, h('b', null, 'Check your computer in detail?'), h('p', null, 'VTube Pro reads your graphics card, memory and processor. Nothing is saved or sent anywhere.'),
          h('div', { class: 'ls-btns' }, h('button', { class: 'ls-btn primary', onClick: () => { if (busy) return; busy = true; paint(); void (TEST ? Promise.resolve(null) : consentedScan()).then(async (hw) => { busy = false; asking = false; facts = TEST ? testFacts(TEST_SCENARIO) : await gatherFacts(app, { hw: hw ?? null }); paint(); }); } }, busy ? 'Checking…' : 'Yes, check my computer'),
            h('button', { class: 'ls-btn ghost', onClick: () => { asking = false; paint(); } }, 'Not now')))
          : h('div', { class: 'ls-btns' }, h('button', { class: 'ls-btn ghost', onClick: () => { asking = true; paint(); } }, 'Check in detail')))
        : null,
      h('div', { class: 'ls-rows' }, ...rows),
      h('div', { class: 'ls-foot' }, h('button', { class: 'ls-btn primary big', onClick: close }, 'Done'))]));
  };
  document.body.append(back);
  paint();
  dlg.focus({ preventScroll: true });
  void (TEST ? Promise.resolve(testFacts(TEST_SCENARIO)) : gatherFacts(app)).then((f) => { facts = f; paint(); });
}

/** The entry card (Me → your avatar, Go Live). */
export function bestLipSyncCard(app: App, nav?: GuideNav): HTMLElement {
  return h('section', { class: 's-card' },
    h('h3', null, h('span', { class: 'grow' }, 'Best lip sync for me')),
    h('p', { class: 'lead' }, 'We check your model, computer, mic and camera. Then we set up the best lip sync for you.'),
    h('div', { class: 's-row' },
      h('button', { class: 'btn primary', onClick: () => openLipSyncGuide(app, { from: 'avatar', nav }) }, 'Find my best lip sync'),
      h('button', { class: 'btn ghost', onClick: () => openHardwareCheck(app, { nav }) }, 'Check my computer')));
}

// ================================================================ observer test scenarios (screenshots only)

const TEST_SCENARIO = (() => { try { return new URLSearchParams(location.search).get('lsScenario') ?? 'mid'; } catch { return 'mid'; } })();
/** Canned setups for ?lipsyncTest= screenshots (&lsScenario=): weak laptop / mid (GTX 1660 S) / strong (RTX 3060) / rtx (RTX 5070, scanned). Never used outside observer pages. */
export function testFacts(s: string): SetupFacts {
  const avatar: AvatarFacts = s === 'weak' ? { name: 'Mira', mouth: 'vowels', vowels: ['aa', 'ih', 'ou', 'ee', 'oh'], seal: false, mouthShapes: 1, perfectSync: false }
    : { name: 'Mira', mouth: 'shapes', vowels: ['aa', 'ih', 'ou', 'ee', 'oh'], seal: true, mouthShapes: 23, perfectSync: s === 'rtx' };
  const machine: MachineFacts = s === 'weak'
    ? machineFromBrowser({ cores: 4, deviceMemory: 8, renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', webgl2: true, webgpu: true, platform: 'Win32' })
    : s === 'rtx'
      ? { source: 'scan', os: 'windows', cores: 32, ramGB: 64, gpu: { name: 'NVIDIA GeForce RTX 5070', vendor: 'nvidia', vramGB: 12 }, webgl2: true, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Direct3D11 vs_5_0 ps_5_0, D3D11)', softwareGl: false, webgpu: true }
      : s === 'mid'
        ? machineFromBrowser({ cores: 8, deviceMemory: 8, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11)', webgl2: true, webgpu: true, platform: 'Win32' })
        : machineFromBrowser({ cores: 12, deviceMemory: 8, renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)', webgl2: true, webgpu: true, platform: 'Win32' });
  return {
    machine, avatar,
    mic: { on: true, label: s === 'weak' ? 'Headset (WH-1000XM4 Hands-Free)' : 'Microphone (USB Audio)', bluetooth: s === 'weak', filterOn: true },
    camera: { on: true, width: 1280, height: 720, fps: 30, trackHz: s === 'weak' ? 24 : 58, faceMs: s === 'weak' ? 16 : 6, cpuTracking: false },
    helper: 'local',
    sidecars: s === 'rtx' ? { nvidia: true, rtx50: true, gpuName: 'NVIDIA GeForce RTX 5070', vramMB: 12227, setUp: true, maxineSdk: false } : { nvidia: s !== 'weak', rtx50: false, gpuName: s === 'weak' ? '' : s === 'mid' ? 'NVIDIA GeForce GTX 1660 SUPER' : 'NVIDIA GeForce RTX 3060', vramMB: s === 'weak' ? 0 : s === 'mid' ? 6144 : 12288, setUp: false, maxineSdk: false },
  };
}

/** Observer pages only: `?lipsyncTest=check|pick|warn|done|try|score|hw` opens that part for screenshots. */
export function maybeOpenLipSyncTest(app: App) {
  if (!TEST || !app.observer) return;
  window.setTimeout(() => { if (TEST === 'hw') openHardwareCheck(app); else if (TEST === 'heavy') void confirmHeavy(app, 'graphics-ultra'); else openLipSyncGuide(app, { from: 'help' }); }, 600);
}

// ================================================================ look

const nn = (xs: (Node | null)[]): Node[] => xs.filter((x): x is Node => x !== null);
const lower1 = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function details(summary: string, lines: string[]) {
  return h('details', { class: 'ls-details' }, h('summary', null, summary), h('ul', null, ...lines.map((l) => h('li', null, l))));
}

function injectCss() {
  if (cssDone) return;
  cssDone = true;
  document.head.append(h('style', { id: 'vtp-lipsync-guide' }, CSS));
}
const CSS = `
.ls-back { position: fixed; inset: 0; z-index: 64; display: grid; place-items: center; padding: 24px; background: radial-gradient(120% 90% at 50% 0%, #7bd88f14, transparent 60%), #05070bd0; backdrop-filter: blur(6px) saturate(130%); animation: ls-fade 220ms cubic-bezier(.16,1,.3,1) both; font-family: Geist, ui-sans-serif, system-ui, sans-serif; }
.ls-back.out { animation: ls-fade 160ms ease reverse both; }
.ls-back.dock { place-items: center start; background: linear-gradient(270deg, transparent 0 40%, #05070bb0 70%); backdrop-filter: none; }
.ls-dlg { width: min(880px, 100%); max-height: calc(100vh - 48px); overflow: auto; background: linear-gradient(180deg, #ffffff0d, #ffffff04), var(--panel, #11171b); color: var(--text, #eef3ef); border: 1px solid #ffffff24; border-radius: 24px; padding: 28px 30px 22px; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12; animation: ls-rise 460ms cubic-bezier(.16,1,.3,1) both; outline: none; }
.ls-back.dock .ls-dlg { width: min(520px, 100%); }
html .ls-back .ls-dlg:is(:focus, :focus-visible) { outline: none !important; box-shadow: 0 40px 120px -30px #000c, inset 0 1px 0 #ffffff12 !important; }
.ls-dlg.small { width: min(560px, 100%); }
.ls-top { display: flex; align-items: center; gap: 10px; }
.ls-x { margin-left: auto; background: none; border: 0; color: var(--dim, #9aa6a0); cursor: pointer; border-radius: 10px; padding: 6px; display: grid; place-items: center; }
.ls-x:hover { color: var(--text, #eef3ef); background: #ffffff10; }
.ls-eyebrow { margin: 0; font: 500 11px/1.4 'Geist Mono', ui-monospace, monospace; letter-spacing: .2em; text-transform: uppercase; color: var(--accent, #7bd88f); display: flex; align-items: center; gap: 8px; }
.ls-eyebrow i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent, #7bd88f); box-shadow: 0 0 10px var(--accent, #7bd88f); }
.ls-dlg h2 { font: 700 28px/1.15 Archivo, ui-sans-serif, system-ui, sans-serif; letter-spacing: -.02em; margin: 10px 0 6px; }
.ls-lead { margin: 0 0 6px; color: var(--dim, #9aa6a0); font-size: 15px; }
.ls-next { margin: 0 0 14px; font-size: 13px; color: var(--dim, #9aa6a0); }
.ls-next b { color: var(--accent, #7bd88f); font: 500 11px 'Geist Mono', ui-monospace, monospace; letter-spacing: .15em; text-transform: uppercase; }
.ls-rows { display: grid; gap: 8px; margin: 12px 0; }
.ls-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 16px; background: #ffffff07; border: 1px solid #ffffff12; }
.ls-row .ls-ic { flex: none; width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center; background: #ffffff0c; color: var(--dim, #9aa6a0); }
.ls-row.ok .ls-ic { background: #7bd88f22; color: #7bd88f; } .ls-row.warn .ls-ic { background: #ffcf6a22; color: #ffcf6a; } .ls-row.err .ls-ic { background: #ff6b6b22; color: #ff6b6b; }
.ls-words { flex: 1; min-width: 0; display: grid; gap: 2px; } .ls-words b { font-size: 15px; } .ls-words > span { color: var(--dim, #9aa6a0); font-size: 13.5px; }
.ls-tag { font: 500 11px 'Geist Mono', ui-monospace, monospace; color: #7bd88f; border: 1px solid #7bd88f55; border-radius: 999px; padding: 3px 9px; }
.ls-pill { flex: none; min-width: 92px; text-align: center; font: 600 12px 'Geist Mono', ui-monospace, monospace; border-radius: 999px; padding: 5px 10px; background: #ffffff10; color: var(--dim, #9aa6a0); }
.ls-row.ok .ls-pill { background: #7bd88f22; color: #7bd88f; } .ls-row.warn .ls-pill { background: #ffcf6a22; color: #ffcf6a; }
.ls-lim { margin: 4px 0 0; padding-left: 18px; color: #ffcf6a; font-size: 13px; } .ls-row.off .ls-lim { color: var(--dim, #9aa6a0); } .ls-row.ok .ls-lim { color: var(--dim, #9aa6a0); }
.ls-btn { font: 600 14px Geist, ui-sans-serif, system-ui, sans-serif; border-radius: 12px; padding: 9px 14px; border: 1px solid #ffffff24; background: #ffffff0c; color: var(--text, #eef3ef); cursor: pointer; transition: background 180ms cubic-bezier(.16,1,.3,1), transform 180ms cubic-bezier(.16,1,.3,1); white-space: nowrap; }
.ls-btn:hover { background: #ffffff16; } .ls-btn:active { transform: translateY(1px); }
.ls-btn.primary { background: var(--accent, #7bd88f); color: #06080a; border-color: transparent; } .ls-btn.primary:hover { background: #a6f5b4; }
.ls-btn.ghost { background: none; border-color: transparent; color: var(--dim, #9aa6a0); } .ls-btn.ghost:hover { color: var(--text, #eef3ef); background: #ffffff0c; }
.ls-btn.big { padding: 12px 20px; font-size: 15px; border-radius: 14px; }
.ls-btn:focus-visible, .ls-tier:focus-visible, .ls-x:focus-visible, .ls-link:focus-visible { outline: 2px solid #7bd88f; outline-offset: 3px; }
.ls-btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.ls-foot { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 18px; }
.ls-consent { padding: 14px 16px; border-radius: 16px; border: 1px solid #6cc7f555; background: #6cc7f50f; } .ls-consent p { margin: 4px 0 0; color: var(--dim, #9aa6a0); font-size: 13.5px; }
.ls-note { color: var(--dim, #9aa6a0); font-size: 13px; margin: 8px 0 0; } .ls-note.warn { color: #ffcf6a; }
.ls-first { display: grid; gap: 6px; margin: 4px 0 12px; }
.ls-firstrow { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 10px 14px; border-radius: 14px; background: #ffcf6a12; border: 1px solid #ffcf6a44; font-size: 14px; margin-top: 8px; }
.ls-tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 12px 0 4px; }
.ls-tier { text-align: left; display: grid; align-content: start; gap: 6px; padding: 16px; border-radius: 20px; border: 1px solid #ffffff1c; background: #ffffff06; color: var(--text, #eef3ef); cursor: pointer; font: inherit; transition: border-color 180ms cubic-bezier(.16,1,.3,1), background 180ms cubic-bezier(.16,1,.3,1), transform 180ms cubic-bezier(.16,1,.3,1); }
.ls-tier:hover { border-color: #ffffff40; transform: translateY(-1px); }
.ls-tier.on { border-color: #7bd88f; background: linear-gradient(180deg, #7bd88f1a, #7bd88f06); box-shadow: 0 0 0 1px #7bd88f inset; }
.ls-tier-top { display: flex; align-items: center; gap: 8px; } .ls-tier-top b { font: 700 20px Archivo, ui-sans-serif, system-ui, sans-serif; letter-spacing: -.01em; }
.ls-badge { font: 600 10.5px 'Geist Mono', ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; background: #7bd88f; color: #06080a; border-radius: 999px; padding: 3px 8px; }
.ls-badge.warn { background: #ffcf6a; }
.ls-tier-line { color: var(--dim, #9aa6a0); font-size: 13.5px; }
.ls-tier ul { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 4px; font-size: 13px; }
.ls-tier li { display: flex; gap: 7px; align-items: baseline; } .ls-tier li > span { width: 12px; flex: none; font-weight: 700; text-align: center; }
.ls-tier li.ok > span { color: #7bd88f; } .ls-tier li.warn > span, .ls-tier li.warn { color: #ffcf6a; } .ls-tier li.skip { color: var(--dim, #9aa6a0); opacity: .75; } .ls-tier li small { color: var(--dim, #9aa6a0); display: block; } .ls-tier li.skip { flex-wrap: wrap; } .ls-tier li.skip small { flex-basis: 100%; padding-left: 19px; margin-top: -2px; }
.ls-know { margin-top: 12px; padding: 12px 16px; border-radius: 16px; background: #ffffff07; border: 1px solid #ffffff12; font-size: 13.5px; } .ls-know ul { margin: 6px 0 0; padding-left: 18px; color: var(--dim, #9aa6a0); }
.ls-warn { display: flex; gap: 14px; padding: 16px 18px; border-radius: 18px; background: #ffcf6a12; border: 1px solid #ffcf6a66; margin: 12px 0 4px; }
.ls-warn-ic { flex: none; width: 34px; height: 34px; border-radius: 50%; background: #ffcf6a; color: #06080a; display: grid; place-items: center; font: 800 18px Archivo, sans-serif; }
.ls-warn ul { margin: 6px 0 0; padding-left: 18px; font-size: 14.5px; display: grid; gap: 4px; } .ls-warn-from { margin: 8px 0 0; color: var(--dim, #9aa6a0); font-size: 12.5px; }
.ls-donelist { list-style: none; padding: 0; margin: 12px 0; display: grid; gap: 6px; } .ls-donelist li { display: flex; gap: 10px; font-size: 15px; } .ls-donelist li span { color: #7bd88f; font-weight: 700; }
.ls-obsauto { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 8px 0 4px; } .ls-obsres { font-size: 13px; color: var(--dim, #9aa6a0); flex-basis: 100%; } .ls-obsmic { display: flex; gap: 6px; align-items: baseline; margin: 2px 0; color: var(--text); } .ls-obsres p { margin: 4px 0; }
.ls-obs { margin-top: 12px; padding: 14px 16px; border-radius: 16px; border: 1px solid #6cc7f555; background: #6cc7f50d; font-size: 14px; } .ls-obs ol { margin: 8px 0 6px; padding-left: 20px; display: grid; gap: 4px; } .ls-obs p { margin: 0; color: var(--dim, #9aa6a0); }
.ls-link { background: none; border: 0; color: #6cc7f5; font: inherit; font-weight: 600; cursor: pointer; padding: 0 2px; text-decoration: underline; }
.ls-details { margin-top: 12px; font-size: 13px; color: var(--dim, #9aa6a0); } .ls-details summary { cursor: pointer; } .ls-details ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
.ls-try { display: grid; gap: 14px; margin: 12px 0; }
.ls-word { padding: 18px; border-radius: 18px; background: #ffffff07; border: 1px solid #ffffff14; display: grid; gap: 6px; text-align: center; }
.ls-word b { font: 700 26px/1.25 Archivo, ui-sans-serif, system-ui, sans-serif; letter-spacing: -.01em; } .ls-wordn { font: 500 11px 'Geist Mono', ui-monospace, monospace; letter-spacing: .15em; text-transform: uppercase; color: var(--dim, #9aa6a0); }
.ls-prog, .ls-meter { height: 10px; border-radius: 999px; background: #ffffff10; overflow: hidden; } .ls-prog i, .ls-meter i { display: block; height: 100%; background: linear-gradient(90deg, #7bd88f, #6cc7f5); border-radius: 999px; transition: width 120ms linear; }
.ls-live { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; } .ls-cap { display: block; font-size: 12px; color: var(--dim, #9aa6a0); margin-bottom: 6px; }
.ls-mouth { width: 200px; height: 100px; border-radius: 16px; background: #0b0f12; border: 1px solid #ffffff14; }
.ls-score { display: flex; align-items: baseline; gap: 10px; margin: 8px 0 12px; } .ls-score b { font: 800 64px/1 Archivo, ui-sans-serif, system-ui, sans-serif; letter-spacing: -.03em; } .ls-score span { color: var(--dim, #9aa6a0); }
.ls-score.great b { color: #7bd88f; } .ls-score.good b { color: #6cc7f5; } .ls-score.help b { color: #ffcf6a; }
.ls-words-res { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; } .ls-words-res li { display: grid; gap: 2px; padding: 10px 14px; border-radius: 14px; background: #ffffff07; border-left: 3px solid #7bd88f; font-size: 14px; }
.ls-words-res li.warn { border-left-color: #ffcf6a; } .ls-words-res li.err { border-left-color: #ff6b6b; } .ls-words-res li span { color: var(--dim, #9aa6a0); font-size: 13px; }
.ls-spin { width: 28px; height: 28px; margin: 24px auto; border: 3px solid #7bd88f; border-right-color: transparent; border-radius: 50%; animation: ls-spin .8s linear infinite; }
@keyframes ls-spin { to { transform: rotate(360deg); } }
@keyframes ls-fade { from { opacity: 0; } }
@keyframes ls-rise { from { opacity: 0; transform: translateY(14px) scale(.985); } }
@media (max-width: 760px) { .ls-tiers { grid-template-columns: 1fr; } .ls-dlg { padding: 20px 16px 16px; } .ls-dlg h2 { font-size: 23px; } .ls-live { grid-template-columns: 1fr; } .ls-back.dock { place-items: end center; background: #05070bb0; } }
@media (prefers-reduced-motion: reduce) { .ls-back, .ls-dlg, .ls-tier, .ls-btn, .ls-spin { animation: none !important; transition: none !important; } }
html[data-theme="light"] .ls-dlg { --text: #11171b; --dim: #4b5560; }
`;
