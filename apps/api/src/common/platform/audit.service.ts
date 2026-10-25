import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../auth/context';
import type { Tx } from '../db/db.service';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  branchId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit trail, written in the same transaction as the change. A staff member acting on a paired POS device
 * (contract 0.2.0) is the actor; the device it came through is recorded as metadata.deviceId.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, ctx: TenantContext, entry: AuditEntry): Promise<void> {
    const metadata = ctx.deviceId && ctx.actorType !== 'device' ? { ...entry.metadata, deviceId: ctx.deviceId } : entry.metadata ?? {};
    await tx.query(
      `insert into audit_logs(org_id, branch_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [ctx.orgId, entry.branchId ?? null, ctx.actorType, ctx.actorId, entry.action, entry.entityType ?? null,
        entry.entityId ?? null, ctx.source, metadata],
    );
  }
}
