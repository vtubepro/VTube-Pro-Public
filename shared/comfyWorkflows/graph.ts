// A tiny graph builder for ComfyUI workflows plus the two file formats ComfyUI reads:
//  - API format ("prompt"): { "<id>": { class_type, inputs: { name: value | [nodeId, outputSlot] }, _meta: { title } } }
//    What ComfyUI's POST /prompt takes and what scripts / the helper use.
//  - UI format (LiteGraph workflow, version 0.4): nodes with positions, sockets, `widgets_values` in the node
//    definition's widget order, a `links` table, notes. What you drag into ComfyUI or open from its Workflows list.
// Widget order, socket lists and defaults come from a node schema (ComfyUI's /object_info, pinned in nodeSchema.json),
// so both files describe exactly the same graph; `uiToApi` converts back and the unit test checks they match.
// Pure TypeScript, no imports from node: or the DOM.

export type Link = { node: string; slot: number };
export type Value = string | number | boolean | Link;
export const isLink = (v: unknown): v is Link => !!v && typeof v === 'object' && typeof (v as Link).node === 'string' && typeof (v as Link).slot === 'number';

export interface GNode {
  id: string;
  type: string;
  title?: string;
  inputs: Record<string, Value>;
  /** Shown in a highlight colour in the UI file: the things a user changes. */
  highlight?: boolean;
  /** `properties.models` for ComfyUI's own "missing models" download dialog. */
  models?: { name: string; url: string; directory: string; hash?: string; hash_type?: string }[];
}
export interface NodeRef { id: string; out: (slot?: number) => Link }

export class Graph {
  nodes: GNode[] = [];
  notes: { title: string; text: string; color?: string }[] = [];
  add(type: string, inputs: Record<string, Value | undefined> = {}, o: { title?: string; highlight?: boolean } = {}): NodeRef {
    const id = String(this.nodes.length + 1);
    const clean: Record<string, Value> = {};
    for (const [k, v] of Object.entries(inputs)) if (v !== undefined) clean[k] = v;
    this.nodes.push({ id, type, inputs: clean, ...(o.title ? { title: o.title } : {}), ...(o.highlight ? { highlight: true } : {}) });
    return { id, out: (slot = 0) => ({ node: id, slot }) };
  }
  note(title: string, text: string) { this.notes.push({ title, text }); }
  get(id: string) { return this.nodes.find((n) => n.id === id); }
}

// ---------------------------------------------------------------- node schema (subset of /object_info)
type Spec = [unknown, Record<string, unknown>?] | [unknown];
export interface NodeDef {
  input: { required?: Record<string, Spec>; optional?: Record<string, Spec>; hidden?: Record<string, unknown> };
  input_order?: { required?: string[]; optional?: string[] };
  output: string[];
  output_name?: string[];
  output_node?: boolean;
  display_name?: string;
}
export type NodeSchema = Record<string, NodeDef>;

const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
export interface InputInfo { name: string; required: boolean; widget: boolean; type: string; options?: unknown[]; opts: Record<string, unknown> }
/** Every input of a node class in ComfyUI's order (required first), classified as widget or socket. */
export function inputsOf(def: NodeDef): InputInfo[] {
  const out: InputInfo[] = [];
  for (const req of [true, false]) {
    const group = (req ? def.input.required : def.input.optional) ?? {};
    const order = (req ? def.input_order?.required : def.input_order?.optional) ?? Object.keys(group);
    for (const name of order) {
      const spec = group[name];
      if (!spec) continue;
      const head = spec[0];
      const opts = (spec[1] ?? {}) as Record<string, unknown>;
      if (Array.isArray(head)) { out.push({ name, required: req, widget: !opts.forceInput, type: 'COMBO', options: head, opts }); continue; }
      const t = String(head);
      const options = t === 'COMBO' ? (opts.options as unknown[] | undefined) ?? [] : undefined;
      out.push({ name, required: req, widget: WIDGET_TYPES.has(t) && !opts.forceInput, type: t, ...(options ? { options } : {}), opts });
    }
  }
  return out;
}
const defaultOf = (i: InputInfo): Value | undefined => {
  if (i.opts.default !== undefined) return i.opts.default as Value;
  if (i.type === 'COMBO') return (i.options?.[0] as Value | undefined);
  if (i.type === 'BOOLEAN') return false;
  if (i.type === 'STRING') return '';
  if (i.type === 'INT' || i.type === 'FLOAT') return (i.opts.min as number | undefined) ?? 0;
  return undefined;
};

