import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const source = path.resolve(app, '../web/public');
const target = path.join(app, 'public');

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const directory of ['brand', 'fonts', 'landing']) {
  await cp(path.join(source, directory), path.join(target, directory), { recursive: true });
}

await writeFile(path.join(target, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), geolocation=(), microphone=()
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' mailto:

/fonts/*
  Cache-Control: public, max-age=31536000, immutable
  Access-Control-Allow-Origin: *

/brand/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800

/landing/*
  Cache-Control: public, max-age=86400, stale-while-revalidate=604800
`);

await writeFile(path.join(target, 'robots.txt'), `User-agent: *
Allow: /
Disallow: /dashboard/
Disallow: /login/
Disallow: /signup/
Sitemap: https://resuto.app/sitemap.xml
`);
