---
name: batch-workflow
description: >
  Tëër end-of-batch shipping workflow. Use whenever finishing a batch/deliverable,
  preparing a commit, opening a PR, or when asked to "ship", "merge", "finir le lot",
  or close out work. Enforces the branch→PR→CI→squash-merge discipline.
---

# Workflow de fin de lot (Tëër)

NE JAMAIS commit directement sur main pour du code ou une migration. Seuls les commits doc-only purs peuvent parfois aller direct sur main.

## Séquence obligatoire

1. **Branche dédiée + PR + CI + squash-merge.** Toujours une branche, jamais de commit direct sur main pour code/migration.
2. **Un commit par livrable.** Message en français, préfixé. La migration ET le code qui en dépend vont dans le MÊME commit (indivisible — jamais séparés).
3. **Sanity loop AVANT chaque commit** (tout doit passer, RLS non-skippé) :
   `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm build`
   Les tests RLS ne sont jamais skippés.
4. **CI 3 cibles = seul juge E2E** : chromium + pixel-7 + iphone-14. Jamais marquer "Done" sur un succès local seul.
5. **Commit final du lot** : inclure le bloc Phase tracker dans `CLAUDE.md` (ou `AGENTS.md` si c'est la source) ET corriger la ligne « Latest applied migration » au passage (ex. 0050→0057 déjà fait ; prochain 0072→0074).
6. **PR verte et mergée avant d'enchaîner le lot suivant.** Arbre propre obligatoire — ne jamais changer d'agent sur un arbre sale.

## Garde-fous
- Si l'arbre git n'est pas propre, NE PAS commencer un nouveau lot — finir/merger d'abord.
- Si la sanity loop échoue, corriger avant de commit — jamais commit "à corriger après".
- Rappel migration : écrire le fichier de migration et S'ARRÊTER (voir teer-migration skill) — la migration et son code partagent le commit, mais l'application (`pnpm exec supabase db push`) reste manuelle.
