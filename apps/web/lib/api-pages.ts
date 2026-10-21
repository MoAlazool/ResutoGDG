import type { ApiOptions } from './api';

/** Pages fetched at most per full list (200 rows each); past the cap the last nextCursor is kept for the caller. */
export const FULL_LIST_MAX_PAGES = 25;

/**
 * Follows `nextCursor` of a list the API marked `X-Resuto-List: full` and returns every row, as the endpoint did
 * before it was paginated (PS-22). Only reached when the caller passed neither `cursor` nor `limit` (apiPage), so
 * appending the cursor is safe. A repeated cursor or a non-list page stops the walk.
 */
export async function followPages(first: any, path: string, opts: ApiOptions,
  fetchPage: (path: string, opts: ApiOptions) => Promise<[any, boolean]>): Promise<any> {
  let data = first;
  for (let page = 1; Array.isArray(data?.items) && typeof data.nextCursor === 'string' && page < FULL_LIST_MAX_PAGES; page++) {
    const [next] = await fetchPage(`${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(data.nextCursor)}`, opts);
    if (!Array.isArray(next?.items)) break;
    data = { ...data, items: [...data.items, ...next.items], nextCursor: next.nextCursor !== data.nextCursor ? next.nextCursor : null };
  }
  return data;
}
