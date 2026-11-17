// Party voice: in-app voice for VTube Pro APP guests (no Discord needed). Rules + wire: shared/partyVoice.ts.
//
//   guest ──'vox' PeerConnection (one audio transceiver, sendrecv; the guest offers)──► host
//     guest → host: my echo-cancelled mic (muted = the track sends silence; no renegotiation)
//     host → guest: the host's mix-minus for me (voiceMixer.ts): the host's talk-back mic + every OTHER on-air voice
//                   (app guests AND browser link guests). A 1-to-1 call sends the host's mic track as is.
//
// Host side it plugs into what link guests already have (src/net/tv/tvStudio.ts): the same Hear / volume / Mute /
// "Also on OBS" settings, the same talk-back mic, the green room gate (party.voiceGate: a waiting guest is in nobody's
// mix and hears nothing but the host's backstage voice). Link guests get the mix-minus back on their TV 'up' link
// (tvLink.ts mixFor) whenever someone besides the host is on the call, so everyone hears everyone.
//
// Guest side: "Talk in VTube Pro (no Discord)" (default on when the host supports it), mic + output pickers, mute
// button + hotkey (Alt+M by default, push-to-talk option: the link page's approach), "Using Discord voice instead".
// The guest's own OBS pages never get the call audio (nothing here publishes to them).
//
// Custody: audio lives in these connections, WebAudio nodes and <audio> elements only — never recorded or stored.
import { HOST_BACK, HOST_MAIN, VOX_CAP, deliveryOf, guestVoxState, mixPlan, planProblems, sanitizeVoxSig, type MixInput, type MixPerson, type MixPlan, type VoxGate, type VoxGuestState, type VoxMode, type VoxSig } from '../../../shared/partyVoice.ts';
import { DEFAULT_COMBO, comboFrom, comboMatch, comboTypes, readCombo, type Combo } from '../../../shared/greenroom.ts';
import { VoiceMixer } from './voiceMixer.ts';

/** What the party gives the voice links (src/party.ts implements it). */
export interface VoxPort {
  readonly role: 'none' | 'host' | 'guest';
  readonly myId: string;
  /** ctl → a guest (host) / the host (guest). false = no open link / the peer lacks VOX_CAP. */
  sendVox(to: string, m: VoxSig): boolean;
  rtcConfig(): RTCConfiguration;
  /** host: ready guests that speak VOX_CAP; guest: [host id] when the host does. */
  voxPeers(): string[];
  /** guest: the host's caps (null = no welcome yet). */
  hostCaps(): string[] | null;
  /** host: a member's green room gate. */
  gate(id: string): VoxGate;
  /** host: the host's volume for a guest (0 = muted in People). */
  volume(id: string): number;
  /** host: browser link guests' voices (TV links) and who of them can hear a return. */
  linkVoices(): Map<string, MediaStreamTrack>;
  linkListeners(): string[];
  /** host: my talk-back mic (null = off) and backstage voice (null = none of its own). */
  hostTracks(): { main: MediaStreamTrack | null; back: MediaStreamTrack | null };
  /** host: hand link guest returns to the TV links (a mix track, or undefined = their usual return). */
  setLinkReturns(m: Map<string, MediaStreamTrack | null>): void;
  /** guest: my mute state changed (the party also tells the green room). */
  muteChanged?(muted: boolean): void;
}

interface HostPc { pc: RTCPeerConnection; iceQ: RTCIceCandidateInit[]; remote: boolean; tr: RTCRtpTransceiver | null }
interface GuestPc extends HostPc { tries: number }
export interface VoxPeerState { mode: VoxMode; muted: boolean; mic: boolean }

const PREF = { mode: 'vtp.pv.mode', mic: 'vtp.pv.mic', sink: 'vtp.pv.sink', vol: 'vtp.pv.vol', key: 'vtp.pv.muteKey', ptt: 'vtp.pv.ptt' };
const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } };
const backoff = (n: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, Math.min(5, n - 1)));
const DISCONNECT_MS = 5000;
/** A studio hotkey must not collide with the Trail's M (map) or Discord's Ctrl+Shift+M: Alt+M by default. */
export const STUDIO_MUTE_COMBO: Combo = { ...DEFAULT_COMBO, alt: true };
const SINK_OK = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
const typing = (t: EventTarget | null) => { const e = t as HTMLElement | null; return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || e.isContentEditable); };
const audioLevel = (r: RTCRtpReceiver | undefined | null): number => {
  try {
    const s = r?.getSynchronizationSources?.()[0];
    if (!s) return 0;
    // (browsers disagree on the time base of `timestamp`: epoch or page time — stale in both = no level)
    const age = Math.min(Math.abs(performance.timeOrigin + performance.now() - s.timestamp), Math.abs(performance.now() - s.timestamp));
    return age < 1000 ? s.audioLevel ?? 0 : 0;
  } catch { return 0; }
};

