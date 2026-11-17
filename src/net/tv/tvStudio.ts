// Studio side of TV performers: "how do I appear" (my VTube Pro avatar, or a webcam / VTube Studio picture on a
// walking TV), my picture source (src/net/tv/tvSource.ts), the party media links (tvLink.ts) and the loopback to this
// PC's OBS pages (tvLocal.ts). Created by the Party (src/party.ts `party.tv`); the Multiplayer panel drives it
// (src/ui/tvSetup.ts). Design + honest limits: docs/MULTIPLAYER_DISCORD.md → "TV guests".
import type { Bus } from '../../bus.ts';
import type { TvInfo } from '../../../shared/tv.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import { TvSource } from './tvSource.ts';
import { TvLocalSender, type LocalFeed } from './tvLocal.ts';
import { DiscordCams } from './tvDiscordCam.ts';
import type { TvLinks } from './tvLink.ts';

/** What TvStudio needs from the party (src/party.ts). */
export interface TvHost {
  readonly role: 'none' | 'host' | 'guest';
  readonly myId: string;
  readonly tvLinks: TvLinks;
  /** Announce (or stop announcing) me as a TV performer. */
  setTv(info: TvInfo | null): void;
  tvOf(id: string): TvInfo | null;
  readonly myTv: TvInfo | null;
  readonly members: { id: string }[];
  /** Spout2: can the side my picture goes to unpack alpha (host: always — my own pages; guest: the host speaks
   *  TV_ALPHA_CAP)? Optional: older parties / tests. */
  alphaOk?(): boolean;
  /** My solo Spout2 performer started / stopped (republish to this PC's OBS pages). */
  tvSoloChanged?(): void;
  /** greenroom: a link guest's voice — 'air' (as usual), 'back' (backstage talk: only me, on the backstage output),
   *  'off' (waiting: nobody). Optional: older parties / tests = always 'air'. */
  voiceGate?(id: string): 'air' | 'back' | 'off';
  /** greenroom: a waiting member — their picture never goes to this PC's OBS pages. */
  readonly green?: { hidden(id: string): boolean };
  /** partyvoice: app guests' voices (src/net/voice/partyVoice.ts) — heard, muted and put on OBS exactly like link
   *  guests'. Optional: older parties / tests. (Created after this studio: read lazily.) */
  readonly voice?: { voices: Map<string, { stream: MediaStream; track: MediaStreamTrack }>; linked(): string[]; replan(): void };
  /** moderation (shared/moderation.ts, src/net/moderation.ts): the host hid a guest's camera (their "Camera off" card goes
   *  out instead) / muted them (no voice anywhere) / set their volume. Optional: older parties / tests. */
  readonly mod?: { cover(id: string): { stream: MediaStream; track: MediaStreamTrack } | null; micOff(id: string): boolean; vol(id: string): number | undefined; setVol(id: string, v: number): unknown };
}

const APPEAR_KEY = 'vtp.tv.appear';
const HEAR_KEY = 'vtp.tv.hearGuests';
const TALKBACK_KEY = 'vtp.tv.talkback';
const TALKMIC_KEY = 'vtp.tv.talkbackMic';
const SINK_KEY = 'vtp.gr.sink';
/** Can this browser send an <audio> to a chosen output device (Chromium: yes; Firefox: behind a flag; Safari: no)? */
const SINK_OK = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
export type Appear = 'avatar' | 'tv';

export class TvStudio {
  /** How I appear in parties. 'tv' needs a running source. */
  appear: Appear = localStorage.getItem(APPEAR_KEY) === 'tv' ? 'tv' : 'avatar';
  private src: TvSource | null = null;
  private local: TvLocalSender | null = null;
  readonly listeners = new Set<() => void>();
  private announced = '';
  private soloWas = false;
  /** guestlink: guests cropped from the Discord call window ("Use their Discord camera instead"). */
  readonly cams = new DiscordCams();
  /** Set by the party: re-announce members after the Discord-camera guests changed. */
  onCams: () => void = () => {};
  /** Audio mixer (src/audio/mixer/audioMixer.ts; optional): it plays guests itself (skipPlayer: then no <audio> here)
   *  and "Mute for me" silences a guest here, backstage included. Guest voices never go to the OBS page (owner rule). */
  mix: { skipPlayer(id: string): boolean; mutedForMe(id: string): boolean } | null = null;

