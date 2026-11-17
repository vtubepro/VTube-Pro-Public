// VTube Pro Live, Go Live tab: the VIEW LOGIC, pure (no DOM, no network, no timers). Everything the Go Live tab decides
// to show or enable comes from here, so tools/broadcast_ui_unit.ts can test it without a browser. The DOM files in this
// folder (goLiveTab, destinationsCard, preflightCard, healthTile, confirmToast, choiceCard) only draw what these
// functions return. Plain words, no jargon, no raw numbers in anything about health.
import {
  FIX_LABEL, HEALTH_TEXT,
  type BackendChoice, type BroadcastErrorCode, type BroadcastStatus, type DestinationView, type FixId, type GoLivePlan, type HealthId,
  type HealthTone, type HealthView, type PreflightReport, type PreflightRow, type PreflightStatus, type DestPlatform, type RecordStatus,
} from '../../../shared/broadcastTypes.ts';

// ---------------------------------------------------------------- can we talk to VTube Pro at all

/** loading = first answer not in yet · ready = the routes answer · no-helper = nothing answers. */
export type Avail = 'loading' | 'ready' | 'no-helper';

export interface AvailView { show: 'tab' | 'notice'; title: string; say: string; action: 'none' | 'check-again' }
export function availView(a: Avail): AvailView {
  switch (a) {
    case 'no-helper': return { show: 'notice', title: 'VTube Pro is not answering',
      say: 'Go Live runs through VTube Pro on this computer. Start it, then come back here.', action: 'check-again' };
    case 'loading': return { show: 'notice', title: 'One moment', say: 'Asking VTube Pro how your stream is set up…', action: 'none' };
    default: return { show: 'tab', title: '', say: '', action: 'none' };
  }
}

// ---------------------------------------------------------------- plain words for a failed call

/** The sentence for a refused or failed call. The server always sends a plain sentence; this only fills in the codes that
 *  need the person to do something different, and makes sure no raw code ever reaches the screen. */
export function failText(code: string, error: string | null | undefined): string {
  const e = (error ?? '').trim();
  switch (code as BroadcastErrorCode | 'no-helper') {
    case 'local-only': return 'To add or change a stream key, open VTube Pro on your computer. This page can’t do that.';
    case 'token-expired': return 'That took too long. Press Go Live again.';
    case 'token-replayed': case 'no-token': case 'token-mismatch': return 'That didn’t go through. Press Go Live again.';
    case 'source-not-allowed': case 'foreign-origin': case 'not-confirmed':
      return e || 'Go Live only works when you press the button in your own VTube Pro window.';
    case 'other-live': return e || 'Another streaming app is already live. Stop it first, then try again.';
    case 'already-live': return e || 'You are already live.';
    case 'not-live': return e || 'You are not live right now.';
    case 'backend-unreachable': return e || 'VTube Pro can’t reach your streaming app. Is OBS open?';
    case 'no-helper': return availView('no-helper').say;
    default: return e || 'That didn’t work. Try again.';
  }
}

// ---------------------------------------------------------------- destinations

export const PLATFORM_NAME: Record<DestPlatform, string> = { twitch: 'Twitch', youtube: 'YouTube', kick: 'Kick', tiktok: 'TikTok', custom: 'Other site' };
export const PLATFORM_ORDER: readonly DestPlatform[] = ['twitch', 'youtube', 'kick', 'tiktok', 'custom'];

/** A destination the Go Live plan may include: switched on and holding a pasted stream key. */
export const destReady = (d: DestinationView): boolean => d.enabled && d.keyState === 'saved';
export const readyDests = (ds: readonly DestinationView[]): DestinationView[] => ds.filter(destReady);

export type ChipState = 'ready' | 'needs-key' | 'off' | 'on-air' | 'retrying' | 'failed';
export interface ChipView { id: string; name: string; label: string; state: ChipState; tone: HealthTone; say: string; on: boolean; fixId: FixId | null }

