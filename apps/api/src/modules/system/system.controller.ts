import { Controller, Get, Headers, Inject, Param, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { ResutoRequest } from '../../common/auth/context';
import { Public } from '../../common/auth/decorators';
import { safeEqual } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { buildInfo } from '../../common/observability/build-info';
import { errorReporter } from '../../common/observability/error-tracking';
import { StorageService, isPublicMediaPath } from '../../common/storage/storage.service';
import { ENV, type Env } from '../../config/env';
import { HealthDetailsService } from './health-details.service';

@Controller()
export class SystemController {
  constructor(private readonly db: DbService, private readonly storage: StorageService, @Inject(ENV) private readonly env: Env,
    private readonly details: HealthDetailsService) {}

  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.db.withPlatform((tx) => tx.query('select 1'));
    // paymentMode lets operators (and the staff UI) see at a glance that a deployment runs simulated payments.
    // build: the deployed commit and build time (CR-07), so every QA result can name the code it tested.
    const b = buildInfo();
    return { status: 'ok', db: { latencyMs: Date.now() - started }, version: process.env.npm_package_version ?? '0.1.0',
      environment: this.env.NODE_ENV, paymentMode: this.env.PAYMENT_MODE,
      build: { commit: b.commit, branch: b.branch, builtAt: b.builtAt, startedAt: b.startedAt } };
  }

  /**
   * Operational detail for staging QA and uptime monitors (CR-14): outbox backlog and oldest pending age, dead event
   * handlers, last run per scheduled job, webhook failures, error tracking on/off. Readable with
   * `Authorization: Bearer <HEALTH_DETAILS_TOKEN>` (an uptime monitor) or by a platform admin; anyone else gets 404, so
   * the route does not advertise itself. Counts only: no tenant data, payloads or error texts.
   */
  @Public()
  @Get('health/details')
  async healthDetails(@Req() req: ResutoRequest, @Headers('authorization') authorization?: string) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1]?.trim();
    let allowed = !!(bearer && this.env.HEALTH_DETAILS_TOKEN && safeEqual(bearer, this.env.HEALTH_DETAILS_TOKEN));
    if (!allowed && req.principal?.kind === 'user') {
      const userId = req.principal.userId;
      allowed = !!(await this.db.withPlatform((tx) => tx.maybeOne('select 1 from platform_admins where user_id = $1', [userId]), 'system:health-details'));
    }
    if (!allowed) throw new DomainError('not_found', 'Not found', 404);
    return { ...(await this.details.snapshot()), errorTracking: errorReporter().enabled ? 'on' : 'off' };
  }

  /** Local storage driver only: serves objects behind short-lived HMAC-signed URLs. */
  @Public()
  @Get('media/*path')
  async media(@Param('path') pathParts: string[] | string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const objectPath = decodeURIComponent(Array.isArray(pathParts) ? pathParts.join('/') : pathParts);
    const bytes = await this.storage.readSigned(objectPath, Number(exp), String(sig ?? ''));
    if (!bytes) throw new DomainError('not_found', 'Not found', 404);
    const ext = objectPath.split('.').pop();
    const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' }[ext ?? ''] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    // Object keys are never reused (immutable content) and the URL is stable for its expiry window (PCL-14), so the
    // response can be cached until the URL expires: publicly for guest-facing images (menu, studio), privately for
    // documents (receipts, proofs, licences).
    const maxAge = Math.max(0, Math.min(31_536_000, Math.floor(Number(exp) - Date.now() / 1000)));
    res.setHeader('Cache-Control', `${isPublicMediaPath(objectPath) ? 'public' : 'private'}, max-age=${maxAge}, immutable`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  }
}
