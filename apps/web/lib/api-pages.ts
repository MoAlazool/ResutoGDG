import type { ApiOptions } from './api';

/** Pages fetched at most per full list (200 rows each); past the cap the last nextCursor is kept for the caller. */
export const FULL_LIST_MAX_PAGES = 25;

/**
 * Follows `nextCursor` of a list the API marked `X-Resuto-List: full` and returns every row, as the endpoint did
 * before it was paginated (PS-22). Only reached when the caller passed neither `cursor` nor `limit` (apiPage), so
 * appending the cursor is safe. A repeated cursor or a non-list page stops the walk.
 *
 * A later page that fails (network, a 5xx, a rejected cursor) does not throw away the rows already fetched: the walk
 * stops there and returns them with `nextCursor` still set, so the screen shows what it has and the list reads as
 * incomplete instead of the whole screen failing. A failed first page still throws (the caller's error state), and so
 * does an aborted request or an expired session (401), which the session layer handles.
 */
export async function followPages(first: any, path: string, opts: ApiOptions,
  fetchPage: (path: string, opts: ApiOptions) => Promise<[any, boolean]>): Promise<any> {
  let data = first;
  for (let page = 1; Array.isArray(data?.items) && typeof data.nextCursor === 'string' && page < FULL_LIST_MAX_PAGES; page++) {
    let next: any;
    try {
      [next] = await fetchPage(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.nextCursor)}`, opts);
    } catch (error: any) {
      if (error?.name === 'AbortError' || error?.status === 401) throw error;
      break;
    }
    if (!Array.isArray(next?.items)) break;
    data = { ...data, items: [...data.items, ...next.items], nextCursor: next.nextCursor !== data.nextCursor ? next.nextCursor : null };
  }
  return data;
}
