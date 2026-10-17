import { Injectable } from '@nestjs/common';
import { DomainError } from '../errors/domain-error';

/**
 * Fixed-window rate limiter. In-memory per API instance: adequate for a single
 * instance or as a coarse guard; multi-instance deployments should back this
 * with Redis (same interface) — see docs/OPEN_BLOCKERS.md.
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
      throw new DomainError('rate_limited', 'Too many requests. Please slow down.', 429, { retryAfterMs: windowMs - (now - w.start) });
    }
  }

  private prune(now: number, windowMs: number) {
    for (const [k, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(k);
  }
}
