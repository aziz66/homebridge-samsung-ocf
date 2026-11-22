/**
 * CBOR for OCF payloads.
 *
 * Encoding is a small canonical encoder that matches Python cbor2's output
 * byte-for-byte for the value shapes this plugin writes (string-keyed maps of
 * strings/ints/floats/bools/arrays, in insertion order). This matters: the
 * write payloads should be indistinguishable from what Samsung's own app sends.
 * cbor-x is kept for decoding, where leniency (accepting any valid CBOR the
 * appliance emits) is what we want.
 *
 * Verified against cbor2 in test/unit/cbor.test.ts.
 */
import { Encoder } from "cbor-x";

const decoder = new Encoder({ useRecords: false, mapsAsObjects: true, tagUint8Array: false });

export function decodeCbor<T = unknown>(buf: Buffer): T {
  if (buf.length === 0) return undefined as unknown as T;
  return decoder.decode(buf) as T;
}

function head(major: number, n: number): Buffer {
  const mt = major << 5;
  if (n < 24) return Buffer.from([mt | n]);
  if (n < 0x100) return Buffer.from([mt | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = mt | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = mt | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = mt | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

function encodeValue(v: unknown, out: Buffer[]): void {
  if (v === null || v === undefined) {
    out.push(Buffer.from([0xf6])); // null
    return;
  }
  if (typeof v === "boolean") {
    out.push(Buffer.from([v ? 0xf5 : 0xf4]));
    return;
  }
  if (typeof v === "number") {
    if (Number.isInteger(v)) {
      if (v >= 0) out.push(head(0, v));
      else out.push(head(1, -1 - v));
    } else {
      const b = Buffer.alloc(9); // float64, as cbor2 does for non-integers
      b[0] = 0xfb;
      b.writeDoubleBE(v, 1);
      out.push(b);
    }
    return;
  }
  if (typeof v === "string") {
    const s = Buffer.from(v, "utf8");
    out.push(head(3, s.length), s);
    return;
  }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v as Uint8Array);
    out.push(head(2, b.length), b);
    return;
  }
  if (Array.isArray(v)) {
    out.push(head(4, v.length));
    for (const item of v) encodeValue(item, out);
    return;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    out.push(head(5, entries.length));
    for (const [k, val] of entries) {
      const key = Buffer.from(k, "utf8");
      out.push(head(3, key.length), key);
      encodeValue(val, out);
    }
    return;
  }
  throw new Error(`cannot CBOR-encode value of type ${typeof v}`);
}

/** Canonical (minimal, cbor2-compatible) CBOR encode. */
export function encodeCbor(value: unknown): Buffer {
  const out: Buffer[] = [];
  encodeValue(value, out);
  return Buffer.concat(out);
}
