import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '@resuto/contracts/lite';
import { spreadsheetKind } from './spreadsheet-kind';
import { parseSpreadsheet } from './spreadsheet-parse';
import { columnIndex, firstSheetPath, numberText, readXlsx, rowsToCsv, sharedStrings, sheetRows, XLSX_MAX_ENTRY_BYTES, xmlText } from './xlsx';

// 21-ONB: the menu spreadsheet reader (first sheet of an .xlsx, read in the browser without a library) and the
// CSV path. The fixture menu.xlsx was written by openpyxl 3.1 (inline strings, numbers, booleans, a second sheet).

const fixture = new Uint8Array(readFileSync(join(__dirname, '__fixtures__/menu.xlsx')));

/** A minimal zip writer (stored or deflated entries) for hand-made workbooks. */
async function zip(entries: Array<{ name: string; text?: string; bytes?: Uint8Array; deflate?: boolean; flags?: number; declaredSize?: number }>) {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = e.bytes ?? enc.encode(e.text ?? '');
    const data = e.deflate
      ? new Uint8Array(await new Response(new Blob([raw as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      : raw;
    const name = enc.encode(e.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(6, e.flags ?? 0, true); local.setUint16(8, e.deflate ? 8 : 0, true);
    local.setUint32(18, data.length, true); local.setUint32(22, e.declaredSize ?? raw.length, true); local.setUint16(26, name.length, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(8, e.flags ?? 0, true); cd.setUint16(10, e.deflate ? 8 : 0, true);
    cd.setUint32(20, data.length, true); cd.setUint32(24, e.declaredSize ?? raw.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}

const WORKBOOK = '<workbook xmlns:r="r"><sheets><sheet name="Prices" sheetId="2" r:id="rId7"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/prices.xml"/></Relationships>';
const SHARED = '<sst><si><t>name</t></si><si><t>category</t></si><si><t>price</t></si><si><r><t>Ful </t></r><r><rPr><b/></rPr><t>medames</t></r><rPh><t>x</t></rPh></si><si><t xml:space="preserve">Breakfast &amp; more</t></si><si/></sst>';
const SHEET = '<worksheet><sheetData>'
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
  + '<row r="2" spans="1:3"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2"><v>24.999999999999996</v></c></row>'
  + '<row r="3"/>'
  + '<row r="4"><c r="A4" t="inlineStr"><is><t>&#1601;&#1608;&#1604;</t></is></c><c r="C4" t="str"><v>30</v></c><c r="D4" t="e"><v>#N/A</v></c></row>'
  + '</sheetData></worksheet>';

describe('xlsx reader', () => {
  it('reads the first sheet of a real workbook (openpyxl fixture) into CSV the menu import accepts', async () => {
    const rows = await readXlsx(fixture);
    expect(rows[0]).toEqual(['name', 'name_ar', 'category', 'price', 'description', 'available']);
    expect(rows[1]).toEqual(['Flat white', 'فلات وايت', 'Coffee', '65', 'Double shot & steamed milk', 'true']);
    expect(rows[2]).toEqual(['Croissant', 'كرواسون', 'Bakery', '45.5', '', 'true']);
    expect(rows[3]).toEqual(['Lemon tart', '', 'Bakery', '70', '"Tangy", buttery', 'false']);
    expect(rows).toHaveLength(4); // the second sheet ("Notes") is not read
    const records = parseCsv(rowsToCsv(rows));
    expect(records[2]).toEqual({ name: 'Lemon tart', name_ar: '', category: 'Bakery', price: '70', description: '"Tangy", buttery', available: 'false' });
  });

  it('follows the workbook to its first sheet, reads shared strings (rich text, entities) and deflated entries', async () => {
    const book = await zip([
      { name: 'xl/workbook.xml', text: WORKBOOK, deflate: true },
      { name: 'xl/_rels/workbook.xml.rels', text: RELS },
      { name: 'xl/sharedStrings.xml', text: SHARED, deflate: true },
      { name: 'xl/worksheets/prices.xml', text: SHEET, deflate: true },
    ]);
    const rows = await readXlsx(book);
    expect(rows).toEqual([['name', 'category', 'price'], ['Ful medames', 'Breakfast & more', '25'], ['فول', '', '30']]);
  });

  it('pieces: cell references, numbers, XML text, sheet paths', () => {
    expect([columnIndex('A1'), columnIndex('Z9'), columnIndex('AA10'), columnIndex('AB3')]).toEqual([0, 25, 26, 27]);
    expect([numberText('45.499999999999993'), numberText('65'), numberText('1e3'), numberText('abc')]).toEqual(['45.5', '65', '1000', 'abc']);
    expect(xmlText('a &lt;b&gt; &amp;amp; &#x41;&#66; _x000D_ &bogus;')).toBe('a <b> &amp; AB \r &bogus;');
    expect(sharedStrings(SHARED)).toEqual(['name', 'category', 'price', 'Ful medames', 'Breakfast & more', '']);
    expect(firstSheetPath(WORKBOOK, RELS)).toBe('xl/worksheets/prices.xml');
    expect(firstSheetPath(null, null)).toBe('xl/worksheets/sheet1.xml');
    expect(firstSheetPath('<sheets><sheet r:id="rId1"/></sheets>', '<Relationship Target="/xl/worksheets/sheet1.xml" Id="rId1"/>')).toBe('xl/worksheets/sheet1.xml');
    // A self-closing row does not swallow the next one; missing cells are empty; columns beyond the limit are dropped.
    expect(sheetRows('<row r="1"/><row r="2"><c r="C2"><v>1</v></c></row>', [])).toEqual([[], ['', '', '1']]);
    expect(rowsToCsv([['a,b', ' x', 'say "hi"'], ['1']])).toBe('"a,b"," x","say ""hi"""\r\n1,,');
  });

  it('refuses what is not a readable workbook', async () => {
    await expect(readXlsx(new TextEncoder().encode('name,price\nTea,10'))).rejects.toMatchObject({ code: 'not_xlsx' });
    await expect(readXlsx(await zip([{ name: 'word/document.xml', text: '<w/>' }]))).rejects.toMatchObject({ code: 'not_xlsx' });
    await expect(readXlsx(await zip([{ name: 'xl/workbook.xml', text: WORKBOOK, flags: 1 }]))).rejects.toMatchObject({ code: 'unsupported' });
    await expect(readXlsx(await zip([{ name: 'xl/workbook.xml', text: '<workbook/>' }, { name: 'xl/worksheets/sheet1.xml', text: '<worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>name</t></is></c></row></sheetData></worksheet>' }])))
      .rejects.toMatchObject({ code: 'empty' });
    // A zip bomb: the declared size is checked first, and the inflated size is capped while reading.
    await expect(readXlsx(await zip([{ name: 'xl/workbook.xml', text: WORKBOOK, declaredSize: XLSX_MAX_ENTRY_BYTES + 1 }]))).rejects.toMatchObject({ code: 'too_large' });
    const bomb = await zip([{ name: 'xl/workbook.xml', text: '<workbook/>' }, { name: 'xl/worksheets/sheet1.xml', bytes: new Uint8Array(XLSX_MAX_ENTRY_BYTES + 10), deflate: true, declaredSize: 100 }]);
    await expect(readXlsx(bomb)).rejects.toMatchObject({ code: 'too_large' });
    const many = '<worksheet><sheetData>' + Array.from({ length: 302 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>n${i}</t></is></c></row>`).join('') + '</sheetData></worksheet>';
    await expect(readXlsx(await zip([{ name: 'xl/workbook.xml', text: '<workbook/>' }, { name: 'xl/worksheets/sheet1.xml', text: many }]))).rejects.toMatchObject({ code: 'too_many_rows' });
  });
});

describe('spreadsheet parsing for the menu import', () => {
  it('tells CSV from xlsx by name and content', () => {
    const zipHead = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextEncoder().encode('name');
    expect(spreadsheetKind('menu.xlsx', zipHead)).toBe('xlsx');
    expect(spreadsheetKind('menu.CSV', text)).toBe('csv');
    expect(spreadsheetKind('menu.xlsx', text)).toBeNull();
    expect(spreadsheetKind('menu.csv', zipHead)).toBeNull();
    expect(spreadsheetKind('menu', zipHead)).toBe('xlsx');
    expect(spreadsheetKind('menu.pdf', text)).toBeNull();
  });

  it('CSV: checked with the import parser (BOM, quotes); errors are reported, not thrown', async () => {
    const ok = await parseSpreadsheet('csv', new TextEncoder().encode('﻿name,category,price\r\n"Tea, mint",Drinks,15\r\n'));
    expect(ok).toEqual({ ok: true, sheet: { kind: 'csv', csv: 'name,category,price\r\n"Tea, mint",Drinks,15\r\n', rows: 1, columns: ['name', 'category', 'price'] } });
    expect(await parseSpreadsheet('csv', new TextEncoder().encode('name,price\n"Tea,10'))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await parseSpreadsheet('csv', new TextEncoder().encode('name,price\n'))).toMatchObject({ ok: false, code: 'empty' });
    const big = 'name,price\n' + Array.from({ length: 301 }, (_, i) => `d${i},1`).join('\n');
    expect(await parseSpreadsheet('csv', new TextEncoder().encode(big))).toMatchObject({ ok: false, code: 'too_many_rows' });
  });

  it('xlsx: the fixture becomes CSV with the same rows', async () => {
    const r = await parseSpreadsheet('xlsx', fixture);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sheet).toMatchObject({ kind: 'xlsx', rows: 3, columns: ['name', 'name_ar', 'category', 'price', 'description', 'available'] });
    expect(r.sheet.csv.split('\r\n')[2]).toBe('Croissant,كرواسون,Bakery,45.5,,true');
  });
});
