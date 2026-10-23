import { describe, expect, it } from 'vitest';
import { qrOutcome } from './qr-outcome';

// Review finding on CR-13: a valid printed venue (counter) code returned 404 whenever the venue lookup was rate limited
// (every guest shares the web server's bucket) or the API was down, because any non-ok venue result became notFound().
describe('/t/<token> outcome', () => {
  const ok = (path: string) => ({ status: 'ok' as const, data: { path } });

  it('a table code (or a table lookup that could not run) renders the table page without asking for a venue', () => {
    expect(qrOutcome('ok')).toEqual({ kind: 'table' });
    expect(qrOutcome('unavailable')).toEqual({ kind: 'table' });
  });

  it('a migrated venue code redirects to its ordering page', () => {
    expect(qrOutcome('missing', ok('/order/smash-and-co?branch=main'))).toEqual({ kind: 'venue', path: '/order/smash-and-co?branch=main' });
  });

  it('a migrated venue code of a counter branch redirects to its counter page (FT-07)', () => {
    const code = 'a'.repeat(32);
    expect(qrOutcome('missing', ok(`/v/${code}`))).toEqual({ kind: 'venue', path: `/v/${code}` });
    // Only a plain counter token path: no other host, no query, no traversal.
    expect(qrOutcome('missing', ok('/v/short'))).toEqual({ kind: 'missing' });
    expect(qrOutcome('missing', ok(`/v/${code}?next=//evil.example`))).toEqual({ kind: 'missing' });
    expect(qrOutcome('missing', ok(`/v/${code}/../../admin`))).toEqual({ kind: 'missing' });
  });

  it('a rate-limited or failing venue lookup is temporary, never a 404', () => {
    expect(qrOutcome('missing', { status: 'unavailable' })).toEqual({ kind: 'unavailable' });
  });

  it('only explicit 404s from both lookups make a 404, and an unexpected redirect target is refused', () => {
    expect(qrOutcome('missing', { status: 'missing' })).toEqual({ kind: 'missing' });
    expect(qrOutcome('missing')).toEqual({ kind: 'missing' });
    expect(qrOutcome('missing', ok('https://evil.example/order/x?branch=y'))).toEqual({ kind: 'missing' });
    expect(qrOutcome('missing', ok('//evil.example'))).toEqual({ kind: 'missing' });
  });
});
