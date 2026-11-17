// Scene tab → 🥂 Yacht life (rooms whose scene.json has a `yacht` key, e.g. sc_890jump): crew / ships / skirmish /
// lightning / cutaway toggles, the support tiers (USD value of one support event → drink · champagne · fireworks ·
// escort flyby · fleet; raids = the fleet) and Test buttons. Everything lives in the host's stage-mode bag
// SceneState.modes.yacht (shared/yacht.ts), so every OBS page — the host's and every party guest's — shows the same yacht.
// Observer studios: the edits only reach this tab's preview (the controller never sends an observer's state).
// Bus / Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"yacht","args":{"event":"fleet"}}
// (event: drink | champagne | fireworks | flyby | fleet; optional "user"; or settings: on / crew / ships / skirmish /
// lightning / cutaway booleans).
import type { App } from '../app.ts';
import type { SceneController } from '../scene/controller.ts';
import { DEFAULT_YACHT_SUPPORT, YACHT_BAG, YACHT_DUR, YACHT_KINDS, YACHT_LEAD, isYachtKind, sanitizeYacht, yachtThresholds, type RoomYachtConfig, type YachtBag, type YachtKind } from '../../shared/yacht.ts';
import { button, h, rerender, section, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
const bagOf = (S: SceneController): YachtBag => sanitizeYacht((S as unknown as BagApi).modeBag(YACHT_BAG));
function setBag(S: SceneController, fn: (b: YachtBag) => void) {
  const b = structuredClone(bagOf(S));
  fn(b);
  (S as unknown as BagApi).setModeBag(YACHT_BAG, sanitizeYacht(b));
}
/** the current room's scene.json `yacht` (null = not a yacht room) */
function roomCfg(S: SceneController): RoomYachtConfig | null {
  const id = S.effective.sceneId;
  const info = id ? (S.scenes.find((x) => x.id === id) as unknown as { yacht?: RoomYachtConfig } | undefined) : undefined;
  return info?.yacht && typeof info.yacht === 'object' ? info.yacht : null;
}

const LABEL: Record<YachtKind, string> = { drink: '🥂 Drink', champagne: '🍾 Champagne', fireworks: '🎆 Fireworks', flyby: '✈️ Escort flyby', fleet: '🚀 Fleet arrival' };

/** Stamp an event (host only). A second press of the same kind while one runs queues behind it on every page. */
export function yachtEvent(S: SceneController, kind: YachtKind, user = ''): boolean {
  if (!S.canEdit) { toast('Only the host runs the yacht', 'warn'); return false; }
  if (!roomCfg(S)) { toast('Yacht life needs a yacht room (e.g. the 890 Jump)', 'warn'); return false; }
  const now = Date.now();
  const seed = ((now * 2654435761) >>> 0) % 2147483646 + 1;       // (deterministic from the press time; every page gets the stamp)
  setBag(S, (b) => { b.ev = { seq: (b.ev?.seq ?? 0) + 1, at: now + YACHT_LEAD, kind, seed, ...(user ? { user: user.slice(0, 32) } : {}) }; });
  toast(`${LABEL[kind]} (${Math.round(YACHT_DUR[kind] / 1000)} s)`, 'ok', 1400);
  return true;
}

/** Bus / Stream Deck: {command:'yacht', args:{event?, user?, on?, crew?, ships?, skirmish?, lightning?, cutaway?}} */
export function yachtCommand(S: SceneController, a: Record<string, unknown>) {
  if (!S.canEdit) return;
  const flags = ['on', 'crew', 'ships', 'skirmish', 'lightning', 'cutaway'] as const;
  if (flags.some((k) => typeof a[k] === 'boolean')) setBag(S, (b) => { for (const k of flags) if (typeof a[k] === 'boolean') b[k] = a[k] as boolean; });
  if (isYachtKind(a.event)) yachtEvent(S, a.event, typeof a.user === 'string' ? a.user : '');
}

/** Scene tab section (keeps itself up to date; empty outside yacht rooms). */
export function yachtSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  const wrap = section('🥂 Yacht life', box);
  const render = () => rerender(box, () => {
    const cfg = roomCfg(S);
    wrap.style.display = cfg ? '' : 'none';
    if (!cfg) return;
    const edit = S.canEdit;
    if (!edit) { box.append(h('p', { class: 'note' }, 'The host runs the yacht — your OBS shows the same crew, ships and shows.')); return; }
    const bag = bagOf(S);
    const thr = yachtThresholds(bag, cfg);
    const num = (k: YachtKind) => h('label', { class: 'row', title: `One support event worth at least this much (USD value; subs / memberships = $5) → ${LABEL[k]}. Tiers add up: a bigger one gets everything below it too.` },
      h('span', { class: 'lbl' }, `${LABEL[k]} from $`),
      h('input', { type: 'number', min: 0, step: 1, value: thr[k], placeholder: String(cfg.support?.[k] ?? DEFAULT_YACHT_SUPPORT[k]),
        onChange: (e: Event) => { const v = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0); setBag(S, (b) => { b.support[k] = v; }); } }));
    box.append(
      toggle('Yacht life', bag.on, (v) => setBag(S, (b) => { b.on = v; }), 'The crew, the ships outside and the shows (off = a still room)'),
      toggle('Crew', bag.crew, (v) => setBag(S, (b) => { b.crew = v; }), 'Bartender, stewards, walking crew and guests (they fade rather than cover a face or the React screen)'),
      toggle('Ship traffic', bag.ships, (v) => setBag(S, (b) => { b.ships = v; }), 'Distant flybys past the windows and the escort patrol holding station'),
      toggle('Pirate skirmishes', bag.skirmish, (v) => setBag(S, (b) => { b.skirmish = v; }), 'Now and then a small dogfight far out: tracers, hits, a fireball (tiny on screen)'),
      toggle('Storm lightning', bag.lightning, (v) => setBag(S, (b) => { b.lightning = v; }), 'Flickers inside Crusader’s storms (photosensitivity-safe spacing)'),
      toggle('Fleet cutaway', bag.cutaway, (v) => setBag(S, (b) => { b.cutaway = v; }), 'When a fleet arrives, cut to the exterior camera for 6 s (Talk mode only; never in React / Gaming / Interview)'),
      h('h4', { style: 'margin:10px 0 4px' }, 'Support'),
      toggle('Support events', bag.support.on, (v) => setBag(S, (b) => { b.support.on = v; }), 'Tips, Super Chats, Rants, subs, memberships, Kicks …'),
      toggle('Raids bring a fleet', bag.support.raids, (v) => setBag(S, (b) => { b.support.raids = v; }), 'An incoming raid quantum-jumps a fleet in'),
      ...YACHT_KINDS.map(num),
      h('h4', { style: 'margin:10px 0 4px' }, 'Test'),
      h('div', { class: 'btns tight' }, ...YACHT_KINDS.map((k) => button(LABEL[k], () => { yachtEvent(S, k, 'Test'); }, k === 'fleet' ? 'primary' : ''))),
      h('p', { class: 'note' }, S.observer ? 'Observer: tests only play in this preview.' : 'Everyone’s OBS and party guests see the same show.'),
      forScripts('Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"yacht","args":{"event":"fireworks"}}'),
    );
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  render();
  return wrap;
}
