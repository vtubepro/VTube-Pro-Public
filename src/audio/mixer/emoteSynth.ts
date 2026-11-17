// Emote sounds' built-ins (shared/emoteSounds.ts BUILTIN_EMOTE_SOUNDS) in the studio: short synthesised effects (no
// file to load) or the CC0 Kenney sounds the Trail's route serves (assets/library/sounds); the streamer's own sounds come
// from the helper (/api/chat/emote-sounds/file/<id>). Played by src/audio/mixer/showSounds.ts into the Room sounds row
// (or the Only-me output for the panel's Test button). Never on an OBS page.
import { BUILTIN_EMOTE_SOUNDS } from '../../../shared/emoteSounds.ts';

type Synth = (ac: AudioContext, dest: AudioNode, gain: number) => { stop(): void };

/** One oscillator note with an attack / decay envelope. */
function note(ac: AudioContext, out: AudioNode, o: { type: OscillatorType; f0: number; f1?: number; at: number; dur: number; vol: number }) {
  const osc = ac.createOscillator(), g = ac.createGain();
  osc.type = o.type; osc.frequency.setValueAtTime(o.f0, o.at);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, o.at + o.dur);
  g.gain.setValueAtTime(0, o.at); g.gain.linearRampToValueAtTime(o.vol, o.at + 0.01); g.gain.exponentialRampToValueAtTime(0.0008, o.at + o.dur);
  osc.connect(g).connect(out); osc.start(o.at); osc.stop(o.at + o.dur + 0.05);
}
const bus = (ac: AudioContext, dest: AudioNode, gain: number) => { const out = ac.createGain(); out.gain.value = Math.max(0, Math.min(1.5, gain)); out.connect(dest); return out; };
const stopper = (out: AudioNode) => ({ stop: () => { try { out.disconnect(); } catch { /* gone */ } } });

const SYNTH: Record<string, Synth> = {
  horn: (ac, d, g) => {
    const out = bus(ac, d, g * 0.16), t = ac.currentTime + 0.02;
    for (const off of [0, 0.26]) for (const f of [440, 443, 554, 660]) note(ac, out, { type: 'sawtooth', f0: f, at: t + off, dur: 0.22, vol: 0.25 });
    return stopper(out);
  },
  siren: (ac, d, g) => {
    const out = bus(ac, d, g * 0.12), t = ac.currentTime + 0.02;
    const osc = ac.createOscillator(), env = ac.createGain();
    osc.type = 'square'; osc.frequency.setValueAtTime(600, t);
    for (let i = 0; i < 3; i++) { osc.frequency.linearRampToValueAtTime(1100, t + i * 0.4 + 0.2); osc.frequency.linearRampToValueAtTime(600, t + i * 0.4 + 0.4); }
    env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.3, t + 0.03); env.gain.setValueAtTime(0.3, t + 1.1); env.gain.linearRampToValueAtTime(0, t + 1.2);
    osc.connect(env).connect(out); osc.start(t); osc.stop(t + 1.25);
    return stopper(out);
  },
  ding: (ac, d, g) => { const out = bus(ac, d, g * 0.35), t = ac.currentTime + 0.02; note(ac, out, { type: 'sine', f0: 1318.5, at: t, dur: 0.9, vol: 0.5 }); note(ac, out, { type: 'sine', f0: 2637, at: t, dur: 0.5, vol: 0.12 }); return stopper(out); },
  coin: (ac, d, g) => { const out = bus(ac, d, g * 0.22), t = ac.currentTime + 0.02; note(ac, out, { type: 'square', f0: 988, at: t, dur: 0.08, vol: 0.3 }); note(ac, out, { type: 'square', f0: 1319, at: t + 0.08, dur: 0.35, vol: 0.3 }); return stopper(out); },
  boing: (ac, d, g) => { const out = bus(ac, d, g * 0.35), t = ac.currentTime + 0.02; note(ac, out, { type: 'sine', f0: 140, f1: 520, at: t, dur: 0.45, vol: 0.6 }); return stopper(out); },
  laser: (ac, d, g) => { const out = bus(ac, d, g * 0.2), t = ac.currentTime + 0.02; note(ac, out, { type: 'sawtooth', f0: 1800, f1: 120, at: t, dur: 0.3, vol: 0.4 }); return stopper(out); },
  pop: (ac, d, g) => { const out = bus(ac, d, g * 0.4), t = ac.currentTime + 0.02; note(ac, out, { type: 'sine', f0: 400, f1: 1400, at: t, dur: 0.07, vol: 0.7 }); return stopper(out); },
  tada: (ac, d, g) => {
    const out = bus(ac, d, g * 0.2), t = ac.currentTime + 0.02;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => note(ac, out, { type: 'triangle', f0: f, at: t + i * 0.07, dur: i === 3 ? 0.8 : 0.3, vol: 0.4 }));
    return stopper(out);
  },
};

/** How to play a sound reference ("b:<id>" built-in, "u:<id>" the streamer's own). */
export function emoteSoundSource(snd: string): { synth?: Synth; url?: string } {
  if (snd.startsWith('u:') && /^u:[a-f0-9]{16}$/.test(snd)) return { url: `/api/chat/emote-sounds/file/${snd.slice(2)}` };
  const id = snd.slice(2);
  if (SYNTH[id]) return { synth: SYNTH[id] };
  const b = BUILTIN_EMOTE_SOUNDS.find((x) => x.id === id);
  return b?.file ? { url: `/api/trail/sfx/${b.file}` } : {};
}
