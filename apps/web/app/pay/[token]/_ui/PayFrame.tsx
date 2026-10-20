'use client';
import type { ReactNode } from 'react';
import { Badge } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import './receipt.css';
import { isSafeRedirect } from './redirect';

export { isSafeRedirect, PROVIDER_CHECKOUT_HOSTS } from './redirect';

/** Shared frame for guest payment pages (hosted checkout, bill share, table bill). */
export function PayFrame({ merchant, sandbox, children }: { merchant?: string | null; sandbox?: boolean; children: ReactNode }) {
  const { t } = useT();
  return (
    <main className="pay-page">
      <div className="pay-head">
        <strong>{merchant ?? t('app.name')}</strong>
        <div className="row" style={{ gap: 8 }}>
          {sandbox && <Badge tone="sandbox">{t('pay.sandboxBadge')}</Badge>}
          <LanguageToggle />
        </div>
      </div>
      {sandbox && <div style={{ width: '100%', maxWidth: 440, marginBottom: 12 }}><div className="notice notice-warn">{t('pay.sandboxNotice')}</div></div>}
      {children}
    </main>
  );
}

export const methodIcon: Record<string, string> = { card: '💳', wallet: '📱', cash: '💵', cod: '🛵', instapay: '⚡', bank_transfer: '🏦' };

/** Keeps one intent's idempotency key across retries of that intent. */
export function intentKey(scope: string): string {
  const k = `resuto.intent.${scope}`;
  try {
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const v = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}
export function clearIntent(scope: string) {
  try { sessionStorage.removeItem(`resuto.intent.${scope}`); } catch { /* ignore */ }
}

/** Only follow redirects to a supported provider's checkout page or back into this app. */
export function safeRedirect(url: string) {
  if (isSafeRedirect(url, window.location.href)) window.location.assign(new URL(url, window.location.href).toString());
}
