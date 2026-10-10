# L07 — Tableau visible dès le HTML reçu : mesure Lighthouse avant / après

Complément de mesure de la PR #251. Mesuré en local le 2026-10-10, sans code.

## Protocole

- **Avant** : `main` (`c8f9ae7`). **Après** : la branche du lot (`b21ba0c`).
- Les deux en build de production (`next build` puis `next start`), Next 15.5.27, même poste,
  même base locale, **même compte et mêmes données** : la fixture du Tableau des tests visuels,
  créée une fois et conservée entre les deux builds.
- Page mesurée : `/tableau` sur la période de la fixture, **session ouverte** (les cookies de la
  session sont remis à Lighthouse ; une garde vérifie que la page finale est bien le Tableau).
- Lighthouse 13.5.0, catégorie performance, 5 passages par préréglage, après une lecture à blanc.
  Préréglage mobile : appareil et réseau simulés par défaut. Préréglage `desktop`.

## Résultats

Médiane, puis minimum et maximum des 5 passages.

### Mobile

| Indicateur | Avant | Après |
| --- | --- | --- |
| Score | 66 (66 – 69) | 69 (66 – 77) |
| FCP | 919 ms (910 – 1 223) | 917 ms (910 – 1 219) |
| LCP | 6 182 ms (5 889 – 6 375) | 5 919 ms (4 235 – 6 342) |
| Speed Index | 2 302 ms (1 723 – 2 403) | 2 151 ms (1 629 – 2 293) |
| TBT | 450 ms (378 – 481) | 388 ms (364 – 500) |
| CLS | 0 (0 – 0) | 0,033 (0,033 – 0,033) |
| TTFB du document | 105 ms (97 – 115) | 106 ms (103 – 121) |

### Desktop

| Indicateur | Avant | Après |
| --- | --- | --- |
| Score | 96 (95 – 97) | 96 (96 – 96) |
| FCP | 340 ms (336 – 361) | 345 ms (336 – 350) |
| LCP | 1 426 ms (1 302 – 1 473) | 1 389 ms (1 364 – 1 409) |
| Speed Index | 743 ms (684 – 774) | 676 ms (663 – 705) |
| TBT | 26 ms (0 – 37) | 20 ms (0 – 34) |
| CLS | 0 (0 – 0) | 0 (0 – 0) |
| TTFB du document | 110 ms (100 – 181) | 99 ms (93 – 161) |

## Lecture

1. **Lighthouse ne mesure pas ce que le lot change.** Les intervalles avant et après se
   recouvrent sur FCP, LCP, Speed Index et TBT : aucun écart n'est établi sur ces indicateurs.
   Le lot ne réduit ni le poids de la page ni le travail du navigateur ; il rend le contenu
   lisible avant l'exécution des scripts. Lighthouse ne retarde pas les scripts : cet effet reste
   celui mesuré par la preuve du lot (scripts retenus, contenu visible ou non).
2. **Un décalage de mise en page apparaît en mobile : CLS 0 → 0,033**, identique sur les cinq
   passages. Lighthouse en donne la cause : le chargement de la police d'affichage (Fraunces)
   change la hauteur du titre « Bonjour … », ce qui déplace le bloc des indicateurs. Avant le
   lot, ce bloc était transparent jusqu'à l'hydratation : le décalage avait lieu, il ne se voyait
   pas. Le lot ne le crée pas, il le rend visible.
3. La valeur reste sous le seuil « bon » de 0,1. Elle dépend de la fixture : le compte de test
   n'a pas de nom, le titre affiche son adresse e-mail sur quatre lignes. Avec un prénom court,
   le titre tient sur une ligne ; l'ampleur du décalage n'a pas été mesurée dans ce cas.
4. Le LCP mobile, autour de 6 s avant comme après, a pour élément ce même titre. Il n'est pas
   l'objet du lot.

## Limites

- Poste de développement, base locale, réseau et appareil **simulés** : ce ne sont pas des
  valeurs de production ni de terrain.
- Cinq passages par cas : un ordre de grandeur, pas une distribution.
- Une seule page, un seul compte, un seul jeu de données.
- Le décalage de mise en page n'est pas corrigé par ce lot.
