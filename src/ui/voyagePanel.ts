// Scene tab -> Voyage (rooms whose scene.json has a `voyage` key, e.g. a walking land-ship; SPEC 2.8): the walking ship's
// settings, Anchor / Weigh anchor, New voyage, the event buttons (Treasure now, Battle now, Storm now, City now,
// Broadside ...), the support tiers. Everything lives in the host's stage-mode bag SceneState.modes.voyage
// (shared/voyage.ts) and is stamped by src/scene/voyage/voyageHost.ts, so every OBS page - the host's and every party
// guest's - walks the same voyage. Observer studios: edits only reach this tab's preview.
// Bus / Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"voyage","args":{"event":"broadside"}}
// (event: any stamp kind; "anchor": true | false; "newVoyage": true; settings on / cutaways / extCams / votes, pacing,
// sway 0..1.5, env journey | state | fixed).
import type { App } from '../app.ts';
import type { SceneController } from '../scene/controller.ts';
import { DEFAULT_TIERS, FLAVOUR_LABEL, STAMP_DUR, TIER_KINDS, stampLabel, voyageNow, voyageTierLines, type StampKind } from '../../shared/voyage.ts';
import { voyageAnchor, voyageBagOf, voyageCommand, voyageDropNote, voyageNew, voyagePacing, voyageRoomCfg, voyageSetBag, voyageStampWhy, type VoyageCtl } from '../scene/voyage/voyageHost.ts';
import { button, h, rerender, section, select, slider, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';

const ctl = (S: SceneController) => S as unknown as VoyageCtl;
/** The helm NPC's name from the room's scene.json (`crew.captainName`, the room owner's own content); generic otherwise. */
function captainName(S: VoyageCtl): string {
  const id = S.effective.sceneId;
  if (!id) return 'The crew captain';
  const info = S.scenes.find((x) => x.id === id) ?? S.scenes.find((x) => x.id === id.split('~')[0]);
  const n = (info as unknown as { crew?: { captainName?: unknown } } | undefined)?.crew?.captainName;
  return typeof n === 'string' && n.trim() ? n.trim().slice(0, 40) : 'The crew captain';
}

/** Stamp an event from the panel (host only). */
export function voyageEvent(S: SceneController, kind: StampKind, user = ''): boolean {
  if (!S.canEdit) { toast('Only the host steers the ship', 'warn'); return false; }
  const rc = voyageRoomCfg(ctl(S));
  if (!rc) { toast('Voyage needs a walking-ship room (e.g. a walking land-ship)', 'warn'); return false; }
  const why = voyageStampWhy(ctl(S), kind, user);
  toast(!why ? `${stampLabel(kind, rc)} (${Math.round(STAMP_DUR[kind])} s)` : `${stampLabel(kind, rc)}: ${why}`, !why ? 'ok' : 'warn', why ? 2600 : 1400);
  return !why;
}
export { voyageCommand };

const BUTTONS: StampKind[] = ['treasure', 'battle', 'storm', 'city', 'broadside', 'salute', 'whistle', 'special', 'fireworks', 'convoy'];

/** Scene tab section (keeps itself up to date; empty outside voyage rooms). */
export function voyageSection(app: App): HTMLElement {
  const S = app.scene;
  const C = ctl(S);
  const box = h('div');
  const wrap = section('Voyage (walking ship)', box);
  const render = () => rerender(box, () => {
    const cfg = voyageRoomCfg(C);
    wrap.style.display = cfg ? '' : 'none';
    if (!cfg) return;
    if (!S.canEdit) { box.append(h('p', { class: 'note' }, 'The host steers the ship - your OBS walks the same voyage.')); return; }
    const bag = voyageBagOf(C);
    const st = voyageNow(bag, cfg, Date.now());
    const anchored = bag.holds.some((x) => x.until === null);
    const pend = bag.pace[bag.pace.length - 1];
    const pacingNote = pend && pend.v > st.V ? ` (from chapter ${pend.ch + 1})` : '';
    const drop = voyageDropNote();
    const tiers = voyageTierLines(bag, cfg);
    const tierRow = (i: number) => h('label', { class: 'row', title: `One support event worth at least this much (host currency; subs = $5) -> ${stampLabel(TIER_KINDS[i], cfg)}. Tiers add up.` },
      h('span', { class: 'lbl' }, `${stampLabel(TIER_KINDS[i], cfg)} from`),
      h('input', { type: 'number', min: 0, step: 1, value: tiers[i], placeholder: String(cfg.support?.tiers?.[i] ?? DEFAULT_TIERS[i]),
        onChange: (e: Event) => { const v = Math.max(0, parseFloat((e.target as HTMLInputElement).value) || 0); voyageSetBag(C, (b) => { const t = voyageTierLines(b, cfg); t[i] = v; b.support.tiers = t; }); } }));
    box.append(
      h('p', { class: 'note' }, `Chapter ${st.leg + 1} (${FLAVOUR_LABEL[st.plan.flavour]}): ${st.beat ? st.beat.kind : 'cruising'}, ${(st.S / 1000).toFixed(1)} km walked, ${String(Math.floor(st.hour)).padStart(2, '0')}:${String(Math.floor((st.hour % 1) * 60)).padStart(2, '0')}${anchored ? ' - at anchor' : ''}`),
      h('div', { class: 'btns tight' },
        button(anchored ? 'Weigh anchor' : 'Anchor', () => voyageAnchor(C, !anchored), 'primary'),
        button('New voyage', () => { if (confirm('Start a new voyage (new route, chapter 1 now)?')) voyageNew(C); })),
      h('div', { class: 'btns tight' }, ...BUTTONS.map((k) => button(stampLabel(k, cfg), () => { voyageEvent(S, k, 'Host'); }, k === 'treasure' || k === 'battle' ? 'primary' : ''))),
      ...(drop ? [h('p', { class: 'note' }, drop)] : []),
      toggle('Voyage', bag.on, (v) => voyageSetBag(C, (b) => { b.on = v; }), 'The world walks past, battles, storms, treasure stops (off = the ship stands still)'),
      select(`Pacing${pacingNote}`, bag.pacing, [['chill', 'Chill (25 min chapters)'], ['normal', 'Normal (20 min chapters)'], ['hot', 'Hot (15 min chapters)']], (v) => voyagePacing(C, v), 'How often something happens - a change starts with the next chapter (nothing jumps)'),
      toggle('Battles', bag.events.battles, (v) => voyageSetBag(C, (b) => { b.events.battles = v; }), 'Show the encounters (off: the ship still walks the same route)'),
      toggle('Sandstorms', bag.events.storms, (v) => voyageSetBag(C, (b) => { b.events.storms = v; })),
      toggle('Treasure sorties', bag.events.treasure, (v) => voyageSetBag(C, (b) => { b.events.treasure = v; })),
      toggle('Cities', bag.events.cities, (v) => voyageSetBag(C, (b) => { b.events.cities = v; })),
      select('Sky', bag.env, [['journey', 'Journey (day + night pass)'], ['state', 'Lighting states'], ['fixed', 'Fixed hour']], (v) => voyageSetBag(C, (b) => { b.env = v; }), 'Journey: one day per 2 chapters; Preshow / BRB / Outro keep their own hours'),
      slider('Day length (chapters)', bag.dayLen, 1, 4, 1, (v) => voyageSetBag(C, (b) => { b.dayLen = v; })),
      slider('Night share', bag.nightShare, 0.15, 0.45, 0.05, (v) => voyageSetBag(C, (b) => { b.nightShare = v; })),
      toggle('Cut away while I talk', bag.talkCuts, (v) => voyageSetBag(C, (b) => { b.talkCuts = v; }), 'Off: in Talk the camera stays on the angle you picked. On: short outside shots of big moments (battle, explosion, sortie, city, storm wall, and the room b-roll), at most one per 90 s, only while nobody talks'),
      toggle('Exterior cams', bag.extCams, (v) => voyageSetBag(C, (b) => { b.extCams = v; }), 'Preshow / BRB / Outro with ambient cameras on: crane, orbit, drive-by shots of the walking ship'),
      toggle('Chat votes the route', bag.votes, (v) => voyageSetBag(C, (b) => { b.votes = v; }), 'A chat poll in the last 2 minutes of each chapter picks the next one (never over your own poll)'),
      slider('Deck motion', bag.sway, 0, 1.5, 0.05, (v) => voyageSetBag(C, (b) => { b.sway = v; }), 'How much the horizon rocks (React and Gaming are always still)'),
      select('Captain at the helm', bag.crew.helm, [['npc', captainName(C)], ['performer', 'Me']], (v) => voyageSetBag(C, (b) => { b.crew.helm = v; })),
      h('h4', { style: 'margin:10px 0 4px' }, 'Support'),
      toggle('Support events', bag.support.on, (v) => voyageSetBag(C, (b) => { b.support.on = v; }), 'Tips, Super Chats, subs, memberships, Kicks ...'),
      toggle('Raids bring a convoy', bag.support.raids, (v) => voyageSetBag(C, (b) => { b.support.raids = v; }), 'An incoming raid sails a skiff convoy alongside'),
      ...TIER_KINDS.map((_, i) => tierRow(i)),
      h('p', { class: 'note' }, S.observer ? 'Observer: changes only play in this preview.' : "Everyone's OBS and party guests see the same voyage."),
      forScripts('Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"voyage","args":{"event":"treasure"}}  /  {"anchor":true}'),
    );
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  render();
  return wrap;
}
