'use server';

import { type TeamRole, requireRole } from '@/lib/actions/safe-action';
import { sendTeamInvitationEmail } from '@/lib/email/team-invitation';
import { env } from '@/lib/env';
import type { Database, Json, Tables } from '@/lib/supabase/database.types';
import { generateInvitationToken, hashInvitationToken } from '@/lib/team/invitation-token';
import { createClient } from '@supabase/supabase-js';
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

const deactivateDriverSchema = z.object({
  driverId: z.string().uuid(),
});

type MemberRole = (typeof memberRoles)[number];
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
  | 'driver_deactivated';

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

function isMemberRole(role: string): role is MemberRole {
  return memberRoles.includes(role as MemberRole);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function expiresInSevenDays(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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

async function assertNotLastOwner(
  merchantAccountId: string,
  member: Pick<TeamMemberRow, 'id' | 'role'>,
): Promise<boolean> {
  if (member.role !== 'owner') {
    return true;
  }

  const admin = createSupabaseAdminClient();
  const { count, error } = await admin
    .from('merchant_member')
    .select('id', { count: 'exact', head: true })
    .eq('merchant_account_id', merchantAccountId)
    .eq('role', 'owner');

  if (error) {
    throw error;
  }

  return (count ?? 0) > 1;
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

    const sent = await sendInvitationOrFail({
      accountName,
      email,
      invitedByEmail: ctx.user.email ?? 'Tëër',
      role: parsedInput.role,
      token,
    });

    if (!sent) {
      return { ok: false as const, errorCode: 'email_failed' as const };
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

    return { ok: true as const };
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

    const role = invitation.role as InviteRole;
    const sent = await sendInvitationOrFail({
      accountName,
      email: invitation.email,
      invitedByEmail: ctx.user.email ?? 'Tëër',
      role,
      token,
    });

    if (!sent) {
      return { ok: false as const, errorCode: 'email_failed' as const };
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

    return { ok: true as const };
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

    if (!member || !isMemberRole(member.role)) {
      return { ok: false as const, errorCode: 'member_not_found' as const };
    }

    if (ctx.member.role !== 'owner' && member.role === 'owner') {
      return forbidden();
    }

    if (member.role === 'owner' && parsedInput.newRole !== 'owner') {
      const hasOtherOwner = await assertNotLastOwner(ctx.member.merchantAccountId, member);

      if (!hasOtherOwner) {
        return { ok: false as const, errorCode: 'last_owner' as const };
      }
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

    if (!member || !isMemberRole(member.role)) {
      return { ok: false as const, errorCode: 'member_not_found' as const };
    }

    if (ctx.member.role !== 'owner' && member.role === 'owner') {
      return forbidden();
    }

    const hasOtherOwner = await assertNotLastOwner(ctx.member.merchantAccountId, member);

    if (!hasOtherOwner) {
      return { ok: false as const, errorCode: 'last_owner' as const };
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

export const deactivateDriverAction = requireRole('owner', 'manager')
  .metadata({ actionName: 'team.deactivate_driver', section: 'team' })
  .inputSchema(deactivateDriverSchema)
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
      .update({ is_active: false })
      .eq('id', driver.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);

    if (updateError) {
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    const auditError = await writeTeamAuditLog({
      action: 'driver_deactivated',
      actorUserId: ctx.user.id,
      merchantAccountId: ctx.member.merchantAccountId,
      resourceType: 'driver',
      resourceId: driver.id,
    });

    if (auditError) {
      return { ok: false as const, errorCode: 'audit_failed' as const };
    }

    revalidateTeamPaths();

    return { ok: true as const };
  });
