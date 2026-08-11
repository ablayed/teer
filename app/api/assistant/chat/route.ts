import { buildAiToolSet } from '@/lib/ia/ai-tools';
import { persistMessage, touchConversation, validateConversation } from '@/lib/ia/conversation';
import { checkToolRateLimit } from '@/lib/ia/rate-limit';
import { resolveIaContext } from '@/lib/ia/server-context';
import { buildSystemPrompt } from '@/lib/ia/system-prompt';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import { detectPcdCategories } from '@/lib/security/pcd-detection';
import { groq } from '@ai-sdk/groq';
import { type UIMessage, convertToModelMessages, stepCountIs, streamText } from 'ai';

export const runtime = 'nodejs';
export const preferredRegion = 'fra1';
export const maxDuration = 30;

const MODEL = 'llama-3.3-70b-versatile';
const MAX_INPUT_CHARS = 4000;
const HISTORY_WINDOW = 10;

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user') {
      return message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
        .trim();
    }
  }
  return '';
}

function allTextParts(messages: UIMessage[]): string {
  return messages
    .flatMap((message) =>
      message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text),
    )
    .join('\n');
}

export async function POST(req: Request): Promise<Response> {
  const auth = await resolveIaContext();
  if (!auth.ok) {
    return jsonError(auth.status === 401 ? 'unauthenticated' : 'forbidden', auth.status);
  }

  let body: { messages?: UIMessage[]; conversationId?: string };
  try {
    body = (await req.json()) as { messages?: UIMessage[]; conversationId?: string };
  } catch {
    return jsonError('invalid_body', 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const conversationId = body.conversationId;
  if (messages.length === 0 || !conversationId) {
    return jsonError('bad_request', 400);
  }

  const userText = lastUserText(messages);
  if (!userText) {
    return jsonError('bad_request', 400);
  }
  if (userText.length > MAX_INPUT_CHARS) {
    return jsonError('input_too_long', 413);
  }

  // Contrôle déterministe MVP : aucune conversation contenant une forme
  // explicitement identifiable de PCD ne doit être persistée ou envoyée à Groq.
  // Le détecteur ne prétend pas couvrir les noms ou adresses sémantiques libres.
  const detectedCategories = detectPcdCategories(allTextParts(messages));
  if (detectedCategories.length > 0) {
    try {
      for (const dataCategory of detectedCategories) {
        await writePcdAccessAudit(auth.ctx.supabase, {
          tenantId: auth.ctx.merchantAccountId,
          actorKind: 'human',
          action: 'ai_processing',
          dataCategory,
          purpose: 'customer_support',
          outcome: 'denied',
          resourceType: 'assistant',
          resourceId: null,
          surface: 'assistant',
          metadata: { reason_code: 'sensitive_content_rejected' },
        });
      }
    } catch {
      return jsonError('audit_unavailable', 503);
    }
    return jsonError('sensitive_content_rejected', 422);
  }

  // Rate-limit par utilisateur (appels d'outils récents).
  const rl = await checkToolRateLimit(auth.ctx);
  if (!rl.ok) {
    return new Response(JSON.stringify({ error: 'rate_limited' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '60' },
    });
  }

  const validId = await validateConversation(auth.ctx.supabase, conversationId, userText);
  if (!validId) {
    return jsonError('forbidden', 403);
  }

  const ctx = { ...auth.ctx, conversationId: validId };
  await persistMessage(ctx.supabase, ctx.merchantAccountId, validId, 'user', userText);

  const result = streamText({
    model: groq(MODEL),
    system: buildSystemPrompt(ctx.role),
    messages: await convertToModelMessages(messages.slice(-HISTORY_WINDOW)),
    tools: buildAiToolSet(ctx),
    stopWhen: stepCountIs(5),
    temperature: 0,
    maxRetries: 3, // repli 429 fournisseur = backoff exponentiel automatique
    onFinish: async ({ text }) => {
      await persistMessage(ctx.supabase, ctx.merchantAccountId, validId, 'assistant', text);
      await touchConversation(ctx.supabase, validId);
    },
  });

  return result.toUIMessageStreamResponse();
}
