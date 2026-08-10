// S3-A3-F — preuve versionnée qu'un même AdminClient traversant la migration 0120 SANS être
// recréé s'auto-corrige DÈS SA PREMIÈRE opération post-migration, jamais "échoue une fois puis
// la requête suivante marche". C'est le scénario que S3-A3-R a identifié comme réaliste (pas
// synthétique) : `app/api/cron/shopify-reconcile/route.ts` construit UN SEUL client puis boucle
// sur toutes les boutiques actives, et `persistBulkOrders` (lib/shopify/reconcile.ts) boucle sur
// TOUTES les commandes d'un import bulk avec CE MÊME client — un run peut durer plusieurs minutes
// (`maxDuration = 300`), largement de quoi chevaucher une fenêtre de migration en production.
//
// Ce fichier échoue sur le head pré-correctif (WeakMap<AdminClient, Promise<boolean>> qui met en
// cache un `true` à vie) et passe avec le cache asymétrique (négatif seul mis en cache) de
// lib/shopify/customer-pcd-columns.ts.
import { getCustomerPcdColumnsAvailable } from '@/lib/shopify/customer-pcd-columns';
import { type ShopifyOrderNode, persistShopifyOrder } from '@/lib/shopify/orders-sync';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const skipIfNoServiceRole = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;
const createdUserIds: string[] = [];
// Utilisé par `afterEach` pour la vérification de convergence par INSERT réelle (voir
// `waitForCustomerInsertCapability`) avant de supprimer les utilisateurs de test — protège tout
// AUTRE fichier de test qui démarrerait juste après celui-ci (même worker séquentiel ou un worker
// concurrent) contre la même fenêtre de latence du schema cache PostgREST que ce fichier peut
// laisser derrière lui après son propre roundtrip DROP/ADD COLUMN.
let lastMerchantAccountId: string | null = null;

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// SQL réel de la migration 0120 (supabase/migrations/0120_s1a_minimize_shopify_customer_pcd.sql
// sur la branche shopify/s2-remediation-and-embedded-review, PR #126) — jamais copié dans le
// répertoire de migrations trackées de CETTE branche, appliqué directement via `pg` pour simuler
// exactement un `db push` survenant en cours de run, sans passer par `supabase db reset --local`
// (qui redémarrerait les conteneurs, invalidant le scénario "même processus, même client").
//
// `lock table ... in access exclusive mode` en tête : rend le DROP+UPDATE (ou le ADD COLUMN de
// restauration) atomique au niveau Postgres vis-à-vis de toute AUTRE transaction concurrente sur
// `public.customer` — une table que d'autres fichiers RLS lisent/écrivent aussi (isolés par tenant
// en DML normal, mais un DROP/ADD COLUMN concurrent casse cette isolation pour toute session).
//
// Ce verrou seul NE SUFFIT PAS : PostgREST maintient un schema cache PROCESS-WIDE, en dehors de
// toute transaction Postgres — un DROP/ADD COLUMN qui vient de committer (verrou relâché) peut
// encore mettre plusieurs dizaines à quelques centaines de ms à se refléter dans ce cache, fenêtre
// pendant laquelle N'IMPORTE QUELLE session (y compris un AUTRE fichier de test tournant en
// parallèle) peut observer un schéma incohérent. C'est ce qui a été mesuré ici : ce fichier exécuté
// seul passait systématiquement (5/5), mais échouait de façon reproductible (observé 3 fois sur 4
// dans un run côte à côte, cause confirmée par log : `PGRST204 ... 'accepts_marketing' ... in the
// schema cache` sur une commande n'ayant RIEN à voir avec la migration en cours dans l'autre
// fichier) dès qu'il tournait aux côtés de `shopify-bridge-dual-schema.rls.test.ts`. Le correctif
// retenu est `--no-file-parallelism` sur le script `test:rls` (package.json) : ce fichier est,à ce
// jour, le SEUL de la suite RLS à faire du DDL live sur une table partagée — sérialiser l'exécution
// des fichiers RLS élimine structurellement toute la classe de race, au prix d'une suite RLS un peu
// plus longue en temps d'horloge (I/O-bound sur un seul stack Postgres partagé de toute façon, pas
// CPU-bound — le gain de parallélisme y était déjà marginal). `waitForSchemaCacheAvailable`
// ci-dessous reste utile en complément : il protège aussi contre la latence de rechargement PURE
// (même sans concurrence d'autres fichiers), qui est non nulle par construction.
const MIGRATION_0120_SQL = `
lock table public.customer in access exclusive mode;

update public.customer
set
  tags = null,
  accepts_marketing = null,
  shopify_orders_count = null,
  shopify_amount_spent_minor = null,
  first_seen_at = null
where tags is not null
   or accepts_marketing is not null
   or shopify_orders_count is not null
   or shopify_amount_spent_minor is not null
   or first_seen_at is not null;

alter table public.customer
  drop column if exists tags,
  drop column if exists accepts_marketing,
  drop column if exists shopify_orders_count,
  drop column if exists shopify_amount_spent_minor,
  drop column if exists first_seen_at;
`;

