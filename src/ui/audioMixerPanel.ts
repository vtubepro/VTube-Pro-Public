// Audio mixer card (beta.12, owner: "I need to be able to monitor volume as much as possible … mute someone on my end,
// but still volume is being read so the camera director understands who is speaking … a noise gate"). Opens from the
// show dock's Guests menu ("Audio mixer") and Tools. One row per voice:
//   You            your mic's level (peak + average, clipping), the voice filter you already have (Off / Standard / Strong),
//                  the browser's noise suppression, "Learn my room's noise"
//   each guest     level meter with the gate threshold on it, volume (= Live → People's volume), Mute for me,
//                  Mute for everyone (the moderation one), Noise gate Off / Auto / Manual, Clean up hiss, timing
//   show sounds    read-aloud, the room screen video's sound, room sounds (horns, slaps, the poll sting), the tabletop
//                  narrator: all played HERE (src/audio/mixer/showSounds.ts) with real meters
// Everything plays only here in the studio, never on the OBS page (owner: "Studio only, everything").
// Runtime: src/audio/mixer/audioMixer.ts; rules: shared/audioMix.ts; guide: docs/VOICE.md → "Audio mixer".
// mountAudioMixer(app) (one line in src/main.ts) wires the runtime to the party (src/audio/mixer/wireMixer.ts) and registers
// the dock + Tools entries. Everything else lives here.
import type { App } from '../app.ts';
import { h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { registerDockEntry } from './showDock.ts';
import { registerTool } from './toolsMenu.ts';
import type { AudioMixer, MixSource } from '../audio/mixer/audioMixer.ts';
import { wireMixer, type MixerParty, type WiredMixer } from '../audio/mixer/wireMixer.ts';
import { GATE_LIMITS, ME_ID, METER_FLOOR, meterPos, peakHold, rowStatus } from '../../shared/audioMix.ts';
import type { VoiceSettings, VoiceStat } from '../audio/voice/voiceFrontEnd.ts';
import { ShowSounds, setStudioShow, type ShowRow, type ShowRowStats } from '../audio/mixer/showSounds.ts';
import { AudioLeader, type LeadWhy } from '../audio/mixer/audioLeader.ts';

/** The card's view of a ShowSounds player. */
export const showUiHost = (S: ShowSounds, L: AudioLeader | null): MixerUiHost['show'] => ({
  stats: (r) => S.stats(r), vol: (r) => S.vols[r], setVol: (r, v) => S.setVol(r, v), played: (r) => S.usedRow(r),
  where: () => (L ? L.where().why : null),
  videoNote: () => S.videoNote(), meSink: () => S.meSink, setMeSink: (id) => S.setMeSink(id), sinkOk: () => S.sinkOk, meFellBack: () => S.meFellBack === true,
});

/** Everything the card needs (the studio wires it to the party; the e2e page to synthetic voices). */
export interface MixerUiHost {
  readonly mixer: AudioMixer;
  readonly observer: boolean;
  role(): 'none' | 'host' | 'guest';
  sources(): MixSource[];
  /** Moderation: muted for everyone (the host's own decision, not BRB). */
  everyoneMuted(id: string): boolean;
  setEveryoneMuted(id: string, on: boolean): void;
  vol(id: string): number;
  air(id: string): boolean;
  /** 0..1: the level the camera director reads for them right now. */
  directorLevel(id: string): number;
  hear: { on(): boolean; set(on: boolean): void };
  me: {
    active(): boolean; label(): string; settings(): VoiceSettings; stat(): VoiceStat | null;
    set(p: Partial<VoiceSettings>): Promise<void>; calibrate(): Promise<unknown>; start(): Promise<unknown>;
  };
  video: { on(): boolean; audio(): boolean; vol(): number; set(p: { audio?: boolean; volume?: number }): void } | null;
  /** The studio's show-sound player (meters + the room / narrator volumes). */
  show: { stats(r: ShowRow): ShowRowStats | null; vol(r: 'room' | 'games' | 'gm' | 'me'): number; setVol(r: 'room' | 'games' | 'gm' | 'me', v: number): void; played(r: ShowRow): boolean;
    /** Why this window plays the show's sounds or stays quiet (null = no election here: an observer). */
    where(): LeadWhy | null;
    /** The narrator's "Only me" output device ('' = same as the studio). */
    meSink(): string; setMeSink(id: string): void; sinkOk(): boolean;
    /** The chosen Only-me output couldn't be used (unplugged?): those lines play on the studio's output instead. */
    meFellBack(): boolean;
    /** Why the room screen's source has no sound anywhere (a camera, the window feed), or null. */
    videoNote(): string | null };
  /** Read-aloud settings (null = no helper to ask). */
  tts: { get(): Promise<{ on: boolean; volume: number; where: string } | null>; set(p: { on?: boolean; volume?: number }): Promise<unknown> } | null;
}

/** The mixer card's line about where the show's sounds play. */
const WHERE_TEXT: Record<LeadWhy, string> = {
  me: 'Sounds play in this window.',
  tab: 'Sounds play in your other window of this studio: this one stays quiet so nothing is heard twice. Close that window and this one takes over.',
  pc: 'Sounds play in the studio on this PC: this one stays quiet so nothing is heard twice.',
  other: 'Sounds play in another VTube Pro window on your network: this one stays quiet so nothing is heard twice.',
  waiting: 'Checking which studio window plays the sounds…',
};

// ---------------------------------------------------------------- the studio's wiring
let mixer: AudioMixer | null = null;
let host: MixerUiHost | null = null;
/** The studio's mixer (null before mountAudioMixer). */
export const studioMixer = () => mixer;

/** The guest half of the card's host, from the real wiring (the studio and the e2e page both use it). */
export function guestUiHost(P: MixerParty, w: WiredMixer): Pick<MixerUiHost, 'mixer' | 'role' | 'sources' | 'everyoneMuted' | 'setEveryoneMuted' | 'vol' | 'air' | 'directorLevel' | 'hear'> {
  return {
    mixer: w.mixer, role: () => P.role, sources: w.port.sources,
    everyoneMuted: (id) => !!P.mod.view(id)?.mic,
    setEveryoneMuted: (id, on) => { P.mod.setMic(id, on); },
    vol: w.port.vol, air: w.port.air,
    directorLevel: (id) => w.activity(id),
    hear: { on: () => P.tv.hear, set: (on) => P.tv.setHear(on) },
  };
}

export function mountAudioMixer(app: App) {
  if (mixer) return;
  const P = app.party;
  // every show sound plays here (output pages are silent): read-aloud, the room screen video, room effects, games, the
  // narrator, sound inputs — in exactly ONE studio window (src/audio/mixer/audioLeader.ts): one window per studio (a
  // Web Lock).
  const leader = app.observer ? null : new AudioLeader(app.bus as unknown as ConstructorParameters<typeof AudioLeader>[0]);
  const w = wireMixer(P, app.observer, () => app.audio.stream, () => leader?.isLeader() ?? false);
  mixer = w.mixer;
  leader?.listeners.add(() => w.mixer.leadChanged());
  const show = new ShowSounds({ observer: app.observer, scene: () => ({ mode: String(app.scene.state.mode ?? 'talk'), video: app.scene.state.video }), leader });
  setStudioShow(show);
  app.bus.on((m) => {
    if (m.type === 'chathub') show.onChatHub(m.m);
    else if (m.type === 'showsound') show.onShowSound(m.id, m.s);
    else if (m.type === 'liveclock') show.onLiveClock(m.src, m.lag);
  });
  host = {
    ...guestUiHost(P, w), observer: app.observer, show: showUiHost(show, leader),
    me: {
      active: () => app.audio.active, label: () => app.audio.deviceLabel, settings: () => app.audio.voiceSettings, stat: () => app.audio.fx?.stat ?? null,
      set: (p) => app.audio.setVoiceSettings(p), calibrate: () => app.audio.calibrateNoise(3),
      start: () => import('./liveOps.ts').then((m) => m.startMic(app)),
    },
    video: {
      on: () => !!app.scene.state.video?.on, audio: () => !!app.scene.state.video?.audio, vol: () => app.scene.state.video?.volume ?? 0.8,
      set: (p) => { if (!app.scene.canEdit) return; app.scene.setVideo((v) => { if (p.audio !== undefined) v.audio = p.audio; if (p.volume !== undefined) v.volume = Math.min(1, Math.max(0, p.volume)); }); },
    },
    tts: {
      get: async () => { try { const r = await fetch('/api/chathub/state', { cache: 'no-store' }); if (!r.ok) return null; const j = await r.json() as { tts?: { on?: boolean; volume?: number; where?: string } }; return j.tts ? { on: !!j.tts.on, volume: j.tts.volume ?? 0.9, where: j.tts.where ?? 'obs' } : null; } catch { return null; } },
      set: (p) => fetch('/api/chathub/tts', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }),
    },
  };
  registerDockEntry({
    id: 'guests-audio-mixer', menu: 'guests', icon: 'speak', order: 15, label: 'Audio mixer',
    hint: 'Every voice’s level and volume, Mute for me (the cameras still follow them) and a noise gate.',
    run: () => openAudioMixer(),
  });
  registerTool({
    id: 'audio-mixer', icon: 'speak', title: 'Audio mixer', short: 'Levels + noise gate',
    line: 'See every voice’s level, set volumes, mute a guest just for you, and gate out background noise.',
    run: () => openAudioMixer(),
  });
}

