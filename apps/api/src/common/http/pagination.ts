import type { Page } from '@resuto/contracts';
import { DomainError } from '../errors/domain-error';

/**
 * Keyset pagination shared by every list endpoint (audit PS-22, docs/API_STYLE.md).
 *
 * A cursor is opaque to clients: base64url of {"at": <sort key>, "id": <row id>} of the last row of the previous page.
 * Lists sort by a key and break ties on the row id, so a page boundary is exact even when many rows share the key:
 *
 *   const k = keyset(query.cursor);                      // null on the first page
 *   const rows = await tx.query(`select ..., ${cursorAt('created_at')} as cursor_at from t
 *                                where org_id = $1 ${k.after('created_at', 'id', 2)}
 *                                order by created_at desc, id desc limit ${k.fetch(limit)}`, [orgId, ...k.params]);
 *   return pageOf(rows, limit, (r) => ({ at: r.cursor_at, id: r.id }), view);
 *
 * `after()` compares the (key, id) row value against the cursor, so it is one index range scan on (key, id) and stays
 * stable while rows are inserted at the head. A malformed or tampered cursor is a 400 invalid_cursor, never a 500.
 */
export interface CursorKey { at: string | number; id: string }

const MAX_CURSOR_LENGTH = 500;

export function encodeCursor(key: CursorKey): string {
  return Buffer.from(JSON.stringify({ at: key.at, id: key.id }), 'utf8').toString('base64url');
}

export const invalidCursor = () => new DomainError('invalid_cursor', 'The cursor is not valid for this list', 400);

export function decodeCursor(cursor: string): CursorKey {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const p = parsed as Partial<CursorKey> | null;
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || p.id.length === 0 || p.id.length > 100
    || !(typeof p.at === 'string' || (typeof p.at === 'number' && Number.isFinite(p.at)))) throw invalidCursor();
  if (typeof p.at === 'string' && p.at.length > 100) throw invalidCursor();
  return { at: p.at, id: p.id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface KeysetOptions {
  /** How the sort key is compared in SQL. Default timestamptz. */
  atType?: 'timestamptz' | 'text' | 'bigint' | 'numeric' | 'int';
  /** How the id is compared in SQL. Default uuid (validated before it reaches the database). */
  idType?: 'uuid' | 'text' | 'bigint';
  /** Sort direction of both columns. Default desc (newest first). */
  direction?: 'asc' | 'desc';
}

export interface Keyset {
  readonly key: CursorKey | null;
  /** Bind parameters for after(): [] on the first page, [at, id] after a cursor. */
  readonly params: unknown[];
  /**
   * "and (keyCol, idCol) < ($n, $n+1)" (">" when ascending) or "" on the first page. `firstParam` is the 1-based index
   * of the first of the two bind parameters in the caller's parameter list.
   */
  after(keyCol: string, idCol: string, firstParam: number): string;
  /** Rows to fetch for a page of `limit`: one extra tells whether another page exists. */
  fetch(limit: number): number;
}

export function keyset(cursor: string | null | undefined, opts: KeysetOptions = {}): Keyset {
  const atType = opts.atType ?? 'timestamptz';
  const idType = opts.idType ?? 'uuid';
  const op = (opts.direction ?? 'desc') === 'desc' ? '<' : '>';
  const key = cursor ? decodeCursor(cursor) : null;
  if (key) {
    if (idType === 'uuid' && !UUID.test(key.id)) throw invalidCursor();
    if (idType === 'bigint' && !/^\d{1,19}$/.test(key.id)) throw invalidCursor();
    if (atType === 'timestamptz' && (typeof key.at !== 'string' || Number.isNaN(Date.parse(key.at)))) throw invalidCursor();
    if ((atType === 'bigint' || atType === 'int') && !(typeof key.at === 'number' && Number.isInteger(key.at))) throw invalidCursor();
    if (atType === 'numeric' && typeof key.at !== 'number') throw invalidCursor();
    if (atType === 'text' && typeof key.at !== 'string') throw invalidCursor();
  }
  return {
    key,
    params: key ? [key.at, key.id] : [],
    after: (keyCol, idCol, n) => (key ? `and (${keyCol}, ${idCol}) ${op} ($${n}::${atType}, $${n + 1}::${idType})` : ''),
    fetch: (limit) => limit + 1,
  };
}

/**
 * SQL for a timestamptz sort key at full (microsecond) precision. A JavaScript Date keeps milliseconds only, so a
 * cursor built from one would skip rows that differ in the sub-millisecond digits: select this as the cursor key.
 */
export const cursorAt = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Keyset over a monotonically increasing bigint id alone (append-only logs: audit, integration logs), newest first.
 * Accepts the opaque cursor and, for older clients, the bare numeric id these lists used to return.
 */
export function idKeyset(cursor: string | null | undefined) {
  let id: string | null = null;
  if (cursor && /^\d{1,19}$/.test(cursor)) id = cursor;
  else if (cursor) {
    const k = decodeCursor(cursor);
    if (!/^\d{1,19}$/.test(k.id)) throw invalidCursor();
    id = k.id;
  }
  return {
    params: id ? [id] : [] as unknown[],
    after: (idCol: string, n: number) => (id ? `and ${idCol} < $${n}::bigint` : ''),
    fetch: (limit: number) => limit + 1,
  };
}

/**
 * Branch scope as a SQL predicate (for lists, so the filter runs before LIMIT): `$n` is bound to ctx.branchFilter
 * (null = every branch). Rows without a branch (org-wide) stay visible, as with TenantContext.canAccessBranch.
 */
export const branchScope = (col: string, n: number) => `($${n}::uuid[] is null or ${col} is null or ${col} = any($${n}::uuid[]))`;

/** Turns limit+1 fetched rows into a page: the extra row only signals that a next page exists. */
export function pageOf<R, T>(rows: R[], limit: number, keyOf: (row: R) => { at: string | number; id: string | number },
  view: (row: R, index: number) => T): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  let nextCursor: string | null = null;
  if (rows.length > limit && last) {
    const k = keyOf(last);
    nextCursor = encodeCursor({ at: k.at, id: String(k.id) });
  }
  return { items: items.map(view), nextCursor };
}
