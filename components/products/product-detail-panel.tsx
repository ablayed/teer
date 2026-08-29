'use client';

import {
  type ProductAdSpendCandidateLot,
  ProductAdSpendForm,
} from '@/components/purchases/product-ad-spend-form';
import { DetailPanel } from '@/components/ui/detail-panel';
import {
  type ProductsPageItem,
  getBundleCompositionAction,
  saveBundleConfigurationAction,
} from '@/lib/actions/products';
import { getProductAdSpendCandidateLotsAction } from '@/lib/actions/purchases';
import { Plus, Search, Trash2 } from 'lucide-react';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type ComponentLine = {
  id: string;
  componentProductId: string;
  search: string;
  quantity: string;
};

const ERROR_MESSAGES: Record<string, string> = {
  bundle_not_found: 'Ce produit est introuvable dans la boutique active. Rechargez la page.',
  component_is_bundle: 'Ce produit est déjà un bundle, il ne peut pas être ajouté comme composant.',
  component_not_found: 'Un composant sélectionné est introuvable dans la boutique active.',
  duplicate_component: 'Chaque composant ne peut apparaître qu’une seule fois dans la liste.',
  product_used_as_component:
    "Ce produit est déjà utilisé comme composant d'un autre bundle, il ne peut pas devenir lui-même un bundle. Retirez-le d'abord de l'autre composition.",
  self_reference: 'Un produit ne peut pas être son propre composant.',
  store_required: 'Aucune boutique active. Rechargez la page.',
  update_failed: 'Impossible d’enregistrer la configuration. Réessayez.',
};

function newLine(): ComponentLine {
  return { id: crypto.randomUUID(), componentProductId: '', search: '', quantity: '1' };
}

