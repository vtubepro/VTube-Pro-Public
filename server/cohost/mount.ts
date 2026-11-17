// beta.16 "cohost" lane entry, helper side (docs/b16/LANES.md): the AI co-host on the chat buddy (docs/b16/COHOST.md).
// Builds the real service (settings in config/cohost.json, the user's AI connection, the Read-aloud voice, the bus) and hooks
// it to the chat hub, the Stream Deck / rules commands `cohost-say` and `cohost-mute`, and /api/cohost/*.
// OFF until the user turns it on: while off, the chat listener returns at once and nothing else runs.
import fs from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import type { B16ServerCtx } from '../b16/mount.ts';
import { registerRuleAction } from '../../shared/streamRules.ts';
import { broadcast, broadcastTaps } from '../bus.ts';
import { chatListeners } from '../chat/hub.ts';
import { hostHub } from '../chat/hostHub.ts';
import { HttpError } from '../library.ts';
import { CACHE_DIR, CONFIG_DIR } from '../paths.ts';
import { requireLocal } from '../routes/util.ts';
import type { AiRow } from './ai.ts';
import { createCohost, type CohostService } from './service.ts';

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
/** This PC only, never another website open in the browser: the same rule as the Chat Hub. */
function guard(req: Request) {
  requireLocal(req);
  const o = req.headers.origin;
  if (o && !LOOPBACK_ORIGIN.test(o)) throw new HttpError(403, 'Only VTube Pro pages on this PC may use this');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request refused');
}

/** The studio's saved chat options (cache/scene.json -> chat), re-read only when the file changed. */
function sceneChat() {
  const file = path.join(CACHE_DIR, 'scene.json');
  let mt = -1, chat: { hideBots: boolean; hideCommands: boolean; bots: string[]; hidden?: boolean } | null = null;
  return () => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs !== mt) {
        mt = st.mtimeMs;
        const c = (JSON.parse(fs.readFileSync(file, 'utf8')) as { chat?: Record<string, unknown> }).chat;
        chat = c && typeof c === 'object'
          ? { hideBots: c.hideBots !== false, hideCommands: c.hideCommands !== false, bots: Array.isArray(c.bots) ? c.bots.map((b) => String(b).toLowerCase()).slice(0, 200) : [], hidden: c.hidden === true }
          : null;
      }
    } catch { mt = -1; chat = null; }
    return chat;
  };
}

let svc: CohostService | null = null;
export const cohostService = () => svc;

export async function mount(ctx: B16ServerCtx): Promise<void> {
  if (svc) return;
  // the user's AI connections (Connect an AI page): loaded once, resolved on every call so a changed choice is picked up
  const agent = await import('../aiAgent.ts');
  const { loadConf } = await import('../aiconnect.ts');
  const rows = (): AiRow[] => {
    const conf = loadConf();
    return agent.PROVIDERS.map((p): AiRow => {
      try { const r = agent.resolveProvider(p.id, conf); return { id: p.id, label: p.label, baseUrl: r.baseUrl, model: agent.modelFor(p.id, conf) }; }
      catch { return { id: p.id, label: p.label, baseUrl: '', model: '' }; }
    });
  };
  svc = createCohost({
    file: path.join(CONFIG_DIR, 'cohost.json'),
    ai: { fetch: globalThis.fetch.bind(globalThis), rows },
    voice: (text, id) => hostHub().say(text, id),
    voiceInfo: () => { const t = hostHub().tts; return { engine: t.engine, where: t.where }; },
    hush: () => broadcast({ type: 'chathub', m: { k: 'hush' } } as Parameters<typeof broadcast>[0]),
    emit: (line) => broadcast({ type: 'command', command: 'cohost-line', args: line }),
    announce: (s) => broadcast({ type: 'command', command: 'cohost-state', args: s }),
    react: (r) => {
      if (r === 'applause') void import('../deck.ts').then((d) => d.runAction('audience-applause', {})).catch(() => { /* optional */ });
    },
    chatState: sceneChat(),
    guard,
    log: (m) => console.log(`[cohost] ${m}`),
  });
  ctx.app.use(svc.routes);
  svc.attach(chatListeners);

  // the Stream Deck keys and the Rules lane's steps arrive as bus commands (shared/deck.ts plans them)
  broadcastTaps.add((msg) => {
    if (msg.type !== 'command') return;
    const a = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>;
    if (msg.command === 'cohost-say') svc!.engine.ask(typeof a.text === 'string' ? a.text : '');
    else if (msg.command === 'cohost-mute') { svc!.engine.setMuted(typeof a.on === 'boolean' ? a.on : 'toggle'); broadcast({ type: 'command', command: 'cohost-state', args: { on: svc!.config().on, muted: svc!.engine.isMuted() } }); }
  });
  registerRuleAction('cohost-say', (c) => {
    const r = svc!.engine.ask(typeof c.params.text === 'string' ? c.params.text : '');
    return r.ok ? { ok: true } : { ok: false, error: r.why };
  }, { label: 'Co-host says', group: 'Stream extras', icon: '🤖', where: 'helper', params: [{ key: 'text', label: 'Say (empty = answer chat)', type: 'text', default: '' }] });
  registerRuleAction('cohost-mute', (c) => {
    const o = c.params.on;
    const muted = svc!.engine.setMuted(o === true || o === 'true' ? true : o === false || o === 'false' ? false : 'toggle');
    broadcast({ type: 'command', command: 'cohost-state', args: { on: svc!.config().on, muted } });
    void muted;
    return { ok: true };
  }, { label: 'Mute co-host', group: 'Stream extras', icon: '🤐', where: 'helper', params: [{ key: 'on', label: 'Press does', type: 'select', options: [{ value: 'toggle', label: 'toggle' }, { value: 'true', label: 'Mute' }, { value: 'false', label: 'Unmute' }], default: 'toggle' }] });
}
