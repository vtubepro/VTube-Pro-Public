// Interview mode ("talk show", src/scene/talkshow/*): the host at a desk, guests on a big in-set MONITOR (or seated in
// the guest chairs), a sidekick for reaction shots, an automatic director that cuts on who is speaking, a show-open
// title card. Style inspiration: late-night cartoon talk shows — no names, logos, characters or music are copied.
//
// Pure data + sanitisers (no three.js), shared by the OBS pages, the studio and party guests. The host-owned settings
// live in the stage-mode bag `SceneState.modes.interview` (src/scene/stage — MODE_REGISTRY) and are re-validated here
// on every read: a guest's copy arrives over the network.
import { baseRoomId } from './roomId.ts';
import { sanitizeFaceBox } from './framing.ts';

export const INTERVIEW_MODE = 'interview';
/** Guests on the show (role guest): on the monitor (≤ MAX_PANELS panels) or in the studio chairs. */
export const MAX_GUESTS = 4;
/** Co-hosts: sit with the host at the desk (role cohost). */
export const MAX_COHOSTS = 2;
/** Picture panels on the show's monitor (1 = full, 2 = side by side, 3 = 2×2 with the show card). */
export const MAX_PANELS = 3;
/** The whole line-up (co-hosts + guests). */
export const MAX_LINEUP = MAX_GUESTS + MAX_COHOSTS;

/** Who a guest is:
 *  - `performer`: a party member (their live avatar) — on the monitor via a remote mini set, or seated in the room;
 *  - `video`: a plain video guest (webcam / Discord / a call window) — the host's shared window (in-scene, optional
 *    crop per guest), else an OBS passthrough hole on the monitor panel;
 *  - `tv`: a walking-TV performer (tvguests workstream): their own live feed on the monitor, or seated as a TV. */
export type GuestKind = 'performer' | 'video' | 'tv';
export interface InterviewGuest {
  kind: GuestKind;
  /** performer / tv: the member key ('@host' never; a party id or 'lib:<id>' stand-in in previews). */
  key?: string;
  /** Name on the panel's lower third (≤ 32 chars). */
  name: string;
  /** video: part of the shared window this guest is in (fractions x, y, w, h — e.g. one tile of a call grid). */
  crop?: [number, number, number, number];
  /** video: where the guest's face is in the shared window (fractions x, y, w, h; shared/framing.ts FaceBox), stamped by
   *  the host's face finder (smoothed, quantised): the monitor's cover crop keeps it inside the panel's safe area. */
  face?: [number, number, number, number];
  /** guestlink: where the HOST put this guest — 'studio' (seated in the room: avatar / walking TV) or 'monitor' (their
   *  picture on the show's screen: a TV's live feed, an avatar from its remote mini set). Missing = their own choice
   *  (a projector-screen TV → monitor, a walking TV → studio), else the layout below (the "set all" shortcut). */
  place?: GuestPlace;
  /** 'cohost' = sits with the host at the desk (performer / TV only; the local host is always the main host). Missing =
   *  a guest (old saved bags have no roles: everyone is a guest, exactly as before). */
  role?: 'cohost';
}
export type GuestPlace = 'studio' | 'monitor';
export type GuestRole = 'guest' | 'cohost';
export const roleOf = (g: Pick<InterviewGuest, 'role'>): GuestRole => (g.role === 'cohost' ? 'cohost' : 'guest');

/** Interview line-up ↔ the party (host, pure): a guest whose member left and came back (link guests get a NEW id on every
 *  join) is re-linked by name — else their camera never reaches the monitor, only a dead entry does; with `addNew`
 *  (Interview mode) a member not in the line-up joins it (a free slot, else the slot of someone who has left). Video
 *  guests are never touched. Returns a new array. */
export function syncInterviewLineup(guests: InterviewGuest[], members: { key: string; name: string; tv: boolean }[], addNew: boolean, cohostKeys?: ReadonlySet<string>): InterviewGuest[] {
  const out = guests.map((g) => ({ ...g }));
  const clean = (n: string) => n.replace(/ \(.*\)$/, '').trim().slice(0, 32);
  const here = new Set(members.map((m) => m.key));
  const lined = () => new Set(out.map((g) => g.key).filter(Boolean));
  for (const g of out) {
    if (g.kind === 'video' || !g.key || here.has(g.key)) continue;
    const taken = lined();
    const m = members.find((x) => !taken.has(x.key) && clean(x.name).toLowerCase() === g.name.trim().toLowerCase());
    if (m) { g.key = m.key; g.kind = m.tv ? 'tv' : 'performer'; }
  }
  if (!addNew) return out;
  // (a member who was a co-host before — the green room remembers — comes back as a co-host while there is room;
  // everyone else joins as a guest: a free guest slot, else the slot of a guest who has left — never a co-host's)
  const count = (r: GuestRole) => out.filter((x) => roleOf(x) === r).length;
  for (const m of members) {
    if (lined().has(m.key)) continue;
    const g: InterviewGuest = { kind: m.tv ? 'tv' : 'performer', key: m.key, name: clean(m.name) || 'Guest' };
    if (cohostKeys?.has(m.key) && count('cohost') < MAX_COHOSTS) { out.push({ ...g, role: 'cohost' }); continue; }
    if (count('guest') < MAX_GUESTS) out.push(g);
    else { const i = out.findIndex((x) => roleOf(x) === 'guest' && x.kind !== 'video' && !!x.key && !here.has(x.key)); if (i >= 0) out[i] = { ...g, ...(out[i].place ? { place: out[i].place } : {}) }; }
  }
  return out;
}

