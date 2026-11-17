// The Trail — the studio-side session (TECH.md §1, §4). Lazy-loaded (never in the studio bundle until a game starts).
//   HOST:  sim Worker (Rapier, 60 Hz) ⇄ this session ⇄ party guests ('game' ctl JSON + 0x54 / 0x49 rt packets)
//                                               ⇄ local views (the studio's game overlay: trail.html?view=play)
//                                               → this PC's OBS pages over the bus ({type:'trail'}: spectator view)
//   GUEST: host ⇄ this session ⇄ local views; → this PC's OBS pages.
// Views connect through window.vtpTrail.connect(port) (same-origin iframe). Nothing here touches avatar data: the game
// only knows each player's size + name; avatars reach the game pages through the party's sealed-vault flow as usual.
import type { Party } from '../../party.ts';
import { Bus } from '../../bus.ts';
import type { BusMessage, TrackingFrame } from '../../../shared/types.ts';
import { avatarSize } from '../../../shared/avatarSize.ts';
import type { Deck, GameState, Grave, RoleId, RunState } from '../../../shared/trail/types.ts';
import {
  PKT_INPUT, PKT_SNAP, TRAIL_PROTO, decodeInputs, decodeSnapshot, encodeInputs, encodeSnapshot, sanitizeFromGuest, sanitizeFromHost,
  type EntInfo, type InputFrame, type Snapshot, type TrailCmd, type TrailCtl,
} from '../../../shared/trail/wire.ts';
import { liteOf } from './client/decklite.ts';
import { WAGON, buildLevel, levelJobs, type LevelDesc, type WagonSpec } from '../../../shared/trail/levels.ts';
import { levelFromGlb, wagonFromGlb } from '../../../shared/trail/glbLevel.ts';
import type { FromWorker, ToWorker } from './sim/worker.ts';
import { toast } from '../../ui/dom.ts';

/** A guest session with no word from the host for this long is stale: its prompt / overlay close. */
const HOST_SILENT_MS = 20000;

export interface ViewPort { onCtl(m: TrailCtl): void; onSnap(s: Snapshot): void; onClose?(): void }
export interface GameLinkApi { myId: string; isHost: boolean; sendInput(f: InputFrame): void; sendCmd(c: TrailCmd): void; close(): void }
export interface HostOpts {
  party: Party | null; theme: string; slice: boolean; seed?: string; name: string; height: number; role?: RoleId;
  /** This PC's bus (OBS relay + frame observer); null in tests. */
  bus?: Bus | null; observeBus?: boolean;
  /** Persist graves / run history on this PC (off in tests). */
  persist?: boolean;
  /** Test harness: a ready deck (skips the server). */
  deck?: Deck;
  /** Custom id (tests: two parties in one page). */
  myId?: string;
  /** Tests: don't register as the page's session (two sessions in one page). */
  standalone?: boolean;
  /** Tests: the guest's height override (else the shared avatar's real size). */
  guestHeight?: number;
  log?: (s: string) => void;
}

/** What a newly connected view (or OBS page) needs to catch up. */
class Catchup {
  hello: TrailCtl | null = null;
  level: Extract<TrailCtl, { k: 'level' }> | null = null;
  ents = new Map<number, EntInfo>();
  state: GameState | null = null;
  apply(m: TrailCtl) {
    if (m.k === 'hello') this.hello = m;
    else if (m.k === 'level') { this.level = m; this.ents = new Map(m.ents.map((e) => [e.id, e])); }
    else if (m.k === 'spawn') for (const e of m.ents) this.ents.set(e.id, e);
    else if (m.k === 'despawn') for (const id of m.ids) this.ents.delete(id);
    else if (m.k === 'state') this.state = m.s;
  }
  replay(): TrailCtl[] {
    const out: TrailCtl[] = [];
    if (this.hello) out.push(this.hello);
    if (this.level) out.push({ ...this.level, ents: [...this.ents.values()] });
    if (this.state) out.push({ k: 'state', s: this.state });
    return out;
  }
}

