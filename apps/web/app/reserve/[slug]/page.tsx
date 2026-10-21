import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicFloor, PublicMenu, ReservationSlotsView } from '@resuto/contracts';
import { GuestWordmark } from '@/components/brand/wordmark';
import { plausible, serverRead } from '@/components/guest/server';
import { getLocale } from '@/lib/i18n/server';
import { MetaPixel } from '@/lib/tracking/MetaPixel';
import { BookingExperience } from './BookingExperience';

export const metadata: Metadata = { title: 'Reserve a table' };

/**
 * Booking (legacy reservations.js): the restaurant, today's sittings in the branch time zone with free-table counts
 * and the floor plan are read while the HTML is rendered, so the first step is usable at first paint. An unknown
 * restaurant is a 404 (CR-03).
 */
export default async function ReservePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { slug } = await params;
  const { branch } = await searchParams;
  if (!plausible(slug)) notFound();
  const info = await serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}`, { revalidate: 30, tags: [`menu:${slug}`] });
  if (info.status === 'missing') notFound();
  const menu = info.status === 'ok' ? info.data : null;
  const bookable = menu?.branches.filter((b) => b.acceptsReservations) ?? [];
  const code = (typeof branch === 'string' && bookable.find((b) => b.code === branch)?.code) || bookable[0]?.code || null;
  const [slots, floor] = code ? await Promise.all([
    serverRead<ReservationSlotsView>(`/public/reservations/${encodeURIComponent(slug)}/slots?branch=${encodeURIComponent(code)}&partySize=2`),
    serverRead<PublicFloor>(`/public/floor/${encodeURIComponent(slug)}/${encodeURIComponent(code)}`, { revalidate: 60, tags: [`floor:${slug}`] }),
  ]) : [null, null];
  return (
    <>
      {/* Meta Pixel (INT-20): only after the guest agreed; renders nothing for restaurants that do not measure with Meta. */}
      <MetaPixel slug={slug} />
      <BookingExperience slug={slug} info={menu} branchCode={code} wordmark={<GuestWordmark locale={await getLocale()} />}
        initialSlots={slots?.status === 'ok' ? slots.data : null} initialFloor={floor?.status === 'ok' ? floor.data : null} />
    </>
  );
}
