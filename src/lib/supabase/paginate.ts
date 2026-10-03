/** PostgREST returns at most 1,000 rows per request by default, silently. */
export const PAGE_SIZE = 1000;

/**
 * Reads every row of a query by asking for consecutive ranges until a short page comes back.
 * `fetchPage` receives inclusive `from`/`to` row indexes (what Supabase's `.range()` expects).
 * The query must have a stable order, or rows can be skipped or repeated between pages.
 */
export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => Promise<T[]>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}
