import { ROLE_PERMISSIONS, type ModuleKey, type Permission, type Role } from '@resuto/contracts';
import { forbidden } from '../errors/domain-error';

export interface AuthUser {
  kind: 'user';
  userId: string;
  email: string | null;
  claims: Record<string, unknown>;
}

export interface AuthMcpClient {
  kind: 'mcp';
  clientId: string;
  orgId: string;
  role: Role;
  branchIds: string[] | null;
  allowedTools: string[];
  rateLimitPerMin: number;
  /** Set for OAuth access tokens (FT-17): the MCP resource URI the token was issued for. */
  oauthResource?: string;
}

export type AuthPrincipal = AuthUser | AuthMcpClient;

/**
 * Who is acting, inside which tenant, with which role. Every tenant-scoped
 * service method receives one of these; it is the only way to reach tenant data.
 */
export class TenantContext {
  constructor(
    readonly orgId: string,
    readonly role: Role,
    readonly branchIds: string[] | null,
    /** Staff user id, or null for MCP clients / system jobs. */
    readonly userId: string | null,
    readonly actorType: 'user' | 'mcp_client' | 'system' | 'guest' | 'driver',
    readonly actorId: string,
    readonly source: 'api' | 'mcp' | 'worker' | 'webhook' | 'web' = 'api',
  ) {}

  can(permission: Permission): boolean {
    return ROLE_PERMISSIONS[this.role].includes(permission);
  }

  require(permission: Permission): void {
    if (!this.can(permission)) throw forbidden(`Your role (${this.role}) cannot perform ${permission}`);
  }

  canAccessBranch(branchId: string | null | undefined): boolean {
    return !branchId || this.branchIds === null || this.branchIds.includes(branchId);
  }

  assertBranch(branchId: string | null | undefined): void {
    if (!this.canAccessBranch(branchId)) throw forbidden('You do not have access to this branch');
  }

  /** Branch filter for list queries: null = all branches. */
  get branchFilter(): string[] | null {
    return this.branchIds;
  }

  static system(orgId: string, actorId = 'system', source: TenantContext['source'] = 'worker') {
    return new TenantContext(orgId, 'admin', null, null, 'system', actorId, source);
  }
}

export interface ResutoRequest {
  id?: string;
  principal?: AuthPrincipal;
  tenant?: TenantContext;
  entitlementCache?: Map<ModuleKey, boolean>;
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  rawBody?: Buffer;
}