/** One destination chip. `live` is that destination's state while a show runs. */
export function destChipView(d: DestinationView, live?: { state: string; say: string | null } | null): ChipView {
  const name = PLATFORM_NAME[d.platform] ?? 'Other';
  const label = d.label.trim() || name;
  const base = { id: d.id, name, label, on: d.enabled };
  if (live && d.enabled) {
    if (live.state === 'live') return { ...base, state: 'on-air', tone: 'ok', say: 'On air', fixId: null };
    if (live.state === 'reconnecting') return { ...base, state: 'retrying', tone: 'warn', say: 'Trying to reconnect', fixId: null };
    if (live.state === 'failed') return { ...base, state: 'failed', tone: 'bad', say: live.say || 'This one didn’t start', fixId: null };
  }
  if (!d.enabled) return { ...base, state: 'off', tone: 'quiet', say: 'Switched off', fixId: null };
  if (d.keyState !== 'saved') return { ...base, state: 'needs-key', tone: 'warn', say: 'Paste your stream key to finish', fixId: 'paste-key' };
  return { ...base, state: 'ready', tone: 'ok', say: 'Ready', fixId: null };
}

/** The plan the confirm card shows and the intent token is bound to: exactly the ready destinations, with the title and
 *  category of the first one that has them. */
export function planFor(ds: readonly DestinationView[], opts: { record?: boolean } = {}): GoLivePlan {
  const ready = readyDests(ds);
  const withTitle = ready.find((d) => d.title.trim()) ?? ready[0];
  const withCat = ready.find((d) => d.category.trim()) ?? ready[0];
  const plan: GoLivePlan = { destIds: ready.map((d) => d.id).sort(), title: withTitle?.title.trim() ?? '', category: withCat?.category.trim() ?? '' };
  if (opts.record) plan.record = true;
  return plan;
}
/** A plan that only records (no destinations): the token for the Record button. */
export const recordPlan = (): GoLivePlan => ({ destIds: [], title: '', category: '', record: true });
/** The plan of the 10 second private test: never a real destination. */
export const dryRunPlan = (): GoLivePlan => ({ destIds: [], title: '', category: '', dryRun: true });

// ---------------------------------------------------------------- the confirm card

export interface ConfirmView { heading: string; lines: string[]; goLabel: string; cancelLabel: string; tone: 'go' | 'quiet' }
export function confirmView(plan: GoLivePlan, ds: readonly DestinationView[]): ConfirmView {
  if (plan.dryRun) return { heading: 'Run a private test?', lines: ['It runs for about ten seconds and only shows you the picture. Nothing is sent to Twitch or anywhere else.'], goLabel: 'Start the test', cancelLabel: 'Cancel', tone: 'quiet' };
  if (plan.destIds.length === 0 && plan.record) return { heading: 'Start recording?', lines: ['This records your show to a file on your computer. It does not go live.'], goLabel: 'Start recording', cancelLabel: 'Cancel', tone: 'quiet' };
  const names = plan.destIds.map((id) => ds.find((d) => d.id === id)).filter((d): d is DestinationView => !!d).map((d) => destChipView(d).label);
  const lines = [`You will be live on ${joinWords(names) || 'your stream'}.`];
  lines.push(plan.title ? `Title: ${plan.title}` : 'No title set.');
  if (plan.category) lines.push(`Category: ${plan.category}`);
  if (plan.record) lines.push('It will also record to a file on your computer.');
  lines.push('Viewers can see you as soon as you press the button.');
  return { heading: 'Go live now?', lines, goLabel: 'Go Live now', cancelLabel: 'Not yet', tone: 'go' };
}
function joinWords(a: string[]): string {
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

// ---------------------------------------------------------------- preflight rows ("Check my setup")

export interface PreflightRowView { id: string; status: PreflightStatus; title: string; say: string; fixId: FixId | null; fixLabel: string | null; tone: HealthTone; mark: 'check' | 'warn' | 'cross' | 'dot' }
const ROW_TONE: Record<PreflightStatus, HealthTone> = { ok: 'ok', warn: 'warn', bad: 'bad', unknown: 'quiet' };
const ROW_MARK: Record<PreflightStatus, PreflightRowView['mark']> = { ok: 'check', warn: 'warn', bad: 'cross', unknown: 'dot' };
/** Red first, then amber, then unknown, then green: what needs the person comes first. */
const ROW_RANK: Record<PreflightStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 };

