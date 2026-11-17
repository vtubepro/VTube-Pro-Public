// "Neck & head" (Advanced → Tracking, under Feel): neck length + how head tracking moves a long neck (llamas, giraffes).
// Settings live in AvatarProfile.neck (shared/neck.ts). Every control is live (no rebuild) and saved per avatar; a
// setting left on "auto" follows the neck's length (longer neck → stiffer, calmer, less sway / tilt, tighter turn limit).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { NECK_LIMITS, NECK_PRESETS, neckAuto, neckLabel, neckLongness, type NeckConfig, type NeckKey } from '../../shared/neck.ts';
import { debounce, h, section, select, slider } from './dom.ts';
import { isStoredBody } from '../../shared/bodyKind.ts';

type Motion = Exclude<NeckKey, 'length'>;

/** One neck field: slider + number box + ↺ (dom.ts slider(); ↺ = the AUTO value for this neck). Landing exactly on the
 *  auto value (↺ or typing it) puts the field back on auto, so it keeps following the neck length. */
function neckRow(label: string, key: NeckKey, value: number, auto: boolean, autoValue: number, step: number, set: (v: number | null) => void,
  hint: string, fmt: (v: number) => string, unit: string, scale = 1) {
  const [lo, hi] = NECK_LIMITS[key];
  return slider(`${label}${auto ? ' (auto)' : ''}`, value, lo, hi, step,
    (v) => set(Math.abs(v - autoValue) < step * 0.5 ? null : Math.min(hi, Math.max(lo, v))), hint, fmt, { def: autoValue, unit, scale });
}

export function neckSection(app: App, redraw: () => void): HTMLElement | null {
  const rt = app.runtime, p = app.profile;
  const rig = rt?.neck;
  if (!rt || !p || !rig) return null;
  const cfg: NeckConfig = p.neck ?? {};
  const later = debounce(redraw, 400);
  const edit = (fn: (q: AvatarProfile) => void, redrawAfter = false) => {
    app.edit((q) => { fn(q); if (q.neck && !Object.keys(q.neck).length) delete q.neck; }, false);
    if (redrawAfter) later();
  };
  const setField = (k: NeckKey, v: number | null) => edit((q) => {
    const n: NeckConfig = { ...(q.neck ?? {}) };
    if (v === null) delete n[k]; else n[k] = v;
    q.neck = n;
  }, v === null || k === 'length');

  rig.configure(p.neck);                                       // (the rig re-resolves every frame; do it now for the panel)
  const info = rig.info();
  const S = info.settings;
  const autoNow = neckAuto(neckLongness(info.restLength, info.height, S.length));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const row = (label: string, k: Motion, step: number, hint: string, fmt: (v: number) => string, unit: string, scale = 1) =>
    neckRow(label, k, S[k], !!S.auto[k], autoNow[k], step, (v) => setField(k, v), hint, fmt, unit, scale);
  const lenBtn = ([l, v]: readonly [string, number]) => {
    const on = Math.abs(S.length - v) < 1e-3;
    return h('button', { class: `btn ${on ? 'active' : ''}`, 'aria-pressed': String(on), onClick: () => setField('length', v === 1 ? null : v) }, l);
  };
  const cm = (m: number) => `${Math.round(m * 100)} cm`;
  const bodySel = select('Body', isStoredBody(p.body) ? p.body : 'biped', [['biped', 'Two legs (arms + legs tracked)'], ['quadruped', 'Four legs (llama, giraffe, dog…)'], ['mech', 'Walking machine (pilot in a cockpit)'], ['object', 'A thing (bends and sways, stays put)'], ['serpent', 'Snake or worm (slithers)']],
    (v) => app.edit((q) => { if (isStoredBody(v)) q.body = v; else delete q.body; }, true),
    'Four legs: your face, head and neck drive it; arm / hand / leg tracking is ignored, the legs stay planted with a little idle life (tail, ears, weight shift) and walk in rooms; it stands next to seats instead of sitting. Walking machine: the pilot is tracked (head always, arms while parked); its legs walk only when it travels in a room, with the hands on the control sticks (needs the machine bones: mpelvis, mleg_*, mstick_*).');
  // walking machines (src/avatar/mech.ts; desert_walker SPEC §2.9): the machine's size around its pilot + the hands
  const mech = p.body === 'mech' ? [
    slider('Walker scale', p.mech?.heroScale ?? 1, 1, 2, 0.05, (v) => app.edit((q) => { q.mech = { ...(q.mech ?? {}), heroScale: Math.round(v * 100) / 100 }; }, false),
      'How big the machine is around its pilot: 1 = true scale (the pilot’s face matches everyone else in the room), up to 2 = a bigger hero machine (and a bigger pilot). Uses the profile’s pilotHeight.', (v) => `${v.toFixed(2)}×`),
    select('Hands', p.mech?.pilot?.hands ?? 'auto', [['auto', 'On the controls while it walks'], ['grip', 'Always on the controls'], ['free', 'Always tracked']],
      (v) => app.edit((q) => { q.mech = { ...(q.mech ?? {}), pilot: { ...(q.mech?.pilot ?? {}), hands: v } }; }, true),
      'While it walks in a room the pilot’s hands hold the control sticks (the head is always tracked); parked, your arms are tracked again.'),
  ] : [];
  return section('Neck & head',
    bodySel,
    ...mech,
    h('p', { class: 'note' }, `Neck: ${info.joints} bone${info.joints === 1 ? '' : 's'}, ${cm(info.restLength * S.length)} (${neckLabel(S.longness)}). `,
      'Settings marked auto follow the neck length: a longer neck bends as a calm curve, sways less and never whips the head around.'),
    neckRow('Neck length', 'length', S.length, cfg.length === undefined, 1, 0.01, (v) => setField('length', v === null ? null : v),
      'Stretch or shorten the neck (1× = as modelled). Live; saved with this avatar.', (v) => `${v.toFixed(2)}×`, '×'),
    h('div', { class: 'btns tight' }, ...NECK_PRESETS.map(lenBtn)),
    row('Head sway', 'sway', 0.01, 'How much of your body lean, breathing and bounce reaches the neck. 100% = all of it (the head travels with the body); low = the neck stays upright and the head stays put', pct, '%', 100),
    row('Head tilt', 'tilt', 0.01, 'How much the head rolls when you tilt yours (100% = your real tilt)', pct, '%', 100),
    row('Neck stiffness', 'stiffness', 0.01, 'How head turns spread down the neck: 0% = the whole neck bends in a smooth curve (swan), 100% = the head turns on a still neck (no whip)', pct, '%', 100),
    row('Max head turn', 'maxTurn', 1, 'Soft limit on how far the head turns / nods (degrees). Lower keeps a long neck from swinging the head too far', (v) => `${Math.round(v)}°`, '°'),
    row('Head smoothing', 'smoothing', 0.01, 'Extra smoothing of head rotation for long necks (more = calmer, a little laggier)', pct, '%', 100),
    rig.joints > 1 || S.longness > 0.02 || p.neck ? null : h('p', { class: 'note' }, 'A human-length neck: everything on auto keeps the standard head motion.'),
  );
}
