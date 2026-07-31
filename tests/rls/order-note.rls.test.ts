import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

// 0118 — note libre sur la commande.
//
// Ce que ces tests verrouillent, et pourquoi :
//  1. Les TROIS rôles (owner, manager, agent) lisent ET écrivent la note, sur
//     une commande `A_APPELER` (avant assignation) ET sur une commande `LIVREE`
//     (après livraison). Les deux états sont hors du WITH CHECK de la policy
//     `orders_update` pour l'agent — c'est exactement ce que la RPC
//     `set_order_note` existe pour permettre sans élargir cette policy.
//  2. Un membre d'un AUTRE marchand ne peut ni lire ni écrire la note.
//  3. Écrire une note ne change aucune dimension ni `cod_status` : ce n'est pas
//     une transition d'état.

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'order-note-rls-test-password';
const createdUserIds: string[] = [];
const skipIfNoServiceRole = serviceRoleKey ? it : it.skip;

type AdminClient = SupabaseClient<Database>;
type TenantRole = 'owner' | 'manager' | 'agent';

function adminClient(): AdminClient {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createUser(admin: AdminClient, email: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error('User creation failed');
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function waitForMerchantAccount(admin: AdminClient, userId: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .maybeSingle();
    if (data?.id) return data.id;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('merchant_account not found');
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

async function seedOrder(
  admin: AdminClient,
  merchantAccountId: string,
  orderNumber: string,
  dimensions: {
    call_state: string;
    cash_state: string;
    delivery_state: string;
    order_state: string;
  },
) {
  const { data, error } = await admin
    .from('orders')
    .insert({
      merchant_account_id: merchantAccountId,
      order_number: orderNumber,
      total_amount: 10000,
      currency: 'XOF',
      ...dimensions,
    })
    .select('id, cod_status')
    .single();
  if (error || !data) throw error ?? new Error('order not created');
  return data;
}

afterEach(async () => {
  if (!serviceRoleKey) return;
  const admin = adminClient();
  await Promise.all(createdUserIds.splice(0).map((id) => admin.auth.admin.deleteUser(id)));
});

describe('0118 — note libre sur la commande', () => {
  skipIfNoServiceRole(
    'owner, manager et agent lisent et ecrivent la note, avant assignation comme apres livraison',
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const ownerEmail = `note-owner-${suffix}@example.com`;
      const ownerId = await createUser(admin, ownerEmail);
      const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

      const managerEmail = `note-manager-${suffix}@example.com`;
      const managerId = await createUser(admin, managerEmail);
      const agentEmail = `note-agent-${suffix}@example.com`;
      const agentId = await createUser(admin, agentEmail);
      await admin.from('merchant_account').delete().in('owner_user_id', [managerId, agentId]);
      await admin.from('merchant_member').insert([
        { merchant_account_id: merchantAccountId, role: 'manager', user_id: managerId },
        { merchant_account_id: merchantAccountId, role: 'agent', user_id: agentId },
      ]);

      // Avant assignation : cod_status = A_APPELER (hors WITH CHECK agent).
      const pendingOrder = await seedOrder(admin, merchantAccountId, `NOTE-PENDING-${suffix}`, {
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });
      expect(pendingOrder.cod_status).toBe('A_APPELER');

      // Apres livraison : cod_status = LIVREE (hors WITH CHECK agent egalement).
      const deliveredOrder = await seedOrder(admin, merchantAccountId, `NOTE-LIVREE-${suffix}`, {
        order_state: 'completed',
        call_state: 'validated',
        delivery_state: 'delivered',
        cash_state: 'collected',
      });
      expect(deliveredOrder.cod_status).toBe('LIVREE');

      const sessions: Array<{ client: SupabaseClient<Database>; role: TenantRole }> = [
        { role: 'owner', client: await signIn(ownerEmail) },
        { role: 'manager', client: await signIn(managerEmail) },
        { role: 'agent', client: await signIn(agentEmail) },
      ];

      const targets = [
        { label: 'A_APPELER', order: pendingOrder },
        { label: 'LIVREE', order: deliveredOrder },
      ];

      for (const { role, client } of sessions) {
        for (const { label, order } of targets) {
          const note = `note ${role} sur ${label}`;

          // ÉCRITURE : la RPC accepte et renvoie la valeur stockee.
          const write = await client.rpc('set_order_note', {
            p_order_id: order.id,
            p_note: note,
          });
          expect(write.error, `${role} doit pouvoir ecrire sur ${label}`).toBeNull();
          expect(write.data).toBe(note);

          // LECTURE : relue par la session du role lui-meme (donc a travers sa
          // propre RLS), pas par le client service-role.
          const read = await client
            .from('orders')
            .select('note, cod_status, order_state, call_state, delivery_state, cash_state')
            .eq('id', order.id)
            .maybeSingle();
          expect(read.error, `${role} doit pouvoir lire sur ${label}`).toBeNull();
          expect(read.data?.note).toBe(note);

          // Ecrire une note n'est PAS une transition : cod_status et les 4
          // dimensions sont inchanges.
          expect(read.data?.cod_status).toBe(order.cod_status);
        }
      }

      // JUSTIFICATION DE LA RPC (sans cette assertion, rien ne prouve que
      // `set_order_note` est necessaire plutot qu'un simple update) : l'agent
      // NE PEUT PAS ecrire la note par un update PostgREST direct sur ces deux
      // etats, car le WITH CHECK de `orders_update` le borne a
      // TENTEE/CONFIRMEE/PROGRAMMEE/EN_LIVRAISON.
      const agentSession = sessions[2].client;
      for (const { label, order } of targets) {
        const direct = await agentSession
          .from('orders')
          .update({ note: `update direct agent ${label}` })
          .eq('id', order.id)
          .select('id');
        expect(direct.error, `update direct agent sur ${label} doit echouer`).not.toBeNull();
      }

      // Vider la note la remet a NULL, jamais a la chaine vide.
      const cleared = await sessions[2].client.rpc('set_order_note', {
        p_order_id: pendingOrder.id,
        p_note: '   ',
      });
      expect(cleared.error).toBeNull();
      expect(cleared.data).toBeNull();
      const { data: afterClear } = await admin
        .from('orders')
        .select('note')
        .eq('id', pendingOrder.id)
        .single();
      expect(afterClear?.note).toBeNull();
    },
  );

  skipIfNoServiceRole(
    'un membre d un autre marchand ne peut ni lire ni ecrire la note',
    async () => {
      const admin = adminClient();
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const ownerEmail = `note-tenant-a-${suffix}@example.com`;
      const ownerId = await createUser(admin, ownerEmail);
      const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

      const outsiderEmail = `note-tenant-b-${suffix}@example.com`;
      const outsiderId = await createUser(admin, outsiderEmail);
      await waitForMerchantAccount(admin, outsiderId);

      const order = await seedOrder(admin, merchantAccountId, `NOTE-ISOLATION-${suffix}`, {
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      });

      const owner = await signIn(ownerEmail);
      const seeded = await owner.rpc('set_order_note', {
        p_order_id: order.id,
        p_note: 'note confidentielle du marchand A',
      });
      expect(seeded.error).toBeNull();

      const outsider = await signIn(outsiderEmail);

      // LECTURE refusee : la policy orders_select filtre la ligne, la requete
      // reussit mais ne renvoie RIEN (pas d'erreur — c'est le comportement RLS).
      const read = await outsider
        .from('orders')
        .select('id, note')
        .eq('id', order.id)
        .maybeSingle();
      expect(read.error).toBeNull();
      expect(read.data).toBeNull();

      // ÉCRITURE refusee : la garde NULL-safe de set_order_note leve `forbidden`
      // (current_member_role renvoie NULL pour un non-membre).
      const write = await outsider.rpc('set_order_note', {
        p_order_id: order.id,
        p_note: 'tentative cross-tenant',
      });
      expect(write.error).not.toBeNull();
      expect(write.error?.message).toContain('forbidden');

      // La note du marchand A est intacte.
      const { data: untouched } = await admin
        .from('orders')
        .select('note')
        .eq('id', order.id)
        .single();
      expect(untouched?.note).toBe('note confidentielle du marchand A');
    },
  );

  skipIfNoServiceRole('une note trop longue est refusee cote base', async () => {
    const admin = adminClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerEmail = `note-length-${suffix}@example.com`;
    const ownerId = await createUser(admin, ownerEmail);
    const merchantAccountId = await waitForMerchantAccount(admin, ownerId);

    const order = await seedOrder(admin, merchantAccountId, `NOTE-LENGTH-${suffix}`, {
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    });

    const owner = await signIn(ownerEmail);
    const tooLong = await owner.rpc('set_order_note', {
      p_order_id: order.id,
      p_note: 'x'.repeat(501),
    });
    expect(tooLong.error).not.toBeNull();
    expect(tooLong.error?.message).toContain('note_too_long');

    const exactLimit = await owner.rpc('set_order_note', {
      p_order_id: order.id,
      p_note: 'y'.repeat(500),
    });
    expect(exactLimit.error).toBeNull();
    expect(exactLimit.data).toHaveLength(500);
  });
});
