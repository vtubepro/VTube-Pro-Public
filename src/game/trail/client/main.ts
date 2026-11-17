// The Trail — game page (trail.html). Modes:
//   ?view=play   a player's view inside the studio (full-window overlay iframe; talks to the studio's session through
//                window.parent.vtpTrail; avatars + tracking frames from this PC's bus, party avatars from the sealed vault)
//   ?view=obs    the stream spectator (mounted by output.html while a game runs; everything from the bus)
//   ?test=duo    PRIVATE test page: two Party instances in one page over loopback WebRTC (invite codes), a host
//                session (sim Worker) + a guest session, two views side by side, scripted players. Never on the live bus.
//   ?test=solo   PRIVATE: one host view (+ sim bots) for render checks.
import '../../../storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import '../../../licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import '../../../net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import * as THREE from 'three';
import type { BusMessage, PartyMember } from '../../../../shared/types.ts';
import { Bus } from '../../../bus.ts';
import { partyView } from '../../../net/partyView.ts';
import type { TrailCtl, Snapshot, InputFrame } from '../../../../shared/trail/wire.ts';
import { BTN } from '../../../../shared/trail/wire.ts';
import { GameView, type ViewLink } from './view.ts';
import type { AvatarSource } from './avatars.ts';
import { sanitizeTvInfo, type TvInfo } from '../../../../shared/tv.ts';
import { mirrorParentFeeds } from './tvfeeds.ts';
import { installPageSilence } from '../../../audio/silentPage.ts';

const q = new URLSearchParams(location.search);
const root = document.getElementById('game') as HTMLElement;
const mode = q.get('test') ? 'test' : q.get('view') === 'obs' ? 'obs' : 'play';
// the OBS view is silent (every sound plays in the studio / the players' own game windows): src/audio/silentPage.ts
if (mode === 'obs') installPageSilence();
(window as unknown as { THREE: typeof THREE }).THREE = THREE;

/** Performers who appear as a walking TV (tvguests: `PartyMember.tv`, the studio's own `tvSelf`): game id → feed + info. */
const tvMembers = new Map<string, { feedId: string; tv: TvInfo }>();
const tvSource = (id: string): AvatarSource | null => { const t = tvMembers.get(id); return t ? { kind: 'tv', memberId: id, feedId: t.feedId, tv: t.tv } : null; };

if (mode === 'play') startPlay();
else if (mode === 'obs') startObs();
else void import('./testpage.ts').then((m) => m.startTest(root, q));

// ---------------------------------------------------------------- the player's view (studio overlay)
function startPlay() {
  const host = (window.parent !== window ? window.parent : window.opener) as (Window & { vtpTrail?: { connect(p: unknown): ViewLink & { close(): void } } }) | null;
  const api = host?.vtpTrail;
  if (!api) { root.innerHTML = '<p style="color:#fff;font:600 18px system-ui;padding:40px">Open The Trail from the studio (the Games area).</p>'; return; }
  let selfAvatar = localStorage.getItem('vtp.lastAvatar') ?? '';
  const pending: TrailCtl[] = [];
  let view: GameView | null = null;
  const link = api.connect({ onCtl: (m: TrailCtl) => (view ? view.onCtl(m) : pending.push(m)), onSnap: (s: Snapshot) => view?.onSnap(s), onClose: () => close() });
  const members = new Set<string>();
  const session = () => (window.parent as unknown as { vtpTrail?: { session?: { quit(): void; hideOverlay(): void } } }).vtpTrail?.session;
  const menu = gameMenu(link.isHost, () => session()?.hideOverlay(), () => session()?.quit());
  view = new GameView(root, {
    menu: () => menu.toggle(),
    link: { myId: link.myId, isHost: link.isHost, sendInput: (f) => link.sendInput(f), sendCmd: (c) => link.sendCmd(c) },
    avatarFor: (id): AvatarSource => tvSource(id) ?? (id === link.myId ? (selfAvatar ? { kind: 'self', avatarId: selfAvatar } : { kind: 'none' }) : members.has(id) ? { kind: 'party', memberId: id } : { kind: 'none' }),
  });
  for (const m of pending.splice(0)) view.onCtl(m);
  view.start();
  (window as unknown as { trailView?: GameView }).trailView = view; // read-only debugging / test handle
  wireBus(view, link.myId, (id) => { selfAvatar = id; view?.refreshAvatars(); }, (ids) => { for (const i of ids) members.add(i); view?.refreshAvatars(); });
  addCloseButton(() => session()?.hideOverlay(), link.isHost, () => menu.confirmQuit());
  const close = () => { view?.dispose(); link.close(); };
  window.addEventListener('pagehide', close);
}

