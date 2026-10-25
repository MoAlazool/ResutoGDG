import { describe, expect, it } from 'vitest';
import { buildPosterPdf, MM_TO_PT, posterLayout, qrRects, type QrMatrix } from './poster-pdf';

// 21-ONB menu QR posters: page sizes, where the code sits (and that the table tent's upper face is upside down), the
// vector modules, and a structurally valid PDF (every xref offset points at its object).

const matrix = (rows: string[]): QrMatrix => ({ size: rows.length, dark: (r, c) => rows[r]![c] === '#' });

describe('poster layout', () => {
  it('A4, A5 and the A4 table tent', () => {
    const a4 = posterLayout('a4');
    expect([a4.widthMm, a4.heightMm, a4.panels.length, a4.foldMm]).toEqual([210, 297, 1, null]);
    const a5 = posterLayout('a5');
    expect([a5.widthMm, a5.heightMm]).toEqual([148, 210]);
    // The code is large enough to scan from across a table: at least 45 mm on A5, centred.
    for (const l of [a4, a5]) {
      const { qr, box } = l.panels[0]!;
      expect(qr.w).toBeGreaterThanOrEqual(45);
      expect(qr.x + qr.w / 2).toBeCloseTo(box.x + box.w / 2, 6);
      expect(qr.y + qr.h).toBeLessThan(box.y + box.h);
    }
    const tent = posterLayout('table_tent');
    expect(tent.foldMm).toBe(148.5);
    const [upper, lower] = tent.panels;
    expect(upper!.rotated).toBe(true);
    expect(lower!.rotated).toBe(false);
    // Folded along the middle, the two faces mirror each other: the upper code lands as far above the fold as the
    // lower one sits below it.
    expect(148.5 - (upper!.qrOnPage.y + upper!.qrOnPage.h)).toBeCloseTo(lower!.qrOnPage.y - 148.5, 6);
    expect(upper!.qrOnPage.y).toBeGreaterThanOrEqual(0);
  });
});

describe('QR modules as vector rectangles', () => {
  const m = matrix(['##.', '.#.', '..#']);
  const box = { x: 10, y: 20, w: 33, h: 33 }; // 3 modules + 8 quiet = 11 cells of 3 mm
  it('one rectangle per run, inside a 4-module quiet zone, in PDF points from the bottom', () => {
    const rects = qrRects(m, box, false, 100);
    expect(rects).toHaveLength(3);
    const [first] = rects;
    expect(first![0]).toBeCloseTo((10 + 4 * 3) * MM_TO_PT, 2); // x
    expect(first![1]).toBeCloseTo((100 - (20 + 4 * 3) - 3) * MM_TO_PT, 2); // y (bottom-left origin)
    expect(first![2]).toBeCloseTo(2 * 3 * MM_TO_PT, 2); // the "##" run
    expect(first![3]).toBeCloseTo(3 * MM_TO_PT, 2);
  });
  it('a rotated face turns the code 180°', () => {
    const up = qrRects(m, box, false, 100);
    const down = qrRects(m, box, true, 100);
    // Module (0,0)-(0,1) lands at the bottom-right: row 2, columns 1-2.
    const run = down.find((r) => Math.abs(r[2] - 2 * 3 * MM_TO_PT) < 0.01)!;
    expect(run[0]).toBeCloseTo((10 + (4 + 1) * 3) * MM_TO_PT, 2);
    expect(run[1]).toBeCloseTo((100 - (20 + (4 + 2) * 3) - 3) * MM_TO_PT, 2);
    expect(down).toHaveLength(up.length);
  });
});

describe('poster PDF', () => {
  it('is a one-page PDF with the JPEG, the modules and a valid cross-reference table', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const pdf = buildPosterPdf({ widthMm: 210, heightMm: 297, jpeg, imageWidth: 1240, imageHeight: 1754, rects: [[1, 2, 3, 4]], title: 'Olive Room menu QR (غرفة)' });
    const text = new TextDecoder('latin1').decode(pdf);
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text).toContain('/MediaBox [0 0 595.276 841.89]');
    expect(text).toContain('/Filter /DCTDecode /Length 9');
    expect(text).toContain('1 2 3 4 re');
    expect(text).toContain('/Title (Olive Room menu QR )');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((o, i) => expect(text.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    // The image stream holds the JPEG bytes unchanged.
    const at = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 'stream\n'.length;
    expect([...pdf.subarray(at, at + jpeg.length)]).toEqual([...jpeg]);
  });
});
