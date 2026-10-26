// Restaurant website renderer (server- and client-safe: no hooks). Ports the
// legacy guest home page ("olive": the legacy guest home script and the platform stylesheet),
// the Smash & Co storefront ("smash", legacy/public/burger.js/css) and a
// lighter "minimal" variant, all driven by published Studio data.
import type { CSSProperties, ReactNode } from 'react';
import type { PublicSite, PublicSiteProduct, PublicSiteSection } from '@resuto/contracts';
import { SOCIAL_NETWORKS, type SocialNetwork } from '@resuto/contracts/lite';
import { SocialIcons } from '@/components/guest/SocialIcons';
import { DishImage as PublicDishImage } from '@/components/public/DishImage';
import { DISH_SIZES, dishSrcSet } from '@/lib/dish-image';
import { LanguageToggle } from '@/lib/i18n/client';
import {
  acceptsOrders, acceptsReservations, altOf, clock, DAY_KEYS, discountPercent, heroCopy, loc, openingHours, pickName, price, promotionLabel, showsDemoStory, type SiteLocale, type T,
} from './site-utils';
import './site.css';

type Section = PublicSiteSection;
interface Ctx { site: PublicSite; locale: SiteLocale; t: T; links: { order: string; reserve: string; home: string }; preview: boolean }

/** Header line under the name: the owner's tagline, "Example restaurant" for the demo tenant (legacy), else the city. */
const tagline = ({ site, locale, t }: Ctx) => loc(site.theme.tagline, locale) || (site.org.demo ? t('studio.site.example') : site.branches[0]?.city || '');
/** Storefront paths are /r/<org>/<store>; on the restaurant's own domain the site root is "/" instead of /r/<org>. */
const storefrontHref = (ctx: Ctx, path: string) => (ctx.links.home === '/' ? path.replace(/^\/r\/[^/]+/, '') || '/' : path);

export function SiteView({ site, locale, t, preview = false, hostLinks }: {
  site: PublicSite; locale: SiteLocale; t: T; preview?: boolean;
  /** On a custom domain the guest routes are host-relative. */
  hostLinks?: { order: string; reserve: string; home: string };
}) {
  const ctx: Ctx = { site, locale, t, links: hostLinks ?? { order: site.links.order, reserve: site.links.reserve, home: site.links.site }, preview };
  const vars = {
    '--site-primary': site.theme.primaryColor,
    '--site-accent': site.theme.accentColor,
    '--site-bg': site.theme.backgroundColor,
  } as CSSProperties;
  const name = pickName(locale, site.org.name, site.org.nameAr);
  const body = site.sections.map((s) => <Block key={s.id} s={s} ctx={ctx} />);
  if (site.template === 'smash') {
    return (
      <div className="bg-app site-root" style={vars} data-template="smash" data-preview={preview || undefined}>
        <header className="bg-head">
          <a className="bg-logo" href={ctx.links.home}>
            {site.theme.logoUrl ? <img src={site.theme.logoUrl} alt="" className="site-logo-img" /> : <i aria-hidden>{name.slice(0, 1).toUpperCase()}</i>}
            <span>{name}</span>
          </a>
          <nav className="bg-head-links" aria-label={t('studio.site.nav')}>
            {acceptsOrders(site) && <a href={ctx.links.order}>{t('studio.site.menu')}</a>}
            {acceptsReservations(site) && <a href={ctx.links.reserve}>{t('studio.site.reservations')}</a>}
            {!preview && <LanguageToggle className="bg-lang" />}
          </nav>
        </header>
        <main id="main">{body}</main>
        <Footer ctx={ctx} className="bg-foot-note" />
      </div>
    );
  }
  return (
    <div className={`consumer-app site-root${site.template === 'minimal' ? ' site-minimal' : ''}${site.theme.font === 'editorial' ? ' site-editorial' : ''}`} style={vars} data-template={site.template} data-preview={preview || undefined}>
      <header className="consumer-header">
        <a className="olive-logo" href={ctx.links.home}>
          {site.theme.logoUrl && <img src={site.theme.logoUrl} alt="" className="site-logo-img" />}
          <span>{name}<small>{tagline(ctx)}</small></span>
        </a>
        <nav aria-label={t('studio.site.nav')}>
          {acceptsOrders(site) && <a href={ctx.links.order}>{t('studio.site.menu')}</a>}
          {acceptsReservations(site) && <a href={ctx.links.reserve}>{t('studio.site.reservations')}</a>}
          {(site.storefronts ?? []).map((sf) => <a key={sf.slug} href={storefrontHref(ctx, sf.path)} className="site-storefront-link">{pickName(locale, sf.name, sf.nameAr)}</a>)}
          {!preview && <LanguageToggle />}
        </nav>
      </header>
      <main id="main">{body}</main>
      <Footer ctx={ctx} className="consumer-footer" />
    </div>
  );
}

