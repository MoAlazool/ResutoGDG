import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult, type RequestId, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ApiError, type ResutoApi, type ToolCallResponse, type ToolDescriptor, type WhoAmI } from './api.js';

export const SERVER_INFO = { name: 'resuto', title: 'Resuto', version: '0.1.0' } as const;

/** Tool calls the HTTP layer already made for a request id (scope check, http.ts); the handler answers with them. */
export type PrefetchedCalls = Map<RequestId, ToolCallResponse | ApiError>;

const ERROR_HINTS: Record<string, string> = {
  forbidden: 'The Resuto connection is not permitted to do this (role, branch or tool restrictions). A restaurant admin can change the connection in Resuto → MCP.',
  tool_not_allowed: 'This tool is not enabled for this connection. A restaurant admin can enable it in Resuto → MCP.',
  rate_limited: 'Too many requests. Wait a minute and retry.',
  invalid_input: 'Fix the arguments and call the tool again.',
  module_unavailable: 'This capability is not available in this Resuto deployment yet.',
  module_not_entitled: 'The restaurant\'s Resuto plan does not include this module.',
  not_found: 'No such record for this restaurant (or outside this connection\'s branches).',
  unauthorized: 'The Resuto key is invalid, expired or revoked. Ask the restaurant for a new key.',
};

/** Maps a Resuto tool response or error onto an MCP CallToolResult. */
export function toCallToolResult(result: ToolCallResponse | ApiError): CallToolResult {
  if (result instanceof ApiError) {
    const payload = { error: { code: result.code, message: result.message, ...(result.details !== undefined ? { details: result.details } : {}) } };
    const hint = ERROR_HINTS[result.code] ?? (result.status >= 500 ? 'Resuto could not complete the request. Retry later.' : undefined);
    return {
      isError: true,
      content: [{ type: 'text', text: `${result.code}: ${result.message}${hint ? `\n${hint}` : ''}\n${JSON.stringify(payload)}` }],
    };
  }
  // approval_required is an expected outcome, not an error: the structured output tells the model what happens next.
  const text = result.status === 'approval_required'
    ? `${String(result.output.message ?? 'Approval required.')}\n${JSON.stringify(result.output)}`
    : JSON.stringify(result.output);
  return { content: [{ type: 'text', text }], structuredContent: result.output };
}

export function toMcpTool(t: ToolDescriptor): Tool {
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    outputSchema: t.outputSchema,
    annotations: { title: t.title, readOnlyHint: !!t.annotations.readOnlyHint, destructiveHint: !!t.annotations.destructiveHint,
      idempotentHint: !!t.annotations.idempotentHint, openWorldHint: !!t.annotations.openWorldHint },
  };
}

/**
 * One MCP server per authenticated session. The low-level `Server` is used on
 * purpose: tool schemas come from the Resuto API as JSON Schema at runtime, so
 * the high-level McpServer (which wants zod schemas compiled in) does not fit.
 */
export function createMcpServer(api: ResutoApi, who: WhoAmI, prefetched?: PrefetchedCalls): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions: [
      `You are connected to the Resuto restaurant operating system for "${who.orgName}" as "${who.name}" (acting role: ${who.actingRole}${who.branchIds ? `, limited to ${who.branchIds.length} branch(es)` : ''}).`,
      'Money amounts are integer minor units (piastres/halalas): 12500 EGP minor = 125.00 EGP.',
      'Dates are YYYY-MM-DD in the restaurant\'s timezone. Totals are computed by Resuto; never estimate them.',
      'Sensitive tools (sending campaigns, payment links, availability changes) only create an approval request for a human; tell the user it awaits approval and use get_approval_status.',
      'Customer contact details may be masked depending on the connection\'s role.',
    ].join(' '),
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const { items } = await api.listTools(who.orgId);
      return { tools: items.map(toMcpTool) };
    } catch (e) {
      if (e instanceof ApiError) throw new McpError(e.status === 401 ? ErrorCode.InvalidRequest : ErrorCode.InternalError, `${e.code}: ${e.message}`);
      throw e;
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const done = prefetched?.get(extra.requestId);
    if (done !== undefined) {
      prefetched!.delete(extra.requestId);
      return toCallToolResult(done);
    }
    try {
      return toCallToolResult(await api.callTool(who.orgId, req.params.name, req.params.arguments ?? {}));
    } catch (e) {
      if (e instanceof ApiError) return toCallToolResult(e);
      throw e;
    }
  });

  return server;
}
