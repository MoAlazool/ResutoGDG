'use client';
// Row 1 "Right now": live orders by stage, kitchen load per station, tables occupied/free with a compact floor
// thumbnail (the full live floor loads only when it is opened), and the next reservations of today.
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import type { LiveFloor, ServiceMode } from '@resuto/contracts';
import { ProvenanceBadge, UserText } from '@resuto/ui';
import { useFormat } from '@/components/charts/insights';
import { formatElapsed, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { stationLabel } from '@/lib/vocab';
import s from './home.module.css';
import type { OverviewData } from './types';

// The interactive floor map (and its live-floor code) and the counter/online launch card are separate chunks.
const OverviewFloor = dynamic(() => import('@/components/ops/OverviewOps').then((m) => m.OverviewFloor), { ssr: false, loading: () => <div className="skeleton" aria-hidden="true" /> });
const LaunchCard = dynamic(() => import('@/components/ops/OverviewOps').then((m) => m.LaunchCard), { ssr: false });

const STAGES = ['placed', 'accepted', 'preparing', 'ready'] as const;

export function RightNow({ data, orgId, slug, timeZone, floorBranchId, mode, canFloor, canEditFloor }: {
  data: OverviewData; orgId: string; slug: string; timeZone: string; floorBranchId: string | null; mode: ServiceMode;
  canFloor: boolean; canEditFloor: boolean;
}) {
  const { t, locale } = useT();
  const f = useFormat();
  const [expanded, setExpanded] = useState(false);
  const live = data.live;
  const oldestAt = live.oldestOpenOrderAt ? Date.parse(live.oldestOpenOrderAt) : null;
  const tables = live.tables;
  const stations = live.stations ?? [];
  const next = data.reservationsToday.next;
  const showFloor = mode === 'tables' && canFloor && !!floorBranchId;

  return (
    <>
      <div className={s.tiles}>
        <article className={s.tile} aria-labelledby="now-orders">
          <div className={s.tileHead}><h3 id="now-orders" className={s.tileTitle}>{t('home.now.orders')}</h3><ProvenanceBadge provenance="live" /></div>
          <div className={s.big}>{f.num(live.openOrders)}</div>
          <ul className={s.stages} aria-label={t('home.now.orders')}>
            {STAGES.map((k) => <li key={k} className={s.stage}>{t(`insights.status.${k}`)} <b>{f.num(live.byStatus[k])}</b></li>)}
            {live.byStatus.awaitingPayment > 0 && (
              <li className={`${s.stage} ${s.stageWarn}`}>{t('insights.status.awaiting_payment')} <b>{f.num(live.byStatus.awaitingPayment)}</b></li>
            )}
          </ul>
          <p className={s.fine}>{oldestAt !== null ? t('insights.overview.oldest', { elapsed: formatElapsed(oldestAt, locale) }) : t('insights.overview.noneOpen')}</p>
        </article>

        <article className={s.tile} aria-labelledby="now-kitchen">
          <div className={s.tileHead}><h3 id="now-kitchen" className={s.tileTitle}>{t('home.now.kitchen')}</h3><ProvenanceBadge provenance="live" /></div>
          {stations.length ? (
            <ul className={s.list}>
              {stations.map((st) => (
                <li key={st.station} className={s.listRow}>
                  <span className={s.listMain}>{stationLabel(t, st.station)}</span>
                  <span className={`${s.listValue} num`}>{t('home.now.station', { queued: f.num(st.queued), preparing: f.num(st.preparing) })}</span>
                </li>
              ))}
            </ul>
          ) : <p className={s.fine}>{t('home.now.kitchenClear')}</p>}
        </article>

        {tables && (
          <article className={s.tile} aria-labelledby="now-tables">
            <div className={s.tileHead}><h3 id="now-tables" className={s.tileTitle}>{t('home.now.tables')}</h3><ProvenanceBadge provenance="live" /></div>
            {tables.total ? (
              <>
                <div className={s.big}>{f.num(tables.occupied)}<span className={s.fine}> / {f.num(tables.total)}</span></div>
                <p className={s.fine}>{t('home.now.tablesLine', { occupied: f.num(tables.occupied), free: f.num(tables.free) })}
                  {tables.outOfService > 0 && <> · {t('home.now.outOfService', { n: tables.outOfService })}</>}</p>
              </>
            ) : <p className={s.fine}>{t('home.now.noTables')}</p>}
            {showFloor && <FloorThumb orgId={orgId} branchId={floorBranchId!} expanded={expanded} onToggle={() => setExpanded((v) => !v)} />}
          </article>
        )}

        {next !== undefined && next !== null && (
          <article className={s.tile} aria-labelledby="now-res">
            <div className={s.tileHead}><h3 id="now-res" className={s.tileTitle}>{t('home.now.reservations')}</h3><ProvenanceBadge provenance="live" /></div>
            {next.length ? (
              <ul className={s.list}>
                {next.map((r) => (
                  <li key={r.id} className={s.listRow}>
                    <span className={s.listMain}>
                      <Link href={`/dashboard/${orgId}/reservations`}><UserText>{r.guestName}</UserText></Link>
                      <span className={s.fine}> · {t('home.now.party', { n: r.partySize })}{r.tableLabel ? <> · <bdi>{r.tableLabel}</bdi></> : null}</span>
                    </span>
                    <span className={`${s.listValue} num`}>{time(r.startsAt, locale, timeZone)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className={s.fine}>{t('home.now.noReservations')}</p>}
            <p className={s.fine}>{t('insights.overview.reservationsToday')}: <span className="num">{f.num(data.reservationsToday.total)}</span> · {t('insights.overview.guests', { count: data.reservationsToday.guests })}</p>
          </article>
        )}

        {mode !== 'tables' && floorBranchId && (
          <div className={s.tile}><LaunchCard orgId={orgId} branchId={floorBranchId} mode={mode} slug={slug} /></div>
        )}
      </div>
      {showFloor && expanded && (
        <div className={s.floorFull}><OverviewFloor key={floorBranchId} orgId={orgId} branchId={floorBranchId!} canEdit={canEditFloor} /></div>
      )}
    </>
  );
}

/** A small, read-only drawing of the branch's tables (occupied vs free), refreshed every 30 seconds. */
function FloorThumb({ orgId, branchId, expanded, onToggle }: { orgId: string; branchId: string; expanded: boolean; onToggle: () => void }) {
  const { t } = useT();
  const floor = useApi<LiveFloor>(expanded ? null : `/o/${orgId}/floor/${branchId}/live`, { pollMs: 30_000 });
  const tables = floor.data?.tables ?? [];
  const occupied = tables.filter((x) => x.visit).length;
  let box: [number, number, number, number] | null = null;
  for (const x of tables) {
    const r: [number, number, number, number] = [x.cx - x.width / 2, x.cy - x.height / 2, x.cx + x.width / 2, x.cy + x.height / 2];
    box = box ? [Math.min(box[0], r[0]), Math.min(box[1], r[1]), Math.max(box[2], r[2]), Math.max(box[3], r[3])] : r;
  }
  const pad = 20;
  return (
    <div className={s.thumbWrap}>
      {!expanded && box && (
        <svg className={s.thumb} viewBox={`${box[0] - pad} ${box[1] - pad} ${box[2] - box[0] + pad * 2} ${box[3] - box[1] + pad * 2}`}
          preserveAspectRatio="xMidYMid meet" role="img" aria-label={t('home.now.floorLabel', { occupied, total: tables.length })}>
          {tables.map((x) => {
            const cls = x.visit ? s.tBusy : x.status === 'out_of_service' ? s.tOut : s.tFree;
            const transform = x.rotation ? `rotate(${x.rotation} ${x.cx} ${x.cy})` : undefined;
            return x.shape === 'round'
              ? <ellipse key={x.id} className={cls} cx={x.cx} cy={x.cy} rx={x.width / 2} ry={x.height / 2} strokeWidth={3} transform={transform} />
              : <rect key={x.id} className={cls} x={x.cx - x.width / 2} y={x.cy - x.height / 2} width={x.width} height={x.height} rx={10} strokeWidth={3} transform={transform} />;
          })}
        </svg>
      )}
      <button type="button" className="btn btn-sm" aria-expanded={expanded} onClick={onToggle}>
        {expanded ? t('home.now.collapse') : t('home.now.expand')}
      </button>
    </div>
  );
}
