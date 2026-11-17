// Scene tab → mode bar → Interview (talk show): the line-up (co-hosts at the desk with you; guests — party members on
// the monitor or in the guest chairs, video guests from a call window), the director (auto / manual, pace, reactions), shot buttons + hotkeys, the show
// open, the sidekick, the video guests' voice meter, and the OBS passthrough helper. Everything is the host's stage-mode
// bag SceneState.modes.interview (shared/talkshow.ts) — every OBS page and party guest gets the same show.
//
// Hotkeys (studio): Ctrl+Shift+1 … 9 = shots, Ctrl+Shift+0 = back to the auto director, Ctrl+Shift+B = show open,
// Ctrl+Shift+P = pin the shot on air / unpin, Ctrl+Shift+G = the guest's turn.
// Stream Deck / scripts: POST http://127.0.0.1:5191/api/command {"command":"interview","args":{"shot":"guest"}}
// (also {"bumper":true}, {"director":"auto"|"manual"}, {"pin":true|false}, {"floor":"guest"|"host"|"g0"…|""},
// {"pace":"calm"|"normal"|"snappy"}) — the studio applies it. The director itself runs in ../interviewHost.ts.
import { registerModePanel } from '../panelCore.ts';
import type { App } from '../../../app.ts';
import type { SceneController } from '../../../scene/controller.ts';
import { button, h, select, slider, toast, toggle } from '../../dom.ts';
import { forScripts } from '../../forScripts.ts';
import { INTERVIEW_MODE, MAX_COHOSTS, MAX_GUESTS, MAX_PANELS, SHOT_LABELS, guestPlace, interviewCutOf, lineupFind, moveInLineup, planLineup, roleOf, roomCoverage, roomInterviewConfig, sanitizeInterview, setLineupRole, type InterviewBag, type InterviewGuest, type ShotId } from '../../../../shared/talkshow.ts';
import { HOST_KEY } from '../../../../shared/scene.ts';
import { tvOfKey } from '../../../net/tv/tvStudio.ts';
import { guestLinkBox } from '../../guestLink.ts';
import type { ObsPlaceReport } from '../../../../shared/obs.ts';
import { interviewHost } from '../interviewHost.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
const bagOf = (S: SceneController) => sanitizeInterview((S as unknown as BagApi).modeBag?.(INTERVIEW_MODE));
function setBag(S: SceneController, fn: (b: InterviewBag) => void) {
  const b = structuredClone(bagOf(S));
  fn(b);
  (S as unknown as BagApi).setModeBag?.(INTERVIEW_MODE, sanitizeInterview(b));
}

/** Cut to a shot (every page takes it now; auto director resumes ~4 s later). The subject the studio's own director gives
 *  it (a push-in on whoever is on air) goes in the bag too: every page — a reloaded OBS source — cuts to the same person. */
export function cutTo(S: SceneController, shot: ShotId, extra?: { cam?: string; aud?: 'r' | 'w' | 'a'; subject?: string }) {
  let subject = extra?.subject ?? '';
  if (!subject) try { const e = liveEngine(); subject = e?.director?.cutSubject?.(shot) ?? ''; } catch { subject = ''; }
  setBag(S, (b) => {
    b.shot = shot; b.cutSeq++; if (subject) b.subject = subject; else delete b.subject;
    // ("House wide" / "Audience": a wide on a room camera / the audience - the bag carries which, every page cuts to the same)
    if (extra?.cam) b.cam = extra.cam; else delete b.cam;
    if (extra?.aud) b.aud = extra.aud; else delete b.aud;
  });
}
/** The studio's own interview engine (this window, else the Scene-tab preview page): its director's cut subject. */
function liveEngine(): { director?: { cutSubject?: (shot: ShotId) => string } | null } | null {
  const w = window as unknown as { vtpInterview?: unknown };
  return (w.vtpInterview as never) ?? (previewEngine() as never) ?? null;
}
export function showOpen(S: SceneController) { setBag(S, (b) => { b.bumperSeq++; }); }

/** A button with a tooltip (and optionally disabled). */
const tb = (text: string, fn: () => void, cls = '', title = '', disabled = false) => { const b = button(text, fn, cls); if (title) b.title = title; if (disabled) b.disabled = true; return b; };
/** A TV performer's own look (walking TV / projector screen), for where they show by default. */
const lookOfKey = (app: App, key?: string) => { const t = key ? tvOfKey(app.party, key) : null; return t ? (t.look ?? 'tv') : null; };
/** Guests who sit in the studio walk to the room's guest chairs (in guest order); co-hosts sit at the desk — the page
 *  seats them (src/scene/talkshow/engine.ts), never in a guest chair. */
