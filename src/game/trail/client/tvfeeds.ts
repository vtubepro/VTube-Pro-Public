// The Trail — live pictures for walking-TV performers (tvguests, S\tv\PERFORMER_API.md).
// The stream spectator runs inside output.html (an iframe), which already receives every TV feed from this PC's studio
// over its loopback link (src/scene/tv/tvFeeds.ts `pageFeeds`, exposed as `vtpTv.feeds`). We MIRROR those streams into
// our own PageFeeds (a second <video> on the same MediaStream: no second WebRTC link, no second decode) — never a new
// receiver. The player's own view (an iframe in the studio = the tracking page) shows the TV bodies without live
// pictures: receiving video there would cost tracking. RAM only, like every feed: nothing is recorded or stored.
import { PageFeeds } from '../../../scene/tv/tvFeeds.ts';

export const trailFeeds = new PageFeeds();
let timer = 0;

type ParentTv = { vtpTv?: { feeds?: PageFeeds } };

/** Keep mirroring the parent page's feeds for these feed ids (~10 Hz: streams + voice levels for the talk animation). */
export function mirrorParentFeeds(ids: () => string[]) {
  if (timer || window.parent === window) return;
  timer = window.setInterval(() => {
    let pf: PageFeeds | undefined;
    try { pf = (window.parent as unknown as ParentTv).vtpTv?.feeds; } catch { pf = undefined; }
    for (const id of ids()) {
      const s = pf?.get(id)?.stream ?? null;
      if ((trailFeeds.get(id)?.stream ?? null) !== s) trailFeeds.inject(id, s);
      trailFeeds.testLevels.set(id, pf?.level(id) ?? 0);
    }
  }, 100);
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = 0; for (const id of [...trailFeeds.feeds.keys()]) trailFeeds.forget(id); });
}
