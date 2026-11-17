// The endshow composer: a whole scripted show (shared/festival.ts FestivalScript - parts + cues) from a template, the
// host's tracks (or the template's arrangement) and the room's own effect groups. Pure and deterministic (the same input
// = the same show on every page), generic (templates, roles, no names). docs/SCENES.md "Festival stages" → "Composed
// endshows"; checked by tools/festival_compose_unit.ts.
//
// The shape follows the research on hard-dance mainstage endshows: contrast is the design rule - every peak follows a
// valley, the effects budget climbs over the show and the finale is the densest part:
//   full endshow (~22 min)   cinematic intro (budget 0.15) · full-force tracks (0.7) · a breather (0.15) · the anthem
//                            (0.8, where the host puts it) · premieres rising 0.5 → 0.9 · a near-dark final break (0.05) ·
//                            the finale (1.0: fire, comet sunbursts and curtains, shells every 2 beats) · the outro (decay)
//   short closing show (~12) an overture (0.15) · the closing theme (0.7) · the finale (1.0) · linger
//   three acts (~30)         a full-force opener · a look back (calmer) · the convergence + an encore finale
//   inverted arc (~20)       open at full force, cut almost to dark, rebuild to the finale
// Every number below is a tunable default (the budgets, the share of each segment, the cue rates).
// Validators (validateEndshow): every drop is preceded within 8 bars by >= 1 bar at <= 0.2 of the light; no high shells
// before 40 % of the show; the finale's cue density >= 1.5 x any earlier segment's; <= 1 flame volley a bar.
import { hash3, type FestivalCueStep, type FestivalScript, type FestivalScriptCue, type FestivalScriptPart, type FxKind, type ScriptSection } from './festival.ts';
import { COMPOSE_LABEL, COMPOSE_MINUTES, DEFAULT_COMPOSE, type ComposeState, type ComposeTemplate } from './festivalComposeState.ts';

// ---------------------------------------------------------------------------------------------------- the room
/** what the composer needs to know about a room: its effect groups (kind, name, units, mean height, x span), its
 *  cameras and the stage's size. Build it from ALL the room's anchors (not a tier's subset): every page composes the same. */
export interface ComposeGroup { kind: FxKind; group: string; n: number; y: number; x0: number; x1: number }
export interface ComposeRoom { groups: ComposeGroup[]; deckY: number; stageH: number; title?: string }

/** the track roles the templates use */
export type TrackRole = 'intro' | 'full' | 'breather' | 'anthem' | 'premiere' | 'finale' | 'break' | 'outro';
export interface ComposeTrack { bars: number; role: TrackRole; budget: number }

// ---------------------------------------------------------------------------------------------------- templates
/** a template's arrangement: [role, share of the show (or bars when < 0: a fixed length), effects budget] */
type Seg = [TrackRole, number, number];
const TEMPLATES: Record<ComposeTemplate, { segs: Seg[]; label: string }> = {
  main: { label: COMPOSE_LABEL.main, segs: [['intro', 0.1, 0.15], ['full', 0.125, 0.7], ['full', 0.125, 0.7], ['breather', 0.1, 0.15], ['anthem', 0.14, 0.8], ['premiere', 0.12, 0.5], ['premiere', 0.12, 0.9], ['break', -8, 0.05], ['finale', 0.15, 1], ['outro', 0.025, 0.05]] },
  closing: { label: COMPOSE_LABEL.closing, segs: [['intro', 0.2, 0.15], ['anthem', 0.38, 0.7], ['break', -4, 0.05], ['finale', 0.36, 1], ['outro', 0.06, 0.05]] },
  acts3: { label: COMPOSE_LABEL.acts3, segs: [['full', 0.12, 0.85], ['full', 0.11, 0.9], ['breather', 0.08, 0.15], ['intro', 0.07, 0.15], ['premiere', 0.12, 0.5], ['premiere', 0.12, 0.65], ['anthem', 0.14, 0.8], ['break', -8, 0.05], ['finale', 0.2, 1], ['outro', 0.04, 0.05]] },
  inverted: { label: COMPOSE_LABEL.inverted, segs: [['full', 0.2, 0.9], ['break', -16, 0.05], ['intro', 0.1, 0.15], ['breather', 0.1, 0.15], ['premiere', 0.15, 0.6], ['anthem', 0.16, 0.8], ['break', -8, 0.05], ['finale', 0.2, 1], ['outro', 0.03, 0.05]] },
};
export const templateLabel = (t: ComposeTemplate) => TEMPLATES[t].label;

