import { z } from 'zod';
import { DOMAIN_ERROR_CODES } from './error-codes';

/**
 * API conventions shared by the API, the web app and the MCP server (docs/API_STYLE.md).
 */

// ---------------------------------------------------------------------------
// Lists (audit PS-21 / PS-22)
// ---------------------------------------------------------------------------

/** Upper bound of `limit` on every list endpoint. */
export const MAX_LIST_LIMIT = 200;

/**
 * Query schema of a list endpoint: `limit` 1..max (default `defaultLimit`) and an opaque `cursor` (the previous page's
 * `nextCursor`). A negative, zero, fractional, non-numeric or too large limit is a 400 validation_failed, never a 500.
 * Extend it with the endpoint's own filters: `listQueryOf({ defaultLimit: 50 }).extend({ status: ... })`.
 */
/**
 * Longest `cursor` a list accepts. Cursors are base64url JSON of the last row's sort key and id; a text key of up to
 * 1,100 characters fits even when every character is JSON-escaped (1,100 × 6 bytes × 4/3 ≈ 8,800 plus the id), and
 * the URL stays far below Node's 16 KB header limit.
 */
export const CURSOR_MAX_LENGTH = 9_000;

export function listQueryOf(opts: { defaultLimit?: number; maxLimit?: number } = {}) {
  const max = Math.min(opts.maxLimit ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
  const def = Math.min(opts.defaultLimit ?? 50, max);
  return z.object({
    limit: z.coerce.number().int().min(1).max(max).default(def),
    cursor: z.string().min(1).max(CURSOR_MAX_LENGTH).optional(),
  });
}

/** The default list query: limit 1..200 (default 50) and cursor. */
export const listQuery = listQueryOf();
export type ListQuery = z.infer<typeof listQuery>;

/**
 * Lists that used to return every row: bounded now, but the default page is the maximum so existing screens that do
 * not follow `nextCursor` keep showing what they showed (up to 200 rows).
 */
export const fullListQuery = listQueryOf({ defaultLimit: MAX_LIST_LIMIT });

// ---------------------------------------------------------------------------
// Errors (audit PS-20)
// ---------------------------------------------------------------------------

/**
 * Codes the HTTP layer itself produces, with their status. Domain codes (DOMAIN_ERROR_CODES) carry the status of the
 * rule that raised them: 422 for a well-formed request a business rule refuses, 409 for a state conflict, 404/403/402
 * and so on as documented in docs/API_STYLE.md.
 */
export const HTTP_ERROR_CODES = {
  validation_failed: { status: 400, message: 'The request is invalid (details lists each field and why).' },
  invalid_json: { status: 400, message: 'The request body is not valid JSON.' },
  invalid_uuid: { status: 400, message: 'An identifier in the path is not a valid UUID.' },
  invalid_cursor: { status: 400, message: 'The cursor is not valid for this list.' },
  invalid_identifier: { status: 400, message: 'A value has the wrong format for its field.' },
  bad_request: { status: 400, message: 'The request could not be understood.' },
  unauthorized: { status: 401, message: 'Sign in again (missing, expired or invalid credentials).' },
  module_not_entitled: { status: 402, message: 'The restaurant\'s subscription does not include this module.' },
  forbidden: { status: 403, message: 'The caller may not do this.' },
  not_found: { status: 404, message: 'The resource (or route) does not exist or is not visible to the caller.' },
  method_not_allowed: { status: 405, message: 'The route does not accept this HTTP method.' },
  not_acceptable: { status: 406, message: 'The requested representation is not available.' },
  duplicate: { status: 409, message: 'A record with these details already exists.' },
  reference_invalid: { status: 409, message: 'A referenced record does not exist or is still in use.' },
  overlap: { status: 409, message: 'This conflicts with an existing booking.' },
  conflict: { status: 409, message: 'The request conflicts with the current state.' },
  gone: { status: 410, message: 'The resource existed but is no longer available.' },
  payload_too_large: { status: 413, message: 'The request body is too large.' },
  unsupported_media_type: { status: 415, message: 'The request body has an unsupported content type.' },
  constraint_violated: { status: 422, message: 'The data breaks a business rule.' },
  rate_limited: { status: 429, message: 'Too many requests: wait for Retry-After seconds.' },
  internal_error: { status: 500, message: 'Something went wrong. Retry; report the requestId if it persists.' },
  service_unavailable: { status: 503, message: 'The service is temporarily unavailable: retry after Retry-After seconds.' },
  db_timeout: { status: 503, message: 'The request took too long: retry after Retry-After seconds.' },
  db_unavailable: { status: 503, message: 'The service is busy: retry after Retry-After seconds.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type HttpErrorCode = keyof typeof HTTP_ERROR_CODES;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];
/** Every error code an API response may carry (generic HTTP codes plus domain codes). */
export type ErrorCode = HttpErrorCode | DomainErrorCode;

const KNOWN = new Set<string>([...Object.keys(HTTP_ERROR_CODES), ...DOMAIN_ERROR_CODES]);
export const isKnownErrorCode = (code: string): code is ErrorCode => KNOWN.has(code);

/** Generic code for an HTTP status that no more specific code describes. */
export function errorCodeForStatus(status: number): HttpErrorCode {
  switch (status) {
    case 400: return 'bad_request';
    case 401: return 'unauthorized';
    case 402: return 'module_not_entitled';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 405: return 'method_not_allowed';
    case 406: return 'not_acceptable';
    case 409: return 'conflict';
    case 410: return 'gone';
    case 413: return 'payload_too_large';
    case 415: return 'unsupported_media_type';
    case 422: return 'constraint_violated';
    case 429: return 'rate_limited';
    case 503: return 'service_unavailable';
    default: return status >= 500 ? 'internal_error' : 'bad_request';
  }
}

/** Zod schema of the error envelope (OpenAPI component "Error"). */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().describe('Stable machine-readable code (HTTP_ERROR_CODES or DOMAIN_ERROR_CODES).'),
    message: z.string().describe('Human-readable English message; clients translate by code.'),
    details: z.unknown().optional().describe('Code-specific details, e.g. [{ path, message }] for validation_failed.'),
    requestId: z.string().describe('The X-Request-Id of the request, for support and log correlation.'),
  }),
});
