// Curated light-show presets ("looks") for the lighting states — pure data. Applying one to a state fills that
// state's LightingLook (house level / tint, effects mix, palette, motion styles, per-group programs, energy).
// Selectable in any state from the Scene tab's preset browser (categories, search, favourites, surprise me,
// auto-cycle every N phrases). Groups are matched by name (sign / neon / accent / onair / spots / fireflies / board /
// lamps / string / lava / aqua / other), so every preset works in any room.
import type { LightGroupSetting, LightProgram } from './types.ts';

export type PresetCat = 'chill' | 'mid' | 'banger' | 'theme';
export type BeamMotion = 'sweep' | 'fan' | 'figure8' | 'ballyhoo' | 'circle' | 'wander' | 'cross' | 'still';
export type LaserMode = 'fan' | 'cross' | 'tunnel' | 'sheet' | 'scan' | 'off';
export type Split = 'oddeven' | 'lr' | 'mono';

export interface ShowPreset {
  id: string;
  name: string;
  cat: PresetCat;
  /** One line for the browser. */
  vibe: string;
  /** House slider value (0 = the moody low-light floor, 1 = normal) and tint. */
  house: number;
  tint: string | null;
  /** Effects amount + mix (beams, lasers, mirror ball) 0..1. */
  fx: number;
  mix: [number, number, number];
  /** Colour pairs [A, B]; the show steps to the next pair every phrase (8 bars) and on drops. */
  palette: [string, string][];
  /** Beam motion styles, cycled every 8 bars; laser looks, cycled every 16 bars. */
  motion: BeamMotion[];
  lasers: LaserMode[];
  split: Split;
  /** Mirror-ball spin (1 = normal) and overall effects speed. */
  ball: number;
  energy: number;
  /** Group programs: 'program:intensity:speed' per group kind ('*' = everything else). */
  groups: Record<string, string>;
}

const P = (id: string, name: string, cat: PresetCat, vibe: string, house: number, tint: string | null, fx: number, mix: [number, number, number],
  palette: [string, string][], motion: BeamMotion[], lasers: LaserMode[], split: Split, ball: number, energy: number, groups: Record<string, string>): ShowPreset =>
  ({ id, name, cat, vibe, house, tint, fx, mix, palette, motion, lasers, split, ball, energy, groups });

// group program shorthands
const CHILL = { sign: 'breathe:1:0.5', neon: 'breathe:1:0.5', accent: 'breathe:0.8:0.5', onair: 'steady:0.4', spots: 'breathe:0.5:0.25', fireflies: 'drift:1.2:0.7', board: 'breathe:0.6:0.5', lamps: 'steady:0.7', string: 'breathe:0.9:0.25', lava: 'breathe:1:0.25', aqua: 'breathe:0.9:0.3', '*': 'breathe:0.8:0.5' };
const MID = { sign: 'pulse:1.3', neon: 'cycle:1.2', accent: 'cycle:1.1', onair: 'steady:0.35', spots: 'chase:1.1', fireflies: 'drift:1.4:1.5', board: 'pulse:1', lamps: 'steady:0.5', string: 'chase:1:1', lava: 'breathe:1.1:0.5', aqua: 'pulse:1', '*': 'pulse:1.1' };
const BANG = { sign: 'pulse:1.7', neon: 'cycle:1.6:2', accent: 'cycle:1.5:2', onair: 'off', spots: 'chase:1.5:2', fireflies: 'drift:2:3', board: 'strobe:1.3:2', lamps: 'steady:0.35', string: 'chase:1.3:2', lava: 'pulse:1.3', aqua: 'pulse:1.4', '*': 'pulse:1.4' };
const W = (base: Record<string, string>, over: Record<string, string>) => ({ ...base, ...over });

