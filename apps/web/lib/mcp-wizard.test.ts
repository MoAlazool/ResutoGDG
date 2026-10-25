import { describe, expect, it } from 'vitest';
import {
  CHANGE_OP_GROUPS, DEFAULT_CHANGE_POLICIES, MCP_ACTING_ROLES, MCP_ASSISTANTS, MCP_GROUPS, mcpGroupAvailability, type ModuleKey, type McpGroupView, type Role,
} from '@resuto/contracts';
import { dictionaries } from './i18n/messages';
import {
  assistantCards, cleanOverrides, clearOAuthDraft, createPayload, firstIncomplete, initialWizard, newOAuthConnection, overrideChoices, policyRows,
  readOAuthDraft, saveOAuthDraft, stepIssues, WIZARD_STEPS, wizardTools, type WizardState,
} from './mcp-wizard';

// 21-MCP connection wizard rules (lib/mcp-wizard.ts): what blocks each step, the policy rows and stricter-only
// overrides, the tools the API will grant, the request body, and the OAuth hand-off to the consent screen.

/** GET /o/:orgId/mcp/groups as the API builds it (McpClientsService.groups), from the shared contracts. */
function groupViews(role: Role, entitled: (m: ModuleKey) => boolean = () => true, modes: Partial<Record<(typeof CHANGE_OP_GROUPS)[number], 'auto' | 'approval' | 'blocked'>> = {}): McpGroupView[] {
  return mcpGroupAvailability(role, entitled).map((a) => {
    const meta = MCP_GROUPS[a.group];
    return {
      ...a, title: meta.title, titleAr: meta.titleAr, description: meta.description, descriptionAr: meta.descriptionAr,
      policies: meta.policyGroups.map((g) => {
        const p = DEFAULT_CHANGE_POLICIES[g];
        return { group: g, mode: modes[g] ?? p.mode, approvers: p.approvers, ownerAboveBps: p.ownerAboveBps, ttlHours: p.ttlHours, isDefault: !modes[g] };
      }),
    };
  });
}

const base = (patch: Partial<WizardState> = {}): WizardState => ({ ...initialWizard('manager'), assistant: 'other', name: 'Ops bot', ...patch });

describe('connection wizard steps', () => {
  it('runs the six steps of plan §6.6 in order', () => {
    expect(WIZARD_STEPS).toEqual(['assistant', 'authorize', 'scope', 'groups', 'policy', 'review']);
  });

  it('blocks a step until it is complete and finds the first incomplete one', () => {
    const groups = groupViews('manager');
    const s = initialWizard('manager');
    expect(stepIssues('assistant', s)).toEqual(['mcp.wizard.err.assistant']);
    expect(firstIncomplete(s, groups)).toBe('assistant');
    expect(stepIssues('scope', { ...s, assistant: 'claude', name: '  ' })).toEqual(['mcp.wizard.err.name']);
    expect(stepIssues('scope', base({ branchIds: [] }))).toEqual(['mcp.form.noBranches']);
    expect(stepIssues('groups', base({ groups: [] }), groups)).toEqual(['mcp.wizard.err.groups']);
    expect(stepIssues('groups', base({ groups: [], advancedTools: ['list_menu'] }), groups)).toEqual([]);
    expect(stepIssues('review', base({ expiresOn: '2000-01-01' }))).toEqual(['mcp.wizard.err.expiry']);
    expect(firstIncomplete(base(), groups)).toBeNull();
  });

  it('does not count a group this role cannot use', () => {
    const kitchen = groupViews('kitchen');
    const promotions = kitchen.find((g) => g.group === 'promotions')!;
    expect(promotions.available).toBe(false);
    expect(stepIssues('groups', base({ actingRole: 'kitchen', groups: ['promotions'] }), kitchen)).toEqual(['mcp.wizard.err.groups']);
  });
});

describe('approval policy step', () => {
  it('lists the restaurant policy of each change group behind the chosen permission groups', () => {
    const rows = policyRows(base({ groups: ['menu', 'promotions', 'orders_analytics'] }), groupViews('manager'));
    expect(rows.map((r) => r.group).sort()).toEqual([...new Set([...MCP_GROUPS.menu.policyGroups, ...MCP_GROUPS.promotions.policyGroups])].sort());
    const promo = rows.find((r) => r.group === 'promotions')!;
    expect(promo).toMatchObject({ mode: DEFAULT_CHANGE_POLICIES.promotions.mode, ttlHours: DEFAULT_CHANGE_POLICIES.promotions.ttlHours, override: null, isDefault: true });
    // A read-only group adds no rows.
    expect(policyRows(base({ groups: ['orders_analytics'] }), groupViews('manager'))).toEqual([]);
  });

  it('offers only stricter modes and drops overrides that are no longer stricter or no longer chosen', () => {
    expect(overrideChoices('auto')).toEqual(['approval', 'blocked']);
    expect(overrideChoices('approval')).toEqual(['blocked']);
    expect(overrideChoices('blocked')).toEqual([]);
    const groups = groupViews('manager', () => true, { menu: 'auto', promotions: 'approval' });
    const s = base({ groups: ['menu', 'promotions'], overrides: { menu: 'approval', promotions: 'approval', payments: 'blocked' } });
    // promotions is already "approval" (not stricter); payments is not behind a chosen group.
    expect(cleanOverrides(s, groups)).toEqual({ menu: 'approval' });
    expect(policyRows(s, groups).find((r) => r.group === 'menu')).toMatchObject({ mode: 'auto', override: 'approval', effective: 'approval' });
  });
});

