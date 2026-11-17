// Room checks off the helper's event loop. analyzeRoom (shared/roomCheck.ts) is pure CPU: 0.5-1.8 s for a 25-40 MB room,
// and packing an embedded .gltf is a big JSON.parse + base64 decode. The helper's event loop also relays every tracking
// frame from the studio to the OBS page (src/bus.ts -> /ws), so doing that work in a route froze the avatar on stream for
// as long, once per call: GET /api/rooms/check/<shipped or linked room> (MCP check_room, scope "read", no approval) held
// the bus for 1.0-1.8 s (b10 review). Every room-file step of server/routes/roomImport.ts (check, import, .gltf packing)
// now runs in its own Node process, one job at a time, at below-normal priority, with a time limit:
//   server/roomCheckChild.ts (dist-helper/room_check.mjs in a release) is that process; this file starts it
//   (runRoomJob) and holds the pure work it does (doRoomJob), so tools/roomcheck_offloop_unit.ts can compare both.
// The process is started on server/spawnOffLoop.ts's worker thread: on Windows spawn() itself holds the event loop for
// the whole process start (60-250 ms on a busy PC, b10 review).
// Node built-ins, shared/* and server/spawnOffLoop.ts only: the child imports this file too (nothing here starts anything
// at import).
import fs from 'node:fs';
import path from 'node:path';
import { aiRoomReport, analyzeRoom, applyFix, declaredAutoFix, planFix, sceneJsonFor, type RoomAnalysis, type RoomReport } from '../shared/roomCheck.ts';
import { parseGlb, writeGlb, type Glb } from '../shared/roomGlb.ts';
import { runOffLoop } from './spawnOffLoop.ts';

// ---------------------------------------------------------------- the work (runs in the child process)

/** What check_room answers for a room (GET and POST /api/rooms/check). */
export type RoomCheckResult = ReturnType<typeof aiRoomReport>;
/** check_room: the report + the suggested fix for a room's GLB (+ its scene.json for an installed room). */
export function checkRoomBytes(glb: Uint8Array, sceneJson?: Record<string, unknown> | null): RoomCheckResult {
  const a = analyzeRoom(glb, sceneJson ? { sceneJson } : {});
  return aiRoomReport(a, planFix(a));
}

export interface RoomImportPrep { fixed: Uint8Array | null; sceneJson: Record<string, unknown>; report: RoomReport }
/** "Add my room" (POST /api/rooms/import): the check, and with autoSeats the places + cameras added when the room has
 *  fewer than 2 (`fixed` = the new GLB, null = the file is used as it is), plus the room's scene.json. */
export function prepareRoomImport(glb: Uint8Array, name: string, autoSeats: boolean): RoomImportPrep {
  let a: RoomAnalysis = analyzeRoom(glb);
  let fixed: Uint8Array | null = null, sceneJson = sceneJsonFor(name, a);
  // a room that says autoFix: false (scene extras; shared/roomCheck.ts declaredAutoFix) is used exactly as authored
  if (autoSeats && a.report.seats < 2 && declaredAutoFix(a.glb.json) !== false) {
    const plan = planFix(a);
    if (plan.spots.length || plan.fix) {
      const f = applyFix(a, plan, name);
      fixed = f.glb; sceneJson = f.sceneJson;
      a = analyzeRoom(fixed, { sceneJson });
    }
  }
  return { fixed, sceneJson, report: a.report };
}

/** An error with the HTTP status the route answers with (the routes' own HttpError lives in server/library.ts, which this
 *  file must not import). */
export class RoomJobError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export const GLTF_BROKEN = 'This .gltf file is not valid. Export the room again as .glb.';
/** A .gltf with everything embedded (JSON, '{') packed into one binary GLB: rooms are always stored as a real scene.glb
 *  (validate_room, creation packages and linked folders read only binary glTF). The data is kept byte for byte. */
export function packGltf(body: Uint8Array): Uint8Array {
  let g: Glb;
  // parseGlb's own plain words (e.g. it needs a .bin next to it); anything else is a crash on a malformed file (a
  // TypeError on "images": [null]): never a JavaScript error message for the user (b10 mcprooms verifier)
  try { g = parseGlb(body); } catch (e) { throw new RoomJobError(422, e instanceof Error && e.constructor === Error ? e.message : GLTF_BROKEN); }
  try { return writeGlb(g.json, g.bin); } catch { throw new RoomJobError(422, GLTF_BROKEN); }
}

/** One job for the room-check process. The header goes first on stdin as one JSON line; the room's bytes follow it
 *  (none when `glbPath` names an installed room's file). `out` = where the child writes a GLB it made. */
