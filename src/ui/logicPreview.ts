// The room preview is off by default (beta.13.5, owner decision: it renders the room a second time on the graphics card).
// Two things in the studio still need the room page's own analysis, which only a running preview produces
// (scene/controller.ts connectPreview → report): the room's real seats (its spot list with size spots: seating checks
// and seat-by-size use it) and React Big re-seating (a big performer sitting down in front of the React screen is walked
// to a free seat). This opens the shared preview OUT OF SIGHT just for that (src/ui/previewFrame.ts openHiddenPreview:
// parked, so it draws only while the room loads / someone walks, its logic runs twice a second) and closes it again:
//   - a room whose seats the studio does not know yet: until its report arrives (at most 40 s; a room that never reports
//     is not retried this session);
//   - a room counts as known once its report carries the automatic size spots too (sizes.ready: seat-by-size needs them)
//     - or needs none: no micro / macro performer, neither in the report nor in the studio's current member list;
//   - React mode: from a change to anything that can move people (room, members, seats, mode) until 15 s after the hidden
//     page reports that room loaded and ready (a walk takes up to ~10 s), longer while a performer is still walking in
//     (soloPending), never past 40 s from the change (review round 1, G2: the hold used to start at the change, and a cold
//     page plus a room load used it all up before the walk).
// Never while a game starves face tracking (Tracker game mode), in an observer tab, on a party guest's studio (the host
// runs the room), or when the user's own preview is showing (that one does the analysis anyway).
import type { App } from '../app.ts';
import { closeHiddenPreview, hiddenPreviewOpen, openHiddenPreview, previewVisible } from './previewFrame.ts';
import { logicPreviewWanted, roomSeatsKnown } from './gameText.ts';

const REACT_HOLD_MS = 15000;
const MAX_OPEN_MS = 40000;

export function mountLogicPreview(app: App) {
  if (app.observer) return;
  const S = app.scene;
  const gaveUp = new Set<string>();
  let reactUntil = 0, reactPending = false, changedAt = 0, openedAt = 0, openedFor = '', lastSig = '';
  // (seats known: the report's room, with its automatic size spots derived when a micro / macro performer needs them —
  //  older pages without `sizes` count as ready)
  const known = (rid: string) => roomSeatsKnown(S.rooms.get(rid), S.members().some((m) => m.size?.cls === 'micro' || m.size?.cls === 'macro'));
  const tick = () => {
    try {
      const now = performance.now(), st = S.effective, id = st.sceneId;
      const sig = `${id}|${st.mode}|${S.members().map((m) => m.key).join(',')}|${JSON.stringify(st.spots ?? {})}`;
      if (sig !== lastSig) { lastSig = sig; if (st.mode === 'react') { reactPending = true; changedAt = now; reactUntil = now + MAX_OPEN_MS; } }
      if (st.mode !== 'react') { reactUntil = 0; reactPending = false; }
      const rep = S.report;
      const ready = !!id && !!rep && !rep.loading && rep.room?.id === id && known(id);
      if (reactPending && hiddenPreviewOpen() && ready) { reactPending = false; reactUntil = Math.min(changedAt + MAX_OPEN_MS, now + REACT_HOLD_MS); }
      if (!reactPending && reactUntil && rep?.room?.soloPending) reactUntil = Math.min(changedAt + MAX_OPEN_MS, Math.max(reactUntil, now + 2000));
      const want = logicPreviewWanted({ now, sceneId: id, canEdit: S.canEdit, observer: S.observer, gameMode: !!app.tracker.gameMode,
        userPreview: previewVisible(), roomKnown: !!id && known(id), gaveUp: !!id && gaveUp.has(id), reactUntil });
      if (want && !hiddenPreviewOpen() && !previewVisible()) { if (openHiddenPreview()) { openedAt = now; openedFor = id ?? ''; } }
      else if (!want && hiddenPreviewOpen()) closeHiddenPreview();
      // (a room that never reports its seats: don't keep it loaded out of sight, and don't try again this session)
      if (hiddenPreviewOpen() && now - openedAt > MAX_OPEN_MS && now >= reactUntil) {
        if (openedFor && !known(openedFor)) gaveUp.add(openedFor);
        closeHiddenPreview();
      }
    } catch (e) { console.warn('[logic preview]', e); }
  };
  window.setInterval(tick, 1000);
  S.on((what) => { if (what === 'state' || what === 'report') tick(); });
}
