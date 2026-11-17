// "Record my own emote" (lane recemote): list, load and play the emotes you recorded.
//
// How a recorded emote reaches the screen: the helper keeps the clip (server/routes/userEmotes.ts); this file loads it and
// registers it with src/avatar/emotes.ts under the name `rec:<id>` (registerEmote). Playing is then the very same thing the
// built-in emotes do: the studio stamps `frame.emote = {id, name:'rec:<id>', at, loop}` into its frames, and every OBS page plays
// the clip at the same phase. An OBS page that has not seen the clip yet fetches it from the helper the first time it sees the
// name (watchOutputEmotes). A party guest never has your clips (their page ignores a name it does not know); nothing of theirs
// is stored here either.
import type { EmoteState } from '../emotes.ts';
import { registerEmote } from '../emotes.ts';
import { PREVIEW_ID, decodeClip, recordedId, recordedName, sanitizeClip, takeSeconds, type EmoteClip, type Take } from './clip.ts';
import { takeToAnimation } from './rig.ts';

export interface UserEmoteMeta { id: string; name: string; secs: number; fps: number; frames: number; bones: number; loop: boolean; createdAt: number; idle: boolean; bytes: number }
export interface UserEmoteList { emotes: UserEmoteMeta[]; idle: string | null; max: number }

/** The part of App this needs (App satisfies it): the stamped emote and a humanoid to play it on. */
export interface EmoteHost {
  emote: EmoteState | null;
  stopEmote(): void;
  runtime: { humanoid: unknown } | null;
}
export type PlayResult = { ok: true; id: string; name: string; secs: number } | { ok: false; error: string };

const NO_HELPER = 'I could not reach VTube Pro. Is it running?';

let seq = 1;
const nextStateId = () => (Date.now() % 1_000_000) * 1000 + (seq++ % 1000) + 1_000_000_000;

/** Every emote that is registered with src/avatar/emotes.ts here, id -> its details. */
const loaded = new Map<string, { clip: EmoteClip; secs: number }>();

export async function listUserEmotes(f: typeof fetch = fetch): Promise<UserEmoteList | { error: string }> {
  try {
    const r = await f('/api/user-emotes', { cache: 'no-store' }); // vtp:user-action (only runs from a click or a deck / rule command)
    if (!r.ok) return { error: NO_HELPER };
    const j = await r.json() as Partial<UserEmoteList>;
    return { emotes: Array.isArray(j.emotes) ? j.emotes : [], idle: typeof j.idle === 'string' ? j.idle : null, max: Number(j.max) || 100 };
  } catch { return { error: NO_HELPER }; }
}

/** Fetch one clip and make it playable here. Cached: a second call is free. */
export async function loadUserEmote(id: string, f: typeof fetch = fetch): Promise<EmoteClip | null> {
  const have = loaded.get(id);
  if (have) return have.clip;
  try {
    const r = await f(`/api/user-emotes/${encodeURIComponent(id)}`, { cache: 'no-cache' });
    if (!r.ok) return null;
    const clip = sanitizeClip(await r.json());
    const take = clip && decodeClip(clip);
    if (!clip || !take) return null;
    registerEmote(recordedName(id), takeToAnimation(take));
    loaded.set(id, { clip, secs: takeSeconds(take) });
    return clip;
  } catch { return null; }
}
/** Forget a loaded clip (it was deleted or re-saved), so the next play fetches it again. */
export function forgetUserEmote(id: string) { loaded.delete(id); }

/** Make a take playable under the preview name (studio only: OBS pages never fetch `rec:_preview`). */
export function registerPreview(take: Take) { registerEmote(recordedName(PREVIEW_ID), takeToAnimation(take)); }

const timers = new WeakMap<object, ReturnType<typeof setTimeout>>();
/** Stamp an emote into the host's frames. A clip that is not a loop ends by itself a moment after it finishes (the built-in
 *  emotes are ended by app.ts, which only knows its own list). */
