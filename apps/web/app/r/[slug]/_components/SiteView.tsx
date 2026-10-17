// Restaurant website renderer (server- and client-safe: no hooks). Ports the
// legacy guest home page ("olive", legacy/public/guest.js home + platform.css),
// the Smash & Co storefront ("smash", legacy/public/burger.js/css) and a
// lighter "minimal" variant, all driven by published Studio data.
import type { CSSProperties, ReactNode } from 'react';
import type { PublicSite, PublicSiteSection } from '@resuto/contracts';
import { LanguageToggle } from '@/lib/i18n/client';
import { acceptsOrders, acceptsReservations, clock, DAY_KEYS, loc, openingHours, pickName, price, type SiteLocale, type T } from './site-utils';
import './site.css';

type Section = PublicSiteSection;
interface Ctx { site: PublicSite; locale: SiteLocale; t: T; links: { order: string; reserve: string; home: string } }

export function SiteView({ site, locale, t, preview = false, hostLinks }: {
  site: PublicSite; locale: SiteLocale; t: T; preview?: boolean;
  /** On a custom domain the guest routes are host-relative. */
  hostLinks?: { order: string; reserve: string; home: string };
}) {
  const ctx: Ctx = { site, locale, t, links: hostLinks ?? { order: site.links.order, reserve: site.links.reserve, home: site.links.site } };
  const vars = {
    '--site-primary': site.theme.primaryColor,
    '--site-accent': site.theme.accentColor,
    '--site-bg': site.theme.backgroundColor,
  } as CSSProperties;
  const name = pickName(locale, site.org.name, site.org.nameAr);
  const body = site.sections.map((s) => <SectionView key={s.id} s={s} ctx={ctx} />);
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
          <span>{name}<small>{site.branches[0]?.city || ''}</small></span>
        </a>
        <nav aria-label={t('studio.site.nav')}>
          {acceptsOrders(site) && <a href={ctx.links.order}>{t('studio.site.menu')}</a>}
          {acceptsReservations(site) && <a href={ctx.links.reserve}>{t('studio.site.reservations')}</a>}
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
    <footer className={className}>
      <span>© {new Date().getFullYear()} {pickName(locale, site.org.name, site.org.nameAr)}{site.branches[0]?.city ? ` · ${site.branches[0].city}` : ''}</span>
      <a href="/">{t('studio.site.poweredBy')}</a>
    </footer>
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
      {order && <a className="primary button" href={links.order}>{label || t('studio.site.browseMenu')} <span aria-hidden>{arrow}</span></a>}
      {reserve && <a className="secondary button" href={links.reserve}>{t('studio.site.bookTable')}</a>}
    </div>
  );
}

function OliveHero({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale } = ctx;
  const img = s.content.media?.url ?? site.theme.heroUrl;
  const name = pickName(locale, site.org.name, site.org.nameAr);
  return (
    <section className={`restaurant-editorial${img ? '' : ' no-photo'}`} aria-labelledby={`h-${s.id}`}>
      {img && <img src={img} alt={s.content.media?.alt ?? ''} fetchPriority="high" />}
      <div>
        <span className="overline">{loc(s.content.eyebrow, locale) || name}</span>
        <h1 id={`h-${s.id}`}>{loc(s.content.headline, locale) || name}</h1>
        {loc(s.content.body, locale) && <p>{loc(s.content.body, locale)}</p>}
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
            <img src={img} alt={s.content.media?.alt ?? ''} fetchPriority="high" />
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
      {img ? <img className="dish-photo" src={img.url} alt={img.alt ?? ''} loading="lazy" /> : <span className="dish-photo dish-placeholder" aria-hidden>{pickName(locale, site.org.name, site.org.nameAr).slice(0, 1)}</span>}
    </section>
  );
}

function DishImage({ url, name }: { url: string | null; name: string }) {
  return url ? <img className="dish-photo" src={url} alt={name} loading="lazy" /> : <span className="dish-photo dish-placeholder" aria-hidden>{name.slice(0, 1)}</span>;
}

function OliveMenu({ s, ctx }: { s: Section; ctx: Ctx }) {
  const { site, locale, t } = ctx;
  if (!site.menuHighlights.length) return null;
  return (
    <section className="consumer-main" aria-labelledby={`h-${s.id}`}>
      <div className="site-section-head">
        <h2 id={`h-${s.id}`}>{heading(s, ctx, 'studio.site.menu')}</h2>
        {acceptsOrders(site) && <a className="site-link" href={ctx.links.order}>{t('studio.site.fullMenu')} <span aria-hidden>{locale === 'ar' ? '←' : '→'}</span></a>}
      </div>
      {loc(s.content.body, locale) && <p className="site-prose">{loc(s.content.body, locale)}</p>}
      <div className="dish-grid">
        {site.menuHighlights.map((m) => {
          const name = pickName(locale, m.name, m.nameAr);
          const desc = pickName(locale, m.description, m.descriptionAr);
          const inner = (
            <>
              <DishImage url={m.imageUrl} name={name} />
              <div className="dish-body">
                <h3>{name}</h3>
                {desc && <p>{desc}</p>}
                <strong>{price(m.priceMinor, m.currency, locale)}</strong>
              </div>
            </>
          );
          return acceptsOrders(site) ? <a key={m.id} className="dish-card" href={ctx.links.order}>{inner}</a> : <article key={m.id} className="dish-card">{inner}</article>;
        })}
      </div>
    </section>
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
                <div className="bg-art">{m.imageUrl ? <img src={m.imageUrl} alt={name} loading="lazy" /> : <span className="dish-placeholder" aria-hidden>{name.slice(0, 1)}</span>}</div>
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
      <div className="site-gallery-grid">{items.map((m, i) => <img key={i} src={m.url} alt={m.alt ?? ''} loading="lazy" />)}</div>
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
          ? <a className="primary button" href={links.reserve}>{loc(s.content.ctaLabel, locale) || t('studio.site.reserveCta')} <span aria-hidden>{arrow}</span></a>
          : <a className="primary button" href={links.order}>{loc(s.content.ctaLabel, locale) || t('studio.site.orderCta')} <span aria-hidden>{arrow}</span></a>}
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
        {site.branches.map((b) => (
          <article key={b.id} className="site-branch">
            <h3>{pickName(locale, b.name, b.nameAr)}</h3>
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
        ))}
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
      {s.content.media && <img className="dish-photo" src={s.content.media.url} alt={s.content.media.alt ?? ''} loading="lazy" />}
    </section>
  );
}
