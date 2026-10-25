'use client';
// Guided setup (VS-17, FT-13), restored from legacy/public/setup.js: "A great service starts here." Eight steps with
// check circles on the left, "n / 8" progress, Back / Save & continue, and "Continue setup later". What counts as done
// comes from GET /o/:org/setup, which derives every step from the restaurant's data; nothing can be ticked by hand.
// Launch is the one explicit step and the server refuses it until the required steps are done.
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { SETUP_STEPS, formatNumber, type ServiceMode, type SetupChecklist, type SetupStep } from '@resuto/contracts';
import { Field, Icon, Notice, SelectField, Skeleton } from '@resuto/ui';
import { CheckIcon, CircleIcon, ExternalIcon, ForwardIcon } from '@/components/icons/glyphs';
import { ServiceModeCards, VenueQrCard } from '@/components/ops/ServiceMode';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface BranchDetail {
  id: string; name: string; nameAr: string | null; address: string | null; city: string | null; phone: string | null; isActive: boolean;
  acceptsDineIn: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean; serviceMode?: ServiceMode;
  openingHours: Array<{ day: number; opens: string; closes: string }> | null;
}
interface OrgDetail {
  id: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR'; timezone: string; defaultLocale: 'en' | 'ar';
  legalName: string | null; taxRegistrationNumber: string | null; commercialRegistration: string | null; branches: BranchDetail[];
}

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export default function SetupPage() {
  return (
    <ModuleGate module="core" permission="org:manage">
      <Suspense fallback={<Skeleton lines={8} />}><Setup /></Suspense>
    </ModuleGate>
  );
}

