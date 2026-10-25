'use client';
// Import & export (VS-28), the legacy data workspace: "A reviewed menu in. Useful business data out." One place that
// leads to every import and export, each shown only to roles that may use it (the API enforces the same rules).
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, Icon, type LucideIcon } from '@resuto/ui';
import { DownloadIcon, GridIcon, SigmaIcon, SwapIcon, UploadIcon, UsersIcon } from '@/components/icons/glyphs';
import '@/components/ops/ops.css';
import { SettingsShell } from '@/components/settings/SettingsShell';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

interface Entry { key: string; glyph: LucideIcon; show: boolean; links: Array<{ href: string; label: string; primary?: boolean }> }

export default function DataPage() {
  const { t } = useT();
  const { org, can, hasModule } = useOrg();
  const base = `/dashboard/${org.id}`;
  const entries: Entry[] = [
    { key: 'menuIn', glyph: DownloadIcon, show: can('menu:write'), links: [{ href: `${base}/menu?tab=import`, label: t('ops.data.menuIn.open'), primary: true }] },
    { key: 'pos', glyph: SwapIcon, show: can('integrations:manage'), links: [{ href: `${base}/integrations`, label: t('ops.data.pos.open') }] },
    { key: 'menuOut', glyph: UploadIcon, show: can('menu:write'), links: [{ href: `${base}/menu?tab=import`, label: t('ops.data.menuOut.open') }] },
    { key: 'customers', glyph: UsersIcon, show: can('customers:export'), links: [{ href: `${base}/customers`, label: t('ops.data.customers.open') }] },
    { key: 'finance', glyph: SigmaIcon, show: can('finance:read') && hasModule('finance'), links: [{ href: `${base}/finance/exports`, label: t('ops.data.finance.open') }] },
    { key: 'floor', glyph: GridIcon, show: can('floor:write'), links: [{ href: `${base}/floor?tab=studio`, label: t('ops.data.floor.open') }, { href: `${base}/floor?tab=qr`, label: t('ops.data.floor.qr') }] },
  ];
  const visible = entries.filter((e) => e.show);
  const card = (e: Entry): ReactNode => (
    <section key={e.key} className="panel data-card">
      <h2><span aria-hidden="true"><Icon icon={e.glyph} size={18} /></span>{t(`ops.data.${e.key}.title`)}</h2>
      <p>{t(`ops.data.${e.key}.body`)}</p>
      <div className="row">{e.links.map((l) => <Link key={l.href} className={`btn btn-sm${l.primary ? ' btn-primary' : ''}`} href={l.href}>{l.label}</Link>)}</div>
    </section>
  );
  return (
    <ModuleGate module="core">
      <SettingsShell header={{ title: t('ops.data.title'), subtitle: t('ops.data.subtitle') }}>
        {visible.length === 0 && <section className="panel"><EmptyState title={t('state.locked')}>{t('ops.data.none')}</EmptyState></section>}
        <h2 className="overline">{t('ops.data.in')}</h2>
        <div className="data-grid">{visible.filter((e) => ['menuIn', 'pos'].includes(e.key)).map(card)}</div>
        <h2 className="overline data-out">{t('ops.data.out')}</h2>
        <div className="data-grid">{visible.filter((e) => !['menuIn', 'pos'].includes(e.key)).map(card)}</div>
      </SettingsShell>
    </ModuleGate>
  );
}
