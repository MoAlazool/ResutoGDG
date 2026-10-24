'use client';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { SearchInput } from './inputs';
import { useUiLocale } from './locale';
import type { UiLocale } from './overlays';

const L = {
  en: { label: 'Filters', views: 'Saved views', saveView: 'Save view', clearAll: 'Clear filters', remove: 'Remove filter: {f}', active: 'Active filters' },
  ar: { label: 'عوامل التصفية', views: 'العروض المحفوظة', saveView: 'حفظ العرض', clearAll: 'مسح عوامل التصفية', remove: 'إزالة عامل التصفية: {f}', active: 'عوامل التصفية النشطة' },
};

export interface FilterChip { key: string; label: ReactNode; text?: string; onRemove: () => void }
export interface SavedView { key: string; label: ReactNode }

/**
 * The row above a list: saved views, search, filter controls, the active filters as removable chips, and actions at
 * the reading end. Purely presentational: the page owns the filter state (URL params, saved views).
 */
export function FilterBar({ search, filters, chips, onClearAll, views, activeView, onViewChange, onSaveView, actions, labels, locale }: {
  search?: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string; debounceMs?: number };
  filters?: ReactNode; chips?: FilterChip[]; onClearAll?: () => void;
  views?: SavedView[]; activeView?: string | null; onViewChange?: (key: string) => void; onSaveView?: () => void;
  actions?: ReactNode; labels?: Partial<typeof L.en>; locale?: UiLocale;
}) {
  const ctx = useUiLocale();
  const loc = locale ?? ctx;
  const t = { ...L[loc], ...labels };
  return (
    <div className="rui-filterbar" role="search" aria-label={t.label}>
      {views && views.length > 0 && (
        <div className="rui-filterbar-views" role="group" aria-label={t.views}>
          {views.map((v) => (
            <button key={v.key} type="button" className="rui-view-chip" aria-pressed={activeView === v.key} onClick={() => onViewChange?.(v.key)}>{v.label}</button>
          ))}
          {onSaveView && <button type="button" className="btn btn-sm btn-ghost" onClick={onSaveView}>{t.saveView}</button>}
        </div>
      )}
      <div className="rui-filterbar-row">
        {search && (
          <div className="rui-filterbar-search">
            <SearchInput value={search.value} onChange={search.onChange} placeholder={search.placeholder} label={search.label} debounceMs={search.debounceMs} locale={loc} />
          </div>
        )}
        {filters && <div className="rui-filterbar-controls">{filters}</div>}
        {actions && <div className="rui-filterbar-actions">{actions}</div>}
      </div>
      {chips && chips.length > 0 && (
        <ul className="rui-filterbar-chips" aria-label={t.active}>
          {chips.map((c) => (
            <li key={c.key} className="rui-filter-chip">
              <span>{c.label}</span>
              <button type="button" onClick={c.onRemove} aria-label={t.remove.replace('{f}', c.text ?? (typeof c.label === 'string' ? c.label : c.key))}>
                <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </li>
          ))}
          {onClearAll && <li><button type="button" className="btn btn-sm btn-ghost" onClick={onClearAll}>{t.clearAll}</button></li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Saved filter views for one list, kept in this browser (a per-person convenience; storage failures are ignored).
 * `save(label, value)` adds or replaces a view; `remove(key)` deletes it.
 */
export function useSavedViews<V>(storageKey: string) {
  const [views, setViews] = useState<Array<{ key: string; label: string; value: V }>>([]);
  useEffect(() => {
    try { const raw = window.localStorage.getItem(storageKey); if (raw) setViews(JSON.parse(raw)); } catch { /* unavailable storage */ }
  }, [storageKey]);
  const persist = useCallback((next: Array<{ key: string; label: string; value: V }>) => {
    setViews(next);
    try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* unavailable storage */ }
  }, [storageKey]);
  return {
    views,
    save: useCallback((label: string, value: V) => {
      const key = label.trim().toLocaleLowerCase().replace(/\s+/g, '-') || String(Date.now());
      persist([...views.filter((v) => v.key !== key), { key, label: label.trim(), value }]);
      return key;
    }, [views, persist]),
    remove: useCallback((key: string) => persist(views.filter((v) => v.key !== key)), [views, persist]),
  };
}