/** The template's tracks for a show of `bars` bars (each a multiple of 8 bars, the anthem moved to where the host
 *  wants it - `anthem` 0..1 of the show - among the middle tracks). Host tracks (bars each) take the roles in order. */
export function arrange(t: ComposeTemplate, bars: number, anthem: number, tracks?: number[] | null, bpm = 150): ComposeTrack[] {
  const segs = TEMPLATES[t].segs.map((s) => [...s] as Seg);
  // the anthem among the middle full-force tracks: swap it with the one whose start is nearest the host's choice
  const ai = segs.findIndex((s) => s[0] === 'anthem');
  if (ai >= 0) {
    const fixed = segs.reduce((a, s) => a + (s[1] < 0 ? -s[1] : 0), 0), share = (s: Seg) => (s[1] < 0 ? -s[1] / bars : s[1] * (1 - fixed / bars));
    let best = ai, bd = Infinity;
    for (let i = 0, at = 0; i < segs.length; at += share(segs[i]), i++) {
      if (!['full', 'premiere', 'anthem'].includes(segs[i][0])) continue;
      const d = Math.abs(at - anthem); if (d < bd) { bd = d; best = i; }
    }
    if (best !== ai) { const a = segs[ai]; segs[ai] = segs[best]; segs[best] = a; }
  }
  // the premieres climb (each drop bigger than the one before): budgets in the order they now sit
  const pre = segs.filter((s) => s[0] === 'premiere'); const pb = pre.map((s) => s[2]).sort((a, b) => a - b); pre.forEach((s, i) => { s[2] = pb[i]; });
  const out: ComposeTrack[] = [];
  if (tracks && tracks.length >= 2) {
    // the host's tracks: the template's roles in order over them (the intro first, the finale last)
    const roles = segs.filter((s) => s[1] > 0);
    tracks.forEach((b, i) => {
      const k = i === 0 ? 0 : i === tracks.length - 1 ? roles.findIndex((s) => s[0] === 'finale') : Math.min(roles.length - 2, 1 + Math.floor((i - 1) * (roles.length - 2) / Math.max(1, tracks.length - 2)));
      const s = roles[Math.max(0, k)] ?? roles[0];
      if (s[0] === 'finale' && out.length) out.push({ bars: 8, role: 'break', budget: 0.05 });
      out.push({ bars: Math.max(16, Math.round(b / 8) * 8), role: s[0], budget: s[2] });
    });
    out.push({ bars: 16, role: 'outro', budget: 0.05 });
    return out;
  }
  const fixed = segs.reduce((a, s) => a + (s[1] < 0 ? -s[1] : 0), 0);
  const free = Math.max(64, bars - fixed);
  // (a long segment is several tracks of ~3.1 minutes each - a real endshow's track length - except the finale, which
  //  runs its drops back to back)
  const trackBars = Math.max(48, Math.round((3.1 * bpm) / 4 / 8) * 8);
  for (const s of segs) {
    const b = s[1] < 0 ? -s[1] : Math.max(16, Math.round((s[1] * free) / 8) * 8);
    const k = s[0] === 'finale' || s[0] === 'intro' || s[1] < 0 || s[0] === 'outro' ? 1 : Math.max(1, Math.round(b / trackBars));
    for (let i = 0; i < k; i++) out.push({ bars: i < k - 1 ? Math.round(b / k / 8) * 8 : b - Math.round(b / k / 8) * 8 * (k - 1), role: s[0], budget: s[2] });
  }
  return out;
}

