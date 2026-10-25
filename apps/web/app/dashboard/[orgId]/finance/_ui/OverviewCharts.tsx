'use client';
// The finance overview's charts (chart kit, inline SVG). Loaded as a lazy chunk by finance/page.tsx so the period
// picker and the KPI tiles render first.
import { dateTimeFormat } from '@resuto/contracts/lite';
import { BarChart, LineChart } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { alignDays, fillDays, type DateRange } from './period';

const minorToMajor = (n: number) => n / 100;

export function NetByDayFigure({ current, previous, rows, previousRows, format }: {
  current: DateRange; previous: DateRange | null; rows: Array<{ date: string; netMinor: number }>; previousRows: Array<{ date: string; netMinor: number }> | null;
  format: (minor: number) => string;
}) {
  const { t, locale } = useT();
  const days = fillDays(current, rows.map((r) => ({ date: r.date, value: r.netMinor })));
  const label = dateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const labels = days.map((d) => label.format(new Date(`${d.date}T12:00:00Z`)));
  const series = [{ name: t('finance.overview.current'), values: days.map((d) => minorToMajor(d.value)) }];
  if (previous && previousRows) series.push({ name: t('finance.overview.previous'), values: alignDays(current, previous, previousRows.map((r) => ({ date: r.date, value: r.netMinor }))).map(minorToMajor) });
  const props = {
    title: t('finance.overview.netByDay'), labels, series, format: (n: number) => format(Math.round(n * 100)),
    rtl: locale === 'ar', xLabel: t('finance.overview.day'), tableCaption: t('finance.overview.netByDay'),
  };
  return days.length <= 31 ? <BarChart {...props} /> : <LineChart {...props} />;
}

export function NetByMonthFigure({ months, format }: { months: Array<{ month: string; netRevenueMinor: number }>; format: (minor: number) => string }) {
  const { t, locale } = useT();
  const label = dateTimeFormat(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  return (
    <BarChart title={t('finance.overview.netByMonth')} labels={months.map((m) => label.format(new Date(`${m.month}-01T12:00:00Z`)))}
      series={[{ name: t('finance.overview.netByMonth'), values: months.map((m) => minorToMajor(m.netRevenueMinor)) }]}
      format={(n) => format(Math.round(n * 100))} rtl={locale === 'ar'} xLabel={t('finance.overview.month')} tableCaption={t('finance.overview.netByMonth')} />
  );
}
