// REM-W08: zod 4 compiles object parsers with `new Function` when it may. To find out, building the first object
// schema probes `new Function("")`; the page CSP has no 'unsafe-eval' (lib/csp.ts), so every document that loaded
// @resuto/contracts reported a script-src 'eval' violation. With the JIT off zod skips the probe and parses through
// its interpreted path, which is what the CSP forced anyway (the probe failed and zod fell back to it).
//
// This module must run before any schema is built: lib/contracts-entry.ts imports it ahead of the contracts package,
// and next.config.ts points '@resuto/contracts' at that entry, so only bundles that already carry zod pay for it.
import { config } from 'zod';

config({ jitless: true });
