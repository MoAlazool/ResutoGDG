import { describe, expect, it } from 'vitest';
import { createAttemptKeys } from './attempt-keys';

describe('PS-14 attempt keys', () => {
  it('reuses the key for retries of one attempt and makes a new one after success or a state change', () => {
    let n = 0;
    const keys = createAttemptKeys(() => `key-${++n}`);
    const launch = 'c1:launch:live:approved';
    const first = keys.key(launch);
    expect(keys.key(launch)).toBe(first); // retry after a timeout: same key, so the API replays
    expect(keys.key('c2:launch:live:approved')).not.toBe(first); // another campaign
    expect(keys.key('c1:launch:live:launching')).not.toBe(first); // the campaign moved on: a new attempt
    keys.settled(launch);
    expect(keys.key(launch)).not.toBe(first); // after success the next click is a new attempt
  });

  it('defaults to random UUIDs', () => {
    const keys = createAttemptKeys();
    expect(keys.key('a')).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys.key('a')).toBe(keys.key('a'));
  });
});
