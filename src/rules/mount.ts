// beta.16 "rules" lane entry (docs/b16/LANES.md, docs/b16/RULES.md): Redeems & Reactions for the avatar.
//
// Studio page: loads the rule list from the helper, runs the engine (src/rules/engine.ts) on every trigger, turns chat lines into
// triggers, accepts the triggers the helper forwards (`rule-trigger`), keeps the revert stamps in SceneState.modes.rules and adds the
// Rules screen to Live > Stream extras. OBS pages and party guests do nothing here: the studio's own actions (outfit, camera, items ...)
// reach them the way they always did.
//
// Idle cost: with no rule switched on, a chat line is one array check and nothing else; no timer exists unless a revert or a queued
// event is waiting.
import type { B16Ctx } from '../b16/mount.ts';
import { registerB16Panel } from '../b16/panels.ts';
import { onAvatarLoaded } from '../avatar/b16Hooks.ts';
import { liveFromScene } from '../../shared/deck.ts';
import { EMOTES } from '../avatar/emotes.ts';
import { sanitizeChatEvent } from '../../shared/chat.ts';
import {
  RULE_TRIGGER_COMMAND, emitRuleTrigger, packRevertStamps, ruleEventsFromChat, sanitizeRevertStamps, sanitizeRuleEvent, sanitizeStep,
  type RuleActionCtx, type RuleActionResult, type RuleRevertStamp,
} from '../../shared/streamRules.ts';
import { wantInput, wantKey } from '../input/runtime.ts';
import { watchModelClickSubscribers } from '../avatar/modelClick.ts';
import { RuleEngine } from './engine.ts';
import { InputWanter } from './inputWants.ts';
import { rulesRuntime } from './store.ts';
import { whenB16Mounted } from '../b16/mount.ts';
import type { UndoBefore } from './undo.ts';
import type { App } from '../app.ts';

/** Bus command the helper sends when the saved list changed behind the studio's back (src/../server/rules.ts). */
const RULES_CHANGED = 'rules-changed';
/** The SceneState.modes bag that holds the revert stamps (plain JSON, at most 6 KB). */
export const RULES_BAG = 'rules';
const BAG_BYTES = 5200;

/** Ask the helper to run one step: an old Stream Deck action or a rule action that lives in the helper. */
async function stepViaHelper(ctx: RuleActionCtx): Promise<RuleActionResult> {
  let r: Response;
  try {
    r = await fetch('/api/rules/step', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: ctx.step.action, params: ctx.params, test: ctx.test, depth: ctx.depth, ...(ctx.rule ? { rule: ctx.rule.id } : {}) }),
    });
  } catch { return { ok: false, error: 'VTube Pro did not answer' }; }
  let j: { ok?: boolean; error?: string; undo?: unknown } = {};
  try { j = await r.json(); } catch { /* not JSON */ }
  const undo = j.undo ? sanitizeStep(j.undo) : null;
  return { ok: r.ok && j.ok !== false, ...(j.error ? { error: j.error } : {}), ...(undo ? { undo } : {}) };
}

function undoBefore(app: App): UndoBefore {
  const p = app.profile;
  return { live: liveFromScene(app.scene.effective, false, 1), costume: p?.costume ?? null, accessories: p?.accessories ?? [] };
}

/** Keep the stamps in the scene state bag (every OBS page and a reload sees them). Oldest are dropped if the bag would be too big. */
function saveStamps(app: App, stamps: RuleRevertStamp[]) {
  if (app.observer || !app.scene.canEdit) return;
  // the saved form is 3 levels deep (packRevertStamps): the scene state bag drops anything deeper, which used to strip the steps' params
  let list = packRevertStamps(stamps);
  while (list.length > 1 && JSON.stringify({ stamps: list }).length > BAG_BYTES) list = list.slice(1);
  const bag = list.length ? { stamps: list } : null;
  const cur = (app.scene.modeBag(RULES_BAG) as { stamps?: unknown } | undefined)?.stamps;
  if (!bag && (!Array.isArray(cur) || !cur.length)) return;   // nothing saved, nothing to clear: no state send
  app.scene.setModeBag(RULES_BAG, bag ?? { stamps: [] });
}

