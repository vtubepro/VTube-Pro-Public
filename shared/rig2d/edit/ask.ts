// When the auto-rig could not tell what something is, it ASKS WITH PICTURES: "Which of these is your left eye?" next to
// thumbnails of the likely layers, never with layer names or rigging words. This file picks the questions and the
// candidate layers (most likely first) and applies the answers. Pure (no DOM); the editor draws the thumbnails.
import type { EdDoc, EdMesh, EdTexture } from './doc.ts';
import { classifyLayers, faceVotes, type Role, type Side } from './classify.ts';
import type { ArtLayer } from './layers.ts';
import { applyAutoRig, ROLE_DEPTH } from './autorig.ts';

export interface Question {
  id: string;
  /** Plain words, shown above the pictures. */
  text: string;
  /** What a picked layer becomes. */
  role: Role;
  side: Side | null;
  /** Mesh ids to show as pictures, most likely first (at most 8). */
  candidates: string[];
  /** May the user pick several (e.g. "all the pieces of your hair in front of your face")? */
  many?: boolean;
}

type Box = { x: number; y: number; w: number; h: number };

/** The questions worth asking for this document (empty = the auto-rig understood everything that matters). */
export function questions(doc: EdDoc, textures?: EdTexture[]): Question[] {
  // (an imported model is already rigged: nothing to ask, and answering would run the auto-rig over it)
  if (doc.imported) return [];
  const box = (m: EdMesh): Box => { const t = doc.textures[m.tex]; return { x: t.x, y: t.y, w: t.w, h: t.h }; };
  const has = (r: Role, s?: Side) => doc.meshes.some((m) => m.role === r && (!s || m.side === s));
  const open = doc.meshes.filter((m) => m.visible && (m.role === 'unknown' || (m.role === 'headAcc' && !m.generated)));
  const out: Question[] = [];
  const face = doc.meshes.find((m) => m.role === 'face');
  const F = face ? box(face) : { x: doc.canvas.w * 0.25, y: doc.canvas.h * 0.1, w: doc.canvas.w * 0.5, h: doc.canvas.h * 0.4 };
  const cx = F.x + F.w / 2;
  const centre = (b: Box) => [b.x + b.w / 2, b.y + b.h / 2];
  const rank = (list: EdMesh[], score: (b: Box) => number) => list.map((m) => ({ m, s: score(box(m)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.m.id);
  const pool = (exclude: Role[] = []) => doc.meshes.filter((m) => !exclude.includes(m.role) && !m.generated);

  if (!face) {
    // most likely first: the layer the small features are painted on, then big layers in the top part
    const order = doc.meshes.map((m, i) => i).sort((a, b) => doc.meshes[a].z - doc.meshes[b].z);
    const layers = order.map((i) => { const m = doc.meshes[i], t = doc.textures[m.tex]; return { name: m.name, path: [], x: t.x, y: t.y, w: t.w, h: t.h, rgba: textures?.[m.tex]?.rgba ?? new Uint8ClampedArray(t.w * t.h * 4), opacity: 1, visible: true, blend: 'normal' as const, clipped: false }; });
    const votes = faceVotes(layers, { width: doc.canvas.w, height: doc.canvas.h });
    const vote = new Map(order.map((mi, k) => [doc.meshes[mi].id, votes[k]]));
    out.push({ id: 'face', text: 'Which of these is your face (the skin, without hair or eyes)?', role: 'face', side: null,
      candidates: doc.meshes.filter((m) => !m.generated && !['eyeWhite', 'iris', 'highlight', 'lashUpper', 'lashLower', 'brow'].includes(m.role))
        .map((m) => { const b = box(m); return { m, s: b.y + b.h / 2 < doc.canvas.h * 0.65 ? (vote.get(m.id) ?? 0) * 1e9 + b.w * b.h : 0 }; })
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.m.id) });
  }
  for (const s of ['L', 'R'] as const) {
    if (has('eyeWhite', s) || has('eyeWhole', s) || has('iris', s)) continue;
    const viewerSide = s === 'L' ? 'right' : 'left';
    out.push({ id: `eye${s}`, text: `Which of these is your ${s === 'L' ? 'left' : 'right'} eye? (It is on the ${viewerSide} of the picture.)`, role: 'eyeWhole', side: s,
      candidates: rank(open.length ? open : pool(['face', 'body', 'hairBack']), (b) => {
        const [x, y] = centre(b);
        const onSide = s === 'L' ? x > cx : x < cx;
        const inBand = y > F.y + F.h * 0.2 && y < F.y + F.h * 0.75;
        const small = b.w < F.w * 0.5;
        return onSide && inBand && small ? 1 + 1 / (1 + Math.abs(y - (F.y + F.h * 0.5)) / F.h) : 0;
      }) });
  }
  if (!has('mouth') && !has('mouthUpper') && !has('mouthInner') && !has('mouthLower'))
    out.push({ id: 'mouth', text: 'Which of these is your mouth?', role: 'mouth', side: null,
      candidates: rank(open.length ? open : pool(['face', 'body', 'hairBack']), (b) => { const [x, y] = centre(b); return Math.abs(x - cx) < F.w * 0.25 && y > F.y + F.h * 0.55 && y < F.y + F.h * 1.05 && b.w < F.w * 0.6 ? 2 - Math.abs(x - cx) / F.w : 0; }) });
  // anything still unknown on the head: one picture question per layer would be tedious; ask about the biggest few
  const unknownHead = open.filter((m) => m.role === 'unknown').sort((a, b) => box(b).w * box(b).h - box(a).w * box(a).h).slice(0, 3);
  for (const m of unknownHead) out.push({ id: `what_${m.id}`, text: 'What is this part?', role: 'unknown', side: null, candidates: [m.id] });
  return out.filter((q) => q.candidates.length);
}

/** The simple choices offered for "What is this part?" (big picture buttons in the editor). */
export const WHAT_CHOICES: { role: Role; label: string }[] = [
  { role: 'hairFront', label: 'Hair in front' }, { role: 'hairBack', label: 'Hair behind' }, { role: 'hairSide', label: 'Hair at the side' },
  { role: 'headAcc', label: 'Something on the head' }, { role: 'bodyAcc', label: 'Something on the body' }, { role: 'face', label: 'Part of the face' },
  { role: 'body', label: 'Body / clothes' }, { role: 'ignore', label: 'Not part of me (hide it)' }, { role: 'unknown', label: 'Leave it still' },
];

/** Apply an answer (the picked mesh ids; for "What is this part?" the chosen role) and re-run the auto-rig. */
export function answer(doc: EdDoc, textures: EdTexture[], q: Question, picked: string[], role?: Role) {
  const r = role ?? q.role;
  for (const id of picked) {
    const m = doc.meshes.find((x) => x.id === id);
    if (!m) continue;
    m.role = r;
    m.side = q.side ?? sideOf(doc, m);
    m.depth = ROLE_DEPTH[r] ?? m.depth;
    m.deformer = null; // let the auto-rig hang it where its new role belongs
    if (r === 'unknown') m.rides = 'head';
    if (r === 'ignore') m.visible = false;
  }
  // with this answer known (often the face), look at the remaining pictures again
  const order = doc.meshes.map((m, i) => i).sort((a, b) => doc.meshes[a].z - doc.meshes[b].z);
  const layers: ArtLayer[] = order.map((i) => { const m = doc.meshes[i], t = doc.textures[m.tex], tx = textures[m.tex]; return { name: m.name, path: m.group ? m.group.split('/') : [], x: t.x, y: t.y, w: t.w, h: t.h, rgba: tx.rgba, opacity: m.opacity, visible: m.visible, blend: 'normal', clipped: false }; });
  const fixed = order.map((i) => (doc.meshes[i].role !== 'unknown' ? { role: doc.meshes[i].role, side: doc.meshes[i].side } : null));
  const cls = classifyLayers(layers, { width: doc.canvas.w, height: doc.canvas.h }, fixed);
  cls.layers.forEach((c, k) => {
    const m = doc.meshes[order[k]];
    if (m.role !== 'unknown' || c.role === 'unknown') return;
    m.role = c.role; m.side = c.side; m.depth = ROLE_DEPTH[c.role] ?? m.depth; m.deformer = null;
  });
  applyAutoRig(doc, textures);
}

function sideOf(doc: EdDoc, m: EdMesh): Side | null {
  const f = doc.meshes.find((x) => x.role === 'face');
  if (!f) return null;
  const ft = doc.textures[f.tex], t = doc.textures[m.tex];
  const d = t.x + t.w / 2 - (ft.x + ft.w / 2);
  return Math.abs(d) < ft.w * 0.03 ? null : d > 0 ? 'L' : 'R';
}
