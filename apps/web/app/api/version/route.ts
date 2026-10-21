import { NextResponse } from 'next/server';
import { webBuildInfo } from './build-info';

/**
 * Deployed commit of the web app (audit CR-07): GET /api/version → { service, commit, branch, builtAt }.
 * Rendered once at build time (force-static), so builtAt is the build time and the commit is the one Vercel built
 * (VERCEL_GIT_COMMIT_SHA). Carries no secrets; the response also sets X-Build like the API, AI and MCP services.
 */
export const dynamic = 'force-static';

export function GET() {
  const info = webBuildInfo(process.env, new Date());
  return NextResponse.json(info, {
    headers: { 'X-Build': `web@${info.commit ? info.commit.slice(0, 12) : 'local'}`, 'Cache-Control': 'public, max-age=60' },
  });
}
