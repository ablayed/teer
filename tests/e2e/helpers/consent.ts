import type { SupabaseClient } from '@supabase/supabase-js';

// Enregistre un consentement RÉEL pour les documents légaux COURANTS (cgu + privacy), reproduisant
// fidèlement l'état d'un utilisateur ayant accepté au signup. On lit la version courante depuis
// legal_documents.is_current (AUCUNE version hardcodée) puis on insère les lignes user_consents
// correspondantes — exactement la forme produite par lib/legal/consent.ts (persistSignupConsents).
//
// But : que les users de test passent le mur post-login (getMissingCurrentConsents) comme un vrai
// user ayant consenti, SANS désactiver le garde. Le garde reste actif ; on satisfait sa condition.
export async function grantCurrentConsents(admin: SupabaseClient, userId: string): Promise<void> {
  const { data: documents, error } = await admin
    .from('legal_documents')
    .select('type, version, content_hash')
    .eq('is_current', true)
    .in('type', ['cgu', 'privacy']);

  if (error) {
    throw error;
  }

  if (!documents || documents.length === 0) {
    throw new Error(
      'Aucun document légal courant (cgu/privacy) — seed migrations 0046/0047 manquant ?',
    );
  }

  const { error: insertError } = await admin.from('user_consents').insert(
    documents.map((document: { type: string; version: string; content_hash: string }) => ({
      user_id: userId,
      document_type: document.type,
      document_version: document.version,
      content_hash: document.content_hash,
      method: 'signup_checkbox',
    })),
  );

  if (insertError) {
    throw insertError;
  }
}
