// AES-256-GCM in plain TypeScript, for the ONE place WebCrypto is missing: an OBS page on a stream PC loads the output
// page over the home network (http://192.168.x.y:5191 is not a "secure context", so crypto.subtle is undefined there)
// and must still open party guests' sealed avatars in RAM (src/net/custody.ts, docs/TWO_PC_STREAMING.md).
// Decrypt + verify only. Checked against node:crypto on random keys / IVs / lengths in tools/streampc_unit.ts.
// Table-driven AES (FIPS-197) and Shoup's 4-bit GHASH (NIST SP 800-38D), 96-bit IVs only (what the vault uses).

const SBOX = new Uint8Array(256);
const TE0 = new Uint32Array(256), TE1 = new Uint32Array(256), TE2 = new Uint32Array(256), TE3 = new Uint32Array(256);
(() => {
  // GF(2^8) log / exp tables -> the S-box
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x ^= (x << 1) ^ (x & 0x80 ? 0x1b : 0); x &= 255; }
  const inv = (a: number) => (a === 0 ? 0 : exp[(255 - log[a]) % 255]);
  for (let i = 0; i < 256; i++) {
    let s = inv(i), x = s;
    for (let k = 0; k < 4; k++) { x = ((x << 1) | (x >> 7)) & 255; s ^= x; }
    SBOX[i] = s ^ 0x63;
  }
  const x2 = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 255;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i], s2 = x2(s), s3 = s2 ^ s;
    const t = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    TE0[i] = t; TE1[i] = ((t >>> 8) | (t << 24)) >>> 0; TE2[i] = ((t >>> 16) | (t << 16)) >>> 0; TE3[i] = ((t >>> 24) | (t << 8)) >>> 0;
  }
})();

/** AES-256 key schedule: 60 words. */
function expandKey(key: Uint8Array): Uint32Array {
  if (key.length !== 32) throw new Error('AES-256 needs a 32-byte key');
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
  let rcon = 1;
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) {
      t = ((SBOX[(t >>> 16) & 255] << 24) | (SBOX[(t >>> 8) & 255] << 16) | (SBOX[t & 255] << 8) | SBOX[t >>> 24]) ^ (rcon << 24);
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x1b : 0)) & 255;
    } else if (i % 8 === 4) {
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
    }
    w[i] = (w[i - 8] ^ t) >>> 0;
  }
  return w;
}

/** Encrypt one block given as 4 big-endian words; writes 4 words to out. */
function encBlock(w: Uint32Array, s0: number, s1: number, s2: number, s3: number, out: Uint32Array) {
  s0 ^= w[0]; s1 ^= w[1]; s2 ^= w[2]; s3 ^= w[3];
  let k = 4;
  for (let r = 1; r < 14; r++) {
    const t0 = TE0[s0 >>> 24] ^ TE1[(s1 >>> 16) & 255] ^ TE2[(s2 >>> 8) & 255] ^ TE3[s3 & 255] ^ w[k];
    const t1 = TE0[s1 >>> 24] ^ TE1[(s2 >>> 16) & 255] ^ TE2[(s3 >>> 8) & 255] ^ TE3[s0 & 255] ^ w[k + 1];
    const t2 = TE0[s2 >>> 24] ^ TE1[(s3 >>> 16) & 255] ^ TE2[(s0 >>> 8) & 255] ^ TE3[s1 & 255] ^ w[k + 2];
    const t3 = TE0[s3 >>> 24] ^ TE1[(s0 >>> 16) & 255] ^ TE2[(s1 >>> 8) & 255] ^ TE3[s2 & 255] ^ w[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3; k += 4;
  }
  out[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 255] << 16) | (SBOX[(s2 >>> 8) & 255] << 8) | SBOX[s3 & 255]) ^ w[k];
  out[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 255] << 16) | (SBOX[(s3 >>> 8) & 255] << 8) | SBOX[s0 & 255]) ^ w[k + 1];
  out[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 255] << 16) | (SBOX[(s0 >>> 8) & 255] << 8) | SBOX[s1 & 255]) ^ w[k + 2];
  out[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 255] << 16) | (SBOX[(s1 >>> 8) & 255] << 8) | SBOX[s2 & 255]) ^ w[k + 3];
}

