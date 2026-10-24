'use client';
import { cloneElement, isValidElement, useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import type { Menu } from '@resuto/ui';

type MenuProps = ComponentProps<typeof Menu>;
type MenuComponent = ComponentType<MenuProps>;

// @resuto/ui's Menu (popover.tsx), loaded right after the shell mounts instead of with every staff route's first-load
// JavaScript (21-SHELL bundle budget). The deep import keeps the chunk to the popover module.
let loaded: MenuComponent | null = null;
let loading: Promise<MenuComponent> | null = null;
const loadMenu = () => (loading ??= import('@resuto/ui/src/popover').then((m) => (loaded = m.Menu as MenuComponent)));

/**
 * `Menu` with the same props. Until the menu code has arrived (usually before anyone can click), the trigger renders
 * as-is; a click or Enter on it then opens the menu as soon as it loads, so nothing is lost.
 */
export function LazyMenu(props: MenuProps) {
  const [Real, setReal] = useState<MenuComponent | null>(() => loaded);
  const wanted = useRef(false);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (Real) return;
    let live = true;
    void loadMenu().then((M) => { if (live) setReal(() => M); });
    return () => { live = false; };
  }, [Real]);
  useEffect(() => {
    if (Real && wanted.current) { wanted.current = false; wrap.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.click(); }
  }, [Real]);
  if (Real) return <span ref={wrap} className="ws-menu-slot"><Real {...props} /></span>;
  const trigger = isValidElement(props.trigger)
    ? cloneElement(props.trigger, { 'aria-haspopup': 'menu', 'aria-expanded': false, onClick: () => { wanted.current = true; } })
    : props.trigger;
  return <span ref={wrap} className="ws-menu-slot"><span className={['rui-pop', props.className].filter(Boolean).join(' ')}>{trigger}</span></span>;
}
