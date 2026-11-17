// Pro2D → 3D job: the state on the helper (resumable from any new chat) and the pure rules on it (lane to3d,
// docs/PRO2D_TO_3D.md). No node / DOM imports: the helper, the studio drawer and tools/to3d_unit.ts share it.
//   * nextStep(job): the ONE thing the AI does next ({tool, args, why}); every to3d tool returns it.
//   * isBetter / bestRound: the revert rule = a round whose review FAILS or that makes ANY checklist line worse than the
//     best round is never the best (the score alone never throws away a better face; silhouette IoU is not quality).
//   * canSubmit: review not FAIL, real app renders (not approximate), the 11-line checklist + 8 angles answered.
export const TO3D_LIMITS = { maxRounds: 10, maxMs: 2 * 60 * 60 * 1000, waitMs: 40_000, staleCallMs: 3 * 60_000 } as const;

/** FACE_CREATION.md §8: the self-review checklist (answer every line yes before showing anyone). */
export const CHECKLIST = [
  'At 128 px, can you tell the sex, age and mood?',
  'Eyes at / below the head midline (anime)?',
  'Each eye: lid overlap, lid shadow on the white, iris gradient, matching catchlights?',
  'Upper lash line the darkest, heaviest mark, tapering right (wing on girls)?',
  'Brows: girls thin + high, boys thick + low, colour = hair shade?',
  'Nose minimal?',
  'Mouth small? Teeth flat and drawn (never 3D)?',
  'Shadows single clean shapes, no blotch around nose / mouth / sockets?',
  'No black lines, no grey shadows?',
  'Blink, smile, surprise, aa / oo / ee / ff clean at front AND 3/4 (no lid clipping, no lash folding)?',
  'Side by side with the 2D at identical framing: the 3 biggest differences listed and worked on?',
] as const;

/** The 8 review angles (yaw degrees): ±90, ±135 and 180 included (house rule: 8+ angles). */
export const ANGLES = [0, 45, 90, 135, 180, -135, -90, -45] as const;

export type Phase = 'created' | 'bundling' | 'bundled' | 'running' | 'iterating' | 'waiting_for_ok' | 'importing' | 'done' | 'stopped' | 'failed';
export type Review = 'PASS' | 'WARN' | 'FAIL';
export type Lever = 'baseline' | 'rebuild' | 'graft' | 'revert';

export interface RegionScores { iou?: Record<string, number>; dE?: Record<string, number>; lm?: Record<string, number> }
export interface Scores { total: number; views: Record<string, RegionScores>; worst?: { region: string; view: string; why: string; lever: string } | null }

export interface Check {
  at: number;
  /** renders came from the Blender toon stand-in, not the app renderer: never enough to submit */
  approximate: boolean;
  views: string[];
  sheets: string[];
  scores: Scores | null;
  review: Review | null;
  reviewNotes: string[];
}

export interface RoundNote { at: number; text: string; checklist: boolean[] | null; angles: Record<string, boolean> | null; gaps: string[] }

export interface Round {
  n: number;
  from: number | null;
  lever: Lever;
  mode: 'full' | 'hair' | 'springs' | 'profile' | 'graft';
  overrides: Record<string, string | number | boolean>;
  parts: string[];
  status: 'running' | 'ready' | 'failed';
  error?: string;
  startedAt: number;
  endedAt?: number;
  check?: Check;
  note?: RoundNote;
}

export interface JobStep { name: string; text: string; progress: number; at: number }

export interface To3dJob {
  id: string;
  version: 1;
  avatarId: string;
  avatarName: string;
  vtp2Sha256: string;
  createdAt: number;
  updatedAt: number;
  client: 'claude' | 'chatgpt' | null;
  consent: { ownership: true; at: number; rightsNote: string | null; sampleNote: boolean };
  base: { kind: 'sample' | 'user' | 'auto'; key: string | null; file: string | null };
  route: 'vtp2' | 'image';
  phase: Phase;
  step: JobStep | null;
  error: string | null;
  rounds: Round[];
  best: number | null;
  current: number | null;
  notes: { at: number; text: string }[];
  knownGaps: string[];
  lastToolCallAt: number | null;
  lastClient: string | null;
  baselineDoneAt: number | null;
  approval: { state: 'waiting' | 'approved' | 'denied'; at: number; round: number; reason?: string } | null;
  submitted: { avatarId: string; at: number } | null;
  vision: { code: string; ok: boolean | null } | null;
  /** the round limit for this job (default TO3D_LIMITS.maxRounds; tests set a smaller one) */
  maxRounds?: number;
}

export interface NextStep { tool: string | null; args: Record<string, unknown>; why: string }

const yes = (n?: RoundNote | null) => (n?.checklist ?? []).filter(Boolean).length;
export const lastRound = (j: To3dJob): Round | null => j.rounds[j.rounds.length - 1] ?? null;
export const roundOf = (j: To3dJob, n: number | null | undefined): Round | null => (n === null || n === undefined ? null : j.rounds.find((r) => r.n === n) ?? null);

