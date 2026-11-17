// src/output.ts ⇄ the TTRPG table engine, in one place (so output.ts only gains three lines): follows the page's
// current room (attach / detach by identity), listens to {type:'ttrpg'} on the bus (speech timing, images), measures
// who is speaking on this page (director cuts), and exposes vtpOut.ttrpg. Test pages: &ttrpg=demo[&ttrpgSeed=n]
// [&ttrpgGm=skull|tome|radio|orb|voice|d20|avatar:<id>]. The GM's voice plays on real OBS pages (gm/voicePlayer.ts);
// ?voice=0 silences a page (a 2nd browser source), ?voice=1 lets a test page play it.
import type { SceneRuntime } from '../../scene/SceneRuntime.ts';
import type { Bus } from '../../bus.ts';
import type { TrackingFrame } from '../../../shared/types.ts';
import { sanitizeTtrpgState } from '../../../shared/ttrpg/state.ts';
import { TtrpgScene } from './ttrpgScene.ts';
import { tvOfActor } from '../../scene/tv/tvApi.ts';
import { VoicePlayer } from '../gm/voicePlayer.ts';

export interface TtrpgPerformer { key: string; frame: TrackingFrame; at: number }

export function installTtrpg(o: { bus: Bus; performers: () => TtrpgPerformer[]; testPage: boolean }) {
  const scene = new TtrpgScene();
  const q = new URLSearchParams(location.search);
  if (o.testPage && q.get('ttrpg') === 'demo') { scene.demo = true; scene.demoSeed = parseInt(q.get('ttrpgSeed') || '7', 10) || 7; scene.demoStyle = q.get('ttrpgGm'); }
  const vq = q.get('voice');
  const voice = (o.testPage ? vq === '1' : vq !== '0') ? new VoicePlayer((id, v) => scene.onBus({ k: 'mouth', id, v })) : null;
  o.bus.on((m) => {
    if (m.type !== 'ttrpg' || !m.m || typeof m.m !== 'object') return;
    if (m.m.k === 'play') { if (voice && typeof m.m.url === 'string' && typeof m.m.at === 'number') void voice.play(m.m); return; }
    if (m.m.k === 'hush') { voice?.hush(typeof m.m.id === 'string' ? m.m.id : undefined); return; }
    scene.onBus(m.m);
  });
  const levels = new Map<string, number>();
  scene.speaking = () => {
    const now = performance.now();
    levels.clear();
    for (const p of o.performers()) {
      if (now - p.at > 800) continue;
      const m = p.frame.mouth;
      const vis = p.frame.visemes;
      const v = typeof m?.speak === 'number' ? m.speak : vis ? 1 - (vis.sil ?? 0) : (m?.open ?? 0) > 0.25 ? 0.6 : 0;
      levels.set(p.key, v);
    }
    // TV performers (webcam / VTube Studio guests): their voice level comes from their feed, not tracking frames
    const rt = (window as unknown as { vtpOut?: { scene?: SceneRuntime | null } }).vtpOut?.scene;
    if (rt) for (const a of rt.actors.values()) { const tv = tvOfActor(a); if (tv) levels.set(a.key, Math.max(levels.get(a.key) ?? 0, tv.speaking ? Math.max(0.5, tv.level) : tv.level * 0.5)); }
    return levels;
  };
  let cur: SceneRuntime | null = null;
  (window as unknown as { vtpOut?: Record<string, unknown> }).vtpOut && ((window as unknown as { vtpOut: Record<string, unknown> }).vtpOut.ttrpg = {
    scene, debug: () => ({ ...scene.debug(), voice: voice ? { playing: voice.playing, log: voice.log } : null }),
    /** Test pages: show this table state locally ({...} merged over the demo / defaults), or null to go back. */
    set: (s: unknown) => { if (o.testPage) scene.local = s ? sanitizeTtrpgState(s) : null; },
    bus: (m: unknown) => { if (o.testPage) scene.onBus(m as never); },
  });
  const frame = (rt: SceneRuntime | null, dt: number) => {
    if (rt !== cur) {
      scene.detach(); cur = rt;
      if (rt) {
        scene.attach(rt);
        // test pages: the demo table counts as a table in the room's state too (seating keeps the GM's chair free for
        // an AI GM; &ttrpgGmWho=<member key> makes that member the human GM instead)
        if (scene.demo && o.testPage && rt.info.ttrpg && !rt.state.ttrpg?.on) {
          const who = q.get('ttrpgGmWho');
          rt.setState({ ...rt.state, ttrpg: sanitizeTtrpgState({ on: true, gm: who ? { kind: 'human', who, look: {} } : { kind: 'ai', look: {} } }) });
        }
      }
    }
    if (rt) scene.update(dt);
    voice?.tick();
  };
  // its own frame callback, requested before output.ts starts its render loop (so it runs first in every frame): no
  // edits to the page's render loop; follows the page's current room (vtpOut.scene) by identity
  let last = performance.now();
  const tick = (t: number) => {
    requestAnimationFrame(tick);
    const dt = Math.min(0.1, Math.max(0, (t - last) / 1000)); last = t;
    const out = (window as unknown as { vtpOut?: { scene?: SceneRuntime | null } }).vtpOut;
    frame(out?.scene ?? null, dt);
  };
  requestAnimationFrame(tick);
  return { scene, frame };
}
