import type { ReactNode } from 'react';
import { LocaleScope } from './locale-scope';
import { layerMessages, routeMessages, type MessageScope } from './messages';
import type { RouteScope } from './route-families';
import { getLocale } from './server';

// Server components that add a route group's messages on top of the root layout's base scope (lib/i18n/messages.ts).

/** Guest route groups (scope "guest") and the landing and pricing pages (scope "public"). */
export async function ScopeMessages({ scope, children }: { scope: Extract<MessageScope, 'guest' | 'public'>; children: ReactNode }) {
  const locale = await getLocale();
  return <LocaleScope messages={layerMessages(locale, scope)}>{children}</LocaleScope>;
}

/**
 * A staff module's messages (lib/i18n/route-families.ts), inside the dashboard shell's: each module directory's layout
 * (app/dashboard/[orgId]/<module>/layout.tsx) and the overview page wrap their screens in it.
 */
export async function RouteMessages({ route, children }: { route: RouteScope; children: ReactNode }) {
  const locale = await getLocale();
  return <LocaleScope messages={routeMessages(locale, route)}>{children}</LocaleScope>;
}
