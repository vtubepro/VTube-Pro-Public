// Interview mode: THE auto director, in the host's studio (host / solo; never an ?observer=1 studio or a party guest).
//
// Every OBS page used to run its own director on what it measured itself — at its own frame rate, without the video
// guests' voices (the meter lives here), a reloaded page starting from scratch — so pages could cut differently, and the
// pages' only "voice" for the host was the avatar's mouth (a mouth that rests open = talking for ever: the VOD of
// 2026-10-08). Now the studio, which has every signal first-hand, decides:
//   host       the mic (the voice front-end's speaking level, src/tracking/audioLipSync.ts) + the camera mouth (only its
//              movement counts, src/scene/talkshow/activity.ts);
//   performers their voice samples / frames as they arrive (src/net/remoteSmoother.ts latestVoice), muted = silent;
//   video      the caller's voice from an audio input the host picks (the call app through a loopback / virtual cable)
//              or one of the audio mixer's sound inputs; none = presumed to talk while everyone else is quiet;
// and sends each cut + a heartbeat every second as a cue (shared/talkshow.ts InterviewCue) to this PC's OBS pages (bus)
// and to party guests (party wire 'ivcue' → their OBS pages). Pages follow the cue; without one for 2.5 s they direct
// themselves. Two studio windows: the lower bus id leads, the other stays quiet.
//
// Live controls (the Interview panel, Stream Deck, Ctrl+K): pin the shot on air, give a guest the floor ("Guest's
// turn"), pace; `explain()` feeds the panel's "why this shot" readout (studio only, never on stream).
import type { App } from '../../app.ts';
import { INTERVIEW_MODE, planLineup, roomCoverage, roomInterviewConfig, sanitizeInterview, type InterviewBag, type InterviewCue, type ShotId } from '../../../shared/talkshow.ts';
import { InterviewDirector, type DirectorOpts } from '../../scene/talkshow/director.ts';
import { InterviewVoices, type VoiceInput, type VoiceState } from '../../scene/talkshow/activity.ts';
import { CrowdEvents } from '../../scene/talkshow/crowd.ts';
import { listenCrowd } from './interviewCrowd.ts';
import { tvOfKey } from '../../net/tv/tvStudio.ts';

const TICK_MS = 100;

// ---------------------------------------------------------------- the video guests' voices (studio only)
/** Per video caller (in video order): an audio input of this PC (getUserMedia, never played: an analyser only) or one of
 *  the audio mixer's sound inputs ('mix:<id>'); levels 0..1 (−55 … −20 dBFS). */
export class VoiceMeter {
  private streams: (MediaStream | null)[] = [null, null, null];
  private an: (AnalyserNode | null)[] = [null, null, null];
  private ctx: AudioContext | null = null;
  devices: (string | null)[] = [null, null, null];
  levels: (number | null)[] = [null, null, null];
  /** the audio mixer's stats for a sound input (set by the host once the mixer is up) */
  mixStats: ((id: string) => { rms: number; open: number; gate: boolean } | null) | null = null;
  get on() { return this.devices.some(Boolean); }
  async set(i: number, deviceId: string | null) {
    this.streams[i]?.getTracks().forEach((t) => t.stop());
    this.streams[i] = null; this.an[i] = null; this.devices[i] = deviceId; this.levels[i] = null;
    if (deviceId && !deviceId.startsWith('mix:')) {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      this.ctx ??= new AudioContext();
      const src = this.ctx.createMediaStreamSource(s);
      const an = this.ctx.createAnalyser(); an.fftSize = 1024;
      src.connect(an);                                   // (an analyser only: never connected to the speakers)
      this.streams[i] = s; this.an[i] = an;
    }
  }
  private buf = new Float32Array(1024);
  /** Measure now (called by the director's tick). */
  tick() {
    for (let i = 0; i < 3; i++) {
      const d = this.devices[i];
      if (!d) { this.levels[i] = null; continue; }
      let db: number | null = null, shut = false;
      if (d.startsWith('mix:')) {
        const st = this.mixStats?.(d.slice(4)) ?? null;
        if (st) { db = st.rms; shut = st.gate && st.open < 0.2; }
      } else {
        const an = this.an[i];
        if (an) { an.getFloatTimeDomainData(this.buf); let e = 0; for (const v of this.buf) e += v * v; db = 10 * Math.log10(e / this.buf.length + 1e-10); }
      }
      if (db === null) { this.levels[i] = null; continue; }
      const lv = shut ? 0 : Math.min(1, Math.max(0, (db + 55) / 35));
      const prev = this.levels[i] ?? 0;
      this.levels[i] = lv > prev ? lv : prev * 0.6 + lv * 0.4;
    }
  }
}

