// The Trail — the host's simulation Worker: Rapier + TrailSim at a fixed 60 Hz, off the studio's main thread (face
// tracking never waits for physics). Messages in: init / join / leave / input / cmd / voice / chat / sync; out: ctl
// (reliable game messages), state (≤ 10 Hz on change), snap (20 Hz), persist (graves / run end), perf.
import RAPIER from '@dimforge/rapier3d-compat';
import type { Deck, Grave, RoleId } from '../../../../shared/trail/types.ts';
import type { LevelDesc, WagonSpec } from '../../../../shared/trail/levels.ts';
import type { InputFrame, TrailCmd } from '../../../../shared/trail/wire.ts';
import { TrailSim } from './sim.ts';

export type ToWorker =
  | { t: 'init'; deck: Deck; hostId: string; seed?: string; slice: boolean; graves: Grave[]; levels?: Record<string, LevelDesc>; wagon?: WagonSpec; botDrive?: boolean }
  | { t: 'join'; id: string; name: string; height: number; role?: RoleId; host?: boolean; bot?: boolean }
  | { t: 'leave'; id: string } | { t: 'input'; id: string; f: InputFrame } | { t: 'cmd'; id: string; c: TrailCmd }
  | { t: 'voice'; v: Record<string, { vad: number; expr: number }> } | { t: 'chat'; opt: string } | { t: 'sync' } | { t: 'stop' };
export type FromWorker =
  | { t: 'ready' } | { t: 'ctl'; msgs: unknown[] } | { t: 'state'; s: unknown } | { t: 'snap'; snap: unknown } | { t: 'lsnap'; snap: unknown }
  | { t: 'persist'; graves: Grave[]; runEnd: unknown } | { t: 'perf'; stepMs: number; maxStepMs: number; bodies: number } | { t: 'error'; message: string };

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);
let sim: TrailSim | null = null;
let timer = 0;
let acc = 0, last = 0, lastSnap = 0, lastState = 0, lastRev = -1, lastPerf = 0;

function loop() {
  if (!sim) return;
  const now = performance.now();
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  let n = 0;
  while (acc >= 1 / 60 && n < 8) { sim.step(1 / 60); acc -= 1 / 60; n++; }
  const msgs = sim.drain();
  if (msgs.length) post({ t: 'ctl', msgs });
  const st = sim.getState();
  if (st.rev !== lastRev && now - lastState > 100) { lastRev = st.rev; lastState = now; post({ t: 'state', s: st }); }
  // this PC's views: every simulated frame, everything (smooth 60 Hz, no interpolation guesswork); guests: 20 Hz delta
  if (n > 0) post({ t: 'lsnap', snap: sim.snapshot(false) });
  if (now - lastSnap >= 50) { lastSnap = now; post({ t: 'snap', snap: sim.snapshot(true) }); }
  if (sim.persist.graves.length || sim.persist.runEnd) {
    post({ t: 'persist', graves: sim.persist.graves.splice(0), runEnd: sim.persist.runEnd });
    sim.persist.runEnd = null;
  }
  if (now - lastPerf > 2000) { lastPerf = now; post({ t: 'perf', ...sim.perf }); }
}

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'init':
        await RAPIER.init();
        sim = new TrailSim({ deck: m.deck, R: RAPIER, hostId: m.hostId, seed: m.seed, slice: m.slice, graves: m.graves, levels: m.levels, wagon: m.wagon, botDrive: m.botDrive });
        last = performance.now();
        timer = setInterval(loop, 1000 / 120) as unknown as number;
        post({ t: 'ready' });
        break;
      case 'join': sim?.join(m); break;
      case 'leave': sim?.leave(m.id); break;
      case 'input': sim?.input(m.id, m.f); break;
      case 'cmd': sim?.cmd(m.id, m.c); break;
      case 'voice': sim?.setVoice(m.v); break;
      case 'chat': sim?.chatVote(m.opt); break;
      case 'sync': if (sim) post({ t: 'ctl', msgs: [sim.levelMsg()] }), post({ t: 'state', s: sim.getState() }); break;
      case 'stop': clearInterval(timer); sim?.phys.dispose(); sim = null; break;
    }
  } catch (err) { post({ t: 'error', message: (err as Error).message }); }
};
