import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_API_TOPICS,
  APP_LEVEL_BY_DECISION_TOPICS,
  APP_LEVEL_ONLY_TOPICS,
  APP_LEVEL_TOPICS,
  PER_SHOP_SUBSCRIPTION_TOPICS,
} from '@/scripts/lib/webhook-subscription-plan.mjs';
import { describe, expect, it } from 'vitest';

// Verrou de DÉCLARATIONS sur shopify.app.teer-public.toml — pas un validateur de syntaxe TOML
// (aucun parseur TOML n'est présent dans le dépôt, et en ajouter un serait une dette annexe).
// La validation syntaxique réelle appartient au Shopify CLI, exécutée par le porteur au moment
// du `deploy --no-release` : cf. docs/shopify/teer-public-app-config.md.
//
// Ce que ces tests garantissent, et qui ne se relit pas à l'œil : le partage 4 / 8 entre les
// abonnements déclarés au niveau app et ceux créés par boutique. Un topic métier qui
// réapparaîtrait dans le TOML produirait une DOUBLE livraison invisible à
// scripts/webhook-subscription-migration.mjs — un abonnement app-scoped n'est pas retourné par la
// query Admin `webhookSubscriptions` (« Returns only shop-scoped subscriptions, not app-scoped
// subscriptions configured in TOML files »), donc ni listSubscriptions ni verifyAndCleanup ne
// pourraient le voir ni le retirer.

const TOML = readFileSync(join(process.cwd(), 'shopify.app.teer-public.toml'), 'utf8');
const TOML_LINES = TOML.split(/\r?\n/);

