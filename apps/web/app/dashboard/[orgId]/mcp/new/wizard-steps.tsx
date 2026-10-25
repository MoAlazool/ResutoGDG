'use client';
// 21-MCP connection wizard steps. Presentational: state comes in through props (the page owns it and the API calls),
// so each step renders in a unit test (wizard-steps.test.tsx) in English and Arabic.
import type { ReactNode } from 'react';
import { MCP_TOOLS, type McpGroupView, type Role } from '@resuto/contracts';
import { Badge, Field, Notice, SelectField } from '@resuto/ui';
import {
  assistantCards, authMethodOf, overrideChoices, policyRows, WIZARD_STEPS, wizardTools, type WizardState, type WizardStep,
} from '@/lib/mcp-wizard';
import { useT } from '@/lib/i18n/client';
import { CopyButton, ToolChecklist, type CatalogTool } from '../_components/shared';
import '@/components/changes/changes.css';

type Set = (patch: Partial<WizardState>) => void;
interface Branch { id: string; name: string; nameAr: string | null }

export function WizardProgress({ current, reachable, onGo }: { current: WizardStep; reachable: (s: WizardStep) => boolean; onGo: (s: WizardStep) => void }) {
  const { t } = useT();
  const at = WIZARD_STEPS.indexOf(current);
  return (
    <ol className="cx-steps" aria-label={t('mcp.wizard.progress', { step: at + 1, total: WIZARD_STEPS.length })}>
      {WIZARD_STEPS.map((s, i) => (
        <li key={s} aria-current={s === current ? 'step' : undefined} data-done={i < at ? 'true' : undefined}>
          {reachable(s) && s !== current
            ? <button type="button" onClick={() => onGo(s)}>{t(`mcp.wizard.step.${s}`)}</button>
            : <span>{t(`mcp.wizard.step.${s}`)}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Step 1: the assistant, with its real sign-in method and a "verified" badge only from recorded live tests. */
export function AssistantStep({ state, set }: { state: WizardState; set: Set }) {
  const { t, locale } = useT();
  return (
    <fieldset className="cx-panel m-0" aria-describedby="wz-assistant-intro">
      <legend className="cx-card-title">{t('mcp.wizard.assistant.title')}</legend>
      <p id="wz-assistant-intro" className="fine m-0">{t('mcp.wizard.assistant.intro')}</p>
      <div className="cx-cards">
        {assistantCards().map((a) => (
          <label key={a.id} className="cx-card" data-selected={state.assistant === a.id ? 'true' : undefined}>
            <span className="cx-card-head">
              <input type="radio" name="wz-assistant" value={a.id} checked={state.assistant === a.id}
                onChange={() => set({ assistant: a.id, name: state.name || t(`mcp.wizard.assistant.${a.id}.name`) })} />
              <span className="cx-card-title">{locale === 'ar' ? a.titleAr : a.title}</span>
            </span>
            <span className="row gap-6">
              <Badge tone={a.auth === 'oauth' ? 'info' : 'neutral'}>{t(`mcp.wizard.auth.${a.auth}`)}</Badge>
              {a.verified ? <Badge tone="ok">{t('mcp.wizard.assistant.verified')}</Badge> : <Badge tone="neutral">{t('mcp.wizard.assistant.notVerified')}</Badge>}
            </span>
            <span className="fine">{t(`mcp.wizard.assistant.${a.id}.body`)}</span>
          </label>
        ))}
      </div>
      <p className="fine m-0">{t('mcp.wizard.assistant.tested')}</p>
    </fieldset>
  );
}

/** Step 2: how the assistant signs in. OAuth: the server URL and what happens next. Key: shown once at the end. */
export function AuthorizeStep({ state, serverUrl, configured }: { state: WizardState; serverUrl: string; configured: boolean }) {
  const { t } = useT();
  const method = authMethodOf(state);
  const who = state.assistant ? t(`mcp.wizard.assistant.${state.assistant}.name`) : '';
  return (
    <div className="cx-panel">
      <h3 className="m-0">{t(method === 'oauth' ? 'mcp.wizard.auth.oauthTitle' : 'mcp.wizard.auth.keyTitle', { assistant: who })}</h3>
      {!configured && <Notice tone="info">{t('mcp.connect.urlMissing')}</Notice>}
      <div className="cx-url">
        <code dir="ltr" aria-label={t('mcp.wizard.auth.serverUrl')}>{serverUrl}</code>
        <CopyButton text={serverUrl} />
      </div>
      {method === 'oauth' ? (
        <ol className="cx-howto">
          <li>{t(`mcp.wizard.auth.oauth1.${state.assistant ?? 'other'}`)}</li>
          <li>{t('mcp.wizard.auth.oauth2')}</li>
          <li>{t('mcp.wizard.auth.oauth3')}</li>
          <li>{t('mcp.wizard.auth.oauth4')}</li>
        </ol>
      ) : (
        <ol className="cx-howto">
          <li>{t('mcp.wizard.auth.key1')}</li>
          <li>{t('mcp.wizard.auth.key2')}</li>
          <li>{t('mcp.wizard.auth.key3')}</li>
        </ol>
      )}
    </div>
  );
}

/** Step 3: the restaurant (this one), the connection's name and acting role, and its branches. */
export function ScopeStep({ state, set, orgName, branches, roles }: { state: WizardState; set: Set; orgName: string; branches: Branch[]; roles: Role[] }) {
  const { t, locale } = useT();
  return (
    <div className="cx-panel">
      <p className="m-0">{t('mcp.wizard.scope.restaurant', { org: orgName })}</p>
      <div className="form-row">
        <Field label={t('mcp.form.name')} hint={t('mcp.form.nameHint')} value={state.name} required maxLength={80} onChange={(e) => set({ name: e.target.value })} />
        <SelectField label={t('mcp.form.role')} hint={t('mcp.form.roleHint')} value={state.actingRole} onChange={(e) => set({ actingRole: e.target.value as Role })}>
          {roles.map((r) => <option key={r} value={r}>{t(`mcp.role.${r}`)}</option>)}
        </SelectField>
      </div>
      <fieldset className="stack m-0 gap-10">
        <legend className="cx-card-title">{t('mcp.form.branches')}</legend>
        <label className="check"><input type="radio" name="wz-branches" checked={state.branchIds === null} onChange={() => set({ branchIds: null })} /> {t('mcp.form.branchesAll')}</label>
        <label className="check"><input type="radio" name="wz-branches" checked={state.branchIds !== null} onChange={() => set({ branchIds: [] })} /> {t('mcp.form.branchesPick')}</label>
        {state.branchIds !== null && (
          <div className="row">
            {branches.map((b) => (
              <label key={b.id} className="check">
                <input type="checkbox" checked={state.branchIds!.includes(b.id)}
                  onChange={(e) => set({ branchIds: e.target.checked ? [...state.branchIds!, b.id] : state.branchIds!.filter((x) => x !== b.id) })} />
                {locale === 'ar' && b.nameAr ? b.nameAr : b.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

/** Step 4: permission groups for this role (unavailable ones say why); individual tools under "Advanced". */
export function GroupsStep({ state, set, groups, catalog }: { state: WizardState; set: Set; groups: McpGroupView[]; catalog: CatalogTool[] }) {
  const { t, locale } = useT();
  const toolTitle = (n: string) => (locale === 'ar' ? MCP_TOOLS[n as keyof typeof MCP_TOOLS]?.titleAr : MCP_TOOLS[n as keyof typeof MCP_TOOLS]?.title) ?? n;
  const toggle = (g: McpGroupView['group'], on: boolean) => set({ groups: on ? [...new Set([...state.groups, g])] : state.groups.filter((x) => x !== g) });
  return (
    <div className="cx-panel">
      <p className="fine m-0">{t('mcp.wizard.groups.intro', { role: t(`mcp.role.${state.actingRole}`) })}</p>
      <div className="cx-cards">
        {groups.map((g) => {
          const on = g.available && state.groups.includes(g.group);
          const reason = !g.available ? (g.notEntitled.length && !g.blockedByRole.length ? 'mcp.wizard.groups.notInPlan' : 'mcp.wizard.groups.notForRole') : null;
          return (
            <label key={g.group} className="cx-card" data-selected={on ? 'true' : undefined} data-disabled={g.available ? undefined : 'true'}>
              <span className="cx-card-head">
                <input type="checkbox" checked={on} disabled={!g.available} onChange={(e) => toggle(g.group, e.target.checked)} />
                <span className="cx-card-title">{locale === 'ar' ? g.titleAr : g.title}</span>
                {g.policies.length ? <Badge tone="warn">{t('mcp.wizard.groups.changes')}</Badge> : <Badge tone="ok">{t('mcp.badge.readOnly')}</Badge>}
              </span>
              <span className="fine">{locale === 'ar' ? g.descriptionAr : g.description}</span>
              {reason && <span className="fine">{t(reason, { role: t(`mcp.role.${state.actingRole}`) })}</span>}
              {g.available && !!g.blockedByRole.length && (
                <span className="fine">{t('mcp.wizard.groups.partial', { tools: g.blockedByRole.map(toolTitle).join(locale === 'ar' ? '، ' : ', ') })}</span>
              )}
              {g.available && <span className="fine">{t('mcp.toolsCount', { n: g.tools.length })}</span>}
            </label>
          );
        })}
      </div>
      <details>
        <summary className="cursor-pointer">{t('mcp.wizard.groups.advanced')}</summary>
        <div className="stack mbs-12">
          <p className="fine m-0">{t('mcp.wizard.groups.advancedBody')}</p>
          <ToolChecklist catalog={catalog} value={state.advancedTools} onChange={(v) => set({ advancedTools: v as WizardState['advancedTools'] })} role={state.actingRole} />
        </div>
      </details>
    </div>
  );
}

/** Step 5: the restaurant's approval policy for what these groups change, and stricter settings for this connection. */
export function PolicyStep({ state, set, groups, policyHref }: { state: WizardState; set: Set; groups: McpGroupView[]; policyHref?: ReactNode }) {
  const { t } = useT();
  const rows = policyRows(state, groups);
  if (!rows.length) return <p className="m-0">{t('mcp.wizard.policy.none')}</p>;
  return (
    <div className="cx-panel">
      <p className="fine m-0">{t('mcp.wizard.policy.intro')}</p>
      <div className="cx-wrap">
        <table className="cx-table">
          <thead><tr>
            <th scope="col">{t('mcp.wizard.policy.what')}</th><th scope="col">{t('mcp.wizard.policy.restaurant')}</th><th scope="col">{t('mcp.wizard.policy.connection')}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const choices = overrideChoices(r.mode);
              return (
                <tr key={r.group}>
                  <th scope="row">{t(`mcp.policy.group.${r.group}`)}</th>
                  <td>
                    <span className="stack gap-4">
                      <span>{t(`mcp.policy.mode.${r.mode}`)}{r.isDefault ? ` · ${t('mcp.policy.default')}` : ''}</span>
                      {r.mode === 'approval' && <span className="fine">{t('mcp.policy.approvers', { n: r.approvers })} · {t('mcp.policy.window', { hours: r.ttlHours })}</span>}
                      {r.ownerAboveBps !== null && <span className="fine">{t('mcp.policy.owner', { pct: r.ownerAboveBps / 100 })}</span>}
                    </span>
                  </td>
                  <td>
                    {choices.length ? (
                      <SelectField label={t('mcp.wizard.policy.connection')} value={r.override ?? ''}
                        onChange={(e) => {
                          const next = { ...state.overrides };
                          if (e.target.value) next[r.group] = e.target.value as 'approval' | 'blocked'; else delete next[r.group];
                          set({ overrides: next });
                        }}>
                        <option value="">{t('mcp.policy.inherit')}</option>
                        {choices.map((m) => <option key={m} value={m}>{t(`mcp.policy.mode.${m}`)}</option>)}
                      </SelectField>
                    ) : <span className="muted">{t('mcp.policy.inherit')}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {policyHref}
    </div>
  );
}

/** Step 6: everything chosen, the expiry, then create (key) or wait for the assistant (OAuth) and run a test call. */
export function ReviewStep({ state, set, groups, orgName, branches, children }: {
  state: WizardState; set: Set; groups: McpGroupView[]; orgName: string; branches: Branch[]; children?: ReactNode;
}) {
  const { t, locale } = useT();
  const tools = wizardTools(state, groups);
  const chosen = groups.filter((g) => g.available && state.groups.includes(g.group));
  const overrides = Object.entries(state.overrides);
  const branchText = state.branchIds === null ? t('mcp.branches.all')
    : state.branchIds.map((id) => { const b = branches.find((x) => x.id === id); return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : id; }).join(locale === 'ar' ? '، ' : ', ');
  const sep = locale === 'ar' ? '، ' : ', ';
  return (
    <div className="cx-panel">
      <dl className="stack gap-8 m-0">
        <div><dt className="muted">{t('mcp.wizard.review.assistant')}</dt>
          <dd className="m-0">{state.assistant ? t(`mcp.wizard.assistant.${state.assistant}.name`) : '—'} · {t(`mcp.wizard.auth.${authMethodOf(state) ?? 'key'}`)}</dd></div>
        <div><dt className="muted">{t('mcp.wizard.review.where')}</dt><dd className="m-0"><bdi>{orgName}</bdi> · {branchText}</dd></div>
        <div><dt className="muted">{t('mcp.form.name')}</dt><dd className="m-0"><bdi>{state.name}</bdi> · {t(`mcp.role.${state.actingRole}`)}</dd></div>
        <div><dt className="muted">{t('mcp.wizard.review.groups')}</dt>
          <dd className="m-0">{chosen.length ? chosen.map((g) => (locale === 'ar' ? g.titleAr : g.title)).join(sep) : '—'}</dd></div>
        <div><dt className="muted">{t('mcp.wizard.review.tools', { n: tools.length })}</dt>
          <dd className="m-0"><ul className="cx-tools">{tools.map((n) => <li key={n}><code dir="ltr">{n}</code></li>)}</ul></dd></div>
        {!!overrides.length && (
          <div><dt className="muted">{t('mcp.wizard.review.overrides')}</dt>
            <dd className="m-0">{overrides.map(([g, m]) => `${t(`mcp.policy.group.${g}`)}: ${t(`mcp.policy.mode.${m}`)}`).join(sep)}</dd></div>
        )}
      </dl>
      <div className="form-row">
        <Field label={t('mcp.form.expiry')} hint={t('mcp.form.expiryHint')} type="date" value={state.expiresOn} onChange={(e) => set({ expiresOn: e.target.value })} />
        <Field label={t('mcp.form.rate')} type="number" min={1} max={600} value={state.rateLimitPerMin}
          onChange={(e) => set({ rateLimitPerMin: Math.max(1, Math.min(600, Number(e.target.value) || 1)) })} />
      </div>
      {children}
    </div>
  );
}