/** Fill every widget the node shows with its default (ComfyUI's own export includes them all). */
export function normalize(g: Graph, schema: NodeSchema): Graph {
  for (const n of g.nodes) {
    const def = schema[n.type];
    if (!def) continue;
    for (const i of inputsOf(def)) if (i.widget && n.inputs[i.name] === undefined) {
      const d = defaultOf(i);
      if (d !== undefined) n.inputs[i.name] = d;
    }
  }
  return g;
}

// ---------------------------------------------------------------- API format
export type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }>;
export function toApi(g: Graph, schema?: NodeSchema): ApiPrompt {
  const out: ApiPrompt = {};
  for (const n of g.nodes) {
    const inputs: Record<string, unknown> = {};
    // ComfyUI's own order (what its frontend exports), then anything the schema doesn't know (the validator flags it)
    const order = schema?.[n.type] ? inputsOf(schema[n.type]).map((i) => i.name) : [];
    const keys = [...order.filter((k) => k in n.inputs), ...Object.keys(n.inputs).filter((k) => !order.includes(k))];
    for (const k of keys) { const v = n.inputs[k]; inputs[k] = isLink(v) ? [v.node, v.slot] : v; }
    out[n.id] = { class_type: n.type, inputs, _meta: { title: n.title ?? schema?.[n.type]?.display_name ?? n.type } };
  }
  return out;
}

// ---------------------------------------------------------------- UI format (LiteGraph 0.4)
export interface UiNode {
  id: number; type: string; pos: [number, number]; size: [number, number]; flags: Record<string, unknown>; order: number; mode: number;
  inputs?: { name: string; type: string; link: number | null; widget?: { name: string }; shape?: number }[];
  outputs?: { name: string; type: string; links: number[] | null; slot_index?: number }[];
  properties: Record<string, unknown>; widgets_values?: unknown[]; title?: string; color?: string; bgcolor?: string;
}
export interface UiWorkflow {
  last_node_id: number; last_link_id: number; nodes: UiNode[];
  links: [number, number, number, number, number, string][];
  groups: unknown[]; config: Record<string, unknown>; extra: Record<string, unknown>; version: number;
}
const HL = { color: '#3f5f12', bgcolor: '#2b3f0c' }; // VTube Pro lime family: "change me"
const NOTE_W = 460;

function depthOf(g: Graph): Map<string, number> {
  const d = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (d.has(id)) return d.get(id)!;
    if (stack.has(id)) throw new Error(`cycle at node ${id}`);
    stack.add(id);
    const n = g.get(id)!;
    let best = 0;
    for (const v of Object.values(n.inputs)) if (isLink(v)) best = Math.max(best, visit(v.node, stack) + 1);
    stack.delete(id);
    d.set(id, best);
    return best;
  };
  for (const n of g.nodes) visit(n.id, new Set());
  return d;
}

