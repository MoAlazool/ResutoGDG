/**
 * AUTH-01: the password rules Resuto applies before a new password reaches Supabase Auth (sign-up, reset, change).
 *
 * Supabase's leaked-password protection (HaveIBeenPwned) is a paid-plan feature and Resuto runs on the Free plan, so
 * this is a COMPENSATING, CLIENT-SIDE control: anyone calling Supabase Auth directly with the public anon key skips
 * it. The server-side floor is the Supabase dashboard setting "minimum password length 10 + required characters"
 * (available on Free); see docs/SECURITY_AUTH.md.
 *
 * The breach check uses the free Pwned Passwords range API with k-anonymity: only the first 5 hex characters of the
 * password's SHA-1 leave the browser, the response lists every known suffix for that prefix (padded with decoy rows
 * whose count is 0, `Add-Padding: true`), and the match happens here. If the service cannot be reached in time the
 * password is NOT blocked (the check is logged as unavailable): an outage of a third-party service must not stop
 * staff from setting a password.
 */
export const MIN_PASSWORD = 10;
/**
 * Supabase Auth (GoTrue) refuses passwords longer than 72 BYTES (bcrypt input limit; internal/api/password.go uses Go
 * len(), i.e. UTF-8 bytes): 72 Latin characters, about 36 Arabic letters. `maxLength` on inputs counts characters, so
 * `passwordBytes` is what decides. The minimum stays in characters: never looser than Supabase's byte count.
 */
export const MAX_PASSWORD = 72;
export const passwordBytes = (password: string) => new TextEncoder().encode(password).length;
export const PWNED_RANGE_URL = 'https://api.pwnedpasswords.com/range/';
const PWNED_TIMEOUT_MS = 4000;

export type PasswordIssue = 'password_too_short' | 'password_too_long' | 'password_common' | 'password_contains_email'
  | 'password_contains_brand' | 'password_breached';

export type BreachCheck = 'clear' | 'breached' | 'unavailable' | 'skipped';
export interface PasswordVerdict {
  issue: PasswordIssue | null;
  /** What the breach lookup said ('skipped' when a local rule already failed). */
  breachCheck: BreachCheck;
  /** How often the password appears in the breach corpus (only when breached). */
  breachCount?: number;
}

/**
 * Very common passwords of 10+ characters (the length rule already rejects shorter ones), and base words that people
 * pad with digits or symbols to reach the minimum. The breach lookup catches far more; this list works offline.
 */
const COMMON = new Set([
  '1234567890', '0123456789', '0987654321', '1234512345', '1122334455', '1qaz2wsx3edc', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5',
  'qwertyuiop', 'asdfghjkl;', 'zxcvbnm,./', 'qazwsxedc123', 'abcdefghij', 'abcd123456', 'abc1234567', 'aa12345678', 'a123456789',
  '123456789a', '12345678910', '123456789q', '1234567890q', '11223344556677', '123123123123', 'iloveyou123', 'monkey12345',
  'trustno1234', 'superman123', 'starwars123', 'whatever123', 'football123', 'baseball123', 'basketball', 'princess123', 'sunshine123',
  'charlie123', 'dragon12345', 'master12345', 'michael123', 'shadow12345', 'qwer1234qwer', 'changeme123', 'default123',
]);
const COMMON_BASES = /^(password|passw0rd|p@ssw0rd|p@ssword|qwerty|qwertyuiop|asdfgh|zxcvbn|iloveyou|welcome|letmein|admin|administrator|login|secret|changeme|default|restaurant|kitchen|manager|cashier|owner|egypt|cairo|riyadh|saudi|1234|12345|123456|abc|abcd)[\d!@#$%^&*._\-+=?]*$/;
const BRAND = /resuto|ريسوتو/i;

/** Rules that need no network: length, very common passwords, the account's email and the product name. */
export function localPasswordIssue(password: string, ctx: { email?: string | null } = {}): PasswordIssue | null {
  if (password.length < MIN_PASSWORD) return 'password_too_short';
  if (passwordBytes(password) > MAX_PASSWORD) return 'password_too_long';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON_BASES.test(lower) || new Set(lower).size <= 2) return 'password_common';
  const email = (ctx.email ?? '').trim().toLowerCase();
  const local = email.split('@')[0] ?? '';
  if (email && (lower.includes(email) || (local.length >= 4 && lower.includes(local)))) return 'password_contains_email';
  if (BRAND.test(password)) return 'password_contains_brand';
  return null;
}

/** Upper-case hex SHA-1 (the Pwned Passwords API format). Web Crypto: browsers and Node 18+. */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export interface PwnedOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Called when the lookup could not be completed (the password is then not blocked). */
  onUnavailable?: (reason: string) => void;
}

/**
 * How many times the password appears in the Pwned Passwords corpus (0 = not found), or null when the service could
 * not be reached or answered unexpectedly. Only the 5-character hash prefix is sent.
 */
export async function pwnedCount(password: string, opts: PwnedOptions = {}): Promise<number | null> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5), suffix = hash.slice(5);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PWNED_TIMEOUT_MS);
  try {
    const res = await doFetch(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { 'Add-Padding': 'true' }, signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!res.ok) { opts.onUnavailable?.(`HTTP ${res.status}`); return null; }
    const body = await res.text();
    if (!/^[0-9A-F]{35}:\d+/im.test(body)) { opts.onUnavailable?.('unexpected response'); return null; }
    for (const line of body.split(/\r?\n/)) {
      const [s, n] = line.trim().split(':');
      // Padding rows are random suffixes with a count of 0: a 0 count is never a breach.
      if (s?.toUpperCase() === suffix) return Math.max(0, Number(n) || 0);
    }
    return 0;
  } catch (e) {
    opts.onUnavailable?.((e as Error)?.name === 'AbortError' ? 'timeout' : 'network');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The full check for a NEW password: local rules first (no network when they fail), then the breach lookup. */
export async function checkNewPassword(password: string, ctx: { email?: string | null } = {}, opts: PwnedOptions = {}): Promise<PasswordVerdict> {
  const local = localPasswordIssue(password, ctx);
  if (local) return { issue: local, breachCheck: 'skipped' };
  const onUnavailable = opts.onUnavailable ?? ((reason: string) => {
    // Never log the password or its hash; only that the compensating check did not run.
    console.warn(`[auth] breached-password check unavailable (${reason}); the password was accepted without it.`);
  });
  const count = await pwnedCount(password, { ...opts, onUnavailable });
  if (count === null) return { issue: null, breachCheck: 'unavailable' };
  if (count > 0) return { issue: 'password_breached', breachCheck: 'breached', breachCount: count };
  return { issue: null, breachCheck: 'clear' };
}
