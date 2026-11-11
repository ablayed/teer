# Réponse aux incidents — brouillon à valider

Responsable : Ablaye Dia. Contact : diaablaye09@gmail.com. Périmètre : Tëër, ses intégrations et les données clients Shopify protégées (niveau 2). Ce document définit une procédure ; il ne constitue pas une attestation de conformité ni une garantie de permanence opérationnelle.

## Qualification et détection

Critique : compromission privilégiée, accès intermarchands ou exfiltration active de données clients. Haute : compte compromis, jeton fournisseur exposé, manipulation du cash ou accès non autorisé confirmé. Moyenne : faiblesse exploitable à impact limité. Basse : durcissement sans exploitation établie. Réévaluer dès qu'une nouvelle preuve apparaît.

Surveiller Sentry, les journaux applicatifs et d'accès, les échecs d'autorisation, les changements de membres et les alertes de disponibilité et dépenses. Une alerte ouvre un dossier horodaté en UTC : faits, source, périmètre, responsable, hypothèses et actions. Les journaux ne doivent contenir ni jetons ni données clients complètes. Vérifier les alertes et leur destinataire avant lancement ; une configuration présente dans le dépôt ne prouve pas leur fonctionnement.

## Confinement et preuves

Le responsable limite le chemin compromis : désactivation du compte ou de l'intégration, retrait des appartenances, révocation des sessions et blocage temporaire de l'opération affectée. Vérifier séparément les sessions déjà émises et les tâches différées. Préserver les preuves avant suppression, sauf urgence de confinement ; consigner tout arbitrage.

Depuis un poste de confiance, renouveler uniquement les credentials exposés ou potentiellement accessibles : Supabase (clés secrètes/service_role, secrets de signature et sessions selon le mécanisme réellement utilisé), Shopify (révocation/réautorisation des installations concernées), Vercel, Resend et Groq. Étendre à GitHub, Redis/QStash et aux clés de chiffrement si le périmètre le justifie. Cartographier les consommateurs, préparer la bascule et vérifier les nouvelles clés avant retrait des anciennes lorsque cela reste compatible avec le confinement. Une rotation de clé de chiffrement exige une stratégie de rechiffrement et de récupération ; ne pas rendre les données irrécupérables.

Exporter les journaux utiles vers un espace restreint, conserver les horodatages, identifiants de déploiement/commit et empreintes cryptographiques. Documenter chaque collecte, accès et transfert. Isoler les secrets éventuellement présents dans les preuves ; ne jamais les placer dans un ticket public, un commit ou une conversation. Éviter les extractions massives de données personnelles.

## Restauration et reprise

Identifier une sauvegarde antérieure à la compromission et vérifier sa disponibilité, sa rétention et ses droits d'accès. Restaurer d'abord dans un environnement isolé ; vérifier isolation RLS/ACL, appartenance des membres, intégrité commandes/cash/stock et absence de mécanisme de persistance. Rejouer les événements Shopify avec déduplication, sans doubler stocks ou encaissements. Valider le correctif et les tests de non-régression avant remise en service progressive. Conserver un point de retour sain ; ne pas restaurer une version connue vulnérable. Les objectifs de reprise seront fixés après un exercice chronométré, sans promesse préalable.

## Information et obligations

Ablaye Dia coordonne l'information des marchands et de Shopify par leurs canaux officiels : nature des données concernées, période, impact établi, mesures prises et actions requises. Distinguer faits et hypothèses ; compléter les notifications au fil de l'enquête. Prévenir les marchands responsables du traitement sans retard injustifié lorsque Tëër agit comme sous-traitant.

Déterminer les territoires, contrats et lois effectivement applicables avec un conseil compétent. Si le RGPD s'applique et que la violation présente un risque, le responsable du traitement notifie l'autorité compétente, si possible dans les 72 heures après en avoir pris connaissance ; une notification tardive doit être motivée. Un risque élevé peut nécessiter l'information des personnes. Pour le Sénégal, déterminer les obligations et modalités applicables auprès de la CDP ; ne pas transposer automatiquement le délai RGPD de 72 heures. Vérifier séparément les délais contractuels Shopify en vigueur. Conserver les décisions de notification et leurs motifs, y compris en cas d'absence de notification.

## Revue après incident

Établir une chronologie, la cause racine, les contrôles qui ont échoué et ceux qui ont détecté l'incident. Affecter chaque action à un responsable avec une échéance réaliste ; ajouter des tests reproduisant le défaut et un contrôle de détection. Tester la restauration et la rotation des credentials avec des données synthétiques. Vérifier l'efficacité des mesures et clôturer explicitement les risques résiduels. Réviser ce document après chaque incident significatif et exercice.

Références consultées le 11 novembre 2026 : [Shopify, données clients protégées](https://shopify.dev/docs/apps/launch/protected-customer-data) ; [CNIL, RGPD articles 33 et 34](https://www.cnil.fr/fr/reglement-europeen-protection-donnees/chapitre4). Ces pages évolutives n'affichent pas ici de date de publication fiable. Les délais sénégalais et les conditions contractuelles exactes restent à valider.
