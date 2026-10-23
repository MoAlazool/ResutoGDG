-- PS-24 remainder (REM-A03) review: before the status fix, IdempotencyService stored status_code 200 for every key,
-- including keys of routes that answered 201 (creates). The service now replays the stored status, so a client
-- retrying across the deploy with a key stored earlier would get 200 where its first call got 201. Those stored 200s
-- are not real statuses: clear them, so a replay of an older key answers with the route's own status, exactly as
-- before the fix. Keys written by the new code that really answered 200 lose nothing (a replay through the same
-- route answers 200 by default). Keys live 7 days (IDEMPOTENCY_RETENTION_DAYS), so this touches at most a week of
-- rows. A key an old instance writes during a rolling deploy, after this migration ran, keeps its 200 (seconds).
-- Idempotent. Down: nothing to restore (the cleared values were the fixed 200).
update public.idempotency_keys set status_code = null where status_code = 200;
