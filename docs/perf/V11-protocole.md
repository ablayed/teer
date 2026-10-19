# V11 — protocole de mesure des appels Supabase (temporaire)

Plan vitesse avant lancement v2 (19/10), lot V11. Ce document décrit l'instrumentation
`lib/monitoring/supabase-call-trace.ts`, comment la lancer, comment lire ses lignes, ce qu'elle ne
sépare pas, et comment la retirer. **Il n'autorise aucune fusion, aucun déploiement ni aucune
action de production** : l'activation est une décision du porteur.

## 1. Ce que la mesure tranche

| Hypothèse | Énoncé | Ce que les lignes doivent montrer pour la soutenir |
|---|---|---|
| **H1** | Le `fetch` de Node n'a pas de connexion à réutiliser : undici ferme une socket inactive après ~4 s, et 20 appels en HTTP/1.1 ouvrent plusieurs sockets. | Après une inactivité **> 5 s**, les premiers appels de la page ont `sock_new:true` avec un `connect_ms` mesuré, et les appels lents sont majoritairement `sock_new:true`. Après **≤ 3 s**, ils ont `sock_new:false`. |
| **H2** | L'attente est en amont chez Supabase (passerelle, Auth, compute). | Des appels lents sur socket **réutilisée** (`sock_new:false`), avec `wait_ms` faible et `ttfb_ms` élevé, une boucle libre, et la même lenteur sur plusieurs opérations (`auth:user` comme `table:*`). **Aucune sonde dédiée dans ce lot** : le trajet passerelle / Auth / connexion base / SQL n'est pas séparé. |
| **H3** | L'instance Vercel est fraîche ou sa boucle d'événements est occupée. | Appels lents concentrés sur le premier(s) `seq` d'un nouvel identifiant `boot`, ou `loop_p99_ms`/`loop_max_ms` nettement au-dessus du plancher de 10 ms pendant la fenêtre de l'appel lent. |

Portes de décision (plan v2) : appels lents sur sockets neuves → V12 puis V15 (keep-alive) ; sur
sockets réutilisées, boucle libre, sur plusieurs opérations à la fois → amont Supabase, V12 reste utile, puis test Micro ;
requêtes lentes marquées Cold avec boucle occupée → V13 et Vercel Pro.

## 2. Activation et retrait

- **Activation** : variable d'environnement `V11_SUPABASE_TRACE=1` sur le déploiement concerné, puis
  **nouveau déploiement** (les variables sont figées à la création du déploiement). Sans cette
  variable, `instrumentation.ts` ne charge jamais le module : aucun abonnement, aucune ligne.
