// DJ decks, the page side (docs/DJ_SYNC.md "DJ decks"; every OBS page, the studio preview, party guests' OBS):
// a generic DJ setup in front of the performer at the room's DJ spot (club / festival booth `djSpot`, scene.json
// `djdeck.spot`, or wherever the host stands), copying the DJ's real controller from the helper's {type:'djdeck'}
// snapshots (server/music/deckRig.ts; listen-only): platters turn with the jog and spin while a deck plays, faders /
// knobs / the crossfader sit where the real ones are, pads and buttons light, meters follow the music input, the
// screens show the track. The host's hands play it (deckPerformer.ts) with the hand picked per control
// (shared/djDeck/hands.ts). Placement fits the performer: the gear is scaled to the avatar's arm length and put at
// elbow height, a short reach in front. Setting: SceneState.djdeck (shared/djDeck/state.ts).
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime.ts';
import type { SceneActor } from '../actor.ts';
import { beatClock, epochNow } from '../beatClock.ts';
import { musicClock } from '../musicClockRx.ts';
import { DeckProp, type PropFrame } from './deckProp.ts';
import { DeckPerformer, type HandSide, type HandTarget, type PerformInput } from './deckPerformer.ts';
import { paintFacade, paintLaptop, paintPlayer, type DeckScreenData } from './deckScreens.ts';
import { HandPlanner } from '../../../shared/djDeck/hands.ts';
import { sanitizeDeckSnapshot, type DeckSnapshot } from '../../../shared/djDeck/reader.ts';
import { sanitizeDjDeckState, type SceneDjDeckState } from '../../../shared/djDeck/state.ts';
import type { LayoutId } from '../../../shared/djDeck/layout.ts';
import type { TrackShow } from '../../../shared/trackShow.ts';

const REF_ARM = 0.57;            // shoulder → wrist of the 1.75 m performer the layouts are drawn for
const WAVE_N = 220;
const smooth = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
const HOST = '@host';
const SIDES = ['L', 'R'] as const;
const PLAY_ID = { L: 'L.play', R: 'R.play' } as const, JOG_ID = { L: 'L.jog', R: 'R.jog' } as const, TEMPO_ID = { L: 'L.tempo', R: 'R.tempo' } as const;
const FADER_ID = ['', 'ch1.fader', 'ch2.fader', 'ch3.fader', 'ch4.fader'] as const;
/** Per-frame scratch (update runs every frame: no allocation once the decks are placed). */
const SC = { pos: new THREE.Vector3(), centre: new THREE.Vector3(), probe: new THREE.Vector3(), fwd: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1), qW: new THREE.Quaternion(), rootQ: new THREE.Quaternion(), sv: new THREE.Vector3() };

interface Fit { s: number; topY: number; near: number; floorY: number; pos: THREE.Vector3; fwd: THREE.Vector3; key: string }

export class DeckScene {
  private rt: SceneRuntime | null = null;
  private prop: DeckProp | null = null;
  private perf: DeckPerformer | null = null;
  private planner = new HandPlanner();
  /** Newest controller snapshot + when it arrived here (local epoch ms). */
  snap: DeckSnapshot | null = null;
  private rxAt = -Infinity;
  packets = 0;
  private touches = new Map<string, number>();
  /** When each part last sent anything (kept longer than the touch glow: the stuck-note guard). */
  private lastMsg = new Map<string, number>();
  private jogSeen = { L: NaN, R: NaN };
  private jogPend = { L: 0, R: 0 };
  /** Platter angle shown (turns). */
  readonly jogVis = { L: 0, R: 0 };
  private grab: Record<HandSide, { part: string | null; at: number; v0: number }> = { left: { part: null, at: 0, v0: 0 }, right: { part: null, at: 0, v0: 0 } };
  private press: Record<HandSide, number> = { left: 0, right: 0 };
  private hw: Record<HandSide, number> = { left: 0, right: 0 };
  private wave = new Float32Array(WAVE_N * 3);
  private waveAcc = 0;
  private paintAcc = 1;
  private fit: Fit | null = null;
  private standKey = '';
  private standOn = false;
  private hosts: SceneActor | null = null;
  private perfStats = { avg: 0, peak: 0 };
  /** Test pages: a local setting instead of the host's (vtpOut.djdeck.force({...})). */
  forced: SceneDjDeckState | null = null;
  private targets: Record<HandSide, HandTarget> = { left: this.blankTarget(), right: this.blankTarget() };
  /** Reused every frame. */
  private pf: PropFrame = { x: {}, jog: { L: 0, R: 0 }, held: new Set(), lit: new Set(), glow: new Map(), level: [0, 0, 0, 0, 0], beat: 0 };
  private pi: PerformInput = { on: 1, idleHold: 1, hands: this.targets, topY: 0, fwd: new THREE.Vector3(0, 0, 1), s: 1, beat: NaN, music: 0 };

