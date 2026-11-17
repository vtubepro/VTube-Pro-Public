// Games hub (the 🎮 Games area, Simple and Advanced): one card per game — The Trail and the Tabletop RPG — each with
// "Play solo" and "Play with friends". Friends opens a small lobby that walks the host through opening a party (the
// same Discord / invite-code calls as the Multiplayer panel), shows who's in and whether their avatar has arrived, then
// starts the game. Nothing here is game logic: The Trail starts through trailPanel.ts startTrail (the one start path),
// the table opens through the stage-mode bar's TTRPG mode (or the TTRPG session when the bar isn't installed).
import type { App } from '../app.ts';
import type { MemberView } from '../party.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import { stageModeDef } from '../scene/stage/registry.ts';
import { discord, goLive, type DiscordStatus } from '../net/discordClient.ts';
import { h, rerender, toast } from './dom.ts';
import { add, observerNote, seg } from './bits.ts';
import { TRAIL_EVENT, startTrail, trailJoinButton, trailRunning, trailThemes, type TrailTheme } from './trailPanel.ts';
import { catalogue, tableName } from './roomWorlds.ts';
import type { Nav } from './simple.ts';
import { shareLink } from '../net/shareLink.ts';

type GmKind = 'ai' | 'human' | 'none';
type GameId = 'trail' | 'ttrpg';

// ---------------------------------------------------------------- choices (per browser; every access wrapped)
const ls = {
  get(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage off */ } },
};
const G = {
  theme: ls.get('vtp.trail.theme', 'frontier'),
  slice: ls.get('vtp.trail.slice', '1') !== '0',
  bots: Math.max(0, Math.min(3, parseInt(ls.get('vtp.games.bots', '0'), 10) || 0)),
  gm: (['ai', 'human', 'none'].includes(ls.get('vtp.games.gm', 'ai')) ? ls.get('vtp.games.gm', 'ai') : 'ai') as GmKind,
  gmWho: '',
  /** Which room's table ('' = the room you're in, or the generic table). */
  table: ls.get('vtp.games.table', ''),
};
let themes: TrailTheme[] | null = null;
let dstatus: DiscordStatus | null = null, dAt = 0;
/** Themes whose levels the sim bots can't walk yet (they don't see island gaps): no bots there. */
const NO_BOTS = new Set(['skyisles']);

// ---------------------------------------------------------------- the TTRPG session (src/ttrpg/studio, window.vtpTtrpg)
interface TtSession { active: boolean; isHost: boolean; selfKey: string; enter(o?: object): void; leave(): void; setGm(p: { kind: GmKind; who?: string }): void; game: { gm: { kind: GmKind } } | null }
const tt = () => (window as unknown as { vtpTtrpg?: { session: TtSession; panel: { open(tab?: string): void } } }).vtpTtrpg ?? null;

/** Open the tabletop game at `room`'s table (its `<env>_ttrpg` room, else the generic table) — the TTRPG mode's own path
 *  (the party walks over, the curtain plays; picking another mode brings everyone back). `room` undefined = here. */
export function openTable(app: App, room?: string | null, gm?: GmKind, who?: string) {
  const S = app.scene, T = tt();
  if (!S.canEdit) { toast('The host opens the table', 'warn'); return; }
  if (!T) { toast('The tabletop game isn’t installed in this studio', 'warn'); return; }
  const bar = !!stageModeDef('ttrpg');
  const cur = S.effective.sceneId ?? null;
  const cat = catalogue(S.scenes);
  const here = cur ? cat.tableOf.get(cur) ?? cur : null;          // (at a table: the room it belongs to)
  const going = room === undefined ? here : room;
  const busy = T.session.active || (S.effective.mode as string) === 'ttrpg';
  if (busy && going === here) { T.panel.open('table'); if (gm) T.session.setGm({ kind: gm, ...(gm === 'human' ? { who: who || T.session.selfKey } : {}) }); return; }
  if (busy) { if (bar) S.setMode('talk'); else T.session.leave(); }              // a table elsewhere: close it first
  if (going !== (S.effective.sceneId ?? null)) S.setScene(going);                // (the state saves ~80 ms later: OBS sees one change)
  if (bar) S.setMode('ttrpg'); else T.session.enter();
  if (!T.session.active) T.session.enter();                                       // (observer tabs don't follow the state by themselves)
  if (gm) T.session.setGm({ kind: gm, ...(gm === 'human' ? { who: who || T.session.selfKey } : {}) });
  T.panel.open('table');
}

