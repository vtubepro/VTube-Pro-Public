// "Set up OBS" wizard (lane obs-wizard): the pieces the helper (server/obsSetup.ts) and the wizard UI
// (src/ui/obsWizard.ts) share. Pure: no I/O, so the helper's plan and the screen's preview are the same plan.
//
// Every change in OBS is a PLAN first: the wizard shows the plan's sentence ("We'll add a Browser Source called
// “VTube Pro” to the scene “Live”"), the user presses the button, the helper re-plans from a fresh look at OBS and
// only applies it when the plan id still matches (OBS changed in between → 409 + the new plan). Each applied plan is
// one undo group on the helper.
//
// obs-websocket v5 requests used (https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md):
//   CreateInput {sceneName, inputName, inputKind, inputSettings, sceneItemEnabled} · CreateSceneItem {sceneName,
//   sourceName, sceneItemEnabled} · CreateScene {sceneName} · SetCurrentSceneTransition {transitionName} ·
//   SetCurrentSceneTransitionDuration {transitionDuration}; undo: RemoveInput · RemoveSceneItem · RemoveScene.
// Browser Source settings keys (obs-browser, obs-browser-source.cpp): url, width, height, shutdown ("Shutdown source
// when not visible"), restart_when_active ("Refresh browser when scene becomes active").

/** What the wizard ties to an OBS scene (live-tabs commit 3, CONTRACT.md): "What you're doing" (the show mode ids
 *  talk · react · gaming · interview) + the BRB lighting state (id `brb`). Labels are the studio's own words. */
export type LookId = 'talk' | 'react' | 'gaming' | 'interview' | 'brb';
export const LOOKS: { id: LookId; label: string; when: string; scene: string }[] = [
  { id: 'talk', label: 'Talk', when: 'what you’re doing: talking', scene: 'Talk' },
  { id: 'react', label: 'React', when: 'watching something together', scene: 'React' },
  { id: 'gaming', label: 'Gaming', when: 'playing a game', scene: 'Gaming' },
  { id: 'interview', label: 'Interview', when: 'with a guest', scene: 'Interview' },
  { id: 'brb', label: 'BRB', when: 'lights on BRB: a short break', scene: 'BRB' },
];
export const LOOK_IDS = LOOKS.map((l) => l.id);
export const isLook = (v: unknown): v is LookId => typeof v === 'string' && (LOOK_IDS as string[]).includes(v);
/** The recommended set of stream scenes the wizard can make. */
export const RECOMMENDED_SCENES = ['Talk', 'React', 'Gaming', 'Interview', 'BRB'];
/** The Browser Source name the wizard uses. */
export const VTP_SOURCE_NAME = 'VTube Pro';
export const DEFAULT_SIZE = { width: 1920, height: 1080 };
/** Transition lengths offered (ms). OBS's own default is 300 ms. */
export const TRANSITION_MS = [300, 500, 1000];

/** What OBS should show right now (null = a mode the wizard doesn't map, e.g. TTRPG). The BRB lighting state wins over
 *  "What you're doing"; Classic (no room) counts as Talk. */
export function lookOf(s: { sceneId?: string | null; mode?: string; lights?: { state?: string } | null }): LookId | null {
  if (s.sceneId && s.lights?.state === 'brb') return 'brb';
  if (!s.sceneId) return 'talk';
  if (s.mode === undefined) return 'talk';
  return s.mode === 'talk' || s.mode === 'react' || s.mode === 'gaming' || s.mode === 'interview' ? s.mode : null;
}

/** Look → OBS scene, filling in the older talkScene / reactScene settings. */
export function effectiveMap(cfg: { sceneMap?: Partial<Record<LookId, string>>; talkScene?: string; reactScene?: string }): Partial<Record<LookId, string>> {
  const m: Partial<Record<LookId, string>> = { ...(cfg.sceneMap ?? {}) };
  if (!m.talk && cfg.talkScene) m.talk = cfg.talkScene;
  if (!m.react && cfg.reactScene) m.react = cfg.reactScene;
  for (const k of Object.keys(m) as LookId[]) if (!m[k]) delete m[k];
  return m;
}

