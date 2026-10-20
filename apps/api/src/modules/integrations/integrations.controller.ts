import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import {
  createIntegrationConnection, integrationAccountSelection, integrationOauthComplete, integrationOauthStart, integrationProviderId, integrationSyncRequest,
  resolveIntegrationConflict, updateIntegrationConnection,
} from '@resuto/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { IntegrationConnectionsService } from './connections.service';
import { IntegrationOAuthService } from './oauth.service';
import { IntegrationSyncService } from './sync.service';

const limitOf = (v?: string, d = 50) => Math.min(Math.max(Number(v) || d, 1), 200);

/**
 * Integration framework. Core capability (no paid module): every route needs
 * integrations:manage. Credentials are write-only through this API.
 */
@Controller()
export class IntegrationsController {
  constructor(
    private readonly connections: IntegrationConnectionsService,
    private readonly sync: IntegrationSyncService,
    private readonly oauth: IntegrationOAuthService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get('o/:orgId/integrations/catalog')
  @RequirePermission('integrations:manage')
  async catalog(@Tenant() ctx: TenantContext) {
    return { items: (await this.connections.catalog(ctx)).map((e) => ({ ...e, oauthConfigured: e.authType === 'oauth' ? !!this.oauth.appConfig(e.id) : null })) };
  }

  @Get('o/:orgId/integrations/connections')
  @RequirePermission('integrations:manage')
  list(@Tenant() ctx: TenantContext, @Query('category') category?: string) {
    return this.connections.list(ctx, { category: category ? z.string().max(20).parse(category) : undefined });
  }

  @Post('o/:orgId/integrations/connections')
  @RequirePermission('integrations:manage')
  create(@Tenant() ctx: TenantContext, @Body(zod(createIntegrationConnection)) body: z.infer<typeof createIntegrationConnection>) {
    return this.connections.create(ctx, body);
  }

  @Get('o/:orgId/integrations/connections/:id')
  @RequirePermission('integrations:manage')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.get(ctx, id);
  }

  @Patch('o/:orgId/integrations/connections/:id')
  @RequirePermission('integrations:manage')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(updateIntegrationConnection)) body: z.infer<typeof updateIntegrationConnection>) {
    return this.connections.update(ctx, id, body);
  }

  @Post('o/:orgId/integrations/connections/:id/enable')
  @RequirePermission('integrations:manage')
  enable(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.setEnabled(ctx, id, true);
  }

  @Post('o/:orgId/integrations/connections/:id/disable')
  @RequirePermission('integrations:manage')
  disable(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.setEnabled(ctx, id, false);
  }

  @Post('o/:orgId/integrations/connections/:id/revoke')
  @RequirePermission('integrations:manage')
  revoke(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.revoke(ctx, id);
  }

  @Delete('o/:orgId/integrations/connections/:id')
  @RequirePermission('integrations:manage')
  remove(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.remove(ctx, id);
  }

  @Post('o/:orgId/integrations/connections/:id/health')
  @RequirePermission('integrations:manage')
  health(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.connections.healthCheck(ctx, id);
  }

  @Post('o/:orgId/integrations/connections/:id/sync')
  @RequirePermission('integrations:manage')
  runSync(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(integrationSyncRequest)) body: z.infer<typeof integrationSyncRequest>) {
    return this.sync.run(ctx, id, body);
  }

  @Get('o/:orgId/integrations/connections/:id/sync-runs')
  @RequirePermission('integrations:manage')
  runs(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.sync.runs(ctx, id, limitOf(limit, 20));
  }

  @Get('o/:orgId/integrations/sync-runs/:runId')
  @RequirePermission('integrations:manage')
  run(@Tenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) runId: string) {
    return this.sync.getRun(ctx, runId);
  }

  @Get('o/:orgId/integrations/connections/:id/logs')
  @RequirePermission('integrations:manage')
  connectionLogs(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.connections.logs(ctx, id, limitOf(limit), before ? Number(before) : undefined);
  }

  @Get('o/:orgId/integrations/logs')
  @RequirePermission('integrations:manage')
  logs(@Tenant() ctx: TenantContext, @Query('limit') limit?: string, @Query('before') before?: string) {
    return this.connections.logs(ctx, null, limitOf(limit), before ? Number(before) : undefined);
  }

  @Get('o/:orgId/integrations/conflicts')
  @RequirePermission('integrations:manage')
  conflicts(@Tenant() ctx: TenantContext, @Query('status') status?: string, @Query('connectionId') connectionId?: string) {
    return this.sync.conflicts(ctx, {
      status: status ? z.enum(['pending', 'kept_local', 'kept_external', 'merged', 'ignored']).parse(status) : undefined,
      connectionId: connectionId ? z.uuid().parse(connectionId) : undefined,
    });
  }

  @Post('o/:orgId/integrations/conflicts/:conflictId/resolve')
  @RequirePermission('integrations:manage')
  resolve(@Tenant() ctx: TenantContext, @Param('conflictId', ParseUUIDPipe) id: string, @Body(zod(resolveIntegrationConflict)) body: z.infer<typeof resolveIntegrationConflict>) {
    return this.sync.resolve(ctx, id, body.resolution);
  }

  @Post('o/:orgId/integrations/oauth/:provider/start')
  @RequirePermission('integrations:manage')
  oauthStart(@Tenant() ctx: TenantContext, @Param('provider') provider: string, @Body(zod(integrationOauthStart)) body: z.infer<typeof integrationOauthStart>) {
    return this.oauth.start(ctx, integrationProviderId.parse(provider), body);
  }

  /** PS-11: completes the flow for the user who started it, from the browser holding the nonce. */
  @Post('o/:orgId/integrations/oauth/:provider/complete')
  @RequirePermission('integrations:manage')
  oauthComplete(@Tenant() ctx: TenantContext, @Param('provider') provider: string, @Body(zod(integrationOauthComplete)) body: z.infer<typeof integrationOauthComplete>) {
    return this.oauth.complete(ctx, integrationProviderId.parse(provider), body);
  }

  /** INT-11: the ad accounts / advertisers the connection's token can use (fresh from the provider). */
  @Get('o/:orgId/integrations/connections/:id/accounts')
  @RequirePermission('integrations:manage')
  accounts(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.oauth.listAccounts(ctx, id);
  }

  /** INT-11: picks the account the connection uses, from the ones the provider granted; then checks its health. */
  @Post('o/:orgId/integrations/connections/:id/account')
  @RequirePermission('integrations:manage')
  selectAccount(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(integrationAccountSelection)) body: z.infer<typeof integrationAccountSelection>) {
    return this.oauth.selectAccount(ctx, id, body.accountId);
  }

  /**
   * Registered provider redirect URI. It completes nothing (PS-11): it forwards code and state to the web app, which
   * completes the flow with the signed-in user's session and the browser nonce. The page must not be cached or
   * referred onward (the code is in the URL).
   */
  @Get('public/integrations/oauth/:provider/callback')
  @Public()
  oauthCallback(@Param('provider') provider: string, @Query() query: Record<string, string | undefined>, @Res() res: Response) {
    this.limiter.hit(`oauth:${res.req.ip}`, 30);
    const target = this.oauth.callbackRedirect(integrationProviderId.parse(provider), {
      code: query.code ?? query.auth_code, state: query.state, error: query.error, error_description: query.error_description,
    });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.redirect(302, target);
  }
}
