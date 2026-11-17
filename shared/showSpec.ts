// VTube Pro Live, W1: show specs (graft G5), pure. Implements ShowSpecApi (shared/broadcastTypes.ts).
//
// validateShowSpec: a .vtpshow file / a built-in template -> a checked, normalized ShowSpec, or one plain sentence.
// diffShowSpec: (spec, what the backend has) -> the ordered obs-websocket v5 requests that make the backend match.
//
//  * IDEMPOTENT: apply the ops, read the backend again, diff again: zero ops. (tools/broadcast_core_unit.ts proves it with
//    a simulator that applies every op type this file can emit.)
//  * ROOM DATA is separate from topology. A room switch changes only `spec.room`, which is pushed into the avatar-page
//    sources' settings under the key ROOM_SETTINGS_KEY with its own SetInputSettings op. It never creates or removes a
//    source, scene or scene item.
//  * Only objects whose name starts with SPEC_PREFIX ("VTube Pro ") are ever removed. Anything else is listed in `foreign`
//    and left alone. Extra filters on one of our sources are left alone too (the person may have added their own).
//
// Workarounds for what the frozen contract (BackendShape) does not carry, done locally and documented here:
//  * Scene items have no sceneItemId in BackendShape. Item ops (SetSceneItemEnabled / SetSceneItemTransform /
//    SetSceneItemIndex / RemoveSceneItem) therefore carry `sceneName` + `sourceName`; the executor resolves the numeric
//    sceneItemId with GetSceneItemId { sceneName, sourceName } just before sending (that request exists in obs-websocket v5).
//  * Audio state (volume, mute, tracks, sync offset) is not in BackendShape. A backend MAY add `audio` to an input of the
//    shape (see ShapeInputWithAudio); when it is absent the audio ops are only emitted for inputs this diff creates.

import type {
  BackendShape, RoomData, ShowSpec, ShowSpecApi, ShowSpecDiff, ShowTemplate, SpecAudio, SpecFilter, SpecItem, SpecOp,
  SpecScene, SpecSource, SpecSourceKind, SpecTransform, VideoFormat,
} from './broadcastTypes.ts';

/** Everything this module creates or removes has this name prefix. */
export const SPEC_PREFIX = 'VTube Pro ';
/** The avatar-page settings key that carries the current room's data. */
export const ROOM_SETTINGS_KEY = 'vtpRoom';

/** SpecSourceKind -> obs-websocket inputKind. */
export const OBS_INPUT_KIND: Record<SpecSourceKind, string> = {
  'avatar-page': 'browser_source', 'game-capture': 'game_capture', 'window-capture': 'window_capture',
  'display-capture': 'monitor_capture', 'camera': 'dshow_input', 'mic': 'wasapi_input_capture',
  'desktop-audio': 'wasapi_output_capture', 'media': 'ffmpeg_source', 'browser': 'browser_source', 'image': 'image_source',
  'text': 'text_gdiplus_v3', 'color': 'color_source_v3',
};
const AUDIO_KINDS: ReadonlySet<SpecSourceKind> = new Set<SpecSourceKind>(['mic', 'desktop-audio']);
const TEMPLATES: readonly ShowTemplate[] = ['just-chatting', 'gaming', 'react', 'interview', 'brb'];
const LIMITS = { sources: 200, scenes: 50, itemsPerScene: 200, filtersPerSource: 30, rooms: 16 } as const;

/** What a backend may add to an input of BackendShape when it can read audio state. */
export interface ShapeAudio { volumeDb: number; muted: boolean; tracks: number[]; syncOffsetMs: number }
export type ShapeInputWithAudio = BackendShape['inputs'][number] & { audio?: ShapeAudio };

// ---------------------------------------------------------------- validation

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
class SpecError extends Error {}
const fail = (say: string): never => { throw new SpecError(say); };

