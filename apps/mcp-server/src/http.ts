import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { Server as McpSdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, ResutoApi } from './api.js';
import type { Config } from './config.js';
import { log } from './log.js';
import { createMcpServer, SERVER_INFO } from './mcp.js';

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpSdkServer;
  keyHash: string;
  clientId: string;
  lastSeen: number;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest();
const sameKey = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const KEY_RE = /^rmcp_[A-Za-z0-9_-]{16,128}$/;

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** JSON-RPC style error body, as the MCP transports expect for transport-level failures. */
function rpcError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: status === 401 ? -32001 : -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(header(req, 'content-length') ?? 0);
  if (declared > limit) throw new HttpFailure(413, `Request body exceeds ${limit} bytes`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpFailure(413, `Request body exceeds ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpFailure(400, 'Parse error: body must be JSON');
  }
}

const UNAUTHORIZED = {
  'WWW-Authenticate': 'Bearer realm="resuto-mcp", error="invalid_token", error_description="Send Authorization: Bearer rmcp_... (a ResutoMCP connection key)"',
};

/**
 * Streamable HTTP endpoint (`POST/GET/DELETE /mcp`) with per-session API keys.
 *
 * Security (MCP transport guidance): Origin validated against an allow-list,
 * Host validated (DNS rebinding), loopback bind by default, body size limit,
 * every request authenticated with the same key that opened the session, and
 * no state beyond in-memory sessions — all data and authorization live in the API.
 */
export function createHttpApp(config: Config) {
  const sessions = new Map<string, Session>();

  async function openSession(req: IncomingMessage, res: ServerResponse, key: string, keyHash: Buffer, body: unknown) {
    if (sessions.size >= config.maxSessions) throw new HttpFailure(503, 'Too many open sessions; retry later');
    const api = new ResutoApi(config.apiUrl, key, config.apiTimeoutMs);
    let who;
    try {
      who = await api.whoami();
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) throw new HttpFailure(401, 'Invalid, expired or revoked Resuto key', UNAUTHORIZED);
        if (e.status === 402 || e.status === 403) throw new HttpFailure(403, e.message);
        if (e.status === 429) throw new HttpFailure(429, e.message);
        throw new HttpFailure(502, e.message);
      }
      throw e;
    }
    const server = createMcpServer(api, who);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: config.maxBodyBytes,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server, keyHash: keyHash.toString('hex'), clientId: who.clientId, lastSeen: Date.now() });
        log('info', 'session opened', { sessionId: id, clientId: who.clientId, orgId: who.orgId, keyPrefix: key.slice(0, 13) });
      },
      onsessionclosed: (id) => { sessions.delete(id); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function sessionFor(req: IncomingMessage, keyHash: Buffer): Session {
    const sid = header(req, 'mcp-session-id');
    if (!sid) throw new HttpFailure(400, 'Bad Request: No valid session ID provided');
    const s = sessions.get(sid);
    if (!s) throw new HttpFailure(404, 'Session not found');
    if (!sameKey(Buffer.from(s.keyHash, 'hex'), keyHash)) throw new HttpFailure(403, 'This session belongs to another key');
    s.lastSeen = Date.now();
    return s;
  }

  async function handleMcp(req: IncomingMessage, res: ServerResponse, urlKey: string | null) {
    const host = header(req, 'host') ?? '';
    if (config.allowedHosts && !config.allowedHosts.includes(host)) throw new HttpFailure(403, 'Host not allowed');
    const origin = header(req, 'origin');
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) throw new HttpFailure(403, 'Origin not allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, WWW-Authenticate');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
      res.end();
      return;
    }
    const auth = header(req, 'authorization') ?? '';
    const headerKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (headerKey && urlKey && headerKey !== urlKey) throw new HttpFailure(401, 'The key in the URL and the Authorization header differ', UNAUTHORIZED);
    const key = headerKey || urlKey || '';
    if (!KEY_RE.test(key)) throw new HttpFailure(401, 'Missing or malformed Resuto key', UNAUTHORIZED);
    const keyHash = sha256(key);

    if (req.method === 'POST') {
      const body = await readJson(req, config.maxBodyBytes);
      if (header(req, 'mcp-session-id')) return sessionFor(req, keyHash).transport.handleRequest(req, res, body);
      const init = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
      if (!init) throw new HttpFailure(400, 'Bad Request: No valid session ID provided');
      return openSession(req, res, key, keyHash, body);
    }
    if (req.method === 'GET' || req.method === 'DELETE') return sessionFor(req, keyHash).transport.handleRequest(req, res);
    throw new HttpFailure(405, 'Method not allowed', { Allow: 'GET, POST, DELETE, OPTIONS' });
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/health' && req.method === 'GET') {
        const deep = (req.url ?? '').includes('deep=1');
        let api: 'ok' | 'unreachable' | undefined;
        if (deep) {
          api = await fetch(`${config.apiUrl}/v1/health`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? 'ok' : 'unreachable'), () => 'unreachable');
        }
        res.writeHead(api === 'unreachable' ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: api === 'unreachable' ? 'degraded' : 'ok', service: 'resuto-mcp', version: SERVER_INFO.version,
          sessions: sessions.size, ...(api ? { api } : {}) }));
        return;
      }
      // Optional secret-URL mode (/mcp/<rmcp_key>) for connectors that cannot send headers; off by default.
      const urlKey = config.allowUrlKey ? (/^\/mcp\/(rmcp_[A-Za-z0-9_-]{16,128})$/.exec(path ?? '')?.[1] ?? null) : null;
      if (path !== '/mcp' && !urlKey) throw new HttpFailure(404, 'Not found');
      await handleMcp(req, res, urlKey);
    } catch (e) {
      if (e instanceof HttpFailure) return rpcError(res, e.status, e.message, e.headers);
      log('error', 'request failed', { error: (e as Error)?.message });
      return rpcError(res, 500, 'Internal server error');
    }
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', 'response failed', { error: (e as Error)?.message });
      res.destroy();
    });
  });
  http.requestTimeout = 120_000;
  http.headersTimeout = 30_000;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - config.sessionIdleMs;
    for (const [id, s] of sessions) {
      if (s.lastSeen < cutoff) {
        sessions.delete(id);
        void s.transport.close().catch(() => undefined);
        log('info', 'session expired', { sessionId: id, clientId: s.clientId });
      }
    }
  }, 60_000);
  sweeper.unref();

  return {
    http,
    sessions,
    listen(): Promise<void> {
      return new Promise((resolve) => http.listen(config.port, config.host, () => resolve()));
    },
    async close() {
      clearInterval(sweeper);
      for (const s of sessions.values()) await s.transport.close().catch(() => undefined);
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
