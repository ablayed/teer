# Accord de Sous-Traitance (Data Processing Agreement – DPA)

**Dernière mise à jour : 10 juin 2026**
**Version : 1.0**

## Entre les parties

- **Le Responsable de traitement** : le Marchand utilisateur du service Tëër (ci-après le « Responsable »).
- **Le Sous-traitant** : Ablaye Dia, entrepreneur individuel, Sotrac Mermoz Villa 64, Dakar, Sénégal (ci-après « Tëër » ou le « Sous-traitant »).

Le présent Accord complète les Conditions Générales d'Utilisation et encadre le traitement, par Tëër, des données à caractère personnel des clients du Responsable.

## 1. Objet, durée, nature et finalité du traitement

Tëër traite, pour le compte du Responsable, les données des clients finaux du Responsable, aux seules fins de fournir le service de gestion des opérations de paiement à la livraison (suivi des commandes, livraisons, encaissements). La durée du traitement correspond à celle de l'abonnement du Responsable.

## 2. Type de données et catégories de personnes concernées

- **Catégories de données** : noms des destinataires, numéros de téléphone, adresses de livraison, adresses électroniques, données de commande.
- **Catégories de personnes concernées** : les clients finaux du Responsable.

## 3. Obligations du Responsable de traitement

Le Responsable garantit qu'il dispose d'une base légale pour le traitement, qu'il a informé ses clients conformément à la réglementation applicable, et qu'il transmet à Tëër des instructions licites et documentées.

## 4. Traitement sur instructions documentées uniquement

Tëër traite les données uniquement sur la base des instructions documentées du Responsable, y compris en matière de transfert international, sauf obligation légale contraire (article 28.3.a RGPD ; article 70 Loi 2008-12).

## 5. Confidentialité du personnel

Toute personne autorisée à traiter les données est soumise à une obligation de confidentialité (engagement écrit conformément à l'article 70 de la Loi 2008-12).

## 6. Sécurité du traitement

Tëër met en œuvre les mesures techniques et organisationnelles appropriées (article 32 RGPD ; article 71 Loi 2008-12), détaillées à l'**Annexe B** : chiffrement en transit et au repos, isolation stricte des données entre Marchands (Row-Level Security), contrôle d'accès basé sur les rôles, journalisation des accès, sauvegardes chiffrées, séparation des environnements de test et de production.

## 7. Sous-traitance ultérieure

Le Responsable autorise Tëër à recourir aux sous-traitants ultérieurs listés en **Annexe C**. Tëër impose à ces sous-traitants des obligations de protection équivalentes et demeure pleinement responsable de leur exécution. Toute modification de la liste est notifiée au Responsable, qui peut s'y opposer pour motif légitime.

## 8. Assistance aux demandes des personnes concernées

Tëër met à disposition du Responsable les moyens techniques permettant de répondre aux demandes d'exercice de droits (accès, rectification, effacement, portabilité), notamment via les webhooks de conformité Shopify (`customers/data_request`, `customers/redact`).

## 9. Assistance en cas de violation de données

Tëër notifie au Responsable toute violation de données à caractère personnel **dans les meilleurs délais** après en avoir pris connaissance, afin de permettre au Responsable de respecter ses propres obligations de notification (notamment le délai de 72 heures sous le RGPD). La notification précise la nature de la violation, les données concernées et les mesures prises.

## 10. Suppression ou restitution des données

À la fin du contrat, Tëër supprime ou restitue les données au choix du Responsable, sauf obligation légale de conservation. La suppression est mise en œuvre notamment via le webhook `shop/redact` (déclenché 48 heures après la désinstallation de l'application) et `customers/redact`.

## 11. Audits et inspections

Tëër met à la disposition du Responsable les informations nécessaires pour démontrer le respect du présent Accord et permet la réalisation d'audits, dans des conditions raisonnables et confidentielles.

## 12. Transferts internationaux

Les données sont hébergées dans l'Union européenne. Tout transfert est encadré par des garanties appropriées (clauses contractuelles types ou équivalentes), conformément aux articles 49 à 51 de la Loi 2008-12 et au chapitre V du RGPD.

---

## Annexe A — Description du traitement

- **Finalité** : gestion des opérations COD pour le compte du Responsable.
- **Durée** : durée de l'abonnement.
- **Nature** : collecte, enregistrement, consultation, mise à jour, suppression.
- **Données** : voir article 2.
- **Personnes concernées** : clients finaux du Responsable.

## Annexe B — Mesures techniques et organisationnelles de sécurité

- Chiffrement des données en transit (TLS) et au repos.
- Isolation des données par Marchand via Row-Level Security (RLS) au niveau base de données.
- Contrôle d'accès basé sur les rôles (propriétaire, gestionnaire, livreur).
- Journalisation des accès et des opérations sensibles (audit logging).
- Sauvegardes régulières et chiffrées.
- Séparation des environnements de test et de production.
- Politique de gestion des incidents de sécurité.
- Accès limité au personnel autorisé, soumis à confidentialité.

## Annexe C — Liste des sous-traitants ultérieurs

| Sous-traitant | Rôle | Localisation |
|---|---|---|
| Supabase | Base de données et authentification | Union européenne |
| Vercel | Hébergement applicatif | Union européenne (fra1) |
| Groq | Assistant IA (lecture seule, aucun entraînement sur les données) | États-Unis |
| Resend | Courriels transactionnels | Union européenne / États-Unis |
| Shopify | Source des données de commande et de client | International |

## Annexe D — Dispositions par juridiction (cadre extensible)

Le présent Accord est conçu sur un standard de protection de niveau RGPD, qui satisfait ou dépasse les exigences des régimes de protection des données d'Afrique de l'Ouest (Acte additionnel CEDEAO A/SA.1/01/10 ; Convention de Malabo de l'Union africaine). Lors de l'extension du service à un nouveau pays, la présente annexe est complétée pour indiquer :

| Pays | Loi applicable | Autorité de contrôle | Formalité préalable | Mécanisme de transfert |
|---|---|---|---|---|
| **Sénégal** | Loi n° 2008-12 | CDP | Déclaration préalable (Art. 18) | Art. 49-51 + garanties |
| Côte d'Ivoire | Loi n° 2013-450 | ARTCI | Déclaration + autorisation du transfert | À compléter |
| Bénin | Loi n° 2017-20 (Code du numérique) | APDP | Déclaration | À compléter |
| Togo | Loi n° 2019-014 | IPDCP | Déclaration | À compléter |
| Burkina Faso | Loi n° 001-2021 | CIL | Déclaration | À compléter |
| Mali | Loi n° 2013-015 | APDP | Déclaration/autorisation | À compléter |
| Nigeria | NDPA 2023 | NDPC | Enregistrement (controller of major importance) + DPO | Instrument de transfert documenté (SCC) |
| Ghana | Act 843 (2012) | DPC | Enregistrement obligatoire | À compléter |

> ⚠️ Chaque ligne (hors Sénégal) doit être validée par un conseil local avant lancement dans le pays concerné.
