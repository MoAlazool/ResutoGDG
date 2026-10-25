'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Card, PageHeader } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { PaymentDetail } from '../_ui/PaymentDetail';

/** One payment on its own page (links from alerts, refunds and receipts); the list opens the same view in a sheet. */
export default function PaymentDetailPage() {
  const { paymentId } = useParams<{ paymentId: string }>();
  const { t } = useT();
  const { org } = useOrg();
  return (
    <ModuleGate module="pay" permission="payments:read">
      <PageHeader overline={<Link href={`/dashboard/${org.id}/payments`}>← {t('pay.dash.title')}</Link>} title={t('pay.detail.title')} />
      <Card><PaymentDetail paymentId={paymentId} /></Card>
    </ModuleGate>
  );
}
