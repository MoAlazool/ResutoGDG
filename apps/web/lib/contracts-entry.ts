// What '@resuto/contracts' resolves to in the web bundles (next.config.ts webpack alias): zod's JIT is switched off
// first (lib/zod-jitless.ts, REM-W08), then the contracts source is re-exported unchanged. ES modules evaluate their
// imports in order, so no contracts schema exists before the switch.
import './zod-jitless';

export * from '../../../packages/contracts/src/index';
