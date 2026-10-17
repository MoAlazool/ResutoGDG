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
}
