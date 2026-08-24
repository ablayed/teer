// Phase 2 / Lot 4B — classification à trois catégories entre l'ACL LIVE de
// production et les baselines (versionnée + courante). Pure, sans I/O : testée
// sans base de données (tests/unit/security/acl-classify.test.ts).
//
// Voir CLAUDE.md, section "Lot 4B — Sonde ACL production", pour la table de
// classification et sa justification. Résumé :
//
//   | Situation                                                | Verdict            |
//   |-----------------------------------------------------------|---------------------|
//   | Objet des deux côtés, ACL divergente À VERSION ÉGALE       | ÉCHEC (drift)        |
//   | Objet dans la baseline COURANTE, absent en production,     | rapporté,            |
//   |   ET absent aussi de la baseline DE SA VERSION              non bloquant        |
//   | Objet dans la baseline courante, absent en production,     | ÉCHEC (non expliqué  |
//   |   mais PRÉSENT dans la baseline de sa version                 par un retard)    |
//   | Objet en production, absent de la baseline de sa version   | ÉCHEC (incident 0141)|
//
// Les champs comparés pour une entrée "fonction"/"table" excluent volontairement
// tout champ qui n'est pas un fait d'ACL/sécurité (aucun champ de ce genre n'existe
// aujourd'hui dans la forme produite par acl-snapshot.mjs — chaque champ EST un
// fait d'ACL/sécurité), donc la comparaison porte sur l'objet entier moins `key`.

function indexByKey(entries) {
  const map = new Map();
  for (const entry of entries) {
    map.set(entry.key, entry);
  }
  return map;
}

function diffFields(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'key') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push({ field: key, production: a[key], expected: b[key] });
    }
  }
  return diffs;
}

/**
 * @param {object} params
 * @param {Array<object>} params.productionObjects - mesure LIVE (fonctions ou tables), production
 * @param {Array<object>} params.versionedBaselineObjects - baseline à la version réellement déployée en production
 * @param {Array<object>} params.currentBaselineObjects - baseline courante du dépôt (committée)
 * @param {string} params.objectLabel - 'function' | 'table', pour le message
 * @returns {{ failures: Array<object>, pendingDeploy: Array<object> }}
 */
export function classifyAclObjects({
  productionObjects,
  versionedBaselineObjects,
  currentBaselineObjects,
  objectLabel,
}) {
  const failures = [];
  const pendingDeploy = [];

  const production = indexByKey(productionObjects);
  const versioned = indexByKey(versionedBaselineObjects);
  const current = indexByKey(currentBaselineObjects);

  // Catégorie 1 et 3 : tout ce qui existe en production.
  for (const [key, prodEntry] of production) {
    const versionedEntry = versioned.get(key);
    if (!versionedEntry) {
      // Catégorie 3 : objet en production, absent de la baseline de sa propre
      // version — forme exacte de l'incident 0141 (dérive hors migration).
      failures.push({
        category: 'unexplained_production_object',
        objectType: objectLabel,
        key,
        detail:
          'présent en production, absent de la baseline correspondant à la version de production déployée',
      });
      continue;
    }
    const diffs = diffFields(prodEntry, versionedEntry);
    if (diffs.length > 0) {
      // Catégorie 1 : ACL divergente à version égale.
      failures.push({
        category: 'acl_drift_at_matched_version',
        objectType: objectLabel,
        key,
        diffs,
      });
    }
  }

  // Catégorie 2 : tout ce que la baseline courante attend mais que la production
  // n'a pas. Doit être expliqué par une migration non déployée (absent aussi de
  // la baseline versionnée) — sinon c'est une régression réelle, pas un retard.
  for (const [key, currentEntry] of current) {
    if (production.has(key)) continue;
    const explainedByPendingMigration = !versioned.has(key);
    if (explainedByPendingMigration) {
      pendingDeploy.push({
        objectType: objectLabel,
        key,
        detail:
          'absent en production ET absent de la baseline de sa version — migration non déployée',
      });
    } else {
      failures.push({
        category: 'missing_in_production_unexplained',
        objectType: objectLabel,
        key,
        detail:
          'absent en production mais présent dans la baseline de la version réellement déployée — aucune migration non déployée ne l’explique',
        entry: currentEntry,
      });
    }
  }

  return { failures, pendingDeploy };
}

