'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

type EmbeddedSurfaceProps = {
  clientId: string | null;
  host: string | null;
  supportEmail: string | null;
};

type SurfaceState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready' | 'uninstalled';
      shop: {
        domain: string;
        installedAt: string;
        lastSyncAt: string | null;
        updatedAt: string;
      };
      nextAction: 'open_cockpit' | 'reinstall';
    }
  | { kind: 'not_configured'; domain: string };

type ShopifyBridge = {
  config: { apiKey: string; host: string };
  idToken: () => Promise<string>;
};

declare global {
  interface Window {
    shopify?: ShopifyBridge;
  }
}

function decodeHost(host: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(host)) {
    return null;
  }

  try {
    const decoded = atob(host.replace(/-/g, '+').replace(/_/g, '/'));
    if (/^admin\.shopify\.com\/store\/[a-z0-9-]+$/i.test(decoded)) {
      return decoded;
    }

    if (/^[a-z0-9-]+\.myshopify\.com\/admin$/i.test(decoded)) {
      return decoded;
    }

    return null;
  } catch {
    return null;
  }
}

function formatDate(value: string | null): string {
  if (!value) {
    return 'Pas encore synchronisée';
  }

  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function stateLabel(state: SurfaceState): string {
  switch (state.kind) {
    case 'loading':
      return 'Chargement';
    case 'ready':
      return 'Prête';
    case 'not_configured':
      return 'Non configurée';
    case 'uninstalled':
      return 'Désinstallée';
    case 'error':
      return 'Erreur';
  }
}

export function EmbeddedShopifySurface({ clientId, host, supportEmail }: EmbeddedSurfaceProps) {
  const [state, setState] = useState<SurfaceState>({ kind: 'loading' });
  const validatedHost = useMemo(() => (host ? decodeHost(host) : null), [host]);

  useEffect(() => {
    let cancelled = false;

    async function loadSurface() {
      if (!clientId) {
        setState({ kind: 'error', message: 'L’application Shopify n’est pas configurée.' });
        return;
      }

      if (!validatedHost) {
        setState({ kind: 'error', message: 'Le contexte Shopify est absent ou invalide.' });
        return;
      }

      const bridge = window.shopify;
      if (!bridge || typeof bridge.idToken !== 'function') {
        setState({ kind: 'error', message: 'App Bridge Shopify est indisponible.' });
        return;
      }

      try {
        bridge.config = { apiKey: clientId, host: host ?? '' };
        const token = await bridge.idToken();
        if (!token) {
          throw new Error('missing_session_token');
        }

        const response = await fetch('/api/shopify/embedded/session', {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const payload: unknown = await response.json();

        if (!response.ok) {
          throw new Error('embedded_session_failed');
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new Error('embedded_session_invalid_response');
        }

        const record = payload as Record<string, unknown>;
        if (record.status === 'not_configured') {
          const shop = record.shop;
          const domain =
            shop && typeof shop === 'object' && !Array.isArray(shop)
              ? (shop as Record<string, unknown>).domain
              : null;
          if (typeof domain !== 'string') {
            throw new Error('embedded_session_invalid_shop');
          }
          if (!cancelled) setState({ kind: 'not_configured', domain });
          return;
        }

        if (record.status !== 'ready' && record.status !== 'uninstalled') {
          throw new Error('embedded_session_invalid_status');
        }

        const shop = record.shop;
        if (!shop || typeof shop !== 'object' || Array.isArray(shop)) {
          throw new Error('embedded_session_invalid_shop');
        }
        const shopRecord = shop as Record<string, unknown>;
        if (
          typeof shopRecord.domain !== 'string' ||
          typeof shopRecord.installedAt !== 'string' ||
          (shopRecord.lastSyncAt !== null && typeof shopRecord.lastSyncAt !== 'string') ||
          typeof shopRecord.updatedAt !== 'string'
        ) {
          throw new Error('embedded_session_invalid_shop');
        }

        if (!cancelled) {
          setState({
            kind: record.status,
            nextAction: record.nextAction === 'reinstall' ? 'reinstall' : 'open_cockpit',
            shop: {
              domain: shopRecord.domain,
              installedAt: shopRecord.installedAt,
              lastSyncAt: shopRecord.lastSyncAt,
              updatedAt: shopRecord.updatedAt,
            },
          });
        }
      } catch {
        if (!cancelled) {
          setState({ kind: 'error', message: 'Impossible de vérifier l’installation Shopify.' });
        }
      }
    }

    void loadSurface();
    return () => {
      cancelled = true;
    };
  }, [clientId, host, validatedHost]);

  const shopDomain =
    state.kind === 'not_configured'
      ? state.domain
      : state.kind === 'ready' || state.kind === 'uninstalled'
        ? state.shop.domain
        : null;
  const installHref =
    state.kind === 'not_configured'
      ? `/api/shopify/embedded/install?shop=${encodeURIComponent(state.domain)}${host ? `&host=${encodeURIComponent(host)}` : ''}`
      : null;

  return (
    <main
      className="min-h-dvh bg-canvas px-4 py-6 text-text sm:px-6 sm:py-10"
      data-testid="shopify-embedded-surface"
    >
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm font-medium text-muted">Tëër dans Shopify</p>
          <h1 className="font-display text-3xl tracking-tight sm:text-4xl">Votre boutique COD</h1>
          <p className="max-w-xl text-sm leading-6 text-muted">
            Cette porte d’entrée confirme l’installation et la synchronisation. Le cockpit complet
            reste ouvert volontairement dans Tëër.
          </p>
        </header>

        <section
          aria-live="polite"
          aria-label="État de l’installation Shopify"
          className="rounded-2xl border border-border bg-surface p-5 shadow-warm-1 sm:p-6"
          data-state={state.kind}
          data-testid="shopify-embedded-state"
        >
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
            État : {stateLabel(state)}
          </p>

          {state.kind === 'loading' ? (
            <p className="mt-4 text-sm text-muted">Vérification sécurisée de la boutique…</p>
          ) : null}

          {state.kind === 'error' ? (
            <div className="mt-4 space-y-4">
              <p className="text-sm leading-6 text-danger" role="alert">
                {state.message}
              </p>
              <p className="text-sm leading-6 text-muted">
                Rechargez cette page depuis Shopify Admin. Aucun cookie tiers ni secret n’est requis
                par cette surface.
              </p>
            </div>
          ) : null}

          {state.kind === 'not_configured' ? (
            <div className="mt-4 space-y-4">
              <p className="text-lg font-semibold">{state.domain}</p>
              <p className="text-sm leading-6 text-muted">
                Shopify a ouvert Tëër, mais cette boutique n’est pas encore associée. L’association
                nécessite une action explicite avec votre compte Tëër.
              </p>
              <Link
                className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-text"
                href={installHref ?? '#'}
              >
                Associer Tëër et installer
              </Link>
            </div>
          ) : null}

          {state.kind === 'ready' || state.kind === 'uninstalled' ? (
            <div className="mt-4 space-y-5">
              <p className="text-lg font-semibold">{shopDomain}</p>
              <dl className="grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="font-medium">Installation</dt>
                  <dd className="mt-1 text-muted">{formatDate(state.shop.installedAt)}</dd>
                </div>
                <div>
                  <dt className="font-medium">Dernière synchronisation</dt>
                  <dd className="mt-1 text-muted">{formatDate(state.shop.lastSyncAt)}</dd>
                </div>
              </dl>
              {state.kind === 'uninstalled' ? (
                <p className="rounded-lg border border-warning/30 bg-canvas px-4 py-3 text-sm leading-6 text-muted">
                  L’application a été désinstallée. Réinstallez-la depuis Shopify Admin pour
                  reprendre la synchronisation.
                </p>
              ) : null}
              {state.kind === 'ready' ? (
                <a
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-accent px-4 text-sm font-semibold text-text"
                  href="/tableau"
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  Ouvrir le cockpit Tëër
                </a>
              ) : null}
            </div>
          ) : null}
        </section>

        <footer className="grid gap-3 text-sm sm:grid-cols-2">
          {supportEmail ? (
            <a
              className="rounded-lg border border-border bg-surface p-4 underline"
              href={`mailto:${supportEmail}`}
            >
              Contacter le support
            </a>
          ) : (
            <p className="rounded-lg border border-border bg-surface p-4 text-muted">
              Le support est disponible depuis votre espace Tëër.
            </p>
          )}
          <details className="rounded-lg border border-border bg-surface p-4">
            <summary className="cursor-pointer font-medium">Désinstaller ou supprimer</summary>
            <p className="mt-3 leading-6 text-muted">
              Désinstallez Tëër depuis Shopify Admin. Pour demander la suppression des données,
              contactez le support depuis votre espace Tëër ; la demande suit le parcours de
              confidentialité prévu.
            </p>
          </details>
        </footer>
      </div>
    </main>
  );
}
