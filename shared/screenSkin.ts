// Room-themed skins for the generated screen rigs (the solo react screen, the in-world chat monitor and the support
// board): what the housing / frame looks like, how it arrives, and how its picture powers on. Rooms declare one in
// scene.json `screenSkin` (a built-in theme, or their own GLB nodes); rooms without one get their built-in default
// (ROOM_THEMES) or the standard studio rig. The screen area itself is always the same flat rectangle (so in-scene
// capture and the OBS passthrough quad work with every skin); a frame may be any shape around it.
//
// Pure data (no three.js): shared by the scene engine (src/scene/screenSkins.ts) and the Scene tab.
import { baseRoomId } from './roomId.ts';

/** Built-in themes. */
export type ScreenSkinTheme = 'studio' | 'scrying' | 'hologram' | 'terragroup' | 'tarp' | 'bedsheet';
/** How the unit arrives (and leaves, reversed). */
export type ScreenSkinMotion = 'drop' | 'rise' | 'unroll' | 'swing' | 'hologram' | 'shimmer';
/** How the picture powers on. */
export type ScreenSkinPower = 'crt' | 'hologram' | 'shimmer' | 'fade';
export type ScreenSkinProp = 'solo' | 'monitor' | 'board';

/** One prop's skin: a built-in theme and/or a GLB node of the room (a template: hidden in the room, cloned per rig). */
export interface ScreenSkinRef {
  theme?: ScreenSkinTheme;
  /** Name of a node in the room's GLB (default: SOLO_SKIN / CHAT_MONITOR_SKIN / CHAT_BOARD_SKIN when present). */
  node?: string;
  motion?: ScreenSkinMotion;
  powerOn?: ScreenSkinPower;
}

/** scene.json `screenSkin`: a theme name for every prop, or per prop (top-level fields = the solo screen's and the
 *  other props' defaults). */
export type ScreenSkinConfig = ScreenSkinTheme | (ScreenSkinRef & {
  solo?: ScreenSkinTheme | ScreenSkinRef;
  monitor?: ScreenSkinTheme | ScreenSkinRef;
  board?: ScreenSkinTheme | ScreenSkinRef;
});

export interface ThemeInfo {
  label: string;
  /** Solo screen default motion / power-on. */
  solo: { motion: ScreenSkinMotion; powerOn: ScreenSkinPower; what: string };
  /** Chat monitor + support board. */
  chat: { motion: ScreenSkinMotion; powerOn: ScreenSkinPower; what: string };
}

export const THEMES: Record<ScreenSkinTheme, ThemeInfo> = {
  studio: { label: 'Studio', solo: { motion: 'unroll', powerOn: 'crt', what: 'motorised projector screen with an ON AIR lamp' }, chat: { motion: 'drop', powerOn: 'crt', what: 'drop-down monitor on cables (neon SUPPORT board)' } },
  scrying: { label: 'Scrying mirror', solo: { motion: 'rise', powerOn: 'shimmer', what: 'rune-framed arched mirror that rises with a magic shimmer' }, chat: { motion: 'drop', powerOn: 'shimmer', what: 'carved signboard on ropes, enchanted glass' } },
  hologram: { label: 'Hologram', solo: { motion: 'hologram', powerOn: 'hologram', what: 'floor emitter projects a hologram that flickers in' }, chat: { motion: 'hologram', powerOn: 'hologram', what: 'ceiling emitter hologram panel' } },
  terragroup: { label: 'TerraGroup display', solo: { motion: 'drop', powerOn: 'fade', what: 'sleek white ceiling-mast display with a blue status strip' }, chat: { motion: 'drop', powerOn: 'fade', what: 'white ceiling-mast display' } },
  tarp: { label: 'Chain-hoist tarp', solo: { motion: 'swing', powerOn: 'fade', what: 'tarp on a rusty I-beam dropped on chain hoists' }, chat: { motion: 'swing', powerOn: 'crt', what: 'rusty steel monitor on chains' } },
  bedsheet: { label: 'Bedsheet on a line', solo: { motion: 'unroll', powerOn: 'fade', what: 'a bedsheet pegged on a clothesline, unfurls' }, chat: { motion: 'drop', powerOn: 'fade', what: 'duct-taped plywood board on ropes' } },
};

/** Built-in defaults for the shipped rooms (a room's own scene.json screenSkin wins). */
export const ROOM_THEMES: Record<string, ScreenSkinTheme> = {
  poe2_kingsmarch: 'scrying',
  helldivers_bridge: 'hologram',
  space_test: 'hologram',
  eft_labs: 'terragroup',
  eft_labs_rnd: 'terragroup',
  eft_factory: 'tarp',
  eft_customs_dorms: 'bedsheet',
};

