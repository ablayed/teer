'use client';

import { cn } from '@/lib/utils';
import { FileDown, Loader2 } from 'lucide-react';
import { useState } from 'react';

type ReportDownloadButtonProps = {
  errorLabel: string;
  from: string;
  label: string;
  loadingLabel: string;
  shopId?: string | null;
  to: string;
};

export function ReportDownloadButton({
  errorLabel,
  from,
  label,
  loadingLabel,
  shopId = null,
  to,
}: ReportDownloadButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const href = `/api/rapport?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${
    shopId ? `&shopId=${encodeURIComponent(shopId)}` : ''
  }`;

  function startDownload() {
    setIsLoading(true);
    setHasError(false);

    window.setTimeout(() => {
      setIsLoading(false);
    }, 2500);
  }

  return (
    <div className="space-y-2">
      <a
        className={cn(
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover',
          isLoading && 'pointer-events-none opacity-80',
        )}
        href={href}
        onClick={startDownload}
        onError={() => {
          setIsLoading(false);
          setHasError(true);
        }}
      >
        {isLoading ? (
          <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
        ) : (
          <FileDown aria-hidden="true" className="size-4" />
        )}
        {isLoading ? loadingLabel : label}
      </a>
      {hasError ? <p className="text-sm font-medium text-danger">{errorLabel}</p> : null}
    </div>
  );
}
