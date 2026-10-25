import { Body, Controller, HttpCode, Injectable, Post, Req, type NestMiddleware } from '@nestjs/common';
import { FUNNEL_BEACON_MAX_BYTES, FUNNEL_PAGE_VIEW_WEIGHT, funnelBeacon, funnelPageViewSampled, type FunnelBeacon } from '@resuto/contracts';
import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { Public } from '../../common/auth/decorators';
import { BoundedCache } from '../../common/cache/bounded-cache';
import { DbService } from '../../common/db/db.service';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';

/**
 * First-party funnel beacons (21-CRM, plan §6.7): page_view (sampled), qr_scan, add_to_cart and checkout_started from
 * the guest pages, sent with navigator.sendBeacon (or fetch keepalive) as a text/plain JSON body, so a browser sends
 * it cross-origin without a CORS preflight.
 *
 * Abuse limits: per client address (before the body is even read; 600 a minute, generous because a restaurant's guests
 * share its Wi-Fi) and per tab session (30 a minute). Fail closed: a body that is too large, not JSON, has unknown
 * keys or an event the page group cannot send is refused (400) and nothing is stored. A beacon for an unknown or closed
 * restaurant, or a page view from a tab outside the sample, is accepted and dropped (204 either way, so the endpoint
 * reveals nothing about which restaurants exist).
 *
 * Stored: org, kind, page group, branch (only when it is the restaurant's), weight and sha256(org, tab id) truncated.
 * Never stored: IP address, user agent, URL, referrer, cookies, customer ids (the body cannot carry any).
 * Lawful basis (docs/security/FUNNEL_BEACONS.md): aggregate first-party operational counts with no identifiers; they
 * do not depend on the ad-measurement consent prompt, which still gates every third-party Pixel (lib/tracking).
 */
export const BEACON_LIMITS = { perIp: 600, perSession: 30, windowMs: 60_000 } as const;

/** Reads the small text/plain body sendBeacon sends (Express only parses JSON and forms) and applies the address limit. */
@Injectable()
export class FunnelBeaconBodyMiddleware implements NestMiddleware {
  constructor(private readonly limiter: RateLimiter) {}

  use(req: Request, _res: Response, next: NextFunction) {
    try {
      this.limiter.hit(`funnel:ip:${req.ip}`, BEACON_LIMITS.perIp, BEACON_LIMITS.windowMs);
    } catch (e) {
      return next(e);
    }
    const type = String(req.headers['content-type'] ?? '');
    if (!/^text\/plain\b/i.test(type)) return next();
    if (Number(req.headers['content-length'] ?? 0) > FUNNEL_BEACON_MAX_BYTES) {
      (req as { body?: unknown }).body = null;
      req.resume();
      return next();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= FUNNEL_BEACON_MAX_BYTES) chunks.push(c); });
    req.on('error', () => next());
    req.on('end', () => {
      let body: unknown = null;
      if (size <= FUNNEL_BEACON_MAX_BYTES) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      }
      (req as { body?: unknown }).body = body;
      next();
    });
  }
}

@Injectable()
export class FunnelBeaconService {
  /** Public slug → organization id (null: unknown or closed), and branch-of-organization checks. */
  private readonly orgs = new BoundedCache<string | null>(5_000, 60_000);
  private readonly branches = new BoundedCache<boolean>(10_000, 300_000);

  constructor(private readonly db: DbService) {}

  /** The stored session key: a hash of the tab id, per restaurant (the tab id itself is never stored). */
  static sessionKey(orgId: string, sid: string) {
    return createHash('sha256').update(`funnel:v1:${orgId}:${sid}`).digest('hex').slice(0, 32);
  }

  private async orgOf(slug: string) {
    let v = this.orgs.get(slug);
    if (v === undefined) {
      const r = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from organizations where slug = $1 and status <> 'closed'`, [slug]),
        'funnel-beacon');
      v = r?.id ?? null;
      this.orgs.set(slug, v);
    }
    return v;
  }

  private async branchOf(orgId: string, branchId: string | undefined) {
    if (!branchId) return null;
    const key = `${orgId}:${branchId}`;
    let ok = this.branches.get(key);
    if (ok === undefined) {
      ok = !!(await this.db.withTenant(orgId, (tx) => tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2`, [branchId, orgId]), 'funnel-beacon'));
      this.branches.set(key, ok);
    }
    return ok ? branchId : null;
  }

  /** Stores one beacon; returns why it was dropped when it was not stored. */
  async record(b: FunnelBeacon): Promise<{ stored: boolean; dropped?: 'not_sampled' | 'unknown_restaurant' }> {
    if (b.e === 'page_view' && !funnelPageViewSampled(b.sid)) return { stored: false, dropped: 'not_sampled' };
    const orgId = await this.orgOf(b.o);
    if (!orgId) return { stored: false, dropped: 'unknown_restaurant' };
    const branchId = await this.branchOf(orgId, b.b);
    await this.db.withTenant(orgId, (tx) => tx.query(
      `insert into attribution_events(org_id, kind, branch_id, session_key, surface, weight, utm) values ($1, $2, $3, $4, $5, $6, '{}')`,
      [orgId, b.e, branchId, FunnelBeaconService.sessionKey(orgId, b.sid), b.s, b.e === 'page_view' ? FUNNEL_PAGE_VIEW_WEIGHT : 1]), 'funnel-beacon');
    return { stored: true };
  }
}

@Controller('public/funnel')
export class PublicFunnelController {
  constructor(private readonly beacons: FunnelBeaconService, private readonly limiter: RateLimiter) {}

  /** One funnel event from a guest page (see FunnelBeaconService). Always 204 when the body is valid. */
  @Post('beacon')
  @Public()
  @HttpCode(204)
  async beacon(@Body(zod(funnelBeacon)) body: FunnelBeacon, @Req() _req: Request): Promise<void> {
    this.limiter.hit(`funnel:sid:${body.sid}`, BEACON_LIMITS.perSession, BEACON_LIMITS.windowMs);
    await this.beacons.record(body);
  }
}
