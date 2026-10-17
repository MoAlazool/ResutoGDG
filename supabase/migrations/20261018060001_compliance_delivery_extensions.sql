-- Agent D2: ResutoDriver + Resuto Compliance extensions.

-- ---------------------------------------------------------------------------
-- Fiscal documents
-- ---------------------------------------------------------------------------
-- authority/authority_ref keep the government-format chain next to Resuto's
-- own SHA-256 JSON chain (previous_hash/document_hash):
--   ZATCA: authority_ref = invoice hash (Base64 SHA-256 of the UBL body), chained as PIH
--   ETA:   authority_ref = receipt UUID (SHA-256 hex of the serialised receipt), chained as previousUUID
-- payment_id ties a credit note to the refunded payment so refunds are credited exactly once.
alter table public.fiscal_documents add column authority text check (authority in ('zatca', 'eta'));
alter table public.fiscal_documents add column authority_ref text;
alter table public.fiscal_documents add column previous_authority_ref text;
alter table public.fiscal_documents add column payment_id uuid references public.payments(id);
create index fiscal_documents_payment_idx on public.fiscal_documents(order_id, payment_id) where payment_id is not null;
create index fiscal_documents_org_issued_idx on public.fiscal_documents(org_id, issued_at desc, id desc);
-- One sales document per order (credit/debit notes may be many).
create unique index fiscal_documents_one_sale_per_order on public.fiscal_documents(order_id)
  where order_id is not null and kind in ('simplified_invoice', 'standard_invoice', 'receipt');

alter table public.fiscal_counters add column last_authority_ref text;

create index government_submissions_document_idx on public.government_submissions(document_id, submitted_at desc);

-- Strengthen immutability: after issue only `status` may change.
create or replace function app.fiscal_document_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'fiscal documents cannot be deleted'; end if;
  if (new.org_id, new.branch_id, new.order_id, new.kind, new.series, new.number, new.counter_value, new.document_uuid,
      new.previous_hash, new.document_hash, new.qr_payload, new.currency, new.subtotal_minor, new.tax_minor, new.total_minor,
      new.buyer, new.lines, new.issued_at, new.references_document_id, new.payment_id, new.authority, new.authority_ref,
      new.previous_authority_ref)
     is distinct from
     (old.org_id, old.branch_id, old.order_id, old.kind, old.series, old.number, old.counter_value, old.document_uuid,
      old.previous_hash, old.document_hash, old.qr_payload, old.currency, old.subtotal_minor, old.tax_minor, old.total_minor,
      old.buyer, old.lines, old.issued_at, old.references_document_id, old.payment_id, old.authority, old.authority_ref,
      old.previous_authority_ref) then
    raise exception 'issued fiscal documents are immutable';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Licences & reminders
-- ---------------------------------------------------------------------------
create index compliance_reminders_due_idx on public.compliance_reminders(remind_on) where status = 'scheduled';

-- ---------------------------------------------------------------------------
-- Delivery
-- ---------------------------------------------------------------------------
create index delivery_offers_live_expiry_idx on public.delivery_offers(expires_at) where status = 'offered';
create index delivery_offers_driver_idx on public.delivery_offers(driver_id, status);
create index driver_cash_settlements_driver_idx on public.driver_cash_settlements(driver_id, created_at desc);
create index delivery_jobs_driver_cash_idx on public.delivery_jobs(driver_id, cash_status) where cash_status = 'collected';

select app.lockdown_public_grants();
