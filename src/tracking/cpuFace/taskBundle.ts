// MediaPipe .task bundles are zip files of the models. This reads the entries (stored, or deflated where the
// browser / Node has DecompressionStream) without any dependency.

export async function readTaskBundle(zip: Uint8Array): Promise<Record<string, Uint8Array>> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  // end of central directory: the last "PK\x05\x06" (a zip comment can follow it)
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('task bundle: not a zip');
  const n = dv.getUint16(eocd + 10, true);
  let o = dv.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let k = 0; k < n; k++) {
    if (dv.getUint32(o, true) !== 0x02014b50) throw new Error('task bundle: bad central directory');
    const method = dv.getUint16(o + 10, true), csize = dv.getUint32(o + 20, true), usize = dv.getUint32(o + 24, true);
    const nl = dv.getUint16(o + 28, true), el = dv.getUint16(o + 30, true), cl = dv.getUint16(o + 32, true), local = dv.getUint32(o + 42, true);
    let name = '';
    for (let i = 0; i < nl; i++) name += String.fromCharCode(zip[o + 46 + i]);
    o += 46 + nl + el + cl;
    const lnl = dv.getUint16(local + 26, true), lel = dv.getUint16(local + 28, true);
    const data = zip.subarray(local + 30 + lnl + lel, local + 30 + lnl + lel + csize);
    if (method === 0) out[name] = data;
    else if (method === 8) out[name] = await inflateRaw(data, usize);
    else throw new Error(`task bundle: ${name} uses zip method ${method}`);
  }
  return out;
}

async function inflateRaw(data: Uint8Array, size: number): Promise<Uint8Array> {
  const DS = (globalThis as unknown as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('task bundle: deflated entry and no DecompressionStream');
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  const stream = new Blob([ab]).stream().pipeThrough(new DS('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  if (size && buf.length !== size) throw new Error('task bundle: size mismatch');
  return buf;
}
