// The Trail v2 — the meme director (DESIGN_V2.md §7): every 25–55 s of play something silly happens. 70 % common,
// 25 % rare, 5 % legendary. Memes never kill, never soft-lock and last ≤ 12 s. A deck may re-word them or add its own
// (`memes2` in deck.json, theme flavour lives there, not in code); `k` picks one of the engine's effects below.
import type { V3 } from '../../../../shared/trail/levels.ts';
import type { MemeDef } from '../../../../shared/trail/types.ts';
import type { SimCtx } from './ctx.ts';
import type { Ent } from './world.ts';

export const MEME_KINDS = ['hop', 'sneeze', 'bighead', 'confetti', 'sound', 'npc', 'duck', 'floaty', 'buzz', 'fakedeath', 'wish', 'kaiju', 'grave'] as const;
const BUILTIN: MemeDef[] = [
  { id: 'hop', tier: 'common', k: 'hop', text: 'The {wagon} did a little hop. Nobody knows why.' },
  { id: 'sneeze', tier: 'common', k: 'sneeze', text: 'A crate sneezed.' },
  { id: 'bighead', tier: 'common', k: 'bighead', text: '{name}\'s head is… bigger?' },
  { id: 'confetti', tier: 'common', k: 'confetti', text: '{name} deserves confetti. For nothing in particular.' },
  { id: 'honk', tier: 'common', k: 'sound', text: 'Somewhere, a goose honks.' },
  { id: 'passerby', tier: 'common', k: 'npc', text: 'A stranger walks by: "Nice {wagon}." Then keeps walking.' },
  { id: 'duck', tier: 'rare', k: 'duck', text: 'A GIANT RUBBER DUCK falls from the sky.' },
  { id: 'floaty', tier: 'rare', k: 'floaty', text: 'Gravity took the afternoon off.' },
  { id: 'buzz', tier: 'rare', k: 'buzz', text: 'Everyone who talks now buzzes.' },
  { id: 'fakedeath', tier: 'rare', k: 'fakedeath', text: '{name} has died of dysentery. …Just kidding.' },
  { id: 'wish', tier: 'legendary', k: 'wish', text: 'A tiny frog grants the party one wish: +50 lbs of food.' },
  { id: 'kaiju', tier: 'legendary', k: 'kaiju', text: 'Something ENORMOUS just walked past on the horizon.' },
  { id: 'grave', tier: 'legendary', k: 'grave', text: 'The grave of {grave} starts singing as you roll past.' },
];

