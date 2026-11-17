// VTube Pro Live, W1: the Go Live rule (graft G1), as pure functions. No I/O, no clock of its own (the caller passes `now`),
// no state. Implements BroadcastPolicyApi from shared/broadcastTypes.ts (the frozen contract) and imports nothing else.
//
// The rule: a stream starts ONLY on a deliberate person's click in the studio (or a Stream Deck key the person confirmed
// on screen within DECK_CONFIRM_MS), carrying a fresh single-use intent token bound to the exact plan the confirm card
// showed. Everything else is refused: MCP tools, autopilot, schedules, relay messages, updates, CLI flags, macros,
// unconfirmed deck keys and anything unknown. The single exception is auto-resume of a session the person started
// (RESUME_WINDOW_MS, RESUME_MAX_PER_HOUR).
//
// Two stages, one function (checkIntent dispatches on what is presented):
//   ISSUE  (grant === null and presentedToken === null): source, origin, trusted gesture, deck confirm, other broadcaster.
//   REDEEM (a token is presented, or a grant is held): origin, source match, token existence / replay / expiry / plan
//          match, then the other broadcaster and "already live". Refused-source and origin checks come first so a
//          forbidden caller is never told anything about the token.
// W2 should call checkIntentIssue / checkIntentRedeem directly when it knows the stage (a /start with NO token must be
// passed to checkIntentRedeem, because checkIntent cannot tell "no token on /start" from "issuing" when both are null).

import {
  DECK_CONFIRM_MS, INTENT_TTL_MS, RESUME_MAX_PER_HOUR, RESUME_WINDOW_MS,
} from './broadcastTypes.ts';
import type {
  BroadcastPolicyApi, GoLivePlan, IntentCheckInput, IntentSource, IntentVerdict,
} from './broadcastTypes.ts';

const refuse = (code: Extract<IntentVerdict, { ok: false }>['code'], say: string, status: 403 | 409 = 403): IntentVerdict =>
  ({ ok: false, code, say, status });
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Sources that may ever start something: a click, a confirmed deck key, and the resume rule. Anything else (including
 *  strings that are not an IntentSource at all) never starts. */
export function mayStart(source: IntentSource): boolean {
  return source === 'click' || source === 'deck-confirmed' || source === 'crash-resume';
}

/** Stable JSON of a plan: ids sorted and de-duplicated, fixed key order, optional flags normalized to booleans. W2 hashes this. */
export function canonicalPlan(p: GoLivePlan): string {
  const destIds = Array.from(new Set(Array.isArray(p.destIds) ? p.destIds.map(String) : [])).sort();
  return JSON.stringify({
    destIds, title: String(p.title ?? ''), category: String(p.category ?? ''),
    dryRun: p.dryRun === true, record: p.record === true,
  });
}

const PAGE_ORIGINS = new Set(['local-page']);

/** Checks every request shares: who is asking and which source they claim. Returns a refusal or null. */
function commonRefusal(i: IntentCheckInput): IntentVerdict | null {
  if (i.origin === 'foreign-web') {
    return refuse('foreign-origin', 'This page is not your VTube Pro studio, so it cannot start a stream.');
  }
  if (!mayStart(i.source)) {
    if (i.source === 'deck-unconfirmed') {
      return refuse('not-confirmed', 'Your Stream Deck key was pressed but not confirmed on screen. Confirm it in the studio to go live.');
    }
    return refuse('source-not-allowed', 'Only you, with a click on Go Live in the studio, can start a stream. Nothing else is allowed to.');
  }
  if (i.source === 'crash-resume') {
    // Resume is the Helper's own act (no page involved): this PC's page or the Helper itself, never another website.
    if (i.origin !== 'local-page' && i.origin !== 'tool') {
      return refuse('source-not-allowed', 'Only VTube Pro on this PC can pick a stream back up after a crash.');
    }
  } else if (!PAGE_ORIGINS.has(i.origin)) {
    // click / deck-confirmed come from a studio page; a program with no page cannot click.
    return refuse('source-not-allowed', 'A program cannot press Go Live for you. Press the Go Live button in the studio yourself.');
  }
  return null;
}

function stateRefusal(i: IntentCheckInput, checkAlreadyLive: boolean): IntentVerdict | null {
  if (i.otherBroadcasterLive === true) {
    return refuse('other-live', 'Your other broadcaster is already live. Stop it first so you are not live twice.', 409);
  }
  if (checkAlreadyLive && i.alreadyLive) {
    return refuse('already-live', 'You are already live.', 409);
  }
  return null;
}

