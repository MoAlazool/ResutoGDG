'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EmptyState, type Column } from './base';
import { SegmentedControl } from './controls';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';
import { Popover } from './popover';

// DataTable v2. The original DataTable (base.tsx) keeps its API and markup for the pages that use it; this is the
// table new and migrated pages use. Same column shape ({ key, header, render, align }) plus optional sorting,
// visibility and row headers, so a page moves over by renaming the import.

export interface ColumnV2<T> extends Column<T> {
  /** Client-side comparator; the header becomes a sort button. */
  sort?: (a: T, b: T) => number;
  /** Server-side sort key (sent through onSortChange); the header becomes a sort button. */
  sortKey?: string;
  /** Can be hidden from the Columns menu (default true; the first column never hides). */
  hideable?: boolean;
  defaultHidden?: boolean;
  /** The cell that names the row (<th scope="row">); defaults to the first visible column. */
  rowHeader?: boolean;
  /** CSS width of the column (e.g. '12ch', '140px'). */
  width?: string;
}

export interface SortState { key: string; dir: 'asc' | 'desc' }
export type Density = 'comfortable' | 'compact';

const L = {
  en: {
    select: 'Select row', selectAll: 'Select all rows on this page', selected: '{n} selected', clear: 'Clear selection',
    columns: 'Columns', density: 'Density', comfortable: 'Comfortable', compact: 'Compact', sortAsc: 'sorted ascending',
    sortDesc: 'sorted descending', sortBy: 'Sort by {col}', next: 'Next', prev: 'Previous', empty: 'Nothing here yet', toolbar: 'Table options',
  },
  ar: {
    select: 'تحديد الصف', selectAll: 'تحديد كل صفوف هذه الصفحة', selected: 'تم تحديد {n}', clear: 'إلغاء التحديد',
    columns: 'الأعمدة', density: 'الكثافة', comfortable: 'مريحة', compact: 'مضغوطة', sortAsc: 'مرتب تصاعديًا',
    sortDesc: 'مرتب تنازليًا', sortBy: 'ترتيب حسب {col}', next: 'التالي', prev: 'السابق', empty: 'لا يوجد شيء بعد', toolbar: 'خيارات الجدول',
  },
};
export type DataTableLabels = typeof L.en;
const fill = (s: string, v: Record<string, string | number>) => Object.entries(v).reduce((a, [k, x]) => a.replaceAll(`{${k}}`, String(x)), s);
const text = (n: ReactNode) => (typeof n === 'string' || typeof n === 'number' ? String(n) : '');

/** Cursor pagination over `{ items, nextCursor }` lists: keeps the stack of cursors so Previous works. */
export function useCursorPagination(reset: unknown[] = []) {
  const [stack, setStack] = useState<Array<string | null>>([null]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setStack([null]), reset);
  const cursor = stack[stack.length - 1] ?? null;
  return {
    cursor, page: stack.length, hasPrev: stack.length > 1,
    next: useCallback((nextCursor: string | null | undefined) => { if (nextCursor) setStack((s) => [...s, nextCursor]); }, []),
    prev: useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []),
    reset: useCallback(() => setStack([null]), []),
  };
}

export interface DataTableV2Props<T> {
  rows: T[];
  columns: ColumnV2<T>[];
  rowKey: (row: T) => string;
  /** Accessible name (also the table's caption for screen readers). */
  label: string;
  empty?: ReactNode;
  /** Previous result while a new one loads: dimmed + aria-busy. */
  busy?: boolean;
  /** Makes each row a link (the row header cell holds a real <a>, and the whole row is its click target). */
  rowHref?: (row: T) => string | null | undefined;
  /** Renders the row link, e.g. with next/link: (href, children, className) => <Link …/>. */
  renderLink?: (href: string, children: ReactNode, className: string) => ReactNode;
  /** Row action without a URL: the row becomes focusable and Enter/Space trigger it. */
  onRowClick?: (row: T) => void;
  /** Controlled sort (server sorting). Without it, columns with `sort` sort the given rows locally. */
  sort?: SortState | null;
  onSortChange?: (s: SortState | null) => void;
  defaultSort?: SortState | null;
  selectable?: boolean;
  selected?: string[];
  onSelectedChange?: (keys: string[]) => void;
  /** Bulk-action bar content while rows are selected. */
  bulkActions?: (keys: string[], clear: () => void) => ReactNode;
  /** Shows the Columns menu. */
  columnToggle?: boolean;
  hiddenColumns?: string[];
  onHiddenColumnsChange?: (keys: string[]) => void;
  density?: Density;
  onDensityChange?: (d: Density) => void;
  /** Shows the density switch. */
  densityToggle?: boolean;
  /** Keeps the header row visible while the body scrolls inside a box of this height (default 70vh). */
  stickyHeader?: boolean;
  maxHeight?: string;
  /** Cursor pagination hooks (see useCursorPagination). */
  pagination?: { hasNext: boolean; hasPrev?: boolean; onNext: () => void; onPrev?: () => void; summary?: ReactNode };
  /** Extra toolbar content at the reading start (filters live in FilterBar above the table). */
  toolbar?: ReactNode;
  labels?: Partial<DataTableLabels>;
  locale?: UiLocale;
}

