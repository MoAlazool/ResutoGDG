// The zod-free contracts the overview command centre (21-HOME) uses, imported from their own source modules rather
// than '@resuto/contracts' (the scope-hoisted full entry, which carries zod) or '@resuto/contracts/lite'. Lite is one
// shared module on every route and webpack keeps every export any page uses, so helpers that only the overview needs
// would otherwise ship to every page. (renderInsight is not here: insight-templates is part of the full contracts
// chunk most staff routes load, and importing it on its own split that chunk, adding ~0.4 kB to every route; the
// overview's "Next actions" row loads lazily and takes it from '@resuto/contracts'.)
export * from '../../../packages/contracts/src/home-sections';