export function preflightRowView(r: PreflightRow): PreflightRowView {
  const fixId = r.status === 'ok' ? null : r.fixId;
  return { id: r.id, status: r.status, title: r.title, say: r.say, fixId, fixLabel: fixId ? (r.fixLabel || FIX_LABEL[fixId]) : null, tone: ROW_TONE[r.status], mark: ROW_MARK[r.status] };
}
export function preflightView(report: PreflightReport | null): { rows: PreflightRowView[]; headline: string; sub: string; tone: HealthTone; showAccept: boolean } {
  if (!report) return { rows: [], headline: 'Check my setup', sub: 'See if everything is ready before you go live.', tone: 'quiet', showAccept: false };
  const rows = report.rows.map((r, i) => [preflightRowView(r), i] as const).sort((a, b) => ROW_RANK[a[0].status] - ROW_RANK[b[0].status] || a[1] - b[1]).map(([v]) => v);
  if (report.verdict === 'blocked') return { rows, headline: 'Something needs fixing', sub: 'Fix the red items, then check again.', tone: 'bad', showAccept: false };
  if (report.verdict === 'check') return { rows, headline: report.canGoLive ? 'Good to go, with a few notes' : 'Almost ready', sub: report.canGoLive ? 'You chose to go live with the yellow items.' : 'Fix the yellow items, or go live anyway.', tone: 'warn', showAccept: !report.canGoLive };
  return { rows, headline: 'Everything looks ready', sub: 'You can go live whenever you like.', tone: 'ok', showAccept: false };
}

/** A fix that points at one destination: which one (the first that needs it). */
export function fixDestId(fixId: FixId, ds: readonly DestinationView[]): string | undefined {
  if (fixId === 'paste-key') return ds.find((d) => d.enabled && d.keyState !== 'saved')?.id;
  return undefined;
}

// ---------------------------------------------------------------- health tile (strings come from HEALTH_TEXT only)

export interface HealthTileView { id: HealthId; title: string; say: string; tone: HealthTone; fixId: FixId | null; fixLabel: string | null }
export function healthTileView(h: HealthView | null | undefined): HealthTileView {
  const id: HealthId = h && h.id in HEALTH_TEXT ? h.id : 'idle';
  const t = HEALTH_TEXT[id];
  return { id, title: t.title, say: t.say, tone: t.tone, fixId: t.fixId, fixLabel: t.fixId ? FIX_LABEL[t.fixId] : null };
}

// ---------------------------------------------------------------- the big button

export interface GoInputs {
  avail: Avail;
  /** An observer tab or any other view that must never act. */
  readOnly: boolean;
  status: BroadcastStatus | null;
  report: PreflightReport | null;
  /** A request of ours is in flight. */
  busy: boolean;
  /** The confirm card is open. */
  confirmOpen: boolean;
}
export type GoMode = 'go' | 'end' | 'wait' | 'off';
export interface GoButtonView { label: string; sub: string; enabled: boolean; mode: GoMode; action: 'confirm' | 'end' | 'none' }

const off = (sub: string, label = 'Go Live'): GoButtonView => ({ label, sub, enabled: false, mode: 'off', action: 'none' });