- **Retrait (réversion)**, par ordre de rapidité :
  1. *Instant Rollback* vers le déploiement précédent (référence au moment de l'activation) ;
  2. retirer la variable puis redéployer : le module n'est plus chargé ;
  3. revert du commit (le code est isolé : `instrumentation.ts` + deux fichiers de `lib/monitoring/`).
- Aucune donnée n'est écrite en base ni chez un tiers : la sortie est `console.log`, donc les
  *Runtime Logs* de Vercel.

## 3. Ce qui est enregistré

Une ligne JSON par événement, étiquetée `"tag":"v11"` :

- au démarrage du processus (`ev:"boot"`) : `node`, `undici`, `region`, `vercel_env`,
  `loop_resolution_ms` et l'identifiant aléatoire `boot` du processus ;
- par appel (`ev:"call"`) : `seq`, `proc_age_s`, `op`, `method`, `status`, `sock` (identifiant de
  socket dans le processus), `sock_new`, `sock_age_ms`, `sock_uses`, `connect_ms`, `alpn`,
  `wait_ms` (création → envoi des en-têtes : file d'attente + DNS + TCP + TLS), `ttfb_ms`
  (envoi → en-têtes de réponse), `body_ms` (lecture du corps), `total_ms`, `loop_p99_ms`,
  `loop_max_ms`, `err` (code seulement) ;
- par échec de connexion vers Supabase (`ev:"connect_error"`) : `proc_age_s`, `connect_ms` (délai avant l'échec), `err` (code seul, par exemple `ECONNREFUSED`). L'appel qui en résulte porte le même code dans `err`, sans `sock` ;
- une ligne `ev:"budget"` si le processus atteint 20 000 lignes, puis plus rien.

**Jamais enregistré** : URL complète, chaîne de requête, hôte, en-tête (requête ou réponse),
cookie, jeton JWT, corps, identifiant de ligne, message ou pile d'erreur. Le chemin n'est lu que
pour produire un nom à liste blanche (`rpc:<fonction>`, `table:<table>`, `auth:<verbe>`) ; tout autre
chemin devient `other`. Seuls les appels vers l'hôte Supabase configuré sont mesurés. Verrouillé par
`tests/unit/monitoring/supabase-call-trace*.test.ts`, y compris contre le vrai `fetch` de Node.

## 4. Protocole — séries d'inactivité

Compte et boutique **de test dédiés** (règle 14 du dépôt), jamais le compte propriétaire. Écran :
`/commandes`. Pour chaque durée d'inactivité **T ∈ {1, 3, 5, 8, 30, 120} s** :

1. charger l'écran une fois (échauffement) ;
2. ne rien envoyer à l'application pendant T secondes ;
3. recharger l'écran ; noter l'heure ;
4. répéter **au moins 3 fois par T** (≈ 20 appels par chargement, soit ≥ 50 appels instrumentés
   par condition, seuil du plan).

Alterner l'ordre des T d'une série à l'autre. Une instance Vercel peut recevoir d'autres requêtes :
**une série n'est valable que si l'identifiant `boot` reste le même d'un chargement au suivant** (sinon
c'est une mesure Cold, à classer à part). Relevé *Cold/Hot* : Cold = premier(s) appel(s) d'un nouvel
identifiant `boot` (`seq` bas, `proc_age_s` petit) ; Hot = les suivants.

**Capture des journaux** : les *Runtime Logs* de Vercel ont une rétention courte sur le plan Hobby
(durée à vérifier dans le tableau de bord, `[Non vérifié]`). Capturer en direct pendant la série
avec `vercel logs` sur le déploiement, ou exporter immédiatement après.

## 5. Ce que cette mesure ne sépare PAS

- **Aucune sonde dédiée dans ce lot.** `net_probe()` a été retirée du périmètre : pas de migration, pas de dépendance à `0168`. Le trajet PostgREST — passerelle, validation du JWT, connexion à la base, SQL — reste **un seul bloc** : un `ttfb_ms` élevé sur socket réutilisée ne dit pas lequel de ces maillons attend. On compare des opérations rapides (`auth:user`, lectures simples) et lentes (listes) entre elles, à corréler avec les journaux et métriques Supabase.
- **Appariement de `connect_ms`.** undici ne transmet pas le même objet `connectParams` à `beforeConnect` et à `connected` (mesuré sur Node 24 / undici 7.18.2) : l'appariement par objet est impossible. Les départs de connexion sont donc rangés dans une file **par hôte**, et seuls ceux de l'hôte Supabase sont suivis : une ouverture parallèle vers un autre hôte (Upstash, Sentry) ne fausse rien, et un échec Supabase sort de la file. **Limite restante** : deux connexions vers Supabase ouvertes en même temps ne se distinguent pas ; elles sont appariées dans l'ordre d'arrivée, ce qui peut échanger leurs deux durées (jamais en créer une).
- `wait_ms` mélange file d'attente locale, DNS, TCP et TLS. `connect_ms` (socket neuve seulement)
  isole le coût de connexion de la socket, mais pas la file d'attente derrière d'autres requêtes.
- La mesure est faite côté fonction : elle ne voit ni la navigation, ni le réseau mobile, ni le rendu.
- Le retard de boucle a un plancher d'échantillonnage de 10 ms : une boucle libre affiche ~10 ms.
- Le surcoût de l'instrumentation n'est pas mesuré ici ; il est attendu négligeable (quelques
  lectures d'horloge et une ligne `console.log` par appel), à confirmer en comparant `total_ms`.

## 6. Hors périmètre de ce lot

Aucun agent undici, aucun HTTP/2, aucun changement de transport, de région, de plan ou de compute.
Constat de contexte (mesuré le 19/10, sans clé) : le serveur Supabase **accepte h2** à la
négociation ALPN, alors que le `fetch` de Node propose et obtient `http/1.1` par défaut ; la réponse
HTTP/1.1 porte `Connection: keep-alive` sans en-tête `Keep-Alive` explicite. C'est une information
pour V15, pas une action.

## 7. Rapport attendu après la session

Seuil de « lent » : `total_ms ≥ 300` (ajustable, à annoncer avant lecture). Pour **chaque appel lent** :

- **socket neuve ou réutilisée** (`sock_new`), avec `sock_age_ms` et `sock_uses` ;
- **part connexion contre attente de réponse** : `wait_ms` (dont `connect_ms` pour une socket neuve) contre `ttfb_ms`, puis `body_ms` ;
- **Cold ou Hot** : Cold = premiers appels d'un nouvel identifiant `boot` ; Hot = les suivants ;
- retard de boucle (`loop_p99_ms`, `loop_max_ms`) et durée d'inactivité T de la série.

Résultats groupés par condition (T et Cold/Hot), avec les effectifs : pas de conclusion sous 50 appels par condition.
