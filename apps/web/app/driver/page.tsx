'use client';
import { useEffect, useState } from 'react';
import type { DriverAvailability } from '@resuto/contracts';
import { EmptyState, Notice, Skeleton, useAction } from '@resuto/ui';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { LocationPill, useDriver } from './_lib/driver-context';
import { JobCard } from './_lib/job-card';
import s from './driver.module.css';

function Countdown({ until }: { until: string }) {
  const { t } = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const left = Math.max(0, Math.round((Date.parse(until) - now) / 1000));
  return <span className="badge badge-pay" aria-live="polite">{left > 0 ? t('driver.offer.expiresIn', { s: left }) : t('driver.offer.expired')}</span>;
}

/** Driver home: availability, live offers, active deliveries (with suggested drop order) and cash on hand. */
export default function DriverHome() {
  const { t, locale } = useT();
  const { base, profile, jobs, call, refresh, location } = useDriver();
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await refresh(); });
  const me = profile.data;
  const data = jobs.data;

  const setAvailability = (availability: DriverAvailability) => act.run(() => call(`${base}/me/availability`, { method: 'PATCH', body: { availability } }));
  const coords = location.lastFix ? { latitude: location.lastFix.latitude, longitude: location.lastFix.longitude } : {};

  if (!me) return <Skeleton lines={6} />;
  const options: Array<{ key: DriverAvailability; tone?: string }> = [
    { key: me.availability === 'busy' ? 'busy' : 'available', tone: 'ok' }, { key: 'break', tone: 'warn' }, { key: 'offline' },
  ];
  const order = data?.route?.order ?? [];
  const active = [...(data?.active ?? [])].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));

  return (
    <>
      <div className={s.statusBar}>
        <div className={s.availability} role="group" aria-label={t('driver.availability.label')}>
          {options.map((o) => (
            <button key={o.key} type="button" data-tone={o.tone} aria-pressed={me.availability === o.key} disabled={act.pending}
              onClick={() => void setAvailability(o.key === 'busy' ? 'available' : o.key)}>
              {t(`driver.availability.${o.key}`)}
            </button>
          ))}
        </div>
        <div className="spread">
          <LocationPill />
          {me.cashOnHandMinor > 0 && <span className={s.pill}>💵 {t('driver.cash.onHand')}: {money(me.cashOnHandMinor, me.org.currency, locale)}</span>}
        </div>
        {act.error && <Notice tone="danger">{act.error}</Notice>}
        {location.state === 'denied' && <Notice tone="warn">{t('driver.location.deniedHelp')}</Notice>}
      </div>

      {jobs.loading && !data ? <Skeleton lines={4} /> : jobs.error ? (
        <Notice tone="danger">{jobs.error.message}</Notice>
      ) : (
        <>
          {!!data?.offers.length && (
            <section className={s.section} aria-labelledby="offers">
              <h2 id="offers" className={s.sectionTitle}>{t('driver.offers')}</h2>
              {data.offers.map((j) => (
                <JobCard key={j.id} job={j} offer>
                  {j.offer && <Countdown until={j.offer.expiresAt} />}
                  <div className={s.row2}>
                    <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run(() => call(`${base}/jobs/${j.id}/accept`, { body: coords }))}>{t('driver.accept')}</button>
                    <button className={`btn ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run(() => call(`${base}/jobs/${j.id}/decline`, { body: coords }))}>{t('driver.decline')}</button>
                  </div>
                </JobCard>
              ))}
            </section>
          )}
          <section className={s.section} aria-labelledby="active">
            <h2 id="active" className={s.sectionTitle}>{t('driver.active')}</h2>
            {active.length > 1 && data?.route && <p className="fine" style={{ margin: 0 }}>{t('driver.route.hint')}</p>}
            {active.length ? active.map((j) => (
              <JobCard key={j.id} job={j} sequence={active.length > 1 && order.includes(j.id) ? order.indexOf(j.id) + 1 : undefined}>
                {j.status === 'assigned' && (
                  <div className={s.row2}>
                    <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run(() => call(`${base}/jobs/${j.id}/accept`, { body: coords }))}>{t('driver.accept')}</button>
                    <button className={`btn ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run(() => call(`${base}/jobs/${j.id}/decline`, { body: coords }))}>{t('driver.decline')}</button>
                  </div>
                )}
              </JobCard>
            )) : (
              <div className="card"><EmptyState title={t('driver.noJobs')}>{me.availability === 'offline' ? t('driver.offlineHint') : t('driver.noJobsHint')}</EmptyState></div>
            )}
          </section>
        </>
      )}
    </>
  );
}