  private blankTarget(): HandTarget { return { w: 0, kind: null, contact: new THREE.Vector3(), center: new THREE.Vector3(), radius: 0.1, rim: false, press: 0, roll: 0, idle: new THREE.Vector3() }; }

  /** A bus message ({type:'djdeck', s}). */
  onBus(m: { s?: unknown }, now = epochNow()) {
    const s = sanitizeDeckSnapshot(m.s); if (!s) return;
    this.take(s, now);
  }
  /** Tests: feed a snapshot directly. */
  take(s: DeckSnapshot, now = epochNow()) {
    for (const side of ['L', 'R'] as const) {
      const seen = this.jogSeen[side];
      if (Number.isFinite(seen)) { const d = s.j[side] - seen; if (Math.abs(d) < 4) this.jogPend[side] += d; }
      this.jogSeen[side] = s.j[side];
    }
    for (const [id, age] of Object.entries(s.k)) { const at = now - age; if ((this.touches.get(id) ?? -Infinity) < at - 5) this.touches.set(id, at); if ((this.lastMsg.get(id) ?? -Infinity) < at) this.lastMsg.set(id, at); }
    if (this.lastMsg.size > 200) for (const [id, at] of this.lastMsg) if (now - at > 60000) this.lastMsg.delete(id);
    this.snap = s; this.rxAt = now; this.packets++;
  }
  live(now = epochNow()) { return !!this.snap && now - this.rxAt < 15000; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
  }
  detach() {
    this.perf?.release(); this.perf = null;
    this.prop?.dispose(); this.prop = null;
    this.fit = null; this.standKey = ''; this.rt = null; this.hosts = null;
  }

  private state(): SceneDjDeckState { return this.forced ?? sanitizeDjDeckState(this.rt?.state.djdeck); }
  /** The room's DJ spot (0-based) or null. */
  private roomSpot(): number | null {
    const info = this.rt?.info as unknown as { club?: { djSpot?: string }; festival?: { djSpot?: string }; djdeck?: { spot?: string } } | undefined;
    const name = info?.djdeck?.spot ?? info?.club?.djSpot ?? info?.festival?.djSpot;
    const m = /SPOT_(\d+)$/.exec(name ?? '');
    return m ? +m[1] - 1 : null;
  }
  private layoutId(st: SceneDjDeckState): LayoutId { return st.look === 'auto' ? (this.snap?.lay ?? 'cdj') : st.look; }

