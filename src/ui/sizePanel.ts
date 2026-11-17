// "Real size": the character's intended real height, its size class (micro … macro, shared/avatarSize.ts) and what that
// means in a room; plus the model's polycount against the party limit (shared/modelStats.ts).
//   sizeSection(app, redraw)     Advanced → Avatars (under "Loaded model")
//   sizeSimpleCard(app, redraw)  Simple → Me
// Saving goes through app.edit (the profile), then the party (guests' OBS pages) and the scene seats are told.
import * as THREE from 'three';
import type { App } from '../app.ts';
import { MAX_REAL, MIN_REAL, REF_HUMAN, SIZE_ICON, SIZE_LABEL, avatarSize, fmtM, readNative, shownHeight, sizeClassOf } from '../../shared/avatarSize.ts';
import { TRIS_MAX, TRIS_WARN, fmtTris } from '../../shared/modelStats.ts';
import { h, section, toast } from './dom.ts';
import { previewPartyLod } from './multiplayerPanel.ts';

const PRESETS: [string, number][] = [['🧚 Fairy', 0.25], ['🐾 Pet', 0.45], ['🧒 Chibi', 1.0], ['🧍 Human', REF_HUMAN], ['🧌 Ogre', 2.4], ['🗿 Giant', 4], ['🦖 Kaiju', 12]];

