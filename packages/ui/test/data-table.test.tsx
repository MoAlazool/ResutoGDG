// @vitest-environment jsdom
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from '../src/base';
import { DataTableV2, useCursorPagination, type ColumnV2 } from '../src/data-table';
import { $, $$, click, EASTERN_DIGITS, html, key, mount } from './dom';

interface Row { id: string; name: string; total: number; status: string }
const ROWS: Row[] = [
  { id: 'r1', name: 'Mona', total: 300, status: 'paid' },
  { id: 'r2', name: 'Adel', total: 1200, status: 'open' },
  { id: 'r3', name: 'Karim', total: 50, status: 'open' },
];
const COLS: ColumnV2<Row>[] = [
  { key: 'name', header: 'Guest', render: (r) => r.name, sort: (a, b) => a.name.localeCompare(b.name) },
  { key: 'total', header: 'Total', render: (r) => r.total, align: 'end', sort: (a, b) => a.total - b.total },
  { key: 'status', header: 'Status', render: (r) => r.status },
];
const names = (host: HTMLElement) => $$(host, 'tbody tr').map((tr) => tr.querySelector('th .dt-cell')?.textContent);

describe('DataTableV2', () => {
  it('makes a scrolling table without controls a focusable, named region (keyboard scrolling), and only then', () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get() { return this.classList.contains('rui-dt-scroll') ? 900 : 0; } });
    try {
      const plain = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS.map((c) => ({ ...c, sort: undefined }))} rowKey={(r) => r.id} />);
      const box = $(plain.host, '.rui-dt-scroll');
      expect(box.getAttribute('tabindex')).toBe('0');
      expect(box.getAttribute('role')).toBe('region');
      expect(document.getElementById(box.getAttribute('aria-labelledby')!)?.textContent).toBe('Orders');
      // Sort buttons in the header can take the focus and scroll the box: no extra tab stop.
      const withButtons = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} />);
      expect($(withButtons.host, '.rui-dt-scroll').hasAttribute('tabindex')).toBe(false);
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', width);
      else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    }
  });

  it('names the table, marks the row header cell and keeps the mobile label/value markup', () => {
    const out = html(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} />);
    expect(out).toContain('<caption');
    expect(out).toContain('scope="row"');
    expect(out).toContain('class="dt-label"');
    expect(out).toContain('data-sticky=""');
  });

  it('sorts from the header buttons and reports aria-sort (ascending → descending → off)', () => {
    const v = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} />);
    expect(names(v.host)).toEqual(['Mona', 'Adel', 'Karim']);
    const totalTh = $$(v.host, 'thead th')[1]!;
    expect(totalTh.getAttribute('aria-sort')).toBe('none');
    click($(totalTh, 'button'));
    expect(totalTh.getAttribute('aria-sort')).toBe('ascending');
    expect(names(v.host)).toEqual(['Karim', 'Mona', 'Adel']);
    click($(totalTh, 'button'));
    expect(totalTh.getAttribute('aria-sort')).toBe('descending');
    expect(names(v.host)).toEqual(['Adel', 'Mona', 'Karim']);
    click($(totalTh, 'button'));
    expect(totalTh.getAttribute('aria-sort')).toBe('none');
    expect($$(v.host, 'thead th')[2]!.hasAttribute('aria-sort')).toBe(false);
    v.unmount();
  });

  it('sends server sorting through onSortChange without reordering locally', () => {
    const onSortChange = vi.fn();
    const cols: ColumnV2<Row>[] = [{ key: 'name', header: 'Guest', render: (r) => r.name, sortKey: 'guest_name' }];
    const v = mount(<DataTableV2 label="Orders" rows={ROWS} columns={cols} rowKey={(r) => r.id} sort={null} onSortChange={onSortChange} />);
    click($(v.host, 'thead button'));
    expect(onSortChange).toHaveBeenCalledWith({ key: 'guest_name', dir: 'asc' });
    expect(names(v.host)).toEqual(['Mona', 'Adel', 'Karim']);
    v.unmount();
  });

  it('makes rows keyboard-reachable: a real link in the row header, or a focusable row that Enter activates', () => {
    const linked = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} rowHref={(r) => `/orders/${r.id}`} />);
    const links = $$<HTMLAnchorElement>(linked.host, 'tbody a.rui-dt-rowlink');
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/orders/r1', '/orders/r2', '/orders/r3']);
    expect(links[0]!.closest('th')?.getAttribute('scope')).toBe('row');
    linked.unmount();
    const onRowClick = vi.fn();
    const clickable = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    const tr = $$(clickable.host, 'tbody tr')[1]!;
    expect(tr.tabIndex).toBe(0);
    key(tr, 'Enter');
    expect(onRowClick).toHaveBeenCalledWith(ROWS[1]);
    key(tr, ' ');
    expect(onRowClick).toHaveBeenCalledTimes(2);
    clickable.unmount();
  });

  it('keeps a click on a control inside a clickable row (selection checkbox, button) from opening the row', () => {
    const onRowClick = vi.fn();
    const own = vi.fn();
    const v = mount(<DataTableV2 label="Orders" rows={ROWS} rowKey={(r) => r.id} onRowClick={onRowClick} selectable
      columns={[...COLS, { key: 'act', header: 'Action', render: (r) => <button type="button" onClick={() => own(r.id)}>Pay</button> }]} />);
    click($$<HTMLInputElement>(v.host, 'tbody input[type="checkbox"]')[0]!);
    expect($(v.host, '.rui-dt-bulk').textContent).toContain('1 selected');
    click($$(v.host, 'tbody button').find((b) => b.textContent === 'Pay')!);
    expect(own).toHaveBeenCalledWith('r1');
    expect(onRowClick).not.toHaveBeenCalled();
    click($$(v.host, 'tbody td')[2]!);
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
    v.unmount();
  });

  it('selects rows, shows the bulk-action bar with the count, and clears it', () => {
    const bulk = vi.fn();
    const v = mount(<DataTableV2 label="Orders" rows={ROWS} columns={COLS} rowKey={(r) => r.id} selectable
      bulkActions={(keys) => <button type="button" onClick={() => bulk(keys)}>Mark paid</button>} />);
    expect(v.host.querySelector('.rui-dt-bulk')).toBeNull();
    const boxes = $$<HTMLInputElement>(v.host, 'tbody input[type="checkbox"]');
    click(boxes[0]!);
    expect($(v.host, '.rui-dt-bulk').textContent).toContain('1 selected');
    const all = $<HTMLInputElement>(v.host, 'thead input[type="checkbox"]');
    expect(all.indeterminate).toBe(true);
    click(all);
    expect($(v.host, '.rui-dt-bulk').textContent).toContain('3 selected');
    click($$(v.host, '.rui-dt-bulk button').find((b) => b.textContent === 'Mark paid')!);
    expect(bulk).toHaveBeenCalledWith(['r1', 'r2', 'r3']);
    click($$(v.host, '.rui-dt-bulk button').find((b) => b.textContent === 'Clear selection')!);
    expect(v.host.querySelector('.rui-dt-bulk')).toBeNull();
    v.unmount();
  });

  it('hides columns from the Columns menu (never the first) and switches density', () => {
    const v = mount(<DataTableV2 label="Orders" rows={ROWS} columns={[...COLS.slice(0, 2), { ...COLS[2]!, defaultHidden: true }]} rowKey={(r) => r.id} columnToggle densityToggle />);
    expect($$(v.host, 'thead th').map((th) => th.textContent)).toEqual(['Guest', 'Total']);
    click($$(v.host, '.rui-dt-toolbar button').find((b) => b.textContent === 'Columns')!);
    const checks = $$<HTMLInputElement>(v.host, '.rui-dt-columns input');
    expect(checks[0]!.disabled).toBe(true);
    click(checks[2]!);
    expect($$(v.host, 'thead th').map((th) => th.textContent)).toEqual(['Guest', 'Total', 'Status']);
    expect($(v.host, '.rui-dt').dataset.density).toBe('comfortable');
    click($$(v.host, '[role="radio"]').find((b) => b.textContent === 'Compact')!);
    expect($(v.host, '.rui-dt').dataset.density).toBe('compact');
    v.unmount();
  });

  it('shows the empty state and cursor pagination, in Arabic with Western digits', () => {
    const empty = html(<DataTableV2 label="الطلبات" rows={[]} columns={COLS} rowKey={(r) => r.id} />, 'ar');
    expect(empty).toContain('لا يوجد شيء بعد');
    const onNext = vi.fn();
    const v = mount(<DataTableV2 label="الطلبات" rows={ROWS} columns={COLS} rowKey={(r) => r.id} selectable
      pagination={{ hasNext: true, hasPrev: false, onNext, summary: 'صفحة 2' }} />, 'ar');
    click($$(v.host, 'tbody input')[0]!);
    expect($(v.host, '.rui-dt-bulk').textContent).toContain('تم تحديد 1');
    const [prev, next] = $$<HTMLButtonElement>(v.host, '.rui-dt-pager button');
    expect(prev!.disabled).toBe(true);
    expect(next!.textContent).toBe('التالي');
    click(next!);
    expect(onNext).toHaveBeenCalled();
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('useCursorPagination keeps the cursor stack for Previous', () => {
    let api!: ReturnType<typeof useCursorPagination>;
    function P() { api = useCursorPagination(); return <span>{api.page}</span>; }
    const v = mount(<P />);
    expect(api.cursor).toBeNull();
    act(() => api.next('c2'));
    act(() => api.next('c3'));
    expect([api.cursor, api.page, api.hasPrev]).toEqual(['c3', 3, true]);
    act(() => api.prev());
    expect(api.cursor).toBe('c2');
    act(() => api.next(null));
    expect(api.page).toBe(2);
    act(() => api.reset());
    expect([api.cursor, api.page]).toEqual([null, 1]);
    v.unmount();
  });
});

describe('DataTable (v1) stays as it was', () => {
  it('renders the same markup for existing pages', () => {
    function T() { const [rows] = useState(ROWS); return <DataTable rows={rows} columns={COLS} rowKey={(r) => r.id} />; }
    const out = html(<T />);
    expect(out).toContain('class="table-wrap dt-stack"');
    expect(out).not.toContain('scope="row"');
    expect(out.match(/<tr/g)).toHaveLength(4);
  });
});
