'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicMenu, PublicSite, WebsiteSeo } from '@resuto/contracts';
import { Badge, Notice, SegmentedControl, Skeleton, Tabs, useToast } from '@resuto/ui';
import { menuPageJsonLd, siteJsonLd, siteUrls } from '@/app/r/[slug]/_components/structured-data';
import { openingHours, pickName } from '@/app/r/[slug]/_components/site-utils';
import { SiteView } from '@/app/r/[slug]/_components/SiteView';
import { API_URL } from '@/lib/api';
import { formatMessage } from '@/lib/i18n/format-message';
import { LocaleProvider, useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { auditCounts, auditSite, readRendered, type AuditArea, type AuditCheck, type AuditFix, type Locale, type RenderedPage } from '@/lib/site-audit';
import { jsonLdReport } from '@/lib/structured-data-checks';
import { websiteEntry } from '@/lib/studio-history';
import { useApi } from '@/lib/use-api';
import { LocalizedField, MediaField } from './EditorPanels';
import { loadSiteCopy, type SiteCopy } from './site-copy';
import type { MediaItem, Studio } from './types';

const LOCALES: Locale[] = ['en', 'ar'];
type Read<T> = { status: 'loading' } | { status: 'ok'; data: T } | { status: 'missing' } | { status: 'error' };

async function readPublic<T>(path: string): Promise<Read<T>> {
  try {
    const res = await fetch(`${API_URL}/v1/public/${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'error' };
    return { status: 'ok', data: (await res.json()) as T };
  } catch { return { status: 'error' }; }
}

/** The canonical page address of the site (its own domain when connected, else the app's /r/<slug>). */
export function siteUrlOf(site: Pick<PublicSite, 'canonicalHost' | 'slug'>) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return site.canonicalHost ? `https://${site.canonicalHost}/` : `${origin}/r/${site.slug}`;
}

/**
 * Renders the draft in both languages into documents that are never displayed (no browsing context: nothing loads),
 * and reads the heading outline, images and internal links from them: the checks use the page as it will really be.
 */
function RenderedReader({ site, copy, onRead }: { site: PublicSite; copy: SiteCopy; onRead: (r: Partial<Record<Locale, RenderedPage>>) => void }) {
  const docs = useMemo(() => ({ en: document.implementation.createHTMLDocument('en'), ar: document.implementation.createHTMLDocument('ar') }), []);
  const base = typeof window === 'undefined' ? '' : window.location.origin;
  useEffect(() => { onRead({ en: readRendered(docs.en, base), ar: readRendered(docs.ar, base) }); });
  return <>{LOCALES.map((l) => createPortal(
    <LocaleProvider key={l} locale={l} messages={copy[l]}>
      <SiteView site={site} locale={l} t={(k, v) => formatMessage(copy[l][k] ?? copy.en[k] ?? k, l, v)} />
    </LocaleProvider>, docs[l].body, l))}</>;
}

/**
 * The Optimize workspace (22-STUDIO): search (SEO), answer engines (AEO) and AI engines (GEO). Each tab has the settings
 * that matter for it, what the published pages emit, and checks over real data with pass/fail counts (lib/site-audit.ts).
 */
export function OptimizeWorkspace({ studio, onFix, initialTab = 'seo' }: { studio: Studio; onFix: (f: AuditFix) => void; initialTab?: AuditArea }) {
  const { t } = useT();
  const [tab, setTab] = useState<AuditArea>(initialTab);
  const draft = studio.preview;
  const w = studio.state.website;
  const slug = studio.state.publicPath.replace(/^\/r\//, '');
  const [published, setPublished] = useState<Read<PublicSite>>({ status: 'loading' });
  const [menu, setMenu] = useState<Read<PublicMenu>>({ status: 'loading' });
  const [robots, setRobots] = useState<Read<string>>({ status: 'loading' });
  const [copy, setCopy] = useState<SiteCopy | null>(null);
  const [rendered, setRendered] = useState<Partial<Record<Locale, RenderedPage>>>({});
  const media = useApi<{ items: MediaItem[] }>(`/o/${studio.orgId}/studio/media`);

  useEffect(() => {
    let live = true;
    void readPublic<PublicSite>(`sites/${encodeURIComponent(slug)}`).then((r) => { if (live) setPublished(r); });
    void readPublic<PublicMenu>(`menu/${encodeURIComponent(slug)}`).then((r) => { if (live) setMenu(r); });
    return () => { live = false; };
  }, [slug, w.publishedRevision]);
  useEffect(() => {
    // robots.txt is read where it is served for this site: the app host (a custom domain serves the same rules).
    fetch('/robots.txt', { cache: 'no-store' }).then(async (r) => setRobots(r.ok ? { status: 'ok', data: await r.text() } : { status: 'error' }), () => setRobots({ status: 'error' }));
    loadSiteCopy().then(setCopy, () => setCopy(null));
  }, []);
  const onRead = useCallback((r: Partial<Record<Locale, RenderedPage>>) => {
    setRendered((prev) => (JSON.stringify(prev) === JSON.stringify(r) ? prev : r));
  }, []);

  const siteUrl = draft ? siteUrlOf(draft) : '';
  const checks = useMemo(() => (draft ? auditSite({
    draft, published: published.status === 'ok' ? published.data : null, website: w, siteUrl,
    menu: menu.status === 'ok' ? menu.data : null, rendered, robotsTxt: robots.status === 'ok' ? robots.data : robots.status === 'loading' ? undefined : null,
    media: media.data?.items.map((m) => ({ id: m.id, url: m.url, alt: m.alt, altAr: m.altAr, inUse: m.inUse })),
  }) : []), [draft, published, w, siteUrl, menu, rendered, robots, media.data]);

  const altRef = useRef<HTMLElement>(null);
  const fix = (f: AuditFix) => {
    if (f.kind === 'field') {
      setTab('seo');
      requestAnimationFrame(() => document.getElementById(`opt-field-${f.field}`)?.scrollIntoView({ block: 'center' }));
      return;
    }
    if (f.kind === 'media') { setTab('seo'); requestAnimationFrame(() => altRef.current?.scrollIntoView({ block: 'start' })); return; }
    onFix(f);
  };

  if (!draft) return <div className="ws-pane-pad"><Skeleton lines={8} /></div>;
  const loading = published.status === 'loading' || menu.status === 'loading';
  const errors = [published.status === 'error' && 'published', menu.status === 'error' && 'menu', robots.status === 'error' && 'robots'].filter(Boolean) as string[];
  const tabLabel = (a: AuditArea) => {
    const c = auditCounts(checks, a);
    const open = c.failed + c.warnings;
    return <span className="row gap-6">{t(`studio.opt.tab.${a}`)} <span className="ws-opt-count num" data-bad={c.failed > 0 || undefined} data-warn={(!c.failed && open > 0) || undefined}>
      {open ? t('studio.opt.toFix', { n: open }) : t('studio.opt.allPass')}</span></span>;
  };
  const counts = auditCounts(checks, tab);
  return (
    <div className="ws-opt">
      {copy && <RenderedReader site={draft} copy={copy} onRead={onRead} />}
      <header className="stack gap-6">
        <h2 className="ws-opt-title">{t('studio.opt.title')}</h2>
        <p className="fine m-0">{t('studio.opt.intro')}</p>
        <p className="m-0 row gap-8 ws-opt-state">
          {w.publishedRevision === 0 ? <Badge tone="warn">{t('studio.opt.state.never')}</Badge>
            : w.hasUnpublishedChanges ? <Badge tone="pay">{t('studio.opt.state.draft')}</Badge>
              : <Badge tone="ok">{t('studio.opt.state.synced', { rev: w.publishedRevision })}</Badge>}
          {w.publishedRevision > 0 && <a href={studio.state.publicPath} target="_blank" rel="noopener" className="fine"><code dir="ltr">{siteUrl}</code> ↗</a>}
        </p>
        {loading && <p className="fine m-0" role="status">{t('studio.opt.loading')}</p>}
        {errors.map((e) => <Notice key={e} tone="warn">{t('studio.opt.readError', { what: t(`studio.opt.what.${e}`) })}</Notice>)}
      </header>
      <Tabs label={t('studio.opt.title')} value={tab} onChange={setTab} tabs={(['seo', 'aeo', 'geo'] as const).map((a) => ({ key: a, label: tabLabel(a) }))} />
      <p className="ws-opt-summary num" role="status">{t('studio.opt.counts', { passed: counts.passed, failed: counts.failed, warnings: counts.warnings })}</p>

      {tab === 'seo' && <>
        <SearchSettings studio={studio} draft={draft} siteUrl={siteUrl} />
        <UrlFacts studio={studio} draft={draft} siteUrl={siteUrl} />
        <section ref={altRef} className="ws-opt-block" aria-labelledby="opt-h-images">
          <h3 id="opt-h-images" className="ws-h3">{t('studio.opt.h.images')}</h3>
          <AltEditor studio={studio} items={media.data?.items ?? null} onSaved={() => { void media.reload(); void studio.reloadPreview(); }} />
          {menu.status === 'ok' && <p className="fine m-0">{t('studio.opt.alt.dishes', { missing: menu.data.categories.flatMap((c) => c.products).filter((p) => !p.nameAr).length })}</p>}
        </section>
      </>}
      {tab === 'aeo' && <>
        <JsonLdPreview draft={draft} published={published.status === 'ok' ? published.data : null} menu={menu.status === 'ok' ? menu.data : null} siteUrl={siteUrl} />
        <FactsTable studio={studio} draft={draft} />
      </>}
      {tab === 'geo' && <>
        <EntityChain draft={draft} menu={menu.status === 'ok' ? menu.data : null} siteUrl={siteUrl} />
        <Suggestions studio={studio} onFix={fix} />
      </>}
      <CheckList checks={checks.filter((c) => c.area === tab)} onFix={fix} />
    </div>
  );
}

// --- Search appearance ----------------------------------------------------------------------------------------------
const TITLE = { min: 15, max: 60 };
const DESCRIPTION = { min: 70, max: 160 };

/** A factual first draft for empty search fields, from the restaurant's own records (applied only when the owner saves). */
export function suggestSeo(site: PublicSite): WebsiteSeo {
  const b = site.branches[0];
  const where = [b?.address, b?.city].filter(Boolean).join(', ');
  const city = b?.city ?? '';
  const nameAr = site.org.nameAr || site.org.name;
  const orders = site.branches.some((x) => x.acceptsPickup || x.acceptsDelivery);
  const books = site.branches.some((x) => x.acceptsReservations);
  const doEn = [books && 'book a table', orders && 'order online'].filter(Boolean).join(' or ');
  const doAr = [books && 'احجز طاولة', orders && 'اطلب عبر الإنترنت'].filter(Boolean).join(' أو ');
  return {
    title: { en: city ? `${site.org.name} — restaurant in ${city}` : site.org.name, ar: city ? `${nameAr} — مطعم في ${city}` : nameAr },
    description: {
      en: `${site.org.name}${where ? `, ${where}` : ''}. See the menu with prices${doEn ? ` and ${doEn}` : ''}.`,
      ar: `${nameAr}${where ? `، ${where}` : ''}. تصفّح القائمة بالأسعار${doAr ? ` و${doAr}` : ''}.`,
    },
  };
}

function SearchSettings({ studio, draft, siteUrl }: { studio: Studio; draft: PublicSite; siteUrl: string }) {
  const { t } = useT();
  const w = studio.state.website;
  const [seo, setSeo] = useState<WebsiteSeo>(w.seo);
  useEffect(() => { setSeo(w.seo); }, [w.seo]);
  const dirty = JSON.stringify(seo) !== JSON.stringify(w.seo);
  useEffect(() => { studio.setDirty(dirty); return () => studio.setDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggest = () => {
    const s = suggestSeo(draft);
    setSeo((cur) => ({ ...cur,
      title: { en: cur.title?.en?.trim() || s.title!.en, ar: cur.title?.ar?.trim() || s.title!.ar },
      description: { en: cur.description?.en?.trim() || s.description!.en, ar: cur.description?.ar?.trim() || s.description!.ar } }));
  };
  const counter = (v: string | undefined, r: { min: number; max: number }) => t('studio.opt.chars', { len: (v ?? '').trim().length, min: r.min, max: r.max });
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-search">
      <h3 id="opt-h-search" className="ws-h3">{t('studio.opt.h.search')}</h3>
      <fieldset className="ws-fieldset stack gap-8" disabled={!studio.canWrite}>
        <div id="opt-field-title"><LocalizedField label={t('studio.seo.pageTitle')} value={seo.title} max={70} onChange={(v) => setSeo({ ...seo, title: v })}
          hint={`${counter(seo.title?.en, TITLE)} · ${counter(seo.title?.ar, TITLE)}`} /></div>
        <div id="opt-field-description"><LocalizedField label={t('studio.seo.description')} value={seo.description} max={170} multiline onChange={(v) => setSeo({ ...seo, description: v })}
          hint={`${counter(seo.description?.en, DESCRIPTION)} · ${counter(seo.description?.ar, DESCRIPTION)}`} /></div>
        <div id="opt-field-ogImage"><MediaField orgId={studio.orgId} label={t('studio.seo.ogImage')} id={seo.ogMediaId} media={studio.state.media} onChange={(id) => setSeo({ ...seo, ogMediaId: id })} /></div>
        {studio.canWrite && <div className="row gap-6 ws-wrap">
          <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void studio.edit(websiteEntry(t('studio.ws.h.seo'), { seo: w.seo }, { seo }))}>{t('studio.ws.apply')}</button>
          <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setSeo(w.seo)}>{t('studio.ws.discard')}</button>
          <button type="button" className="btn" onClick={suggest} title={t('studio.opt.suggestTextHint')}>{t('studio.opt.suggestText')}</button>
        </div>}
        <small className="fine">{t('studio.opt.suggestTextHint')}</small>
      </fieldset>
      <div className="ws-snippets">
        {LOCALES.map((l) => (
          <figure key={l} className="ws-snippet" lang={l} dir={l === 'ar' ? 'rtl' : 'ltr'}>
            <figcaption className="fine">{t('studio.opt.snippet', { lang: t(`studio.lang.${l}`) })}</figcaption>
            <span className="ws-snippet-url" dir="ltr">{`${siteUrl}?lang=${l}`}</span>
            <strong className="ws-snippet-title">{(seo.title?.[l] || pickName(l, draft.org.name, draft.org.nameAr)).slice(0, 70)}</strong>
            <span className="ws-snippet-body">{(seo.description?.[l] || '').slice(0, 170) || '—'}</span>
          </figure>
        ))}
      </div>
      <p className="fine m-0">{t('studio.opt.snippetNote')}</p>
    </section>
  );
}

function UrlFacts({ studio, draft, siteUrl }: { studio: Studio; draft: PublicSite; siteUrl: string }) {
  const { t } = useT();
  const urls = siteUrls(draft, siteUrl);
  const origin = new URL(siteUrl).origin;
  const sitemap = draft.canonicalHost ? `${origin}/sitemap.xml` : `${origin}/r/${draft.slug}/sitemap.xml`;
  const rows: Array<[string, string, string | null]> = [
    [t('studio.opt.url.public'), siteUrl, studio.state.website.publishedRevision > 0 ? studio.state.publicPath : null],
    [t('studio.opt.url.canonical'), siteUrl, null],
    [t('studio.opt.url.menu'), urls.menu, `/m/${draft.slug}`],
    [t('studio.opt.url.sitemap'), draft.canonicalHost ? sitemap : `${origin}/r/${draft.slug}/sitemap.xml`, `/r/${draft.slug}/sitemap.xml`],
    [t('studio.opt.url.robots'), `${origin}/robots.txt`, '/robots.txt'],
  ];
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-urls">
      <h3 id="opt-h-urls" className="ws-h3">{t('studio.opt.h.urls')}</h3>
      <dl className="ws-opt-dl">
        {rows.map(([k, v, href]) => (
          <div key={k}><dt>{k}</dt><dd>{href ? <a href={href} target="_blank" rel="noopener"><code dir="ltr">{v}</code> ↗</a> : <code dir="ltr">{v}</code>}</dd></div>
        ))}
        <div><dt>{t('studio.opt.url.hreflang')}</dt><dd className="stack gap-2">
          {[['en', `${siteUrl}?lang=en`], ['ar', `${siteUrl}?lang=ar`], ['x-default', siteUrl]].map(([l, u]) => <code key={l} dir="ltr">{l} → {u}</code>)}
        </dd></div>
      </dl>
      <p className="fine m-0">{draft.canonicalHost ? t('studio.opt.url.custom') : t('studio.opt.url.app')} {t('studio.opt.robotsMeta')}</p>
    </section>
  );
}

function AltEditor({ studio, items, onSaved }: { studio: Studio; items: MediaItem[] | null; onSaved: () => void }) {
  const { t } = useT();
  const used = (items ?? []).filter((m) => m.inUse);
  if (!items) return <Skeleton lines={3} />;
  if (!used.length) return <p className="fine m-0">{t('studio.opt.alt.none')}</p>;
  return <ul className="ws-alt-list">{used.map((m) => <AltRow key={m.id} studio={studio} item={m} onSaved={onSaved} />)}</ul>;
}

function AltRow({ studio, item, onSaved }: { studio: Studio; item: MediaItem; onSaved: () => void }) {
  const { t } = useT();
  const session = useSession();
  const toast = useToast();
  const [alt, setAlt] = useState(item.alt ?? '');
  const [altAr, setAltAr] = useState(item.altAr ?? '');
  const [busy, setBusy] = useState(false);
  const dirty = alt !== (item.alt ?? '') || altAr !== (item.altAr ?? '');
  const save = async () => {
    setBusy(true);
    try {
      await session.call(`/o/${studio.orgId}/studio/media/${item.id}`, { method: 'PATCH', body: { alt: alt.trim() || null, altAr: altAr.trim() || null } });
      toast.show({ message: t('studio.opt.alt.saved'), tone: 'ok' });
      onSaved();
    } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); } finally { setBusy(false); }
  };
  return (
    <li className="ws-alt-row">
      <img src={item.url} alt="" className="ws-thumb" />
      <label className="field"><span>{t('studio.opt.alt.en')}</span>
        <input className="input" dir="ltr" lang="en" maxLength={200} value={alt} disabled={!studio.canWrite} onChange={(e) => setAlt(e.target.value)} /></label>
      <label className="field"><span>{t('studio.opt.alt.ar')}</span>
        <input className="input" dir="rtl" lang="ar" maxLength={200} value={altAr} disabled={!studio.canWrite} onChange={(e) => setAltAr(e.target.value)} /></label>
      {studio.canWrite && <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={() => void save()}>{t('studio.opt.alt.save')}</button>}
    </li>
  );
}

