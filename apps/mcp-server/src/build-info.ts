import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Deployed commit and build time of the MCP server (audit CR-07); same rules as the API (apps/api build-info.ts). */
export interface BuildInfo { commit: string | null; branch: string | null; builtAt: string | null; startedAt: string }

const STARTED_AT = new Date().toISOString();
const SHA = /^[0-9a-f]{7,40}$/i;

export function readBuildInfo(env: Record<string, string | undefined> = process.env, codeFile = fileURLToPath(import.meta.url)): BuildInfo {
  const raw = [env.RENDER_GIT_COMMIT, env.GIT_COMMIT_SHA, env.SOURCE_VERSION].find((v) => v && SHA.test(v.trim()));
  let builtAt: string | null = null;
  if (env.BUILD_TIME && !Number.isNaN(Date.parse(env.BUILD_TIME))) builtAt = new Date(env.BUILD_TIME).toISOString();
  else { try { builtAt = statSync(codeFile).mtime.toISOString(); } catch { builtAt = null; } }
  const branch = (env.RENDER_GIT_BRANCH ?? env.GIT_BRANCH ?? '').trim();
  return { commit: raw ? raw.trim().toLowerCase() : null, branch: /^[\w./-]{1,100}$/.test(branch) ? branch : null, builtAt, startedAt: STARTED_AT };
}

export const buildHeader = (b: BuildInfo) => `mcp@${b.commit ? b.commit.slice(0, 12) : 'local'}`;
