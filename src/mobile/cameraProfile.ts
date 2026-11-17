// The phone tracking profile (src/tracking/camera.ts openCamera asks this first):
//   * the FRONT camera (facingMode 'user') unless you picked a camera yourself (vtp.camChosen): the studio's automatic
//     pick takes the first camera the browser lists, which on many Android phones is the BACK camera;
//   * about 720p at 30 fps: the face tracker needs no more, and a phone runs cooler.
// Face-only tracking for 2D avatars on a phone: faceOnlyParts (src/app.ts, one line at each tracker start).
import type { CameraRequest } from '../tracking/camera.ts';
import { isPhone } from './device.ts';

/** Pure rule (tools/mobile2d_unit.ts). null = not a phone: the desktop request as it is. */
export function phoneRequestRule(req: CameraRequest, o: { phone: boolean; chosen: boolean }): { req: CameraRequest; facing: boolean } | null {
  if (!o.phone) return null;
  return { req: { ...req, deviceId: o.chosen ? req.deviceId : undefined, width: Math.min(req.width || 1280, 1280), height: Math.min(req.height || 720, 720), fps: 30 }, facing: !o.chosen || !req.deviceId };
}
export function phoneCameraRequest(req: CameraRequest): { req: CameraRequest; facing: boolean } | null {
  let chosen = false;
  try { chosen = !!localStorage.getItem('vtp.camChosen'); } catch { /* storage off */ }
  return phoneRequestRule(req, { phone: isPhone(), chosen });
}

/** The Hands / Body parts the tracker starts with: a 2D avatar on a phone tracks the face only (the body and hand
 *  models are never downloaded or run: 13+ MB of models, and the heat). */
export function faceOnlyParts<T extends { body: boolean; hands: boolean }>(parts: T, flat: boolean): T {
  return isPhone() && flat ? { ...parts, body: false, hands: false } : parts;
}
