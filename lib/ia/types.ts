import type { Database } from '@/lib/supabase/database.types';
import type { TeamRole } from '@/lib/team/permissions';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

// Contexte d'exécution d'un outil IA.
// `supabase` est TOUJOURS le client JWT de l'utilisateur (RLS s'applique) —
// jamais le client admin service-role (décision Phase 8).
export type IaToolContext = {
  supabase: SupabaseClient<Database>;
  merchantAccountId: string;
  userId: string;
  role: TeamRole;
  conversationId?: string | null;
};

// Un outil du catalogue fixe. Le LLM n'émet qu'un nom + des args JSON ;
// il n'a aucun accès SQL/HTTP. `allowedRoles` = couche A (filtrage du catalogue
// par rôle) ; `runTool` re-vérifie ce même `allowedRoles` = couche B.
// Type ERASÉ (input: unknown) pour pouvoir stocker des outils hétérogènes dans
// un même tableau ; l'inférence par outil est préservée par defineTool().
export type IaTool = {
  name: string;
  description: string;
  allowedRoles: readonly TeamRole[];
  inputSchema: z.ZodTypeAny;
  execute: (ctx: IaToolContext, input: unknown) => Promise<unknown>;
};

// Authoring typé : `execute` reçoit le type inféré du schéma de CET outil,
// puis on efface le générique pour le catalogue.
export function defineTool<S extends z.ZodTypeAny>(tool: {
  name: string;
  description: string;
  allowedRoles: readonly TeamRole[];
  inputSchema: S;
  execute: (ctx: IaToolContext, input: z.infer<S>) => Promise<unknown>;
}): IaTool {
  return tool as unknown as IaTool;
}

export type IaToolRunResult = { ok: true; data: unknown } | { ok: false; error: string };
