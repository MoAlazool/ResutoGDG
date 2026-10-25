import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_POLICIES, MCP_GROUPS, mcpGroupAvailability, type ChangeOpView, type ChangeSetView, type McpGroupView, type Role } from '@resuto/contracts';
import { AuditTimeline, ChangeSetDiff, RequirementLine } from '@/components/changes/ChangeSetDiff';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { initialWizard, type WizardState } from '@/lib/mcp-wizard';
import { AssistantStep, AuthorizeStep, GroupsStep, PolicyStep, ReviewStep, WizardProgress } from './wizard-steps';

// 21-MCP: the connection wizard steps and the approvals-inbox diff rendered in English and Arabic (RTL copy, Western
// digits), with honest sign-in labels and no "verified" badge without a recorded live test.

type Lang = 'en' | 'ar';
const render = (lang: Lang, el: ReactElement) => renderToStaticMarkup(h(LocaleProvider, { locale: lang, messages: messagesFor(lang, 'staff'), children: el }));
const noop = () => undefined;
const views = (role: Role): McpGroupView[] => mcpGroupAvailability(role).map((a) => ({
  ...a, title: MCP_GROUPS[a.group].title, titleAr: MCP_GROUPS[a.group].titleAr, description: MCP_GROUPS[a.group].description,
  descriptionAr: MCP_GROUPS[a.group].descriptionAr,
  policies: MCP_GROUPS[a.group].policyGroups.map((g) => ({ group: g, ...DEFAULT_CHANGE_POLICIES[g], isDefault: true })),
}));
const state = (patch: Partial<WizardState> = {}): WizardState => ({ ...initialWizard('manager'), assistant: 'claude', name: 'Claude', ...patch });
const EASTERN_DIGITS = /[٠-٩۰-۹]/;
const KEY_LEAK = /mcp\.(wizard|inbox|policy)\.[a-z]/;

describe.each(['en', 'ar'] as const)('connection wizard (%s)', (lang) => {
  it('labels each assistant with its sign-in method and never as verified', () => {
    const html = render(lang, h(AssistantStep, { state: state(), set: noop }));
    expect(html).toContain(lang === 'en' ? 'Sign-in (OAuth 2.1)' : 'OAuth 2.1');
    expect(html).toContain(lang === 'en' ? 'Connection key' : 'مفتاح اتصال');
    expect(html).toContain(lang === 'en' ? 'Not verified yet' : 'لم يُتحقق منه بعد');
    expect(html).not.toMatch(lang === 'en' ? />Verified</ : />تم التحقق</);
    expect(html).not.toMatch(KEY_LEAK);
  });

  it('shows the server URL and the OAuth steps, or the key steps', () => {
    const oauth = render(lang, h(AuthorizeStep, { state: state(), serverUrl: 'https://mcp.example.com/mcp', configured: true }));
    expect(oauth).toContain('dir="ltr"');
    expect(oauth).toContain('https://mcp.example.com/mcp');
    const key = render(lang, h(AuthorizeStep, { state: state({ assistant: 'other' }), serverUrl: 'https://mcp.example.com/mcp', configured: false }));
    expect(key).toContain('rmcp_');
    for (const html of [oauth, key]) expect(html).not.toMatch(KEY_LEAK);
  });

  it('turns off groups the acting role cannot use and keeps the raw tool list under Advanced', () => {
    const html = render(lang, h(GroupsStep, { state: state({ actingRole: 'kitchen', groups: ['promotions'] }), set: noop, groups: views('kitchen'), catalog: [] }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('<details>');
    expect(html).toContain(lang === 'en' ? MCP_GROUPS.promotions.title : MCP_GROUPS.promotions.titleAr);
    expect(html).not.toMatch(KEY_LEAK);
  });

  it('shows the restaurant policy with its approval window, and progress with Western digits', () => {
    const html = render(lang, h(PolicyStep, { state: state({ groups: ['promotions'] }), set: noop, groups: views('manager') }));
    expect(html).toContain(String(DEFAULT_CHANGE_POLICIES.promotions.ttlHours));
    expect(html).toContain(String(DEFAULT_CHANGE_POLICIES.promotions.ownerAboveBps! / 100));
    const progress = render(lang, h(WizardProgress, { current: 'groups', reachable: () => true, onGo: noop }));
    expect(progress).toContain('aria-current="step"');
    for (const out of [html, progress]) {
      expect(out).not.toMatch(EASTERN_DIGITS);
      expect(out).not.toMatch(KEY_LEAK);
    }
  });

  it('reviews the choices with the tool list and the expiry field', () => {
    const html = render(lang, h(ReviewStep, { state: state({ groups: ['menu'], branchIds: null }), set: noop, groups: views('manager'), orgName: 'Koshary Lab', branches: [] }));
    expect(html).toContain('<bdi>Koshary Lab</bdi>');
    expect(html).toContain('list_menu');
    expect(html).toContain('type="date"');
    expect(html).not.toMatch(KEY_LEAK);
  });
});

const op = (patch: Partial<ChangeOpView> = {}): ChangeOpView => ({
  id: 'op-1', seq: 1, type: 'promotion.create', title: 'Create an offer', titleAr: 'إنشاء عرض', group: 'promotions', kind: 'local', target: null, branchId: null,
  input: {}, before: null, after: null, summary: 'Eid 15: 15% off', status: 'proposed', result: null, error: null, appliedAt: null, effect: null,
  changes: [{ label: 'Offer', before: null, after: 'Eid 15' }, { label: 'Price', before: 'EGP 185.00', after: 'EGP 157.25' }], ...patch,
});

describe.each(['en', 'ar'] as const)('approvals inbox diff (%s)', (lang) => {
  it('shows before and after for every op, new values, and the effect state', () => {
    const html = render(lang, h(ChangeSetDiff, { cs: { ops: [op(), op({ id: 'op-2', type: 'payment_link.create', kind: 'effect', title: 'Create a payment link',
      titleAr: 'إنشاء رابط دفع', status: 'pending_effect', changes: [],
      effect: { status: 'running', attempts: 1, maxAttempts: 5, nextAttemptAt: null, lastError: null, reversible: true, compensation: 'none', finishedAt: null } })] } }));
    expect(html).toContain('class="cx-before"');
    expect(html).toContain('class="cx-after"');
    expect(html).toContain('EGP 157.25');
    expect(html).toContain(lang === 'en' ? 'Create an offer' : 'إنشاء عرض');
    expect(html).not.toMatch(KEY_LEAK);
  });

  it('shows who must approve and the audit timeline with the approver MFA level', () => {
    const cs: Pick<ChangeSetView, 'policy' | 'decisions' | 'status'> = { status: 'pending_approval', decisions: [],
      policy: { mode: 'approval', approvalsRequired: 2, requiresOwner: true, groups: {} } };
    const req = render(lang, h(RequirementLine, { cs }));
    expect(req).toContain('2');
    expect(req).not.toMatch(EASTERN_DIGITS);
    const audit = render(lang, h(AuditTimeline, { timezone: 'Africa/Cairo', rows: [
      { id: 1, action: 'change_set.approved', actorType: 'user', actorId: 'u', source: 'api', metadata: { aal: 'aal2', reason: 'OK for Eid' }, requestId: null, at: '2026-10-24T10:00:00Z' },
    ] }));
    expect(audit).toContain('OK for Eid');
    expect(audit).toContain('<time');
    expect(audit).not.toMatch(EASTERN_DIGITS);
    expect(audit).not.toMatch(KEY_LEAK);
  });
});
