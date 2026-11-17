// Music-locked camera grammar for festival shows (docs/SCENES.md "Festival stages" → "Camera grammar"): camera ROLES from
// the room's camera names (wide / aerial / close / crowd / side) and the cuts a live-music edit makes, by song section:
//   intro / breakdown / outro   holds of 4-6 bars, faces and close shots (the valleys are faces)
//   groove                      a cut every 2-4 bars, wide / side / close in turn
//   build                       tightening: 2-bar cuts, then 1 bar, then 2 beats in its last bar (close / crowd roles)
//   the bar before a drop       a dark wide, held into the drop
//   the drop                    the widest role ON the drop's downbeat (the same frame as the white hit), held 2-4 bars,
//                               then close <-> wide every 1-2 bars, most cuts on beats inside the bar (~1 in 4 on a bar
//                               line), never the same camera twice in a row
//   a high burst                held (no cut for 2 bars after a shell bursts), then one crowd cutaway
// Photosensitivity: a cut is a whole-frame change the light governor never sees, so the grammar spaces them itself:
// every cut lands ON a beat, cuts are >= 2 beats (and >= 334 ms) apart, and with Safe flashes ON above 180 BPM only on
// the even beats - the stage governor's window grid - so a cut never adds a turn between two light windows.
// Pure and deterministic (the same plan on every page); tools/festival_grammar_unit.ts proves the spacing.
import { hash3, hashStr, type ScriptSection } from './festival.ts';
import type { MusicState } from './festivalDirector.ts';

export type CamRole = 'wide' | 'aerial' | 'close' | 'crowd' | 'side';
/** a camera's role from its name (CAM_WIDE, CAM_FOH → wide; DRONE / CRANE / AERIAL / HIGH → aerial; BOOTH / DJ / BEHIND /
 *  CLOSE / SPOT_xx_CAM → close; CROWD / PIT / FACE / FRONT → crowd; SIDE / WING / LEFT / RIGHT → side) */
export function camRole(name: string): CamRole {
  const n = name.toUpperCase();
  if (/DRONE|CRANE|AERIAL|HIGH|SKY|HELI/.test(n)) return 'aerial';
  if (/CROWD|PIT|FACE|FRONT|AUDIENCE|FANS/.test(n)) return 'crowd';
  if (/SIDE|WING|LEFT|RIGHT|STAGE_L|STAGE_R/.test(n)) return 'side';
  if (/BOOTH|DJ|BEHIND|CLOSE|DECK|SPOT_\d+_CAM|MC|HOST/.test(n)) return 'close';
  if (/WIDE|FOH|MAIN|PYRO|TOTAL|MASTER|ESTABLISH/.test(n)) return 'wide';
  return 'side';
}
/** roles the open (wide) and tight shots use */
const OPEN: CamRole[] = ['wide', 'aerial'], TIGHT: CamRole[] = ['close', 'crowd', 'side'];

/** one part of a show for the grammar (show beats) */
export interface GrammarPart { start: number; end: number; section: ScriptSection; master: number;
  /** a drop starts here (a drop part after a non-drop part) */ drop: boolean;
  /** the next part starts a drop */ beforeDrop: boolean }
export interface Cut { at: number; cam: string; role: CamRole }
export interface GrammarOpts { bpm: number; safe: boolean; seed: number;
  /** show beats of high bursts (shells): no cut for 8 beats after one, then a crowd cutaway */
  holds?: number[];
  /** a wide framed for the pyro (the roofline at ~half the frame, the sky above it): the drop's shot when shells burst in
   *  its first bars, and the open shot of choice while they keep coming */
  pyroCam?: string }

/** the smallest gap between two cuts (beats): 2 beats and never under 334 ms */
export const minCutBeats = (bpm: number) => Math.max(2, Math.ceil((0.334 * bpm) / 60));
/** with Safe flashes ON above 180 BPM cuts land on the even beats (the stage governor's windows are every 2nd beat) */
export const cutGrid = (bpm: number, safe: boolean) => (safe && bpm > 180 ? 2 : 1);
/** The tempo band a plan is made for, latched against a jittery clock: fast from 179.5 BPM, slow again only under 177 BPM.
 *  A tempo hovering around 180 can't flip the plan (and its grid) back and forth, and the latch leans to the safe side (the
 *  even beats from 179.5 BPM, so "the even beats above 180" still holds). */
