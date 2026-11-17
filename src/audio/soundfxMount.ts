// beta.16 "soundfx" lane entry (docs/b16/LANES.md, docs/b16/SOUNDFX.md): Soundboard stings + screen FX presets.
//
//   every page (studio + OBS)  bus command `screen-fx` -> src/stage/post/fxPresets.ts (glitch / VHS / pixelate / shake / glow pop / B&W)
//   the studio only            bus command `sfx` -> a sting out of the show's output (src/audio/soundboard.ts); cues ("when this emote /
//                              outfit / redeem happens, play this"); the scream detector (emits the `loud` rule trigger); the rule
//                              actions `sfx` and `screen-fx`; the "Sounds & screen effects" panel in Live > Stream extras.
//
// Idle = zero cost: a mount only subscribes and registers. The mic is sampled (every 60 ms) only while the scream detector is
// switched on and the mic is open; the panel's code is loaded when it is opened; sounds are OFF until the streamer turns them on.
import type { B16Ctx } from '../b16/mount.ts';
import { registerB16Panel } from '../b16/panels.ts';
import { emitRuleTrigger, onRuleTrigger, registerRuleAction, ruleEventsFromChat, RULE_TRIGGER_COMMAND, sanitizeRuleEvent, type RuleEvent } from '../../shared/streamRules.ts';
import { ACTION_BY_ID } from '../../shared/deck.ts';
import {
  DEFAULT_SOUNDBOARD, LoudDetector, cueTriggerOf, loudRuleEvent, sanitizeScreenFxArgs, sanitizeSfxArgs, sanitizeSoundboardCfg, soundKind, synthSting,
  type FxPresetId, type SoundInfo, type SoundboardCfg,
} from '../../shared/soundboard.ts';
import { screenFx, type FxStartResult } from '../stage/post/fxPresets.ts';
import { CueRunner, SoundboardPlayer, testStartAt, type BoardCtx, type BoardDeps, type PlayVerdict, type SynthFn } from './soundboard.ts';
import { studioShow } from './mixer/showSounds.ts';
import { emoteSoundSource } from './mixer/emoteSynth.ts';
import type { App } from '../app.ts';
import type { BusMessage } from '../../shared/types.ts';

export type HelperState = 'ok' | 'down' | 'loading';
export interface SoundfxApi {
  /** An observer tab: read-only, plays nothing. */
  readonly observer: boolean;
  readonly helper: HelperState;
  cfg(): SoundboardCfg;
  sounds(): SoundInfo[];
  /** Read the settings and sounds from VTube Pro's server. */
  load(): Promise<void>;
  /** Save a change (the whole config); the player and the detector pick it up at once. Rejects with a plain message. */
  save(next: SoundboardCfg): Promise<void>;
  upload(file: File): Promise<string>;
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  /** Play a sound out through the stream (what a Stream Deck key does). */
  play(id: string): Promise<PlayVerdict>;
  /** Hear it on the "Only me" output only (never the stream). */
  test(id: string): { ok: boolean; why: string };
  /** Start a screen effect here and on every OBS page. */
  fireFx(preset: FxPresetId, secs: number): FxStartResult;
  /** How this page showed that effect (shader, the light CSS version, or not at all). null = not known yet. */
  fxVia(p: FxPresetId): 'shader' | 'css' | 'none' | null;
  /** The mic level 0..1 (null = no mic open). */
  level(): number | null;
  outfits(): { id: string; name: string }[];
  /** The flash-safety limit is on. */
  flashSafe(): boolean;
  onChange(fn: () => void): () => void;
}
let current: SoundfxApi | null = null;
/** The studio's Soundboard (null until the studio mounted it, and on OBS pages). */
export const soundfxApi = (): SoundfxApi | null => current;

const jerr = async (r: Response): Promise<never> => { let m = `Something went wrong (${r.status})`; try { m = (await r.json()).error ?? m; } catch { /* not json */ } throw new Error(m); };