export class TrailSession {
  static current: TrailSession | null = null;
  readonly views = new Set<ViewPort>();
  readonly catchup = new Catchup();
  role: 'host' | 'guest';
  myId: string;
  hostId: string;
  private worker: Worker | null = null;
  private guests = new Set<string>();
  private pollT = 0;
  private obsBus: Bus | null = null;
  private watchBus: Bus | null = null;
  private inputs: InputFrame[] = [];
  private lastGuestState = 0;
  private pendingGuestState: GameState | null = null;
  private guestStateT = 0;
  private voice = new Map<string, { vad: number; expr: number; face: Record<string, number> | null; at: number }>();
  private voiceT = 0;
  private guestRate = new Map<string, { tok: number; at: number }>();
  perf = { stepMs: 0, maxStepMs: 0, bodies: 0 };
  overlay: HTMLIFrameElement | null = null;
  status = '';
  onChange: () => void = () => {};
  private runPosted = false;
  private sessionId = Math.random().toString(36).slice(2, 10);
  /** Guest: the host session we're in (from its hello) + when the host was last heard. */
  private hostSession = '';
  private lastHostAt = performance.now();
  private aliveT = 0;
  private prompt: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private ended = false;

  private constructor(role: 'host' | 'guest', readonly party: Party | null, myId: string, hostId: string, readonly o: Partial<HostOpts> = {}) {
    this.role = role; this.myId = myId; this.hostId = hostId;
    if (!o.standalone) {
      TrailSession.current = this;
      (window as unknown as { vtpTrail: unknown }).vtpTrail = { connect: (p: ViewPort) => this.connect(p), session: this };
    }
  }

