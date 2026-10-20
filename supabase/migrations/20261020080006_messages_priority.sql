-- PCL-12: the WhatsApp sender picked the 50 earliest due messages across all tenants, so one tenant's 5000-recipient
-- campaign delayed every other tenant's order and reservation notifications. Messages now carry a priority
-- (0 = transactional: orders, deliveries, reservations, payments, staff replies; 1 = marketing) and the sender takes
-- at most a fixed number per organization per run, transactional first (connect/messaging.service.ts runSender).
-- Reverse: drop index messages_sender_due_idx; alter table messages drop column priority;
alter table public.messages add column if not exists priority smallint not null default 0;
alter table public.messages add constraint messages_priority_range check (priority between 0 and 9);
update public.messages set priority = 1 where status = 'queued' and payload->>'reason' like 'campaign:%';
create index if not exists messages_sender_due_idx on public.messages (org_id, priority, next_attempt_at)
  where status = 'queued' and direction = 'outbound';
