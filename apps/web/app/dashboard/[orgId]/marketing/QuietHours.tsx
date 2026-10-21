'use client';
// Marketing > quiet hours for email / SMS campaigns (INT-28). Times are in the restaurant's time zone.
import { useEffect, useState } from 'react';
import { Card, Notice, Skeleton, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Policy { quietHoursStart: string | null; quietHoursEnd: string | null; timezone: string; isDefault: boolean }

export function QuietHours() {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const policy = useApi<Policy>(`/o/${org.id}/messaging/policy`);
  const [form, setForm] = useState<{ on: boolean; start: string; end: string }>({ on: true, start: '22:00', end: '09:00' });
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const p = policy.data;
    if (p) setForm({ on: p.quietHoursStart !== null, start: p.quietHoursStart ?? '22:00', end: p.quietHoursEnd ?? '09:00' });
  }, [policy.data]);
  const save = useAction(async () => {
    await session.call(`/o/${org.id}/messaging/policy`, { method: 'PUT', body: form.on ? { quietHoursStart: form.start, quietHoursEnd: form.end } : { quietHoursStart: null, quietHoursEnd: null } });
    setSaved(true);
    await policy.reload();
  });
  if (policy.error) return <Notice tone="danger">{policy.error.message}</Notice>;
  if (!policy.data) return <Skeleton lines={2} />;
  const editable = can('marketing:write');
  return (
    <Card title={t('marketing.quiet.title')}>
      <div className="stack" data-testid="quiet-hours">
        <p className="fine">{t('marketing.quiet.body', { tz: policy.data.timezone })}</p>
        {policy.data.isDefault && <p className="fine">{t('marketing.quiet.default')}</p>}
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={!form.on} disabled={!editable} onChange={(e) => { setSaved(false); setForm({ ...form, on: !e.target.checked }); }} />
          {t('marketing.quiet.off')}
        </label>
        {form.on && (
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label className="stack" style={{ gap: 4 }}>{t('marketing.quiet.start')}
              <input type="time" dir="ltr" className="input" value={form.start} disabled={!editable} onChange={(e) => { setSaved(false); setForm({ ...form, start: e.target.value }); }} /></label>
            <label className="stack" style={{ gap: 4 }}>{t('marketing.quiet.end')}
              <input type="time" dir="ltr" className="input" value={form.end} disabled={!editable} onChange={(e) => { setSaved(false); setForm({ ...form, end: e.target.value }); }} /></label>
          </div>
        )}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {saved && <Notice tone="ok">{t('marketing.quiet.saved')}</Notice>}
        {editable && <div><button className="btn btn-primary" disabled={save.pending} onClick={() => void save.run()}>{t('marketing.quiet.save')}</button></div>}
      </div>
    </Card>
  );
}
