// The festival's two "authored" modes on top of the director:
//  - Endshow: the room's scripted show (scene.json festival.script, e.g. a 7-minute finale) played on the music clock
//    from the moment the host starts it: the script's part sets the section (so countdowns / blackouts / drops land on
//    the script's bars), the look (motion + palette), the wall visual, the lore line, the swell node, the eyes, the
//    level and the camera cuts; its cues are the pyro (chases, hero columns, shells that burst on the beat, the tongue).
//  - Ambient: Talk / Interview - the stage behind the conversation plays a calm, seeded show with pyro moments in
//    tiers (shared/festivalScript.ts ambientEvents): ripples and swells any time, big ones only in a pause of the
//    conversation (or on the host's "Big moment" cue), decaying gracefully when someone starts talking.
//  - TalkLights: a neutral key light on whoever speaks + two rims tinted to the show (the talk set's lighting).
// Everything is a pure function of the beat / the shared clock + the host's state, so every OBS page agrees.
import * as THREE from 'three';
import type { FestivalConfig, FestivalCueStep, FestivalScript, FestivalScriptPart, FxKind } from '../../../shared/festival.ts';
import { hash3, hashStr } from '../../../shared/festival.ts';
import { cueHits, type MusicState, type SfxHit } from '../../../shared/festivalDirector.ts';
import type { Catalogue, Look } from '../../../shared/festivalLooks.ts';
import { ambientEvents, scriptCues, scriptFrame, type ScriptFrame } from '../../../shared/festivalScript.ts';
import { AUTO_WRAP, autoMusic } from './music.ts';

