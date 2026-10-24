// Change sets (Resuto 2.1, WS 21-CS): one typed, reviewable, approvable unit of change shared by MCP, Studio AI,
// the copilot and staff. docs/architecture/CHANGE_SETS.md describes the engine.
import { z } from 'zod';
import { idempotencyKey, isoDateTime, optionalText, text, uuid } from './common';
import { listQueryOf } from './api';
import { promotionInput } from './marketing';
import type { ModuleKey } from './modules';
import type { Permission, Role } from './permissions';
import { createSection, sectionContent } from './studio';

export const changesContractsVersion = 1 as const;

export const CHANGE_ORIGINS = ['mcp', 'studio_ai', 'copilot', 'staff'] as const;
export type ChangeOrigin = (typeof CHANGE_ORIGINS)[number];

export const CHANGE_SET_STATUSES = [
  'draft', 'validated', 'pending_approval', 'approved', 'applying', 'applied', 'partially_applied', 'failed',
  'rejected', 'expired', 'invalidated',
] as const;
export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];
/** Statuses after which nothing about the change set changes any more (effects may still be compensated). */
export const CHANGE_SET_FINAL: readonly ChangeSetStatus[] = ['applied', 'partially_applied', 'failed', 'rejected', 'expired', 'invalidated'];

export const CHANGE_OP_STATUSES = ['proposed', 'applied', 'pending_effect', 'succeeded', 'failed', 'needs_attention', 'skipped'] as const;
export type ChangeOpStatus = (typeof CHANGE_OP_STATUSES)[number];

export const CHANGE_EFFECT_STATUSES = ['pending_effect', 'running', 'succeeded', 'failed', 'needs_attention'] as const;
export type ChangeEffectStatus = (typeof CHANGE_EFFECT_STATUSES)[number];
/** What a person can still do about a settled effect: undo it, or follow up by hand (it cannot be undone). */
export const CHANGE_COMPENSATIONS = ['none', 'available', 'reversed', 'follow_up'] as const;
export type ChangeCompensation = (typeof CHANGE_COMPENSATIONS)[number];

/** Policy groups (the MCP permission groups of plan §6.6 that change things). */
export const CHANGE_OP_GROUPS = ['menu', 'prices', 'promotions', 'website_drafts', 'website_publish', 'messages', 'payments'] as const;
export type ChangeOpGroup = (typeof CHANGE_OP_GROUPS)[number];

export const CHANGE_POLICY_MODES = ['auto', 'approval', 'blocked'] as const;
export type ChangePolicyMode = (typeof CHANGE_POLICY_MODES)[number];

export const CHANGE_OP_TYPES = [
  'menu.item.update', 'menu.item.price.set', 'menu.item.availability.set',
  'promotion.create',
  'website.section.add', 'website.section.update', 'website.publish',
  'campaign.send', 'payment_link.create',
] as const;
export type ChangeOpType = (typeof CHANGE_OP_TYPES)[number];

export interface ChangeOpMeta {
  title: string;
  titleAr: string;
  group: ChangeOpGroup;
  /** Both the proposer and every approver need it. */
  permission: Permission;
  module: ModuleKey;
  /** local: committed with the change set's transaction; effect: queued in the outbox and confirmed by a job. */
  kind: 'local' | 'effect';
  /** Effects only: a succeeded effect can be undone by its reverse action (otherwise a person follows up). */
  reversible: boolean;
}

export const CHANGE_OPS: Record<ChangeOpType, ChangeOpMeta> = {
  'menu.item.update': { title: 'Edit a menu item', titleAr: 'تعديل صنف', group: 'menu', permission: 'menu:write', module: 'core', kind: 'local', reversible: false },
  'menu.item.price.set': { title: 'Change a price', titleAr: 'تغيير سعر', group: 'prices', permission: 'menu:write', module: 'core', kind: 'local', reversible: false },
  'menu.item.availability.set': { title: 'Change availability', titleAr: 'تغيير التوفر', group: 'menu', permission: 'menu:availability', module: 'core', kind: 'local', reversible: false },
  'promotion.create': { title: 'Create an offer', titleAr: 'إنشاء عرض', group: 'promotions', permission: 'marketing:write', module: 'marketing', kind: 'local', reversible: false },
  'website.section.add': { title: 'Add a website section', titleAr: 'إضافة قسم للموقع', group: 'website_drafts', permission: 'studio:write', module: 'studio', kind: 'local', reversible: false },
  'website.section.update': { title: 'Edit a website section', titleAr: 'تعديل قسم في الموقع', group: 'website_drafts', permission: 'studio:write', module: 'studio', kind: 'local', reversible: false },
  'website.publish': { title: 'Publish the website', titleAr: 'نشر الموقع', group: 'website_publish', permission: 'studio:publish', module: 'studio', kind: 'local', reversible: false },
  'campaign.send': { title: 'Send a campaign', titleAr: 'إرسال حملة', group: 'messages', permission: 'marketing:approve', module: 'marketing', kind: 'effect', reversible: false },
  'payment_link.create': { title: 'Create a payment link', titleAr: 'إنشاء رابط دفع', group: 'payments', permission: 'payments:collect', module: 'pay', kind: 'effect', reversible: true },
};

