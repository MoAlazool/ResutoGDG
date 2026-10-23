'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { can, type Role } from '@resuto/contracts';
import { EmptyState, Notice, Wordmark } from '@resuto/ui';
import { NavSkeleton } from '@/components/shell/Skeletons';
import { useT } from '@/lib/i18n/client';
import { loginUrl, useSession } from '@/lib/session';

/**
 * Where the Resuto MCP server sends an admin's browser for OAuth consent (FT-17). Picks the restaurant (only those
 * where the person may manage AI connections), then opens the consent screen inside that restaurant's workspace.
 */
function PickRestaurant() {
  const { t } = useT();
  const search = useSearchParams();
  const router = useRouter();
  const { ready, token, me, call } = useSession();
  const request = search.get('request') ?? '';
  const valid = /^[0-9a-f-]{36}$/i.test(request);
  const [denied, setDenied] = useState<string | null>(null);
  const eligible = (me?.memberships ?? []).filter((m) => can(m.role as Role, 'mcp:manage'));

  useEffect(() => {
    if (!ready) return;
    if (!token) { router.replace(loginUrl(`/dashboard/mcp-authorize?request=${encodeURIComponent(request)}`)); return; }
    if (valid && eligible.length === 1) router.replace(`/dashboard/${eligible[0]!.orgId}/mcp/authorize?request=${request}`);
  }, [ready, token, valid, eligible.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const deny = async () => {
    try {
      const r = await call<{ redirectTo: string }>(`/mcp/oauth/requests/${request}/deny`, { body: {} });
      window.location.assign(r.redirectTo);
    } catch (e) { setDenied((e as Error).message); }
  };

  return (
    <main className="ws-solo">
      <div className="ws-solo-card" style={{ display: 'grid', gap: 16, maxWidth: 520 }}>
        <Wordmark label={t('app.name')} />
        {!valid ? <Notice tone="danger">{t('mcp.oauth.badRequest')}</Notice>
          : !me ? <NavSkeleton count={3} />
            : eligible.length === 0 ? (
              <EmptyState title={t('mcp.oauth.noRestaurant')} action={<button type="button" className="btn" onClick={() => void deny()}>{t('mcp.oauth.deny')}</button>}>
                {t('mcp.oauth.noRestaurantBody')}
              </EmptyState>
            ) : (
              <>
                <h1 style={{ fontSize: 20, margin: 0 }}>{t('mcp.oauth.pickTitle')}</h1>
                <p className="fine m-0">{t('mcp.oauth.pickBody')}</p>
                <div className="stack gap-8">
                  {eligible.map((m) => (
                    <button key={m.orgId} type="button" className="btn" style={{ justifyContent: 'flex-start' }}
                      onClick={() => router.push(`/dashboard/${m.orgId}/mcp/authorize?request=${request}`)}><bdi>{m.orgName}</bdi></button>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost" onClick={() => void deny()}>{t('mcp.oauth.deny')}</button>
              </>
            )}
        {denied && <Notice tone="danger">{denied}</Notice>}
      </div>
    </main>
  );
}

export default function McpAuthorizePickPage() {
  return <Suspense fallback={null}><PickRestaurant /></Suspense>;
}
