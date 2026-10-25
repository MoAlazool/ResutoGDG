// Print-ready menu QR posters as PDF (21-ONB, plan §6.2 step 9), built in the browser with no PDF library: one page
// holding a JPEG of the poster artwork (drawn on a canvas, so Arabic names are shaped by the browser's own text
// engine) and the QR code itself on top as vector squares, so it stays sharp at any print size and scans from
// across a table. Sizes: A4 and A5 portrait, and a table tent (A4 folded across the middle: the upper half is
// printed upside down so both faces read upright once folded). This file is pure (layout, QR geometry, PDF bytes)
// and unit-tested; poster.ts draws the artwork and is loaded only when a poster is downloaded.
import { MENU_QR_POSTERS, type MenuQrPoster } from '@resuto/contracts/lite';

export const MM_TO_PT = 72 / 25.4;

export interface Box { x: number; y: number; w: number; h: number }
/**
 * One printed face of a poster, in millimetres from the page's top-left corner. `qr` is where the artwork draws the
 * code's card in the face's own upright frame; `qrOnPage` is where the code lands on the sheet (for a face printed
 * upside down, `qr` turned 180° about the face's centre).
 */
export interface PosterPanel { box: Box; qr: Box; qrOnPage: Box; rotated: boolean }
export interface PosterLayout { widthMm: number; heightMm: number; panels: PosterPanel[]; foldMm: number | null }

/** Where each face and its QR code sit on the page (millimetres, top-left origin). */
export function posterLayout(kind: MenuQrPoster): PosterLayout {
  const { widthMm, heightMm } = MENU_QR_POSTERS[kind];
  const panel = (box: Box, rotated: boolean): PosterPanel => {
    // The QR takes about 60 % of the face's width (at least 45 mm on A5, ~126 mm on A4), centred a little below the
    // middle, leaving the top for the restaurant's name and the bottom for the address.
    const size = Math.min(box.w * 0.6, box.h * (kind === 'table_tent' ? 0.52 : 0.46));
    const x = box.x + (box.w - size) / 2;
    const y = box.y + box.h * (kind === 'table_tent' ? 0.3 : 0.33);
    const qr = { x, y, w: size, h: size };
    const qrOnPage = rotated ? { x: 2 * box.x + box.w - x - size, y: 2 * box.y + box.h - y - size, w: size, h: size } : qr;
    return { box, qr, qrOnPage, rotated };
  };
  if (kind === 'table_tent') {
    const half = heightMm / 2;
    return {
      widthMm, heightMm, foldMm: half,
      // The upper face is upside down: folded along the middle, it faces the other side of the table upright.
      panels: [panel({ x: 0, y: 0, w: widthMm, h: half }, true), panel({ x: 0, y: half, w: widthMm, h: half }, false)],
    };
  }
  return { widthMm, heightMm, foldMm: null, panels: [panel({ x: 0, y: 0, w: widthMm, h: heightMm }, false)] };
}

/** A QR matrix: `size` × `size` modules, `dark(row, col)` true for a dark module. */
export interface QrMatrix { size: number; dark(row: number, col: number): boolean }

/**
 * The dark modules as rectangles in PDF points (bottom-left origin), one per horizontal run, with a 4-module quiet
 * zone inside `qr` (a face's `qrOnPage`). On a rotated face the code itself is also turned 180°.
 */
export function qrRects(m: QrMatrix, qr: Box, rotated: boolean, pageHeightMm: number): Array<[number, number, number, number]> {
  const quiet = 4;
  const cell = qr.w / (m.size + quiet * 2);
  const out: Array<[number, number, number, number]> = [];
  for (let r = 0; r < m.size; r++) {
    let c = 0;
    while (c < m.size) {
      if (!m.dark(r, c)) { c++; continue; }
      let end = c;
      while (end + 1 < m.size && m.dark(r, end + 1)) end++;
      const len = end - c + 1;
      // Module (r, c) top-left in mm; rotated: the run ending at `end` lands mirrored on both axes.
      const col = rotated ? m.size - 1 - end : c;
      const row = rotated ? m.size - 1 - r : r;
      const xMm = qr.x + (quiet + col) * cell;
      const yMm = qr.y + (quiet + row) * cell;
      out.push([round(xMm * MM_TO_PT), round((pageHeightMm - yMm - cell) * MM_TO_PT), round(len * cell * MM_TO_PT), round(cell * MM_TO_PT)]);
      c = end + 1;
    }
  }
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '').replace(/[()\\]/g, '');

/**
 * A one-page PDF 1.4: the artwork JPEG (DCTDecode, embedded as is) scaled to the page, then the QR rectangles filled
 * in black. `title` goes to the document info (ASCII only).
 */
export function buildPosterPdf(opts: {
  widthMm: number; heightMm: number; jpeg: Uint8Array; imageWidth: number; imageHeight: number;
  rects: Array<[number, number, number, number]>; title?: string;
}): Uint8Array {
  const W = round(opts.widthMm * MM_TO_PT);
  const H = round(opts.heightMm * MM_TO_PT);
  const enc = new TextEncoder();
  const content = enc.encode([
    'q', `${W} 0 0 ${H} 0 0 cm`, '/Im0 Do', 'Q',
    '0 0 0 rg',
    ...opts.rects.map(([x, y, w, h]) => `${x} ${y} ${w} ${h} re`),
    'f', '',
  ].join('\n'));
  const objects: Array<Uint8Array[]> = [
    [enc.encode('<< /Type /Catalog /Pages 2 0 R >>')],
    [enc.encode('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')],
    [enc.encode(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)],
    [enc.encode(`<< /Type /XObject /Subtype /Image /Width ${opts.imageWidth} /Height ${opts.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${opts.jpeg.length} >>\nstream\n`), opts.jpeg, enc.encode('\nendstream')],
    [enc.encode(`<< /Length ${content.length} >>\nstream\n`), content, enc.encode('endstream')],
    [enc.encode(`<< /Title (${ascii(opts.title ?? 'Menu QR')}) /Producer (Resuto) >>`)],
  ];
  // Header plus the binary comment line (four bytes above 127) that marks the file as binary for transfer tools.
  const header = Uint8Array.from([...'%PDF-1.4\n%'].map((c) => c.charCodeAt(0)).concat([0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const parts: Uint8Array[] = [header];
  let offset = header.length;
  const offsets: number[] = [];
  objects.forEach((chunks, i) => {
    offsets.push(offset);
    const body = [enc.encode(`${i + 1} 0 obj\n`), ...chunks, enc.encode('\nendobj\n')];
    for (const b of body) { parts.push(b); offset += b.length; }
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n', ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(enc.encode(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
