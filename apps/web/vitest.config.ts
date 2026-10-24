import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Web unit tests. The '@/…' alias matches tsconfig "paths" so a test can import and render a screen component
// (react-dom/server) instead of matching its source text; JSX uses the automatic runtime like Next.
// The @resuto/ui component tests (packages/ui/test, jsdom per file) run here too, so CI's web test job covers them.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: `${fileURLToPath(new URL('./', import.meta.url))}` }] },
  esbuild: { jsx: 'automatic' },
  test: {
    include: [...configDefaults.include, '../../packages/ui/test/**/*.test.{ts,tsx}'],
  },
});