function Footer({ ctx, className }: { ctx: Ctx; className: string }) {
  const { site, locale, t } = ctx;
  return (
    <>
    {/* 21-ONB: the restaurant's social links as icons above the footer (only valid https links on each network). */}
    <div className="site-social-row"><SocialIcons links={site.org.socialLinks} t={t} className="site-social" /></div>
    <footer className={className}>
      {/* The demo tenant is labelled as the legacy page was: an example restaurant with illustrated (AI-generated) dishes. */}
      {site.org.demo
        ? <span>{t('studio.site.example')} · {t('studio.site.illustrations')}</span>
        : <span>© <bdi>{new Date().getFullYear()}</bdi> {pickName(locale, site.org.name, site.org.nameAr)}{site.branches[0]?.city ? ` · ${site.branches[0].city}` : ''}</span>}
      <a href="/">{t('studio.site.poweredBy')}</a>
    </footer>
    </>
  );
}

/**
 * A section with its inspector layout (alignment, spacing, tone, columns) and, on the Studio canvas, the hooks the
 * canvas uses for selection and the change-set diff (data-sid, data-diff). Published sections without a layout render
 * exactly as before (no wrapper).
 */
function Block({ s, ctx }: { s: Section; ctx: Ctx }) {
  const view = SectionView({ s, ctx });
  const layout = s.content.layout;
  const diff = ctx.site.diff;
  const mark = diff ? (diff.added.includes(s.id) ? 'added' : diff.changed.includes(s.id) ? 'changed' : undefined) : undefined;
  if (!ctx.preview && !layout) return view;
  return (
    <div className="site-block" data-sid={ctx.preview ? s.id : undefined} data-kind={ctx.preview ? s.kind : undefined} data-diff={mark}
      data-diff-label={mark ? ctx.t(`studio.site.diff.${mark}`) : undefined}
      data-align={layout?.align} data-spacing={layout?.spacing} data-tone={layout?.tone} data-columns={layout?.columns}>
      {view ?? (ctx.preview ? <p className="site-empty-block">{ctx.t('studio.site.emptyBlock')}</p> : null)}
    </div>
  );
}

function SectionView({ s, ctx }: { s: Section; ctx: Ctx }): ReactNode {
  const smash = ctx.site.template === 'smash';
  switch (s.kind) {
    case 'hero': return smash ? <SmashHero s={s} ctx={ctx} /> : <OliveHero s={s} ctx={ctx} />;
    case 'about': return <About s={s} ctx={ctx} />;
    case 'menu_highlights': return smash ? <SmashMenu s={s} ctx={ctx} /> : <OliveMenu s={s} ctx={ctx} />;
    case 'gallery': return <Gallery s={s} ctx={ctx} />;
    case 'reservations': return acceptsReservations(ctx.site) ? <Invitation s={s} ctx={ctx} kind="reservations" /> : null;
    case 'ordering': return acceptsOrders(ctx.site) ? <Invitation s={s} ctx={ctx} kind="ordering" /> : null;
    case 'location': return <Location s={s} ctx={ctx} />;
    case 'hours': return <HoursSection s={s} ctx={ctx} />;
    case 'testimonials': return <Quotes s={s} ctx={ctx} />;
    case 'contact': return <Contact s={s} ctx={ctx} />;
    case 'custom': return <Custom s={s} ctx={ctx} />;
    case 'promo_banner': return <PromoBanner s={s} ctx={ctx} />;
    case 'offers': return <Offers s={s} ctx={ctx} />;
    case 'social': return <Social s={s} ctx={ctx} />;
    case 'faq': return <Faq s={s} ctx={ctx} />;
    case 'menu_full': return <FullMenu s={s} ctx={ctx} />;
    default: return null;
  }
}

