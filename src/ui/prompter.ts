// "Describe your room": turns a few words (+ style chips, time of day, weather, calm ↔ busy) into a room set-up.
//  1. Instant: picks the best existing room and the lighting preset, time, weather and background action that fit,
//     shows the plan in plain words, and applies it only when the performer clicks "Set it up" (with Undo).
//  2. "Generate new room (takes a while)": records the request as a server job (POST /api/rooms/generate,
//     shared/roomGen.ts) for the AI room builder; today that job explains that generation is coming.
import type { App } from '../app.ts';
import type { SceneInfo, SceneMode, SceneState } from '../../shared/types.ts';
import { SHOW_PRESETS, type ShowPreset } from '../../shared/lightPresets.ts';
import { ENV_WEATHERS, WEATHER_ICON, WEATHER_LABEL, type EnvWeather, type SceneEnvState } from '../../shared/environment.ts';
import { ROOM_STYLES, type RoomGenerateRequest, type RoomStyle } from '../../shared/roomGen.ts';
import type { Job } from '../../shared/types.ts';
import { waitJob } from '../api.ts';
import { button, h, sliderControl, toast } from './dom.ts';

// ---------------------------------------------------------------- what each shipped room is like
type RoomTag = { tags: RoomStyle[]; words: string[]; blurb: string };
const ROOMS: Record<string, RoomTag> = {
  eft_customs_dorms: { tags: ['cozy'], blurb: 'A lived-in soldiers’ lounge', words: ['dorm', 'dorms', 'barracks', 'military', 'tactical', 'tarkov', 'customs', 'soldier', 'soldiers', 'army', 'lounge', 'abandoned', 'soviet', 'gritty', 'bunker'] },
  eft_factory: { tags: ['horror'], blurb: 'A dark industrial hall', words: ['factory', 'industrial', 'warehouse', 'dark', 'gritty', 'tarkov', 'abandoned', 'rust', 'rusty', 'concrete', 'horror', 'creepy', 'scary', 'grim', 'machines'] },
  eft_labs: { tags: ['sci-fi'], blurb: 'A high-tech secret lab office', words: ['lab', 'labs', 'laboratory', 'office', 'corporate', 'clean', 'science', 'research', 'secret', 'tech', 'facility', 'modern', 'white', 'hightech'] },
  eft_labs_rnd: { tags: ['sci-fi'], blurb: 'Research domes', words: ['lab', 'research', 'dome', 'domes', 'science', 'experiment', 'futuristic', 'clean', 'tech', 'bio', 'greenhouse'] },
  gzw_crimson_camp: { tags: ['jungle'], blurb: 'A jungle army camp with real weather', words: ['jungle', 'camp', 'tropical', 'forest', 'rainforest', 'military', 'outdoor', 'outdoors', 'outside', 'tent', 'humid', 'wild', 'nature', 'trees', 'army', 'base'] },
  helldivers_bridge: { tags: ['sci-fi'], blurb: 'A starship bridge over a space battle', words: ['space', 'spaceship', 'ship', 'bridge', 'starship', 'destroyer', 'orbit', 'galaxy', 'stars', 'scifi', 'battle', 'war', 'helldivers', 'planet', 'cockpit', 'fleet', 'lasers'] },
  poe2_kingsmarch: { tags: ['fantasy', 'cozy'], blurb: 'A fantasy harbour terrace', words: ['fantasy', 'medieval', 'harbour', 'harbor', 'port', 'sea', 'ocean', 'coast', 'coastal', 'castle', 'tavern', 'village', 'ships', 'magic', 'rpg', 'terrace', 'lanterns', 'boats', 'docks', 'pirate'] },
  sc_area18: { tags: ['city', 'sci-fi'], blurb: 'A sci-fi city overlook', words: ['city', 'cyberpunk', 'skyline', 'neon', 'tower', 'skyscraper', 'urban', 'future', 'futuristic', 'downtown', 'metropolis', 'rooftop', 'scifi', 'balcony', 'lights', 'traffic'] },
};
/** What a room is like: the built-in entry, else the room's own scene.json `prompter` {tags, blurb, words}. */
function roomTag(r: SceneInfo): RoomTag | undefined {
  if (ROOMS[r.id]) return ROOMS[r.id];
  const p = (r as SceneInfo & { prompter?: unknown }).prompter;
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase().slice(0, 32)).slice(0, 40) : []);
  return { tags: list(o.tags).filter((t): t is RoomStyle => (ROOM_STYLES as readonly string[]).includes(t)), words: list(o.words), blurb: typeof o.blurb === 'string' ? o.blurb.slice(0, 80) : '' };
}
/** Grey boxes / test yards are for builders — hidden in the Simple views and never suggested. */
export const isTestRoom = (r: Pick<SceneInfo, 'id' | 'name'>) => /(^|_)test(_|$)|test room|grey box|test yard/i.test(`${r.id} ${r.name}`);

