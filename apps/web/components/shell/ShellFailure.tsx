'use client';
import Link from 'next/link';
import { ErrorState } from '@resuto/ui';
import type { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';

/**
 * First load of the restaurant failed: say why and what to do (no endless spinner, no raw error text). Its own chunk:
 * a rare path, so the shell's first load does not carry the shared error-state copy.
 */
export default function ShellFailure({ error, onRetry }: { error: ApiRequestError; onRetry(): Promise<void> }) {
  const { t, locale } = useT();
  if (error.kind === 'forbidden' || error.kind === 'not_found') {
    const k = error.kind === 'forbidden' ? 'forbidden' : 'notFound';
    return (
      <div className="err-inline" role="alert" data-kind={k}>
        <h2>{t(`shell.fail.${k}.title`)}</h2>
        <p>{t(`shell.fail.${k}.body`)}</p>
        <div className="err-actions"><Link className="btn btn-primary" href="/dashboard">{t('shell.fail.myRestaurants')}</Link></div>
      </div>
    );
  }
  return <div className="err-inline"><ErrorState error={error} onRetry={onRetry} locale={locale} /></div>;
}