export function sanitizeSceneMap(o: unknown): Partial<Record<LookId, string>> {
  const out: Partial<Record<LookId, string>> = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o)) if (isLook(k) && typeof v === 'string' && v.length <= 256 && !/[\u0000-\u001f]/.test(v)) { if (v) out[k] = v; }
  return out;
}

// ---------------------------------------------------------------- a look at OBS
export interface ObsItem { name: string; id: number; kind?: string }
export interface ObsSnapshot {
  scenes: { name: string; items: ObsItem[] }[];
  /** Program scene. */
  current: string | null;
  /** Every source name (inputs) — OBS needs scene and source names to be unique together. */
  inputs: { name: string; kind: string }[];
  /** Browser Sources that already show VTube Pro (their URL ends in /output.html on this PC). */
  vtpInputs: string[];
  transitions: string[];
  transition: { name: string; ms: number | null } | null;
  canvas: { width: number; height: number } | null;
  obsVersion: string | null;
  wsVersion: string | null;
  /** Microphone inputs (OBS's global Mic/Aux + any audio-input capture source) and their Sync Offset in ms. */
  mics?: { name: string; offsetMs: number; virtual?: boolean }[];
}
/** A virtual audio cable / mixer input (music, a call, game audio routed into OBS): never delayed unless picked. */
export const VIRTUAL_MIC_RE = /cable|voicemeeter|vb-?audio|virtual|loopback|blackhole|soundflower|stereo mix|what u hear|wave link|sonar|nvidia broadcast|krisp/i;
/** obs-websocket input kinds that capture a microphone / audio interface. */
export const MIC_KIND_RE = /(^|_)(wasapi_input_capture|coreaudio_input_capture|pulse_input_capture|alsa_input_capture|jack_input_client|pipewire.*input|sndio_input_capture)$/;
/** Highest mic delay the lip-sync button sets (OBS allows −950 … 20000 ms). */
export const MIC_OFFSET_MAX = 400;
/** Is this Browser Source URL the helper's OBS page? (On this PC, or - Stream PC mode, server/streamPc.ts - the gaming
 *  PC's page that OBS on a stream PC loads over the home network: http://<private IPv4 | PC name>:<port>/streampc/obs …) */
export const isVtpUrl = (u: unknown) => typeof u === 'string' && (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/output\.html(\?.*)?$/i.test(u.trim()) || isLanVtpUrl(u));
/** The stream PC form of the OBS page (Stream PC mode). */
export const isLanVtpUrl = (u: unknown) => typeof u === 'string'
  && /^http:\/\/((10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01])|169\.254)\.\d{1,3}\.\d{1,3}|[a-z0-9][a-z0-9-]{0,62}(\.(local|lan|home))?):\d{1,5}\/(output\.html|streampc\/(obs|view))(\?.*)?$/i.test(u.trim());

// ---------------------------------------------------------------- plans
export type PlanStep =
  | { op: 'CreateInput'; scene: string; name: string; text: string }
  | { op: 'CreateSceneItem'; scene: string; name: string; text: string }
  | { op: 'CreateScene'; scene: string; text: string }
  | { op: 'SetTransition'; name: string; ms: number; prev: { name: string; ms: number | null } | null; text: string }
  | { op: 'SetMicOffset'; name: string; ms: number; prev: number; text: string };
export type PlanAction =
  | { action: 'add-source'; scene: string }
  | { action: 'scenes'; scenes: string[] }
  | { action: 'add-to-scenes'; scenes: string[] }
  | { action: 'transition'; name: string; ms: number }
  /** Lip sync on time: delay the microphone(s) by the lip-sync lookahead (0 = put them back to no delay). */
  | { action: 'mic-offset'; ms: number; names?: string[] };
export interface Plan {
  ok: boolean;
  id: string;
  steps: PlanStep[];
  /** One plain sentence for the confirm card ("We'll …"). */
  summary: string;
  /** Nothing to do (already set up). */
  nothing?: boolean;
  error?: string;
  /** Browser Source settings the helper will use. */
  source?: { url: string; width: number; height: number };
}

