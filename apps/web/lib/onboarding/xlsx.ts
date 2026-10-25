// A small, dependency-free reader for the first sheet of an .xlsx workbook (21-ONB menu import). It runs inside the
// spreadsheet worker (lib/onboarding/spreadsheet.worker.ts), so it uses no DOM: the zip container is read by hand,
// entries are inflated with the platform's DecompressionStream('deflate-raw'), and the few OOXML parts needed
// (workbook, its relationships, shared strings, one worksheet) are read with bounded regular expressions.
//
// Why not a library: SheetJS on npm is an old release with open advisories (pnpm audit), and the maintained readers
// (exceljs, read-excel-file + jszip) add 100-400 kB to a phone page. A menu sheet needs text and numbers only, so
// this reads cell values (shared strings, inline strings, numbers, booleans, formula results) and ignores styles,
// formulas, merged cells and every other sheet. Limits keep a hostile file from exhausting the browser.

export const XLSX_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Inflated size cap per zip entry (a zip bomb stops here). */
export const XLSX_MAX_ENTRY_BYTES = 20 * 1024 * 1024;
export const SHEET_MAX_ROWS = 301; // header + IMPORT_MAX_ROWS
export const SHEET_MAX_COLUMNS = 40;

export class SpreadsheetError extends Error {
  constructor(readonly code: 'not_xlsx' | 'too_large' | 'unsupported' | 'empty' | 'too_many_rows', message: string) {
    super(message);
    this.name = 'SpreadsheetError';
  }
}

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const utf8 = new TextDecoder('utf-8');

/** The central directory of a zip file (no zip64, no encryption: an .xlsx menu is far below either). */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new SpreadsheetError('not_xlsx', 'not an Excel (.xlsx) file');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new SpreadsheetError('not_xlsx', 'damaged zip directory');
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const compressedSize = u32(bytes, p + 20);
    const size = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (flags & 1) throw new SpreadsheetError('unsupported', 'password-protected workbooks are not supported');
    out.set(name, { name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel(); throw new SpreadsheetError('too_large', 'the workbook is too large'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** One zip entry as text, or null when the workbook has no such part. */
export async function readEntry(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string): Promise<string | null> {
  const e = entries.get(name);
  if (!e) return null;
  if (e.size > XLSX_MAX_ENTRY_BYTES) throw new SpreadsheetError('too_large', 'the workbook is too large');
  const h = e.offset;
  if (h + 30 > bytes.length || u32(bytes, h) !== 0x04034b50) throw new SpreadsheetError('not_xlsx', 'damaged zip entry');
  const start = h + 30 + u16(bytes, h + 26) + u16(bytes, h + 28);
  const data = bytes.subarray(start, start + e.compressedSize);
  if (e.method === 0) return utf8.decode(data);
  if (e.method === 8) return utf8.decode(await inflateRaw(data, XLSX_MAX_ENTRY_BYTES));
  throw new SpreadsheetError('unsupported', 'this workbook uses an unsupported compression');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/** XML text: entities, numeric references and OOXML's _xHHHH_ escapes. */
export function xmlText(s: string): string {
  return s
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e] ?? m;
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The text of every <t> in a string item or inline string (rich-text runs joined; phonetic runs dropped). */
const itemText = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1]!)).join('');

export function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) => (m[1] ? itemText(m[1]) : ''));
}

/** The worksheet path of the first sheet listed in the workbook. */
export function firstSheetPath(workbook: string | null, rels: string | null): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  const sheet = workbook && /<sheet\b[^>]*?\br:id="([^"]+)"/.exec(workbook);
  if (!sheet || !rels) return fallback;
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    if (new RegExp(`\\bId="${sheet[1]!.replace(/[^A-Za-z0-9_-]/g, '')}"`).test(attrs)) {
      const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
      if (!target) return fallback;
      const t = target.replace(/^\//, '');
      return t.startsWith('xl/') ? t : `xl/${t}`;
    }
  }
  return fallback;
}

/** "B12" → column index 1. */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A number as a spreadsheet shows it (binary noise such as 45.499999999999993 is rounded away). */
export const numberText = (raw: string) => {
  const n = Number(raw);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : raw;
};

/** The cell values of a worksheet, row by row (missing cells are ''; trailing empty rows dropped). */
export function sheetRows(xml: string, strings: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const attrs = row[1] ?? '';
    const rIndex = Number(/\br="(\d+)"/.exec(attrs)?.[1] ?? rows.length + 1) - 1;
    if (rIndex >= SHEET_MAX_ROWS + 50) break;
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = c[1]!;
      const ref = /\br="([A-Z]+\d+)"/.exec(a)?.[1];
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      if (col >= SHEET_MAX_COLUMNS) continue;
      const type = /\bt="([a-zA-Z]+)"/.exec(a)?.[1] ?? 'n';
      const body = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = '';
      if (type === 's') value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = itemText(body);
      else if (type === 'b') value = v === '1' ? 'true' : v === '0' ? 'false' : '';
      else if (type === 'str') value = xmlText(v ?? '');
      else if (type === 'e') value = '';
      else value = v !== undefined ? numberText(xmlText(v)) : '';
      cells[col] = value;
    }
    const values = Array.from({ length: cells.length }, (_, i) => cells[i] ?? '');
    while (values.length && !values[values.length - 1]) values.pop();
    rows[rIndex] = values;
  }
  const out = Array.from({ length: rows.length }, (_, i) => rows[i] ?? []);
  while (out.length && out[out.length - 1]!.every((v) => !v.trim())) out.pop();
  return out;
}

/** CSV text (RFC 4180) of rows, the format the menu import reads. No formula escaping: it goes to our own parser. */
export function rowsToCsv(rows: string[][]): string {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const cell = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return rows.map((r) => Array.from({ length: width }, (_, i) => cell(r[i] ?? '')).join(',')).join('\r\n');
}

/** The first sheet of an .xlsx file as rows of text. */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  if (bytes.length > XLSX_MAX_FILE_BYTES) throw new SpreadsheetError('too_large', 'the file is larger than 5 MB');
  if (bytes.length < 4 || u32(bytes, 0) !== 0x04034b50) throw new SpreadsheetError('not_xlsx', 'not an Excel (.xlsx) file');
  const entries = zipEntries(bytes);
  if (!entries.has('xl/workbook.xml')) throw new SpreadsheetError('not_xlsx', 'not an Excel workbook');
  const [workbook, rels, shared] = await Promise.all([
    readEntry(bytes, entries, 'xl/workbook.xml'),
    readEntry(bytes, entries, 'xl/_rels/workbook.xml.rels'),
    readEntry(bytes, entries, 'xl/sharedStrings.xml'),
  ]);
  const sheet = await readEntry(bytes, entries, firstSheetPath(workbook, rels));
  if (!sheet) throw new SpreadsheetError('empty', 'the workbook has no sheet');
  const rows = sheetRows(sheet, sharedStrings(shared)).filter((r) => r.some((v) => v.trim()));
  if (rows.length < 2) throw new SpreadsheetError('empty', 'the first sheet has no menu rows');
  if (rows.length > SHEET_MAX_ROWS) throw new SpreadsheetError('too_many_rows', 'at most 300 dishes per import');
  return rows;
}
