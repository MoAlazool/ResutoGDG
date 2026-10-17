import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { createHttpApp } from '../src/http.js';
import { toCallToolResult, toMcpTool } from '../src/mcp.js';

describe('Resuto → MCP result mapping', () => {
  it('maps ok results to structured content', () => {
    const r = toCallToolResult({ status: 'ok', tool: 'list_orders', output: { items: [], nextCursor: null }, replayed: false });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ items: [], nextCursor: null });
    expect(r.content[0]).toMatchObject({ type: 'text', text: '{"items":[],"nextCursor":null}' });
  });

  it('maps approval_required to a non-error result that explains the next step', () => {
    const output = { status: 'approval_required', approvalId: 'a1', summary: 'Mark "Fries" unavailable', expiresAt: '2026-10-18T00:00:00.000Z', message: 'A team member must approve this.' };
    const r = toCallToolResult({ status: 'approval_required', tool: 'update_product_availability', output, replayed: false });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual(output);
    expect((r.content[0] as any).text).toContain('A team member must approve this.');
  });

  it.each([
    [403, 'forbidden'], [403, 'tool_not_allowed'], [429, 'rate_limited'], [400, 'invalid_input'], [503, 'module_unavailable'], [401, 'unauthorized'],
  ])('maps HTTP %i %s to isError', (status, code) => {
    const r = toCallToolResult(new ApiError(status, code, 'nope', code === 'invalid_input' ? [{ path: 'limit', message: 'too big' }] : undefined));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect((r.content[0] as any).text).toContain(`${code}: nope`);
    if (code === 'invalid_input') expect((r.content[0] as any).text).toContain('"path":"limit"');
  });

  it('keeps annotations and schemas from the API descriptor', () => {
    const tool = toMcpTool({
      name: 'create_payment_link', title: 'Create payment link', description: 'd', sensitive: true,
      inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    });
    expect(tool).toMatchObject({ name: 'create_payment_link', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, readOnlyHint: false } });
  });
});

describe('configuration', () => {
  it('binds to loopback and validates Host by default', () => {
    const c = loadConfig({ MCP_PORT: '7108' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.allowedHosts).toEqual(['127.0.0.1:7108', 'localhost:7108', '[::1]:7108']);
    expect(c.allowedOrigins).toEqual([]);
    expect(c.allowUrlKey).toBe(false);
  });

  it('serves only /mcp and /health; the secret-URL form is off by default', async () => {
    const app = createHttpApp(loadConfig({ MCP_PORT: '7199' }));
    await app.listen();
    try {
      const base = 'http://127.0.0.1:7199';
      expect((await fetch(`${base}/mcp/rmcp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await fetch(`${base}/other`)).status).toBe(404);
      const unauth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
      expect(unauth.status).toBe(401);
      expect(await unauth.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32001 } });
      expect((await fetch(`${base}/mcp`, { method: 'PUT', headers: { Authorization: 'Bearer rmcp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status).toBe(405);
      const big = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: 'Bearer rmcp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, body: 'x'.repeat(300 * 1024) });
      expect(big.status).toBe(413);
      expect((await fetch(`${base}/health`)).headers.get('x-content-type-options')).toBe('nosniff');
    } finally {
      await app.close();
    }
  });

  it('uses the public URL host when deployed', () => {
    const c = loadConfig({ MCP_HOST: '0.0.0.0', MCP_PUBLIC_URL: 'https://mcp.resuto.app', MCP_ALLOWED_ORIGINS: 'https://claude.ai, https://chatgpt.com' });
    expect(c.allowedHosts).toEqual(['mcp.resuto.app']);
    expect(c.allowedOrigins).toEqual(['https://claude.ai', 'https://chatgpt.com']);
  });
});
