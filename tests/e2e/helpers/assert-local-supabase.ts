/**
 * Garde-fou défensif E2E.
 *
 * Les tests E2E créent/suppriment des users et des commandes via une clé service-role
 * (bypass RLS). Ils NE DOIVENT JAMAIS s'exécuter contre une base distante/prod : la stack
 * cloud liée (`ggckakaeaklwaoobpeks`) contient les données marchands réelles. La seule
 * protection « naturelle » est que playwright.config charge `.env.test` (127.0.0.1:54321)
 * dans process.env avant que les specs résolvent leur URL — mais si `.env.test` manque ou
 * si `SUPABASE_URL` est exporté dans le shell, la résolution bascule silencieusement sur
 * l'URL + la clé service-role de `.env.local` (cloud/prod).
 *
 * Ce garde-fou fait échouer BRUYAMMENT plutôt que de taper la prod en silence. Il
 * n'affiche que le host (un éventuel credential dans l'URL est masqué).
 */
export function assertLocalSupabase(url: string): void {
  const isLocal = /127\.0\.0\.1|localhost/.test(url);
  if (!isLocal) {
    throw new Error(
      `GARDE-FOU E2E : SUPABASE_URL non-locale détectée (${url.replace(/\/\/.*@/, '//***@')}). Les tests E2E créent/suppriment des données via service-role et NE DOIVENT JAMAIS s'exécuter contre une base distante/prod. Vérifie .env.test (attendu : 127.0.0.1:54321).`,
    );
  }
}
