'use client';
import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import { assignableRoles, can, MCP_ACTING_ROLES, type Permission, type Role } from '@resuto/contracts';
import { Badge, Card, EmptyState, ErrorState, Field, ListPage, Notice, SelectField, SkeletonTable, type Tone } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { MCP_SECTIONS } from '@/lib/sections';
import type { ApiRequestError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import st from './mcp.module.css';

export interface CatalogTool {
  name: string; title: string; titleAr: string; description: string; sensitive: boolean; readOnly: boolean;
  permission: Permission | null; module: string; entitled: boolean; available: boolean; roles: Role[];
  inputSchema: { properties?: Record<string, { description?: string }> };
}

export interface McpClient {
  id: string; name: string; keyPrefix: string; actingRole: Role; branchIds: string[] | null; allowedTools: string[];
  rateLimitPerMin: number; status: 'active' | 'revoked'; expired: boolean; expiresAt: string | null; lastUsedAt: string | null;
  createdAt: string; revokedAt: string | null; calls24h?: number; pendingApprovals?: number;
  authKind?: 'key' | 'oauth'; groups?: string[]; policyOverrides?: Record<string, string>;
}

export interface McpCall {
  id: string; clientId: string; clientName: string; keyPrefix: string; tool: string; outcome: string; via: string;
  approvalId: string | null; changeSetId?: string | null; durationMs: number | null; errorCode: string | null; error: string | null; createdAt: string;
}

type Tab = 'clients' | 'approvals' | 'calls' | 'connect' | 'inbox';
// 21-MCP: 'inbox' is the cross-feature approvals inbox (MCP, Studio AI, staff change sets) at /approvals.
const MCP_TAB_HREF: Record<Tab, string> = { clients: '/mcp', approvals: '/mcp/approvals', calls: '/mcp/calls', connect: '/mcp/connect', inbox: '/approvals' };

/**
 * Page frame for every MCP screen (ListPage template): entitlement/permission gate, header, the area's SectionNav in
 * the filter slot, then the screen.
 */
export function McpPage({ tab, permission = 'mcp:manage', actions, children }: { tab: Tab; permission?: Permission; actions?: ReactNode; children: ReactNode }) {
  const { t } = useT();
  return (
    <ModuleGate module="mcp" permission={permission}>
      <div className={st.frame}>
        <ListPage header={{ eyebrow: 'ResutoMCP', title: t('mcp.title'), subtitle: t('mcp.subtitle'), actions }}
          filters={<SectionNav sections={MCP_SECTIONS} label={t('mcp.title')} active={MCP_TAB_HREF[tab]} />}>
          {children}
        </ListPage>
      </div>
    </ModuleGate>
  );
}

/** Loading → table skeleton; a failed request → the shared ErrorState with Try again; otherwise the screen. */
export function LoadState({ loading, error, retry, children }: { loading: boolean; error: ApiRequestError | null; retry: () => void; children: ReactNode }) {
  const { locale } = useT();
  if (error) return <Card><ErrorState error={error} onRetry={retry} locale={locale} /></Card>;
  if (loading) return <SkeletonTable rows={4} cols={4} />;
  return <>{children}</>;
}

export function ClientStatus({ client }: { client: Pick<McpClient, 'status' | 'expired'> }) {
  const { t } = useT();
  if (client.status === 'revoked') return <Badge tone="danger">{t('mcp.status.revoked')}</Badge>;
  if (client.expired) return <Badge tone="warn">{t('mcp.status.expired')}</Badge>;
  return <Badge tone="ok">{t('mcp.status.active')}</Badge>;
}

const OUTCOME_TONE: Record<string, Tone> = { ok: 'ok', approval_required: 'info', invalid_input: 'warn', rate_limited: 'warn', denied: 'danger', error: 'danger' };
export function OutcomeBadge({ outcome }: { outcome: string }) {
  const { t } = useT();
  return <Badge tone={OUTCOME_TONE[outcome] ?? 'neutral'}>{t(`mcp.outcome.${outcome}`)}</Badge>;
}

/** 21-MCP: when a connection stops working (expired, in a few days, on a date, or never). */
export function ExpiryBadge({ client, timezone }: { client: Pick<McpClient, 'expiresAt' | 'expired' | 'status'>; timezone: string }) {
  const { t, locale } = useT();
  if (client.status === 'revoked') return null;
  if (client.expired) return <Badge tone="warn">{t('mcp.status.expired')}</Badge>;
  if (!client.expiresAt) return <Badge tone="neutral">{t('mcp.expiry.none')}</Badge>;
  const days = Math.ceil((new Date(client.expiresAt).getTime() - Date.now()) / 86_400_000);
  if (days <= 7) return <Badge tone="warn">{t('mcp.expiry.soon', { n: Math.max(1, days) })}</Badge>;
  return <Badge tone="info">{t('mcp.expiry.on', { date: dateTime(client.expiresAt, locale, timezone) })}</Badge>;
}

const APPROVAL_TONE: Record<string, Tone> = { pending: 'info', approved: 'ok', executed: 'ok', rejected: 'neutral', expired: 'warn', failed: 'danger', invalidated: 'warn' };
export function ApprovalStatusBadge({ status }: { status: string }) {
  const { t } = useT();
  return <Badge tone={APPROVAL_TONE[status] ?? 'neutral'}>{t(`mcp.status.${status}`)}</Badge>;
}

export function CopyButton({ text, label, className = 'btn btn-sm btn-ghost' }: { text: string; label?: string; className?: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" className={className} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch { /* clipboard blocked: the text stays selectable */ }
    }}>{copied ? t('mcp.key.copied') : label ?? t('mcp.connect.copy')}</button>
  );
}