/** Auto-resume of a session the person started: no click, no token, strict window and rate. */
function resumeVerdict(i: IntentCheckInput): IntentVerdict {
  const r = i.resume;
  if (!r || !finite(r.lastAliveAt) || !finite(r.resumesInLastHour)) {
    return refuse('source-not-allowed', 'There is no earlier stream of yours to pick back up.');
  }
  if (!r.journalStartedByPerson) {
    return refuse('source-not-allowed', 'That stream was not started by you, so it will not be restarted by itself.');
  }
  const age = i.now - r.lastAliveAt;
  if (age > RESUME_WINDOW_MS) {
    return refuse('source-not-allowed', 'Your stream was down for too long to pick back up by itself. Press Go Live to start again.');
  }
  if (r.resumesInLastHour >= RESUME_MAX_PER_HOUR) {
    return refuse('source-not-allowed', 'Your stream already came back by itself a few times this hour. Press Go Live to start again.');
  }
  const st = stateRefusal(i, true);
  return st ?? { ok: true, source: 'crash-resume' };
}

/** Stage 1: the confirm card opened; may a token be issued? */
export function checkIntentIssue(i: IntentCheckInput): IntentVerdict {
  const c = commonRefusal(i);
  if (c) return c;
  if (i.source === 'crash-resume') return resumeVerdict(i);
  if (!i.gesture || i.gesture.trusted !== true || !finite(i.gesture.at)) {
    return refuse('source-not-allowed', 'Go Live only works from a real click in the studio.');
  }
  if (i.source === 'deck-confirmed') {
    const d = i.deckPressedAt;
    if (!finite(d) || d > i.now) {
      return refuse('not-confirmed', 'Your Stream Deck key was not confirmed on screen. Press it again and confirm.');
    }
    const wait = i.gesture.at - d;
    // the click must come within DECK_CONFIRM_MS of the key press, AND the key press itself must not be older than that on the
    // Helper's own clock (the client's timestamps alone are not trusted to prove it)
    if (wait < 0 || wait > DECK_CONFIRM_MS || i.now - d > DECK_CONFIRM_MS) {
      return refuse('not-confirmed', 'You took too long to confirm the Stream Deck key. Press it again and confirm quickly.');
    }
  }
  const st = stateRefusal(i, false);
  return st ?? { ok: true, source: i.source };
}

/** Stage 2: the person pressed Start on the card; may the token be redeemed? */
export function checkIntentRedeem(i: IntentCheckInput): IntentVerdict {
  const c = commonRefusal(i);
  if (c) return c;
  if (i.source === 'crash-resume') return resumeVerdict(i);
  const g = i.grant;
  if (!i.presentedToken) {
    return refuse('no-token', 'This start needs your approval first. Press Go Live and confirm.');
  }
  if (!g) {
    return refuse('no-token', 'That approval is not valid any more. Press Go Live again.');
  }
  if (g.used) {
    return refuse('token-replayed', 'That approval was already used. Press Go Live again.');
  }
  if (i.now >= g.expiresAt || i.now - g.issuedAt > INTENT_TTL_MS) {
    return refuse('token-expired', 'That approval ran out of time. Press Go Live again.');
  }
  if (g.token !== i.presentedToken) {
    return refuse('token-mismatch', 'That approval does not match. Press Go Live again.');
  }
  if (g.source !== i.source) {
    return refuse('token-mismatch', 'That approval was given for something else. Press Go Live again.');
  }
  if (g.planHash !== i.presentedPlanHash) {
    return refuse('token-mismatch', 'What you are starting changed after you approved it. Press Go Live and confirm again.');
  }
  if (i.source === 'deck-confirmed' && i.deckPressedAt !== undefined) {
    // The deck evidence is optional on redeem (the grant already proves it was checked at issue) but must be sane if sent.
    const d = i.deckPressedAt;
    if (!finite(d) || d > i.now) return refuse('not-confirmed', 'Your Stream Deck key was not confirmed on screen.');
  }
  const st = stateRefusal(i, true);
  return st ?? { ok: true, source: i.source };
}

/** BroadcastPolicyApi.checkIntent: redeem when a token is presented or a grant is held, otherwise issue. */
export function checkIntent(i: IntentCheckInput): IntentVerdict {
  if (i.source === 'crash-resume') {
    const c = commonRefusal(i);
    return c ?? resumeVerdict(i);
  }
  return i.presentedToken !== null || i.grant !== null ? checkIntentRedeem(i) : checkIntentIssue(i);
}

// Compile-time proof that the named exports satisfy the contract.
const _api: BroadcastPolicyApi = { checkIntent, canonicalPlan, mayStart };
void _api;
