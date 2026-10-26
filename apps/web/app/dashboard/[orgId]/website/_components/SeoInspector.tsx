'use client';
import { useT } from '@/lib/i18n/client';
import type { Studio } from './types';

/**
 * The site inspector's SEO tab (22-STUDIO): search, answer-engine and AI-engine settings and checks moved to the Optimize
 * workspace, which has the room for both languages side by side, the structured data and the checks. This tab shows
 * what the page currently says in search and opens Optimize.
 */
export function SeoInspector({ studio }: { studio: Studio }) {
  const { t } = useT();
  const seo = studio.state.website.seo;
  return (
    <div className="stack gap-12">
      <p className="fine m-0">{t('studio.opt.intro')}</p>
      <dl className="ws-opt-dl">
        {(['en', 'ar'] as const).map((l) => (
          <div key={l} lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'}>
            <dt>{t('studio.seo.pageTitle')} · {t(`studio.lang.${l}`)}</dt>
            <dd>{seo.title?.[l]?.trim() || '—'}</dd>
            <dt>{t('studio.seo.description')} · {t(`studio.lang.${l}`)}</dt>
            <dd>{seo.description?.[l]?.trim() || '—'}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="btn btn-primary" onClick={() => studio.openOptimize()}>{t('studio.opt.optimize')}</button>
    </div>
  );
}
