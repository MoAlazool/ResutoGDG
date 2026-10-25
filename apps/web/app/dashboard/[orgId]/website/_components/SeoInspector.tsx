'use client';
import { useEffect, useMemo, useState } from 'react';
import type { WebsiteSeo } from '@resuto/contracts';
import { Badge, Notice } from '@resuto/ui';
import { siteJsonLd, validateJsonLd } from '@/app/r/[slug]/_components/structured-data';
import { useT } from '@/lib/i18n/client';
import { websiteEntry } from '@/lib/studio-history';
import { seoChecklist, type CheckGroup } from '@/lib/studio-seo';
import { LocalizedField, MediaField } from './EditorPanels';
import type { Studio } from './types';

const GROUPS: CheckGroup[] = ['search', 'local', 'answers'];

/**
 * SEO / AEO / GEO (21-STUDIO): the page title, description and sharing image in both languages, then three checklists
 * over the draft — search (hreflang, sitemap, valid structured data), local listing facts and AI answer readiness — and
 * the schema.org JSON-LD the published page will carry (Restaurant with Menu and Offers, FAQPage).
 */
export function SeoInspector({ studio }: { studio: Studio }) {
  const { t, locale } = useT();
  const w = studio.state.website;
  const [seo, setSeo] = useState<WebsiteSeo>(w.seo);
  useEffect(() => { setSeo(w.seo); }, [w.seo]);
  const dirty = JSON.stringify(seo) !== JSON.stringify(w.seo);
  useEffect(() => { studio.setDirty(dirty); return () => studio.setDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const site = studio.preview;
  const url = typeof window === 'undefined' ? studio.state.publicPath : `${window.location.origin}${studio.state.publicPath}`;
  const pageUrl = site?.canonicalHost ? `https://${site.canonicalHost}/` : url;
  const checks = useMemo(() => (site ? seoChecklist(site, pageUrl) : []), [site, pageUrl]);
  const ld = useMemo(() => (site ? siteJsonLd(site, pageUrl, locale) : []), [site, pageUrl, locale]);
  const problems = ld.flatMap((d) => validateJsonLd(d));
  return (
    <div className="stack gap-12">
      <fieldset className="ws-fieldset stack gap-8" disabled={!studio.canWrite}>
        <p className="fine m-0">{t('studio.seo.hint')}</p>
        <LocalizedField label={t('studio.seo.pageTitle')} value={seo.title} max={70} onChange={(v) => setSeo({ ...seo, title: v })} hint={t('studio.seo.titleHint')} />
        <LocalizedField label={t('studio.seo.description')} value={seo.description} max={170} multiline onChange={(v) => setSeo({ ...seo, description: v })} hint={t('studio.seo.descriptionHint')} />
        <MediaField orgId={studio.orgId} label={t('studio.seo.ogImage')} id={seo.ogMediaId} media={studio.state.media} onChange={(id) => setSeo({ ...seo, ogMediaId: id })} />
        {studio.canWrite && <div className="row gap-6">
          <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void studio.edit(websiteEntry(t('studio.ws.h.seo'), { seo: w.seo }, { seo }))}>{t('studio.ws.apply')}</button>
          <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setSeo(w.seo)}>{t('studio.ws.discard')}</button>
        </div>}
      </fieldset>
      {GROUPS.map((g) => {
        const items = checks.filter((c) => c.group === g);
        const done = items.filter((c) => c.ok).length;
        return (
          <section key={g} className="ws-checks" aria-labelledby={`ws-checks-${g}`}>
            <h3 id={`ws-checks-${g}`} className="ws-h3 spread">{t(`studio.seo.group.${g}`)} <span className="fine num">{t('studio.seo.done', { done, total: items.length })}</span></h3>
            <ul>
              {items.map((c) => (
                <li key={c.key} data-ok={c.ok || undefined}>
                  <Badge tone={c.ok ? 'ok' : 'warn'}>{c.ok ? t('studio.seo.ok') : t('studio.seo.todo')}</Badge>
                  <span><strong>{t(`studio.seo.check.${c.key}`)}</strong><small className="fine">{t(`studio.seo.check.${c.key}.hint`)}</small></span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="fine m-0">{t('studio.seo.sitemap')} <a href={`${studio.state.publicPath}/sitemap.xml`} target="_blank" rel="noopener"><code dir="ltr">{studio.state.publicPath}/sitemap.xml</code></a></p>
      <details className="ws-ld">
        <summary>{t('studio.seo.jsonLd')}</summary>
        {problems.length ? <Notice tone="warn">{problems.join(' · ')}</Notice> : <p className="fine">{t('studio.seo.jsonLdValid')}</p>}
        <pre dir="ltr">{JSON.stringify(ld, null, 2)}</pre>
      </details>
    </div>
  );
}