const RESTORE_PRE_0120_SQL = `
lock table public.customer in access exclusive mode;

alter table public.customer
  add column if not exists tags text[],
  add column if not exists accepts_marketing boolean,
  add column if not exists shopify_orders_count integer,
  add column if not exists shopify_amount_spent_minor bigint,
  add column if not exists first_seen_at timestamptz;
`;

// DDL appliqué via une connexion `pg` directe (hors du chemin `supabase db push`/CLI) ne déclenche
// pas automatiquement le rechargement du schema cache PostgREST — sans ce NOTIFY explicite, un
// test qui restaure les colonnes en `afterEach` peut laisser PostgREST répondre encore "colonne
// absente" pendant une fenêtre courte après le ADD COLUMN, provoquant un flake du test SUIVANT
// (observé une fois pendant la mise au point de ce fichier, non reproductible après ce fix).
const RELOAD_SCHEMA_CACHE_SQL = `notify pgrst, 'reload schema';`;

async function applySql(sql: string) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(sql);
    await client.query(RELOAD_SCHEMA_CACHE_SQL);
  } finally {
    await client.end();
  }
}

// PostgREST recharge son schema cache de façon ASYNCHRONE après un NOTIFY (délai non nul, non
// borné a priori) — un test-only artefact de la restauration `RESTORE_PRE_0120_SQL` (ADD COLUMN),
// jamais rencontré dans la vraie séquence 0120 (les migrations de ce projet sont append-only,
// aucune colonne n'est jamais réintroduite après un drop en production). Sans cette attente, le
// test SUIVANT peut démarrer pendant que PostgREST croit encore certaines colonnes absentes et
// rejeter un select/insert les référençant avec PGRST204 — un faux négatif de harnais de test, pas
// un défaut du correctif de production (qui, lui, gère déjà ce code exactement comme 42703).
//
// Sonde volontairement les 5 colonnes explicitement (pas seulement `tags`, la colonne
// représentative que `getCustomerPcdColumnsAvailable` sonde en production) : mesuré ici que le
// rechargement du schema cache PostgREST n'est PAS garanti atomique entre colonnes pendant la
// fenêtre de convergence — `tags` peut redevenir visible avant `accepts_marketing` après un ADD
// COLUMN qui les ajoute pourtant dans la même transaction. Cette non-atomicité inter-colonnes n'a
// aucune incidence en production (0120 ne supprime/ré-ajoute jamais qu'une seule fois, jamais en
// boucle comme ce harnais de test), mais casserait ce fichier si on réutilisait tel quel le probe
// à une seule colonne du helper applicatif.
async function createOwnerWithMerchant(admin: AdminClient, suffix: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email: `bridge-live-${suffix}@example.com`,
    password: 'bridge-live-transition-test',
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('user not created');
  createdUserIds.push(data.user.id);

  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: member } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', data.user.id)
      .maybeSingle();
    if (member?.id) return member.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('merchant_account not found');
}