export function ProductDetailPanel({
  product,
  allProducts,
  currentRole,
  onClose,
}: {
  product: ProductsPageItem;
  allProducts: ProductsPageItem[];
  currentRole: 'agent' | 'manager' | 'owner';
  onClose: () => void;
}) {
  const router = useRouter();
  const load = useAction(getBundleCompositionAction);
  const save = useAction(saveBundleConfigurationAction);
  const isOwner = currentRole === 'owner';
  const [isBundle, setIsBundle] = useState(product.isBundle);
  const [lines, setLines] = useState<ComponentLine[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Dépense publicitaire (Lot F2) — entrée owner-only, jamais rendue pour manager/agent
  // (le mécanisme lui-même : `canManage` au niveau appelant, products-catalog.tsx, ne
  // couvre QUE owner+manager, pas owner seul — cette section pose sa propre garde
  // owner-only ici, même mécanisme que le masquage de `unit_cost` pour l'agent dans
  // products-catalog.tsx, appliqué au cran de rôle immédiatement supérieur).
  const adSpendCandidates = useAction(getProductAdSpendCandidateLotsAction);
  const [showAdSpendForm, setShowAdSpendForm] = useState(false);
  const [adSpendMessage, setAdSpendMessage] = useState<string | null>(null);

  // Résolution des arrivages candidats dès l'ouverture du panneau (owner uniquement) —
  // jamais au clic sur « Ajouter une dépense publicitaire », pour pouvoir afficher
  // immédiatement le cas « aucun arrivage reçu » sans attente perceptible au clic.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mêmes raisons que l'effet ci-dessus (product.id uniquement)
  useEffect(() => {
    setShowAdSpendForm(false);
    setAdSpendMessage(null);
    if (isOwner) {
      adSpendCandidates.execute({ productId: product.id });
    }
  }, [product.id, isOwner]);

  const candidateLotsResult = adSpendCandidates.result.data;
  const candidateLots: ProductAdSpendCandidateLot[] | null =
    candidateLotsResult?.ok === true ? candidateLotsResult.candidateLots : null;

  // Re-init volontaire sur product.id uniquement — product.isBundle/load.execute changent
  // aussi quand la liste parente se rafraîchit après sauvegarde, ce qui ne doit PAS
  // réinitialiser un panneau déjà ouvert.
  // biome-ignore lint/correctness/useExhaustiveDependencies: voir commentaire ci-dessus
  useEffect(() => {
    setIsBundle(product.isBundle);
    setMessage(null);
    load.execute({ bundleProductId: product.id });
  }, [product.id]);

  useEffect(() => {
    const result = load.result.data;
    if (!result?.ok) return;
    setLines(
      result.components.map((c) => {
        const componentProduct = allProducts.find((p) => p.id === c.componentProductId);
        return {
          id: crypto.randomUUID(),
          componentProductId: c.componentProductId,
          search: componentProduct?.title ?? '',
          quantity: String(c.quantity),
        };
      }),
    );
  }, [load.result.data, allProducts]);

  useEffect(() => {
    const result = save.result.data;
    if (!result) return;
    if (result.ok) {
      setMessage('Configuration enregistrée.');
      router.refresh();
      return;
    }
    setMessage(ERROR_MESSAGES[result.errorCode] ?? 'Une erreur est survenue.');
  }, [router, save.result.data]);

  // Candidats sélectionnables comme composant : ni le produit lui-même (auto-référence),
  // ni un produit déjà marqué bundle (pas d'imbrication) — filtre client en confort UX ;
  // les contraintes SQL (PR 1, migration 0107) restent la source de vérité en cas de
  // contournement (double-onglet, etc.), l'action serveur remonte alors un message clair.
  const candidateProducts = allProducts.filter((p) => p.id !== product.id && !p.isBundle);

  function patchLine(id: string, patch: Partial<ComponentLine>) {
    setLines((current) => current.map((line) => (line.id === id ? { ...line, ...patch } : line)));
  }

  function selectComponent(id: string, componentProductId: string) {
    const componentProduct = candidateProducts.find((p) => p.id === componentProductId);
    patchLine(id, {
      componentProductId,
      search: componentProduct?.title ?? '',
    });
  }

  const componentsValid =
    !isBundle ||
    lines.every((line) => {
      const quantity = Number(line.quantity);
      return (
        line.componentProductId && Number.isInteger(quantity) && quantity >= 1 && quantity <= 999
      );
    });

  function onSave() {
    if (!componentsValid) {
      setMessage('Chaque composant doit être sélectionné avec une quantité valide.');
      return;
    }
    setMessage(null);
    save.execute({
      productId: product.id,
      isBundle,
      components: isBundle
        ? lines.map((line) => ({
            componentProductId: line.componentProductId,
            quantity: Number(line.quantity),
          }))
        : [],
    });
  }

  return (
    <DetailPanel closeLabel="Fermer" onClose={onClose} open title={product.title}>
      <div className="space-y-6 p-4" data-testid="product-detail-panel">
        <section aria-labelledby="product-detail-heading" className="space-y-4">
          <h2 className="text-sm font-semibold text-muted" id="product-detail-heading">
            Détails
          </h2>

          <label className="flex items-center gap-3">
            <input
              checked={isBundle}
              className="size-5"
              onChange={(event) => setIsBundle(event.target.checked)}
              type="checkbox"
            />
            <span className="text-sm font-medium">Pack/bundle</span>
          </label>

          {isBundle ? (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-sm text-muted">
                Composants requis pour assembler ce bundle. La disponibilité du bundle (onglet
                Stock) est calculée à partir du stock de ces composants.
              </p>
              {load.isExecuting ? (
                <p className="text-sm text-muted">Chargement de la composition…</p>
              ) : null}
              {lines.map((line) => {
                const query = line.search.trim().toLowerCase();
                const matches = candidateProducts.filter(
                  (p) =>
                    !query ||
                    p.title.toLowerCase().includes(query) ||
                    p.sku?.toLowerCase().includes(query),
                );
                return (
                  <div className="space-y-2 rounded-lg border border-border p-3" key={line.id}>
                    <label className="block text-sm font-medium">
                      Composant
                      <span className="relative mt-1 block">
                        <Search
                          aria-hidden="true"
                          className="absolute left-3 top-3 size-4 text-muted"
                        />
                        <input
                          className="min-h-10 w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3"
                          onChange={(event) => patchLine(line.id, { search: event.target.value })}
                          value={line.search}
                        />
                      </span>
                    </label>
                    <select
                      aria-label="Produit composant sélectionné"
                      className="min-h-10 w-full rounded-lg border border-border bg-canvas px-3"
                      onChange={(event) => selectComponent(line.id, event.target.value)}
                      value={line.componentProductId}
                    >
                      <option value="">Sélectionnez un produit</option>
                      {matches.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                          {p.sku ? ` (${p.sku})` : ''}
                        </option>
                      ))}
                    </select>
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                      <label className="text-sm font-medium">
                        Quantité requise
                        <input
                          className="mt-1 min-h-10 w-full rounded-lg border border-border bg-canvas px-3"
                          min="1"
                          onChange={(event) => patchLine(line.id, { quantity: event.target.value })}
                          type="number"
                          value={line.quantity}
                        />
                      </label>
                      <button
                        aria-label="Retirer ce composant"
                        className="mt-6 inline-flex size-10 items-center justify-center rounded-lg border border-border hover:bg-canvas"
                        onClick={() =>
                          setLines((current) => current.filter((l) => l.id !== line.id))
                        }
                        type="button"
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-canvas disabled:opacity-60"
                disabled={load.isExecuting}
                onClick={() => setLines((current) => [...current, newLine()])}
                type="button"
              >
                <Plus aria-hidden="true" className="size-4" />
                Ajouter un composant
              </button>
            </div>
          ) : null}

          {message ? <output className="block text-sm text-muted">{message}</output> : null}

          <button
            className="min-h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink hover:bg-accent-hover disabled:opacity-60"
            disabled={save.isExecuting || load.isExecuting}
            onClick={onSave}
            type="button"
          >
            {save.isExecuting ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </section>

        {/* Ce gate `isOwner` est de l'UX seulement (masquer l'entrée pour un rôle qui
            ne l'utilisera pas) — la VRAIE frontière de sécurité est `requireRole('owner')`
            côté serveur sur les actions de dépense publicitaire elles-mêmes
            (`lib/actions/purchases.ts`). Un contournement client (devtools, requête
            directe) est rejeté serveur quel que soit l'état de ce booléen. */}
        {isOwner ? (
          <section aria-labelledby="product-ad-spend-heading" className="space-y-4">
            <h2 className="text-sm font-semibold text-muted" id="product-ad-spend-heading">
              Dépenses publicitaires
            </h2>

            {adSpendCandidates.isExecuting ? (
              <p className="text-sm text-muted">Recherche de l'arrivage concerné…</p>
            ) : showAdSpendForm ? (
              <div className="space-y-2 rounded-lg border border-border p-3">
                <ProductAdSpendForm
                  candidateLots={candidateLots ?? undefined}
                  onDone={() => {
                    setShowAdSpendForm(false);
                    setAdSpendMessage('Dépense publicitaire enregistrée.');
                  }}
                  productId={product.id}
                  productLabel={product.title}
                />
                <button
                  className="min-h-11 text-xs font-medium text-muted underline hover:text-text"
                  onClick={() => setShowAdSpendForm(false)}
                  type="button"
                >
                  Annuler
                </button>
              </div>
            ) : (
              <button
                className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-canvas disabled:opacity-60"
                disabled={candidateLots == null}
                onClick={() => {
                  setAdSpendMessage(null);
                  setShowAdSpendForm(true);
                }}
                type="button"
              >
                <Plus aria-hidden="true" className="size-4" />
                Ajouter une dépense publicitaire
              </button>
            )}

            {candidateLotsResult != null && candidateLotsResult.ok === false ? (
              <p className="text-sm text-danger" role="alert">
                Impossible de trouver l'arrivage de ce produit pour le moment.
              </p>
            ) : null}

            {adSpendMessage ? (
              <output className="block text-sm text-muted">{adSpendMessage}</output>
            ) : null}
          </section>
        ) : null}
      </div>
    </DetailPanel>
  );
}