// ---------------------------------------------------------------- styles
const CSS = `
.gm-intro { margin: 0 0 12px; }
.gm-intro h3 { margin: 0 0 3px; font-size: 16px; letter-spacing: -.01em; }
.gm-intro p { margin: 0; color: var(--dim); font-size: 12.5px; line-height: 1.45; }
.gm-intro .s-row { margin-top: 8px; }
.gm-card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; overflow: hidden; margin-bottom: 14px; }
.gm-art { position: relative; aspect-ratio: 16/7.2; background: var(--card2) center/cover no-repeat; display: grid; place-items: center; overflow: hidden; }
.gm-art .logo { max-width: 86%; max-height: 80%; object-fit: contain; filter: drop-shadow(0 4px 10px #0009); }
.gm-art .fade { position: absolute; inset: 0; background: linear-gradient(180deg, #0000 45%, #000a); pointer-events: none; }
.gm-art .ttl { position: absolute; left: 14px; bottom: 10px; right: 14px; color: #fff; font-size: 21px; font-weight: 800; letter-spacing: -.02em; line-height: 1.05; text-shadow: 0 2px 10px #000c; }
.gm-art .ttl small { display: block; font-size: 12px; font-weight: 600; letter-spacing: 0; opacity: .85; margin-top: 3px; }
.gm-art.frontier { background: radial-gradient(120% 90% at 50% 110%, #f4a259 0%, #c8553d 38%, #3a2e4f 78%, #1d1b2c 100%); }
.gm-art.frontier .ttl { text-align: center; bottom: auto; font-size: 26px; font-family: Georgia, 'Times New Roman', serif; font-weight: 700; }
.gm-art .live { position: absolute; top: 10px; left: 10px; display: inline-flex; align-items: center; gap: 6px; background: #000b; color: #fff; font-size: 11.5px; font-weight: 700; padding: 3px 9px; border-radius: 99px; }
.gm-art .live i { width: 8px; height: 8px; border-radius: 50%; background: #ff5d5d; box-shadow: 0 0 8px #ff5d5d; }
.gm-body { padding: 12px 14px 14px; }
.gm-body h3 { margin: 0; font-size: 15px; display: flex; align-items: baseline; gap: 8px; }
.gm-body h3 .who { font-size: 12px; font-weight: 600; color: var(--faint); }
.gm-how { color: var(--dim); font-size: 12.5px; line-height: 1.5; margin: 4px 0 10px; }
.gm-how kbd { font: inherit; font-size: 11px; font-weight: 700; background: var(--card2); border: 1px solid var(--line2); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; color: var(--text); }
.gm-opt { display: grid; gap: 5px; margin: 0 0 10px; }
.gm-opt > span { font-size: 12px; font-weight: 600; color: var(--dim); }
.gm-opt .hint { font-size: 11.5px; color: var(--faint); line-height: 1.4; }
.gm-opt select { width: 100%; }
.gm-play { display: grid; grid-template-columns: 1fr 1.3fr; gap: 8px; margin-top: 12px; }
.gm-play .btn { padding: 10px 10px; font-weight: 700; font-size: 13.5px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; gap: 1px; }
.gm-play .btn small { font-size: 11px; font-weight: 600; opacity: .75; }
.gm-running { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
.gm-lobby-back { position: fixed; inset: 0; z-index: 58; background: #05070bc4; backdrop-filter: blur(3px); display: grid; place-items: center; padding: 20px; }
.gm-lobby { width: min(600px, 100%); max-height: calc(100vh - 40px); overflow-y: auto; background: var(--panel); border: 1px solid var(--line2); border-radius: 18px; box-shadow: 0 24px 80px #000a; }
.gm-lobby .gm-art { aspect-ratio: 16/5; }
.gm-lobby-in { padding: 14px 20px 18px; }
.gm-lobby h2 { margin: 0 0 2px; font-size: 19px; letter-spacing: -.01em; display: flex; align-items: center; gap: 8px; }
.gm-lobby h2 .grow { flex: 1; }
.gm-steps { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 14px; }
.gm-step { display: grid; grid-template-columns: 28px 1fr; gap: 10px; }
.gm-step > .n { width: 26px; height: 26px; border-radius: 50%; border: 1.5px solid var(--line2); display: grid; place-items: center; font-size: 12px; font-weight: 800; color: var(--dim); }
.gm-step.done > .n { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
.gm-step.cur > .n { border-color: var(--accent); color: var(--accent); }
.gm-step > div > b { display: block; font-size: 14px; margin: 3px 0 4px; }
.gm-step .note { font-size: 12.5px; margin: 0 0 6px; }
.gm-ways { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.gm-way { border: 1px solid var(--line2); border-radius: 12px; padding: 10px; background: var(--card); display: flex; flex-direction: column; gap: 6px; }
.gm-way b { font-size: 13px; }
.gm-way span { color: var(--dim); font-size: 11.5px; line-height: 1.4; flex: 1; }
.gm-way textarea { width: 100%; font-size: 11px; }
.gm-roster { display: grid; gap: 4px; }
.gm-mem { display: grid; grid-template-columns: 28px 1fr auto; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 10px; background: var(--card); border: 1px solid var(--line); }
.gm-mem .av { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 12px; color: #fff; }
.gm-mem .nm { font-weight: 650; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gm-mem .nm small { color: var(--faint); font-weight: 600; margin-left: 4px; }
.gm-knock { display: flex; gap: 8px; align-items: center; padding: 6px 8px; border-radius: 10px; background: var(--warn-soft); border: 1px solid #ffb45455; font-size: 12.5px; }
.gm-knock .grow { flex: 1; }
@media (max-width: 560px) { .gm-ways { grid-template-columns: 1fr; } }
`;
let cssDone = false;
const css = () => { if (!cssDone) { document.head.append(h('style', { id: 'gm-css' }, CSS)); cssDone = true; } };

