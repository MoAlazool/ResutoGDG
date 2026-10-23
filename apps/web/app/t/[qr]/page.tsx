import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import type { PublicMenu, PublicTableView } from '@resuto/contracts';
import { GUEST_MENU_BUDGET_MS, plausible, serverRead, within } from '@/components/guest/server';
import { TableExperience } from './_guest/TableExperience';

export const metadata: Metadata = { title: 'Menu', robots: { index: false, follow: false } };

/**
 * QR table page. The restaurant and table come from the read-only lookup (no session is opened here) and the menu
 * from the public menu (cached 30 s per branch), both while the HTML is rendered (PCL-08). An unknown QR code is a real
 * 404 with the branded not-found page (CR-03). If the API cannot be reached the page still renders and loads in the
 * browser.
 *
 * There is deliberately no loading.tsx on this route (PERF-01): content streamed behind a loading fallback is revealed
 * by React's batched timer, which a repeat visit's cached JavaScript delays until hydration has finished (the heading
 * painted at ~1.6 s instead of with the first paint). The table read is already awaited by the layout, so the page adds
 * only the shared, cached menu read; one slower than GUEST_MENU_BUDGET_MS renders the menu skeleton and loads in the
 * browser (scripts/perf/guest-shell.mjs checks the HTML).
 */
export default async function TablePage({ params }: { params: Promise<{ qr: string }> }) {
  const { qr } = await params;
  if (!plausible(qr) || !/^[A-Za-z0-9_-]{16,128}$/.test(qr)) notFound();
  // Cached briefly: the session call (in the browser) is what decides whether ordering can start.
  const table = await serverRead<PublicTableView>(`/public/tables/${encodeURIComponent(qr)}`, { revalidate: 15, tags: [`table:${qr}`] });
  if (table.status === 'missing') notFound();
  const t = table.status === 'ok' ? table.data : null;
  const menu = t ? await within(serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(t.org.slug)}?branch=${encodeURIComponent(t.branch.code)}`,
    { revalidate: 30, tags: [`menu:${t.org.slug}`] }), GUEST_MENU_BUDGET_MS) : null;
  // The restaurant's own cover, when it has one (never a stock or another restaurant's photo).
  if (t?.cover) preload(t.cover, { as: 'image', fetchPriority: 'high' });
  return <TableExperience qr={qr} table={t} initialMenu={menu?.status === 'ok' ? menu.data : null} />;
}
