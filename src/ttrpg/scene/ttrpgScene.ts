// TTRPG table engine on OBS pages / the Scene preview (attached like the kitchen / raid engines by src/output.ts).
// SceneState.ttrpg (host-owned) → the battle map on MAP_SURFACE, minis, dice thrown into DICE_TRAY (same throw on
// every page from the roll's seed, faces forced to the host's result), the GM at the head of the table (built-in
// talking object / the room's figure / a library avatar) whose mouth follows the spoken line, mood lighting, the
// handout, the 2D overlay (captions, roll card, initiative) and the auto-director. Costs nothing unless a session is on.
// Test pages: output.html?sceneTest=<room>&ttrpg=demo[&ttrpgSeed=n] — a self-running demo table (rolls every 9 s,
// aligned to the wall clock so two pages throw the same dice at the same moment); vtpOut.ttrpg.debug().
import * as THREE from 'three';
import type { SceneRuntime } from '../../scene/SceneRuntime.ts';
import { DEFAULT_TTRPG_STATE, sanitizeTtrpgState, type RoomTtrpgConfig, type SceneTtrpgState, type TtrpgDie, type TtrpgMood, type TtrpgRoll } from '../../../shared/ttrpg/state.ts';
import { sanitizeLip, type TtrpgBus } from '../../../shared/ttrpg/wire.ts';
import { buildMap, type MapGrid } from '../../../shared/ttrpg/maps.ts';
import { hash32, sfc32 } from '../../../shared/ttrpg/dice.ts';
import { findAnchors, type TtrpgAnchors } from './anchors.ts';
import { drawMap, isMapLook, roundRect, type MapLook } from './mapCanvas.ts';
import { TokenLayer } from './tokens.ts';
import { DiceView } from '../dice/diceView.ts';
import { GmEmbodiment } from '../gm/gmEmbodiment.ts';
import { sampleSpeech, speechTrack, spokenChars, trackFromLip, type SpeechTrack } from '../gm/speech.ts';
import { TableDirector } from './director.ts';
import { TableOverlay } from './overlay.ts';
import { tvReact } from '../../scene/tv/tvApi.ts';
import { ClearShot, surfacePoints, type ClearTarget } from './clearShot.ts';

export const MOOD_COLOR: Record<TtrpgMood, string> = { calm: '#ffcf8a', tense: '#ffab4a', combat: '#ff3b30', mystery: '#5b7cff', eerie: '#43d17a', triumph: '#ffd257', dark: '#3a3f7a' };
const MOOD_LIGHT: Record<TtrpgMood, number> = { calm: 0.5, tense: 0.6, combat: 0.9, mystery: 0.55, eerie: 0.6, triumph: 0.9, dark: 0.25 };

interface SurfaceDraw { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; mat: THREE.Material; key: string }

