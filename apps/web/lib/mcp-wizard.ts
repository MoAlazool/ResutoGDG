// 21-MCP connection wizard: the state of the six steps, what blocks each step, and the request it produces. Pure (no
// React), so the steps' rules are unit-tested (lib/mcp-wizard.test.ts) and shared by the wizard and the OAuth consent
// screen, which picks up the settings chosen here for an assistant that connects with OAuth.
import {
  CHANGE_POLICY_STRICTNESS, isMcpAssistantVerified, MCP_ASSISTANT_COMPAT, MCP_ASSISTANTS, MCP_OVERRIDE_MODES, mcpToolsFor,
  type ChangeOpGroup, type ChangePolicyMode, type McpAssistant, type McpGroupView, type McpPermissionGroup, type McpPolicyOverrides,
  type McpToolName, type Role,
} from '@resuto/contracts';

export const WIZARD_STEPS = ['assistant', 'authorize', 'scope', 'groups', 'policy', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardState {
  assistant: McpAssistant | null;
  name: string;
  actingRole: Role;
  /** null: every branch the creator can access. */
  branchIds: string[] | null;
  groups: McpPermissionGroup[];
  /** "Advanced": tools added one by one on top of the groups. */
  advancedTools: McpToolName[];
  overrides: McpPolicyOverrides;
  /** YYYY-MM-DD (end of that day), or '' for no expiry. */
  expiresOn: string;
  rateLimitPerMin: number;
}

export const DEFAULT_GROUPS: McpPermissionGroup[] = ['orders_analytics', 'menu'];

export function initialWizard(defaultRole: Role): WizardState {
  return { assistant: null, name: '', actingRole: defaultRole, branchIds: null, groups: [...DEFAULT_GROUPS], advancedTools: [], overrides: {},
    expiresOn: '', rateLimitPerMin: 60 };
}

export interface AssistantCard {
  id: McpAssistant;
  title: string;
  titleAr: string;
  auth: 'oauth' | 'key';
  /** Only an assistant with a recorded live test is "verified" (none yet). */
  verified: boolean;
}

export const assistantCards = (): AssistantCard[] => MCP_ASSISTANTS.map((id) => ({
  id, title: MCP_ASSISTANT_COMPAT[id].title, titleAr: MCP_ASSISTANT_COMPAT[id].titleAr, auth: MCP_ASSISTANT_COMPAT[id].auth,
  verified: isMcpAssistantVerified(id),
}));

export const authMethodOf = (s: Pick<WizardState, 'assistant'>): 'oauth' | 'key' | null => (s.assistant ? MCP_ASSISTANT_COMPAT[s.assistant].auth : null);

const DEFAULT_NAMES: Record<McpAssistant, string> = { claude: 'Claude', chatgpt: 'ChatGPT', other: 'AI assistant' };
export const defaultConnectionName = (a: McpAssistant) => DEFAULT_NAMES[a];

/** Dictionary keys of what is still missing before leaving a step (empty: the step is complete). */
export function stepIssues(step: WizardStep, s: WizardState, groups: readonly McpGroupView[] = []): string[] {
  switch (step) {
    case 'assistant': return s.assistant ? [] : ['mcp.wizard.err.assistant'];
    case 'authorize': return [];
    case 'scope': {
      const out: string[] = [];
      if (!s.name.trim()) out.push('mcp.wizard.err.name');
      if (s.branchIds !== null && !s.branchIds.length) out.push('mcp.form.noBranches');
      return out;
    }
    case 'groups': {
      const usable = new Set(groups.filter((g) => g.available).map((g) => g.group));
      const chosen = s.groups.filter((g) => !groups.length || usable.has(g));
      return chosen.length || s.advancedTools.length ? [] : ['mcp.wizard.err.groups'];
    }
    case 'policy': return [];
    case 'review': {
      if (!s.expiresOn) return [];
      const end = new Date(`${s.expiresOn}T23:59:59`);
      return Number.isNaN(end.getTime()) || end.getTime() <= Date.now() ? ['mcp.wizard.err.expiry'] : [];
    }
  }
}

/** The first step with something missing, or null when the wizard can finish. */
export function firstIncomplete(s: WizardState, groups: readonly McpGroupView[] = []): WizardStep | null {
  return WIZARD_STEPS.find((st) => stepIssues(st, s, groups).length > 0) ?? null;
}

/** The policy groups behind the chosen permission groups, with the restaurant's mode for each. */
export function policyRows(s: Pick<WizardState, 'groups' | 'overrides'>, groups: readonly McpGroupView[]) {
  const rows = new Map<ChangeOpGroup, McpGroupView['policies'][number] & { override: 'approval' | 'blocked' | null; effective: ChangePolicyMode }>();
  for (const g of groups) {
    if (!s.groups.includes(g.group) || !g.available) continue;
    for (const p of g.policies) {
      const override = s.overrides[p.group] ?? null;
      rows.set(p.group, { ...p, override, effective: override && CHANGE_POLICY_STRICTNESS[override] > CHANGE_POLICY_STRICTNESS[p.mode] ? override : p.mode });
    }
  }
  return [...rows.values()];
}

/** The overrides a connection may choose for a group: only stricter than the restaurant's mode. */
export const overrideChoices = (mode: ChangePolicyMode): Array<'approval' | 'blocked'> =>
  MCP_OVERRIDE_MODES.filter((m) => CHANGE_POLICY_STRICTNESS[m] > CHANGE_POLICY_STRICTNESS[mode]);

/** Drops overrides that are not stricter (the restaurant changed its policy) or belong to groups no longer chosen. */
export function cleanOverrides(s: Pick<WizardState, 'groups' | 'overrides'>, groups: readonly McpGroupView[]): McpPolicyOverrides {
  const out: McpPolicyOverrides = {};
  for (const row of policyRows({ groups: s.groups, overrides: {} }, groups)) {
    const o = s.overrides[row.group];
    if (o && overrideChoices(row.mode).includes(o)) out[row.group] = o;
  }
  return out;
}

/** The tools the connection will have (what the API computes from the same groups). */
export function wizardTools(s: Pick<WizardState, 'groups' | 'actingRole' | 'advancedTools'>, groups: readonly McpGroupView[]): McpToolName[] {
  const off = new Set(groups.flatMap((g) => g.notEntitled));
  return mcpToolsFor(s.groups, s.actingRole, s.advancedTools, () => true).filter((t) => !off.has(t) || s.advancedTools.includes(t));
}

/** ISO end of day (local) for a YYYY-MM-DD input, or null. */
export const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : null);

