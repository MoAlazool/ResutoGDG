-- VS-16 / FT-07: the legacy "Service model" (Table service / Counter, one QR / Online orders only). It drives the
-- navigation (no floor or reservations without tables), the overview launch card, the counter's single venue QR and
-- the guided setup. Stored per branch (a restaurant can run a dining room and a takeaway counter).
--
--   tables  : floor plan with a QR per table; reservations optional.
--   counter : one venue QR (the branch's ordering page); every scan starts that guest's own pickup order.
--   online  : no on-site ordering; pickup and delivery through the website.
--
-- The accepts_* flags stay the ordering truth; the setup endpoint keeps them consistent with the mode.
-- Reverse: alter table public.branches drop column service_mode;

alter table public.branches
  add column service_mode text not null default 'tables' check (service_mode in ('tables', 'counter', 'online'));

update public.branches
   set service_mode = case when accepts_dine_in then 'tables' when accepts_pickup then 'counter' else 'online' end;
