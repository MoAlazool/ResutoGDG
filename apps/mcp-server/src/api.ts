// Thin client for the Resuto API. The MCP server has no database access and no
// credentials of its own: it forwards the caller's rmcp_ key on every request.

/** Mirrors `McpWhoAmI` in @resuto/contracts (kept local so this package deploys on its own). */
export interface WhoAmI {
  clientId: string;
  name: string;
  orgId: string;
  orgName: string;
  actingRole: string;
  branchIds: string[] | null;
  allowedTools: string[];
  rateLimitPerMin: number;
}

/** Mirrors `McpToolDescriptor` in @resuto/contracts. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; [k: string]: unknown };
  outputSchema: { type: 'object'; [k: string]: unknown };
  annotations: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  sensitive: boolean;
}

export interface ToolCallResponse {
  status: 'ok' | 'approval_required';
  tool: string;
  output: Record<string, unknown>;
  replayed: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export class ResutoApi {
  constructor(private readonly baseUrl: string, private readonly key: string, private readonly timeoutMs = 30_000) {}

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'resuto-mcp-server/0.1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      throw new ApiError(502, 'api_unreachable', `Resuto API is unreachable (${(e as Error).name})`);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError(502, 'api_bad_response', 'Resuto API returned a non-JSON response');
    }
    if (!res.ok) {
      const err = data?.error ?? {};
      throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? res.statusText, err.details);
    }
    return data as T;
  }

  whoami() {
    return this.request<WhoAmI>('GET', '/mcp/whoami');
  }

  listTools(orgId: string) {
    return this.request<{ items: ToolDescriptor[] }>('GET', `/o/${encodeURIComponent(orgId)}/mcp/tools`);
  }

  callTool(orgId: string, tool: string, input: unknown) {
    return this.request<ToolCallResponse>('POST', `/o/${encodeURIComponent(orgId)}/mcp/tools/${encodeURIComponent(tool)}`, { input: input ?? {} });
  }

  health() {
    return this.request<{ status: string }>('GET', '/health');
  }
}
