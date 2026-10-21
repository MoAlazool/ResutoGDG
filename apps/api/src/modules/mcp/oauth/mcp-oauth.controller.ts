import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { createMcpClient } from '@resuto/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { AuthPrincipal, ResutoRequest, TenantContext } from '../../../common/auth/context';
import { Principal, Public, RequirePermission, RequiresModule, Tenant } from '../../../common/auth/decorators';
import { RequireMfa } from '../../../common/auth/mfa.guard';
import { DomainError } from '../../../common/errors/domain-error';
import { RateLimiter } from '../../../common/http/rate-limiter';
import { zod } from '../../../common/http/zod.pipe';
import { McpOAuthService, OAuthError } from './mcp-oauth.service';

const consentInput = createMcpClient.extend({ name: z.string().trim().min(1).max(80).optional() });

/** RFC 6749 §5.2 error body, never cached. */
function oauthError(res: Response, e: unknown) {
  if (e instanceof OAuthError) {
    res.status(e.status).setHeader('Cache-Control', 'no-store');
    return { error: e.error, error_description: e.description };
  }
  throw e;
}

/**
 * Authorization-server endpoints for MCP clients (FT-17). The Resuto MCP server is the public face (it serves the
 * metadata and forwards /oauth/* here); these routes hold no tenant access and answer in OAuth's own error format.
 */
@Controller('mcp/oauth')
export class McpOAuthController {
  constructor(private readonly oauth: McpOAuthService, private readonly limiter: RateLimiter) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  async register(@Body() body: unknown, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    await this.limiter.guard(`mcp-oauth-register:${req.ip}`, 20, 3600_000);
    try { return await this.oauth.register(body); } catch (e) { return oauthError(res, e); }
  }

  /** Validates an authorization request forwarded by the MCP server; answers with what the browser should see. */
  @Public()
  @Post('authorize')
  @HttpCode(200)
  async authorize(@Body() body: Record<string, unknown>, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`mcp-oauth-authorize:${req.ip}`, 120);
    try { return await this.oauth.authorize(body ?? {}); } catch (e) { return oauthError(res, e); }
  }

  @Public()
  @Post('token')
  @HttpCode(200)
  async token(@Body() body: Record<string, unknown>, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`mcp-oauth-token:${req.ip}`, 120);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try { return await this.oauth.token(body ?? {}); } catch (e) { return oauthError(res, e); }
  }

  @Public()
  @Post('revoke')
  @HttpCode(200)
  async revoke(@Body() body: Record<string, unknown>, @Req() req: ResutoRequest, @Res({ passthrough: true }) res: Response) {
    this.limiter.hit(`mcp-oauth-revoke:${req.ip}`, 120);
    try { return await this.oauth.revoke(body ?? {}); } catch (e) { return oauthError(res, e); }
  }

  // --- Consent (a signed-in staff member, in the dashboard) ---------------------------------------------------------

  @Get('requests/:requestId')
  describe(@Param('requestId', ParseUUIDPipe) id: string, @Principal() p: AuthPrincipal) {
    if (p.kind !== 'user') throw new DomainError('forbidden', 'Staff only', 403);
    return this.oauth.describeRequest(p.userId, id);
  }

  @HttpCode(200)
  @Post('requests/:requestId/deny')
  deny(@Param('requestId', ParseUUIDPipe) id: string, @Principal() p: AuthPrincipal) {
    if (p.kind !== 'user') throw new DomainError('forbidden', 'Staff only', 403);
    return this.oauth.deny(p.userId, id);
  }
}

/** Approving needs mcp:manage in the restaurant the admin picks (same rule as creating a connection key). */
@Controller('o/:orgId/mcp/oauth')
@RequiresModule('mcp')
export class McpOAuthConsentController {
  constructor(private readonly oauth: McpOAuthService) {}

  @HttpCode(200)
  @Post('requests/:requestId/approve')
  @RequireMfa()
  @RequirePermission('mcp:manage')
  approve(@Tenant() ctx: TenantContext, @Param('requestId', ParseUUIDPipe) id: string, @Body(zod(consentInput)) body: z.infer<typeof consentInput>) {
    return this.oauth.approve(ctx, id, body);
  }
}