export const tempoBand = (fast: boolean, bpm: number): boolean => (bpm > 179.5 ? true : bpm < 177 ? false : fast);
/** the tempo the planner gets inside a band (its grid then matches the band's plan) */
export const bandBpm = (fast: boolean, bpm: number): number => (fast ? Math.max(bpm, 180.5) : Math.min(bpm, 180));

/** The cut actually on screen, kept across re-plans (a live section change, a drop moving, the tempo band, Safe flashes, a
 *  new show). A plan spaces its own cuts; a NEW plan can move them, so a different camera waits until the one up has been up
 *  `gap` beats - a re-plan never adds a cut inside the spacing - and the same camera under a new plan is no cut at all (its
 *  move carries on, under its old key). Beats are the music clock's (not a show's: they don't restart with a show); a clock
 *  that jumps back more than a beat (a reset) starts over. No allocation. */
export class CutGuard {
  /** the camera up and its key */
  cam = ''; key = '';
  /** the plan's cut last seen; the beat the camera went up; its move (start beat, beats) */
  private seen = ''; private up = -Infinity; private start = 0; private len = 1; private lastB = -Infinity;
  reset(): void { this.cam = ''; this.key = ''; this.seen = ''; this.up = -Infinity; this.start = 0; this.len = 1; this.lastB = -Infinity; }
  /** the plan's cut at beat b (its camera, key, start beat, length in beats) → how far the camera up (this.cam) is into its
   *  move, 0..1 */
  step(cam: string, key: string, start: number, len: number, b: number, gap: number): number {
    if (b < this.up - 1) this.reset();
    if (key !== this.seen) {
      if (cam === this.cam) this.seen = key;
      else if (b - this.up >= gap) {
        this.seen = key; this.cam = cam; this.key = key; this.start = start; this.len = Math.max(1, len);
        // (its beat passed since the last frame - on time: stamped on the plan's own beat, so the plan's next cut isn't
        //  held a frame; a cut whose beat passed earlier (a re-plan's, or one that waited): the beat it went up)
        this.up = this.lastB < start && start <= b ? start : b;
      }
    }
    this.lastB = b;
    return Math.min(1, Math.max(0, (b - this.start) / this.len));
  }
}

/** what the live grammar reads off the music clock */
export type LiveMusic = Pick<MusicState, 'beat' | 'section' | 'sectionStart' | 'lastDrop' | 'nextDrop'>;
/** where the live (unscripted) grammar's plan starts: a drop from its downbeat (its first 16 bars), else the section's start */
export const liveStart = (m: LiveMusic): number => (m.section === 'drop' && Number.isFinite(m.lastDrop) && m.beat - m.lastDrop < 64 ? m.lastDrop : m.sectionStart);
/** the live grammar's parts from `start`: a build counting down to a known drop → the build, its dark last bar and the drop;
 *  else 32 bars of the section (re-planned when the section changes) */
export function liveParts(m: LiveMusic, start: number): GrammarPart[] {
  if (m.section === 'build' && m.nextDrop != null && m.nextDrop - 4 > start) return [
    { start, end: m.nextDrop - 4, section: 'build', master: 1, drop: false, beforeDrop: false },
    { start: m.nextDrop - 4, end: m.nextDrop, section: 'build', master: 0.15, drop: false, beforeDrop: true },
    { start: m.nextDrop, end: m.nextDrop + 64, section: 'drop', master: 1, drop: true, beforeDrop: false }];
  return [{ start, end: start + 128, section: m.section, master: 1, drop: m.section === 'drop' && start === m.lastDrop, beforeDrop: false }];
}

