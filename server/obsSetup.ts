// "Set up OBS" wizard, helper side (lane obs-wizard). The wizard UI is src/ui/obsWizard.ts: in the studio
// and on its own page /obs/setup (vite entry obs-setup.html).
//
//   GET  /api/obs/setup          → ObsSetupState: every step's check in one read (no password, ever)
//   POST /api/obs/setup/find     → "Find it for me": read OBS's own remote-control settings on this computer, save
//                                  port + password in config/obs.json (address pinned to ws://127.0.0.1:<OBS's port>)
//   POST /api/obs/setup/plan     → { action … } → Plan (what WOULD change, in one sentence; changes nothing)
//   POST /api/obs/setup/apply    → { action …, planId } → only when the fresh plan has the same id (else 409 + plan)
//   POST /api/obs/setup/undo     → { id } (the latest change) | { id: 'all' }: remove what the wizard added
//   GET  /api/obs/local/nonce    → this PC's own pages only: the nonce for /api/obs/local/save (typed password)
//   GET  /obs/setup              → the wizard as a helper page (this PC only)
//
// Who may call: like every route, server/localGuard.ts (other sites 403) + the OBS
// read guard (GETs refused before any OBS connection) + the OBS write guard (no password / address from a web page).
// Every OBS write here is a click in the wizard (apply / undo), previewed by /plan first.
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectLocal, obs, obsConnectNonce, obsInstalled, obsReadGuard, obsWriteGuard, readObsRemoteSettings, type ObsClient } from './obs.ts';
import { outputPages } from './bus.ts';
import { requireLocal } from './routes/util.ts';
import { CONFIG_DIR, PORT } from './paths.ts';
import { streamPc } from './streamPc.ts';
import { MIC_KIND_RE, VIRTUAL_MIC_RE, effectiveMap, isVtpUrl, makePlan, parsePlanAction, sizeFor, type ObsSetupState, type ObsSnapshot, type Plan, type PlanAction, type UndoGroup } from '../shared/obsSetup.ts';

/** Is OBS automation pointed at OBS on ANOTHER computer (the stream PC: Stream PC mode, server/streamPc.ts)? */
export function obsElsewhere(url: string = obs.cfg.url): boolean {
  try { return !/^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])$/i.test(new URL(url).hostname); } catch { return false; }
}
/** What OBS's Browser Source loads: the helper's own output page on this computer; or, when OBS runs on the stream PC,
 *  the stream PC link with its own pairing (made on this PC by the user's click; `mint` false = a display form only). */
export const sourceUrl = (mint = true) => {
  const local = `http://127.0.0.1:${PORT}/output.html`;
  if (!obsElsewhere()) return local;
  const sp = streamPc();
  if (!mint) return sp.ctx ? `http://${sp.ctx.address}:${PORT}/streampc/obs?vtp_sp=…` : local;
  return sp.obsLink() ?? local;
};
const ELSEWHERE_OFF = 'Your OBS is on another PC. Turn on “Let my stream PC connect” (OBS & stream → Streaming from a second PC), then press this again.';

