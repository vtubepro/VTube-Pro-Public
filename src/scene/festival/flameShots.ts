// Flame cannons, the decisions (pure: src/scene/festival/pyro.ts draws them, stageRig.ts picks the heads, the units
// check them - tools/festival_flame_unit.ts, tools/festival_gov_unit.ts):
//   flamePattern  which heads of a row (sorted left -> right) a hit without its own chase fires (festival.flamePatterns):
//                 the bar picks centre-out pairs, L->R, R->L or every 4th; the beat steps through it
//   ShotGate      when a head fires: a fresh hit = a shot, a held hit = a column (Safe flashes OFF) or a re-fire every
//                 1.8 s; Safe flashes ON: at most one shot per head per 0.9 s and the whole stage fires in VOLLEYS (every
//                 head firing in a frame fires together), at most one volley per 0.7 s. All times are the SHARED page
//                 clock (the spacing holds at any frame rate and through a stall; which head of a chase leads a volley
//                 can differ by a frame between pages)
//   ballLight     a fireball's drawn light over its life (0..1, the shader's envelope): the governor unit's model

/** Indexes (into a row sorted by x) a pattern hit fires at this beat; writes into `out` (no allocation). */
export function flamePattern(n: number, beat: number, out: number[]): number[] {
  out.length = 0;
  if (n <= 0) return out;
  const b = Math.floor(beat + 1e-3), pat = ((Math.floor(b / 4) % 4) + 4) % 4;
  if (pat === 0) { const pairs = Math.ceil(n / 2), r = ((b % pairs) + pairs) % pairs; add(out, n, Math.floor((n - 1) / 2) - r); add(out, n, Math.ceil((n - 1) / 2) + r); }
  else if (pat === 1) { const j = ((b * 2) % n + n) % n; add(out, n, j); add(out, n, (j + 1) % n); }
  else if (pat === 2) { const j = ((b * 2) % n + n) % n; add(out, n, n - 1 - j); add(out, n, n - 1 - ((j + 1) % n)); }
  else { const q = Math.min(4, n), o = ((b % q) + q) % q; for (let i = o; i < n; i += 4) add(out, n, i); }   // (a short row: never an offset past its end)
  return out;
}

const add = (out: number[], n: number, i: number) => { if (i >= 0 && i < n && !out.includes(i)) out.push(i); };

export interface HeadGate { prevT: number; held: number; lastShot: number; acc: number }
export const newHeadGate = (): HeadGate => ({ prevT: 0, held: 0, lastShot: -1e9, acc: 0 });
/** a head's decision this frame (the caller owns it: no allocation per head per frame) */
export interface ShotOut { kind: 'shot' | 'column' | 'none'; n: number }
export const newShotOut = (): ShotOut => ({ kind: 'none', n: 0 });
const put = (o: ShotOut, kind: ShotOut['kind'], n: number) => { o.kind = kind; o.n = n; return o; };

/** Per-frame flame decisions on the shared clock. */
export class ShotGate {
  lastVolley = -1e9; private volleyAt = NaN;
  /** Safe flashes ON: shot spacing per head (fresh / held) and between volleys (s) */
  static readonly HEAD = 0.9; static readonly HELD = 1.8; static readonly VOLLEY = 0.7;
  /** what head `h` does this frame, written into `out` (returned): 'shot', 'column' (n balls to stream), or 'none'.
   *  t = its target (0..1.5) */
  step(h: HeadGate, t: number, now: number, dt: number, safe: boolean, columnRate: number, out: ShotOut): ShotOut {
    // (a clock that jumped back - a rebase, a test page's manual time - never holds the gates shut; only a jump bigger
    //  than the volley spacing heals, so a clock creeping backwards still fires at most one volley per 0.7 s)
    if (now < h.lastShot - ShotGate.VOLLEY) h.lastShot = -1e9;
    if (now < this.lastVolley - ShotGate.VOLLEY) this.lastVolley = -1e9;
    const fresh = t > 0.25 && t - h.prevT > 0.2;
    h.held = t > 0.25 ? h.held + dt : 0;
    h.prevT = t;
    if (safe) {
      if (t > 0.25 && (fresh || h.held > 0.6) && now - h.lastShot >= (fresh ? ShotGate.HEAD : ShotGate.HELD)
        && (now - this.lastVolley >= ShotGate.VOLLEY || this.volleyAt === now)) {
        if (this.volleyAt !== now) { this.volleyAt = now; this.lastVolley = now; }
        h.lastShot = now; h.acc = 0;
        return put(out, 'shot', 1);
      }
      return put(out, 'none', 0);
    }
    if (fresh) { h.lastShot = now; h.acc = 0; return put(out, 'shot', 1); }
    if (t > 0.25 && h.held > 0.6) {
      h.acc += dt * columnRate * Math.min(1.2, t);
      const n = Math.floor(h.acc); h.acc -= n;
      return n > 0 ? put(out, 'column', n) : put(out, 'none', 0);
    }
    return put(out, 'none', 0);
  }
}

/** A fireball's drawn light at age `a` of `life` s (0..1): eases in over ~50 ms, cools away (the shader's envelope). */
export function ballLight(a: number, life: number): number {
  if (a < 0 || a > life) return 0;
  const u = a / life, pop = Math.min(1, u / 0.06);
  return pop * Math.pow(Math.max(0, 1 - u * 1.05), 1.5);
}