// ---------------------------------------------------------------- the floating card
let closeOpen: (() => void) | null = null;
/** Open the mixer card above the show dock (again = close it). */
export function openAudioMixer(h0: MixerUiHost | null = host) {
  if (closeOpen) { closeOpen(); return; }
  if (!h0) return;
  injectCss();
  const body = h('div', { class: 'am-body' });
  const card = h('div', { class: 'am-card', role: 'dialog', 'aria-label': 'Audio mixer', 'data-ui': 'audio-mixer' },
    h('header', null,
      h('span', null, h('b', null, 'Audio mixer'), h('small', null, 'Every voice: its level, its volume, a noise gate.')),
      h('button', { type: 'button', class: 'am-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => close() }, icon('x', 16))),
    body);
  const place = () => {
    const d = document.getElementById('showdock'), r = d && d.offsetParent ? d.getBoundingClientRect() : null;
    card.style.bottom = `${Math.round(r ? innerHeight - r.top + 8 : 12)}px`;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement | null)?.closest?.('input,select,textarea')) { e.preventDefault(); e.stopPropagation(); close(); } };
  const unmount = mountMixer(body, h0);
  const close = () => {
    if (closeOpen !== close) return;
    closeOpen = null;
    window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place);
    unmount();
    card.remove();
  };
  closeOpen = close;
  document.body.append(card);
  place();
  window.addEventListener('keydown', onKey, true); window.addEventListener('resize', place);
  return close;
}

// ---------------------------------------------------------------- the card's content
const pct = (v: number) => `${Math.round(v * 100)}%`;
const dbText = (db: number) => (db <= -99 ? '−∞' : `${Math.round(db)} dB`.replace('-', '−'));

