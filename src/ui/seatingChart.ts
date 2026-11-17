// Seating chart (docs/ROOM_EDITOR.md → "Seating chart"): a top-down map of the room's places (SPOT_xx, size spots) with
// their names and who sits where. Drag a person onto a place (or tap the person, then the place) to seat them there;
// whoever sat there swaps. Size-aware: while dragging, every place shows whether it suits that performer (green = made
// for them, amber = works, red = never: a giant on a bar stool, a mech on a couch) and a refused seat says why. The
// choice is remembered per room by the scene controller (the host's own pick per room; guests by their Discord id or
// name) — this chart only drives SceneController.move.
//
//   mountSeatingChart(el, app) → the chart (one mount function; the layout decides where it lives). Returns unmount.
import type { App } from '../app.ts';
import { SIZE_ICON } from '../../shared/avatarSize.ts';
import { h } from './dom.ts';

const CSS = `
.seat-chart { position:relative; user-select:none; }
.seat-chart svg { width:100%; display:block; color:var(--dim, #8d99ae); background:var(--card2, #12151b); border:1px solid var(--line, #283041); border-radius:8px; touch-action:none; }
.seat-chart .seat circle { fill:var(--card, #1d2330); stroke:var(--dim, #4a5568); stroke-width:2; }
.seat-chart .seat.taken circle { fill:var(--accent2, #6cc7f5); stroke:var(--accent2, #6cc7f5); }
.seat-chart .seat.fit2 circle { stroke:#7bd88f; stroke-width:3; } .seat-chart .seat.fit1 circle { stroke:#ffd166; stroke-width:3; } .seat-chart .seat.fit0 circle { stroke:#ff5d6c; stroke-width:3; opacity:.6; }
.seat-chart .seat.hot circle { fill:#28405a; }
.seat-chart .seat text { font:600 11px Inter, system-ui, sans-serif; fill:var(--text, #c9d2e3); pointer-events:none; text-anchor:middle; }
.seat-chart .seat text.who { font-weight:800; fill:#06131a; }
.seat-chart .seat line { stroke:var(--dim, #8d99ae); stroke-width:2; pointer-events:none; }
.seat-people { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 4px; }
.seat-chip { display:inline-flex; align-items:center; gap:5px; padding:6px 11px; border-radius:16px; background:var(--card2, #232a38); color:var(--text, #e7ebf3); border:1px solid var(--line, #344055); cursor:grab; font-size:12px; touch-action:none; }
.seat-chip.sel { border-color:var(--accent2, #6cc7f5); box-shadow:0 0 0 1px var(--accent2, #6cc7f5) inset; } .seat-chip .at { color:var(--dim, #8d99ae); }
.seat-ghost { position:fixed; z-index:9999; pointer-events:none; padding:4px 9px; border-radius:14px; background:#6cc7f5; color:#06131a; font:700 12px system-ui; transform:translate(-50%, -130%); }
.seat-warn { color:var(--warn, #ffb454); font-size:12px; margin:4px 0; font-weight:600; } .seat-note { color:var(--dim, #8d99ae); font-size:12px; margin:4px 0; }
`;
let cssDone = false;

type Seat = { index: number; label: string; pose: 'sit' | 'stand'; x: number; z: number; yaw: number; sizes?: import('../../shared/avatarSize.ts').SizeClass[] | null; sizeSpot?: 'auto' | 'json' };