  update(dt: number) {
    const rt = this.rt; if (!rt) return;
    const st = this.state();
    if (!st.on) { if (this.prop) { this.perf?.release(); this.perf = null; this.prop.dispose(); this.prop = null; this.fit = null; } return; }
    const p0 = performance.now();
    const now = epochNow();
    const spotIdx = st.spot ?? this.roomSpot() ?? rt.seatOf(HOST)?.index ?? 0;
    const spot = rt.room.spots[spotIdx] ?? rt.room.spots.find((x) => !!x) ?? null;
    if (!spot) return;
    const lay = this.layoutId(st);
    if (!this.prop || this.prop.id !== lay) {
      this.prop?.dispose();
      this.prop = new DeckProp(lay);
      rt.root.add(this.prop.root);
      this.fit = null; this.standKey = '';
    }
    const host = rt.actors.get(HOST) ?? null;
    const atDecks = !!host && host.shown && !!host.runtime && rt.seatOf(HOST)?.index === spot.index && !rt.mover.busy(host);
    // ---- fit + place (cheap; the stand probe runs once per placement)
    this.fit = this.fitTo(rt, spot, atDecks ? host : null, st);
    this.place(rt, this.fit, st);
    // ---- controller state → the prop
    const frame = this.frame(now, dt, st);
    this.prop.update(frame);
    // ---- hands
    if (atDecks && st.hands && host) {
      if (!this.perf || this.perf.actor !== host) { this.perf?.release(); this.perf = new DeckPerformer(host); }
      this.perf.update(this.performInput(now, dt, frame, st));
    } else if (this.perf) {
      const pi = this.performInput(now, dt, frame, st); pi.on = 0; this.perf.update(pi);
      if (!atDecks) { this.perf.release(); this.perf = null; }
    }
    // ---- screens (~12 fps)
    this.paintAcc += dt;
    if (this.paintAcc >= 1 / 12 && !(typeof document !== 'undefined' && document.hidden)) { this.paintAcc = 0; this.paint(now, frame); }
    const ms = performance.now() - p0;
    this.perfStats.avg += (ms - this.perfStats.avg) * 0.05; this.perfStats.peak = Math.max(this.perfStats.peak * 0.995, ms);
  }

  // ------------------------------------------------------------------------------------------ fit + placement
  private fitTo(rt: SceneRuntime, spot: NonNullable<SceneRuntime['room']['spots'][number]>, actor: SceneActor | null, st: SceneDjDeckState): Fit {
    const fwd = SC.fwd.copy(spot.forward).setY(0).normalize();
    let shoulderY: number, arm: number, Lu: number, floorY = spot.position.y;
    const pos = actor ? actor.mount.getWorldPosition(SC.pos) : SC.pos.copy(spot.position);
    const J = actor?.rest?.joints, A = actor?.anchor;
    if (J && A && J.leftUpperArm && J.leftLowerArm && J.leftHand && J.rightUpperArm) {
      A.updateWorldMatrix(true, false);
      const su = A.localToWorld(SC.a.copy(J.leftUpperArm)), el = A.localToWorld(SC.b.copy(J.leftLowerArm));
      Lu = su.distanceTo(el);
      const wr = A.localToWorld(SC.centre.copy(J.leftHand)); arm = Lu + el.distanceTo(wr);
      const sr = A.localToWorld(SC.b.copy(J.rightUpperArm));
      shoulderY = (su.y + sr.y) / 2;
      floorY = pos.y;
      // seated (a chair spot) or crouching: the shoulders are where they are now, not where they stand at rest
      // (2 cm steps so tracking sway never moves the decks)
      const hum = actor?.runtime?.humanoid;
      const lu = hum?.getNormalizedBoneNode('leftUpperArm'), ru = hum?.getNormalizedBoneNode('rightUpperArm');
      if (lu && ru && (actor?.sit ?? 0) > 0.5) {
        const live = (lu.getWorldPosition(SC.a).y + ru.getWorldPosition(SC.b).y) / 2;
        if (Number.isFinite(live) && live > floorY && live < shoulderY + 0.05) shoulderY = Math.round(live / 0.02) * 0.02;
      }
    } else {
      const H = (rt.info.avatarHeight ?? 1.5) * (rt.state.avatarScale ?? 1);
      shoulderY = floorY + H * 0.82; Lu = H * 0.172; arm = H * 0.326;
    }
    const s = THREE.MathUtils.clamp(arm / REF_ARM, 0.45, 1.7);
    const topY = shoulderY - 1.32 * Lu + st.height * s;
    const near = 0.3 * arm + st.dist * s;
    // keep the previous fit unless something moved by more than a centimetre (no per-frame jitter from tracking)
    const p = this.fit;
    if (p && Math.hypot(p.pos.x - pos.x, p.pos.y - floorY, p.pos.z - pos.z) < 0.01 && Math.abs(p.s - s) < 0.003 && Math.abs(p.topY - topY) < 0.01 && Math.abs(p.near - near) < 0.01 && p.fwd.dot(fwd) > 0.9999) return p;
    const key = `${spot.index}|${pos.x.toFixed(1)},${pos.z.toFixed(1)},${floorY.toFixed(1)}|${s.toFixed(3)}|${topY.toFixed(3)}|${near.toFixed(3)}|`;
    return { s, topY, near, floorY, pos: new THREE.Vector3(pos.x, floorY, pos.z), fwd: fwd.clone(), key };   // (a new placement only)
  }