const STYLE_WORDS: Record<RoomStyle, { words: string[]; presets: string[]; label: string; icon: string }> = {
  cozy: { label: 'Cozy', icon: '🛋', words: ['cozy', 'cosy', 'warm', 'chill', 'comfy', 'relax', 'relaxing', 'lounge', 'homey', 'snug', 'candle', 'candles', 'lofi', 'lo-fi', 'quiet'], presets: ['chill_lounge', 'candlelight', 'vinyl_night', 'lofi_rain'] },
  'sci-fi': { label: 'Sci-fi', icon: '🚀', words: ['sci-fi', 'scifi', 'futuristic', 'future', 'space', 'tech', 'cyber', 'robot', 'spaceship', 'alien'], presets: ['galaxy', 'neon_noir', 'ice_palace', 'deep_sea'] },
  fantasy: { label: 'Fantasy', icon: '🏰', words: ['fantasy', 'medieval', 'magic', 'magical', 'tavern', 'castle', 'dragon', 'elf', 'rpg', 'knight'], presets: ['candlelight', 'sunrise_set', 'sunset_bbq'] },
  horror: { label: 'Horror', icon: '👻', words: ['horror', 'scary', 'creepy', 'spooky', 'eerie', 'haunted', 'dread', 'halloween', 'ghost', 'sinister'], presets: ['horror_red', 'witching_hour', 'afterhours'] },
  jungle: { label: 'Jungle', icon: '🌴', words: ['jungle', 'tropical', 'rainforest', 'forest', 'wild', 'nature', 'humid'], presets: ['rainforest', 'tropical'] },
  city: { label: 'City', icon: '🌆', words: ['city', 'urban', 'cyberpunk', 'downtown', 'street', 'skyline', 'metropolis', 'neon'], presets: ['neon_noir', 'retro_80s', 'ocean_drive'] },
  party: { label: 'Party', icon: '🪩', words: ['party', 'club', 'rave', 'dance', 'dj', 'disco', 'hype', 'festival', 'banger'], presets: ['club_classic', 'disco_fever', 'big_room'] },
};
export const STYLE_CHIPS = ROOM_STYLES.map((id) => ({ id, ...STYLE_WORDS[id] }));

export const TIME_CHIPS = [
  { id: 'dawn', label: 'Dawn', icon: '🌅' }, { id: 'day', label: 'Day', icon: '☀️' },
  { id: 'sunset', label: 'Sunset', icon: '🌇' }, { id: 'night', label: 'Night', icon: '🌙' },
] as const;
const TIME_WORDS: [RegExp, string][] = [
  [/\b(dawn|sunrise|early morning|daybreak)\b/, 'dawn'], [/\b(morning|noon|midday|daytime|day ?light|sunny|afternoon|bright day)\b/, 'day'],
  [/\b(sunset|dusk|golden hour|evening|twilight)\b/, 'sunset'], [/\b(night|midnight|late night|nighttime|starry|moonlit|moon)\b/, 'night'],
];
const WEATHER_WORDS: [RegExp, EnvWeather][] = [
  [/\b(thunder|lightning|storm|stormy)\b/, 'storm'], [/\b(downpour|heavy rain|pouring|monsoon)\b/, 'heavyrain'],
  [/\b(rain|rainy|raining|drizzle|wet)\b/, 'rain'], [/\b(fog|foggy|mist|misty|haze|hazy)\b/, 'fog'],
  [/\b(overcast|grey sky|gray sky|gloomy)\b/, 'overcast'], [/\b(cloud|clouds|cloudy)\b/, 'cloudy'], [/\b(clear|sunny|blue sky)\b/, 'clear'],
];
export const BUSY_LABELS = ['Very calm', 'Calm', 'As the room is', 'Lively', 'Chaos'];

// ---------------------------------------------------------------- the plan
export interface PromptInput { prompt: string; styles: RoomStyle[]; time: string | null; weather: EnvWeather | null; busy: number }
export interface PlanLine { icon: string; text: string; why: string }
export interface RoomPlan {
  roomId: string | null; roomName: string; lines: PlanLine[];
  hour: number | null; weather: EnvWeather | null; preset: ShowPreset | null; lighting: string | null;
  raid: { on: boolean; intensity: 'chill' | 'normal' | 'hot' } | null; space: { on: boolean; intensity: 'chill' | 'normal' | 'hot' } | null;
  mode: SceneMode | null; score: number;
}

