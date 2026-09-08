'use server';

// APP-03 / Lot 2 — enveloppe next-safe-action mince. Le cœur métier (gardes, écriture) vit dans
// `lib/shopify/embedded-link-write.ts`, testable sans passer par le safe-action client.
import { authActionClient } from '@/lib/actions/safe-action';
import {
  type ShopifyEmbeddedLinkResult,
  performShopifyEmbeddedLink,
} from '@/lib/shopify/embedded-link-write';
import { z } from 'zod';

export type { ShopifyEmbeddedLinkResult };

const inputSchema = z.object({
  intent: z.string().min(1),
  merchantAccountId: z.string().uuid(),
});

export const linkShopifyEmbeddedShopAction = authActionClient
  .metadata({ actionName: 'shopify.embedded_link', section: 'shopify' })
  .inputSchema(inputSchema)
  .action(
    async ({ parsedInput, ctx }): Promise<ShopifyEmbeddedLinkResult> =>
      performShopifyEmbeddedLink(parsedInput, { userId: ctx.user.id, supabase: ctx.supabase }),
  );