// ---------------------------------------------------------------------------------------------------- the endshow
export interface EndshowOut {
  m: MusicState; hits: SfxHit[]; f: ScriptFrame; pinned: string; wall: string; blackout: boolean;
  /** the script playing, its first downbeat (music beats) and where it is (show beats) */
  script: FestivalScript; startBeat: number; b: number;
}
export class Endshow {
  private key = -1; private start = 0; private sc: FestivalScript | null = null;
  private looks = new Map<number, string>();
  /** the show's first downbeat (music beats) for a start stamp */
  startBeat(at: number, beatAt: (ms: number) => number) {
    if (at !== this.key) { this.key = at; this.start = Math.ceil(beatAt(at) / 4) * 4; this.looks.clear(); }
    return this.start;
  }
  /** `sc`: the room's script (scene.json festival.script) or a composed one (shared/festivalCompose.ts) */
  frame(sc: FestivalScript | null, cat: Catalogue, at: number, m: MusicState, beatAt: (ms: number) => number, auto: boolean, secPerBeat: number): EndshowOut | null {
    if (!sc) return null;
    if (sc !== this.sc) { this.sc = sc; this.looks.clear(); }
    let sb = this.startBeat(at, beatAt);
    // (the built-in clock's beat counter wraps every ~40-80 minutes: a long show that crosses the wrap keeps its place -
    //  its start moves into the wrapped count, so every absolute beat below stays in step with m.beat. Only once its start
    //  stamp has passed: a show stamped to start later keeps its plain count and waits - unwrapping it would start it
    //  now, mid-show)
    if (auto && beatAt(at) <= m.beat) while (m.beat - sb < -8 && sb - m.beat < 4 * AUTO_WRAP) sb -= AUTO_WRAP;
    const b = m.beat - sb;
    if (b < -8 || b > sc.bars * 4 + 8) return null;
    const f = scriptFrame(sc, Math.max(0, b));
    const sec = f.section;
    const kickOn = sec === 'drop' || sec === 'groove';
    const ph = m.beat - Math.floor(m.beat);
    const m2: MusicState = { ...m,
      section: sec, sectionStart: sb + f.partStart, prevSection: f.idx > 0 ? sc.parts[f.idx - 1].section : 'intro',
      nextDrop: f.nextDrop !== null ? sb + f.nextDrop : null, lastDrop: Number.isFinite(f.lastDrop) ? sb + f.lastDrop : -Infinity, dropCount: f.dropCount, known: true,
      kickOn, kick: kickOn ? (auto || !m.kickOn ? Math.exp(-ph * 5) : m.kick) : 0,
      energy: sec === 'drop' ? 1 : sec === 'build' ? 0.5 + 0.5 * f.k : sec === 'groove' ? 0.75 : sec === 'breakdown' ? 0.3 : 0.2 };
    // the script's cues around now (shells are in the frame their lift time early)
    const lead = 3.8 / secPerBeat;
    const near = scriptCues(sc, b, 48, lead);
    const steps = near.map((c) => ({ ...c.step, beat: sb + c.beat }));
    const hits = cueHits(steps, sb);
    const blackout = near.some((c) => c.step.kind === 'blackout' && b >= c.beat && b <= c.beat + c.step.dur);
    return { m: m2, hits, f, pinned: this.lookFor(cat, f.part, f.idx), wall: f.part.wall ?? '', blackout, script: sc, startBeat: sb, b };
  }
  /** a look for the part: its motion + palette (the energy class by section), cached per part */
  private lookFor(cat: Catalogue, p: FestivalScriptPart, idx: number): string {
    const k = this.looks.get(idx);
    if (k !== undefined) return k;
    const cls = p.section === 'drop' ? 'peak' : p.section === 'build' || p.section === 'groove' ? 'mid' : 'chill';
    const score = (l: Look) => (p.motion && l.motion === p.motion ? 4 : 0) + (p.palette && l.palette === p.palette ? 3 : 0) + (l.cls === cls ? 2 : 0) + (l.sections.includes(p.section) ? 1 : 0);
    let best: Look | null = null, bs = -1;
    if (p.motion || p.palette) for (const l of cat.looks) { const s = score(l); if (s > bs) { bs = s; best = l; } }
    let id = best && bs >= 3 ? best.id : '';
    // the part names a room palette no generated look has with that motion: the best look in that palette (a derived
    // look, added to this page's catalogue once - every page derives the same one)
    if (best && p.palette && best.palette !== p.palette && cat.palettes.has(p.palette)) {
      const did = `${best.id}${p.palette}`.slice(0, 40);
      if (!cat.byId.has(did)) { const dl: Look = { ...best, id: did, name: `${cat.palettes.get(p.palette)!.name} ${best.name.replace(cat.palettes.get(best.palette)?.name ?? '', '').trim()}`, palette: p.palette }; cat.looks.push(dl); cat.byId.set(did, dl); }
      id = did;
    }
    this.looks.set(idx, id);
    return id;
  }
}

