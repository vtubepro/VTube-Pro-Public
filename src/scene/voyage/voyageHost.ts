// Voyage host controller (SPEC 2.8, D10): the HOST studio turns support events, buttons, the bus and the fork votes into
// stamps in its bag SceneState.modes.voyage - every page (late ones too) plays the same stamps; no page ever computes
// support from its own chat feed. Observer studios and party guests never stamp (their controller never sends state).
//   installVoyageHost(controller, bus)   once, from SceneController's constructor
//   voyageStampNow / voyageAnchor / voyageNew / voyagePacing / voyageCommand   the Scene tab, Stream Deck, bus
// Every write goes through shared/voyage.ts (voyageCompact folds finished holds into heldMs, prunes stamps that show
// nothing any more), so nothing a page shows ever jumps when the host writes.
// Fork votes: in the last 120 s of a chapter the host starts a chat poll (never over a poll that is already live, never
// read aloud) that closes FORK_CLOSE s before the boundary, and stamps the winner while at least FORK_FINAL s of the
// chapter remain (re-checked when the result arrives); no votes / a tie / too late = the seeded pick (nothing stamped).
import type { Bus } from '../../bus.ts';
import { sanitizeChatEvent } from '../../../shared/chat.ts';
import { raidDonationValue } from '../../../shared/raid.ts';
import {
  FLAVOUR_LABEL, FORK_CLOSE, FORK_FINAL, STAMP_LABEL, STAMP_LEAD, SUPPORT_MAX_WAIT, TIER_OFFSET, VOYAGE_BAG, VOYAGE_EPOCH0, isStampKind, sanitizeVoyage, voyageAnchorBag,
  voyageBagFrom, voyageCompact, voyageHash, voyageNow, voyageRewardKind, voyageSetPacing, voyageStamp, voyageTierLines, voyageTiers,
  type RoomVoyageConfig, type StampKind, type VoyageBag, type VoyagePacing, type VoyageStamp, VOYAGE_PACINGS,
} from '../../../shared/voyage.ts';

/** What the host logic needs from the SceneController (structural: no import cycle). */
export interface VoyageCtl {
  readonly observer: boolean;
  readonly canEdit: boolean;
  readonly effective: { sceneId: string | null };
  readonly scenes: readonly { id: string }[];
  modeBag(id: string): unknown;
  setModeBag(id: string, v: unknown): void;
}

/** the current room's scene.json `voyage` (null = not a voyage room) */
export function voyageRoomCfg(S: VoyageCtl): RoomVoyageConfig | null {
  const id = S.effective.sceneId;
  if (!id) return null;
  const base = id.split('~')[0];
  const info = S.scenes.find((x) => x.id === id) ?? S.scenes.find((x) => x.id === base);
  const v = (info as unknown as { voyage?: RoomVoyageConfig } | undefined)?.voyage;
  return v && typeof v === 'object' ? v : null;
}
/** The bag as every page reads it (the room's seed / pacing where the host never wrote one: voyageScene uses the same). */
export const voyageBagOf = (S: VoyageCtl): VoyageBag => voyageBagFrom(S.modeBag(VOYAGE_BAG), voyageRoomCfg(S), S.effective.sceneId ?? '');
/** Host write: tidy (fold finished holds, prune spent stamps), edit, sanitize. */
export function voyageSetBag(S: VoyageCtl, fn: (b: VoyageBag) => VoyageBag | void) {
  const b = voyageCompact(structuredClone(voyageBagOf(S)), Date.now());
  const r = fn(b);
  S.setModeBag(VOYAGE_BAG, sanitizeVoyage(r ?? b));
}

/** Dropped stamps (host-local, for the Scene tab): newest first. */
export const voyageDrops: { k: StampKind; who: string; why: string; at: number }[] = [];
function noteDrop(k: StampKind, who: string, why: string) {
  voyageDrops.unshift({ k, who, why, at: Date.now() });
  voyageDrops.length = Math.min(voyageDrops.length, 6);
}

