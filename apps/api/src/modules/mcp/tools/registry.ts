import type { McpToolName } from '@resuto/contracts';
import { actionTools } from './action-tools';
import { changeTools } from './change-tools';
import { dataTools } from './data-tools';
import { readTools } from './read-tools';
import type { McpTool } from './types';

/** The complete, fixed MCP tool registry. No dynamic or SQL tools exist. */
export const MCP_TOOL_REGISTRY: ReadonlyMap<McpToolName, McpTool> = new Map([...readTools, ...dataTools, ...actionTools, ...changeTools].map((t) => [t.name, t]));
