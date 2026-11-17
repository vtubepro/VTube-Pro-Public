// Live → Stream extras → "Throw & Bonk" (beta.16, docs/b16/THROW.md). Plain words, one click to try it, sensible defaults:
// the four big buttons throw straight away; everything below them only changes how it feels. Settings are the host's stage-mode bag
// (SceneState.modes.throw, shared/throwables.ts), so every OBS page plays the same thing.
import type { B16PanelHandle } from '../b16/panels.ts';
import { THROW_LIMITS, THROW_THROWN, type ClickPat, type ThrowArgs, type ThrowBag } from '../../shared/throwables.ts';
import { button, h, rerender, section, select, slider, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';

/** What the panel needs from the mount (kept small so the panel can be tested with a stub). */
export interface ThrowPanelApi {
  bag(): ThrowBag;
  setBag(fn: (b: ThrowBag) => void): void;
  canEdit(): boolean;
  /** Throw now (a test throw is a real one). Resolves to the sentence to show. */
  throwNow(a: Partial<ThrowArgs>): Promise<string>;
  optOut: { get(): boolean; set(v: boolean): void };
  /** How many chat emotes are remembered right now. */
  emotesSeen(): number;
  pictures: { changed(): void };
  isGuest(): boolean;
}

interface Mine { id: string; name: string }
interface Listing { mine: Mine[]; max: number }

const TRY_KEY = 'vtp.throw.tryCount';
const readCount = () => { try { return Math.min(THROW_LIMITS.maxBarrage, Math.max(1, Number(localStorage.getItem(TRY_KEY)) || 5)); } catch { return 5; } };
const writeCount = (n: number) => { try { localStorage.setItem(TRY_KEY, String(n)); } catch { /* private mode */ } };

async function listing(): Promise<Listing> {
  try { const r = await fetch('/api/throwables'); if (r.ok) return await r.json() as Listing; } catch { /* VTube Pro is not answering */ }
  return { mine: [], max: THROW_LIMITS.maxUserImages };
}

export function mountThrowPanel(host: HTMLElement, api: ThrowPanelApi): B16PanelHandle {
  const box = h('div', { class: 'throw-panel' });
  host.append(box);
  let lst: Listing | null = null;
  const reload = () => listing().then((l) => { lst = l; if (box.isConnected) render(); });
  const say = (p: Promise<string>) => { void p.then((s) => toast(s, 'ok', 2200)).catch(() => toast('That did not work. Try again.', 'warn')); };

  async function upload(file: File) {
    if (file.size > THROW_LIMITS.maxImageBytes) { toast('That picture is bigger than 1 MB: use a smaller one', 'warn'); return; }
    try {
      const r = await fetch(`/api/throwables/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      if (!r.ok) { const j = await r.json().catch(() => ({})) as { error?: string }; toast(j.error || 'I could not add that picture', 'warn'); return; }
      api.pictures.changed(); toast('Picture added. Try “My picture”.', 'ok'); await reload();
    } catch { toast('I could not reach VTube Pro to add that picture', 'warn'); }
  }
  async function remove(id: string) {
    try { await fetch(`/api/throwables/file/${encodeURIComponent(id)}`, { method: 'DELETE' }); api.pictures.changed(); await reload(); } catch { toast('I could not remove that picture', 'warn'); }
  }

  const render = () => rerender(box, () => {
    const edit = api.canEdit();
    const b = api.bag();
    const set = (fn: (x: ThrowBag) => void) => api.setBag(fn);
    const n = readCount();
    if (!edit) {
      box.append(
        h('p', { class: 'note' }, 'The host throws things at their own avatar. When they pick “everyone in my party”, your avatar can get hit too.'),
        toggle('Never hit my avatar', api.optOut.get(), (v) => { api.optOut.set(v); render(); }, 'Only on this computer: the host cannot see or change it'),
      );
      return;
    }
    const mine = lst?.mine ?? [];
    box.append(
      h('p', { class: 'note' }, 'Chat throws things at your head and your avatar flinches. Press a button to try it: it happens on your stream right now.'),
      h('div', { class: 'btns tight' },
        button('🎯 Chat’s emotes', () => say(api.throwNow({ what: 'emote', count: n })), 'primary', 'throw-emote'),
        button('🍅 A prop', () => say(api.throwNow({ what: 'prop', count: n }))),
        button('🖼 My picture', () => say(api.throwNow({ what: 'image', count: n })), '', 'throw-image'),
        button('🖐 Headpat', () => say(api.throwNow({ what: 'headpat', item: 'pat-hand' })), '', 'throw-pat'),
        button('☝ Boop', () => say(api.throwNow({ what: 'headpat', item: 'boop-finger' })), '', 'throw-boop')),
      slider('How many', n, 1, THROW_LIMITS.maxBarrage, 1, (v) => { writeCount(Math.round(v)); }, 'How many things the buttons above throw at once', (v) => `${Math.round(v)}`, { def: 5 }),
      h('p', { class: 'note', 'data-tick': '1' }, api.emotesSeen() ? `Chat has sent ${api.emotesSeen()} emotes lately: they are what “Chat’s emotes” throws.` : 'No chat emotes yet: until chat sends some, “Chat’s emotes” throws props instead.'),

      section('How it feels',
        slider('Hit strength', b.strength, 0, 1, 0.05, (v) => set((x) => { x.strength = v; }), 'How hard the head snaps back when something hits it', (v) => `${Math.round(v * 100)}%`, { def: 0.6 }),
        slider('Settle time', b.returnSecs, 0.2, 2, 0.05, (v) => set((x) => { x.returnSecs = v; }), 'How long the head takes to come back', (v) => `${v.toFixed(2)} s`, { def: 0.7 }),
        slider('Reaction delay', b.delayMs, 0, 500, 10, (v) => set((x) => { x.delayMs = Math.round(v); }), 'A short wait between the hit and the flinch (makes it feel heavier)', (v) => `${Math.round(v)} ms`, { def: 60 }),
        slider('Item size', b.size, 0.5, 2, 0.05, (v) => set((x) => { x.size = v; }), undefined, (v) => `${v.toFixed(2)}×`, { def: 1 }),
        toggle('Ouch face', b.ouch, (v) => set((x) => { x.ouch = v; }), 'A pained face while it hurts (avatars with face shapes only; the head still flinches without it)'),
        toggle('Impact stars', b.stars, (v) => set((x) => { x.stars = v; }), 'A little star where each thing hits and hearts for a headpat. With “Photosensitivity-safe flashes” on (Lights) there are never more than 3 a second.')),

      section('Big gifts',
        slider('Most things at once', b.maxBarrage, 1, THROW_LIMITS.maxBarrage, 1, (v) => set((x) => { x.maxBarrage = Math.round(v); }), 'Bits, gifted subs and raids throw more things, but never more than this', (v) => `${Math.round(v)}`, { def: 20 }),
        slider('Bits per extra thing', b.perBits, 10, 1000, 10, (v) => set((x) => { x.perBits = Math.round(v); }), '100 bits = one more thing by default. Kicks count the same way.', (v) => `${Math.round(v)}`, { def: 100 }),
        slider('Things per gifted sub', b.perGift, 0.5, 10, 0.5, (v) => set((x) => { x.perGift = v; }), 'Also used for TikTok gifts', (v) => `${v}`, { def: 1 })),

      section('Headpat',
        select<ClickPat>('When I click my head', b.clickPat, [['off', 'Nothing'], ['headpat', 'A hand pats it'], ['boop', 'A finger boops it']], (v) => set((x) => { x.clickPat = v; }), 'Click the avatar’s head in the studio preview'),
        h('p', { class: 'note' }, 'To pat on a redeem: Redeems & Reactions → add the step “Throw at my head” and pick Headpat.')),

      section('Sound',
        toggle('Hit sounds', b.sound, (v) => set((x) => { x.sound = v; }), 'Off by default. When on, a short thud plays on your OBS Browser Source only, never in the studio or for guests.'),
        h('p', { class: 'note' }, 'Plays through the OBS Browser Source (the sound reaches your stream, so check “Control audio via OBS” if you want it in the mixer).')),

      section('My pictures',
        h('p', { class: 'note' }, 'Your own PNG, GIF or WebP (up to 1 MB). They stay on this computer. A GIF throws as a still picture.'),
        h('div', { class: 'btns tight' }, button('➕ Add a picture', () => fileInput.click()), mine.length ? h('span', { class: 'note', style: 'margin-left:8px' }, `${mine.length} of ${lst?.max ?? THROW_LIMITS.maxUserImages}`) : null),
        h('div', { class: 'throw-pics', style: 'display:flex;flex-wrap:wrap;gap:8px;margin-top:6px' },
          ...mine.map((m) => h('div', { style: 'position:relative;width:64px;text-align:center', title: m.name },
            h('img', { src: `/api/throwables/file/${m.id}`, alt: m.name, style: 'width:64px;height:64px;object-fit:contain;background:#0003;border-radius:6px' }),
            h('button', { class: 'btn', style: 'position:absolute;top:-6px;right:-6px;padding:0 6px;min-width:0', title: 'Remove', onClick: () => { void remove(m.id); } }, '×'))))),

      section('Who gets hit',
        select<ThrowBag['who']>('Who', b.who, [['me', 'Only me'], ['everyone', 'Everyone in my party']], (v) => set((x) => { x.who = v; }), 'Party guests can switch it off for themselves on their own computer'),
        h('p', { class: 'note' }, `Starter props: ${THROW_THROWN.map((p) => p.label.toLowerCase()).join(', ')}.`)),

      forScripts('Stream Deck: add the action “Throw at my head”. Scripts: POST http://127.0.0.1:5191/api/command {"command":"throw","args":{"what":"emote","count":5,"from":"chat"}} — what: emote, prop, image or headpat; from: chat, raider or redeemer.'),
    );
  });

  const fileInput = h('input', { type: 'file', accept: 'image/png,image/gif,image/webp', style: 'display:none', onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; (e.target as HTMLInputElement).value = ''; if (f) void upload(f); } });
  render();
  void reload();
  const tick = setInterval(() => { if (box.isConnected) render(); }, 4000);   // (the "emotes seen" line follows chat; rerender keeps the DOM when nothing changed)
  return { destroy() { clearInterval(tick); box.remove(); } };
}
