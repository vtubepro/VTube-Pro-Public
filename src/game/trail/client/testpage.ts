// The Trail — PRIVATE test page (trail.html?test=duo|solo on a private vite, never the live studio / bus):
//   duo:  two Party instances in ONE page connected over loopback WebRTC with invite codes (host + guest), a host
//         session (the real sim Worker) + a guest session, two GameViews side by side with scripted players;
//   solo: one host view.
// Params: &theme=bayou &seed=SWAMP-0420 &ha=frog &ga=robot (library stand-in avatars) &hh=1.7 &gh=0.4 (heights)
//         &anim=0 (procedural walk instead of the body clips) · test=anim: the animation lab (animlab.ts)
//         &bots=2 (sim bots that shop / hunt / haul) &river=ford|ferry|caulk &auto=1 (scripted players + auto votes)
// window.trailTest exposes the sessions / views / a log for the CDP harness (S\trail\tools\duo_run.py).
import type { Deck } from '../../../../shared/trail/types.ts';
import { mergeDeck } from '../../../../shared/trail/deck.ts';
import { BTN, type InputFrame, type TrailCtl } from '../../../../shared/trail/wire.ts';
import { Party } from '../../../party.ts';
import type { Bus } from '../../../bus.ts';
import { TrailSession } from '../session.ts';
import { GameView } from './view.ts';
import type { AvatarSource } from './avatars.ts';
import { trailFeeds } from './tvfeeds.ts';
import { pathPoint, roadInfo } from '../../../../shared/trail/procgen.ts';
import { animConfig } from './anim.ts';

type Log = { t: number; who: string; msg: string };
const logs: Log[] = [];
const t0 = performance.now();
const log = (who: string, msg: string) => { logs.push({ t: Math.round(performance.now() - t0), who, msg }); if (logs.length > 4000) logs.shift(); };
const fakeBus = (): Bus => ({ send() {}, on() { return () => true; }, connected: false, id: 'test' } as unknown as Bus);

async function loadDeck(theme: string): Promise<Deck> {
  const raw = async (id: string): Promise<Deck> => {
    const d = await fetch(`/api/trail/${id}/file/deck.json`, { cache: 'no-store' }).then((r) => r.json()) as Deck & { extends?: string };
    return d.extends ? mergeDeck(await raw(d.extends), d) : mergeDeck(d, {});
  };
  return raw(theme);
}

