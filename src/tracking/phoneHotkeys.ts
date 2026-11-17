// VTube Studio phone buttons 1–8 → the studio action the performer picked (shared/phoneHotkeys.ts plans it). The helper
// sends {type:'command', command:'phone-hotkey', args:{n}} on each tap (server/tracking/manager.ts); src/app.ts calls
// runPhoneHotkey(). The choice lives in this browser (localStorage vtp.phoneKeys); an observer studio never acts.
import type { App } from '../app.ts';
import { DEFAULT_PHONE_HOTKEYS, planHotkey, sanitizeHotkeys, type PhoneHotkey } from '../../shared/phoneHotkeys.ts';
import { toast } from '../ui/dom.ts';
import { sameKey } from '../../shared/rig2d/userParams.ts';

const KEY = 'vtp.phoneKeys';
export function loadPhoneHotkeys(): PhoneHotkey[] {
  try { return sanitizeHotkeys(JSON.parse(localStorage.getItem(KEY) ?? 'null')); } catch { return DEFAULT_PHONE_HOTKEYS.slice(); }
}
export function savePhoneHotkeys(list: PhoneHotkey[]) {
  try { localStorage.setItem(KEY, JSON.stringify(sanitizeHotkeys(list))); } catch { /* storage off */ }
}

let held3d: string | null = null;
/** The last button tapped (for the "Phone buttons" panel's live light). */
export const lastPhoneHotkey = { n: 0, at: 0, did: '' };

/**
 * One of the model's own keys, matched BY COMBO (modifiers included; reserved keys were refused when it was picked):
 * a Pro2D model's sliders / outfits / expressions (src/ui/rig2dSliders.ts matches the combo the same way the keyboard
 * does), else any 2D model's expression or motion saved on that key. Never the studio's keyboard handler (flatHotkey
 * ignores Ctrl / Alt / Meta keys for expressions). Returns what happened ('' = the model has nothing on that key).
 */
export async function runModelKey(app: App, combo: string): Promise<string> {
  const m = /^(Ctrl\+)?(Alt\+)?(Shift\+)?(Meta\+)?([A-Za-z0-9]+)$/.exec(combo);
  if (!m) return '';
  const { rig2dSliderHotkey } = await import('../ui/rig2dSliders.ts');
  const ev = new KeyboardEvent('keydown', { code: m[5], ctrlKey: !!m[1], altKey: !!m[2], shiftKey: !!m[3], metaKey: !!m[4], cancelable: true });
  if (rig2dSliderHotkey(ev, app)) return 'Model key';
  const fl = app.runtime?.flat;
  if (!fl) return '';
  const ex = fl.expressions().find((x) => x.key && sameKey(x.key, combo));
  if (ex) { const on = app.flatCue.s !== ex.id; app.setFlatExpression(on ? ex.id : null); return on ? ex.name : 'Default look'; }
  const mo = fl.motions().find((x) => x.key && sameKey(x.key, combo));
  if (mo) { app.playFlatMotion(mo.group, mo.index); return 'Motion'; }
  return '';
}

export async function runPhoneHotkey(app: App, n: number): Promise<string> {
  if (app.observer) return 'observer';
  const fl = app.runtime?.flat ?? null;
  const plan = planHotkey(n, loadPhoneHotkeys(), fl ? fl.expressions() : null);
  let did = '';
  switch (plan.do) {
    case 'flat-expression': {
      const on = app.flatCue.s !== plan.id;
      app.setFlatExpression(on ? plan.id : null);
      did = on ? plan.name : 'Default look';
      break;
    }
    case '3d-expression': {
      // a real toggle: held until the next tap (no time limit), then back to the tracked face
      const on = held3d !== plan.name;
      app.preview(on ? plan.name : 'Neutral', on ? Infinity : 0.05);
      held3d = on ? plan.name : null;
      did = on ? plan.name : 'Default face';
      break;
    }
    case 'key': did = await runModelKey(app, plan.combo); break;
    case 'deck': {
      // "Recalibrate" while the phone drives the face = re-centre the phone's rest pose
      if (plan.action === 'recalibrate' && app.trackingSource !== 'webcam') { app.external.recenter(0.8, true); did = 'Re-centred'; break; }
      const r = await fetch(`/api/deck/run/${encodeURIComponent(plan.action)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: plan.params }) }).catch(() => null);
      did = r?.ok ? plan.action : '';
      break;
    }
    case 'nothing': did = ''; break;
  }
  Object.assign(lastPhoneHotkey, { n, at: Date.now(), did });
  if (did) toast(`Phone button ${n}: ${did}`, 'ok', 1200);
  return did;
}
