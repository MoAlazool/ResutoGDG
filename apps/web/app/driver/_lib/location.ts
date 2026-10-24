'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError } from '@/lib/api';

export type LocationState = 'off' | 'starting' | 'on' | 'denied' | 'unsupported' | 'error';
export interface Fix { latitude: number; longitude: number; accuracyM: number | null; recordedAt: string }

const FLUSH_MS = 15_000;
const MAX_BUFFER = 50;

/**
 * When a fix was taken. GeolocationPosition.timestamp is not always epoch milliseconds (WebKit's emulated positions
 * in Playwright map to the year 58783, and some devices report clock-skewed fixes), so a value outside the window the
 * API keeps (driver-app.service.ts: the last hour, up to 2 minutes ahead) is replaced by the time the fix arrived.
 */
export function fixTime(timestamp: number, now = Date.now()): string {
  const plausible = Number.isFinite(timestamp) && timestamp >= now - 3_600_000 && timestamp <= now + 120_000;
  return new Date(plausible ? timestamp : now).toISOString();
}

/**
 * Shares the driver's position while `active` (a job is picked up / en route):
 * navigator.geolocation.watchPosition → in-memory buffer → batched upload every
 * 15 s (the API rate-limits batches). Stops watching as soon as `active` is false.
 */
export function useLocationSharing(active: boolean, upload: (points: Fix[]) => Promise<unknown>) {
  const [state, setState] = useState<LocationState>('off');
  const [lastFix, setLastFix] = useState<Fix | null>(null);
  const buffer = useRef<Fix[]>([]);
  const uploadRef = useRef(upload);
  uploadRef.current = upload;

  useEffect(() => {
    if (!active) { setState('off'); return; }
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) { setState('unsupported'); return; }
    setState('starting');
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const fix = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyM: pos.coords.accuracy ?? null, recordedAt: fixTime(pos.timestamp) };
        buffer.current.push(fix);
        if (buffer.current.length > MAX_BUFFER) buffer.current.splice(0, buffer.current.length - MAX_BUFFER);
        setLastFix(fix);
        setState('on');
      },
      (err) => setState(err.code === err.PERMISSION_DENIED ? 'denied' : 'error'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    );
    const flush = async () => {
      if (!buffer.current.length) return;
      const points = buffer.current.splice(0, MAX_BUFFER);
      try {
        await uploadRef.current(points);
      } catch (e) {
        // Keep the newest points for the next attempt unless the server refused them outright.
        if (!(e instanceof ApiRequestError) || e.status === 0 || e.status >= 500) buffer.current.unshift(...points.slice(-10));
      }
    };
    const timer = setInterval(() => { void flush(); }, FLUSH_MS);
    return () => {
      navigator.geolocation.clearWatch(watchId);
      clearInterval(timer);
      void flush();
    };
  }, [active]);

  return { state, lastFix };
}
