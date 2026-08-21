'use server';

import { type TeamRole, requireRole } from '@/lib/actions/safe-action';
import { sendTeamInvitationEmail } from '@/lib/email/team-invitation';
import { env } from '@/lib/env';
import { writePcdAccessAudit } from '@/lib/security/pcd-access-audit';
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import { generateInvitationToken, hashInvitationToken } from '@/lib/team/invitation-token';
import {
  canChangeMemberRole,
  canInviteRole,
  canRemoveMember,
  isTeamRole,
} from '@/lib/team/permissions';
import { getRequestStoreId } from '@/lib/workspace/store';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const inviteRoles = ['manager', 'agent'] as const;
const memberRoles = ['owner', 'manager', 'agent'] as const;

const inviteMemberSchema = z.object({
  email: z.string().trim().email().max(320),
  role: z.enum(inviteRoles),
});

const invitationIdSchema = z.object({
  invitationId: z.string().uuid(),
});

const changeRoleSchema = z.object({
  memberId: z.string().uuid(),
  newRole: z.enum(memberRoles),
});

const removeMemberSchema = z.object({
  memberId: z.string().uuid(),
});

const createDriverSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(32),
});

const updateDriverSchema = createDriverSchema.extend({
  driverId: z.string().uuid(),
  isActive: z.boolean().optional(),
});

const removeDriverSchema = z.object({
  driverId: z.string().uuid(),
});

type InviteRole = (typeof inviteRoles)[number];
type AuthUserSummary = {
  id: string;
  email: string | null;
  fullName: string | null;
};

type TeamAuditAction =
  | 'invite_sent'
  | 'invite_resent'
  | 'invite_revoked'
  | 'role_changed'
  | 'member_removed'
  | 'driver_created'
  | 'driver_updated'
  | 'driver_deactivated'
  | 'driver_deleted';

type TeamMemberRow = Pick<
  Tables<'merchant_member'>,
  'created_at' | 'id' | 'merchant_account_id' | 'role' | 'user_id'
>;
type InvitationRow = Pick<
  Tables<'invitation'>,
  'created_at' | 'email' | 'expires_at' | 'id' | 'role' | 'status'
>;
type DriverRow = Pick<
  Tables<'driver'>,
  'created_at' | 'full_name' | 'id' | 'is_active' | 'phone' | 'user_id'
>;

function createSupabaseAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function expiresInSevenDays(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

// Lien d'invitation complet. Le token clair n'existe qu'à la création (seul
// son hash est stocké) : c'est l'unique moment où l'on peut le renvoyer pour
// un partage WhatsApp / copier-coller. Même base que l'e-mail Resend.
function buildInvitationUrl(token: string): string {
  const url = new URL('/invitation/accept', env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

function revalidateTeamPaths() {
  revalidatePath('/parametres');
}

async function getMerchantAccountName(merchantAccountId: string): Promise<string | null> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from('merchant_account')
    .select('name')
    .eq('id', merchantAccountId)
    .is('deleted_at', null)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data.name;
}

async function writeTeamAuditLog({
  action,
  actorUserId,
  merchantAccountId,
  payload,
  resourceId,
  resourceType,
}: {
  action: TeamAuditAction;
  actorUserId: string;
  merchantAccountId: string;
  payload?: Json;
  resourceId?: string | null;
  resourceType: 'invitation' | 'merchant_member' | 'driver';
}) {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from('audit_log').insert({
    merchant_account_id: merchantAccountId,
    actor_user_id: actorUserId,
    action,
    resource_type: resourceType,
    resource_id: resourceId ?? null,
    payload,
  });

  return error;
}

async function findAuthUserByEmail(email: string): Promise<AuthUserSummary | null> {
  const admin = createSupabaseAdminClient();
  let page = 1;

  while (page <= 10) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });

    if (error) {
      throw error;
    }

    const user = data.users.find((candidate) => candidate.email?.toLowerCase() === email);

    if (user) {
      const metadata = user.user_metadata as { full_name?: unknown; name?: unknown } | null;
      const fullName =
        typeof metadata?.full_name === 'string'
          ? metadata.full_name
          : typeof metadata?.name === 'string'
            ? metadata.name
            : null;

      return {
        id: user.id,
        email: user.email ?? null,
        fullName,
      };
    }

    if (data.users.length < 1000) {
      return null;
    }

    page += 1;
  }

  return null;
}