function declaredTopics(key: 'topics' | 'compliance_topics'): string[] {
  const out: string[] = [];
  for (const line of TOML_LINES) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key} = [`)) continue;
    const inner = trimmed.slice(trimmed.indexOf('[') + 1, trimmed.lastIndexOf(']'));
    for (const raw of inner.split(',')) {
      const value = raw.trim().replace(/^"|"$/g, '');
      if (value) out.push(value);
    }
  }
  return out;
}

function declaredWebhookUris(): string[] {
  return [...TOML.matchAll(/^\s*uri = "([^"]+)"/gm)].map((m) => m[1]);
}

describe('shopify.app.teer-public.toml — identité de la version active teer-public-2', () => {
  it('reprend les trois valeurs confirmées, sans changement de domaine', () => {
    expect(TOML).toContain('client_id = "86c612a670ee04fe488426f442037605"');
    expect(TOML).toContain(
      'application_url = "https://www.teerafrik.com/shopify/embedded/teer-public"',
    );
    expect(TOML).toContain('"https://www.teerafrik.com/api/shopify/callback"');
  });

  it('conserve les portées à l\u2019identique — toute divergence reconsent le marchand', () => {
    expect(TOML).toContain('scopes = "read_customers,read_orders,read_products"');
    expect(TOML).toContain('optional_scopes = [ ]');
  });

  // TEST-NONEMBED-01, Test A : `embedded` bascule à `false` pour MESURER si Shopify délivre
  // un code d'autorisation exploitable à une app publique non embarquée qui le demande. La
  // garde anti-dérive reste entière : elle change de valeur attendue, jamais de rôle. Et
  // `use_legacy_install_flow` reste à `false` : ce réglage ne se touche QUE sur le verdict
  // « échec du régime géré » du protocole, jamais sur un échec interne.
  it('porte le mode non embarqué du Test A et le flux d\u2019installation moderne', () => {
    expect(TOML).toContain('embedded = false');
    expect(TOML).toContain('use_legacy_install_flow = false');
  });

  it('ne porte plus aucun marqueur à renseigner', () => {
    expect(TOML).not.toMatch(/__A_RENSEIGNER__|TODO|FIXME/);
  });
});

describe('shopify.app.teer-public.toml — URI', () => {
  it('déclare exactement deux blocs d\u2019abonnements, tous deux sur l\u2019endpoint historique', () => {
    expect(declaredWebhookUris()).toEqual([
      'https://www.teerafrik.com/api/shopify/webhooks',
      'https://www.teerafrik.com/api/shopify/webhooks',
    ]);
  });

  it('n\u2019utilise que HTTPS et un seul hôte, sur toutes les URL du fichier', () => {
    const urls = [...TOML.matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => new URL(m[1]));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe('www.teerafrik.com');
    }
  });

  it('ne déclare jamais l\u2019URL opaque au niveau app', () => {
    expect(TOML).not.toContain('/api/shopify/ingest/');
  });
});

describe('partage 4 / 8 entre niveau app et niveau boutique', () => {
  it('déclare les 3 topics GDPR comme compliance_topics, seul endroit possible', () => {
    expect(declaredTopics('compliance_topics').sort()).toEqual([...APP_LEVEL_ONLY_TOPICS].sort());
  });

  it('déclare app/uninstalled au niveau app — décision, pas incapacité', () => {
    expect(declaredTopics('topics')).toEqual([...APP_LEVEL_BY_DECISION_TOPICS]);
  });

  it('déclare exactement les 4 topics de niveau app, ni plus ni moins', () => {
    const declared = [...declaredTopics('topics'), ...declaredTopics('compliance_topics')].sort();
    expect(declared).toEqual([...APP_LEVEL_TOPICS].sort());
    expect(declared).toHaveLength(4);
  });

  it('ne déclare AUCUN des topics métier — ils sont créés par boutique sur l\u2019URL opaque', () => {
    const declared = new Set([...declaredTopics('topics'), ...declaredTopics('compliance_topics')]);
    for (const topic of ADMIN_API_TOPICS) {
      expect(declared.has(topic.rest)).toBe(false);
    }
  });
});

describe('topics par boutique — huit topics métier, plus app/uninstalled (lot 1b, E0)', () => {
  it('compte exactement 8 topics métier', () => {
    expect(ADMIN_API_TOPICS).toHaveLength(8);
  });

  it('garde app/uninstalled hors des topics MÉTIER', () => {
    expect(ADMIN_API_TOPICS.map((t) => t.rest)).not.toContain('app/uninstalled');
    expect(ADMIN_API_TOPICS.map((t) => t.graphql)).not.toContain('APP_UNINSTALLED');
  });

  // SHOPIFY-WEBHOOKS-PER-SHOP-1B / E0 — ce test verrouillait l'EXCLUSION d'app/uninstalled des
  // abonnements par boutique. Il verrouille désormais son INCLUSION : la désinstallation doit
  // arriver sur l'URL opaque, résolue par le jeton et non par un en-tête non signé.
  it('souscrit app/uninstalled par boutique : neuf abonnements attendus', () => {
    expect(PER_SHOP_SUBSCRIPTION_TOPICS).toHaveLength(9);
    expect(PER_SHOP_SUBSCRIPTION_TOPICS.map((t) => t.rest)).toContain('app/uninstalled');
    expect(PER_SHOP_SUBSCRIPTION_TOPICS.map((t) => t.graphql)).toContain('APP_UNINSTALLED');
    expect(PER_SHOP_SUBSCRIPTION_TOPICS.slice(0, 8)).toEqual([...ADMIN_API_TOPICS]);
  });

  // Le TOML global reste inchangé dans ce lot (E11 est un sous-lot distinct) : app/uninstalled
  // est donc livré DEUX fois, et c'est la primitive ordonnée de 0161 qui absorbe la seconde.
  it('laisse app/uninstalled déclaré au niveau app : double livraison assumée jusqu’à E11', () => {
    expect(declaredTopics('topics')).toEqual(['app/uninstalled']);
    const perShop = new Set(PER_SHOP_SUBSCRIPTION_TOPICS.map((t) => t.rest));
    expect(APP_LEVEL_TOPICS.filter((topic) => perShop.has(topic))).toEqual(['app/uninstalled']);
  });

  it('garde les deux raisons de rester au niveau app SÉPARÉES', () => {
    // GDPR : non souscriptibles. app/uninstalled : souscriptible, et resté au niveau app par choix.
    // Fusionner les deux listes ferait perdre la raison, donc la possibilité de la réviser.
    expect(APP_LEVEL_ONLY_TOPICS).not.toContain('app/uninstalled');
    expect(APP_LEVEL_BY_DECISION_TOPICS).toEqual(['app/uninstalled']);
  });

  it('ne souscrit jamais par boutique un topic RGPD (non souscriptible)', () => {
    const perShop = new Set(PER_SHOP_SUBSCRIPTION_TOPICS.map((t) => t.rest));
    for (const topic of APP_LEVEL_ONLY_TOPICS) {
      expect(perShop.has(topic)).toBe(false);
    }
  });

  it('ne recoupe jamais les topics de niveau app par un topic MÉTIER', () => {
    const admin = new Set(ADMIN_API_TOPICS.map((t) => t.rest));
    for (const topic of APP_LEVEL_TOPICS) {
      expect(admin.has(topic)).toBe(false);
    }
  });
});
