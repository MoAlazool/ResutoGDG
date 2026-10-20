'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Wordmark } from '@resuto/ui';

// Branded, localised error states for the route error boundaries (app/error.tsx, app/global-error.tsx and the area
// error.tsx files). The copy lives here, not in the dictionaries, because global-error renders without the root
// layout (no LocaleProvider): the language is read from the document or the locale cookie instead.

type Lang = 'en' | 'ar';
const COPY = {
  en: {
    title: 'Something went wrong', body: 'This screen hit an unexpected problem. Your data is safe. Try again, or go back to the start.',
    chunkTitle: 'A new version of Resuto is available', chunkBody: 'This page was updated while it was open. Reload to continue with the latest version.',
    retry: 'Try again', reload: 'Reload', home: 'Back to the start', reference: 'Reference',
  },
  ar: {
    title: 'حدث خطأ غير متوقع', body: 'واجهت هذه الشاشة مشكلة غير متوقعة. بياناتك آمنة. حاول مرة أخرى، أو عُد إلى البداية.',
    chunkTitle: 'يتوفر إصدار أحدث من ريسوتو', chunkBody: 'تم تحديث هذه الصفحة أثناء فتحها. أعد التحميل للمتابعة بأحدث إصدار.',
    retry: 'حاول مرة أخرى', reload: 'إعادة التحميل', home: 'العودة إلى البداية', reference: 'المرجع',
  },
} as const;

export function documentLang(): Lang {
  if (typeof document === 'undefined') return 'en';
  if (document.documentElement.lang === 'ar') return 'ar';
  return /(?:^|;\s*)resuto_locale=ar(?:;|$)/.test(document.cookie) ? 'ar' : 'en';
}

/** A failed JavaScript chunk (a deploy replaced the build while the page was open, or the CDN returned an error). */
export function isChunkLoadError(error: unknown): boolean {
  const e = error as { name?: string; message?: string } | null;
  if (!e) return false;
  return e.name === 'ChunkLoadError'
    || /Loading (CSS )?chunk [\w/-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(e.message ?? '');
}

const RELOAD_KEY = 'resuto.chunk-reload-at';
/**
 * Reloads the page once for a chunk load failure. Returns false (show the error instead) when it already reloaded
 * in the last minute, so a broken deploy cannot cause a reload loop.
 */
export function reloadOnceForChunkError(now = Date.now(), store: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(), reload = () => window.location.reload()): boolean {
  try {
    const last = Number(store?.getItem(RELOAD_KEY) ?? 0);
    if (last && now - last < 60_000) return false;
    store?.setItem(RELOAD_KEY, String(now));
  } catch { /* storage blocked: still reload once */ }
  reload();
  return true;
}
function safeSession() { try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; } }

const referenceOf = (error: Error & { digest?: string; requestId?: string }) => error.requestId ?? error.digest ?? null;

/**
 * Error state for a route segment. `page` fills the viewport (root and global errors, areas without chrome);
 * `inline` sits inside the staff shell so navigation stays available.
 */
export function ErrorView({ error, reset, variant = 'page', homeHref = '/' }: {
  error: Error & { digest?: string; requestId?: string }; reset?: () => void; variant?: 'page' | 'inline'; homeHref?: string;
}) {
  const [lang, setLang] = useState<Lang>('en');
  const [reloading, setReloading] = useState(false);
  const chunk = isChunkLoadError(error);
  useEffect(() => {
    setLang(documentLang());
    if (chunk && reloadOnceForChunkError()) setReloading(true);
  }, [chunk]);
  const s = COPY[lang];
  const ref = referenceOf(error);
  const content = (
    <>
      <h1>{chunk ? s.chunkTitle : s.title}</h1>
      <p>{chunk ? s.chunkBody : s.body}</p>
      {ref && !chunk && <span className="err-ref">{s.reference}: <bdi dir="ltr">{ref}</bdi></span>}
      <div className="err-actions">
        {chunk || !reset
          ? <button type="button" className="btn btn-primary" disabled={reloading} onClick={() => window.location.reload()}>{s.reload}</button>
          : <button type="button" className="btn btn-primary" onClick={() => reset()}>{s.retry}</button>}
        <Link className="btn" href={homeHref}>{s.home}</Link>
      </div>
    </>
  );
  if (variant === 'inline') return <div className="err-inline" role="alert" data-chunk={chunk || undefined}>{content}</div>;
  return (
    <main className="err-page" role="alert" data-chunk={chunk || undefined}>
      <div className="err-page-inner">
        <Wordmark label="Resuto" />
        {content}
      </div>
    </main>
  );
}
