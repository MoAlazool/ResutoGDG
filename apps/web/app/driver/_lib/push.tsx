'use client';
// FT-22: turn Web Push on/off for this device. Requires the server's VAPID key (GET me/push), browser support and the
// driver's permission. On iPhone, Web Push works only for a Home Screen app (iOS 16.4+), which the card explains.
import { useCallback, useEffect, useState } from 'react';
import { Notice, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { driverDeviceId, useDriver } from './driver-context';
import s from '../driver.module.css';

interface PushConfig { available: boolean; publicKey: string | null; subscribed: boolean; lastSuccessAt: string | null; lastError: string | null }
type Support = 'checking' | 'supported' | 'unsupported' | 'ios_needs_home_screen';

const toKey = (b64url: string) => {
  const raw = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

function detectSupport(): Support {
  if (typeof window === 'undefined') return 'checking';
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return ios && !standalone ? 'ios_needs_home_screen' : 'unsupported';
  return 'supported';
}

export function PushToggle() {
  const { t } = useT();
  const { base, call } = useDriver();
  const [cfg, setCfg] = useState<PushConfig | null>(null);
  const [support, setSupport] = useState<Support>('checking');
  const [permission, setPermission] = useState<NotificationPermission | 'unknown'>('unknown');
  const [note, setNote] = useState<string | null>(null);
  const deviceId = driverDeviceId();

  const load = useCallback(async () => {
    if (!deviceId) return;
    setCfg(await call<PushConfig>(`${base}/me/push?deviceId=${encodeURIComponent(deviceId)}`).catch(() => null));
  }, [base, call, deviceId]);
  useEffect(() => {
    setSupport(detectSupport());
    if (typeof Notification !== 'undefined') setPermission(Notification.permission);
    void load();
  }, [load]);

  const enable = useAction(async () => {
    if (!cfg?.publicKey || !deviceId) return;
    const p = await Notification.requestPermission();
    setPermission(p);
    if (p !== 'granted') return;
    const reg = await navigator.serviceWorker.register('/driver-sw.js', { scope: '/driver' });
    await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(cfg.publicKey) });
    await call(`${base}/me/push`, { body: { deviceId, subscription: sub.toJSON(), appVersion: 'pwa-1' } });
    setNote(null);
    await load();
  });
  const disable = useAction(async () => {
    if (!deviceId) return;
    const reg = await navigator.serviceWorker.getRegistration('/driver');
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    await call(`${base}/me/push/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
    await load();
  });
  const test = useAction(async () => {
    if (!deviceId) return;
    const r = await call<{ sent: number }>(`${base}/me/push/${encodeURIComponent(deviceId)}/test`, { method: 'POST' });
    setNote(r.sent ? t('driver.push.testSent') : t('driver.push.testFailed'));
    await load();
  });

  if (!cfg || support === 'checking') return null;
  const busy = enable.pending || disable.pending || test.pending;
  return (
    <div className={s.pushCard} data-testid="driver-push">
      <strong>{t('driver.push.title')}</strong>
      {!cfg.available ? <p className="fine">{t('driver.push.unavailable')}</p>
        : support === 'ios_needs_home_screen' ? <p className="fine">{t('driver.push.iosHomeScreen')}</p>
          : support === 'unsupported' ? <p className="fine">{t('driver.push.unsupported')}</p>
            : permission === 'denied' ? <p className="fine">{t('driver.push.denied')}</p>
              : cfg.subscribed ? (
                <>
                  <p className="fine">{t('driver.push.on')}</p>
                  <div className="row" style={{ gap: 8 }}>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void test.run()}>{t('driver.push.test')}</button>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void disable.run()}>{t('driver.push.turnOff')}</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="fine">{cfg.lastError === 'subscription_expired' ? t('driver.push.expired') : t('driver.push.why')}</p>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void enable.run()}>{t('driver.push.turnOn')}</button>
                </>
              )}
      {(enable.error || disable.error || test.error) && <Notice tone="danger">{enable.error || disable.error || test.error}</Notice>}
      {note && <Notice>{note}</Notice>}
    </div>
  );
}
