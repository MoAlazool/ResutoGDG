'use client';
import { useParams } from 'next/navigation';
import { TableBill } from '../TableBill';

/** Split the table bill: the bill page with the split chooser open (legacy splitChooser()/splitForm()). */
export default function SplitBillPage() {
  const { qr } = useParams<{ qr: string }>();
  return <TableBill qr={qr} startSplit />;
}
