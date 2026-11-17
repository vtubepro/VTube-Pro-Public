// Special effects, emulated only (never DMX): flame columns (MagicFX-style, 4 m, up to 8 m in big-flame mode), CO2 jets
// (~8 m plumes that hang as a cloud), confetti cannons (metallic flutter over the crowd), gerbs / sparkulars (fountains),
// comets, fireworks (shells that burst - also into a named point SHAPE from scene.json festival.shapes).
// GPU particles: every particle is a pure function of (event slot, its own random numbers, age) evaluated in the vertex
// shader - no per-particle CPU work and no state, so every page shows the same burst. The CPU only fills 24-32 event
// slots per system (origin, start time, power, kind). Flames are flame-cannon shots: bursts of rolling fireballs (see
// "flames" below) with a warm pool on the floor under them; 'green' heads burn green fluid, 'hero' heads fire taller.
// Shells: the lift trail climbs for the shell's lift time (from its anchor's height: ~1.2 s for 30 m, ~2.6 s for 100 m)
// and the burst lands ON the hit's beat (the director keeps firework hits FIREWORK_LEAD seconds early). Bursts: peony,
// willow (long gold drooping trails), salute (white glitter), crossette (splitting stars), glitter, or a named shape.
// Sparks: gerbs, comets, mines (a spray of stars), waterfalls (a falling spark curtain). CO2: jets and smoke puffs.
import * as THREE from 'three';
import { FESTIVAL_BUDGET, hash3, type Tier } from '../../../shared/festival.ts';
import { NOISE_GLSL, fxMaterial, glow, softSprite, type Fixture } from './common.ts';
import { ShotGate, newHeadGate, newShotOut, type HeadGate } from './flameShots.ts';

const PUFF_ATTRS = ['aA', 'aB', 'aC'] as const;

const SLOTS = 24;
export interface PyroEvent {
  /** stable key (the director's hit key + anchor) */
  key: string;
  /** room-frame origin + aim (unit), start time (page seconds), duration (s), power 0..1.5 */
  pos: THREE.Vector3; aim: THREE.Vector3; t0: number; dur: number; power: number;
  /** sparks: 0 gerb, 1 comet, 4 waterfall, 5 mine, 10 comet fan, 11 comet row, 12 V-fan (+0.5: the event's own colours;
   *  `dur` then carries the fan: shared/festivalFans.ts packFan) · shells: 2 peony, 3 shaped, 6 willow, 7 salute, 8 crossette,
   *  9 glitter (+ burst height / 400 as the fraction) · CO2: 0 jet, 1 puff */
  mode: number; seed: number;
  color: THREE.Color; color2: THREE.Color;
  /** how long it burns (s) when `dur` carries something else (a comet fan's packed shape) */
  span?: number;
  /** (set by the system) when it is over, page seconds */
  end?: number;
}

const PARTICLE_VS = (motion: string, slots: number) => /* glsl */ `
uniform float uTime; uniform vec4 uA[${slots}]; uniform vec4 uB[${slots}]; uniform vec4 uC[${slots}]; uniform vec4 uD[${slots}]; uniform vec2 uShape[64]; uniform float uShapeN; uniform float uPer; uniform float uMinAng; uniform float uGain; uniform float uScale; uniform float uSafe;
attribute vec4 aRand; attribute float aSlot;   // aSlot: the slot + (this particle's index in it) / uPer
varying vec2 vUv; varying vec4 vCol; varying float vSpin;
${NOISE_GLSL}
// uA = origin xyz, t0 · uB = aim xyz, dur · uC = colour rgb, power · uD = colour2 rgb, mode
${motion}
void main() {
  int s = int(aSlot);
  vec4 A = uA[s], Bv = uB[s], Cc = uC[s], Dd = uD[s];
  float age = uTime - A.w;
  vec3 p; float size; vec4 col; float stretch; vec3 vel;
  bool alive = motion(A.xyz, Bv.xyz, Bv.w, Cc.w, Dd.w, age, aRand, Cc.rgb, Dd.rgb, p, vel, size, col, stretch);
  col.rgb *= uGain;                                 // (shell stars are HDR-bright points: the bloom makes them glow)
  vUv = position.xy + 0.5; vCol = col; vSpin = aRand.w;
  if (!alive || col.a < 0.002) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec4 wp = modelMatrix * vec4(p, 1.0);
  // (Safe flashes ON: particles right at the lens fade out - one near piece or spark can cover a whole region)
  vCol.a *= mix(1.0, smoothstep(2.5, 9.0, distance(wp.xyz, cameraPosition)), uSafe);
  vec4 c = viewMatrix * wp;
  // far stars (shells 200 m away) never shrink under ~2 px: a star is a point of light, bloom does the rest
  float far = max(size, -c.z * uMinAng);
  size = far;
  vec2 q = position.xy * size;
  if (stretch > 0.0) {
    // velocity-stretched streak (sparks): along the projected velocity
    vec3 vv = mat3(viewMatrix) * mat3(modelMatrix) * vel;
    vec2 d = normalize(vv.xy + vec2(1e-5, 0.0));
    float L = 1.0 + stretch * length(vv) * 0.06;
    q = d * position.y * size * L + vec2(-d.y, d.x) * position.x * size;
  }
  c.xy += q;
  gl_Position = projectionMatrix * c;
}`;