async function getAuthUsersById(userIds: string[]): Promise<Map<string, AuthUserSummary>> {
  const uniqueIds = [...new Set(userIds)];
  const users = await Promise.all(
    uniqueIds.map(async (userId) => {
      const admin = createSupabaseAdminClient();
      const { data, error } = await admin.auth.admin.getUserById(userId);

      if (error || !data.user) {
        return null;
      }

      const metadata = data.user.user_metadata as { full_name?: unknown; name?: unknown } | null;
      const fullName =
        typeof metadata?.full_name === 'string'
          ? metadata.full_name
          : typeof metadata?.name === 'string'
            ? metadata.name
            : null;

      return {
        id: data.user.id,
        email: data.user.email ?? null,
        fullName,
      };
    }),
  );

  return new Map(
    users.filter((user): user is AuthUserSummary => user !== null).map((user) => [user.id, user]),
  );
}

async function countOwners(merchantAccountId: string): Promise<number> {
  const admin = createSupabaseAdminClient();
  const { count, error } = await admin
    .from('merchant_member')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', merchantAccountId)
    .eq('role', 'owner');

  if (error) {
    throw error;
  }

  return count ?? 0;
}

async function sendInvitationOrFail({
  accountName,
  email,
  invitedByEmail,
  role,
  token,
}: {
  accountName: string;
  email: string;
  invitedByEmail: string;
  role: InviteRole;
  token: string;
}): Promise<boolean> {
  const { error } = await sendTeamInvitationEmail({
    accountName,
    email,
    invitedByEmail,
    role,
    token,
  });

  return !error;
}

function forbidden(): { ok: false; errorCode: 'forbidden' } {
  return { ok: false, errorCode: 'forbidden' };
}

