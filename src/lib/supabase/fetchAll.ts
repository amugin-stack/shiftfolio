// Paged reads for PostgREST queries that can legitimately exceed the row cap.
//
// WHY THIS EXISTS: PostgREST caps every response at `max-rows` (1000 on
// Supabase by default) and truncates SILENTLY — no error, no flag, `data`
// just stops early. A query that outgrows the cap therefore starts serving a
// partial answer that looks complete.
//
// That is exactly what broke the brand calendar: it fetched a brand's entire
// stream history unbounded, so once a brand crossed 1000 shifts every date
// past the cutoff rendered as an EMPTY grid — while the slots were still very
// much occupied. Booking into one then failed with a raw
// "duplicate key ... streams_unique_slot" error, because the UNIQUE index and
// the modal's own date-bounded occupancy check both see rows the calendar
// never drew. Symptom: "the calendar is empty but it says a shift exists."
//
// Prefer a date-bounded query where the surface allows one (master-schedule
// does this). Use this helper when the caller genuinely needs every matching
// row, e.g. a client-navigable calendar that pages through data in the browser.
//
// ---------------------------------------------------------------------------
// THIS APPLIES TO .rpc() TOO — that is where it bit us the second time
// ---------------------------------------------------------------------------
//
// max_rows caps stored procedures exactly as it caps tables (supabase/
// config.toml says so in as many words). After the calendar was fixed, the pay
// accessor RPCs from migration 055 were left unpaged, and `admin_stream_pay()`
// — which returns one row per stream, ever — quietly started serving 1000 of N
// to seven admin money screens. Because a missing entry in the resulting Map is
// indistinguishable from a NULL frozen rate, and NULL means "use the host's
// CURRENT rate", historical shifts were being re-priced. See migration 064.
//
// A `supabase.rpc(...)` builder satisfies RangeableQuery, so it pages here just
// like a `.from(...)` query:
//
//     await fetchAllRows<Row>(() => supabase.rpc('admin_stream_pay') as never)
//
// >>> PREREQUISITE: the function MUST have a deterministic ORDER BY. <<<
// Range-based paging over an unordered result can repeat rows across pages or
// skip them entirely — which would convert a truncation bug (underpaying) into
// a duplication bug (overpaying). Migration 064 adds `ORDER BY id` to all five
// pay accessors for precisely this reason. Do not page an unordered function.

/** Supabase/PostgREST default `max-rows`. Page size is capped to this. */
export const POSTGREST_PAGE_SIZE = 1000

/** Runaway guard — far above any real brand's shift count. */
export const DEFAULT_MAX_ROWS = 50_000

/** Minimal shape we need from a PostgREST builder: `.range()` returning rows. */
export interface RangeableQuery<T> {
  range(
    from: number,
    to: number,
  ): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

export interface FetchAllOptions {
  pageSize?: number
  maxRows?: number
  /** Called if maxRows is hit (i.e. the result IS truncated). Defaults to console.warn. */
  onTruncated?: (rowsFetched: number) => void
}

/**
 * Fetch every row a query matches, paging with `.range()` until a short page
 * proves the end was reached.
 *
 * Takes a FACTORY, not a query: PostgREST builders are single-use thenables,
 * so each page must be built fresh. Pass `() => supabase.from(...)...`.
 *
 * Throws on the first page error rather than returning a silently-short list —
 * a partial calendar is worse than a visible failure.
 */
export async function fetchAllRows<T>(
  buildQuery: () => RangeableQuery<T>,
  options: FetchAllOptions = {},
): Promise<T[]> {
  if ((options.pageSize !== undefined && (!Number.isInteger(options.pageSize) || options.pageSize < 1))
    || (options.maxRows !== undefined && (!Number.isInteger(options.maxRows) || options.maxRows < 1))) {
    throw new Error('Page size and row limit must be finite positive integers')
  }
  const pageSize = Math.max(1, Math.min(options.pageSize ?? POSTGREST_PAGE_SIZE, POSTGREST_PAGE_SIZE))
  const maxRows = Math.max(pageSize, options.maxRows ?? DEFAULT_MAX_ROWS)

  const rows: T[] = []
  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await buildQuery().range(from, Math.min(from + pageSize, maxRows) - 1)
    if (error) throw new Error(error.message)
    const page = data ?? []
    for (const row of page) rows.push(row)
    // A short page means we've read past the last row — done.
    if (page.length < Math.min(pageSize, maxRows - from)) return rows
  }

  // Probe one row beyond the limit: exactly maxRows is still complete.
  const probe = await buildQuery().range(maxRows, maxRows)
  if (probe.error) throw new Error(probe.error.message)
  if (!probe.data?.length) return rows

  // Hit the guard: the answer IS incomplete. Say so loudly rather than
  // reproducing the silent-truncation bug this helper exists to prevent.
  const notify =
    options.onTruncated ??
    ((n: number) =>
      console.warn(`[fetchAllRows] hit maxRows guard (${n} rows) — result is truncated`))
  notify(rows.length)
  throw new Error(`Incomplete data: more than ${maxRows} rows. Narrow the date range and try again.`)
}
