'use client';
import { useParams } from 'next/navigation';
import { TableBill } from './TableBill';

/** Table bill (QR): Split & pay, share links and receipts (legacy guest.js billSheet()). */
export default function TableBillPage() {
  const { qr } = useParams<{ qr: string }>();
  return <TableBill qr={qr} />;
}