/** The effects budget (0..1) at x (0..1 of the show) for a template - the curve the composer follows (for the UI / tests). */
export function budgetCurve(t: ComposeTemplate, x: number, anthem = DEFAULT_COMPOSE.anthem, bars = 800, bpm = 150): number {
  const tr = arrange(t, bars, anthem, null, bpm);
  const total = tr.reduce((a, b) => a + b.bars, 0);
  let at = 0;
  for (const s of tr) { if (x * total < at + s.bars) return s.budget; at += s.bars; }
  return tr[tr.length - 1]?.budget ?? 0;
}

// ---------------------------------------------------------------------------------------------------- the parts
/** a block of a track: section, bars, the light level (part master), what it is for the cues */
export interface Block { section: ScriptSection; bars: number; master: number; kind: 'intro' | 'tease' | 'reveal' | 'build' | 'gap' | 'drop' | 'groove' | 'break' | 'outro'; dropIdx?: number }
/** a track's blocks (in 8-bar phrases; the gap is the bar before each drop: the show layer near black, the set's outline on).
 *  They fill the track's bars exactly: a short track keeps its build, the gap and the drop and loses the groove / tease /
 *  reveal first (a slow tempo or a short show - the show's length is what the host asked for). */
export function trackBlocks(t: ComposeTrack): Block[] {
  const B = t.bars;
  const drop = (bars: number, i: number, m = 1): Block[] => [{ section: 'build', bars: 7, master: 0.85, kind: 'build' }, { section: 'build', bars: 1, master: 0.12, kind: 'gap' }, { section: 'drop', bars, master: m, kind: 'drop', dropIdx: i }];
  const fill = (blocks: Block[], tail: Block) => {
    const used = blocks.reduce((a, b) => a + b.bars, 0);
    const left = B - used;
    if (left >= 8) blocks.push({ ...tail, bars: left });
    else if (left > 0) blocks[blocks.length - 1].bars += left;
    return blocks;
  };
  switch (t.role) {
    case 'intro': return fill([{ section: 'intro', bars: Math.max(8, B - 8), master: 0.32, kind: 'intro' }], { section: 'breakdown', bars: 8, master: 0.3, kind: 'tease' });
    case 'break': return [{ section: 'breakdown', bars: B, master: 0.05, kind: 'break' }];
    case 'outro': return [{ section: 'outro', bars: B, master: 0.14, kind: 'outro' }];
    case 'breather': {
      if (B < 40) return B >= 24 ? [{ section: 'breakdown', bars: 8, master: 0.3, kind: 'tease' }, ...drop(B - 16, 0, 0.75)] : drop(Math.max(1, B - 8), 0, 0.75);
      const d = Math.max(16, Math.floor((B - 32) / 16) * 8);
      return fill([{ section: 'groove', bars: 8, master: 0.55, kind: 'groove' }, { section: 'breakdown', bars: 8, master: 0.3, kind: 'tease' }, ...drop(d, 0, 0.75)], { section: 'outro', bars: 8, master: 0.3, kind: 'outro' });
    }
    case 'finale': {
      // a build-up, then drops back to back to the end (each 16+ bars), a last salvo, dark
      if (B < 32) return drop(Math.max(1, B - 8), 0);
      const blocks: Block[] = [{ section: 'breakdown', bars: 8, master: 0.6, kind: 'reveal' }, ...drop(Math.max(16, Math.floor((B - 16) / 2 / 8) * 8), 0)];
      const left = B - blocks.reduce((a, b) => a + b.bars, 0);
      if (left >= 24) blocks.push(...drop(left - 8, 1));
      return fill(blocks, { section: 'drop', bars: 8, master: 1, kind: 'drop', dropIdx: 2 });
    }
    default: {
      // a full track: groove · tease · reveal · build + gap · drop · break · build + gap · drop · (groove)
      if (B < 48) return B >= 32 ? [{ section: 'breakdown', bars: 8, master: 0.6, kind: 'reveal' }, ...drop(B - 16, 0)] : drop(Math.max(1, B - 8), 0);
      const d = Math.max(16, Math.floor((B - 56) / 2 / 8) * 8);
      const blocks: Block[] = [{ section: 'groove', bars: 8, master: 0.8, kind: 'groove' }, { section: 'breakdown', bars: 8, master: 0.3, kind: 'tease' }, { section: 'breakdown', bars: 8, master: 0.6, kind: 'reveal' }, ...drop(d, 0)];
      if (B - blocks.reduce((a, b) => a + b.bars, 0) >= d + 16) blocks.push({ section: 'breakdown', bars: 8, master: 0.45, kind: 'reveal' }, ...drop(d, 1));
      return fill(blocks, { section: 'groove', bars: 8, master: 0.8, kind: 'groove' });
    }
  }
}

