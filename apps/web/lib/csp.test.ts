import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';

// Audit PS-17 review: script-src allowed 'unsafe-inline' on every page, so any injected script could run and read the
// localStorage session token. Pages now get a per-request nonce policy without 'unsafe-inline' for scripts.

const directive = (csp: string, name: string) => csp.split('; ').find((d) => d === name || d.startsWith(`${name} `));
const opts = { apiUrl: 'https://api.resuto.app/v1', supabaseUrl: 'https://ref.supabase.co' };

describe('page policy (with nonce)', () => {
  const csp = buildCsp({ ...opts, nonce: 'abc123+/=', dev: false });
  it('runs only nonce-carrying scripts (and what they load), never inline script or handlers', () => {
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'nonce-abc123+/=' 'strict-dynamic'");
    expect(directive(csp, 'script-src')).not.toContain('unsafe-inline');
    expect(directive(csp, 'script-src')).not.toContain('unsafe-eval');
    expect(directive(csp, 'script-src-attr')).toBe("script-src-attr 'none'");
  });
  it('keeps connections, framing, plugins, base and forms locked down', () => {
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self' https://api.resuto.app https://ref.supabase.co wss://ref.supabase.co");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
    expect(csp).toContain('upgrade-insecure-requests');
  });
  it('Next.js finds the nonce in the header the middleware sets', () => {
    // same parsing as next/dist/server/app-render/get-script-nonce-from-header
    const src = directive(csp, 'script-src')!.split(/\s+/).slice(1).map((s) => s.match(/^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/)?.[1]).find(Boolean);
    expect(src).toBe('abc123+/=');
  });
  it('development adds eval (React refresh) and websockets (HMR) only there', () => {
    const dev = buildCsp({ ...opts, nonce: 'n', dev: true });
    expect(directive(dev, 'script-src')).toBe("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(directive(dev, 'connect-src')).toContain('ws: wss:');
  });
});

describe('fallback policy (static responses, no nonce)', () => {
  it('is compatible with the page policy and still blocks framing and plugins', () => {
    const csp = buildCsp({ ...opts, nonce: null, dev: false });
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
  });
});

describe('newNonce', () => {
  it('is 128 random bits, base64, different every time', () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(new Set(Array.from({ length: 50 }, newNonce)).size).toBe(50);
  });
});
