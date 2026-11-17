// "Just drop a model": what an .fbx says about itself before the helper converts it (Blender does the real work):
// binary or text, version, units (UnitScaleFactor: 1 = cm, 100 = m), up axis, the bones / meshes / face-shape channels
// it holds, the texture files it points at (and which are embedded), animation-only files. Reads the FBX node tree
// without inflating any array (only names and settings are needed). Pure; tests: tools/model_import_unit.ts.

export interface FbxFacts {
  binary: boolean;
  version: number;
  /** Centimetres per file unit (FBX's UnitScaleFactor): 1 = centimetres, 100 = metres. */
  unitScale: number | null;
  /** 0 = X, 1 = Y, 2 = Z (with sign). */
  upAxis: number | null;
  upSign: number | null;
  meshes: string[];
  bones: { name: string; parent: string | null }[];
  shapes: string[];
  /** Texture files referenced (relative or absolute paths, as written). */
  textures: string[];
  /** File names of textures stored inside the FBX. */
  embedded: string[];
  animations: number;
  creator: string;
}

const MAGIC = 'Kaydara FBX Binary  ';

export function isFbxBinary(b: Uint8Array) {
  if (b.length < 27) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}
export function isFbxText(head: string) { return /^\s*;\s*FBX\s+\d/.test(head) || /FBXHeaderExtension\s*:/.test(head.slice(0, 4096)); }

interface Node { name: string; props: (string | number | null)[]; children: Node[] }

/** The binary node tree (names + scalar / string properties; arrays are skipped by their stored length). */
function readBinary(b: Uint8Array): { version: number; nodes: Node[] } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(23, true);
  const big = version >= 7500;
  const td = new TextDecoder('utf-8');
  let budget = 2_000_000;
  const readNode = (o: number): { node: Node | null; end: number } => {
    const end = big ? Number(dv.getBigUint64(o, true)) : dv.getUint32(o, true);
    const nprops = big ? Number(dv.getBigUint64(o + 8, true)) : dv.getUint32(o + 4, true);
    const hdr = big ? 25 : 13;
    const nameLen = b[o + hdr - 1];
    if (end === 0) return { node: null, end: o + hdr };
    if (end > b.byteLength || end <= o) throw new Error('This .fbx file is damaged or cut off. Export it again.');
    const name = td.decode(b.subarray(o + hdr, o + hdr + nameLen));
    let p = o + hdr + nameLen;
    const props: Node['props'] = [];
    for (let i = 0; i < nprops && p < end; i++) {
      const t = String.fromCharCode(b[p]); p++;
      switch (t) {
        case 'Y': props.push(dv.getInt16(p, true)); p += 2; break;
        case 'C': props.push(b[p]); p += 1; break;
        case 'I': props.push(dv.getInt32(p, true)); p += 4; break;
        case 'F': props.push(dv.getFloat32(p, true)); p += 4; break;
        case 'D': props.push(dv.getFloat64(p, true)); p += 8; break;
        case 'L': props.push(Number(dv.getBigInt64(p, true))); p += 8; break;
        case 'S': case 'R': { const len = dv.getUint32(p, true); p += 4; props.push(t === 'S' ? td.decode(b.subarray(p, p + len)) : null); p += len; break; }
        case 'f': case 'd': case 'l': case 'i': case 'b': { const clen = dv.getUint32(p + 8, true); p += 12 + clen; props.push(null); break; }
        default: throw new Error('This .fbx file is damaged (unknown data inside). Export it again.');
      }
    }
    const children: Node[] = [];
    while (p < end - (big ? 25 : 13) + 1 && budget-- > 0) {
      const r = readNode(p);
      if (!r.node) { p = r.end; break; }
      children.push(r.node); p = r.end;
    }
    return { node: { name, props, children }, end };
  };
  const nodes: Node[] = [];
  let o = 27;
  while (o < b.byteLength - 13 && budget-- > 0) {
    const r = readNode(o);
    if (!r.node) break;
    nodes.push(r.node); o = r.end;
  }
  return { version, nodes };
}

const find = (ns: Node[], name: string) => ns.find((n) => n.name === name);
const objName = (s: unknown) => String(s ?? '').split('\u0000\u0001')[0].replace(/^(Model|Geometry|Deformer|SubDeformer|Texture|Video)::/, '');

