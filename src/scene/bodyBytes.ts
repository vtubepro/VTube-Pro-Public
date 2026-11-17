// Reading a fetch body (the room's .glb) into ONE buffer. With the announced length known the chunks land straight in a
// buffer of that size (no second copy of a 20-80 MB file while the chunk list is joined); a stream that turns out longer
// or shorter than announced (an encoded body) falls back to the chunk list. Pure, so it is unit-tested (tools/body_bytes_unit.ts).

interface ChunkReader { read(): Promise<{ done: boolean; value?: Uint8Array }> }

export async function readBodyBytes(rd: ChunkReader, total: number, onBytes?: (n: number) => void): Promise<ArrayBuffer> {
  const parts: Uint8Array[] = [];
  let pre: Uint8Array | null = null;
  if (total > 0 && total < 0x7fffffff) { try { pre = new Uint8Array(total); } catch { pre = null; } }
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done || !value) break;
    if (pre && n + value.byteLength <= pre.byteLength) pre.set(value, n);
    else { if (pre) { parts.push(pre.subarray(0, n)); pre = null; } parts.push(value); }
    n += value.byteLength;
    onBytes?.(n);
  }
  if (pre && n === pre.byteLength) return pre.buffer as ArrayBuffer;
  if (pre) parts.push(pre.subarray(0, n));
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return all.buffer;
}
