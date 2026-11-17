// What a 2D rig knows about the world around it (one per page; pure, unit-testable): the room's lights, the wind, the
// graphics tier and the stream's events (chat messages, follows / subs / raids …). The page feeds it
// (src/avatar/flat/rig2d/worldFeed.ts from output.ts); every 2D rig on the page reads it. Without a feed (the studio's
// classic stage, tests) the defaults apply: a soft white key light from the upper left, a light breeze, tier High,
// no events.

export interface Rig2DLight {
  /** Direction the light TRAVELS, in view space (x right, y up, z toward the viewer): a light from the upper left
   *  shining onto the puppet = (+0.5, −0.6, −0.6). Normalised by the reader. */
  dir: [number, number, number];
  /** Linear RGB × intensity (relative: 1 = a normal key light). */
  color: [number, number, number];
}

export type Rig2DTier = 'low' | 'medium' | 'high';

export interface Rig2DEvent {
  /** 'chat' (value = the message text), 'event' (value = follow / sub / raid / cheer / donation / redeem …). */
  kind: 'chat' | 'event';
  value: string;
  /** increasing serial, set by pushRig2DEvent */
  serial: number;
}

export interface Rig2DWorld {
  key: Rig2DLight;
  fill: Rig2DLight;
  /** ambient light colour (linear RGB) */
  ambient: [number, number, number];
  /** light-show colour washing the puppet (linear RGB × level), [0, 0, 0] = none */
  show: [number, number, number];
  /** wind strength 0..2 (0.3 = a breeze; the default with no room) and its direction (−1 = blowing to the left) */
  wind: number;
  windDir: number;
  tier: Rig2DTier;
  /** recent events (the last 64) */
  events: Rig2DEvent[];
  /** true once a page fed real room data (else the defaults are in use) */
  fed: boolean;
}

export const WORLD_DEFAULTS: Readonly<Omit<Rig2DWorld, 'events'>> = Object.freeze({
  key: { dir: [0.45, -0.55, -0.7] as [number, number, number], color: [1, 1, 1] as [number, number, number] },
  fill: { dir: [-0.6, 0.1, -0.8] as [number, number, number], color: [0.35, 0.38, 0.45] as [number, number, number] },
  ambient: [0.45, 0.45, 0.48] as [number, number, number],
  show: [0, 0, 0] as [number, number, number],
  wind: 0.3, windDir: 1, tier: 'high' as Rig2DTier, fed: false,
});

const world: Rig2DWorld = { ...structuredClone(WORLD_DEFAULTS as Rig2DWorld), events: [] };
let serial = 0;

export function rig2dWorld(): Readonly<Rig2DWorld> { return world; }

/** Update the room data (any subset). */
export function setRig2DWorld(w: Partial<Omit<Rig2DWorld, 'events'>>) {
  Object.assign(world, w);
  if (w.key || w.fill || w.ambient || w.wind !== undefined) world.fed = true;
}

/** A chat message / stream event reached this page. */
export function pushRig2DEvent(kind: Rig2DEvent['kind'], value: string) {
  world.events.push({ kind, value: String(value).slice(0, 500), serial: ++serial });
  if (world.events.length > 64) world.events.splice(0, world.events.length - 64);
}

/** Events newer than `after` (a serial). */
export function eventsSince(after: number): Rig2DEvent[] {
  const ev = world.events;
  let i = ev.length;
  while (i > 0 && ev[i - 1].serial > after) i--;
  return ev.slice(i);
}
export const lastEventSerial = () => serial;

/** Back to the defaults (tests). */
export function resetRig2DWorld() { Object.assign(world, structuredClone(WORLD_DEFAULTS as Rig2DWorld)); world.events = []; }

/** Particle budget for the whole puppet per tier. */
export const PARTICLE_BUDGET: Record<Rig2DTier, number> = { low: 0, medium: 128, high: 512 };

/** The performer's emotion from the face (ARKit blendshapes 0..1): the strongest of happy / sad / angry / surprised /
 *  relaxed, or neutral. Same weights as the 3D avatars' estimator (src/avatar/expressions.ts). */
export function faceEmotion(f: Record<string, number>): { name: string; level: number } {
  const g = (k: string) => f[k] ?? 0;
  const avg = (a: string, b: string) => (g(a) + g(b)) / 2;
  const c = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smile = avg('mouthSmileLeft', 'mouthSmileRight'), frown = avg('mouthFrownLeft', 'mouthFrownRight');
  const browDown = avg('browDownLeft', 'browDownRight'), browOuter = avg('browOuterUpLeft', 'browOuterUpRight');
  const wide = avg('eyeWideLeft', 'eyeWideRight'), sneer = avg('noseSneerLeft', 'noseSneerRight'), cheek = avg('cheekSquintLeft', 'cheekSquintRight');
  const e: Record<string, number> = {
    happy: c(smile * 1.1 + cheek * 0.3 - frown * 0.5),
    sad: c(frown * 0.8 + g('browInnerUp') * 0.55 - smile * 0.8 - browDown * 0.2),
    angry: c(browDown * 0.9 + sneer * 0.45 - smile * 0.6),
    surprised: c(browOuter * 0.55 + wide * 0.55 + g('jawOpen') * 0.2 - browDown * 0.6),
    relaxed: c((1 - g('jawOpen')) * cheek * 0.3),
  };
  let best = 'neutral', lv = 0.25;
  for (const [k, v] of Object.entries(e)) if (v > lv) { best = k; lv = v; }
  return { name: best, level: best === 'neutral' ? 1 - lv : lv };
}
