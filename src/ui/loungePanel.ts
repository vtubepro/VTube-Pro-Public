// Scene tab → 🥂 Lounge events (rooms whose scene.json has a `lounge` key, e.g. hangout_lounge: bar / patio / main):
// on / calm / banner / light-show cues / room-wide, which support counts (gifted subs, subs, raids), the tier lines
// (USD for donations, a count for gifted subs, the gift-train size) and Test buttons. Everything lives in the host's
// stage-mode bag SceneState.modes.lounge (shared/lounge.ts), so every OBS page — the host's and every party guest's —
// celebrates the same supporter the same way. Observer studios: the edits only reach this tab's preview.
// Bus / Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"lounge","args":{"event":"t3"}}
// (event: t1…t5 | gift | train | sub | raid (+ "n": gifts, "user") | calm | toggle | on | off; or settings: on / calm /
// banner / lights / roomWide booleans). Stream Deck action "Lounge celebration"; Ctrl+K: "lounge tier 4", "gift train 25".
import type { App } from '../app.ts';
import type { SceneController } from '../scene/controller.ts';
import {
  DEFAULT_LOUNGE_GIFTS, DEFAULT_LOUNGE_MONEY, DEFAULT_LOUNGE_TRAIN, LOUNGE_BAG, LOUNGE_LEAD, LOUNGE_TIER_HELP, LOUNGE_TIER_LABELS, loungeLines, loungeZoneOf, sanitizeLounge,
  type LoungeBag, type LoungeSource, type RoomLoungeConfig,
} from '../../shared/lounge.ts';
import { button, h, rerender, section, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
const bagOf = (S: SceneController): LoungeBag => sanitizeLounge((S as unknown as BagApi).modeBag(LOUNGE_BAG));
function setBag(S: SceneController, fn: (b: LoungeBag) => void) {
  const b = structuredClone(bagOf(S));
  fn(b);
  (S as unknown as BagApi).setModeBag(LOUNGE_BAG, sanitizeLounge(b));
}
/** the current room's (area's) scene.json `lounge` + its area (null = not a lounge room) */
function roomCfg(S: SceneController): { cfg: RoomLoungeConfig; area?: string; label?: string } | null {
  const id = S.effective.sceneId;
  const info = id ? (S.scenes.find((x) => x.id === id) as unknown as { lounge?: RoomLoungeConfig; area?: string; areaList?: { key: string; label: string }[] } | undefined) : undefined;
  if (!info?.lounge || typeof info.lounge !== 'object' || info.lounge.on === false) return null;
  return { cfg: info.lounge, area: info.area, label: info.areaList?.find((a) => a.key === info.area)?.label };
}

/** Stamp a test / remote celebration (host only). It plays on every page `LOUNGE_LEAD` ms from now. */
export function loungeEvent(S: SceneController, src: LoungeSource, o: { usd?: number; n?: number; user?: string; tier?: number } = {}): boolean {
  if (!S.canEdit) { toast('Only the host runs the lounge', 'warn'); return false; }
  const rc = roomCfg(S);
  if (!rc) { toast('Lounge events need a lounge room (e.g. the Hangout Lounge)', 'warn'); return false; }
  const bag = bagOf(S), L = loungeLines(bag, rc.cfg);
  const now = Date.now();
  const usd = src === 'money' ? (o.usd ?? L.money[Math.min(5, Math.max(1, o.tier ?? 3)) - 1]) : 0;
  const n = src === 'gift' ? Math.max(1, Math.round(o.n ?? 5)) : src === 'raid' ? 42 : src === 'sub' ? 1 : 0;
  const user = (o.user || 'Test Supporter').slice(0, 32);
  const amount = src === 'money' ? `$${usd.toFixed(2)}` : src === 'gift' ? `${n} sub${n === 1 ? '' : 's'}` : '';
  const seed = ((now * 2654435761) >>> 0) % 2147483646 + 1;
  setBag(S, (b) => {
    const seq = (b.evs[b.evs.length - 1]?.seq ?? 0) + 1;
    b.evs = [...b.evs.filter((e) => e.at > now - 10 * 60_000), { seq, at: now + LOUNGE_LEAD, src, usd, n, seed, user, ...(amount ? { amount } : {}) }].slice(-6);
  });
  toast(`🥂 ${src === 'money' ? `$${usd} donation` : src === 'gift' ? `${n} gifted subs` : src} — ${user}`, 'ok', 1600);
  return true;
}

/** Bus / Stream Deck / Ctrl+K: {command:'scene', args:{lounge:{event?, n?, user?, on?, calm?, banner?, lights?, roomWide?}} */
export function loungeCommand(S: SceneController, a: Record<string, unknown>) {
  if (!S.canEdit) return;
  const flags = ['on', 'calm', 'banner', 'lights', 'roomWide'] as const;
  if (flags.some((k) => typeof a[k] === 'boolean')) setBag(S, (b) => { for (const k of flags) if (typeof a[k] === 'boolean') b[k] = a[k] as boolean; });
  const ev = typeof a.event === 'string' ? a.event : '';
  const user = typeof a.user === 'string' ? a.user : undefined;
  const n = typeof a.n === 'number' && Number.isFinite(a.n) ? a.n : undefined;
  const m = /^t([1-5])$/.exec(ev);
  if (m) loungeEvent(S, 'money', { tier: +m[1], user });
  else if (ev === 'gift') loungeEvent(S, 'gift', { n: n ?? 5, user });
  else if (ev === 'train') { const L = loungeLines(bagOf(S), roomCfg(S)?.cfg); loungeEvent(S, 'gift', { n: Math.max(n ?? 20, L.trainMin), user }); }
  else if (ev === 'sub' || ev === 'raid') loungeEvent(S, ev, { user });
  else if (ev === 'calm') { const v = !bagOf(S).calm; setBag(S, (b) => { b.calm = v; }); toast(`Lounge calm ${v ? 'on' : 'off'}`, 'ok', 1400); }
  else if (ev === 'toggle' || ev === 'on' || ev === 'off') { const v = ev === 'toggle' ? !bagOf(S).on : ev === 'on'; setBag(S, (b) => { b.on = v; }); toast(`Lounge events ${v ? 'on' : 'off'}`, 'ok', 1400); }
}

/** Scene tab section (keeps itself up to date; hidden outside lounge rooms). */
export function loungeSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const wrap = section('🥂 Lounge events', box);
  const render = () => rerender(box, () => {
    const rc = roomCfg(S);
    wrap.style.display = rc ? '' : 'none';
    if (!rc) return;
    if (!S.canEdit) { box.append(h('p', { class: 'note' }, 'The host runs the lounge — your OBS shows the same celebrations.')); return; }
    const bag = bagOf(S), L = loungeLines(bag, rc.cfg);
    const zone = loungeZoneOf(rc.cfg, rc.area, rc.label);
    const ladder = (which: 'money' | 'gifts', i: number) => h('input', {
      type: 'number', min: which === 'money' ? 0 : 1, step: 1, value: L[which][i], style: 'width:100%;min-width:0', title: `Tier ${i + 1} (${LOUNGE_TIER_LABELS[(i + 1) as 1]}): ${LOUNGE_TIER_HELP[zone][(i + 1) as 1]}`,
      placeholder: String((which === 'money' ? DEFAULT_LOUNGE_MONEY : DEFAULT_LOUNGE_GIFTS)[i]),
      onChange: (e: Event) => { const v = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0); setBag(S, (b) => { const arr = [...loungeLines(b, rc.cfg)[which]]; arr[i] = v; b[which] = arr; }); },
    });
    const zoneName = { bar: 'the bar', patio: 'the patio', main: 'the lounge' }[zone];
    box.append(
      h('p', { class: 'note' }, `Donations and gifted subs set off celebrations in ${zoneName} (the area you are in). Bigger ones add more; the same supporter is thanked the same way on every OBS page.`),
      toggle('Lounge events', bag.on, (v) => setBag(S, (b) => { b.on = v; }), 'Off = nothing plays (chat alerts and the Chat Hub still work)'),
      toggle('Calm', bag.calm, (v) => setBag(S, (b) => { b.calm = v; }), 'Small acknowledgements only (tier 2 at most), no light-show hits, no fireworks flashes, no gift trains — for serious moments. The banner still thanks them.'),
      toggle('Supporter banner', bag.banner, (v) => setBag(S, (b) => { b.banner = v; }), 'A gold card with the name and amount in a free corner of the frame (never over a face or the React screen)'),
      toggle('Light-show hits', bag.lights, (v) => setBag(S, (b) => { b.lights = v; }), 'Ask the light show for a celebration cue (never in React mode or calm; photosensitivity-safe)'),
      toggle('Big ones go room-wide', bag.roomWide, (v) => setBag(S, (b) => { b.roomWide = v; }), 'Tier 4+ also plays the other areas’ signatures where this camera can see them (fireworks over the patio through the glass, the bottle wall …)'),
      h('h4', { style: 'margin:10px 0 4px' }, 'What counts'),
      toggle('Donations', bag.support.on, (v) => setBag(S, (b) => { b.support.on = v; }), 'Tips, Super Chats, Rants, bits, Kicks, Jewels, TikTok gifts (their USD value)'),
      toggle('Gifted subs', bag.support.gifts, (v) => setBag(S, (b) => { b.support.gifts = v; }), 'Gifted subs / memberships, by count: N shots / balloons / rockets'),
      toggle('New subs', bag.support.subs, (v) => setBag(S, (b) => { b.support.subs = v; }), 'A new sub / resub / membership = tier 1'),
      toggle('Raids', bag.support.raids, (v) => setBag(S, (b) => { b.support.raids = v; }), 'An incoming raid = tier 3'),
      h('h4', { style: 'margin:10px 0 4px' }, 'Tiers'),
      h('div', { style: 'display:grid;grid-template-columns:auto 4.4em 4.4em 1fr;gap:4px 8px;align-items:center;font-size:12px;margin-bottom:6px' },
        h('span', null, ''), h('span', { class: 'note', title: 'One donation worth at least this much (USD value) reaches the tier. Tiers add up.' }, 'From $'),
        h('span', { class: 'note', title: 'Gifted subs in one go (a burst from one gifter adds up).' }, 'Or gifts'), h('span', { class: 'note' }, `What happens in ${zoneName}`),
        ...([1, 2, 3, 4, 5] as const).flatMap((k) => [h('b', { title: LOUNGE_TIER_LABELS[k] }, `T${k}`), ladder('money', k - 1), ladder('gifts', k - 1), h('span', { style: 'opacity:.8;line-height:1.25' }, LOUNGE_TIER_HELP[zone][k])])),
      h('label', { class: 'row', title: 'This many gifted subs or more also run the gift train: one drink / balloon / rocket per gift.' }, h('span', { class: 'lbl' }, 'Gift train from'),
        h('input', { type: 'number', min: 2, step: 1, value: L.trainMin, placeholder: String(DEFAULT_LOUNGE_TRAIN), style: 'width:4.2em',
          onChange: (e: Event) => { const v = Math.max(2, Math.round(parseFloat((e.target as HTMLInputElement).value) || DEFAULT_LOUNGE_TRAIN)); setBag(S, (b) => { b.trainMin = v; }); } })),
      button('Reset tiers', () => setBag(S, (b) => { delete b.money; delete b.gifts; delete b.trainMin; })),
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'),
      h('div', { class: 'btns tight' }, ...([1, 2, 3, 4, 5] as const).map((k) => button(`T${k} $${L.money[k - 1]}`, () => loungeEvent(S, 'money', { tier: k }), k === 4 ? 'primary' : ''))),
      h('div', { class: 'btns tight' },
        button('🎁 5 gifted', () => loungeEvent(S, 'gift', { n: 5 })), button(`🚂 Gift train ×${Math.max(20, L.trainMin)}`, () => loungeEvent(S, 'gift', { n: Math.max(20, L.trainMin) })),
        button('⭐ Sub', () => loungeEvent(S, 'sub')), button('🎉 Raid', () => loungeEvent(S, 'raid'))),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same celebration. Stream Deck: “Lounge celebration” · Ctrl+K: “lounge tier 4”, “gift train 25”, “calm lounge”.'),
      forScripts('POST http://127.0.0.1:5191/api/command {"command":"lounge","args":{"event":"t3"}}'),
    );
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  render();
  return wrap;
}