function Setup() {
  const { t, locale } = useT();
  const { org, branchId: shellBranch, can, reload: reloadShell } = useOrg();
  const session = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const detail = useApi<OrgDetail>(`/o/${org.id}`);
  const branchId = shellBranch ?? org.branches[0]?.id ?? '';
  const setup = useApi<SetupChecklist>(`/o/${org.id}/setup${branchId ? `?branchId=${branchId}` : ''}`);
  const requested = params.get('step') as SetupStep | null;
  const firstOpen = setup.data?.steps.find((s) => s.required && !s.done)?.step ?? (setup.data ? 'launch' : 'welcome');
  const step: SetupStep = requested && SETUP_STEPS.includes(requested) ? requested : (setup.data && !setup.data.launched ? (firstOpen === 'profile' ? 'welcome' : firstOpen) : 'welcome');
  const index = SETUP_STEPS.indexOf(step);
  const go = (s: SetupStep) => router.replace(`${pathname}?step=${s}`, { scroll: false });
  const next = () => go(SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)]!);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [step]);

  const refresh = async () => { await Promise.all([setup.reload(), detail.reload(), reloadShell()]); };
  /** Saves the step's form (when it has one), re-reads the derived checklist, then moves on. */
  const saveAndContinue = async (fn?: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true); setError(null);
    try { if (fn) { await fn(); await refresh(); } next(); }
    catch (e) { setError((e as Error).message); }
    finally { setPending(false); }
  };

  const d = detail.data;
  const branch = d?.branches.find((b) => b.id === (setup.data?.branchId ?? branchId)) ?? d?.branches[0];
  const check = (s: SetupStep) => setup.data?.steps.find((x) => x.step === s);
  const nf = (n: number) => formatNumber(n, locale);

  return (
    <div className="setup-shell">
      <aside className="setup-aside">
        <span className="overline">RESUTO / {t('ops.setup.overline')}</span>
        <h1>{t('ops.setup.title')}</h1>
        <ol className="setup-steps">
          {SETUP_STEPS.map((s, i) => {
            const done = check(s)?.done && s !== 'welcome';
            return (
              <li key={s} className={s === step ? 'current' : undefined}>
                <button type="button" onClick={() => go(s)} aria-current={s === step ? 'step' : undefined}>
                  <span className={done ? 'is-done' : undefined} aria-hidden="true">{done ? <Icon icon={CheckIcon} size={14} /> : nf(i + 1)}</span>
                  {t(`ops.setup.step.${s}`)}
                  {done && <span className="sr-only"> · {t('ops.setup.done')}</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <Link href={`/dashboard/${org.id}`} className="setup-later">{t('ops.setup.later')} <Icon icon={ForwardIcon} size={14} /></Link>
      </aside>

      <section className="setup-card">
        <div className="setup-progress">
          <bdi dir="ltr" className="num">{nf(index + 1)} / {nf(SETUP_STEPS.length)}</bdi>
          <progress value={index + 1} max={SETUP_STEPS.length} aria-label={t('ops.setup.progress')} />
        </div>
        <h2>{t(`ops.setup.step.${step}`)}</h2>
        {setup.error && <Notice tone="danger">{setup.error.message}</Notice>}
        {!setup.data || !d ? <Skeleton lines={6} /> : (
          renderStep()
        )}
      </section>
    </div>
  );

  function Footer({ submit, label, disabled }: { submit?: boolean; label?: string; disabled?: boolean }) {
    return (
      <>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="setup-footer">
          <button type="button" className="btn btn-ghost" disabled={index === 0 || pending} onClick={() => go(SETUP_STEPS[index - 1]!)}>{t('action.back')}</button>
          {submit
            ? <button type="submit" className="btn btn-primary" disabled={pending || disabled}>{pending ? t('state.loading') : <>{label ?? t('ops.setup.saveContinue')} <Icon icon={ForwardIcon} size={16} /></>}</button>
            : <button type="button" className="btn btn-primary" disabled={pending || disabled} onClick={() => void saveAndContinue()}>{label ?? t('action.continue')} <Icon icon={ForwardIcon} size={16} /></button>}
        </div>
      </>
    );
  }

  function Status({ s }: { s: SetupStep }) {
    const c = check(s);
    if (!c || s === 'welcome') return null;
    return <p className={`setup-status${c.done ? ' is-done' : ''}`}><span aria-hidden="true"><Icon icon={c.done ? CheckIcon : CircleIcon} size={14} /></span>{t(c.done ? 'ops.setup.status.done' : c.required ? 'ops.setup.status.todo' : 'ops.setup.status.optional')}</p>;
  }

  function renderStep(): ReactNode {
    const base = `/dashboard/${org.id}`;
    switch (step) {
      case 'welcome':
        return (<>
          <div className="setup-welcome" aria-hidden="true">✦</div>
          <h3 className="setup-lead">{t('ops.setup.welcome.title')}</h3>
          <p className="fine setup-lead-text">{t('ops.setup.welcome.body')}</p>
          <Footer />
        </>);
      case 'profile':
        return (
          <form onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const v = (k: string) => String(f.get(k) ?? '').trim();
            void saveAndContinue(() => session.call(`/o/${org.id}`, { method: 'PATCH', body: {
              name: v('name'), nameAr: v('nameAr') || null, defaultLocale: v('defaultLocale'), legalName: v('legalName') || null,
              taxRegistrationNumber: v('tax') || null, commercialRegistration: v('cr') || null,
            } }));
          }}>
            <Status s="profile" />
            <div className="setup-fields">
              <Field label={t('ops.setup.profile.name')} name="name" required maxLength={120} defaultValue={d!.name} />
              <Field label={t('ops.setup.profile.nameAr')} name="nameAr" dir="rtl" maxLength={120} defaultValue={d!.nameAr ?? ''} />
              <Field label={t('ops.setup.profile.legalName')} name="legalName" required maxLength={200} defaultValue={d!.legalName ?? ''} hint={t('ops.setup.profile.legalHint')} />
              <SelectField label={t('ops.setup.profile.language')} name="defaultLocale" defaultValue={d!.defaultLocale}>
                <option value="en">English</option><option value="ar">العربية</option>
              </SelectField>
              <Field label={t('ops.setup.profile.tax')} name="tax" dir="ltr" maxLength={40} defaultValue={d!.taxRegistrationNumber ?? ''} />
              <Field label={t('ops.setup.profile.cr')} name="cr" dir="ltr" maxLength={40} defaultValue={d!.commercialRegistration ?? ''} />
            </div>
            <p className="fine"><bdi>{d!.currency}</bdi> · <bdi>{d!.timezone}</bdi></p>
            <Footer submit />
          </form>
        );
      case 'branch': {
        if (!branch) return <><Notice tone="warn">{t('ops.setup.branch.none')}</Notice><Footer /></>;
        const hours = branch.openingHours ?? [];
        const first = hours[0];
        // One window, the same every open day, is what this step edits; detailed hours are left alone.
        const uniform = hours.every((h) => h.opens === first?.opens && h.closes === first?.closes) && new Set(hours.map((h) => h.day)).size === hours.length;
        return (
          <form onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const v = (k: string) => String(f.get(k) ?? '').trim();
            const opens = v('opens'); const closes = v('closes');
            const days = DAYS.filter((day) => f.has(`day-${day}`));
            void saveAndContinue(() => session.call(`/o/${org.id}/branches/${branch.id}`, { method: 'PATCH', body: {
              name: v('name'), address: v('address') || null, city: v('city') || null, phone: v('phone') || null,
              acceptsPickup: f.has('pickup'), acceptsDelivery: f.has('delivery'),
              ...(branch.serviceMode === 'tables' || !branch.serviceMode ? { acceptsDineIn: f.has('dineIn') } : {}),
              ...(uniform ? { openingHours: opens && closes ? days.map((day) => ({ day, opens, closes })) : [] } : {}),
            } }));
          }}>
            <Status s="branch" />
            <div className="setup-fields">
              <Field label={t('ops.setup.branch.name')} name="name" required maxLength={120} defaultValue={branch.name} />
              <Field label={t('ops.setup.branch.phone')} name="phone" dir="ltr" maxLength={30} defaultValue={branch.phone ?? ''} />
              <Field label={t('ops.setup.branch.address')} name="address" maxLength={300} defaultValue={branch.address ?? ''} />
              <Field label={t('ops.setup.branch.city')} name="city" maxLength={80} defaultValue={branch.city ?? ''} />
              {uniform && <>
                <Field label={t('ops.setup.branch.opens')} name="opens" type="time" defaultValue={first?.opens ?? '12:00'} />
                <Field label={t('ops.setup.branch.closes')} name="closes" type="time" defaultValue={first?.closes ?? '23:00'} hint={t('ops.setup.branch.hoursHint')} />
              </>}
            </div>
            {uniform ? (
              <fieldset className="setup-options">
                <legend>{t('ops.setup.branch.days')}</legend>
                {DAYS.map((day) => (
                  <label key={day} className="check"><input type="checkbox" name={`day-${day}`} defaultChecked={!hours.length || hours.some((h) => h.day === day)} />{t(`ops.setup.day.${day}`)}</label>
                ))}
              </fieldset>
            ) : <p className="fine">{t('ops.setup.branch.detailedHours')}</p>}
            <fieldset className="setup-options">
              <legend>{t('ops.setup.branch.services')}</legend>
              {(branch.serviceMode ?? 'tables') === 'tables' && <label className="check"><input type="checkbox" name="dineIn" defaultChecked={branch.acceptsDineIn} />{t('ops.setup.branch.dineIn')}</label>}
              <label className="check"><input type="checkbox" name="pickup" defaultChecked={branch.acceptsPickup} />{t('ops.setup.branch.pickup')}</label>
              <label className="check"><input type="checkbox" name="delivery" defaultChecked={branch.acceptsDelivery} />{t('ops.setup.branch.delivery')}</label>
            </fieldset>
            <Footer submit />
          </form>
        );
      }
      case 'mode':
        if (!branch) return <Footer />;
        return (<>
          <Status s="mode" />
          <p className="fine">{t('ops.setup.mode.body')}</p>
          <ServiceModeCards key={branch.id} orgId={org.id} branch={branch} canEdit={can('branches:manage')} saveLabel={t('ops.setup.mode.save')}
            onSaved={async () => { await refresh(); next(); }} />
          <Footer label={t('ops.setup.skip')} />
        </>);
      case 'menu': {
        const c = check('menu');
        return (<>
          <Status s="menu" />
          <div className="setup-focus">
            <h3>{t('ops.setup.menu.title')}</h3>
            <p className="fine">{t('ops.setup.menu.count', { n: Number(c?.detail.orderable ?? 0) })}</p>
            <div className="owner-choices">
              <Link href={`${base}/menu`}>{t('ops.setup.menu.manual')}</Link>
              <Link href={`${base}/menu?tab=import`}>{t('ops.setup.menu.import')}</Link>
              <Link href={`${base}/integrations`}>{t('ops.menu.sync')}</Link>
            </div>
          </div>
          <Footer />
        </>);
      }
      case 'floor': {
        const c = check('floor');
        const mode = setup.data!.serviceMode;
        return (<>
          <Status s="floor" />
          {mode === 'tables' ? (
            <div className="setup-focus">
              <h3>{t('ops.setup.floor.title')}</h3>
              <p className="fine">{t('ops.setup.floor.count', { n: Number(c?.detail.tables ?? 0) })}</p>
              <div className="owner-choices">
                <Link href={`${base}/floor?tab=studio`}>{t('ops.studio.manual')}</Link>
                <Link href={`${base}/floor?tab=studio`}>{t('ops.studio.upload')}</Link>
                <span className="is-disabled" aria-disabled="true">{t('ops.studio.ai')}<small>{t('ops.studio.aiSoon')}</small></span>
              </div>
            </div>
          ) : mode === 'counter' && branch ? (
            <><p className="fine">{t('ops.setup.floor.counter')}</p><VenueQrCard orgId={org.id} branchId={branch.id} /></>
          ) : <p className="fine">{t('ops.setup.floor.online')}</p>}
          <Footer />
        </>);
      }
      case 'payments': {
        const c = check('payments');
        const n = Number(c?.detail.onlineProviders ?? 0);
        return (<>
          <div className="setup-focus">
            <span className="setup-focus-icon" aria-hidden="true">◎</span>
            <h3>{t('ops.setup.payments.title')}</h3>
            <p className="fine">{t('ops.setup.payments.body')}</p>
            <div className="readiness-list">
              <p><span aria-hidden="true"><Icon icon={CheckIcon} size={14} /></span><strong>{t('ops.setup.payments.cash')}</strong><small>{t('ops.setup.payments.cashKind')}</small></p>
              <p><span aria-hidden="true"><Icon icon={n ? CheckIcon : CircleIcon} size={14} /></span><strong>{t('ops.setup.payments.online')}</strong><small>{n ? t('ops.setup.payments.connected', { n }) : t('ops.setup.payments.none')}</small></p>
            </div>
            <Link href={`${base}/${can('payments:read') ? 'payments' : 'integrations'}`}>{t('ops.setup.payments.review')} <Icon icon={ExternalIcon} size={14} /></Link>
          </div>
          <Footer />
        </>);
      }
      case 'launch': {
        const s = setup.data!;
        const missing = s.steps.filter((x) => x.required && !x.done);
        return (<>
          <div className="setup-checklist">
            {s.steps.filter((x) => x.step !== 'welcome' && x.step !== 'launch').map((x) => (
              <p key={x.step} className={x.done ? 'is-done' : undefined}>
                <span aria-hidden="true"><Icon icon={x.done ? CheckIcon : CircleIcon} size={14} /></span>
                <button type="button" className="ops-link" onClick={() => go(x.step)}>{t(`ops.setup.step.${x.step}`)}</button>
                {!x.required && <small>{t('ops.setup.status.optional')}</small>}
              </p>
            ))}
          </div>
          <p>{t('ops.setup.launch.preview')}</p>
          <div className="row">
            <a className="btn" href={`/r/${org.slug}`} target="_blank" rel="noopener noreferrer">{t('ops.setup.launch.guest')} <Icon icon={ExternalIcon} size={14} /></a>
            <Link className="btn" href={base}>{t('ops.setup.launch.dashboard')}</Link>
          </div>
          {s.launched ? <Notice tone="ok">{t('ops.setup.launch.live')}</Notice>
            : missing.length ? <Notice tone="warn">{t('ops.setup.launch.missing', { list: missing.map((x) => t(`ops.setup.step.${x.step}`)).join(locale === 'ar' ? '، ' : ', ') })}</Notice> : null}
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="setup-footer">
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={() => go(SETUP_STEPS[index - 1]!)}>{t('action.back')}</button>
            {!s.launched && (
              <button type="button" className="btn btn-primary" disabled={pending || !s.ready} onClick={async () => {
                if (pending) return;
                setPending(true); setError(null);
                try { await session.call(`/o/${org.id}/setup/launch`, { body: {} }); await refresh(); }
                catch (e) { setError((e as Error).message); } finally { setPending(false); }
              }}>{pending ? t('state.loading') : t('ops.setup.launch.go')}</button>
            )}
          </div>
        </>);
      }
    }
  }
}
