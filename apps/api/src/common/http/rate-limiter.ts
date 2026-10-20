import { Injectable } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';

/**
 * Fixed-window rate limiter, in memory per API process (audit PS-13).
 *
 * Limits are per instance: with N API instances a client gets up to N× each limit, and a restart resets the
 * windows. That is acceptable as abuse damping for the current single-instance deployment; scaling out needs a
 * shared store (Redis or Postgres) behind this same interface. Counters that guard a secret (the delivery OTP) are
 * kept in the database instead, so they survive restarts and are shared.
 *
 * Keys use req.ip, which depends on TRUST_PROXY (common/http/http-hardening.ts): behind Render's load balancer it
 * is the client address the balancer appended to X-Forwarded-For, not a value the client chose.
 * A refusal is a 429 with Retry-After and RateLimit-* headers (see the exception filter).
 */
@Injectable()
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  hit(key: string, limit: number, windowMs = 60_000): void {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 50_000) this.prune(now, windowMs);
      return;
    }
    if (++w.count > limit) {
      throw new DomainError('rate_limited', 'Too many requests. Please slow down.', 429, { retryAfterMs: windowMs - (now - w.start), limit });
    }
  }

  private prune(now: number, windowMs: number) {
    for (const [k, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(k);
  }
}
