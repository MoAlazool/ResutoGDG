// The Studio canvas (22-STUDIO; replaces the 21-STUDIO /studio-canvas document). The editor renders the draft with the
// site renderer (SiteView) through a React portal into an iframe whose document it creates itself (srcdoc) and keeps
// script-free: the frame is sandboxed with "allow-same-origin" only, so nothing inside it can ever run (no allow-scripts),
// submit a form, open a popup or navigate the editor. The editor's own code attaches the listeners (clicks select a
// section) and copies the editor's stylesheets in, so the frame lays the page out at the device's real width.
//
// Why not a separate document any more: the 21-STUDIO canvas was a Next.js page in a frame sandboxed with
// "allow-scripts" only (an opaque origin). Every script and stylesheet that page loaded was then a cross-site request
// (Sec-Fetch-Site: cross-site), so a deployment behind cookie-based access control — Vercel Authentication on staging,
// whose _vercel_jwt cookie is SameSite=Lax — answered them 401 and the canvas stayed an empty box. Third-party cookie
// blocking (Safari, Firefox, Chrome incognito) had the same effect. The portal frame makes no script requests at all,
// and its stylesheet and image requests are same-origin. Pure helpers here are unit-tested in lib/studio-canvas.test.ts.
export type CanvasDevice = 'desktop' | 'tablet' | 'phone';
export const CANVAS_WIDTHS: Record<CanvasDevice, number> = { desktop: 1280, tablet: 820, phone: 390 };

/** The iframe sandbox: same origin (so the editor can render into it), and no scripts, forms, popups or navigation. */
export const CANVAS_SANDBOX = 'allow-same-origin';

/** The frame's initial document: standards mode, the device viewport, nothing else (the editor fills it). */
export const CANVAS_SRCDOC = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>';

/** A section id, or "site" for the page chrome (header, footer): what a click on the canvas selects. */
export type CanvasTarget = string;

/** What a click inside the canvas selects: the nearest section, "site" for the header or footer, else nothing. */
export function targetOf(node: unknown): CanvasTarget | null {
  const el = node && typeof (node as Element).closest === 'function' ? (node as Element) : (node as Node | null)?.parentElement ?? null;
  if (!el) return null;
  const block = el.closest<HTMLElement>('[data-sid]');
  if (block?.dataset.sid) return block.dataset.sid;
  return el.closest('header, footer') ? 'site' : null;
}

/** The stylesheet nodes of a document head that the canvas needs: linked stylesheets and <style> blocks. */
const STYLE_NODES = 'link[rel="stylesheet"], style';

/**
 * Mirrors the editor's stylesheets into the canvas document: every linked stylesheet and <style> block of `from`'s head
 * that is not in `to` yet is cloned in (keyed by href or text), and the ones that left `from` are removed. Next.js adds
 * route CSS as <link> elements when chunks load, so the editor calls this again whenever its head changes. Returns
 * how many nodes were added and removed.
 */
export function syncStyles(from: Document, to: Document): { added: number; removed: number } {
  const key = (n: Element) => (n.tagName === 'LINK' ? `l:${(n as HTMLLinkElement).getAttribute('href') ?? ''}` : `s:${n.textContent ?? ''}`);
  const wanted = new Map<string, Element>();
  from.head.querySelectorAll(STYLE_NODES).forEach((n) => { if (!n.hasAttribute('data-canvas-skip')) wanted.set(key(n), n); });
  const have = new Map<string, Element>();
  to.head.querySelectorAll('[data-canvas-style]').forEach((n) => have.set(key(n), n));
  let added = 0;
  let removed = 0;
  for (const [k, n] of have) if (!wanted.has(k)) { n.remove(); removed++; }
  for (const [k, n] of wanted) {
    if (have.has(k)) continue;
    const copy = to.importNode(n, true) as Element;
    copy.setAttribute('data-canvas-style', '');
    // A nonce is meaningless in the canvas (no script runs there) and must not leak into its markup.
    copy.removeAttribute('nonce');
    to.head.appendChild(copy);
    added++;
  }
  return { added, removed };
}

/** The canvas copy the site renderer needs: Studio site and section names and the social labels, plus the language switch. */
export const CANVAS_MESSAGE_KEYS = /^(studio\.site\.|studio\.kind\.|core\.guest\.social\.|lang\.switch$)/;
