// Show pack: FORMATIONS - where the beams aim (moving heads) and what shape the laser rays make, as pure functions of
// the motion clock (beats) and a fixture's place in the rig. Angles in degrees, the festival convention: yaw 0 = towards
// the crowd, + = towards stage left (+x); pitch = above the horizon. A fixture's place: x −1..1 (left → right), y 0..1
// (low → high), i of n (left → right order), seed 0..1.
// With the flash limit on, the engines pass a calmer motion clock (shared/festivalDirector.ts motionBeat): snapping
// formations (grid, snap, ballyhoo, burst) then ease between their positions instead of jumping.
import { fract, hash3 } from '../festival.ts';

export interface PackGeo { x: number; y: number; z: number; i: number; n: number; seed: number }
export type MoverKind = 'beam' | 'spot' | 'wash';

export const BEAM_FORMS = ['fan', 'tunnel', 'cross', 'counter', 'converge', 'mirror', 'orbit', 'spiral', 'wave', 'grid', 'starburst', 'pendulum', 'lift', 'chevron', 'diamond', 'helix', 'iris', 'ribbon', 'sail', 'steps', 'vault', 'wings', 'terraces', 'corkscrew', 'crosswind', 'orbitals', 'ballyhoo', 'cathedral', 'scissor', 'searchlight', 'crown', 'comb', 'rain', 'zigzag', 'flower', 'pillars', 'vee', 'snap',
  'funnel', 'rise', 'vortex', 'pinch', 'barfan', 'nod', 'sway', 'box', 'eight', 'bankwave', 'drift', 'liquid', 'skytilt', 'bath', 'ceiling', 'halo'] as const;
