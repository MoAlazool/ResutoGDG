import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../../config/env';
import type { ResutoRequest } from '../auth/context';
import { writeAccessLog } from '../observability/log';
import { forwardableRoute, forwardedClientIp } from './client-forwarding';
import { acceptRequestId, requestContext } from './request-context';

/** Request headers that change who the caller is; every response varies on them (PCL-04). */
export const CREDENTIAL_HEADERS = ['Authorization', 'X-Visit-Token', 'X-Reservation-Token'];

/**
 * Express `trust proxy` from TRUST_PROXY (audit PS-13): "false"/"0" (API reached directly), a hop count, or a
 * comma-separated list of addresses/CIDRs/names (loopback, linklocal, uniquelocal). Unset: one hop in deployed
 * environments (Render's load balancer appends the client address to X-Forwarded-For) and loopback locally, so the
 * local load/demo scripts can still simulate many guests with X-Forwarded-For.
 */
export function trustProxySetting(env: Pick<Env, 'NODE_ENV' | 'TRUST_PROXY'>): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return env.NODE_ENV === 'production' || env.NODE_ENV === 'staging' ? 1 : 'loopback';
  if (raw === 'false') return false;
  if (raw === 'true') throw new Error('TRUST_PROXY=true would trust any X-Forwarded-For; give a hop count or the proxy addresses');
  if (/^\d+$/.test(raw)) return Number(raw) === 0 ? false : Number(raw);
  return raw;
}

/** Route pattern (never the raw path: guest and payment tokens live in paths) for the access log. */
function routeOf(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  return route ? `${req.baseUrl ?? ''}${route}` : '(unmatched)';
}

/**
 * First middleware on every request:
 * - correlation id: the caller's X-Request-Id when it has a safe shape, else a new UUID; echoed back and carried in
 *   AsyncLocalStorage, so DB transactions (app.request_id → audit_logs / outbox_events / mcp_tool_calls), worker runs
 *   of the events it causes, logs and outbound calls (X-Request-Id) all name it (PS-15);
 * - security headers; HSTS in deployed environments (PS-17);
 * - `Cache-Control: private, no-store` and `Vary` on the credential headers unless a controller sets its own policy
 *   (public sites do), so no proxy, CDN or shared browser cache keeps tenant data (PCL-04);
 * - one structured access-log line per response (method, route pattern, status, ms, request id, org, actor); JSON
 *   lines in staging and production (LOG_FORMAT, CR-14).
 */
export function hardeningMiddleware(env: Pick<Env, 'NODE_ENV'> & Partial<Pick<Env, 'CLIENT_IP_FORWARD_SECRET'>>) {
  const deployed = env.NODE_ENV === 'production' || env.NODE_ENV === 'staging';
  return (req: Request & { id?: string }, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    // REM-A11: a guest address forwarded by the web server with a valid signature replaces the web server's own
    // address for the public guest reads it makes on a guest's behalf (GET/HEAD under /v1/public/: rate limits,
    // access log). Every other route keeps the connecting address; unsigned or foreign headers are ignored.
    if (forwardableRoute(req.method, req.path)) {
      const forwarded = forwardedClientIp(req.headers, env.CLIENT_IP_FORWARD_SECRET);
      if (forwarded) Object.defineProperty(req, 'ip', { value: forwarded, configurable: true, enumerable: true });
    }
    req.id = acceptRequestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (deployed) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Cache-Control', 'private, no-store');
    for (const h of CREDENTIAL_HEADERS) res.vary(h);
    res.on('finish', () => {
      if (req.path === '/v1/health' && res.statusCode < 400) return;
      const r = req as unknown as ResutoRequest;
      const p = r.principal;
      // One JSON line per response in deployed environments (CR-14; see common/observability/log.ts).
      writeAccessLog({
        requestId: req.id ?? '', method: req.method, route: routeOf(req), status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
        orgId: r.tenant?.orgId ?? null,
        actor: p ? (p.kind === 'mcp' ? `mcp:${p.clientId}` : `user:${p.userId}`) : null,
        ip: req.ip ?? null,
      });
    });
    requestContext.run({ requestId: req.id, source: 'api', response: res }, next);
  };
}
