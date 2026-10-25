'use client';
// The view-only digital menu (21-ONB): the consumer shell and menu browser of the ordering pages with ordering turned
// off. There is no cart, no dock, no assistant, no checkout and no table or visit session: nothing here can place an
// order. Dish details (photo, description, allergens, options) open in the same sheet, read-only.
import { useEffect, useRef, useState } from 'react';
import type { PublicMenu, PublicMenuProduct } from '@resuto/contracts';
import { MenuBrowser, ProductSheet, type Cart } from '@/components/guest/menu';
import { ConsumerFooter, ConsumerHeader, Cover } from '@/components/guest/shell';
import { MenuSkeleton } from '@/components/guest/skeleton';
import { SocialIcons } from '@/components/guest/SocialIcons';
import { api, ApiRequestError } from '@/lib/api';
import { useFunnel } from '@/lib/funnel-beacon';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import './menu-only.css';

/** MenuBrowser shows in-cart counts; a view-only menu has no cart, so this one is always empty and ignores writes. */
const NO_CART: Cart = {
  items: [], count: 0,
  add() {}, addMany() {}, setQty() {}, clear() {},
  lines: () => [],
};
const noop = () => {};

export function MenuOnlyExperience({ slug, branchCode, initialMenu }: { slug: string; branchCode?: string; initialMenu: PublicMenu | null }) {
  const { t, locale } = useT();
  const [branch, setBranch] = useState<string | undefined>(branchCode);
  const [menu, setMenu] = useState<PublicMenu | null>(initialMenu);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<PublicMenuProduct | null>(null);
  const first = useRef(true);
  // First-party funnel page view (21-CRM). The menu QR link carries no marker, so it counts as a visit, not a QR scan.
  useFunnel('m', slug, { branchId: menu?.branch.id });

  // Server-rendered for the requested branch; another branch (or a slow or failed server read) loads here.
  useEffect(() => {
    if (first.current && initialMenu && branch === branchCode) { first.current = false; return; }
    first.current = false;
    setMenu(null);
    setError(null);
    api<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`)
      .then(setMenu).catch((e) => setError((e as ApiRequestError).status === 404 ? t('core.web.notFound') : t('core.guest.menuUnavailable')));
  }, [slug, branch, branchCode, initialMenu, t]);

  const org = menu?.org ?? null;
  const b = menu?.branch ?? null;
  // The header links to the restaurant's site only through its slug; a menu-only restaurant may have none, so omit it.
  const shellOrg = org ? { name: org.name, nameAr: org.nameAr } : null;

  return (
    <div className="gx gx-menu-only">
      <ConsumerHeader org={shellOrg} branch={b} menuHref={null} reserveHref={null} />
      <Cover image={null} overline={org ? pick(locale, org.name, org.nameAr) : ''} title={t('core.guest.menuOnly.title')} body={t('core.guest.menuOnly.body')} />
      <main className="gx-main">
        {error && <div className="gx-note is-danger" role="alert">{error}</div>}
        {menu && b ? (
          <>
            <div className="gx-context">
              <span>◉ {menu.branches.length > 1 ? (
                <select value={b.code} onChange={(e) => setBranch(e.target.value)} aria-label={t('core.web.branch')}
                  style={{ border: 0, background: 'transparent', font: 'inherit', color: 'inherit', padding: 0 }}>
                  {menu.branches.map((x) => <option key={x.id} value={x.code}>{pick(locale, x.name, x.nameAr)}</option>)}
                </select>
              ) : pick(locale, b.name, b.nameAr)}</span>
              <span>{t('core.guest.menuOnly.note')}</span>
            </div>
            <MenuBrowser menu={menu} cart={NO_CART} onOpen={setProduct} ordering={false} />
          </>
        ) : !error && <><p className="gx-fine" role="status">{t('core.guest.shell.loading')}</p><MenuSkeleton /></>}
        {/* Icons with the network's name; only https links on each network's own hosts (checked again inside). */}
        <SocialIcons links={org?.socialLinks} t={t} className="gx-social" withNames />
      </main>
      <ConsumerFooter org={shellOrg} />
      {product && menu && (
        <ProductSheet product={product} currency={menu.org.currency} ordering={false} onClose={() => setProduct(null)} onAdd={noop} />
      )}
    </div>
  );
}