/** motion functions per system (GLSL): fill p (room frame), vel, size, col, stretch; return alive */
const CO2_MOTION = /* glsl */ `
bool motion(vec3 o, vec3 aim, float dur, float power, float mode, float age, vec4 r, vec3 c1, vec3 c2, out vec3 p, out vec3 vel, out float size, out vec4 col, out float stretch) {
  stretch = 0.0; vel = vec3(0.0);
  if (mode > 0.5) {                         // smoke puff (a burst's residue): a slow cloud that drifts and spreads
    float a = age - r.x * 0.3;
    if (a < 0.0 || a > 9.0) { p = o; size = 0.0; col = vec4(0.0); return false; }
    vec3 dir = normalize(vec3(r.y - 0.5, r.z - 0.5, r.w - 0.5) + vec3(1e-4));
    p = o + dir * (3.0 + 6.0 * power) * (1.0 - exp(-a * 0.8)) + vec3(0.6, 0.25, 0.2) * a;
    size = (1.6 + 3.4 * power) * (0.4 + 0.6 * (1.0 - exp(-a * 0.6)));
    col = vec4(mix(vec3(0.13, 0.14, 0.16), c1 * 0.45, 0.3), 0.03 * smoothstep(0.0, 0.4, a) * (1.0 - smoothstep(2.5, 8.0, a)));
    return true;
  }
  float emit = r.x * dur;                  // when this particle left the nozzle
  float a = age - emit;
  if (a < 0.0 || a > 3.6) { p = o; size = 0.0; col = vec4(0.0); return false; }
  float sp = (14.0 + 8.0 * r.y) * (0.6 + 0.4 * power);
  vec3 side = normalize(cross(aim, vec3(0.31, 0.0, 0.95))); vec3 up2 = cross(side, aim);
  float ang = r.z * 6.2832, cone = 0.07 + 0.05 * r.y;
  vec3 dir = normalize(aim + (side * cos(ang) + up2 * sin(ang)) * cone);
  float k = 2.4;
  p = o + dir * sp * (1.0 - exp(-k * a)) / k;
  p += vec3(sin(a * 0.9 + r.w * 6.0), 0.25, cos(a * 0.7 + r.z * 5.0)) * a * a * 0.35;
  p += (vec3(vnoise(p * 0.5 + a), vnoise(p * 0.5 + 3.0 + a), vnoise(p * 0.5 + 7.0 - a)) - 0.5) * a * 1.4;
  size = 0.35 + a * 1.3 + r.w * 0.3;
  float fade = smoothstep(0.0, 0.06, a) * (1.0 - smoothstep(0.9, 3.2, a));
  col = vec4(mix(vec3(0.95, 0.97, 1.0), c1, 0.35), 0.16 * fade * (0.7 + 0.3 * r.y));
  return true;
}`;
const CONFETTI_MOTION = /* glsl */ `
bool motion(vec3 o, vec3 aim, float dur, float power, float mode, float age, vec4 r, vec3 c1, vec3 c2, out vec3 p, out vec3 vel, out float size, out vec4 col, out float stretch) {
  float a = age - r.x * 0.25;
  stretch = 0.0; vel = vec3(0.0);
  if (a < 0.0 || a > 14.0) { p = o; size = 0.0; col = vec4(0.0); return false; }
  vec3 side = normalize(cross(aim, vec3(0.0, 1.0, 0.0)) + vec3(1e-4)); vec3 up2 = normalize(cross(side, aim));
  float ang = r.z * 6.2832, cone = 0.38 * sqrt(r.y);
  vec3 dir = normalize(aim + (side * cos(ang) + up2 * sin(ang)) * cone);
  float sp = (16.0 + 10.0 * r.w) * (0.7 + 0.3 * power);
  float k = 1.6;
  vec3 burst = dir * sp * (1.0 - exp(-k * a)) / k;
  float fall = max(0.0, a - 0.8);
  p = o + burst - vec3(0.0, 0.9 * fall + 0.4 * fall * exp(-fall), 0.0);
  p += vec3(sin(a * 2.3 + r.w * 9.0), 0.0, cos(a * 1.9 + r.z * 7.0)) * 0.6 * smoothstep(0.5, 2.0, a);
  size = 0.075;
  float spin = a * (6.0 + 8.0 * r.y) + r.w * 6.28;
  // (Safe flashes ON: a soft glint - a big near piece flipping full bright / dark 2-4 times a second fills a region)
  float glint = mix(0.35 + 0.65 * pow(abs(cos(spin)), 3.0), 0.75 + 0.25 * cos(spin), uSafe);
  vec3 cc = r.y < 0.33 ? c1 : r.y < 0.66 ? c2 : vec3(1.0, 0.86, 0.45);
  col = vec4(cc * glint * 1.3, 1.0 - smoothstep(11.0, 14.0, a));
  return p.y > -0.1 || a < 1.0;
}`;
const SPARK_MOTION = /* glsl */ `
bool motion(vec3 o, vec3 aim, float dur, float power, float mode, float age, vec4 r, vec3 c1, vec3 c2, out vec3 p, out vec3 vel, out float size, out vec4 col, out float stretch) {
  stretch = 1.0; vel = vec3(0.0, 1.0, 0.0); size = 0.0; col = vec4(0.0); p = o;
  vec3 g = vec3(0.0, -9.8, 0.0);
  if (mode > 9.75) {                      // comet fans / rows (shared/festivalFans.ts): one event = many comets; the slot's
    // particles are shared out - each comet a head + an ember trail. dur = spread * 4096 + comets * 64 + slot * 8 + slots - 1
    float kind = floor(mode); bool own = fract(mode) > 0.25;
    float w = dur; float S = mod(w, 8.0) + 1.0; w = floor(w / 8.0); float sp = mod(w, 8.0); w = floor(w / 8.0);
    float N = mod(w, 64.0); float q = floor(w / 64.0);
    float K = ceil((N - sp) / S);                         // comets this slot draws: sp, sp + S, sp + 2S …
    float ppc = floor(uPer / max(1.0, K));                // particles per comet
    float idx = floor(fract(aSlot) * uPer + 0.5);
    float c = floor(idx / max(1.0, ppc));
    if (K < 1.0 || c >= K || ppc < 2.0) return false;
    float k = idx - c * ppc;                              // 0 = the head, then its embers
    float j = sp + S * c;
    float u = N > 1.0 ? j / (N - 1.0) - 0.5 : 0.0;
    vec3 ad = normalize(aim);
    vec3 side = vec3(ad.y, -ad.x, 0.0);
    side = length(side) < 1e-3 ? vec3(1.0, 0.0, 0.0) : normalize(side);
    if (side.x < 0.0) side = -side;
    vec3 o2 = o, dir = ad;
    if (kind > 10.5 && kind < 11.5) o2 = o + vec3(u * q * 0.25, 0.0, 0.0);       // a row: comets from points along x
    else {
      float hsp = radians(q);
      float a = kind > 11.5 ? sign(u + 1e-6) * hsp * 0.5 * (0.5 + abs(u)) : u * hsp;
      dir = normalize(ad * cos(a) + side * sin(a));
    }
    float hj = fract(sin(j * 12.9898 + q * 0.17 + sp * 3.3) * 43758.5453);
    float life = 2.0 + 0.4 * hj;
    float lag = k * 0.035;                                // embers trail their head (a streak on camera)
    float a0 = age - hj * 0.06 - lag;
    if (a0 < 0.0 || a0 > life) return false;
    vec3 v0 = dir * (24.0 + 4.0 * power) * uScale * (0.96 + 0.08 * hj);
    p = o2 + v0 * a0 + 0.5 * g * a0 * a0 + (vec3(r.y, r.z, r.w) - 0.5) * lag * 2.2 + vec3(0.0, -0.6, 0.0) * lag * lag * 9.8;
    vel = v0 + g * a0;
    float f = 1.0 - a0 / life;
    bool head = k < 0.5;
    stretch = head ? 6.0 : 3.0;
    size = (head ? 0.2 : 0.07) * sqrt(max(0.25, uScale));
    vec3 hc = own ? c1 : mix(vec3(1.0, 0.92, 0.7), c1, 0.2), tc = own ? c2 : mix(vec3(1.0, 0.78, 0.45), c1, 0.2);
    float e = head ? 1.0 : 0.7 * (1.0 - k / (ppc + 1.0));
    // (Safe flashes ON: dimmer heads - a fan's comets sweeping through a region one after another flicker it)
    col = vec4((head ? hc : mix(hc, tc, min(1.0, k / 4.0))) * (2.2 + 2.4 * f) * e * mix(1.0, 0.55, uSafe), f * (head ? 1.0 : 0.9));
    return true;
  }
  if (mode < 0.5) {                       // gerb: a fountain of sparks while it burns
    float emit = r.x * dur; float a = age - emit; float life = 0.8 + 0.7 * r.y;
    if (a < 0.0 || a > life) return false;
    float ang = r.z * 6.2832, cone = 0.12 + 0.1 * r.w;
    vec3 v0 = vec3(cos(ang) * cone, 1.0, sin(ang) * cone) * (7.0 + 3.0 * r.y) * (0.7 + 0.3 * power);
    p = o + v0 * a + 0.5 * g * a * a; vel = v0 + g * a;
    size = 0.035; float f = 1.0 - a / life;
    col = vec4(mix(vec3(1.0, 0.95, 0.75), c1, 0.25) * (1.5 + 2.0 * f), f);
    return true;
  }
  if (mode < 1.5) {                       // comet: a bright head climbing with a trail of embers
    float lag = r.x * 0.5; float a = age - lag; if (a < 0.0 || a > 2.2) return false;
    vec3 v0 = normalize(aim) * (24.0 + 4.0 * power);
    p = o + v0 * a + 0.5 * g * a * a + (vec3(r.y, r.z, r.w) - 0.5) * lag * 1.2; vel = v0 + g * a;
    size = r.x < 0.06 ? 0.16 : 0.05; float f = (1.0 - a / 2.2) * (1.0 - r.x * 1.5);
    col = vec4(mix(vec3(1.0, 0.9, 0.6), c1, 0.3) * (2.0 + 2.0 * f), max(0.0, f));
    return f > 0.0;
  }
  if (mode < 4.5) {                       // waterfall: sparks dropping out of a hung line, a curtain while it burns
    float emit = r.x * dur; float a = age - emit; float life = 2.2 + 1.2 * r.y;
    if (a < 0.0 || a > life) return false;
    vec3 v0 = vec3((r.z - 0.5) * 0.8, -0.6 - 0.8 * r.w, (r.w - 0.5) * 0.5);
    vec3 gw = vec3(0.35, -4.2, 0.0);        // drag-limited fall + a little wind
    p = o + v0 * a + 0.5 * gw * a * a; vel = v0 + gw * a;
    size = 0.03; float f = 1.0 - a / life;
    float tw = 0.6 + 0.4 * sin(a * 31.0 + r.y * 40.0);
    col = vec4(mix(vec3(1.0, 0.82, 0.45), vec3(1.0, 0.97, 0.9), r.z) * (1.6 + 1.4 * f) * tw, f);
    return p.y > -0.05;
  }
  // mine: a spray of stars thrown at once from the mortar
  float a = age - r.x * 0.08; float life = 1.3 + 0.7 * r.y;
  if (a < 0.0 || a > life) return false;
  vec3 side = normalize(cross(aim, vec3(0.0, 0.0, 1.0)) + vec3(1e-4)); vec3 up2 = normalize(cross(side, aim));
  float ang = r.z * 6.2832, cone = 0.42 * sqrt(r.w);
  vec3 dir = normalize(aim + (side * cos(ang) + up2 * sin(ang)) * cone);
  float sp = (26.0 + 10.0 * r.y) * (0.75 + 0.25 * power), k = 1.1;
  p = o + dir * sp * (1.0 - exp(-k * a)) / k + 0.5 * vec3(0.0, -5.0, 0.0) * a * a; vel = dir * sp * exp(-k * a) + vec3(0.0, -5.0, 0.0) * a;
  size = 0.06; float f = 1.0 - a / life;
  col = vec4(mix(c1, vec3(1.0, 0.9, 0.7), 0.35) * (1.8 + 1.6 * f), f);
  return true;
}`;
const SHELL_MOTION = /* glsl */ `
float shellH(float mode, float power) { float h = fract(mode) * 400.0; return h > 1.0 ? h : 22.0 + 10.0 * power; }
float shellT(float h) { return clamp(0.55 + h / 42.0, 1.1, 3.4); }
vec3 shellPos(vec3 o, vec3 aim, float t, float h, float T) { float tt = clamp(t / T, 0.0, 1.0); return o + aim * h * (1.0 - (1.0 - tt) * (1.0 - tt)); }
bool motion(vec3 o, vec3 aim, float dur, float power, float mode, float age, vec4 r, vec3 c1, vec3 c2, out vec3 p, out vec3 vel, out float size, out vec4 col, out float stretch) {
  stretch = 1.0; vel = vec3(0.0, 1.0, 0.0); size = 0.0; col = vec4(0.0); p = o;
  float H = shellH(mode, power), T = shellT(H), m = floor(mode);
  if (age < T) {                          // the lift: a bright head + a trail of falling sparks behind it
    if (r.x > 0.08) return false;
    float lag = r.x < 0.01 ? 0.0 : r.y * 0.45;
    float t = age - lag; if (t < 0.0) return false;
    p = shellPos(o, aim, t, H, T) + vec3(r.z - 0.5, -0.5 * lag * lag * 9.8 * 0.3, r.w - 0.5) * lag * 1.5;
    vel = aim * 20.0; size = r.x < 0.01 ? 0.14 : 0.05;
    col = vec4(vec3(1.0, 0.82, 0.5) * (r.x < 0.01 ? 3.0 : 1.6 * (1.0 - lag / 0.45)), 1.0);
    return true;
  }
  float a = age - T;
  vec3 c0 = shellPos(o, aim, T, H, T);
  float scale = (0.65 + H / 260.0) * uScale;   // higher shells are (a little) bigger shells; a room's fxScale grows them
  vec3 dir;
  if (m > 2.5 && m < 3.5 && uShapeN > 1.0) {   // shaped: each particle flies to a point of the outline (facing +Z)
    int k = int(floor(r.z * uShapeN)); vec2 q = uShape[k];
    dir = vec3(q.x, q.y, (r.w - 0.5) * 0.12) * (0.92 + 0.1 * r.y);
  } else {
    float th = r.z * 6.2832, ph = acos(2.0 * r.w - 1.0);
    dir = vec3(sin(ph) * cos(th), cos(ph), sin(ph) * sin(th));
  }
  if (m > 5.5 && m < 6.5) {               // willow: long gold trails that droop and hang
    float life = 4.2 + 1.4 * r.y; if (a > life) return false;
    float R = (9.0 + 5.0 * power) * scale, k = 3.2;
    vec3 gg = vec3(0.0, -3.4, 0.0);
    p = c0 + dir * R * (1.0 - exp(-k * a)) + gg * a * a * 0.5; vel = dir * R * k * exp(-k * a) + gg * a;
    stretch = 3.0; size = 0.06 * sqrt(uScale); float f = 1.0 - a / life;
    col = vec4(vec3(1.0, 0.72, 0.32) * (0.9 + 1.6 * f) * (0.75 + 0.25 * sin(a * 9.0 + r.y * 20.0)) * smoothstep(0.03, 0.2, a), f);
    return true;
  }
  if (m > 6.5 && m < 7.5) {               // salute: a soft white burst of glitter (small, out of phase: not a flash)
    float life = 1.1 + 0.5 * r.y; if (a > life) return false;
    float R = (7.0 + 3.0 * power) * scale, k = 4.0;
    p = c0 + dir * R * (1.0 - exp(-k * a)); vel = dir * R * k * exp(-k * a);
    size = 0.09; float f = 1.0 - a / life;
    // (Safe flashes ON: no twinkle at all - a burst's stars stepping on / off 14 times a second, all re-rolled together,
    //  flicker a region past the governor's limits, which never see a star: a steady glow instead)
    float tw = mix(step(0.45, fract(sin(floor(a * 14.0) + r.y * 71.0) * 43758.5)), 0.55, uSafe);
    col = vec4(vec3(1.0, 0.98, 0.92) * (1.2 + 1.6 * f) * (0.35 + 0.65 * tw), f * smoothstep(0.0, 0.08, a));
    return true;
  }
  float life = 2.2 + 0.6 * r.y;
  if (a > life) return false;
  stretch = 3.2;                          // (stars streak along their flight from the burst instant: chrysanthemum trails)
  float R = (9.0 + 5.0 * power) * scale, k = 4.5;            // (a fast break: the stars leave the centre at once)
  vec3 gg = vec3(0.0, -2.2, 0.0);
  if (m > 7.5 && m < 8.5) {               // crossette: each star splits in two at 45 % of its life
    float ts = life * 0.45;
    vec3 d2 = normalize(cross(dir, vec3(0.3, 1.0, 0.2)) * (r.x > 0.5 ? 1.0 : -1.0) + dir * 0.3);
    vec3 at = c0 + dir * R * (1.0 - exp(-k * min(a, ts)));
    p = at + (a > ts ? d2 * R * 0.6 * (1.0 - exp(-k * (a - ts))) : vec3(0.0)) + gg * a * a * 0.5;
    vel = (a > ts ? d2 : dir) * R * k * exp(-k * a) + gg * a;
  } else {
    p = c0 + dir * R * (1.0 - exp(-k * a)) + gg * a * a * 0.5;
    vel = dir * R * k * exp(-k * a) + gg * a;
  }
  size = 0.06 * sqrt(uScale); float f = 1.0 - a / life;
  // (Safe flashes ON: no crackle / glitter stepping at all - a finale's sky full of stars stepping on / off 12-18 times a
  //  second flickers whole regions of the frame, and the governor never sees a star: a steady level instead)
  float crackle = a > life * 0.6 ? mix(step(0.5, fract(sin(floor(a * 18.0) + r.y * 91.0) * 43758.5)), 0.5, uSafe) : 1.0;
  float glit = m > 8.5 ? 0.4 + 0.6 * mix(step(0.5, fract(sin(floor(a * 12.0) + r.w * 57.0) * 43758.5)), 0.5, uSafe) : 1.0;
  // (the stars light up as they leave the centre: a packed cluster at the break instant read as a soft glowing ball)
  col = vec4(mix(c1, c2, r.y) * (1.6 + 1.5 * f) * crackle * glit * smoothstep(0.1, 0.32, a), f);
  return true;
}`;
const PARTICLE_FS_ADD = /* glsl */ `
uniform sampler2D uMap; varying vec2 vUv; varying vec4 vCol; varying float vSpin;
// (the blend multiplies by alpha once: the colour goes out un-premultiplied with alpha = the sprite's coverage;
// a soft root keeps a 2-pixel far star bright)
void main() { float a = pow(texture2D(uMap, vUv).a, 0.6) * vCol.a; gl_FragColor = vec4(vCol.rgb, a); }`;
const PARTICLE_FS_SMOKE = /* glsl */ `
uniform sampler2D uMap; uniform float uPer; varying vec2 vUv; varying vec4 vCol; varying float vSpin;
// (more particles on higher tiers = finer smoke, not thicker: each one is fainter, ~2x Low's density at High)
void main() { float a = texture2D(uMap, vUv).a * vCol.a * min(1.0, pow(14.0 / max(1.0, uPer), 0.75)); gl_FragColor = vec4(vCol.rgb, a); }`;
const PARTICLE_FS_FLAT = /* glsl */ `
varying vec2 vUv; varying vec4 vCol; varying float vSpin;
void main() { gl_FragColor = vec4(vCol.rgb, vCol.a); }`;