  private place(rt: SceneRuntime, f: Fit, st: SceneDjDeckState) {
    const prop = this.prop!, L = prop.layout;
    const centre = SC.centre.copy(f.pos).addScaledVector(f.fwd, f.near + (L.d / 2) * f.s); centre.y = f.topY;
    const yaw = Math.atan2(f.fwd.x, f.fwd.z);
    const qW = SC.qW.setFromAxisAngle(SC.up, yaw);
    rt.root.updateWorldMatrix(true, false);
    const rootQ = rt.root.getWorldQuaternion(SC.rootQ), rootS = rt.root.getWorldScale(SC.sv).x || 1;
    prop.root.position.copy(centre); rt.root.worldToLocal(prop.root.position);
    prop.root.quaternion.copy(rootQ.invert().multiply(qW));
    prop.gear.scale.setScalar(f.s / rootS);
    // a stand when the room has nothing there to put the decks on
    // (the room probe runs once per placement: a coarse key, so tracking sway never re-probes)
    // (the key is the placement's own: built once per placement, compared by reference)
    const sk = f.key + st.stand;
    if (this.standKey !== sk) {
      this.standKey = sk;
      let on = st.stand === 'on';
      if (st.stand === 'auto') {
        on = true;
        try {
          const rays = rt.seatEnv.rays();
          prop.root.visible = false;
          const probe = SC.probe.copy(centre); probe.y = f.topY - L.h * f.s - 0.004;
          const below = rays.floorBelow(probe, 2);
          // a booth / table top right under the gear (≤ 15 cm below its bottom): put the decks on it
          if (below !== null && probe.y - below < 0.15 * f.s && below > f.floorY + 0.3) on = false;
        } catch { /* no rays: a stand */ }
        prop.root.visible = true;
      }
      this.standOn = on;
      prop.setStand(on, (f.topY - f.floorY) / f.s);
    }
  }

