// Interview auto-director: cuts on who is speaking, with talk-show pacing (docs/SCENES.md → Interview mode).
//
// Pure logic, no three.js: `update(dt, levels)` → the shot on air. THE director runs in the host's studio
// (src/ui/stage/interviewHost.ts) on the clean voice levels of src/scene/talkshow/activity.ts and sends every cut to the
// OBS pages as a cue (`follow`); a page without cues (no studio, an older studio) runs its own copy on the signals it has.
//
// It steps at a fixed 20 Hz (the loudest level since the last step is held), so the same signals cut the same way at any
// frame rate; choices use a seeded PRNG (seed + cut count).
//
// Rules (seconds scale with the pace — shared/talkshow.ts PACE):
//  · a new speaker gets their shot once they have talked `turnLag` s and the current shot is ≥ `minHold` old (no cut on
//    a cough, no ping-pong on quick back-and-forth: overlaps go to the two-shot / over-the-shoulder instead);
//  · long answers get variety: a slow push-in on the speaker, a listener's reaction, the alternate angle;
//  · NO shot stays on air longer than `cap` (≈ 8-15 s, broadcast practice) without a reason: past it the director cuts
//    to the next shot that fits (the speaker's other angle, a listener, the guest's screen, the host, the wide), at the
//    next gap between words (≤ 2.5 s later) — never mid-word;
//  · punchlines: a turn of ≥ 2.5 s that ends in a burst from a listener (laughing) or a beat of silence → a reaction
//    shot (the listener, the sidekick, or — rarely — a comedic snap zoom), then back to whoever talks;
//  · silence ≥ 5 s → the establishing wide / two-shot; nobody on the set → establishing;
//  · guests still connecting (`ready` false) are not on the show yet: never the speaker, never a reaction;
//  · guests with no voice signal at all (`voiceless`: a video caller without a meter) are presumed to talk while every
//    one with a voice has been quiet ≥ 1.5 s (one such caller: their screen; several: the whole monitor, subject 'gv');
//    the guess ends the instant a real voice starts, and that voice gets the camera back after 0.6 s;
//  · with guests only on the monitor (`seated` 0) the host + monitor two-shot (an empty chair in the middle, both small)
//    gives way to the over-the-shoulder towards the screen;
//  · a hotkey / button cut (cutSeq) is taken at once and held ≥ 4 s before the automatic cutting resumes; the manual
//    director only ever shows the chosen shot; `floor(id)` gives someone the floor for a while (the studio's "Guest's
//    turn" button / Stream Deck key).
import { CRANE_SECS, PACE, type Pace, type RoomCoverage, type ShotId } from '../../../shared/talkshow.ts';

export interface DirectorOpts {
  pace: Pace;
  reactions: boolean;
  pushIns: boolean;
  snaps: boolean;
  /** Number of guests (0…4) and whether they are on the monitor or seated. */
  guests: number;
  /** Co-hosts at the desk with the host (0…2). */
  cohosts?: number;
  layout: 'monitor' | 'seated';
  sidekick: boolean;
  seed: number;
  /** Participants on the show right now (missing = yes): a guest still connecting is false. */
  ready?: Record<string, boolean>;
  /** Guests without any voice signal (video callers without a meter): presumed to talk while the others are quiet. */
  voiceless?: string[];
  /** Guests seated in the room (the rest are on the monitor); missing = unknown (the layout decides). */
  seated?: number;
  /** The guests (ids) on the monitor; missing = the guests after the first `seated` ones. */
  monitor?: string[];
  /** The room's cameras besides its people shots (shared/talkshow.ts roomCoverage): the house wide, the audience and its sections,
   *  b-roll cutaways, the band camera, the jib. Missing = none (a room without them is directed as before). */
  coverage?: RoomCoverage;
  /** The owner's switches (default on): cuts to the chat audience (laugh, big cheer, the asker) / the room's own cameras. */
  crowdCuts?: boolean;
  roomCams?: boolean;
  /** Display names (id → name): a chat question that names a guest ("Chat asks Sam: …") is for them. */
  names?: Record<string, string>;
  /** 'talk' (default) or 'game' (a game-show set: contestants, a clock, buzzers). The game profile listens to the game events below;
   *  the talk profile ignores them - nothing about a talk show changes. */
  profile?: 'talk' | 'game';
}

/** What the studio tells the director besides voices (src/scene/talkshow/crowd.ts merges bursts; src/ui/stage/interviewCrowd.ts
 *  feeds it from the bus): applied at the next fixed step, so every page with the same feed makes the same cut. */
export type DirectorEvent =
  | { kind: 'show' }                                                       // the show-open card starts: the curtain, then the crane in
  | { kind: 'laughWave'; n: number }                                       // several chatters laugh together
  | { kind: 'alert'; what: 'cheer' | 'raid' | 'gifts' | 'montage' | 'applause'; size: number }
  | { kind: 'ask'; key: string; text: string; cut?: false }               // "Answer now" on a chat question (key = cueShots.askKey; cut:false = the owner's "Close-up of the asker" is off: no close-up cut)
  // ---- the game profile (profile 'game'; the game rules come with the game set - only the types, the queue and the buzz rule land now)
  | { kind: 'buzz'; id: string }                                           // a contestant buzzed in: their single within a fixed step
  | { kind: 'reveal' } | { kind: 'win'; id: string } | { kind: 'lose'; id: string } | { kind: 'clock'; left: number };

/** A shot on air: the shot id, its subject ('host' | 'c0' | 'c1' | 'g0'…'g3' | 'gv' = the whole monitor | ''), the camera
 *  move time (0 = cut); `via` = the other person the shot is built on (over-the-shoulder: whose shoulder; `hosts`: which
 *  co-host). */
export interface DirectorShot { shot: ShotId; subject: string; secs: number; why: string; via?: string;
  /** Cue v3 (shared/talkshow.ts InterviewCue): a room camera preset for a `wide` (the house wide, a band camera, the jib); the
   *  audience on a `wide` ('r' reaction, 'w' wide, 'a' the asker's close-up, `ak` = which question); a named camera move
   *  ('crane' / 'pull': secs stay 0, the pages take the time from CRANE_SECS / PULL_SECS); `at` = how long the cut had been on air
   *  when this page took it (a page that joined late starts a timed move that far in). No new shot ids. */
  cam?: string; aud?: 'r' | 'w' | 'a'; ak?: string; mv?: 'crane' | 'pull'; at?: number }

/** A cut as the studio sends it (shared/talkshow.ts InterviewCue, the fields `follow` needs). */
export interface CueLike { n: number; shot: ShotId; subject: string; via?: string; secs: number; why: string; react?: 'laugh' | 'snap' | 'nod'; rw?: string; src?: string; s?: string;
  at?: number; v?: number; cam?: string; aud?: 'r' | 'w' | 'a'; ak?: string; mv?: 'crane' | 'pull'; sk?: 'on' | 'off' }

type Voice = { lvl: number; raw: number; on: boolean; above: number; below: number; turnStart: number; lastOn: number; lastOff: number; burst: number; loudAt: number;
  /** The current run of sound (a line): started at runStart, still going while sound came within RUN_GAP; `hist` = the last
   *  ACT_STEPS steps' sound / no sound (hsum of them): how much of the last second this voice was sounding. */
  runStart: number; runOpen: boolean; hist: Uint8Array; hi: number; hsum: number;
  /** This run is a LISTENER burst (a laugh / an interjection, not a turn): 'mid' = it started while the holder was sounding,
   *  'hug' = right on the end of their line, 'grp' = several others started together. lkSeen = the run classified (its start),
   *  reacted = the run the director already reacted to. */
  lk: '' | 'mid' | 'hug' | 'grp'; lkAt: number; lkRun: number; lkSeen: number; reacted: number };

const ON = 0.34, OFF = 0.17;
/** Everyone with a voice quiet this long (s) → a voiceless caller is presumed to talk (a sentence pause is shorter). */
const PRESUME = 1.5;
/** A real voice back from a presumed caller: cut after this long (s), not a whole turn lag + minimum hold (a cough or an "mm-hm"
 *  is shorter: the guess would only come back after PRESUME s of quiet, so a cut on it stays on air for seconds). */
const EARLY = 0.6;
/** No automatic cut leaves a shot younger than this (s): a page that renders at 3 fps, or one that joins a moment later, could
 *  not show a sub-second shot the way the studio did - and a flash is bad television anyway. The operator's cuts, the floor and
 *  the studio's cues (`follow`) are exempt; a snap zoom counts its 0.2 s move inside its hold. */
export const MIN_ON = 1.2;
/** The director's fixed step (s). */
export const DIRECTOR_STEP = 0.05;
/** A clean handover: the holder has made no sound for this long (s), their turn was at least HANDOVER_PREV s, nobody else
 *  sounds - the newcomer then needs only PACE.fast s of talk to take the floor (a contested voice needs turnLag). */
const HANDOVER_GAP = 0.2, HANDOVER_PREV = 1.0;
/** A reaction cutaway that ends goes back to whoever holds the floor: the speaker while they sound, else a voice that sounds now
 *  and has for REACT_BACK_RUN s (the host who chimed in over the end of an answer), else - with nobody just starting - the speaker
 *  through the pause between two phrases (a breath, a word looked for: PHRASE_PAUSE s since their last sound). Only a table with
 *  nobody talking gets the quiet wide - one put up under a voice stays there for the rest of the sentence. */
const PHRASE_PAUSE = 1.0, REACT_BACK_RUN = 0.6;
/** The person we expect to answer (after a long turn of the person who held the floor: the only guest, the question's
 *  addressee, the last guest who held the floor) takes the floor in PACE.fast × ANTICIPATE s, a gap or not; the expectation
 *  lasts EXPECT_FOR s after a turn of at least EXPECT_TURN s. */
const ANTICIPATE = 0.75, ASKED = 0.4, EXPECT_FOR = 6, EXPECT_TURN = 1.5;
/** A fast cut that lands on a voice who stops within RETRACT_TURN s while the holder resumes is taken back (within RETRACT_WINDOW s). */
const RETRACT_TURN = 1.0, RETRACT_WINDOW = 4;
/** A line = a run of sound; it ends after RUN_GAP s of quiet. Lines of at least RUN_MIN s are remembered (the last 8). */
const RUN_GAP = 0.3, RUN_MIN = 0.5;
/** The steps of the "how much of the last second was this voice sounding" window. */
const ACT_STEPS = 20;
/** The laugh ladder. A burst from someone who does not hold the floor, started while the holder was sounding or within
 *  LAUGH_HUG s of the end of their line, is a laugh / an interjection (never cross-talk, never a turn) for up to LAUGH_ONE_MAX s
 *  (LISTEN_MAX for several together). The camera goes to the laugher REACT_DELAY s after it starts (MID_REACT while the holder
 *  carries on: a "mhm" is shorter), at most once per REACT_GAP s, and stays until the laughter decays: REACT_MIN…REACT_MAX s. */
const REACT_DELAY = 0.35, MID_REACT = 0.9, LAUGH_HUG = 0.2, LAUGH_ONE_MAX = 1.8, LISTEN_MAX = 3.0;
const REACT_GAP = 4, REACT_MIN = 1.2, REACT_MAX = 3.0, HUG_TURN = 2.5;
/** Rapid banter: BANTER_ALT back-and-forths (lines handed over between different people) inside BANTER_WINDOW s, every line
 *  (a speaker's consecutive sentences, pauses < BANTER_JOIN s, make one line) at most BANTER_LINE s long. The camera then holds
 *  the shot of THOSE people (their two-shot / the wide) instead of ping-ponging between singles, while a line follows within
 *  BANTER_QUIET s; a line longer than BANTER_LINE s ends it (the new speaker's own shot at once). */
const BANTER_ALT = 2, BANTER_WINDOW = 8, BANTER_LINE = 3, BANTER_ENTRY = 2.2, BANTER_JOIN = 1, BANTER_QUIET = 2;
/** In a turn of at least STORY_TURN s a listener's face is shown at a word gap every STORY_GAP[0]…[1] s (seeded). */
const STORY_TURN = 6, STORY_GAP: [number, number] = [15, 25];
/** A snap zoom (rare): at least SNAP_GAP s apart, only on a laugh of several people. A push-in: once per subject per PUSH_GAP s. */
const SNAP_GAP = 120, PUSH_GAP = 60;
/** Rhythm: the last MEM_N shots on air are remembered. A shot used in the last MEM_RECENT s is welcome only W_RECENT as much, one
 *  that would close a 3-shot sequence already seen in the last LOOP_WINDOW s not at all; a listener whose own shot ended less than
 *  ALT_RECENT s ago is shown from another angle. Holds are jittered (seeded, per cut): minHold × MIN_JIT, the cap × CAP_JIT. */
const MEM_N = 8, MEM_RECENT = 20, W_RECENT = 0.3, LOOP_WINDOW = 60, ALT_RECENT = 8;
const MIN_JIT: [number, number] = [0.85, 1.2], CAP_JIT: [number, number] = [0.8, 1.0];
/** The crowd and the room's cameras. An audience reaction to a laugh wave ≥ CROWD_GAP s apart, an applause shot ≥ ALERT_GAP s apart,
 *  a b-roll cutaway ≥ BROLL_GAP s apart (an applause shot of ANOTHER kind - a raid after a cheer - only ALERT_ANY s); none in the first
 *  TURN_QUIET s of a turn; the wide family (wide, establishing, cutaways,
 *  the audience) at most WIDE_BUDGET of the last WIDE_WINDOW s of conversation. Dead air from DEAD_AIR s: a wide / cutaway, a new
 *  one every DEAD_HOLD s. "The think": a question hangs THINK_GAP s apart at most. The curtain starts to clear OPEN_REVEAL s after
 *  the show-open card starts (the crane in begins then). */
const CROWD_GAP = 12, ALERT_GAP = 25, ALERT_ANY = 5, BROLL_GAP = 45, WIDE_BUDGET = 0.2, WIDE_WINDOW = 60, TURN_QUIET = 3, THINK_GAP = 30, DEAD_AIR = 4.5;
const CROWD_HOLD: [number, number] = [1.6, 2.8], ALERT_HOLD: [number, number] = [3, 4], ASK_HOLD: [number, number] = [2.5, 4], DEAD_HOLD: [number, number] = [4, 8];
const OPEN_REVEAL = 3.5, THINK_TURN = 7;
/** How late (s) the show-open crane may still fire: a hotkey cut's 4 s window (manualUntil) can delay it, a pin that outlives that cannot. */
const OPEN_LATE = 6;
/** Subathon extras: the gift-train montage (section cameras, MONTAGE_STEP s each) at most every MONTAGE_GAP s; a huge alert (size 3) makes
 *  the pace snappy for HYPE_SECS; "the take": the host's snap zoom when they stay silent TAKE_QUIET s after the crowd laughed. */
