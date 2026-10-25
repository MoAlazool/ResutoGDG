// Spreadsheet → CSV for the menu import (21-ONB, plan §6.2 step 5). Runs in the spreadsheet worker; also importable
// directly (tests, browsers without module workers). A CSV is checked with the same RFC 4180 parser the API uses; an
// .xlsx is read by ./xlsx (first sheet) and turned into CSV, so the API's preview and validation apply unchanged.
import { parseCsv } from '@resuto/contracts/lite';
import type { SpreadsheetKind } from './spreadsheet-kind';
import { readXlsx, rowsToCsv, SpreadsheetError, XLSX_MAX_FILE_BYTES } from './xlsx';

export type { SpreadsheetKind };
export interface ParsedSheet { kind: SpreadsheetKind; csv: string; rows: number; columns: string[] }
export type SheetResult = { ok: true; sheet: ParsedSheet } | { ok: false; code: string; message: string };

export async function parseSpreadsheet(kind: SpreadsheetKind, bytes: Uint8Array): Promise<SheetResult> {
  try {
    if (bytes.length > XLSX_MAX_FILE_BYTES) throw new SpreadsheetError('too_large', 'the file is larger than 5 MB');
    const csv = kind === 'xlsx' ? rowsToCsv(await readXlsx(bytes)) : new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    const records = parseCsv(csv);
    if (!records.length) throw new SpreadsheetError('empty', 'the file has no menu rows');
    if (records.length > 300) throw new SpreadsheetError('too_many_rows', 'at most 300 dishes per import');
    return { ok: true, sheet: { kind, csv, rows: records.length, columns: Object.keys(records[0]!) } };
  } catch (e) {
    const err = e as Error;
    return { ok: false, code: err instanceof SpreadsheetError ? err.code : 'invalid', message: err.message };
  }
}