// ---------------------------------------------------------------- the stream spectator (OBS)
function startObs() {
  const bus = new Bus('output');
  const members = new Set<string>();
  let selfAvatar = localStorage.getItem('vtp.lastAvatar') ?? '';
  let myId = '';
  const view = new GameView(root, {
    spectator: true,
    link: { get myId() { return myId; }, isHost: false, sendInput: () => {}, sendCmd: () => {} } as ViewLink,
    avatarFor: (id): AvatarSource => tvSource(id) ?? (members.has(id) ? { kind: 'party', memberId: id } : id === myId && selfAvatar ? { kind: 'self', avatarId: selfAvatar } : { kind: 'none' }),
  });
  bus.on((m: BusMessage) => {
    if (m.type !== 'trail') return;
    if (m.k === 'ctl') { const d = m.d as TrailCtl; if (d.k === 'hello') myId = d.host; view.onCtl(d); }
    else if (m.k === 'snap') view.onSnap(m.d as Snapshot);
  });
  // ask the studio for a catch-up (hello + level + state)
  const sync = () => bus.send({ type: 'trail', k: 'sync' });
  setTimeout(sync, 400); setTimeout(sync, 1500);
  wireBus(view, '', (id) => { selfAvatar = id; view.refreshAvatars(); }, (ids) => { for (const i of ids) members.add(i); view.refreshAvatars(); }, bus, () => myId);
  // TV performers' live pictures: mirrored from output.html's own feeds (this page is its iframe)
  mirrorParentFeeds(() => [...tvMembers.values()].map((t) => t.feedId));
  window.addEventListener('pagehide', () => { view.dispose(); bus.close(); });
  view.start();
  (window as unknown as { trailView?: GameView }).trailView = view; // read-only debugging / test handle
}

/** Tracking frames + party members (sealed avatars) from this PC's bus → the view. */
function wireBus(view: GameView, myId: string, onSelf: (avatarId: string) => void, onMembers: (ids: string[]) => void, busIn?: Bus, getMyId?: () => string) {
  const bus = busIn ?? new Bus('output');
  let src: string | null = null, srcAt = 0;
  let sig = '';
  bus.on((m: BusMessage) => {
    // one publisher at a time (like output.ts): the studio that runs this game
    const from = (m as { src?: string }).src;
    if ((m.type === 'frame' || m.type === 'party' || m.type === 'load' || m.type === 'pvoice') && from) {
      const now = performance.now();
      if (!src || now - srcAt > 2500) src = from;
      if (from !== src) return;
      srcAt = now;
    }
    const self = getMyId ? getMyId() : myId;
    if (m.type === 'frame') {
      if (m.peer) { partyView.frame(m.peer, m.frame, m.net, performance.now()); view.pushFrame(m.peer, m.frame); }
      else view.pushFrame(self, m.frame, m.ts, m.seq);
    } else if (m.type === 'pvoice') partyView.voice(m.peer, m.v, performance.now());
    else if (m.type === 'party') {
      const changed = partyView.update((m.members as PartyMember[]).slice(0, 7));
      // TV performers: members with `tv` + this PC's own (`tvSelf`, keyed by my game id)
      const s = JSON.stringify([m.members.map((x) => [x.id, x.sealed?.rev ?? -1, x.tv ?? 0]), m.tvSelf ?? 0, self]);
      if (s !== sig) {
        tvMembers.clear();
        for (const x of m.members) { const tv = sanitizeTvInfo(x.tv); if (tv) tvMembers.set(x.id, { feedId: x.id, tv }); }
        const st = sanitizeTvInfo(m.tvSelf);
        if (st && m.tvSelf?.id && self) tvMembers.set(self, { feedId: m.tvSelf.id, tv: st });
      }
      if (s !== sig || changed.size) { sig = s; onMembers(m.members.filter((x) => x.sealed).map((x) => x.id)); if (changed.size) view.refreshAvatars(true); }
    } else if (m.type === 'load') onSelf(m.avatarId);
  });
}