// ---------------------------------------------------------------- a full look at OBS (read-only)
type Items = { sceneItems?: { sourceName: string; sceneItemId: number; inputKind?: string | null }[] };
export async function snapshot(c: ObsClient): Promise<ObsSnapshot> {
  const [list, inputs, video, ver, trs, tr] = await Promise.all([
    c.request<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>('GetSceneList'),
    c.request<{ inputs?: { inputName: string; inputKind: string }[] }>('GetInputList'),
    c.request<{ baseWidth: number; baseHeight: number }>('GetVideoSettings').catch(() => null),
    c.request<{ obsVersion?: string; obsWebSocketVersion?: string }>('GetVersion').catch(() => null),
    c.request<{ transitions?: { transitionName: string }[] }>('GetSceneTransitionList').catch(() => null),
    c.request<{ transitionName?: string; transitionDuration?: number | null; transitionFixed?: boolean }>('GetCurrentSceneTransition').catch(() => null),
  ]);
  const names = (list.scenes ?? []).map((s) => String(s.sceneName)).reverse().slice(0, 60);   // OBS order: top first
  const scenes = await Promise.all(names.map(async (name) => {
    const r = await c.request<Items>('GetSceneItemList', { sceneName: name }).catch(() => ({ sceneItems: [] } as Items));
    return { name, items: (r.sceneItems ?? []).map((i) => ({ name: String(i.sourceName), id: Number(i.sceneItemId), ...(i.inputKind ? { kind: String(i.inputKind) } : {}) })) };
  }));
  const all = (inputs.inputs ?? []).map((i) => ({ name: String(i.inputName), kind: String(i.inputKind) }));
  const browsers = all.filter((i) => i.kind === 'browser_source').slice(0, 40);
  const vtpInputs: string[] = [];
  for (const b of browsers) {
    const s = await c.request<{ inputSettings?: { url?: unknown } }>('GetInputSettings', { inputName: b.name }).catch(() => null);
    if (isVtpUrl(s?.inputSettings?.url)) vtpInputs.push(b.name);
  }
  // microphones: OBS's global Mic/Aux sources + any audio-input capture source, with their Sync Offset
  const sp = await c.request<Record<string, string | null>>('GetSpecialInputs').catch(() => null);
  const micNames = [...new Set([...['mic1', 'mic2', 'mic3', 'mic4'].map((k) => sp?.[k]).filter((x): x is string => typeof x === 'string' && !!x),
    ...all.filter((i) => MIC_KIND_RE.test(i.kind)).map((i) => i.name)])].slice(0, 8);
  const mics: { name: string; offsetMs: number; virtual?: boolean }[] = [];
  for (const name of micNames) {
    const r = await c.request<{ inputAudioSyncOffset?: number }>('GetInputAudioSyncOffset', { inputName: name }).catch(() => null);
    if (!r || typeof r.inputAudioSyncOffset !== 'number') continue;
    // a virtual cable / mixer (by its OBS name, or the device it captures): never delayed unless the user picks it
    let virtual = VIRTUAL_MIC_RE.test(name);
    if (!virtual) {
      const st = await c.request<{ inputSettings?: { device_id?: unknown } }>('GetInputSettings', { inputName: name }).catch(() => null);
      const dev = st?.inputSettings?.device_id;
      if (typeof dev === 'string' && dev && dev !== 'default') {
        const items = await c.request<{ propertyItems?: { itemName?: string; itemValue?: unknown }[] }>('GetInputPropertiesListPropertyItems', { inputName: name, propertyName: 'device_id' }).catch(() => null);
        const label = items?.propertyItems?.find((i) => i.itemValue === dev)?.itemName;
        virtual = VIRTUAL_MIC_RE.test(label ?? '') || VIRTUAL_MIC_RE.test(dev);
      }
    }
    mics.push({ name, offsetMs: Math.round(r.inputAudioSyncOffset), ...(virtual ? { virtual: true } : {}) });
  }
  return {
    mics,
    scenes, current: typeof list.currentProgramSceneName === 'string' ? list.currentProgramSceneName : null, inputs: all, vtpInputs,
    transitions: (trs?.transitions ?? []).map((t) => String(t.transitionName)),
    transition: tr?.transitionName ? { name: String(tr.transitionName), ms: tr.transitionFixed || typeof tr.transitionDuration !== 'number' ? null : tr.transitionDuration } : null,
    canvas: video ? { width: video.baseWidth, height: video.baseHeight } : null,
    obsVersion: ver?.obsVersion ? String(ver.obsVersion).slice(0, 24) : null, wsVersion: ver?.obsWebSocketVersion ? String(ver.obsWebSocketVersion).slice(0, 24) : null,
  };
}

// ---------------------------------------------------------------- undo journal (config/obs-setup.json on this PC)
type UndoStep =
  | { op: 'RemoveInput'; name: string }
  | { op: 'RemoveSceneItem'; scene: string; id: number; name: string }
  | { op: 'RemoveScene'; scene: string }
  | { op: 'SetTransition'; name: string; ms: number | null }
  | { op: 'SetMicOffset'; name: string; ms: number; was: number };
