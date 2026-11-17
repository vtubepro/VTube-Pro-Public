// The knowledge every AI path in VTube Pro shares, in ONE place, so the house rules and the guides an AI is pointed at
// are identical everywhere:
//   * server/mcpTools.ts + mcpHost.ts   MCP (stdio / localhost HTTP / remote tunnel): INSTRUCTIONS, get_docs,
//                                       get_creator_guide, the vtube-pro:// resources
//   * server/aiAgent.ts                 the built-in "Create with AI" host for a model on this PC (its system prompt)
//   * server/routes/aiconnect.ts        the copy-paste instruction pack (GET /api/aiconnect/pack)
// Pure module (node:fs only, plus the pure ComfyUI catalogue for the recipe counts): safe to import from the hosts and tests. The guides themselves stay in docs/*.md; the
// derived resources below are cut out of them at read time (no second copy that can drift).
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOM_CHECKLIST } from '../shared/roomCheck.ts';
import { WORKFLOW_DEFS } from '../shared/comfyWorkflows/catalog.ts';
import { HUNYUAN_AI_RULE, HUNYUAN_AI_RULE_SHORT, HUNYUAN_PLACES } from '../shared/comfyWorkflows/models.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The ready-made ComfyUI recipes, counted from the catalogue so the sentences below never drift from it. */
const COMFY_RECIPES = WORKFLOW_DEFS.length;
const COMFY_PICTURE_RECIPES = WORKFLOW_DEFS.filter((d) => d.id !== 'character-3d').length;