export interface HostReadout {
  on: boolean; leading: boolean; following: string;
  shot: string; subject: string; why: string; held: number; cap: number; speaker: string; floor: string; manual: boolean;
  people: { id: string; name: string; talking: boolean; level: number; src: VoiceState['src'] | 'guess'; note: string }[];
}

class InterviewHost {
  readonly meter = new VoiceMeter();
  private director: InterviewDirector | null = null;
  private voices = new InterviewVoices();
  private t = 0;
  private lastSent = -1;
  private sentN = -1;
  private seenCut = -1;
  private bag: InterviewBag | null = null;
  private names = new Map<string, string>();
  private otherLead: { src: string; at: number } | null = null;
  /** The chat audience's laughs, cheers, raids, gift trains, "Answer now" and the show-open card, merged into the events the director
   *  reacts to (src/scene/talkshow/crowd.ts); the bag's bumperSeq is watched here. */
  private crowd = new CrowdEvents();
  private seenBumper = -1;
  private levels: Record<string, number> = {};
  private timer: Worker | null = null;
  /** This director's session (a new one each time Interview starts here): pages treat it as a new show. */
  private session = '';
  constructor(private app: App) {}

  start() {
    // a Worker's timer is never throttled in a background / covered studio tab (src/app.ts startBackgroundTicker)
    try {
      const w = new Worker(URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${TICK_MS});`], { type: 'text/javascript' })));
      w.onmessage = () => this.tick();
      this.timer = w;
    } catch { window.setInterval(() => this.tick(), TICK_MS); }
    // what the chat audience does (src/ui/stage/interviewCrowd.ts): the director reacts to it in its next step
    listenCrowd(this.app.bus, () => this.t, (e) => this.crowd.push(e));
    // another studio window's director (the web + the local studio both open): the lower id leads
    this.app.bus.on((m) => {
      if (m.type !== 'command' || m.command !== 'interview') return;
      const c = (m.args as { cue?: { src?: unknown } } | undefined)?.cue;
      if (c && typeof c.src === 'string' && c.src !== this.app.bus.id) this.otherLead = { src: c.src, at: performance.now() };
    });
    void import('../audioMixerPanel.ts').then((mx) => {
      this.meter.mixStats = (id) => { const st = mx.studioMixer()?.stats(id); return st ? { rms: st.rms, open: st.open, gate: st.gate } : null; };
    }).catch(() => {});
  }

  /** This studio runs the show's director (host / solo, in Interview, not an observer). */
  private get active() {
    const S = this.app.scene;
    return !this.app.observer && S.canEdit && (S.effective.mode as string) === INTERVIEW_MODE;
  }
  /** Another studio with a lower id is directing (heard within 3 s). */
  private get yielding() { const o = this.otherLead; return !!o && performance.now() - o.at < 3000 && o.src < this.app.bus.id; }

  private tick() {
    if (!this.active) { if (this.director) { this.director = null; this.voices = new InterviewVoices(); } this.crowd.take(); return; }
    const dt = TICK_MS / 1000;
    this.t += dt;
    const S = this.app.scene, P = this.app.party;
    const bag = sanitizeInterview((S as unknown as { modeBag(id: string): unknown }).modeBag(INTERVIEW_MODE));
    this.bag = bag;
    const plan = planLineup(bag, (g) => { const t = g.key ? tvOfKey(P, g.key) : null; return t ? { tv: true, look: t.look ?? 'tv' } : null; });
    this.meter.tick();
    // ---- signals
    const a = this.app.audio, f = this.app.frame;
    const am = a.active ? a.last : null;
    // (the fusion's own "speaking": src/tracking/speechFusion.ts)
    const hostSpeak = am ? Math.max(Math.min(1, am.level * 1.6) * (am.voiced || am.fv > 0.3 || am.sib > 0.3 ? 1 : 0.4), Math.max(am.fv, am.sib) * 0.7) : null;
    const inputs: VoiceInput[] = [{ id: 'host', kind: 'performer', speak: hostSpeak, open: f.tracked ? f.mouth.open : null }];
    const now = performance.now();
    const covered = !!(S.effective as { capcover?: { on?: boolean } }).capcover?.on;
    // (shared window wanted but none shared: the monitor shows "SHARE A WINDOW", the caller isn't on the show yet)
    const noWindow = bag.video === 'window' && !S.capturing;
    this.names = new Map([['host', 'You']]);
    let vi = 0;
    for (const x of plan) {
      this.names.set(x.id, x.g.name);
      if (x.kind === 'video') { const lv = this.meter.levels[vi++] ?? null; inputs.push({ id: x.id, kind: 'video', meter: lv, ready: !covered && !noWindow }); continue; }
      const key = x.g.key ?? '';
      const r = key ? P.remotes.get(key) : undefined;
      const muted = !!key && P.mod.micOff(key);
      const tv = key ? P.tvLinks.feeds.get(key) : undefined;
      const lv = r?.net.latestVoice(now) ?? null;
      const speak = muted ? 0 : tv ? tv.level : lv?.speak ?? null;
      inputs.push({ id: x.id, kind: 'performer', speak, open: muted ? null : lv?.open ?? null, ready: !!key && (key.startsWith('lib:') || P.members.some((m) => m.id === key)) });
    }
    this.levels = this.voices.levels(this.t, inputs);
    // ---- the director (the same code as every page's own)
    const guests = plan.filter((x) => x.role === 'guest'), cohosts = plan.filter((x) => x.role === 'cohost');
    const ready = Object.fromEntries(inputs.map((x) => [x.id, x.ready !== false]));
    // (a room whose set has no sidekick: never a sidekick cutaway)
    const info = S.scenes.find((x) => x.id === S.effective.sceneId) as unknown as { interview?: unknown } | undefined;
    const sidekick = bag.sidekick && roomInterviewConfig(S.effective.sceneId ?? '', info?.interview).sidekick !== null;
    // (cue v3: the room's cameras - house wide, audience, cutaways, band, jib - from its scene.json; the guests' names for a chat question that names one)
    const names: Record<string, string> = {};
    for (const x of plan) if (x.role === 'guest') names[x.id] = x.g.name;
    const opts: DirectorOpts = { pace: bag.pace, reactions: bag.reactions, pushIns: bag.pushIns, snaps: bag.snaps, guests: guests.length, cohosts: cohosts.length, layout: bag.layout, sidekick, seed: bag.seed,
      ready, voiceless: this.voices.voiceless().filter((id) => /^g\d$/.test(id)), seated: guests.filter((x) => x.place === 'studio' && x.kind !== 'video').length,
      ...(roomCoverage(info) ? { coverage: roomCoverage(info) } : {}), crowdCuts: bag.crowdCuts !== false, roomCams: bag.roomCams !== false, names };
    if (!this.director) { this.director = new InterviewDirector(opts); this.seenCut = bag.cutSeq; this.seenBumper = bag.bumperSeq; this.sentN = -1; this.session = Math.random().toString(36).slice(2, 10); this.crowd.take(); }
    const d = this.director;
    d.opts = opts;
    // (the host hit "Show open": the card plays on every page, the director crane-shots the host in when the curtain clears)
    if (bag.bumperSeq !== this.seenBumper) { this.seenBumper = bag.bumperSeq; this.crowd.push({ t: this.t, kind: 'bumper' }); }
    for (const e of this.crowd.take(this.t)) d.event(e);
    if (bag.cutSeq !== this.seenCut) { this.seenCut = bag.cutSeq; d.cut(bag.shot, bag.subject ?? '', bag); }
    // (an operator's turn in progress is never cut back to the pinned shot)
    if (bag.director === 'manual') { if (d.shot.shot !== bag.shot && !d.floorHolder) d.cut(bag.shot, bag.subject ?? '', bag); d.update(dt, this.levels, true); }
    else d.update(dt, this.levels);
    this.send();
  }

  /** The cue on every cut + a heartbeat each second (reloaded / late pages join the running show). */
  private send() {
    const d = this.director;
    if (!d || this.yielding) return;
    // the callers' voices too, while an input is picked (pages directing themselves — no cue for a moment — hear them)
    if (this.meter.on) this.app.bus.send({ type: 'command', command: 'interview', args: { v: this.meter.levels.map((x) => (x === null ? null : Math.round(x * 100) / 100)) } });
    const n = d.cutCount;
    if (n === this.sentN && this.t - this.lastSent < 1) return;
    const s = d.shot, b = d.lastBeat;
    // (cue v3: the same shot ids with optional fields - a room camera / the audience on a wide, a named move (secs 0), the sidekick
    // decision; an older page's sanitizer ignores them and shows the shot id it knows - shared/talkshow.ts InterviewCue)
    const cue: InterviewCue = { v: 3, s: this.session, n, shot: s.shot, subject: s.subject, ...(s.via ? { via: s.via } : {}), secs: s.mv ? 0 : s.secs, why: s.why.slice(0, 80), at: +d.onAirFor.toFixed(2), src: this.app.bus.id,
      ...(s.cam ? { cam: s.cam } : {}), ...(s.aud ? { aud: s.aud } : {}), ...(s.ak ? { ak: s.ak } : {}), ...(s.mv ? { mv: s.mv } : {}), sk: d.opts.sidekick ? 'on' : 'off', ...(d.cuesAsker ? { ac: 1 as const } : {}),
      ...(b && b.n === n ? { react: b.kind, rw: b.who } : {}) };
    this.app.bus.send({ type: 'command', command: 'interview', args: { cue } });
    try { (this.app.party as unknown as { sendInterviewCue?: (c: InterviewCue) => void }).sendInterviewCue?.(cue); } catch { /* party down */ }
    this.sentN = n; this.lastSent = this.t;
  }

  // ---------------------------------------------------------------- live controls
  /** The shot on air now + its subject (Pin: the manual director keeps exactly this). */
  onAir(): { shot: ShotId; subject: string } | null { return this.director ? { shot: this.director.shot.shot, subject: this.director.shot.subject } : null; }
  /** Give someone the floor ('host', 'c0', 'g0'…, 'guest' = the first guest on the show); '' = back to automatic. */
  floor(id: string, secs = 25): string {
    const d = this.director;
    if (!d) return '';
    if (id === 'guest') {
      const vl = d.opts.voiceless ?? [];
      id = vl.length > 1 ? 'gv' : Array.from({ length: d.opts.guests }, (_, i) => `g${i}`).find((g) => d.opts.ready?.[g] !== false) ?? '';
    }
    d.floor(id, secs);
    this.send();
    return id;
  }

  /** The panel's "why this shot" readout. */
  explain(): HostReadout {
    const d = this.director;
    const base = { on: this.active, leading: this.active && !this.yielding, following: this.yielding ? this.otherLead!.src : '' };
    if (!d) return { ...base, shot: '', subject: '', why: '', held: 0, cap: 0, speaker: '', floor: '', manual: false, people: [] };
    const e = d.explain(this.levels), vs = this.voices.state();
    const people = Object.entries(e.voices).map(([id, v]) => {
      const st = vs[id];
      const src = v.presumed ? 'guess' as const : st?.src ?? 'none';
      const note = !v.ready ? 'not on yet' : v.presumed ? 'no voice input: guessed while everyone else is quiet' : st?.bleed ? 'hearing the call through your mic: ignored'
        : st?.still ? 'mouth resting open: not counted as talking' : src === 'mouth' ? 'no mic: mouth movement' : src === 'none' ? 'no signal' : '';
      return { id, name: id === 'gv' ? 'The callers' : this.names.get(id) ?? id, talking: v.on, level: v.lvl, src, note };
    });
    // (the readout names people: "guest 1" → their name, "the host" → you)
    const why = e.why.replace(/\bguest (\d)\b/g, (m, k) => this.names.get(`g${+k - 1}`) ?? m).replace(/\bco-host (\d)\b/g, (m, k) => this.names.get(`c${+k - 1}`) ?? m).replace(/\bthe host\b/g, 'you');
    return { ...base, shot: e.shot, subject: e.subject, why, held: e.held, cap: e.cap, speaker: e.speaker, floor: e.floor, manual: bag(this.bag).director === 'manual', people };
  }
}
const bag = (b: InterviewBag | null) => b ?? sanitizeInterview(null);

let host: InterviewHost | null = null;
/** The studio's interview director (null before mountInterviewHost / in an observer studio). */
export const interviewHost = () => host;

/** Once, from the studio's start (src/main.ts): the director + the Interview hotkeys / Stream Deck commands. */
export function mountInterviewHost(app: App) {
  if (host || app.observer) return;
  host = new InterviewHost(app);
  host.start();
  void import('./panels/interview.ts').then((m) => m.installInterviewControls(app)).catch((e) => console.warn('interview controls', e));
}