const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 \-']/g, ' ').split(/\s+/).filter(Boolean);

export function planRoom(app: App, inp: PromptInput): RoomPlan {
  const S = app.scene;
  const text = ` ${inp.prompt.toLowerCase()} `;
  const tk = new Set(tokens(inp.prompt));
  const styles = new Set<RoomStyle>(inp.styles);
  for (const s of ROOM_STYLES) if (STYLE_WORDS[s].words.some((w) => tk.has(w) || (w.includes(' ') && text.includes(w)))) styles.add(s);
  let time = inp.time;
  if (!time) for (const [re, t] of TIME_WORDS) if (re.test(text)) { time = t; break; }
  let weather = inp.weather;
  if (!weather) for (const [re, w] of WEATHER_WORDS) if (re.test(text)) { weather = w; break; }
  let busy = inp.busy;
  if (busy === 2) {
    if (/\b(chaos|chaotic|war|warzone|battle|intense|action|explosions|firefight|busy)\b/.test(text)) busy = 4;
    else if (/\b(lively|active|bustling|some action)\b/.test(text)) busy = 3;
    else if (/\b(calm|quiet|peaceful|relax|relaxing|serene|still|cozy|cosy)\b/.test(text)) busy = 1;
  }
  const wantsSky = !!time || !!weather;

  // ---- pick a room
  const rooms = S.scenes.filter((r) => r.ready !== false && !isTestRoom(r));
  let best: SceneInfo | null = null, bestScore = -1, bestWhy: string[] = [];
  for (const r of rooms) {
    const tag = roomTag(r);
    const words = tag?.words ?? tokens(`${r.name} ${r.id.replace(/_/g, ' ')}`);
    let score = 0; const why: string[] = [];
    const hits = words.filter((w) => tk.has(w));
    if (hits.length) { score += hits.length * 2; why.push(`you said “${hits.slice(0, 3).join('”, “')}”`); }
    for (const s of styles) if (tag?.tags.includes(s)) { score += 3; why.push(`${STYLE_WORDS[s].label.toLowerCase()} style`); }
    if (!tag) { // a room this file doesn't know yet: its features still count
      if (r.space && styles.has('sci-fi')) score += 2;
      if (r.environment && (styles.has('jungle') || styles.has('fantasy'))) score += 1;
    }
    if (wantsSky) { if (r.environment) { score += 1.5; why.push('it has a real sky for time & weather'); } else score -= 1; }
    if (busy >= 3 && (r.raid || r.space)) { score += 1; why.push('it has background action'); }
    if (score > bestScore) { best = r; bestScore = score; bestWhy = why; }
  }
  if (best && bestScore <= 0) {
    // nothing matched: keep the current room if there is one, else the first nice one
    const cur = S.effective.sceneId ? rooms.find((r) => r.id === S.effective.sceneId) : null;
    best = cur ?? rooms.find((r) => r.id === 'poe2_kingsmarch') ?? rooms[0] ?? null;
    bestWhy = [cur ? 'nothing specific matched, so your current room stays' : 'a good all-round room'];
  }
  const room = best;
  const lines: PlanLine[] = [];
  if (room) lines.push({ icon: '🏠', text: room.id === S.effective.sceneId ? `Stay in ${room.name}` : `Room: ${room.name}`, why: `${roomTag(room)?.blurb ?? ''}${bestWhy.length ? ` — ${bestWhy.slice(0, 2).join(', ')}` : ''}` });

  // ---- time + weather (rooms with a sky)
  let hour: number | null = null;
  const env = room?.environment;
  if (time) {
    if (env) {
      hour = time === 'dawn' ? (env.sunrise ?? 6) + 0.25 : time === 'day' ? 12.5 : time === 'sunset' ? (env.sunset ?? 18.5) - 0.3 : 22.5;
      lines.push({ icon: TIME_CHIPS.find((t) => t.id === time)?.icon ?? '🕒', text: `Time: ${TIME_CHIPS.find((t) => t.id === time)?.label ?? time} (the clock stops there)`, why: 'you can let the clock run again in Room → Advanced → Time & weather' });
    } else lines.push({ icon: '🕒', text: 'Time of day: not in this room', why: 'this room has fixed lighting (no sky)' });
  } else if (env && styles.has('horror')) { hour = 23; lines.push({ icon: '🌙', text: 'Time: night', why: 'horror reads best in the dark' }); }
  let wx: EnvWeather | null = null;
  if (weather) {
    if (env) { wx = weather; lines.push({ icon: WEATHER_ICON[weather], text: `Weather: ${WEATHER_LABEL[weather]}`, why: 'manual weather — it stays until you change it' }); }
    else lines.push({ icon: '🌦', text: 'Weather: not in this room', why: 'only outdoor rooms have weather' });
  } else if (env && styles.has('horror')) { wx = 'fog'; lines.push({ icon: WEATHER_ICON.fog, text: 'Weather: fog', why: 'extra creepy' }); }

  // ---- lights: a show preset whose name / vibe fits
  let preset: ShowPreset | null = null, pScore = 0;
  for (const p of SHOW_PRESETS) {
    let sc = 0;
    const words = tokens(`${p.name} ${p.vibe}`);
    for (const w of words) if (w.length > 3 && tk.has(w)) sc += 2;
    for (const s of styles) if (STYLE_WORDS[s].presets.includes(p.id)) sc += 3 - STYLE_WORDS[s].presets.indexOf(p.id) * 0.4;
    if (busy <= 1 && p.cat === 'chill') sc += 0.5;
    if (busy >= 4 && p.cat === 'banger') sc += 0.5;
    if (sc > pScore) { pScore = sc; preset = p; }
  }
  if (pScore < 1.5) preset = null;
  if (preset) lines.push({ icon: '💡', text: `Lights: ${preset.name}`, why: preset.vibe });

  // ---- lighting state words
  let lighting: string | null = null;
  if (/\b(starting soon|pre-?show|intro|countdown)\b/.test(text)) lighting = 'preshow';
  else if (/\b(brb|be right back|break)\b/.test(text)) lighting = 'brb';
  else if (/\b(outro|ending|goodnight|after ?party)\b/.test(text)) lighting = 'outro';
  if (lighting) lines.push({ icon: '🎬', text: `Lighting state: ${lighting.toUpperCase()}`, why: 'the big buttons at the top of Room switch these any time' });

  // ---- background action
  const act = (): { on: boolean; intensity: 'chill' | 'normal' | 'hot' } | null => busy === 2 ? null : busy <= 0 ? { on: false, intensity: 'chill' } : busy === 1 ? { on: true, intensity: 'chill' } : busy === 3 ? { on: true, intensity: 'normal' } : { on: true, intensity: 'hot' };
  const raid = room?.raid ? act() : null;
  const space = room?.space ? act() : null;
  if (raid || space) {
    const a = (raid ?? space)!;
    lines.push({ icon: room?.space ? '🚀' : '⚔️', text: !a.on ? 'Background action: off' : `Background action: ${a.intensity === 'chill' ? 'now and then' : a.intensity === 'normal' ? 'regular' : 'non-stop'}`, why: room?.space ? 'the space battle outside the window' : 'soldiers skirmishing far behind you (never in front of your face)' });
  } else if (busy !== 2 && room && !room.raid && !room.space) lines.push({ icon: '🌿', text: 'Background action: this room is always calm', why: 'it has no background battles' });

  // ---- mode
  let mode: SceneMode | null = null;
  if (/\b(react|reacting|watch|watching|movie|video|youtube|screen)\b/.test(text)) { mode = 'react'; lines.push({ icon: '🖥', text: 'Mode: React (the screen comes down)', why: 'you mentioned watching something' }); }

  return { roomId: room?.id ?? null, roomName: room?.name ?? 'Classic', lines, hour, weather: wx, preset, lighting, raid, space, mode, score: bestScore };
}