  // ------------------------------------------------------------------------------------------ controller → frame
  private frame(now: number, dt: number, st: SceneDjDeckState): PropFrame {
    const s = this.snap;
    // (held parts; a note-off that never came — a cable pulled mid-press — lets go after 10 s without a move)
    const F = this.pf, held = F.held, lit = F.lit;
    held.clear(); lit.clear();
    if (s && now - this.rxAt < 4000) for (const id of s.on) if (now - (this.lastMsg.get(id) ?? now) < 10000) held.add(id);
    if (s) for (const id of s.lit) lit.add(id);
    const x = s?.x ?? F.x;
    const c = musicClock.active(now) ? musicClock.clock : null;
    for (const side of SIDES) {
      const p = this.playing(side, c, x);
      if (p) lit.add(PLAY_ID[side]);
      const touched = held.has(JOG_ID[side]);
      // controller turns (smoothed over ~60 ms) + 33⅓ rpm at the tempo fader's pitch while playing and not held
      const step = this.jogPend[side] * Math.min(1, dt / 0.06);
      this.jogPend[side] -= step;
      if (Math.abs(this.jogPend[side]) > 2) { this.jogVis[side] += this.jogPend[side]; this.jogPend[side] = 0; }
      const pitch = ((x[TEMPO_ID[side]] ?? 0.5) - 0.5) * 2 * 0.08;
      this.jogVis[side] += step + (p && !touched ? (33.333 / 60) * (1 + pitch) * dt : 0);
    }
    const glow = F.glow; glow.clear();
    for (const [id, at] of this.touches) { const a = (now - at) / 1000; if (a > 1.2) { this.touches.delete(id); continue; } glow.set(id, Math.max(0, 1 - a / 1.2)); }
    // meters: the music input × each channel's fader (× its deck playing); master = the music input
    beatClock.update(now);
    const e = beatClock.env, lvl = Math.min(1, (beatClock.active(now) ? e.e * 0.85 + e.k * 0.35 : 0));
    const level = F.level; level[0] = lvl;
    for (let ch = 1; ch <= 4; ch++) {
      const side = ch % 2 === 1 ? 'L' : 'R', isLayer = (s?.ly[side] ?? (ch <= 2 ? ch : 0)) === ch;
      let on = isLayer && this.playing(side, c, x);
      if (!isLayer && c?.decks) for (const k of c.decks) if (k.n === ch && k.playing) on = true;
      level[ch] = lvl * (x[FADER_ID[ch]] ?? (ch <= 2 ? 0.85 : 0)) * (on ? 1 : 0.08) * (0.9 + 0.1 * Math.sin(now / 90 + ch));
    }
    // the live waveform history (~30 samples a second)
    this.waveAcc += dt;
    if (this.waveAcc >= 1 / 30) {
      this.waveAcc = 0;
      this.wave.copyWithin(0, 3);
      const on = beatClock.active(now);
      this.wave[WAVE_N * 3 - 3] = on ? Math.min(1, e.lo * 1.1 + e.k * 0.4) : 0.02;
      this.wave[WAVE_N * 3 - 2] = on ? Math.min(1, e.mi * 1.1) : 0.02;
      this.wave[WAVE_N * 3 - 1] = on ? Math.min(1, e.hi * 1.2 + e.h * 0.2) : 0.02;
    }
    const beat = this.beatNow(now);
    void st;
    F.x = x; F.jog.L = this.jogVis.L; F.jog.R = this.jogVis.R; F.beat = Number.isFinite(beat) ? beat - Math.floor(beat) : (now / 500) % 1;
    return F;
  }
  /** Playing per side: the DJ app's clock (decks) when it says, else the PLAY toggles, else "music on + fader up". */
  private playing(side: 'L' | 'R', c: typeof musicClock.clock, x: Record<string, number>): boolean {
    const s = this.snap, d = s?.ly[side] ?? (side === 'L' ? 1 : 2);
    if (c?.decks) for (const k of c.decks) if (k.n === d) return k.playing;
    if (s?.pl[d - 1]) return true;
    return !!c?.on && (x[FADER_ID[d]] ?? 0) > 0.15;
  }

  private beatNow(now: number) { return musicClock.active(now) ? musicClock.beatAt(now) : beatClock.active(now) ? beatClock.posAt(now) : NaN; }