export function readFbxFacts(b: Uint8Array): FbxFacts {
  const facts: FbxFacts = { binary: false, version: 0, unitScale: null, upAxis: null, upSign: null, meshes: [], bones: [], shapes: [], textures: [], embedded: [], animations: 0, creator: '' };
  if (isFbxBinary(b)) {
    facts.binary = true;
    const { version, nodes } = readBinary(b);
    facts.version = version;
    facts.creator = String(find(nodes, 'Creator')?.props[0] ?? '');
    const gs = find(find(nodes, 'GlobalSettings')?.children ?? [], 'Properties70')?.children ?? [];
    for (const p of gs) {
      const k = p.props[0];
      if (k === 'UnitScaleFactor') facts.unitScale = Number(p.props[4]);
      if (k === 'UpAxis') facts.upAxis = Number(p.props[4]);
      if (k === 'UpAxisSign') facts.upSign = Number(p.props[4]);
    }
    const objs = find(nodes, 'Objects')?.children ?? [];
    const ids = new Map<number, { kind: string; name: string }>();
    for (const o of objs) {
      const id = Number(o.props[0]), name = objName(o.props[1]), cls = String(o.props[2] ?? '');
      if (o.name === 'Model') { ids.set(id, { kind: cls, name }); if (cls === 'Mesh') facts.meshes.push(name); }
      else if (o.name === 'Deformer' && cls === 'BlendShapeChannel') facts.shapes.push(name);
      else if (o.name === 'Texture') {
        const rel = find(o.children, 'RelativeFilename')?.props[0] ?? find(o.children, 'FileName')?.props[0];
        if (rel) facts.textures.push(String(rel));
      } else if (o.name === 'Video') {
        const content = find(o.children, 'Content');
        const fn = find(o.children, 'RelativeFilename')?.props[0] ?? find(o.children, 'Filename')?.props[0];
        if (content && fn) facts.embedded.push(String(fn).replace(/\\/g, '/').split('/').pop()!);
      } else if (o.name === 'AnimationStack') facts.animations++;
    }
    const parentOf = new Map<number, number>();
    for (const c of find(nodes, 'Connections')?.children ?? []) if (c.props[0] === 'OO') parentOf.set(Number(c.props[1]), Number(c.props[2]));
    for (const [id, o] of ids) if (o.kind === 'LimbNode' || o.kind === 'Root') { const p = ids.get(parentOf.get(id) ?? -1); facts.bones.push({ name: o.name, parent: p && (p.kind === 'LimbNode' || p.kind === 'Root' || p.kind === 'Null') ? p.name : null }); }
    return facts;
  }
  const text = new TextDecoder('utf-8').decode(b.subarray(0, Math.min(b.byteLength, 64 << 20)));
  if (!isFbxText(text)) throw new Error('This .fbx file is damaged or isn’t really an FBX. Export it again.');
  facts.version = Number(/FBXVersion:\s*(\d+)/.exec(text)?.[1] ?? 0);
  facts.creator = /Creator:\s*"([^"]*)"/.exec(text)?.[1] ?? '';
  const P = (k: string) => { const m = new RegExp(`P:\\s*"${k}",\\s*"[^"]*",\\s*"[^"]*",\\s*"[^"]*",\\s*(-?[\\d.eE+-]+)`).exec(text); return m ? Number(m[1]) : null; };
  facts.unitScale = P('UnitScaleFactor'); facts.upAxis = P('UpAxis'); facts.upSign = P('UpAxisSign');
  const models = new Map<string, { kind: string; name: string }>();
  for (const m of text.matchAll(/Model:\s*(-?\d+),\s*"Model::([^"]*)",\s*"([^"]*)"/g)) { models.set(m[1], { kind: m[3], name: m[2] }); if (m[3] === 'Mesh') facts.meshes.push(m[2]); }
  for (const m of text.matchAll(/Deformer:\s*-?\d+,\s*"(?:SubDeformer|Deformer)::([^"]*)",\s*"BlendShapeChannel"/g)) facts.shapes.push(m[1]);
  for (const m of text.matchAll(/RelativeFilename:\s*"([^"]*)"/g)) facts.textures.push(m[1]);
  facts.animations = [...text.matchAll(/AnimationStack:\s*-?\d+/g)].length;
  const parentOf = new Map<string, string>();
  for (const m of text.matchAll(/C:\s*"OO",\s*(-?\d+),\s*(-?\d+)/g)) parentOf.set(m[1], m[2]);
  for (const [id, o] of models) if (o.kind === 'LimbNode' || o.kind === 'Root') { const p = models.get(parentOf.get(id) ?? ''); facts.bones.push({ name: o.name, parent: p && (p.kind === 'LimbNode' || p.kind === 'Root' || p.kind === 'Null') ? p.name : null }); }
  facts.textures = [...new Set(facts.textures)];
  return facts;
}
