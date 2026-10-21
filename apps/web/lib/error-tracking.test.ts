import { afterEach, describe, expect, it } from 'vitest';
import { configureWebErrorReporter, ErrorReporter } from './error-tracking';
import { onRequestError } from '../instrumentation';

// CR-14: server-side errors of the web app reach the optional error tracker with the route PATTERN only.
describe('web error tracking (CR-14)', () => {
  afterEach(() => configureWebErrorReporter(null));

  it('reports a server render error with the route pattern, never the requested path or its tokens', async () => {
    const sent: string[] = [];
    configureWebErrorReporter(new ErrorReporter('https://pub@errors.example.test/5', { service: 'web', environment: 'preview', release: 'deadbeef1' },
      async (_url, init) => { sent.push(String(init.body)); return new Response('{}'); }));
    const token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
    await onRequestError(new Error(`table lookup failed for ${token}`),
      { path: `/t/${token}?lang=ar`, method: 'GET', headers: { 'x-request-id': 'req-12345678' } },
      { routerKind: 'App Router', routePath: '/t/[qr]', routeType: 'render', renderSource: 'react-server-components', revalidateReason: undefined });
    expect(sent).toHaveLength(1);
    const event = JSON.parse(sent[0].split('\n')[2]);
    expect(event.tags).toEqual(expect.objectContaining({ service: 'web', route: '/t/[qr]', request_id: 'req-12345678', source: 'web:App Router:render' }));
    expect(event.release).toBe('deadbeef1');
    expect(sent[0]).not.toContain(token);
  });

  it('does nothing without ERROR_TRACKING_DSN', async () => {
    configureWebErrorReporter(new ErrorReporter(undefined, { service: 'web', environment: 'test' }, async () => { throw new Error('must not be called'); }));
    await expect(onRequestError(new Error('x'), { path: '/', method: 'GET', headers: {} },
      { routerKind: 'App Router', routePath: '/', routeType: 'render', renderSource: 'react-server-components', revalidateReason: undefined })).resolves.toBeUndefined();
  });
});
