'use client';
// Live table view for the QR guest pages (PCL-18). One request every 5 s while the tab is visible, carrying the last
// version so an unchanged table answers in a few bytes; order timelines come with it, so tracking needs no second
// poll. Failures back off (10 s, 20 s, up to 30 s) and two in a row show "Reconnecting…"; a hidden tab stops polling.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuestVisitLive, GuestVisitPoll } from '@resuto/contracts';
import { api, ApiRequestError } from '@/lib/api';
import { visitHeaders, type GuestVisit } from '@/lib/guest-visit';

import { nextDelay } from './schedule';

export function useVisitLive(visit: GuestVisit | null, onClosed: () => void) {
  const [view, setView] = useState<GuestVisitLive | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const version = useRef<string | null>(null);
  const failures = useRef(0);
  const closedRef = useRef(onClosed);
  closedRef.current = onClosed;

  const refresh = useCallback(async () => {
    if (!visit) return;
    try {
      const q = version.current ? `?v=${version.current}` : '';
      const r = await api<GuestVisitPoll>(`/public/visits/current${q}`, { headers: visitHeaders(visit) });
      if (!('unchanged' in r)) { version.current = r.version; setView(r); }
      failures.current = 0;
      setReconnecting(false);
    } catch (e) {
      if ((e as ApiRequestError).status === 401) { closedRef.current(); return; }
      failures.current += 1;
      if (failures.current >= 2) setReconnecting(true);
    }
  }, [visit]);

  useEffect(() => {
    if (!visit) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let inFlight = false;
    const loop = async () => {
      if (stopped || inFlight) return;
      timer = null;
      if (document.visibilityState === 'visible') { inFlight = true; await refresh(); inFlight = false; }
      if (!stopped && !timer) timer = setTimeout(loop, nextDelay(failures.current));
    };
    void loop();
    // Coming back to the tab refreshes at once instead of waiting out the timer.
    const onVisible = () => { if (document.visibilityState === 'visible' && !inFlight) { if (timer) clearTimeout(timer); timer = null; void loop(); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [visit, refresh]);

  /** Fetch now (after an order, a request or a payment), keeping the version so the answer can be "unchanged". */
  const now = useCallback(() => { version.current = null; return refresh(); }, [refresh]);
  return { view, reconnecting, refresh: now };
}
