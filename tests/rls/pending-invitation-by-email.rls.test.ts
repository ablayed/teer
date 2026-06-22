import { createHash } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it } from 'vitest';

const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const password = 'mot-de-passe-test-rls';

const createdUserIds: string[] = [];
const createdEmails: string[] = [];

type GenericRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>;

function serviceClient() {
  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createAuthUser(email: string) {
  const { data, error } = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(error).toBeNull();
  const user = data.user;
  if (!user) {
    throw new Error(`Utilisateur ${email} non créé`);
  }
  createdUserIds.push(user.id);
  createdEmails.push(email);
  return user;
}

async function createUser(label: string, emailOverride?: string) {
  const email =
    emailOverride ?? `pending-invite-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
  const user = await createAuthUser(email);
  return { id: user.id, email };
}

async function signIn(email: string) {
  const client = createClient<Database>(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  expect(error).toBeNull();
  return client;
}

async function ownedAccountId(userId: string) {
  const { data, error } = await serviceClient()
    .from('merchant_account')
    .select('id')
    .eq('owner_user_id', userId)
    .single();
  expect(error).toBeNull();
  if (!data) {
    throw new Error('Compte marchand introuvable');
  }
  return data.id;
}

async function renameAccount(accountId: string, name: string) {
  const { error } = await serviceClient()
    .from('merchant_account')
    .update({ name })
    .eq('id', accountId);
  expect(error).toBeNull();
}

async function createInvitation(params: {
  merchantAccountId: string;
  invitedBy: string;
  email: string;
  role: 'manager' | 'agent';
  expiresAt?: string;
}) {
  const token = `pending-email-token-${crypto.randomUUID()}`;
  const invitationInsert: Database['public']['Tables']['invitation']['Insert'] = {
    merchant_account_id: params.merchantAccountId,
    invited_by: params.invitedBy,
    email: params.email.toLowerCase(),
    role: params.role,
    token_hash: `\\x${createHash('sha256').update(token).digest('hex')}`,
  };

  if (params.expiresAt) {
    invitationInsert.expires_at = params.expiresAt;
  }

  const { data, error } = await serviceClient()
    .from('invitation')
    .insert(invitationInsert)
    .select('*')
    .single();
  expect(error).toBeNull();
  if (!data) {
    throw new Error('Invitation non créée');
  }
  return data;
}

async function merchantMemberships(userId: string) {
  const { data, error } = await serviceClient()
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', userId);
  expect(error).toBeNull();
  return data ?? [];
}

async function inviteAcceptedAudits(invitationId: string) {
  const { data, error } = await serviceClient()
    .from('audit_log')
    .select('action, resource_id')
    .eq('action', 'invite_accepted')
    .eq('resource_id', invitationId);
  expect(error).toBeNull();
  return data ?? [];
}

function expectRpcErrorMessage(
  error: { message?: string | null; code?: string | null } | null,
  message: string,
) {
  expect(error).not.toBeNull();
  expect(error?.message).toContain(message);
}

afterEach(async () => {
  if (!supabaseUrl || !serviceRoleKey) {
    return;
  }

  const service = serviceClient();

  if (createdUserIds.length > 0) {
    await service.from('audit_log').delete().in('actor_user_id', createdUserIds);
    await service.from('merchant_member').delete().in('user_id', createdUserIds);
    await service.from('invitation').delete().in('invited_by', createdUserIds);
    await service.from('invitation').delete().in('accepted_by', createdUserIds);
  }

  if (createdEmails.length > 0) {
    await service
      .from('invitation')
      .delete()
      .in(
        'email',
        createdEmails.map((email) => email.toLowerCase()),
      );
  }

  if (createdUserIds.length > 0) {
    await service.from('merchant_account').delete().in('owner_user_id', createdUserIds);
    await Promise.all(createdUserIds.map((id) => service.auth.admin.deleteUser(id)));
  }

  createdUserIds.length = 0;
  createdEmails.length = 0;
});

describe('Pending invitation fallback RPCs', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'list_my_pending_invitations ne renvoie que les invitations pending non expirées du user connecté',
    async () => {
      const ownerA = await createUser('owner-list-a');
      const ownerB = await createUser('owner-list-b');
      const ownerC = await createUser('owner-list-c');
      const accountA = await ownedAccountId(ownerA.id);
      const accountB = await ownedAccountId(ownerB.id);
      const accountC = await ownedAccountId(ownerC.id);
      await renameAccount(accountA, 'Org Alpha');
      await renameAccount(accountB, 'Org Beta');
      await renameAccount(accountC, 'Org Gamma');

      const invitedEmail = `pending-list-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const otherEmail = `pending-list-other-${Date.now()}-${crypto.randomUUID()}@example.com`;

      const invitationA = await createInvitation({
        merchantAccountId: accountA,
        invitedBy: ownerA.id,
        email: invitedEmail,
        role: 'manager',
      });
      const invitationB = await createInvitation({
        merchantAccountId: accountB,
        invitedBy: ownerB.id,
        email: invitedEmail,
        role: 'agent',
      });
      await createInvitation({
        merchantAccountId: accountC,
        invitedBy: ownerC.id,
        email: invitedEmail,
        role: 'agent',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await createInvitation({
        merchantAccountId: accountA,
        invitedBy: ownerA.id,
        email: otherEmail,
        role: 'agent',
      });

      await createUser('pending-list-invited', invitedEmail);
      const invitedClient = await signIn(invitedEmail);

      const { data, error } = await (invitedClient.rpc as unknown as GenericRpc)(
        'list_my_pending_invitations',
        {},
      );

      expect(error).toBeNull();
      expect(data).toHaveLength(2);
      expect(data).toEqual(
        expect.arrayContaining([
          {
            id: invitationA.id,
            merchant_account_id: accountA,
            org_name: 'Org Alpha',
            role: 'manager',
            expires_at: invitationA.expires_at,
          },
          {
            id: invitationB.id,
            merchant_account_id: accountB,
            org_name: 'Org Beta',
            role: 'agent',
            expires_at: invitationB.expires_at,
          },
        ]),
      );
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_pending_invitation_by_email rattache le user invité avec le bon rôle',
    async () => {
      const owner = await createUser('owner-accept');
      const merchantAccountId = await ownedAccountId(owner.id);
      await renameAccount(merchantAccountId, 'Org Acceptation');

      const invitedEmail = `pending-accept-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const invitation = await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: invitedEmail,
        role: 'agent',
      });

      const invitedUser = await createUser('pending-accept-invited', invitedEmail);
      const invitedClient = await signIn(invitedEmail);

      const { data, error } = await (invitedClient.rpc as unknown as GenericRpc)(
        'accept_pending_invitation_by_email',
        {
          p_invitation_id: invitation.id,
        },
      );

      expect(error).toBeNull();
      expect(data).toMatchObject({
        ok: true,
        merchant_account_id: merchantAccountId,
        role: 'agent',
      });

      const memberships = await merchantMemberships(invitedUser.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({
        merchant_account_id: merchantAccountId,
        role: 'agent',
      });

      const { data: invitationRow, error: invitationError } = await serviceClient()
        .from('invitation')
        .select('status, accepted_by')
        .eq('id', invitation.id)
        .single();
      expect(invitationError).toBeNull();
      expect(invitationRow).toMatchObject({
        status: 'accepted',
        accepted_by: invitedUser.id,
      });

      const audits = await inviteAcceptedAudits(invitation.id);
      expect(audits).toHaveLength(1);
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_pending_invitation_by_email refuse une invitation expirée',
    async () => {
      const ownerExpired = await createUser('owner-expired');
      const ownerGuard = await createUser('owner-expired-guard');
      const expiredAccountId = await ownedAccountId(ownerExpired.id);
      const guardAccountId = await ownedAccountId(ownerGuard.id);

      const invitedEmail = `pending-expired-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const expiredInvitation = await createInvitation({
        merchantAccountId: expiredAccountId,
        invitedBy: ownerExpired.id,
        email: invitedEmail,
        role: 'manager',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await createInvitation({
        merchantAccountId: guardAccountId,
        invitedBy: ownerGuard.id,
        email: invitedEmail,
        role: 'agent',
      });

      await createUser('pending-expired-invited', invitedEmail);
      const invitedClient = await signIn(invitedEmail);

      const { data, error } = await (invitedClient.rpc as unknown as GenericRpc)(
        'accept_pending_invitation_by_email',
        {
          p_invitation_id: expiredInvitation.id,
        },
      );

      expect(data).toBeNull();
      expectRpcErrorMessage(error, 'expired_invitation');
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_pending_invitation_by_email renvoie already_has_organization pour un user déjà membre ailleurs',
    async () => {
      const owner = await createUser('owner-legacy');
      const merchantAccountId = await ownedAccountId(owner.id);
      const legacyUser = await createUser('legacy-user');
      const invitation = await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: legacyUser.email,
        role: 'manager',
      });

      const legacyClient = await signIn(legacyUser.email);
      const { data, error } = await (legacyClient.rpc as unknown as GenericRpc)(
        'accept_pending_invitation_by_email',
        {
          p_invitation_id: invitation.id,
        },
      );

      expect(data).toBeNull();
      expectRpcErrorMessage(error, 'already_has_organization');

      const memberships = await merchantMemberships(legacyUser.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'un user ne peut pas accepter par id une invitation adressée à un autre email',
    async () => {
      const ownerAllowed = await createUser('owner-email-ok');
      const ownerTarget = await createUser('owner-email-target');
      const allowedAccountId = await ownedAccountId(ownerAllowed.id);
      const targetAccountId = await ownedAccountId(ownerTarget.id);

      const userEmail = `pending-email-user-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const otherEmail = `pending-email-other-${Date.now()}-${crypto.randomUUID()}@example.com`;

      await createInvitation({
        merchantAccountId: allowedAccountId,
        invitedBy: ownerAllowed.id,
        email: userEmail,
        role: 'agent',
      });
      const foreignInvitation = await createInvitation({
        merchantAccountId: targetAccountId,
        invitedBy: ownerTarget.id,
        email: otherEmail,
        role: 'manager',
      });

      const invitedUser = await createUser('pending-email-user', userEmail);
      const invitedClient = await signIn(userEmail);

      const { data, error } = await (invitedClient.rpc as unknown as GenericRpc)(
        'accept_pending_invitation_by_email',
        {
          p_invitation_id: foreignInvitation.id,
        },
      );

      expect(data).toBeNull();
      expectRpcErrorMessage(error, 'email_mismatch');

      const memberships = await merchantMemberships(invitedUser.id);
      expect(memberships).toEqual([]);
    },
  );
});
