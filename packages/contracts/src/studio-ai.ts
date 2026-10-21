import { z } from 'zod';
import { idempotencyKey } from './common';

// Studio AI creative workflows (ws9): menu extraction (FT-08/VS-26), food-photo enhancement (FT-04) and the
// capability report the dashboard uses to label every result honestly (deterministic vs model, BYOK only).

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** The only model provider Studio AI calls, and only with the restaurant's own key (BYOK, integration "gemini_byok"). */
export const STUDIO_AI_PROVIDER = 'gemini_byok' as const;

export interface StudioAiCapabilities {
  /** The restaurant's own model key. Resuto never calls a model on the platform's account for these features. */
  byok: { provider: typeof STUDIO_AI_PROVIDER; configured: boolean; connectionId: string | null; model: string | null; environment: 'sandbox' | 'live' | null };
  menuExtraction: { text: true; csv: true; image: boolean; pdf: boolean; floorPlan: false };
  photoEnhancement: { deterministic: boolean; generative: false; generativeReason: string };
}

// ---------------------------------------------------------------------------
// Menu extraction (upload -> job -> editable review table -> validated commit)
// ---------------------------------------------------------------------------

export const EXTRACTION_SOURCE_KINDS = ['text', 'csv', 'image', 'pdf'] as const;
export type ExtractionSourceKind = (typeof EXTRACTION_SOURCE_KINDS)[number];
export const EXTRACTION_MODES = ['heuristic_text', 'csv_columns', 'vision_model'] as const;
export type ExtractionMode = (typeof EXTRACTION_MODES)[number];
export const EXTRACTION_STATUSES = ['queued', 'processing', 'review', 'committing', 'committed', 'failed', 'discarded'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];
export const EXTRACTION_MAX_ROWS = 300;
/** Images and PDFs sent to the restaurant's own model; larger files are refused before upload. */
export const EXTRACTION_MAX_FILE_BYTES = 10 * 1024 * 1024;

const shortText = (max: number) => z.string().trim().max(max);

export const extractionOption = z.object({
  name: shortText(100).min(1),
  nameAr: shortText(100).nullable().default(null),
  /** Price added to the item, integer minor units (0 = free choice). */
  priceDeltaMinor: z.number().int().min(0).max(10_000_000),
});
export type ExtractionOption = z.infer<typeof extractionOption>;

export const extractionModifierGroup = z.object({
  name: shortText(80).min(1),
  nameAr: shortText(80).nullable().default(null),
  minSelect: z.number().int().min(0).max(10),
  maxSelect: z.number().int().min(1).max(20),
  options: z.array(extractionOption).min(1).max(30),
}).refine((g) => g.minSelect <= g.maxSelect, { message: 'Minimum selections cannot exceed the maximum', path: ['minSelect'] });
export type ExtractionModifierGroup = z.infer<typeof extractionModifierGroup>;

export const extractionRow = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  status: z.enum(['review', 'approved', 'rejected']),
  name: shortText(200),
  nameAr: shortText(200).nullable().default(null),
  category: shortText(200),
  description: shortText(2000).nullable().default(null),
  /** Integer minor units; null when the source shows no price (the row cannot be approved until one is entered). */
  priceMinor: z.number().int().nullable(),
  allergens: z.array(shortText(40)).max(30).default([]),
  modifiers: z.array(extractionModifierGroup).max(10).default([]),
  /** Imported items start unavailable (legacy behaviour) unless the reviewer ticks "available to order". */
  available: z.boolean().default(false),
  /** 0..1, from the parser or the model; low values are highlighted in the review table. */
  confidence: z.number().min(0).max(1),
  uncertainFields: z.array(z.string().max(40)).max(20).default([]),
  /** The source line(s) the row was read from (heuristic parser), for the reviewer. */
  source: z.string().max(400).nullable().default(null),
});
export type ExtractionRow = z.infer<typeof extractionRow>;

export const createTextExtraction = z.object({
  kind: z.enum(['text', 'csv']),
  text: z.string().min(1).max(200_000),
  name: z.string().trim().max(120).optional(),
});
export type CreateTextExtraction = z.infer<typeof createTextExtraction>;

