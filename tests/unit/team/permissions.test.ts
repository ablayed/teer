import {
  type TeamCapability,
  type TeamRole,
  canAssignRole,
  canChangeMemberRole,
  canInviteRole,
  canRemoveMember,
  hasCapability,
} from '@/lib/team/permissions';
import { describe, expect, it } from 'vitest';

const matrix: Record<TeamRole, Record<TeamCapability, boolean>> = {
  owner: {
    view_all_orders: true,
    view_call_queue: true,
    log_calls: true,
    transition_cod: true,
    assign_driver: true,
    read_customers: true,
    edit_customers: true,
    read_products: true,
    edit_products: true,
    view_finances: true,
    manage_members: true,
    assign_owner: true,
    manage_billing: true,
    delete_account: true,
  },
  manager: {
    view_all_orders: true,
    view_call_queue: true,
    log_calls: true,
    transition_cod: true,
    assign_driver: true,
    read_customers: true,
    edit_customers: true,
    read_products: true,
    edit_products: true,
    view_finances: true,
    manage_members: true,
    assign_owner: false,
    manage_billing: false,
    delete_account: false,
  },
  agent: {
    view_all_orders: false,
    view_call_queue: true,
    log_calls: true,
    transition_cod: true,
    assign_driver: false,
    read_customers: true,
    edit_customers: false,
    read_products: true,
    edit_products: false,
    view_finances: false,
    manage_members: false,
    assign_owner: false,
    manage_billing: false,
    delete_account: false,
  },
};

describe('permissions équipe', () => {
  it('respecte la matrice de permissions RBAC', () => {
    for (const [role, capabilities] of Object.entries(matrix) as Array<
      [TeamRole, Record<TeamCapability, boolean>]
    >) {
      for (const [capability, allowed] of Object.entries(capabilities) as Array<
        [TeamCapability, boolean]
      >) {
        expect(hasCapability(role, capability)).toBe(allowed);
      }
    }
  });

  it('interdit au manager de créer ou choisir le rôle owner', () => {
    expect(canInviteRole('manager', 'owner')).toBe(false);
    expect(canAssignRole('manager', 'owner')).toBe(false);
    expect(canInviteRole('manager', 'manager')).toBe(true);
    expect(canInviteRole('manager', 'agent')).toBe(true);
  });

  it('interdit de rétrograder ou retirer le dernier owner', () => {
    expect(
      canChangeMemberRole({
        actorRole: 'owner',
        targetRole: 'owner',
        newRole: 'manager',
        ownerCount: 1,
      }),
    ).toBe(false);

    expect(canRemoveMember({ actorRole: 'owner', targetRole: 'owner', ownerCount: 1 })).toBe(false);
    expect(canRemoveMember({ actorRole: 'owner', targetRole: 'owner', ownerCount: 2 })).toBe(true);
  });
});