/** Is round a better candidate than round b (b = the current best)? The revert rule lives here. */
export function isBetter(a: Round, b: Round | null): boolean {
  if (a.status !== 'ready' || !a.check || a.check.review === 'FAIL') return false;
  if (!b || !b.check) return true;
  const an = a.note?.checklist, bn = b.note?.checklist;
  if (an && bn) {
    for (let i = 0; i < Math.min(an.length, bn.length); i++) if (bn[i] && !an[i]) return false;   // a line got worse
    if (yes(a.note) !== yes(b.note)) return yes(a.note) > yes(b.note);
  }
  if (b.check.review === 'FAIL') return true;
  return (a.check.scores?.total ?? 0) >= (b.check.scores?.total ?? 0) - 0.5;
}

/** Recompute the best round over every checked round (in order). */
export function bestRound(j: To3dJob): number | null {
  let best: Round | null = null;
  for (const r of j.rounds) if (isBetter(r, best)) best = r;
  return best?.n ?? null;
}

/** Should the newest round be reverted (it lost a checklist line, or its review fails)? */
export function shouldRevert(j: To3dJob): boolean {
  const r = lastRound(j), b = roundOf(j, j.best);
  if (!r || !r.check || !r.note || !b || b.n === r.n) return false;
  if (r.check.review === 'FAIL') return true;
  const an = r.note.checklist ?? [], bn = b.note?.checklist ?? [];
  return bn.some((v, i) => v && !an[i]);
}

export function timeUp(j: To3dJob, now: number): boolean {
  return !!j.baselineDoneAt && now - j.baselineDoneAt > TO3D_LIMITS.maxMs;
}
export const roundsUsed = (j: To3dJob) => j.rounds.filter((r) => r.lever !== 'baseline' && r.lever !== 'revert').length;
/** An AI that can't see pictures (vision check failed) works by the numbers only: fewer rounds, the user judges at Approve. */
export const numbersOnly = (j: To3dJob) => j.vision?.ok === false;
export const roundLimit = (j: To3dJob) => Math.min(numbersOnly(j) ? 4 : Infinity, j.maxRounds ?? TO3D_LIMITS.maxRounds);
/** The round or time limit is reached: hand in what there is. */
export const atLimit = (j: To3dJob, now = Date.now()) => roundsUsed(j) >= roundLimit(j) || timeUp(j, now);

/** The round to hand in: the best one; when NO round passes the review, the least-bad checked one (highest total). */
export function handInRound(j: To3dJob): number | null {
  if (j.best !== null && j.best !== undefined) return j.best;
  const checked = j.rounds.filter((r) => r.status === 'ready' && r.check && !r.check.approximate);
  if (!checked.length) return null;
  return checked.reduce((a, b) => ((b.check!.scores?.total ?? 0) >= (a.check!.scores?.total ?? 0) ? b : a)).n;
}

/** Why a round can't be submitted (null = it can). */
export function submitProblem(j: To3dJob, n: number, now = Date.now()): string | null {
  const r = roundOf(j, n);
  if (!r) return `There is no round ${n}.`;
  if (r.status !== 'ready') return `Round ${n} is not finished.`;
  if (!r.check) return `Round ${n} has not been checked yet: call to3d_check first.`;
  if (r.check.approximate) return `Round ${n} was only checked with approximate renders. Run to3d_check again when the app renderer is available.`;
  // a review FAIL is handed in only at the limits when no round passes: every problem goes on the approval page and the
  // user decides with the pictures in front of them
  if (r.check.review === 'FAIL' && !(atLimit(j, now) && j.best === null && handInRound(j) === n)) return `Round ${n}'s review FAILS. Submit a round that passes (the best is ${j.best ?? 'none yet'}).`;
  if (numbersOnly(j)) return null;   // can't judge pictures: the user does, on the approval page
  if (!r.note || !r.note.checklist || r.note.checklist.length !== CHECKLIST.length) return `Write round ${n}'s note with all ${CHECKLIST.length} checklist answers (to3d_note).`;
  const angles = r.note.angles ?? {};
  const missing = ANGLES.filter((a) => typeof angles[String(a)] !== 'boolean');
  if (missing.length) return `Round ${n}'s note needs a pass / fail for every angle (missing ${missing.join(', ')}).`;
  const base = j.rounds.find((x) => x.lever === 'baseline' && x.check);
  if (base && base.n !== n && base.check?.scores && r.check.scores && r.check.scores.total + 2 < base.check.scores.total && !isBetter(r, base)) {
    return `Round ${n} scores below the baseline. Submit the best round (${j.best}) or the baseline.`;
  }
  return null;
}