  constructor(private party: TvHost, bus: Bus, observer: boolean) {
    // observer tabs never publish to OBS pages (the real studio does)
    if (!observer) this.local = new TvLocalSender((m) => bus.send(m), (h) => bus.on(h), () => this.localFeeds());
    party.tvLinks.onChange = () => { this.syncAlpha(); this.local?.sync(); this.voicesChanged(); this.emit(); };
    if (!observer) { void this.refreshMics(); try { navigator.mediaDevices.addEventListener('devicechange', () => void this.refreshMics()); } catch { /* old browser */ } }
    this.observer = observer;
    this.extraFeeds = () => this.cams.feeds();
    this.cams.onChange = () => { this.local?.sync(); this.onCams(); this.emit(); };
  }

  get source(): TvSource {
    if (!this.src) {
      this.src = new TvSource();
      this.src.onChange = () => { this.refresh(); this.emit(); };
    }
    return this.src;
  }
  get hasSource(): boolean { return !!this.src?.live; }

  setAppear(a: Appear) {
    this.appear = a;
    try { localStorage.setItem(APPEAR_KEY, a); } catch { /* storage off */ }
    if (a === 'avatar') { this.src?.stop(); }
    this.refresh();
    this.emit();
  }

  /** Join flow: appear as a TV — open the picture now if it isn't running (a click: window sharing may ask). */
  async ensureStarted() {
    this.appear = 'tv';
    try { localStorage.setItem(APPEAR_KEY, 'tv'); } catch { /* storage off */ }
    if (!this.source.live) await this.source.start();
    this.refresh();
    this.emit();
  }

  /** Spout2: pack the alpha only when the receiving side can unpack it (else the model is keyed over green). */
  private syncAlpha() { if (this.src) this.src.setAlphaOk(this.party.alphaOk?.() ?? true); }

  /** Spout2 performer shown in my own OBS rooms with no party (the host's own model from VSeeFace / Warudo …). */
  get soloShow(): boolean {
    const s = this.src;
    return this.party.role === 'none' && this.appear === 'tv' && !!s?.live && s.settings.via === 'spout' && s.settings.solo !== false;
  }

  /** Re-announce + re-publish after any change of mode / source / settings. */
  refresh() {
    this.syncAlpha();
    const on = this.appear === 'tv' && !!this.src?.live;
    const info = on ? this.src!.info() : null;
    const sig = info ? JSON.stringify(info) : '';
    const stream = on ? this.src!.out : null;
    if (sig !== this.announced) { this.announced = sig; this.party.setTv(info); }
    const src = this.src;
    this.party.tvLinks.setOwn(on && stream && src ? { stream, preset: src.settings.preset, level: () => src.level, vts: src.settings.kind === 'vts' } : null);
    this.local?.sync();
    const solo = this.soloShow;
    if (solo !== this.soloWas) { this.soloWas = solo; this.party.tvSoloChanged?.(); }
  }

  private localFeeds(): LocalFeed[] {
    if (this.party.role === 'none') {
      const own = this.soloShow ? this.party.tvLinks.feeds.get(this.party.myId) : null;
      return own && own.track.readyState === 'live' ? [{ id: own.owner, stream: own.stream, track: own.track, level: this.src?.level ?? 0 }, ...this.extraFeeds()] : this.extraFeeds();
    }
    // guest VOICES never go to the OBS pages (owner: "only through the studio, never straight to OBS"): pictures + levels only
    const out: LocalFeed[] = [];
    for (const f of this.party.tvLinks.feeds.values()) {
      if (f.track.readyState !== 'live' || this.party.green?.hidden(f.owner)) continue;   // greenroom: waiting = not on the OBS pages
      // moderation: hidden = their "Camera off" card instead of the picture; muted = no voice, level 0
      const cover = this.party.mod?.cover(f.owner) ?? null, muted = !!this.party.mod?.micOff(f.owner);
      const air = this.gate(f.owner) === 'air', speak = air && !muted;
      out.push({ id: f.owner, stream: cover?.stream ?? f.stream, track: cover?.track ?? f.track, level: speak ? f.level : 0 });
    }
    for (const f of this.extraFeeds()) out.push(f);
    return out;
  }
  /** Every guest voice that arrives here: browser link guests (TV links) + VTube Pro app guests (party voice). */
  allVoices(): Map<string, { stream: MediaStream; track: MediaStreamTrack }> {
    const m = new Map(this.party.tvLinks.voices);
    for (const [id, v] of this.party.voice?.voices ?? []) if (!m.has(id)) m.set(id, v);
    return m;
  }
  /** Guests who can hear me: link guests' return paths + app guests with a voice link. */
  private earIds(): string[] { return [...this.allVoices().keys(), ...this.party.tvLinks.listeners, ...(this.party.voice?.linked() ?? [])]; }
  /** partyvoice: an app guest's voice link came / went / changed. */
  voiceLinksChanged() { this.voicesChanged(); this.local?.sync(); void this.syncBackMic(); this.emit(); }
  /** guestlink: more feeds for this PC's OBS pages (the host's own "Discord camera" guests, src/net/tv/tvDiscordCam.ts). */
  extraFeeds: () => LocalFeed[] = () => [];

