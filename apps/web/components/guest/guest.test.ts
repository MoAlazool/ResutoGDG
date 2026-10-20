import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billStage } from './bill-state';
import { MAX_BACKOFF_MS, nextDelay, POLL_MS, pollsPerMinute } from './schedule';
import { reservationIcs, timeLeft } from '../../app/reserve/[slug]/calendar';

const repo = join(__dirname, '..', '..', '..', '..');
/** Every guest-facing route and the consumer shell. */
const GUEST_ROOTS = ['apps/web/app/t', 'apps/web/app/order', 'apps/web/app/reserve', 'apps/web/app/pay', 'apps/web/app/s', 'apps/web/app/o',
  'apps/web/components/guest'];

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}
const guestSources = () => GUEST_ROOTS.flatMap((r) => [...files(join(repo, r))]);

describe('table bill state (VP-18)', () => {
  const bill = (orders: string[], totalMinor: number, dueMinor: number, url: string | null = null) =>
    ({ orders: orders.map((status) => ({ status })), totals: { totalMinor, dueMinor }, pendingCheckout: url ? { url } : null });

  it('an empty table is never "fully paid"', () => {
    expect(billStage(bill([], 0, 0))).toBe('empty');
    expect(billStage(bill(['cancelled', 'cancelled'], 0, 0))).toBe('empty');
    expect(billStage(bill(['placed'], 0, 0))).toBe('empty');
  });

  it('is due until the server records the payment, and settled only then', () => {
    expect(billStage(bill(['placed'], 12000, 12000))).toBe('due');
    expect(billStage(bill(['served', 'cancelled'], 12000, 4000))).toBe('due');
    expect(billStage(bill(['served'], 12000, 12000, 'https://pay.example/c/1'))).toBe('pending');
    expect(billStage(bill(['served'], 12000, 0))).toBe('settled');
  });
});

describe('guest polling cadence (PCL-18)', () => {
  it('polls every 5 s and backs off to at most 30 s after failures', () => {
    expect(nextDelay(0)).toBe(POLL_MS);
    expect(nextDelay(1)).toBe(10_000);
    expect(nextDelay(2)).toBe(20_000);
    expect(nextDelay(3)).toBe(MAX_BACKOFF_MS);
    expect(nextDelay(50)).toBe(MAX_BACKOFF_MS);
  });

  it('a table of six phones stays inside the per-token (240/min) and per-address (1200/min) read limits', () => {
    expect(6 * pollsPerMinute()).toBeLessThanOrEqual(240);
    // A whole dining room behind one café Wi-Fi address: 16 tables of four.
    expect(16 * 4 * pollsPerMinute()).toBeLessThanOrEqual(1200);
  });
});

describe('reservation deposit and calendar (FT-11)', () => {
  it('counts the deposit window down in mm:ss with Western digits and never below zero', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    expect(timeLeft('2026-10-20T10:09:05Z', now)).toEqual({ ms: 545_000, text: '9:05' });
    expect(timeLeft('2026-10-20T09:59:00Z', now)).toEqual({ ms: 0, text: '0:00' });
    expect(timeLeft(null, now).ms).toBe(0);
  });

  it('writes one calendar event in UTC with escaped text', () => {
    const ics = reservationIcs({ id: 'r1', startsAt: '2026-10-21T18:00:00Z', endsAt: '2026-10-21T19:30:00Z' }, 'Olive, Zamalek; T4', Date.parse('2026-10-20T10:00:00Z'));
    expect(ics).toContain('DTSTART:20261021T180000Z');
    expect(ics).toContain('DTEND:20261021T193000Z');
    expect(ics).toContain('SUMMARY:Olive\\, Zamalek\\; T4');
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  });
});

describe('guest pages: bidi isolation and glyphs (DF-07)', () => {
  // Phones, emails and names typed by guests are isolated (<bdi>) — never concatenated into a sentence with a
  // template string, which reorders them in Arabic ("201090001004+").
  const FIELD = /\$\{[^}]*\b(phone|guestPhone|customerPhone|email|guestEmail|address|guestName|customerName|payerName|fullName|displayName)\b[^}]*\}/i;

  it('no guest page interpolates phones, emails or guest names into display strings', () => {
    const offenders: string[] = [];
    for (const f of guestSources()) {
      if (!f.endsWith('.tsx')) continue;
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const shown = line.replace(/(href|to|src)=\{`[^`]*`\}/g, '').replace(/\b(api|fetch|serverRead)<[^>]*>\(`[^`]*`/g, '');
        if (FIELD.test(shown)) offenders.push(`${relative(repo, f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('no colour emoji on guest pages (the legacy consumer app uses typographic glyphs)', () => {
    const EMOJI = /[\u{1F300}-\u{1FAFF}\u{23F0}-\u{23F3}\u{2600}-\u{26FF}\u{2700}-\u{27BF}](?!\u{FE0E})/u;
    const ALLOWED = new Set(['✓', '★', '☆', '✕', '✦', '✧', '✎', '♥']);
    const offenders: string[] = [];
    for (const f of guestSources()) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        const hits = [...line].filter((c) => EMOJI.test(c) && !ALLOWED.has(c));
        if (hits.length) offenders.push(`${relative(repo, f)}:${i + 1}: ${hits.join(' ')}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('guest pages format numbers through the shared formatters, never a raw ar-EG locale tag', () => {
    const offenders: string[] = [];
    for (const f of guestSources()) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/['"`]ar-(EG|SA)['"`]/.test(line)) offenders.push(`${relative(repo, f)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
