'use client';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Notice, Wordmark } from '@resuto/ui';
import { NavSkeleton } from '@/components/shell/Skeletons';
import { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { takeOAuth } from '../binding';

interface CompleteResult { connection: { id: string; status: string }; needsAccountSelection: boolean; redirectAfter: string | null }

/**
 * Where the provider's callback forwards the person (PS-11): the flow is completed here, with the signed-in session
 * and the nonce this browser kept when it started. The code is removed from the address bar immediately.
 */
function OAuthReturn() {
  const { provider } = useParams<{ provider: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { t } = useT();
  const { ready, token, call } = useSession();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (!ready || !token || once.current) return;
    once.current = true;
    const code = search.get('code');
    const state = search.get('state');
    const failure = search.get('integration_error');
    try { window.history.replaceState(null, '', window.location.pathname); } catch { /* ignore */ }
    const pending = takeOAuth(provider);
    if (failure || !code || !state) { setError(t(`intg.oauth.error.${failure ?? 'missing_code'}`)); return; }
    if (!pending) { setError(t('intg.oauth.error.other_browser')); return; }
    call<CompleteResult>(`/o/${pending.orgId}/integrations/oauth/${encodeURIComponent(provider)}/complete`, { body: { code, state, browserNonce: pending.nonce } })
      .then((r) => {
        const target = new URL(r.redirectAfter ?? pending.redirectAfter, window.location.origin);
        target.searchParams.set('connected', provider);
        if (r.needsAccountSelection) target.searchParams.set('choose', r.connection.id);
        router.replace(`${target.pathname}${target.search}`);
      })
      .catch((e: unknown) => setError(e instanceof ApiRequestError && e.code === 'oauth_state_invalid' ? t('intg.oauth.error.other_browser') : (e as Error).message));
  }, [ready, token, provider, search, call, router, t]);

  return (
    <main className="ws-solo" aria-busy={!error}>
      <div className="ws-solo-card" style={{ display: 'grid', gap: 16 }}>
        <Wordmark label={t('app.name')} />
        {error ? (
          <>
            <Notice tone="danger">{error}</Notice>
            <button className="btn btn-primary" onClick={() => router.replace('/dashboard')}>{t('intg.oauth.back')}</button>
          </>
        ) : (
          <>
            <p className="m-0">{t('intg.oauth.finishing')}</p>
            <NavSkeleton count={2} />
          </>
        )}
      </div>
    </main>
  );
}

/** useSearchParams needs a Suspense boundary for static rendering. */
export default function OAuthReturnPage() {
  return <Suspense fallback={null}><OAuthReturn /></Suspense>;
}