function seatStudioGuests(app: App, S: SceneController) {
  const st = S.effective;
  const info = S.scenes.find((x) => x.id === st.sceneId) as unknown as { interview?: unknown } | undefined;
  const cfg = roomInterviewConfig(st.sceneId ?? '', info?.interview);
  const idx = (n: string) => { const m = /^SPOT_(\d{2})$/.exec(n); return m ? +m[1] - 1 : -1; };
  const chairs = (cfg.guests ?? []).map(idx).filter((i) => i >= 0);
  const nb = bagOf(S);
  planLineup(nb, (g) => { const l = lookOfKey(app, g.key); return l ? { tv: true, look: l } : null; })
    .filter((x) => x.role === 'guest' && x.kind !== 'video' && x.g.key && x.place === 'studio')
    .forEach((x, n) => { if (chairs[n] !== undefined) S.move(x.g.key!, chairs[n]); });
}
/** Co-host ↔ guest (Live Control / Stream Deck / the line-up editor): never drops anyone — a full role says so. */
function setRole(app: App, S: SceneController, at: { i?: unknown; key?: unknown; who?: unknown }, role: 'cohost' | 'guest' | 'toggle') {
  let err = '';
  const b0 = bagOf(S), i = lineupFind(b0.guests, at);
  if (i < 0) { toast('Interview: they are not in the line-up', 'warn'); return; }
  setBag(S, (b) => { const r = setLineupRole(b.guests, i, role); err = r.error ?? ''; b.guests = r.guests; });
  if (err) { toast(`Interview: ${err}`, 'warn'); return; }
  seatStudioGuests(app, S);
}

const HOTKEY_SHOTS: ShotId[] = ['establishing', 'host', 'guest', 'ots', 'two', 'sidekick', 'push', 'snap', 'reverse'];
const CROPS: [string, string, [number, number, number, number] | null][] = [
  ['full', 'Whole window', null], ['l2', 'Left half', [0, 0, 0.5, 1]], ['r2', 'Right half', [0.5, 0, 0.5, 1]],
  ['l3', 'Left third', [0, 0, 1 / 3, 1]], ['m3', 'Middle third', [1 / 3, 0, 1 / 3, 1]], ['r3', 'Right third', [2 / 3, 0, 1 / 3, 1]],
  ['tl', 'Top-left quarter', [0, 0, 0.5, 0.5]], ['tr', 'Top-right quarter', [0.5, 0, 0.5, 0.5]], ['bl', 'Bottom-left quarter', [0, 0.5, 0.5, 0.5]], ['br', 'Bottom-right quarter', [0.5, 0.5, 0.5, 0.5]],
];
const cropId = (c?: [number, number, number, number]) => CROPS.find((x) => JSON.stringify(x[2]) === JSON.stringify(c ?? null))?.[0] ?? 'full';

/** The video callers' voices (the studio's director measures them: ../interviewHost.ts). */
const meterOf = () => interviewHost()?.meter ?? null;

/** Someone's turn (the operator): a pinned shot is unpinned first — the turn is a cut the director then keeps. */
function giveFloor(S: SceneController, id: string): string {
  if (bagOf(S).director === 'manual') setBag(S, (b) => { b.director = 'auto'; });
  return interviewHost()?.floor(id) ?? '';
}

/** Manual / pinned (every way in: the panel, Ctrl+Shift+P, the deck's manual / pin, Live Control): the manual director
 *  keeps exactly the shot on air NOW — never a stale bag shot from the last hotkey; off = back to auto. */
export function pinShot(S: SceneController, on: boolean) {
  if (!on) { setBag(S, (b) => { b.director = 'auto'; }); return; }
  const oa = interviewHost()?.onAir();
  setBag(S, (b) => { b.director = 'manual'; if (oa) { b.shot = oa.shot; b.cutSeq++; if (oa.subject) b.subject = oa.subject; else delete b.subject; } });
}

// ---------------------------------------------------------------- hotkeys + Stream Deck commands (installed once)
let installed = false;
/** Once per studio (../interviewHost.ts mountInterviewHost, at start): hotkeys + the bus commands (Stream Deck, Live
 *  Control, Ctrl+K) work before the panel was ever opened. */
