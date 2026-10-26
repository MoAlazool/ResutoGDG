'use client';
import { useContext, useMemo, type ReactNode } from 'react';
import { LocaleContext } from './context';
import type { Messages } from './locale';

/** Adds a route group's messages (e.g. the staff namespaces) on top of the root layout's shared ones. */
export function LocaleScope({ messages, children }: { messages: Messages; children: ReactNode }) {
  const parent = useContext(LocaleContext);
  const value = useMemo(() => ({ locale: parent.locale, messages: { ...parent.messages, ...messages } }), [parent, messages]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}