export class TtrpgScene {
  private rt: SceneRuntime | null = null;
  private a: TtrpgAnchors | null = null;
  private cfg: RoomTtrpgConfig | undefined;
  private map: SurfaceDraw | null = null;
  private hand: SurfaceDraw | null = null;
  private grid: MapGrid | null = null;
  private tokens: TokenLayer | null = null;
  private dice: DiceView | null = null;
  gm: GmEmbodiment | null = null;
  private director: TableDirector | null = null;
  private overlay: TableOverlay | null = null;
  private moodLight: THREE.PointLight | null = null;
  private moodMats: { m: THREE.MeshStandardMaterial; base: THREE.Color; baseI: number }[] = [];
  private moodC = new THREE.Color(MOOD_COLOR.calm);
  private prevOverride: SceneRuntime['cameraOverride'] = null;
  private myOverride: SceneRuntime['cameraOverride'] = null;
  private track: { id: string; tr: SpeechTrack; at: number } | null = null;
  private retime = new Map<string, { at: number; dur: number }>();
  /** per line: the mouth timeline of the audio itself (Rhubarb on the server's rendered line), when the host had one */
  private lipTr = new Map<string, SpeechTrack>();
  private level = { id: '', v: 0, at: 0 };
  private assets = new Map<string, { url: string; img: HTMLImageElement | null }>();
  private t = 0;
  private active = false;
  private lastRev = -1;
  private lastRoll = '';
  private handoutAt = 0;
  private reacted = '';
  private gmScreenVis: boolean | null = null;
  private clear: ClearShot | null = null;
  private clearPts = new Map<string, THREE.Vector3[]>();
  /** Member key → voice level 0..1 (output.ts hands in this page's view of everyone's mouth). */
  speaking: () => Map<string, number> = () => new Map();
  /** Test pages: a self-running demo table instead of the host's state. */
  demo = false;
  demoSeed = 7;
  /** Test pages: a local state override (vtpOut.ttrpg.set({...})). */
  local: SceneTtrpgState | null = null;

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    this.cfg = (rt.info as unknown as { ttrpg?: RoomTtrpgConfig }).ttrpg;
    this.a = findAnchors(rt.room);
    const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
    this.prevOverride = hook.cameraOverride;
    this.myOverride = (aspect: number) => this.shot(aspect) ?? this.prevOverride?.(aspect) ?? null;
    hook.cameraOverride = this.myOverride;
    for (const e of rt.room.emissive) if (/^mood/i.test(e.group)) this.moodMats.push({ m: e.material, base: e.baseColor.clone(), baseI: e.baseIntensity });
  }

  detach() {
    const rt = this.rt;
    if (rt) {
      const hook = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (hook.cameraOverride === this.myOverride) hook.cameraOverride = this.prevOverride;
    }
    this.deactivate();
    this.rt = null; this.a = null; this.moodMats = []; this.prevOverride = null; this.myOverride = null;
  }

  /** The table state this page shows. */
  get state(): SceneTtrpgState | null {
    if (this.local) return this.local;
    if (this.demo) return this.demoState(Date.now());
    const s = (this.rt?.state as unknown as { ttrpg?: SceneTtrpgState } | undefined)?.ttrpg;
    // (only in a room that IS a table - its scene.json has `ttrpg`, like gmSeatRule: a `ttrpg.on` left over from the last game
    // must never run the table, the GM or the table's camera director in the Studio Club or any other ordinary room)
    return s && s.on && this.cfg ? s : null;
  }

  private activate() {
    const rt = this.rt!, a = this.a!;
    this.active = true;
    if (a.map) {
      const look: MapLook = isMapLook(this.cfg?.map?.look) ? this.cfg!.map!.look as MapLook : isMapLook(a.map.extras.look) ? a.map.extras.look as MapLook : 'paper';
      const full = a.map.full ?? a.map;                          // (the canvas covers the whole mesh, even when the map uses part of it)
      this.map = this.surface(full.width / Math.max(1e-3, full.height), look === 'holo' || look === 'crt');
      this.tokens = new TokenLayer(a.map);
      rt.root.add(this.tokens.group);
    }
    if (a.tray) {
      if (typeof this.cfg?.dice?.size === 'number') a.tray.die = Math.min(0.08, Math.max(0.015, this.cfg.dice.size));
      this.dice = new DiceView(a.tray, this.cfg?.dice); rt.root.add(this.dice.group);
    }
    this.gm = new GmEmbodiment(rt, a, this.cfg);
    this.director = new TableDirector(rt, a);
    // table shots see the table: whatever hangs / stands between their camera and the surface is hidden for them
    this.clear = new ClearShot(() => [rt.room.root, ...(this.gm && !this.gm.isAvatar ? [this.gm.group] : [])], () => [a.map?.mesh, a.handout?.mesh, a.tray?.node].filter((o): o is THREE.Object3D => !!o));
    this.clearPts.clear();
    this.overlay = new TableOverlay();
    this.moodLight = new THREE.PointLight(this.moodC, 0, 3.5, 2);
    this.moodLight.position.copy(a.table?.position ?? new THREE.Vector3()).add(new THREE.Vector3(0, 1.3, 0));
    rt.root.add(this.moodLight);
    this.lastRev = -1;
  }

  private deactivate() {
    if (!this.active) return;
    this.active = false;
    const a = this.a;
    if (a?.map && this.map) a.map.mesh.material = a.map.original;
    if (a?.handout && this.hand) a.handout.mesh.material = a.handout.original;
    for (const s of [this.map, this.hand]) if (s) { s.tex.dispose(); s.mat.dispose(); }
    this.map = null; this.hand = null; this.grid = null;
    this.tokens?.dispose(); this.tokens = null;
    this.dice?.dispose(); this.dice = null;
    this.gm?.dispose(); this.gm = null;
    this.overlay?.dispose(); this.overlay = null;
    this.moodLight?.removeFromParent(); this.moodLight = null;
    for (const x of this.moodMats) { x.m.emissive.copy(x.base); x.m.emissiveIntensity = x.baseI; }
    if (a?.gmScreen && this.gmScreenVis !== null) a.gmScreen.visible = this.gmScreenVis;
    this.clear?.restore(); this.clear = null;
    this.director = null; this.track = null;
  }

  private surface(aspect: number, glow: boolean): SurfaceDraw {
    const canvas = document.createElement('canvas');
    const W = 2048;
    canvas.width = W; canvas.height = Math.max(256, Math.min(4096, Math.round(W / Math.max(0.25, aspect))));
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.flipY = false; tex.anisotropy = 8;       // glTF UV convention
    // (lit maps sit right under the table lamp: a darker base colour keeps the paper from blowing out, esp. with bloom)
    const mat = glow ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: 0xd8d8d8 }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, color: new THREE.Color(0.5, 0.5, 0.5), envMapIntensity: 0.3 });
    return { canvas, tex, mat, key: '' };
  }

  onBus(m: TtrpgBus) {
    if (m.k === 'sayAt') {
      this.retime.set(m.id, { at: m.at, dur: m.dur });
      const lip = sanitizeLip(m.lip), tr = lip ? trackFromLip(lip, m.dur) : null;
      if (tr) { this.lipTr.set(m.id, tr); if (this.lipTr.size > 12) this.lipTr.delete(this.lipTr.keys().next().value as string); } else this.lipTr.delete(m.id);
    }
    else if (m.k === 'mouth') this.level = { id: m.id, v: Math.max(0, Math.min(1, m.v)), at: performance.now() };
    else if (m.k === 'asset' && /^data:image\/(png|jpeg|webp);base64,/.test(m.url) && m.url.length < 6_000_000) {
      const img = new Image(); img.src = m.url;
      const e = { url: m.url, img: null as HTMLImageElement | null };
      img.onload = () => { e.img = img; this.lastRev = -1; };
      this.assets.set(m.id, e);
      if (this.assets.size > 24) this.assets.delete(this.assets.keys().next().value as string);
    }
  }

  update(dt: number) {
    const rt = this.rt;
    if (!rt || !this.a) return;
    const st = this.state;
    if (!st) { this.deactivate(); return; }
    if (!this.active) this.activate();
    this.t += dt;
    const now = Date.now();
    if (st.rev !== this.lastRev || this.local || this.demo) { this.lastRev = st.rev; this.apply(st); }
    // speech → mouth
    const say = st.say;
    if (say && (!this.track || this.track.id !== say.id)) this.track = { id: say.id, tr: speechTrack(say.text, say.dur), at: say.at };
    const rt2 = say ? this.retime.get(say.id) : null;
    if (this.track && rt2 && (rt2.at !== this.track.at || rt2.dur !== this.track.tr.dur)) this.track = { id: this.track.id, tr: speechTrack(this.track.tr.text, rt2.dur), at: rt2.at };
    const lineT = this.track ? (now - this.track.at) / 1000 : -1;
    // the mouth follows the audio's own shapes when the host had them (Rhubarb), else the text-driven timeline
    const mouth = sampleSpeech((say ? this.lipTr.get(say.id) : null) ?? this.track?.tr ?? null, lineT);
    const lvl = this.level.id === say?.id && performance.now() - this.level.at < 400 ? this.level.v : -1;
    // mood colour eases
    this.moodC.lerp(new THREE.Color(MOOD_COLOR[st.mood]), Math.min(1, dt * 1.5));
    const excite = Math.max(this.dice?.excite ?? 0, 0);
    const gmColor = new THREE.Color(st.gm.look.color).lerp(this.moodC, 0.25);
    // (a performer sitting in the GM's chair = a human GM: the AI's figure steps aside)
    this.gm!.hidden = st.gm.kind !== 'ai' || [...rt.actors.values()].some((x) => x.spot?.index === 11 && x.shown);
    // NPC lines move the GM's mouth too (the GM voices them), a little less
    this.gm!.update({ dt, t: this.t, mouth: say?.npc ? { ...mouth, open: mouth.open * 0.8 } : mouth, level: lvl, excite, color: gmColor, camera: rt.stage.camera, aspect: rt.stage.camera.aspect || 16 / 9 });
    this.tokens?.update(dt, rt.stage.camera, this.t);
    // dice: the newest throw that is due (the host staggers throws ~2.8 s apart, so each one lands and reads)
    if (this.dice) {
      let due: TtrpgRoll | null = null;
      for (const r of st.rolls) if (!r.secret && r.at <= now + 400 && (!due || r.at >= due.at)) due = r;
      if (due) void this.dice.show(due);
    }
    this.dice?.update(dt, now);
    // mood light + EMIT_mood materials (after the light show so they win), crit flash
    if (this.moodLight) {
      const pulse = st.mood === 'combat' ? 0.75 + 0.25 * Math.sin(this.t * 3) : 1;
      this.moodLight.color.copy(this.moodC);
      this.moodLight.intensity = (MOOD_LIGHT[st.mood] * pulse + excite * 1.5) * 1.2;
    }
    for (const x of this.moodMats) { x.m.emissive.copy(this.moodC); x.m.emissiveIntensity = Math.max(0.2, x.baseI) * (0.8 + excite * 2); }
    // overlay
    const ov = this.overlay!;
    ov.setAccent(st.gm.look.color);
    const capOn = st.overlay.captions && !!say && lineT > -0.2 && lineT < (this.track?.tr.dur ?? 0) + 2.2;
    ov.caption(capOn, say ? (say.npc ? say.name : say.name || st.gm.look.name) : '', say?.text ?? '', this.track ? spokenChars(this.track.tr, lineT) : 0, !!st.xAt && now - st.xAt < 6000);
    const cur = this.dice?.current ?? null;
    // a crit landed: the roller reacts if they are a TV performer (webcam / VTube Studio guests have reaction clips)
    if (cur?.crit && this.dice && this.dice.sinceSettle >= 0 && this.reacted !== cur.id) {
      this.reacted = cur.id;
      tvReact(rt.actors.get(cur.who) ?? null, cur.crit === 'hi' ? 'clap' : 'react_shock');
    }
    ov.rollCard(st.overlay.rolls && !!cur && (this.dice?.sinceSettle ?? -1) >= 0.25, cur, now);
    const secret = st.rolls.length ? st.rolls[st.rolls.length - 1] : null;
    if (secret?.secret && secret.id !== this.lastRoll && now > secret.at) { this.lastRoll = secret.id; ov.rollCard(st.overlay.rolls, secret, now); }
    ov.initiative(st);
    // (the handout card only when the handout isn't already on screen in 3D)
    ov.handout(this.a.handout && this.director?.shot === 'handout' ? { ...st, handout: null } : st, now, (id) => this.assets.get(id)?.url ?? null);
  }

  /** Map, tokens, dice, GM style, handout — on state change. */
  private apply(st: SceneTtrpgState) {
    const a = this.a!;
    // GM screen: hidden for an AI GM when the room asks
    if (a.gmScreen && a.gmScreen.userData?.aiHide === true) { if (this.gmScreenVis === null) this.gmScreenVis = a.gmScreen.visible; a.gmScreen.visible = st.gm.kind !== 'ai' && this.gmScreenVis; }
    void this.gm?.setStyle(st.gm.look.style, st.gm.look.color);
    // map
    if (a.map && this.map) {
      const m = st.map;
      const cols = m?.grid ?? 16, rows = m?.rows ?? Math.max(4, Math.round(cols * (a.map.height / Math.max(1e-3, a.map.width))));
      const img = m?.img ? this.assets.get(m.img)?.img ?? null : null;
      const key = m ? `${m.tpl}|${m.seed}|${cols}|${rows}|${m.title}|${m.img ?? ''}|${img ? 1 : 0}` : '';
      if (key !== this.map.key) {
        this.map.key = key;
        if (!m) { a.map.mesh.material = a.map.original; this.grid = null; }
        else {
          this.grid = m.tpl === 'img' || m.tpl === 'room' ? null : buildMap(m.tpl, m.seed, cols, rows);
          const c = this.map.canvas, ctx = c.getContext('2d')!;
          const look: MapLook = isMapLook(this.cfg?.map?.look) ? this.cfg!.map!.look as MapLook : isMapLook(a.map.extras.look) ? a.map.extras.look as MapLook : 'paper';
          if (m.tpl === 'room') a.map.mesh.material = a.map.original;
          else {
            const opts = { grid: this.grid, img, title: m.title, look, ink: this.cfg?.map?.ink, paper: this.cfg?.map?.paper, cols, rows };
            const sub = a.map.sub;
            if (!sub) drawMap(ctx, c.width, c.height, opts);
            else {
              // the dice tray stands on part of the surface: the map is drawn on the rest, the tray's corner gets the paper
              const w = Math.max(64, Math.round(c.width * (sub.u1 - sub.u0))), h = Math.max(64, Math.round(c.height * (sub.v1 - sub.v0)));
              const off = document.createElement('canvas'); off.width = w; off.height = h;
              const octx = off.getContext('2d')!;
              drawMap(octx, w, h, opts);
              const px = octx.getImageData(2, 2, 1, 1).data;
              ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`; ctx.fillRect(0, 0, c.width, c.height);
              ctx.drawImage(off, Math.round(sub.u0 * c.width), Math.round(sub.v0 * c.height), w, h);
            }
            this.map.tex.needsUpdate = true;
            a.map.mesh.material = this.map.mat;
          }
        }
      }
      this.tokens?.setGrid(cols, rows);
      const turn = st.init.on ? st.init.order[st.init.turn]?.tok ?? null : null;
      this.tokens?.sync(m ? st.tokens : [], turn, typeof a.map.extras.mini === 'number' ? a.map.extras.mini as number : undefined);
    }
    // handout on the HANDOUT plane
    if (a.handout) {
      const h = st.handout;
      const key = h ? `${h.id}|${h.title}|${h.text ?? ''}|${h.img ?? ''}|${h.img && this.assets.get(h.img)?.img ? 1 : 0}` : '';
      if (!this.hand) this.hand = this.surface(a.handout.width / Math.max(1e-3, a.handout.height), false);
      if (key !== this.hand.key) {
        this.hand.key = key;
        if (!h) a.handout.mesh.material = a.handout.original;
        else { drawHandout(this.hand.canvas, h.title, h.text ?? '', h.style ?? 'parchment', h.img ? this.assets.get(h.img)?.img ?? null : null); this.hand.tex.needsUpdate = true; a.handout.mesh.material = this.hand.mat; }
      }
    }
    if (st.handout && st.handout.at !== this.handoutAt) this.handoutAt = st.handout.at;
  }

  private shot(aspect: number) {
    const st = this.state, rt = this.rt;
    if (!st || !rt || !this.director || !this.a) return null;
    if (rt.state.mode === 'react') { this.clear?.update(null, null); return null; }   // React mode keeps its own screen shot
    const now = Date.now();
    const d = this.dice;
    const cur = d?.current ?? null;
    const diceActive = !!cur && now >= cur.at - 250 && (d!.sinceSettle < 0 || d!.sinceSettle < (cur.crit ? 2.6 : 1.3));
    const say = st.say;
    const lineAge = say ? (now - say.at) / 1000 : -1;
    const gmSpeaking = !!say && lineAge >= 0 && lineAge < say.dur + 0.4 && st.gm.kind === 'ai';
    const speak = this.speaking();
    // a human GM speaking counts as a performer; the AI GM is 'gm'
    const shot = this.director.decide({
      st, now, speaking: speak, gmSpeaking, gmLineAge: lineAge, gmFace: this.gm!.facePoint(), gmFaceSize: this.gm!.faceSize, gmShotH: this.gm!.shotHeight,
      diceActive, diceCrit: cur?.crit ?? null, diceSettled: d?.sinceSettle ?? -1, diceCenter: d ? d.center() : null,
      handoutAge: st.handout ? (now - st.handout.at) / 1000 : -1, combat: st.init.on,
    }, aspect);
    this.clear?.update(shot?.pose.position ?? null, shot ? this.clearTarget(shot.key) : null);
    return shot;
  }

  /** What a table shot must see: points just above the map / the tray / the handout. */
  private clearTarget(key: string): ClearTarget | null {
    const a = this.a!;
    const what = key === 'ttrpg:map' ? 'map' : key.startsWith('ttrpg:dice') ? 'dice' : key === 'ttrpg:handout' ? 'handout' : '';
    if (!what) return null;
    let pts = this.clearPts.get(what);
    if (!pts) {
      pts = [];
      if (what === 'map' && a.map) pts = surfacePoints(a.map, 6, 4, 0.03);
      else if (what === 'handout' && a.handout) pts = surfacePoints(a.handout, 3, 3, 0.01);
      else if (what === 'dice' && a.tray) {
        const t = a.tray, right = new THREE.Vector3().crossVectors(t.forward, new THREE.Vector3(0, 1, 0)).normalize();
        for (const [x, z] of [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) pts.push(t.position.clone().addScaledVector(right, x * t.w).addScaledVector(t.forward, z * t.d).add(new THREE.Vector3(0, 0.03, 0)));
      }
      this.clearPts.set(what, pts);
    }
    let protect: THREE.Box3[] | undefined;
    if (what === 'dice' && a.tray) {
      const t = a.tray, r = Math.max(t.w, t.d) / 2 + t.rim + 0.03;
      protect = [new THREE.Box3(t.position.clone().add(new THREE.Vector3(-r, -0.05, -r)), t.position.clone().add(new THREE.Vector3(r, t.rim + 0.08, r)))];
    }
    return { key: what, points: pts, surfaceY: a.tableY, protect };
  }

  // ---------------------------------------------------------------- test-page demo table
  private demoCache: { slot: number; st: SceneTtrpgState } | null = null;
  private demoState(now: number): SceneTtrpgState {
    const slot = Math.floor(now / 9000);
    if (this.demoCache?.slot === slot) return this.demoCache.st;
    const r = sfc32(hash32(`demo:${this.demoSeed}:${slot}`));
    const kinds: [number, number][] = [[20, 1], [20, 2], [6, 3], [8, 2], [12, 1], [4, 2], [10, 2], [100, 1], [20, 1]];
    const [s, n] = kinds[slot % kinds.length];
    const dice: TtrpgDie[] = Array.from({ length: n }, () => ({ s, v: 1 + Math.floor(r() * s) }));
    if (slot % 3 === 0 && s === 20) dice[0].v = 20;
    if (s === 20 && n === 2) { if (dice[1].v > dice[0].v) [dice[0].v, dice[1].v] = [dice[1].v, dice[0].v]; dice[1].k = false; }
    const total = dice.filter((x) => x.k !== false).reduce((a, x) => a + x.v, 0) + 3;
    const roll: TtrpgRoll = { id: `demo-${slot}`, who: '@host', name: 'Aria', label: ['Stealth', 'Attack', 'Damage', 'Perception', 'Initiative'][slot % 5], expr: `${n}d${s}+3`, dice, mod: 3, total,
      crit: s === 20 && n <= 2 && dice[0].v === 20 ? 'hi' : s === 20 && dice[0].v === 1 ? 'lo' : null, at: slot * 9000 + 1500, seed: hash32(`seed:${this.demoSeed}:${slot}`), dc: 14 };
    const lines = ['The lantern gutters. Somewhere below, water drips onto stone — and something breathes.', 'Three goblins burst from behind the crates, blades out!', 'Roll for it, Aria. The floor looks wrong.'];
    const st = sanitizeTtrpgState({
      ...DEFAULT_TTRPG_STATE, on: true, title: 'Demo table', gm: { kind: 'ai', look: { style: this.demoStyle ?? 'd20', name: 'The Oracle', color: '#8fd3ff' } },
      map: { tpl: ['dungeon', 'cave', 'swamp', 'factory', 'tavern'][Math.floor(slot / 3) % 5], seed: this.demoSeed + Math.floor(slot / 3), title: 'The Smugglers’ Cellar', grid: 18 },
      tokens: [
        { id: 'p1', name: 'Aria', kind: 'pc', x: 2, y: 5, color: '#45b7d1', owner: '@host', hp: [9, 12] }, { id: 'p2', name: 'Grog', kind: 'pc', x: 3, y: 6, color: '#e8615a', hp: [14, 14] },
        { id: 'p3', name: 'Vex', kind: 'pc', x: 2, y: 7, color: '#b07cf0', hp: [3, 9] }, { id: 'g1', name: 'Goblin 1', kind: 'monster', x: 12 + (slot % 3), y: 5, color: '#6b8e23', hp: [7, 7] },
        { id: 'g2', name: 'Goblin 2', kind: 'monster', x: 13, y: 7, color: '#6b8e23', hp: [0, 7], dead: slot % 2 === 0 }, { id: 'o1', name: 'Crate', kind: 'object', x: 9, y: 3, color: '#8a6a45' },
      ],
      init: { on: true, round: 1 + Math.floor((slot % 40) / 4), turn: slot % 4, order: [{ id: 'i1', name: 'Aria', init: 18, tok: 'p1', kind: 'pc' }, { id: 'i2', name: 'Goblin 1', init: 15, tok: 'g1', kind: 'monster' }, { id: 'i3', name: 'Grog', init: 11, tok: 'p2', kind: 'pc' }, { id: 'i4', name: 'Vex', init: 7, tok: 'p3', kind: 'pc' }] },
      rolls: [roll], say: { id: `demo-say-${slot}`, who: 'gm', name: 'The Oracle', text: lines[slot % 3], at: slot * 9000 + 5200, dur: 3.4 },
      mood: (['tense', 'combat', 'mystery', 'eerie'] as const)[slot % 4], cam: 'auto', rev: slot,
      handout: slot % 4 === 3 ? { id: `h${slot}`, title: 'Wanted: the Goblin King', text: '50 gold, dead or alive.\nLast seen in the cellar under the Gilded Goose.', style: 'wanted', at: slot * 9000 } : null,
    });
    this.demoCache = { slot, st };
    return st;
  }
  demoStyle: string | null = null;

  debug() {
    const a = this.a;
    return {
      active: this.active, room: this.rt?.info.id ?? null, problems: a?.problems ?? [],
      anchors: a ? { table: !!a.table, map: a.map ? { w: +a.map.width.toFixed(3), h: +a.map.height.toFixed(3), normalY: +a.map.normal.y.toFixed(3), sub: a.map.sub ?? null } : null, tray: a.tray ? { w: a.tray.w, d: a.tray.d, die: a.tray.die, authored: !!a.tray.node } : null,
        gmSeat: !!a.gmSeat, gmProp: !!a.gmProp.node, handout: !!a.handout, cams: Object.fromEntries(Object.entries(a.cams).map(([k, v]) => [k, k === 'seats' ? [...(v as Map<number, unknown>).keys()] : !!v])) } : null,
      dice: this.dice?.last ?? null, director: this.director ? { shot: this.director.shot, why: this.director.why, seats: this.director.seatInfo } : null,
      gm: this.gm ? { style: this.gm.style, shownAs: this.gm.shownAs, note: this.gm.note, hidden: this.gm.hidden } : null,
      say: this.track ? { id: this.track.id, dur: this.track.tr.dur } : null, map: this.map?.key ?? null, cleared: this.clear?.names ?? [],
    };
  }
  info() { return this.active ? { on: true, shot: this.director?.shot ?? '', gm: this.gm?.shownAs ?? '', problems: this.a?.problems ?? [], dice: this.dice?.last ?? null } : null; }
}

/** Handout art on the HANDOUT plane (parchment, sticky note, dossier, wanted poster, terminal screen). */
function drawHandout(c: HTMLCanvasElement, title: string, text: string, style: string, img: HTMLImageElement | null) {
  const x = c.getContext('2d')!, W = c.width, H = c.height;
  const bg: Record<string, [string, string, string]> = { parchment: ['#efe0bb', '#3a2812', 'Georgia, serif'], note: ['#fff7a8', '#2a2a2a', '"Segoe Print", cursive'], dossier: ['#e8e2d0', '#1c1c1c', '"Courier New", monospace'],
    wanted: ['#e3c98f', '#3b2208', 'Georgia, serif'], screen: ['#07131a', '#9df0ff', 'Consolas, monospace'] };
  const [paper, ink, font] = bg[style] ?? bg.parchment;
  x.fillStyle = paper; x.fillRect(0, 0, W, H);
  const r = sfc32(hash32(title));
  for (let i = 0; i < 1500; i++) { x.fillStyle = `rgba(${style === 'screen' ? '120,240,255' : '90,60,20'},${0.02 + r() * 0.04})`; x.fillRect(r() * W, r() * H, 2, 2); }
  x.strokeStyle = ink; x.lineWidth = W * 0.008; roundRect(x, W * 0.04, H * 0.04, W * 0.92, H * 0.92, W * 0.02); x.stroke();
  let y = H * 0.1;
  if (img) { const s = Math.min((W * 0.84) / img.width, (H * 0.45) / img.height); x.drawImage(img, (W - img.width * s) / 2, y, img.width * s, img.height * s); y += img.height * s + H * 0.04; }
  x.fillStyle = ink; x.textAlign = 'center'; x.textBaseline = 'top';
  x.font = `700 ${Math.round(W * (style === 'wanted' ? 0.11 : 0.07))}px ${font}`;
  x.fillText(title, W / 2, y, W * 0.86); y += W * (style === 'wanted' ? 0.14 : 0.1);
  x.font = `500 ${Math.round(W * 0.045)}px ${font}`; x.textAlign = 'left';
  const words = text.split(/(\s+)/); let line = '';
  for (const w of words) {
    if (w.includes('\n')) { x.fillText(line, W * 0.08, y); y += W * 0.06; line = ''; continue; }
    const t = line + w;
    if (x.measureText(t).width > W * 0.84 && line) { x.fillText(line, W * 0.08, y); y += W * 0.06; line = w.trimStart(); } else line = t;
    if (y > H * 0.9) break;
  }
  if (line && y <= H * 0.9) x.fillText(line, W * 0.08, y);
}
