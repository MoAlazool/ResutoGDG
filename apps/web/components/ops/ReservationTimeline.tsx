'use client';
// Reservation timeline (21-OPS): one row per table, the day's bookings as bars along the hours (a Gantt chart), a "now"
// line on today's date, and a row for bookings without a table. Bars are buttons (keyboard and screen readers get the
// time, guest, party and status); they open the reservation sheet. Bars are placed with inset-inline-start, so the
// hours run right to left in Arabic. Loaded on demand by the reservations page.
import { useMemo } from 'react';
import type { ReservationView } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { clock, hourTicks, layoutTimeline, minutesInDay, offsetOf, type TimelineTable } from './timeline';
import './timeline.css';

export function ReservationTimeline({ tables, bookings, timeZone, day, now, onOpen }: {
  tables: TimelineTable[]; bookings: ReservationView[]; timeZone: string; day: string; now?: number; onOpen: (id: string) => void;
}) {
  const { t } = useT();
  const { window: w, rows } = useMemo(() => layoutTimeline(tables, bookings, timeZone, day), [tables, bookings, timeZone, day]);
  const ticks = hourTicks(w);
  const nowAt = now === undefined ? null : minutesInDay(now, timeZone, day);
  const showNow = nowAt !== null && nowAt >= w.start && nowAt <= w.end;
  return (
    <div className="res-gantt" role="region" aria-label={t('core.resdash.timeline')}>
      <div className="res-gantt-grid">
        <div className="res-gantt-head" aria-hidden="true">
          <span className="res-gantt-label" />
          <span className="res-gantt-track">
            {ticks.map((m) => <span key={m} className="res-gantt-hour num" style={{ insetInlineStart: `${offsetOf(m, w)}%` }}>{clock(m)}</span>)}
          </span>
        </div>
        <ul className="res-gantt-rows">
          {rows.map((row) => (
            <li key={row.id ?? 'none'} className="res-gantt-row" data-unassigned={row.id === null || undefined}>
              <span className="res-gantt-label">{row.label ?? t('ops.res.noTable')}</span>
              <span className="res-gantt-track" style={{ blockSize: `calc(${row.lanes} * var(--res-lane))` }}>
                {ticks.map((m) => <i key={m} className="res-gantt-tick" style={{ insetInlineStart: `${offsetOf(m, w)}%` }} aria-hidden="true" />)}
                {showNow && <i className="res-gantt-now" style={{ insetInlineStart: `${offsetOf(nowAt!, w)}%` }} aria-hidden="true" />}
                {row.bars.map((b) => {
                  const r = b.booking;
                  const label = `${clock(b.start)}–${clock(b.end)} · ${r.guestName} · ${t('core.res.guests', { n: r.partySize })} · ${t(`core.res.status.${r.status}`)}`;
                  return (
                    <button key={r.id} type="button" className="res-gantt-bar" data-status={r.status} title={label} aria-label={`${row.label ?? t('ops.res.noTable')}: ${label}`}
                      style={{ insetInlineStart: `${b.offset}%`, inlineSize: `${b.width}%`, insetBlockStart: `calc(${b.lane} * var(--res-lane))` }} onClick={() => onOpen(r.id)}>
                      <span className="num">{clock(b.start)}</span> <bdi>{r.guestName}</bdi> <span className="num">· {r.partySize}</span>
                    </button>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
