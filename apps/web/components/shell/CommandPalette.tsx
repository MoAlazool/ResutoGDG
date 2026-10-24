'use client';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Role } from '@resuto/contracts';
import { Kbd, OrderRef, Sheet, useModalDialog } from '@resuto/ui';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import type { NavArea } from '@/lib/nav';
import type { OrgInfo } from '@/lib/org-context';
import { actionEntries, pageEntries, type PaletteEntry } from '@/lib/palette-entries';
import { rankEntries, searchableQuery } from '@/lib/palette-match';
import { GO_SHORTCUTS } from '@/lib/shortcuts';
import './palette.css';

// The command palette and the shortcuts cheat sheet (21-SHELL). This module is its own chunk: the shell loads it the
// first time either is opened (⌘K / Ctrl K, the search button, or ?), so the staff routes' first load does not pay for it.

type SearchHit =
  | { type: 'order'; id: string; number: string; status: string; branchId: string; customerName: string | null; totalMinor: number; currency: string; placedAt: string }
  | { type: 'customer'; id: string; displayName: string | null; phone: string | null }
  | { type: 'product'; id: string; name: string; nameAr: string | null; priceMinor: number; currency: string };

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  org: OrgInfo;
  role: Role;
  areas: NavArea[];
  explore: boolean;
  branchId: string | null;
  allowAll: boolean;
  allBranches: boolean;
  onBranch(id: string | null): void;
  onNavigate(href: string): void;
  onLanguage(): void;
  onSignOut(): void;
  search(path: string, signal: AbortSignal): Promise<{ items: SearchHit[] }>;
}

interface Row { entry: PaletteEntry; group: string; content?: ReactNode }

