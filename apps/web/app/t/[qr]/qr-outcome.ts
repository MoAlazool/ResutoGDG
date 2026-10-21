import type { ServerRead } from '@/components/guest/server';

/** The printed-code paths the venue lookup may send a guest to (FT-07): the branch's public ordering page. */
const VENUE_PATH = /^\/order\/[a-z0-9-]+\?branch=[a-z0-9-]+$/;

export type QrOutcome =
  | { kind: 'table' }                       // a table code, or the table lookup could not run: render the page
  | { kind: 'venue'; path: string }         // a migrated legacy venue (counter) code: redirect to its ordering page
  | { kind: 'missing' }                     // neither a table nor a venue: 404
  | { kind: 'unavailable' };                // the venue lookup failed (rate limited, API down): temporary, never a 404

/**
 * Decides what /t/<token> serves. Only explicit 404s from BOTH lookups make a 404; a venue lookup that failed for any
 * other reason (429 when every guest shares the web server's rate-limit bucket, 5xx, timeout) is a temporary error,
 * so a valid printed counter code is never turned into a "this code does not exist" page.
 */
export function qrOutcome(table: ServerRead<unknown>['status'], venue?: ServerRead<{ path: string }>): QrOutcome {
  if (table !== 'missing') return { kind: 'table' };
  if (!venue) return { kind: 'missing' };
  if (venue.status === 'ok') return VENUE_PATH.test(venue.data.path) ? { kind: 'venue', path: venue.data.path } : { kind: 'missing' };
  return venue.status === 'missing' ? { kind: 'missing' } : { kind: 'unavailable' };
}
