// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, staggerStyle, withViewTransition } from '../src/motion';
import { BoardPage, DetailPage, ListPage, SettingsPage, WorkspacePage } from '../src/templates';
import { $, $$, EASTERN_DIGITS, html, mount } from './dom';

describe('page templates', () => {
  it('ListPage: header, filters, list and footer', () => {
    const out = html(<ListPage header={{ title: 'Orders', subtitle: 'Today', actions: <button type="button">New</button> }} filters={<div id="f" />} footer={<nav />}><table /></ListPage>);
    expect(out).toContain('<h1>Orders</h1>');
    expect(out).toContain('rui-page-filters');
    expect(out).toContain('rui-page-footer');
  });

  it('DetailPage: a named inspector at the reading end only when given', () => {
    expect(html(<DetailPage header={{ title: 'Order 12' }}><p /></DetailPage>)).not.toContain('<aside');
    const v = mount(<DetailPage header={{ title: 'الطلب 12' }} inspector={<p>تفاصيل</p>} inspectorLabel="التفاصيل"><p>main</p></DetailPage>, 'ar');
    expect($(v.host, 'aside').getAttribute('aria-label')).toBe('التفاصيل');
    expect($(v.host, '.rui-detail-grid').hasAttribute('data-has-inspector')).toBe(true);
    expect(getComputedStyle($(v.host, 'aside')).direction).toBe('rtl');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('WorkspacePage: navigator, centre and inspector panes with landmarks', () => {
    const out = html(<WorkspacePage start={<p />} end={<p />} toolbar={<button type="button">x</button>} labels={{ start: 'Conversations', main: 'Thread', end: 'Customer', toolbar: 'Inbox tools' }}><p /></WorkspacePage>);
    expect(out).toContain('<nav class="rui-workspace-pane rui-workspace-start" aria-label="Conversations">');
    expect(out).toContain('<section class="rui-workspace-pane rui-workspace-main" aria-label="Thread">');
    expect(out).toContain('<aside class="rui-workspace-pane rui-workspace-end" aria-label="Customer">');
    expect(out).toContain('role="toolbar"');
    expect(out).toContain('data-start="" data-end=""');
  });

  it('BoardPage: one named lane per stage with its count', () => {
    const v = mount(<BoardPage header={{ title: 'Kitchen' }} lanes={[
      { key: 'new', title: 'New', count: 3, tone: 'info', label: 'New tickets', children: <p /> },
      { key: 'ready', title: 'Ready', count: 1, tone: 'ok', children: <p /> },
    ]} />);
    const lanes = $$(v.host, '.rui-lane');
    expect(lanes).toHaveLength(2);
    expect(lanes[0]!.getAttribute('aria-label')).toBe('New tickets');
    expect(lanes.map((l) => l.querySelector('.rui-lane-count')?.textContent)).toEqual(['3', '1']);
    v.unmount();
  });

  it('SettingsPage: section links mark the current one', () => {
    const out = html(<SettingsPage navLabel="Settings sections" active="team" sections={[{ key: 'general', label: 'General', href: '?tab=general' }, { key: 'team', label: 'Team', href: '?tab=team' }]}><form /></SettingsPage>);
    expect(out).toContain('aria-label="Settings sections"');
    expect(out).toContain('<a href="?tab=team" aria-current="page">Team</a>');
    expect(out).not.toContain('<a href="?tab=general" aria-current');
    const buttons = html(<SettingsPage navLabel="الأقسام" active="a" sections={[{ key: 'a', label: 'عام' }]}><form /></SettingsPage>, 'ar');
    expect(buttons).toContain('aria-current="true"');
  });
});

describe('motion', () => {
  const doc = document as unknown as { startViewTransition?: unknown };
  afterEach(() => { delete doc.startViewTransition; vi.unstubAllGlobals(); });

  it('runs the update directly where the View Transitions API is missing', async () => {
    const update = vi.fn();
    await withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('uses the View Transitions API where present and motion is allowed', async () => {
    const update = vi.fn();
    doc.startViewTransition = vi.fn((fn: () => void) => { fn(); return { finished: Promise.resolve() }; });
    await withViewTransition(update);
    expect(doc.startViewTransition).toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips the transition under prefers-reduced-motion', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener() {}, removeEventListener() {} }));
    const start = vi.fn();
    doc.startViewTransition = start;
    const update = vi.fn();
    expect(prefersReducedMotion()).toBe(true);
    await withViewTransition(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('caps the stagger delay', () => {
    expect(staggerStyle(2)).toEqual({ animationDelay: '60ms' });
    expect(staggerStyle(40)).toEqual({ animationDelay: '240ms' });
  });
});
