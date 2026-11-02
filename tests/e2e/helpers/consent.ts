import type { SupabaseClient } from '@supabase/supabase-js';

type ConsentType = 'cgu' | 'privacy' | 'mentions' | 'dpa';

const REQUIRED_CURRENT_CONSENT_TYPES: readonly ConsentType[] = [
  'cgu',
  'privacy',
  'mentions',
  'dpa',
];

// Enregistre des consentements RÉELS pour les documents légaux COURANTS, reproduisant
// fidèlement l'état d'un utilisateur ayant accepté au signup. On lit les versions et empreintes
// depuis legal_documents.is_current (AUCUNE version ni empreinte hardcodée), puis on insère les
// lignes user_consents correspondantes — comme persistSignupConsents.
//
// But : que les users de test passent le mur post-login (getMissingCurrentConsents) comme un vrai
// user ayant consenti, SANS désactiver le garde. Le garde reste actif ; on satisfait sa condition.
export async function grantCurrentConsents(
  admin: SupabaseClient,
  userId: string,
  documentTypes: readonly ConsentType[] = REQUIRED_CURRENT_CONSENT_TYPES,
): Promise<void> {
  if (documentTypes.length === 0 || new Set(documentTypes).size !== documentTypes.length) {
    throw new Error('La liste des types de documents légaux doit être non vide et sans doublons.');
  }

  const { data: documents, error } = await admin
    .from('legal_documents')
    .select('type, version, content_hash')
    .eq('is_current', true)
    .in('type', [...documentTypes]);

  if (error) {
    throw error;
  }

  const currentTypes = new Set((documents ?? []).map((document) => document.type));
  const missingTypes = documentTypes.filter((type) => !currentTypes.has(type));
  if (missingTypes.length > 0 || documents?.length !== documentTypes.length) {
    throw new Error(`Documents légaux courants absents ou dupliqués : ${missingTypes.join(', ')}`);
  }

  const { error: insertError } = await admin.from('user_consents').insert(
    documents.map((document) => ({
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
