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
import { recordWhatsappShareAction } from '@/lib/actions/pcd-access';
import {
  type WhatsappOrderData,
  buildWhatsappDirectUrl,
  buildWhatsappShareUrl,
  formatMoneyForWhatsApp,
  formatProduits,
  safeText,
} from '@/lib/whatsapp/format';
import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { type ReactNode, useEffect, useRef, useState } from 'react';

type Template = 'clientConfirmation' | 'livreur';

type Props = {
  order: WhatsappOrderData;
  // Lot 3 (Sujet B) : null pour une commande hors périmètre (livrée/annulée/retournée)
  // — textarea vide, aucun appel à buildMessage.
  template: Template | null;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

function buildMessage(
  t: ReturnType<typeof useTranslations<'whatsapp'>>,
  template: Template | null,
  order: WhatsappOrderData,
): string {
  if (!template) {
    return '';
  }
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
  const [shareError, setShareError] = useState(false);
  const recordShare = useAction(recordWhatsappShareAction);
  // Lot 3 (Sujet C) : suit la dernière valeur connue de isOpen pour détecter une
  // VRAIE transition fermé→ouvert, y compris quand le composant est monté avec
  // open=true dès son premier rendu (mode compact/liste — voir order-actions-menu.tsx).
  // Un composant contrôlé de type Vaul/Radix n'invoque onOpenChange qu'en réaction à
  // une action interne (trigger/close), jamais simplement parce que le parent lui
  // passe open=true au montage — buildMessage() ne peut donc pas dépendre de
  // handleOpenChange seul, sous peine de laisser le textarea vide en mode compact.
  const wasOpenRef = useRef(false);

  const isControlled = open !== undefined;
  const isOpen = open ?? internalOpen;

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setMessage(buildMessage(t, template, order));
      setShareError(false);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, template, order, t]);

  function handleOpenChange(next: boolean) {
    if (!isControlled) {
      setInternalOpen(next);
    }
    onOpenChange?.(next);
  }

  // Sujet 1.3 : le template client cible directement la conversation du client
  // (`wa.me/<numéro>`). Le template livreur n'a pas de destinataire connu ici —
  // `order.telephone` est celui du CLIENT, recopié dans le corps du message pour
  // le livreur : il ne doit jamais devenir le destinataire.
  const shareUrl =
    template === 'livreur'
      ? buildWhatsappShareUrl(message)
      : buildWhatsappDirectUrl(order.telephone, message);

  async function handleShare() {
    if (recordShare.status === 'executing') return;

    // Ouvrir une fenêtre neutre dans le geste utilisateur évite qu'un
    // navigateur bloque la navigation après l'aller-retour de l'audit.
    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer');
    if (!popup) {
      setShareError(true);
      return;
    }

    const result = await recordShare.executeAsync({ orderId: order.numeroCommande ?? '' });
    if (!result?.data?.ok) {
      popup.close();
      setShareError(true);
      return;
    }

    popup.location.replace(shareUrl);
    handleOpenChange(false);
  }

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

        {shareError ? (
          <p className="px-4 text-sm text-danger" role="alert">
            Le partage est indisponible. Aucun message n'a été ouvert.
          </p>
        ) : null}

        <DrawerFooter className="flex-row gap-2">
          <button
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-3 text-sm font-semibold text-white hover:bg-[#1ebe5d] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={recordShare.status === 'executing'}
            onClick={() => void handleShare()}
            type="button"
          >
            <MessageCircle aria-hidden="true" className="size-4" />
            {t('openWhatsapp')}
          </button>
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
