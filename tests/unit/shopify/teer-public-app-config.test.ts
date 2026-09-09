import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ADMIN_API_TOPICS,
  APP_LEVEL_BY_DECISION_TOPICS,
  APP_LEVEL_ONLY_TOPICS,
  APP_LEVEL_TOPICS,
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

  it('conserve le mode embarqué et le flux d\u2019installation moderne', () => {
    expect(TOML).toContain('embedded = true');
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

describe('ADMIN_API_TOPICS — invariant anti double livraison', () => {
  it('compte exactement 8 topics métier', () => {
    expect(ADMIN_API_TOPICS).toHaveLength(8);
  });

  it('exclut app/uninstalled — sinon --apply en créerait un second, shop-scoped', () => {
    expect(ADMIN_API_TOPICS.map((t) => t.rest)).not.toContain('app/uninstalled');
    expect(ADMIN_API_TOPICS.map((t) => t.graphql)).not.toContain('APP_UNINSTALLED');
  });

  it('garde les deux raisons de rester au niveau app SÉPARÉES', () => {
    // GDPR : non souscriptibles. app/uninstalled : souscriptible, mais non souscrit par choix.
    // Fusionner les deux listes ferait perdre la raison, donc la possibilité de la réviser.
    expect(APP_LEVEL_ONLY_TOPICS).not.toContain('app/uninstalled');
    expect(APP_LEVEL_BY_DECISION_TOPICS).toEqual(['app/uninstalled']);
  });

  it('ne recoupe jamais les topics de niveau app', () => {
    const admin = new Set(ADMIN_API_TOPICS.map((t) => t.rest));
    for (const topic of APP_LEVEL_TOPICS) {
      expect(admin.has(topic)).toBe(false);
    }
  });
});