// ---------------------------------------------------------------- the guides
export interface AiDoc { key: string; file: string; title: string; about: string }
/** Every guide an AI may read (get_docs topic / get_creator_guide doc / vtube-pro://docs/<file>). Order = reading order. */
export const AI_DOCS = [
  { key: 'agents', file: 'docs/AGENT_GUIDE.md', title: 'Agent guide: make avatars and rooms that work the first time', about: 'For any AI making or fixing a creation: pick the kind (3D VRM / GLB, Pro2D PSD, PNGTuber, a model moved over from Live2D / Inochi2D, 3D room, 2D room, 2.5D overlay), the intake brief, each kind\'s exact contract (bone, ARKit, VRM, Live2D and PSD layer names, budgets, export settings), the check_creation loop, failure modes (symptom → cause → fix) and starter prompts. Data twin: creation_spec.' },
  { key: 'pro2d', file: 'docs/PRO2D.md', title: 'Pro2D: 2D avatars', about: 'What 2D avatars VTube Pro takes (a layered PSD in the 2D avatar maker, .vtp2, PNGTubers, and models moved over from Live2D / Inochi2D), how to prepare a drawing for the maker, expressions, outfits, lighting, phones, Pro2D → 3D.' },
  { key: 'creator', file: 'docs/AI_CREATOR_GUIDE.md', title: 'AI creator guide', about: 'The master reference: characters, rig, morph names, visemes, mouth / eye rules, profile.json, materials, hair, physics, costumes, rooms, review protocol, one-shot recipes, lessons.' },
  { key: 'avatars', file: 'docs/ARTIST_AVATARS.md', title: 'Artist guide: 3D avatars', about: 'Production handbook for avatars: topology + scale, humanoid rig, ARKit 52 + visemes, anime mouth / eye rules, painted-eye replacement, linear colours + toon looks, hair, costumes, spring bones, the import check, autorig, testing from 8+ angles.' },
  { key: 'environments', file: 'docs/ARTIST_ENVIRONMENTS.md', title: 'Artist guide: 3D environments (rooms)', about: 'Production handbook for rooms: the full room contract (spots, cameras, screen, door / path, areas, LIGHT_ / EMIT_, size spots, chat anchors, engine anchors), scale + axes, baked light, day / night, screen skins, budgets per graphics tier, camera QA, a worked example.' },
  { key: 'connect', file: 'docs/AI_CONNECT.md', title: 'AI connectors + build a room end to end', about: 'Connecting AIs, scopes + the approval click, the creation package format and the "build or modify a room" checklist the validator enforces.' },
  { key: 'scenes', file: 'docs/SCENES.md', title: 'Room (scene) contract + engines', about: 'Every room node and scene.json key and every room engine (cameras, lights, chat, raid, warzone, space, environment, areas, club, interview ...).' },
  { key: 'blender', file: 'docs/BLENDER_PLAYBOOK.md', title: 'Blender playbook', about: 'Running Blender safely (the lock, low priority, headless vs live window), glTF axes + export settings, the light bake, costumes, testing in the app.' },
  { key: 'faces', file: 'docs/FACE_CREATION.md', title: 'Face creation', about: 'Face proportions, anime eye construction, cel face shadows, MToon values, skin painting, face topology, painted-eye replacement internals.' },
  { key: 'examples', file: 'docs/BLENDER_EXAMPLES.md', title: 'Tested Blender examples', about: 'Tested scripts: a prop, a small room, a costume, a read-only test mock, an install script.' },
  { key: 'moving', file: 'docs/MOVING_ROOMS.md', title: 'Moving rooms (motion layers)', about: 'Rooms that move: looping glTF clips + zero-scale FX, props on a path, a space battle outside the window, sky traffic, the walking-ship voyage (the world streams past, spots and cameras stay put), the music-reactive show sky, time of day / eras, riding spots, cryo / drop-pod entrances, a worked example and safe ?sceneTest pages.' },
  { key: 'phone', file: 'docs/PHONE_TRACKING.md', title: 'Phone face tracking', about: 'Which phone apps VTube Pro takes (VTube Studio iPhone, iFacialMocap, Live Link Face, VMC apps such as Waidayo / AndroidMoCap, the browser phone page), which ones take the tracking work off the PC and which do not (a phone as a webcam: DroidCam, Iriun, Camo, Phone Link), set-up and firewall steps.' },
  { key: 'performance', file: 'docs/PERFORMANCE.md', title: 'Performance + graphics presets', about: 'What each graphics preset does, the benchmark and the measured per-room costs.' },
  { key: 'localai', file: 'docs/LOCAL_AI.md', title: 'Local AI (models + ComfyUI)', about: 'The consent-first hardware scan, which local chat model / ComfyUI setup fits which graphics card, and the MCP tools local_ai_recommend + comfy_workflows (curated ComfyUI recipes for VTube Pro jobs).' },
  { key: 'comfyui', file: 'docs/COMFYUI.md', title: 'ComfyUI workflows (ready-made, shareable)', about: `The ${COMFY_RECIPES} ready-made VTube Pro ComfyUI workflows (a picture-to-3D character maker and ${COMFY_PICTURE_RECIPES} picture recipes) in 3 graphics-card sizes, their models + licences (the 3D one is not for ${HUNYUAN_PLACES}), and how to set one up for the user with install_comfy_workflow (the user presses Yes on VTube Pro’s page).` },
] as const satisfies readonly AiDoc[];
export type AiDocKey = (typeof AI_DOCS)[number]['key'];
export const AI_DOC_KEYS = AI_DOCS.map((d) => d.key) as [AiDocKey, ...AiDocKey[]];
export const aiDoc = (key: string) => AI_DOCS.find((d) => d.key === key);
/** Guides present in this install (a packaged release ships only some of them). */
export const availableDocs = (root = ROOT) => AI_DOCS.filter((d) => existsSync(path.join(root, d.file)));

export async function readAiDoc(key: AiDocKey | string, root = ROOT): Promise<string> {
  const d = aiDoc(key);
  if (!d) throw new Error(`Unknown guide "${key}". Guides: ${AI_DOC_KEYS.join(', ')}`);
  const f = path.join(root, d.file);
  try { return await fs.readFile(f, 'utf8'); } catch { throw new Error(`Guide "${key}" is not in this install (${d.file}). Available: ${availableDocs(root).map((x) => x.key).join(', ')}`); }
}

/**
 * The sections whose "## " or "### " heading contains `q` (case-insensitive). A section runs to the next heading of the
 * same or a higher level. "## " matches win over "### " ones. No match = the list of headings.
 */
export function docSection(md: string, q: string): string {
  const lines = md.split(/\r?\n/);
  const heads: { i: number; level: number; text: string }[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (l.startsWith('```')) fence = !fence;
    const m = !fence && /^(#{2,3}) (.*)$/.exec(l);
    if (m) heads.push({ i, level: m[1].length, text: m[2] });
  });
  const needle = q.trim().toLowerCase();
  const cut = (h: { i: number; level: number }) => {
    const next = heads.find((x) => x.i > h.i && x.level <= h.level);
    return lines.slice(h.i, next ? next.i : lines.length).join('\n').trimEnd();
  };
  for (const level of [2, 3]) {
    const hits = heads.filter((h) => h.level === level && h.text.toLowerCase().includes(needle));
    if (hits.length) return hits.map(cut).join('\n\n');
  }
  return `No section heading contains "${q}". Sections:\n${heads.map((h) => `${h.level === 3 ? '  - ' : '- '}${h.text}`).join('\n')}`;
}

