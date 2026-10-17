import { Injectable } from '@nestjs/common';
import type { IntegrationSyncRequest } from '@resuto/contracts';
import { posAdapterFor, ProviderError, type MenuImportRow } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IntegrationConnectionsService } from './connections.service';

const IMPORT_SOURCE: Record<string, 'foodics' | 'odoo' | 'csv'> = { foodics: 'foodics', odoo: 'odoo', pos_sandbox: 'csv' };
const MAX_STORED_ROWS = 2000;

export interface ImportableRow extends MenuImportRow {
  /** create: no Resuto product has this externalId; update: provider is the menu of record and data differs. */
  action: 'create' | 'update';
}

const iso = (v: Date | string | null) => (v ? new Date(v).toISOString() : null);
const runView = (r: any) => ({
  id: r.id, connectionId: r.connection_id, resource: r.resource, direction: r.direction, status: r.status, attempt: r.attempt,
  stats: r.stats ?? {}, error: r.error, startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
});

/**
 * Pull syncs (POS menu import). Rows are returned for review and are applied by
 * B1's menu import endpoints from the dashboard — this module never writes menu
 * tables. Source-of-truth rules (contracts/integrations.ts):
 *   menu = 'resuto'   → a fetched row whose externalId matches an existing product
 *                        with different name/price becomes a pending conflict and is
 *                        NOT offered for import until a human keeps the external value.
 *   menu = 'provider' → such rows are offered for import as updates (no conflict).
 * Unchanged rows are skipped in both modes.
 */
@Injectable()
export class IntegrationSyncService {
  constructor(private readonly db: DbService, private readonly connections: IntegrationConnectionsService, private readonly audit: AuditService) {}