  // ================================================================ HOST
  static async host(o: HostOpts): Promise<TrailSession> {
    if (TrailSession.current && !o.standalone) TrailSession.current.end();
    const myId = o.myId ?? o.party?.myId ?? 'host';
    const s = new TrailSession('host', o.party, myId, myId, o);
    const deck = o.deck ?? await fetch(`/api/trail/${encodeURIComponent(o.theme)}/deck`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`deck ${r.status}`)))) as Deck;
    const graves = o.persist === false ? [] : await fetch('/api/trail/graveyard', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as Grave[];
    s.obsBus = o.bus ?? null;
    const levels = await loadThemeLevels(deck, o.log ?? ((x) => console.info('trail:', x)));
    const wagon = await loadThemeWagon(deck, o.log ?? ((x) => console.info('trail:', x)));
    const w = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
    s.worker = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => s.fromWorker(e.data);
    w.onerror = (e) => { s.status = `Game error: ${e.message}`; s.onChange(); };
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('the game engine did not start (Rapier)')), 20000);
      const prev = w.onmessage;
      w.onmessage = (e: MessageEvent<FromWorker>) => { if (e.data.t === 'ready') { clearTimeout(t); w.onmessage = prev; res(); } else prev?.call(w, e); };
      s.toWorker({ t: 'init', deck, hostId: myId, seed: o.seed, slice: o.slice, graves, levels, wagon: wagon ?? undefined, ...((o as { botDrive?: boolean }).botDrive ? { botDrive: true } : {}) });
    });
    const hello: TrailCtl = { k: 'hello', v: TRAIL_PROTO, theme: deck.id, session: s.sessionId, you: '', host: myId, deck: liteOf(deck) };
    s.catchup.apply(hello);
    for (const v of s.views) v.onCtl(hello);
    s.toWorker({ t: 'join', id: myId, name: o.name, height: o.height, role: o.role, host: true });
    s.relayBus({ type: 'trail', k: 'on' });
    s.relayBus({ type: 'trail', k: 'ctl', d: hello });
    if (o.party) s.hookHostParty(o.party);
    if (o.observeBus !== false && o.bus) s.observe();
    // "this session is alive" to every game peer (guests drop a stale session without it)
    if (o.party) s.aliveT = window.setInterval(() => o.party?.sendGame({ k: 'ping', session: s.sessionId }), 3000);
    if (!o.standalone) s.installHotkey();
    s.status = `The Trail is running (${deck.name}).`;
    s.onChange();
    return s;
  }
  private toWorker(m: ToWorker) { this.worker?.postMessage(m); }
  /** Tests / filling a party: a simulated player (plays with the sim's bot brain). */
  addBot(id: string, name: string, height: number, role?: RoleId) { this.toWorker({ t: 'join', id, name, height, role, bot: true }); }
  private fromWorker(m: FromWorker) {
    if (this.ended) return;   // (late messages of a terminated worker)
    switch (m.t) {
      case 'ctl': for (const d of m.msgs as TrailCtl[]) this.broadcast(d); break;
      case 'state': this.broadcast({ k: 'state', s: m.s as GameState }); break;
      case 'snap': {
        // (the network channel: only party guests)
        if (this.guests.size && this.party) for (const pkt of packSnapshot(m.snap as Snapshot)) this.party.sendGameRt(pkt);
        break;
      }
      case 'lsnap': {
        // this PC: the game overlay every frame, the OBS spectator at 30 Hz (JSON over the local bus)
        const snap = m.snap as Snapshot;
        for (const v of this.views) v.onSnap(snap);
        if ((this.lsnapN = (this.lsnapN + 1) % 2) === 0) this.relayBus({ type: 'trail', k: 'snap', d: snap });
        break;
      }
      case 'persist': void this.persist(m.graves, m.runEnd as RunState | null); break;
      case 'perf': this.perf = { stepMs: m.stepMs, maxStepMs: m.maxStepMs, bodies: m.bodies }; break;
      case 'error': this.status = `Game engine error: ${m.message}`; this.onChange(); console.error('trail worker', m.message); break;
    }
  }
  private broadcast(d: TrailCtl) {
    this.catchup.apply(d);
    for (const v of this.views) v.onCtl(d);
    if (this.role === 'host' && this.party && this.guests.size) {
      if (d.k === 'state') this.sendGuestState(d.s);
      else this.party.sendGame(d);
    }
    this.relayBus({ type: 'trail', k: 'ctl', d });
  }
  /** Guests get the state at ≤ 5 Hz (the local views at 10). */
  private sendGuestState(s: GameState) {
    const now = performance.now();
    this.pendingGuestState = s;
    if (now - this.lastGuestState >= 200) { this.lastGuestState = now; this.party!.sendGame({ k: 'state', s }); this.pendingGuestState = null; return; }
    if (!this.guestStateT) this.guestStateT = window.setTimeout(() => { this.guestStateT = 0; if (this.pendingGuestState) { this.lastGuestState = performance.now(); this.party?.sendGame({ k: 'state', s: this.pendingGuestState }); this.pendingGuestState = null; } }, 210);
  }
  private hookHostParty(p: Party) {
    p.onGame = (from, d) => {
      const m = sanitizeFromGuest(d);
      if (!m) return;
      if (m.k === 'join') {
        this.guests.add(from); this.declined.delete(from);
        this.toWorker({ t: 'join', id: from, name: this.memberName(from, m.name), height: m.height, role: m.role });
        // the level + state again (a guest whose studio was still loading the game code missed them)
        for (const c of this.catchup.replay().slice(1)) p.sendGame(c, from);
      }
      else if (m.k === 'cmd' && m.c.c === 'leave') { if (this.guests.delete(from)) this.toWorker({ t: 'leave', id: from }); this.declined.add(from); this.status = `${this.memberName(from, 'A guest')} left The Trail.`; this.onChange(); }
      else if (m.k === 'cmd' && m.c.c === 'rejoin') { this.helloSent.delete(from); this.declined.delete(from); this.announce(from); }   // the next poll sends the game again (a new prompt)
      else if (m.k === 'cmd') this.toWorker({ t: 'cmd', id: from, c: m.c });
      else if (m.k === 'here' && m.session !== this.sessionId) p.sendGame({ k: 'end' }, from);   // a stale game from before a reload
    };
    p.onGameRt = (from, pkt) => {
      if (pkt[0] !== PKT_INPUT) return;
      // rate limit (45 packets/s with bursts)
      const now = performance.now();
      const r = this.guestRate.get(from) ?? { tok: 20, at: now };
      r.tok = Math.min(20, r.tok + (now - r.at) / 1000 * 45); r.at = now;
      if (r.tok < 1) return;
      r.tok--; this.guestRate.set(from, r);
      const d = decodeInputs(pkt);
      if (!d || !d.frames.length) return;
      for (const f of d.frames) this.toWorker({ t: 'input', id: from, f: clampInput(f) });
    };
    const poll = () => {
      const peers = new Set(p.gamePeers());
      for (const id of peers) if (!this.guests.has(id) && !this.helloSent.has(id)) { this.helloSent.add(id); this.announce(id); }
      // party members whose app has no game channel (an older VTube Pro): tell the host once
      const now = performance.now();
      for (const mem of p.members) {
        if (mem.id === p.myId || !p.remotes.has(mem.id) || peers.has(mem.id)) { this.missingSince.delete(mem.id); continue; }
        if (!this.missingSince.has(mem.id)) this.missingSince.set(mem.id, now);
        if (this.warnedOld.has(mem.id) || now - this.missingSince.get(mem.id)! < 10000) continue;   // (links still connecting)
        this.warnedOld.add(mem.id);
        const text = `${mem.name ?? 'A guest'} can't join The Trail: their VTube Pro has no game support yet (they need today's update).`;
        this.status = text; this.onChange();
        for (const v of this.views) v.onCtl({ k: 'ev', e: { e: 'toast', text, tone: 'bad' } });
      }
      for (const id of [...this.guests]) if (!peers.has(id)) { this.guests.delete(id); this.helloSent.delete(id); this.toWorker({ t: 'leave', id }); }
      for (const id of [...this.helloSent]) if (!peers.has(id)) this.helloSent.delete(id);
    };
    this.pollT = window.setInterval(poll, 800);
    poll();
    // every 10 s: the game again to party members who aren't in it and didn't say no (a missed hello = no prompt)
    this.announceT = window.setInterval(() => { for (const id of p.gamePeers()) if (!this.guests.has(id) && !this.declined.has(id)) this.announce(id); }, 10000);
  }
  private helloSent = new Set<string>();
  private lsnapN = 0;
  private declined = new Set<string>();
  private warnedOld = new Set<string>();
  private missingSince = new Map<string, number>();
  private announceT = 0;
  /** Host → one guest: hello + the catch-up (level, state). */
  private announce(id: string) {
    const p = this.party;
    if (!p || !this.catchup.hello || this.ended) return;
    p.sendGame({ ...(this.catchup.hello as Extract<TrailCtl, { k: 'hello' }>), you: id }, id);
    for (const m of this.catchup.replay().slice(1)) p.sendGame(m, id);
  }
  private memberName(id: string, claimed: string) { const m = this.party?.members.find((x) => x.id === id); return (m?.name ?? claimed).slice(0, 40); }

  /** Voice / face activity of everyone on this PC's bus → the sim (singing / talent-show events), + chat votes. */
  private observe() {
    const bus = new Bus('control');
    this.watchBus = bus;
    bus.on((m: BusMessage) => {
      const now = performance.now();
      if (m.type === 'frame') this.noteFrame(m.peer ?? this.myId, m.frame, now);
      else if (m.type === 'pvoice') { const v = this.voice.get(m.peer) ?? { vad: 0, expr: 0, face: null, at: now }; const s = m.v?.[m.v.length - 1]; if (s) v.vad = Math.max(v.vad * 0.8, Number(s.vad) || 0); v.at = now; this.voice.set(m.peer, v); }
      else if (m.type === 'chat' && this.role === 'host' && this.catchup.state?.lobby.chatVotes) for (const e of m.evs ?? []) {
        const mm = /^!\s*([1-5])\b/.exec(String(e.text ?? '')); const v = this.catchup.state?.vote;
        if (mm && v) { const opt = v.options[Number(mm[1]) - 1]; if (opt) this.toWorker({ t: 'chat', opt: opt.id }); }
      }
      else if (m.type === 'trail' && m.k === 'sync') for (const d of this.catchup.replay()) this.relayBus({ type: 'trail', k: 'ctl', d });
    });
    this.voiceT = window.setInterval(() => {
      const out: Record<string, { vad: number; expr: number }> = {};
      const now = performance.now();
      for (const [id, v] of this.voice) if (now - v.at < 1500) out[id] = { vad: Math.round(v.vad * 100) / 100, expr: Math.round(v.expr * 100) / 100 };
      if (this.role === 'host') this.toWorker({ t: 'voice', v: out });
    }, 100);
  }
  private noteFrame(id: string, f: TrackingFrame, now: number) {
    const v = this.voice.get(id) ?? { vad: 0, expr: 0, face: null, at: now };
    const speak = Number((f.mouth as { speak?: number } | undefined)?.speak ?? (f.visemes ? 1 - (f.visemes.sil ?? 1) : (f.mouth?.open ?? 0) * 2));
    v.vad = Math.max(v.vad * 0.85, Math.min(1, speak));
    // expressiveness: how much the face moves (blendshape deltas), smoothed
    let d = 0;
    if (f.face && v.face) for (const [k, x] of Object.entries(f.face)) d += Math.abs(x - (v.face[k] ?? 0));
    v.face = f.face ? { ...f.face } : v.face;
    v.expr = v.expr * 0.9 + Math.min(3, d) * 0.1 * 4;
    v.at = now;
    this.voice.set(id, v);
  }
  private async persist(graves: Grave[], runEnd: RunState | null) {
    if (this.o.persist === false || this.role !== 'host') return;
    const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
    if (graves.length) await post('/api/trail/graveyard', { graves: graves.map((g) => ({ ...g, run: this.sessionId })) });
    if (runEnd && !this.runPosted) {
      this.runPosted = true;
      // final epitaphs (written after the death) update the graves
      if (runEnd.graves.length) await post('/api/trail/graveyard', { graves: runEnd.graves.map((g) => ({ ...g, run: this.sessionId })) });
      await post('/api/trail/runs', { run: { theme: runEnd.theme, seed: runEnd.seed, slice: runEnd.slice, outcome: runEnd.outcome, score: runEnd.score?.total ?? 0, days: runEnd.day, miles: runEnd.miles, modifiers: runEnd.modifiers,
        party: Object.values(runEnd.party).map((m) => ({ name: m.name, role: m.role, cls: m.cls, alive: m.alive, diedOf: m.diedOf, epitaph: m.epitaph })) } });
    }
  }

  // ================================================================ GUEST
  static guest(party: Party, hostId: string, o: Partial<HostOpts> = {}): TrailSession {
    if (!o.standalone && TrailSession.current?.role === 'guest' && TrailSession.current.hostId === hostId) return TrailSession.current;
    if (!o.standalone) TrailSession.current?.end(false);
    const s = new TrailSession('guest', party, party.myId, hostId, { bus: o.standalone ? null : party.gameBus(), ...o });
    s.obsBus = o.standalone ? null : party.gameBus();
    party.onGame = (from, d) => { if (from === hostId) s.fromHost(d); };
    if (!o.standalone) s.aliveT = window.setInterval(() => s.guestTick(), 2000);
    party.onGameRt = (from, pkt) => { if (from !== hostId || pkt[0] !== PKT_SNAP) return; s.lastHostAt = performance.now(); const snap = decodeSnapshot(pkt); if (snap) { for (const v of s.views) v.onSnap(snap); s.relayBus({ type: 'trail', k: 'snap', d: snap }); } };
    if (!o.standalone) s.observe();
    return s;
  }
  /** Guest: a message from the host. */
  fromHost(d: unknown) {
    const m = sanitizeFromHost(d);
    if (!m) return;
    this.lastHostAt = performance.now();
    if (m.k === 'end') { if (!this.ended) toast('The host ended The Trail — back to your room.', 'info', 5000); this.end(false); return; }
    if (m.k === 'ping') { if (this.hostSession && m.session !== this.hostSession) { this.end(false); } return; }
    if (m.k === 'hello' && this.hostSession && m.session !== this.hostSession) {
      // the host started a new game: drop the old one, take the new one (prompt again)
      const party = this.party!, host = this.hostId;
      this.end(false);
      guestReceive(party, host, d);
      return;
    }
    if (m.k === 'hello') this.hostSession = m.session;
    if (m.k === 'hello') {
      this.relayBus({ type: 'trail', k: 'on' });
      // introduce myself: name + my avatar's real size (the only avatar data the game uses)
      const p = this.party!;
      const size = this.o.guestHeight ? { height: this.o.guestHeight } : p.myTv ? { height: p.myTv.height } : avatarSize(p.myAvatar);   // a walking TV: its set's height
      const role = (localStorage.getItem('vtp.trail.role') ?? undefined) as RoleId | undefined;
      p.sendGame({ k: 'join', v: TRAIL_PROTO, name: p.name, height: size.height, role }, this.hostId);
      this.status = 'You joined The Trail.';
      this.onChange();
    }
    this.broadcast(m);
  }

  promptShown() { return !!this.prompt; }
  setPrompt(el: HTMLElement) { this.prompt = el; }
  /** Guest, every 2 s: report "still in the game" to the host; close a session whose host went silent. */
  private guestTick() {
    if (this.role !== 'guest' || this.ended) return;
    const hostGone = !this.party || this.party.role === 'none';
    if (hostGone || performance.now() - this.lastHostAt > HOST_SILENT_MS) {
      toast('Lost the host\'s game (their studio reloaded or left) — back to your room.', 'warn', 6000);
      this.end(false);
      return;
    }
    if (this.hostSession) this.party?.sendGame({ k: 'here', session: this.hostSession }, this.hostId);
  }
  /** Guest: leave the game (the host's sim drops my player); the host can send it again later ("Rejoin"). */
  leave() {
    if (this.role !== 'guest') { this.end(); return; }
    this.party?.sendGame({ k: 'cmd', c: { c: 'leave' } }, this.hostId);
    toast('You left The Trail. (Friends → Party games → Rejoin to get back in.)', 'info', 5000);
    this.end(false);
  }
  /** The big red button: host ends for everyone, a guest leaves. */
  quit() { if (this.role === 'host') { toast('The Trail ended for everyone.', 'info', 4000); this.end(); } else this.leave(); }
  /** Ctrl+Shift+E twice within 4 s (studio page; the game overlay has its own) = quit. */
  private hotkeyAt = 0;
  private onHotkey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey && e.shiftKey && e.code === 'KeyE')) return;
    e.preventDefault();
    const now = performance.now();
    if (now - this.hotkeyAt < 4000) { this.hotkeyAt = 0; this.quit(); return; }
    this.hotkeyAt = now;
    toast(this.role === 'host' ? 'Press Ctrl+Shift+E again to END The Trail for everyone.' : 'Press Ctrl+Shift+E again to leave The Trail.', 'warn', 4000);
  };
  private installHotkey() { window.addEventListener('keydown', this.onHotkey); }

  // ================================================================ views (overlay iframe / tests / OBS)
  connect(port: ViewPort): GameLinkApi {
    this.views.add(port);
    for (const m of this.catchup.replay()) port.onCtl(m);
    return {
      myId: this.myId, isHost: this.role === 'host',
      sendInput: (f) => this.localInput(f),
      sendCmd: (c) => this.localCmd(c),
      close: () => this.views.delete(port),
    };
  }
  private localInput(f: InputFrame) {
    if (this.role === 'host') { this.toWorker({ t: 'input', id: this.myId, f }); return; }
    this.inputs.push(f);
    if (this.inputs.length > 3) this.inputs.shift();
    this.party?.sendGameRt(encodeInputs(this.inputs, 0), this.hostId);
  }
  private localCmd(c: TrailCmd) {
    if (c.c === 'role') try { localStorage.setItem('vtp.trail.role', c.role); } catch { /* storage off */ }
    if (this.role === 'host') this.toWorker({ t: 'cmd', id: this.myId, c });
    else this.party?.sendGame({ k: 'cmd', c }, this.hostId);
  }
  private relayBus(m: Extract<BusMessage, { type: 'trail' }>) {
    if (this.ended && m.k !== 'off') return;               // an ended game never talks to OBS again
    this.obsBus?.send({ ...m, from: this.gameSession() });   // OBS pages tell sessions apart (and ignore ended ones)
  }
  /** The game's session id (host: its own; guest: the host's). */
  gameSession() { return this.role === 'host' ? this.sessionId : this.hostSession; }

  /** The studio's full-window game view (Esc inside it releases the mouse; the ✕ goes back to the studio). */
  openOverlay() {
    this.pill?.remove(); this.pill = null;
    this.prompt?.remove(); this.prompt = null;
    this.holdStudioRender(true);
    if (this.overlay) { this.overlay.style.display = ''; this.overlay.focus(); return; }
    const f = document.createElement('iframe');
    f.src = '/trail.html?view=play';
    f.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:9000;background:#000';
    f.allow = 'fullscreen';
    document.body.append(f);
    this.overlay = f;
    setTimeout(() => f.focus(), 300);
  }
  /** While the game covers the studio, the studio's own preview render pauses (tracking goes on): one less full 3D
   *  scene on the GPU the face tracker and OBS share. */
  private holdStudioRender(on: boolean) { const app = (window as unknown as { vtp?: { renderHold?: boolean } }).vtp; if (app && 'renderHold' in app) app.renderHold = on; }
  hideOverlay() {
    this.holdStudioRender(false);
    if (this.overlay) this.overlay.style.display = 'none';
    // a pill in the studio corner: back into the game, or out of it
    if (this.pill || this.ended) return;
    const pill = document.createElement('div');
    pill.style.cssText = 'position:fixed;left:18px;bottom:18px;z-index:9001;background:#15181c;color:#fff;border-radius:14px;padding:10px 12px;font:600 14px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center';
    const t = document.createElement('span'); t.textContent = 'The Trail is running';
    const back = document.createElement('button'); back.textContent = '▶ Back to the game';
    back.style.cssText = 'background:#e8a33d;border:0;border-radius:10px;padding:7px 12px;font-weight:800;cursor:pointer';
    back.onclick = () => this.openOverlay();
    const out = document.createElement('button'); out.textContent = this.role === 'host' ? '⏹ End game for everyone' : '🚪 Leave game';
    out.style.cssText = 'background:#b3261e;color:#fff;border:0;border-radius:10px;padding:7px 12px;font-weight:800;cursor:pointer';
    out.onclick = () => { if (this.role !== 'host' || confirm('End The Trail for everyone? Everyone goes back to their room.')) this.quit(); };
    pill.append(t, back, out);
    document.body.append(pill);
    this.pill = pill;
  }

  end(notify = true) {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.aliveT);
    window.removeEventListener('keydown', this.onHotkey);
    this.pill?.remove(); this.pill = null;
    this.prompt?.remove(); this.prompt = null;
    if (this.role === 'host' && notify && this.party) this.party.sendGame({ k: 'end' });
    if (this.role === 'guest' && notify && this.party) this.party.sendGame({ k: 'cmd', c: { c: 'leave' } }, this.hostId);   // a guest ending = leaving
    this.relayBus({ type: 'trail', k: 'off' });
    clearInterval(this.announceT);
    this.toWorker({ t: 'stop' });
    this.worker?.terminate(); this.worker = null;
    clearInterval(this.pollT); clearInterval(this.voiceT); clearTimeout(this.guestStateT);
    if (this.party) { this.party.onGame = null; this.party.onGameRt = null; }
    this.watchBus?.close(); this.watchBus = null;
    for (const v of this.views) v.onClose?.();
    this.views.clear();
    this.overlay?.remove(); this.overlay = null;
    this.holdStudioRender(false);
    if (TrailSession.current === this) { TrailSession.current = null; delete (window as unknown as { vtpTrail?: unknown }).vtpTrail; }
    this.status = 'The game has ended.';
    this.onChange();
  }
}

