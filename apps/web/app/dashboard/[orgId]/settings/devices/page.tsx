'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Page, PosDeviceSummary } from '@resuto/contracts';
import { Badge, Card, DataTableV2, EmptyState, Ltr, Notice, SkeletonTable, UserText, useCursorPagination, usePrompt, type ColumnV2 } from '@resuto/ui';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { ModuleGate } from '@/components/shell/ModuleGate';
import type { ApiRequestError } from '@/lib/api';
import { date, formatWhen, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { deviceStatus, STATUS_TONE } from './model';
import { PairSheet } from './PairSheet';
import styles from './devices.module.css';

// Settings › iPad devices (22-DEVICES): restaurant staff (and QA testing the native iPad app) pair POS iPads from the web
// (POST /v1/o/:orgId/pos/pairings), see every paired iPad of the branches they manage, and revoke one with a reason.
// devices:manage (owner, admin, manager; branch-scoped managers see their branches only: the API filters, and the
// branch select lists only the branches in their scope). Device credentials never reach this page.

export default function DevicesPage() {
  const { t } = useT();
  const { can } = useOrg();
  if (!can('devices:manage')) {
    return (
      <SettingsShell header={{ title: t('devices.page.title') }}>
        <ModuleGate module="core" permission="devices:manage">{null}</ModuleGate>
      </SettingsShell>
    );
  }
  return <Devices />;
}

const PAGE = 50;

function Devices() {
  const { locale, t, tn } = useT();
  const { org } = useOrg();
  const session = useSession();
  const pager = useCursorPagination();
  const [pairing, setPairing] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'danger'; text: ReactNode } | null>(null);
  const [prompt, promptDialog] = usePrompt(locale);
  const list = useApi<Page<PosDeviceSummary>>(`/o/${org.id}/pos/devices?limit=${PAGE}${pager.cursor ? `&cursor=${encodeURIComponent(pager.cursor)}` : ''}`);
  const reload = list.reload;
  const onPaired = useCallback(() => { void reload(); }, [reload]);
  // The command palette's "Pair a new iPad" opens the page with ?pair=1: open the sheet.
  useEffect(() => { if (new URLSearchParams(window.location.search).get('pair') === '1') setPairing(true); }, []);

  const branchName = (id: string) => {
    const b = org.branches.find((x) => x.id === id);
    return b ? pick(locale, b.name, b.nameAr) : '—';
  };

  async function revoke(d: PosDeviceSummary) {
    const name = <UserText>{d.name}</UserText>;
    const reason = await prompt({
      title: tn('devices.revoke.title', { name }), body: t('devices.revoke.body'), label: t('devices.revoke.label'),
      placeholder: t('devices.revoke.placeholder'), minLength: 2, maxLength: 200, confirmLabel: t('devices.revoke.confirm'), cancelLabel: t('action.cancel'),
      tone: 'danger',
    });
    if (reason === null) return;
    setNotice(null);
    try {
      await session.call(`/o/${org.id}/pos/devices/${d.id}/revoke`, { body: { reason } });
      setNotice({ tone: 'ok', text: tn('devices.page.revoked', { name }) });
      await list.reload();
    } catch (err) {
      setNotice({ tone: 'danger', text: t('devices.revoke.failed', { message: (err as ApiRequestError).message }) });
    }
  }

  const when = (iso: string | null) => (iso ? <span className="num nowrap">{formatWhen(iso, locale, org.timezone)}</span> : null);
  const columns: ColumnV2<PosDeviceSummary>[] = [
    { key: 'name', header: t('devices.col.name'), rowHeader: true, render: (d) => (
      <span><strong><UserText>{d.name}</UserText></strong>
        {(d.model || d.appVersion) && <span className={styles.sub}><Ltr>{[d.model, d.appVersion].filter(Boolean).join(' · ')}</Ltr></span>}</span>) },
    { key: 'branch', header: t('devices.col.branch'), render: (d) => branchName(d.branchId) },
    { key: 'role', header: t('devices.col.role'), render: (d) => t(`role.${d.actingRole}`) },
    { key: 'staff', header: t('devices.col.staff'), priority: 'low', render: (d) => (d.requireStaff
      ? <Badge tone="info">{t('devices.staff.required')}</Badge> : <span className="muted">{t('devices.staff.optional')}</span>) },
    { key: 'status', header: t('devices.col.status'), render: (d) => {
      const s = deviceStatus(d);
      return (
        <span data-status={s}>
          <Badge tone={STATUS_TONE[s]}>{t(`devices.status.${s}`)}</Badge>
          {s === 'revoked' && d.revokeReason && <span className={styles.reason}>{tn('devices.list.reason', { reason: <UserText>{d.revokeReason}</UserText> })}</span>}
        </span>
      );
    } },
    { key: 'paired', header: t('devices.col.paired'), render: (d) => when(d.pairedAt) },
    { key: 'lastSeen', header: t('devices.col.lastSeen'), render: (d) => when(d.lastSeenAt) ?? <span className="muted">{t('devices.list.never')}</span> },
    { key: 'expires', header: t('devices.col.expires'), priority: 'low', render: (d) => (d.expiresAt
      ? <span className="num nowrap">{date(d.expiresAt, locale, org.timezone)}</span> : <span className="muted">{t('devices.list.noExpiry')}</span>) },
    { key: 'actions', header: t('devices.col.actions'), align: 'end', hideable: false, render: (d) => (deviceStatus(d) === 'active'
      ? <button type="button" className="btn btn-sm btn-danger" aria-label={t('devices.list.revokeNamed', { name: d.name })} onClick={() => void revoke(d)}>{t('devices.list.revoke')}</button>
      : null) },
  ];

  const pairButton = <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>{t('devices.page.pair')}</button>;
  return (
    <SettingsShell header={{ title: t('devices.page.title'), subtitle: t('devices.page.subtitle'), actions: pairButton }}>
      {notice && <div className={styles.notice}><Notice tone={notice.tone}>{notice.text}</Notice></div>}
      {list.error && !list.data ? (
        <Notice tone="danger">{t('devices.page.loadError')} <button type="button" className="btn btn-sm" onClick={() => void list.reload()}>{t('action.retry')}</button></Notice>
      ) : !list.data ? <Card><SkeletonTable rows={3} cols={6} /></Card> : (
        <DataTableV2 label={t('devices.page.table')} rows={list.data.items} rowKey={(d) => d.id} busy={list.pending} columns={columns} locale={locale}
          empty={<EmptyState title={t('devices.empty.title')} action={pairButton}>{t('devices.empty.body')}</EmptyState>}
          pagination={list.data.nextCursor || pager.hasPrev ? {
            hasNext: !!list.data.nextCursor, hasPrev: pager.hasPrev, onNext: () => pager.next(list.data?.nextCursor), onPrev: pager.prev,
          } : undefined} />
      )}
      <PairSheet open={pairing} onClose={() => { setPairing(false); void list.reload(); }} onPaired={onPaired} />
      {promptDialog}
    </SettingsShell>
  );
}