// ---------------------------------------------------------------------------------------------------- the cues
interface Groups {
  line: string | null;          // the flame row along the deck front (chases)
  flamesHigh: string[];         // tower / roof flames (volleys, the fire wall)
  roof: string | null;          // the highest effect group (comet fans, the sunburst)
  comets: string | null; gerbs: string | null; co2: string | null; confetti: string | null; shells: string | null; towers: string | null;
}
function pickGroups(room: ComposeRoom): Groups {
  const of = (k: FxKind) => room.groups.filter((g) => g.kind === k);
  const flames = of('flame').sort((a, b) => a.y - b.y || b.n - a.n);
  const line = flames.length ? [...flames].sort((a, b) => b.n - a.n + (a.y - b.y) * 0.02)[0] : null;   // (the most units, low)
  const high = flames.filter((g) => g !== line && g.y > room.deckY + 0.3 * room.stageH);
  // the roof: the highest comet / flame / gerb group (comets fire from the other kinds' anchors when it has no comets)
  const sky = [...of('comet'), ...of('flame'), ...of('gerb')].sort((a, b) => b.y - a.y);
  const roof = sky.length && sky[0].y > room.deckY + 0.45 * room.stageH ? sky[0] : null;
  const towers = flames.filter((g) => g.n <= 2 && g.y > room.deckY + 0.3 * room.stageH)[0] ?? null;
  const first = (k: FxKind) => of(k).sort((a, b) => b.n - a.n)[0]?.group ?? null;
  return { line: line?.group ?? null, flamesHigh: high.map((g) => g.group), roof: roof?.group ?? null, comets: first('comet'), gerbs: first('gerb'), co2: first('co2'), confetti: first('confetti'), shells: first('firework'), towers: towers?.group ?? null };
}

/** The effect groups a composed show can fire in this room ('kind:GROUP', the roof by its real kind): FestivalScene keeps
 *  at least one unit of each on every tier, so a composed show plays the same on every page (the composer reads every
 *  anchor of the room, whatever the tier). Depends only on the room. */
export function composeGroupKeys(room: ComposeRoom): string[] {
  const g = pickGroups(room), out = new Set<string>();
  const add = (grp: string | null, kinds: FxKind[]) => {
    if (!grp) return;
    for (const k of kinds) if (room.groups.some((x) => x.kind === k && x.group === grp)) out.add(`${k}:${grp}`);
  };
  add(g.line, ['flame']); add(g.towers, ['flame']);
  for (const h of g.flamesHigh) add(h, ['flame']);
  // (the roof: the highest comet / flame / gerb group - its comet fans fire from whichever of them carries that name)
  add(g.roof, ['comet', 'flame', 'gerb']);
  add(g.comets, ['comet']); add(g.gerbs, ['gerb']); add(g.co2, ['co2']); add(g.confetti, ['confetti']); add(g.shells, ['firework']);
  return [...out].sort();
}

const ORDERS = ['lr', 'rl', 'out', 'in'] as const;
const SHELL_STYLES = [undefined, 'willow', 'crossette', 'glitter', undefined, 'willow'] as const;
const FINALE_FANS = ['sunburst', 'curtain', 'lattice', 'semicircle', 'sunburst', 'fan'] as const;

