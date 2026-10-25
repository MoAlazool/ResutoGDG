'use client';
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Category } from '@resuto/contracts';
import { Menu } from '@resuto/ui';
import { formatNumber } from '@resuto/contracts/lite';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { MenuIcon } from './icons';
import { moveId } from './model';

/**
 * The category rail (21-MENU): "All dishes", then each category with its dish count. Choosing one filters the table.
 * Writers reorder by dragging a row, or from the keyboard on its handle (Arrow Up / Down move it one place, Home / End
 * to the top or bottom); every move is announced. Rename, move and archive are also in each row's menu, which works
 * on touch screens where dragging does not.
 */
export function CategoryRail({ categories, counts, total, selected, onSelect, writable, busy, onAdd, onRename, onArchive, onReorder }: {
  categories: Category[]; counts: Map<string, number>; total: number; selected: string; onSelect: (id: string) => void;
  writable: boolean; busy: boolean; onAdd: () => void; onRename: (c: Category) => void; onArchive: (c: Category) => void;
  onReorder: (ids: string[]) => Promise<void>;
}) {
  const { t, locale } = useT();
  const [order, setOrder] = useState<string[]>(() => categories.map((c) => c.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [said, setSaid] = useState('');
  const focusAfter = useRef<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const key = categories.map((c) => c.id).join(',');
  useEffect(() => { setOrder(categories.map((c) => c.id)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusAfter.current) return;
    list.current?.querySelector<HTMLElement>(`[data-handle="${focusAfter.current}"]`)?.focus();
    focusAfter.current = null;
  });
  const byId = new Map(categories.map((c) => [c.id, c]));
  const shown = order.map((id) => byId.get(id)).filter((c): c is Category => !!c);
  const name = (c: Category) => pick(locale, c.name, c.nameAr);

  const move = (id: string, to: number) => {
    const from = order.indexOf(id);
    const next = moveId(order, from, to);
    if (next === order) return;
    setOrder(next);
    const c = byId.get(id);
    if (c) setSaid(t('menu.ws.rail.moved', { name: name(c), pos: formatNumber(next.indexOf(id) + 1, locale), total: formatNumber(next.length, locale) }));
    void onReorder(next).catch(() => setOrder(categories.map((x) => x.id)));
  };
  const handleKey = (id: string) => (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = order.indexOf(id);
    const to = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : null;
    if (to === null || busy) return;
    e.preventDefault();
    focusAfter.current = id;
    move(id, to);
  };
  const dragProps = (c: Category) => writable ? {
    draggable: !busy,
    onDragStart: (e: DragEvent<HTMLLIElement>) => { setDragging(c.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); },
    onDragEnd: () => { setDragging(null); setOver(null); },
    onDragOver: (e: DragEvent<HTMLLIElement>) => {
      if (!dragging || dragging === c.id) return;
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      if (over?.id !== c.id || over.after !== after) setOver({ id: c.id, after });
    },
    onDrop: (e: DragEvent<HTMLLIElement>) => {
      e.preventDefault();
      const id = dragging ?? e.dataTransfer.getData('text/plain');
      setDragging(null); setOver(null);
      if (!id || id === c.id) return;
      // The dragged category lands before or after this one: its index once it has left its own place.
      const at = order.filter((x) => x !== id).indexOf(c.id) + (over?.id === c.id && over.after ? 1 : 0);
      move(id, at);
    },
  } : {};

  return (
    <div className="menu-rail">
      <div className="menu-rail-head">
        <h2>{t('ops.menu.categories')}</h2>
        {writable && <button type="button" className="btn btn-sm" disabled={busy} onClick={onAdd}><MenuIcon name="plus" /> {t('menu.ws.rail.add')}</button>}
      </div>
      <ul className="menu-rail-list" ref={list} aria-label={t('ops.menu.categories')}>
        <li className="menu-rail-item">
          <button type="button" className="menu-rail-pick" aria-pressed={!selected} onClick={() => onSelect('')}>
            <span className="menu-rail-name">{t('menu.ws.rail.all')}</span><span className="menu-rail-count num">{formatNumber(total, locale)}</span>
          </button>
        </li>
        {shown.map((c, i) => (
          <li key={c.id} className="menu-rail-item" data-dragging={dragging === c.id || undefined}
            data-drop={over?.id === c.id ? (over.after ? 'after' : 'before') : undefined} {...dragProps(c)}>
            {writable && (
              <button type="button" className="menu-rail-handle" data-handle={c.id} disabled={busy} onKeyDown={handleKey(c.id)}
                aria-label={t('menu.ws.rail.reorder', { name: name(c) })} aria-describedby="menu-rail-reorder-hint">
                <MenuIcon name="grip" />
              </button>
            )}
            <button type="button" className="menu-rail-pick" aria-pressed={selected === c.id} onClick={() => onSelect(c.id)}>
              <span className="menu-rail-name"><bdi>{name(c)}</bdi></span>
              <span className="menu-rail-count num" aria-label={t('ops.menu.itemsCount', { n: counts.get(c.id) ?? 0 })}>{formatNumber(counts.get(c.id) ?? 0, locale)}</span>
            </button>
            {writable && (
              <Menu label={t('menu.ws.rail.actions', { name: name(c) })} align="end" items={[
                { key: 'rename', label: t('menu.ws.rail.rename'), onSelect: () => onRename(c), disabled: busy },
                { key: 'up', label: t('core.menu.moveUp'), onSelect: () => move(c.id, i - 1), disabled: busy || i === 0 },
                { key: 'down', label: t('core.menu.moveDown'), onSelect: () => move(c.id, i + 1), disabled: busy || i === shown.length - 1 },
                { key: 'archive', label: t('core.menu.archive'), tone: 'danger', onSelect: () => onArchive(c), disabled: busy },
              ]} trigger={(
                <button type="button" className="menu-rail-more" aria-label={t('menu.ws.rail.actions', { name: name(c) })}>
                  <MenuIcon name="more" />
                </button>
              )} />
            )}
          </li>
        ))}
      </ul>
      {writable && <p id="menu-rail-reorder-hint" className="fine menu-rail-hint">{t('menu.ws.rail.hint')}</p>}
      <p className="sr-only" role="status" aria-live="polite">{said}</p>
    </div>
  );
}
