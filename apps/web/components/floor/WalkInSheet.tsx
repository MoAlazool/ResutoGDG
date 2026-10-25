'use client';
// "+ Seat a walk-in" (21-OPS: a sheet, was the legacy modal). Party size, the free tables (the smallest that fits is
// picked; staff can choose another) and, when nothing fits, the tables that should free up next (needs cleaning,
// paid, paying), so the front desk can quote the wait. Loaded on demand by the floor and the front desk.
import { useState } from 'react';
import { Notice, Sheet } from '@resuto/ui';
import { freeingSoon, liveState, smallestFreeTable, type LiveTable } from './live';
import { useFloorLabels } from './use-floor-labels';

export function WalkInSheet({ tables, onClose, onSeat, busy }: { tables: LiveTable[]; onClose(): void; onSeat(t: LiveTable, party: number): Promise<void>; busy: boolean }) {
  const { t, nf } = useFloorLabels();
  const [party, setParty] = useState(2);
  const free = tables.filter((x) => liveState(x).key === 'available').sort((a, b) => a.capacity - b.capacity);
  const suggested = smallestFreeTable(tables, party);
  const [tableId, setTableId] = useState<string>('');
  const chosen = free.find((x) => x.id === tableId && x.capacity >= party) ?? suggested;
  const soon = suggested ? [] : freeingSoon(tables, party).slice(0, 6);
  return (
    <Sheet open onClose={onClose} size="sm" title={t('ops.floor.seatWalkIn')} footer={<>
      <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
      <button type="button" className="btn btn-primary" disabled={!chosen || busy} onClick={() => chosen && void onSeat(chosen, party)}>
        {chosen ? t('ops.floor.seatAt', { label: chosen.label }) : t('ops.floor.seatGuests')}
      </button>
    </>}>
      <div className="stack">
        <label className="field"><span>{t('studio.live.partySize')}</span>
          <input className="input num" type="number" inputMode="numeric" min={1} max={50} value={party} onChange={(e) => setParty(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
        </label>
        {free.length === 0 ? <Notice tone="warn">{t('ops.floor.noFree')}</Notice> : (
          <div className="free-chips" role="radiogroup" aria-label={t('ops.floor.freeTables')}>
            {free.map((x) => (
              <button key={x.id} type="button" role="radio" aria-checked={chosen?.id === x.id} disabled={x.capacity < party}
                className={`chip-btn${chosen?.id === x.id ? ' is-on' : ''}`} onClick={() => setTableId(x.id)}>
                <strong>{x.label}</strong><small>{t('studio.floor.seats', { n: nf.format(x.capacity) })}</small>
              </button>
            ))}
          </div>
        )}
        {!suggested && free.length > 0 && <p className="fine">{t('ops.floor.noneFits')}</p>}
        {soon.length > 0 && (
          <section className="walkin-soon" aria-label={t('ops.walkin.soon')}>
            <h3>{t('ops.walkin.soon')}</h3>
            <ul>
              {soon.map(({ table, key }) => (
                <li key={table.id}><strong>{table.label}</strong> · {t('studio.floor.seats', { n: nf.format(table.capacity) })} · <span className={`badge state-badge state-${liveState(table).state}`}>{t(`ops.floor.state.${key}`)}</span></li>
              ))}
            </ul>
            <p className="fine">{t('ops.walkin.soonHint')}</p>
          </section>
        )}
      </div>
    </Sheet>
  );
}