// ---------------------------------------------------------------- the house rules (one copy for every AI path)
/** The rules every AI follows in VTube Pro. Keep in sync with AGENTS.md "Golden rules" (the human-facing copy). */
export const HOUSE_RULES_LIST: readonly string[] = [
  '**Assume the user is LIVE.** The person running VTube Pro may be streaming right now. Anything that saves a profile, switches an avatar or costume, changes the scene or sends a bus command shows up on their stream instantly. Do it only when the user asked for exactly that, now. Test only in `/?observer=1` studios or `output.html?sceneTest=<room>` / `output.html?avatar=<id>` test pages, and close them when done (an open render tab slows their face tracking).',
  '**Never make sound.** No TTS, test tones, oscillators, media playback or WebRTC audio in any test: the app plays through the streamer\'s headset and reaches their live audience. Audio code is measured with analysers in a muted headless browser (`--mute-audio`), or not tested at all.',
  '**Hands off the user\'s data.** Never edit `library/`, `cache/`, `config/` or `dist/`. Build new content in its own folder and let the user import it (`import_model` / Add my model): never copy a shipped avatar\'s profile.json whole, never set an avatar\'s `source` to `builtin` (only the avatars VTube Pro ships are builtin, and the user cannot delete those), never write into the program folder (`assets/builtin`). Never type keys or passwords; the user enters secrets.',
  '**Model custody.** Another performer\'s avatar (a party guest) lives only in memory. Never save, cache or export someone else\'s model.',
  `**Licences.** No Mixamo files redistributed, no non-commercial datasets or assets, VRoid CC0 sample models only, no game files, logos or textures (original homage designs only). ${HUNYUAN_AI_RULE} No downloads or installs unless the user says so (docs/RESOURCES.md section 7).`,
  '**Quality bar: one-shot.** This ships to non-experts and must look good the first time. Judge every creation in the app\'s renderer from 8+ angles (front, both 3/4, both profiles, back, bust, head close-up) plus an expression / viseme sheet; Blender previews lie about toon shading. Never install a result that looks worse than what it replaces. Every manual fix becomes a reusable pipeline step.',
  '**Faces.** Anime mouths are carved into the face; teeth are a flat drawn band, never 3D teeth geometry. Faces are drawn, never projected (no photo, AI render or low-res crop projected onto a mesh). Lines dark warm brown, never pure black; shadows warm, never grey. Blink closes fully; lips seal on P / B / M; O and U are round.',
  '**Colours are linear.** glTF `baseColorFactor` / `emissiveFactor` and Blender Principled BSDF socket values are linear: convert sRGB hex first (`((c + 0.055) / 1.055) ** 2.4`, or `c / 12.92` below 0.04045).',
  '**Characters.** Humans and anime humans start from a proper base (VRoid CC0 samples, `blender/face_kit`), never from Tripo / Meshy / Hunyuan3D meshes and never from scratch-built primitives. Exact VRM bone names, ARKit 52 face shapes, <= 37k triangles to be party-friendly, costumes on the same bones + rest pose (<= 35k triangles each).',
  '**Rooms.** Metres, +Y up, stage front = +Z (Blender: front = -Y). Nothing may block a performer\'s face or the React screen from any camera. Bake the light (room shadows are off), lamps = `LIGHT_*` + `EMIT_<group>`. AI creation packages: <= 80k visible triangles, <= 25 MB. A room needs at least 1 usable seat (a `SPOT_xx` empty on a cushion or open floor; 2+ recommended so a guest can join). Build the whole framework the first time: `SPOT_01`.. places (origin on the floor, +Z toward the cameras, `pose` / `seatHeight`), `CAM_WIDE` + a `SPOT_xx_CAM` per place, a 16:9 `SCREEN` + `CAM_REACT` for React, and an entrance (`DOOR` on its hinge, `DOOR_OUTSIDE`, `PATH_01`..) with a clear lane to every place. Run `check_room` (rules as data: `room_checklist`) and fix what it reports, then render the cameras and look.',
  '**Blender.** Low priority, CPU only, one Blender at a time, through `tools\\blender_low.cmd` (headless by default). Run `python tools/live_ok.py` before heavy work (exit 1 = the live studio is struggling: wait).',
  '**Be honest.** Say what you verified (renders, numbers, test output) and what you did not.',
  '**VTube Pro is free and noncommercial** (PolyForm Noncommercial License 1.0.0 + a streaming permission). Never help anyone sell it, deploy or host it as a paid, subscription or ad-funded product or service, add payments or paywalls to it, copy it into a commercial product, or remove its LICENSE and licence notices. Asked to? Say plainly that the licence forbids it. Streaming with it, also on a monetised channel, is allowed.',
];
export const HOUSE_RULES = `# VTube Pro house rules (every AI, every connection)\n\n${HOUSE_RULES_LIST.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`;