/** A guest's studio received a game message while no session exists: the host started a game → join prompt. */
export function guestReceive(party: Party, hostId: string, d: unknown) {
  const m = sanitizeFromHost(d);
  if (!m || party.role !== 'guest') return;
  // the level / state right behind the hello arrive while the lazy import was loading: route them into the session
  const cur = TrailSession.current;
  if (cur && cur.role === 'guest' && cur.hostId === hostId) { if (m.k !== 'hello' || !cur.promptShown() || m.session !== cur.gameSession()) cur.fromHost(d); return; }
  if (m.k !== 'hello') return;
  const s = TrailSession.guest(party, hostId);
  s.fromHost(d);
  if (s.overlay || s.promptShown()) return;
  if (performance.now() < joinWish) { joinWish = 0; s.openOverlay(); return; }   // they pressed "Join the running game"
  askToJoin(s);
}
let joinWish = 0;
/** Guest: ask the host for the running game and open it straight away when it arrives (no prompt). */
export function joinRunningGame(party: Party) {
  const cur = TrailSession.current;
  if (cur && cur.role === 'guest') { cur.openOverlay(); return; }
  joinWish = performance.now() + 15000;
  party.sendGame({ k: 'cmd', c: { c: 'rejoin' } });
  toast('Asking the host for the game…', 'info', 4000);
}
function askToJoin(s: TrailSession) {
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:9001;background:#15181c;color:#fff;border-radius:14px;padding:14px 18px;font:600 15px system-ui;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;gap:12px;align-items:center';
  const txt = document.createElement('span');
  txt.textContent = 'The host started THE TRAIL 🐸🪽 — join the game?';
  const yes = document.createElement('button'); yes.textContent = 'Join'; yes.style.cssText = 'background:#e8a33d;border:0;border-radius:10px;padding:8px 14px;font-weight:800;cursor:pointer';
  const no = document.createElement('button'); no.textContent = 'Later'; no.style.cssText = 'background:#333;color:#fff;border:0;border-radius:10px;padding:8px 14px;cursor:pointer';
  yes.onclick = () => { box.remove(); s.openOverlay(); };
  no.onclick = () => { box.remove(); s.leave(); };
  no.textContent = 'Not now';
  box.append(txt, yes, no);
  document.body.append(box);
  s.setPrompt(box);
}