function reqStr(o: Obj, k: string, what: string, max = 200): string {
  const v = o[k];
  if (!isStr(v) || v.trim() === '' || v.length > max) fail(`${what} needs a ${k}.`);
  return v as string;
}
function reqNum(o: Obj, k: string, what: string, lo: number, hi: number): number {
  const v = o[k];
  if (!isNum(v) || v < lo || v > hi) fail(`${what} has a ${k} that does not make sense.`);
  return v as number;
}
function triple(v: unknown, what: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(isNum)) return fail(`${what} needs three numbers.`);
  const a = v as number[];
  return [a[0], a[1], a[2]];
}

function normRoom(raw: unknown): RoomData | null {
  if (raw === null || raw === undefined) return null;
  if (!isObj(raw)) return fail('The room part of this show is not readable.');
  const roomId = reqStr(raw, 'roomId', 'The room');
  const cams = raw.cameras;
  if (!Array.isArray(cams) || cams.length > LIMITS.rooms) fail('The room cameras are not readable.');
  const cameras = (cams as unknown[]).map((c, n) => {
    if (!isObj(c)) fail(`Room camera ${n + 1} is not readable.`);
    const co = c as Obj;
    return { id: reqStr(co, 'id', `Room camera ${n + 1}`), fov: reqNum(co, 'fov', `Room camera ${n + 1}`, 1, 179),
      pos: triple(co.pos, `Room camera ${n + 1} position`), look: triple(co.look, `Room camera ${n + 1} target`) };
  });
  let quad: [number, number][] | null = null;
  if (raw.quad !== null && raw.quad !== undefined) {
    const q = raw.quad;
    if (!Array.isArray(q) || q.length !== 4 || !q.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) {
      fail('The screen corners in this room need four points.');
    }
    quad = (q as number[][]).map((p) => [p[0], p[1]] as [number, number]);
  }
  const fit = raw.fit === undefined ? null : raw.fit;
  if (fit !== null && fit !== 'fit' && fit !== 'fill') fail('The screen fit must be fit or fill.');
  return { roomId, cameras, quad, fit: fit as RoomData['fit'] };
}

function normFilters(raw: unknown, srcName: string): SpecFilter[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.filtersPerSource) fail(`The filters of ${srcName} are not readable.`);
  const seen = new Set<string>();
  return (raw as unknown[]).map((f) => {
    if (!isObj(f)) fail(`A filter of ${srcName} is not readable.`);
    const fo = f as Obj;
    const id = reqStr(fo, 'id', `A filter of ${srcName}`, 120);
    if (seen.has(id)) fail(`${srcName} has two filters called ${id}.`);
    seen.add(id);
    if (!isObj(fo.settings)) fail(`The filter ${id} of ${srcName} needs settings.`);
    if (fo.enabled !== undefined && typeof fo.enabled !== 'boolean') fail(`The filter ${id} of ${srcName} must be on or off.`);
    return { id, kind: reqStr(fo, 'kind', `The filter ${id}`, 120), settings: fo.settings as Obj, enabled: fo.enabled !== false };
  });
}

function normTransform(raw: unknown, what: string): SpecTransform {
  if (!isObj(raw)) return fail(`${what} needs a position and size.`);
  const t: SpecTransform = {
    x: reqNum(raw, 'x', what, -100000, 100000), y: reqNum(raw, 'y', what, -100000, 100000),
    w: reqNum(raw, 'w', what, 0, 100000), h: reqNum(raw, 'h', what, 0, 100000), rotation: reqNum(raw, 'rotation', what, -3600, 3600),
  };
  if (raw.crop !== undefined) {
    if (!isObj(raw.crop)) fail(`${what} has a crop that is not readable.`);
    const c = raw.crop as Obj;
    t.crop = { l: reqNum(c, 'l', what, 0, 100000), t: reqNum(c, 't', what, 0, 100000), r: reqNum(c, 'r', what, 0, 100000), b: reqNum(c, 'b', what, 0, 100000) };
  }
  return t;
}

