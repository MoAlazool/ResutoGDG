// Test helpers for @resuto/ui components (vitest + jsdom; each test file starts with `// @vitest-environment jsdom`).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { UiLocaleProvider } from '../src/locale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has HTMLDialogElement but not showModal()/close(): enough of them for the components' open/close logic.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
if (typeof window !== 'undefined' && !('CSS' in window && typeof CSS.escape === 'function')) {
  (window as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s: string) => s.replace(/["\\]/g, '\\$&') };
}

export type Lang = 'en' | 'ar';

/** Renders into a container with the page language and direction set as the app does (lang + dir). */
export function mount(node: ReactNode, lang: Lang = 'en') {
  const host = document.createElement('div');
  host.setAttribute('lang', lang);
  host.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
  document.body.appendChild(host);
  let root: Root;
  act(() => { root = createRoot(host); root.render(<UiLocaleProvider locale={lang}>{node}</UiLocaleProvider>); });
  return {
    host,
    rerender(next: ReactNode) { act(() => root.render(<UiLocaleProvider locale={lang}>{next}</UiLocaleProvider>)); },
    unmount() { act(() => root.unmount()); host.remove(); },
  };
}

/** Static HTML in a language (the server render). */
export const html = (node: ReactNode, lang: Lang = 'en') => renderToStaticMarkup(<UiLocaleProvider locale={lang}>{node}</UiLocaleProvider>);

/** Arabic-Indic or Extended Arabic-Indic digits (the Western-digits policy forbids them in rendered output). */
export const EASTERN_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/;

export function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
}

export function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

/** Sets an input's value the way React notices (native setter + input event). */
export function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
}

export const $ = <E extends Element = HTMLElement>(root: ParentNode, sel: string) => {
  const el = root.querySelector<E>(sel);
  if (!el) throw new Error(`no element matches ${sel}`);
  return el;
};
export const $$ = <E extends Element = HTMLElement>(root: ParentNode, sel: string) => [...root.querySelectorAll<E>(sel)];
