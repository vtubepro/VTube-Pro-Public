// Party games → The Trail (studio launcher, OBS tab under Multiplayer). The host picks a theme + run length and starts;
// party guests with this update get a "join the game" prompt. The game itself is lazy-loaded (src/game/trail/*).
import type { App } from '../app.ts';
import { avatarSize } from '../../shared/avatarSize.ts';
import type { RoleId } from '../../shared/trail/types.ts';
import { button, h, section, select, toast, toggle } from './dom.ts';

export type TrailTheme = { id: string; name: string; personal: boolean };
let themes: TrailTheme[] | null = null;
let theme = localStorage.getItem('vtp.trail.theme') ?? 'frontier';
let slice = localStorage.getItem('vtp.trail.slice') !== '0';

// ---- rescue hooks, installed once the studio app exists: the `trail` bus command (Stream Deck: POST /api/command
// {command:'trail', args:{end:true}}), and game messages that arrive while this studio has no session (after a reload:
// guests still showing a game report 'here'; a guest's studio gets the host's hello → join prompt, as before).
let rescueOn = false;
function installRescue() {
  const app = (window as unknown as { vtp?: App }).vtp;
  if (!app?.party || !app.bus) { setTimeout(installRescue, 1500); return; }
  if (rescueOn) return;
  rescueOn = true;
  app.bus.on((m) => {
    if (m.type !== 'command' || m.command !== 'trail') return;
    const a = (m.args ?? {}) as { end?: unknown; leave?: unknown; open?: unknown };
    if (a.end || a.leave) void import('../game/trail/session.ts').then((g) => g.trailRescue.endAll(app.party.role === 'none' ? null : app.party, app.bus));
    else if (a.open) void import('../game/trail/session.ts').then((g) => g.TrailSession.current?.openOverlay());
  });
  // the party's game lane while no session holds it: host → note orphans; guest → the usual join prompt
  setInterval(() => {
    const p = app.party;
    if (p.onGame) return;
    p.onGame = (from, d) => void import('../game/trail/session.ts').then((g) => {
      if (g.TrailSession.current) return;
      if (p.role === 'guest') g.guestReceive(p, from, d); else if (p.role === 'host') g.trailRescue.orphanMessage(p, from, d);
    });
  }, 2000);
}
setTimeout(installRescue, 500);

export function trailSection(app: App): HTMLElement {
  const box = h('div');
  const draw = async () => {
    box.replaceChildren();
    const mod = (window as unknown as { vtpTrail?: { session?: { role: string; status: string; openOverlay(): void; end(): void; quit(): void; perf: { stepMs: number } } } }).vtpTrail;
    const s = mod?.session;
    if (s) {
      box.append(
        h('p', { class: 'note' }, s.status || 'A game is running.'),
        h('div', { class: 'btns' },
          button('Open the game view', () => s.openOverlay()),
          s.role === 'host' ? button('⏹ End game for everyone', () => { s.quit(); void draw(); }, 'danger') : button('🚪 Leave game', () => { s.quit(); void draw(); }, 'danger')),
        h('p', { class: 'note' }, `Physics ${s.perf.stepMs.toFixed(2)} ms / step (in a worker — tracking unaffected). OBS shows the spectator view automatically while the game runs.`),
      );
      return;
    }
    if (app.party.role === 'guest') {
      box.append(h('p', { class: 'note' }, 'When the host starts The Trail you get a “Join” prompt here in the studio.'),
        h('div', { class: 'btns' }, trailJoinButton(app)));
      return;
    }
    const rescue = (await import('../game/trail/session.ts')).trailRescue;
    rescue.onChange = () => void draw();
    if (rescue.orphans.size) box.append(h('p', { class: 'note' }, `A game is still showing for ${rescue.orphans.size} guest(s) (this studio reloaded).`),
      h('div', { class: 'btns' }, button('⏹ End it for everyone', () => { rescue.endAll(app.party, app.bus); void draw(); }, 'danger')));
    const opts = (await trailThemes()).map((t) => [t.id, t.name] as [string, string]);
    if (!opts.some((o) => o[0] === theme)) theme = opts[0][0];
    box.append(
      select('Theme', theme, opts, (v) => { theme = v; localStorage.setItem('vtp.trail.theme', v); }),
      toggle('Short run (vertical slice, ~15 min)', slice, (v) => { slice = v; localStorage.setItem('vtp.trail.slice', v ? '1' : '0'); }),
      h('div', { class: 'btns' }, button('▶ Start The Trail', () => void start())),
      h('p', { class: 'note' }, 'An Oregon-Trail party game for everyone in your party (or solo): your own tracked avatar, your real size, one very bad wagon. Guests need this update. WASD + mouse, E interact, LMB grab, 1–5 vote.'),
    );
  };
  const start = async () => { await startTrail(app, { theme, slice }); void draw(); };
  const onGame = () => { if (box.isConnected) void draw(); else document.removeEventListener(TRAIL_EVENT, onGame); };
  document.addEventListener(TRAIL_EVENT, onGame);
  void draw();
  return section('Party games — The Trail', box);
}

