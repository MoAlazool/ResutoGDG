import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import type { PublicTableView } from '@resuto/contracts';
import { plausible, requestStartedAt, serverRead } from '@/components/guest/server';
import { qrOutcome } from './qr-outcome';

/**
 * Unknown QR code → HTTP 404 with the branded not-found page (CR-03). The check runs here, before any HTML streams
 * (the route has no loading boundary: PERF-01, see page.tsx); the page's identical lookup is served from the same
 * request cache. Only an explicit 404 counts: when the API cannot be reached the page renders and retries in the browser.
 *
 * A venue (counter) QR printed by the legacy app also lives at /t/<token>: it opens the branch's counter page /v/<token>
 * (FT-07: that guest's own counter order) or, for a branch that no longer serves at a counter, its ordering page,
 * resolved by the API from the migration's token map (CR-13). When that lookup fails temporarily (rate limited, API
 * down) the guest gets the area's branded "try again" error, never a 404 for a valid printed code.
 */
export default async function TableLayout({ children, params }: { children: ReactNode; params: Promise<{ qr: string }> }) {
  requestStartedAt();   // the guest menu budget counts from here (components/guest/server.ts)
  const { qr } = await params;
  if (!plausible(qr) || !/^[A-Za-z0-9_-]{16,128}$/.test(qr)) notFound();
  const table = await serverRead<PublicTableView>(`/public/tables/${encodeURIComponent(qr)}`, { revalidate: 15, tags: [`table:${qr}`] });
  const venue = table.status === 'missing'
    ? await serverRead<{ path: string }>(`/public/venue/${encodeURIComponent(qr)}`, { revalidate: 300, tags: [`venue:${qr}`] })
    : undefined;
  const outcome = qrOutcome(table.status, venue);
  if (outcome.kind === 'venue') redirect(outcome.path);
  if (outcome.kind === 'missing') notFound();
  if (outcome.kind === 'unavailable') throw new Error('This code could not be checked right now. Please try again in a moment.');   // → app/t/error.tsx
  return children;
}
