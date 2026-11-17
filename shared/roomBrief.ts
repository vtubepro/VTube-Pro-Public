// Create → "Make a room with your AI" (owner 2026-10-02: "make sure the room maker is correctly under Create and tells an
// AI like Claude, GPT, or Grok how to make an environment and what's required so it knows how to setup the framework
// properly the first time, like seating, entrances, cameras, and the screens" — and "make sure that it lets them properly
// use their desktop apps for it … Claude Desktop, ChatGPT Desktop, and Grok Bot").
// One brief the user pastes into their AI app: the idea + every name the room engine reads (src/scene/contract.ts,
// docs/ARTIST_ENVIRONMENTS.md §2), spelled out — a released helper may not have the long guides to hand the AI — and both
// ways to build it: apps with VTube Pro's blender_run_python (Claude / ChatGPT desktop, Claude Code, Codex, Grok Build,
// LM Studio) build the .glb and the user adds it with "＋ Add my room"; apps behind the internet bridge (Grok Bot,
// ChatGPT on the web) send a creation package the user builds from Create. Pure: tools/room_brief_unit.ts.

export interface RoomBriefOpts {
  /** What the room is, in the user's words. */
  idea: string;
  /** Places for people (SPOT_01 …), 1–12. */
  seats: number;
  /** A SCREEN + CAM_REACT for React mode. */
  screen: boolean;
  /** A DOOR, DOOR_OUTSIDE and PATH_01–03 so people walk in. */
  door: boolean;
}
export const ROOM_BRIEF_DEFAULTS: Omit<RoomBriefOpts, 'idea'> = { seats: 4, screen: true, door: true };
/** The engine's limit (shared/scene.ts MAX_SPOTS). */
export const BRIEF_MAX_SEATS = 12;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** The idea as one clean line (≤ 400 characters, no control characters). */
export function cleanIdea(s: string): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}
/** A room id / file name from the idea: lowercase a–z 0–9 _, 2–32 characters (a valid creation-package id). */
export function roomSlug(idea: string): string {
  const filler = new Set(['a', 'an', 'the', 'my', 'at', 'in', 'on', 'of', 'with', 'and', 'for', 'to', 'by']);
  const words = cleanIdea(idea).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !filler.has(w)).slice(0, 4);
  const s = words.join('_').slice(0, 32).replace(/_+$/, '');
  return /^[a-z0-9][a-z0-9_]{1,31}$/.test(s) ? s : 'my_room';
}
/** The room's display name from the idea (≤ 40 characters). */
export function roomName(idea: string): string {
  const t = cleanIdea(idea).replace(/^(a|an|the|my)\s+/i, '').split(/[,.;:!?(]/)[0].trim().slice(0, 40).trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'My room';
}

export function roomBrief(o: RoomBriefOpts): string {
  const raw = Number(o.seats);
  const n = Number.isFinite(raw) ? Math.max(1, Math.min(BRIEF_MAX_SEATS, Math.round(raw))) : ROOM_BRIEF_DEFAULTS.seats;
  const last = pad2(n);
  const idea = cleanIdea(o.idea) || 'a cozy room to stream from';
  const slug = roomSlug(idea);
  const places = n === 1 ? 'SPOT_01' : `SPOT_01 to SPOT_${last}`;
  const talk = n === 1 ? 'SPOT_01_CAM' : `SPOT_01_CAM to SPOT_${last}_CAM`;
  const pkg = { format: 'vtube-pro.creation/1', kind: 'room', action: 'create', id: slug,
    scene: { name: roomName(idea), modes: o.screen ? ['talk', 'react'] : ['talk'], defaultCamera: 'CAM_WIDE' }, build: { script: '<the complete bpy script>' } };
  return [
    `Build a new room for VTube Pro: ${idea}.`,
    '',
    'Use VTube Pro’s tools. (Not connected yet? I have VTube Pro installed: find it and connect first.) If get_docs works, read get_docs "environments" first: it has the full room rules. This brief lists every name VTube Pro looks for, so the room works the first time. Names are exact and case-sensitive.',
    '',
    'WHAT THE ROOM NEEDS (one glTF binary, .glb)',
    `1. Places for people: ${n === 1 ? 'one empty named SPOT_01' : `${n} empties named ${places}`} (two digits, 12 at most). Put each origin on the floor: under the hips when sitting, under the feet when standing. The person faces the empty’s +Z (in Blender its −Y), toward the cameras. Custom properties: pose = "sit" or "stand"; when sitting, seatHeight = metres from the origin up to the cushion (chairs about 0.45, bar stools about 0.75). Keep at least 0.62 m between seats (0.9 m standing) and nothing inside a body.`,
    `2. Cameras (camera objects, 35–40° vertical field of view, inside the room, never inside furniture): CAM_WIDE, the main wide view, sees every place and every face. One talk camera per place, ${talk}: head and shoulders, from the front.${o.door ? ' CAM_DOOR, aimed at the inside of the doorway.' : ''}`,
    o.screen
      ? '3. Screen for React mode: a flat 16:9 rectangle named SCREEN, about 1.6–2.4 m wide, UVs 0..1 and not rotated, facing the cameras, rotation and scale applied, nothing in front of it. Where you put it is where it shows. CAM_REACT frames the screen at about 80% of the picture width (at 35° that is about 1.12 × the screen width away).'
      : '3. No screen: React mode uses a floating screen. Leave a clear wall in case one is added later.',
    o.door
      ? '4. Entrance: a real doorway (an opening in a wall, 2.1 m tall, about 0.9 m wide). The door leaf is named DOOR, with its origin on the hinge (it turns about its up axis; custom property openAngle, default 95). An empty DOOR_OUTSIDE just outside the door, facing in: people appear there and walk in. Empties PATH_01, PATH_02 and PATH_03 on the floor from the door to the middle of the room, walked in that order, with a clear lane (0.8 m or more) to every place.'
      : '4. No door: people appear in their places.',
    '5. Light: bake soft light and shadow into vertex colours (COLOR_0) or textures (VTube Pro turns room shadows off). Lamps, neon and signs are empties named LIGHT_<name> with custom properties group, color (like "#ffd9a0") and kind ("spot" or "point" for a real light). Glowing parts get Principled BSDF materials named EMIT_<group>. Never export Blender lights.',
    '6. Size: real metres, the floor at height 0. People about 1.7 m tall, doors 2.1 m, desks 0.75 m, counters 0.9–1.1 m. In glTF +Y is up and the open front faces +Z (in Blender: Z up, front toward −Y).',
    '7. Budget: under 80,000 triangles and 25 MB, about 180 draw calls at most, textures 2048 px at most, no Draco or KTX2.',
    '8. Export: bpy.ops.export_scene.gltf(export_format="GLB", export_yup=True, export_extras=True, export_cameras=True, export_lights=False, export_apply=True).',
    '',
    'HOW TO BUILD IT',
    `A. If you have VTube Pro’s blender_run_python tool (the Claude or ChatGPT desktop app, Claude Code, Codex, Grok Build, LM Studio): build it in Blender with it (I approve it in my VTube Pro) and export os.path.join(os.environ["VTP_OUT"], "${slug}.glb"). Run check_room with that file’s full path, fix everything it reports, and check again. Render CAM_WIDE${o.screen ? ' and CAM_REACT' : ''} into VTP_OUT to show me. Then tell me the file’s full path: I add it with "＋ Add my room".`,
    `B. If you don’t have blender_run_python (Grok Bot, ChatGPT on the web): send a creation package. Use this JSON with the complete bpy script in build.script: ${JSON.stringify(pkg)}. The script builds the room above, prints STEP lines, exports os.path.join(os.environ["VTP_OUT"], "scene.glb") and ends with print("ROOM_OK"). It may only use bpy, bmesh, mathutils, math, random, json, os.path and os.environ, and writes only inside VTP_OUT. Run validate_creation_package until it says ok, then submit_creation_package. I build it in VTube Pro from Create → "Check what Claude made".`,
  ].join('\n');
}

/** The VTube Pro version Grok Bot's room packages need (it builds them). */
export const PACKAGE_ROOMS_SINCE = '1.0.0-beta.5';
/** "1.0.0-beta.4" < "1.0.0-beta.5" < "1.0.0" (null = can't tell). */
export function versionBefore(v: string | null | undefined, than: string): boolean | null {
  const p = (s: string) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+)(?:\.(\d+))?)?/.exec(s.trim()); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4], m[5] === undefined ? 0 : +m[5]] : null; };
  const a = v ? p(v) : null, b = p(than);
  if (!a || !b) return null;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