/** the cues of one block (absolute bars), by its kind, the track's role / budget and where it sits in the show */
function blockCues(b: Block & { bar: number }, t: ComposeTrack, x: number, g: Groups, seed: number, ti: number, out: FestivalScriptCue[]) {
  const r = (k: number, j = 0) => hash3(seed, ti * 977 + b.bar, k * 31 + j);
  const cue = (bar: number, at: number, s: Omit<FestivalCueStep, 'at'>) => out.push({ ...s, at, bar } as FestivalScriptCue);
  const bud = t.budget, fin = t.role === 'finale';
  switch (b.kind) {
    case 'intro': case 'tease': {
      // accents: 1-4 single / paired flame hits per 8 bars (no aerials, no volleys)
      if (bud > 0.12 && (g.towers || g.line)) for (let ph = 0; ph < b.bars; ph += 8) {
        const n = 1 + Math.floor(r(1, ph) * (b.kind === 'intro' ? 3 : 2));
        for (let k = 0; k < n; k++) {
          const bar = b.bar + ph + Math.min(7, Math.floor(((k + 0.5) / n) * 8));
          if (bar >= b.bar + b.bars) continue;
          cue(bar, 0, { kind: 'flame', group: g.towers ?? g.line!, dur: 1, power: 0.7, side: g.towers ? 0 : (k % 2 ? 1 : -1) as -1 | 1 });
        }
      }
      return;
    }
    case 'reveal': if (fin && g.gerbs) cue(b.bar, 0, { kind: 'gerb', group: g.gerbs, dur: 16, power: 0.7 }); return;
    case 'build': {
      if (bud >= 0.5 && g.gerbs) cue(b.bar, 0, { kind: 'gerb', group: g.gerbs, dur: 8, power: 0.7 });
      // CO2 through the build's last 2 bars, sides alternating every 2 beats
      if (bud >= 0.5 && g.co2) for (let k = 0; k < 4; k++) cue(b.bar + b.bars - 2 + Math.floor(k / 2), (k % 2) * 2, { kind: 'co2', group: g.co2, dur: 0.6, power: 0.75, side: (k % 2 ? 1 : -1) as -1 | 1 });
      return;
    }
    case 'drop': {
      const first = !b.dropIdx;
      // the downbeat: every flame unit at once (the first volley), CO2, a gerb line, confetti on the big ones
      if (bud >= 0.5) {
        for (const grp of [g.line, ...(bud >= 0.8 ? g.flamesHigh : [])]) if (grp) cue(b.bar, 0, { kind: 'flame', group: grp, dur: first ? 2 : 1.5, power: 1.2 });
        if (g.co2) cue(b.bar, 0, { kind: 'co2', group: g.co2, dur: 1.5, power: 1 });
        if (g.gerbs) cue(b.bar, 0, { kind: 'gerb', group: g.gerbs, dur: 8, power: 0.9 });
        if (g.confetti && (fin || t.role === 'anthem') && first) cue(b.bar, 0, { kind: 'confetti', group: g.confetti, dur: 2, power: 1 });
      } else if (bud > 0.12 && g.line) cue(b.bar, 0, { kind: 'flame', group: g.line, dur: 1, power: 0.9, order: 'out', span: 1 });
      // chases on bars 1 and 5 of every 8 (punctuation, not every kick); the finale on every 2nd bar + CO2 every 4
      if (fin && g.co2) for (let k = 2; k < b.bars; k += 4) cue(b.bar + k, 0, { kind: 'co2', group: g.co2, dur: 0.8, power: 0.9, side: ((k / 4) % 2 ? 1 : -1) as -1 | 1 });
      if (bud >= 0.5 && g.line) for (let ph = 0; ph < b.bars; ph += 8) for (const off of fin ? [0, 2, 4, 6] : [0, 4]) {
        const bar = b.bar + ph + off; if (bar >= b.bar + b.bars || (ph === 0 && off === 0)) continue;
        cue(bar, 0, { kind: 'flame', group: g.line, dur: 0.5, power: 0.9, order: ORDERS[Math.floor(r(2, ph + off) * 4) % 4], span: 1 + Math.round(r(3, ph + off)) });
        if (bud >= 0.85 && g.flamesHigh.length && off === 4) cue(bar, 2, { kind: 'flame', group: g.flamesHigh[Math.floor(r(4, ph) * g.flamesHigh.length) % g.flamesHigh.length], dur: 0.6, power: 1 });
      }
      // low-tier aerials: comet fans from the roof every 2nd phrase (the anthem: every phrase), the finale every phrase
      const fanFrom = g.roof ?? g.comets;
      if (fanFrom && bud >= 0.6) for (let ph = 0; ph < b.bars; ph += 8) {
        const every = fin || t.role === 'anthem' ? 1 : 2;
        if ((ph / 8) % every !== (every > 1 ? 1 : 0)) continue;
        const style = fin ? FINALE_FANS[Math.floor(r(5, ph) * FINALE_FANS.length) % FINALE_FANS.length] : g.roof ? 'fan' : 'vfan';
        cue(b.bar + ph, 0, { kind: 'comet', group: fanFrom, dur: 1, power: 1, style });
        if (fin && g.comets && g.comets !== fanFrom) cue(b.bar + ph + 4, 0, { kind: 'comet', group: g.comets, dur: 1, power: 1, style: 'vfan' });
      }
      // high-tier shells: never before 40 % of the show; the anthem one teaser salvo (its second drop), the finale one
      // shell every 2 beats (alternating sides, styles), a last salvo
      if (g.shells && x >= 0.4) {
        if (t.role === 'anthem' && b.dropIdx === 1) for (let k = 0; k < 3; k++) cue(b.bar + 4, k * 2, { kind: 'firework', group: g.shells, dur: 1, power: 1.1, side: (k % 2 ? 1 : -1) as -1 | 1 });
        if (fin) for (let bt = 0; bt < b.bars * 4; bt += 2) {
          const bar = b.bar + Math.floor(bt / 4);
          const style = SHELL_STYLES[Math.floor(r(6, bt) * SHELL_STYLES.length) % SHELL_STYLES.length];
          cue(bar, bt % 4, { kind: 'firework', group: g.shells, dur: 1, power: 1 + 0.3 * r(7, bt), side: ((bt / 2) % 2 ? 1 : -1) as -1 | 1, ...(style ? { style } : {}) });
        }
      }
      return;
    }
    default: return;
  }
}

