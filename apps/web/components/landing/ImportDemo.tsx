'use client';
// "Menu import" chapter (port of legacy/public/landing-import.js): source menu →
// extraction → bilingual draft → human review. React renders the structure once;
// the timeline below drives it imperatively (as the legacy page did). Sample data
// only: no file is uploaded, no camera is opened and nothing is published.
import { useEffect, useRef } from 'react';
import { IMPORT_SAMPLE as data, type ImportDish } from './sample-data';
import { createCursor, createStage, EASE, quadMatrix, type StageCtx } from './stage';
import type { Landing } from './use-landing';

const PREVIEW = 5;
const dishes = data.dishes;
const flagged = dishes.find((d) => d.was)!;
const SOURCES = [{ id: 'pdf', label: 'PDF menu', file: 'olive-room-menu.pdf', kind: 'PDF' }, { id: 'photo', label: 'Menu photo' }, { id: 'csv', label: 'CSV file', file: 'olive-room-menu.csv', kind: 'CSV' }] as const;
const STEPS = ['Source', 'Read', 'Review', 'Ready'];
const CSV_COLUMNS: Array<[keyof ImportDish | 'price', string]> = [['name', 'name'], ['nameAr', 'nameAr'], ['category', 'category'], ['price', 'price_egp']];
const egp = (p: number) => String(p / 100);
const csvCell = (d: ImportDish, f: string) => (f === 'price' ? (d.was ? `${egp(d.was)} / ${egp(d.price)}` : egp(d.price)) : String((d as any)[f]));
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function ImportDemo({ L }: { L: Landing }) {
  const { l, money, num, rtl, reduced } = L;
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    return mountImport(box, { t: l, money, num, reduced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, l]);

  return (
    <section className="lp-chapter lp-import" id="import">
      <div className="lp-shell">
        <div className="lp-head-row" data-reveal>
          <div><span className="lp-chapter-tag">{l('Menu import')}</span><h2>{l('Your menu, wherever it lives now.')}</h2></div>
          <p>{l('Upload a PDF, a photo or a CSV. Resuto reads the dishes and prices into a bilingual draft, and you review every field before anything is published.')}</p>
        </div>
        <div className="imp" id="imp" data-source="pdf" data-step="0" data-reveal ref={boxRef}>
          <div className="imp-stage">
            <div className="imp-desk" aria-hidden>
              <div className="imp-drop">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 19h14" /></svg>
                <b>{l('Drop your menu here')}</b><small>{l('PDF, photo or CSV')}</small>
              </div>
              <div className="imp-file"><i /><span><b className="imp-file-name" /><small>{l('1 page')}</small></span></div>
              <div className="imp-cam">
                <img className="imp-cam-photo" src="/landing/menu-sample-photo.webp" alt="" width={data.photo.w} height={data.photo.h} loading="lazy" decoding="async" />
                <svg className="imp-crop" viewBox="0 0 100 100" preserveAspectRatio="none"><path className="imp-crop-dim" fillRule="evenodd" /><polygon className="imp-crop-line" /></svg>
                <div className="imp-crop-handles"><i /><i /><i /><i /></div>
                <div className="imp-cam-ui"><span className="imp-cam-mode">{l('Photo')}</span><i className="imp-cam-focus" /><b className="imp-cam-shutter" /></div>
                <div className="imp-cam-flash" />
              </div>
              <div className="imp-sheet"><div className="imp-sheet-body" /><div className="imp-marks" /></div>
            </div>
            <div className="imp-draft">
              <header><span className="imp-draft-title">{l('Menu draft')}</span><span className="imp-draft-state" id="imp-state">{l('Waiting for a menu')}</span></header>
              <ol className="imp-rows">
                {dishes.map((d, i) => (
                  <li key={d.id} className={`imp-row${i >= PREVIEW ? ' is-extra' : ''}`} data-dish={d.id}>
                    <div className="imp-row-main">
                      <span className="imp-name">
                        {rtl
                          ? <><b lang="ar" data-f="nameAr">{d.nameAr}</b><small lang="en" dir="ltr" data-f="name">{d.name}</small></>
                          : <><b data-f="name">{d.name}</b><small lang="ar" dir="rtl" data-f="nameAr">{d.nameAr}</small></>}
                      </span>
                      <span className="imp-cat" data-f="category">{l(d.category)}</span>
                      <span className="imp-price" data-f="price"><bdi>{money(d.price)}</bdi></span>
                      <span className="imp-status" data-f="status">{l('Review')}</span>
                    </div>
                    {d === flagged && (
                      <div className="imp-check" id="imp-check"><div className="imp-check-in">
                        <div className="imp-check-src" aria-hidden />
                        <div className="imp-check-body">
                          <strong>{l('Two prices in the source')}</strong>
                          <p>{l('Which one is current?')}</p>
                          <div className="imp-check-actions">{[d.was!, d.price].map((p) => <button key={p} type="button" data-imp="price" data-arg={p}><bdi>{money(p)}</bdi></button>)}</div>
                        </div>
                      </div></div>
                    )}
                  </li>
                ))}
              </ol>
              <footer>
                <p className="imp-count" id="imp-count" />
                <button type="button" className="imp-more" data-imp="more" aria-expanded="false" hidden />
                <p className="imp-note">{l('Allergens are not stated in this source, so they are left empty for you to add.')}</p>
              </footer>
            </div>
            <svg className="imp-threads" aria-hidden />
          </div>
          <div className="imp-rail">
            <div className="imp-tabs" role="group" aria-label={l('Menu source')}>
              {SOURCES.map((s, i) => <button key={s.id} type="button" data-imp="source" data-arg={s.id} aria-pressed={!i}>{l(s.label)}</button>)}
            </div>
            <ol className="imp-steps" aria-hidden>{STEPS.map((s) => <li key={s}>{l(s)}</li>)}</ol>
            <span className="imp-sample">{l('Sample data')}</span>
            <div className="imp-ctls">
              <button type="button" className="imp-ctl" data-imp="toggle" />
              <button type="button" className="imp-ctl" data-imp="replay">{l('Restart')}</button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** The legacy timeline, unchanged in behaviour. Returns a cleanup function. */
function mountImport(box: HTMLElement, { t, money, num, reduced }: { t: (s: string) => string; money: (m: number) => string; num: (n: number) => string; reduced: boolean }) {
  const $ = <E extends Element = HTMLElement>(s: string) => box.querySelector<E>(s)!;
  const $$ = <E extends Element = HTMLElement>(s: string) => [...box.querySelectorAll<E>(s)];
  const stageEl = $('.imp-stage'), desk = $('.imp-desk'), drop = $('.imp-drop'), file = $('.imp-file');
  const cam = $('.imp-cam'), photo = $<HTMLImageElement>('.imp-cam-photo'), flash = $('.imp-cam-flash'), shutter = $('.imp-cam-shutter');
  const cropLine = $<SVGPolygonElement>('.imp-crop-line'), cropDim = $<SVGPathElement>('.imp-crop-dim'), handles = $$('.imp-crop-handles i');
  const sheet = $('.imp-sheet'), sheetBody = $('.imp-sheet-body'), marks = $('.imp-marks'), threads = $<SVGSVGElement>('.imp-threads');
  const draft = $('.imp-draft'), check = $('#imp-check'), toggleBtn = $<HTMLButtonElement>('[data-imp="toggle"]'), moreBtn = $<HTMLButtonElement>('[data-imp="more"]');
  const rowOf = (d: ImportDish) => $(`.imp-row[data-dish="${d.id}"]`);
  const fieldOf = (d: ImportDish, f: string) => rowOf(d).querySelector<HTMLElement>(`[data-f="${f}"]`)!;
  const stacked = () => matchMedia('(max-width:860px)').matches;
  const cursor = createCursor(stageEl);
  const stage = createStage(box, { reduced, onChange: controls });
  let source: string = 'pdf', read = 0, choice: number | null = null, panY = 0;

  function controls() { toggleBtn.textContent = stage.paused || stage.finished ? t('Play') : t('Pause'); }
  const setStep = (n: number) => { box.dataset.step = String(n); $$('.imp-steps li').forEach((li, i) => { li.className = i < n ? 'is-done' : i === n ? 'is-on' : ''; }); };
  const say = (text: string) => { $('#imp-state').textContent = text; };
  function count() {
    const approved = choice ? 1 : 0;
    $('#imp-count').textContent = read ? `${num(approved)} ${t('approved')} · ${num(read - approved)} ${t('to review')} · ${num(0)} ${t('published')}` : '';
    moreBtn.hidden = read < dishes.length;
    const open = box.classList.contains('is-all');
    moreBtn.textContent = open ? t('Show fewer') : `${t('Show all items')} (${num(dishes.length)})`;
    moreBtn.setAttribute('aria-expanded', String(open));
  }
  const sheetImage = () => (source === 'photo' ? '/landing/menu-sample-scan.webp' : '/landing/menu-sample-page.webp');
  function fillSheet() {
    sheetBody.innerHTML = source === 'csv'
      ? `<table class="imp-csv"><thead><tr><th></th>${CSV_COLUMNS.map(([, head]) => `<th>${head}</th>`).join('')}</tr></thead><tbody>${dishes.map((d, i) => `<tr><th>${i + 2}</th>${CSV_COLUMNS.map(([f]) => `<td data-r="${d.id}" data-c="${f}"${f === 'nameAr' ? ' lang="ar" dir="rtl"' : ''}>${esc(csvCell(d, f))}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      : `<img src="${sheetImage()}" alt="" width="${data.page.w}" height="${data.page.h}" decoding="async">`;
  }
  // Where a field sits on the source, as fractions of the sheet.
  function region(d: ImportDish, f: string): [number, number, number, number] {
    if (source !== 'csv') {
      const [x, y, w, h] = f === 'category' ? data.categories[d.category]! : d.regions[f as 'name' | 'price' | 'nameAr'];
      return [x - 0.012, y - 0.005, w + 0.024, h + 0.01];
    }
    const s = sheet.getBoundingClientRect(), c = sheet.querySelector(`[data-r="${d.id}"][data-c="${f}"]`)!.getBoundingClientRect();
    return [(c.left - s.left) / s.width, (c.top - s.top) / s.height, c.width / s.width, c.height / s.height];
  }
  function mark(d: ImportDish, f: string, cls = '') {
    const [x, y, w, h] = region(d, f), el = document.createElement('i');
    el.className = `imp-mark ${cls}`;
    el.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
    marks.append(el);
    return el;
  }
  // On a phone the page is larger than its window, so it follows the line being read.
  function panFor(d: ImportDish, f: string) {
    if (!stacked() || source === 'csv') return 0;
    const [, y, , h] = region(d, f), room = desk.clientHeight;
    const centre = sheet.offsetTop + (y + h / 2) * sheet.offsetHeight;
    if (centre + panY > room * 0.2 && centre + panY < room * 0.74) return panY;
    return Math.round(Math.min(0, Math.max(room - sheet.offsetHeight - sheet.offsetTop - 14, room * 0.34 - centre)));
  }
  const rest = (y: number) => `matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,${y},0,1)`;
  async function pan(c: StageCtx, d: ImportDish, f: string) {
    const y = panFor(d, f);
    if (y === panY) return;
    panY = y;
    await c.to(sheet, { transform: rest(y) }, 460, { ease: EASE.move });
  }
  const show = (d: ImportDish, f: string) => fieldOf(d, f).classList.add('is-in');
  function fillRow(d: ImportDish) { rowOf(d).classList.add('is-read'); ['name', 'nameAr', 'category', 'price', 'status'].forEach((f) => show(d, f)); }
  function flag() { rowOf(flagged).classList.add('is-flagged'); fieldOf(flagged, 'status').textContent = t('Check price'); }
  function openCheck() {
    const src = check.querySelector<HTMLElement>('.imp-check-src')!;
    if (source === 'csv') {
      src.style.cssText = '';
      src.innerHTML = `<span class="imp-check-cell"><small>price_egp</small>${esc(csvCell(flagged, 'price'))}</span>`;
    } else {
      // The same pixels the reader saw, enlarged.
      const [x, y, w, h] = flagged.regions.price, pad = 0.035, width = (src.clientWidth || 132) / (w + pad * 2);
      src.innerHTML = '';
      src.style.cssText = `background-image:url(${sheetImage()});background-size:${width}px auto;background-position:${-(x - pad) * width}px ${-((y + h / 2) * width * data.page.h / data.page.w - 22)}px`;
    }
    check.classList.add('is-open');
  }
  function choose(price: number) {
    choice = price;
    const row = rowOf(flagged);
    row.classList.remove('is-flagged');
    row.classList.add('is-approved');
    fieldOf(flagged, 'price').innerHTML = `<bdi>${esc(money(price))}</bdi>`;
    fieldOf(flagged, 'status').textContent = t('Approved');
    check.classList.remove('is-open');
    marks.querySelector('.is-warn')?.classList.remove('is-warn', 'is-focus');
    count();
    if (read === dishes.length) ready();
  }
  function ready() { setStep(3); say(t('Draft ready. Nothing has been published.')); }
  // Threads end at the edge of the row; `lane` keeps the name and price lines apart.
  async function thread(c: StageCtx, from: Element, row: Element, lane: number, ms: number) {
    const s = stageEl.getBoundingClientRect(), a = from.getBoundingClientRect(), b = row.getBoundingClientRect();
    let d: string, x2: number, y2: number;
    if (stacked()) {
      const x1 = a.left + a.width / 2 - s.left, y1 = a.bottom - s.top;
      const top = draft.getBoundingClientRect();
      x2 = top.left + top.width * (lane < 0.5 ? 0.22 : 0.78) - s.left; y2 = top.top - s.top;
      const k = (y2 - y1) * 0.5;
      d = `M${x1} ${y1}C${x1} ${y1 + k} ${x2} ${y2 - k} ${x2} ${y2}`;
    } else {
      const ltr = b.left > a.left, x1 = (ltr ? a.right : a.left) - s.left, y1 = a.top + a.height / 2 - s.top;
      x2 = (ltr ? b.left : b.right) - s.left; y2 = b.top + b.height * lane - s.top;
      const k = (x2 - x1) * 0.5;
      d = `M${x1} ${y1}C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`;
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.innerHTML = `<path class="imp-thread" pathLength="1" d="${d}"/><circle class="imp-thread-end" cx="${x2}" cy="${y2}" r="4"/>`;
    threads.append(g);
    await c.to(g.firstChild as Element, { strokeDashoffset: 0 }, ms, { ease: EASE.move });
    (g.lastChild as Element).classList.add('is-in');
    void c.fork(c.to(g, { opacity: 0 }, 600, { delay: 260 }).then(() => g.remove()));
  }
  function reset() {
    box.dataset.source = source;
    box.classList.remove('is-all', 'is-static');
    $$('.imp-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.arg === source)));
    [drop, file, cam, photo, flash, sheet, cursor.el].forEach((el) => el.removeAttribute('style'));
    box.classList.remove('is-swap');
    drop.classList.remove('is-over');
    file.classList.remove('is-held');
    cam.classList.remove('is-shot', 'is-cropping');
    marks.innerHTML = ''; threads.innerHTML = '';
    const src = SOURCES.find((s) => s.id === source)!;
    file.dataset.kind = 'kind' in src ? src.kind : '';
    $('.imp-file-name').textContent = 'file' in src ? src.file : '';
    fillSheet();
    $$('.imp-row').forEach((r) => r.classList.remove('is-read', 'is-flagged', 'is-approved'));
    $$('.imp-row [data-f]').forEach((f) => f.classList.remove('is-in', 'is-new'));
    $$('.imp-status').forEach((s) => { s.textContent = t('Review'); });
    fieldOf(flagged, 'price').innerHTML = `<bdi>${esc(money(flagged.price))}</bdi>`;
    check.classList.remove('is-open');
    read = 0; choice = null; panY = 0;
    setStep(0); say(t('Waiting for a menu')); count();
  }
  const centre = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  async function dropFile(c: StageCtx) {
    cursor.set(desk, 0.8, 0.92);
    await c.wait(200);
    await cursor.show(c);
    await cursor.move(c, file, 480, 0.3, 0.55);
    await cursor.press(c);
    file.classList.add('is-held');
    const a = centre(file), b = centre(drop), dx = b.x - a.x, dy = b.y - a.y;
    await Promise.all([
      cursor.move(c, { x: cursor.point(file, 0.3, 0.55).x + dx, y: cursor.point(file, 0.3, 0.55).y + dy }, 700),
      c.to(file, { transform: `translate(${dx}px,${dy}px) rotate(-3deg)` }, 700, { ease: EASE.move }),
      c.wait(380).then(() => drop.classList.add('is-over')),
    ]);
    await c.wait(180);
    file.classList.remove('is-held');
    await Promise.all([c.to(file, { opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.82)` }, 220), c.to(drop, { opacity: 0, transform: 'scale(1.06)' }, 300)]);
    const w = sheet.offsetWidth, h = sheet.offsetHeight;
    panY = 0;
    sheet.style.transform = `translate(${w * 0.04}px,${panY + h * 0.04 + 26}px) scale(.92)`;
    await Promise.all([c.to(sheet, { opacity: 1, transform: rest(panY) }, 580, { ease: EASE.move }), cursor.hide(c, 300)]);
  }
  function drawCrop(points: Array<[number, number]>) {
    const p = points.map(([x, y]) => `${x * 100},${y * 100}`);
    cropLine.setAttribute('points', p.join(' '));
    cropDim.setAttribute('d', `M0 0H100V100H0ZM${p.join('L')}Z`);
    handles.forEach((el, i) => { el.style.left = `${points[i]![0] * 100}%`; el.style.top = `${points[i]![1] * 100}%`; });
  }
  async function capture(c: StageCtx) {
    const frame: Array<[number, number]> = [[0.04, 0.03], [0.96, 0.03], [0.96, 0.97], [0.04, 0.97]], quad = data.photo.quad;
    drawCrop(frame);
    photo.style.transform = 'scale(1.14) translate(2.5%,-2%)';
    await c.wait(200);
    await Promise.all([c.to(cam, { opacity: 1 }, 320), c.to(photo, { transform: 'scale(1) translate(0,0)' }, 820, { ease: EASE.move })]);
    cursor.set(cam, 0.85, 0.8);
    await cursor.show(c, 160);
    await cursor.move(c, shutter, 420);
    await cursor.press(c);
    await c.to(flash, { opacity: 0.92 }, 70);
    cam.classList.add('is-shot');
    await Promise.all([c.to(flash, { opacity: 0 }, 340), cursor.hide(c, 240)]);
    cam.classList.add('is-cropping');
    await c.wait(160);
    await c.tween(600, (p) => drawCrop(frame.map(([x, y], i) => [x + (quad[i]![0] - x) * p, y + (quad[i]![1] - y) * p])));
    await c.wait(240);
    // Lift the page out of the photograph and straighten it.
    panY = 0;
    const s = { x: desk.getBoundingClientRect().left + sheet.offsetLeft, y: desk.getBoundingClientRect().top + sheet.offsetTop }, p = photo.getBoundingClientRect();
    sheet.style.transform = quadMatrix(sheet.offsetWidth, sheet.offsetHeight, quad.map(([x, y]) => [p.left + x * p.width - s.x, p.top + y * p.height - s.y]));
    await c.to(sheet, { opacity: 1 }, 160);
    await Promise.all([c.to(sheet, { transform: rest(panY) }, 740, { ease: EASE.move }), c.to(cam, { opacity: 0 }, 380, { delay: 140 })]);
  }
  async function extract(c: StageCtx) {
    setStep(1); say(t('Reading the menu…'));
    let category = '';
    for (let i = 0; i < PREVIEW; i++) {
      const d = dishes[i]!, pace = [1, 0.66, 0.5, 0.42, 0.4][i]!, row = rowOf(d), warn = d === flagged ? 'is-warn' : '';
      await pan(c, d, 'name');
      if (source !== 'csv' && d.category !== category) { category = d.category; mark(d, 'category', 'is-cat'); await c.wait(260 * pace); }
      const name = mark(d, 'name');
      await c.wait(200 * pace);
      await thread(c, name, row.firstElementChild!, 0.36, Math.max(240, 420 * pace));
      row.classList.add('is-read');
      show(d, 'name'); row.querySelector('.imp-name b')!.classList.add('is-new');
      mark(d, 'nameAr');
      await c.wait(160 * pace);
      show(d, 'nameAr');
      if (source === 'csv') mark(d, 'category', 'is-cat');
      const price = mark(d, 'price', warn);
      await c.wait(200 * pace);
      await thread(c, price, row.firstElementChild!, 0.66, Math.max(240, 400 * pace));
      show(d, 'category'); show(d, 'price'); fieldOf(d, 'price').classList.add('is-new');
      if (warn) flag();
      await c.wait(140 * pace);
      show(d, 'status');
      read = i + 1; count();
      await c.wait(120 * pace);
    }
    for (const d of dishes.slice(PREVIEW)) {
      mark(d, 'name'); mark(d, 'price'); fillRow(d);
      read++; count();
      await c.wait(90);
    }
  }
  async function review(c: StageCtx) {
    if (choice) return ready();
    setStep(2); say(t('One field needs you'));
    await c.wait(250);
    await pan(c, flagged, 'price');
    marks.querySelector('.is-warn')?.classList.add('is-focus');
    openCheck();
    await c.wait(850);
    if (choice) return;
    const yes = check.querySelector(`[data-arg="${flagged.price}"]`)!;
    cursor.set(check, 0.5, 1.5);
    await cursor.show(c);
    await cursor.move(c, yes, 560, 0.5, 0.6);
    await c.wait(160);
    yes.classList.add('is-down');
    await cursor.press(c);
    yes.classList.remove('is-down');
    if (!choice) choose(flagged.price);
    await c.wait(420);
    await cursor.hide(c);
  }
  function start() {
    reset();
    stage.loop(async (c) => {
      await (source === 'photo' ? capture(c) : dropFile(c));
      await c.wait(300);
      await extract(c);
      await review(c);
    }, {
      hold: 2400,
      rewind: async (c) => {
        box.classList.add('is-swap');
        await c.wait(380);
        source = SOURCES[(SOURCES.findIndex((s) => s.id === source) + 1) % SOURCES.length]!.id;
        reset();
        box.classList.remove('is-swap');
        await c.wait(120);
      },
    });
  }
  // Reduced motion: no playback. The draft is ready for review, with the open question still open.
  function still() {
    stage.stop();
    reset();
    box.classList.add('is-static');
    [drop, file, cam].forEach((el) => { el.style.display = 'none'; });
    sheet.style.opacity = '1';
    dishes.forEach((d) => {
      if (source !== 'csv' && d === dishes.find((x) => x.category === d.category)) mark(d, 'category', 'is-cat');
      mark(d, 'name'); mark(d, 'price', d === flagged ? 'is-warn is-focus' : '');
      fillRow(d);
    });
    read = dishes.length;
    flag(); openCheck();
    setStep(2); say(t('Draft ready for review')); count();
  }
  const begin = () => (reduced ? still() : start());
  const onClick = (ev: MouseEvent) => {
    const el = (ev.target as Element).closest<HTMLElement>('[data-imp]');
    if (!el) return;
    switch (el.dataset.imp) {
      case 'source': source = el.dataset.arg!; return begin();
      case 'replay': return begin();
      case 'toggle': return stage.finished ? begin() : stage.toggle();
      // Answering it yourself ends the autoplay; Play starts it again.
      case 'price': if (ev.isTrusted && !reduced) { stage.stop(); cursor.el.style.opacity = '0'; } return choose(Number(el.dataset.arg));
      case 'more': box.classList.toggle('is-all'); return count();
    }
  };
  box.addEventListener('click', onClick);
  reset(); controls();
  if (reduced) still(); else stage.whenVisible(start);
  return () => { box.removeEventListener('click', onClick); stage.destroy(); cursor.el.remove(); };
}