export const SHOW_PRESETS: ShowPreset[] = [
  // ---------------------------------------------------------------- chill
  P('chill_lounge', 'Chill Lounge', 'chill', 'Warm low lamps, slow breathing neon, a lazy mirror ball', 0.25, '#ffb070', 0.35, [0, 0, 1], [['#ffb347', '#ff7a8a'], ['#ffd27a', '#ff9a5a']], ['still'], ['off'], 'mono', 0.35, 0.4, CHILL),
  P('lofi_rain', 'Lo-fi Rain', 'chill', 'Blue-grey night, soft drifting spots, study-beats energy', 0.18, '#6a8cff', 0.3, [0.4, 0, 0.8], [['#6a8cff', '#9fb8ff'], ['#7a9aff', '#c0d0ff']], ['wander'], ['off'], 'mono', 0.3, 0.3, W(CHILL, { lamps: 'steady:0.55', neon: 'flicker:0.8:0.6' })),
  P('moonlit_night', 'Moonlit Night', 'chill', 'Moonlight blue, fireflies glowing, the night breathing', 0.15, '#4a6cff', 0.25, [0.3, 0, 0.6], [['#4a8cff', '#b0e0ff'], ['#3a6aff', '#d8ff5a']], ['still', 'wander'], ['off'], 'mono', 0.25, 0.3, W(CHILL, { fireflies: 'drift:1.8:0.8' })),
  P('candlelight', 'Candlelight', 'chill', 'Amber flicker, cosy and quiet', 0.2, '#ff9a4a', 0, [0, 0, 0], [['#ff9a4a', '#ffcf7a']], ['still'], ['off'], 'mono', 0, 0.3, W(CHILL, { neon: 'flicker:0.7:0.4', sign: 'flicker:0.9:0.3', lamps: 'flicker:0.8:0.3' })),
  P('sunday_morning', 'Sunday Morning', 'chill', 'Bright and gentle, nothing moving fast', 0.8, '#fff0d8', 0, [0, 0, 0], [['#fff1d6', '#ffe0b0']], ['still'], ['off'], 'mono', 0, 0.3, W(CHILL, { spots: 'steady:0.9', lamps: 'steady:1' })),
  P('deep_sea', 'Deep Sea', 'chill', 'Teal and indigo waves, slow sweeping beams', 0.15, '#2a8cc8', 0.5, [0.7, 0, 0.5], [['#00c8d0', '#2a3cff'], ['#00e0a0', '#3a5aff']], ['sweep', 'circle'], ['sheet'], 'lr', 0.4, 0.35, W(CHILL, { aqua: 'breathe:1.5:0.5' })),
  P('lava_lamp', 'Lava Lamp', 'chill', 'Orange and magenta blobs, gooey slow colour', 0.2, '#ff6a3a', 0.35, [0.5, 0, 0.3], [['#ff5a1f', '#ff3fd2'], ['#ff8a2b', '#c83dff']], ['wander'], ['off'], 'lr', 0.3, 0.3, W(CHILL, { lava: 'breathe:1.6:0.3', neon: 'cycle:1:0.25', accent: 'cycle:0.9:0.25' })),
  P('vinyl_night', 'Vinyl Night', 'chill', 'Jazz-club gold and red, the ball turning slowly', 0.22, '#ff8a5a', 0.4, [0.3, 0, 1], [['#ffcf7a', '#ff4a4a'], ['#ffb347', '#ff6a6a']], ['still', 'sweep'], ['off'], 'mono', 0.5, 0.4, CHILL),
  P('stargazer', 'Stargazer', 'chill', 'Dark sky, glittering ball spots everywhere', 0.12, '#3a4aa0', 0.55, [0, 0, 1], [['#e8f6ff', '#9fb8ff']], ['still'], ['off'], 'mono', 0.2, 0.3, W(CHILL, { fireflies: 'drift:1.6:0.6', spots: 'off' })),
  P('matcha', 'Matcha', 'chill', 'Soft greens and cream, very easy on the eyes', 0.35, '#b8ff9a', 0.2, [0.3, 0, 0.4], [['#8dff3a', '#fff1d6'], ['#5dffa0', '#e8ffc0']], ['still', 'wander'], ['off'], 'mono', 0.3, 0.3, CHILL),
  P('late_stream', 'Late Night Stream', 'chill', 'Monitor-glow purple, one slow beam pair', 0.14, '#7a5aff', 0.35, [0.5, 0, 0.3], [['#7a5aff', '#ff4fd8']], ['sweep'], ['off'], 'lr', 0.3, 0.3, W(CHILL, { board: 'breathe:1:0.5' })),
  P('rainforest', 'Rainforest', 'chill', 'Jungle green haze with drifting yellow sparks', 0.2, '#3aff8a', 0.35, [0.5, 0, 0.5], [['#3aff8a', '#d8ff5a'], ['#00c870', '#ffd000']], ['wander'], ['off'], 'oddeven', 0.3, 0.4, W(CHILL, { fireflies: 'drift:1.8:1' })),
  // ---------------------------------------------------------------- mid
  P('house_party', 'House Party', 'mid', 'Lime and pink, fans of beams, lasers on the build', 0.12, '#3a5cff', 0.85, [1, 0.7, 0.8], [['#8dff3a', '#ff3fd2'], ['#00e5ff', '#8dff3a'], ['#ff3fd2', '#ffd000'], ['#7c3cff', '#00ff9c']], ['fan', 'figure8', 'sweep', 'cross'], ['fan', 'cross', 'tunnel'], 'oddeven', 1, 0.9, W(MID, { sign: 'pulse:1.6', fireflies: 'drift:2:2.5' })),
  P('disco_fever', 'Disco Fever', 'mid', 'Mirror ball front and centre, 70s colour pairs, groovy sweeps', 0.2, '#ff8ad0', 0.8, [0.7, 0.2, 1], [['#ff2bd6', '#ffd000'], ['#00e5ff', '#ff5a00'], ['#8dff3a', '#ff2bd6']], ['figure8', 'circle', 'sweep'], ['off', 'fan'], 'oddeven', 1.2, 0.8, W(MID, { neon: 'cycle:1.4:1' })),
  P('sunset_sway', 'Sunset Sway', 'mid', 'Orange to violet, warm and swaying', 0.22, '#ff8a4a', 0.65, [0.8, 0.3, 0.5], [['#ff7a2b', '#c83dff'], ['#ff3d6e', '#ffb347'], ['#ff5050', '#7a2bff']], ['sweep', 'figure8'], ['sheet'], 'lr', 0.6, 0.6, MID),
  P('acid_uv', 'Acid UV', 'mid', 'Acid green and UV, crossing lasers over the floor', 0.1, '#7a2bff', 0.85, [0.8, 1, 0.4], [['#b0ff00', '#7a2bff'], ['#00ff9c', '#ff00d4']], ['cross', 'fan', 'ballyhoo'], ['cross', 'scan'], 'oddeven', 0.8, 0.9, W(MID, { sign: 'strobe:1.4:1', accent: 'cycle:1.5:2' })),
  P('neon_noir', 'Neon Noir', 'mid', 'Rain-soaked cyan and red, moody film light', 0.1, '#2a4a8a', 0.6, [0.8, 0.4, 0], [['#00e5ff', '#ff2b2b'], ['#00a2ff', '#ff006a']], ['still', 'sweep'], ['sheet', 'off'], 'lr', 0, 0.5, W(MID, { neon: 'flicker:1.3:0.8', sign: 'flicker:1.2:0.6', lamps: 'steady:0.35' })),
  P('retro_80s', 'Retro 80s', 'mid', 'Synthwave pink and cyan, grid-style laser sheets', 0.15, '#ff4fd8', 0.8, [0.7, 0.9, 0.3], [['#ff2bd6', '#00e5ff'], ['#ff7a2b', '#b026ff']], ['sweep', 'fan'], ['sheet', 'tunnel'], 'lr', 0.6, 0.7, MID),
  P('ice_palace', 'Ice Palace', 'mid', 'Cold white-blue beams, frosty ball', 0.18, '#9fd8ff', 0.75, [0.9, 0.4, 0.9], [['#00d0ff', '#e8f6ff'], ['#4b9bff', '#b0fff4']], ['fan', 'still', 'circle'], ['fan'], 'oddeven', 0.8, 0.6, MID),
  P('tropical', 'Tropical', 'mid', 'Mango, lime and flamingo, bouncy', 0.25, '#ffb347', 0.7, [0.8, 0.3, 0.6], [['#ffd000', '#ff4f8a'], ['#8dff3a', '#ff7a2b'], ['#00ffd5', '#ffd000']], ['figure8', 'wander', 'fan'], ['fan'], 'oddeven', 0.9, 0.8, MID),
  P('jazz_bar', 'Jazz Bar', 'mid', 'Golden spot pair and a slow ball; swing, not rave', 0.25, '#ffb070', 0.5, [0.5, 0, 0.8], [['#ffcf7a', '#ff9a5a']], ['still', 'sweep'], ['off'], 'mono', 0.5, 0.5, W(MID, { neon: 'breathe:1:0.5', board: 'breathe:0.8' })),
  P('ocean_drive', 'Ocean Drive', 'mid', 'Miami teal and coral, wide sweeps', 0.2, '#40c8ff', 0.75, [0.9, 0.5, 0.4], [['#00ffd5', '#ff6a8a'], ['#00a2ff', '#ffb347']], ['sweep', 'fan', 'figure8'], ['sheet', 'fan'], 'lr', 0.7, 0.7, MID),
  P('galaxy', 'Galaxy', 'mid', 'Deep violet with a sparkling ball and circling beams', 0.1, '#5a3aff', 0.8, [0.7, 0.3, 1], [['#7a2bff', '#00d0ff'], ['#b04bff', '#ff4fd8'], ['#2b6bff', '#e8f6ff']], ['circle', 'figure8'], ['tunnel'], 'oddeven', 0.7, 0.6, MID),
  P('karaoke', 'Karaoke Night', 'mid', 'Big friendly colours, spots on the singers', 0.35, '#ff8ad0', 0.6, [0.9, 0, 0.8], [['#ff2bd6', '#00e5ff'], ['#ffd000', '#7c3cff']], ['still', 'sweep'], ['off'], 'oddeven', 0.8, 0.7, W(MID, { spots: 'steady:1.2' })),
  P('fairground', 'Fairground', 'mid', 'Carnival bulbs chasing, primary colours', 0.3, '#ffd07a', 0.6, [0.6, 0.2, 0.6], [['#ff2b2b', '#ffd000'], ['#2b6bff', '#ff2b2b'], ['#00ff9c', '#ffd000']], ['circle', 'ballyhoo'], ['off'], 'oddeven', 1, 0.8, W(MID, { string: 'chase:1.5:2', spots: 'chase:1.3:2', lamps: 'chase:0.9:1' })),
  P('sunrise_set', 'Golden Hour', 'mid', 'Peach and gold rising with the energy', 0.3, '#ffb070', 0.55, [0.8, 0.2, 0.3], [['#ffb347', '#ff7a8a'], ['#ffd27a', '#ff5a5a']], ['sweep', 'fan'], ['sheet'], 'lr', 0.5, 0.6, MID),
  // ---------------------------------------------------------------- banger
  P('hype_train', 'Hype Train', 'banger', 'Everything on: fan-outs, ballyhoo, lasers, hard sign pulses', 0.1, '#4a5cff', 1, [1, 1, 1], [['#ff2bd6', '#00e5ff'], ['#7c3cff', '#00ff9c'], ['#ff5a00', '#ffd000'], ['#00a2ff', '#ff006a'], ['#b026ff', '#ff2b2b']], ['fan', 'ballyhoo', 'figure8', 'cross'], ['fan', 'cross', 'tunnel', 'scan'], 'oddeven', 1.3, 1.2, BANG),
  P('dnb', 'Drum & Bass', 'banger', 'Fast crossing lasers and snappy beam chases at 170+', 0.08, '#2a4aff', 1, [0.9, 1, 0.5], [['#00ff9c', '#ff00d4'], ['#00e5ff', '#ff5a00'], ['#b0ff00', '#2b6bff']], ['ballyhoo', 'cross', 'fan'], ['scan', 'cross', 'fan'], 'oddeven', 1.5, 1.5, W(BANG, { board: 'strobe:1.4:3', spots: 'chase:1.5:3' })),
  P('laser_tunnel', 'Laser Tunnel', 'banger', 'A spinning laser tunnel over the room, beams holding still', 0.06, '#2a2aff', 1, [0.5, 1, 0.3], [['#00ff4a', '#00e5ff'], ['#ff2b2b', '#ff00d4'], ['#ffffff', '#00ff9c']], ['still', 'fan'], ['tunnel', 'sheet', 'tunnel', 'cross'], 'mono', 0.8, 1.1, BANG),
  P('techno_bunker', 'Techno Bunker', 'banger', 'Near-dark white strobes and cold beams, relentless', 0.05, '#8a9aff', 0.9, [1, 0.6, 0], [['#ffffff', '#9fb8ff'], ['#e8f6ff', '#4b9bff']], ['still', 'fan', 'cross'], ['sheet', 'scan'], 'mono', 0, 1.2, W(BANG, { neon: 'strobe:1.2:2', accent: 'strobe:1.1:2', sign: 'pulse:1.8' })),
  P('big_room', 'Big Room', 'banger', 'Festival main stage: huge fans, big drops, confetti colours', 0.1, '#4a5cff', 1, [1, 0.9, 0.7], [['#ff2bd6', '#ffd000'], ['#00e5ff', '#ff2b2b'], ['#7c3cff', '#8dff3a'], ['#ff5a00', '#00a2ff']], ['fan', 'sweep', 'ballyhoo'], ['fan', 'tunnel'], 'lr', 1.1, 1.1, BANG),
  P('hardstyle', 'Hardstyle Kick', 'banger', 'Red and white punches on every kick', 0.06, '#ff2b2b', 1, [1, 0.8, 0.3], [['#ff2b2b', '#ffffff'], ['#ff5a00', '#ffffff']], ['still', 'fan', 'ballyhoo'], ['cross', 'scan'], 'oddeven', 1, 1.3, W(BANG, { lamps: 'pulse:0.6', string: 'pulse:1.4' })),
  P('dubstep', 'Wub Wub', 'banger', 'Half-time drops, wobbling purple and green', 0.08, '#7a2bff', 1, [0.9, 0.8, 0.5], [['#7a2bff', '#b0ff00'], ['#ff00d4', '#00ff9c']], ['figure8', 'ballyhoo', 'cross'], ['tunnel', 'cross'], 'lr', 0.9, 1, BANG),
  P('trance_gate', 'Trance Gate', 'banger', 'Euphoric blue-violet sheets, long builds, massive releases', 0.1, '#4a5cff', 1, [0.9, 1, 0.8], [['#2b6bff', '#e8f6ff'], ['#b04bff', '#00d0ff'], ['#00ffd5', '#7a2bff']], ['sweep', 'circle', 'fan'], ['sheet', 'tunnel', 'fan'], 'oddeven', 1, 1, BANG),
  P('jungle_riot', 'Jungle Riot', 'banger', 'Lime green + hot orange, chaotic ballyhoo', 0.1, '#3aff8a', 1, [1, 0.8, 0.6], [['#8dff3a', '#ff5a00'], ['#00ff9c', '#ffd000'], ['#b0ff00', '#ff2bd6']], ['ballyhoo', 'wander', 'cross'], ['scan', 'fan'], 'oddeven', 1.3, 1.3, BANG),
  P('rgb_overload', 'RGB Overload', 'banger', 'Pure red/green/blue splits, maximum colour', 0.08, '#4a5cff', 1, [1, 1, 1], [['#ff0000', '#0040ff'], ['#00ff00', '#ff0000'], ['#0040ff', '#00ff00']], ['fan', 'cross', 'figure8'], ['cross', 'tunnel', 'fan'], 'lr', 1.4, 1.3, BANG),
  P('warehouse', 'Warehouse', 'banger', 'Amber sodium lights and white sweeps, gritty', 0.12, '#ff9a4a', 0.9, [1, 0.5, 0], [['#ffb347', '#ffffff'], ['#ff8a2b', '#fff1d6']], ['sweep', 'still', 'fan'], ['sheet'], 'mono', 0, 1, W(BANG, { lamps: 'steady:0.6' })),
  P('gabber', 'Gabber', 'banger', 'Silly-fast everything (turn the photosensitivity limit on for guests)', 0.06, '#ff2bd6', 1, [1, 1, 1], [['#ff2bd6', '#00ff9c'], ['#ffd000', '#2b6bff']], ['ballyhoo', 'cross'], ['scan', 'cross', 'tunnel'], 'oddeven', 2, 2, W(BANG, { board: 'strobe:1.5:4', spots: 'chase:1.6:4', string: 'chase:1.4:4' })),
  P('club_classic', 'Club Classic', 'banger', 'The default club: neon pairs, fans, lasers, mirror ball', 0.1, '#4a5cff', 1, [1, 0.8, 0.8], [['#ff2bd6', '#00e5ff'], ['#7c3cff', '#00ff9c'], ['#ff5a00', '#ffd000'], ['#00a2ff', '#ff006a'], ['#b026ff', '#ff2b2b'], ['#00ffd5', '#ff4fd8']], ['fan', 'figure8', 'sweep', 'cross'], ['fan', 'cross', 'tunnel'], 'oddeven', 1, 1, BANG),
  P('afterhours', 'Afterhours', 'banger', 'Deep and dark, slow heavy sweeps, lasers low', 0.06, '#3a2aff', 0.9, [0.8, 0.9, 0.4], [['#5a00ff', '#ff00d4'], ['#2b6bff', '#00ffd5']], ['sweep', 'still'], ['sheet', 'tunnel'], 'lr', 0.5, 0.7, W(BANG, { sign: 'pulse:1.3' })),
  // ---------------------------------------------------------------- themes
  P('police', 'Police Lights', 'theme', 'Red / blue split flashing (fun for a raid bit)', 0.12, '#4a5cff', 0.9, [1, 0, 0], [['#ff0000', '#0040ff']], ['still', 'fan'], ['off'], 'lr', 0, 1.2, { sign: 'strobe:1.4:2', neon: 'strobe:1.3:2', accent: 'strobe:1.2:2', onair: 'strobe:1.2:2', spots: 'chase:1.5:4', board: 'strobe:1.2:2', lamps: 'steady:0.3', '*': 'strobe:1:2' }),
  P('witching_hour', 'Witching Hour', 'theme', 'Sickly green and purple, flickering lamps, creeping beams', 0.08, '#5aff7a', 0.6, [0.6, 0.3, 0], [['#5aff3a', '#7a2bff'], ['#b0ff00', '#3a00a0']], ['wander', 'still'], ['sheet'], 'lr', 0, 0.4, { sign: 'flicker:1.2:0.6', neon: 'flicker:1.3:1', lamps: 'flicker:0.7:0.8', spots: 'breathe:0.4:0.25', fireflies: 'drift:1.6:0.4', onair: 'flicker:0.5', '*': 'flicker:0.9:0.7' }),
  P('birthday', 'Birthday', 'theme', 'Party pastels, ball spinning, happy chases', 0.35, '#ffd0f0', 0.75, [0.6, 0.2, 1], [['#ff8ad0', '#8adfff'], ['#ffd07a', '#b08aff'], ['#8affc0', '#ff8ad0']], ['circle', 'figure8'], ['off'], 'oddeven', 1.3, 0.8, W(MID, { string: 'chase:1.4:2', lamps: 'steady:0.8' })),
  P('mono_blue', 'Mono Blue', 'theme', 'Single-colour blue show, clean and classy', 0.12, '#2a5aff', 0.8, [1, 0.6, 0.6], [['#2b6bff', '#8ab4ff']], ['fan', 'sweep', 'still'], ['sheet', 'fan'], 'mono', 0.7, 0.8, W(MID, { neon: 'pulse:1.2', accent: 'pulse:1.1' })),
  P('mono_red', 'Mono Red', 'theme', 'All red, dramatic', 0.1, '#ff3a3a', 0.8, [1, 0.6, 0.4], [['#ff2b2b', '#ff8a8a']], ['still', 'fan'], ['sheet'], 'mono', 0.5, 0.8, W(MID, { neon: 'pulse:1.2', accent: 'pulse:1.1' })),
  P('christmas', 'Holiday Lights', 'theme', 'Red and green chases, warm string lights', 0.3, '#ffcf9a', 0.55, [0.6, 0, 0.8], [['#ff2b2b', '#2bff5a'], ['#ffd000', '#ff2b2b']], ['circle', 'still'], ['off'], 'oddeven', 0.6, 0.6, W(MID, { string: 'chase:1.5:1', lamps: 'steady:0.9' })),
  P('pride', 'Rainbow', 'theme', 'Full rainbow palette stepping every phrase', 0.2, '#ffffff', 0.85, [1, 0.6, 0.8], [['#ff2b2b', '#ff9a00'], ['#ffe600', '#2bff5a'], ['#00a2ff', '#7a2bff'], ['#ff2bd6', '#00e5ff']], ['fan', 'figure8', 'circle'], ['fan', 'tunnel'], 'oddeven', 1, 0.9, W(MID, { neon: 'cycle:1.3:2', accent: 'cycle:1.3:2' })),
  P('horror_red', 'Red Room', 'theme', 'Dim crimson, slow pulse like a heartbeat', 0.06, '#ff1a1a', 0.35, [0.5, 0, 0], [['#ff0000', '#600000']], ['still'], ['off'], 'mono', 0, 0.35, { sign: 'pulse:1.2:0.5', neon: 'breathe:1:0.5', onair: 'pulse:1', lamps: 'flicker:0.5:0.5', '*': 'breathe:0.8:0.5' }),
  P('arcade', 'Arcade', 'theme', 'Pixel colours, chasing boards, bleepy laser scans', 0.2, '#7a5aff', 0.8, [0.6, 0.9, 0.2], [['#ffe600', '#ff2bd6'], ['#00ff9c', '#2b6bff'], ['#ff5a00', '#00e5ff']], ['ballyhoo', 'cross'], ['scan', 'cross'], 'oddeven', 0.8, 1, W(MID, { board: 'chase:1.4:2', string: 'chase:1.3:3' })),
  P('movie_night', 'Movie Night', 'theme', 'Lights down for the screen, a faint blue glow', 0.1, '#3a4aa0', 0, [0, 0, 0], [['#3a4aa0', '#3a4aa0']], ['still'], ['off'], 'mono', 0, 0.3, { onair: 'steady:0.3', lamps: 'steady:0.35', lava: 'breathe:0.8:0.25', fireflies: 'drift:0.8:0.4', '*': 'steady:0.3' }),
  P('sunset_bbq', 'Porch BBQ', 'theme', 'Evening porch vibes, warm lamps, orange sky', 0.4, '#ffa060', 0.3, [0.4, 0, 0.3], [['#ff9a4a', '#ffd27a']], ['still', 'sweep'], ['off'], 'mono', 0.4, 0.5, W(CHILL, { lamps: 'steady:1', string: 'steady:1' })),
];