const heading = (s: Section, ctx: Ctx, fallbackKey: string) => loc(s.content.headline, ctx.locale) || ctx.t(fallbackKey);

function Ctas({ ctx, s, smash }: { ctx: Ctx; s: Section; smash?: boolean }) {
  const { site, t, links } = ctx;
  const order = acceptsOrders(site), reserve = acceptsReservations(site);
  const arrow = ctx.locale === 'ar' ? '↖' : '↗';
  const label = loc(s.content.ctaLabel, ctx.locale);
  if (smash) {
    return (
      <div className="bg-hero-actions">
        {order && <a className="bg-btn" href={links.order}>{label || t('studio.site.startOrder')} <span aria-hidden>{ctx.locale === 'ar' ? '←' : '→'}</span></a>}
        {reserve && <a className="bg-btn ghost" href={links.reserve}>{t('studio.site.bookTable')}</a>}
      </div>
    );
  }
  return (
    <div className="site-ctas">
      {/* Label and arrow are one flex item, so the button gap never pulls the arrow away from its label (PAR-09). */}
      {order && <a className="primary button" href={links.order}><span className="button-label">{label || t('studio.site.browseMenu')}{' '}<span aria-hidden>{arrow}</span></span></a>}
      {reserve && <a className="secondary button" href={links.reserve}>{t('studio.site.bookTable')}</a>}
    </div>
  );
}

function OliveHero({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site } = ctx;
  const img = s.content.media?.url ?? site.theme.heroUrl;
  const copy = heroCopy(s, ctx.site, ctx.locale, ctx.t);
  return (
    <section className={`restaurant-editorial${img ? '' : ' no-photo'}`} aria-labelledby={`h-${s.id}`}>
      {/* Without a photo the template draws its own backdrop (site.css .no-photo), never another restaurant's room. */}
      {img ? <img src={img} alt={altOf(s.content.media, ctx.locale)} fetchPriority="high" /> : <span className="site-hero-mark" aria-hidden>{copy.eyebrow.slice(0, 1)}</span>}
      <div>
        <span className="overline">{copy.eyebrow}</span>
        <h1 id={`h-${s.id}`}>{copy.headline}</h1>
        {copy.body && <p>{copy.body}</p>}
        <Ctas ctx={ctx} s={s} />
      </div>
    </section>
  );
}

function SmashHero({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale } = ctx;
  const img = s.content.media?.url ?? site.theme.heroUrl;
  const headline = loc(s.content.headline, locale) || pickName(locale, site.org.name, site.org.nameAr);
  const [first, ...rest] = headline.split(/(?<=[.!؟?])\s+/);
  return (
    <section className="bg-hero" aria-labelledby={`h-${s.id}`}>
      <div className={`bg-hero-inner${img ? '' : ' no-art'}`}>
        <div>
          <h1 id={`h-${s.id}`}>{first}{rest.length ? <><br /><em>{rest.join(' ')}</em></> : null}</h1>
          {loc(s.content.body, locale) && <p>{loc(s.content.body, locale)}</p>}
          <Ctas ctx={ctx} s={s} smash />
        </div>
        {img && (
          <div className="bg-hero-art">
            <img src={img} alt={altOf(s.content.media, ctx.locale)} fetchPriority="high" />
            {loc(s.content.eyebrow, locale) && <span>{loc(s.content.eyebrow, locale)}</span>}
          </div>
        )}
      </div>
    </section>
  );
}

