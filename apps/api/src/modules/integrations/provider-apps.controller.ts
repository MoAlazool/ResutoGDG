import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { providerAppInput, type ProviderAppInput } from '@resuto/contracts';
import type { AuthPrincipal } from '../../common/auth/context';
import { PlatformAdmin, Principal } from '../../common/auth/decorators';
import { RequireMfa } from '../../common/auth/mfa.guard';
import { forbidden } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { PlatformProviderAppsService } from './provider-apps.service';

const userOf = (p: AuthPrincipal) => {
  if (p.kind !== 'user') throw forbidden('Platform administrators only');
  return p.userId;
};

/**
 * `/v1/admin/providers` — the operator console for Resuto's own provider apps (21-INT, plan §6.3). Platform staff
 * only (AccessGuard checks platform_admins): every platform role reads the console, where secrets are masked;
 * superadmins save and delete. Restaurant members, MCP clients and POS devices are refused.
 */
@Controller('admin/providers')
@RequireMfa()
export class ProviderAppsController {
  constructor(private readonly apps: PlatformProviderAppsService) {}

  @Get()
  @PlatformAdmin()
  list() {
    return this.apps.list();
  }

  @Get(':provider')
  @PlatformAdmin()
  get(@Param('provider') provider: string) {
    return this.apps.get(provider);
  }

  /** Secrets are write-only: the response says whether each is set and shows its last four characters. */
  @Put(':provider')
  @PlatformAdmin('superadmin')
  save(@Principal() p: AuthPrincipal, @Param('provider') provider: string, @Body(zod(providerAppInput)) body: ProviderAppInput) {
    return this.apps.save(userOf(p), provider, body);
  }

  /** Removes the console record; the environment variables apply again. */
  @Delete(':provider')
  @PlatformAdmin('superadmin')
  remove(@Principal() p: AuthPrincipal, @Param('provider') provider: string) {
    return this.apps.remove(userOf(p), provider);
  }
}