// GHASH, Shoup 4-bit tables. 128-bit values as 4 big-endian uint32 words [w0 (most significant) .. w3].
const LAST4 = [0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0, 0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0];
function ghashTable(h: Uint32Array): Uint32Array {
  const T = new Uint32Array(64); // 16 entries x 4 words
  let a = h[0], b = h[1], c = h[2], d = h[3];
  T.set([a, b, c, d], 8 * 4);
  for (let i = 4; i > 0; i >>= 1) {
    const m = d & 1 ? 0xe1000000 : 0;
    d = ((d >>> 1) | (c << 31)) >>> 0; c = ((c >>> 1) | (b << 31)) >>> 0; b = ((b >>> 1) | (a << 31)) >>> 0; a = ((a >>> 1) ^ m) >>> 0;
    T.set([a, b, c, d], i * 4);
  }
  for (let i = 2; i <= 8; i *= 2) for (let j = 1; j < i; j++) for (let k = 0; k < 4; k++) T[(i + j) * 4 + k] = T[i * 4 + k] ^ T[j * 4 + k];
  return T;
}
/** y = (y xor block) * H, in place (y = 4 words; block given as 4 words). */
function gmul(T: Uint32Array, y: Uint32Array) {
  let z0 = 0, z1 = 0, z2 = 0, z3 = 0;
  for (let i = 15; i >= 0; i--) {
    const byte = (y[i >> 2] >>> (24 - 8 * (i & 3))) & 255;
    for (let half = 0; half < 2; half++) {
      const nib = half === 0 ? byte & 15 : byte >>> 4;
      if (!(i === 15 && half === 0)) {
        const rem = z3 & 15;
        z3 = ((z3 >>> 4) | (z2 << 28)) >>> 0; z2 = ((z2 >>> 4) | (z1 << 28)) >>> 0; z1 = ((z1 >>> 4) | (z0 << 28)) >>> 0; z0 = (z0 >>> 4) ^ (LAST4[rem] << 16);
      }
      const o = nib * 4;
      z0 ^= T[o]; z1 ^= T[o + 1]; z2 ^= T[o + 2]; z3 ^= T[o + 3];
    }
  }
  y[0] = z0 >>> 0; y[1] = z1 >>> 0; y[2] = z2 >>> 0; y[3] = z3 >>> 0;
}
const rd = (b: Uint8Array, o: number) => (o + 3 < b.length ? ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0 : ((b[o] ?? 0) << 24 | (b[o + 1] ?? 0) << 16 | (b[o + 2] ?? 0) << 8 | (b[o + 3] ?? 0)) >>> 0);
function ghashBytes(T: Uint32Array, y: Uint32Array, data: Uint8Array) {
  for (let o = 0; o < data.length; o += 16) {
    if (o + 16 <= data.length) { y[0] ^= rd(data, o); y[1] ^= rd(data, o + 4); y[2] ^= rd(data, o + 8); y[3] ^= rd(data, o + 12); }
    else { const p = new Uint8Array(16); p.set(data.subarray(o)); y[0] ^= rd(p, 0); y[1] ^= rd(p, 4); y[2] ^= rd(p, 8); y[3] ^= rd(p, 12); }
    gmul(T, y);
  }
}

/** Open an AES-256-GCM box: `ctTag` = ciphertext || 16-byte tag (WebCrypto's layout). Throws when the tag is wrong. */
export function aesGcmOpen(key: Uint8Array, iv: Uint8Array, ctTag: Uint8Array, aad: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (iv.length !== 12) throw new Error('GCM needs a 12-byte IV here');
  if (ctTag.length < 16) throw new Error('sealed blob too short');
  const w = expandKey(key);
  const ct = ctTag.subarray(0, ctTag.length - 16), tag = ctTag.subarray(ctTag.length - 16);
  const blk = new Uint32Array(4);
  encBlock(w, 0, 0, 0, 0, blk);
  const T = ghashTable(blk);
  // GHASH(A, C) with the length block
  const y = new Uint32Array(4);
  ghashBytes(T, y, aad);
  ghashBytes(T, y, ct);
  const abits = aad.length * 8, cbits = ct.length * 8;
  y[0] ^= Math.floor(abits / 2 ** 32) >>> 0; y[1] ^= abits >>> 0; y[2] ^= Math.floor(cbits / 2 ** 32) >>> 0; y[3] ^= cbits >>> 0;
  gmul(T, y);
  const n0 = rd(iv, 0), n1 = rd(iv, 4), n2 = rd(iv, 8);
  encBlock(w, n0, n1, n2, 1, blk); // E(K, J0)
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ ((((y[i >> 2] ^ blk[i >> 2]) >>> (24 - 8 * (i & 3))) & 255));
  if (diff !== 0) { w.fill(0); throw new Error('The sealed data did not check out (wrong key or damaged)'); }
  // CTR from J0 + 1
  const out = new Uint8Array(ct.length);
  let ctr = 2;
  for (let o = 0; o < ct.length; o += 16, ctr = (ctr + 1) >>> 0) {
    encBlock(w, n0, n1, n2, ctr, blk);
    const n = Math.min(16, ct.length - o);
    for (let i = 0; i < n; i++) out[o + i] = ct[o + i] ^ ((blk[i >> 2] >>> (24 - 8 * (i & 3))) & 255);
  }
  w.fill(0);
  return out;
}
