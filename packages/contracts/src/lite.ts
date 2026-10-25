// '@resuto/contracts/lite': the zod-free part of the contracts, for guest and public pages. The web resolves
// '@resuto/contracts' to one scope-hoisted module (apps/web/lib/contracts-entry.ts), so a page importing a single
// helper from it ships every contracts export any page uses, and zod with them. Helpers imported from here keep those
// pages free of the schema library. lite.test.ts checks that nothing reachable from this file imports zod at runtime;
// types still come from '@resuto/contracts' with `import type`.
export * from './locale-format';
export * from './money';
export * from './phone-format';
export * from './split';
export * from './options';
export * from './permissions';
export * from './units';
export * from './tax-rules';
export * from './social-links';
export * from './slugs';
export * from './marketplace';
export * from './whatsapp-onboarding';
export * from './onboarding';
export * from './csv';
export * from './studio-templates';
export * from './studio-sections';
export * from './reservation-rules';
export * from './funnel-beacon';