export function mountSeatingChart(el: HTMLElement, app: App): () => void {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const box = h('div', { class: 'seat-chart' });
  el.append(box);
  let picked: string | null = null;           // tap-to-seat: the person picked
  let drag: { key: string; ghost: HTMLElement } | null = null;
  let hot: number | null = null;
  // without a preview (no room summary yet) the places come from the helper (GLB + scene.json + the user's edits)
  const placesOf = new Map<string, Seat[] | 'loading' | null>();
  const fetchPlaces = (id: string) => {
    placesOf.set(id, 'loading');
    void fetch(`/api/rooms/${encodeURIComponent(id)}/edits`).then((r) => r.json()).then((j: { anchors?: { places?: { key: string; label?: string; pos: number[]; yawDeg: number; pose: 'sit' | 'stand' }[] } | null }) => {
      placesOf.set(id, (j.anchors?.places ?? []).map((p) => ({ index: +p.key.slice(5) - 1, label: p.label ?? p.key.replace('SPOT_', 'Spot '), pose: p.pose, x: p.pos[0], z: p.pos[2], yaw: (p.yawDeg * Math.PI) / 180, sizes: null })));
      draw();
    }).catch(() => { placesOf.set(id, null); draw(); });
  };

  const draw = () => {
    const st = S.effective;
    const sum = st.sceneId ? S.rooms.get(st.sceneId) : null;
    if (!st.sceneId) { box.replaceChildren(h('p', { class: 'seat-note' }, 'Classic layout: pick a room to seat people in it.')); return; }
    let seats: Seat[];
    if (sum) seats = sum.spots.filter((s): s is NonNullable<typeof s> => !!s);
    else {
      const got = placesOf.get(st.sceneId);
      if (got === undefined) fetchPlaces(st.sceneId);
      if (!Array.isArray(got) || !got.length) { box.replaceChildren(h('p', { class: 'seat-note' }, got === null ? 'Could not read the places of this room.' : 'Loading the places of this room…')); return; }
      seats = got;
    }
    const labelOf = (i: number) => seats.find((s) => s.index === i)?.label ?? `#${i + 1}`;
    const members = S.members();
    const whoAt = new Map<number, { key: string; name: string }>();
    for (const m of members) { const i = st.spots[m.key]; if (i !== undefined && st.present[m.key] !== false) whoAt.set(i, m); }
    // the map: x right, +Z (stage front, towards the cameras) down
    const xs = seats.map((s) => s.x), zs = seats.map((s) => s.z);
    let x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const pad = 1.2;
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad;
    if (x1 - x0 < 4) { const c = (x0 + x1) / 2; x0 = c - 2; x1 = c + 2; }
    if (z1 - z0 < 3) { const c = (z0 + z1) / 2; z0 = c - 1.5; z1 = c + 1.5; }
    const W = Math.max(320, Math.min(720, box.clientWidth || 600)), k = W / (x1 - x0), H = Math.max(200, Math.min(520, (z1 - z0) * k));
    const kz = H / (z1 - z0);
    const P = (x: number, z: number) => [(x - x0) * k, (z - z0) * kz] as const;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const front = document.createElementNS(ns, 'text');
    front.setAttribute('x', String(W / 2)); front.setAttribute('y', String(H - 6)); front.setAttribute('fill', 'currentColor'); front.setAttribute('opacity', '0.5'); front.setAttribute('font-size', '11'); front.setAttribute('text-anchor', 'middle');
    front.textContent = 'cameras / stage front ↓';
    svg.append(front);
    const dk = drag?.key ?? picked;
    // labels of places close together alternate above / below (a desk row of four would overlap), and long ones shrink
    const above = new Set<number>();
    const byX = [...seats].sort((a, b2) => P(a.x, a.z)[0] - P(b2.x, b2.z)[0]);
    byX.forEach((s, i) => {
      const prev = byX[i - 1];
      if (!prev) return;
      const [x1, y1] = P(s.x, s.z), [x0, y0] = P(prev.x, prev.z);
      if (Math.abs(x1 - x0) < 90 && Math.abs(y1 - y0) < 34 && !above.has(prev.index)) above.add(s.index);
    });
    for (const s of seats) {
      const [cx, cy] = P(s.x, s.z);
      const g = document.createElementNS(ns, 'g');
      const who = whoAt.get(s.index);
      const fit = dk ? S.spotFitFor(dk, s.index) : null;
      g.setAttribute('class', `seat${who ? ' taken' : ''}${fit !== null ? ` fit${fit}` : ''}${hot === s.index ? ' hot' : ''}`);
      g.dataset.spot = String(s.index);
      const r = s.sizeSpot ? 11 : 15;
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
      c.dataset.spot = String(s.index);
      const ln = document.createElementNS(ns, 'line');
      ln.setAttribute('x1', String(cx)); ln.setAttribute('y1', String(cy));
      ln.setAttribute('x2', String(cx + Math.sin(s.yaw) * (r + 7))); ln.setAttribute('y2', String(cy + Math.cos(s.yaw) * (r + 7)));
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', String(cx)); t.setAttribute('y', String(above.has(s.index) ? cy - r - 6 : cy + r + 12));
      const lab = `${s.label}${s.pose === 'sit' ? '' : ' (stand)'}${s.sizes?.length ? ` ${s.sizes.map((z) => SIZE_ICON[z] ?? '').join('')}` : ''}`;
      t.textContent = lab.length > 22 ? `${lab.slice(0, 21)}…` : lab;
      g.append(c, ln, t);
      if (who) {
        const w = document.createElementNS(ns, 'text');
        w.setAttribute('class', 'who'); w.setAttribute('x', String(cx)); w.setAttribute('y', String(cy + 4));
        w.textContent = who.name.replace(/ \((host|you|test)\)$/, '').slice(0, 10);
        g.append(w);
      }
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${s.label}${who ? ` — ${who.name}` : ' — free'}${fit === 0 ? ' · does not suit them' : fit === 1 ? ' · works for them' : fit === 2 ? ' · made for them' : ''}`;
      g.append(title);
      g.addEventListener('click', () => { if (picked && S.canEdit) { S.move(picked, s.index); picked = null; draw(); } });
      svg.append(g);
    }
    const chips = members.map((m) => {
      const i = st.spots[m.key];
      const at = i !== undefined ? labelOf(i) : 'not seated';
      const chip = h('span', { class: `seat-chip${picked === m.key ? ' sel' : ''}`, title: S.canEdit ? 'Drag onto a place, or tap here then tap a place' : '' },
        m.size && m.size.cls !== 'normal' ? `${SIZE_ICON[m.size.cls] ?? ''} ` : '', m.name, h('span', { class: 'at' }, `· ${at}`));
      if (S.canEdit) chip.addEventListener('pointerdown', (e) => startDrag(e, m.key, m.name));
      return chip;
    });
    box.replaceChildren(
      svg,
      h('div', { class: 'seat-people' }, ...chips),
      ...(S.sizeWarning ? [h('div', { class: 'seat-warn' }, S.sizeWarning)] : []),
      ...S.sizeNotes().slice(0, 4).map((n) => h('div', { class: 'seat-note' }, n)),
      h('div', { class: 'seat-note' }, S.canEdit ? 'Your pick is remembered for this room. Green = made for them, amber = works, red = too big / small for that place.' : 'The host seats everyone in this room.'),
    );
  };

  const seatAt = (x: number, y: number): number | null => {
    const t = document.elementFromPoint(x, y) as (Element & { dataset?: DOMStringMap }) | null;
    const g = t?.closest?.('[data-spot]') as (Element & { dataset: DOMStringMap }) | null;
    return g ? +g.dataset.spot! : null;
  };
  const startDrag = (e: PointerEvent, key: string, name: string) => {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const ghost = h('div', { class: 'seat-ghost' }, name.replace(/ \((host|you|test)\)$/, ''));
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      if (!moved) { moved = true; drag = { key, ghost }; document.body.append(ghost); draw(); }
      ghost.style.left = `${ev.clientX}px`; ghost.style.top = `${ev.clientY}px`;
      const s = seatAt(ev.clientX, ev.clientY);
      if (s !== hot) { hot = s; draw(); }
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      ghost.remove();
      if (moved) { const s = seatAt(ev.clientX, ev.clientY); drag = null; hot = null; if (s !== null) S.move(key, s); }
      else picked = picked === key ? null : key;          // a tap: pick (then tap a place)
      draw();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  let last = '';
  const off = S.on(() => {
    const st = S.effective, sum = st.sceneId ? S.rooms.get(st.sceneId) : null;
    const sig = JSON.stringify([st.sceneId, st.spots, st.present, sum?.spots.length, S.sizeWarning, S.members().map((m) => m.key + m.name)]);
    if (sig !== last && !drag) { last = sig; draw(); }
  });
  draw();
  return () => { off(); box.remove(); };
}
