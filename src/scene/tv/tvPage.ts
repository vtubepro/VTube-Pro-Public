// OBS page glue for TV performers (src/output.ts calls this with a few one-line hooks): which slots are TV / projector
// guests (from the studio's {type:'party'} message — members' `tv` + `tvSelf` for this PC's own performer, and the
// host's overrides in SceneState.modes[TV_BAG]), their feeds (tvFeeds.ts), loading a TvRuntime (walking TV) or a
// ProjectorRuntime (pull-down screen) into a slot, the projector spots + the Talk camera's cut to a speaking projector
// guest (SceneRuntime hooks, projectorPlace.ts), and the key → feed map behind the public API (tvApi.ts).
import type * as THREE from 'three';
import type { AvatarRuntime } from '../../avatar/AvatarRuntime.ts';
import type { BusMessage, PartyMember } from '../../../shared/types.ts';
import { TV_BAG, effectiveLook, effectiveMotion, sanitizeTvBag, sanitizeTvInfo, type TvBag, type TvInfo, type TvLook } from '../../../shared/tv.ts';
import { INTERVIEW_MODE, sanitizeInterview } from '../../../shared/talkshow.ts';
import type { SceneActor } from '../actor.ts';
import type { SpotInfo } from '../contract.ts';
import { SceneRuntime } from '../SceneRuntime.ts';
import { pageFeeds } from './tvFeeds.ts';
import { TvRuntime } from './tvRuntime.ts';
import { ProjectorRuntime } from './tvProjector.ts';
import { StandeeRuntime } from './tvStandee.ts';
import { projectorPlan } from './projectorPlace.ts';

export interface TvSlotInfo { slot: string; feedId: string; tv: TvInfo; name: string }
/** The avatar id a TV slot loads under (Slot.load's id; never a library id). */
export const TV_SELF = 'tv-self';

type AnyTvRuntime = TvRuntime | ProjectorRuntime | StandeeRuntime;
const infos = new Map<string, TvSlotInfo>();
const runtimes = new Map<string, AnyTvRuntime>();       // slot id → its runtime
let keyOfSlot: (slotId: string) => string | null = () => null;
let sceneOf: () => SceneRuntime | null = () => null;
let reload: (slotId: string) => void = () => {};
let checkT = 0;

const bagOf = (rt: SceneRuntime | null): TvBag => sanitizeTvBag(rt?.state.modes?.[TV_BAG]);
function lookOf(slot: string, i: TvSlotInfo): TvLook {
  const key = keyOfSlot(slot);
  return effectiveLook(i.tv, bagOf(sceneOf()), key ?? '');
}

export const tvPage = {
  feeds: pageFeeds,
  /** The avatar the self slot showed before it became a TV (restored when it stops being one). */
  selfPrev: '' as string,

  /** OBS pages: receive this PC's feeds over the loopback link. */
  start(send: (m: Extract<BusMessage, { type: 'tvfeed' }>) => void, listen: (h: (m: BusMessage) => void) => () => void) { pageFeeds.start(send, listen); },
  /** Resolve a slot id to its scene member key (the page's keyOf). */
  setKeyOf(fn: (slotId: string) => string | null) { keyOfSlot = fn; },
  /** The page's current room + how to reload a slot (a guest switched TV ↔ projector, or the host did). */
  setHooks(h: { scene: () => SceneRuntime | null; reload: (slotId: string) => void }) {
    sceneOf = h.scene; reload = h.reload;
    if (!checkT) checkT = window.setInterval(() => tvPage.check(), 400);
  },

  /** A {type:'party'} message: returns the slot ids that must (re)load (became / stopped being a TV, new skin / height / look). */
  update(members: PartyMember[], tvSelf: (TvInfo & { id?: string; name?: string }) | null | undefined): Set<string> {
    const changed = new Set<string>();
    const next = new Map<string, TvSlotInfo>();
    for (const m of members) {
      const tv = sanitizeTvInfo(m.tv);
      if (tv) next.set(m.id, { slot: m.id, feedId: m.id, tv, name: String(m.name ?? 'Guest').slice(0, 40) });
    }
    const st = sanitizeTvInfo(tvSelf);
    if (st && typeof tvSelf?.id === 'string') next.set('self', { slot: 'self', feedId: tvSelf.id, tv: st, name: typeof tvSelf.name === 'string' ? tvSelf.name.slice(0, 40) : '' });
    for (const [id, n] of next) {
      const o = infos.get(id);
      if (!o || o.tv.skin !== n.tv.skin || o.tv.height !== n.tv.height || o.feedId !== n.feedId || (o.tv.look ?? 'tv') !== (n.tv.look ?? 'tv') || (n.tv.look !== 'standee' && Math.abs(o.tv.aspect - n.tv.aspect) > 0.05)) changed.add(id);
      else {
        if (JSON.stringify(o.tv) !== JSON.stringify(n.tv)) runtimes.get(id)?.setInfo(n.tv);
        if (o.name !== n.name && n.name) runtimes.get(id)?.setName(n.name);
      }
    }
    for (const id of infos.keys()) if (!next.has(id)) changed.add(id);
    infos.clear();
    for (const [k, v] of next) infos.set(k, v);
    return changed;
  },

  /** Periodic: the host's overrides (look / motion) changed → reload / retune the slots. */
  check() {
    const bag = bagOf(sceneOf());
    for (const [slot, i] of infos) {
      const rt = runtimes.get(slot);
      if (!rt) continue;
      if (rt.look !== lookOf(slot, i)) { runtimes.delete(slot); reload(slot); continue; }
      rt.motion = effectiveMotion(i.tv, bag);
    }
  },

  infoFor(slotId: string): TvSlotInfo | null { return infos.get(slotId) ?? null; },
  get selfTv(): boolean { return infos.has('self'); },

  /** Build the TV body / projector into `anchor` (Slot.load). Typed as AvatarRuntime: it implements what the scene uses. */
  async load(info: TvSlotInfo, anchor: THREE.Object3D, name: string, actorOf: () => SceneActor | null): Promise<AvatarRuntime> {
    const look = lookOf(info.slot, info);
    let rt: AnyTvRuntime;
    if (look === 'projector') {
      const p = new ProjectorRuntime(info.feedId, info.tv, anchor, pageFeeds, info.name || name);
      p.sceneOf = sceneOf;
      rt = p;
    } else if (look === 'standee') rt = new StandeeRuntime(info.feedId, info.tv, anchor, pageFeeds, info.name || name);
    else rt = await TvRuntime.load({ feedId: info.feedId, name: info.name || name, tv: info.tv, anchor, feeds: pageFeeds });
    rt.actorOf = actorOf;
    rt.motion = effectiveMotion(info.tv, bagOf(sceneOf()));
    runtimes.set(info.slot, rt);
    return rt as unknown as AvatarRuntime;
  },

  /** Scene member key → the TV / projector runtime (tvApi). */
  runtimeByKey(key: string): TvRuntime | null {
    for (const [slot, rt] of runtimes) if (keyOfSlot(slot) === key && infos.has(slot)) return rt as TvRuntime;
    return null;
  },
  feedIdByKey(key: string): string | null {
    for (const [slot, i] of infos) if (keyOfSlot(slot) === key) return i.feedId;
    return null;
  },
  forget(slotId: string) { runtimes.delete(slotId); },
  /** A TV build a newer load overtook was dropped (output.ts Slot, src/outputFollow.ts LatestLoads): point the slot back
   *  at the TV it shows (null = it shows none). */
  settle(slotId: string, shown: AvatarRuntime | null) { if (shown) runtimes.set(slotId, shown as unknown as AnyTvRuntime); else runtimes.delete(slotId); },
};

