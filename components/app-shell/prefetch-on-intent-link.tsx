'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ComponentProps, type FocusEvent, type PointerEvent, useCallback } from 'react';

// Lien de navigation du shell, sans préchargement automatique (V7). `<Link prefetch>` rendait, dès le
// chargement de /commandes, un rendu serveur COMPLET de chaque page de la barre de navigation (et le
// téléchargement du JS de chacune : graphiques, animations…), avant que l'utilisateur ait touché quoi
// que ce soit. Le préchargement ne part plus que sur une intention : focus clavier, survol, appui.
// Pas de nouvelle rafale après `load` : aucune minuterie ici.
type Props = Omit<ComponentProps<typeof Link>, 'prefetch'>;

export function PrefetchOnIntentLink({
  href,
  onFocus,
  onPointerDown,
  onPointerEnter,
  ...rest
}: Props) {
  const router = useRouter();
  const prefetch = useCallback(() => {
    router.prefetch(typeof href === 'string' ? href : (href.pathname ?? ''));
  }, [router, href]);

  return (
    <Link
      {...rest}
      href={href}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        onFocus?.(event);
        prefetch();
      }}
      onPointerDown={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerDown?.(event);
        prefetch();
      }}
      onPointerEnter={(event: PointerEvent<HTMLAnchorElement>) => {
        onPointerEnter?.(event);
        prefetch();
      }}
      prefetch={false}
    />
  );
}
