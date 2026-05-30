alter table public.merchant_account
  add column owner_full_name text,
  add column whatsapp_e164 text,
  add column onboarded_at timestamptz;