  async run(ctx: TenantContext, connectionId: string, req: IntegrationSyncRequest) {
    const view = await this.connections.get(ctx, connectionId);
    if (view.category !== 'pos') throw invalid('sync_unsupported', 'Only POS connections support menu sync');
    if (!view.enabled || view.status === 'revoked') throw conflict('connection_disabled', 'Enable the connection before syncing');
    const adapter = posAdapterFor(view.provider);
    if (!adapter) throw invalid('sync_unsupported', `${view.provider} has no menu adapter`);
    this.connections.assertNotRateLimited(await this.connections.rateLimit(ctx.orgId, connectionId));
    const conn = await this.connections.load(ctx.orgId, { id: connectionId });
    const currency = (await this.db.scoped(ctx, (tx) => tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]))).currency;

    // Cursor: explicit request value, else resume a partial/failed run, else start over.
    const run = await this.db.scoped(ctx, async (tx) => {
      const stored = await tx.maybeOne<{ cursor: string | null }>(`select cursor from integration_sync_cursors where connection_id = $1 and resource = $2`, [connectionId, req.resource]);
      const last = await tx.query<{ status: string }>(`select status from integration_sync_runs where connection_id = $1 and resource = $2 order by started_at desc limit 10`, [connectionId, req.resource]);
      let attempt = 1;
      for (const r of last) { if (r.status === 'failed') attempt++; else break; }
      const startCursor = req.cursor !== undefined ? req.cursor : stored?.cursor ?? null;
      const row = await tx.one(`insert into integration_sync_runs(org_id, connection_id, resource, direction, attempt, stats) values ($1, $2, $3, 'pull', $4, $5) returning *`,
        [ctx.orgId, connectionId, req.resource, attempt, { startCursor }]);
      return { ...row, startCursor };
    });

    const rows: MenuImportRow[] = [];
    const warnings: string[] = [];
    let cursor: string | null = run.startCursor;
    let pages = 0;
    let failure: ProviderError | Error | null = null;
    try {
      do {
        const page = await adapter.fetchMenuPage(conn.adapter, { cursor, currency });
        rows.push(...page.rows);
        warnings.push(...page.warnings);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < req.maxPages && rows.length < MAX_STORED_ROWS);
    } catch (e) {
      failure = e as Error;
      if (e instanceof ProviderError && e.status === 429) await this.connections.markRateLimited(ctx.orgId, connectionId, e.retryAfterMs);
    }

    return this.db.withTenant(ctx.orgId, async (tx) => {
      const classified = await this.classify(tx, ctx.orgId, connectionId, rows, conn.sourceOfTruth.menu);
      const status = failure ? (pages > 0 ? 'partial' : 'failed') : cursor ? 'partial' : 'succeeded';
      const stats = {
        startCursor: run.startCursor, pages, fetched: rows.length, importable: classified.importable.length, unchanged: classified.unchanged,
        conflicts: classified.conflicts, warnings: [...new Set(warnings)].slice(0, 20), nextCursor: cursor,
        importSource: IMPORT_SOURCE[view.provider] ?? null, sandbox: adapter.descriptor.readiness === 'simulated',
        rows: classified.importable.slice(0, MAX_STORED_ROWS),
      };
      const errorText = failure ? (failure instanceof ProviderError ? failure.message : `Sync failed: ${failure.message}`).slice(0, 1000) : null;
      const updated = await tx.one(`update integration_sync_runs set status = $2, stats = $3, error = $4, finished_at = now() where id = $1 returning *`,
        [run.id, status, stats, errorText]);
      await tx.query(
        `insert into integration_sync_cursors(org_id, connection_id, resource, cursor, last_synced_at) values ($1, $2, $3, $4, case when $5 then now() end)
         on conflict (connection_id, resource) do update set cursor = excluded.cursor,
           last_synced_at = coalesce(excluded.last_synced_at, integration_sync_cursors.last_synced_at)`,
        [ctx.orgId, connectionId, req.resource, cursor, status === 'succeeded']);
      await tx.query(`update integration_connections set last_error = $2${failure ? '' : ", status = case when status in ('pending', 'error') then 'connected'::integration_status else status end"} where id = $1`,
        [connectionId, errorText]);
      await this.connections.log(tx, ctx.orgId, connectionId, failure ? 'error' : 'info',
        failure ? `Menu sync ${status}: ${errorText}` : `Menu sync ${status}: ${rows.length} fetched, ${classified.importable.length} to review, ${classified.conflicts} conflicts`,
        { runId: run.id, pages, attempt: run.attempt });
      await this.audit.record(tx, ctx, { action: 'integration.sync', entityType: 'integration_sync_run', entityId: run.id, metadata: { provider: view.provider, status } });
      if (failure && pages === 0) {
        const retryable = failure instanceof ProviderError && failure.retryable;
        return { run: runView(updated), rows: [], warnings: stats.warnings, nextCursor: cursor, importSource: stats.importSource, retryable };
      }
      return { run: runView(updated), rows: classified.importable, warnings: stats.warnings, nextCursor: cursor, importSource: stats.importSource, retryable: false };
    }, `${ctx.actorType}:${ctx.actorId}`);
  }

  /** Compares fetched rows with products by external_ref (read-only) and records conflicts. */
  private async classify(tx: any, orgId: string, connectionId: string, rows: MenuImportRow[], menuOwner: 'resuto' | 'provider') {
    const ids = rows.map((r) => r.externalId).filter((x): x is string => !!x);
    const existing = ids.length
      ? await tx.query(`select id, external_ref, name, name_ar, price_minor, description from products where org_id = $1 and external_ref = any($2::text[])`, [orgId, ids])
      : [];
    const byRef = new Map<string, any>(existing.map((p: any) => [p.external_ref, p]));
    const importable: ImportableRow[] = [];
    let unchanged = 0, conflicts = 0;
    for (const row of rows) {
      const local = row.externalId ? byRef.get(row.externalId) : undefined;
      if (!local) { importable.push({ ...row, action: 'create' }); continue; }
      const differs = local.name !== row.name || Number(local.price_minor) !== row.priceMinor;
      if (!differs) { unchanged++; continue; }
      if (menuOwner === 'provider') { importable.push({ ...row, action: 'update' }); continue; }
      conflicts++;
      await tx.query(
        `insert into integration_conflicts(org_id, connection_id, resource, local_id, external_id, local_snapshot, external_snapshot)
         values ($1, $2, 'menu', $3, $4, $5, $6)
         on conflict (connection_id, resource, external_id) where resolution = 'pending'
         do update set local_snapshot = excluded.local_snapshot, external_snapshot = excluded.external_snapshot, created_at = now()`,
        [orgId, connectionId, local.id, row.externalId, { name: local.name, nameAr: local.name_ar, priceMinor: Number(local.price_minor), description: local.description }, row]);
    }
    return { importable, unchanged, conflicts };
  }

  runs(ctx: TenantContext, connectionId: string, limit: number) {
    return this.db.scoped(ctx, async (tx) => {
      await this.connections.row(tx, ctx, connectionId);
      const rows = await tx.query(`select id, connection_id, resource, direction, status, attempt, stats - 'rows' as stats, error, started_at, finished_at
          from integration_sync_runs where connection_id = $1 order by started_at desc limit $2`, [connectionId, limit]);
      return { items: rows.map(runView), nextCursor: null };
    });
  }

  getRun(ctx: TenantContext, runId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from integration_sync_runs where id = $1 and org_id = $2`, [runId, ctx.orgId]);
      if (!r) throw notFound('Sync run');
      await this.connections.row(tx, ctx, r.connection_id);
      return { ...runView({ ...r, stats: { ...r.stats, rows: undefined } }), rows: r.stats?.rows ?? [] };
    });
  }

  conflicts(ctx: TenantContext, filter: { status?: string; connectionId?: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select k.*, c.provider from integration_conflicts k join integration_connections c on c.id = k.connection_id
          where k.org_id = $1 and ($2::text is null or k.resolution = $2) and ($3::uuid is null or k.connection_id = $3)
          order by k.created_at desc limit 200`, [ctx.orgId, filter.status ?? null, filter.connectionId ?? null]);
      return {
        items: rows.map((r) => ({
          id: r.id, connectionId: r.connection_id, provider: r.provider, resource: r.resource, localId: r.local_id, externalId: r.external_id,
          local: r.local_snapshot, external: r.external_snapshot, resolution: r.resolution, resolvedAt: iso(r.resolved_at), createdAt: iso(r.created_at),
        })),
        nextCursor: null,
      };
    });
  }

  /**
   * Resolves a conflict. kept_external returns the provider row so the dashboard
   * can send it to B1's import endpoint; kept_local/ignored change nothing else.
   */
  resolve(ctx: TenantContext, conflictId: string, resolution: 'kept_local' | 'kept_external' | 'ignored') {
    return this.db.scoped(ctx, async (tx) => {
      const k = await tx.maybeOne(`select * from integration_conflicts where id = $1 and org_id = $2 for update`, [conflictId, ctx.orgId]);
      if (!k) throw notFound('Conflict');
      await this.connections.row(tx, ctx, k.connection_id);
      if (k.resolution !== 'pending') throw new DomainError('conflict_resolved', 'This conflict was already resolved', 409, { resolution: k.resolution });
      await tx.query(`update integration_conflicts set resolution = $2, resolved_by = $3, resolved_at = now() where id = $1`, [conflictId, resolution, ctx.userId]);
      await this.connections.log(tx, ctx.orgId, k.connection_id, 'info', `Conflict ${k.external_id} resolved: ${resolution}`, { conflictId });
      await this.audit.record(tx, ctx, { action: 'integration.conflict_resolved', entityType: 'integration_conflict', entityId: conflictId, metadata: { resolution } });
      return { id: conflictId, resolution, importRow: resolution === 'kept_external' ? { ...k.external_snapshot, action: 'update' } : null };
    });
  }
}
