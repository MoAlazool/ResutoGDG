import type { Metadata } from 'next';
import Link from 'next/link';
import { Wordmark } from '@resuto/ui';
import { getT } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t('err.notFound.title'), robots: { index: false, follow: false } };
}

/**
 * Branded, localised 404 (HTTP 404) for unknown URLs, unknown restaurants and unknown guest links (CR-03), instead
 * of Next's default English "This page could not be found." in an Arabic page.
 */
export default async function NotFound() {
  const { t } = await getT();
  return (
    <main className="err-page">
      <div className="err-page-inner">
        <Link href="/" aria-label={t('app.name')} style={{ textDecoration: 'none' }}><Wordmark label={t('app.name')} /></Link>
        <div className="err-code" aria-hidden="true">404</div>
        <h1>{t('err.notFound.title')}</h1>
        <p>{t('err.notFound.body')}</p>
        <div className="err-actions">
          <Link className="btn btn-primary" href="/">{t('err.notFound.home')}</Link>
          <Link className="btn" href="/login">{t('err.notFound.staff')}</Link>
        </div>
      </div>
    </main>
  );
}
