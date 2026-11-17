// Procedural battle maps: (template, seed, cols, rows) → the same grid on every page (the host only broadcasts the
// template + seed; each OBS page draws it in the room's own map look — src/ttrpg/scene/mapCanvas.ts). The AI GM picks
// a template with set_scene; a human GM picks one in the panel (or sends an image).
import { sfc32 } from './dice.ts';

export const Cell = { Rock: 0, Floor: 1, Wall: 2, Water: 3, Deep: 4, Tree: 5, Door: 6, Rubble: 7, Hazard: 8, Grass: 9, Road: 10, Block: 11 } as const;
export type Cell = (typeof Cell)[keyof typeof Cell];
export const CELL_NAMES = ['rock', 'floor', 'wall', 'water', 'deep water', 'trees', 'door', 'rubble (difficult)', 'hazard', 'grass', 'road', 'obstacle'];

export interface MapProp { x: number; y: number; kind: string; rot: number }
export interface MapGrid {
  tpl: string; cols: number; rows: number;
  cells: Uint8Array;
  props: MapProp[];
  party: [number, number][];
  foes: [number, number][];
  labels: { x: number; y: number; text: string }[];
}

export const MAP_TEMPLATES: { id: string; name: string; hint: string }[] = [
  { id: 'dungeon', name: 'Dungeon', hint: 'stone rooms joined by corridors' },
  { id: 'cave', name: 'Cave', hint: 'winding natural caverns, a pool' },
  { id: 'forest', name: 'Forest clearing', hint: 'trees around a clearing, a path' },
  { id: 'swamp', name: 'Swamp', hint: 'islands, reeds, deep water channels' },
  { id: 'tavern', name: 'Tavern', hint: 'tables, a bar, a hearth, back rooms' },
  { id: 'street', name: 'Street', hint: 'buildings, alleys, a crossroads' },
  { id: 'factory', name: 'Factory floor', hint: 'machines, conveyors, catwalk pillars, crates' },
  { id: 'lab', name: 'Lab complex', hint: 'clean corridors, labs, security doors' },
  { id: 'ship', name: 'Ship deck', hint: 'corridors, bays, airlocks' },
  { id: 'camp', name: 'Camp', hint: 'tents, sandbags, a fence, a gate' },
  { id: 'kitchen', name: 'Kitchen', hint: 'counters, a grill line, a freezer, a dining room' },
  { id: 'ruins', name: 'Ruins', hint: 'broken walls, rubble, overgrowth' },
  { id: 'arena', name: 'Arena', hint: 'an open pit ringed by walls, pillars' },
];
export const isMapTemplate = (v: unknown): v is string => typeof v === 'string' && MAP_TEMPLATES.some((t) => t.id === v);

