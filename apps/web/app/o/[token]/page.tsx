import type { Metadata } from 'next';
import { OrderingClient } from './OrderingClient';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

/** Hosted ordering page opened from the WhatsApp ordering link (single-use bearer token). */
export default async function HostedOrderingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <OrderingClient token={token} />;
}