const q = (s: string) => `“${s}”`;
const list = (xs: string[]) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
/** Short stable hash of the steps (the apply call must send the id it previewed). */
export function planIdOf(steps: PlanStep[]): string {
  const s = JSON.stringify(steps.map((x) => [x.op, 'scene' in x ? x.scene : '', 'name' in x ? x.name : '', 'ms' in x ? x.ms : '']));
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}
/** A source name nothing in OBS uses yet: "VTube Pro", then "VTube Pro 2" … */
export function freeName(snap: ObsSnapshot, base = VTP_SOURCE_NAME): string {
  const used = new Set([...snap.inputs.map((i) => i.name), ...snap.scenes.map((s) => s.name)]);
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${Date.now() % 10000}`;
}
const sceneOf = (snap: ObsSnapshot, name: string) => snap.scenes.find((s) => s.name === name);
const hasVtp = (snap: ObsSnapshot, scene: string) => !!sceneOf(snap, scene)?.items.some((i) => snap.vtpInputs.includes(i.name));
export const sizeFor = (snap: ObsSnapshot | null) => (snap?.canvas && snap.canvas.width > 0 && snap.canvas.height > 0 ? snap.canvas : DEFAULT_SIZE);

function finish(steps: PlanStep[], summary: string, source?: Plan['source']): Plan {
  return { ok: true, id: planIdOf(steps), steps, summary: steps.length ? summary : 'Nothing to change: this is already set up.', nothing: !steps.length, source };
}
const fail = (error: string): Plan => ({ ok: false, id: '', steps: [], summary: error, error });

/** Steps that put VTube Pro in each of `scenes` (one new Browser Source the first time, then the same source). */
type SourceStep = Extract<PlanStep, { op: 'CreateInput' | 'CreateSceneItem' }>;
function sourceSteps(snap: ObsSnapshot, scenes: string[]): SourceStep[] {
  const steps: SourceStep[] = [];
  let src = snap.vtpInputs[0] ?? null;
  for (const scene of scenes) {
    if (hasVtp(snap, scene)) continue;
    if (!src) { src = freeName(snap); steps.push({ op: 'CreateInput', scene, name: src, text: `Add a Browser Source called ${q(src)} to ${q(scene)}` }); }
    else steps.push({ op: 'CreateSceneItem', scene, name: src, text: `Show ${q(src)} in ${q(scene)}` });
  }
  return steps;
}

export function makePlan(snap: ObsSnapshot, a: PlanAction, url: string): Plan {
  const size = sizeFor(snap);
  const source = { url, width: size.width, height: size.height };
  if (a.action === 'add-source') {
    if (!sceneOf(snap, a.scene)) return fail(`OBS has no scene called ${q(a.scene)} any more. Pick another one.`);
    const steps = sourceSteps(snap, [a.scene]);
    const s = steps[0];
    const summary = !s ? '' : s.op === 'CreateInput'
      ? `We'll add a Browser Source called ${q(s.name)} to the scene ${q(a.scene)}. It's ${size.width}×${size.height} and stays loaded when you switch scenes.`
      : `You already have ${q(s.name)} in OBS. We'll show it in the scene ${q(a.scene)} too.`;
    return finish(steps, summary, source);
  }
  if (a.action === 'scenes' || a.action === 'add-to-scenes') {
    const names = [...new Set(a.scenes.map((s) => s.trim()).filter((s) => s && s.length <= 256))].slice(0, 12);
    if (!names.length) return fail('Pick at least one scene.');
    const steps: PlanStep[] = [];
    const made: string[] = [];
    for (const n of names) {
      if (sceneOf(snap, n)) continue;
      if (a.action === 'add-to-scenes') return fail(`OBS has no scene called ${q(n)} any more.`);
      if (snap.inputs.some((i) => i.name === n)) return fail(`OBS already has a source called ${q(n)}, so it can't make a scene with that name.`);
      steps.push({ op: 'CreateScene', scene: n, text: `Make a scene called ${q(n)}` });
      made.push(n);
    }
    // the new scenes are empty: the source steps see them as such
    const after: ObsSnapshot = { ...snap, scenes: [...snap.scenes, ...made.map((name) => ({ name, items: [] }))] };
    const src = sourceSteps(after, names);
    steps.push(...src);
    const parts: string[] = [];
    if (made.length) parts.push(`make ${made.length === 1 ? 'the scene' : `${made.length} scenes:`} ${list(made.map(q))}`);
    const into = src.map((s) => s.scene);
    if (into.length) parts.push(`put VTube Pro in ${list(into.map(q))}`);
    return finish(steps, parts.length ? `We'll ${parts.join(' and ')}. Nothing else in OBS changes.` : '', source);
  }
  if (a.action === 'transition') {
    const ms = Math.round(a.ms);
    if (!snap.transitions.includes(a.name)) return fail(`OBS has no transition called ${q(a.name)}.`);
    if (!(ms >= 50 && ms <= 20000)) return fail('Pick a length between 0.05 and 20 seconds.');
    const prev = snap.transition;
    if (prev && prev.name === a.name && prev.ms === ms) return finish([], '');
    const steps: PlanStep[] = [{ op: 'SetTransition', name: a.name, ms, prev, text: `Set OBS's transition to ${q(a.name)}, ${ms / 1000} s` }];
    return finish(steps, `We'll set OBS's scene transition to ${q(a.name)}, ${ms / 1000} seconds${prev ? ` (now: ${q(prev.name)}${prev.ms ? `, ${prev.ms / 1000} s` : ''})` : ''}.`);
  }
  if (a.action === 'mic-offset') {
    const ms = Math.round(a.ms);
    if (!(ms >= 0 && ms <= MIC_OFFSET_MAX)) return fail(`Pick a delay between 0 and ${MIC_OFFSET_MAX} ms.`);
    if (!snap.mics) return fail('VTube Pro could not read your OBS microphones. Press Find it again.');
    if (!snap.mics.length) return fail('OBS has no microphone source. Add your mic in OBS (Sources → + → Audio Input Capture), then press this again.');
    // the mics the user ticked (by exact OBS name); none given = every mic except virtual cables / mixers
    const unknown = (a.names ?? []).filter((n) => !snap.mics!.some((m) => m.name === n));
    if (unknown.length) return fail(`OBS has no audio source called ${list(unknown.map(q))} any more. Look again and pick.`);
    const chosen = a.names ? snap.mics.filter((m) => a.names!.includes(m.name)) : snap.mics.filter((m) => !m.virtual);
    if (!chosen.length) return fail('Pick at least one microphone.');
    const steps: PlanStep[] = chosen.filter((m) => m.offsetMs !== ms)
      .map((m) => ({ op: 'SetMicOffset' as const, name: m.name, ms, prev: m.offsetMs, text: `Set the Sync Offset of ${q(m.name)} to ${ms} ms` }));
    const names = list(chosen.map((m) => q(m.name)));
    const many = chosen.length > 1 ? 's' : '';
    return finish(steps, ms
      ? `We'll delay your mic${many} ${names} by ${ms} ms in OBS, so viewers hear you right on the mouth. Discord and party friends are not delayed.`
      : `We'll put your mic${many} ${names} back to no delay in OBS.`);
  }
  return fail('Unknown change.');
}

