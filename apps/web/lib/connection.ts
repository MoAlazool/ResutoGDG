// Connection health for the staff topbar ("Live updates" / "Reconnecting…" / "Offline"), as in the legacy workspace
// sync status. api() reports every request outcome here: a network failure or a gateway/server outage (502/503/504)
// marks the connection as reconnecting until the next successful response; the browser's offline event wins.
// It is a display signal only; screens keep their own error and retry handling. Framework-free (also imported by
// server code through lib/api.ts); the React hook lives in components/shell.

export type ConnectionState = 'live' | 'reconnecting' | 'offline';

let failing = false;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Called by api() after each request. `ok` is false for network errors and 502/503/504 responses only. */
export function reportConnection(ok: boolean) {
  if (failing === !ok) return;
  failing = !ok;
  emit();
}

const browserOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export function connectionState(): ConnectionState {
  if (browserOffline()) return 'offline';
  return failing ? 'reconnecting' : 'live';
}

/** Subscribes to changes (status reports and the browser's online/offline events); use with useSyncExternalStore. */
export function subscribeConnection(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('online', listener);
  window.addEventListener('offline', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('online', listener);
    window.removeEventListener('offline', listener);
  };
}

/** Test helper. */
export function resetConnection() { failing = false; emit(); }
