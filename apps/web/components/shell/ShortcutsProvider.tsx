'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { createShortcutReader, type ShortcutCommand } from '@/lib/shortcuts';

/**
 * Global keyboard shortcuts of the staff shell (21-SHELL): ⌘K / Ctrl K → command palette, ? → cheat sheet,
 * g + letter → a page. Keys typed into fields are left alone (lib/shortcuts.ts isTypingTarget).
 */
export function ShortcutsProvider({ onCommand, children }: { onCommand(cmd: ShortcutCommand): boolean | void; children?: ReactNode }) {
  const handler = useRef(onCommand);
  handler.current = onCommand;
  useEffect(() => {
    const read = createShortcutReader();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const cmd = read(e);
      if (cmd && handler.current(cmd) !== false) e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return <>{children}</>;
}
