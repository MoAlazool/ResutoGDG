import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { CallToolRequestSchema, isInitializeRequest, JSONRPCRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, ResutoApi, type WhoAmI } from './api.js';
import { buildHeader, readBuildInfo } from './build-info.js';
import { mcpErrorReporter, routeLabel } from './error-tracking.js';
import type { Config } from './config.js';
import { log } from './log.js';
import { createMcpServer, prefetchedAuthInfo, SERVER_INFO } from './mcp.js';
import { bearerChallenge, handleOAuth, insufficientScopeChallenge } from './oauth.js';

/** What one HTTP request of a session needs: who the connection is and an API client carrying this request's credential. */
interface Session {
  sessionId: string;
  clientId: string;
  orgId: string;
  api: ResutoApi;
  who: WhoAmI;
  /** OAuth access token (rmat_): tool calls get the scope step-up check. */
  oauth: boolean;
}

/**
 * How long this instance trusts a session check it made with the API. Sessions live in the API database (21-MCP), so
 * any instance serves any request of any session; this short cache only saves an API round trip per request. Every
 * tool call is still authorized by the API with the request's credential (a revoked key fails at once); a session
 * closed through another instance stops being served here within this window.
 */
const SESSION_CHECK_MS = 15_000;

const sha256 = (v: string) => createHash('sha256').update(v).digest();
/** rmcp_: a connection key; rmat_: an OAuth access token issued by Resuto for this server's resource (FT-17). */
const KEY_RE = /^(rmcp|rmat)_[A-Za-z0-9_-]{16,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Streamable HTTP endpoint (`POST/GET/DELETE /mcp`) with per-session API keys.
 *
 * Security (MCP transport guidance): Origin validated against an allow-list, Host validated (DNS rebinding), loopback
 * bind by default, body size limit, every request authenticated, and a session usable only by the connection that
 * opened it. 21-MCP: no session state in this process. Sessions (Mcp-Session-Id) are rows in the API database and
 * every request gets its own MCP server and stateless transport, so instances scale horizontally without sticky
 * sessions; all data and authorization live in the API.
 */
export function createHttpApp(config: Config) {
  /** `<sessionId>:<credential hash>` → a recent successful session check (SESSION_CHECK_MS). */
  const checked = new Map<string, { at: number; who: WhoAmI }>();
  const unauthorized = (description?: string, error?: 'invalid_token') => ({ 'WWW-Authenticate': bearerChallenge(config, error, description) });
  const newApi = (key: string) => new ResutoApi(config.apiUrl, key, config.apiTimeoutMs, config.oauth?.resource ?? null);

  /** API errors while resolving the caller, as HTTP answers (401 makes OAuth clients refresh their access token). */
  function authFailure(e: unknown): never {
    if (e instanceof ApiError) {
      if (e.status === 401) throw new HttpFailure(401, 'Invalid, expired or revoked credential', unauthorized('The access token or key is invalid, expired or revoked', 'invalid_token'));
      if (e.code === 'session_not_found') throw new HttpFailure(404, 'Session not found');
      if (e.code === 'session_other_connection') throw new HttpFailure(403, 'This session belongs to another key');
      if (e.status === 402 || e.status === 403) throw new HttpFailure(403, e.message);
      if (e.status === 429) throw new HttpFailure(429, e.message);
      throw new HttpFailure(502, e.message);
    }
    throw e;
  }

  /** OAuth access tokens must have been issued for this server's resource (audience check, MCP spec "Token Handling"). */
  function assertAudience(key: string, who: WhoAmI) {
    if (key.startsWith('rmat_') && (!config.oauth || who.auth !== 'oauth' || who.resource !== config.oauth.resource)) {
      throw new HttpFailure(401, 'This access token was not issued for this MCP server', unauthorized('The token audience is not this server', 'invalid_token'));
    }
  }

  /** Initialize: the API opens the session and says who the caller is; the id goes back in Mcp-Session-Id. */
  async function openSession(res: ServerResponse, key: string, body: unknown): Promise<Session> {
    const api = newApi(key);
    const init = (Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : body) as
      { params?: { protocolVersion?: unknown; clientInfo?: { name?: unknown } } } | undefined;
    const version = init?.params?.protocolVersion;
    const clientName = init?.params?.clientInfo?.name;
    const opened = await api.openSession({
      protocolVersion: typeof version === 'string' ? version.slice(0, 40) : undefined,
      clientName: typeof clientName === 'string' ? clientName.slice(0, 120) : undefined,
      idleMinutes: Math.max(1, Math.round(config.sessionIdleMs / 60_000)),
    }).catch(authFailure);
    assertAudience(key, opened.who);
    res.setHeader('Mcp-Session-Id', opened.sessionId);
    log('info', 'session opened', { sessionId: opened.sessionId, clientId: opened.who.clientId, orgId: opened.who.orgId, keyPrefix: key.slice(0, 13) });
    return { sessionId: opened.sessionId, clientId: opened.who.clientId, orgId: opened.who.orgId, api, who: opened.who, oauth: key.startsWith('rmat_') };
  }

  /**
   * A request of an open session: the API confirms the session belongs to this credential's connection (another key is
   * refused with 403; a refreshed OAuth access token of the same connection continues it) and refreshes its idle timer.
   * An expired or revoked access token is answered with HTTP 401, so the client refreshes it.
   */
  async function sessionFor(req: IncomingMessage, key: string, keyHash: Buffer): Promise<Session> {
    const sid = header(req, 'mcp-session-id');
    if (!sid) throw new HttpFailure(400, 'Bad Request: No valid session ID provided');
    if (!UUID_RE.test(sid)) throw new HttpFailure(404, 'Session not found');
    const api = newApi(key);
    const cacheKey = `${sid}:${keyHash.toString('hex')}`;
    const hit = checked.get(cacheKey);
    let who: WhoAmI;
    if (hit && Date.now() - hit.at < SESSION_CHECK_MS) who = hit.who;
    else {
      who = (await api.touchSession(sid).catch(authFailure)).who;
      assertAudience(key, who);
      checked.set(cacheKey, { at: Date.now(), who });
    }
    return { sessionId: sid, clientId: who.clientId, orgId: who.orgId, api, who, oauth: key.startsWith('rmat_') };
  }

  /** One MCP server and one stateless transport per HTTP request (the session id is handled above, by the API). */
  async function serve(req: IncomingMessage, res: ServerResponse, s: Session, body?: unknown) {
    const server = createMcpServer(s.api, s.who);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, maxRequestBodySize: config.maxBodyBytes });
    res.on('close', () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /**
   * Scope step-up for OAuth sessions (MCP authorization spec, "Scope Challenge Handling"; RFC 6750 §3.1). A tools/call
   * whose tool needs a scope the access token was not granted must be answered with HTTP 403 and
   * `WWW-Authenticate: Bearer error="insufficient_scope", scope="…"`, so the client can authorize again with that scope
   * and retry — not with a tool error, which a client cannot act on. Which scope a tool needs is decided by the API, so
   * the call is made here, before the transport answers: an insufficient_scope refusal becomes the HTTP challenge (the
   * API refused before running anything), any other outcome is handed to the MCP handler for this request id, so the
   * tool runs exactly once. The transport's own request checks are applied first (headers, protocol version, and the
   * JSON-RPC and tools/call message schemas the transport and the SDK server validate), so a request they would
   * reject never reaches the API. The outcome travels with this HTTP request only (req.auth → the handler's authInfo),
   * so it cannot answer another request that reuses the id.
   */
  async function scopeCheck(req: IncomingMessage & { auth?: AuthInfo }, s: Session, body: unknown) {
    if (!s.oauth || !body || typeof body !== 'object' || Array.isArray(body)) return;
    if (!JSONRPCRequestSchema.safeParse(body).success) return;   // the transport answers 400 (parse error)
    const parsed = CallToolRequestSchema.safeParse(body);
    if (!parsed.success) return;                                  // not a tools/call, or the SDK answers invalid params
    const msg = { id: (body as { id: string | number }).id, name: parsed.data.params.name, arguments: parsed.data.params.arguments };
    const accept = header(req, 'accept') ?? '';
    const type = (header(req, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const version = header(req, 'mcp-protocol-version');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream') || type !== 'application/json'
      || (version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version))) return;   // the transport answers these
    let outcome;
    try {
      outcome = await s.api.callTool(s.orgId, msg.name, msg.arguments ?? {});
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      outcome = e;
    }
    if (outcome instanceof ApiError && outcome.status === 403 && outcome.code === 'insufficient_scope') {
      const needed = (outcome.details as { scope?: unknown } | undefined)?.scope;
      throw new HttpFailure(403, outcome.message, { 'WWW-Authenticate': insufficientScopeChallenge(config, typeof needed === 'string' ? needed : 'mcp:act') });
    }
    req.auth = prefetchedAuthInfo(s.clientId, { id: msg.id, name: msg.name, outcome });
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
    if (headerKey && urlKey && headerKey !== urlKey) throw new HttpFailure(401, 'The key in the URL and the Authorization header differ', unauthorized(undefined, 'invalid_token'));
    const key = headerKey || urlKey || '';
    if (!key) throw new HttpFailure(401, 'Authorization required', unauthorized());
    if (!KEY_RE.test(key)) throw new HttpFailure(401, 'Missing or malformed credential', unauthorized(undefined, 'invalid_token'));
    if (key.startsWith('rmat_') && !config.oauth) throw new HttpFailure(401, 'OAuth is not enabled on this server', unauthorized(undefined, 'invalid_token'));
    const keyHash = sha256(key);

    if (req.method === 'POST') {
      const body = await readJson(req, config.maxBodyBytes);
      if (header(req, 'mcp-session-id')) {
        const s = await sessionFor(req, key, keyHash);
        await scopeCheck(req, s, body);
        return serve(req, res, s, body);
      }
      const init = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
      if (!init) throw new HttpFailure(400, 'Bad Request: No valid session ID provided');
      return serve(req, res, await openSession(res, key, body), body);
    }
    if (req.method === 'DELETE') {
      const s = await sessionFor(req, key, keyHash);
      await s.api.closeSession(s.sessionId).catch(authFailure);
      for (const k of checked.keys()) if (k.startsWith(`${s.sessionId}:`)) checked.delete(k);
      log('info', 'session closed', { sessionId: s.sessionId, clientId: s.clientId });
      res.writeHead(200).end();
      return;
    }
    if (req.method === 'GET') {
      // No standalone server-to-client stream: each request gets its own server and Resuto sends no notifications
      // (tools.listChanged is false). MCP clients read 405 here as "this server offers no SSE stream".
      await sessionFor(req, key, keyHash);
      throw new HttpFailure(405, 'This server does not offer a standalone SSE stream', { Allow: 'POST, DELETE, OPTIONS' });
    }
    throw new HttpFailure(405, 'Method not allowed', { Allow: 'GET, POST, DELETE, OPTIONS' });
  }

  const build = readBuildInfo();
  const xBuild = buildHeader(build);
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('X-Build', xBuild);   // deployed commit on every response (CR-07)
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path === '/health' && req.method === 'GET') {
        const deep = (req.url ?? '').includes('deep=1');
        let api: 'ok' | 'unreachable' | undefined;
        let apiBuild: string | null = null;
        if (deep) {
          api = await fetch(`${config.apiUrl}/v1/health`, { signal: AbortSignal.timeout(3000) })
            .then((r) => { apiBuild = r.headers.get('x-build'); return r.ok ? 'ok' as const : 'unreachable' as const; }, () => 'unreachable' as const);
        }
        res.writeHead(api === 'unreachable' ? 503 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: api === 'unreachable' ? 'degraded' : 'ok', service: 'resuto-mcp', version: SERVER_INFO.version,
          build, sessionStore: 'api', ...(api ? { api, apiBuild } : {}) }));
        return;
      }
      if (await handleOAuth(req, res, path ?? '/', config)) return;
      // Optional secret-URL mode (/mcp/<rmcp_key>) for connectors that cannot send headers; off by default.
      const urlKey = config.allowUrlKey ? (/^\/mcp\/(rmcp_[A-Za-z0-9_-]{16,128})$/.exec(path ?? '')?.[1] ?? null) : null;
      if (path !== '/mcp' && !urlKey) throw new HttpFailure(404, 'Not found');
      await handleMcp(req, res, urlKey);
    } catch (e) {
      if (e instanceof HttpFailure) return rpcError(res, e.status, e.message, e.headers);
      log('error', 'request failed', { error: (e as Error)?.message });
      void mcpErrorReporter(build.commit).capture(e, { route: routeLabel(path), source: 'mcp' });   // CR-14, optional
      return rpcError(res, 500, 'Internal server error');
    }
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log('error', 'response failed', { error: (e as Error)?.message });
      void mcpErrorReporter(build.commit).capture(e, { route: routeLabel((req.url ?? '/').split('?')[0]), source: 'mcp' });
      res.destroy();
    });
  });
  http.requestTimeout = 120_000;
  http.headersTimeout = 30_000;

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_CHECK_MS;
    for (const [k, v] of checked) if (v.at < cutoff) checked.delete(k);
  }, 60_000);
  sweeper.unref();

  return {
    http,
    listen(): Promise<void> {
      return new Promise((resolve) => http.listen(config.port, config.host, () => resolve()));
    },
    async close() {
      clearInterval(sweeper);
      checked.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
