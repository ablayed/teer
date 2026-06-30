'use client';

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import { Textarea } from '@/components/ui/textarea';
import {
  type WhatsappOrderData,
  buildWhatsappShareUrl,
  formatMoneyForWhatsApp,
  formatProduits,
  safeText,
} from '@/lib/whatsapp/format';
import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';

type Template = 'clientConfirmation' | 'livreur';

type Props = {
  order: WhatsappOrderData;
  template: Template;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function buildMessage(
  t: ReturnType<typeof useTranslations<'whatsapp'>>,
  template: Template,
  order: WhatsappOrderData,
): string {
  const vars = {
    numeroCommande: safeText(order.numeroCommande),
    telephone: safeText(order.telephone),
    produits: formatProduits(order.items),
    adresse: safeText(order.adresse),
    total: formatMoneyForWhatsApp(order.total),
  };
  // Literal-key ternary required — next-intl TS enforces literal string arguments to t().
  return template === 'livreur' ? t('livreur', vars) : t('clientConfirmation', vars);
}

export function WhatsappComposeSheet({ order, template, trigger, open, onOpenChange }: Props) {
  const t = useTranslations('whatsapp');
  const [internalOpen, setInternalOpen] = useState(false);
  const [message, setMessage] = useState('');

  const isControlled = open !== undefined;
  const isOpen = open ?? internalOpen;

  function handleOpenChange(next: boolean) {
    if (next) {
      setMessage(buildMessage(t, template, order));
    }
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }

  const shareUrl = buildWhatsappShareUrl(message);

  return (
    <Drawer open={isOpen} onOpenChange={handleOpenChange}>
      {trigger ? <DrawerTrigger asChild>{trigger}</DrawerTrigger> : null}
      <DrawerContent className="max-h-[90dvh]">
        <DrawerHeader>
          <DrawerTitle>{t('composeTitle')}</DrawerTitle>
          <p className="text-sm text-muted-foreground">{t('composeHint')}</p>
        </DrawerHeader>

        <div className="flex-1 overflow-y-auto px-4 pb-2">
          <Textarea
            className="min-h-[200px] font-mono text-sm"
            onChange={(e) => setMessage(e.target.value)}
            value={message}
          />
        </div>

        <DrawerFooter className="flex-row gap-2">
          <a
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1ebe5d]"
            href={shareUrl}
            onClick={() => handleOpenChange(false)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <MessageCircle aria-hidden="true" className="size-4" />
            {t('openWhatsapp')}
          </a>
          <DrawerClose asChild>
            <button
              className="rounded-lg border border-border px-4 py-3 text-sm font-medium text-text hover:bg-canvas"
              type="button"
            >
              Annuler
            </button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