export async function startTest(root: HTMLElement, q: URLSearchParams) {
  // &test=anim: the body animation lab (animlab.ts); &anim=0: the procedural walk instead of the clips (A/B)
  if (q.get('test') === 'anim') return (await import('./animlab.ts')).startAnimLab(root, q);
  animConfig.enabled = q.get('anim') !== '0';
  const duo = q.get('test') === 'duo';
  const theme = q.get('theme') ?? 'frontier';
  const deck = await loadDeck(theme);
  root.style.display = 'grid';
  const spect = q.get('spect') === '1';
  root.style.gridTemplateColumns = duo ? '1fr 1fr' : spect ? '1fr 1fr' : '1fr';
  root.style.gap = '4px';
  const mk = () => { const d = document.createElement('div'); d.style.cssText = 'position:relative;overflow:hidden;background:#000'; root.append(d); return d; };
  const hostBox = mk(), guestBox = duo ? mk() : null;
  const hh = Number(q.get('hh') ?? 1.7), gh = Number(q.get('gh') ?? 0.4);
  const stand: Record<string, string> = {};
  let hostParty: Party | null = null, guestParty: Party | null = null;
  if (duo) {
    hostParty = new Party(fakeBus()); guestParty = new Party(fakeBus());
    hostParty.name = 'Don (host)'; guestParty.name = 'Pip (guest)';
    hostParty.shareMine = false; guestParty.shareMine = false;
    const invite = await hostParty.createInvite();
    const reply = await guestParty.join(invite, false);
    await hostParty.acceptReply(reply);
    log('net', `invite ${invite.length} chars, reply ${reply.length} chars`);
    for (let i = 0; i < 100 && !hostParty.gamePeers().length; i++) await new Promise((r) => setTimeout(r, 100));
    log('net', `host game peers: ${hostParty.gamePeers().join(',')} · guest sees host: ${guestParty.gamePeers().join(',')}`);
  }
  const hostId = hostParty?.myId ?? 'host01';
  stand[hostId] = q.get('ha') ?? 'frog';
  if (guestParty) stand[guestParty.myId] = q.get('ga') ?? 'robot';
  const host = await TrailSession.host({ party: hostParty, theme, slice: true, seed: q.get('seed') ?? 'SWAMP-0420', name: 'Host', height: hh, role: 'banker', deck, persist: false, standalone: true, myId: hostId, bus: null, observeBus: false, ...(q.get('drive') === '1' ? { botDrive: true } : {}) } as Parameters<typeof TrailSession.host>[0]);
  const guest = guestParty ? TrailSession.guest(guestParty, hostId, { standalone: true, guestHeight: gh }) : null;
  const botAv = (q.get('ba') ?? 'frog_v2,robot,frog').split(',');
  // &tv=1: the guest performs as a walking TV (tvguests' TvRuntime; grey-box set until tvart's skins are installed) with
  // a fake live picture (an animated canvas) — the same path a real TV guest takes, minus the network
  const tvId = q.get('tv') === '1' && guestParty ? guestParty.myId : '';
  if (tvId) trailFeeds.inject('tvtest', fakeFeed('Pip TV'));
  const avatarFor = (id: string): AvatarSource => id === tvId ? { kind: 'tv', memberId: id, feedId: 'tvtest', tv: { v: 1, kind: 'webcam', skin: q.get('tvskin') ?? 'retro80', height: gh, aspect: 4 / 3, mirror: false, chroma: null, bg: 'studio', fit: 'cover' } } : (stand[id] ? { kind: 'lib' as const, avatarId: stand[id] } : id.startsWith('bot') && botAv[Number(id.slice(3)) % botAv.length] !== 'none' ? { kind: 'lib' as const, avatarId: botAv[Number(id.slice(3)) % botAv.length] } : { kind: 'none' as const });
  const auto = q.get('auto') === '1';
  const views: GameView[] = [];
  const attach = (s: TrailSession, box: HTMLElement, who: string) => {
    let view: GameView | null = null;
    const pending: TrailCtl[] = [];
    const pilot = new Pilot(who, q.get('river') ?? 'ford', Number(q.get('dwell') ?? 140), who === 'host' && q.get('hdrive') === '1');
    const link = s.connect({
      onCtl: (m) => { if (m.k === 'ev' && m.e.e === 'toast') log(who, `toast ${m.e.text}`); if (m.k === 'ev' && m.e.e === 'death') log(who, `DEATH ${m.e.name}: ${m.e.cause}`); if (m.k === 'level') log(who, `level ${m.id} (${m.ents.length} ents)`); view ? view.onCtl(m) : pending.push(m); },
      onSnap: (sn) => view?.onSnap(sn),
    });
    view = new GameView(box, { link: { myId: link.myId, isHost: link.isHost, sendInput: (f) => link.sendInput(f), sendCmd: (c) => { log(who, `cmd ${JSON.stringify(c)}`); link.sendCmd(c); } }, avatarFor, shadows: q.get('shadows') !== '0', script: auto ? (v) => pilot.frame(v, link.sendCmd) : undefined });
    for (const m of pending) view.onCtl(m);
    view.start();
    views.push(view);
    return view;
  };
  const hv = attach(host, hostBox, 'host');
  const gv = guest && guestBox ? attach(guest, guestBox, 'guest') : null;
  // &spect=1 (solo): a stream-spectator panel next to the host view (the OBS director camera + stream HUD)
  let sv: GameView | null = null;
  if (spect && !duo) {
    const box = mk();
    const pend: TrailCtl[] = [];
    const link = host.connect({ onCtl: (m) => (sv ? sv.onCtl(m) : pend.push(m)), onSnap: (sn) => sv?.onSnap(sn) });
    sv = new GameView(box, { spectator: true, link: { myId: '', isHost: false, sendInput: () => {}, sendCmd: () => {} }, avatarFor, shadows: q.get('shadows') !== '0' });
    for (const m of pend) sv.onCtl(m);
    sv.start();
    views.push(sv);
  }
  const bots = Number(q.get('bots') ?? (duo ? 1 : 2));
  const botH = [1.7, 3.2, 1.1, 0.5];
  for (let i = 0; i < bots; i++) host.addBot(`bot${i}`, ['Big Tony', 'Mira', 'Gus', 'Tiny'][i % 4], botH[i % botH.length], (['carpenter', 'hunter', 'medic', 'whisperer'] as const)[i % 4]);
  (window as unknown as { trailTest: unknown }).trailTest = {
    host, guest, hv, gv, views, logs, hostParty, guestParty,
    state: () => hv.state, start: () => hv.o.link.sendCmd({ c: 'start' }),
    cmd: (c: never, who: 'host' | 'guest' = 'host') => (who === 'host' ? hv : gv)?.o.link.sendCmd(c),
    perf: () => ({ sim: host.perf, views: views.map((v) => v.stats) }),
    net: () => ({ host: hostParty?.view().map((m) => ({ name: m.name, stats: m.stats })), guestPeers: guestParty?.gamePeers() }),
  };
  log('test', `ready: ${duo ? 'duo' : 'solo'} theme ${theme}`);
}

