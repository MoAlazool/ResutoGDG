import type { NextFunction, Request, Response } from 'express';
import { brotliCompress, constants, gzip } from 'node:zlib';

/** Bodies below this many bytes are sent as they are (headers would eat the saving). */
export const COMPRESSION_THRESHOLD = 1024;
const COMPRESSIBLE = /^(application\/(json|javascript|xml|problem\+json|x-ndjson)|text\/|image\/svg\+xml)/i;

/**
 * Response compression for the API (PCL-24): JSON lists were sent uncompressed (orders 24.7 kB raw vs 3.7 kB gzip).
 * Brotli (quality 4, fast) when the client accepts it, else gzip, for compressible bodies of at least 1 kB sent in one
 * piece (res.json / res.send). Streamed responses (res.write), HEAD, 204/304, bodies that already carry an encoding
 * and `Cache-Control: no-transform` pass through untouched. Compression runs off the event loop (zlib thread pool).
 * The ETag Express computes stays the weak validator of the uncompressed body, so conditional GET keeps working.
 */
export function compressionMiddleware(threshold = COMPRESSION_THRESHOLD) {
  return (req: Request, res: Response, next: NextFunction) => {
    const end = res.end.bind(res) as (...args: unknown[]) => Response;
    const write = res.write.bind(res) as (...args: unknown[]) => boolean;
    let streamed = false;
    (res as any).write = (...args: unknown[]) => {
      streamed = true;
      return write(...args);
    };
    (res as any).end = (chunk?: unknown, encoding?: unknown, cb?: unknown) => {
      if (typeof chunk === 'function') return end(chunk);
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      const pass = () => end(chunk, encoding, cb);
      if (streamed || res.headersSent || chunk === undefined || chunk === null || req.method === 'HEAD'
        || res.statusCode === 204 || res.statusCode === 304 || res.getHeader('Content-Encoding')) return pass();
      if (!COMPRESSIBLE.test(String(res.getHeader('Content-Type') ?? ''))) return pass();
      if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') ?? ''))) return pass();
      res.vary('Accept-Encoding');
      const body = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, (encoding as BufferEncoding) || 'utf8') : null;
      if (!body || body.length < threshold) return pass();
      // Brotli whenever the client accepts it (smaller at similar CPU), whatever order it listed the encodings in.
      const accepted = req.acceptsEncodings('br') === 'br' ? 'br' : req.acceptsEncodings('gzip') === 'gzip' ? 'gzip' : null;
      if (!accepted) return pass();
      const done = (err: Error | null, out: Buffer) => {
        if (err || res.headersSent) return end(body, undefined, cb);
        res.setHeader('Content-Encoding', accepted);
        res.setHeader('Content-Length', String(out.length));
        return end(out, undefined, cb);
      };
      if (accepted === 'br') {
        brotliCompress(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, done);
      } else {
        gzip(body, { level: 6 }, done);
      }
      return res;
    };
    next();
  };
}
