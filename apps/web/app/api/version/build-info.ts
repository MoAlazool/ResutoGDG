/** Build identity of the web app (CR-07). Pure, so it is unit-tested without a build. */
export interface WebBuildInfo { service: 'web'; commit: string | null; branch: string | null; builtAt: string }

const SHA = /^[0-9a-f]{7,40}$/i;

export function webBuildInfo(env: Record<string, string | undefined>, now: Date): WebBuildInfo {
  const raw = [env.VERCEL_GIT_COMMIT_SHA, env.GIT_COMMIT_SHA, env.NEXT_PUBLIC_GIT_COMMIT_SHA].find((v) => v && SHA.test(v.trim()));
  const branch = (env.VERCEL_GIT_COMMIT_REF ?? env.GIT_BRANCH ?? '').trim();
  const builtAt = env.BUILD_TIME && !Number.isNaN(Date.parse(env.BUILD_TIME)) ? new Date(env.BUILD_TIME) : now;
  return {
    service: 'web',
    commit: raw ? raw.trim().toLowerCase() : null,
    branch: /^[\w./-]{1,100}$/.test(branch) ? branch : null,
    builtAt: builtAt.toISOString(),
  };
}
