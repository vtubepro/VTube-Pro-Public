// AI co-host (docs/b16/COHOST.md): the helper-side service = settings file + engine + the REST routes. Built from injected parts
// (createCohost) so tools/cohost_unit.ts can run all of it against fakes; server/cohost/mount.ts builds the real one.
//
//   GET  /api/cohost/state          -> { config, state, connections, voice }   the panel
//   PUT  /api/cohost/config         -> same                                    save (on/off, persona, model, caps ...)
//   POST /api/cohost/try   {text}   -> { ok, text, mood, why }                 ask the model, say nothing (Try it)
//   POST /api/cohost/say   {text?}  -> { ok }                                  "Co-host says" (empty = answer chat)
//   POST /api/cohost/mute  {on?}    -> { muted }                               Mute / unmute (missing = toggle)
//   POST /api/cohost/host-speaking {speaking} -> { ok }                        the studio says the streamer is (not) talking
// Local pages only (the same guard as the Chat Hub). Nothing here returns a key.
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type RequestHandler } from 'express';
import type { ChatEvent, SceneChatState } from '../../shared/chat.ts';
import { complete, connectionStatus, pickConn, type AiDeps } from './ai.ts';
import { DEFAULT_COHOST, sanitizeCohost, type CohostConfig, type CohostLine, type CohostReaction } from './config.ts';
import { CohostEngine, type CohostState } from './engine.ts';

export interface CohostParts {
  /** Where the settings live (config/cohost.json). null = memory only (tests). */
  file: string | null;
  ai: AiDeps;
  voice(text: string, id: string): Promise<number>;
  /** What the Read-aloud voice is set to, for the panel's one-line note. */
  voiceInfo?(): { engine: string; where: string };
  hush(): void;
  emit(line: CohostLine): void;
  /** Tell every page the switch changed (so the studio only listens to the mic while it matters). */
  announce?(s: { on: boolean; muted: boolean }): void;
  react(r: CohostReaction): void;
  chatState(): Pick<SceneChatState, 'hideBots' | 'hideCommands' | 'bots' | 'hidden'> | null;
  /** Throws an HttpError-like object when the request must be refused. */
  guard?(req: Request): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  log?(msg: string): void;
}

export interface CohostService {
  engine: CohostEngine;
  routes: Router;
  config(): CohostConfig;
  setConfig(patch: unknown): CohostConfig;
  snapshot(): Promise<Record<string, unknown>>;
  /** Wire the engine to the chat hub's events. Returns the unsubscribe. */
  attach(listeners: Set<(e: ChatEvent) => void>): () => void;
}

class Refuse extends Error { constructor(readonly status: number, m: string) { super(m); } }

export function createCohost(p: CohostParts): CohostService {
  const now = p.now ?? Date.now;
  let cfg: CohostConfig = DEFAULT_COHOST;
  if (p.file) { try { cfg = sanitizeCohost(JSON.parse(fs.readFileSync(p.file, 'utf8'))); } catch { /* first run: the defaults (switched off) */ } }
  const save = () => {
    if (!p.file) return;
    try { fs.mkdirSync(path.dirname(p.file), { recursive: true }); const tmp = p.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2)); fs.renameSync(tmp, p.file); }
    catch (e) { p.log?.(`could not save the co-host settings: ${(e as Error).message}`); }
  };
  const engine = new CohostEngine({
    now, config: () => cfg, chatState: p.chatState, voice: p.voice, hush: p.hush, emit: p.emit, react: p.react, log: p.log,
    sleep: p.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    ask: async (system, user) => {
      const conn = await pickConn(cfg, p.ai, now());
      return complete(conn, p.ai, { system, user, maxTokens: 220 });
    },
  });

  const announce = () => { try { p.announce?.({ on: cfg.on, muted: engine.isMuted() }); } catch { /* optional */ } };
  const setConfig = (patch: unknown): CohostConfig => {
    const was = cfg.on;
    cfg = sanitizeCohost(patch, cfg);
    if (was && !cfg.on) engine.turnedOff();
    save(); announce();
    return cfg;
  };

  let conns: { at: number; list: Awaited<ReturnType<typeof connectionStatus>> } | null = null;
  const connections = async (fresh = false) => {
    if (!fresh && conns && now() - conns.at < 8000) return conns.list;
    const list = await connectionStatus(p.ai).catch(() => []);
    conns = { at: now(), list };
    return list;
  };
  const snapshot = async (fresh = false) => ({ config: cfg, state: engine.state() as CohostState, connections: await connections(fresh), voice: p.voiceInfo?.() ?? null });

  // ---------------------------------------------------------------- routes
  const routes = Router();
  const guarded = (fn: (req: Request) => unknown | Promise<unknown>): RequestHandler => async (req, res) => {
    try { p.guard?.(req); res.json(await fn(req)); }
    catch (e) {
      const st = (e as { status?: number }).status;
      res.status(typeof st === 'number' && st >= 400 && st < 600 ? st : 500).json({ error: (e as Error).message || 'failed' });
    }
  };
  const body = (req: Request) => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
  routes.get('/api/cohost/state', guarded((req) => snapshot(req.query.fresh === '1')));
  routes.put('/api/cohost/config', guarded(async (req) => { setConfig(body(req)); return snapshot(); }));
  let tryAt = 0;
  routes.post('/api/cohost/try', guarded(async (req) => {
    if (now() - tryAt < 2000) throw new Refuse(429, 'One moment, then try again.');
    tryAt = now();
    const t = typeof body(req).text === 'string' ? body(req).text as string : '';
    return engine.tryIt(t.slice(0, 300));
  }));
  routes.post('/api/cohost/say', guarded((req) => {
    const t = typeof body(req).text === 'string' ? body(req).text as string : '';
    const r = engine.ask(t.slice(0, 300));
    if (!r.ok) throw new Refuse(409, r.why ?? 'Not now.');
    return { ok: true };
  }));
  routes.post('/api/cohost/mute', guarded((req) => {
    const o = body(req).on;
    const muted = engine.setMuted(typeof o === 'boolean' ? o : 'toggle');
    announce();
    return { muted };
  }));
  routes.post('/api/cohost/host-speaking', guarded((req) => { engine.setHostSpeaking(body(req).speaking === true); return { ok: true }; }));

  return {
    engine, routes, config: () => cfg, setConfig, snapshot,
    attach(listeners) {
      const fn = (e: ChatEvent) => { try { engine.ingest(e); } catch (err) { p.log?.(`co-host: ${(err as Error).message}`); } };
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}