/** Percent offers above this many basis points need an owner among the approvers (default; configurable per org). */
export const DEFAULT_OWNER_DISCOUNT_BPS = 3000;
/** Pending change sets wait this long for a decision. */
export const CHANGE_SET_TTL_HOURS = 24;

export interface ChangePolicy {
  mode: ChangePolicyMode;
  /** 1, or 2 for a second approver (distinct people; the proposer cannot be one of them). */
  approvers: 1 | 2;
  /** promotions only: percent offers above this need the owner. */
  ownerAboveBps: number | null;
}

/** Risk defaults (plan §6.6): money, price changes and outbound messages need approval. */
export const DEFAULT_CHANGE_POLICIES: Record<ChangeOpGroup, ChangePolicy> = {
  menu: { mode: 'auto', approvers: 1, ownerAboveBps: null },
  prices: { mode: 'approval', approvers: 1, ownerAboveBps: null },
  promotions: { mode: 'approval', approvers: 1, ownerAboveBps: DEFAULT_OWNER_DISCOUNT_BPS },
  website_drafts: { mode: 'auto', approvers: 1, ownerAboveBps: null },
  website_publish: { mode: 'auto', approvers: 1, ownerAboveBps: null },
  messages: { mode: 'approval', approvers: 1, ownerAboveBps: null },
  payments: { mode: 'approval', approvers: 1, ownerAboveBps: null },
};

// ---------------------------------------------------------------------------
// Op inputs
// ---------------------------------------------------------------------------
const productFields = z.object({
  name: text(120).optional(),
  nameAr: optionalText(120),
  description: optionalText(1000),
  descriptionAr: optionalText(1000),
  isActive: z.boolean().optional(),
});

export const changeOpInputs = {
  'menu.item.update': productFields.extend({ productId: uuid }).strict()
    .refine((v) => Object.keys(v).some((k) => k !== 'productId' && (v as Record<string, unknown>)[k] !== undefined),
      { message: 'Change at least one field', path: ['name'] }),
  'menu.item.price.set': z.object({ productId: uuid, priceMinor: z.number().int().min(1).max(100_000_000) }).strict(),
  'menu.item.availability.set': z.object({
    productId: uuid, branchId: uuid, available: z.boolean(), reason: z.string().trim().max(200).optional(),
  }).strict(),
  'promotion.create': promotionInput,
  'website.section.add': createSection,
  'website.section.update': z.object({ sectionId: uuid, content: sectionContent.optional(), isVisible: z.boolean().optional() }).strict()
    .refine((v) => v.content !== undefined || v.isVisible !== undefined, { message: 'Change the content or the visibility', path: ['content'] }),
  'website.publish': z.object({ note: z.string().trim().max(200).optional() }).strict(),
  'campaign.send': z.object({ campaignId: uuid, scheduledAt: isoDateTime.optional() }).strict(),
  'payment_link.create': z.object({
    orderId: uuid.optional(),
    amountMinor: z.number().int().positive().max(100_000_000).optional(),
    description: z.string().trim().min(1).max(200),
    customerId: uuid.optional(),
    expiresInMinutes: z.number().int().min(5).max(7 * 24 * 60).default(24 * 60),
  }).strict().refine((v) => v.orderId || v.amountMinor, { message: 'orderId or amountMinor is required', path: ['amountMinor'] }),
} satisfies Record<ChangeOpType, z.ZodType>;
export type ChangeOpInput<T extends ChangeOpType> = z.output<(typeof changeOpInputs)[T]>;

const opRequest = <T extends ChangeOpType>(type: T) => z.object({ type: z.literal(type), input: changeOpInputs[type] }).strict();