function parts(app: App, redraw: () => void, pillClass: string): (Node | string)[] {
  const p = app.profile!, rt = app.runtime;
  const size = avatarSize(p);
  const set = (height: number | null) => {
    app.edit((q) => { if (height === null) delete q.size; else q.size = { height: Math.round(THREE.MathUtils.clamp(height, MIN_REAL, MAX_REAL) * 1000) / 1000 }; }, false);
    // party guests' OBS pages (the shared profile carries it) + this room's seats (size classes pick the spots)
    void app.party.setAvatar(app.profile!);
    app.scene.sizesChanged();
    redraw();
  };
  const native = rt ? rt.bounds().getSize(new THREE.Vector3()).y : NaN;
  const nat = readNative(native);
  const input = h('input', { type: 'number', min: String(MIN_REAL), max: String(MAX_REAL), step: '0.01', value: size.auto ? '' : String(size.height), placeholder: `${REF_HUMAN} (auto)`, style: 'width:90px', 'aria-label': 'Real height in metres',
    onChange: (e: Event) => { const v = parseFloat((e.target as HTMLInputElement).value); set(Number.isFinite(v) && v > 0 ? v : null); } });
  const base = 1.5;
  const shown = shownHeight(size, base);
  const cls = size.cls;
  const out: (Node | string)[] = [
    h('p', { class: 'note' }, h('b', null, `${SIZE_ICON[cls]} ${SIZE_LABEL[cls]}`), size.auto ? ` — auto: an ordinary human (${fmtM(REF_HUMAN)}).` : ` — ${fmtM(size.height)} real height.`),
    h('label', { class: 'row', title: 'How tall this character really is. Empty = an ordinary human (every human-sized avatar is shown at the room’s height).' },
      h('span', { class: 'lbl' }, 'Real height (m)'), input),
    h('div', { class: pillClass === 's-pill' ? 's-pills' : 'btns tight' }, ...PRESETS.map(([l, v]) => {
      const on = (!size.auto && Math.abs(size.height - v) < 1e-3) || (size.auto && v === REF_HUMAN);
      return h('button', { class: pillClass === 's-pill' ? `s-pill ${on ? 'on' : ''}` : `btn ${on ? 'active' : ''}`, 'aria-pressed': String(on), onClick: () => set(v === REF_HUMAN ? null : v) }, l);
    })),
    h('p', { class: 'note' }, cls === 'normal'
      ? `In rooms: shown at the room’s height like every human-sized performer (${fmtM(base)} in most rooms).`
      : cls === 'micro' ? `In rooms: ${fmtM(shown)} tall next to ${fmtM(base)} humans — on a table-top perch or hovering beside someone, with a close-up talk camera.`
        : cls === 'macro' ? `In rooms: up to ${fmtM(shown)} tall next to ${fmtM(base)} humans — at the back of the room with head room (never through the ceiling).`
          : `In rooms: ${fmtM(shown)} tall next to ${fmtM(base)} humans.`),
  ];
  if (rt && Number.isFinite(native)) {
    out.push(h('p', { class: 'note' }, `Your model file: ${nat.note}. `, nat.unit === 'cm' || nat.unit === 'mm' ? 'Rooms size it correctly anyway (only the real height above counts).' : ''));
    // the model's own size says "tiny" / "huge" and nobody set a height yet: offer it
    const guess = sizeClassOf(nat.metres);
    if (size.auto && nat.unit === 'm' && guess !== 'normal') out.push(h('div', { class: pillClass === 's-pill' ? 's-pills' : 'btns tight' },
      h('button', { class: pillClass === 's-pill' ? 's-pill' : 'btn', onClick: () => set(nat.metres) }, `Use its own size (${fmtM(nat.metres)} → ${SIZE_LABEL[guess]})`)));
  }
  // polycount vs the party limit
  if (rt) {
    const t = rt.info.triangles, lim = app.party.role === 'none' ? TRIS_MAX : app.party.trisLimit;
    const col = t > lim ? '#f57' : t > TRIS_WARN ? '#f5c451' : '';
    const auto = app.party.autoLod;
    out.push(h('p', { class: 'note', style: col ? `color:${col}` : '' }, `Multiplayer: ${fmtTris(t)} triangles`,
      t > lim ? (auto ? ` — over the party limit of ${fmtTris(lim)}, so parties get an automatic party version (face, eyes, mouth shapes and rig kept; body and clothes simplified). Your original stays as it is.`
        : ` — the party limit is ${fmtTris(lim)}; decimate it or pick a lighter model (or turn on the automatic party version under Multiplayer).`)
        : t > TRIS_WARN ? ` — heavy (warning above ${fmtTris(TRIS_WARN)}, limit ${fmtTris(lim)}).` : ` ✔ light enough to share in parties (limit ${fmtTris(lim)})`));
    if (t > lim && auto) out.push(h('div', { class: pillClass === 's-pill' ? 's-pills' : 'btns tight' }, h('button', {
      class: pillClass === 's-pill' ? 's-pill' : 'btn', disabled: app.observer,
      title: app.observer ? 'Observer sandbox: nothing is written' : 'Makes the party version (a second file in this avatar’s folder) and shows it in its own window',
      onClick: async () => {
        try {
          const r = await fetch(`/api/avatars/${encodeURIComponent(p.id)}/party-lod`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max: lim, costume: p.costume ?? '' }) });
          const st = await r.json() as { ready?: boolean; tris?: number; error?: string };
          if (!r.ok || !st.ready) throw new Error(st.error ?? String(r.status));
          toast(`Party version: ${fmtTris(st.tris ?? 0)} triangles`, 'ok');
          previewPartyLod(p.id, lim, p.costume ?? null);
        } catch (e) { toast(`Party version failed: ${(e as Error).message}`, 'err', 8000); }
      } }, 'Preview party version')));
  }
  return out;
}

/** Advanced → Avatars. */
export function sizeSection(app: App, redraw: () => void): HTMLElement {
  return section('Real size', ...parts(app, redraw, 'btn'));
}

/** Simple → Me. */
export function sizeSimpleCard(app: App, redraw: () => void): HTMLElement | null {
  if (!app.profile) return null;
  return h('section', { class: 's-card' }, h('h3', null, '📏 Real size'),
    h('p', { class: 'lead' }, 'How big is your character really? Fairies sit on the desk, giants stand at the back — everyone human-sized is shown the same height.'),
    ...parts(app, redraw, 's-pill'));
}
