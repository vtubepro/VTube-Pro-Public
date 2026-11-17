// A party guest WITHOUT VTube Pro: a plain browser tab (the relay's /tv page, relay/tvguest/) that joins a Discord party
// as a webcam / VTube Studio TV. It speaks just enough of the party protocol (src/party.ts): the relay handshake, the
// host's 'ctl' channel (welcome → hello with `tv` + `lite: true`, ping / pong, kick / bye) and the TV media links
// (tvLink.ts). `lite` tells the host not to send it anyone's avatar or tracking (it can't show them — it has no OBS
// page; it only sends its own picture + voice level). Nothing is stored; closing the tab leaves the party.
import { RelayClient, peekTicket, type SignalData } from '../relayClient.ts';
import { TV_CAP, sanitizeTvInfo, type TvInfo, type TvSig } from '../../../shared/tv.ts';
import { TvLinks } from './tvLink.ts';
import { TvSource } from './tvSource.ts';
import { GR_CAP, GUEST_MSG_MAX, HISTORY, cleanText, guestBuckets, readToGuest } from '../../../shared/greenroom.ts';
import { MOD_CAP, modNotice, readModToGuest } from '../../../shared/moderation.ts';

const rid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
// GR_CAP: I show the host's green room messages and send READY / notes / my mute state (shared/greenroom.ts)
// MOD_CAP: I show the host's moderation (camera off / muted) and lock my own unmute while it lasts (shared/moderation.ts)
const CAPS = ['xf1', TV_CAP, GR_CAP, MOD_CAP];

export class TvLiteGuest {
  readonly myId = rid();
  role: 'none' | 'guest' = 'none';
  status = '';
  hostName = '';
  you = '';
  members: { id: string; name: string; tv: boolean }[] = [];
  readonly source = new TvSource();
  readonly links: TvLinks;
  onChange: () => void = () => {};
  /** guestlink: the link dropped (not the host's / my doing) — the page may rejoin (no-sign-in links can). */
  onLost: ((why: string) => void) | null = null;
  /** guestlink: I'm not in Discord voice — my voice goes to the host over this link, and the host's comes back. */
  voice = false;
  voiceError = '';
  /** guestlink: I want to hear the host here (the voice box is ticked) — stays on when my mic fails, so a guest with a
   *  denied / missing mic still hears the host (a receive-only voice line). */
  hearHost = false;
  /** guestlink: the browser refused to play the host's voice (autoplay) — the page shows a "tap to hear" button. */
  earBlocked = false;
  /** guestlink: the relay handed out a TURN server (null = not known yet). Without one, strict NATs / mobile data fail. */
  turn: boolean | null = null;
  /** guestlink: 'ice' = the last attempt never connected (the networks can't reach each other: TURN / another network);
   *  'drop' = it was connected and dropped. The page stops auto-retrying after repeated 'ice' failures. */
  lastFail: '' | 'ice' | 'drop' = '';
  private everConnected = false;
  // ---- greenroom (shared/greenroom.ts): the host's waiting room + messages, my READY / notes, my mic mute
  /** known = the host's VTube Pro speaks it; wait = I'm in the green room (not on the show); talk = backstage voice. */
  green = { known: false, wait: false, talk: false, msgs: [] as { text: string; at: number }[], unread: 0 };
  ready = false;
  readyText = '';
  /** My mic is muted (the voice track sends silence; my level reads 0). */
  muted = false;
  /** A host message arrived (the page shows a banner). */
  onMessage: ((text: string) => void) | null = null;
  /** moderation: what the host decided about me (camera hidden from the show / muted). The host enforces it; this page
   *  shows it and keeps my mic muted until the host lifts it. */
  hostMod = { cam: false, mic: false, at: 0 };
  /** moderation: the host's decision changed (the page shows a banner with these words). */
  onMod: ((text: string) => void) | null = null;
  private buckets = guestBuckets();
  private muteAt = 0; private muteT = 0;
  private vmic: { stream: MediaStream; ctx: AudioContext; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; lv: number; t: number } | null = null;
  private hostEar: HTMLAudioElement | null = null;
  private relay: RelayClient | null = null;
  private pc: RTCPeerConnection | null = null;
  private ctl: RTCDataChannel | null = null;
  private ice: RTCIceServer[] = [];
  private hostId = '';
  private hostCaps = new Set<string>();
  private iceQ: RTCIceCandidateInit[] = [];
  private remoteSet = false;