const initialOf = (n: string) => (n.replace(/\(.*?\)/g, '').trim()[0] ?? '?').toUpperCase();
const hueOf = (n: string) => [...n].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

// ---------------------------------------------------------------- the hub
/** The Games area body (Simple and Advanced build the same thing; `advanced` adds the per-game detail links). */
export function gamesHub(app: App, el: HTMLElement, nav: Nav, o: { advanced?: boolean } = {}) {
  css();
  add(el, observerNote(app) ?? '');
  const P = app.party;
  if (!themes) void trailThemes().then((t) => { themes = t; nav.refresh(); });
  if (Date.now() - dAt > 15000) { dAt = Date.now(); void discord.status().then((s) => { const ch = JSON.stringify(s) !== JSON.stringify(dstatus); dstatus = s; if (ch && lobby) lobby.draw(); }).catch(() => {}); }
  // keep the running / party state current while this view shows
  watch(app, el, nav);
  const guests = P.role === 'host' ? P.remotes.size : 0;
  const partyLine = P.role === 'guest' ? h('span', { class: 'chip ok' }, h('span', { class: 'dot' }), `In ${P.hostInfo?.name ?? 'a friend'}’s party`)
    : P.role === 'host' ? h('span', { class: 'chip ok' }, h('span', { class: 'dot' }), `Party open · ${guests} friend${guests === 1 ? '' : 's'} in`)
      : h('span', { class: 'chip' }, h('span', { class: 'dot' }), 'No party yet');
  add(el, h('div', { class: 'gm-intro' },
    h('h3', null, 'Play with your avatar'),
    h('p', null, P.role === 'guest' ? 'The host starts the games. When they do, a Join prompt shows up here in your studio.' : 'Your tracked avatar is your character. Play on your own, or open a party and play with friends: everyone’s OBS shows the game.'),
    h('div', { class: 's-row' }, partyLine, P.role === 'none' ? h('button', { class: 'btn link', onClick: () => nav.go('friends') }, 'Party settings') : null)));
  add(el, trailCard(app, nav), tableCard(app, nav));
  if (o.advanced) add(el, h('p', { class: 'note' }, `More: the classic Trail launcher is also under OBS → Browser Source & output; the full tabletop panel (dice, sheets, the GM, campaigns) opens with the 🎲 Tabletop game button or Shift+Y. Interview and Gaming layouts are show modes in Show & layout → Show mode.`));
}

let watching: HTMLElement | null = null;
function watch(app: App, el: HTMLElement, nav: Nav) {
  if (watching === el) return;
  watching = el;
  let sig = '';
  const tick = () => {
    if (!el.isConnected || watching !== el) { cleanup(); return; }
    const T = tt(), t = trailRunning();
    const s = `${app.party.role}|${app.party.remotes.size}|${t ? `${t.role}:${t.status}` : ''}|${T?.session.active ?? ''}|${app.scene.effective.sceneId}|${app.scene.canEdit}`;
    if (s !== sig) { const first = !sig; sig = s; if (!first) nav.refresh(); }
  };
  const onTrail = () => tick();
  const iv = window.setInterval(tick, 700);
  document.addEventListener(TRAIL_EVENT, onTrail);
  const cleanup = () => { window.clearInterval(iv); document.removeEventListener(TRAIL_EVENT, onTrail); if (watching === el) watching = null; };
  tick();
}

// ---------------------------------------------------------------- The Trail
function trailArt(theme: string, running: boolean) {
  const list = themes ?? [];
  const t = list.find((x) => x.id === theme);
  const live = running ? h('span', { class: 'live' }, h('i'), 'Running') : null;
  if (!t || theme === 'frontier') return h('div', { class: 'gm-art frontier', role: 'img', 'aria-label': t?.name ?? 'The Trail' }, h('div', { class: 'ttl' }, t?.name ?? 'The Trail', h('small', null, 'one very bad wagon')), live);
  const base = `/api/trail/${encodeURIComponent(theme)}/file/ui`;
  return h('div', { class: 'gm-art', role: 'img', 'aria-label': t.name, style: `background-image:linear-gradient(#0000,#0005),url("${base}/map.png")` },
    h('img', { class: 'logo', src: `${base}/logo.png`, alt: '', onError: (e: Event) => { (e.target as HTMLElement).replaceWith(h('div', { class: 'ttl' }, t.name)); } }), live);
}