/** One GPU particle system with `slots` event slots. */
class Particles {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private U: Record<string, THREE.IUniform>;
  set safe(v: boolean) { this.U.uSafe.value = v ? 1 : 0; }
  /** the size of the bursts (shells: a room's fxScale) */
  set scale(v: number) { this.U.uScale.value = v; }
  private slots: (PyroEvent | null)[];
  readonly per: number;
  private readonly S: number;
  constructor(name: string, total: number, motion: string, fs: string, additive: boolean, map: boolean, quad = 1, slots = SLOTS, gain = 1) {
    this.S = slots; this.slots = Array(slots).fill(null);
    this.per = Math.max(4, Math.floor(total / slots));
    const n = this.per * slots;
    const q = new THREE.PlaneGeometry(quad, quad);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = q.index; this.geo.setAttribute('position', q.getAttribute('position'));
    const rand = new Float32Array(n * 4), slot = new Float32Array(n);
    let s = 1234567;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 16777216; };
    // (the slot + this particle's index in it / per: int(aSlot) is the slot, the fraction lets a comet fan share the
    //  slot's particles out among its comets - every other mode reads only the slot)
    for (let i = 0; i < n; i++) { slot[i] = Math.floor(i / this.per) + (i % this.per) / this.per; for (let k = 0; k < 4; k++) rand[i * 4 + k] = rnd(); }
    this.geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rand, 4));
    this.geo.setAttribute('aSlot', new THREE.InstancedBufferAttribute(slot, 1));
    this.geo.instanceCount = n;
    const v4 = () => Array.from({ length: slots }, () => new THREE.Vector4(0, 0, 0, -1e6));
    this.U = { uSafe: { value: 1 }, uScale: { value: 1 }, uGain: { value: gain }, uMinAng: { value: additive ? 0.0026 : 0 }, uTime: { value: 0 }, uA: { value: v4() }, uB: { value: v4() }, uC: { value: v4() }, uD: { value: v4() }, uShape: { value: Array.from({ length: 64 }, () => new THREE.Vector2()) }, uShapeN: { value: 0 }, uPer: { value: this.per }, uMap: { value: softSprite() } };
    const mat = fxMaterial(PARTICLE_VS(motion, slots), fs, this.U, { additive, side: THREE.DoubleSide });
    if (!map) delete (mat.uniforms as Record<string, unknown>).uMap;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false; this.mesh.name = name; this.mesh.renderOrder = additive ? 13 : 8;
    if (additive) glow(this.mesh);
    q.dispose();
  }
  /** is this event already placed (its uniforms are set once) - or was it given up for a newer one */
  has(key: string) { return this.dropped.has(key) || this.slots.some((x) => x?.key === key); }
  private dropped = new Set<string>();
  /** put an event in a slot (an already-placed key keeps its slot); old finished events are replaced first */
  place(e: PyroEvent, now: number, life: number) {
    let i = this.slots.findIndex((x) => x?.key === e.key);
    if (i < 0) {
      // a free slot = one whose event has run its own life; full: the event with the least time left gives way (never
      // the one bursting now for one that is only lifting), and the evicted one stays dropped (no slot thrash)
      e.end = e.t0 + (e.span ?? e.dur) + life;
      i = this.slots.findIndex((x) => !x || now > (x.end ?? x.t0 + (x.span ?? x.dur) + life));
      if (i < 0) {
        let old = 0; for (let k = 1; k < this.S; k++) if ((this.slots[k]!.end ?? 0) < (this.slots[old]!.end ?? 0)) old = k;
        if ((this.slots[old]!.end ?? 0) > e.end) return;            // everything in flight outlives this one: skip it
        this.dropped.add(this.slots[old]!.key); i = old;
        if (this.dropped.size > 400) { let k = 0; for (const x of this.dropped) { this.dropped.delete(x); if (++k > 200) break; } }
      }
      if (this.dropped.has(e.key)) return;
      this.slots[i] = e;
      (this.U.uA.value as THREE.Vector4[])[i].set(e.pos.x, e.pos.y, e.pos.z, e.t0);
      (this.U.uB.value as THREE.Vector4[])[i].set(e.aim.x, e.aim.y, e.aim.z, e.dur);
      (this.U.uC.value as THREE.Vector4[])[i].set(e.color.r, e.color.g, e.color.b, e.power);
      (this.U.uD.value as THREE.Vector4[])[i].set(e.color2.r, e.color2.g, e.color2.b, e.mode);
    }
  }
  setShape(pts: number[] | null) {
    const arr = this.U.uShape.value as THREE.Vector2[];
    const n = pts ? Math.min(64, pts.length / 2) : 0;
    for (let i = 0; i < n; i++) arr[i].set(pts![i * 2], pts![i * 2 + 1]);
    this.U.uShapeN.value = n;
  }
  tick(now: number) { this.U.uTime.value = now; }
  get active() { return this.slots.filter((s) => s && (this.U.uTime.value as number) - s.t0 < (s.span ?? s.dur) + 15).length; }
  clear() { this.dropped.clear(); this.slots.fill(null); for (const v of this.U.uA.value as THREE.Vector4[]) v.w = -1e6; }
  dispose() { this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

// ---------------------------------------------------------------------------------------------------- flames
// Flame cannons as real stage flame-jets fire them (the owner: "like puffs of flame at actual raves"): every shot is a
// burst of rolling fireballs - each one a camera-facing billboard shaded as a turbulent sphere (two noise octaves bend
// its edge and its temperature): it shoots up with drag (~8 m in a quarter second at fxScale 1), billows and grows as it
// rises, cools from a white-yellow core through orange-red edges to dark sooty tips and ends as a thin smoke wisp, ~0.7-1 s
// in all. A short hit = a puff (one big ball + trailing ones); a held hit = a column (a stream of balls); a tilted anchor
// fires along its own +Y (crossfire). Pure GPU particles in a ring of slots: the CPU writes one slot per ball when it is
// fired, the vertex shader moves it (drag + buoyancy), nothing else per frame. Premultiplied blending: the fire adds
// light, the soot darkens (the canvas alpha is untouched - an OBS page stays transparent where it was).
const PUFF_VS = /* glsl */ `
attribute vec4 aA;   // spawn x, y, z (room frame), birth (s)
attribute vec4 aB;   // velocity x, y, z (m/s), life (s)
attribute vec4 aC;   // size at birth, size at death (m), seed, style (1 green)
uniform float uTime;
varying vec2 vUv; varying float vAge; varying float vSeed; varying float vStyle;
void main() {
  float age = uTime - aA.w, u = age / max(0.05, aB.w);
  vAge = u; vSeed = aC.z; vStyle = aC.w;
  if (u < 0.0 || u > 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vUv = vec2(0.0); return; }
  const float K = 3.4;                                       // drag: a ball's rise tops out at v / K
  vec3 p = aA.xyz + aB.xyz * (1.0 - exp(-K * age)) / K + vec3(0.0, 1.6 * age * age, 0.0);   // + buoyancy late
  float sz = mix(aC.x, aC.y, 1.0 - pow(1.0 - u, 3.0));   // (grows fast: a ball reads at once, even from the back of the field)
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float ang = aC.z * 6.2832 + age * (fract(aC.z * 7.3) - 0.5) * 1.6;
  vec2 q = position.xy;
  q = vec2(q.x * cos(ang) - q.y * sin(ang), q.x * sin(ang) + q.y * cos(ang));
  vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz + (right * q.x + up * q.y) * sz;
  vUv = position.xy * 2.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const PUFF_FS = /* glsl */ `
uniform float uTime; uniform float uGain; uniform float uNoiseK;
varying vec2 vUv; varying float vAge; varying float vSeed; varying float vStyle;
${NOISE_GLSL}
void main() {
  float r = length(vUv);
  if (r > 1.0 || vAge <= 0.0) discard;
  float u = vAge, un = vAge * uNoiseK;                      // (un: the billows' own clock - Safe flashes ON: slower)
  // a turbulent ball: the edge and the heat bent by two noise octaves rolling upward through it
  vec2 w = vUv * vec2(1.0, 0.9);
  float n1 = fbm3(vec3(w * 1.7 + vec2(0.0, -un * 2.2), vSeed * 17.0 + un * 1.8));
  float n2 = fbm3(vec3(w * 4.3 + vec2(vSeed * 3.1, -un * 5.0), vSeed * 5.0 + un * 3.6));
  // billows: the cauliflower lobes of a real fireball (ridged noise: dark creases between bright rolls)
  float b1 = 1.0 - abs(2.0 * fbm3(vec3(w * 3.1 + vec2(1.7, -un * 3.5), vSeed * 9.0 + un * 2.4)) - 1.0);
  float b2 = 1.0 - abs(2.0 * fbm3(vec3(w * 7.3 + vec2(vSeed, -un * 6.0), vSeed * 3.0 + un * 4.2)) - 1.0);
  float d = r + (n1 - 0.5) * 0.85 + (n2 - 0.5) * 0.35 - (b1 - 0.5) * 0.25;
  float body = smoothstep(1.0, 0.5, d);
  float core = smoothstep(0.7, 0.0, d + u * 0.35);
  // temperature: hot early and in the middle, cooling with age; the rolling edge cools first
  float T = clamp(core * 1.35 * (1.0 - u * 1.05) + body * 0.5 * (1.0 - u * 1.5) + (n2 - 0.5) * 0.25, 0.0, 1.3);
  // (kept under the bloom's white-out: a ball keeps its yellow core, orange body and red edge on camera)
  vec3 fire = T > 0.85 ? mix(vec3(1.0, 0.66, 0.24), vec3(1.0, 0.84, 0.5), (T - 0.85) / 0.45) * 1.2
    : T > 0.55 ? mix(vec3(1.0, 0.34, 0.05), vec3(1.0, 0.66, 0.24), (T - 0.55) / 0.3) * 1.15
    : T > 0.25 ? mix(vec3(0.5, 0.07, 0.01), vec3(1.0, 0.34, 0.05), (T - 0.25) / 0.3) * 1.05
    : vec3(0.3, 0.035, 0.01) * T * 3.0;
  if (vStyle > 0.5) fire = vec3(fire.g * 0.35, fire.r * 1.05 + fire.g * 0.2, fire.b * 0.6 + fire.r * 0.08);   // barium-green fluid
  float flame = body * smoothstep(0.06, 0.3, T) * (0.45 + 0.75 * b1 * (0.7 + 0.3 * b2));   // (lobes bright, creases dark)
  // soot: the cool rolling edge of a ball, darker and denser as it ages; ends as a thin grey wisp
  // (the rim only: soot over the middle of a ball read as grey holes where balls overlap)
  float soot = body * (1.0 - smoothstep(0.05, 0.55, core)) * smoothstep(0.32, 0.05, T) * smoothstep(0.35, 0.65, u) * (1.0 - smoothstep(0.8, 1.0, u));   // (older = higher balls: soot at the tips)
  vec3 smoke = mix(vec3(0.02, 0.016, 0.012), vec3(0.11, 0.1, 0.095), smoothstep(0.85, 1.0, u));
  float a = soot * mix(0.55, 0.2, smoothstep(0.5, 1.0, u));
  float pop = smoothstep(0.0, 0.06, u);                     // (no single-frame pop: a ball eases in over ~50 ms)
  // premultiplied: colour x coverage, alpha = the fire's own coverage (its emission) over the soot's - a transparent OBS
  // page keeps the fire (alpha 0 dropped it) and un-premultiplies it right; the soot darkens what is behind it
  vec3 emit = fire * flame * 0.8 * uGain;
  float af = clamp(max(max(emit.r, emit.g), emit.b), 0.0, 1.0);
  gl_FragColor = vec4((emit * (1.0 - a) + smoke * a) * pop, (af + a * (1.0 - af)) * pop);
}`;

/** The fireballs' blend: premultiplied colour AND alpha (One / OneMinusSrcAlpha both) - the shader writes colour x
 *  coverage and its coverage, so a transparent OBS page composites them like the opaque studio view. */
export function puffBlend(m: THREE.ShaderMaterial): THREE.ShaderMaterial {
  m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation; m.blendEquationAlpha = THREE.AddEquation;
  m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
  m.premultipliedAlpha = true;
  return m;
}

const PC = new THREE.Color();
interface FlameHead { f: Fixture; level: number; height: number; seed: number; style: number; dir: THREE.Vector3; shots: number; gate: HeadGate }

export interface PyroFrame { now: number; tint: THREE.Color; tint2: THREE.Color }

export class Pyro {
  readonly group = new THREE.Group();
  readonly co2: Particles; readonly confetti: Particles; readonly sparks: Particles; readonly shells: Particles;
  private flames: FlameHead[] = [];
  private flameMesh: THREE.Mesh | null = null;
  private puffA: Float32Array; private puffB: Float32Array; private puffC: Float32Array; private puffN = 0; private puffI = 0;
  /** the shared page clock at this frame (s): every ball is born on it (every page fires the same balls) */
  private pT = 0;
  /** the balls' size scale (fxScale + the root of flameScale) and the fire's exposure now */
  private zS = 1; private gainNow = 1;
  /** the shot decisions (flameShots.ts): per-head gates + the stage's volleys */
  private gate = new ShotGate(); private shotOut = newShotOut();
  private pools: THREE.InstancedMesh | null = null;
  /** warm light on camera from the flames now (0..1) */
  heat = 0;
  private disposables: { dispose(): void }[] = [];

  constructor(fixtures: Fixture[], tier: Tier, private readonly fxScale = 1, boost = 1, private readonly flameWidth = 1, shellScale: number | null = null, private readonly flameScale = 1) {
    this.group.name = 'festival:pyro';
    const B = FESTIVAL_BUDGET[tier];
    this.co2 = new Particles('festival:co2', B.co2 * boost, CO2_MOTION, PARTICLE_FS_SMOKE, false, true);
    this.confetti = new Particles('festival:confetti', B.confetti * boost, CONFETTI_MOTION, PARTICLE_FS_FLAT, false, false, 1);
    this.sparks = new Particles('festival:sparks', B.sparks * boost, SPARK_MOTION, PARTICLE_FS_ADD, true, true, 1, 32, 1.0);
    // (more shells at once on a boosted room, not denser ones: a chrysanthemum is ~60-90 streaking stars)
    this.shells = new Particles('festival:shells', Math.min(B.firework * boost, 90 * 48), SHELL_MOTION, PARTICLE_FS_ADD, true, true, 1, 48, 2.0);
    this.shells.scale = shellScale ?? Math.pow(fxScale, 0.9);
    // (comet fans: launch speed with the root of the room's effect scale; the rig sets it from the stage's height)
    this.sparks.scale = Math.sqrt(Math.max(0.25, fxScale));
    for (const p of [this.co2, this.confetti, this.sparks, this.shells]) { this.group.add(p.mesh); this.disposables.push(p); }
    const fl = fixtures.filter((f) => f.kind === 'flame');
    // (a tilted anchor fires along its own +Y: crossfire cannons)
    this.flames = fl.map((f) => ({ f, level: 0, height: 0, seed: f.geo.seed, style: 0, shots: 0, gate: newHeadGate(), dir: new THREE.Vector3(0, 1, 0).applyQuaternion(f.quat).normalize() }));
    this.headList = this.flames.map((h) => h.f);
    // the ball ring: ~14 live balls per head (a column at full rate), a budget per tier
    this.puffN = Math.max(64, Math.min(1536, fl.length * (tier === 'low' ? 6 : tier === 'medium' ? 10 : 14)));
    this.puffA = new Float32Array(this.puffN * 4); this.puffB = new Float32Array(this.puffN * 4); this.puffC = new Float32Array(this.puffN * 4);
    for (let i = 0; i < this.puffN; i++) { this.puffA[i * 4 + 3] = -1e6; this.puffB[i * 4 + 3] = 1; }
    if (fl.length) {
      const base = new THREE.PlaneGeometry(1, 1);
      const g = new THREE.InstancedBufferGeometry(); g.index = base.index; g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('aA', new THREE.InstancedBufferAttribute(this.puffA, 4)); g.setAttribute('aB', new THREE.InstancedBufferAttribute(this.puffB, 4)); g.setAttribute('aC', new THREE.InstancedBufferAttribute(this.puffC, 4));
      g.instanceCount = this.puffN;
      const m = puffBlend(fxMaterial(PUFF_VS, PUFF_FS, { uTime: { value: 0 }, uGain: { value: 1 }, uNoiseK: { value: 1 } }, { side: THREE.DoubleSide }));
      this.flameMesh = new THREE.Mesh(g, m);
      this.flameMesh.frustumCulled = false; this.flameMesh.renderOrder = 12; this.flameMesh.name = 'festival:flames';
      glow(this.flameMesh); this.group.add(this.flameMesh); this.disposables.push(g, base, m);
      // warm pools on the floor under each flame head
      const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
      const pm = fxMaterial(/* glsl */ `varying vec2 vUv; varying vec3 vCol; void main() { vUv = uv; vCol = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
        /* glsl */ `varying vec2 vUv; varying vec3 vCol; void main() { float r = length(vUv - 0.5) * 2.0; float a = exp(-r * r * 3.0) * smoothstep(1.0, 0.8, r); gl_FragColor = vec4(vCol * a, a); }`, {});
      pm.polygonOffset = true; pm.polygonOffsetFactor = -2; pm.polygonOffsetUnits = -2;
      this.pools = new THREE.InstancedMesh(pg, pm, fl.length);
      this.pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(fl.length * 3), 3);
      fl.forEach((f, i) => this.pools!.setMatrixAt(i, new THREE.Matrix4().compose(f.pos.clone().add(new THREE.Vector3(0, 0.04, 0)), new THREE.Quaternion(), new THREE.Vector3(7, 1, 7))));
      this.pools.frustumCulled = false; this.pools.renderOrder = 9; this.pools.name = 'festival:flame-pools';
      this.group.add(this.pools); this.disposables.push(pg, pm);
    }
  }

  get flameCount() { return this.flames.length; }
  /** the page-seconds origin moved: forget the shot times (Safe ON's gates would wait for the old clock) and the
   *  fireballs in flight */
  rebase() {
    this.gate = new ShotGate();
    for (const h of this.flames) { h.gate = newHeadGate(); h.level = 0; }
    for (let i = 0; i < this.puffN; i++) this.puffA[i * 4 + 3] = -1e6;
    if (this.flameMesh) (this.flameMesh.geometry.getAttribute('aA') as THREE.InstancedBufferAttribute).needsUpdate = true;
  }
  /** Safe flashes ON: soft confetti glints, no particles right at the lens */
  set safe(v: boolean) { this.isSafe = v; for (const p of [this.co2, this.confetti, this.sparks, this.shells]) p.safe = v; }
  private isSafe = true;
  /** a flame head's level now (0..1.5) and whether it burns green */
  levelOf(i: number) { return this.flames[i]?.level ?? 0; }
  greenOf(i: number) { return (this.flames[i]?.style ?? 0) % 2 === 1; }

  /** flame heads: target per head (0..1.5 power, from the director's flame hits) + style per head (1 green, 2 hero
   *  20 m column, 3 both); attack 30 ms, release towards the target */
  flame(targets: Float32Array, dt: number, now: number, styles?: Float32Array) {
    if (!this.flameMesh) return;
    const step = Math.min(0.25, Math.max(0, dt));
    // (births and gates run on the SHARED page clock `now`: every page fires the same balls, also after a stall)
    this.pT = now;
    const S = Math.pow(this.fxScale, 0.8) * this.flameScale, W = this.flameWidth;
    this.zS = Math.pow(this.fxScale, 0.8) * Math.sqrt(this.flameScale);
    let heat = 0, wrote = false;
    for (let i = 0; i < this.flames.length; i++) {
      const h = this.flames[i];
      const t = targets[i] ?? 0;
      // the light envelope (the floor glow, the fire lights, the camera's warmth): attack 30 ms, release towards the
      // target - the governed level; the visible fire below is fired from the same targets
      h.level = t > h.level ? h.level + (t - h.level) * Math.min(1, step / 0.03) : t + (h.level - t) * Math.exp(-step / 0.12);
      const p = h.level;
      const sty = styles ? styles[i] : 0;
      if (t > 0.01 || p < 0.02) h.style = sty;                    // (a column keeps its style while it dies down)
      const hero = h.style >= 2 ? 1 : 0, green = h.style % 2;
      // a fresh hit = a shot (one big ball + three trailing); a held hit = a column (Safe flashes OFF) or a re-fire;
      // Safe flashes ON: one shot per head per 0.9 s, the stage in volleys (flameShots.ts ShotGate)
      const d = this.gate.step(h.gate, t, now, step, this.isSafe, hero ? 24 : 15, this.shotOut);
      if (d.kind === 'shot') { this.shot(h, Math.min(1.5, t), hero, green, S, W); wrote = true; }
      else if (d.kind === 'column') for (let k = 0; k < d.n; k++) { h.shots++; this.ball(h, Math.min(1.5, t), hero, green, S, W, 0.8 + 0.25 * hash3(h.seed * 31, h.shots, 1), 0, 0.85); wrote = true; }
      const k = Math.min(1, p) * 0.55;
      this.pools!.setColorAt(i, green ? PC.setRGB(0.15 * k, 1.0 * k, 0.1 * k) : PC.setRGB(1.0 * k, 0.45 * k, 0.1 * k));
      heat = Math.max(heat, Math.min(1, p));
    }
    this.heat = heat;
    // the fire's exposure: many balls at once (a whole row on a big hit) share a light budget - a bloom white-out of the
    // frame on the drop is a flash; fewer balls each read at full strength (Safe flashes ON: a smaller budget)
    let live = 0;
    for (let j = 0; j < this.puffN; j++) { const age = now - this.puffA[j * 4 + 3]; if (age >= 0 && age < this.puffB[j * 4 + 3]) live++; }
    const want = Math.min(1, Math.max(this.isSafe ? 0.2 : 0.3, (this.isSafe ? 30 : 40) / Math.max(1, live)));
    this.gainNow += (want - this.gainNow) * Math.min(1, step / (want < this.gainNow ? 0.05 : 0.4));
    const U = (this.flameMesh.material as THREE.ShaderMaterial).uniforms;
    U.uTime.value = now; U.uGain.value = this.gainNow; U.uNoiseK.value = this.isSafe ? 0.5 : 1;   // (Safe flashes ON: the billows roll at half speed - fewer bright lobes a second)
    if (wrote) for (const n of PUFF_ATTRS) (this.flameMesh.geometry.getAttribute(n) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.pools!.instanceColor!.needsUpdate = true;
  }

  /** one shot of a flame cannon: the big ball + three trailing ones, a few hundredths of a second apart */
  private shot(h: FlameHead, power: number, hero: number, green: number, S: number, W: number) {
    h.shots++;
    this.ball(h, power, hero, green, S, W, 1.0, 0, 1.0);
    for (let k = 1; k <= 3; k++) this.ball(h, power, hero, green, S, W, 1 - 0.16 * k, 0.03 * k, 1 - 0.12 * k);
  }

  /** one fireball into the ring (deterministic from the head + its shot count: every page fires the same ball) */
  private ball(h: FlameHead, power: number, hero: number, green: number, S: number, W: number, speed: number, delay: number, size: number) {
    const i = this.puffI; this.puffI = (i + 1) % this.puffN;
    const s1 = h.seed * 977, s2 = h.shots * 13 + Math.round(delay * 1000), s3 = Math.round(speed * 100);
    const r = (k: number) => hash3(s1 + k, s2, s3);
    const d = h.dir, pw = Math.sqrt(Math.max(0.7, power));   // (a light hit is still a full shot: it reads from the field)
    const vy = 27 * S * pw * speed * (hero ? 1.3 : 1) * (0.92 + 0.16 * r(1));
    const side = 0.12 * vy, A = this.puffA, B = this.puffB, C = this.puffC, o = i * 4;
    A[o] = h.f.pos.x + d.x * 0.3 + (r(2) - 0.5) * 0.3; A[o + 1] = h.f.pos.y + d.y * 0.3; A[o + 2] = h.f.pos.z + d.z * 0.3 + (r(3) - 0.5) * 0.3; A[o + 3] = this.pT + delay;
    B[o] = d.x * vy + (r(4) - 0.5) * side; B[o + 1] = d.y * vy; B[o + 2] = d.z * vy + (r(5) - 0.5) * side; B[o + 3] = (hero ? 1.1 : 0.85) * (0.85 + 0.3 * r(6));
    C[o] = 0.9 * this.zS * W * size; C[o + 1] = 3.3 * this.zS * W * size * (hero ? 1.35 : 1) * (0.85 + 0.3 * r(7)); C[o + 2] = r(8); C[o + 3] = green;
  }

  /** flame heads in the room frame (for the scheduler: sides, shapes) - the same array every frame */
  get heads() { return this.headList; }
  private headList: Fixture[] = [];

  tick(now: number) { this.co2.tick(now); this.confetti.tick(now); this.sparks.tick(now); this.shells.tick(now); }

  dispose() { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}
