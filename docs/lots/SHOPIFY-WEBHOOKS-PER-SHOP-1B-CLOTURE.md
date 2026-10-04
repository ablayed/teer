# SHOPIFY-WEBHOOKS-PER-SHOP-1B — verdict de clôture

Verdict du porteur, repris tel quel.

> **Lot clos avec réserves acceptées.**
>
> **Schéma** : `0161` (sha256 `4afe2026dfc9fd6ac6a6804362cd15969343da71fbb783664f3b52690271b200`). Push en production le 2026-10-03, après :
> - M0 : délai apparent minimum de +2,385 s sur 360 lignes, aucune anomalie détectée, **H2 non démontrée** ;
> - les relevés « avant » R0 à R6 et R1bis.
>
> Les relevés « après » sont conformes à la liste fermée des différences attendues. Le schéma a été livré sur `main` par la PR #246 (`ec3285f`). La sonde ACL est verte sur une exécution relue (`37153080896`). La fenêtre entre le push et la fusion **n'a pas été sondée** : elle pouvait produire un échec, mais aucun n'a été mesuré.
>
> **Code** : PR #247, fusionnée en squash, `main` à `364c25e`. Deux exécutions CI initiales vertes sur `401635c`, **avec trois tests passés au rejeu interne de Playwright dans la seconde**. 42 mutations, toutes rouges une fois la garde neutralisée.
>
> **G11, inventaire « avant »** (2026-10-04, outil hors dépôt, sha256 `85d4508cbdcc09cff2f80f80356791ac86606373beb3c4415f7fb3f4829faffa`) :
> - `ntmwxz-83` (GETGET SN, `teer-koba`) : 9 abonnements, tous sur `https://webhooks.teerafrik.com`, tous `true | true | current` ;
> - `teer-test` (`teer-pilote`) : 0 abonnement, pas de jeton d'URL.
>
> **Décision documentée** : `WEBHOOK_PUBLIC_BASE_URL = https://webhooks.teerafrik.com`, valeur déjà posée en Production et vérifiée.
>
> **Mesures en production sur `teer-s1-apres`, le 2026-10-04, heures locales (UTC+1)** :
> - **avant** : commande `Q1B-AVANT-2026-10-04` créée à 20:52, **absente** de Tëër à +15 min sans synchronisation, sans intervention du cron ;
> - premier clic sur « Synchroniser » : **aucun bail, aucun jeton, aucune ligne d'état**. Le déploiement qui a servi ce clic **n'a pas été identifié** ; la cause plausible, un onglet ouvert avant le déploiement, **n'est pas établie** ;
> - **après un rechargement complet**, second clic : 9 abonnements `active`, `2026-04`, sans erreur, observés à 20:33:33 UTC ;
> - **commande neuve** `Q1B-WEBHOOK-2026-10-04` créée à 21:37, **visible à 21:38** après un rechargement de page, sans synchronisation ;
> - **mise à jour** de cette commande à 21:40, **visible** sans synchronisation. **Nature exacte de la modification : `[Non vérifié]`**, non consignée au moment de la mesure.
>
> **Portée de la preuve** : le parcours mesuré, création et mise à jour de commande sur une boutique `teer-public` après réconciliation, est **validé en production**. Cela **ne démontre pas** tous les topics, toutes les boutiques, ni tous les scénarios de réparation.
>
> **Réserves acceptées**
> 1. **H1** : `X-Shopify-Triggered-At` n'est pas signé.
> 2. **H2** : l'écart d'horloge est supposé inférieur à `m`. C'est une hypothèse, non démontrée.
> 3. **Coût de la marge** (`m` = 10 s, valeur provisoire) : dans la marge, une ancienne livraison peut supprimer une attente ou désinstaller une installation nouvelle.
> 4. **G7 et D20b** : le chemin global reste résolu par l'en-tête tant que E11 n'est pas fait.
> 4 bis. **Doubles livraisons** (abonnement global et abonnement par boutique) : elles sont **couvertes par les tests automatisés W5, sous les réserves H1, H2 et de marge**. Elles **ne sont pas mesurées en production**. Aucune garantie générale d'absence d'effets répétés n'est annoncée.
> 5. La convergence après désinstallation est **incomplète** si l'écriture `store_connection` échoue.
> 6. **GETGET SN** : sans inventaire « après », « aucun changement chez le marchand » reste `[Non vérifié]`. Seul l'état « avant » est prouvé.
> 7. **Inventaire « après » de `teer-s1-apres`** non réalisé, remplacé par la preuve fonctionnelle. Les inventaires de `teer-public-smoke` et `teer-s1-apres`, avec un nettoyage éventuel, restent dus avant toute mesure qui en dépend.
> 8. **Désinstallation puis réinstallation avec le code du lot 1b** : non mesurées en production. La preuve vient des tests automatisés (W6, W7, mode de rotation). Les mesures du lot 1 ne valident pas ce nouveau chemin. La mesure est reportée à la répétition générale.
> 9. **Journaux de requêtes Vercel** : l'exposition du secret L3 n'est pas mesurée. **Ce point est dans la checklist avant soumission.**
> 10. Instabilités E2E `shop-filter:271`, `drivers:368` et `purchases:257`, ainsi que la boucle RLS locale (T12, 9B) : dette (m) et `e2e-zero-flake`.
>
> **Décision E11 (porteur, 2026-10-04) : différé après la soumission.** Les deux abonnements `app/uninstalled`, global et par boutique, sont **conservés** en attendant.
>
> **Motif** : l'abonnement global couvre les installations dont la réconciliation échoue avant de créer l'abonnement par boutique (`sync=pending`). Le retirer maintenant ouvrirait un trou de couverture.
>
> **Ce que cette décision n'est pas** : c'est une décision technique qui accepte le risque D20b. **Ce n'est pas une preuve que Shopify jugera ce choix acceptable pendant la revue.**
>
> **Critères de sortie d'E11**, à remplir dans cet ordre :
> 1. couverture vérifiée de **toutes** les boutiques actives par un abonnement `app/uninstalled` par boutique (inventaire relu) ;
> 2. traitement des installations restées en `sync=pending`, en réparant ou en démontrant la reprise par le cron ;
> 3. mesure en production du **chemin opaque** de désinstallation puis réinstallation ;
> 4. retrait de `app/uninstalled` du TOML de `teer-public`, nouvelle version d'app, puis **vérification après déploiement** (une désinstallation traitée par le seul chemin opaque).