// ---------------------------------------------------------------------------------------------------- the ambient show
export interface AmbientOut { m: MusicState; hits: SfxHit[]; master: number; big: boolean; show: string }
const AMB_BPM = 140;
export class Ambient {
  private fired = new Map<number, { at: number; hits: SfxHit[] }>();     // big moments taken (event n → when, its hits)
  private lastTalk = -Infinity;
  frame(cfg: FestivalConfig, cat: Catalogue, nowMs: number, talking: boolean, bigCue: number | null, groups: Map<FxKind, string[]>, roomSeed: number): AmbientOut {
    const amb = cfg.ambient;
    if (talking) this.lastTalk = nowMs;
    const pause = nowMs - this.lastTalk >= 1200;
    const a = autoMusic(nowMs, AMB_BPM);
    // a calm section: no drops, no countdowns; the "kick" is a slow breath (eyes, heartbeat, beams pulse gently)
    const breath = 0.5 + 0.5 * Math.sin(nowMs / 1000 * Math.PI * 2 / 4.6);
    const m: MusicState = { ...a, section: 'breakdown', sectionStart: Math.floor(a.beat / 64) * 64, prevSection: 'breakdown', nextDrop: null, lastDrop: -Infinity, dropCount: 0, kickOn: false, kick: breath * 0.6, energy: 0.35, known: true };
    const beatAt = (ms: number) => a.beat + (ms - nowMs) * AMB_BPM / 60000;
    const hits: SfxHit[] = [];
    let big = false;
    for (const ev of ambientEvents(amb, roomSeed, nowMs, 40_000, 4_000)) {
      if (ev.tier !== 'big') { hits.push(...this.tierHits(cfg, ev.tier, ev.n, beatAt(ev.at), groups, talking)); continue; }
      // big: due → taken in the first pause within a minute
      let f = this.fired.get(ev.n);
      if (!f && ev.at <= nowMs && nowMs - ev.at < 60_000 && pause) { f = { at: nowMs, hits: this.tierHits(cfg, 'big', ev.n, beatAt(nowMs) + 1, groups, false) }; this.fired.set(ev.n, f); }
      if (f) { hits.push(...f.hits); if (nowMs - f.at < 25_000) big = true; }
    }
    if (bigCue !== null && nowMs - bigCue < 30_000) {
      const n = -Math.floor(bigCue / 1000);
      let f = this.fired.get(n);
      if (!f) { f = { at: bigCue, hits: this.tierHits(cfg, 'big', n, beatAt(bigCue) + 1, groups, false) }; this.fired.set(n, f); }
      hits.push(...f.hits); big = true;
    }
    // someone starts talking during a big moment: no new launches (what is in the air finishes)
    const nowBeat = a.beat;
    const live = talking ? hits.filter((h) => h.beat - (h.kind === 'firework' ? 3.8 * AMB_BPM / 60 : 0) <= nowBeat) : hits;
    for (const [n, f] of this.fired) if (nowMs - f.at > 120_000) this.fired.delete(n);
    const show = amb.show || cfg.shows.find((s) => s.genre === 'chill')?.id || cat.shows.find((s) => s.genre === 'chill')?.id || 'auto';
    return { m, hits: live, master: (talking ? amb.talking : amb.master) * (big && pause ? 1.6 : 1), big, show };
  }
  /** a tier's effects: the room's own cues for the tier, else built from its effect groups */
  private tierHits(cfg: FestivalConfig, tier: 'ripple' | 'swell' | 'big', n: number, beat: number, groups: Map<FxKind, string[]>, quiet: boolean): SfxHit[] {
    const amb = cfg.ambient;
    const names = tier === 'ripple' ? amb.ripples : tier === 'swell' ? amb.swells : amb.bigs;
    const r = (k: number) => hash3(n, hashStr(tier), k);
    let steps: FestivalCueStep[] = [];
    const named = names.length ? cfg.cues[names[Math.floor(r(1) * names.length) % names.length]] : undefined;
    if (named) steps = named;
    else {
      const pick = (kind: FxKind) => { const g = groups.get(kind) ?? []; return g.length ? g[Math.floor(r(kind.length + 2) * g.length) % g.length] : null; };
      const fl = pick('flame'), cm = pick('comet'), gb = pick('gerb'), fw = pick('firework'), cf = pick('confetti');
      if (tier === 'ripple') {
        const which = r(3);
        if (which < 0.5 && fl !== null) steps = [{ kind: 'flame', group: fl, at: 0, dur: 0.5, power: 0.7, order: r(4) < 0.5 ? 'lr' : 'rl', span: 2, side: r(5) < 0.5 ? -1 : 1 }];
        else if (cm !== null) steps = [{ kind: 'comet', group: cm, at: 0, dur: 1, power: 0.8, side: -1 }, { kind: 'comet', group: cm, at: 1, dur: 1, power: 0.8, side: 1 }];
      } else if (tier === 'swell') {
        if (fl !== null) steps.push({ kind: 'flame', group: fl, at: 0, dur: 0.6, power: 0.9, order: 'out', span: 4 });
        if (gb !== null) steps.push({ kind: 'gerb', group: gb, at: 2, dur: 8, power: 0.8 });
        if (cf !== null) steps.push({ kind: 'confetti', group: cf, at: 6, dur: 1.5, power: 0.6 });
      } else {
        const buzz = cfg.cues.buzz;
        if (buzz) steps.push(...buzz);
        else if (fl !== null) steps.push({ kind: 'flame', group: '', at: 0, dur: 1, power: 1.2, order: 'out', span: 1 });
        if (fw !== null || groups.get('firework')?.length) for (let k = 0; k < 18; k++) steps.push({ kind: 'firework', group: '', at: 2 + k * (1.5 + r(10 + k) * 1.5), dur: 1, power: 0.9 + 0.4 * r(30 + k), style: (['willow', 'crossette', 'glitter', 'willow'] as const)[k % 4], side: k % 2 ? -1 : 1 } as FestivalCueStep);
      }
    }
    if (quiet) steps = steps.map((s) => ({ ...s, power: s.power * 0.7 }));
    return cueHits(steps.map((s) => ({ ...s, beat: beat + s.at })), beat);
  }
}

