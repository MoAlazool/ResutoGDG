// Guest polling cadence (PCL-18): every 5 s while the tab is visible; after failures 10 s, 20 s, then 30 s at most.
// The API allows 240 reads a minute per table token and 1200 per address, so a table of six phones polling every
// 5 s (72 a minute) stays far inside both, and a failing network backs off instead of hammering.

export const POLL_MS = 5000;
export const MAX_BACKOFF_MS = 30_000;

/** The delay before the next poll after `failures` consecutive failures. */
export const nextDelay = (failures: number) => (failures <= 0 ? POLL_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures));

/** Polls per minute one open tab makes when every request succeeds. */
export const pollsPerMinute = () => Math.ceil(60_000 / POLL_MS);