/** Stamp (host only): queue rules in shared/voyage.ts voyageStamp. `delayMs` = a tier's offset. Returns '' or why not. */
export function voyageStampWhy(S: VoyageCtl, k: StampKind, who = '', delayMs = 0): string {
  if (!S.canEdit || S.observer) return 'only the host steers the ship';
  const cfg = voyageRoomCfg(S);
  if (!cfg) return 'not a walking-ship room';
  const why: { reason?: string; dropped?: VoyageStamp[] } = {};
  const r = voyageStamp(voyageBagOf(S), cfg, k, Date.now(), who || undefined, undefined, undefined, why, undefined, delayMs);
  if (!r) { noteDrop(k, who, why.reason ?? 'dropped'); return why.reason ?? 'dropped'; }
  for (const d of why.dropped ?? []) noteDrop(d.k, d.who ?? '', 'no clear moment after the stop moved the timeline');
  S.setModeBag(VOYAGE_BAG, r.bag);
  return '';
}
export function voyageStampNow(S: VoyageCtl, k: StampKind, who = '', delayMs = 0): boolean { return voyageStampWhy(S, k, who, delayMs) === ''; }
/** Several stamps from one event in one bag write (each queued in turn). */
function stampMany(S: VoyageCtl, list: { k: StampKind; delay: number }[], who: string) {
  const cfg = voyageRoomCfg(S);
  if (!cfg || !list.length) return 0;
  let bag = voyageBagOf(S), n = 0;
  const now = Date.now();
  for (const x of list) {
    const why: { reason?: string; dropped?: VoyageStamp[] } = {};
    // the real clock tidies the bag (a delayed tier must not prune stamps still on air); the delay only sets the start
    const r = voyageStamp(bag, cfg, x.k, now, who || undefined, undefined, undefined, why, SUPPORT_MAX_WAIT, x.delay);
    if (r) { bag = r.bag; n++; } else if (why.reason && !/merged/.test(why.reason)) noteDrop(x.k, who, why.reason);
    for (const d of why.dropped ?? []) noteDrop(d.k, d.who ?? '', 'no clear moment after the stop moved the timeline');
  }
  if (n) S.setModeBag(VOYAGE_BAG, bag);
  return n;
}

/** Anchor (true) / weigh anchor (false). An anchor pressed mid-battle / mid-stop waits for it to end; weighing anchor
 *  waits for a treasure stop that stands on the anchor. */
export function voyageAnchor(S: VoyageCtl, on: boolean) {
  if (!S.canEdit) return;
  const cfg = voyageRoomCfg(S);
  const lost: VoyageStamp[] = [];
  voyageSetBag(S, (b) => voyageAnchorBag(b, cfg, on, Date.now(), lost));
  for (const d of lost) noteDrop(d.k, d.who ?? '', on ? 'no clear moment after the anchor' : 'no clear moment after weighing anchor');
}

/** Pacing: takes effect at the next chapter boundary (no jump of the world or the sun). */
export function voyagePacing(S: VoyageCtl, p: VoyagePacing) {
  if (!S.canEdit || !(VOYAGE_PACINGS as readonly unknown[]).includes(p)) return;
  const cfg = voyageRoomCfg(S);
  voyageSetBag(S, (b) => voyageSetPacing(b, cfg, p, Date.now()));
}

/** A fresh voyage (new seed, chapter 1 starts now) + the 'newVoyage' banner stamp. */
export function voyageNew(S: VoyageCtl) {
  if (!S.canEdit) return;
  const now = Date.now();
  voyageSetBag(S, (b) => {
    b.seed = (((now * 2654435761) >>> 0) % 99999) + 1; b.epoch = now + STAMP_LEAD; b.heldMs = 0; b.holds = []; b.forks = []; b.pace = []; b.fx = [];
    b.stamps = [{ id: (voyageHash('new', now) % 2147483646) + 1, at: now + STAMP_LEAD, k: 'newVoyage' }];
  });
}

