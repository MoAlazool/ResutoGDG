'use client';
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { FiscalDocumentView, FiscalKind, FiscalLine } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, Skeleton, Tabs, useAction, type Tone, Phone, UserText, OrderRef } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import s from '../compliance.module.css';

const STATUS_TONE: Record<string, Tone> = { issued: 'info', submitted: 'info', reported: 'ok', cleared: 'ok', accepted: 'ok', rejected: 'danger', error: 'danger', draft: 'neutral' };

interface Detail extends FiscalDocumentView {
  seller: Record<string, any>; meta: Record<string, any>; authorityRef: string | null; previousAuthorityRef: string | null;
  hashVerified: boolean; related: Array<{ id: string; kind: FiscalKind; number: string; totalMinor: number; issuedAt: string }>;
}
interface PrintView {
  title: { en: string; ar: string }; number: string; issuedAt: string; uuid: string; authority: string; environment: string | null; kind: FiscalKind;
  seller: { name: string; tradeName: string; tradeNameAr: string | null; vatNumber: string; address: Record<string, string>; branch: { name: string; address: string | null; city: string | null; phone: string | null } };
  buyer: { name?: string }; currency: string; lines: FiscalLine[]; totals: { subtotalMinor: number; taxMinor: number; totalMinor: number; vatRateBp: number | null };
  orderNumber: string | null; paymentMethod: string | null; reference: { number: string; issuedAt: string } | null; reason: string | null;
  qr: { kind: string; payload: string | null }; submission: { mode: string; status: string } | null; notice: string;
}
interface Submission { id: string; mode: string; status: string; attempt: number; environment: string; submittedAt: string; response: Record<string, any> }

/** Renders a QR code locally with the `qrcode` package (no external service). */
export function QrImage({ payload, size = 132, className }: { payload: string | null; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!payload) { setSrc(null); return; }
    QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: size * 2 }).then((u) => { if (alive) setSrc(u); }).catch(() => setSrc(null));
    return () => { alive = false; };
  }, [payload, size]);
  return src ? <img className={className} src={src} width={size} height={size} alt="QR" /> : <div style={{ width: size, height: size }} className="skeleton" />;
}

/** Prints one element in a new window that reuses this page's stylesheets. */
function printElement(el: HTMLElement | null, title: string) {
  if (!el) return;
  const w = window.open('', '_blank', 'width=720,height=900');
  if (!w) return;
  const styles = [...document.querySelectorAll('link[rel="stylesheet"], style')].map((n) => n.outerHTML).join('');
  w.document.write(`<!doctype html><html lang="${document.documentElement.lang}" dir="${document.documentElement.dir}"><head><meta charset="utf-8"><title>${title.replace(/</g, '')}</title>${styles}</head><body style="background:#fff;padding:16px">${el.outerHTML}</body></html>`);
  w.document.close();
  w.onload = () => { w.focus(); w.print(); };
}

