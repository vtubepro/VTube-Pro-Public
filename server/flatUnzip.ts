// The server's 2D-upload unzip: shared/flatUnzip.ts (one implementation for the server and the browser import
// worker), run here with Node's zlib: a hard output cap per entry (maxOutputLength) and zlib's CRC.
import zlib from 'node:zlib';
import { FlatZipError, setUnzipIo } from '../shared/flatUnzip.ts';

export * from '../shared/flatUnzip.ts';

const BOMB = 'This .zip is damaged or unpacks to far more than it says (a “zip bomb”), so it was refused.';
// (VTP_UNZIP_PORTABLE=1: keep the browser inflater)
if (process.env.VTP_UNZIP_PORTABLE !== '1') setUnzipIo({
  inflateRaw(raw, size) {
    try { const r = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) }); return new Uint8Array(r.buffer, r.byteOffset, r.byteLength); }
    catch (x) {
      if ((x as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' || x instanceof RangeError) throw new FlatZipError(413, BOMB);
      throw new FlatZipError(400, 'This .zip is damaged or cut off. Download it again, or unzip it and drop the folder.');
    }
  },
  crc32: (d) => (typeof (zlib as { crc32?: (d: Uint8Array) => number }).crc32 === 'function' ? (zlib as unknown as { crc32: (d: Uint8Array) => number }).crc32(d) >>> 0 : null),
});
