import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { PublicTableView } from '@resuto/contracts';
import { plausible, serverRead } from '@/components/guest/server';

/**
 * Unknown QR code → HTTP 404 with the branded not-found page (CR-03). The check runs here, outside the route's loading
 * boundary, so the status is decided before any HTML streams; the page's identical lookup is served from the same
 * request cache. Only an explicit 404 counts: when the API cannot be reached the page renders and retries in the browser.
 */
export default async function TableLayout({ children, params }: { children: ReactNode; params: Promise<{ qr: string }> }) {
  const { qr } = await params;
  if (!plausible(qr) || !/^[A-Za-z0-9_-]{16,128}$/.test(qr)) notFound();
  const table = await serverRead<PublicTableView>(`/public/tables/${encodeURIComponent(qr)}`, { revalidate: 15, tags: [`table:${qr}`] });
  if (table.status === 'missing') notFound();
  return children;
}
