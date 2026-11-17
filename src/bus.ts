// Live bus over WebSocket: studio publishes tracking frames; OBS output pages + MCP/AI controllers subscribe.
import type { BusMessage } from '../shared/types.ts';

export class Bus {
  private ws: WebSocket | null = null;
  private handlers = new Set<(m: BusMessage) => void>();
  private links = new Set<(up: boolean) => void>();
  private retry = 500;
  private closed = false;
  connected = false;
  /** Per-page id stamped on every message, so listeners can tell publishers apart. */
  readonly id = Math.random().toString(36).slice(2, 10);

  /** `helloExtra`: more fields for the hello (output pages: kind / inside OBS / size, shared/obsPages.ts). */
  constructor(private role: 'studio' | 'output' | 'control', private helloExtra?: () => Record<string, unknown>) { this.connect(); }

  private hello() { this.send({ type: 'hello', role: this.role, ...(this.helloExtra?.() ?? {}) } as BusMessage); }
  /** Say hello again (e.g. the OBS Browser Source was resized), so the helper's page list stays current. */
  resendHello() { this.hello(); }

  private connect() {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { this.connected = true; this.retry = 500; this.hello(); this.link(true); };
    ws.onmessage = (e) => {
      try { const m = JSON.parse(e.data) as BusMessage; for (const h of this.handlers) h(m); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      const was = this.connected;
      this.connected = false;
      if (was || !this.everTried) { this.everTried = true; this.link(false); }
      if (this.closed) return;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 8000);
    };
  }

  on(h: (m: BusMessage) => void) { this.handlers.add(h); return () => this.handlers.delete(h); }
  /** The connection came up (true) or went down (false; also once when the very first attempt fails). */
  onLink(fn: (up: boolean) => void) { this.links.add(fn); return () => this.links.delete(fn); }
  private everTried = false;
  private link(up: boolean) { if (up) this.everTried = true; for (const f of this.links) try { f(up); } catch { /* listener */ } }

  /** Stop for good: no more handlers, no reconnect (short-lived listeners, e.g. a party game session). */
  close() { this.closed = true; this.handlers.clear(); this.links.clear(); try { this.ws?.close(); } catch { /* already closed */ } this.ws = null; }

  send(m: BusMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ ...m, src: this.id }));
  }
}