export type BeamForm = (typeof BEAM_FORMS)[number];
export interface FormDef { id: BeamForm; name: string; word: string; /** beats per cycle */ rate: number; energy: number; /** jumps between positions (eases with the limit on) */ snaps: boolean; /** reads best for these sections */ calm: boolean }
const F = (id: BeamForm, name: string, word: string, rate: number, energy: number, snaps = false, calm = false): FormDef => ({ id, name, word, rate, energy, snaps, calm });
export const BEAM_FORM_DEFS: FormDef[] = [
  F('fan', 'Fan in / out', 'Fans', 8, 0.5), F('tunnel', 'Tunnel ring', 'Tunnel', 8, 0.6), F('cross', 'Crossing rigs', 'Cross', 4, 0.7),
  F('counter', 'Counter-sweep', 'Counter', 4, 0.65), F('converge', 'Converge on the DJ', 'Converge', 4, 0.7), F('mirror', 'Mirror sweep', 'Mirror', 8, 0.5),
  F('orbit', 'Orbit', 'Orbit', 8, 0.5), F('spiral', 'Spiral out', 'Spiral', 8, 0.6), F('wave', 'Pan wave', 'Wave', 4, 0.6),
  F('grid', 'Grid snaps', 'Grid', 2, 0.85, true), F('starburst', 'Starburst', 'Starburst', 4, 0.8), F('pendulum', 'Pendulum', 'Pendulum', 4, 0.55),
  F('lift', 'Lift to the sky', 'Lift', 16, 0.65), F('chevron', 'Chevron', 'Chevron', 8, 0.55), F('diamond', 'Diamond path', 'Diamond', 8, 0.55),
  F('helix', 'Helix', 'Helix', 8, 0.5), F('iris', 'Iris', 'Iris', 8, 0.55), F('ribbon', 'Ribbon', 'Ribbon', 8, 0.45, false, true),
  F('sail', 'Sail', 'Sail', 8, 0.45, false, true), F('steps', 'Steps', 'Steps', 4, 0.6, true), F('vault', 'Vault', 'Vault', 16, 0.35, false, true),
  F('wings', 'Wings', 'Wings', 4, 0.65), F('terraces', 'Terraces', 'Terraces', 8, 0.5, true), F('corkscrew', 'Corkscrew', 'Corkscrew', 4, 0.7),
  F('crosswind', 'Crosswind', 'Crosswind', 8, 0.55), F('orbitals', 'Orbitals', 'Orbitals', 4, 0.6), F('ballyhoo', 'Ballyhoo', 'Ballyhoo', 2, 0.95, true),
  F('cathedral', 'Cathedral pillars', 'Cathedral', 16, 0.25, false, true), F('scissor', 'Scissors', 'Scissor', 4, 0.75), F('searchlight', 'Searchlights', 'Searchlight', 32, 0.2, false, true),
  F('crown', 'Crown', 'Crown', 16, 0.4, false, true), F('comb', 'Comb sweep', 'Comb', 8, 0.5), F('rain', 'Rain on the crowd', 'Rain', 4, 0.6),
  F('zigzag', 'Zigzag', 'Zigzag', 4, 0.65), F('flower', 'Flower', 'Flower', 8, 0.5), F('pillars', 'Pillars', 'Pillars', 16, 0.15, false, true),
  F('vee', 'V spread', 'Vee', 8, 0.4, false, true), F('snap', 'Snap positions', 'Snap', 1, 0.9, true),
  // build geometries, groove motions, slow motions
  F('funnel', 'Funnel', 'Funnel', 8, 0.7), F('rise', 'Rising steps', 'Rise', 1, 0.7, true), F('vortex', 'Vortex', 'Vortex', 8, 0.75),
  F('pinch', 'Pinch', 'Pinch', 4, 0.7), F('barfan', 'Bar fan', 'Bar Fan', 4, 0.55, true), F('nod', 'Nod', 'Nod', 1, 0.6),
  F('sway', 'Sway', 'Sway', 8, 0.45), F('box', 'Box step', 'Box', 1, 0.6, true), F('eight', 'Figure eight', 'Eight', 4, 0.5),
  F('bankwave', 'Bank wave', 'Bank Wave', 4, 0.55), F('drift', 'Drift', 'Drift', 32, 0.15, false, true), F('liquid', 'Liquid', 'Liquid', 16, 0.2, false, true),
  F('skytilt', 'Sky tilt', 'Sky Tilt', 32, 0.2, false, true), F('bath', 'Floor bath', 'Bath', 16, 0.1, false, true), F('ceiling', 'Ceiling circles', 'Ceiling', 16, 0.2, false, true),
  F('halo', 'Halo', 'Halo', 16, 0.2, false, true),
];
export const beamFormById = (id: string) => BEAM_FORM_DEFS.find((f) => f.id === id);

const HOME: Record<MoverKind, number> = { beam: 58, spot: -18, wash: -30 };
const ease = (x: number) => { const c = x < 0 ? 0 : x > 1 ? 1 : x; return c * c * (3 - 2 * c); };
const TAU = Math.PI * 2;

export interface Aim { yaw: number; pitch: number; zoom: number }
/**
 * Beam / spot / wash aim for a formation. `mb` = the motion clock (beats; a calmer clock with the limit on), `rate` =
 * beats per cycle, `amp` 0..1.3, `calm` = ease snaps. Writes yaw / pitch (deg) and zoom 0..1.
 */
