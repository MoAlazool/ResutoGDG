'use client';
import { useT } from '@/lib/i18n/client';

export default function SiteError({ reset }: { error: Error; reset: () => void }) {
  const { t } = useT();
  return (
    <main className="center-page">
      <div className="auth-card" style={{ textAlign: 'center' }} role="alert">
        <h1 style={{ fontSize: 24 }}>{t('studio.site.errorTitle')}</h1>
        <p className="muted">{t('studio.site.errorBody')}</p>
        <button className="btn btn-primary" onClick={reset}>{t('action.retry')}</button>
      </div>
    </main>
  );
}