export const inviteMemberAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.invite_member', section: 'team' })
  .inputSchema(inviteMemberSchema)
  .action(async ({ ctx, parsedInput }) => {
    const email = normalizeEmail(parsedInput.email);
    const admin = createSupabaseAdminClient();
    const accountName = await getMerchantAccountName(ctx.member.merchantAccountId);

    if (!canInviteRole(ctx.member.role, parsedInput.role)) {
      return forbidden();
    }

    if (!accountName) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    const existingUser = await findAuthUserByEmail(email);

    if (existingUser) {
      const { data: existingMember, error: existingMemberError } = await admin
        .from('merchant_member')
        .select('id')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('user_id', existingUser.id)
        .maybeSingle();

      if (existingMemberError) {
        return { ok: false as const, errorCode: 'update_failed' as const };
      }

      if (existingMember) {
        return { ok: false as const, errorCode: 'member_conflict' as const };
      }
    }

    const { data: pendingInvitation, error: pendingError } = await admin
      .from('invitation')
      .select('id')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('email', email)
      .eq('status', 'pending')
      .maybeSingle();

    if (pendingError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (pendingInvitation) {
      return { ok: false as const, errorCode: 'invitation_conflict' as const };
    }

    const token = generateInvitationToken();
    const { data: invitation, error: insertError } = await admin
      .from('invitation')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        email,
        role: parsedInput.role,
        token_hash: hashInvitationToken(token),
        invited_by: ctx.user.id,
        expires_at: expiresInSevenDays(),
      })
      .select('id')
      .single();

    if (insertError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    // Envoi Resend BEST-EFFORT : l'invitation est déjà créée et le lien clair
    // est renvoyé pour un partage manuel (WhatsApp / copier). Un échec d'e-mail
    // (Resend down, quota, secret absent en local) ne doit plus faire échouer
    // l'action ni perdre l'invitation. On signale juste `emailSent: false`.
    let emailSent = false;
    try {
      emailSent = await sendInvitationOrFail({
        accountName,
        email,
        invitedByEmail: ctx.user.email ?? 'Tëër',
        role: parsedInput.role,
        token,
      });
    } catch {
      emailSent = false;
    }

    const auditError = await writeTeamAuditLog({
      action: 'invite_sent',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      payload: { email, role: parsedInput.role },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return {
      ok: true as const,
      inviteUrl: buildInvitationUrl(token),
      email,
      role: parsedInput.role,
      emailSent,
    };
  });

export const resendInviteAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.resend_invite', section: 'team' })
  .inputSchema(invitationIdSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const accountName = await getMerchantAccountName(ctx.member.merchantAccountId);

    if (!accountName) {
      return { ok: false as const, errorCode: 'merchant_not_found' as const };
    }

    const { data: invitation, error: invitationError } = await admin
      .from('invitation')
      .select('id, email, role, status')
      .eq('id', parsedInput.invitationId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (invitationError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!invitation || invitation.status !== 'pending') {
      return { ok: false as const, errorCode: 'invitation_not_found' as const };
    }

    if (!inviteRoles.includes(invitation.role as InviteRole)) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const token = generateInvitationToken();
    const { error: updateError } = await admin
      .from('invitation')
      .update({
        token_hash: hashInvitationToken(token),
        expires_at: expiresInSevenDays(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', invitation.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    // « Renvoyer » régénère le token (token_hash + expires_at mis à jour ci-dessus) :
    // c'est aussi le seul moyen de ré-obtenir un lien clair partageable pour une
    // invitation déjà en attente (le token clair d'origine est perdu). Envoi Resend
    // BEST-EFFORT (cf. inviteMemberAction) ; on renvoie toujours le lien frais.
    const role = invitation.role as InviteRole;
    let emailSent = false;
    try {
      emailSent = await sendInvitationOrFail({
        accountName,
        email: invitation.email,
        invitedByEmail: ctx.user.email ?? 'Tëër',
        role,
        token,
      });
    } catch {
      emailSent = false;
    }

    const auditError = await writeTeamAuditLog({
      action: 'invite_resent',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      payload: { email: invitation.email, role },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return {
      ok: true as const,
      inviteUrl: buildInvitationUrl(token),
      email: invitation.email,
      role,
      emailSent,
    };
  });

export const revokeInviteAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.revoke_invite', section: 'team' })
  .inputSchema(invitationIdSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: invitation, error: invitationError } = await admin
      .from('invitation')
      .select('id, email, role, status')
      .eq('id', parsedInput.invitationId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (invitationError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!invitation || invitation.status !== 'pending') {
      return { ok: false as const, errorCode: 'invitation_not_found' as const };
    }

    const { error: updateError } = await admin
      .from('invitation')
      .update({ status: 'revoked', updated_at: new Date().toISOString() })
      .eq('id', invitation.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'invite_revoked',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      payload: { email: invitation.email, role: invitation.role },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const };
  });

export const changeRoleAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.change_role', section: 'team' })
  .inputSchema(changeRoleSchema)
  .action(async ({ ctx, parsedInput }) => {
    if (ctx.member.role !== 'owner' && parsedInput.newRole === 'owner') {
      return forbidden();
    }

    const admin = createSupabaseAdminClient();
    const { data: member, error: memberError } = await admin
      .from('merchant_member')
      .select('id, merchant_account_id, role, user_id, created_at')
      .eq('id', parsedInput.memberId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (memberError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!member || !isTeamRole(member.role)) {
      return { ok: false as const, errorCode: 'member_not_found' as const };
    }

    const ownerCount = await countOwners(ctx.member.merchantAccountId);

    if (
      !canChangeMemberRole({
        actorRole: ctx.member.role,
        targetRole: member.role,
        newRole: parsedInput.newRole,
        ownerCount,
      })
    ) {
      return member.role === 'owner' && parsedInput.newRole !== 'owner' && ownerCount <= 1
        ? { ok: false as const, errorCode: 'last_owner' as const }
        : forbidden();
    }

    const { error: updateError } = await admin
      .from('merchant_member')
      .update({ role: parsedInput.newRole })
      .eq('id', member.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'role_changed',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'merchant_member',
      resourceId: member.id,
      payload: { before: member.role, after: parsedInput.newRole, userId: member.user_id },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const };
  });

export const removeMemberAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.remove_member', section: 'team' })
  .inputSchema(removeMemberSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: member, error: memberError } = await admin
      .from('merchant_member')
      .select('id, merchant_account_id, role, user_id, created_at')
      .eq('id', parsedInput.memberId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (memberError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!member || !isTeamRole(member.role)) {
      return { ok: false as const, errorCode: 'member_not_found' as const };
    }

    const ownerCount = await countOwners(ctx.member.merchantAccountId);

    if (!canRemoveMember({ actorRole: ctx.member.role, targetRole: member.role, ownerCount })) {
      return member.role === 'owner' && ownerCount <= 1
        ? { ok: false as const, errorCode: 'last_owner' as const }
        : forbidden();
    }

    const { error: deleteError } = await admin
      .from('merchant_member')
      .delete()
      .eq('id', member.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (deleteError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'member_removed',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'merchant_member',
      resourceId: member.id,
      payload: { role: member.role, userId: member.user_id },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const };
  });

export const listTeamAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.list', section: 'team' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const admin = createSupabaseAdminClient();
    const [membersResult, invitationsResult, driversResult] = await Promise.all([
      admin
        .from('merchant_member')
        .select('id, merchant_account_id, role, user_id, created_at')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .order('created_at', { ascending: true }),
      admin
        .from('invitation')
        .select('id, email, role, status, expires_at, created_at')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .eq('status', 'pending')
        .order('created_at', { ascending: false }),
      admin
        .from('driver')
        .select('id, full_name, phone, user_id, is_active, created_at')
        .eq('merchant_account_id', ctx.member.merchantAccountId)
        .order('created_at', { ascending: false }),
    ]);

    if (membersResult.error || invitationsResult.error || driversResult.error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const members = (membersResult.data ?? []) as TeamMemberRow[];
    const invitations = (invitationsResult.data ?? []) as InvitationRow[];
    const drivers = (driversResult.data ?? []) as DriverRow[];
    const usersById = await getAuthUsersById(members.map((member) => member.user_id));

    try {
      await writePcdAccessAudit(ctx.supabase as unknown as SupabaseClient<Database>, {
        tenantId: ctx.member.merchantAccountId,
        actorKind: 'human',
        action: 'list_access',
        dataCategory: 'member_data',
        purpose: 'system_processing',
        outcome: 'succeeded',
        resourceType: 'member',
        surface: 'server_action',
        metadata: { result_count: Math.min(members.length + drivers.length, 500), page_size: 500 },
      });
    } catch {
      return { ok: false as const, errorCode: 'audit_unavailable' as const };
    }

    return {
      ok: true as const,
      currentUserId: ctx.user.id,
      currentRole: ctx.member.role as TeamRole,
      members: members.map((member) => {
        const user = usersById.get(member.user_id);

        return {
          id: member.id,
          userId: member.user_id,
          role: member.role as TeamRole,
          email: user?.email ?? null,
          fullName: user?.fullName ?? null,
          createdAt: member.created_at,
          isSelf: member.user_id === ctx.user.id,
        };
      }),
      invitations: invitations.map((invitation) => ({
        id: invitation.id,
        email: invitation.email,
        role: invitation.role as InviteRole,
        expiresAt: invitation.expires_at,
        createdAt: invitation.created_at,
      })),
      drivers: drivers.map((driver) => ({
        id: driver.id,
        fullName: driver.full_name,
        phone: driver.phone,
        userId: driver.user_id,
        isActive: driver.is_active,
        createdAt: driver.created_at,
      })),
    };
  });

export const createDriverAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.create_driver', section: 'team' })
  .inputSchema(createDriverSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: driver, error: insertError } = await admin
      .from('driver')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        full_name: parsedInput.fullName,
        phone: parsedInput.phone,
      })
      .select('id')
      .single();

    if (insertError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    // 0133 — rattacher le livreur à la boutique ACTIVE. Sans cette ligne il
    // n'apparaîtrait dans AUCUNE boutique : `/livreurs` et le sélecteur
    // d'affectation lisent désormais `driver_shop`, pas `driver` seule.
    // Repli sur la boutique par défaut hors contexte de boutique, pour qu'un
    // livreur créé depuis un chemin sans boutique reste atteignable.
    const activeShopId =
      (await getRequestStoreId()) ??
      (
        await admin
          .from('shop')
          .select('id')
          .eq('merchant_account_id', ctx.member.merchantAccountId)
          .eq('is_default', true)
          .maybeSingle()
      ).data?.id;

    if (!activeShopId) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const { error: membershipError } = await admin.from('driver_shop').insert({
      merchant_account_id: ctx.member.merchantAccountId,
      shop_id: activeShopId,
      driver_id: driver.id,
    });

    if (membershipError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'driver_created',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'driver',
      resourceId: driver.id,
      payload: { fullName: parsedInput.fullName, phone: parsedInput.phone },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const, driverId: driver.id };
  });

export const updateDriverAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.update_driver', section: 'team' })
  .inputSchema(updateDriverSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const { data: driver, error: driverError } = await admin
      .from('driver')
      .select('id')
      .eq('id', parsedInput.driverId)
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .maybeSingle();

    if (driverError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!driver) {
      return { ok: false as const, errorCode: 'driver_not_found' as const };
    }

    const { error: updateError } = await admin
      .from('driver')
      .update({
        full_name: parsedInput.fullName,
        phone: parsedInput.phone,
        ...(parsedInput.isActive === undefined ? {} : { is_active: parsedInput.isActive }),
      })
      .eq('id', driver.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'driver_updated',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'driver',
      resourceId: driver.id,
      payload: {
        fullName: parsedInput.fullName,
        phone: parsedInput.phone,
        isActive: parsedInput.isActive ?? null,
      },
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const };
  });

// Supprime un livreur si totalement vierge (aucune commande assignée, aucun
// cash, aucun mouvement de stock) ; sinon le désactive (is_active=false) pour
// préserver l'historique et les invariants. owner/manager uniquement.
export const removeDriverAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.remove_driver', section: 'team' })
  .inputSchema(removeDriverSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createSupabaseAdminClient();
    const merchantAccountId = ctx.member.merchantAccountId;

    const { data: driver, error: driverError } = await admin
      .from('driver')
      .select('id')
      .eq('id', parsedInput.driverId)
      .eq('merchant_account_id', merchantAccountId)
      .maybeSingle();

    if (driverError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    if (!driver) {
      return { ok: false as const, errorCode: 'driver_not_found' as const };
    }

    // Le livreur a-t-il un historique (commandes assignées, cash, stock en main) ?
    const [orders, settlements, shortfalls, movements] = await Promise.all([
      admin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId)
        .eq('assigned_driver_id', driver.id),
      admin
        .from('cash_settlement')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driver.id),
      admin
        .from('settlement_shortfall')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driver.id),
      admin
        .from('stock_movement')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', merchantAccountId)
        .eq('driver_id', driver.id),
    ]);

    if (orders.error || settlements.error || shortfalls.error || movements.error) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const hasHistory =
      (orders.count ?? 0) > 0 ||
      (settlements.count ?? 0) > 0 ||
      (shortfalls.count ?? 0) > 0 ||
      (movements.count ?? 0) > 0;

    if (hasHistory) {
      // Désactivation : préserve l'historique et les invariants de stock/cash.
      const { error: updateError } = await admin
        .from('driver')
        .update({ is_active: false })
        .eq('id', driver.id)
        .eq('merchant_account_id', merchantAccountId);

      if (updateError) {
        return { ok: false as const, errorCode: 'update_failed' as const };
      }

      const auditError = await writeTeamAuditLog({
        action: 'driver_deactivated',
        actorUserId: ctx.user.id,
        merchantAccountId,
        resourceType: 'driver',
        resourceId: driver.id,
      });

      if (auditError) {
        return { ok: false as const, errorCode: 'audit_failed' as const };
      }

      revalidateTeamPaths();

      return { ok: true as const, mode: 'deactivated' as const };
    }

    // Suppression dure : livreur totalement vierge.
    const { error: deleteError } = await admin
      .from('driver')
      .delete()
      .eq('id', driver.id)
      .eq('merchant_account_id', merchantAccountId);

    if (deleteError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'driver_deleted',
      actorUserId: ctx.user.id,
      merchantAccountId,
      resourceType: 'driver',
      resourceId: driver.id,
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const, mode: 'deleted' as const };
  });