// Un `select ... limit(0)` referant les 5 colonnes PCD peut répondre "présentes" alors qu'un
// INSERT réel sur les mêmes colonnes échoue encore en PGRST204 juste après : mesuré ici — le cache
// PostgREST n'est PAS garanti cohérent entre le chemin de validation d'un SELECT et celui d'un
// INSERT pendant sa fenêtre de rechargement asynchrone. Cet artefact n'a de sens que pour un
// ADD COLUMN qui RÉINTRODUIT des colonnes après un DROP — un aller-retour que ce fichier de test
// exerce (afin de rejouer 2 opérations avec le même client sans redémarrer `supabase db reset`)
// mais que la vraie production ne fait JAMAIS (migrations append-only, cf. CLAUDE.md). Le seul
// probe fiable est donc une INSERT réelle des 5 colonnes, immédiatement retirée, retryée jusqu'à
// convergence — exactement le chemin que `persistShopifyOrder` empruntera juste après.
async function waitForCustomerInsertCapability(
  admin: AdminClient,
  merchantAccountId: string,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const probeId = `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0')}`;
    const { error } = await admin
      .from('customer')
      .insert({
        id: probeId,
        merchant_account_id: merchantAccountId,
        source: 'manual',
        tags: ['probe'],
        accepts_marketing: false,
        shopify_orders_count: 0,
        shopify_amount_spent_minor: 0,
      })
      .select('id')
      .single();

    if (!error) {
      await admin.from('customer').delete().eq('id', probeId);
      return;
    }

    if (error.code !== '42703' && error.code !== 'PGRST204') {
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`customer insert capability did not converge within ${timeoutMs}ms`);
}

