// The goals board IN the room (beta.13): a neon scoreboard that winches down from the ceiling (the studio's HangingRig,
// same family as the chat monitor / support board) showing the subathon timer, the first goal + its stretch-goal ladder
// (or the "time added by" leaderboard), drawn from the helper's view - identical on the studio preview, OBS and every
// party guest's page.
//
// Where: rooms host it with GOAL_BOARD_xx (per SPOT_xx: the board for performer xx's shot) / GOAL_BOARD nodes or
// scene.json `goalBoards: { SPOT_01: { position, yaw, width } }`; rooms without one fall back to their chat board anchors
// (CHAT_BOARD_xx / CHAT_BOARD / chatBoards) while the support board itself is off. Rooms with neither keep the docked
// card instead (goalsOverlay.ts). Off with Goals & subathon → On stream → "In the room" (show.world). Free while off.
//
// The board never covers a LIVE timer display (timerDisplays.ts: the countdown drawn onto a room mesh, e.g. a clock set into a statue): while the
// shot has the board hung in front of a display's glass panel it winches up (the docked card carries the goals + the clock meanwhile) and
// comes back down the moment the shot no longer frames one in front of the other (src/goals/boardShield.ts). A hard camera cut onto such a
// shot has no board at all (it is not there to be seen leaving). Shots that show the board without covering a display (performers, side
// angles) are untouched: the board keeps its job there.
import * as THREE from 'three';
import { HOST_KEY } from '../../shared/scene.ts';
import { viewActive } from '../../shared/goalsView.ts';
import type { StagePalette } from '../../shared/stage.ts';
import { HangingRig, type PropPlacement } from '../scene/chatRig.ts';
import { RoomRays } from '../scene/twoShot.ts';
import type { SceneRuntime } from '../scene/SceneRuntime.ts';
import { SHIELD_MARGIN_OFF, SHIELD_MARGIN_ON, boardCorners, boardCovers, type BoardShield } from './boardShield.ts';
import { drawBoard } from './goalsDraw.ts';
import { lookOf } from './goalsOverlay.ts';
import { goalsStore } from './goalsStore.ts';

const ASPECT = 9 / 16;
// scratch (the shot check runs 4× a second: no garbage)
const SQ = new THREE.Quaternion(), SV = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const W = 1280, H = 720;
const NO_PANELS: readonly never[] = [];
/** how often the board asks whether it covers a display (s) */
const YIELD_EVERY = 0.1;

export class GoalsWorld {
  private rt: SceneRuntime | null = null;
  private rays: RoomRays | null = null;
  private rig: HangingRig | null = null;
  private canvas = document.createElement('canvas');
  private g = this.canvas.getContext('2d')!;
  readonly texture = new THREE.CanvasTexture(this.canvas);
  private placeKey = '';
  private next: PropPlacement | null = null;
  private time = 0;
  private lastDraw = 0;
  private planFor = '';
  private drawnRev = -1;
  private drawnSec = -1;
  /** the board is up because it would cover a live timer display in this shot (boardShield.ts) */
  private yielding = false;
  /** Test pages: false = the board ignores timer displays (an A/B control: the same shot with the board hung in front of the clock). On in every real page. */
  shield = true;
  private yieldT = 0;
  private cornersOut = boardCorners(new THREE.Vector3(), 0, 1, ASPECT);
  private camPos = new THREE.Vector3();
  private camRot = new THREE.Quaternion();
  private camSeen = false;
  /** texture redraws so far (tests: idle = about one a second) */
  draws = 0;
  source = '';
  palette: StagePalette | null = null;

  constructor() {
    this.canvas.width = W; this.canvas.height = H;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
  }

  attach(rt: SceneRuntime) { if (this.rt === rt) return; this.detach(); this.rt = rt; this.rays = null; this.placeKey = ''; this.planFor = ''; }
  detach() { this.rig?.dispose(); this.rig = null; this.rt = null; this.next = null; this.placeKey = ''; this.planFor = ''; this.yielding = false; this.camSeen = false; }