/** Scripted player: votes, readies, walks to where the action is, grabs / shoots / sits. Crude on purpose. */
class Pilot {
  private dwell: Record<string, number> = {};
  private seq = 0; private t = 0; private voted = ''; private ready = ''; private yaw = 0; private pitch = -0.1; private started = false; private bought = '';
  constructor(readonly who: string, readonly river: string, readonly dwellStore = 140, readonly drives = false) {}
  frame(v: GameView, cmd: (c: never) => void): InputFrame | null {
    this.t += 1 / 60;
    const st = v.state;
    const f: InputFrame = { seq: (this.seq = (this.seq + 1) & 0xffff), mx: 0, mz: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0, hold: 0 };
    if (!st) return f;
    const me = v.ents.players().get(v.o.link.myId)?.cur;
    // votes: river choice by param, hunting yes, everything else the first enabled option
    const vote = st.vote;
    if (vote && this.voted !== vote.id && Math.random() < 0.02) {
      this.voted = vote.id;
      const want = vote.kind === 'river' ? this.river : vote.id === 'hunt_offer' ? 'hunt' : vote.id === 'store_leave' ? 'leave' : '';
      const opt = vote.options.find((o) => o.id === want && !o.disabled) ?? vote.options.find((o) => !o.disabled);
      if (opt) cmd({ c: 'vote', opt: opt.id } as never);
    }
    if (st.phase === 'lobby' && v.o.link.isHost && !this.started && this.t > 3) { this.started = true; cmd({ c: 'start' } as never); }
    if (st.card && v.o.link.isHost && Math.random() < 0.004) cmd({ c: 'continue' } as never);
    const stop = st.stop;
    const key = `${st.phase}:${stop?.kind}:${stop?.title}`;
    if (stop && (stop.kind === 'store' || stop.kind === 'landmark' || stop.kind === 'camp') && this.ready !== key && this.t > 1) {
      if (stop.kind === 'store' && v.o.link.isHost && this.bought !== key) { this.bought = key; cmd({ c: 'buy', item: 'food', n: 4 } as never); cmd({ c: 'buy', item: 'draft', n: 4 } as never); cmd({ c: 'buy', item: 'ammo', n: 3 } as never); cmd({ c: 'buy', item: 'wheel', n: 1 } as never); }
      this.dwell[key] = (this.dwell[key] ?? 0) + 1 / 60;
      if (this.dwell[key] > (stop.kind === 'store' ? this.dwellStore : 20) && Math.random() < 0.01) { this.ready = key; cmd({ c: v.o.link.isHost ? 'continue' : 'ready', on: true } as never); }
    }
    if (!me) return f;
    // &hdrive=1: the host player takes the reins and drives along the road (a scripted human driver: real inputs)
    const J = st.journey, wv = v.ents.wagon();
    if (this.drives && J && st.phase === 'travel' && wv && v.terrain) {
      const wq = wv.cur.q, fx = 2 * (wq.x * wq.z + wq.w * wq.y), fz = 1 - 2 * (wq.x * wq.x + wq.y * wq.y), head = Math.atan2(fx, fz);
      if (J.driver === v.o.link.myId) {
        const o = v.terrain.origin, wx = wv.cur.p.x + o[0], wz = wv.cur.p.z + o[1];
        const r = roadInfo(v.terrain.plan, wx, wz, 60);
        if (r) {
          const pt = pathPoint(v.terrain.plan.paths[r.path], r.s + 10);
          const want = Math.atan2(pt.x - wx, pt.z - wz);
          const d = Math.atan2(Math.sin(want - head), Math.cos(want - head));
          f.mx = Math.max(-1, Math.min(1, -d * 2.4)); f.mz = 1;
          if (Math.abs(d) < 0.15 && Math.random() < 0.3) f.buttons |= BTN.sprint;
        }
        if (J.bogged) f.buttons |= BTN.sprint;
        return f;
      }
      if (!J.driver || J.driver.startsWith('bot')) {
        // walk to the bench (front of the wagon) and press E
        const bx = wv.cur.p.x + fx * 1.0 + fz * 2.1, bz = wv.cur.p.z + fz * 1.0 - fx * 2.1;   // (beside the front bench)
        const dx = bx - me.p.x, dz = bz - me.p.z;
        if (me.flags & 4) { if (Math.random() < 0.05) f.buttons |= BTN.use; return f; }   // (seated elsewhere: hop off first)
        if (Math.hypot(dx, dz) > 1.2) { this.yaw = Math.atan2(-dx, -dz); f.mz = 1; f.yaw = this.yaw; f.buttons |= BTN.sprint; }
        else if (Math.random() < 0.1) f.buttons |= BTN.use;
        return f;
      }
    }
    // steering target per situation
    const w = v.ents.wagon()?.cur.p;
    let target: { x: number; z: number } | null = null;
    const p = me.p;
    if (stop?.kind === 'river' && this.river === 'ford') { const fz = v.world.level?.zones.find((z) => z.name === 'farbank'); target = fz ? { x: fz.p[0] + (this.who === 'guest' ? -4 : 2), z: fz.p[2] } : { x: 0, z: 15 }; }
    else if (stop?.kind === 'hunt') {
      let best: { x: number; z: number; d: number } | null = null;
      for (const e of v.ents.map.values()) if (e.info.kind === 'animal' && !e.info.sub.startsWith('carcass')) { const d = e.cur.p.distanceTo(p); if (!best || d < best.d) best = { x: e.cur.p.x, z: e.cur.p.z, d }; }
      // (floating-island levels: a scripted player can't see gaps, so it only walks where the level has no fall-out zone high up)
      const islands = v.world.level?.zones.some((z) => z.name === 'kill') && v.world.theme === 'skyisles';
      if (best) { target = best.d > 10 && !islands ? best : null; this.aimAt(p, { x: best.x, y: 0.4, z: best.z }); if (best.d < 28 && Math.random() < 0.08) f.buttons |= BTN.fire; }
    } else if (stop?.kind === 'landmark') target = { x: this.who === 'guest' ? 1 : -1, z: -4 };
    else if (stop?.kind === 'event' && stop.notes.some((n) => n.startsWith('goal:'))) { const g = stop.notes.find((n) => n.startsWith('goal:'))!.slice(5).split(',').map(Number); target = { x: g[0], z: g[2] }; f.buttons |= BTN.sprint | BTN.use; }
    else if (stop?.kind === 'event' && w) { target = { x: w.x - 1.2, z: w.z + 1.4 }; f.buttons |= BTN.use; }
    else if (stop?.kind === 'store') { target = { x: Math.sin(this.t * 0.3) * 6, z: 2 + Math.cos(this.t * 0.2) * 3 }; if (Math.random() < 0.01) f.buttons |= BTN.jump; }
    else if (st.phase === 'travel' && w && !(me.flags & 4) && Math.random() < 0.5) { target = { x: w.x, z: w.z }; f.buttons |= BTN.sprint; if (me.p.distanceTo(w) < 3) f.buttons |= BTN.use; }
    if (target) {
      const dx = target.x - p.x, dz = target.z - p.z;
      if (Math.hypot(dx, dz) > 0.8) { this.yaw = Math.atan2(-dx, -dz); f.mz = 1; }
    }
    f.yaw = this.yaw; f.pitch = this.pitch;
    return f;
  }
  private aimAt(p: { x: number; y: number; z: number }, t: { x: number; y: number; z: number }) {
    const dx = t.x - p.x, dz = t.z - p.z, dy = t.y - (p.y + 0.6);
    this.yaw = Math.atan2(-dx, -dz); this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }
}

/** A fake webcam for the TV test: colour bars, a bouncing name and a clock (canvas.captureStream). */
function fakeFeed(name: string): MediaStream {
  const c = document.createElement('canvas'); c.width = 320; c.height = 240;
  const g = c.getContext('2d')!;
  const bars = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff'];
  const draw = () => {
    const t = performance.now() / 1000;
    bars.forEach((b, i) => { g.fillStyle = b; g.fillRect(i * 320 / 7, 0, 320 / 7 + 1, 240); });
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 90 + Math.sin(t * 2) * 50, 320, 60);
    g.fillStyle = '#fff'; g.font = 'bold 30px system-ui'; g.textAlign = 'center';
    g.fillText(name, 160, 130 + Math.sin(t * 2) * 50);
    g.font = '16px monospace'; g.fillText(t.toFixed(1), 160, 230);
  };
  draw(); setInterval(draw, 50);
  return c.captureStream(20);
}
