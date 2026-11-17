// TTRPG session in the studio.
//  HOST (or solo): owns the game (engine.ts). Writes the table to SceneState.ttrpg (every OBS page + guests' OBS), the
//  panel view to guests (party 'ttrpg' channel), runs the AI GM loop against this PC's server (/api/ttrpg/gm/turn —
//  a model on this PC answers), speaks the GM's lines (voice.ts) and re-times the mouth on this PC's OBS pages,
//  applies VTT-bridge relays, autosaves the campaign.
//  GUEST: sends actions / rolls / its sheet / the X-card to the host, receives the panel view + the GM's lines (spoken
//  locally if they want to hear them) + images (relayed to its own OBS pages).
import type { SceneController } from '../../scene/controller.ts';
import type { Party } from '../../party.ts';
import type { Bus } from '../../bus.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import { roomGmStyles, type GmLook, type RoomTtrpgConfig, type SceneTtrpgState, type TtrpgShot } from '../../../shared/ttrpg/state.ts';
import type { SceneInfo } from '../../../shared/types.ts';
import { sanitizeFromGuest, sanitizeFromHost, type GamePublic, type LipCue, type PartyTtrpg, type TtrpgBus, type VttMsg } from '../../../shared/ttrpg/wire.ts';
import { tidyNarration, validateAction, type GmAction, type GmContext } from '../../../shared/ttrpg/gm.ts';
import { findSeed, seedsFor, setRoomQuests, type AdventureSeed } from '../../../shared/ttrpg/seeds.ts';
import { exportCharacter, importCharacter, sanitizeCharacter, type TtrpgCharacter, type TtrpgSystem } from '../../../shared/ttrpg/rules.ts';
import { applyAction, applyHp, findTarget, gmContext, log, newGame, nextThrowAt, placeParty, roll, setScene, syncCharToken, varsFor, type TtrpgGame } from './engine.ts';
import { playOnStream, renderLine, speak, type RenderedLine, type SpeakHandle, type SpeakOpts, type VoiceOut, playPrivately } from './voice.ts';
import { ttrpgRoomFor } from '../../../shared/ttrpg/rooms.ts';
import { estimateDuration } from '../gm/speech.ts';

export type GmStatus = '' | 'thinking' | 'speaking' | 'waiting' | 'paused' | 'approve' | 'error';
export interface PendingTurn { narration: string; actions: GmAction[]; dropped: string[]; event: GmContext['event']; raw: string }
export interface SpendView { calls: number; input: number; output: number; lastMinute: number; budgetTokens: number }

const LS_LAST = 'vtp.ttrpg.lastGame';
const rid = () => Math.random().toString(36).slice(2, 10);

export class TtrpgSession {
  game: TtrpgGame | null = null;
  /** Guest: the host's panel view. */
  view: GamePublic | null = null;
  gmStatus: GmStatus = '';
  gmError = '';
  /** Live narration while the model streams (host panel). */
  live = '';
  pending: PendingTurn | null = null;
  spend: SpendView | null = null;
  lastTurn: { ms: number; firstMs: number; model: string } | null = null;
  vtt: { clients: { id: string; src: string; name: string; at: number }[]; last: string } = { clients: [], last: '' };
  paused = false;
  hearGm = localStorage.getItem('vtp.ttrpg.hear') !== '0';
  /** How the GM's voice plays on this PC: 'stream' / 'both' = the server-rendered line, played by this studio through the
   *  audio mixer (OBS pages are silent; they follow its level), 'studio' = the browser's own voice in this studio.
   *  Default: the host → stream (the GM is part of the show), a guest → their studio (so they hear it while playing). */
  private voicePref: VoiceOut | null = (['stream', 'studio', 'both'] as const).find((v) => v === localStorage.getItem('vtp.ttrpg.voiceOut')) ?? null;
  /** ('both' was "OBS page + studio": both now mean the one studio playback, so a saved 'both' reads as 'stream') */
  get voiceOut(): VoiceOut { const v = this.voicePref ?? (this.isHost ? 'stream' : 'studio'); return v === 'both' ? 'stream' : v; }
  /** Why the stream voice fell back to the studio (shown in the panel), '' when fine. */
  voiceNote = '';
  private rendered = new Map<string, Promise<RenderedLine>>();
  private listeners = new Set<(what: string) => void>();
  private speechQ: { id: string; who: string; name: string; text: string; npc?: boolean; voice?: string }[] = [];
  private speaking: SpeakHandle | null = null;
  private tablePushT = 0; private viewPushT = 0; private saveT = 0;
  private abort: AbortController | null = null;
  private actQueue: { who: string; name: string; text: string; ooc: boolean }[] = [];
  private actTimer = 0;
  private waitRolls: { ids: Set<string>; lines: string[] } | null = null;
  private chain = 0;
  private snap: { game: string; event: GmContext['event'] } | null = null;
  private xNext = false;
  private camReset = 0;
  private assetsSent = new Map<string, string>();
  private pushingOff = false;

  constructor(readonly scene: SceneController, readonly party: Party, readonly bus: Bus, readonly observer: boolean) {
    party.onTtrpg = (d, from) => this.onParty(d, from);
    bus.on((m) => { if (m.type === 'ttrpg' && m.m && typeof m.m === 'object') this.onBus(m.m); });
    setInterval(() => { if (this.isHost && this.game?.table.on) this.save(); }, 60_000);
    window.addEventListener('beforeunload', () => { if (this.isHost && this.game?.table.on) this.save(true); });
    // (re)open the last game when the table is already on after a reload
    queueMicrotask(() => this.resume());
    // the stage-mode bar (stagemodes' registry: src/scene/stage/modes/ttrpg.ts) turns the table on / off in the scene
    // state itself: follow it
    scene.on((what) => {
      if (what !== 'state' || !this.isHost || this.observer && !this.game) return;
      const t = this.scene.state.ttrpg;
      if (t?.on && (!this.game || !this.game.table.on)) this.enter({ fromState: true });
      else if (!t?.on && this.game?.table.on && !this.pushingOff) { this.stopAll(); this.game.table.on = false; void this.save(); this.pushView(true); }
    });
  }

