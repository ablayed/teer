# T1 — analyse prioritaire, avant corrections

Source : pnpm audit --prod du lockfile après S0 4cb81a5, puis lecture des 18 notices primaires par l'API GitHub Advisory. Les identifiants, plages corrigées et tous les chemins exacts avant changement sont conservés dans [dependency-alerts.json](./dependency-alerts.json). Les données primaires détaillées et chemins pnpm why restent dans les artefacts locaux de security-audit-proofs (`docs/security/evidence/s2-t1-*`). La version S0 48ea636 n'a changé que les tests depuis ce relevé. Aucun avis n'est déclaré non atteignable sur la seule absence d'un import applicatif.

| GHSA (préfixe GHSA-) | CVE | Paquet installé | Chemin consommateur principal | Contexte / prérequis | État actuel | Cible corrigée |
|---|---|---|---|---|---|---|
| 3jxr-9vmj-r5cp | 2026-13149 | brace-expansion 5.0.6 | Sentry 10.76.2 → bundler-plugins → glob 13.0.6 → minimatch 10.2.5 → brace-expansion | build ; motif hostile arrivant à expand | indéterminé | 5.0.11, patch |
| mh99-v99m-4gvg | 2026-14257 | idem | idem | build ; expansion de longueur non bornée | indéterminé | 5.0.11 |
| rgw5-rvv9-x895 | 2026-69152 | idem | idem | build ; tableaux intermédiaires non bornés | indéterminé | 5.0.11 |
| qhr7-859c-m2p7 | 2026-102278 | idem | idem | build ; imbrication récursive | indéterminé | 5.0.11 |
| 6j4f-fj2g-mc7p | 2026-102276 | idem | idem | build ; récursion parseCommaParts | indéterminé | 5.0.11 |
| v2hh-gcrm-f6hx | 2026-16221 | fast-uri 3.1.2 | Sentry → bundler-plugins/webpack 5.107.2 → schema-utils 4.3.3 → ajv 8.20.0 → fast-uri | build/config ; désaccord de parsing exploité comme politique de destination | indéterminé | 3.1.7, patch |
| 7p8r-x3mc-p8w7 | 2026-18446 | idem | idem | autorité avec antislash ; sortie réinterprétée par URL/fetch | indéterminé | 3.1.7 |
| f65p-4m7j-42xc | 2026-75975 | idem | idem | IPv6 malformé normalisé puis utilisé comme destination | indéterminé | 3.1.7 |
| fph4-wmhf-6fwf | 2026-75899 | idem | idem | double décodage du hostname | indéterminé | 3.1.7 |
| jqff-g426-hqxp | 2026-76172 | idem | idem | schéma encodé introduisant une structure d'autorité/en-tête | indéterminé | 3.1.7 |
| 4c8g-83qw-93j6 | 2026-13676 | idem | idem | hôte Unicode interprété différemment par le consommateur | indéterminé | 3.1.7 |
| qw65-cvwx-89v3 | 2026-84292 | idem | idem | port non fiable passé à une forme objet de serialize/normalize | indéterminé | 3.1.7 |
| c83g-rgw3-j3cx | 2026-73089 | browserslist 4.28.2 | Sentry → bundler-plugins → Babel 7.29.7 → helper-compilation-targets → browserslist ; aussi webpack et styled-jsx (tous chemins JSON) | build ; nombreuses requêtes de ciblage distinctes contrôlables | indéterminé | 4.28.7, patch |
| 73wf-gq98-2v4g | 2026-73088 | idem | idem | build ; stats JSON hostile découvert sur disque ou fourni comme option | indéterminé | 4.28.7 |
| 68fv-2mgg-jv7q | 2026-93749 | source-map-js 1.2.1 | Next 16.4.6 → postcss 8.5.23 → source-map-js | build CSS ; source map indexée hostile et offsets excessifs | indéterminé | 1.2.2, patch |
| cg2g-xh64-v4q7 (critique) | non attribué | dompurify 3.4.7 | lib/analytics/posthog.ts → posthog-js 1.376.3 → product-tours-utils.getStepHtml → sanitize | navigateur production ; SAFE_FOR_TEMPLATES + mode DOM/IN_PLACE + shadow root et réinterprétation template | indéterminé, conditions absentes du consommateur trouvé mais couverture complète des bundles non établie | 3.4.17, patch |
| mrv2-3pqr-j5jr | non attribué | dompurify 3.4.7 | idem | navigateur ; IN_PLACE et hook détachant un autre nœud | indéterminé, modes/hooks absents du consommateur trouvé | 3.4.17 |
| mrhx-c7xc-m3w5 | 2023-54404 | zod 3.25.76 | dépendance directe → schémas Server Actions ; aussi peers ai/provider-utils/groq | production ; collection contrôlée par l'appelant, accumulation d'erreurs sans borne suffisante | indéterminé ; validation Zod atteinte, épuisement de ressources non reproduit | avis : 4.6.6, changement majeur non autorisé par T1 |

