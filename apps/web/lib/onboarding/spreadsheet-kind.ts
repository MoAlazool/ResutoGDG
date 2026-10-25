// Which menu spreadsheet a file is (21-ONB): decided from its name and first bytes (an .xlsx is a zip: "PK\x03\x04").
export type SpreadsheetKind = 'csv' | 'xlsx';

export function spreadsheetKind(name: string, head: Uint8Array): SpreadsheetKind | null {
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (/\.xlsx$/i.test(name)) return zip ? 'xlsx' : null;
  if (/\.(csv|txt)$/i.test(name)) return zip ? null : 'csv';
  return zip ? 'xlsx' : null;
}