/** Body of POST /o/:orgId/mcp/clients (connection key) or the extra fields of the OAuth consent. */
export function createPayload(s: WizardState, groups: readonly McpGroupView[]) {
  return {
    name: s.name.trim().slice(0, 80), actingRole: s.actingRole, branchIds: s.branchIds, groups: [...s.groups], allowedTools: [...s.advancedTools],
    policyOverrides: cleanOverrides(s, groups), rateLimitPerMin: s.rateLimitPerMin, expiresAt: endOfDay(s.expiresOn),
  };
}

// ---------------------------------------------------------------------------
// OAuth: the assistant opens the consent screen itself; the wizard's choices wait for it in this browser.
// ---------------------------------------------------------------------------
const DRAFT_KEY = (orgId: string) => `resuto.mcp.wizard.${orgId}`;
const DRAFT_TTL_MS = 2 * 3600_000;

export interface OAuthDraft { state: WizardState; savedAt: number }

export function saveOAuthDraft(orgId: string, state: WizardState, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try { storage?.setItem(DRAFT_KEY(orgId), JSON.stringify({ state, savedAt: Date.now() } satisfies OAuthDraft)); } catch { /* storage blocked */ }
}

export function readOAuthDraft(orgId: string, storage: Pick<Storage, 'getItem'> | null = safeStorage(), now = Date.now()): OAuthDraft | null {
  try {
    const raw = storage?.getItem(DRAFT_KEY(orgId));
    if (!raw) return null;
    const d = JSON.parse(raw) as OAuthDraft;
    if (!d?.state || typeof d.savedAt !== 'number' || now - d.savedAt > DRAFT_TTL_MS || !Array.isArray(d.state.groups)) return null;
    return d;
  } catch { return null; }
}

export function clearOAuthDraft(orgId: string, storage: Pick<Storage, 'removeItem'> | null = safeStorage()) {
  try { storage?.removeItem(DRAFT_KEY(orgId)); } catch { /* storage blocked */ }
}

function safeStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** The connection an OAuth assistant created after the wizard started (newest first). */
export function newOAuthConnection<C extends { authKind?: 'key' | 'oauth'; createdAt: string; status: string }>(items: readonly C[], since: number): C | null {
  return items.filter((c) => c.authKind === 'oauth' && c.status === 'active' && new Date(c.createdAt).getTime() >= since - 5_000)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))[0] ?? null;
}
