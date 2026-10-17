'use client';
// "01 · Floor Studio" chapter (port of the studio demo in legacy/public/landing.js):
// a guided loop draws the room, places tables, reshapes one and saves it so every
// table gets its QR code. Visitors can take over and place objects themselves.
import { useEffect, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import { FloorSceneContent, type SceneTable } from '../floor/FloorScene';
import type { FloorObject } from '../floor/model';
import { LINKS } from './links';
import { SAMPLE } from './sample-data';
import { createTour, type TourApi } from './stage';
import type { Landing } from './use-landing';

type DemoTable = SceneTable;
const TOOLS: Array<[string, string]> = [['Select', 'M4 3l14 7-6 2-2 6z'], ['Table', 'M4 6h16v4H4zM8 10v8M16 10v8'], ['Zone', 'M3 5h18v14H3z'], ['Wall', 'M3 12h18M3 9v6M21 9v6'], ['Window', 'M3 12h18M8 9v6M16 9v6'], ['Door', 'M6 4h12v16M6 4v16h6'], ['Counter', 'M3 9h18v6H3zM7 15v4M17 15v4'], ['Plant', 'M12 20v-8M12 12c0-4 3-6 6-6 0 4-3 6-6 6zm0 0c0-4-3-6-6-6 0 4 3 6 6 6z'], ['Label', 'M5 6h14M12 6v12']];

const draftTable = (n: number, shape: 'round' | 'square' | 'rect', capacity: number, cx: number, cy: number, zone = 'Main Room', features = ['Non-smoking', 'Center']): DemoTable => ({
  id: `b-t${n}`, label: `T${n}`, capacity, zone, shape, cx, cy, width: shape === 'rect' ? 160 : 100, height: shape === 'rect' ? 90 : 100, rotation: 0,
  features, reservable: true, premium: false, minSpendMinor: null, internalNotes: null, state: 'available',
});

interface Doc { tables: DemoTable[]; zones: FloorObject[]; objects: FloorObject[] }

export function StudioDemo({ L }: { L: Landing }) {
  const { l, num, arrow, reduced } = L;
  const room = (): FloorObject[] => [
    { id: 'b-main', type: 'zone', label: l('Main Room'), x: 600, y: 290, width: 1080, height: 470, rotation: 0, color: '#e9e6dc' },
    { id: 'b-wall', type: 'wall', label: 'North wall', x: 600, y: 46, width: 1120, height: 16, rotation: 0 },
    { id: 'b-window', type: 'window', label: 'Window side', x: 800, y: 58, width: 550, height: 12, rotation: 0 },
    { id: 'b-door', type: 'door', label: l('Entrance'), x: 110, y: 742, width: 110, height: 35, rotation: 0 },
  ];
  const seats = (): DemoTable[] => [draftTable(1, 'round', 2, 230, 200), draftTable(2, 'square', 4, 500, 200), draftTable(3, 'square', 4, 800, 200), draftTable(4, 'square', 4, 230, 430), draftTable(5, 'round', 4, 500, 430)];
  const extras = (): Array<FloorObject | DemoTable> => [
    { id: 'b-bar', type: 'counter', label: l('Bar'), x: 1090, y: 300, width: 70, height: 250, rotation: 0 },
    { id: 'b-terrace', type: 'zone', label: l('Terrace'), x: 600, y: 655, width: 1080, height: 200, rotation: 0, color: '#e0e9d7' },
    draftTable(6, 'round', 4, 500, 655, 'Terrace', ['Smoking', 'Terrace']), draftTable(7, 'square', 4, 800, 655, 'Terrace', ['Smoking', 'Terrace']),
  ];
  const addTo = (d: Doc, o: FloorObject | DemoTable): Doc => {
    if ((o as DemoTable).capacity !== undefined) return { ...d, tables: [...d.tables, { ...(o as DemoTable), features: [...(o as DemoTable).features] }] };
    return (o as FloorObject).type === 'zone' ? { ...d, zones: [...d.zones, { ...(o as FloorObject) }] } : { ...d, objects: [...d.objects, { ...(o as FloorObject) }] };
  };
  const full = (): Doc => [...room(), ...seats(), ...extras()].reduce(addTo, { tables: [], zones: [], objects: [] });

  const [doc, setDoc] = useState<Doc>(full);
  const [sel, setSel] = useState<string | null>(null);
  const [tool, setTool] = useState('Select');
  const [placedIds, setPlaced] = useState<string[]>([]);
  const [chips, setChips] = useState<Array<{ id: string; label: string; x: number; y: number }>>([]);
  const [swap, setSwap] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const docRef = useRef(doc); docRef.current = doc;
  const visitorN = useRef(0);

  const svg = () => canvasRef.current?.querySelector('svg') ?? null;
  // Where a point on the plan sits on screen, relative to the tour's host.
  const studioPoint = (x: number, y: number) => {
    const s = svg(), host = shellRef.current;
    if (!s || !host) return { x: 0, y: 0 };
    const vb = s.viewBox.baseVal, r = s.getBoundingClientRect(), h = host.getBoundingClientRect();
    const k = Math.min(r.width / vb.width, r.height / vb.height), ox = r.left + (r.width - vb.width * k) / 2, oy = r.top + (r.height - vb.height * k) / 2;
    return { x: Math.min(r.right - 12, Math.max(r.left + 12, ox + (x - vb.x) * k)) - h.left, y: Math.min(r.bottom - 12, Math.max(r.top + 12, oy + (y - vb.y) * k)) - h.top };
  };
  const place = (o: FloorObject | DemoTable) => {
    setDoc((d) => addTo(d, o));
    if ((o as DemoTable).capacity !== undefined) setSel(o.id);
    setPlaced((p) => [...p, o.id]);
  };
  // Saving the room gives every table its own QR code.
  const codes = (on: boolean) => {
    if (!on) { setChips([]); return; }
    const host = shellRef.current?.getBoundingClientRect(), box = canvasRef.current?.getBoundingClientRect();
    if (!host || !box) return;
    setChips(docRef.current.tables.map((x) => { const p = studioPoint(x.cx, x.cy); return { id: x.id, label: x.label, x: p.x + host.left - box.left, y: p.y + host.top - box.top }; }));
  };
  const selected = doc.tables.find((x) => x.id === sel);
  const update = (fn: (x: DemoTable) => DemoTable) => setDoc((d) => ({ ...d, tables: d.tables.map((x) => (x.id === sel ? fn({ ...x }) : x)) }));
  const squareSize = (cap: number) => Math.min(150, 80 + cap * 7);

  const onCanvasClick = (ev: RMouseEvent<HTMLDivElement>) => {
    const target = ev.target as Element;
    const table = target.closest('.svg-table');
    if (table) { setSel(table.getAttribute('data-object-id')); return; }
    if (!ev.nativeEvent.isTrusted) return;
    const s = svg();
    const m = s?.getScreenCTM();
    if (!s || !m) return;
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse()), x = Math.round(p.x), y = Math.round(p.y), id = `v-${++visitorN.current}`;
    const made: Record<string, () => FloorObject | DemoTable> = {
      Table: () => ({ ...draftTable(docRef.current.tables.length + 1, 'square', 4, x, y), id }),
      Plant: () => ({ id, type: 'plant', label: 'Plant', x, y, width: 46, height: 46, rotation: 0 }),
      Door: () => ({ id, type: 'door', label: l('Entrance'), x, y, width: 110, height: 35, rotation: 0 }),
      Counter: () => ({ id, type: 'counter', label: l('Bar'), x, y, width: 70, height: 200, rotation: 0 }),
    };
    if (made[tool]) place(made[tool]!());
  };

  // The guided loop (same script as the legacy page).
  const api = useRef({ place, codes, studioPoint, setDoc, setSel, setSwap, setPlaced, full });
  api.current = { place, codes, studioPoint, setDoc, setSel, setSwap, setPlaced, full };
  useEffect(() => {
    const host = shellRef.current;
    if (!host) return;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let tour: TourApi | null = createTour(host, {
      t: l, reduced, pointer: 'cursor', hold: 3600,
      manualHint: 'Pick Table, Plant, Door or Counter, then click the room. Click a table to change its shape and seats.',
      onTakeover: () => api.current.codes(false),
      script: async ({ c, tap, say, cursor }) => {
        const a = api.current;
        a.setSwap(true);
        await c.wait(320);
        a.codes(false); a.setDoc({ tables: [], zones: [], objects: [] }); a.setSel(null); a.setPlaced([]);
        a.setSwap(false);
        say('Draw the room');
        await tap(c, '[data-lp="tool"][data-arg="Zone"]', { ms: 440, wait: 120 });
        await cursor.move(c, a.studioPoint(600, 290), 480); await cursor.press(c);
        room().forEach((o) => api.current.place(o));
        await c.wait(800);
        say('Place the tables');
        await tap(c, '[data-lp="tool"][data-arg="Table"]', { ms: 440, wait: 120 });
        await cursor.move(c, api.current.studioPoint(230, 200), 460); await cursor.press(c);
        for (const o of seats()) { api.current.place(o); await c.wait(170); }
        await c.wait(500);
        say('Change a table’s shape');
        await tap(c, '[data-lp="tool"][data-arg="Select"]', { ms: 400, wait: 100 });
        await cursor.move(c, api.current.studioPoint(800, 200), 440); await cursor.press(c);
        api.current.setSel('b-t3');
        await c.wait(350);
        await tap(c, '[data-lp="shape"][data-arg="rect"]', { ms: 520, wait: 900 });
        say('Give it more seats');
        await tap(c, '[data-lp="seats"][data-arg="1"]', { ms: 420, wait: 260 });
        await tap(c, '[data-lp="seats"][data-arg="1"]', { ms: 120, wait: 900 });
        say('Save: every table gets its own QR code');
        api.current.setDoc((d) => extras().reduce(addTo, d));
        api.current.setSel(null);
        await wait(0);
        await tap(c, '[data-lp="save-room"]', { ms: 520, wait: 200 });
        await cursor.hide(c, 200);
      },
    });
    return () => { tour?.destroy(); tour = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, l]);

  const stats: Array<[number, string]> = [[doc.zones.length, 'zones'], [doc.tables.length, 'tables'], [doc.tables.reduce((n, x) => n + x.capacity, 0), 'seats'], [doc.objects.length, 'objects']];
  return (
    <section className="lp-studio" id="studio">
      <div className="lp-studio-track" id="studio-track">
        <div className="lp-studio-sticky">
          <div className="lp-shell" ref={shellRef}>
            <div className="lp-studio-head">
              <div data-reveal><span className="lp-chapter-tag is-dark">{l('Floor Studio')}</span><h2>{l('Draw the room once. Use it everywhere.')}</h2></div>
              <p data-reveal>{l('The plan you draw becomes the map guests book from, the QR identity of every table and the board your team runs service on. There is no second layout to maintain.')}</p>
              <ul className="lp-studio-uses" data-reveal>
                {[['Reservation map', 'Guests pick a real table'], ['Table QR codes', 'One for every table'], ['Service board', 'The same room, live']].map(([a, b]) => <li key={a}><b>{l(a!)}</b><small>{l(b!)}</small></li>)}
              </ul>
            </div>
            <div className="lp-studio-stage" data-reveal>
              <div className="lp-tools" role="toolbar" aria-label={l('Floor objects')}>
                {TOOLS.map(([id, d]) => (
                  <button key={id} type="button" className={tool === id ? 'is-on' : undefined} data-lp="tool" data-arg={id} aria-label={l(id)} title={l(id)} aria-pressed={tool === id} onClick={() => setTool(id)}>
                    <svg viewBox="0 0 24 24" aria-hidden><path d={d} /></svg><span>{l(id)}</span>
                  </button>
                ))}
              </div>
              <div className="lp-studio-work">
                <div className="lp-studio-top">
                  <div className="lp-studio-stats" id="studio-stats">{stats.map(([n, w]) => <span key={w}><b>{num(n)}</b> {l(w)}</span>)}</div>
                  <button type="button" className="lp-studio-save" data-lp="save-room" onClick={() => { setSel(null); requestAnimationFrame(() => codes(true)); }}>{l('Save room')}</button>
                </div>
                <div className={`lp-studio-canvas${chips.length ? ' is-saved' : ''}${swap ? ' is-swap' : ''}`} id="studio-canvas" ref={canvasRef} onClick={onCanvasClick}>
                  <svg className="lp-floor-svg" viewBox={`0 0 ${SAMPLE.floor.width} ${SAMPLE.floor.height}`} role="group" aria-label={l('Restaurant floor plan')}>
                    <FloorSceneContent layout={{ width: SAMPLE.floor.width, height: SAMPLE.floor.height, background: null, zones: doc.zones, objects: doc.objects, tables: doc.tables }}
                      editor grid mode="design" selected={sel ? [sel] : []} seatsLabel={(n) => `${num(n)} ${l('seats')}`} labelOf={l} selectAria={(x) => x}
                      classOf={(id) => (placedIds.includes(id) ? 'is-placed' : undefined)} />
                  </svg>
                  {chips.map((chip, i) => (
                    <span key={chip.id} className="lp-qr-chip" style={{ left: chip.x, top: chip.y, ['--i' as string]: i }}><i aria-hidden /><b>{chip.label}</b></span>
                  ))}
                </div>
              </div>
              <aside className="lp-studio-panel" id="studio-panel">
                {!selected ? (
                  <>
                    <div className="lp-panel-head"><span>{l('Object')}</span><strong>—</strong></div>
                    <p className="lp-panel-note">{l('Pick a tool, then click the room to place it. Select a table to set its seats, shape and features.')}</p>
                  </>
                ) : (
                  <>
                    <div className="lp-panel-head"><span>{l('Object')}</span><strong>{selected.label}</strong></div>
                    <div className="lp-field"><label htmlFor="lp-seats">{l('Seats')}</label>
                      <div className="lp-stepper">
                        <button type="button" data-lp="seats" data-arg="-1" aria-label={l('Fewer seats')} onClick={() => update((x) => { x.capacity = Math.min(12, Math.max(1, x.capacity - 1)); if (x.shape !== 'rect') { x.width = x.height = squareSize(x.capacity); } return x; })}>−</button>
                        <output id="lp-seats">{num(selected.capacity)}</output>
                        <button type="button" data-lp="seats" data-arg="1" aria-label={l('More seats')} onClick={() => update((x) => { x.capacity = Math.min(12, Math.max(1, x.capacity + 1)); if (x.shape !== 'rect') { x.width = x.height = squareSize(x.capacity); } return x; })}>+</button>
                      </div>
                    </div>
                    <div className="lp-field"><span className="lp-field-label">{l('Shape')}</span>
                      <div className="lp-seg lp-seg-sm">
                        {([['round', 'Round'], ['square', 'Square'], ['rect', 'Long']] as const).map(([s, lab]) => (
                          <button key={s} type="button" className={selected.shape === s ? 'is-on' : undefined} data-lp="shape" data-arg={s} aria-pressed={selected.shape === s}
                            onClick={() => update((x) => { x.shape = s; if (s === 'rect') { x.width = 160; x.height = 90; } else { x.width = x.height = squareSize(x.capacity); } return x; })}>{l(lab)}</button>
                        ))}
                      </div>
                    </div>
                    <div className="lp-field"><label htmlFor="lp-rot">{l('Rotation')}</label>
                      <input id="lp-rot" className="lp-range" type="range" min="0" max="345" step="15" value={selected.rotation || 0} data-lp="rotate" onChange={(e) => update((x) => { x.rotation = Number(e.target.value); return x; })} />
                      <span className="lp-field-value">{num(selected.rotation || 0)}°</span>
                    </div>
                    <div className="lp-field"><span className="lp-field-label">{l('Features')}</span>
                      <div className="lp-feats">
                        {['Window side', 'Quiet area', 'Booth', 'Accessible'].map((f) => (
                          <button key={f} type="button" className={selected.features.includes(f) ? 'is-on' : undefined} data-lp="feature" data-arg={f} aria-pressed={selected.features.includes(f)}
                            onClick={() => update((x) => { x.features = x.features.includes(f) ? x.features.filter((y) => y !== f) : [...x.features, f]; return x; })}>{l(f)}</button>
                        ))}
                        <button type="button" className={selected.premium ? 'is-on' : undefined} data-lp="feature" data-arg="premium" aria-pressed={!!selected.premium} onClick={() => update((x) => { x.premium = !x.premium; return x; })}>{l('Premium')}</button>
                      </div>
                    </div>
                    <p className="lp-panel-note">{l('Each table gets its own QR code when the room is saved.')}</p>
                  </>
                )}
              </aside>
            </div>
            <div className="lp-studio-foot"><div data-guide /><a className="lp-inline is-dark" href={LINKS.reserve}>{l('Try the guest map')} {arrow}</a></div>
          </div>
        </div>
      </div>
    </section>
  );
}
