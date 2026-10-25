// The zod-free saved-report contracts (21-INSIGHTS) the Insights pages use, imported from their own source module
// rather than '@resuto/contracts' (the full entry, which carries zod) or '@resuto/contracts/lite' (one shared module on
// every route), as lib/contracts-home.ts does for the overview. Request schemas: packages/contracts/src/reports.ts.
export * from '../../../packages/contracts/src/report-sections';