export function goButtonView(i: GoInputs): GoButtonView {
  if (i.avail !== 'ready') return off(availView(i.avail).say);
  const s = i.status;
  if (!s) return off('Asking VTube Pro how your stream is set up…');
  const g = s.goLive;
  if (g.dryRun && (g.phase === 'live' || g.phase === 'starting')) return { label: 'Stop the test', sub: 'This is a private test. Nobody can see it.', enabled: !i.busy, mode: 'end', action: 'end' };
  if (g.phase === 'live' || g.phase === 'reconnecting') return { label: 'End show', sub: i.readOnly ? 'You are live. End the show from your main VTube Pro window.' : g.phase === 'reconnecting' ? 'Your connection dropped. VTube Pro is trying to get it back.' : 'You are live. Press when you are done.', enabled: !i.busy && !i.readOnly, mode: 'end', action: 'end' };
  if (g.phase === 'starting') return { label: 'Going live…', sub: 'Starting your stream.', enabled: false, mode: 'wait', action: 'none' };
  if (g.phase === 'stopping') return { label: 'Ending…', sub: 'Stopping your stream.', enabled: false, mode: 'wait', action: 'none' };
  if (i.readOnly) return off('This is a view-only window. Press Go Live in your main VTube Pro window.');
  if (s.choice === 'none') return off('Choose how you stream first (below).');
  if (s.choice === 'engine' && !s.engineAvailable) return off('The VTube Pro Live engine is coming later. Use your OBS for now.');
  if (s.backend && !s.backend.reachable) return off('VTube Pro can’t reach your streaming app. Is OBS open?');
  if (g.otherBroadcasterLive === true) return off('Another streaming app is already live. Stop it first.');
  if (s.destinations.length === 0 || readyDests(s.destinations).length === 0) {
    return off(s.destinations.some((d) => d.enabled) ? 'Finish setting up where you stream (it needs a key).' : 'Add where you stream first.');
  }
  if (i.confirmOpen || g.phase === 'confirming') return { label: 'Go Live', sub: 'Waiting for your OK below.', enabled: false, mode: 'wait', action: 'none' };
  if (i.busy || g.phase === 'checking') return { label: 'Checking…', sub: 'Looking at your setup.', enabled: false, mode: 'wait', action: 'none' };
  if (!i.report) return off('Check your setup first.');
  if (i.report.verdict === 'blocked') return off('Fix the red items first.');
  if (!i.report.canGoLive) return off('Look at the yellow items, then fix them or go live anyway.');
  return { label: 'Go Live', sub: 'You will see a quick “are you sure” first.', enabled: true, mode: 'go', action: 'confirm' };
}

// ---------------------------------------------------------------- timer and live line

