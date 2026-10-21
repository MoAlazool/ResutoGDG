// Test-only: the minimal browser surface the SessionProvider needs, so it can be rendered with react-dom in the node
// test environment (the web workspace has no DOM test environment; see lib/session-stability.test.ts).
import * as React from 'react';

const noop = () => undefined;

export function installFakeDom(path = '/login') {
  const store = new Map<string, string>();
  const session = new Map<string, string>();
  const fakeDocument = {
    visibilityState: 'visible', activeElement: null, querySelector: () => null, addEventListener: noop, removeEventListener: noop,
  };
  const container = {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', localName: 'div', namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: fakeDocument, addEventListener: noop, removeEventListener: noop,
  };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    React,
    document: fakeDocument,
    window: { HTMLIFrameElement: class {}, addEventListener: noop, removeEventListener: noop, location: { pathname: path, search: '', origin: 'http://app.test', href: `http://app.test${path}` } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); }, key: () => null, length: 0 },
    sessionStorage: { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); }, removeItem: (k: string) => { session.delete(k); } },
  });
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
  return { container, store, session };
}

/** An unsigned JWT-shaped token (the web only decodes claims; the API verifies signatures). */
export const fakeJwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