/** A performer / TV guest whose party member is gone (left, dropped) leaves the line-up — their monitor panel / seat is
 *  freed instead of showing a guest who isn't there. Video callers (no member) and preview stand-ins ('lib:') stay.
 *  Returns what was removed + where, so the host can put a returning member back in the same slot / place / role. */
export function pruneDeparted(guests: InterviewGuest[], here: ReadonlySet<string>): { guests: InterviewGuest[]; departed: { entry: InterviewGuest; index: number }[] } {
  const kept: InterviewGuest[] = [], departed: { entry: InterviewGuest; index: number }[] = [];
  guests.forEach((g, i) => { if (g.kind !== 'video' && !!g.key && !g.key.startsWith('lib:') && !here.has(g.key)) departed.push({ entry: { ...g }, index: i }); else kept.push({ ...g }); });
  return { guests: kept, departed };
}
/** Put a returning member back where they were (`index` clamped), with their new party key. */
export function restoreDeparted(guests: InterviewGuest[], entry: InterviewGuest, key: string, tv: boolean, index: number): InterviewGuest[] {
  const out = guests.filter((g) => g.key !== key).map((g) => ({ ...g }));
  out.splice(Math.max(0, Math.min(index, out.length)), 0, { ...entry, key, kind: entry.kind === 'video' ? entry.kind : tv ? 'tv' : 'performer' });
  return out;
}

/** Where guests appear. */
export type InterviewLayout = 'monitor' | 'seated';
export type DirectorMode = 'auto' | 'manual';
export type Pace = 'calm' | 'normal' | 'snappy';
/** Video guests: in-scene window when the host shares one ('auto'), always the window, or always the OBS hole. */
export type VideoSource = 'auto' | 'window' | 'hole';

/** Shot ids the director and the hotkeys use (+ `guest1`…`guest4` for one guest: their monitor panel / seat, and
 *  `cohost1` / `cohost2` for a co-host's single). `hosts` = the host + a co-host, `panel` = every host at the desk. */
export const SHOTS = ['establishing', 'host', 'guest', 'ots', 'two', 'sidekick', 'push', 'snap', 'reverse', 'wide', 'hosts', 'panel'] as const;
export type ShotId = (typeof SHOTS)[number] | 'guest1' | 'guest2' | 'guest3' | 'guest4' | 'cohost1' | 'cohost2';
export const SHOT_LABELS: Record<string, string> = {
  establishing: 'Establishing wide', host: 'Host single', guest: 'Guest on the monitor', ots: 'Over the shoulder (host → guest)',
  two: 'Two-shot', sidekick: 'Sidekick cutaway', push: 'Slow push-in (current subject)', snap: 'Snap zoom (current subject)',
  reverse: 'Reverse: the guest’s view of the host', wide: 'Room wide', guest1: 'Guest 1', guest2: 'Guest 2', guest3: 'Guest 3', guest4: 'Guest 4',
  cohost1: 'Co-host 1', cohost2: 'Co-host 2', hosts: 'Hosts: you + a co-host', panel: 'Panel: everyone at the desk',
};
export const isShotId = (v: unknown): v is ShotId => typeof v === 'string' && ((SHOTS as readonly string[]).includes(v) || /^guest[1-4]$/.test(v) || /^cohost[12]$/.test(v));

/** Three operator names are not shot ids: "house" (a wide on the house camera), "audience" (a wide on the audience) and "take" (the
 *  snap zoom on the host). ONE mapping, two users: shared/deck.ts planRun turns them into the bus command, and the studio's interview
 *  command handler (interviewCutOf) takes the raw names too,
 *  so the cut is the same either way. Not an alias: null. */
export const expandShotAlias = (s: unknown): { shot: 'wide' | 'snap'; cam?: string; aud?: 'w'; subject?: string } | null =>
  s === 'house' ? { shot: 'wide', cam: 'CAM_HOUSE' } : s === 'audience' ? { shot: 'wide', aud: 'w' } : s === 'take' ? { shot: 'snap', subject: 'host' } : null;

/** The cut a bus command `interview` {shot, cam?, aud?, subject?} asks for (the studio's handler: src/ui/stage/panels/interview.ts), or
 *  null when it names no shot. The aliases above are expanded first, so a new helper's `{shot:'wide', cam:'CAM_HOUSE'}` and an old
 *  helper's `{shot:'house'}` are the same cut (every page then shows the same shot: it goes through the bag). Junk fields are dropped. */
export function interviewCutOf(a: Record<string, unknown>): { shot: ShotId; extra: { cam?: string; aud?: 'r' | 'w' | 'a'; subject?: string } } | null {
  const al = expandShotAlias(a.shot);
  const b: Record<string, unknown> = al ? { ...a, ...al } : a;
  if (!isShotId(b.shot)) return null;
  return { shot: b.shot, extra: {
    ...(typeof b.cam === 'string' ? { cam: b.cam } : {}),
    ...(b.aud === 'r' || b.aud === 'w' || b.aud === 'a' ? { aud: b.aud } : {}),
    // ("The take": a snap zoom on the host, whoever is on air)
    ...(typeof b.subject === 'string' && /^(host|sidekick|gv|c[0-9]|g[0-9])$/.test(b.subject) ? { subject: b.subject } : {}),
  } };
}

