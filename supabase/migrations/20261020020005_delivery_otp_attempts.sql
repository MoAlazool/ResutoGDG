-- Delivery codes (audit PS-08). The code hash becomes a keyed HMAC computed by the API ("h1:" prefix; the old unkeyed
-- sha256 of a 4-digit code was reversible offline in 10,000 tries), and failed attempts are counted on the job
-- itself instead of in one API process's memory: after OTP_MAX_ATTEMPTS wrong codes the code is locked until staff
-- issue a new one. Client roles have no access to delivery_jobs (20261020020001), so neither the hash nor the
-- counter is readable outside the API.
-- Reversible: alter table public.delivery_jobs drop column otp_failed_attempts, drop column otp_locked_at,
--             drop column otp_issued_at.
alter table public.delivery_jobs
  add column otp_failed_attempts integer not null default 0 check (otp_failed_attempts >= 0),
  add column otp_locked_at timestamptz,
  add column otp_issued_at timestamptz;
