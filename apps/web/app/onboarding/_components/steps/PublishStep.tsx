'use client';
// Step 8: preview in a phone and a desktop frame, then publish. The frames draw the live public menu
// (GET /v1/public/menu/:slug, what the QR opens) with the brand chosen at step 4; the real page opens in a new tab.
// (Pages cannot be framed: the CSP sets frame-ancestors 'none' on every page, which this preview keeps.) Publishing
// is the website publish (a new revision, studio_basic), which also puts the restaurant site at /r/<slug> online.
import { useEffect, useState, type CSSProperties } from 'react';
import { formatMoney, type Currency } from '@resuto/contracts/lite';
import type { BrandPublishResult, BrandView, PublicMenu } from '@resuto/contracts';
import { SegmentedControl } from '@resuto/ui';
import { SOCIAL_ICON_SRC, socialEntries } from '@/components/guest/SocialIcons';
import { newIdempotencyKey } from '@/lib/api';
import { APP_ORIGIN } from '@/lib/app-origin';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';

type Frame = 'phone' | 'desktop';

export function PublishStep() {
  const { t, tn, locale } = useT();
  const w = useWizard();
  const { call } = w;
  const org = w.org!;
  const [frame, setFrame] = useState<Frame>('phone');
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [brand, setBrand] = useState<BrandView | null>(null);
  const [published, setPublished] = useState<BrandPublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [key] = useState(() => newIdempotencyKey());

  useEffect(() => {
    let live = true;
    Promise.all([call<PublicMenu>(`/public/menu/${encodeURIComponent(org.slug)}`), call<BrandView>(`/o/${org.id}/brand`)])
      .then(([m, b]) => { if (live) { setMenu(m); setBrand(b); } })
      .catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [org.id, org.slug, call]);

  const isPublished = !!published || (brand?.website.status === 'published' && !brand.website.hasUnpublishedChanges);
  /** Publishes the draft; true when it went live. */
  const publish = async () => {
    setPublishing(true); setError(null);
    try {
      setPublished(await call<BrandPublishResult>(`/o/${org.id}/brand/publish`, { body: { key } }));
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setPublishing(false);
    }
  };
  const submit = async () => {
    if (!isPublished && !(await publish())) return;
    await w.finish();
  };

  const menuUrl = `${APP_ORIGIN}/m/${org.slug}`;
  const siteUrl = `${APP_ORIGIN}/r/${org.slug}`;
  return (
    <StepFrame title={t('onb.publish.title')} body={t('onb.publish.body')} onSubmit={submit} error={error}
      primary={isPublished ? t('onb.continue') : publishing ? t('onb.publish.publishing') : t('onb.publish.publish')} primaryDisabled={publishing}
      secondary={isPublished && brand?.website.hasUnpublishedChanges && !published
        ? <button type="button" className="btn onb-btn" onClick={() => void publish()} disabled={publishing}>{t('onb.publish.republish')}</button> : undefined}>
      <SegmentedControl<Frame> label={t('onb.publish.view')} value={frame} onChange={setFrame} size="sm"
        options={[{ value: 'phone', label: t('onb.publish.phone') }, { value: 'desktop', label: t('onb.publish.desktop') }]} />
      <div className={`onb-device is-${frame}`}>
        <div className="onb-device-screen" role="img" aria-label={t('onb.publish.frame')}>
          {menu && brand ? <MenuPreview menu={menu} brand={brand} locale={locale} /> : <div className="onb-step-loading" aria-hidden="true" />}
        </div>
      </div>
      <p className="onb-links">
        <a className="onb-link" href={menuUrl} target="_blank" rel="noopener noreferrer"><bdi dir="ltr">{menuUrl.replace(/^https?:\/\//, '')}</bdi> ↗</a>
      </p>
      {isPublished && (
        <p className="onb-ok" role="status">
          {tn('onb.publish.published', {
            menu: <a href={menuUrl} target="_blank" rel="noopener noreferrer"><bdi dir="ltr">{menuUrl.replace(/^https?:\/\//, '')}</bdi></a>,
            site: <a href={siteUrl} target="_blank" rel="noopener noreferrer"><bdi dir="ltr">{siteUrl.replace(/^https?:\/\//, '')}</bdi></a>,
          })}
        </p>
      )}
    </StepFrame>
  );
}

/** A drawing of the guest menu with the restaurant's brand (not the page itself: pages cannot be framed). */
function MenuPreview({ menu, brand, locale }: { menu: PublicMenu; brand: BrandView; locale: 'en' | 'ar' }) {
  const vars = { '--pv-primary': brand.theme.primaryColor, '--pv-accent': brand.theme.accentColor, '--pv-bg': brand.theme.backgroundColor } as CSSProperties;
  const currency = menu.org.currency as Currency;
  return (
    <div className="onb-pv" style={vars} aria-hidden="true">
      <div className="onb-pv-head">
        {brand.logoUrl && <img src={brand.logoUrl} alt="" />}
        <strong>{pick(locale, menu.org.name, menu.org.nameAr)}</strong>
      </div>
      <div className="onb-pv-body">
        {menu.categories.map((c) => (
          <section key={c.id}>
            <h3>{pick(locale, c.name, c.nameAr)}</h3>
            <div className="onb-pv-grid">
              {c.products.map((p) => (
                <div key={p.id} className={`onb-pv-dish${p.available ? '' : ' is-off'}`}>
                  {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <span className="onb-pv-ph" />}
                  <span className="onb-pv-name">{pick(locale, p.name, p.nameAr)}</span>
                  <span className="onb-pv-price"><bdi>{formatMoney(p.priceMinor, currency, locale)}</bdi></span>
                </div>
              ))}
            </div>
          </section>
        ))}
        <div className="onb-pv-social">{socialEntries(menu.org.socialLinks).map(([n]) => <img key={n} src={SOCIAL_ICON_SRC[n]} alt="" />)}</div>
      </div>
    </div>
  );
}