export interface InterviewBag {
  layout: InterviewLayout;
  guests: InterviewGuest[];
  director: DirectorMode;
  /** Manual director: the shot on air. Auto: the last hotkey cut (held a few seconds, then auto again). */
  shot: ShotId;
  /** Bumps on every hotkey / button cut (every page takes the cut when it sees a new value — no clocks involved). */
  cutSeq: number;
  /** Who that cut is on ('host' | 'sidekick' | 'c0'… | 'g0'…), stamped by the host's studio when the shot has no subject
   *  of its own (a two-shot, a push-in): every page cuts to the same person, whatever it had on air. Missing = the shot's
   *  own default. */
  subject?: string;
  /** The last hotkey cut was a `wide` on a room camera / the audience ("House wide", "Audience": cue v3's cam / aud): every page cuts
   *  to the same one; a page whose room lacks it shows the room wide. */
  cam?: string;
  aud?: 'r' | 'w' | 'a';
  pace: Pace;
  /** Sprocket (or the chosen model) as the sidekick / bandleader at the side of the set. */
  sidekick: boolean;
  /** Sidekick model ('' = the chat buddy's model, else Sprocket). */
  sidekickModel: string;
  /** Show title (desk plate, monitor idle card, the show-open title card). */
  title: string;
  /** Show-open title card: bumps each time the host plays it. */
  bumperSeq: number;
  video: VideoSource;
  /** The studio measures the video guests' voices from an audio input and sends the levels to this PC's OBS pages. */
  meter: boolean;
  /** Reaction cutaways after punchlines / laughter (auto director). */
  reactions: boolean;
  /** Slow push-ins on long answers. */
  pushIns: boolean;
  /** Comedic snap zooms (rare, on big reactions). */
  snaps: boolean;
  /** Cuts to the chat audience: the crowd's laugh, a big cheer / raid / gift train, the asker of a chat question (default on).
   *  Optional: a helper that does not know the key drops it and the pages behave as before. */
  crowdCuts?: boolean;
  /** The room's own cameras: the house wide, the cutaways, the band camera (default on). */
  roomCams?: boolean;
  /** Seed for the director's choices (all pages choose alike from the same signals). */
  seed: number;
}

export const DEFAULT_INTERVIEW: InterviewBag = {
  layout: 'monitor', guests: [], director: 'auto', shot: 'establishing', cutSeq: 0, pace: 'normal', sidekick: true, sidekickModel: '',
  title: 'Late Night Live', bumperSeq: 0, video: 'auto', meter: false, reactions: true, pushIns: true, snaps: true, seed: 7,
};

const KEY = /^([a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
const AVATAR = /^[A-Za-z0-9_-]{0,48}$/;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const text = (v: unknown, max: number, d: string) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : d);

export function sanitizeGuest(o: unknown): InterviewGuest | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  const kind: GuestKind = x.kind === 'video' ? 'video' : x.kind === 'tv' ? 'tv' : 'performer';
  const key = typeof x.key === 'string' && KEY.test(x.key) ? x.key : undefined;
  if (kind !== 'video' && !key) return null;
  const g: InterviewGuest = { kind, name: text(x.name, 32, kind === 'video' ? 'Caller' : 'Guest') || 'Guest' };
  if (key && kind !== 'video') g.key = key;
  if (kind !== 'video' && (x.place === 'studio' || x.place === 'monitor')) g.place = x.place;
  if (kind !== 'video' && x.role === 'cohost') g.role = 'cohost';
  if (Array.isArray(x.crop) && x.crop.length === 4 && x.crop.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    const [cx, cy, cw, ch] = (x.crop as number[]).map((v) => Math.min(1, Math.max(0, v)));
    if (cw > 0.02 && ch > 0.02) g.crop = [Math.min(cx, 0.98), Math.min(cy, 0.98), Math.min(cw, 1 - Math.min(cx, 0.98)), Math.min(ch, 1 - Math.min(cy, 0.98))];
  }
  if (kind === 'video') { const f = sanitizeFaceBox(x.face); if (f) g.face = f; }
  return g;
}

/** Where a guest is on the show (guestlink: per guest, host's override first). `tvLook` = a TV guest's own choice. */
export function guestPlace(bag: Pick<InterviewBag, 'layout'>, g: InterviewGuest, tvLook?: 'tv' | 'projector' | 'standee' | null): GuestPlace {
  if (g.kind === 'video') return 'monitor';
  if (g.place) return g.place;
  if (tvLook === 'projector') return 'monitor';
  if (tvLook === 'tv' || tvLook === 'standee') return 'studio';
  return bag.layout === 'seated' ? 'studio' : 'monitor';
}

/** One line-up entry on the show (planLineup). */
export interface LineupSlot {
  /** Index in `bag.guests`. */
  i: number;
  g: InterviewGuest;
  /** The kind in effect (a performer who turned out to be a walking TV is a TV). */
  kind: GuestKind;
  role: GuestRole;
  /** 1-based number within the role: Co-host 1 / 2, Guest 1…4 (the `cohostN` / `guestN` shots). */
  n: number;
  /** Director / shot subject id: 'c0', 'c1' (co-hosts), 'g0'…'g3' (guests). */
  id: string;
  /** Where they are in effect: co-hosts sit at the desk ('studio'; a projector-screen TV has no body to seat: the
   *  monitor); a guest's own place — and once the monitor's panels are all taken, a performer / TV sits in the studio. */
  place: GuestPlace;
  /** Monitor panel (0…MAX_PANELS-1), -1 = not on the monitor. */
  panel: number;
  /** A monitor guest moved to the studio because the monitor was full. */
  overflow?: boolean;
}