function makeOrderNode(suffix: string): ShopifyOrderNode {
  return {
    id: `gid://shopify/Order/${suffix}`,
    name: `#live-${suffix}`,
    createdAt: '2026-08-10T10:00:00Z',
    displayFinancialStatus: 'PENDING',
    displayFulfillmentStatus: 'UNFULFILLED',
    currentTotalPriceSet: { shopMoney: { amount: '5000', currencyCode: 'XOF' } },
    customer: {
      id: `gid://shopify/Customer/${suffix}`,
      displayName: 'Client Live',
      phone: `+22177${suffix.slice(-7)}`,
      numberOfOrders: 3,
      amountSpent: { amount: '15000' },
      tags: ['live', 'S3-A3-F'],
      emailMarketingConsent: { marketingState: 'SUBSCRIBED' },
      createdAt: '2026-01-01T00:00:00Z',
    },
    shippingAddress: null,
    lineItems: {
      edges: [
        {
          node: {
            title: 'Produit live',
            sku: 'LIVE-1',
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: '5000' } },
            variant: null,
            product: null,
          },
        },
      ],
    },
  };
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  // Restaure le schéma pré-0120 pour ne jamais laisser la base locale dans un état non tracké
  // par les migrations (ce fichier n'ajoute et ne suppose aucune migration committée).
  await applySql(RESTORE_PRE_0120_SQL);
  const admin = adminClient();
  // Attend la convergence RÉELLE (INSERT, pas SELECT) avant de continuer : protège tout AUTRE
  // fichier RLS préexistant qui toucherait `customer` juste après celui-ci (ex.
  // `customer-enrichment.rls.test.ts`, qui insère `accepts_marketing` sans aucune protection
  // contre ce cache-lag PostgREST spécifique à un ADD COLUMN après DROP) — observé en pratique :
  // ce fichier de test faisait échouer `customer-enrichment.rls.test.ts` en `PGRST204` quand les
  // deux tournaient dans la même invocation `vitest run tests/rls`, avant ce garde.
  if (lastMerchantAccountId) {
    await waitForCustomerInsertCapability(admin, lastMerchantAccountId);
  }
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('Bridge S3-A3-F — même client à travers une migration 0120 live (sans restart)', () => {
  skipIfNoServiceRole(
    "same process / same AdminClient / cache primé true / migration appliquée sans restart / première opération post-0120 = PASS immédiat (pas 'échoue puis la suivante marche')",
    async () => {
      const admin = adminClient(); // SAME client instance utilisée avant ET après la migration.
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const merchantAccountId = await createOwnerWithMerchant(admin, suffix);
      lastMerchantAccountId = merchantAccountId;

      const { data: shop, error: shopError } = await admin
        .from('shop')
        .insert({
          merchant_account_id: merchantAccountId,
          shop_domain: `bridge-live-${suffix}.myshopify.com`,
          access_token_encrypted: 'encrypted-token-placeholder',
          scopes: 'read_orders,read_customers',
        })
        .select('id')
        .single();
      if (shopError || !shop) throw shopError ?? new Error('shop not created');

      // same AdminClient object = YES, cache primed true = YES.
      const before = await getCustomerPcdColumnsAvailable(admin);
      expect(before).toBe(true);

      // no restart = YES (pas de supabase db reset ici), no cache reset from test = YES (aucun
      // accès direct au WeakSet interne du helper).
      await applySql(MIGRATION_0120_SQL);

      // first post-0120 operation = PASS attendu DÈS CET APPEL, avec le MÊME client.
      const result = await persistShopifyOrder({
        merchantAccountId,
        orderNode: makeOrderNode(suffix),
        shopId: shop.id,
        supabaseServiceClient: admin,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        // Message de diagnostic explicite si jamais le correctif régresse.
        throw new Error(`Regression: first post-0120 operation failed: ${result.error}`);
      }

      const { data: order } = await admin
        .from('orders')
        .select('id, total_amount')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', suffix)
        .maybeSingle();
      expect(order?.total_amount).toBe(5000);
    },
    30000,
  );

  skipIfNoServiceRole(
    'boucle bulk/cron à 2 commandes avec un seul client : migration injectée entre les deux, ni la première ni la seconde ne casse silencieusement, aucune double écriture sur la première',
    async () => {
      const admin = adminClient(); // SAME client réutilisé pour toute la "boucle bulk" simulée.
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const merchantAccountId = await createOwnerWithMerchant(admin, suffix);
      lastMerchantAccountId = merchantAccountId;

      // Ce test s'exécute juste après le test précédent, qui a fait DROP puis (en afterEach)
      // ADD COLUMN sur `public.customer`. Attend la convergence réelle du cache PostgREST via une
      // vraie INSERT (pas un SELECT, cf. commentaire de `waitForCustomerInsertCapability`) avant de
      // faire reposer les assertions qui suivent sur un schéma supposé stable — n'affecte PAS
      // l'invariant testé par CE fichier (le comportement d'un client qui traverse 0120 en LIVE),
      // seulement l'hygiène de démarrage de ce test précis vis-à-vis du roundtrip du test précédent.
      await waitForCustomerInsertCapability(admin, merchantAccountId);

      const { data: shop, error: shopError } = await admin
        .from('shop')
        .insert({
          merchant_account_id: merchantAccountId,
          shop_domain: `bridge-bulk-${suffix}.myshopify.com`,
          access_token_encrypted: 'encrypted-token-placeholder',
          scopes: 'read_orders,read_customers',
        })
        .select('id')
        .single();
      if (shopError || !shop) throw shopError ?? new Error('shop not created');

      // Commande 1, traitée AVANT la migration, avec le client qui va traverser 0120.
      const firstResult = await persistShopifyOrder({
        merchantAccountId,
        orderNode: makeOrderNode(`${suffix}-a`),
        shopId: shop.id,
        supabaseServiceClient: admin,
      });
      expect(firstResult.ok).toBe(true);

      const { data: firstOrderBefore } = await admin
        .from('orders')
        .select('id, total_amount, customer_id')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', `${suffix}-a`)
        .maybeSingle();
      expect(firstOrderBefore?.total_amount).toBe(5000);

      // Migration injectée EN COURS DE BOUCLE, sans jamais recréer `admin`.
      await applySql(MIGRATION_0120_SQL);

      // Commande 2, traitée APRÈS la migration, avec le MÊME client — doit réussir dès ce
      // premier appel post-migration (même invariant que le test précédent).
      const secondResult = await persistShopifyOrder({
        merchantAccountId,
        orderNode: makeOrderNode(`${suffix}-b`),
        shopId: shop.id,
        supabaseServiceClient: admin,
      });
      expect(secondResult.ok).toBe(true);

      // La commande 1 n'a subi AUCUNE double écriture / mutation causée par le traitement de la
      // commande 2 ou par la migration elle-même (hors nullification des colonnes PCD faite par
      // la migration sur `customer`, qui ne touche jamais `orders`).
      const { data: firstOrderAfter } = await admin
        .from('orders')
        .select('id, total_amount, customer_id')
        .eq('merchant_account_id', merchantAccountId)
        .eq('shopify_order_id', `${suffix}-a`)
        .maybeSingle();
      expect(firstOrderAfter?.id).toBe(firstOrderBefore?.id);
      expect(firstOrderAfter?.total_amount).toBe(5000);
      expect(firstOrderAfter?.customer_id).toBe(firstOrderBefore?.customer_id);

      const { data: allOrdersForShop } = await admin
        .from('orders')
        .select('id')
        .eq('merchant_account_id', merchantAccountId);
      // Exactement 2 commandes créées par ce test — aucun doublon.
      expect(allOrdersForShop?.length).toBe(2);
    },
    30000,
  );
});
