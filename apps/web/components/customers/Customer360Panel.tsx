'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Customer360, Customer360Section } from '@resuto/contracts';
import { Badge, Email, Ltr, Notice, OrderRef, Phone, ProvenanceBadge, Skeleton, StatusBadge, UserText } from '@resuto/ui';
import { date, dateTime, money, num, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import './customer360.css';

// Customer 360 (21-INBOX, plan §6.5): one bounded read (GET customers/:id/360) shown as a stack of sections, each naming
// where its figures come from. Shared by the Inbox's side pane and the customer profile page; both load it lazily.
// Customer-written text (names, messages, e-mail) is plain text in an isolated run (untrustedFields); it is never
// rendered as markup or links and never sent to an AI prompt from here.

export type C360SectionKey = 'identity' | 'value' | 'favourites' | 'acquisition' | 'consent' | 'orders' | 'reservations' | 'loyalty' | 'conversations' | 'notes';
const ALL: C360SectionKey[] = ['identity', 'value', 'favourites', 'acquisition', 'consent', 'orders', 'reservations', 'loyalty', 'conversations', 'notes'];
const RECORDED = new Set(['tracked_link_click', 'attribution_event', 'order_attribution']);

export interface Customer360PanelProps {
  customerId: string;
  /** Sections to leave out (the profile page already shows identity, orders, reservations and loyalty). */
  omit?: C360SectionKey[];
  /** Heading level of the section titles (3 in the Inbox pane, 2 on the profile page). */
  level?: 2 | 3;
  /** The conversation open next to the panel (left out of the conversations list). */
  currentConversationId?: string | null;
  /** `stack`: one column (a side pane); `grid`: sections side by side (a full-width page). */
  layout?: 'stack' | 'grid';
}

export default function Customer360Panel({ customerId, omit = [], level = 3, currentConversationId, layout = 'stack' }: Customer360PanelProps) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const q = useApi<Customer360>(`/o/${org.id}/customers/${customerId}/360`, { staleMs: 30_000 });
  const tz = org.timezone;
  const shown = (k: C360SectionKey) => ALL.includes(k) && !omit.includes(k);
  const H = level === 2 ? 'h2' : 'h3';
  /** A translated label for an API value, or the value itself when there is no copy for it (new kinds stay readable). */
  const tk = (prefix: string, value: string) => { const key = `${prefix}.${value}`; const s = t(key); return s === key ? value.replaceAll('_', ' ') : s; };

  if (!q.data) {
    return (
      <div className="c360" data-layout={layout} aria-busy={!q.error}>
        {q.error ? <Notice tone="danger">{t('insights.c360.error')} <button type="button" className="btn btn-sm" onClick={() => void q.reload()}>{t('action.retry')}</button></Notice>
          : <Skeleton lines={6} />}
      </div>
    );
  }
  const c = q.data;
  const cur = c.stats.currency;
  const sec = (key: C360SectionKey, title: string, source: ReactNode, body: ReactNode) => shown(key) && (
    <section className="c360-sec" aria-labelledby={`c360-${key}`} data-section={key}>
      <div className="c360-head"><H id={`c360-${key}`} className="c360-title">{title}</H>{source}</div>
      {body}
    </section>
  );
  const src = (text: string) => <p className="c360-src">{text}</p>;
  const missing = (s: Customer360Section) => (
    <div className="c360-missing"><ProvenanceBadge provenance="unavailable" labels={{ unavailable: t('insights.c360.unavailable') }} />
      <span>{t(s === 'no_permission' ? 'insights.c360.noPermission' : 'insights.c360.notEntitled')}</span></div>
  );
  const ft = c.acquisition.firstTouch;
  const cadence = c.stats.cadence;
  const convs = (c.conversations ?? []).filter((x) => x.id !== currentConversationId);

  return (
    <div className="c360" data-layout={layout}>
      {c.customer.anonymisedAt && <Notice tone="warn">{t('insights.profile.anonymised')}</Notice>}
      {sec('identity', t('insights.c360.identity'), null, (
        <dl className="c360-kv">
          <div><dt>{t('insights.customers.name')}</dt><dd>{c.customer.displayName ? <UserText>{c.customer.displayName}</UserText> : t('insights.customers.unnamed')}</dd></div>
          {c.customer.phone && <div><dt>{t('insights.customers.phone')}</dt><dd><Phone value={c.customer.phone} /></dd></div>}
          {c.customer.email && <div><dt>{t('insights.customers.email')}</dt><dd><Email value={c.customer.email} /></dd></div>}
          {c.identities.length > 0 && <div><dt>{t('insights.profile.identities')}</dt><dd className="c360-chips">
            {c.identities.map((i) => <Badge key={i.id}>{tk('insights.c360.kind', i.kind)} <Ltr><UserText>{i.value}</UserText></Ltr></Badge>)}</dd></div>}
          <div><dt>{t('insights.c360.firstSeen')}</dt><dd>{c.customer.firstSeenAt ? date(c.customer.firstSeenAt, locale, tz) : '—'}</dd></div>
          {c.tags.customer.length > 0 && <div><dt>{t('insights.customers.tags')}</dt><dd className="c360-chips">{c.tags.customer.map((tg) => <Badge key={tg} tone="info"><UserText>{tg}</UserText></Badge>)}</dd></div>}
        </dl>
      ))}
      {sec('value', t('insights.c360.value'), src(t(c.stats.source === 'customer_stats' ? 'insights.c360.src.stats' : 'insights.c360.src.branchStats')), (
        <>
          <dl className="c360-figures">
            <div><dt>{t('insights.kpi.orders')}</dt><dd className="num">{num(c.stats.orderCount, locale)}</dd></div>
            <div><dt>{t('insights.customers.spend')}</dt><dd>{money(c.stats.spendMinor, cur, locale)}</dd></div>
            <div><dt>{t('insights.kpi.aov')}</dt><dd>{c.stats.orderCount ? money(c.stats.averageOrderMinor, cur, locale) : '—'}</dd></div>
            <div><dt>{t('insights.customers.lastOrder')}</dt><dd>{c.stats.lastOrderAt ? date(c.stats.lastOrderAt, locale, tz) : '—'}</dd></div>
          </dl>
          <p className="c360-line">{cadence.medianDaysBetweenOrders === null
            ? t('insights.c360.cadenceNone')
            : t('insights.c360.cadence', { interval: num(cadence.medianDaysBetweenOrders, locale, 1), d30: num(cadence.ordersLast30Days, locale), d90: num(cadence.ordersLast90Days, locale) })}</p>
          {cadence.sampleSize > 0 && src(t('insights.c360.src.cadence', { n: cadence.sampleSize }))}
        </>
      ))}
      {sec('favourites', t('insights.c360.favourites'), src(t('insights.c360.src.items')), c.topItems.length ? (
        <ol className="c360-list">
          {c.topItems.map((i) => (
            <li key={i.productId ?? i.name}><UserText>{pick(locale, i.name, i.nameAr)}</UserText>
              <span className="c360-sub num">{t('insights.c360.timesOrdered', { qty: num(i.quantity, locale) })}</span></li>
          ))}
        </ol>
      ) : <p className="c360-empty">{t('insights.c360.noItems')}</p>)}
      {sec('acquisition', t('insights.c360.acquisition'), ft ? <ProvenanceBadge provenance={RECORDED.has(ft.basis) && !ft.inferred ? 'live' : 'estimated'}
        labels={{ live: t('insights.c360.recorded'), estimated: t('insights.c360.inferred') }} /> : null, ft ? (
        <dl className="c360-kv">
          <div><dt>{t('insights.c360.basis')}</dt><dd>{tk('insights.c360.basis', ft.basis)}</dd></div>
          {ft.channel && <div><dt>{t('insights.marketing.channel')}</dt><dd>{tk('insights.channel', ft.channel)}</dd></div>}
          {(ft.utm.source || ft.utm.campaign) && <div><dt>{t('insights.c360.utm')}</dt><dd><Ltr>{[ft.utm.source, ft.utm.medium, ft.utm.campaign].filter(Boolean).join(' / ')}</Ltr></dd></div>}
          {ft.campaignName && <div><dt>{t('insights.c360.campaign')}</dt><dd><UserText>{ft.campaignName}</UserText></dd></div>}
          {ft.occurredAt && <div><dt>{t('insights.c360.when')}</dt><dd>{date(ft.occurredAt, locale, tz)}</dd></div>}
        </dl>
      ) : <p className="c360-empty">{t('insights.c360.noAcquisition')}</p>)}
      {sec('consent', t('insights.profile.consent'), src(t('insights.c360.src.consent')), (
        <>
          <p className="c360-line">
            <Badge tone={c.consent.marketing.granted ? 'ok' : 'neutral'}>{t(c.consent.marketing.granted ? 'insights.customers.consentGranted' : 'insights.customers.consentNot')}</Badge>
            {c.consent.marketing.at && <span className="c360-sub"> {t('insights.c360.consentAt', { source: c.consent.marketing.source ? tk('insights.consentSource', c.consent.marketing.source) : '—', at: dateTime(c.consent.marketing.at, locale, tz) })}</span>}
          </p>
          {c.consent.channels.length > 0 && (
            <ul className="c360-list">
              {c.consent.channels.map((ch) => (
                <li key={ch.channel} data-contact-basis={ch.contactBasis}>{tk('insights.c360.ch', ch.channel)}
                  {/* 21-CRM: messaging the restaurant is not marketing consent; without an opt-in it is service replies only. */}
                  {ch.contactBasis === 'service_replies_only' && <span className="c360-sub"> · {t('crm.consent.serviceOnly')}</span>}
                  {ch.serviceWindow && <span className="c360-sub"> · {ch.serviceWindow.open
                    ? t('insights.c360.windowOpen', { until: dateTime(ch.serviceWindow.closesAt, locale, tz) }) : t('insights.c360.windowClosed')}</span>}</li>
              ))}
            </ul>
          )}
        </>
      ))}
      {sec('orders', t('insights.profile.orders'), null, c.recentOrders.length ? (
        <ul className="c360-list">
          {c.recentOrders.map((o) => (
            <li key={o.id}>
              <Link href={`/dashboard/${org.id}/orders?order=${o.id}`} className="c360-link"><OrderRef n={o.number} /></Link>
              <span className="c360-sub">{date(o.placedAt, locale, tz)} · {money(o.totalMinor, cur, locale)}</span>
              <span className="c360-chips"><StatusBadge kind="order" status={o.status} locale={locale} /><StatusBadge kind="payment" status={o.paymentStatus} locale={locale} /></span>
            </li>
          ))}
        </ul>
      ) : <p className="c360-empty">{t('insights.profile.noOrders')}</p>)}
      {sec('reservations', t('insights.profile.reservations'), null, c.reservations.length ? (
        <ul className="c360-list">
          {c.reservations.map((r) => (
            <li key={r.id}><span className="num">{r.code}</span> <span className="c360-sub">{dateTime(r.startsAt, locale, tz)} · {t('insights.c360.party', { n: r.partySize })}</span>
              <StatusBadge kind="reservation" status={r.status} locale={locale} /></li>
          ))}
        </ul>
      ) : <p className="c360-empty">{t('insights.profile.noReservations')}</p>)}
      {sec('loyalty', t('nav.loyalty'), null, c.sections.loyalty !== 'included' ? missing(c.sections.loyalty) : !c.loyalty || !c.loyalty.programActive
        ? <p className="c360-empty">{t('insights.c360.noLoyalty')}</p>
        : <p className="c360-line">{t('insights.c360.points', { n: c.loyalty.balance, total: num(c.loyalty.lifetimeEarned, locale) })}</p>)}
      {sec('conversations', t('insights.c360.conversations'), null, c.sections.conversations !== 'included' ? missing(c.sections.conversations) : convs.length ? (
        <ul className="c360-list">
          {convs.map((x) => (
            <li key={x.id}>
              <Link href={`/dashboard/${org.id}/inbox?c=${x.id}`} className="c360-link"><bdi>{x.channelName}</bdi></Link>
              <span className="c360-sub">{x.lastMessageAt ? dateTime(x.lastMessageAt, locale, tz) : '—'} · {tk('connect.status', x.status)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="c360-empty">{t('insights.c360.noOtherConversations')}</p>)}
      {sec('notes', t('insights.profile.notes'), null, (
        <>
          {c.notes.profile ? <p className="c360-note"><UserText>{c.notes.profile}</UserText></p> : <p className="c360-empty">{t('insights.c360.noProfileNote')}</p>}
          {c.notes.conversation && c.notes.conversation.length > 0 && (
            <ul className="c360-list" aria-label={t('insights.c360.staffNotes')}>
              {c.notes.conversation.slice(0, 5).map((n) => (
                <li key={n.id} className="c360-staff-note"><span className="c360-sub">{n.authorName ? <bdi>{n.authorName}</bdi> : t('insights.c360.staff')} · {dateTime(n.createdAt, locale, tz)}</span>
                  <p className="m-0"><UserText>{n.body}</UserText></p></li>
              ))}
            </ul>
          )}
        </>
      ))}
      <p className="c360-src c360-generated">{t('insights.c360.generated', { at: dateTime(c.generatedAt, locale, tz) })}</p>
    </div>
  );
}
