'use client';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { assignableRoles, MCP_ACTING_ROLES, type McpGroupView, type Role } from '@resuto/contracts';
import { Card, EmptyState, Notice, Skeleton, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import {
  authMethodOf, cleanOverrides, clearOAuthDraft, createPayload, firstIncomplete, initialWizard, newOAuthConnection, saveOAuthDraft, stepIssues,
  WIZARD_STEPS, type WizardState, type WizardStep,
} from '@/lib/mcp-wizard';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { CopyButton, McpPage, type CatalogTool, type McpClient } from '../_components/shared';
import { AssistantStep, AuthorizeStep, GroupsStep, PolicyStep, ReviewStep, ScopeStep, WizardProgress } from './wizard-steps';

/** Public HTTPS URL of the deployed ResutoMCP server, e.g. https://mcp.example.com/mcp */
const CONFIGURED_URL = process.env.NEXT_PUBLIC_MCP_URL?.replace(/\/$/, '') ?? null;
const SERVER_URL = CONFIGURED_URL ?? 'https://mcp.example.com/mcp';

interface TestResult { ok: boolean; text: string }

/**
 * Connect an AI assistant (21-MCP, plan §6.6): six steps — assistant, authorize, restaurant and branches, permission
 * groups, approval policy, review with expiry and a test call. Key connections are created here (the key is shown once,
 * under Advanced); OAuth assistants create theirs on the consent screen with the settings chosen here, and this page
 * picks the new connection up and tests it.
 */
export default function NewMcpConnectionPage() {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const roles = assignableRoles(org.role).filter((r) => (MCP_ACTING_ROLES as readonly string[]).includes(r)) as Role[];
  const [state, setState] = useState<WizardState>(() => initialWizard(roles.includes('manager') ? 'manager' : roles[0] ?? 'manager'));
  const [step, setStep] = useState<WizardStep>('assistant');
  const [shown, setShown] = useState<Partial<Record<WizardStep, boolean>>>({});
  const groups = useApi<{ items: McpGroupView[] }>(`/o/${org.id}/mcp/groups?role=${state.actingRole}`);
  const catalog = useApi<{ items: CatalogTool[] }>(`/o/${org.id}/mcp/catalog`);
  const items = useMemo(() => groups.data?.items ?? [], [groups.data]);
  const set = (patch: Partial<WizardState>) => setState((s) => ({ ...s, ...patch }));
  const issues = stepIssues(step, state, items);
  const at = WIZARD_STEPS.indexOf(step);
  const method = authMethodOf(state);
  const base = `/dashboard/${org.id}/mcp`;

  // Created connection (key) or the OAuth connection the assistant made, and the test call on it.
  const [created, setCreated] = useState<(McpClient & { key?: string }) | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const clients = useApi<{ items: McpClient[] }>(waitingSince && !created ? `/o/${org.id}/mcp/clients` : null, { pollMs: 4000, staleMs: 0 });

  const runTest = useAction(async (clientId: string) => {
    setTest(null);
    try {
      const r = await session.call<{ output: { name: string; actingRole: string; branchCount: number } }>(
        `/o/${org.id}/mcp/clients/${clientId}/test/get_restaurant_profile`, { body: { input: {} } });
      setTest({ ok: true, text: t('mcp.wizard.review.testOk', { org: r.output.name, role: t(`mcp.role.${r.output.actingRole}`), n: r.output.branchCount }) });
    } catch (e) {
      setTest({ ok: false, text: t('mcp.wizard.review.testFailed', { error: (e as Error).message }) });
    }
  });
  const testRef = useRef(runTest.run);
  testRef.current = runTest.run;

  useEffect(() => {
    if (!waitingSince || created || !clients.data) return;
    const found = newOAuthConnection(clients.data.items, waitingSince);
    if (found) {
      setCreated(found);
      clearOAuthDraft(org.id);
      void testRef.current(found.id);
    }
  }, [clients.data, waitingSince, created, org.id]);

  const create = useAction(async () => {
    const res = await session.call<McpClient & { key: string }>(`/o/${org.id}/mcp/clients`, { body: createPayload(state, items) });
    setCreated(res);
    await runTest.run(res.id);
  });

  const go = (to: WizardStep) => {
    setShown((s) => ({ ...s, [step]: true }));
    setStep(to);
  };
  const next = () => {
    if (issues.length) { setShown((s) => ({ ...s, [step]: true })); return; }
    if (step === 'groups') set({ overrides: cleanOverrides(state, items) });
    go(WIZARD_STEPS[Math.min(at + 1, WIZARD_STEPS.length - 1)]!);
  };
  const reachable = (s: WizardStep) => WIZARD_STEPS.indexOf(s) <= at || WIZARD_STEPS.slice(0, WIZARD_STEPS.indexOf(s)).every((x) => !stepIssues(x, state, items).length);
  const finish = () => {
    const missing = firstIncomplete(state, items);
    if (missing) { setShown((s) => ({ ...s, [missing]: true })); setStep(missing); return; }
    if (method === 'oauth') {
      saveOAuthDraft(org.id, { ...state, overrides: cleanOverrides(state, items) });
      setWaitingSince(Date.now());
    } else void create.run();
  };

  if (!roles.length) return <McpPage tab="clients"><Card><EmptyState title={t('mcp.form.noRoles')} /></Card></McpPage>;

  const assistantName = state.assistant ? t(`mcp.wizard.assistant.${state.assistant}.name`) : '';
  return (
    <McpPage tab="clients">
      <h2 className="mbs-0">{t('mcp.wizard.title')}</h2>
      <WizardProgress current={step} reachable={reachable} onGo={go} />
      <Card>
        {groups.error ? <Notice tone="danger">{t('mcp.error.load', { message: groups.error.message })}</Notice>
          : !groups.data && (step === 'groups' || step === 'policy' || step === 'review') ? <Skeleton lines={4} />
            : step === 'assistant' ? <AssistantStep state={state} set={set} />
              : step === 'authorize' ? <AuthorizeStep state={state} serverUrl={SERVER_URL} configured={!!CONFIGURED_URL} />
                : step === 'scope' ? <ScopeStep state={state} set={set} orgName={org.name} branches={org.branches} roles={roles} />
                  : step === 'groups' ? <GroupsStep state={state} set={set} groups={items} catalog={catalog.data?.items ?? []} />
                    : step === 'policy' ? <PolicyStep state={state} set={set} groups={items} policyHref={<p className="fine m-0">{t('mcp.wizard.policy.manage')}</p>} />
                      : (
                        <ReviewStep state={state} set={set} groups={items} orgName={org.name} branches={org.branches}>
                          {waitingSince && !created && (
                            <Notice tone="info">{t('mcp.wizard.review.waiting', { assistant: assistantName })}</Notice>
                          )}
                          {created && (
                            <div className="stack">
                              <Notice tone="ok">{t('mcp.wizard.review.created', { name: created.name })}</Notice>
                              {created.key && (
                                <details open>
                                  <summary className="cursor-pointer">{t('mcp.wizard.review.keyAdvanced')}</summary>
                                  <div className="stack mbs-12">
                                    <Notice tone="warn">{t('mcp.key.warning')}</Notice>
                                    <div className="cx-url">
                                      <code dir="ltr" aria-label={t('mcp.col.key')}>{created.key}</code>
                                      <CopyButton text={created.key} label={t('mcp.key.copy')} className="btn btn-primary" />
                                    </div>
                                    <p className="fine m-0">{t('mcp.wizard.review.keyUse')}</p>
                                  </div>
                                </details>
                              )}
                              {runTest.pending && <p className="fine m-0">{t('mcp.wizard.review.testRunning')}</p>}
                              {test && <Notice tone={test.ok ? 'ok' : 'danger'}>{test.text}</Notice>}
                              <div className="row">
                                <button type="button" className="btn btn-ghost" disabled={runTest.pending} onClick={() => void runTest.run(created.id)}>{t('mcp.wizard.review.retest')}</button>
                                <Link className="btn btn-primary" href={`${base}/clients/${created.id}`}>{t('mcp.wizard.review.open')}</Link>
                              </div>
                            </div>
                          )}
                        </ReviewStep>
                      )}
        {shown[step] && !!issues.length && <Notice tone="warn">{issues.map((k) => t(k)).join(' ')}</Notice>}
        {create.error && <Notice tone="danger">{create.error}</Notice>}
      </Card>
      {!created && (
        <div className="cx-actions mbs-16">
          <button type="button" className="btn btn-ghost" disabled={at === 0} onClick={() => go(WIZARD_STEPS[Math.max(0, at - 1)]!)}>{t('mcp.wizard.back')}</button>
          {step !== 'review' ? <button type="button" className="btn btn-primary" onClick={next}>{t('mcp.wizard.next')}</button>
            : waitingSince ? <button type="button" className="btn btn-ghost" onClick={() => { setWaitingSince(null); clearOAuthDraft(org.id); }}>{t('mcp.wizard.review.cancelWait')}</button>
              : <button type="button" className="btn btn-primary" disabled={create.pending} onClick={finish}>
                {create.pending ? t('state.loading') : t(method === 'oauth' ? 'mcp.wizard.review.oauthSave' : 'mcp.wizard.review.create')}</button>}
        </div>
      )}
    </McpPage>
  );
}