## Checklist avant soumission

À cocher avant de soumettre `teer-public` à la revue Shopify. Aucune de ces lignes n'est faite à la date de ce document.

- [ ] **Journaux de requêtes Vercel, secret L3** (réserve 9). Mesurer si le chemin `/api/shopify/ingest/<jeton>` apparaît en clair dans les journaux de requêtes de la plateforme. Le code masque ce segment dans Sentry ; les journaux de l'hébergeur sont hors de sa portée.
- [ ] **Inventaire `teer-public`** (réserve 7). Inventorier `teer-public-smoke` et `teer-s1-apres`, avec un nettoyage éventuel, **avant** toute mesure qui dépend de leur état.
- [ ] **Désinstallation puis réinstallation avec le code du lot 1b** (réserve 8), pendant la répétition générale. Les mesures du lot 1 ne valident pas ce chemin.
- [ ] **E11 : rien à faire avant la soumission.** Il est **différé après la soumission** (décision du porteur, 2026-10-04) ; les deux abonnements `app/uninstalled` restent en place. Il ne se rouvre que par ses quatre critères de sortie, dans l'ordre :
  1. couverture vérifiée de **toutes** les boutiques actives par un abonnement `app/uninstalled` par boutique (inventaire relu) ;
  2. traitement des installations restées en `sync=pending`, en réparant ou en démontrant la reprise par le cron ;
  3. mesure en production du **chemin opaque** de désinstallation puis réinstallation ;
  4. retrait de `app/uninstalled` du TOML de `teer-public`, nouvelle version d'app, puis **vérification après déploiement** (une désinstallation traitée par le seul chemin opaque).