export const PRESET_CATS: { id: PresetCat; label: string }[] = [
  { id: 'chill', label: 'Chill' }, { id: 'mid', label: 'Mid' }, { id: 'banger', label: 'Banger' }, { id: 'theme', label: 'Themes' },
];
/**
 * Retired preset ids → their current id. Saved scenes, state looks, favourites, deck buttons and scripts made before a
 * rename keep working: every lookup goes through canonPresetId. Never remove an entry (old saves live forever).
 */
export const PRESET_ID_ALIASES: Readonly<Record<string, string>> = {
  moonlit_bayou: 'moonlit_night', swamp_rave: 'house_party', frog_disco: 'disco_fever', bayou_sunset: 'sunset_sway',
  acid_lily: 'acid_uv', spooky_bog: 'witching_hour',
};
/** A preset id, old or new → the current id (unknown ids come back unchanged). */
export const canonPresetId = <T extends string | undefined>(id: T): T =>
  (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESET_ID_ALIASES, id) ? PRESET_ID_ALIASES[id] : id) as T;
/** A light program / palette key ('p_<preset id>') with a retired preset id → the current key; anything else unchanged. */
export const canonPresetKey = (key: string): string => (key.startsWith('p_') ? `p_${canonPresetId(key.slice(2))}` : key);
export const presetById = (id: string | undefined) => { const c = canonPresetId(id); return SHOW_PRESETS.find((p) => p.id === c) ?? null; };

