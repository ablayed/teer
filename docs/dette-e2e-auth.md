# Dette E2E auth — scénarios à écrire

> Démarrer dès que PR #37 est mergée sur main.  
> Spec cible : `tests/e2e/auth.spec.ts`  
> Ne pas toucher à `playwright.config.ts` ni aux workflows.

---

## 0. Adaptation du scénario existant

Le seul test existant dans `auth.spec.ts` doit être mis à jour :

| Ce qui change | Avant (main pré-#38) | Après (#38) |
|---|---|---|
| Bouton submit signup | `messages.auth.submit` = "Continuer" | `messages.auth.signup.submit` = "Créer mon compte" |
| Écran vérif email | `messages.auth.verify_email` | `messages.auth.signup.verify_title` |

```ts
// Remplacer :
await page.getByRole('button', { name: messages.auth.submit }).click();
await expect(page.getByText(messages.auth.verify_email)...).toBeVisible();
// Par :
await page.getByRole('button', { name: messages.auth.signup.submit }).click();
await expect(page.getByText(messages.auth.signup.verify_title)...).toBeVisible();
```

---

## 1. Connexion — scénarios nouveaux

### 1a. Sign-in happy path
```
GIVEN user with valid credentials + onboarded_at set
WHEN fill email + password → click "Se connecter"
THEN redirect to /tableau, nav visible
```
- Helper : `loginViaForm(page, email, password)` (à créer ou inliner)
- Clé i18n bouton : `messages.auth.signin.submit`

### 1b. Sign-in invalid credentials → role="alert" + password cleared
```
GIVEN wrong password
WHEN submit
THEN <p role="alert"> visible avec messages.auth.errors.invalid_credentials
AND le champ mot de passe est vide (vidé côté client)
```

### 1c. Sign-in email_not_confirmed → resend button
```
GIVEN user créé mais email non confirmé
WHEN submit connexion
THEN messages.auth.errors.email_not_confirmed visible
AND bouton "Renvoyer l'email" (messages.auth.signup.verify_resend) visible
```

### 1d. Idle bandeau ?reason=idle
```
GIVEN navigation vers /connexion?reason=idle
THEN <output> contenant messages.auth.session_expired_idle visible
AND role implicite status (pas de role="alert")
```
- Pas de login nécessaire — page publique.

### 1e. Password reveal toggle
```
GIVEN /connexion, champ mot de passe
WHEN click sur le bouton messages.auth.common.show_password
THEN input[name="password"] a type="text"
WHEN click sur messages.auth.common.hide_password
THEN type="password"
```

### 1f. Tab switch Connexion ↔ Inscription
```
GIVEN /connexion (mode signin par défaut)
WHEN click onglet "Inscription"
THEN URL contient ?mode=signup
AND bouton submit = messages.auth.signup.submit
WHEN click onglet "Connexion"
THEN URL contient ?mode=signin (ou pas de mode)
AND bouton submit = messages.auth.signin.submit
```

---

## 2. Inscription — scénarios nouveaux

### 2a. Indicateur de force MDP
```
GIVEN /connexion?mode=signup
WHEN fill password "abc" (faible)
THEN <meter> visible, au moins un <li> texte-muted (critère non valide)
WHEN fill password "TeerSecure1#" (fort)
THEN tous les <li> en texte-success
```

### 2b. Bouton submit bloqué
```
GIVEN /connexion?mode=signup
THEN bouton "Créer mon compte" est disabled tant que :
  - MDP ne satisfait pas les 5 critères
  - OU case #acceptedLegal non cochée
WHEN critères + case cochés
THEN bouton enabled
```

### 2c. Sign-up happy path → écran vérification
```
GIVEN email unique, MDP fort, case cochée
WHEN submit
THEN <section aria-label=messages.auth.signup.verify_aria> visible
AND messages.auth.signup.verify_body contenant l'email soumis visible
AND bouton "Renvoyer l'email" présent
```
- E-mail réel envoyé via Supabase test — on ne suit pas le lien, on vérifie juste l'écran.

---

## 3. Onboarding — scénarios nouveaux

> Pré-requis : user connecté avec `onboarded_at = null`.  
> Helper à créer : `createUnboardedTestUser(admin)` → insère un user + `grantCurrentConsents` mais ne remplit pas `onboarded_at`.

### 3a. Step 1 s'affiche correctement
```
GIVEN user non onboardé → redirigé vers /onboarding
THEN messages.onboarding.step1.title visible
AND progress bar à 50% (style.width = "50%")
AND messages.onboarding.stepIndicator avec step=1 visible
```

### 3b. Validation step 1 — shop name requis
```
WHEN click "Continuer" sans remplir shop name
THEN messages.onboarding.errors.shopName visible
AND on reste sur step 1
```

### 3c. Transition step 1 → step 2
```
WHEN fill shop name ≥ 2 chars → click "Continuer"
THEN messages.onboarding.step2.title visible
AND <output> messages.onboarding.stepSaved visible (flash auto-dismiss 3s)
AND progress bar à 100%
```

### 3d. Retour step 2 → step 1
```
WHEN sur step 2 → click "Retour"
THEN messages.onboarding.step1.title visible
AND progress bar à 50%
```

### 3e. Validation WhatsApp invalide
```
WHEN fill whatsapp "1234" (invalide) → submit
THEN messages.onboarding.errors.invalid_whatsapp visible
```

### 3f. Parcours complet → écran bienvenue
```
WHEN step1 (shop name + pays) → step2 (ownerFullName) → submit
THEN messages.onboarding.welcome.title avec le prénom visible
AND messages.onboarding.welcome.cta visible
AND onboarded_at NOT NULL en base (assertion SQL ou recharge page)
```

### 3g. CTA bienvenue → /tableau
```
WHEN click messages.onboarding.welcome.cta
THEN navigated to /tableau
AND guard (app)/layout.tsx laisse passer (onboarded_at set)
AND ActivationChecklist présente (messages.onboarding.checklist.title)
```

---

## 4. Comportement mobile

Les scénarios 1a–3g doivent passer sur les 3 projets (`chromium`, `pixel-7`, `iphone-14`).  
Points spécifiques mobile à vérifier dans un test dédié :

```
GIVEN /connexion sur pixel-7
THEN BrandPanel affiché comme strip compact (pas de tagline)
AND formulaire visible sans scroll
THEN /connexion?mode=signup
AND indicateur de force MDP visible (pas tronqué)
```

**Piège fill() sur iphone-14** : pour les champs MDP contrôlés React, utiliser le pattern :
```ts
await field.click({ clickCount: 3 });
await field.pressSequentially('TeerSecure1#');
await expect(field).toHaveValue('TeerSecure1#');
```

---

## 5. Helpers à créer / vérifier

| Helper | Fichier | Statut |
|---|---|---|
| `grantCurrentConsents(admin, userId)` | `tests/e2e/helpers/consent.ts` | ✅ Existe |
| `createUnboardedTestUser(admin)` | `tests/e2e/helpers/onboarding.ts` | ❌ À créer |
| `loginViaForm(page, email, password)` | inline ou `tests/e2e/helpers/auth.ts` | ❌ À créer si besoin |

`createUnboardedTestUser` doit :
1. Créer un user Supabase Auth (email unique `e2e+onboarding+${Date.now()}@example.com`)
2. Insérer `merchant_accounts` avec `onboarded_at = null`
3. Appeler `grantCurrentConsents(admin, userId)`
4. Retourner `{ email, password, userId }`

---

## 6. Ordre de priorité

1. **Adapter le test existant** (1 commit) — bloquant si non fait, casse la CI.
2. **Idle bandeau + tab switch** (low-risk, pas de auth nécessaire)
3. **Sign-in happy path + invalid credentials**
4. **Sign-up happy path**
5. **Onboarding complet (3f + 3g)** — nécessite `createUnboardedTestUser`
6. **Mobile** — une fois les scénarios desktop stables