## Identifiants relus à l'écriture de ce document

Relus le 2026-10-04 sur GitHub. Ils complètent le verdict, ils ne le modifient pas.

| Élément | Valeur |
|---|---|
| PR #246, fusion | `ec3285f500c775f512709a312ad83763e9b0e063`, 2026-10-03 20:51:42 UTC |
| PR #247, tête | `401635ce5d5ad92bdb255cc4140ad64fafecd9d6` |
| PR #247, exécutions CI initiales | `37194614918`, `37196059557` |
| PR #247, fusion | `364c25eb41ea5c0a110ba703688d99ee4f5c5af1`, 2026-10-04 20:13:42 UTC |
| CI post-fusion sur `364c25e` | `37231290318`, conclusion `success` (conclusion relue, **sans lecture test par test**) |
| Sonde ACL citée par le verdict | `37153080896`, manuelle, `ec3285f`, 2026-10-03 20:52:12 UTC, `success` |
| Sonde ACL planifiée suivante | `37191692623`, `ec3285f`, 2026-10-04 09:17:48 UTC, `success` |

Les trois tests passés au rejeu dans `37196059557` : `tests/e2e/shop-filter.spec.ts:271` (iphone-14), `tests/e2e/drivers.spec.ts:368` (chromium), `tests/e2e/purchases.spec.ts:257` (iphone-14).

## Dossiers de preuves hors dépôt

Toutes les empreintes ci-dessous ont été **recalculées le 2026-10-04**, avant l'écriture de ce document. Aucun de ces fichiers n'est dans le dépôt.

**Mise à jour du 2026-10-04, après la fusion de la PR #248.** Sur instruction du porteur, deux fichiers du dossier de la phase 1 ont été corrigés : `README.md` (une phrase) et `SHA256SUMS.txt` (régénéré pour couvrir `prod\`). Leurs empreintes ci-dessous sont les **valeurs finales**, recalculées après la correction ; les valeurs antérieures sont conservées dans la section des écarts. Aucun autre fichier n'a changé : contrôle `sha256sum -c` conforme pour les 51 fichiers listés.

### `C:\Users\diaab\teer-preuves\2026-10-03-LOT-1B-PHASE1\`

