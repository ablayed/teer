import { POSTGREST_PAGE_SIZE, fetchAllPostgrestRows } from '@/lib/supabase/pagination';
import { describe, expect, it, vi } from 'vitest';

describe('fetchAllPostgrestRows', () => {
  it('récupère toutes les lignes au-delà de la limite PostgREST de 1000', async () => {
    const source = Array.from({ length: 1_205 }, (_, id) => ({ id }));
    const fetchPage = vi.fn(async (from: number, to: number) => ({
      data: source.slice(from, to + 1),
      error: null,
    }));

    const result = await fetchAllPostgrestRows(fetchPage);

    expect(result).toEqual({ data: source, error: null });
    expect(fetchPage.mock.calls).toEqual([
      [0, POSTGREST_PAGE_SIZE - 1],
      [POSTGREST_PAGE_SIZE, POSTGREST_PAGE_SIZE * 2 - 1],
      [POSTGREST_PAGE_SIZE * 2, POSTGREST_PAGE_SIZE * 3 - 1],
    ]);
  });

  it('arrête la pagination et propage une erreur de page', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: Array.from({ length: POSTGREST_PAGE_SIZE }, () => 1),
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: { message: 'lecture impossible' } });

    await expect(fetchAllPostgrestRows(fetchPage)).resolves.toEqual({
      data: null,
      error: { message: 'lecture impossible' },
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});
