'use client';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Code, EmptyState, Notice, PageHeader, SelectField, Skeleton } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { actionLabel, entityLabel, sourceLabel } from '@/lib/vocab';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


interface Entry {
  id: number; branch_id: string | null; actor_type: string; actor_id: string | null; action: string; entity_type: string | null;
  entity_id: string | null; source: string; metadata: Record<string, unknown>; created_at: string;
}

const STR = {
  en: {
    title: 'Activity log', subtitle: 'Every change made by staff, AI connections, Resuto support and automated jobs. Entries cannot be edited.',
    entity: 'Type', all: 'All activity', when: 'When', who: 'Who', what: 'What', details: 'Details', more: 'Load older activity', loading: 'Loading…',
    empty: 'No activity recorded yet.', error: 'Could not load the activity log.', retry: 'Retry', end: 'You have reached the beginning of the log.',
    actor_user: 'Staff', actor_system: 'System', actor_platform_admin: 'Resuto support', actor_mcp_client: 'AI connection', actor_guest: 'Guest', actor_integration: 'Integration', actor_driver: 'Driver', actor_device: 'POS device',
    e_organization: 'Restaurant', e_branch: 'Branches', e_membership: 'Team', e_invitation: 'Invitations', e_subscription: 'Billing', e_order: 'Orders',
    e_entitlement_override: 'Module grants', e_payment: 'Payments', e_menu: 'Menu', e_product: 'Products', e_legacy: 'Legacy import',
  },
  ar: {
    title: 'سجل النشاط', subtitle: 'كل تغيير قام به الموظفون واتصالات الذكاء الاصطناعي ودعم ريسوتو والمهام التلقائية. لا يمكن تعديل السجلات.',
    entity: 'النوع', all: 'كل النشاط', when: 'الوقت', who: 'من', what: 'ماذا', details: 'التفاصيل', more: 'تحميل نشاط أقدم', loading: 'جارٍ التحميل…',
    empty: 'لا يوجد نشاط مسجّل بعد.', error: 'تعذّر تحميل سجل النشاط.', retry: 'إعادة المحاولة', end: 'وصلت إلى بداية السجل.',
    actor_user: 'موظف', actor_system: 'النظام', actor_platform_admin: 'دعم ريسوتو', actor_mcp_client: 'اتصال ذكاء اصطناعي', actor_guest: 'ضيف', actor_integration: 'تكامل', actor_driver: 'سائق', actor_device: 'جهاز نقاط بيع',
    e_organization: 'المطعم', e_branch: 'الفروع', e_membership: 'الفريق', e_invitation: 'الدعوات', e_subscription: 'الفوترة', e_order: 'الطلبات',
    e_entitlement_override: 'منح الوحدات', e_payment: 'المدفوعات', e_menu: 'القائمة', e_product: 'المنتجات', e_legacy: 'استيراد قديم',
  },
};
const ENTITY_TYPES = ['organization', 'branch', 'membership', 'invitation', 'subscription', 'entitlement_override', 'order', 'payment', 'menu', 'product', 'legacy'] as const;
const TONE: Record<string, 'info' | 'pay' | 'warn' | 'neutral'> = { platform_admin: 'pay', mcp_client: 'info', system: 'neutral', user: 'neutral' };

export default function AuditPage() {
  const { locale, t } = useT();
  const s = STR[locale];
  const { org, can } = useOrg();
  const { call, ready, token } = useSession();
  const [entityType, setEntityType] = useState('');
  const [items, setItems] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async (before: string | null) => {
    setLoading(true); setError(false);
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (before) q.set('before', before);
      if (entityType) q.set('entityType', entityType);
      const r = await call<{ items: Entry[]; nextCursor: string | null }>(`/o/${org.id}/audit?${q}`);
      setItems((prev) => (before ? [...(prev ?? []), ...r.items] : r.items));
      setCursor(r.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [call, org.id, entityType]);
  useEffect(() => { if (ready && token) void load(null); }, [load, ready, token]);

  if (!can('audit:read')) return <><PageHeader title={s.title} /><Notice tone="warn">{s.error}</Notice></>;
  const actor = (t: string) => (s as Record<string, string>)[`actor_${t}`] ?? t;
  return (
    <div style={FIT}>
      <PageHeader title={s.title} subtitle={s.subtitle} actions={
        <div style={{ minWidth: 200 }}>
          <SelectField label={s.entity} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">{s.all}</option>
            {ENTITY_TYPES.map((t) => <option key={t} value={t}>{(s as Record<string, string>)[`e_${t}`] ?? t}</option>)}
          </SelectField>
        </div>
      } />
      {error && <div className="mbe-12"><Notice tone="danger">{s.error} <button className="btn btn-sm" onClick={() => void load(null)}>{s.retry}</button></Notice></div>}
      {!items ? <Card><Skeleton lines={6} /></Card> : !items.length ? <Card><EmptyState title={s.empty} /></Card> : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{s.when}</th><th>{s.who}</th><th>{s.what}</th><th>{s.details}</th></tr></thead>
            <tbody>
              {items.map((e) => (
                <tr key={e.id}>
                  <td className="num nowrap">{dateTime(e.created_at, locale, undefined)}</td>
                  <td><Badge tone={TONE[e.actor_type] ?? 'neutral'}>{actor(e.actor_type)}</Badge>{e.source !== 'api' && <span className="fine"> · {sourceLabel(t, e.source)}</span>}</td>
                  <td title={e.action}>{actionLabel(t, e.action) ?? <Code>{e.action}</Code>}
                    {e.entity_type && <div className="fine">{entityLabel(t, e.entity_type)}{e.entity_id && <> · <Code>{e.entity_id.slice(0, 8)}</Code></>}</div>}</td>
                  <td>
                    {Object.keys(e.metadata ?? {}).length > 0 && (
                      <>
                        <button className="btn btn-ghost btn-sm" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? '−' : '+'}</button>
                        {open === e.id && <pre dir="ltr" style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', maxWidth: 420 }}>{JSON.stringify(e.metadata, null, 2)}</pre>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="row" style={{ justifyContent: 'center', marginBlockStart: 16 }}>
          {cursor ? <button className="btn" disabled={loading} onClick={() => void load(cursor)}>{loading ? s.loading : s.more}</button> : <span className="fine">{s.end}</span>}
        </div>
      )}
    </div>
  );
}