// ---------------------------------------------------------------------------------------------------- the talk-set lights
/** A neutral key on whoever speaks (soft, from the camera side, slightly above the eye line) + two rims from behind
 *  tinted to the show, following the background's level (the subject stays separated when the stage flares). Created
 *  once for the room (the light count never changes mid-show: no shader recompiles). */
export class TalkLights {
  readonly group = new THREE.Group();
  private key = new THREE.SpotLight(0xfff2e6, 0, 9, 0.55, 0.85, 1.4);
  private rims = [new THREE.SpotLight(0xffffff, 0, 8, 0.5, 0.7, 1.4), new THREE.SpotLight(0xffffff, 0, 8, 0.5, 0.7, 1.4)];
  private on = 0;
  private aim = new THREE.Vector3();
  // (scratch vectors: no allocation per frame)
  private toCam = new THREE.Vector3(); private side = new THREE.Vector3(); private back = new THREE.Vector3(); private bs = new THREE.Vector3();
  constructor() {
    this.group.name = 'festival:talk-lights';
    for (const l of [this.key, ...this.rims]) { l.castShadow = false; this.group.add(l, l.target); }
  }
  /** face = the speaker's face (room-local), cam = the camera (room-local), stage = a point on the stage (room-local) */
  update(want: boolean, face: THREE.Vector3 | null, cam: THREE.Vector3, stage: THREE.Vector3, rimA: THREE.Color, rimB: THREE.Color, bg: number, dt: number) {
    this.on += ((want && face ? 1 : 0) - this.on) * Math.min(1, dt * 2);
    if (!face) { for (const l of [this.key, ...this.rims]) l.intensity *= this.on; return; }
    this.aim.lerp(face, this.aim.lengthSq() ? Math.min(1, dt * 1.5) : 1);       // follows the speaker smoothly
    const toCam = this.toCam.copy(cam).sub(this.aim).setY(0).normalize();
    const side = this.side.set(toCam.z, 0, -toCam.x);
    this.key.position.copy(this.aim).addScaledVector(toCam, 2.2).addScaledVector(side, 1.2); this.key.position.y += 0.55;
    this.key.target.position.copy(this.aim);
    this.key.intensity = 2.4 * this.on;
    const back = this.back.copy(stage).sub(this.aim).setY(0).normalize();
    const bs = this.bs.set(back.z, 0, -back.x);
    this.rims.forEach((l, i) => {
      l.position.copy(this.aim).addScaledVector(back, 1.6).addScaledVector(bs, i ? 1.1 : -1.1); l.position.y += 0.9;
      l.target.position.copy(this.aim);
      l.color.copy(i ? rimB : rimA);
      l.intensity = (1.6 + 3.0 * Math.min(1, bg)) * this.on;
    });
  }
  dispose() { this.group.removeFromParent(); for (const l of [this.key, ...this.rims]) l.dispose(); }
}