  /** Is the board down AND readable in the current shot (the docked card steps aside only then)? */
  get shown() { return !!this.rig && this.rig.down && this.inShot; }
  private inShot = false;
  private shotT = 0;
  /** Most of the board on screen and big enough to read (≥ 85 % of it inside the frame, ≥ 14 % of the frame tall). */
  private checkShot() {
    const rt = this.rt, rig = this.rig;
    if (!rt || !rig) { this.inShot = false; return; }
    const cam = rt.stage.camera;
    const pl = rig.place, W = pl.width, H = W * ASPECT;
    const q = SQ.setFromAxisAngle(UP, pl.yaw);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
    for (const [sx, sy] of CORNERS) {
      const p = SV.set(sx * W / 2, sy * H / 2, 0).applyQuaternion(q).add(pl.center).project(cam);
      if (p.z > 1 || p.z < -1) behind = true;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    if (behind) { this.inShot = false; return; }
    const area = (x1 - x0) * (y1 - y0);
    const ix = Math.max(0, Math.min(1, x1) - Math.max(-1, x0)), iy = Math.max(0, Math.min(1, y1) - Math.max(-1, y0));
    this.inShot = area > 0 && (ix * iy) / area >= 0.85 && (Math.min(1, y1) - Math.max(-1, y0)) / 2 >= 0.14;
  }

  /**
   * Did the camera jump (a hard cut, not a glide) since the last frame? More than 2 m or about 20 degrees in one frame.
   * Called every frame (the pose it compares with has to be the last frame's).
   */
  private cut(cam: THREE.Camera) {
    let jumped = false;
    if (this.camSeen) jumped = cam.position.distanceToSquared(this.camPos) > 4 || 1 - Math.abs(cam.quaternion.dot(this.camRot)) > 0.03;
    this.camPos.copy(cam.position); this.camRot.copy(cam.quaternion); this.camSeen = true;
    return jumped;
  }

  /**
   * Is the board (hung where its anchor puts it) in front of a live timer display's panel in this shot? Sets `yielding` (with a wider clearance
   * to come back than to leave, so a camera drifting along the edge does not make it winch up and down). A hard cut onto a covering shot
   * snaps the board away instead of letting it winch up in front of the clock for the second it takes.
   */
  private checkYield(dt: number, wanted: boolean, shield: BoardShield | null) {
    const cam = this.rt?.stage.camera;
    const panels = shield && this.shield && wanted && cam ? shield.panels() : NO_PANELS;
    const jumped = cam ? this.cut(cam) : false;
    const place = this.next ?? this.rig?.place ?? null;
    if (!cam || !panels.length || !place) { this.yielding = false; this.yieldT = 0; return; }
    this.yieldT -= dt;
    if (this.yieldT > 0 && !jumped) return;
    this.yieldT = YIELD_EVERY;
    const cov = boardCovers(cam, boardCorners(place.center, place.yaw, place.width, ASPECT, this.cornersOut), place.center, panels, this.yielding ? SHIELD_MARGIN_OFF : SHIELD_MARGIN_ON);
    if (cov && !this.yielding && jumped && this.rig) { this.rig.target = 0; this.rig.finish(); }
    this.yielding = cov;
  }

  /** `chatBoardBusy` = the support board uses the chat board anchors right now; `shield` = the room's timer displays (the board keeps clear of them). */
  update(dt: number, chatBoardBusy: boolean, shield: BoardShield | null = null) {
    const rt = this.rt;
    this.time += dt;
    const v = goalsStore.view;
    const act = viewActive(v);
    const wanted = !!rt && !!v && v.show.world && (act.goals.length > 0 || act.timer);
    // the room's anchors only change with the host's spot / the support board: walk the room only then
    if (rt && wanted) {
      const k = `${rt.actors.get(HOST_KEY)?.spot?.index ?? -1}|${chatBoardBusy}`;
      if (k !== this.planFor) { this.planFor = k; this.plan(rt, chatBoardBusy); }
    }
    this.checkYield(dt, wanted, shield);
    const want = wanted && !this.yielding;
    if (this.rig) {
      const stale = !!this.next;
      this.rig.target = want && !stale ? 1 : 0;
      this.rig.update(dt, this.time);
      if (this.rig.away && (stale || !want)) { this.rig.dispose(); this.rig = null; if (!want) { this.planFor = ''; this.placeKey = ''; } }
    }
    if (!this.rig && want && this.next && rt) {
      this.rig = new HangingRig('board', this.next, ASPECT, this.texture, 'GOALS');
      this.drawnRev = -1;
      rt.root.add(this.rig.rig);
      this.next = null;
      this.rig.target = 1;
    }
    this.shotT -= dt;
    if (this.shotT <= 0) { this.shotT = 0.25; this.checkShot(); }
    // redraw (and re-upload the 1280×720 texture) only on change: a new view, a bar easing, a new second on the clock
    goalsStore.step();
    const sec = v?.sub && !v.sub.paused && !v.sub.ended ? Math.floor(goalsStore.now() / 1000) : 0;
    const due = !!v && (goalsStore.rev !== this.drawnRev || sec !== this.drawnSec || (goalsStore.moving && performance.now() - this.lastDraw > 110));
    if (this.rig?.rig.visible && v && due) {
      this.lastDraw = performance.now(); this.drawnRev = goalsStore.rev; this.drawnSec = sec; this.draws++;
      this.g.setTransform(1, 0, 0, 1, 0, 0);
      drawBoard(this.g, W, H, act.goals, v.show.what === 'goals' ? null : v.sub, v.cur, lookOf(this.palette, v.show.style, v.test), goalsStore.now());
      this.texture.needsUpdate = true;
    }
  }

  private plan(rt: SceneRuntime, chatBoardBusy: boolean) {
    const spot = rt.actors.get(HOST_KEY)?.spot ?? null;
    const idx = spot?.index ?? -1;
    let pl = this.anchors(rt, 'GOAL_BOARD', 'goalBoards', idx);
    if (!pl.length && !chatBoardBusy) pl = this.anchors(rt, 'CHAT_BOARD', 'chatBoards', idx);
    const p = pl[0] ?? null;
    const key = p ? `${p.source}|${p.center.toArray().map((x) => x.toFixed(2)).join(',')}|${p.width.toFixed(2)}` : '';
    if (key === this.placeKey) return;
    this.placeKey = key;
    this.source = p ? p.source : '';
    this.next = p;
  }

  private anchors(rt: SceneRuntime, prefix: string, jsonKey: string, spotIndex: number): PropPlacement[] {
    this.rays ??= new RoomRays(rt.room);
    const rays = this.rays;
    const out: PropPlacement[] = [];
    const nn = String(spotIndex + 1).padStart(2, '0');
    const want = new Set([`${prefix}_${nn}`, prefix]);
    const tagged: PropPlacement[] = [];
    rt.room.root.traverse((o) => {
      if (!want.has(o.name)) return;
      const p = o.getWorldPosition(new THREE.Vector3());
      if (o.name === prefix && spotIndex >= 0 && rt.room.spots[spotIndex] && p.distanceTo(rt.room.spots[spotIndex]!.position) > 6) return;
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      const wx = Number((o.userData as Record<string, unknown>).width);
      const width = Number.isFinite(wx) && wx > 0.2 ? wx : 1.6;
      (o.name === prefix ? out : tagged).push({ center: p, yaw: Math.atan2(f.x, f.z), width, ceilingY: rays.ceilingAbove(p) ?? p.y + width * ASPECT / 2 + 1.2, source: `node:${o.name}` });
    });
    const spotName = spotIndex >= 0 ? `SPOT_${nn}` : '';
    const j = (rt.info as unknown as Record<string, Record<string, { position?: number[]; yaw?: number; width?: number }> | undefined>)[jsonKey]?.[spotName];
    if (j && Array.isArray(j.position) && j.position.length === 3 && j.position.every((x) => Number.isFinite(x))) {
      const p = rt.room.root.localToWorld(new THREE.Vector3(...(j.position as [number, number, number])));
      const width = THREE.MathUtils.clamp(Number(j.width) || 1.6, 0.3, 5);
      tagged.push({ center: p, yaw: THREE.MathUtils.degToRad(Number(j.yaw) || 0), width, ceilingY: rays.ceilingAbove(p) ?? p.y + width * ASPECT / 2 + 1.2, source: `scene.json:${jsonKey}` });
    }
    return [...tagged, ...out];
  }

  debug() { return { source: this.source, down: !!this.rig?.down, inShot: this.inShot, yielding: this.yielding, lowered: +(this.rig?.lowered ?? 0).toFixed(2), draws: this.draws, target: this.rig?.target ?? 0, center: this.rig?.place.center.toArray().map((x) => +x.toFixed(2)) ?? null }; }
  dispose() { this.detach(); this.texture.dispose(); }
}
