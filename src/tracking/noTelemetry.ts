// Nothing leaves this PC when tracking starts. MediaPipe's tasks-vision (1.0.x) has a built-in usage logger with no
// off switch: every landmarker it creates POSTs to https://odml.pa.googleapis.com/v1/log (task name, timings) once a
// minute, through the global fetch. Imported (for its side effect) by every module that creates MediaPipe tasks: the
// tracking worker, the main-thread tracker and the avatar pose helper. Their requests to the logging host get an empty
// local answer; nothing else is touched. tools/realqa_notelemetry_unit.ts.
export const TELEMETRY_HOSTS = ['odml.pa.googleapis.com'];

export function isTelemetryUrl(u: unknown): boolean {
  try {
    const s = typeof u === 'string' ? u : u instanceof URL ? u.href : (u as { url?: string } | null)?.url ?? '';
    const host = new URL(s, 'http://localhost/').hostname.toLowerCase();
    return TELEMETRY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

type G = typeof globalThis & { __vtpNoTelemetry?: boolean; XMLHttpRequest?: { prototype: { open: (...a: unknown[]) => void; send: (...a: unknown[]) => void } } };

/** Install once per JS realm (page or worker). Safe to call again. */
export function blockTelemetry(g: G = globalThis as G) {
  if (g.__vtpNoTelemetry) return;
  g.__vtpNoTelemetry = true;
  const f = g.fetch?.bind(g);
  if (f) g.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (isTelemetryUrl(input) ? Promise.resolve(new Response(null, { status: 204 })) : f(input, init))) as typeof fetch;
  const X = g.XMLHttpRequest?.prototype;
  if (X) {
    const open = X.open, send = X.send;
    X.open = function (this: { __vtpBlocked?: boolean }, ...a: unknown[]) { this.__vtpBlocked = isTelemetryUrl(a[1]); return open.apply(this, a); };
    X.send = function (this: { __vtpBlocked?: boolean }, ...a: unknown[]) { if (this.__vtpBlocked) return; return send.apply(this, a); };
  }
  const nav = (g as { navigator?: { sendBeacon?: (u: string | URL, d?: unknown) => boolean } }).navigator;
  if (nav?.sendBeacon) { const b = nav.sendBeacon.bind(nav); nav.sendBeacon = (u, d) => (isTelemetryUrl(u) ? true : b(u, d as BodyInit)); }
}

blockTelemetry();