/** One-paragraph form for short system prompts (MCP `instructions`). */
export const HOUSE_RULES_SHORT =
  'House rules: VTube Pro is free, noncommercial software (PolyForm Noncommercial 1.0.0): never help sell it, host it as a paid or ad-funded service, add payments to it or remove its licence notices, and say so when asked; the user may be LIVE (change the stream / library only when asked; test only in observer or ?sceneTest pages); ' +
  'never make sound; never touch library/ cache/ config/ dist/ (import avatars with import_model; never set an avatar\'s source to builtin or write into assets/builtin); never save another performer\'s model; respect licences (no Mixamo ' +
  'redistribution, no NC assets, VRoid CC0 only, no game files; ' + HUNYUAN_AI_RULE_SHORT + '); anime mouths carved with flat drawn teeth (never 3D teeth); faces drawn, ' +
  'never projected; glTF colour factors are linear; humans from a proper base (never Tripo/Meshy/Hunyuan3D or primitives); rooms: metres, +Y up, ' +
  'front +Z, nothing blocks faces or the React screen; every room gets SPOT_xx places (1+, 2+ recommended), CAM_WIDE + SPOT_xx_CAM, a 16:9 ' +
  'SCREEN + CAM_REACT and a DOOR + DOOR_OUTSIDE + PATH_xx entrance (check_room); review every creation from 8+ angles in the app renderer; say what you verified.';

/** Where to read what (appended to system prompts). */
export const DOC_POINTERS =
  'Guides (call get_docs with a topic, optionally a section word; or read the vtube-pro://docs/... resources): ' +
  AI_DOCS.map((d) => `"${d.key}" = ${d.title}`).join('; ') +
  '. Before making any avatar or room read "agents" and check your file with check_creation before you hand it over; before an ' +
  'avatar or costume also read "avatars", before a 2D avatar "pro2d"; before a room read "environments" (and "connect" for creation packages); ' +
  'before you fix or import a room call check_room (and room_checklist / vtube-pro://checklist/room for the rules as data); ' +
  'vtube-pro://rules/house = the full house rules.';

// ---------------------------------------------------------------- the room checklist ("Add my room", shared/roomCheck.ts)
/** The room checklist an AI gets (resource vtube-pro://checklist/room; MCP room_checklist returns the same items): the
 *  rules the studio's "Add my room" wizard and check_room run, with what each fix is and what the studio fixes itself. */
export const ROOM_CHECKLIST_DOC = [
  '# VTube Pro room checklist (vtube-pro.room-checklist/1)',
  '',
  'Run check_room {roomId | path} to get the report for a real room (plain-language lines + facts + a suggested fix as data:',
  'SPOT_xx empties + SPOT_xx_CAM / CAM_WIDE cameras in glTF space). REQUIRED items block a room; the rest are quality.',
  'The user can also fix a room without any AI: Change room → "Add my room" → "Place seats for me" / "Let me place them".',
  '',
  ...ROOM_CHECKLIST.map((c) => `- **${c.id}**${c.required ? ' (REQUIRED)' : ''}: ${c.rule}\n  - checked by: ${c.how}\n  - fix: ${c.fix}\n  - automatic: ${c.auto}\n  - guide: ${c.doc}`),
  '',
  '```json',
  JSON.stringify({ format: 'vtube-pro.room-checklist/1', items: ROOM_CHECKLIST }, null, 1),
  '```',
].join('\n');

