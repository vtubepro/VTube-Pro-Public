// Time of day + weather for rooms that opt in (scene.json "environment"; src/scene/environment/*, docs/SCENES.md →
// "Environment: time of day, weather, night lights"). Part of the HOST-owned SceneState (SceneState.env), so the studio
// preview, every OBS page and party guests show the same sky: everything below is a pure function of (state, room config,
// wall-clock ms) — no messages per change beyond the state itself, nothing that can drift apart.
//
//   clock  'cycle'  accelerated game clock: hour = hour@epoch + elapsed real hours × speed   (speed 1 = real time)
//          'real'   the HOST's local wall clock (tz = the host's UTC offset, so a guest abroad sees the host's evening)
//          'fixed'  locked at `hour`
//   weather 'manual' (crossfade from weatherFrom → weather, stamped at weatherAt), 'cycle' (automatic, like games: a
//          seeded, smoothed random walk through the room's climate in cycleMins-long slots of absolute time), 'state'
//          (follows the host's lighting state through the room's weatherByState map, e.g. PRESHOW → storm).

export const ENV_WEATHERS = ['clear', 'cloudy', 'overcast', 'rain', 'heavyrain', 'storm', 'fog', 'sandstorm'] as const;
export type EnvWeather = (typeof ENV_WEATHERS)[number];
export type EnvClock = 'cycle' | 'real' | 'fixed';
export type EnvWeatherMode = 'manual' | 'cycle' | 'state';

export const WEATHER_LABEL: Record<EnvWeather, string> = {
  clear: 'Clear', cloudy: 'Cloudy', overcast: 'Overcast', rain: 'Light rain', heavyrain: 'Heavy rain', storm: 'Storm', fog: 'Fog', sandstorm: 'Sandstorm',
};
export const WEATHER_ICON: Record<EnvWeather, string> = { clear: '☀', cloudy: '⛅', overcast: '☁', rain: '🌦', heavyrain: '🌧', storm: '⛈', fog: '🌫', sandstorm: '🌪' };

export interface SceneEnvState {
  /** Time + weather on (off = the room's authored look, exactly as before). */
  on: boolean;
  clock: EnvClock;
  /** 'fixed': the hour (0..24); 'cycle': the hour at `epoch`. */
  hour: number;
  /** 'cycle': game hours per real hour (1 = real time, 24 = a day per hour, 60 = one game hour per real minute). */
  speed: number;
  /** 'cycle': host epoch ms at which the clock read `hour`. */
  epoch: number;
  /** 'real': the host's UTC offset in minutes (east positive). */
  tz: number;
  weather: EnvWeather;
  weatherMode: EnvWeatherMode;
  /** 'manual' crossfade: previous weather + host epoch ms of the change. */
  weatherFrom: EnvWeather;
  weatherAt: number;
  /** Weather crossfade (s). */
  fade: number;
  /** 'cycle': average real minutes per weather. */
  cycleMins: number;
  seed: number;
  /** Wind strength multiplier (0 = still air … 2 = gale). */
  wind: number;
  /** Lightning in storms (flashes obey the lighting's photosensitivity setting). */
  lightning: boolean;
}