export function beamAim(form: BeamForm, kind: MoverKind, mb: number, rate: number, amp: number, g: PackGeo, calm: boolean, out: Aim): Aim {
  const t = mb / Math.max(0.25, rate), tw = TAU * t;
  const n = Math.max(1, g.n), u = n > 1 ? g.i / (n - 1) : 0.5, side = g.x < 0 ? -1 : 1, ax = Math.abs(g.x);
  const home = HOME[kind], up = kind === 'beam';
  let yaw = g.x * 18, pitch = home, zoom = kind === 'beam' ? 0 : kind === 'spot' ? 0.35 : 0.8;
  switch (form) {
    case 'fan': { const o = 0.5 + 0.5 * Math.sin(tw); yaw = g.x * (12 + 48 * o) * amp; pitch += -8 * Math.sin(tw); break; }
    case 'tunnel': { const a = TAU * u + tw * 0.25, R = 16 * amp; yaw = Math.cos(a) * R; pitch = (up ? 40 : -12) + Math.sin(a) * R * 0.75; zoom = 0; break; }
    case 'cross': yaw = -side * (26 + 22 * (0.5 + 0.5 * Math.sin(tw))) * amp; pitch -= 12; break;
    case 'counter': yaw = (g.i % 2 ? 1 : -1) * 42 * Math.sin(tw) * amp + g.x * 6; break;
    case 'converge': yaw = -g.x * 34; pitch = up ? 48 : -10; pitch += Math.sin(tw) * 6 * amp; break;
    case 'mirror': yaw = side * 40 * Math.sin(tw) * amp * (0.4 + 0.6 * ax); break;
    case 'orbit': yaw = g.x * 12 + Math.cos(tw + g.i * 0.4) * 24 * amp; pitch += Math.sin(tw + g.i * 0.4) * 18 * amp; break;
    case 'spiral': { const r = 8 + 30 * fract(t); const a = tw * 2 + u * TAU; yaw = Math.cos(a) * r * amp; pitch += Math.sin(a) * r * 0.7 * amp; break; }
    case 'wave': yaw = Math.sin(TAU * (t - g.x * 0.5)) * 40 * amp; break;
    case 'grid': case 'snap': {
      // positions on a 5 x 3 grid of aims, a new cell every step (eased with the limit on)
      const step = form === 'snap' ? mb : mb / 2, k = Math.floor(step), w = fract(step);
      const cell = (j: number, s: number) => Math.floor(hash3(j, g.i, s) * 5) - 2;
      const e = calm ? ease(w / 0.45) : Math.min(1, w / 0.06);
      const ya = cell(k - 1, 3) * 20, yb = cell(k, 3) * 20, pa = (cell(k - 1, 9) % 3) * 12, pb = (cell(k, 9) % 3) * 12;
      yaw = (ya + (yb - ya) * e) * amp + g.x * 6; pitch += (pa + (pb - pa) * e) * amp; break; }
    case 'starburst': { const o = Math.exp(-fract(t) * 3); yaw = g.x * (20 + 45 * o) * amp; pitch += (g.y - 0.5) * 30 + 12 * o; zoom = kind === 'beam' ? 0.2 * o : zoom; break; }
    case 'pendulum': yaw = g.x * 12; pitch += Math.sin(tw - g.x * 0.6) * 40 * amp; break;
    case 'lift': { const w = calm ? 0.5 - 0.5 * Math.cos(tw) : fract(t); pitch = (up ? -5 : -25) + 90 * w * w; yaw = g.x * 22; break; }
    case 'chevron': { const flip = Math.sin(tw * 0.5); yaw = g.x * 35 * amp; pitch = home + flip * (ax * 34 - 12) * amp; break; }
    case 'diamond': { const a = tw + u * TAU * 0.25; const c = Math.cos(a), s = Math.sin(a), d = Math.abs(c) + Math.abs(s); yaw = g.x * 10 + (c / d) * 32 * amp; pitch += (s / d) * 24 * amp; break; }
    case 'helix': yaw = Math.cos(tw + g.i * 0.6) * 34 * amp; pitch += Math.sin(tw + g.i * 0.6) * 20 * amp; break;
    case 'iris': { const R = (6 + 26 * (0.5 + 0.5 * Math.cos(tw))) * amp, a = TAU * u + t * 0.6; yaw = Math.cos(a) * R; pitch = (up ? 44 : -14) + Math.sin(a) * R * 0.7; break; }
    case 'ribbon': yaw = g.x * 30 + Math.sin(TAU * (t + g.x * 0.5)) * 14 * amp; pitch += Math.cos(TAU * (t + g.x * 0.35)) * 16 * amp; break;
    case 'sail': yaw = g.x * 26; pitch += g.x * 30 * Math.sin(tw) * amp; break;
    case 'steps': { const k = Math.floor(mb), w = fract(mb), e = calm ? ease(w / 0.5) : Math.min(1, w / 0.08); const lvl = (j: number) => ((g.i + j) % 4) / 3; pitch = home - 30 + 60 * (lvl(k - 1) + (lvl(k) - lvl(k - 1)) * e) * amp; yaw = g.x * 30; break; }
    case 'vault': yaw = g.x * 45 * amp; pitch = home + 22 - ax * 48 + Math.sin(tw) * 4; break;
    case 'wings': { const o = 0.5 + 0.5 * Math.sin(tw); yaw = side * (16 + 44 * o) * Math.sqrt(ax) * amp; pitch += 14 * Math.sin(tw + 1); break; }
    case 'terraces': { const tier = Math.floor(u * 2.999); const k = Math.floor(mb / 4), w = fract(mb / 4), e = calm ? ease(w / 0.5) : ease(w / 0.2); const lv = (j: number) => ((tier + j) % 3) - 1; pitch = home + 22 * (lv(k - 1) + (lv(k) - lv(k - 1)) * e); yaw = g.x * 34 * amp; break; }
    case 'corkscrew': { const a = tw * 2 + g.x * 3; yaw = g.x * 20 + Math.cos(a) * 18 * amp; pitch += Math.sin(a) * 18 * amp; break; }
    case 'crosswind': yaw = 35 * Math.sin(tw - g.x * 1.2) * amp; pitch -= 10 + 6 * Math.cos(tw - g.x); break;
    case 'orbitals': { const pair = Math.floor(g.i / 2), a = tw * 1.5 + (g.i % 2) * Math.PI; yaw = (n > 2 ? (pair / Math.max(1, Math.ceil(n / 2) - 1) - 0.5) * 60 : 0) + Math.cos(a) * 14 * amp; pitch += Math.sin(a) * 14 * amp; break; }
    case 'ballyhoo': {
      const k = Math.floor(mb / 2), w = fract(mb / 2), e = calm ? ease(w) : ease(Math.min(1, w / 0.35));
      const ya = (hash3(k - 1, g.i, 7) - 0.5) * 120, yb = (hash3(k, g.i, 7) - 0.5) * 120, pa = (hash3(k - 1, g.i, 9) - 0.5) * 70, pb = (hash3(k, g.i, 9) - 0.5) * 70;
      if (up) pitch = 36;
      yaw = (ya + (yb - ya) * e) * amp; pitch += (pa + (pb - pa) * e) * amp * 0.7; break; }
    case 'cathedral': yaw = -g.x * 8 + Math.sin(tw + g.i) * 2; pitch = (up ? 80 : 20) - ax * 6; zoom = 0; break;
    case 'scissor': yaw = (g.i % 2 ? 1 : -1) * (g.x * 20 + 32 * Math.sin(tw)) * amp; pitch -= 4; break;
    case 'searchlight': yaw = Math.cos(tw + g.x) * 50 * amp; pitch = (up ? 62 : 10) + Math.sin(tw + g.x) * 18; break;
    case 'crown': { const a = TAU * u + tw; yaw = g.x * 30 + Math.cos(a) * 10; pitch = (up ? 72 : 15) + Math.sin(a) * 8; break; }
    case 'comb': yaw = 40 * Math.sin(tw) * amp + g.x * 4; break;
    case 'rain': yaw = g.x * 15; pitch = -40 + 22 * Math.sin(tw + g.x * 0.8) * amp; break;
    case 'zigzag': yaw = g.x * 30; pitch += (g.i % 2 ? 1 : -1) * 22 * Math.cos(tw) * amp; break;
    case 'flower': { const a = TAU * u + tw * 0.5, R = (14 + 14 * Math.cos(3 * a + tw)) * amp; yaw = Math.cos(a) * R; pitch = (up ? 46 : -12) + Math.sin(a) * R * 0.7; break; }
    case 'pillars': yaw = g.x * 9 + Math.sin(tw) * 3; pitch = (up ? 84 : 30) - ax * 10; zoom = 0; break;
    case 'vee': yaw = g.x * 46 * amp; pitch = up ? 62 : home; break;
    case 'funnel': { const a = TAU * u + tw, R = 26 * amp * (0.55 + 0.45 * Math.cos(tw * 0.5)); yaw = Math.cos(a) * R; pitch = home + (up ? -6 : 10) + Math.sin(a) * R * 0.5; break; }
    case 'rise': { const k = Math.floor(mb), w = fract(mb), e = calm ? ease(w / 0.5) : Math.min(1, w / 0.1); const lv = (j: number) => ((j % 4) + 4) % 4; pitch = home - 30 + 20 * (lv(k - 1) + (lv(k) - lv(k - 1)) * e) * amp; yaw = g.x * 24; break; }
    case 'vortex': { const a = TAU * u + tw * 2, R = (8 + 26 * (1 - fract(t))) * amp; yaw = Math.cos(a) * R; pitch = (up ? 44 : -12) + Math.sin(a) * R * 0.7; break; }
    case 'pinch': yaw = Math.sin(tw + (g.y > 0.5 ? Math.PI : 0) + (g.i % 2) * Math.PI) * 36 * amp + g.x * 8; break;
    case 'barfan': { const k = Math.floor(mb / 4), w = fract(mb / 4), e = calm ? ease(w / 0.5) : ease(w / 0.12); const W = (j: number) => [14, 30, 46, 62][((j % 4) + 4) % 4]; yaw = g.x * (W(k - 1) + (W(k) - W(k - 1)) * e) * amp; break; }
    case 'nod': { const w = calm ? 0.5 + 0.5 * Math.cos(TAU * fract(mb)) : Math.exp(-fract(mb) * 5); pitch = home - 18 * w * amp; yaw = g.x * 26; break; }
    case 'sway': yaw = g.x * 20 + Math.sin(tw) * 22 * amp; pitch += Math.sin(tw * 2) * 4; break;
    case 'box': { const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]], k = Math.floor(mb), w = fract(mb), e = calm ? ease(w / 0.6) : ease(w / 0.15), a = C[((k - 1) % 4 + 4) % 4], b = C[(k % 4 + 4) % 4];
      yaw = g.x * 16 + (a[0] + (b[0] - a[0]) * e) * 18 * amp; pitch += (a[1] + (b[1] - a[1]) * e) * 12 * amp; break; }
    case 'eight': yaw = Math.sin(tw) * 34 * amp + g.x * 6; pitch += Math.sin(2 * tw) * 14 * amp; break;
    case 'bankwave': yaw = g.x * 22; pitch += Math.sin(TAU * (t - g.y * 0.8 - g.x * 0.3)) * 20 * amp; break;
    case 'drift': yaw = g.x * 24 + Math.sin(tw + g.i * 0.7) * 10; pitch += Math.sin(tw * 0.7 + g.i) * 6; break;
    case 'liquid': yaw = Math.sin(tw + g.x) * 26 * amp; pitch += Math.sin(tw * 1.5 + g.i * 0.5) * 10; break;
    case 'skytilt': pitch = (up ? 20 : -30) + 50 * (0.5 + 0.5 * Math.sin(tw + g.y * Math.PI + g.x)); yaw = g.x * 22; break;
    case 'bath': pitch = up ? -50 : -55; yaw = g.x * 14; zoom = 1; break;
    case 'ceiling': { const a = tw + u * TAU; yaw = Math.cos(a) * 25; pitch = (up ? 75 : 30) + Math.sin(a) * 8; zoom = 0.3; break; }
    case 'halo': { const R = (18 + 8 * Math.sin(tw)) * amp, a = TAU * u + t * 0.25; yaw = Math.cos(a) * R; pitch = (up ? 50 : -10) + Math.sin(a) * R * 0.7; break; }
  }
  out.yaw = yaw; out.pitch = Math.max(-70, Math.min(89, pitch)); out.zoom = zoom;
  return out;
}

