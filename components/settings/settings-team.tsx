'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  changeRoleAction,
  createDriverAction,
  deactivateDriverAction,
  inviteMemberAction,
  listTeamAction,
  removeMemberAction,
  resendInviteAction,
  revokeInviteAction,
  updateDriverAction,
} from '@/lib/actions/team';
import { cn } from '@/lib/utils';
import { MoreHorizontal, RefreshCw, Send, UserMinus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

type Role = 'owner' | 'manager' | 'agent';
type InviteRole = 'manager' | 'agent';

type TeamMember = {
  id: string;
  userId: string;
  role: Role;
  email: string | null;
  fullName: string | null;
  createdAt: string;
  isSelf: boolean;
};

type TeamDriver = {
  id: string;
  fullName: string;
  phone: string;
  userId: string | null;
  isActive: boolean;
  createdAt: string;
};

type SettingsTeamProps = {
  currentRole: string;
};

const roles = ['owner', 'manager', 'agent'] as const satisfies readonly Role[];
const inviteRoles = ['manager', 'agent'] as const satisfies readonly InviteRole[];

function initials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.trim() || '?';
  const parts = source.split(/\s+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
}

function daysUntil(date: string): number {
  return Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 86_400_000));
}

export function SettingsTeam({ currentRole }: SettingsTeamProps) {
  const t = useTranslations('settings.team');
  const canManage = currentRole === 'owner' || currentRole === 'manager';
  const listTeam = useAction(listTeamAction);
  const inviteMember = useAction(inviteMemberAction);
  const resendInvite = useAction(resendInviteAction);
  const revokeInvite = useAction(revokeInviteAction);
  const changeRole = useAction(changeRoleAction);
  const removeMember = useAction(removeMemberAction);
  const createDriver = useAction(createDriverAction);
  const updateDriver = useAction(updateDriverAction);
  const deactivateDriver = useAction(deactivateDriverAction);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteRole, setInviteRole] = useState<InviteRole>('agent');
  const data = listTeam.result.data?.ok ? listTeam.result.data : null;
  const ownerCount = useMemo(
    () => data?.members.filter((member) => member.role === 'owner').length ?? 0,
    [data],
  );

  useEffect(() => {
    if (canManage) {
      listTeam.execute({});
    }
  }, [canManage, listTeam.execute]);

  function refresh(message?: string) {
    if (message) {
      setNotice(message);
    }
    setError(null);
    listTeam.execute({});
  }

  function fail() {
    setNotice(null);
    setError(t('errors.generic'));
  }

  if (!canManage) {
    return (
      <div className="rounded-lg border border-border bg-surface p-6 text-sm text-muted shadow-1">
        {t('restricted')}
      </div>
    );
  }

  const members = data?.members ?? [];
  const invitations = data?.invitations ?? [];
  const drivers = data?.drivers ?? [];
  const loading = listTeam.isExecuting && !data;

  async function onInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get('email') ?? '').trim();

    if (!email) {
      setError(t('errors.generic'));
      return;
    }

    const result = await inviteMember.executeAsync({ email, role: inviteRole });

    if (result?.data?.ok) {
      event.currentTarget.reset();
      setInviteRole('agent');
      refresh(t('notices.inviteSent'));
      return;
    }

    fail();
  }

  async function onCreateDriver(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const fullName = String(formData.get('fullName') ?? '').trim();
    const phone = String(formData.get('phone') ?? '').trim();

    if (!fullName || !phone) {
      setError(t('errors.generic'));
      return;
    }

    const result = await createDriver.executeAsync({ fullName, phone });

    if (result?.data?.ok) {
      event.currentTarget.reset();
      refresh(t('notices.driverCreated'));
      return;
    }

    fail();
  }

  async function onResendInvite(invitationId: string) {
    const result = await resendInvite.executeAsync({ invitationId });
    result?.data?.ok ? refresh(t('notices.inviteResent')) : fail();
  }

  async function onRevokeInvite(invitationId: string) {
    const result = await revokeInvite.executeAsync({ invitationId });
    result?.data?.ok ? refresh(t('notices.inviteRevoked')) : fail();
  }

  async function onChangeRole(memberId: string, newRole: Role) {
    const result = await changeRole.executeAsync({ memberId, newRole });
    result?.data?.ok ? refresh(t('notices.roleChanged')) : fail();
  }

  async function onRemoveMember(memberId: string) {
    const result = await removeMember.executeAsync({ memberId });
    result?.data?.ok ? refresh(t('notices.memberRemoved')) : fail();
  }

  async function onUpdateDriver(
    driverId: string,
    payload: { fullName: string; phone: string; isActive?: boolean },
  ) {
    const result = await updateDriver.executeAsync({ driverId, ...payload });
    result?.data?.ok ? refresh(t('notices.driverUpdated')) : fail();
  }

  async function onDeactivateDriver(driverId: string) {
    const result = await deactivateDriver.executeAsync({ driverId });
    result?.data?.ok ? refresh(t('notices.driverUpdated')) : fail();
  }

  return (
    <div className="space-y-6">
      {notice ? (
        <output className="block rounded-lg border border-success/30 bg-success-subtle p-3 text-sm text-success">
          {notice}
        </output>
      ) : null}

      {error ? (
        <p
          className="rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm text-danger"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('members.title')}</h2>
          <Button
            aria-label={t('refresh')}
            disabled={listTeam.isExecuting}
            onClick={() => listTeam.execute({})}
            size="sm"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {t('refresh')}
          </Button>
        </div>

        <div className="mt-4 space-y-3">
          {loading ? <TeamSkeleton /> : null}
          {!loading && members.length === 0 ? (
            <p className="text-sm text-muted">{t('members.empty')}</p>
          ) : null}
          {members.map((member) => (
            <MemberRow
              currentRole={data?.currentRole ?? 'agent'}
              key={member.id}
              member={member}
              onChangeRole={(newRole) => onChangeRole(member.id, newRole)}
              onRemove={() => {
                if (window.confirm(t('members.confirmRemove'))) {
                  onRemoveMember(member.id);
                }
              }}
              ownerCount={ownerCount}
              t={t}
            />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <h2 className="text-lg font-semibold">{t('invite.title')}</h2>
        <form className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto]" onSubmit={onInvite}>
          <div className="space-y-2">
            <Label htmlFor="team-invite-email">{t('invite.email')}</Label>
            <Input autoComplete="email" id="team-invite-email" name="email" required type="email" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="team-invite-role">{t('invite.role')}</Label>
            <select
              className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
              id="team-invite-role"
              onChange={(event) => setInviteRole(event.target.value as InviteRole)}
              value={inviteRole}
            >
              {inviteRoles.map((role) => (
                <option key={role} value={role}>
                  {t(`roles.${role}`)}
                </option>
              ))}
            </select>
          </div>
          <Button className="self-end" disabled={inviteMember.isExecuting} type="submit">
            <Send aria-hidden="true" className="h-4 w-4" />
            {t('invite.submit')}
          </Button>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <h2 className="text-lg font-semibold">{t('invitations.title')}</h2>
        <div className="mt-4 space-y-3">
          {invitations.length === 0 ? (
            <p className="text-sm text-muted">{t('invitations.empty')}</p>
          ) : null}
          {invitations.map((invitation) => (
            <div
              className="flex flex-col gap-3 rounded-md border border-border bg-canvas p-4 md:flex-row md:items-center md:justify-between"
              key={invitation.id}
            >
              <div>
                <p className="font-medium text-text">{invitation.email}</p>
                <p className="text-sm text-muted">
                  {t(`roles.${invitation.role}`)} ·{' '}
                  {t('invitations.expiresIn', { days: daysUntil(invitation.expiresAt) })}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  disabled={resendInvite.isExecuting}
                  onClick={() => onResendInvite(invitation.id)}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {t('invitations.resend')}
                </Button>
                <Button
                  disabled={revokeInvite.isExecuting}
                  onClick={() => onRevokeInvite(invitation.id)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  {t('invitations.revoke')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5 shadow-1">
        <h2 className="text-lg font-semibold">{t('drivers.title')}</h2>
        <form className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto]" onSubmit={onCreateDriver}>
          <div className="space-y-2">
            <Label htmlFor="driver-full-name">{t('drivers.fullName')}</Label>
            <Input autoComplete="name" id="driver-full-name" name="fullName" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="driver-phone">{t('drivers.phone')}</Label>
            <Input autoComplete="tel" id="driver-phone" name="phone" required type="tel" />
          </div>
          <Button className="self-end" disabled={createDriver.isExecuting} type="submit">
            {t('drivers.add')}
          </Button>
        </form>
        <div className="mt-4 space-y-3">
          {drivers.length === 0 ? <p className="text-sm text-muted">{t('drivers.empty')}</p> : null}
          {drivers.map((driver) => (
            <DriverRow
              driver={driver}
              key={driver.id}
              onDeactivate={() => onDeactivateDriver(driver.id)}
              onUpdate={(payload) => onUpdateDriver(driver.id, payload)}
              t={t}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function MemberRow({
  currentRole,
  member,
  onChangeRole,
  onRemove,
  ownerCount,
  t,
}: {
  currentRole: Role;
  member: TeamMember;
  onChangeRole: (role: Role) => void;
  onRemove: () => void;
  ownerCount: number;
  t: ReturnType<typeof useTranslations<'settings.team'>>;
}) {
  const isLastOwner = member.role === 'owner' && ownerCount <= 1;
  const canEditRole = !member.isSelf && !isLastOwner;
  const visibleRoles = currentRole === 'owner' ? roles : (['manager', 'agent'] as const);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-canvas p-4 md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-surface font-mono text-sm font-semibold tabular-nums text-text shadow-1">
          {initials(member.fullName, member.email)}
        </span>
        <div className="min-w-0">
          <p className="truncate font-medium text-text">
            {member.fullName || member.email || t('members.unknown')}
          </p>
          <p className="truncate text-sm text-muted">{member.email ?? t('members.noEmail')}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <select
          aria-label={t('members.roleAria')}
          className="h-11 rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent disabled:opacity-60"
          disabled={!canEditRole}
          onChange={(event) => onChangeRole(event.target.value as Role)}
          value={member.role}
        >
          {visibleRoles.map((role) => (
            <option key={role} value={role}>
              {t(`roles.${role}`)}
            </option>
          ))}
        </select>
        <Button
          aria-label={t('members.remove')}
          disabled={member.isSelf || isLastOwner}
          onClick={onRemove}
          size="sm"
          type="button"
          variant="destructive"
        >
          <UserMinus aria-hidden="true" className="h-4 w-4" />
          {t('members.remove')}
        </Button>
      </div>
    </div>
  );
}

function DriverRow({
  driver,
  onDeactivate,
  onUpdate,
  t,
}: {
  driver: TeamDriver;
  onDeactivate: () => void;
  onUpdate: (payload: { fullName: string; phone: string; isActive?: boolean }) => void;
  t: ReturnType<typeof useTranslations<'settings.team'>>;
}) {
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(driver.fullName);
  const [phone, setPhone] = useState(driver.phone);

  if (editing) {
    return (
      <form
        className="grid gap-3 rounded-md border border-border bg-canvas p-4 md:grid-cols-[1fr_180px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          onUpdate({ fullName: fullName.trim(), phone: phone.trim(), isActive: driver.isActive });
          setEditing(false);
        }}
      >
        <Input
          aria-label={t('drivers.fullName')}
          onChange={(event) => setFullName(event.target.value)}
          value={fullName}
        />
        <Input
          aria-label={t('drivers.phone')}
          onChange={(event) => setPhone(event.target.value)}
          value={phone}
        />
        <Button type="submit">{t('drivers.save')}</Button>
      </form>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-md border border-border bg-canvas p-4 md:flex-row md:items-center md:justify-between',
        !driver.isActive && 'opacity-60',
      )}
    >
      <div>
        <p className="font-medium text-text">{driver.fullName}</p>
        <p className="font-mono text-sm text-muted tabular-nums">{driver.phone}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => setEditing(true)} size="sm" type="button" variant="secondary">
          <MoreHorizontal aria-hidden="true" className="h-4 w-4" />
          {t('drivers.edit')}
        </Button>
        <Button
          disabled={!driver.isActive}
          onClick={onDeactivate}
          size="sm"
          type="button"
          variant="destructive"
        >
          {t('drivers.deactivate')}
        </Button>
      </div>
    </div>
  );
}

function TeamSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1, 2].map((item) => (
        <div className="h-20 animate-pulse rounded-md border border-border bg-canvas" key={item} />
      ))}
    </div>
  );
}
