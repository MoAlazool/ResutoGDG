/**
 * Optional error tracking (audit CR-14) for this service, without a dependency: events are posted in the Sentry
 * envelope format (Sentry, GlitchTip and compatible services accept it) when ERROR_TRACKING_DSN is set; off otherwise.
 * Same rules as the API's reference implementation (apps/api/src/common/observability/error-tracking.ts): an event
 * carries only the error type, a scrubbed message, scrubbed stack frames, the route pattern, the request id, the
 * service, the deployed commit and the environment; never bodies, headers, cookies, query strings, raw paths, user ids,
 * emails, phone numbers or tokens. Best effort: 3 s timeout, at most 30 events a minute, identical errors once a
 * minute, never throws. Runtime-agnostic (fetch and Web Crypto only).
 */
export interface Dsn { endpoint: string; publicKey: string; raw: string }

export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(u.protocol) || !u.username) return null;
  const parts = u.pathname.replace(/\/+$/, '').split('/');
  const project = parts.pop();
  if (!project || !/^\d+$/.test(project)) return null;
  return { endpoint: `${u.protocol}//${u.host}${parts.join('/')}/api/${project}/envelope/`, publicKey: decodeURIComponent(u.username),
    raw: `${u.protocol}//${u.username}@${u.host}${u.pathname}` };
}

const SCRUBBERS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/\b(?:rmcp|rsk|sk|pk|whsec)_[A-Za-z0-9_-]{8,}/g, '[key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  [/(?:\+|00)?\d[\d\s-]{7,}\d/g, '[number]'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[token]'],
  [/([?&][^=\s&]+)=[^\s&]+/g, '$1=[redacted]'],
  [/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgres://[redacted]'],
];

export function scrub(text: unknown, max = 500): string {
  let out = String(text ?? '');
  for (const [re, by] of SCRUBBERS) out = out.replace(re, by);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** V8 stack → Sentry frames (oldest first); file paths are cut to the repository-relative part. */
export function framesOf(stack: string | undefined) {
  const frames: Array<{ filename: string; function: string; lineno: number; colno: number; in_app: boolean }> = [];
  for (const line of String(stack ?? '').split('\n').slice(1, 40)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const file = (m[2] ?? '').replace(/^file:\/\//, '');
    const rel = /(?:^|\/)((?:apps|packages)\/.+)$/.exec(file)?.[1] ?? (file.includes('node_modules') ? `node_modules/${file.split('node_modules/').pop()}` : file.split('/').slice(-2).join('/'));
    frames.push({ filename: scrub(rel, 200), function: scrub(m[1] ?? '<anonymous>', 120), lineno: Number(m[3]), colno: Number(m[4]),
      in_app: !file.includes('node_modules') && !file.startsWith('node:') });
  }
  return frames.reverse();
}

export interface ErrorContext { requestId?: string | null; route?: string | null; source?: string }
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const hex = (n: number) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

export function buildEvent(error: unknown, ctx: ErrorContext, meta: { service: string; environment: string; release?: string | null }) {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown');
  const tags: Record<string, string> = { service: meta.service, source: ctx.source ?? meta.service };
  if (ctx.route) tags.route = scrub(ctx.route, 200);
  if (ctx.requestId && /^[A-Za-z0-9._:-]{8,64}$/.test(ctx.requestId)) tags.request_id = ctx.requestId;
  return {
    event_id: hex(16), timestamp: Date.now() / 1000, platform: 'node', level: 'error', environment: meta.environment,
    ...(meta.release ? { release: meta.release } : {}), tags,
    exception: { values: [{ type: scrub(e.name || 'Error', 80), value: scrub(e.message), stacktrace: { frames: framesOf(e.stack) } }] },
  };
}

export class ErrorReporter {
  private readonly dsn: Dsn | null;
  private window = { start: 0, count: 0 };
  private readonly recent = new Map<string, number>();
  constructor(raw: string | undefined, private readonly meta: { service: string; environment: string; release?: string | null },
    private readonly fetcher: Fetch = (url, init) => fetch(url, init)) {
    this.dsn = parseDsn(raw);
  }

  get enabled() { return this.dsn !== null; }

  async capture(error: unknown, ctx: ErrorContext = {}): Promise<'sent' | 'skipped' | 'failed'> {
    if (!this.dsn) return 'skipped';
    const now = Date.now();
    if (now - this.window.start > 60_000) this.window = { start: now, count: 0 };
    const key = `${(error as Error)?.name}:${(error as Error)?.message}:${ctx.route ?? ''}`.slice(0, 300);
    if ((this.recent.get(key) ?? 0) > now - 60_000 || this.window.count >= 30) return 'skipped';
    this.window.count++;
    this.recent.set(key, now);
    if (this.recent.size > 500) this.recent.clear();
    const event = buildEvent(error, ctx, this.meta);
    const body = [JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: this.dsn.raw }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
    try {
      const res = await this.fetcher(this.dsn.endpoint, {
        method: 'POST', body, signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=resuto-${this.meta.service}/1.0` },
      });
      return res.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

let reporter: ErrorReporter | null = null;
/** The MCP server's reporter (ERROR_TRACKING_DSN), release = the deployed commit. */
export function mcpErrorReporter(release: string | null = null): ErrorReporter {
  reporter ??= new ErrorReporter(process.env.ERROR_TRACKING_DSN, { service: 'mcp', environment: process.env.NODE_ENV ?? 'development', release });
  return reporter;
}
export function configureMcpErrorReporter(next: ErrorReporter | null) { reporter = next; }
/** Route label for an event: the secret-URL form (/mcp/<rmcp_key>) is never sent. */
export const routeLabel = (path: string | undefined) => ((path ?? '/').startsWith('/mcp') ? '/mcp' : scrub(path ?? '/', 80));