/** scene.json `environment` — every key optional. Positions / boxes in glTF space. */
export interface RoomEnvConfig {
  /** 'procedural' (the engine's sky dome), 'room' (only the room's own M_Sky / GFX_SKY* / SKY_* meshes, tinted), 'none'. */
  sky?: 'procedural' | 'room' | 'none';
  /** Compass: yaw (deg) of north about +Y from glTF −Z; 0 = the sun rises at +X, sets at −X (behind stage left). */
  north?: number;
  /** Max sun elevation at noon (deg, default 62) and sunrise / sunset hours (default 6.0 / 18.5). */
  noonElevation?: number;
  sunrise?: number;
  sunset?: number;
  /** 'temperate' (default), 'jungle', 'city', 'coastal', 'arid' — the automatic weather cycle's odds. */
  climate?: string;
  /** Allowed weathers in the automatic cycle (default: every one the climate uses). */
  weathers?: EnvWeather[];
  /** Initial state for this room (anything of SceneEnvState). */
  default?: Partial<SceneEnvState>;
  /** weatherMode 'state': lighting state → weather. */
  weatherByState?: Record<string, EnvWeather>;
  /** weatherMode 'state' with a fixed clock: lighting state → hour (e.g. OUTRO at sunset). */
  hourByState?: Record<string, number>;
  /** Room light at deep night as a fraction of day (default 0.2) and overall exposure (default 1). */
  night?: number;
  exposure?: number;
  /** The hour the room's own (baked) lighting was authored for: at that hour, in clear weather, the room, its sky, fog
   *  and the performers look exactly as authored; other times are relative to it (default: none = noon, plus the sun). */
  bakedAt?: number;
  /** Strength of the engine's sun / moon light on the room (default 1; 0 for rooms with a baked sun). */
  sun?: number;
  /** Fog: base distances + colour weight (the fog colour follows the sky horizon); false = never add fog. */
  fog?: { near?: number; far?: number; tint?: number } | false;
  /** Night lights per EMIT_ / LIGHT_ group (see docs): threshold 0..1 darkness, stagger, flicker 0..1, fade (s), day level. */
  nightLights?: Record<string, { threshold?: number; stagger?: number; flicker?: number; fade?: number; day?: number; pools?: boolean; radius?: number }>;
  /** Window-grid emissive masks per EMIT_ group (city buildings): world or uv cells, each window lights at its own darkness. */
  windows?: Record<string, { mode?: 'world' | 'uv'; cell?: [number, number]; grid?: [number, number]; frame?: number; lit?: number; late?: number; colors?: string[]; tv?: number; threshold?: number; spread?: number }>;
  /** Wet surfaces (default true) and the share of flat ground that gathers puddles (0..1, default 0.35). */
  wet?: boolean;
  puddles?: number;
  /** Extra material-name patterns (regex source) that sway in the wind (foliage / cloth). */
  foliage?: string[];
  cloth?: string[];
  sway?: number;
  /** Rain-free boxes [minX, minY, minZ, maxX, maxY, maxZ] (tents, roofs, interiors) in addition to ENV_DRY_* nodes. */
  dry?: number[][];
  /** Rain box size around the camera (m, default 24). */
  rainArea?: number;
  /** Performers are never darker than this (key / fill as a fraction of the studio lights; defaults 0.62 / 0.55). */
  performers?: { minKey?: number; minFill?: number };
  /** Lighting states in which the light show owns the night-light groups (default preshow + outro). */
  showOwnsNightLights?: string[];
}

export const DEFAULT_ENV_STATE: SceneEnvState = {
  on: true, clock: 'cycle', hour: 17.5, speed: 24, epoch: 0, tz: 0,
  weather: 'clear', weatherMode: 'manual', weatherFrom: 'clear', weatherAt: 0, fade: 40, cycleMins: 10, seed: 1, wind: 1, lightning: true,
};

const numIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export const isEnvWeather = (v: unknown): v is EnvWeather => typeof v === 'string' && (ENV_WEATHERS as readonly string[]).includes(v);

export function sanitizeEnvState(o: unknown, base: SceneEnvState = DEFAULT_ENV_STATE): SceneEnvState {
  const d = base;
  if (!o || typeof o !== 'object') return { ...d };
  const x = o as Record<string, unknown>;
  return {
    on: typeof x.on === 'boolean' ? x.on : d.on,
    clock: x.clock === 'cycle' || x.clock === 'real' || x.clock === 'fixed' ? x.clock : d.clock,
    hour: numIn(x.hour, 0, 24, d.hour) % 24,
    speed: numIn(x.speed, 0.1, 1440, d.speed),
    epoch: numIn(x.epoch, 0, 1e14, d.epoch),
    tz: Math.round(numIn(x.tz, -840, 840, d.tz)),
    weather: isEnvWeather(x.weather) ? x.weather : d.weather,
    weatherMode: x.weatherMode === 'manual' || x.weatherMode === 'cycle' || x.weatherMode === 'state' ? x.weatherMode : d.weatherMode,
    weatherFrom: isEnvWeather(x.weatherFrom) ? x.weatherFrom : isEnvWeather(x.weather) ? x.weather : d.weatherFrom,
    weatherAt: numIn(x.weatherAt, 0, 1e14, d.weatherAt),
    fade: numIn(x.fade, 0, 600, d.fade),
    cycleMins: numIn(x.cycleMins, 1, 240, d.cycleMins),
    seed: Math.round(numIn(x.seed, 0, 2 ** 31, d.seed)),
    wind: numIn(x.wind, 0, 2, d.wind),
    lightning: typeof x.lightning === 'boolean' ? x.lightning : d.lightning,
  };
}

