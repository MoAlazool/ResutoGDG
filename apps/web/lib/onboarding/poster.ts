'use client';
// Draws a menu QR poster and returns it as a PDF (21-ONB). Loaded with import() only when the owner downloads a
// poster, together with the QR encoder, so neither is part of the onboarding page's first load. The artwork (colours,
// the restaurant's name in both languages, the scan line, the address) is drawn on a canvas and embedded as JPEG; the
// QR code is added on top as vector squares (poster-pdf.ts), encoded from the same URL as the API's menu QR.
import QRCode from 'qrcode';
import type { MenuQrPoster } from '@resuto/contracts/lite';
import { buildPosterPdf, posterLayout, qrRects, type Box, type QrMatrix } from './poster-pdf';

/** Printed copy is bilingual whatever the page language: guests read either. */
export const POSTER_COPY = {
  scan: { en: 'Scan to see our menu', ar: 'امسح الرمز لعرض قائمتنا' },
  by: 'resuto',
} as const;

export interface PosterInput {
  kind: MenuQrPoster;
  url: string;
  name: string;
  nameAr: string | null;
  locale: 'en' | 'ar';
  colors: { primary: string; accent: string; background: string };
  logoUrl?: string | null;
}

/** Pixels per millimetre of the artwork (150 dpi: sharp text in print, a few hundred kB of JPEG). */
const PX_PER_MM = 150 / 25.4;
const INK = 'rgb(28, 28, 28)';
const WHITE = 'white';

export function qrMatrix(url: string): QrMatrix {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const { size, data } = qr.modules;
  return { size, dark: (r, c) => data[r * size + c] === 1 };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // A logo without CORS headers would taint the canvas (no export): such a logo is simply left out.
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startPx: number, weight: number, family: string) {
  let size = startPx;
  for (; size > 10; size -= 2) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
  }
  return size;
}

function drawPanel(ctx: CanvasRenderingContext2D, box: Box, qr: Box, input: PosterInput, logo: HTMLImageElement | null, family: string) {
  const px = (mm: number) => mm * PX_PER_MM;
  const X = px(box.x), Y = px(box.y), W = px(box.w), H = px(box.h);
  ctx.fillStyle = input.colors.background;
  ctx.fillRect(X, Y, W, H);
  // Brand band with the name.
  const band = H * 0.2;
  ctx.fillStyle = input.colors.primary;
  ctx.fillRect(X, Y, W, band);
  ctx.fillStyle = input.colors.accent;
  ctx.fillRect(X, Y + band, W, Math.max(4, H * 0.008));
  const primaryName = input.locale === 'ar' && input.nameAr ? input.nameAr : input.name;
  const secondName = input.nameAr && input.nameAr !== input.name ? (primaryName === input.name ? input.nameAr : input.name) : null;
  const logoSize = logo ? band * 0.62 : 0;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = WHITE;
  ctx.direction = /[؀-ۿ]/.test(primaryName) ? 'rtl' : 'ltr';
  const nameSize = fitText(ctx, primaryName, W * 0.84 - logoSize, band * 0.34, 800, family);
  const textCx = X + W / 2 + (logo ? logoSize * 0.6 : 0);
  ctx.fillText(primaryName, textCx, Y + band * (secondName ? 0.42 : 0.5));
  if (secondName) {
    ctx.direction = /[؀-ۿ]/.test(secondName) ? 'rtl' : 'ltr';
    fitText(ctx, secondName, W * 0.84 - logoSize, Math.min(nameSize * 0.55, band * 0.2), 600, family);
    ctx.fillText(secondName, textCx, Y + band * 0.75);
  }
  if (logo) {
    const lx = X + W * 0.08, ly = Y + (band - logoSize) / 2;
    ctx.fillStyle = WHITE;
    ctx.fillRect(lx - 6, ly - 6, logoSize + 12, logoSize + 12);
    const r = Math.min(logoSize / logo.naturalWidth, logoSize / logo.naturalHeight);
    const w = logo.naturalWidth * r, h = logo.naturalHeight * r;
    ctx.drawImage(logo, lx + (logoSize - w) / 2, ly + (logoSize - h) / 2, w, h);
  }
  // White card behind the code (its quiet zone is part of the QR box), with an accent frame.
  const qx = px(qr.x), qy = px(qr.y), qs = px(qr.w);
  ctx.fillStyle = input.colors.accent;
  ctx.fillRect(qx - 10, qy - 10, qs + 20, qs + 20);
  ctx.fillStyle = WHITE;
  ctx.fillRect(qx - 4, qy - 4, qs + 8, qs + 8);
  // Scan line in both languages, then the address.
  let y = qy + qs + H * 0.07;
  ctx.fillStyle = input.colors.primary;
  for (const [text, dir] of [[POSTER_COPY.scan.en, 'ltr'], [POSTER_COPY.scan.ar, 'rtl']] as const) {
    ctx.direction = dir;
    fitText(ctx, text, W * 0.86, H * 0.05, 800, family);
    ctx.fillText(text, X + W / 2, y);
    y += H * 0.065;
  }
  ctx.direction = 'ltr';
  ctx.fillStyle = INK;
  fitText(ctx, input.url.replace(/^https?:\/\//, ''), W * 0.86, H * 0.028, 600, family);
  ctx.fillText(input.url.replace(/^https?:\/\//, ''), X + W / 2, y);
  ctx.font = `600 ${Math.round(H * 0.018)}px ${family}`;
  ctx.globalAlpha = 0.6;
  ctx.fillText(POSTER_COPY.by, X + W / 2, Y + H - H * 0.035);
  ctx.globalAlpha = 1;
}

/** The poster as a PDF file. */
export async function makePosterPdf(input: PosterInput): Promise<Blob> {
  const layout = posterLayout(input.kind);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(layout.widthMm * PX_PER_MM);
  canvas.height = Math.round(layout.heightMm * PX_PER_MM);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  const family = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  const logo = input.logoUrl ? await loadImage(input.logoUrl) : null;
  for (const p of layout.panels) {
    ctx.save();
    if (p.rotated) {
      const cx = (p.box.x + p.box.w / 2) * PX_PER_MM, cy = (p.box.y + p.box.h / 2) * PX_PER_MM;
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI);
      ctx.translate(-cx, -cy);
    }
    // A rotated face is drawn upright about its own centre, so its QR box is mirrored the same way.
    drawPanel(ctx, p.box, p.qr, input, logo, family);
    ctx.restore();
  }
  if (layout.foldMm !== null) {
    ctx.strokeStyle = INK;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([18, 14]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, layout.foldMm * PX_PER_MM);
    ctx.lineTo(canvas.width, layout.foldMm * PX_PER_MM);
    ctx.stroke();
  }
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  } catch {
    blob = null; // a tainted canvas (should not happen: see loadImage)
  }
  if (!blob) throw new Error('poster artwork could not be exported');
  const jpeg = new Uint8Array(await blob.arrayBuffer());
  const matrix = qrMatrix(input.url);
  const rects = layout.panels.flatMap((p) => qrRects(matrix, p.qrOnPage, p.rotated, layout.heightMm));
  const pdf = buildPosterPdf({ widthMm: layout.widthMm, heightMm: layout.heightMm, jpeg, imageWidth: canvas.width, imageHeight: canvas.height, rects, title: `${input.name} menu QR` });
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