// ---------------------------------------------------------------------------------------------------- compose
/** The house show a composed endshow plays (by tempo: hardcore above 166 BPM). */
export const composeShow = (bpm: number) => (bpm >= 166 ? 'hardcore_mainstage' : 'hardstyle_mainstage');

/** Compose an endshow: `template`, the host's tracks (bars each; null = the template's arrangement), the room. */
export function composeEndshow(template: ComposeTemplate, tracks: number[] | null, room: ComposeRoom, o: Partial<ComposeState> = {}): FestivalScript {
  const st: ComposeState = { ...DEFAULT_COMPOSE, ...o, t: template, min: o.min ?? COMPOSE_MINUTES[template][0] };
  const bars = Math.max(64, Math.round((st.min * st.bpm) / 4 / 8) * 8);
  const arr = arrange(template, bars, st.anthem, tracks ?? st.tracks ?? null, st.bpm);
  const g = pickGroups(room);
  const parts: FestivalScriptPart[] = [], cues: FestivalScriptCue[] = [];
  // (the show's length: the blocks as walked - every part and cue inside it, the minutes in its name what plays)
  const blocks = arr.map((t) => trackBlocks(t));
  const total = blocks.reduce((a, bl) => a + bl.reduce((n, b) => n + b.bars, 0), 0);
  let bar = 0;
  arr.forEach((t, ti) => {
    for (const b of blocks[ti]) {
      // (the finale's drops: the moving heads step back to 55 % - the sky is the comets' and the shells')
      parts.push({ bar, section: b.section, master: Math.round(b.master * 100) / 100, ...(t.role === 'finale' && b.kind === 'drop' ? { beams: 0.55 } : {}) });
      blockCues({ ...b, bar }, t, bar / total, g, st.seed, ti, cues);
      bar += b.bars;
    }
  });
  // the last salvo (the finale's final bar before the outro): every shell, a sunburst, a curtain, the whole fire line
  const outroAt = parts.length && parts[parts.length - 1].section === 'outro' ? parts[parts.length - 1].bar : bar;
  const salvo = outroAt - 1;
  if (salvo > 0) {
    // (bursts stay >= 2 beats apart: <= 2 a second at 230 BPM)
    if (g.shells) for (let k = 0; k < 4; k++) {
      const at = (salvo - 2 + Math.floor(k / 2)) * 4 + (k % 2) * 2;
      for (let i = cues.length - 1; i >= 0; i--) if (cues[i].kind === 'firework' && Math.abs(cues[i].bar * 4 + cues[i].at - at) < 2) cues.splice(i, 1);
      cues.push({ kind: 'firework', group: g.shells, bar: salvo - 2 + Math.floor(k / 2), at: (k % 2) * 2, dur: 1, power: 1.4, side: (k % 2 ? 1 : -1) as -1 | 1, style: k === 3 ? 'willow' : undefined } as FestivalScriptCue);
    }
    if (g.roof ?? g.comets) cues.push({ kind: 'comet', group: (g.roof ?? g.comets)!, bar: salvo, at: 0, dur: 1, power: 1.2, style: 'sunburst' });
    if (g.line) cues.push({ kind: 'flame', group: g.line, bar: salvo, at: 0, dur: 2, power: 1.3 });
  }
  for (const c of cues) if (c.style === undefined) delete c.style;
  cues.sort((a, b) => a.bar * 4 + a.at - (b.bar * 4 + b.at));
  const id = `composed_${template}`;
  return { id, name: `${templateLabel(template)} (${Math.round((total * 4 * 60) / st.bpm / 60)} min)`, bars: total, parts, cues, show: composeShow(st.bpm), house: true, camGrammar: true };
}