const MONTAGE_GAP = 60, MONTAGE_STEP = 1.2, HYPE_SECS = 30, TAKE_QUIET = 0.8, TAKE_HOLD = 1.5;
/** Optional cuts (another angle, a push-in, a listener's face, a cutaway) per 30 s, by pace. */
const CUT_BUDGET: Record<Pace, number> = { calm: 5, normal: 7, snappy: 9 };
/** The pseudo participant for several voiceless callers (the whole monitor). */
const GV = 'gv';
/** What the viewer calls "the same shot": the shot, who it is about, the other person it is built on, the camera / audience it
 *  is on (cue v3). */
const shotKey = (s: { shot: string; subject: string; via?: string; cam?: string; aud?: string }) => `${s.shot}:${s.subject}${s.via ? '@' + s.via : ''}${s.cam ? '#' + s.cam : ''}${s.aud ? '*' + s.aud : ''}`;
/** Both are the same picture (a cut to it would change nothing). */
const sameShot = (a: DirectorShot, b: DirectorShot) => a.shot === b.shot && a.subject === b.subject && (a.via ?? '') === (b.via ?? '') && (a.cam ?? '') === (b.cam ?? '') && (a.aud ?? '') === (b.aud ?? '') && (a.ak ?? '') === (b.ak ?? '') && (a.mv ?? '') === (b.mv ?? '');
/** The shot a cue names. */
const wideFam = (s: Pick<DirectorShot, 'shot'>) => s.shot === 'establishing' || s.shot === 'wide';
const shotOfCue = (c: CueLike, secs = c.secs): DirectorShot => ({ shot: c.shot, subject: c.subject, secs, why: c.why, ...(c.via ? { via: c.via } : {}),
  ...(c.cam ? { cam: c.cam } : {}), ...(c.aud ? { aud: c.aud } : {}), ...(c.ak ? { ak: c.ak } : {}), ...(c.mv ? { mv: c.mv } : {}) });

export class InterviewDirector {
  opts: DirectorOpts;
  now = 0;
  private voices = new Map<string, Voice>();
  private cur: DirectorShot = { shot: 'establishing', subject: '', secs: 0, why: 'start' };
  private curAt = 0;
  /** The shot on air was chosen by the guess rule (a voiceless caller presumed to talk), not merely one that shows such a caller. */
  private curGuess = false;
  private prev: DirectorShot | null = null;
  private prevLeft = -99;
  private speaker = '';
  private speakerSince = 0;
  private lastReact = -99;
  private lastVariety = -99;
  private lastWide = -99;
  /** A reaction cutaway in progress: shown until `until`, then (for a laugh) while the laughers (`ids`) still sound, at most until `max`. */
  private reacting: { until: number; max: number; back: string; kind: 'laugh' | 'nod' | 'snap'; ids: string[] } | null = null;
  private manualUntil = -1;
  /** The next story reaction is due this long (s) after the last reaction (seeded), the last snap zoom, the last push-in per subject. */
  private reactEvery = 20;
  private lastSnap = -999;
  /** The last laugh reaction (a nod reaction never blocks a laugh), and the last moment two or more listeners were laughing. */
  private lastLaugh = -99;
  private laughMode = -99;
  /** The last moment a voiceless caller was presumed to talk (their lines are not heard: no banter is judged around them). */
  private guessAt = -99;
  /** Rapid banter in progress: the people trading lines, since when, whether the wide cutaway (the cap) is on air. */
  private banter: { set: string[]; since: number; alt: boolean } | null = null;
  /** A single laugher's cut waiting to learn what the burst was: a laugh (it ended within LAUGH_ONE_MAX s) or an answer. */
  private pendingLaugh: { id: string; runStart: number; n: number } | null = null;
  private readonly lastPush: Record<string, number> = {};
  /** The last MEM_N shots on air (key, when it went up, when it left - 0 = still on air) and the 3-shot sequences seen lately. */
  private readonly mem: { key: string; at: number; end: number }[] = [];
  private readonly seqs: { k: string; at: number }[] = [];
  private cuts = 0;
  private acc = 0;
  private readonly pend: Record<string, number> = {};
  private quietT = 0;
  /** Who is expected to take the floor next (after a long turn of the person who held it) and until when. */
  private expect = '';
  private expectUntil = -1;
  /** The last guest who held the floor and when (the host's likely partner). */
  private lastGuest = { id: '', at: -99 };
  /** The speaker before the current one; whether the current one took the floor by the fast path (a clean handover). */
  private prevSpeaker = '';
  private speakerFast = false;
  /** The speaker took the floor by the fast path and their shot is not on air yet (the cut then needs the shorter hold). */
  private fastPending = false;
  /** The last cut made by the fast path (a clean handover): who, from whom, when. */
  private fastTake: { x: string; prev: string; at: number } | null = null;
  /** The cut made when a real voice took the camera from a presumed caller: who, from whom, when. */
  private guessTake: { x: string; prev: string; at: number } | null = null;
  /** Events waiting for their moment (at = when they may fire, until = when they are stale). */
  private evq: { e: DirectorEvent; at: number; until: number }[] = [];
  private lastCrowd = -99; private lastAlert = -99; private lastBroll = -99; private lastThink = -99;
  /** How long the speaker's last turn was (a question is short; a monologue that pauses for the laugh is not a question). */
  private lastTurnLen = 0;
  private readonly lastAlertKind: Record<string, number> = {};
  private lastApplauseAud: boolean | null = null;
  private lastMontage = -99; private hypeUntil = -1;
  /** The gift-train montage in progress (the next step is due at `at`), and "the take" waiting for the host's silence after a laugh. */
  private montage: { steps: DirectorShot[]; at: number } | null = null;
  private takeFrom = -1; private takeUntil = -1;
  /** A chat question is being read / answered: who it is for ('' = nobody named), until when. */
  private askAddr = ''; private askUntil = -1;
  /** The show-open card started: the crane in is due at this time. */
  private openAt = -1;
  /** The show-open crane is stale after this (s): Show open pressed in Manual / Pin must not crane in minutes later, on Auto's return. */
  private openBy = -1;
  /** A guest who just arrived (ready false → true): the shot that shows them in, in two beats. */
  private arrive: { id: string; at: number; stage: number } | null = null;
  private readyPrev: Record<string, boolean> = {};
  /** The shots that left the air in the last WIDE_WINDOW s (for the wide budget). */
  private readonly air: { t0: number; t1: number; wide: boolean }[] = [];
  /** A crowd / room reaction in progress tells the sidekick plays along (the studio's lights): kind. */
  onCrowd: ((kind: 'laugh' | 'applause' | 'ask' | 'open', size: number) => void) | null = null;
  /** The finished lines of the last 8 (who, start, end of sound; at least RUN_MIN s). */
  private readonly runs: { who: string; t0: number; t1: number; lk?: boolean }[] = [];
  private forced: { id: string; until: number; at: number } | null = null;
  private cueN = -1;
  /** A laugh / reaction happened (the sidekick plays along): subject id + kind. */
  onReaction: ((who: string, kind: 'laugh' | 'snap' | 'nod') => void) | null = null;
  /** The reaction beat that went with the last cut (the studio sends it with the cue): cut number, who, kind. */
  lastBeat: { n: number; who: string; kind: 'laugh' | 'snap' | 'nod' } | null = null;
  /** Debug log of the last cuts (time, shot, why). */
  readonly log: { t: number; shot: string; subject: string; why: string; cam?: string; aud?: string; ak?: string; mv?: string; secs?: number }[] = [];

  constructor(opts: DirectorOpts) { this.opts = { ...opts }; }

  get shot(): DirectorShot { return this.cur; }
  get onAirFor() { return this.now - this.curAt; }
  /** The pace now: a huge alert (a $100 cheer, a raid of 50) runs snappy for HYPE_SECS. */
  get pace(): Pace { return this.now < this.hypeUntil ? 'snappy' : this.opts.pace; }
  /** The number of cuts so far (the cue number). */
  get cutCount() { return this.cuts; }