function trailCard(app: App, nav: Nav): HTMLElement {
  const P = app.party, run = trailRunning();
  const list = themes ?? [];
  if (list.length && !list.some((t) => t.id === G.theme)) G.theme = list[0].id;
  const body = h('div', { class: 'gm-body' },
    h('h3', null, 'The Trail', h('span', { class: 'who' }, '1–8 players')),
    h('p', { class: 'gm-how' }, 'Oregon Trail with your real avatar: shop, ford rivers, hunt, vote on disasters. Your size matters (tiny folks eat less, big ones haul more). ',
      h('kbd', null, 'WASD'), ' walk, ', h('kbd', null, 'E'), ' use, click to grab, ', h('kbd', null, '1–5'), ' vote.'));
  if (run) {
    add(body, h('p', { class: 'note', style: 'margin:0' }, run.status || 'A game is running.'),
      h('div', { class: 'gm-running' },
        h('button', { class: 'btn primary', onClick: () => run.openOverlay() }, 'Open the game view'),
        run.role === 'host' ? h('button', { class: 'btn danger', onClick: () => { if (confirm('End The Trail for everyone?')) { run.end(); nav.refresh(); } } }, 'End the game') : null));
    const runTheme = (run as { catchup?: { hello?: { theme?: string } | null } }).catchup?.hello?.theme ?? G.theme;   // (the game's own theme)
    return h('article', { class: 'gm-card', 'aria-label': 'The Trail' }, trailArt(runTheme, true), body);
  }
  if (P.role === 'guest') {
    add(body, h('div', { class: 's-banner', style: 'margin:0' }, h('span', null, '⏳'), h('span', null, 'Waiting for the host. When they start The Trail you get a ', h('b', null, 'Join'), ' prompt here — press it and your avatar walks in.')),
      h('div', { class: 'gm-running' }, trailJoinButton(app)));   // (missed the prompt / came in late)
    return h('article', { class: 'gm-card', 'aria-label': 'The Trail' }, trailArt(G.theme, false), body);
  }
  const noBots = NO_BOTS.has(G.theme);
  add(body,
    list.length > 1 ? h('div', { class: 'gm-opt' }, h('span', null, 'Theme'), h('div', { class: 's-pills' }, ...list.map((t) => h('button', { class: `s-pill ${t.id === G.theme ? 'on' : ''}`, 'aria-pressed': String(t.id === G.theme), onClick: () => { G.theme = t.id; ls.set('vtp.trail.theme', t.id); nav.refresh(); } }, t.name)))) : null,
    h('div', { class: 'gm-opt' }, h('span', null, 'Length'), seg<'short' | 'full'>([['short', 'Short run', '~15 min'], ['full', 'Whole trail', 'the full route']], G.slice ? 'short' : 'full', (v) => { G.slice = v === 'short'; ls.set('vtp.trail.slice', G.slice ? '1' : '0'); nav.refresh(); })),
    h('div', { class: 'gm-opt' }, h('span', null, 'Bots when you play solo'),
      seg<string>([['0', 'None'], ['1', '1'], ['2', '2'], ['3', '3']], noBots ? '0' : String(G.bots), (v) => { G.bots = +v; ls.set('vtp.games.bots', v); nav.refresh(); }, noBots),
      h('span', { class: 'hint' }, noBots ? 'This theme’s sky islands trip the bots up, so it’s just you here.' : 'Simple helpers that shop, haul and vote. They show as grey stand-ins, not avatars. Solo games only.')),
    h('div', { class: 'gm-play' },
      h('button', { class: 'btn', onClick: () => void startTrail(app, { theme: G.theme, slice: G.slice, solo: true, bots: noBots ? 0 : G.bots }).then(() => nav.refresh()) }, 'Play solo', h('small', null, noBots || !G.bots ? 'just you' : `you + ${G.bots} bot${G.bots > 1 ? 's' : ''}`)),
      h('button', { class: 'btn primary', onClick: () => openLobby(app, nav, 'trail') }, '👥 Play with friends', h('small', null, P.role === 'host' ? `${P.remotes.size + 1} in your party` : 'open a party first'))));
  return h('article', { class: 'gm-card', 'aria-label': 'The Trail' }, trailArt(G.theme, false), body);
}