// ---------------------------------------------------------------------------------------------------- lasers
export const LASER_FORMS = ['fan', 'sheet', 'tunnel', 'cone', 'scan', 'cross', 'grid', 'star', 'helix', 'chevron', 'liquid', 'burst', 'wall', 'scissor', 'comb', 'zigzag', 'cathedral', 'vortex', 'crown', 'iris', 'ribbon', 'diamond', 'stack', 'dome', 'split'] as const;
export type LaserForm = (typeof LASER_FORMS)[number];
export interface LaserFormDef { id: LaserForm; name: string; word: string; energy: number; /** draw translucent sheets between neighbouring rays */ sheet: boolean; /** rays (fraction of the origin's budget) */ rays: number; calm: boolean }
const LF = (id: LaserForm, name: string, word: string, energy: number, sheet: boolean, rays: number, calm = false): LaserFormDef => ({ id, name, word, energy, sheet, rays, calm });
export const LASER_FORM_DEFS: LaserFormDef[] = [
  LF('fan', 'Fan', 'Fans', 0.5, true, 0.75), LF('sheet', 'Sheet', 'Sheets', 0.35, true, 1, true), LF('tunnel', 'Spinning tunnel', 'Tunnel', 0.7, false, 1),
  LF('cone', 'Cone', 'Cone', 0.5, false, 1), LF('scan', 'Scanners', 'Scan', 0.75, false, 0.25), LF('cross', 'Cross', 'Cross', 0.65, false, 1),
  LF('grid', 'Grid', 'Grid', 0.6, false, 1), LF('star', 'Star', 'Star', 0.7, false, 1), LF('helix', 'Helix ribbon', 'Helix', 0.55, false, 1),
  LF('chevron', 'Chevrons', 'Chevron', 0.6, false, 1), LF('liquid', 'Liquid sky', 'Liquid', 0.2, true, 1, true), LF('burst', 'Burst', 'Burst', 0.9, false, 1),
  LF('wall', 'Light wall', 'Wall', 0.45, true, 1, true), LF('scissor', 'Scissors', 'Scissor', 0.75, false, 1), LF('comb', 'Comb', 'Comb', 0.6, false, 0.5),
  LF('zigzag', 'Zigzag', 'Zigzag', 0.65, false, 1), LF('cathedral', 'Cathedral', 'Cathedral', 0.3, true, 0.75, true), LF('vortex', 'Vortex', 'Vortex', 0.8, false, 1),
  LF('crown', 'Crown', 'Crown', 0.35, false, 0.75, true), LF('iris', 'Iris', 'Iris', 0.55, false, 1), LF('ribbon', 'Ribbon', 'Ribbon', 0.4, true, 1, true),
  LF('diamond', 'Diamond', 'Diamond', 0.55, false, 1), LF('stack', 'Stacked tiers', 'Stack', 0.7, true, 1), LF('dome', 'Dome', 'Dome', 0.3, false, 1, true),
  LF('split', 'Split fans', 'Split', 0.6, true, 1),
];
export const laserFormById = (id: string) => LASER_FORM_DEFS.find((f) => f.id === id);