interface Group { id: string; label: string; at: string; undo: UndoStep[] }
const JOURNAL = () => path.join(CONFIG_DIR, 'obs-setup.json');
function readJournal(): Group[] {
  try { const j = JSON.parse(fs.readFileSync(JOURNAL(), 'utf8')) as { groups?: Group[] }; return Array.isArray(j.groups) ? j.groups.slice(-20) : []; } catch { return []; }
}
function writeJournal(g: Group[]) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(JOURNAL(), JSON.stringify({ groups: g.slice(-20) }, null, 2), { mode: 0o600 });
}
const publicGroups = (g: Group[]): UndoGroup[] => g.map((x) => ({ id: x.id, label: x.label, at: x.at, steps: x.undo.length }));

/** One plain sentence for an OBS refusal. */
function plain(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  // (raw network errors like "read ECONNRESET" reached the Live panel as "OBS said no: … ECONNRESET")
  if (/not connected|closed|timed out|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|connection failed|did not answer/i.test(m)) return 'OBS stopped answering. Is it still open? Then press Try again.';
  if (/already exists|601/i.test(m)) return 'OBS already has something with that name. Press Try again: we’ll pick another name.';
  return `OBS said no: ${m.replace(/^\w+: /, '').slice(0, 160)}`;
}

/** What was done, for the "Changes we made in OBS" list (past tense, short). */
export function pastTense(steps: Plan['steps']): string {
  const made = steps.filter((s) => s.op === 'CreateScene').map((s) => `“${(s as { scene: string }).scene}”`);
  const src = steps.filter((s) => s.op === 'CreateInput' || s.op === 'CreateSceneItem') as { name: string; scene: string }[];
  const tr = steps.find((s) => s.op === 'SetTransition') as { name: string; ms: number } | undefined;
  const mic = steps.filter((s) => s.op === 'SetMicOffset') as { name: string; ms: number }[];
  const out: string[] = [];
  if (made.length) out.push(`Made ${made.length === 1 ? 'the scene' : 'the scenes'} ${made.join(', ')}`);
  if (src.length) out.push(`${made.length ? 'put' : 'Put'} “${src[0].name}” in ${src.map((s) => `“${s.scene}”`).join(', ')}`);
  if (tr) out.push(`Set OBS’s transition to “${tr.name}”, ${tr.ms / 1000} s`);
  if (mic.length) out.push(mic[0].ms ? `Delayed ${mic.map((m) => `“${m.name}”`).join(', ')} by ${mic[0].ms} ms for lip sync` : `Took the lip-sync delay off ${mic.map((m) => `“${m.name}”`).join(', ')}`);
  return out.join(' and ') || 'A change in OBS';
}

/** OPT-IN ONLY (ApplyOptions.routeAudio; nothing in the app turns it on — owner decision, beta.12: page audio must keep
 *  playing the way it always did, so the streamer hears and monitors it). When used: the streamer hears the routed page
 *  audio through OBS's monitoring ("Monitor and Output") when OBS has no Desktop Audio capture; with one, monitoring stays
 *  off (Desktop Audio would record the monitored sound again: twice on stream). Best effort. */