## Ce qui est effectivement tracé

`lib/analytics/posthog.ts:50` initialise PostHog dans le navigateur. Dans le paquet installé, `lib/src/extensions/product-tours/product-tours-utils.js:318` passe step.contentHtml à sanitize avec ADD_TAGS et ADD_ATTR, sans les modes particuliers des deux avis prioritaires. Ce n'est pas une preuve suffisante d'absence dans tous les bundles chargés ou configurations distantes ; les deux avis restent donc indéterminés. Ne pas remplacer ce constat par « aucun appel trouvé ».

Sentry est enveloppé dans `next.config.mjs`, et les dépendances glob/webpack/AJV/Babel sont utilisées pour la configuration et le build. Le graphe pnpm --prod n'est pas une preuve d'exécution en réponse à une requête utilisateur. La provenance des motifs, stats et sourcemaps, ainsi que les autres consommateurs transitifs, doit être tracée avant un verdict d'inatteignabilité. Les mises à jour patch réduisent néanmoins l'exposition à ces défauts connus, y compris en CI.

Zod : le chemin de validation est applicatif. Le corps des Server Actions est borné par Next, mais cela ne prouve pas à lui seul une limite de mémoire adéquate ; certains schémas contiennent des collections. Aucune charge d'épuisement n'est exécutée. Une migration vers Zod 4 ne relève pas de l'autorisation patch/mineure et peut casser les imports, types et adaptateurs next-safe-action/AI.

## Correctifs compatibles effectués localement

Les cinq transitives sont verrouillées aux versions patch corrigées ci-dessus par overrides limités à leur major existant. brace-expansion 2.1.1 reste inchangé ; seul le major 5 est ciblé. Les versions cibles ont été vérifiées dans le registry. Aucun test existant modifié. Browserslist entraîne aussi des données de ciblage compatibles : baseline-browser-mapping 2.11.35, caniuse-lite 1.0.30001826, electron-to-chromium 1.5.481 et node-releases 2.0.63. Les changements restent patch/mineurs et répondent aux nouvelles plages de Browserslist. Risques : limites nouvelles des motifs glob, canonicalisation URI, variations CSS/sourcemaps, ciblage navigateurs et sanitization des visites guidées. La version minimale d'un avis peut différer de la cible cumulative qui corrige tous les avis du paquet.

Validation locale : audit --prod passe de 40 alertes (1 critique,17 hautes,13 moyennes,9 basses) à 17 (0 critique,1 haute,12 moyennes,4 basses). L'alerte haute restante est Zod. Typage, lint (six avertissements), 2060 tests unitaires réussis/3 ignorés préexistants, build, 812 tests RLS, baseline ACL et inventaire service-role réussis. Le stack a été remis à zéro puis Kong redémarré avant la suite. Les logs sont conservés dans les artefacts locaux `s2-t1-*`. La version affectée de chacun des 17 avis prioritaires ciblés est remplacée ; l'atteignabilité antérieure n'est pas déclarée prouvée. Les tests E2E/visuels et deux CI initiales sur le SHA final restent requis avant fusion.

État : correctif local prêt à publier en PR séparée sur la base S0 fusionnée 05f65e9 ; aucune fusion T1 à ce stade. Le rattachement a vérifié l'identité du contenu entre le SHA S0 testé et son squash avant de préserver les seuls changements T1. Les avis ont été consultés le 11 novembre 2026 ; leurs dates de publication/mise à jour précises sont conservées dans les données primaires locales. Les changements sont réversibles par retrait du commit et réinstallation du lockfile antérieur ; cela réintroduirait les versions concernées et exige donc une évaluation de risque. Zod 4 reste un lot majeur soumis à approbation, aucune garantie générale de sécurité n'est annoncée.