// ---------------------------------------------------------------------------------------------------- validators
export interface EndshowCheck { ok: boolean; problems: string[]; stats: { bars: number; cues: number; parts: number; drops: number; finaleDensity: number; maxEarlierDensity: number; firstShellAt: number } }
/** the light level of every bar (the part's master) */
export function levelByBar(s: FestivalScript): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.parts.length; i++) { const p = s.parts[i], end = i + 1 < s.parts.length ? s.parts[i + 1].bar : s.bars; for (let b = p.bar; b < end; b++) out[b] = p.master ?? 1; }
  return out;
}
/** Check a script against the endshow rules (any script: composed or hand-made). */
export function validateEndshow(s: FestivalScript): EndshowCheck {
  const problems: string[] = [];
  const lv = levelByBar(s);
  // 1. contrast: every drop (a drop part after a non-drop part) has >= 1 bar at <= 0.2 within the 8 bars before it
  let drops = 0;
  s.parts.forEach((p, i) => {
    if (p.section !== 'drop' || (p.master ?? 1) < 0.7 || (i > 0 && s.parts[i - 1].section === 'drop')) return;
    drops++;
    let valley = false;
    for (let b = Math.max(0, p.bar - 8); b < p.bar; b++) if ((lv[b] ?? 1) <= 0.2) valley = true;
    if (!valley && p.bar > 0) problems.push(`no valley before the drop at bar ${p.bar}`);
  });
  // 2. no high shells before 40 %
  const firstShell = s.cues.filter((c) => c.kind === 'firework').sort((a, b) => a.bar * 4 + a.at - (b.bar * 4 + b.at))[0];
  const firstShellAt = firstShell ? firstShell.bar / s.bars : 1;
  if (firstShellAt < 0.4) problems.push(`a shell at bar ${firstShell!.bar} (${Math.round(firstShellAt * 100)} % < 40 %)`);
  // 3. the finale is the densest: cues per bar over each run of drop parts (the peaks); the finale = the drop runs after
  //    the last near-dark break (else the last run) - at least 1.5 x denser than any earlier run
  const runs: [number, number][] = [];
  s.parts.forEach((p, i) => {
    if (p.section !== 'drop') return;
    const end = i + 1 < s.parts.length ? s.parts[i + 1].bar : s.bars;
    if (i > 0 && s.parts[i - 1].section === 'drop' && runs.length) runs[runs.length - 1][1] = end; else runs.push([p.bar, end]);
  });
  const dens = (a: number, b: number) => s.cues.filter((c) => c.bar >= a && c.bar < b).length / Math.max(1, b - a);
  const lastBreak = [...s.parts].reverse().find((p) => (p.master ?? 1) <= 0.06 && runs.some(([a]) => a > p.bar));
  const finRuns = runs.filter(([a]) => (lastBreak ? a > lastBreak.bar : a === runs[runs.length - 1]?.[0]));
  const finA = finRuns.length ? finRuns[0][0] : s.bars, finB = finRuns.length ? finRuns[finRuns.length - 1][1] : s.bars;
  const finD = finRuns.length ? s.cues.filter((c) => finRuns.some(([a, b]) => c.bar >= a && c.bar < b)).length / Math.max(1, finRuns.reduce((n, [a, b]) => n + b - a, 0)) : 0;
  const earlier = runs.filter(([, b]) => b <= finA).map(([a, b]) => dens(a, b));
  const maxEarlier = earlier.length ? Math.max(...earlier) : 0;
  void finB;
  if (earlier.length && finD < 1.5 * maxEarlier) problems.push(`the finale (${finD.toFixed(2)} cues / bar) is not 1.5 x denser than an earlier drop run (${maxEarlier.toFixed(2)})`);
  // 4. <= 1 flame volley (a flame step on a whole group, no chase) per bar in drops
  const volleys = new Map<number, number>();
  for (const c of s.cues) if (c.kind === 'flame' && !c.order && c.power >= 1.2) volleys.set(c.bar, (volleys.get(c.bar) ?? 0) + 1);
  // (one volley = every flame group firing together on one beat)
  const perBar = new Map<number, Set<number>>();
  for (const c of s.cues) if (c.kind === 'flame' && !c.order && c.power >= 1.2) { const k = perBar.get(c.bar) ?? new Set(); k.add(c.at); perBar.set(c.bar, k); }
  for (const [b, beats] of perBar) if (beats.size > 1) problems.push(`${beats.size} flame volleys in bar ${b}`);
  void volleys;
  // 5. everything inside the show: a part or a cue at / past its last bar never plays (the endshow ends there)
  for (const p of s.parts) if (p.bar >= s.bars) problems.push(`a part at bar ${p.bar} - past the show's ${s.bars} bars`);
  const late = s.cues.filter((c) => c.bar * 4 + c.at >= s.bars * 4);
  if (late.length) problems.push(`${late.length} cue(s) past the show's ${s.bars} bars (the first at bar ${late[0].bar})`);
  // 6. shell bursts >= 2 beats apart (<= 2 a second at 230 BPM: a burst lights the whole sky)
  const shells = s.cues.filter((c) => c.kind === 'firework').map((c) => c.bar * 4 + c.at).sort((a, b) => a - b);
  for (let i = 1; i < shells.length; i++) if (shells[i] - shells[i - 1] < 2) { problems.push(`two shell bursts ${(shells[i] - shells[i - 1]).toFixed(2)} beats apart at bar ${Math.floor(shells[i] / 4)}`); break; }
  return { ok: !problems.length, problems, stats: { bars: s.bars, cues: s.cues.length, parts: s.parts.length, drops, finaleDensity: +finD.toFixed(3), maxEarlierDensity: +maxEarlier.toFixed(3), firstShellAt: +firstShellAt.toFixed(3) } };
}
