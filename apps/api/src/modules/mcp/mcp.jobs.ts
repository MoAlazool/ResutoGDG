import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Scheduled } from '../../common/events/events';
import { McpExecutionService } from './mcp-execution.service';

@Injectable()
export class McpJobs {
  private readonly logger = new Logger('McpJobs');
  constructor(private readonly db: DbService, private readonly exec: McpExecutionService) {}

  /** Expires approval requests nobody decided on in time: platform query only resolves tenants, updates run per tenant. */
  @Scheduled('mcp.expire_approvals', 60)
  async expireApprovals(): Promise<number> {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct org_id from mcp_approvals where status = 'pending' and expires_at <= now() limit 500`));
    let n = 0;
    for (const { org_id } of orgs) n += await this.exec.expireDue(org_id);
    if (n) this.logger.log(`expired ${n} MCP approval request(s)`);
    return n;
  }

  /** 21-MCP: removes MCP sessions that expired or were closed more than an hour ago (sessions are database-backed). */
  @Scheduled('mcp.sessions_cleanup', 600)
  async cleanupSessions(): Promise<number> {
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string }>(
      `delete from mcp_sessions where expires_at < now() - interval '1 hour' or closed_at < now() - interval '1 hour' returning id`));
    return rows.length;
  }
}