/** Who is where on the show (pure: the engine, the studio panel, tests). `info(g, i)`: a performer who turned out to be
 *  a walking TV (`tv`) + a TV's own look. Panels go to the monitor places in line-up order (co-hosts included). */
export function planLineup(bag: Pick<InterviewBag, 'layout' | 'guests'>, info?: (g: InterviewGuest, i: number) => { tv?: boolean; look?: 'tv' | 'projector' | 'standee' | null } | null): LineupSlot[] {
  const out: LineupSlot[] = [];
  const cnt = { cohost: 0, guest: 0 };
  let panels = 0;
  bag.guests.forEach((g, i) => {
    const inf = info?.(g, i) ?? null;
    const kind: GuestKind = g.kind !== 'video' && inf?.tv ? 'tv' : g.kind;
    const role: GuestRole = kind === 'video' ? 'guest' : roleOf(g);
    const look = kind === 'tv' ? inf?.look ?? null : null;
    let place: GuestPlace = role === 'cohost' ? (look === 'projector' ? 'monitor' : 'studio') : guestPlace(bag, { ...g, kind }, look);
    let panel = -1, overflow = false;
    if (place === 'monitor') {
      if (panels < MAX_PANELS) panel = panels++;
      else if (kind !== 'video') { place = 'studio'; overflow = true; }
    }
    const n = ++cnt[role];
    out.push({ i, g, kind, role, n, id: `${role === 'cohost' ? 'c' : 'g'}${n - 1}`, place, panel, ...(overflow ? { overflow } : {}) });
  });
  return out;
}

/** Who a command means (Live panel / Stream Deck / Ctrl+K): a member key first (the line-up may have changed since),
 *  else 'guestN' / 'cohostN' (N-th of that role), else a line-up index. -1 = nobody. */
export function lineupFind(guests: Pick<InterviewGuest, 'key' | 'role'>[], at: { key?: unknown; who?: unknown; i?: unknown }): number {
  if (typeof at.key === 'string' && at.key) { const k = guests.findIndex((g) => g.key === at.key); if (k >= 0) return k; }
  const m = typeof at.who === 'string' ? /^(guest|cohost)([1-6])$/.exec(at.who) : null;
  if (m) { let n = 0; for (let k = 0; k < guests.length; k++) if (roleOf(guests[k]) === m[1] && ++n === +m[2]) return k; return -1; }
  if (typeof at.who === 'string' && at.who) return guests.findIndex((g) => g.key === at.who);
  return typeof at.i === 'number' && Number.isInteger(at.i) && at.i >= 0 && at.i < guests.length ? at.i : -1;
}

/** Make line-up entry i a co-host / a guest (toggle = the other one). Never drops anyone: a full role is an error.
 *  Returns a new array. */
export function setLineupRole(guests: InterviewGuest[], i: number, role: GuestRole | 'toggle'): { guests: InterviewGuest[]; error?: string } {
  const g = guests[i];
  if (!g) return { guests, error: 'Not in the line-up' };
  if (g.kind === 'video') return { guests, error: 'Video callers are guests on the monitor' };
  const want: GuestRole = role === 'toggle' ? (roleOf(g) === 'cohost' ? 'guest' : 'cohost') : role;
  if (want === roleOf(g)) return { guests };
  const have = guests.filter((x) => roleOf(x) === want).length;
  if (want === 'cohost' && have >= MAX_COHOSTS) return { guests, error: `Up to ${MAX_COHOSTS} co-hosts` };
  if (want === 'guest' && have >= MAX_GUESTS) return { guests, error: `Up to ${MAX_GUESTS} guests` };
  const out = guests.map((x) => ({ ...x }));
  if (want === 'cohost') out[i].role = 'cohost'; else delete out[i].role;
  return { guests: out };
}