/**
 * Combine fonctions et tables. Lève si un des trois inventaires d'entrée est
 * vide sur `functions` ET `tables` simultanément — un inventaire totalement
 * vide (0 fonction ET 0 table) ne doit jamais passer silencieusement : c'est
 * la signature d'une connexion qui n'a rien pu lire, pas d'un schéma vide.
 */
export function classifyAclSnapshot({ production, versionedBaseline, currentBaseline }) {
  if ((production.functions?.length ?? 0) === 0 && (production.tables?.length ?? 0) === 0) {
    throw new Error(
      'Inventaire de production vide (0 fonction ET 0 table) — refusé : soit la connexion n’a rien pu lire, soit les schémas surveillés sont réellement vides, dans les deux cas ce n’est jamais un succès silencieux.',
    );
  }

  const functionsResult = classifyAclObjects({
    productionObjects: production.functions,
    versionedBaselineObjects: versionedBaseline.functions,
    currentBaselineObjects: currentBaseline.functions,
    objectLabel: 'function',
  });
  const tablesResult = classifyAclObjects({
    productionObjects: production.tables,
    versionedBaselineObjects: versionedBaseline.tables,
    currentBaselineObjects: currentBaseline.tables,
    objectLabel: 'table',
  });

  return {
    failures: [...functionsResult.failures, ...tablesResult.failures],
    pendingDeploy: [...functionsResult.pendingDeploy, ...tablesResult.pendingDeploy],
  };
}

/**
 * Invariant absolu (Couche 1 de 4A, réappliqué en production) — indépendant de
 * toute baseline/version. `functions` est la mesure LIVE de production, dans la
 * forme produite par acl-snapshot.mjs (`key`, `name`, `returnType`, `anonExec`,
 * `authenticatedExec`). Logique alignée terme à terme sur
 * tests/rls/function-execute-acl-invariant.rls.test.ts (Couche 1 originale,
 * exécutée sur le stack LOCAL) — mêmes deux assertions, ici rejouées contre la
 * production réelle :
 *   1. aucune fonction exposée exécutable par anon, hors liste blanche nommée,
 *      trigger functions exclues (has_function_privilege renvoie toujours true
 *      pour elles, PostgreSQL refuse structurellement leur invocation directe —
 *      prouvé, cf. commentaire du test original) ;
 *   2. les fonctions confirmées service_role-only (par NOM, une fonction peut
 *      être surchargée) ne sont jamais exécutables par authenticated.
 */
export function checkAbsoluteInvariant({
  functions,
  knownAnonExecuteExceptions,
  serviceRoleOnlyNames,
}) {
  const violations = [];
  const exceptions = new Set(knownAnonExecuteExceptions ?? []);
  const serviceOnlyNames = new Set(serviceRoleOnlyNames ?? []);

  for (const fn of functions) {
    if (fn.anonExec && fn.returnType !== 'trigger' && !exceptions.has(fn.key)) {
      violations.push({
        category: 'anon_executable',
        key: fn.key,
        detail: 'fonction exécutable par anon, hors liste blanche nommée',
      });
    }
  }

  for (const name of serviceOnlyNames) {
    const matches = functions.filter((fn) => fn.name === name);
    if (matches.length === 0) {
      violations.push({
        category: 'service_role_only_function_missing',
        key: name,
        detail: 'introuvable dans les schémas surveillés (renommée/supprimée ?)',
      });
      continue;
    }
    for (const fn of matches) {
      if (fn.authenticatedExec) {
        violations.push({
          category: 'service_role_only_executable_by_authenticated',
          key: fn.key,
          detail: 'fonction confirmée service_role-only, mais exécutable par authenticated',
        });
      }
    }
  }

  return violations;
}
