// beta.16 "recemote" lane entry (docs/b16/LANES.md): "Record my own emote from the webcam".
//
//   studio page : plays a recorded emote when the bus command `recorded-emote {name?, loop?}` arrives (a deck key, a rule, a
//                 global key; an empty name = the newest one), registers the rule action of the same name, adds the screen to
//                 Live > Stream extras, and runs the optional "my idle" emote.
//   OBS page    : fetches a clip from the helper the first time a frame names it (player.ts watchOutputEmotes).
//
// Nothing here runs per frame while the feature is idle: the studio side is a bus listener + a one-per-second check that only
// exists once an idle emote is chosen; the OBS side is two property reads per incoming frame.
import type { B16Ctx } from '../../b16/mount.ts';
import { registerB16Panel } from '../../b16/panels.ts';
import { registerRuleAction } from '../../../shared/streamRules.ts';
import { IdleEmote, type IdleHost } from './idle.ts';
import { playRecorded, stopRecordedEmote, watchOutputEmotes, type EmoteHost } from './player.ts';

export const RECORD_EMOTE_COMMAND = 'recorded-emote';

/** The one idle watcher of this studio page (the panel reads and sets it). */
let idleWatcher: IdleEmote | null = null;
export const idleEmote = (): IdleEmote | null => idleWatcher;

export function mount(ctx: B16Ctx): void | (() => void) {
  const undo: (() => void)[] = [];
  if (ctx.role === 'output') {
    undo.push(watchOutputEmotes(ctx.bus as unknown as Parameters<typeof watchOutputEmotes>[0]));
    return () => { for (const u of undo.splice(0)) u(); };
  }
  const app = ctx.app;
  if (!app) return;
  const host = app as unknown as IdleHost & EmoteHost;

  const run = (args: unknown) => {
    const a = (args && typeof args === 'object' ? args : {}) as { name?: unknown; loop?: unknown; stop?: unknown };
    if (a.stop === true) { stopRecordedEmote(host); return Promise.resolve({ ok: true as const }); }
    return playRecorded(host, typeof a.name === 'string' ? a.name : '', { loop: typeof a.loop === 'boolean' ? a.loop : undefined });
  };

  undo.push(ctx.bus.on((m) => {
    if (m.type !== 'command' || m.command !== RECORD_EMOTE_COMMAND) return;
    void run(m.args).then((r) => { if (!r.ok) console.warn('[recorded-emote]', r.error); });
  }));

  undo.push(registerRuleAction(RECORD_EMOTE_COMMAND, async (rc) => {
    const r = await run({ name: String(rc.params.name ?? ''), loop: typeof rc.params.loop === 'boolean' ? rc.params.loop : undefined });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }, {
    label: 'My recorded emote', group: 'Stream extras', icon: '🎞️', where: 'studio',
    params: [{ key: 'name', label: 'Emote name (empty = my newest)', type: 'text', default: '' }],
  }));

  idleWatcher = new IdleEmote(host);
  undo.push(() => { idleWatcher?.destroy(); idleWatcher = null; });

  undo.push(registerB16Panel({
    id: 'record-emote', title: 'Record my own emote', lane: 'recemote', simple: true, order: 40,
    blurb: 'Do a wave once in front of your camera. It becomes an emote you can use anywhere.',
    mount: (el) => {
      let handle: { destroy(): void } | void, dead = false;
      void import('../../ui/recordEmotePanel.ts').then((m) => { if (!dead) handle = m.mountRecordEmotePanel(el, app); });
      return { destroy() { dead = true; if (handle) handle.destroy(); else el.replaceChildren(); } };
    },
  }));

  return () => { for (const u of undo.splice(0).reverse()) { try { u(); } catch { /* best effort */ } } };
}
