import { describe, expect, it } from 'vitest';
import { webBuildInfo } from './build-info';

// CR-07: the web app exposed no deployed-commit identity; QA rows could not name the build they tested.
describe('web build identity (/api/version)', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  it('reports the commit Vercel built and the build time', () => {
    expect(webBuildInfo({ VERCEL_GIT_COMMIT_SHA: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01', VERCEL_GIT_COMMIT_REF: 'claude/relaxed-mayer-omkl3f' }, now))
      .toEqual({ service: 'web', commit: 'abcdef0123456789abcdef0123456789abcdef01', branch: 'claude/relaxed-mayer-omkl3f', builtAt: '2026-10-21T12:00:00.000Z' });
    expect(webBuildInfo({ BUILD_TIME: '2026-10-20T08:00:00Z' }, now).builtAt).toBe('2026-10-20T08:00:00.000Z');
  });
  it('says honestly when the commit is unknown and never echoes junk', () => {
    expect(webBuildInfo({ VERCEL_GIT_COMMIT_SHA: '<img src=x>', VERCEL_GIT_COMMIT_REF: 'a b' }, now)).toMatchObject({ commit: null, branch: null });
  });
});