export function validateShowSpec(raw: unknown): { ok: true; spec: ShowSpec } | { ok: false; say: string } {
  try {
    if (!isObj(raw)) return { ok: false, say: 'This is not a VTube Pro show file.' };
    if (raw.v !== 1) return { ok: false, say: 'This show file is from a different version of VTube Pro and cannot be opened here.' };
    let src: Obj;
    try { src = JSON.parse(JSON.stringify(raw)) as Obj; } catch { return { ok: false, say: 'This show file is not readable.' }; }

    const id = reqStr(src, 'id', 'The show', 120);
    const name = reqStr(src, 'name', 'The show');
    if (!TEMPLATES.includes(src.template as ShowTemplate)) fail('The show needs a type: just chatting, gaming, react, interview or BRB.');
    if (!isObj(src.canvas)) fail('The show needs a picture size.');
    const cv = src.canvas as Obj;
    const canvas: VideoFormat = {
      width: reqNum(cv, 'width', 'The picture size', 160, 7680), height: reqNum(cv, 'height', 'The picture size', 160, 7680),
      fps: reqNum(cv, 'fps', 'The picture size', 1, 240),
    };
    if (!Number.isInteger(canvas.width) || !Number.isInteger(canvas.height) || !Number.isInteger(canvas.fps)) fail('The picture size must be whole numbers.');

    if (!isObj(src.topology)) fail('The show needs its sources and scenes.');
    const tp = src.topology as Obj;
    if (!Array.isArray(tp.sources) || tp.sources.length > LIMITS.sources) fail('The sources of this show are not readable.');
    if (!Array.isArray(tp.scenes) || tp.scenes.length === 0 || tp.scenes.length > LIMITS.scenes) fail('The show needs at least one scene.');

    const names = new Set<string>();
    const claimName = (n: string, what: string) => {
      if (!n.startsWith(SPEC_PREFIX)) fail(`${what} “${n}” must start with “${SPEC_PREFIX.trim()}”.`);
      const k = n.toLowerCase();
      if (names.has(k)) fail(`Two things in this show are called “${n}”.`);
      names.add(k);
    };

    const sources: SpecSource[] = [];
    const srcIds = new Set<string>();
    for (const s of tp.sources as unknown[]) {
      if (!isObj(s)) { fail('A source in this show is not readable.'); continue; }
      const so = s as Obj;
      const sid = reqStr(so, 'id', 'A source', 120);
      if (srcIds.has(sid)) fail(`Two sources share the id ${sid}.`);
      srcIds.add(sid);
      const kind = so.kind as SpecSourceKind;
      if (!isStr(kind) || !(kind in OBS_INPUT_KIND)) fail(`The source ${sid} has a kind VTube Pro does not know.`);
      const sname = reqStr(so, 'name', `The source ${sid}`);
      claimName(sname, 'The source');
      if (!isObj(so.settings)) fail(`The source ${sid} needs settings.`);
      sources.push({ id: sid, kind, name: sname, settings: so.settings as Obj, filters: normFilters(so.filters, sname) });
    }

    const scenes: SpecScene[] = [];
    const sceneIds = new Set<string>();
    for (const sc of tp.scenes as unknown[]) {
      if (!isObj(sc)) { fail('A scene in this show is not readable.'); continue; }
      const co = sc as Obj;
      const cid = reqStr(co, 'id', 'A scene', 120);
      if (sceneIds.has(cid)) fail(`Two scenes share the id ${cid}.`);
      sceneIds.add(cid);
      const cname = reqStr(co, 'name', `The scene ${cid}`);
      claimName(cname, 'The scene');
      if (!Array.isArray(co.items) || co.items.length > LIMITS.itemsPerScene) fail(`The scene ${cname} has items that are not readable.`);
      const used = new Set<string>();
      const items: SpecItem[] = (co.items as unknown[]).map((it) => {
        if (!isObj(it)) fail(`The scene ${cname} has an item that is not readable.`);
        const io = it as Obj;
        const sourceId = reqStr(io, 'sourceId', `An item in ${cname}`, 120);
        if (!srcIds.has(sourceId)) fail(`The scene ${cname} uses a source (${sourceId}) that is not in the show.`);
        if (used.has(sourceId)) fail(`The scene ${cname} uses ${sourceId} twice.`);
        used.add(sourceId);
        if (io.visible !== undefined && typeof io.visible !== 'boolean') fail(`An item in ${cname} must be shown or hidden.`);
        return { sourceId, transform: normTransform(io.transform, `The item ${sourceId} in ${cname}`), visible: io.visible !== false };
      });
      scenes.push({ id: cid, name: cname, items });
    }
    if (typeof tp.programScene !== 'string' || !sceneIds.has(tp.programScene)) fail('The show must start on one of its scenes.');

    const audio: SpecAudio[] = [];
    const audioSeen = new Set<string>();
    if (tp.audio !== undefined && !Array.isArray(tp.audio)) fail('The sound settings of this show are not readable.');
    for (const a of ((tp.audio ?? []) as unknown[])) {
      if (!isObj(a)) { fail('A sound setting is not readable.'); continue; }
      const ao = a as Obj;
      const sourceId = reqStr(ao, 'sourceId', 'A sound setting', 120);
      if (!srcIds.has(sourceId)) fail(`A sound setting is for ${sourceId}, which is not in the show.`);
      if (audioSeen.has(sourceId)) fail(`${sourceId} has two sound settings.`);
      audioSeen.add(sourceId);
      if (typeof ao.muted !== 'boolean') fail(`The sound of ${sourceId} must be muted or not.`);
      const tracks = ao.tracks;
      if (!Array.isArray(tracks) || tracks.length === 0 || !tracks.every((t) => Number.isInteger(t) && t >= 1 && t <= 6) || new Set(tracks).size !== tracks.length) {
        fail(`The sound of ${sourceId} needs tracks between 1 and 6.`);
      }
      audio.push({
        sourceId, volumeDb: reqNum(ao, 'volumeDb', `The sound of ${sourceId}`, -100, 26), muted: ao.muted as boolean,
        tracks: [...(tracks as number[])].sort((p, q) => p - q), syncOffsetMs: reqNum(ao, 'syncOffsetMs', `The sound of ${sourceId}`, -950, 20000),
      });
    }

    const spec: ShowSpec = {
      v: 1, id, name, template: src.template as ShowTemplate, canvas,
      topology: { sources, scenes, audio, programScene: tp.programScene as string },
      room: normRoom(src.room),
    };
    return { ok: true, spec };
  } catch (e) {
    if (e instanceof SpecError) return { ok: false, say: e.message };
    return { ok: false, say: 'This show file is not readable.' };
  }
}