export class PartyVoice {
  // ---------------------------------------------------------------- guest (my prefs + my link to the host)
  /** 'app' = talk in VTube Pro (default), 'discord' = I'm in the Discord call instead, 'off' = no voice. */
  mode: VoxMode = ((): VoxMode => { const v = ls(PREF.mode); return v === 'discord' || v === 'off' ? v : 'app'; })();
  micId = ls(PREF.mic) ?? '';
  sink = ls(PREF.sink) ?? '';
  outVol = ((): number => { const v = Number(ls(PREF.vol) ?? '1'); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; })();
  combo: Combo = readCombo(ls(PREF.key)) ?? STUDIO_MUTE_COMBO;
  ptt = ls(PREF.ptt) === '1';
  muted = false;
  micError = '';
  micLabel = '';
  sinkError = '';
  readonly sinkOk = SINK_OK;
  private up: GuestPc | null = null;
  private mic: MediaStream | null = null;
  private micBusy: Promise<void> | null = null;
  /** The host's mix for me, and the element playing it (my headphones). */
  hostStream: MediaStream | null = null;
  private player: HTMLAudioElement | null = null;
  private meter: { ctx: AudioContext; an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  private pttHeld = false;
  private stateT = 0; private stateAt = 0; private muteSent = false;

  // ---------------------------------------------------------------- host
  private pcs = new Map<string, HostPc>();
  /** App guests' voices (host), by guest id. */
  readonly voices = new Map<string, { stream: MediaStream; track: MediaStreamTrack }>();
  /** What each app guest says they use (mode / muted / mic), host side. */
  readonly peers = new Map<string, VoxPeerState>();
  private mixer = new VoiceMixer();
  /** The last plan (tests / diagnostics). */
  plan: MixPlan = {};
  planInput: MixInput | null = null;
  private replanQ = false;

  readonly listeners = new Set<() => void>();
  log: (s: string) => void = () => {};

  constructor(private port: VoxPort, private observer = false) {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => this.onKey(e, true), true);
      window.addEventListener('keyup', (e) => this.onKey(e, false), true);
      window.addEventListener('blur', () => { if (this.ptt && this.pttHeld) { this.pttHeld = false; this.setMuted(true); } });
    }
  }

  // ================================================================ guest
  /** Why in-app voice is (not) running for me right now. */
  get guestState(): VoxGuestState { return guestVoxState({ role: this.port.role, hostCaps: this.port.hostCaps(), mode: this.observer ? 'off' : this.mode }); }
  get connected(): boolean { return this.up?.pc.connectionState === 'connected'; }
  get linkState(): string { return this.up ? this.up.pc.connectionState : '—'; }

  setMode(m: VoxMode) {
    if (this.mode === m) return;
    this.mode = m; lsSet(PREF.mode, m);
    this.guestSync();
    this.emit();
  }
  /** Pick my microphone ('' = the system default); a running call switches over without renegotiating. */
  async setMic(id: string) {
    this.micId = id; lsSet(PREF.mic, id);
    if (this.up) await this.openMic(true);
    this.emit();
  }
  /** Where the host's mix plays ('' = the default output). Chromium only. */
  setSink(id: string) {
    this.sink = id; lsSet(PREF.sink, id);
    if (this.player) this.sinkTo(this.player);
    this.emit();
  }
  setOutVol(v: number) { this.outVol = Math.min(1, Math.max(0, v)); lsSet(PREF.vol, String(this.outVol)); if (this.player) this.player.volume = this.outVol; this.emit(); }
  setCombo(c: Combo) { this.combo = c; lsSet(PREF.key, JSON.stringify(c)); this.emit(); }
  setPtt(on: boolean) { this.ptt = on; lsSet(PREF.ptt, on ? '1' : '0'); this.pttHeld = false; if (on) this.setMuted(true); this.emit(); }
  /** Capture the next key combo as the mute hotkey (the panel's "Change" button; Esc cancels). */
  capturing = false;
  setCapturing(on: boolean) { this.capturing = on; this.emit(); }
  /** moderation (guest): the host muted me — my own unmute is refused until the host lifts it. */
  hostLock = false;
  setMuted(on: boolean) {
    if (!on && this.hostLock) { this.emit(); return; }
    if (this.muted === on) return;
    this.muted = on;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !on;
    this.sendState();
    this.emit();
  }
  toggleMute() { if (!this.ptt) this.setMuted(!this.muted); }
  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.capturing && down) {
      if (e.code === 'Escape') { this.capturing = false; this.emit(); return; }
      const c = comboFrom(e);
      if (!c) return;
      e.preventDefault(); e.stopPropagation();
      this.capturing = false; this.setCombo(c);
      return;
    }
    if (this.guestState !== 'on') return;
    if (down) {
      if (e.repeat || !comboMatch(this.combo, e) || (comboTypes(this.combo) && typing(e.target))) return;
      e.preventDefault();
      if (this.ptt) { this.pttHeld = true; this.setMuted(false); } else this.setMuted(!this.muted);
    } else if (this.ptt && this.pttHeld && comboMatch(this.combo, e, true)) { this.pttHeld = false; this.setMuted(true); }
  }
  /** Push-to-talk button (hold). */
  pttPress(down: boolean) { if (!this.ptt) return; this.pttHeld = down; this.setMuted(!down); }

  /** My mic level 0..1 (0 while muted) — the panel meter. */
  micLevel(): number {
    const m = this.meter; if (!m || this.muted) return 0;
    m.an.getFloatTimeDomainData(m.buf); let pk = 0; for (const x of m.buf) pk = Math.max(pk, Math.abs(x));
    return Math.min(1, pk * 1.4);
  }
  /** The host's mix level as it arrives (someone is talking to me). */
  hostLevel(): number { return audioLevel(this.up?.tr?.receiver); }

  /** Start / stop my link to match the prefs + what the host speaks. */
  private guestSync() {
    if (this.port.role !== 'guest') return;
    const want = this.guestState === 'on';
    if (want && !this.up) void this.startUp();
    if (!want && this.up) this.stopUp(true);
    this.sendState(true);
  }
  private async openMic(replace = false) {
    const run = async () => {
      const want = (id: string) => navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      let st: MediaStream | null = null;
      try { st = await want(this.micId).catch((e) => { if (!this.micId) throw e; return want(''); }); this.micError = ''; }
      catch (e) { this.micError = (e as Error).message || 'Microphone blocked'; }
      if (!this.up && !replace) { st?.getTracks().forEach((t) => t.stop()); return; }
      const old = this.mic;
      this.mic = st;
      const tr = st?.getAudioTracks()[0] ?? null;
      if (tr) { tr.enabled = !this.muted; this.micLabel = tr.label; }
      await this.up?.tr?.sender.replaceTrack(tr).catch(() => {});
      old?.getTracks().forEach((t) => t.stop());
      void this.meter?.ctx.close().catch(() => {}); this.meter = null;
      if (st) try {
        const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512;
        ctx.createMediaStreamSource(st).connect(an);   // (analyser only: never to the speakers)
        this.meter = { ctx, an, buf: new Float32Array(an.fftSize) };
      } catch { /* meter is optional */ }
      this.sendState();
    };
    const p = (this.micBusy ?? Promise.resolve()).then(run);
    this.micBusy = p.finally(() => { if (this.micBusy === p) this.micBusy = null; });
    await p;
  }
  private async startUp(tries = 0) {
    const host = this.port.voxPeers()[0];
    if (!host || this.up) return;
    const pc = new RTCPeerConnection(this.port.rtcConfig());
    const x: GuestPc = { pc, iceQ: [], remote: false, tr: null, tries };
    this.up = x;
    x.tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    pc.onicecandidate = (e) => this.port.sendVox(host, { t: 'vsig', k: 'ice', cand: e.candidate ? e.candidate.toJSON() : null });
    pc.ontrack = (e) => {
      if (x !== this.up || e.track.kind !== 'audio') return;
      try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 40; } catch { /* */ }
      this.hostStream = new MediaStream([e.track]);
      this.play();
      this.emit();
    };
    let discT = 0;
    pc.addEventListener('connectionstatechange', () => {
      if (x !== this.up) return;
      const s = pc.connectionState;
      this.log(`guest vox: ${s}`);
      clearTimeout(discT);
      if (s === 'connected') x.tries = 0;
      if (s === 'failed' || s === 'closed') this.retryUp(x);
      if (s === 'disconnected') discT = window.setTimeout(() => { if (x === this.up && pc.connectionState === 'disconnected') this.retryUp(x); }, DISCONNECT_MS);
      this.emit();
    });
    await this.openMic();
    if (x !== this.up) return;
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (!this.port.sendVox(host, { t: 'vsig', k: 'offer', sdp: pc.localDescription!.sdp })) this.retryUp(x);
    } catch (e) { this.log(`vox offer failed: ${(e as Error).message}`); this.retryUp(x); }
    this.emit();
  }
  private retryUp(x: GuestPc) {
    if (x !== this.up) return;
    const n = x.tries + 1;
    this.stopUp(false);
    this.log(`vox link lost — retrying in ${backoff(n) / 1000} s`);
    setTimeout(() => { if (!this.up && this.guestState === 'on') void this.startUp(n); }, backoff(n));
    this.emit();
  }
  private stopUp(bye: boolean) {
    const x = this.up;
    if (!x) return;
    this.up = null;
    if (bye) for (const h of this.port.voxPeers()) this.port.sendVox(h, { t: 'vsig', k: 'bye' });
    try { x.pc.close(); } catch { /* */ }
    this.mic?.getTracks().forEach((t) => t.stop()); this.mic = null;
    void this.meter?.ctx.close().catch(() => {}); this.meter = null;
    this.hostStream = null; this.play();
  }
  private play() {
    const s = this.hostStream;
    if (!s) { if (this.player) { this.player.pause(); this.player.srcObject = null; this.player = null; } return; }
    const a = this.player ?? (this.player = new Audio());
    a.autoplay = true; a.volume = this.outVol;
    if (a.srcObject !== s) a.srcObject = s;
    this.sinkTo(a);
    // autoplay blocked (no click since the studio loaded): start on the next click / key instead of staying silent
    void a.play().catch(() => { const retry = () => { if (this.player === a && a.paused) void a.play().catch(() => {}); }; document.addEventListener('pointerdown', retry, { once: true }); document.addEventListener('keydown', retry, { once: true }); });
  }
  private sinkTo(a: HTMLAudioElement) {
    if (!SINK_OK) return;
    void (a as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.sink).then(() => { if (this.sinkError) { this.sinkError = ''; this.emit(); } },
      (e: Error) => { this.sinkError = `Output device: ${e.message}`; this.emit(); });
  }
  /** guest → host: my mode / mute / mic (throttled: push-to-talk taps send ≤ ~3 a second, the last one always). */
  private sendState(now = false) {
    if (this.port.role !== 'guest') return;
    const host = this.port.voxPeers()[0];
    if (!host) return;
    clearTimeout(this.stateT);
    const go = () => {
      this.stateAt = performance.now();
      this.port.sendVox(host, { t: 'vsig', k: 'state', mode: this.observer ? 'off' : this.mode, muted: this.muted, mic: !!this.mic?.getAudioTracks()[0] });
      // (the green room's MUTED tag too — same throttle, so push-to-talk taps can't flood the host)
      if (this.muted !== this.muteSent) { this.muteSent = this.muted; this.port.muteChanged?.(this.muted); }
    };
    const wait = this.stateAt + 300 - performance.now();
    if (now || wait <= 0) go(); else this.stateT = window.setTimeout(go, wait);
  }
  private async guestSig(m: VoxSig) {
    const x = this.up;
    if (m.k === 'bye') { if (x) this.retryUp(x); return; }
    if (!x) return;
    if (m.k === 'answer') {
      await x.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }).catch((e) => this.log(`vox answer: ${(e as Error).message}`));
      x.remote = true; for (const c of x.iceQ.splice(0)) await x.pc.addIceCandidate(c).catch(() => {});
    } else if (m.k === 'ice') await this.addIce(x, m.cand);
  }

  // ================================================================ host
  private async hostSig(g: string, m: VoxSig) {
    if (m.k === 'state') {
      const was = JSON.stringify(this.peers.get(g) ?? null);
      this.peers.set(g, { mode: m.mode, muted: m.muted, mic: m.mic });
      if (JSON.stringify(this.peers.get(g)) !== was) { this.replan(); this.emit(); }
      return;
    }
    if (m.k === 'offer') {
      this.closeHost(g, false);
      const pc = new RTCPeerConnection(this.port.rtcConfig());
      const x: HostPc = { pc, iceQ: [], remote: false, tr: null };
      this.pcs.set(g, x);
      pc.onicecandidate = (e) => this.port.sendVox(g, { t: 'vsig', k: 'ice', cand: e.candidate ? e.candidate.toJSON() : null });
      pc.ontrack = (e) => {
        if (this.pcs.get(g) !== x || e.track.kind !== 'audio') return;
        try { (e.receiver as RTCRtpReceiver & { jitterBufferTarget?: number }).jitterBufferTarget = 40; } catch { /* */ }
        this.voices.set(g, { stream: new MediaStream([e.track]), track: e.track });
        e.track.addEventListener('ended', () => { if (this.voices.get(g)?.track === e.track) { this.voices.delete(g); this.replan(); this.emit(); } });
        this.log(`vox: voice from ${g}`);
        this.replan(); this.emit();
      };
      let discT = 0;
      const fail = () => {
        if (this.pcs.get(g) !== x) return;
        this.closeHost(g, true);               // → the guest re-offers
        this.replan(); this.emit();
      };
      pc.addEventListener('connectionstatechange', () => {
        clearTimeout(discT);
        const s = pc.connectionState;
        if (s === 'failed' || s === 'closed') fail();
        if (s === 'disconnected') discT = window.setTimeout(() => { if (pc.connectionState === 'disconnected') fail(); }, DISCONNECT_MS);
        this.emit();
      });
      try {
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        x.remote = true; for (const c of x.iceQ.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        x.tr = pc.getTransceivers().find((t) => t.receiver.track?.kind === 'audio') ?? null;
        if (x.tr) x.tr.direction = 'sendrecv';
        await pc.setLocalDescription(await pc.createAnswer());
        this.port.sendVox(g, { t: 'vsig', k: 'answer', sdp: pc.localDescription!.sdp });
      } catch (e) { this.log(`vox answer for ${g}: ${(e as Error).message}`); fail(); return; }
      this.replan(); this.emit();
    } else if (m.k === 'ice') { const x = this.pcs.get(g); if (x) await this.addIce(x, m.cand); }
    else if (m.k === 'bye') { this.closeHost(g, false); this.replan(); this.emit(); }
  }
  private closeHost(g: string, bye: boolean) {
    const x = this.pcs.get(g);
    if (!x) return;
    this.pcs.delete(g);
    if (bye) this.port.sendVox(g, { t: 'vsig', k: 'bye' });
    try { x.pc.close(); } catch { /* */ }
    this.voices.delete(g);
  }
  /** App guests with an open voice link (host). */
  linked(): string[] { return [...this.pcs.keys()]; }
  /** A guest's voice level as it arrives (host: the People tile's "talking"). */
  level(id: string): number { return audioLevel(this.pcs.get(id)?.tr?.receiver); }
  talking(id: string): boolean { return this.level(id) > 0.02 && !this.peers.get(id)?.muted; }

  /** Re-plan every return mix (voices came / went, green room, talk-back, mutes). Coalesced to one run per task. */
  replan() {
    if (this.port.role !== 'host') { if (this.pcs.size || Object.keys(this.plan).length) { this.plan = {}; this.mixer.keep(new Set()); this.port.setLinkReturns(new Map()); } return; }
    if (this.replanQ) return;
    this.replanQ = true;
    queueMicrotask(() => { this.replanQ = false; this.applyPlan(); });
  }
  private applyPlan() {
    const P = this.port;
    const { main, back } = P.hostTracks();
    const people: MixPerson[] = [];
    for (const [g, x] of this.pcs) {
      const v = this.voices.get(g), st = this.peers.get(g);
      people.push({ id: g, kind: 'app', gate: P.gate(g), sends: !!v && v.track.readyState === 'live', listens: !!x.tr, muted: P.volume(g) <= 0 || !!st?.muted });
    }
    const lv = P.linkVoices(), ll = new Set(P.linkListeners());
    for (const g of new Set([...lv.keys(), ...ll])) {
      if (this.pcs.has(g)) continue;
      people.push({ id: g, kind: 'link', gate: P.gate(g), sends: lv.get(g)?.readyState === 'live', listens: ll.has(g), muted: P.volume(g) <= 0 });
    }
    const inp: MixInput = { talkback: !!main, back: !!(back ?? main), people };
    const plan = mixPlan(inp);
    const bad = planProblems(inp, plan);
    if (bad.length) { this.log(`vox plan refused: ${bad.join('; ')}`); return; }   // (can't happen: a safety net, never feed back)
    this.plan = plan; this.planInput = inp;
    // mixer inputs: only what some mix needs
    const need = new Set<string>();
    for (const srcs of Object.values(plan)) { const d = deliveryOf(srcs); if (d.k === 'mix') d.srcs.forEach((s) => need.add(s)); }
    const inputs = new Map<string, { track: MediaStreamTrack; remote: boolean }>();
    for (const s of need) {
      const t = s === HOST_MAIN ? main : s === HOST_BACK ? back ?? main : this.voices.get(s)?.track ?? lv.get(s) ?? null;
      if (t) inputs.set(s, { track: t, remote: s !== HOST_MAIN && s !== HOST_BACK });
    }
    const mixed = new Set<string>();
    if (need.size) this.mixer.setInputs(inputs);
    const linkRet = new Map<string, MediaStreamTrack | null>();
    for (const p of people) {
      if (!(p.id in plan)) continue;
      const d = deliveryOf(plan[p.id]);
      let track: MediaStreamTrack | null = null;
      if (d.k === 'direct') track = d.src === HOST_MAIN ? main : back ?? main;
      else if (d.k === 'mix') { track = this.mixer.output(p.id, d.srcs); mixed.add(p.id); }
      if (p.kind === 'app') {
        const s = this.pcs.get(p.id)?.tr?.sender;
        if (s && s.track !== track) void s.replaceTrack(track).catch(() => {});
      } else if (d.k === 'mix') linkRet.set(p.id, track);   // (direct / none: the TV link's own return = the same thing)
    }
    P.setLinkReturns(linkRet);
    this.mixer.keep(mixed);
  }
  /** The mixer's actual wiring (tests: proves nobody's mix contains their own voice). */
  routes(): Record<string, string[]> { return this.mixer.routes(); }
  get mixState(): string { return this.mixer.state; }
  /** Live panel diagnostics: the mixer (running / suspended / none), who hears whom, each outgoing mix's level. */
  mixInfo(): { state: string; routes: Record<string, string[]>; levels: Record<string, number> } { return { state: this.mixer.state, routes: this.routes(), levels: this.mixer.levels() }; }
  resumeMix() { this.mixer.resume(); }

  // ================================================================ party events (src/party.ts calls these)
  /** A {t:'vsig'} ctl message (already checked: the link speaks VOX_CAP; from a guest only about itself). */
  onSig(from: string, raw: unknown) {
    const m = sanitizeVoxSig(raw);
    if (!m) return;
    if (this.port.role === 'host') void this.hostSig(from, m);
    else if (this.port.role === 'guest') void this.guestSig(m);
  }
  /** Host: a guest's hello was processed; guest: the host's welcome arrived (its caps are known now). */
  peerUp(id: string) {
    if (this.port.role === 'guest') { this.stopUp(false); this.guestSync(); }
    else if (this.port.role === 'host') this.replan();
    void id;
    this.emit();
  }
  /** A party link / member is gone. */
  peerDown(id: string) {
    if (this.port.role === 'host' || this.port.role === 'none') { this.closeHost(id, false); this.peers.delete(id); this.replan(); }
    if (this.port.role === 'guest' || this.port.role === 'none') this.stopUp(false);
    this.emit();
  }
  /** Left the party: close everything. */
  reset() {
    this.stopUp(false);
    for (const g of [...this.pcs.keys()]) this.closeHost(g, false);
    this.peers.clear(); this.plan = {}; this.planInput = null;
    this.mixer.close();
    this.setMuted(false);
    this.emit();
  }
  private async addIce(x: HostPc, cand: unknown) {
    const c = (cand ?? undefined) as RTCIceCandidateInit | undefined;
    if (!x.remote) { if (c) x.iceQ.push(c); return; }
    await x.pc.addIceCandidate(c).catch(() => {});
  }
  /** For the diagnostics dump (no SDP, no addresses). */
  debug() {
    return {
      cap: VOX_CAP, role: this.port.role, mode: this.mode, state: this.guestState, muted: this.muted, micError: this.micError,
      up: this.up ? this.up.pc.connectionState : '—',
      host: Object.fromEntries([...this.pcs].map(([g, x]) => [g, `${x.pc.connectionState}${this.voices.has(g) ? ' · voice' : ''}`])),
      peers: Object.fromEntries(this.peers), plan: this.plan, mix: this.mixer.state, routes: this.routes(),
    };
  }
  private emit() { for (const l of this.listeners) try { l(); } catch (e) { console.warn('vox listener', e); } }
}