  private rnd(k = 0) {
    let t = (this.opts.seed * 7919 + this.cuts * 104729 + k * 1299709) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Participants: 'host', the co-hosts 'c0', 'c1', the guests 'g0'…'g3' (+ 'gv': several voiceless callers). */
  private ids(): string[] {
    const v = this.voiceless();
    return ['host', ...Array.from({ length: this.co }, (_, i) => `c${i}`), ...Array.from({ length: this.opts.guests }, (_, i) => `g${i}`), ...(v.length > 1 ? [GV] : [])];
  }
  private get co() { return Math.max(0, Math.min(2, this.opts.cohosts ?? 0)); }
  /** On the show (a guest still connecting is not). */
  private live(id: string) { return id === GV ? this.voiceless().length > 1 : this.opts.ready?.[id] !== false; }
  private voiceless(): string[] { return (this.opts.voiceless ?? []).filter((id) => /^g\d$/.test(id) && +id.slice(1) < this.opts.guests && this.opts.ready?.[id] !== false); }
  /** Guests only on the monitor (no seated guest): the two-shot would be host + screen with empty chairs between. */
  private get monitorOnly() { return this.opts.guests > 0 && (this.opts.seated ?? (this.opts.layout === 'seated' ? this.opts.guests : 0)) === 0; }
  private get readyGuests() { return Array.from({ length: this.opts.guests }, (_, i) => `g${i}`).filter((id) => this.live(id)); }
  /** The host's side of the desk (the host + the co-hosts). */
  private hostSide(id: string) { return id === 'host' || /^c\d$/.test(id); }
  /** A random co-host id (seeded), or '' with none. */
  private someCo(k: number) { return this.co ? `c${Math.floor(this.rnd(k) * this.co)}` : ''; }
  /** A random guest on the show (seeded), or ''. */
  private someGuest(k: number) { const g = this.readyGuests; return g.length ? g[Math.floor(this.rnd(k) * g.length)] : ''; }
  /** The cap and the minimum hold of THIS hold: jittered (seeded by the cut count, so constant within a hold and the same on every
   *  page) - a metronome of 2.6 s / 13 s holds is what makes automatic television look automatic. */
  private cap(P: (typeof PACE)[Pace]) { return P.cap * (CAP_JIT[0] + (CAP_JIT[1] - CAP_JIT[0]) * this.rnd(51)); }
  private minHold(P: (typeof PACE)[Pace]) { return P.minHold * (MIN_JIT[0] + (MIN_JIT[1] - MIN_JIT[0]) * this.rnd(50)); }

  /** A shot went up: into the memory (the previous one leaves) and the 3-shot sequences. */
  private remember(s: DirectorShot) {
    const last = this.mem[this.mem.length - 1];
    if (last) last.end = this.now;
    this.mem.push({ key: shotKey(s), at: this.now, end: 0 });
    if (this.mem.length > MEM_N) this.mem.shift();
    const n = this.mem.length;
    if (n >= 3) { this.seqs.push({ k: `${this.mem[n - 3].key}>${this.mem[n - 2].key}>${this.mem[n - 1].key}`, at: this.now }); if (this.seqs.length > 16) this.seqs.shift(); }
  }
  /** How welcome a shot is as the next one (0…1): one of the last 3 shots on air 0, one that would repeat a 3-shot sequence seen
   *  in the last LOOP_WINDOW s 0, a key used in the last MEM_RECENT s W_RECENT, else 1. */
  private welcome(s: DirectorShot): number {
    const k = shotKey(s), n = this.mem.length;
    if (this.mem.slice(-3).some((m) => m.key === k)) return 0;
    if (n >= 2) { const q = `${this.mem[n - 2].key}>${this.mem[n - 1].key}>${k}`; if (this.seqs.some((x) => x.k === q && this.now - x.at < LOOP_WINDOW)) return 0; }
    return this.mem.some((m) => m.key === k && this.now - (m.end || this.now) < MEM_RECENT) ? W_RECENT : 1;
  }
  /** A weighted (seeded) pick among shots: weight × welcome. null = none is welcome (every one repeats); `force` (a cut is due
   *  anyway) then takes the one that has been off the air the longest. */
  private pickShot(c: { s: DirectorShot; w?: number }[], k: number, force = false): DirectorShot | null {
    const ws = c.map((x) => (x.w ?? 1) * this.welcome(x.s)), tot = ws.reduce((a, b) => a + b, 0);
    if (tot <= 0) {
      if (!force || !c.length) return null;
      const off = (sh: DirectorShot) => { const key = shotKey(sh); const m = [...this.mem].reverse().find((q) => q.key === key); return m ? (m.end ? this.now - m.end : 0) : 1e9; };
      return c.reduce((b, x) => (off(x.s) > off(b.s) ? x : b)).s;
    }
    let x = this.rnd(k) * tot;
    for (let i = 0; i < c.length; i++) { x -= ws[i]; if (x < 0) return c[i].s; }
    return c[c.length - 1].s;
  }

  /** The subject a manual cut to `shot` takes on THIS page now (the shot's own, else whoever is on air): the host's
   *  studio stamps it into the bag (InterviewBag.subject), so every page — a reloaded OBS source, a guest who joined late
   *  — cuts to the same person. */
  cutSubject(shot: ShotId): string { return this.subjectOf(shot) || this.cur.subject; }

  /** A hotkey / button cut: taken now, held ≥ 4 s (auto) — or for good (manual). */
  cut(shot: ShotId, subject = '', extra?: { cam?: string; aud?: 'r' | 'w' | 'a' }) {
    // (an unstamped cut takes the shot's own subject or a fixed default — never whatever this page happened to have on air:
    // a push-in / snap on the host, an over-the-shoulder towards guest 1, the sidekick's own shot)
    const sub = subject || this.subjectOf(shot) || (shot === 'push' || shot === 'snap' ? 'host' : shot === 'ots' ? (this.opts.guests ? 'g0' : 'host') : shot === 'sidekick' ? 'sidekick' : '');
    this.take({ shot, subject: sub, secs: shot === 'push' ? 6.5 : shot === 'snap' ? 0.2 : 0, why: 'operator', ...(shot === 'wide' && extra?.cam ? { cam: extra.cam } : {}), ...(shot === 'wide' && extra?.aud ? { aud: extra.aud } : {}) }, true);
    this.manualUntil = this.now + 4;
  }

  /** Give `id` the floor for `secs` (the operator's "Guest's turn"): their shot now, the director treats them as the
   *  speaker until the time runs out or someone else clearly takes over. '' = cancel. */
  floor(id: string, secs = 25) {
    if (!id) { this.forced = null; return; }
    if (!this.ids().includes(id) && id !== GV) return;
    this.forced = { id, until: this.now + secs, at: this.now };
    this.speaker = id; this.speakerSince = this.now; this.speakerFast = false; this.fastPending = false;
    this.manualUntil = -1; this.reacting = null;
    this.take({ shot: this.single(id), subject: id, secs: 0, why: `operator: ${this.name(id)}'s turn` }, true);
  }
  get floorHolder() { return this.forced && this.forced.until > this.now ? this.forced.id : ''; }

  /** The studio tells the director something happened (see DirectorEvent): applied at the next fixed step. */
  event(e: DirectorEvent) {
    if (this.evq.length >= 32) return;
    const crowd = this.opts.crowdCuts !== false;
    switch (e.kind) {
      case 'show': this.openAt = this.now + OPEN_REVEAL; this.openBy = this.openAt + OPEN_LATE; try { this.onCrowd?.('open', 0); } catch { /* optional */ } break;
      case 'laughWave': if (crowd) this.evq.push({ e, at: this.now + REACT_DELAY, until: this.now + 3 }); break;
      case 'alert':
        if (crowd) {
          this.evq.push({ e, at: this.now, until: this.now + 6 });
          if (e.size >= 3 && e.what !== 'montage') this.hypeUntil = this.now + HYPE_SECS;
        }
        break;
      case 'buzz': case 'reveal': case 'win': case 'lose': case 'clock':
        // (the game profile only: a talk show never reacts to them)
        if (this.opts.profile === 'game') this.evq.push({ e, at: this.now, until: this.now + (e.kind === 'buzz' ? 1 : 3) });
        break;
      case 'ask':
        // (who the question is for is known the moment it is read out; the asker's close-up is a cut, maybe)
        this.askAddr = this.addresseeOf(e.text); this.askUntil = this.now + 30;
        // (the owner's "Close-up of the asker" off: only the cut is skipped - the addressee tracking above still drives the think and the guest's turn)
        if (crowd && e.cut !== false) this.evq.push({ e, at: this.now, until: this.now + 2 });
        break;
    }
  }

  /** The room's cameras the director may use (none with the owner's room-cameras switch off). */
  private get cov(): RoomCoverage | null { return this.opts.roomCams === false ? null : this.opts.coverage ?? null; }
  private get audience(): boolean { const c = this.opts.crowdCuts === false ? null : this.opts.coverage; return !!c && !!(c.audience || c.sections.length); }
  /** Does this director cue the asker's close-up ("Answer now")? Only in a room whose scene.json has an audience (and with the owner's
   *  "cut to the chat audience" on): the studio says so in its cue (`ac`), and only then do its pages drop the audience engine's own
   *  close-up - a room whose audience is just AUDIENCE_SEAT_xx nodes in the GLB keeps that close-up. */
  get cuesAsker(): boolean { return this.audience; }
  /** The guest a chat question names (display name, else "guest N") or ''. */
  private addresseeOf(text: string): string {
    const toks = (x: string) => x.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const words = ` ${toks(text).join(' ')} `;
    for (const id of this.readyGuests) {
      const nn = toks(this.opts.names?.[id] ?? '').join(' ');
      if (nn.length >= 2 && words.includes(` ${nn} `)) return id;
    }
    const m = /guest\s*(\d)/.exec(text.toLowerCase());
    return m && this.readyGuests.includes(`g${+m[1] - 1}`) ? `g${+m[1] - 1}` : '';
  }
  /** The share of the last WIDE_WINDOW s that was on a wide-family shot (the one on air counts). */
  private wideShare(): number {
    const from = this.now - WIDE_WINDOW;
    let w = 0, tot = 0;
    for (const a of [...this.air, { t0: this.curAt, t1: this.now, wide: wideFam(this.cur) }]) {
      const d = Math.min(a.t1, this.now) - Math.max(a.t0, from);
      if (d <= 0) continue;
      tot += d; if (a.wide) w += d;
    }
    return tot > 5 ? w / tot : 0;
  }
  private wideOk() { return this.wideShare() < WIDE_BUDGET; }
  /** The establishing wide - or the room's house wide (the whole set from the riser) when it has one: whichever is welcome. */
  private estab(why: string, k: number): DirectorShot {
    const est: DirectorShot = { shot: 'establishing', subject: '', secs: 0, why };
    const house = this.cov?.house;
    if (!house) return est;
    return this.pickShot([{ s: est }, { s: { shot: 'wide', subject: '', secs: 0, why, cam: house } }], k) ?? est;
  }
  /** B-roll cutaways (the jib, the band, the on-air monitors …): at most one per BROLL_GAP s of conversation. */
  private cutaways(): DirectorShot[] {
    const c = this.cov;
    if (!c || !c.broll.length || this.now - this.lastBroll < BROLL_GAP) return [];
    return c.broll.map((cam) => ({ shot: 'wide' as ShotId, subject: '', secs: 0, why: 'cutaway: the room', cam }));
  }
  /** The sidekick's shot: the band camera (the sidekick from the front) when the room has one, else the sidekick single. */
  private sideShot(why: string): DirectorShot {
    const band = this.cov?.band;
    return band ? { shot: 'wide', subject: 'sidekick', secs: 0, why, cam: band } : { shot: 'sidekick', subject: 'sidekick', secs: 0, why };
  }
  /** Dead air: a wide or a cutaway (never the host + guest 1 two-shot). */
  private deadAirShot(): DirectorShot | null {
    const why = 'nobody is talking: the wide';
    const c = this.cov;
    if (!c && !(this.monitorOnly && this.opts.guests && this.now - this.lastWide < 40)) {
      const w = this.opts.guests > 1 ? 'establishing' : this.quietWide();
      return { shot: w, subject: this.subjectFor(w, 21), secs: 0, why };
    }
    if (!c) { const g = this.someGuest(21); return g ? { shot: 'ots', subject: g, secs: 0, why } : { shot: 'establishing', subject: '', secs: 0, why }; }
    const cands: { s: DirectorShot; w?: number }[] = [{ s: { shot: 'establishing', subject: '', secs: 0, why } }];
    if (c.house) cands.push({ s: { shot: 'wide', subject: '', secs: 0, why: 'nobody is talking: the house wide', cam: c.house } });
    for (const cam of c.broll) cands.push({ s: { shot: 'wide', subject: '', secs: 0, why: 'nobody is talking: a cutaway', cam }, w: 0.7 });
    return this.pickShot(cands, 46) ?? this.pickShot(cands, 46, true);
  }

  /** Take the studio's cut (pages following the studio's director). Same cut number = already on air. */
  follow(c: CueLike): DirectorShot {
    // (the show = the studio's bus id + its director session: Interview left and started again in the same studio is a
    // new show whose cuts count from 0; so is a big step back in the numbers from an older studio without sessions)
    const src = `${c.src ?? ''}/${c.s ?? ''}`;
    if (src === this.cueSrc && c.n < this.cueN - 3) this.cueSrc = '';
    // (an older cut from the same studio arriving late: never back to it; a new studio — a reload — starts again at 0)
    if (src === this.cueSrc && c.n < this.cueN) return this.cur;
    const same = sameShot(shotOfCue(c), this.cur);
    if (src === this.cueSrc && c.n === this.cueN) {
      // the heartbeat of the cut we already took — unless this page directed itself meanwhile (the cues stopped for a
      // while): then it says where the show really is, once
      if (!same) this.take(shotOfCue(c, 0), true);
      return this.cur;
    }
    this.cueN = c.n; this.cueSrc = src;
    // (a cut that had been on air a while when this page first saw it - a reload, a late joiner: its timed move starts that far in)
    this.take({ ...shotOfCue(c), ...(c.at && c.at > 0.25 ? { at: c.at } : {}) }, true);
    if (c.react && c.rw) try { this.onReaction?.(c.rw, c.react); } catch { /* a reaction never breaks the show */ }
    return this.cur;
  }
  private cueSrc = '';

  private subjectOf(shot: ShotId): string {
    if (shot === 'host' || shot === 'reverse') return 'host';
    const c = /^cohost([12])$/.exec(shot);
    if (c) return `c${+c[1] - 1}`;
    if (shot === 'hosts') return /^c\d$/.test(this.speaker) ? this.speaker : 'c0';
    if (shot === 'panel') return '';
    if (shot === 'guest') return this.opts.guests ? (this.speakerIsGuest() ? this.speaker : 'g0') : '';
    const m = /^guest([1-4])$/.exec(shot);
    return m ? `g${+m[1] - 1}` : '';
  }
  private speakerIsGuest() { return /^g\d$/.test(this.speaker); }

  /** On air now; false = it already was (nothing changed) or the shot on air is still younger than MIN_ON. `guess` = the cut
   *  was made by the guess rule (a voiceless caller presumed to talk). */
  private take(s: DirectorShot, force = false, guess = false): boolean {
    if (sameShot(s, this.cur)) {
      // (the same picture: nothing to cut - but the guess rule saying "that is the presumed caller" makes the shot on air the guess shot,
      // e.g. after the think already put the caller up: the host's next word then takes the camera back fast)
      if (force || (guess && !this.curGuess)) {
        this.cur = { ...this.cur, why: s.why };
        if (guess) this.curGuess = true;
        if (this.log.length) this.log[this.log.length - 1].why = s.why;
      }
      return false;
    }
    if (!force && this.cuts > 0 && this.now - this.curAt < MIN_ON - 1e-9) return false;
    this.air.push({ t0: this.curAt, t1: this.now, wide: wideFam(this.cur) });
    while (this.air.length && this.air[0].t1 < this.now - WIDE_WINDOW) this.air.shift();
    if (/^cutaway/.test(s.why)) this.lastBroll = this.now;
    this.prev = this.cur; this.prevLeft = this.now;
    this.cur = s; this.curAt = this.now; this.cuts++; this.curGuess = guess;
    this.remember(s);
    if (['establishing', 'two', 'wide'].includes(s.shot)) this.lastWide = this.now;
    this.log.push({ t: +this.now.toFixed(2), shot: s.shot, subject: s.subject, why: s.why, secs: s.secs, ...(s.cam ? { cam: s.cam } : {}), ...(s.aud ? { aud: s.aud } : {}), ...(s.ak ? { ak: s.ak } : {}), ...(s.mv ? { mv: s.mv } : {}) });
    if (this.log.length > 400) this.log.shift();
    return true;
  }

  /** The single for a participant (monitor guests: their panel; one guest: the whole monitor; several voiceless
   *  callers: the whole monitor). */
  private single(id: string): ShotId {
    if (id === 'host') return 'host';
    if (id === 'sidekick') return 'sidekick';
    if (id === GV) return 'guest';
    if (/^c\d$/.test(id)) return `cohost${+id.slice(1) + 1}` as ShotId;
    if (this.opts.guests <= 1) return 'guest';
    return `guest${+id.slice(1) + 1}` as ShotId;
  }
  private name(id: string) { return id === 'host' ? 'the host' : id === GV ? 'the callers' : /^c\d$/.test(id) ? `co-host ${+id.slice(1) + 1}` : /^g\d$/.test(id) ? `guest ${+id.slice(1) + 1}` : id; }

  /** Advance by dt with the current voice levels (0..1 per participant id). `manual` (Director: Manual): voices are
   *  still tracked, but nothing is ever cut automatically — the chosen shot stays on air (before, the 4 s hold of
   *  `cut` ran out and the automatic rules flashed another shot for a frame every ~4 s before the page cut back). */
  update(dt: number, levels: Record<string, number>, manual = false): DirectorShot {
    // steps that ended before this frame first, on what the frames before it said (a step [a, b) takes the loudest level
    // of the frames inside it — so 30, 60 or 144 fps pages fed the same 20 Hz signal take the same steps); then this
    // frame's levels count for the step it is in
    this.acc += Math.max(0, Math.min(dt, 2));
    while (this.acc >= DIRECTOR_STEP - 1e-9) {
      this.acc -= DIRECTOR_STEP;
      // (no frame inside a step — a page slower than 20 Hz: the newest levels carry over)
      if (!this.pendN) for (const k in this.lastLv) this.pend[k] = this.lastLv[k];
      this.step(DIRECTOR_STEP, this.pend, manual);
      for (const k in this.pend) delete this.pend[k];
      this.pendN = 0;
    }
    for (const k in this.lastLv) delete this.lastLv[k];
    for (const k in levels) { const v = levels[k], x = Number.isFinite(v) ? v : 0; this.pend[k] = Math.max(this.pend[k] ?? 0, x); this.lastLv[k] = x; }
    this.pendN++;
    return this.cur;
  }
  // (two maps, refilled — nothing allocated per frame)
  private readonly lastLv: Record<string, number> = {};
  private pendN = 0;

  private step(dt: number, levels: Record<string, number>, manual: boolean) {
    this.now += dt;
    const P = PACE[this.pace];
    const ids = this.ids();
    // ---- voice activity (hysteresis + minimum times)
    const vl = new Set(this.voiceless());
    // presumed talk: every one with a voice quiet for ≥ PRESUME s → the voiceless caller(s); the guess ends the instant
    // a real voice starts (a host pausing mid-thought takes the floor straight back)
    const voiced = ids.filter((id) => id !== GV && !vl.has(id) && this.live(id));
    const realStart = voiced.some((id) => (levels[id] ?? 0) > ON);
    const quietAll = !realStart && voiced.every((id) => { const q = this.voices.get(id); return !q || q.lvl < OFF; });
    this.quietT = vl.size && quietAll ? this.quietT + dt : 0;
    const presumed = this.quietT > PRESUME;
    if (presumed || vl.has(this.speaker) || this.speaker === GV) this.guessAt = this.now;
    if (realStart) for (const id of [...vl, GV]) {
      const q = this.voices.get(id);
      // (no "end of a turn" for a guess: no laugh / punchline reaction is built on it)
      if (q?.on) { q.on = false; q.lvl = 0; q.above = 0; q.below = 0; q.lastOff = this.now; q.burst = 0; }
    }
    for (const id of ids) {
      let v = this.voices.get(id);
      if (!v) { v = { lvl: 0, raw: 0, on: false, above: 0, below: 0, turnStart: 0, lastOn: -99, lastOff: 0, burst: 0, loudAt: -99, runStart: 0, runOpen: false, hist: new Uint8Array(ACT_STEPS), hi: 0, hsum: 0, lk: '', lkAt: -99, lkRun: -1, lkSeen: -1, reacted: -1 }; this.voices.set(id, v); }
      let x = Math.max(0, Math.min(1, levels[id] ?? 0));
      if (!this.live(id)) x = 0;
      if (vl.has(id)) x = presumed && vl.size === 1 ? 0.7 : 0;
      if (id === GV) x = presumed ? 0.7 : 0;
      v.raw = x;
      if (x > ON) { v.loudAt = this.now; if (!v.runOpen) { v.runOpen = true; v.runStart = this.now; } }
      else if (v.runOpen && this.now - v.loudAt >= RUN_GAP) { v.runOpen = false; if (!vl.has(id) && id !== GV) this.lineEnded(id, v); }
      v.hsum += (x > ON ? 1 : 0) - v.hist[v.hi]; v.hist[v.hi] = x > ON ? 1 : 0; v.hi = (v.hi + 1) % ACT_STEPS;
      v.lvl += (x - v.lvl) * (1 - Math.exp(-dt / (x > v.lvl ? 0.06 : 0.25)));
      if (v.lvl > ON) { v.above += dt; v.below = 0; } else if (v.lvl < OFF) { v.below += dt; v.above = 0; }
      if (!v.on && v.above > 0.18) { v.on = true; v.turnStart = this.now - v.above; v.lastOn = this.now; }
      if (v.on && v.below > 0.9) { v.on = false; v.lastOff = this.now - v.below; v.burst = v.lastOff - v.turnStart; }
    }
    // (voices of guests who left)
    for (const k of [...this.voices.keys()]) if (!ids.includes(k)) this.voices.delete(k);
    if (this.forced && (this.forced.until <= this.now || !ids.includes(this.forced.id))) this.forced = null;
    if (manual || this.manualUntil > this.now) {
      // (Manual / Pin: nothing is cut, and a guest who connects meanwhile has arrived - the arrival beats are for the moment, not for the
      // switch back to Auto. A hotkey cut's 4 s window is no pin: a guest who connects just after it still gets their arrival.)
      if (manual) { for (let i = 0; i < this.opts.guests; i++) this.readyPrev[`g${i}`] = this.live(`g${i}`); this.arrive = null; }
      return;
    }
    const on = ids.filter((id) => this.voices.get(id)!.on);
    // ---- listener bursts (laughs, interjections) are told apart from turns the moment they start
    this.flagListeners(ids, vl);
    if (this.pendingLaugh) {
      const pl = this.pendingLaugh, pv = this.voices.get(pl.id);
      if (!pv || pv.runStart !== pl.runStart || !pv.runOpen) this.pendingLaugh = null;
      else if (!pv.lk) { this.pendingLaugh = null; this.relabel(pl.n, `${this.name(pl.id)} is talking`); }
    }
    // ---- who holds the floor: among those talking for ≥ turnLag (a laugh / "mhm" never takes it), the longest turn - or, for a
    // CLEAN handover (the holder stopped, nobody else sounds) / the person we expect, after only `fast` s
    let spk = '', spkFast = false;
    const guessOnAir = vl.has(this.speaker) || this.speaker === GV;
    // (a real voice back from a presumed caller must have SOUNDED this long: EARLY at the normal pace, shorter at a snappy one)
    const early = Math.min(EARLY, Math.max(0.45, P.turnLag * 0.6));
    const cands: { id: string; viaFast: boolean }[] = [];
    for (const id of on) {
      const q = this.voices.get(id)!;
      if (q.lk) continue;                                   // (a laugh / an interjection never takes the floor)
      const guessId = vl.has(id) || id === GV;
      // (off a guess, a real voice needs only a moment: the guess was a pause, not the caller)
      const normal = guessOnAir && !guessId ? early : P.turnLag;
      const fast = guessId || guessOnAir ? Infinity : this.fastLag(id, on, P);
      // (the fast lag counts from the voice's current line: after a laugh the turn goes on, the new line is a new start)
      const talked = this.now - q.turnStart, talkedRun = this.now - Math.max(q.turnStart, q.runStart);
      if (talked < normal && talkedRun < fast) continue;
      // (a real voice taking over from a presumed caller must have SOUNDED for the lag - not merely be inside the hangover of a
      // 0.5 s "mm-hm": the guess would have come back only after PRESUME s of quiet, a cut on it stays up for seconds)
      if (guessOnAir && !guessId && q.loudAt - Math.max(q.turnStart, q.runStart) < early) continue;
      // (fast = the voice is young, or its CURRENT line is and the handover is clean: the `on` flag outlives a pause shorter than 0.9 s,
      // so a voice that laughed and paused is still "old" - its new line is a new start)
      cands.push({ id, viaFast: talked < normal || (fast !== Infinity && talkedRun < normal) });
    }
    // (the oldest turn holds the floor ...)
    let best = cands.reduce<(typeof cands)[number] | null>((b, c) => (!b || this.voices.get(c.id)!.turnStart < this.voices.get(b.id)!.turnStart ? c : b), null);
    if (best) {
      // ... unless it is only the hangover of a word that ended a moment ago and a newcomer who started after it is sounding
      const bv = this.voices.get(best.id)!;
      if (this.now - bv.loudAt >= HANDOVER_GAP) {
        const newer = cands.filter((c) => c !== best && this.now - this.voices.get(c.id)!.loudAt < 0.6 && Math.max(this.voices.get(c.id)!.turnStart, this.voices.get(c.id)!.runStart) >= bv.loudAt - 0.1)
          .sort((a, b) => this.voices.get(a.id)!.turnStart - this.voices.get(b.id)!.turnStart)[0];
        if (newer) best = newer;
      }
    }
    if (best) { spk = best.id; spkFast = best.viaFast; }
    // the operator gave someone the floor: theirs, unless someone else has clearly taken over (≥ 4 s, them quiet)
    if (this.forced) {
      const f = this.voices.get(this.forced.id), o = spk ? this.voices.get(spk)! : null;
      if (spk && spk !== this.forced.id && o && this.now - Math.max(o.turnStart, this.forced.at) > 4 && !f?.on) this.forced = null;
      else spk = this.forced.id;
    }
    if (spk && spk !== this.speaker) {
      // (a real voice after a presumed one: the guess ended the moment the voice started - a clean handover, whatever shot is on air)
      const fromGuess = (vl.has(this.speaker) || this.speaker === GV) && !vl.has(spk) && spk !== GV;
      this.prevSpeaker = this.speaker; this.speaker = spk; this.speakerSince = this.voices.get(spk)?.turnStart ?? this.now; this.speakerFast = (spkFast || fromGuess) && !this.forced; this.fastPending = this.speakerFast;
    }
    else if (spk && spk === this.speaker) { if (spkFast && !this.speakerFast) this.fastPending = true; this.speakerFast = spkFast; }
    if (/^g\d$/.test(this.speaker) && this.voices.get(this.speaker)?.on) this.lastGuest = { id: this.speaker, at: this.now };
    const speakerOn = (id: string) => !!id && (this.voices.get(id)?.on || this.floorHolder === id);
    // ---- laughter: a burst from a listener right on a line (see the laugh ladder above) → their face on its first beat, or
    // the shared shot when several laugh together; held until the laughter decays
    // ---- the crowd and the show's beats: events from the studio (laugh wave, big cheer, a chat question, the show open) and a
    // guest arriving
    if (this.eventStep(ids, vl)) return;
    if (this.laughLadder(P, ids)) return;
    const held = this.now - this.curAt;
    const mh = this.minHold(P);
    // ---- rapid banter: the shot of the people trading lines, not a ping-pong of singles
    if (!this.reacting && this.banterStep(P, ids, vl, held)) return;
    // ---- a reaction cutaway in progress
    if (this.reacting) {
      // (a listener's nod or laugh gives way the moment someone else takes the floor: the answer is the shot, not the reaction)
      const sv = this.speaker ? this.voices.get(this.speaker) : null;
      const taken = this.reacting.kind !== 'snap' && !!sv && this.speaker !== this.reacting.back && sv.on && this.now - sv.loudAt < 0.4;
      if (taken && this.now - this.curAt >= MIN_ON) this.reacting = null;
      else {
        // (a laugh is held while the laughers still sound - at most REACT_MAX s)
        const rc = this.reacting;
        const decaying = rc.kind === 'laugh' && this.now < rc.max && rc.ids.some((id) => !!this.voices.get(id)?.lk && this.now - (this.voices.get(id)?.loudAt ?? -99) < 0.3);
        if (this.now < rc.until || decaying || this.now - this.curAt < MIN_ON) return;
        this.reacting = null;
        // (rapid banter going on: the pair / the table is the shot, not a single of whoever spoke last - the banter rules take over at
        // the next step)
        const bs = this.banterSet(ids, vl, true, BANTER_ENTRY);
        if (bs && bs.length >= 2 && !bs.some((id) => !this.live(id))) return;
        // (back to whoever holds the floor - the speaker while they sound, else the voice that sounds now; with someone just starting,
        // the speaker rules take over; else the speaker in a pause between two phrases)
        const sv2 = this.speaker ? this.voices.get(this.speaker) : null;
        const holder = speakerOn(this.speaker) && !!sv2;
        let back = holder && (this.floorHolder === this.speaker || this.now - sv2!.loudAt < 0.4) ? this.speaker : '';
        if (!back) {
          let since = Infinity;
          for (const id of ids) {
            const q = this.voices.get(id)!;
            if (id !== GV && !vl.has(id) && !q.lk && q.runOpen && this.now - q.loudAt < 0.25 && this.now - q.runStart >= REACT_BACK_RUN && q.runStart < since) { back = id; since = q.runStart; }
          }
        }
        if (!back && ids.some((id) => { const q = this.voices.get(id)!; return q.runOpen && this.now - q.runStart < 1.2; })) return;
        if (!back && holder && this.now - sv2!.loudAt < PHRASE_PAUSE) back = this.speaker;
        const w = this.quietWide();
        this.take(back ? { shot: this.single(back), subject: back, secs: 0, why: `back to ${this.name(back)} after the reaction` } : { shot: w, subject: this.subjectFor(w, 21), secs: 0, why: 'back from the reaction: nobody talking' });
        return;
      }
    }
    const v = this.speaker ? this.voices.get(this.speaker) ?? null : null;
    const vOn = !!v && speakerOn(this.speaker);
    // ---- overlap (two talking over each other ≥ 1.2 s): the two-shot, not ping-pong (the hosts among themselves: the
    // hosts two-shot / the panel; with guests only on the monitor: over the host's shoulder towards the screen)
    // (talking over each other = both making sound NOW: a turn's 0.9 s hangover after the last word is not cross-talk —
    // an instant hand-over used to read as an overlap and put the wide up before the new speaker's shot)
    // (a laugh is no cross-talk, and cross-talk needs both voices sounding most of the last second)
    const talking = on.filter((id) => (id !== GV || vl.size > 1) && !this.voices.get(id)!.lk && (vl.has(id) || id === GV || this.now - this.voices.get(id)!.loudAt < 0.6));
    const sustained = (id: string) => vl.has(id) || id === GV || (this.voices.get(id)!.hsum >= ACT_STEPS * 0.6 && this.now - this.voices.get(id)!.loudAt < 0.3);
    // (a clean handover: the last speaker's 0.6 s window is not "talking over" - only a voice sounding right now is)
    const sounding = on.filter((id) => (id !== GV || vl.size > 1) && (vl.has(id) || id === GV || this.now - this.voices.get(id)!.loudAt < 0.25));
    if (!this.floorHolder && this.now - this.laughMode > 0.8 && talking.length >= 2 && talking.every((id) => this.now - this.voices.get(id)!.turnStart > 1.2 && sustained(id)) && held > Math.max(1.2, P.minHold * 0.6) && this.cur.shot !== 'establishing') {
      const desk = talking.every((id) => this.hostSide(id));
      const g = talking.find((id) => /^g\d$/.test(id) || id === GV) ?? '';
      const s: DirectorShot = desk
        ? (talking.length === 2 && talking.includes('host') ? { shot: 'hosts', subject: '', via: talking.find((id) => id !== 'host'), secs: 0, why: 'the hosts talk over each other' } : { shot: 'panel', subject: '', secs: 0, why: 'the desk talks over each other' })
        : talking.length > 2 || (this.opts.guests > 1 && !this.monitorOnly) ? { shot: 'establishing', subject: '', secs: 0, why: 'several people talk at once' }
        : this.monitorOnly && g && talking.includes('host') ? { shot: 'ots', subject: g === GV ? 'g0' : g, secs: 0, why: `the host and ${this.name(g)} talk over each other` }
        : { shot: 'two', subject: this.partner() || 'g0', secs: 0, why: 'two people talk over each other' };
      if (s.shot !== this.cur.shot && this.take(s)) return;
    }
    // ---- a real voice that took the camera from a presumed caller and stopped within RETRACT_TURN s was only an interjection: the
    // presumed caller is back on air (the guess itself returns only after PRESUME s of quiet)
    if (this.guessTake) {
      const gt = this.guessTake, xv = this.voices.get(gt.x);
      if (this.now - gt.at >= RETRACT_WINDOW || this.cur.subject !== gt.x || !xv || (!vl.has(gt.prev) && gt.prev !== GV)) this.guessTake = null;
      else if (this.now - xv.loudAt >= 0.25 && !xv.runOpen && xv.loudAt - xv.turnStart < RETRACT_TURN && !on.some((id) => id !== gt.x && !vl.has(id) && id !== GV)) {
        const pv = gt.prev;
        if (this.take({ shot: this.single(pv), subject: pv, secs: 0, why: `${this.name(pv)} talking (guessed: ${this.name(gt.x)} only interjected)` }, false, true)) {
          this.guessTake = null;
          if (this.log.length > 1) this.log[this.log.length - 2].why = `${this.name(gt.x)} reacts (short interjection)`;
          return;
        }
      }
    }
    // ---- the speaker changed: their shot, once they have really started and the current shot is old enough
    const wide = ['two', 'establishing', 'sidekick', 'wide', 'hosts', 'panel'].includes(this.cur.shot);
    // (a wide / pair shot that already SHOWS the speaker may stay a while; one that doesn't gives way as fast as the handover
    // allows: a clean one needs only MIN_ON / 0.6 minHold of hold)
    const shows = this.featured(this.cur).includes(this.speaker);
    // (a shot that went up before this voice began - a listener's face, an alternate angle - was cut without knowing them: it
    // only has to be on air MIN_ON + 0.3 s; one cut on their own words waits a little longer)
    const fastGeneral = Math.max(MIN_ON, P.minHold * 0.6);
    // (jittered 0.15 s: a pile of cuts at exactly the minimum is a metronome of its own)
    const anticipated = this.speaker === this.expect && this.now < this.expectUntil + 1;
    const fastHold = v && (anticipated || Math.max(v.turnStart, v.runStart) >= this.curAt - 0.1) ? Math.min(MIN_ON + 0.3, fastGeneral) : fastGeneral + 0.15 * this.rnd(54);
    const retract = this.shortTake() && this.speaker === this.fastTake!.prev;
    // (a presumed caller has been waited for PRESUME s already: no further wait for a wide that does not show them)
    const guessNow = vl.has(this.speaker) || this.speaker === GV;
    // (a speaker who has stopped - the hangover of their last word - is not cut to: the cut would arrive after the line)
    const stillTalking = !!v && (vl.has(this.speaker) || this.speaker === GV || this.floorHolder === this.speaker || this.now - v.loudAt < 0.4);
    if (v && vOn && stillTalking && ((this.cur.subject !== this.speaker && !wide) || (wide && (shows ? held > mh * 1.6 : held > (this.fastPending || guessNow ? fastHold : mh * 1.6))))) {
      const talked = this.now - v.turnStart;
      // (only a shot the GUESS rule put up is a guess: an over-the-shoulder / a variety shot that merely shows a voiceless caller
      // is a real shot - treating it as one cut back to the host after 0.6 s, the 0.7 s flash of the VOD analysis)
      const offGuess = this.curGuess && !vl.has(this.speaker) && this.speaker !== GV;
      const guessSpk = vl.has(this.speaker) || this.speaker === GV;
      const need = offGuess || retract ? MIN_ON : this.fastPending || guessNow ? fastHold : mh;
      const lagOk = offGuess ? talked > Math.min(EARLY, Math.max(0.45, P.turnLag * 0.6)) : this.fastPending || talked > P.turnLag;
      if ((lagOk || this.floorHolder === this.speaker) && held > need && ((this.fastPending ? sounding : talking).length < 2 || this.floorHolder)) {
        // guests: their single, sometimes over the host's shoulder; host: single, sometimes the two-shot with the guest the
        // host is talking with
        const r = this.rnd(1);
        let shot: ShotId = this.single(this.speaker);
        let sub = this.speaker;
        let via: string | undefined;
        const pt = this.partner();
        // (an alternate angle is as likely as it is welcome: not the shot of the last 20 s, never one that closes a loop)
        const wl = (sh: ShotId, su: string, vi?: string) => this.welcome({ shot: sh, subject: su, secs: 0, why: '', ...(vi ? { via: vi } : {}) });
        if (this.speaker === 'host' && this.opts.guests && !this.monitorOnly && pt && this.seatedGuest(pt) && r < 0.22 * wl('two', pt)) { shot = 'two'; sub = pt; }
        else if (this.speaker === 'host' && !this.opts.guests && this.co && r < 0.22 * wl('hosts', 'host', this.someCo(10))) { shot = 'hosts'; via = this.someCo(10); }
        else if (/^c\d$/.test(this.speaker) && r < 0.2 * wl('hosts', this.speaker, this.speaker)) { shot = 'hosts'; via = this.speaker; }
        else if (/^g\d$/.test(this.speaker) && this.opts.guests <= 1 && r < 0.3 * wl('ots', this.speaker)) { shot = 'ots'; if (this.co && this.rnd(11) < 0.35) via = this.someCo(12); }
        if (shot === this.prev?.shot && this.now - this.prevLeft < 1.5) { shot = this.single(this.speaker); sub = this.speaker; via = undefined; }
        // (already on that wide: the speaker's own single — re-taking the same shot changed nothing, and the old director
        // returned here every frame: one shot for the rest of the show, the VOD of 2026-10-08)
        if (shot === this.cur.shot && (via ?? '') === (this.cur.via ?? '') && sub === this.cur.subject) { shot = this.single(this.speaker); sub = this.speaker; via = undefined; }
        const nm = this.name(this.speaker);
        const why = this.floorHolder === this.speaker ? `operator: ${nm}'s turn` : guessSpk ? `${nm} talking (guessed: everyone else is quiet)` : retract ? `back to ${nm} after the reaction` : this.fastPending ? `${nm} is talking (handover)` : `${nm} is talking`;
        const wasFast = this.fastPending;
        if (this.take({ shot, subject: sub, secs: 0, why, ...(via ? { via } : {}) }, false, guessSpk)) {
          // (a take that turned out to be a short reaction reads as one: the log says so)
          if (retract && this.fastTake && this.log.length > 1) this.log[this.log.length - 2].why = `${this.name(this.fastTake.x)} reacts (short handover)`;
          // (a clean handover is remembered: a voice that was only a short reaction and the holder's return take it back)
          const fromGuess = (vl.has(this.prevSpeaker) || this.prevSpeaker === GV) && !guessSpk;
          this.fastTake = wasFast && !retract && !guessSpk && !fromGuess ? { x: this.speaker, prev: this.prevSpeaker, at: this.now } : null;
          this.guessTake = wasFast && fromGuess ? { x: this.speaker, prev: this.prevSpeaker, at: this.now } : null;
          this.fastPending = false;
          return;
        }
      }
    }
    // ---- long answer: variety on the same speaker (at a gap between words)
    // (a gap between words; a presumed voice has no words to wait for)
    const breath = !v || v.raw < OFF || vl.has(this.speaker) || this.speaker === GV || held > this.cap(P) + 2.5;
    // ---- a listener's face every STORY_GAP s of a long turn, at a word gap (what the other person thinks - the audience's eyes)
    if (v && v.on && stillTalking && breath && this.opts.reactions && !vl.has(this.speaker) && this.speaker !== GV && this.cur.subject === this.speaker && this.cur.shot === this.single(this.speaker)
      && held > 2.5 && this.now - v.turnStart >= STORY_TURN && this.now - this.lastReact >= this.reactEvery && this.cutsIn(30) < CUT_BUDGET[this.pace]) {
      const pk = this.pickListener(this.listenersOf(this.speaker), 4);
      if (pk) { this.reactionShot(pk.who, 'nod', this.speaker, [], pk.s); return; }
    }
    // (only while they are still making sound — not in the hangover after their last word, when someone else may be
    // taking over)
    if (v && vOn && held > 1.2 && this.cur.subject === this.speaker && (vl.has(this.speaker) || this.speaker === GV || this.floorHolder === this.speaker || this.now - v.loudAt < 0.6) && held > P.maxHold * (0.8 + 0.4 * this.rnd(2)) && this.now - this.lastVariety > mh && this.now - this.lastReact > 6 && breath) {
      if (this.variety(P)) return;
    }
    // ---- a beat of silence after a real turn (the audience laughs, the guest is stunned): a reaction shot
    if (v && !v.on && !vl.has(this.speaker) && this.speaker !== GV && v.burst > 2.5 && !on.length && this.now - v.lastOff > 0.8 && this.now - v.lastOff < 0.8 + dt * 1.5 + 1e-6
      && held > 1.2 && this.opts.reactions && this.now - this.lastReact > mh * 2 && this.rnd(8) < 0.6) {
      const other = this.speaker === 'host' ? (this.someGuest(16) || (this.co ? 'c0' : 'sidekick')) : 'host';
      this.punchline(this.speaker, other);
      return;
    }
    // ---- the think: a question hangs in the air - the person who has to answer, before they speak
    if (this.think(P, ids, vl)) return;
    // ---- quiet: dead air is a wide or a cutaway (the house wide, the jib, the band ...), a new one every few seconds
    const lastSound = Math.max(...ids.map((id) => { const q = this.voices.get(id)!; return q.on ? this.now : q.lastOff; }));
    if (!on.length && !this.floorHolder && this.now - lastSound > DEAD_AIR && held > MIN_ON + 0.3) {
      if (!wideFam(this.cur) || held > DEAD_HOLD[0] + (DEAD_HOLD[1] - DEAD_HOLD[0]) * this.rnd(41)) {
        const s = this.deadAirShot();
        if (s && this.take(s)) return;
      }
    }
    // ---- nothing changed for too long: the next shot that fits (at a gap between words)
    if (held > this.cap(P) && breath) this.rotate(P, vOn);
  }

  /** The beats the studio's events and the show set up: the show opens (the host by crane when the curtain clears), a guest
   *  arrives (the house wide / the two-shot, then their single), the crowd laughs (a reaction of the audience), a big cheer / raid /
   *  gift train (the house applauds), a chat question (the asker's close-up while the host reads it). True = cut. */
  private eventStep(ids: string[], vl: Set<string>): boolean {
    const held = this.now - this.curAt;
    // ---- a guest who just arrived (ready false → true) is shown in: the wide / two-shot, then their single
    for (let i = 0; i < this.opts.guests; i++) {
      const id = `g${i}`, rdy = this.live(id);
      if (this.readyPrev[id] === false && rdy && this.now > 3 && !this.arrive) this.arrive = { id, at: this.now + 0.2, stage: 0 };
      this.readyPrev[id] = rdy;
    }
    // ---- the show opens: the host's single by crane when the curtain starts to clear (too late for it: the beat is gone)
    if (this.openAt > 0 && this.now > this.openBy) this.openAt = -1;
    if (this.openAt > 0 && this.now >= this.openAt) {
      if (this.take({ shot: 'host', subject: 'host', secs: 0, mv: 'crane', why: 'show open: crane in' })) { this.openAt = -1; this.holdFor(CRANE_SECS + 0.3 + 0.4 * this.rnd(52), 'host'); return true; }
      this.openAt = this.now + DIRECTOR_STEP;                  // (a shot younger than MIN_ON is on air: the next step)
    }
    if (this.arrive && this.now >= this.arrive.at) {
      const a = this.arrive;
      if (!this.live(a.id) || this.floorHolder) this.arrive = null;
      else if (held >= MIN_ON) {
        if (a.stage === 0) {
          const pair = this.pairShot('host', a.id, `${this.name(a.id)} arrives`);
          const house = this.cov?.house;
          const shot: DirectorShot = house && this.rnd(47) < 0.5 ? { shot: 'wide', subject: '', secs: 0, why: `${this.name(a.id)} arrives`, cam: house } : pair.shot === 'establishing' ? this.estab(`${this.name(a.id)} arrives`, 47) : pair;
          if (this.take(shot)) { const hold = 2.6 + 0.8 * this.rnd(51); this.holdFor(hold, 'host'); a.stage = 1; a.at = this.now + hold; return true; }
        } else {
          this.arrive = null;
          if (this.take({ shot: this.single(a.id), subject: a.id, secs: 0, why: `${this.name(a.id)} joins the show` })) { this.holdFor(2.1 + 0.8 * this.rnd(53), a.id); return true; }
        }
      }
    }
    // ---- the gift-train montage: the audience's section cameras one after the other (a speaker who takes the floor ends it)
    if (this.montage && this.now >= this.montage.at) {
      const m = this.montage;
      if (this.floorHolder || !this.reacting || !m.steps.length) this.montage = null;
      else {
        const s = m.steps.shift()!;
        if (this.take(s, true)) { const step = MONTAGE_STEP * (0.85 + 0.35 * this.rnd(57)); this.holdFor(step, this.speaker || 'host'); m.at = this.now + step; if (!m.steps.length) this.montage = null; return true; }
      }
    }
    // ---- "the take": the crowd laughed, the teller says nothing - the host's snap zoom for a moment (rare: SNAP_GAP apart)
    if (this.takeFrom > 0 && this.now >= this.takeFrom) {
      const hv = this.voices.get('host');
      const sounding = ids.some((id) => { const q = this.voices.get(id)!; return q.runOpen && id !== GV && !vl.has(id); });
      if (this.now > this.takeUntil || this.floorHolder || sounding) this.takeFrom = -1;
      else if (hv && this.now - hv.loudAt >= TAKE_QUIET && this.opts.snaps && this.opts.reactions && this.now - this.lastSnap >= SNAP_GAP && held >= MIN_ON) {
        this.takeFrom = -1;
        if (this.take({ shot: 'snap', subject: 'host', secs: 0.2, why: 'the take: the host after the laugh' })) { this.lastSnap = this.now; this.reacting = { until: this.now + TAKE_HOLD, max: this.now + TAKE_HOLD, back: 'host', kind: 'snap', ids: [] }; return true; }
      }
    }
    if (!this.evq.length) return false;
    this.evq = this.evq.filter((q) => q.until > this.now);
    if (this.floorHolder) { this.evq = []; return false; }
    const sv = this.speaker ? this.voices.get(this.speaker) ?? null : null;
    const talking = !!sv && sv.on && !vl.has(this.speaker) && this.speaker !== GV;
    const turnAge = talking ? this.now - sv!.turnStart : Infinity;
    for (let i = 0; i < this.evq.length; i++) {
      const q = this.evq[i], e = q.e;
      if (q.at > this.now) continue;
      if (e.kind === 'buzz') {
        // (G1: a buzz is the beat - the contestant's single at the next fixed step, whatever shot was young; someone who is not a guest on the show is no buzz)
        this.evq.splice(i--, 1);
        if (this.readyGuests.includes(e.id) && this.take({ shot: this.single(e.id), subject: e.id, secs: 0, why: `buzz-in: ${this.name(e.id)}` }, true)) { this.holdFor(1.5, e.id); return true; }
        continue;
      }
      if (held < MIN_ON) continue;
      if (e.kind === 'ask') { this.evq.splice(i--, 1); if (this.askShot(e.key)) return true; continue; }
      if (e.kind === 'reveal' || e.kind === 'win' || e.kind === 'lose' || e.kind === 'clock') { this.evq.splice(i--, 1); continue; }   // (the game set's rules: not in this lane)
      if (e.kind === 'laughWave') {
        if (this.now - this.lastCrowd < CROWD_GAP) { this.evq.splice(i--, 1); continue; }
        // (the chat laughs at a LINE: nothing was said within 3 s - it laughs at something else)
        const lastLine = Math.max(...ids.map((id) => { const v = this.voices.get(id)!; return v.runOpen ? this.now : v.loudAt; }));
        if (this.now - lastLine > 3) { this.evq.splice(i--, 1); continue; }
        if (this.reactionBlocks() || turnAge < TURN_QUIET) continue;
        this.evq.splice(i--, 1);
        if (this.crowdLaugh()) return true;
        continue;
      }
      if (e.kind === 'alert') {
        if (e.what === 'montage') {
          if (this.now - this.lastMontage < MONTAGE_GAP || !this.audience) { this.evq.splice(i--, 1); continue; }
          if (this.reactionBlocks() || turnAge < TURN_QUIET) continue;
          this.evq.splice(i--, 1);
          if (this.startMontage()) return true;
          continue;
        }
        if (this.now - this.lastAlert < ALERT_ANY || this.now - (this.lastAlertKind[e.what] ?? -99) < ALERT_GAP) { this.evq.splice(i--, 1); continue; }
        if (this.reactionBlocks() || turnAge < TURN_QUIET) continue;
        this.evq.splice(i--, 1);
        if (this.applause(e)) return true;
      }
    }
    return false;
  }

  /** A reaction on air that the crowd's cut must wait for: a laugh, another crowd shot - not a plain listener's face (a filler nod
   *  gives way to a cheer). */
  private reactionBlocks(): boolean {
    return !!this.reacting && !(this.reacting.kind === 'nod' && /listening \(reaction\)/.test(this.cur.why));
  }

  /** A reaction cutaway of `secs` s that gives way to whoever talks (the generic reaction end takes it from there). */
  private holdFor(secs: number, back: string) { this.reacting = { until: this.now + secs, max: this.now + secs, back, kind: 'nod', ids: [] }; }

  /** Several chatters laughed: the audience (a section camera, the crowd's reaction), else the sidekick, else a listener. */
  private crowdLaugh(): boolean {
    const spk = this.speaker || 'host';
    const dur = CROWD_HOLD[0] + (CROWD_HOLD[1] - CROWD_HOLD[0]) * this.rnd(44);
    let took = false;
    if (this.audience) {
      const secs = this.opts.coverage!.sections;
      const cam = secs.length && this.rnd(42) < 0.6 ? secs[Math.floor(this.rnd(43) * secs.length)] : '';
      took = this.take({ shot: 'wide', subject: '', secs: 0, aud: 'r', ...(cam ? { cam } : {}), why: 'the crowd laughs' });
    } else if (this.opts.sidekick && this.opts.reactions) {
      took = this.take({ ...this.sideShot('the crowd laughs: the sidekick plays along') });
    } else if (this.opts.reactions) {
      const pk = this.pickListener(this.listenersOf(spk), 48);
      if (pk) took = this.take({ ...pk.s, why: `the crowd laughs: ${this.name(pk.who)} reacts` });
    }
    if (!took) return false;
    this.holdFor(dur, spk);
    this.lastCrowd = this.lastReact = this.now;
    // ("the take": if the teller is silent when the crowd's reaction is over, the camera finds them)
    this.takeFrom = this.now + dur + 0.1; this.takeUntil = this.takeFrom + 2.5;
    if (this.opts.sidekick) this.beat('sidekick', 'laugh');
    try { this.onCrowd?.('laugh', 1); } catch { /* optional */ }
    return true;
  }

  /** A big cheer / a raid / a gift train / applause: the house applauds - the audience wide (or the house wide), dollying back. */
  private applause(e: Extract<DirectorEvent, { kind: 'alert' }>): boolean {
    // (the audience or the house wide - the other one from last time: two alerts in a row are not the same shot twice)
    const cov = this.cov, useAud = this.audience && (!cov?.house || (this.lastApplauseAud === null ? this.rnd(45) < 0.6 : !this.lastApplauseAud));
    const what = e.what === 'cheer' ? 'a big cheer' : e.what === 'raid' ? 'a raid' : e.what === 'gifts' ? 'a gift train' : 'applause';
    const shot: DirectorShot = { shot: 'wide', subject: '', secs: 0, mv: 'pull', ...(useAud ? { aud: 'w' as const } : cov?.house ? { cam: cov.house } : {}), why: `${what}: the house applauds` };
    if (!this.take(shot)) return false;
    this.holdFor(ALERT_HOLD[0] + (ALERT_HOLD[1] - ALERT_HOLD[0]) * this.rnd(49), this.speaker || 'host');
    this.lastAlert = this.lastReact = this.now; this.lastAlertKind[e.what] = this.now; this.lastApplauseAud = !!shot.aud;
    try { this.onCrowd?.('applause', e.size); } catch { /* optional */ }
    return true;
  }

  /** A gift train of ten: two or three of the audience's section cameras, MONTAGE_STEP s each (the applause shot came with the 5th
   *  gift); once per MONTAGE_GAP s. */
  private startMontage(): boolean {
    const secs = this.opts.coverage?.sections ?? [];
    const n = Math.min(3, Math.max(secs.length ? 1 : 0, 2 + (this.rnd(55) < 0.5 ? 1 : 0)));
    const picks: string[] = [];
    for (let k = 0; picks.length < Math.min(n, secs.length) && k < 12; k++) { const c = secs[Math.floor(this.rnd(56 + k) * secs.length)]; if (!picks.includes(c)) picks.push(c); }
    const steps: DirectorShot[] = (picks.length ? picks : ['']).map((cam) => ({ shot: 'wide' as ShotId, subject: '', secs: 0, aud: 'r' as const, ...(cam ? { cam } : {}), why: 'gift train montage: the crowd' }));
    const first = steps.shift()!;
    if (!this.take(first, true)) return false;
    const step = MONTAGE_STEP * (0.85 + 0.35 * this.rnd(57));
    this.holdFor(step, this.speaker || 'host');
    this.lastMontage = this.lastAlert = this.lastReact = this.now;
    this.montage = steps.length ? { steps, at: this.now + step } : null;
    try { this.onCrowd?.('applause', 3); } catch { /* optional */ }
    return true;
  }

  /** "Answer now" on a chat question: the asker's close-up while the host reads it, then the host (the cut that follows names the
   *  guest it is for - setExpect). */
  private askShot(key: string): boolean {
    if (!this.audience || this.manualUntil > this.now) return false;
    const prev = this.reacting;
    this.reacting = null;
    if (!this.take({ shot: 'wide', subject: '', secs: 0, aud: 'a', ak: key, why: 'question from chat' })) { this.reacting = prev; return false; }
    this.holdFor(ASK_HOLD[0] + (ASK_HOLD[1] - ASK_HOLD[0]) * this.rnd(50), 'host');
    this.lastReact = this.now;
    try { this.onCrowd?.('ask', 1); } catch { /* optional */ }
    return true;
  }

  /** "The think": the host asked and nobody has said a word for PACE.think s - the camera goes to the person who has to answer
   *  (before they speak), then pushes in slowly while they stay quiet. At most once per THINK_GAP s. */
  private think(P: (typeof PACE)[Pace], ids: string[], vl: Set<string>): boolean {
    const e = this.expect;
    if (!e || !/^g\d$/.test(e) || this.now >= this.expectUntil || !this.live(e) || this.floorHolder) return false;
    if (ids.some((id) => { const q = this.voices.get(id)!; return q.runOpen && id !== GV && !vl.has(id); })) return false;
    const sv = this.speaker ? this.voices.get(this.speaker) ?? null : null;
    const quiet = sv ? this.now - sv.loudAt : 0;
    // (the silence is dead air from DEAD_AIR s: the wide takes it; a question that hangs that long has been answered by the pause)
    if (!sv || quiet < P.think || quiet > DEAD_AIR - 1) return false;
    // (a question is short: a long turn that pauses is a monologue waiting for its laugh, and the camera stays on the teller - unless
    // a chat question named the guest it is for: that read can be long, and they are the one who has to answer)
    const asked = !!this.askAddr && e === this.askAddr && this.now < this.askUntil;
    if (!asked && (this.lastTurnLen > THINK_TURN || this.now - this.lastReact < 5 || this.now - this.lastCrowd < 5)) return false;
    if (this.featured(this.cur).includes(e)) {
      // (already on them: a slow push-in while the silence lasts - from their own single only, once per subject per PUSH_GAP s)
      const own = this.cur.subject === e && this.cur.shot === this.single(e);
      // (and only with room before the dead-air wide takes over at DEAD_AIR s: a push-in cut after a second is no push-in)
      if (this.opts.pushIns && own && quiet >= P.think + 1.5 && quiet + 2.5 < DEAD_AIR && this.now - (this.lastPush[e] ?? -999) >= PUSH_GAP && this.take({ shot: 'push', subject: e, secs: 6.5, why: `the think: ${this.name(e)} is about to answer (a slow push-in)` })) { this.lastPush[e] = this.now; return true; }
      return false;
    }
    if (!asked && this.now - this.lastThink < THINK_GAP) return false;
    if (!this.take({ shot: this.single(e), subject: e, secs: 0, why: asked ? `the think: ${this.name(e)} to answer the question from chat` : `the think: waiting for ${this.name(e)}` })) return false;
    this.lastThink = this.now;
    return true;
  }

  /** The lines of the last BANTER_WINDOW s (finished runs + the ones sounding now; a speaker's sentences < BANTER_JOIN s apart are
   *  one line), oldest first. */
  private bantLines(ids: string[], vl: Set<string>, openOk = true): { who: string; t0: number; t1: number }[] {
    // (all the remembered runs are merged first: a long monologue is one long line, however much of it is in the window)
    // (laughs and interjections are no lines of banter)
    const raw = this.runs.filter((r) => !r.lk).map((r) => ({ who: r.who, t0: r.t0, t1: r.t1 }));
    for (const id of openOk ? ids : []) {
      const v = this.voices.get(id)!;
      // (a voice joining a banter in progress is noticed after 0.15 s: the table shows them as they start)
      const minRun = this.banter && !this.banter.set.includes(id) ? 0.15 : 0.3;
      if (v.runOpen && id !== GV && !vl.has(id) && this.live(id) && !v.lk && v.loudAt - v.runStart >= minRun) raw.push({ who: id, t0: v.runStart, t1: v.loudAt });
    }
    raw.sort((a, b) => a.t0 - b.t0 || (a.who < b.who ? -1 : 1));
    const out: typeof raw = [];
    for (const l of raw) {
      const last = out[out.length - 1];
      if (last && last.who === l.who && l.t0 - last.t1 < BANTER_JOIN) last.t1 = Math.max(last.t1, l.t1); else out.push(l);
    }
    return out.filter((l) => l.t1 >= this.now - BANTER_WINDOW);
  }

  /** The people trading lines right now (null = not banter): the trailing chain of BANTER_ALT+ hand-overs, each line short. */
  private banterSet(ids: string[], vl: Set<string>, openOk = true, maxLine = BANTER_LINE): string[] | null {
    if (this.now - this.guessAt < 6) return null;
    const L = this.bantLines(ids, vl, openOk);
    let n = 1;
    while (n < L.length && L[L.length - 1 - n].who !== L[L.length - n].who) n++;
    if (n < BANTER_ALT + 1) return null;
    const chain = L.slice(L.length - n);
    // (the line that STARTED the exchange - the host's question - may be as long as it likes; the answers must be short)
    if (chain.slice(1).some((l) => l.t1 - l.t0 > maxLine) || this.now - chain[1].t0 > BANTER_WINDOW) return null;
    return [...new Set(chain.map((l) => l.who))];
  }

  /** Rapid banter (see BANTER_*): enter on a chain of short hand-overs, hold the shot of the people trading lines, leave on a
   *  long line (that speaker's own shot at once) or after BANTER_QUIET s without one. True = the step is taken. */
  private banterStep(P: (typeof PACE)[Pace], ids: string[], vl: Set<string>, held: number): boolean {
    if (this.floorHolder) { this.banter = null; return false; }
    // (banter STARTS only on short lines, BANTER_ENTRY s: a 3 s line is a question, and the first 0.6 s of the answer that follows it
    // may turn out to be a long one)
    const set = this.banterSet(ids, vl, true, this.banter ? BANTER_LINE : BANTER_ENTRY);
    if (!this.banter) {
      if (!set || set.length < 2 || set.some((id) => !this.live(id))) return false;
      this.banter = { set, since: this.now, alt: false };
    } else if (set) {
      this.banter.set = set;
    } else {
      // (still banter while a short line follows; over on a long line - the speaker's own shot - or a pause)
      const lastSound = Math.max(...ids.map((id) => { const q = this.voices.get(id)!; return q.runOpen ? this.now : q.loudAt; }));
      const long = ids.find((id) => { const q = this.voices.get(id)!; return q.runOpen && !q.lk && id !== GV && !vl.has(id) && q.loudAt - q.runStart > BANTER_LINE; });
      if (long) { this.banter = null; this.take({ shot: this.single(long), subject: long, secs: 0, why: `${this.name(long)} is talking` }); return true; }
      if (this.now - lastSound > BANTER_QUIET) { this.banter = null; return false; }
    }
    const b = this.banter;
    const people = b.set;
    // the cap: a long banter shows something else for a moment (the whole table / the last two speakers), then the people again
    const L = this.bantLines(ids, vl);
    const last2 = [...new Set(L.slice().reverse().map((l) => l.who))].slice(0, 2);
    const table: DirectorShot = this.estab('banter: the whole table', 36);
    // (the break: the whole table - it shows everyone trading lines; a break to one face would lose the other)
    const breaks: DirectorShot[] = [table];
    const onAlt = b.alt && this.cur.why.startsWith('banter:');
    if (!onAlt && held > P.cap * 0.9) {
      // (no welcome break - the table was on air a moment ago: the cap is due anyway, so another angle on the pair will do)
      const pg = people.find((id) => /^g\d$/.test(id));
      const spare: DirectorShot[] = people.length === 2 ? (people.includes('host') && pg && !this.opts.cohosts ? [{ shot: 'ots', subject: pg, secs: 0, why: 'banter: another angle' }, { shot: 'reverse', subject: 'host', secs: 0, why: 'banter: another angle' }] : [])
        : [this.pairShot(last2[0] ?? people[0], last2[1] ?? people[1], 'banter: the last two')];
      const bk = this.pickShot(breaks.map((x) => ({ s: x })), 37) ?? this.pickShot([...breaks, ...spare].map((x) => ({ s: x })), 38, held > P.cap);
      if (bk && this.take(bk)) { b.alt = true; return true; }
    }
    if (onAlt && held < 3.2 + 0.8 * this.rnd(36)) return true;
    b.alt = onAlt && held < 3.2 ? true : false;
    const s = people.length === 2 ? this.pairShot(people[0], people[1], `rapid banter: ${this.name(people[0])} and ${this.name(people[1])}`) : this.sharedShot(people, 'rapid banter: the whole table');
    const same = s.shot === this.cur.shot && s.subject === this.cur.subject && (s.via ?? '') === (this.cur.via ?? '');
    if (!same) this.take(s);
    // (a banter is not interrupted by anything else - the fast path, the variety, the cap - but the people in it may change)
    return true;
  }

  /** A line (a run of sound) of a real voice ended: remembered if it was a real line; the floor holder's long turn pausing
   *  sets who we expect to answer. */
  private lineEnded(id: string, v: Voice) {
    if (id === this.speaker) this.lastTurnLen = v.loudAt - v.turnStart;
    if (v.loudAt - v.runStart >= RUN_MIN) { this.runs.push({ who: id, t0: v.runStart, t1: v.loudAt, ...(v.lk ? { lk: true } : {}) }); if (this.runs.length > 8) this.runs.shift(); }
    if (id === this.speaker && v.loudAt - v.turnStart >= EXPECT_TURN) this.setExpect(id);
  }

  /** After a long turn of `from`: who will answer. The host: the only guest on the show, else the last guest who held the
   *  floor (30 s); a guest or a co-host: the host. */
  private setExpect(from: string) {
    let e = '';
    if (from === 'host' && this.askAddr && this.now < this.askUntil && this.live(this.askAddr)) e = this.askAddr;     // (the chat question's guest)
    else if (from === 'host' || /^c\d$/.test(from)) {
      const gs = this.readyGuests;
      if (gs.length === 1) e = gs[0];
      else if (this.lastGuest.id && this.now - this.lastGuest.at < 30 && gs.includes(this.lastGuest.id)) e = this.lastGuest.id;
    } else e = 'host';
    this.expect = e; this.expectUntil = this.now + EXPECT_FOR;
  }

  /** The fast cut on air landed on a voice that was only a short reaction (it stopped within RETRACT_TURN s) and the holder it
   *  took the floor from is the speaker again. */
  private shortTake(): boolean {
    const ft = this.fastTake;
    if (!ft || this.speaker !== ft.prev && this.speaker !== ft.x || this.cur.subject !== ft.x || this.now - ft.at >= RETRACT_WINDOW) return false;
    const xv = this.voices.get(ft.x);
    return !!xv && this.now - xv.loudAt >= 0.1 && xv.loudAt - xv.turnStart < RETRACT_TURN;
  }

  /** The talk time (s) after which `id` takes the floor when the handover is clean or expected; Infinity = contested (turnLag). */
  private fastLag(id: string, on: string[], P: (typeof PACE)[Pace]): number {
    const q = this.voices.get(id)!;
    const p = this.speaker ? this.voices.get(this.speaker) ?? null : null;
    // the holder's turn resumes after a short reaction of the one we cut to
    if (id === this.fastTake?.prev && this.shortTake()) return P.fast;
    // (the one who took the floor this way keeps it while they talk)
    if (id === this.speaker) return this.speakerFast ? P.fast : Infinity;
    // a third voice sounding (even one that started a moment ago and is not `on` yet): contested
    for (const [o, ov] of this.voices) if (o !== id && o !== this.speaker && ov.runOpen && this.now - ov.loudAt < HANDOVER_GAP) return Infinity;
    if (!p) return P.fast;
    // the newcomer started over the holder: contested
    if (Math.max(q.turnStart, q.runStart) < p.loudAt - 0.1) return Infinity;
    const quiet = this.now - p.loudAt;
    if (this.expect === id && this.now < this.expectUntil && quiet >= DIRECTOR_STEP) return P.fast * (id === this.askAddr && this.now < this.askUntil ? ASKED : ANTICIPATE);
    if (quiet >= HANDOVER_GAP && p.loudAt - p.turnStart >= HANDOVER_PREV) return P.fast;
    return Infinity;
  }

  /** Who a shot is about: the single's person, an over-the-shoulder's target, both people of a pair shot; a wide shows
   *  nobody in particular. */
  private featured(s: DirectorShot): string[] {
    const g = (x: string | undefined): x is string => !!x && /^g\d$/.test(x);
    switch (s.shot) {
      case 'host': case 'reverse': return ['host'];
      case 'sidekick': return ['sidekick'];
      case 'push': case 'snap': return [s.subject || 'host'];
      case 'ots': return [s.subject];
      case 'two': return g(s.subject) && g(s.via) ? [s.subject, s.via] : ['host', ...(g(s.subject) ? [s.subject] : [])];
      case 'hosts': return ['host', s.via || 'c0'];
      case 'panel': return ['host', ...Array.from({ length: this.co }, (_, i) => `c${i}`)];
      case 'establishing': case 'wide': return [];
      default: return s.subject === GV ? this.voiceless() : s.subject ? [s.subject] : [];
    }
  }

  /** On the monitor (a call-in / a panel) or seated in the room. */
  private seatedGuest(id: string): boolean {
    const m = this.opts.monitor;
    if (m) return !m.includes(id);
    const n = this.opts.seated ?? (this.opts.layout === 'seated' ? this.opts.guests : 0);
    return +id.slice(1) < n;
  }

  /** The guest the host is talking with: the one we expect, else the last guest who held the floor (45 s), else the only
   *  guest on the show. '' = nobody in particular (two or more guests and none has talked yet - no two-shot then: it would
   *  always be host + Guest 1), or no guests. */
  private partner(): string {
    const e = this.expect && /^g\d$/.test(this.expect) && this.now < this.expectUntil ? this.expect : '';
    for (const c of [e, this.lastGuest.id && this.now - this.lastGuest.at < 45 ? this.lastGuest.id : '']) if (c && this.live(c) && +c.slice(1) < this.opts.guests) return c;
    const gs = this.readyGuests;
    return gs.length === 1 ? gs[0] : '';
  }

  /** The subject of a wide for a quiet moment / a reaction ending: the two-shot's partner, the over-the-shoulder's guest. */
  private subjectFor(w: ShotId, k: number): string {
    if (w === 'two') return this.partner();
    if (w === 'ots') return this.someGuest(k);
    return '';
  }

  /** The wide for a quiet moment: the two-shot (a seated guest) / the hosts / the establishing wide — with guests only on
   *  the monitor, the establishing wide at most every ~40 s, else over the host's shoulder towards the screen. */
  private quietWide(): ShotId {
    const r = this.rnd(5);
    // (the two-shot of the host with the guest they talk with - a call-in is no two-shot: the screen would be edge-on)
    // (two or more guests: no host + guest-1 two-shot in the silence - the table, or the house)
    if (this.opts.guests > 1 && !this.monitorOnly) return 'establishing';
    if (this.opts.guests && !this.monitorOnly) {
      const pt = this.partner();
      const wTwo = pt && this.seatedGuest(pt) ? 0.55 * this.welcome({ shot: 'two', subject: pt, secs: 0, why: '' }) : 0, wEst = 0.45 * this.welcome({ shot: 'establishing', subject: '', secs: 0, why: '' });
      return r * (wTwo + wEst) < wTwo ? 'two' : 'establishing';
    }
    if (!this.opts.guests && this.co) return r < 0.5 ? (this.co > 1 ? 'panel' : 'hosts') : 'establishing';
    if (this.monitorOnly && this.readyGuests.length && this.now - this.lastWide < 40) return 'ots';
    return 'establishing';
  }

  /** The cuts in the last `secs` s (from the log). */
  private cutsIn(secs: number): number { let n = 0; for (let i = this.log.length - 1; i >= 0 && this.log[i].t >= this.now - secs; i--) n++; return n; }

  /** Long answer: a push-in, a listener's face, or the alternate angle (true = cut). `force` = the cap is due: a repeat will do
   *  when no angle is welcome; else no cut - the speaker's shot stays. */
  private variety(P: (typeof PACE)[Pace], force = false): boolean {
    this.lastVariety = this.now;
    // (a cut rate a viewer can follow: when the last 30 s already had CUT_BUDGET cuts, the optional ones wait - the cap still moves on)
    if (!force && this.cutsIn(30) >= CUT_BUDGET[this.pace]) return false;
    const r = this.rnd(3), spk = this.speaker;
    // a slow push-in: from the speaker's own single, not right after a laugh, once per speaker per PUSH_GAP s
    const own = this.cur.subject === spk && this.cur.shot === this.single(spk);
    const turnLen = this.voices.get(spk) ? this.now - this.voices.get(spk)!.turnStart : 0;
    if (this.opts.pushIns && own && !this.banter && turnLen >= 8 && this.now - (this.lastPush[spk] ?? -999) >= PUSH_GAP && this.now - this.lastReact >= 10 && r < 0.45) {
      if (this.take({ shot: 'push', subject: spk, secs: 6.5, why: `long answer from ${this.name(spk)}: a slow push-in` })) { this.lastPush[spk] = this.now; return true; }
    }
    if (this.opts.reactions && this.now - this.lastReact >= this.reactEvery && r < 0.78) {
      const pk = this.pickListener(this.listenersOf(spk), 4);
      if (pk) { this.reactionShot(pk.who, 'nod', spk, [], pk.s); return true; }
    }
    // the host's other angles: over their shoulder towards the guest's screen (a caller still connecting too: "we're
    // waiting for them"), the two-shot with a seated guest, the desk, the wide, the guest's view of the host
    const pt = this.partner();
    const hostAlts: ShotId[] = [...(this.opts.guests ? ['ots' as ShotId] : []), ...(this.opts.guests && !this.monitorOnly && pt && this.seatedGuest(pt) ? ['two' as ShotId] : []), ...(this.co ? ['hosts' as ShotId] : []), 'establishing', 'reverse'];
    const fresh = hostAlts.filter((x) => x !== this.cur.shot && x !== this.prev?.shot);
    const shotOf = (x: ShotId): DirectorShot => {
      if (x === 'establishing') return this.estab(`long answer from ${this.name(spk)}: another angle`, 23);
      const via = x === 'hosts' ? (/^c\d$/.test(spk) ? spk : this.someCo(15)) : undefined;
      const sub = x === 'ots' && (spk === 'host' || spk === GV) ? (spk === GV ? 'g0' : this.someGuest(17) || 'g0') : x === 'two' && spk === 'host' ? this.partner() || 'g0' : spk;
      return { shot: x, subject: sub, secs: 0, why: `long answer from ${this.name(spk)}: another angle`, ...(via ? { via } : {}) };
    };
    // (the angles: weighted by how welcome each is after the last 8 shots - the host's, a guest's, a co-host's)
    const guestAlts = (): ShotId[] => {
      const alts: ShotId[] = [];
      if (this.opts.guests <= 1 || spk === GV) alts.push(this.cur.shot === 'ots' ? 'guest' : 'ots');
      else alts.push(this.monitorOnly || !this.seatedGuest(spk) ? 'ots' : 'two', ...(this.cur.subject === spk && this.cur.shot !== 'ots' ? ['ots' as ShotId] : []));
      if (spk !== GV && this.opts.guests === 1 && !this.monitorOnly && this.seatedGuest(spk)) alts.push('two');
      if (this.cur.shot !== this.single(spk)) alts.push(this.single(spk));
      return [...new Set(alts)];
    };
    const pool = fresh.length ? fresh : hostAlts;
    const cands: DirectorShot[] = spk === 'host' ? pool.map(shotOf) : /^c\d$/.test(spk) ? [shotOf(this.co > 1 && this.cur.shot === 'hosts' ? 'panel' : 'hosts')] : guestAlts().map(shotOf);
    // (the wide family within its budget; a b-roll cutaway now and then - the room's other cameras)
    const wk = (x: DirectorShot) => ({ s: x, w: wideFam(x) && !this.wideOk() ? 0.25 : 1 });
    const pickFrom = [...cands.map(wk), ...this.cutaways().map((x) => ({ s: x, w: this.wideOk() ? 0.6 : 0.15 }))];
    const alt: DirectorShot | null = this.pickShot(pickFrom, 22) ?? (force ? this.pickShot(cands.map((x) => ({ s: x })), 22, true) : null);
    if (!alt) return false;
    if (this.take(alt)) return true;
    if (!force) return false;
    return this.take({ shot: this.single(spk) === this.cur.shot ? (spk === 'host' ? 'reverse' : 'ots') : this.single(spk), subject: spk === GV ? 'g0' : spk, secs: 0, why: `long answer from ${this.name(spk)}: another angle` });
  }

  /** A listener's face: their single - or, when they were on air as the speaker less than ALT_RECENT s ago (or are now), the other
   *  angle on them (the host: over the guest's shoulder; a guest: over the host's; a co-host: the desk two-shot). */
  private listenShot(who: string): DirectorShot {
    const single: DirectorShot = { shot: who === 'sidekick' ? 'sidekick' : this.single(who), subject: who, secs: 0, why: '' };
    if (who === 'sidekick') return this.sideShot('');
    const k = shotKey(single);
    const recent = this.mem.some((m) => m.key === k && (m.end === 0 || this.now - m.end < ALT_RECENT));
    if (!recent) return single;
    if (who === 'host') return { shot: 'reverse', subject: 'host', secs: 0, why: '' };
    if (/^c\d$/.test(who)) return { shot: 'hosts', subject: 'host', via: who, secs: 0, why: '' };
    return { shot: 'ots', subject: who, secs: 0, why: '' };
  }
  /** One of `who` to show listening (weighted by how welcome the shot is); null = every one would repeat. */
  private pickListener(who: string[], k: number): { who: string; s: DirectorShot } | null {
    const c = who.map((l) => ({ l, s: this.listenShot(l) }));
    const s = this.pickShot(c.map((x) => ({ s: x.s })), k);
    return s ? { who: c.find((x) => x.s === s)!.l, s } : null;
  }

  /** Who can give a listening reaction to `spk` (on the show, not the speaker). */
  private listenersOf(spk: string): string[] {
    const out: string[] = [];
    if (spk !== 'host') out.push('host');
    for (let i = 0; i < this.co; i++) if (`c${i}` !== spk) out.push(`c${i}`);
    // (a guest's face on the monitor reacting: only callers we can see — the voiceless ones too, they listen)
    for (const g of this.readyGuests) if (g !== spk && spk !== GV) out.push(g);
    // (nobody else on the show yet — a guest still connecting: the sidekick listens along)
    if (!out.length && this.opts.sidekick) out.push('sidekick');
    return out;
  }

  /** Nothing changed for `cap` s: cut to the next shot that fits the moment. */
  private rotate(P: (typeof PACE)[Pace], speakerTalking: boolean) {
    const spk = this.speaker;
    if (speakerTalking && spk) {
      if (this.cur.subject !== spk && !['two', 'ots'].includes(this.cur.shot)) { if (this.take({ shot: this.single(spk), subject: spk, secs: 0, why: `held ${Math.round(this.now - this.curAt)} s: back to ${this.name(spk)}` })) return; }
      // (the same wait as a long answer's variety: not while the speaker is only in the fade after their last word —
      // someone else may be taking over)
      const sv = this.voices.get(spk);
      const sounding = this.voiceless().includes(spk) || spk === GV || this.floorHolder === spk || (!!sv && this.now - sv.loudAt < 0.6);
      if (sounding && this.variety(P, true)) return;
    }
    // quiet (or nothing else worked): the next of host single / the guest's screen / the wide / the sidekick
    const g = this.someGuest(18);
    const cands: DirectorShot[] = [
      { shot: 'host', subject: 'host', secs: 0, why: 'quiet: the host' },
      ...(g ? [{ shot: this.single(g), subject: g, secs: 0, why: `quiet: ${this.name(g)} on the screen` } as DirectorShot] : []),
      ...(this.monitorOnly && g ? [{ shot: 'ots' as ShotId, subject: g, secs: 0, why: 'quiet: over the host\'s shoulder' }] : []),
      ...(this.co ? [{ shot: 'hosts' as ShotId, subject: '', via: this.someCo(19), secs: 0, why: 'quiet: the desk' }] : []),
      ...[this.quietWide()].map((w) => ({ shot: w, subject: w === 'ots' ? g : w === 'two' ? this.partner() : '', secs: 0, why: 'quiet: the wide' }) as DirectorShot),
      ...(this.opts.sidekick ? [this.sideShot('quiet: the sidekick')] : []),
      ...(this.opts.pushIns && this.cur.shot === 'host' && this.now - (this.lastPush.host ?? -999) >= PUSH_GAP ? [{ shot: 'push' as ShotId, subject: 'host', secs: 6.5, why: 'quiet: a slow push-in on the host' }] : []),
    ];
    // (the room's other cameras: the house wide and the b-roll cutaways, within the wide budget)
    const house = this.cov?.house;
    if (house) cands.push({ shot: 'wide', subject: '', secs: 0, why: 'quiet: the house wide', cam: house });
    cands.push(...this.cutaways().map((x) => ({ ...x, why: 'cutaway: the room' })));
    const fresh = cands.filter((c) => shotKey(c) !== shotKey(this.cur) && shotKey(c) !== (this.prev ? shotKey(this.prev) : ''));
    const pool = fresh.length ? fresh : cands.filter((c) => shotKey(c) !== shotKey(this.cur));
    if (!pool.length) return;
    const ok = this.wideOk();
    const pick = this.pickShot(pool.map((x) => ({ s: x, w: wideFam(x) && !ok ? 0.25 : /^cutaway/.test(x.why) ? 0.6 : 1 })), 20, true) ?? pool[Math.floor(this.rnd(20) * pool.length)];
    if (this.take({ ...pick, why: `held ${Math.round(this.now - this.curAt)} s, ${pick.why}` }) && pick.shot === 'push') this.lastPush.host = this.now;
  }

  /** A beat of silence after a real turn (the audience laughs, the guest is stunned - nothing we can hear): a listener reacts. */
  private punchline(teller: string, reactor: string) {
    if (this.opts.sidekick && teller !== 'sidekick' && this.rnd(7) < 0.4) { this.reactionShot('sidekick', 'nod', teller); return; }
    const who = reactor === 'sidekick' ? 'host' : reactor;
    // (already on them: the sidekick plays along instead of a jump cut on the same face)
    if (who === this.cur.subject) { if (this.opts.sidekick) this.reactionShot('sidekick', 'nod', teller); return; }
    this.reactionShot(who, 'nod', teller);
  }

  /** A reaction cutaway: `who`'s face (a laugh: held while `ids` still sound, REACT_MIN…REACT_MAX s; a nod: P.react-ish). */
  private reactionShot(who: string, kind: 'laugh' | 'nod', back: string, ids: string[] = [], on?: DirectorShot) {
    this.lastReact = this.now;
    this.reactEvery = STORY_GAP[0] + (STORY_GAP[1] - STORY_GAP[0]) * this.rnd(40);
    const sh = on ?? this.listenShot(who);
    // (a burst that starts like an answer: "reacts" until its length tells - a laugh stays a reaction, an answer becomes the turn)
    const took = this.take({ shot: sh.shot, subject: sh.subject, secs: 0, why: kind === 'laugh' ? `${this.name(who)} reacts` : `${this.name(who)} listening (reaction)`, ...(sh.via ? { via: sh.via } : {}), ...(sh.cam ? { cam: sh.cam } : {}) });
    if (kind === 'laugh' && took && ids.length === 1) this.pendingLaugh = { id: who, runStart: this.voices.get(who)?.runStart ?? -1, n: this.cuts };
    this.holdReaction(kind, back, ids);
    if (took || kind === 'laugh') this.beat(who, kind);
  }

  /** Name the cut on air once it is known what the burst was (the reason is read out in the studio and logged). */
  private relabel(n: number, why: string) {
    if (this.cuts !== n) return;
    this.cur = { ...this.cur, why };
    if (this.log.length) this.log[this.log.length - 1].why = why;
  }

  /** How long the reaction on air stays (seeded: never the same length twice). */
  private holdReaction(kind: 'laugh' | 'nod', back: string, ids: string[]) {
    const P = PACE[this.pace];
    const min = Math.max(MIN_ON * (1 + 0.3 * this.rnd(30)), kind === 'laugh' ? REACT_MIN * (0.9 + 0.35 * this.rnd(31)) : P.react * (0.65 + 0.6 * this.rnd(31)));
    this.reacting = { until: this.now + min, max: this.now + (kind === 'laugh' ? Math.max(min, REACT_MAX * (0.8 + 0.35 * this.rnd(32))) : min), back, kind, ids };
  }

  /** Mark the bursts that are laughs / interjections the moment they start: someone who does not hold the floor and starts
   *  while the holder is sounding ('mid') or within LAUGH_HUG s of their last sound ('hug'; the holder's turn is a real one),
   *  or two or more others starting together ('grp': a group laugh - or cross-talk, which the overlap rule takes over once
   *  it lasts). A flagged burst never takes the floor; it stops being one when it outlasts a laugh. */
  private flagListeners(ids: string[], vl: Set<string>) {
    const hv = this.speaker && !vl.has(this.speaker) && this.speaker !== GV ? this.voices.get(this.speaker) ?? null : null;
    const open: string[] = [];
    for (const id of ids) {
      const v = this.voices.get(id)!;
      // (a flagged burst stays one for its whole turn - the hangover after the last "ha" is no cross-talk either - but a NEW run
      // after the laugh is talk again: the host laughing, then carrying on)
      if (v.lk && ((!v.on && !v.runOpen) || (v.runOpen && v.runStart !== v.lkRun))) v.lk = '';
      const age = this.now - v.lkAt;
      if (v.lk) {
        // (a single burst that goes on after the holder fell silent is a turn; a laugh of several lasts a little longer)
        if (age > (v.lk === 'grp' ? LISTEN_MAX : LAUGH_ONE_MAX) || (v.lk !== 'grp' && age > 0.8 && hv && this.now - hv.loudAt >= 0.4)) v.lk = '';
        continue;
      }
      if (!v.runOpen || id === GV || vl.has(id) || !this.live(id)) continue;
      // (the holder's own run counts when it is a new one - the teller laughing at their own joke - but never as a laugh by itself)
      if (id === this.speaker) { if (this.now - v.runStart < 1.2 && v.runStart - v.lastOn > 0.3) open.push(id); continue; }
      if (v.lkSeen !== v.runStart) {
        v.lkSeen = v.runStart;
        // ('hug' = a laugh right on the end of a joke: the teller's turn was a real one; a quick hand-over after a short line is banter)
        if (hv && this.now - hv.loudAt < LAUGH_HUG) {
          const mid = hv.loudAt >= this.now - 1.5 * DIRECTOR_STEP, told = hv.loudAt - hv.turnStart;
          if (told >= (mid ? 0.8 : HUG_TURN)) { v.lk = mid ? 'mid' : 'hug'; v.lkAt = v.runStart; v.lkRun = v.runStart; continue; }
        }
      }
      open.push(id);
    }
    const young = open.filter((id) => this.now - this.voices.get(id)!.runStart >= 0.2);
    // (a listener already flagged on its own who is joined within 0.5 s by the holder's new run: the table laughs together)
    const lone = ids.filter((id) => { const q = this.voices.get(id)!; return (q.lk === 'mid' || q.lk === 'hug') && q.runOpen && q.lkRun === q.runStart; });
    const pool = young.length ? [...young, ...lone] : young;
    // (two or more starting together: the holder's new run + at least one other, or two others)
    if (pool.length >= 2 && pool.some((id) => id !== this.speaker)) {
      const t = pool.map((id) => this.voices.get(id)!.runStart);
      if (Math.max(...t) - Math.min(...t) <= 0.5) for (const id of pool) { const q = this.voices.get(id)!; q.lk = 'grp'; q.lkAt = Math.min(...t); q.lkRun = q.runStart; }
    }
    // a group laugh (two or more flagged at once): everyone sounding is part of it - the table laughs, it does not talk over
    // each other - for as long as it lasts
    const flagged = ids.filter((id) => { const q = this.voices.get(id)!; return !!q.lk && q.runOpen; });
    if (flagged.length >= 2) {
      this.laughMode = this.now;
      for (const id of ids) { const q = this.voices.get(id)!; if (q.runOpen && !q.lk && id !== GV && !vl.has(id) && this.live(id)) { q.lk = 'grp'; q.lkAt = Math.min(...flagged.map((f) => this.voices.get(f)!.lkAt)); q.lkRun = q.runStart; } }
    }
  }

  /** The laugh ladder: a flagged burst old enough → the laugher's face (or the shared shot when several laugh), once per
   *  burst, REACT_GAP s apart; the sidekick plays along. True = cut. */
  private laughLadder(P: (typeof PACE)[Pace], ids: string[]): boolean {
    if (!this.opts.reactions || this.banter || (this.reacting && this.reacting.kind !== 'nod') || this.floorHolder || this.now - this.curAt < MIN_ON || this.now - this.lastLaugh < REACT_GAP) return false;
    const hv = this.speaker ? this.voices.get(this.speaker) ?? null : null;
    const holderQuiet = !hv || this.now - hv.loudAt >= RUN_GAP;   // (the holder's line is over - not just a gap between two words)

    // (by how long they have SOUNDED, still sounding: a 0.5 s "mhm" never reaches MID_REACT, however long the run stays open)
    const ready = ids.filter((id) => { const v = this.voices.get(id)!; return !!v.lk && v.runOpen && v.reacted !== v.runStart && this.now - v.loudAt < 0.12 && v.loudAt - v.runStart >= (v.lk !== 'grp' && !holderQuiet ? MID_REACT : REACT_DELAY); });
    if (!ready.length) return false;
    // everyone laughing right now (the group)
    const laughers = ids.filter((id) => { const v = this.voices.get(id)!; return !!v.lk && v.runOpen && this.now - v.loudAt < 0.3; });
    for (const id of laughers) this.voices.get(id)!.reacted = this.voices.get(id)!.runStart;
    const teller = hv && this.speaker ? this.speaker : '';
    this.reacting = null; this.lastLaugh = this.now;                     // (a listener's nod on air gives way to the laugh)
    if (laughers.length === 1) {
      const who = laughers[0];
      // (already on them: no jump cut on the same face - the sidekick plays along)
      if (this.featured(this.cur).includes(who)) { this.lastReact = this.now; if (this.opts.sidekick && this.rnd(33) < 0.5) this.beat('sidekick', 'laugh'); return false; }
      this.reactionShot(who, 'laugh', teller, laughers);
      if (this.opts.sidekick && this.rnd(33) < 0.35) this.beat('sidekick', 'laugh');
      return true;
    }
    const people = [...new Set([...laughers, ...(teller ? [teller] : [])])].filter((id) => this.live(id));
    const names = laughers.map((id) => this.name(id));
    let s: DirectorShot;
    if (this.opts.snaps && teller && teller !== 'sidekick' && laughers.length >= 3 && this.now - this.lastSnap >= SNAP_GAP && this.rnd(34) < 0.5) {
      // (rare: the whole table laughs - the one who told the joke, crash-zoomed)
      s = { shot: 'snap', subject: teller, secs: 0.2, why: `punchline by ${this.name(teller)}: snap zoom` };
    } else s = this.sharedShot(people, laughers.length === 2 ? `${names[0]} and ${names[1]} react` : 'everyone reacts');
    this.lastReact = this.now;
    this.reactEvery = STORY_GAP[0] + (STORY_GAP[1] - STORY_GAP[0]) * this.rnd(40);
    const took = this.take(s);
    if (s.shot === 'snap' && took) { this.lastSnap = this.now; this.beat(teller, 'snap'); this.reacting = { until: this.now + Math.max(MIN_ON, P.react * 0.8), max: this.now + P.react, back: teller, kind: 'snap', ids: [] }; return true; }
    this.holdReaction('laugh', teller, laughers);
    if (this.opts.sidekick) this.beat('sidekick', 'laugh');
    return took;
  }

  /** The shot for several people together: two → their pair shot; the desk → the panel; else the establishing wide. */
  private sharedShot(people: string[], why: string): DirectorShot {
    const ps = [...new Set(people)];
    if (ps.length === 2) return this.pairShot(ps[0], ps[1], why);
    if (this.co && ps.length > 1 && ps.every((p) => this.hostSide(p))) return { shot: 'panel', subject: '', secs: 0, why };
    return { shot: 'establishing', subject: '', secs: 0, why };
  }

  /** The two-shot of two people on the set: host + a seated guest → two (subject = the guest; a call-in gets the over-the-shoulder
   *  instead: the screen would be edge-on), host + co-host → hosts, two seated guests → two (subject = the first, `via` the
   *  second), two on the monitor → the whole monitor, else the establishing wide. */
  private pairShot(a: string, b: string, why: string): DirectorShot {
    const g = (x: string) => /^g\d$/.test(x), c = (x: string) => /^c\d$/.test(x);
    const rank = (x: string) => (x === 'host' ? 0 : c(x) ? 1 + +x.slice(1) : 10 + (g(x) ? +x.slice(1) : 9));
    const [p, q] = rank(a) <= rank(b) ? [a, b] : [b, a];
    if (p === 'host' && g(q)) return this.seatedGuest(q) ? { shot: 'two', subject: q, secs: 0, why } : { shot: 'ots', subject: q, secs: 0, why };
    if (p === 'host' && c(q)) return { shot: 'hosts', subject: '', via: q, secs: 0, why };
    if (c(p) && c(q)) return { shot: 'panel', subject: '', secs: 0, why };
    if (g(p) && g(q)) {
      const sp = this.seatedGuest(p), sq = this.seatedGuest(q);
      if (sp && sq) return { shot: 'two', subject: p, via: q, secs: 0, why };
      if (!sp && !sq) return { shot: 'guest', subject: GV, secs: 0, why };
    }
    return { shot: 'establishing', subject: '', secs: 0, why };
  }

  /** A reaction beat (laugh / snap: the sidekick / a TV performer plays along); the studio sends it with the cue. */
  private beat(who: string, kind: 'laugh' | 'snap' | 'nod') {
    if (kind === 'nod' && who !== 'sidekick') return;
    this.lastBeat = { n: this.cuts, who, kind };
    this.onReaction?.(who, kind);
  }

  /** The studio's "why" readout: the shot, why, how long, when the next forced cut is due, who talks. */
  explain(levels?: Record<string, number>) {
    const P = PACE[this.pace];
    const vl = new Set(this.voiceless());
    return {
      shot: this.cur.shot, subject: this.cur.subject, via: this.cur.via ?? '', why: this.cur.why, held: +(this.now - this.curAt).toFixed(1), cap: P.cap,
      speaker: this.speaker && (this.voices.get(this.speaker)?.on || this.floorHolder === this.speaker) ? this.speaker : '', floor: this.floorHolder,
      manual: this.manualUntil > this.now, cuts: this.cuts,
      voices: Object.fromEntries(this.ids().map((id) => { const q = this.voices.get(id); return [id, { on: !!q?.on, lvl: +(levels?.[id] ?? q?.lvl ?? 0).toFixed(2), presumed: vl.has(id) || id === GV, ready: this.live(id) }]; })),
    };
  }
}