export const DEFAULT_SKIN_NODES: Record<ScreenSkinProp, string> = { solo: 'SOLO_SKIN', monitor: 'CHAT_MONITOR_SKIN', board: 'CHAT_BOARD_SKIN' };
const MOTIONS: ScreenSkinMotion[] = ['drop', 'rise', 'unroll', 'swing', 'hologram', 'shimmer'];
const POWERS: ScreenSkinPower[] = ['crt', 'hologram', 'shimmer', 'fade'];

export interface ResolvedSkinSpec {
  theme: ScreenSkinTheme;
  motion: ScreenSkinMotion;
  powerOn: ScreenSkinPower;
  /** GLB node used as the housing (null = the theme's generated one). */
  node: string | null;
  /** Where the choice came from. */
  source: 'scene.json' | 'glb node' | 'room default' | 'default';
  /** Problems (unknown theme / motion names …). */
  warnings: string[];
}

const isTheme = (v: unknown): v is ScreenSkinTheme => typeof v === 'string' && v in THEMES;

/** Resolve one prop's skin. `hasNode(name)` = the room's GLB has that node. */
export function resolveSkinSpec(roomId: string, cfg: unknown, prop: ScreenSkinProp, hasNode: (name: string) => boolean): ResolvedSkinSpec {
  const warnings: string[] = [];
  let theme: ScreenSkinTheme = ROOM_THEMES[roomId] ?? ROOM_THEMES[baseRoomId(roomId)] ?? 'studio';   // (an area: its room's)
  let source: ResolvedSkinSpec['source'] = roomId in ROOM_THEMES ? 'room default' : 'default';
  let ref: ScreenSkinRef = {};
  const asRef = (v: unknown): ScreenSkinRef | null => {
    if (typeof v === 'string') { if (isTheme(v)) return { theme: v }; warnings.push(`unknown theme "${v}"`); return null; }
    if (v && typeof v === 'object') return v as ScreenSkinRef;
    return null;
  };
  if (cfg !== undefined && cfg !== null) {
    const top = asRef(cfg);
    const per = cfg && typeof cfg === 'object' ? asRef((cfg as Record<string, unknown>)[prop]) : null;
    // top-level node / motion / powerOn are the solo screen's; a top-level theme applies to every prop
    const base: ScreenSkinRef = top ? (prop === 'solo' ? { ...top } : { theme: top.theme }) : {};
    ref = { ...base, ...(per ?? {}) };
    if (ref.theme !== undefined && !isTheme(ref.theme)) { warnings.push(`unknown theme "${String(ref.theme)}"`); delete ref.theme; }
    if (ref.theme || ref.node || ref.motion || ref.powerOn) source = 'scene.json';
    if (ref.theme) theme = ref.theme;
  }
  let node: string | null = null;
  if (typeof ref.node === 'string' && ref.node.trim()) {
    node = ref.node.trim();
    if (!hasNode(node)) { warnings.push(`node "${node}" not found in the room`); node = null; }
  } else if (hasNode(DEFAULT_SKIN_NODES[prop])) { node = DEFAULT_SKIN_NODES[prop]; if (source !== 'scene.json') source = 'glb node'; }
  const t = THEMES[theme][prop === 'solo' ? 'solo' : 'chat'];
  let motion = t.motion, powerOn = t.powerOn;
  if (ref.motion !== undefined) { if (MOTIONS.includes(ref.motion)) motion = ref.motion; else warnings.push(`unknown motion "${String(ref.motion)}"`); }
  if (ref.powerOn !== undefined) { if (POWERS.includes(ref.powerOn)) powerOn = ref.powerOn; else warnings.push(`unknown powerOn "${String(ref.powerOn)}"`); }
  // a hologram / shimmer arrival reads best with the matching power-on (unless the room chose one)
  if (ref.powerOn === undefined && ref.motion !== undefined && (motion === 'hologram' || motion === 'shimmer')) powerOn = motion;
  return { theme, motion, powerOn, node, source, warnings };
}

export function describeSkin(s: ResolvedSkinSpec, prop: ScreenSkinProp): string {
  const t = THEMES[s.theme];
  const what = s.node ? `the room's own ${s.node} node` : t[prop === 'solo' ? 'solo' : 'chat'].what;
  return `${t.label} — ${what} (arrives: ${s.motion}, power-on: ${s.powerOn})`;
}