// --- Structured data ------------------------------------------------------------------------------------------------
function JsonLdPreview({ draft, published, menu, siteUrl }: { draft: PublicSite; published: PublicSite | null; menu: PublicMenu | null; siteUrl: string }) {
  const { t } = useT();
  const [page, setPage] = useState<'site' | 'menu'>('site');
  const [version, setVersion] = useState<'draft' | 'published'>('draft');
  const [lang, setLang] = useState<Locale>('en');
  const source = version === 'draft' ? draft : published;
  const urls = siteUrls(draft, siteUrl);
  const docs = useMemo(() => {
    if (page === 'site') return source ? siteJsonLd(source, siteUrl, lang) : null;
    return menu ? menuPageJsonLd(menu, source, source ? siteUrl : null, urls.menu, lang) : null;
  }, [page, source, menu, siteUrl, lang, urls.menu]);
  const report = useMemo(() => (docs ? jsonLdReport(docs) : null), [docs]);
  const target = page === 'site' ? siteUrl : urls.menu;
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-ld">
      <h3 id="opt-h-ld" className="ws-h3">{t('studio.opt.h.structured')}</h3>
      <div className="row gap-8 ws-wrap">
        <SegmentedControl size="sm" label={t('studio.opt.ld.page')} value={page} onChange={setPage} options={[{ value: 'site', label: t('studio.opt.ld.site') }, { value: 'menu', label: t('studio.opt.ld.menu') }]} />
        <SegmentedControl size="sm" label={t('studio.opt.ld.version')} value={version} onChange={setVersion} options={[{ value: 'draft', label: t('studio.opt.ld.draft') }, { value: 'published', label: t('studio.opt.ld.published') }]} />
        <SegmentedControl size="sm" label={t('studio.opt.ld.language')} value={lang} onChange={setLang} options={[{ value: 'en', label: 'EN' }, { value: 'ar', label: 'ع' }]} />
      </div>
      {!docs || !report ? <p className="fine">{t('studio.opt.ld.empty', { reason: page === 'menu' && !menu ? t('studio.opt.ld.noMenu') : t('studio.opt.ld.notPublished') })}</p> : <>
        <ul className="ws-ld-report">
          <li>{report.problems.length ? <Badge tone="danger">{t('studio.opt.ld.problems', { list: report.problems.join(' · ') })}</Badge> : <Badge tone="ok">{t('studio.opt.ld.valid')}</Badge>}</li>
          <li><Badge tone={report.required.failed.length ? 'danger' : 'ok'}>{t('studio.opt.ld.required', { passed: report.required.passed, total: report.required.passed + report.required.failed.length })}</Badge>
            {report.required.failed.length > 0 && <small className="fine"> {t('studio.opt.ld.missing', { list: report.required.failed.map((c) => `${c.type}.${c.property}`).join(', ') })}</small>}</li>
          <li><Badge tone={report.recommended.missing.some((c) => !c.note) ? 'warn' : 'ok'}>{t('studio.opt.ld.recommended', { passed: report.recommended.passed, total: report.recommended.passed + report.recommended.missing.length })}</Badge>
            {report.recommended.missing.length > 0 && <small className="fine"> {t('studio.opt.ld.missing', { list: [...new Set(report.recommended.missing.map((c) => `${c.type}.${c.property}${c.note ? ` (${t(`studio.opt.ld.note.${c.note}`)})` : ''}`))].join(', ') })}</small>}</li>
          <li className="fine">{t('studio.opt.ld.nodes', { list: Object.entries(report.types).map(([k, n]) => `${k} ${n}`).join(' · ') })}</li>
        </ul>
        <p className="fine m-0">{t('studio.opt.ld.exact')}</p>
        <pre className="ws-ld-pre" dir="ltr" tabIndex={0} aria-label={t('studio.opt.h.structured')}>{JSON.stringify(docs.length === 1 ? docs[0] : docs, null, 2)}</pre>
      </>}
      <p className="fine m-0">{t('studio.opt.ld.disclaimer')}{' '}
        {/^https:\/\//.test(target) && version === 'published' && <a href={`https://search.google.com/test/rich-results?url=${encodeURIComponent(target)}`} target="_blank" rel="noopener">{t('studio.opt.ld.richResults')}</a>}</p>
    </section>
  );
}

