// CSV for menu import and export (zod-free: exported from '@resuto/contracts/lite' so the onboarding wizard's
// spreadsheet worker can read and write it without the schema library). The API parses the same way.

/** RFC 4180 CSV parser (port of legacy data-tools.parseCSV): quoted fields, CRLF, BOM. */
export function parseCsv(input: string): Array<Record<string, string>> {
  if (input.length > 1_000_000) throw new RangeError('CSV must be smaller than 1 MB.');
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(value); value = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && input[i + 1] === '\n') i++;
      row.push(value);
      if (row.some((x) => x.trim())) rows.push(row);
      row = []; value = '';
    } else value += c;
  }
  if (quoted) throw new RangeError('CSV has an unclosed quoted field.');
  row.push(value);
  if (row.some((x) => x.trim())) rows.push(row);
  const columns = (rows.shift() ?? []).map((x) => x.replace(/^﻿/, '').trim());
  if (new Set(columns).size !== columns.length) throw new RangeError('Duplicate CSV columns.');
  return rows.map((r, i) => {
    if (r.length !== columns.length) throw new RangeError(`Incorrect column count at row ${i + 2}`);
    return Object.fromEntries(columns.map((c, n) => [c, r[n] ?? '']));
  });
}

/** Escapes a CSV cell against formula injection (legacy toCSV behaviour). */
export function csvCell(v: unknown): string {
  let s = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export const toCsv = (rows: Array<Record<string, unknown>>) => {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]!);
  return [keys, ...rows.map((r) => keys.map((k) => r[k]))].map((r) => r.map(csvCell).join(',')).join('\r\n');
};