/** Studio-wide: `trail` bus commands (Stream Deck / POST /api/command {command:'trail', args:{end:true}}) and a game
 *  still on guests' screens after this studio reloaded (they report 'here'). Installed once by the launcher module. */
export const trailRescue = {
  /** Guests that reported a game while this studio has none (host reload). */
  orphans: new Map<string, number>(),
  onChange: (() => {}) as () => void,
  /** End whatever game is on screen: this PC's session, else tell every game peer + this PC's OBS pages. */
  endAll(party: Party | null, bus: Bus | null) {
    const s = TrailSession.current;
    if (s) { s.quit(); return; }
    party?.sendGame({ k: 'end' });
    bus?.send({ type: 'trail', k: 'off' });
    this.orphans.clear(); this.onChange();
    toast('Sent “end The Trail” to everyone.', 'info', 4000);
  },
  /** Host studio without a session got a game message from a guest (party.onGame slot is free). */
  orphanMessage(party: Party, from: string, d: unknown) {
    const m = sanitizeFromGuest(d);
    if (!m) return;
    if (m.k === 'here' || m.k === 'cmd' || m.k === 'join') {
      const first = !this.orphans.size;
      this.orphans.set(from, performance.now());
      if (first) toast('A Trail game is still showing for your party — Friends → Party games → “End it for everyone”.', 'warn', 8000);
      this.onChange();
    }
    void party;
  },
};

