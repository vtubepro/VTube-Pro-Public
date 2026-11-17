// beta.16 "bindings" lane, helper side (docs/b16/LANES.md, docs/b16/BINDINGS.md): keys that work while a game has focus.
//
//   GET /api/hotkeys               -> { supported, running, results, note? }     what the helper can do and what it holds now
//   PUT /api/hotkeys {keys:[{id,combo}]} -> same + results per binding           make exactly these combos global (an empty list lets go of all)
//   bus  {type:'command', command:'binding-hotkey', args:{id, combo, phase:'down'|'up'}}   a registered combo was pressed / let go
//
// The studio owns the bindings (it knows what each key should do); the server only holds the Windows registrations and says
// when one was pressed. Windows only (RegisterHotKey from a hidden helper process, server/hotkeys/hostScript.ts): other
// systems answer { supported: false } and the studio keeps the key working while its own tab is in front. Local requests
// only; the global guard (server/localGuard.ts) already refuses other websites.
import type { Express, Request } from 'express';
import type { B16ServerCtx } from '../b16/mount.ts';
import { broadcast } from '../bus.ts';
import { HttpError } from '../library.ts';
import { requireLocal } from '../routes/util.ts';
import { HotkeyHost } from './host.ts';

/** Routes on any Express app, with the host injected (tools/bindings_unit.ts mounts this with a fake child). */
export function hotkeyRoutes(app: Pick<Express, 'get' | 'put'>, host: HotkeyHost) {
  const guard = (req: Request) => requireLocal(req);
  app.get('/api/hotkeys', (req, res) => { guard(req); res.json(host.status()); });
  app.put('/api/hotkeys', async (req, res) => {
    guard(req);
    const body = (req.body ?? {}) as { keys?: unknown };
    if (body.keys !== undefined && !Array.isArray(body.keys)) throw new HttpError(400, 'keys must be a list');
    const results = await host.set(body.keys ?? []);
    res.json({ ...host.status(), results });
  });
}

let shared: HotkeyHost | null = null;
export function mount(ctx: B16ServerCtx): void {
  if (shared) return;                                               // (a second mount, e.g. a dev restart of this module)
  const host = shared = new HotkeyHost({
    onEvent: (e) => broadcast({ type: 'command', command: 'binding-hotkey', args: e }),
    log: (s) => console.log(s),
  });
  hotkeyRoutes(ctx.app, host);
  process.once('exit', () => host.stop());
}