export function parsePlanAction(b: unknown): PlanAction | null {
  const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  const name = (v: unknown) => (typeof v === 'string' && v.trim() && v.length <= 256 && !/[\u0000-\u001f]/.test(v) ? v.trim() : null);
  const names = (v: unknown) => (Array.isArray(v) ? v.map(name).filter((x): x is string => !!x).slice(0, 12) : []);
  switch (o.action) {
    case 'add-source': { const s = name(o.scene); return s ? { action: 'add-source', scene: s } : null; }
    case 'scenes': return { action: 'scenes', scenes: names(o.scenes) };
    case 'add-to-scenes': return { action: 'add-to-scenes', scenes: names(o.scenes) };
    case 'transition': { const n = name(o.name); return n && typeof o.ms === 'number' && Number.isFinite(o.ms) ? { action: 'transition', name: n, ms: o.ms } : null; }
    case 'mic-offset': return typeof o.ms === 'number' && Number.isFinite(o.ms) ? { action: 'mic-offset', ms: o.ms, ...(Array.isArray(o.names) ? { names: names(o.names) } : {}) } : null;
  }
  return null;
}

// ---------------------------------------------------------------- the wizard's one read: GET /api/obs/setup
export type StepId = 'install' | 'remote' | 'connect' | 'source' | 'scenes' | 'automation' | 'test' | 'done';
export const STEPS: { id: StepId; title: string; short: string }[] = [
  { id: 'install', title: 'Is OBS on this computer?', short: 'Get OBS' },
  { id: 'remote', title: 'Turn on OBS’s remote control', short: 'Remote control' },
  { id: 'connect', title: 'Connect VTube Pro to OBS', short: 'Connect' },
  { id: 'source', title: 'Add VTube Pro to OBS', short: 'Add VTube Pro' },
  { id: 'scenes', title: 'Your stream scenes', short: 'Scenes' },
  { id: 'automation', title: 'Let OBS follow you', short: 'Automation' },
  { id: 'test', title: 'Test it', short: 'Test' },
  { id: 'done', title: 'You’re ready', short: 'Ready' },
];

