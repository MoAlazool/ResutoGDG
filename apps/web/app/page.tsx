import Link from 'next/link';
import { getT } from '@/lib/i18n/server';

// Temporary entry page; Agent F ports the legacy landing page here.
export default async function Home() {
  const { t } = await getT();
  return (
    <main className="center-page">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <img src="/brand/resuto-icon.png" alt="" width={56} height={56} style={{ borderRadius: 14 }} />
        <h1>{t('app.name')}</h1>
        <p className="muted">{t('app.tagline')}</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn btn-primary" href="/signup">{t('auth.signUp')}</Link>
          <Link className="btn" href="/login">{t('auth.signIn')}</Link>
        </div>
      </div>
    </main>
  );
}