/** Fired on document whenever a game started from here changes (status, ended). */
export const TRAIL_EVENT = 'vtp-trail';

/** The theme packs (GET /api/trail/themes; the neutral Frontier Trail when the server has none). Cached. */
export async function trailThemes(): Promise<TrailTheme[]> {
  if (!themes) themes = await fetch('/api/trail/themes').then((r) => (r.ok ? r.json() : [])).catch(() => []) as TrailTheme[];
  return themes.length ? themes : [{ id: 'frontier', name: 'The Frontier Trail', personal: false }];
}

/** The running game (host or guest), if any: the lazily loaded session's public bits. */
export function trailRunning(): { role: string; status: string; openOverlay(): void; end(): void; perf: { stepMs: number } } | null {
  return (window as unknown as { vtpTrail?: { session?: { role: string; status: string; openOverlay(): void; end(): void; perf: { stepMs: number } } } }).vtpTrail?.session ?? null;
}

/** Bot names / sizes / jobs for "Play solo" helpers (the sim's own bot brain plays them; they show as stand-ins). */
const BOTS: [string, number, RoleId][] = [['Big Tony', 1.7, 'carpenter'], ['Mira', 1.6, 'hunter'], ['Gus', 1.1, 'medic']];

/** Start The Trail as the host: with the party (everyone in it gets the join prompt) or solo (`solo`: just you, plus
 *  0–3 sim bots). The one start path for every launcher (this section, the Games hub). */
export async function startTrail(app: App, o: { theme: string; slice: boolean; solo?: boolean; bots?: number }): Promise<{ onChange: () => void; addBot(id: string, name: string, height: number, role?: RoleId): void } | null> {
  try {
    const { TrailSession } = await import('../game/trail/session.ts');
    const p = app.party;
    const size = p.myTv ? { height: p.myTv.height } : avatarSize(p.myAvatar);   // a walking TV (tvguests): its set's height
    const withParty = p.role === 'host' && !o.solo;
    const s = await TrailSession.host({ party: withParty ? p : null, theme: o.theme, slice: o.slice, name: p.members.find((m) => m.id === p.myId)?.name ?? p.name, height: size.height, bus: p.gameBus(), observeBus: true, persist: !app.observer });
    const bots = withParty ? 0 : Math.max(0, Math.min(BOTS.length, Math.round(o.bots ?? 0)));
    s.onChange = () => document.dispatchEvent(new CustomEvent(TRAIL_EVENT));   // (every launcher redraws on it)
    for (let i = 0; i < bots; i++) s.addBot(`bot${i}`, BOTS[i][0], BOTS[i][1], BOTS[i][2]);
    s.openOverlay();
    toast(`The Trail started${bots ? ` with ${bots} bot${bots > 1 ? 's' : ''}` : ''} — OBS switches to the game view`, 'ok');
    return s;
  } catch (e) { toast(`Couldn't start The Trail: ${(e as Error).message}`, 'err', 7000); return null; }
}

/** Guest: "Join the running game" — asks the host for it and opens it straight away (no prompt needed). */
export function trailJoinButton(app: App): HTMLElement {
  return button('▶ Join the running game', () => void import('../game/trail/session.ts').then((g) => g.joinRunningGame(app.party)), 'primary');
}
