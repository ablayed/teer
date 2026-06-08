import { getToolsForRole, runTool } from '@/lib/ia/tools';
import type { IaToolContext } from '@/lib/ia/types';
import { type ToolSet, tool } from 'ai';

// Construit le ToolSet exposé au LLM à partir du catalogue filtré par rôle
// (couche A). Chaque exécution passe par runTool (couche B : re-check rôle,
// validation des args, audit). Le LLM ne voit donc QUE des outils autorisés,
// et chaque appel est re-vérifié et journalisé.
export function buildAiToolSet(ctx: IaToolContext): ToolSet {
  const set: ToolSet = {};
  for (const catalogTool of getToolsForRole(ctx.role)) {
    set[catalogTool.name] = tool({
      description: catalogTool.description,
      inputSchema: catalogTool.inputSchema,
      execute: async (args) => {
        const result = await runTool(ctx, catalogTool.name, args);
        // On renvoie un objet JSON au LLM (données ou erreur explicite) ; jamais
        // une exception, pour qu'il puisse formuler une réponse honnête.
        return result.ok ? result.data : { error: result.error };
      },
    });
  }
  return set;
}