export function toUi(g: Graph, schema: NodeSchema, extra: Record<string, unknown> = {}): UiWorkflow {
  const links: UiWorkflow['links'] = [];
  const nodes: UiNode[] = [];
  const depth = depthOf(g);
  const colY = new Map<number, number>();
  const outLinks = new Map<string, number[][]>(); // node id -> per slot link ids
  // order = topological (by depth, then id)
  const ordered = [...g.nodes].sort((a, b) => (depth.get(a.id)! - depth.get(b.id)!) || (Number(a.id) - Number(b.id)));
  const order = new Map(ordered.map((n, i) => [n.id, i]));
  let linkId = 0;
  const pendingInputs = new Map<string, UiNode['inputs']>();
  for (const n of g.nodes) {
    const def = schema[n.type];
    if (!def) throw new Error(`no schema for ${n.type}`);
    const infos = inputsOf(def);
    const inputs: NonNullable<UiNode['inputs']> = [];
    const widgets: unknown[] = [];
    for (const i of infos) {
      const v = n.inputs[i.name];
      if (!i.widget) {
        let link: number | null = null;
        if (isLink(v)) {
          link = ++linkId;
          const srcDef = schema[g.get(v.node)!.type];
          links.push([link, Number(v.node), v.slot, Number(n.id), inputs.length, srcDef.output[v.slot]]);
          const per = outLinks.get(v.node) ?? [];
          (per[v.slot] ??= []).push(link);
          outLinks.set(v.node, per);
        }
        inputs.push({ name: i.name, type: i.type, link });
        continue;
      }
      if (isLink(v)) {
        const link = ++linkId;
        const srcDef = schema[g.get(v.node)!.type];
        links.push([link, Number(v.node), v.slot, Number(n.id), inputs.length, srcDef.output[v.slot]]);
        const per = outLinks.get(v.node) ?? [];
        (per[v.slot] ??= []).push(link);
        outLinks.set(v.node, per);
        inputs.push({ name: i.name, type: i.type, link, widget: { name: i.name } });
        widgets.push(defaultOf(i) ?? 0);
      } else {
        widgets.push(v ?? defaultOf(i) ?? null);
      }
      if (i.opts.control_after_generate) widgets.push(i.opts.control_after_generate === true ? 'randomize' : String(i.opts.control_after_generate));
      if (i.opts.image_upload) widgets.push('image');
    }
    pendingInputs.set(n.id, inputs);
    const dcol = depth.get(n.id)!;
    const multiline = infos.filter((i) => i.widget && i.opts.multiline).length;
    const h = 46 + 24 * (inputs.length + Math.max(def.output.length - inputs.length, 0)) + 26 * widgets.length + 110 * multiline
      + (n.type === 'LoadImage' ? 320 : 0); // ComfyUI shows a picture preview under Load Image
    const y = colY.get(dcol) ?? 60;
    colY.set(dcol, y + h + 40);
    const w = multiline ? 420 : 340;
    const props: Record<string, unknown> = { 'Node name for S&R': n.type };
    if (n.models?.length) props.models = n.models;
    nodes.push({
      id: Number(n.id), type: n.type, pos: [NOTE_W + 80 + dcol * 450, y], size: [w, h], flags: {}, order: order.get(n.id)!, mode: 0,
      inputs, outputs: [], properties: props, widgets_values: widgets,
      ...(n.title ? { title: n.title } : {}), ...(n.highlight ? HL : {}),
    });
  }
  for (const u of nodes) {
    const def = schema[u.type];
    const per = outLinks.get(String(u.id)) ?? [];
    u.outputs = def.output.map((t, i) => ({ name: def.output_name?.[i] ?? t, type: t, links: per[i]?.length ? per[i] : null, slot_index: i }));
    if (!u.inputs?.length) delete u.inputs;
  }
  // notes in the left column
  let ny = 60;
  let nid = g.nodes.length;
  for (const note of g.notes) {
    const lines = note.text.split('\n').length;
    const h = Math.min(1400, 80 + lines * 22);
    nodes.push({ id: ++nid, type: 'MarkdownNote', pos: [40, ny], size: [NOTE_W, h], flags: {}, order: nodes.length, mode: 0, properties: {},
      widgets_values: [note.text], title: note.title, color: '#432', bgcolor: '#653' });
    ny += h + 40;
  }
  return {
    last_node_id: nid, last_link_id: linkId, nodes, links, groups: [], config: {},
    extra: { ds: { scale: 0.7, offset: [0, 0] }, ...extra }, version: 0.4,
  };
}

/** Convert a UI workflow back to API format with the same schema (what ComfyUI does on "Queue"). Notes are skipped. */
export function uiToApi(ui: UiWorkflow, schema: NodeSchema): ApiPrompt {
  const out: ApiPrompt = {};
  const linkById = new Map(ui.links.map((l) => [l[0], l]));
  for (const u of ui.nodes) {
    const def = schema[u.type];
    if (!def) continue; // notes and other frontend-only nodes
    const inputs: Record<string, unknown> = {};
    const vals = [...(u.widgets_values ?? [])];
    const socket = new Map((u.inputs ?? []).map((i) => [i.name, i]));
    for (const i of inputsOf(def)) {
      const s = socket.get(i.name);
      const l = s?.link != null ? linkById.get(s.link) : undefined;
      if (i.widget) {
        const v = vals.shift();
        if (i.opts.control_after_generate) vals.shift();
        if (i.opts.image_upload) vals.shift();
        inputs[i.name] = l ? [String(l[1]), l[2]] : v;
      } else if (l) inputs[i.name] = [String(l[1]), l[2]];
    }
    out[String(u.id)] = { class_type: u.type, inputs, _meta: { title: u.title ?? def.display_name ?? u.type } };
  }
  return out;
}