export const toolKind = (tool: Pick<CatalogTool, 'sensitive' | 'readOnly'>) => (tool.sensitive ? 'sensitive' : tool.readOnly ? 'read' : 'draft');

export function ToolBadges({ tool }: { tool: CatalogTool }) {
  const { t } = useT();
  const kind = toolKind(tool);
  return (
    <span className="row gap-6">
      {kind === 'sensitive' && <Badge tone="warn">{t('mcp.badge.sensitive')}</Badge>}
      {kind === 'draft' && <Badge tone="info">{t('mcp.badge.draft')}</Badge>}
      {kind === 'read' && <Badge tone="ok">{t('mcp.badge.readOnly')}</Badge>}
      {!tool.entitled && <Badge tone="neutral">{t('mcp.badge.notInPlan')}</Badge>}
      {tool.entitled && !tool.available && <Badge tone="sandbox">{t('mcp.badge.unavailable')}</Badge>}
    </span>
  );
}

/** Grouped tool allow-list with sensitivity badges and role warnings. */
export function ToolChecklist({ catalog, value, onChange, role, disabled }: {
  catalog: CatalogTool[]; value: string[]; onChange: (v: string[]) => void; role: Role; disabled?: boolean;
}) {
  const { t, locale } = useT();
  const groups = (['read', 'draft', 'sensitive'] as const).map((k) => ({ k, tools: catalog.filter((x) => toolKind(x) === k) }));
  const toggle = (name: string, on: boolean) => onChange(on ? [...new Set([...value, name])] : value.filter((v) => v !== name));
  return (
    <div className={`stack ${st.toolGroups}`}>
      {groups.map(({ k, tools }) => (
        <fieldset key={k} className={st.plainFieldset} disabled={disabled}>
          <div className={`spread ${st.groupHead}`}>
            <legend className={st.groupLegend}>{t(`mcp.kind.${k}`)}</legend>
            {k === 'read' && !disabled && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...new Set([...value, ...tools.map((x) => x.name)])])}>
                {t('mcp.form.selectAllRead')}
              </button>
            )}
          </div>
          <div className="stack gap-10">
            {tools.map((tool) => {
              const blocked = tool.permission !== null && !can(role, tool.permission);
              return (
                <label key={tool.name} className={st.tool}>
                  <input className="mbs-4" type="checkbox" checked={value.includes(tool.name)}
                    onChange={(e) => toggle(tool.name, e.target.checked)} />
                  <span className="stack gap-4 min-w-0">
                    <span className="row gap-8">
                      <strong>{locale === 'ar' ? tool.titleAr : tool.title}</strong>
                      <code className="fine" dir="ltr">{tool.name}</code>
                      <ToolBadges tool={tool} />
                    </span>
                    <span className="fine text-start" dir="ltr">{tool.description}</span>
                    {blocked && <span className={`fine ${st.blocked}`}>{t('mcp.roleCannot', { role: t(`mcp.role.${role}`) })}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

export interface ScopeValue {
  name: string; actingRole: Role; branchIds: string[] | null; allowedTools: string[]; rateLimitPerMin: number; expiresOn: string;
}

/** Shared create/edit form for a connection's scope. */
export function ScopeForm({ catalog, initial, submitLabel, pending, error, disabled, onSubmit }: {
  catalog: CatalogTool[]; initial: ScopeValue; submitLabel: string; pending: boolean; error: string | null; disabled?: boolean;
  onSubmit: (v: ScopeValue) => void;
}) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const roles = assignableRoles(org.role).filter((r) => (MCP_ACTING_ROLES as readonly string[]).includes(r));
  const [v, setV] = useState<ScopeValue>(initial);
  const [localError, setLocalError] = useState<string | null>(null);
  const set = <K extends keyof ScopeValue>(k: K, val: ScopeValue[K]) => setV((p) => ({ ...p, [k]: val }));

  if (!roles.length) return <Card><EmptyState title={t('mcp.form.noRoles')} /></Card>;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!v.allowedTools.length) return setLocalError(t('mcp.form.noTools'));
    if (v.branchIds !== null && !v.branchIds.length) return setLocalError(t('mcp.form.noBranches'));
    setLocalError(null);
    onSubmit(v);
  }

  return (
    <form onSubmit={submit} className="stack gap-16">
      <Card>
        <div className="form-row">
          <Field label={t('mcp.form.name')} hint={t('mcp.form.nameHint')} value={v.name} required maxLength={80} disabled={disabled}
            onChange={(e) => set('name', e.target.value)} />
          <SelectField label={t('mcp.form.role')} hint={t('mcp.form.roleHint')} value={v.actingRole} disabled={disabled}
            onChange={(e) => set('actingRole', e.target.value as Role)}>
            {(roles.includes(v.actingRole) ? roles : [v.actingRole, ...roles]).map((r) => <option key={r} value={r}>{t(`mcp.role.${r}`)}</option>)}
          </SelectField>
        </div>
        <div className="form-row">
          <Field label={t('mcp.form.rate')} type="number" min={1} max={600} value={v.rateLimitPerMin} disabled={disabled}
            onChange={(e) => set('rateLimitPerMin', Number(e.target.value))} />
          <Field label={t('mcp.form.expiry')} hint={t('mcp.form.expiryHint')} type="date" value={v.expiresOn} disabled={disabled}
            onChange={(e) => set('expiresOn', e.target.value)} />
        </div>
      </Card>

      <Card title={t('mcp.form.branches')}>
        <fieldset className={`stack gap-10 ${st.plainFieldset}`} disabled={disabled}>
          <label className="check"><input type="radio" name="branch-mode" checked={v.branchIds === null} onChange={() => set('branchIds', null)} /> {t('mcp.form.branchesAll')}</label>
          <label className="check"><input type="radio" name="branch-mode" checked={v.branchIds !== null} onChange={() => set('branchIds', [])} /> {t('mcp.form.branchesPick')}</label>
          {v.branchIds !== null && (
            <div className={`row ${st.branchPick}`}>
              {org.branches.map((b) => (
                <label key={b.id} className="check">
                  <input type="checkbox" checked={v.branchIds!.includes(b.id)}
                    onChange={(e) => set('branchIds', e.target.checked ? [...v.branchIds!, b.id] : v.branchIds!.filter((x) => x !== b.id))} />
                  {locale === 'ar' && b.nameAr ? b.nameAr : b.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </Card>

      <Card title={t('mcp.form.tools')}>
        <ToolChecklist catalog={catalog} value={v.allowedTools} onChange={(x) => set('allowedTools', x)} role={v.actingRole} disabled={disabled} />
      </Card>

      {(localError || error) && <Notice tone="danger">{localError ?? error}</Notice>}
      {!disabled && (
        <div className="row justify-end">
          <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : submitLabel}</button>
        </div>
      )}
    </form>
  );
}

/** ISO end-of-day (local) for a YYYY-MM-DD input, or null. */
export const endOfDayIso = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);
export const isoToDateInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