// ---------------------------------------------------------------- diff helpers

const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a)) {
    if (!isObj(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}
/** Every key of `want` is present in `have` with an equal value (the backend may hold extra defaults). */
function subsetEqual(want: Obj, have: Obj): boolean {
  return Object.keys(want).every((k) => k in have && deepEqual(want[k], have[k]));
}

/** The obs-websocket sceneItemTransform for a SpecTransform (top-left aligned, stretched into the box). */
export function obsTransform(t: SpecTransform): Obj {
  const c = t.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  return {
    positionX: t.x, positionY: t.y, rotation: t.rotation, alignment: 5, boundsType: 'OBS_BOUNDS_STRETCH',
    boundsWidth: Math.max(1, t.w), boundsHeight: Math.max(1, t.h),
    cropLeft: c.l, cropTop: c.t, cropRight: c.r, cropBottom: c.b,
  };
}
function sameTransform(have: Obj, want: Obj): boolean {
  return Object.keys(want).every((k) => {
    const w = want[k], h = have[k];
    return typeof w === 'number' ? typeof h === 'number' && Math.abs(h - w) < 0.01 : h === w;
  });
}

const trackMap = (tracks: number[]): Record<string, boolean> => {
  const m: Record<string, boolean> = {};
  for (let i = 1; i <= 6; i++) m[String(i)] = tracks.includes(i);
  return m;
};

interface WantItem { source: string; transform: SpecTransform; visible: boolean }

// ---------------------------------------------------------------- the diff

export function diffShowSpec(spec: ShowSpec, shape: BackendShape, opts?: { prune?: boolean }): ShowSpecDiff {
  const prune = opts?.prune !== false;
  const ops: SpecOp[] = [];
  const push = (requestType: string, requestData: Obj, why: string) => { ops.push({ requestType, requestData, why }); };

  const { sources, scenes, audio, programScene } = spec.topology;
  const srcName = new Map(sources.map((s) => [s.id, s.name]));
  const haveInput = new Map<string, ShapeInputWithAudio>(shape.inputs.map((i) => [i.name, i as ShapeInputWithAudio]));
  const haveScene = new Map(shape.scenes.map((s) => [s.name, s]));

  // 1. The canvas.
  const v = shape.video;
  if (!v || v.width !== spec.canvas.width || v.height !== spec.canvas.height || v.fps !== spec.canvas.fps) {
    push('SetVideoSettings', {
      baseWidth: spec.canvas.width, baseHeight: spec.canvas.height, outputWidth: spec.canvas.width, outputHeight: spec.canvas.height,
      fpsNumerator: spec.canvas.fps, fpsDenominator: 1,
    }, 'Set the picture size and frame rate');
  }

  // 2. Our own inputs of the wrong kind are removed and made again.
  const recreate = new Set<string>();
  for (const s of sources) {
    const h = haveInput.get(s.name);
    if (h && h.kind !== OBS_INPUT_KIND[s.kind] && s.name.startsWith(SPEC_PREFIX)) {
      recreate.add(s.name);
      push('RemoveInput', { inputName: s.name }, `Replace ${s.name}: it is a different kind of source now`);
    }
  }
  const exists = (name: string) => haveInput.has(name) && !recreate.has(name);

  // 3. What every scene should contain, bottom to top. Sources that no scene uses ride along (hidden, or tiny and visible
  //    for sound-only sources) in the first scene, because an input can only be created inside a scene.
  const want = new Map<string, WantItem[]>();
  for (const sc of scenes) {
    want.set(sc.name, sc.items.flatMap((it) => {
      const n = srcName.get(it.sourceId);
      return n ? [{ source: n, transform: it.transform, visible: it.visible }] : [];
    }));
  }
  const usedIds = new Set(scenes.flatMap((sc) => sc.items.map((it) => it.sourceId)));
  const programName = scenes.find((sc) => sc.id === programScene)?.name ?? scenes[0]?.name ?? '';
  // The carrier home is the FIRST scene (not the on-air one), so switching the on-air scene never moves a source around.
  const carrierHome = scenes[0]?.name ?? '';
  for (const s of sources) {
    if (usedIds.has(s.id) || !want.has(carrierHome)) continue;
    want.get(carrierHome)!.push({
      source: s.name, visible: AUDIO_KINDS.has(s.kind), transform: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
    });
  }

  // 4. Scenes.
  for (const sc of scenes) {
    if (!haveScene.has(sc.name)) push('CreateScene', { sceneName: sc.name }, `Make the scene ${sc.name}`);
  }

  // The items each scene has as we go (names, bottom to top), minus inputs being replaced.
  const cur = new Map<string, string[]>();
  const shapeItem = new Map<string, { enabled: boolean; transform: Obj }>();
  for (const sc of scenes) {
    const hs = haveScene.get(sc.name);
    const items = (hs?.items ?? []).filter((it) => !recreate.has(it.source));
    cur.set(sc.name, items.map((it) => it.source));
    for (const it of items) shapeItem.set(`${sc.name}\u0000${it.source}`, { enabled: it.enabled, transform: it.transform });
  }
  const isNewItem = new Set<string>();
  const key = (scene: string, source: string) => `${scene}\u0000${source}`;

  // 5. Inputs that do not exist yet, created inside the first scene that uses them.
  const created = new Set<string>();
  for (const s of sources) {
    if (exists(s.name)) continue;
    const home = scenes.find((sc) => want.get(sc.name)!.some((w) => w.source === s.name));
    if (!home) continue;
    const w = want.get(home.name)!.find((x) => x.source === s.name)!;
    const settings: Obj = { ...s.settings };
    if (s.kind === 'avatar-page' && spec.room) settings[ROOM_SETTINGS_KEY] = spec.room as unknown as Obj;
    push('CreateInput', {
      sceneName: home.name, inputName: s.name, inputKind: OBS_INPUT_KIND[s.kind], inputSettings: settings, sceneItemEnabled: w.visible,
    }, `Add ${s.name}`);
    created.add(s.name);
    cur.get(home.name)!.push(s.name);
    isNewItem.add(key(home.name, s.name));
  }

  // 6. Items: add missing ones, remove our own that the spec no longer has, then fix visibility, placement and order.
  for (const sc of scenes) {
    const list = cur.get(sc.name)!;
    const wants = want.get(sc.name)!;
    for (const w of wants) {
      if (list.includes(w.source)) continue;
      push('CreateSceneItem', { sceneName: sc.name, sourceName: w.source, sceneItemEnabled: w.visible }, `Show ${w.source} in ${sc.name}`);
      list.push(w.source);
      isNewItem.add(key(sc.name, w.source));
    }
    if (prune) {
      for (const n of [...list]) {
        if (n.startsWith(SPEC_PREFIX) && !wants.some((w) => w.source === n)) {
          push('RemoveSceneItem', { sceneName: sc.name, sourceName: n }, `Take ${n} out of ${sc.name}: this show does not use it there`);
          list.splice(list.indexOf(n), 1);
        }
      }
    }
    for (const w of wants) {
      const k = key(sc.name, w.source);
      const have = shapeItem.get(k);
      const fresh = isNewItem.has(k) || !have;
      if (!fresh && have!.enabled !== w.visible) {
        push('SetSceneItemEnabled', { sceneName: sc.name, sourceName: w.source, sceneItemEnabled: w.visible }, `${w.visible ? 'Show' : 'Hide'} ${w.source} in ${sc.name}`);
      }
      const wt = obsTransform(w.transform);
      if (fresh || !sameTransform(have!.transform, wt)) {
        push('SetSceneItemTransform', { sceneName: sc.name, sourceName: w.source, sceneItemTransform: wt }, `Place ${w.source} in ${sc.name}`);
      }
    }
    // Order: spec items bottom to top, anything else of the person's on top of them.
    const order = wants.map((w) => w.source);
    for (let i = 0; i < order.length; i++) {
      if (list[i] === order[i]) continue;
      push('SetSceneItemIndex', { sceneName: sc.name, sourceName: order[i], sceneItemIndex: i }, `Put ${order[i]} in the right layer of ${sc.name}`);
      list.splice(list.indexOf(order[i]), 1);
      list.splice(i, 0, order[i]);
    }
  }

  // 7. Per source: settings, room data, filters, sound.
  const audioOf = new Map(audio.map((a) => [a.sourceId, a]));
  for (const s of sources) {
    if (!exists(s.name) && !created.has(s.name)) continue;
    const isNew = created.has(s.name);
    const have = isNew ? undefined : haveInput.get(s.name);
    if (have) {
      if (!subsetEqual(s.settings, have.settings)) {
        push('SetInputSettings', { inputName: s.name, inputSettings: s.settings, overlay: true }, `Update the settings of ${s.name}`);
      }
      if (s.kind === 'avatar-page' && spec.room && !deepEqual(have.settings[ROOM_SETTINGS_KEY], spec.room)) {
        push('SetInputSettings', { inputName: s.name, inputSettings: { [ROOM_SETTINGS_KEY]: spec.room }, overlay: true }, `Switch ${s.name} to the room ${spec.room.roomId}`);
      }
    }
    for (const f of s.filters) {
      const hf = have?.filters.find((x) => x.name === f.id);
      if (hf && hf.kind !== f.kind) {
        push('RemoveSourceFilter', { sourceName: s.name, filterName: f.id }, `Replace the filter ${f.id} on ${s.name}`);
      }
      if (!hf || hf.kind !== f.kind) {
        push('CreateSourceFilter', { sourceName: s.name, filterName: f.id, filterKind: f.kind, filterSettings: f.settings }, `Add the filter ${f.id} to ${s.name}`);
        if (!f.enabled) push('SetSourceFilterEnabled', { sourceName: s.name, filterName: f.id, filterEnabled: false }, `Turn the filter ${f.id} off`);
        continue;
      }
      if (!subsetEqual(f.settings, hf.settings)) {
        push('SetSourceFilterSettings', { sourceName: s.name, filterName: f.id, filterSettings: f.settings, overlay: true }, `Update the filter ${f.id} on ${s.name}`);
      }
      if (hf.enabled !== f.enabled) {
        push('SetSourceFilterEnabled', { sourceName: s.name, filterName: f.id, filterEnabled: f.enabled }, `Turn the filter ${f.id} ${f.enabled ? 'on' : 'off'}`);
      }
    }
    const a = audioOf.get(s.id);
    if (a) {
      const h = have?.audio;
      if (isNew || h) {
        if (!h || h.volumeDb !== a.volumeDb) push('SetInputVolume', { inputName: s.name, inputVolumeDb: a.volumeDb }, `Set the volume of ${s.name}`);
        if (!h || h.muted !== a.muted) push('SetInputMute', { inputName: s.name, inputMuted: a.muted }, `${a.muted ? 'Mute' : 'Unmute'} ${s.name}`);
        if (!h || !deepEqual([...h.tracks].sort((p, q) => p - q), a.tracks)) push('SetInputAudioTracks', { inputName: s.name, inputAudioTracks: trackMap(a.tracks) }, `Set the sound tracks of ${s.name}`);
        if (!h || num(h.syncOffsetMs) !== a.syncOffsetMs) push('SetInputAudioSyncOffset', { inputName: s.name, inputAudioSyncOffset: a.syncOffsetMs }, `Set the sound delay of ${s.name}`);
      }
    }
  }

  // 8. The scene that is on air.
  if (programName && shape.program !== programName) {
    push('SetCurrentProgramScene', { sceneName: programName }, `Go to the scene ${programName}`);
  }

  // 9. Clean up: only our own names, never the person's.
  const specNames = new Set<string>([...sources.map((s) => s.name), ...scenes.map((s) => s.name)]);
  const foreign: string[] = [];
  for (const sc of shape.scenes) {
    if (specNames.has(sc.name)) continue;
    if (sc.name.startsWith(SPEC_PREFIX)) { if (prune) push('RemoveScene', { sceneName: sc.name }, `Remove the scene ${sc.name}: this show does not have it`); }
    else foreign.push(sc.name);
  }
  for (const inp of shape.inputs) {
    if (specNames.has(inp.name)) continue;
    if (inp.name.startsWith(SPEC_PREFIX)) { if (prune) push('RemoveInput', { inputName: inp.name }, `Remove ${inp.name}: this show does not have it`); }
    else foreign.push(inp.name);
  }

  const roomOnly = ops.length > 0 && ops.every((o) => {
    if (o.requestType !== 'SetInputSettings') return false;
    const ks = Object.keys(o.requestData.inputSettings as Obj);
    return ks.length === 1 && ks[0] === ROOM_SETTINGS_KEY;
  });
  return { ops, roomOnly, foreign };
}

const _api: ShowSpecApi = { validateShowSpec, diffShowSpec };
void _api;