export function installInterviewControls(app: App) {
  if (installed) return;
  installed = true;
  const S = app.scene;
  const inMode = () => (S.effective.mode as string) === INTERVIEW_MODE && S.canEdit;
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return;
    if ((e.target as HTMLElement)?.closest?.('input,textarea,select')) return;
    const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
    if (!inMode()) return;
    if (digit !== undefined) {
      e.preventDefault();
      if (digit === '0') { setBag(S, (b) => { b.director = 'auto'; }); toast('Interview: auto director', 'ok', 1200); return; }
      const shot = HOTKEY_SHOTS[+digit - 1];
      if (shot) { cutTo(S, shot); toast(`Cut: ${SHOT_LABELS[shot]}`, 'ok', 900); }
    } else if (e.code === 'KeyB') { e.preventDefault(); showOpen(S); toast('Show open!', 'ok', 1200); }
    else if (e.code === 'KeyP') { e.preventDefault(); const pin = bagOf(S).director !== 'manual'; pinShot(S, pin); toast(pin ? 'Interview: shot pinned' : 'Interview: auto director', 'ok', 1200); }
    else if (e.code === 'KeyG') { e.preventDefault(); const id = giveFloor(S, 'guest'); toast(id ? 'Interview: the guest’s turn' : 'Interview: no guest on the show yet', id ? 'ok' : 'warn', 1200); }
  });
  app.bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'interview' || !inMode()) return;
    const a = (m.args ?? {}) as Record<string, unknown>;
    // (an older version passes "house" / "audience" / "take" through unchanged: interviewCutOf reads them like a newer one's plan)
    const cut = interviewCutOf(a);
    if (cut) cutTo(S, cut.shot, cut.extra);
    if (a.bumper === true) showOpen(S);
    if (a.director === 'auto' || a.director === 'manual') pinShot(S, a.director === 'manual');
    if (a.pin === true || a.pin === false) pinShot(S, a.pin);
    if (typeof a.floor === 'string' && /^(guest|host|gv|c[01]|g[0-3]|)$/.test(a.floor)) giveFloor(S, a.floor);
    if (a.pace === 'calm' || a.pace === 'normal' || a.pace === 'snappy') setBag(S, (b) => { b.pace = a.pace as 'calm' | 'normal' | 'snappy'; });
    const pl = a.place as { i?: unknown; key?: unknown; where?: unknown } | undefined; // livedash: Live Control / Stream Deck "Guest: studio / monitor"
    if (pl && (pl.where === 'studio' || pl.where === 'monitor')) {
      const i = lineupFind(bagOf(S).guests, pl);
      const g = bagOf(S).guests[i];
      if (g && g.kind !== 'video' && roleOf(g) === 'guest') { setBag(S, (b) => { b.guests[i].place = pl.where as 'studio' | 'monitor'; }); seatStudioGuests(app, S); }
    }
    const ro = a.role as { i?: unknown; key?: unknown; who?: unknown; role?: unknown } | undefined; // "Co-host / guest"
    if (ro && (ro.role === 'cohost' || ro.role === 'guest' || ro.role === 'toggle')) setRole(app, S, ro, ro.role);
  });
}

/** The Scene-tab preview page (same origin): its interview engine, for the OBS fit numbers. */
function previewEngine(): { fitInfo(i: number, aspect: number): { rect: { x: number; y: number; w: number; h: number }; quad: [number, number][] } | null; debug(): { layout?: string[]; shot?: { shot: string; subject: string; why: string } | null } } | null {
  for (const f of document.querySelectorAll('iframe')) {
    try { const w = (f as HTMLIFrameElement).contentWindow as unknown as { vtpInterview?: unknown } | null; if (w?.vtpInterview) return w.vtpInterview as never; } catch { /* other origin */ }
  }
  return null;
}

