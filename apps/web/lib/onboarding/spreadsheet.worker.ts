/// <reference lib="webworker" />
// The spreadsheet worker (21-ONB): reads a CSV or .xlsx menu off the main thread, so a large file never freezes the
// wizard on a phone. Loaded only when the owner picks a spreadsheet (lib/onboarding/spreadsheet.ts).
import type { SpreadsheetKind } from './spreadsheet-kind';
import { parseSpreadsheet } from './spreadsheet-parse';

self.onmessage = async (e: MessageEvent<{ id: number; kind: SpreadsheetKind; bytes: ArrayBuffer }>) => {
  const { id, kind, bytes } = e.data;
  const result = await parseSpreadsheet(kind, new Uint8Array(bytes));
  (self as unknown as Worker).postMessage({ id, result });
};