  // ------------------------------------------------------------------------------------------ hands
  private performInput(now: number, dt: number, f: PropFrame, st: SceneDjDeckState): PerformInput {
    const prop = this.prop!, L = prop.layout, gear = prop.gear;
    gear.updateWorldMatrix(true, false);
    const picks = this.planner.update(now, this.touches, f.held, L);
    const s = gear.getWorldScale(SC.sv).x;
    const topY = gear.localToWorld(SC.a.set(0, 0, 0)).y;
    const fwd = this.pi.fwd.copy(SC.z).transformDirection(gear.matrixWorld).setY(0).normalize();
    const beat = this.beatNow(now);
    const ph = Number.isFinite(beat) ? beat - Math.floor(beat) : 0;
    const pump = Number.isFinite(beat) ? Math.exp(-ph * 6) : 0;
    for (const hand of ['left', 'right'] as const) {
      const pk = picks[hand], T = this.targets[hand], G = this.grab[hand];
      const sg = hand === 'left' ? 1 : -1;
      // groove / rest: hovering over the near edge between the deck and the mixer, bobbing on the beat
      const idleU = (L.id === 'ctrl4' ? 0.16 : 0.2) * (hand === 'left' ? -1 : 1);
      T.idle.set(-idleU + sg * 0.008 * Math.sin((Number.isFinite(beat) ? beat : now / 500) * Math.PI), 0.085 + 0.014 * pump, -L.d / 2 + 0.075);
      gear.localToWorld(T.idle);
      this.hw[hand] += ((pk.part ? 1 : 0) - this.hw[hand]) * Math.min(1, dt / (pk.part ? 0.1 : 0.4));
      T.w = smooth(this.hw[hand]);
      if (!pk.part) { G.part = null; this.press[hand] = Math.max(0, this.press[hand] - dt / 0.12); T.press = this.press[hand]; continue; }
      const part = L.byId.get(pk.part)!;
      T.kind = part.kind;
      if (G.part !== pk.part) { G.part = pk.part; G.at = part.kind === 'jog' ? this.jogVis[part.side as 'L' | 'R'] : 0; G.v0 = f.x[pk.part] ?? 0.5; }
      if (part.kind === 'jog') {
        const side = part.side as 'L' | 'R';
        const rim = this.snap?.jm[side] === 'side' && !f.held.has(pk.part);
        let d = this.jogVis[side] - G.at;
        if (Math.abs(d) > 0.11) { G.at = this.jogVis[side] - Math.sign(d) * 0.02; d = Math.sign(d) * 0.02; }   // the hand slides back and grabs again
        const base = sg * (rim ? 0.75 : 0.55);
        const a = base - d * Math.PI * 2;
        const r = part.r * (rim ? 1.0 : 0.52);
        T.center.set(-part.u, 0.017, part.v); gear.localToWorld(T.center);
        T.contact.set(-part.u + Math.sin(a) * r, 0.017, part.v - Math.cos(a) * r); gear.localToWorld(T.contact);
        T.radius = part.r * s; T.rim = rim; T.roll = 0;
      } else {
        prop.contact(pk.part, f, T.contact); gear.localToWorld(T.contact);
        T.rim = false;
        if (part.kind === 'knob' || part.kind === 'encoder') {
          let dv = (f.x[pk.part] ?? 0.5) - G.v0;
          if (part.kind === 'encoder') dv = ((dv + 1.5) % 1) - 0.5;
          if (Math.abs(dv) > 0.22) { G.v0 = (f.x[pk.part] ?? 0.5) - Math.sign(dv) * 0.05; dv = Math.sign(dv) * 0.05; }
          T.roll = -dv * (300 * Math.PI / 180);
        } else T.roll = 0;
      }
      const pressing = f.held.has(pk.part) || (now - (this.touches.get(pk.part) ?? -Infinity) < 120);
      this.press[hand] = pressing ? 1 : Math.max(0, this.press[hand] - dt / 0.12);
      T.press = this.press[hand];
    }
    const pi = this.pi;
    pi.on = 1; pi.idleHold = st.idle === 'groove' ? 1 : 0; pi.topY = topY; pi.s = s; pi.beat = beat; pi.music = Number.isFinite(beat) ? 1 : 0;
    return pi;
  }

