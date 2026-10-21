// Minimal ASN.1 DER encoder/reader (X.690) for the fiscal signers: PKCS#10 CSRs (ZATCA), CMS SignedData (ETA CAdES-BES)
// and reading the few certificate fields they need. Node's crypto signs and verifies but does not build these
// structures; no third-party ASN.1 library is in the lockfile. Only what the signers use is implemented.

export type Der = Buffer;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, content: Buffer): Der => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
export const seq = (...items: Der[]): Der => tlv(0x30, Buffer.concat(items));
/** SET OF: DER sorts the encoded elements (X.690 11.6). */
export const setOf = (...items: Der[]): Der => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare)));
export const nul = (): Der => Buffer.from([0x05, 0x00]);
export const bool = (v: boolean): Der => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export const octet = (b: Buffer): Der => tlv(0x04, b);
export const utf8 = (s: string): Der => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printable = (s: string): Der => {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(s)) throw new RangeError(`not a PrintableString: ${s}`);
  return tlv(0x13, Buffer.from(s, 'ascii'));
};
export const bitString = (b: Buffer, unused = 0): Der => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
/** [n] with explicit (constructed) tagging. */
export const ctx = (n: number, content: Buffer, constructed = true): Der => tlv((constructed ? 0xa0 : 0x80) | n, content);

export function int(v: number | bigint | Buffer): Der {
  let b: Buffer;
  if (Buffer.isBuffer(v)) b = v;
  else {
    let hex = BigInt(v).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    b = Buffer.from(hex, 'hex');
  }
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && (b[i + 1]! & 0x80) === 0) i++;
  b = b.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Der {
  const parts = dotted.split('.').map((p) => BigInt(p));
  if (parts.length < 2) throw new RangeError(`bad OID ${dotted}`);
  const out: number[] = [Number(parts[0]! * 40n + parts[1]!)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do { chunk.unshift(Number(v & 0x7fn)); v >>= 7n; } while (v > 0n);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime for 1950–2049 (RFC 5280 4.1.2.5), else GeneralizedTime. */
export function time(d: Date): Der {
  const iso = d.toISOString();
  const y = d.getUTCFullYear();
  if (y >= 1950 && y < 2050) return tlv(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'));
  return tlv(0x18, Buffer.from(`${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'));
}

/** AlgorithmIdentifier. */
export const alg = (o: string, params?: Der): Der => seq(oid(o), ...(params ? [params] : []));

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------
export interface Node { tag: number; start: number; headerLength: number; length: number; end: number; raw: Buffer; content: Buffer }

export function read(buf: Buffer, offset = 0): Node {
  const tag = buf[offset];
  if (tag === undefined) throw new RangeError('DER: unexpected end');
  let len = buf[offset + 1];
  if (len === undefined) throw new RangeError('DER: unexpected end');
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new RangeError('DER: unsupported length');
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[offset + 2 + i]!;
    header += n;
  }
  const end = offset + header + len;
  if (end > buf.length) throw new RangeError('DER: truncated');
  return { tag, start: offset, headerLength: header, length: len, end, raw: buf.subarray(offset, end), content: buf.subarray(offset + header, end) };
}

export function children(node: Node): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < node.content.length) {
    const c = read(node.content, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

/** The fields of an X.509 certificate the signers need (raw DER pieces, no interpretation). */
export function certificateParts(der: Buffer) {
  const cert = read(der);
  const [tbs, sigAlg, sigValue] = children(cert);
  if (!tbs || !sigAlg || !sigValue) throw new RangeError('not an X.509 certificate');
  const t = children(tbs);
  const offset = t[0]?.tag === 0xa0 ? 1 : 0; // [0] version is optional
  const serial = t[offset];
  const issuer = t[offset + 2];
  const subject = t[offset + 4];
  const spki = t[offset + 5];
  if (!serial || !issuer || !subject || !spki) throw new RangeError('not an X.509 certificate');
  return {
    tbs: tbs.raw, serialNumber: serial.raw, serialNumberValue: serial.content, issuer: issuer.raw, subject: subject.raw, subjectPublicKeyInfo: spki.raw,
    signatureAlgorithm: sigAlg.raw,
    /** The CA's signature (BIT STRING content without the unused-bits byte). */
    signatureValue: sigValue.content.subarray(1),
  };
}
