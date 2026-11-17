// beta.16 "emoterain" lane entry (docs/b16/LANES.md; docs/b16/EMOTE_RAIN.md).
//   studio  Live > Stream extras > "Emote rain" screen, the bus command `emote-rain` (deck, keys), the rule action
//           `emote-rain`. Writes the stamp; owns no drawing.
//   output  the OBS page / preview: the driver (physics + drawing) listening to chat and the scene state.
// A mount only subscribes and registers: no timers and no canvas until something falls (idle = zero cost).
import type { B16Ctx } from '../../b16/mount.ts';
import { registerB16Panel, type B16PanelHandle } from '../../b16/panels.ts';
import { planRainOp } from '../../../shared/emoteRain.ts';
import { rainCommand, registerRainRuleAction, stampRain } from './studio.ts';

export function mount(ctx: B16Ctx): void | (() => void) {
  if (ctx.role === 'studio') return mountStudio(ctx);
  return mountOutput(ctx);
}

function mountStudio(ctx: B16Ctx): () => void {
  const app = ctx.app;
  if (!app) return () => {};
  const S = app.scene;
  const offRule = registerRainRuleAction(S);
  const offBus = ctx.bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'emote-rain') return;
    const r = rainCommand(S, m.args);
    if (!r.ok) console.info('[emote rain]', r.error);
  });
  const offPanel = registerB16Panel({
    id: 'emote-rain', title: 'Emote rain', lane: 'emoterain', simple: true, order: 30,
    blurb: 'Chat\u2019s emotes fall onto your avatar, bounce off your head and pile up on your shoulders.',
    mount(host: HTMLElement): B16PanelHandle {
      let handle: B16PanelHandle | void, gone = false;
      void import('./panel.ts').then((p) => { if (!gone) handle = p.mountEmoteRainPanel(host, S, (op) => stampRain(S, planRainOp(op)!, { test: true })); });
      return { destroy() { gone = true; handle?.destroy(); } };
    },
  });
  return () => { offRule(); offBus(); offPanel(); };
}

function mountOutput(ctx: B16Ctx): () => void {
  let drv: import('./driver.ts').RainDriver | null = null;
  let offBus: (() => void) | null = null;
  let dead = false;
  let sceneSeen = false;
  // The painter and the driver are loaded now (a few KB); they create no canvas and no timer until something falls.
  void Promise.all([import('./driver.ts'), import('./painter.ts'), import('./anchor.ts'), import('../../api.ts')]).then(([D, P, A, API]) => {
    if (dead) return;
    const d = new D.RainDriver({
      now: () => Date.now(),
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
      rng: Math.random,
      aspect: () => Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight)),
      measure: (aspect) => A.measureAnchor(aspect),
      painter: P.createCanvasPainter(),
    });
    drv = d;
    offBus = ctx.bus.on((m) => { if (m.type === 'scene') sceneSeen = true; d.onBus(m as never); });
    // the first read: the scene state the page would otherwise wait for until the next change
    void API.api.get<unknown>('/api/scene').then((s) => { if (!dead && !sceneSeen) d.onScene(s, undefined); }).catch(() => { /* an older version: the bus message comes */ });
    (window as unknown as { vtpEmoteRain?: unknown }).vtpEmoteRain = { driver: d };
  });
  return () => { dead = true; offBus?.(); drv?.dispose(); drv = null; delete (window as unknown as { vtpEmoteRain?: unknown }).vtpEmoteRain; };
}