function Invoice({ view, innerRef }: { view: PrintView; innerRef: React.Ref<HTMLDivElement> }) {
  const { t, locale } = useT();
  const m = (x: number) => money(x, view.currency, locale);
  return (
    <div ref={innerRef} className={s.invoice}>
      <div className={s.invoiceHead}>
        <div>
          <h3>{view.title.ar} — {view.title.en}</h3>
          <div><strong><UserText>{view.seller.name}</UserText></strong>{view.seller.tradeName && view.seller.tradeName !== view.seller.name ? <> (<UserText>{locale === 'ar' && view.seller.tradeNameAr ? view.seller.tradeNameAr : view.seller.tradeName}</UserText>)</> : ''}</div>
          <div>{t('compliance.doc.vatNumber')}: <span dir="ltr">{view.seller.vatNumber}</span></div>
          <div className="fine"><UserText>{Object.values(view.seller.address ?? {}).filter(Boolean).join(', ')}</UserText></div>
          <div className="fine"><UserText>{view.seller.branch.name}</UserText>{view.seller.branch.phone ? <> · <Phone value={view.seller.branch.phone} /></> : ''}</div>
        </div>
        <QrImage payload={view.qr.payload} className={s.qr} />
      </div>
      <div className="row fine" style={{ gap: 14 }}>
        <span>{t('compliance.doc.number')}: <strong dir="ltr">{view.number}</strong></span>
        <span>{t('compliance.doc.issued')}: {dateTime(view.issuedAt, locale)}</span>
        {view.orderNumber && <span>{t('compliance.doc.order')}: <OrderRef n={view.orderNumber} /></span>}
        {view.reference && <span>{t('compliance.doc.references')}: <span dir="ltr">{view.reference.number}</span></span>}
        {view.buyer?.name && <span>{t('compliance.doc.buyer')}: {view.buyer.name}</span>}
      </div>
      <table className={s.lines}>
        <thead><tr><th>{t('compliance.doc.item')}</th><th className={s.num}>{t('compliance.doc.qty')}</th><th className={s.num}>{t('compliance.doc.net')}</th><th className={s.num}>{t('compliance.doc.vat')}</th><th className={s.num}>{t('compliance.doc.gross')}</th></tr></thead>
        <tbody>{view.lines.map((l, i) => (
          <tr key={i}><td>{locale === 'ar' && l.nameAr ? l.nameAr : l.name}{l.discountMinor ? <span className="fine"> (−{m(l.discountMinor)})</span> : null}</td>
            <td className={s.num}>{l.quantity}</td><td className={s.num}>{m(l.netMinor)}</td><td className={s.num}>{m(l.vatMinor)}</td><td className={s.num}>{m(l.grossMinor)}</td></tr>
        ))}</tbody>
      </table>
      <div className={s.totals}>
        <div><span>{t('compliance.doc.subtotal')}</span><span>{m(view.totals.subtotalMinor)}</span></div>
        <div><span>{t('compliance.doc.vatTotal')}{view.totals.vatRateBp !== null ? ` (${view.totals.vatRateBp / 100}%)` : ''}</span><span>{m(view.totals.taxMinor)}</span></div>
        <div className={s.grand}><span>{t('compliance.doc.total')}</span><span>{m(view.totals.totalMinor)}</span></div>
      </div>
      {view.reason && <div className="fine">{t('compliance.doc.reason')}: {view.reason}</div>}
      <div className={`fine ${s.mono}`}>UUID {view.uuid}</div>
      <div className="fine">{view.submission?.mode === 'sandbox_stub' ? t('compliance.doc.stubNotice') : view.notice}</div>
    </div>
  );
}

