import { Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors/domain-error';

const WINDOW_MS = 60_000;
const KNOWN_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 50_000;

/**
 * Slows visit-token guessing (PCL-18 review). Each address gets a small budget of requests whose token turns out to
 * be missing or invalid; once it is spent, further requests from that address are refused BEFORE the token is looked
 * up, unless the token was recently seen working (the phones already seated at the restaurant keep polling) or was
 * just issued by a QR scan here. A correct guess therefore gains nothing after the budget is gone, and guesses cost
 * no database work. In memory per API instance, like RateLimiter.
 */
@Injectable()
export class TokenGuessGuard {
  private readonly failures = new Map<string, { start: number; count: number }>();
  private readonly known = new Map<string, number>();

  /** Throws 429 when this address has spent its budget and the token is not one seen working recently. */
  check(ip: string, tokenKey: string | null, limit: number): void {
    const now = Date.now();
    const w = this.failures.get(ip);
    if (!w || now - w.start >= WINDOW_MS || w.count < limit) return;
    if (tokenKey && (this.known.get(tokenKey) ?? 0) > now) return;
    throw new DomainError('rate_limited', 'Too many requests. Please slow down.', 429, { retryAfterMs: WINDOW_MS - (now - w.start), limit });
  }

  /** Counts a missing or invalid token from this address. */
  failed(ip: string): void {
    const now = Date.now();
    const w = this.failures.get(ip);
    if (!w || now - w.start >= WINDOW_MS) {
      this.failures.set(ip, { start: now, count: 1 });
      if (this.failures.size > MAX_ENTRIES) for (const [k, v] of this.failures) if (now - v.start >= WINDOW_MS) this.failures.delete(k);
    } else w.count += 1;
  }

  /** Remembers a token that just worked (or was just issued), so its table is never caught by someone else's guessing. */
  worked(tokenKey: string): void {
    const now = Date.now();
    this.known.delete(tokenKey);
    this.known.set(tokenKey, now + KNOWN_TTL_MS);
    if (this.known.size > MAX_ENTRIES) {
      for (const [k, exp] of this.known) if (exp <= now) this.known.delete(k);
      for (const k of this.known.keys()) { if (this.known.size <= MAX_ENTRIES) break; this.known.delete(k); }
    }
  }
}
