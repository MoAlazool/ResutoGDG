import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ENV, type Env } from '../../config/env';
import { DbService } from '../db/db.service';
import { DomainError } from '../errors/domain-error';

/**
 * Fixed-window rate limiter (audit PS-13). `hit()` stays synchronous for its 60+ call sites; the store decides how
 * windows are counted:
 *
 * - RATE_LIMIT_STORE=memory (default): windows live in this process. With N API instances a client gets up to N×
 *   each limit and a restart resets the windows; fine for one instance and for local development.
 * - RATE_LIMIT_STORE=postgres: windows are shared through public.rate_limit_windows (migration
 *   20261022030002), aligned to the clock so every instance counts the same window. Each instance counts locally,
 *   flushes its increments in one upsert about every FLUSH_MS and learns the shared total from the upsert; a hit is
 *   refused when (shared total as last read + this instance's unflushed hits) exceeds the limit. The overshoot is
 *   bounded by what other instances accepted since their last flush. Database trouble never refuses traffic: the
 *   limiter keeps counting locally (fail open) and logs it.
 *
 * Keys use req.ip, which depends on TRUST_PROXY (common/http/http-hardening.ts): behind Render's load balancer it
 * is the client address the balancer appended to X-Forwarded-For, not a value the client chose. Keys are stored as
 * SHA-256 hashes, never raw. Counters that guard a secret (the delivery OTP) are kept in their own tables.
 * A refusal is a 429 with Retry-After and RateLimit-* headers (see the exception filter).
 */
const FLUSH_MS = 200;
const MAX_KEYS = 50_000;

interface Window { start: number; count: number; pending: number; shared: number; windowMs: number }

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly windows = new Map<string, Window>();
  private readonly logger = new Logger('RateLimiter');
  private readonly shared: boolean;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private lastPrune = 0;
  private failingSince: number | null = null;

  constructor(@Optional() @Inject(ENV) env?: Env, @Optional() private readonly db?: DbService) {
    this.shared = env?.RATE_LIMIT_STORE === 'postgres' && !!db;
  }

  /** Which store counts the windows (health/diagnostics, tests). */
  get store(): 'memory' | 'postgres' { return this.shared ? 'postgres' : 'memory'; }

  hit(key: string, limit: number, windowMs = 60_000): void {
    const now = Date.now();
    // Shared windows are aligned to the clock so every instance counts the same window; local ones start at the first hit.
    const start = this.shared ? Math.floor(now / windowMs) * windowMs : undefined;
    let w = this.windows.get(key);
    if (!w || (start !== undefined ? w.start !== start : now - w.start >= windowMs)) {
      w = { start: start ?? now, count: 0, pending: 0, shared: 0, windowMs };
      this.windows.set(key, w);
      if (this.windows.size > MAX_KEYS) this.prune(now);
    }
    w.count++;
    if (this.shared) {
      w.pending++;
      this.scheduleFlush();
    }
    const seen = this.shared ? Math.max(w.count, w.shared + w.pending) : w.count;
    if (seen > limit) {
      throw new DomainError('rate_limited', 'Too many requests. Please slow down.', 429, { retryAfterMs: w.start + windowMs - now, limit });
    }
  }

  /** Writes unflushed increments now (tests; shutdown). Resolves when the shared counts have been read back. */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.flushing) await this.flushing;
    this.flushing = this.flushNow().finally(() => { this.flushing = null; });
    await this.flushing;
  }

  async onModuleDestroy() {
    if (this.shared) await this.flush().catch(() => undefined);
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush().catch(() => undefined); }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private async flushNow(): Promise<void> {
    if (!this.shared || !this.db) return;
    const batch: Array<{ key: string; hash: string; w: Window; delta: number }> = [];
    for (const [key, w] of this.windows) {
      if (w.pending > 0) batch.push({ key, hash: hashKey(key), w, delta: w.pending });
    }
    if (!batch.length) return;
    for (const b of batch) b.w.pending -= b.delta; // hits during the flush stay pending for the next one
    try {
      const rows = await this.db.withPlatform((tx) => tx.query<{ key_hash: string; window_start: Date; count: number }>(
        `insert into rate_limit_windows (key_hash, window_start, count, expires_at)
         select k, to_timestamp(s / 1000.0), d, to_timestamp((s + ms) / 1000.0) + interval '1 minute'
           from unnest($1::text[], $2::bigint[], $3::int[], $4::bigint[]) as t(k, s, d, ms)
         on conflict (key_hash, window_start) do update set count = rate_limit_windows.count + excluded.count
         returning key_hash, window_start, count`,
        [batch.map((b) => b.hash), batch.map((b) => b.w.start), batch.map((b) => b.delta), batch.map((b) => b.w.windowMs)]), 'system:rate-limit');
      const totals = new Map(rows.map((r) => [`${r.key_hash}:${new Date(r.window_start).getTime()}`, r.count]));
      for (const b of batch) {
        const total = totals.get(`${b.hash}:${b.w.start}`);
        if (total !== undefined) b.w.shared = Math.max(b.w.shared, total);
      }
      if (this.failingSince) {
        this.logger.log('shared rate-limit store reachable again');
        this.failingSince = null;
      }
      const now = Date.now();
      if (now - this.lastPrune > 60_000) {
        this.lastPrune = now;
        await this.db.withPlatform((tx) => tx.query(
          `delete from rate_limit_windows where ctid = any(array(select ctid from rate_limit_windows where expires_at < now() limit 5000))`), 'system:rate-limit');
      }
    } catch (e) {
      // Fail open: keep counting locally; the hits are not re-sent (the shared count is a damping signal, not a ledger).
      if (!this.failingSince) {
        this.failingSince = Date.now();
        this.logger.warn(`shared rate-limit store unavailable, counting in memory: ${(e as Error).message}`);
      }
    }
  }

  /** Drops expired windows; if a flood of distinct keys keeps the map large, the oldest windows go too (PCL-25). */
  private prune(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= w.windowMs && w.pending === 0) this.windows.delete(k);
    for (const [k, w] of this.windows) {
      if (this.windows.size <= MAX_KEYS * 0.8) break;
      if (w.pending === 0) this.windows.delete(k);
    }
  }
}

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');
