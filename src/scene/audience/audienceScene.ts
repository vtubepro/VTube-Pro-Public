// The chat audience — the page side (OBS pages + the Scene-tab preview; docs/SCENES.md "Chat audience").
//
// Everyone active in chat sits in the room's audience seats (shared/audienceSeats.ts) with their NAME above their head:
//   who + where   the helper's roster ({type:'audience'} views, server/audience.ts): a stable slot per chatter; slot i sits
//                 in the room's seat i (front row first, centre out) → every page seats everyone in the same place;
//   looks         procedural bean folk (bodies.ts), seeded per chatter, shirt = their chat colour; one draw per part;
//   names         one atlas + one instanced draw (nameTags.ts); supporter tiers get their effect (colour, glow, badge,
//                 pulse, particle trail); declutter fades names that would overlap, names never cover a performer's face;
//   reactions     idle sway / looks / blinks; a bob + mouth flap + speech bubble when their message arrives (filtered:
//                 links stripped, blocklist, length cap; emotes drawn); laughs on LUL / KEKW / 😂 (contagious); cheers on
//                 support by size (the supporter jumps; claps → everyone cheers → a stadium wave + confetti); applause
//                 (Stream Deck / panel); a raised hand while their question waits; joins pop in, leaves wave + shrink;
//   questions     approved questions as cards above the asker's name; "now answering": the asker stands in a spotlight,
//                 their card grows, the director gets a camera hook (cams.ts) and (setting) a short close-up;
//                 + an optional clean overlay card (overlay.ts);
//   crowd mode    rooms with no seats but a background crowd: the names / bubbles / cards ride the crowd's dancers.
// Deterministic: everything is a pure function of the helper's view, the chat events' timestamps and the wall clock.
// Costs nothing in rooms without seats (or a crowd), or while the audience is off / empty.
import * as THREE from 'three';
import type { SceneRuntime } from '../SceneRuntime';
import type { ChatEvent, ChatPart } from '../../../shared/chat.ts';
import { chatVisible } from '../../../shared/chat.ts';
import { AskQueue, cheerSize, emptyView, filterText, isLaugh, personKey, resolveNameStyle, sanitizeView, tierRank, type AudienceView, type AudienceMemberView, type QuestionView, type NameStyle } from '../../../shared/audience.ts';
import { orderSeats, seatsFromArea, type SeatSpec } from '../../../shared/audienceSeats.ts';
import { audienceRoomOf, type AudienceRoomInfo } from './audienceRoom.ts';
import { AudienceBodies, TOPPERS, newPose, type BodyLook, type BodyPose } from './bodies.ts';
import { NameTags, tagKey, type TagSpec } from './nameTags.ts';
import { AudienceCards } from './cards.ts';
import { AudienceFx } from './fx.ts';
import { AudienceOverlay } from './overlay.ts';
import { askerPoseClear, audienceWidePose, setAudienceShotSource, type AudienceShotKind, type AudienceShotRequest } from './cams.ts';
import { setNameStyles } from '../../chat/nameStyle.ts';
import type { CamPose } from '../cameraRig.ts';
import { RoomRays } from '../twoShot.ts';
import type { CrowdScene } from '../crowd/crowdScene.ts';

const CAP = 200;
const SKIN = ['#f6d7c3', '#eec1a1', '#d9a07b', '#b97a55', '#8d5a3b', '#5e3b26', '#f3cfb3', '#c58c63', '#9be3b5', '#c9b8ff'].map((h) => new THREE.Color(h));
const HAIR = ['#2a1d17', '#4a2f1f', '#7a4b2a', '#c99a5b', '#e8d6a8', '#1a1a1f', '#b8b8c4', '#d4553b', '#7b4fd8', '#2f9cd8', '#ff6fb1', '#3cbf7a'].map((h) => new THREE.Color(h));
const HATS = ['#e94f4f', '#3d7bd9', '#f2c14e', '#2fbf71', '#9b59d0', '#ff8a3d', '#1e1e24', '#f5f5f5', '#27c4c4', '#e85fa8'].map((h) => new THREE.Color(h));
const SHIRTS = ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff8a', '#c3a6ff', '#ffab76', '#6fffd6', '#ff9aa2', '#b8f35d', '#8fb8ff'];
const CONFETTI = ['#ff4fd8', '#9dff3f', '#35e3ff', '#ffd23a', '#ff7a59', '#ffffff'];

function hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/** A hash of two integers to 0…1 (the per-frame noise: no closures, no allocations). */
function h01(a: number, b: number) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be59b, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function rnd(seed: number) { let s = seed || 1; return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; s ^= s >>> 13; return (s >>> 0) / 4294967296; }; }
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const backOut = (v: number) => { const x = clamp01(v), c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

interface Bubble { id: string; parts: ChatPart[]; at: number; until: number; laugh: boolean }
interface Person {
  k: string; name: string; platform: AudienceMemberView['p']; color: string; slot: number; tier: AudienceMemberView['t'] | null;
  seed: number; look: BodyLook;
  joinAt: number; leftAt: number;
  msgAt: number; laughAt: number; bubble: Bubble | null;
  pose: BodyPose;
  /** name tag: current / target alpha (declutter + faces) */
  na: number; nt: number;
  /** question card size, eased: 0 waiting .. 1 on air */
  cardK: number;
  /** body hidden (over a performer's face, nearer the lens) until */
  hideUntil: number;
  /** screen rect of the tag (declutter, 5 Hz) */
  sx: number; sy: number; depth: number;
  head: THREE.Vector3;
  /** name style + tag, recomputed only when the view changes (not per frame) */
  style: NameStyle; tag: TagSpec; tkey: string;
}
interface Cheer { at: number; k: string; usd: number; big: number; seed: number }

const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3(), tcam = new THREE.Vector3();
const NO_STYLE: NameStyle = { tier: null, color: '', glow: '', badge: 'none', trail: 'none', pulse: false };

export class AudienceScene {
  private rt: SceneRuntime | null = null;
  room: AudienceRoomInfo | null = null;
  private group = new THREE.Group();
  private bodies: AudienceBodies | null = null;
  private names: NameTags | null = null;
  private cards: AudienceCards | null = null;
  private fx: AudienceFx | null = null;
  private overlay = new AudienceOverlay();
  view: AudienceView = emptyView();
  private persons = new Map<string, Person>();
  private order: Person[] = [];
  private cardQs = new Map<string, QuestionView>();
  private poses: (BodyPose | null)[] = [];
  private spotAt = new THREE.Vector3();
  private ovStyle: { id: string; style: NameStyle | null } = { id: '', style: null };
  private orderDirty = true;
  private coloursDirty = true;
  private cheers: Cheer[] = [];
  private firstView = true;
  private lodT = 0;
  private faceRects: { x0: number; y0: number; x1: number; y1: number; d: number }[] = [];
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private answering: { id: string; k: string; since: number } | null = null;
  private hiddenAreas: THREE.Object3D[] = [];
  readonly perf = { avg: 0, peak: 0, n: 0 };
  /** Test pages: time advances only through update(). */
  manual = false;
  clock = Date.now();
  /** Seconds of the asker close-up after "answer now". */
  askerSecs = 7;
  /** Page clock minus helper clock, seconds (setView). */
  private skew = 0;
  /** The question the overlay card showed while it was on air: only that one stays on the overlay while fading out. */
  private ovShownId = '';
  /** Answered cards that shrank (someone else went on air during their fade-out): they stay small. */
  private shrunk = new Set<string>();
  now() { return this.manual ? this.clock : Date.now(); }

  constructor(private crowd: CrowdScene | null = null) {
    this.group.name = 'vtp:audience';
    setAudienceShotSource({ request: () => this.request(), pose: (k, a) => this.shotPose(k, a) });
  }

  // ------------------------------------------------------------------------------------------ lifecycle
  /** The live page reports the seats its room has (install.ts → POST /api/audience/seats). */
  onSeats: ((n: number) => void) | null = null;
  /** Seats (or crowd places) of the room this page shows; 0 = no audience here. */
  seatCount(): number { return !this.room ? 0 : this.room.mode === 'seats' ? this.room.seats.length : this.crowdPoints().length; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    const info = rt.info as unknown as { audience?: unknown; crowd?: unknown };
    const room = audienceRoomOf(rt.root, info);
    if (room.mode === 'none') return;
    this.rt = rt; this.room = room;
    this.group = new THREE.Group(); this.group.name = 'vtp:audience';
    rt.root.add(this.group);
    for (const m of room.areaMeshes) { if (m.visible) { m.visible = false; this.hiddenAreas.push(m); } }
    if (room.mode === 'seats') { this.bodies = new AudienceBodies(CAP); this.group.add(this.bodies.group); }
    this.names = new NameTags(CAP); this.group.add(this.names.mesh);
    this.cards = new AudienceCards(8, 8); this.group.add(this.cards.group);   // (8 question cards: 1 on air + 5 waiting + 2 fading)
    this.fx = new AudienceFx(); this.group.add(this.fx.group);
    this.orderDirty = this.coloursDirty = true;
    // the asker close-up: before the other engines' overrides (the interview engine wraps this one and asks it first)
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect) => this.cameraShot(aspect) ?? this.prevOverride?.(aspect) ?? null;
    hook.cameraOverride = this.myOverride;
    this.onSeats?.(this.seatCount());
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    }
    this.prevOverride = this.myOverride = null;
    this.rays = null; this.askerCache = null;
    for (const m of this.hiddenAreas) m.visible = true;
    this.hiddenAreas = [];
    this.bodies?.dispose(); this.names?.dispose(); this.cards?.dispose(); this.fx?.dispose();
    this.bodies = null; this.names = null; this.cards = null; this.fx = null;
    this.group.removeFromParent();
    this.overlay.update(null, null);
    this.rt = null; this.room = null;
  }

  // ------------------------------------------------------------------------------------------ inputs
  /** A {type:'audience'} view from the helper (or the test demo). */
  setView(raw: unknown) {
    const v = sanitizeView(raw);
    if (!v) return;
    this.view = v;
    setNameStyles(v.on ? v : null);
    const t = this.now() / 1000;
    // this page's clock minus the helper's (a stream PC's clock may differ): helper times (q.since) are compared on ours
    if (v.at > 0) this.skew = t - v.at / 1000;
    const seen = new Set<string>();
    for (const m of v.on ? v.members : []) {
      seen.add(m.k);
      let p = this.persons.get(m.k);
      if (p && p.leftAt > 0) { this.persons.delete(m.k); p = undefined; }
      if (!p) {
        // a seat someone is leaving right now: wait for them to go first
        const ghost = [...this.persons.values()].some((o) => o.slot === m.s && o.leftAt > 0 && t - o.leftAt < 0.9);
        p = this.person(m, this.firstView ? t - 30 : t + (ghost ? 0.7 : 0));
        this.persons.set(m.k, p);
        this.orderDirty = this.coloursDirty = true;
      } else {
        if (p.slot !== m.s) {
          // to / from the bench (a seat the room has vs none): leave with the usual wave from the old seat, or walk in
          const was = this.drawnSlot(p.slot), now = this.drawnSlot(m.s);
          if (was && !now) this.persons.set(`${p.k}\u0000out`, { ...p, k: `${p.k}\u0000out`, leftAt: t, bubble: null, pose: newPose(), head: p.head.clone() });
          else if (!was && now) p.joinAt = t + ([...this.persons.values()].some((o) => o.slot === m.s && o.leftAt > 0 && t - o.leftAt < 0.9) ? 0.7 : 0);
          p.slot = m.s; this.orderDirty = true;
        }
        const c = m.c ?? '';
        if (c && c !== p.color) { p.color = c; p.look.shirt.copy(shirtOf(c, p.seed)); this.coloursDirty = true; }
        p.tier = m.t ?? null; p.name = m.n;
      }
    }
    for (const p of this.persons.values()) if (!seen.has(p.k) && p.leftAt <= 0) { p.leftAt = t; this.orderDirty = true; }
    this.firstView = false;
    // messages deleted in chat: their bubbles come down at once
    if (v.removed.length) for (const p of this.persons.values()) if (p.bubble && v.removed.some((r) => p.bubble!.id === r || p.bubble!.id.endsWith(`:${r}`))) p.bubble = null;
    // name styles + tags (per view, not per frame)
    for (const p of this.persons.values()) this.restyle(p);
    this.ovStyle.id = '';
    // "now answering" changes
    const ans = v.questions.find((q) => q.status === 'answering') ?? null;
    if (ans && ans.id !== this.answering?.id) this.answering = { id: ans.id, k: ans.k, since: Math.min(t, ans.since / 1000 + this.skew + 0.2) };   // (helper time on this page's clock)
    else if (!ans) this.answering = null;
  }

  /** Does this page draw anyone in that slot (a seat, or a crowd place)? */
  private drawnSlot(slot: number): boolean { const r = this.room; return !r ? false : r.mode === 'seats' ? !!r.seats[slot] : !!this.crowdPoints()[slot]; }

  private person(m: AudienceMemberView, joinAt: number): Person {
    const seed = hash(m.k);
    const r = rnd(seed);
    const look: BodyLook = {
      h: 0.92 + r() * 0.2, w: 0.88 + r() * 0.3,
      skin: SKIN[Math.floor(r() * (r() < 0.85 ? 8 : SKIN.length))].clone(),
      shirt: shirtOf(m.c ?? '', seed), hair: HAIR[Math.floor(r() * HAIR.length)].clone(), hat: HATS[Math.floor(r() * HATS.length)].clone(),
      topper: Math.floor(r() * TOPPERS),
    };
    return {
      k: m.k, name: m.n, platform: m.p, color: m.c ?? '', slot: m.s, tier: m.t ?? null, seed, look,
      joinAt, leftAt: 0, msgAt: -99, laughAt: -99, bubble: null, pose: newPose(), na: 0, nt: 1, cardK: 0, hideUntil: 0, sx: 0, sy: 0, depth: 1, head: new THREE.Vector3(),
      style: NO_STYLE, tag: { name: m.n, platform: m.p, color: '', style: NO_STYLE, showPlatform: false }, tkey: '',
    };
  }
  private restyle(p: Person) {
    const style = resolveNameStyle(p.tier ?? this.view.tiers[p.k] ?? null, p.color, this.view.look);
    const tag: TagSpec = { name: p.name, platform: p.platform, color: p.color || SHIRTS[p.seed % SHIRTS.length], style, showPlatform: this.view.look.names.platform };
    const key = tagKey(tag);
    if (key !== p.tkey) { p.style = style; p.tag = tag; p.tkey = key; }
  }

  /** Chat feed events (bus / party relay): messages → bob + bubble (+ laugh), support → cheers. */
  onChat(evs: ChatEvent[], snap: boolean, chatState?: Parameters<typeof chatVisible>[1]) {
    if (snap) return;
    const look = this.view.look, now = this.now();
    for (const e of evs) {
      const ts = (typeof e.ts === 'number' && Math.abs(now - e.ts) < 60_000 ? e.ts : now) / 1000;
      const k = personKey(e.platform, e.user, e.uid);
      if (e.kind === 'finance') {
        const usd = e.usd ?? e.approxUsd ?? (e.fkind === 'giftSub' || e.fkind === 'giftMembership' ? 2.5 * (e.amount ?? 1) : e.fkind === 'sub' || e.fkind === 'resub' || e.fkind === 'membership' ? 5 : 0);
        this.addCheer(ts + 0.8, k, usd);
        continue;
      }
      if (e.kind !== 'chat') continue;
      if (chatState && !chatVisible(e, chatState)) continue;
      const p = this.persons.get(k);
      if (!p || p.leftAt > 0) continue;
      const at = ts + 0.35;
      p.msgAt = at;
      const names = (e.parts ?? []).filter((x) => x.t === 'emote').map((x) => (x as { n: string }).n);
      const laugh = isLaugh(e.text, names);
      if (laugh) p.laughAt = at;
      if (!look.bubbles || /^\s*!/.test(e.text)) continue;
      // the filter: links stripped, blocklist hides the bubble, length cap (emote parts kept as they are)
      const parts: ChatPart[] = [];
      let blocked = false, len = 0;
      for (const part of e.parts ?? [{ t: 'text', v: e.text } as ChatPart]) {
        if (part.t === 'emote') {
          // emote names are typed by viewers on some platforms: filtered and capped like text (a blocked one = no bubble)
          const fe = filterText(part.n, { maxLen: 24, blocklist: look.blocklist, builtin: look.builtinBlock, allow: look.allowWords, words: look.filterWords, linkFilter: look.filterLinks });
          if (fe.blocked || fe.notes.includes('link removed')) { blocked = true; break; }
          parts.push({ t: 'emote', n: fe.text || 'emote', u: part.u }); len += Math.min(8, 2 + fe.text.length / 4); continue;
        }
        const f = filterText(part.v, { maxLen: Math.max(4, 90 - len), blocklist: look.blocklist, builtin: look.builtinBlock, allow: look.allowWords, words: look.filterWords, linkFilter: look.filterLinks });
        if (f.blocked) { blocked = true; break; }   // (a blocked word / a hidden link: no bubble at all)
        if (f.text) { parts.push({ t: 'text', v: (parts.length ? ' ' : '') + f.text }); len += f.text.length; }
        if (len >= 90) break;
      }
      if (blocked || !parts.length) continue;
      const dur = Math.min(9, 3.8 + len * 0.045);
      p.bubble = { id: e.id, parts, at, until: at + dur, laugh };
    }
  }

  private addCheer(at: number, k: string, usd: number) {
    if (this.cheers.some((c) => Math.abs(c.at - at) < 0.05 && c.k === k)) return;
    const big = cheerSize(usd, this.view.look.intensity);
    this.cheers.push({ at, k, usd, big, seed: (Math.round(at * 10) ^ k.length * 7919) | 0 });
    this.cheers.sort((a, b) => a.at - b.at);
    if (this.cheers.length > 16) this.cheers.shift();
  }
  /** Tests (budget runs): extra seats from an area block (root space, yaw in radians), appended after the room's own. */
  testArea(a: { center: [number, number, number]; yaw: number; w: number; d: number; rise?: number }) {
    if (!this.room) return 0;
    const extra = orderSeats(seatsFromArea({ ...a, name: `test_area_${this.room.seats.length}` }, 900 + this.room.seats.length));
    this.room.seats = [...this.room.seats, ...extra];
    this.neighbourCache.clear();
    return this.room.seats.length;
  }
  /** Tests: a support cheer `inSec` from now (usd sets its size). */
  testCheer(k: string, usd: number, inSec = 0.3) { this.addCheer(this.now() / 1000 + inSec, k, usd); }
  /** Tests: a chat message from a seated chatter. */
  testChat(k: string, text: string, parts?: ChatPart[]) {
    const p = this.persons.get(k); if (!p) return false;
    const [platform, ...u] = k.split(':');
    this.onChat([{ id: `t${Math.random()}`, kind: 'chat', platform: platform.split('#')[0] as ChatEvent['platform'], user: p.name, ...(k.includes('#') ? { uid: k.slice(k.indexOf('#') + 1) } : {}), text, ts: this.now(), ...(parts ? { parts } : {}) }], false);
    void u;
    return true;
  }

  // ------------------------------------------------------------------------------------------ per frame
  update(dt: number) {
    if (this.manual) this.clock += dt * 1000;
    const rt = this.rt, room = this.room, names = this.names, cards = this.cards, fx = this.fx;
    if (!rt || !room || !names || !cards || !fx) return;
    const t0 = performance.now();
    const t = this.now() / 1000;
    // drop finished ghosts
    for (const p of this.persons.values()) if (p.leftAt > 0 && t - p.leftAt > 1.2) { this.persons.delete(p.k); this.orderDirty = this.coloursDirty = true; }   // (deleting while iterating a Map is safe)
    if (this.orderDirty) {
      this.order = [...this.persons.values()].sort((a, b) => a.slot - b.slot || a.joinAt - b.joinAt);
      this.orderDirty = false; this.coloursDirty = true;
      this.neighbourCache.clear();   // (seats changed: laughs / claps spread to whoever sits next to them now)
    }
    const cam = rt.stage.camera as THREE.PerspectiveCamera;
    const viewH = rt.stage.renderer.domElement.height || 1080;
    const look = this.view.look;
    const ansQ = this.view.questions.find((q) => q.status === 'answering') ?? null;
    const cardQs = this.cardQs; cardQs.clear();
    for (const q of this.view.questions) if (!cardQs.has(q.k)) cardQs.set(q.k, q);
    // ---- 5 Hz: performer faces, declutter, body protection
    this.lodT -= dt;
    if (this.lodT <= 0) { this.lodT = 0.2; this.faces(cam); this.declutter(cam, viewH, cardQs); }
    // ---- poses
    const crowdMode = room.mode === 'crowd';
    const poses = this.poses; poses.length = 0;
    if (this.bodies) this.bodies.looks.length = 0;
    names.begin(viewH, t, look.names.size);
    cards.begin(); fx.begin();
    let spotAt: THREE.Vector3 | null = null, spotK = 0, spotFloor = 0;
    const crowdPts = crowdMode ? this.crowdPoints() : null;
    const ease = Math.min(1, dt * 7);
    for (const p of this.order) {
      p.na += (p.nt - p.na) * ease;
      const seat = crowdMode ? null : room.seats[p.slot];
      const cp = crowdPts ? crowdPts[p.slot] : null;
      if (!seat && !cp) { if (this.bodies) { poses.push(null); this.bodies.looks.push(null); } continue; }
      const q = cardQs.get(p.k) ?? null;
      const answering = !!ansQ && ansQ.k === p.k;
      // (answered a moment ago: the card stays up for AskQueue.LINGER_MS and fades; the asker sits back down)
      const lingering = q?.status === 'answered';
      if (seat) {
        this.pose(p, seat, t, answering, !!q && !answering && !lingering);
        const hidden = p.hideUntil > t && !answering;
        poses.push(hidden ? null : p.pose); this.bodies!.looks.push(p.look);
        this.bodies!.headTop(p.pose, p.look, p.head);
        if (hidden) continue;   // (over a performer's face, nearer the lens: no name / card either)
      } else if (cp) {
        if (!cp.visible) continue;
        p.head.copy(cp.head);
      }
      // name, bubble, card, trail
      const style = p.style;
      const alpha = p.na * (p.leftAt > 0 ? clamp01(1 - (t - p.leftAt) / 0.6) : clamp01((t - p.joinAt) / 0.4));
      const tagH = 0.12 * look.names.size;
      tv.copy(p.head); tv.y += 0.06;
      names.put(tv, p.tag, p.tkey, tagH, Math.max(alpha, answering ? 1 : 0), style.pulse);
      // the world height the tag really has at its depth (clamped on screen): stack the cards above it
      const depth = this.depthOf(tv, cam), projY = cam.projectionMatrix.elements[5];
      const tagWorld = names.pxHeight(tagH, depth, projY) / (projY * viewH * 0.5 / depth);
      tv2.copy(tv); tv2.y += tagWorld * 1.08;
      if (style.trail !== 'none' && alpha > 0.3) fx.trail(style.trail, tv, tagWorld * 3.2, t, p.seed, style.glow || style.color || '#ffffff');
      const fade = lingering ? clamp01((this.lingerEnd(q!) - t) / 1.5) : 1;
      // card size 0 (waiting) .. 1 (on air), eased: a fading ANSWERED card keeps its size until someone else goes on air,
      // then shrinks smoothly, and never grows back
      if (lingering && ansQ) { if (this.shrunk.size > 64) this.shrunk.clear(); this.shrunk.add(q!.id); }
      const want = answering || (lingering && !this.shrunk.has(q!.id)) ? 1 : 0;
      p.cardK += (want - p.cardK) * ease;
      if (q && p.leftAt <= 0 && p.na > 0.05 && fade > 0.01) {
        const L = (a: number, b: number) => a + (b - a) * p.cardK;
        const pop = answering ? backOut((t - (this.answering?.since ?? t)) / 0.5) : lingering ? 1 : clamp01((t - q.since / 1000) / 0.35);
        cards.show(`q:${q.id}`, { kind: 'question', text: q.text, name: p.name, nameColor: p.color, style, ...(q.paid ? { paid: { display: q.paid.display, tier: q.paid.tier } } : {}), answering, ...(lingering ? { done: true } : {}) }, tv2, L(0.42, 0.62), L(70, 120), L(150, 250), Math.max(0.02, pop), fade, answering ? 3000 : lingering ? 2900 : 2000 + Math.min(999, q.pr));
      } else if (p.bubble && t >= p.bubble.at && t < p.bubble.until && p.na > 0.05) {
        const b = p.bubble;
        const pop = Math.min(backOut((t - b.at) / 0.3), clamp01((b.until - t) / 0.3));
        cards.show(`b:${p.k}`, { kind: 'bubble', parts: b.parts, laugh: b.laugh }, tv2, 0.3, 46, 96, Math.max(0.02, pop), 1, 1000 + (b.at % 900));
      }
      if (answering) {
        const k = clamp01((t - (this.answering?.since ?? t)) / 0.6);
        spotAt = this.spotAt.copy(p.head); spotK = k; spotFloor = seat ? seat.y : p.head.y - 1.2;
      }
      this.reactFx(p, t, cam);
    }
    fx.spot(spotAt, spotFloor, spotK, ansQ?.paid?.tier ? '#fff1d0' : '#fff3c4');
    this.crowdFx(t);
    if (this.bodies) this.bodies.write(poses, this.coloursDirty);
    this.coloursDirty = false;
    names.end(); cards.end(cam, viewH, this.faceRects); fx.end();
    // the overlay card: 'on', or 'auto' in rooms where the question can't sit above anyone
    const ov = look.ask.overlay;
    // the one on air; after Done, only the one the overlay card was showing stays (as ANSWERED) until its fade-out (0.45 s)
    // ends with the linger — a question taken down (Skip, chat delete, ban) has left the view, so it never pops up here
    const lingerQ = ansQ ? null : this.view.questions.find((q) => q.status === 'answered' && q.id === this.ovShownId && this.lingerEnd(q) - 0.45 > t) ?? null;
    const ovQ = ansQ ?? lingerQ;
    const asker = ovQ ? this.persons.get(ovQ.k) : null;
    const seated = !!asker && (crowdMode ? !!crowdPts?.[asker.slot]?.visible : !!room.seats[asker.slot]);
    if (ovQ && this.ovStyle.id !== ovQ.id) this.ovStyle = { id: ovQ.id, style: resolveNameStyle(this.view.tiers[ovQ.k] ?? asker?.tier ?? null, ovQ.color, look) };
    // ('Never' wins at once, the fade-out after Done included)
    const ovOn = !!ovQ && ov !== 'off' && (!!lingerQ || ov === 'on' || (ov === 'auto' && !seated));
    if (ansQ || ov === 'off') this.ovShownId = ovOn && ansQ ? ansQ.id : '';
    this.overlay.update(ovOn ? ovQ : null, ovQ ? this.ovStyle.style : null);
    const ms = performance.now() - t0;
    this.perf.avg += (ms - this.perf.avg) * 0.05; this.perf.peak = Math.max(this.perf.peak * 0.995, ms); this.perf.n = this.order.length;
  }

  /** The current pose of a seated person (pure function of time + events). */
  private pose(p: Person, seat: SeatSpec, t: number, answering: boolean, handUp: boolean) {
    const o = p.pose, r = p.seed, I = this.view.look.intensity;
    const ph = (r % 1000) / 159.2, f = 0.55 + ((r >> 10) % 100) / 300;
    o.x = seat.x; o.y = seat.y; o.z = seat.z; o.yaw = seat.yaw; o.seatH = seat.seatHeight;
    o.sit = seat.pose === 'sit' ? 1 : 0;
    o.lift = 0; o.lean = 0.04 * Math.sin(t * f * 0.7 + ph); o.roll = 0.035 * Math.sin(t * f + ph) * (0.5 + 0.5 * I);
    o.aLx = 0.08; o.aLz = 0.14; o.aRx = 0.08; o.aRz = 0.14;
    // idle looks: now and then a glance to a side
    const lookSeg = Math.floor((t + ph * 3) / 3.7), lr = h01(r, lookSeg);
    o.headYaw = (lr < 0.3 ? -0.45 : lr > 0.75 ? 0.4 : 0) * smooth(((t + ph * 3) % 3.7) / 0.5) + 0.06 * Math.sin(t * 0.4 + ph);
    o.headPitch = 0.04 * Math.sin(t * 0.33 + ph); o.headRoll = 0.03 * Math.sin(t * 0.5 + ph * 2);
    o.mouth = 0;
    const bper = 2.8 + (r % 23) / 10, bp = (t + ph) % bper;
    o.blink = bp < 0.13 ? Math.sin((bp / 0.13) * Math.PI) : 0;
    o.scale = 1; o.visible = true;
    // ---- a message: bob + talk
    const ma = t - p.msgAt;
    if (ma >= 0 && ma < 1.6) {
      o.lift += Math.sin(clamp01(ma / 0.45) * Math.PI) * 0.07 * (0.6 + 0.4 * I);
      o.headPitch -= 0.1 * Math.sin(clamp01(ma / 0.6) * Math.PI);
      o.mouth = Math.max(o.mouth, ma < 1.3 ? 0.35 + 0.35 * Math.sin(t * 17 + ph) : 0);
      o.aRx = 0.35 * Math.sin(clamp01(ma / 1.2) * Math.PI); o.aRz = 0.25;
    }
    // ---- waiting with a question: hand up
    if (handUp) { o.aRz = 2.75 + 0.12 * Math.sin(t * 2.2 + ph); o.aRx = 0.15; o.roll += 0.04; }
    // ---- laughing (theirs, or a neighbour's: contagious)
    let la = t - p.laughAt, lk = 1;
    if (!(la >= 0 && la < 2.6) && I >= 0.7) {
      for (const n of this.neighbours(p, seat)) { const a = t - n.laughAt - 0.35; if (a >= 0 && a < 2.2) { la = a; lk = 0.55; break; } }
    }
    if (la >= 0 && la < 2.6) {
      const e = Math.sin(clamp01(la / 2.6) * Math.PI) * lk;
      o.lean -= 0.28 * e; o.roll += 0.06 * Math.sin(t * 22 + ph) * e; o.lift += Math.abs(Math.sin(t * 11 + ph)) * 0.025 * e;
      o.mouth = Math.max(o.mouth, 0.8 * e); o.aLx = o.aRx = 0.7 * e; o.aLz = o.aRz = -0.25 * e + 0.14 * (1 - e);
      o.headPitch -= 0.18 * e; o.blink = Math.max(o.blink, 0.75 * e);
    }
    // ---- support cheers
    let stand = 0;
    for (const c of this.cheers) {
      const a = t - c.at;
      const own = c.k === p.k;
      const dur = own ? 4.5 : c.big >= 3 ? 5.5 : c.big >= 2 ? 4 : 3;
      if (a < 0 || a > dur) continue;
      const env = smooth(a / 0.35) * smooth((dur - a) / 0.6);
      if (own || c.big >= 2) {
        // arms up, bouncing (the supporter jumps)
        let wave = 1;
        if (!own && c.big >= 3) {
          // a stadium wave sweeps across the seats (left → right), twice
          const lat = (seat.lat + 8) / 16, w1 = Math.exp(-Math.pow(((a / 2.2) % 1) - lat, 2) / 0.012);
          wave = 0.35 + 0.65 * w1;
          stand = Math.max(stand, w1 * env);
        }
        const k = env * wave * (own ? 1 : 0.8 * Math.min(1.2, 0.4 + 0.6 * I));
        o.aLz = Math.max(o.aLz, 2.55 * k + 0.12 * Math.sin(t * 9 + ph)); o.aRz = Math.max(o.aRz, 2.55 * k + 0.12 * Math.sin(t * 9 + ph + 1));
        o.aLx = o.aRx = 0.1;
        o.lift += Math.abs(Math.sin(t * (own ? 7.5 : 6) + ph)) * (own ? 0.24 : 0.09) * k;
        o.mouth = Math.max(o.mouth, 0.85 * k);
        if (own) stand = Math.max(stand, env);
        else if (c.big >= 2) stand = Math.max(stand, 0.6 * env * Math.min(1, I));
      } else if (c.big === 1 || this.near(p, seat, c.k)) {
        this.clap(o, t, ph, env);
      }
    }
    // ---- applause
    const ap = t - this.view.applause.at / 1000 - (r % 7) * 0.05;
    if (this.view.applause.at && ap >= 0 && ap < 4.6) { this.clap(o, t, ph, smooth(ap / 0.3) * smooth((4.6 - ap) / 0.6)); o.mouth = Math.max(o.mouth, 0.5 * smooth(ap / 0.3)); }
    // ---- the asker being answered: stand up, wave, then listen with hands together
    if (answering) {
      const a = t - (this.answering?.since ?? t);
      stand = Math.max(stand, smooth(a / 0.6));
      if (a < 2.4) { o.aRz = 2.5 + 0.35 * Math.sin(a * 9); o.aRx = 0.2; }
      else { o.aLx = o.aRx = 0.95; o.aLz = o.aRz = -0.42; }
      o.headPitch = 0.05; o.headYaw = 0; o.mouth = Math.max(o.mouth, a < 2.4 ? 0.4 : 0);
    }
    if (o.sit > 0) o.sit = Math.max(0, o.sit - stand);
    // ---- join / leave
    if (t < p.joinAt) { o.scale = 0; o.visible = false; }
    else {
      const ja = (t - p.joinAt) / 0.55;
      if (ja < 1) { o.scale = Math.max(0.02, backOut(ja)); o.lift += (1 - smooth(ja)) * 0.25; }
    }
    if (p.leftAt > 0) {
      const la2 = t - p.leftAt;
      if (la2 < 0.45) { o.aRz = 2.4 + 0.4 * Math.sin(la2 * 18); o.aRx = 0.15; }
      else o.scale *= Math.max(0, 1 - smooth((la2 - 0.45) / 0.45));
      o.lift -= Math.max(0, la2 - 0.45) * 0.3;
    }
  }
  private clap(o: BodyPose, t: number, ph: number, k: number) {
    if (k <= 0.01) return;
    const c = Math.sin(t * 15 + ph);
    o.aLx = o.aRx = o.aLx + (1.2 - o.aLx) * k;
    o.aLz = o.aLz + (-0.32 + 0.22 * c - o.aLz) * k; o.aRz = o.aRz + (-0.32 + 0.22 * c - o.aRz) * k;
    o.lean += 0.04 * k;
  }
  private neighbourCache = new Map<string, Person[]>();
  private neighbours(p: Person, seat: SeatSpec): Person[] {
    const key = `${p.k}|${p.slot}|${this.order.length}`;
    let l = this.neighbourCache.get(key);
    if (!l) {
      l = this.order.filter((o) => o !== p && this.room!.seats[o.slot] && Math.hypot(this.room!.seats[o.slot].x - seat.x, this.room!.seats[o.slot].z - seat.z) < 1.4);
      if (this.neighbourCache.size > 400) this.neighbourCache.clear();
      this.neighbourCache.set(key, l);
    }
    return l;
  }
  private near(p: Person, seat: SeatSpec, k: string) { return this.neighbours(p, seat).some((n) => n.k === k); }

  /** Cheer / laugh / clap particles over a person. */
  private reactFx(p: Person, t: number, cam: THREE.Camera) {
    const fx = this.fx!;
    void cam;
    for (const c of this.cheers) {
      const a = t - c.at;
      if (c.k === p.k && a >= 0 && a < 2.2) {
        // a confetti pop over the supporter
        for (let j = 0; j < 14; j++) {
          const sd = p.seed ^ c.seed;
          const ang = h01(sd, j * 3) * Math.PI * 2, sp = 0.4 + h01(sd, j * 3 + 1) * 0.6, up = 1.6 + h01(sd, j * 3 + 2) * 1.2;
          tv3.set(p.head.x + Math.cos(ang) * sp * a, p.head.y + 0.15 + up * a - 2.6 * a * a, p.head.z + Math.sin(ang) * sp * a);
          fx.bill('confetti', tv3, 0.07, CONFETTI[j % CONFETTI.length], clamp01(2.2 - a), t * 6 + j);
        }
        if (a < 1.2) fx.bill('glow', tv3.copy(p.head).setY(p.head.y + 0.1), 0.9 * (1 - a / 1.2), '#ffe28a', 0.8);
      }
    }
    const la = t - p.laughAt;
    if (la >= 0 && la < 1.8) fx.bill('ha', tv3.set(p.head.x + 0.18 * Math.sin(p.seed), p.head.y + 0.12 + la * 0.25, p.head.z), 0.17, '#ffe066', clamp01(1.8 - la) * clamp01(la / 0.15), 0.25 * Math.sin(la * 9));
  }
  /** Room-wide confetti for the biggest cheers. */
  private crowdFx(t: number) {
    const fx = this.fx!, room = this.room!;
    if (!room.seats.length && room.mode === 'seats') return;
    for (const c of this.cheers) {
      const a = t - c.at;
      if (c.big < 3 || a < 0 || a > 4.5) continue;
      const seats = room.mode === 'seats' ? room.seats : [];
      const n = Math.min(160, Math.max(40, seats.length));
      const al = clamp01((4.5 - a) / 0.8);
      for (let j = 0; j < n; j++) {
        const sd = c.seed + j * 5;
        const s = seats.length ? seats[Math.floor(h01(sd, 0) * seats.length)] : null;
        if (!s) break;
        const fall = ((a * 0.55 + h01(sd, 1)) % 1);
        tv3.set(s.x + (h01(sd, 2) - 0.5) * 1.2 + 0.2 * Math.sin(t * 2 + j), s.y + 3.2 - fall * 3.0, s.z + (h01(sd, 3) - 0.5) * 1.2);
        fx.bill('confetti', tv3, 0.08, CONFETTI[j % CONFETTI.length], al, t * (2 + h01(sd, 4) * 3) + j);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ names
  private depthOf(v: THREE.Vector3, cam: THREE.Camera) {
    const w = this.group.localToWorld(tv3.copy(v));
    return Math.max(0.05, -w.applyMatrix4(cam.matrixWorldInverse).z);
  }

  /** Performer faces on screen (the same boxes the crowd uses): names, cards and bodies keep off them. */
  private faces(cam: THREE.PerspectiveCamera) {
    const rt = this.rt!;
    this.faceRects.length = 0;
    cam.updateMatrixWorld();
    const camPos = cam.getWorldPosition(tcam);
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (const a of rt.actors.values()) {
      if (!a.shown || !a.spot) continue;
      const f = a.faceAt(a.spot);
      if (!f) continue;
      tv.copy(f.center).project(cam);
      if (tv.z > 1) continue;
      const x = (tv.x + 1) / 2, y = (1 - tv.y) / 2;
      const dist = camPos.distanceTo(f.center);
      const r = (f.size * 1.5) / (dist * tanH) / 2;
      this.faceRects.push({ x0: x - r / cam.aspect, x1: x + r / cam.aspect, y0: y - r * 1.2, y1: y + r * 1.35, d: dist });
    }
  }

  /** 5 Hz: which names show (no overlaps when decluttering; never over a face), which bodies hide (over a face, nearer
   *  the lens than the performer). */
  private declutter(cam: THREE.PerspectiveCamera, viewH: number, cardQs: Map<string, QuestionView>) {
    const names = this.names!, look = this.view.look;
    const vw = this.rt!.stage.renderer.domElement.width || 1920;
    const t = this.now() / 1000;
    const camPos = cam.getWorldPosition(tcam);
    const prio = (p: Person) => (cardQs.get(p.k)?.status === 'answering' ? 1e6 : cardQs.has(p.k) ? 1e5 : 0) + (t - p.msgAt < 8 ? 1e4 : 0) + tierRank(p.tier ?? this.view.tiers[p.k]) * 100 - p.slot * 0.01;
    const list = this.order.filter((p) => p.leftAt <= 0);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const sorted = [...list].sort((a, b) => prio(b) - prio(a));
    const tagH = 0.12 * look.names.size;
    for (const p of sorted) {
      const w = this.group.localToWorld(tv.copy(p.head).setY(p.head.y + 0.06));
      const d = Math.max(0.05, -tv2.copy(w).applyMatrix4(cam.matrixWorldInverse).z);
      tv2.copy(w).project(cam);
      if (tv2.z > 1 || Math.abs(tv2.x) > 1.2 || Math.abs(tv2.y) > 1.2) { p.nt = 0; continue; }
      const sx = (tv2.x + 1) / 2, sy = (1 - tv2.y) / 2;
      p.sx = sx; p.sy = sy; p.depth = d;
      const hPx = names.pxHeight(tagH, d, cam.projectionMatrix.elements[5]);
      const wPx = hPx * names.aspectOf(p.tag, p.tkey);
      const rect = { x0: sx - wPx / 2 / vw, x1: sx + wPx / 2 / vw, y0: sy - hPx / viewH, y1: sy };
      // never over a performer's face
      const overFace = this.faceRects.some((f) => !(rect.x1 < f.x0 || rect.x0 > f.x1 || rect.y1 < f.y0 || rect.y0 > f.y1));
      let ok = !overFace;
      if (ok && look.names.declutter && prio(p) < 1e5) {
        const m = 0.15 * hPx / viewH;
        ok = !placed.some((r) => !(rect.x1 < r.x0 + m || rect.x0 > r.x1 - m || rect.y1 < r.y0 + m || rect.y0 > r.y1 - m));
      }
      if (ok) placed.push(rect);
      p.nt = ok ? 1 : 0;
      // the body over a face, nearer the lens than that performer → hidden for ≥ 1 s
      if (this.room?.mode === 'seats' && this.faceRects.length) {
        const feet = this.group.localToWorld(tv3.set(p.pose.x, p.pose.y, p.pose.z));
        const dn = camPos.distanceTo(feet);
        tv3.project(cam);
        const bx = (tv3.x + 1) / 2, by = (1 - tv3.y) / 2;
        const bw = 0.5 * 0.55 / (Math.max(0.3, dn) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / cam.aspect;
        const body = { x0: Math.min(bx, sx) - bw, x1: Math.max(bx, sx) + bw, y0: sy, y1: by };
        if (this.faceRects.some((f) => dn < f.d - 0.3 && !(body.x1 < f.x0 || body.x0 > f.x1 || body.y1 < f.y0 || body.y0 > f.y1))) p.hideUntil = t + 1;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ crowd mode
  /** Root-space head points of the crowd's dancers, ordered like seats (front / centre first). */
  private crowdPts: { head: THREE.Vector3; visible: boolean }[] = [];
  private crowdOrder: { m: number; i: number }[] | null = null;
  private crowdPoints(): { head: THREE.Vector3; visible: boolean }[] {
    const c = this.crowd;
    if (!c || !this.view.look.crowdNames) return [];
    const mass = c.mass.filter((m) => m.ready);
    if (!mass.length) return [];
    if (!this.crowdOrder || this.crowdOrder.length !== mass.reduce((a, m) => a + m.dancers.length, 0)) {
      const f = this.room!.focus;
      const all: { m: number; i: number; d: number; lat: number }[] = [];
      mass.forEach((m, mi) => m.dancers.forEach((d, i) => all.push({ m: mi, i, d: Math.hypot(d.home.x - f.x, d.home.z - f.z), lat: d.home.x - f.x })));
      all.sort((a, b) => Math.round(a.d / 0.9) - Math.round(b.d / 0.9) || Math.abs(a.lat) - Math.abs(b.lat) || a.lat - b.lat);
      this.crowdOrder = all.map(({ m, i }) => ({ m, i }));
      this.crowdPts = this.crowdOrder.map(() => ({ head: new THREE.Vector3(), visible: false }));
    }
    this.crowdOrder.forEach((o, k) => {
      const m = mass[o.m], d = m?.dancers[o.i];
      const pt = this.crowdPts[k];
      if (!d) { pt.visible = false; return; }
      m.headTop(d, pt.head); pt.head.y += 0.08;
      pt.visible = !d.hidden && !d.shield;
    });
    return this.crowdPts;
  }

  // ------------------------------------------------------------------------------------------ camera
  /** When an answered question's linger ends, on this page's clock (seconds). */
  private lingerEnd(q: QuestionView): number { return q.since / 1000 + this.skew + AskQueue.LINGER_MS / 1000; }

  /** The audience's own short asker close-up ("answer now", setting ask.askerCut). */
  private cameraShot(aspect: number): { key: string; pose: CamPose; secs: number } | null {
    const r = this.request();
    if (!r || r.kind !== 'asker' || !this.view.look.ask.askerCut || !this.rt) return null;
    const pose = this.shotPose('asker', aspect);
    return pose ? { key: `audience:asker:${this.answering?.id}`, pose, secs: 0.9 } : null;
  }
  private rays: RoomRays | null = null;
  private askerCache: { k: string; aspect: number; head: THREE.Vector3; pose: CamPose | null } | null = null;
  /** The room's surfaces for the asker's close-up (count-bounded: a few dozen rays once per question). */
  private viewRays(): RoomRays | null {
    const rt = this.rt;
    if (!rt) return null;
    if (!this.rays) { this.rays = new RoomRays(rt.room); this.rays.skipMovers = true; }
    return this.rays;
  }
  request(): AudienceShotRequest | null {
    if (!this.room || !this.rt) return null;
    const t = this.now() / 1000;
    if (this.answering) {
      const p = this.persons.get(this.answering.k);
      const seatOk = p && (this.room.mode === 'crowd' ? !!this.crowdPts[p.slot]?.visible : !!this.room.seats[p.slot]);
      if (seatOk && t - this.answering.since < this.askerSecs) return { kind: 'asker', key: this.answering.k, since: this.answering.since, until: this.answering.since + this.askerSecs, priority: 2 };
    }
    for (let i = this.cheers.length - 1; i >= 0; i--) {
      const c = this.cheers[i];
      if (c.big >= 2 && t >= c.at && t - c.at < 3.5) return { kind: 'reaction', since: c.at, until: c.at + 3.5, priority: c.big };
    }
    const ap = this.view.applause.at / 1000;
    if (ap && t >= ap && t - ap < 3) return { kind: 'reaction', since: ap, until: ap + 3, priority: 1 };
    return null;
  }
  shotPose(kind: AudienceShotKind, aspect: number): CamPose | null {
    const rt = this.rt, room = this.room;
    if (!rt || !room) return null;
    const toWorld = (v: THREE.Vector3) => this.group.localToWorld(v.clone());
    const stage = toWorld(room.focus.clone().setY(room.focus.y + 1.2));
    if (kind === 'asker') {
      const p = this.answering ? this.persons.get(this.answering.k) : null;
      if (!p) return null;
      // (a prop between the lens and the asker - a pedestal, a railing - hides more than a tenth of them: another stand, else none; solved
      // once per asker, not per frame)
      const head = toWorld(p.head), c = this.askerCache;
      if (c && c.k === this.answering!.k && Math.abs(c.aspect - aspect) < 0.01 && c.head.distanceTo(head) < 0.15) return c.pose;
      const pose = askerPoseClear(head, stage, aspect, this.viewRays());
      this.askerCache = { k: this.answering!.k, aspect, head, pose };
      return pose;
    }
    const preset = rt.room.cameras.get(room.camera);
    if (preset) return { position: preset.position.clone(), quaternion: preset.quaternion.clone(), fov: preset.fov };
    const pts = room.mode === 'seats' ? this.order.filter((p) => room.seats[p.slot]).map((p) => toWorld(new THREE.Vector3(room.seats[p.slot].x, room.seats[p.slot].y, room.seats[p.slot].z))) : this.crowdPts.filter((c) => c.visible).map((c) => toWorld(c.head));
    return audienceWidePose(stage, pts.length ? pts : room.seats.slice(0, 40).map((s) => toWorld(new THREE.Vector3(s.x, s.y, s.z))), aspect);
  }

  // ------------------------------------------------------------------------------------------ status
  info() {
    const room = this.room;
    return {
      room: room ? { mode: room.mode, seats: room.seats.length, camera: room.camera } : null,
      on: this.view.on, members: this.view.members.length, shown: this.order.filter((p) => p.leftAt <= 0 && (room?.mode === 'crowd' ? !!this.crowdPts[p.slot]?.visible : !!room?.seats[p.slot])).length,
      names: this.order.filter((p) => p.na > 0.5).length, questions: this.view.questions.map((q) => ({ id: q.id, k: q.k, status: q.status })),
      answering: this.answering, request: this.request(), cheers: this.cheers.slice(-3).map((c) => ({ in: +(c.at - this.now() / 1000).toFixed(1), k: c.k, usd: c.usd, big: c.big })),
      draws: (this.bodies?.drawCalls() ?? 0) + 1 + 4, ms: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(3),
    };
  }
}

function shirtOf(c: string, seed: number): THREE.Color {
  const col = new THREE.Color(/^#[0-9a-f]{6}$/i.test(c) ? c : SHIRTS[seed % SHIRTS.length]);
  // chat colours can be neon: keep the hue, calm the saturation a little so the room's lighting reads
  const hsl = { h: 0, s: 0, l: 0 }; col.getHSL(hsl);
  col.setHSL(hsl.h, Math.min(0.75, hsl.s), Math.min(0.62, Math.max(0.28, hsl.l)));
  return col;
}