/** Split a snapshot into rt packets (≤ 4 kB each). Players always go in the first packet. */
export function packSnapshot(snap: Snapshot): Uint8Array[] {
  const out: Uint8Array[] = [];
  let rest = [...snap.ents].sort((a, b) => Number(b.yaw !== undefined) - Number(a.yaw !== undefined));
  let guard = 0;
  while (rest.length && guard++ < 16) {
    const { pkt, n } = encodeSnapshot({ ...snap, ents: rest });
    out.push(pkt);
    if (n <= 0) break;
    rest = rest.slice(n);
  }
  if (!out.length) out.push(encodeSnapshot({ ...snap, ents: [] }).pkt);
  return out;
}
const num = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
function clampInput(f: InputFrame): InputFrame { return { seq: f.seq & 0xffff, mx: num(f.mx, -1, 1), mz: num(f.mz, -1, 1), yaw: num(f.yaw, -4, 4), pitch: num(f.pitch, -1.56, 1.56), buttons: f.buttons & 0xff, hold: num(f.hold, 0, 13) }; }

/** The theme pack's level GLBs (trailart) read into physics level descs; kinds without a GLB use the grey-box. */
export async function loadThemeLevels(deck: Deck, log: (s: string) => void): Promise<Record<string, LevelDesc>> {
  const out: Record<string, LevelDesc> = {};
  // (the travel road is a seamless 60 m tile + a scenery kit in the art contract: the client tiles it; its physics stay grey-box)
  await Promise.all(levelJobs([...deck.route, ...(deck.slice ?? [])]).map(async ([key, kind, files]) => {
    let rel = '';
    try {
      let r: Response | null = null;
      for (const f of files) {
        rel = `${f}.glb`;
        r = await fetch(`/api/trail/${encodeURIComponent(deck.id)}/file/${rel}`, { cache: 'no-store' });
        if (r.ok) break;
      }
      if (!r?.ok) return;
      const buf = await r.arrayBuffer();
      const info = levelFromGlb(buf, buildLevel(kind === 'trail_road' ? 'road' : kind, { theme: deck.id, palette: deck.palette }), rel);
      out[key] = info.desc;
      log(`level ${rel}: ${info.desc.cols.length} colliders (${Math.round(info.trimeshTris)} mesh tris)${info.warnings.length ? ' · ' + info.warnings.join('; ') : ''}`);
    } catch (e) { log(`level ${rel} unusable: ${(e as Error).message}`); }
  }));
  return out;
}

/** The theme pack's wagon.glb read into the wagon's physics + anchors (null = the engine default). */
export async function loadThemeWagon(deck: Deck, log: (s: string) => void): Promise<WagonSpec | null> {
  try {
    const r = await fetch(`/api/trail/${encodeURIComponent(deck.id)}/file/wagon.glb`, { cache: 'no-store' });
    if (!r.ok) return null;
    const { spec, warnings } = wagonFromGlb(await r.arrayBuffer(), WAGON);
    log(`wagon.glb: ${spec.cols.length} colliders, ${spec.seats.length} seats, mass ${spec.mass} kg${warnings.length ? ' · ' + warnings.join('; ') : ''}`);
    return spec;
  } catch (e) { log(`wagon.glb unusable: ${(e as Error).message}`); return null; }
}
