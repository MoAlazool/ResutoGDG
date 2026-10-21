import { statSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';

/**
 * Identity of the running build (audit CR-07): which commit is deployed and when it was built, so every QA result can
 * name the code it tested.
 *
 * - commit: the hosting platform's variable (Render sets RENDER_GIT_COMMIT; GIT_COMMIT_SHA / SOURCE_VERSION /
 *   VERCEL_GIT_COMMIT_SHA are accepted for other hosts and CI). Null when unknown (a local build).
 * - builtAt: BUILD_TIME when the build sets it, otherwise the modification time of the compiled code (the build step
 *   writes dist/), so a container that only restarts keeps its build time.
 * - startedAt: when this process started (a restart is visible without a deploy).
 */
export interface BuildInfo {
  commit: string | null;
  shortCommit: string | null;
  branch: string | null;
  builtAt: string | null;
  startedAt: string;
  service: string;
}

const STARTED_AT = new Date().toISOString();
const SHA = /^[0-9a-f]{7,40}$/i;

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env, codeFile: string = __filename, service = 'api'): BuildInfo {
  const raw = [env.RENDER_GIT_COMMIT, env.GIT_COMMIT_SHA, env.SOURCE_VERSION, env.VERCEL_GIT_COMMIT_SHA].find((v) => v && SHA.test(v.trim()));
  const commit = raw ? raw.trim().toLowerCase() : null;
  let builtAt: string | null = null;
  if (env.BUILD_TIME && !Number.isNaN(Date.parse(env.BUILD_TIME))) builtAt = new Date(env.BUILD_TIME).toISOString();
  else {
    try { builtAt = statSync(codeFile).mtime.toISOString(); } catch { builtAt = null; }
  }
  const branch = (env.RENDER_GIT_BRANCH ?? env.GIT_BRANCH ?? env.VERCEL_GIT_COMMIT_REF ?? '').trim();
  return { commit, shortCommit: commit ? commit.slice(0, 12) : null, branch: /^[\w./-]{1,100}$/.test(branch) ? branch : null, builtAt, startedAt: STARTED_AT, service };
}

let cached: BuildInfo | null = null;
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo();
  return cached;
}

/** Value of the X-Build response header: "<service>@<short sha>" or "<service>@local" when the commit is unknown. */
export const buildHeaderValue = (b: BuildInfo = buildInfo()) => `${b.service}@${b.shortCommit ?? 'local'}`;

/** Adds X-Build to every API response (also on errors), so a tester or a log line can name the deployed commit. */
export function buildHeaderMiddleware() {
  const value = buildHeaderValue();
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Build', value);
    next();
  };
}