/** Fill `el` with the mixer (returns the unmount). Meters run while it is mounted. */
export function mountMixer(el: HTMLElement, H: MixerUiHost): () => void {
  injectCss();
  const M = H.mixer;
  const stopMeter = M.meter();
  el.classList.add('am');
  let alive = true;
  /** Meter elements per source id, updated every animation frame. */
  const meters = new Map<string, { bar: HTMLElement; avg: HTMLElement; peak: HTMLElement; thr: HTMLElement | null; clip: HTMLElement; read: HTMLElement; state: HTMLElement | null; hold: { db: number; at: number }; clipAt: number; lvl: number; t: number;
    /** the last values written, so an unchanged frame touches no DOM */
    wAvg?: string; wBg?: string; wPk?: string; pkHid?: boolean; vNow?: string; rd?: string; thrHid?: boolean; wThr?: string }>();
  const sliders = new Map<string, () => void>();
  let sig = '';
  let tts: { on: boolean; volume: number; where: string } | null = null;
  void H.tts?.get().then((t) => { tts = t; paint(true); });

  const meterEl = (id: string, withThr: boolean, thrTip = 'Noise gate threshold: quieter sound is cut') => {
    const avg = h('i', { class: 'am-avg' }), peak = h('i', { class: 'am-pk' }), thr = withThr ? h('i', { class: 'am-thr', title: thrTip }) : null;
    const clip = h('span', { class: 'am-clip', title: 'Lights up when the voice is so loud it distorts. Lower the mic gain at the source.' }, 'Too loud');
    const read = h('span', { class: 'am-read' }, '−∞');
    const bar = h('div', { class: 'am-meter', role: 'meter', 'aria-label': 'Level', 'aria-valuemin': String(METER_FLOOR), 'aria-valuemax': '0' }, avg, peak, thr);
    meters.set(id, { bar, avg, peak, thr, clip, read, state: null, hold: { db: -100, at: 0 }, clipAt: -1e9, lvl: -100, t: 0 });
    return h('div', { class: 'am-mrow' }, bar, read, clip);
  };
  const pill = (label: string, on: boolean, click: () => void, o: { tip?: string; danger?: boolean; mute?: boolean; ic?: string; ui?: string; off?: boolean } = {}) =>
    h('button', { type: 'button', class: `am-pill${on ? ' on' : ''}${o.danger ? ' danger' : ''}${o.mute ? ' mute' : ''}`, 'aria-pressed': String(on), title: o.tip ?? null, disabled: o.off || null, 'data-ui': o.ui ?? null, onClick: click }, o.ic ? icon(o.ic, 14) : null, label);
  const seg = <T extends string>(opts: [T, string, string][], cur: T, pick: (v: T) => void, label: string) =>
    h('div', { class: 'am-seg', role: 'radiogroup', 'aria-label': label }, ...opts.map(([v, t, tip]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(v === cur), class: v === cur ? 'on' : '', title: tip, 'data-v': v, onClick: () => { if (v !== cur) pick(v); } }, t)));
  const range = (id: string, label: string, v: number, lo: number, hi: number, step: number, fmt: (v: number) => string, onInput: (v: number) => void, read?: () => number) => {
    const inp = h('input', { type: 'range', min: String(lo), max: String(hi), step: String(step), value: String(v), 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(v));
    inp.addEventListener('input', () => { const x = Number(inp.value); out.textContent = fmt(x); onInput(x); });
    if (read) sliders.set(id, () => { if (document.activeElement === inp) return; const x = read(); if (Math.abs(Number(inp.value) - x) > step / 2) { inp.value = String(x); out.textContent = fmt(x); } });
    return h('label', { class: 'am-range' }, h('span', { class: 'am-rl' }, label), inp, out);
  };

  // ---- You
  const meRow = () => {
    const on = H.me.active(), s = H.me.settings();
    const row = h('section', { class: 'am-row', 'data-src': 'me' },
      h('div', { class: 'am-top' }, h('b', { class: 'am-name' }, 'You'), h('span', { class: 'am-tag' }, on ? H.me.label() || 'your mic' : 'mic off'), h('span', { class: 'am-state dim', 'data-state': 'me' }, on ? '' : 'Off')),
      on ? meterEl(ME_ID, true, 'Your room’s noise level (learned): the voice filter ignores what stays under it') : null,
      on ? h('div', { class: 'am-ctl' },
        h('span', { class: 'am-lbl' }, 'Voice filter'),
        seg<VoiceSettings['filter']>([['off', 'Off', 'No filtering: your mouth follows every sound'], ['standard', 'Standard', 'Background noise and other voices don’t move your mouth (recommended)'], ['strong', 'Strong', 'For loud rooms: stricter, needs clear speech']], s.filter, (v) => void H.me.set({ filter: v }).then(() => paint(true)), 'Voice filter'),
        pill('Browser noise suppression', s.browserNS, () => { void H.me.set({ browserNS: !s.browserNS }).then(() => paint(true)); toast(s.browserNS ? 'Browser noise suppression off: your mic restarts' : 'Browser noise suppression on: your mic restarts', 'info', 3200); },
          { tip: s.filter === 'off' ? 'Works with the voice filter on (Standard or Strong).' : 'The browser’s own noise removal on your mic. The voice filter usually does better; try this in a very noisy room.', off: s.filter === 'off' }),
        h('button', { type: 'button', class: 'am-link', onClick: () => { toast('Stay quiet for 3 seconds…', 'info', 3000); void H.me.calibrate().then(() => toast('Learned your room’s noise', 'ok')).catch(() => toast('Couldn’t learn it: is your mic on?', 'warn')); } }, 'Learn my room’s noise'))
        : h('div', { class: 'am-ctl' }, h('span', { class: 'am-note' }, 'Your mic is off, so there is nothing to measure.'), h('button', { type: 'button', class: 'am-pill', onClick: () => void H.me.start().then(() => paint(true)) }, icon('mic', 14), 'Turn on my mic')),
      on ? h('p', { class: 'am-note' }, 'Your stream hears you through OBS’s own mic source. This meter is what VTube Pro hears for lip sync.') : null);
    return row;
  };

  // ---- a guest
  const guestRow = (s: MixSource, i: number, all: MixSource[]) => {
    const p = M.prefsOf(s.id), muted = H.everyoneMuted(s.id), g = p.gate;
    // (two guests with the same name: number them, so the right one gets muted)
    const same = all.filter((x) => x.name === s.name), nth = same.length > 1 ? ` · #${same.indexOf(s) + 1}` : '';
    void i;
    const head = h('div', { class: 'am-top' },
      h('b', { class: 'am-name' }, s.name),
      h('span', { class: 'am-tag' }, `${s.kind === 'link' ? 'guest link' : 'VTube Pro'}${nth}`),
      h('span', { class: 'am-state', 'data-state': s.id }, ''));
    const thrRow = g.mode === 'manual' ? range(`thr:${s.id}`, 'Cut below', g.threshold, GATE_LIMITS.threshold[0], GATE_LIMITS.threshold[1], 1, dbText, (v) => M.set(s.id, { gate: { threshold: v } }), () => M.prefsOf(s.id).gate.threshold) : null;
    const timing = g.mode !== 'off' ? h('details', { class: 'am-more' }, h('summary', null, 'Gate timing'),
      range(`att:${s.id}`, 'Fade in', g.attack, GATE_LIMITS.attack[0], GATE_LIMITS.attack[1], 1, (v) => `${v} ms`, (v) => M.set(s.id, { gate: { attack: v } })),
      range(`hold:${s.id}`, 'Stay open', g.hold, GATE_LIMITS.hold[0], GATE_LIMITS.hold[1], 10, (v) => `${v} ms`, (v) => M.set(s.id, { gate: { hold: v } })),
      range(`rel:${s.id}`, 'Fade out', g.release, GATE_LIMITS.release[0], GATE_LIMITS.release[1], 10, (v) => `${v} ms`, (v) => M.set(s.id, { gate: { release: v } })),
      g.mode === 'auto' ? h('button', { type: 'button', class: 'am-link', onClick: () => { M.relearn(s.id); toast(`Listening to ${s.name}’s background for 3 seconds (everything passes meanwhile)`, 'info', 3500); } }, 'Learn their background again') : null) : null;
    return h('section', { class: 'am-row', 'data-src': s.id },
      head,
      meterEl(s.id, g.mode !== 'off'),
      h('div', { class: 'am-ctl' },
        range(`vol:${s.id}`, 'Volume', H.vol(s.id), 0, 1, 0.01, pct, (v) => M.setVolume(s.id, v), () => H.vol(s.id)),
        pill('Mute for me', p.muteMe, () => M.set(s.id, { muteMe: !p.muteMe }), { ui: 'mute-for-me', mute: true, ic: p.muteMe ? 'micoff' : 'speak', tip: 'You stop hearing them here (backstage too), but the cameras still follow their voice. For a guest you already hear in Discord.' }),
        H.role() === 'host' ? pill('Mute for everyone', muted, () => H.setEveryoneMuted(s.id, !muted), { danger: true, ui: 'mute-everyone', tip: 'Nobody hears them: not you, not the stream, not the other guests. The cameras stop cutting to them.' }) : null),
      h('div', { class: 'am-ctl' },
        h('span', { class: 'am-lbl' }, 'Noise gate'),
        seg([['off', 'Off', 'Their voice as it arrives'], ['auto', 'Auto', 'Learns their background noise and cuts it between words'], ['manual', 'Manual', 'You set the level below which sound is cut']], g.mode, (v) => M.set(s.id, { gate: { mode: v } }), 'Noise gate'),
        pill('Clean up hiss', p.clean, () => M.set(s.id, { clean: !p.clean }), { tip: 'Lightly removes steady background hiss and hum from their voice (adds 11 ms).' })),
      thrRow, timing);
  };

  // ---- sound inputs: a camera's microphone, a capture card, an interface channel — played here, like a guest
  let devices: { id: string; label: string }[] = [], outputs: { id: string; label: string }[] = [];
  const listDevices = () => void navigator.mediaDevices?.enumerateDevices?.().then((d) => {
    const ins = d.filter((x) => x.kind === 'audioinput' && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x, i) => ({ id: x.deviceId, label: x.label || `Sound input ${i + 1}` }));
    const outs = d.filter((x) => x.kind === 'audiooutput' && x.deviceId && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x, i) => ({ id: x.deviceId, label: x.label || `Output ${i + 1}` }));
    if (JSON.stringify([ins, outs]) !== JSON.stringify([devices, outputs])) { devices = ins; outputs = outs; paint(true); }
  }).catch(() => {});
  const inputRow = (r: ReturnType<AudioMixer['inputRows']>[number]) => {
    const p = M.prefsOf(r.id), g = p.gate;
    return h('section', { class: 'am-row am-input', 'data-src': r.id },
      h('div', { class: 'am-top' }, h('b', { class: 'am-name' }, r.label), h('span', { class: 'am-tag' }, 'sound input'), h('span', { class: 'am-state', 'data-state': r.id }, r.open ? '' : r.elsewhere ? 'In the other window' : r.error ? 'Not playing' : 'Opening…'),
        h('button', { type: 'button', class: 'am-x am-rm', 'aria-label': `Remove ${r.label}`, title: 'Remove this sound input', onClick: () => { M.removeInput(r.id); paint(true); } }, icon('x', 14))),
      r.error && !r.elsewhere ? h('p', { class: 'am-warn' }, r.error, ' ', h('button', { type: 'button', class: 'am-link', onClick: () => M.retryInputs() }, 'Try again')) : null,
      h('p', { class: 'am-note', 'data-ui': 'input-warning' }, 'This plays through the studio’s sound. Don’t also capture this device in OBS, and wear headphones if this mic can hear your speakers.'),
      r.elsewhere ? h('p', { class: 'am-note' }, 'It opens in the studio window that plays the show’s sounds, so only one window ever uses it.') : null,
      meterEl(r.id, g.mode !== 'off'),
      h('div', { class: 'am-ctl' },
        range(`vol:${r.id}`, 'Volume', p.vol ?? 1, 0, 1, 0.01, pct, (v) => M.setVolume(r.id, v), () => M.prefsOf(r.id).vol ?? 1),
        pill('Mute', p.muteMe, () => M.set(r.id, { muteMe: !p.muteMe }), { mute: true, ic: p.muteMe ? 'micoff' : 'speak', ui: 'input-mute' })),
      h('div', { class: 'am-ctl' },
        h('span', { class: 'am-lbl' }, 'Noise gate'),
        seg([['off', 'Off', 'As it comes in'], ['auto', 'Auto', 'Learns the background noise and cuts it'], ['manual', 'Manual', 'You set the level below which sound is cut']], g.mode, (v) => M.set(r.id, { gate: { mode: v } }), 'Noise gate'),
        pill('Clean up hiss', p.clean, () => M.set(r.id, { clean: !p.clean })),
        pill('Echo cancel', r.ec, () => { M.setInputEcho(r.id, !r.ec); paint(true); }, { ui: 'input-echo', tip: r.ec ? 'On: removes your speakers’ sound if this mic hears them. Turn off for a capture card or a music source.' : 'Off: as it comes in (best for a capture card or music). Turn on if this mic can hear your speakers.' })),
      g.mode === 'manual' ? range(`thr:${r.id}`, 'Cut below', g.threshold, GATE_LIMITS.threshold[0], GATE_LIMITS.threshold[1], 1, dbText, (v) => M.set(r.id, { gate: { threshold: v } }), () => M.prefsOf(r.id).gate.threshold) : null);
  };
  const addInput = () => {
    const free = devices.filter((d) => !M.inputs.some((x) => x.deviceId === d.id));
    const sel = h('select', { class: 'am-select', 'aria-label': 'Sound input to add', 'data-ui': 'add-input-device' }, ...free.map((d) => h('option', { value: d.id }, d.label))) as HTMLSelectElement;
    return h('div', { class: 'am-ctl am-add' },
      free.length ? sel : h('span', { class: 'am-note' }, devices.length ? 'Every sound input is added.' : 'No sound inputs found (or the browser hides their names until the microphone is allowed).'),
      free.length ? h('button', { type: 'button', class: 'am-pill', 'data-ui': 'add-input', onClick: () => { const d = free.find((x) => x.id === sel.value); if (d) { M.addInput(d.id, d.label); paint(true); } } }, icon('mic', 14), 'Add a sound input') : null);
  };

  const showRow = (row: ShowRow, title: string, ctl: (HTMLElement | null)[], note: string | null) =>
    h('section', { class: 'am-row am-show', 'data-src': `show:${row}` },
      h('div', { class: 'am-top' }, h('b', { class: 'am-name' }, title), h('span', { class: 'am-tag' }, row === 'me' ? 'only on the output you pick' : 'plays in the studio'), h('span', { class: 'am-state dim', 'data-state': `show:${row}` }, '')),
      meterEl(`show:${row}`, false), h('div', { class: 'am-ctl' }, ...ctl), note ? h('p', { class: 'am-note' }, note) : null);
  const showRows = () => {
    const rows: HTMLElement[] = [];
    const S = H.show;
    const T = tts;
    rows.push(showRow('tts', 'Read-aloud', T ? [
      range('tts', 'Volume', T.volume, 0, 1, 0.05, pct, (v) => { T.volume = v; void H.tts?.set({ volume: v }); }),
      pill(T.on ? 'On' : 'Off', T.on, () => { void H.tts?.set({ on: !T.on }).then(() => H.tts?.get()).then((t) => { tts = t ?? tts; paint(true); }); }, { tip: 'Read supporters’ messages aloud (Chat Hub)' }),
    ] : [], T ? null : 'Set it up in the Chat Hub (support messages read aloud).'));
    const V = H.video;
    if (V) rows.push(showRow('video', 'Room screen video', [
      range('video', 'Volume', V.vol(), 0, 1, 0.05, pct, (v) => V.set({ volume: v }), () => V.vol()),
      pill(V.audio() ? 'Sound on' : 'Sound off', V.audio(), () => { V.set({ audio: !V.audio() }); setTimeout(() => paint(true), 50); }),
    ], V.on() ? H.show.videoNote() : 'No video on the room’s screen right now.'));
    rows.push(showRow('room', 'Room sounds', [range('room', 'Volume', S.vol('room'), 0, 1, 0.05, pct, (v) => S.setVol('room', v), () => S.vol('room'))],
      'Air horns, slaps, the poll sting: the room’s own effects.'));
    if (S.played('games')) rows.push(showRow('games', 'Games', [range('games', 'Volume', S.vol('games'), 0, 1, 0.05, pct, (v) => S.setVol('games', v), () => S.vol('games'))], 'The Trail’s game sounds.'));
    if (S.played('gm')) rows.push(showRow('gm', 'Tabletop narrator', [range('gm', 'Volume', S.vol('gm'), 0, 1, 0.05, pct, (v) => S.setVol('gm', v), () => S.vol('gm'))], null));
    // "Only me": the narrator's private lines, on an output the host picks (their headphones)
    const outs = h('select', { class: 'am-select', 'aria-label': 'Where Only-me sounds play', 'data-ui': 'only-me-output' },
      h('option', { value: '' }, 'Same as the studio'), ...outputs.map((o) => h('option', { value: o.id }, o.label))) as HTMLSelectElement;
    // (a saved output that isn't plugged in right now stays chosen, and the row says it isn't available)
    const missing = !!S.meSink() && !outputs.some((o) => o.id === S.meSink()), gone = missing && outputs.length > 0;
    if (missing) outs.append(h('option', { value: S.meSink() }, gone ? 'Your chosen output (not found)' : 'Your chosen output'));
    outs.value = S.meSink();
    outs.disabled = !S.sinkOk();
    outs.addEventListener('change', () => { S.setMeSink(outs.value); paint(true); });
    rows.push(showRow('me', 'Only me', [h('span', { class: 'am-lbl' }, 'Plays on'), outs, range('me', 'Volume', S.vol('me'), 0, 1, 0.05, pct, (v) => S.setVol('me', v), () => S.vol('me'))],
      !S.sinkOk() ? 'This browser can’t pick an output: Only-me sounds play with the studio, so a window capture in OBS hears them too.'
        : !S.meSink() ? 'The tabletop narrator’s “Only me” lines. On “Same as the studio” a window or desktop capture in OBS hears them too: pick your headphones so only you hear them.'
          : gone || S.meFellBack() ? 'Your chosen output isn’t available (unplugged?), so Only-me lines play with the studio and a window capture in OBS hears them too. Plug it back in or pick another.'
            : 'The tabletop narrator’s “Only me” lines play only on this output.'));
    return rows;
  };

  function paint(force = false) {
    if (!alive) return;
    const srcs = H.sources();
    const s = H.me.settings();
    // (rebuild only when what the rows SHOW changed — never while a slider is being dragged: volumes / thresholds are synced in place)
    const next = JSON.stringify([H.me.active(), s.filter, s.browserNS, H.role(), H.hear.on(), srcs.map((x) => [x.id, x.name, x.kind, M.prefsOf(x.id).muteMe, M.prefsOf(x.id).clean, M.prefsOf(x.id).gate.mode, H.everyoneMuted(x.id)]), H.video?.on(), H.video?.audio(), tts?.on, H.show.played('gm'), H.show.played('games'), H.show.where(), H.show.videoNote(), H.show.meSink(), H.show.meFellBack(), M.inputRows().map((r) => [r, M.prefsOf(r.id).muteMe, M.prefsOf(r.id).clean, M.prefsOf(r.id).gate.mode]), devices.length, outputs.length, M.error]);
    if (!force && next === sig) return;
    if (!force && el.contains(document.activeElement) && (document.activeElement as HTMLElement).tagName === 'INPUT') return;
    sig = next;
    meters.clear(); sliders.clear();
    const guests = srcs.map(guestRow);
    const inputs = M.inputRows().map(inputRow);
    const show = showRows();
    const kids: (Node | null | (Node | null)[])[] = [
      M.error ? h('div', { class: 'am-warn', role: 'alert' }, M.error, ' ', h('button', { type: 'button', class: 'am-link', onClick: () => { M.retryNow(); toast('Trying again…', 'info', 2000); } }, 'Try again')) : null,
      meRow(),
      h('div', { class: 'am-head' }, h('span', null, 'Guests'),
        srcs.length ? pill('Hear guests here', H.hear.on(), () => { H.hear.set(!H.hear.on()); paint(true); }, { tip: 'Plays your guests in this studio window: the only place VTube Pro plays them (never on the OBS page). Wear headphones.' }) : null,
        null),
      guests.length ? guests : h('p', { class: 'am-empty' }, H.role() === 'guest'
        ? 'You are a guest in someone’s show: their studio mixes the guests.'
        : 'No guest voices yet. When someone joins with a guest link, or talks in a party, they appear here with their own meter.'),
      h('div', { class: 'am-head' }, h('span', null, 'Show sounds'), h('small', null, 'They play in the studio too, never on your OBS page: your stream hears them from the studio window.')),
      (() => { const w = H.show.where(); return w ? h('p', { class: `am-where ${w === 'me' ? 'me' : 'other'}`, 'data-ui': 'sounds-where', 'data-why': w, role: 'status' }, WHERE_TEXT[w]) : null; })(),
      ...show,
      h('div', { class: 'am-head' }, h('span', null, 'Sound inputs'), h('small', null, 'A camera’s microphone, a capture card or an interface channel, played here in the studio with its own meter, volume and noise gate. VTube Pro can’t hear another app’s sound.')),
      ...inputs,
      addInput(),
      srcs.length ? h('p', { class: 'am-foot' }, 'Guests play only here in the studio, never on your OBS page. ', h('b', null, 'Mute for me'), ' silences a guest for you, while the cameras still follow their voice. ',
        h('b', null, 'Auto gate'), ' listens for a few seconds, then cuts their background noise between words, so noise never switches the camera to them.') : null];
    el.replaceChildren(...kids.flat().filter((k): k is Node => !!k));
    tick();
  }

  // ---- meters (every animation frame while the card is open)
  let raf = 0;
  const tick = () => {
    const now = performance.now() / 1000;
    for (const [id, m] of meters) {
      const showR = id.startsWith('show:') ? (id.slice(5) as ShowRow) : null;
      const ss = showR ? H.show.stats(showR) : null;
      const st = showR ? null : M.stats(id);
      const peak = st ? st.peak : ss ? ss.peak : -100, rms = st ? st.rms : ss ? ss.rms : -100;
      m.hold = peakHold(m.hold, peak, now);
      // meter ballistics: up at once, down 24 dB/s (a syllable gap doesn't flicker the bar / the number)
      m.lvl = rms >= m.lvl ? rms : Math.max(rms, m.lvl - 24 * Math.min(0.2, now - m.t)); m.t = now;
      const pos = meterPos(m.lvl);
      const wAvg = `${(pos * 100).toFixed(1)}%`;
      if (wAvg !== m.wAvg) { m.wAvg = wAvg; m.avg.style.width = wAvg; }
      const wBg = `${(100 / Math.max(0.01, pos)).toFixed(1)}% 100%`;   // (the colours stay where the dB are)
      if (wBg !== m.wBg) { m.wBg = wBg; m.avg.style.backgroundSize = wBg; }
      const wPk = `${(meterPos(m.hold.db) * 100).toFixed(1)}%`;
      if (wPk !== m.wPk) { m.wPk = wPk; m.peak.style.left = wPk; }
      const pkHid = m.hold.db <= METER_FLOOR;
      if (pkHid !== m.pkHid) { m.pkHid = pkHid; m.peak.hidden = pkHid; }
      const vNow = String(Math.round(m.lvl));
      if (vNow !== m.vNow) { m.vNow = vNow; m.bar.setAttribute('aria-valuenow', vNow); }
      if (st?.clip || (ss && ss.peak > -0.3)) m.clipAt = now;
      m.clip.classList.toggle('on', now - m.clipAt < 1.5);
      const rd = dbText(m.lvl);
      if (rd !== m.rd) { m.rd = rd; m.read.textContent = rd; }
      let thrDb: number | null = null, closed = false;
      if (id === ME_ID) { const vs = H.me.stat(); if (vs && vs.rawFloor > -99) thrDb = vs.rawFloor; }
      else if (st && (st.gate || st.learning)) { thrDb = st.learning ? null : st.thr; closed = st.gate && st.open < 0.05; }
      if (m.thr) {
        const hid = thrDb === null;
        if (hid !== m.thrHid) { m.thrHid = hid; m.thr.hidden = hid; }
        if (thrDb !== null) { const w = `${(meterPos(thrDb) * 100).toFixed(1)}%`; if (w !== m.wThr) { m.wThr = w; m.thr.style.left = w; } }
      }
      m.bar.classList.toggle('closed', closed);
      // the one-line state
      // looked up until found (a row may join the panel a frame after its meter), then kept while it is on the page
      if (!m.state?.isConnected) m.state = el.querySelector<HTMLElement>(`[data-state="${CSS.escape(id === ME_ID ? 'me' : id)}"]`);
      const stEl = m.state;
      // (className writes go through setCls: same string = no DOM write)
      const setCls = (c: string) => { if (stEl!.className !== c) stEl!.className = c; };
      if (stEl) {
        if (id.startsWith('in:')) { const on = rms > -60; const t = M.prefsOf(id).muteMe ? 'Muted' : on ? 'Sound' : 'Quiet'; if (stEl.textContent !== t && M.inputRows().some((x) => x.id === id && x.open)) { stEl.textContent = t; setCls(`am-state ${on && t === 'Sound' ? 'ok' : 'dim'}`); } }
        else if (showR) { const on = rms > -60; const t = on ? 'Playing' : 'Quiet'; if (stEl.textContent !== t) stEl.textContent = t; setCls(`am-state ${on ? 'ok' : 'dim'}`); }
        else if (id === ME_ID) { const vs = H.me.stat(); const talk = vs ? vs.gate > 0 : rms > -40; const tt = talk ? 'Talking' : 'Quiet'; if (stEl.textContent !== tt) stEl.textContent = tt; setCls(`am-state ${talk ? 'ok' : 'dim'}`); }
        else {
          const r = rowStatus({ muted: H.everyoneMuted(id), muteMe: M.prefsOf(id).muteMe, air: H.air(id), talking: H.directorLevel(id) > 0.3, gateClosed: closed });
          const txt = st?.learning ? `${r.text} · gate learning…` : r.text;
          if (stEl.textContent !== txt) stEl.textContent = txt;
          setCls(`am-state ${r.tone}`);
        }
      }
    }
    for (const f of sliders.values()) f();
  };
  const loop = () => { if (!alive) return; tick(); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  const offMix = (() => { const f = () => paint(); M.listeners.add(f); return () => M.listeners.delete(f); })();
  // (roster / moderation / voice settings changed elsewhere; a new mic track for the "You" meter)
  const poll = window.setInterval(() => { M.sync(); paint(); }, 700);
  paint(true);
  listDevices();
  const onDev = () => listDevices();
  try { navigator.mediaDevices?.addEventListener?.('devicechange', onDev); } catch { /* */ }
  return () => { try { navigator.mediaDevices?.removeEventListener?.('devicechange', onDev); } catch { /* */ } alive = false; cancelAnimationFrame(raf); clearInterval(poll); offMix(); stopMeter(); el.replaceChildren(); };
}

