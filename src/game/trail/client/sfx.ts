// The Trail — small sound layer from the CC0 Kenney packs in assets/library/sounds (served by /api/trail/sfx/*).
// Player views only (the spectator / OBS view stays silent). Inside the studio (the game overlay iframe) the sounds go
// through the studio's audio mixer — its "Games" row, in the one window that plays the show's sounds
// (src/audio/mixer/showSounds.ts games()); a standalone player window plays them itself.
import type { TrailEvent } from '../../../../shared/trail/wire.ts';

const MAP: Record<string, string[]> = {
  vote: ['kenney_ui/switch7.ogg'], cast: ['kenney_ui/click3.ogg'], card: ['kenney_ui/switch20.ogg'], insane: ['kenney_impact/impactBell_heavy_000.ogg'],
  death: ['kenney_impact/impactBell_heavy_002.ogg'], good: ['kenney_ui/rollover2.ogg'], bad: ['kenney_impact/impactPunch_medium_001.ogg'],
  impact: ['kenney_impact/impactSoft_heavy_000.ogg', 'kenney_impact/impactSoft_heavy_001.ogg', 'kenney_impact/impactSoft_heavy_002.ogg'],
  splash: ['kenney_impact/impactSoft_medium_000.ogg', 'kenney_impact/impactSoft_medium_001.ogg'], shot: ['kenney_impact/impactPlank_medium_000.ogg', 'kenney_impact/impactPlank_medium_002.ogg'],
  hit: ['kenney_impact/impactPunch_heavy_000.ogg', 'kenney_impact/impactPunch_heavy_002.ogg'], tip: ['kenney_impact/impactWood_heavy_001.ogg'], photo: ['kenney_ui/click1.ogg'],
  dust: ['kenney_impact/impactWood_medium_002.ogg'], crash: ['kenney_impact/impactWood_heavy_000.ogg', 'kenney_impact/impactWood_heavy_002.ogg', 'kenney_impact/impactPlank_medium_003.ogg'],
  load: ['kenney_impact/impactGeneric_light_001.ogg', 'kenney_impact/impactGeneric_light_003.ogg'], emote: ['kenney_ui/click2.ogg'], meme: ['kenney_ui/rollover6.ogg', 'kenney_ui/switch3.ogg'], confetti: ['kenney_ui/rollover5.ogg'], sparkle: ['kenney_ui/rollover3.ogg'], win: ['kenney_impact/impactBell_heavy_004.ogg'], wipe: ['kenney_impact/impactBell_heavy_001.ogg'],
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private bufs = new Map<string, Promise<AudioBuffer | null>>();
  volume = Number(localStorage.getItem('vtp.trail.volume') ?? '0.5');
  enabled = true;
  private last = new Map<string, number>();

  /** The studio's Games row when this page is its game overlay (null = not in the studio). */
  private studio(): { ctx: AudioContext; out: AudioNode } | null | undefined {
    try { const f = window.parent !== window ? (window.parent as unknown as { __vtpGames?: () => { ctx: AudioContext; out: AudioNode } | null }).__vtpGames : undefined; return f ? f() : undefined; } catch { return undefined; }
  }
  private out: AudioNode | null = null;
  private audio(): AudioContext | null {
    if (!this.enabled) return null;
    const st = this.studio();
    if (st !== undefined) { this.out = st?.out ?? null; return st?.ctx ?? null; }   // in the studio: its mixer (or silent here)
    try { this.ctx ??= new AudioContext(); if (this.ctx.state === 'suspended') void this.ctx.resume(); } catch { return null; }
    this.out = this.ctx.destination;
    return this.ctx;
  }
  private load(rel: string): Promise<AudioBuffer | null> {
    let p = this.bufs.get(rel);
    if (!p) {
      const ctx = this.audio();
      p = ctx ? fetch(`/api/trail/sfx/${rel}`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status))))).then((b) => ctx.decodeAudioData(b)).catch(() => null) : Promise.resolve(null);
      this.bufs.set(rel, p);
    }
    return p;
  }
  /** Play a named cue (rate-limited per cue). `gain` 0..1 scales the master volume. */
  play(name: string, gain = 1) {
    const list = MAP[name];
    const ctx = this.audio();
    if (!list || !ctx || this.volume <= 0) return;
    const now = performance.now();
    if (now - (this.last.get(name) ?? 0) < 90) return;
    this.last.set(name, now);
    const rel = list[Math.floor(Math.random() * list.length)];
    void this.load(rel).then((buf) => {
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = 0.92 + Math.random() * 0.16;
      const g = ctx.createGain();
      g.gain.value = this.volume * gain;
      const out = this.audio() === ctx ? this.out : null;
      if (!out) return;
      src.connect(g).connect(out);
      src.start();
    });
  }
  /** Little synthesized cues the sound packs don't have (a frog buzz, a goose honk, a boing, a tiny choir). */
  synth(kind: 'buzz' | 'honk' | 'boing' | 'choir') {
    const ctx = this.audio();
    if (!ctx || this.volume <= 0) return;
    const now = performance.now();
    if (now - (this.last.get(kind) ?? 0) < 250) return;
    this.last.set(kind, now);
    const t = ctx.currentTime, g = ctx.createGain();
    if (!this.out) return;
    g.connect(this.out);
    const tone = (type: OscillatorType, f0: number, f1: number, at: number, dur: number, vol: number) => {
      const o = ctx.createOscillator(), a = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t + at); o.frequency.exponentialRampToValueAtTime(f1, t + at + dur);
      a.gain.setValueAtTime(0.0001, t + at); a.gain.exponentialRampToValueAtTime(vol * this.volume, t + at + 0.02); a.gain.exponentialRampToValueAtTime(0.0001, t + at + dur);
      o.connect(a).connect(g); o.start(t + at); o.stop(t + at + dur + 0.02);
    };
    if (kind === 'buzz') { tone('sawtooth', 190, 120, 0, 0.12, 0.25); tone('sawtooth', 170, 105, 0.15, 0.16, 0.25); }
    else if (kind === 'honk') { tone('square', 420, 380, 0, 0.18, 0.15); tone('square', 400, 330, 0.22, 0.25, 0.15); }
    else if (kind === 'boing') tone('sine', 180, 720, 0, 0.35, 0.3);
    else for (const [i, f] of [262, 330, 392, 523].entries()) tone('triangle', f, f * 1.01, i * 0.02, 1.4, 0.07);
  }
  event(e: TrailEvent) {
    if (e.e === 'toast') { if (e.tone === 'good') this.play('good', 0.5); else if (e.tone === 'bad') this.play('bad', 0.6); }
    else if (e.e === 'death') this.play('death');
    else if (e.e === 'photo') this.play('photo');
    else if (e.e === 'fx') this.play(e.fx === 'launch' ? 'impact' : e.fx === 'fire' ? 'dust' : e.fx, 0.8);
    else if (e.e === 'sound') {
      if (e.s === 'buzz') this.synth('buzz');
      else if (e.s === 'crash' || e.s === 'load') this.play(e.s, 0.8);
      else if (e.s === 'meme') this.synth('honk');
      else if (e.s === 'sing') this.synth('choir');
      else this.play(e.s === 'insane' ? 'insane' : e.s === 'hard' ? 'card' : e.s === 'win' ? 'win' : e.s === 'wipe' ? 'wipe' : e.s === 'death' ? 'death' : 'card', 0.7);
    }
    else if (e.e === 'meme') { if (e.k === 'hop') this.synth('boing'); else if (e.k !== 'sound') this.play('meme', e.tier === 'common' ? 0.5 : 0.9); }
    else if (e.e === 'emote') this.play('emote', 0.4);
  }
}
