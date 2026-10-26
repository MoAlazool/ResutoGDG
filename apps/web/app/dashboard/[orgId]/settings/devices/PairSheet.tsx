'use client';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Page, PosDeviceSummary, PosPairingCreated } from '@resuto/contracts';
import { Field, Notice, SelectField, Sheet, Switch, UserText } from '@resuto/ui';
import { API_URL, ApiRequestError } from '@/lib/api';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import {
  codeDeadline, defaultPairForm, deviceAbilities, displayCode, formatCountdown, pairedWith, pairRequest, POS_ACTING_ROLES, POS_DEVICE_NAME_MAX,
  POS_DEVICE_TTL_DAYS, POS_PAIRING_MINUTES, secondsLeft, type PairError, type PairField, type PairForm, type PosActingRole,
} from './model';
import styles from './devices.module.css';

interface Created extends PosPairingCreated { minutes: number; deadline: number }

/**
 * "Pair a new iPad" (22-DEVICES): branch, acting role, name, code lifetime, staff sign-in (on by default, contract
 * 0.2.0) and how long the device stays paired; then the one-time code, large and copyable, with a live countdown, the
 * steps on the iPad and the API address. The code is held only in this panel's state: closing it forgets the code.
 * The device credential (rpos_…) goes to the iPad alone; this page never receives it.
 */
