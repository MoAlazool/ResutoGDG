# Loading, refresh and failure states

One behaviour for every screen. Building blocks: `useApi` (`apps/web/lib/use-api.ts`) on the shared query cache
(`apps/web/lib/query-cache.ts`), and the state components in `packages/ui/src/states.tsx`.

| Situation | What the user sees | How |
|---|---|---|
| First load, nothing to show | A skeleton shaped like the final layout (KPI tiles, table rows with the real column count, card grid). No spinners, no progress percentages, no artificial delay. | `loading` → `SkeletonStats` / `SkeletonTable` / `SkeletonCards` / `SkeletonBlock` |
| Revisit or remount | The last result for the same key immediately, refreshed in the background | query cache, stale-while-revalidate |
| Filter, page or sort change | The previous result of the same resource stays until the new one arrives | `useApi` keeps same-resource data (`refreshing`) |
| Background refresh / polling | Data stays; a small "Updating… / Updated 09:30" line | `Freshness` |
| Refresh failed, data available | Data stays; "Could not refresh. Showing data from 09:30." with Retry | `StaleNotice` |
| Nothing loaded and it failed | The failure is named: offline, signed out (401), no access (403), not in plan (402), not found (404), changed elsewhere (409), too many requests (429), validation (message), server/provider (5xx, with the request reference) | `ErrorState`, `failureKind` |
| Empty result | The module's own empty state, never a skeleton | `Loadable` `isEmpty` / `empty` |
| Mutation in flight | Pending state on the control that started it; a second click is ignored | `useAction` (busy guard) |
| Mutation done | Success is shown only after the API confirms; the tenant's queries refresh | `useSession().call` invalidates the tenant prefix |

Rules
- Never declare a payment paid, a delivery completed or an order sent optimistically. Optimistic updates are limited
  to reversible, low-risk actions.
- Background updates must not overwrite a form being edited or reopen a closed drawer.
- A skeleton never hides an error: once a request fails, the failure state replaces it.
- Sign-out and user changes clear the query cache; keys carry the user, tenant, branch, filters and page, so another
  tenant's data cannot flash on screen.
- Polling pauses while the tab is hidden and refreshes once when it becomes visible again.
- Respect `prefers-reduced-motion` (the skeleton shimmer stops).