export function DataTableV2<T>(props: DataTableV2Props<T>) {
  const { rows, columns, rowKey, label, busy, rowHref, renderLink, onRowClick, selectable, bulkActions, pagination, toolbar } = props;
  const ctx = useUiLocale();
  const t = { ...L[props.locale ?? ctx], ...props.labels };
  const id = useId();

  const [innerSort, setInnerSort] = useState<SortState | null>(props.defaultSort ?? null);
  const sort = props.sort !== undefined ? props.sort : innerSort;
  const [innerHidden, setInnerHidden] = useState<string[]>(() => columns.filter((c) => c.defaultHidden).map((c) => c.key));
  const hidden = props.hiddenColumns ?? innerHidden;
  const [innerDensity, setInnerDensity] = useState<Density>('comfortable');
  const density = props.density ?? innerDensity;
  const [innerSel, setInnerSel] = useState<string[]>([]);
  const selected = props.selected ?? innerSel;
  const setSelected = (keys: string[]) => { if (props.selected === undefined) setInnerSel(keys); props.onSelectedChange?.(keys); };

  const visible = columns.filter((c, i) => i === 0 || !hidden.includes(c.key));
  const headerKey = (visible.find((c) => c.rowHeader) ?? visible[0])?.key;
  const sorted = useMemo(() => {
    if (!sort || props.sort !== undefined) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const out = [...rows].sort(col.sort);
    return sort.dir === 'desc' ? out.reverse() : out;
  }, [rows, columns, sort, props.sort]);
  const keys = sorted.map(rowKey);
  const allOn = selectable && keys.length > 0 && keys.every((k) => selected.includes(k));
  const someOn = selectable && keys.some((k) => selected.includes(k));
  const allRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = !!someOn && !allOn; }, [someOn, allOn]);

  const toggleSort = (c: ColumnV2<T>) => {
    const key = c.sortKey ?? c.key;
    const next: SortState | null = sort?.key !== key ? { key, dir: 'asc' } : sort.dir === 'asc' ? { key, dir: 'desc' } : null;
    if (props.sort === undefined) setInnerSort(next);
    props.onSortChange?.(next);
  };
  const setHidden = (keysNow: string[]) => { if (props.hiddenColumns === undefined) setInnerHidden(keysNow); props.onHiddenColumnsChange?.(keysNow); };
  const setDensity = (d: Density) => { if (props.density === undefined) setInnerDensity(d); props.onDensityChange?.(d); };
  const clear = () => setSelected([]);

  const showToolbar = toolbar || props.columnToggle || props.densityToggle;
  const rowKeyDown = (row: T) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick?.(row); }
  };

  return (
    <div className="rui-dt" data-density={density}>
      {showToolbar && (
        <div className="rui-dt-toolbar" role="toolbar" aria-label={t.toolbar}>
          <div className="rui-dt-toolbar-start">{toolbar}</div>
          <div className="rui-dt-toolbar-end">
            {props.densityToggle && (
              <SegmentedControl size="sm" label={t.density} value={density} onChange={setDensity}
                options={[{ value: 'comfortable', label: t.comfortable }, { value: 'compact', label: t.compact }]} />
            )}
            {props.columnToggle && (
              <Popover label={t.columns} align="end" trigger={<button type="button" className="btn btn-sm">{t.columns}</button>}>
                <fieldset className="rui-dt-columns">
                  <legend className="sr-only">{t.columns}</legend>
                  {columns.map((c, i) => (
                    <label key={c.key} className="check">
                      <input type="checkbox" checked={i === 0 || !hidden.includes(c.key)} disabled={i === 0 || c.hideable === false}
                        onChange={(e) => setHidden(e.currentTarget.checked ? hidden.filter((k) => k !== c.key) : [...hidden, c.key])} />
                      {c.header}
                    </label>
                  ))}
                </fieldset>
              </Popover>
            )}
          </div>
        </div>
      )}
      {selectable && selected.length > 0 && (
        <div className="rui-dt-bulk motion-slide-up" role="region" aria-label={fill(t.selected, { n: selected.length })}>
          <span className="num" aria-live="polite">{fill(t.selected, { n: selected.length })}</span>
          <div className="rui-dt-bulk-actions">{bulkActions?.(selected, clear)}</div>
          <button type="button" className="btn btn-sm btn-ghost" onClick={clear}>{t.clear}</button>
        </div>
      )}
      {!rows.length ? (
        <div className="card" aria-busy={busy || undefined}>{props.empty ?? <EmptyState title={t.empty} />}</div>
      ) : (
        <div className="table-wrap dt-stack rui-dt-scroll" aria-busy={busy || undefined} data-busy={busy || undefined}
          data-sticky={props.stickyHeader === false ? undefined : ''} style={{ ['--dt-max' as string]: props.maxHeight ?? '70vh' }}>
          <table className="data" aria-labelledby={`${id}-cap`}>
            <caption id={`${id}-cap`} className="sr-only">{label}</caption>
            <colgroup>
              {selectable && <col className="rui-dt-col-select" />}
              {visible.map((c) => <col key={c.key} style={c.width ? { inlineSize: c.width } : undefined} />)}
            </colgroup>
            <thead>
              <tr>
                {selectable && (
                  <th scope="col" className="rui-dt-select">
                    <input ref={allRef} type="checkbox" aria-label={t.selectAll} checked={!!allOn}
                      onChange={(e) => setSelected(e.currentTarget.checked ? [...new Set([...selected, ...keys])] : selected.filter((k) => !keys.includes(k)))} />
                  </th>
                )}
                {visible.map((c) => {
                  const sortable = !!(c.sort || c.sortKey);
                  const key = c.sortKey ?? c.key;
                  const dir = sort?.key === key ? sort.dir : null;
                  return (
                    <th key={c.key} scope="col" data-align={c.align ?? 'start'} aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : sortable ? 'none' : undefined}>
                      {sortable
                        ? <button type="button" className="rui-dt-sort" onClick={() => toggleSort(c)} data-dir={dir ?? undefined}
                          aria-label={text(c.header) ? fill(t.sortBy, { col: text(c.header) }) + (dir ? ` (${dir === 'asc' ? t.sortAsc : t.sortDesc})` : '') : undefined}>
                          {c.header}<span className="rui-dt-sort-icon" aria-hidden="true" />
                        </button>
                        : c.header}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const k = rowKey(r);
                const href = rowHref?.(r) ?? null;
                const clickable = !href && !!onRowClick;
                const isSel = selected.includes(k);
                return (
                  <tr key={k} data-selected={isSel || undefined} data-link={href ? '' : undefined}
                    tabIndex={clickable ? 0 : undefined} onClick={clickable ? () => onRowClick!(r) : undefined} onKeyDown={clickable ? rowKeyDown(r) : undefined}
                    className={clickable ? 'rui-dt-clickable' : undefined}>
                    {selectable && (
                      <td className="rui-dt-select">
                        <input type="checkbox" aria-label={t.select} checked={isSel}
                          onChange={(e) => setSelected(e.currentTarget.checked ? [...selected, k] : selected.filter((x) => x !== k))} />
                      </td>
                    )}
                    {visible.map((c) => {
                      const content = c.render(r);
                      const cell = c.key === headerKey && href
                        ? (renderLink ? renderLink(href, content, 'rui-dt-rowlink') : <a className="rui-dt-rowlink" href={href}>{content}</a>)
                        : content;
                      const inner = <>{c.header ? <span className="dt-label" aria-hidden="true">{c.header}</span> : null}<div className="dt-cell">{cell}</div></>;
                      return c.key === headerKey
                        ? <th key={c.key} scope="row" data-align={c.align ?? 'start'}>{inner}</th>
                        : <td key={c.key} data-align={c.align ?? 'start'}>{inner}</td>;
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pagination && (pagination.hasNext || pagination.hasPrev) && (
        <nav className="rui-dt-pager" aria-label={label}>
          <span aria-live="polite">{pagination.summary}</span>
          <div className="row">
            <button type="button" className="btn btn-sm" disabled={!pagination.hasPrev} onClick={pagination.onPrev}>{t.prev}</button>
            <button type="button" className="btn btn-sm" disabled={!pagination.hasNext} onClick={pagination.onNext}>{t.next}</button>
          </div>
        </nav>
      )}
    </div>
  );
}
