'use client';
// Row 3 "Needs attention": GET /o/:orgId/attention, most severe first. Each item names what it is, how many, a few
// examples, where the number comes from and a link to the screen that resolves it. Kinds the role cannot see are
// listed by name (they were not read).
import Link from 'next/link';
import type { AttentionItem, AttentionResponse } from '@resuto/contracts/home';
import { Badge, OrderRef, ProvenanceBadge, UserText, type Tone } from '@resuto/ui';
import { useFormat } from '@/components/charts/insights';
import { formatElapsed, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { providerName } from './model';
import s from './home.module.css';

const SEVERITY_TONE: Record<AttentionItem['severity'], Tone> = { critical: 'danger', warning: 'warn', info: 'info' };

export function Attention({ data, orgId, timeZone }: { data: AttentionResponse; orgId: string; timeZone: string }) {
  const { t } = useT();
  const kindName = (k: string) => t(`home.att.kind.${k}`);
  const byPermission = data.omitted.filter((o) => o.reason === 'permission').map((o) => kindName(o.kind));
  const byModule = data.omitted.filter((o) => o.reason === 'module').map((o) => kindName(o.kind));
  return (
    <>
      {data.items.length ? (
        <ul className={s.attention}>
          {data.items.map((item) => <Item key={item.kind} item={item} orgId={orgId} timeZone={timeZone} rules={data.rules} />)}
        </ul>
      ) : data.checked.length ? <p className={s.allClear}>{t('home.att.allClear')}</p> : null}
      {byPermission.length > 0 && <p className={s.sectionNote}>{t('home.att.omitted', { list: byPermission.join(' · ') })}</p>}
      {byModule.length > 0 && <p className={s.sectionNote}>{t('home.att.module', { list: byModule.join(' · ') })}</p>}
    </>
  );
}

function Item({ item, orgId, timeZone, rules }: { item: AttentionItem; orgId: string; timeZone: string; rules: Record<string, number> }) {
  const { t, locale } = useT();
  const f = useFormat();
  const desc = t(`home.att.desc.${item.kind}`, {
    minutes: rules.slowOrderMinutes ?? 30, days: item.kind === 'negative_reviews' ? rules.negativeReviewDays ?? 7 : item.kind === 'tokens_expiring' ? rules.tokenExpiryDays ?? 7 : rules.unpaidBillDays ?? 7,
    max: rules.negativeReviewMaxScore ?? 2,
  });
  const sample = (x: AttentionItem['samples'][number]) => {
    switch (item.kind) {
      case 'slow_orders': return <><OrderRef n={x.label} /> <span className="fine">{x.at ? formatElapsed(x.at, locale) : ''}</span></>;
      case 'unpaid_bills': return <><OrderRef n={x.label} /> <span className="num">{f.money(x.value ?? 0)}</span></>;
      case 'low_stock': return <><bdi>{locale === 'ar' && x.labelAr ? x.labelAr : x.label}</bdi> <span className="num">{f.num(x.value ?? 0)}</span></>;
      case 'integrations_failing': case 'tokens_expiring': return <bdi dir="ltr">{providerName(x.label)}</bdi>;
      case 'negative_reviews': return <><span className="num">{f.num(x.value ?? 0)} / 5</span>{x.label ? <> · <UserText>{x.label}</UserText></> : null}</>;
      case 'creative_approvals': return <span>{t(`studio.creative.kind.${x.label}`)}</span>;
      default: return <><UserText>{x.label}</UserText>{x.at ? <span className="fine"> · {time(x.at, locale, timeZone)}</span> : null}</>;
    }
  };
  return (
    <li className={s.attItem} data-severity={item.severity} data-kind={item.kind}>
      <div className="stack gap-6">
        <h3 className={s.attTitle}>
          <Badge tone={SEVERITY_TONE[item.severity]}>{t(`home.att.sev.${item.severity}`)}</Badge>
          {t(`home.att.kind.${item.kind}`)}
        </h3>
        <p className={s.fine}>{desc}</p>
        {item.samples.length > 0 && (
          <ul className={s.samples}>
            {item.samples.map((x) => <li key={x.id}>{sample(x)}</li>)}
            {item.count > item.samples.length && <li className="fine">{t('home.att.more', { n: item.count - item.samples.length })}</li>}
          </ul>
        )}
      </div>
      <div className={s.attSide}>
        <span className={s.attCount} aria-label={`${t(`home.att.kind.${item.kind}`)}: ${f.num(item.count)}`}>{f.num(item.count)}</span>
        <ProvenanceBadge provenance={item.provenance} />
        <Link className="btn btn-sm" href={`/dashboard/${orgId}${item.href}`}>{t('home.att.open')}<span className="sr-only"> {t(`home.att.kind.${item.kind}`)}</span></Link>
      </div>
    </li>
  );
}
