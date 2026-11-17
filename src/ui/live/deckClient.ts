// Live Control (livedash): a small client of the Stream Deck socket (/ws/deck, server/deck.ts) — the server's live
// state (room, mode, lighting, cover, read-aloud, interview camera + guests) and `run` for any registry action.
// The studio's Live area, its on-air mini-bar, Ctrl+K and the pop-out window all run actions through here, so a button
// on screen and a key on a physical Stream Deck are the same action with the same lit state.
import { DEFAULT_LIVE, type DeckLiveState, type DeckServerMsg } from '../../../shared/deck.ts';
const NOT_CONNECTED = () => 'VTube Pro’s engine isn’t answering. Restart VTube Pro.';

export interface DeckClient {
  live(): DeckLiveState;
  online(): boolean;
  run(action: string, params?: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  on(cb: () => void): () => void;
}

let shared: DeckClient | null = null;
/** One socket per page. */
export function deckClient(): DeckClient {
  if (shared) return shared;
  let ws: WebSocket | null = null, live: DeckLiveState = { ...DEFAULT_LIVE }, up = false, retry = 800, seq = 0;
  const subs = new Set<() => void>();
  const waits = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  const emit = () => { for (const s of subs) { try { s(); } catch (e) { console.warn('[live]', e); } } };
  const connect = () => {
    const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/deck`);
    ws = s;
    s.onopen = () => { up = true; retry = 800; emit(); };
    s.onmessage = (e) => {
      let m: DeckServerMsg; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.t === 'hello' || m.t === 'state') { live = m.live; emit(); }
      else if (m.t === 'result' && m.id) { waits.get(m.id)?.({ ok: m.ok, error: m.error }); waits.delete(m.id); }
    };
    s.onclose = () => { up = false; ws = null; emit(); for (const w of waits.values()) w({ ok: false, error: 'Lost the connection to VTube Pro. Try again.' }); waits.clear(); setTimeout(connect, retry); retry = Math.min(retry * 2, 8000); };
  };
  connect();
  shared = {
    live: () => live,
    online: () => up,
    run(action, params) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: NOT_CONNECTED() });
      const id = `l${++seq}`;
      ws.send(JSON.stringify({ t: 'run', action, params, id }));
      return new Promise((res) => { waits.set(id, res); setTimeout(() => { if (waits.delete(id)) res({ ok: false, error: 'VTube Pro didn’t answer. Try again.' }); }, 4000); });
    },
    on(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
  return shared;
}
