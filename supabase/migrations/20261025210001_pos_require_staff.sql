-- 21-POSAPI contract 0.2.0: staff sessions on a paired POS device (docs/api/IPAD_COMPATIBILITY.md, "Staff session on
-- a device"). A manager may pair a device with requireStaff: such a device answers every device route except
-- GET /v1/pos/session only when the request also carries a staff session (X-Resuto-Staff-Authorization), so every
-- action is attributed to an employee and bounded by the employee's own role. Additive: the column defaults to false,
-- which is the 0.1.0 behaviour; existing devices and pairing codes are unchanged.
--
-- The flag is chosen with the pairing code (pos_device_pairings.require_staff) and copied to the device when it pairs
-- (pos_devices.require_staff). Sessions read both columns through the same column grants as the other non-secret
-- columns (credential and code hashes stay unreadable); the platform role (the access guard) reads pos_devices whole.
--
-- Reverse: revoke select (require_staff) on public.pos_devices, public.pos_device_pairings from resuto_member,
--   resuto_tenant; alter table public.pos_devices drop column require_staff; alter table public.pos_device_pairings
--   drop column require_staff.

alter table public.pos_device_pairings add column require_staff boolean not null default false;
alter table public.pos_devices add column require_staff boolean not null default false;

grant select (require_staff) on public.pos_devices to resuto_member, resuto_tenant;
grant select (require_staff) on public.pos_device_pairings to resuto_member, resuto_tenant;

select app.lockdown_public_grants();