/** Group kind of a group name (the keys used in ShowPreset.groups). */
const KIND_MEMO = new Map<string, string>();   // names are a small fixed set per room; hit every fixture-group every frame
export function groupKind(g: string): string {
  let k = KIND_MEMO.get(g);
  if (k === undefined) { if (KIND_MEMO.size > 512) KIND_MEMO.clear(); k = groupKindUncached(g); KIND_MEMO.set(g, k); }
  return k;
}
function groupKindUncached(g: string): string {
  const n = g.toLowerCase();
  if (/sign/.test(n)) return 'sign';
  if (/neon/.test(n)) return 'neon';
  if (/accent|rgb|strip/.test(n)) return 'accent';
  if (/on_?air|onair/.test(n)) return 'onair';
  if (/spot/.test(n)) return 'spots';
  if (/firefl|star|spark/.test(n)) return 'fireflies';
  if (/board|led|panel|monitor/.test(n)) return 'board';
  if (/lamp|practical|bulb/.test(n)) return 'lamps';
  if (/string|fairy/.test(n)) return 'string';
  if (/lava/.test(n)) return 'lava';
  if (/aqua|tank|water/.test(n)) return 'aqua';
  return '*';
}

/** 'program:intensity:speed' → a group setting. */
export function parseGroupCode(code: string | undefined): LightGroupSetting {
  const [p, i, s] = (code ?? 'pulse').split(':');
  return { program: (p || 'pulse') as LightProgram, intensity: i ? +i : 1, speed: s ? +s : 1, color: null };
}
export const presetGroup = (p: ShowPreset, g: string) => parseGroupCode(p.groups[groupKind(g)] ?? p.groups['*']);