  on(fn: (what: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(what = 'state') { for (const l of this.listeners) try { l(what); } catch (e) { console.warn(e); } }

  get isHost() { return this.party.role !== 'guest'; }
  get selfKey() { return this.scene.selfKey; }
  get table(): SceneTtrpgState | null { return this.isHost ? this.game?.table ?? null : this.scene.effective.ttrpg ?? null; }
  get active() { return !!this.table?.on; }
  memberName(key: string) { return this.scene.members().find((m) => m.key === key)?.name ?? (key === HOST_KEY ? 'Host' : 'Player'); }
  /** My character (the one I own). */
  myChar(): TtrpgCharacter | null { const list = this.isHost ? this.game?.chars : this.view?.chars; return list?.find((c) => c.owner === this.selfKey) ?? null; }

  // ---------------------------------------------------------------- rooms
  roomInfo(id: string | null | undefined): SceneInfo | null { return id ? this.scene.scenes.find((s) => s.id === id) ?? null : null; }
  roomCfg(id: string | null | undefined): RoomTtrpgConfig | undefined { return (this.roomInfo(id) as unknown as { ttrpg?: RoomTtrpgConfig } | null)?.ttrpg; }
  /** The TTRPG room for an environment: its own `<env>_ttrpg` (ttrpg.of = env / parent ttrpgRoom), else the generic one. */
  ttrpgRoomFor(env: string | null): string | null { return ttrpgRoomFor(this.scene.scenes, env); }
  envOf(room: string | null): string { const of = this.roomCfg(room)?.of; return of && of !== '*' ? of : this.game?.env ?? room ?? ''; }
  seeds(): AdventureSeed[] { setRoomQuests(this.scene.scenes); return seedsFor(this.game?.env ?? this.scene.effective.sceneId); }

  // ---------------------------------------------------------------- enter / leave (host)
  /** Start (or resume) the table: move the party to the environment's TTRPG room (the room-change curtain plays). */
  enter(o: { system?: TtrpgSystem; campaign?: TtrpgGame; fresh?: boolean; fromState?: boolean } = {}) {
    if (!this.isHost) return;
    setRoomQuests(this.scene.scenes);   // (rooms' own scene.json quests)
    const cur = this.scene.state.sceneId;
    const env = o.fromState && this.scene.state.ttrpg?.from ? this.scene.state.ttrpg.from : this.roomCfg(cur) ? this.envOf(cur) : cur ?? '';
    const room = this.ttrpgRoomFor(env || cur) ?? cur ?? '';
    const cfg = this.roomCfg(room);
    if (o.campaign) this.game = o.campaign;
    else if (!this.game || o.fresh || this.game.env !== env) {
      const last = this.loadLocal();
      if (last && last.env === env && !o.fresh) this.game = last;
      else {
        const styles = roomGmStyles(cfg);
        const def = styles.find((s) => s.id === cfg?.defaultGm) ?? styles[0];
        const seed = (cfg?.seeds?.map((id) => findSeed(id)).find(Boolean) ?? seedsFor(env)[0]) ?? null;
        const look: GmLook = { style: def ? (def.builtin ?? `room:${def.id}`) : 'd20', name: def?.name && def.kind === 'character' ? def.name : 'The Game Master', color: def?.color ?? '#8fd3ff' };
        this.game = newGame({ env, room, system: o.system ?? seed?.system ?? '5e', title: seed?.title ?? 'A new adventure', mapAspect: cfg?.map?.aspect ?? 16 / 9, look,
          persona: cfg?.persona ?? def?.persona ?? seed?.persona ?? '', seedId: seed?.id ?? '' });
      }
    }
    const g = this.game!;
    g.room = room; g.table.on = true; g.table.from = env || undefined;
    if (cfg?.map?.aspect) g.mapAspect = cfg.map.aspect;
    if (room && room !== cur && !o.fromState) this.scene.setScene(room);
    this.pushTable(true); this.pushView(true);
    this.emit();
  }

  /** Close the table and go back to the environment. */
  leave() {
    if (!this.isHost || !this.game) return;
    this.stopAll();
    const from = this.game.table.from;
    this.game.table.on = false;
    void this.save();
    this.pushingOff = true;
    try {
      this.scene.setTtrpg(null);
      // with the stage-mode bar installed the TTRPG mode returns to its room by itself when another mode is picked
      if ((this.scene.state.mode as string) === 'ttrpg') (this.scene.setMode as (m: string) => void)('talk');
      else if (from && from !== this.scene.state.sceneId) this.scene.setScene(from);
    } finally { this.pushingOff = false; }
    this.pushView(true);
    this.emit();
  }

  private resume() {
    const t = this.scene.state.ttrpg;
    if (!this.isHost || !t?.on || this.game) return;
    const last = this.loadLocal();
    if (last) { this.game = last; this.game.table = { ...last.table, ...t, on: true }; this.emit(); }
  }

  // ---------------------------------------------------------------- pushing state
  /** The table → SceneState.ttrpg (saved, every OBS page, guests). Throttled to ~7 / s. */
  pushTable(now = false) {
    const g = this.game;
    if (!g || !this.isHost) return;
    const go = () => {
      this.tablePushT = 0;
      g.table.rev++;
      g.table.system = g.system; g.table.title = g.title;
      g.table.gm = { kind: g.gm.kind, ...(g.gm.who ? { who: g.gm.who } : {}), look: g.gm.look };
      if (g.table.on) this.scene.setTtrpg(structuredClone(g.table));
      this.saveLocal();
    };
    if (now) { clearTimeout(this.tablePushT); go(); } else if (!this.tablePushT) this.tablePushT = window.setTimeout(go, 140);
  }
  /** The panel view → every guest (throttled ~4 / s; ≤ 60 kB). */
  pushView(now = false) {
    if (!this.isHost || this.party.role !== 'host') { this.emit(); return; }
    const go = () => {
      this.viewPushT = 0;
      const v = this.publicView();
      if (!v) return;
      let json = JSON.stringify({ k: 'game', g: v });
      while (json.length > 60_000 && v.log.length > 5) { v.log = v.log.slice(Math.floor(v.log.length / 3)); json = JSON.stringify({ k: 'game', g: v }); }
      this.party.sendTtrpg(JSON.parse(json));
    };
    if (now) { clearTimeout(this.viewPushT); go(); } else if (!this.viewPushT) this.viewPushT = window.setTimeout(go, 250);
    this.emit();
  }
  publicView(): GamePublic | null {
    const g = this.game;
    if (!g) return null;
    return { title: g.title, system: g.system, gmKind: g.gm.kind, gmName: g.gm.look.name, gmBusy: this.gmStatus === 'approve' || this.gmStatus === 'error' ? 'thinking' : this.gmStatus,
      rating: g.ai.rating, lines: g.ai.lines, veils: g.ai.veils, chars: g.chars, log: g.log.slice(-60), requests: g.requests, tokens: g.table.tokens, rev: g.table.rev };
  }
  changed(table = true) { if (table) this.pushTable(); this.pushView(); }

  // ---------------------------------------------------------------- persistence
  private saveLocal() { if (!this.game || this.observer) return; try { localStorage.setItem(LS_LAST, JSON.stringify(this.game)); } catch { /* full */ } }
  private loadLocal(): TtrpgGame | null { try { const g = JSON.parse(localStorage.getItem(LS_LAST) || 'null'); return g && g.v === 1 ? g as TtrpgGame : null; } catch { return null; } }
  async save(beacon = false): Promise<boolean> {
    const g = this.game;
    if (!g || this.observer || !this.isHost) return false;
    const body = JSON.stringify({ ...g, log: g.log.slice(-400), chars: g.chars });
    if (beacon) { try { void fetch(`/api/ttrpg/campaigns/${encodeURIComponent(g.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 }); } catch { /* */ } return true; }
    clearTimeout(this.saveT);
    const r = await fetch(`/api/ttrpg/campaigns/${encodeURIComponent(g.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }).catch(() => null);
    return !!r?.ok;
  }
  async load(id: string) {
    const r = await fetch(`/api/ttrpg/campaigns/${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `load ${r.status}`);
    const g = await r.json() as TtrpgGame;
    if (g.v !== 1) throw new Error('Not a VTube Pro campaign');
    g.sessions = (g.sessions || 0) + 1;
    this.enter({ campaign: g });
    log(g, 'system', 'gm', 'Table', `Session ${g.sessions} begins.`);
    this.changed();
  }

  // ---------------------------------------------------------------- characters
  setSheet(c: TtrpgCharacter) {
    if (!this.isHost) { this.party.sendTtrpg({ k: 'sheet', c } satisfies PartyTtrpg); return; }
    const g = this.game; if (!g) return;
    const i = g.chars.findIndex((x) => x.id === c.id);
    if (i >= 0) g.chars[i] = c; else g.chars.push(c);
    syncCharToken(g, c);
    if (!g.table.tokens.some((t) => t.id === `pc-${c.id}`) && g.table.map) placeParty(g);
    this.changed();
  }
  removeSheet(id: string) { const g = this.game; if (!g) return; g.chars = g.chars.filter((c) => c.id !== id); g.table.tokens = g.table.tokens.filter((t) => t.id !== `pc-${id}`); this.changed(); }
  importSheet(json: unknown, owner?: string) { const r = importCharacter(json, owner ?? this.selfKey); if (r.c) this.setSheet(r.c); return r; }
  exportSheet(c: TtrpgCharacter) { return exportCharacter(c); }

  // ---------------------------------------------------------------- dice
  /** Anyone rolls (guests via the host). `req` = answering a GM roll request. */
  roll(expr: string, label: string, req?: string, secret?: boolean) {
    if (!this.isHost) { this.party.sendTtrpg({ k: 'roll', expr, label, ...(req ? { req } : {}), ...(secret ? { secret: true } : {}) } satisfies PartyTtrpg); return; }
    return this.rollFor(this.selfKey, expr, label, req, secret);
  }
  rollFor(who: string, expr: string, label: string, reqId?: string, secret?: boolean) {
    const g = this.game; if (!g) return;
    const c = g.chars.find((x) => x.owner === who);
    const q = reqId ? g.requests.find((x) => x.id === reqId) : undefined;
    try {
      const out = roll(g, { who, name: q?.name ?? c?.name ?? this.memberName(who), expr: q?.expr ?? expr, label: q?.label ?? label, dc: q?.dc, secret: secret ?? q?.secret, vars: varsFor(c ?? undefined) });
      if (q) {
        g.requests = g.requests.filter((x) => x.id !== q.id);
        if (this.waitRolls?.ids.has(q.id)) { this.waitRolls.ids.delete(q.id); this.waitRolls.lines.push(out.line); if (!this.waitRolls.ids.size) this.afterRolls(); }
      }
      this.changed();
      return out;
    } catch (e) { this.note(`Roll failed: ${(e as Error).message}`, who); }
  }
  private afterRolls() {
    const w = this.waitRolls; this.waitRolls = null;
    if (!w || !this.game) return;
    this.gmStatus = '';
    // let the dice land before the GM reacts
    if (this.game.gm.kind === 'ai' && this.game.ai.auto && !this.paused) setTimeout(() => void this.gmTurn({ kind: 'rolls', rolls: w.lines }), 2600);
    this.pushView();
  }
  /** Host: stop waiting for rolls and let the GM go on. */
  continueWithout() { if (this.waitRolls) { this.waitRolls.lines.push('(the host moved on without the remaining rolls)'); this.waitRolls.ids.clear(); this.afterRolls(); } }

  // ---------------------------------------------------------------- players act
  act(text: string, ooc = false) {
    const t = text.trim(); if (!t) return;
    if (!this.isHost) { this.party.sendTtrpg({ k: 'act', text: t, ...(ooc ? { ooc: true } : {}) } satisfies PartyTtrpg); return; }
    this.actFrom(this.selfKey, t, ooc);
  }
  private actFrom(who: string, text: string, ooc: boolean) {
    const g = this.game; if (!g) return;
    const c = g.chars.find((x) => x.owner === who);
    const name = c?.name ?? this.memberName(who);
    log(g, ooc ? 'ooc' : 'player', who, name, text);
    this.changed(false);
    if (g.gm.kind !== 'ai' || !g.ai.auto || this.paused) return;
    this.actQueue.push({ who, name, text, ooc });
    clearTimeout(this.actTimer);
    this.actTimer = window.setTimeout(() => this.flushActs(), 1500);
  }
  private flushActs() {
    if (!this.actQueue.length) return;
    if (this.gmStatus === 'thinking' || this.gmStatus === 'approve' || this.speaking || this.waitRolls) { this.actTimer = window.setTimeout(() => this.flushActs(), 1200); return; }
    const q = this.actQueue.splice(0);
    const ooc = q.every((x) => x.ooc);
    void this.gmTurn({ kind: ooc ? 'ooc' : 'action', who: q.length === 1 ? q[0].name : 'The players', text: q.length === 1 ? q[0].text : q.map((x) => `${x.name}${x.ooc ? ' [OOC]' : ''}: ${x.text}`).join('\n') });
  }

  // ---------------------------------------------------------------- safety
  xcard(from = this.selfKey) {
    if (!this.isHost) { this.party.sendTtrpg({ k: 'x' } satisfies PartyTtrpg); return; }
    const g = this.game; if (!g) return;
    this.stopAll();
    g.table.xAt = Date.now();
    g.table.say = null;
    log(g, 'x', from, this.memberName(from), 'The X-card was tapped. The last thing described is gone — moving on.');
    this.xNext = true;
    this.changed();
    if (g.gm.kind === 'ai' && !this.paused) setTimeout(() => void this.gmTurn({ kind: 'continue', text: 'The X-card was used: retcon the last description and move the scene on.' }), 1200);
  }
  setPaused(p: boolean) { this.paused = p; if (p) { this.stopAll(); this.gmStatus = 'paused'; } else if (this.gmStatus === 'paused') this.gmStatus = ''; this.pushView(); }
  stopAll() {
    this.abort?.abort(); this.abort = null;
    void fetch('/api/ttrpg/gm/abort', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    this.speechQ = []; this.speaking?.stop(); this.speaking = null;
    clearTimeout(this.actTimer);
    if (this.gmStatus !== 'paused') this.gmStatus = '';
    this.live = '';
    this.emit();
  }

  // ---------------------------------------------------------------- the AI GM
  private ctx(event: GmContext['event']): GmContext {
    const g = this.game!;
    const info = this.roomInfo(g.env) ?? this.roomInfo(g.room);
    const cfg = this.roomCfg(g.room);
    const players = new Map(this.scene.members().map((m) => [m.key, m.name]));
    const seed = findSeed(g.ai.seedId);
    const ctx = gmContext(g, { env: { id: g.env, name: info?.name ?? g.env, theme: cfg?.theme ?? '' }, seed, players, event, xcard: this.xNext, gmName: g.gm.look.name });
    return ctx;
  }

  /** One GM turn: stream the narration (spoken sentence by sentence unless "approve lines" is on), then apply the actions. */
  async gmTurn(event: GmContext['event'], auto = true): Promise<void> {
    const g = this.game;
    if (!g || !this.isHost || g.gm.kind !== 'ai') return;
    if (this.gmStatus === 'thinking') return;
    if (!auto) this.chain = 0;
    if (event.kind === 'rolls') { if (++this.chain > 3) { this.chain = 0; this.note('The GM paused after several automatic turns — press Continue.'); return; } } else this.chain = 0;
    this.snap = { game: JSON.stringify(g), event };
    const ctx = this.ctx(event);
    this.xNext = false;
    g.feedback = [];
    this.gmStatus = 'thinking'; this.gmError = ''; this.live = '';
    this.pushView();
    const ac = new AbortController();
    this.abort = ac;
    let spoken = 0;
    const approve = g.ai.approve;
    try {
      const r = await fetch('/api/ttrpg/gm/turn', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx }), signal: ac.signal });
      if (!r.ok || !r.body) throw new Error((await r.json().catch(() => ({}))).error ?? `GM ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let turn: { narration: string; actions: unknown[]; dropped: string[]; raw: string } | null = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data:\s?(.*)$/m.exec(chunk);
          if (!m) continue;
          let ev: any; try { ev = JSON.parse(m[1]); } catch { continue; }
          if (ev.t === 'delta') {
            this.live += ev.text;
            if (!approve) spoken = this.speakCompleteSentences(spoken, false);
            this.emit('live');
          } else if (ev.t === 'turn') turn = ev;
          else if (ev.t === 'done') { this.lastTurn = { ms: ev.ms, firstMs: ev.firstMs, model: ev.model }; this.spend = ev.meter; }
          else if (ev.t === 'error') throw Object.assign(new Error(ev.message), { partial: ev.partial });
        }
      }
      if (!turn) throw new Error('The GM stream ended without a turn');
      const actions = (turn.actions ?? []).map(validateAction).filter((a): a is GmAction => typeof a !== 'string');
      if (approve) {
        this.pending = { narration: turn.narration, actions, dropped: turn.dropped ?? [], event, raw: turn.raw ?? '' };
        this.gmStatus = 'approve';
        this.pushView();
        return;
      }
      // speak whatever is left (the last sentence), then apply
      this.live = turn.narration;
      spoken = this.speakCompleteSentences(spoken, true);
      this.commit(turn.narration, actions, turn.dropped ?? []);
    } catch (e) {
      if ((e as Error).name === 'AbortError' || /Stopped/.test((e as Error).message)) { this.gmStatus = this.paused ? 'paused' : ''; this.emit(); return; }
      this.gmStatus = 'error'; this.gmError = (e as Error).message;
      const partial = (e as { partial?: string }).partial || this.live;
      if (partial.trim()) log(g, 'gm', 'gm', g.gm.look.name, `${partial.trim()} (…interrupted)`);
      this.pushView();
    } finally { if (this.abort === ac) this.abort = null; }
  }

  /** Feed finished sentences of `this.live` to the voice queue as they complete. */
  private speakCompleteSentences(from: number, final: boolean): number {
    const text = this.live;
    let upto = from;
    const re = /[.!?…]+["'”’)\]]?(\s+|$)/g;
    re.lastIndex = from;
    let m: RegExpExecArray | null;
    let cut = -1;
    while ((m = re.exec(text))) { const end = m.index + m[0].length; if (end - upto >= 28 || (final && end === text.length)) { cut = end; } if (m[0].length === 0) break; }
    if (cut > upto) { this.queueSpeech('gm', this.game!.gm.look.name, text.slice(upto, cut).trim()); upto = cut; }
    if (final && text.length > upto && text.slice(upto).trim()) { this.queueSpeech('gm', this.game!.gm.look.name, text.slice(upto).trim()); upto = text.length; }
    return upto;
  }

  /** Apply a finished (or approved) GM turn: log, NPC lines, actions, rolls to wait for, follow-ups. */
  private commit(narration: string, actions: GmAction[], dropped: string[]) {
    const g = this.game!;
    if (narration.trim()) log(g, 'gm', 'gm', g.gm.look.name, narration.trim());
    g.feedback.push(...dropped);
    const reqIds = new Set<string>();
    let npcRolls = 0, init: string | null = null, lastAt = 0;
    for (const a of actions) {
      const o = applyAction(g, a);
      for (const l of o.log) log(g, 'system', 'gm', 'Table', l);
      for (const s of o.speak) { log(g, 'npc', 'gm', s.name, s.text); this.queueSpeech('npc', s.name, s.text, s.voice); }
      for (const q of o.requests) reqIds.add(q.id);
      for (const r of o.npcRolls) { npcRolls++; lastAt = Math.max(lastAt, r.roll.at); }
      if (o.initRoll) { init = o.initRoll.line; lastAt = Math.max(lastAt, o.initRoll.roll.at); }
      if (o.cam) this.pin(o.cam.shot as TtrpgShot, o.cam.who);
    }
    this.gmStatus = this.speaking || this.speechQ.length ? 'speaking' : reqIds.size ? 'waiting' : '';
    this.live = '';
    if (reqIds.size) this.waitRolls = { ids: reqIds, lines: [] };
    this.changed();
    // NPC rolls / initiative with nobody else to wait for: the GM reacts once the dice land and the voice is done
    if (!reqIds.size && (npcRolls || init) && g.ai.auto && !this.paused) {
      const lines = g.log.filter((e) => e.kind === 'roll').slice(-(npcRolls + (init ? 1 : 0))).map((e) => e.text);
      const wait = Math.max(0, lastAt - Date.now()) + 2600;
      const go = () => { if (this.speaking || this.speechQ.length) { setTimeout(go, 500); return; } void this.gmTurn({ kind: 'rolls', rolls: lines }); };
      setTimeout(go, wait);
    }
    this.maybeSummarize();
  }

  approve(edited?: string, keep?: boolean[]) {
    const p = this.pending; if (!p) return;
    this.pending = null;
    const text = (edited ?? p.narration).trim();
    const actions = keep ? p.actions.filter((_, i) => keep[i]) : p.actions;
    this.live = text;
    this.speakCompleteSentences(0, true);
    this.commit(text, actions, p.dropped);
  }
  discard() { this.pending = null; this.gmStatus = ''; this.live = ''; this.pushView(); }
  /** Redo: put the table back as it was before the last GM turn and ask again. */
  redo() {
    const s = this.snap; if (!s) return;
    this.stopAll(); this.pending = null;
    this.game = JSON.parse(s.game) as TtrpgGame;
    this.changed();
    void this.gmTurn(s.event, false);
  }
  /** Undo the last GM turn (no new answer). */
  undo() { const s = this.snap; if (!s) return; this.stopAll(); this.pending = null; this.game = JSON.parse(s.game) as TtrpgGame; this.snap = null; this.gmStatus = ''; this.changed(); }

  private async maybeSummarize() {
    const g = this.game!;
    if (g.gm.kind !== 'ai' || g.log.length - g.ai.summarizedTo < 50) return;
    const from = g.ai.summarizedTo, to = g.log.length;
    const tr = g.log.slice(from, to).filter((e) => e.kind !== 'system').map((e) => ({ who: e.kind === 'gm' ? 'GM' : e.name, text: e.text }));
    try {
      const r = await fetch('/api/ttrpg/gm/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prev: g.ai.memory, transcript: tr }) });
      if (!r.ok) return;
      const j = await r.json() as { text: string };
      if (j.text) { g.ai.memory = j.text; g.ai.summarizedTo = to; this.saveLocal(); }
    } catch { /* next time */ }
  }

  // ---------------------------------------------------------------- speech
  private queueSpeech(kind: 'gm' | 'npc', name: string, text: string, voice?: string) {
    if (!text) return;
    text = tidyNarration(text);   // (no markdown read aloud: *buzzed* → buzzed)
    if (!text) return;
    const it = { id: rid(), who: kind === 'gm' ? 'gm' : 'npc', name, text: text.slice(0, 600), npc: kind === 'npc', voice };
    this.speechQ.push(it);
    this.prerender(it.id, it.text, it.npc ? it.voice ?? 'rough' : undefined);   // (the next line is ready when this one ends)
    if (!this.speaking) this.nextSpeech();
  }
  private nextSpeech() {
    const g = this.game;
    const it = this.speechQ.shift();
    if (!it || !g) { this.speaking = null; if (this.gmStatus === 'speaking') this.gmStatus = this.waitRolls ? 'waiting' : ''; this.pushView(); return; }
    this.gmStatus = 'speaking';
    const est = estimateDuration(it.text, g.voice.rate * (it.npc ? 1 : 1));
    const at = Date.now() + 150;
    g.table.say = { id: it.id, who: it.who, name: it.name, text: it.text, at, dur: est, ...(it.npc ? { npc: true } : {}) };
    this.pushTable(true);
    if (this.party.role === 'host') this.party.sendTtrpg({ k: 'speak', id: it.id, text: it.text, ...(it.voice ? { voice: it.voice } : {}), ...(it.npc ? { npc: true } : {}) } satisfies PartyTtrpg);
    const h = this.voiceLine(it.id, it.text, it.npc ? it.voice ?? 'rough' : undefined, est, (t, dur) => {
      if (g.table.say?.id === it.id && (Math.abs(t - g.table.say.at) > 250 || Math.abs(dur - g.table.say.dur) > 0.4)) { g.table.say = { ...g.table.say, at: t, dur }; this.pushTable(); }
    });
    this.speaking = h;
    this.emit();
    void h.done.then(() => { if (this.speaking === h) { this.speaking = null; setTimeout(() => { if (!this.speaking) this.nextSpeech(); }, 220); } });
  }
  skipLine() { this.speaking?.stop(); }
  setHear(on: boolean) { this.hearGm = on; localStorage.setItem('vtp.ttrpg.hear', on ? '1' : '0'); if (!on) this.speaking?.stop(); this.emit(); }
  setVoiceOut(v: VoiceOut) { this.voicePref = v; this.voiceNote = ''; localStorage.setItem('vtp.ttrpg.voiceOut', v); this.rendered.clear(); this.emit(); }

  private voiceOpts(npc?: string): SpeakOpts {
    const v = this.game?.voice;
    return { voice: v?.voice, rate: v?.rate ?? 1, pitch: v?.pitch ?? 1, npc, provider: v?.provider ?? 'browser' };
  }
  /** Start rendering a line on the server now (On stream and Only me both play a rendered line), so it's ready in time. */
  private prerender(id: string, text: string, npc?: string) {
    if (!this.hearGm || this.rendered.has(id)) return;
    const p = renderLine(text, this.voiceOpts(npc));
    p.catch(() => null);
    this.rendered.set(id, p);
    if (this.rendered.size > 12) this.rendered.delete(this.rendered.keys().next().value as string);
  }
  /** Speak one line wherever this PC plays the GM (stream / studio / both / muted) and keep this PC's OBS pages' mouth
   *  + captions in step (sayAt). onTiming(at, dur) = when it really starts and how long it is. */
  private voiceLine(id: string, text: string, npc: string | undefined, est: number, onTiming: (at: number, dur: number) => void): SpeakHandle {
    const sayAt = (at: number, dur: number, lip?: LipCue[]) => { this.bus.send({ type: 'ttrpg', m: { k: 'sayAt', id, at, dur, ...(lip ? { lip } : {}) } }); onTiming(at, dur); };
    // muted on this PC: no audio, but the line still takes its time (captions, the GM's mouth, OBS pacing)
    if (!this.hearGm) { let r!: () => void; const done = new Promise<void>((res) => { r = res; }); const t = setTimeout(() => r(), est * 1000); sayAt(Date.now(), est); return { done, stop: () => { clearTimeout(t); r(); } }; }
    // a caption-only line: no sound, but it takes its time (captions, the GM's mouth, OBS pacing)
    const silent = (): SpeakHandle => { let r!: () => void; const done = new Promise<void>((res) => { r = res; }); const t = setTimeout(() => r(), est * 1000); sayAt(Date.now(), est); return { done, stop: () => { clearTimeout(t); r(); } }; };
    // the server-rendered line: On stream = the studio's output (the OBS pages follow it silently); Only me = the mixer's
    // private "Only me" output (the host's headphones). Never the browser's own voice: OBS would capture it from this window.
    const only = this.voiceOut === 'studio';
    let inner: SpeakHandle | null = null, stopped = false, resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    this.prerender(id, text, npc);
    void (async () => {
      try {
        const line = await this.rendered.get(id)!;
        this.rendered.delete(id);
        if (stopped) return resolve();
        const at = Date.now() + 250;                                  // (time for the OBS page to fetch + decode it)
        inner = only ? playPrivately(line, at) : playOnStream(this.bus, id, line, at, false);
        sayAt(at, line.dur, line.lip);
        if (this.voiceNote) { this.voiceNote = ''; this.emit(); }
      } catch (e) {
        this.rendered.delete(id);
        // (no voice for this line: shown as a caption only — never the browser voice on the captured output)
        const why = `The narrator’s voice couldn’t be made for this line (${(e as Error).message || 'no voice'}), so it is shown as a caption only.`;
        if (this.voiceNote !== why) { this.voiceNote = why; this.emit(); }
        console.warn('[ttrpg] voice line failed: caption only', e);
        if (stopped) return resolve();
        inner = silent();
      }
      await inner.done; resolve();
    })();
    return { done, stop: () => { stopped = true; inner?.stop(); resolve(); } };
  }

  // ---------------------------------------------------------------- GM tools (the host as GM, a human guest GM, or the AI's actions)
  gmDo(a: GmAction, from = this.selfKey) {
    if (!this.isHost) { this.party.sendTtrpg({ k: 'gm', a } satisfies PartyTtrpg); return; }
    const g = this.game; if (!g) return;
    if (from !== this.selfKey && !(g.gm.kind === 'human' && g.gm.who === from)) return;     // only the GM may
    const o = applyAction(g, a);
    for (const l of o.log) log(g, 'system', 'gm', 'Table', l);
    for (const s of o.speak) { log(g, 'npc', 'gm', s.name, s.text); if (g.gm.kind === 'ai') this.queueSpeech('npc', s.name, s.text, s.voice); }
    if (o.cam) this.pin(o.cam.shot as TtrpgShot, o.cam.who);
    this.changed();
  }
  pin(shot: TtrpgShot, who?: string, secs = 8) {
    const g = this.game; if (!g) return;
    g.table.cam = shot; if (who) g.table.camWho = who; else delete g.table.camWho;
    clearTimeout(this.camReset);
    if (shot !== 'auto' && secs > 0) this.camReset = window.setTimeout(() => { g.table.cam = 'auto'; this.pushTable(); }, secs * 1000);
    this.pushTable();
  }
  narrate(text: string) { const g = this.game; if (!g) return; log(g, 'gm', 'gm', g.gm.look.name, text); if (g.gm.kind === 'ai') this.queueSpeech('gm', g.gm.look.name, text); this.changed(false); }
  note(text: string, who = 'gm') { const g = this.game; if (!g) return; log(g, 'system', who, 'Table', text); this.changed(false); }
  damage(name: string, amount: number) { const g = this.game; if (!g) return; const t = findTarget(g, name); if (t) { log(g, 'system', 'gm', 'Table', applyHp(g, t, -amount)); this.changed(); } }
  newScene(title: string, tpl: string) { const g = this.game; if (!g) return; setScene(g, title, tpl); this.changed(); }
  /** Host: send an image (map / handout) to this PC's OBS pages and to guests (RAM only everywhere). */
  sendImage(id: string, dataUrl: string) {
    this.assetsSent.set(id, dataUrl);
    this.bus.send({ type: 'ttrpg', m: { k: 'asset', id, url: dataUrl } });
    if (this.party.role === 'host') {
      const parts = Math.ceil(dataUrl.length / 45_000);
      for (let i = 0; i < parts; i++) this.party.sendTtrpg({ k: 'asset', id, part: i, of: parts, data: dataUrl.slice(i * 45_000, (i + 1) * 45_000) } satisfies PartyTtrpg);
    }
  }

  // ---------------------------------------------------------------- incoming
  private assetParts = new Map<string, string[]>();
  private onParty(d: unknown, from: string | null) {
    if (from) {        // host: a guest wrote
      const m = sanitizeFromGuest(d);
      if (!m || !this.game) return;
      if (m.k === 'act') this.actFrom(from, m.text, !!m.ooc);
      else if (m.k === 'roll') this.rollFor(from, m.expr, m.label, m.req, m.secret);
      else if (m.k === 'sheet') {
        const own = this.game.chars.find((c) => c.id === m.c.id);
        if (own && own.owner && own.owner !== from) return;                          // only your own sheet
        this.setSheet({ ...m.c, owner: from });
      } else if (m.k === 'x') this.xcard(from);
      else if (m.k === 'pause') this.note(`${this.memberName(from)} asked for a pause.`, from);
      else if (m.k === 'move') { const t = this.game.table.tokens.find((x) => x.id === m.tok); if (t && (t.owner === from || this.game.gm.who === from)) { t.x = m.x; t.y = m.y; this.changed(); } }
      else if (m.k === 'gm') this.gmDo(m.a, from);
      return;
    }
    const m = sanitizeFromHost(d);     // guest: the host wrote
    if (!m) return;
    if (m.k === 'game') { this.view = m.g; this.emit(); }
    else if (m.k === 'speak') {
      if (!this.hearGm) return;
      // (a guest's own voice settings; 'stream' plays it on the guest's own OBS page from their own server)
      const h = this.voiceLine(m.id, m.text, m.npc ? m.voice ?? 'rough' : undefined, estimateDuration(m.text, 1), () => {});
      void h.done;
    } else if (m.k === 'asset') {
      const arr = this.assetParts.get(m.id) ?? new Array<string>(m.of).fill('');
      arr[m.part] = m.data; this.assetParts.set(m.id, arr);
      if (arr.every(Boolean)) { this.assetParts.delete(m.id); this.bus.send({ type: 'ttrpg', m: { k: 'asset', id: m.id, url: arr.join('') } }); }
    }
  }

  private onBus(m: TtrpgBus) {
    if (m.k === 'vttStatus') { this.vtt.clients = m.clients; this.emit('vtt'); return; }
    if (m.k !== 'vtt' || !this.isHost || !this.game?.table.on) return;
    this.applyVtt(m.m);
  }

  /** A VTT (Foundry / Owlbear / Roll20) relayed something: mirror it on the 3D table. */
  applyVtt(v: VttMsg) {
    const g = this.game; if (!g) return;
    this.vtt.last = `${v.src}: ${v.k}`;
    if (v.k === 'roll') {
      const dice = v.dice.filter((d) => [4, 6, 8, 10, 12, 20, 100].includes(d.s)).slice(0, 12);
      const crit = dice.length === 1 && dice[0].s === 20 ? (dice[0].v === 20 ? 'hi' : dice[0].v === 1 ? 'lo' : null) : null;
      const r = { id: `v${rid()}`, who: 'gm', name: v.who, label: v.label || 'Roll', expr: v.expr || `${dice.length} dice`, dice, mod: v.total - dice.reduce((a, d) => a + d.v, 0), total: v.total, crit, at: nextThrowAt(g, 300), seed: Math.floor(Math.random() * 2 ** 31) } as const;
      g.table.rolls = [...g.table.rolls, r].slice(-8);
      log(g, 'roll', 'gm', v.who, `${v.who} (${v.src}) rolls ${v.label || v.expr}: ${v.total}`);
    } else if (v.k === 'chat') log(g, 'player', 'gm', v.who, `${v.text} (${v.src})`);
    else if (v.k === 'init') g.table.init = { on: v.order.length > 0, round: v.round, turn: Math.min(v.turn, Math.max(0, v.order.length - 1)), order: v.order.map((o, i) => ({ id: `vi${i}`, name: o.name, init: o.init, kind: 'npc' as const, tok: g.table.tokens.find((t) => t.name === o.name)?.id })) };
    else if (v.k === 'tokens') {
      if (!g.table.map) g.table.map = { tpl: 'room', seed: 1, title: g.title, grid: Math.min(60, v.cols), rows: Math.min(60, v.rows) };
      const keep = g.table.tokens.filter((t) => t.kind === 'pc' && !v.tokens.some((x) => x.name === t.name));
      g.table.tokens = [...keep, ...v.tokens.slice(0, 40).map((t) => ({ id: `vt${t.id}`.slice(0, 40), name: t.name, kind: t.pc ? 'pc' as const : 'monster' as const, x: t.x, y: t.y, color: t.color ?? (t.pc ? '#45b7d1' : '#a8453a'), ...(t.hp ? { hp: t.hp } : {}) }))];
    } else if (v.k === 'sheet') { const r = importCharacter(v.actor); if (r.c) { const same = g.chars.find((c) => c.name === r.c!.name); this.setSheet(same ? { ...r.c, id: same.id, owner: same.owner } : r.c); } }
    else if (v.k === 'scene') { if (g.table.map) g.table.map.title = v.title; else setScene(g, v.title, 'room'); }
    this.changed();
  }

  // ---------------------------------------------------------------- settings (host)
  setGm(p: Partial<TtrpgGame['gm']>) { const g = this.game; if (!g) return; g.gm = { ...g.gm, ...p, look: { ...g.gm.look, ...(p.look ?? {}) } }; if (p.kind === 'human' && p.who) this.scene.move(p.who, 11); this.changed(); }
  setAi(p: Partial<TtrpgGame['ai']>) { const g = this.game; if (!g) return; g.ai = { ...g.ai, ...p }; this.changed(false); }
  setVoice(p: Partial<TtrpgGame['voice']>) { const g = this.game; if (!g) return; g.voice = { ...g.voice, ...p }; this.saveLocal(); this.emit(); }
  setOverlay(p: Partial<SceneTtrpgState['overlay']>) { const g = this.game; if (!g) return; g.table.overlay = { ...g.table.overlay, ...p }; this.pushTable(); this.emit(); }
  setTitle(t: string) { const g = this.game; if (!g) return; g.title = t.slice(0, 80); this.changed(); }
  setSystem(s: TtrpgSystem) { const g = this.game; if (!g) return; g.system = s; this.changed(); }
  setMood(m: SceneTtrpgState['mood']) { const g = this.game; if (!g) return; g.table.mood = m; this.pushTable(); this.emit(); }
  moveToken(id: string, x: number, y: number) {
    if (!this.isHost) { this.party.sendTtrpg({ k: 'move', tok: id, x, y } satisfies PartyTtrpg); return; }
    const t = this.game?.table.tokens.find((k) => k.id === id); if (!t) return; t.x = x; t.y = y; this.changed();
  }
  newCampaign(system: TtrpgSystem) { this.stopAll(); this.game = null; localStorage.removeItem(LS_LAST); this.enter({ system, fresh: true }); }
}

export { sanitizeCharacter };
