import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import { createAuthRunner } from './auth-recovery';

const unauthorized = () => new ApiRequestError(401, 'unauthorized', 'Session expired');

function setup(opts: { refreshTo?: string | null } = {}) {
  let token: string | null = 'old';
  const refresh = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); token = opts.refreshTo === undefined ? 'new' : opts.refreshTo; return token; });
  const expire = vi.fn(() => { token = null; });
  const withAuth = createAuthRunner({ getToken: () => token, refresh, expire });
  return { withAuth, refresh, expire, setToken: (t: string | null) => { token = t; } };
}

describe('createAuthRunner (global 401 recovery)', () => {
  it('refreshes once and retries with the new token', async () => {
    const { withAuth, refresh, expire } = setup();
    const seen: Array<string | null> = [];
    const result = await withAuth(async (t) => { seen.push(t); if (t === 'old') throw unauthorized(); return 'ok'; });
    expect(result).toBe('ok');
    expect(seen).toEqual(['old', 'new']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(expire).not.toHaveBeenCalled();
  });

  it('shares one refresh between concurrent 401s', async () => {
    const { withAuth, refresh } = setup();
    const run = (t: string | null) => (t === 'old' ? Promise.reject(unauthorized()) : Promise.resolve(t));
    const out = await Promise.all([withAuth(run), withAuth(run), withAuth(run)]);
    expect(out).toEqual(['new', 'new', 'new']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('expires the session (sign in again) when no refresh is possible', async () => {
    const { withAuth, expire } = setup({ refreshTo: null });
    await expect(withAuth(async () => { throw unauthorized(); })).rejects.toMatchObject({ status: 401 });
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('expires when the retried request is rejected again', async () => {
    const { withAuth, expire } = setup();
    await expect(withAuth(async () => { throw unauthorized(); })).rejects.toMatchObject({ status: 401 });
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it('uses a token another request already refreshed instead of refreshing again', async () => {
    const { withAuth, refresh, setToken } = setup();
    const result = await withAuth(async (t) => { if (t === 'old') { setToken('rotated'); throw unauthorized(); } return t; });
    expect(result).toBe('rotated');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('passes other errors through and never retries anonymous requests', async () => {
    const { withAuth, refresh, setToken } = setup();
    await expect(withAuth(async () => { throw new ApiRequestError(403, 'forbidden', 'No access'); })).rejects.toMatchObject({ status: 403 });
    setToken(null);
    await expect(withAuth(async () => { throw unauthorized(); })).rejects.toMatchObject({ status: 401 });
    expect(refresh).not.toHaveBeenCalled();
  });
});
