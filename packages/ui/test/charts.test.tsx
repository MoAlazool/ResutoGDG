// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  AreaChart, BarChart, BarList, ChartLegend, DonutChart, ForecastChart, FunnelChart, Heatmap, LineChart, RouteMap, SeriesLegend, Sparkline, chartColor, niceScale,
  projectRoute,
} from '../src/charts';
import * as ui from '../src';
import { $, $$, click, EASTERN_DIGITS, html, key, mount } from './dom';

const fmt = (n: number) => `EGP ${n}`;
const LABELS = ['Mon', 'Tue', 'Wed', 'Thu'];
const SERIES = [{ name: 'This week', values: [10, 40, 25, 60] }, { name: 'Last week', values: [5, 30, 20, 50] }];

describe('chart kit', () => {
  it('LineChart: titled image, legend for two series, draw-in line, values table', () => {
    const out = html(<LineChart title="Revenue" labels={LABELS} series={SERIES} format={fmt} xLabel="Day" tableCaption="Show values" />);
    expect(out).toContain('role="img"');
    expect(out).toContain('<title');
    expect(out).toContain('rui-chart-legend');
    expect(out).toContain('pathLength="1"');
    expect(out).toContain('<summary>Show values</summary>');
    expect(out).toContain('EGP 60');
  });

  it('LineChart: arrow keys walk the points in time order, mirrored in RTL', () => {
    const v = mount(<LineChart title="الإيراد" labels={LABELS} series={SERIES} format={fmt} xLabel="اليوم" tableCaption="القيم" rtl />, 'ar');
    const svg = $(v.host, 'svg');
    key(svg, 'ArrowLeft');
    expect($(v.host, '.rui-chart-tip strong').textContent).toBe('Mon');
    key(svg, 'ArrowLeft');
    expect($(v.host, '.rui-chart-tip strong').textContent).toBe('Tue');
    key(svg, 'ArrowRight');
    expect($(v.host, '.rui-chart-tip strong').textContent).toBe('Mon');
    key(svg, 'End');
    expect($(v.host, '.rui-chart-tip').textContent).toContain('EGP 60');
    key(svg, 'Escape');
    expect(v.host.querySelector('.rui-chart-tip')).toBeNull();
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('AreaChart and BarChart render bars/areas for every point', () => {
    expect(html(<AreaChart title="Covers" labels={LABELS} series={SERIES.slice(0, 1)} format={fmt} xLabel="Day" tableCaption="Values" />)).toContain('rui-chart-area');
    const bars = html(<BarChart title="Orders" labels={LABELS} series={SERIES} format={fmt} xLabel="Day" tableCaption="Values" />);
    expect(bars.match(/class="rui-chart-bar"/g)).toHaveLength(8);
  });

  it('BarList: analytics items or intelligence rows; rows become toggle buttons with categorical colours', () => {
    const items = html(<BarList items={[{ key: 'a', label: 'Cash', value: 30 }, { key: 'b', label: 'Card', value: 60 }]} format={fmt} />);
    expect(items).toContain('EGP 60');
    expect(items).toContain('inline-size:100%');
    expect(html(<BarList items={[]} format={fmt} empty="Nothing yet" />)).toContain('Nothing yet');
    const onSelect = vi.fn();
    const v = mount(<BarList rows={[{ key: 'vip', label: 'VIP', value: 1200 }, { key: 'new', label: 'New', value: 300 }]} onSelect={onSelect} selected="new" label="Segments" palette="categorical" />, 'ar');
    const buttons = $$(v.host, 'button');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    expect($$(v.host, '.rui-bar-value').map((s) => s.textContent)).toEqual(['1,200', '300']);
    click(buttons[0]!);
    expect(onSelect).toHaveBeenCalledWith('vip');
    expect(v.host.innerHTML).not.toMatch(EASTERN_DIGITS);
    v.unmount();
  });

  it('DonutChart: shares as a list with Western-digit percentages', () => {
    const out = html(<DonutChart title="Payment methods" segments={[{ key: 'cash', label: 'نقدًا', value: 25 }, { key: 'card', label: 'بطاقة', value: 75 }]} format={fmt} centerValue="100" />, 'ar').replace(/[\u200e\u200f]/g, '');
    expect(out).toContain('25%');
    expect(out).toContain('75%');
    expect(out.match(/rui-donut-arc/g)).toHaveLength(2);
    expect(out).not.toMatch(EASTERN_DIGITS);
  });

  it('FunnelChart: ordered steps with step-to-step conversion', () => {
    const out = html(<FunnelChart title="Menu to order" steps={[{ key: 'v', label: 'Viewed', value: 200 }, { key: 'c', label: 'Cart', value: 50 }, { key: 'o', label: 'Ordered', value: 25 }]}
      format={String} rateLabel={(r) => `${r} converted`} />);
    expect(out).toContain('<ol');
    expect(out).toContain('25% converted');
    expect(out).toContain('50% converted');
  });

  it('Heatmap: a grid with a cell per hour and day', () => {
    const out = html(<Heatmap cells={[{ isoDow: 1, hour: 12, value: 900, orders: 4 }]} dayLabels={['Mon', 'Tue']} format={fmt} title="Busy hours" tableCaption="Values" hourLabel="Hour" dayLabel="Day" />);
    expect(out.match(/role="gridcell"/g)).toHaveLength(48);
    expect(out).toContain('Mon 12:00 — EGP 900 · 4');
  });

  it('Sparkline: decorative unless labelled; needs two points', () => {
    expect(html(<Sparkline values={[1]} />)).toBe('');
    expect(html(<Sparkline values={[1, 4, 2]} />)).toContain('aria-hidden="true"');
    expect(html(<Sparkline values={[1, 4, 2]} label="Trend" />)).toContain('aria-label="Trend"');
  });

  it('ForecastChart and the legends', () => {
    const out = html(<ForecastChart label="Forecast" history={[{ date: '2026-10-01', value: 5 }]} forecast={[{ date: '2026-10-02', yhat: 6, lower: 4, upper: 8 }]} />);
    expect(out).toContain('aria-label="Forecast"');
    expect(out).toContain('stroke-dasharray="6 4"');
    expect(html(<ChartLegend items={[{ color: 'var(--chart-1)', label: 'Forecast', dashed: true }]} />)).toContain('stroke-dasharray="5 3"');
    expect(html(<SeriesLegend series={SERIES.slice(0, 1)} />)).toBe('');
  });

  it('helpers: nice ticks and the 8-colour cycle', () => {
    expect(niceScale(95)).toEqual([0, 25, 50, 75, 100]);
    expect(niceScale(0)).toEqual([0, 1]);
    expect(chartColor(0)).toBe('var(--chart-1)');
    expect(chartColor(9)).toBe('var(--chart-2)');
  });
});

describe('chart kit: RTL axes, scales and empty states (21-INSIGHTS)', () => {
  const axis = (out: string) => [...out.matchAll(/<text class="rui-chart-axis" x="([\d.]+)" y="[\d.]+" text-anchor="(start|end)">/g)].map((m) => [Number(m[1]), m[2]]);

  it('LineChart: the value axis sits at the reading start (left in English, right in Arabic) and time runs with the reading direction', () => {
    const ltr = html(<LineChart title="Revenue" labels={LABELS} series={SERIES} format={fmt} xLabel="Day" tableCaption="Values" />);
    const rtl = html(<LineChart title="الإيراد" labels={LABELS} series={SERIES} format={fmt} xLabel="اليوم" tableCaption="القيم" rtl />, 'ar');
    const l = axis(ltr);
    const r = axis(rtl);
    expect(l.length).toBeGreaterThan(1);
    expect(l.every(([, a]) => a === 'end')).toBe(true);
    expect(r.every(([, a]) => a === 'start')).toBe(true);
    // English: tick labels left of the plot; Arabic: right of it.
    expect(Math.max(...l.map(([x]) => x as number))).toBeLessThan(Math.min(...r.map(([x]) => x as number)));
    // The first label (Mon) is drawn at the reading start: left in English, right in Arabic.
    const monX = (out: string) => Number(/<text class="rui-chart-axis" x="([\d.]+)" y="[\d.]+" text-anchor="middle">Mon</.exec(out)![1]);
    const thuX = (out: string) => Number(/<text class="rui-chart-axis" x="([\d.]+)" y="[\d.]+" text-anchor="middle">Thu</.exec(out)![1]);
    expect(monX(ltr)).toBeLessThan(thuX(ltr));
    const rtlMon = html(<LineChart title="x" labels={LABELS} series={SERIES} format={fmt} xLabel="x" tableCaption="x" rtl />);
    expect(monX(rtlMon)).toBeGreaterThan(thuX(rtlMon));
    expect(rtl).not.toMatch(EASTERN_DIGITS);
  });

  it('scales: the top tick covers the largest value, negative values sit on the baseline', () => {
    for (const max of [1, 7, 95, 1234, 99_999]) {
      const ticks = niceScale(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      expect(ticks.length).toBeLessThanOrEqual(6);
    }
    expect(niceScale(-5)).toEqual([0, 1]);
    expect(niceScale(Number.NaN)).toEqual([0, 1]);
    const out = html(<BarChart title="Net" labels={['a', 'b']} series={[{ name: 'Net', values: [-50, 100] }]} format={fmt} xLabel="x" tableCaption="t" />);
    expect(out.match(/class="rui-chart-bar"/g)).toHaveLength(2);
    // The table keeps the real (negative) value: nothing is invented or clipped there.
    expect(out).toContain('EGP -50');
  });

  it('empty and no-data states never draw made-up figures', () => {
    expect(html(<BarList items={[]} empty="No sales in this period" />)).toContain('No sales in this period');
    const flat = html(<LineChart title="Revenue" labels={LABELS} series={[{ name: 'Net', values: [0, 0, 0, 0] }]} format={fmt} xLabel="Day" tableCaption="Values" />);
    expect(flat).toContain('EGP 0');
    expect(flat).not.toContain('NaN');
    const none = html(<LineChart title="Revenue" labels={[]} series={[{ name: 'Net', values: [] }]} format={fmt} xLabel="Day" tableCaption="Values" />);
    expect(none).not.toContain('NaN');
    expect(none).not.toContain('rui-chart-dot');
    expect(html(<Heatmap cells={[]} dayLabels={['Mon']} format={fmt} title="Busy hours" tableCaption="Values" hourLabel="Hour" dayLabel="Day" />)).not.toContain('background');
    const donut = html(<DonutChart title="Methods" segments={[{ key: 'cash', label: 'Cash', value: 0 }]} format={fmt} />);
    expect(donut).not.toContain('rui-donut-arc');
    expect(donut).toContain('0%');
    expect(html(<FunnelChart title="Funnel" steps={[{ key: 'v', label: 'Viewed', value: 0 }, { key: 'o', label: 'Ordered', value: 0 }]} format={String} />)).not.toContain('converted');
    expect(html(<ForecastChart label="Forecast" history={[]} forecast={[]} empty="Not enough history yet" />)).toContain('Not enough history yet');
    expect(html(<ForecastChart label="Forecast" history={[]} forecast={[]} />)).toBe('');
    expect(html(<RouteMap start={{ lat: 30, lng: 31 }} stops={[]} label="Route" naiveLabel="n" plannedLabel="p" startLabel="s" empty="No stops" />)).toContain('No stops');
  });

  it('ForecastChart: time runs right to left in Arabic', () => {
    const props = { label: 'Forecast', history: [{ date: '2026-10-01', value: 5 }], forecast: [{ date: '2026-10-02', yhat: 6, lower: 4, upper: 8 }] };
    const x = (out: string, d: string) => Number(new RegExp(`x="([\\d.]+)" y="[\\d.]+" text-anchor="middle">${d}<`).exec(out)![1]);
    const ltr = html(<ForecastChart {...props} />);
    const rtl = html(<ForecastChart {...props} rtl />);
    expect(x(ltr, '10-01')).toBeLessThan(x(ltr, '10-02'));
    expect(x(rtl, '10-01')).toBeGreaterThan(x(rtl, '10-02'));
  });
});

describe('RouteMap (moved into the kit)', () => {
  const start = { lat: 30.05, lng: 31.24 };
  const stops = [
    { jobId: 'a', lat: 30.06, lng: 31.25, sequence: 2, naiveSequence: 1, lateMinutes: 0 },
    { jobId: 'b', lat: 30.04, lng: 31.26, sequence: 1, naiveSequence: 2, lateMinutes: 6 },
  ];

  it('projects with one scale for both axes, north up, inside the padding', () => {
    const { x, y } = projectRoute(start, stops, 360, 24);
    const all = [start, ...stops];
    for (const p of all) {
      expect(x(p)).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(x(p)).toBeLessThanOrEqual(336 + 1e-9);
      expect(y(p)).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(y(p)).toBeLessThanOrEqual(336 + 1e-9);
    }
    // North (higher latitude) is drawn higher (smaller y); east is to the right.
    expect(y(stops[0]!)).toBeLessThan(y(stops[1]!));
    expect(x(stops[1]!)).toBeGreaterThan(x(start));
    // A single point does not divide by zero.
    const one = projectRoute(start, []);
    expect(Number.isFinite(one.x(start)) && Number.isFinite(one.y(start))).toBe(true);
  });

  it('draws the planned route, the naive route, the start and each stop in planned order, late stops flagged', () => {
    const out = html(<RouteMap start={start} stops={stops} label="Optimised: 2 stops" naiveLabel="Naive order" plannedLabel="Optimised" startLabel="Start" />, 'ar');
    expect(out).toContain('role="img"');
    expect(out).toContain('aria-label="Optimised: 2 stops"');
    expect(out).toContain('stroke-dasharray="5 5"');
    expect(out.match(/<g data-late=""/g)).toHaveLength(1);
    expect([...out.matchAll(/font-weight="700" fill="var\(--on-ink\)">(\d+)</g)].map((m) => m[1])).toEqual(['1', '2']);
    expect(out).toContain('rui-route-map');
    expect(out).not.toMatch(EASTERN_DIGITS);
    // Geographic: the Arabic page draws the same map (never mirrored).
    expect(out.replace(/aria-label="[^"]*"/, '')).toBe(html(<RouteMap start={start} stops={stops} label="x" naiveLabel="Naive order" plannedLabel="Optimised" startLabel="Start" />).replace(/aria-label="[^"]*"/, '').replace(/<title>x<\/title>/, '<title>Optimised: 2 stops</title>'));
  });

  it('is exported from the package entry with the rest of the kit', () => {
    for (const name of ['LineChart', 'AreaChart', 'BarChart', 'BarList', 'DonutChart', 'FunnelChart', 'Heatmap', 'Sparkline', 'ForecastChart', 'RouteMap', 'SeriesLegend', 'ChartLegend']) {
      expect(typeof (ui as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(ui.RouteMap).toBe(RouteMap);
  });
});