function browserDeps(getCfg: () => SoundboardCfg): BoardDeps {
  return {
    out: () => { const g = studioShow()?.games() ?? null; return g ? { ctx: g.ctx as unknown as BoardCtx, node: g.out } : null; },
    cfg: getCfg,
    load: async (id) => { try { const r = await fetch(`/api/soundboard/file/${encodeURIComponent(id)}`); return r.ok ? await r.arrayBuffer() : null; } catch { return null; } },
    synth: (name) => (name ? (emoteSoundSource(`b:${name}`).synth as SynthFn | undefined) ?? null : null),
    now: () => performance.now(),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Test plays on the mixer's "Only me" output (your headphones); on "Same as the studio" a desktop capture would hear it too. */
function onlyMe(): { ok: boolean; why: string } {
  const sh = studioShow();
  if (!sh) return { ok: false, why: 'Test plays in the studio window: open the studio (not a pop-out).' };
  if (!sh.sinkOk) return { ok: false, why: 'This browser can’t pick a separate output, so a test would reach your stream too.' };
  if (!sh.meSink) return { ok: false, why: 'To hear it without your stream hearing it, pick your headphones as the “Only me” output (Audio mixer → Only me).' };
  if (sh.meFellBack) return { ok: false, why: 'Your “Only me” output isn’t available (unplugged?). Plug it back in or pick another in the Audio mixer.' };
  return { ok: true, why: 'Plays only on your “Only me” output (your headphones), never on your stream.' };
}

export function mount(ctx: B16Ctx): void | (() => void) {
  const undo: (() => void)[] = [];
  const bus = ctx.bus;
  const send = (command: string, args: unknown) => bus.send({ type: 'command', command, args } as BusMessage);
  const fire = (preset: FxPresetId, secs: number): FxStartResult => screenFx.start(preset, secs);

  // every page: a screen effect (the studio's preview and each OBS page run it on their own clock; it is short)
  undo.push(bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'screen-fx') return;
    const a = sanitizeScreenFxArgs(m.args);
    if (a) fire(a.preset, a.secs);
  }));
  if (ctx.role !== 'studio' || !ctx.app) return () => { for (const u of undo.splice(0).reverse()) u(); };

  const app: App = ctx.app;
  const observer = !!app.observer;

  // ---------------------------------------------------------------- state
  let cfg: SoundboardCfg = sanitizeSoundboardCfg(DEFAULT_SOUNDBOARD);
  let sounds: SoundInfo[] = [];
  let helper: HelperState = 'loading';
  const watchers = new Set<() => void>();
  const changed = () => { for (const w of [...watchers]) { try { w(); } catch { /* listener */ } } };
  const player = new SoundboardPlayer(browserDeps(() => cfg));
  const cues = new CueRunner({
    cfg: () => cfg,
    playSound: (id, vol) => { if (!observer) void player.play(id, vol); },
    fireFx: (p, s) => { fire(p, s); send('screen-fx', { preset: p, secs: s }); },
  });

  // ---------------------------------------------------------------- the scream detector
  const loud = new LoudDetector();
  let micT = 0;
  const micLevel = (): number | null => (app.audio.active ? app.audio.last.level : null);
  const applyCfg = () => {
    loud.configure(cfg.scream);
    const want = cfg.scream.on && !observer;
    if (want && !micT) {
      loud.reset();
      micT = window.setInterval(() => {
        const l = micLevel();
        if (l === null) return;
        const hit = loud.feed(l, performance.now());
        if (!hit) return;
        const now = Date.now();
        cues.scream();
        emitRuleTrigger(loudRuleEvent(hit.level, hit.ms, now), now);
      }, 60);
    } else if (!want && micT) { clearInterval(micT); micT = 0; }
    if (!cfg.on) player.stopAll();
    changed();
  };
  undo.push(() => { if (micT) clearInterval(micT); micT = 0; });

  // ---------------------------------------------------------------- talking to the server
  const api: SoundfxApi = {
    observer,
    get helper() { return helper; },
    cfg: () => cfg,
    sounds: () => sounds,
    async load() {
      try {
        const r = await fetch('/api/soundboard', { cache: 'no-store' });
        if (!r.ok) { helper = 'down'; changed(); return; }
        const j = await r.json() as { cfg: unknown; sounds: SoundInfo[] };
        cfg = sanitizeSoundboardCfg(j.cfg); sounds = Array.isArray(j.sounds) ? j.sounds : []; helper = 'ok';
        applyCfg();
      } catch { helper = 'down'; changed(); }
    },
    async save(next) {
      if (observer) throw new Error('This is a read-only tab: nothing is saved here.');
      const clean = sanitizeSoundboardCfg(next);
      const before = cfg;
      cfg = clean; applyCfg();                                   // (the screen answers at once; the server confirms below)
      try {
        const r = await fetch('/api/soundboard', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clean) });
        if (!r.ok) await jerr(r);
        const j = await r.json() as { cfg: unknown; sounds: SoundInfo[] };
        cfg = sanitizeSoundboardCfg(j.cfg); sounds = j.sounds ?? sounds; applyCfg();
      } catch (e) { cfg = before; applyCfg(); throw e; }
    },
    async upload(file) {
      if (observer) throw new Error('This is a read-only tab: nothing is saved here.');
      const r = await fetch(`/api/soundboard/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      if (!r.ok) await jerr(r);
      const j = await r.json() as { cfg: unknown; sounds: SoundInfo[]; added: string };
      cfg = sanitizeSoundboardCfg(j.cfg); sounds = j.sounds; changed();
      return j.added;
    },
    async remove(id) {
      const r = await fetch(`/api/soundboard/file/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!r.ok) await jerr(r);
      const j = await r.json() as { cfg: unknown; sounds: SoundInfo[] };
      player.forget(id); cfg = sanitizeSoundboardCfg(j.cfg); sounds = j.sounds; applyCfg();
    },
    async rename(id, name) {
      const r = await fetch(`/api/soundboard/sound/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      if (!r.ok) await jerr(r);
      const j = await r.json() as { cfg: unknown; sounds: SoundInfo[] };
      sounds = j.sounds; changed();
    },
    play: (id) => (observer ? Promise.resolve('nolead' as PlayVerdict) : player.play(id, 1)),
    test(id) {
      const o = onlyMe();
      if (!o.ok || observer) return o.ok ? { ok: false, why: 'This is a read-only tab: no sound.' } : o;
      const sh = studioShow()!;
      const syn = synthSting(id);
      if (syn) sh.onShowSound(`sbtest:${Date.now().toString(36)}`, { k: 'emote', snd: `b:${syn.synth}`, gain: 1, only: true });
      else if (soundKind(id)) sh.playLine(`/api/soundboard/file/${encodeURIComponent(id)}`, testStartAt(Date.now()), true);
      return o;
    },
    fireFx(preset, secs) { const r = fire(preset, secs); if (r === 'started') send('screen-fx', { preset, secs }); return r; },
    fxVia: (p) => screenFx.viaOf(p),
    level: micLevel,
    outfits: () => (app.profile?.costumes ?? []).filter((c) => c.kind !== 'accessory').map((c) => ({ id: c.id, name: c.name })),
    flashSafe: () => screenFx.timeline.safe,
    onChange(fn) { watchers.add(fn); return () => { watchers.delete(fn); }; },
  };
  current = api;
  undo.push(() => { if (current === api) current = null; watchers.clear(); });
  void api.load();

  // ---------------------------------------------------------------- bus commands
  undo.push(bus.on((m) => {
    if (m.type !== 'command') return;
    if (m.command === 'sfx') {
      const a = sanitizeSfxArgs(m.args);
      if (a && !observer) void player.play(a.id, a.volume / 100);
    } else if (m.command === RULE_TRIGGER_COMMAND) {
      const e = sanitizeRuleEvent(m.args);
      if (e) onRuleEvent(e);
    }
  }));

  // redeems: from the rules (this process or forwarded over the bus) and straight from the chat line
  const onRuleEvent = (e: RuleEvent) => {
    if (e.test) return;
    const t = cueTriggerOf(e);
    if (t) cues.trigger(t, e.id);
  };
  undo.push(onRuleTrigger(onRuleEvent));
  undo.push(bus.on((m) => {
    if (m.type !== 'chat' || m.snap || m.origin === 'party') return;
    for (const ev of m.evs) {
      if (ev.test || Date.now() - ev.ts > 30_000) continue;
      for (const re of ruleEventsFromChat(ev)) onRuleEvent(re);
    }
  }));

  // emotes and outfits: the studio's own start (a button, a key, the Stream Deck, a rule, a chat command) all end in these two
  const playEmote = app.playEmote;
  app.playEmote = function (this: App, name: string, loop?: boolean) {
    const ok = playEmote.call(this, name, loop);
    if (ok) cues.trigger({ kind: 'emote', name });
    return ok;
  };
  const setCostume = app.setCostume;
  app.setCostume = async function (this: App, id: string | null) {
    const before = this.profile?.costume ?? null;
    await setCostume.call(this, id);
    if (id !== null && (this.profile?.costume ?? null) === id && before !== id) cues.trigger({ kind: 'outfit', id });
  };
  undo.push(() => { if (app.playEmote !== playEmote) app.playEmote = playEmote; if (app.setCostume !== setCostume) app.setCostume = setCostume; });

  // ---------------------------------------------------------------- rule actions
  const meta = (id: string, sound: boolean) => { const d = ACTION_BY_ID.get(id); return { label: d?.label ?? id, group: d?.group ?? 'Stream extras', icon: d?.icon, params: d?.params, where: 'studio' as const, sound }; };
  undo.push(registerRuleAction('sfx', ({ params }) => {
    const a = sanitizeSfxArgs({ id: params.id, volume: Number(params.volume ?? 70) });
    if (!a) return { ok: false, error: 'Pick a sound first' };
    if (!observer) void player.play(a.id, a.volume / 100);
    return { ok: true };
  }, meta('sfx', true)));
  undo.push(registerRuleAction('screen-fx', ({ params }) => {
    const a = sanitizeScreenFxArgs({ preset: params.preset, secs: Number(params.secs ?? 3) });
    if (!a) return { ok: false, error: 'Pick an effect first' };
    api.fireFx(a.preset, a.secs);
    return { ok: true };
  }, meta('screen-fx', false)));

  // ---------------------------------------------------------------- the panel
  undo.push(registerB16Panel({
    id: 'soundfx', title: 'Sounds & screen effects', lane: 'soundfx', simple: true, order: 40,
    blurb: 'Play a sting, or fire a glitch / VHS / pixelate burst, when an emote, an outfit, a redeem or a scream happens.',
    mount(host) {
      let off: (() => void) | undefined;
      let gone = false;
      void import('../ui/soundboardPanel.ts').then((m) => { if (!gone) off = m.drawSoundboard(host, api); });
      return { destroy() { gone = true; off?.(); } };
    },
  }));
  return () => { for (const u of undo.splice(0).reverse()) { try { u(); } catch { /* best effort */ } } };
}
