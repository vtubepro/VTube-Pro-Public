// beta.16 "rules" lane, helper side (docs/b16/RULES.md, docs/b16/LANES.md): Redeems & Reactions for the avatar.
//
// The engine itself lives in the studio page (src/rules/*: it owns SceneState and the bus). This file is the part that must
// live in the helper:
//   * the rule list on disk (config/rules.json) - host-wide, survives studio reloads and web-studio visits;
//   * the helper end of the trigger bus: anything the server notices (from other lanes, or a tool's POST /api/rules/trigger) calls
//     emitRuleTrigger(); we forward it as the bus command `rule-trigger` to the studio's engine (setRuleForwarder);
//   * the helper end of a step: the studio asks us to run an old Stream Deck action (or a rule action registered here)
//     through the same runner the deck uses, so a rule can do anything a deck key can.
//
//   GET  /api/rules                -> { rules, seeded }             the list (the ten starter rules, OFF, until saved once)
//   PUT  /api/rules {rules}        -> { rules }                     save (cleaned: bounded, known fields only) + tell the studio
//   POST /api/rules/run/:id        -> { ok }                        "Try it": runs one rule for real, posts nothing anywhere
//   POST /api/rules/trigger {event}-> { ok, result }                a tool (Companion, Touch Portal, curl) says something happened
//   POST /api/rules/step {action, params, test?, depth?} -> { ok, error?, undo? }   the studio's fallback runner
//   GET  /api/rules/actions        -> { actions }                   rule actions registered in the helper
//
// Same trust as the Stream Deck routes: loopback only, loopback Origin. Never writes anywhere but
// config/rules.json; never talks to a platform.
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Router, type Request } from 'express';
import type { B16ServerCtx } from './b16/mount.ts';
import { broadcast, busOriginOk } from './bus.ts';
import { HttpError } from './library.ts';
import { CONFIG_DIR } from './paths.ts';
import { requireLocal } from './routes/util.ts';
import { starterRules } from '../src/rules/starters.ts';
import {
  MAX_RULE_DEPTH, MAX_RULES, RULES_FILE_VERSION, RULE_DENIED_ACTIONS, RULE_TRIGGER_COMMAND, emitRuleTrigger, getRuleAction, listRuleActions, sanitizeRuleEvent, sanitizeRules, setRuleForwarder,
  type RuleEvent, type StreamRule,
} from '../shared/streamRules.ts';

const FILE = path.join(CONFIG_DIR, 'rules.json');

/** Bus command the helper sends when the list changed from outside the studio page (a REST save, a file import in another tab). */
export const RULES_CHANGED_COMMAND = 'rules-changed';

export interface RulesFile { rules: StreamRule[]; seeded: boolean }

/** The saved list. No file yet = the ten starter rules, all OFF (seeded: false until the first save). */
export function readRules(file = FILE): RulesFile {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { vtprules?: unknown; rules?: unknown };
    if (j && j.vtprules === RULES_FILE_VERSION) return { rules: sanitizeRules(j.rules), seeded: true };
  } catch { /* none yet, or unreadable: start from the starters */ }
  return { rules: starterRules(), seeded: false };
}

/** Save the list (cleaned). Returns what was stored. Atomic: a crash never leaves half a file. */
export function writeRules(rules: unknown, file = FILE): StreamRule[] {
  const clean = sanitizeRules(rules).slice(0, MAX_RULES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ vtprules: RULES_FILE_VERSION, rules: clean }, null, 1));
  fs.renameSync(tmp, file);
  return clean;
}

// ---------------------------------------------------------------- routes
const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function guard(req: Request | IncomingMessage) {
  if (!LOOP_HOST.test(String(req.headers.host ?? ''))) throw new HttpError(403, 'Loopback host only');   // DNS rebinding
  const origin = req.headers.origin;
  if (origin && !busOriginOk(origin)) throw new HttpError(403, 'Only VTube Pro pages on this PC may use this');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request refused');
}
const G = (req: Request) => { requireLocal(req); guard(req); };
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export const rulesRoutes = Router();

