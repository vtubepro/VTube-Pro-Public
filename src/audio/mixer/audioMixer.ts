// Audio mixer runtime (beta.12): every guest voice the studio receives plays through here. Rules: shared/audioMix.ts;
// the card: src/ui/audioMixerPanel.ts; guide: docs/VOICE.md → "Audio mixer".
//
// Owner rule: guest voices come through the studio only, never straight to OBS. So, per guest voice (link guests and
// VTube Pro app guests alike):
//
//   voice ─► gate node (AudioWorklet: measures; gate + hiss clean-up when on, else passes untouched) ─► gain ─► speakers
//                │                                                                     (volume · Hear · on air · Mute for me · Mute for everyone)
//                └─► stats ~30 Hz ─► meters, "is talking", the director's level (TvLinks.levelGate) and app guests'
//                                    speaking signal (Party.voiceGated): both 0 while their gate is shut, whatever
//                                    "Mute for me" says
//
// TvStudio keeps its plain <audio> per guest only as the fallback while this can't carry a voice (the audio context
// hasn't started yet — no click in the studio since it loaded — or the gate module failed to load): never a silent guest
// because of the mixer, and still never on the OBS page. Backstage talk (green room) stays TvStudio's own player, which
// asks mutedForMe().
//
// Custody: audio lives in these nodes only, never recorded or stored. Observer tabs never play anything.
import { ME_ID, MIX_PREFS_KEY, MixPrefs, directorLevel, hostPlayGain, identityKey, type GateCfg, type SourcePrefs } from '../../../shared/audioMix.ts';

export interface MixSource { id: string; name: string; uid: string | null; track: MediaStreamTrack; kind: 'link' | 'app' | 'input' }
/** A sound input the host added (a camera's microphone, a capture card, an interface channel): played here in the studio. */
/** A sound input the host added. `ec` = the browser's echo cancelling (default on; off for a line-level source like a
 *  capture card, where it can wash out music). */
export interface InputDef { deviceId: string; label: string; ec?: boolean }
const INPUTS_KEY = 'vtp.audioMix.inputs';
/** A short, stable id for a device (its own id is long and not for the DOM). */
export const inputId = (deviceId: string) => { let h = 2166136261; for (let i = 0; i < deviceId.length; i++) { h ^= deviceId.charCodeAt(i); h = Math.imul(h, 16777619); } return `in:${(h >>> 0).toString(36)}`; };
/** What the mixer needs from the studio (wireMixer in src/ui/audioMixerPanel.ts connects it to the party + TvStudio). */
export interface MixerPort {
  readonly observer: boolean;
  /** Guest voices arriving here right now (host). */
  sources(): MixSource[];
  /** Who a party member is (name + Discord / link identity), voice or not (a reconnect, a new mic). */
  who(id: string): { name: string; uid: string | null } | null;
  /** Everyone in the party (host: the guests), voice or not: their volume memory follows moderation for all of them. */
  roster(): { id: string; name: string; uid: string | null }[];
  /** TvStudio "Hear guests here". */
  hear(): boolean;
  /** On air (not waiting in the green room / backstage). */
  air(id: string): boolean;
  /** Moderation "Mute for everyone" (also the BRB hush). */
  muted(id: string): boolean;
  /** The effective volume (TvStudio.voiceVol: the moderation volume). */
  vol(id: string): number;
  /** The moderation volume when the host set one this session (undefined = never, or back to 100 %). */
  modVol(id: string): number | undefined;
  /** Set the volume through moderation (one Undo step per drag). */
  setModVol(id: string, v: number): void;
  /** Re-route TvStudio (its fallback <audio> players, backstage players) after a mixer decision changed. */
  refresh(): void;
  /** My lip-sync mic (for the "You" meter), null = off. */
  mic(): MediaStream | null;
  /** Does this studio window play the show's sounds (src/audio/mixer/audioLeader.ts)? Sound inputs play only there. */
  leads?(): boolean;
}
export interface GateStats { peak: number; rms: number; post: number; open: number; gate: boolean; learning: boolean; floor: number; thr: number; clip: boolean }

