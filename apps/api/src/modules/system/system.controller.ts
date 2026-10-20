import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { StorageService } from '../../common/storage/storage.service';
import { ENV, type Env } from '../../config/env';

@Controller()
export class SystemController {
  constructor(private readonly db: DbService, private readonly storage: StorageService, @Inject(ENV) private readonly env: Env) {}

  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    await this.db.withPlatform((tx) => tx.query('select 1'));
    // paymentMode lets operators (and the staff UI) see at a glance that a deployment runs simulated payments.
    return { status: 'ok', db: { latencyMs: Date.now() - started }, version: process.env.npm_package_version ?? '0.1.0',
      environment: this.env.NODE_ENV, paymentMode: this.env.PAYMENT_MODE };
  }

  /** Local storage driver only: serves objects behind short-lived HMAC-signed URLs. */
  @Public()
  @Get('media/*path')
  async media(@Param('path') pathParts: string[] | string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const objectPath = decodeURIComponent(Array.isArray(pathParts) ? pathParts.join('/') : pathParts);
    const bytes = await this.storage.readSigned(objectPath, Number(exp), String(sig ?? ''));
    if (!bytes) return res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
    const ext = objectPath.split('.').pop();
    const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', pdf: 'application/pdf' }[ext ?? ''] ?? 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  }
}
