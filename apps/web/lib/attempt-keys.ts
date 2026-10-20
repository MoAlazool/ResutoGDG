/**
 * One Idempotency-Key per logical attempt (PS-14). The same key is reused while the person retries the same action on
 * the same object in the same state (a second click after a timeout or a network error), so the API replays the first
 * result instead of acting twice. A new key is made once the attempt succeeded, or when the scope changes (the object
 * moved to another state, so it is a new attempt). The API stores a key's result only when the call succeeded, so
 * reusing a key after a failure simply runs the call again.
 */
export interface AttemptKeys {
  /** The key for this attempt (created on first use). */
  key(scope: string): string;
  /** The attempt finished successfully: the next call in this scope is a new attempt. */
  settled(scope: string): void;
}

export function createAttemptKeys(newKey: () => string = () => crypto.randomUUID()): AttemptKeys {
  const keys = new Map<string, string>();
  return {
    key(scope) {
      let k = keys.get(scope);
      if (!k) { k = newKey(); keys.set(scope, k); }
      return k;
    },
    settled(scope) { keys.delete(scope); },
  };
}