// ---------------------------------------------------------------- Tabletop RPG
/** Settings with a table: [room id ('' = the generic table), label, table thumb]. */
function tableChoices(app: App) {
  const S = app.scene, cat = catalogue(S.scenes);
  const cur = S.effective.sceneId ?? null;
  const here = cur ? cat.tableOf.get(cur) ?? cur : null;
  const out: { id: string; label: string; thumb: string | null; table: string }[] = [];
  const generic = cat.entries.find((e) => e.info.ttrpg?.of === '*');
  for (const e of cat.entries) if (e.table && e.table !== e.info && !e.test && e.table.ready !== false) out.push({ id: e.info.id, label: `${e.title}: ${tableName(e.table.name)}`, thumb: e.table.thumb ?? e.info.thumb ?? null, table: tableName(e.table.name) });
  const hereOpt = out.find((x) => x.id === here);
  return { list: out, here: hereOpt ?? null, generic: generic ? { id: generic.info.id, label: generic.title, thumb: generic.info.thumb ?? null, table: generic.title } : null };
}

/** The setting picked on the card → openTable's room argument (the generic table from a room without its own table:
 *  undefined, so the TTRPG mode walks everyone over and brings them back afterwards). */
function chosenTable(app: App) {
  const c = tableChoices(app);
  const ch = (G.table && c.list.find((x) => x.id === G.table)) || c.here || c.generic || c.list[0] || null;
  const room = !ch ? undefined : c.generic && ch.id === c.generic.id && !c.here ? undefined : ch.id;
  return { ch, room };
}

function tableCard(app: App, nav: Nav): HTMLElement {
  const S = app.scene, P = app.party, T = tt();
  const { list, here, generic } = tableChoices(app);
  // the chosen setting ('' = where you are, or the generic table when this room has none)
  const { ch: chosen, room: target } = chosenTable(app);
  const active = !!T?.session.active || (S.effective.mode as string) === 'ttrpg';
  const art = h('div', { class: 'gm-art', role: 'img', 'aria-label': 'Tabletop RPG', style: chosen?.thumb ? `background-image:url("${chosen.thumb}")` : 'background:radial-gradient(110% 90% at 30% 20%, #5b3a8a, #1c1630)' },
    h('div', { class: 'fade' }), h('div', { class: 'ttl' }, chosen ? chosen.table : 'The game table', h('small', null, 'Dice, a map, minis and a game master')),
    active ? h('span', { class: 'live' }, h('i'), 'Table open') : null);
  const body = h('div', { class: 'gm-body' },
    h('h3', null, 'Tabletop RPG', h('span', { class: 'who' }, '1–8 players')),
    h('p', { class: 'gm-how' }, 'Everyone walks to the table in your room and sits down: your avatar is your character on stream. Roll dice, read your sheet and say what you do in the TTRPG panel (', h('kbd', null, 'Shift'), '+', h('kbd', null, 'Y'), ').'));
  if (!T) { add(body, h('p', { class: 'note' }, 'The tabletop game isn’t part of this studio build.')); return h('article', { class: 'gm-card', 'aria-label': 'Tabletop RPG' }, art, body); }
  if (active) {
    add(body, h('div', { class: 'gm-running' },
      h('button', { class: 'btn primary', onClick: () => T.panel.open('table') }, 'Open the TTRPG panel'),
      S.canEdit ? h('button', { class: 'btn danger', onClick: () => { if (stageModeDef('ttrpg')) S.setMode('talk'); else T.session.leave(); nav.refresh(); } }, 'Close the table') : null));
    return h('article', { class: 'gm-card', 'aria-label': 'Tabletop RPG' }, art, body);
  }
  if (P.role === 'guest') {
    add(body, h('div', { class: 's-banner', style: 'margin:0' }, h('span', null, '🎲'), h('span', null, 'When the host opens the table, your dice and character sheet appear in the TTRPG panel. You can make your character now.')),
      h('div', { class: 'gm-running' }, h('button', { class: 'btn', onClick: () => T.panel.open('char') }, 'Make my character')));
    return h('article', { class: 'gm-card', 'aria-label': 'Tabletop RPG' }, art, body);
  }
  const opts: [string, string][] = list.map((x) => [x.id, x.label]);
  if (generic) opts.push([generic.id, `${generic.label} (any setting)`]);
  const sel = h('select', { 'aria-label': 'Where to play', onChange: (e: Event) => { G.table = (e.target as HTMLSelectElement).value; ls.set('vtp.games.table', G.table); nav.refresh(); } },
    ...opts.map(([v, l]) => h('option', { value: v, selected: v === chosen?.id }, `${v === here?.id ? '📍 ' : ''}${l}`)));
  add(body,
    opts.length ? h('div', { class: 'gm-opt' }, h('span', null, 'Where'), sel, h('span', { class: 'hint' }, target === undefined ? `Everyone walks over to ${chosen?.table ?? 'the table'}; closing the table takes everyone back.`
      : target !== (here?.id ?? null) ? `Your room changes to ${list.find((x) => x.id === target)?.label.split(': ')[0] ?? 'that setting'} first, then everyone walks to its table.` : '📍 = the room you’re in now. Closing the table takes everyone back to it.')) : null,
    h('div', { class: 'gm-opt' }, h('span', null, 'Game master'),
      seg<GmKind>([['ai', 'AI', 'narrates & voices'], ['human', 'You', 'you run it'], ['none', 'Nobody', 'dice & map only']], G.gm, (v) => { G.gm = v; ls.set('vtp.games.gm', v); nav.refresh(); }),
      h('span', { class: 'hint' }, G.gm === 'ai' ? 'Uses your AI key or a local model (set it in the TTRPG panel → Setup).' : G.gm === 'human' ? 'You sit in the GM’s chair and get the GM tools. In a party you can hand the chair to a friend.' : 'Free play: a practice table with dice, the map and initiative.')),
    h('div', { class: 'gm-play' },
      h('button', { class: 'btn', onClick: () => { openTable(app, target, G.gm); nav.refresh(); } }, 'Play solo', h('small', null, G.gm === 'ai' ? 'you + the AI GM' : G.gm === 'none' ? 'practice table' : 'you run a solo table')),
      h('button', { class: 'btn primary', onClick: () => openLobby(app, nav, 'ttrpg') }, '👥 Play with friends', h('small', null, P.role === 'host' ? `${P.remotes.size + 1} in your party` : 'open a party first'))));
  return h('article', { class: 'gm-card', 'aria-label': 'Tabletop RPG' }, art, body);
}