// ---------------------------------------------------------------- apply / undo
type Snapshot = { sceneId: string | null; env: SceneState['env']; program: string; groups: SceneState['lights']['groups']; state: string | undefined; raid: SceneState['raid']; space: SceneState['space']; mode: SceneMode };
let undo: Snapshot | null = null;
export const canUndo = () => !!undo;

export function applyPlan(app: App, plan: RoomPlan) {
  const S = app.scene;
  if (!S.canEdit) { toast('The host runs the room while you are a guest.', 'warn'); return; }
  const st = S.effective;
  undo = { sceneId: st.sceneId, env: st.env ? JSON.parse(JSON.stringify(st.env)) : undefined, program: st.lights.program, groups: st.lights.groups, state: st.lights.state, raid: st.raid ? { ...st.raid } : undefined, space: st.space ? { ...st.space } : undefined, mode: st.mode };
  if (plan.roomId && plan.roomId !== st.sceneId) S.setScene(plan.roomId);
  const envPatch: Partial<SceneEnvState> = {};
  if (plan.hour !== null) Object.assign(envPatch, { on: true, hour: plan.hour, clock: 'fixed' as const });
  if (plan.weather) Object.assign(envPatch, { on: true, weather: plan.weather, weatherMode: 'manual' as const });
  if (Object.keys(envPatch).length) S.setEnv(envPatch);
  if (plan.preset) S.setLights({ program: `p_${plan.preset.id}`, groups: undefined });
  if (plan.lighting) S.setLighting(plan.lighting);
  if (plan.raid) S.setRaid(plan.raid);
  if (plan.space) S.setSpace(plan.space);
  if (plan.mode && plan.mode !== S.effective.mode) S.setMode(plan.mode);
  toast(S.observer ? 'Set up in this observer preview (not sent to OBS).' : 'Room set up — your OBS shows it now. Changed your mind? Click Undo.', 'ok', 5000);
}
export function undoPlan(app: App) {
  const S = app.scene, u = undo;
  if (!u) return;
  undo = null;
  if (u.sceneId !== S.effective.sceneId) S.setScene(u.sceneId);
  if (u.env) S.setEnv(u.env);
  S.setLights({ program: u.program, groups: u.groups });
  if (u.state) S.setLighting(u.state);
  if (u.raid) S.setRaid(u.raid);
  if (u.space) S.setSpace(u.space);
  if (u.mode !== S.effective.mode) S.setMode(u.mode);
  toast('Undone — the room is back the way it was.', 'ok');
}

