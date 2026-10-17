import { Module } from '@nestjs/common';
import { McpCallFilter } from './mcp-call.filter';
import { McpClientsService } from './mcp-clients.service';
import { McpExecutionService } from './mcp-execution.service';
import { McpController } from './mcp.controller';
import { McpJobs } from './mcp.jobs';
import { McpRuntimeController } from './mcp-runtime.controller';

/**
 * ResutoMCP. Owner: Agent E2 (docs/architecture/MODULE_CONTRACTS.md).
 * Client keys, tool registry, approvals, call log. External AI clients reach it
 * through apps/mcp-server, which holds no database access.
 */
@Module({
  controllers: [McpController, McpRuntimeController],
  providers: [McpClientsService, McpExecutionService, McpJobs, McpCallFilter],
  exports: [McpExecutionService],
})
export class McpModule {}