// ---------------------------------------------------------------- the lobby: open a party → who's in → start
const draft = { code: '', reply: '' };
let lobby: { game: GameId; draw: () => void; close: () => void } | null = null;

function openLobby(app: App, nav: Nav, game: GameId) {
  css();
  lobby?.close();
  const P = app.party;
  const inner = h('div', { class: 'gm-lobby-in' });
  const artBox = h('div');
  const box = h('div', { class: 'gm-lobby', role: 'dialog', 'aria-modal': 'true', 'aria-label': game === 'trail' ? 'Play The Trail with friends' : 'Play the tabletop game with friends' }, artBox, inner);
  const back = h('div', { class: 'gm-lobby-back', onClick: (e: Event) => { if (e.target === back) close(); } }, box);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const onParty = () => draw();
  const iv = window.setInterval(() => draw(), 1000);
  function close() { window.clearInterval(iv); P.listeners.delete(onParty); window.removeEventListener('keydown', onKey, true); back.remove(); if (lobby?.close === close) lobby = null; nav.refresh(); }
  function draw() { if (!back.isConnected) return; rerender(inner, () => build(app, nav, game, inner, close)); }
  artBox.append(game === 'trail' ? trailArt(G.theme, false) : (() => { const { ch } = chosenTable(app); return h('div', { class: 'gm-art', style: ch?.thumb ? `background-image:url("${ch.thumb}")` : '' }, h('div', { class: 'fade' }), h('div', { class: 'ttl' }, 'Tabletop RPG', h('small', null, ch?.table ?? ''))); })());
  P.listeners.add(onParty);
  window.addEventListener('keydown', onKey, true);
  document.body.append(back);
  lobby = { game, draw, close };
  if (Date.now() - dAt > 5000) { dAt = Date.now(); void discord.status().then((s) => { dstatus = s; draw(); }).catch(() => draw()); }
  build(app, nav, game, inner, close);
  setTimeout(() => (inner.querySelector('button.primary, button') as HTMLElement | null)?.focus(), 30);
}

function memberStatus(m: MemberView): { cls: '' | 'ok' | 'warn' | 'err'; text: string } {
  if (m.tv) return { cls: 'ok', text: '📺 on a TV screen' };
  if (m.me) return m.avatar ? { cls: 'ok', text: 'your avatar is shared' } : { cls: 'warn', text: m.why === 'off' ? 'not sharing your avatar' : m.why === 'none' ? 'your avatar is loading' : 'avatar not shared' };
  if (!m.avatar) return { cls: 'err', text: m.why === 'off' ? 'not sharing — shows as a stand-in' : 'no avatar — shows as a stand-in' };
  if (m.ready) return { cls: 'ok', text: 'avatar ready' };
  const x = m.xfer;
  if (x && x.n > 0 && x.got > 0) return { cls: 'warn', text: `avatar arriving ${Math.min(99, Math.round((x.got / x.n) * 100))}%` };
  if (x && ['failed', 'outdated'].includes(x.st)) return { cls: 'err', text: 'avatar didn’t arrive — ask them to resend' };
  return { cls: 'warn', text: m.receiving ? 'avatar arriving…' : 'waiting for their avatar' };
}