export function mount(ctx: B16Ctx): void | (() => void) {
  if (ctx.role !== 'studio') return;   // OBS pages and guests: nothing to do (the studio's actions reach them the usual way)
  const app = ctx.app;
  const store = rulesRuntime.store;
  rulesRuntime.observer = !!app?.observer;
  if (app) rulesRuntime.env = {
    rooms: () => app.scene.scenes.map((x) => ({ id: x.id, name: x.name })),
    outfits: () => (app.profile?.costumes ?? []).filter((c) => c.kind !== 'accessory').map((c) => ({ id: c.id, name: c.name })),
    accessories: () => (app.profile?.costumes ?? []).filter((c) => c.kind === 'accessory').map((c) => ({ id: c.id, name: c.name })),
    emotes: () => EMOTES.map((e) => ({ id: e.id, name: e.label })),
  };
  void store.load();

  const undo: (() => void)[] = [];
  undo.push(registerB16Panel({
    id: 'rules', title: 'Redeems & reactions', lane: 'rules', simple: true, order: 1,
    blurb: 'When chat redeems, donates, follows or types a command, your avatar reacts, then goes back.',
    mount(host) {
      let h: { destroy(): void } | void;
      let dead = false;
      void import('../ui/live/rulesPanel.ts').then((m) => { if (!dead) h = m.drawRulesPanel(host); });
      return { destroy() { dead = true; h?.destroy(); } };
    },
  }));

  // The helper changed the list (a save from another tab, a REST call): read it again.
  const offBus = ctx.bus.on((m) => {
    if (m.type !== 'command') return;
    if (m.command === RULES_CHANGED) { void store.externalChange(); return; }
    if (m.command === RULE_TRIGGER_COMMAND && app && !app.observer) {
      // a trigger the server noticed (a tool's POST /api/rules/trigger); the same id is delivered once
      const e = sanitizeRuleEvent(m.args);
      if (e) emitRuleTrigger(e);
    }
  });
  undo.push(offBus);
  // (the throw lane's click-on-the-avatar sender skips its raycast while no VTS plugin listens: the helper tells the studio over the bus)
  undo.push(watchModelClickSubscribers(ctx.bus));

  if (!app || app.observer) return () => { for (const u of undo.splice(0).reverse()) u(); };   // a debugging tab never acts for the studio

  const engine = new RuleEngine({
    now: () => Date.now(),
    rules: () => store.rules,
    fallback: stepViaHelper,
    before: () => undoBefore(app),
    loadStamps: () => sanitizeRevertStamps((app.scene.modeBag(RULES_BAG) as { stamps?: unknown } | undefined)?.stamps),
    saveStamps: (s) => saveStamps(app, s),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (h) => window.clearTimeout(h as number),
  });
  rulesRuntime.engine = engine;
  engine.start();
  // Key, pad, controller and hand-sign triggers only arrive while their listener runs: hold exactly what the switched-on rules need.
  const wanter = new InputWanter({ wantKey, wantInput });
  undo.push(store.onChange(() => {
    engine.prune();   // a rule switched off or deleted stops its queued events at once
    wanter.sync(store.rules);
  }));
  wanter.sync(store.rules);
  undo.push(() => wanter.release());
  undo.push(() => { engine.stop(); rulesRuntime.engine = null; });

  // Chat lines (not the catch-up batch, not a party host's relayed lines) -> triggers. Nothing to look at while no rule is on.
  undo.push(ctx.bus.on((m) => {
    if (m.type !== 'chat' || m.snap || m.origin === 'party' || !store.anyEnabled() || !Array.isArray(m.evs)) return;
    for (const raw of m.evs.slice(0, 50)) {
      const c = sanitizeChatEvent(raw);
      if (!c || c.cue) continue;   // ("thank on stream" replays of an earlier event never fire a rule twice)
      for (const e of ruleEventsFromChat(c)) emitRuleTrigger(e);
    }
  }));

  // Resume the saved reverts once the scene state is read, the avatar is on AND every other lane has mounted (the sticker / item-scene
  // put-backs belong to lanes that mount after this one; a revert run before they listen is lost), or after 20 s: a 2D avatar, a slow model.
  let resumed = false;
  const resume = () => { if (!resumed) { resumed = true; clearInterval(poll); engine.resume(); } };
  const sceneReady = () => (app.scene as unknown as { loaded?: boolean }).loaded === true;
  const t0 = Date.now();
  let avatarOn = !!app.runtime;
  let lanesOn = false;
  undo.push(onAvatarLoaded(() => { avatarOn = true; }));
  void whenB16Mounted().then(() => { lanesOn = true; });
  const poll = window.setInterval(() => { if ((sceneReady() && avatarOn && lanesOn) || Date.now() - t0 > 20_000) resume(); }, 400);
  undo.push(() => clearInterval(poll));

  // Test hook for tools (muted browser checks): the engine's state, read only.
  if (new URLSearchParams(location.search).has('livetest')) (window as unknown as { vtpRules?: unknown }).vtpRules = { engine, store, wanter };
  return () => { for (const u of undo.splice(0).reverse()) u(); };
}