export default function CommandPalette(props: CommandPaletteProps) {
  const { open, onClose, org, role, areas, explore, branchId, allowAll, allBranches, onBranch, onNavigate, onLanguage, onSignOut, search } = props;
  const { t, locale } = useT();
  const ref = useModalDialog(open);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'all' | 'branches'>('all');
  const [active, setActive] = useState(0);
  const [records, setRecords] = useState<{ q: string; items: SearchHit[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const base = `/dashboard/${org.id}`;

  useEffect(() => { if (open) { setQuery(''); setMode('all'); setActive(0); setRecords(null); setFailed(false); requestAnimationFrame(() => input.current?.focus()); } }, [open]);

  const pages = useMemo(() => pageEntries(areas, role, t, { explore }), [areas, role, t, explore]);
  const actions = useMemo(() => actionEntries({ role, hrefs: new Set(areas.flatMap((a) => a.items.map((i) => i.href))), multiBranch: org.branches.filter((b) => b.isActive).length > 1 }, t), [areas, role, t, org.branches]);
  const branchEntries = useMemo<PaletteEntry[]>(() => [
    ...(allowAll ? [{ id: 'branch:all', kind: 'branch' as const, label: t('shell.allBranches'), branchId: null }] : []),
    ...org.branches.filter((b) => b.isActive).map((b) => ({ id: `branch:${b.id}`, kind: 'branch' as const, label: pick(locale, b.name, b.nameAr), keywords: b.name, branchId: b.id })),
  ], [allowAll, org.branches, locale, t]);

  // Records: debounced, cancelled when the query changes, bounded by the API (20 hits).
  const canSearch = mode === 'all' && searchableQuery(query);
  useEffect(() => {
    if (!open || !canSearch) { setRecords(null); setSearching(false); return; }
    const ctl = new AbortController();
    setSearching(true);
    const h = setTimeout(() => {
      const q = query.trim();
      const params = new URLSearchParams({ q, ...(branchId && !allBranches ? { branchId } : {}) });
      search(`/o/${org.id}/search?${params}`, ctl.signal)
        .then((r) => { setRecords({ q, items: r.items }); setFailed(false); })
        .catch((e) => { if ((e as Error).name !== 'AbortError') setFailed(true); })
        .finally(() => { if (!ctl.signal.aborted) setSearching(false); });
    }, 200);
    return () => { clearTimeout(h); ctl.abort(); };
  }, [open, canSearch, query, org.id, branchId, allBranches, search]);

  const rows: Row[] = useMemo(() => {
    if (mode === 'branches') return rankEntries(branchEntries, query).map((entry) => ({ entry, group: t('palette.group.branches') }));
    const out: Row[] = [
      ...rankEntries(pages, query, query ? 8 : 12).map((entry) => ({ entry, group: t('palette.group.pages') })),
      ...rankEntries(actions, query, 6).map((entry) => ({ entry, group: t('palette.group.actions') })),
    ];
    for (const hit of records?.items ?? []) out.push(recordRow(hit));
    return out;
    function recordRow(hit: SearchHit): Row {
      const group = t('palette.group.records');
      if (hit.type === 'order') {
        return { group, entry: { id: `order:${hit.id}`, kind: 'record', label: hit.number, href: `/orders?order=${hit.id}`, hint: t('palette.kind.order') },
          content: <><OrderRef n={hit.number} /> {hit.customerName && <bdi className="cp-sub">{hit.customerName}</bdi>} <span className="cp-sub num">{money(hit.totalMinor, hit.currency as 'EGP', locale)}</span></> };
      }
      if (hit.type === 'customer') {
        return { group, entry: { id: `customer:${hit.id}`, kind: 'record', label: hit.displayName ?? hit.phone ?? '—', href: `/customers/${hit.id}`, hint: t('palette.kind.customer') },
          content: <><bdi>{hit.displayName ?? '—'}</bdi> {hit.phone && <bdi dir="ltr" className="cp-sub">{hit.phone}</bdi>}</> };
      }
      const name = pick(locale, hit.name, hit.nameAr);
      return { group, entry: { id: `product:${hit.id}`, kind: 'record', label: name, href: `/menu?product=${hit.id}`, hint: t('palette.kind.product') },
        content: <><bdi>{name}</bdi> <span className="cp-sub num">{money(hit.priceMinor, hit.currency as 'EGP', locale)}</span></> };
    }
  }, [mode, branchEntries, pages, actions, records, query, t, locale]);

  useEffect(() => { setActive(0); }, [query, mode]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [active]);

  const choose = (row: Row | undefined) => {
    if (!row) return;
    const e = row.entry;
    if (e.kind === 'branch') { onBranch(e.branchId ?? null); onClose(); return; }
    if (e.action === 'branches') { setMode('branches'); setQuery(''); return; }
    if (e.action === 'language') { onClose(); onLanguage(); return; }
    if (e.action === 'signOut') { onClose(); onSignOut(); return; }
    if (e.href) { onClose(); onNavigate(base + e.href); }
  };
  const onKey = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive((a) => (rows.length ? (a + 1) % rows.length : 0)); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0)); }
    else if (ev.key === 'Home' && ev.ctrlKey) { ev.preventDefault(); setActive(0); }
    else if (ev.key === 'End' && ev.ctrlKey) { ev.preventDefault(); setActive(Math.max(0, rows.length - 1)); }
    else if (ev.key === 'Enter') { ev.preventDefault(); choose(rows[active]); }
    else if (ev.key === 'Backspace' && !query && mode === 'branches') { ev.preventDefault(); setMode('all'); }
  };

  const optionId = (i: number) => `${id}-opt-${i}`;
  let lastGroup = '';
  return (
    <dialog ref={ref} className="cp" aria-label={t('palette.title')} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={() => { if (open) onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cp-panel">
        <div className="cp-search">
          {mode === 'branches' && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setMode('all'); input.current?.focus(); }}>{t('palette.back')}</button>}
          <input ref={input} className="cp-input" type="text" role="combobox" aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list"
            aria-activedescendant={rows.length ? optionId(active) : undefined} aria-label={t('palette.title')}
            placeholder={mode === 'branches' ? t('palette.action.switchBranch') : t('palette.placeholder')}
            value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} autoComplete="off" spellCheck={false} />
        </div>
        <ul ref={list} id={`${id}-list`} role="listbox" className="cp-list" aria-label={t('palette.title')}>
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <li key={row.entry.id} role="presentation">
                {header && <div className="cp-group" role="presentation">{header}</div>}
                <div id={optionId(i)} role="option" aria-selected={i === active} data-index={i} className="cp-option"
                  onMouseMove={() => { if (i !== active) setActive(i); }} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(row)}>
                  <span className="cp-label">{row.content ?? <bdi>{row.entry.label}</bdi>}</span>
                  {row.entry.hint && <span className="cp-hint">{row.entry.hint}</span>}
                </div>
              </li>
            );
          })}
        </ul>
        <div className="cp-status" role="status" aria-live="polite">
          {!rows.length && !searching ? t('palette.empty') : searching ? t('palette.searching') : failed ? t('palette.searchFailed') : ''}
        </div>
        <div className="cp-foot" aria-hidden="true">
          <span><Kbd keys={['↑', '↓']} /> {t('palette.hint.move')}</span>
          <span><Kbd>Enter</Kbd> {t('palette.hint.open')}</span>
          <span><Kbd>Esc</Kbd> {t('palette.hint.close')}</span>
        </div>
      </div>
    </dialog>
  );
}

/** The `?` cheat sheet: palette, help, and the `g` shortcuts the member's navigation offers. */
export function ShortcutsSheet({ open, onClose, visibleHrefs }: { open: boolean; onClose(): void; visibleHrefs: Set<string> }) {
  const { t } = useT();
  const go = GO_SHORTCUTS.filter((s) => visibleHrefs.has(s.item.href));
  return (
    <Sheet open={open} onClose={onClose} title={t('shortcuts.title')} description={t('shortcuts.note')} size="sm" labels={{ close: t('action.close') }}>
      <h3 className="cp-sheet-h">{t('shortcuts.general')}</h3>
      <dl className="cp-keys">
        <div><dt><Kbd keys={['⌘', 'K']} /> <span className="cp-or">{t('shortcuts.or')}</span> <Kbd keys={['Ctrl', 'K']} /></dt><dd>{t('shortcuts.palette')}</dd></div>
        <div><dt><Kbd>?</Kbd></dt><dd>{t('shortcuts.help')}</dd></div>
      </dl>
      {go.length > 0 && <>
        <h3 className="cp-sheet-h">{t('shortcuts.goTo')}</h3>
        <dl className="cp-keys">
          {go.map((s) => (
            <div key={s.letter}><dt><Kbd>g</Kbd> <span className="cp-or">{t('shortcuts.then')}</span> <Kbd>{s.letter}</Kbd></dt><dd>{t(s.item.label)}</dd></div>
          ))}
        </dl>
      </>}
    </Sheet>
  );
}