  constructor() {
    const self = this;
    this.links = new TvLinks({
      get role() { return self.role; }, get myId() { return self.myId; },
      sendTv: (_to, m) => this.send(m),
      rtcConfig: () => ({ iceServers: this.ice.length ? this.ice : [{ urls: 'stun:stun.l.google.com:19302' }] }),
      mayForward: () => false,
      tvPeers: () => (this.hostId && this.hostCaps.has(TV_CAP) && this.ctl?.readyState === 'open' ? [this.hostId] : []),
    });
    this.links.onChange = () => { this.playHost(); this.onChange(); };
    this.source.onChange = () => { this.announce(); this.onChange(); };
    this.source.cardLevel = () => this.micLevel();
    window.addEventListener('pagehide', () => this.leave());
    // audio contexts made before any click start suspended (meter reads 0): resume them on the first gesture
    const wake = () => { void this.vmic?.ctx.resume().catch(() => {}); this.source.resumeAudio(); if (this.earBlocked) this.unlockAudio(); };
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, wake, { capture: true, passive: true });
  }

  /** Voice over the link on / off (opens the mic with echo cancellation: the host's voice plays in this tab). */
  async setVoice(on: boolean) {
    this.voice = on; this.voiceError = ''; this.hearHost = on;
    if (this.vmic) { this.vmic.stream.getTracks().forEach((t) => t.stop()); void this.vmic.ctx.close().catch(() => {}); this.vmic = null; }
    // one mic capture per page: while my voice goes over the link, its track also feeds the meter / TV level
    // (iOS mutes the older capture when a page opens the mic twice — the host would hear silence)
    this.source.holdMic(on);
    if (on) {
      const mic = this.source.settings.mic;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...(mic && mic !== 'none' ? { deviceId: { exact: mic } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!this.voice) { stream.getTracks().forEach((t) => t.stop()); return; }   // switched off meanwhile
        const ctx = new AudioContext();
        void ctx.resume().catch(() => {});
        const an = ctx.createAnalyser(); an.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(an);
        this.vmic = { stream, ctx, an, buf: new Float32Array(an.fftSize), lv: 0, t: 0 };
        this.applyMute();
      } catch (e) {
        this.voice = false; this.source.holdMic(false);
        const n = (e as Error).name;
        this.voiceError = n === 'NotAllowedError' ? 'Microphone permission was denied — allow it in the address bar so the host can hear you'
          : n === 'NotReadableError' ? 'Your microphone is busy in another app — close it there, then tick voice again'
          : n === 'NotFoundError' ? 'No microphone found' : `Couldn’t open the microphone: ${(e as Error).message}`;
      }
    }
    this.announce(); this.onChange();
  }
  // ---------------------------------------------------------------- greenroom
  /** Mute / unmute my voice over the link (the host sees a muted-mic icon). */
  setMuted(on: boolean) {
    if (!on && this.hostMod.mic) { this.onChange(); return; }       // moderation: only the host can unmute me
    if (this.muted === on) return;
    this.muted = on;
    this.applyMute();
    this.sendMute();
    this.onChange();
  }
  private applyMute() { for (const t of this.vmic?.stream.getAudioTracks() ?? []) t.enabled = !this.muted; }
  /** At most ~3 mute updates a second (push-to-talk taps), the last state always gets through. */
  private sendMute() {
    clearTimeout(this.muteT);
    const wait = this.muteAt + 300 - performance.now();
    const go = () => { this.muteAt = performance.now(); if (this.green.known && this.voice) this.send({ t: 'gr', k: 'mute', on: this.muted }); };
    if (wait <= 0) go(); else this.muteT = window.setTimeout(go, wait);
  }
  /** "I'm ready" on / off, with an optional short message. '' = sent, else why not. */
  setReady(on: boolean, text = ''): string {
    if (!this.green.known) return 'The host’s VTube Pro doesn’t support this yet';
    if (!this.buckets.say.take()) return 'Slow down a moment';
    this.ready = on; this.readyText = on ? cleanText(text, GUEST_MSG_MAX) : '';
    this.send({ t: 'gr', k: 'ready', on, text: this.readyText });
    this.onChange();
    return '';
  }
  /** A short message to the host. */
  note(text: string): string {
    const t = cleanText(text, GUEST_MSG_MAX);
    if (!t) return 'Type a message first';
    if (!this.green.known) return 'The host’s VTube Pro doesn’t support messages yet';
    if (!this.buckets.say.take()) return 'Slow down a moment';
    this.send({ t: 'gr', k: 'note', text: t });
    return '';
  }
  markRead() { if (this.green.unread) { this.green.unread = 0; this.onChange(); } }

  /** Mic loudness 0..1 (the meter; the TV's talk gestures). Muted = 0. */
  micLevel(): number {
    const m = this.vmic;
    if (!m) return this.source.level;
    if (this.muted) return 0;
    const now = performance.now();
    if (now - m.t > 40) {
      m.t = now;
      m.an.getFloatTimeDomainData(m.buf);
      let s = 0; for (const v of m.buf) s += v * v;
      const lv = Math.min(1, Math.sqrt(s / m.buf.length) * 6);
      m.lv += (lv - m.lv) * (lv > m.lv ? 0.6 : 0.15);
    }
    return m.lv;
  }
  /** Unlock audio playback from a click (phones only allow it after a gesture). */
  unlockAudio() {
    if (!this.hostEar) { this.hostEar = Object.assign(document.createElement('audio'), { autoplay: true }); (this.hostEar as HTMLAudioElement & { playsInline?: boolean }).playsInline = true; }
    void this.vmic?.ctx.resume().catch(() => {}); this.source.resumeAudio();
    if (this.earBlocked && this.hostEar.srcObject) void this.hostEar.play().then(() => { this.earBlocked = false; this.onChange(); }, () => {});
    else void this.hostEar.play().catch(() => {});
  }
  get hearingHost(): boolean { return !!this.links.hostAudio; }
  private playHost() {
    const s = this.links.hostAudio;
    if (!this.hostEar) { if (!s) return; this.unlockAudio(); }
    if (this.hostEar!.srcObject !== s) {
      this.hostEar!.srcObject = s;
      // phones / strict autoplay: a refused play() gets a "tap to hear" button (any tap then retries)
      if (s) void this.hostEar!.play().then(() => { if (this.earBlocked) { this.earBlocked = false; this.onChange(); } }, (e: Error) => { if (e?.name === 'NotAllowedError') { this.earBlocked = true; this.onChange(); } });
      else this.earBlocked = false;
    }
  }

  info(): TvInfo | null { return this.source.live ? sanitizeTvInfo(this.source.info()) : null; }

  /** Join with the relay ticket from the Discord sign-in (single use, ≤ 10 min). */
  async join(relayOrigin: string, ticket: string) {
    const t = peekTicket(ticket);
    if (!t.r) throw new Error('This join link is not valid — click Join in Discord again');
    this.hostName = String(t.hn ?? 'the host').slice(0, 40); this.you = String(t.n ?? '').slice(0, 40);
    this.role = 'guest';
    this.everConnected = false;
    this.say('Connecting to the show…');
    const inside = () => this.pc?.connectionState === 'connected';
    const rc = new RelayClient(relayOrigin, t.r, {
      welcome: (w) => {
        this.ice = Array.isArray(w.ice) ? w.ice.slice(0, 6) : [];
        this.turn = this.ice.some((x) => [x.urls].flat().some((u) => /^turns?:/.test(String(u))));
        if (w.host?.name) this.hostName = w.host.name;
        this.say(w.hostHere === false ? `Waiting for ${this.hostName} — their VTube Pro isn’t connected right now. You’ll be let in when they’re back.` : `Waiting for ${this.hostName} to let you in…`);
      },
      approved: () => this.say(`${this.hostName} let you in — connecting…`),
      denied: () => this.leave(`${this.hostName} declined`),
      kicked: () => this.leave('The host removed you from the party'),
      mod: (m) => this.applyMod(m),
      ended: () => this.leave('The party has ended'),
      hostAway: (away) => this.say(inside() ? (away ? 'The host lost the relay (you stay connected)' : `In ${this.hostName}’s party ✔`)
        : away ? `${this.hostName}’s VTube Pro dropped off — waiting for them to come back…` : `Waiting for ${this.hostName} to let you in…`),
      signal: (_from, d) => void this.onSignal(d),
      error: (m) => this.say(`Relay: ${m}`),
      // the handshake socket dropped before the video link came up: nothing will ever arrive — start over
      closed: () => { this.relay = null; if (this.role === 'guest' && !this.everConnected) { this.lastFail = 'drop'; this.leave('Lost the connection to the show’s relay', true); } },
    });
    this.relay = rc;
    try { await rc.connect(ticket); } catch (e) { if (this.relay === rc) this.relay = null; this.role = 'none'; this.onChange(); throw e; }
  }

  private async onSignal(d: SignalData) {
    try {
      if (d.sdp?.type === 'offer' && !this.pc) {
        const pc = new RTCPeerConnection({ iceServers: this.ice });
        this.pc = pc;
        pc.onicecandidate = (e) => this.relay?.signal('host', { candidate: e.candidate ? e.candidate.toJSON() : null });
        pc.ondatachannel = (e) => {
          // 'bin' (avatars) and 'rt' (tracking) are never used by a lite guest: the host is told not to send them
          if (e.channel.label !== 'ctl') { e.channel.onmessage = null; return; }
          this.ctl = e.channel;
          e.channel.onmessage = (ev) => this.onCtl(ev.data);
          e.channel.onclose = () => this.leave('Disconnected from the host', true);
        };
        pc.addEventListener('connectionstatechange', () => {
          if (pc !== this.pc) return;
          if (pc.connectionState === 'connected') { this.everConnected = true; this.lastFail = ''; this.say(`In ${this.hostName}’s party ✔`); }
          if (pc.connectionState === 'failed') {
            this.lastFail = this.everConnected ? 'drop' : 'ice';
            this.leave(this.everConnected ? 'The connection dropped' : failText(this.hostName, this.turn), true);
          }
        });
        await pc.setRemoteDescription(d.sdp);
        this.remoteSet = true;
        await pc.setLocalDescription(await pc.createAnswer());
        this.relay?.signal('host', { sdp: { type: 'answer', sdp: pc.localDescription!.sdp } });
        for (const c of this.iceQ.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if ('candidate' in d) {
        const c = d.candidate ?? undefined;
        if (!this.remoteSet) { if (c) this.iceQ.push(c); } else await this.pc?.addIceCandidate(c).catch(() => {});
      }
    } catch (e) { this.say(`Connection setup failed: ${(e as Error).message}`); }
  }

  private onCtl(data: unknown) {
    if (typeof data !== 'string' || data.length > 64 * 1024) return;
    let m: Record<string, unknown>;
    try { m = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    switch (m.t) {
      case 'welcome':
        if (typeof m.id !== 'string') return;
        this.hostId = m.id;
        this.hostCaps = new Set((Array.isArray(m.caps) ? m.caps : []).map(String));
        if (!this.hostCaps.has(TV_CAP)) this.say(`${this.hostName}’s VTube Pro is too old to show TV guests — ask them to update`);
        this.green.known = this.hostCaps.has(GR_CAP);
        this.hello();
        this.links.peerUp(this.hostId);
        this.announce();
        // (a reconnect: the host forgot my READY / mute — tell it again)
        if (this.green.known) { if (this.voice) this.send({ t: 'gr', k: 'mute', on: this.muted }); if (this.ready) this.send({ t: 'gr', k: 'ready', on: true, text: this.readyText }); }
        this.onChange();
        return;
      case 'ping': this.send({ t: 'pong', n: Number(m.n) || 0 }); return;
      case 'kick': this.leave('The host removed you from the party'); return;
      case 'bye': if (m.owner === this.hostId) this.leave('The host ended the party'); return;
      case 'roster':
        if (Array.isArray(m.members)) this.members = (m.members as Record<string, unknown>[]).slice(0, 8).map((x) => ({ id: String(x.id), name: String(x.name ?? '').slice(0, 40), tv: !!x.tv }));
        this.onChange();
        return;
      case 'tvsig': this.links.onSig(this.hostId, m); return;
      case 'mod': { const x = readModToGuest(m); if (x) this.applyMod(x); return; }
      case 'gr': {
        if (!this.green.known) return;
        const g = readToGuest(m);
        if (!g) return;
        if (g.k === 'state') { const was = this.green.wait; this.green.wait = g.wait; this.green.talk = g.talk; if (was && !g.wait) this.ready = false; this.onChange(); return; }
        this.green.msgs.push({ text: g.text, at: Date.now() });
        if (this.green.msgs.length > HISTORY) this.green.msgs.splice(0, this.green.msgs.length - HISTORY);
        this.green.unread++;
        this.onMessage?.(g.text);
        this.onChange();
        return;
      }
    }
  }

  /** moderation: the host's decision about me (from the 'ctl' channel or the relay; both may arrive: same state = no-op). */
  applyMod(m: { cam: boolean; mic: boolean }) {
    const was = this.hostMod;
    if (was.cam === m.cam && was.mic === m.mic) return;
    const text = modNotice(was, m, this.hostName || 'The host');
    this.hostMod = { cam: m.cam, mic: m.mic, at: Date.now() };
    // muted by the host: my mic goes quiet here too (it is already silent for everyone on the host's side)
    if (m.mic && !this.muted) { this.muted = true; this.applyMute(); this.sendMute(); }
    if (text) this.onMod?.(text);
    this.onChange();
  }

  private hello() {
    this.send({ t: 'hello', id: this.myId, name: (this.you || 'Guest').slice(0, 40), secret: '', profile: null, bytes: 0, caps: CAPS, share: 'party', avatar: false, why: 'tv', tv: this.info(), lite: true });
  }
  /** My picture / settings changed: tell the host (hello) + (re)start my media link. */
  private announced = '';
  private announce() {
    const info = this.info();
    const sig = JSON.stringify(info);
    if (this.hostId && sig !== this.announced) { this.announced = sig; this.hello(); }
    const src = this.source;
    this.links.setOwn(info && src.out ? { stream: src.out, preset: src.settings.preset, level: () => this.micLevel(), vts: src.settings.kind === 'vts', audio: this.voice ? this.vmic?.stream.getAudioTracks()[0] ?? null : null, hear: this.hearHost } : null);
  }

  private send(m: object | TvSig): boolean {
    if (this.ctl?.readyState !== 'open') return false;
    this.ctl.send(JSON.stringify(m));
    return true;
  }

  leave(why = '', lost = false) {
    if (this.role === 'none') return;
    this.send({ t: 'bye', owner: this.myId });
    this.links.reset();
    try { this.pc?.close(); } catch { /* */ }
    this.relay?.close();
    this.pc = null; this.ctl = null; this.relay = null; this.hostId = ''; this.remoteSet = false;
    this.role = 'none';
    this.green.known = false; this.green.wait = false; this.green.talk = false;
    this.hostMod = { cam: false, mic: false, at: 0 };
    this.say(why || 'You left the party');
    if (lost) this.onLost?.(why);
  }

  private say(s: string) { this.status = s; this.onChange(); }
}

/** guestlink: why a link never came up, in words a guest can act on. */
export function failText(host: string, turn: boolean | null): string {
  return turn
    ? `Couldn’t connect to ${host} — your network blocks it even through the relay’s TURN server. Try another network (home Wi-Fi instead of mobile data, or no VPN).`
    : `Couldn’t connect to ${host} — your network and theirs can’t reach each other directly (common on mobile data, work / school Wi-Fi or VPNs). ${host} needs to turn on TURN on their relay; meanwhile try home Wi-Fi.`;
}
