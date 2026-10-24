// Dashboard charts now live in the shared chart kit (packages/ui/src/charts/, docs/ui/DESIGN_SYSTEM.md): one set
// of line, area, bar, donut, funnel, heatmap and sparkline charts for every page. These re-exports keep the existing
// imports ('@/components/charts') working; new code imports from '@resuto/ui'.
export { BarList, CHART_COLORS, Heatmap, LineChart, SeriesLegend as Legend, type ChartSeries as Series } from '@resuto/ui';