export const updateExtractionDraft = z.object({
  /** The job version the edit was made on; a stale version is refused (409) instead of overwriting someone else's edit. */
  version: z.number().int().min(0),
  rows: z.array(extractionRow).max(EXTRACTION_MAX_ROWS),
});
export type UpdateExtractionDraft = z.infer<typeof updateExtractionDraft>;

export const commitExtraction = z.object({ version: z.number().int().min(0), key: idempotencyKey });
export type CommitExtraction = z.infer<typeof commitExtraction>;

export interface ExtractionRowCheck { id: string; errors: string[]; warnings: string[]; action: 'create' | 'update' | null }

export interface MenuExtractionJob {
  id: string;
  status: ExtractionStatus;
  mode: ExtractionMode;
  sourceKind: ExtractionSourceKind;
  sourceName: string | null;
  /** Who produced the draft: Resuto's own parser (no model involved) or the restaurant's own model key. */
  provider: 'resuto_parser' | typeof STUDIO_AI_PROVIDER;
  model: string | null;
  version: number;
  rows: ExtractionRow[];
  checks: ExtractionRowCheck[];
  uncertainties: string[];
  summary: { total: number; approved: number; rejected: number; review: number; errors: number; lowConfidence: number };
  error: string | null;
  attempts: number;
  commitResult: { created: number; updated: number; categoriesCreated: string[]; modifierGroupsCreated: number } | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

// ---------------------------------------------------------------------------
// Food-photo enhancement (upload -> durable job -> review -> approve -> publish)
// ---------------------------------------------------------------------------

export const PHOTO_JOB_STATUSES = ['queued', 'processing', 'review', 'approved', 'rejected', 'published', 'failed'] as const;
export type PhotoJobStatus = (typeof PHOTO_JOB_STATUSES)[number];
export const PHOTO_ASPECTS = ['1:1', '4:3', '3:2', '16:9', 'original'] as const;
export type PhotoAspect = (typeof PHOTO_ASPECTS)[number];

export const photoEnhanceParams = z.object({
  /** Crop to this aspect, centred on the dish (sharp attention strategy). */
  aspect: z.enum(PHOTO_ASPECTS).default('4:3'),
  /** Trim a uniform border (plates on a plain background) before cropping. */
  trimBorder: z.boolean().default(true),
  /** -1..1: added to the automatic exposure correction. */
  exposure: z.number().min(-1).max(1).default(0),
  /** Per-channel normalisation towards neutral grey. */
  whiteBalance: z.boolean().default(true),
  /** 0..1 local contrast (CLAHE) strength. */
  contrast: z.number().min(0).max(1).default(0.35),
  /** 0..1 unsharp-mask strength. */
  sharpen: z.number().min(0).max(1).default(0.5),
});
export type PhotoEnhanceParams = z.infer<typeof photoEnhanceParams>;

export const createPhotoJob = z.object({
  productId: z.uuid().optional(),
  /** 'generative' is refused while no restaurant-owned image provider is configured (it never is by default). */
  mode: z.enum(['deterministic', 'generative']).default('deterministic'),
  params: photoEnhanceParams.default(photoEnhanceParams.parse({})),
});
export type CreatePhotoJob = z.infer<typeof createPhotoJob>;

export const reviewPhotoJob = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(500).optional() });
export const publishPhotoJob = z.object({
  target: z.enum(['product', 'website_section']),
  productId: z.uuid().optional(),
  sectionId: z.uuid().optional(),
  key: idempotencyKey,
}).refine((b) => (b.target === 'product' ? !!b.productId && !b.sectionId : !!b.sectionId && !b.productId), { message: 'Name exactly one product or section for the target' });
export type PublishPhotoJob = z.infer<typeof publishPhotoJob>;

export interface PhotoJobView {
  id: string;
  status: PhotoJobStatus;
  /** deterministic = local exposure/white balance/contrast/sharpen/crop (no pixels invented); generative = a model edit (never the default). */
  mode: 'deterministic' | 'generative';
  provider: 'resuto_sharp' | string;
  model: string | null;
  params: PhotoEnhanceParams;
  productId: string | null;
  original: { mediaId: string; url: string; width: number | null; height: number | null; bytes: number };
  output: { mediaId: string; url: string; width: number | null; height: number | null; bytes: number; formats: Array<{ format: 'webp' | 'avif'; width: number; bytes: number }> } | null;
  provenance: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  published: { target: 'product' | 'website_section'; id: string; at: string } | null;
  createdAt: string;
}