  // ---------------------------------------------------------------- guestlink: browser guests' voices
  private vols = new Map<string, number>();
  /** The host's volume (0..1) for a guest's voice in the studio (0 = muted for everyone). */
  voiceVol(id: string): number {
    const m = this.party.mod;
    if (m) { if (m.micOff(id)) return 0; const v = m.vol(id); if (v !== undefined) return v; }   // moderation: muted = 0, else the host's volume
    return this.vols.get(id) ?? 1;
  }
  setVoiceVol(id: string, v: number) {
    // a host's per-guest volume is a moderation setting (kept by the guest's stable identity, Undo-able)
    if (this.party.mod && this.party.role === 'host') { this.party.mod.setVol(id, Math.min(1, Math.max(0, v))); return; }
    this.vols.set(id, Math.min(1, Math.max(0, v))); this.local?.sync(); this.syncHear(); this.party.voice?.replan(); this.emit();
  }
  /** moderation: a guest was hidden / muted / brought back — re-publish this PC's OBS feeds, re-route the studio speakers. */
  modChanged() { this.local?.sync(); this.syncHear(); this.emit(); }
  /** My voice back to browser guests who aren't in Discord voice (they hear me on their page). */
  returnVoice: { on: boolean; mic: string; error: string; label?: string } = { on: false, mic: localStorage.getItem(TALKMIC_KEY) ?? '', error: '' };
  /** Microphones on this PC (labels need mic permission, which the studio has) — for the talk-back picker. */
  mics: { id: string; label: string }[] = [];
  async refreshMics() {
    try {
      const d = await navigator.mediaDevices.enumerateDevices();
      const list = d.filter((x) => x.kind === 'audioinput' && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x, i) => ({ id: x.deviceId, label: x.label || `Microphone ${i + 1}` }));
      if (JSON.stringify(list) !== JSON.stringify(this.mics)) { this.mics = list; this.emit(); }
      const outs = d.filter((x) => x.kind === 'audiooutput' && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x, i) => ({ id: x.deviceId, label: x.label || `Output ${i + 1}` }));
      if (JSON.stringify(outs) !== JSON.stringify(this.outputs)) { this.outputs = outs; this.emit(); }
    } catch { /* no devices API */ }
  }
  /** Pick the talk-back mic ('' = the same one lip sync uses). Remembered; a running talk-back switches over now. */
  async setTalkbackMic(id: string) {
    try { localStorage.setItem(TALKMIC_KEY, id); } catch { /* storage off */ }
    if (this.returnVoice.on) await this.setReturnVoice(true, id); else { this.returnVoice = { ...this.returnVoice, mic: id }; this.emit(); }
  }
  /** The mic talk-back uses when none was picked: the app sets it to lip sync's mic (the Windows default is often NOT the
   *  performer's mic — an audio interface, a headset — and guests would hear silence or the wrong room). */
  defaultMic: () => string = () => '';
  private meter: { ctx: AudioContext; an: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null = null;
  /** Talk-back level 0..1 right now (Live panel meter: proof the guests get sound, not silence). */
  returnLevel(): number {
    const m = this.meter; if (!m) return 0;
    m.an.getFloatTimeDomainData(m.buf); let pk = 0; for (const x of m.buf) pk = Math.max(pk, Math.abs(x));
    return Math.min(1, pk * 1.4);
  }
  private returnStream: MediaStream | null = null;
  private observer = false;

  // ---- talking over the link without Discord: two-way by default (Live panel → Guests)
  /** Hear guests here, in the studio (the host's headphones). This is the ONLY place guest voices play: never the OBS page. */
  hear = localStorage.getItem(HEAR_KEY) !== '0';
  /** Send my voice back automatically when a link guest with a voice arrives (unless I switched it off). */
  get talkbackPref() { return localStorage.getItem(TALKBACK_KEY) !== '0'; }
  private players = new Map<string, HTMLAudioElement>();
  setHear(on: boolean) { this.hear = on; try { localStorage.setItem(HEAR_KEY, on ? '1' : '0'); } catch { /* storage off */ } this.syncHear(); this.emit(); }
  /** The user's own choice (remembered): talk back to link guests or not. */
  async setTalkback(on: boolean) { this.autoTalk = false; try { localStorage.setItem(TALKBACK_KEY, on ? '1' : '0'); } catch { /* storage off */ } await this.setReturnVoice(on); }
  /** guestlink: talk-back was switched on automatically (not by the user) — released again when the link guests leave. */
  private autoTalk = false;
  /** Called when talk-back switched itself on (a link guest arrived): the studio says so (src/ui/live/liveStudio.ts). */
  onAutoTalk: (() => void) | null = null;
  private voicesChanged() {
    this.syncHear();
    // a link guest is here (talking over the link, or just listening: no / denied mic) and I haven't said no: they
    // should hear me too (no Discord needed)
    // (guests waiting in the green room don't count: they must not hear the show)
    const any = this.earIds().some((id) => this.gate(id) === 'air');
    if (any && !this.observer && this.party.role === 'host' && !this.returnVoice.on && !this.returnVoice.error && this.talkbackPref) { this.autoTalk = true; void this.setReturnVoice(true); this.onAutoTalk?.(); }
    // nobody left to hear me: close the mic I opened by myself (a manual On stays on)
    if (!any && this.autoTalk && this.returnVoice.on) { this.autoTalk = false; void this.setReturnVoice(false); }
  }
  // ---- greenroom: backstage voice (one waiting guest <-> me), never on the OBS page
  /** Speakers / headphones on this PC for backstage voice ('' = the default output). */
  outputs: { id: string; label: string }[] = [];
  backSink = localStorage.getItem(SINK_KEY) ?? '';
  readonly sinkOk = SINK_OK;
  backError = '';
  private backPlayers = new Map<string, HTMLAudioElement>();
  private backStream: MediaStream | null = null;
  private gate(id: string) { return this.party.voiceGate?.(id) ?? 'air'; }
  /** Pick the backstage output (Chromium only). The default output is usually what OBS Desktop Audio captures. */
  setBackSink(id: string) {
    this.backSink = id; try { localStorage.setItem(SINK_KEY, id); } catch { /* storage off */ }
    for (const a of this.backPlayers.values()) this.sinkTo(a);
    this.emit();
  }
  private sinkTo(a: HTMLAudioElement) {
    if (!SINK_OK) return;
    void (a as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(this.backSink).then(() => { if (this.backError.startsWith('Output')) { this.backError = ''; this.emit(); } },
      (e: Error) => { this.backError = `Output device: ${e.message}`; this.emit(); });
  }
  /** The green room changed (someone waits / came on / backstage talk on or off): re-route every voice. */
  gateChanged() {
    this.syncHear(); this.local?.sync(); this.party.tvLinks.refreshReturn();
    void this.syncBackMic();
    this.voicesChanged();
    this.emit();
  }
  /** Backstage talk needs my mic: the talk-back one when it's on, else its own capture (closed when nobody talks). */
  private async syncBackMic() {
    const L = this.party.tvLinks;
    const want = !this.observer && this.earIds().some((id) => this.gate(id) === 'back');
    if (!want || this.returnVoice.on) {
      if (this.backStream) { this.backStream.getTracks().forEach((t) => t.stop()); this.backStream = null; L.setBackAudio(null); }
      return;
    }
    if (this.backStream) return;
    try {
      const dev = this.returnVoice.mic || this.defaultMic();
      const st = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(dev ? { deviceId: { exact: dev } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      // (switched off / talk-back came on while the mic opened)
      if (this.backStream || this.returnVoice.on || !this.earIds().some((id) => this.gate(id) === 'back')) { st.getTracks().forEach((t) => t.stop()); return; }
      this.backStream = st;
      this.backError = '';
      L.setBackAudio(st.getAudioTracks()[0] ?? null);
    } catch (e) { this.backError = `Microphone: ${(e as Error).message}`; }
    this.emit();
  }
  /** One <audio> per link voice while Hear is on (volume = the guest's OBS volume: Mute mutes both). */
  private syncHear() {
    const all = this.observer ? new Map<string, { stream: MediaStream }>() : this.allVoices();
    // greenroom: waiting guests' voices never play with the show; backstage talk plays on its own output
    // (moderation: a muted guest plays nowhere — not on stream, not backstage)
    const muted = (id: string) => !!this.party.mod?.micOff(id);
    const back = new Map([...all].filter(([id]) => this.gate(id) === 'back' && !muted(id) && !this.mix?.mutedForMe(id)));
    for (const [id, a] of this.backPlayers) if (!back.has(id) || a.srcObject !== back.get(id)!.stream) { a.pause(); a.srcObject = null; this.backPlayers.delete(id); }
    for (const [id, v] of back) {
      if (this.backPlayers.has(id)) continue;
      const a = new Audio(); a.autoplay = true; a.srcObject = v.stream; this.sinkTo(a); this.backPlayers.set(id, a);
      void a.play().catch(() => { const retry = () => { if (this.backPlayers.get(id) === a && a.paused) void a.play().catch(() => {}); }; document.addEventListener('pointerdown', retry, { once: true }); });
    }
    const want = this.hear && !this.observer ? new Map([...all].filter(([id]) => this.gate(id) === 'air' && !muted(id) && !this.mix?.skipPlayer(id))) : new Map<string, { stream: MediaStream }>();
    for (const [id, a] of this.players) if (!want.has(id) || a.srcObject !== want.get(id)!.stream) { a.pause(); a.srcObject = null; this.players.delete(id); }
    for (const [id, v] of want) {
      let a = this.players.get(id);
      if (!a) {
        a = new Audio(); a.autoplay = true; a.srcObject = v.stream; this.players.set(id, a);
        // autoplay blocked (no click in the studio since it loaded): start on the next click / key instead of staying silent
        const el = a, retry = () => { if (this.players.get(id) === el && el.paused) void el.play().catch(() => {}); };
        void el.play().catch(() => { document.addEventListener('pointerdown', retry, { once: true }); document.addEventListener('keydown', retry, { once: true }); });
      }
      a.volume = this.voiceVol(id);
    }
  }
  async setReturnVoice(on: boolean, mic = this.returnVoice.mic) {
    this.returnStream?.getTracks().forEach((t) => t.stop());
    this.returnStream = null;
    void this.meter?.ctx.close().catch(() => {}); this.meter = null;
    this.returnVoice = { on, mic, error: '' };
    if (on) {
      // (no mic picked: the one lip sync uses — the performer's real mic — else the Windows default)
      const dev = mic || this.defaultMic();
      const want = (id: string) => navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      try {
        this.returnStream = await want(dev).catch((e) => { if (!dev) throw e; return want(''); });
        const tr = this.returnStream.getAudioTracks()[0];
        this.returnVoice.label = tr?.label ?? '';
        try {
          const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512;
          ctx.createMediaStreamSource(this.returnStream).connect(an);
          this.meter = { ctx, an, buf: new Float32Array(an.fftSize) };
        } catch { /* meter is optional */ }
      } catch (e) { this.returnVoice = { on: false, mic, error: (e as Error).message }; }
    }
    this.party.tvLinks.setReturnAudio(this.returnStream?.getAudioTracks()[0] ?? null);
    void this.syncBackMic();
    this.emit();
  }
  /** Poke the OBS-page link after the extra feeds changed. */
  syncLocal() { this.local?.sync(); }
  /** OBS pages currently receiving the feeds (for the panel). */
  get pages() { return this.local?.pages ?? []; }

  private emit() { for (const l of this.listeners) try { l(); } catch (e) { console.warn('tv listener', e); } }
}

/** TvInfo of a scene member key ('@host' = the host) — for modes / the controller (see S\tv\PERFORMER_API.md). */
export function tvOfKey(party: { role: string; myId: string; myTv: TvInfo | null; tvOf(id: string): TvInfo | null; members: { id: string }[] }, key: string): TvInfo | null {
  if (key === HOST_KEY) {
    if (party.role === 'guest') { const h = party.members[0]?.id; return h ? party.tvOf(h) : null; }
    return party.myTv;
  }
  return key === party.myId ? party.myTv : party.tvOf(key);
}