export function buildMap(tpl: string, seed: number, cols: number, rows: number): MapGrid {
  cols = Math.max(6, Math.min(60, Math.round(cols))); rows = Math.max(6, Math.min(60, Math.round(rows)));
  const r = sfc32((seed >>> 0) ^ 0x5bd1e995);
  const ri = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const cells = new Uint8Array(cols * rows);
  const g: MapGrid = { tpl, cols, rows, cells, props: [], party: [], foes: [], labels: [] };
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < cols && y < rows ? cells[y * cols + x] : Cell.Rock);
  const set = (x: number, y: number, c: Cell) => { if (x >= 0 && y >= 0 && x < cols && y < rows) cells[y * cols + x] = c; };
  const fill = (x0: number, y0: number, w: number, h: number, c: Cell) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c); };
  const box = (x0: number, y0: number, w: number, h: number, wall: Cell, floor: Cell) => { fill(x0, y0, w, h, wall); fill(x0 + 1, y0 + 1, w - 2, h - 2, floor); };
  const prop = (x: number, y: number, kind: string) => g.props.push({ x, y, kind, rot: Math.floor(r() * 4) });
  const walk = (x0: number, y0: number, x1: number, y1: number, c: Cell, w = 1) => {
    let x = x0, y = y0;
    const horizFirst = r() < 0.5;
    const stepX = () => { while (x !== x1) { fill(x, y, w, w, c); x += Math.sign(x1 - x); } };
    const stepY = () => { while (y !== y1) { fill(x, y, w, w, c); y += Math.sign(y1 - y); } };
    if (horizFirst) { stepX(); stepY(); } else { stepY(); stepX(); }
    fill(x, y, w, w, c);
  };
  const free = (c: number[]) => { const out: [number, number][] = []; for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (c.includes(at(x, y))) out.push([x, y]); return out; };
  const scatter = (n: number, on: number[], kind: string) => { const f = free(on); for (let i = 0; i < n && f.length; i++) { const [x, y] = f.splice(Math.floor(r() * f.length), 1)[0]; prop(x, y, kind); } };
  const spawns = (walkable: number[]) => {
    const f = free(walkable).filter(([x, y]) => !g.props.some((p) => p.x === x && p.y === y));
    const west = f.filter(([x]) => x < cols * 0.35).sort((a, b) => a[0] - b[0] || Math.abs(a[1] - rows / 2) - Math.abs(b[1] - rows / 2));
    const east = f.filter(([x]) => x > cols * 0.6).sort((a, b) => b[0] - a[0] || Math.abs(a[1] - rows / 2) - Math.abs(b[1] - rows / 2));
    g.party = west.slice(0, 8); g.foes = east.slice(0, 10);
    if (g.party.length < 4) g.party = f.slice(0, 8);
    if (g.foes.length < 4) g.foes = f.slice(-10);
  };

  switch (tpl) {
    case 'cave': {
      for (let i = 0; i < cells.length; i++) cells[i] = r() < 0.47 ? Cell.Floor : Cell.Rock;
      for (let it = 0; it < 5; it++) {
        const next = new Uint8Array(cells);
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
          let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && at(x + dx, y + dy) === Cell.Rock) n++;
          next[y * cols + x] = n >= 5 || x === 0 || y === 0 || x === cols - 1 || y === rows - 1 ? Cell.Rock : Cell.Floor;
        }
        cells.set(next);
      }
      walk(1, Math.floor(rows / 2), cols - 2, Math.floor(rows / 2), Cell.Floor);
      const px = ri(cols * 0.4, cols * 0.6), py = ri(rows * 0.3, rows * 0.6);
      for (let y = -2; y <= 2; y++) for (let x = -3; x <= 3; x++) if (x * x / 9 + y * y / 4 <= 1 && at(px + x, py + y) === Cell.Floor) set(px + x, py + y, Math.abs(x) + Math.abs(y) < 2 ? Cell.Deep : Cell.Water);
      scatter(6, [Cell.Floor], 'stalagmite'); scatter(3, [Cell.Floor], 'bones');
      spawns([Cell.Floor]); break;
    }
    case 'forest': case 'swamp': {
      const sw = tpl === 'swamp';
      fill(0, 0, cols, rows, sw ? Cell.Water : Cell.Grass);
      for (let i = 0; i < cells.length; i++) if (r() < (sw ? 0.1 : 0.22)) cells[i] = sw ? Cell.Deep : Cell.Tree;
      const cx = cols / 2, cy = rows / 2;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const d = ((x - cx) / (cols * 0.32)) ** 2 + ((y - cy) / (rows * 0.3)) ** 2;
        if (sw) { if (r() < 0.55 - d * 0.25) set(x, y, Cell.Grass); }
        else if (d < 1 && r() < 0.95) set(x, y, Cell.Grass);
        else if (d > 1.8 && r() < 0.5) set(x, y, Cell.Tree);
      }
      if (sw) { walk(0, ri(2, rows - 3), cols - 1, ri(2, rows - 3), Cell.Road); for (let i = 0; i < 6; i++) { const x = ri(2, cols - 3), y = ri(2, rows - 3); fill(x, y, ri(2, 4), ri(2, 3), Cell.Grass); } scatter(8, [Cell.Grass], 'reeds'); scatter(3, [Cell.Water], 'lilypad'); scatter(2, [Cell.Grass], 'hut'); }
      else { walk(0, ri(3, rows - 4), cols - 1, ri(3, rows - 4), Cell.Road); scatter(5, [Cell.Grass], 'boulder'); scatter(2, [Cell.Grass], 'campfire'); }
      spawns([Cell.Grass, Cell.Road]); break;
    }
    case 'tavern': case 'kitchen': {
      box(0, 0, cols, rows, Cell.Wall, Cell.Floor);
      const split = Math.floor(cols * (tpl === 'kitchen' ? 0.45 : 0.65));
      fill(split, 1, 1, rows - 2, Cell.Wall);
      set(split, Math.floor(rows / 2), Cell.Door); set(split, Math.floor(rows / 2) + 1, Cell.Door);
      set(0, Math.floor(rows / 2), Cell.Door);
      if (tpl === 'tavern') {
        fill(split - 3, 2, 1, rows - 6, Cell.Block); prop(split - 2, 2, 'barrel'); prop(split - 2, 3, 'barrel');
        for (let y = 2; y < rows - 2; y += 3) for (let x = 2; x < split - 5; x += 4) { set(x, y, Cell.Block); prop(x + 1, y, 'stool'); prop(x - 1, y, 'stool'); }
        prop(split + 2, 2, 'bed'); prop(split + 2, rows - 3, 'crate'); fill(1, rows - 2, 3, 1, Cell.Hazard); g.labels.push({ x: 2, y: rows - 2, text: 'hearth' });
      } else {
        fill(split - 2, 2, 1, rows - 4, Cell.Block); g.labels.push({ x: split - 2, y: 1, text: 'counter' });
        fill(2, 2, split - 6, 1, Cell.Hazard); g.labels.push({ x: 3, y: 2, text: 'grill line' });
        fill(2, rows - 4, 4, 3, Cell.Wall); fill(3, rows - 3, 2, 1, Cell.Floor); set(4, rows - 4, Cell.Door); g.labels.push({ x: 3, y: rows - 3, text: 'freezer' });
        for (let y = 3; y < rows - 2; y += 3) for (let x = split + 2; x < cols - 2; x += 4) { set(x, y, Cell.Block); prop(x + 1, y, 'stool'); }
        scatter(4, [Cell.Floor], 'spill');
      }
      spawns([Cell.Floor, Cell.Door]); break;
    }
    case 'street': {
      fill(0, 0, cols, rows, Cell.Road);
      const bw = ri(4, 6), bh = ri(3, 5);
      for (let y = 1; y < rows - 2; y += bh + 2) for (let x = 1; x < cols - 2; x += bw + 3) {
        if (r() < 0.15) continue;
        const w = Math.min(bw, cols - x - 1), h = Math.min(bh, rows - y - 1);
        if (w < 3 || h < 3) continue;
        box(x, y, w, h, Cell.Wall, Cell.Floor); set(x + Math.floor(w / 2), y + h - 1, Cell.Door);
      }
      scatter(5, [Cell.Road], 'cart'); scatter(4, [Cell.Road], 'crate'); scatter(3, [Cell.Road], 'lamp');
      spawns([Cell.Road]); break;
    }
    case 'factory': case 'lab': case 'ship': {
      fill(0, 0, cols, rows, Cell.Wall);
      const rooms: [number, number, number, number][] = [];
      const lab = tpl !== 'factory';
      if (!lab) {
        box(0, 0, cols, rows, Cell.Wall, Cell.Floor);
        for (let y = 3; y < rows - 3; y += 4) for (let x = 3; x < cols - 3; x += 5) { fill(x, y, 2, 2, Cell.Block); prop(x, y, 'machine'); }
        fill(2, Math.floor(rows / 2), cols - 4, 1, Cell.Road); g.labels.push({ x: 3, y: Math.floor(rows / 2), text: 'conveyor' });
        scatter(8, [Cell.Floor], 'crate'); scatter(3, [Cell.Floor], 'barrel'); scatter(2, [Cell.Floor], 'spill');
        set(0, 2, Cell.Door); set(cols - 1, rows - 3, Cell.Door); g.labels.push({ x: cols - 2, y: rows - 3, text: 'extract' });
      } else {
        const hall = Math.floor(rows / 2);
        fill(1, hall - 1, cols - 2, 2, Cell.Floor);
        for (let x = 1; x < cols - 4; x += ri(5, 7)) {
          const w = Math.min(ri(4, 6), cols - 1 - x);
          const top = ri(1, 2), hTop = hall - 1 - top - 1;
          if (hTop >= 3) { box(x, top, w, hTop + 1, Cell.Wall, Cell.Floor); set(x + Math.floor(w / 2), top + hTop, Cell.Door); rooms.push([x, top, w, hTop]); }
          const hBot = rows - (hall + 2) - 1;
          if (hBot >= 3) { box(x, hall + 1, w, hBot, Cell.Wall, Cell.Floor); set(x + Math.floor(w / 2), hall + 1, Cell.Door); rooms.push([x, hall + 1, w, hBot]); }
        }
        set(0, hall, Cell.Door); set(cols - 1, hall - 1, Cell.Door);
        scatter(6, [Cell.Floor], tpl === 'ship' ? 'console' : 'bench'); scatter(3, [Cell.Floor], tpl === 'ship' ? 'crate' : 'locker');
        if (rooms.length) { const rm = rooms[ri(0, rooms.length - 1)]; g.labels.push({ x: rm[0] + 1, y: rm[1] + 1, text: tpl === 'ship' ? 'airlock' : 'server room' }); }
      }
      spawns([Cell.Floor, Cell.Road]); break;
    }
    case 'camp': {
      fill(0, 0, cols, rows, Cell.Grass);
      box(2, 2, cols - 4, rows - 4, Cell.Block, Cell.Floor);
      set(2, Math.floor(rows / 2), Cell.Door); set(2, Math.floor(rows / 2) + 1, Cell.Door); g.labels.push({ x: 1, y: Math.floor(rows / 2), text: 'gate' });
      for (let i = 0; i < 4; i++) { const x = ri(4, cols - 8), y = ri(4, rows - 7); fill(x, y, 3, 2, Cell.Wall); prop(x + 1, y, 'tent'); }
      scatter(6, [Cell.Floor], 'sandbags'); scatter(3, [Cell.Floor], 'crate'); prop(Math.floor(cols / 2), Math.floor(rows / 2), 'campfire');
      spawns([Cell.Grass, Cell.Floor]); break;
    }
    case 'ruins': case 'arena': {
      fill(0, 0, cols, rows, tpl === 'ruins' ? Cell.Grass : Cell.Floor);
      if (tpl === 'arena') {
        const cx = cols / 2, cy = rows / 2;
        for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const d = ((x + 0.5 - cx) / (cols / 2)) ** 2 + ((y + 0.5 - cy) / (rows / 2)) ** 2; if (d > 0.92) set(x, y, Cell.Wall); }
        for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + 0.4; set(Math.round(cx + Math.cos(a) * cols * 0.25), Math.round(cy + Math.sin(a) * rows * 0.25), Cell.Block); }
        set(0, Math.floor(cy), Cell.Door); set(cols - 1, Math.floor(cy), Cell.Door);
      } else {
        for (let i = 0; i < 5; i++) { const x = ri(1, cols - 7), y = ri(1, rows - 6); box(x, y, ri(4, 7), ri(4, 6), Cell.Wall, Cell.Floor); }
        for (let i = 0; i < cells.length; i++) if (cells[i] === Cell.Wall && r() < 0.35) cells[i] = Cell.Rubble;
        scatter(6, [Cell.Grass], 'tree'); scatter(4, [Cell.Floor, Cell.Grass], 'statue');
      }
      spawns([Cell.Floor, Cell.Grass, Cell.Rubble]); break;
    }
    default: { // dungeon
      fill(0, 0, cols, rows, Cell.Rock);
      const rooms: [number, number, number, number][] = [];
      for (let tries = 0; tries < 60 && rooms.length < 7; tries++) {
        const w = ri(4, 7), h = ri(3, 6), x = ri(1, cols - w - 1), y = ri(1, rows - h - 1);
        if (rooms.some(([a, b, c, d]) => x < a + c + 1 && x + w + 1 > a && y < b + d + 1 && y + h + 1 > b)) continue;
        rooms.push([x, y, w, h]);
      }
      rooms.sort((a, b) => a[0] - b[0]);
      for (const [x, y, w, h] of rooms) box(x - 1, y - 1, w + 2, h + 2, Cell.Wall, Cell.Floor);
      for (let i = 1; i < rooms.length; i++) {
        const [ax, ay, aw, ah] = rooms[i - 1], [bx, by, bw, bh] = rooms[i];
        walk(ax + Math.floor(aw / 2), ay + Math.floor(ah / 2), bx + Math.floor(bw / 2), by + Math.floor(bh / 2), Cell.Floor);
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (at(x, y) === Cell.Rock && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) === Cell.Floor)) set(x, y, Cell.Wall);
      if (rooms.length > 2) { const [x, y] = rooms[Math.floor(rooms.length / 2)]; prop(x, y, 'chest'); g.labels.push({ x, y, text: 'treasure' }); }
      scatter(4, [Cell.Floor], 'pillar'); scatter(3, [Cell.Floor], 'bones'); scatter(2, [Cell.Floor], 'brazier');
      spawns([Cell.Floor]);
    }
  }
  return g;
}

/** Can a token stand here (for move_token validation / spawn nudging)? */
export function walkable(c: number) { return c === Cell.Floor || c === Cell.Grass || c === Cell.Road || c === Cell.Door || c === Cell.Rubble || c === Cell.Water || c === Cell.Hazard; }

/** A short text description of a map for the GM prompt (what's where, in words and coarse coordinates). */
export function describeMap(g: MapGrid): string {
  const count = new Map<number, number>();
  for (const c of g.cells) count.set(c, (count.get(c) ?? 0) + 1);
  const main = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => CELL_NAMES[c]).join(', ');
  const props = [...new Set(g.props.map((p) => p.kind))].slice(0, 8).join(', ');
  return `${g.cols}×${g.rows} cells (x 0–${g.cols - 1} west→east, y 0–${g.rows - 1} north→south); mostly ${main}${props ? `; features: ${props}` : ''}${g.labels.length ? `; ${g.labels.map((l) => `${l.text} at ${l.x},${l.y}`).join('; ')}` : ''}; party starts west (${g.party.slice(0, 2).map((p) => p.join(',')).join(' / ')}), foes east (${g.foes.slice(0, 2).map((p) => p.join(',')).join(' / ')}).`;
}
