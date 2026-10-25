'use client';
// Reads a menu spreadsheet in the browser (21-ONB): the parsing runs in a lazily created worker (its own chunk, so the
// onboarding page does not ship the reader until a file is chosen). Without module workers it falls back to a lazy
// import on the main thread.
import { spreadsheetKind, type SpreadsheetKind } from './spreadsheet-kind';
import type { SheetResult } from './spreadsheet-parse';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, (r: SheetResult) => void>();

function getWorker(): Worker | null {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./spreadsheet.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result: SheetResult }>) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      for (const [id, done] of pending) { done({ ok: false, code: 'invalid', message: 'the file could not be read' }); pending.delete(id); }
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

export async function readSpreadsheet(file: File): Promise<SheetResult> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind: SpreadsheetKind | null = spreadsheetKind(file.name, bytes.subarray(0, 4));
  if (!kind) return { ok: false, code: 'unsupported', message: 'unsupported file' };
  const w = typeof Worker === 'undefined' ? null : getWorker();
  if (!w) return (await import('./spreadsheet-parse')).parseSpreadsheet(kind, bytes);
  const id = ++seq;
  return new Promise<SheetResult>((resolve) => {
    pending.set(id, resolve);
    w.postMessage({ id, kind, bytes: bytes.buffer }, [bytes.buffer]);
  });
}
