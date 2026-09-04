'use client';

import { Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

export function ProductSearchBar({
  initialQuery,
  storeId,
  tab,
}: {
  initialQuery: string;
  storeId: string;
  tab?: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setValue(initialQuery);
  }, [initialQuery]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const params = new URLSearchParams();
      if (tab) params.set('tab', tab);
      if (v.trim()) params.set('q', v.trim());
      router.push(`/s/${storeId}/produits${params.size > 0 ? `?${params.toString()}` : ''}`);
    }, 300);
  }

  return (
    <label className="relative block w-full max-w-md">
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted"
      />
      <input
        className="min-h-12 w-full rounded-lg border border-border bg-canvas pl-10 pr-3 text-sm text-text shadow-1"
        onChange={handleChange}
        placeholder="Rechercher par titre ou SKU…"
        type="search"
        value={value}
      />
    </label>
  );
}