// ---------------------------------------------------------------- derived resources (cut from the guides at read time)
/** `doc`: the guide it is cut from (a copy may lack some guides: readAiDoc then says so). */
export interface DerivedResource { name: string; uri: string; title: string; description: string; read: (root?: string) => Promise<string>; doc?: AiDocKey }
const fromDoc = (key: AiDocKey, ...sections: string[]) => async (root?: string) => {
  const md = await readAiDoc(key, root);
  return sections.map((s) => docSection(md, s)).join('\n\n');
};
export const DERIVED_RESOURCES: DerivedResource[] = [
  { name: 'rules_house', uri: 'vtube-pro://rules/house', title: 'House rules', description: 'The rules every AI follows in VTube Pro: live safety, no sound, hands off user data, model custody, licences, the quality bar, faces, linear colours, characters, rooms, Blender, honesty.', read: async () => HOUSE_RULES },
  { name: 'spec_agents', uri: 'vtube-pro://spec/agents', title: 'Agent spec (machine readable)', description: 'What VTube Pro accepts for every avatar and room kind, as JSON (vtube-pro.agent-spec/1): bone / ARKit / VRM / Live2D / PSD layer names, budgets, export settings, room nodes. Check a real file with check_creation.', read: async (root = ROOT) => fs.readFile(path.join(root, 'docs', 'agent-spec.json'), 'utf8'), doc: 'agents' },
  { name: 'checklist_room', uri: 'vtube-pro://checklist/room', title: 'Room checklist (machine readable)', description: 'What a room needs (at least 1 seat, 2+ recommended; cameras, scale, axes, floor, lights, budget, screen, door) as a list + JSON, with the fix for each and what the studio fixes automatically. Check a real room with check_room.', read: async () => ROOM_CHECKLIST_DOC },
  { name: 'contract_room', uri: 'vtube-pro://contract/room', title: 'Room contract', description: 'Every node and extra a room scene.glb needs (spots, cameras, screen, door / path, floors, lights, chat anchors, size spots, areas) + scene.json.', read: fromDoc('environments', 'The room contract'), doc: 'environments' },
  { name: 'contract_avatar', uri: 'vtube-pro://contract/avatar', title: 'Avatar checklist', description: 'The short avatar checklist, the rig (VRM bone names) and the face shapes (ARKit 52, visemes) an avatar must have.', read: fromDoc('avatars', 'The short version', 'The humanoid rig', 'Face shapes'), doc: 'avatars' },
  { name: 'recipes_one_shot', uri: 'vtube-pro://recipes/one-shot', title: 'One-shot recipes', description: 'Step-by-step recipes: an anime VTuber from a reference, a creature / mascot, a themed room.', read: fromDoc('creator', 'One-shot recipes'), doc: 'creator' },
  { name: 'recipes_room_template', uri: 'vtube-pro://recipes/room-template', title: 'Minimal room build script', description: 'A complete, minimal Blender room build script (shell, door, path, spots, screen, lights, cameras, export).', read: fromDoc('creator', 'Minimal working room'), doc: 'creator' },
  { name: 'knowledge_local_ai', uri: 'vtube-pro://knowledge/local-ai', title: 'Local AI + ComfyUI workflows', description: 'Which local chat model and ComfyUI models fit which graphics card (dated, licensed), and the curated ComfyUI recipes for avatar textures, rooms, skies, decals, thumbnails, overlays and emotes.', read: async () => (await import('./localAiTools.ts')).localAiKnowledge() },
  { name: 'knowledge_comfy_workflows', uri: 'vtube-pro://knowledge/comfy-workflows', title: 'Ready-made ComfyUI workflows', description: `The ${COMFY_RECIPES} shareable VTube Pro ComfyUI workflows (a picture-to-3D character maker and ${COMFY_PICTURE_RECIPES} picture recipes, 3 graphics-card sizes each). The 3D one uses the Hunyuan3D model, which is not licensed for ${HUNYUAN_PLACES}: ${HUNYUAN_AI_RULE_SHORT}. How to set one up for the user with install_comfy_workflow: the user presses Yes on VTube Pro’s page.`, read: async () => { const g = await import('../shared/comfyWorkflows/guide.ts'); return g.COMFY_AI_GUIDE; } },
  { name: 'recipes_review', uri: 'vtube-pro://recipes/review', title: 'Review protocol', description: 'The mandatory review: automated detectors, the 8+ angle app-renderer check, comparing against the reference.', read: fromDoc('creator', 'Review protocol'), doc: 'creator' },
];
/** The derived resources this install can serve (a copy without docs/AI_CREATOR_GUIDE.md serves no recipes). */
export const availableResources = (root = ROOT) => {
  const have = new Set<string>(availableDocs(root).map((d) => d.key));
  return DERIVED_RESOURCES.filter((r) => !r.doc || have.has(r.doc));
};