function About({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale, site } = ctx;
  const img = s.content.media;
  return (
    <section className="consumer-main restaurant-introduction" aria-labelledby={`h-${s.id}`}>
      <div>
        <span className="overline">{loc(s.content.eyebrow, locale) || pickName(locale, site.org.name, site.org.nameAr)}</span>
        <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.aboutTitle')}</h2>
        {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
        {acceptsOrders(site) && <a className="site-link" href={ctx.links.order}>{ctx.t('studio.site.browseMenu')} <span aria-hidden>{locale === 'ar' ? '↖' : '↗'}</span></a>}
      </div>
      {img ? <img className="dish-photo" src={img.url} alt={altOf(img, ctx.locale)} loading="lazy" /> : <span className="dish-photo dish-placeholder" aria-hidden>◌</span>}
    </section>
  );
}

function DishImage({ url, name, englishName, srcSet, sizes }: { url: string | null; name: string; englishName?: string; srcSet?: string; sizes?: string }) {
  return <PublicDishImage url={url} srcSet={srcSet} sizes={sizes} name={name} englishName={englishName} className="dish-photo" />;
}

/**
 * Menu highlights in the olive template, as the legacy guest home showed them: the dishes (photo, name, price). The
 * demo restaurant also gets the legacy "Dinner, without the back-and-forth." story beside the first dish photo; that
 * is demo copy, not an owner-editable section, so other restaurants never see words they did not write. The minimal
 * template keeps descriptions.
 */
function OliveMenu({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale, t } = ctx;
  if (!site.menuHighlights.length) return null;
  const olive = site.template === 'olive';
  const lead = site.menuHighlights.find((m) => m.imageUrl);
  return (
    <>
      {olive && showsDemoStory(site) && lead && (
        <section className="consumer-main restaurant-introduction" aria-labelledby={`h-${s.id}-story`}>
          <div>
            <span className="overline">{pickName(locale, site.org.name, site.org.nameAr)}</span>
            <h2 id={`h-${s.id}-story`}>{t('studio.site.tpl.storyTitle')}</h2>
            <p>{t('studio.site.tpl.storyBody')}</p>
            <a className="site-link" href={ctx.links.order}>{t('studio.site.browseMenu')} <span aria-hidden>{locale === 'ar' ? '↖' : '↗'}</span></a>
          </div>
          <img className="dish-photo" srcSet={dishSrcSet(lead)} sizes={dishSrcSet(lead) ? DISH_SIZES.siteStory : undefined} src={lead.imageUrl!}
            alt={pickName(locale, lead.name, lead.nameAr)} loading="lazy" />
        </section>
      )}
      <section className="consumer-main" aria-labelledby={`h-${s.id}`}>
        <div className="site-section-head">
          <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.menu')}</h2>
          {!olive && acceptsOrders(site) && <a className="site-link" href={ctx.links.order}>{t('studio.site.fullMenu')} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span></a>}
        </div>
        {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
        <div className="dish-grid">
          {site.menuHighlights.map((m) => {
            const name = pickName(locale, m.name, m.nameAr);
            const desc = pickName(locale, m.description, m.descriptionAr);
            const inner = (
              <>
                {/* The card's CSS box is square (aspect-ratio: 1), so no width/height attributes: they would set its height. */}
                <DishImage url={m.imageUrl} srcSet={dishSrcSet(m)} sizes={DISH_SIZES.siteCard} name={name} englishName={m.name} />
                <div className="dish-body">
                  <h3>{name}</h3>
                  {!olive && desc && <p>{desc}</p>}
                  <strong><bdi>{price(m.priceMinor, m.currency, locale)}</bdi></strong>
                </div>
              </>
            );
            return acceptsOrders(site) ? <a key={m.id} className="dish-card" href={ctx.links.order}>{inner}</a> : <article key={m.id} className="dish-card">{inner}</article>;
          })}
        </div>
      </section>
    </>
  );
}

function SmashMenu({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale, t } = ctx;
  if (!site.menuHighlights.length) return null;
  return (
    <section className="bg-main" aria-labelledby={`h-${s.id}`}>
      <div className="bg-menu-group">
        <div className="bg-section-head">
          <div><small>{loc(s.content.eyebrow, locale) || t('studio.site.menu')}</small><h2 id={`h-${s.id}`} className="bg-section-title">{heading(s, ctx, 'studio.site.favourites')}</h2></div>
          {loc(s.content.body, locale) && <p>{loc(s.content.body, locale)}</p>}
        </div>
        <div className="bg-grid">
          {site.menuHighlights.map((m) => {
            const name = pickName(locale, m.name, m.nameAr);
            const desc = pickName(locale, m.description, m.descriptionAr);
            return (
              <article key={m.id} className="bg-card">
                <div className="bg-art"><PublicDishImage url={m.imageUrl} srcSet={dishSrcSet(m)} sizes={DISH_SIZES.storefrontCard} name={name} englishName={m.name} /></div>
                <div className="bg-body">
                  <div className="bg-tagrow">{m.dietary.includes('vegetarian') && <span className="bg-tag veg">{t('studio.site.veggie')}</span>}</div>
                  <h3>{name}</h3>
                  {desc && <p>{desc}</p>}
                  <div className="bg-foot">
                    <span className="bg-price">{price(m.priceMinor, m.currency, locale)}</span>
                    {acceptsOrders(site) && <a className="bg-add" href={ctx.links.order}><span aria-hidden>+</span> {t('studio.site.order')}</a>}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function Gallery({ s, ctx }: { s: Section; ctx: Ctx }) {
  const items = s.content.gallery ?? [];
  if (!items.length) return null;
  return (
    <section className="consumer-main site-gallery" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.gallery')}</h2>
      <div className="site-gallery-grid">{items.map((m, i) => <img key={i} src={m.url} alt={altOf(m, ctx.locale)} loading="lazy" />)}</div>
    </section>
  );
}

function Invitation({ s, ctx, kind }: { s: Section; ctx: Ctx; kind: 'reservations' | 'ordering' }) {
  const { locale, t, links, site } = ctx;
  const arrow = locale === 'ar' ? '↖' : '↗';
  const pickup = site.branches.some((b) => b.acceptsPickup), delivery = site.branches.some((b) => b.acceptsDelivery);
  return (
    <section className={`restaurant-invitation site-${kind}`} aria-labelledby={`h-${s.id}`}>
      <span className="overline">{loc(s.content.eyebrow, locale) || t(kind === 'reservations' ? 'studio.site.reserveEyebrow' : 'studio.site.orderEyebrow')}</span>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, kind === 'reservations' ? 'studio.site.reserveTitle' : 'studio.site.orderTitle')}</h2>
      <p>{loc(s.content.body, locale) || t(kind === 'reservations' ? 'studio.site.reserveBody' : pickup && delivery ? 'studio.site.orderBodyBoth' : delivery ? 'studio.site.orderBodyDelivery' : 'studio.site.orderBodyPickup')}</p>
      <div className="site-ctas">
        {kind === 'reservations'
          ? <a className="primary button" href={links.reserve}><span className="button-label">{loc(s.content.ctaLabel, locale) || t('studio.site.reserveCta')}{' '}<span aria-hidden>{arrow}</span></span></a>
          : <a className="primary button" href={links.order}><span className="button-label">{loc(s.content.ctaLabel, locale) || t('studio.site.orderCta')}{' '}<span aria-hidden>{arrow}</span></span></a>}
      </div>
    </section>
  );
}

function HoursList({ hours, ctx }: { hours: ReturnType<typeof openingHours>; ctx: Ctx }) {
  if (!hours.length) return <p className="fine">{ctx.t('studio.site.hoursUnknown')}</p>;
  return (
    <dl className="site-hours">
      {DAY_KEYS.map((d, i) => {
        const slots = hours.filter((h) => h.day === i);
        return (
          <div key={d}>
            <dt>{ctx.t(`studio.site.day.${d}`)}</dt>
            <dd>{slots.length ? slots.map((h) => `${clock(h.opens, ctx.locale)} – ${clock(h.closes, ctx.locale)}`).join(', ') : ctx.t('studio.site.closed')}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Location({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale, t } = ctx;
  if (!site.branches.length) return null;
  return (
    <section className="consumer-main site-location" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, site.branches.length > 1 ? 'studio.site.locationsTitle' : 'studio.site.locationTitle')}</h2>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      <div className="site-branches">
        {site.branches.map((b) => {
          const sf = (site.storefronts ?? []).find((x) => x.branchId === b.id);
          return (
          <article key={b.id} className={`site-branch${sf ? ' has-storefront' : ''}`} style={sf ? ({ '--sf-primary': sf.primaryColor, '--sf-accent': sf.accentColor } as CSSProperties) : undefined}>
            <h3>{sf ? pickName(locale, sf.name, sf.nameAr) : pickName(locale, b.name, b.nameAr)}</h3>
            {sf && loc(sf.tagline, locale) && <p className="site-branch-tagline">{loc(sf.tagline, locale)}</p>}
            {sf && <p><a className="site-link site-storefront-cta" href={storefrontHref(ctx, sf.path)}>{t('studio.site.visit', { name: pickName(locale, sf.name, sf.nameAr) })} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span></a></p>}
            {(b.address || b.city) && <p>{[b.address, b.city].filter(Boolean).join(', ')}</p>}
            {b.phone && <p><a href={`tel:${b.phone.replace(/[^+\d]/g, '')}`} dir="ltr">{b.phone}</a></p>}
            {b.latitude !== null && b.longitude !== null && (
              <p><a className="site-link" href={`https://www.openstreetmap.org/?mlat=${b.latitude}&mlon=${b.longitude}#map=17/${b.latitude}/${b.longitude}`} rel="noopener noreferrer" target="_blank">{t('studio.site.directions')} <span aria-hidden>↗</span></a></p>
            )}
            <ul className="site-services">
              {b.acceptsDineIn && <li>{t('studio.site.dineIn')}</li>}
              {b.acceptsPickup && <li>{t('studio.site.pickup')}</li>}
              {b.acceptsDelivery && <li>{t('studio.site.delivery')}</li>}
              {b.acceptsReservations && <li>{t('studio.site.reservable')}</li>}
            </ul>
            <HoursList hours={openingHours(b.openingHours)} ctx={ctx} />
          </article>
          );
        })}
      </div>
    </section>
  );
}

function HoursSection({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale } = ctx;
  if (!site.branches.length) return null;
  return (
    <section className="consumer-main site-location" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.hoursTitle')}</h2>
      <div className="site-branches">
        {site.branches.map((b) => (
          <article key={b.id} className="site-branch">
            {site.branches.length > 1 && <h3>{pickName(locale, b.name, b.nameAr)}</h3>}
            <HoursList hours={openingHours(b.openingHours)} ctx={ctx} />
          </article>
        ))}
      </div>
    </section>
  );
}

function Quotes({ s, ctx }: { s: Section; ctx: Ctx }) {
  const items = (s.content.items ?? []).filter((i) => loc(i.title, ctx.locale));
  if (!items.length) return null;
  return (
    <section className="consumer-main site-quotes" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.quotesTitle')}</h2>
      <div className="site-quote-grid">
        {items.map((q, i) => (
          <figure key={i} className="site-quote">
            <blockquote>{loc(q.title, ctx.locale)}</blockquote>
            {loc(q.body, ctx.locale) && <figcaption>{loc(q.body, ctx.locale)}</figcaption>}
          </figure>
        ))}
      </div>
    </section>
  );
}

function Contact({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale } = ctx;
  const phones = site.branches.filter((b) => b.phone);
  return (
    <section className="consumer-main site-contact" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.contactTitle')}</h2>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      {phones.length > 0 && (
        <ul className="site-services">
          {phones.map((b) => <li key={b.id}>{pickName(locale, b.name, b.nameAr)} · <a href={`tel:${b.phone!.replace(/[^+\d]/g, '')}`} dir="ltr">{b.phone}</a></li>)}
        </ul>
      )}
    </section>
  );
}

function Custom({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale } = ctx;
  if (!loc(s.content.headline, locale) && !loc(s.content.body, locale) && !s.content.media) return null;
  return (
    <section className="consumer-main restaurant-introduction site-custom" aria-labelledby={`h-${s.id}`}>
      <div>
        {loc(s.content.eyebrow, locale) && <span className="overline">{loc(s.content.eyebrow, locale)}</span>}
        {loc(s.content.headline, locale) && <h2 id={`h-${s.id}`}>{loc(s.content.headline, locale)}</h2>}
        {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      </div>
      {s.content.media && <img className="dish-photo" src={s.content.media.url} alt={altOf(s.content.media, ctx.locale)} loading="lazy" />}
    </section>
  );
}

// --- 21-STUDIO section kinds ----------------------------------------------------------------------------------------

/** "Code EID15 · 15% off" for a live promotion (the badge text an offer or banner shows). */
function PromoChip({ ctx, s }: { ctx: Ctx; s: Section }) {
  const p = s.content.promotion;
  if (!p) return null;
  return (
    <p className="site-promo-chip">
      <strong>{promotionLabel(p, ctx.site.org.currency, ctx.locale, ctx.t)}</strong>
      {p.code && <> · {ctx.t('studio.site.useCode')} <code dir="ltr">{p.code}</code></>}
    </p>
  );
}

function PromoBanner({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale, t, site } = ctx;
  const headline = loc(s.content.headline, locale);
  if (!headline && !loc(s.content.body, locale) && !s.content.promotion) return null;
  const badge = loc(s.content.badge, locale);
  return (
    <section className="site-promo" aria-labelledby={`h-${s.id}`}>
      <div className="site-promo-copy">
        {badge && <span className="site-badge">{badge}</span>}
        <h2 id={`h-${s.id}`}>{headline || (s.content.promotion ? pickName(locale, s.content.promotion.name, s.content.promotion.nameAr) : t('studio.site.offersTitle'))}</h2>
        {loc(s.content.body, locale) && <p>{loc(s.content.body, locale)}</p>}
        <PromoChip ctx={ctx} s={s} />
        {acceptsOrders(site) && <a className="primary button" href={ctx.links.order}><span className="button-label">{loc(s.content.ctaLabel, locale) || t('studio.site.orderCta')}</span></a>}
      </div>
      {s.content.media && <img src={s.content.media.url} alt={altOf(s.content.media, ctx.locale)} loading="lazy" />}
    </section>
  );
}

function OfferCard({ p, ctx, fallback }: { p: PublicSiteProduct; ctx: Ctx; fallback: string | null }) {
  const { locale, t, site } = ctx;
  const name = pickName(locale, p.name, p.nameAr);
  const pct = discountPercent(p);
  const inner = (
    <>
      <DishImage url={p.imageUrl} srcSet={dishSrcSet(p)} sizes={DISH_SIZES.siteCard} name={name} englishName={p.name} />
      {(pct !== null || fallback) && <span className="site-badge site-badge-float">{pct !== null ? t('studio.site.percentOff', { pct }) : fallback}</span>}
      <div className="dish-body">
        <h3>{name}</h3>
        <p className="site-offer-price">
          <strong><bdi>{price(p.priceMinor, p.currency, locale)}</bdi></strong>
          {pct !== null && <s><span className="sr-only">{t('studio.site.was')} </span><bdi>{price(p.compareAtMinor!, p.currency, locale)}</bdi></s>}
        </p>
      </div>
    </>
  );
  return acceptsOrders(site) ? <a className="dish-card site-offer" href={ctx.links.order}>{inner}</a> : <article className="dish-card site-offer">{inner}</article>;
}

function Offers({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale, t, site } = ctx;
  const products = s.content.products ?? [];
  if (!products.length && !s.content.promotion) return null;
  const promo = s.content.promotion ? promotionLabel(s.content.promotion, site.org.currency, locale, t) : null;
  const badge = loc(s.content.badge, locale);
  return (
    <section className="consumer-main site-offers" aria-labelledby={`h-${s.id}`}>
      <div className="site-section-head">
        <div>
          {badge && <span className="site-badge">{badge}</span>}
          <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.offersTitle')}</h2>
        </div>
        {acceptsOrders(site) && <a className="site-link" href={ctx.links.order}>{t('studio.site.fullMenu')} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span></a>}
      </div>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      <PromoChip ctx={ctx} s={s} />
      {products.length > 0 && <div className="dish-grid">{products.map((p) => <OfferCard key={p.id} p={p} ctx={ctx} fallback={promo} />)}</div>}
    </section>
  );
}

const SOCIAL_LOGO: Partial<Record<SocialNetwork, string>> = {
  instagram: '/brand/providers/instagram.svg', facebook: '/brand/providers/facebook.svg', tiktok: '/brand/providers/tiktok.svg',
  snapchat: '/brand/providers/snapchat.svg', whatsapp: '/brand/providers/whatsapp.svg', google_maps: '/brand/providers/google-maps.svg',
};
const SOCIAL_MARK: Record<SocialNetwork, string> = { instagram: 'IG', facebook: 'f', tiktok: 'TT', x: 'X', snapchat: 'SC', whatsapp: 'WA', google_maps: '⌖', website: '⌂' };

function Social({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale, t, site } = ctx;
  const links = site.org.socialLinks ?? {};
  const networks = SOCIAL_NETWORKS.filter((n) => links[n]);
  if (!networks.length) return null;
  return (
    <section className="consumer-main site-social" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.socialTitle')}</h2>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      <ul className="site-social-list">
        {networks.map((n) => (
          <li key={n}>
            <a href={links[n]} target="_blank" rel="noopener noreferrer nofollow" aria-label={t('core.guest.social.open', { network: t(`core.guest.social.${n}`) })}>
              {SOCIAL_LOGO[n] ? <img src={SOCIAL_LOGO[n]} alt="" aria-hidden width={20} height={20} /> : <span className="site-social-mark" aria-hidden>{SOCIAL_MARK[n]}</span>}
              <span>{t(`core.guest.social.${n}`)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Questions and answers as native disclosure widgets: the text is in the page for guests, search and answer engines. */
function Faq({ s, ctx }: { s: Section; ctx: Ctx }) {
  const items = (s.content.items ?? []).filter((i) => loc(i.title, ctx.locale) && loc(i.body, ctx.locale));
  if (!items.length) return null;
  return (
    <section className="consumer-main site-faq" aria-labelledby={`h-${s.id}`}>
      <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.faqTitle')}</h2>
      {loc(s.content.body, ctx.locale) && <p className="site-prose">{loc(s.content.body, ctx.locale)}</p>}
      <div className="site-faq-list">
        {items.map((q, i) => (
          <details key={i} className="site-faq-item" open={i === 0}>
            <summary>{loc(q.title, ctx.locale)}</summary>
            <p>{loc(q.body, ctx.locale)}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/** The whole menu as text by category (what answer engines read); ordering stays on the live menu page. */
function FullMenu({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { locale, t, site } = ctx;
  const groups = (s.content.menu ?? []).filter((g) => g.items.length);
  if (!groups.length) return null;
  return (
    <section className="consumer-main site-full-menu" aria-labelledby={`h-${s.id}`}>
      <div className="site-section-head">
        <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.menuFullTitle')}</h2>
        {acceptsOrders(site) && <a className="site-link" href={ctx.links.order}>{t('studio.site.orderCta')} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span></a>}
      </div>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      {groups.map((g) => (
        <section key={g.id} className="site-menu-group" aria-labelledby={`h-${s.id}-${g.id}`}>
          <h3 id={`h-${s.id}-${g.id}`}>{pickName(locale, g.name, g.nameAr)}</h3>
          <ul className="site-menu-list">
            {g.items.map((p) => {
              const desc = pickName(locale, p.description, p.descriptionAr);
              const pct = discountPercent(p);
              return (
                <li key={p.id}>
                  <div><strong>{pickName(locale, p.name, p.nameAr)}</strong>{desc && <p>{desc}</p>}</div>
                  <span className="site-menu-price">
                    <bdi>{price(p.priceMinor, p.currency, locale)}</bdi>
                    {pct !== null && <s><span className="sr-only">{t('studio.site.was')} </span><bdi>{price(p.compareAtMinor!, p.currency, locale)}</bdi></s>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
