'use client';
import Link from 'next/link';
import { Sheet } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import styles from '../payments.module.css';
import { PaymentDetail } from './PaymentDetail';

/** The payment inspector on the list (lazy chunk): the payment, its refund history and the refund form in a Sheet. */
export function PaymentSheet({ paymentId, onClose, onChanged }: { paymentId: string | null; onClose: () => void; onChanged: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  return (
    <Sheet open={!!paymentId} onClose={onClose} title={t('pay.detail.title')} size="lg" className="payment-sheet"
      footer={paymentId ? (
        <div className={styles.sheetFoot}>
          <Link href={`/dashboard/${org.id}/payments/${paymentId}`}>{t('pay.sheet.openFull')}</Link>
          <button type="button" className="btn" onClick={onClose}>{t('action.close')}</button>
        </div>
      ) : undefined}>
      {paymentId && <PaymentDetail paymentId={paymentId} onChanged={onChanged} />}
    </Sheet>
  );
}
