// A stream PC's OBS page (Stream PC mode, server/streamPc.ts): the gaming PC's helper serves output.html over the home
// network. Every 5 s it asks the helper what it should be: the user switched to "Draw on the gaming PC" (mode B) ->
// go to the receiver page; this stream PC was forgotten on the gaming PC -> reload (the helper then answers with a plain
// "connect this stream PC first" card instead of a frozen avatar). Nothing runs on any other page.
import { LAN_PAGE } from './helper.ts';

if (LAN_PAGE && /\/output\.html$/i.test(location.pathname)) {
  setInterval(async () => {
    try {
      const r = await fetch('/streampc/state', { cache: 'no-store' });
      if (r.status === 401) { location.reload(); return; }
      const j = (await r.json()) as { mode?: string };
      if (j?.mode === 'B') location.replace(`/streampc/obs${location.search}`);
    } catch { /* the gaming PC is restarting: the bus reconnects by itself */ }
  }, 5000);
}
