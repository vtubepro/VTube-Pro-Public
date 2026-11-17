// Room favourites for the studio UI (beta.12 UX): one list for the Room area's picker (src/ui/roomPicker.ts), Live
// Control's Rooms tile, the show dock's Room menu and the Live pop-out window. The helper keeps it (src/net/roomPrefs.ts,
// the showctl lane's API: every tab and restarts share it; an old per-browser list is brought in
// once). This file is a thin wrapper so the UI code stays the same if the storage changes again.
import { isFavoriteRoom, onRoomPrefs, roomFavorites, toggleFavoriteRoom } from '../net/roomPrefs.ts';

/** The favourite room ids, newest star first. */
export const roomFavs = (): string[] => roomFavorites();
export const isRoomFav = (id: string): boolean => isFavoriteRoom(id);
/** Star / unstar a room (optimistic: the list changes at once, the helper saves it). Returns whether it is a favourite now. */
export function toggleRoomFav(id: string): boolean {
  const on = !isFavoriteRoom(id);
  void toggleFavoriteRoom(id, on).catch((e) => console.warn('[favourites]', e));
  return on;
}
/** Called when the favourites change here, in another tab or on a load (returns the unsubscribe). */
export function onRoomFavs(cb: () => void): () => void { return onRoomPrefs(() => cb()); }