/** The ONE next thing to do. Deterministic from the job, so any new chat can resume. */
export function nextStep(j: To3dJob, now = Date.now()): NextStep {
  const id = j.id;
  switch (j.phase) {
    case 'done': return { tool: null, args: {}, why: `Done: "${j.avatarName} (3D)" is in the library. Tell the user what you made and the known gaps.` };
    case 'stopped': return { tool: null, args: {}, why: 'The user stopped this job. Stop and tell them you stopped.' };
    case 'failed': return { tool: null, args: {}, why: `The job failed: ${j.error ?? 'unknown error'}. Tell the user in one sentence.` };
    case 'created': case 'bundling': return { tool: 'to3d_wait', args: { jobId: id }, why: 'VTube Pro is reading the 2D model.' };
    case 'waiting_for_ok': return { tool: 'to3d_wait', args: { jobId: id }, why: 'Waiting for the user to press Approve in VTube Pro. Poll every 30 s, at most 10 minutes.' };
    case 'importing': return { tool: 'to3d_wait', args: { jobId: id }, why: 'Adding it to the library.' };
    default: break;
  }
  const last = lastRound(j);
  if (!last) return { tool: 'to3d_baseline', args: { jobId: id }, why: 'Make the deterministic first pass (round 0).' };
  if (last.status === 'running') return { tool: 'to3d_wait', args: { jobId: id }, why: `Round ${last.n} is being built.` };
  if (last.status === 'failed') {
    if (last.lever === 'baseline') return { tool: 'to3d_baseline', args: { jobId: id, route: 'image' }, why: `The baseline failed (${last.error ?? '?'}). Try the picture route once; if that fails too, stop and tell the user.` };
    return { tool: 'to3d_revert', args: { jobId: id, round: j.best ?? 0 }, why: `Round ${last.n} failed (${last.error ?? '?'}). Go back to the best round and try a different lever.` };
  }
  if (!last.check) return { tool: 'to3d_check', args: { jobId: id, round: last.n }, why: `Render round ${last.n} from 8 angles + the expression sheet, compare it with the 2D references and review it (one call).` };
  if (!last.note && !numbersOnly(j)) return { tool: 'to3d_note', args: { jobId: id, round: last.n }, why: `Look at round ${last.n}'s renders and write its note: what changed, the 11 checklist answers, pass / fail per angle, gaps.` };
  if (shouldRevert(j)) return { tool: 'to3d_revert', args: { jobId: id, round: j.best }, why: `Round ${last.n} made a checklist line worse or fails review: go back to round ${j.best}, then try another lever.` };
  const stop = roundsUsed(j) >= roundLimit(j) || timeUp(j, now) || stopEarly(j);
  if (stop) {
    const n = handInRound(j) ?? 0;
    const p = submitProblem(j, n, now);
    if (p) return { tool: p.includes('to3d_check') ? 'to3d_check' : 'to3d_note', args: { jobId: id, round: n }, why: p };
    if (j.best === null) return { tool: 'to3d_submit', args: { jobId: id, round: n }, why: `No round passes the automatic review and the ${timeUp(j, now) ? 'two hours are' : 'round limit is'} up: hand in round ${n} (the least bad) with EVERY review problem written as a gap in its note. The user sees them on the approval page and decides.` };
    return { tool: 'to3d_submit', args: { jobId: id, round: n }, why: roundsUsed(j) >= roundLimit(j) ? 'Round limit reached: submit the best round with its gaps written down.' : timeUp(j, now) ? 'Two hours are up: submit the best round with its gaps written down.' : 'Every check passes and the last rounds stopped improving: submit the best round.' };
  }
  const w = last.check.scores?.worst;
  return { tool: 'to3d_rebuild', args: { jobId: id, from: j.best ?? last.n }, why: w ? `Fix the worst region next: ${w.region} (${w.view}: ${w.why}). Usual lever: ${w.lever}. Follow the fix order in the pack.` : 'Fix the next region in the pack\'s fix order.' };
}

/** All checks pass and the last two rounds improved the total by < 1 point. */
export function stopEarly(j: To3dJob): boolean {
  const b = roundOf(j, j.best);
  if (!b?.check || !b.note?.checklist) return false;
  if (b.check.review === 'FAIL' || b.note.checklist.some((x) => !x)) return false;
  if (Object.values(b.note.angles ?? {}).some((x) => !x)) return false;
  const checked = j.rounds.filter((r) => r.check?.scores);
  if (checked.length < 3) return false;
  const t = checked.slice(-3).map((r) => r.check!.scores!.total);
  return t[2] - t[0] < 1;
}

/** The fields a paired web page may see (no paths, no notes' free text beyond the round summary). */
export function publicJob(j: To3dJob) {
  const r = lastRound(j);
  return {
    id: j.id, avatarId: j.avatarId, avatarName: j.avatarName, phase: j.phase, client: j.client, step: j.step, error: j.error,
    rounds: j.rounds.map((x) => ({ n: x.n, lever: x.lever, status: x.status, review: x.check?.review ?? null, total: x.check?.scores?.total ?? null, approximate: x.check?.approximate ?? null, worst: x.check?.scores?.worst?.region ?? null })),
    best: j.best, current: j.current, roundsUsed: roundsUsed(j), maxRounds: roundLimit(j),
    lastToolCallAt: j.lastToolCallAt, approval: j.approval, submitted: j.submitted, knownGaps: j.knownGaps,
    working: r ? `Round ${r.n}${r.check?.scores?.worst ? `: now working on ${r.check.scores.worst.region}` : ''}` : null,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}