export function PairSheet({ open, onClose, onPaired }: { open: boolean; onClose: () => void; onPaired: () => void }) {
  const { locale, t, tn } = useT();
  const { org } = useOrg();
  const session = useSession();
  const formId = useId();
  const branches = org.branches.filter((b) => b.isActive);
  const firstBranch = branches[0]?.id ?? '';
  const [form, setForm] = useState<PairForm>(() => defaultPairForm(firstBranch));
  const [errors, setErrors] = useState<Partial<Record<PairField, PairError>>>({});
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [paired, setPaired] = useState<PosDeviceSummary | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // A fresh form each time the panel opens; closing it forgets the code (it is shown once).
  useEffect(() => {
    if (!open) return;
    setForm(defaultPairForm(firstBranch)); setErrors({}); setFailure(null); setCreated(null); setPaired(null); setCopied(false);
  }, [open, firstBranch]);

  const left = created ? secondsLeft(created.deadline, now) : 0;
  const waiting = !!created && !paired && left > 0;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [waiting]);

  // While the code is valid, look for the iPad that uses it (the panel is a dialog: keep polling while it is open).
  const recent = useApi<Page<PosDeviceSummary>>(waiting ? `/o/${org.id}/pos/devices?limit=20&status=active` : null, { pollMs: 3000, pauseWhileEditing: false });
  useEffect(() => {
    if (!created || paired || !recent.data) return;
    const d = pairedWith(recent.data.items, created);
    if (d) { setPaired(d); onPaired(); }
  }, [recent.data, created, paired, onPaired]);

  const set = <K extends keyof PairForm>(k: K, v: PairForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setErrors((e) => ({ ...e, [k]: undefined })); };
  const errorText = (field: PairField, min?: number, max?: number) => {
    const e = errors[field];
    if (!e) return null;
    if (e === 'range' && field === 'name') return t('devices.pair.errRange', { min: 1, max: POS_DEVICE_NAME_MAX });
    return e === 'required' ? t('devices.pair.errRequired') : t('devices.pair.errRange', { min: min ?? 1, max: max ?? 1 });
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = pairRequest(form);
    if (!r.ok) { setErrors(r.errors); return; }
    setPending(true); setFailure(null);
    const requestedAt = Date.now();
    try {
      const res = await session.call<PosPairingCreated>(`/o/${org.id}/pos/pairings`, { body: r.body });
      const minutes = r.body.expiresInMinutes;
      setCreated({ ...res, minutes, deadline: codeDeadline(requestedAt, minutes) });
      setNow(Date.now());
    } catch (err) {
      setFailure(t('devices.pair.failed', { message: (err as ApiRequestError).message }));
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard?.writeText(displayCode(created.code)); } catch { /* the code stays selectable */ }
    setCopied(true);
  }

  const restart = () => { setForm(defaultPairForm(form.branchId || firstBranch)); setErrors({}); setFailure(null); setCreated(null); setPaired(null); setCopied(false); };

  const footer = created ? (
    <div className={styles.actions}>
      <button type="button" className="btn" onClick={restart}>{t('devices.code.another')}</button>
      <button type="button" className="btn btn-primary" onClick={onClose}>{t('devices.code.done')}</button>
    </div>
  ) : (
    <div className={styles.actions}>
      <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
      <button type="submit" form={formId} className="btn btn-primary" disabled={pending || !branches.length} aria-busy={pending || undefined}>
        {pending ? t('devices.pair.creating') : t('devices.pair.create')}
      </button>
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} locale={locale} size="md" closeOnBackdrop={!created}
      title={created ? tn('devices.code.title', { name: <UserText>{created.name}</UserText> }) : t('devices.pair.title')}
      description={created ? undefined : t('devices.pair.description')} labels={{ close: t('action.close') }} footer={footer}>
      {created ? (
        <div className={styles.codeView}>
          {paired && <Notice tone="ok">{tn('devices.code.paired', { name: <UserText>{paired.name}</UserText> })}</Notice>}
          <div>
            <p className={styles.codeLabel} id={`${formId}-code`}>{t('devices.code.label')}</p>
            <div className={styles.codeRow}>
              <output className={styles.code} dir="ltr" aria-labelledby={`${formId}-code`} data-testid="pairing-code">{displayCode(created.code)}</output>
              <button type="button" className="btn" onClick={() => void copy()}>{copied ? t('devices.code.copied') : t('devices.code.copy')}</button>
            </div>
          </div>
          {!paired && (left > 0
            ? <p className={styles.timer}>{t('devices.code.expiresIn')} <strong role="timer" dir="ltr" data-testid="code-countdown">{formatCountdown(left)}</strong></p>
            : <Notice tone="warn">{t('devices.code.expired')}</Notice>)}
          {!paired && <Notice tone="warn">{t('devices.code.once')}</Notice>}
          <div>
            <h3 className={styles.stepsTitle}>{t('devices.code.steps')}</h3>
            <ol className={styles.steps}>
              <li>{t('devices.code.step1')}</li>
              <li>{t('devices.code.step2')}</li>
              <li>{t('devices.code.step3')}</li>
            </ol>
          </div>
          <div className={styles.api}>
            <span>{t('devices.code.api')}</span>
            <code className={styles.apiValue} dir="ltr" data-testid="api-base">{`${API_URL}/v1`}</code>
            <small>{t('devices.code.apiHint')}</small>
          </div>
          <p className="fine mbs-0">{t('devices.code.secret')}</p>
          {waiting && <p className="fine mbs-0" role="status">{t('devices.code.waiting')}</p>}
        </div>
      ) : (
        <form id={formId} className={styles.form} onSubmit={submit} noValidate>
          {!branches.length && <Notice tone="warn">{t('devices.pair.noBranch')}</Notice>}
          <SelectField label={t('devices.pair.branch')} hint={t('devices.pair.branchHint')} value={form.branchId} error={errorText('branchId')}
            onChange={(e) => set('branchId', e.target.value)}>
            {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
          </SelectField>
          <fieldset className={styles.roles}>
            <legend>{t('devices.pair.role')}</legend>
            {POS_ACTING_ROLES.map((r) => (
              <label key={r} className={styles.role}>
                <input type="radio" name={`${formId}-role`} value={r} checked={form.actingRole === r} onChange={() => set('actingRole', r as PosActingRole)} />
                <span><strong>{t(`role.${r}`)}</strong><small>{t(`devices.role.summary.${r}`)}</small></span>
              </label>
            ))}
          </fieldset>
          <div className={styles.abilities} aria-live="polite">
            <p>{t('devices.pair.can')}</p>
            <ul>{deviceAbilities(form.actingRole).map((k) => <li key={k}>{t(`devices.ability.${k}`)}</li>)}</ul>
            <p>{t('devices.pair.cannot')}</p>
          </div>
          <Field label={t('devices.pair.name')} hint={t('devices.pair.nameHint')} placeholder={t('devices.pair.namePlaceholder')} value={form.name}
            maxLength={POS_DEVICE_NAME_MAX} required autoComplete="off" error={errorText('name')} onChange={(e) => set('name', e.target.value)} />
          <Switch checked={form.requireStaff} onChange={(v) => set('requireStaff', v)} label={t('devices.pair.staff')} description={t('devices.pair.staffHint')} />
          <div className={styles.numbers}>
            <Field label={t('devices.pair.minutes')} inputMode="numeric" value={form.minutes} dir="ltr" required
              hint={t('devices.pair.minutesHint', { min: POS_PAIRING_MINUTES.min, max: POS_PAIRING_MINUTES.max })}
              error={errorText('minutes', POS_PAIRING_MINUTES.min, POS_PAIRING_MINUTES.max)} onChange={(e) => set('minutes', e.target.value)} />
            <Field label={t('devices.pair.days')} inputMode="numeric" value={form.days} dir="ltr" required
              hint={t('devices.pair.daysHint', { min: POS_DEVICE_TTL_DAYS.min, max: POS_DEVICE_TTL_DAYS.max })}
              error={errorText('days', POS_DEVICE_TTL_DAYS.min, POS_DEVICE_TTL_DAYS.max)} onChange={(e) => set('days', e.target.value)} />
          </div>
          {failure && <Notice tone="danger">{failure}</Notice>}
        </form>
      )}
    </Sheet>
  );
}
