import { describe, expect, it } from 'vitest';
import { ErrorReporter, parseDsn, routeLabel, scrub } from '../src/error-tracking.js';

// CR-14: error tracking for the MCP server (same envelope format and PII rules as the API).
describe('MCP error tracking (CR-14)', () => {
  it('is off without a DSN and posts one scrubbed envelope per distinct error when configured', async () => {
    expect(await new ErrorReporter(undefined, { service: 'mcp', environment: 'test' }).capture(new Error('x'))).toBe('skipped');
    const sent: Array<{ url: string; body: string }> = [];
    const fake = async (url: string, init: RequestInit) => { sent.push({ url, body: String(init.body) }); return new Response('{}'); };
    const r = new ErrorReporter('https://pub@errors.example.test/4', { service: 'mcp', environment: 'staging', release: 'abc1234' }, fake);
    expect(await r.capture(new Error('tool failed for rmcp_abcdefghijklmnop and a@b.co'), { route: routeLabel('/mcp/rmcp_abcdefghijklmnopqrst'), source: 'mcp' })).toBe('sent');
    expect(await r.capture(new Error('tool failed for rmcp_abcdefghijklmnop and a@b.co'), { route: '/mcp' })).toBe('skipped');
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://errors.example.test/api/4/envelope/');
    const event = JSON.parse(sent[0].body.split('\n')[2]);
    expect(event.tags).toEqual(expect.objectContaining({ service: 'mcp', route: '/mcp' }));
    expect(event.release).toBe('abc1234');
    expect(sent[0].body).not.toMatch(/rmcp_abc|a@b\.co/);
  });

  it('never sends the secret-URL path and refuses malformed DSNs', () => {
    expect(routeLabel('/mcp/rmcp_secretsecretsecret12')).toBe('/mcp');
    expect(routeLabel(undefined)).toBe('/');
    expect(parseDsn('not a url')).toBeNull();
    expect(parseDsn('https://errors.example.test/4')).toBeNull();
    expect(scrub('Bearer abc.def')).toBe('Bearer [redacted]');
  });
});
