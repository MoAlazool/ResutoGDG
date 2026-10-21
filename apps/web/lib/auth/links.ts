/**
 * AUTH-03: what an email link brought back to /auth/callback, and which flow it belongs to, so the page can say what
 * happened and offer the right way to get a new link. Supabase Auth reports link problems as `error`, `error_code`
 * and `error_description` in the query (PKCE) or the fragment (implicit flow), e.g.
 * `#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`. The first of
 * the two "secure email change" links carries `message=Confirmation link accepted. Please proceed to confirm link
 * sent to the other email` and no session.
 */
export type LinkFlow = 'signup' | 'reset' | 'email_change';
export type LinkProblem = 'link_expired' | 'link_invalid' | 'link_other_browser';

export type ParsedLink =
  | { kind: 'error'; problem: LinkProblem; description: string | null }
  | { kind: 'message'; message: string }
  | { kind: 'code'; code: string; type: string | null }
  | { kind: 'tokens'; type: string | null }
  | { kind: 'none' };

export function parseAuthLink(href: string): ParsedLink {
  let url: URL;
  try { url = new URL(href); } catch { return { kind: 'error', problem: 'link_invalid', description: null }; }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const get = (k: string) => url.searchParams.get(k) ?? hash.get(k);
  const error = get('error'), errorCode = get('error_code');
  if (error || errorCode) {
    const description = get('error_description');
    const expired = errorCode === 'otp_expired' || /expired/i.test(description ?? '');
    return { kind: 'error', problem: expired ? 'link_expired' : 'link_invalid', description };
  }
  const type = get('type');
  const code = url.searchParams.get('code');
  if (code) return { kind: 'code', code, type };
  if (hash.get('access_token')) return { kind: 'tokens', type };
  const message = get('message');
  if (message) return { kind: 'message', message };
  return { kind: 'none' };
}

/** Which email flow a callback belongs to, from the validated `next` the link was created with. */
export function linkFlow(next: string | null | undefined): LinkFlow {
  if (next === '/reset-password') return 'reset';
  if (next === '/account/security') return 'email_change';
  return 'signup';
}

/** A PKCE exchange that failed because this browser does not hold the code verifier (link opened elsewhere). */
export function isOtherBrowserError(err: unknown): boolean {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== 'object') return false;
  return e.name === 'AuthPKCEGrantCodeExchangeError' || e.code === 'bad_code_verifier' || e.code === 'flow_state_not_found'
    || /code verifier|flow state/i.test(String(e.message ?? ''));
}

/** Supabase answers a too-early resend with "For security purposes, you can only request this after 42 seconds." */
export function retryAfterSeconds(err: unknown, fallback = 60): number {
  const m = /after (\d+) seconds?/i.exec(String((err as { message?: unknown } | null)?.message ?? ''));
  return m ? Math.min(Math.max(Number(m[1]), 1), 3600) : fallback;
}

/** Seconds between two confirmation / reset emails (Supabase's default per-user limit is 60 s). */
export const RESEND_COOLDOWN_S = 60;
