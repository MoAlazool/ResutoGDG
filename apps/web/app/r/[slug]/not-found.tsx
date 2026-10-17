import Link from 'next/link';
import { getT } from '@/lib/i18n/server';

export default async function SiteNotFound() {
  const { t } = await getT();
  return (
    <main className="center-page">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <p className="overline">404</p>
        <h1 style={{ fontSize: 26 }}>{t('studio.site.notFoundTitle')}</h1>
        <p className="muted">{t('studio.site.notFoundBody')}</p>
        <Link className="btn btn-primary" href="/">{t('studio.site.poweredBy')}</Link>
      </div>
    </main>
  );
}