function build(app: App, nav: Nav, game: GameId, el: HTMLElement, close: () => void) {
  const P = app.party, st = dstatus;
  const hosting = P.role === 'host';
  const members = P.role === 'none' ? [] : P.view();
  const friends = members.filter((m) => !m.me);
  const title = game === 'trail' ? 'The Trail with friends' : 'Tabletop with friends';
  el.append(h('h2', null, h('span', { class: 'grow' }, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', title: 'Close (Esc)', onClick: close }, '✕')),
    h('p', { class: 'note', style: 'margin:0' }, 'Everyone runs VTube Pro on their own PC and talks in Discord as usual. Up to 8 players.'));
  if (P.role === 'guest') {
    el.append(h('div', { class: 's-banner', style: 'margin:14px 0 0' }, h('span', null, '👋'), h('span', null, 'You’re in ', h('b', null, P.hostInfo?.name ?? 'a friend'), '’s party. The host starts the game; you get a Join prompt.')));
    return;
  }
  // 1 · open the party
  const s1 = h('li', { class: `gm-step ${hosting ? 'done' : 'cur'}` }, h('span', { class: 'n' }, hosting ? '✓' : '1'));
  if (hosting) {
    s1.append(h('div', null, h('b', null, P.via === 'discord' ? 'Your party is live on Discord' : 'Your party is open'),
      P.joinUrl ? h('div', { class: 's-copy' }, h('code', { title: shareLink(P.joinUrl) }, shareLink(P.joinUrl)), h('button', { class: 'btn', onClick: () => { void navigator.clipboard.writeText(shareLink(P.joinUrl)).then(() => toast('Join link copied — paste it in Discord', 'ok'), () => toast('Couldn’t copy (clipboard blocked)', 'err')); } }, 'Copy link'))
        : h('p', { class: 'note' }, 'Invite one more with a new code below, or share your Discord post.'),
      P.via === 'code' ? codeWay(app, true) : null));
  } else {
    const discordWay = h('div', { class: 'gm-way' }, h('b', null, 'Discord'), h('span', null, 'A Join button in your server. Guests click it; nothing to paste.'),
      !st ? h('span', null, 'Checking Discord…')
        : !st.configured ? h('button', { class: 'btn', onClick: () => { close(); nav.wizard('multiplayer'); } }, 'Set up Discord (one time)')
          : !st.signedIn ? h('button', { class: 'btn primary', onClick: () => { discord.login(); toast('Finish signing in in the Discord window, then come back here', 'info', 6000); } }, 'Connect Discord')
            : h('button', { class: 'btn primary', onClick: async () => {
              if (app.observer) { toast('Observer sandbox: parties stay off here', 'warn'); return; }
              try { const r = await goLive(P, st, { channelId: st.channelId, post: !!st.channelId }); toast(r.posted ? 'Invite posted in Discord ✔' : 'Party open — copy the join link', 'ok'); } catch (e) { toast(`Couldn’t open the party: ${(e as Error).message}`, 'err', 7000); }
            } }, st.channelId ? 'Open party · post invite' : 'Open party'));
    s1.append(h('div', null, h('b', null, 'Open your party'), h('p', { class: 'note' }, 'Pick one. You only set Discord up once; codes work without it.'),
      h('div', { class: 'gm-ways' }, discordWay, codeWay(app, false))));
  }
  // 2 · who's in
  const s2 = h('li', { class: `gm-step ${hosting ? (friends.length ? 'done' : 'cur') : ''}` }, h('span', { class: 'n' }, hosting && friends.length ? '✓' : '2'));
  const roster = h('div', { class: 'gm-roster' });
  for (const k of P.knocks) roster.append(h('div', { class: 'gm-knock' }, h('span', { class: 'grow' }, h('b', null, k.user?.name ?? 'Someone'), ' wants to join', k.guildOk ? ' (server member)' : '', k.link ? ' (interview link — name not verified)' : ''),
    h('button', { class: 'btn primary', onClick: () => void P.approve(k) }, 'Let in'), h('button', { class: 'btn', onClick: () => P.deny(k) }, 'Deny')));
  for (const m of members) {
    const s = memberStatus(m);
    roster.append(h('div', { class: 'gm-mem' }, h('span', { class: 'av', style: `background:hsl(${hueOf(m.name)} 45% 38%)`, 'aria-hidden': 'true' }, initialOf(m.name)),
      h('span', { class: 'nm' }, m.name, h('small', null, m.me ? 'you' : m.host ? 'host' : '')),
      h('span', { class: `chip ${s.cls}` }, h('span', { class: 'dot' }), s.text)));
  }
  s2.append(h('div', null, h('b', null, 'Friends join'),
    hosting ? (friends.length ? null : h('p', { class: 'note' }, 'Waiting for friends… They join from your Discord post or code; you can start without them too.')) : h('p', { class: 'note' }, 'Once the party is open, people who join show up here with their avatar status.'),
    members.length ? roster : null));
  // 3 · start
  const notReady = friends.filter((m) => !m.tv && m.avatar && !m.ready).length;
  const n = hosting ? friends.length + 1 : 1;
  const s3 = h('li', { class: `gm-step ${hosting ? 'cur' : ''}` }, h('span', { class: 'n' }, '3'));
  // (read at click time: rerender may keep an identical-looking older tree, with older closures)
  const gmWho = () => { const list = P.role === 'none' ? [] : P.view(); return G.gmWho && list.some((m) => (m.me ? HOST_KEY : m.id) === G.gmWho) ? G.gmWho : HOST_KEY; };
  const who = gmWho();
  s3.append(h('div', null, h('b', null, 'Start'),
    game === 'ttrpg' ? h('div', { class: 'gm-opt' }, h('span', null, 'Game master'),
      seg<GmKind>([['ai', 'AI'], ['human', 'A person'], ['none', 'Nobody']], G.gm, (v) => { G.gm = v; ls.set('vtp.games.gm', v); draw(); }),
      G.gm === 'human' && members.length > 1 ? h('select', { 'aria-label': 'Who runs the game', onChange: (e: Event) => { G.gmWho = (e.target as HTMLSelectElement).value; } },
        ...members.map((m) => { const k = m.me ? HOST_KEY : m.id; return h('option', { value: k, selected: k === who }, m.me ? `${m.name} (you)` : m.name); })) : null) : null,
    notReady ? h('p', { class: 'note', style: 'color:var(--warn)' }, `${notReady} avatar${notReady > 1 ? 's are' : ' is'} still arriving — they pop in when ready. You can start now.`) : null,
    h('button', { class: 'btn primary big', disabled: !hosting, onClick: () => {
      close();
      if (game === 'trail') void startTrail(app, { theme: G.theme, slice: G.slice }).then(() => nav.refresh());
      else openTable(app, chosenTable(app).room, G.gm, G.gm === 'human' ? gmWho() : undefined);
    } }, !hosting ? 'Open a party first' : game === 'trail' ? `▶ Start The Trail · ${n} player${n > 1 ? 's' : ''}` : `🎲 Open the table · ${n} player${n > 1 ? 's' : ''}`),
    h('p', { class: 'note', style: 'margin-top:6px' }, game === 'trail' ? 'Friends get a Join prompt in their studio (they need this update). OBS switches to the game view.' : 'Everyone walks to the table; guests’ TTRPG panels open with their dice and sheets.')));
  el.append(h('ol', { class: 'gm-steps' }, s1, s2, s3));
  function draw() { lobby?.draw(); }
}

/** Invite codes (no Discord): the Multiplayer panel's code flow, compact. */
function codeWay(app: App, hosting: boolean): HTMLElement {
  const P = app.party;
  const out = h('textarea', { readonly: true, rows: 2, placeholder: 'Your invite code shows here', value: draft.code, 'aria-label': 'Your invite code' }) as HTMLTextAreaElement;
  const inp = h('textarea', { rows: 2, placeholder: 'Paste their reply code', value: draft.reply, 'aria-label': 'Reply code', onInput: (e: Event) => (draft.reply = (e.target as HTMLTextAreaElement).value) }) as HTMLTextAreaElement;
  const make = async () => {
    try { draft.code = out.value = await P.createInvite(); out.select(); void navigator.clipboard.writeText(draft.code).catch(() => {}); toast('Code copied — send it to your friend', 'ok'); lobby?.draw(); }
    catch (e) { toast(`Couldn’t make a code: ${(e as Error).message}`, 'err'); }
  };
  const connect = async () => {
    try { await P.acceptReply(inp.value); draft.reply = ''; draft.code = ''; toast('Connected ✔', 'ok'); lobby?.draw(); }
    catch (e) { toast(`That reply didn’t work: ${(e as Error).message}`, 'err'); }
  };
  return h('div', { class: 'gm-way' }, h('b', null, hosting ? 'Invite one more' : 'Invite code'), h('span', null, 'No set-up. One code per friend: send yours, paste their reply.'),
    h('button', { class: 'btn', onClick: () => void make() }, draft.code ? 'New code' : 'Make a code'),
    draft.code ? out : null, draft.code ? inp : null,
    draft.code ? h('button', { class: 'btn primary', onClick: () => void connect() }, 'Connect reply') : null);
}

/** A small "Games" pointer for the Friends view (the hub lives in its own area). */
export function gamesTeaser(nav: Nav): HTMLElement {
  css();
  return h('button', { class: 's-more', onClick: () => nav.go('games' as never) }, h('span', { 'aria-hidden': 'true' }, '🎮'), h('span', null, h('b', null, 'Games'), ' — The Trail and the tabletop RPG, solo or with your party'), h('span', { style: 'margin-left:auto', 'aria-hidden': 'true' }, '→'));
}
