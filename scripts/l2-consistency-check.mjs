#!/usr/bin/env node
// Phase 2 / Lot L2, mis à jour Verrou 0 — contrôle de cohérence entre webhook_event (autoritaire
// en lecture, Phase 2) et ingestion_event (registre L1/L2, alimenté en parallèle).
//
// PAS un comptage : une jointure par identité de livraison (webhook_event.shopify_webhook_id ↔
// ingestion_event.delivery_id), comparant topic / connexion+tenant+boutique / statut / id de
// commande externe / orders.store_connection_id. Les écarts sont listés ligne par ligne, avec le
// champ divergent nommé et les deux valeurs — jamais un "écart nul" global.
//
// ── Ce que CE script prouve, et ce qu'il NE prouve PAS (clarification demandée en revue, Verrou 0)
// Ce script mesure l'ÉCART entre les deux représentations d'un même événement (webhook_event vs
// ingestion_event) — il n'ATTESTE PAS laquelle des deux fait autorité. Que webhook_event reste la
// table autoritaire en lecture est une DÉCISION produit de Phase 2 (documentée dans CLAUDE.md,
// « Voie A »), indépendante de ce script : un écart nul ici ne prouve pas que webhook_event est
// correct, seulement que les deux tables s'accordent. Ne jamais lire un « PASS » comme une preuve
// d'autorité — seulement comme une preuve de cohérence entre les deux vues.
//
// ── Depuis le Verrou 0 (lib/shopify/webhook-core.ts), les DEUX endpoints webhook (legacy ET URL
// opaque) écrivent désormais webhook_event ET ingestion_event de façon identique — le cœur
// partagé appelle recordWebhookReceipt (webhook_event) pour les deux chemins. Ce script reste
// donc pleinement significatif aujourd'hui, y compris pour le trafic de test sur l'endpoint
// opaque (aucun abonnement Shopify réel ne le cible encore).
//
// ── Limite POST-BASCULE (Phase 2 — Clôture, runbook
// docs/security/webhook-subscription-bascule-runbook.md), qui reste EXACTE : ce document nommait
// une limite qui s'active seulement quand des abonnements Shopify RÉELS basculent vers l'URL
// opaque (Temps 1 du runbook, pas encore fait) ET que le Temps 2 (refus des topics opérationnels
// sur l'ancien endpoint) est franchi — à partir de là, plus aucune NOUVELLE ligne webhook_event
// n'arrive pour les 9 topics opérationnels sur le chemin qui reste actif (l'URL opaque écrit
// pourtant bien webhook_event, mais legacy — la seule source que ce script attendait pour ces
// topics avant la bascule réelle — n'en reçoit plus). Un « PASS » lu vite à ce moment-là serait
// trompeur pour la même raison qu'avant : `diffs.length === 0` resterait vrai non pas parce que
// tout concorde, mais parce qu'il n'y a plus rien de NOUVEAU à joindre depuis ce sens de jointure.
// La section « post-bascule » de la sortie ci-dessous rend ce fait visible à chaque exécution
// plutôt que de le laisser implicite : un compte croissant y est ATTENDU et NORMAL après le
// Temps 1 réel, jamais un signal d'échec. Ce script reste pleinement significatif pour
// l'historique et pour les 3 topics de conformité GDPR, qui continuent d'alimenter webhook_event
// indéfiniment (jamais souscriptibles via l'Admin API, cf. runbook).
//
// Usage : node scripts/l2-consistency-check.mjs
// Nécessite NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (local ou linked, en lecture
// seule — ce script n'écrit rien).

import { createClient } from '@supabase/supabase-js';
import { ADMIN_API_TOPICS } from './lib/webhook-subscription-plan.mjs';

const OPERATIONAL_TOPICS = new Set(ADMIN_API_TOPICS.map((t) => t.rest));

function log(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI de diagnostic, sa sortie EST le livrable.
  console.log(...args);
}