/** One requested operation: a type and its typed input. */
export const changeOpRequest = z.discriminatedUnion('type', [
  opRequest('menu.item.update'), opRequest('menu.item.price.set'), opRequest('menu.item.availability.set'),
  opRequest('promotion.create'),
  opRequest('website.section.add'), opRequest('website.section.update'), opRequest('website.publish'),
  opRequest('campaign.send'), opRequest('payment_link.create'),
]);
export type ChangeOpRequest = z.infer<typeof changeOpRequest>;

/** Staff proposal (POST /o/:orgId/change-sets with an Idempotency-Key header). */
export const proposeChangeSet = z.object({
  title: text(200),
  summary: optionalText(1000),
  ops: z.array(changeOpRequest).min(1).max(20),
}).strict();
export type ProposeChangeSet = z.infer<typeof proposeChangeSet>;

export const changeSetDecision = z.object({
  note: optionalText(500),
  /** The previewDigest the approver was shown (GET change set). A different current digest is refused (409 approval_changed). */
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type ChangeSetDecision = z.infer<typeof changeSetDecision>;

export const changeSetsQuery = listQueryOf({ defaultLimit: 50 }).extend({
  status: z.enum([...CHANGE_SET_STATUSES, 'open', 'all']).default('open'),
  origin: z.enum(CHANGE_ORIGINS).optional(),
});
export type ChangeSetsQuery = z.infer<typeof changeSetsQuery>;

export const changeSetAuditQuery = listQueryOf({ defaultLimit: 100 });

export const changePolicyUpdate = z.object({
  mode: z.enum(CHANGE_POLICY_MODES),
  approvers: z.union([z.literal(1), z.literal(2)]).default(1),
  ownerAboveBps: z.number().int().min(0).max(10000).nullable().optional(),
}).strict();
export type ChangePolicyUpdate = z.infer<typeof changePolicyUpdate>;

/** Which change sets an inbox shows for `status=open`: waiting for a decision, or still being applied. */
export const CHANGE_SET_OPEN: readonly ChangeSetStatus[] = ['pending_approval', 'approved', 'applying'];

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
export interface ChangeLine { label: string; before: string | null; after: string }

export interface ChangeEffectView {
  status: ChangeEffectStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  reversible: boolean;
  compensation: ChangeCompensation;
  finishedAt: string | null;
}

export interface ChangeOpView {
  id: string;
  seq: number;
  type: ChangeOpType;
  title: string;
  titleAr: string;
  group: ChangeOpGroup;
  kind: 'local' | 'effect';
  target: { type: string; id: string } | null;
  branchId: string | null;
  input: Record<string, unknown>;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  summary: string;
  changes: ChangeLine[];
  status: ChangeOpStatus;
  /** Never carries bearer tokens (a payment link URL is delivered once to the requester, not stored here). */
  result: Record<string, unknown> | null;
  error: string | null;
  appliedAt: string | null;
  effect: ChangeEffectView | null;
}

export interface ChangeDecisionView { userId: string; role: Role; decision: 'approved' | 'rejected'; note: string | null; at: string }

export interface ChangeSetView {
  id: string;
  origin: ChangeOrigin;
  status: ChangeSetStatus;
  title: string;
  summary: string | null;
  actor: { type: 'user' | 'mcp_client' | 'system'; id: string; mcpClientId: string | null };
  proposedBy: string | null;
  policy: { mode: ChangePolicyMode; approvalsRequired: number; requiresOwner: boolean; groups: Partial<Record<ChangeOpGroup, ChangePolicyMode>> };
  previewDigest: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  appliedAt: string | null;
  error: string | null;
  invalidatedReason: string | null;
  decisions: ChangeDecisionView[];
  ops: ChangeOpView[];
  /** Set on a proposal answer: an identical earlier proposal (same Idempotency-Key and body) was returned. */
  replayed?: boolean;
  /**
   * On the answer that applied the set only (op id → value): what an effect hands over once, such as a payment link URL.
   * Never stored by the engine and never repeated (staff can re-open a payment link from Payments › Links).
   */
  deliverables?: Record<string, Record<string, unknown>>;
}

export interface ChangeSetSummary extends Omit<ChangeSetView, 'ops' | 'decisions'> {
  opCount: number;
  opTypes: ChangeOpType[];
}

export interface ChangeAuditEntry {
  id: number;
  action: string;
  actorType: string;
  actorId: string | null;
  source: string;
  metadata: Record<string, unknown>;
  requestId: string | null;
  at: string;
}

export interface ChangePolicyView extends ChangePolicy {
  group: ChangeOpGroup;
  isDefault: boolean;
  updatedAt: string | null;
}

/** Bounds of the Idempotency-Key header a proposal carries (8–200 characters). */
export const changeSetIdempotencyKey = idempotencyKey;
