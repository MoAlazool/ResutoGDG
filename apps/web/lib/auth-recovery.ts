import { ApiRequestError } from './api';

export interface AuthRecoveryDeps {
  /** The current access token (it may change while a request is in flight). */
  getToken(): string | null;
  /** One refresh attempt (Supabase refresh token); resolves to the new access token or null. */
  refresh(): Promise<string | null>;
  /** The session cannot be recovered: clear it and send the user to sign in. */
  expire(): void;
}

/**
 * Global 401 handling for authenticated requests. When a request is rejected with 401:
 * - if another request already obtained a newer token meanwhile, retry once with it;
 * - otherwise refresh once (concurrent 401s share the same refresh) and retry once with the new token;
 * - if there is no new token, or the retry is rejected again, expire the session (sign-in with ?next=).
 * Other errors pass through unchanged. Requests made without a token are never retried.
 */
export function createAuthRunner(deps: AuthRecoveryDeps) {
  let refreshing: Promise<string | null> | null = null;
  const refreshOnce = () => {
    if (!refreshing) {
      refreshing = deps.refresh().catch(() => null).finally(() => { setTimeout(() => { refreshing = null; }, 0); });
    }
    return refreshing;
  };
  const is401 = (e: unknown) => e instanceof ApiRequestError && e.status === 401;

  return async function withAuth<T>(run: (token: string | null) => Promise<T>): Promise<T> {
    const sentWith = deps.getToken();
    try {
      return await run(sentWith);
    } catch (e) {
      if (!is401(e) || !sentWith) throw e;
      const current = deps.getToken();
      const fresh = current && current !== sentWith ? current : await refreshOnce();
      if (!fresh) { deps.expire(); throw e; }
      try {
        return await run(fresh);
      } catch (e2) {
        if (is401(e2)) deps.expire();
        throw e2;
      }
    }
  };
}
