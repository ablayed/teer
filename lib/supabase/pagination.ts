export const POSTGREST_PAGE_SIZE = 500;

type PostgrestError = { message: string };

export async function fetchAllPostgrestRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => Promise<{ data: T[] | null; error: PostgrestError | null }>,
): Promise<{ data: T[]; error: null } | { data: null; error: PostgrestError }> {
  const rows: T[] = [];

  for (let from = 0; ; from += POSTGREST_PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + POSTGREST_PAGE_SIZE - 1);
    if (error) return { data: null, error };

    const page = data ?? [];
    rows.push(...page);
    if (page.length < POSTGREST_PAGE_SIZE) return { data: rows, error: null };
  }
}