// ---------------------------------------------------------------- SceneRuntime hooks: projector spots + Talk cuts
SceneRuntime.spotHook = (rt) => {
  if (!infos.size) return null;
  const list: { key: string; aspect: number }[] = [];
  const hidden = new Set<string>();
  const iv = rt.state.mode === INTERVIEW_MODE ? sanitizeInterview(rt.state.modes?.[INTERVIEW_MODE]) : null;
  for (const [slot, i] of infos) {
    const key = keyOfSlot(slot);
    const r = runtimes.get(slot);
    if (!key || !rt.actors.has(key) || r?.look !== 'projector') continue;
    // Interview mode shows a listed projector guest on the show's monitor instead (src/scene/talkshow): screen stays up
    if (iv && iv.guests.some((g) => g.key === key)) { hidden.add(key); continue; }
    list.push({ key, aspect: i.tv.aspect });
  }
  if (!list.length && !hidden.size) return null;
  const out = new Map<string, SpotInfo | null>();
  for (const k of hidden) out.set(k, null);
  for (const s of list.length ? projectorPlan(rt, list) : []) out.set(s.key, s.spot);
  return out;
};

const cuts = new WeakMap<SceneRuntime, { cur: SceneActor | null; since: number; quiet: number; acc: Map<SceneActor, number>; t: number }>();
/** Talk camera: a projector guest who talks for ≥ 0.7 s gets the shot (held ≥ 3 s); 2.5 s of silence gives it back to
 *  the host's pick. Host setting TV_BAG.cut (default on). */
SceneRuntime.focusHook = (rt) => {
  const st = rt.state;
  if (!infos.size || st.mode !== 'talk' || st.camera !== 'talk' || !bagOf(rt).cut) { cuts.delete(rt); return null; }
  const now = performance.now() / 1000;
  let c = cuts.get(rt);
  if (!c) { c = { cur: null, since: 0, quiet: 0, acc: new Map(), t: now }; cuts.set(rt, c); }
  const dt = Math.min(0.2, now - c.t); c.t = now;
  let best: SceneActor | null = null, bestAcc = 0;
  for (const a of rt.actors.values()) {
    const r = a.runtime as unknown as { look?: string; speaking?: boolean } | null;
    if (r?.look !== 'projector' || !a.shown) { c.acc.delete(a); continue; }
    const acc = r.speaking ? (c.acc.get(a) ?? 0) + dt : 0;
    c.acc.set(a, acc);
    if (acc > bestAcc) { bestAcc = acc; best = a; }
  }
  if (c.cur) {
    const r = c.cur.runtime as unknown as { speaking?: boolean } | null;
    c.quiet = r?.speaking ? 0 : c.quiet + dt;
    const held = now - c.since;
    if (!rt.actors.has(c.cur.key) || !c.cur.shown || (c.quiet > 2.5 && held > 3)) c.cur = null;
    else if (best && best !== c.cur && bestAcc > 0.7 && c.quiet > 1 && held > 3) { c.cur = best; c.since = now; c.quiet = 0; }
  } else if (best && bestAcc > 0.7) { c.cur = best; c.since = now; c.quiet = 0; }
  return c.cur;
};

// test / debugging handle (read-only use; test pages inject fake feeds with vtpTv.feeds.inject(id, stream))
(window as unknown as { vtpTv: unknown }).vtpTv = tvPage;
