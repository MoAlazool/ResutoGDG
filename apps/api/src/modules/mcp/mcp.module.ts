import { Module } from '@nestjs/common';
import { ChangesModule } from '../changes/changes.module';
import { FinanceModule } from '../finance/finance.module';
import { McpCallFilter } from './mcp-call.filter';
import { McpClientsService } from './mcp-clients.service';
import { McpExecutionService } from './mcp-execution.service';
import { McpController } from './mcp.controller';
import { McpJobs } from './mcp.jobs';
import { McpRuntimeController } from './mcp-runtime.controller';
import { McpOAuthConsentController, McpOAuthController } from './oauth/mcp-oauth.controller';
import { McpOAuthService, OAUTH_FETCH } from './oauth/mcp-oauth.service';

/**
 * ResutoMCP. Owner: Agent E2 (docs/architecture/MODULE_CONTRACTS.md).
 * Client keys, tool registry, approvals, call log. External AI clients reach it
 * through apps/mcp-server, which holds no database access.
 */
@Module({
  // FinanceModule: get_finance_summary reuses FinanceService.pnlTx (FT-17). ChangesModule: sensitive tools run as change sets (21-CS).
  imports: [FinanceModule, ChangesModule],
  controllers: [McpController, McpRuntimeController, McpOAuthController, McpOAuthConsentController],
  providers: [McpClientsService, McpExecutionService, McpJobs, McpCallFilter, McpOAuthService,
    // null = the egress-guarded platform fetch (tests replace it to serve client metadata documents).
    { provide: OAUTH_FETCH, useValue: null }],
  exports: [McpExecutionService],
})
export class McpModule {}
