'use client';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Code, DataTableV2, EmptyState, FilterBar, Notice, SelectField, Skeleton } from '@resuto/ui';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { entityLabel, sourceLabel } from '@/lib/vocab';
import { actionLabel } from '@/lib/vocab-codes';
import styles from './audit.module.css';

interface Entry {
  id: number; branch_id: string | null; actor_type: string; actor_id: string | null; action: string; entity_type: string | null;
  entity_id: string | null; source: string; metadata: Record<string, unknown>; created_at: string;
}

const STR = {
  en: {
    title: 'Activity log', subtitle: 'Every change made by staff, AI connections, Resuto support and automated jobs. Entries cannot be edited.',
    entity: 'Type', all: 'All activity', when: 'When', who: 'Who', what: 'What', details: 'Details', more: 'Load older activity', loading: 'Loading…',
    empty: 'No activity recorded yet.', error: 'Could not load the activity log.', retry: 'Retry', end: 'You have reached the beginning of the log.',
    show: 'Show details', hide: 'Hide details', table: 'Activity',
    actor_user: 'Staff', actor_system: 'System', actor_platform_admin: 'Resuto support', actor_mcp_client: 'AI connection', actor_guest: 'Guest', actor_integration: 'Integration', actor_driver: 'Driver', actor_device: 'POS device',
    e_organization: 'Restaurant', e_branch: 'Branches', e_membership: 'Team', e_invitation: 'Invitations', e_subscription: 'Billing', e_order: 'Orders',
    e_entitlement_override: 'Module grants', e_payment: 'Payments', e_menu: 'Menu', e_product: 'Products', e_legacy: 'Legacy import',
  },
  ar: {
    title: 'سجل النشاط', subtitle: 'كل تغيير قام به الموظفون واتصالات الذكاء الاصطناعي ودعم ريسوتو والمهام التلقائية. لا يمكن تعديل السجلات.',
    entity: 'النوع', all: 'كل النشاط', when: 'الوقت', who: 'من', what: 'ماذا', details: 'التفاصيل', more: 'تحميل نشاط أقدم', loading: 'جارٍ التحميل…',
    empty: 'لا يوجد نشاط مسجّل بعد.', error: 'تعذّر تحميل سجل النشاط.', retry: 'إعادة المحاولة', end: 'وصلت إلى بداية السجل.',
    show: 'عرض التفاصيل', hide: 'إخفاء التفاصيل', table: 'النشاط',
    actor_user: 'موظف', actor_system: 'النظام', actor_platform_admin: 'دعم ريسوتو', actor_mcp_client: 'اتصال ذكاء اصطناعي', actor_guest: 'ضيف', actor_integration: 'تكامل', actor_driver: 'سائق', actor_device: 'جهاز نقاط بيع',
    e_organization: 'المطعم', e_branch: 'الفروع', e_membership: 'الفريق', e_invitation: 'الدعوات', e_subscription: 'الفوترة', e_order: 'الطلبات',
    e_entitlement_override: 'منح الوحدات', e_payment: 'المدفوعات', e_menu: 'القائمة', e_product: 'المنتجات', e_legacy: 'استيراد قديم',
  },
};
const ENTITY_TYPES = ['organization', 'branch', 'membership', 'invitation', 'subscription', 'entitlement_override', 'order', 'payment', 'menu', 'product', 'legacy'] as const;
const TONE: Record<string, 'info' | 'pay' | 'warn' | 'neutral'> = { platform_admin: 'pay', mcp_client: 'info', system: 'neutral', user: 'neutral' };

/** The activity log on the SettingsPage template: a type filter, the entries (newest first) and older pages on demand. */
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
  useEffect(() => { if (ready && token && can('audit:read')) void load(null); }, [load, ready, token, can]);

  if (!can('audit:read')) return <SettingsShell header={{ title: s.title }}><Notice tone="warn">{s.error}</Notice></SettingsShell>;
  const actor = (a: string) => (s as Record<string, string>)[`actor_${a}`] ?? a;
  const entity = (e: string) => (s as Record<string, string>)[`e_${e}`] ?? e;
  return (
    <SettingsShell header={{ title: s.title, subtitle: s.subtitle }}>
      <FilterBar
        filters={(
          <SelectField label={s.entity} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">{s.all}</option>
            {ENTITY_TYPES.map((x) => <option key={x} value={x}>{entity(x)}</option>)}
          </SelectField>
        )}
        chips={entityType ? [{ key: 'type', label: `${s.entity}: ${entity(entityType)}`, onRemove: () => setEntityType('') }] : []} />
      {error && <Notice tone="danger">{s.error} <button className="btn btn-sm" onClick={() => void load(null)}>{s.retry}</button></Notice>}
      {!items ? <Card><Skeleton lines={6} /></Card> : (
        <DataTableV2 label={s.table} rows={items} rowKey={(e) => String(e.id)} busy={loading} empty={<EmptyState title={s.empty} />} columns={[
          { key: 'when', header: s.when, render: (e) => <span className="num nowrap">{dateTime(e.created_at, locale, undefined)}</span> },
          { key: 'who', header: s.who, render: (e) => <><Badge tone={TONE[e.actor_type] ?? 'neutral'}>{actor(e.actor_type)}</Badge>{e.source !== 'api' && <span className="fine"> · {sourceLabel(t, e.source)}</span>}</> },
          { key: 'what', header: s.what, rowHeader: true, render: (e) => <span title={e.action}>{actionLabel(t, e.action) ?? <Code>{e.action}</Code>}
            {e.entity_type && <span className={`fine ${styles.entity}`}>{entityLabel(t, e.entity_type)}{e.entity_id && <> · <Code>{e.entity_id.slice(0, 8)}</Code></>}</span>}</span> },
          { key: 'details', header: s.details, render: (e) => Object.keys(e.metadata ?? {}).length > 0 ? (
            <>
              <button className="btn btn-ghost btn-sm" aria-expanded={open === e.id} aria-label={open === e.id ? s.hide : s.show} onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? '−' : '+'}</button>
              {open === e.id && <pre dir="ltr" className={styles.meta}>{JSON.stringify(e.metadata, null, 2)}</pre>}
            </>
          ) : null },
        ]} />
      )}
      {items && items.length > 0 && (
        <div className={styles.more}>
          {cursor ? <button className="btn" aria-busy={loading || undefined} onClick={() => { if (!loading) void load(cursor); }}>{loading ? s.loading : s.more}</button> : <span className="fine">{s.end}</span>}
        </div>
      )}
    </SettingsShell>
  );
}