/** Move line-up entry i one place earlier (-1) / later (+1) — the order numbers the shots (Guest 1, 2 …). New array. */
export function moveInLineup<G>(guests: G[], i: number, dir: -1 | 1): G[] {
  const j = i + dir, out = guests.slice();
  if (i < 0 || i >= out.length || j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** The single shot of a line-up entry: `cohostN`, `guestN` (or `guest` when there is only one guest). */
export function singleShotOf(slot: Pick<LineupSlot, 'role' | 'n'>, guestCount: number): ShotId {
  if (slot.role === 'cohost') return `cohost${Math.min(MAX_COHOSTS, slot.n)}` as ShotId;
  return guestCount <= 1 ? 'guest' : `guest${Math.min(MAX_GUESTS, slot.n)}` as ShotId;
}

export function sanitizeInterview(o: unknown): InterviewBag {
  const d = DEFAULT_INTERVIEW;
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const guests: InterviewGuest[] = [];
  // (per role: ≤ MAX_COHOSTS co-hosts, ≤ MAX_GUESTS guests, ≤ MAX_PANELS video guests — they only ever show on the monitor)
  const n = { cohost: 0, guest: 0, video: 0 };
  if (Array.isArray(x.guests)) for (const g of x.guests.slice(0, 32)) {
    const s = sanitizeGuest(g);
    if (!s || (s.key && guests.some((q) => q.key === s.key))) continue;
    const r = roleOf(s);
    if (r === 'cohost' ? n.cohost >= MAX_COHOSTS : n.guest >= MAX_GUESTS || (s.kind === 'video' && n.video >= MAX_PANELS)) continue;
    n[r]++; if (s.kind === 'video') n.video++;
    guests.push(s);
  }
  return {
    layout: x.layout === 'seated' ? 'seated' : 'monitor',
    guests,
    director: x.director === 'manual' ? 'manual' : 'auto',
    shot: isShotId(x.shot) ? x.shot : d.shot,
    cutSeq: Math.round(num(x.cutSeq, 0, 1e9, 0)),
    ...(typeof x.subject === 'string' && /^(host|sidekick|gv|c[0-9]|g[0-9])$/.test(x.subject) ? { subject: x.subject } : {}),
    ...(x.shot === 'wide' && typeof x.cam === 'string' && CAM_NAME.test(x.cam) ? { cam: x.cam } : {}),
    ...(x.shot === 'wide' && (x.aud === 'r' || x.aud === 'w' || x.aud === 'a') ? { aud: x.aud } : {}),
    pace: x.pace === 'calm' || x.pace === 'snappy' ? x.pace : 'normal',
    sidekick: typeof x.sidekick === 'boolean' ? x.sidekick : d.sidekick,
    sidekickModel: typeof x.sidekickModel === 'string' && AVATAR.test(x.sidekickModel) ? x.sidekickModel : '',
    title: text(x.title, 40, d.title),
    bumperSeq: Math.round(num(x.bumperSeq, 0, 1e9, 0)),
    video: x.video === 'window' || x.video === 'hole' ? x.video : 'auto',
    meter: x.meter === true,
    reactions: typeof x.reactions === 'boolean' ? x.reactions : d.reactions,
    pushIns: typeof x.pushIns === 'boolean' ? x.pushIns : d.pushIns,
    snaps: typeof x.snaps === 'boolean' ? x.snaps : d.snaps,
    // (switches that default on are only stored when switched off: a v2 bag parses to the defaults)
    ...(x.crowdCuts === false ? { crowdCuts: false } : {}),
    ...(x.roomCams === false ? { roomCams: false } : {}),
    seed: Math.round(num(x.seed, 0, 1e6, d.seed)),
  };
}

// ---------------------------------------------------------------- per-room sets
/** Themes of the generated set pieces (desk, monitor frame, sidekick's band stand). */
export type SetTheme = 'studio' | 'swamp' | 'dorms' | 'factory' | 'labs' | 'camp' | 'fob' | 'bridge' | 'epoch' | 'kitchen' | 'harbour' | 'lounge';
/** Monitor frame styles: generated TV sets, or the room's own screen skin (shared/screenSkin.ts; `skin`). */
export type MonitorStyle = 'tv' | 'crt' | 'fieldcrt' | 'holo' | 'terminal' | 'menuboard' | 'mirror' | 'skin';

/** A point + facing in the room (glTF space, metres; yaw in degrees about +Y, 0 = facing +Z). */
export interface SetPlace { position: [number, number, number]; yaw: number }

/** scene.json `interview` (all optional) — or the built-in entry below. */
export interface RoomInterviewConfig {
  /** Theme of the generated pieces. */
  theme?: SetTheme;
  /** The host's chair (SPOT_xx name). Default: SPOT_01. */
  host?: string;
  /** 'room' = the room already has a desk at the host's chair; 'none'; a place = a generated desk there ({width} m);
   *  missing = a generated desk in front of the host's chair when the floor there is free. */
  desk?: 'room' | 'none' | (SetPlace & { width?: number });
  /** The guest monitor: style + picture width (m); `position` / `yaw` (centre of the PICTURE, glTF) pin it, else it is
   *  placed automatically beside the host; `side` +1 / -1 = the host's right / left first. `node` = the room node the
   *  picture sits ON (a picture rect authored on the room's own TV glass, e.g. a screen-skin template): placed there
   *  (unless position / yaw pin it) and it rides that node - never lifted to fit.monY (src/scene/talkshow/callInHousing.ts). */
  monitor?: Partial<SetPlace> & { width?: number; style?: MonitorStyle; side?: number; node?: string };
  /** Seated guests (the other layout): SPOT_xx names, best first. */
  guests?: string[];
  /** Co-hosts' chairs (SPOT_xx names, first co-host first). Missing = automatic (layout.ts): generated chairs at the
   *  desk beside the host (the desk grows to seat everyone) — a room chair right there is used instead — else the
   *  nearest room chairs facing the same way. */
  cohosts?: string[];
  /** Sidekick: band stand kind; `position` / `yaw` pin the floor point (else automatic); null = no sidekick. */
  sidekick?: (Partial<SetPlace> & { stand?: 'keys' | 'drums' | 'none' }) | null;
  /** Extra cutaway presets (room cameras, e.g. the kitchen crew). */
  cutaways?: string[];
  /** Hand-tuned shot poses (glTF): { host: {pos, target, fov}, … } — else solved. */
  shots?: Record<string, { pos: [number, number, number]; target: [number, number, number]; fov: number }>;
  note?: string;
}

/** Built-in sets for the shipped rooms (a room's own scene.json `interview` wins, key by key). Positions come from each
 *  room's spots (docs/SCENES.md), checked in the app renderer (contact sheets in the talkshow workstream). */
export const ROOM_SETS: Record<string, RoomInterviewConfig> = {
  // (the desk / monitor / sidekick places are found automatically from the host's chair — src/scene/talkshow/layout.ts;
  // pin one here or in the room's scene.json `interview` only when a room needs it)
  eft_customs_dorms: { theme: 'dorms', host: 'SPOT_01', monitor: { style: 'crt', width: 1.2 }, guests: ['SPOT_07', 'SPOT_06', 'SPOT_02'], sidekick: { stand: 'none' } },
  eft_factory: { theme: 'factory', host: 'SPOT_01', desk: 'room', monitor: { style: 'fieldcrt', width: 1.3 }, guests: ['SPOT_02', 'SPOT_03', 'SPOT_04'], sidekick: { stand: 'drums' } },
  eft_labs: { theme: 'labs', host: 'SPOT_01', desk: 'room', monitor: { style: 'skin', width: 1.7 }, guests: ['SPOT_02', 'SPOT_03', 'SPOT_04'], sidekick: { stand: 'keys' } },
  eft_labs_rnd: { theme: 'labs', host: 'SPOT_01', desk: 'room', monitor: { style: 'skin', width: 1.7 }, guests: ['SPOT_02', 'SPOT_03', 'SPOT_04'], sidekick: { stand: 'keys' } },
  gzw_crimson_camp: { theme: 'camp', host: 'SPOT_01', monitor: { style: 'fieldcrt', width: 1.15 }, guests: ['SPOT_02', 'SPOT_05', 'SPOT_06'], sidekick: { stand: 'drums' } },
  gzw_fob: { theme: 'fob', host: 'SPOT_01', monitor: { style: 'fieldcrt', width: 1.25 }, guests: ['SPOT_02', 'SPOT_04', 'SPOT_03'], sidekick: { stand: 'keys' } },
  helldivers_bridge: { theme: 'bridge', host: 'SPOT_01', monitor: { style: 'skin', width: 1.9 }, guests: ['SPOT_02', 'SPOT_03', 'SPOT_04'], sidekick: { stand: 'keys' } },
  lastepoch_end_of_time: { theme: 'epoch', host: 'SPOT_01', monitor: { style: 'skin', width: 1.8 }, guests: ['SPOT_02', 'SPOT_05', 'SPOT_06'], sidekick: { stand: 'drums' } },
  poe2_kingsmarch: { theme: 'harbour', host: 'SPOT_01', monitor: { style: 'skin', width: 1.8 }, guests: ['SPOT_02', 'SPOT_05', 'SPOT_04'], sidekick: { stand: 'drums' } },
  sc_area18: { theme: 'lounge', host: 'SPOT_01', monitor: { style: 'skin', width: 1.7 }, guests: ['SPOT_02', 'SPOT_03', 'SPOT_06'], sidekick: { stand: 'keys' } },
  // (cohost workstream: studio guests take the other armchair, then the nearest bench ends — not the far bench seats)
  sc_grimhex: { host: 'SPOT_01', guests: ['SPOT_02', 'SPOT_05', 'SPOT_06', 'SPOT_04'] },
};

/** The cameras of a room the auto director may cut to besides its people shots (cue v3 `cam`): none of these = v2 behaviour. */
export interface RoomCoverage {
  /** The house wide (CAM_HOUSE): the whole set from the riser; the plain room wide when absent. */
  house?: string;
  /** The audience camera (scene.json audience.camera) and its section cameras (sectionCams, left to right). */
  audience?: string;
  sections: string[];
  /** B-roll: the room's cutaways (interview.cutaways) minus the audience cameras and the house wide. */
  broll: string[];
  /** The cutaway that frames the sidekick from the front (a band camera), the jib cameras. */
  band?: string;
  jib: string[];
}
const CAM_NAME = /^(CAM|SPOT)_[A-Z0-9_]{1,28}$/;
/** The coverage of a room from its scene.json (the same answer in the studio, from the scenes list, and on every page, from
 *  rt.info). `interview.coverage` overrides any key: { house, audience, sections, broll, band, jib }. undefined = the room has
 *  none of it (a cutaway-less, audience-less room: the director then behaves as before). */
export function roomCoverage(info: unknown): RoomCoverage | undefined {
  const j = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const names = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((s): s is string => typeof s === 'string' && CAM_NAME.test(s));
  const one = (v: unknown) => (typeof v === 'string' && CAM_NAME.test(v) ? v : undefined);
  const iv = obj(j.interview), ov = obj(iv.coverage), au = obj(j.audience);
  const audOn = au.on !== false && (!!au.camera || !!au.sectionCams || !!au.count);
  const cutaways = names(iv.cutaways);
  // (every camera name the scene.json mentions: the studio cameras' shots and the room's mirrored cams)
  const known = new Set<string>([...cutaways, ...names([j.defaultCamera, j.reactCamera]), ...(Object.keys(obj(j.cams)).filter((s) => CAM_NAME.test(s)))]);
  for (const c of Array.isArray(obj(j.studioCams).cameras) ? obj(j.studioCams).cameras as unknown[] : []) for (const s of names(obj(c).shots)) known.add(s);
  const audience = 'audience' in ov ? one(ov.audience) : audOn ? one(au.camera) : undefined;
  const sections = 'sections' in ov ? names(ov.sections) : audOn ? Object.keys(obj(au.sectionCams)).sort((a, b) => +a - +b).map((k) => one(obj(au.sectionCams)[k])).filter((s): s is string => !!s) : [];
  const house = 'house' in ov ? one(ov.house) : known.has('CAM_HOUSE') ? 'CAM_HOUSE' : undefined;
  const audCams = new Set([...(audience ? [audience] : []), ...sections]);
  const broll = 'broll' in ov ? names(ov.broll) : cutaways.filter((s) => !audCams.has(s) && s !== house && s !== 'CAM_WIDE');
  const band = 'band' in ov ? one(ov.band) : broll.find((s) => /BAND|STAGE|SIDEKICK/.test(s));
  const jib = 'jib' in ov ? names(ov.jib) : broll.filter((s) => /JIB/.test(s));
  if (!house && !audience && !sections.length && !broll.length) return undefined;
  return { ...(house ? { house } : {}), ...(audience ? { audience } : {}), sections, broll, ...(band ? { band } : {}), jib };
}

/** The physical studio camera that owns a shot (scene.json `studioCams.cameras[]`: id, label, tally fixture, lens point, the virtual
 *  presets taken from it): by the camera preset's name (`CAM_HOUSE`, `SPOT_03_CAM` ...), else the camera whose lens is within 0.5 m of
 *  `pos` (a solved shot standing at a studio lens). null = no mapped camera (a robo cam without a tally, a solved free pose). A page
 *  would light that camera's tally fixture; every page derives the same answer from the cue. */
export function studioCamFor(info: unknown, cam?: string, pos?: readonly [number, number, number]): { id: string; tally: string | null } | null {
  const j = (info && typeof info === 'object' ? info : {}) as Record<string, unknown>;
  const sc = j.studioCams && typeof j.studioCams === 'object' ? j.studioCams as Record<string, unknown> : {};
  const list = (Array.isArray(sc.cameras) ? sc.cameras : []).filter((c): c is Record<string, unknown> => !!c && typeof c === 'object');
  const out = (c: Record<string, unknown>) => ({ id: String(c.id), tally: typeof c.tally === 'string' ? c.tally : null });
  if (cam) { const c = list.find((q) => Array.isArray(q.shots) && (q.shots as unknown[]).includes(cam)); if (c) return out(c); }
  if (pos) {
    let best: Record<string, unknown> | null = null, bd = 0.5;
    for (const c of list) {
      const l = c.lens;
      if (!Array.isArray(l) || l.length < 3) continue;
      const d = Math.hypot(+l[0] - pos[0], +l[1] - pos[1], +l[2] - pos[2]);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) return out(best);
  }
  return null;
}

/** The room's set: built-in entry, overridden key by key by scene.json `interview`. */
export function roomInterviewConfig(roomId: string, json: unknown): RoomInterviewConfig {
  const base = ROOM_SETS[roomId] ?? ROOM_SETS[baseRoomId(roomId)] ?? {};   // (an area: its room's set)
  const j = (json && typeof json === 'object' ? json : {}) as RoomInterviewConfig;
  return { ...base, ...j };
}

/** Director pacing (seconds). `cap` = the longest any one shot stays on air without a reason (broadcast practice: ~8-15 s;
 *  a cut then waits for a gap between words, ≤ 2.5 s more). `turnLag` = how long a voice must have talked before it takes the
 *  floor when it is contested; `fast` = the same for a CLEAN handover (the holder stopped, nobody else sounds: people answer
 *  within ~0.2 s and a good director takes the answer on its first words); `think` = how long a silence after a question lasts
 *  before the camera goes to the person who has to answer. */
export const PACE: Record<Pace, { minHold: number; maxHold: number; react: number; turnLag: number; cap: number; fast: number; think: number }> = {
  calm: { minHold: 3.6, maxHold: 13, react: 2.4, turnLag: 1.6, cap: 18, fast: 0.5, think: 1.6 },
  normal: { minHold: 2.6, maxHold: 9, react: 1.9, turnLag: 1.2, cap: 13, fast: 0.4, think: 1.2 },
  snappy: { minHold: 1.7, maxHold: 6, react: 1.5, turnLag: 0.8, cap: 9, fast: 0.3, think: 0.9 },
};

// ---------------------------------------------------------------- director cues (one director for every page)
/** The host's studio runs THE auto director (src/ui/stage/interviewHost.ts) and sends each cut — and a heartbeat every
 *  second — to this PC's OBS pages (bus command 'interview' {cue}) and to party guests (party wire 'ivcue', relayed to
 *  their OBS pages the same way). Pages take the cue instead of deciding for themselves, so every page shows the same
 *  shot at the same moment, a reloaded OBS source joins the running show, and video guests' voices measured only in the
 *  studio count everywhere. No cue for 2.5 s (an older studio, no studio): each page directs itself as before.
 *  n = the studio director's cut number; at = how long ago (s) that cut was taken; src = the sending studio's id (two
 *  studio windows: the lower id leads); react = a reaction beat that goes with the cut (the sidekick laughs …).
 *
 *  Cue v3 (the v3 director; every field optional, an older page's sanitizer ignores what it does not know, and no new shot id
 *  exists - a v3 shot rides on an existing id, so an older page shows a sensible shot instead of dropping the cue):
 *    v    3 = a v3 studio. A page following a fresh v3 cue lets nobody but the studio's director choose the shot (room events
 *         still come first).
 *    ac   1 = this studio's director cues the asker's close-up itself ("Answer now": a `wide` + `aud: 'a'`, see `aud`): only then does
 *         the audience engine's page-local asker close-up stand down (`askerStandsDown`). Absent (a room whose audience the studio
 *         cannot see - AUDIENCE_SEAT_xx nodes in the GLB, no scene.json `audience` -, or the owner's "cut to the chat audience" off):
 *         the page's own asker close-up shows, as it did before v3.
 *    cam  a room camera preset (/^(CAM|SPOT)_…/) for `wide`: the house wide, a band camera, the jib, an audience section camera.
 *         A page whose room lacks it shows the room wide.
 *    aud  `wide` shows the audience: 'r' the crowd's reaction, 'w' the audience wide, 'a' the asker's close-up (ak = which
 *         question; another / none on this page: the audience wide). No audience on the page: cam, else the room wide.
 *    mv   a named camera move, sent with secs 0 (an older page cuts): 'crane' (down onto the host at the show open),
 *         'pull' (back and wider on applause). v3 pages take the time from CRANE_SECS / PULL_SECS.
 *    sk   the studio's sidekick decision: 'on' / 'off' (the room has one and the bag allows it).
 *    at   (existing) how long ago the cut was taken: a page that joins late starts a timed move that far in. */
export interface InterviewCue { n: number; shot: ShotId; subject: string; via?: string; secs: number; why: string; at: number; src: string; react?: 'laugh' | 'snap' | 'nod'; rw?: string;
  /** The studio director's session (a new one each time Interview starts in that studio): a new session is a new show,
   *  its cut numbers start again at 0 on the same bus id. */
  s?: string;
  v?: number; cam?: string; aud?: 'r' | 'w' | 'a'; ak?: string; mv?: 'crane' | 'pull'; sk?: 'on' | 'off'; ac?: 1 }
/** The named camera moves' times (s), shared by every page: a `mv` cue carries secs 0 so an older page cuts, never flies. */
export const CRANE_SECS = 3.5, PULL_SECS = 2.5;
const CUE_WHO = /^(host|sidekick|gv|c[01]|g[0-3])?$/;
export function sanitizeCue(o: unknown): InterviewCue | null {
  if (!o || typeof o !== 'object') return null;
  const x = o as Record<string, unknown>;
  if (!isShotId(x.shot) || typeof x.n !== 'number' || !Number.isFinite(x.n)) return null;
  const sub = typeof x.subject === 'string' && CUE_WHO.test(x.subject) ? x.subject : '';
  const via = typeof x.via === 'string' && /^(host|c[01]|g[0-3])$/.test(x.via) ? x.via : undefined;
  const react = x.react === 'laugh' || x.react === 'snap' || x.react === 'nod' ? x.react : undefined;
  const rw = typeof x.rw === 'string' && CUE_WHO.test(x.rw) && x.rw ? x.rw : undefined;
  // (cue v3: a field that does not fit its shot is dropped, never the cue)
  const v = typeof x.v === 'number' && Number.isInteger(x.v) && x.v >= 3 && x.v <= 9 ? x.v : undefined;
  const wide = x.shot === 'wide';
  const cam = wide && typeof x.cam === 'string' && /^(CAM|SPOT)_[A-Z0-9_]{1,28}$/.test(x.cam) ? x.cam : undefined;
  const aud = wide && (x.aud === 'r' || x.aud === 'w' || x.aud === 'a') ? x.aud : undefined;
  const ak = aud === 'a' && typeof x.ak === 'string' && /^[A-Za-z0-9_:.-]{1,40}$/.test(x.ak) ? x.ak : undefined;
  const mv = (x.mv === 'crane' && x.shot === 'host') || (x.mv === 'pull' && wide) ? x.mv : undefined;
  const sk = x.sk === 'on' || x.sk === 'off' ? x.sk : undefined;
  const ac = v && x.ac === 1 ? 1 as const : undefined;
  return {
    n: Math.round(Math.min(1e9, Math.max(0, x.n))), shot: x.shot, subject: sub, ...(via ? { via } : {}), secs: num(x.secs, 0, 12, 0),
    why: text(x.why, 80, ''), at: num(x.at, 0, 3600, 0), src: typeof x.src === 'string' ? x.src.replace(/[^a-z0-9]/gi, '').slice(0, 16) : '',
    ...(react && rw ? { react, rw } : {}),
    ...(typeof x.s === 'string' && /^[a-z0-9]{1,16}$/i.test(x.s) ? { s: x.s } : {}),
    ...(v ? { v } : {}), ...(cam ? { cam } : {}), ...(aud ? { aud } : {}), ...(ak ? { ak } : {}), ...(mv ? { mv } : {}), ...(sk ? { sk } : {}), ...(ac ? { ac } : {}),
  };
}
/** Does the audience engine's own "Answer now" close-up (the camera override `audience:asker:*`) stand down on a page following this cue?
 *  Only when the studio is a v3 one that says it cues the asker itself (`ac`): a room the studio's director has no audience for would
 *  otherwise lose the close-up silently. No cue (or a v2 one): it shows, as before. */
export function askerStandsDown(cue: Pick<InterviewCue, 'v' | 'ac'> | null | undefined): boolean { return !!cue && (cue.v ?? 0) >= 3 && cue.ac === 1; }
