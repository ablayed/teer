export const teamRoles = ['owner', 'manager', 'agent'] as const;
export type TeamRole = (typeof teamRoles)[number];

export type TeamCapability =
  | 'view_all_orders'
  | 'view_call_queue'
  | 'log_calls'
  | 'transition_cod'
  | 'assign_driver'
  | 'read_customers'
  | 'edit_customers'
  | 'read_products'
  | 'edit_products'
  | 'view_finances'
  | 'manage_members'
  | 'assign_owner'
  | 'manage_billing'
  | 'delete_account';

const capabilitiesByRole: Record<TeamRole, ReadonlySet<TeamCapability>> = {
  owner: new Set([
    'view_all_orders',
    'view_call_queue',
    'log_calls',
    'transition_cod',
    'assign_driver',
    'read_customers',
    'edit_customers',
    'read_products',
    'edit_products',
    'view_finances',
    'manage_members',
    'assign_owner',
    'manage_billing',
    'delete_account',
  ]),
  manager: new Set([
    'view_all_orders',
    'view_call_queue',
    'log_calls',
    'transition_cod',
    'assign_driver',
    'read_customers',
    'edit_customers',
    'read_products',
    'edit_products',
    'view_finances',
    'manage_members',
  ]),
  agent: new Set([
    'view_call_queue',
    'log_calls',
    'transition_cod',
    'read_customers',
    'read_products',
  ]),
};

export function isTeamRole(role: string): role is TeamRole {
  return teamRoles.includes(role as TeamRole);
}

export function hasCapability(role: TeamRole, capability: TeamCapability): boolean {
  return capabilitiesByRole[role].has(capability);
}

export function canInviteRole(actorRole: TeamRole, invitedRole: TeamRole): boolean {
  if (invitedRole === 'owner') {
    return false;
  }

  return actorRole === 'owner' || actorRole === 'manager';
}

export function canAssignRole(actorRole: TeamRole, newRole: TeamRole): boolean {
  if (actorRole === 'owner') {
    return true;
  }

  return actorRole === 'manager' && newRole !== 'owner';
}

export function canChangeMemberRole({
  actorRole,
  newRole,
  ownerCount,
  targetRole,
}: {
  actorRole: TeamRole;
  newRole: TeamRole;
  ownerCount: number;
  targetRole: TeamRole;
}): boolean {
  if (!canAssignRole(actorRole, newRole)) {
    return false;
  }

  if (actorRole !== 'owner' && targetRole === 'owner') {
    return false;
  }

  if (targetRole === 'owner' && newRole !== 'owner' && ownerCount <= 1) {
    return false;
  }

  return true;
}

export function canRemoveMember({
  actorRole,
  ownerCount,
  targetRole,
}: {
  actorRole: TeamRole;
  ownerCount: number;
  targetRole: TeamRole;
}): boolean {
  if (actorRole !== 'owner' && actorRole !== 'manager') {
    return false;
  }

  if (actorRole !== 'owner' && targetRole === 'owner') {
    return false;
  }

  if (targetRole === 'owner' && ownerCount <= 1) {
    return false;
  }

  return true;
}
