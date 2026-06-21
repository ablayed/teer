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
    emailOverride ?? `inv-guard-${label}-${Date.now()}-${crypto.randomUUID()}@example.com`;
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

async function listOwnedAccounts(userId: string) {
  const { data, error } = await serviceClient()
    .from('merchant_account')
    .select('id, name')
    .eq('owner_user_id', userId);
  expect(error).toBeNull();
  return data ?? [];
}

async function ownedAccountId(userId: string) {
  const accounts = await listOwnedAccounts(userId);
  expect(accounts).toHaveLength(1);
  return accounts[0].id;
}

async function createInvitation(params: {
  merchantAccountId: string;
  invitedBy: string;
  email: string;
  role: 'manager' | 'agent';
  token: string;
  expiresAt?: string;
}) {
  const invitationInsert: Database['public']['Tables']['invitation']['Insert'] = {
    merchant_account_id: params.merchantAccountId,
    invited_by: params.invitedBy,
    email: params.email.toLowerCase(),
    role: params.role,
    token_hash: `\\x${createHash('sha256').update(params.token).digest('hex')}`,
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
    .select('id, merchant_account_id, role')
    .eq('user_id', userId);
  expect(error).toBeNull();
  return data ?? [];
}

async function accountCreatedAudits(userId: string) {
  const { data, error } = await serviceClient()
    .from('audit_log')
    .select('id, merchant_account_id, action')
    .eq('actor_user_id', userId)
    .eq('action', 'account.created');
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

describe('Invitation guardrail and conditional signup trigger', () => {
  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'signup sans invitation pending crée toujours org + owner + audit',
    async () => {
      const user = await createUser('plain-signup');

      const ownedAccounts = await listOwnedAccounts(user.id);
      const memberships = await merchantMemberships(user.id);
      const audits = await accountCreatedAudits(user.id);

      expect(ownedAccounts).toHaveLength(1);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.merchant_account_id).toBe(ownedAccounts[0]?.id);
      expect(memberships[0]?.role).toBe('owner');
      expect(audits).toHaveLength(1);
      expect(audits[0]?.merchant_account_id).toBe(ownedAccounts[0]?.id);
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'signup avec invitation pending non expirée ne crée aucune org fantôme',
    async () => {
      const owner = await createUser('owner-pending');
      const merchantAccountId = await ownedAccountId(owner.id);
      const invitedEmail = `invited-pending-${Date.now()}-${crypto.randomUUID()}@example.com`;

      await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: invitedEmail,
        role: 'manager',
        token: `pending-token-${crypto.randomUUID()}`,
      });

      const invitedUser = await createUser('invited-pending', invitedEmail);

      const ownedAccounts = await listOwnedAccounts(invitedUser.id);
      const memberships = await merchantMemberships(invitedUser.id);
      const audits = await accountCreatedAudits(invitedUser.id);

      expect(ownedAccounts).toEqual([]);
      expect(memberships).toEqual([]);
      expect(audits).toEqual([]);
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_invitation rattache ensuite le user invité à l’org du marchand avec le bon rôle',
    async () => {
      const owner = await createUser('owner-accept');
      const merchantAccountId = await ownedAccountId(owner.id);
      const invitedEmail = `invited-accept-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const token = `accept-token-${crypto.randomUUID()}`;

      await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: invitedEmail,
        role: 'agent',
        token,
      });

      const invitedUser = await createUser('invited-accept', invitedEmail);
      const invitedClient = await signIn(invitedEmail);

      const { data, error } = await invitedClient.rpc('accept_invitation', { p_token: token });

      expect(error).toBeNull();
      expect(data).toMatchObject({
        ok: true,
        merchant_account_id: merchantAccountId,
        role: 'agent',
      });

      const memberships = await merchantMemberships(invitedUser.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.merchant_account_id).toBe(merchantAccountId);
      expect(memberships[0]?.role).toBe('agent');

      const { data: acceptedInvitation, error: invitationError } = await serviceClient()
        .from('invitation')
        .select('status, accepted_by')
        .eq('merchant_account_id', merchantAccountId)
        .eq('email', invitedEmail.toLowerCase())
        .single();
      expect(invitationError).toBeNull();
      expect(acceptedInvitation).toMatchObject({
        status: 'accepted',
        accepted_by: invitedUser.id,
      });
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'le garde-fou bloque un insert merchant_member si le user appartient déjà à une autre org',
    async () => {
      const ownerA = await createUser('owner-a');
      const ownerB = await createUser('owner-b');
      const accountB = await ownedAccountId(ownerB.id);

      const { error } = await serviceClient().from('merchant_member').insert({
        merchant_account_id: accountB,
        user_id: ownerA.id,
        role: 'manager',
      });

      expect(error).not.toBeNull();
      expect(error?.code).toBe('P0001');
      expect(error?.message).toContain('already_has_organization');
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_invitation renvoie already_has_organization pour un user legacy déjà rattaché à sa propre org',
    async () => {
      const owner = await createUser('legacy-owner');
      const merchantAccountId = await ownedAccountId(owner.id);
      const legacyUser = await createUser('legacy-user');
      const token = `legacy-token-${crypto.randomUUID()}`;

      await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: legacyUser.email,
        role: 'manager',
        token,
      });

      const legacyClient = await signIn(legacyUser.email);
      const { data, error } = await legacyClient.rpc('accept_invitation', { p_token: token });

      expect(data).toBeNull();
      expectRpcErrorMessage(error, 'already_has_organization');

      const memberships = await merchantMemberships(legacyUser.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');

      const { data: invitationRow, error: invitationError } = await serviceClient()
        .from('invitation')
        .select('status, accepted_by')
        .eq('merchant_account_id', merchantAccountId)
        .eq('email', legacyUser.email)
        .single();
      expect(invitationError).toBeNull();
      expect(invitationRow).toMatchObject({
        status: 'pending',
        accepted_by: null,
      });
    },
  );

  it.skipIf(!process.env.SUPABASE_SERVICE_ROLE_KEY)(
    'accept_invitation continue de gérer email_mismatch et expiration',
    async () => {
      const owner = await createUser('owner-errors');
      const merchantAccountId = await ownedAccountId(owner.id);

      const mismatchToken = `mismatch-token-${crypto.randomUUID()}`;
      await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: `other-${Date.now()}-${crypto.randomUUID()}@example.com`,
        role: 'manager',
        token: mismatchToken,
      });

      const invitedUser = await createUser('mismatch-user');
      const invitedClient = await signIn(invitedUser.email);
      const mismatchResult = await invitedClient.rpc('accept_invitation', {
        p_token: mismatchToken,
      });
      expectRpcErrorMessage(mismatchResult.error, 'email_mismatch');

      const expiredEmail = `expired-${Date.now()}-${crypto.randomUUID()}@example.com`;
      const expiredToken = `expired-token-${crypto.randomUUID()}`;
      await createInvitation({
        merchantAccountId,
        invitedBy: owner.id,
        email: expiredEmail,
        role: 'agent',
        token: expiredToken,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });

      await createUser('expired-user', expiredEmail);
      const expiredClient = await signIn(expiredEmail);
      const expiredResult = await expiredClient.rpc('accept_invitation', { p_token: expiredToken });
      expectRpcErrorMessage(expiredResult.error, 'expired_invitation');
    },
  );
});