// ---------------------------------------------------------------- generate (server job)
export async function requestRoomGeneration(req: RoomGenerateRequest): Promise<string> {
  const r = await fetch('/api/rooms/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
  const b = (await r.json().catch(() => ({}))) as { jobId?: string; error?: string };
  if (!r.ok || !b.jobId) throw new Error(b.error ?? `HTTP ${r.status}`);
  return b.jobId;
}

// ---------------------------------------------------------------- the UI block
const draft: PromptInput & { plan: RoomPlan | null; job: Job | null; genBusy: boolean } = { prompt: '', styles: [], time: null, weather: null, busy: 2, plan: null, job: null, genBusy: false };

/** The prompter card (Room → Simple, the room wizard). `refresh` re-renders the host view. */
export function roomPrompter(app: App, refresh: () => void, opts: { compact?: boolean } = {}): HTMLElement {
  const S = app.scene;
  const ta = h('textarea', {
    placeholder: 'e.g. “a cozy fantasy tavern by the sea at sunset, a bit of rain” or “creepy abandoned factory at night”',
    value: draft.prompt, rows: 3, 'aria-label': 'Describe your room',
    onInput: (e: Event) => { draft.prompt = (e.target as HTMLTextAreaElement).value; },
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); find(); } },
  }) as HTMLTextAreaElement;
  const find = () => {
    draft.prompt = ta.value;
    if (!draft.prompt.trim() && !draft.styles.length && !draft.time && !draft.weather && draft.busy === 2) { toast('Describe your room or pick a style first', 'warn'); return; }
    if (!S.scenes.length) { toast('No rooms found yet — is the server running?', 'warn'); return; }
    draft.plan = planRoom(app, draft);
    refresh();
  };
  const pill = (on: boolean, label: string, onClick: () => void, title = '') => h('button', { class: `s-pill ${on ? 'on' : ''}`, onClick, title, 'aria-pressed': String(on) }, label);
  const styleChips = h('div', { class: 's-pills' }, ...STYLE_CHIPS.map((c) => pill(draft.styles.includes(c.id), `${c.icon} ${c.label}`, () => {
    draft.styles = draft.styles.includes(c.id) ? draft.styles.filter((x) => x !== c.id) : [...draft.styles, c.id];
    draft.prompt = ta.value; refresh();
  })));
  const timeChips = h('div', { class: 's-pills' }, ...TIME_CHIPS.map((c) => pill(draft.time === c.id, `${c.icon} ${c.label}`, () => { draft.time = draft.time === c.id ? null : c.id; draft.prompt = ta.value; refresh(); })));
  const wxShown: EnvWeather[] = ['clear', 'cloudy', 'rain', 'storm', 'fog'];
  const wxChips = h('div', { class: 's-pills' }, ...wxShown.filter((w) => (ENV_WEATHERS as readonly string[]).includes(w)).map((w) => pill(draft.weather === w, `${WEATHER_ICON[w]} ${WEATHER_LABEL[w]}`, () => { draft.weather = draft.weather === w ? null : w; draft.prompt = ta.value; refresh(); })));
  const busyOut = h('b', null, BUSY_LABELS[draft.busy]);
  const busy = sliderControl(draft.busy, 0, 4, 1, (v) => { draft.busy = v; busyOut.textContent = BUSY_LABELS[draft.busy]; },
    { inline: true, label: 'Calm or busy', def: 2 });

  const plan = draft.plan;
  const planBox = plan ? h('div', { class: 'pr-plan', 'aria-live': 'polite' },
    h('h4', null, '✨ Here’s the plan'),
    h('ul', null, ...plan.lines.map((l) => h('li', null, h('span', null, l.icon), h('span', null, l.text, l.why ? h('div', { class: 'why' }, l.why) : null)))),
    h('div', { class: 's-row' },
      button(S.observer ? 'Set it up (preview only)' : 'Set it up', () => { applyPlan(app, plan); draft.plan = null; refresh(); }, 'primary'),
      button('Not quite — change the words', () => { draft.plan = null; refresh(); ta.focus(); }, 'ghost')),
    !S.observer ? h('p', { class: 'note', style: 'margin:6px 0 0' }, 'This changes what your viewers see on OBS.') : null,
  ) : null;

  // generation job (server) — clearly the slow path
  const job = draft.job;
  const gen = h('div', { class: 'pr-gen' },
    h('div', { class: 's-row between' },
      h('div', null, h('b', null, 'Want a brand-new room?'), h('div', { class: 'note', style: 'margin:2px 0 0' }, 'AI builds one from your description. This takes a while.')),
      button(draft.genBusy ? 'Sending…' : 'Generate new room (takes a while)', async () => {
        draft.prompt = ta.value;
        if (!draft.prompt.trim() && !draft.styles.length) { toast('Describe the room first', 'warn'); return; }
        draft.genBusy = true; refresh();
        try {
          const id = await requestRoomGeneration({ prompt: draft.prompt, styles: draft.styles, time: draft.time, weather: draft.weather, busy: draft.busy, basedOn: draft.plan?.roomId ?? planRoom(app, draft).roomId });
          draft.job = await waitJob(id, (j) => { draft.job = j; });
          toast('Room request saved ✓ — AI room building is coming in an update; your request is kept.', 'ok', 6500);
        } catch (e) { toast(`Couldn’t send the request: ${(e as Error).message}`, 'err', 7000); }
        draft.genBusy = false; refresh();
      })),
    job ? h('div', { class: 'note', style: 'margin:8px 0 0' },
      h('span', { class: `s-badge ${job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'warn' : ''}` }, job.status === 'succeeded' ? 'saved' : job.status),
      ' ', job.result?.stub ? 'Your request is saved. Room generation isn’t switched on in this version yet — it will build this room as soon as it ships. Until then, “Find my room” sets up the closest existing one.' : (job.log.slice(-1)[0] ?? '')) : null);

  const bl = opts.compact ? null : h('p', { class: 'lead' }, 'Say what you want in your own words. VTube Pro picks the best room, lights, time of day and weather — nothing changes until you click “Set it up”.');
  return h('div', { class: 'pr-box' }, bl, ta,
    h('div', { class: 's-field' }, h('span', null, 'Style'), styleChips),
    h('div', { class: 's-grid two', style: 'gap:10px' },
      h('div', { class: 's-field' }, h('span', null, 'Time of day'), timeChips),
      h('div', { class: 's-field' }, h('span', null, 'Weather'), wxChips)),
    h('label', { class: 'pr-slider', title: 'Background action: soldiers, space battles, … (only rooms that have them)' }, h('span', null, 'Calm'), busy, h('span', null, 'Busy')),
    h('div', { class: 'note', style: 'margin:-4px 0 8px;text-align:center' }, 'Background action: ', busyOut),
    h('div', { class: 's-row' }, button('Find my room', find, 'primary'), h('span', { class: 'note', style: 'margin:0' }, h('span', { class: 'kbd' }, 'Ctrl'), '+', h('span', { class: 'kbd' }, 'Enter'))),
    planBox,
    canUndo() && !plan ? h('div', { class: 's-row', style: 'margin-top:8px' }, button('↶ Undo the last set-up', () => { undoPlan(app); refresh(); })) : null,
    gen);
}