export async function monitorSource(c: { request: <T = unknown>(type: string, data?: Record<string, unknown>) => Promise<T> }, name: string) {
  try {
    const sp = await c.request<{ desktop1?: string | null; desktop2?: string | null }>('GetSpecialInputs');
    if (sp?.desktop1 || sp?.desktop2) return;
    await c.request('SetInputAudioMonitorType', { inputName: name, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
  } catch { /* an older obs-websocket: the source keeps OBS's default (monitor off) */ }
}

export interface ApplyResult { ok: boolean; did: string[]; undoId: string | null; error?: string; plan?: Plan }
/** routeAudio: OBS's "Control audio via OBS" on a new Browser Source (+ monitoring, monitorSource). Default OFF; no caller sets it. */
export interface ApplyOptions { routeAudio?: boolean }
export async function applyPlan(a: PlanAction, planId: string, url = sourceUrl(), opts: ApplyOptions = {}): Promise<ApplyResult & { status?: number }> {
  try {
    return await obs.session(async (c) => {
      const snap = await snapshot(c);
      const plan = makePlan(snap, a, url);
      if (!plan.ok) return { ok: false, did: [], undoId: null, error: plan.error, plan, status: 400 };
      if (plan.id !== planId) return { ok: false, did: [], undoId: null, error: 'OBS changed since you looked. Check the new plan and press the button again.', plan, status: 409 };
      if (plan.nothing) return { ok: true, did: [], undoId: null, plan };
      const size = plan.source ?? { url, ...sizeFor(snap) };
      const group: Group = { id: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label: '', at: new Date().toISOString(), undo: [] };
      const did: string[] = [];
      let error: string | undefined;
      for (const st of plan.steps) {
        try {
          if (st.op === 'CreateInput') {
            // OBS's Browser Source properties: URL, Width, Height; "Shutdown source when not visible" OFF (stays ready
            // between scenes), "Refresh browser when scene becomes active" OFF (no reload flash on a scene switch).
            // "Control audio via OBS" is left as OBS has it (off): the page's sounds play the way they always did, so the
            // streamer hears them (owner decision); routeAudio is an opt-in nothing sets yet.
            await c.request('CreateInput', { sceneName: st.scene, inputName: st.name, inputKind: 'browser_source', sceneItemEnabled: true,
              inputSettings: { url: size.url, width: size.width, height: size.height, shutdown: false, restart_when_active: false, ...(opts.routeAudio ? { reroute_audio: true } : {}) } });
            group.undo.push({ op: 'RemoveInput', name: st.name });
            if (opts.routeAudio) await monitorSource(c, st.name);
          } else if (st.op === 'CreateSceneItem') {
            const r = await c.request<{ sceneItemId: number }>('CreateSceneItem', { sceneName: st.scene, sourceName: st.name, sceneItemEnabled: true });
            group.undo.push({ op: 'RemoveSceneItem', scene: st.scene, id: Number(r.sceneItemId), name: st.name });
          } else if (st.op === 'CreateScene') {
            await c.request('CreateScene', { sceneName: st.scene });
            group.undo.push({ op: 'RemoveScene', scene: st.scene });
          } else if (st.op === 'SetTransition') {
            await c.request('SetCurrentSceneTransition', { transitionName: st.name });
            group.undo.push({ op: 'SetTransition', name: st.prev?.name ?? st.name, ms: st.prev?.ms ?? null });
            await c.request('SetCurrentSceneTransitionDuration', { transitionDuration: st.ms }).catch(() => { /* a fixed transition (Cut) has no length */ });
          } else if (st.op === 'SetMicOffset') {
            await c.request('SetInputAudioSyncOffset', { inputName: st.name, inputAudioSyncOffset: st.ms });
            group.undo.push({ op: 'SetMicOffset', name: st.name, ms: st.prev, was: st.ms });
            // read it back: OBS clamps it / an old OBS ignores it → put that source back as it was, then say so (the mics
            // already changed keep their journal entry: Undo still works for them)
            const r = await c.request<{ inputAudioSyncOffset?: number }>('GetInputAudioSyncOffset', { inputName: st.name }).catch(() => null);
            const got = r ? Math.round(Number(r.inputAudioSyncOffset)) : NaN;
            if (got !== st.ms) {
              await c.request('SetInputAudioSyncOffset', { inputName: st.name, inputAudioSyncOffset: st.prev }).catch(() => {});
              group.undo.pop();
              throw new Error(`OBS kept “${st.name}” at ${Number.isFinite(got) ? got : '?'} ms, so we put it back to ${st.prev} ms`);
            }
          }
          did.push(st.text);
        } catch (e) { error = plain(e); break; }
      }
      group.label = pastTense(plan.steps.slice(0, did.length));
      if (group.undo.length) writeJournal([...readJournal(), group]);
      return { ok: !error, did, undoId: group.undo.length ? group.id : null, ...(error ? { error, status: 502 } : {}) };
    });
  } catch (e) { return { ok: false, did: [], undoId: null, error: plain(e), status: 503 }; }
}

export interface UndoResult { ok: boolean; did: string[]; kept: string[]; error?: string; status?: number }
/** Undo the latest change (`id` must be the latest group) or every change ('all'), newest first. Removes only what
 *  the wizard added and still looks like it: a scene the user has since put their own things in is kept. */
export async function undo(id: string): Promise<UndoResult> {
  const groups = readJournal();
  const last = groups[groups.length - 1];
  if (!last) return { ok: false, did: [], kept: [], error: 'Nothing to undo.', status: 404 };
  if (id !== 'all' && id !== last.id) return { ok: false, did: [], kept: [], error: 'Only the latest change can be undone here. Undo that one first.', status: 409 };
  const todo = id === 'all' ? [...groups].reverse() : [last];
  const did: string[] = [], kept: string[] = [];
  try {
    await obs.session(async (c) => {
      for (const g of todo) {
        for (const u of [...g.undo].reverse()) {
          if (u.op === 'RemoveSceneItem') {
            const items = (await c.request<Items>('GetSceneItemList', { sceneName: u.scene }).catch(() => ({ sceneItems: [] } as Items))).sceneItems ?? [];
            if (items.some((i) => Number(i.sceneItemId) === u.id && i.sourceName === u.name)) { await c.request('RemoveSceneItem', { sceneName: u.scene, sceneItemId: u.id }); did.push(`Took “${u.name}” out of “${u.scene}”`); }
          } else if (u.op === 'RemoveInput') {
            const s = await c.request<{ inputSettings?: { url?: unknown }; inputKind?: string }>('GetInputSettings', { inputName: u.name }).catch(() => null);
            if (s && isVtpUrl(s.inputSettings?.url)) { await c.request('RemoveInput', { inputName: u.name }); did.push(`Removed the Browser Source “${u.name}”`); }
            else if (s) kept.push(`Kept “${u.name}”: it shows something else now.`);
          } else if (u.op === 'RemoveScene') {
            const list = (await c.request<{ scenes?: { sceneName: string }[] }>('GetSceneList')).scenes ?? [];
            if (!list.some((x) => x.sceneName === u.scene)) continue;
            const items = (await c.request<Items>('GetSceneItemList', { sceneName: u.scene })).sceneItems ?? [];
            const ours = await Promise.all(items.map(async (i) => isVtpUrl((await c.request<{ inputSettings?: { url?: unknown } }>('GetInputSettings', { inputName: i.sourceName }).catch(() => null))?.inputSettings?.url)));
            if (list.length <= 1) kept.push(`Kept “${u.scene}”: OBS needs at least one scene.`);
            else if (ours.every(Boolean)) { await c.request('RemoveScene', { sceneName: u.scene }); did.push(`Removed the scene “${u.scene}”`); }
            else kept.push(`Kept the scene “${u.scene}”: you added your own things to it.`);
          } else if (u.op === 'SetMicOffset') {
            // only while it still has the delay we set (the user may have changed it since)
            const r = await c.request<{ inputAudioSyncOffset?: number }>('GetInputAudioSyncOffset', { inputName: u.name }).catch(() => null);
            if (r && Math.round(Number(r.inputAudioSyncOffset)) === u.was) { await c.request('SetInputAudioSyncOffset', { inputName: u.name, inputAudioSyncOffset: u.ms }); did.push(`Put the Sync Offset of “${u.name}” back to ${u.ms} ms`); }
            else if (r) kept.push(`Kept the Sync Offset of “${u.name}”: you changed it since.`);
          } else if (u.op === 'SetTransition') {
            await c.request('SetCurrentSceneTransition', { transitionName: u.name }).catch(() => kept.push(`Couldn’t put the transition back to “${u.name}”.`));
            if (u.ms) await c.request('SetCurrentSceneTransitionDuration', { transitionDuration: u.ms }).catch(() => {});
            did.push(`Put OBS’s transition back to “${u.name}”`);
          }
        }
      }
    });
  } catch (e) {
    return { ok: false, did, kept, error: plain(e), status: 503 };
  }
  writeJournal(id === 'all' ? [] : groups.slice(0, -1));
  // a scene the map pointed at may be gone now: forget those entries
  const map = effectiveMap(obs.cfg);
  const st = await obs.scenes(0);
  if (st.ok) {
    const keep = Object.fromEntries(Object.entries(map).filter(([, v]) => st.scenes.includes(v as string)));
    if (Object.keys(keep).length !== Object.keys(map).length) obs.updateSwitcher({ sceneMap: keep });
  }
  return { ok: true, did, kept };
}

// ---------------------------------------------------------------- state
let snapCache: { at: number; snap: ObsSnapshot } | null = null;
export async function setupState(env: NodeJS.ProcessEnv = process.env): Promise<ObsSetupState> {
  const remote = readObsRemoteSettings(env);
  const install = obsInstalled(env);
  const st = await obs.statusView();
  let snap: ObsSnapshot | null = null;
  if (st.connected) {
    if (snapCache && Date.now() - snapCache.at < 1200) snap = snapCache.snap;
    else { snap = await obs.readOnly(snapshot).catch(() => null); if (snap) snapCache = { at: Date.now(), snap }; }
  }
  const o = outputPages();
  const sw = obs.switcherView();
  return {
    install, remote: { found: remote.found, enabled: remote.enabled, port: remote.found ? remote.port : null, auth: remote.found ? remote.auth : null },
    connected: st.connected && !!snap, hasPassword: st.hasPassword, error: st.connected ? null : st.error, fix: st.connected ? null : wizardFix(st.error ?? '', !!obs.cfg.password, remote),
    obs: snap, outputs: { count: o.count, inObs: o.inObs, size: o.size ? { w: o.size.w, h: o.size.h } : null },
    source: { url: sourceUrl(false), ...sizeFor(snap) },
    automation: { enabled: sw.enabled, switchScenes: sw.switchScenes, sceneMap: sw.sceneMap ?? {}, recordReminder: !!sw.recordReminder, reviewed: !!sw.reviewed },
    undo: publicGroups(readJournal()),
  };
}
const forgetSnap = () => { snapCache = null; };
/** The wizard's one sentence for "not connected" (it has its own Find it for me button, so no "open the helper page"). */
function wizardFix(err: string, hasPassword: boolean, remote: { found: boolean; enabled: boolean }): string {
  if (/password|4009|auth/i.test(err)) return hasPassword ? 'OBS didn’t accept the saved password. Press Find it for me to read it again.' : 'Press Find it for me. We read the password from OBS’s own settings.';
  if (remote.found && !remote.enabled) return 'OBS’s remote control is off. Go back one step and tick “Enable WebSocket server”.';
  return 'Is OBS open? Start OBS, then wait a moment. This turns green by itself.';
}

// ---------------------------------------------------------------- routes
export const obsSetupRoutes = Router();
obsSetupRoutes.use(obsReadGuard);
obsSetupRoutes.use(obsWriteGuard);
const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

obsSetupRoutes.get('/api/obs/setup', async (req, res) => { requireLocal(req); noStore(res); res.json(await setupState()); });
// OBS's own scene transitions (read-only) for the Live panel's Transitions tab (src/ui/obsTransitions.ts)
obsSetupRoutes.get('/api/obs/transitions', async (req, res) => {
  requireLocal(req); noStore(res);
  try {
    const r = await obs.readOnly(async (c) => {
      const [trs, tr] = await Promise.all([
        c.request<{ transitions?: { transitionName: string }[] }>('GetSceneTransitionList'),
        c.request<{ transitionName?: string; transitionDuration?: number | null; transitionFixed?: boolean }>('GetCurrentSceneTransition').catch(() => null),
      ]);
      return { ok: true, transitions: (trs.transitions ?? []).map((t) => String(t.transitionName)),
        current: tr?.transitionName ? { name: String(tr.transitionName), ms: tr.transitionFixed || typeof tr.transitionDuration !== 'number' ? null : tr.transitionDuration } : null };
    });
    res.json(r);
  } catch (e) { res.json({ ok: false, transitions: [], current: null, error: plain(e), fix: 'Is OBS open? Set up OBS connects it.' }); }
});
obsSetupRoutes.post('/api/obs/setup/find', async (req, res) => {
  requireLocal(req);
  const r = await obs.detect();
  if (r.test?.ok && !obs.cfg.enabled) obs.update({ enabled: true });
  forgetSnap();
  const connected = !!r.test?.ok;
  res.json({
    found: r.found, serverEnabled: r.serverEnabled ?? false, port: r.port ?? null, authRequired: r.authRequired ?? null, connected,
    fix: connected ? null : !r.found ? 'Open OBS once, then do the step before this one (turn on its remote control).'
      : !r.serverEnabled ? 'OBS’s remote control is still off. Go back one step, tick “Enable WebSocket server” and press Apply.'
      : r.test?.fix ?? 'Is OBS open? Start it, then press Find it for me again.',
  });
});
obsSetupRoutes.post('/api/obs/setup/plan', async (req, res) => {
  requireLocal(req); noStore(res);
  const a = parsePlanAction(req.body);
  if (!a) { res.status(400).json({ ok: false, error: 'Which change? (action)' }); return; }
  if (obsElsewhere() && !streamPc().ctx) { res.status(409).json({ ok: false, id: '', steps: [], summary: '', error: ELSEWHERE_OFF }); return; }
  try { res.json(await obs.session(async (c) => makePlan(await snapshot(c), a, sourceUrl()))); }
  catch (e) { res.status(503).json({ ok: false, id: '', steps: [], summary: '', error: plain(e) }); }
});
obsSetupRoutes.post('/api/obs/setup/apply', async (req, res) => {
  requireLocal(req); noStore(res);
  const a = parsePlanAction(req.body);
  const id = (req.body as { planId?: unknown } | undefined)?.planId;
  if (!a || typeof id !== 'string' || !id) { res.status(400).json({ ok: false, error: 'Preview the change first (planId).' }); return; }
  if (obsElsewhere() && !streamPc().ctx) { res.status(409).json({ ok: false, did: [], undoId: null, error: ELSEWHERE_OFF }); return; }
  const r = await applyPlan(a, id);
  forgetSnap();
  const { status, ...body } = r;
  res.status(r.ok ? 200 : status ?? 500).json(body);
});
obsSetupRoutes.post('/api/obs/setup/undo', async (req, res) => {
  requireLocal(req); noStore(res);
  const id = (req.body as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !id) { res.status(400).json({ ok: false, error: 'Which change? (id)' }); return; }
  const r = await undo(id);
  forgetSnap();
  const { status, ...body } = r;
  res.status(r.ok ? 200 : status ?? 500).json(body);
});
// the nonce for /api/obs/local/save (a password typed on THIS computer). /api/obs/local/* is local-only for every web
// origin (server/obs.ts checkObsWrite); a browser fetch from another site can't read the answer (no CORS) and is
// refused here as well.
obsSetupRoutes.get('/api/obs/local/nonce', (req: Request, res) => {
  requireLocal(req); noStore(res);
  const site = String(req.headers['sec-fetch-site'] ?? '');
  if (!connectLocal(req) || (site && site !== 'same-origin' && site !== 'none')) { res.status(403).json({ error: 'Open this page on this PC' }); return; }
  res.json({ nonce: obsConnectNonce() });
});

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
obsSetupRoutes.get(['/obs/setup', '/obs/setup/'], (req, res) => {
  requireLocal(req);
  if (!connectLocal(req, true)) { res.status(403).json({ error: 'Open this page on this PC' }); return; }
  const file = path.join(process.env.VTP_DIST_DIR || DIST, 'obs-setup.html');
  if (!fs.existsSync(file)) { res.redirect(302, '/obs/connect'); return; }   // an older build: the one-page connect
  noStore(res);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(fs.readFileSync(file, 'utf8'));
});