52 fichiers : 51 listés par `SHA256SUMS.txt` (les 37 d'origine et les 14 du sous-dossier `prod\`), et `SHA256SUMS.txt` lui-même.

| Fichier | sha256 |
|---|---|
| `SHA256SUMS.txt` | `ba94922f913bf26722747cd1263c9d10215f1a328c202fb42599940fac3f3842` |

Les 37 fichiers d'origine — recalcul **conforme pour les 37** :

| Fichier | sha256 |
|---|---|
| `README.md` | `88857689327737af18c35e4a5a507b9d20c02163ecfd9bd289f7c57ab66ac41a` |
| `out\00_setup_helpers.txt` | `881d13c3c2a2ddaaa10bc1a394601fa4c44f0a5caef9e073f0a0b807ddfa144d` |
| `out\01_scenarios_P1a_P14.txt` | `5262c6f4f0f786bdfba1f8c8e108c68d6bf9116a42d6ef507a7980b618f75755` |
| `out\02_P10_reconcile_lease.txt` | `bc0c35b9de0fc24b9bacdff9937b3cbc0922db70d151978b2e0b7417709f4192` |
| `out\03_P15_other_app.txt` | `35406ca3d8480b1e31cb9ffee2ffcdc7e59a3f4508dd8280bed06a40e3687663` |
| `out\04_P1c.txt` | `55499d3d6b955d7d28014ee96dc99981d551c3b18c2b3006d3916988a6baeee2` |
| `out\10_catalog.txt` | `2f104f13854231f7e53f438c0b0d1d448f22f305d2116c54aeb2ff8a32af17d5` |
| `out\11_catalog_primitive.txt` | `445d2546b39de11acc5309aa54903fbb4ac105cba197a3149aedc572fbbc21f9` |
| `out\12_hash_avant_apres.txt` | `7caddc7dc560916af0339916820fa293f703b3574eaceec03ae222e0fd3ba351` |
| `out\20_releves_apres_local.txt` | `1684cce40b6c17b1f5be3c2c456a4faccb430bca5c2fc4d845583f5aeb6e1ede` |
| `out\21_R1bis_apres_local.txt` | `f27c8d568d4c91933d3a0d95cbfec90538e148eb96d708b4cf8f6037dbc10d93` |
| `out\30_run1_passerelle.txt` | `a886485a83337419b2cf5596cb3e497a079378a7418fe9a928440a308473f52f` |
| `out\31_run3_passerelle.txt` | `0f2abe765cdd7b5730b113f2036badd130f866b26efa360485045df1a3bbc9e5` |
| `out\p1c_connexion_a.out` | `5bec41dfbd4d3c2995421d034630b2b2e957bf2f7986c40bf98e2ebfa93701b6` |
| `out\p1c_connexion_a.sql` | `d082bb4d412bf066effccc316464fc6bee4add935d0e052efd535da975f60f80` |
| `out\p1c_connexion_b.out` | `5bec41dfbd4d3c2995421d034630b2b2e957bf2f7986c40bf98e2ebfa93701b6` |
| `out\p1c_connexion_b.sql` | `f7d314616569551a40dc5d113c2b863277abdac59ba8d5a5250641143ae6af5d` |
| `rls\rls.run1.json` | `d174b9d2ae2ce393906a68601c49f92d08a75b92934a19b704a1f7b6cb9162b2` |
| `rls\rls.run1.log` | `860da149dfe620789277ce7cc4c7804fc4b0b73c941ff52ff3d1bbae09131b8d` |
| `rls\rls.run2.json` | `0453e36ca5e564abb9cf2ac876da20f0bc06c125c3194207be5e272161f73243` |
| `rls\rls.run2.log` | `77458f8fdc8c6d150db28b6e50ec8029069f45fd1bf5a8b9ad6f9460647be670` |
| `rls\rls.run3.json` | `c569dee6c561f4776056e7a5737c29094a85dc874e8e90970ae634a7c8dd136b` |
| `rls\rls.run3.log` | `48274fde7eb91ca15151b297a4e5b4585f3053eb63126bd4eb7e1c1550e408c6` |
| `rls\rls.run4.json` | `6f050f33ff185e508c0367b0bc7eed3ce65b64050fd2a462c1df39c0a7dc6af7` |
| `rls\rls.run4.log` | `1d76b835be32859fad4689f87b18da0832d3e00176cfe5313ae049cc0db4a06d` |
| `sql\00_setup_helpers.sql` | `0b03532e80d79931e148ef2eb75ef8c8266a033a73e738ac898b316babc1ebac` |
| `sql\01_scenarios_P1a_P14.sql` | `03722d472b25e933ce19b21a117889074d595b0daabc78820308b65a0ac7ae42` |
| `sql\02_P10_reconcile_lease.sql` | `26e984f6c2189bb21dfe6e8107c36231e532159aaf2e198a63856370c8d47518` |
| `sql\03_P15_other_app.sql` | `c13016d777787256b77a9fabad92d73d7021cad09b7ca8198e8dc0e921a924fd` |
| `sql\04_P1c_report.sql` | `37b8ac349e3d0cd8f3adc013473f8c5eeb42fe04f3413d44bf09c8e7fa596b65` |
| `sql\04_P1c_run.sh` | `83f2aaeaf7f70aaac59196634d3eace0d86723d75208d967e1901a12fd453476` |
| `sql\04_P1c_setup.sql` | `58664a52cff191bdf15d95d415406601d553d0751943ba54df163a0f1c54001b` |
| `sql\10_catalog.sql` | `4d266a722effb075816419bd2fb6653f2accc9bba6bc2b17a711c286c215025f` |
| `sql\11_catalog_primitive.sql` | `5ceae75967197e417cc99d30fb8fb4ee3c0c6b7ab7d7c0628c020f436d8092cb` |
| `sql\12_hash_avant_apres.sql` | `9dc5116d7ef4a998a211174c0657afa8646440c535adf6aa1f5bb104ea4a70ba` |
| `sql\20_releves_production_R0_R6.sql` | `b9e1cdb3518ce941a3bd8d3e3b20cf9a9040038d8dba25dce8242d697c49da3e` |
| `sql\21_releve_production_R1bis.sql` | `f72318674e1ac66438f509a43e89521d111f9ae58843420d6380e082ba941106` |

Les 14 fichiers du sous-dossier `prod\` — relevés de production, **transcriptions et non exports bruts** (`prod\README_prod.md`) ; couverts par `SHA256SUMS.txt` depuis sa régénération du 2026-10-04 :

| Fichier | sha256 |
|---|---|
| `prod\README_prod.md` | `c63b8b51aed29febf4fe4864774e55430938d43b805a65fe8c16eeedc0fee3af` |
| `prod\R0_M0.json` | `1a1c3aa3bee3705f5faf090424284a8c99f6760ebeaefae52719fa6f423d8329` |
| `prod\R1_avant.json` | `517a764a6f01ff93f5d9af298118cd11844961e339a5d8d95233d90bd96a86b6` |
| `prod\R1_apres.json` | `24762fb20a97358312894666c365b9f7159596696a4146d5acc92ca867932486` |
| `prod\R2_avant.json` | `b88d1e0bbc335a664d640bf2e5df3adc9a3ec7ddf60bddd7507ebadb48791bc5` |
| `prod\R2_apres.json` | `bdeae2723f77e485736c0173d4fb807512c52c77be0a66c089c8fa10c977521b` |
| `prod\R3_avant.json` | `a3306f79dd74955f0e069c77878f55c68f2ddcd759e22bf5669f494fe2ed8c27` |
| `prod\R3_apres.json` | `5c38493232dca5c480b2b8e5b4c2df527981f425a028c51a567bcc6b4c551f15` |
| `prod\R4_avant.json` | `94efc7808c992677ff8d41259c71332bf4e34d98810f9070b0414035ff2da09b` |
| `prod\R4_apres.json` | `c7841523cbcbfa4fdb8418f7336ca94e5be917897b13ae2b154b6986480e6b15` |
| `prod\R5_avant.json` | `fb21a3a390b2bc43ef71ccd2d6b8b13857015e69881b52b0ae2cc4fa0251ac56` |
| `prod\R5_apres.json` | `fb21a3a390b2bc43ef71ccd2d6b8b13857015e69881b52b0ae2cc4fa0251ac56` |
| `prod\R6_avant.json` | `330ecc694e378d2faa44bb94039fce2d5ed88eafddc972b107c3803b3d66d7a8` |
| `prod\R6_apres.json` | `828f6c1ea43ab9d5f2bed7eaf4836ed58052c4ddfac3f180601af0b6397d6dbe` |

### `C:\Users\diaab\teer-preuves\2026-10-04-LOT-1B-G11\`

3 fichiers : l'outil et ses deux sorties. Aucun fichier d'empreintes dans ce dossier.

| Fichier | sha256 |
|---|---|
| `g11-inventory.mjs` | `85d4508cbdcc09cff2f80f80356791ac86606373beb3c4415f7fb3f4829faffa` |
| `ntmwxz-83.myshopify.com.txt` | `d57ca42c4208399d94dd2a7a71f6a5e108ede9c73bb5b00f5ebb8e26910c8dc6` |
| `teer-test.myshopify.com.txt` | `9a646d96fd71358c0fa4068e38c28e4401b699e23d6649e92eb4a2a4b06bf659` |

Relus dans les deux sorties, datées du 2026-10-04 à 19:47 UTC : 9 abonnements pour `ntmwxz-83`, tous sur l'origine `https://webhooks.teerafrik.com`, version `2026-04`, classés `true | true | current` ; 0 abonnement et aucun jeton d'URL local pour `teer-test`. Les sorties ne portent ni chemin opaque, ni secret, ni `uri` complète.

## Écarts constatés et signalés

1. **Le sous-dossier `prod\` n'existait pas** à l'ouverture de ce lot documentaire. Le porteur a déposé ses fichiers dans son dossier de téléchargements le 2026-10-04 ; ils ont été **copiés** dans `prod\`, et la copie a été comparée à l'original, empreinte par empreinte : identique. **Les originaux ne sont plus dans le dossier de téléchargements** à la fin de ce lot : `prod\` est désormais le seul exemplaire connu de ces pièces.
2. **14 fichiers et non 15.** Le porteur en annonçait 15 ; le dépôt en compte 14, soit exactement le contenu de l'archive `files.zip` déposée avec eux (sha256 `558742ef5629aaa22e69d61bb63e87e65523cef9e303c151d10901def573dc17`, 14 entrées aux empreintes identiques). Cette archive **n'a pas été conservée** : elle n'est plus dans le dossier de téléchargements, et son empreinte, relevée une fois, ne peut plus être recalculée.
3. **RÉSOLU le 2026-10-04 — `SHA256SUMS.txt` ne couvrait pas `prod\`.** À la rédaction, il listait 37 fichiers (sha256 `cab6ec6fb74490424e803cb984f4ee1a03776d67f26738be1e9ca3620db0436d`). Régénéré après la fusion de la PR #248, au même format et dans le même ordre : il liste désormais 51 fichiers, dont les 14 de `prod\` (sha256 `ba94922f913bf26722747cd1263c9d10215f1a328c202fb42599940fac3f3842`). L'ancienne version n'a pas été conservée ; ses 37 lignes sont reprises à l'identique dans la nouvelle, sauf celle de `README.md`.
4. **RÉSOLU le 2026-10-04 — `README.md` du dossier disait « Rien ici n'a été mesuré en production »**, ce qui n'était plus vrai du sous-dossier `prod\`. Cette phrase, et elle seule, a été remplacée : le fichier dit maintenant que `prod\` contient des **transcriptions de relevés de production, et non des exports bruts**, le reste du dossier étant local. Empreinte avant : `6eb47f1b943744418740ced4b52dbc62360b2046a00314ac932f1615ad28da82` ; après : `88857689327737af18c35e4a5a507b9d20c02163ecfd9bd289f7c57ab66ac41a`. **L'ancienne version du fichier n'a pas été conservée** : son empreinte ne peut plus être recalculée.
5. **R1bis n'a aucune pièce.** Le verdict cite « les relevés « avant » R0 à R6 et R1bis » ; les définitions complètes n'ont pas été conservées en fichier. Leur identité repose sur les empreintes de R1 (`docs/security/ATTESTATION-0161-2026-10-03.md`, §5 et réserve 2).
6. **R5 ne varie pas.** Le mandat de ce lot documentaire prévoyait « R5 qui varie sous explication » ; les deux relevés sont identiques, il n'y a aucune variation à expliquer.
7. **Relevés de production : transcriptions.** Le verdict dit les relevés « après » « conformes à la liste fermée des différences attendues » ; cette conformité est lue dans des transcriptions du porteur, les exports bruts n'ayant pas été conservés.

Les écarts 1, 2, 5, 6 et 7 restent en l'état. Aucune empreinte recalculée ne diffère d'une empreinte écrite dans le verdict ou dans `SHA256SUMS.txt`.

## Renvois

- Attestation de la migration : `docs/security/ATTESTATION-0161-2026-10-03.md`.
- Ce que le lot livre, ses réserves et ses dettes : `CLAUDE.md`, section « Shopify — abonnements par boutique et désinstallation ordonnée ».