function DocumentModal({ id, onClose, onChanged }: { id: string; onClose(): void; onChanged(): void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const doc = useApi<Detail>(`/o/${org.id}/compliance/fiscal-documents/${id}`);
  const print = useApi<PrintView>(`/o/${org.id}/compliance/fiscal-documents/${id}/print`);
  const subs = useApi<{ items: Submission[] }>(`/o/${org.id}/compliance/fiscal-documents/${id}/submissions`);
  const [payload, setPayload] = useState<{ format: string; payload: string; note: string; matchesIssued: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => { await fn(); await Promise.all([doc.reload(), subs.reload()]); onChanged(); });
  const d = doc.data;
  return (
    <Modal open onClose={onClose} title={d ? `${t(`compliance.kind.${d.kind}`)} ${d.number}` : t('state.loading')}>
      {!d || !print.data ? (doc.error || print.error ? <Notice tone="danger">{(doc.error ?? print.error)!.message}</Notice> : <Skeleton lines={8} />) : (
        <div className="stack">
          <div className="row">
            <Badge tone={STATUS_TONE[d.status]}>{t(`compliance.status.${d.status}`)}</Badge>
            {d.lastSubmission?.mode === 'sandbox_stub' && <span className="badge badge-sandbox">{t('compliance.doc.sandboxStub')}</span>}
            <Badge tone={d.hashVerified ? 'ok' : 'danger'}>{d.hashVerified ? t('compliance.doc.hashOk') : t('compliance.doc.hashBad')}</Badge>
          </div>
          <Invoice view={print.data} innerRef={ref} />
          <div className="row">
            <button className="btn btn-sm" onClick={() => printElement(ref.current, d.number)}>{t('compliance.doc.print')}</button>
            <button className="btn btn-sm" onClick={() => void call<any>(`/o/${org.id}/compliance/fiscal-documents/${id}/payload`).then(setPayload)}>{'</>'} {t('compliance.doc.payload')}</button>
            {can('compliance:write') && <button className="btn btn-sm" disabled={act.pending} onClick={() => void act.run(() => call(`/o/${org.id}/compliance/fiscal-documents/${id}/resubmit`, { body: {} }))}>↻ {t('compliance.doc.resubmit')}</button>}
          </div>
          {act.error && <Notice tone="danger">{act.error}</Notice>}
          {payload && (
            <div className="stack" style={{ gap: 6 }}>
              <span className="fine">{payload.note} {payload.matchesIssued ? `· ${t('compliance.doc.payloadMatches')}` : ''}</span>
              <pre className={s.payload} dir="ltr">{payload.payload}</pre>
            </div>
          )}
          <div className="stack" style={{ gap: 4 }}>
            <span className="fine">{t('compliance.doc.chain')}</span>
            <span className={s.mono} dir="ltr">prev {d.previousHash ?? '∅ (first)'}</span>
            <span className={s.mono} dir="ltr">hash {d.documentHash}</span>
            <span className={s.mono} dir="ltr">{d.authority === 'zatca' ? 'PIH' : 'previousUUID'} {d.previousAuthorityRef ?? '∅'} → {d.authorityRef}</span>
          </div>
          {!!d.related.length && (
            <div className="fine">{t('compliance.doc.related')}: {d.related.map((r) => `${t(`compliance.kind.${r.kind}`)} ${r.number} (${money(r.totalMinor, d.currency, locale)})`).join(' · ')}</div>
          )}
          <div>
            <strong>{t('compliance.doc.submissions')}</strong>
            {(subs.data?.items ?? []).map((x) => (
              <div key={x.id} className="spread fine" style={{ borderBlockEnd: '1px solid var(--line-soft)', paddingBlock: 6 }}>
                <span><OrderRef n={x.attempt} /> · {t(`compliance.mode.${x.mode}`)} · {x.environment}</span>
                <span><Badge tone={x.status === 'rejected' ? 'danger' : 'info'}>{t(`compliance.subStatus.${x.status}`)}</Badge> {dateTime(x.submittedAt, locale)}</span>
                {x.response?.localValidation?.problems?.length ? <span style={{ width: '100%', color: 'var(--danger)' }}>{x.response.localValidation.problems.join('; ')}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** Fiscal documents list with filters, paging, chain verification and manual issue. */
export function FiscalDocuments() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const [kind, setKind] = useState<'all' | FiscalKind>('all');
  const [items, setItems] = useState<FiscalDocumentView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; series: Array<{ series: string; count: number; ok: boolean; firstBreak: { number: string; reason: string } | null }> } | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => fn());

  const load = useCallback(async (next: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: '50' });
      if (kind !== 'all') q.set('kind', kind);
      if (next) q.set('cursor', next);
      const page = await call<{ items: FiscalDocumentView[]; nextCursor: string | null }>(`/o/${org.id}/compliance/fiscal-documents?${q}`);
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [call, org.id, kind]);
  useEffect(() => { void load(null); }, [load]);

  async function issue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const orderId = String(new FormData(e.currentTarget).get('orderId') || '').trim();
    const r = await act.run(() => call<{ id: string }>(`/o/${org.id}/compliance/fiscal-documents/issue`, { body: { orderId } }));
    if (r && typeof r === 'object' && 'id' in r) { await load(null); setOpen((r as { id: string }).id); }
  }

  return (
    <div className="stack">
      <div className="spread">
        <Tabs<'all' | FiscalKind> value={kind} onChange={setKind} tabs={[
          { key: 'all', label: t('compliance.doc.all') },
          { key: org.country === 'SA' ? 'simplified_invoice' : 'receipt', label: t(`compliance.kind.${org.country === 'SA' ? 'simplified_invoice' : 'receipt'}`) },
          { key: 'credit_note', label: t('compliance.kind.credit_note') },
        ]} />
        <div className="row">
          {org.branches.filter((b) => b.isActive).map((b) => (
            <button key={b.id} className="btn btn-sm" disabled={act.pending}
              onClick={() => void act.run(async () => setVerify(await call(`/o/${org.id}/compliance/fiscal-documents/verify?branchId=${b.id}`)))}>
              ✓ {t('compliance.doc.verify', { branch: locale === 'ar' && b.nameAr ? b.nameAr : b.name })}
            </button>
          ))}
        </div>
      </div>
      {verify && (
        <Notice tone={verify.ok ? 'ok' : 'danger'}>
          {verify.ok ? t('compliance.doc.chainOk') : t('compliance.doc.chainBroken')}{' '}
          {verify.series.map((x) => `${x.series}: ${x.count}${x.firstBreak ? ` — ${x.firstBreak.number} ${x.firstBreak.reason}` : ''}`).join(' · ') || t('compliance.doc.noDocs')}
        </Notice>
      )}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {error && <Notice tone="danger">{error}</Notice>}
      {loading && !items.length ? <Skeleton lines={6} /> : (
        <DataTable rows={items} rowKey={(d) => d.id} onRowClick={(d) => setOpen(d.id)}
          empty={<EmptyState title={t('compliance.doc.empty')}>{t('compliance.doc.emptyHint')}</EmptyState>}
          columns={[
            { key: 'number', header: t('compliance.doc.number'), render: (d) => <strong dir="ltr">{d.number}</strong> },
            { key: 'kind', header: t('compliance.doc.kind'), render: (d) => t(`compliance.kind.${d.kind}`) },
            { key: 'issued', header: t('compliance.doc.issued'), render: (d) => dateTime(d.issuedAt, locale) },
            { key: 'total', header: t('compliance.doc.total'), align: 'end', render: (d) => money(d.totalMinor, d.currency, locale) },
            { key: 'vat', header: t('compliance.doc.vat'), align: 'end', render: (d) => money(d.taxMinor, d.currency, locale) },
            { key: 'status', header: t('compliance.doc.status'), render: (d) => (
              <div className="row" style={{ gap: 4 }}>
                <Badge tone={STATUS_TONE[d.status]}>{t(`compliance.status.${d.status}`)}</Badge>
                {d.lastSubmission?.mode === 'sandbox_stub' && <span className="badge badge-sandbox">{t('compliance.doc.sandboxStub')}</span>}
              </div>
            ) },
          ]} />
      )}
      {cursor && <button className="btn" disabled={loading} onClick={() => void load(cursor)}>{t('compliance.loadMore')}</button>}
      {can('compliance:write') && (
        <form className="row" onSubmit={issue} style={{ alignItems: 'end' }}>
          <Field label={t('compliance.doc.issueManual')} name="orderId" placeholder="00000000-0000-0000-0000-000000000000" pattern="[0-9a-fA-F-]{36}" required dir="ltr" hint={t('compliance.doc.issueHint')} />
          <div className="field"><button className="btn" disabled={act.pending}>{t('compliance.doc.issue')}</button></div>
        </form>
      )}
      {open && <DocumentModal id={open} onClose={() => setOpen(null)} onChanged={() => void load(null)} />}
    </div>
  );
}
