import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '../..');

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  transpilePackages: ['@resuto/contracts'],
  experimental: { externalDir: true },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      '@resuto/contracts$': path.join(repoRoot, 'packages/contracts/src/index.ts'),
      '@resuto/contracts/lite$': path.join(repoRoot, 'packages/contracts/src/lite.ts'),
    };
    return config;
  },
};

export default config;