  // ------------------------------------------------------------------------------------------ screens
  private shows(): Map<string, TrackShow> | null { return (musicClock.show as unknown as { shows?: Map<string, TrackShow> }).shows ?? null; }
  private screenData(side: 'L' | 'R', now: number, f: PropFrame): DeckScreenData {
    const s = this.snap, n = s?.ly[side] ?? (side === 'L' ? 1 : 2);
    const c = musicClock.active(now) ? musicClock.clock : null;
    const cd = c?.decks?.find((k) => k.n === n);
    const tr = c?.track && (c.track.deck === n || (!c.track.deck && side === 'L')) ? c.track : null;
    const trk = c?.trk && c.trk.deck === n ? c.trk : null;
    const show = trk ? this.shows()?.get(trk.id) ?? null : null;
    let pos = NaN, sections: DeckScreenData['sections'] = null, drops: number[] = [];
    if (show && trk) {
      const span = Math.max(1, show.to - show.from), b = musicClock.show.beatAt(now);
      pos = Number.isFinite(b) ? Math.min(1, Math.max(0, (b - show.from) / span)) : NaN;
      sections = show.sections.map((q) => [(q.b - show.from) / span, (q.e - show.from) / span, q.energy]);
      drops = show.drops.map((d) => (d - show.from) / span);
    } else if (tr?.posMs !== undefined && tr.lenMs) pos = tr.posMs / tr.lenMs;
    const pitch = ((f.x[`${side}.tempo`] ?? 0.5) - 0.5) * 2 * 0.08;
    const ph = musicClock.active(now) ? musicClock.phraseAt(now) : null;
    return {
      n, title: cd?.title ?? tr?.title ?? '', artist: cd?.artist ?? tr?.artist ?? '', bpm: cd?.bpm ?? c?.bpm ?? (beatClock.active(now) ? beatClock.bpm : 0),
      pitch, playing: f.lit.has(`${side}.play`), onAir: c?.onAir ? c.onAir === n : side === 'L' ? (f.x['m.xf'] ?? 0.5) <= 0.5 : (f.x['m.xf'] ?? 0.5) > 0.5,
      pos, wave: this.wave, waveN: WAVE_N, sections, drops, beat: f.beat, dropIn: ph?.known && ph.dropIn !== undefined && trk ? ph.dropIn : 0, accent: side === 'L' ? '#35e3ff' : '#ff3fd2',
    };
  }
  private paint(now: number, f: PropFrame) {
    const prop = this.prop; if (!prop) return;
    const A = this.screenData('L', now, f), B = this.screenData('R', now, f);
    for (const sc of prop.screens) {
      if (sc.id === 'laptop') paintLaptop(sc.canvas, A, B);
      else paintPlayer(sc.canvas, sc.side === 'R' ? B : A);
      sc.tex.needsUpdate = true;
    }
    if (prop.facade && this.standOn) { paintFacade(prop.facade.canvas, A.onAir ? A : B, now / 1000); prop.facade.tex.needsUpdate = true; }
  }

  // ------------------------------------------------------------------------------------------ debug / tests
  info() {
    const p = this.perf;
    return {
      on: !!this.prop, layout: this.prop?.id ?? null, live: this.live(), packets: this.packets, device: this.snap?.dev ?? null, profile: this.snap?.pid ?? null,
      fit: this.fit && { s: +this.fit.s.toFixed(3), topY: +this.fit.topY.toFixed(3), near: +this.fit.near.toFixed(3) }, stand: this.standOn,
      hands: { left: this.planner.hands.left.part, right: this.planner.hands.right.part }, perf: p ? p.last : null, lean: p ? +p.lean.toFixed(3) : 0,
      jog: { L: +this.jogVis.L.toFixed(3), R: +this.jogVis.R.toFixed(3) }, ms: +this.perfStats.avg.toFixed(3), peak: +this.perfStats.peak.toFixed(3),
      parts: this.prop ? this.prop.parts.size : 0,
      draws: (() => { let n = 0; this.prop?.root.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh) n++; }); return n; })(),
    };
  }
  /** World position of a part (tests: where to point the camera / compare the hands). */
  partWorld(id: string): [number, number, number] | null {
    const prop = this.prop; if (!prop) return null;
    const v = prop.contact(id, null); if (!v) return null;
    prop.gear.updateWorldMatrix(true, false); prop.gear.localToWorld(v);
    return [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
  }
  get root(): THREE.Object3D | null { return this.prop?.root ?? null; }
  /** Tests / cameras: the gear's top centre, its forward (DJ → room) and the host's head (world). */
  view(): { centre: number[]; fwd: number[]; top: number; host: number[] | null; s: number } | null {
    const prop = this.prop, rt = this.rt; if (!prop || !rt) return null;
    prop.gear.updateWorldMatrix(true, false);
    const c = prop.gear.localToWorld(new THREE.Vector3(0, 0, 0));
    const f = new THREE.Vector3(0, 0, 1).transformDirection(prop.gear.matrixWorld).setY(0).normalize();
    const h = rt.actors.get(HOST);
    const head = h?.runtime?.humanoid?.getNormalizedBoneNode('head')?.getWorldPosition(new THREE.Vector3()) ?? null;
    const r = (v: THREE.Vector3) => [+v.x.toFixed(4), +v.y.toFixed(4), +v.z.toFixed(4)];
    return { centre: r(c), fwd: r(f), top: +c.y.toFixed(4), host: head ? r(head) : null, s: +(this.fit?.s ?? 1).toFixed(3) };
  }
}
