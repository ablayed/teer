import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';

/**
 * Preuve de compilation pour la preuve 5.5 (Phase F · Lot U1-F). Vérifié par `pnpm typecheck`,
 * jamais chargé par vitest (pas de suffixe .test.tsx).
 */

// Usage valide — une carte avec sa portée temporelle compile.
function ValidBalanceCard() {
  return (
    <ScopedMetricCard
      label="Argent chez le livreur"
      scope={{ kind: 'balance', asOfLabel: '27 août 2026' }}
      value="1 539 116 F CFA"
    />
  );
}

function ValidFlowCard() {
  return (
    <ScopedMetricCard
      label="CA encaissé"
      scope={{ kind: 'flow', periodLabel: '30 derniers jours' }}
      value="495 405 F CFA"
    />
  );
}

// Une carte SANS portée temporelle ne doit pas compiler.
function InvalidCardWithoutScope() {
  // @ts-expect-error — `scope` est obligatoire, une carte sans portée ne doit pas compiler.
  return <ScopedMetricCard label="CA encaissé" value="495 405 F CFA" />;
}

export const __scopedMetricCardContractFixtures = {
  ValidBalanceCard,
  ValidFlowCard,
  InvalidCardWithoutScope,
};
