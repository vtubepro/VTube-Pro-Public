// "Describe your room" → a request for an AI-generated room (POST /api/rooms/generate, server/routes/setup.ts).
// Today the server records the request as a job (cache/jobs/<id>/request.json) and explains that room generation is
// coming; the room-building pipeline picks these requests up once it exists. The same shape is what the studio's
// instant matcher (src/ui/prompter.ts) reads, so a request can always be re-run.

export const ROOM_GEN_JOB = 'room-generate';
export const ROOM_STYLES = ['cozy', 'sci-fi', 'fantasy', 'horror', 'jungle', 'city', 'party'] as const;
export type RoomStyle = (typeof ROOM_STYLES)[number];

export interface RoomGenerateRequest {
  /** The performer's own words. */
  prompt: string;
  /** Style chips picked in the prompter. */
  styles: RoomStyle[];
  /** 'dawn' | 'day' | 'sunset' | 'night' | null (no preference). */
  time: string | null;
  /** An EnvWeather id or null. */
  weather: string | null;
  /** 0 = very calm … 4 = chaos (2 = no preference). */
  busy: number;
  /** The closest existing room the instant matcher picked (a starting point for the builder). */
  basedOn: string | null;
}

const clean = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

export function sanitizeRoomRequest(x: unknown): RoomGenerateRequest {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const styles = Array.isArray(o.styles) ? o.styles.filter((s): s is RoomStyle => (ROOM_STYLES as readonly string[]).includes(s as string)) : [];
  const busy = Number(o.busy);
  return {
    prompt: clean(o.prompt, 2000),
    styles: [...new Set(styles)],
    time: /^(dawn|day|sunset|night)$/.test(String(o.time)) ? String(o.time) : null,
    weather: /^[a-z]{2,16}$/.test(String(o.weather)) ? String(o.weather) : null,
    busy: Number.isFinite(busy) ? Math.max(0, Math.min(4, Math.round(busy))) : 2,
    basedOn: /^[A-Za-z0-9_-]{1,64}$/.test(String(o.basedOn)) ? String(o.basedOn) : null,
  };
}