function logError(...args) {
  // biome-ignore lint/suspicious/noConsole: script CLI de diagnostic, sa sortie EST le livrable.
  console.error(...args);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  logError(
    'l2-consistency-check: NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis.',
  );
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function fetchAll(table, select) {
  const rows = [];
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await admin
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1);
    if (error) {
      throw new Error(`${table}: ${error.message}`);
    }
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function main() {
  const [webhookEvents, ingestionEvents, orders] = await Promise.all([
    fetchAll('webhook_event', 'shopify_webhook_id, topic, status, merchant_account_id, shop_id'),
    fetchAll(
      'ingestion_event',
      'delivery_id, topic, status, merchant_account_id, shop_id, store_connection_id, resource_kind, resource_external_id',
    ),
    fetchAll('orders', 'id, shopify_order_id, store_connection_id'),
  ]);

  const ingestionByDelivery = new Map(ingestionEvents.map((row) => [row.delivery_id, row]));
  const orderByShopifyId = new Map(
    orders.filter((o) => o.shopify_order_id).map((o) => [o.shopify_order_id, o]),
  );

  const diffs = [];
  let joined = 0;
  let notYetMirrored = 0;

  for (const we of webhookEvents) {
    const deliveryId = we.shopify_webhook_id;
    const ie = ingestionByDelivery.get(deliveryId);

    if (!ie) {
      // Attendu pour toute ligne antérieure au lot (backfill 0142, jamais rejoué en continu) et
      // pour tout événement dont la boutique n'a jamais eu de store_connection résolvable
      // (dual-write silencieusement refusé — comportement voulu, cf. rapport).
      notYetMirrored += 1;
      continue;
    }
    joined += 1;

    if (we.topic !== ie.topic) {
      diffs.push({ deliveryId, field: 'topic', webhookEvent: we.topic, ingestionEvent: ie.topic });
    }
    if (we.merchant_account_id !== ie.merchant_account_id) {
      diffs.push({
        deliveryId,
        field: 'merchant_account_id',
        webhookEvent: we.merchant_account_id,
        ingestionEvent: ie.merchant_account_id,
      });
    }
    if (we.shop_id !== ie.shop_id) {
      diffs.push({
        deliveryId,
        field: 'shop_id',
        webhookEvent: we.shop_id,
        ingestionEvent: ie.shop_id,
      });
    }
    // ingestion_event.status suit un cycle de vie strictement plus restreint (0142 :
    // processing/retryable/terminal/done) que webhook_event mais les deux doivent converger vers
    // le même verdict final (done/terminal) une fois traités — comparé seulement quand les deux
    // sont dans un état terminal.
    const terminalStates = new Set(['done', 'terminal']);
    if (terminalStates.has(we.status) && terminalStates.has(ie.status) && we.status !== ie.status) {
      diffs.push({
        deliveryId,
        field: 'status',
        webhookEvent: we.status,
        ingestionEvent: ie.status,
      });
    }

    if (ie.resource_kind === 'order' && ie.resource_external_id) {
      const order = orderByShopifyId.get(ie.resource_external_id);
      if (order && order.store_connection_id !== ie.store_connection_id) {
        diffs.push({
          deliveryId,
          field: 'orders.store_connection_id vs ingestion_event.store_connection_id',
          webhookEvent: order.store_connection_id,
          ingestionEvent: ie.store_connection_id,
        });
      }
    }
  }

  log(`l2-consistency-check: webhook_event=${webhookEvents.length} lignes.`);
  log(`l2-consistency-check: ingestion_event=${ingestionEvents.length} lignes.`);
  log(
    `l2-consistency-check: ${joined} lignes jointes par delivery_id, ${notYetMirrored} non miroitées (attendu : historique pré-lot ou connexion refusée).`,
  );

  // Post-bascule : lignes ingestion_event de topics OPÉRATIONNELS sans AUCUNE ligne webhook_event
  // correspondante. Un compte croissant ici est ATTENDU dès que le Temps 1 du runbook a eu lieu —
  // ce n'est jamais un écart, juste la preuve que ce script ne compare plus rien de nouveau pour
  // ces topics. Reporté séparément pour qu'un lecteur ne le confonde jamais avec `diffs`.
  const webhookDeliveryIds = new Set(webhookEvents.map((we) => we.shopify_webhook_id));
  const postBasculeByTopic = new Map();
  for (const ie of ingestionEvents) {
    if (!OPERATIONAL_TOPICS.has(ie.topic)) continue;
    if (ie.delivery_id && webhookDeliveryIds.has(ie.delivery_id)) continue;
    postBasculeByTopic.set(ie.topic, (postBasculeByTopic.get(ie.topic) ?? 0) + 1);
  }
  const postBasculeTotal = [...postBasculeByTopic.values()].reduce((a, b) => a + b, 0);
  if (postBasculeTotal > 0) {
    log(
      `l2-consistency-check: ${postBasculeTotal} ligne(s) ingestion_event de topics opérationnels sans webhook_event correspondant (NORMAL après le Temps 1 du runbook de bascule — ce script ne compare plus rien de nouveau pour ces topics, ce n'est PAS un écart) :`,
    );
    for (const [topic, count] of postBasculeByTopic) {
      log(`    ${topic.padEnd(28)} ${count}`);
    }
  }

  if (diffs.length === 0) {
    log('l2-consistency-check: PASS — aucun écart de champ sur les lignes jointes.');
    process.exit(0);
  }

  logError(`l2-consistency-check: ${diffs.length} écart(s) — détail par ligne :`);
  for (const d of diffs) {
    logError(
      `  delivery_id=${d.deliveryId} champ=${d.field} webhook_event=${JSON.stringify(d.webhookEvent)} ingestion_event=${JSON.stringify(d.ingestionEvent)}`,
    );
  }
  process.exit(1);
}

main().catch((error) => {
  logError('l2-consistency-check: échec', error);
  process.exit(1);
});