registerModePanel(INTERVIEW_MODE, (app, S) => {
  installInterviewControls(app);
  const meter = meterOf();
  const bag = bagOf(S);
  const edit = S.canEdit;
  const st = S.effective;
  const info = S.scenes.find((x) => x.id === st.sceneId) as unknown as { interview?: unknown } | undefined;
  const cfg = roomInterviewConfig(st.sceneId ?? '', info?.interview);
  const box = h('div', { class: 'iv-panel' });
  if (!edit) { box.append(h('p', { class: 'note' }, 'The host runs the interview — your OBS shows the same show.')); return box; }
  const eng = previewEngine();
  const dbg = eng?.debug();
  box.append(h('p', { class: 'note' }, h('b', null, '📺 Interview: '), 'you at the desk, guests on the big monitor (or in the guest chairs), Sprocket on the band stand, and a director that cuts on whoever is talking.',
    dbg?.shot ? h('span', null, ' · On air: ', h('b', null, SHOT_LABELS[dbg.shot.shot] ?? dbg.shot.shot), ` (${dbg.shot.why})`) : null));

  // ---- show
  const title = h('input', { type: 'text', value: bag.title, maxLength: 40, placeholder: 'Show title', onChange: (e: Event) => setBag(S, (b) => { b.title = (e.target as HTMLInputElement).value; }) });
  box.append(h('h4', { style: 'margin:10px 0 4px' }, 'The show'),
    h('label', { class: 'row', title: 'On the desk plate, the monitor’s stand-by card and the show-open title card' }, h('span', { class: 'lbl' }, 'Show title'), title),
    h('div', { class: 'btns tight' }, button('🎬 Show open (Ctrl+Shift+B)', () => showOpen(S), 'primary'),
      // guestlink: placement is per guest (Guests below); these two only set everyone at once
      button('Set all: 🪑 in studio', () => setAll('studio')), button('Set all: 📺 on the monitor', () => setAll('monitor'))),
    h('p', { class: 'note' }, 'Pick for each guest below: 🪑 In studio (seated in the room as their avatar / TV) or 📺 On the monitor (“live via satellite”: an avatar from its own little studio, a webcam guest’s live picture). Video guests are always on the monitor.'));

  // ---- the line-up: co-hosts (at the desk with you) + guests (the monitor / the guest chairs)
  const lookOf = (key?: string) => lookOfKey(app, key);
  /** Put guest i in the studio (walks to a free guest chair) or on the monitor (their panel powers on). */
  const place = (i: number, where: 'studio' | 'monitor' | '') => {
    setBag(S, (b) => { if (where) b.guests[i].place = where; else delete b.guests[i].place; });
    seatStudioGuests(app, S);
  };
  function setAll(where: 'studio' | 'monitor') {
    setBag(S, (b) => { b.layout = where === 'studio' ? 'seated' : 'monitor'; for (const g of b.guests) if (g.kind !== 'video' && roleOf(g) === 'guest') g.place = where; });
    if (where === 'studio') seatStudioGuests(app, S);
  }
  const plan = planLineup(bag, (g) => { const l = lookOf(g.key); return l ? { tv: true, look: l } : null; });
  const nCo = plan.filter((x) => x.role === 'cohost').length, nGu = plan.length - nCo;
  const onMon = plan.filter((x) => x.panel >= 0).length;
  /** Up / down within the same role (the order numbers Co-host 1, 2 and Guest 1…4 — their camera buttons). */
  const move = (i: number, dir: -1 | 1) => setBag(S, (b) => {
    const same = b.guests.map((g, k) => ({ g, k })).filter((x) => roleOf(x.g) === roleOf(b.guests[i])).map((x) => x.k);
    const at = same.indexOf(i), j = same[at + dir];
    if (j === undefined) return;
    let out = b.guests;
    for (let k = i; k !== j; k += Math.sign(j - i)) out = moveInLineup(out, k, Math.sign(j - i) as -1 | 1);
    b.guests = out;
  });
  const members = S.members().filter((m) => m.key !== HOST_KEY && !bag.guests.some((g) => g.key === m.key));
  const row = (x: (typeof plan)[number]) => {
    const g = x.g, i = x.i, co = x.role === 'cohost';
    const same = plan.filter((q) => q.role === x.role), at = same.indexOf(x);
    const r = h('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap', 'data-lineup': String(i) },
      h('b', { title: co ? `Co-host ${x.n}: the “Co-host ${x.n}” camera` : `Guest ${x.n}: the “Guest ${x.n}” camera` }, co ? `C${x.n}` : `${x.n}.`),
      h('input', { type: 'text', value: g.name, maxLength: 32, style: 'width:9em', title: 'Name on the lower third', onChange: (e: Event) => setBag(S, (b) => { b.guests[i].name = (e.target as HTMLInputElement).value; }) }),
      h('span', { class: 'note' }, x.kind === 'video' ? 'video' : x.kind === 'tv' ? 'TV (their live picture)' : 'avatar'),
      // one click: guest ↔ co-host (video callers are always guests on the monitor)
      x.kind !== 'video' ? tb(co ? 'Make guest' : '★ Make co-host', () => setRole(app, S, { i }, co ? 'guest' : 'cohost'), '',
        co ? 'Back to a guest (the monitor / a guest chair)' : nCo >= MAX_COHOSTS ? `Up to ${MAX_COHOSTS} co-hosts` : 'Co-host: sits with you at the desk, gets their own camera and the hosts / panel shots', !co && nCo >= MAX_COHOSTS) : null,
      !co && x.kind !== 'video' ? select('Where', g.place ?? '', [['', `Their choice (${guestPlace(bag, { ...g, place: undefined }, lookOf(g.key)) === 'studio' ? 'in studio' : 'on the monitor'})`], ['studio', '🪑 In studio'], ['monitor', '📺 On the monitor']], (v) => place(i, v as 'studio' | 'monitor' | ''), 'In studio: seated in the room. On the monitor: their picture on the show’s screen.') : null,
      co ? h('span', { class: 'note' }, x.place === 'monitor' ? '📺 on the monitor (projector screen)' : '🎙 at the desk') : null,
      x.overflow ? h('span', { class: 'note', title: `The monitor shows ${MAX_PANELS} people at most` }, '(monitor full: in studio)') : null,
      x.kind === 'video' ? select('Their part of the window', cropId(g.crop), CROPS.map(([id, label]) => [id, label] as [string, string]), (v) => setBag(S, (b) => { const c = CROPS.find((q) => q[0] === v)?.[2]; if (c) b.guests[i].crop = c; else delete b.guests[i].crop; }), 'Which part of the shared call window is this guest (a tile of a call grid)') : null,
      at > 0 ? tb('↑', () => move(i, -1), '', 'Earlier') : null,
      at < same.length - 1 ? tb('↓', () => move(i, 1), '', 'Later') : null,
      tb('✕', () => setBag(S, (b) => { b.guests.splice(i, 1); }), '', 'Remove from the line-up'));
    return r;
  };
  const coList = h('div', { class: 'iv-guests iv-cohosts' }, ...plan.filter((x) => x.role === 'cohost').map(row));
  const list = h('div', { class: 'iv-guests' }, ...plan.filter((x) => x.role === 'guest').map(row));
  // (a new party member is a guest — or a co-host when all the guest places are taken)
  const canAdd = nGu < MAX_GUESTS || nCo < MAX_COHOSTS;
  const add = canAdd ? h('div', { class: 'btns tight' },
    members.length ? select('Add a party member', '', [['', '— pick —'], ...members.map((m): [string, string] => [m.key, m.name])], (k) => {
      const m = members.find((q) => q.key === k);
      if (m) setBag(S, (b) => { b.guests.push({ kind: tvOfKey(app.party, m.key) ? 'tv' : 'performer', key: m.key, name: m.name.replace(/ \(.*\)$/, '').slice(0, 32), ...(nGu >= MAX_GUESTS ? { role: 'cohost' } : {}) } as InterviewGuest); });
    }, 'Their live avatar joins the show as a guest (on the monitor, or in a guest chair). ★ Make co-host puts them at the desk with you.') : h('span', { class: 'note' }, 'No party members to add (invite them in Multiplayer).'),
    nGu < MAX_GUESTS && bag.guests.filter((g) => g.kind === 'video').length < MAX_PANELS ? button('+ Video guest', () => setBag(S, (b) => { b.guests.push({ kind: 'video', name: `Caller ${b.guests.filter((g) => g.kind === 'video').length + 1}` }); }), '') : null)
    : h('p', { class: 'note' }, `Full: ${MAX_COHOSTS} co-hosts and ${MAX_GUESTS} guests.`);
  box.append(h('h4', { style: 'margin:10px 0 4px' }, `At the desk with you${nCo ? '' : ' (co-hosts)'}`),
    nCo ? coList : h('p', { class: 'note' }, 'No co-host yet. ★ Make co-host on a guest below seats them beside you at the desk (up to 2).'),
    h('h4', { style: 'margin:10px 0 4px' }, 'Guests'), list,
    h('p', { class: 'note' }, `The monitor shows up to ${MAX_PANELS} people (${onMon} now); more guests sit in the studio.`),
    add, guestLinkBox(app));

  // ---- director
  const on = (s: string) => (bag.shot === s && bag.director === 'manual' ? 'active' : '');
  const cover = roomCoverage(S.scenes.find((x) => x.id === S.effective.sceneId));
  const shots = h('div', { class: 'btns tight', style: 'flex-wrap:wrap' },
    ...HOTKEY_SHOTS.map((s, i) => button(`${i + 1} ${SHOT_LABELS[s].replace(/ \(.*\)$/, '')}`, () => cutTo(S, s), on(s))),
    // per person: co-hosts, then guests (their own camera), + the hosts / panel shots with co-hosts
    ...plan.filter((x) => x.role === 'cohost').map((x) => tb(`🎙 ${x.g.name}`, () => cutTo(S, `cohost${x.n}` as ShotId), on(`cohost${x.n}`), `Co-host ${x.n}`)),
    ...(nCo ? [tb('Hosts', () => cutTo(S, 'hosts'), on('hosts'), SHOT_LABELS.hosts), ...(nCo > 1 ? [tb('Panel', () => cutTo(S, 'panel'), on('panel'), SHOT_LABELS.panel)] : [])] : []),
    ...plan.filter((x) => x.role === 'guest').map((x) => tb(`${x.g.name}`, () => cutTo(S, `guest${x.n}` as ShotId), on(`guest${x.n}`), `Guest ${x.n}`)),
    // the room's own cameras (its scene.json: audience, house wide): only the ones this room has
    ...(cover?.audience || cover?.sections.length ? [tb('👥 Audience', () => cutTo(S, 'wide', { aud: 'w' }), bag.shot === 'wide' && bag.aud === 'w' && bag.director === 'manual' ? 'active' : '', 'The chat audience')] : []),
    ...(cover?.house ? [tb('🏛 House wide', () => cutTo(S, 'wide', { cam: cover.house! }), bag.shot === 'wide' && bag.cam === cover.house && bag.director === 'manual' ? 'active' : '', 'The whole set from the house camera')] : []));
  box.append(h('h4', { style: 'margin:10px 0 4px' }, 'Director'),
    select('Director', bag.director, [['auto', 'Auto — cuts on who is speaking'], ['manual', 'Manual — only my cuts']], (v) => pinShot(S, v === 'manual'), 'Auto: talk-show pacing, reaction shots after punchlines, no ping-pong. A button / hotkey cut is held ~4 s, then auto takes over again.'),
    select('Pace', bag.pace, [['calm', 'Calm (long holds)'], ['normal', 'Normal'], ['snappy', 'Snappy']], (v) => setBag(S, (b) => { b.pace = v; })),
    toggle('Reaction cutaways after punchlines / laughs', bag.reactions, (v) => setBag(S, (b) => { b.reactions = v; })),
    toggle('Slow push-ins on long answers', bag.pushIns, (v) => setBag(S, (b) => { b.pushIns = v; })),
    toggle('Comedic snap zooms (rare)', bag.snaps, (v) => setBag(S, (b) => { b.snaps = v; })),
    toggle('Cut to the chat audience (laugh waves, big cheers and raids, “Answer now”)', bag.crowdCuts !== false, (v) => setBag(S, (b) => { if (v) delete b.crowdCuts; else b.crowdCuts = false; })),
    toggle('Use the room’s own cameras (house wide, cutaways, band camera)', bag.roomCams !== false, (v) => setBag(S, (b) => { if (v) delete b.roomCams; else b.roomCams = false; })),
    liveDirector(S, plan.filter((x) => x.role === 'guest').map((x) => ({ id: x.id, name: x.g.name }))),
    shots, h('p', { class: 'note' }, 'Hotkeys: Ctrl+Shift+1…9 = these shots, Ctrl+Shift+0 = back to auto, Ctrl+Shift+P = pin the shot on air, Ctrl+Shift+G = the guest’s turn.'),
    forScripts('Stream Deck: POST http://127.0.0.1:5191/api/command with {"command":"interview","args":{"shot":"guest"}} (or "bumper": true, "pin": true / false, "floor": "guest" / "host", "pace": "snappy").'));

  // ---- sidekick
  box.append(h('h4', { style: 'margin:10px 0 4px' }, 'Sidekick'),
    toggle('Sprocket on the band stand', bag.sidekick, (v) => setBag(S, (b) => { b.sidekick = v; }), 'He follows the conversation, laughs on punchlines and gets reaction shots. (The chat buddy steps out while the interview runs.)'));

  // ---- video guests: source, voice meter, OBS
  if (bag.guests.some((g) => g.kind === 'video')) {
    const vid = bag.guests.map((g, i) => ({ g, i })).filter((x) => x.g.kind === 'video');
    const meterRows = h('div');
    void Promise.all([navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]), import('../../audioMixerPanel.ts').then((m) => m.studioMixer()?.inputRows() ?? []).catch(() => [])]).then(([ds, mixIns]) => {
      if (!meter) return;
      const ins = (ds as MediaDeviceInfo[]).filter((d) => d.kind === 'audioinput');
      // (the audio mixer's sound inputs first: a call app already routed into the studio there needs no second capture)
      const mix = (mixIns as { id: string; label: string }[]).map((m): [string, string] => [`mix:${m.id}`, `🎚 ${m.label} (audio mixer)`]);
      vid.forEach((x, vi) => {
        meterRows.append(select(`${x.g.name}’s voice`, meter.devices[vi] ?? '', [['', 'Guess (while nobody else talks)'], ...mix, ...ins.map((d): [string, string] => [d.deviceId, d.label || 'Audio input'])], (v) => {
          void meter.set(vi, v || null).then(() => setBag(S, (b) => { b.meter = meter.on; })).catch((e) => toast(`Audio input: ${(e as Error).message}`, 'err'));
        }, 'Where this caller’s voice comes in: the call app’s sound through a loopback / virtual cable (or a sound input of the audio mixer). Without one, the director guesses: the caller talks while you and the other guests are quiet.'));
      });
    }).catch(() => {});
    const fit = h('div', { class: 'btns tight' }, ...vid.map((x) => button(`Fit my Window Capture → ${x.g.name}`, () => {
      const e = previewEngine();
      const w = parseInt(localStorage.getItem('vtp.scene.obsW') || '1920', 10), hh = parseInt(localStorage.getItem('vtp.scene.obsH') || '1080', 10);
      const r = e?.fitInfo(x.i, w / hh);
      if (!r) { toast('Turn the Scene preview on first (the numbers come from it).', 'warn'); return; }
      // (its own route, not a React hole report: React holds a capture to an exact fit, this close-up is turned a touch
      // towards the host, so the click places the closest box and says how far off it is — server/obs.ts placeAt)
      void fetch('/api/obs/place', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rect: r.rect, quad: r.quad, layout: 'big', aspect: w / hh }) })
        .then((res) => res.json()).then((j: ObsPlaceReport) => {
          if (!j.ok) { toast(`OBS: ${j.error ?? 'the capture was not placed'}`, 'warn', 8000); return; }
          const off = j.offPx ?? 0;
          toast(off > 6 ? `OBS: the Window Capture now sits on the monitor panel (its close-up shot) — up to ${off} px off at the corners, since that shot is at a slight angle. The free obs-shaderfilter plugin + Perspective corner-pin makes it exact.`
            : 'OBS: the Window Capture now sits on the monitor panel (its close-up shot).', 'ok', 8000);
        })
        .catch(() => toast('Could not reach the server.', 'err'));
    })));
    const nums = vid.map((x) => { const r = eng?.fitInfo(x.i, 16 / 9); return r ? `${x.g.name}: x ${(r.rect.x * 100).toFixed(1)}% y ${(r.rect.y * 100).toFixed(1)}% · ${(r.rect.w * 100).toFixed(1)}×${(r.rect.h * 100).toFixed(1)}% of the frame` : null; }).filter(Boolean).join(' · ');
    box.append(h('h4', { style: 'margin:10px 0 4px' }, 'Video guests'),
      select('Picture', bag.video, [['auto', 'Auto — the shared window if any, else the OBS hole'], ['window', 'Shared window (in-scene)'], ['hole', 'OBS passthrough hole']], (v) => setBag(S, (b) => { b.video = v; }),
        'Shared window: Show → React screen → Pick a window (e.g. your Discord call); each caller shows their tile (set “their part of the window” above). It shows in every shot. OBS hole: a Window Capture under the browser source, visible only in that caller’s close-up.'),
      meterRows,
      h('p', { class: 'note' }, 'OBS passthrough setup: add a Window Capture of the call BELOW the VTube Pro browser source. The monitor panel opens a see-through hole only in that caller’s close-up (a fixed capture lines up with exactly one shot); in the other shots the panel shows an “on the line” card. With OBS automation on, the button below places the capture for you (only when you click it).', nums ? h('br') : null, nums || null),
      fit);
  }
  if (dbg?.layout?.length) box.append(h('p', { class: 'note' }, 'Set: ', dbg.layout.join(' · ')));
  void slider;
  return box;
});