interface Chain {
  id: string; track: MediaStreamTrack; sink: HTMLAudioElement | null;
  src: MediaStreamAudioSourceNode; node: AudioWorkletNode; play: GainNode;
  stats: GateStats | null; at: number; cfgSig: string;
}

const ls = { get(k: string) { try { return localStorage.getItem(k); } catch { return null; } }, set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };
const STALE_MS = 600;
/** Waits before retrying a failed start (then only "Try again" on the card). */
const RETRY_MS = [3000, 10_000, 30_000];

export class AudioMixer {
  readonly prefs = new MixPrefs(ls.get(MIX_PREFS_KEY));
  private ctx: AudioContext | null = null;
  private loading: Promise<boolean> | null = null;
  private chains = new Map<string, Chain>();
  private meters = 0;
  /** Guests seen this session (their remembered volume was put back once). */
  private seen = new Set<string>();
  /** The moderation volume last seen per guest (a change back to "never set" = back to 100 %: forget the reduction). */
  private lastMod = new Map<string, number | undefined>();
  private carried = new Set<string>();
  private dogT = 0;
  private syncQ = false;
  private fails = 0;
  private nextTry = 0;
  private retryT = 0;
  private wake = () => { if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => {}); };
  /** Why the mixer can't run (shown on the card); '' = fine. */
  error = '';
  /** Tests / diagnostics: contexts made and closed, start attempts. */
  readonly counts = { contexts: 0, closed: 0, attempts: 0 };
  readonly listeners = new Set<() => void>();

  constructor(private port: MixerPort) {
    try { const a = JSON.parse(ls.get(INPUTS_KEY) || '[]') as unknown; if (Array.isArray(a)) this.inputs = a.filter((x): x is InputDef => !!x && typeof x.deviceId === 'string' && x.deviceId.length <= 200 && typeof x.label === 'string').slice(0, 8).map((x) => ({ deviceId: x.deviceId, label: x.label.slice(0, 80), ...(x.ec === false ? { ec: false } : {}) })); } catch { /* none */ }
  }

  // ---------------------------------------------------------------- sound inputs (nothing until the host adds one)
  inputs: InputDef[] = [];
  private inStreams = new Map<string, { stream: MediaStream | null; error: string; busy: boolean }>();
  private saveInputs() { if (!this.port.observer) ls.set(INPUTS_KEY, JSON.stringify(this.inputs)); }
  /** Add an audio input device as a mixer row (remembered; opened at once). */
  addInput(deviceId: string, label: string) {
    if (this.port.observer || this.inputs.some((x) => x.deviceId === deviceId) || this.inputs.length >= 8) return;
    this.inputs.push({ deviceId, label: (label || 'Sound input').slice(0, 80) });
    this.saveInputs(); this.sync(); this.emit();
  }
  removeInput(id: string) {
    const d = this.inputs.find((x) => inputId(x.deviceId) === id);
    if (!d) return;
    this.inputs = this.inputs.filter((x) => x !== d);
    const st = this.inStreams.get(d.deviceId); st?.stream?.getTracks().forEach((t) => t.stop()); this.inStreams.delete(d.deviceId);
    this.saveInputs(); this.sync(); this.emit();
  }
  /** Echo cancelling on / off for one input (it re-opens the device). */
  setInputEcho(id: string, on: boolean) {
    const d = this.inputs.find((x) => inputId(x.deviceId) === id);
    if (!d || (d.ec !== false) === on) return;
    if (on) delete d.ec; else d.ec = false;
    const st = this.inStreams.get(d.deviceId); st?.stream?.getTracks().forEach((t) => t.stop()); this.inStreams.delete(d.deviceId);
    this.saveInputs(); this.sync(); this.emit();
  }
  /** Close every sound input device (this window stopped playing the show's sounds, or the mixer closes). */
  private stopInputs() {
    for (const st of this.inStreams.values()) { st.stream?.getTracks().forEach((t) => t.stop()); st.stream = null; }
  }
  /** This window started / stopped playing the show's sounds: sound inputs open only while it does. */
  leadChanged() { this.sync(); this.regain(); this.emit(); }
  private leading(): boolean { return this.port.leads?.() ?? true; }
  /** Why an input isn't playing ('' = fine / opening). */
  inputError(id: string): string { const d = this.inputs.find((x) => inputId(x.deviceId) === id); return d ? this.inStreams.get(d.deviceId)?.error ?? '' : ''; }
  /** The added inputs, open or not (the card lists them all). */
  inputRows(): { id: string; label: string; open: boolean; error: string; ec: boolean; elsewhere: boolean }[] {
    const lead = this.leading();
    return this.inputs.map((d) => { const st = this.inStreams.get(d.deviceId); const tr = st?.stream?.getAudioTracks()[0]; return { id: inputId(d.deviceId), label: d.label, open: !!tr && tr.readyState === 'live', error: st?.error ?? '', ec: d.ec !== false, elsewhere: !lead }; });
  }
  private inputSources(): MixSource[] {
    const out: MixSource[] = [];
    // the device is open only in the window that plays the show's sounds (never two windows holding the same mic)
    if (!this.leading()) { this.stopInputs(); return out; }
    for (const d of this.inputs) {
      let st = this.inStreams.get(d.deviceId);
      if (!st) { st = { stream: null, error: '', busy: false }; this.inStreams.set(d.deviceId, st); }
      const tr = st.stream?.getAudioTracks()[0];
      if (tr && tr.readyState === 'live') { out.push({ id: inputId(d.deviceId), name: d.label, uid: `input:${d.deviceId}`, track: tr, kind: 'input' }); continue; }
      if (st.busy || st.error || this.port.observer || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) continue;
      st.busy = true;
      const s0 = st;
      // Echo cancelling ON by default (a mic that hears the studio's speakers would otherwise put the guests back on
      // stream with a delay); the row can turn it off for a line-level source. Automatic gain stays OFF: the noise gate
      // needs steady levels (gain riding would lift the background noise over its threshold). Noise suppression OFF:
      // the mixer's own "Clean up hiss" does that, per input.
      void navigator.mediaDevices.getUserMedia({ video: false, audio: { deviceId: { exact: d.deviceId }, echoCancellation: d.ec !== false, noiseSuppression: false, autoGainControl: false } })
        .then((m) => {
          // (removed, re-opened, or this window stopped leading while the browser was opening it: let it go)
          if (!this.inputs.includes(d) || this.inStreams.get(d.deviceId) !== s0 || !this.leading()) { m.getTracks().forEach((t) => t.stop()); return; }
          s0.stream = m; s0.error = '';
          for (const t of m.getTracks()) t.addEventListener('ended', () => { if (s0.stream === m) { s0.stream = null; this.sync(); this.emit(); } });
        })
        .catch((e: Error) => { s0.error = e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'This device isn’t connected right now.' : e?.name === 'NotAllowedError' ? 'The browser blocked it: allow the microphone for this page.' : 'It couldn’t be opened.'; })
        .finally(() => { s0.busy = false; this.sync(); this.emit(); });
    }
    return out;
  }
  /** Try the inputs that failed to open again (the card's "Try again"). */
  retryInputs() { for (const st of this.inStreams.values()) st.error = ''; this.sync(); }
  private isInput(id: string) { return id.startsWith('in:'); }
  private inputWho(id: string): { name: string; uid: string } | null { const d = this.inputs.find((x) => inputId(x.deviceId) === id); return d ? { name: d.label, uid: `input:${d.deviceId}` } : null; }
  private who(id: string): { name: string; uid: string | null } | null { return this.isInput(id) ? this.inputWho(id) : this.port.who(id); }

  // ---------------------------------------------------------------- settings
  /** id → identity key + "Mute for me", refreshed on every sync (the hooks run every 66 ms: no lookups there). */
  private keys = new Map<string, string>();
  private muteIds = new Set<string>();
  keyOf(id: string): string { const k = this.keys.get(id); if (k !== undefined) return k; const w = this.who(id); return w ? identityKey(w) : ''; }
  private save() { if (!this.port.observer) ls.set(MIX_PREFS_KEY, this.prefs.toText()); }
  /** Guests with no stable identity keep their settings for this connection only. */
  private session = new Map<string, SourcePrefs>();
  private sessionGet(id: string): SourcePrefs { return this.session.get(id) ?? this.prefs.get(''); }
  prefsOf(id: string): SourcePrefs { const k = this.keyOf(id); return k ? this.prefs.get(k) : this.sessionGet(id); }
  /** Change a guest's mixer settings (remembered by who they are). */
  set(id: string, patch: { muteMe?: boolean; clean?: boolean; gate?: Partial<GateCfg> }) {
    const s = this.who(id);
    if (!s) return;
    const key = identityKey(s);
    if (!this.prefs.set(key, patch, s.name)) { const cur = this.sessionGet(id); this.session.set(id, { ...cur, ...patch, gate: { ...cur.gate, ...(patch.gate ?? {}) } }); }
    if (patch.muteMe !== undefined) { if (patch.muteMe) this.muteIds.add(id); else this.muteIds.delete(id); }
    this.save();
    this.sync();
    this.regain();
    this.port.refresh();
    this.emit();
  }
  /** The volume slider: the moderation volume (what Live → People shows too), remembered by who they are. */
  setVolume(id: string, v: number) {
    const x = Math.min(1, Math.max(0, v));
    if (this.isInput(id)) { const k = this.keyOf(id); if (k) { this.prefs.set(k, { vol: x >= 0.995 ? undefined : x }, this.inputWho(id)?.name); this.save(); } this.regain(); this.emit(); return; }
    this.port.setModVol(id, x);
    // (remembered under their identity even while their voice is briefly gone — a reconnect, a new mic; the next sync
    //  sees the same moderation value and leaves it)
    const k = this.keyOf(id);
    if (k) { this.prefs.set(k, { vol: x >= 0.995 ? undefined : x }, this.who(id)?.name); this.save(); }
    this.regain();
    this.emit();
  }
  relearn(id: string) { this.chains.get(id)?.node.port.postMessage({ cfg: { relearn: true } }); }

  // ---------------------------------------------------------------- hooks (TvStudio / TvLinks / Party ask these)
  /** Is the mixer playing this voice right now (node built, context running, reporting)? */
  carries(id: string): boolean { const c = this.chains.get(id); return !!c && id !== ME_ID && !!c.stats && performance.now() - c.at < STALE_MS && this.ctx?.state === 'running'; }
  /** TvStudio: don't give this guest a plain <audio> (muted for me, or the mixer plays them). */
  skipPlayer(id: string): boolean { return this.muteIds.has(id) || this.carries(id); }
  /** TvStudio's backstage player too: "Mute for me" is for everything I hear. */
  mutedForMe(id: string): boolean { return this.muteIds.has(id); }
  private gateShut(id: string): boolean { const c = this.chains.get(id); return !!c && this.carries(id) && !!c.stats?.gate && c.stats.open <= 0.05; }
  /** TvLinks (link guests): the level the director / speaking glow get (0 while their gate is shut; never the volume). */
  levelGate(id: string, reported: number): number {
    // (Auto gate still learning their background — its first 3 s: the cameras don't take their level yet, so a noisy
    //  room can't win a cut before the floor is known; their voice is heard meanwhile. App guests keep their mouth:
    //  their own app's voice filter already gates it, and closing it for 3 s would cut their first words on stream.)
    const st = this.carries(id) ? this.chains.get(id)?.stats : null;
    if (st?.learning) return 0;
    return directorLevel({ reported, quiet: false, gate: st?.gate ? { open: !this.gateShut(id) } : null });
  }
  /** Party (app guests): their voice-mouth samples — the speaking signal every page's director reads — are dropped
   *  while their gate is shut. */
  voiceGated(id: string): boolean { return this.gateShut(id); }

  // ---------------------------------------------------------------- meters (the card)
  /** The card is open: also measure my own mic (returns the stop function). */
  meter(): () => void {
    this.meters++;
    this.sync();
    let done = false;
    return () => { if (done) return; done = true; this.meters = Math.max(0, this.meters - 1); this.sync(); };
  }
  stats(id: string): GateStats | null { const c = this.chains.get(id); return c && c.stats && performance.now() - c.at < STALE_MS * 2 ? c.stats : null; }
  get state(): AudioContextState | 'none' { return this.ctx?.state ?? 'none'; }
  /** Start a suspended context now (call from a click). */
  resume() { this.wake(); }
  /** The card's "Try again" after a failed start. */
  retryNow() { clearTimeout(this.retryT); this.retryT = 0; this.nextTry = 0; this.fails = 0; this.buildFails.clear(); this.error = ''; this.sync(); this.wake(); }

  // ---------------------------------------------------------------- graph
  /** Bring the nodes in line with the voices + settings (coalesced). */
  sync() {
    if (this.syncQ) return;
    this.syncQ = true;
    queueMicrotask(() => { this.syncQ = false; void this.applyOnce(); });
  }
  private applying = false; private again = false;
  private async applyOnce() {
    if (this.applying) { this.again = true; return; }
    this.applying = true;
    try { do { this.again = false; await this.apply(); } while (this.again); }
    finally { this.applying = false; }
  }
  private async apply() {
    const srcs = this.port.observer ? [] : [...this.port.sources(), ...this.inputSources()];
    const roster = this.port.observer ? [] : this.port.roster();
    this.keys = new Map([...roster.map((m) => [m.id, identityKey(m)] as const), ...srcs.map((s) => [s.id, identityKey(s)] as const)]);
    // a guest's first appearance this session (voice or not): put back the volume remembered for them (one moderation step)
    for (const m of roster) {
      if (this.seen.has(m.id)) continue;
      this.seen.add(m.id);
      const k = identityKey(m), v = k ? this.prefs.get(k).vol : undefined;
      if (v !== undefined && this.port.modVol(m.id) === undefined) this.port.setModVol(m.id, v);
      this.lastMod.set(m.id, this.port.modVol(m.id));
    }
    // ... and keep remembering what the host sets elsewhere (Live → People), including back to 100 % / Undo — for
    // everyone in the party, whether or not their voice is connected right now
    for (const m of roster) {
      const k = identityKey(m), mv = this.port.modVol(m.id), was = this.lastMod.get(m.id);
      this.lastMod.set(m.id, mv);
      if (!k || mv === was) continue;
      const v = mv === undefined || mv >= 0.995 ? undefined : mv;
      if (v !== this.prefs.get(k).vol) { this.prefs.set(k, { vol: v }, m.name); this.save(); }
    }
    for (const id of [...this.lastMod.keys()]) if (!this.keys.has(id)) this.lastMod.delete(id);
    for (const id of [...this.session.keys()]) if (!this.keys.has(id)) this.session.delete(id);
    // "Mute for me" membership: re-route TvStudio NOW, before any await (a returning guest muted for me must lose the
    // plain <audio> TvStudio just gave them even while the audio context / gate module is still loading)
    const mutes = new Set(srcs.filter((s) => this.prefsOf(s.id).muteMe).map((s) => s.id));
    if (mutes.size !== this.muteIds.size || [...mutes].some((id) => !this.muteIds.has(id))) { this.muteIds = mutes; this.port.refresh(); }
    else this.muteIds = mutes;

    const want = new Map<string, { track: MediaStreamTrack; remote: boolean }>();
    for (const s of srcs) if (s.track.readyState === 'live') want.set(s.id, { track: s.track, remote: s.kind !== 'input' });
    const mic = this.meters > 0 && !this.port.observer ? this.port.mic()?.getAudioTracks()[0] ?? null : null;
    if (mic && mic.readyState === 'live') want.set(ME_ID, { track: mic, remote: false });
    for (const [id, c] of this.chains) {
      const w = want.get(id);
      if (!w || w.track !== c.track || c.track.readyState !== 'live') this.drop(id);
    }
    for (const id of [...this.buildFails.keys()]) { const f = this.buildFails.get(id)!; if (!want.has(id) || want.get(id)!.track !== f.track) this.buildFails.delete(id); }
    let refresh = false;
    if (want.size && (await this.ensure())) {
      for (const [id, w] of want) {
        const c = this.chains.get(id) ?? this.build(id, w.track, w.remote);
        if (!c) continue;
        const p = id === ME_ID ? null : this.prefsOf(id);
        const cfg = p ? { mode: p.gate.mode, threshold: p.gate.threshold, attack: p.gate.attack, hold: p.gate.hold, release: p.gate.release, clean: p.clean } : { mode: 'off', clean: false };
        const sig = JSON.stringify(cfg);
        if (sig !== c.cfgSig) { c.cfgSig = sig; c.node.port.postMessage({ cfg }); }
      }
    }
    if (!want.size && this.ctx) this.close();
    this.regain();
    this.watch();
    if (this.checkCarried()) refresh = true;
    if (refresh) this.port.refresh();
    this.emit();
  }
  /** A retry, scheduled (and replaced / cancelled: "Try again", close). */
  private schedule(ms: number) {
    clearTimeout(this.retryT);
    this.retryT = setTimeout(() => { this.retryT = 0; this.sync(); }, ms) as unknown as number;
  }
  private async ensure(): Promise<boolean> {
    if (this.ctx && this.ctx.state !== 'closed') return true;
    this.ctx = null;
    if (performance.now() < this.nextTry) return false;
    // never wait for a start here: a sync that runs meanwhile (a mute, a guest leaving) must not queue behind a slow or
    // stuck module load; the start syncs again when it is done
    if (this.loading) return false;
    const p = this.start();
    this.loading = p;
    // (cleared once THIS attempt settles — a start that failed synchronously can't leave a settled promise behind)
    void p.finally(() => { if (this.loading === p) this.loading = null; this.sync(); });
    return false;
  }
  private async start(): Promise<boolean> {
    let ctx: AudioContext | null = null;
    this.counts.attempts++;
    try {
      const o = { latencyHint: 'interactive', sampleRate: 48_000 } as AudioContextOptions;
      try { ctx = new AudioContext(o); } catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
      this.counts.contexts++;
      // (a module load that never answers counts as a failure after 10 s: closed, retried later)
      let to = 0;
      await Promise.race([ctx.audioWorklet.addModule(new URL('./gate-worklet.js', import.meta.url).href),
        new Promise((_, no) => { to = setTimeout(() => no(new Error('the gate module took too long to load')), 10_000) as unknown as number; })]).finally(() => clearTimeout(to));
      this.ctx = ctx;
      const mine = ctx;
      for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, this.wake, { capture: true, passive: true });
      ctx.addEventListener('statechange', () => { if (this.ctx === mine) { if (this.checkCarried()) this.port.refresh(); this.emit(); } });
      this.wake();
      this.error = ''; this.fails = 0; this.nextTry = 0;
      return true;
    } catch (e) {
      // unwind: nothing half-built stays open; retry after 3 / 10 / 30 s (scheduled), then only on "Try again"
      // (guests keep playing the plain way in the studio meanwhile)
      if (ctx) { this.counts.closed++; void ctx.close().catch(() => {}); }
      this.fails++;
      if (this.fails <= RETRY_MS.length) { this.nextTry = performance.now() + RETRY_MS[this.fails - 1]; this.schedule(RETRY_MS[this.fails - 1] + 20); }
      else this.nextTry = Infinity;
      this.error = `The noise gate couldn’t start (${(e as Error)?.message || 'audio error'}). Your guests still play here in the studio, without a gate.`;
      return false;
    }
  }
  /** Per voice: node builds that failed (the same back-off, then only on "Try again"). */
  private buildFails = new Map<string, { track: MediaStreamTrack; n: number; next: number }>();
  private build(id: string, track: MediaStreamTrack, remote: boolean): Chain | null {
    const f = this.buildFails.get(id);
    if (f && f.track === track && performance.now() < f.next) return null;
    const ctx = this.ctx!;
    let sink: HTMLAudioElement | null = null, src: MediaStreamAudioSourceNode | null = null, node: AudioWorkletNode | null = null, play: GainNode | null = null;
    try {
      const stream = new MediaStream([track]);
      // (Chromium only feeds a REMOTE WebRTC track into WebAudio while it also plays in a media element: a muted one)
      if (remote) { sink = new Audio(); sink.muted = true; sink.volume = 0; sink.srcObject = stream; void sink.play().catch(() => {}); }
      src = ctx.createMediaStreamSource(stream);
      node = new AudioWorkletNode(ctx, 'vtp-mix-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'clamped-max' });
      play = ctx.createGain(); play.gain.value = 0;
      src.connect(node).connect(play).connect(ctx.destination);
      const c: Chain = { id, track, sink, src, node, play, stats: null, at: 0, cfgSig: '' };
      node.port.onmessage = (e) => { c.stats = e.data as GateStats; c.at = performance.now(); if (!this.carried.has(id) && this.carries(id) && this.checkCarried()) this.port.refresh(); };
      this.chains.set(id, c);
      this.buildFails.delete(id);
      return c;
    } catch (e) {
      // unwind whatever was made; retry this voice after 3 / 10 / 30 s, then only on "Try again"
      try { src?.disconnect(); node?.disconnect(); play?.disconnect(); node?.port.postMessage({ bye: true }); } catch { /* */ }
      if (sink) { sink.pause(); sink.srcObject = null; }
      const n = (f && f.track === track ? f.n : 0) + 1;
      const wait = n <= RETRY_MS.length ? RETRY_MS[n - 1] : Infinity;
      this.buildFails.set(id, { track, n, next: performance.now() + wait });
      if (Number.isFinite(wait)) this.schedule(wait + 20);
      this.error = `A voice couldn’t join the mixer (${(e as Error)?.message || 'audio error'}): it plays the plain way.`;
      return null;
    }
  }
  /** Speaker gains: volume · Hear · on air · Mute for me · Mute for everyone (my own mic: never played). */
  regain() {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const c of this.chains.values()) {
      const g = c.id === ME_ID || !this.carries(c.id) ? 0
        // a sound input: its own volume and Mute, only in the window that plays the show's sounds
        : this.isInput(c.id) ? ((this.port.leads?.() ?? true) && !this.muteIds.has(c.id) ? this.prefsOf(c.id).vol ?? 1 : 0)
        : hostPlayGain({ hear: this.port.hear(), air: this.port.air(c.id), vol: this.port.vol(c.id), muteMe: this.muteIds.has(c.id), muted: this.port.muted(c.id) });
      if (Math.abs(c.play.gain.value - g) > 1e-4) c.play.gain.setTargetAtTime(g, ctx.currentTime, 0.02);
    }
  }
  private drop(id: string) {
    const c = this.chains.get(id);
    if (!c) return;
    this.chains.delete(id);
    try { c.node.port.postMessage({ bye: true }); c.src.disconnect(); c.node.disconnect(); c.play.disconnect(); } catch { /* */ }
    if (c.sink) { c.sink.pause(); c.sink.srcObject = null; }
  }
  /** Who the mixer started / stopped carrying since last time (true = TvStudio must re-route). */
  private checkCarried(): boolean {
    let changed = false;
    for (const id of new Set([...this.chains.keys(), ...this.carried])) {
      const r = this.carries(id);
      if (r !== this.carried.has(id)) { changed = true; if (r) this.carried.add(id); else this.carried.delete(id); }
    }
    if (changed) this.regain();
    return changed;
  }
  private watch() {
    const any = this.chains.size > 0;
    if (any && !this.dogT) this.dogT = window.setInterval(() => { if (this.checkCarried()) { this.port.refresh(); this.emit(); } }, 400);
    if (!any && this.dogT) { clearInterval(this.dogT); this.dogT = 0; }
  }
  close() {
    this.stopInputs();                       // (the devices too: nothing keeps a mic open after the mixer closes)
    for (const id of [...this.chains.keys()]) this.drop(id);
    if (typeof window !== 'undefined') for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, this.wake, { capture: true });
    if (this.dogT) { clearInterval(this.dogT); this.dogT = 0; }
    clearTimeout(this.retryT); this.retryT = 0;
    if (this.ctx) { this.counts.closed++; void this.ctx.close().catch(() => {}); }
    this.ctx = null;
    if (this.checkCarried()) this.port.refresh();
  }
  /** Tests / diagnostics: who has a node, whether it plays, their numbers. */
  debug() {
    return { state: this.state, error: this.error, meters: this.meters, counts: { ...this.counts }, fails: this.fails,
      chains: Object.fromEntries([...this.chains].map(([id, c]) => [id, { carries: this.carries(id), playGain: +c.play.gain.value.toFixed(3), stats: c.stats }])) };
  }
  private emit() { for (const l of this.listeners) try { l(); } catch (e) { console.warn('mixer listener', e); } }
}
