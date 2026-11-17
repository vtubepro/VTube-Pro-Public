// beta.16 "bindings" lane entry (docs/b16/LANES.md, docs/b16/BINDINGS.md): Keys & pads. Press a key in your game, tap a MIDI pad,
// push a controller button or make a hand sign, and the avatar reacts. This mount only registers the screen and builds the
// runtime object; nothing listens (no key handler, no MIDI, no controller poll, no timer) until a binding exists.
import type { B16Ctx } from '../b16/mount.ts';
import { registerB16Panel } from '../b16/panels.ts';
import { BindingsRuntime } from './runtime.ts';

export function mount(ctx: B16Ctx): void | (() => void) {
  // OBS pages and observer tabs never act on keys, pads or hands: the performer's own studio does.
  if (ctx.role !== 'studio' || !ctx.app || ctx.app.observer) return;
  const rt = new BindingsRuntime(ctx.app, ctx.bus);
  rt.start();
  const off = registerB16Panel({
    id: 'keys-pads', title: 'Keys & pads', lane: 'bindings', simple: true, order: 20,
    blurb: 'Press a key in your game, tap a MIDI pad, push a controller button or make a hand sign, and your avatar reacts.',
    mount(host) {
      let handle: { destroy(): void } | void;
      let gone = false;
      void import('../ui/bindingsPanel.ts').then((m) => { if (!gone) handle = m.mountBindingsPanel(host, rt); });
      return { destroy() { gone = true; handle?.destroy(); } };
    },
  });
  return () => { off(); rt.stop(); };
}