function FactsTable({ studio, draft }: { studio: Studio; draft: PublicSite }) {
  const { t, locale } = useT();
  const cell = (ok: boolean, text: string) => (ok ? <span>{text}</span> : <Badge tone="warn">{t('studio.opt.fact.missing')}</Badge>);
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-facts">
      <h3 id="opt-h-facts" className="ws-h3">{t('studio.opt.h.facts')}</h3>
      <div className="ws-table-scroll"><table className="ws-facts">
        <thead><tr><th scope="col">{t('studio.opt.fact.branch')}</th><th scope="col">{t('studio.opt.fact.address')}</th><th scope="col">{t('studio.opt.fact.phone')}</th>
          <th scope="col">{t('studio.opt.fact.hours')}</th><th scope="col">{t('studio.opt.fact.map')}</th><th scope="col">{t('studio.opt.fact.services')}</th></tr></thead>
        <tbody>{draft.branches.map((b) => {
          const days = new Set(openingHours(b.openingHours).map((h) => h.day)).size;
          const services = [b.acceptsDineIn && 'dineIn', b.acceptsPickup && 'pickup', b.acceptsDelivery && 'delivery', b.acceptsReservations && 'booking'].filter(Boolean) as string[];
          return (
            <tr key={b.id}>
              <th scope="row">{pickName(locale, b.name, b.nameAr)}</th>
              <td>{cell(!!(b.address && b.city), [b.address, b.city].filter(Boolean).join(', '))}</td>
              <td>{cell(!!b.phone, b.phone ?? '')}</td>
              <td>{cell(days > 0, t('studio.opt.fact.days', { n: days }))}</td>
              <td>{cell(b.latitude !== null && b.longitude !== null, t('studio.opt.fact.set'))}</td>
              <td>{services.map((s) => t(`studio.opt.fact.${s}`)).join(' · ')}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
      <p className="fine m-0">{t('studio.opt.fact.source')} <Link href={`/dashboard/${studio.orgId}/settings`}>{t('studio.opt.fact.edit')} ↗</Link></p>
    </section>
  );
}

function EntityChain({ draft, menu, siteUrl }: { draft: PublicSite; menu: PublicMenu | null; siteUrl: string }) {
  const { t } = useT();
  const types = useMemo(() => {
    const docs = [...siteJsonLd(draft, siteUrl, 'en'), ...(menu ? menuPageJsonLd(menu, draft, siteUrl, siteUrls(draft, siteUrl).menu, 'en') : [])];
    return jsonLdReport(docs).types;
  }, [draft, menu, siteUrl]);
  const steps: Array<[string, number]> = [
    ['restaurant', 1], ['branches', draft.branches.length], ['menu', types.Menu ? 1 : 0], ['sections', types.MenuSection ?? 0],
    ['items', types.MenuItem ?? 0], ['offers', types.Offer ?? 0], ['faq', types.Question ?? 0],
  ];
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-entities">
      <h3 id="opt-h-entities" className="ws-h3">{t('studio.opt.h.entities')}</h3>
      <ol className="ws-chain">{steps.map(([k, n]) => (
        <li key={k} data-empty={n === 0 || undefined}><strong className="num">{n}</strong><span>{t(`studio.opt.entity.${k}`)}</span></li>
      ))}</ol>
    </section>
  );
}

function Suggestions({ studio, onFix }: { studio: Studio; onFix: (f: AuditFix) => void }) {
  const { t } = useT();
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-suggest">
      <h3 id="opt-h-suggest" className="ws-h3">{t('studio.opt.h.suggest')}</h3>
      <div className="ws-suggest">
        {(['faq', 'about'] as const).map((k) => (
          <div key={k} className="ws-suggest-card">
            <strong>{t(`studio.opt.suggest.${k}`)}</strong>
            <p className="fine m-0">{t(`studio.opt.suggest.${k}Body`)}</p>
            <button type="button" className="btn btn-sm" disabled={!studio.canWrite} onClick={() => onFix({ kind: 'ai', request: k })}>{t('studio.opt.suggest.cta')}</button>
          </div>
        ))}
      </div>
    </section>
  );
}

// --- Checks -----------------------------------------------------------------------------------------------------------
const TONE = { pass: 'ok', fail: 'danger', warn: 'warn', info: 'info' } as const;
const ORDER = { fail: 0, warn: 1, info: 2, pass: 3 } as const;

function CheckList({ checks, onFix }: { checks: AuditCheck[]; onFix: (f: AuditFix) => void }) {
  const { t } = useT();
  const sorted = [...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  return (
    <section className="ws-opt-block" aria-labelledby="opt-h-checks">
      <h3 id="opt-h-checks" className="ws-h3">{t('studio.opt.h.checks')}</h3>
      <ul className="ws-opt-checks">
        {sorted.map((c) => (
          <li key={`${c.id}:${c.locale ?? ''}`} data-status={c.status} data-check={c.id}>
            <Badge tone={TONE[c.status]}>{t(`studio.opt.status.${c.status}`)}</Badge>
            <div className="ws-opt-check-main">
              <strong>{t(`studio.opt.check.${c.id}`, c.vars)}{c.locale && <span className="badge ws-opt-lang">{t(`studio.opt.lang.${c.locale}`)}</span>}</strong>
              {!!c.details?.length && <ul className="ws-opt-details">{c.details.slice(0, 12).map((d, i) => <li key={i} dir="auto">{d}</li>)}</ul>}
              <details className="ws-opt-why"><summary>{t('studio.opt.why')}</summary><p className="fine m-0">{t(`studio.opt.check.${c.id}.why`)}</p></details>
            </div>
            {c.fix && (c.status !== 'pass' || c.fix.kind === 'link') && <FixButton fix={c.fix} onFix={onFix} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function FixButton({ fix, onFix }: { fix: AuditFix; onFix: (f: AuditFix) => void }) {
  const { t } = useT();
  if (fix.kind === 'link') return <a className="btn btn-sm" href={fix.href} target="_blank" rel="noopener">{t('studio.opt.fix.link')} ↗</a>;
  return <button type="button" className="btn btn-sm" onClick={() => onFix(fix)}>{t(`studio.opt.fix.${fix.kind}`)}</button>;
}