/** Bus / Stream Deck: {command:'voyage', args:{event?, user?, anchor?, newVoyage?, on?, cutaways? (= talkCuts: Talk may cut away), extCams?, votes?, pacing?, sway?, env?}} */
export function voyageCommand(S: VoyageCtl, a: Record<string, unknown>) {
  if (!S.canEdit) return;
  const flags = ['on', 'extCams', 'votes'] as const;
  const cuts = typeof a.talkCuts === 'boolean' ? a.talkCuts : typeof a.cutaways === 'boolean' ? a.cutaways : null;
  if (flags.some((k) => typeof a[k] === 'boolean') || cuts !== null || typeof a.sway === 'number' || a.env === 'journey' || a.env === 'state' || a.env === 'fixed') voyageSetBag(S, (b) => {
    for (const k of flags) if (typeof a[k] === 'boolean') b[k] = a[k] as boolean;
    if (cuts !== null) b.talkCuts = cuts;
    if (typeof a.sway === 'number') b.sway = Math.max(0, Math.min(1.5, a.sway));
    if (a.env === 'journey' || a.env === 'state' || a.env === 'fixed') b.env = a.env;
  });
  if ((VOYAGE_PACINGS as readonly unknown[]).includes(a.pacing)) voyagePacing(S, a.pacing as VoyagePacing);
  if (typeof a.anchor === 'boolean') voyageAnchor(S, a.anchor);
  if (a.newVoyage === true) voyageNew(S);
  if (isStampKind(a.event)) voyageStampNow(S, a.event, typeof a.user === 'string' ? a.user.slice(0, 32) : '');
}

// ------------------------------------------------------------------------------------------------ support -> stamps
const seen = new Set<string>();
/** Chat feed (this PC's server, host / solo): finance events + Kick rewards -> stamps. */
export function voyageSupport(S: VoyageCtl, evs: unknown[]) {
  if (S.observer || !S.canEdit) return;
  const cfg = voyageRoomCfg(S);
  if (!cfg) return;
  const bag = voyageBagOf(S);
  if (!bag.on || !bag.support.on) return;
  const tiers = voyageTierLines(bag, cfg);
  for (const raw of evs.slice(0, 50)) {
    const e = sanitizeChatEvent(raw);
    if (!e || seen.has(e.id)) continue;
    const x = e as unknown as { kind: string; fkind?: string; ev?: string; text?: string; label?: string; platform?: string; user?: string };
    let kinds: StampKind[] = [];
    if (x.kind === 'system' && (x.ev === 'reward' || /^redeemed\b/i.test(x.text ?? '')) && (x.platform === 'kick' || x.platform === 'test')) {
      kinds = [voyageRewardKind((x.label || (x.text ?? '').replace(/^redeemed\s*/i, '')).slice(0, 60), cfg.rewards)];
    } else if (x.kind === 'finance') {
      if (x.fkind === 'raid' && !bag.support.raids) continue;
      kinds = voyageTiers(raidDonationValue(e as never), tiers, x.fkind ?? '');
    } else continue;
    seen.add(e.id);
    if (seen.size > 500) { const keep = [...seen].slice(-200); seen.clear(); for (const k of keep) seen.add(k); }
    stampMany(S, kinds.map((k) => ({ k, delay: TIER_OFFSET[k] ?? 0 })), String(x.user ?? '').slice(0, 32));
  }
}

