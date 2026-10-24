// @vitest-environment jsdom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import * as legacyCharts from '../../../apps/web/components/charts';
import { BarList as IntelBarList, ForecastChart as IntelForecast, Legend as IntelLegend } from '../../../apps/web/app/dashboard/[orgId]/intelligence/_components/charts';
import {
  AreaChart, BarChart, BarList, ChartLegend, DonutChart, ForecastChart, FunnelChart, Heatmap, LineChart, SeriesLegend, Sparkline, chartColor, niceScale,
} from '../src/charts';
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

describe('old chart imports keep working', () => {
  it('@/components/charts re-exports the kit', () => {
    expect(legacyCharts.LineChart).toBe(LineChart);
    expect(legacyCharts.BarList).toBe(BarList);
    expect(legacyCharts.Heatmap).toBe(Heatmap);
    expect(legacyCharts.Legend).toBe(SeriesLegend);
    expect(legacyCharts.CHART_COLORS.comparison).toBe('var(--chart-4)');
  });

  it('intelligence charts adapt the kit (ForecastChart, Legend, BarList rows)', () => {
    expect(IntelForecast).toBe(ForecastChart);
    expect(IntelLegend).toBe(ChartLegend);
    const v = mount(<IntelBarList rows={[{ key: 'a', label: 'A', value: 2 }]} label="Segments" onSelect={() => {}} />);
    expect($(v.host, 'ul').getAttribute('aria-label')).toBe('Segments');
    expect($(v.host, '.rui-bar').getAttribute('style')).toContain('var(--chart-1)');
    act(() => { v.unmount(); });
  });
});
