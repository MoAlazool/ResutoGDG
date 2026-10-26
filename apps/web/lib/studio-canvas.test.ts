// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CANVAS_MESSAGE_KEYS, CANVAS_SANDBOX, CANVAS_SRCDOC, CANVAS_WIDTHS, syncStyles, targetOf } from './studio-canvas';

const SID = '6f1c2a40-0000-4000-8000-000000000001';
const WEB = join(__dirname, '..');

describe('Studio canvas frame (script-free, same origin)', () => {
  it('sandboxes the frame without scripts, forms, popups or navigation of the editor', () => {
    expect(CANVAS_SANDBOX).toBe('allow-same-origin');
    expect(CANVAS_SANDBOX).not.toMatch(/scripts|top-navigation|popups|forms|modals|downloads/);
    // The editor creates the document itself: no URL to load, so nothing in it is fetched from the server as a page.
    expect(CANVAS_SRCDOC).toMatch(/^<!doctype html>/i);
    expect(CANVAS_SRCDOC).not.toMatch(/<script|src=|href=/i);
    expect(CANVAS_WIDTHS).toEqual({ desktop: 1280, tablet: 820, phone: 390 });
  });

  it('the editor renders the frame with that sandbox and srcdoc, never a page URL', () => {
    const src = readFileSync(join(WEB, 'app/dashboard/[orgId]/website/_components/Canvas.tsx'), 'utf8');
    expect(src).toMatch(/srcDoc=\{CANVAS_SRCDOC\}/);
    expect(src).toMatch(/sandbox=\{CANVAS_SANDBOX\}/);
    expect(src).not.toMatch(/<iframe[^>]*\ssrc=/);
  });

  it('a click selects the section it landed in, "site" on the header or footer, nothing elsewhere', () => {
    document.body.innerHTML = `<header><a id="logo">Logo</a></header><section class="site-block" data-sid="${SID}"><h2 id="h">Hi</h2><p>t<b id="deep">x</b></p></section>
      <div id="loose">x</div><footer><span id="f">f</span></footer>`;
    expect(targetOf(document.getElementById('h'))).toBe(SID);
    expect(targetOf(document.getElementById('deep'))).toBe(SID);
    expect(targetOf(document.getElementById('deep')!.firstChild)).toBe(SID); // a text node
    expect(targetOf(document.getElementById('logo'))).toBe('site');
    expect(targetOf(document.getElementById('f'))).toBe('site');
    expect(targetOf(document.getElementById('loose'))).toBeNull();
    expect(targetOf(null)).toBeNull();
    expect(targetOf({})).toBeNull();
  });

  it('mirrors the editor’s stylesheets into the frame, without nonces, and follows additions and removals', () => {
    const editor = document.implementation.createHTMLDocument('editor');
    const frame = document.implementation.createHTMLDocument('frame');
    editor.head.innerHTML = '<link rel="stylesheet" href="/_next/static/css/a.css" nonce="n1"><style nonce="n2">.x{color:red}</style><link rel="preload" href="/f.woff2"><script src="/s.js"></script>';
    expect(syncStyles(editor, frame)).toEqual({ added: 2, removed: 0 });
    expect(frame.head.querySelectorAll('[data-canvas-style]')).toHaveLength(2);
    expect(frame.head.innerHTML).not.toMatch(/nonce|<script|preload/);
    // Idempotent.
    expect(syncStyles(editor, frame)).toEqual({ added: 0, removed: 0 });
    // A route stylesheet arrives, another leaves.
    editor.head.querySelector('style')!.remove();
    editor.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/_next/static/css/site.css">');
    expect(syncStyles(editor, frame)).toEqual({ added: 1, removed: 1 });
    expect([...frame.head.querySelectorAll('link')].map((l) => l.getAttribute('href'))).toEqual(['/_next/static/css/a.css', '/_next/static/css/site.css']);
    // The frame's own nodes (not copies) are left alone.
    frame.head.insertAdjacentHTML('afterbegin', '<meta charset="utf-8">');
    syncStyles(editor, frame);
    expect(frame.head.querySelector('meta')).not.toBeNull();
  });

  it('the canvas copy is the site renderer’s strings only', () => {
    expect(CANVAS_MESSAGE_KEYS.test('studio.site.faqTitle')).toBe(true);
    expect(CANVAS_MESSAGE_KEYS.test('studio.kind.hero')).toBe(true);
    expect(CANVAS_MESSAGE_KEYS.test('core.guest.social.instagram')).toBe(true);
    expect(CANVAS_MESSAGE_KEYS.test('lang.switch')).toBe(true);
    expect(CANVAS_MESSAGE_KEYS.test('studio.ws.publish')).toBe(false);
    expect(CANVAS_MESSAGE_KEYS.test('auth.password')).toBe(false);
  });
});
