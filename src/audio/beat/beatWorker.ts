// Beat analysis worker: runs the music analysis (beatAnalyzer.ts: BeatEngine v8 + the voice gate + the arranger) OFF
// the studio's main thread — its tempo search costs a few ms every 500 ms, which must not jitter the face tracker.
//
// in : { type:'hops', t0, hopMs, nBands, hops, streamId, now }   (worklet hop batch, relayed by beatInput.ts;
//                                                                 now = epoch ms when the main thread got it)
//      { type:'voice', v }                                        the lip-sync mic's voice activity 0..1 (-1 = none)
//      { type:'reset' }
// out: { type:'packet', b: BeatPacket }   ~30 Hz + immediately on kick / snare / drop / downbeat
//      { type:'meter', … }                ~15 Hz for the Scene tab meter
import { AudioHopClock } from './beatEngine.ts';
import { BeatAnalyzer } from './beatAnalyzer.ts';
import { EV_DOWN, EV_DROP, EV_KICK, EV_SNARE } from '../../../shared/lightShow.ts';

interface HopMsg { type: 'hops'; t0: number; hopMs: number; nBands: number; hops: number[]; streamId: string; now: number }

// engine time = epoch ms − base (small numbers; the engine's sentinels / modulo maths were tuned on page-clock ms)
const base = Date.now() - 1000;
let an = new BeatAnalyzer();
let clock = new AudioHopClock();
let lastHopEpoch = 0;
let lastSent = 0, lastMeter = 0;
const post = (m: unknown) => (self as unknown as Worker).postMessage(m);

function onHops(m: HopMsg) {
  const now = m.now - base;
  const mapped = clock.map(m, now);
  if (!mapped) return;
  if (mapped.reset) an.resetInput(mapped.first);
  lastHopEpoch = m.now;
  const n = m.nBands, count = Math.floor(m.hops.length / n);
  for (let i = 0; i < count; i++) an.pushHop(mapped.first + i * m.hopMs, m.hops.slice(i * n, i * n + n));
  const urgent = an.ev & (EV_KICK | EV_SNARE | EV_DROP | EV_DOWN);
  if (urgent || an.lastT - lastSent >= 33) { post({ type: 'packet', b: an.packet(base) }); lastSent = an.lastT; }
  if (an.lastT - lastMeter >= 66 && an.last) { lastMeter = an.lastT; post({ type: 'meter', ...an.meter() }); }
}

// no hops (capture stopped / muted device): tell the OBS pages twice a second that the music is gone
setInterval(() => {
  if (!an.last) return;
  if (Date.now() - lastHopEpoch > 400) {
    const t = Date.now() - base;
    const p = an.packet(base, an.engine.peek(t), t);
    post({ type: 'packet', b: { ...p, on: false, md: 0 } });
    post({ type: 'meter', on: false, bpm: 0, locked: false, conf: 0, grid: 'no audio', section: 'listening', bands: [0, 0, 0, 0, 0, 0], kick: 0, snare: 0, hat: 0, energy: 0, beat: 0, mode: 'silence', music: 0, talk: 0, kp: 0, phraseBeat: 0 });
  }
}, 500);

self.onmessage = (e: MessageEvent) => {
  const m = e.data as HopMsg | { type: 'reset' } | { type: 'voice'; v: number };
  if (m.type === 'hops') onHops(m);
  else if (m.type === 'voice') an.micVoice(m.v, Date.now() - base);
  else if (m.type === 'reset') { an = new BeatAnalyzer(); clock = new AudioHopClock(); }
};