// ------------------------------------------------------------------------------------------------ fork votes + upkeep
/** chapter key (seed:chapter) -> the poll we started ('' = asked / failed / done) and when it closes (wall ms) */
const started = new Map<string, { id: string; endsAt: number }>();
let lastUpkeep = 0;
export function voyageHostTick(S: VoyageCtl) {
  if (!S.canEdit || S.observer) return;
  const cfg = voyageRoomCfg(S);
  if (!cfg) return;
  const now = Date.now();
  const raw = S.modeBag(VOYAGE_BAG) as { epoch?: unknown; seed?: unknown; pacing?: unknown } | undefined;
  // materialise the room defaults once (an explicit epoch shifts onto party guests' clocks; nothing on air changes)
  if (!raw || typeof raw.epoch !== 'number' || !(raw.epoch > 0) || typeof raw.seed !== 'number' || typeof raw.pacing !== 'string') {
    voyageSetBag(S, (b) => { if (!(b.epoch > 0)) b.epoch = VOYAGE_EPOCH0; });
    return;
  }
  const bag = voyageBagOf(S);
  // upkeep every ~30 s: fold finished holds, prune spent stamps (only writes when something changed)
  if (now - lastUpkeep > 30000) {
    lastUpkeep = now;
    const c = voyageCompact(bag, now);
    if (c.holds.length !== bag.holds.length || c.stamps.length !== bag.stamps.length || c.fx.length !== bag.fx.length) { S.setModeBag(VOYAGE_BAG, sanitizeVoyage(c)); return; }
  }
  if (!bag.on || !bag.votes) return;
  const st = voyageNow(bag, cfg, now);
  if (bag.forks.some((f) => f.ch === st.leg)) return;
  const remain = st.chap.C - st.tLeg;                   // voyage s to the chapter boundary
  const key = `${bag.seed}:${st.leg}`;
  const pair = st.fork.pair;
  if (st.fork.open && !started.has(key) && remain >= FORK_CLOSE + 25) {
    const durationSec = Math.max(20, Math.min(100, Math.floor(remain - FORK_CLOSE)));
    started.set(key, { id: '', endsAt: 0 });
    void fetch('/api/poll/state').then((r) => r.json()).then((s: { poll?: { state?: string } | null }) => {
      if (s.poll?.state === 'live') return;                       // never over the host's own poll
      return fetch('/api/poll/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        question: 'Where does the ship walk next?', options: pair.map((f) => ({ label: FLAVOUR_LABEL[f] })),
        durationSec, subDouble: true, donationVotes: false, announce: false,
      }) }).then((r) => r.json()).then((j: { poll?: { id?: string } | null }) => { started.set(key, { id: j.poll?.id ?? '', endsAt: Date.now() + durationSec * 1000 + 1500 }); });
    }).catch(() => {});
  }
  // the poll has closed: stamp the winner while the chapter still has >= FORK_FINAL s (re-checked on arrival; a tie / no
  // votes / too late = the seeded pick: nothing stamped)
  const p = started.get(key);
  if (p?.id && now >= p.endsAt && remain >= FORK_FINAL + 1) {
    const id = p.id;
    started.set(key, { id: '', endsAt: 0 });
    void fetch('/api/poll/state').then((r) => r.json()).then((s: { poll?: { id?: string; winner?: number[] } | null }) => {
      const w = s.poll && s.poll.id === id ? s.poll.winner ?? [] : [];
      if (w.length !== 1 || (w[0] !== 0 && w[0] !== 1)) return;
      voyageSetBag(S, (b) => {
        const t = Date.now(), s2 = voyageNow(b, voyageRoomCfg(S), t);
        if (s2.leg !== st.leg || s2.chap.C - s2.tLeg < FORK_FINAL + 0.5 || b.forks.some((f) => f.ch === st.leg)) return;   // too late: the seeded pick stands
        b.forks.push({ ch: st.leg, choice: w[0] as 0 | 1, v: Math.floor(s2.V * 10) / 10 });
      });
    }).catch(() => {});
  }
  if (started.size > 20) started.delete(started.keys().next().value as string);
}

/** A drop note for the Scene tab ('' = none in the last 2 minutes). */
export function voyageDropNote(): string {
  const d = voyageDrops[0];
  if (!d || Date.now() - d.at > 120000) return '';
  return `${STAMP_LABEL[d.k]}${d.who ? ` for ${d.who}` : ''} did not play: ${d.why}`;
}

let installed = false;
/** Once, from SceneController's constructor: the chat feed -> stamps, and the fork vote / upkeep tick. */
export function installVoyageHost(S: VoyageCtl, bus: Bus) {
  if (installed) return;
  installed = true;
  bus.on((m) => { const x = m as { type?: string; origin?: string; snap?: boolean; evs?: unknown }; if (x.type === 'chat' && x.origin !== 'party' && !x.snap) voyageSupport(S, Array.isArray(x.evs) ? x.evs : []); });
  setInterval(() => { try { voyageHostTick(S); } catch { /* next tick */ } }, 2000);
}
