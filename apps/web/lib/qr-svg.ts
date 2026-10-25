// Server-rendered QR codes (SVG from the API) are inserted as markup: this keeps only a plain <svg> element.
/** Keeps only the <svg> element of a server-rendered QR code (no scripts, handlers or foreign markup). */
export function sanitizeQrSvg(svg: string): string | null {
  const m = /^\s*(?:<\?xml[^>]*>\s*)?(<svg[\s\S]*<\/svg>)\s*$/i.exec(svg);
  if (!m) return null;
  const body = m[1]!;
  if (/<script|on[a-z]+\s*=|javascript:|<foreignObject|<iframe|xlink:href\s*=\s*["']?(?!#)/i.test(body)) return null;
  return body;
}