function addCloseButton(onClose: () => void, isHost: boolean, onQuit: () => void) {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:14px;top:14px;z-index:50;display:flex;gap:8px';
  const btn = (text: string, title: string, bg: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = text; b.title = title;
    b.style.cssText = `background:${bg};color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:10px;padding:6px 12px;font:700 13px system-ui;cursor:pointer`;
    b.onclick = fn;
    return b;
  };
  bar.append(
    btn(isHost ? '⏹ End game' : '🚪 Leave game', isHost ? 'End The Trail for everyone (Ctrl+Shift+E twice)' : 'Leave The Trail (your player leaves the game)', 'rgba(179,38,30,.85)', onQuit),
    btn('✕ Studio', 'Back to the studio (the game keeps running)', 'rgba(0,0,0,.6)', onClose));
  document.body.append(bar);
}

/** The game menu (Esc when the mouse is free / the halt card): resume, studio, leave / end — with a confirm step. */
function gameMenu(isHost: boolean, toStudio: () => void, quit: () => void) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;z-index:60;display:none;place-items:center;background:rgba(0,0,0,.55);font:600 16px system-ui;color:#fff';
  const card = document.createElement('div');
  card.style.cssText = 'background:#15181c;border-radius:18px;padding:22px 26px;min-width:320px;display:flex;flex-direction:column;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)';
  wrap.append(card);
  document.body.append(wrap);
  const mk = (text: string, bg: string, fn: () => void) => { const b = document.createElement('button'); b.textContent = text; b.style.cssText = `background:${bg};color:#fff;border:0;border-radius:12px;padding:11px 16px;font:800 15px system-ui;cursor:pointer;text-align:left`; b.onclick = fn; return b; };
  let open = false;
  const show = (confirmStep: boolean) => {
    card.replaceChildren();
    const h = document.createElement('h2'); h.style.cssText = 'margin:0 0 6px;font-size:20px';
    if (!confirmStep) {
      h.textContent = 'The Trail — menu';
      card.append(h, mk('▶ Resume', '#2b3138', () => set(false)), mk('✕ Back to the studio (game keeps running)', '#2b3138', () => { set(false); toStudio(); }),
        mk(isHost ? '⏹ End game for everyone…' : '🚪 Leave game…', '#b3261e', () => show(true)));
    } else {
      h.textContent = isHost ? 'End The Trail for everyone?' : 'Leave The Trail?';
      const p = document.createElement('p'); p.style.cssText = 'margin:0 0 6px;opacity:.8;font-weight:500';
      p.textContent = isHost ? 'The game closes for the whole party and every OBS goes back to the room.' : 'Your player leaves the game; the others keep playing. You can rejoin from Friends → Party games.';
      card.append(h, p, mk(isHost ? '⏹ Yes, end it for everyone' : '🚪 Yes, leave', '#b3261e', () => { set(false); quit(); }), mk('Cancel', '#2b3138', () => show(false)));
    }
  };
  const set = (on: boolean, confirmStep = false) => { open = on; wrap.style.display = on ? 'grid' : 'none'; if (on) { if (document.pointerLockElement) document.exitPointerLock(); show(confirmStep); } };
  // Ctrl+Shift+E: straight to the confirm (twice = do it)
  let hotAt = 0;
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyE') { e.preventDefault(); e.stopPropagation(); const now = performance.now(); if (open && now - hotAt < 4000) { set(false); quit(); return; } hotAt = now; set(true, true); }
    else if (open && e.code === 'Escape') { e.stopPropagation(); set(false); }
  }, true);
  return { toggle: () => set(!open), confirmQuit: () => set(true, true) };
}
export type { InputFrame };
export const BUTTONS = BTN;
