import { Injectable, Logger } from '@nestjs/common';
import { parseFoodicsWebhook } from '@resuto/integrations';
import { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';
import { OutboxService } from '../../common/platform/outbox.service';
import { IntegrationConnectionsService } from './connections.service';
import { foodicsWebhookToken } from './meta-platform';
import { IntegrationSyncService } from './sync.service';

/** A menu change within this window of the last pull (or a queued one) does not schedule another. */
export const MENU_NUDGE_DEBOUNCE_SECONDS = 120;

/**
 * Foodics menu-change webhook (INT-24). Foodics posts menu.updated to ONE URL per app and documents no signature, so:
 *   * the URL carries Resuto's own secret (FOODICS_WEBHOOK_TOKEN, compared in constant time; unset = every call refused);
 *   * the payload is never applied: only business.reference is read, to find the connection(s) whose owner confirmed
 *     that Foodics business during OAuth, and a pull sync is scheduled through the outbox (debounced);
 *   * the pull uses the restaurant's own token, and its rows still go through review (nothing is published by it).
 * A forged call can therefore at most cause one extra read of the business's own menu.
 */
@Injectable()
export class PosWebhooksService {
  private readonly logger = new Logger('PosWebhooks');

  constructor(
    private readonly db: DbService,
    private readonly outbox: OutboxService,
    private readonly sync: IntegrationSyncService,
    private readonly connections: IntegrationConnectionsService,
  ) {}

  async foodics(urlToken: string, body: unknown): Promise<{ status: number; result: Record<string, unknown> }> {
    const parsed = parseFoodicsWebhook({ urlToken, expectedToken: foodicsWebhookToken(), body });
    if (!parsed.ok) {
      // Wrong or unconfigured secret: 404 (the URL does not exist). Otherwise 200 so Foodics does not block the endpoint.
      if (parsed.reason === 'not_configured' || parsed.reason === 'bad_token') return { status: 404, result: { ok: false } };
      return { status: 200, result: { ok: true, ignored: parsed.reason } };
    }
    const conns = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string }>(
      `select id, org_id from integration_connections
        where provider = 'foodics' and enabled and status = 'connected' and config->>'businessReference' = $1`, [parsed.nudge.businessReference]), 'webhook:foodics');
    let scheduled = 0;
    for (const c of conns) {
      const queued = await this.db.withTenant(c.org_id, async (tx) => {
        await tx.query(`select pg_advisory_xact_lock(hashtext('foodics-nudge:' || $1::text))`, [c.id]);
        const recent = await tx.maybeOne(
          `select 1 from integration_sync_runs where connection_id = $1::uuid and started_at > now() - make_interval(secs => $2)
           union all
           select 1 from outbox_events where aggregate_id::text = $1::text and event_type = 'integration.menu_changed' and published_at is null
           limit 1`, [c.id, MENU_NUDGE_DEBOUNCE_SECONDS]);
        if (recent) return false;
        await this.outbox.publish(tx, c.org_id, { type: 'integration.menu_changed', aggregateType: 'integration_connection', aggregateId: c.id,
          payload: { provider: 'foodics', event: parsed.nudge.event } });
        await this.connections.log(tx, c.org_id, c.id, 'info', 'Foodics reported a menu change; a menu pull was scheduled', { event: parsed.nudge.event });
        return true;
      }, 'webhook:foodics');
      if (queued) scheduled++;
    }
    return { status: 200, result: { ok: true, connections: conns.length, scheduled } };
  }

  /** Runs the scheduled pull as the system (rows land in the review list exactly like a manual sync). */
  @OnDomainEvent('integrations.menu_pull', 'integration.menu_changed', { timeoutMs: 120_000 })
  async onMenuChanged(e: OutboxEvent) {
    if (!e.orgId) return { skipped: 'no_org' };
    const ctx = TenantContext.system(e.orgId, 'integrations:menu-webhook');
    try {
      const r = await this.sync.run(ctx, e.aggregateId, { resource: 'menu', direction: 'pull', maxPages: 5 });
      return { run: r.run.id, status: r.run.status };
    } catch (err) {
      // A disconnected / disabled connection is not retried; anything else is (outbox retry with backoff).
      const code = (err as { code?: string }).code;
      if (code === 'connection_disabled' || code === 'not_found' || code === 'sync_unsupported') return { skipped: code };
      this.logger.warn(`menu pull after webhook failed: ${(err as Error).message}`);
      throw err;
    }
  }
}