// ---------------------------------------------------------------- live director: why this shot (studio only, never on stream)
const SRC_LABEL: Record<string, string> = { mic: 'mic', meter: 'call audio', mouth: 'camera mouth, no mic', guess: 'guessing', none: 'no mic or camera', off: 'not on yet' };
/** The auto director's live readout + its controls: the shot on air and why, how long until it moves on, who it hears
 *  talking (and what it ignores); 📌 Pin / ▶ Auto; 🎤 a guest's turn. Refreshes 4× a second while shown. */
function liveDirector(S: SceneController, guests: { id: string; name: string }[]): HTMLElement {
  const line = h('div', { class: 'note', style: 'min-height:2.6em' });
  const who = h('div', { class: 'btns tight', style: 'flex-wrap:wrap;gap:4px' });
  const pin = button('📌 Pin this shot', () => { const on = bagOf(S).director !== 'manual'; pinShot(S, on); toast(on ? 'Pinned: this shot stays until you unpin' : 'Auto director', 'ok', 1400); });
  pin.title = 'Keep the shot on air now (the director stops cutting) · Ctrl+Shift+P';
  const turns = h('div', { class: 'btns tight', style: 'flex-wrap:wrap' },
    ...guests.map((g) => tb(`🎤 ${g.name}’s turn`, () => { const id = giveFloor(S, g.id); if (!id) toast(`${g.name} isn’t on the show yet`, 'warn', 1400); }, '', `Cut to ${g.name} now and keep them as the speaker for ~25 s (when the director can’t hear them) · Ctrl+Shift+G`)),
    tb('🎙 My turn', () => { giveFloor(S, 'host'); }, '', 'Cut to you now and keep you as the speaker for ~25 s'));
  const tip = h('div', { class: 'note', style: 'display:none' }, 'Tip: under “Video guests” pick where the caller’s voice comes in (the call app through a virtual cable, or an audio mixer input) — then the director hears them instead of guessing.');
  const box = h('div', { class: 'iv-live', style: 'border:1px solid var(--line, #8884);border-radius:8px;padding:6px 8px;margin:6px 0' },
    h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', null, '🎬 Live director'), pin), line, who, turns, tip);
  const draw = () => {
    const r = interviewHost()?.explain();
    const pinned = bagOf(S).director === 'manual';
    pin.textContent = pinned ? '▶ Back to auto' : '📌 Pin this shot';
    if (!r || !r.on) { line.textContent = 'Starts when Interview mode is on.'; who.replaceChildren(); return; }
    if (!r.leading) { line.textContent = 'Another studio window is directing this show (only one does).'; who.replaceChildren(); return; }
    const label = SHOT_LABELS[r.shot] ?? r.shot;
    const next = pinned ? 'pinned' : r.manual ? 'your cut' : `${r.held.toFixed(0)} s on air · moves on by ~${r.cap} s`;
    line.replaceChildren(h('span', null, 'On air: ', h('b', null, label)), ` — ${r.why || '…'} (${next})`);
    tip.style.display = r.people.some((p) => p.src === 'guess') ? '' : 'none';
    who.replaceChildren(...r.people.map((p) => {
      const c = h('span', { class: 'chip', style: `padding:1px 7px;border-radius:9px;border:1px solid var(--line, #8884);${p.talking ? 'background:#2a7a3b;color:#fff' : 'opacity:.85'}`, title: p.note || '' },
        `${p.talking ? '🗣' : '·'} ${p.name}: ${p.talking ? 'talking' : 'quiet'} (${SRC_LABEL[p.src] ?? p.src})${p.note ? ' ⚠' : ''}`);
      return c;
    }));
  };
  draw();
  const timer = window.setInterval(() => { if (!box.isConnected) { clearInterval(timer); return; } draw(); }, 250);
  return box;
}