export type RoomJob =
  | { mode: 'check'; glbPath?: string; sceneJson?: Record<string, unknown> | null }
  | { mode: 'pack'; out: string }
  | { mode: 'import'; name: string; autoSeats: boolean; out: string };
export type RoomJobAnswer = { result: unknown } | { error: string; status?: number };

/** The child's whole job: header line + bytes in, one answer out. Never throws. */
export function doRoomJob(input: Uint8Array): RoomJobAnswer {
  try {
    const nl = input.indexOf(0x0a);
    if (nl < 0) throw new Error('room check: no job header');
    const job = JSON.parse(new TextDecoder().decode(input.subarray(0, nl))) as RoomJob;
    const body = input.subarray(nl + 1);
    if (job.mode === 'check') return { result: checkRoomBytes(job.glbPath ? fs.readFileSync(job.glbPath) : body, job.sceneJson) };
    if (job.mode === 'pack') { fs.writeFileSync(job.out, packGltf(body)); return { result: { out: job.out } }; }
    if (job.mode === 'import') {
      const p = prepareRoomImport(body, job.name, job.autoSeats);
      if (p.fixed) fs.writeFileSync(job.out, p.fixed);
      return { result: { fixed: !!p.fixed, sceneJson: p.sceneJson, report: p.report } };
    }
    throw new Error(`room check: unknown job "${String((job as { mode?: unknown }).mode)}"`);
  } catch (e) {
    return e instanceof RoomJobError ? { error: e.message, status: e.status } : { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------- starting it (the helper's side)

/** How the room-check process is started: the bundled dist-helper/room_check.mjs on THIS Node (a release ships no tsx)
 *  when it exists, else server/roomCheckChild.ts through tsx (the source install). Pure, for the unit test. */
export function roomCheckCommand(root: string, exists: (p: string) => boolean = fs.existsSync): { args: string[]; bundled: boolean } {
  const bundled = path.join(root, 'dist-helper', 'room_check.mjs');
  if (exists(bundled)) return { args: [bundled], bundled: true };
  return { args: ['--import', 'tsx', path.join(root, 'server', 'roomCheckChild.ts')], bundled: false };
}

export const ROOM_JOB_TIMEOUT_MS = 180_000;
let queue: Promise<unknown> = Promise.resolve();
let running = 0;
/** Jobs started or waiting right now (for the unit test). */
export const roomJobsInFlight = () => running;

/** Run one job in the room-check process and resolve its result. One process at a time (the next job waits for it), each
 *  at below-normal priority, stopped after `timeoutMs`, started off the event loop (runOffLoop). Rejects with the job's
 *  own error (a RoomJobError with the HTTP status when the job set one, else a plain Error: the route answers 500 as it
 *  did when this ran in-process). */
export function runRoomJob<T>(root: string, job: RoomJob, body: Uint8Array | null = null, timeoutMs = ROOM_JOB_TIMEOUT_MS): Promise<T> {
  running++;
  const go = async (): Promise<T> => {
    // stdin = the header line + the room's bytes, in one fresh array whose memory moves to the worker (no second copy)
    const head = Buffer.from(JSON.stringify(job) + '\n', 'utf8');
    const input = new Uint8Array(head.length + (body?.byteLength ?? 0));
    input.set(head, 0);
    if (body) input.set(body, head.length);
    const r = await runOffLoop(process.execPath, roomCheckCommand(root).args, { cwd: root, input, transferInput: true, timeoutMs });
    if (r.timedOut) throw new RoomJobError(503, `The room check took over ${Math.max(1, Math.round(timeoutMs / 1000))} s and was stopped. Make the room lighter and try again.`);
    if (r.error && r.code === null) {   // could not start it: the details stay in VTube Pro's own log
      console.warn(`[rooms] the room check process failed: ${r.error}`);
      throw new Error('The room check could not start on this PC. Try again in a moment.');
    }
    let a: Partial<{ result: T; error: string; status: number }> | null = null;
    try { a = JSON.parse(r.stdout.toString('utf8').trim().split(/\r?\n/).pop() ?? ''); } catch { /* no answer: below */ }
    if (a && typeof a.error === 'string') throw typeof a.status === 'number' ? new RoomJobError(a.status, a.error) : new Error(a.error);
    if (a && 'result' in a && r.code === 0) return a.result as T;
    console.warn(`[rooms] the room check process ended without an answer (exit ${r.code}): ${r.stderr.trim().slice(-600)}`);   // details stay in VTube Pro's own log
    throw new Error(`The room check stopped before it finished (exit ${r.code}). Try again; if it keeps happening, the room may be too big.`);
  };
  const p = queue.then(go, go);
  queue = p.catch(() => {});
  return p.finally(() => { running--; });
}
