// The hanging goals board never covers a live timer display (beta.14). Pure geometry (three.js only): is the board, hung where the room
// anchors it, in front of a timer display's glass panel in what the camera sees? goalsWorld.ts asks this a few times a second and
// winches the board up while the answer is yes (the docked card carries the goals meanwhile); timerDisplays.ts supplies the panels.
//
// Why a screen-space rule and not "never hang over a display": a board 5 m in front of a display covers it only from some cameras (head
// on), and rooms put their boards in front of the thing the clock is built into on purpose (a clock set into a statue, a sign, a screen). The
// board keeps its job in every shot where it does not sit in front of the clock: performer shots, side angles, shots that frame
// only one of the two.
import * as THREE from 'three';

/** A live display's glass panel (the dark strip the digits sit on) in the world. */
export interface ShieldPanel {
  /** top-left, top-right, bottom-right, bottom-left */
  corners: readonly THREE.Vector3[];
  centre: THREE.Vector3;
}

/** What goalsWorld.ts asks of the timer displays: their panels while they are live (empty = nothing to keep clear). */
export interface BoardShield { panels(): readonly ShieldPanel[] }

/** How far (fraction of the panel's size, each side) the board must stay clear of a panel before it may hang again / is told to leave. */
export const SHIELD_MARGIN_ON = 0.08, SHIELD_MARGIN_OFF = 0.16;
/** The housing + yoke above the display (m): they hang with it and are part of what covers the shot. */
export const BOARD_HEAD = 0.3;

const V = new THREE.Vector3();
const CP = new THREE.Vector3();
const Q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const BOX = [0, 0, 0, 0];

/** The board's four world corners when fully down (top-left first), housing included on the top edge. `out` is filled in place. */
export function boardCorners(center: THREE.Vector3, yaw: number, width: number, aspect: number, out: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]): THREE.Vector3[] {
  const hw = width / 2, hh = width * aspect / 2;
  Q.setFromAxisAngle(UP, yaw);
  const set = (i: number, x: number, y: number) => out[i].set(x, y, 0).applyQuaternion(Q).add(center);
  set(0, -hw, hh + BOARD_HEAD); set(1, hw, hh + BOARD_HEAD); set(2, hw, -hh); set(3, -hw, -hh);
  return out;
}

/** The corners' bounding box in the camera's NDC (x0, y0, x1, y1) into BOX; false when any corner is behind the camera (not drawable as a box). */
function ndcBox(cam: THREE.Camera, corners: readonly THREE.Vector3[]): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of corners) {
    V.copy(c).applyMatrix4(cam.matrixWorldInverse);
    if (V.z >= -0.05) return false;
    V.applyMatrix4(cam.projectionMatrix);
    x0 = Math.min(x0, V.x); x1 = Math.max(x1, V.x); y0 = Math.min(y0, V.y); y1 = Math.max(y1, V.y);
  }
  BOX[0] = x0; BOX[1] = y0; BOX[2] = x1; BOX[3] = y1;
  return true;
}

/**
 * Does the board, hung at `board` (its corners + centre), cover any of the `panels` in this camera's picture? Yes when the board's box and
 * a panel's box (grown by `margin` of its size each side) overlap inside the frame AND the board is the nearer one. A panel that is off
 * screen or behind the camera is nobody's clock: no. A board partly behind the camera is in the viewer's face: yes while any panel is in front.
 * No allocation (scratch vectors).
 */
export function boardCovers(cam: THREE.PerspectiveCamera, board: readonly THREE.Vector3[], boardCentre: THREE.Vector3, panels: readonly ShieldPanel[], margin: number): boolean {
  if (!panels.length) return false;
  cam.updateMatrixWorld();
  const boardBox = ndcBox(cam, board);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0;
  if (boardBox) { b0 = BOX[0]; b1 = BOX[1]; b2 = BOX[2]; b3 = BOX[3]; }
  cam.getWorldPosition(CP);
  const dBoard = CP.distanceTo(boardCentre);
  for (const p of panels) {
    if (!ndcBox(cam, p.corners)) continue;
    const mx = (BOX[2] - BOX[0]) * margin + 0.005, my = (BOX[3] - BOX[1]) * margin + 0.005;
    const px0 = Math.max(-1, BOX[0] - mx), py0 = Math.max(-1, BOX[1] - my), px1 = Math.min(1, BOX[2] + mx), py1 = Math.min(1, BOX[3] + my);
    // (the panel itself, not its margin, has to be in the frame: a margin alone reaching into the frame is not a clock on screen)
    if (BOX[0] >= 1 || BOX[2] <= -1 || BOX[1] >= 1 || BOX[3] <= -1) continue;
    const near = dBoard < CP.distanceTo(p.centre) + 0.3;
    if (!boardBox) { if (near) return true; continue; }
    if (!near) continue;
    if (Math.max(b0, px0) < Math.min(b2, px1) && Math.max(b1, py0) < Math.min(b3, py1)) return true;
  }
  return false;
}
