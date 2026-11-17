// Emote rain: the Live > Stream extras screen (docs/b16/EMOTE_RAIN.md). Plain words, Simple first: a three-way choice and a
// Try it button; everything else sits under "More". The settings are the host's scene bag (modes.emoterain), so the OBS
// page, the preview and the Stream Deck all see the same thing.
import type { B16PanelHandle } from '../../b16/panels.ts';
import { button, debounce, h, rerender, select, slider, toast, toggle } from '../../ui/dom.ts';
import {
  EMOTE_RAIN_BAG, RAIN_LIMITS, emoteRainJson, sanitizeEmoteRain, type EmoteRainBag, type RainMode,
} from '../../../shared/emoteRain.ts';
import type { RainScene } from './studio.ts';

const MODE_TEXT: Record<RainMode, { label: string; hint: string }> = {
  off: { label: 'Off', hint: 'Nothing falls.' },
  all: { label: 'Every chat emote', hint: 'Each emote your chat sends falls onto your avatar (up to the limit below). A raid also makes it rain.' },
  rules: { label: 'Only when I ask', hint: 'Chat emotes stay in the chat. It rains when a rule, a Stream Deck key or a raid asks for it.' },
};

export function mountEmoteRainPanel(host: HTMLElement, S: RainScene & { on(fn: (what: string) => void): () => void }, tryIt: (op: { op: string; secs: number; from: string }) => { ok: boolean; error?: string }): B16PanelHandle {
  const box = h('div', { class: 'erain' });
  host.append(box);
  const bag = (): EmoteRainBag => sanitizeEmoteRain(S.modeBag(EMOTE_RAIN_BAG));
  const write = (patch: Partial<EmoteRainBag>) => {
    if (S.observer) { toast('This is a read-only preview: nothing was changed', 'warn'); return; }
    S.setModeBag(EMOTE_RAIN_BAG, emoteRainJson({ ...bag(), ...patch }));
  };
  const writeSoon = debounce(write, 350);
  const run = (op: 'burst' | 'start' | 'stop', secs: number) => {
    const r = tryIt({ op, secs, from: 'chat' });
    if (!r.ok) toast(r.error ?? 'Could not start', 'warn');
  };

  const render = () => rerender(box, () => {
    const b = bag();
    const can = S.canEdit && !S.observer;
    const tests = [button('Try it', () => run('burst', 6), 'primary', 'emote-rain-try'), button('Rain for 20 s', () => run('start', 20)), button('Stop', () => run('stop', 1))];
    for (const t of tests) t.disabled = !can;
    if (!S.canEdit) box.append(h('p', { class: 'note' }, 'The host controls emote rain. It shows on the host\u2019s stream.'));
    box.append(
      h('p', { class: 'note' }, 'Chat\u2019s emotes fall onto your avatar, bounce off your head and pile up on your shoulders, then fade. It shows on your OBS page and in the preview.'),
      h('div', { class: 'btns tight', role: 'radiogroup', 'aria-label': 'Emote rain' },
        ...(['off', 'all', 'rules'] as RainMode[]).map((m) => {
          const btn = button(MODE_TEXT[m].label, () => write({ mode: m }), b.mode === m ? 'primary' : '');
          btn.setAttribute('role', 'radio'); btn.setAttribute('aria-checked', String(b.mode === m)); btn.disabled = !can;
          return btn;
        })),
      h('p', { class: 'note' }, MODE_TEXT[b.mode].hint),
      h('div', { class: 'btns tight' }, ...tests),
      h('p', { class: 'note' }, b.mode === 'off' ? 'Try it works even while it is off, so you can see what it looks like.' : 'No chat yet? Try it rains hearts and sparkles instead.'),
    );

    const more = h('details', { class: 'erain-more' }, h('summary', null, 'More'),
      select('Size', b.size, [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], (v) => write({ size: v }), 'How big each emote is'),
      toggle('Pile up on my shoulders', b.pile, (v) => write({ pile: v }), 'Emotes rest on your shoulders for a few seconds. Off: they bounce off your head and fall away.'),
      toggle('Rain when someone raids me', b.raid, (v) => write({ raid: v }), 'A burst of the raiders\u2019 emotes the moment a raid arrives. Needs "Every chat emote" or "Only when I ask".'),
      slider('Most per minute', b.perMin, RAIN_LIMITS.perMin[0], RAIN_LIMITS.perMin[1], 1, (v) => writeSoon({ perMin: Math.round(v) }), 'Keeps a busy chat from burying your avatar', (v) => `${Math.round(v)}`, { def: 30 }),
      select('Where they land', b.where, [['avatar', 'On my avatar (follows my head)'], ['center', 'Middle of the picture'], ['left', 'Left side'], ['right', 'Right side']], (v) => write({ where: v }), 'If your avatar sits in a small window of a layout, pick the side where it is'),
      select('Chat flying past', b.lane, [['off', 'Off'], ['front', 'In front of my avatar'], ['behind', 'Behind my avatar']], (v) => write({ lane: v }), 'New chat lines slide across the picture. Behind needs the see-through OBS background (without a room); in a room they fly in front.'),
      b.lane === 'behind' ? h('p', { class: 'note' }, 'Behind my avatar shows with the see-through background. In a room the room is in the way, so the lines fly in front there.') : null,
      h('p', { class: 'note' }, 'Want it only on a raid, sub or redeem? Choose "Only when I ask", then in Rules add the action "Emote rain".'),
    );
    for (const el of more.querySelectorAll('input, select')) (el as HTMLInputElement).disabled = !can;
    box.append(more,
      h('p', { class: 'note' }, 'It never makes a sound. Chat lines you hide or filter (bots, !commands, Hide chat) never show up, deleted or banned lines take their emotes away, and nothing is saved.'));
  });
  render();
  const off = S.on((what) => { if (what === 'state' && box.isConnected) render(); });
  return { destroy() { off(); box.remove(); } };
}