/** 7 -> "0:07", 3725 -> "1:02:05". */
export function formatTimer(secs: number | null | undefined): string {
  const t = Math.max(0, Math.floor(Number.isFinite(secs as number) ? (secs as number) : 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
/** Seconds on air: from the start time when we have it, else the server's own count. */
export function onAirSeconds(g: { startedAt: number | null; liveForS: number | null }, now: number): number | null {
  if (g.startedAt) return Math.max(0, (now - g.startedAt) / 1000);
  return g.liveForS;
}

// ---------------------------------------------------------------- record and "save last 60 s"

export interface RecordView { label: string; sub: string; active: boolean; enabled: boolean }
export function recordView(rec: RecordStatus | null | undefined, ok: { avail: Avail; readOnly: boolean; status: BroadcastStatus | null; busy: boolean }): RecordView {
  const active = !!rec?.active;
  const canTalk = ok.avail === 'ready' && !ok.readOnly && !!ok.status && ok.status.choice === 'obs' && ok.status.backend?.reachable !== false;
  if (active) return { label: 'Stop recording', sub: `Recording ${formatTimer((rec?.durationMs ?? 0) / 1000)}`, active: true, enabled: ok.avail === 'ready' && !ok.readOnly && !ok.busy };
  return { label: 'Record', sub: 'Save your show to a file on your computer.', active: false, enabled: canTalk && !ok.busy };
}
export interface ReplayView { show: boolean; label: string; enabled: boolean; sub: string }
export function replayView(s: BroadcastStatus | null, ok: { readOnly: boolean; busy: boolean }): ReplayView {
  const r = s?.goLive.replay;
  const show = !!s && (r?.available === true || s.backend?.replayBufferActive === true);
  const secs = r && r.seconds > 0 ? r.seconds : 60;
  return { show, label: `Save last ${secs} s`, enabled: show && !ok.readOnly && !ok.busy && !r?.saving, sub: r?.saving ? 'Saving…' : 'Keeps the last moments as a clip.' };
}

// ---------------------------------------------------------------- "Which one do you stream with?"

export interface ChoiceOption { id: BackendChoice; title: string; say: string; enabled: boolean; badge: string | null; selected: boolean }
export interface ChoiceView { question: string; options: ChoiceOption[]; summary: string; needsPick: boolean }
export function choiceView(s: BroadcastStatus | null): ChoiceView {
  const choice: BackendChoice = s?.choice ?? 'none';
  const engineOk = !!s?.engineAvailable;
  const options: ChoiceOption[] = [
    { id: 'obs', title: 'My OBS', say: 'Use the OBS you already have. VTube Pro starts and stops the stream for you.', enabled: true, badge: null, selected: choice === 'obs' },
    { id: 'engine', title: 'VTube Pro Live engine', say: 'Our own streaming engine, with nothing else to set up.', enabled: engineOk, badge: engineOk ? null : 'Coming later', selected: choice === 'engine' },
    { id: 'none', title: 'Not yet', say: 'Just use VTube Pro on its own for now.', enabled: true, badge: null, selected: choice === 'none' },
  ];
  const summary = choice === 'obs' ? 'You stream with your OBS.' : choice === 'engine' ? 'You stream with the VTube Pro Live engine.' : 'You haven’t picked how you stream yet.';
  return { question: 'Which one do you stream with?', options, summary, needsPick: choice === 'none' };
}

// ---------------------------------------------------------------- links

/** A link the person may click: https anywhere, or http only to this computer (the private test platform). Anything else
 *  (javascript:, data:, a lookalike) is shown as text and not linked. */
export function safeLink(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return x.href;
    if (x.protocol === 'http:' && (x.hostname === '127.0.0.1' || x.hostname === 'localhost' || x.hostname === '[::1]')) return x.href;
  } catch { /* not a URL */ }
  return null;
}
/** A pasted stream key: one run of characters, no spaces, not a web address. */
export function keyLooksOk(k: string): boolean {
  const t = k.trim();
  return t.length >= 4 && t.length <= 512 && !/\s/.test(t) && !/^[a-z]+:\/\//i.test(t);
}
export const KEY_HELP = 'That doesn’t look like a stream key. Copy it again from your streaming site, with nothing extra.';

// ---------------------------------------------------------------- one click, one request

/** Single-flight guard: while one run is going, every further call is ignored (a double-click is ONE request). The flag is
 *  set synchronously, before any await, so two clicks in the same tick cannot both pass. */
export class Once {
  private running = false;
  get busy(): boolean { return this.running; }
  async run<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.running) return { ran: false };
    this.running = true;
    try { return { ran: true, value: await fn() }; } finally { this.running = false; }
  }
}

// ---------------------------------------------------------------- when to ask the helper

export interface PollInputs { active: boolean; docHidden: boolean; connected: boolean; avail: Avail; live: boolean }
/** Milliseconds until the next /status read, or null = ask nothing. A tab nobody is looking at asks nothing. */
export function pollDelayMs(p: PollInputs): number | null {
  if (!p.active || p.docHidden || !p.connected) return null;
  if (p.avail === 'no-helper') return null;
  return p.live ? 2000 : 4000;
}

/** A confirm card's token lives this long on the server; the card closes itself a little earlier. */
export const CONFIRM_CLOSE_MS = 28_000;
/** Seconds the private test runs (the server ends it too). */
export const DRY_RUN_SECONDS = 10;
/** Press End show twice within this long. */
export const END_ARM_MS = 3000;

export const toneClass = (t: HealthTone): string => `gl-${t}`;
