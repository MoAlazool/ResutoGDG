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
  /** Set for OAuth access tokens: the scopes this token was issued with (allowedTools is already limited to them). */
  oauthScopes?: string[];
}

/** A paired POS device (21-POSAPI, rpos_ credential): one org, one branch, one acting role (waiter, cashier or kitchen). */
export interface AuthPosDevice {
  kind: 'device';
  deviceId: string;
  orgId: string;
  branchId: string;
  role: Role;
  /** Paired with requireStaff (contract 0.2.0): every device route except the session needs a staff session. */
  requireStaff: boolean;
  /** Set when the request also carried a staff session (X-Resuto-Staff-Authorization) that the guard accepted. */
  staff?: { userId: string; email: string | null; role: Role };
}

export type AuthPrincipal = AuthUser | AuthMcpClient | AuthPosDevice;

/**
 * Who is acting, inside which tenant, with which role. Every tenant-scoped
 * service method receives one of these; it is the only way to reach tenant data.
 */
export interface TenantContextOptions {
  /**
   * A second role whose permissions bound this context's (contract 0.2.0): a staff member signed in on a paired POS
   * device may do only what both their own role and the device's acting role allow. Absent = no ceiling.
   */
  ceilingRole?: Role;
  /**
   * The POS device the request came through (21-POSAPI). Set for device contexts and for staff sessions on a device,
   * where actorId is the staff user: device-owned records (pos_order_submissions.device_id, print-job claims, the
   * device's session) use this, never actorId.
   */
  deviceId?: string;
}

export class TenantContext {
  readonly ceilingRole?: Role;
  readonly deviceId?: string;

  constructor(
    readonly orgId: string,
    readonly role: Role,
    readonly branchIds: string[] | null,
    /** Staff user id, or null for MCP clients, POS devices and system jobs. */
    readonly userId: string | null,
    readonly actorType: 'user' | 'mcp_client' | 'system' | 'guest' | 'driver' | 'device',
    readonly actorId: string,
    readonly source: 'api' | 'mcp' | 'worker' | 'webhook' | 'web' = 'api',
    options: TenantContextOptions = {},
  ) {
    if (options.ceilingRole) this.ceilingRole = options.ceilingRole;
    if (options.deviceId) this.deviceId = options.deviceId;
  }

  /** The role grants the permission and, when there is a ceiling, so does the ceiling role. */
  can(permission: Permission): boolean {
    return ROLE_PERMISSIONS[this.role].includes(permission)
      && (this.ceilingRole === undefined || ROLE_PERMISSIONS[this.ceilingRole].includes(permission));
  }

  /** Every permission this context has (the role's, bounded by the ceiling), in the matrix's order. */
  get permissions(): Permission[] {
    return ROLE_PERMISSIONS[this.role].filter((p) => this.can(p));
  }

  require(permission: Permission): void {
    if (this.can(permission)) return;
    if (this.ceilingRole && ROLE_PERMISSIONS[this.role].includes(permission)) {
      throw forbidden(`This device (acting as ${this.ceilingRole}) cannot perform ${permission}`);
    }
    throw forbidden(`Your role (${this.role}) cannot perform ${permission}`);
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