export function stampEmote(host: EmoteHost, animName: string, secs: number, loop: boolean): EmoteState {
  const old = timers.get(host);
  if (old) clearTimeout(old);
  const st: EmoteState = { id: nextStateId(), name: animName, at: Date.now(), loop };
  host.emote = st;
  if (!loop) {
    timers.set(host, setTimeout(() => { if (host.emote?.id === st.id) host.stopEmote(); }, secs * 1000 + 500));
  } else timers.delete(host);
  return st;
}
export function stopRecordedEmote(host: EmoteHost) {
  const old = timers.get(host);
  if (old) clearTimeout(old);
  timers.delete(host);
  if (recordedId(host.emote?.name ?? '') !== null) host.stopEmote();
}

/** Find one of the user's emotes by id, by its name (any capitals), or "" / "latest" = the newest. */
export function pickEmote(list: readonly UserEmoteMeta[], ref: string): UserEmoteMeta | null {
  const r = ref.trim().toLowerCase();
  if (!list.length) return null;
  if (!r || r === 'latest' || r === 'newest') return [...list].sort((a, b) => b.createdAt - a.createdAt)[0];
  return list.find((e) => e.id === r) ?? list.find((e) => e.name.toLowerCase() === r) ?? list.find((e) => e.id === r.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) ?? null;
}

/** Play one of the user's emotes on the host (the deck key, a rule, the panel's Play button). */
export async function playRecorded(host: EmoteHost, ref: string, o: { loop?: boolean; list?: readonly UserEmoteMeta[]; fetchFn?: typeof fetch } = {}): Promise<PlayResult> {
  if (!host.runtime?.humanoid) return { ok: false, error: 'This avatar has no body bones, so it cannot play emotes.' };
  let list = o.list;
  if (!list) {
    const l = await listUserEmotes(o.fetchFn);
    if ('error' in l) return { ok: false, error: l.error };
    list = l.emotes;
  }
  if (!list.length) return { ok: false, error: 'You have not recorded an emote yet.' };
  const m = pickEmote(list, ref);
  if (!m) return { ok: false, error: `No recorded emote called "${ref.slice(0, 40)}".` };
  const clip = await loadUserEmote(m.id, o.fetchFn);
  if (!clip) return { ok: false, error: `I could not load "${m.name}".` };
  const secs = loaded.get(m.id)!.secs;
  stampEmote(host, recordedName(m.id), secs, o.loop ?? clip.loop);
  return { ok: true, id: m.id, name: clip.name, secs };
}

/** Play a take that is not saved yet (the editor's Preview): on this studio's avatar, and on no OBS page. */
export function playPreview(host: EmoteHost, take: Take, loop: boolean): PlayResult {
  if (!host.runtime?.humanoid) return { ok: false, error: 'This avatar has no body bones, so it cannot play emotes.' };
  registerPreview(take);
  stampEmote(host, recordedName(PREVIEW_ID), takeSeconds(take), loop);
  return { ok: true, id: PREVIEW_ID, name: 'Preview', secs: takeSeconds(take) };
}

// ------------------------------------------------------------------------------------------------ OBS pages

/** OBS page / preview page: when a frame names a recorded emote this page has not got, fetch it from the helper (once; a failed
 *  fetch is tried again after 10 s). The check is two property reads per frame; nothing else runs. Returns the unsubscribe. */
export function watchOutputEmotes(bus: { on(h: (m: { type: string; frame?: { emote?: { name?: unknown } | null } }) => void): () => void }, f: typeof fetch = fetch, now: () => number = Date.now): () => void {
  const tried = new Map<string, number>();
  return bus.on((m) => {
    if (m.type !== 'frame') return;
    const nm = m.frame?.emote?.name;
    if (typeof nm !== 'string' || !nm.startsWith('rec:')) return;
    const id = recordedId(nm);
    if (!id || id.startsWith('_') || loaded.has(id)) return;
    const t = now();
    if ((tried.get(id) ?? -1e9) > t - 10_000) return;
    tried.set(id, t);
    void loadUserEmote(id, f);
  });
}
