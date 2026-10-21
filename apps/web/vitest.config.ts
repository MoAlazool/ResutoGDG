import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Web unit tests. The '@/…' alias matches tsconfig "paths" so a test can import and render a screen component
// (react-dom/server) instead of matching its source text; JSX uses the automatic runtime like Next.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: `${fileURLToPath(new URL('./', import.meta.url))}` }] },
  esbuild: { jsx: 'automatic' },
});
