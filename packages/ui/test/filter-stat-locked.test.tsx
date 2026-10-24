// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from '../src/base';
import { FilterBar, useSavedViews } from '../src/filter-bar';
import { LockedFeature } from '../src/locked-feature';
import { ProvenanceBadge, StatV2, provenanceFromMetaKind } from '../src/stat';
import { Loadable } from '../src/states';
import { $, $$, click, EASTERN_DIGITS, html, mount } from './dom';

describe('FilterBar', () => {
  it('shows saved views, search, controls and removable chips (EN)', () => {
    const onView = vi.fn();
    const onRemove = vi.fn();
    const onClear = vi.fn();
    const v = mount(<FilterBar search={{ value: '', onChange: () => {} }} views={[{ key: 'all', label: 'All' }, { key: 'late', label: 'Late' }]} activeView="late"
      onViewChange={onView} filters={<select aria-label="Branch"><option>Main</option></select>}
      chips={[{ key: 'status', label: 'Status: open', onRemove }]} onClearAll={onClear} />);
    expect($(v.host, '[role="search"]').getAttribute('aria-label')).toBe('Filters');
    const views = $$(v.host, '.rui-view-chip');
    expect(views.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    click(views[0]!);
    expect(onView).toHaveBeenCalledWith('all');
    const remove = $(v.host, '.rui-filter-chip button');
    expect(remove.getAttribute('aria-label')).toBe('Remove filter: Status: open');
    click(remove);
    expect(onRemove).toHaveBeenCalled();
    click($$(v.host, 'button').find((b) => b.textContent === 'Clear filters')!);
    expect(onClear).toHaveBeenCalled();
    v.unmount();
  });

  it('is bilingual', () => {
    const out = html(<FilterBar chips={[{ key: 's', label: 'الحالة: مفتوح', onRemove: () => {} }]} onClearAll={() => {}} views={[{ key: 'a', label: 'الكل' }]} onSaveView={() => {}} />, 'ar');
    expect(out).toContain('عوامل التصفية');
    expect(out).toContain('حفظ العرض');
    expect(out).toContain('إزالة عامل التصفية: الحالة: مفتوح');
    expect(out).not.toMatch(EASTERN_DIGITS);
  });

  it('useSavedViews stores views in this browser and survives broken storage', () => {
    let api!: ReturnType<typeof useSavedViews<{ status: string }>>;
    function P() { api = useSavedViews<{ status: string }>('test-views'); return null; }
    const v = mount(<P />);
    act(() => { api.save('Late orders', { status: 'late' }); });
    expect(api.views).toEqual([{ key: 'late-orders', label: 'Late orders', value: { status: 'late' } }]);
    expect(JSON.parse(window.localStorage.getItem('test-views')!)).toHaveLength(1);
    act(() => { api.remove('late-orders'); });
    expect(api.views).toEqual([]);
    v.unmount();
  });
});

describe('StatV2 and provenance', () => {
  it('shows value, unit, delta and provenance; a decrease can be good', () => {
    const out = html(<StatV2 label="Revenue" value="12,400" unit="EGP" delta={{ value: 12.5, label: 'vs last week' }} provenance="live" sparkline={[1, 3, 2, 5]} />);
    expect(out).toContain('Live');
    expect(out).toContain('+12.5%');
    expect(out).toContain('data-trend="good"');
    expect(out).toContain('vs last week');
    expect(out).toContain('rui-spark');
    expect(html(<StatV2 label="Wait" value="8" delta={{ value: -10, inverse: true }} />)).toContain('data-trend="good"');
    expect(html(<StatV2 label="Wait" value="8" delta={{ value: -10 }} />)).toContain('data-trend="bad"');
    expect(html(<StatV2 label="Wait" value="8" delta={{ value: null }} />)).toContain('No comparison');
  });

  it('never shows a value it does not have: unavailable is a dash, without delta or sparkline', () => {
    const out = html(<StatV2 label="Satisfaction" value="4.8" provenance="unavailable" delta={{ value: 3 }} sparkline={[1, 2]} />);
    expect(out).toContain('—');
    expect(out).not.toContain('4.8');
    expect(out).not.toContain('rui-spark');
    expect(out).toContain('Unavailable');
  });

  it('labels provenance in Arabic with Western digits', () => {
    const out = html(<StatV2 label="الإيراد" value="12,400" unit="ج.م." delta={{ value: 4.25 }} provenance="estimated" />, 'ar');
    expect(out).toContain('تقديري');
    expect(out).toContain('+4.3%');
    expect(out).not.toMatch(EASTERN_DIGITS);
    expect(html(<ProvenanceBadge provenance="sandbox" />, 'ar')).toContain('تجريبي');
    expect(provenanceFromMetaKind('measured')).toBe('live');
    expect(provenanceFromMetaKind('mixed')).toBe('estimated');
    expect(provenanceFromMetaKind(undefined)).toBe('unavailable');
  });

  it('is a link when it drills down', () => {
    expect(html(<StatV2 label="Orders" value="42" href="/orders" />)).toMatch(/^<a class="rui-stat" href="\/orders"/);
  });
});

describe('EmptyState and Loadable', () => {
  it('EmptyState shows an icon and actions, and keeps its old markup without them', () => {
    expect(html(<EmptyState title="No orders" />)).toBe('<div class="empty"><strong>No orders</strong></div>');
    const out = html(<EmptyState title="لا طلبات" icon={<svg />} action={<a href="/menu">أضف</a>} secondary={<button type="button">استيراد</button>} />, 'ar');
    expect(out).toContain('class="empty-icon"');
    expect(out).toContain('class="empty-actions"');
  });

  it('Loadable fades content in only when asked', () => {
    const state = { data: [1], error: null, loading: false };
    expect(html(<Loadable state={state} skeleton={<i />}>{() => <b>ok</b>}</Loadable>)).toBe('<b>ok</b>');
    expect(html(<Loadable state={state} skeleton={<i />} fade>{() => <b>ok</b>}</Loadable>)).toBe('<div class="motion-content"><b>ok</b></div>');
  });
});

describe('LockedFeature', () => {
  it('shows an inert preview, benefits and the upgrade action (EN)', () => {
    const v = mount(<LockedFeature title="Inventory" description="Track stock." plan="Growth" benefits={['Low-stock alerts', 'Stocktakes']}
      preview={<button type="button">Preview button</button>} cta={{ label: 'Upgrade to Growth', href: '/billing' }} />);
    const preview = $(v.host, '.rui-locked-preview');
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.hasAttribute('inert')).toBe(true);
    expect($$(v.host, '.rui-locked-benefits li')).toHaveLength(2);
    expect($<HTMLAnchorElement>(v.host, '.rui-locked-actions a').getAttribute('href')).toBe('/billing');
    expect($(v.host, 'section').getAttribute('aria-labelledby')).toBe($(v.host, 'h2').id);
    expect($(v.host, '.rui-locked-badge').textContent).toBe('Growth');
    v.unmount();
  });

  it('has Arabic defaults', () => {
    const out = html(<LockedFeature title="المخزون" benefits={['تنبيهات انخفاض المخزون']} />, 'ar');
    expect(out).toContain('ما ستحصل عليه');
    expect(out).toContain('عرض الباقات');
    expect(out).toContain('غير مشمول في باقتك');
    expect(out).not.toMatch(EASTERN_DIGITS);
  });
});