/** The origin's aim + width for a laser formation at the motion clock (the rays fan around it: rayAim). */
export function laserAim(form: LaserForm, mt: number, g: PackGeo, calm: boolean, out: { yaw: number; pitch: number; spread: number; spin: number }) {
  const side = g.x < 0 ? -1 : 1;
  out.yaw = -g.x * 10; out.pitch = 8; out.spread = 40; out.spin = 0;
  switch (form) {
    case 'fan': out.spread = 30 + 40 * (0.5 + 0.5 * Math.sin(mt * Math.PI / 4)); out.pitch = 6 + 6 * Math.sin(mt * Math.PI / 8); break;
    case 'sheet': out.spread = 80; out.pitch = 4 + 16 * (0.5 + 0.5 * Math.sin(mt * Math.PI / 4 + g.i)); break;
    case 'tunnel': out.spread = 18; out.pitch = 3; out.spin = mt * (calm ? 20 : 45); break;
    case 'cone': out.spread = 26 + 10 * Math.sin(mt * Math.PI / 8); out.pitch = 10; out.spin = mt * 6; break;
    case 'iris': out.spread = 8 + 34 * (0.5 + 0.5 * Math.cos(mt * Math.PI / 4)); out.pitch = 8; out.spin = mt * 10; break;
    case 'vortex': out.spread = 10 + 30 * (1 - fract(mt / 8)); out.pitch = 6; out.spin = mt * (calm ? 30 : 70); break;
    case 'scan': out.spread = 6; out.yaw = Math.sin(mt * Math.PI / 2 + g.i) * 50; out.pitch = 3 + 8 * Math.sin(mt * (calm ? Math.PI / 2 : Math.PI)); break;
    case 'cross': out.spread = 34; out.yaw = -side * 22 + Math.sin(mt * Math.PI / 4) * 10; out.pitch = 8; break;
    case 'grid': out.spread = 50; out.pitch = 12; out.yaw = Math.sin(mt * Math.PI / 8) * 12; break;
    case 'star': out.spread = 70; out.pitch = 16; out.spin = mt * 8; break;
    case 'helix': out.spread = 70; out.pitch = 10; break;
    case 'chevron': out.spread = 60; out.pitch = 10; break;
    case 'liquid': out.spread = 110; out.pitch = 1.5 + 2.5 * Math.sin(mt * Math.PI / 8 + g.x * 2); break;
    case 'burst': {
      if (calm) { const k = Math.floor(mt), w = fract(mt), e = w * w * (3 - 2 * w), l = (a: number, b: number) => a + (b - a) * e;
        out.spread = 60 + 30 * Math.cos(2 * Math.PI * mt); out.pitch = 10 + 20 * l(hash3(k - 1, g.i), hash3(k, g.i)); out.yaw = (l(hash3(k - 1, g.i, 3), hash3(k, g.i, 3)) - 0.5) * 40; break; }
      out.spread = 100 * Math.exp(-fract(mt) * 2); out.pitch = 10 + 20 * hash3(Math.floor(mt), g.i); out.yaw = (hash3(Math.floor(mt), g.i, 3) - 0.5) * 40; break; }
    case 'wall': out.spread = 60; out.pitch = 4; out.yaw = -g.x * 6 + Math.sin(mt * Math.PI / 8) * 18; break;
    case 'scissor': out.spread = 70; out.pitch = 9; break;
    case 'comb': out.spread = 10; out.yaw = Math.sin(mt * Math.PI / 4) * 48; out.pitch = 6; break;
    case 'zigzag': out.spread = 64; out.pitch = 10; break;
    case 'cathedral': out.spread = 50; out.pitch = 74; out.yaw = -g.x * 8; break;
    case 'crown': out.spread = 18; out.pitch = 70; out.spin = mt * 6; break;
    case 'ribbon': out.spread = 90; out.pitch = 8; break;
    case 'diamond': out.spread = 30; out.pitch = 12; out.spin = mt * 12; break;
    case 'stack': out.spread = 70; out.pitch = 4; break;
    case 'dome': out.spread = 70; out.pitch = 62; out.spin = mt * 4; break;
    case 'split': out.spread = 64; out.pitch = 10 + 4 * Math.sin(mt * Math.PI / 8); break;
  }
  return out;
}

