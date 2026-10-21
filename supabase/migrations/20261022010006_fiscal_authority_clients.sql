-- INT-26 / FT-24: real (not stub) submissions to ZATCA and the ETA, labelled "implementation incomplete" until
-- validated by the authorities' test environments.
--
-- zatca_egs_units: one onboarded EGS unit per organisation and environment. The EGS private key and both CSIDs
-- (binarySecurityToken + secret) are sealed (SecretBox, aad "zatca-egs:<org>:<id>:<what>"); only the CSR and the
-- stamp certificate (public) are readable.
create table public.zatca_egs_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  environment text not null check (environment in ('sandbox', 'simulation', 'production')),
  status text not null default 'key_generated' check (status in ('key_generated', 'compliance_csid', 'compliance_checked', 'active', 'error', 'retired')),
  common_name text not null check (length(common_name) between 1 and 200),
  egs_serial text not null check (egs_serial ~ '^1-[^|]+\|2-[^|]+\|3-[^|]+$' and length(egs_serial) <= 200),
  invoice_type text not null check (invoice_type ~ '^[01]{4}$' and invoice_type <> '0000'),
  private_key_sealed text not null,
  csr_pem text not null,
  compliance_request_id text,
  compliance_csid_sealed text,
  compliance_checks jsonb not null default '[]'::jsonb,
  production_csid_sealed text,
  certificate_pem text,
  last_error text check (last_error is null or length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index zatca_egs_units_live_idx on public.zatca_egs_units(org_id, environment) where status <> 'retired';
create trigger zatca_egs_units_updated before update on public.zatca_egs_units for each row execute function app.set_updated_at();
select app.enable_tenant_rls('public.zatca_egs_units');

-- Authority submission references (ETA submissionUUID, ZATCA invoice hash) for polling and display.
alter table public.government_submissions add column external_id text check (external_id is null or length(external_id) <= 200);
create index government_submissions_poll_idx on public.government_submissions(authority, status, submitted_at) where external_id is not null;

select app.lockdown_public_grants();

-- Reversal:
--   drop index public.government_submissions_poll_idx; alter table public.government_submissions drop column external_id;
--   drop table public.zatca_egs_units;
