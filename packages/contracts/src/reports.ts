// Saved Insights reports (21-INSIGHTS): request schemas of GET/POST /o/:orgId/reports and PATCH/DELETE
// /o/:orgId/reports/:reportId. Zod-free constants and the response shape: ./report-sections.ts. Subpath export
// '@resuto/contracts/reports' (not in the main entry), like '@resuto/contracts/home'.
import { z } from 'zod';
import { MAX_ANALYTICS_DAYS } from './analytics';
import { listQueryOf } from './api';
import { isoDate, uuid } from './common';
import {
  REPORT_COMPARE, REPORT_FILTERS, REPORT_PERIODS, REPORT_SECTIONS, SAVED_REPORT_NAME_MAX, validReportFilter, type ReportSection,
} from './report-sections';

export * from './report-sections';

export const reportsContractsVersion = 1 as const;

const filterKey = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,31}$/);
const filterValue = z.string().min(1).max(100);

/** Period, comparison and page filters of a report. A custom period needs both dates, in order, at most 400 days. */
export const reportViewInput = z.object({
  period: z.enum(REPORT_PERIODS),
  from: isoDate.optional(),
  to: isoDate.optional(),
  compare: z.enum(REPORT_COMPARE).default('previous_period'),
  filters: z.record(filterKey, filterValue).default({}).refine((f) => Object.keys(f).length <= 10, { message: 'at most 10 filters' }),
}).strict()
  .refine((v) => v.period === 'custom' ? !!v.from && !!v.to : v.from === undefined && v.to === undefined,
    { message: 'from and to go with period "custom" only', path: ['from'] })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: 'from must not be after to', path: ['to'] })
  .refine((v) => !v.from || !v.to || (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 < MAX_ANALYTICS_DAYS,
    { message: `at most ${MAX_ANALYTICS_DAYS} days`, path: ['from'] });
export type ReportViewInput = z.infer<typeof reportViewInput>;

/** The filters `view` sets that `section` does not keep (empty = valid). */
export const unknownReportFilters = (section: ReportSection, filters: Record<string, string>) =>
  Object.entries(filters).filter(([k, v]) => !validReportFilter(section, k, v)).map(([k]) => k);

const name = z.string().trim().min(1).max(SAVED_REPORT_NAME_MAX);

export const savedReportInput = z.object({
  name,
  section: z.enum(REPORT_SECTIONS),
  view: reportViewInput,
  /** null or absent: every branch the viewer can see. Branch-scoped staff may only name one of their branches. */
  branchId: uuid.nullable().optional(),
  /** Share with colleagues who may read analytics (private by default). */
  shared: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  for (const key of unknownReportFilters(v.section, v.view.filters)) {
    ctx.addIssue({ code: 'custom', path: ['view', 'filters', key], message: `"${key}" is not a filter of the ${v.section} view` });
  }
});
export type SavedReportInput = z.infer<typeof savedReportInput>;

/** Rename, re-save the view, move it to another branch, or share/unshare it (the section stays). */
export const savedReportUpdate = z.object({
  name: name.optional(),
  view: reportViewInput.optional(),
  branchId: uuid.nullable().optional(),
  shared: z.boolean().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type SavedReportUpdate = z.infer<typeof savedReportUpdate>;

/** The caller's own reports and the reports colleagues shared, most recently changed first. */
export const savedReportListQuery = listQueryOf({ defaultLimit: 100 }).extend({
  section: z.enum(REPORT_SECTIONS).optional(),
  /** mine: only the caller's own; shared: only colleagues' shared reports; all (default): both. */
  owner: z.enum(['all', 'mine', 'shared']).default('all'),
});
export type SavedReportListQuery = z.infer<typeof savedReportListQuery>;

/** Every section keeps only its own filters (for documentation and the web's URL handling). */
export const REPORT_FILTER_KEYS: Record<ReportSection, string[]> = Object.fromEntries(
  REPORT_SECTIONS.map((s) => [s, Object.keys(REPORT_FILTERS[s])])) as Record<ReportSection, string[]>;
