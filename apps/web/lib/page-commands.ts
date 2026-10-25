// Page commands (21-INBOX): actions and single-key shortcuts a page offers while it is open (the Inbox's j/k/r/n/a/e).
// The page registers them here; the shell's ⌘K palette lists them as actions and the `?` cheat sheet lists their keys.
// Both live in the palette chunk, which loads on first use, so this registry adds nothing to the shell's first load:
// only pages that register commands, and the palette chunk, import it. The page handles its own keys
// (lib/inbox-keys.ts) so a pending `g` of the shell's go-to shortcuts is never mistaken for a page key.
import { useEffect, useRef, useSyncExternalStore } from 'react';

export interface PageCommand {
  id: string;
  /** Visible text (already translated). */
  label: string;
  /** Single key that runs it on the page (shown in the cheat sheet), e.g. "j". */
  key?: string;
  /** English search words for the palette. */
  keywords?: string;
  /** Hidden from the palette (still listed in the cheat sheet) when false: e.g. "Assign" without a conversation. */
  enabled?: boolean;
  run(): void;
}

export interface PageCommandGroup { title: string; commands: PageCommand[] }

let current: PageCommandGroup | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Registers the page's commands (replacing another page's); returns the function that removes them. */
export function setPageCommands(group: PageCommandGroup): () => void {
  current = group;
  emit();
  return () => { if (current === group) { current = null; emit(); } };
}

/** The commands of the page that is open, or null. */
export const pageCommands = (): PageCommandGroup | null => current;

export function subscribePageCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The open page's commands, re-rendering when a page registers or removes them (palette and cheat sheet). */
export function usePageCommandsSnapshot(): PageCommandGroup | null {
  return useSyncExternalStore(subscribePageCommands, pageCommands, () => null);
}

/**
 * Registers a page's commands for as long as it is mounted. `group` may be a new object on every render: the registry
 * keeps the latest one (labels and enabled state follow the page) without re-subscribing.
 */
export function usePageCommands(group: PageCommandGroup) {
  const latest = useRef(group);
  latest.current = group;
  const signature = `${group.title}|${group.commands.map((c) => `${c.id}:${c.label}:${c.key ?? ''}:${c.enabled !== false}`).join(',')}`;
  useEffect(() => {
    const live: PageCommandGroup = {
      get title() { return latest.current.title; },
      get commands() { return latest.current.commands.map((c) => ({ ...c, run: () => latest.current.commands.find((x) => x.id === c.id)?.run() })); },
    };
    return setPageCommands(live);
  }, [signature]);
}
