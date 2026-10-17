import type { TenantContext } from '../../common/auth/context';
import { DomainError } from '../../common/errors/domain-error';

/** Largest JSON tool result returned to an MCP client. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** Sensitive requests wait this long for a human decision. */
export const APPROVAL_TTL_HOURS = 24;

export const invalidInput = (message: string, details?: unknown) => new DomainError('invalid_input', message, 400, details);

/** "+201001234567" → "+20•••••••67" */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  if (phone.length <= 5) return '•'.repeat(phone.length);
  return `${phone.slice(0, 3)}${'•'.repeat(Math.max(phone.length - 5, 3))}${phone.slice(-2)}`;
}

/** "mona@example.com" → "m•••@example.com" */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

/** "Mona Adel Hassan" → "Mona A." */
export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  const [first, second] = name.trim().split(/\s+/);
  return second ? `${first} ${second[0]}.` : first ?? null;
}

/** PII is shown in full only when the acting role may read customers. */
export const piiVisible = (ctx: TenantContext) => ctx.can('customers:read');

/** Branch filter for a tool call: explicit branch (checked) or the client's scope (null = all). */
export function branchScope(ctx: TenantContext, branchId?: string): string[] | null {
  if (branchId) {
    ctx.assertBranch(branchId);
    return [branchId];
  }
  return ctx.branchFilter;
}

export function encodeCursor(parts: Array<string | number>): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, arity: number): string[] | null {
  if (!cursor) return null;
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === arity && parts.every((p) => typeof p === 'string' || typeof p === 'number')) {
      return parts.map(String);
    }
  } catch { /* fall through */ }
  throw invalidInput('The cursor is invalid; call the tool again without it');
}

export const iso = (v: Date | string | null | undefined): string | null => (v ? new Date(v).toISOString() : null);

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Calendar-day difference for YYYY-MM-DD strings. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function assertPeriod(from: string, to: string, maxDays = 366) {
  const d = daysBetween(from, to);
  if (d < 0) throw invalidInput('"from" must be on or before "to"');
  if (d >= maxDays) throw invalidInput(`The period may cover at most ${maxDays} days`);
}
