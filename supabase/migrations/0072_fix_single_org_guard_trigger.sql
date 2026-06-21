drop trigger if exists merchant_member_single_org_guard on public.merchant_member;

create trigger merchant_member_single_org_guard
  before insert on public.merchant_member
  for each row execute function public.enforce_single_organization_membership();