export interface UndoGroup { id: string; label: string; at: string; steps: number }
export interface ObsSetupState {
  /** OBS's program files or settings folder are on this computer. */
  install: { found: boolean; settings: boolean };
  /** OBS's own remote-control (obs-websocket) settings on this computer. */
  remote: { found: boolean; enabled: boolean; port: number | null; auth: boolean | null };
  connected: boolean;
  /** A password is saved in the helper (never the password itself). */
  hasPassword: boolean;
  error: string | null;
  fix: string | null;
  obs: ObsSnapshot | null;
  /** Output pages attached to the helper (inObs > 0 = an OBS Browser Source shows VTube Pro right now). */
  outputs: { count: number; inObs: number; size: { w: number; h: number } | null };
  /** What OBS's Browser Source should load. */
  source: { url: string; width: number; height: number };
  automation: { enabled: boolean; switchScenes: boolean; sceneMap: Partial<Record<LookId, string>>; recordReminder: boolean; reviewed: boolean };
  undo: UndoGroup[];
}

/** Which steps are green. `tested`: scenes the user switched to with the Test buttons (this session). */
export function stepChecks(s: ObsSetupState | null, tested: string[] = []): Record<StepId, boolean> {
  const snap = s?.obs ?? null;
  const vtpScenes = snap ? snap.scenes.filter((x) => x.items.some((i) => snap.vtpInputs.includes(i.name))).map((x) => x.name) : [];
  const map = s?.automation.sceneMap ?? {};
  const mapped = Object.values(map).filter((v): v is string => !!v);
  const live = !!snap && mapped.length > 0 && mapped.every((m) => snap.scenes.some((x) => x.name === m));
  const install = !!s && (s.install.found || s.connected);
  const remote = !!s && (s.remote.enabled || s.connected);
  const connect = !!s?.connected;
  const source = connect && vtpScenes.length > 0;
  const scenes = source && live && mapped.every((m) => vtpScenes.includes(m));
  const automation = !!s?.automation.reviewed;
  const test = tested.length > 0 && tested.every((t) => mapped.includes(t)) && (s?.outputs.inObs ?? 0) > 0;
  return { install, remote, connect, source, scenes, automation, test, done: install && remote && connect && source && scenes && automation && test };
}
export function firstOpenStep(s: ObsSetupState | null, tested: string[] = []): StepId {
  const c = stepChecks(s, tested);
  return STEPS.find((x) => x.id !== 'done' && !c[x.id])?.id ?? 'done';
}