/** The room's starting state (scene.json environment.default over the engine defaults). */
export function envDefaults(cfg?: RoomEnvConfig | null): SceneEnvState {
  return sanitizeEnvState(cfg?.default ?? {}, DEFAULT_ENV_STATE);
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Hour of day (0 ≤ h < 24) at wall-clock `now` (ms, this page's clock — guests' states are converted on arrival). */
export function envHour(st: SceneEnvState, now: number): number {
  if (st.clock === 'fixed') return mod(st.hour, 24);
  if (st.clock === 'real') return mod(now / 3.6e6 + st.tz / 60, 24);
  return mod(st.hour + ((now - st.epoch) / 3.6e6) * st.speed, 24);
}

export const fmtHour = (h: number) => { const m = Math.floor(mod(h, 24) * 60 + 1e-6); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------------ weather
/** What a weather does (blended linearly during transitions). */
export interface WeatherParams {
  /** Cloud cover 0..1, storm-dark clouds 0..1. */
  cloud: number; cloudDark: number;
  /** Extra darkness 0..1 (overcast / storm light loss). */
  dark: number;
  rain: number; fog: number; wind: number; bolt: number;
  /** Wetness the ground heads towards. */
  wet: number;
  /** Airborne sand 0..1 (sandstorms: the voyage / desert engines' streaks + ochre haze; walking-ship rooms drive it from
   *  their timeline through EnvScene.drive - never from the climate cycle). */
  dust: number;
}
export const WEATHER_PARAMS: Record<EnvWeather, WeatherParams> = {
  clear: { cloud: 0.14, cloudDark: 0, dark: 0, rain: 0, fog: 0, wind: 0.25, bolt: 0, wet: 0, dust: 0 },
  cloudy: { cloud: 0.5, cloudDark: 0.1, dark: 0.1, rain: 0, fog: 0.04, wind: 0.4, bolt: 0, wet: 0, dust: 0 },
  overcast: { cloud: 0.88, cloudDark: 0.35, dark: 0.34, rain: 0, fog: 0.14, wind: 0.5, bolt: 0, wet: 0, dust: 0 },
  rain: { cloud: 0.94, cloudDark: 0.5, dark: 0.42, rain: 0.42, fog: 0.24, wind: 0.55, bolt: 0, wet: 0.78, dust: 0 },
  heavyrain: { cloud: 1, cloudDark: 0.7, dark: 0.52, rain: 1, fog: 0.4, wind: 0.75, bolt: 0.12, wet: 1, dust: 0 },
  storm: { cloud: 1, cloudDark: 0.9, dark: 0.64, rain: 0.9, fog: 0.34, wind: 1, bolt: 1, wet: 1, dust: 0 },
  fog: { cloud: 0.62, cloudDark: 0.15, dark: 0.26, rain: 0, fog: 1, wind: 0.1, bolt: 0, wet: 0.3, dust: 0 },
  // SPEC D15 (walking-ship rooms): ochre dark sky, short fog (world materials; performers stay clear), full wind, dry
  sandstorm: { cloud: 0.65, cloudDark: 0.3, dark: 0.4, rain: 0, fog: 0.9, wind: 1, bolt: 0, wet: 0, dust: 1 },
};

/** Automatic-cycle odds per climate, in intensity order (clear → storm) + the fog chance. */
const CLIMATES: Record<string, { w: [EnvWeather, number][]; fog: number }> = {
  temperate: { w: [['clear', 0.3], ['cloudy', 0.26], ['overcast', 0.16], ['rain', 0.15], ['heavyrain', 0.08], ['storm', 0.05]], fog: 0.06 },
  jungle: { w: [['clear', 0.14], ['cloudy', 0.22], ['overcast', 0.14], ['rain', 0.22], ['heavyrain', 0.16], ['storm', 0.12]], fog: 0.14 },
  city: { w: [['clear', 0.34], ['cloudy', 0.28], ['overcast', 0.16], ['rain', 0.14], ['heavyrain', 0.05], ['storm', 0.03]], fog: 0.04 },
  coastal: { w: [['clear', 0.24], ['cloudy', 0.26], ['overcast', 0.16], ['rain', 0.16], ['heavyrain', 0.08], ['storm', 0.1]], fog: 0.12 },
  arid: { w: [['clear', 0.66], ['cloudy', 0.22], ['overcast', 0.07], ['rain', 0.03], ['heavyrain', 0.01], ['storm', 0.01]], fog: 0.01 },
};
const ORDER: EnvWeather[] = ['clear', 'cloudy', 'overcast', 'rain', 'heavyrain', 'storm'];

/** Deterministic hash → [0, 1). */
export function hash01(a: number, b = 0, c = 0): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35) ^ Math.imul((c | 0) + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** The automatic cycle's weather for slot `s` (absolute time / slot length): a smoothed random walk through the climate. */
export function cycleWeather(seed: number, s: number, cfg?: RoomEnvConfig | null): EnvWeather {
  const cl = CLIMATES[cfg?.climate ?? 'temperate'] ?? CLIMATES.temperate;
  const allowed = cfg?.weathers?.filter(isEnvWeather);
  // value noise over slots (neighbours differ gradually: clear → cloudy → rain → storm, rarely a jump)
  const x = s * 0.42, i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const lv = hash01(seed, i, 11) * (1 - u) + hash01(seed, i + 1, 11) * u;
  // a Gaussian-ish level (sum with a second octave) → the climate's cumulative odds
  const lv2 = Math.min(0.9999, Math.max(0, lv * 0.8 + hash01(seed, s, 12) * 0.2));
  let acc = 0, pick: EnvWeather = cl.w[cl.w.length - 1][0];
  const total = cl.w.reduce((a, [, p]) => a + p, 0);
  for (const [w, p] of cl.w) { acc += p / total; if (lv2 < acc) { pick = w; break; } }
  if (hash01(seed, s, 13) < cl.fog && pick !== 'storm' && pick !== 'heavyrain') pick = 'fog';
  if (allowed && allowed.length && !allowed.includes(pick)) {
    // nearest allowed weather in the intensity order (fog → overcast's slot)
    const k = pick === 'fog' ? 2 : ORDER.indexOf(pick);
    let best = allowed[0], bd = 99;
    for (const a of allowed) { const j = a === 'fog' ? 2.5 : ORDER.indexOf(a); if (Math.abs(j - k) < bd) { bd = Math.abs(j - k); best = a; } }
    pick = best;
  }
  return pick;
}

export interface WeatherNow {
  from: EnvWeather; to: EnvWeather;
  /** Crossfade 0 (from) … 1 (to). */
  k: number;
  params: WeatherParams;
  /** When the current transition started (ms) — wetness lags behind it. */
  since: number;
  /** Automatic cycle: when the next change starts (ms), null otherwise. */
  next: number | null;
}

const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

export function blendParams(a: WeatherParams, b: WeatherParams, k: number): WeatherParams {
  const o = {} as WeatherParams;
  for (const key of Object.keys(a) as (keyof WeatherParams)[]) o[key] = a[key] + (b[key] - a[key]) * k;
  return o;
}

/** Weather at `now`. 'state' mode is resolved by the caller (the lighting state) and passed in as `stateWeather`. */
export function envWeatherAt(st: SceneEnvState, cfg: RoomEnvConfig | null | undefined, now: number, stateWeather?: EnvWeather | null): WeatherNow {
  if (st.weatherMode === 'cycle') {
    const L = st.cycleMins * 60_000;
    const s = Math.floor(now / L);
    const from = cycleWeather(st.seed, s - 1, cfg), to = cycleWeather(st.seed, s, cfg);
    const fade = Math.min(st.fade * 1000, L * 0.5);
    const k = from === to ? 1 : smooth((now - s * L) / Math.max(1, fade));
    return { from, to, k, params: blendParams(WEATHER_PARAMS[from], WEATHER_PARAMS[to], k), since: s * L, next: (s + 1) * L };
  }
  if (st.weatherMode === 'state' && stateWeather) {
    return { from: stateWeather, to: stateWeather, k: 1, params: { ...WEATHER_PARAMS[stateWeather] }, since: 0, next: null };
  }
  const k = st.weatherFrom === st.weather || st.fade <= 0 ? 1 : smooth((now - st.weatherAt) / (st.fade * 1000));
  return { from: st.weatherFrom, to: st.weather, k, params: blendParams(WEATHER_PARAMS[st.weatherFrom], WEATHER_PARAMS[st.weather], k), since: st.weatherAt, next: null };
}

/** Ground wetness at `now` (closed form: the new weather's wetness is approached from the old one's, wetting in ~40 s,
 *  drying over ~4 min). */
export function envWetAt(w: WeatherNow, now: number): number {
  const wa = WEATHER_PARAMS[w.from].wet, wb = WEATHER_PARAMS[w.to].wet;
  if (!w.since) return w.params.wet;
  const tau = wb >= wa ? 40_000 : 240_000;
  return wb + (wa - wb) * Math.exp(-Math.max(0, now - w.since) / tau);
}

// ------------------------------------------------------------------ lightning
export interface Strike { at: number; power: number; az: number; near: boolean; re: number | null }
const BOLT_SLOT = 1700;
/** Lightning strikes around `now` (the current and previous slots): deterministic from the seed. With `safe` every full
 *  flash is ≥ 340 ms from the next (≤ 3 per second, docs/SCENES.md → Photosensitivity). */
export function envStrikes(seed: number, now: number, bolt: number, safe: boolean): Strike[] {
  if (bolt <= 0.02) return [];
  const out: Strike[] = [];
  const s0 = Math.floor(now / BOLT_SLOT);
  for (let s = s0 - 1; s <= s0; s++) {
    if (hash01(seed, s, 21) > bolt * 0.34) continue;
    const at = s * BOLT_SLOT + hash01(seed, s, 22) * 1000;
    const near = hash01(seed, s, 23) < 0.35;
    const re = hash01(seed, s, 24) < 0.55 ? at + (safe ? 360 : 110 + hash01(seed, s, 25) * 120) : null;
    out.push({ at, power: (near ? 1 : 0.55) * (0.7 + 0.3 * hash01(seed, s, 26)), az: hash01(seed, s, 27) * Math.PI * 2, near, re });
  }
  return out;
}
/** Flash brightness 0..1 at `now` from the strikes (main flash ~0.14 s, re-strike 60 %). */
export function envFlashAt(strikes: Strike[], now: number, safe: boolean): { f: number; az: number; near: boolean; at: number } {
  let f = 0, az = 0, near = false, at = 0;
  const depth = safe ? 0.72 : 1;
  for (const s of strikes) {
    const pulse = (t0: number, k: number) => { const dt = now - t0; return dt < 0 || dt > 420 ? 0 : k * (dt < 30 ? dt / 30 : Math.exp(-(dt - 30) / 95)); };
    const v = (pulse(s.at, 1) + (s.re !== null ? pulse(s.re, 0.6) : 0)) * s.power * depth;
    if (v > f) { f = v; az = s.az; near = s.near; at = s.at; }
  }
  return { f: Math.min(1, f), az, near, at };
}

/** Wind gust factor at `now` (deterministic, 0.55 … 1.45). */
export function envGust(seed: number, now: number): number {
  const t = now / 1000;
  const n = (x: number, k: number) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return hash01(seed, i, k) * (1 - u) + hash01(seed, i + 1, k) * u; };
  return 0.55 + 0.6 * n(t / 7.1, 31) + 0.3 * n(t / 1.9, 32);
}

/** Sun (and moon) elevation / azimuth for an hour of the day. Elevation in degrees; azimuth in radians about +Y. */
export function sunPath(hour: number, cfg?: RoomEnvConfig | null): { el: number; az: number; moonEl: number; moonAz: number } {
  const rise = Math.min(11, Math.max(2, cfg?.sunrise ?? 6)), set = Math.min(22, Math.max(13, cfg?.sunset ?? 18.5)), max = Math.min(88, Math.max(10, cfg?.noonElevation ?? 62));
  const north = ((cfg?.north ?? 0) * Math.PI) / 180;
  // azimuth = angle of the horizontal direction (x = sin az, z = cos az): east (+X) π/2 at sunrise → south (+Z, the
  // camera side) 0 at noon → west (−X) −π/2 at sunset → north (−Z) through the night
  const arc = (h: number, top: number, depth: number) => {
    const dayLen = set - rise, nightLen = 24 - dayLen;
    const t = mod(h - rise, 24);
    if (t <= dayLen) { const f = t / dayLen; return { el: top * Math.sin(Math.PI * f), az: north + Math.PI / 2 - Math.PI * f }; }
    const g = (t - dayLen) / nightLen;
    return { el: -depth * Math.sin(Math.PI * g), az: north - Math.PI / 2 - Math.PI * g };
  };
  const s = arc(hour, max, 38);
  // moon: roughly opposite the sun (rises around sunset, highest after midnight), a little lower, offset sideways
  const m = arc(hour + 12.4, max * 0.8, 30);
  return { el: s.el, az: s.az, moonEl: m.el, moonAz: m.az + 0.35 };
}

/** Darkness 0 (full day) … 1 (deep night) from the sun elevation + weather light loss: night lights switch on it. */
export function envDarkness(sunEl: number, dark: number): number {
  const day = smooth((sunEl + 7) / 12);          // −7° … +5°
  return Math.min(1, 1 - day * (1 - dark * 0.86));
}
