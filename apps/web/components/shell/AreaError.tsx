'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorState } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import type { AreaKey } from '@/lib/nav';
import { isChunkLoadError, reloadOnceForChunkError } from './ErrorView';

/**
 * Error state of an area's routes (21-SHELL, the area error.tsx files): a screen that failed to render shows the
 * shared ErrorState with Try again (re-renders the screen) and a way home, inside the shell, so the navigation stays
 * usable. A failed JavaScript chunk (a new deploy) reloads the page once instead.
 */
export function AreaError({ error, reset, area, homeHref }: {
  error: Error & { digest?: string }; reset: () => void;
  /** The area (a staff area, or the operator console). */
  area: AreaKey | 'admin';
  /** Where "Back to home" goes; defaults to the restaurant's overview (the operator console passes /admin). */
  homeHref?: string;
}) {
  const { t, locale } = useT();
  const params = useParams<{ orgId: string }>();
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);
  useEffect(() => { if (chunk && reloadOnceForChunkError()) setReloading(true); }, [chunk]);
  const home = homeHref ?? (params?.orgId ? `/dashboard/${params.orgId}` : '/dashboard');
  return (
    <div className="err-inline area-error" role="alert" data-area={area} data-chunk={chunk || undefined}>
      <ErrorState locale={locale} onRetry={chunk ? () => window.location.reload() : reset}
        error={{ status: 500, message: error.message, requestId: error.digest }} />
      <div className="err-actions">
        {chunk && <button type="button" className="btn btn-primary" disabled={reloading} onClick={() => window.location.reload()}>{t('action.retry')}</button>}
        <Link className="btn" href={home}>{t('shell.area.error.home')}</Link>
      </div>
    </div>
  );
}
