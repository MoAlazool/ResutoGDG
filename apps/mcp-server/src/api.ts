import { randomUUID } from 'node:crypto';
import { log } from './log.js';

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
  /** 'oauth' for access tokens, with the resource (audience) they were issued for. */
  auth?: 'key' | 'oauth';
  resource?: string | null;
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
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown, readonly requestId?: string) {
    super(message);
  }
}

/**
 * One correlation id per API call (audit PS-15): the API echoes it, logs it in its access log and stores it on the
 * mcp_tool_calls row and audit entries, so an MCP server log line can be matched with what the API did.
 */
export const newRequestId = () => `mcp-${randomUUID()}`;

export class ResutoApi {
  /**
   * `resource`: for OAuth access tokens, the MCP resource URI this server serves; sent as X-Mcp-Resource so the API
   * accepts the token only for that audience. The token's own audience is checked again by the API on every call.
   */
  constructor(private readonly baseUrl: string, private key: string, private readonly timeoutMs = 30_000, private readonly resource: string | null = null) {}

  /** A refreshed OAuth access token for the same grant replaces the old one on an open session. */
  setKey(key: string) {
    this.key = key;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, label = path): Promise<T> {
    const requestId = newRequestId();
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          'User-Agent': 'resuto-mcp-server/0.1',
          'X-Request-Id': requestId,
          ...(this.resource && this.key.startsWith('rmat_') ? { 'X-Mcp-Resource': this.resource } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      log('warn', 'api call failed', { requestId, call: label, error: (e as Error).name, ms: Date.now() - started });
      throw new ApiError(502, 'api_unreachable', `Resuto API is unreachable (${(e as Error).name})`, undefined, requestId);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      log('warn', 'api call failed', { requestId, call: label, status: res.status, error: 'non_json', ms: Date.now() - started });
      throw new ApiError(502, 'api_bad_response', 'Resuto API returned a non-JSON response', undefined, requestId);
    }
    const ms = Date.now() - started;
    if (!res.ok) {
      const err = data?.error ?? {};
      log('info', 'api call', { requestId, call: label, status: res.status, code: err.code ?? null, ms });
      throw new ApiError(res.status, err.code ?? 'http_error', err.message ?? res.statusText, err.details, requestId);
    }
    log('info', 'api call', { requestId, call: label, status: res.status, ms });
    return data as T;
  }

  whoami() {
    return this.request<WhoAmI>('GET', '/mcp/whoami', undefined, 'whoami');
  }

  listTools(orgId: string) {
    return this.request<{ items: ToolDescriptor[] }>('GET', `/o/${encodeURIComponent(orgId)}/mcp/tools`, undefined, 'tools/list');
  }

  callTool(orgId: string, tool: string, input: unknown) {
    return this.request<ToolCallResponse>('POST', `/o/${encodeURIComponent(orgId)}/mcp/tools/${encodeURIComponent(tool)}`, { input: input ?? {} },
      `tools/call:${tool.slice(0, 80)}`);
  }

  /** Authorization-server calls (no credential of the caller is involved; the API answers in OAuth's error format). */
  static async oauth(baseUrl: string, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: any }> {
    const requestId = newRequestId();
    try {
      const res = await fetch(`${baseUrl}/v1/mcp/oauth/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Request-Id': requestId, 'User-Agent': 'resuto-mcp-server/0.1' },
        body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
      });
      const text = await res.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
      log('info', 'api call', { requestId, call: `oauth/${path}`, status: res.status });
      if (json === null) return { status: 502, body: { error: 'server_error', error_description: 'Resuto API returned a non-JSON response' } };
      // Resuto domain errors ({error:{code,message}}) are mapped onto OAuth's flat format.
      if (json && typeof json.error === 'object' && json.error) {
        return { status: res.status, body: { error: res.status >= 500 ? 'server_error' : res.status === 429 ? 'slow_down' : 'invalid_request', error_description: String(json.error.message ?? '') } };
      }
      return { status: res.status, body: json };
    } catch (e) {
      log('warn', 'api call failed', { requestId, call: `oauth/${path}`, error: (e as Error).name });
      return { status: 502, body: { error: 'temporarily_unavailable', error_description: 'Resuto API is unreachable' } };
    }
  }

  health() {
    return this.request<{ status: string }>('GET', '/health', undefined, 'health');
  }
}