/** Ray k of n of a formation around the origin's aim (yaw / pitch / spread / spin from laserAim): yaw, pitch (deg). */
export function rayAim(form: LaserForm, k: number, n: number, mt: number, seed: number, o: { yaw: number; pitch: number; spread: number; spin: number }, out: { yaw: number; pitch: number }) {
  const u = n > 1 ? k / (n - 1) - 0.5 : 0, s = o.spread;
  let yaw = o.yaw + u * s, pitch = o.pitch;
  const ring = (half: number) => { const a = o.spin * Math.PI / 180 + (k / n) * TAU; yaw = o.yaw + Math.cos(a) * half; pitch = o.pitch + Math.sin(a) * half; };
  switch (form) {
    case 'tunnel': case 'cone': case 'iris': case 'vortex': case 'crown': case 'dome': ring(s * 0.5); break;
    case 'stack': { const per = Math.max(1, Math.ceil(n / 3)), row = Math.floor(k / per), j = k % per; yaw = o.yaw + (per > 1 ? j / (per - 1) - 0.5 : 0) * s; pitch = o.pitch + ((row + Math.floor(mt)) % 3) * 7; break; }
    case 'split': { const d = k % 2 ? 1 : -1; const v = (Math.floor(k / 2) / Math.max(1, Math.ceil(n / 2) - 1) - 0.5) * s; yaw = o.yaw + v; pitch = o.pitch + d * 6; break; }
    case 'star': { const a = o.spin * Math.PI / 180 + (k / n) * TAU; const r = s * 0.5 * (k % 2 ? 0.55 : 1); yaw = o.yaw + Math.cos(a) * r; pitch = o.pitch + Math.sin(a) * r * 0.8; break; }
    case 'diamond': { const a = o.spin * Math.PI / 180 + (k / n) * TAU, c = Math.cos(a), si = Math.sin(a), d = Math.abs(c) + Math.abs(si); yaw = o.yaw + (c / d) * s * 0.5; pitch = o.pitch + (si / d) * s * 0.4; break; }
    case 'cross': { const d = k % 2 ? 1 : -1; const v = (Math.floor(k / 2) / Math.max(1, Math.ceil(n / 2) - 1) - 0.5) * s; yaw = o.yaw + v; pitch = o.pitch + d * v * 0.45; break; }
    case 'grid': { const half = Math.ceil(n / 2); if (k < half) { yaw = o.yaw + (half > 1 ? k / (half - 1) - 0.5 : 0) * s; pitch = o.pitch; } else { const j = k - half, m = Math.max(1, n - half - 1); yaw = o.yaw + Math.sin(mt * Math.PI / 4) * s * 0.3; pitch = o.pitch - 6 + (j / m) * s * 0.6; } break; }
    case 'helix': case 'ribbon': pitch = o.pitch + Math.sin(TAU * (u * (form === 'helix' ? 2 : 1) + mt / 8)) * (form === 'helix' ? 12 : 7); break;
    case 'chevron': { const flip = Math.sin(mt * Math.PI / 4) >= 0 ? 1 : -1; pitch = o.pitch + flip * (Math.abs(u) * s * 0.45 - s * 0.1); break; }
    case 'scissor': { const d = k % 2 ? 1 : -1; const v = (Math.floor(k / 2) / Math.max(1, Math.ceil(n / 2) - 1) - 0.5) * s * 0.5; const sw = Math.sin(mt * Math.PI / 4) * s * 0.35; yaw = o.yaw + v + d * sw; pitch = o.pitch + d * 3; break; }
    case 'zigzag': pitch = o.pitch + (k % 2 ? 1 : -1) * 7 * (0.6 + 0.4 * Math.cos(mt * Math.PI / 2)); break;
    case 'wall': { yaw = o.yaw + Math.sin(u * 2) * 3; pitch = o.pitch + (u + 0.5) * s; break; }
    case 'cathedral': pitch = o.pitch + Math.abs(u) * -12 + Math.sin(mt * Math.PI / 16 + k) * 1.5; break;
    case 'comb': yaw = o.yaw + u * s; break;
    case 'burst': yaw = o.yaw + Math.sin(k * 12.9898 + seed * 78) * 0.5 * s * 1.2; pitch = o.pitch + Math.cos(k * 4.1) * s * 0.25; break;
    case 'sheet': case 'liquid': break;
    default: pitch = o.pitch + Math.sin(k * 1.7 + mt) * 1.5;
  }
  out.yaw = yaw; out.pitch = pitch;
  return out;
}