// ---------------------------------------------------------------- styles (calm: the studio's tokens, light + dark)
function injectCss() {
  if (document.getElementById('vtp-am-css')) return;
  document.head.append(h('style', { id: 'vtp-am-css' }, STYLE));
}
const STYLE = `
.am-card { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 72; width: min(600px, calc(100vw - 16px)); max-height: min(78vh, calc(100vh - 120px));
  display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--panel, #161920); color: var(--text, #eef1f6); border: 1px solid var(--line2, #333a4a); border-radius: 14px;
  box-shadow: 0 24px 60px -20px #000c; overflow: hidden; font-size: 13.5px; }
.am-card > header { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 16px; border-bottom: 1px solid var(--line, #262b37); }
.am-card > header > span { flex: 1; min-width: 0; display: grid; }
.am-card > header b { font-size: 15px; }
.am-card > header small { color: var(--dim, #a3abba); font-size: 12px; }
.am-x { flex: none; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--line2, #333a4a); background: var(--card2, #222733); color: var(--text, #eef1f6); cursor: pointer; }
.am-body { overflow: auto; overscroll-behavior: contain; padding: 10px 14px 14px; }
body.clean .am-card { display: none; }
.am { display: grid; gap: 8px; }
.am-row { display: grid; gap: 7px; padding: 10px 12px; background: var(--card, #1b1f28); border: 1px solid var(--line, #262b37); border-radius: 11px; }
.am-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.am-name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 46%; }
.am-tag { color: var(--faint, #717a8b); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.am-state { margin-left: auto; font-size: 12px; font-weight: 600; white-space: nowrap; color: var(--dim, #a3abba); }
.am-state.ok { color: var(--ok, #7bd88f); } .am-state.warn { color: var(--warn, #ffb454); }
.am-mrow { display: flex; align-items: center; gap: 8px; }
.am-meter { position: relative; flex: 1; height: 10px; border-radius: 5px; background: var(--input, #10131a); border: 1px solid var(--line, #262b37); overflow: hidden; }
.am-meter .am-avg { position: absolute; left: 0; top: 0; bottom: 0; width: 0; border-radius: 5px; background: linear-gradient(90deg, var(--ok, #7bd88f) 0 78%, var(--warn, #ffb454) 84% 92%, var(--err, #ff6b6b) 96%) 0 0 / 100% 100% no-repeat; }
.am-meter.closed .am-avg { opacity: .35; }
.am-meter .am-pk { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--text, #eef1f6); opacity: .8; }
.am-meter .am-thr { position: absolute; top: -1px; bottom: -1px; width: 2px; margin-left: -1px; background: var(--accent2, #6cc7f5); box-shadow: 0 0 0 1px var(--panel, #161920); }
.am-read { width: 50px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; color: var(--dim, #a3abba); }
.am-clip { visibility: hidden; font-size: 10.5px; font-weight: 700; white-space: nowrap; padding: 1px 6px; border-radius: 4px; color: #fff; background: var(--err, #ff6b6b); }
.am-clip.on { visibility: visible; }
.am-ctl { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.am-lbl { color: var(--dim, #a3abba); font-size: 12px; font-weight: 600; min-width: 74px; }
.am-pill { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line2, #333a4a); background: var(--card2, #222733); color: var(--text, #eef1f6); font: inherit; font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 99px; cursor: pointer; min-height: 30px; }
.am-pill:hover:not(:disabled) { border-color: var(--dim, #a3abba); }
.am-pill:disabled { opacity: .5; cursor: default; }
.am-pill.on { background: var(--accent-soft, #7bd88f22); border-color: var(--accent, #7bd88f); color: var(--text, #eef1f6); }
.am-pill.danger.on { background: var(--err-soft, #ff6b6b22); border-color: var(--err, #ff6b6b); }
.am-pill.mute.on { background: var(--accent2-soft, #6cc7f522); border-color: var(--accent2, #6cc7f5); }
.am-pill svg { flex: none; }
.am-seg { display: inline-flex; background: var(--input, #10131a); border: 1px solid var(--line, #262b37); border-radius: 99px; padding: 2px; gap: 2px; }
.am-seg button { border: 0; background: transparent; color: var(--dim, #a3abba); font: inherit; font-size: 12px; font-weight: 600; padding: 4px 11px; border-radius: 99px; cursor: pointer; min-height: 26px; }
.am-seg button.on { background: var(--accent, #7bd88f); color: var(--accent-ink, #08130b); }
.am-seg button:not(.on):hover { color: var(--text, #eef1f6); }
.am-range { display: inline-flex; align-items: center; gap: 8px; flex: 1 1 220px; min-width: 0; }
.am-range .am-rl { color: var(--dim, #a3abba); font-size: 12px; font-weight: 600; min-width: 74px; }
.am-range input { flex: 1; min-width: 80px; accent-color: var(--accent, #7bd88f); }
.am-range output { width: 46px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; color: var(--dim, #a3abba); }
.am-more summary { cursor: pointer; color: var(--dim, #a3abba); font-size: 12px; font-weight: 600; padding: 2px 0; }
.am-more[open] { display: grid; gap: 6px; }
.am-link { border: 0; background: none; color: var(--accent2, #6cc7f5); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 4px 2px; text-decoration: underline; text-underline-offset: 2px; justify-self: start; }
.am-note { color: var(--dim, #a3abba); font-size: 12px; margin: 0; }
.am-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 6px 2px 0; }
.am-head > span { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--faint, #717a8b); margin-right: auto; }
.am-head > small { color: var(--faint, #717a8b); font-size: 11.5px; flex-basis: 100%; }
.am-empty { margin: 0; padding: 12px; border: 1px dashed var(--line2, #333a4a); border-radius: 11px; color: var(--dim, #a3abba); font-size: 12.5px; }
.am-srow { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 12px; background: var(--card, #1b1f28); border: 1px solid var(--line, #262b37); border-radius: 11px; }
.am-srow > b { font-size: 13px; min-width: 130px; }
.am-foot { margin: 4px 2px 0; color: var(--faint, #717a8b); font-size: 11.5px; line-height: 1.45; }
.am-foot b { color: var(--dim, #a3abba); }
.am-select { font: inherit; font-size: 12px; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line2, #333a4a); background: var(--input, #10131a); color: var(--text, #eef1f6); max-width: 100%; min-width: 0; flex: 1 1 160px; }
.am-rm { width: 26px; height: 26px; margin-left: 6px; }
.am-where { margin: 0 2px; font-size: 12px; font-weight: 600; color: var(--ok, #7bd88f); }
.am-where.other { color: var(--warn, #ffb454); }
.am-warn { padding: 8px 12px; border-radius: 10px; background: var(--warn-soft, #ffb45422); color: var(--text, #eef1f6); font-size: 12.5px; }
@media (max-width: 520px) {
  .am-card { width: calc(100vw - 16px); max-height: calc(100vh - 90px); }
  .am-body { padding: 8px 10px 12px; }
  .am-lbl, .am-range .am-rl { min-width: 0; }
  .am-name { max-width: 40%; }
}
`;
