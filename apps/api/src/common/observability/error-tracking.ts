import { randomBytes } from 'node:crypto';
import { writeSync } from 'node:fs';
import { buildInfo } from './build-info';

/**
 * Optional error tracking for unexpected server errors (audit CR-14), without a new dependency: events are posted in
 * the Sentry envelope format, which Sentry, GlitchTip and other compatible services accept. Off unless
 * ERROR_TRACKING_DSN is set.
 *
 * PII: an event carries only the error type, a scrubbed message, a scrubbed stack (file, function, line), the route
 * PATTERN, the request id, the service, the deployed commit and the environment. Never request bodies, headers,
 * cookies, query strings, raw paths, user ids, emails, phone numbers or tokens; message text is scrubbed of anything
 * that looks like one of those. Sending is best-effort (3 s timeout, at most 30 events a minute, identical errors
 * once a minute) and never affects the response.
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
  const prefix = parts.join('/');
  return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, publicKey: decodeURIComponent(u.username), raw: `${u.protocol}//${u.username}@${u.host}${u.pathname}` };
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

/** Removes anything in free text that could identify a person or grant access. */
export function scrub(text: string, max = 500): string {
  let out = String(text ?? '');
  for (const [re, by] of SCRUBBERS) out = out.replace(re, by);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

interface Frame { filename: string; function: string; lineno?: number; colno?: number; in_app: boolean }

/** Parses a V8 stack into Sentry frames (oldest first), keeping only the path from the repository's apps/packages. */
export function framesOf(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of String(stack ?? '').split('\n').slice(1, 40)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const file = m[2].replace(/^file:\/\//, '');
    const rel = /(?:^|\/)((?:apps|packages)\/.+)$/.exec(file)?.[1] ?? (file.includes('node_modules') ? `node_modules/${file.split('node_modules/').pop()}` : file.split('/').slice(-2).join('/'));
    frames.push({ filename: rel, function: scrub(m[1] ?? '<anonymous>', 120), lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes('node_modules') && !file.startsWith('node:') });
  }
  return frames.reverse();
}

export interface ErrorContext { requestId?: string | null; route?: string | null; source?: string }

export function buildEvent(error: unknown, ctx: ErrorContext, environment: string) {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Non-error thrown');
  const b = buildInfo();
  const tags: Record<string, string> = { service: b.service, source: ctx.source ?? 'api' };
  if (ctx.route) tags.route = scrub(ctx.route, 200);
  if (ctx.requestId) tags.request_id = String(ctx.requestId).slice(0, 64);
  const pgCode = (error as { code?: unknown })?.code;
  if (typeof pgCode === 'string' && /^[0-9A-Z]{5}$/.test(pgCode)) tags.pg_code = pgCode;
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: 'error',
    environment,
    ...(b.commit ? { release: b.commit } : {}),
    tags,
    exception: { values: [{ type: scrub(e.name || 'Error', 80), value: scrub(e.message), stacktrace: { frames: framesOf(e.stack) } }] },
  };
}

export class ErrorReporter {
  private readonly dsn: Dsn | null;
  private window = { start: 0, count: 0 };
  private readonly recent = new Map<string, number>();
  constructor(raw: string | undefined, private readonly environment: string, private readonly fetcher: typeof fetch = (...a) => fetch(...a)) {
    this.dsn = parseDsn(raw);
  }

  get enabled() { return this.dsn !== null; }

  /** Fire and forget; resolves when the event was sent, skipped or failed (never rejects). */
  async capture(error: unknown, ctx: ErrorContext = {}): Promise<'sent' | 'skipped' | 'failed'> {
    if (!this.dsn) return 'skipped';
    const now = Date.now();
    if (now - this.window.start > 60_000) this.window = { start: now, count: 0 };
    const key = `${(error as Error)?.name}:${(error as Error)?.message}:${ctx.route ?? ''}`.slice(0, 300);
    if ((this.recent.get(key) ?? 0) > now - 60_000 || this.window.count >= 30) return 'skipped';
    this.window.count++;
    this.recent.set(key, now);
    if (this.recent.size > 500) this.recent.clear();
    const event = buildEvent(error, ctx, this.environment);
    const body = [
      JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn: this.dsn.raw }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');
    try {
      const res = await this.fetcher(this.dsn.endpoint, {
        method: 'POST', body, signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=resuto-api/1.0` },
      });
      return res.ok ? 'sent' : 'failed';
    } catch {
      return 'failed';
    }
  }
}

let reporter: ErrorReporter | null = null;
/** The process-wide reporter (configured once from the environment by the API and worker entrypoints). */
export function errorReporter(): ErrorReporter {
  reporter ??= new ErrorReporter(process.env.ERROR_TRACKING_DSN, process.env.NODE_ENV ?? 'development');
  return reporter;
}
export function configureErrorReporter(next: ErrorReporter | null) { reporter = next; }

/**
 * Crash reporting that actually leaves the process (review finding on CR-14). A listener on 'uncaughtExceptionMonitor'
 * cannot send anything: Node exits synchronously right after it returns, so an async POST never goes out. Instead an
 * 'uncaughtException' handler keeps Node's crash semantics by hand: it prints the stack to stderr as Node would, writes
 * one scrubbed JSON line (synchronously, so the log stream keeps it even if the network is down), waits for the error
 * tracker for at most `timeoutMs`, and exits with code 1. A second failure while reporting exits at once. Unhandled
 * promise rejections reach it too (Node's default --unhandled-rejections=throw raises them as uncaught exceptions).
 */
export interface CrashReportingOptions {
  target?: Pick<NodeJS.Process, 'on' | 'off'>;
  reporter?: () => ErrorReporter;
  exit?: (code: number) => void;
  write?: (text: string) => void;
  timeoutMs?: number;
}

export function crashLine(error: unknown, origin: string): string {
  const event = buildEvent(error, { source: origin }, process.env.NODE_ENV ?? 'development');
  const ex = event.exception.values[0];
  return JSON.stringify({
    level: 'fatal', msg: 'process crash', origin, time: new Date().toISOString(), service: event.tags.service, release: event.release ?? null,
    error: { type: ex.type, message: ex.value, frames: ex.stacktrace.frames.slice(-8).map((f) => `${f.function} (${f.filename}:${f.lineno})`) },
  });
}

export function installCrashReporting(opts: CrashReportingOptions = {}): () => void {
  const target = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const write = opts.write ?? ((text: string) => { try { writeSync(2, text); } catch { /* stderr closed */ } });
  let crashing = false;
  const handler = (error: unknown, origin: string = 'uncaughtException') => {
    if (crashing) { exit(1); return; }
    crashing = true;
    write(`${(error as Error)?.stack ?? String(error)}\n`);
    write(`${crashLine(error, origin)}\n`);
    let done = false;
    const finish = () => { if (!done) { done = true; exit(1); } };
    const timer = setTimeout(finish, opts.timeoutMs ?? 2000);
    (opts.reporter ?? errorReporter)().capture(error, { source: origin }).finally(() => { clearTimeout(timer); finish(); });
  };
  target.on('uncaughtException', handler as NodeJS.UncaughtExceptionListener);
  return () => { target.off('uncaughtException', handler as NodeJS.UncaughtExceptionListener); };
}
