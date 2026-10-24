'use client';
import {
  cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState,
  type KeyboardEvent, type ReactElement, type ReactNode, type Ref, type RefObject,
} from 'react';

// Anchored, non-modal surfaces. The panel is positioned with logical properties against a wrapper around the
// trigger, so `align="start"` lines up with the reading start in both directions and nothing is measured.

type TriggerProps = {
  ref?: Ref<HTMLElement>; id?: string; onClick?: (e: unknown) => void; onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  'aria-expanded'?: boolean; 'aria-controls'?: string; 'aria-haspopup'?: 'menu' | 'dialog' | 'listbox' | boolean; 'aria-describedby'?: string;
};
type TriggerElement = ReactElement<TriggerProps>;

/** Closes on Escape (focus back to the trigger) and on a pointer press outside `root`. */
function useDismiss(open: boolean, close: (refocus: boolean) => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(false); };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(true); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close, root]);
}

export type PopoverAlign = 'start' | 'end';
export type PopoverPlacement = 'bottom' | 'top';

/**
 * A button-triggered panel (filters, column pickers, quick forms). `trigger` is one element, usually a button; it
 * gets aria-expanded/aria-controls and toggles the panel. Escape and an outside press close it.
 */
export function Popover({ trigger, children, label, align = 'start', placement = 'bottom', open: controlled, onOpenChange, className }: {
  trigger: TriggerElement; children: ReactNode | ((close: () => void) => ReactNode); label: string;
  align?: PopoverAlign; placement?: PopoverPlacement; open?: boolean; onOpenChange?: (open: boolean) => void; className?: string;
}) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const set = useCallback((v: boolean) => { if (controlled === undefined) setInner(v); onOpenChange?.(v); }, [controlled, onOpenChange]);
  const close = useCallback((refocus: boolean) => { set(false); if (refocus) triggerRef.current?.focus(); }, [set]);
  useDismiss(open, close, root);
  const t = isValidElement(trigger) ? cloneElement(trigger, {
    ref: triggerRef, 'aria-expanded': open, 'aria-controls': `${id}-panel`, 'aria-haspopup': 'dialog',
    onClick: (e: unknown) => { trigger.props.onClick?.(e); set(!open); },
  }) : trigger;
  return (
    <span ref={root} className={['rui-pop', className].filter(Boolean).join(' ')}>
      {t}
      <div id={`${id}-panel`} role="dialog" aria-label={label} className="rui-pop-panel motion-scale-in" data-align={align} data-placement={placement} hidden={!open}>
        {open ? (typeof children === 'function' ? children(() => close(true)) : children) : null}
      </div>
    </span>
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  onSelect?: () => void;
  /** Renders a link instead of a button. */
  href?: string;
  icon?: ReactNode;
  /** Shown at the end (a shortcut hint, a count). */
  hint?: ReactNode;
  tone?: 'danger';
  disabled?: boolean;
  /** Plain text used for type-ahead when `label` is not a string. */
  text?: string;
}

/**
 * Menu button (WAI-ARIA menu pattern). Enter, Space or ArrowDown on the trigger opens it on the first item, ArrowUp on
 * the last; ArrowUp/Down, Home/End and type-ahead move between items (roving focus); Enter/Space activate; Escape
 * closes and returns focus to the trigger; Tab closes.
 */
export function Menu({ trigger, items, label, align = 'start', placement = 'bottom', className }: {
  trigger: TriggerElement; items: MenuItem[]; label: string; align?: PopoverAlign; placement?: PopoverPlacement; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const close = useCallback((refocus: boolean) => { setOpen(false); if (refocus) triggerRef.current?.focus(); }, []);
  useDismiss(open, close, root);
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active]);

  const openAt = (where: 'first' | 'last') => {
    setActive(where === 'first' ? enabled[0] ?? 0 : enabled[enabled.length - 1] ?? 0);
    setOpen(true);
  };
  const move = (delta: number) => {
    const pos = enabled.indexOf(active);
    setActive(enabled[(pos + delta + enabled.length) % enabled.length] ?? active);
  };
  const activate = (it: MenuItem) => {
    if (it.disabled) return;
    close(true);
    it.onSelect?.();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(enabled[0] ?? 0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(enabled[enabled.length - 1] ?? 0); }
    else if (e.key === 'Tab') close(false);
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLocaleLowerCase();
      const pos = enabled.indexOf(active);
      const order = [...enabled.slice(pos + 1), ...enabled.slice(0, pos + 1)];
      const hit = order.find((i) => {
        const it = items[i]!;
        const text = it.text ?? (typeof it.label === 'string' ? it.label : '');
        return text.trim().toLocaleLowerCase().startsWith(ch);
      });
      if (hit !== undefined) setActive(hit);
    }
  };
  const t = isValidElement(trigger) ? cloneElement(trigger, {
    ref: triggerRef, id: `${id}-button`, 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': `${id}-menu`,
    onClick: (e: unknown) => { trigger.props.onClick?.(e); if (open) close(false); else openAt('first'); },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      trigger.props.onKeyDown?.(e);
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAt('first'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); openAt('last'); }
    },
  }) : trigger;
  return (
    <span ref={root} className={['rui-pop', className].filter(Boolean).join(' ')}>
      {t}
      <div ref={list} id={`${id}-menu`} role="menu" aria-label={label} aria-labelledby={`${id}-button`} className="rui-pop-panel rui-menu motion-scale-in"
        data-align={align} data-placement={placement} hidden={!open} onKeyDown={onMenuKey}>
        {open && items.map((it, i) => {
          const common = {
            role: 'menuitem', tabIndex: i === active ? 0 : -1, 'data-index': i, 'data-tone': it.tone, className: 'rui-menu-item',
            'aria-disabled': it.disabled || undefined, onMouseEnter: () => { if (!it.disabled) setActive(i); },
          } as const;
          const body = <>{it.icon && <span className="rui-menu-icon" aria-hidden="true">{it.icon}</span>}<span className="rui-menu-label">{it.label}</span>{it.hint && <span className="rui-menu-hint">{it.hint}</span>}</>;
          return it.href && !it.disabled
            ? <a key={it.key} href={it.href} {...common} onClick={() => close(false)}
              onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); (e.currentTarget as HTMLAnchorElement).click(); } }}>{body}</a>
            : <button key={it.key} type="button" {...common} onClick={() => activate(it)}>{body}</button>;
        })}
      </div>
    </span>
  );
}

/**
 * Tooltip: a short description of its single child (an icon button, a truncated value). Shown on hover after a short
 * delay and immediately on keyboard focus; Escape hides it. The child gets aria-describedby, so the text is announced
 * as a description; an icon-only button still needs its own aria-label.
 */
export function Tooltip({ content, children, placement = 'top', delayMs = 400 }: {
  content: ReactNode; children: TriggerElement; placement?: PopoverPlacement; delayMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const child = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], `${id}-tip`].filter(Boolean).join(' ') })
    : children;
  return (
    <span className="rui-tip-wrap"
      onPointerEnter={() => { clear(); timer.current = setTimeout(() => setOpen(true), delayMs); }}
      onPointerLeave={() => { clear(); setOpen(false); }}
      onFocus={() => { clear(); setOpen(true); }}
      onBlur={() => { clear(); setOpen(false); }}>
      {child}
      <span id={`${id}-tip`} role="tooltip" className="rui-tip motion-fade-in" data-placement={placement} hidden={!open}>{content}</span>
    </span>
  );
}