rulesRoutes.get('/api/rules', (req, res) => { G(req); res.json(readRules()); });

rulesRoutes.put('/api/rules', (req, res) => {
  G(req);
  const b = (req.body ?? {}) as { rules?: unknown };
  if (!Array.isArray(b.rules)) throw new HttpError(400, 'Send {"rules": [...]}');
  const rules = writeRules(b.rules);
  broadcast({ type: 'command', command: RULES_CHANGED_COMMAND, args: {} } as Parameters<typeof broadcast>[0]);
  res.json({ rules });
});

/** Try it / the "run rule" button of a tool: the rule runs for real (that is the point of testing it), nothing is posted anywhere. */
rulesRoutes.post('/api/rules/run/:id', (req, res) => {
  G(req);
  const id = String(req.params.id);
  if (!/^[A-Za-z0-9_-]{1,48}$/.test(id)) throw new HttpError(400, 'Bad rule id');
  if (!readRules().rules.some((r) => r.id === id)) throw new HttpError(404, 'No such rule');
  const e: RuleEvent = { kind: 'manual', id: `try-${id}-${Date.now().toString(36)}`, ts: Date.now(), rule: id, test: true };
  res.json({ ok: true, ...emitRuleTrigger(e) });
});

rulesRoutes.post('/api/rules/trigger', (req, res) => {
  G(req);
  const e = sanitizeRuleEvent((req.body as { event?: unknown } | undefined)?.event ?? req.body);
  if (!e) throw new HttpError(400, 'Not a rule event (see docs/b16/RULES.md)');
  res.json({ ok: true, result: emitRuleTrigger({ ...e, depth: 0 }) });
});

/** The studio's fallback: run one step here. A rule action registered in the helper by another lane wins; every other id is a Stream Deck action. */
rulesRoutes.post('/api/rules/step', async (req, res) => {
  G(req);
  const b = (req.body ?? {}) as { action?: unknown; params?: unknown; test?: unknown; depth?: unknown; rule?: unknown };
  const action = typeof b.action === 'string' ? b.action : '';
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(action)) throw new HttpError(400, 'Bad action');
  if (RULE_DENIED_ACTIONS.includes(action)) throw new HttpError(403, 'Going live can only be started on screen');
  const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params as Record<string, string | number | boolean> : {};
  const reg = getRuleAction(action);
  if (reg) {
    const depth = Math.round(num(b.depth, 0, MAX_RULE_DEPTH, 0));
    const rule = typeof b.rule === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(b.rule) ? b.rule : undefined;
    const event: RuleEvent = { kind: 'manual', id: `step-${Date.now().toString(36)}`, ts: Date.now(), depth, ...(rule ? { via: rule } : {}), ...(b.test === true ? { test: true } : {}) };
    try {
      const r = await reg.handler({ rule: null, event, step: { action, params }, params, depth, test: b.test === true, now: Date.now() });
      res.json(r && typeof r === 'object' ? { ok: r.ok !== false, ...(r.error ? { error: r.error } : {}), ...(r.undo ? { undo: r.undo } : {}) } : { ok: true });
    } catch (err) { res.json({ ok: false, error: (err as Error).message || 'failed' }); }
    return;
  }
  const { runAction } = await import('./deck.ts');   // (loaded on first use: the deck module starts its own timers and sockets)
  const r = runAction(action, params);
  res.json({ ok: r.ok, ...(r.error ? { error: r.error } : {}) });
});

rulesRoutes.get('/api/rules/actions', (req, res) => { G(req); res.json({ actions: listRuleActions() }); });

// ---------------------------------------------------------------- mount
let mountedRoutes = false;
export function mount(ctx: B16ServerCtx): void {
  if (mountedRoutes) return;
  mountedRoutes = true;
  ctx.app.use(rulesRoutes);
  // Something the server noticed (a tool's POST /api/rules/trigger ...) goes to the studio, where the engine runs.
  setRuleForwarder((e) => broadcast({ type: 'command', command: RULE_TRIGGER_COMMAND, args: e } as Parameters<typeof broadcast>[0]));
}
