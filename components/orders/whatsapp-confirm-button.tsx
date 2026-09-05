'use client';

import { cn } from '@/lib/utils';
import { ExternalLink } from 'lucide-react';

type WhatsAppConfirmButtonProps = {
  disabledLabel: string;
  label: string;
  url: string | null;
};

export function WhatsAppConfirmButton({ disabledLabel, label, url }: WhatsAppConfirmButtonProps) {
  function openWhatsApp() {
    if (!url) {
      return;
    }

    window.open(url, '_blank', 'noopener');
  }

  return (
    <button
      className={cn(
        'inline-flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold',
        url
          ? 'bg-[#128C7E] text-white hover:brightness-95'
          : 'cursor-not-allowed border border-border bg-canvas text-muted',
      )}
      disabled={!url}
      onClick={openWhatsApp}
      title={url ? label : disabledLabel}
      type="button"
    >
      <ExternalLink aria-hidden="true" className="size-4" />
      {label}
    </button>
  );
}