export class MemeDirector {
  private next = 30;
  private table: MemeDef[];
  private ends: { at: number; undo: () => void; world: unknown }[] = [];
  private buzzUntil = 0;
  private buzzAt = new Map<string, number>();
  constructor(private c: SimCtx) {
    const own = c.deck.memes2 ?? [];
    const byId = new Map(BUILTIN.map((m) => [m.id, m]));
    for (const m of own) if (MEME_KINDS.includes(m.k as never)) byId.set(m.id, { ...byId.get(m.id), ...m });
    this.table = [...byId.values()];
    this.next = c.misc.range(20, 35);
  }
  /** One step while the party is out on the journey or in camp (`quiet` = hold off: a mini-scene or a big card). */
  step(dt: number, quiet: boolean, voice: Record<string, { vad: number }>) {
    const c = this.c;
    for (const e of [...this.ends]) if (c.time >= e.at) { if (e.world === c.phys) e.undo(); this.ends = this.ends.filter((x) => x !== e); }
    if (c.time < this.buzzUntil) for (const p of c.active()) {
      if ((voice[p.id]?.vad ?? 0) > 0.3 && c.time - (this.buzzAt.get(p.id) ?? 0) > 0.7) { this.buzzAt.set(p.id, c.time); c.emit({ e: 'sound', s: 'buzz', at: c.phys.feet(p) }); }
    }
    this.next -= dt;
    if (this.next > 0 || quiet) return;
    this.next = c.misc.range(25, 55);
    this.fire();
  }
  /** Roll + play one meme (tests may force an id). */
  fire(id?: string) {
    const c = this.c;
    const roll = c.misc.next();
    const tier = roll < 0.05 ? 'legendary' : roll < 0.3 ? 'rare' : 'common';
    let pool = id ? this.table.filter((m) => m.id === id) : this.table.filter((m) => m.tier === tier);
    if (!pool.length) pool = this.table.filter((m) => m.tier === 'common');
    let m = c.misc.pick(pool);
    const ps = c.active();
    const who = ps.length ? c.misc.pick(ps) : null;
    const grave = [...c.run.oldGraves, ...c.run.graves].sort((a, b) => Math.abs(a.mile - c.run.miles) - Math.abs(b.mile - c.run.miles))[0];
    if (m.k === 'grave' && !grave) m = this.table.find((x) => x.k === 'wish') ?? m;
    if ((m.k === 'bighead' || m.k === 'confetti' || m.k === 'fakedeath') && !who) m = this.table.find((x) => x.k === 'hop') ?? m;
    const J = c.journey;
    let at: V3 | undefined = who ? c.phys.feet(who) : J.wagonLocal();
    let dur = 0;
    switch (m.k) {
      case 'hop': J.jump(3.4); c.emit({ e: 'shake', k: 0.5 }); break;
      case 'sneeze': {
        const bed = [...c.phys.ents.values()].filter((e) => e.stowed && e.item && e.item !== 'draft');
        // (only when standing: a sneeze must never throw cargo off a rolling wagon)
        if (bed.length && Math.abs(J.speed) < 0.5) { const e = c.misc.pick(bed); const mass = e.info.mass ?? 10; c.phys.unstow(e, [0, mass * 3.2, 0]); at = e.body ? c.phys.pos(e.body) : at; c.fx('dust', at!); }
        else J.jump(2.5);
        break;
      }
      case 'bighead': dur = 10; break;
      case 'confetti': c.fx('confetti', at!, 30); break;
      case 'sound': c.emit({ e: 'sound', s: 'meme' }); break;
      case 'npc': break;
      case 'duck': {
        const p = J.frame(c.misc.range(-5, 5), 12 + Math.max(0, J.speed) * 2, 24);
        const e = c.phys.addProp('rubber_duck', p, { yaw: c.misc.range(0, 6.28), owned: false });
        at = p;
        this.later(40, () => { const x = c.phys.ents.get(e.id); if (x) c.phys.remove(x as Ent); });
        break;
      }
      case 'floaty': {
        c.phys.world.gravity = { x: 0, y: -2.2, z: 0 };
        dur = 8;
        this.later(8, () => { c.phys.world.gravity = { x: 0, y: -9.81, z: 0 }; });
        break;
      }
      case 'buzz': dur = 10; this.buzzUntil = c.time + 10; break;
      case 'fakedeath': if (who) { c.phys.ragdoll(who, 2.5, [0, who.st.mass * 3, 0]); c.emit({ e: 'sound', s: 'death' }); } break;
      case 'wish': c.run.food += 50; c.syncAll(); c.fx('sparkle', J.wagonLocal(), 20); break;
      case 'kaiju': c.emit({ e: 'shake', k: 1.2 }); dur = 8; break;
      case 'grave': c.emit({ e: 'sound', s: 'sing' }); break;
    }
    const text = m.text.replace(/\{name\}/g, who ? c.nameOf(who.id) : 'Someone').replace(/\{wagon\}/g, c.deck.text.wagon ?? 'wagon').replace(/\{grave\}/g, grave?.name ?? 'a stranger');
    J.st.meme = { id: m.id, tier: m.tier, text, at: Math.round(c.time * 1000), who: who?.id };
    c.emit({ e: 'meme', id: m.id, tier: m.tier, text, k: m.k, who: who?.id, at, dur: dur || undefined });
    c.markDirty();
  }
  private later(s: number, undo: () => void) { this.ends.push({ at: this.c.time + s, undo, world: this.c.phys }); }
  /** Stop (a stop / camp end): undo anything still running. */
  reset() { for (const e of this.ends) if (e.world === this.c.phys) e.undo(); this.ends = []; this.buzzUntil = 0; }
}