/** The cut list of a whole show (sorted, show beats). */
export function planCuts(parts: GrammarPart[], cams: string[], o: GrammarOpts): Cut[] {
  const list = cams.filter((c, i) => cams.indexOf(c) === i);
  if (!list.length || !parts.length) return [];
  const byRole = new Map<CamRole, string[]>();
  for (const c of list) { const r = camRole(c); (byRole.get(r) ?? byRole.set(r, []).get(r)!).push(c); }
  const grid = cutGrid(o.bpm, o.safe), gap = Math.max(minCutBeats(o.bpm), grid);
  const snap = (b: number) => Math.round(b / grid) * grid;
  const cuts: Cut[] = [];
  let n = 0;
  const pick = (roles: CamRole[], salt: number, avoid?: string): Cut['cam'] => {
    // the first role with a camera, a camera of it by the seed - never the camera already up
    for (const r of roles) {
      const cs = (byRole.get(r) ?? []).filter((c) => c !== avoid);
      if (cs.length) return cs[Math.floor(hash3(o.seed, salt, hashStr(r)) * cs.length) % cs.length];
    }
    const any = list.filter((c) => c !== avoid);
    return any.length ? any[Math.floor(hash3(o.seed, salt, 7) * any.length) % any.length] : list[0];
  };
  const widest = (salt: number, avoid?: string) => pick(OPEN, salt, avoid);
  const add = (at: number, cam: string, force = false) => {
    const t = snap(at);
    const last = cuts[cuts.length - 1];
    if (last && last.cam === cam) return;
    if (last && t - last.at < gap) { if (!force) return; cuts.pop(); }          // (a forced cut - the drop - replaces one too close)
    while (cuts.length && cuts[cuts.length - 1].at >= t) cuts.pop();
    const prev = cuts[cuts.length - 1];
    if (prev && prev.cam === cam) return;
    if (prev && t - prev.at < gap) return;
    cuts.push({ at: t, cam, role: camRole(cam) });
  };
  const held = (b: number) => (o.holds ?? []).some((h) => b > h && b < h + 8);
  const shellsIn = (a: number, b: number) => (o.holds ?? []).some((h) => h >= a && h < b);
  const pyro = o.pyroCam && list.includes(o.pyroCam) ? o.pyroCam : null;
  for (const p of parts) {
    const len = p.end - p.start;
    if (len <= 0) continue;
    const salt = (k: number) => Math.round(p.start) * 131 + k;
    const cur = () => cuts[cuts.length - 1]?.cam;
    if (p.drop) {
      // the drop: the widest shot on the downbeat (forced: it lands on the white hit), held 2-4 bars, then close <-> wide.
      // (from the dark wide: the OTHER open camera - the aerial - when there is one, else the wide just stays up)
      const up = cur(), open = list.filter((c) => OPEN.includes(camRole(c)) && c !== up);
      // (shells bursting in the drop's first bars: the pyro wide - else the wide, from the dark aerial; the aerial from a
      //  dark wide)
      if (pyro && pyro !== up && shellsIn(p.start - 16, p.start + 16)) add(p.start, pyro, true);
      else if (open.length || !up || !OPEN.includes(camRole(up))) add(p.start, open.length ? pick(camRole(up ?? '') === 'aerial' ? ['wide', 'aerial'] : ['aerial', 'wide'], salt(1), up) : widest(salt(1), up), true);
      let t = p.start + 4 * (2 + Math.floor(hash3(o.seed, salt(2), 3) * 3));
      let tight = true;
      while (t < p.end - 1) {
        const r = hash3(o.seed, salt(n), 5);
        if (shellsIn(t - 8, t + 8)) {
          // shells bursting: the open (pyro) shot holds through them (>= 3 bars), a short crowd / close cutaway between
          const upOpen = OPEN.includes(camRole(cur() ?? ''));
          if (upOpen) { add(t, pick(['crowd', 'close'], salt(n++), cur())); t += r < 0.5 ? 5 : 6; }
          else { add(t, pyro && pyro !== cur() ? pyro : widest(salt(n++), cur())); t += 12 + Math.floor(r * 4); }
          tight = true;
          continue;
        }
        if (held(t)) { const h = (o.holds ?? []).find((x) => t > x && t < x + 8)!; t = h + 8; continue; }
        add(t, tight ? pick(TIGHT, salt(n++), cur()) : widest(salt(n++), cur()));
        tight = !tight;
        // 1-2 bars, most of them landing inside the bar (5, 6, 7 beats), about 1 in 4 on a bar line
        t += r < 0.15 ? 4 : r < 0.25 ? 8 : r < 0.5 ? 5 : r < 0.75 ? 6 : 7;
      }
      continue;
    }
    if (p.beforeDrop && (len <= 4 || p.master <= 0.2)) { add(p.start, pick(['aerial', 'wide'], salt(1), cur())); continue; }   // the dark wide before the drop
    if (p.section === 'drop') {
      // a drop going on (a second drop part): keep alternating
      let t = p.start, tight = camRole(cur() ?? '') === 'wide' || camRole(cur() ?? '') === 'aerial';
      while (t < p.end - 1) {
        const r = hash3(o.seed, salt(n), 5);
        if (shellsIn(t - 8, t + 8)) { const upOpen = OPEN.includes(camRole(cur() ?? '')); if (upOpen) { add(t, pick(['crowd', 'close'], salt(n++), cur())); t += r < 0.5 ? 5 : 6; } else { add(t, pyro && pyro !== cur() ? pyro : widest(salt(n++), cur())); t += 12 + Math.floor(r * 4); } continue; }
        if (!held(t)) { add(t, tight ? pick(TIGHT, salt(n++), cur()) : widest(salt(n++), cur())); tight = !tight; }
        t += r < 0.15 ? 4 : r < 0.25 ? 8 : r < 0.5 ? 5 : r < 0.75 ? 6 : 7;
      }
      continue;
    }
    if (p.section === 'build') {
      // tightening: 2-bar cuts, the last 2 bars 1-bar cuts, the last bar 2 beats (the next part is the drop's dark wide)
      const end = p.end;
      for (let t = p.start; t < end - 1;) {
        const left = end - t;
        add(t, pick(n % 2 ? ['crowd', 'close'] : ['close', 'side'], salt(n), cur())); n++;
        t += left > 12 ? 8 : left > 4 ? 4 : 2;
      }
      continue;
    }
    // intro / breakdown / outro: hold 4-6 bars; groove: 2-4 bars
    const calm = p.section === 'intro' || p.section === 'breakdown' || p.section === 'outro' || p.master <= 0.35;
    for (let t = p.start; t < p.end - 1;) {
      // (a shell still bursting from the part before: its 2 bars first)
      while (held(t)) t = (o.holds ?? []).filter((x) => t > x && t < x + 8).reduce((a, x) => Math.max(a, x + 8), t);
      if (t >= p.end - 1) break;
      const roles: CamRole[] = calm ? (n % 3 === 0 ? ['wide', 'aerial'] : n % 3 === 1 ? ['crowd', 'close'] : ['close', 'side']) : (n % 3 === 0 ? ['wide'] : n % 3 === 1 ? ['side', 'close'] : ['close', 'crowd']);
      add(t, pick(roles, salt(n), cur())); n++;
      const r = hash3(o.seed, salt(n), 9);
      t += calm ? (r < 0.5 ? 16 : 24) : (r < 0.4 ? 8 : r < 0.75 ? 12 : 16);
    }
  }
  return cuts;
}

/** where a show is in its cut list at show beat b: the cut up (index, camera) and how far into it (beats) - binary search */
export function cutAt(cuts: Cut[], b: number): { idx: number; cut: Cut | null; into: number; len: number } {
  let lo = 0, hi = cuts.length - 1, at = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cuts[m].at <= b) { at = m; lo = m + 1; } else hi = m - 1; }
  if (at < 0) return { idx: -1, cut: null, into: 0, len: 1 };
  const next = cuts[at + 1]?.at ?? cuts[at].at + 32;
  return { idx: at, cut: cuts[at], into: b - cuts[at].at, len: Math.max(1, next - cuts[at].at) };
}

/** a scripted show's parts (bars) → the grammar's parts (show beats) */
export function grammarParts(parts: { bar: number; section: ScriptSection; master?: number }[], bars: number): GrammarPart[] {
  return parts.map((p, i) => {
    const next = parts[i + 1];
    return { start: p.bar * 4, end: (next ? next.bar : bars) * 4, section: p.section, master: p.master ?? 1,
      drop: p.section === 'drop' && !(i > 0 && parts[i - 1].section === 'drop'), beforeDrop: !!next && next.section === 'drop' && p.section !== 'drop' };
  });
}
