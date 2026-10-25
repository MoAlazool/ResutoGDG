// The Studio canvas protocol (21-STUDIO, plan §6.4). The canvas is /studio-canvas in an iframe sandboxed with
// "allow-scripts" only — no allow-same-origin — so the framed document has an opaque origin: it cannot read the
// editor's localStorage (the session token), cookies or DOM, and its requests carry no credentials of the editor.
// Both sides exchange plain JSON messages and drop anything that is not exactly one of the shapes below, from the
// exact window and origin they expect:
//   - the editor accepts messages only from its own iframe's window, whose origin is the opaque "null";
//   - the canvas accepts messages only from its parent window at the app's own origin (location.origin).
// The editor posts to the frame with targetOrigin "*" (an opaque origin cannot be named); the frame's address is fixed,
// it cannot navigate itself (the canvas cancels link clicks and form submits; the sandbox forbids top navigation,
// popups and forms), and it only ever receives the owner's own draft. Pure functions, unit-tested in
// lib/studio-canvas.test.ts.
import type { PublicSite } from '@resuto/contracts';

export const CANVAS_PROTOCOL = 'resuto-studio-canvas';
export const CANVAS_VERSION = 1;
/** The iframe sandbox: scripts only (see above). Exported so the isolation test checks the same value. */
export const CANVAS_SANDBOX = 'allow-scripts';
export const CANVAS_PATH = '/studio-canvas';

export type CanvasDevice = 'desktop' | 'tablet' | 'phone';
export const CANVAS_WIDTHS: Record<CanvasDevice, number> = { desktop: 1280, tablet: 820, phone: 390 };

/** A section id, or "site" for the page chrome (header, footer): what a click on the canvas selects. */
export type CanvasTarget = string;

export type ToCanvas =
  | { protocol: typeof CANVAS_PROTOCOL; v: typeof CANVAS_VERSION; type: 'render'; site: PublicSite; locale: 'en' | 'ar'; selected: CanvasTarget | null; compare: 'before' | 'after' | null }
  | { protocol: typeof CANVAS_PROTOCOL; v: typeof CANVAS_VERSION; type: 'select'; id: CanvasTarget | null };

export type FromCanvas =
  | { protocol: typeof CANVAS_PROTOCOL; v: typeof CANVAS_VERSION; type: 'ready' }
  | { protocol: typeof CANVAS_PROTOCOL; v: typeof CANVAS_VERSION; type: 'select'; id: CanvasTarget | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isTarget = (v: unknown): v is CanvasTarget | null => v === null || v === 'site' || (typeof v === 'string' && UUID.test(v));

function isPlain(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
const keysAre = (o: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && own.every((k) => keys.includes(k));
};
const header = (o: Record<string, unknown>) => o.protocol === CANVAS_PROTOCOL && o.v === CANVAS_VERSION;

/** The minimal shape the renderer relies on; anything else in a site payload is ignored by SiteView. */
function isSite(v: unknown): v is PublicSite {
  if (!isPlain(v)) return false;
  if (typeof v.slug !== 'string' || !Array.isArray(v.sections) || !Array.isArray(v.branches) || !Array.isArray(v.menuHighlights)) return false;
  if (!isPlain(v.org) || !isPlain(v.theme) || !isPlain(v.seo) || !isPlain(v.links)) return false;
  return v.sections.every((s) => isPlain(s) && typeof s.id === 'string' && typeof s.kind === 'string' && isPlain(s.content));
}

export interface MessageLike { data: unknown; origin: string; source: unknown }

/** Editor side: a message from the canvas, or null (wrong window, wrong origin, wrong shape). */
export function readFromCanvas(e: MessageLike, frame: unknown): FromCanvas | null {
  if (!frame || e.source !== frame || e.origin !== 'null') return null;
  const d = e.data;
  if (!isPlain(d) || !header(d)) return null;
  if (d.type === 'ready' && keysAre(d, ['protocol', 'v', 'type'])) return { protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'ready' };
  if (d.type === 'select' && keysAre(d, ['protocol', 'v', 'type', 'id']) && isTarget(d.id)) return { protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'select', id: d.id };
  return null;
}

/** Canvas side: a message from the editor, or null. `parent` is window.parent, `origin` the app's own origin. */
export function readToCanvas(e: MessageLike, parent: unknown, origin: string): ToCanvas | null {
  if (!parent || e.source !== parent || e.origin !== origin) return null;
  const d = e.data;
  if (!isPlain(d) || !header(d)) return null;
  if (d.type === 'select' && keysAre(d, ['protocol', 'v', 'type', 'id']) && isTarget(d.id)) return { protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'select', id: d.id };
  if (d.type === 'render' && keysAre(d, ['protocol', 'v', 'type', 'site', 'locale', 'selected', 'compare']) && isSite(d.site)
    && (d.locale === 'en' || d.locale === 'ar') && isTarget(d.selected) && (d.compare === null || d.compare === 'before' || d.compare === 'after')) {
    return { protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'render', site: d.site, locale: d.locale, selected: d.selected, compare: d.compare };
  }
  return null;
}

export const toCanvas = {
  render: (site: PublicSite, locale: 'en' | 'ar', selected: CanvasTarget | null, compare: 'before' | 'after' | null): ToCanvas =>
    ({ protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'render', site, locale, selected, compare }),
  select: (id: CanvasTarget | null): ToCanvas => ({ protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'select', id }),
};
export const fromCanvas = {
  ready: (): FromCanvas => ({ protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'ready' }),
  select: (id: CanvasTarget | null): FromCanvas => ({ protocol: CANVAS_PROTOCOL, v: CANVAS_VERSION, type: 'select', id }),
};