describe('tools and request body', () => {
  it('computes the same allow-list as the API: base tools, usable group tools, Advanced tools; nothing the plan lacks', () => {
    const noMarketing = (m: ModuleKey) => m !== 'marketing';
    const groups = groupViews('manager', noMarketing);
    const tools = wizardTools(base({ groups: ['menu', 'promotions'] }), groups);
    expect(tools).toEqual(expect.arrayContaining(['get_restaurant_profile', 'list_branches', 'get_approval_status', 'list_menu']));
    expect(tools).not.toContain('create_promotion');
    expect(wizardTools(base({ groups: ['menu'], advancedTools: ['create_promotion'] }), groups)).toContain('create_promotion');
  });

  it('sends groups, Advanced tools, cleaned overrides and the end of the expiry day', () => {
    const groups = groupViews('manager');
    const body = createPayload(base({ name: '  Claude  ', groups: ['menu'], overrides: { menu: 'blocked', payments: 'blocked' }, expiresOn: '2099-12-31' }), groups);
    expect(body).toMatchObject({ name: 'Claude', actingRole: 'manager', branchIds: null, groups: ['menu'], allowedTools: [], rateLimitPerMin: 60 });
    expect(body.policyOverrides).toEqual(DEFAULT_CHANGE_POLICIES.menu.mode === 'blocked' ? {} : { menu: 'blocked' });
    expect(new Date(body.expiresAt!).getTime()).toBe(new Date('2099-12-31T23:59:59').getTime());
    expect(createPayload(base({ expiresOn: '' }), groups).expiresAt).toBeNull();
  });
});

describe('assistants', () => {
  it('shows each assistant with its real sign-in method and never "verified" without a recorded live test', () => {
    const cards = assistantCards();
    expect(cards.map((c) => c.id)).toEqual([...MCP_ASSISTANTS]);
    expect(cards.find((c) => c.id === 'claude')!.auth).toBe('oauth');
    expect(cards.find((c) => c.id === 'other')!.auth).toBe('key');
    expect(cards.every((c) => c.verified === false)).toBe(true);
  });
});

describe('OAuth hand-off to the consent screen', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it('keeps the wizard choices per restaurant for two hours', () => {
    const st = store();
    const s = base({ assistant: 'claude', groups: ['menu', 'promotions'] });
    saveOAuthDraft('org-1', s, st);
    expect(readOAuthDraft('org-1', st)?.state).toEqual(s);
    expect(readOAuthDraft('org-2', st)).toBeNull();
    expect(readOAuthDraft('org-1', st, Date.now() + 2 * 3600_000 + 1000)).toBeNull();
    clearOAuthDraft('org-1', st);
    expect(readOAuthDraft('org-1', st)).toBeNull();
    st.setItem('resuto.mcp.wizard.org-1', '{not json');
    expect(readOAuthDraft('org-1', st)).toBeNull();
  });

  it('picks up the OAuth connection the assistant created after the wizard started', () => {
    const since = Date.parse('2026-10-24T10:00:00Z');
    const items = [
      { id: 'old', authKind: 'oauth' as const, status: 'active', createdAt: '2026-10-23T10:00:00Z' },
      { id: 'key', authKind: 'key' as const, status: 'active', createdAt: '2026-10-24T10:01:00Z' },
      { id: 'new', authKind: 'oauth' as const, status: 'active', createdAt: '2026-10-24T10:02:00Z' },
      { id: 'revoked', authKind: 'oauth' as const, status: 'revoked', createdAt: '2026-10-24T10:03:00Z' },
    ];
    expect(newOAuthConnection(items, since)?.id).toBe('new');
    expect(newOAuthConnection(items.slice(0, 2), since)).toBeNull();
  });
});

describe('copy', () => {
  it('has English and Arabic for every key the wizard builds at runtime', () => {
    const keys = [
      ...WIZARD_STEPS.map((s) => `mcp.wizard.step.${s}`),
      ...MCP_ASSISTANTS.flatMap((a) => [`mcp.wizard.assistant.${a}.name`, `mcp.wizard.assistant.${a}.body`, `mcp.wizard.auth.oauth1.${a}`]),
      'mcp.wizard.auth.oauth', 'mcp.wizard.auth.key',
      ...CHANGE_OP_GROUPS.map((g) => `mcp.policy.group.${g}`),
      ...(['auto', 'approval', 'blocked'] as const).map((m) => `mcp.policy.mode.${m}`),
      ...MCP_ACTING_ROLES.map((r) => `mcp.role.${r}`),
    ];
    for (const locale of ['en', 'ar'] as const) {
      const missing = keys.filter((k) => !dictionaries[locale][k]);
      expect(missing, locale).toEqual([]);
    }
    // Arabic copy uses Western digits.
    const ar = Object.entries(dictionaries.ar).filter(([k]) => k.startsWith('mcp.wizard.') || k.startsWith('mcp.inbox.') || k.startsWith('mcp.policy.'));
    expect(ar.filter(([, v]) => /[٠-٩۰-۹]/.test(v))).toEqual([]);
  });
});
