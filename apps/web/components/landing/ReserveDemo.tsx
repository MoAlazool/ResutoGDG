'use client';
// "Reservations" chapter (port of legacy/public/landing-reserve.js): three choices
// (table, time, party) fill one large ticket. Demo booking only — nothing is created.
import { useEffect, useRef, useState } from 'react';
import { LINKS } from './links';
import { SAMPLE } from './sample-data';
import { createTour } from './stage';
import type { Landing } from './use-landing';

const DAYS: Array<[string, number]> = [['Thu', 8], ['Fri', 9], ['Sat', 10], ['Sun', 11]];
const SLOTS: Array<[string, number]> = [['19:00', 2], ['19:30', 0], ['20:00', 4], ['20:30', 3]];
const STEPS: Array<[string, string]> = [['table', 'Choose your table'], ['time', 'Pick the time'], ['guests', 'How many guests']];
const REFERENCE = 'K7M2Q9XD';
interface S { step: number; table: string | null; day: number | null; slot: string | null; guests: number | null; count: number; done: boolean }
const fresh = (): S => ({ step: 0, table: null, day: null, slot: null, guests: null, count: 2, done: false });

export function ReserveDemo({ L }: { L: Landing }) {
  const { l, num, arrow, reduced, rtl } = L;
  const tables = SAMPLE.floor.tables;
  const pick = [tables.find((x) => x.premium) ?? tables[0]!, tables.find((x) => x.capacity >= 6) ?? tables[1]!, tables.find((x) => x.features.includes('Center')) ?? tables[2]!]
    .filter((x, i, a) => x && a.indexOf(x) === i);
  const roomy = tables.find((x) => x.capacity >= 6) ?? tables[0]!;
  const [s, setS] = useState<S>(fresh);
  const [swap, setSwap] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sRef = useRef(s); sRef.current = s;

  useEffect(() => {
    if (reduced) setS({ step: 2, table: roomy.id, day: 2, slot: '20:00', guests: Math.min(6, roomy.capacity), count: 6, done: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  const table = tables.find((x) => x.id === s.table);
  const when = s.day !== null && s.slot ? `${l(DAYS[s.day]![0])} ${num(DAYS[s.day]![1])} · ${s.slot}` : '';
  // A choice stays on screen for a beat, selected, before the next step opens.
  const next = (step: number, from: S) => {
    clearTimeout(pending.current);
    if (reduced) { from.step = step; return; }
    pending.current = setTimeout(() => setS((cur) => (cur.table === from.table && cur.slot === from.slot && !cur.done ? { ...cur, step } : cur)), 750);
  };
  const act = (kind: string, arg?: string) => {
    const cur = { ...sRef.current };
    const cap = tables.find((x) => x.id === cur.table)?.capacity ?? 6;
    switch (kind) {
      case 'open': clearTimeout(pending.current); cur.step = Number(arg); cur.done = false; break;
      case 'table': { cur.table = arg!; const c = tables.find((x) => x.id === arg)!.capacity; if ((cur.guests ?? 0) > c) cur.guests = c; cur.done = false; next(1, cur); break; }
      case 'day': cur.day = Number(arg); break;
      case 'slot': cur.slot = arg!; if (cur.day === null) cur.day = 2; next(2, cur); break;
      case 'guests': cur.guests = cur.count = Number(arg); break;
      case 'less': cur.guests = cur.count = Math.max(1, (cur.guests ?? cur.count) - 1); break;
      case 'more': cur.guests = cur.count = Math.min(cap, (cur.guests ?? cur.count) + 1); break;
      case 'confirm': cur.done = true; break;
    }
    setS(cur);
  };

  useEffect(() => {
    if (!box.current) return;
    const tour = createTour(box.current, {
      t: l, reduced, hold: 5200,
      manualHint: 'Choose a table, a time and the party size, then confirm.',
      script: async ({ c, tap, say }) => {
        say('First, the table they want');
        await c.wait(2400);
        await tap(c, `[data-rsv="table"][data-arg="${CSS.escape(roomy.id)}"]`, { wait: 900 });
        say('Then the date and time');
        await c.wait(1900);
        await tap(c, '[data-rsv="day"][data-arg="2"]', { wait: 1000 });
        await tap(c, '[data-rsv="slot"][data-arg="20:00"]', { wait: 900 });
        say('Then the number of guests');
        await c.wait(1800);
        await tap(c, `[data-rsv="guests"][data-arg="${Math.min(6, roomy.capacity)}"]`, { wait: 1400 });
        say('Confirm, and the ticket is theirs');
        await tap(c, '[data-rsv="confirm"]', { wait: 500 });
      },
      rewind: async ({ c }) => {
        setSwap(true);
        await c.wait(380);
        clearTimeout(pending.current);
        setS(fresh());
        setSwap(false);
      },
    });
    return () => { tour.destroy(); clearTimeout(pending.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, l]);

  const cap = table?.capacity ?? 6;
  const summary: Record<string, string> = { table: table ? `${table.label} · ${l(table.zone ?? '')}` : '', time: when, guests: s.guests ? num(s.guests) : '' };
  const setFlags = [!!s.table, !!when, !!s.guests];
  const glyph = (x: (typeof tables)[number]) => (
    <span className={`rsv-glyph is-${x.shape === 'round' ? 'round' : 'square'}`} style={{ ['--n' as string]: x.capacity }} aria-hidden>
      {Array.from({ length: Math.min(8, x.capacity) }, (_, i) => <i key={i} />)}
    </span>
  );
  const body: Record<string, React.ReactNode> = {
    table: (
      <div className="rsv-tables">
        {pick.map((x) => (
          <button key={x.id} type="button" data-rsv="table" data-arg={x.id} aria-pressed={x.id === s.table} onClick={() => act('table', x.id)}>
            {glyph(x)}
            <span className="rsv-t-main"><b>{x.label}</b><small>{l(x.zone ?? '')} · {num(x.capacity)} {l('seats')}</small></span>
            <span className="rsv-tags">{x.premium && <em className="is-premium">{l('Premium')}</em>}{x.features.slice(0, 2).map((f) => <em key={f}>{l(f)}</em>)}</span>
          </button>
        ))}
      </div>
    ),
    time: (
      <>
        <span className="rsv-label">{l('Date')}</span>
        <div className="rsv-days">{DAYS.map(([d, n], i) => <button key={d} type="button" data-rsv="day" data-arg={i} aria-pressed={s.day === i} onClick={() => act('day', String(i))}><small>{l(d)}</small><b>{num(n)}</b></button>)}</div>
        <span className="rsv-label">{l('Time')}</span>
        <div className="rsv-slots">{SLOTS.map(([slot, free]) => <button key={slot} type="button" data-rsv="slot" data-arg={slot} aria-pressed={s.slot === slot} disabled={!free} onClick={() => act('slot', slot)}><b>{slot}</b><small>{free ? `${num(free)} ${l('free')}` : l('Full')}</small></button>)}</div>
      </>
    ),
    guests: (
      <>
        <div className="rsv-guests">
          <div className="rsv-stepper">
            <button type="button" data-rsv="less" aria-label={l('Fewer guests')} onClick={() => act('less')}>−</button>
            <output id="rsv-count">{num(s.guests ?? s.count)}</output>
            <button type="button" data-rsv="more" aria-label={l('More guests')} onClick={() => act('more')}>+</button>
          </div>
          <div className="rsv-quick">{[2, 4, 6].map((n) => <button key={n} type="button" data-rsv="guests" data-arg={n} disabled={n > cap} className={s.guests === n ? 'is-on' : undefined} onClick={() => act('guests', String(n))}>{num(n)}</button>)}</div>
        </div>
        <button type="button" className="lp-btn lp-btn-solid rsv-confirm" data-rsv="confirm" disabled={!(s.table && when && s.guests)} onClick={() => act('confirm')}>{l('Confirm reservation')} {arrow}</button>
      </>
    ),
  };
  return (
    <section className="lp-reserve" id="reserve">
      <div className="lp-reserve-photo" aria-hidden><img src="/brand/olive-interior.webp" alt="" loading="lazy" decoding="async" width={1600} height={900} /></div>
      <div className={`lp-shell rsv${s.done ? ' is-done' : ''}${swap ? ' is-swap' : ''}`} id="rsv" data-step={s.step} ref={box}>
        <div className="rsv-left">
          <div className="lp-copy is-light" data-reveal>
            <span className="lp-chapter-tag is-dark">{l('Reservations')}</span>
            <h2>{l('Guests book a table, not a time slot.')}</h2>
            <p>{l('They choose the table they want from the room you drew, then the time and the party. The booking lands on the floor your team is watching.')}</p>
          </div>
          <ol className="rsv-steps" data-reveal>
            {STEPS.map(([id, title], i) => (
              <li key={id} data-step={i} className={[i === s.step && !s.done ? 'is-open' : '', setFlags[i] ? 'is-set' : ''].filter(Boolean).join(' ') || undefined}>
                <button type="button" className="rsv-head" data-rsv="open" data-arg={i} aria-expanded={i === s.step && !s.done} onClick={() => act('open', String(i))}><i>{num(i + 1)}</i><b>{l(title)}</b><span data-summary={id}>{summary[id]}</span></button>
                <div className="rsv-body"><div className="rsv-body-in">{body[id]}</div></div>
              </li>
            ))}
          </ol>
          <div className="rsv-foot"><div data-guide /><a className="lp-inline is-dark" href={LINKS.reserve}>{l('Open the booking page')} {arrow}</a></div>
        </div>
        <article className="rsv-ticket" data-reveal aria-live="off">
          <header><small>{SAMPLE.restaurant} · {rtl ? SAMPLE.branchAr : SAMPLE.branch}</small><strong>{l('Reservation')}</strong></header>
          <dl>
            <TicketField name="table" label={l('Table')} value={summary.table!} animate={!reduced} />
            <TicketField name="when" label={l('When')} value={when} animate={!reduced} />
            <TicketField name="guests" label={l('Guests')} value={s.guests ? `${num(s.guests)} ${l('guests')}` : ''} animate={!reduced} />
          </dl>
          <div className="rsv-rip" aria-hidden />
          <footer>
            <div className="rsv-stamp"><b><i aria-hidden>✓</i>{l('Your table is booked')}</b><small>{l('Reference')} <bdi>{REFERENCE}</bdi></small></div>
            <div className="rsv-code" aria-hidden />
            <p className="rsv-wait">{l('Three choices and it is booked.')}</p>
          </footer>
          <small className="rsv-note">{l('Demo booking. No card is charged and no message is sent.')}</small>
        </article>
      </div>
    </section>
  );
}

function TicketField({ name, label, value, animate }: { name: string; label: string; value: string; animate: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (value && value !== prev.current && animate) ref.current?.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.32,.72,0,1)' });
    prev.current = value;
  }, [value, animate]);
  return <div data-field={name} className={value ? 'is-set' : undefined}><dt>{label}</dt><dd ref={ref}>{value || '—'}</dd></div>;
}
